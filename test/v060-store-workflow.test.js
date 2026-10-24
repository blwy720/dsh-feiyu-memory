import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MemoryStore } from '../lib/store.js';

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-v060-store-')); const clock = { now: '2026-10-24T12:00:00.000Z' }; const stores = [];
  const open = () => { const store = new MemoryStore({ dataDir, instanceId: 'synthetic-workflow', now: () => new Date(clock.now) }); stores.push(store); return store; };
  t.after(() => { for (const store of stores) store.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { store: open(), clock, open, dataDir };
}
function raw(store, id, text = `原文${id}：合成检查结果`, extra = {}) { return store.appendRaw({ id, text, role: 'user', pool: 'a', sessionId: 'session-a', recordedAt: '2026-10-10T12:00:00.000Z', ...extra }); }
function entry(store, id, rawId, extra = {}) { return store.writeEntry({ id, kind: 'memory', text: `记忆${id}`, sources: [{ rawId, quote: store.getRaw(rawId).text, support: 'context_only' }], ...extra }); }
function omit(store, id, requestId = `review-${id}`) { return store.submitSelfReview({ requestId, rawIds: [id], reason: '本项已经检查，记录省略理由', omissions: [{ rawId: id, reason: '合成无新增事项' }] }); }

test('D preserves external versus raw provenance, validation levels, versions, and recovery projections', t => {
  const { store, open, dataDir } = fixture(t);
  const request = { requestId: 'learn-method', id: 'method', purpose: '在本机验证合成操作', conditions: ['测试环境'], method: '运行已知测试并检查结果', validationStatus: 'learned', environment: { name: 'Node', version: '24' }, externalSources: [{ url: 'https://example.com/manual', title: '合成文档' }], reason: '保留方法' };
  const result = store.writeKnowledge(request);
  assert.equal(result.entry.pool, 'd'); assert.equal(result.entry.evidenceStatus, 'external_reference'); assert.equal(result.entry.currentValidity, 'unknown');
  assert.equal(store.audit().length, 0); assert.equal(store.listEntries({ pool: 'd' }).length, 1);
  assert.throws(() => store.writeKnowledge({ ...request, requestId: 'bad-verify', validationStatus: 'verified', expectedVersion: 1 }), /evidence/);
  raw(store, 'validation', '运行测试：通过；环境 Node 24');
  const updated = store.writeKnowledge({ ...request, requestId: 'verify-method', expectedVersion: 1, validationStatus: 'verified', validation: { method: '执行测试', result: '合成测试通过', sources: [{ rawId: 'validation', quote: '运行测试：通过' }] } });
  assert.equal(updated.version, 2); assert.equal(updated.entry.validation.autoVerified, false); assert.equal(store.getEntry('method', { version: 1 }).validationStatus, 'learned');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM evidence WHERE raw_id=?').get('validation').n, 1);
  const versionPath = path.join(dataDir, 'd', createHash('sha256').update('method').digest('hex'), 'v2.json'); assert.equal(fs.existsSync(versionPath), true);
  store.close(); const reopened = open(); assert.equal(reopened.writeKnowledge(request).duplicate, true); assert.equal(reopened.getEntry('method').version, 2); assert.equal(reopened.metadata().schema, 7);
});

test('validity is a version-specific append-only declared check, separate from quote match and expiry', t => {
  const { store, clock } = fixture(t); raw(store, 'fact'); entry(store, 'item', 'fact'); raw(store, 'check', '今天检查：该状态仍成立');
  const before = store.db.prepare('SELECT json FROM entries WHERE id=? AND version=1').get('item').json;
  assert.equal(store.getEntry('item').currentValidity, 'unknown');
  assert.throws(() => store.reviewValidity({ requestId: 'no-check', targets: [{ id: 'item', version: 1 }], currentValidity: 'valid', reason: '只有引文', sources: [{ rawId: 'check', quote: '今天检查' }] }), /check.method/);
  const input = { requestId: 'check-item', targets: [{ id: 'item', version: 1 }], currentValidity: 'valid', reason: '明确复核', check: { method: '合成复查', result: '通过' }, sources: [{ rawId: 'check', quote: '今天检查：该状态仍成立' }], reviewAfter: '2026-10-25T12:00:00.000Z' };
  store.reviewValidity(input); assert.equal(store.reviewValidity(input).duplicate, true);
  assert.equal(store.getEntry('item').currentValidity, 'valid'); assert.equal(store.getEntry('item').evidenceStatus, 'quote_verified'); assert.equal(store.getEntry('item').version, 1);
  assert.equal(store.db.prepare('SELECT json FROM entries WHERE id=? AND version=1').get('item').json, before);
  clock.now = '2026-10-26T12:00:00.000Z'; assert.equal(store.getEntry('item').reviewDue, true); assert.equal(store.getEntry('item').currentValidity, 'valid');
  entry(store, 'item', 'fact', { expectedVersion: 1 }); assert.equal(store.getEntry('item').currentValidity, 'unknown'); assert.equal(store.getEntry('item', { version: 1 }).currentValidity, 'valid');
  omit(store, 'check'); store.cleanupA1({ apply: true }); assert.ok(store.getRaw('check')); assert.ok(store.db.prepare('SELECT 1 FROM originals WHERE id=?').get('check'));
  assert.throws(() => store.db.exec('DELETE FROM workflow_events'), /immutable/); assert.throws(() => store.db.exec('DELETE FROM workflow_sources'), /immutable/);
});

test('cross-session event lines retain exact versions and frozen pagination', t => {
  const { store } = fixture(t); raw(store, 'r1', '十七号修好', { sessionId: 'session-old' }); raw(store, 'r2', '二十四号又坏', { sessionId: 'session-new' });
  entry(store, 'issue', 'r1'); entry(store, 'issue', 'r2', { expectedVersion: 1 });
  store.linkThread({ requestId: 'thread-start', threadId: 'issue-fetch', title: '抓取事项', entries: [{ id: 'issue', version: 1 }, { id: 'issue', version: 2 }], reason: '同一事项的变化' });
  const first = store.readThread({ threadId: 'issue-fetch', limit: 1 }); assert.equal(first.items[0].version, 1);
  entry(store, 'issue', 'r2', { expectedVersion: 2 }); store.linkThread({ requestId: 'thread-later', threadId: 'issue-fetch', entries: [{ id: 'issue', version: 3 }], reason: '进一步更正' });
  const second = store.readThread({ threadId: 'issue-fetch', limit: 1, cursor: first.nextCursor }); assert.equal(second.items[0].version, 2); assert.equal(second.hasMore, false);
  assert.equal(store.readThread({ threadId: 'issue-fetch' }).total, 3); assert.equal(store.getEntry('issue', { version: 1 }).threads[0].threadId, 'issue-fetch');
  assert.throws(() => store.readThread({ threadId: 'other', cursor: first.nextCursor }), /cursor/);
});

test('merge is atomic, source-preserving and reversible without rewriting parents or identity merging', t => {
  const { store } = fixture(t); raw(store, 'one'); raw(store, 'two'); entry(store, 'a', 'one'); entry(store, 'b', 'two');
  const targets = [{ id: 'a', version: 1 }, { id: 'b', version: 1 }];
  const sources = ['one', 'two'].map(rawId => ({ rawId, quote: store.getRaw(rawId).text }));
  const request = { requestId: 'merge-ab', targets, reason: '同一事项压缩', entry: { id: 'combined', kind: 'memory', text: '合成合并内容', sources } };
  assert.throws(() => store.mergeEntries({ ...request, entry: { ...request.entry, sources: sources.slice(0, 1) } }), /retain every/); assert.equal(store.getEntry('combined'), null);
  store.mergeEntries(request); assert.equal(store.getEntry('a').mergedInto[0].id, 'combined'); assert.equal(store.getEntry('combined').lineage.parents.length, 2);
  assert.equal(store.getEntry('a').version, 1); assert.equal(store.mergeEntries(request).duplicate, true);
  store.revokeMerge({ requestId: 'revoke-ab', mergeRequestId: 'merge-ab', reason: '需要恢复分开记录' });
  assert.equal(store.getEntry('a').mergedInto, undefined); assert.equal(store.getEntry('combined').status, 'archived'); assert.equal(store.getEntry('combined').mergeState, 'revoked'); assert.equal(store.getEntry('combined').sources.length, 2);
  assert.throws(() => store.mergeEntries({ ...request, requestId: 'bad-kind', entry: { ...request.entry, id: 'entity', kind: 'entity' } }), /preserve entry kind/);
});

test('review cursor does not skip when prior items disappear and progress notices late arrivals; reports count commits only', t => {
  const { store } = fixture(t); for (const id of ['a', 'b', 'c']) raw(store, id);
  const first = store.listReviewQueue({ limit: 1 }); assert.equal(first.items[0].rawId, 'a');
  const result = omit(store, 'a'); assert.equal(result.completed, 1); omit(store, 'a');
  assert.throws(() => store.submitSelfReview({ requestId: 'failed', rawIds: ['b'], entries: [], reason: '缺少处理' }), /coverage|omission|covered|accounted/i);
  raw(store, 'late', '迟到导入', { recordedAt: '2026-10-01T12:00:00.000Z' });
  const second = store.listReviewQueue({ limit: 1, cursor: first.nextCursor }); assert.equal(second.items[0].rawId, 'b'); omit(store, 'b');
  const third = store.listReviewQueue({ limit: 1, cursor: second.nextCursor }); assert.equal(third.items[0].rawId, 'c'); assert.equal(third.hasMore, false);
  assert.equal(store.listReviewQueue({ limit: 1 }).items[0].rawId, 'late'); assert.equal(store.reviewProgress().oldestUnreviewed.id, 'late');
  const report = store.reviewDailyReport({ date: '2026-10-24' }); assert.equal(report.successfulCommits, 2); assert.equal(report.reviewedRaw, 2); assert.equal(report.byType.self_review, 2); assert.equal(report.items.some(item => item.requestId === 'failed'), false);
});

test('quote diagnostics return original exact slices but formatting variants still fail', t => {
  const { store } = fixture(t); raw(store, 'markdown', '其它话题\n安装 `ComfyUI`：成功\n结束');
  assert.throws(() => store.writeEntry({ id: 'bad', kind: 'memory', text: '安装成功', sources: [{ rawId: 'markdown', quote: '安装 ComfyUI:成功' }] }), error => {
    assert.equal(error.code, 'QUOTE_MISMATCH'); assert.equal(error.details.candidates[0].text, '安装 `ComfyUI`：成功');
    assert.equal(store.getRaw('markdown').text.slice(error.details.candidates[0].offset, error.details.candidates[0].offset + error.details.candidates[0].length), error.details.candidates[0].text); return true;
  });
  assert.equal(store.getEntry('bad'), null);
});

test('redaction precedes persistence and hashes; derived excerpts cannot become independent new evidence', t => {
  const { store, dataDir } = fixture(t); raw(store, 'original', '旧知识：确切原文'); entry(store, 'origin-memory', 'original');
  const text = '回忆内容二十字这是旧记忆的复述并非新的实验结果。\n今天做了新实验：通过';
  raw(store, 'echo', text, { role: 'assistant', derivedFromMemory: [{ id: 'origin-memory', version: 1 }], derivedFromRaw: ['original'], derivedSpans: [{ start: 0, end: text.indexOf('\n') }] });
  const derived = store.writeEntry({ id: 'derived', kind: 'memory', text: '旧内容再述', sources: [{ rawId: 'echo', quote: '旧记忆的复述' }] }); assert.equal(derived.evidenceStatus, 'derived_only'); assert.equal(derived.sources[0].independent, false);
  const fresh = store.writeEntry({ id: 'fresh', kind: 'memory', text: '新实验声明', sources: [{ rawId: 'echo', quote: '今天做了新实验：通过' }] }); assert.equal(fresh.evidenceStatus, 'quote_verified'); assert.equal(fresh.sources[0].independent, undefined); assert.equal(fresh.semanticStatus, 'declared_only');
  assert.throws(() => store.reviewValidity({ requestId: 'echo-check', targets: [{ id: 'derived', version: 1 }], currentValidity: 'valid', reason: '重复自证', check: { method: '复述', result: '确信' }, sources: [{ rawId: 'echo', quote: '旧记忆的复述' }] }), /Derived/);
  assert.throws(() => raw(store, 'cycle', '错误链', { derivedFromRaw: ['cycle'] }), /another existing/);
  const secret = 'sk-' + 'abcdefghijklmnopqrstuvwxyz123456789'; const redacted = raw(store, 'secret', `api_key=${secret}`); assert.equal(redacted.text.includes(secret), false); assert.equal(redacted.redaction.applied, true);
  store.flush(); assert.equal(fs.readFileSync(path.join(dataDir, 'a', '2026', '10', '10', 'raw.jsonl'), 'utf8').includes(secret), false);
  assert.equal(store.db.prepare('SELECT json FROM raw WHERE id=?').get('secret').json.includes(secret), false);
});

test('A2 keyset cursor survives retirement of the first page', t => {
  const { store } = fixture(t); raw(store, 'r');
  for (const id of ['a', 'b', 'c']) entry(store, id, 'r', { recordedAt: '2026-09-01T12:00:00.000Z' });
  const first = store.listA2ReviewQueue({ limit: 1 }); assert.equal(first.items[0].id, 'a');
  store.reviewA2({ requestId: 'retire-a', items: [{ id: 'a', version: 1, decision: 'discard', reason: '不再有用' }], reason: '已完成审查' }); store.retireA2({ apply: true });
  const next = store.listA2ReviewQueue({ limit: 1, cursor: first.nextCursor }); assert.equal(next.items[0].id, 'b');
});

test('daily ledger includes ordinary and B2 writes, counts multi-product review once, and commits atomically', t => {
  const { store, dataDir } = fixture(t); for (const id of ['a', 'b', 'c', 'd']) raw(store, id);
  entry(store, 'a-entry', 'a'); entry(store, 'b-entry', 'b'); entry(store, 'a-entry', 'a', { expectedVersion: 1 });
  const b2 = { requestId: 'b2-save', id: 'web-note', expectedVersion: 0, action: 'write', text: '关键发现', judgment: '尚未验证', sources: [{ url: 'https://example.com/find', title: '合成页面' }], reason: '保存冲浪发现' };
  store.writeB2(b2); store.writeB2(b2);
  store.submitSelfReview({ requestId: 'review-cd', rawIds: ['c', 'd'], entries: ['c', 'd'].map(id => ({ id: `${id}-entry`, kind: 'memory', text: `审查产物${id}`, sources: [{ rawId: id, quote: store.getRaw(id).text }] })), reason: '同批两项提炼' });
  const report = store.reviewDailyReport({ date: '2026-10-24' });
  assert.equal(report.successfulCommits, 5); assert.equal(report.added, 5); assert.equal(report.updated, 1); assert.equal(report.reviewedRaw, 2);
  assert.equal(report.items.find(item => item.decisions.some(decision => decision.requestId === 'review-cd')).entries.length, 2);
  assert.ok(report.historyCoverageStartsAt); assert.equal(fs.existsSync(path.join(dataDir, 'logs', 'daily', '2026-10-24.json')), true);
  const page = store.reviewDailyReport({ date: '2026-10-24', limit: 1 }); entry(store, 'late-write', 'a');
  const next = store.reviewDailyReport({ date: '2026-10-24', limit: 1, cursor: page.nextCursor }); assert.equal(next.successfulCommits, 5);
  store.db.exec("CREATE TRIGGER reject_test_ledger BEFORE INSERT ON workflow_events WHEN NEW.kind='entry_commit' BEGIN SELECT RAISE(ABORT,'synthetic ledger failure'); END");
  assert.throws(() => entry(store, 'failed-write', 'a'), /synthetic ledger/); assert.equal(store.getEntry('failed-write'), null);
  assert.throws(() => store.writeB2({ ...b2, requestId: 'b2-failed', id: 'failed-web' }), /synthetic ledger/); assert.equal(store.getB2('failed-web'), null);
  store.db.exec('DROP TRIGGER reject_test_ledger');
  assert.equal(store.reviewDailyReport({ date: '2026-10-24' }).successfulCommits, 6);
});

test('capture replay preserves original provenance; legacy secret records replay without rewriting historical bytes', t => {
  const { store } = fixture(t); raw(store, 'origin'); entry(store, 'origin-entry', 'origin');
  const originalInput = { id: 'replay', text: '合成回忆文本', role: 'assistant', pool: 'a', sessionId: 'session-a', recordedAt: '2026-10-10T12:00:00.000Z', derivedFromMemory: [{ id: 'origin-entry', version: 1 }], captureSource: 'assistant' };
  store.appendRaw(originalInput); const first = store.db.prepare('SELECT json FROM raw WHERE id=?').get('replay').json;
  store.appendRaw({ ...originalInput, derivedFromMemory: [], derivedFromRaw: [] }); assert.equal(store.db.prepare('SELECT json FROM raw WHERE id=?').get('replay').json, first);
  assert.throws(() => store.appendRaw({ ...originalInput, sourceNature: 'changed_source' }), /different data/);
  const secret = 'sk-' + 'legacyabcdefghijklmnopqrstuvwxyz'; const input = { id: 'legacy-secret', text: `api_key=${secret}`, role: 'user', pool: 'a', sessionId: 'legacy-session', recordedAt: '2026-10-10T12:00:00.000Z' };
  const legacy = store._prepareRaw(input); legacy.text = input.text; delete legacy.redaction;
  store._transaction(() => store._commitRaw(legacy)); const before = store.db.prepare('SELECT json FROM raw WHERE id=?').get(input.id).json;
  store.appendRaw({ ...input, captureSource: 'human' }); assert.equal(store.db.prepare('SELECT json FROM raw WHERE id=?').get(input.id).json, before);
  assert.equal(store.getRaw(input.id).redaction, undefined);
  assert.throws(() => store.appendRaw({ ...input, text: 'different body' }), /different data/);
});

test('derived raw chains preserve memory ancestry for later corrections and late checks do not replace newer validity', t => {
  const { store, clock } = fixture(t); raw(store, 'original'); entry(store, 'origin-entry', 'original');
  raw(store, 'echo-one', '旧内容的复述', { role: 'assistant', derivedFromMemory: [{ id: 'origin-entry', version: 1 }] });
  raw(store, 'echo-two', '旧内容的复述', { role: 'assistant', derivedFromRaw: ['echo-one'] });
  entry(store, 'derived', 'echo-two'); assert.equal(store.getEntry('derived').dependencyEntries[0].id, 'origin-entry');
  raw(store, 'correction', '原条目需要更正'); store.applyCorrection({ requestId: 'fix', targets: [{ id: 'origin-entry', version: 1 }], status: 'disputed', reason: '原始更正声明', sources: [{ rawId: 'correction', quote: '原条目需要更正' }] });
  assert.equal(store.getEntry('derived').correctness.status, 'needs_review');
  const check = { targets: [{ id: 'origin-entry', version: 1 }], reason: '按检查时间更新', check: { method: '合成检查', result: '状态结果' }, sources: [{ rawId: 'correction', quote: '原条目需要更正' }] };
  store.reviewValidity({ ...check, requestId: 'check-now', currentValidity: 'invalid' });
  clock.now = '2026-10-25T12:00:00.000Z'; store.reviewValidity({ ...check, requestId: 'late-check', currentValidity: 'valid', checkedAt: '2026-10-23T12:00:00.000Z' });
  assert.equal(store.getEntry('origin-entry').currentValidity, 'invalid');
});

test('invalid dependencies flag learned/merged content for review and revocation refreshes disk; merged output keeps explicit issue links', t => {
  const { store, dataDir } = fixture(t); raw(store, 'a'); raw(store, 'b'); raw(store, 'check', '这项当前无效'); entry(store, 'a-entry', 'a'); entry(store, 'b-entry', 'b');
  store.linkThread({ requestId: 'issue-link', threadId: 'explicit-issue', title: '明确事项', entries: [{ id: 'a-entry', version: 1 }], reason: '显式关联' });
  store.writeKnowledge({ requestId: 'derived-method', id: 'method', purpose: '复用合成方法', conditions: [], method: '合成方法', validationStatus: 'learned', dependencyEntries: [{ id: 'a-entry', version: 1 }], reason: '来自精确记忆版本' });
  const valid = { targets: [{ id: 'method', version: 1 }], reason: '合成复核', check: { method: '合成检查', result: '合成结果' }, sources: [{ rawId: 'check', quote: '这项当前无效' }] };
  store.reviewValidity({ ...valid, requestId: 'check-method', currentValidity: 'valid' });
  store.mergeEntries({ requestId: 'merge-issue', targets: [{ id: 'a-entry', version: 1 }, { id: 'b-entry', version: 1 }], entry: { id: 'combined', kind: 'memory', text: '合并结论', sources: ['a', 'b'].map(rawId => ({ rawId, quote: store.getRaw(rawId).text })) }, reason: '保留已有事项关联' });
  assert.equal(store.getEntry('combined').threads[0].threadId, 'explicit-issue'); assert.equal(store.getEntry('combined').threads[0].derived, true);
  store.reviewValidity({ ...valid, requestId: 'invalidate-source', targets: [{ id: 'a-entry', version: 1 }], currentValidity: 'invalid' });
  assert.equal(store.getEntry('method').dependencyReviewPending, true); assert.equal(store.getEntry('method').currentValidity, 'valid'); assert.equal(store.getEntry('method').correctness.status, 'unreviewed');
  assert.equal(store.getEntry('combined').dependencyReviewPending, true);
  store.revokeMerge({ requestId: 'undo-issue', mergeRequestId: 'merge-issue', reason: '恢复分开记录' });
  const file = path.join(dataDir, 'a2', createHash('sha256').update('combined').digest('hex'), 'current.json'); assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).status, 'archived');
});

test('a relation explicitly checked invalid no longer grants first-hop B3 scope', t => {
  const { store } = fixture(t); raw(store, 'r', '主人是直接相连的人，主人喜欢面条');
  store.assertCore({ requestId: 'person-core', id: 'person', expectedVersion: 0, kind: 'entity', text: '主人', category: 'identity', statementType: 'fact', sources: [{ rawId: 'r', quote: '主人' }], reason: '明确身份' });
  store.assertCore({ requestId: 'edge-core', id: 'edge', expectedVersion: 0, kind: 'relation', from: 'self', to: 'person', rel: '主人', text: '直接关系', category: 'relationship', statementType: 'fact', sources: [{ rawId: 'r', quote: '主人是直接相连的人' }], reason: '明确关系' });
  const preference = { requestId: 'pref', id: 'person-pref', expectedVersion: 0, action: 'set', subject: 'person', topic: '吃饭', stance: 'like', text: '喜欢面条', reason: '记录喜好', sources: [{ rawId: 'r', quote: '主人喜欢面条' }], declaration: { rawId: 'r', quote: '主人喜欢面条', subject: 'person' } };
  store.setPreference(preference); assert.equal(store.getEntry('person-pref').scopeEligible, true);
  store.reviewValidity({ requestId: 'edge-invalid', targets: [{ id: 'edge', version: 1 }], currentValidity: 'invalid', reason: '关系已经变更', check: { method: '明确声明', result: '旧关系当前无效' }, sources: [{ rawId: 'r', quote: '主人是直接相连的人' }] });
  assert.equal(store.getEntry('person-pref').scopeEligible, false);
  assert.throws(() => store.setPreference({ ...preference, requestId: 'pref-later', id: 'new-pref' }), /first-degree/);
});
