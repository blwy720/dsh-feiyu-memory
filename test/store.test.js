import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../lib/store.js';

function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-store-test-'));
  const args = { dataDir, instanceId: 'test-fish', now: () => new Date('2026-10-16T15:00:00Z'), ...options };
  const store = new MemoryStore(args);
  t.after(() => { store.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { store, dataDir, args };
}

function raw(store, values = {}) {
  return store.appendRaw({ sessionId: 'test-session', role: 'user', text: '如果我中了800万，我就买房。\n这只是设想。', pool: 'a', ...values });
}

test('exact original survives reopen, duplicate replay is idempotent, mismatch is rejected', t => {
  const { store, args, dataDir } = fixture(t);
  const original = raw(store, { id: 'original', recordedAt: '2026-10-16T11:00:00Z' });
  assert.equal(original.text, '如果我中了800万，我就买房。\n这只是设想。');
  assert.equal(original.occurredAt, null);
  raw(store, { id: 'original' });
  assert.equal(store.listRaw().length, 1);
  assert.throws(() => raw(store, { id: 'original', text: '改写' }), /different data/);
  store.close();
  const reopened = new MemoryStore(args);
  try {
    const { committed, projectionPending, ...canonical } = original;
    assert.equal(committed, true);
    assert.equal(projectionPending, false);
    assert.deepEqual(reopened.getRaw('original'), canonical);
    assert.equal(fs.readFileSync(path.join(dataDir, 'a/2026/10/16/raw.jsonl'), 'utf8').trim().split('\n').length, 1);
  } finally { reopened.close(); }
});

test('B stores only statistics and minimal replay receipts, not content or session identity', t => {
  const { store, args, dataDir } = fixture(t);
  const secret = 'B_POOL_SECRET_NEVER_PERSIST';
  const input = { id: 'solitude', sessionId: 'secret-session-name', role: 'assistant', text: secret, pool: 'b', recordedAt: '2026-10-16T01:20:00Z', entities: ['secret-entity'] };
  const result = store.appendRaw(input);
  assert.equal(result.text, undefined);
  assert.equal(result.recordedAt, undefined);
  assert.equal(result.count, 1);
  store.appendRaw(input);
  store.appendRaw({ ...input, recordedAt: undefined });
  assert.equal(store.dayStats('2026-10-16').b.total, 1);
  assert.deepEqual(store.dayStats('2026-10-16').b.hours, { '09': 1 });
  assert.equal(store.getRaw('solitude'), null);
  store.close();
  const reopened = new MemoryStore({ ...args, now: () => new Date('2027-01-01T00:00:00Z') });
  try {
    reopened.appendRaw(input);
    const replay = reopened.appendRaw({ ...input, recordedAt: undefined });
    assert.equal(replay.date, '2026-10-16');
    assert.equal(replay.hour, '09');
    assert.equal(reopened.dayStats('2026-10-16').b.total, 1);
    assert.equal(reopened.dayStats('2027-01-01').b.total, 0);
  } finally { reopened.close(); }
  const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(item => item.isDirectory() ? walk(path.join(directory, item.name)) : [path.join(directory, item.name)]);
  for (const file of walk(dataDir)) {
    const bytes = fs.readFileSync(file);
    for (const excluded of [secret, input.sessionId, 'secret-entity', '2026-10-16T01:20:00']) assert.equal(bytes.includes(Buffer.from(excluded)), false, `${excluded} leaked to ${file}`);
  }
});

test('evidence is exact original only; quote success never asserts support or independence', t => {
  const { store } = fixture(t);
  const source = raw(store, { id: 'raw1' });
  const entry = store.writeEntry({ id: 'memory1', kind: 'memory', text: '用户中了800万', hooks: ['彩票'], sources: [{ rawId: source.id, quote: '中了800万' }] });
  assert.equal(entry.evidenceStatus, 'quote_verified');
  assert.equal(entry.sources[0].support, 'unassessed');
  assert.equal(entry.sources[0].sourceNature, 'user_statement');
  assert.equal(entry.independentSourceCount, null);
  assert.equal(entry.currentValidity, 'unknown');
  assert.throws(() => store.writeEntry({ kind: 'memory', text: '摘要套摘要', sources: [{ rawId: entry.id, quote: '用户' }] }), /original raw/);
  assert.throws(() => store.writeEntry({ kind: 'memory', text: '错配', sources: [{ rawId: source.id, quote: '不在原文' }] }), /verbatim/);
  assert.throws(() => store.writeEntry({ kind: 'memory', text: '空引文', sources: [{ rawId: source.id, quote: '' }] }), /quote/);
});

test('immutable versions, doing statuses, and explicit aliases persist', t => {
  const { store } = fixture(t);
  const first = store.writeEntry({ id: 'todo', kind: 'doing', text: '待完成', hooks: ['模块'], project: 'demo', aliases: ['鱼'], entities: ['肥鱼'] });
  const second = store.writeEntry({ id: 'todo', kind: 'doing', text: '已完成', hooks: ['模块'], status: 'done' });
  assert.equal(first.status, 'pending');
  assert.equal(second.version, 2);
  assert.equal(store.getEntry('todo', { version: 1 }).text, '待完成');
  assert.equal(store.getEntry('todo').status, 'done');
  assert.deepEqual(store.getEntry('todo', { version: 1 }).aliases, ['鱼']);
  assert.equal(store.listEntries({ kind: 'doing', status: 'pending' }).length, 0);
  assert.throws(() => store.writeEntry({ id: 'todo', kind: 'entity', text: '不可改类别' }), /kind cannot change/);
  assert.throws(() => store.writeEntry({ kind: 'doing', text: '状态', status: 'confirmed_forever' }), /status/);
  assert.throws(() => store.db.prepare('UPDATE entries SET json=? WHERE id=?').run('{}', 'todo'), /immutable/);
});

test('legacy or unsupported entries remain unverified and audit only downgrades', t => {
  const { store } = fixture(t);
  const entry = store.writeEntry({ id: 'legacy', kind: 'memory', text: '没有原文的旧总结', legacy: { evidence_count: 8, confidence: 0.9, label: 'legacy_summary' } });
  assert.equal(entry.evidenceStatus, 'unverified');
  assert.equal(entry.independentSourceCount, null);
  const finding = store.audit()[0];
  assert.equal(finding.action, 'downgrade_only');
  assert.deepEqual(finding.reasons, ['no_original_evidence']);
  assert.equal(store.getEntry('legacy').auditDowngraded, true);
  assert.equal(store.getEntry('legacy').text, entry.text);
  assert.deepEqual(store.getEntry('legacy').legacy, entry.legacy);
});

test('both time axes filter independently; emotion tags do not exclude raw', t => {
  const { store } = fixture(t);
  raw(store, { id: 'history', occurredAt: '2025-12-24T12:00:00Z', recordedAt: '2026-10-16T01:00:00Z', tags: ['emotion:happy'], entities: ['小鱼'], project: 'demo' });
  raw(store, { id: 'other', recordedAt: '2026-10-15T16:01:00Z' });
  assert.equal(store.listRaw({ from: '2025-12-24', to: '2025-12-24' }).length, 1);
  assert.equal(store.listRaw({ from: '2025-12-24', to: '2025-12-24', timeAxis: 'recorded' }).length, 0);
  assert.equal(store.listRaw({ date: '2026-10-16' }).length, 2);
  assert.equal(store.listRaw({ entity: '小鱼', project: 'demo' })[0].id, 'history');
  assert.equal(store.listRaw({ limit: 1, offset: 1 }).length, 1);
  assert.throws(() => store.listRaw({ from: '../../secret' }), /timestamp/);
  assert.throws(() => store.listRaw({ date: '2026-02-30' }), /calendar/);
});

test('seven-day local window retains today and prior six local dates; unreviewed deletion blocks', t => {
  const { store } = fixture(t);
  raw(store, { id: 'old', recordedAt: '2026-10-09T15:59:59Z' }); // Oct 9 local, expires.
  raw(store, { id: 'boundary', recordedAt: '2026-10-09T16:00:00Z' }); // Oct 10 local, keep.
  raw(store, { id: 'today', recordedAt: '2026-10-16T00:00:00Z' });
  const preview = store.slide({ apply: false });
  assert.deepEqual(preview, { cutoff: '2026-10-10', eligible: 1, blocked: 1, removed: 0, retained: 0 });
  assert.equal(store.slide({ apply: true }).blocked, 1);
  assert.ok(store.getRaw('old'));
});

test('review then retain rescues entire original and every old version evidence remains readable', t => {
  const { store, args, dataDir } = fixture(t);
  raw(store, { id: 'rescued', recordedAt: '2026-09-01T00:00:00Z' });
  store.writeEntry({ id: 'cited', kind: 'memory', text: '设想买房', sources: [{ rawId: 'rescued', quote: '只是设想' }] });
  store.writeEntry({ id: 'cited', kind: 'memory', text: '当前版本无引用' });
  assert.throws(() => store.reviewRetention({ ids: ['rescued'], decision: 'discard', reason: '用户审阅' }), /Cited original/);
  store.reviewRetention({ ids: ['rescued'], decision: 'retain', reason: '保留原始上下文' });
  assert.equal(store.slide().retained, 1);
  const result = store.slide({ apply: true });
  assert.equal(result.removed, 1);
  assert.equal(store.listRaw().length, 0);
  assert.match(store.getRaw('rescued').text, /这只是设想/);
  assert.equal(store.audit().some(item => item.version === 1), false);
  assert.equal(fs.readFileSync(path.join(dataDir, 'a/2026/09/01/raw.jsonl'), 'utf8'), '');
  store.close();
  const reopened = new MemoryStore(args);
  try { assert.match(reopened.getRaw('rescued').text, /只是设想/); assert.equal(reopened.getEntry('cited', { version: 1 }).sources[0].rawId, 'rescued'); } finally { reopened.close(); }
});

test('explicit discard removes active content and its day projection, keeps only tombstone receipt', t => {
  const { store, args, dataDir } = fixture(t);
  raw(store, { id: 'discarded', text: 'UNIQUE_DISCARD_TEXT', recordedAt: '2026-09-01T00:00:00Z' });
  store.writeProjection('a/2026/09/01/_day.md', 'UNIQUE_DISCARD_TEXT');
  store.reviewRetention({ ids: ['discarded'], decision: 'discard', reason: '已人工审阅无需保留' });
  assert.equal(store.slide({ apply: true }).removed, 1);
  assert.equal(store.getRaw('discarded'), null);
  assert.equal(fs.existsSync(path.join(dataDir, 'a/2026/09/01/_day.md')), false);
  assert.throws(() => raw(store, { id: 'discarded', text: '重用 id' }), /different data/);
  store.close();
  const reopened = new MemoryStore(args);
  try { assert.equal(reopened.getRaw('discarded'), null); } finally { reopened.close(); }
});

test('retention reviews are transactional across a batch', t => {
  const { store } = fixture(t);
  raw(store, { id: 'valid', recordedAt: '2026-09-01T00:00:00Z' });
  assert.throws(() => store.reviewRetention({ ids: ['valid', 'missing'], decision: 'discard', reason: 'test' }), /active raw/);
  assert.equal(store.slide().blocked, 1);
});

test('raw and entries share one immutable ID namespace including A/B cross-pool replay', t => {
  const { store } = fixture(t);
  store.writeEntry({ id: 'entry-id', kind: 'memory', text: 'entry' });
  assert.throws(() => raw(store, { id: 'entry-id' }), /collides with entry/);
  raw(store, { id: 'raw-id' });
  assert.throws(() => store.writeEntry({ id: 'raw-id', kind: 'memory', text: 'entry' }), /collides with raw/);
  assert.throws(() => raw(store, { id: 'raw-id', pool: 'b' }), /different data/);
  raw(store, { id: 'b-id', pool: 'b' });
  assert.throws(() => raw(store, { id: 'b-id', pool: 'a' }), /different data/);
  assert.equal(store.dayStats('2026-10-16').b.total, 1);
  assert.equal(store.getRaw('b-id'), null);
});

test('partial same-day discard invalidates excerpts while blocked originals remain', t => {
  const { store, dataDir } = fixture(t);
  raw(store, { id: 'discard-partial', text: 'DISCARDED_EXCERPT', recordedAt: '2026-09-01T01:00:00Z' });
  raw(store, { id: 'unreviewed-partial', text: 'BLOCKED_TEXT', recordedAt: '2026-09-01T02:00:00Z' });
  store.writeProjection('a/2026/09/01/_day.md', 'DISCARDED_EXCERPT\nBLOCKED_TEXT');
  store.reviewRetention({ ids: ['discard-partial'], decision: 'discard', reason: '人工审阅' });
  const result = store.slide({ apply: true });
  assert.equal(result.removed, 1);
  assert.equal(result.blocked, 1);
  assert.equal(fs.existsSync(path.join(dataDir, 'a/2026/09/01/_day.md')), false);
  assert.equal(fs.readFileSync(path.join(dataDir, 'a/2026/09/01/raw.jsonl'), 'utf8').includes('DISCARDED_EXCERPT'), false);
  assert.equal(store.getRaw('unreviewed-partial').text, 'BLOCKED_TEXT');
});

test('retained originals remain searchable by opt-in without entering active raw again', t => {
  const { store } = fixture(t);
  raw(store, { id: 'rescue-search', recordedAt: '2026-09-01T00:00:00Z', entities: ['肥鱼'] });
  store.reviewRetention({ ids: ['rescue-search'], decision: 'retain', reason: '保留完整原文' });
  store.slide({ apply: true });
  assert.equal(store.listRaw().length, 0);
  assert.equal(store.listRaw({ includeRetained: true, entity: '肥鱼', from: '2026-09-01', to: '2026-09-01' })[0].id, 'rescue-search');
  assert.equal(store.listRaw({ includeRetained: true, date: '2026-09-02' }).length, 0);
});

test('restart finishes day invalidation after a retention SQL commit and projection failure', t => {
  const { store, dataDir, args } = fixture(t);
  raw(store, { id: 'crash-discard', text: 'CRASH_STALE_EXCERPT', recordedAt: '2026-09-01T00:00:00Z' });
  raw(store, { id: 'crash-keep', text: 'still active', recordedAt: '2026-09-01T01:00:00Z' });
  store.writeProjection('a/2026/09/01/_day.md', 'CRASH_STALE_EXCERPT\nstill active');
  store.reviewRetention({ ids: ['crash-discard'], decision: 'discard', reason: 'test' });
  store.flush = () => { throw new Error('simulated projection failure after SQL commit'); };
  assert.throws(() => store.slide({ apply: true }), /simulated projection failure/);
  store.close();
  const reopened = new MemoryStore(args);
  try {
    assert.equal(reopened.getRaw('crash-discard'), null);
    assert.equal(reopened.getRaw('crash-keep').text, 'still active');
    assert.equal(fs.existsSync(path.join(dataDir, 'a/2026/09/01/_day.md')), false);
    assert.equal(fs.readFileSync(path.join(dataDir, 'a/2026/09/01/raw.jsonl'), 'utf8').includes('CRASH_STALE_EXCERPT'), false);
  } finally { reopened.close(); }
});

test('restart repairs missing/corrupt projections from SQLite without changing original', t => {
  const { store, dataDir, args } = fixture(t);
  raw(store, { id: 'repair' });
  const file = path.join(dataDir, 'a/2026/10/16/raw.jsonl');
  fs.writeFileSync(file, '{partial');
  fs.unlinkSync(path.join(dataDir, 'index/entries.json'));
  store.close();
  const repaired = new MemoryStore(args);
  try {
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).id, 'repair');
    assert.ok(fs.existsSync(path.join(dataDir, 'index/entries.json')));
  } finally { repaired.close(); }
});

test('identity/timezone boundaries fail closed and separate instances never read each other', t => {
  const { store, dataDir, args } = fixture(t);
  raw(store, { id: 'only-mine' });
  assert.throws(() => new MemoryStore({ ...args, instanceId: 'other-fish' }), /identity/);
  assert.throws(() => new MemoryStore({ ...args, timezone: 'UTC' }), /timezone/);
  const other = fixture(t, { instanceId: 'other-fish' }).store;
  assert.equal(other.getRaw('only-mine'), null);
  fs.unlinkSync(path.join(dataDir, 'identity.json'));
  assert.throws(() => new MemoryStore({ ...args, instanceId: 'other-fish' }), /identity/);
});

test('unsafe paths and symlink escapes fail closed', t => {
  const { store, dataDir } = fixture(t);
  assert.throws(() => store.safePath('../secret'), /Unsafe/);
  assert.throws(() => store.safePath('a/../../secret'), /Unsafe/);
  assert.throws(() => store.safePath('file:stream'), /Unsafe/);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-outside-test-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const link = path.join(dataDir, 'escape');
  try { fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Symlink creation unavailable'); throw error; }
  assert.throws(() => store.writeProjection('escape/leak.txt', 'secret'), /Symlink/);
  assert.equal(fs.existsSync(path.join(outside, 'leak.txt')), false);
  fs.unlinkSync(link);
});

test('recall logs never retain query, snippets, or raw text by default', t => {
  const { store, dataDir } = fixture(t);
  const record = store.recordRecall({ action: 'search', q: 'secret query', text: 'secret original', snippet: 'secret excerpt', candidateIds: ['one'], count: 1 });
  assert.equal(record.q, undefined);
  store.flush();
  const log = fs.readFileSync(path.join(dataDir, 'logs/recall.jsonl'), 'utf8');
  assert.equal(log.includes('secret'), false);
  assert.equal(JSON.parse(log).candidateIds[0], 'one');
});

test('dictionary version is immutable and malformed timestamps cannot create dates', t => {
  const { store, dataDir } = fixture(t);
  assert.throws(() => raw(store, { recordedAt: '2026-02-30T00:00:00Z' }), /calendar/);
  assert.throws(() => raw(store, { occurredAt: 'yesterday' }), /timestamp/);
  assert.throws(() => raw(store, { recordedAt: '2026-10-16T25:00:00Z' }), /Invalid/);
  fs.writeFileSync(path.join(dataDir, 'dict/v1.md'), 'unauthorized changed dictionary');
  assert.throws(() => store.flush(), /Immutable dictionary/);
});
