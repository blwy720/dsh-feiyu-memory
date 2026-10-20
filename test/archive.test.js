import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { MemoryStore, DICTIONARY_V2, DICTIONARY_V3 } from '../lib/store.js';

const filename = id => createHash('sha256').update(id).digest('hex');
function fixture(t, now = '2026-10-18T12:00:00.000Z') {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-a3-store-'));
  const clock = { now }; const stores = [];
  const args = { dataDir, instanceId: 'synthetic-a3-fish', now: () => new Date(clock.now) };
  const open = () => { const store = new MemoryStore(args); stores.push(store); return store; };
  t.after(() => { for (const store of stores) store.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { store: open(), open, args, clock, dataDir };
}
function parent(store, id = 'parent', extra = {}) {
  if (!store.getRaw(`raw-${id}`)) store.appendRaw({ id: `raw-${id}`, sessionId: 'synthetic', pool: 'a', role: 'assistant', text: `原始陈述${id}，不保证事实成立。`, recordedAt: '2026-09-01T00:00:00Z' });
  return store.writeEntry({ id, kind: 'memory', text: `关于${id}的初步提取`, recordedAt: '2026-09-18T12:00:00.000Z', sources: [{ rawId: `raw-${id}`, quote: `原始陈述${id}`, support: 'unassessed' }], ...extra });
}
function archive(store, values = {}) {
  return { requestId: 'archive-request', id: 'archive', expectedVersion: 0, action: 'write', reason: '归纳已声明范围内的关键信息。', text: '这是一条需要保留来源边界的明确陈述。', body: { time: '原对话发生时', persons: ['原说话者'], event: '原说话者留下这项明确陈述，未验证其真实性。' }, statementType: 'fact', derivedFrom: ['parent'], coverage: { scope: [{ id: 'parent', version: store.getEntry('parent')?.version ?? 1 }], covered: ['parent'], notCovered: [], scopeNote: '仅审查这一条明确选定的笔记，不声称覆盖所有相关记忆。' }, ...values };
}
function approve(store, id = 'parent', values = {}) {
  return store.reviewA2({ requestId: `review-${id}`, reason: '明确审查活动池清理。', items: [{ id, version: store.getEntry(id).version, decision: 'discard', reason: '没有需要保留在活动池的新增信息。' }], ...values });
}

test('A3 requires an explicit write and exact declared coverage; raw, parent versions and evidence never change', t => {
  const { store } = fixture(t);
  parent(store); parent(store, 'other');
  const rawBefore = JSON.stringify(store.db.prepare('SELECT * FROM raw').all());
  const parentBefore = store.db.prepare('SELECT json FROM entries WHERE id=?').get('parent').json;
  const input = archive(store, { coverage: { scope: [{ id: 'parent', version: 1 }, { id: 'other', version: 1 }], covered: ['parent'], notCovered: [{ id: 'other', reason: '其他主题，另行审查。' }], scopeNote: '只包含这两条已读取的笔记。' } });
  assert.equal(store.listEntries({ pool: 'a3' }).length, 0);
  store.retireA2({ apply: true }); assert.equal(store.listEntries({ pool: 'a3' }).length, 0);
  const result = store.writeA3(input); const entry = store.getEntry(result.id);
  assert.equal(entry.kind, 'a3'); assert.equal(entry.depth, 2); assert.equal(entry.evidenceStatus, 'derived_only');
  assert.equal(entry.sourceNature, 'second_distillation'); assert.equal(entry.currentValidity, 'unknown');
  assert.deepEqual(entry.sources, []); assert.equal(entry.independentSourceCount, null);
  assert.equal(entry.sourceEntries[0].hash, createHash('sha256').update(parentBefore).digest('hex'));
  assert.deepEqual(entry.sourceEntries[0].read, { tool: 'memory_read', arguments: { id: 'parent', version: 1 } });
  assert.equal(entry.lineageBroken, false); assert.equal(entry.orphaned, false);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM evidence WHERE entry_id=?').get('archive').n, 0);
  assert.equal(store.db.prepare('SELECT json FROM entries WHERE id=?').get('parent').json, parentBefore);
  assert.equal(JSON.stringify(store.db.prepare('SELECT * FROM raw').all()), rawBefore);
  assert.equal(store.retireA2({ apply: true }).retired, 0, 'coverage is not cleanup approval');
});

test('coverage rejects omitted scope entries, duplicate IDs, stale versions and missing omission reasons atomically', t => {
  const { store } = fixture(t); parent(store); parent(store, 'other');
  const input = archive(store);
  const cases = [
    { coverage: undefined },
    { derivedFrom: ['parent', 'parent'] },
    { coverage: { ...input.coverage, scope: [{ id: 'parent', version: 0 }] } },
    { coverage: { ...input.coverage, scope: [{ id: 'parent', version: 1 }, { id: 'other', version: 1 }] } },
    { coverage: { ...input.coverage, covered: ['other'] } },
    { coverage: { ...input.coverage, notCovered: [{ id: 'parent', reason: '重复' }] } },
    { coverage: { ...input.coverage, scope: [{ id: 'parent', version: 1 }, { id: 'other', version: 1 }], notCovered: [{ id: 'other', reason: '' }] } },
    { coverage: { ...input.coverage, scopeNote: '' } },
  ];
  for (const values of cases) assert.throws(() => store.writeA3({ ...input, ...values }));
  assert.equal(store.getEntry('archive'), null); assert.equal(store.reviewHistory().total, 0);
  parent(store, 'parent', { expectedVersion: 1 });
  assert.throws(() => store.writeA3(input), /current active A2/);
  assert.equal(store.writeA3(archive(store)).version, 1);
});

test('A3 rejects inference even when marked, and never treats assistant quotes as semantic proof', t => {
  const { store } = fixture(t); parent(store);
  const input = archive(store);
  assert.throws(() => store.writeA3({ ...input, statementType: undefined }), /statementType/);
  assert.throws(() => store.writeA3({ ...input, statementType: 'inference' }), /inference/);
  assert.throws(() => store.writeA3({ ...input, statementType: 'inference', inference: { reasoning: '归纳线索', uncertainty: '未知' } }), /inference/);
  assert.throws(() => store.writeA3({ ...input, inference: { reasoning: '伪装成明确陈述', uncertainty: '未知' } }), /inference/);
  store.writeA3({ ...input, statementType: 'self_report' });
  const entry = store.getEntry('archive');
  assert.equal(entry.statementType, 'self_report'); assert.equal(entry.evidenceStatus, 'derived_only'); assert.equal(entry.semanticStatus, 'declared_only');
  assert.equal(entry.independentSourceCount, null);
  store.audit(); assert.equal(store.getEntry('archive').evidenceStatus, 'derived_only');
});

test('only A2 can be a parent and only the dedicated entrance can create or edit A3', t => {
  const { store } = fixture(t); parent(store); store.writeA3(archive(store));
  for (const id of ['raw-parent', 'archive']) assert.throws(() => store.writeA3(archive(store, { requestId: `bad-${id}`, id: `result-${id}`, derivedFrom: [id], coverage: { scope: [{ id, version: 1 }], covered: [id], notCovered: [], scopeNote: '不是A2' } })), /current active A2/);
  assert.throws(() => store.writeEntry({ id: 'direct', kind: 'a3', text: '绕过专属入口' }), /writeA3/);
  assert.throws(() => store.writeEntry({ id: 'direct', kind: 'memory', pool: 'a3', text: '绕过池' }), /pool a2/);
  assert.throws(() => store.writeEntry({ id: 'archive', kind: 'a3', text: '改写' }), /writeA3/);
  assert.throws(() => store.setCore({ requestId: 'bad-core', id: 'archive', expectedVersion: 1, action: 'promote', category: 'identity', reason: '不能加入关系核心' }), /only the relationship graph/);
  assert.throws(() => store.writeA3(archive(store, { requestId: 'self', id: 'self' })), /reserved/);
  assert.throws(() => store.writeA3(archive(store, { requestId: 'collision', id: 'raw-parent' })), /collides/);
  assert.throws(() => store.submitSelfReview({ requestId: 'bad-first-review', rawIds: ['raw-parent'], entries: [{ id: 'hidden-a3', kind: 'a3', text: '绕过再次归纳', sources: [{ rawId: 'raw-parent', quote: '原始陈述parent' }] }], reason: '不应创建' }), /writeA3/);
});

test('new A3 parent provenance is independent of live raw validity and never becomes quote_verified', t => {
  const { store } = fixture(t); parent(store, 'parent', { sources: [] });
  store.writeA3(archive(store));
  assert.equal(store.getEntry('archive').lineageBroken, false);
  assert.equal(store.getEntry('archive').orphaned, false);
  const before = store.db.prepare('SELECT json FROM entries WHERE id=?').get('archive').json;
  store.audit();
  assert.equal(store.getEntry('archive').evidenceStatus, 'derived_only');
  assert.equal(store.db.prepare('SELECT json FROM entries WHERE id=?').get('archive').json, before);
  assert.deepEqual(store.a3Stats(), { status: 'active', total: 1, orphaned: 0, lineageBroken: 0 });
});

test('parent edits, archival and moving to C change A3 view flags without rewriting historical A3 JSON', t => {
  const { store } = fixture(t); parent(store, 'parent', { kind: 'entity', text: '用户', sources: [{ rawId: 'raw-parent', quote: '原始陈述parent', support: 'supports' }] });
  store.writeA3(archive(store));
  const before = store.db.prepare('SELECT json FROM entries WHERE id=?').get('archive').json;
  parent(store, 'parent', { kind: 'entity', text: '用户更新', expectedVersion: 1, status: 'archived' });
  assert.equal(store.getEntry('archive').orphaned, true); assert.equal(store.getEntry('archive').sourceChanged, true);
  assert.equal(store.getEntry('archive').lineageBroken, false);
  parent(store, 'parent', { kind: 'entity', text: '用户', expectedVersion: 2, sources: [{ rawId: 'raw-parent', quote: '原始陈述parent', support: 'supports' }] });
  assert.equal(store.getEntry('archive').orphaned, false);
  store.setCore({ requestId: 'promote-parent', id: 'parent', expectedVersion: 3, action: 'promote', category: 'identity', reason: '核心关系节点' });
  assert.equal(store.getEntry('archive').orphaned, true); assert.equal(store.getEntry('archive').lineageBroken, false);
  assert.equal(store.db.prepare('SELECT json FROM entries WHERE id=?').get('archive').json, before);
});

test('A3 updates, revoke, restore and retries preserve exact version provenance and immutable decisions', t => {
  const { store, open } = fixture(t); parent(store);
  const first = archive(store); store.writeA3(first);
  parent(store, 'parent', { expectedVersion: 1, text: '新的A2版本' });
  assert.equal(store.writeA3(first).duplicate, true);
  assert.throws(() => store.writeA3({ ...first, text: '修改同请求' }), /different payload/);
  assert.throws(() => store.writeA3(archive(store, { requestId: 'stale', expectedVersion: 0 })), /version conflict/);
  store.writeA3(archive(store, { requestId: 'update', expectedVersion: 1, text: '对新版本重新归纳' }));
  assert.equal(store.getEntry('archive', { version: 1 }).sourceEntries[0].version, 1);
  assert.equal(store.getEntry('archive').sourceEntries[0].version, 2);
  const revoke = { requestId: 'revoke', id: 'archive', expectedVersion: 2, action: 'revoke', reason: '暂时撤回归纳' };
  const mock = t.mock.method(store, 'getRaw', () => null);
  store.writeA3(revoke); mock.mock.restore();
  store.close(); const reopened = open();
  assert.equal(reopened.writeA3(revoke).duplicate, true);
  assert.equal(reopened.getEntry('archive').status, 'archived');
  reopened.writeA3(archive(reopened, { requestId: 'restore', expectedVersion: 3 }));
  assert.equal(reopened.getEntry('archive').version, 4);
  assert.equal(reopened.reviewHistory({ id: 'archive' }).total, 4);
  assert.throws(() => reopened.db.exec("DELETE FROM entries WHERE kind='a3'"), /immutable/);
});

test('A2 due time is exactly 720 hours from its current recordedAt and queue is metadata-only', t => {
  const { store, clock } = fixture(t); parent(store);
  parent(store, 'early', { recordedAt: '2026-09-18T12:00:00.001Z', text: 'DO_NOT_PARSE_A2_BODY'.repeat(10000) });
  const originalParse = JSON.parse;
  const mock = t.mock.method(JSON, 'parse', (value, ...args) => { assert.equal(String(value).includes('DO_NOT_PARSE_A2_BODY'), false); return originalParse(value, ...args); });
  const queue = store.listA2ReviewQueue({ limit: 1 }); mock.mock.restore();
  assert.equal(queue.total, 1); assert.equal(queue.items[0].id, 'parent');
  assert.equal(queue.items[0].dueAt, clock.now); assert.equal(queue.items[0].reviewed, false);
  clock.now = '2026-10-18T12:00:00.001Z'; assert.equal(store.listA2ReviewQueue().total, 2);
  approve(store); parent(store, 'parent', { expectedVersion: 1, recordedAt: clock.now });
  assert.deepEqual(store.listA2ReviewQueue().items.map(item => item.id), ['early']);
  clock.now = '2026-11-18T12:00:00Z';
  assert.equal(store.listA2ReviewQueue().items.find(item => item.id === 'parent').reviewed, false);
});

test('A2 retirement removes only reviewed due active projections, preserves history and originals, and permits a new version', t => {
  const { store, dataDir, open } = fixture(t);
  parent(store, 'parent', { kind: 'entity' }); parent(store, 'pending');
  const before = store.db.prepare('SELECT json FROM entries WHERE id=?').get('parent').json;
  approve(store);
  const preview = store.retireA2(); assert.equal(preview.ready, 1); assert.equal(preview.retired, 0); assert.equal(preview.pendingReview, 1);
  const result = store.retireA2({ apply: true }); assert.equal(result.retired, 1);
  assert.deepEqual(store.listEntries({ pool: 'a2' }).map(entry => entry.id), ['pending']);
  assert.equal(store.getEntry('parent').retired, true);
  assert.equal(store.listEntries({ includeHistory: true }).find(entry => entry.id === 'parent').retired, true);
  const hash = filename('parent');
  assert.equal(fs.existsSync(path.join(dataDir, 'a2', hash, 'current.json')), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'entities', `${hash}.json`)), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'a2', hash, 'v1.json')), true);
  assert.equal(store.db.prepare('SELECT json FROM entries WHERE id=?').get('parent').json, before);
  assert.ok(store.getRaw('raw-parent'));
  assert.throws(() => store.db.exec("DELETE FROM raw WHERE id='raw-parent'"), /retention API/);
  assert.throws(() => store.reviewRetention({ ids: ['raw-parent'], decision: 'discard', reason: '仍有不可变证据引用' }), /must be retained/);
  assert.throws(() => store.setCore({ requestId: 'retired-core', id: 'parent', expectedVersion: 1, action: 'promote', category: 'identity', reason: '不得绕过退休状态' }), /active A2/);
  store.close(); const reopened = open();
  assert.equal(fs.existsSync(path.join(dataDir, 'a2', hash, 'current.json')), false);
  parent(reopened, 'parent', { kind: 'entity', expectedVersion: 1, recordedAt: reopened.now() });
  assert.equal(reopened.getEntry('parent').retired, undefined);
  assert.equal(reopened.getEntry('parent', { version: 1 }).retired, true);
  assert.equal(fs.existsSync(path.join(dataDir, 'a2', hash, 'current.json')), true);
});

test('retiring a covered A2 orphans A3 but keeps its two-step historical lineage intact', t => {
  const { store, dataDir } = fixture(t); parent(store); store.writeA3(archive(store));
  approve(store, 'parent', { items: [{ id: 'parent', version: 1, decision: 'archived', a3Ids: ['archive'], reason: '归档引用了该精确版本' }] });
  store.retireA2({ apply: true });
  assert.equal(store.getEntry('archive').orphaned, true); assert.equal(store.getEntry('archive').lineageBroken, false);
  assert.equal(store.getEntry('archive').evidenceStatus, 'derived_only');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'a3/index.json'), 'utf8'))[0].orphaned, true);
  store.audit(); assert.equal(store.getEntry('archive').lineageBroken, false);
});

test('cleanup revalidates archived approval and an invalid approval can be superseded only by a new immutable review', t => {
  const { store } = fixture(t); parent(store); parent(store, 'other'); store.writeA3(archive(store));
  approve(store, 'parent', { items: [{ id: 'parent', version: 1, decision: 'archived', a3Ids: ['archive'], reason: '已有明确归档' }] });
  assert.throws(() => approve(store, 'parent', { requestId: 'conflict' }), /valid A2 approval/);
  store.writeA3(archive(store, { requestId: 'change-coverage', expectedVersion: 1, derivedFrom: ['other'], coverage: { scope: [{ id: 'other', version: 1 }], covered: ['other'], notCovered: [], scopeNote: '改为另一个归纳范围' } }));
  assert.equal(store.listA2ReviewQueue().items.find(item => item.id === 'parent').reviewed, false);
  assert.equal(store.retireA2({ apply: true }).retired, 0);
  approve(store, 'parent', { requestId: 'new-explicit-decision' });
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM a2_reviews WHERE entry_id=?').get('parent').n, 2);
  assert.equal(store.retireA2({ apply: true }).retired, 1);
  assert.equal(store.reviewHistory({ id: 'parent' }).items.filter(item => item.type === 'a2_review').length, 2);
  assert.throws(() => store.db.exec('DELETE FROM a2_reviews'), /immutable/);
  assert.throws(() => store.db.exec('UPDATE a2_retirements SET version=999'), /immutable/);
});

test('A3 decision and A2 retirement failures roll back whole batches and leave safe retries', t => {
  const { store } = fixture(t); parent(store); parent(store, 'other');
  store.db.exec("CREATE TRIGGER fail_a3 BEFORE INSERT ON memory_decisions WHEN NEW.kind='a3' BEGIN SELECT RAISE(ABORT,'synthetic A3 ledger failure'); END");
  assert.throws(() => store.writeA3(archive(store)), /synthetic A3/); assert.equal(store.getEntry('archive'), null);
  store.db.exec('DROP TRIGGER fail_a3'); store.writeA3(archive(store));
  approve(store); approve(store, 'other');
  store.db.exec("CREATE TRIGGER fail_retirement BEFORE INSERT ON a2_retirements WHEN NEW.entry_id='parent' BEGIN SELECT RAISE(ABORT,'synthetic retirement failure'); END");
  assert.throws(() => store.retireA2({ apply: true }), /synthetic retirement/);
  assert.equal(store.listEntries({ pool: 'a2' }).length, 2); assert.equal(store.db.prepare('SELECT count(*) AS n FROM a2_retirements').get().n, 0);
  store.db.exec('DROP TRIGGER fail_retirement'); assert.equal(store.retireA2({ apply: true }).retired, 2);
});

test('A3 statistics cache only lineage results and do not deserialize A3 or parent summary bodies', t => {
  const { store } = fixture(t); parent(store, 'parent', { text: 'PARENT_BODY_NOT_NEEDED'.repeat(10000) });
  for (let i = 0; i < 3; i++) store.writeA3(archive(store, { requestId: `req-${i}`, id: `a3-${i}`, text: `A3_BODY_NOT_NEEDED_${i}` }));
  const originalGetRaw = store.getRaw.bind(store); let lookups = 0;
  const rawMock = t.mock.method(store, 'getRaw', id => { lookups++; return originalGetRaw(id); });
  const originalParse = JSON.parse;
  const parseMock = t.mock.method(JSON, 'parse', (value, ...args) => { assert.equal(/A3_BODY_NOT_NEEDED|PARENT_BODY_NOT_NEEDED/.test(String(value)), false); return originalParse(value, ...args); });
  const stats = store.a3Stats(); parseMock.mock.restore(); rawMock.mock.restore();
  assert.equal(stats.total, 3); assert.equal(stats.lineageBroken, 0); assert.equal(lookups, 0);
});

test('A3 projection failures are durable, recover after restart, and cleanup removes only known A3 temps', t => {
  const { store, open, dataDir } = fixture(t); parent(store);
  const originalRename = fs.renameSync;
  const mock = t.mock.method(fs, 'renameSync', (from, to) => { if (to.includes(`${path.sep}a3${path.sep}`)) { const error = new Error('synthetic lock'); error.code = 'EPERM'; throw error; } return originalRename(from, to); });
  const input = archive(store); const result = store.writeA3(input);
  assert.equal(result.committed, true); assert.equal(result.projectionPending, true); assert.ok(store.getEntry('archive'));
  mock.mock.restore();
  const temp = path.join(dataDir, 'a3', `index.json.${randomUUID()}.tmp`); fs.writeFileSync(temp, '合成残片');
  const userFile = path.join(dataDir, 'a3', 'user-note.tmp'); fs.writeFileSync(userFile, '保留');
  store.close(); const reopened = open();
  assert.equal(reopened.projectionStatus().pending, false); assert.equal(reopened.writeA3(input).duplicate, true);
  assert.equal(fs.existsSync(temp), false); assert.equal(fs.readFileSync(userFile, 'utf8'), '保留');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'a3', filename('archive'), 'v1.json'), 'utf8')).evidenceStatus, 'derived_only');
});

test('schema 6 migration leaves older immutable JSON and dictionaries untouched and preserves v3', t => {
  const { store, open, dataDir } = fixture(t); parent(store);
  const rawBefore = JSON.stringify(store.db.prepare('SELECT * FROM raw').all());
  const legacy = { ...store.getEntry('parent'), id: 'legacy-v2', dictVersion: 'v2', sources: [] };
  store.db.prepare('INSERT INTO entries(id,version,kind,json) VALUES (?,?,?,?)').run(legacy.id, 1, legacy.kind, JSON.stringify(legacy));
  const older = { ...store.metadata(), schema: 3 };
  store.db.prepare('UPDATE meta SET value=? WHERE key=?').run(JSON.stringify(older), 'identity');
  const v1 = fs.readFileSync(path.join(dataDir, 'dict/v1.md'), 'utf8');
  const legacyBytes = store.db.prepare('SELECT json FROM entries WHERE id=?').get(legacy.id).json;
  store.close(); fs.writeFileSync(path.join(dataDir, 'identity.json'), JSON.stringify(older));
  const reopened = open();
  assert.equal(reopened.metadata().schema, 6);
  assert.equal(reopened.db.prepare('SELECT json FROM entries WHERE id=?').get(legacy.id).json, legacyBytes);
  assert.equal(JSON.stringify(reopened.db.prepare('SELECT * FROM raw').all()), rawBefore);
  assert.equal(fs.readFileSync(path.join(dataDir, 'dict/v1.md'), 'utf8'), v1);
  assert.equal(fs.readFileSync(path.join(dataDir, 'dict/v2.md'), 'utf8'), DICTIONARY_V2);
  assert.equal(fs.readFileSync(path.join(dataDir, 'dict/v3.md'), 'utf8'), DICTIONARY_V3);
  reopened.writeA3(archive(reopened)); assert.equal(reopened.getEntry('archive').dictVersion, 'v5');
});
