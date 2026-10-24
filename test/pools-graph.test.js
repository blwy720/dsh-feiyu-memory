import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore, DICTIONARY_V2 } from '../lib/store.js';

const filename = id => createHash('sha256').update(id).digest('hex');
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-pools-graph-'));
  const args = { dataDir, instanceId: 'synthetic-fish', now: () => new Date('2026-10-18T12:00:00Z') };
  const stores = [];
  const open = () => { const store = new MemoryStore(args); stores.push(store); return store; };
  t.after(() => { for (const store of stores) store.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { store: open(), args, open, dataDir };
}
function source(store) {
  if (!store.getRaw('original')) store.appendRaw({ id: 'original', pool: 'a', role: 'user', sessionId: 'synthetic', text: '合成测试：肥鱼称用户为主人，用户称朋友为朋友。', recordedAt: '2026-10-01T00:00:00Z' });
  return [{ rawId: 'original', quote: store.getRaw('original').text, support: 'supports' }];
}
function entity(store, id, extra = {}) { return store.writeEntry({ id, kind: 'entity', text: id, sources: source(store), ...extra }); }
function relation(store, id, from, to, rel = '朋友', extra = {}) { return store.writeEntry({ id, kind: 'relation', text: `${from}称${to}为${rel}`, from, to, rel, sources: source(store), ...extra }); }
function promote(store, id, extra = {}) {
  return store.setCore({ requestId: `promote-${id}`, id, expectedVersion: store.getEntry(id).version, action: 'promote', reason: '自主保留明确关系网信息', category: 'relationship', ...extra });
}
function revoke(store, id, extra = {}) {
  return store.setCore({ requestId: `revoke-${id}`, id, expectedVersion: store.getEntry(id).version, action: 'revoke', reason: '自主撤出核心，保留历史', ...extra });
}

test('ordinary writes default to A2, reject direct C and enforce optional optimistic versions', t => {
  const { store } = fixture(t);
  const first = entity(store, 'person');
  assert.equal(first.pool, 'a2');
  assert.throws(() => entity(store, 'person', { expectedVersion: 0 }), /version conflict/);
  assert.throws(() => entity(store, 'other', { pool: 'c' }), /pool a2/);
  const second = entity(store, 'person', { expectedVersion: 1, text: '新名字' });
  assert.equal(second.version, 2);
  assert.equal(store.getEntry('person', { version: 1 }).text, 'person');
  promote(store, 'person');
  assert.throws(() => entity(store, 'person', { expectedVersion: 3 }), /revoke before editing/);
  assert.equal(store.getEntry('person').version, 3);
  assert.equal(store.listEntries({ pool: 'c' }).length, 1);
  assert.equal(store.listEntries({ pool: 'a2' }).length, 0);
  assert.equal(store.listEntries({ pool: 'a2', includeHistory: true }).length, 2);
});

test('C accepts only supported active graph records with the category and endpoint constraints', t => {
  const { store } = fixture(t);
  store.writeEntry({ id: 'memory', kind: 'memory', text: '普通记忆', sources: source(store) });
  store.writeEntry({ id: 'doing', kind: 'doing', status: 'active', text: '事项', sources: source(store) });
  assert.throws(() => promote(store, 'memory'), /only the relationship graph/);
  assert.throws(() => promote(store, 'doing'), /only the relationship graph/);
  entity(store, 'unsupported', { sources: [] });
  entity(store, 'context', { sources: source(store).map(item => ({ ...item, support: 'context_only' })) });
  entity(store, 'inactive', { status: 'archived' });
  entity(store, 'too-long', { text: '名'.repeat(201) });
  for (const id of ['unsupported', 'context']) assert.throws(() => promote(store, id), /declared supports/);
  assert.throws(() => promote(store, 'inactive'), /active A2/);
  assert.throws(() => promote(store, 'too-long'), /at most 200/);
  entity(store, 'user'); entity(store, 'friend');
  assert.throws(() => promote(store, 'user', { category: 'commitment' }), /identity\/relationship/);
  relation(store, 'self-user', 'self', 'user', '主人');
  assert.throws(() => promote(store, 'self-user'), /active core entities/);
  promote(store, 'user', { category: 'identity' });
  assert.throws(() => promote(store, 'self-user', { category: 'identity' }), /relationship category/);
  promote(store, 'self-user');
  assert.equal(store.getEntry('self-user').evidenceStatus, 'quote_verified');
  assert.equal(store.getEntry('self-user').currentValidity, 'unknown');
  assert.equal(store.getEntry('self-user').independentSourceCount, null);
  assert.equal(store.getEntry('self-user').coreDecision.sourceVersion, 1);
  assert.throws(() => revoke(store, 'user'), /Revoke incident core relations/);
  revoke(store, 'self-user'); revoke(store, 'user');
  assert.equal(store.listEntries({ pool: 'c' }).length, 0);
});

test('core decisions are immutable, version-checked, idempotent after restart, and preserve all history', t => {
  const { store, open, dataDir } = fixture(t);
  entity(store, 'user');
  const request = { requestId: 'one-decision', id: 'user', expectedVersion: 1, action: 'promote', category: 'identity', reason: '用户核心节点' };
  store.setCore(request);
  assert.equal(store.reviewHistory({ id: 'user' }).items[0].sourceVersion, 1);
  assert.equal(fs.existsSync(path.join(dataDir, 'a2', filename('user'), 'v1.json')), true);
  assert.equal(fs.existsSync(path.join(dataDir, 'archive', filename('user'), 'v2.json')), true);
  assert.equal(fs.existsSync(path.join(dataDir, 'a2', filename('user'), 'current.json')), false);
  store.close();
  const reopened = open();
  assert.equal(reopened.setCore(request).duplicate, true);
  assert.throws(() => reopened.setCore({ ...request, reason: '改变同请求内容' }), /different payload/);
  assert.throws(() => revoke(reopened, 'user', { expectedVersion: 1 }), /version conflict/);
  revoke(reopened, 'user');
  assert.equal(reopened.getEntry('user').pool, 'a2');
  assert.equal(reopened.getEntry('user', { version: 2 }).pool, 'c');
  assert.equal(fs.existsSync(path.join(dataDir, 'archive', filename('user'), 'current.json')), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'archive', filename('user'), 'v2.json')), true);
  assert.equal(fs.existsSync(path.join(dataDir, 'a2', filename('user'), 'v3.json')), true);
  assert.equal(reopened.reviewHistory().total, 2);
  assert.throws(() => reopened.db.exec("UPDATE memory_decisions SET kind='forged'"), /immutable/);
  assert.throws(() => reopened.setCore({ ...request, requestId: 'missing-version', expectedVersion: undefined }), /expectedVersion/);
});

test('undirected adjacency BFS preserves each stored direction without inverse or inferred edges', t => {
  const { store } = fixture(t);
  for (const id of ['user', 'friend', 'stranger']) { entity(store, id); promote(store, id); }
  relation(store, 'self-user', 'self', 'user', '主人'); promote(store, 'self-user');
  relation(store, 'user-friend', 'user', 'friend'); promote(store, 'user-friend');
  relation(store, 'stranger-friend', 'stranger', 'friend'); promote(store, 'stranger-friend');
  relation(store, 'a2-self-friend', 'self', 'friend', '尚待复核');
  relation(store, 'archived', 'self', 'stranger', '旧关系', { status: 'archived' });
  const graph = store.graph();
  assert.deepEqual(graph.edges.map(edge => edge.id), ['self-user', 'user-friend']);
  assert.deepEqual(graph.nodes.map(node => node.id), ['self', 'user', 'friend']);
  assert.equal(graph.nodes[0].name, '肥鱼');
  assert.equal(graph.edges.every(edge => edge.pool === 'c' && edge.status === 'active'), true);
  assert.equal(graph.edges.some(edge => edge.from === 'self' && edge.to === 'friend'), false);
  assert.deepEqual(graph.edges[0].read, { tool: 'memory_read', arguments: { id: 'self-user', version: 2 } });
  assert.equal(store.graph({ center: 'friend' }).edges.length, 3);
  assert.deepEqual(store.graph({ depth: 1 }).edges.map(edge => edge.id), ['self-user']);
  assert.equal(store.graph({ depth: 1 }).depthLimited, true);
  assert.deepEqual(store.graph({ pool: 'a2' }).edges.map(edge => edge.id), ['a2-self-friend']);
  assert.equal(store.graph({ pool: 'all' }).edges.length, 4);
});

test('graph bounds keep complete endpoint nodes, distinguish cycles and expose all truncation', t => {
  const { store } = fixture(t);
  for (const id of ['one', 'two']) entity(store, id, { text: '显示名'.repeat(100) });
  relation(store, 'a-one', 'self', 'one', '关系', { note: '注'.repeat(1000) });
  relation(store, 'b-two', 'self', 'two');
  relation(store, 'cycle', 'one', 'self');
  const graph = store.graph({ pool: 'a2', limit: 1 });
  assert.equal(graph.edges.length, 1); assert.equal(graph.nodes.length, 2); assert.equal(graph.truncated, true);
  assert.equal(graph.nodes[1].name.length, 200); assert.equal(graph.edges[0].note.length, 500);
  for (const edge of graph.edges) for (const endpoint of [edge.from, edge.to]) assert.equal(graph.nodes.some(node => node.id === endpoint), true);
  assert.equal(store.graph({ pool: 'a2', depth: 5 }).edges.length, 3);
  for (const args of [{ depth: 0 }, { depth: 6 }, { depth: 1.5 }, { limit: 0 }, { limit: 501 }, { pool: 'b' }]) assert.throws(() => store.graph(args));
});

test('new relations require canonical entity IDs; aliases and non-entity IDs are not endpoints', t => {
  const { store } = fixture(t);
  entity(store, 'user', { aliases: ['同名显示词'] });
  store.writeEntry({ id: 'note', kind: 'memory', text: '不是实体' });
  assert.throws(() => relation(store, 'bad', 'self', 'missing'), /resolve to an entity/);
  assert.throws(() => relation(store, 'bad', 'self', '同名显示词'), /resolve to an entity/);
  assert.throws(() => relation(store, 'bad', 'note', 'user'), /resolve to an entity/);
  assert.equal(store.writeEntry({ id: 'good', kind: 'relation', text: '默认从肥鱼出发', to: 'user', rel: '主人' }).from, 'self');
  assert.throws(() => entity(store, 'self', { text: '另一个虚构身份' }), /reserved virtual Feiyu/);
  assert.throws(() => store.writeEntry({ id: 'self', kind: 'memory', text: '不可占用中心ID' }), /reserved virtual Feiyu/);
});

for (const schema of [1, 2]) test(`schema ${schema} migrates old entries and legacy endpoints to A2 without mutating canonical history`, t => {
  const { store, open, dataDir } = fixture(t);
  const identity = { ...store.metadata(), schema };
  store.close();
  const db = new DatabaseSync(path.join(dataDir, 'memory.sqlite'));
  const oldEntity = { id: 'old-entity', version: 1, instanceId: identity.instanceId, kind: 'entity', text: '老实体', hooks: [], aliases: ['旧名称'], sources: [], status: 'active', recordedAt: '2026-01-01T00:00:00.000Z', occurredAt: null, date: '2026-01-01', sourceNature: 'manual_entry', evidenceStatus: 'unverified', currentValidity: 'unknown', independentSourceCount: null };
  const oldRelation = { ...oldEntity, id: 'old-edge', kind: 'relation', text: '旧关系', from: 'self', to: '旧名称', rel: '朋友', note: null };
  const oldSelf = { ...oldEntity, id: 'self', text: '旧库中心名字' };
  const canonical = JSON.stringify(oldRelation);
  db.prepare('UPDATE meta SET value=? WHERE key=?').run(JSON.stringify(identity), 'identity');
  for (const entry of [oldEntity, oldRelation, oldSelf]) db.prepare('INSERT INTO entries(id,version,kind,json) VALUES (?,?,?,?)').run(entry.id, entry.version, entry.kind, JSON.stringify(entry));
  db.close();
  fs.writeFileSync(path.join(dataDir, 'identity.json'), JSON.stringify(identity));
  for (const entry of [oldEntity, oldRelation]) {
    const folder = path.join(dataDir, 'archive', filename(entry.id)); fs.mkdirSync(folder, { recursive: true });
    for (const name of ['current.json', 'v1.json']) fs.writeFileSync(path.join(folder, name), JSON.stringify(entry));
    fs.writeFileSync(path.join(folder, 'user-note.txt'), '不是本模块投影，不得删除');
  }
  const reopened = open();
    assert.equal(reopened.metadata().schema, 7);
  assert.equal(reopened.getEntry('old-edge').pool, 'a2');
  assert.equal(reopened.db.prepare('SELECT json FROM entries WHERE id=?').get('old-edge').json, canonical);
  assert.equal(reopened.listEntries({ pool: 'c' }).length, 0);
  assert.equal(reopened.graph().edges.length, 0);
  const graph = reopened.graph({ pool: 'a2' });
  assert.equal(graph.legacySelfConflict, true);
  assert.equal(graph.nodes[0].name, '肥鱼');
  assert.equal(reopened.getEntry('self').text, '旧库中心名字');
  assert.equal(reopened.getEntry('self').identityConflict, true);
  assert.throws(() => entity(reopened, 'self', { text: '不可自动迁移覆盖' }), /read-only/);
  assert.throws(() => promote(reopened, 'self'), /read-only/);
  const target = graph.nodes.find(node => node.id === graph.edges[0].to);
  assert.equal(target.placeholder, true); assert.equal(target.name, '旧名称');
  assert.notEqual(target.id, 'old-entity');
  for (const entry of [oldEntity, oldRelation]) {
    assert.equal(fs.existsSync(path.join(dataDir, 'a2', filename(entry.id), 'v1.json')), true);
    assert.equal(fs.existsSync(path.join(dataDir, 'archive', filename(entry.id), 'v1.json')), false);
    assert.equal(fs.existsSync(path.join(dataDir, 'archive', filename(entry.id), 'current.json')), false);
    assert.equal(fs.readFileSync(path.join(dataDir, 'archive', filename(entry.id), 'user-note.txt'), 'utf8'), '不是本模块投影，不得删除');
  }
});

test('A2/C projection rename failures report pending after durable review/core commits and repair on reopen', t => {
  const { store, open, dataDir } = fixture(t);
  const originalRename = fs.renameSync;
  const mocked = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to.includes(`${path.sep}a2${path.sep}`) || to.includes(`${path.sep}archive${path.sep}`)) { const error = new Error('synthetic Windows lock'); error.code = 'EPERM'; throw error; }
    return originalRename(from, to);
  });
  const sources = source(store);
  const reviewed = store.submitSelfReview({ requestId: 'locked-review', rawIds: ['original'], entries: [{ id: 'user', kind: 'entity', text: '用户', sources }], reason: '投影故障测试' });
  assert.equal(reviewed.committed, true); assert.equal(reviewed.projectionPending, true);
  assert.equal(store.listReviewQueue().total, 0);
  const core = promote(store, 'user');
  assert.equal(core.committed, true); assert.equal(core.projectionPending, true);
  assert.equal(store.getEntry('user').pool, 'c');
  mocked.mock.restore(); store.close();
  const reopened = open();
  assert.equal(reopened.getEntry('user').pool, 'c');
  assert.equal(reopened.projectionStatus().pending, false);
  assert.equal(fs.existsSync(path.join(dataDir, 'archive', filename('user'), 'current.json')), true);
  assert.equal(fs.existsSync(path.join(dataDir, 'a2', filename('user'), 'v1.json')), true);
  assert.equal(reopened.reviewHistory().total, 2);
});

test('role-filtered B statistics preserve the correct joint hourly counts without content', t => {
  const { store } = fixture(t);
  for (const [id, role, recordedAt] of [['u', 'user', '2026-10-18T00:00:00Z'], ['a', 'assistant', '2026-10-18T01:00:00Z']]) store.appendRaw({ id, pool: 'b', role, recordedAt, sessionId: 'fake', text: '不保存的正文' });
  assert.deepEqual(store.dayStats('2026-10-18', { role: 'user' }).b, { total: 1, roles: { user: 1 }, hours: { '08': 1 } });
  assert.deepEqual(store.dayStats('2026-10-18', { role: 'assistant' }).b, { total: 1, roles: { assistant: 1 }, hours: { '09': 1 } });
});

test('v2 dictionary stays immutable while new versions use v4 and v1 bytes remain intact', t => {
  const { store, open, dataDir } = fixture(t);
  const v1 = fs.readFileSync(path.join(dataDir, 'dict/v1.md'), 'utf8');
  assert.equal(fs.readFileSync(path.join(dataDir, 'dict/v2.md'), 'utf8'), DICTIONARY_V2);
  assert.equal(entity(store, 'user').dictVersion, 'v6');
  promote(store, 'user');
  assert.equal(store.getEntry('user').dictVersion, 'v6');
  store.close();
  const reopened = open();
  assert.equal(fs.readFileSync(path.join(dataDir, 'dict/v1.md'), 'utf8'), v1);
  fs.writeFileSync(path.join(dataDir, 'dict/v2.md'), '不得原地改字典');
  assert.throws(() => reopened.flush(), /Immutable dictionary v2/);
});

test('revocation remains possible when a historical original has become unavailable', t => {
  const { store } = fixture(t);
  entity(store, 'user'); promote(store, 'user');
  const mock = t.mock.method(store, 'getRaw', () => null);
  const result = revoke(store, 'user');
  mock.mock.restore();
  assert.equal(result.pool, 'a2');
  assert.equal(store.getEntry('user').evidenceStatus, 'unverified');
  assert.equal(store.getEntry('user', { version: 2 }).pool, 'c');
});

test('an audited core endpoint cannot be used to promote another core relation', t => {
  const { store } = fixture(t);
  entity(store, 'user'); promote(store, 'user');
  relation(store, 'edge', 'self', 'user', '主人');
  store.db.prepare('INSERT INTO audits(entry_id,version,json) VALUES (?,?,?)').run('user', 2, JSON.stringify({ entryId: 'user', version: 2, action: 'downgrade_only', reasons: ['synthetic evidence failure'] }));
  assert.equal(store.getEntry('user').auditDowngraded, true);
  assert.throws(() => promote(store, 'edge'), /without audit downgrade/);
  assert.equal(store.getEntry('edge').pool, 'a2');
});
