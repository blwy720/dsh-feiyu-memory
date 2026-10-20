import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../lib/store.js';

function fixture(t, now = '2026-10-18T12:00:00.000Z') {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-self-review-'));
  const clock = { now };
  const args = { dataDir, instanceId: 'synthetic-fish', now: () => new Date(clock.now) };
  const stores = [];
  const open = () => { const store = new MemoryStore(args); stores.push(store); return store; };
  t.after(() => { for (const store of stores) store.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { store: open(), open, dataDir, clock };
}
function raw(store, id, extra = {}) {
  return store.appendRaw({ id, sessionId: 'fake-session', role: 'user', pool: 'a', text: `合成记录${id}：只是当时的陈述。`, recordedAt: '2026-10-11T12:00:00.000Z', ...extra });
}
function product(store, rawId, id = 'reviewed-entry', extra = {}) {
  return { id, kind: 'memory', text: '保留陈述，不推断当前真假。', sources: [{ rawId, quote: store.getRaw(rawId).text, support: 'context_only' }], ...extra };
}

test('queue waits exactly 168 hours, pages oldest first, and exposes no body or B content', t => {
  const { store, clock } = fixture(t);
  raw(store, 'due');
  raw(store, 'early', { recordedAt: '2026-10-11T12:00:00.001Z', occurredAt: '2020-01-01T00:00:00Z' });
  raw(store, 'oldest', { recordedAt: '2026-10-01T00:00:00Z' });
  raw(store, 'b-secret', { pool: 'b', text: 'NOT_A_REVIEW_INPUT', recordedAt: '2026-01-01T00:00:00Z' });
  const first = store.listReviewQueue({ limit: 1 });
  assert.equal(first.total, 2);
  assert.equal(first.items[0].rawId, 'oldest');
  assert.equal(first.hasMore, true);
  assert.equal(first.nextOffset, 1);
  const second = store.listReviewQueue({ limit: 1, offset: 1 });
  assert.equal(second.items[0].dueAt, clock.now);
  assert.deepEqual(second.items[0].read, { tool: 'memory_read', arguments: { id: 'due' } });
  assert.equal(second.items[0].text, undefined);
  assert.equal(second.hasMore, false);
  assert.equal(second.nextOffset, null);
  assert.equal(JSON.stringify(first).includes('NOT_A_REVIEW_INPUT'), false);
  clock.now = '2026-10-18T12:00:00.001Z';
  assert.equal(store.listReviewQueue().total, 3);
  for (const args of [{ limit: 0 }, { limit: 101 }, { offset: -1 }]) assert.throws(() => store.listReviewQueue(args), /pagination/);
});

test('full review persists A2 products and omissions, restarts idempotently without authorizing deletion', t => {
  const { store, open } = fixture(t);
  raw(store, 'keep'); raw(store, 'omit');
  const request = { requestId: 'review-one', rawIds: ['keep', 'omit'], entries: [product(store, 'keep')], omissions: [{ rawId: 'omit', reason: '仅重复问候，无新增信息。' }], reason: '完成本批七日自审。' };
  const result = store.submitSelfReview(request);
  assert.equal(result.completed, 2); assert.equal(result.committed, true);
  assert.equal(result.entries[0].pool, 'a2');
  assert.equal(store.getEntry('reviewed-entry').selfReview.requestId, 'review-one');
  assert.equal(store.listReviewQueue().total, 0);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM reviews').get().n, 0);
  assert.equal(store.slide().blocked, 2);
  store.close();
  const reopened = open();
  assert.equal(reopened.listReviewQueue().total, 0);
  assert.equal(reopened.submitSelfReview(request).duplicate, true);
  assert.equal(reopened.listEntries({ includeHistory: true }).length, 1);
  assert.equal(reopened.reviewHistory().total, 1);
  assert.throws(() => reopened.submitSelfReview({ ...request, reason: '不同负载' }), /different payload/);
  assert.throws(() => reopened.db.exec('DELETE FROM memory_decisions'), /immutable/);
  assert.throws(() => reopened.db.exec('DELETE FROM self_review_completed'), /immutable/);
  assert.equal(reopened.reviewHistory({ id: 'keep' }).items[0].type, 'self_review');
  assert.equal(reopened.reviewHistory({ id: 'reviewed-entry' }).total, 1);
});

test('late invalid product, silent omission, foreign source and premature raw all roll back atomically', t => {
  const { store } = fixture(t);
  raw(store, 'one'); raw(store, 'two');
  raw(store, 'future', { recordedAt: '2026-10-12T00:00:00Z' });
  const base = { requestId: 'retry-after-failure', rawIds: ['one', 'two'], entries: [product(store, 'one')], reason: '完整审查' };
  assert.throws(() => store.submitSelfReview(base), /output or explicit omission/);
  assert.equal(store.getEntry('reviewed-entry'), null);
  assert.equal(store.reviewHistory().total, 0);
  assert.throws(() => store.submitSelfReview({ ...base, entries: [product(store, 'one'), product(store, 'two', 'bad', { sources: [{ rawId: 'two', quote: '不存在的逐字引文' }] })] }), /verbatim/);
  assert.equal(store.listEntries().length, 0);
  assert.throws(() => store.submitSelfReview({ ...base, rawIds: ['one'], entries: [product(store, 'two')] }), /this batch/);
  assert.throws(() => store.submitSelfReview({ ...base, rawIds: ['future'], entries: [], omissions: [{ rawId: 'future', reason: '仍未到期' }] }), /not due/);
  assert.throws(() => store.submitSelfReview({ ...base, entries: [product(store, 'one', 'core', { pool: 'c' })] }), /pool a2/);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM evidence').get().n, 0);
  const done = store.submitSelfReview({ ...base, omissions: [{ rawId: 'two', reason: '本批明确省略' }] });
  assert.equal(done.completed, 2);
  assert.throws(() => store.submitSelfReview({ ...base, requestId: 'second-review' }), /already reviewed/);
});

test('queue includes rescued originals and self review preserves original-only evidence', t => {
  const { store } = fixture(t);
  raw(store, 'retained');
  store.reviewRetention({ ids: ['retained'], decision: 'retain', reason: '合成保留' });
  store.slide({ apply: true });
  assert.equal(store.listRaw().length, 0);
  assert.equal(store.listReviewQueue().items[0].rawId, 'retained');
  store.submitSelfReview({ requestId: 'retained-review', rawIds: ['retained'], entries: [product(store, 'retained')], reason: '审查已救回原文' });
  assert.equal(store.getEntry('reviewed-entry').sources[0].rawId, 'retained');
  assert.throws(() => store.writeEntry({ kind: 'memory', text: '不得摘要互证', sources: [{ rawId: 'reviewed-entry', quote: '保留陈述' }] }), /original raw/);
});

test('one review can create entities and directed relations atomically independent of product order', t => {
  const { store } = fixture(t);
  raw(store, 'network');
  const source = [{ rawId: 'network', quote: store.getRaw('network').text, support: 'supports' }];
  const result = store.submitSelfReview({ requestId: 'network-review', rawIds: ['network'], reason: '合成关系提取', entries: [
    { id: 'edge', kind: 'relation', text: '肥鱼称用户为主人', to: 'user', rel: '主人', sources: source },
    { id: 'user', kind: 'entity', text: '用户', sources: source },
  ] });
  assert.equal(result.entries.length, 2);
  assert.equal(store.getEntry('edge').pool, 'a2');
  assert.equal(store.graph().edges.length, 0);
  assert.equal(store.graph({ pool: 'a2' }).edges[0].rel, '主人');
});

test('review history is bounded, paged and linked without storing raw body in decisions', t => {
  const { store } = fixture(t);
  for (const id of ['a', 'b']) {
    raw(store, id);
    store.submitSelfReview({ requestId: `request-${id}`, rawIds: [id], reason: '审'.repeat(2000), omissions: [{ rawId: id, reason: '略'.repeat(2000) }] });
  }
  const history = store.reviewHistory({ limit: 1 });
  assert.equal(history.total, 2); assert.equal(history.hasMore, true);
  assert.equal(history.items[0].reason.length, 512);
  assert.equal(history.items[0].omissions[0].reason.length, 256);
  assert.equal(history.items[0].truncated, true);
  assert.equal(store.reviewHistory({ limit: 1, offset: 1 }).hasMore, false);
  assert.equal(JSON.stringify(history).includes('只是当时的陈述'), false);
  assert.throws(() => store.reviewHistory({ limit: 101 }), /pagination/);
  assert.throws(() => store.submitSelfReview({ requestId: 'large', rawIds: Array.from({ length: 21 }, (_, i) => `r${i}`), reason: '过量' }), /1\.\.20/);
});

test('large review backlogs return SQL-paged metadata without deserializing original bodies in JavaScript', t => {
  const { store } = fixture(t);
  for (const id of ['large-one', 'large-two', 'large-three']) raw(store, id, { text: 'BACKLOG_BODY_MARKER'.repeat(10000) });
  const originalParse = JSON.parse;
  const mock = t.mock.method(JSON, 'parse', (value, ...args) => {
    assert.equal(String(value).includes('BACKLOG_BODY_MARKER'), false, 'queue must not parse a raw body');
    return originalParse(value, ...args);
  });
  const queue = store.listReviewQueue({ limit: 1, offset: 1 });
  mock.mock.restore();
  assert.equal(queue.total, 3); assert.equal(queue.items.length, 1);
  assert.equal(queue.items[0].textLength, 190000);
  assert.ok(JSON.stringify(queue).length < 1000);
});
