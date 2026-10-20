import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { MemoryStore } from '../lib/store.js';

const cli = fileURLToPath(new URL('../scripts/cli.js', import.meta.url));
const quotePS = value => "'" + value.replaceAll("'", "''") + "'";

// Use an actual Windows handle without FILE_SHARE_DELETE. No fs calls are mocked.
async function sharingLock(dir, target) {
  const ready = join(dir, 'lock-ready');
  const release = join(dir, 'lock-release');
  const script = `$ErrorActionPreference = 'Stop'
$handle = [IO.File]::Open(${quotePS(target)}, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
  [IO.File]::WriteAllText(${quotePS(ready)}, 'ready')
  $deadline = [DateTime]::UtcNow.AddSeconds(25)
  while (-not [IO.File]::Exists(${quotePS(release)})) {
    if ([DateTime]::UtcNow -gt $deadline) { throw 'Test lock timed out' }
    Start-Sleep -Milliseconds 20
  }
} finally { $handle.Dispose() }`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '', spawnError;
  child.stderr.on('data', data => { stderr += data; });
  child.on('error', error => { spawnError = error; });
  const ended = new Promise(resolve => child.on('close', code => resolve(code)));
  for (let attempt = 0; attempt < 200 && !fs.existsSync(ready); attempt++) {
    if (spawnError || child.exitCode !== null) break;
    await delay(25);
  }
  if (!fs.existsSync(ready)) {
    child.kill();
    await ended;
    throw new Error(`Cannot acquire Windows test lock: ${spawnError?.message ?? stderr}`);
  }
  return async () => {
    fs.writeFileSync(release, 'release');
    assert.equal(await ended, 0, stderr);
  };
}

function fixture() {
  const dir = fs.mkdtempSync(join(tmpdir(), 'feiyu-win-lock-'));
  const dataDir = join(dir, 'data');
  const options = { dataDir, instanceId: 'windows-recovery' };
  const run = (command, input, name = 'input') => {
    const flags = [];
    if (input) {
      const file = join(dir, `${name}.json`);
      fs.writeFileSync(file, JSON.stringify(input));
      flags.push('--input', file);
    }
    const result = spawnSync(process.execPath, [cli, command, '--data', dataDir, '--instance', options.instanceId, ...flags], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  return { dir, dataDir, options, run };
}

test('Windows sharing lock: committed append returns pending and rebuild repairs after release', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const { dir, dataDir, options, run } = fixture();
  let unlock;
  try {
    new MemoryStore(options).close();
    unlock = await sharingLock(dir, join(dataDir, 'index', 'projections.json'));
    const result = run('append', { id: 'locked-raw', role: 'user', pool: 'a', sessionId: 'synthetic', text: 'synthetic original', recordedAt: '2026-10-17T03:00:00Z' });
    assert.equal(result.committed, true);
    assert.equal(result.projectionPending, true);
    assert.ok(result.pendingCount > 0);
    const store = new MemoryStore(options);
    try { assert.equal(store.getRaw('locked-raw').text, 'synthetic original'); }
    finally { store.close(); }
    await unlock(); unlock = null;
    const repaired = run('rebuild');
    assert.equal(repaired.projectionPending, false);
    assert.equal(repaired.pendingCount, 0);
    assert.match(fs.readFileSync(join(dataDir, 'a', '2026', '10', '17', 'raw.jsonl'), 'utf8'), /synthetic original/);
  } finally {
    if (unlock) await unlock();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Windows sharing lock: doing update reports commit, next process still captures, no retry version needed', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const { dir, dataDir, options, run } = fixture();
  let unlock;
  try {
    const store = new MemoryStore(options);
    store.writeEntry({ id: 'locked-doing', kind: 'doing', text: 'first version', sources: [] });
    store.close();
    const target = join(dataDir, 'doing', createHash('sha256').update('locked-doing').digest('hex') + '.json');
    unlock = await sharingLock(dir, target);
    const updated = run('write', { id: 'locked-doing', kind: 'doing', statementType: 'fact', text: 'second version', sources: [] });
    assert.equal(updated.version, 2);
    assert.equal(updated.committed, true);
    assert.equal(updated.projectionPending, true);
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).version, 1);
    const appended = run('append', { id: 'next-message', role: 'user', pool: 'a', sessionId: 'synthetic', text: 'saved despite prior lock' }, 'next');
    assert.equal(appended.committed, true);
    assert.equal(appended.projectionPending, true);
    await unlock(); unlock = null;
    assert.equal(run('rebuild').projectionPending, false);
    const repaired = new MemoryStore(options);
    try {
      assert.equal(repaired.getEntry('locked-doing').version, 2);
      assert.equal(repaired.db.prepare('SELECT count(*) AS n FROM entries WHERE id=?').get('locked-doing').n, 2);
      assert.equal(repaired.getRaw('next-message').text, 'saved despite prior lock');
      assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).version, 2);
    } finally { repaired.close(); }
  } finally {
    if (unlock) await unlock();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
