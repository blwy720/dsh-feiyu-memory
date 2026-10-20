import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { MemoryStore } from '../lib/store.js';

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-recovery-test-'));
  const args = { dataDir, instanceId: 'recovery-fish', now: () => new Date('2026-10-17T01:00:00Z') };
  const store = new MemoryStore(args);
  t.after(() => { store.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { store, dataDir, args };
}
const rawInput = (id, overrides = {}) => ({ id, pool: 'a', sessionId: 'test', role: 'user', text: 'synthetic original', recordedAt: '2026-09-01T01:00:00Z', ...overrides });
const hash = value => createHash('sha256').update(value).digest('hex');
function denied() { return Object.assign(new Error('controlled sharing lock'), { code: 'EPERM' }); }

test('direct DELETE and REPLACE cannot bypass retention through either connection', t => {
  const { store, dataDir } = fixture(t);
  store.appendRaw(rawInput('guarded'));
  assert.throws(() => store.db.prepare('DELETE FROM raw WHERE id=?').run('guarded'), /retention API/);
  assert.throws(() => store.db.prepare('INSERT OR REPLACE INTO raw(id,date,json) VALUES (?,?,?)').run('guarded', '2026-09-01', '{}'), /immutable/);
  const other = new DatabaseSync(path.join(dataDir, 'memory.sqlite'));
  try { assert.throws(() => other.prepare('DELETE FROM raw WHERE id=?').run('guarded'), /feiyu_retention_allowed/); }
  finally { other.close(); }
  assert.equal(store.getRaw('guarded').text, 'synthetic original');
});

test('reviewed deletion records a plaintext-free tombstone and rolls back as one transaction', t => {
  const { store } = fixture(t);
  for (const id of ['first', 'second']) store.appendRaw(rawInput(id));
  store.reviewRetention({ ids: ['first', 'second'], decision: 'discard', reason: 'synthetic review' });
  store.db.exec("CREATE TRIGGER injected_abort BEFORE DELETE ON raw WHEN OLD.id='second' BEGIN SELECT RAISE(ABORT,'test rollback'); END;");
  assert.throws(() => store.slide({ apply: true }), /test rollback/);
  assert.equal(store.listRaw().length, 2);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM deletion_tombstones').get().n, 0);
  store.db.exec('DROP TRIGGER injected_abort');
  assert.equal(store.slide({ apply: true }).removed, 2);
  const tombstones = store.db.prepare('SELECT json FROM deletion_tombstones').all();
  assert.equal(tombstones.length, 2);
  assert.equal(JSON.stringify(tombstones).includes('synthetic original'), false);
  assert.equal(store.audit().some(item => item.reasons.includes('orphaned_raw_receipt')), false);
  assert.equal(store.appendRaw(rawInput('first')).deleted, true);
  assert.equal(store.getRaw('first'), null);
});

test('schema-one migration preserves originals and reports old receipt gaps without invented deletion proof', t => {
  const { store, args } = fixture(t);
  store.appendRaw(rawInput('preserved'));
  store.appendRaw(rawInput('legacy-gap'));
  store.reviewRetention({ ids: ['legacy-gap'], decision: 'discard', reason: 'old reviewed deletion' });
  store.db.exec('DROP TRIGGER guarded_raw_delete');
  store.db.prepare('DELETE FROM raw WHERE id=?').run('legacy-gap');
  const old = { ...store.metadata(), schema: 1 };
  store.db.prepare('UPDATE meta SET value=? WHERE key=?').run(JSON.stringify(old), 'identity');
  store.close();
  const reopened = new MemoryStore(args);
  try {
    assert.equal(reopened.metadata().schema, 6);
    assert.equal(reopened.getRaw('preserved').text, 'synthetic original');
    const finding = reopened.audit().find(item => item.rawId === 'legacy-gap');
    assert.equal(finding.deletionAuthorization, 'unproven');
    assert.equal(finding.historicalReview.decision, 'discard');
    assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM deletion_tombstones').get().n, 0);
    assert.throws(() => reopened.db.prepare('DELETE FROM raw WHERE id=?').run('preserved'), /retention API/);
  } finally { reopened.close(); }
});

test('unsupported identities are rejected before any schema mutation', t => {
  const { store, dataDir, args } = fixture(t);
  const unsupported = { ...store.metadata(), schema: 999 };
  store.db.prepare('UPDATE meta SET value=? WHERE key=?').run(JSON.stringify(unsupported), 'identity');
  const before = store.db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all();
  store.close();
  fs.unlinkSync(path.join(dataDir, 'identity.json'));
  assert.throws(() => new MemoryStore(args), /schema mismatch/);
  const db = new DatabaseSync(path.join(dataDir, 'memory.sqlite'));
  try { assert.deepEqual(db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all(), before); }
  finally { db.close(); }
});

test('bounded transient rename retry succeeds without a pending task', t => {
  const { store } = fixture(t);
  const original = fs.renameSync;
  let attempts = 0;
  const mock = t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(to).includes(`${path.sep}doing${path.sep}`) && ++attempts < 3) throw denied();
    return original(from, to);
  });
  const result = store.writeEntry({ id: 'retry', kind: 'doing', text: 'version one' });
  mock.mock.restore();
  assert.equal(attempts, 3);
  assert.equal(result.committed, true);
  assert.equal(result.projectionPending, false);
});

test('committed write survives persistent rename denial, restart ingests, repair clears pending without duplicate versions', t => {
  const { store, args, dataDir } = fixture(t);
  store.writeEntry({ id: 'locked', kind: 'doing', text: 'first' });
  const original = fs.renameSync;
  const target = path.join(dataDir, 'doing', `${hash('locked')}.json`);
  const mock = t.mock.method(fs, 'renameSync', (from, to) => { if (to === target) throw denied(); return original(from, to); });
  const result = store.writeEntry({ id: 'locked', kind: 'doing', text: 'second' });
  assert.equal(result.committed, true);
  assert.equal(result.version, 2);
  assert.equal(result.projectionPending, true);
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).version, 1);
  store.close();
  const reopened = new MemoryStore(args);
  try {
    assert.equal(reopened.getEntry('locked').version, 2);
    assert.equal(reopened.projectionStatus().projectionPending, true);
    assert.equal(reopened.appendRaw(rawInput('during-lock')).committed, true);
    assert.equal(reopened.getRaw('during-lock').text, 'synthetic original');
    mock.mock.restore();
    reopened.flush();
    assert.equal(reopened.projectionStatus().projectionPending, false);
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).version, 2);
    assert.equal(reopened.listEntries({ includeHistory: true }).length, 2);
  } finally { mock.mock.restore(); reopened.close(); }
});

test('startup removes only module-owned crash temporary files and preserves unremovable cleanup pending', t => {
  const { store, dataDir, args } = fixture(t);
  const relative = `a/2026/09/01/raw.jsonl.${randomUUID()}.tmp`;
  const owned = store.safePath(relative);
  const unrelated = path.join(dataDir, `notes.${randomUUID()}.tmp`);
  fs.writeFileSync(owned, 'DELETED_SYNTHETIC_PLAINTEXT');
  fs.writeFileSync(unrelated, 'user file');
  store.close();
  const original = fs.unlinkSync;
  const mock = t.mock.method(fs, 'unlinkSync', target => { if (target === owned) throw denied(); return original(target); });
  const reopened = new MemoryStore(args);
  try {
    assert.equal(reopened.projectionStatus().paths.find(item => item.path === relative)?.operation, 'cleanup');
    assert.ok(fs.existsSync(owned));
    mock.mock.restore();
    reopened.flush();
    assert.equal(fs.existsSync(owned), false);
    assert.equal(fs.existsSync(unrelated), true);
    assert.equal(reopened.projectionStatus().projectionPending, false);
  } finally { mock.mock.restore(); reopened.close(); }
});

test('temporary directory scan permission failures remain visible and do not disable ingestion', t => {
  const { store, dataDir, args } = fixture(t);
  store.close();
  const original = fs.readdirSync;
  const mock = t.mock.method(fs, 'readdirSync', (target, options) => { if (target === path.join(dataDir, 'archive')) throw denied(); return original(target, options); });
  fs.mkdirSync(path.join(dataDir, 'archive'), { recursive: true });
  const reopened = new MemoryStore(args);
  try {
    assert.equal(reopened.projectionStatus().paths.some(item => item.operation === 'scan'), true);
    reopened.appendRaw(rawInput('scan-denial'));
    assert.ok(reopened.getRaw('scan-denial'));
    mock.mock.restore(); reopened.flush();
    assert.equal(reopened.projectionStatus().projectionPending, false);
  } finally { mock.mock.restore(); reopened.close(); }
});

test('temporary cleanup preserves a live child writer and removes its orphan after exit', async t => {
  const { store, dataDir } = fixture(t);
  const relative = `a/2026/09/01/raw.jsonl.${randomUUID()}.tmp`;
  const target = store.safePath(relative);
  const source = `
    import fs from 'node:fs'; import path from 'node:path'; import { DatabaseSync } from 'node:sqlite';
    const [dataDir, relative] = process.argv.slice(1);
    const db = new DatabaseSync(path.join(dataDir, 'memory.sqlite'));
    db.prepare('INSERT INTO projection_pending(path,operation,error_code,updated_at,owner_pid) VALUES (?,?,?,?,?)').run(relative, 'cleanup', null, new Date().toISOString(), process.pid);
    fs.writeFileSync(path.join(dataDir, relative), 'LIVE_SYNTHETIC_TEMP');
    console.log('READY');
    await new Promise(resolve => process.stdin.once('data', resolve));
    db.close(); process.stdin.destroy();
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, dataDir, relative], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const [ready] = await once(child.stdout, 'data');
    assert.match(ready.toString(), /READY/);
    store.flush();
    assert.equal(fs.existsSync(target), true);
    const pending = store.projectionStatus().paths.find(item => item.path === relative);
    assert.equal(pending.ownerPid, child.pid);
    assert.equal(pending.errorCode, 'OWNER_ALIVE');
    const exited = once(child, 'exit'); child.stdin.write('release\n'); await exited;
    store.flush();
    assert.equal(fs.existsSync(target), false);
    assert.equal(store.projectionStatus().paths.some(item => item.path === relative), false);
  } finally { if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } }
});

test('a recall append failure is rebuilt from canonical logs before a later append clears pending', t => {
  const { store, dataDir } = fixture(t);
  const target = path.join(dataDir, 'logs/recall.jsonl');
  const original = fs.appendFileSync;
  let failed = false;
  const mock = t.mock.method(fs, 'appendFileSync', (filename, content, options) => {
    if (filename === target && !failed) { failed = true; original(filename, '{partial', options); throw denied(); }
    return original(filename, content, options);
  });
  store.recordRecall({ action: 'first' });
  assert.equal(store.projectionStatus().projectionPending, true);
  mock.mock.restore();
  store.recordRecall({ action: 'second' });
  assert.deepEqual(fs.readFileSync(target, 'utf8').trim().split('\n').map(line => JSON.parse(line).action), ['first', 'second']);
  assert.equal(store.projectionStatus().projectionPending, false);
});

test('corrupt inventory is disposable and audited current projections show downgrade without rewriting original versions', t => {
  const { store, dataDir, args } = fixture(t);
  store.appendRaw(rawInput('evidence'));
  store.writeEntry({ id: 'claim', kind: 'doing', text: 'claim', sources: [{ rawId: 'evidence', quote: 'synthetic' }] });
  store.db.exec('DROP TRIGGER guarded_raw_delete');
  store.db.prepare('DELETE FROM raw WHERE id=?').run('evidence');
  store.audit();
  const filename = hash('claim');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'doing', `${filename}.json`), 'utf8')).evidenceStatus, 'unverified');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'a2', filename, 'current.json'), 'utf8')).auditDowngraded, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'a2', filename, 'v1.json'), 'utf8')).evidenceStatus, 'quote_verified');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'index/entries.json'), 'utf8'))[0].evidenceStatus, 'unverified');
  fs.writeFileSync(path.join(dataDir, 'index/projections.json'), '{broken');
  store.close();
  const reopened = new MemoryStore(args);
  try { assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'index/projections.json'), 'utf8')).rawDates, []); }
  finally { reopened.close(); }
});

test('includeHistory exposes immutable versions while latest remains the default', t => {
  const { store } = fixture(t);
  store.writeEntry({ id: 'history', kind: 'doing', text: 'old', status: 'active', recordedAt: '2026-09-01T00:00:00Z' });
  store.writeEntry({ id: 'history', kind: 'doing', text: 'new', status: 'done', recordedAt: '2026-10-01T00:00:00Z' });
  assert.deepEqual(store.listEntries().map(row => row.version), [2]);
  assert.deepEqual(store.listEntries({ includeHistory: true }).map(row => row.version), [1, 2]);
  assert.deepEqual(store.listEntries({ includeHistory: true, status: 'active' }).map(row => row.version), [1]);
});

test('capture commits claim and every part atomically; preexisting conflict rolls back earlier part', t => {
  const { store } = fixture(t);
  store.appendRaw(rawInput('existing'));
  const request = { id: 'message', pool: 'a', role: 'user', records: [rawInput('new-part'), rawInput('existing', { text: 'conflict' })] };
  assert.throws(() => store.captureMessage(request), /different data/);
  assert.equal(store.getRaw('new-part'), null);
  assert.equal(store.db.prepare('SELECT 1 FROM captures WHERE id=?').get('message'), undefined);
  request.records[1] = rawInput('next-part');
  const first = store.captureMessage(request);
  assert.equal(first.committed, true);
  assert.equal(first.duplicate, false);
  assert.equal(store.captureMessage(request).duplicate, true);
  assert.equal(store.listRaw().length, 3);
});

test('legacy multipart receipts and empty A claims preserve message pool across replay', t => {
  const { store } = fixture(t);
  const records = [rawInput('legacy-part-0', { sourceRoot: 'legacy' }), rawInput('legacy-part-1', { sourceRoot: 'legacy' })];
  records.forEach(record => store.appendRaw(record));
  assert.throws(() => store.captureMessage({ id: 'legacy', pool: 'b', role: 'user', records: [rawInput('legacy', { pool: 'b', text: '' })] }), /Legacy captured/);
  store.captureMessage({ id: 'legacy', pool: 'a', role: 'user', records });
  assert.equal(store.listRaw().length, 2);
  store.captureMessage({ id: 'image-only', pool: 'a', role: 'user', records: [] });
  assert.throws(() => store.captureMessage({ id: 'image-only', pool: 'b', role: 'user', records: [rawInput('image-only', { pool: 'b', text: '' })] }), /different pool/);
});
