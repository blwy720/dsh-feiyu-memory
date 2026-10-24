import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { MemoryStore } from '../lib/store.js';
import { createTools } from '../lib/tools.js';

function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'feiyu-a3-tools-'));
  const store = new MemoryStore({ dataDir, instanceId: 'synthetic-a3', timezone: 'Asia/Shanghai', now: () => new Date('2026-10-18T04:00:00Z') });
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const api = createTools(store);
  store.appendRaw({ id: 'original', pool: 'a', role: 'user', sessionId: 'synthetic', text: '如果中了800万，我才考虑买房。', recordedAt: '2026-09-01T00:00:00Z' });
  const source = { rawId: 'original', quote: '如果中了800万，我才考虑买房。', support: 'context_only' };
  api.memory_write({ statementType: 'fact', id: 'parent', kind: 'memory', text: '这段是关于中奖的条件假设。', sources: [source], recordedAt: '2026-09-02T00:00:00Z' });
  api.memory_write({ statementType: 'fact', id: 'other', kind: 'memory', text: '与该主题无关的另一条笔记。', sources: [], recordedAt: '2026-10-17T00:00:00Z' });
  const input = { requestId: 'a3-first', id: 'long-term', expectedVersion: 0, action: 'write', reason: '保留对条件陈述的重要限定', text: '原文讨论的是假设，没有确认中奖。', statementType: 'fact',
    body: { time: '2026年9月1日的对话；假设事件未发生', persons: ['用户'], event: '用户以中奖作为考虑买房的条件，并未报告中奖事实' },
    derivedFrom: ['parent'], coverage: { scope: [{ id: 'parent', version: 1 }, { id: 'other', version: 1 }], covered: ['parent'],
      notCovered: [{ id: 'other', reason: '这条属于另一主题，需另行判断' }], scopeNote: '仅声明已经查看的两条笔记，不声称覆盖全库相关信息' } };
  return { store, api, input, source };
}

function singleCoverage(id, version = 1) {
  return { scope: [{ id, version }], covered: [id], notCovered: [], scopeNote: '本次仅审阅这一条明确来源' };
}

test('A3 tool preserves exact A2 provenance, declared omissions and immutable versions without claiming raw verification', t => {
  const { store, api, input, source } = fixture(t);
  const written = api.memory_a3_write(input);
  assert.equal(written.pool, 'a3');
  assert.equal(written.version, 1);
  assert.equal(api.memory_a3_write(input).duplicate, true);
  assert.equal(api.memory_archive, undefined);
  const read = api.memory_a3_read({ id: 'long-term' });
  assert.equal(read.kind, 'a3');
  assert.equal(read.depth, 2);
  assert.equal(read.evidenceStatus, 'derived_only');
  assert.equal(read.sourceNature, 'second_distillation');
  assert.equal(read.currentValidity, 'unknown');
  assert.equal(read.independentSourceCount, null);
  assert.equal(read.orphaned, false);
  assert.equal(read.lineageBroken, false);
  assert.equal(read.archiveDecision.action, 'write');
  assert.equal(read.archiveDecision.reason, input.reason);
  assert.equal(read.sourceEntryCount, 1);
  assert.deepEqual(read.derivedFrom, ['parent']);
  assert.match(read.sourceEntries[0].hash, /^[0-9a-f]{64}$/);
  assert.equal(read.sourceEntries[0].read.arguments.version, 1);
  assert.equal(read.checks.supportJudgment.status, 'derived_only');
  assert.equal(read.checks.quoteLocation.status, 'derived_only');
  assert.deepEqual(read.sources, []);
  assert.equal(read.parents[0].snippet, '这段是关于中奖的条件假设。');
  assert.equal(read.parents[0].rawSourceCount, 1);
  assert.equal(read.parents[0].rawSources[0].read.arguments.id, 'original');
  assert.equal(read.parents[0].rawSources[0].quote, undefined);
  assert.equal(read.coverage.notCovered[0].reason, input.coverage.notCovered[0].reason);
  assert.deepEqual(api.memory_search({ pool: 'a3', q: '假设' }).candidates.map(item => item.id), ['long-term']);
  assert.equal(api.memory_list({ type: 'a3' }).candidates[0].evidenceStatus, 'derived_only');
  assert.equal(api.memory_read({ id: 'long-term', kind: 'a3', pool: 'a3' }).kind, 'a3');
  assert.equal(api.memory_read({ id: 'long-term', pool: 'a2' }), null);
  assert.equal(store.getEntry('parent').version, 1);
  api.memory_write({ statementType: 'fact', id: 'parent', kind: 'memory', expectedVersion: 1, text: '父条目补充了新的表述。', sources: [source] });
  assert.equal(api.memory_read(read.sourceEntries[0].read.arguments).text, '这段是关于中奖的条件假设。');
  assert.equal(api.memory_a3_read('long-term').sourceChanged, true);
  const updated = api.memory_a3_write({ ...input, requestId: 'a3-update', expectedVersion: 1,
    coverage: { ...input.coverage, scope: [{ id: 'parent', version: 2 }, { id: 'other', version: 1 }] } });
  assert.equal(updated.version, 2);
  const revoked = api.memory_a3_write({ requestId: 'a3-revoke', id: 'long-term', expectedVersion: 2, action: 'revoke', reason: '暂不作为当前长期关键资料' });
  assert.equal(revoked.status, 'archived');
  assert.equal(api.memory_a3_list({ status: 'active' }).total, 0);
  assert.equal(api.memory_a3_list({ status: 'archived' }).total, 1);
  assert.equal(api.memory_a3_read({ id: 'long-term', version: 1 }).sourceEntries[0].version, 1);
  assert.equal(api.memory_review({ action: 'history', id: 'long-term' }).total, 3);
  assert.ok(store.getRaw('original'));
});

test('A3 tools reject raw/A3 input, evidence overrides, incomplete coverage and implicit inference', t => {
  const { store, api, input, source } = fixture(t);
  assert.throws(() => api.memory_a3_write({ ...input, derivedFrom: ['original'], coverage: singleCoverage('original') }), /A2|scope|parent/i);
  assert.throws(() => api.memory_a3_write({ ...input, coverage: undefined }), /coverage/i);
  assert.throws(() => api.memory_a3_write({ ...input, coverage: { ...input.coverage, notCovered: [] } }), /coverage|scope|cover/i);
  for (const extra of [{ sources: [] }, { evidenceStatus: 'quote_verified' }, { depth: 3 }, { pool: 'a3' }]) {
    assert.throws(() => api.memory_a3_write({ ...input, ...extra }), /调用方/);
  }
  assert.equal(store.getEntry('long-term'), null);
  api.memory_a3_write(input);
  assert.throws(() => api.memory_a3_write({ ...input, id: 'a4', requestId: 'a4', derivedFrom: ['long-term'], coverage: singleCoverage('long-term') }), /A2|scope|parent/i);
  assert.throws(() => api.memory_write({ statementType: 'fact', kind: 'a3', text: '绕过专属入口' }), /memory_a3_write/);
  assert.throws(() => api.memory_write({ statementType: 'fact', id: 'long-term', kind: 'memory', text: '覆盖已有 A3' }), /A3|a3|kind|archive/i);
  assert.throws(() => api.memory_review({ action: 'submit', requestId: 'a3-via-review', rawIds: ['original'], reason: '不能绕过A3来源与覆盖约束',
    entries: [{ id: 'bypass-a3', kind: 'a3', pool: 'a3', text: '错误入口', sources: [source] }] }), /kind|A3|pool/i);
  assert.throws(() => api.memory_core({ requestId: 'a3-core', id: 'long-term', expectedVersion: 1, action: 'promote', category: 'identity', reason: '不能把A3送入C' }), /A2|entity|relation|graph/i);
  assert.throws(() => api.memory_graph({ pool: 'a3' }), /pool/);
  assert.throws(() => api.memory_a3_write({ ...input, id: 'inference', requestId: 'bad-inference', statementType: 'inference' }), /statementType/i);
  assert.throws(() => api.memory_a3_write({ ...input, id: 'summary-with-inference', requestId: 'bad-summary', inference: { reasoning: '推理', uncertainty: '不确定' } }), /inference|summary/i);
  assert.throws(() => api.memory_a3_write({ ...input, id: 'inference', requestId: 'good-inference', statementType: 'inference', inference: { reasoning: '这一条件句反映说话者在讨论一种可能性。', uncertainty: '单条陈述不足以概括长期倾向。' } }), /inference|statementType/i);
  assert.equal(store.getEntry('inference'), null);
});

test('A3 keeps lightweight parent lineage without requiring retained original bodies, while parent state stays visible', t => {
  const { store, api, input } = fixture(t);
  api.memory_a3_write({ ...input, derivedFrom: ['other'], coverage: singleCoverage('other') });
  const initial = api.memory_a3_read('long-term');
  assert.equal(initial.lineageBroken, false);
  assert.equal(initial.orphaned, false);
  assert.equal(initial.parents[0].rawSourceCount, 0);
  assert.equal(api.memory_a3_list({ lineageBroken: false, orphaned: false }).total, 1);
  api.memory_write({ statementType: 'fact', id: 'other', kind: 'memory', expectedVersion: 1, status: 'archived', text: '该笔记已归档', sources: [] });
  const orphan = api.memory_a3_read('long-term');
  assert.equal(orphan.orphaned, true);
  assert.equal(orphan.parents[0].found, true);
  assert.equal(orphan.parents[0].version, 1);
  assert.equal(api.memory_a3_list({ orphaned: true }).total, 1);
  store.audit();
  assert.equal(api.memory_read('long-term').evidenceStatus, 'derived_only');
  assert.throws(() => api.memory_a3_list({ orphaned: 'true' }), /布尔/);
});

test('A3 source and coverage pages bound summaries and reasons without expanding full parent bodies', t => {
  const { api, input, source } = fixture(t);
  const parents = [];
  for (let i = 0; i < 12; i++) {
    const id = `bounded-parent-${i}`;
    api.memory_write({ statementType: 'fact', id, kind: 'memory', text: 'LARGE_PARENT_BODY'.repeat(3000), sources: [source] });
    parents.push({ id, version: 1 });
  }
  api.memory_a3_write({ ...input, derivedFrom: parents.map(parent => parent.id),
    coverage: { scope: [...parents, { id: 'other', version: 1 }], covered: parents.map(parent => parent.id),
      notCovered: [{ id: 'other', reason: '单独的未覆盖笔记'.repeat(20) }], scopeNote: '仅本批次声明范围' } });
  const read = api.memory_a3_read({ id: 'long-term', limit: 10, sourceLimit: 2, coverageLimit: 2 });
  assert.equal(read.sourceEntryCount, 12);
  assert.equal(read.sourceEntries.length, 2);
  assert.equal(read.parents.length, 2);
  assert.equal(read.coveragePage.total, 13);
  assert.equal(read.coveragePage.notCoveredCount, 1);
  assert.equal(read.sourceEntriesPage.hasMore, true);
  assert.ok(read.parents.every(parent => parent.snippet.length <= 200));
  assert.ok(JSON.stringify(read).length < 10000);
  assert.ok(!JSON.stringify(read).includes('LARGE_PARENT_BODY'.repeat(20)));
  const next = api.memory_a3_read({ id: 'long-term', sourceOffset: read.sourceEntriesPage.nextOffset, sourceLimit: 10, coverageOffset: 12, coverageLimit: 1 });
  assert.equal(next.sourceEntries.length, 10);
  assert.equal(next.sourceEntriesPage.hasMore, false);
  assert.deepEqual(next.coverage.covered, []);
  assert.equal(next.coverage.notCovered[0].id, 'other');
  assert.equal(next.coveragePage.hasMore, false);
  assert.throws(() => api.memory_a3_read({ id: 'long-term', sourceLimit: 11 }), /sourceLimit/);
  assert.throws(() => api.memory_read({ id: 'long-term', coverageLimit: 11 }), /coverageLimit/);
});

test('A2 due cleanup requires explicit matching review; coverage alone never retires a parent', t => {
  const { store, api, input } = fixture(t);
  api.memory_write({ statementType: 'fact', id: 'other', kind: 'memory', expectedVersion: 1, text: '声明范围内但未纳入A3的过期笔记', sources: [], recordedAt: '2026-09-03T00:00:00Z' });
  input.coverage.scope[1].version = 2;
  assert.equal(api.memory_a2_review_queue().total, 2);
  assert.equal(api.memory_a2_review_queue().items[0].reviewed, false);
  api.memory_a3_write(input);
  const blocked = api.memory_a2_cleanup({ apply: true });
  assert.equal(blocked.retired, 0);
  assert.equal(blocked.pendingReview, 2);
  const review = { requestId: 'review-a2', items: [{ id: 'parent', version: 1, decision: 'archived', a3Ids: ['long-term'], reason: '已在A3保留关键限定' }], reason: '逐条确认过期笔记去向' };
  assert.equal(api.memory_a2_review(review).reviewed, 1);
  assert.equal(api.memory_a2_review(review).duplicate, true);
  assert.equal(api.memory_a2_review_queue().items[0].reviewed, true);
  assert.equal(api.memory_a2_cleanup().retired, 0);
  const applied = api.memory_a2_cleanup({ apply: true });
  assert.equal(applied.retired, 1);
  assert.equal(api.memory_a2_review_queue().total, 1);
  assert.equal(api.memory_a2_review_queue().items[0].id, 'other');
  assert.equal(api.memory_a2_review_queue().items[0].reviewed, false);
  assert.ok(!api.memory_list({ pool: 'a2' }).candidates.some(item => item.id === 'parent'));
  assert.ok(api.memory_list({ pool: 'a2', includeHistory: true }).candidates.some(item => item.id === 'parent' && item.retired === true));
  const parent = api.memory_read('parent');
  assert.equal(parent.retired, true);
  assert.equal(parent.retirement.decision, 'archived');
  assert.equal(parent.retirement.read.arguments.version, 1);
  const a3 = api.memory_a3_read('long-term');
  assert.equal(a3.orphaned, true);
  assert.equal(a3.lineageBroken, false);
  assert.equal(a3.parents[0].retired, true);
  assert.ok(store.getRaw('original'));
  assert.equal(api.memory_read('other').retired, undefined);
  assert.throws(() => api.memory_a2_cleanup({ apply: 'true' }), /布尔/);
});

test('A2 version changes invalidate cleanup approval and remain pending for a new explicit decision', t => {
  const { api, source } = fixture(t);
  api.memory_a2_review({ requestId: 'discard-old', items: [{ id: 'parent', version: 1, decision: 'discard', reason: '旧笔记暂不保留在活动池' }], reason: '明确审查这一个版本' });
  api.memory_write({ statementType: 'fact', id: 'parent', kind: 'memory', expectedVersion: 1, text: '新版仍需单独审核', sources: [source], recordedAt: '2026-09-03T00:00:00Z' });
  assert.equal(api.memory_a2_cleanup({ apply: true }).retired, 0);
  const pending = api.memory_a2_review_queue();
  assert.equal(pending.items[0].version, 2);
  assert.equal(pending.items[0].reviewed, false);
  assert.equal(api.memory_read('parent').retired, undefined);
});

test('revoked A3 invalidates a dependent cleanup approval and permits a fresh explicit review', t => {
  const { api, input } = fixture(t);
  api.memory_a3_write(input);
  api.memory_a2_review({ requestId: 'review-before-revoke', items: [{ id: 'parent', version: 1, decision: 'archived', a3Ids: ['long-term'], reason: '关键内容已归纳' }], reason: '审查当前版本' });
  assert.equal(api.memory_a2_review_queue().items[0].reviewed, true);
  api.memory_a3_write({ requestId: 'revoke-before-cleanup', id: 'long-term', expectedVersion: 1, action: 'revoke', reason: '撤回本条归纳' });
  assert.equal(api.memory_a2_review_queue().items[0].reviewed, false);
  assert.equal(api.memory_a2_cleanup({ apply: true }).retired, 0);
  api.memory_a2_review({ requestId: 'review-after-revoke', items: [{ id: 'parent', version: 1, decision: 'discard', reason: '复审后决定仅保留版本历史，不再依赖已撤回的A3' }], reason: '撤回后重新审查' });
  assert.equal(api.memory_a2_cleanup({ apply: true }).retired, 1);
  assert.equal(api.memory_review({ action: 'history', id: 'parent' }).items.filter(item => item.type === 'a2_review').length, 2);
});

test('v0.5 CLI exposes structured A3, declared coverage and reviewed A2 logical cleanup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feiyu-a3-cli-'));
  const cli = fileURLToPath(new URL('../scripts/cli.js', import.meta.url));
  try {
    const inputFile = join(dir, 'input.json');
    const run = (command, flags = [], payload) => {
      if (payload !== undefined) { writeFileSync(inputFile, JSON.stringify(payload)); flags = [...flags, '--input', inputFile]; }
      const result = spawnSync(process.execPath, [cli, command, '--data', join(dir, 'data'), '--instance', 'synthetic-a3-cli', ...flags], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return JSON.parse(result.stdout);
    };
    assert.equal(run('doctor').moduleVersion, '0.6.1');
    const source = { rawId: 'raw', quote: '关键资料在指定目录。', support: 'supports' };
    run('append', [], { id: 'raw', pool: 'a', role: 'user', sessionId: 'synthetic', text: source.quote, recordedAt: '2000-01-01T00:00:00Z' });
    run('write', [], { id: 'a2', kind: 'memory', statementType: 'fact', text: '归纳资料位置。', sources: [source], recordedAt: '2000-01-02T00:00:00Z' });
    run('a3-write', [], { requestId: 'cli-a3', id: 'a3', expectedVersion: 0, action: 'write', reason: '重要资料位置需长期可查', text: '关键资料的位置曾被明确说明。',
      body: { time: '2000年1月1日的对话', persons: ['用户'], event: '用户说关键资料位于指定目录' }, statementType: 'fact', derivedFrom: ['a2'], coverage: singleCoverage('a2') });
    const read = run('a3-read', ['--id', 'a3', '--source-limit', '1', '--coverage-limit', '1']);
    assert.equal(read.kind, 'a3');
    assert.equal(read.evidenceStatus, 'derived_only');
    assert.equal(read.parents[0].rawSourceCount, 1);
    assert.equal(run('a3-list', ['--orphaned', 'false', '--lineage-broken', 'false']).total, 1);
    assert.equal(run('list', ['--pool', 'a3', '--type', 'a3']).total, 1);
    assert.equal(run('search', ['--pool', 'a3', '--query', '关键资料']).total, 1);
    assert.equal(run('a2-cleanup', ['--apply']).retired, 0);
    assert.equal(run('a2-review-queue').total, 1);
    run('a2-review', [], { requestId: 'cli-a2-review', items: [{ id: 'a2', version: 1, decision: 'archived', a3Ids: ['a3'], reason: '保留在A3且历史仍可查' }], reason: '明确审查该版本' });
    assert.equal(run('a2-cleanup').retired, 0);
    assert.equal(run('a2-cleanup', ['--apply']).retired, 1);
    assert.equal(run('a3-list', ['--orphaned', 'true']).total, 1);
    assert.equal(run('a3-read', ['--id', 'a3']).lineageBroken, false);
    assert.equal(run('read', ['--id', 'a2']).retired, true);
    assert.equal(run('read', ['--id', 'raw']).text, source.quote);
    run('a3-write', [], { requestId: 'cli-a3-revoke', id: 'a3', expectedVersion: 1, action: 'revoke', reason: '暂不作为当前归纳' });
    assert.equal(run('a3-list', ['--status', 'active']).total, 0);
    assert.equal(run('self-review', ['--action', 'history', '--id', 'a3']).items[0].type, 'a3');
    assert.equal(run('dict').version, 'v6');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
