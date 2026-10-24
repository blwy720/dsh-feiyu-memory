import { createHash, randomUUID } from 'node:crypto';
import { presentMemoryTimes } from './time-display.js';

const BODY_FIELDS = ['text', 'role', 'recordedAt', 'occurredAt', 'sessionId', 'turnId', 'statementType', 'sourceNature', 'evidenceStatus', 'currentValidity', 'reviewDue', 'checkedAt', 'reviewAfter', 'status', 'subject', 'target', 'from', 'to', 'rel', 'validationStatus', 'nonIndependentEvidence', 'redaction', 'threadIds', 'mergedInto', 'mergeState', 'dependencyReviewPending', 'dependencyReviewReasons'];
const SAFE_FIELDS = new Set(['id', 'kind', 'pool', 'version', ...BODY_FIELDS, 'hooks', 'tags', 'aliases', 'entities', 'project', 'topic', 'stance', 'expressionKind', 'sources', 'sourceCount', 'checks', 'evidence', 'evidencePage', 'sourceEntries', 'sourceEntriesPage', 'coverage', 'correctness', 'currentStateEvents', 'externalSources', 'externalSourcesPage', 'purpose', 'conditions', 'method', 'validation', 'environment', 'reviewAfter', 'checkedAt', 'threads', 'mergedInto', 'redaction', 'derivedFromMemory', 'validityBasis']);
const normalize = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase('und');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = value => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('参数必须是对象'); return value; };
function keys(value, allowed) { for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`不支持参数 ${key}`); }
function integer(value, fallback, min, max, name) { value ??= fallback; if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`${name} 必须为 ${min}..${max} 整数`); return value; }
function text(value, name, max = 2000) { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new TypeError(`${name} 必须是 1..${max} 字符`); return value; }
function clip(value, max = 180) { value = String(value ?? ''); return value.length <= max ? value : value.slice(0, max - 1) + '…'; }

export function validateReadView(args) {
  if (args.view !== undefined && !['body', 'evidence', 'history', 'full'].includes(args.view)) throw new TypeError('view 必须是 body、evidence、history 或 full');
  if (args.fields !== undefined && (!Array.isArray(args.fields) || !args.fields.length || args.fields.length > 30 || args.fields.some(field => !SAFE_FIELDS.has(field)))) throw new TypeError('fields 含不支持的字段，最多30个；使用 view:evidence 或 history 展开详情');
}

export function projectRead(result, args, store) {
  validateReadView(args);
  if (!result || (args.view === undefined && args.fields === undefined) || (args.view === 'full' && args.fields === undefined)) return result;
  const view = args.view ?? 'body';
  const fields = args.fields ?? (view === 'body' ? BODY_FIELDS : view === 'evidence'
    ? ['text', 'statementType', 'sourceNature', 'evidenceStatus', 'currentValidity', 'sources', 'sourceCount', 'evidence', 'evidencePage', 'checks', 'externalSources', 'externalSourcesPage', 'sourceEntries', 'sourceEntriesPage', 'coverage']
    : ['recordedAt', 'status', 'currentValidity', 'correctness', 'currentStateEvents', 'checkedAt', 'reviewAfter', 'reviewDue', 'validityBasis', 'mergedInto', 'threads']);
  const value = Object.fromEntries(['id', 'kind', 'pool', 'version'].filter(key => result[key] !== undefined).map(key => [key, result[key]]));
  for (const key of fields) if (result[key] !== undefined) value[key] = result[key];
  // A saved validity declaration must not lose the present-day caveats when
  // the caller chooses a compact view (or requests currentValidity alone).
  if (fields.includes('currentValidity')) for (const key of ['checkedAt', 'reviewAfter', 'reviewDue', 'dependencyReviewPending', 'dependencyReviewReasons']) {
    if (result[key] !== undefined) value[key] = result[key];
  }
  if (fields.includes('text')) Object.assign(value, { textPage: result.textPage, hasMore: result.hasMore, nextOffset: result.nextOffset, truncated: result.truncated });
  if (view === 'history') {
    const all = store.listEntries({ includeHistory: true }).filter(entry => entry.id === result.id).sort((a, b) => b.version - a.version);
    const offset = args.metadataOffset ?? 0, limit = args.metadataLimit ?? 5;
    value.versions = all.slice(offset, offset + limit).map(entry => ({ id: entry.id, version: entry.version, pool: entry.pool, recordedAt: entry.recordedAt, status: entry.status, currentValidity: entry.currentValidity ?? 'unknown' }));
    value.versionPage = { offset, total: all.length, nextOffset: offset + value.versions.length < all.length ? offset + value.versions.length : null };
  }
  return value;
}

/** Lightweight model-facing workflows. Cursors pin versions; they never pretend
 * a missing original or an unverified excerpt is a complete successful read. */
export function createWorkflowTools(store, api) {
  const cursors = new Map();
  const maxCursors = 256;
  function saveCursor(state) {
    const now = Date.now();
    for (const [key, saved] of cursors) if (saved.deadline <= now) cursors.delete(key);
    while (cursors.size >= maxCursors) cursors.delete(cursors.keys().next().value);
    const key = `fetch-${randomUUID()}`;
    cursors.set(key, { ...state, deadline: now + 3600000 });
    return key;
  }
  const outputLength = value => JSON.stringify(presentMemoryTimes(value, store.timezone)).length;

  function fetch(input = {}) {
    const args = object(input);
    keys(args, ['ids', 'sessionId', 'turnId', 'anchorId', 'budget', 'cursor', 'fields']);
    validateReadView({ fields: args.fields });
    const budget = integer(args.budget, 8000, 800, 48000, 'budget');
    let state;
    if (args.cursor !== undefined) {
      text(args.cursor, 'cursor', 100);
      const previous = cursors.get(args.cursor);
      if (!previous || previous.deadline <= Date.now()) throw new Error('读取游标已过期或插件已重启，请重新发起读取');
      if (args.ids || args.sessionId || args.turnId || args.anchorId || args.fields) throw new TypeError('续读只传 cursor 和可选 budget');
      state = structuredClone(previous);
    } else {
      if (args.ids && (args.sessionId || args.turnId || args.anchorId)) throw new TypeError('ids 与按轮读取条件不能混用');
      let refs, sequenceSource;
      let sessionId = args.sessionId, turnId = args.turnId;
      if (args.anchorId !== undefined) {
        const anchor = store.getRaw(text(args.anchorId, 'anchorId', 200));
        if (!anchor) throw new Error('anchorId 原文不存在');
        if (sessionId || turnId) throw new TypeError('anchorId 与 sessionId/turnId 不能混用');
        sessionId = anchor.sessionId; turnId = anchor.turnId;
      }
      if (sessionId !== undefined || turnId !== undefined) {
        text(sessionId, 'sessionId', 200); text(turnId, 'turnId', 200);
        const records = store.listRaw({ includeRetained: true }).filter(raw => raw.sessionId === sessionId && raw.turnId === turnId);
        const indexed = new Map(store.db.prepare('SELECT raw_id AS id,ordinal FROM completed_round_parts WHERE session_id=? AND turn_id=?').all(sessionId, turnId).map(item => [item.id, item.ordinal]));
        const capturePosition = store.db.prepare("SELECT rowid AS position FROM receipts WHERE pool='a' AND id=?");
        const captured = new Map(records.map(raw => [raw.id, capturePosition.get(raw.id)?.position ?? 0]));
        const allIndexed = records.length > 0 && records.every(raw => indexed.has(raw.id));
        sequenceSource = allIndexed ? 'completed_round_index' : 'recorded_time_then_capture_order';
        refs = records.sort((a, b) => allIndexed ? indexed.get(a.id) - indexed.get(b.id)
          : String(a.recordedAt).localeCompare(String(b.recordedAt)) || (captured.get(a.id) ?? 0) - (captured.get(b.id) ?? 0) || String(a.id).localeCompare(String(b.id)))
          .map(raw => ({ id: raw.id, kind: 'raw' }));
        if (refs.length > 500) throw new Error('此轮超过500条原文，请使用 memory_list 缩小范围后批量读取');
      } else {
        if (!Array.isArray(args.ids) || !args.ids.length || args.ids.length > 50) throw new TypeError('ids 需要1..50个定位对象');
        refs = args.ids.map(ref => {
          ref = typeof ref === 'string' ? { id: ref } : object(ref);
          keys(ref, ['id', 'kind', 'version']); text(ref.id, 'id', 200);
          if (ref.version !== undefined) integer(ref.version, undefined, 1, Number.MAX_SAFE_INTEGER, 'version');
          const raw = ref.kind && ref.kind !== 'raw' ? null : store.getRaw(ref.id);
          const entry = ref.kind === 'raw' ? null : store.getEntry(ref.id, ref.version === undefined ? {} : { version: ref.version });
          if (raw && entry) throw new Error('同一ID有多种记录，请明确kind');
          return { ...ref, ...(entry ? { version: entry.version, kind: entry.kind } : raw ? { kind: 'raw' } : {}) };
        });
      }
      state = { refs, index: 0, offset: 0, fields: args.fields, sessionId, turnId, sequenceSource };
    }
    const result = { items: [], total: state.refs.length, hasMore: false, cursor: null, budget, ...(state.sessionId ? { sessionId: state.sessionId, turnId: state.turnId, sequenceSource: state.sequenceSource, scope: 'available_originals_for_exact_session_turn' } : {}) };
    // Leave room for the continuation token, timezone presentation and envelope.
    const reserve = 130;
    for (; state.index < state.refs.length;) {
      const ref = state.refs[state.index];
      let item;
      try {
        const value = api.memory_read({ ...ref, offset: state.offset, limit: 16000, view: 'body', ...(state.fields ? { fields: state.fields } : {}) });
        item = value ? { ...value, readStatus: 'ok' } : { id: ref.id, readStatus: 'not_found' };
      } catch (error) { item = { id: ref.id, readStatus: 'error', error: clip(error.message, 180) }; }
      const space = budget - outputLength(result) - reserve;
      if (outputLength(item) > space && typeof item.text === 'string') {
        let low = 0, high = item.text.length;
        const full = item.text;
        const reduced = length => ({ ...item, text: full.slice(0, length), textPage: { ...item.textPage, returnedChars: length, hasMore: true, nextOffset: state.offset + length, truncated: true }, hasMore: true, nextOffset: state.offset + length, truncated: true });
        while (low < high) { const mid = Math.ceil((low + high) / 2); if (outputLength(reduced(mid)) <= space) low = mid; else high = mid - 1; }
        if (low > 0 && /[\uD800-\uDBFF]/u.test(full[low - 1])) low--;
        if (low > 0) item = reduced(low);
      }
      if (outputLength(item) > space || (item.hasMore && item.text?.length === 0)) {
        result.blocked = result.items.length ? 'budget' : 'metadata_requires_larger_budget';
        break;
      }
      result.items.push(item);
      if (item.readStatus === 'ok' && item.hasMore && typeof item.text === 'string') { state.offset = item.nextOffset; break; }
      state.index++; state.offset = 0;
    }
    result.hasMore = state.index < state.refs.length;
    if (result.hasMore) result.cursor = saveCursor(state);
    return result;
  }

  function resolveEntities(query) {
    const wanted = normalize(query);
    if (!wanted) return [];
    return store.listEntries({ pool: 'c' }).filter(entry => entry.kind === 'entity' && entry.status === 'active')
      .filter(entry => [entry.id, ...(entry.aliases ?? []), ...(entry.hooks ?? []), ...(entry.entities ?? [])].some(name => normalize(name) === wanted) || normalize(entry.text).includes(wanted))
      .slice(0, 20).map(entry => ({ id: entry.id, version: entry.version, name: entry.aliases?.[0] ?? entry.hooks?.[0] ?? entry.id, description: clip(entry.text), aliases: (entry.aliases ?? []).slice(0, 5), currentValidity: entry.currentValidity ?? 'unknown' }));
  }

  function prepare(input) {
    const args = object(input); keys(args, ['text', 'rawIds', 'pool', 'entity', 'limit']);
    if (args.text !== undefined) text(args.text, 'text', 4000);
    if (args.entity !== undefined) text(args.entity, 'entity', 200);
    if (!args.text && !args.entity) throw new TypeError('需要 text 或 entity');
    if (args.pool !== undefined && !['a2', 'b3', 'c', 'd'].includes(args.pool)) throw new TypeError('pool 必须是 a2、b3、c 或 d');
    const limit = integer(args.limit, 5, 1, 10, 'limit');
    const sources = [];
    if (args.rawIds !== undefined) {
      if (!Array.isArray(args.rawIds) || args.rawIds.length > 20) throw new TypeError('rawIds 最多20个');
      for (const id of args.rawIds) {
        const raw = store.getRaw(text(id, 'rawId', 200));
        if (!raw) { sources.push({ rawId: id, found: false }); continue; }
        const index = args.text ? raw.text.indexOf(args.text) : -1;
        sources.push({ rawId: id, found: true, role: raw.role, recordedAt: raw.recordedAt, sessionId: raw.sessionId,
          exactMatch: index >= 0, ...(index >= 0 ? { quote: args.text, offset: index, source: { rawId: id, quote: args.text, support: 'unassessed' } } : { textPreview: clip(raw.text, 500) }),
          derivedFromMemory: raw.derivedFromMemory ?? null });
      }
    }
    const related = args.text ? api.memory_search({ q: args.text.slice(0, 2048), ...(args.pool ? { pool: args.pool } : {}), limit, fuzzy: true }).candidates
      .map(item => ({ id: item.id, version: item.version, pool: item.pool, textPreview: item.snippet, statementType: item.statementType, currentValidity: item.currentValidity,
        ...(item.threadIds ? { threadIds: item.threadIds } : {}), ...(item.mergedInto ? { mergedInto: item.mergedInto } : {}),
        ...(item.dependencyReviewPending ? { dependencyReviewPending: true, dependencyReviewReasons: item.dependencyReviewReasons } : {}), comparisonRequired: true })) : [];
    const entities = resolveEntities(args.entity ?? '');
    return { sources, related, entities, ambiguousEntity: entities.length > 1, written: false,
      note: '相关旧记忆只是需比较的候选，不是已判定矛盾。只有exactMatch的引文才自动填入；缩写、改写、推断均须回读原文。重名须选具体实体ID。' };
  }

  function reviewBatch(input) {
    const args = object(input); keys(args, ['action', 'requestId', 'items']);
    text(args.requestId, 'requestId', 200);
    if (!Array.isArray(args.items) || !args.items.length || args.items.length > 20) throw new TypeError('items 必须为1..20个独立审查单元');
    const seenKeys = new Set(), owners = new Map(), rawOwners = new Map();
    for (const [index, item] of args.items.entries()) {
      object(item); keys(item, ['key', 'rawIds', 'entries', 'omissions', 'reason']); text(item.key, 'key', 80);
      if (seenKeys.has(item.key)) throw new Error('每项key必须唯一'); seenKeys.add(item.key);
      if (!Array.isArray(item.rawIds) || !item.rawIds.length) throw new TypeError('每项rawIds不能为空');
      for (const rawId of item.rawIds) { if (rawOwners.has(rawId) && rawOwners.get(rawId) !== index) throw new Error('跨项共享原文会造成提前标记完成；请放在同一审查单元'); rawOwners.set(rawId, index); }
      for (const entry of item.entries ?? []) if (entry.id) { if (owners.has(entry.id)) throw new Error('跨项条目ID重复'); owners.set(entry.id, index); }
    }
    for (const [index, item] of args.items.entries()) for (const entry of item.entries ?? []) {
      for (const endpoint of [entry.from, entry.to]) if (owners.has(endpoint) && owners.get(endpoint) !== index) throw new Error('跨项实体依赖须合并到同一原子审查单元');
      for (const source of entry.sources ?? []) if (rawOwners.has(source.rawId) && rawOwners.get(source.rawId) !== index) throw new Error('跨项来源依赖须合并到同一原子审查单元');
    }
    const results = args.items.map(item => {
      const requestId = `batch-${hash([args.requestId, item.key])}`;
      const { key, ...submission } = item;
      try {
        const result = api.memory_review({ action: 'submit', requestId, ...submission });
        return { key, requestId, status: 'committed', duplicate: Boolean(result.duplicate), result };
      } catch (error) { return { key, requestId, status: 'failed', error: clip(error.message, 1000), ...(error.details ? { details: error.details } : {}) }; }
    });
    return { requestId: args.requestId, results, succeeded: results.filter(item => item.status === 'committed').length, failed: results.filter(item => item.status === 'failed').length,
      note: '每个审查单元独立提交；单元内的原文覆盖和依赖保持原子性。失败项仍待审，重试保留requestId和key。' };
  }

  function manage(input) {
    const args = object(input); keys(args, ['action', 'requestId', 'reason', 'knowledge', 'check', 'thread', 'merge', 'date', 'limit', 'cursor']);
    switch (args.action) {
      case 'knowledge': return store.writeKnowledge({ ...object(args.knowledge), requestId: args.requestId, reason: args.reason });
      case 'revalidate': return store.reviewValidity({ ...object(args.check), requestId: args.requestId, reason: args.reason });
      case 'link_thread': return store.linkThread({ ...object(args.thread), requestId: args.requestId, reason: args.reason });
      case 'read_thread': return store.readThread(object(args.thread));
      case 'merge': return store.mergeEntries({ ...object(args.merge), requestId: args.requestId, reason: args.reason });
      case 'revoke_merge': return store.revokeMerge({ ...object(args.merge), requestId: args.requestId, reason: args.reason });
      case 'progress': return store.reviewProgress();
      case 'report': return store.reviewDailyReport({ ...(args.date === undefined ? {} : { date: args.date }), ...(args.limit === undefined ? {} : { limit: args.limit }), ...(args.cursor === undefined ? {} : { cursor: args.cursor }) });
      default: throw new TypeError('action 必须是 knowledge/revalidate/link_thread/read_thread/merge/revoke_merge/progress/report');
    }
  }
  return { memory_fetch: fetch, memory_prepare: prepare, memory_manage: manage, reviewBatch };
}
