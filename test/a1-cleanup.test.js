import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore, DICTIONARY_V2, DICTIONARY_V3 } from '../lib/store.js';

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-a1-cleanup-'));
  const clock = { now: '2026-10-18T12:00:00.000Z' }; const stores = [];
  const open = () => { const store = new MemoryStore({ dataDir, instanceId: 'synthetic-a1', now: () => new Date(clock.now) }); stores.push(store); return store; };
  t.after(() => { for (const store of stores) store.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { store: open(), open, clock, dataDir };
}
function raw(store, id, extra = {}) {
  return store.appendRaw({ id, pool: 'a', role: 'user', sessionId: 'synthetic', text: `合成原始陈述-${id}`, recordedAt: '2026-10-11T12:00:00.000Z', ...extra });
}
function omitted(store, ids, requestId = 'review-omissions') {
  return store.submitSelfReview({ requestId, rawIds: ids, reason: '明确检查每条原文。', omissions: ids.map(rawId => ({ rawId, reason: '未提取新的记忆。' })) });
}

test('A1 maintenance uses exact 168 hours and requires self review even with administrator approval', t => {
  const { store, clock } = fixture(t);
  raw(store, 'due'); raw(store, 'unreviewed'); raw(store, 'admin-unreviewed');
  raw(store, 'early', { recordedAt: '2026-10-11T12:00:00.001Z' });
  raw(store, 'solitude', { pool: 'b' });
  omitted(store, ['due']);
  store.reviewRetention({ ids: ['admin-unreviewed'], decision: 'discard', reason: '管理员旧决定不替代自审。' });
  const preview = store.cleanupA1();
  assert.equal(preview.eligible, 3); assert.equal(preview.ready, 1); assert.equal(preview.pendingReview, 2); assert.equal(preview.removed, 0);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM deletion_tombstones').get().n, 0);
  const applied = store.cleanupA1({ apply: true });
  assert.equal(applied.removed, 1); assert.equal(applied.retained, 0);
  assert.deepEqual(store.listRaw().map(r => r.id).sort(), ['admin-unreviewed', 'early', 'unreviewed']);
  assert.equal(store.dayStats('2026-10-11').b.total, 1);
  clock.now = '2026-10-18T12:00:00.001Z';
  assert.equal(store.cleanupA1({ apply: true }).removed, 0, 'newly due but unreviewed remains');
  assert.equal(store.listReviewQueue().total, 3);
  assert.throws(() => store.cleanupA1({ apply: 'yes' }), /boolean/);
});

test('A1 maintenance preserves cited originals and administrator retains without replacing prior decisions', t => {
  const { store, open } = fixture(t);
  for (const id of ['cited', 'retained', 'discarded', 'later-cited']) raw(store, id);
  store.reviewRetention({ ids: ['retained'], decision: 'retain', reason: '管理员明确保留。' });
  store.reviewRetention({ ids: ['discarded', 'later-cited'], decision: 'discard', reason: '当时尚未被引用。' });
  const oldReviews = store.db.prepare('SELECT seq,json FROM reviews ORDER BY seq').all();
  const cite = id => ({ id: `entry-${id}`, kind: 'memory', text: '留存有据陈述。', sources: [{ rawId: id, quote: store.getRaw(id).text, support: 'context_only' }] });
  store.submitSelfReview({ requestId: 'review-citations', rawIds: ['cited', 'retained', 'discarded', 'later-cited'], reason: '完成全部原文的自审。', entries: [cite('cited'), cite('later-cited')], omissions: [{ rawId: 'retained', reason: '无需提炼但尊重管理员保留。' }, { rawId: 'discarded', reason: '无需继续保留。' }] });
  const result = store.cleanupA1({ apply: true });
  assert.equal(result.removed, 4); assert.equal(result.retained, 3); assert.equal(result.pendingReview, 0);
  assert.equal(store.listRaw().length, 0);
  assert.deepEqual(store.listRaw({ includeRetained: true }).map(r => r.id).sort(), ['cited', 'later-cited', 'retained']);
  assert.equal(store.getRaw('discarded'), null);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM reviews').get().n, 4);
  for (const row of oldReviews) assert.equal(store.db.prepare('SELECT json FROM reviews WHERE seq=?').get(row.seq).json, row.json);
  const automatic = JSON.parse(store.db.prepare('SELECT json FROM reviews WHERE raw_id=?').get('cited').json);
  assert.equal(automatic.selfReviewRequestId, 'review-citations');
  const later = JSON.parse(store.db.prepare('SELECT json FROM deletion_tombstones WHERE raw_id=?').get('later-cited').json);
  assert.equal(later.decision, 'retain'); assert.equal(later.selfReviewRequestId, 'review-citations');
  assert.equal(store.audit().filter(f => f.entryId).length, 0);
  store.close(); const reopened = open();
  assert.equal(reopened.cleanupA1({ apply: true }).removed, 0);
  assert.equal(reopened.getRaw('cited').text, '合成原始陈述-cited');
  assert.equal(reopened.getRaw('discarded'), null);
  raw(reopened, 'discarded');
  assert.equal(reopened.getRaw('discarded'), null, 'capture replay does not resurrect discarded body');
  assert.throws(() => reopened.db.exec('DELETE FROM originals'), /immutable/);
  assert.throws(() => reopened.db.exec('DELETE FROM deletion_tombstones'), /immutable/);
});

test('a late A1 deletion failure rolls back reviews, rescued originals, tombstones and the entire batch', t => {
  const { store } = fixture(t);
  raw(store, 'a-first'); raw(store, 'z-last');
  omitted(store, ['a-first', 'z-last']);
  store.db.exec("CREATE TRIGGER synthetic_failure BEFORE DELETE ON raw WHEN OLD.id='z-last' BEGIN SELECT RAISE(ABORT,'synthetic late failure'); END;");
  assert.throws(() => store.cleanupA1({ apply: true }), /synthetic late failure/);
  assert.equal(store.listRaw().length, 2);
  for (const table of ['reviews', 'originals', 'deletion_tombstones', 'dirty_days']) assert.equal(store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
  assert.throws(() => store.db.exec("DELETE FROM raw WHERE id='a-first'"), /retention API/);
  store.db.exec('DROP TRIGGER synthetic_failure');
  assert.equal(store.cleanupA1({ apply: true }).removed, 2);
});

test('A1 projection failures preserve durable deletion state and retry without retaining stale day excerpts', t => {
  const { store, open, dataDir } = fixture(t);
  raw(store, 'omit'); raw(store, 'keep-unreviewed'); omitted(store, ['omit']);
  const day = path.join(dataDir, 'a', '2026', '10', '11', '_day.md');
  store.writeProjection('a/2026/10/11/_day.md', '合成原始陈述-omit');
  const originalUnlink = fs.unlinkSync; const originalRename = fs.renameSync;
  fs.unlinkSync = function (target, ...args) { if (String(target) === day) throw Object.assign(new Error('synthetic locked day'), { code: 'EPERM' }); return originalUnlink.call(this, target, ...args); };
  fs.renameSync = function (source, target, ...args) { if (String(target).endsWith(path.join('2026', '10', '11', 'raw.jsonl'))) throw Object.assign(new Error('synthetic locked raw projection'), { code: 'EPERM' }); return originalRename.call(this, source, target, ...args); };
  let result;
  try { result = store.cleanupA1({ apply: true }); } finally { fs.unlinkSync = originalUnlink; fs.renameSync = originalRename; }
  assert.equal(result.removed, 1); assert.equal(result.projectionPending, true);
  assert.equal(store.getRaw('omit'), null); assert.equal(store.getRaw('keep-unreviewed').text, '合成原始陈述-keep-unreviewed');
  store.close(); const reopened = open();
  assert.equal(reopened.projectionStatus().pending, false);
  assert.equal(fs.existsSync(day), false);
  assert.equal(fs.readFileSync(path.join(dataDir, 'a', '2026', '10', '11', 'raw.jsonl'), 'utf8').includes('原始陈述-omit'), false);
  assert.equal(reopened.cleanupA1({ apply: true }).removed, 0);
});

test('v3 explains reviewed A1 exit and B2 fourteen-day deletion while v2 remains unchanged', () => {
  assert.match(DICTIONARY_V3, /满 168 小时且已完成自审/);
  assert.match(DICTIONARY_V3, /14×24 小时滑动删除/);
  assert.match(DICTIONARY_V3, /未审先保留/);
  assert.match(DICTIONARY_V2, /不授予删除原文的权限/);
  assert.doesNotMatch(DICTIONARY_V2, /B2：/);
});
