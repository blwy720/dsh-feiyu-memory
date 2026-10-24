import { createHash } from 'node:crypto';
import { assertSafeMemoryPayload } from './redaction.js';
import { presentMemoryTimes } from './time-display.js';

const AGE = 7 * 86400000;
export function stableJSON(value) {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJSON(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const workflowHash = value => createHash('sha256').update(typeof value === 'string' ? value : stableJSON(value)).digest('hex');
export function wfText(value, name, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new TypeError(`Invalid ${name}`);
  return value;
}
export function wfId(value) { wfText(value, 'id', 200); if (!/^[\p{L}\p{N}][\p{L}\p{N}._:@-]*$/u.test(value)) throw new TypeError('Invalid id'); return value; }
export function wfTime(value, name = 'timestamp') {
  wfText(value, name, 40);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== value.slice(0, 10) || +value.slice(11, 13) > 23 || +value.slice(14, 16) > 59 || +value.slice(17, 19) > 59) throw new TypeError(`Invalid ${name}`);
  return new Date(value).toISOString();
}
export function exactReferences(store, values, { min = 1, current = false } = {}) {
  if (!Array.isArray(values) || values.length < min || values.length > 50) throw new TypeError('Expected 1..50 exact entry versions');
  const seen = new Set();
  return values.map(value => {
    const id = wfId(value?.id); const version = value.version;
    if (!Number.isSafeInteger(version) || version < 1 || seen.has(`${id}:${version}`)) throw new TypeError('Invalid or duplicate exact version');
    seen.add(`${id}:${version}`);
    const row = store.db.prepare('SELECT json FROM entries WHERE id=? AND version=?').get(id, version);
    if (!row || current && store.getEntry(id)?.version !== version) throw new Error(`Missing or changed entry version: ${id}@${version}`);
    return { id, version, hash: workflowHash(row.json), read: { tool: 'memory_read', arguments: { id, version } } };
  });
}

// Suggestions are exact slices of the original; they are never accepted as a quote automatically.
export function quoteError(raw, quote, message = 'Quote does not occur verbatim in original') {
  const lines = [...raw.text.matchAll(/[^\r\n]+/g)];
  const normalize = value => value.normalize('NFKC').replace(/[`*_\s:：]/g, '').toLowerCase();
  const query = normalize(quote); const tokens = new Set([...query]);
  const candidates = lines.map(line => {
    const text = line[0]; const normalized = normalize(text);
    const overlap = [...new Set([...normalized])].filter(char => tokens.has(char)).length;
    return { text, offset: line.index, length: text.length, score: query && normalized.includes(query) ? 2 : overlap / Math.max(tokens.size, 1) };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.offset - b.offset).slice(0, 3).map(({ text, offset, length }) => ({ text: text.slice(0, 500), offset, length: Math.min(length, 500), originalLineLength: length, truncated: text.length > 500 }));
  const error = new Error(`${message}: ${raw.id}`); error.code = 'QUOTE_MISMATCH';
  error.details = { rawId: raw.id, offsetUnit: 'utf16', candidates, action: 'Read the exact original slice and resubmit; punctuation and Markdown remain significant.' };
  return error;
}
export function sourceDerivation(raw, quote) {
  if (!raw.derivedFromMemory?.length && !raw.derivedFromRaw?.length) return {};
  if (raw.derivedSpans?.length) {
    let offset = raw.text.indexOf(quote); let overlaps = false;
    while (offset >= 0 && !overlaps) {
      overlaps = raw.derivedSpans.some(span => span.start < offset + quote.length && span.end > offset);
      if (!overlaps) offset = raw.text.indexOf(quote, offset + Math.max(quote.length, 1));
    }
    if (!overlaps) return {};
  }
  return { ...(raw.derivedFromMemory?.length ? { derivedFromMemory: raw.derivedFromMemory } : {}), ...(raw.derivedFromRaw?.length ? { derivedFromRaw: raw.derivedFromRaw } : {}), ...(raw.provenanceIncomplete ? { provenanceIncomplete: true } : {}), independent: false };
}
export function quotedEvidence(store, values = [], { required = false } = {}) {
  if (!Array.isArray(values) || values.length > 20 || required && !values.length) throw new TypeError('Original quoted evidence is required (maximum 20)');
  return values.map(value => {
    const rawId = wfId(value?.rawId); const quote = wfText(value.quote, 'quote', 1000000); const raw = store.getRaw(rawId);
    if (!raw) throw new Error(`Missing original: ${rawId}`);
    if (!raw.text.includes(quote)) throw quoteError(raw, quote);
    return { rawId, quote, role: raw.role, sourceRoot: raw.sourceRoot, sourceNature: raw.sourceNature, quoteStatus: 'quote_verified', semanticStatus: 'declared_only', ...sourceDerivation(raw, quote) };
  });
}
export function initializeWorkflow(store) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,request_id TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS workflow_kind ON workflow_events(kind,seq);
    CREATE TABLE IF NOT EXISTS workflow_sources(request_id TEXT NOT NULL,raw_id TEXT NOT NULL,PRIMARY KEY(request_id,raw_id));
    CREATE INDEX IF NOT EXISTS workflow_source_raw ON workflow_sources(raw_id);
    CREATE TRIGGER IF NOT EXISTS immutable_workflow_update BEFORE UPDATE ON workflow_events BEGIN SELECT RAISE(ABORT,'workflow events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_workflow_delete BEFORE DELETE ON workflow_events BEGIN SELECT RAISE(ABORT,'workflow events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_workflow_sources_update BEFORE UPDATE ON workflow_sources BEGIN SELECT RAISE(ABORT,'workflow sources are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_workflow_sources_delete BEFORE DELETE ON workflow_sources BEGIN SELECT RAISE(ABORT,'workflow sources are immutable'); END;
  `);
  store.db.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)').run('workflow_history_started_at', store.now());
}
export function recordEntryCommits(store, before, transactionId) {
  const committedAt = store.now();
  const rows = [
    ...store.db.prepare("SELECT id,version,kind,coalesce(json_extract(json,'$.pool'),'a2') AS pool,json_extract(json,'$.status') AS status,coalesce(json_extract(json,'$.coreDecision.action'),json_extract(json,'$.preferenceDecision.action'),json_extract(json,'$.archiveDecision.action')) AS action FROM entries WHERE rowid>?").all(before.entries),
    ...store.db.prepare("SELECT id,version,'b2' AS kind,'b2' AS pool,json_extract(json,'$.status') AS status,json_extract(json,'$.b2Decision.action') AS action FROM b2_notes WHERE rowid>?").all(before.b2)
  ];
  for (const row of rows) {
    const requestId = `entry-commit:${workflowHash({ id: row.id, version: row.version })}`;
    const action = row.action === 'revoke' || row.status === 'archived' ? 'revoked' : row.version === 1 ? 'added' : 'updated';
    const event = { requestId, type: 'entry_commit', transactionId, id: row.id, version: row.version, kind: row.kind, pool: row.pool, action, committedAt };
    store.db.prepare('INSERT INTO workflow_events(request_id,kind,json) VALUES (?,?,?)').run(requestId, 'entry_commit', JSON.stringify(event));
  }
  if (rows.length) store._queueProjection(`logs/daily/${store._local(committedAt).date}.json`);
}
function saveEvent(store, event, hash) {
  assertSafeMemoryPayload(event);
  store.db.prepare('INSERT INTO workflow_events(request_id,kind,json) VALUES (?,?,?)').run(event.requestId, event.type, JSON.stringify(event));
  for (const rawId of new Set((event.evidence ?? []).map(source => source.rawId))) store.db.prepare('INSERT INTO workflow_sources(request_id,raw_id) VALUES (?,?)').run(event.requestId, rawId);
  const result = { event, duplicate: false };
  store._policySaveDecision(event, hash, result); return result;
}
function project(store, result) {
  store._projectDecisions(); store._projectEntryIndex();
  for (const target of [...(result.event?.targets ?? []), ...(result.event?.entries ?? []), ...(result.event?.result ? [result.event.result] : [])]) { const entry = store.getEntry(target.id); if (entry) store._projectEntryCurrent(entry); }
  if (['validity', 'merge_revoke'].includes(result.event?.type)) for (const entry of store.listEntries({ includeRetired: true })) if (entry.kind !== 'b2') store._projectEntryCurrent(entry);
  return store._writeResult(result);
}
export function reviewValidity(store, input = {}) {
  const { requestId, targets, currentValidity, reason, check } = input;
  wfId(requestId); wfText(reason, 'reason');
  if (!['unknown', 'valid', 'invalid'].includes(currentValidity)) throw new TypeError('Invalid currentValidity');
  const hash = workflowHash({ type: 'validity', ...input });
  const result = store._transaction(() => {
    const replay = store._policyReplay(requestId, hash); if (replay) return replay;
    const normalized = exactReferences(store, targets);
    const decidedAt = store.now(); const checkedAt = wfTime(input.checkedAt ?? decidedAt, 'checkedAt');
    const reviewAfter = input.reviewAfter == null ? null : wfTime(input.reviewAfter, 'reviewAfter');
    if (checkedAt > decidedAt || reviewAfter && reviewAfter <= checkedAt) throw new TypeError('checkedAt cannot be future; reviewAfter must follow checkedAt');
    const evidence = quotedEvidence(store, input.sources, { required: currentValidity !== 'unknown' });
    let checkRecord = null;
    if (currentValidity !== 'unknown') {
      checkRecord = { method: wfText(check?.method, 'check.method'), result: wfText(check?.result, 'check.result'), actor: check?.actor == null ? 'memory_owner' : wfText(check.actor, 'check.actor', 200) };
      if (!evidence.some(source => source.independent !== false)) throw new Error('Derived recollections alone cannot confirm current validity');
    }
    return saveEvent(store, { requestId, type: 'validity', targets: normalized, currentValidity, reason, check: checkRecord, evidence, checkedAt, reviewAfter, decidedAt, semanticStatus: 'declared_check', autoVerified: false }, hash);
  });
  return project(store, result);
}
function dependencyValidity(store, entry) {
  const queue = [...(entry.dependencyEntries ?? []), ...(entry.sourceEntries ?? [])]; const visited = new Set([`${entry.id}:${entry.version}`]); const reasons = []; let truncated = false;
  for (let index = 0; index < queue.length; index++) {
    const ref = queue[index]; const key = `${ref.id}:${ref.version}`; if (visited.has(key)) continue;
    if (visited.size >= 1000) { truncated = true; break; } visited.add(key);
    const validity = store.db.prepare("SELECT json_extract(w.json,'$.currentValidity') AS currentValidity,json_extract(w.json,'$.checkedAt') AS checkedAt,json_extract(w.json,'$.reviewAfter') AS reviewAfter FROM workflow_events w WHERE kind='validity' AND EXISTS(SELECT 1 FROM json_each(w.json,'$.targets') t WHERE json_extract(t.value,'$.id')=? AND json_extract(t.value,'$.version')=?) ORDER BY json_extract(w.json,'$.checkedAt') DESC,seq DESC LIMIT 1").get(ref.id, ref.version);
    if (validity && (validity.currentValidity === 'invalid' || validity.reviewAfter && validity.reviewAfter <= store.now())) reasons.push({ id: ref.id, version: ref.version, reason: validity.currentValidity === 'invalid' ? 'source_currently_invalid' : 'source_review_due', ...validity });
    const revoked = store.db.prepare("SELECT 1 FROM workflow_events m JOIN workflow_events r ON r.kind='merge_revoke' AND json_extract(r.json,'$.mergeRequestId')=m.request_id WHERE m.kind='merge' AND json_extract(m.json,'$.result.id')=? AND json_extract(m.json,'$.result.version')=? LIMIT 1").get(ref.id, ref.version);
    if (revoked) reasons.push({ id: ref.id, version: ref.version, reason: 'source_merge_revoked' });
    const row = store.db.prepare("SELECT json_extract(json,'$.dependencyEntries') AS dependencies,json_extract(json,'$.sourceEntries') AS sources FROM entries WHERE id=? AND version=?").get(ref.id, ref.version);
    if (row) queue.push(...JSON.parse(row.dependencies ?? '[]'), ...JSON.parse(row.sources ?? '[]'));
  }
  return { dependencyReviewPending: reasons.length > 0 || truncated, dependencyReviewReasons: reasons.slice(0, 20), dependencyReviewCount: reasons.length, dependencyScanTruncated: truncated };
}
export function workflowState(store, entry) {
  // Filter in SQLite before decoding: unrelated checks may contain long source
  // quotes and must not be copied into JS for every search candidate.
  const rows = store.db.prepare(`SELECT seq,json FROM workflow_events w WHERE
    (kind IN ('validity','merge') AND EXISTS(SELECT 1 FROM json_each(w.json,'$.targets') t WHERE json_extract(t.value,'$.id')=@id AND json_extract(t.value,'$.version')=@version))
    OR (kind='merge' AND json_extract(w.json,'$.result.id')=@id AND json_extract(w.json,'$.result.version')=@version)
    OR (kind IN ('thread','thread_unlink') AND EXISTS(SELECT 1 FROM json_each(w.json,'$.entries') t WHERE json_extract(t.value,'$.id')=@id AND json_extract(t.value,'$.version')=@version))
    ORDER BY seq`).all({ id: entry.id, version: entry.version });
  const relevantMergeIds = rows.filter(row => JSON.parse(row.json).type === 'merge').map(row => JSON.parse(row.json).requestId);
  if (relevantMergeIds.length) rows.push(...store.db.prepare(`SELECT seq,json FROM workflow_events WHERE kind='merge_revoke' AND json_extract(json,'$.mergeRequestId') IN (${relevantMergeIds.map(() => '?').join(',')}) ORDER BY seq`).all(...relevantMergeIds));
  rows.sort((a, b) => a.seq - b.seq);
  let validity; const merges = new Map(); const revoked = new Set(); const allMerges = []; const threads = new Map((entry.threadLineage ?? []).map(thread => [thread.threadId, { ...thread, derived: true }]));
  const threadLinks = activeThreadLinks(rows.map(row => JSON.parse(row.json)));
  for (const link of threadLinks) if (link.recordType === 'entry' && link.id === entry.id && link.version === entry.version) threads.set(link.threadId, { threadId: link.threadId, title: link.title, requestId: link.requestId });
  for (const row of rows) {
    const event = JSON.parse(row.json);
    if (event.type === 'merge_revoke') { merges.delete(event.mergeRequestId); revoked.add(event.mergeRequestId); }
    if (event.type === 'merge') { merges.set(event.requestId, event); allMerges.push(event); }
    if (event.type === 'validity' && event.targets.some(target => target.id === entry.id && target.version === entry.version) && (!validity || event.checkedAt >= validity.checkedAt)) validity = event;
  }
  const merged = [...merges.values()].filter(event => event.targets.some(target => target.id === entry.id && target.version === entry.version));
  const outputMerge = allMerges.find(event => event.result.id === entry.id && event.result.version === entry.version);
  const reviewDue = Boolean(validity?.reviewAfter && validity.reviewAfter <= store.now());
  return { currentValidity: validity?.currentValidity ?? 'unknown', checkedAt: validity?.checkedAt ?? null, reviewAfter: validity?.reviewAfter ?? null, reviewDue, validityBasis: validity ? { requestId: validity.requestId, check: validity.check, semanticStatus: 'declared_check', autoVerified: false } : null, ...dependencyValidity(store, entry), ...(threads.size ? { threads: [...threads.values()] } : {}), ...(merged.length ? { mergedInto: merged.map(event => ({ ...event.result, requestId: event.requestId })) } : {}), ...(outputMerge ? { mergeState: revoked.has(outputMerge.requestId) ? 'revoked' : 'active', ...(revoked.has(outputMerge.requestId) ? { status: 'archived' } : {}) } : {}) };
}
export function linkThread(store, input = {}) {
  const { requestId, threadId, reason } = input; wfId(requestId); wfId(threadId); wfText(reason, 'reason');
  const hash = workflowHash({ type: 'thread', ...input });
  const result = store._transaction(() => {
    const replay = store._policyReplay(requestId, hash); if (replay) return replay;
    const previous = store.db.prepare("SELECT json FROM workflow_events WHERE kind='thread' AND json_extract(json,'$.threadId')=? ORDER BY seq DESC LIMIT 1").get(threadId);
    const title = wfText(input.title ?? (previous && JSON.parse(previous.json).title), 'thread title', 200);
    const entries = exactReferences(store, input.entries ?? [], { min: 0 }).map(ref => {
      const record = JSON.parse(store.db.prepare('SELECT json FROM entries WHERE id=? AND version=?').get(ref.id, ref.version).json);
      return { ...ref, recordedAt: record.recordedAt };
    });
    const rawIds = input.rawIds ?? [];
    if (!Array.isArray(rawIds) || rawIds.length > 50 || new Set(rawIds).size !== rawIds.length) throw new TypeError('rawIds requires at most 50 unique IDs');
    const raws = rawIds.map(rawId => {
      wfId(rawId);
      // Read the immutable payload directly. Derived read-view metadata must
      // never become part of an original's identity or preservation receipt.
      const row = store.db.prepare('SELECT json FROM raw WHERE id=? UNION ALL SELECT json FROM originals WHERE id=? LIMIT 1').get(rawId, rawId);
      if (!row) throw new Error(`Missing original: ${rawId}`);
      const raw = JSON.parse(row.json);
      if (raw.pool !== 'a') throw new TypeError('Thread originals must belong to A1');
      return { id: rawId, rawId, hash: workflowHash(row.json), sessionId: raw.sessionId ?? null, turnId: raw.turnId ?? null, role: raw.role, recordedAt: raw.recordedAt };
    });
    if (!entries.length && !raws.length || entries.length + raws.length > 50) throw new TypeError('Thread link requires 1..50 original or exact entry references');
    // Navigation is deliberately NOT added to evidence/workflow_sources:
    // those tables retain source text beyond A1's normal retention policy.
    return saveEvent(store, { requestId, type: 'thread', threadId, title, entries, raws, reason, decidedAt: store.now() }, hash);
  });
  return project(store, result);
}

function threadMemberKey(ref, type) { return type === 'raw' ? `raw:${ref.rawId ?? ref.id}` : `entry:${ref.id}:${ref.version}`; }
function activeThreadLinks(events) {
  const links = new Map();
  for (const event of events) {
    if (event.type === 'thread') {
      for (const [type, refs] of [['entry', event.entries ?? []], ['raw', event.raws ?? []]]) for (const ref of refs) {
        links.set(JSON.stringify([event.requestId, threadMemberKey(ref, type)]), { ...ref, recordType: type, threadId: event.threadId, title: event.title, linkedAt: event.decidedAt, requestId: event.requestId });
      }
    } else if (event.type === 'thread_unlink') {
      for (const [type, refs] of [['entry', event.entries ?? []], ['raw', event.raws ?? []]]) for (const ref of refs) links.delete(JSON.stringify([event.linkRequestId, threadMemberKey(ref, type)]));
    }
  }
  return [...links.values()];
}

export function unlinkThread(store, input = {}) {
  const { requestId, threadId, linkRequestId, reason } = input;
  wfId(requestId); wfId(threadId); wfId(linkRequestId); wfText(reason, 'reason');
  const hash = workflowHash({ type: 'thread_unlink', ...input });
  const result = store._transaction(() => {
    const replay = store._policyReplay(requestId, hash); if (replay) return replay;
    const row = store.db.prepare("SELECT json FROM workflow_events WHERE request_id=? AND kind='thread'").get(linkRequestId);
    const original = row && JSON.parse(row.json);
    if (!original || original.threadId !== threadId) throw new Error('Thread link event not found in this thread');
    const selectAll = input.entries === undefined && input.rawIds === undefined;
    const entrySelectors = selectAll ? original.entries ?? [] : input.entries ?? [];
    const rawSelectors = selectAll ? (original.raws ?? []).map(ref => ref.rawId) : input.rawIds ?? [];
    if (!Array.isArray(entrySelectors) || !Array.isArray(rawSelectors) || !entrySelectors.length && !rawSelectors.length || entrySelectors.length + rawSelectors.length > 50) throw new TypeError('Unlink requires 1..50 linked references');
    const seen = new Set();
    const entries = entrySelectors.map(ref => {
      wfId(ref?.id); if (!Number.isSafeInteger(ref.version) || ref.version < 1) throw new TypeError('Unlink requires exact entry versions');
      const key = threadMemberKey(ref, 'entry'); const found = (original.entries ?? []).find(item => item.id === ref.id && item.version === ref.version);
      if (!found || seen.has(key)) throw new Error('Reference is missing or duplicated in the original link'); seen.add(key); return found;
    });
    const raws = rawSelectors.map(rawId => {
      wfId(rawId); const key = `raw:${rawId}`; const found = (original.raws ?? []).find(item => item.rawId === rawId);
      if (!found || seen.has(key)) throw new Error('Original is missing or duplicated in the original link'); seen.add(key); return found;
    });
    const unlinks = store.db.prepare("SELECT json FROM workflow_events WHERE kind='thread_unlink' AND json_extract(json,'$.linkRequestId')=? ORDER BY seq").all(linkRequestId).map(item => JSON.parse(item.json));
    const active = new Set(activeThreadLinks([original, ...unlinks]).map(ref => threadMemberKey(ref, ref.recordType)));
    if ([...seen].some(key => !active.has(key))) throw new Error('Requested thread association is already unlinked');
    return saveEvent(store, { requestId, type: 'thread_unlink', threadId, linkRequestId, title: original.title, entries, raws, reason, decidedAt: store.now() }, hash);
  });
  return project(store, result);
}

export function rawThreadState(store, rawId) {
  const events = store.db.prepare("SELECT json FROM workflow_events w WHERE kind IN ('thread','thread_unlink') AND EXISTS(SELECT 1 FROM json_each(w.json,'$.raws') r WHERE json_extract(r.value,'$.rawId')=?) ORDER BY seq").all(rawId).map(row => JSON.parse(row.json));
  const grouped = new Map();
  for (const link of activeThreadLinks(events)) if (link.recordType === 'raw' && link.rawId === rawId) {
    const old = grouped.get(link.threadId);
    grouped.set(link.threadId, { threadId: link.threadId, title: link.title, requestId: link.requestId, linkedAt: link.linkedAt, association: 'direct', retention: 'weak', linkCount: (old?.linkCount ?? 0) + 1 });
  }
  const threads = [...grouped.values()];
  return threads.length ? { threads, threadIds: threads.map(thread => thread.threadId), threadCount: threads.length } : {};
}
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function decode(cursor, kind, instanceId) {
  let data; try { if (typeof cursor !== 'string' || cursor.length > 3000) throw new Error(); data = JSON.parse(Buffer.from(cursor, 'base64url').toString()); } catch { throw new TypeError('Invalid cursor'); }
  if (data.kind !== kind || data.instanceId !== instanceId) throw new TypeError('Cursor scope mismatch');
  return data;
}
export function readThread(store, { threadId, include, limit = 20, budget = 8000, cursor } = {}) {
  wfId(threadId); if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Invalid pagination');
  if (!Number.isSafeInteger(budget) || budget < 800 || budget > 48000) throw new TypeError('Thread budget must be 800..48000 characters');
  const state = cursor ? decode(cursor, 'thread', store.instanceId) : { kind: 'thread', instanceId: store.instanceId, threadId, include: include ?? 'both', maxSeq: store.db.prepare('SELECT coalesce(max(seq),0) AS n FROM workflow_events').get().n, offset: 0 };
  const legacyCursor = Boolean(cursor && state.include === undefined);
  state.include ??= 'entries'; // Accept already-issued 0.6.0 entry-only cursors.
  if (state.threadId !== threadId || !Number.isSafeInteger(state.offset) || state.offset < 0 || !Number.isSafeInteger(state.maxSeq) || state.maxSeq < 0) throw new TypeError('Invalid thread cursor');
  if (!['entries', 'raw', 'both'].includes(state.include) || include !== undefined && include !== state.include) throw new TypeError('Thread cursor include mismatch');
  const events = store.db.prepare("SELECT json FROM workflow_events WHERE kind IN ('thread','thread_unlink') AND json_extract(json,'$.threadId')=? AND seq<=? ORDER BY seq").all(threadId, state.maxSeq).map(row => JSON.parse(row.json));
  const grouped = new Map();
  for (const link of activeThreadLinks(events)) {
    if (state.include === 'entries' && link.recordType !== 'entry' || state.include === 'raw' && link.recordType !== 'raw') continue;
    const key = threadMemberKey(link, link.recordType); const old = grouped.get(key);
    if (old) { old.linkCount++; continue; }
    const { threadId: _threadId, title: _title, ...item } = link;
    grouped.set(key, { ...item, linkCount: 1 });
  }
  const all = [...grouped.values()];
  if (!legacyCursor) all.sort((a, b) => String(a.recordedAt ?? a.linkedAt).localeCompare(String(b.recordedAt ?? b.linkedAt)) || String(a.id).localeCompare(String(b.id)) || (a.version ?? 0) - (b.version ?? 0));
  const items = all.slice(state.offset, state.offset + limit).map(item => {
    if (item.recordType !== 'raw') {
      const exists = store.db.prepare('SELECT 1 FROM entries WHERE id=? AND version=?').get(item.id, item.version);
      return { ...item, availability: exists ? 'available' : 'pruned_or_missing', read: exists ? { tool: 'memory_read', arguments: { id: item.id, version: item.version } } : null };
    }
    const row = store.db.prepare('SELECT json FROM raw WHERE id=? UNION ALL SELECT json FROM originals WHERE id=? LIMIT 1').get(item.rawId, item.rawId);
    const tombstone = !row && store.db.prepare('SELECT 1 FROM deletion_tombstones WHERE raw_id=?').get(item.rawId);
    const availability = row ? workflowHash(row.json) === item.hash ? 'available' : 'hash_mismatch' : tombstone ? 'cleared' : 'missing';
    return { ...item, kind: 'raw', pool: 'a1', retention: 'weak', availability, read: availability === 'available' ? { tool: 'memory_read', arguments: { id: item.rawId, kind: 'raw' } } : null };
  });
  const response = () => {
    const hasMore = state.offset + items.length < all.length;
    const nextState = { ...state, offset: state.offset + items.length };
    if (legacyCursor) delete nextState.include; // Keep the old insertion ordering on every continuation.
    return { threadId, title: [...events].reverse().find(event => event.type === 'thread')?.title ?? null, include: state.include, total: all.length, items, hasMore, nextCursor: hasMore ? encode(nextState) : null };
  };
  // Public tools convert known instants and add timeZone. Reserve those exact
  // bytes here while keeping the storage/API return values in UTC.
  const outputLength = value => JSON.stringify(presentMemoryTimes(value, store.timezone)).length;
  while (items.length > 1 && outputLength(response()) > budget) items.pop();
  const result = response();
  if (outputLength(result) > budget) throw new RangeError(`Thread budget is too small; retry with budget >= ${outputLength(result)}`);
  return result;
}
export function mergeEntries(store, input = {}) {
  wfId(input.requestId); wfText(input.reason, 'reason'); const hash = workflowHash({ type: 'merge', ...input }); let created;
  const result = store._transaction(() => {
    const replay = store._policyReplay(input.requestId, hash); if (replay) return replay;
    const targets = exactReferences(store, input.targets, { min: 2, current: true });
    const parents = targets.map(target => store.getEntry(target.id, { version: target.version }));
    if (parents.some(entry => entry.pool !== 'a2' || !['memory', 'doing'].includes(entry.kind) || entry.retired || entry.status === 'archived' || entry.kind !== parents[0].kind || entry.mergedInto?.length)) throw new Error('Merge requires unmerged current A2 memory/doing entries of the same kind');
    if (input.entry?.kind !== parents[0].kind) throw new Error('Merge output must preserve entry kind');
    created = store._prepareEntry(input.entry);
    if (store.getEntry(created.id) || targets.some(target => target.id === created.id)) throw new Error('Merge output requires a new entry id');
    const sourceKeys = new Set(created.sources.map(source => `${source.rawId}\0${source.quote}`));
    if (parents.some(parent => parent.sources.some(source => !sourceKeys.has(`${source.rawId}\0${source.quote}`)))) throw new Error('Merge must retain every original source quote');
    const threadLineage = new Map();
    for (const parent of parents) for (const thread of parent.threads ?? []) {
      if (!threadLineage.has(thread.threadId)) threadLineage.set(thread.threadId, { threadId: thread.threadId, title: thread.title, sourceEntries: [] });
      threadLineage.get(thread.threadId).sourceEntries.push({ id: parent.id, version: parent.version });
    }
    created = { ...created, lineage: { operation: 'merge', requestId: input.requestId, parents: targets }, dependencyEntries: targets, ...(threadLineage.size ? { threadLineage: [...threadLineage.values()] } : {}) };
    store._commitPolicyEntry(created, { expectedVersion: 0, requireNew: true });
    return saveEvent(store, { requestId: input.requestId, type: 'merge', reason: input.reason, targets, result: { id: created.id, version: created.version }, decidedAt: store.now() }, hash);
  });
  if (created) store._projectEntry(created); return project(store, result);
}
export function revokeMerge(store, input = {}) {
  wfId(input.requestId); wfId(input.mergeRequestId); wfText(input.reason, 'reason'); const hash = workflowHash({ type: 'merge_revoke', ...input });
  const result = store._transaction(() => {
    const replay = store._policyReplay(input.requestId, hash); if (replay) return replay;
    const row = store.db.prepare("SELECT json FROM workflow_events WHERE request_id=? AND kind='merge'").get(input.mergeRequestId);
    if (!row) throw new Error('Merge event not found');
    if (store.db.prepare("SELECT 1 FROM workflow_events WHERE kind='merge_revoke' AND json_extract(json,'$.mergeRequestId')=?").get(input.mergeRequestId)) throw new Error('Merge already revoked');
    const merge = JSON.parse(row.json);
    return saveEvent(store, { requestId: input.requestId, type: 'merge_revoke', mergeRequestId: input.mergeRequestId, reason: input.reason, targets: merge.targets, result: merge.result, decidedAt: store.now() }, hash);
  });
  return project(store, result);
}

export function reviewQueue(store, { limit = 4, offset = 0, cursor } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || cursor && offset) throw new TypeError('Invalid pagination');
  const state = cursor ? decode(cursor, 'a1-review', store.instanceId) : { kind: 'a1-review', instanceId: store.instanceId, asOf: store.now(), maxReceipt: store.db.prepare('SELECT coalesce(max(rowid),0) AS n FROM receipts').get().n, maxEarly: store.db.prepare('SELECT coalesce(max(rowid),0) AS n FROM early_reviews').get().n, after: null };
  wfTime(state.asOf); if (![state.maxReceipt, state.maxEarly].every(value => Number.isSafeInteger(value) && value >= 0)) throw new TypeError('Invalid cursor');
  const cutoff = new Date(Date.parse(state.asOf) - AGE).toISOString();
  const sql = `WITH candidates AS (SELECT r.id AS rawId,json_extract(r.json,'$.role') AS role,json_extract(r.json,'$.sessionId') AS sessionId,json_extract(r.json,'$.turnId') AS turnId,json_extract(r.json,'$.recordedAt') AS recordedAt,length(json_extract(r.json,'$.text')) AS textLength,EXISTS(SELECT 1 FROM early_reviews e WHERE e.raw_id=r.id AND e.rowid<=@maxEarly) AS earlyRequested FROM (SELECT id,json FROM raw UNION ALL SELECT id,json FROM originals WHERE NOT EXISTS(SELECT 1 FROM raw WHERE raw.id=originals.id)) r JOIN receipts p ON p.id=r.id WHERE p.rowid<=@maxReceipt AND NOT EXISTS(SELECT 1 FROM self_review_completed s WHERE s.raw_id=r.id)) SELECT * FROM candidates WHERE (recordedAt<=@cutoff OR earlyRequested=1)`;
  const params = { maxEarly: state.maxEarly, maxReceipt: state.maxReceipt, cutoff };
  const total = store.db.prepare(`SELECT count(*) AS n FROM (${sql})`).get(params).n;
  let afterSQL = '';
  if (state.after) {
    const [early, recorded, id] = state.after;
    if (![0, 1].includes(early)) throw new TypeError('Invalid cursor'); wfTime(recorded); wfId(id);
    Object.assign(params, { early, recorded, id });
    afterSQL = ' AND (earlyRequested<@early OR earlyRequested=@early AND (recordedAt>@recorded OR recordedAt=@recorded AND rawId>@id))';
  }
  const rows = store.db.prepare(`${sql}${afterSQL} ORDER BY earlyRequested DESC,recordedAt,rawId LIMIT @limit OFFSET @offset`).all({ ...params, limit: limit + 1, offset });
  const hasMore = rows.length > limit; const items = rows.slice(0, limit).map(row => ({ ...row, earlyRequested: Boolean(row.earlyRequested), dueAt: new Date(Date.parse(row.recordedAt) + AGE).toISOString(), read: { tool: 'memory_read', arguments: { id: row.rawId } } }));
  const last = items.at(-1);
  return { total, items, asOf: state.asOf, hasMore, nextOffset: hasMore ? offset + items.length : null, nextCursor: hasMore ? encode({ ...state, after: [Number(last.earlyRequested), last.recordedAt, last.rawId] }) : null, snapshot: true, lateArrivals: 'Start a fresh queue pass to include arrivals after this snapshot.' };
}
export function reviewProgress(store) {
  const asOf = store.now(); const queue = reviewQueue(store, { limit: 1 });
  const oldest = store.db.prepare("SELECT p.id,json_extract(p.json,'$.recordedAt') AS recordedAt FROM receipts p WHERE p.pool='a' AND NOT EXISTS(SELECT 1 FROM self_review_completed c WHERE c.raw_id=p.id) ORDER BY recordedAt,p.id LIMIT 1").get();
  const reviewed = store.db.prepare('SELECT count(*) AS n FROM self_review_completed').get().n;
  const latest = store.db.prepare("SELECT json FROM memory_decisions WHERE kind='self_review' ORDER BY seq DESC LIMIT 1").get();
  return { asOf, reviewed, pendingDue: queue.total, oldestUnreviewed: oldest ?? null, coveredBefore: oldest?.recordedAt && oldest.recordedAt < asOf ? oldest.recordedAt : asOf, coverageMeaning: 'Every known A1 receipt strictly before coveredBefore was reviewed; late imports can reopen this boundary.', lastCommittedReviewAt: latest ? JSON.parse(latest.json).reviewedAt : null, queue: { tool: 'memory_review_queue', arguments: {} } };
}
export function reviewDailyReport(store, { date = store._local(store.now()).date, limit = 20, cursor } = {}) {
  if (typeof date !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new TypeError('Invalid date');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Invalid report limit');
  const state = cursor ? decode(cursor, 'daily-report', store.instanceId) : { kind: 'daily-report', instanceId: store.instanceId, date, maxDecision: store.db.prepare('SELECT coalesce(max(seq),0) AS n FROM memory_decisions').get().n, maxWorkflow: store.db.prepare('SELECT coalesce(max(seq),0) AS n FROM workflow_events').get().n, offset: 0 };
  if (state.date !== date || ![state.maxDecision, state.maxWorkflow, state.offset].every(value => Number.isSafeInteger(value) && value >= 0)) throw new TypeError('Invalid report cursor');
  const rows = store.db.prepare('SELECT seq,kind,json,result_json FROM memory_decisions WHERE seq<=? ORDER BY seq').all(state.maxDecision);
  const decisions = rows.map(row => ({ row, value: JSON.parse(row.json), result: JSON.parse(row.result_json) })).filter(({ value }) => { const time = value.committedAt ?? value.decidedAt ?? value.reviewedAt ?? value.requestedAt ?? value.purgedAt; return time && store._local(time).date === date; }).map(({ row, value, result }) => ({ seq: row.seq, requestId: value.requestId, transactionId: value.transactionId ?? `historical:${value.requestId}`, type: row.kind, committedAt: value.committedAt ?? value.decidedAt ?? value.reviewedAt ?? value.requestedAt ?? value.purgedAt, ...(result.completed == null ? {} : { completed: result.completed }), ...(result.id ? { id: result.id, version: result.version } : {}), ...(row.kind === 'correction' ? { targets: value.targets } : {}) }));
  const commits = store.db.prepare("SELECT json FROM workflow_events WHERE kind='entry_commit' AND seq<=? ORDER BY seq").all(state.maxWorkflow).map(row => JSON.parse(row.json)).filter(event => store._local(event.committedAt).date === date);
  const transactions = new Map();
  for (const item of [...decisions, ...commits]) {
    if (!transactions.has(item.transactionId)) transactions.set(item.transactionId, { transactionId: item.transactionId, committedAt: item.committedAt, decisions: [], entries: [] });
    const group = transactions.get(item.transactionId); (item.type === 'entry_commit' ? group.entries : group.decisions).push(item.type === 'entry_commit' ? { id: item.id, version: item.version, kind: item.kind, pool: item.pool, action: item.action } : item);
  }
  const all = [...transactions.values()].sort((a, b) => a.committedAt.localeCompare(b.committedAt) || a.transactionId.localeCompare(b.transactionId));
  const items = all.slice(state.offset, state.offset + limit); const hasMore = state.offset + items.length < all.length;
  const byType = {}; for (const item of decisions) byType[item.type] = (byType[item.type] ?? 0) + 1;
  const counts = { added: 0, updated: 0, corrected: 0, revoked: 0 }; for (const commit of commits) counts[commit.action]++;
  for (const item of decisions.filter(item => item.type === 'correction')) counts.corrected += item.targets?.length ?? 0;
  counts.revoked += decisions.filter(item => item.type === 'merge_revoke').length;
  return { date, timezone: store.timezone, historyCoverageStartsAt: store.db.prepare('SELECT value FROM meta WHERE key=?').get('workflow_history_started_at')?.value ?? null, historicalEntryCoverage: 'Entry/B2 version counts begin at historyCoverageStartsAt; older missing commit times are unknown.', successfulCommits: all.length, ...counts, reviewedRaw: decisions.reduce((sum, item) => sum + (item.completed ?? 0), 0), byType, items, hasMore, nextCursor: hasMore ? encode({ ...state, offset: state.offset + items.length }) : null, source: 'committed transactions and unique entry versions; failed calls and replays are not new successes' };
}

export function writeDailyReport(store, input = {}) {
  const report = reviewDailyReport(store, { ...input, cursor: undefined, limit: 100 });
  // The durable summary is intentionally bounded; full transaction details are paged via the report tool.
  const relative = `logs/daily/${report.date}.json`;
  store.writeProjection(relative, JSON.stringify(report, null, 2) + '\n');
  return { date: report.date, path: relative, successfulCommits: report.successfulCommits, projectionPending: store.projectionStatus().projectionPending };
}
