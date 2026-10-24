import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MemoryStore } from '../lib/store.js';
import { createTools } from '../lib/tools.js';
import plugin, { WAKE_SECTION } from '../lib/index.js';

function temporary() { return mkdtempSync(join(tmpdir(), 'feiyu-v061-tools-')); }
function removeTemporary(dataDir) {
  assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()));
  rmSync(dataDir, { recursive: true, force: true });
}
function fixture(t) {
  const dataDir = temporary(t), store = new MemoryStore({ dataDir, instanceId: 'v061-tools' });
  t.after(() => { store.close(); removeTemporary(dataDir); }); return { dataDir, store, api: createTools(store) };
}
function seedLinked(store) {
  store.appendRaw({ id: 'source', pool: 'a', role: 'user', sessionId: 's', turnId: 't', text: '一句短原文。' });
  store.writeEntry({ id: 'linked', kind: 'memory', text: '一句短原文。', statementType: 'self_report', sources: [{ rawId: 'source', quote: '一句短原文。', support: 'supports' }] });
  for (let i = 0; i < 5; i++) store.linkThread({ requestId: `link-${i}`, threadId: `topic-${i}-${'x'.repeat(80)}`, title: `Topic ${i}`, entries: [{ id: 'linked', version: 1 }], reason: '合成事项关联' });
}

test('fetch 900 keeps short text and evidence nature while deferring optional thread metadata explicitly', t => {
  const { store, api } = fixture(t); seedLinked(store);
  const result = api.memory_fetch({ ids: [{ id: 'linked' }], budget: 900 });
  assert.ok(JSON.stringify(result).length <= 900);
  assert.equal(result.items.length, 1); assert.equal(result.hasMore, false);
  const item = result.items[0];
  assert.equal(item.text, '一句短原文。'); assert.equal(item.statementType, 'self_report');
  assert.equal(item.evidenceStatus, 'quote_verified'); assert.equal(item.currentValidity, 'unknown');
  assert.equal(item.metadataOmitted, true); assert.ok(item.omittedFields.includes('threadIds'));
  assert.equal(item.threadIds, undefined);
});

test('fetch required attribution over budget gives an exact actionable minimum and resumes the same cursor', t => {
  const { store, api } = fixture(t);
  const id = 'r'.repeat(200), sessionId = 's'.repeat(200), turnId = 't'.repeat(200);
  store.appendRaw({ id, pool: 'a', role: 'user', sessionId, turnId, text: '🙂必须保留归属和时间。'.repeat(20) });
  const first = api.memory_fetch({ ids: [{ id }], budget: 800 });
  assert.equal(first.items.length, 0); assert.equal(first.blocked, 'required_metadata_exceeds_budget');
  assert.ok(first.minimumBudget > 800 && first.minimumBudget <= 48000);
  assert.ok(JSON.stringify(first).length <= 800);
  assert.deepEqual(first.retry, { cursor: first.cursor, budget: first.minimumBudget });
  const next = api.memory_fetch(first.retry);
  assert.ok(JSON.stringify(next).length <= first.minimumBudget);
  assert.equal(next.items.length, 1); assert.ok(next.items[0].text.length > 0);
  assert.equal(next.items[0].id, id); assert.equal(next.items[0].sessionId, sessionId); assert.equal(next.items[0].turnId, turnId);
  assert.equal(next.items[0].role, 'user'); assert.ok(next.items[0].recordedAt);
});

test('fetch small-budget Unicode pages preserve scrubbed originals and do not add an empty continuation', t => {
  const { store, api } = fixture(t), secret = 'sk-' + 'syntheticsecret'.repeat(3);
  store.appendRaw({ id: 'prior-raw', pool: 'a', role: 'user', sessionId: 's', text: '已有一条合成记录。' });
  store.writeEntry({ id: 'prior', kind: 'memory', text: '已有一条合成记录。', statementType: 'self_report', sources: [{ rawId: 'prior-raw', quote: '已有一条合成记录。' }] });
  store.appendRaw({ id: 'r', pool: 'a', role: 'assistant', sessionId: 's', turnId: 't',
    text: `api_key=${secret}。` + '🙂条件尚未验证，不能当成已成功。'.repeat(70), derivedFromMemory: [{ id: 'prior', version: 1 }] });
  const expected = store.getRaw('r').text; let result = api.memory_fetch({ ids: [{ id: 'r' }], budget: 900 });
  let received = '', calls = 0;
  while (true) {
    assert.ok(JSON.stringify(result).length <= result.budget); assert.equal(JSON.stringify(result).includes(secret), false);
    for (const item of result.items) {
      assert.equal(item.redaction.applied, true); assert.equal(item.nonIndependentEvidence, true);
      assert.ok(item.text.length); assert.equal(/[\uD800-\uDBFF]$/u.test(item.text), false); received += item.text;
    }
    if (!result.hasMore) break;
    assert.ok(++calls < 100); result = api.memory_fetch(result.retry ?? { cursor: result.cursor, budget: 900 });
  }
  assert.equal(received, expected);
  store.appendRaw({ id: 'a'.repeat(64), pool: 'a', role: 'user', sessionId: 'session-12345678-1234-1234-1234-123456789012', turnId: '123', text: '普通捕获格式的原文。' });
  const small = api.memory_fetch({ ids: [{ id: 'a'.repeat(64) }], budget: 800 });
  assert.equal(small.items[0].text, '普通捕获格式的原文。'); assert.equal(small.hasMore, false); assert.equal(small.cursor, null);
  const boundaryText = '汉'.repeat(15999) + '🙂';
  store.appendRaw({ id: 'unicode-boundary', pool: 'a', role: 'user', sessionId: 's', turnId: 't', text: boundaryText });
  const boundaryFirst = api.memory_fetch({ ids: [{ id: 'unicode-boundary' }], budget: 48000 });
  assert.equal(boundaryFirst.items[0].text.length, 15999); assert.equal(boundaryFirst.items[0].hasMore, true);
  const boundaryNext = api.memory_fetch({ cursor: boundaryFirst.cursor, budget: 800 });
  assert.equal(boundaryNext.items[0].text, '🙂'); assert.equal(boundaryNext.hasMore, false);
});

test('field selection cannot strip dependency risk or turn a disputed fact into an unqualified valid declaration', t => {
  const { store, api } = fixture(t); seedLinked(store);
  store.appendRaw({ id: 'correction', pool: 'a', role: 'user', sessionId: 's', text: '前面的说法仍需核实。' });
  store.applyCorrection({ requestId: 'dispute', targets: [{ id: 'linked', version: 1 }], status: 'disputed', reason: '合成复核', sources: [{ rawId: 'correction', quote: '前面的说法仍需核实。' }] });
  const result = api.memory_fetch({ ids: [{ id: 'linked' }], fields: ['text'], budget: 900 });
  assert.equal(result.items[0].correctnessStatus, 'disputed'); assert.equal(result.items[0].statementType, 'self_report');
  assert.ok(JSON.stringify(result).length <= 900);
});

test('displayName flows through core/write/review schemas into reads, search and entity preparation', t => {
  const { store, api } = fixture(t);
  const core = api.memory_core_write({ requestId: 'display-core', id: 'person', expectedVersion: 0, kind: 'entity', category: 'identity',
    displayName: '合成姐姐', text: '较长的人物说明，不应该被用作整个人名。', statementType: 'inference',
    inference: { reasoning: '合成测试角色', uncertainty: '尚未核实' }, reason: '建立合成人物' });
  assert.equal(core.entry?.displayName ?? store.getEntry('person').displayName, '合成姐姐');
  assert.equal(api.memory_read({ id: 'person', view: 'body' }).displayName, '合成姐姐');
  assert.equal(api.memory_search({ q: '合成姐姐', pool: 'c' }).candidates[0].displayName, '合成姐姐');
  assert.equal(api.memory_prepare({ entity: '合成姐姐' }).entities[0].name, '合成姐姐');
  store.appendRaw({ id: 'person-raw', pool: 'a', role: 'user', sessionId: 's', text: '这个人叫合成小甲。', recordedAt: '2000-01-01T00:00:00Z' });
  api.memory_write({ id: 'a2-person', kind: 'entity', displayName: '合成小甲', text: '这个人叫合成小甲。', statementType: 'self_report', sources: [{ rawId: 'person-raw', quote: '这个人叫合成小甲。' }] });
  assert.equal(api.memory_read({ id: 'a2-person', fields: ['displayName'] }).displayName, '合成小甲');
});

const installedRoot = process.env.FEIYU_DSH_MODULES_ROOT;
test('opt-in actual host: compact discovery, budgeted body, structured quote repair and raw-thread dispatch reach rendered model JSON', { skip: !installedRoot }, async t => {
  const dataDir = temporary(t), seed = new MemoryStore({ dataDir, instanceId: 'v061-runtime' });
  seedLinked(seed);
  const original = '开头。\n我安装了 `ComfyUI`，还没确认可用。';
  seed.appendRaw({ id: 'quote-source', pool: 'a', role: 'user', sessionId: 's', turnId: 't', text: original }); seed.close();
  const load = name => import(pathToFileURL(join(installedRoot, name, 'lib/index.js')).href);
  const [{ Context }, { SessionStore }, { AgentRegistry }, { SystemPrompt }, { ToolRuntime }] = await Promise.all([load('cordis'), load('dsh-session'), load('dsh-agent'), load('dsh-system-prompt'), load('dsh-tools')]);
  const ctx = new Context(); let fiber, detach;
  t.after(async () => { await fiber?.dispose(); detach?.(); await ctx.fiber.dispose(); removeTemporary(dataDir); });
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false }); await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(ToolRuntime, { mode: 'native' });
  fiber = await ctx.plugin(plugin, { dataDir, instanceId: 'v061-runtime', sessionScope: 'profile', participation: 'interactive', toolMode: 'compact', wakeMaxChars: 160 });
  assert.equal(fiber.state, 2); assert.ok(ctx.tools instanceof ToolRuntime);
  const session = ctx.sessions.create('main'), agent = { id: 'main', session, ctx, options: {} }; detach = ctx.agents.enter(agent, undefined);
  let call = 0;
  const execute = async (name, args = {}) => {
    const result = await ctx.tools.execute({ callId: `v061-${++call}`, name, arguments: args, agent, signal: new AbortController().signal });
    assert.equal(result.isError, false, JSON.stringify(result));
    return JSON.parse(result.content.filter(item => item.type === 'text').map(item => item.text).join('\n'));
  };
  const catalog = await execute('memory_tools');
  assert.equal(catalog.total, 24); assert.equal(catalog.businessTools, 23); assert.equal(catalog.enabledCount, 6);
  assert.equal(catalog.available.find(item => item.name === 'memory_dict').enabled, false);
  assert.deepEqual(catalog.enableExample, { tool: 'memory_tools', arguments: { names: ['memory_dict'] } });
  await execute('memory_tools', { names: ['memory_dict', 'memory_write', 'memory_preference'] });
  assert.equal((await execute('memory_dict')).moduleVersion, '0.6.1');
  const fetched = await execute('memory_fetch', { ids: [{ id: 'linked' }], budget: 900 });
  assert.equal(fetched.items[0].text, '一句短原文。'); assert.ok(JSON.stringify(fetched).length <= 900);
  const badQuote = '我安装了 ComfyUI，还没确认可用。';
  const failures = [await execute('memory_write', { id: 'bad-a2', kind: 'memory', text: badQuote, statementType: 'self_report', hooks: [], sources: [{ rawId: 'quote-source', quote: badQuote }] }),
    await execute('memory_preference', { requestId: 'bad-b3', id: 'bad-b3', expectedVersion: 0, action: 'set', topic: '测试', stance: 'like', text: '测试喜好', reason: '测试定位', sources: [{ rawId: 'quote-source', quote: badQuote }] })];
  for (const failure of failures) {
    assert.equal(failure.committed, false); assert.equal(failure.error.code, 'QUOTE_MISMATCH'); assert.equal(failure.error.offsetUnit, 'utf16');
    assert.match(failure.error.message, /本次未写入/u);
    const candidate = failure.error.candidates.find(item => item.text.includes('`ComfyUI`'));
    assert.ok(candidate); assert.equal(original.slice(candidate.offset, candidate.offset + candidate.length), candidate.text);
  }
  await execute('memory_manage', { action: 'link_thread', requestId: 'raw-link', reason: '合成原文关联', thread: { threadId: 'raw-topic', title: '原文事项', rawIds: ['quote-source'] } });
  const thread = await execute('memory_manage', { action: 'read_thread', thread: { threadId: 'raw-topic', include: 'raw', budget: 2000 } });
  assert.ok(thread.items.some(item => item.recordType === 'raw' && item.rawId === 'quote-source'));
  await execute('memory_manage', { action: 'unlink_thread', requestId: 'raw-unlink', reason: '撤回合成关联', thread: { threadId: 'raw-topic', linkRequestId: 'raw-link' } });
  assert.equal((await execute('memory_manage', { action: 'read_thread', thread: { threadId: 'raw-topic', include: 'raw' } })).items.length, 0);
  const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent });
  assert.match(assembly.sections.find(item => item.name === WAKE_SECTION).text, /memory_tools\(\{names:/u);
  assert.equal(ctx.tools.schemas(agent).filter(item => item.name.startsWith('memory_')).length, 9);
  await fiber.dispose(); fiber = null;
  assert.equal(ctx.tools.schemas(agent).filter(item => item.name.startsWith('memory_')).length, 0);
});

const previousPackageRoot = process.env.FEIYU_PREVIOUS_PACKAGE_ROOT;
test('opt-in previous release: actual 0.6.0 library upgrades with immutable v6 bytes and a response-only interface supplement', { skip: !previousPackageRoot }, async t => {
  const dataDir = temporary(); let current;
  t.after(() => { current?.close(); removeTemporary(dataDir); });
  const { MemoryStore: PreviousStore } = await import(pathToFileURL(join(previousPackageRoot, 'lib/store.js')).href);
  assert.equal(JSON.parse(readFileSync(join(previousPackageRoot, 'package.json'), 'utf8')).version, '0.6.0');
  const prior = new PreviousStore({ dataDir, instanceId: 'previous-release-fixture' });
  try { prior.appendRaw({ id: 'old-source', pool: 'a', role: 'user', sessionId: 'old-session', text: '正式旧版本产生的合成原文。' }); }
  finally { prior.close(); }
  const dictionaryPath = join(dataDir, 'dict/v6.md'), original = readFileSync(dictionaryPath);
  current = new MemoryStore({ dataDir, instanceId: 'previous-release-fixture' });
  const output = createTools(current).memory_dict();
  assert.equal(output.version, 'v6'); assert.equal(output.moduleVersion, '0.6.1'); assert.equal(output.supplementVersion, '0.6.1');
  assert.ok(output.text.startsWith(original.toString('utf8'))); assert.match(output.text, /0\.6\.1接口补充/u);
  assert.match(output.text, /rawIds/u); assert.match(output.text, /minimumBudget/u); assert.match(output.text, /memory_tools/u);
  assert.deepEqual(readFileSync(dictionaryPath), original);
  assert.equal(current.getRaw('old-source').text, '正式旧版本产生的合成原文。');
});
