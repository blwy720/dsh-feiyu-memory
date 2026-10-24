import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { MemoryStore } from '../lib/store.js';
import { searchRecall, refreshRecall, semanticCandidates, createSemanticRecall, buildRecallData } from '../lib/recall.js';

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-v060-recall-audit-'));
  const store = new MemoryStore({ dataDir, instanceId: 'synthetic-recall-audit', now: () => new Date('2026-10-24T12:00:00Z') });
  t.after(() => {
    store.close(); assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith('feiyu-v060-recall-audit-'));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return store;
}
function raw(store, id, text, extra = {}) {
  return store.appendRaw({ id, pool: 'a', role: 'user', sessionId: 'past', turnId: '1', text, ...extra });
}
function memory(store, id, rawId, extra = {}) {
  return store.writeEntry({ id, kind: 'memory', text: store.getRaw(rawId).text,
    sources: [{ rawId, quote: store.getRaw(rawId).text, support: 'context_only' }], statementType: 'self_report', ...extra });
}

test('default retrieval and disabled semantic mode never call the network; enabled embeddings exclude A1 and redact keys', async t => {
  const store = fixture(t); raw(store, 'raw-only', 'A1_PRIVATE_SENTINEL ComfyUI 安装上下文');
  raw(store, 'curated-source', 'ComfyUI 经核验的合成启动流程'); memory(store, 'curated', 'curated-source');
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body); requests.push(body);
    return Response.json({ data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) });
  });
  const local = searchRecall(store, { query: 'ComfyUI' });
  const disabled = await createSemanticRecall()('ComfyUI', local.items);
  assert.equal(disabled.semantic, 'disabled'); assert.equal(requests.length, 0);
  const secret = 'sk-' + 'syntheticabcdefghijklmnopqrstuvwxyz1234567890';
  const result = await createSemanticRecall({ endpoint: 'https://synthetic.invalid/embeddings', model: 'synthetic' })
    (`ComfyUI api_key=${secret}`, local.items, undefined, semanticCandidates(store));
  assert.equal(result.semantic, 'hybrid_bounded'); assert.equal(requests.length, 1);
  const transmitted = JSON.stringify(requests);
  assert.ok(!transmitted.includes('A1_PRIVATE_SENTINEL'));
  assert.ok(!transmitted.includes(secret));
  assert.ok(transmitted.includes('ComfyUI 经核验的合成启动流程'));
  assert.ok(result.items.some(item => item.kind === 'raw'), 'raw candidates remain available locally');
});

test('time-filtered semantic candidates retain check deadlines and never add out-of-window entries or A1', t => {
  const store = fixture(t);
  raw(store, 'old-source', 'ComfyUI 上周合成安装完成', { recordedAt: '2026-10-15T12:00:00Z' });
  raw(store, 'new-source', 'ComfyUI 本周合成安装完成', { recordedAt: '2026-10-24T08:00:00Z' });
  memory(store, 'old', 'old-source'); memory(store, 'new', 'new-source');
  raw(store, 'check', '合成复核通过', { recordedAt: '2026-10-23T00:00:00Z' });
  store.reviewValidity({ requestId: 'check-old', targets: [{ id: 'old', version: 1 }], currentValidity: 'valid',
    check: { method: '合成检查', result: '通过' }, sources: [{ rawId: 'check', quote: '合成复核通过' }],
    checkedAt: '2026-10-23T00:00:00Z', reviewAfter: '2026-10-24T00:00:00Z', reason: '测试过期复核提示' });
  const local = searchRecall(store, { query: '上星期安装ComfyUI' });
  const bank = semanticCandidates(store, { resolvedTime: local.resolvedTime });
  assert.deepEqual(bank.map(item => item.id), ['old']);
  assert.equal(bank[0].currentValidity, 'valid'); assert.equal(bank[0].reviewDue, true);
  assert.equal(bank[0].checkedAt, '2026-10-23T00:00:00.000Z');
  assert.equal(bank[0].reviewAfter, '2026-10-24T00:00:00.000Z');
});

test('refreshing a same-turn candidate removes invalidated and superseded versions without hiding their deliberate reads', t => {
  const store = fixture(t);
  raw(store, 'source', 'ComfyUI 合成网络设置有效'); memory(store, 'network', 'source');
  const cached = searchRecall(store, { query: 'ComfyUI', pools: ['a2'] }).items;
  assert.equal(cached.length, 1);
  raw(store, 'check', '合成检查：网络设置现在失效');
  store.reviewValidity({ requestId: 'invalid-network', targets: [{ id: 'network', version: 1 }], currentValidity: 'invalid',
    check: { method: '合成检查', result: '失效' }, sources: [{ rawId: 'check', quote: '网络设置现在失效' }], reason: '当前状态已变' });
  assert.deepEqual(refreshRecall(store, cached), []);
  assert.equal(store.getEntry('network', { version: 1 }).currentValidity, 'invalid');
  memory(store, 'network', 'source', { expectedVersion: 1, text: 'ComfyUI 重新配置，当前尚待核验' });
  assert.deepEqual(refreshRecall(store, cached), []);
  assert.equal(store.getEntry('network').version, 2);
});

test('current-turn exclusion is session-specific and an empty greeting never reuses prior topic context', t => {
  const store = fixture(t);
  raw(store, 'current', 'ComfyUI 当前输入', { sessionId: 'current', turnId: '2' });
  raw(store, 'other', 'ComfyUI 另一会话配置显卡', { sessionId: 'other', turnId: '2' });
  raw(store, 'previous', 'ComfyUI 先前一轮修复端口', { sessionId: 'current', turnId: '1' });
  const ids = searchRecall(store, { query: 'ComfyUI', excludeSessionId: 'current', excludeTurnId: '2' }).items.map(item => item.id);
  assert.ok(!ids.includes('current')); assert.ok(ids.includes('other')); assert.ok(ids.includes('previous'));
  const greeting = searchRecall(store, { query: '你好', context: 'ComfyUI安装' });
  assert.equal(greeting.method, 'no_substantive_query'); assert.equal(greeting.items.length, 0);
});

test('optional semantic timeout falls back to unchanged local results within a bounded wait', async t => {
  const items = [{ id: 'curated', version: 1, kind: 'memory', pool: 'a2', text: '合成候选', score: 1 }];
  t.mock.method(globalThis, 'fetch', async (_url, init) => new Promise((resolve, reject) => {
    const guard = setTimeout(() => reject(new Error('test timeout guard')), 2500);
    const cancelled = () => { clearTimeout(guard); reject(init.signal.reason); };
    if (init.signal.aborted) cancelled(); else init.signal.addEventListener('abort', cancelled, { once: true });
  }));
  const started = performance.now();
  const result = await createSemanticRecall({ endpoint: 'https://synthetic.invalid/embeddings', model: 'synthetic', timeoutMs: 100 })('合成查询', items);
  assert.equal(result.semantic, 'unavailable_local_fallback'); assert.deepEqual(result.items, items);
  assert.ok(performance.now() - started < 1500);
  for (const maxChars of [512, 900, 2400]) {
    const rendered = buildRecallData({ items: [...items, { ...items[0], id: 'long', text: '限定条件'.repeat(1000) }] }, { maxChars });
    assert.ok(rendered.length <= maxChars); if (rendered) assert.doesNotThrow(() => JSON.parse(rendered));
  }
});

test('identical words from a user and an assistant retain separate speaker attribution', t => {
  const store = fixture(t), text = '星河路由已经完成合成配置，仍需核验连接。';
  raw(store, 'user-said', text, { role: 'user' });
  raw(store, 'assistant-said', text, { role: 'assistant' });
  const items = searchRecall(store, { query: '星河路由' }).items;
  assert.deepEqual(new Set(items.map(item => item.role)), new Set(['user', 'assistant']));
});

test('different preference holders are not deduplicated merely because their words are identical', () => {
  const entries = ['person-a', 'person-b'].map(subject => ({ id: `${subject}-taste`, version: 1, pool: 'b3', kind: 'preference',
    subject, sourceNature: 'attributed_self_report', scopeEligible: true, status: 'active', text: '喜欢合成咖啡', topic: '合成咖啡',
    recordedAt: '2026-10-24T12:00:00Z' }));
  const store = { timezone: 'Asia/Shanghai', now: () => new Date('2026-10-24T12:00:00Z'), listEntries: () => entries,
    listRaw: () => [], getEntry: id => entries.find(item => item.id === id) };
  const result = searchRecall(store, { query: '合成咖啡' });
  assert.deepEqual(new Set(result.items.map(item => item.id)), new Set(entries.map(item => item.id)));
});

test('near-identical long reports with opposite results both remain available as candidates', t => {
  const store = fixture(t);
  const process = '星河工具安装记录包括环境版本、依赖配置、路径检查、启动日志、端口绑定、网络访问、文件权限、缓存清理、驱动状态、磁盘容量、工作目录、设备列表、服务设置、登录过程、任务队列和操作说明。';
  raw(store, 'a-passed', process + '最终检查：成功。');
  raw(store, 'b-failed', process + '最终检查：失败。');
  const ids = searchRecall(store, { query: '星河工具安装' }).items.map(item => item.id);
  assert.ok(ids.includes('a-passed')); assert.ok(ids.includes('b-failed'));
});
