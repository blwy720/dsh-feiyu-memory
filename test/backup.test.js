import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync, gunzipSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { MemoryStore } from '../lib/store.js';
import { exportBackup, restoreBackup, verifyBackup, createBackupScheduler, readBackupStatus, nextBackupDue, atomicReplace, LATEST_BACKUP } from '../lib/backup.js';

const MAGIC = Buffer.from('FEIYU-BACKUP/1\n');
const digest = value => createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'feiyu-backup-test-'));
  const dataDir = path.join(root, 'memory'), backupDir = path.join(root, 'backups');
  const store = new MemoryStore({ dataDir, instanceId: 'backup-fish' });
  t.after(() => { store.close(); assert.equal(path.dirname(root), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith('feiyu-backup-test-')); fs.rmSync(root, { recursive: true, force: true }); });
  const add = (id, text = `原文 ${id}`) => store.appendRaw({ id, pool: 'a', sessionId: 'source-session', role: 'user', text, recordedAt: '2026-10-01T12:34:56.000Z' });
  return { root, dataDir, backupDir, store, add, file: path.join(root, 'export.feiyu-backup') };
}
function payload(file) {
  const contents = gunzipSync(fs.readFileSync(file)), size = contents.readUInt32BE(MAGIC.length);
  return { manifest: JSON.parse(contents.subarray(MAGIC.length + 4, MAGIC.length + 4 + size)), database: contents.subarray(MAGIC.length + 4 + size) };
}
function pack(file, manifest, database) {
  const json = Buffer.from(JSON.stringify(manifest)), length = Buffer.alloc(4); length.writeUInt32BE(json.length);
  fs.writeFileSync(file, gzipSync(Buffer.concat([MAGIC, length, json, database])));
}
function readDb(file, query) { const db = new DatabaseSync(file, { readOnly: true }); try { return query(db); } finally { db.close(); } }

test('manual export is validated, stream packaged and independent from broken projections; restore preserves original authority bytes', async t => {
  const f = fixture(t); f.add('original', '逐字原文\n包括  空格😀');
  f.store.writeEntry({ id: 'derived', kind: 'memory', text: '有据摘要', sources: [{ rawId: 'original', quote: '逐字原文', support: 'supports' }] });
  fs.mkdirSync(path.join(f.dataDir, 'index'), { recursive: true }); fs.writeFileSync(path.join(f.dataDir, 'index', 'projections.json'), 'intentionally invalid projection');
  const exported = await exportBackup({ dataDir: f.dataDir, file: f.file, expectedInstanceId: 'backup-fish' });
  assert.equal(exported.validated, true); assert.equal(exported.manifest.identity.instanceId, 'backup-fish');
  assert.equal(exported.sha256, digest(fs.readFileSync(f.file)));
  assert.equal(JSON.stringify(exported.manifest).includes(f.dataDir), false);
  assert.equal(fs.readFileSync(path.join(f.dataDir, 'index', 'projections.json'), 'utf8'), 'intentionally invalid projection');
  assert.equal((await verifyBackup({ file: f.file })).validated, true);
  const target = path.join(f.root, 'restored');
  const restored = await restoreBackup({ file: f.file, targetDir: target, expectedInstanceId: 'backup-fish' });
  assert.equal(restored.needsRebuild, true); assert.equal(restored.projectionPending, true); assert.equal(restored.warnings.length, 2);
  assert.equal(digest(fs.readFileSync(path.join(target, 'memory.sqlite'))), exported.manifest.database.sha256);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target, 'identity.json'), 'utf8')), exported.manifest.identity);
  const raw = readDb(path.join(target, 'memory.sqlite'), db => JSON.parse(db.prepare("SELECT json FROM raw WHERE id='original'").get().json));
  assert.equal(raw.text, '逐字原文\n包括  空格😀'); assert.equal(raw.recordedAt, '2026-10-01T12:34:56.000Z');
  assert.equal(fs.existsSync(path.join(target, 'index')), false, 'restore itself does not construct/mutate MemoryStore');
  const reopened = new MemoryStore({ dataDir: target, instanceId: 'backup-fish' });
  try { assert.equal(reopened.getRaw('original').text, raw.text); assert.ok(fs.existsSync(path.join(target, 'index'))); }
  finally { reopened.close(); }
});

test('online backup under concurrent WAL writes contains committed pairs and valid captures only', async t => {
  const f = fixture(t); let written = 0;
  const appendPair = () => {
    const id = `pair-${++written}`;
    f.store.captureMessage({ id, pool: 'a', role: 'user', records: [0, 1].map(index => ({ id: `${id}-part-${index}`, pool: 'a', sessionId: 'concurrent', turnId: '1', role: 'user', text: `${id}:${index}`, recordedAt: new Date().toISOString(), sourceRoot: id })) });
  };
  appendPair(); const timer = setInterval(appendPair, 2);
  let exported; try { exported = await exportBackup({ dataDir: f.dataDir, file: f.file }); } finally { clearInterval(timer); }
  assert.ok(written > 1, 'writes continue while the worker captures a snapshot');
  const target = path.join(f.root, 'concurrent-restore'); await restoreBackup({ file: f.file, targetDir: target });
  readDb(path.join(target, 'memory.sqlite'), db => {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    const captures = db.prepare('SELECT json FROM captures').all(); assert.ok(captures.length >= 1);
    for (const row of captures) { const ids = JSON.parse(row.json).partIds; assert.equal(ids.length, 2); for (const id of ids) assert.ok(db.prepare('SELECT id FROM raw WHERE id=?').get(id)); }
    assert.equal(db.prepare('SELECT count(*) AS n FROM raw').get().n, captures.length * 2);
  });
  assert.equal(exported.validated, true);
});

test('automatic backup is optional, due only when changed, survives restart, and manual export stays separate', async t => {
  const f = fixture(t); f.add('first');
  const off = createBackupScheduler({ dataDir: f.dataDir }); assert.equal((await off.check()).enabled, false); await off.close();
  assert.equal(fs.existsSync(f.backupDir), false); assert.equal(fs.existsSync(path.join(f.dataDir, 'backup-state.json')), false);
  let now = new Date('2026-10-20T00:00:00Z');
  let scheduler = createBackupScheduler({ dataDir: f.dataDir, backupDir: f.backupDir, enabled: true, intervalDays: 1, now: () => now });
  const first = await scheduler.check(); assert.equal(first.lastError, null); assert.equal(first.dirty, false);
  const latest = path.join(f.backupDir, LATEST_BACKUP), firstHash = digest(fs.readFileSync(latest));
  await exportBackup({ dataDir: f.dataDir, file: f.file }); const manualHash = digest(fs.readFileSync(f.file));
  f.add('second'); now = new Date('2026-10-20T12:00:00Z');
  assert.equal((await scheduler.check()).dirty, true); assert.equal(digest(fs.readFileSync(latest)), firstHash);
  await scheduler.close(); scheduler = createBackupScheduler({ dataDir: f.dataDir, backupDir: f.backupDir, enabled: true, now: () => now });
  assert.equal((await scheduler.check()).lastSuccessAt, first.lastSuccessAt);
  now = new Date('2026-10-21T00:00:00Z'); const second = await scheduler.check();
  assert.equal(second.lastSuccessAt, now.toISOString()); assert.notEqual(digest(fs.readFileSync(latest)), firstHash);
  assert.equal(digest(fs.readFileSync(f.file)), manualHash);
  const secondHash = digest(fs.readFileSync(latest)); now = new Date('2026-10-25T00:00:00Z');
  assert.equal((await scheduler.check()).lastSuccessAt, second.lastSuccessAt); assert.equal(digest(fs.readFileSync(latest)), secondHash);
  assert.equal(readBackupStatus({ dataDir: f.dataDir }).lastSuccessAt, second.lastSuccessAt);
  assert.deepEqual(fs.readdirSync(f.backupDir), [LATEST_BACKUP]); await scheduler.close();
});

test('monthly schedule clamps in the configured calendar and interval limits are explicit', () => {
  assert.equal(nextBackupDue('2026-01-30T16:30:00Z', { schedule: 'monthly', timezone: 'Asia/Shanghai' }), '2026-02-27T16:30:00.000Z');
  assert.equal(nextBackupDue('2024-01-31T12:00:00Z', { schedule: 'monthly', timezone: 'UTC' }), '2024-02-29T12:00:00.000Z');
  assert.equal(nextBackupDue('2026-12-31T12:00:00Z', { schedule: 'monthly', timezone: 'UTC' }), '2027-01-31T12:00:00.000Z');
  assert.equal(nextBackupDue('2026-02-08T07:30:00Z', { schedule: 'monthly', timezone: 'America/New_York' }), '2026-03-08T07:30:00.000Z');
  assert.equal(nextBackupDue('2026-10-20T12:00:00Z', { intervalDays: 30 }), '2026-11-19T12:00:00.000Z');
  for (const options of [{ intervalDays: 0 }, { intervalDays: 31 }, { schedule: 'yearly' }, { schedule: 'monthly', intervalDays: 2 }]) assert.throws(() => nextBackupDue('2026-01-01', options), /interval|monthly/);
});

test('failed atomic replacement preserves the previous good bytes; transient Windows sharing errors are retried', async t => {
  const f = fixture(t), old = path.join(f.root, 'old'), temporary = path.join(f.root, 'new');
  fs.writeFileSync(old, 'previous good snapshot'); fs.writeFileSync(temporary, 'new complete snapshot');
  let calls = 0;
  await assert.rejects(atomicReplace(temporary, old, { attempts: 2, rename() { calls++; throw Object.assign(new Error('locked'), { code: 'EPERM' }); } }), { code: 'EPERM' });
  assert.equal(calls, 2); assert.equal(fs.readFileSync(old, 'utf8'), 'previous good snapshot'); assert.equal(fs.readFileSync(temporary, 'utf8'), 'new complete snapshot');
  calls = 0;
  await atomicReplace(temporary, old, { rename(source, target) { if (++calls === 1) throw Object.assign(new Error('locked'), { code: 'EPERM' }); fs.renameSync(source, target); } });
  assert.equal(calls, 2); assert.equal(fs.readFileSync(old, 'utf8'), 'new complete snapshot');
});

test('real Windows sharing lock keeps the prior validated snapshot and a later check recovers', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t); f.add('first'); let now = new Date('2026-10-20T00:00:00Z');
  const scheduler = createBackupScheduler({ dataDir: f.dataDir, backupDir: f.backupDir, enabled: true, now: () => now });
  const first = await scheduler.check(), latest = path.join(f.backupDir, LATEST_BACKUP), hash = digest(fs.readFileSync(latest));
  f.add('second'); now = new Date('2026-10-22T00:00:00Z');
  const script = "$stream=[System.IO.File]::Open($env:FEIYU_TEST_LOCK_FILE,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::Read); [Console]::WriteLine('READY'); [Console]::ReadLine() | Out-Null; $stream.Dispose()";
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, FEIYU_TEST_LOCK_FILE: latest } });
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Synthetic file lock did not start')), 5000);
      child.stdout.on('data', chunk => { if (chunk.toString().includes('READY')) { clearTimeout(timer); resolve(); } });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { if (code !== null && code !== 0) { clearTimeout(timer); reject(new Error('Synthetic file lock exited early')); } });
    });
    const failed = await scheduler.check(); assert.ok(['EPERM', 'EACCES', 'EBUSY'].includes(failed.lastError?.code));
    assert.equal(failed.lastSuccessAt, first.lastSuccessAt); assert.equal(digest(fs.readFileSync(latest)), hash);
    assert.equal((await verifyBackup({ file: latest })).validated, true);
  } finally { child.stdin.end('\n'); await exited; }
  const recovered = await scheduler.check(); assert.equal(recovered.lastError, null); assert.notEqual(digest(fs.readFileSync(latest)), hash); await scheduler.close();
});

test('unavailable backup destination is nonfatal, persists only safe error metadata and catches up when usable', async t => {
  const f = fixture(t); f.add('first');
  const missingParent = path.join(f.root, 'external-disk'); fs.writeFileSync(missingParent, 'not mounted');
  const scheduler = createBackupScheduler({ dataDir: f.dataDir, backupDir: missingParent, enabled: true, expectedInstanceId: 'backup-fish' });
  const failed = await scheduler.check(); assert.ok(failed.lastError); assert.equal(failed.lastSuccessAt, null);
  const persisted = readBackupStatus({ dataDir: f.dataDir }); assert.ok(persisted.lastError.code); assert.equal(persisted.lastError.message, undefined);
  f.add('still-recording'); assert.ok(f.store.getRaw('still-recording'));
  fs.unlinkSync(missingParent); fs.mkdirSync(missingParent);
  const caughtUp = await scheduler.check(); assert.equal(caughtUp.lastError, null); assert.ok(caughtUp.lastSuccessAt); await scheduler.close();
});

test('tampered, truncated, mismatched, newer schema and extra payload backups never populate restore target', async t => {
  const f = fixture(t); f.add('original'); await exportBackup({ dataDir: f.dataDir, file: f.file });
  const original = payload(f.file);
  const cases = [
    { name: 'hash', manifest: { ...original.manifest, database: { ...original.manifest.database, sha256: '0'.repeat(64) } }, data: original.database },
    { name: 'schema', manifest: { ...original.manifest, identity: { ...original.manifest.identity, schema: 999 } }, data: original.database },
    { name: 'identity', manifest: { ...original.manifest, identity: { ...original.manifest.identity, instanceId: 'other' } }, data: original.database },
    { name: 'format', manifest: { ...original.manifest, formatVersion: 99 }, data: original.database },
    { name: 'truncated', manifest: original.manifest, data: original.database.subarray(0, 1000) },
    { name: 'trailing', manifest: original.manifest, data: Buffer.concat([original.database, Buffer.from('extra')]) },
  ];
  for (const item of cases) {
    const file = path.join(f.root, `${item.name}.feiyu-backup`), target = path.join(f.root, `restore-${item.name}`); pack(file, item.manifest, item.data);
    await assert.rejects(restoreBackup({ file, targetDir: target })); assert.equal(fs.existsSync(target), false);
  }
  await assert.rejects(restoreBackup({ file: f.file, targetDir: path.join(f.root, 'wrong-owner'), expectedInstanceId: 'wrong' }), { code: 'BACKUP_IDENTITY' });
  assert.equal(fs.readdirSync(f.root).some(name => name.startsWith('.feiyu-backup-')), false);
});

test('paths reject source containment, links, hard links and nonempty restore without touching unrelated files', async t => {
  const f = fixture(t); f.add('original');
  await assert.rejects(exportBackup({ dataDir: f.dataDir, file: path.join(f.dataDir, 'bad.feiyu-backup') }), { code: 'BACKUP_PATH' });
  await assert.rejects(exportBackup({ dataDir: f.dataDir, file: path.join(f.root, LATEST_BACKUP) }), { code: 'BACKUP_PATH' });
  assert.throws(() => createBackupScheduler({ dataDir: f.dataDir, enabled: true, backupDir: path.join(f.dataDir, 'backup') }), { code: 'BACKUP_PATH' });
  const link = path.join(f.root, 'linked'); fs.symlinkSync(f.dataDir, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(exportBackup({ dataDir: f.dataDir, file: path.join(link, 'alias.feiyu-backup') }), { code: 'BACKUP_LINK' });
  fs.unlinkSync(link);
  const hard = path.join(f.root, 'alias.sqlite'); fs.linkSync(path.join(f.dataDir, 'memory.sqlite'), hard);
  await assert.rejects(exportBackup({ dataDir: f.dataDir, file: hard }), { code: 'BACKUP_PATH' }); fs.unlinkSync(hard);
  await exportBackup({ dataDir: f.dataDir, file: f.file }); const before = digest(fs.readFileSync(f.file));
  await assert.rejects(exportBackup({ dataDir: f.dataDir, file: f.file }), { code: 'EEXIST' }); assert.equal(digest(fs.readFileSync(f.file)), before);
  const target = path.join(f.root, 'occupied'); fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'important.txt'), 'keep me');
  await assert.rejects(restoreBackup({ file: f.file, targetDir: target }), { code: 'BACKUP_TARGET' }); assert.equal(fs.readFileSync(path.join(target, 'important.txt'), 'utf8'), 'keep me');
  const empty = path.join(f.root, 'empty'); fs.mkdirSync(empty); await restoreBackup({ file: f.file, targetDir: empty }); assert.ok(fs.existsSync(path.join(empty, 'memory.sqlite')));
});

test('automatic latest filename refuses an unrelated existing file and another instance backup', async t => {
  const f = fixture(t); f.add('original'); fs.mkdirSync(f.backupDir);
  const latest = path.join(f.backupDir, LATEST_BACKUP); fs.writeFileSync(latest, 'unrelated important bytes');
  let scheduler = createBackupScheduler({ dataDir: f.dataDir, backupDir: f.backupDir, enabled: true });
  assert.ok((await scheduler.check()).lastError); assert.equal(fs.readFileSync(latest, 'utf8'), 'unrelated important bytes'); await scheduler.close();
  fs.unlinkSync(latest);
  const other = new MemoryStore({ dataDir: path.join(f.root, 'other'), instanceId: 'different-fish' });
  try { const exported = path.join(f.root, 'other.feiyu-backup'); await exportBackup({ dataDir: other.dataDir, file: exported }); fs.renameSync(exported, latest); } finally { other.close(); }
  const hash = digest(fs.readFileSync(latest)); scheduler = createBackupScheduler({ dataDir: f.dataDir, backupDir: f.backupDir, enabled: true });
  assert.equal((await scheduler.check()).lastError.code, 'BACKUP_IDENTITY'); assert.equal(digest(fs.readFileSync(latest)), hash); await scheduler.close();
});

test('restore does not expire B2, retimestamp records or migrate authority before normal startup', async t => {
  const f = fixture(t); f.add('raw');
  f.store._clock = () => new Date('2020-01-01T00:00:00Z');
  f.store.writeB2({ requestId: 'b2-r', id: 'surf', expectedVersion: 0, action: 'write', text: '历史冲浪发现', judgment: '仅测试观点', reason: '用于恢复测试', sources: [{ url: 'https://example.com/', title: 'synthetic' }] });
  const exported = await exportBackup({ dataDir: f.dataDir, file: f.file });
  const target = path.join(f.root, 'unopened'); await restoreBackup({ file: f.file, targetDir: target });
  assert.equal(digest(fs.readFileSync(path.join(target, 'memory.sqlite'))), exported.manifest.database.sha256);
  assert.deepEqual(fs.readdirSync(target).sort(), ['identity.json', 'memory.sqlite']);
  readDb(path.join(target, 'memory.sqlite'), db => {
    assert.equal(db.prepare('SELECT count(*) AS n FROM b2_notes').get().n, 1);
    assert.equal(JSON.parse(db.prepare('SELECT json FROM b2_notes').get().json).recordedAt, '2020-01-01T00:00:00.000Z');
  });
  const reopened = new MemoryStore({ dataDir: target, instanceId: 'backup-fish' });
  try { assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM b2_notes').get().n, 0); } finally { reopened.close(); }
});

test('invalid canonical JSON cannot replace the last good automatic snapshot', async t => {
  const f = fixture(t); f.add('good'); let now = new Date('2026-10-20T00:00:00Z');
  const scheduler = createBackupScheduler({ dataDir: f.dataDir, backupDir: f.backupDir, enabled: true, now: () => now });
  try {
    const first = await scheduler.check(); assert.equal(first.lastError, null);
    const latest = path.join(f.backupDir, LATEST_BACKUP), before = digest(fs.readFileSync(latest));
    f.store.db.prepare('INSERT INTO entries(id,version,kind,json) VALUES (?,?,?,?)').run('broken', 1, 'memory', 'not-valid-json');
    assert.equal(f.store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    now = new Date('2026-10-22T00:00:00Z');
    const failed = await scheduler.check();
    assert.equal(failed.lastError.code, 'BACKUP_RECORD'); assert.equal(failed.lastSuccessAt, first.lastSuccessAt);
    assert.equal(digest(fs.readFileSync(latest)), before);
    await assert.rejects(exportBackup({ dataDir: f.dataDir, file: f.file }), { code: 'BACKUP_RECORD' });
    assert.equal(fs.existsSync(f.file), false);
    const restored = path.join(f.root, 'last-good'); await restoreBackup({ file: latest, targetDir: restored });
    const store = new MemoryStore({ dataDir: restored, instanceId: 'backup-fish' });
    try { assert.equal(store.getRaw('good').text, '原文 good'); assert.equal(store.getEntry('broken'), null); } finally { store.close(); }
  } finally { await scheduler.close(); }
});

test('valid SQLite and checksums cannot hide missing schema, malformed record shapes or failed normal startup', async t => {
  const f = fixture(t); f.add('good');
  f.store.writeEntry({ id: 'valid-entry', kind: 'memory', text: '合成明确陈述', statementType: 'fact' });
  await exportBackup({ dataDir: f.dataDir, file: f.file });
  const original = payload(f.file);
  const cases = [
    ['json', db => db.prepare('INSERT INTO entries(id,version,kind,json) VALUES (?,?,?,?)').run('invalid', 1, 'memory', '{'), 'BACKUP_RECORD'],
    ['object-shape', db => db.prepare('INSERT INTO entries(id,version,kind,json) VALUES (?,?,?,?)').run('invalid', 1, 'memory', '{}'), 'BACKUP_RECORD'],
    ['column-record-mismatch', db => {
      const row = JSON.parse(db.prepare("SELECT json FROM entries WHERE id='valid-entry'").get().json);
      db.prepare('INSERT INTO entries(id,version,kind,json) VALUES (?,?,?,?)').run('different-row-id', 1, 'memory', JSON.stringify(row));
    }, 'BACKUP_RECORD'],
    ['missing-authority-table', db => db.exec('DROP TABLE correction_events'), 'BACKUP_SCHEMA'],
    ['missing-authority-column', db => db.exec('ALTER TABLE raw RENAME COLUMN date TO wrong_date'), 'BACKUP_SCHEMA'],
    ['bad-startup-task', db => db.prepare('INSERT INTO projection_pending(path,operation,updated_at) VALUES (?,?,?)').run('../outside', 'delete', new Date().toISOString()), 'BACKUP_RESTORE']
  ];
  for (const [name, mutate, code] of cases) {
    const databaseFile = path.join(f.root, `${name}.sqlite`);
    fs.writeFileSync(databaseFile, original.database);
    const db = new DatabaseSync(databaseFile);
    try { mutate(db); assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); } finally { db.close(); }
    const data = fs.readFileSync(databaseFile), file = path.join(f.root, `${name}.feiyu-backup`);
    pack(file, { ...original.manifest, database: { ...original.manifest.database, bytes: data.length, sha256: digest(data) } }, data);
    const before = digest(fs.readFileSync(file)), target = path.join(f.root, `${name}-restore`);
    await assert.rejects(verifyBackup({ file }), { code });
    await assert.rejects(restoreBackup({ file, targetDir: target }), { code });
    assert.equal(fs.existsSync(target), false); assert.equal(digest(fs.readFileSync(file)), before);
  }
  assert.equal(fs.readdirSync(f.root).some(name => name.startsWith('.feiyu-backup-')), false);
});

test('a trusted OS temp alias is resolved without relaxing user backup path checks', async t => {
  const f = fixture(t); f.add('good'); await exportBackup({ dataDir: f.dataDir, file: f.file });
  const physical = path.join(f.root, 'physical-temp'), alias = path.join(f.root, 'temp-alias');
  fs.mkdirSync(physical); fs.symlinkSync(physical, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const script = "const {verifyBackup}=await import(process.env.FEIYU_TEST_BACKUP_MODULE); const result=await verifyBackup({file:process.env.FEIYU_TEST_BACKUP_FILE}); process.stdout.write(String(result.validated));";
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true,
    env: { ...process.env, TEMP: alias, TMP: alias, TMPDIR: alias, FEIYU_TEST_BACKUP_MODULE: new URL('../lib/backup.js', import.meta.url).href, FEIYU_TEST_BACKUP_FILE: f.file } });
  let output = '', errors = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
  const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(exitCode, 0, errors); assert.equal(output, 'true'); assert.deepEqual(fs.readdirSync(physical), []);
  await assert.rejects(exportBackup({ dataDir: f.dataDir, file: path.join(alias, 'user-file.feiyu-backup') }), { code: 'BACKUP_LINK' });
  fs.unlinkSync(alias);
});

test('backup validation and restore read real durable preinject choices in none, ready and unavailable states', async t => {
  const f = fixture(t);
  const now = Date.now();
  f.store.selectPreinject({ targetSessionId: 'none-target', firstTurnId: '1' });
  const round = (sessionId, startedAt) => {
    const captures = ['user', 'assistant'].map((role, position) => {
      const id = `${sessionId}-${role}`;
      f.store.captureMessage({ id, pool: 'a', role, records: [{
        id, pool: 'a', role, sessionId, turnId: '1', sourceRoot: id,
        text: `Synthetic ${role} for backup regression`,
        recordedAt: new Date(startedAt + (position + 1) * 1000).toISOString()
      }] });
      return { id, role, seq: position + 1 };
    });
    f.store.recordCompletedRound({ sessionId, turnId: '1', startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date(startedAt + 3000).toISOString(), startSeq: 0, endSeq: 3,
      reason: 'completed', proof: 'live', captures, omittedNonText: false });
  };
  const expiredStart = now - 8 * 86400000;
  round('expired-source', expiredStart);
  f.store.selectPreinject({ targetSessionId: 'expired-target', firstTurnId: '1', asOf: new Date(expiredStart + 4000).toISOString() });
  round('ready-source', now - 60000);
  f.store.selectPreinject({ targetSessionId: 'ready-target', firstTurnId: '1' });
  const expected = [['none-target', 'none'], ['ready-target', 'ready'], ['expired-target', 'unavailable']];
  for (const [targetSessionId, status] of expected) assert.equal(f.store.readPreinject({ targetSessionId, turnId: '1' }).status, status);
  const beforeChoices = f.store.db.prepare('SELECT * FROM preinject_choices ORDER BY target_session_id').all();
  const exported = await exportBackup({ dataDir: f.dataDir, file: f.file });
  assert.equal(exported.validated, true);
  assert.equal((await verifyBackup({ file: f.file })).validated, true);
  const target = path.join(f.root, 'restored-choices');
  await restoreBackup({ file: f.file, targetDir: target });
  assert.equal(digest(fs.readFileSync(path.join(target, 'memory.sqlite'))), exported.manifest.database.sha256);
  const restored = new MemoryStore({ dataDir: target, instanceId: 'backup-fish' });
  try {
    assert.deepEqual(restored.db.prepare('SELECT * FROM preinject_choices ORDER BY target_session_id').all(), beforeChoices);
    for (const [targetSessionId, status] of expected) assert.equal(restored.readPreinject({ targetSessionId, turnId: '1' }).status, status);
  } finally { restored.close(); }
  assert.deepEqual(f.store.db.prepare('SELECT * FROM preinject_choices ORDER BY target_session_id').all(), beforeChoices);
});
