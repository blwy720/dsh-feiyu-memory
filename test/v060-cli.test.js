import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../scripts/cli.js', import.meta.url));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'feiyu-v060-cli-'));
  t.after(() => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  const data = join(root, 'memory');
  const run = (args, payload) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', input: payload === undefined ? undefined : JSON.stringify(payload) });
  const call = (command, payload, flags = []) => {
    const result = run([command, '--data', data, '--instance', 'cli-v6', ...(payload === undefined ? [] : ['--input', '-']), ...flags], payload);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  return { root, data, run, call };
}

test('CLI version, doctor and JSON fetch/prepare/manage cover the v0.6 entry points', t => {
  const { run, call } = fixture(t);
  assert.equal(run(['--version']).stdout.trim(), '0.6.1');
  const doctor = call('doctor');
  assert.equal(doctor.moduleVersion, '0.6.1'); assert.equal(doctor.schema, 7); assert.equal(doctor.dictVersion, 'v6');
  call('append', { id: 'raw-user', pool: 'a', role: 'user', sessionId: 'main', turnId: 'turn-one', text: '今天装好了 ComfyUI', recordedAt: '2026-10-10T07:00:00Z' });
  call('append', { id: 'raw-assistant', pool: 'a', role: 'assistant', sessionId: 'main', turnId: 'turn-one', text: '随后确认启动日志。', recordedAt: '2026-10-10T07:00:01Z' });
  const fetched = call('fetch', { anchorId: 'raw-user' });
  assert.deepEqual(fetched.items.map(item => item.id), ['raw-user', 'raw-assistant']);
  assert.equal(fetched.items[0].checks, undefined);
  const prepared = call('prepare', { text: '装好了 ComfyUI', rawIds: ['raw-user'], pool: 'a2' });
  assert.equal(prepared.sources[0].exactMatch, true); assert.equal(prepared.written, false);
  const knowledge = call('manage', { action: 'knowledge', requestId: 'cli-knowledge', reason: '记录待验证的启动经验', knowledge: {
    id: 'knowledge-start', purpose: '检查 ComfyUI 启动', conditions: ['软件已安装'], method: '先查看启动日志，再核对服务状态', validationStatus: 'learned',
    sources: [{ rawId: 'raw-assistant', quote: '随后确认启动日志。' }],
  } });
  assert.equal(knowledge.id, 'knowledge-start');
  const body = call('read', undefined, ['--id', 'knowledge-start', '--view', 'body']);
  assert.equal(body.pool, 'd'); assert.equal(body.validationStatus, 'learned');
  assert.ok(call('manage', { action: 'report' }).successfulCommits >= 1);
  const dict = call('dict'); assert.equal(dict.version, 'v6');
});

test('CLI batch self-review exposes partial failures and exact quote repair details', t => {
  const { call } = fixture(t);
  for (const id of ['good', 'bad']) call('append', { id, pool: 'a', role: 'user', sessionId: 'main', text: `${id} 条件成立`, recordedAt: '2000-01-01T00:00:00Z' });
  const result = call('self-review', { requestId: 'cli-review-batch', items: [
    { key: 'good', rawIds: ['good'], omissions: [{ rawId: 'good', reason: '合成无长期信息' }], reason: '明确审过' },
    { key: 'bad', rawIds: ['bad'], entries: [{ id: 'invalid-output', kind: 'memory', text: '条件不成立', statementType: 'fact', sources: [{ rawId: 'bad', quote: 'bad 条件不成立' }] }], reason: '故意提供不一致引文检查失败' },
  ] }, ['--action', 'batch']);
  assert.equal(result.succeeded, 1); assert.equal(result.failed, 1);
  assert.equal(result.results[1].details.rawId, 'bad');
  assert.ok(result.results[1].details.candidates.length > 0);
  assert.equal(call('review-queue').total, 1);
});

test('privacy-audit counts legacy sensitive patterns without exposing values or migrating the database', t => {
  const { data, run } = fixture(t);
  mkdirSync(data);
  const file = join(data, 'memory.sqlite');
  const secret = 'sk-' + 'SyntheticOnlySecret1234567890';
  const legacy = new DatabaseSync(file);
  legacy.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE raw(id TEXT PRIMARY KEY,json TEXT)');
  legacy.prepare('INSERT INTO meta VALUES (?,?)').run('identity', JSON.stringify({ instanceId: 'cli-v6', timezone: 'Asia/Shanghai', schema: 6 }));
  legacy.prepare('INSERT INTO raw VALUES (?,?)').run('private-source-id', JSON.stringify({ text: `曾经记录 api_key=${secret}`, recordedAt: '2026-10-01T00:00:00Z' }));
  legacy.close();
  writeFileSync(join(data, 'identity.json'), 'do not rewrite this file');
  const before = readFileSync(file), names = readdirSync(data);
  const result = run(['privacy-audit', '--data', data, '--instance', 'cli-v6']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.readOnly, true); assert.equal(report.schema, 6);
  assert.ok(report.matchedFields >= 1); assert.ok(report.patterns.api_key >= 1);
  assert.equal(report.backupsScanned, false); assert.equal(report.projectionsScanned, false);
  assert.equal(result.stdout.includes(secret), false);
  assert.equal(result.stdout.includes('private-source-id'), false);
  assert.equal(result.stderr.includes(secret), false);
  assert.deepEqual(readFileSync(file), before);
  assert.deepEqual(readdirSync(data), names);
  assert.equal(readFileSync(join(data, 'identity.json'), 'utf8'), 'do not rewrite this file');
  const reopened = new DatabaseSync(file, { readOnly: true });
  assert.equal(JSON.parse(reopened.prepare("SELECT value FROM meta WHERE key='identity'").get().value).schema, 6);
  assert.equal(reopened.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get().n, 2);
  reopened.close();
});

test('privacy-audit does not create missing paths and rejects mutation options or wrong identity', t => {
  const { data, run } = fixture(t);
  assert.equal(run(['privacy-audit', '--data', data]).status, 1);
  assert.equal(existsSync(data), false);
  assert.equal(run(['privacy-audit', '--data', data, '--apply']).status, 1);
  assert.equal(existsSync(data), false);
  mkdirSync(data);
  const db = new DatabaseSync(join(data, 'memory.sqlite'));
  db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT)');
  db.prepare('INSERT INTO meta VALUES (?,?)').run('identity', JSON.stringify({ instanceId: 'correct', schema: 7 }));
  db.close();
  const mismatch = run(['privacy-audit', '--data', data, '--instance', 'wrong']);
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /身份不匹配/);
});
