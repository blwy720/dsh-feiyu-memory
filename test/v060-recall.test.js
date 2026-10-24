import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryStore } from '../lib/store.js';
import { searchRecall, buildRecallData, createSemanticRecall } from '../lib/recall.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'feiyu-v060-recall-'));
  const store = new MemoryStore({ dataDir: dir, instanceId: 'recall', now: () => '2026-10-24T04:00:00Z' });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return store;
}
const raw = (store, id, text, extra = {}) => store.appendRaw({ id, pool: 'a', sessionId: 'past', turnId: '1', role: 'user', text, ...extra });

test('automatic candidates exclude current input and retrieve one-off exact or misspelled topics', t => {
  const store = fixture(t);
  raw(store, 'install', '我给肥鱼安装了 ComfyUI，启动之前要进入虚拟环境。');
  raw(store, 'current', 'ComfyUI 怎么启动', { sessionId: 'current', turnId: '2' });
  raw(store, 'food', '今天吃饭睡觉，明天也吃饭睡觉');
  const result = searchRecall(store, { query: 'ComfyUI 怎么启动', excludeSessionId: 'current', excludeTurnId: '2' });
  assert.equal(result.items[0].id, 'install');
  assert.ok(!result.items.some(x => x.id === 'current' || x.id === 'food'));
  assert.ok(searchRecall(store, { query: 'ComfyUl 启动', excludeRawIds: ['current'] }).items.some(x => x.id === 'install'));
  assert.equal(searchRecall(store, { query: '你好' }).items.length, 0);
  assert.equal(searchRecall(store, { query: '你好', context: 'ComfyUI安装' }).items.length, 0);
  raw(store, 'music', '工作时我喜欢听音乐');
  assert.ok(!searchRecall(store, { query: 'ComfyUI 工作流' }).items.some(x => x.id === 'music'));
});

test('same-name identities stay separate and repeated results do not fill the budget', t => {
  const store = fixture(t);
  raw(store, 'source', '大肥鱼和另一位姐姐来自不同会话。');
  for (const [id, text] of [['one', '大肥鱼'], ['two', '另一位姐姐']]) store.writeEntry({ id, kind: 'entity', text, aliases: ['姐姐'], statementType: 'self_report', sources: [{ rawId: 'source', quote: text }] });
  const result = searchRecall(store, { query: '姐姐' });
  assert.equal(result.ambiguities[0].entityIds.length, 2);
  raw(store, 'copy1', '路由器的设置需要重启，重启之前先保存配置。');
  raw(store, 'copy2', '路由器的设置需要重启，重启之前先保存配置。');
  assert.equal(searchRecall(store, { query: '路由器设置' }).items.filter(x => x.id.startsWith('copy')).length, 1);
});

test('time-only recall and correction filtering keep dated history explicit', t => {
  const store = fixture(t);
  raw(store, 'old', '上周确认了网络配置', { recordedAt: '2026-10-15T01:00:00Z' });
  raw(store, 'new', '今天确认了网络配置');
  const result = searchRecall(store, { query: '上星期有什么重要的事情', timeWindow: { preset: 'last_week' } });
  assert.ok(result.items.some(x => x.id === 'old'));
  assert.ok(!result.items.some(x => x.id === 'new'));
  assert.equal(searchRecall(store, { query: '上星期安装ComfyUI' }).items.length, 0);
  const text = buildRecallData(result, { maxChars: 900 });
  assert.ok(text.length <= 900);
  assert.match(text, /\+08:00/);
});

test('optional semantic provider disabled or failing does not prevent local candidates', async () => {
  const items = [{ id: 'entry', text: 'example', score: 1 }];
  assert.deepEqual(await createSemanticRecall()('query', items), { items, semantic: 'disabled' });
  const signal = AbortSignal.abort();
  const result = await createSemanticRecall({ endpoint: 'http://127.0.0.1:1/embeddings', model: 'test' })('query', items, signal);
  assert.deepEqual(result.items, items);
  assert.equal(result.semantic, 'cancelled');
  assert.throws(() => createSemanticRecall({ endpoint: 'http://example.com/embeddings' }), /HTTPS/);
});
