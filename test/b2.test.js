import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { MemoryStore } from '../lib/store.js';
import fs from 'node:fs';

function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'feiyu-b2-'));
  let clock = '2026-10-01T04:00:00.000Z';
  const options = { dataDir, instanceId: 'b2-fish', now: () => new Date(clock) };
  let current = new MemoryStore(options);
  t.after(() => { current.close(); assert.equal(dirname(resolve(dataDir)), resolve(tmpdir())); assert.ok(dataDir.includes('feiyu-b2-')); rmSync(dataDir, { recursive: true, force: true }); });
  const input = { requestId: 'b2-request', id: 'web-note', expectedVersion: 0, action: 'write', text: '关键发现：测试来源描述了一个机制。', judgment: '我的判断：仍需其他来源核对。', reason: '独处冲浪时明确记录关键发现。', sources: [{ url: 'https://example.org/research', title: '合成研究页面', accessedAt: clock }], hooks: ['研究'] };
  return { get store() { return current; }, dataDir, input, setClock(value) { clock = value; }, reopen() { current.close(); current = new MemoryStore(options); return current; } };
}

test('B2 stores concise independent discoveries and versioned judgments without original evidence claims', t => {
  const f = fixture(t); const store = f.store;
  const saved = store.writeB2(f.input);
  assert.equal(saved.version, 1); assert.equal(saved.evidenceStatus, 'external_reference');
  assert.equal(store.writeB2(f.input).duplicate, true);
  const note = store.getB2(saved.id);
  assert.equal(note.kind, 'b2'); assert.equal(note.pool, 'b2'); assert.deepEqual(note.sources, []);
  assert.equal(note.externalSources[0].url, 'https://example.org/research');
  assert.equal(note.judgment, f.input.judgment); assert.equal(note.currentValidity, 'unknown');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM raw').get().n, 0);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM evidence').get().n, 0);
  const update = { ...f.input, requestId: 'update', expectedVersion: 1, judgment: '修正判断：只能算线索。' };
  store.writeB2(update);
  assert.equal(store.getB2('web-note', { version: 1 }).judgment, f.input.judgment);
  assert.equal(store.getB2('web-note', { version: 2 }).judgment, update.judgment);
  assert.equal(store.getB2('web-note', { version: 3 }), null);
  assert.throws(() => store.writeB2({ ...f.input, requestId: 'stale', expectedVersion: 1 }), /version conflict/);
  store.writeB2({ requestId: 'revoke', id: 'web-note', expectedVersion: 2, action: 'revoke', reason: '撤回这条当前发现' });
  assert.equal(store.getB2('web-note').status, 'archived');
});

test('B2 expires at exactly fourteen days; edits, idempotent retries and rebuild cannot extend or resurrect it', t => {
  const f = fixture(t); let store = f.store;
  store.appendRaw({ id: 'unrelated', sessionId: 'main', role: 'user', pool: 'a', text: 'A1独立原文', recordedAt: '2026-10-01T04:00:00Z' });
  store.writeB2(f.input);
  f.setClock('2026-10-14T04:00:00.000Z');
  store.writeB2({ ...f.input, requestId: 'later-update', expectedVersion: 1, text: '更新关键发现。' });
  assert.equal(store.getB2('web-note').expiresAt, '2026-10-15T04:00:00.000Z');
  f.setClock('2026-10-15T03:59:59.999Z'); assert.ok(store.getB2('web-note'));
  f.setClock('2026-10-15T04:00:00.000Z');
  assert.equal(store.getB2('web-note'), null); assert.deepEqual(store.listB2(), []);
  assert.equal(store.cleanupB2().eligible, 1); assert.equal(store.db.prepare('SELECT count(*) AS n FROM b2_notes').get().n, 2);
  assert.throws(() => store.writeB2({ ...f.input, requestId: 'late', expectedVersion: 2 }), /expired/);
  assert.equal(store.cleanupB2({ apply: true }).removed, 1);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM b2_notes').get().n, 0);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM b2_expirations').get().n, 1);
  const durableReceipts = JSON.stringify(store.db.prepare('SELECT * FROM b2_requests').all());
  assert.ok(!durableReceipts.includes(f.input.text)); assert.ok(!durableReceipts.includes('example.org'));
  assert.equal(store.writeB2(f.input).expired, true);
  assert.equal(store.writeB2(f.input).duplicate, true);
  assert.throws(() => store.writeB2({ ...f.input, requestId: 'new-but-same-id' }), /expired/);
  store.flush(); store = f.reopen();
  assert.equal(store.getB2('web-note', { version: 1 }), null);
  assert.equal(store.getRaw('unrelated').text, 'A1独立原文');
  assert.equal(store.cleanupB2({ apply: true }).removed, 0);
  const hash = createHash('sha256').update('web-note').digest('hex');
  assert.equal(existsSync(join(f.dataDir, 'b2', hash, 'v1.json')), false);
  assert.equal(existsSync(join(f.dataDir, 'b2', hash, 'v2.json')), false);
  assert.equal(existsSync(join(f.dataDir, 'b2', hash, 'current.json')), false);
  assert.deepEqual(JSON.parse(readFileSync(join(f.dataDir, 'b2/index.json'), 'utf8')), []);
});

test('B2 validates sources and quotas and keeps pool, id and request ownership isolated', t => {
  const { store, input } = fixture(t);
  for (const url of ['file:///secret', 'javascript:alert(1)', 'https://name:secret@example.org/', `https://example.org/${'汉'.repeat(500)}`]) {
    assert.throws(() => store.writeB2({ ...input, sources: [{ ...input.sources[0], url }] }));
  }
  for (const change of [{ text: 'x'.repeat(601) }, { judgment: 'x'.repeat(601) }, { sources: [] }, { sources: [{ ...input.sources[0], accessedAt: '2026-10-02T04:00:00Z' }] }, { sources: [{ ...input.sources[0], accessedAt: '2026-02-30T04:00:00Z' }] }, { pool: 'a3' }, { sources: [{ ...input.sources[0], rawId: 'fake' }] }]) assert.throws(() => store.writeB2({ ...input, ...change }));
  assert.equal(store.listB2().length, 0);
  store.writeB2(input);
  assert.throws(() => store.writeB2({ ...input, text: '同请求号不同内容' }), /different payload/);
  assert.throws(() => store.writeEntry({ id: input.id, kind: 'memory', text: '冒充A2', sources: [] }), /colli|B2|id/i);
  assert.throws(() => store.appendRaw({ id: input.id, sessionId: 'main', role: 'user', pool: 'a', text: '冒充原文' }), /colli|B2|id/i);
  assert.throws(() => store.setPreference({ requestId: input.requestId, id: 'preference', expectedVersion: 0, action: 'set', topic: '主题', stance: 'like', text: '我的喜好', reason: '测试请求号隔离' }), /requestId|B2/);
  store.writeEntry({ id: 'a2-existing', kind: 'memory', text: '另一条A2', sources: [] });
  assert.throws(() => store.writeB2({ ...input, requestId: 'other', id: 'a2-existing' }), /collides/);
  assert.throws(() => store.writeEntry({ kind: 'memory', text: '不能把B2当原文', sources: [{ rawId: input.id, quote: input.text }] }), /original raw/);
});

test('B2 expiry deletion is guarded and rejected writes do not leave partial versions', t => {
  const { store, input } = fixture(t); store.writeB2(input);
  assert.throws(() => store.db.prepare('DELETE FROM b2_notes WHERE id=?').run(input.id), /expiry cleanup/);
  assert.throws(() => store.db.exec('INSERT OR REPLACE INTO b2_notes SELECT * FROM b2_notes'), /immutable/);
  store.db.exec("CREATE TRIGGER abort_b2_receipt BEFORE INSERT ON b2_requests WHEN NEW.request_id='abort-write' BEGIN SELECT RAISE(ABORT,'simulated commit failure'); END;");
  assert.throws(() => store.writeB2({ ...input, requestId: 'abort-write', expectedVersion: 1 }), /simulated/);
  assert.equal(store.getB2(input.id).version, 1);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM b2_notes').get().n, 1);
});

test('B2 committed writes and expiry cleanup recover from projection sharing locks without resurrection', t => {
  const f = fixture(t); const store = f.store;
  const hash = createHash('sha256').update(f.input.id).digest('hex');
  const target = join(f.dataDir, 'b2', hash, 'current.json');
  const denied = () => Object.assign(new Error('controlled B2 sharing lock'), { code: 'EPERM' });
  const rename = fs.renameSync;
  const writeLock = t.mock.method(fs, 'renameSync', (from, to) => { if (to === target) throw denied(); return rename(from, to); });
  const saved = store.writeB2(f.input);
  assert.equal(saved.committed, true); assert.equal(saved.projectionPending, true);
  assert.equal(store.getB2(f.input.id).version, 1);
  writeLock.mock.restore(); store.flush(); assert.equal(store.projectionStatus().projectionPending, false);
  assert.equal(existsSync(target), true);
  const unlink = fs.unlinkSync;
  const deleteLock = t.mock.method(fs, 'unlinkSync', file => { if (file === target) throw denied(); return unlink(file); });
  f.setClock('2026-10-15T04:00:00.000Z');
  const removed = store.cleanupB2({ apply: true });
  assert.equal(removed.removed, 1); assert.equal(removed.projectionPending, true);
  assert.equal(store.getB2(f.input.id), null);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM b2_notes').get().n, 0);
  deleteLock.mock.restore(); store.flush();
  assert.equal(store.projectionStatus().projectionPending, false);
  assert.equal(existsSync(target), false);
  assert.equal(f.reopen().getB2(f.input.id), null);
});
