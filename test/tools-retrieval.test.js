import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTimeQuery, localDayStart } from '../lib/retrieval.js';
import { createTools } from '../lib/tools.js';

function apiFor(entries = [], raws = []) {
  const calls = [];
  const store = {
    timezone: 'Asia/Shanghai', now: () => new Date('2026-10-20T04:00:00Z'),
    listEntries: options => { calls.push(options); return entries; }, listRaw: () => raws,
    getRaw: id => raws.find(raw => raw.id === id) ?? null,
    getEntry: (id, options = {}) => entries.find(entry => entry.id === id && (!options.version || entry.version === options.version)) ?? null,
    recordRecall() {},
  };
  return { api: createTools(store), store, calls };
}

test('last_week resolves the previous local Mon–Sun, including Sunday/Monday and year boundaries', () => {
  const query = asOf => resolveTimeQuery({ timeWindow: { preset: 'last_week', asOf } }, { timeZone: 'Asia/Shanghai' }).resolvedTime;
  const monday = query('2026-10-18T16:00:00Z');
  assert.equal(monday.localStartDate, '2026-10-12');
  assert.equal(monday.localEndDateExclusive, '2026-10-19');
  assert.equal(monday.start, '2026-10-11T16:00:00.000Z');
  assert.equal(monday.endExclusive, '2026-10-18T16:00:00.000Z');
  assert.equal(query('2026-10-18T15:59:59.999Z').localStartDate, '2026-10-05');
  assert.equal(query('2026-01-01T04:00:00Z').localStartDate, '2025-12-22');
  assert.equal(monday.interval, '[start,endExclusive)');
});

test('local natural weeks respect DST while recent_7_days remains exactly 168 hours', () => {
  const query = (preset, asOf) => resolveTimeQuery({ timeWindow: { preset, asOf, timeZone: 'America/New_York' } }).resolvedTime;
  const spring = query('last_week', '2026-03-09T16:00:00Z');
  assert.equal(spring.start, '2026-03-02T05:00:00.000Z');
  assert.equal(spring.endExclusive, '2026-03-09T04:00:00.000Z');
  assert.equal((Date.parse(spring.endExclusive) - Date.parse(spring.start)) / 3600000, 167);
  const autumn = query('last_week', '2026-11-02T17:00:00Z');
  assert.equal((Date.parse(autumn.endExclusive) - Date.parse(autumn.start)) / 3600000, 169);
  const rolling = query('recent_7_days', '2026-03-09T04:00:00Z');
  assert.equal((Date.parse(rolling.endExclusive) - Date.parse(rolling.start)) / 3600000, 168);
  assert.equal(rolling.start, '2026-03-02T04:00:00.000Z');
  assert.equal(localDayStart('2026-03-09', 'America/New_York'), Date.parse('2026-03-09T04:00:00Z'));
});

test('explicit dates retain inclusive-date semantics and invalid/conflicting windows fail rather than widen', () => {
  const query = resolveTimeQuery({ date: '2026-03-08', timeAxis: 'occurred' }, { timeZone: 'America/New_York' });
  assert.equal(query.resolvedTime.start, '2026-03-08T05:00:00.000Z');
  assert.equal(query.resolvedTime.endExclusive, '2026-03-09T04:00:00.000Z');
  for (const input of [
    { date: '2026-02-30' }, { timeWindow: { preset: 'week' } },
    { date: '2026-10-12', timeWindow: { preset: 'last_week' } },
    { from: '2026-10-12', timeWindow: { preset: 'recent_7_days' } },
    { timeWindow: { preset: 'last_week', timeZone: 'Not/A_Zone' } },
    { timeWindow: { preset: 'last_week', asOf: '2026-10-20' } },
    { timeWindow: { preset: 'last_week', widen: true } },
    { from: '2026-10-20', to: '2026-10-19' },
    { from: '2026-10-20T24:00:00Z' }, { timeAxis: 'created' },
  ]) assert.throws(() => resolveTimeQuery(input), TypeError);
});

test('A3 retained conversation times remain searchable without A1/A2 bodies; missing occurrence is never invented', () => {
  const archive = { id: 'installed-comfy', kind: 'a3', pool: 'a3', version: 1, status: 'active',
    text: '用户明确说给肥鱼装好了 ComfyUI。', body: { time: '用户于10月13日提及，实际安装时间未说明', persons: ['用户', '肥鱼'], event: '用户说已安装 ComfyUI' },
    recordedAt: '2026-10-20T04:00:00Z', occurredAt: null, statementType: 'self_report',
    mentionedTimes: ['2026-10-13T03:00:00Z'], sourceTimes: [{ rawId: 'gone-raw', sessionId: 'gone-session', recordedAt: '2026-10-13T03:00:00Z', occurredAt: null }],
    sourceEntries: [{ id: 'gone-parent', version: 2 }], derivedFrom: ['gone-parent'], sources: [] };
  const { api, calls } = apiFor([archive]);
  const args = { pool: 'a3', timeWindow: { preset: 'last_week' } };
  const mentioned = api.memory_search({ ...args, timeAxis: 'mentioned' });
  assert.equal(mentioned.total, 1);
  assert.deepEqual(mentioned.candidates[0].matchedTimeAxes, ['mentioned']);
  assert.equal(mentioned.resolvedTime.asOf, '2026-10-20T04:00:00.000Z');
  assert.equal(mentioned.resolvedTime.timeZone, 'Asia/Shanghai');
  assert.equal(mentioned.candidates[0].occurredAt, null);
  assert.equal(api.memory_search({ ...args, timeAxis: 'recorded' }).total, 0);
  const occurrence = api.memory_search({ ...args, timeAxis: 'occurred' });
  assert.equal(occurrence.total, 0);
  assert.equal(occurrence.unknownTimeExcluded, 1);
  assert.equal(occurrence.automaticWidening, false);
  assert.equal(calls.at(-1).includeHistory, true);
  api.memory_search({ ...args, timeAxis: 'mentioned', includeHistory: false });
  assert.equal(calls.at(-1).includeHistory, false);
  const read = api.memory_a3_read('installed-comfy');
  assert.equal(read.parents[0].found, false);
  assert.deepEqual(read.body, archive.body);
  assert.deepEqual(read.mentionedTimes, archive.mentionedTimes);
});

test('subject/topic/event queries impose no hidden time window and known aliases remain explicit', () => {
  const entries = [
    { id: 'mei', kind: 'entity', pool: 'c', text: '小梅', hooks: ['小梅'], aliases: ['阿梅'], version: 1 },
    { id: 'old-relationship', kind: 'a3', pool: 'a3', text: '小梅第一次认真听肥鱼说话。', version: 1,
      body: { persons: ['小梅', '肥鱼'], event: '第一次被认真倾听', time: '很久以前，具体时间不明' }, occurredAt: null, recordedAt: '2020-01-01T00:00:00Z' },
    { id: 'pref-self', kind: 'preference', pool: 'b3', text: '我喜欢小梅推荐的音乐。', subject: 'self', topic: '音乐', scopeEligible: true, version: 1 },
    { id: 'pref-mei', kind: 'preference', pool: 'b3', text: '小梅说喜欢音乐。', subject: 'mei', topic: '音乐', scopeEligible: false, version: 1 },
  ];
  const { api } = apiFor(entries);
  const result = api.memory_search({ pool: 'a3', subject: '阿梅', eventKeywords: '倾听' });
  assert.deepEqual(result.candidates.map(item => item.id), ['old-relationship']);
  assert.equal(result.resolvedTime, null);
  assert.equal(result.effectiveFilters.subject, '阿梅');
  assert.equal(result.candidates[0].occurredAt, null);
  assert.deepEqual(api.memory_list({ pool: 'b3', subject: '阿梅', topic: '音乐' }).candidates.map(item => item.id), ['pref-mei']);
  assert.deepEqual(api.memory_list({ pool: 'b3', scopeEligible: true }).candidates.map(item => item.id), ['pref-self']);
  assert.equal(api.memory_search({ pool: 'a3', eventKeywords: '火星旅行' }).total, 0);
  assert.throws(() => api.memory_search({ eventKeywords: '???' }), /eventKeywords/);
  assert.throws(() => api.memory_search({ timeWindow: { preset: 'last_week' }, automaticWidening: true }), /不支持/);
});

test('legacy reads preserve inferred/unspecified meanings, deriving mention time only from surviving originals', () => {
  const original = { id: 'old-source', pool: 'a', role: 'user', text: '原话', recordedAt: '2026-10-13T00:00:00Z' };
  const entries = [
    { id: 'legacy-parent', kind: 'memory', pool: 'a2', text: '旧记忆', version: 1, recordedAt: '2026-10-19T00:00:00Z', sources: [{ rawId: 'old-source', quote: '原话' }] },
    { id: 'legacy-a3', kind: 'a3', pool: 'a3', text: '旧推断', version: 1, recordedAt: '2026-10-20T00:00:00Z',
      statementType: 'inference', inference: { reasoning: '旧版的推理', uncertainty: '不能确认' }, sourceEntries: [{ id: 'legacy-parent', version: 1 }], sources: [] },
    { id: 'no-source', kind: 'memory', text: '来源已经不可得', version: 1, recordedAt: '2026-10-13T00:00:00Z', sources: [{ rawId: 'missing', quote: '原话' }] },
  ];
  const { api } = apiFor(entries, [original]);
  const read = api.memory_a3_read('legacy-a3');
  assert.equal(read.statementType, 'inference');
  assert.equal(read.legacyStatement, true);
  assert.equal(read.checks.supportJudgment.status, 'derived_only');
  assert.match(read.checks.supportJudgment.note, /旧版/);
  assert.deepEqual(read.mentionedTimes, [original.recordedAt]);
  assert.equal(api.memory_read('legacy-parent').statementType, 'legacy_unspecified');
  assert.equal(api.memory_search({ pool: 'a3', timeAxis: 'mentioned', date: '2026-10-13' }).total, 1);
  assert.equal(api.memory_search({ q: '来源已经不可得', timeAxis: 'mentioned', date: '2026-10-13' }).total, 0);
});

test('new time/dependency/correction metadata is paged and bounded rather than copying stored payloads', () => {
  const dates = Array.from({ length: 30 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}T00:00:00Z`);
  const record = { id: 'large-meta', kind: 'a3', pool: 'a3', version: 1, text: '原文不能在元数据中重复展开', mentionedTimes: dates,
    sourceTimes: dates.map((recordedAt, i) => ({ rawId: `raw-${i}`, recordedAt, text: 'SHOULD_NOT_LEAK'.repeat(5000) })),
    dependencyEntries: dates.map((_, i) => ({ id: `parent-${i}`, version: 1, text: 'SHOULD_NOT_LEAK' })),
    correctness: { status: 'disputed', events: dates.map((decidedAt, i) => ({ requestId: `correction-${i}`, decidedAt, reason: 'x'.repeat(5000), text: 'SHOULD_NOT_LEAK' })), eventCount: 30 } };
  const { api } = apiFor([record]);
  const read = api.memory_read({ id: record.id, metadataOffset: 5, metadataLimit: 2, limit: 1 });
  assert.equal(read.mentionedTimes.length, 2);
  assert.equal(read.mentionedTimes[0], dates[5]);
  assert.equal(read.sourceTimes[0].rawId, 'raw-5');
  assert.equal(read.dependencyEntries[0].id, 'parent-5');
  assert.equal(read.correctness.events[0].requestId, 'correction-5');
  assert.equal(read.correctness.events[0].reason.length, 2000);
  assert.equal(read.correctness.eventsPage.nextOffset, 7);
  assert.equal(read.metadataTruncated, true);
  assert.ok(JSON.stringify(read).length < 12000);
  assert.ok(!JSON.stringify(read).includes('SHOULD_NOT_LEAK'));
  assert.throws(() => api.memory_read({ id: record.id, metadataLimit: 11 }), /metadataLimit/);
});

test('model A2/A3 entries require explicit statement nature and forbid inferred writes; dedicated routes remain separate', () => {
  const { api, store } = apiFor();
  let writes = 0;
  store.writeEntry = () => { writes++; throw new Error('not expected'); };
  assert.throws(() => api.memory_write({ kind: 'memory', text: '明确声明缺失' }), /statementType/);
  assert.throws(() => api.memory_write({ kind: 'memory', statementType: 'inference', text: '猜测' }), /statementType/);
  assert.throws(() => api.memory_review({ action: 'submit', requestId: 'r', rawIds: ['r'], reason: 'r', entries: [{ kind: 'memory', text: '缺少声明' }] }), /statementType/);
  assert.throws(() => api.memory_a3_write({ action: 'write', statementType: 'inference' }), /statementType/);
  assert.equal(writes, 0);
  const calls = [];
  store.assertCore = input => { calls.push(input); return { committed: true }; };
  store.applyCorrection = input => { calls.push(input); return { committed: true }; };
  store.requestEarlyReview = input => { calls.push(input); return { committed: true }; };
  const core = { requestId: 'c', id: 'e', expectedVersion: 0, kind: 'entity', text: '明确标记的关系网推断', statementType: 'inference', inference: { reasoning: '依据', uncertainty: '不确定' }, reason: '保留推断', category: 'identity' };
  api.memory_core_write(core);
  api.memory_correct({ requestId: 'fix', targets: [{ id: 'e', version: 1 }], changeType: 'state_change', reason: '现在变化了', sources: [{ rawId: 'source', quote: '原话' }] });
  api.memory_review_request({ requestId: 'early', rawIds: ['important-once'], reason: '一次性的关键变化' });
  assert.equal(calls[0].statementType, 'inference');
  assert.equal(calls[1].status, undefined);
  assert.deepEqual(calls[2].rawIds, ['important-once']);
});
