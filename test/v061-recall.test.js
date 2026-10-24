import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../lib/store.js';
import { searchRecall, buildRecallData, createSemanticRecall } from '../lib/recall.js';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-v061-recall-'));
  const store = new MemoryStore({ dataDir: directory, instanceId: 'synthetic-recall-v061', now: () => '2026-10-24T09:00:00Z' });
  t.after(() => {
    store.close(); assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('feiyu-v061-recall-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return store;
}
const raw = (store, id, text, extra = {}) => store.appendRaw({ id, text, pool: 'a', sessionId: 'synthetic-past', turnId: id, role: 'user', ...extra });
const ids = result => result.items.map(item => item.id);
function mixedTopics(store) {
  raw(store, 'plugin', '我更新了记忆插件，你看看现在的版本。');
  raw(store, 'bilibili', 'B站的视频评论更新了，你看看这个视频的评论。');
  raw(store, 'food', '今天晚上吃牛肉面。');
}

test('v061 vague update follows a specific prior topic only; explicit topic excludes conversational-word noise', t => {
  const store = fixture(t); mixedTopics(store);
  const vague = searchRecall(store, { query: '更新了你看看', context: '我们在调试记忆插件', limit: 5 });
  assert.deepEqual(ids(vague), ['plugin']); assert.equal(vague.contextBased, true);
  assert.deepEqual(ids(searchRecall(store, { query: '记忆插件更新了你看看', limit: 5 })), ['plugin']);
  const rendered = JSON.parse(buildRecallData(vague));
  assert.match(rendered.topicHint, /话题线索不是事实证据/);
  assert.equal(rendered.items[0].text, store.getRaw('plugin').text);
  assert.equal(rendered.items[0].role, 'user');
});

test('v061 empty generic context and greetings produce no speculative candidates or embeddings', async t => {
  const store = fixture(t); mixedTopics(store);
  for (const context of ['', '更新了你看看', '你好']) {
    const result = searchRecall(store, { query: '更新了你看看', context });
    assert.deepEqual(result.items, []); assert.equal(result.method, 'no_substantive_query');
  }
  assert.deepEqual(searchRecall(store, { query: '你好', context: '记忆插件' }).items, []);
  let requests = 0;
  t.mock.method(globalThis, 'fetch', () => { requests++; throw new Error('generic text must not be embedded'); });
  const local = searchRecall(store, { query: '更新了你看看', context: '记忆插件' }).items;
  const result = await createSemanticRecall({ endpoint: 'https://synthetic.invalid/embeddings', model: 'synthetic' })
    ('更新了你看看', local, undefined, [{ id: 'unrelated', kind: 'memory', pool: 'a2', text: '不相关内容' }]);
  assert.deepEqual(result.items, local); assert.equal(requests, 0);
});

test('v061 substantive topic switches cannot be dragged back to a previously strong topic', t => {
  const store = fixture(t); mixedTopics(store);
  const switched = searchRecall(store, { query: '视频评论更新了你看看', context: '记忆插件' });
  assert.deepEqual(ids(switched), ['bilibili']); assert.equal(switched.contextBased, undefined);
  assert.deepEqual(searchRecall(store, { query: '这个火星土壤怎么样', context: '记忆插件' }).items, []);
});

test('v061 contextual followups are bounded to two relevant records without borrowing generic matches', t => {
  const store = fixture(t); mixedTopics(store);
  raw(store, 'plugin-2', '记忆插件的关系网改为双向分别记录。');
  raw(store, 'plugin-3', '记忆插件的归档保留来源类型。');
  const result = searchRecall(store, { query: '这个呢', context: '记忆插件', limit: 20 });
  assert.equal(result.items.length, 2); assert.ok(result.items.every(item => item.id.startsWith('plugin')));
  assert.ok(result.items.every(item => item.contextBased));
});

test('v061 update remains searchable inside explicit topics; weak fragment overlap is not enough', t => {
  const store = fixture(t); mixedTopics(store);
  raw(store, 'guide', '系统更新操作教程：先验证备份，再检查目标版本。');
  raw(store, 'failed', '系统更新失败，需要先核对错误日志，尚未恢复。');
  raw(store, 'other-plugin', '音乐插件可调节音量。');
  assert.ok(ids(searchRecall(store, { query: '更新操作教程' })).includes('guide'));
  assert.ok(ids(searchRecall(store, { query: '系统更新失败' })).includes('failed'));
  assert.ok(!ids(searchRecall(store, { query: '记忆插件' })).includes('other-plugin'));
});

test('v061 exact short identities retain ambiguity but cannot bypass an added subject', t => {
  const store = fixture(t);
  raw(store, 'names', '小明和另一位小明是不同的人。');
  for (const id of ['person-one', 'person-two']) store.writeEntry({ id, kind: 'entity', text: '小明', aliases: ['小明'],
    statementType: 'self_report', sources: [{ rawId: 'names', quote: '小明' }] });
  const named = searchRecall(store, { query: '小明' });
  assert.equal(named.ambiguities[0].entityIds.length, 2);
  assert.ok(ids(named).includes('person-one')); assert.ok(ids(named).includes('person-two'));
  assert.deepEqual(searchRecall(store, { query: '小明火星土壤' }).items, []);
});

test('v061 display names are indexed as explicit aliases without merging same-name identities', () => {
  const entries = ['device-a', 'device-b'].map(id => ({ id, version: 1, kind: 'entity', pool: 'c',
    displayName: '大肥鱼', aliases: [], text: '这是另一个独立记忆主体的完整说明。'.repeat(4), status: 'active' }));
  const store = { timezone: 'Asia/Shanghai', now: () => '2026-10-24T09:00:00Z', listEntries: () => entries,
    listRaw: () => [], getEntry: id => entries.find(item => item.id === id) };
  const result = searchRecall(store, { query: '大肥鱼' });
  assert.deepEqual(new Set(ids(result)), new Set(['device-a', 'device-b']));
  assert.deepEqual(new Set(result.ambiguities[0].entityIds), new Set(['device-a', 'device-b']));
});

test('v061 pure time questions ignore an unrelated previous topic; dated topic queries still intersect', t => {
  const store = fixture(t);
  raw(store, 'old-video', '视频评论中确认了合成说明', { recordedAt: '2026-10-15T01:00:00Z' });
  raw(store, 'new-plugin', '记忆插件正在检查');
  assert.deepEqual(ids(searchRecall(store, { query: '上星期看看', context: '记忆插件' })), ['old-video']);
  assert.deepEqual(searchRecall(store, { query: '上星期记忆插件' }).items, []);
});

test('v061 confident one-off and fuzzy product queries preserve complete short qualifications and attribution', t => {
  const store = fixture(t);
  const original = '主人说 ComfyUI 已安装，但我没有验证启动成功；只有进入对应虚拟环境后才能按此流程检查。';
  raw(store, 'important-once', original, { role: 'assistant' });
  for (let i = 0; i < 10; i++) raw(store, `routine-${i}`, '今天吃饭睡觉，然后继续吃饭睡觉。');
  const result = searchRecall(store, { query: 'ComfyUl 怎么启动' });
  assert.deepEqual(ids(result), ['important-once']);
  const rendered = JSON.parse(buildRecallData(result));
  assert.equal(rendered.items[0].text, original); assert.equal(rendered.items[0].role, 'assistant');
  assert.ok(!rendered.items[0].excerptOnly);
});
