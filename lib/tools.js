import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolveTimeQuery, mentionedTimes, matchTime } from './retrieval.js';
export { validateDate, localDate } from './retrieval.js';

const KINDS = new Set(['raw', 'memory', 'doing', 'entity', 'relation', 'preference', 'a3', 'b2']);
const POOLS = new Set(['a1', 'a2', 'a3', 'b', 'b2', 'b3', 'c']);
const ROLES = new Set(['user', 'assistant', 'tool']);
const SUPPORT = new Set(['unassessed', 'supports', 'contradicts', 'context_only']);
const STATUSES = new Set(['pending', 'active', 'done', 'cancelled', 'archived']);
const READ_DEFAULT = 4000;
const READ_MAX = 16000;
const QUOTE_MAX = 1000;
const AUXILIARY = /(?:情绪|主题|标签|emotion|tag|topic)[:：]([^\s,，;；]+)/giu;

function object(value, name = '参数') {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name}必须是对象`);
  return value;
}

function string(value, name, { optional = false, max = 2048 } = {}) {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || value.length > max) throw new TypeError(`${name}必须是不超过 ${max} 字符的字符串`);
  return value;
}

function integer(value, fallback, name, min, max) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new TypeError(`${name}必须是 ${min} 至 ${max} 的整数`);
  return value;
}

function onlyKeys(args, keys, name = '参数') {
  const allowed = new Set(keys);
  for (const key of Object.keys(args)) if (!allowed.has(key)) throw new TypeError(`${name}不支持 ${key}`);
}

function statement(args, name) {
  if (!['fact', 'self_report'].includes(args.statementType)) throw new TypeError(`${name} statementType 必须明确为 fact 或 self_report；推断仅可用独立 C 入口`);
}

function normalize(text) { return String(text ?? '').normalize('NFKC').toLocaleLowerCase('und'); }
function strings(values) { return Array.isArray(values) ? values.filter(x => typeof x === 'string') : []; }
function toolPool(record) { return record.kind === 'raw' || record.pool === 'a' ? 'a1' : record.pool ?? 'a2'; }

function textPage(text, offset, limit) {
  const totalChars = text.length;
  const value = text.slice(offset, offset + limit);
  const nextOffset = offset + value.length < totalChars ? offset + value.length : null;
  return { text: value, page: { offset, limit, totalChars, returnedChars: value.length,
    hasMore: nextOffset !== null, nextOffset, truncated: offset > 0 || value.length < totalChars, offsetUnit: 'utf16_code_units' } };
}

function arrayPage(items, offset, limit) {
  const values = items.slice(offset, offset + limit);
  const hasMore = offset + values.length < items.length;
  return { values, page: { offset, limit, total: items.length, count: values.length, hasMore,
    nextOffset: hasMore && values.length ? offset + values.length : null, truncated: offset > 0 || values.length < items.length } };
}

function entryReference(parent) {
  const id = typeof parent?.id === 'string' ? parent.id : '';
  const version = Number.isSafeInteger(parent?.version) && parent.version > 0 ? parent.version : null;
  return { id: id.slice(0, 200), version,
    ...(typeof parent?.hash === 'string' ? { hash: parent.hash.slice(0, 128) } : {}),
    read: id.length > 0 && id.length <= 200 && version !== null ? { tool: 'memory_read', arguments: { id, version } } : null };
}

// No spreading stored records: metadata arrays and arbitrary legacy objects can
// themselves be much larger than the requested text page.
function readMetadata(record, { sourceOffset = 0, sourceLimit = 5, coverageOffset = 0, coverageLimit = 5,
  metadataOffset = 0, metadataLimit = 5 } = {}) {
  const result = {};
  let truncated = false;
  for (const key of ['id', 'instanceId', 'sessionId', 'turnId', 'pool', 'role', 'kind', 'recordedAt', 'occurredAt', 'createdAt', 'expiresAt', 'date', 'status', 'sourceRoot', 'evidenceStatus', 'contextEvidenceStatus', 'dictVersion']) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value === 'string' && value.length > 200) { result[key] = value.slice(0, 200); truncated = true; }
    else if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) result[key] = value;
    else { result[key] = null; truncated = true; }
  }
  for (const key of ['sourceNature', 'project']) {
    if (record[key] === undefined) continue;
    result[key] = typeof record[key] === 'string' ? record[key].slice(0, 200) : null;
    truncated ||= typeof record[key] === 'string' && record[key].length > 200;
  }
  const fieldCounts = {};
  for (const key of ['hooks', 'tags', 'entities', 'aliases']) {
    const values = strings(record[key]);
    fieldCounts[key] = values.length;
    result[key] = values.slice(0, 8).map(value => value.slice(0, 120));
    truncated ||= values.length > 8 || values.some(value => value.length > 120);
  }
  if (record.version !== undefined) result.version = record.version;
  if (record.auditDowngraded === true) result.auditDowngraded = true;
  if (record.contextAuditDowngraded === true) result.contextAuditDowngraded = true;
  if (record.identityConflict === true) result.identityConflict = true;
  if (record.retired === true) result.retired = true;
  for (const key of ['pruned', 'provenanceOnly', 'legacyPolicy', 'legacyInference']) if (record[key] === true) result[key] = true;
  if (record.retirement && typeof record.retirement === 'object') {
    result.retirement = { ...entryReference(record.retirement) };
    for (const key of ['decision', 'reason', 'reviewRequestId', 'retiredAt']) {
      const value = record.retirement[key];
      if (typeof value === 'string') { result.retirement[key] = value.slice(0, 2000); truncated ||= value.length > 2000; }
    }
  }
  result.pool = toolPool(record);
  if (record.kind !== 'raw' && record.pool !== 'a') {
    result.statementType = ['fact', 'self_report', 'inference'].includes(record.statementType) ? record.statementType : 'legacy_unspecified';
    result.legacyStatement = result.statementType === 'legacy_unspecified' || (record.kind === 'a3' && record.statementType === 'inference');
    result.semanticStatus = 'declared_only';
    if (Number.isSafeInteger(record.policyVersion)) result.policyVersion = record.policyVersion;
  }
  if (record.inference && typeof record.inference === 'object') {
    result.inference = { reasoning: String(record.inference.reasoning ?? '').slice(0, 1000), uncertainty: String(record.inference.uncertainty ?? '').slice(0, 500) };
    truncated ||= String(record.inference.reasoning ?? '').length > 1000 || String(record.inference.uncertainty ?? '').length > 500;
  }
  const timePage = arrayPage(strings(record.mentionedTimes), metadataOffset, metadataLimit);
  result.mentionedTimes = timePage.values.map(value => value.slice(0, 40));
  result.mentionedTimesPage = timePage.page;
  const sourceTimes = arrayPage(Array.isArray(record.sourceTimes) ? record.sourceTimes : [], metadataOffset, metadataLimit);
  result.sourceTimes = sourceTimes.values.map(source => Object.fromEntries(['rawId', 'sessionId', 'recordedAt', 'occurredAt']
    .map(key => [key, typeof source?.[key] === 'string' ? source[key].slice(0, 200) : null])));
  result.sourceTimesPage = sourceTimes.page;
  const dependencies = arrayPage(Array.isArray(record.dependencyEntries) ? record.dependencyEntries : [], metadataOffset, metadataLimit);
  result.dependencyEntries = dependencies.values.map(entryReference);
  result.dependencyEntriesPage = dependencies.page;
  truncated ||= timePage.page.truncated || sourceTimes.page.truncated || dependencies.page.truncated;
  const event = value => {
    const result = { target: entryReference(value?.target), propagated: value?.propagated === true };
    for (const [key, max] of Object.entries({ requestId: 200, changeType: 40, status: 40, reason: 2000, decidedAt: 40 })) {
      const original = String(value?.[key] ?? '');
      result[key] = original.slice(0, max);
      truncated ||= original.length > max;
    }
    return result;
  };
  if (record.correctness && typeof record.correctness === 'object') {
    const values = Array.isArray(record.correctness.events) ? record.correctness.events : [];
    const page = arrayPage(values, metadataOffset, metadataLimit);
    result.correctness = { status: ['unreviewed', 'needs_review', 'superseded', 'disputed'].includes(record.correctness.status) ? record.correctness.status : 'unreviewed',
      events: page.values.map(event), eventsPage: page.page,
      eventCount: Number.isSafeInteger(record.correctness.eventCount) ? record.correctness.eventCount : values.length,
      eventsTruncated: Boolean(record.correctness.eventsTruncated || page.page.truncated) };
    truncated ||= result.correctness.eventsTruncated;
  }
  if (record.currentStateChanged === true) result.currentStateChanged = true;
  if (Array.isArray(record.currentStateEvents)) {
    const page = arrayPage(record.currentStateEvents, metadataOffset, metadataLimit);
    result.currentStateEvents = page.values.map(event);
    result.currentStateEventsPage = page.page;
    truncated ||= page.page.truncated;
  }
  if (record.kind === 'b2') {
    result.judgment = String(record.judgment ?? '').slice(0, 600);
    result.evidenceStatus = 'external_reference';
    truncated ||= String(record.judgment ?? '').length > 600;
  }
  if (record.kind === 'a3') {
    const parents = Array.isArray(record.sourceEntries) ? record.sourceEntries : [];
    const parentsPage = arrayPage(parents, sourceOffset, sourceLimit);
    result.derivedFromCount = Array.isArray(record.derivedFrom) ? record.derivedFrom.length : 0;
    result.sourceEntryCount = parents.length;
    result.sourceEntries = parentsPage.values.map(entryReference);
    result.derivedFrom = result.sourceEntries.map(parent => parent.id);
    result.sourceEntriesPage = parentsPage.page;
    result.derivedFromPage = parentsPage.page;
    const coverage = record.coverage ?? {};
    const scopePage = arrayPage(Array.isArray(coverage.scope) ? coverage.scope : [], coverageOffset, coverageLimit);
    const pageIds = new Set(scopePage.values.map(parent => parent.id));
    result.coverage = { scope: scopePage.values.map(entryReference),
      covered: strings(coverage.covered).filter(id => pageIds.has(id)).map(id => id.slice(0, 200)),
      notCovered: (Array.isArray(coverage.notCovered) ? coverage.notCovered : []).filter(item => pageIds.has(item.id))
        .map(item => ({ id: String(item.id).slice(0, 200), reason: String(item.reason ?? '').slice(0, 500) })),
      scopeNote: String(coverage.scopeNote ?? '').slice(0, 1000) };
    result.coveragePage = { ...scopePage.page, coveredCount: strings(coverage.covered).length,
      notCoveredCount: Array.isArray(coverage.notCovered) ? coverage.notCovered.length : 0 };
    result.depth = 2;
    result.evidenceStatus = 'derived_only';
    if (record.body && typeof record.body === 'object') {
      result.body = { time: String(record.body.time ?? '').slice(0, 300),
        persons: strings(record.body.persons).slice(0, 20).map(person => person.slice(0, 200)),
        event: String(record.body.event ?? '').slice(0, 2000) };
      truncated ||= String(record.body.time ?? '').length > 300 || strings(record.body.persons).length > 20 ||
        strings(record.body.persons).some(person => person.length > 200) || String(record.body.event ?? '').length > 2000;
    }
    for (const key of ['orphaned', 'lineageBroken', 'sourceChanged']) if (typeof record[key] === 'boolean') result[key] = record[key];
    if (record.statementType === 'inference' && record.inference) result.inference = {
      reasoning: String(record.inference.reasoning ?? '').slice(0, 1000), uncertainty: String(record.inference.uncertainty ?? '').slice(0, 500) };
    truncated ||= parentsPage.page.truncated || scopePage.page.truncated || result.sourceEntries.some(parent => !parent.read);
  }
  if (record.kind === 'preference') {
    for (const key of ['topic', 'stance', 'subject', 'expressionKind', 'target']) {
      const value = record[key];
      result[key] = typeof value === 'string' ? value.slice(0, 200) : null;
      truncated ||= typeof value === 'string' && value.length > 200;
    }
    if (typeof record.scopeEligible === 'boolean') result.scopeEligible = record.scopeEligible;
    if (record.declaration && typeof record.declaration === 'object') {
      result.declaration = { subject: String(record.declaration.subject ?? '').slice(0, 200),
        rawId: String(record.declaration.rawId ?? '').slice(0, 200), quote: String(record.declaration.quote ?? '').slice(0, QUOTE_MAX),
        quoteLength: String(record.declaration.quote ?? '').length, quoteTruncated: String(record.declaration.quote ?? '').length > QUOTE_MAX };
      truncated ||= result.declaration.quoteTruncated;
    }
    result.selfReport = true;
    result.evidenceStatus = 'self_report';
  }
  if (record.kind === 'relation') {
    // Current relation fields have strict store limits. Older free-form endpoints
    // are still data, and their original lengths remain visible when clipped.
    result.relationFieldLengths = {};
    for (const key of ['from', 'to', 'rel', 'note']) {
      const value = typeof record[key] === 'string' ? record[key] : null;
      result[key] = value?.slice(0, 2000) ?? null;
      result.relationFieldLengths[key] = value?.length ?? 0;
      truncated ||= (value?.length ?? 0) > 2000;
    }
  }
  for (const [key, fields] of Object.entries({
    coreDecision: ['requestId', 'sourceVersion', 'action', 'category', 'reason', 'decidedAt'],
    archiveDecision: ['requestId', 'sourceVersion', 'action', 'reason', 'decidedAt'],
    b2Decision: ['requestId', 'sourceVersion', 'action', 'reason', 'decidedAt'],
    preferenceDecision: ['requestId', 'sourceVersion', 'action', 'reason', 'asOf'],
    selfReview: ['requestId', 'reviewedAt'],
  })) {
    if (!record[key] || typeof record[key] !== 'object') continue;
    result[key] = {};
    for (const field of fields) {
      const value = record[key][field];
      if (typeof value === 'string') {
        result[key][field] = value.slice(0, 2000);
        truncated ||= value.length > 2000;
      } else if (typeof value === 'number') result[key][field] = value;
    }
  }
  return { ...result, independentSourceCount: null, currentValidity: 'unknown', fieldCounts,
    metadataTruncated: truncated, legacyPresent: record.legacy != null };
}

export function shortText(value, max = 100) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  if (text.length <= max) return text;
  if (max < 2) return text.slice(0, max);
  let end = max - 1;
  if (/[\uD800-\uDBFF]/u.test(text[end - 1] ?? '')) end--;
  return text.slice(0, end) + '…';
}

function termsFor(text) {
  const result = new Set();
  for (const token of normalize(text).match(/[\p{Script=Han}]+|[\p{L}\p{N}_]+/gu) ?? []) {
    result.add(token);
    if (/^[\p{Script=Han}]+$/u.test(token) && token.length > 2) {
      for (let i = 0; i < token.length - 1; i++) result.add(token.slice(i, i + 2));
    }
  }
  return [...result];
}

function entityNames(entry) {
  return [...new Set([entry.id, ...strings(entry.hooks), ...strings(entry.aliases), ...strings(entry.entities)].map(normalize).filter(Boolean))];
}

function expandAliases(query, entities) {
  const expanded = new Set();
  const normalized = normalize(query);
  for (const entity of entities) {
    const names = entityNames(entity);
    if (names.some(name => normalized === name || (name.length > 1 && normalized.includes(name)))) {
      for (const name of names) expanded.add(name);
    }
  }
  return [...expanded].slice(0, 100);
}

function count(text, term) {
  if (!term) return 0;
  let value = 0, offset = 0;
  while ((offset = text.indexOf(term, offset)) !== -1) { value++; offset += term.length; }
  return value;
}

function searchable(record) {
  const primary = normalize(record.kind === 'b2' ? `${record.text ?? ''}\n判断：${record.judgment ?? ''}` : `${record.text ?? ''}\n${record.body?.event ?? ''}`);
  const hooks = normalize([...strings(record.hooks), ...strings(record.aliases), ...strings(record.entities),
    ...strings(record.body?.persons), record.project ?? '', record.topic ?? '', record.subject ?? '', record.target ?? ''].join(' '));
  const tags = normalize(strings(record.tags).join(' '));
  return { primary, hooks, tags, length: Math.max(1, primary.length + hooks.length) };
}

function snippet(text, terms) {
  const clean = String(text ?? '').replace(/\s+/gu, ' ').trim();
  const normalized = normalize(clean);
  const matches = terms.map(term => normalized.indexOf(term)).filter(index => index >= 0);
  const begin = matches.length ? Math.max(0, Math.min(...matches) - 20) : 0;
  return shortText((begin ? '…' : '') + clean.slice(begin), 100);
}

function candidate(record, terms, score, mentions = [], matchedAxes = []) {
  return {
    id: record.id, kind: record.kind ?? 'raw', pool: toolPool(record),
    ...(record.retired === true ? { retired: true } : {}),
    ...(record.pruned === true ? { pruned: true, provenanceOnly: true } : {}),
    ...(record.legacyInference === true ? { legacyInference: true } : {}),
    hooks: (strings(record.hooks).length ? record.hooks : [record.role ?? record.kind, record.date ?? record.recordedAt?.slice(0, 10)].filter(Boolean)).slice(0, 4).map(hook => shortText(hook, 40)),
    snippet: snippet(record.kind === 'b2' ? `${record.text ?? ''}\n判断：${record.judgment ?? ''}` : record.text, terms), recordedAt: record.recordedAt, occurredAt: record.occurredAt ?? null,
    mentionedTimes: mentions.slice(0, 4), mentionedTimeCount: mentions.length, matchedTimeAxes: matchedAxes,
    role: record.role ?? null, status: record.status ?? null, sourceNature: record.sourceNature ?? 'unknown',
    sourceRoot: record.sourceRoot ?? null, sourceIds: strings((record.sources ?? []).map(x => x.rawId)).slice(0, 4), sourceCount: (record.sources ?? []).length,
    evidenceStatus: record.kind === 'b2' ? 'external_reference' : record.kind === 'a3' ? 'derived_only' : record.kind === 'preference' ? 'self_report' : record.kind !== 'raw' ? record.evidenceStatus ?? 'unverified' : 'original_record',
    ...(record.kind === 'b2' ? { expiresAt: record.expiresAt, externalSourceCount: Array.isArray(record.externalSources) ? record.externalSources.length : 0 } : {}),
    ...(record.kind === 'a3' ? { depth: 2, orphaned: Boolean(record.orphaned), lineageBroken: Boolean(record.lineageBroken),
      sourceChanged: Boolean(record.sourceChanged),
      a3Read: { tool: 'memory_a3_read', arguments: { id: record.id, version: record.version } } } : {}),
    ...(record.kind !== 'raw' ? {
      statementType: ['fact', 'self_report', 'inference'].includes(record.statementType) ? record.statementType : 'legacy_unspecified',
      legacyStatement: !['fact', 'self_report'].includes(record.statementType) && toolPool(record) !== 'c',
      semanticStatus: 'declared_only',
    } : {}),
    ...(record.correctness ? { correctnessStatus: ['unreviewed', 'needs_review', 'superseded', 'disputed'].includes(record.correctness.status) ? record.correctness.status : 'unreviewed' } : {}),
    ...(record.currentStateChanged === true ? { currentStateChanged: true } : {}),
    ...(record.kind === 'preference' ? { subject: shortText(record.subject ?? 'self', 200), topic: shortText(record.topic, 120),
      target: typeof record.target === 'string' ? shortText(record.target, 200) : null, expressionKind: shortText(record.expressionKind ?? 'preference', 32),
      stance: record.stance, scopeEligible: record.scopeEligible ?? record.subject === 'self', selfReport: true } : {}),
    independentSourceCount: null, version: record.version ?? null,
    read: { id: record.id, kind: record.kind ?? 'raw', ...(record.version === undefined ? {} : { version: record.version }) },
    currentValidity: 'unknown', score: Math.round(score * 1000) / 1000,
  };
}

function parseSearch(input, timezone, now) {
  const args = { ...object(input) };
  onlyKeys(args, ['q', 'date', 'from', 'to', 'timeAxis', 'timeWindow', 'type', 'pool', 'includeHistory', 'status', 'orphaned', 'lineageBroken',
    'entity', 'subject', 'topic', 'eventKeywords', 'scopeEligible', 'project', 'limit', 'offset']);
  const q = string(args.q, 'q', { optional: true });
  const time = resolveTimeQuery(args, { timeZone: timezone, now });
  const type = string(args.type, 'type', { optional: true, max: 120 });
  if (args.pool !== undefined && !POOLS.has(args.pool)) throw new TypeError('pool 必须是 a1、a2、a3、b、b2、b3 或 c');
  if (args.type === 'b' && args.pool !== undefined && args.pool !== 'b') throw new TypeError('type:b 不能与其他 pool 同时使用');
  if (args.includeHistory !== undefined && typeof args.includeHistory !== 'boolean') throw new TypeError('includeHistory 必须是布尔值');
  if (args.status !== undefined && !STATUSES.has(args.status)) throw new TypeError('status 必须是 pending、active、done、cancelled 或 archived');
  for (const key of ['orphaned', 'lineageBroken']) if (args[key] !== undefined && (typeof args[key] !== 'boolean' || args.pool !== 'a3')) throw new TypeError(`${key} 必须是 A3 查询的布尔过滤条件`);
  if (args.scopeEligible !== undefined && (typeof args.scopeEligible !== 'boolean' || args.pool !== 'b3')) throw new TypeError('scopeEligible 必须是 B3 查询的布尔过滤条件');
  return { q, time, timeAxis: time.axis, fromBound: time.fromBound, toBound: time.toBound, type, pool: args.pool ?? (type === 'b' ? 'b' : undefined),
    orphaned: args.orphaned, lineageBroken: args.lineageBroken,
    includeHistory: args.includeHistory ?? time.hasTimeFilter, status: args.status, scopeEligible: args.scopeEligible,
    entity: string(args.entity, 'entity', { optional: true, max: 200 }),
    subject: string(args.subject, 'subject', { optional: true, max: 200 }),
    topic: string(args.topic, 'topic', { optional: true, max: 200 }),
    eventKeywords: string(args.eventKeywords, 'eventKeywords', { optional: true, max: 1000 }),
    project: string(args.project, 'project', { optional: true, max: 200 }),
    limit: integer(args.limit, 4, 'limit', 1, 20), offset: integer(args.offset, 0, 'offset', 0, Number.MAX_SAFE_INTEGER),
  };
}

/** Original messages and manually authored entries are searched independently. No index is required. */
export function createTools(store) {
  function statistics(args, operation) {
    if (args.q || args.entity || args.subject || args.topic || args.eventKeywords || args.project || args.status) throw new TypeError('B 只保留参与统计，不支持正文、实体、项目或状态查询');
    if (!['either', 'recorded'].includes(args.timeAxis)) throw new TypeError('B 统计只有 recorded 时间轴');
    if ((args.fromBound && !args.fromBound.date) || (args.toBound && !args.toBound.date)) throw new TypeError('B 统计仅支持 YYYY-MM-DD 日期边界');
    if (args.time.timeZone !== store.timezone) throw new TypeError('B 按存储时区汇总，不能转换统计日期时区');
    if (args.type && args.type !== 'b' && !ROLES.has(args.type)) throw new TypeError('B 统计 type 仅支持 user、assistant 或 tool');
    const dates = store.listProjectionDates().filter(date => (!args.fromBound || date >= args.fromBound.date) && (!args.toBound || date <= args.toBound.date));
    const all = dates.map(date => ({ date, ...store.dayStats(date, { role: ROLES.has(args.type) ? args.type : undefined }).b }))
      .filter(item => item.total > 0).sort((a, b) => b.date.localeCompare(a.date));
    const items = all.slice(args.offset, args.offset + args.limit);
    const hasMore = args.offset + items.length < all.length;
    store.recordRecall({ operation, resultCount: items.length, hasMore, timeAxis: 'recorded' });
    return { pool: 'b', kind: 'participation_stats', items, total: all.length, offset: args.offset, limit: args.limit,
      hasMore, nextOffset: hasMore ? args.offset + items.length : null, timeAxis: 'recorded', role: ROLES.has(args.type) ? args.type : null,
      resolvedTime: args.time.resolvedTime ? { ...args.time.resolvedTime, axis: 'recorded' } : null, automaticWidening: false,
      effectiveFilters: { pool: 'b', type: args.type || null, timeAxis: 'recorded', timeZone: store.timezone },
      note: '仅有按本地日期、角色与小时汇总的参与次数；B 不保存正文，也不能作为独立事实证据。' };
  }

  function search(input, operation = 'memory_search') {
    const started = performance.now();
    const args = parseSearch(input, store.timezone, typeof store.now === 'function' ? store.now() : new Date());
    if (args.pool === 'b') return statistics(args, operation);
    const allEntries = store.listEntries({ includeHistory: args.includeHistory });
    const entities = allEntries.filter(entry => entry.kind === 'entity');
    const auxiliary = [...args.q.matchAll(AUXILIARY)].map(match => normalize(match[0]));
    const primaryQuery = args.q.replace(AUXILIARY, ' ').trim();
    const aliasTerms = expandAliases(primaryQuery, entities);
    const terms = [...new Set([...termsFor(primaryQuery), ...aliasTerms])];
    const entityTerms = args.entity ? [...new Set([normalize(args.entity), ...expandAliases(args.entity, entities)])] : [];
    const subjectTerms = args.subject ? [...new Set([normalize(args.subject), ...expandAliases(args.subject, entities)])] : [];
    const eventTerms = termsFor(args.eventKeywords);
    if (args.eventKeywords.trim() && !eventTerms.length) throw new TypeError('eventKeywords 必须含可检索的文字或数字');
    const structuralType = KINDS.has(args.type) || ROLES.has(args.type) || args.type === 'a' || args.type === 'b';
    if (args.type && !structuralType) auxiliary.push(normalize(args.type));
    const originals = store.listRaw({ includeRetained: true });
    const corpus = [...originals.map(raw => ({ ...raw, kind: 'raw' })), ...allEntries];
    const rawCache = new Map(originals.map(raw => [raw.id, raw]));
    const entryCache = new Map(allEntries.map(entry => [`${entry.id}\0${entry.version}`, entry]));
    const getRaw = id => { if (!rawCache.has(id)) rawCache.set(id, store.getRaw(id)); return rawCache.get(id); };
    const getEntry = (id, options) => {
      const key = `${id}\0${options.version}`;
      if (!entryCache.has(key)) entryCache.set(key, store.getEntry(id, options));
      return entryCache.get(key);
    };
    const timeResults = new Map();
    let unknownTimeExcluded = 0;
    const records = corpus.filter(record => {
      if (record.pool === 'b') return false;
      if (args.pool && toolPool(record) !== args.pool) return false;
      if (args.orphaned !== undefined && Boolean(record.orphaned) !== args.orphaned) return false;
      if (args.lineageBroken !== undefined && Boolean(record.lineageBroken) !== args.lineageBroken) return false;
      if (structuralType && args.type !== 'a' && record.kind !== args.type && record.role !== args.type) return false;
      if (args.type === 'a' && record.kind !== 'raw') return false;
      if (args.status && record.status !== args.status) return false;
      if (args.scopeEligible !== undefined && record.scopeEligible !== args.scopeEligible) return false;
      if (args.project && normalize(record.project) !== normalize(args.project)) return false;
      const fields = searchable(record);
      if (entityTerms.length) {
        if (!entityTerms.some(term => fields.primary.includes(term) || fields.hooks.includes(term))) return false;
      }
      if (subjectTerms.length && !subjectTerms.some(term => record.kind === 'preference'
        ? normalize(record.subject) === term : fields.primary.includes(term) || fields.hooks.includes(term))) return false;
      if (args.topic && !`${fields.primary} ${fields.hooks}`.includes(normalize(args.topic))) return false;
      if (eventTerms.length && !eventTerms.some(term => fields.primary.includes(term) || fields.hooks.includes(term))) return false;
      const mentions = mentionedTimes(record, { getRaw, getEntry });
      const time = matchTime(record, args.time, mentions);
      if (!time.matches) {
        if (time.unknownTime && (!terms.length || terms.some(term => fields.primary.includes(term) || fields.hooks.includes(term)))) unknownTimeExcluded++;
        return false;
      }
      timeResults.set(record, { mentions, matchedAxes: time.matchedAxes });
      return true;
    }).map(record => ({ record, fields: searchable(record) }));
    const averageLength = records.reduce((sum, item) => sum + item.fields.length, 0) / Math.max(1, records.length);
    const frequencies = new Map(terms.map(term => [term, records.filter(({ fields }) => fields.primary.includes(term) || fields.hooks.includes(term)).length]));
    const ranked = [];
    for (const { record, fields } of records) {
      let score = 0, found = terms.length === 0;
      for (const term of terms) {
        const tf = count(fields.primary, term) + count(fields.hooks, term) * 2;
        if (!tf) continue;
        found = true;
        const df = frequencies.get(term);
        const idf = Math.log(1 + (records.length - df + 0.5) / (df + 0.5));
        score += idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * fields.length / averageLength));
      }
      if (!found) continue;
      if (primaryQuery && fields.primary.includes(normalize(primaryQuery))) score += 3;
      if (primaryQuery && fields.hooks.includes(normalize(primaryQuery))) score += 4;
      for (const tag of auxiliary) if (`${fields.primary} ${fields.hooks} ${fields.tags}`.includes(tag)) score += 0.25;
      ranked.push({ record, score });
    }
    ranked.sort((a, b) => b.score - a.score || String(b.record.recordedAt).localeCompare(String(a.record.recordedAt)) || String(a.record.id).localeCompare(String(b.record.id)) || (b.record.version ?? 0) - (a.record.version ?? 0));
    const candidates = ranked.slice(args.offset, args.offset + args.limit).map(({ record, score }) => {
      const time = timeResults.get(record);
      return candidate(record, terms, score, time.mentions, time.matchedAxes);
    });
    store.recordRecall({ operation, candidateIds: candidates.map(x => x.id), resultCount: candidates.length,
      durationMs: Math.round((performance.now() - started) * 1000) / 1000, hasMore: args.offset + candidates.length < ranked.length, timeAxis: args.timeAxis });
    return { candidates, hasMore: args.offset + candidates.length < ranked.length, total: ranked.length,
      offset: args.offset, limit: args.limit, scannedCount: corpus.length, timeAxis: args.timeAxis,
      includeHistory: args.includeHistory, pool: args.pool ?? 'all',
      resolvedTime: args.time.resolvedTime, automaticWidening: false, unknownTimeExcluded,
      effectiveFilters: { q: args.q, entity: args.entity || null, subject: args.subject || null, topic: args.topic || null,
        eventKeywords: args.eventKeywords || null, project: args.project || null, type: args.type || null, pool: args.pool ?? 'all',
        status: args.status ?? null, scopeEligible: args.scopeEligible ?? null, includeHistory: args.includeHistory,
        timeAxis: args.timeAxis, eitherAxes: args.timeAxis === 'either' ? ['recorded', 'occurred'] : null,
        orphaned: args.orphaned ?? null, lineageBroken: args.lineageBroken ?? null,
        aliasExpansion: aliasTerms.slice(0, 20).map(term => shortText(term, 200)), aliasExpansionOmitted: Math.max(0, aliasTerms.length - 20) },
      channels: ['original_raw', 'manual_entries'],
      note: '候选仅供定位；历史版本须保留 version。mentioned 是原始对话时间，recorded 是该版本录入时间，occurred 是已记录的发生时间，未知不补齐。引文命中不等于事实成立；未命中不代表事情没发生。本次未自动扩大范围，可明确换轴或扩大条件后再查。' };
  }

  function read(input) {
    const args = typeof input === 'string' ? { id: input } : object(input);
    onlyKeys(args, ['id', 'kind', 'pool', 'version', 'offset', 'limit', 'evidenceOffset', 'evidenceLimit', 'sourceOffset', 'sourceLimit',
      'coverageOffset', 'coverageLimit', 'metadataOffset', 'metadataLimit']);
    const id = string(args.id, 'id', { max: 256 });
    if (!id) throw new TypeError('id 不能为空');
    if (args.kind !== undefined && !KINDS.has(args.kind)) throw new TypeError('kind 不受支持');
    if (args.pool !== undefined && !['a1', 'a2', 'a3', 'b2', 'b3', 'c'].includes(args.pool)) throw new TypeError('read pool 必须是 a1、a2、a3、b2、b3 或 c；B 没有正文');
    if (args.version !== undefined) integer(args.version, undefined, 'version', 1, Number.MAX_SAFE_INTEGER);
    const offset = integer(args.offset, 0, 'offset', 0, Number.MAX_SAFE_INTEGER);
    const limit = integer(args.limit, READ_DEFAULT, 'limit', 1, READ_MAX);
    const evidenceOffset = integer(args.evidenceOffset, 0, 'evidenceOffset', 0, Number.MAX_SAFE_INTEGER);
    const evidenceLimit = integer(args.evidenceLimit, 4, 'evidenceLimit', 0, 10);
    const sourceOffset = integer(args.sourceOffset, 0, 'sourceOffset', 0, Number.MAX_SAFE_INTEGER);
    const sourceLimit = integer(args.sourceLimit, 5, 'sourceLimit', 1, 10);
    const coverageOffset = integer(args.coverageOffset, 0, 'coverageOffset', 0, Number.MAX_SAFE_INTEGER);
    const coverageLimit = integer(args.coverageLimit, 5, 'coverageLimit', 1, 10);
    const metadataOffset = integer(args.metadataOffset, 0, 'metadataOffset', 0, Number.MAX_SAFE_INTEGER);
    const metadataLimit = integer(args.metadataLimit, 5, 'metadataLimit', 1, 10);
    const raw = args.kind && args.kind !== 'raw' ? null : store.getRaw(id);
    const entry = args.kind === 'raw' ? null : store.getEntry(id, args.version === undefined ? {} : { version: args.version });
    const b2 = entry?.kind === 'b2' ? entry : null;
    if (raw && entry) throw new Error('此 ID 同时用于原文和条目，请指定 kind');
    const record = raw ?? entry;
    if (record && args.kind && (raw ? 'raw' : record.kind) !== args.kind) return null;
    if (record && args.pool && toolPool(record) !== args.pool) return null;
    store.recordRecall({ operation: 'memory_read', id, kind: raw ? 'raw' : record?.kind ?? null, version: record?.version ?? null, found: Boolean(record) });
    if (!record) return null;
    const body = textPage(record.text, offset, limit);
    const recordMentions = mentionedTimes(record, { getRaw: id => store.getRaw(id), getEntry: (id, options) => store.getEntry(id, options) });
    const common = { ...readMetadata({ ...record, mentionedTimes: recordMentions }, { sourceOffset, sourceLimit, coverageOffset, coverageLimit, metadataOffset, metadataLimit }), text: body.text, textPage: body.page,
      hasMore: body.page.hasMore, nextOffset: body.page.nextOffset, truncated: body.page.truncated };
    if (raw) {
      return { ...common, kind: 'raw',
        checks: {
          quoteLocation: { status: 'original_record', rawId: raw.id },
          supportJudgment: { status: 'unassessed', note: '原文证明该来源当时记录了这些话，不自动证明话中主张为事实。' },
          sourceNature: { role: raw.role, nature: common.sourceNature ?? 'unknown', sourceRoot: raw.sourceRoot ?? raw.id, independence: 'unknown' },
          currentValidity: { status: 'unknown', recordedAt: raw.recordedAt, occurredAt: raw.occurredAt ?? null },
        } };
    }
    if (b2) {
      const external = Array.isArray(b2.externalSources) ? b2.externalSources : [];
      const page = arrayPage(external, evidenceOffset, evidenceLimit);
      return { ...common, externalSourceCount: external.length,
        externalSources: page.values.map(source => ({ url: String(source.url ?? '').slice(0, 2048), title: String(source.title ?? '').slice(0, 200), accessedAt: String(source.accessedAt ?? '').slice(0, 40) })),
        externalSourcesPage: page.page, sources: [], sourceCount: 0, originals: [],
        checks: {
          quoteLocation: { status: 'not_checked', scope: 'external_references', note: '仅保存外部网址引用，不保存或自动核验网页全文。' },
          supportJudgment: { status: 'not_independently_verified', note: 'judgment 是肥鱼对外部资料的判断，不是独立事实验证，也不能替代 A1 原文证据。' },
          sourceNature: { status: 'external_reference', independence: 'unknown' },
          currentValidity: { status: 'unknown', recordedAt: b2.recordedAt, expiresAt: b2.expiresAt },
        } };
    }
    const sourceCount = (entry.sources ?? []).length;
    const sourcePage = (entry.sources ?? []).slice(evidenceOffset, evidenceOffset + evidenceLimit);
    const originalRecords = new Map(), originals = new Map();
    const evidence = sourcePage.map((source, pageIndex) => {
      if (!originalRecords.has(source.rawId)) originalRecords.set(source.rawId, store.getRaw(source.rawId));
      const original = originalRecords.get(source.rawId);
      const exact = Boolean(original && typeof source.quote === 'string' && source.quote.length && original.text.includes(source.quote));
      const index = exact ? original.text.indexOf(source.quote) : null;
      if (original && !originals.has(original.id)) originals.set(original.id, {
        id: original.id, role: original.role, recordedAt: original.recordedAt, occurredAt: original.occurredAt ?? null,
        sourceNature: typeof original.sourceNature === 'string' ? original.sourceNature.slice(0, 200) : 'unknown', sourceRoot: original.sourceRoot ?? original.id,
        textLength: original.text.length, read: { id: original.id, kind: 'raw', offset: 0, limit: READ_DEFAULT },
      });
      return { sourceIndex: evidenceOffset + pageIndex, rawId: source.rawId, originalId: original?.id ?? null,
        quote: source.quote.slice(0, QUOTE_MAX), quoteLength: source.quote.length, quoteTruncated: source.quote.length > QUOTE_MAX,
        quoteLocation: { status: !original ? 'missing_original' : exact ? 'exact_match' : 'quote_mismatch', index,
          quoteLength: source.quote.length, read: exact ? { id: original.id, kind: 'raw', offset: index, limit: Math.min(source.quote.length, READ_MAX) } : null },
        supportJudgment: { status: 'not_independently_verified', declared: SUPPORT.has(source.support) ? source.support : 'unassessed' },
        sourceNature: { role: original?.role ?? null, nature: typeof original?.sourceNature === 'string' ? original.sourceNature.slice(0, 200) : 'unknown', sourceRoot: original?.sourceRoot ?? null, independence: 'unknown' },
        currentValidity: { status: 'unknown' },
      };
    });
    const roots = evidence.map(x => x.sourceNature.sourceRoot).filter(Boolean);
    const evidenceHasMore = evidenceOffset + evidence.length < sourceCount;
    return { ...common, evidence, sourceCount, originals: [...originals.values()],
      sources: evidence.map(source => ({ rawId: source.rawId, quote: source.quote, quoteLength: source.quoteLength, quoteTruncated: source.quoteTruncated, support: source.supportJudgment.declared })),
      evidencePage: { offset: evidenceOffset, limit: evidenceLimit, total: sourceCount, count: evidence.length,
        hasMore: evidenceHasMore, nextOffset: evidenceHasMore && evidence.length ? evidenceOffset + evidence.length : null,
        truncated: evidenceOffset > 0 || evidence.length < sourceCount },
      checks: {
        quoteLocation: entry.kind === 'a3'
          ? { status: 'derived_only', scope: 'a2_parents', note: 'A3 不是原文；轻量来源元数据记录精确 A2 版本，父正文可能已按明确审查清理，缺失正文不等于主张被证伪。' }
          : { status: evidence.length && evidence.every(x => x.quoteLocation.status === 'exact_match') ? 'exact_matches_only' : 'unverified', count: evidence.length, total: sourceCount, scope: 'current_evidence_page' },
        supportJudgment: entry.kind === 'a3'
          ? { status: 'derived_only', note: common.statementType === 'inference'
            ? '这是旧版保存的显式推断，按原含义读取；不作为新事实，也不提高来源独立性。'
            : '这是对 A2 的再次提纯；fact/self_report 是写入者声明，不构成新增原始证据或独立事实验证。' }
          : entry.kind === 'preference'
          ? { status: 'self_report', subject: common.subject,
            note: common.subject === 'self' ? '这是记忆拥有者自身喜好或情绪的自述；不自动证明态度稳定、持续有效或对象也持相同态度。'
              : '这是指定主体的明确自述记录；逐字引文不证明其长期有效，也不能当成记忆拥有者自己的喜好。' }
          : { status: 'not_independently_verified', note: '逐字定位只校验引文位置；supports 等标签是写入者的声明，不是系统确认。' },
        sourceNature: entry.kind === 'a3'
          ? { status: 'second_distillation', independence: 'unknown', scope: 'a2_parents' }
          : { status: 'per_source', independence: roots.length > 1 && new Set(roots).size === 1 ? 'known_same_origin' : 'unknown', scope: 'current_evidence_page' },
        currentValidity: { status: 'unknown', lastKnownStatus: entry.status ?? null, asOf: entry.recordedAt },
      } };
  }

  function readA3(input) {
    const args = typeof input === 'string' ? { id: input } : object(input);
    const result = read({ ...args, kind: 'a3', pool: 'a3' });
    if (!result) return null;
    const parents = result.sourceEntries.map(reference => {
      const parent = reference.read ? store.getEntry(reference.id, { version: reference.version }) : null;
      const sources = Array.isArray(parent?.sources) ? parent.sources : [];
      const rawIds = [...new Set(sources.map(source => source.rawId).filter(id => typeof id === 'string'))];
      return { ...reference, found: Boolean(parent), bodyAvailable: Boolean(parent && !parent.provenanceOnly),
        pruned: parent?.pruned === true, kind: parent?.kind ?? null, pool: parent?.pool ?? null,
        status: parent?.status ?? null, retired: Boolean(parent?.retired), snippet: shortText(parent?.text ?? '', 200),
        evidenceStatus: parent?.evidenceStatus ?? 'unverified', currentValidity: 'unknown',
        sourceCount: sources.length, rawSourceCount: rawIds.length, rawSources: rawIds.slice(0, 4).map(rawId => ({ rawId,
          read: { tool: 'memory_read', arguments: { id: rawId, kind: 'raw' } } })), rawSourcesOmitted: Math.max(0, rawIds.length - 4) };
    });
    return { ...result, parents, parentPage: result.sourceEntriesPage,
      lineageNote: '父条目摘要仅供定位，provenanceOnly/pruned 表示仅保留轻量来源标记、正文已清理；原始出处数量不代表独立证据数量。可用 read 指针检查仍保留的来源。' };
  }

  return {
    memory_search: search,
    memory_read: read,
    memory_list(input) {
      const args = { ...object(input) };
      args.q = '';
      return search(args, 'memory_list');
    },
    memory_write(input) {
      const args = object(input);
      if (args.kind === 'raw') throw new Error('原文只允许由宿主捕获或管理员导入；模型工具不能制造 raw 证据');
      if (args.kind === 'retention_review') throw new Error('保留/删除审核仅限管理员 CLI；模型工具不能批准删除原文');
      if (args.kind === 'preference' || args.pool === 'b3') throw new Error('kind:preference / pool:b3 只能使用 memory_preference；用户偏好仍写 A2');
      if (args.kind === 'b2' || args.pool === 'b2') throw new Error('kind:b2 / pool:b2 只能使用 memory_b2_write；外部引用不是 A1 原文');
      if (args.kind === 'a3' || args.pool === 'a3') throw new Error('kind:a3 / pool:a3 只能使用 memory_a3_write，从 A2 二次提纯关键资料');
      if (!['memory', 'doing', 'entity', 'relation'].includes(args.kind)) throw new TypeError('kind 必须是 memory、doing、entity 或 relation');
      onlyKeys(args, ['id', 'kind', 'pool', 'expectedVersion', 'text', 'hooks', 'tags', 'entities', 'aliases', 'project', 'sources', 'status',
        'from', 'to', 'rel', 'note', 'recordedAt', 'occurredAt', 'sourceNature', 'statementType']);
      statement(args, 'A2');
      const record = store.writeEntry(args);
      const body = textPage(record.text, 0, READ_DEFAULT);
      return { ...readMetadata(record), text: body.text, textPage: body.page, committed: record.committed,
        projectionPending: record.projectionPending, read: { tool: 'memory_read', arguments: { id: record.id, version: record.version } } };
    },
    memory_graph(input) {
      const args = object(input);
      onlyKeys(args, ['center', 'pool', 'depth', 'limit']);
      const center = string(args.center ?? 'self', 'center', { max: 200 });
      if (!center) throw new TypeError('center 不能为空');
      const pool = args.pool ?? 'c';
      if (!['c', 'a2', 'all'].includes(pool)) throw new TypeError('graph pool 必须是 c、a2 或 all');
      return store.graph({ center, pool, depth: integer(args.depth, 2, 'depth', 1, 5), limit: integer(args.limit, 100, 'limit', 1, 500) });
    },
    memory_review_queue(input) {
      const args = object(input);
      onlyKeys(args, ['limit', 'offset']);
      return store.listReviewQueue({ limit: integer(args.limit, 4, 'limit', 1, 20), offset: integer(args.offset, 0, 'offset', 0, Number.MAX_SAFE_INTEGER) });
    },
    memory_review_request(input) {
      const args = object(input);
      onlyKeys(args, ['requestId', 'rawIds', 'reason']);
      return store.requestEarlyReview(args);
    },
    memory_review(input) {
      const args = object(input);
      if (args.action === 'history') {
        onlyKeys(args, ['action', 'limit', 'offset', 'id']);
        return store.reviewHistory({
          limit: integer(args.limit, 20, 'limit', 1, 100), offset: integer(args.offset, 0, 'offset', 0, Number.MAX_SAFE_INTEGER),
          ...(args.id === undefined ? {} : { id: string(args.id, 'id', { max: 200 }) }),
        });
      }
      if (args.action !== 'submit') throw new TypeError('action 必须是 submit 或 history；原文删除审核仅供管理员 CLI review');
      onlyKeys(args, ['action', 'requestId', 'rawIds', 'reason', 'entries', 'omissions']);
      const entries = args.entries ?? [];
      if (!Array.isArray(entries)) throw new TypeError('entries 必须是数组');
      for (const entry of entries) {
        object(entry, 'entries 条目');
        if (!['memory', 'doing', 'entity', 'relation'].includes(entry.kind)) throw new TypeError('self review kind 必须是 memory、doing、entity 或 relation');
        onlyKeys(entry, ['id', 'kind', 'pool', 'expectedVersion', 'text', 'hooks', 'tags', 'entities', 'aliases', 'project', 'sources', 'status',
          'from', 'to', 'rel', 'note', 'recordedAt', 'occurredAt', 'sourceNature', 'statementType'], 'entries 条目');
        statement(entry, 'A2');
      }
      const { action, ...submission } = args;
      return store.submitSelfReview(submission);
    },
    memory_core(input) {
      const args = object(input);
      onlyKeys(args, ['requestId', 'id', 'expectedVersion', 'action', 'reason', 'category']);
      return store.setCore(args);
    },
    memory_core_write(input) {
      const args = object(input);
      onlyKeys(args, ['requestId', 'id', 'expectedVersion', 'kind', 'text', 'from', 'to', 'rel', 'note',
        'statementType', 'inference', 'sources', 'reason', 'category', 'dependencyEntries', 'hooks', 'aliases', 'tags', 'entities']);
      return store.assertCore(args);
    },
    memory_correct(input) {
      const args = object(input);
      onlyKeys(args, ['requestId', 'targets', 'status', 'reason', 'sources', 'changeType', 'replacement']);
      return store.applyCorrection(args);
    },
    memory_a3_write(input) {
      const args = object(input);
      for (const key of ['kind', 'pool', 'depth', 'evidenceStatus', 'sourceNature', 'currentValidity', 'sources', 'sourceEntries']) {
        if (Object.hasOwn(args, key)) throw new TypeError(`${key} 不能由 A3 调用方设置；A3 只引用 A2 且固定 derived_only`);
      }
      onlyKeys(args, ['requestId', 'id', 'expectedVersion', 'action', 'reason', 'text', 'body', 'derivedFrom', 'coverage', 'statementType',
        'hooks', 'tags', 'occurredAt']);
      if (args.action === 'write') statement(args, 'A3');
      return store.writeA3(args);
    },
    memory_a3_list(input) { return search({ ...object(input), pool: 'a3', type: 'a3', q: '' }, 'memory_a3_list'); },
    memory_a3_read: readA3,
    memory_a2_review_queue(input) {
      const args = object(input);
      onlyKeys(args, ['limit', 'offset']);
      return store.listA2ReviewQueue({ limit: integer(args.limit, 4, 'limit', 1, 20), offset: integer(args.offset, 0, 'offset', 0, Number.MAX_SAFE_INTEGER) });
    },
    memory_a2_review(input) {
      const args = object(input);
      onlyKeys(args, ['requestId', 'items', 'reason']);
      return store.reviewA2(args);
    },
    memory_a2_cleanup(input) {
      const args = object(input);
      onlyKeys(args, ['apply']);
      if (args.apply !== undefined && typeof args.apply !== 'boolean') throw new TypeError('apply 必须是布尔值');
      return store.retireA2({ apply: args.apply ?? false });
    },
    memory_preference(input) {
      const args = object(input);
      for (const key of ['pool', 'kind', 'sourceNature']) if (Object.hasOwn(args, key)) throw new TypeError(`${key} 由系统固定；B3 记录自身或 C 第一跳主体的明确自述`);
      onlyKeys(args, ['requestId', 'id', 'expectedVersion', 'action', 'topic', 'stance', 'text', 'reason', 'sources', 'subject',
        'expressionKind', 'target', 'declaration', 'dependencyEntries']);
      return store.setPreference(args);
    },
    memory_b2_write(input) {
      const args = object(input);
      for (const key of ['kind', 'pool', 'evidenceStatus', 'sourceNature', 'currentValidity', 'createdAt', 'expiresAt', 'externalSources']) {
        if (Object.hasOwn(args, key)) throw new TypeError(`${key} 由系统固定；B2 外部引用有14天期限且不视为已验证原文`);
      }
      onlyKeys(args, ['requestId', 'id', 'expectedVersion', 'action', 'text', 'judgment', 'reason', 'sources', 'hooks', 'tags']);
      return store.writeB2(args);
    },
    memory_dict() { return getDictionary(store); },
  };
}

export function getDictionary(store) {
  const path = store.safePath('dict/v5.md');
  return { version: 'v5', moduleVersion: '0.5.0', text: readFileSync(path, 'utf8'), format: 'plain_chinese',
    note: '使用短中文；字典不把摘要转换成原始证据。' };
}
