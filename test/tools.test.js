import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../lib/store.js';
import { createTools } from '../lib/tools.js';

function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'feiyu-tools-'));
  const store = new MemoryStore({ dataDir, instanceId: 'tools-test', timezone: 'Asia/Shanghai', now: () => new Date('2026-10-16T12:00:00.000Z') });
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return { store, tools: createTools(store) };
}

function raw(store, id, text, fields = {}) {
  return store.appendRaw({ id, text, sessionId: 'test-session', role: 'user', pool: 'a', ...fields });
}

test('raw fallback finds Chinese details without distilled entries or an index', t => {
  const { store, tools } = fixture(t);
  raw(store, 'raw-cat', '今天清理了猫砂盆，买的型号是鱼形三号。');
  raw(store, 'raw-dog', '下午带狗散步。');
  const result = tools.memory_search({ q: '猫砂盆' });
  assert.deepEqual(result.candidates.map(x => x.id), ['raw-cat']);
  assert.equal(result.candidates[0].kind, 'raw');
  assert.equal(result.candidates[0].evidenceStatus, 'original_record');
  assert.equal(result.scannedCount, 2);
});

test('explicit entity aliases expand queries without writing inferred aliases', t => {
  const { store, tools } = fixture(t);
  raw(store, 'raw-fish', '肥鱼今天讨论了记忆模块。', { entities: ['肥鱼'], project: 'memory' });
  raw(store, 'raw-other', '另一个项目没有这一段。', { project: 'other' });
  tools.memory_write({ statementType: 'fact', id: 'entity-fish', kind: 'entity', text: '人工录入的称呼映射', hooks: ['肥鱼'], aliases: ['小鱼'], sources: [] });
  assert.ok(tools.memory_search({ q: '小鱼' }).candidates.some(x => x.id === 'raw-fish'));
  assert.deepEqual(tools.memory_list({ entity: '小鱼', project: 'memory' }).candidates.map(x => x.id), ['raw-fish']);
  assert.deepEqual(store.getEntry('entity-fish').aliases, ['小鱼']);
});

test('both date axes work, including old events recorded later and local midnight', t => {
  const { store, tools } = fixture(t);
  raw(store, 'raw-old-event', '这件事发生在去年冬天。', { occurredAt: '2025-12-20T12:00:00.000Z' });
  raw(store, 'raw-local-next', '北京时间次日记录。', { recordedAt: '2026-10-16T16:30:00.000Z' });
  assert.deepEqual(tools.memory_search({ from: '2025-12-01', to: '2025-12-31' }).candidates.map(x => x.id), ['raw-old-event']);
  assert.equal(tools.memory_search({ from: '2025-12-01', to: '2025-12-31', timeAxis: 'recorded' }).total, 0);
  assert.equal(tools.memory_search({ from: '2025-12-01', to: '2025-12-31', timeAxis: 'occurred' }).total, 1);
  assert.deepEqual(tools.memory_list({ date: '2026-10-17', timeAxis: 'recorded' }).candidates.map(x => x.id), ['raw-local-next']);
});

test('emotion and theme tags only rank; structural role filters still filter', t => {
  const { store, tools } = fixture(t);
  raw(store, 'raw-tagged', '猫砂盆换好了。', { tags: ['情绪:高兴'] });
  raw(store, 'raw-plain', '猫砂盆放在门口。', { role: 'assistant' });
  const result = tools.memory_search({ q: '猫砂盆 情绪:高兴' });
  assert.equal(result.total, 2);
  assert.equal(result.candidates[0].id, 'raw-tagged');
  assert.equal(tools.memory_search({ q: '情绪:高兴' }).total, 2);
  assert.equal(tools.memory_search({ type: '情绪:高兴' }).total, 2);
  assert.deepEqual(tools.memory_search({ type: 'assistant' }).candidates.map(x => x.id), ['raw-plain']);
});

test('candidates stay short and pagination is deterministic', t => {
  const { store, tools } = fixture(t);
  for (let i = 0; i < 5; i++) raw(store, `raw-${i}`, `猫砂盆 ${'🐟'.repeat(100)} ${i}`);
  const page1 = tools.memory_search({ q: '猫砂盆', limit: 2 });
  const page2 = tools.memory_search({ q: '猫砂盆', limit: 2, offset: 2 });
  assert.equal(page1.hasMore, true);
  assert.equal(new Set([...page1.candidates, ...page2.candidates].map(x => x.id)).size, 4);
  for (const candidate of page1.candidates) {
    assert.ok(candidate.snippet.length <= 100);
    assert.ok(!/[\uD800-\uDBFF]…$/u.test(candidate.snippet));
    assert.equal(candidate.currentValidity, 'unknown');
  }
  tools.memory_write({ statementType: 'fact', id: 'memory-preview', kind: 'memory', text: '猫砂盆', hooks: Array.from({ length: 12 }, (_, i) => `${i}${'长钩子'.repeat(100)}`),
    sources: Array.from({ length: 8 }, () => ({ rawId: 'raw-0', quote: '猫砂盆' })) });
  const preview = tools.memory_search({ type: 'memory' }).candidates[0];
  assert.equal(preview.hooks.length, 4);
  assert.ok(preview.hooks.every(hook => hook.length <= 40));
  assert.equal(preview.sourceIds.length, 4);
  assert.equal(preview.sourceCount, 8);
});

test('reading exact conditional quotes never confirms the proposed fact or current status', t => {
  const { store, tools } = fixture(t);
  raw(store, 'raw-hypothesis', '如果我中了800万，我就买房。');
  const entry = tools.memory_write({ statementType: 'fact', id: 'memory-hypothesis', kind: 'memory', text: '用户中了800万', hooks: ['800万'], sources: [{ rawId: 'raw-hypothesis', quote: '中了800万', support: 'supports' }] });
  const first = tools.memory_read('memory-hypothesis');
  const second = tools.memory_read('memory-hypothesis');
  assert.equal(first.checks.quoteLocation.status, 'exact_matches_only');
  assert.equal(first.checks.supportJudgment.status, 'not_independently_verified');
  assert.equal(first.evidence[0].supportJudgment.declared, 'supports');
  assert.equal(first.evidence[0].originalId, 'raw-hypothesis');
  assert.equal(first.originals.length, 1);
  assert.equal(first.originals[0].text, undefined);
  assert.equal(tools.memory_read(first.originals[0].read).text, '如果我中了800万，我就买房。');
  assert.equal(first.checks.currentValidity.status, 'unknown');
  assert.equal(first.independentSourceCount, null);
  assert.equal(second.version, entry.version);
  assert.equal(store.getEntry(entry.id).version, entry.version);
});

test('same-origin repeats remain same-origin, assistant originals are source-limited', t => {
  const { store, tools } = fixture(t);
  raw(store, 'raw-assistant', '建议尝试短中文。', { role: 'assistant', sourceRoot: 'same-origin', sourceNature: 'assistant_statement' });
  raw(store, 'raw-echo', '建议尝试短中文。', { role: 'tool', sourceRoot: 'same-origin', sourceNature: 'tool_echo' });
  tools.memory_write({ statementType: 'fact', id: 'memory-repeat', kind: 'memory', text: '短中文方案', hooks: ['短中文'], sources: [
    { rawId: 'raw-assistant', quote: '短中文' }, { rawId: 'raw-echo', quote: '短中文' },
  ] });
  const result = tools.memory_read('memory-repeat');
  assert.equal(result.checks.sourceNature.independence, 'known_same_origin');
  assert.equal(result.independentSourceCount, null);
  assert.equal(tools.memory_read('raw-assistant').checks.sourceNature.role, 'assistant');
  assert.equal(tools.memory_read('raw-assistant').checks.supportJudgment.status, 'unassessed');
});

test('retained originals remain discoverable after leaving the seven-day raw pool', t => {
  const { store, tools } = fixture(t);
  raw(store, 'raw-rescued', '过去的冷门细节：蓝色杯沿。', { recordedAt: '2026-10-01T12:00:00.000Z' });
  store.reviewRetention({ ids: ['raw-rescued'], decision: 'retain', reason: '管理员明确保留完整原文' });
  store.slide({ apply: true });
  assert.equal(tools.memory_search({ q: '蓝色杯沿' }).candidates[0].id, 'raw-rescued');
  assert.equal(tools.memory_read('raw-rescued').text, '过去的冷门细节：蓝色杯沿。');
});

test('model write cannot fabricate original capture or authorize retention deletion', t => {
  const { tools } = fixture(t);
  assert.throws(() => tools.memory_write({ statementType: 'fact', kind: 'raw', text: '假的原文' }), /原文/);
  assert.throws(() => tools.memory_write({ statementType: 'fact', kind: 'retention_review', decision: 'discard' }), /管理员/);
  const noEvidence = tools.memory_write({ statementType: 'fact', kind: 'memory', text: '待核实的人工笔记', hooks: ['待核实'], sources: [] });
  assert.equal(noEvidence.evidenceStatus, 'unverified');
});

test('search validates dates, argument bounds, and ambiguous input', t => {
  const { tools } = fixture(t);
  assert.throws(() => tools.memory_search({ from: '../archive' }), /from/);
  assert.throws(() => tools.memory_search({ from: '2026-02-30' }), /有效日期/);
  assert.throws(() => tools.memory_search({ from: '2026-10-18', to: '2026-10-16' }), /晚于/);
  assert.throws(() => tools.memory_search({ from: '2026-10-18', to: '2026-10-16T12:00:00Z' }), /晚于/);
  assert.throws(() => tools.memory_search({ from: '2026-10-16T24:00:00Z' }), /有效时间/);
  assert.throws(() => tools.memory_search({ limit: 21 }), /limit/);
  assert.throws(() => tools.memory_search({ offset: -1 }), /offset/);
  assert.throws(() => tools.memory_search({ timeAxis: 'guessed' }), /timeAxis/);
  assert.throws(() => tools.memory_list({ date: '2026-10-16', from: '2026-10-15' }), /不能/);
});

test('recall logs contain identifiers and timing, never query or raw text', t => {
  const { store, tools } = fixture(t);
  raw(store, 'raw-private', '唯一隐私查询词对应的原文。');
  const logs = [];
  store.recordRecall = event => logs.push(event);
  tools.memory_search({ q: '唯一隐私查询词' });
  tools.memory_read('raw-private');
  assert.equal(logs.length, 2);
  assert.ok(!JSON.stringify(logs).includes('唯一隐私查询词'));
  assert.deepEqual(logs[0].candidateIds, ['raw-private']);
  assert.ok(Number.isFinite(logs[0].durationMs));
  assert.equal(logs[1].id, 'raw-private');
});

test('raw reading pages exact text without silent clipping or unbounded output', t => {
  const { store, tools } = fixture(t);
  const text = ('首行\n空格  🐟\r\n').repeat(900);
  raw(store, 'raw-paged', text);
  const first = tools.memory_read('raw-paged');
  assert.equal(first.text.length, 4000);
  assert.equal(first.truncated, true);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextOffset, 4000);
  assert.equal(first.textPage.totalChars, text.length);
  assert.equal(first.textPage.offsetUnit, 'utf16_code_units');
  let reconstructed = '', offset = 0;
  do {
    const page = tools.memory_read({ id: 'raw-paged', offset, limit: 997 });
    assert.ok(page.text.length <= 997);
    reconstructed += page.text;
    offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(reconstructed, text);
  const beyond = tools.memory_read({ id: 'raw-paged', offset: text.length + 50 });
  assert.equal(beyond.text, '');
  assert.equal(beyond.hasMore, false);
  assert.throws(() => tools.memory_read({ id: 'raw-paged', limit: 16001 }), /limit/);
  assert.throws(() => tools.memory_read({ id: 'raw-paged', evidenceLimit: 11 }), /evidenceLimit/);
});

test('entry text, metadata and repeated long evidence are bounded with original references', t => {
  const { store, tools } = fixture(t);
  const quote = '长期原始引文'.repeat(5000);
  raw(store, 'raw-large', `开头\n${quote}\n结尾`);
  const largeValues = Array.from({ length: 100 }, (_, i) => `${i}${'长'.repeat(990)}`);
  store.writeEntry({ id: 'entry-large', kind: 'memory', text: '正文'.repeat(100000), hooks: largeValues, tags: largeValues,
    entities: largeValues, aliases: largeValues, legacy: { text: '旧数据'.repeat(100000) }, sourceNature: '原'.repeat(1900), project: '项'.repeat(1900),
    sources: Array.from({ length: 100 }, () => ({ rawId: 'raw-large', quote })) });
  const result = tools.memory_read({ id: 'entry-large' });
  assert.ok(JSON.stringify(result).length < 30000);
  assert.equal(result.text.length, 4000);
  assert.equal(result.metadataTruncated, true);
  assert.equal(result.legacyPresent, true);
  assert.equal(result.legacy, undefined);
  assert.equal(result.fieldCounts.hooks, 100);
  assert.equal(result.hooks.length, 8);
  assert.equal(result.evidence.length, 4);
  assert.equal(result.originals.length, 1);
  assert.equal(result.originals[0].text, undefined);
  assert.equal(result.evidence[0].quote.length, 1000);
  assert.equal(result.evidence[0].quoteTruncated, true);
  assert.equal(result.evidence[0].quoteLength, quote.length);
  assert.equal(result.evidencePage.nextOffset, 4);
  assert.equal(result.evidencePage.total, 100);
  assert.equal(result.checks.quoteLocation.scope, 'current_evidence_page');
  const next = tools.memory_read({ id: 'entry-large', evidenceOffset: result.evidencePage.nextOffset, evidenceLimit: 10, limit: 16000 });
  assert.ok(JSON.stringify(next).length < 60000);
  assert.equal(next.evidence[0].sourceIndex, 4);
  assert.equal(next.evidence.length, 10);
  const navigation = result.evidence[0].quoteLocation.read;
  let recovered = '', offset = navigation.offset;
  while (recovered.length < quote.length) {
    const page = tools.memory_read({ ...navigation, offset, limit: Math.min(16000, quote.length - recovered.length) });
    recovered += page.text; offset += page.text.length;
  }
  assert.equal(recovered, quote);
  const withoutEvidence = tools.memory_read({ id: 'entry-large', evidenceLimit: 0 });
  assert.deepEqual(withoutEvidence.evidence, []);
  assert.deepEqual(withoutEvidence.originals, []);
  assert.equal(withoutEvidence.evidencePage.hasMore, true);
});

test('temporal search/list finds historical versions while ordinary search defaults to latest', t => {
  const { store, tools } = fixture(t);
  store.writeEntry({ id: 'doing-history', kind: 'doing', text: '早期独有线索：琥珀铃铛', hooks: ['琥珀铃铛'], sources: [], status: 'active', recordedAt: '2026-10-01T10:00:00Z' });
  store.writeEntry({ id: 'doing-history', kind: 'doing', text: '后来改成红色杯盖', hooks: ['红色杯盖'], sources: [], status: 'done', recordedAt: '2026-10-16T10:00:00Z' });
  assert.equal(tools.memory_search({ q: '琥珀铃铛' }).total, 0);
  const historical = tools.memory_search({ q: '琥珀铃铛', from: '2026-10-01', to: '2026-10-01', timeAxis: 'recorded' });
  assert.equal(historical.includeHistory, true);
  assert.equal(historical.candidates[0].version, 1);
  assert.equal(tools.memory_read({ id: historical.candidates[0].id, version: historical.candidates[0].version }).status, 'active');
  assert.equal(tools.memory_list({ date: '2026-10-01', status: 'active', timeAxis: 'recorded' }).candidates[0].version, 1);
  assert.equal(tools.memory_search({ includeHistory: true }).candidates.filter(item => item.id === 'doing-history').length, 2);
  assert.equal(tools.memory_list({ type: 'doing', status: 'done' }).candidates[0].version, 2);
  assert.throws(() => tools.memory_search({ includeHistory: 'yes' }), /includeHistory/);
});
