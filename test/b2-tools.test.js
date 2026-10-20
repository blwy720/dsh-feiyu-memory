import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { MemoryStore } from '../lib/store.js';
import { createTools } from '../lib/tools.js';

test('B2 tools page external references separately from raw evidence and preserve exact versions until expiry', t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'feiyu-b2-tools-'));
  let time = '2026-10-01T00:00:00Z';
  const store = new MemoryStore({ dataDir, instanceId: 'synthetic-b2-tools', now: () => new Date(time) });
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const api = createTools(store);
  const input = { requestId: 'b2-first', id: 'discovery', expectedVersion: 0, action: 'write', text: '合成冲浪资料提出一个值得再查的线索。', judgment: '目前只是待核查线索，不是已确认事实。', reason: '短期保留关键内容以供复查',
    sources: Array.from({ length: 5 }, (_, i) => ({ url: `https://example.invalid/source-${i}`, title: `合成来源${i}`, accessedAt: '2026-09-30T00:00:00Z' })) };
  const saved = api.memory_b2_write(input);
  assert.equal(saved.pool, 'b2');
  assert.equal(saved.evidenceStatus, 'external_reference');
  assert.equal(saved.text, undefined);
  assert.equal(api.memory_b2_write(input).duplicate, true);
  const first = api.memory_read({ id: 'discovery', kind: 'b2', pool: 'b2' });
  assert.equal(first.externalSourceCount, 5);
  assert.equal(first.externalSources.length, 4);
  assert.equal(first.externalSourcesPage.hasMore, true);
  assert.deepEqual(first.sources, []);
  assert.deepEqual(first.originals, []);
  assert.equal(first.sourceCount, 0);
  assert.equal(first.checks.quoteLocation.status, 'not_checked');
  assert.equal(first.checks.supportJudgment.status, 'not_independently_verified');
  assert.equal(first.evidenceStatus, 'external_reference');
  assert.equal(first.b2Decision.reason, input.reason);
  assert.equal(first.judgment, input.judgment);
  const next = api.memory_read({ id: 'discovery', evidenceOffset: first.externalSourcesPage.nextOffset });
  assert.equal(next.externalSources.length, 1);
  assert.equal(next.externalSources[0].url, 'https://example.invalid/source-4');
  assert.equal(next.externalSourcesPage.hasMore, false);
  const suppressed = api.memory_read({ id: 'discovery', evidenceLimit: 0 });
  assert.equal(suppressed.externalSources.length, 0);
  assert.equal(suppressed.externalSourcesPage.nextOffset, null);
  assert.equal(api.memory_search({ pool: 'b2', q: '合成冲浪' }).total, 1);
  assert.equal(api.memory_search({ pool: 'b2', q: '待核查线索' }).total, 1);
  assert.equal(api.memory_list({ type: 'b2' }).candidates[0].externalSourceCount, 5);
  assert.equal(api.memory_read({ id: 'discovery', kind: 'raw' }), null);
  assert.equal(api.memory_read({ id: 'discovery', version: 99 }), null);
  assert.equal(api.memory_read('self'), null);
  assert.throws(() => api.memory_write({ kind: 'b2', text: '绕过专属入口' }), /memory_b2_write/);
  assert.throws(() => api.memory_b2_write({ ...input, evidenceStatus: 'quote_verified' }), /系统固定/);
  assert.throws(() => api.memory_b2_write({ ...input, expiresAt: '2099-01-01T00:00:00Z' }), /系统固定/);
  time = '2026-10-03T00:00:00Z';
  api.memory_b2_write({ ...input, requestId: 'b2-update', expectedVersion: 1, text: '更新后的短期关键内容。' });
  assert.equal(api.memory_read({ id: 'discovery', version: 1 }).text, input.text);
  assert.equal(api.memory_read('discovery').expiresAt, saved.expiresAt);
  assert.equal(api.memory_list({ pool: 'b2', includeHistory: true }).total, 2);
  time = '2026-10-15T00:00:00Z';
  assert.equal(api.memory_read('discovery'), null);
  assert.equal(api.memory_read({ id: 'discovery', version: 1 }), null);
  assert.equal(api.memory_list({ pool: 'b2', includeHistory: true }).total, 0);
  assert.equal(api.memory_b2_write(input).duplicate, true);
  assert.equal(api.memory_search({ q: '合成冲浪' }).total, 0);
});

test('B2 CLI exposes write/query/read and administrative expiry preview without raw evidence promotion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feiyu-b2-cli-'));
  const cli = fileURLToPath(new URL('../scripts/cli.js', import.meta.url));
  try {
    const inputFile = join(dir, 'input.json');
    const run = (command, flags = [], payload) => {
      if (payload !== undefined) { writeFileSync(inputFile, JSON.stringify(payload)); flags = [...flags, '--input', inputFile]; }
      const result = spawnSync(process.execPath, [cli, command, '--data', join(dir, 'data'), '--instance', 'synthetic-b2-cli', ...flags], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return JSON.parse(result.stdout);
    };
    const written = run('b2-write', [], { requestId: 'cli-b2', id: 'note', expectedVersion: 0, action: 'write', text: '合成外部资料线索', judgment: '需要后续核查', reason: '短期保存',
      sources: [{ url: 'https://example.invalid/note', title: '合成网页', accessedAt: '2000-01-01T00:00:00Z' }] });
    assert.equal(written.kind, 'b2');
    const read = run('read', ['--id', 'note', '--pool', 'b2', '--type', 'b2']);
    assert.equal(read.externalSources[0].title, '合成网页');
    assert.equal(read.sourceCount, 0);
    assert.equal(run('list', ['--pool', 'b2']).total, 1);
    assert.equal(run('search', ['--type', 'b2', '--query', '外部资料']).total, 1);
    assert.equal(run('b2-cleanup').applied, false);
    assert.equal(run('b2-cleanup', ['--apply']).removed, 0);
    run('b2-write', [], { requestId: 'cli-b2-revoke', id: 'note', expectedVersion: 1, action: 'revoke', reason: '不再列为当前线索' });
    assert.equal(run('list', ['--pool', 'b2', '--status', 'active']).total, 0);
    assert.equal(run('read', ['--id', 'note', '--version-number', '1']).status, 'active');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
