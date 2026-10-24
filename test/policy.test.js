import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MemoryStore, DICTIONARY_V4 } from '../lib/store.js';

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-policy-synthetic-'));
  const clock = { now: '2026-10-20T12:00:00Z' };
  const args = { dataDir, instanceId: 'synthetic-policy', now: () => new Date(clock.now) };
  const stores = [];
  const open = () => { const store = new MemoryStore(args); stores.push(store); return store; };
  t.after(() => { for (const store of stores) store.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { store: open(), open, dataDir, args, clock };
}
function raw(store, id = 'raw', extras = {}) {
  return store.appendRaw({ id, pool: 'a', role: 'user', text: '我明确说过我喜欢红茶。', sessionId: 'test-session', recordedAt: '2026-09-01T10:00:00Z', ...extras });
}
function a2(store, id = 'a2', rawId = 'raw') {
  return store.writeEntry({ id, kind: 'memory', text: '用户明确表示喜欢红茶。', statementType: 'self_report', recordedAt: '2026-09-01T11:00:00Z', sources: [{ rawId, quote: '我喜欢红茶', support: 'supports' }] });
}
function a3Input(id = 'a3', parent = 'a2') {
  return { requestId: `write-${id}`, id, expectedVersion: 0, action: 'write', reason: '长期保留明确陈述', statementType: 'self_report', body: { time: '2026 年 9 月 1 日对话时', persons: ['用户'], event: '用户明确表示喜欢红茶，当前是否仍喜欢未知。' }, derivedFrom: [parent], coverage: { scope: [{ id: parent, version: 1 }], covered: [parent], notCovered: [], scopeNote: '仅处理该精确版本' } };
}
function core(store, id, extras = {}) {
  return store.assertCore({ requestId: `core-${id}`, id, expectedVersion: 0, kind: 'entity', text: id, statementType: 'fact', reason: '显式记录关系网', category: 'identity', ...extras });
}
function relation(store, id, from, to, extras = {}) {
  return core(store, id, { kind: 'relation', text: `${from}认为${to}是朋友`, category: 'relationship', from, to, rel: '朋友', ...extras });
}
function preference(id = 'preference', extras = {}) {
  return { requestId: `preference-${id}`, id, expectedVersion: 0, action: 'set', topic: '红茶', stance: 'like', text: '我喜欢红茶。', reason: '明确自述', ...extras };
}

test('A2/A3 reject inferred claims; self-contained archives preserve original conversation times independently', t => {
  const { store } = fixture(t); raw(store);
  assert.throws(() => store.writeEntry({ id: 'bad', kind: 'memory', text: '我推断', statementType: 'inference' }), /inference/);
  assert.throws(() => store.writeEntry({ id: 'bad', kind: 'memory', text: '伪装', statementType: 'fact', inference: {} }), /inference/);
  a2(store);
  assert.equal(store.getEntry('a2').semanticStatus, 'declared_only');
  assert.deepEqual(store.getEntry('a2').mentionedTimes, ['2026-09-01T10:00:00.000Z']);
  const input = a3Input();
  assert.throws(() => store.writeA3({ ...input, statementType: 'inference', inference: { reasoning: '猜测', uncertainty: '未知' } }), /inference/);
  assert.throws(() => store.writeA3({ ...input, body: undefined }), /body/);
  assert.throws(() => store.writeA3({ ...input, body: { ...input.body, persons: [] } }), /body/);
  store.writeA3(input);
  const archive = store.getEntry('a3');
  assert.equal(archive.statementType, 'self_report');
  assert.equal(archive.evidenceStatus, 'derived_only');
  assert.equal(archive.body.event, input.body.event);
  assert.equal(archive.sourceTimes[0].sessionId, 'test-session');
  assert.equal(archive.sourceTimes[0].recordedAt, '2026-09-01T10:00:00.000Z');
  const mock = t.mock.method(store, 'getRaw', () => { throw new Error('No live raw lookup allowed'); });
  assert.equal(store.getEntry('a3').lineageBroken, false);
  assert.equal(store.a3Stats().lineageBroken, 0); mock.mock.restore();
});

test('C has an independent inference path and undirected traversal keeps directed cyclic edges unchanged', t => {
  const { store } = fixture(t);
  core(store, 'user'); core(store, 'friend');
  relation(store, 'incoming', 'user', 'self', { statementType: 'inference', inference: { reasoning: '关系解释', uncertainty: '尚未经对方确认' } });
  relation(store, 'next', 'user', 'friend'); relation(store, 'loop', 'friend', 'self');
  const graph = store.graph({ depth: 2 });
  assert.equal(graph.nodes.length, 3); assert.equal(graph.edges.length, 3);
  assert.equal(graph.edges.find(edge => edge.id === 'incoming').from, 'user');
  assert.equal(graph.edges.find(edge => edge.id === 'incoming').to, 'self');
  assert.equal(store.listEntries({ pool: 'a2' }).length, 0, 'inference never traverses A2');
  assert.equal(store.getEntry('incoming').evidenceStatus, 'inference');
  store.audit(); assert.equal(store.getEntry('incoming').auditDowngraded, undefined);
  store.setCore({ requestId: 'remove-inference', id: 'incoming', expectedVersion: 1, action: 'revoke', reason: '撤回推断' });
  assert.equal(store.getEntry('incoming').pool, 'c'); assert.equal(store.getEntry('incoming').status, 'archived');
  assert.equal(store.listEntries({ pool: 'a2' }).length, 0);
});

test('B3 nonself declarations require first-hop active C scope and remain historical after the edge disappears', t => {
  const { store, open } = fixture(t); raw(store); core(store, 'user'); core(store, 'friend');
  relation(store, 'incoming', 'user', 'self'); relation(store, 'second-hop', 'user', 'friend');
  assert.throws(() => store.setPreference(preference('missing', { subject: 'user' })), /attributed/);
  const declaration = { subject: 'user', rawId: 'raw', quote: '我喜欢红茶' };
  const input = preference('user-tea', { subject: 'user', expressionKind: 'preference', target: 'self', declaration, sources: [{ rawId: 'raw', quote: '我喜欢红茶' }] });
  assert.throws(() => store.setPreference({ ...input, expressionKind: 'emotion' }), /Only self/);
  store.setPreference(preference('self-emotion', { expressionKind: 'emotion', topic: '开心', text: '我今天很开心。' }));
  store.setPreference(input);
  assert.equal(store.getEntry('user-tea').scopeEligible, true);
  assert.equal(store.getEntry('user-tea').target, 'self');
  assert.throws(() => store.setPreference(preference('friend-tea', { subject: 'friend', declaration: { ...declaration, subject: 'friend' }, sources: input.sources })), /first-degree/);
  assert.throws(() => store.setPreference({ ...input, requestId: 'swap', expectedVersion: 1, subject: 'self' }), /immutable/);
  store.setCore({ requestId: 'revoke-edge', id: 'incoming', expectedVersion: 1, action: 'revoke', reason: '关系不再有效' });
  assert.equal(store.getEntry('user-tea').scopeEligible, false);
  store.close(); const reopened = open();
  assert.equal(reopened.getEntry('user-tea').text, input.text);
  assert.equal(reopened.getEntry('user-tea').scopeEligible, false);
  const revoke = { requestId: 'revoke-user-tea', id: 'user-tea', expectedVersion: 1, action: 'revoke', reason: '可在范围消失后用最小参数撤回' };
  reopened.setPreference(revoke);
  assert.equal(reopened.getEntry('user-tea').subject, 'user');
  assert.equal(reopened.getEntry('user-tea').status, 'archived');
  assert.equal(reopened.setPreference(revoke).duplicate, true);
});

test('early review requests persist; failed coverage remains pending and cannot cause premature A1 deletion', t => {
  const { store, open } = fixture(t);
  raw(store, 'recent', { recordedAt: '2026-10-20T10:00:00Z' });
  assert.equal(store.listReviewQueue().total, 0);
  store.requestEarlyReview({ requestId: 'early', rawIds: ['recent'], reason: '当前轮的重要明确陈述' });
  assert.equal(store.listReviewQueue().items[0].earlyRequested, true);
  assert.throws(() => store.submitSelfReview({ requestId: 'failed', rawIds: ['recent'], reason: '缺少覆盖' }), /requires an output/);
  store.close(); const reopened = open(); assert.equal(reopened.listReviewQueue().total, 1);
  reopened.submitSelfReview({ requestId: 'reviewed', rawIds: ['recent'], omissions: [{ rawId: 'recent', reason: '明确选择不保留' }], reason: '完整审查' });
  assert.equal(reopened.listReviewQueue().total, 0);
  assert.equal(reopened.cleanupA1({ apply: true }).removed, 0);
  assert.ok(reopened.getRaw('recent'));
});

test('corrections are immutable exact-version events, propagate only explicit dependencies, and do not confuse later state change', t => {
  const { store } = fixture(t); raw(store); a2(store); store.writeA3(a3Input()); core(store, 'unlinked');
  store.setPreference(preference('linked', { dependencyEntries: [{ id: 'a2', version: 1 }] }));
  const old = store.db.prepare('SELECT json FROM entries WHERE id=? AND version=1').get('a3').json;
  const changed = { requestId: 'state', targets: [{ id: 'a2', version: 1 }], changeType: 'state_change', reason: '后来口味变了，过去的自述不因此错误。', sources: [{ rawId: 'raw', quote: '我喜欢红茶' }] };
  store.applyCorrection(changed);
  assert.equal(store.getEntry('a3').correctness.status, 'unreviewed');
  assert.equal(store.getEntry('a3').currentStateChanged, true);
  const corrected = { ...changed, requestId: 'dispute', changeType: 'correction', status: 'disputed', reason: '质疑此前归纳准确性' };
  store.applyCorrection(corrected);
  assert.equal(store.getEntry('a2').correctness.status, 'disputed');
  assert.equal(store.getEntry('a3').correctness.status, 'needs_review');
  assert.equal(store.getEntry('linked').correctness.status, 'needs_review');
  assert.equal(store.getEntry('unlinked').correctness.status, 'unreviewed');
  assert.equal(store.db.prepare('SELECT json FROM entries WHERE id=? AND version=1').get('a3').json, old);
  assert.equal(store.applyCorrection(corrected).duplicate, true);
  assert.throws(() => store.applyCorrection({ ...corrected, reason: '变更相同请求' }), /different payload/);
  assert.throws(() => store.db.exec('DELETE FROM correction_events'), /immutable/);
  assert.equal(store.reviewHistory({ id: 'a2' }).items.filter(item => item.type === 'correction').length, 2);
});

function reviewedParent(store, id = 'a2', rawId = 'raw') {
  raw(store, rawId);
  store.submitSelfReview({ requestId: `self-${id}`, rawIds: [rawId], reason: '完整覆盖', entries: [{ id, kind: 'memory', statementType: 'self_report', text: '用户明确自述喜欢红茶。', recordedAt: '2026-09-01T11:00:00Z', sources: [{ rawId, quote: '我喜欢红茶', support: 'supports' }] }] });
}
function retire(store, id = 'a2', a3Id = 'a3') {
  store.reviewA2({ requestId: `approve-${id}`, reason: '已逐条核准覆盖', items: [{ id, version: 1, decision: 'archived', a3Ids: [a3Id], reason: '明确归档覆盖' }] });
  store.retireA2({ apply: true });
}

test('explicit due A2 purge preserves self-contained A3 and lightweight provenance, cleans only eligible unreferenced raw', t => {
  const { store, open, dataDir } = fixture(t); reviewedParent(store); store.writeA3(a3Input());
  const input = { requestId: 'purge', items: [{ id: 'a2', version: 1 }], reason: '显式管理员容量清理' };
  assert.equal(store.purgeA2(input).blocked[0].reason, 'not_retired');
  retire(store); store.cleanupA1({ apply: true }); assert.ok(store.getRaw('raw'));
  assert.equal(store.purgeA2(input).ready, 1); assert.ok(store.db.prepare('SELECT 1 FROM entries WHERE id=?').get('a2'));
  const result = store.purgeA2({ ...input, apply: true });
  assert.equal(result.purged, 1); assert.equal(result.removedRaw, 1);
  assert.equal(store.getRaw('raw'), null);
  assert.equal(store.getEntry('a2', { version: 1 }).pruned, true);
  assert.equal(store.getEntry('a3').lineageBroken, false);
  assert.equal(store.getEntry('a3').body.persons[0], '用户');
  assert.equal(store.getEntry('a3').mentionedTimes[0], '2026-09-01T10:00:00.000Z');
  assert.equal(store.listEntries({ pool: 'a2' }).length, 0);
  store.close(); const reopened = open();
  assert.equal(reopened.purgeA2({ ...input, apply: true }).duplicate, true);
  assert.equal(reopened.getEntry('a3').lineageBroken, false);
  assert.equal(reopened.getRaw('raw'), null);
  assert.throws(() => reopened.appendRaw({ id: 'a2', text: 'reused', pool: 'a', role: 'user', sessionId: 'test-session' }), /collides/);
  const projections = fs.readdirSync(path.join(dataDir, 'originals'));
  assert.equal(projections.some(name => name.endsWith('.json')), false);
});

test('purge retains administrator-protected raw, blocks invalidated coverage, and preserves atomicity', t => {
  const { store } = fixture(t); reviewedParent(store); store.writeA3(a3Input()); retire(store);
  store.reviewRetention({ ids: ['raw'], decision: 'retain', reason: '管理员永久保留' });
  const input = { requestId: 'purge', items: [{ id: 'a2', version: 1 }], reason: '容量清理', apply: true };
  assert.throws(() => store.purgeA2({ ...input, items: [...input.items, { id: 'missing', version: 1 }] }), /blocked/);
  assert.ok(store.db.prepare('SELECT 1 FROM entries WHERE id=?').get('a2'));
  assert.equal(store.purgeA2(input).removedRaw, 0); assert.ok(store.getRaw('raw'));
  reviewedParent(store, 'other', 'raw-other'); store.writeA3(a3Input('other-a3', 'other')); retire(store, 'other', 'other-a3');
  store.writeA3({ requestId: 'revoke-a3', id: 'other-a3', expectedVersion: 1, action: 'revoke', reason: '覆盖归档已撤回' });
  assert.equal(store.purgeA2({ requestId: 'blocked', items: [{ id: 'other', version: 1 }], reason: '失效覆盖不可删' }).blocked[0].reason, 'review_no_longer_valid');
});

test('other live references prevent raw purge; a late purge failure rolls back deletion, receipts and projections', t => {
  const { store } = fixture(t); reviewedParent(store); store.writeA3(a3Input()); retire(store);
  store.setPreference(preference('raw-protector', { sources: [{ rawId: 'raw', quote: '我喜欢红茶' }] }));
  const first = store.purgeA2({ requestId: 'shared', items: [{ id: 'a2', version: 1 }], reason: '保留其他喜好上下文', apply: true });
  assert.equal(first.removedRaw, 0); assert.ok(store.getRaw('raw'));
  reviewedParent(store, 'separate', 'raw-separate'); store.writeA3(a3Input('separate-a3', 'separate')); retire(store, 'separate', 'separate-a3');
  store.cleanupA1({ apply: true });
  const input = { requestId: 'rollback', items: [{ id: 'separate', version: 1 }], reason: '整批失败需原样保留', apply: true };
  store.db.exec("CREATE TRIGGER fail_original_purge BEFORE DELETE ON originals WHEN OLD.id='raw-separate' BEGIN SELECT RAISE(ABORT,'synthetic original purge failure'); END");
  assert.throws(() => store.purgeA2(input), /synthetic original purge/);
  assert.ok(store.getRaw('raw-separate'));
  assert.equal(store.getEntry('separate').pruned, undefined);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM a2_purges WHERE entry_id='separate'").get().n, 0);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM original_purges WHERE raw_id='raw-separate'").get().n, 0);
  store.db.exec('DROP TRIGGER fail_original_purge');
  assert.equal(store.purgeA2(input).removedRaw, 1);
});

test('corrections still propagate through pruned A2 IDs and correction evidence is retained', t => {
  const { store } = fixture(t); reviewedParent(store); store.writeA3(a3Input()); retire(store);
  store.purgeA2({ requestId: 'purge', items: [{ id: 'a2', version: 1 }], reason: '正文已独立归档', apply: true });
  raw(store, 'correction-raw', { text: '之前归纳的那句话不准确。', recordedAt: '2026-10-20T11:00:00Z' });
  store.applyCorrection({ requestId: 'later', targets: [{ id: 'a2', version: 1 }], status: 'disputed', reason: '后来明确更正', sources: [{ rawId: 'correction-raw', quote: '那句话不准确' }] });
  assert.equal(store.getEntry('a3').correctness.status, 'needs_review');
  assert.equal(store.getEntry('a2').correctness.status, 'disputed');
  const history = store.reviewHistory({ id: 'a2' }).items.find(item => item.type === 'correction');
  assert.equal(history.evidence[0].quote, undefined);
  assert.ok(history.evidence[0].quoteLength > 0);
});

test('corrected first-hop entities lose B3 scope and disappear from graph expansion', t => {
  const { store } = fixture(t); raw(store); core(store, 'user'); relation(store, 'edge', 'user', 'self');
  store.setPreference(preference('user-tea', { subject: 'user', declaration: { subject: 'user', rawId: 'raw', quote: '我喜欢红茶' }, sources: [{ rawId: 'raw', quote: '我喜欢红茶' }] }));
  store.applyCorrection({ requestId: 'wrong-node', targets: [{ id: 'user', version: 1 }], status: 'needs_review', reason: '实体身份需要复核', sources: [{ rawId: 'raw', quote: '我喜欢红茶' }] });
  assert.equal(store.getEntry('user-tea').scopeEligible, false);
  assert.equal(store.graph().edges.length, 0);
});

test('actual released 0.4 schema 5 migration keeps old inference JSON and dictionary bytes unchanged', async t => {
  const { store, args, open, dataDir } = fixture(t); store.close();
  // Build the old database in a separate synthetic directory, never live data.
  fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir);
  const oldPath = process.env.FEIYU_PREVIOUS_PACKAGE ? path.join(process.env.FEIYU_PREVIOUS_PACKAGE, 'lib/store.js') : path.resolve(import.meta.dirname, '../../../outputs/feiyu-memory-v0.4.0/lib/store.js');
  const { MemoryStore: OldStore } = await import(pathToFileURL(oldPath));
  const old = new OldStore(args); raw(old); a2(old);
  const input = a3Input();
  old.writeA3({ ...input, text: '旧版推断归档', statementType: 'inference', inference: { reasoning: '旧版本允许推断', uncertainty: '未经验证' } });
  const before = old.db.prepare('SELECT id,version,json FROM entries ORDER BY id,version').all();
  const dictionary = fs.readFileSync(path.join(dataDir, 'dict/v4.md'), 'utf8');
  old.close();
  const upgraded = open(); assert.equal(upgraded.metadata().schema, 7);
  assert.deepEqual(upgraded.db.prepare('SELECT id,version,json FROM entries ORDER BY id,version').all(), before);
  assert.equal(upgraded.getEntry('a3').legacyInference, true);
  assert.equal(upgraded.getEntry('a3').statementType, 'inference');
  assert.equal(fs.readFileSync(path.join(dataDir, 'dict/v4.md'), 'utf8'), dictionary);
  assert.equal(dictionary, DICTIONARY_V4);
  assert.throws(() => upgraded.writeA3({ ...input, requestId: 'new-inference', expectedVersion: 1, statementType: 'inference' }), /inference/);
});
