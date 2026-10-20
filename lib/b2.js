import { createHash } from 'node:crypto';

const TTL = 14 * 24 * 60 * 60 * 1000;
const cleanupGuards = new WeakMap();
const hash = value => createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function text(value, name, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new TypeError(`${name} must contain 1..${max} characters`);
  return value;
}
function id(value, name = 'id') {
  text(value, name, 200);
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._:@-]*$/u.test(value) || value === 'self') throw new TypeError(`Invalid ${name}`);
  return value;
}
function list(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) throw new TypeError(`${name} must contain at most 20 items`);
  return [...new Set(value.map(item => text(item, name, 120)))];
}
function timestamp(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(new Date(value).getTime())) throw new TypeError(`Invalid ${name}`);
  const day = value.slice(0, 10);
  if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day || +value.slice(11, 13) > 23 || +value.slice(14, 16) > 59 || +value.slice(17, 19) > 59) throw new TypeError(`Invalid ${name}`);
  return new Date(value).toISOString();
}
function versions(store, entryId) { return store.db.prepare('SELECT version,json FROM b2_notes WHERE id=? ORDER BY version').all(entryId); }
const directory = entryId => `b2/${hash(entryId)}`;

export function initializeB2(store) {
  const guard = new Set(); cleanupGuards.set(store, guard);
  store.db.function('feiyu_b2_cleanup_allowed', entryId => guard.has(entryId) ? 1 : 0);
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS b2_notes (id TEXT NOT NULL, version INTEGER NOT NULL, expires_at TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(id,version));
    CREATE INDEX IF NOT EXISTS b2_expiry ON b2_notes(expires_at);
    CREATE TABLE IF NOT EXISTS b2_requests (request_id TEXT PRIMARY KEY, hash TEXT NOT NULL, result_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS b2_expirations (id TEXT PRIMARY KEY, expired_at TEXT NOT NULL, last_version INTEGER NOT NULL, content_hash TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS immutable_b2_update BEFORE UPDATE ON b2_notes BEGIN SELECT RAISE(ABORT,'B2 versions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_b2_reinsert BEFORE INSERT ON b2_notes WHEN EXISTS (SELECT 1 FROM b2_notes WHERE id=NEW.id AND version=NEW.version) BEGIN SELECT RAISE(ABORT,'B2 versions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS guarded_b2_delete BEFORE DELETE ON b2_notes BEGIN
      SELECT CASE WHEN feiyu_b2_cleanup_allowed(OLD.id) <> 1 OR NOT EXISTS (SELECT 1 FROM b2_expirations WHERE id=OLD.id) THEN RAISE(ABORT,'B2 deletion requires expiry cleanup') END;
    END;
    CREATE TRIGGER IF NOT EXISTS immutable_b2_requests_update BEFORE UPDATE ON b2_requests BEGIN SELECT RAISE(ABORT,'B2 requests are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_b2_requests_delete BEFORE DELETE ON b2_requests BEGIN SELECT RAISE(ABORT,'B2 requests are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_b2_expiry_update BEFORE UPDATE ON b2_expirations BEGIN SELECT RAISE(ABORT,'B2 expiry records are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_b2_expiry_delete BEFORE DELETE ON b2_expirations BEGIN SELECT RAISE(ABORT,'B2 expiry records are immutable'); END;
  `);
}

export function getB2(store, entryId, { version, includeExpired = false } = {}) {
  store._assertOpen(); id(entryId);
  if (typeof includeExpired !== 'boolean' || (version !== undefined && (!Number.isSafeInteger(version) || version < 1))) throw new TypeError('Invalid B2 read options');
  const row = version === undefined ? store.db.prepare('SELECT json FROM b2_notes WHERE id=? ORDER BY version DESC LIMIT 1').get(entryId)
    : store.db.prepare('SELECT json FROM b2_notes WHERE id=? AND version=?').get(entryId, version);
  if (!row) return null;
  const record = JSON.parse(row.json);
  return !includeExpired && record.expiresAt <= store.now() ? null : record;
}

export function listB2(store, { includeHistory = false, includeExpired = false } = {}) {
  store._assertOpen();
  if (typeof includeHistory !== 'boolean' || typeof includeExpired !== 'boolean') throw new TypeError('Invalid B2 list options');
  const rows = store.db.prepare(includeHistory ? 'SELECT id,version FROM b2_notes ORDER BY id,version' : 'SELECT id,max(version) AS version FROM b2_notes GROUP BY id ORDER BY id').all();
  return rows.map(row => getB2(store, row.id, { version: row.version, includeExpired })).filter(Boolean);
}

export function writeB2(store, input = {}) {
  store._assertOpen();
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('B2 input must be an object');
  const allowed = new Set(['requestId', 'id', 'expectedVersion', 'action', 'text', 'judgment', 'reason', 'sources', 'hooks', 'tags']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new TypeError(`Unknown B2 field ${key}`);
  const entryId = id(input.id); const requestId = id(input.requestId, 'requestId');
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw new TypeError('expectedVersion is required');
  if (!['write', 'revoke'].includes(input.action)) throw new TypeError('Invalid B2 action');
  text(input.reason, 'reason', 2000);
  const payloadHash = hash(canonical(input));
  let created;
  const result = store._transaction(() => {
    if (store.db.prepare('SELECT 1 FROM memory_decisions WHERE request_id=?').get(requestId)) throw new Error('requestId belongs to another memory decision');
    const replay = store.db.prepare('SELECT hash,result_json FROM b2_requests WHERE request_id=?').get(requestId);
    if (replay) {
      if (replay.hash !== payloadHash) throw new Error('requestId already exists with different payload');
      const saved = JSON.parse(replay.result_json);
      return { ...saved, duplicate: true, expired: saved.expiresAt <= store.now() };
    }
    if (store.db.prepare('SELECT 1 FROM b2_expirations WHERE id=?').get(entryId)) throw new Error('B2 id has expired; use a new id for a new discovery');
    for (const table of ['entries', 'receipts', 'captures']) if (store.db.prepare(`SELECT 1 FROM ${table} WHERE id=? LIMIT 1`).get(entryId)) throw new Error('B2 id collides with another memory id');
    if (store.db.prepare('SELECT 1 FROM a2_purges WHERE entry_id=? LIMIT 1').get(entryId)) throw new Error('B2 id collides with a purged A2 identity');
    const old = getB2(store, entryId, { includeExpired: true });
    const now = store.now();
    if (old && old.expiresAt <= now) throw new Error('B2 has expired; use a new id');
    if (input.expectedVersion !== (old?.version ?? 0)) throw new Error('B2 version conflict');
    if (input.action === 'revoke' && !old) throw new Error('B2 does not exist');
    let externalSources;
    if (input.action === 'write') {
      text(input.text, 'text', 600); text(input.judgment, 'judgment', 600);
      if (!Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > 10) throw new TypeError('B2 requires 1..10 external sources');
      externalSources = input.sources.map(source => {
        if (!source || typeof source !== 'object') throw new TypeError('Invalid external source');
        if (Object.keys(source).some(key => !['url', 'title', 'accessedAt'].includes(key))) throw new TypeError('Unknown B2 source field');
        const url = new URL(text(source.url, 'url', 2000));
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new TypeError('Sources require HTTP(S) URLs without credentials');
        text(url.href, 'normalized URL', 2000);
        const accessedAt = timestamp(source.accessedAt ?? now, 'accessedAt');
        if (accessedAt > now) throw new TypeError('Source accessedAt cannot be in the future');
        return { url: url.href, title: text(source.title, 'title', 200), accessedAt };
      });
    }
    const createdAt = old?.createdAt ?? now;
    created = input.action === 'revoke' ? { ...old, status: 'archived' } : {
      id: entryId, instanceId: store.instanceId, kind: 'b2', pool: 'b2', text: input.text,
      judgment: input.judgment, externalSources, sources: [], hooks: list(input.hooks, 'hooks'), tags: list(input.tags, 'tags'),
      entities: [], aliases: [], occurredAt: null, project: null, status: 'active', createdAt,
      expiresAt: new Date(new Date(createdAt).getTime() + TTL).toISOString(),
      sourceNature: 'autonomous_browsing_note', evidenceStatus: 'external_reference', currentValidity: 'unknown', independentSourceCount: null,
    };
    Object.assign(created, { version: (old?.version ?? 0) + 1, recordedAt: now, date: store._local(now).date, dictVersion: 'v5', b2Decision: { requestId, action: input.action, reason: input.reason, decidedAt: now, sourceVersion: old?.version ?? 0 } });
    store.db.prepare('INSERT INTO b2_notes(id,version,expires_at,json) VALUES (?,?,?,?)').run(entryId, created.version, created.expiresAt, JSON.stringify(created));
    const saved = { id: entryId, version: created.version, pool: 'b2', kind: 'b2', status: created.status, expiresAt: created.expiresAt, evidenceStatus: 'external_reference', duplicate: false };
    store.db.prepare('INSERT INTO b2_requests(request_id,hash,result_json) VALUES (?,?,?)').run(requestId, payloadHash, JSON.stringify(saved));
    store._queueProjection(`${directory(entryId)}/v${created.version}.json`); store._queueProjection(`${directory(entryId)}/current.json`); store._queueProjection('b2/index.json');
    return saved;
  });
  if (created) {
    store.writeProjection(`${directory(entryId)}/v${created.version}.json`, JSON.stringify(created, null, 2) + '\n');
    store.writeProjection(`${directory(entryId)}/current.json`, JSON.stringify(created, null, 2) + '\n');
    projectIndex(store);
  }
  return store._writeResult(result);
}

export function cleanupB2(store, { apply = false } = {}) {
  store._assertOpen(); if (typeof apply !== 'boolean') throw new TypeError('apply must be boolean');
  const now = store.now();
  const rows = store.db.prepare('SELECT id,max(version) AS version FROM b2_notes WHERE expires_at<=? GROUP BY id ORDER BY id').all(now);
  let removed = 0;
  if (apply && rows.length) store._transaction(() => {
    const guard = cleanupGuards.get(store);
    for (const row of rows) {
      const existing = versions(store, row.id);
      store.db.prepare('INSERT INTO b2_expirations(id,expired_at,last_version,content_hash) VALUES (?,?,?,?)').run(row.id, now, row.version, hash(JSON.stringify(existing)));
      guard.add(row.id);
      try { store.db.prepare('DELETE FROM b2_notes WHERE id=?').run(row.id); } finally { guard.delete(row.id); }
      for (const version of existing) store._queueProjection(`${directory(row.id)}/v${version.version}.json`, 'delete');
      store._queueProjection(`${directory(row.id)}/current.json`, 'delete'); removed++;
    }
    store._queueProjection('b2/index.json');
  });
  if (apply && removed) {
    drainDeletes(store);
    projectIndex(store);
  }
  return { eligible: rows.length, removed, applied: apply, projectionPending: store.projectionStatus().projectionPending };
}

function drainDeletes(store) {
  for (const row of store.db.prepare("SELECT path FROM projection_pending WHERE operation='delete' AND path LIKE 'b2/%'").all()) store._removeProjection(row.path);
}

function projectIndex(store) {
  const rows = store.db.prepare(`SELECT n.id,n.version,json_extract(n.json,'$.text') AS text,json_extract(n.json,'$.status') AS status,json_extract(n.json,'$.recordedAt') AS recordedAt,n.expires_at AS expiresAt FROM b2_notes n JOIN (SELECT id,max(version) AS version FROM b2_notes GROUP BY id) latest ON n.id=latest.id AND n.version=latest.version WHERE n.expires_at>? ORDER BY n.id`).all(store.now());
  store.writeProjection('b2/index.json', JSON.stringify(rows.map(row => ({ ...row, text: row.text.slice(0, 80) })), null, 2) + '\n');
}

export function projectB2(store) {
  // Retry queued expiry deletions first; expired bodies never return to the index.
  drainDeletes(store);
  for (const record of listB2(store, { includeHistory: true })) store.writeProjection(`${directory(record.id)}/v${record.version}.json`, JSON.stringify(record, null, 2) + '\n');
  const current = listB2(store);
  for (const record of current) store.writeProjection(`${directory(record.id)}/current.json`, JSON.stringify(record, null, 2) + '\n');
  projectIndex(store);
}
