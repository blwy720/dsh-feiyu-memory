import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { MemoryStore } from '../lib/store.js';
import { createTools } from '../lib/tools.js';

test('user coverage example preserves the unrelated A2 through review, retirement, audit and reopen', t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'feiyu-a3-workflow-'));
  let clock = '2026-09-10T04:00:00.000Z';
  const options = { dataDir, instanceId: 'workflow-fish', now: () => new Date(clock) };
  let store = new MemoryStore(options);
  let api = createTools(store);
  t.after(() => {
    store.close(); assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()));
    assert.ok(dataDir.includes('feiyu-a3-workflow-')); rmSync(dataDir, { recursive: true, force: true });
  });
  const contents = new Map([
    ['a2-3', ['user', '归档需要区分原文和推断。']],
    ['a2-5', ['assistant', '这一条是另一话题，暂不归到证据讨论里。']],
    ['a2-7', ['assistant', '我会保留原话依据，不把自己的推断冒充原话。']],
    ['a2-11', ['user', '关键消息要能核对，归纳允许但要标清性质。']],
  ]);
  for (const [id, [role, text]] of contents) {
    store.appendRaw({ id: `raw-${id}`, sessionId: 'example-main', pool: 'a', role, text, recordedAt: '2026-09-01T04:00:00.000Z' });
    api.memory_write({ id, kind: 'memory', statementType: 'self_report', text, hooks: ['记忆'], sources: [{ rawId: `raw-${id}`, quote: text, support: 'supports' }] });
  }
  assert.equal(store.listEntries({ pool: 'a3' }).length, 0);
  const rawBefore = JSON.stringify(store.db.prepare('SELECT * FROM raw ORDER BY rowid').all());
  const covered = ['a2-3', 'a2-7', 'a2-11'];
  const input = {
    requestId: 'coverage-example', id: 'archive-evidence', expectedVersion: 0, action: 'write',
    reason: '保存这次证据讨论中的明确要求与承诺',
    body: { time: '2026年9月1日对话', persons: ['用户', '肥鱼'], event: '用户要求归档区分原文与推断、关键消息能核对；肥鱼承诺保留原话依据。' },
    statementType: 'self_report',
    derivedFrom: covered,
    coverage: { scope: [...contents.keys()].map(id => ({ id, version: 1 })), covered, notCovered: [{ id: 'a2-5', reason: '这是另一话题，需要单独审查。' }], scopeNote: '仅这四条已阅读笔记，不宣称穷尽所有相关记忆。' },
  };
  assert.throws(() => api.memory_a3_write({ ...input, coverage: { ...input.coverage, notCovered: [] } }));
  assert.equal(store.listEntries({ pool: 'a3' }).length, 0, 'incomplete coverage must not commit');
  const saved = api.memory_a3_write(input);
  assert.equal(saved.evidenceStatus, 'derived_only');
  assert.equal(api.memory_a3_write(input).duplicate, true);
  assert.deepEqual(store.getEntry(saved.id).coverage.notCovered.map(item => item.id), ['a2-5']);
  clock = '2026-10-10T04:00:00.000Z';
  api.memory_a2_cleanup({ apply: true });
  assert.equal(store.listEntries({ pool: 'a2' }).length, 4, 'A3 coverage alone never authorizes retirement');
  api.memory_a2_review({ requestId: 'approve-covered', reason: '已确认这三条的长期关键内容有归档', items: covered.map(id => ({ id, version: 1, decision: 'archived', a3Ids: [saved.id], reason: '由该 A3 覆盖精确版本。' })) });
  api.memory_a2_cleanup({});
  assert.equal(store.listEntries({ pool: 'a2' }).length, 4, 'preview must not mutate');
  api.memory_a2_cleanup({ apply: true });
  assert.deepEqual(store.listEntries({ pool: 'a2' }).map(entry => entry.id), ['a2-5']);
  assert.deepEqual(api.memory_a2_review_queue({}).items.map(entry => entry.id), ['a2-5']);
  const archive = api.memory_read({ id: saved.id, kind: 'a3', pool: 'a3' });
  assert.equal(archive.evidenceStatus, 'derived_only');
  assert.equal(archive.orphaned, true, 'parent A2 left the active pool; this does not invalidate the independently readable A3');
  assert.equal(archive.lineageBroken, false, 'retained historical A2 still leads to originals');
  assert.equal(store.getEntry('a2-3', { version: 1 }).retired, true);
  assert.equal(JSON.stringify(store.db.prepare('SELECT * FROM raw ORDER BY rowid').all()), rawBefore);
  store.audit(); store.flush();
  assert.equal(store.getEntry(saved.id).evidenceStatus, 'derived_only');
  const hash = createHash('sha256').update('a2-3').digest('hex');
  assert.equal(existsSync(join(dataDir, 'a2', hash, 'current.json')), false);
  store.close(); store = new MemoryStore(options); api = createTools(store);
  assert.deepEqual(store.listEntries({ pool: 'a2' }).map(entry => entry.id), ['a2-5']);
  assert.equal(api.memory_read({ id: saved.id }).evidenceStatus, 'derived_only');
  assert.equal(existsSync(join(dataDir, 'a2', hash, 'current.json')), false);
  assert.equal(JSON.stringify(store.db.prepare('SELECT * FROM raw ORDER BY rowid').all()), rawBefore);
});
