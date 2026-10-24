import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore } from '../lib/store.js';
import { exportBackup, verifyBackup, restoreBackup } from '../lib/backup.js';

const now = () => new Date('2026-10-24T12:00:00.000Z');
const oldTables = ['raw', 'originals', 'receipts', 'entries', 'evidence', 'reviews', 'deletion_tombstones', 'memory_decisions'];
const newTables = [...oldTables, 'workflow_events', 'workflow_sources'];
const sha = value => createHash('sha256').update(value).digest('hex');
function snapshot(db, tables) {
  return Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}
function inspect(file, read) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return read(db); } finally { db.close(); }
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-v060-backup-'));
  const dataDir = path.join(root, 'source'), targetDir = path.join(root, 'restored');
  const file = path.join(root, 'synthetic.feiyu-backup');
  const instanceId = 'synthetic-v060-backup';
  const handles = [];
  const open = directory => {
    const store = new MemoryStore({ dataDir: directory, instanceId, now });
    handles.push(store); return store;
  };
  t.after(() => {
    for (const handle of handles) handle.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('feiyu-v060-backup-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, dataDir, targetDir, file, instanceId, open };
}

test('schema 6 export and restored startup upgrade preserve legacy canonical JSON byte for byte', async t => {
  const f = fixture(t), seed = f.open(f.dataDir);
  // Construct an explicit synthetic schema-6 authority fixture. This does not
  // read an installed plugin, user database, profile, or earlier package.
  const raw = seed._prepareRaw({ id: 'legacy-original', pool: 'a', role: 'user', sessionId: 'legacy-session',
    text: '旧版原文 `格式`：保留  空格😀，2026-10-10T12:00:00Z 不改写。', recordedAt: '2026-10-10T12:00:00.000Z' });
  delete raw.redaction;
  seed._transaction(() => seed._commitRaw(raw));
  const legacy = seed._prepareEntry({ id: 'legacy-memory', kind: 'memory', text: '主人自述旧版操作已完成。',
    statementType: 'self_report', sources: [{ rawId: raw.id, quote: '旧版原文 `格式`', support: 'context_only' }] });
  legacy.dictVersion = 'v5'; legacy.policyVersion = 5;
  seed._transaction(() => seed._commitPolicyEntry(legacy, { expectedVersion: 0 }));
  seed.reviewRetention({ ids: [raw.id], decision: 'retain', reason: '合成旧版保留决定' });
  seed.slide({ apply: true });
  const original = snapshot(seed.db, oldTables);
  assert.ok(original.originals.length, 'exercise retained originals as well as entry history');
  const identity = { ...seed.metadata(), schema: 6 };
  seed.close();
  const legacyDb = new DatabaseSync(path.join(f.dataDir, 'memory.sqlite'));
  try {
    // Only the newly created temporary fixture is converted to the old schema.
    // Version 6 has neither workflow authority table nor a workflow start time.
    legacyDb.exec('DROP TABLE workflow_sources; DROP TABLE workflow_events;');
    legacyDb.prepare('DELETE FROM meta WHERE key=?').run('workflow_history_started_at');
    legacyDb.prepare('UPDATE meta SET value=? WHERE key=?').run(JSON.stringify(identity), 'identity');
  } finally { legacyDb.close(); }
  fs.writeFileSync(path.join(f.dataDir, 'identity.json'), JSON.stringify(identity));

  const exported = await exportBackup({ dataDir: f.dataDir, file: f.file, expectedInstanceId: f.instanceId });
  assert.equal(exported.validated, true);
  assert.equal(exported.manifest.identity.schema, 6, 'validation must upgrade only its disposable clone');
  inspect(path.join(f.dataDir, 'memory.sqlite'), db => {
    assert.deepEqual(snapshot(db, oldTables), original);
    assert.equal(JSON.parse(db.prepare('SELECT value FROM meta WHERE key=?').get('identity').value).schema, 6);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='workflow_events'").get(), undefined);
  });
  await restoreBackup({ file: f.file, targetDir: f.targetDir, expectedInstanceId: f.instanceId, expectedSha256: exported.sha256 });
  assert.equal(sha(fs.readFileSync(path.join(f.targetDir, 'memory.sqlite'))), exported.manifest.database.sha256);
  const upgraded = f.open(f.targetDir);
  assert.equal(upgraded.metadata().schema, 7);
  assert.deepEqual(snapshot(upgraded.db, oldTables), original);
  assert.equal(upgraded.getRaw(raw.id).text, raw.text);
  assert.equal(upgraded.getEntry('legacy-memory').policyVersion, 5);
  assert.equal(upgraded.getEntry('legacy-memory').dictVersion, 'v5');
  assert.equal(upgraded.getEntry('legacy-memory').currentValidity, 'unknown');
  assert.equal(upgraded.db.prepare('SELECT count(*) AS n FROM workflow_events').get().n, 0,
    'migration must not invent historical checks, merges or committed activity');
});

test('schema 7 backup preserves D validation, exact issue links, checks and reversible merge sources', async t => {
  const f = fixture(t), store = f.open(f.dataDir);
  for (const [id, sessionId, text] of [
    ['install', 'old-session', '合成事件：已安装工具，限定 Node 24。'],
    ['configure', 'new-session', '合成事件：配置完成，尚未验证其他环境。'],
    ['validation', 'new-session', '合成测试执行通过，只验证了本机 Node 24。'],
  ]) store.appendRaw({ id, sessionId, role: 'user', pool: 'a', text });
  const sources = ['install', 'configure'].map(rawId => ({ rawId, quote: store.getRaw(rawId).text, support: 'context_only' }));
  for (const [index, id] of ['install-memory', 'configure-memory'].entries()) {
    store.writeEntry({ id, kind: 'memory', text: sources[index].quote, statementType: 'self_report', sources: [sources[index]] });
  }
  const parents = [{ id: 'install-memory', version: 1 }, { id: 'configure-memory', version: 1 }];
  store.linkThread({ requestId: 'issue-first', threadId: 'tool-installation', title: '工具安装事项', entries: parents,
    reason: '同一事项在两个会话中的明确记录' });
  store.mergeEntries({ requestId: 'merge-setup', targets: parents, reason: '归并已完成安装配置的关键记录',
    entry: { id: 'setup', kind: 'memory', text: '用户自述完成安装配置；只涉及本机 Node 24。', statementType: 'self_report', sources } });
  store.writeKnowledge({ requestId: 'learn-setup', id: 'setup-method', purpose: '在本机复用合成安装方法',
    conditions: ['本机 Node 24', '先核对插件版本'], method: '检查版本，再执行合成测试；没有验证其他环境。',
    environment: { name: 'Node', version: '24', notes: '仅合成测试环境' }, validationStatus: 'verified',
    dependencyEntries: [{ id: 'setup', version: 1 }],
    externalSources: [{ url: 'https://example.com/synthetic-manual', title: '合成操作文档' }],
    validation: { method: '执行合成检查', result: '通过，仅本机 Node 24', sources: [{ rawId: 'validation', quote: '合成测试执行通过，只验证了本机 Node 24。' }] },
    reason: '记录明确验证过程，不把其他环境当作已验证' });
  store.reviewValidity({ requestId: 'check-method', targets: [{ id: 'setup-method', version: 1 }], currentValidity: 'valid',
    check: { method: '本机复查', result: '通过' }, sources: [{ rawId: 'validation', quote: '合成测试执行通过' }],
    reviewAfter: '2026-10-25T12:00:00.000Z', reason: '保留检查时间和再次复核期限' });
  store.linkThread({ requestId: 'issue-method', threadId: 'tool-installation', entries: [{ id: 'setup-method', version: 1 }], reason: '经验来源于该事项' });
  const authority = snapshot(store.db, newTables);
  const expectedKnowledge = store.getEntry('setup-method'), expectedMerge = store.getEntry('setup');
  const expectedThread = store.readThread({ threadId: 'tool-installation' });
  const exported = await exportBackup({ dataDir: f.dataDir, file: f.file, expectedInstanceId: f.instanceId });
  assert.equal(exported.manifest.identity.schema, 7);
  assert.equal((await verifyBackup({ file: f.file, expectedInstanceId: f.instanceId })).validated, true);
  assert.deepEqual(snapshot(store.db, newTables), authority, 'export/verification must not mutate the live authority');
  await restoreBackup({ file: f.file, targetDir: f.targetDir, expectedInstanceId: f.instanceId, expectedSha256: exported.sha256 });
  assert.equal(sha(fs.readFileSync(path.join(f.targetDir, 'memory.sqlite'))), exported.manifest.database.sha256);
  const restored = f.open(f.targetDir);
  assert.deepEqual(snapshot(restored.db, newTables), authority);
  assert.deepEqual(restored.getEntry('setup-method'), expectedKnowledge);
  assert.deepEqual(restored.getEntry('setup'), expectedMerge);
  assert.deepEqual(restored.readThread({ threadId: 'tool-installation' }), expectedThread);
  assert.equal(expectedKnowledge.validationStatus, 'verified');
  assert.equal(expectedKnowledge.validation.autoVerified, false);
  assert.equal(expectedKnowledge.currentValidity, 'valid');
  assert.equal(expectedKnowledge.reviewDue, false);
  assert.equal(expectedKnowledge.reviewAfter, '2026-10-25T12:00:00.000Z');
  assert.deepEqual(expectedMerge.lineage.parents.map(({ id, version }) => ({ id, version })), parents);
  assert.deepEqual(expectedMerge.sources.map(({ rawId, quote }) => ({ rawId, quote })), sources.map(({ rawId, quote }) => ({ rawId, quote })));
  assert.ok(restored.db.prepare('SELECT 1 FROM workflow_sources WHERE raw_id=?').get('validation'));

  // Recovered append-only workflow records must remain usable, including
  // rollback of a merge and invalidation of dependents without deleting history.
  restored.revokeMerge({ requestId: 'undo-restored-merge', mergeRequestId: 'merge-setup', reason: '恢复后明确撤销合并' });
  assert.equal(restored.getEntry('setup').status, 'archived');
  assert.equal(restored.getEntry('install-memory').mergedInto, undefined);
  assert.equal(restored.getEntry('setup-method').dependencyReviewPending, true);
  assert.equal(restored.getRaw('install').text, sources[0].quote);
  assert.equal(store.getEntry('setup').status, 'active', 'restored changes cannot affect the source instance');
});
