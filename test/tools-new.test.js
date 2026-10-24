import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../lib/store.js';
import { createTools } from '../lib/tools.js';

function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'feiyu-tools-v2-'));
  const store = new MemoryStore({ dataDir, instanceId: 'synthetic-v2-tools', timezone: 'Asia/Shanghai', now: () => new Date('2026-10-18T04:00:00Z') });
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return { store, api: createTools(store) };
}

function capture(store, id, text, fields = {}) {
  return store.appendRaw({ id, text, role: 'user', pool: 'a', sessionId: 'synthetic', recordedAt: '2026-10-10T04:00:00Z', ...fields });
}

test('review queue exposes only due raw pointers with exact seven-day boundary and pagination', t => {
  const { store, api } = fixture(t);
  capture(store, 'old', 'synthetic old body');
  capture(store, 'boundary', 'synthetic boundary body', { recordedAt: '2026-10-11T04:00:00Z' });
  capture(store, 'young', 'synthetic young body', { recordedAt: '2026-10-11T04:00:00.001Z' });
  capture(store, 'external', 'B must never become original evidence', { pool: 'b' });
  const first = api.memory_review_queue({ limit: 1 });
  assert.equal(first.total, 2);
  assert.equal(first.items[0].rawId, 'old');
  assert.equal(first.hasMore, true);
  assert.equal(JSON.stringify(first).includes('synthetic old body'), false);
  const next = api.memory_review_queue({ offset: first.nextOffset, limit: 1 });
  assert.equal(next.items[0].rawId, 'boundary');
  assert.equal(next.items[0].dueAt, '2026-10-18T12:00:00.000+08:00');
  assert.equal(next.items[0].read.tool, 'memory_read');
  assert.equal(api.memory_read(next.items[0].read.arguments).text, 'synthetic boundary body');
  assert.throws(() => api.memory_review_queue({ limit: 21 }), /limit/);
});

test('self-review rejects bad evidence atomically, retries idempotently, and never approves raw deletion', t => {
  const { store, api } = fixture(t);
  capture(store, 'source', '如果中了800万，我才考虑买房。');
  capture(store, 'small-talk', '嗯');
  const submission = { action: 'submit', requestId: 'review-1', rawIds: ['source', 'small-talk'], reason: '保留条件，略过无新增信息的应答',
    entries: [{ id: 'conditional', kind: 'memory', statementType: 'fact', pool: 'a2', text: '这是关于中奖的假设，不是中奖事实。', sources: [{ rawId: 'source', quote: '如果中了800万', support: 'context_only' }] }],
    omissions: [{ rawId: 'small-talk', reason: '只有应答词，没有待提炼主张' }] };
  const bad = structuredClone(submission);
  bad.entries[0].sources[0].quote = '已经中了800万';
  assert.throws(() => api.memory_review(bad), /verbatim/);
  assert.equal(api.memory_review_queue().total, 2);
  assert.equal(store.getEntry('conditional'), null);
  const result = api.memory_review(submission);
  assert.equal(result.completed, 2);
  assert.equal(result.entries[0].pool, 'a2');
  assert.equal(api.memory_review_queue().total, 0);
  assert.equal(api.memory_review(submission).duplicate, true);
  assert.equal(store.getEntry('conditional').version, 1);
  const history = api.memory_review({ action: 'history', id: 'source', limit: 1 });
  assert.equal(history.total, 1);
  assert.equal(history.items[0].type, 'self_review');
  assert.equal(history.items[0].reason, submission.reason);
  assert.ok(!JSON.stringify(history).includes('如果中了800万，我才考虑买房。'));
  const read = api.memory_read({ id: 'conditional' });
  assert.equal(read.pool, 'a2');
  assert.equal(read.selfReview.requestId, 'review-1');
  assert.equal(read.checks.supportJudgment.status, 'not_independently_verified');
  assert.equal(store.slide({ apply: false }).blocked >= 2, true);
  assert.throws(() => api.memory_review({ action: 'discard', ids: ['source'] }), /管理员/);
  assert.throws(() => api.memory_write({ statementType: 'fact', kind: 'retention_review' }), /管理员/);
});

test('pool filters and relation reads expose explicit C graph decisions without promoting ordinary memory', t => {
  const { store, api } = fixture(t);
  capture(store, 'relationships', '我是你的主人；GPT是我的朋友。');
  const evidence = [{ rawId: 'relationships', quote: '我是你的主人；GPT是我的朋友。', support: 'supports' }];
  api.memory_write({ statementType: 'fact', id: 'ordinary', kind: 'memory', text: '普通提炼', sources: evidence });
  for (const [id, name] of [['owner', '主人'], ['gpt', '朋友 GPT']]) {
    api.memory_write({ statementType: 'fact', id, kind: 'entity', text: name, sources: evidence });
    api.memory_core({ requestId: `core-${id}`, id, expectedVersion: 1, action: 'promote', category: 'identity', reason: '关系网需要可定位的节点' });
  }
  api.memory_write({ statementType: 'fact', id: 'owner-edge', kind: 'relation', text: '肥鱼将此人记录为主人', from: 'self', to: 'owner', rel: '主人', note: '有向关系', sources: evidence });
  api.memory_write({ statementType: 'fact', id: 'friend-edge', kind: 'relation', text: '主人称 GPT 是自己的朋友', from: 'owner', to: 'gpt', rel: '朋友', sources: evidence });
  for (const id of ['owner-edge', 'friend-edge']) api.memory_core({ requestId: `core-${id}`, id, expectedVersion: 1, action: 'promote', category: 'relationship', reason: '保存有出处的有向关系' });
  assert.throws(() => api.memory_core({ requestId: 'bad-core', id: 'ordinary', expectedVersion: 1, action: 'promote', category: 'identity', reason: '不能放入普通记忆' }), /entity|relation|关系|graph/i);
  assert.deepEqual(api.memory_list({ pool: 'a1' }).candidates.map(item => item.id), ['relationships']);
  assert.deepEqual(api.memory_list({ pool: 'a2' }).candidates.map(item => item.id), ['ordinary']);
  assert.equal(api.memory_search({ pool: 'c', type: 'relation' }).total, 2);
  assert.equal(api.memory_search({ pool: 'c', limit: 20 }).total, 4);
  const read = api.memory_read({ id: 'friend-edge', kind: 'relation', pool: 'c' });
  assert.equal(read.from, 'owner');
  assert.equal(read.to, 'gpt');
  assert.equal(read.rel, '朋友');
  assert.equal(read.pool, 'c');
  assert.equal(read.coreDecision.action, 'promote');
  assert.equal(read.coreDecision.reason, '保存有出处的有向关系');
  assert.equal(read.checks.supportJudgment.status, 'not_independently_verified');
  assert.equal(api.memory_read({ id: 'friend-edge', pool: 'a2' }), null);
  const graph = api.memory_graph({ depth: 2 });
  assert.deepEqual(new Set(graph.edges.map(edge => edge.id)), new Set(['owner-edge', 'friend-edge']));
  assert.deepEqual(api.memory_graph({ depth: 1 }).edges.map(edge => edge.id), ['owner-edge']);
  const reverseTraversal = api.memory_graph({ center: 'gpt', depth: 2 });
  assert.equal(reverseTraversal.edges.length, 2);
  assert.deepEqual(reverseTraversal.edges.find(edge => edge.id === 'friend-edge').from, 'owner');
  assert.deepEqual(reverseTraversal.edges.find(edge => edge.id === 'friend-edge').to, 'gpt');
  for (const edge of graph.edges) assert.equal(api.memory_read(edge.read.arguments).version, edge.version);
  assert.throws(() => api.memory_core({ requestId: 'revoke-owner-first', id: 'owner', expectedVersion: 2, action: 'revoke', reason: '先撤边' }), /edge|relation|边/i);
  const revoked = api.memory_core({ requestId: 'revoke-friend', id: 'friend-edge', expectedVersion: 2, action: 'revoke', reason: '关系需要重新核对' });
  assert.equal(revoked.pool, 'a2');
  assert.equal(api.memory_graph().edges.length, 1);
  assert.equal(api.memory_read({ id: 'friend-edge', version: 2 }).pool, 'c');
  assert.equal(api.memory_review({ action: 'history', id: 'friend-edge' }).total, 2);
  assert.throws(() => api.memory_graph({ depth: 6 }), /depth/);
  assert.throws(() => api.memory_graph({ pool: 'a1' }), /pool/);
  assert.throws(() => api.memory_graph({ limit: 501 }), /limit/);
});

test('B returns bounded date-role-hour counts and never pretends to search message bodies', t => {
  const { store, api } = fixture(t);
  capture(store, 'b-user', 'private external text', { pool: 'b', role: 'user', recordedAt: '2026-10-10T01:00:00Z' });
  capture(store, 'b-assistant', 'different private external text', { pool: 'b', role: 'assistant', recordedAt: '2026-10-10T02:00:00Z' });
  capture(store, 'b-next', 'another external text', { pool: 'b', role: 'user', recordedAt: '2026-10-11T01:00:00Z' });
  const first = api.memory_list({ pool: 'b', limit: 1 });
  assert.equal(first.total, 2);
  assert.equal(first.items[0].date, '2026-10-11');
  assert.equal(first.hasMore, true);
  const second = api.memory_search({ pool: 'b', offset: first.nextOffset, limit: 1 });
  assert.equal(second.items[0].total, 2);
  const role = api.memory_list({ pool: 'b', type: 'user', date: '2026-10-10' });
  assert.deepEqual(role.items, [{ date: '2026-10-10', total: 1, roles: { user: 1 }, hours: { '09': 1 } }]);
  assert.equal(api.memory_list({ type: 'b' }).total, 2);
  assert.equal(api.memory_list().total, 0);
  assert.equal(api.memory_read({ id: 'b-user' }), null);
  assert.ok(!JSON.stringify(first).includes('external text'));
  assert.throws(() => api.memory_search({ pool: 'b', q: 'private' }), /正文/);
  assert.throws(() => api.memory_list({ pool: 'b', timeAxis: 'occurred' }), /recorded/);
  assert.throws(() => api.memory_list({ pool: 'b', from: '2026-10-10T00:00:00Z' }), /YYYY-MM-DD/);
  assert.throws(() => api.memory_list({ pool: 'invalid' }), /pool/);
  assert.throws(() => api.memory_read({ id: 'b-user', pool: 'b' }), /没有正文/);
});

test('dictionary tool serves v6 while leaving the immutable v1/v2/v3/v4/v5 dictionaries unchanged', t => {
  const { store, api } = fixture(t);
  const oldPath = join(store.dataDir, 'dict', 'v1.md');
  const oldText = readFileSync(oldPath, 'utf8');
  const v2Path = join(store.dataDir, 'dict', 'v2.md');
  const v2Text = readFileSync(v2Path, 'utf8');
  const v3Path = join(store.dataDir, 'dict', 'v3.md');
  const v3Text = readFileSync(v3Path, 'utf8');
  const v4Path = join(store.dataDir, 'dict', 'v4.md');
  const v4Text = readFileSync(v4Path, 'utf8');
  const v5Path = join(store.dataDir, 'dict', 'v5.md');
  const v5Text = readFileSync(v5Path, 'utf8');
  const dictionary = api.memory_dict();
  assert.equal(dictionary.version, 'v6');
  assert.equal(dictionary.moduleVersion, '0.6.1');
  const baseV6 = readFileSync(join(store.dataDir, 'dict', 'v6.md'), 'utf8');
  assert.ok(dictionary.text.startsWith(baseV6));
  assert.equal(dictionary.supplementVersion, '0.6.1');
  assert.match(dictionary.text.slice(baseV6.length), /0\.6\.1接口补充/u);
  assert.equal(readFileSync(join(store.dataDir, 'dict', 'v6.md'), 'utf8'), baseV6);
  assert.match(dictionary.text, /A2/);
  assert.match(dictionary.text, /有向边/);
  store.flush();
  assert.equal(readFileSync(oldPath, 'utf8'), oldText);
  assert.equal(readFileSync(v2Path, 'utf8'), v2Text);
  assert.equal(readFileSync(v3Path, 'utf8'), v3Text);
  assert.equal(readFileSync(v4Path, 'utf8'), v4Text);
  assert.equal(readFileSync(v5Path, 'utf8'), v5Text);
  const entry = api.memory_write({ statementType: 'fact', kind: 'memory', text: '合成未验证条目' });
  assert.equal(entry.dictVersion, 'v6');
});

test('B3 preferences are self-reports with a dedicated CAS/idempotent API, separate from user memories and C', t => {
  const { store, api } = fixture(t);
  api.memory_write({ statementType: 'fact', id: 'user-preference', kind: 'memory', text: '用户说喜欢蓝色，尚无原文引用。' });
  const initial = { requestId: 'pref-create', id: 'fish-weather', expectedVersion: 0, action: 'set', topic: '雨天环境', stance: 'like',
    text: '我喜欢安静听雨的感觉。', reason: '这是肥鱼自己的当前喜好自述' };
  const written = api.memory_preference(initial);
  assert.equal(written.pool, 'b3');
  assert.equal(written.version, 1);
  assert.equal(api.memory_preference(initial).duplicate, true);
  const read = api.memory_read({ id: 'fish-weather', pool: 'b3', kind: 'preference' });
  assert.equal(read.subject, 'self');
  assert.equal(read.stance, 'like');
  assert.equal(read.topic, '雨天环境');
  assert.equal(read.sourceNature, 'model_self_report');
  assert.equal(read.evidenceStatus, 'self_report');
  assert.equal(read.contextEvidenceStatus, 'none');
  assert.equal(read.checks.supportJudgment.status, 'self_report');
  assert.equal(read.currentValidity, 'unknown');
  assert.equal(read.sourceCount, 0);
  assert.equal(read.preferenceDecision.action, 'set');
  assert.equal(read.preferenceDecision.sourceVersion, 0);
  assert.equal(read.preferenceDecision.asOf, '2026-10-18T12:00:00.000+08:00');
  assert.deepEqual(api.memory_search({ pool: 'b3', q: '雨天环境' }).candidates.map(item => item.id), ['fish-weather']);
  assert.equal(api.memory_list({ type: 'preference' }).candidates[0].evidenceStatus, 'self_report');
  assert.deepEqual(api.memory_list({ pool: 'a2' }).candidates.map(item => item.id), ['user-preference']);
  assert.equal(api.memory_list({ pool: 'b' }).total, 0);
  assert.equal(api.memory_graph({ pool: 'all' }).edges.length, 0);
  assert.throws(() => api.memory_write({ statementType: 'fact', kind: 'preference', pool: 'b3', text: '错误入口' }), /kind/);
  assert.throws(() => api.memory_write({ statementType: 'fact', kind: 'memory', pool: 'b3', text: '用户偏好不能写到 B3' }), /pool/i);
  assert.throws(() => api.memory_preference({ ...initial, requestId: 'pref-user', id: 'different', subject: 'user' }), /subject|first|declaration|C|第一跳/i);
  assert.throws(() => api.memory_core({ requestId: 'pref-core', id: 'fish-weather', expectedVersion: 1, action: 'promote', category: 'identity', reason: '喜好不进入 C' }), /entity|relation|graph/i);
  assert.throws(() => api.memory_preference({ ...initial, requestId: 'stale', text: '版本已经存在' }), /version|conflict/i);
  const changed = api.memory_preference({ ...initial, requestId: 'pref-update', expectedVersion: 1, stance: 'mixed', text: '喜欢听雨，但不喜欢雷声。' });
  assert.equal(changed.version, 2);
  const revoked = api.memory_preference({ requestId: 'pref-revoke', id: 'fish-weather', expectedVersion: 2, action: 'revoke', reason: '暂不将它作为当前喜好' });
  assert.equal(revoked.version, 3);
  assert.equal(revoked.status, 'archived');
  assert.equal(api.memory_list({ pool: 'b3', status: 'active' }).total, 0);
  assert.equal(api.memory_read({ id: 'fish-weather', version: 1 }).stance, 'like');
  assert.equal(api.memory_review({ action: 'history', id: 'fish-weather' }).total, 3);
  assert.ok(api.memory_review({ action: 'history', id: 'fish-weather' }).items.every(item => item.type === 'preference'));
  assert.equal(store.getEntry('user-preference').pool, 'a2');
});

test('B3 context quotes stay context and cannot fabricate original evidence or verification', t => {
  const { store, api } = fixture(t);
  capture(store, 'rain-context', '今天谈到了雨天。');
  const input = { requestId: 'context-pref', id: 'context-pref', expectedVersion: 0, action: 'set', topic: '雨天', stance: 'like',
    text: '我喜欢听雨。', reason: '结合交流后的自身喜好', sources: [{ rawId: 'rain-context', quote: '今天谈到了雨天。', support: 'context_only' }] };
  assert.throws(() => api.memory_preference({ ...input, requestId: 'bad-context', sources: [{ rawId: 'rain-context', quote: '从未说过的原文' }] }), /verbatim|quote/i);
  assert.equal(store.getEntry('context-pref'), null);
  api.memory_preference(input);
  const read = api.memory_read({ id: 'context-pref' });
  assert.equal(read.evidenceStatus, 'self_report');
  assert.equal(read.contextEvidenceStatus, 'quote_verified');
  assert.equal(read.evidence[0].supportJudgment.declared, 'context_only');
  assert.equal(read.evidence[0].quoteLocation.status, 'exact_match');
  assert.equal(read.checks.supportJudgment.status, 'self_report');
  assert.equal(read.independentSourceCount, null);
  assert.equal(read.originals[0].text, undefined);
});
