import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { MemoryStore } from '../lib/store.js';

const previous = process.env.FEIYU_PREVIOUS_PACKAGE;
test('opt-in: actual previous installed package migrates immutable data without promoting old entries', { skip: !previous }, async t => {
  const manifest = JSON.parse(readFileSync(join(previous, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'dsh-feiyu-memory');
  assert.ok(['0.1.1', '0.1.2', '0.2.0', '0.3.0', '0.4.0'].includes(manifest.version));
  const supportsRelations = ['0.1.2', '0.2.0', '0.3.0', '0.4.0'].includes(manifest.version);
  const supportsPools = ['0.2.0', '0.3.0', '0.4.0'].includes(manifest.version);
  const supportsArchive = ['0.3.0', '0.4.0'].includes(manifest.version);
  const { MemoryStore: PreviousStore } = await import(pathToFileURL(join(previous, 'lib/store.js')).href);
  const dataDir = mkdtempSync(join(tmpdir(), 'feiyu-actual-upgrade-'));
  const handles = [];
  t.after(() => {
    for (const store of handles.reverse()) store.close();
    assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()));
    assert.ok(dataDir.includes('feiyu-actual-upgrade-'));
    rmSync(dataDir, { recursive: true, force: true });
  });
  const options = { dataDir, instanceId: 'synthetic-upgrade-fish', now: () => new Date('2026-10-18T04:00:00Z') };
  const old = new PreviousStore(options); handles.push(old);
  old.appendRaw({ id: 'source', sessionId: 'synthetic-session', pool: 'a', role: 'user', text: '我是肥鱼的主人，阿明是我的朋友。', recordedAt: '2026-10-01T04:00:00Z' });
  const sources = [{ rawId: 'source', quote: '我是肥鱼的主人', support: 'supports' }];
  old.writeEntry({ id: 'owner', kind: 'entity', text: '主人', hooks: ['主人'], sources });
  if (supportsRelations) old.writeEntry({ id: 'legacy-relation', kind: 'relation', from: 'self', to: supportsPools ? 'owner' : '旧版名称端点', rel: '主人', text: '旧关系', hooks: ['主人'], sources });
  old.writeEntry({ id: 'event', kind: 'memory', text: '普通事件第一版', hooks: ['事件'], sources });
  old.writeEntry({ id: 'event', kind: 'memory', text: '普通事件第二版', hooks: ['事件'], sources });
  if (supportsPools) {
    old.setCore({ requestId: 'core-owner', id: 'owner', expectedVersion: 1, action: 'promote', reason: '已有原文支持关系身份', category: 'identity' });
    old.setCore({ requestId: 'core-edge', id: 'legacy-relation', expectedVersion: 1, action: 'promote', reason: '保留有向主人关系', category: 'relationship' });
    old.setPreference({ requestId: 'like-quiet', id: 'quiet', expectedVersion: 0, action: 'set', topic: '安静', stance: 'like', text: '我喜欢安静地整理笔记。', reason: '合成自述升级样例' });
  }
  old.reviewRetention({ ids: ['source'], decision: 'retain', reason: '合成升级测试保留证据' });
  old.slide({ apply: true });
  const activeCaptures = [];
  if (supportsArchive) {
    old.writeA3({ requestId: 'archive-event', action: 'write', id: 'archive', expectedVersion: 0, text: '合成归档要点', reason: '保留升级前的精确来源', statementType: 'summary', derivedFrom: ['event'], coverage: { scope: [{ id: 'event', version: 2 }], covered: ['event'], notCovered: [], scopeNote: '仅审查合成事件的第二版' } });
    old.writeB2({ requestId: 'web-discovery', action: 'write', id: 'web-note', expectedVersion: 0, text: '合成发现', judgment: '待核对的线索', reason: '测试旧笔记迁移', sources: [{ url: 'https://example.org/', title: '合成来源', accessedAt: '2026-10-18T03:00:00Z' }] });
    // Exercise the actual previous capture signature and multipart originals,
    // not only the retained original rescued by slide() above. No completion
    // may be inferred from this user/assistant pair during schema migration.
    for (const [id, role, texts, recordedAt] of [
      ['recent-human', 'user', ['升级前真人第一段😀', '升级前真人第二段'], '2026-10-18T03:59:00Z'],
      ['recent-fish', 'assistant', ['升级前肥鱼回复🐟'], '2026-10-18T03:59:10Z'],
    ]) {
      const capture = { id, pool: 'a', role, records: texts.map((text, index) => ({
        id: texts.length === 1 ? id : `${id}-part-${index}`, pool: 'a', role, text,
        sessionId: 'previous-main-session', turnId: '1', sourceRoot: id, recordedAt,
        sourceNature: role === 'user' ? 'user_statement' : 'model_output', tags: [`dsh:text-part:${index}`],
      })) };
      old.captureMessage(capture); activeCaptures.push(capture);
    }
    assert.equal(old.listRaw().length, 3);
  }
  const tables = ['raw', 'originals', 'entries', 'evidence', 'receipts', 'reviews', 'deletion_tombstones'];
  if (supportsPools) tables.push('memory_decisions', 'self_review_completed');
  if (supportsArchive) tables.push('b2_notes', 'b2_requests', 'b2_expirations', 'a2_reviews', 'a2_retirements', 'captures');
  const digest = store => Object.fromEntries(tables.map(table => [table, createHash('sha256').update(JSON.stringify(store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).digest('hex')]));
  const before = digest(old);
  old.close();
  const updated = new MemoryStore(options); handles.push(updated);
  assert.equal(updated.metadata().schema, 6);
  assert.deepEqual(digest(updated), before);
  assert.equal(updated.getRaw('source').text, '我是肥鱼的主人，阿明是我的朋友。');
  assert.equal(updated.listEntries({ pool: 'c' }).length, supportsPools ? 2 : 0);
  assert.equal(updated.listEntries({ pool: 'a3' }).length, supportsArchive ? 1 : 0);
  if (supportsArchive) {
    assert.equal(updated.getB2('web-note').text, '合成发现');
    assert.equal(updated.getEntry('archive').sourceEntries[0].version, 2);
    assert.equal(updated.listRaw().length, 3);
    for (const capture of activeCaptures) assert.equal(updated.verifyCaptureMessage(capture), true);
    assert.deepEqual(digest(updated), before, 'capture verification is read-only');
    assert.equal(updated.listPreinjectCandidates().items[0].totalBlocks, 3);
    assert.equal(updated.db.prepare('SELECT count(*) AS n FROM completed_rounds').get().n, 0);
    assert.equal(updated.db.prepare('SELECT count(*) AS n FROM completed_round_parts').get().n, 0);
    assert.equal(updated.db.prepare('SELECT count(*) AS n FROM preinject_choices').get().n, 0);
  }
  assert.equal(updated.readPreinject({ targetSessionId: 'never-claimed', turnId: 'first' }), null);
  assert.equal(updated.listEntries({ pool: 'b3' }).length, supportsPools ? 1 : 0);
  assert.equal(updated.listEntries({ pool: 'a2', includeHistory: true }).length, supportsRelations ? 4 : 3);
  if (supportsRelations) {
    assert.equal(updated.getEntry('legacy-relation').to, supportsPools ? 'owner' : '旧版名称端点');
    const graph = updated.graph({ pool: supportsPools ? 'c' : 'a2' });
    if (supportsPools) assert.ok(graph.edges.some(edge => edge.from === 'self' && edge.to === 'owner'));
    else assert.ok(graph.nodes.some(node => node.placeholder && node.name === '旧版名称端点'));
  }
  const hash = createHash('sha256').update('event').digest('hex');
  assert.ok(existsSync(join(dataDir, 'a2', hash, 'v1.json')));
  assert.equal(existsSync(join(dataDir, 'archive', hash, 'v1.json')), false);
  updated.close();
  assert.throws(() => new PreviousStore(options), /schema mismatch/);
});
