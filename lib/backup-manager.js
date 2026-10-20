import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicReplace, createBackupScheduler, exportBackup, verifyBackup, restoreBackup, nextBackupDue } from './backup.js';

export const BACKUP_SETTINGS_FILE = 'backup-settings.json';
const MAX_SETTINGS_BYTES = 16384;
const SETTING_KEYS = ['enabled', 'backupDir', 'intervalDays', 'schedule'];
function failure(code) { return Object.assign(new Error(`Backup management operation failed (${code})`), { code }); }
function codeOf(error) { return typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'BACKUP_FAILED'; }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function inside(candidate, directory) {
  const relative = path.relative(directory, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function safePath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\u0000-\u001f]/u.test(value)) throw failure('BACKUP_PATH');
  const absolute = path.resolve(value), root = path.parse(absolute).root;
  let cursor = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) throw failure('BACKUP_LINK');
      if (cursor !== absolute && !stat.isDirectory()) throw failure('BACKUP_PATH');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return absolute;
}
function settingsPath(dataDir) {
  const file = safePath(path.join(dataDir, BACKUP_SETTINGS_FILE));
  try { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.nlink > 1) throw failure('BACKUP_SETTINGS'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return file;
}
function validateSettings(value, dataDir, timezone) {
  if (!object(value) || Object.keys(value).some(key => !SETTING_KEYS.includes(key))) throw failure('BACKUP_SETTINGS');
  if (typeof value.enabled !== 'boolean' || typeof value.backupDir !== 'string' || !Number.isSafeInteger(value.intervalDays) || !['interval', 'monthly'].includes(value.schedule)) throw failure('BACKUP_SETTINGS');
  try { nextBackupDue('2026-01-01T00:00:00Z', { intervalDays: value.intervalDays, schedule: value.schedule, timezone }); }
  catch { throw failure('BACKUP_SCHEDULE'); }
  let backupDir = value.backupDir;
  if (backupDir !== '') {
    backupDir = safePath(backupDir);
    if (inside(backupDir, dataDir)) throw failure('BACKUP_PATH');
    try { if (!fs.statSync(backupDir).isDirectory()) throw failure('BACKUP_PATH'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  } else if (value.enabled) throw failure('BACKUP_PATH');
  return { enabled: value.enabled, backupDir, intervalDays: value.intervalDays, schedule: value.schedule };
}
function syncFile(file) {
  const descriptor = fs.openSync(file, 'r+');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

/** Administrator-only core. The host supplies authentication and a periodic check timer. */
export function createBackupManager({ dataDir, expectedInstanceId, timezone = 'Asia/Shanghai', fallbackSettings = {}, now = () => new Date(), onStatus } = {}) {
  const directory = safePath(dataDir);
  if (!fs.statSync(directory).isDirectory()) throw failure('BACKUP_PATH');
  if (typeof expectedInstanceId !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N}._:@-]{0,199}$/u.test(expectedInstanceId) || typeof now !== 'function') throw failure('BACKUP_CONFIG');
  const fallback = validateSettings({ enabled: false, backupDir: '', intervalDays: 1, schedule: 'interval', ...fallbackSettings }, directory, timezone);
  let settings = fallback, settingsSource = 'config', updatedAt = null, settingsError = null, settingsWarning = null;
  let active = null, closed = false, lastOperation = null, lastError = null;
  const time = () => {
    const value = new Date(now());
    if (!Number.isFinite(value.getTime())) throw failure('BACKUP_CLOCK');
    return value.toISOString();
  };
  const safeError = error => ({ code: codeOf(error), at: new Date().toISOString() });
  try {
    const file = settingsPath(directory);
    if (fs.statSync(file).size > MAX_SETTINGS_BYTES) throw failure('BACKUP_SETTINGS');
    let saved;
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error instanceof SyntaxError) throw failure('BACKUP_SETTINGS'); throw error; }
    if (!object(saved) || saved.version !== 1 || saved.instanceId !== expectedInstanceId || typeof saved.updatedAt !== 'string' || !Number.isFinite(Date.parse(saved.updatedAt))
      || Object.keys(saved).some(key => !['version', 'instanceId', 'updatedAt', ...SETTING_KEYS].includes(key))) throw failure('BACKUP_SETTINGS');
    settings = validateSettings(Object.fromEntries(SETTING_KEYS.map(key => [key, saved[key]])), directory, timezone);
    settingsSource = 'saved'; updatedAt = saved.updatedAt;
  } catch (error) {
    if (error.code !== 'ENOENT') { settings = { ...fallback, enabled: false }; settingsSource = 'blocked'; settingsError = safeError(error); }
  }
  const makeScheduler = value => createBackupScheduler({
    dataDir: directory, expectedInstanceId, timezone, now, enabled: value.enabled,
    ...(value.backupDir ? { backupDir: value.backupDir } : {}),
    intervalDays: value.intervalDays, schedule: value.schedule
  });
  let scheduler = makeScheduler(settings);
  const getSettings = () => structuredClone({ ...settings, source: settingsSource, updatedAt });
  function status() {
    const scheduled = scheduler.status();
    const nextDueAt = settings.enabled && scheduled.lastSuccessAt
      ? nextBackupDue(scheduled.lastSuccessAt, { intervalDays: settings.intervalDays, schedule: settings.schedule, timezone }) : null;
    return structuredClone({
      settings: getSettings(), busy: active !== null, closed, operation: active?.operation ?? null,
      scheduler: { ...scheduled, enabled: settings.enabled, nextDueAt },
      lastOperation, lastError, settingsError, settingsWarning
    });
  }
  const publish = () => { try { onStatus?.(status()); } catch {} };
  function run(name, operation) {
    if (closed) return Promise.reject(failure('BACKUP_CLOSED'));
    if (active) return Promise.reject(failure('BACKUP_BUSY'));
    const current = { name, startedAt: time() };
    const task = Promise.resolve().then(operation).then(result => {
      lastOperation = { ...current, finishedAt: time(), outcome: 'success', completion: 'confirmed' };
      lastError = null; return result;
    }, error => {
      lastError = safeError(error);
      // A worker may have published an artifact before a cleanup/state write failed.
      lastOperation = { ...current, finishedAt: new Date().toISOString(), outcome: 'error', completion: 'unconfirmed', error: lastError };
      throw failure(lastError.code);
    }).finally(() => { active = null; publish(); });
    active = { operation: current, promise: task }; publish();
    return task;
  }
  async function saveSettings(input) {
    await run('settings', async () => {
      const candidate = validateSettings(input, directory, timezone);
      const replacement = makeScheduler(candidate);
      const destination = settingsPath(directory), temporary = safePath(path.join(directory, `${BACKUP_SETTINGS_FILE}.${randomUUID()}.tmp`));
      const savedAt = time(), content = JSON.stringify({ version: 1, instanceId: expectedInstanceId, ...candidate, updatedAt: savedAt }, null, 2) + '\n';
      let committed = false, warning = null;
      try {
        fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 }); syncFile(temporary);
        settingsPath(directory);
        try { await atomicReplace(temporary, destination); committed = true; }
        catch (error) {
          // Rename may have committed before directory fsync failed. Do not report
          // an unchanged plan when the new durable settings file is already present.
          if (!fs.existsSync(temporary) && fs.readFileSync(settingsPath(directory), 'utf8') === content) { committed = true; warning = safeError(error); }
          else throw error;
        }
        const previous = scheduler;
        scheduler = replacement; settings = candidate; settingsSource = 'saved'; updatedAt = savedAt;
        settingsError = null; settingsWarning = warning;
        await previous.close();
      } finally {
        if (!committed) await replacement.close();
        try { if (fs.existsSync(temporary)) fs.unlinkSync(safePath(temporary)); }
        catch (error) { if (committed) settingsWarning = safeError(error); }
      }
    });
    return status();
  }
  async function check() {
    if (closed || active || !settings.enabled) return status();
    try {
      await run('automatic-backup', async () => {
        const result = await scheduler.check();
        if (result.lastError) throw failure(result.lastError.code);
      });
    } catch { /* Automatic failures remain visible but never block memory capture. */ }
    return status();
  }
  async function backupNow() {
    await run('backup-now', async () => {
      if (!settings.backupDir) throw failure('BACKUP_PATH');
      const enabled = settings.enabled ? scheduler : makeScheduler({ ...settings, enabled: true });
      let result;
      try { result = await enabled.check({ force: true }); }
      finally {
        if (enabled !== scheduler) {
          await enabled.close(); const previous = scheduler;
          scheduler = makeScheduler(settings); await previous.close();
        }
      }
      if (result.lastError) throw failure(result.lastError.code);
    });
    return status();
  }
  function requireFields(input, allowed) {
    if (!object(input) || Object.keys(input).some(key => !allowed.includes(key))) throw failure('BACKUP_CONFIG');
  }
  return {
    getSettings, status, saveSettings, check, backupNow,
    exportFile(input) { return run('export', () => { requireFields(input, ['file']); return exportBackup({ dataDir: directory, file: safePath(input.file), expectedInstanceId }); }); },
    verifyFile(input) { return run('verify', () => { requireFields(input, ['file']); return verifyBackup({ file: safePath(input.file) }); }); },
    restoreFile(input) {
      return run('restore', () => {
        requireFields(input, ['file', 'targetDir', 'expectedSha256', 'expectedBackupInstanceId']);
        const targetDir = safePath(input.targetDir);
        if (inside(targetDir, directory) || inside(directory, targetDir)) throw failure('BACKUP_PATH');
        if (input.expectedSha256 !== undefined && (typeof input.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedSha256))) throw failure('BACKUP_HASH');
        const backupInstanceId = input.expectedBackupInstanceId ?? expectedInstanceId;
        if (typeof backupInstanceId !== 'string' || !backupInstanceId.trim() || backupInstanceId.length > 200 || /[\u0000-\u001f]/u.test(backupInstanceId)) throw failure('BACKUP_IDENTITY');
        return restoreBackup({ file: safePath(input.file), targetDir, expectedInstanceId: backupInstanceId, expectedSha256: input.expectedSha256 });
      });
    },
    async close() { closed = true; if (active) await active.promise.catch(() => {}); await scheduler.close(); publish(); }
  };
}
