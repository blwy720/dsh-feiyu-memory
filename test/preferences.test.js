import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { MemoryStore } from '../lib/store.js';

const filename = id => createHash('sha256').update(id).digest('hex');
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-preferences-'));
  const args = { dataDir, instanceId: 'synthetic-fish', now: () => new Date('2026-10-18T12:00:00Z') };
  const stores = [];
  const open = () => { const store = new MemoryStore(args); stores.push(store); return store; };
  t.after(() => { for (const store of stores) store.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { store: open(), open, dataDir };
}
function request(values = {}) {
  return { requestId: 'preference-first', id: 'preference-rain', expectedVersion: 0, action: 'set', topic: '雨声', stance: 'like', text: '我喜欢听雨声，这是我此刻的自述。', reason: '我愿意在后续会话保留这项喜好。', ...values };
}
function raw(store, id = 'context', pool = 'a') {
  return store.appendRaw({ id, pool, role: 'assistant', sessionId: 'synthetic', text: '合成上下文：窗外下起了雨。', recordedAt: '2026-10-01T00:00:00Z' });
}

test('B3 is an explicit self report with no required source and never shares the B or C pools', t => {
  const { store, dataDir } = fixture(t);
  const result = store.setPreference(request());
  const entry = store.getEntry(result.id);
  assert.equal(entry.kind, 'preference'); assert.equal(entry.pool, 'b3');
  assert.equal(entry.subject, 'self'); assert.equal(entry.sourceNature, 'model_self_report');
  assert.equal(entry.evidenceStatus, 'self_report'); assert.equal(entry.contextEvidenceStatus, 'none');
  assert.equal(entry.currentValidity, 'unknown'); assert.equal(entry.independentSourceCount, null);
  assert.deepEqual(entry.sources, []); assert.equal(entry.status, 'active');
  assert.equal(entry.preferenceDecision.sourceVersion, 0);
  assert.equal(store.listEntries({ pool: 'b3', status: 'active' }).length, 1);
  assert.equal(store.listEntries({ pool: 'a2' }).length, 0); assert.equal(store.listEntries({ pool: 'c' }).length, 0);
  assert.equal(store.dayStats('2026-10-18').b.total, 0); assert.equal(store.listReviewQueue().total, 0);
  assert.equal(store.graph({ pool: 'all' }).edges.length, 0);
  const folder = path.join(dataDir, 'b3', filename(entry.id));
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'current.json'), 'utf8')).subject, 'self');
  assert.equal(fs.existsSync(path.join(folder, 'v1.json')), true);
  assert.equal(fs.existsSync(path.join(dataDir, 'archive', filename(entry.id), 'v1.json')), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'a2', filename(entry.id), 'v1.json')), false);
  assert.equal(store.audit().length, 0);
  assert.equal(store.getEntry(entry.id).auditDowngraded, undefined);
  assert.equal(store.getEntry(entry.id).evidenceStatus, 'self_report');
});

test('set, update, revoke and restore preserve immutable B3 versions and decision history across restart', t => {
  const { store, open, dataDir } = fixture(t);
  const first = request(); store.setPreference(first);
  const second = request({ requestId: 'second', expectedVersion: 1, stance: 'mixed', text: '我仍喜欢小雨，但不喜欢雷声。', reason: '现在有更细的偏好。' });
  store.setPreference(second);
  const removal = { requestId: 'remove', id: first.id, expectedVersion: 2, action: 'revoke', reason: '暂时不再放入新会话。' };
  store.setPreference(removal);
  assert.equal(store.getEntry(first.id).status, 'archived');
  assert.equal(store.getEntry(first.id).text, second.text);
  assert.equal(store.listEntries({ pool: 'b3', status: 'active' }).length, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'b3', filename(first.id), 'current.json'), 'utf8')).status, 'archived');
  store.close();
  const reopened = open();
  assert.equal(reopened.setPreference(removal).duplicate, true);
  assert.equal(reopened.setPreference(first).duplicate, true);
  assert.equal(reopened.getEntry(first.id).version, 3);
  reopened.setPreference(request({ requestId: 'restore', expectedVersion: 3, stance: 'neutral', text: '我目前对雨声没有明显偏向。' }));
  assert.deepEqual(reopened.listEntries({ kind: 'preference', includeHistory: true }).map(entry => [entry.version, entry.stance, entry.status]), [[1, 'like', 'active'], [2, 'mixed', 'active'], [3, 'mixed', 'archived'], [4, 'neutral', 'active']]);
  assert.equal(reopened.reviewHistory({ id: first.id }).total, 4);
  const decision = reopened.reviewHistory({ id: first.id }).items[0];
  assert.equal(decision.type, 'preference'); assert.equal(decision.subject, 'self');
  assert.equal(decision.sourceVersion, 3); assert.equal(decision.asOf, '2026-10-18T12:00:00.000Z');
  assert.deepEqual(decision.read, { tool: 'memory_read', arguments: { id: first.id, version: 4 } });
  assert.throws(() => reopened.db.exec("UPDATE entries SET json='{}' WHERE kind='preference'"), /immutable/);
});

test('preference requests reject stale versions and changed replay payload without partial decisions', t => {
  const { store } = fixture(t);
  const first = request(); store.setPreference(first);
  assert.throws(() => store.setPreference({ ...first, text: '同请求换正文' }), /different payload/);
  assert.throws(() => store.setPreference({ ...first, requestId: 'stale', expectedVersion: 0 }), /version conflict/);
  assert.throws(() => store.setPreference({ ...first, requestId: 'missing', expectedVersion: undefined }), /expectedVersion/);
  assert.throws(() => store.setPreference({ requestId: 'revoke-missing', id: 'missing', expectedVersion: 0, action: 'revoke', reason: '不存在' }), /missing preference/);
  assert.equal(store.reviewHistory().total, 1);
  assert.equal(store.getEntry(first.id).version, 1);
  assert.equal(store.setPreference({ ...first, requestId: 'stale', expectedVersion: 1, stance: 'dislike' }).version, 2);
});

test('only setPreference can write B3, and preferences cannot replace other kinds or become C', t => {
  const { store } = fixture(t);
  assert.throws(() => store.writeEntry({ id: 'blocked', kind: 'preference', text: '绕过入口' }), /setPreference/);
  assert.throws(() => store.writeEntry({ kind: 'memory', text: '绕过池', pool: 'b3' }), /pool a2/);
  assert.throws(() => store.setPreference(request({ id: 'self' })), /reserved virtual Feiyu/);
  assert.throws(() => store.setPreference(request({ subject: 'user' })), /first-degree/);
  store.writeEntry({ id: 'entity', kind: 'entity', text: '原实体' });
  assert.throws(() => store.setPreference(request({ id: 'entity', expectedVersion: 1 })), /another entry kind/);
  const a = raw(store);
  assert.throws(() => store.setPreference(request({ id: a.id })), /collides with raw id/);
  store.setPreference(request());
  assert.throws(() => store.setCore({ requestId: 'not-core', id: 'preference-rain', expectedVersion: 1, action: 'promote', category: 'identity', reason: '喜好不是关系网' }), /only the relationship graph/);
  assert.throws(() => store.writeEntry({ id: 'preference-rain', kind: 'memory', text: '改为别类' }), /kind cannot change/);
  assert.equal(store.reviewHistory().total, 1);
});

test('self review cannot bypass the preference entrance and rolls back earlier products in its batch', t => {
  const { store } = fixture(t);
  raw(store);
  const sources = [{ rawId: 'context', quote: '窗外下起了雨。', support: 'context_only' }];
  assert.throws(() => store.submitSelfReview({ requestId: 'bad-review', rawIds: ['context'], reason: '合成错误批次', entries: [
    { id: 'first-memory', kind: 'memory', text: '合法产物也须一同回滚', sources },
    { id: 'hidden-preference', kind: 'preference', pool: 'b3', subject: 'self', text: '不能这样写入喜好', sources },
  ] }), /setPreference/);
  assert.equal(store.getEntry('first-memory'), null); assert.equal(store.getEntry('hidden-preference'), null);
  assert.equal(store.reviewHistory().total, 0); assert.equal(store.listReviewQueue().total, 1);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM evidence').get().n, 0);
});

test('B3 validates bounded fields and stance without recording rejected requests', t => {
  const { store } = fixture(t);
  for (const invalid of [{ topic: '' }, { topic: '话'.repeat(121) }, { text: '' }, { text: '述'.repeat(501) }, { reason: '' }, { reason: '因'.repeat(2001) }, { stance: 'probably' }, { expectedVersion: -1 }, { expectedVersion: 1.5 }, { action: 'promote' }, { sources: {} }]) assert.throws(() => store.setPreference(request(invalid)));
  assert.equal(store.listEntries().length, 0); assert.equal(store.reviewHistory().total, 0);
  store.setPreference(request({ topic: '话'.repeat(120), text: '述'.repeat(500), reason: '因'.repeat(2000) }));
  assert.equal(store.getEntry('preference-rain').text.length, 500);
});

test('optional original quotes are context only and do not validate the self report', t => {
  const { store } = fixture(t);
  raw(store);
  const sources = [{ rawId: 'context', quote: '窗外下起了雨。' }];
  const result = store.setPreference(request({ sources }));
  const entry = store.getEntry(result.id);
  assert.equal(entry.sources[0].support, 'context_only');
  assert.equal(entry.evidenceStatus, 'self_report'); assert.equal(entry.contextEvidenceStatus, 'quote_verified');
  assert.equal(entry.sources[0].role, 'assistant');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM evidence WHERE entry_id=?').get(result.id).n, 1);
  assert.throws(() => store.setPreference(request({ requestId: 'bad', expectedVersion: 1, sources: [{ rawId: 'context', quote: '原文中没有这句' }] })), /verbatim/);
  assert.throws(() => store.setPreference(request({ requestId: 'bad', expectedVersion: 1, sources: [{ rawId: 'context', quote: '窗外下起了雨。', support: 'supports' }] })), /context_only/);
  assert.throws(() => store.setPreference(request({ requestId: 'bad', expectedVersion: 1, sources: [{ rawId: result.id, quote: entry.text }] })), /original raw/);
  raw(store, 'b-context', 'b');
  assert.throws(() => store.setPreference(request({ requestId: 'bad', expectedVersion: 1, sources: [{ rawId: 'b-context', quote: '窗外下起了雨。' }] })), /original raw/);
  assert.equal(store.getEntry(result.id).version, 1); assert.equal(store.reviewHistory().total, 1);
});

test('audit downgrades broken context only; source-free self reports survive audit and missing-source revoke works', t => {
  const { store } = fixture(t);
  raw(store);
  store.setPreference(request({ sources: [{ rawId: 'context', quote: '窗外下起了雨。' }] }));
  store.setPreference(request({ requestId: 'without-context', id: 'other' }));
  const originalGetRaw = store.getRaw.bind(store);
  const mock = t.mock.method(store, 'getRaw', id => id === 'context' ? null : originalGetRaw(id));
  const findings = store.audit();
  assert.equal(findings.length, 1); assert.equal(findings[0].scope, 'context');
  const current = store.getEntry('preference-rain');
  assert.equal(current.evidenceStatus, 'self_report'); assert.equal(current.contextEvidenceStatus, 'unverified');
  assert.equal(current.contextAuditDowngraded, true); assert.equal(current.auditDowngraded, undefined);
  assert.equal(store.getEntry('other').contextEvidenceStatus, 'none');
  store.setPreference({ requestId: 'remove-broken-context', id: 'preference-rain', expectedVersion: 1, action: 'revoke', reason: '缺失上下文仍可撤回喜好' });
  mock.mock.restore();
  assert.equal(store.getEntry('preference-rain').status, 'archived');
  store.setPreference(request({ requestId: 'fresh-report', expectedVersion: 2 }));
  assert.equal(store.getEntry('preference-rain').contextEvidenceStatus, 'none');
  assert.equal(store.getEntry('preference-rain').contextAuditDowngraded, undefined);
});

test('decision failure rolls back preference version and evidence together and leaves the request reusable', t => {
  const { store } = fixture(t);
  raw(store);
  store.db.exec("CREATE TRIGGER fail_preference_decision BEFORE INSERT ON memory_decisions WHEN NEW.kind='preference' BEGIN SELECT RAISE(ABORT,'synthetic decision failure'); END");
  const input = request({ sources: [{ rawId: 'context', quote: '窗外下起了雨。' }] });
  assert.throws(() => store.setPreference(input), /synthetic decision failure/);
  assert.equal(store.getEntry(input.id), null); assert.equal(store.reviewHistory().total, 0);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM evidence').get().n, 0);
  store.db.exec('DROP TRIGGER fail_preference_decision');
  assert.equal(store.setPreference(input).version, 1);
});

test('B3 projection locks do not lose canonical versions, restart repairs pending and safely cleans only owned temps', t => {
  const { store, open, dataDir } = fixture(t);
  const originalRename = fs.renameSync;
  const mock = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to.includes(`${path.sep}b3${path.sep}`)) { const error = new Error('synthetic file lock'); error.code = 'EPERM'; throw error; }
    return originalRename(from, to);
  });
  const input = request(); const result = store.setPreference(input);
  assert.equal(result.committed, true); assert.equal(result.projectionPending, true);
  assert.equal(store.getEntry(input.id).text, input.text);
  mock.mock.restore();
  const folder = path.join(dataDir, 'b3', filename(input.id)); fs.mkdirSync(folder, { recursive: true });
  const ownedTemp = path.join(folder, `current.json.${randomUUID()}.tmp`);
  const userTemp = path.join(folder, 'my-note.tmp');
  fs.writeFileSync(ownedTemp, '合成崩溃残片'); fs.writeFileSync(userTemp, '用户文件');
  store.close();
  const reopened = open();
  assert.equal(reopened.projectionStatus().pending, false);
  assert.equal(reopened.setPreference(input).duplicate, true);
  assert.equal(reopened.getEntry(input.id).version, 1);
  assert.equal(fs.existsSync(ownedTemp), false); assert.equal(fs.readFileSync(userTemp, 'utf8'), '用户文件');
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'current.json'), 'utf8')).pool, 'b3');
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'v1.json'), 'utf8')).evidenceStatus, 'self_report');
});

test('B3 never starts persisting ordinary B content or copies B receipt bodies into preference evidence', t => {
  const { store, open, dataDir } = fixture(t);
  const secret = 'SYNTHETIC_B_BODY_MUST_STAY_ABSENT';
  store.appendRaw({ id: 'private-b', pool: 'b', role: 'assistant', sessionId: 'private-session', text: secret, recordedAt: '2026-10-18T00:00:00Z' });
  store.setPreference(request()); store.close();
  const reopened = open();
  assert.equal(reopened.getRaw('private-b'), null);
  assert.equal(reopened.dayStats('2026-10-18').b.total, 1);
  const walk = folder => fs.readdirSync(folder, { withFileTypes: true }).flatMap(item => item.isDirectory() ? walk(path.join(folder, item.name)) : [path.join(folder, item.name)]);
  for (const file of walk(dataDir)) assert.equal(fs.readFileSync(file).includes(Buffer.from(secret)), false, `B content leaked to ${file}`);
});
