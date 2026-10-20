import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { MemoryStore } from '../lib/store.js';
import { Config, createHostAdapter } from '../lib/index.js';
import { buildWake, buildCoreData, buildPreferenceData } from '../lib/lifecycle.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'feiyu-integration-policy-'));
  const dataDir = join(root, 'data');
  const store = new MemoryStore({ dataDir, instanceId: 'synthetic-integration' });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, dataDir, store };
}
const data = text => JSON.parse(text.slice(text.indexOf('\n') + 1));

test('optional backup configuration and path failure cannot disable primary host capture', async t => {
  const { dataDir, store } = fixture(t);
  store.close();
  const config = { dataDir, instanceId: 'synthetic-integration', sessionScope: 'profile', participation: 'interactive' };
  assert.equal(Config['~standard'].validate(config).value.backupEnabled, false);
  for (const extra of [{ backupIntervalDays: 0 }, { backupIntervalDays: 31 }, { backupEnabled: true },
    { backupEnabled: 'true' }, { backupDir: 'relative/path' }, { backupSchedule: 'weekly' },
    { backupSchedule: 'monthly', backupIntervalDays: 30 }]) {
    assert.ok(Config['~standard'].validate({ ...config, ...extra }).issues);
  }
  const session = { id: 'main', header: { id: 'main' }, isOwnSeq: () => true };
  const agent = { id: 'main', session, options: {} }, handlers = new Map();
  const ctx = { tools: { register: () => () => {} }, sessions: { get: () => session },
    agents: { get: () => agent, roots: () => [agent] }, systemPrompt: {},
    on: (name, fn) => { handlers.set(name, fn); return () => handlers.delete(name); } };
  const adapter = createHostAdapter(ctx, { ...config, backupEnabled: true, backupDir: dataDir });
  t.after(() => adapter.close());
  assert.ok(adapter.diagnostics().backup.lastError);
  adapter.onSessionEvent(session, { seq: 1, type: 'turn/start', data: { turn: 1 }, time: Date.now() });
  adapter.onSessionEvent(session, { seq: 2, type: 'user/message', surfaceOp: 'append', time: Date.now(),
    data: { id: 'message', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Primary capture survives an invalid optional backup path.' }] } });
  assert.equal(adapter.store.listRaw().length, 1);
  const assembly = await handlers.get('system-prompt/assemble')({}, { agent, scope: agent }, async () => ({ sections: [] }));
  assert.match(assembly.sections[0].text, /备份设置或最近操作需要检查；主记忆继续写入/);
  await adapter.close();
});

test('C inference stays explicitly uncertain, incoming first-hop B3 injects, and corrections remove disputed context', t => {
  const { store } = fixture(t);
  store.appendRaw({ id: 'statement', pool: 'a', sessionId: 'main', role: 'user', text: '小梅说她喜欢安静的音乐，也愿意和肥鱼聊天。' });
  const source = { rawId: 'statement', quote: '小梅说她喜欢安静的音乐', support: 'context_only' };
  store.assertCore({ requestId: 'mei', id: 'mei', expectedVersion: 0, kind: 'entity', category: 'identity', text: '小梅',
    statementType: 'inference', inference: { reasoning: '对话把小梅作为一个人物提及', uncertainty: '身份尚未独立核验' }, reason: '自主收集节点', sources: [source] });
  store.assertCore({ requestId: 'edge', id: 'edge', expectedVersion: 0, kind: 'relation', category: 'relationship',
    from: 'mei', to: 'self', rel: '聊天朋友', text: '小梅可能把肥鱼当作聊天朋友', statementType: 'inference',
    inference: { reasoning: '她愿意聊天', uncertainty: '称谓是推断，尚未得到确认' }, reason: '自主收集关系', sources: [source] });
  store.setPreference({ requestId: 'music', id: 'music', expectedVersion: 0, action: 'set', subject: 'mei',
    topic: '音乐', stance: 'like', text: '小梅说喜欢安静的音乐', reason: '仅明确自述', sources: [source],
    declaration: { subject: 'mei', rawId: source.rawId, quote: source.quote } });
  const core = data(buildCoreData(store, { maxChars: 8000 }));
  assert.equal(core.items[0].from, 'mei');
  assert.equal(core.items[0].to, 'self');
  assert.equal(core.items[0].statementType, 'inference');
  assert.match(core.items[0].inference.uncertainty, /尚未/);
  assert.deepEqual(data(buildPreferenceData(store, { maxChars: 8000 })).items.map(x => x.subject), ['mei']);
  store.appendRaw({ id: 'correction', pool: 'a', sessionId: 'main', role: 'user', text: '之前那位不是小梅，人物归属需要核查。' });
  store.applyCorrection({ requestId: 'dispute-person', targets: [{ id: 'mei', version: 1 }], status: 'disputed',
    reason: '归属存疑', sources: [{ rawId: 'correction', quote: '之前那位不是小梅' }] });
  assert.equal(data(buildCoreData(store, { maxChars: 8000 })).items.length, 0);
  assert.equal(data(buildPreferenceData(store, { maxChars: 8000 })).items.length, 0);
  assert.equal(store.getEntry('music').status, 'active', 'historical preference is preserved despite injection exclusion');
});

test('default wake fits all policy routes without archive contents or caller-controlled instructions', t => {
  const { store } = fixture(t);
  const wake = buildWake(store);
  assert.ok(wake.length <= 1800);
  for (const route of ['memory_review_request', 'memory_a3_write', 'memory_core_write', 'memory_preference', 'memory_correct',
    'memory_a2_review_queue', 'memory_b2_write']) assert.ok(wake.includes(route), route);
  assert.match(wake, /不额外调用模型或开启会话/);
  assert.doesNotMatch(wake, /提示有省略/);
});

test('documented CLI export, verify and import round-trip preserves identity and rejects an occupied destination', t => {
  const { root, dataDir, store } = fixture(t);
  store.appendRaw({ id: 'original', pool: 'a', sessionId: 'main', role: 'user', text: 'A synthetic portable memory.' });
  store.close();
  const cli = fileURLToPath(new URL('../scripts/cli.js', import.meta.url));
  const run = (args, expected = 0) => {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, expected, result.stderr || result.stdout);
    return expected === 0 ? JSON.parse(result.stdout) : result.stderr;
  };
  const file = join(root, 'manual-export.feiyu-backup'), target = join(root, 'restored');
  run(['export', '--data', dataDir, '--instance', 'synthetic-integration', '--file', file]);
  run(['verify-backup', '--file', file]);
  const restored = run(['import', '--file', file, '--target', target]);
  assert.equal(restored.needsRebuild, true);
  assert.equal(JSON.parse(readFileSync(join(target, 'identity.json'), 'utf8')).instanceId, 'synthetic-integration');
  assert.match(run(['import', '--file', file, '--target', target], 1), /BACKUP_TARGET/);
  const reopened = new MemoryStore({ dataDir: target, instanceId: 'synthetic-integration' });
  try { assert.equal(reopened.getRaw('original').text, 'A synthetic portable memory.'); }
  finally { reopened.close(); }
});
