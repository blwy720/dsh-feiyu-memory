import { createHash } from 'node:crypto';

export const POLICY_VERSION = 5;
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
const pointer = (id, version) => ({ tool: 'memory_read', arguments: { id, version } });
function text(value, name, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new TypeError(`Invalid ${name}`);
  return value;
}
function id(value) { text(value, 'id', 200); if (!/^[\p{L}\p{N}][\p{L}\p{N}._:@-]*$/u.test(value)) throw new TypeError('Invalid id'); return value; }
export function explicitStatement(input, { required = false } = {}) {
  const type = input.statementType ?? (required ? null : 'fact');
  if (!['fact', 'self_report'].includes(type) || input.inference != null) throw new TypeError('A2/A3 require explicit statementType fact or self_report; inference is not allowed');
  return type;
}
export function normalizeBody(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.persons) || !body.persons.length || body.persons.length > 20) throw new TypeError('A3 body requires time, persons and event');
  return { time: text(body.time, 'body.time', 300), persons: [...new Set(body.persons.map(person => text(person, 'body.persons', 200)))], event: text(body.event, 'body.event', 2000) };
}
export function sourceTimes(store, sources) {
  const rows = [];
  for (const source of sources) {
    const raw = store.getRaw(source.rawId);
    if (raw) rows.push({ rawId: raw.id, sessionId: raw.sessionId ?? null, recordedAt: raw.recordedAt, occurredAt: raw.occurredAt ?? null });
  }
  return [...new Map(rows.map(row => [row.rawId, row])).values()];
}
export function dependencyEntries(store, values = []) {
  if (!Array.isArray(values) || values.length > 50) throw new TypeError('dependencyEntries must contain at most 50 exact versions');
  const seen = new Set();
  return values.map(item => {
    const entryId = id(item?.id);
    if (!Number.isSafeInteger(item.version) || item.version < 1 || seen.has(`${entryId}:${item.version}`)) throw new TypeError('Invalid dependency version');
    seen.add(`${entryId}:${item.version}`);
    const entry = store.getEntry(entryId, { version: item.version });
    if (!entry || entry.kind === 'b2') throw new Error('Dependency must resolve to a retained entry or provenance tombstone');
    return { id: entryId, version: item.version, read: pointer(entryId, item.version) };
  });
}
export function initializePolicy(store) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS early_reviews(raw_id TEXT PRIMARY KEY,request_id TEXT NOT NULL,json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS correction_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,request_id TEXT NOT NULL,target_id TEXT NOT NULL,target_version INTEGER NOT NULL,json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS correction_target ON correction_events(target_id,target_version,seq);
    CREATE TABLE IF NOT EXISTS a2_purges(entry_id TEXT NOT NULL,version INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(entry_id,version));
    CREATE TABLE IF NOT EXISTS original_purges(raw_id TEXT PRIMARY KEY,json TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS immutable_early_update BEFORE UPDATE ON early_reviews BEGIN SELECT RAISE(ABORT,'early reviews are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_early_delete BEFORE DELETE ON early_reviews BEGIN SELECT RAISE(ABORT,'early reviews are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_correction_update BEFORE UPDATE ON correction_events BEGIN SELECT RAISE(ABORT,'corrections are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_correction_delete BEFORE DELETE ON correction_events BEGIN SELECT RAISE(ABORT,'corrections are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_purges_update BEFORE UPDATE ON a2_purges BEGIN SELECT RAISE(ABORT,'purges are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_purges_delete BEFORE DELETE ON a2_purges BEGIN SELECT RAISE(ABORT,'purges are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_original_purges_update BEFORE UPDATE ON original_purges BEGIN SELECT RAISE(ABORT,'purges are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_original_purges_delete BEFORE DELETE ON original_purges BEGIN SELECT RAISE(ABORT,'purges are immutable'); END;
  `);
}
export function inPreferenceScope(store, subject) {
  if (subject === 'self') return true;
  const node = store.db.prepare("SELECT version,kind,json_extract(json,'$.pool') AS pool,json_extract(json,'$.status') AS status FROM entries WHERE id=? ORDER BY version DESC LIMIT 1").get(subject);
  if (!node || node.kind !== 'entity' || node.pool !== 'c' || node.status !== 'active') return false;
  if (store.db.prepare('SELECT 1 FROM audits WHERE entry_id=? AND version=?').get(subject, node.version) || correctionState(store, { id: subject, version: node.version }).correctness.status !== 'unreviewed') return false;
  const rows = store.db.prepare("SELECT id,version,json_extract(json,'$.from') AS f,json_extract(json,'$.to') AS t FROM entries e WHERE kind='relation' AND version=(SELECT max(version) FROM entries WHERE id=e.id) AND json_extract(json,'$.pool')='c' AND json_extract(json,'$.status')='active' AND ((json_extract(json,'$.from')='self' AND json_extract(json,'$.to')=?) OR (json_extract(json,'$.from')=? AND json_extract(json,'$.to')='self'))").all(subject, subject);
  return rows.some(row => !store.db.prepare('SELECT 1 FROM audits WHERE entry_id=? AND version=?').get(row.id, row.version) && correctionState(store, { id: row.id, version: row.version }).correctness.status === 'unreviewed');
}
export function correctionState(store, entry) {
  // Follow only explicit version links. Visiting a cycle never duplicates an event.
  const queue = [{ id: entry.id, version: entry.version, direct: true }]; const seen = new Set(); const events = []; const state = [];
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i]; const key = `${item.id}:${item.version}`;
    if (seen.has(key)) continue; seen.add(key);
    for (const row of store.db.prepare("SELECT seq,request_id AS requestId,json_extract(json,'$.changeType') AS changeType,json_extract(json,'$.status') AS status,substr(json_extract(json,'$.reason'),1,512) AS reason,json_extract(json,'$.decidedAt') AS decidedAt FROM correction_events WHERE target_id=? AND target_version=? ORDER BY seq").all(item.id, item.version)) {
      const view = { ...row, target: { id: item.id, version: item.version }, propagated: !item.direct };
      (row.changeType === 'state_change' ? state : events).push(view);
    }
    const row = store.db.prepare("SELECT json_extract(json,'$.sourceEntries') AS parents,json_extract(json,'$.dependencyEntries') AS dependencies FROM entries WHERE id=? AND version=?").get(item.id, item.version);
    if (row) for (const link of [...JSON.parse(row.parents ?? '[]'), ...JSON.parse(row.dependencies ?? '[]')]) queue.push({ id: link.id, version: link.version, direct: false });
  }
  const unique = [...new Map(events.map(event => [event.seq, event])).values()].sort((a, b) => b.seq - a.seq);
  // A source correction marks dependents for review, never supersedes them blindly.
  const direct = unique.find(event => !event.propagated);
  const status = direct?.status ?? (unique.length ? 'needs_review' : 'unreviewed');
  return { correctness: { status, events: unique.slice(0, 20), eventCount: unique.length, eventsTruncated: unique.length > 20 }, currentStateChanged: state.length > 0, currentStateEvents: state.slice(-20).reverse() };
}
export function decoratePolicy(store, entry) {
  if (!entry) return entry;
  if (entry.policyVersion !== POLICY_VERSION && ['a2', 'a3'].includes(entry.pool)) {
    entry.legacyPolicy = true;
    if (entry.statementType === 'inference') entry.legacyInference = true;
  }
  if (entry.kind === 'preference') entry.scopeEligible = inPreferenceScope(store, entry.subject ?? 'self');
  Object.assign(entry, correctionState(store, entry));
  return entry;
}
export function requestEarlyReview(store, { requestId, rawIds, reason } = {}) {
  id(requestId); text(reason, 'reason');
  if (!Array.isArray(rawIds) || !rawIds.length || rawIds.length > 20 || new Set(rawIds).size !== rawIds.length) throw new TypeError('rawIds must contain 1..20 unique IDs');
  rawIds.forEach(id);
  const payload = { requestId, rawIds, reason }; const digest = hash(payload);
  const result = store._transaction(() => {
    const replay = store._policyReplay(requestId, digest); if (replay) return replay;
    const requestedAt = store.now();
    for (const rawId of rawIds) {
      if (!store.getRaw(rawId)) throw new Error(`Raw is missing: ${rawId}`);
      if (store.db.prepare('SELECT 1 FROM self_review_completed WHERE raw_id=?').get(rawId)) throw new Error('Raw already reviewed');
      if (!store.db.prepare('SELECT 1 FROM early_reviews WHERE raw_id=?').get(rawId)) store.db.prepare('INSERT INTO early_reviews(raw_id,request_id,json) VALUES (?,?,?)').run(rawId, requestId, JSON.stringify({ rawId, requestId, reason, requestedAt }));
    }
    const saved = { requestId, type: 'early_review', rawIds, requested: rawIds.length, duplicate: false };
    store._policySaveDecision({ ...saved, reason, requestedAt }, digest, saved); return saved;
  });
  store._projectDecisions(); return store._writeResult(result);
}
export function applyCorrection(store, input = {}) {
  const { requestId, targets, status, reason, sources, changeType = 'correction', replacement } = input;
  id(requestId); text(reason, 'reason');
  if (!['correction', 'state_change'].includes(changeType)) throw new TypeError('Invalid changeType');
  if (changeType === 'correction' && !['needs_review', 'superseded', 'disputed'].includes(status)) throw new TypeError('Invalid correction status');
  if (changeType === 'state_change' && status !== undefined) throw new TypeError('state_change does not invalidate historical correctness');
  if (!Array.isArray(targets) || !targets.length || targets.length > 50) throw new TypeError('targets must contain exact versions');
  if (!Array.isArray(sources) || !sources.length || sources.length > 20) throw new TypeError('Correction requires original quoted evidence');
  const digest = hash({ requestId, targets, status, reason, sources, changeType, replacement });
  const result = store._transaction(() => {
    const replay = store._policyReplay(requestId, digest); if (replay) return replay;
    const normalized = dependencyEntries(store, targets);
    const replacementEntry = replacement ? dependencyEntries(store, [replacement])[0] : null;
    if (replacementEntry && normalized.some(item => item.id === replacementEntry.id && item.version === replacementEntry.version)) throw new Error('Replacement cannot be the corrected version');
    const evidence = sources.map(source => {
      const rawId = id(source?.rawId); const quote = text(source.quote, 'evidence quote', 1000000); const raw = store.getRaw(rawId);
      if (!raw || !raw.text.includes(quote)) throw new Error('Correction evidence must match original text');
      return { rawId, quote, role: raw.role, sourceNature: raw.sourceNature, quoteStatus: 'quote_verified', semanticStatus: 'declared_only' };
    });
    const decidedAt = store.now();
    for (const target of normalized) {
      const event = { requestId, target: { id: target.id, version: target.version }, status: status ?? null, changeType, reason, evidence, replacement: replacementEntry, decidedAt };
      store.db.prepare('INSERT INTO correction_events(request_id,target_id,target_version,json) VALUES (?,?,?,?)').run(requestId, target.id, target.version, JSON.stringify(event));
    }
    const saved = { requestId, type: 'correction', targets: normalized, changeType, status: status ?? null, duplicate: false };
    store._policySaveDecision({ ...saved, reason, decidedAt, evidence, replacement: replacementEntry }, digest, saved); return saved;
  });
  store._projectDecisions(); store._projectEntryIndex();
  for (const entry of store.listEntries()) store._projectEntryCurrent(entry);
  return store._writeResult(result);
}
export function assertCore(store, input = {}) {
  const { requestId, id: entryId, expectedVersion, kind, text: value, reason, category, statementType, inference, dependencyEntries: dependencies } = input;
  id(requestId); id(entryId); text(reason, 'reason');
  if (entryId === 'self') throw new Error('self is reserved');
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new TypeError('expectedVersion is required');
  if (!['entity', 'relation'].includes(kind)) throw new TypeError('C accepts only entity and relation');
  if (!['fact', 'self_report', 'inference'].includes(statementType)) throw new TypeError('Explicit core statementType is required');
  if (kind === 'entity' && !['identity', 'relationship'].includes(category) || kind === 'relation' && category !== 'relationship') throw new TypeError('Invalid core category');
  if (kind === 'entity') text(value, 'entity name', 200);
  const inferenceRecord = statementType === 'inference' ? { reasoning: text(inference?.reasoning, 'inference reasoning'), uncertainty: text(inference?.uncertainty, 'inference uncertainty', 500) } : null;
  if (statementType !== 'inference' && inference != null) throw new TypeError('Non-inference C assertion cannot carry inference');
  const digest = hash(input); let created;
  const result = store._transaction(() => {
    const replay = store._policyReplay(requestId, digest); if (replay) return replay;
    const old = store.getEntry(entryId);
    if (old && (old.pool !== 'c' || old.kind !== kind)) throw new Error('Direct C assertions require new ID or same-kind C entry');
    const base = store._prepareEntry({ ...input, id: entryId, statementType: 'fact', inference: undefined, pool: 'a2' });
    if (kind === 'relation') for (const endpoint of [base.from, base.to]) {
      const node = endpoint === 'self' ? null : store.getEntry(endpoint);
      if (endpoint !== 'self' && (!node || node.kind !== 'entity' || node.pool !== 'c' || node.status !== 'active' || node.auditDowngraded || node.correctness.status !== 'unreviewed')) throw new Error('Core endpoints require active reviewed core entities');
    }
    const decidedAt = store.now();
    created = { ...base, pool: 'c', statementType, ...(inferenceRecord ? { inference: inferenceRecord } : {}), evidenceStatus: statementType === 'inference' ? 'inference' : base.evidenceStatus, sourceNature: 'core_assertion', dependencyEntries: dependencyEntries(store, dependencies), coreDecision: { requestId, action: 'assert', reason, category, sourceVersion: old?.version ?? 0, decidedAt }, recordedAt: decidedAt, date: store._local(decidedAt).date };
    store._commitPolicyEntry(created, { expectedVersion, core: true });
    const saved = { requestId, type: 'core', id: entryId, version: created.version, pool: 'c', action: 'assert', duplicate: false, read: pointer(entryId, created.version) };
    store._policySaveDecision({ ...saved, reason, category, statementType, decidedAt }, digest, saved); return saved;
  });
  if (created) store._projectEntry(created); store._projectEntryIndex(); store._projectDecisions(); return store._writeResult(result);
}
