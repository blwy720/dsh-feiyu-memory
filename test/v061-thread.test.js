import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../lib/store.js';
import { createTools } from '../lib/tools.js';

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-v061-thread-'));
  const options = { dataDir, instanceId: 'thread-fixture', now: () => new Date('2026-10-24T12:00:00Z') };
  const stores = []; const open = () => { const store = new MemoryStore(options); stores.push(store); return store; };
  t.after(() => { for (const store of stores) store.close(); assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir())); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { store: open(), open };
}
const raw = (store, id, extra = {}) => store.appendRaw({ id, text: `原文 ${id}：抓取状态的独立记录`, role: 'user', pool: 'a', sessionId: 's-old', turnId: 'turn-1', recordedAt: '2026-10-10T12:00:00Z', ...extra });
const omit = (store, id) => store.submitSelfReview({ requestId: `review-${id}`, rawIds: [id], reason: '已检查本条记录', omissions: [{ rawId: id, reason: '没有需要另行提纯的内容' }] });
const link = (store, requestId, rawIds, extra = {}) => store.linkThread({ requestId, threadId: 'issue-fetch', title: '抓取故障', rawIds, reason: '同一事项后续', ...extra });

test('A1 weak thread links span sessions without changing originals, receipts or capture replay', t => {
  const { store, open } = fixture(t);
  const record = { id: 'r1', text: '这次已经修好', role: 'assistant', pool: 'a', sessionId: 's-old', turnId: 't-old', recordedAt: '2026-10-10T12:00:00Z' };
  store.captureMessage({ id: 'capture-1', pool: 'a', role: 'assistant', records: [record] });
  raw(store, 'r2', { sessionId: 's-new', turnId: 't-new', recordedAt: '2026-10-17T12:00:00Z' });
  const before = store.db.prepare('SELECT id,json FROM raw ORDER BY id').all();
  const receipts = store.db.prepare('SELECT * FROM receipts ORDER BY id').all();
  const input = { requestId: 'link-main', threadId: 'issue-fetch', title: '抓取故障', rawIds: ['r1', 'r2'], reason: '先修好后再次出现' };
  store.linkThread(input); assert.equal(store.linkThread(input).duplicate, true);
  link(store, 'link-second-issue', ['r1'], { threadId: 'issue-sibling' });
  assert.equal(store.getRaw('r1').threadCount, 2);
  assert.equal(store.getRaw('r1').threads[0].retention, 'weak');
  assert.deepEqual(store.db.prepare('SELECT id,json FROM raw ORDER BY id').all(), before);
  assert.deepEqual(store.db.prepare('SELECT * FROM receipts ORDER BY id').all(), receipts);
  assert.equal(store.verifyCaptureMessage({ id: 'capture-1', pool: 'a', role: 'assistant', records: [record] }), true);
  assert.equal(store.captureMessage({ id: 'capture-1', pool: 'a', role: 'assistant', records: [record] }).duplicate, true);
  const result = store.readThread({ threadId: 'issue-fetch' });
  assert.deepEqual(result.items.map(item => item.sessionId), ['s-old', 's-new']);
  assert.equal(result.items[0].recordType, 'raw'); assert.equal(result.items[0].availability, 'available');
  assert.equal(result.items[0].read.arguments.kind, 'raw');
  assert.throws(() => store.linkThread({ ...input, rawIds: ['r1'] }), /different payload/);
  store.close(); const reopened = open(); assert.equal(reopened.getRaw('r1').threadCount, 2);
  assert.equal(reopened.readThread({ threadId: 'issue-fetch' }).total, 2);
});

test('unlink targets one immutable link event and leaves later or other-issue associations intact', t => {
  const { store } = fixture(t); raw(store, 'r1'); raw(store, 'r2');
  link(store, 'link-1', ['r1', 'r2']); link(store, 'link-2', ['r1']);
  const input = { requestId: 'unlink-1', threadId: 'issue-fetch', linkRequestId: 'link-1', rawIds: ['r1'], reason: '第一次挂接有误' };
  store.unlinkThread(input); assert.equal(store.unlinkThread(input).duplicate, true);
  assert.equal(store.getRaw('r1').threads[0].requestId, 'link-2'); assert.equal(store.readThread({ threadId: 'issue-fetch' }).total, 2);
  store.unlinkThread({ ...input, requestId: 'unlink-2', linkRequestId: 'link-2', rawIds: undefined });
  assert.equal(store.getRaw('r1').threads, undefined); assert.equal(store.getRaw('r2').threadCount, 1);
  assert.throws(() => store.unlinkThread({ ...input, requestId: 'again' }), /already unlinked/);
  assert.throws(() => store.unlinkThread({ ...input, requestId: 'wrong-thread', threadId: 'other' }), /not found/);
  assert.throws(() => store.db.exec("DELETE FROM workflow_events WHERE kind='thread'"), /immutable/);
});

test('thread navigation is weak: reviewed A1 can be cleaned, real A2 evidence stays, and unlink survives cleanup', t => {
  const { store } = fixture(t); raw(store, 'weak'); raw(store, 'strong');
  store.writeEntry({ id: 'evidence-entry', kind: 'memory', text: '有真实来源的记忆', sources: [{ rawId: 'strong', quote: store.getRaw('strong').text }] });
  link(store, 'navigation', ['weak', 'strong']); omit(store, 'weak'); omit(store, 'strong');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM workflow_sources').get().n, 0);
  assert.equal(store._rawIsCited('weak'), false); assert.equal(store._rawIsCited('strong'), true);
  store.cleanupA1({ apply: true });
  assert.equal(store.getRaw('weak'), null); assert.ok(store.getRaw('strong'));
  const items = store.readThread({ threadId: 'issue-fetch', include: 'raw' }).items;
  assert.equal(items.find(item => item.rawId === 'weak').availability, 'cleared');
  assert.equal(items.find(item => item.rawId === 'weak').read, null);
  assert.equal(items.find(item => item.rawId === 'strong').availability, 'available');
  store.unlinkThread({ requestId: 'remove-cleared', threadId: 'issue-fetch', linkRequestId: 'navigation', rawIds: ['weak'], reason: '移除已清理记录的导航' });
  assert.equal(store.readThread({ threadId: 'issue-fetch' }).total, 1);
});

test('mixed thread pages respect the response budget and freeze links/unlinks without skipping', t => {
  const { store } = fixture(t); for (let i = 0; i < 6; i++) raw(store, `r${i}`);
  store.writeEntry({ id: 'entry', kind: 'memory', text: '事项总结', sources: [{ rawId: 'r0', quote: store.getRaw('r0').text }] });
  link(store, 'mixed', ['r0', 'r1', 'r2', 'r3', 'r4'], { entries: [{ id: 'entry', version: 1 }] });
  const first = store.readThread({ threadId: 'issue-fetch', budget: 1600, limit: 100 });
  assert.ok(JSON.stringify(first).length <= 1600); assert.equal(first.hasMore, true);
  link(store, 'late', ['r5']); store.unlinkThread({ requestId: 'unlink-during-read', threadId: 'issue-fetch', linkRequestId: 'mixed', rawIds: ['r4'], reason: '后续解除' });
  const collected = [...first.items]; let cursor = first.nextCursor;
  while (cursor) { const page = store.readThread({ threadId: 'issue-fetch', cursor, budget: 1600 }); assert.ok(JSON.stringify(page).length <= 1600); collected.push(...page.items); cursor = page.nextCursor; }
  assert.equal(collected.length, 6); assert.equal(new Set(collected.map(item => `${item.recordType}:${item.id}`)).size, 6);
  assert.ok(collected.some(item => item.id === 'r4')); assert.ok(!collected.some(item => item.id === 'r5'));
  assert.throws(() => store.readThread({ threadId: 'issue-fetch', cursor: first.nextCursor, include: 'raw' }), /mismatch/);
  assert.equal(store.readThread({ threadId: 'issue-fetch', include: 'entries' }).total, 1);
  store.unlinkThread({ requestId: 'unlink-entry', threadId: 'issue-fetch', linkRequestId: 'mixed', entries: [{ id: 'entry', version: 1 }], reason: '取消条目导航' });
  assert.equal(store.getEntry('entry').threads, undefined);
});

test('thread link rejects missing or excessive inputs atomically, and empty read remains bounded', t => {
  const { store } = fixture(t); raw(store, 'r1');
  assert.throws(() => link(store, 'bad', ['r1', 'missing']), /Missing original/);
  assert.equal(store.getRaw('r1').threads, undefined);
  assert.throws(() => link(store, 'duplicate', ['r1', 'r1']), /unique/);
  assert.throws(() => link(store, 'empty', []), /1..50/);
  const result = store.readThread({ threadId: 'nothing', budget: 800 }); assert.equal(result.total, 0); assert.equal(result.nextCursor, null);
});

test('broken original references remain visible as missing or hash mismatch instead of silently disappearing', t => {
  const { store } = fixture(t); raw(store, 'missing'); raw(store, 'changed'); link(store, 'integrity-links', ['missing', 'changed']);
  // Deliberately corrupt this disposable synthetic fixture to exercise read
  // diagnostics. Production writers cannot perform either operation.
  store.db.exec('DROP TRIGGER guarded_raw_delete; DROP TRIGGER immutable_raw;');
  store.db.prepare('DELETE FROM raw WHERE id=?').run('missing');
  store.db.prepare("UPDATE raw SET json=json_set(json,'$.text',?) WHERE id=?").run('损坏后替换的正文', 'changed');
  const items = store.readThread({ threadId: 'issue-fetch' }).items;
  assert.equal(items.length, 2);
  assert.equal(items.find(item => item.id === 'missing').availability, 'missing');
  assert.equal(items.find(item => item.id === 'changed').availability, 'hash_mismatch');
  assert.ok(items.every(item => item.read === null));
});

test('public thread pages count timezone conversion and preserve exact entry read pointers', t => {
  const { store } = fixture(t); const api = createTools(store);
  for (let i = 0; i < 4; i++) raw(store, `public-${i}`);
  store.writeEntry({ id: 'public-entry', kind: 'memory', text: '公开入口检查', sources: [{ rawId: 'public-0', quote: store.getRaw('public-0').text }] });
  link(store, 'public-link', ['public-0', 'public-1', 'public-2', 'public-3'], { entries: [{ id: 'public-entry', version: 1 }] });
  const items = []; let cursor;
  do {
    const page = api.memory_manage({ action: 'read_thread', thread: { threadId: 'issue-fetch', budget: 1400, ...(cursor ? { cursor } : {}) } });
    assert.ok(JSON.stringify(page).length <= 1400); assert.equal(page.timeZone, store.timezone);
    items.push(...page.items); cursor = page.nextCursor;
  } while (cursor);
  assert.equal(items.length, 5);
  assert.deepEqual(items.find(item => item.id === 'public-entry').read, { tool: 'memory_read', arguments: { id: 'public-entry', version: 1 } });
});

test('colon-containing IDs cannot collide across independent link events', t => {
  const { store } = fixture(t); raw(store, 'r2'); raw(store, 'r1:raw:r2');
  link(store, 'link:raw:r1', ['r2']); link(store, 'link', ['r1:raw:r2']);
  assert.equal(store.readThread({ threadId: 'issue-fetch' }).total, 2);
  store.unlinkThread({ requestId: 'remove-one', threadId: 'issue-fetch', linkRequestId: 'link', reason: '只解除这一条' });
  assert.equal(store.readThread({ threadId: 'issue-fetch' }).items[0].id, 'r2');
  assert.equal(store.getRaw('r2').threadCount, 1);
});

test('entity displayName is optional, validated and retained across C revisions while history is immutable', t => {
  const { store } = fixture(t);
  const input = { requestId: 'entity-1', id: 'person', expectedVersion: 0, kind: 'entity', category: 'identity', statementType: 'self_report', text: '某位人物的完整身份说明', displayName: '姐姐', reason: '明确短名称' };
  store.assertCore(input); const first = store.db.prepare('SELECT json FROM entries WHERE id=? AND version=1').get('person').json;
  store.assertCore({ ...input, requestId: 'entity-2', expectedVersion: 1, displayName: undefined, text: '人物身份说明的新版本' });
  assert.equal(store.getEntry('person').displayName, '姐姐'); assert.equal(store.getEntry('person', { version: 1 }).displayName, '姐姐');
  assert.equal(store.db.prepare('SELECT json FROM entries WHERE id=? AND version=1').get('person').json, first);
  for (const invalid of ['', null, 'a\nb', 'a\rb', 'a\tb', 'a'.repeat(49)]) assert.throws(() => store.assertCore({ ...input, requestId: 'invalid', expectedVersion: 2, displayName: invalid }), /displayName/);
  store.assertCore({ ...input, requestId: 'legacy', id: 'unnamed', displayName: undefined });
  assert.equal(store.getEntry('unnamed').displayName, undefined);
  assert.throws(() => store.writeEntry({ id: 'wrong-kind', kind: 'memory', text: '正文', displayName: '名称' }), /only valid for entities/);
});

test('B3 quote mismatch returns exact original candidates and UTF16 location without weakening comparison', t => {
  const { store } = fixture(t); raw(store, 'p', { text: '😀 我喜欢：`牛肉面`。' });
  const input = { requestId: 'preference', id: 'pref', expectedVersion: 0, action: 'set', subject: 'self', topic: '食物', stance: 'like', text: '喜欢牛肉面', reason: '记录喜好', sources: [{ rawId: 'p', quote: '我喜欢:牛肉面。' }] };
  assert.throws(() => store.setPreference(input), error => error.code === 'QUOTE_MISMATCH' && error.details.offsetUnit === 'utf16' && error.details.candidates[0].text === '😀 我喜欢：`牛肉面`。');
  assert.equal(store.getEntry('pref'), null);
  store.setPreference({ ...input, sources: [{ rawId: 'p', quote: '我喜欢：`牛肉面`。' }] });
  assert.equal(store.getEntry('pref').contextEvidenceStatus, 'quote_verified');
});

test('physically missing synthetic evidence still downgrades audit and permits C/B3 revocation', t => {
  const { store } = fixture(t); raw(store, 'missing-context', { text: '合成身份与喜好上下文' });
  const sources = [{ rawId: 'missing-context', quote: '合成身份与喜好上下文' }];
  store.assertCore({ requestId: 'entity-with-source', id: 'person', expectedVersion: 0, kind: 'entity', category: 'identity', statementType: 'self_report', text: '人物', sources, reason: '合成来源' });
  store.setPreference({ requestId: 'preference-with-source', id: 'pref', expectedVersion: 0, action: 'set', topic: '食物', stance: 'like', text: '喜欢面', sources, reason: '合成喜好' });
  store.db.exec('DROP TRIGGER guarded_raw_delete');
  store.db.prepare('DELETE FROM raw WHERE id=?').run('missing-context');
  assert.equal(store.getRaw('missing-context'), null);
  const findings = store.audit(); assert.ok(findings.some(item => item.entryId === 'pref' && item.scope === 'context'));
  assert.equal(store.getEntry('pref').contextEvidenceStatus, 'unverified');
  store.setCore({ requestId: 'remove-broken-person', id: 'person', expectedVersion: 1, action: 'revoke', reason: '来源已损坏但必须能撤回' });
  store.setPreference({ requestId: 'remove-broken-pref', id: 'pref', expectedVersion: 1, action: 'revoke', reason: '来源已损坏但必须能撤回' });
  assert.equal(store.getEntry('person').pool, 'a2'); assert.equal(store.getEntry('person').evidenceStatus, 'unverified');
  assert.equal(store.getEntry('pref').status, 'archived');
});
