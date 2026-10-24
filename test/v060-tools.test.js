import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { MemoryStore } from '../lib/store.js';
import { createTools } from '../lib/tools.js';

function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'feiyu-v060-tools-'));
  const store = new MemoryStore({ dataDir, instanceId: 'v060-tools', timezone: 'Asia/Shanghai', now: () => new Date('2026-10-24T07:00:00Z') });
  t.after(() => { store.close(); assert.equal(dirname(resolve(dataDir)), resolve(tmpdir())); rmSync(dataDir, { recursive: true, force: true }); });
  return { store, api: createTools(store) };
}
function raw(store, id, value, extra = {}) { return store.appendRaw({ id, text: value, pool: 'a', role: 'user', recordedAt: '2026-10-10T07:00:00Z', sessionId: 's', turnId: 't', ...extra }); }
function entry(id, rawId, quote) { return { id, kind: 'memory', pool: 'a2', text: quote, statementType: 'self_report', hooks: [quote.slice(0, 80)], sources: [{ rawId, quote, support: 'supports' }] }; }

test('body and fields are concise while the legacy default and exact evidence remain available', t => {
  const { store, api } = fixture(t);
  raw(store, 'source', '我已安装 ComfyUI，但还没有验证是否可用。');
  api.memory_write(entry('installed', 'source', '我已安装 ComfyUI，但还没有验证是否可用。'));
  const full = api.memory_read({ id: 'installed' });
  assert.equal(full.checks.supportJudgment.status, 'not_independently_verified');
  const body = api.memory_read({ id: 'installed', view: 'body' });
  assert.equal(body.text, full.text);
  assert.equal(body.statementType, 'self_report');
  assert.equal(body.checks, undefined);
  assert.equal(body.evidence, undefined);
  assert.ok(JSON.stringify(body).length < JSON.stringify(full).length / 2);
  const selected = api.memory_read({ id: 'source', fields: ['text', 'role', 'recordedAt'] });
  assert.equal(selected.role, 'user');
  assert.equal(selected.recordedAt, '2026-10-10T15:00:00.000+08:00');
  assert.equal(selected.checks, undefined);
  assert.equal(selected.sessionId, undefined);
  assert.equal(api.memory_read({ id: 'installed', view: 'evidence' }).evidence[0].quoteLocation.status, 'exact_match');
  assert.throws(() => api.memory_read({ id: 'installed', fields: ['arbitraryUnknown'] }), /fields/);
});

test('batch reads stay inside total presented JSON budget and resume full Unicode text without loss', t => {
  const { store, api } = fixture(t);
  const original = '先确认条件🙂，不要删除历史。'.repeat(700);
  raw(store, 'long', original);
  raw(store, 'short', '第二条');
  let response = api.memory_fetch({ ids: [{ id: 'long' }, { id: 'missing' }, { id: 'short' }], budget: 1800 });
  let restored = '', foundMissing = false, foundShort = false, calls = 0;
  while (true) {
    assert.ok(JSON.stringify(response).length <= 1800, JSON.stringify(response).length);
    for (const item of response.items) {
      if (item.id === 'long') { restored += item.text; assert.equal(/[\uD800-\uDBFF]$/u.test(item.text), false); }
      if (item.id === 'missing') foundMissing ||= item.readStatus === 'not_found';
      if (item.id === 'short') foundShort ||= item.text === '第二条';
    }
    if (!response.hasMore) break;
    assert.ok(++calls < 100);
    response = api.memory_fetch({ cursor: response.cursor, budget: 1800 });
  }
  assert.equal(restored, original);
  assert.equal(foundMissing, true);
  assert.equal(foundShort, true);
});

test('batch continuation pins entry versions instead of silently switching to a new version', t => {
  const { store, api } = fixture(t);
  raw(store, 'old-source', '原来的条件'.repeat(500));
  api.memory_write(entry('memory', 'old-source', '原来的条件'.repeat(500)));
  let response = api.memory_fetch({ ids: [{ id: 'memory' }], budget: 1500 });
  let text = response.items[0].text;
  raw(store, 'new-source', '后来条件改变了');
  api.memory_write({ ...entry('memory', 'new-source', '后来条件改变了'), expectedVersion: 1 });
  while (response.hasMore) {
    response = api.memory_fetch({ cursor: response.cursor, budget: 1500 });
    for (const item of response.items) { assert.equal(item.version, 1); text += item.text; }
  }
  assert.equal(text, '原来的条件'.repeat(500));
});

test('turn reads require session and turn and exclude identically named turns in other sessions', t => {
  const { store, api } = fixture(t);
  raw(store, 'question', '这一轮的问题', { sessionId: 'first', turnId: 'same' });
  raw(store, 'answer', '这一轮的回答', { sessionId: 'first', turnId: 'same', role: 'assistant', recordedAt: '2026-10-10T07:00:01Z' });
  raw(store, 'other', '另一个会话的秘密', { sessionId: 'second', turnId: 'same' });
  const result = api.memory_fetch({ anchorId: 'question' });
  assert.deepEqual(result.items.map(item => item.id), ['question', 'answer']);
  assert.equal(result.sessionId, 'first');
  assert.equal(result.turnId, 'same');
  assert.equal(JSON.stringify(result).includes('另一个会话的秘密'), false);
  assert.throws(() => api.memory_fetch({ turnId: 'same' }), /sessionId/);
});

test('same-time raw messages retain capture order rather than sorting by generated IDs', t => {
  const { store, api } = fixture(t);
  raw(store, 'z-user', '先问'); raw(store, 'a-assistant', '后答', { role: 'assistant' });
  const result = api.memory_fetch({ sessionId: 's', turnId: 't' });
  assert.deepEqual(result.items.map(item => item.id), ['z-user', 'a-assistant']);
  assert.equal(result.sequenceSource, 'recorded_time_then_capture_order');
  assert.equal(result.scope, 'available_originals_for_exact_session_turn');
});

test('field-only batch reads terminate without requiring omitted text to be read', t => {
  const { store, api } = fixture(t);
  raw(store, 'source', '非常长'.repeat(10000));
  const result = api.memory_fetch({ ids: [{ id: 'source' }], fields: ['role', 'recordedAt'], budget: 1000 });
  assert.equal(result.items[0].text, undefined);
  assert.equal(result.hasMore, false);
});

test('prepare fills only verbatim sources and returns same-name identities separately', t => {
  const { store, api } = fixture(t);
  raw(store, 'source', '工具叫 `ComfyUI`，已安装，未验证。');
  assert.equal(api.memory_prepare({ text: '工具叫 ComfyUI', rawIds: ['source'] }).sources[0].exactMatch, false);
  const exact = api.memory_prepare({ text: '`ComfyUI`', rawIds: ['source'] });
  assert.equal(exact.sources[0].source.quote, '`ComfyUI`');
  assert.equal(exact.written, false);
  for (const id of ['person-one', 'person-two']) {
    store.writeEntry({ ...entry(id, 'source', '`ComfyUI`'), kind: 'entity', text: `${id} 姐姐`, aliases: ['姐姐'] });
    store.setCore({ requestId: `core-${id}`, id, expectedVersion: 1, action: 'promote', category: 'identity', reason: '区分同名实体' });
  }
  const result = api.memory_prepare({ entity: '姐姐' });
  assert.equal(result.ambiguousEntity, true);
  assert.deepEqual(new Set(result.entities.map(item => item.id)), new Set(['person-one', 'person-two']));
});

test('independent review batch commits good units, leaves failed raw pending, and retries idempotently', t => {
  const { store, api } = fixture(t);
  raw(store, 'one', '一次性重要事件'); raw(store, 'two', '这里有一个反引号 `');
  const input = { action: 'batch', requestId: 'daily-1', items: [
    { key: 'one', rawIds: ['one'], entries: [entry('remember-one', 'one', '一次性重要事件')], reason: '保留重要事件' },
    { key: 'two', rawIds: ['two'], entries: [entry('remember-two', 'two', '这里有一个反引号')], reason: '保留准确引文' },
  ] };
  input.items[1].entries[0].sources[0].quote = '这里没有反引号';
  const first = api.memory_review(input);
  assert.equal(first.succeeded, 1); assert.equal(first.failed, 1);
  assert.equal(store.getEntry('remember-one').version, 1);
  assert.equal(store.getEntry('remember-two'), null);
  assert.deepEqual(api.memory_review_queue().items.map(item => item.rawId), ['two']);
  input.items[1].entries[0].sources[0].quote = '这里有一个反引号 `';
  const second = api.memory_review(input);
  assert.equal(second.succeeded, 2); assert.equal(second.failed, 0);
  assert.equal(second.results[0].duplicate, true);
  assert.equal(store.getEntry('remember-one').version, 1);
  assert.equal(api.memory_review_queue().total, 0);
});

test('shared raw or cross-unit entity dependencies are rejected before any review is committed', t => {
  const { store, api } = fixture(t);
  raw(store, 'shared', '我认识她');
  const item = { rawIds: ['shared'], omissions: [{ rawId: 'shared', reason: '无新增内容' }], reason: '检查' };
  assert.throws(() => api.memory_review({ action: 'batch', requestId: 'unsafe', items: [{ ...item, key: 'a' }, { ...item, key: 'b' }] }), /共享原文/);
  assert.equal(api.memory_review_queue().total, 1);
  raw(store, 'second', '她是我的朋友');
  assert.throws(() => api.memory_review({ action: 'batch', requestId: 'unsafe-2', items: [
    { key: 'node', rawIds: ['shared'], entries: [{ ...entry('new-person', 'shared', '我认识她'), kind: 'entity' }], reason: '节点' },
    { key: 'edge', rawIds: ['second'], entries: [{ ...entry('new-edge', 'second', '她是我的朋友'), kind: 'relation', from: 'self', to: 'new-person', rel: '朋友' }], reason: '边' },
  ] }), /实体依赖/);
  assert.equal(store.getEntry('new-person'), null);
});

test('D experience is searchable and readable with external provenance kept separate from verification', t => {
  const { store, api } = fixture(t);
  const written = api.memory_manage({ action: 'knowledge', requestId: 'learn-comfy', reason: '读到教程，尚未操作', knowledge: {
    id: 'd-comfy', purpose: '启动 ComfyUI', conditions: ['电脑已安装依赖'], method: '检查启动日志并打开本机页面；无响应时先检查进程。', validationStatus: 'learned',
    externalSources: [{ url: 'https://example.com/comfyui', title: '示例教程' }], environment: { name: 'Windows', version: '11' },
  } });
  assert.equal(written.id, 'd-comfy');
  const body = api.memory_read({ id: written.id, pool: 'd', view: 'body' });
  assert.equal(body.kind, 'knowledge');
  assert.equal(body.validationStatus, 'learned');
  assert.equal(body.evidenceStatus, 'external_reference');
  assert.ok(api.memory_search({ q: 'ComfyUI', pool: 'd' }).candidates.some(item => item.id === 'd-comfy'));
  assert.equal(api.memory_read({ id: written.id, view: 'evidence' }).externalSources[0].url, 'https://example.com/comfyui');
  assert.throws(() => api.memory_manage({ action: 'knowledge', requestId: 'fake-verify', reason: '不能无证据成功', knowledge: {
    id: 'd-fake', purpose: '测试', conditions: [], method: '测试步骤', validationStatus: 'verified', externalSources: [{ url: 'https://example.com/' }],
  } }), /evidence|method|sources|validation/i);
});

test('lightweight validity checks preserve old text and expose due status and source-limited validation', t => {
  const { store, api } = fixture(t);
  raw(store, 'check-source', '我今天实际启动成功了');
  api.memory_write(entry('old-state', 'check-source', '我今天实际启动成功了'));
  const before = api.memory_read({ id: 'old-state', view: 'body' });
  api.memory_manage({ action: 'revalidate', requestId: 'check-once', reason: '本人明确确认当前状态', check: {
    targets: [{ id: 'old-state', version: 1 }], currentValidity: 'valid', check: { method: '本人自述', result: '本人说启动成功', actor: '主人' },
    sources: [{ rawId: 'check-source', quote: '我今天实际启动成功了' }], checkedAt: '2026-10-23T07:00:00Z', reviewAfter: '2026-10-24T06:00:00Z',
  } });
  const after = api.memory_read({ id: 'old-state', view: 'body' });
  assert.equal(after.text, before.text); assert.equal(after.version, before.version);
  assert.equal(after.currentValidity, 'valid'); assert.equal(after.reviewDue, true);
  assert.equal(after.checkedAt, '2026-10-23T15:00:00.000+08:00');
  assert.equal(api.memory_read({ id: 'old-state', view: 'history' }).validityBasis.autoVerified, false);
});

test('cross-session thread and merge keep precise history, and progress/report count only real commits', t => {
  const { store, api } = fixture(t);
  raw(store, 'first', '第一次修好', { sessionId: 'one' }); raw(store, 'second', '后来又坏了', { sessionId: 'two' });
  api.memory_write(entry('event-one', 'first', '第一次修好'));
  api.memory_write(entry('event-two', 'second', '后来又坏了'));
  api.memory_manage({ action: 'link_thread', requestId: 'thread-link', reason: '同一抓取功能的变化', thread: {
    threadId: 'fetch-issue', title: '抓取故障', entries: [{ id: 'event-one', version: 1 }, { id: 'event-two', version: 1 }],
  } });
  const thread = api.memory_manage({ action: 'read_thread', thread: { threadId: 'fetch-issue' } });
  assert.deepEqual(thread.items.map(item => item.id), ['event-one', 'event-two']);
  assert.deepEqual(api.memory_read({ id: 'event-one', view: 'body' }).threadIds, ['fetch-issue']);
  assert.deepEqual(api.memory_search({ q: '第一次修好', pool: 'a2' }).candidates.find(item => item.id === 'event-one').threadIds, ['fetch-issue']);
  const combined = { ...entry('combined', 'first', '第一次修好'), text: '第一次修好，后来又坏了', sources: [{ rawId: 'first', quote: '第一次修好' }, { rawId: 'second', quote: '后来又坏了' }] };
  api.memory_manage({ action: 'merge', requestId: 'merge-events', reason: '合并同一事项两段经过', merge: {
    targets: [{ id: 'event-one', version: 1 }, { id: 'event-two', version: 1 }], entry: combined,
  } });
  assert.equal(api.memory_read({ id: 'event-one', view: 'history' }).mergedInto[0].id, 'combined');
  assert.equal(api.memory_read({ id: 'event-one', view: 'body' }).mergedInto[0].id, 'combined');
  assert.deepEqual(api.memory_search({ q: '修好', pool: 'a2' }).candidates.map(item => item.id), ['combined']);
  assert.ok(api.memory_search({ q: '修好', pool: 'a2', includeHistory: true }).candidates.some(item => item.id === 'event-one' && item.mergedInto[0].id === 'combined'));
  assert.equal(store.getEntry('event-one').text, '第一次修好');
  api.memory_manage({ action: 'revoke_merge', requestId: 'unmerge-events', reason: '恢复分别展示', merge: { mergeRequestId: 'merge-events' } });
  assert.equal(store.getEntry('event-one').mergedInto, undefined);
  assert.equal(api.memory_search({ q: '修好', pool: 'a2' }).candidates.some(item => item.id === 'combined'), false);
  assert.deepEqual(api.memory_prepare({ text: '第一次修好', pool: 'a2' }).related.find(item => item.id === 'event-one').threadIds, ['fetch-issue']);
  const report = api.memory_manage({ action: 'report', date: '2026-10-24' });
  assert.ok(report.successfulCommits >= 3);
  assert.equal(api.memory_manage({ action: 'progress' }).pendingDue, 2);
});

test('read views and selected validity keep dependency warnings and prepare/search expose them', t => {
  const { store, api } = fixture(t);
  raw(store, 'dependency-raw', '该版本具有启动能力');
  raw(store, 'invalid-now', '该版本现在已经无法启动');
  api.memory_write(entry('dependency-state', 'dependency-raw', '该版本具有启动能力'));
  api.memory_manage({ action: 'knowledge', requestId: 'dependent-knowledge', reason: '保存待尝试的方法', knowledge: {
    id: 'dependent-method', purpose: '启动方法', conditions: ['该版本支持启动'], method: '按该版本说明启动', validationStatus: 'learned',
    dependencyEntries: [{ id: 'dependency-state', version: 1 }],
  } });
  api.memory_manage({ action: 'revalidate', requestId: 'invalidate-dependency', reason: '后续明确自述已不可用', check: {
    targets: [{ id: 'dependency-state', version: 1 }], currentValidity: 'invalid',
    check: { method: '本人明确自述', result: '现在无法启动' }, sources: [{ rawId: 'invalid-now', quote: '该版本现在已经无法启动' }],
  } });
  for (const view of ['body', 'evidence', 'history', 'full']) {
    const read = api.memory_read({ id: 'dependent-method', view });
    assert.equal(read.dependencyReviewPending, true, view);
    assert.equal(read.dependencyReviewReasons[0].id, 'dependency-state', view);
  }
  assert.equal(api.memory_read({ id: 'dependent-method', fields: ['currentValidity'] }).dependencyReviewPending, true);
  assert.equal(api.memory_search({ q: '启动', pool: 'd' }).candidates[0].dependencyReviewPending, true);
  assert.equal(api.memory_prepare({ text: '启动方法', pool: 'd' }).related[0].dependencyReviewPending, true);
});

test('explicit fuzzy search keeps pool/time filters and never upgrades approximate matching to evidence', t => {
  const { store, api } = fixture(t);
  raw(store, 'comfy-source', '安装了 ComfyUI');
  api.memory_write(entry('comfy-memory', 'comfy-source', '安装了 ComfyUI'));
  assert.equal(api.memory_search({ q: 'ComfyUj', pool: 'a2' }).total, 0);
  const fuzzy = api.memory_search({ q: 'ComfyUj', pool: 'a2', fuzzy: true });
  assert.ok(fuzzy.candidates.some(item => item.id === 'comfy-memory' && item.matchMethod === 'fuzzy_candidate'));
  assert.equal(api.memory_search({ q: 'ComfyUj', pool: 'c', fuzzy: true }).total, 0);
  assert.equal(api.memory_search({ q: 'ComfyUj', pool: 'a2', fuzzy: true, date: '2026-01-01' }).total, 0);
});
