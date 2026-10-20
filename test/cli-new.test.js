import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('../scripts/cli.js', import.meta.url));

test('CLI v0.2 keeps self-review/core/graph distinct from administrative retention review', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feiyu-cli-v2-'));
  try {
    const inputFile = join(dir, 'input.json');
    const run = (command, flags = [], payload, expected = 0) => {
      if (payload !== undefined) { writeFileSync(inputFile, JSON.stringify(payload)); flags = [...flags, '--input', inputFile]; }
      const result = spawnSync(process.execPath, [cli, command, '--data', join(dir, 'data'), '--instance', 'synthetic-cli-v2', ...flags], { encoding: 'utf8' });
      assert.equal(result.status, expected, result.stderr || result.stdout);
      return expected === 0 ? JSON.parse(result.stdout) : result.stderr;
    };
    const version = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' });
    assert.equal(version.stdout.trim(), '0.5.0');
    assert.equal(run('doctor').moduleVersion, '0.5.0');
    run('append', [], { id: 'original', pool: 'a', role: 'user', sessionId: 'synthetic', text: '我是你的主人。', recordedAt: '2000-01-01T00:00:00Z' });
    assert.equal(run('review-queue').total, 1);
    const evidence = [{ rawId: 'original', quote: '我是你的主人。', support: 'supports' }];
    const review = { requestId: 'cli-self-review', rawIds: ['original'], reason: '提炼明确说出的身份关系', entries: [
      { id: 'owner', statementType: 'fact', kind: 'entity', text: '主人', sources: evidence },
      { id: 'owner-edge', statementType: 'fact', kind: 'relation', text: '自称是肥鱼的主人', from: 'self', to: 'owner', rel: '主人', sources: evidence },
    ] };
    assert.equal(run('self-review', [], review).completed, 1);
    assert.equal(run('self-review', [], review).duplicate, true);
    assert.equal(run('review-queue').total, 0);
    assert.equal(run('slide').blocked, 1);
    assert.equal(run('self-review', ['--action', 'history', '--id', 'owner']).items[0].type, 'self_review');
    run('core', [], { requestId: 'cli-core-owner', id: 'owner', expectedVersion: 1, action: 'promote', category: 'identity', reason: '关系网实体节点' });
    run('core', [], { requestId: 'cli-core-edge', id: 'owner-edge', expectedVersion: 1, action: 'promote', category: 'relationship', reason: '保留显式有向关系' });
    const graph = run('graph', ['--center', 'self', '--depth', '1', '--pool', 'c']);
    assert.equal(graph.edges[0].to, 'owner');
    const read = run('read', ['--id', 'owner-edge', '--type', 'relation', '--pool', 'c']);
    assert.equal(read.rel, '主人');
    assert.equal(read.coreDecision.category, 'relationship');
    assert.equal(run('list', ['--pool', 'a2']).total, 0);
    assert.equal(run('list', ['--pool', 'c']).total, 2);
    run('review', [], { ids: ['original'], decision: 'retain', reason: '管理员单独决定保留原文' });
    assert.equal(run('slide', ['--apply']).removed, 1);
    assert.equal(run('read', ['--id', 'original']).text, '我是你的主人。');
    assert.match(run('self-review', ['--action', 'discard'], {}, 1), /submit.*history/);
    assert.match(run('core', [], { requestId: 'bad-core', id: 'owner', expectedVersion: 2, action: 'discard', reason: '不能删除原文' }, 1), /action/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI B pool supports role-filtered statistics without retaining or returning external bodies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feiyu-cli-v2-b-'));
  try {
    const inputFile = join(dir, 'input.json');
    writeFileSync(inputFile, JSON.stringify({ id: 'external', pool: 'b', role: 'assistant', sessionId: 'synthetic-external', text: 'synthetic private external conversation', recordedAt: '2026-01-02T01:00:00Z' }));
    const common = ['--data', join(dir, 'data'), '--instance', 'synthetic-b'];
    const appended = spawnSync(process.execPath, [cli, 'append', ...common, '--input', inputFile], { encoding: 'utf8' });
    assert.equal(appended.status, 0, appended.stderr);
    const listed = spawnSync(process.execPath, [cli, 'list', ...common, '--pool', 'b', '--type', 'assistant', '--date', '2026-01-02'], { encoding: 'utf8' });
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout).items, [{ date: '2026-01-02', total: 1, roles: { assistant: 1 }, hours: { '09': 1 } }]);
    assert.ok(!listed.stdout.includes('private external conversation'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI preference writes B3 self-reports and exposes immutable changes through history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feiyu-cli-v2-b3-'));
  try {
    const inputFile = join(dir, 'input.json');
    const run = (command, flags = [], payload, expected = 0) => {
      if (payload !== undefined) { writeFileSync(inputFile, JSON.stringify(payload)); flags = [...flags, '--input', inputFile]; }
      const result = spawnSync(process.execPath, [cli, command, '--data', join(dir, 'data'), '--instance', 'synthetic-cli-b3', ...flags], { encoding: 'utf8' });
      assert.equal(result.status, expected, result.stderr || result.stdout);
      return expected === 0 ? JSON.parse(result.stdout) : result.stderr;
    };
    const input = { requestId: 'cli-pref-set', id: 'tea', expectedVersion: 0, action: 'set', topic: '茶香', stance: 'like', text: '我偏爱茶香这个意象。', reason: '这是自己的喜好，不是用户喜好' };
    assert.equal(run('preference', [], input).pool, 'b3');
    assert.equal(run('preference', [], input).duplicate, true);
    const read = run('read', ['--id', 'tea', '--type', 'preference', '--pool', 'b3']);
    assert.equal(read.sourceNature, 'model_self_report');
    assert.equal(read.subject, 'self');
    assert.equal(read.checks.supportJudgment.status, 'self_report');
    assert.equal(run('search', ['--pool', 'b3', '--query', '茶香']).total, 1);
    assert.equal(run('list', ['--pool', 'c']).total, 0);
    assert.match(run('write', [], { kind: 'preference', text: '不能走普通入口' }, 1), /kind/);
    run('preference', [], { requestId: 'cli-pref-revoke', id: 'tea', expectedVersion: 1, action: 'revoke', reason: '暂不保留当前喜好' });
    assert.equal(run('list', ['--pool', 'b3', '--status', 'active']).total, 0);
    assert.equal(run('read', ['--id', 'tea', '--version-number', '1']).status, 'active');
    const history = run('self-review', ['--action', 'history', '--id', 'tea']);
    assert.equal(history.total, 2);
    assert.ok(history.items.every(item => item.type === 'preference'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
