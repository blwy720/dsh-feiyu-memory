import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore } from '../lib/store.js';
import { createBackupManager, BACKUP_SETTINGS_FILE } from '../lib/backup-manager.js';
import { LATEST_BACKUP } from '../lib/backup.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'feiyu-manager-test-'));
  const dataDir = path.join(root, 'memory'), backupDir = path.join(root, 'backups');
  const store = new MemoryStore({ dataDir, instanceId: 'manager-fish' }), managers = [];
  t.after(async () => {
    for (const manager of managers) await manager.close();
    store.close();
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('feiyu-manager-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root, dataDir, backupDir, store, settingsFile: path.join(dataDir, BACKUP_SETTINGS_FILE),
    add(id) { store.appendRaw({ id, pool: 'a', role: 'user', sessionId: 'manager-session', text: `synthetic ${id}`, recordedAt: '2026-10-20T00:00:00.000Z' }); },
    make(options = {}) {
      const manager = createBackupManager({ dataDir, expectedInstanceId: 'manager-fish', ...options });
      managers.push(manager); return manager;
    },
    settings(overrides = {}) { return { enabled: true, backupDir, intervalDays: 1, schedule: 'interval', ...overrides }; }
  };
}

test('settings fall back without writes, persist across restart, and hot reconfigure the due schedule', async t => {
  const f = fixture(t); f.add('first');
  let now = new Date('2026-10-20T00:00:00Z');
  let manager = f.make({ now: () => now });
  assert.equal(manager.getSettings().source, 'config');
  assert.equal(manager.getSettings().enabled, false);
  await manager.check();
  assert.equal(fs.existsSync(f.settingsFile), false);
  assert.equal(fs.existsSync(f.backupDir), false);
  await manager.saveSettings(f.settings());
  assert.equal(manager.getSettings().source, 'saved');
  assert.equal(fs.existsSync(f.backupDir), false, 'saving does not launch an untracked worker');
  const first = await manager.check();
  assert.equal(first.scheduler.lastSuccessAt, now.toISOString());
  f.add('second'); now = new Date('2026-10-20T12:00:00Z');
  await manager.saveSettings(f.settings({ intervalDays: 2 }));
  assert.equal(manager.status().scheduler.nextDueAt, '2026-10-22T00:00:00.000Z');
  const pending = await manager.check();
  assert.equal(pending.scheduler.lastSuccessAt, first.scheduler.lastSuccessAt);
  assert.equal(pending.scheduler.dirty, true);
  await manager.close();
  manager = f.make({ now: () => now, fallbackSettings: f.settings({ enabled: false, backupDir: path.join(f.root, 'ignored') }) });
  assert.equal(manager.getSettings().enabled, true);
  assert.equal(manager.getSettings().backupDir, f.backupDir);
  assert.equal(manager.getSettings().intervalDays, 2);
  assert.equal(manager.status().scheduler.nextDueAt, '2026-10-22T00:00:00.000Z');
  now = new Date('2026-10-22T00:00:00Z');
  assert.equal((await manager.check()).scheduler.lastSuccessAt, now.toISOString());
});

test('manual backup forces a validated latest snapshot while automatic backup remains disabled', async t => {
  const f = fixture(t); f.add('original');
  let now = new Date('2026-10-20T00:00:00Z');
  let manager = f.make({ fallbackSettings: f.settings({ enabled: false }), now: () => now });
  const first = await manager.backupNow();
  assert.equal(first.settings.enabled, false);
  assert.equal(first.scheduler.enabled, false);
  assert.equal(first.scheduler.nextDueAt, null);
  assert.equal(first.scheduler.lastSuccessAt, now.toISOString());
  const latest = path.join(f.backupDir, LATEST_BACKUP);
  assert.equal((await manager.verifyFile({ file: latest })).validated, true);
  now = new Date('2026-10-20T00:01:00Z');
  const second = await manager.backupNow();
  assert.equal(second.scheduler.lastSuccessAt, now.toISOString(), 'force runs despite unchanged data and interval not elapsed');
  assert.equal(second.lastOperation.name, 'backup-now');
  assert.equal(second.lastOperation.completion, 'confirmed');
  await manager.close();
  manager = f.make({ fallbackSettings: f.settings({ enabled: false }), now: () => now });
  assert.equal(manager.status().scheduler.lastSuccessAt, now.toISOString());
  assert.equal(manager.status().scheduler.nextDueAt, null);
  assert.equal((await manager.check()).scheduler.lastSuccessAt, now.toISOString());
});

test('automatic work shares the same busy guard as settings, exports and manual operations', async t => {
  const f = fixture(t); f.add('original');
  const manager = f.make({ fallbackSettings: f.settings() });
  const running = manager.check();
  assert.equal(manager.status().busy, true);
  assert.equal(manager.status().operation.name, 'automatic-backup');
  assert.equal((await manager.check()).busy, true);
  await assert.rejects(manager.saveSettings(f.settings({ enabled: false })), { code: 'BACKUP_BUSY' });
  await assert.rejects(manager.backupNow(), { code: 'BACKUP_BUSY' });
  const never = path.join(f.root, 'never.feiyu-backup');
  await assert.rejects(manager.exportFile({ file: never }), { code: 'BACKUP_BUSY' });
  const closed = manager.close();
  await assert.rejects(manager.verifyFile({ file: never }), { code: 'BACKUP_CLOSED' });
  await running; await closed;
  assert.equal(manager.status().closed, true);
  assert.equal(manager.status().busy, false);
  assert.equal(fs.existsSync(never), false);
  assert.equal(fs.existsSync(path.join(f.backupDir, LATEST_BACKUP)), true);
});

test('invalid settings and failed atomic saves preserve both persisted and active plans', async t => {
  const f = fixture(t); f.add('original');
  const manager = f.make();
  await manager.saveSettings(f.settings());
  const before = fs.readFileSync(f.settingsFile), active = manager.getSettings();
  for (const input of [
    f.settings({ enabled: 'yes' }), f.settings({ backupDir: '' }), f.settings({ backupDir: 'relative' }),
    f.settings({ backupDir: path.join(f.dataDir, 'backups') }), f.settings({ intervalDays: 0 }),
    f.settings({ schedule: 'monthly', intervalDays: 2 }), { ...f.settings(), dataDir: f.root }
  ]) {
    await assert.rejects(manager.saveSettings(input));
    assert.deepEqual(manager.getSettings(), active);
    assert.ok(fs.readFileSync(f.settingsFile).equals(before));
  }
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = (file, ...args) => {
    if (typeof file === 'string' && file.startsWith(f.settingsFile + '.')) throw Object.assign(new Error('synthetic write denied'), { code: 'EACCES' });
    return originalWrite(file, ...args);
  };
  try { await assert.rejects(manager.saveSettings(f.settings({ enabled: false })), { code: 'EACCES' }); }
  finally { fs.writeFileSync = originalWrite; }
  assert.ok(fs.readFileSync(f.settingsFile).equals(before));
  assert.deepEqual(manager.getSettings(), active);
  const originalRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === f.settingsFile) throw Object.assign(new Error('private synthetic error text'), { code: 'EPERM' });
    return originalRename(from, to);
  };
  try { await assert.rejects(manager.saveSettings(f.settings({ backupDir: path.join(f.root, 'replacement') })), { code: 'EPERM' }); }
  finally { fs.renameSync = originalRename; }
  assert.ok(fs.readFileSync(f.settingsFile).equals(before));
  assert.deepEqual(manager.getSettings(), active);
  assert.equal(JSON.stringify(manager.status()).includes('private synthetic'), false);
  assert.equal(manager.status().lastOperation.completion, 'unconfirmed');
  await manager.check();
  assert.ok(fs.existsSync(path.join(f.backupDir, LATEST_BACKUP)));
  assert.equal(fs.existsSync(path.join(f.root, 'replacement')), false);
});

test('a settings rename committed before a sync error is reported as the new plan with a warning', async t => {
  const f = fixture(t), manager = f.make();
  await manager.saveSettings(f.settings({ enabled: false }));
  const originalRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    originalRename(from, to);
    if (to === f.settingsFile) throw Object.assign(new Error('post-commit sync fault'), { code: 'EIO' });
  };
  let result;
  try { result = await manager.saveSettings(f.settings({ enabled: false, intervalDays: 3 })); }
  finally { fs.renameSync = originalRename; }
  assert.equal(result.settings.intervalDays, 3);
  assert.equal(result.settingsWarning.code, 'EIO');
  assert.equal(result.lastOperation.outcome, 'success');
  assert.equal(JSON.parse(fs.readFileSync(f.settingsFile, 'utf8')).intervalDays, 3);
});

test('corrupt, wrong-owner and unreadable persisted settings never silently enable fallback backup', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.settingsFile, '{ broken');
  let manager = f.make({ fallbackSettings: f.settings() });
  assert.equal(manager.getSettings().enabled, false);
  assert.equal(manager.getSettings().source, 'blocked');
  assert.equal(manager.status().settingsError.code, 'BACKUP_SETTINGS');
  await manager.check(); assert.equal(fs.existsSync(f.backupDir), false);
  await manager.saveSettings(f.settings({ enabled: false }));
  assert.equal(manager.status().settingsError, null);
  await manager.close();
  const saved = JSON.parse(fs.readFileSync(f.settingsFile, 'utf8'));
  fs.writeFileSync(f.settingsFile, JSON.stringify({ ...saved, instanceId: 'another-fish' }));
  manager = f.make({ fallbackSettings: f.settings() });
  assert.equal(manager.getSettings().enabled, false);
  assert.equal(manager.status().settingsError.code, 'BACKUP_SETTINGS');
  await manager.saveSettings(f.settings({ enabled: false })); await manager.close();
  const originalRead = fs.readFileSync;
  fs.readFileSync = (file, ...args) => {
    if (file === f.settingsFile) throw Object.assign(new Error('private file contents must not appear'), { code: 'EACCES' });
    return originalRead(file, ...args);
  };
  try { manager = f.make({ fallbackSettings: f.settings() }); }
  finally { fs.readFileSync = originalRead; }
  assert.equal(manager.status().settingsError.code, 'EACCES');
  assert.equal(manager.getSettings().enabled, false);
  assert.equal(JSON.stringify(manager.status()).includes('private file contents'), false);
  await manager.saveSettings(f.settings({ enabled: true }));
  assert.equal(manager.status().settingsError, null);
});

test('verified restore is bound to the approved bytes and never switches or overwrites the active store', async t => {
  const f = fixture(t); f.add('original');
  const manager = f.make(), file = path.join(f.root, 'manual.feiyu-backup'), second = path.join(f.root, 'newer.feiyu-backup');
  await manager.exportFile({ file });
  const approved = await manager.verifyFile({ file });
  assert.equal(approved.manifest.identity.instanceId, 'manager-fish');
  assert.equal(approved.sha256, digest(fs.readFileSync(file)));
  f.add('later'); await manager.exportFile({ file: second });
  fs.copyFileSync(second, file);
  const targetDir = path.join(f.root, 'restored');
  await assert.rejects(manager.restoreFile({ file, targetDir, expectedSha256: approved.sha256 }), { code: 'BACKUP_CHANGED' });
  assert.equal(fs.existsSync(targetDir), false);
  for (const target of [f.dataDir, f.root, path.join(f.dataDir, 'restored')]) {
    await assert.rejects(manager.restoreFile({ file, targetDir: target }), { code: 'BACKUP_PATH' });
  }
  const verified = await manager.verifyFile({ file });
  const restored = await manager.restoreFile({ file, targetDir, expectedSha256: verified.sha256 });
  assert.equal(restored.sha256, verified.sha256);
  assert.equal(restored.needsRebuild, true);
  assert.equal(restored.projectionPending, true);
  assert.equal(f.store.listRaw().length, 2);
  const db = new DatabaseSync(path.join(targetDir, 'memory.sqlite'), { readOnly: true });
  try { assert.equal(db.prepare('SELECT count(*) AS n FROM raw').get().n, 2); } finally { db.close(); }
  const targetHash = digest(fs.readFileSync(path.join(targetDir, 'memory.sqlite')));
  await assert.rejects(manager.restoreFile({ file, targetDir, expectedSha256: verified.sha256 }), { code: 'BACKUP_TARGET' });
  assert.equal(digest(fs.readFileSync(path.join(targetDir, 'memory.sqlite'))), targetHash);
  await assert.rejects(manager.exportFile({ file }), { code: 'EEXIST' });
  assert.equal(digest(fs.readFileSync(file)), verified.sha256);
});

test('linked settings or backup directories are rejected without touching their other targets', async t => {
  const f = fixture(t), unrelated = path.join(f.root, 'unrelated.json');
  fs.writeFileSync(unrelated, 'synthetic unrelated file');
  fs.linkSync(unrelated, f.settingsFile);
  let manager = f.make();
  assert.equal(manager.status().settingsError.code, 'BACKUP_SETTINGS');
  await assert.rejects(manager.saveSettings(f.settings({ enabled: false })), { code: 'BACKUP_SETTINGS' });
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'synthetic unrelated file');
  await manager.close(); fs.unlinkSync(f.settingsFile);
  const link = path.join(f.root, 'linked-memory');
  fs.symlinkSync(f.dataDir, link, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    manager = f.make();
    await assert.rejects(manager.saveSettings(f.settings({ backupDir: link })), { code: 'BACKUP_LINK' });
    await assert.rejects(manager.restoreFile({ file: unrelated, targetDir: path.join(link, 'child') }), { code: 'BACKUP_LINK' });
  } finally { fs.unlinkSync(link); }
});

test('foreign backup verification reveals identity and restore requires explicit approval without changing the active instance', async t => {
  const f = fixture(t); f.add('active-original');
  const foreignDir = path.join(f.root, 'foreign-memory'), file = path.join(f.root, 'foreign.feiyu-backup');
  const foreignStore = new MemoryStore({ dataDir: foreignDir, instanceId: 'other-device-fish' });
  try {
    foreignStore.appendRaw({ id: 'foreign-original', pool: 'a', role: 'user', sessionId: 'foreign-session', text: 'synthetic foreign evidence' });
    const exporter = f.make({ dataDir: foreignDir, expectedInstanceId: 'other-device-fish' });
    await exporter.exportFile({ file }); await exporter.close();
  } finally { foreignStore.close(); }
  const manager = f.make(), verified = await manager.verifyFile({ file });
  assert.equal(verified.validated, true);
  assert.equal(verified.manifest.identity.instanceId, 'other-device-fish');
  const defaultTarget = path.join(f.root, 'default-rejected');
  await assert.rejects(manager.restoreFile({ file, targetDir: defaultTarget, expectedSha256: verified.sha256 }), { code: 'BACKUP_IDENTITY' });
  assert.equal(fs.existsSync(defaultTarget), false);
  await assert.rejects(manager.restoreFile({ file, targetDir: f.dataDir, expectedSha256: verified.sha256, expectedBackupInstanceId: 'other-device-fish' }), { code: 'BACKUP_PATH' });
  const targetDir = path.join(f.root, 'explicit-foreign-restore');
  const restored = await manager.restoreFile({ file, targetDir, expectedSha256: verified.sha256, expectedBackupInstanceId: 'other-device-fish' });
  assert.equal(restored.identity.instanceId, 'other-device-fish');
  assert.equal(restored.sha256, verified.sha256);
  assert.equal(restored.needsRebuild, true);
  assert.equal(f.store.metadata().instanceId, 'manager-fish');
  assert.ok(f.store.getRaw('active-original'));
  assert.equal(f.store.getRaw('foreign-original'), null);
  const db = new DatabaseSync(path.join(targetDir, 'memory.sqlite'), { readOnly: true });
  try {
    assert.equal(JSON.parse(db.prepare("SELECT value FROM meta WHERE key='identity'").get().value).instanceId, 'other-device-fish');
    assert.equal(db.prepare("SELECT count(*) AS n FROM raw WHERE id='foreign-original'").get().n, 1);
  } finally { db.close(); }
});

test('an unavailable automatic destination reports a safe error and does not block primary capture', async t => {
  const f = fixture(t), manager = f.make();
  f.add('first'); await manager.saveSettings(f.settings());
  fs.writeFileSync(f.backupDir, 'synthetic disconnected volume');
  const result = await manager.check();
  assert.ok(result.lastError?.code);
  assert.equal(result.lastError.message, undefined);
  assert.equal(result.lastOperation.completion, 'unconfirmed');
  f.add('still-recording'); assert.ok(f.store.getRaw('still-recording'));
  fs.unlinkSync(f.backupDir);
  const recovered = await manager.check();
  assert.equal(recovered.lastError, null);
  assert.ok(recovered.scheduler.lastSuccessAt);
});
