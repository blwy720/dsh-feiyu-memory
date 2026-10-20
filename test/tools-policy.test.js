import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../lib/store.js';
import { createTools } from '../lib/tools.js';

function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'feiyu-policy-tools-'));
  const store = new MemoryStore({ dataDir, instanceId: 'synthetic-policy-tools', timezone: 'Asia/Shanghai', now: () => new Date('2026-10-20T04:00:00Z') });
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return { store, api: createTools(store) };
}
function raw(store, id, text) {
  store.appendRaw({ id, role: 'user', pool: 'a', sessionId: 'synthetic-policy', text });
  return { rawId: id, quote: text, support: 'context_only' };
}
function entity(api, id, text) {
  return api.memory_core_write({ requestId: `create-${id}`, id, expectedVersion: 0, kind: 'entity', text,
    category: 'identity', statementType: 'fact', reason: '明确记录合成人物节点' });
}
function edge(api, id, from, to, rel) {
  return api.memory_core_write({ requestId: `create-${id}`, id, expectedVersion: 0, kind: 'relation', from, to, rel, text: `${from}称${to}为${rel}`,
    category: 'relationship', statementType: 'self_report', reason: '明确记录这个方向的称谓' });
}

test('early review preserves one-off important changes as pending work; failure never marks raw reviewed', t => {
  const { store, api } = fixture(t);
  const source = raw(store, 'one-off', '我给肥鱼安装好了 ComfyUI。');
  assert.equal(api.memory_review_queue().total, 0);
  const request = { requestId: 'early-one-off', rawIds: ['one-off'], reason: '一次性的能力环境变化，不按频次决定重要性' };
  assert.equal(api.memory_review_request(request).requested, 1);
  assert.equal(api.memory_review_request(request).duplicate, true);
  const queued = api.memory_review_queue();
  assert.equal(queued.total, 1);
  assert.equal(queued.items[0].rawId, 'one-off');
  assert.ok(!JSON.stringify(queued).includes(source.quote));
  const review = { action: 'submit', requestId: 'extract-once', rawIds: ['one-off'], reason: '保存用户明确自述，不宣称实际运行已验证',
    entries: [{ id: 'installed', kind: 'memory', statementType: 'self_report', text: '用户说已给肥鱼安装 ComfyUI。', sources: [source] }] };
  assert.throws(() => api.memory_review({ ...review, entries: [{ ...review.entries[0], sources: [{ rawId: 'one-off', quote: '实际成功运行' }] }] }), /verbatim/);
  assert.equal(api.memory_review_queue().total, 1);
  assert.equal(store.getEntry('installed'), null);
  assert.equal(api.memory_review(review).completed, 1);
  assert.equal(api.memory_review_queue().total, 0);
  const result = api.memory_read('installed');
  assert.equal(result.statementType, 'self_report');
  assert.equal(result.semanticStatus, 'declared_only');
  assert.equal(result.currentValidity, 'unknown');
});

test('B3 retains distinct self and first-hop subjects and directed C traversal does not manufacture reverse relations', t => {
  const { store, api } = fixture(t);
  entity(api, 'mei', '小梅');
  entity(api, 'gpt', 'GPT');
  edge(api, 'mei-fish', 'mei', 'self', '朋友');
  edge(api, 'mei-gpt', 'mei', 'gpt', '同学');
  const source = raw(store, 'mei-statement', '小梅说：我喜欢安静的音乐。');
  const input = { requestId: 'mei-preference', id: 'mei-music', expectedVersion: 0, action: 'set', subject: 'mei',
    topic: '音乐', stance: 'like', text: '小梅明确说喜欢安静的音乐。', reason: '保存明确归属于小梅的自述',
    declaration: { subject: 'mei', rawId: source.rawId, quote: source.quote }, sources: [source] };
  api.memory_preference(input);
  api.memory_preference({ requestId: 'self-emotion', id: 'self-happy', expectedVersion: 0, action: 'set', subject: 'self', target: 'mei',
    expressionKind: 'emotion', topic: '这次谈话', stance: 'like', text: '我很高兴有人认真听我说话。', reason: '记录自己的当前感受' });
  assert.throws(() => api.memory_preference({ ...input, id: 'second-hop', requestId: 'second-hop', subject: 'gpt',
    declaration: { ...input.declaration, subject: 'gpt' } }), /first|scope|hop/i);
  const read = api.memory_read('mei-music');
  assert.equal(read.subject, 'mei');
  assert.equal(read.sourceNature, 'attributed_self_report');
  assert.equal(read.scopeEligible, true);
  assert.equal(read.declaration.subject, 'mei');
  assert.equal(read.checks.supportJudgment.subject, 'mei');
  const own = api.memory_read('self-happy');
  assert.equal(own.subject, 'self');
  assert.equal(own.target, 'mei');
  assert.equal(own.expressionKind, 'emotion');
  assert.equal(api.memory_list({ pool: 'b3', scopeEligible: true }).total, 2);
  const graph = api.memory_graph({ center: 'gpt', depth: 2 });
  assert.equal(graph.edges.length, 2);
  assert.ok(graph.edges.every(item => item.from === 'mei'));
  const correction = raw(store, 'relationship-disputed', '关于小梅和肥鱼的关系，之前记录的归属还需要核对。');
  api.memory_correct({ requestId: 'dispute-edge', targets: [{ id: 'mei-fish', version: 1 }], status: 'disputed',
    reason: '关系原归属存在争议，暂不按该边扩展喜好范围', sources: [correction] });
  assert.equal(api.memory_read('mei-music').scopeEligible, false);
  assert.deepEqual(api.memory_list({ pool: 'b3', scopeEligible: true }).candidates.map(item => item.id), ['self-happy']);
  assert.deepEqual(api.memory_list({ pool: 'b3', subject: 'mei', scopeEligible: false }).candidates.map(item => item.id), ['mei-music']);
  const revoke = { requestId: 'revoke-mei-music', id: 'mei-music', expectedVersion: 1, action: 'revoke', reason: '撤销已退出第一跳的喜好，不必重填持有者' };
  assert.equal(api.memory_preference(revoke).status, 'archived');
  assert.equal(api.memory_preference(revoke).duplicate, true);
  assert.equal(api.memory_read('mei-music').subject, 'mei');
});

test('exact-source corrections mark dependent A3 for review without rewriting text; state changes do not falsify old facts', t => {
  const { store, api } = fixture(t);
  const source = raw(store, 'old-place', '资料在蓝色目录。');
  api.memory_write({ id: 'place', kind: 'memory', statementType: 'self_report', text: '用户说资料在蓝色目录。', sources: [source] });
  const archived = { requestId: 'archive-place', id: 'a3-place', expectedVersion: 0, action: 'write', reason: '长期可检索的明确资料位置',
    statementType: 'self_report', body: { time: '2026年10月20日用户提及；放置时间未说明', persons: ['用户'], event: '用户说资料在蓝色目录' },
    derivedFrom: ['place'], coverage: { scope: [{ id: 'place', version: 1 }], covered: ['place'], notCovered: [], scopeNote: '只覆盖这条明确自述' } };
  api.memory_a3_write(archived);
  const before = api.memory_a3_read('a3-place').text;
  const correction = raw(store, 'correct-place', '刚才说错了，资料在绿色目录。');
  api.memory_correct({ requestId: 'correct-place', targets: [{ id: 'place', version: 1 }], status: 'superseded',
    reason: '原说话者明确纠正目录', sources: [correction] });
  const updated = api.memory_a3_read('a3-place');
  assert.equal(updated.correctness.status, 'needs_review');
  assert.equal(updated.correctness.events[0].propagated, true);
  assert.equal(updated.text, before);
  assert.equal(updated.version, 1);
  assert.equal(api.memory_read('place').correctness.status, 'superseded');
  const taste = raw(store, 'old-taste', '我以前喜欢红色。');
  api.memory_write({ id: 'past-taste', kind: 'memory', statementType: 'self_report', text: '用户过去说喜欢红色。', sources: [taste] });
  const change = raw(store, 'new-taste', '现在改为喜欢蓝色了。');
  api.memory_correct({ requestId: 'taste-change', targets: [{ id: 'past-taste', version: 1 }], changeType: 'state_change',
    reason: '现在改变了喜好，不能据此否认过去的自述', sources: [change] });
  const history = api.memory_read('past-taste');
  assert.equal(history.currentStateChanged, true);
  assert.equal(history.correctness.status, 'unreviewed');
  assert.equal(history.currentStateEvents[0].changeType, 'state_change');
  assert.throws(() => api.memory_correct({ requestId: 'wrong-change', targets: [{ id: 'past-taste', version: 1 }],
    changeType: 'state_change', status: 'superseded', reason: '错误地否定过去', sources: [change] }), /historical|state_change/i);
});
