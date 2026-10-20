const TTL = 168 * 60 * 60 * 1000;
const MAX_PARTS = 4096;

function id(value, name) {
  if (typeof value !== 'string' || value.length > 200 || !/^[\p{L}\p{N}][\p{L}\p{N}._:@-]*$/u.test(value)) throw new TypeError(`Invalid ${name}`);
  return value;
}
function integer(value, name, min, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`Invalid ${name}`);
  return value;
}
function instant(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) throw new TypeError(`Invalid ${name}`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== value.slice(0, 10)
    || +value.slice(11, 13) > 23 || +value.slice(14, 16) > 59 || +value.slice(17, 19) > 59) throw new TypeError(`Invalid ${name}`);
  return parsed.toISOString();
}
function parse(row) { return row ? JSON.parse(row.json) : null; }
function roundRow(store, sessionId, turnId) { return store.db.prepare('SELECT json FROM completed_rounds WHERE session_id=? AND turn_id=?').get(sessionId, turnId); }
function source(record) {
  return { sessionId: record.sessionId, turnId: record.turnId, startedAt: record.startedAt, completedAt: record.completedAt, omittedNonText: record.omittedNonText, totalBlocks: record.totalBlocks };
}
function selectionView(record, duplicate = false) { return { ...record, duplicate }; }

// Called inside the same schema transaction as the identity version upgrade.
// These tables deliberately contain only receipts and references, never text.
export function initializePreinject(store) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS completed_rounds (session_id TEXT NOT NULL,turn_id TEXT NOT NULL,completed_at TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(session_id,turn_id));
    CREATE INDEX IF NOT EXISTS completed_rounds_latest ON completed_rounds(completed_at DESC,session_id,turn_id);
    CREATE TABLE IF NOT EXISTS completed_round_parts (session_id TEXT NOT NULL,turn_id TEXT NOT NULL,ordinal INTEGER NOT NULL,raw_id TEXT NOT NULL,capture_id TEXT NOT NULL,role TEXT NOT NULL,recorded_at TEXT NOT NULL,source_root TEXT NOT NULL,raw_hash TEXT NOT NULL,code_points INTEGER NOT NULL,PRIMARY KEY(session_id,turn_id,ordinal),UNIQUE(session_id,turn_id,raw_id),FOREIGN KEY(session_id,turn_id) REFERENCES completed_rounds(session_id,turn_id));
    CREATE TABLE IF NOT EXISTS preinject_choices (target_session_id TEXT PRIMARY KEY,first_turn_id TEXT NOT NULL,json TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS immutable_round_update BEFORE UPDATE ON completed_rounds BEGIN SELECT RAISE(ABORT,'completed rounds are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_round_delete BEFORE DELETE ON completed_rounds BEGIN SELECT RAISE(ABORT,'completed rounds are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_round_parts_update BEFORE UPDATE ON completed_round_parts BEGIN SELECT RAISE(ABORT,'completed round references are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_round_parts_delete BEFORE DELETE ON completed_round_parts BEGIN SELECT RAISE(ABORT,'completed round references are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_preinject_update BEFORE UPDATE ON preinject_choices BEGIN SELECT RAISE(ABORT,'first turn selection is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_preinject_delete BEFORE DELETE ON preinject_choices BEGIN SELECT RAISE(ABORT,'first turn selection is immutable'); END;
  `);
}

export function recordCompletedRound(store, input = {}) {
  store._assertOpen();
  const sessionId = id(input.sessionId, 'sessionId'), turnId = id(input.turnId, 'turnId');
  const startedAt = instant(input.startedAt, 'startedAt'), completedAt = instant(input.completedAt, 'completedAt');
  const startSeq = integer(input.startSeq, 'startSeq', 0), endSeq = integer(input.endSeq, 'endSeq', 1);
  if (startSeq >= endSeq || startedAt > completedAt || input.reason !== 'completed' || !['live', 'verified_history'].includes(input.proof)) throw new TypeError('Round requires a normal completed interval and explicit proof');
  const omittedNonText = input.omittedNonText ?? false;
  if (typeof omittedNonText !== 'boolean') throw new TypeError('Invalid omittedNonText');
  if (!Array.isArray(input.captures) || input.captures.length < 2 || input.captures.length > MAX_PARTS) throw new TypeError('Round requires 2..4096 ordered captures');
  let previous = startSeq; const captureIds = new Set();
  const captures = input.captures.map(capture => {
    const captureId = id(capture?.id, 'capture id'); const seq = integer(capture?.seq, 'capture seq', 0);
    if (!['user', 'assistant'].includes(capture?.role) || seq <= previous || seq >= endSeq || captureIds.has(captureId)) throw new TypeError('Captures must have unique IDs, allowed roles and strictly ordered in-round sequence numbers');
    previous = seq; captureIds.add(captureId);
    return { id: captureId, role: capture.role, seq };
  });
  const identity = { sessionId, turnId, startedAt, completedAt, startSeq, endSeq, reason: 'completed', captures, omittedNonText };
  return store._transaction(() => {
    const old = parse(roundRow(store, sessionId, turnId));
    if (old) {
      const { proof, totalBlocks, indexedAt, ...oldIdentity } = old;
      if (JSON.stringify(oldIdentity) !== JSON.stringify(identity)) throw new Error('Completed round already exists with different metadata');
      return { ...source(old), proof: old.proof, duplicate: true };
    }
    const parts = []; const seenParts = new Set(); const nonempty = { user: false, assistant: false };
    const metadata = store.db.prepare("SELECT json_extract(r.json,'$.sessionId') AS sessionId,json_extract(r.json,'$.turnId') AS turnId,json_extract(r.json,'$.role') AS role,json_extract(r.json,'$.pool') AS pool,json_extract(r.json,'$.recordedAt') AS recordedAt,json_extract(r.json,'$.sourceRoot') AS sourceRoot,length(json_extract(r.json,'$.text')) AS codePoints,p.hash FROM raw r JOIN receipts p ON p.id=r.id AND p.pool='a' WHERE r.id=?");
    for (const capture of captures) {
      const receipt = store.db.prepare('SELECT pool,role,json FROM captures WHERE id=?').get(capture.id);
      if (!receipt || receipt.pool !== 'a' || receipt.role !== capture.role) throw new Error('Round requires committed A capture receipts');
      const partIds = JSON.parse(receipt.json).partIds;
      if (!Array.isArray(partIds) || partIds.length + parts.length > MAX_PARTS) throw new Error('Round exceeds the 4096 original-block limit');
      for (const rawId of partIds) {
        if (seenParts.has(rawId)) throw new Error('Repeated original block in completed round');
        const raw = metadata.get(rawId);
        if (!raw || raw.sessionId !== sessionId || raw.turnId !== turnId || raw.role !== capture.role || raw.pool !== 'a' || raw.sourceRoot !== capture.id
          || raw.recordedAt < startedAt || raw.recordedAt > completedAt || !Number.isSafeInteger(raw.codePoints)) throw new Error('Completed round original is missing or mismatched');
        seenParts.add(rawId); nonempty[raw.role] ||= raw.codePoints > 0;
        parts.push({ rawId, captureId: capture.id, role: raw.role, recordedAt: raw.recordedAt, sourceRoot: raw.sourceRoot, rawHash: raw.hash, codePoints: raw.codePoints });
      }
    }
    if (!nonempty.user || !nonempty.assistant) throw new Error('Completed round requires both human and assistant text');
    const record = { ...identity, proof: input.proof, totalBlocks: parts.length, indexedAt: store.now() };
    store.db.prepare('INSERT INTO completed_rounds(session_id,turn_id,completed_at,json) VALUES (?,?,?,?)').run(sessionId, turnId, completedAt, JSON.stringify(record));
    const insert = store.db.prepare('INSERT INTO completed_round_parts(session_id,turn_id,ordinal,raw_id,capture_id,role,recorded_at,source_root,raw_hash,code_points) VALUES (?,?,?,?,?,?,?,?,?,?)');
    parts.forEach((part, ordinal) => insert.run(sessionId, turnId, ordinal, part.rawId, part.captureId, part.role, part.recordedAt, part.sourceRoot, part.rawHash, part.codePoints));
    return { ...source(record), proof: record.proof, duplicate: false };
  });
}

export function listPreinjectCandidates(store, { excludeSessionId, asOf = store.now(), limit = 32 } = {}) {
  store._assertOpen();
  if (excludeSessionId !== undefined) id(excludeSessionId, 'excludeSessionId');
  integer(limit, 'limit', 1, 128); asOf = instant(asOf, 'asOf');
  const cutoff = new Date(Date.parse(asOf) - TTL).toISOString();
  const groups = store.db.prepare("SELECT json_extract(json,'$.sessionId') AS sessionId,json_extract(json,'$.turnId') AS turnId,min(json_extract(json,'$.recordedAt')) AS earliestRecordedAt,max(json_extract(json,'$.recordedAt')) AS latestRecordedAt,count(*) AS totalBlocks FROM raw WHERE json_extract(json,'$.role') IN ('user','assistant') AND json_extract(json,'$.recordedAt')>? AND json_extract(json,'$.recordedAt')<=? AND json_extract(json,'$.turnId') IS NOT NULL AND (? IS NULL OR json_extract(json,'$.sessionId')<>?) GROUP BY sessionId,turnId ORDER BY latestRecordedAt DESC,sessionId,turnId LIMIT ?").all(cutoff, asOf, excludeSessionId ?? null, excludeSessionId ?? null, limit + 1);
  const items = groups.slice(0, limit).map(group => {
    const rows = store.db.prepare("SELECT id,json_extract(json,'$.sourceRoot') AS captureId FROM raw WHERE json_extract(json,'$.sessionId')=? AND json_extract(json,'$.turnId')=? AND json_extract(json,'$.role') IN ('user','assistant') AND json_extract(json,'$.recordedAt')>? AND json_extract(json,'$.recordedAt')<=? ORDER BY json_extract(json,'$.recordedAt'),rowid LIMIT ?").all(group.sessionId, group.turnId, cutoff, asOf, MAX_PARTS + 1);
    const bounded = rows.slice(0, MAX_PARTS);
    const captureIds = [...new Set(bounded.map(row => row.captureId))].filter(captureId => store.db.prepare("SELECT 1 FROM captures WHERE id=? AND pool='a'").get(captureId));
    return { ...group, rawIds: bounded.map(row => row.id), captureIds, metadataTruncated: rows.length > MAX_PARTS };
  });
  return { asOf, items, hasMore: groups.length > limit };
}

function available(store, record, asOf) {
  const cutoff = new Date(Date.parse(asOf) - TTL).toISOString();
  const row = store.db.prepare("SELECT count(*) AS total,sum(CASE WHEN r.id IS NOT NULL AND p.pool='a' AND p.hash=b.raw_hash AND json_extract(r.json,'$.sessionId')=b.session_id AND json_extract(r.json,'$.turnId')=b.turn_id AND json_extract(r.json,'$.role')=b.role AND json_extract(r.json,'$.recordedAt')=b.recorded_at AND json_extract(r.json,'$.sourceRoot')=b.source_root AND b.recorded_at>? AND b.recorded_at<=? THEN 0 ELSE 1 END) AS invalid FROM completed_round_parts b LEFT JOIN raw r ON r.id=b.raw_id LEFT JOIN receipts p ON p.id=b.raw_id WHERE b.session_id=? AND b.turn_id=?").get(cutoff, asOf, record.sessionId, record.turnId);
  return row.total === record.totalBlocks && row.total > 0 && row.invalid === 0;
}

export function selectPreinject(store, { targetSessionId, firstTurnId, asOf = store.now() } = {}) {
  store._assertOpen(); id(targetSessionId, 'targetSessionId'); id(firstTurnId, 'firstTurnId'); asOf = instant(asOf, 'asOf');
  return store._transaction(() => {
    const old = parse(store.db.prepare('SELECT json FROM preinject_choices WHERE target_session_id=?').get(targetSessionId));
    if (old) return selectionView(old, true);
    // Iterate bounded-size metadata rows rather than collecting full round/raw
    // bodies. SQL's index gives deterministic latest-completed ordering.
    let chosen = null;
    const cutoff = new Date(Date.parse(asOf) - TTL).toISOString();
    for (const row of store.db.prepare('SELECT json FROM completed_rounds WHERE completed_at>? AND completed_at<=? AND session_id<>? ORDER BY completed_at DESC,session_id,turn_id').iterate(cutoff, asOf, targetSessionId)) {
      const round = parse(row);
      if (available(store, round, asOf)) { chosen = source(round); break; }
    }
    const record = { targetSessionId, firstTurnId, selectedAt: store.now(), asOf, status: chosen ? 'selected' : 'none', source: chosen };
    store.db.prepare('INSERT INTO preinject_choices(target_session_id,first_turn_id,json) VALUES (?,?,?)').run(targetSessionId, firstTurnId, JSON.stringify(record));
    return selectionView(record);
  });
}

function quotas(blocks, budget) {
  const totals = Object.fromEntries(['user', 'assistant'].map(role => [role, blocks.filter(block => block.role === role).reduce((n, block) => n + block.originalCodePoints, 0)]));
  const allocations = { user: Math.min(totals.user, Math.ceil(budget / 2)), assistant: Math.min(totals.assistant, Math.floor(budget / 2)) };
  let remaining = budget - allocations.user - allocations.assistant;
  for (const role of ['user', 'assistant']) { const extra = Math.min(remaining, totals[role] - allocations[role]); allocations[role] += extra; remaining -= extra; }
  const result = new Map();
  for (const role of ['user', 'assistant']) {
    const group = blocks.filter(block => block.role === role && block.originalCodePoints > 0);
    let left = allocations[role];
    // Even the minimum two-codepoint budget must retain the first human text
    // and the last assistant text, rather than spending the reply on an earlier
    // intermediate assistant block.
    const anchor = role === 'user' ? group[0] : group.at(-1);
    if (anchor && left) { result.set(anchor.ordinal, 1); left--; }
    group.forEach((block, index) => {
      const initial = result.get(block.ordinal) ?? 0;
      const count = Math.min(block.originalCodePoints - initial, Math.ceil(left / (group.length - index)));
      result.set(block.ordinal, initial + count); left -= count;
    });
  }
  return result;
}

export function readPreinject(store, { targetSessionId, turnId, maxCodePoints = 8000, maxBlocks = 32 } = {}) {
  store._assertOpen(); id(targetSessionId, 'targetSessionId'); id(turnId, 'turnId');
  integer(maxCodePoints, 'maxCodePoints', 2, 32000); integer(maxBlocks, 'maxBlocks', 2, 256);
  return store._transaction(() => {
    const choice = parse(store.db.prepare('SELECT json FROM preinject_choices WHERE target_session_id=? AND first_turn_id=?').get(targetSessionId, turnId));
    if (!choice) return null;
    const snapshot = { status: choice.source ? 'ready' : 'none', targetSessionId, firstTurnId: choice.firstTurnId, selectedAt: choice.selectedAt, source: choice.source, blocks: [], omittedBlocks: choice.source?.totalBlocks ?? 0 };
    if (!choice.source) return snapshot;
    if (!available(store, choice.source, store.now())) return { ...snapshot, status: 'unavailable', reason: 'source_missing_expired_or_mismatched' };
    const all = store.db.prepare('SELECT raw_id AS id,role,recorded_at AS recordedAt,source_root AS sourceRoot,ordinal,code_points AS originalCodePoints FROM completed_round_parts WHERE session_id=? AND turn_id=? ORDER BY ordinal').all(choice.source.sessionId, choice.source.turnId);
    const firstUser = all.find(block => block.role === 'user' && block.originalCodePoints > 0);
    const lastAssistant = all.findLast(block => block.role === 'assistant' && block.originalCodePoints > 0);
    const selected = new Map([firstUser, lastAssistant].map(block => [block.ordinal, block]));
    for (const block of all) { if (selected.size >= maxBlocks) break; selected.set(block.ordinal, block); }
    const blocks = [...selected.values()].sort((a, b) => a.ordinal - b.ordinal);
    const limits = quotas(blocks, maxCodePoints);
    const prefix = store.db.prepare("SELECT substr(json_extract(json,'$.text'),1,?) AS text FROM raw WHERE id=?");
    snapshot.blocks = blocks.map(block => {
      const count = limits.get(block.ordinal) ?? 0;
      return { ...block, text: prefix.get(count, block.id).text, textTruncated: block.originalCodePoints > count };
    });
    snapshot.omittedBlocks = all.length - blocks.length;
    return snapshot;
  });
}
