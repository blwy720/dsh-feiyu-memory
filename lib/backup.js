import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { createGzip, createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Worker } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';

const MAGIC = Buffer.from('FEIYU-BACKUP/1\n');
const MAX_MANIFEST = 65536;
const MAX_DATABASE = 64 * 1024 ** 3;
const STATE_FILE = 'backup-state.json';
export const LATEST_BACKUP = 'latest.feiyu-backup';
const SUPPORTED_SCHEMA = 7;
const RETRY = new Set(['EPERM', 'EACCES', 'EBUSY', 'EAGAIN']);
const AUTHORITY = {
  meta: [1, 'key value'], raw: [1, 'id date json'], originals: [1, 'id json'],
  receipts: [1, 'id pool hash json'], b_stats: [1, 'date role hour count'],
  entries: [1, 'id version kind json'], evidence: [1, 'entry_id version raw_id'],
  reviews: [1, 'seq raw_id decision json'], recalls: [1, 'seq json'],
  audits: [1, 'seq entry_id version json'], dirty_days: [1, 'date'],
  projection_pending: [2, 'path operation error_code updated_at'],
  captures: [2, 'id pool role hash json'],
  deletion_tombstones: [2, 'raw_id review_seq decision raw_hash deleted_at json'],
  integrity_audits: [2, 'seq json'],
  memory_decisions: [3, 'seq request_id kind entry_id hash json result_json'],
  self_review_completed: [3, 'raw_id request_id'],
  a2_reviews: [4, 'seq entry_id version request_id json'],
  a2_retirements: [4, 'entry_id version json'],
  b2_notes: [4, 'id version expires_at json'], b2_requests: [4, 'request_id hash result_json'],
  b2_expirations: [4, 'id expired_at last_version content_hash'],
  completed_rounds: [5, 'session_id turn_id completed_at json'],
  completed_round_parts: [5, 'session_id turn_id ordinal raw_id capture_id role recorded_at source_root raw_hash code_points'],
  preinject_choices: [5, 'target_session_id first_turn_id json'],
  early_reviews: [6, 'raw_id request_id json'],
  correction_events: [6, 'seq request_id target_id target_version json'],
  a2_purges: [6, 'entry_id version json'], original_purges: [6, 'raw_id json'],
  workflow_events: [7, 'seq request_id kind json'], workflow_sources: [7, 'request_id raw_id']
};

function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function requirePath(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw failure('BACKUP_PATH', `${label} must be an explicit absolute path`);
  return path.resolve(value);
}
function checked(value, label = 'path') {
  const absolute = requirePath(value, label), root = path.parse(absolute).root;
  let cursor = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) throw failure('BACKUP_LINK', 'Symbolic links and junctions are not permitted in backup paths');
      if (cursor !== absolute && !stat.isDirectory()) throw failure('BACKUP_PATH', 'A path ancestor is not a directory');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return absolute;
}
function inside(candidate, directory) {
  const relative = path.relative(directory, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function sourcePaths(dataDir) {
  const directory = checked(dataDir, 'dataDir'), database = checked(path.join(directory, 'memory.sqlite'));
  if (!fs.statSync(directory).isDirectory() || !fs.statSync(database).isFile()) throw failure('BACKUP_SOURCE', 'Memory database is unavailable');
  for (const suffix of ['-wal', '-shm', '-journal']) checked(database + suffix);
  return { directory, database };
}
function privateDirectory(directory) {
  checked(directory); fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); checked(directory);
  if (!fs.statSync(directory).isDirectory()) throw failure('BACKUP_PATH', 'Backup parent is not a directory');
}
function safeTemporary(parent) {
  privateDirectory(parent);
  const directory = fs.mkdtempSync(path.join(parent, '.feiyu-backup-'));
  fs.chmodSync(directory, 0o700);
  return directory;
}
function removeTemporary(directory, parent) {
  const target = checked(directory), resolvedParent = checked(parent);
  if (path.dirname(target) !== resolvedParent || !path.basename(target).startsWith('.feiyu-backup-')) throw failure('BACKUP_PATH', 'Unexpected temporary directory');
  fs.rmSync(target, { recursive: true, force: true });
}
function syncFile(file) { const descriptor = fs.openSync(checked(file), 'r+'); try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); } }
function syncDirectory(directory) {
  let descriptor;
  try { descriptor = fs.openSync(directory, 'r'); fs.fsyncSync(descriptor); }
  catch (error) { if (!['EPERM', 'EACCES', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EBADF'].includes(error.code)) throw error; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}
function identityFrom(db) {
  const table = db.prepare("SELECT type FROM sqlite_master WHERE name='meta'").get();
  if (table?.type !== 'table') throw failure('BACKUP_IDENTITY', 'Backup does not contain a memory identity table');
  let identity;
  try { identity = JSON.parse(db.prepare("SELECT value FROM meta WHERE key='identity'").get()?.value); }
  catch { throw failure('BACKUP_IDENTITY', 'Memory identity is invalid'); }
  if (!identity || !Number.isSafeInteger(identity.schema) || identity.schema < 1 || identity.schema > SUPPORTED_SCHEMA) throw failure('BACKUP_SCHEMA', 'Unsupported memory schema');
  if (typeof identity.instanceId !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N}._:@-]{0,199}$/u.test(identity.instanceId)) throw failure('BACKUP_IDENTITY', 'Memory instance identity is invalid');
  if (typeof identity.timezone !== 'string') throw failure('BACKUP_IDENTITY', 'Memory timezone is invalid');
  try { new Intl.DateTimeFormat('en', { timeZone: identity.timezone }); }
  catch { throw failure('BACKUP_IDENTITY', 'Memory timezone is invalid'); }
  return identity;
}
function inspectAuthority(db, identity) {
  const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
  const validId = value => typeof value === 'string' && /^[\p{L}\p{N}][\p{L}\p{N}._:@-]{0,199}$/u.test(value);
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const ensure = value => { if (!value) throw failure('BACKUP_RECORD', 'Memory authority record is malformed'); };
  // Check the claimed schema before a constructor could recreate missing tables.
  // Iterate individual rows: validation must not retain the whole database body.
  for (const [table, [introduced, columns]] of Object.entries(AUTHORITY)) {
    const present = db.prepare("SELECT type FROM sqlite_master WHERE name=?").get(table);
    if (!present && identity.schema < introduced) continue;
    if (present?.type !== 'table') throw failure('BACKUP_SCHEMA', 'Memory authority tables are missing');
    const actual = new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map(column => column.name));
    if (columns.split(' ').some(column => !actual.has(column))) throw failure('BACKUP_SCHEMA', 'Memory authority columns are missing');
    const jsonColumns = ['json', 'result_json'].filter(column => actual.has(column));
    if (!jsonColumns.length) continue;
    for (const row of db.prepare(`SELECT * FROM "${table}"`).iterate()) {
      for (const column of jsonColumns) {
        if (table === 'receipts' && row.pool === 'b' && row[column] === null) continue;
        let record;
        try { record = JSON.parse(row[column]); } catch { throw failure('BACKUP_RECORD', 'Memory authority JSON is malformed'); }
        ensure(object(record));
        if (column !== 'json') continue;
        if (table === 'raw' || table === 'originals') {
          ensure(validId(record.id) && record.id === row.id && record.instanceId === identity.instanceId
            && record.pool === 'a' && validId(record.sessionId) && typeof record.text === 'string'
            && ['user', 'assistant', 'tool'].includes(record.role) && validTime(record.recordedAt)
            && /^\d{4}-\d\d-\d\d$/.test(record.date ?? '') && (table !== 'raw' || record.date === row.date)
            && Array.isArray(record.entities) && Array.isArray(record.tags));
        } else if (table === 'entries' || table === 'b2_notes') {
          ensure(validId(record.id) && record.id === row.id && record.instanceId === identity.instanceId
            && Number.isSafeInteger(record.version) && record.version > 0 && record.version === row.version
            && typeof record.text === 'string' && validTime(record.recordedAt)
            && ['memory', 'doing', 'entity', 'relation', 'preference', 'a3', 'b2', 'knowledge'].includes(record.kind));
          if (table === 'entries') {
            ensure(record.kind === row.kind && Array.isArray(record.sources)
              && record.sources.every(source => object(source) && validId(source.rawId) && typeof source.quote === 'string'));
            for (const field of ['hooks', 'entities', 'aliases', 'tags']) if (record[field] !== undefined) ensure(Array.isArray(record[field]));
          } else ensure(record.kind === 'b2' && validTime(record.expiresAt) && record.expiresAt === row.expires_at);
        } else if (table === 'receipts') {
          ensure(['a', 'b'].includes(row.pool) && /^[a-f0-9]{64}$/.test(row.hash));
          if (row.pool === 'a') ensure(validTime(record.recordedAt));
          else ensure(/^\d{4}-\d\d-\d\d$/.test(record.date ?? '') && /^\d\d$/.test(record.hour ?? ''));
        } else if (table === 'captures') {
          ensure(['a', 'b'].includes(row.pool) && ['user', 'assistant', 'tool'].includes(row.role)
            && Array.isArray(record.partIds) && record.partIds.every(validId)
            && new Set(record.partIds).size === record.partIds.length && /^[a-f0-9]{64}$/.test(row.hash));
        } else if (table === 'memory_decisions') {
          ensure(typeof record.reason === 'string');
        }
      }
    }
  }
}
function inspectDatabase(file, expectedInstanceId) {
  const db = new DatabaseSync(checked(file), { readOnly: true, timeout: 5000 });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
    const identity = identityFrom(db);
    if (expectedInstanceId !== undefined && expectedInstanceId !== identity.instanceId) throw failure('BACKUP_IDENTITY', 'Memory instance identity does not match');
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') throw failure('BACKUP_INTEGRITY', 'SQLite integrity check failed');
    if (db.prepare('PRAGMA foreign_key_check').get()) throw failure('BACKUP_FOREIGN_KEY', 'SQLite foreign key check failed');
    inspectAuthority(db, identity);
    return identity;
  } finally { db.close(); }
}
async function inspectRestorability(file, identity, temporary) {
  // Real startup/migration/retention is exercised only on an expendable clone.
  // The DB that is hashed, exported or restored remains byte-for-byte unchanged.
  const directory = path.join(temporary, 'startup-validation');
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.copyFileSync(file, path.join(directory, 'memory.sqlite'), fs.constants.COPYFILE_EXCL);
  let store;
  try {
    const { MemoryStore } = await import('./store.js');
    store = new MemoryStore({ dataDir: directory, instanceId: identity.instanceId, timezone: identity.timezone });
    store.metadata();
    for (const row of store.db.prepare('SELECT id FROM raw UNION SELECT id FROM originals').iterate()) store.getRaw(row.id);
    for (const row of store.db.prepare('SELECT id,version FROM entries ORDER BY id,version').iterate()) store.getEntry(row.id, { version: row.version });
    for (const row of store.db.prepare('SELECT id,version FROM b2_notes ORDER BY id,version').iterate()) store.getB2(row.id, { version: row.version });
    for (const row of store.db.prepare('SELECT target_session_id,first_turn_id FROM preinject_choices').iterate()) {
      store.readPreinject({ targetSessionId: row.target_session_id, turnId: row.first_turn_id });
    }
    store.listReviewQueue({ limit: 1 }); store.listA2ReviewQueue({ limit: 1 }); store.a3Stats();
    store.reviewHistory({ limit: 1 }); store.graph({ limit: 1 });
    if (store.projectionStatus().pending) throw failure('BACKUP_RESTORE', 'Memory projection rebuild did not complete');
  } catch {
    throw failure('BACKUP_RESTORE', 'Memory snapshot cannot be opened and read by this version');
  } finally { store?.close(); }
}
async function hashFile(file) {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of fs.createReadStream(file)) { hash.update(chunk); bytes += chunk.length; }
  return { sha256: hash.digest('hex'), bytes };
}
function fingerprint(dataDir) {
  const { database } = sourcePaths(dataDir);
  const parts = [];
  for (const suffix of ['', '-wal']) {
    try { const stat = fs.statSync(checked(database + suffix), { bigint: true }); parts.push([suffix, String(stat.dev), String(stat.ino), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)]); }
    catch (error) { if (error.code !== 'ENOENT') throw error; parts.push([suffix, null]); }
  }
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
function fileStamp(file) {
  try { const stat = fs.lstatSync(checked(file), { bigint: true }); if (!stat.isFile() || stat.nlink > 1n) throw failure('BACKUP_PATH', 'Backup target must be a regular, unlinked file'); return [String(stat.dev), String(stat.ino), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)].join(':'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Atomic rename never deletes the previous destination as a retry strategy. */
export async function atomicReplace(temporary, destination, { rename = fs.renameSync, attempts = 5 } = {}) {
  const source = checked(temporary), target = checked(destination);
  for (let attempt = 0; ; attempt++) {
    try { checked(source); checked(target); rename(source, target); syncDirectory(path.dirname(target)); return; }
    catch (error) { if (!RETRY.has(error.code) || attempt >= attempts - 1) throw error; await delay(25 * 2 ** attempt); }
  }
}

function validateManifest(value) {
  if (!value || value.format !== 'feiyu-backup' || value.formatVersion !== 1 || value.compression !== 'gzip' || value.database?.name !== 'memory.sqlite') throw failure('BACKUP_FORMAT', 'Unsupported backup file format');
  if (!Number.isSafeInteger(value.database.bytes) || value.database.bytes < 512 || value.database.bytes > MAX_DATABASE || !/^[a-f0-9]{64}$/.test(value.database.sha256 ?? '')) throw failure('BACKUP_FORMAT', 'Invalid database size or checksum');
  if (!Number.isSafeInteger(value.identity?.schema) || value.identity.schema < 1 || value.identity.schema > SUPPORTED_SCHEMA) throw failure('BACKUP_SCHEMA', 'Unsupported memory schema');
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) throw failure('BACKUP_FORMAT', 'Invalid snapshot time');
  return value;
}

/** Gzip payload: magic, uint32-BE JSON byte length, JSON manifest, exact DB bytes. */
async function unpack(file, databaseFile, { expectedSha256, artifact } = {}) {
  if (expectedSha256 !== undefined && (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256))) throw failure('BACKUP_HASH', 'Expected backup checksum is invalid');
  const input = fs.createReadStream(checked(file)), stream = createGunzip();
  const packedHash = createHash('sha256'); let packedBytes = 0;
  input.on('data', chunk => { packedHash.update(chunk); packedBytes += chunk.length; });
  input.on('error', error => stream.destroy(error)); input.pipe(stream);
  const iterator = stream[Symbol.asyncIterator](); let current = Buffer.alloc(0), position = 0;
  async function take(length) {
    const result = Buffer.alloc(length); let written = 0;
    while (written < length) {
      if (position === current.length) { const next = await iterator.next(); if (next.done) throw failure('BACKUP_FORMAT', 'Backup is truncated'); current = next.value; position = 0; }
      const count = Math.min(length - written, current.length - position); current.copy(result, written, position, position + count); written += count; position += count;
    }
    return result;
  }
  let descriptor;
  try {
    if (!(await take(MAGIC.length)).equals(MAGIC)) throw failure('BACKUP_FORMAT', 'Backup file signature is invalid');
    const length = (await take(4)).readUInt32BE();
    if (length < 2 || length > MAX_MANIFEST) throw failure('BACKUP_FORMAT', 'Backup manifest size is invalid');
    let manifest; try { manifest = validateManifest(JSON.parse((await take(length)).toString('utf8'))); }
    catch (error) { if (error.code?.startsWith('BACKUP_')) throw error; throw failure('BACKUP_FORMAT', 'Backup manifest is invalid'); }
    descriptor = await fs.promises.open(checked(databaseFile), 'wx', 0o600);
    const hash = createHash('sha256'); let bytes = 0;
    async function write(chunk) {
      if (!chunk.length) return;
      bytes += chunk.length;
      if (bytes > manifest.database.bytes) throw failure('BACKUP_FORMAT', 'Backup contains unexpected trailing data');
      hash.update(chunk); let offset = 0;
      while (offset < chunk.length) offset += (await descriptor.write(chunk, offset, chunk.length - offset)).bytesWritten;
    }
    await write(current.subarray(position));
    for (;;) { const next = await iterator.next(); if (next.done) break; await write(next.value); }
    await descriptor.sync();
    if (bytes !== manifest.database.bytes || hash.digest('hex') !== manifest.database.sha256) throw failure('BACKUP_HASH', 'Backup checksum or length does not match');
    const packedSha256 = packedHash.digest('hex');
    if (expectedSha256 !== undefined && packedSha256 !== expectedSha256) throw failure('BACKUP_CHANGED', 'Backup no longer matches the confirmed checksum');
    if (artifact) Object.assign(artifact, { sha256: packedSha256, bytes: packedBytes });
    return manifest;
  } finally { input.destroy(); stream.destroy(); if (descriptor) await descriptor.close(); }
}

function worker(operation, options) {
  return new Promise((resolve, reject) => {
    const task = new Worker(new URL('./backup-worker.js', import.meta.url), { workerData: { operation, options },
      // This worker needs only built-ins. Parent test-runner/desktop V8 flags
      // are often invalid as explicit Worker flags; never forward them.
      execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 32 } });
    let result;
    task.once('message', message => { result = message; });
    task.once('error', error => reject(error.code === 'ERR_WORKER_OUT_OF_MEMORY'
      ? failure('BACKUP_MEMORY_LIMIT', 'Snapshot validation exceeded the backup worker heap limit')
      : error));
    task.once('exit', code => {
      if (code !== 0 || !result) return reject(failure('BACKUP_WORKER', 'Backup worker did not complete'));
      if (!result.ok) return reject(failure(result.code ?? 'BACKUP_FAILED', result.message ?? 'Backup operation failed'));
      resolve(result.value);
    });
  });
}

/** Manual export never overwrites an existing file. No source projections are opened. */
export function exportBackup({ dataDir, file, expectedInstanceId } = {}) {
  return worker('export', { dataDir, file, expectedInstanceId, replace: false });
}
/** Restore authority only. The normal store startup migrates/rebuilds projections. */
export function restoreBackup({ file, targetDir, expectedInstanceId, expectedSha256 } = {}) {
  return worker('restore', { file, targetDir, expectedInstanceId, expectedSha256 });
}
export function verifyBackup({ file, expectedInstanceId } = {}) { return worker('verify', { file, expectedInstanceId }); }

async function createExport({ dataDir, file, expectedInstanceId, replace = false, ownedStamp = null, ownedInstanceId = null }) {
  const { directory, database } = sourcePaths(dataDir), destination = checked(file, 'file'), parent = path.dirname(destination);
  if (inside(destination, directory)) throw failure('BACKUP_PATH', 'Backup must be outside the memory directory');
  if (path.basename(destination) === STATE_FILE) throw failure('BACKUP_PATH', 'Reserved backup state filename');
  if (!replace && path.basename(destination).toLowerCase() === LATEST_BACKUP) throw failure('BACKUP_PATH', 'Manual exports must use a name other than the automatic latest backup');
  privateDirectory(parent);
  const existing = fileStamp(destination);
  if (existing && !replace) throw failure('EEXIST', 'Export destination already exists');
  const temporary = safeTemporary(parent);
  try {
    // A destination with the reserved latest name is replaced only when it is
    // our prior file stamp, or a valid backup of this same memory instance.
    const source = new DatabaseSync(database, { readOnly: true, timeout: 5000 });
    const dbFile = path.join(temporary, 'memory.sqlite');
    let identity;
    try {
      source.exec('PRAGMA query_only=ON; BEGIN');
      identity = identityFrom(source); // pins a consistent WAL read snapshot
      const expectedBytes = source.prepare('PRAGMA page_count').get().page_count * source.prepare('PRAGMA page_size').get().page_size;
      if (!Number.isSafeInteger(expectedBytes) || expectedBytes > MAX_DATABASE) throw failure('BACKUP_SIZE', 'Memory snapshot exceeds the supported 64 GiB limit');
      if (expectedInstanceId !== undefined && identity.instanceId !== expectedInstanceId) throw failure('BACKUP_IDENTITY', 'Memory instance identity does not match');
      if (existing && (existing !== ownedStamp || ownedInstanceId !== identity.instanceId)) {
        const oldDb = path.join(temporary, 'previous.sqlite');
        const oldManifest = await unpack(destination, oldDb);
        inspectDatabase(oldDb, identity.instanceId);
        if (oldManifest.identity.instanceId !== identity.instanceId) throw failure('BACKUP_IDENTITY', 'Existing backup belongs to another memory instance');
      }
      await sqliteBackup(source, dbFile, { rate: 256 });
      source.exec('ROLLBACK');
    } finally { source.close(); }
    // Normalize only the private snapshot: one SQLite file without WAL state.
    const normalized = new DatabaseSync(dbFile);
    try { normalized.exec('PRAGMA journal_mode=DELETE;'); } finally { normalized.close(); }
    fs.chmodSync(dbFile, 0o600); syncFile(dbFile);
    identity = inspectDatabase(dbFile, expectedInstanceId);
    const databaseHash = await hashFile(dbFile);
    if (databaseHash.bytes > MAX_DATABASE) throw failure('BACKUP_SIZE', 'Memory snapshot exceeds the supported 64 GiB limit');
    const manifest = { format: 'feiyu-backup', formatVersion: 1, compression: 'gzip',
      moduleVersion: JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
      createdAt: new Date().toISOString(), identity, database: { name: 'memory.sqlite', ...databaseHash } };
    const json = Buffer.from(JSON.stringify(manifest)), size = Buffer.alloc(4); size.writeUInt32BE(json.length);
    const packed = path.join(temporary, 'snapshot.feiyu-backup');
    async function* contents() { yield MAGIC; yield size; yield json; yield* fs.createReadStream(dbFile); }
    await pipeline(Readable.from(contents()), createGzip(), fs.createWriteStream(packed, { flags: 'wx', mode: 0o600 }));
    syncFile(packed);
    // Validate the actual compressed artifact, not just the pre-compression DB.
    const roundTrip = path.join(temporary, 'verified.sqlite');
    const verified = await unpack(packed, roundTrip);
    const verifiedIdentity = inspectDatabase(roundTrip, expectedInstanceId);
    if (JSON.stringify(verified.identity) !== JSON.stringify(verifiedIdentity)) throw failure('BACKUP_IDENTITY', 'Backup manifest identity does not match database');
    await inspectRestorability(roundTrip, verifiedIdentity, temporary);
    const artifact = await hashFile(packed);
    checked(destination);
    if (fileStamp(destination) !== existing) throw failure('BACKUP_CONFLICT', 'Backup destination changed during snapshot creation');
    if (replace) await atomicReplace(packed, destination);
    else {
      // Hard-link creation is atomic and cannot overwrite a concurrent export.
      try { fs.linkSync(packed, destination); }
      catch (error) {
        if (!['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(error.code)) throw error;
        // Android's shared-storage filesystem does not support hard links.
        // Exclusive streamed-by-OS copy still cannot overwrite any existing
        // file; a crash may leave an invalid manual export, never a lost old one.
        fs.copyFileSync(packed, destination, fs.constants.COPYFILE_EXCL); syncFile(destination);
      }
      fs.unlinkSync(packed); syncDirectory(parent);
    }
    return { file: destination, manifest, sha256: artifact.sha256, bytes: artifact.bytes, fileStamp: fileStamp(destination), validated: true };
  } finally { removeTemporary(temporary, parent); }
}

async function verifyOrRestore({ file, targetDir, expectedInstanceId, expectedSha256 }, restore) {
  const source = checked(file, 'file');
  if (!fs.statSync(source).isFile()) throw failure('BACKUP_PATH', 'Backup input is not a regular file');
  let destination, parent;
  if (restore) {
    destination = checked(targetDir, 'targetDir'); parent = path.dirname(destination);
    if (inside(source, destination) || destination === path.parse(destination).root) throw failure('BACKUP_PATH', 'Restore target conflicts with input');
    try { if (!fs.statSync(destination).isDirectory() || fs.readdirSync(destination).length) throw failure('BACKUP_TARGET', 'Restore requires a new or empty directory'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  } else parent = checked(fs.realpathSync(tmpdir()));
  const temporary = safeTemporary(parent);
  try {
    const staged = path.join(temporary, 'restored'); fs.mkdirSync(staged, { mode: 0o700 });
    const dbFile = path.join(staged, 'memory.sqlite');
    const artifact = {};
    const manifest = await unpack(source, dbFile, { expectedSha256, artifact }), identity = inspectDatabase(dbFile, expectedInstanceId);
    if (JSON.stringify(identity) !== JSON.stringify(manifest.identity)) throw failure('BACKUP_IDENTITY', 'Backup manifest identity does not match database');
    await inspectRestorability(dbFile, identity, temporary);
    if (!restore) return { manifest, validated: true, ...artifact };
    fs.writeFileSync(path.join(staged, 'identity.json'), JSON.stringify(identity, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    syncFile(path.join(staged, 'identity.json')); syncDirectory(staged);
    checked(destination);
    let removedEmpty = false;
    try {
      if (fs.existsSync(destination)) { if (fs.readdirSync(destination).length) throw failure('BACKUP_TARGET', 'Restore target is no longer empty'); fs.rmdirSync(destination); removedEmpty = true; }
      fs.renameSync(staged, destination); syncDirectory(parent);
    } catch (error) { if (removedEmpty && !fs.existsSync(destination)) fs.mkdirSync(destination, { mode: 0o700 }); throw error; }
    return { targetDir: destination, identity, manifest, ...artifact, needsRebuild: true, projectionPending: true,
      warnings: ['This restores the snapshot state; later changes are not present.', 'Normal MemoryStore startup rebuilds projections, migrates supported older schemas, and applies current retention rules.'] };
  } finally { removeTemporary(temporary, parent); }
}

/** Worker entry: live sources and restored output are never opened as MemoryStore. */
export async function runBackupWorker(operation, options) {
  if (operation === 'export') return createExport(options);
  if (operation === 'restore') return verifyOrRestore(options, true);
  if (operation === 'verify') return verifyOrRestore(options, false);
  throw failure('BACKUP_OPERATION', 'Unknown backup operation');
}

function scheduleOptions({ schedule = 'interval', intervalDays = 1, timezone = 'Asia/Shanghai' } = {}) {
  if (!['interval', 'monthly'].includes(schedule) || !Number.isSafeInteger(intervalDays) || intervalDays < 1 || intervalDays > 30 || (schedule === 'monthly' && intervalDays !== 1)) throw failure('BACKUP_SCHEDULE', 'Use intervalDays 1..30 or monthly with the default intervalDays');
  new Intl.DateTimeFormat('en', { timeZone: timezone });
  return { schedule, intervalDays, timezone };
}
function localParts(date, timezone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date).filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)]));
}
export function nextBackupDue(lastSuccessAt, options = {}) {
  const { schedule, intervalDays, timezone } = scheduleOptions(options), previous = new Date(lastSuccessAt);
  if (!Number.isFinite(previous.getTime())) throw failure('BACKUP_SCHEDULE', 'Last success time is invalid');
  if (schedule === 'interval') return new Date(previous.getTime() + intervalDays * 86400000).toISOString();
  const parts = localParts(previous, timezone), year = parts.year + (parts.month === 12 ? 1 : 0), month = parts.month % 12;
  const day = Math.min(parts.day, new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
  const wall = Date.UTC(year, month, day, parts.hour, parts.minute, parts.second, previous.getUTCMilliseconds());
  let result = wall;
  const visited = new Set([result]);
  for (let i = 0; i < 4; i++) {
    const seen = localParts(new Date(result), timezone);
    const offset = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second) - Math.floor(result / 1000) * 1000;
    const next = wall - offset; if (next === result) break;
    // A nonexistent wall time in a spring-forward gap oscillates between two
    // instants. Choose the later one (compatible forward adjustment).
    if (visited.has(next)) { result = Math.max(result, next); break; }
    visited.add(next); result = next;
  }
  return new Date(result).toISOString();
}

export function readBackupStatus({ dataDir, backupDir } = {}) {
  const directory = checked(dataDir, 'dataDir'), file = checked(path.join(directory, STATE_FILE));
  try {
    if (fs.statSync(file).size > MAX_MANIFEST) throw failure('BACKUP_STATE', 'Backup state is too large');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.version !== 1 || (value.instanceId !== null && typeof value.instanceId !== 'string') || typeof value.backupFile !== 'string' ||
      (value.lastSuccessAt !== null && !Number.isFinite(Date.parse(value.lastSuccessAt)))) throw failure('BACKUP_STATE', 'Backup state is invalid');
    if (backupDir !== undefined && value.backupFile !== path.join(checked(backupDir), LATEST_BACKUP)) return { lastSuccessAt: null, lastError: null, dirty: true };
    const result = Object.fromEntries(['version', 'instanceId', 'backupFile', 'lastSuccessAt', 'snapshotCreatedAt', 'sourceFingerprint', 'sha256', 'fileStamp'].filter(key => Object.hasOwn(value, key)).map(key => [key, structuredClone(value[key])]));
    result.lastError = value.lastError ? { code: /^[A-Z0-9_]+$/.test(value.lastError.code ?? '') ? value.lastError.code : 'BACKUP_FAILED',
      ...(typeof value.lastError.at === 'string' && Number.isFinite(Date.parse(value.lastError.at)) ? { at: value.lastError.at } : {}) } : null;
    return result;
  } catch (error) { if (error.code === 'ENOENT') return { lastSuccessAt: null, lastError: null, dirty: true }; if (error.code === 'BACKUP_STATE') throw error; throw failure('BACKUP_STATE', 'Backup state could not be read'); }
}
async function saveState(dataDir, state) {
  const directory = checked(dataDir), destination = checked(path.join(directory, STATE_FILE));
  const temporary = checked(path.join(directory, `${STATE_FILE}.${randomUUID()}.tmp`));
  try {
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); syncFile(temporary);
    await atomicReplace(temporary, destination);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(checked(temporary)); }
}

/** Host owns its timer. check() is nonthrowing, coalesced and starts only if due+dirty. */
export function createBackupScheduler({ dataDir, backupDir, enabled = false, intervalDays = 1, schedule = 'interval', timezone = 'Asia/Shanghai', expectedInstanceId, now = () => new Date(), onStatus } = {}) {
  const frequency = scheduleOptions({ intervalDays, schedule, timezone }), directory = checked(dataDir, 'dataDir');
  if (typeof enabled !== 'boolean' || typeof now !== 'function') throw failure('BACKUP_CONFIG', 'Invalid backup scheduler configuration');
  let destination;
  if (enabled || backupDir !== undefined) {
    const backupDirectory = checked(backupDir, 'backupDir'); destination = path.join(backupDirectory, LATEST_BACKUP);
    if (inside(destination, directory)) throw failure('BACKUP_PATH', 'Backup must be outside the memory directory');
  }
  let saved;
  try { saved = readBackupStatus({ dataDir: directory, backupDir }); } catch { saved = { lastSuccessAt: null, lastError: { code: 'BACKUP_STATE' }, dirty: true }; }
  let status = { ...saved, enabled, running: false }, closed = false, inFlight = null;
  const publish = () => { try { onStatus?.(structuredClone(status)); } catch {} };
  const currentTime = () => { const value = new Date(now()); if (!Number.isFinite(value.getTime())) throw failure('BACKUP_CLOCK', 'Invalid backup clock'); return value.toISOString(); };
  async function execute(force) {
    try {
      const stamp = fingerprint(directory), existing = fileStamp(destination), time = currentTime();
      const dueAt = saved.lastSuccessAt ? nextBackupDue(saved.lastSuccessAt, frequency) : null;
      const owned = existing !== null && existing === saved.fileStamp;
      const dirty = stamp !== saved.sourceFingerprint || !owned;
      status = { ...status, dirty, nextDueAt: dueAt, lastCheckedAt: time };
      if (!force && (!dirty || (owned && dueAt && Date.parse(time) < Date.parse(dueAt)))) { publish(); return structuredClone(status); }
      status.running = true; publish();
      const exported = await worker('export', { dataDir: directory, file: destination, expectedInstanceId,
        replace: true, ownedStamp: saved.fileStamp ?? null, ownedInstanceId: saved.instanceId ?? null });
      const successAt = currentTime();
      saved = { version: 1, instanceId: exported.manifest.identity.instanceId, backupFile: destination,
        lastSuccessAt: successAt, snapshotCreatedAt: exported.manifest.createdAt, sourceFingerprint: stamp,
        sha256: exported.sha256, fileStamp: exported.fileStamp, lastError: null };
      await saveState(directory, saved);
      status = { ...saved, enabled, running: false, dirty: fingerprint(directory) !== stamp, nextDueAt: nextBackupDue(successAt, frequency) };
    } catch (error) {
      const code = typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'BACKUP_FAILED';
      status = { ...status, enabled, running: false, lastError: { code, at: new Date().toISOString() } };
      // Store only a code, never an exception message, SQL, content or credentials.
      try { await saveState(directory, { version: 1, instanceId: saved.instanceId ?? expectedInstanceId ?? null,
        backupFile: destination, lastSuccessAt: saved.lastSuccessAt ?? null, ...saved, lastError: status.lastError }); } catch {}
    }
    publish(); return structuredClone(status);
  }
  return {
    check({ force = false } = {}) {
      if (typeof force !== 'boolean') throw failure('BACKUP_CONFIG', 'force must be boolean');
      if (!enabled || closed) return Promise.resolve(structuredClone(status));
      if (!inFlight) { inFlight = execute(force).finally(() => { inFlight = null; }); } return inFlight;
    },
    status() { return structuredClone(status); },
    close() { closed = true; return inFlight ?? Promise.resolve(); },
  };
}
