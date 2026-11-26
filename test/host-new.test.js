import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { BACKUP_API } from '../lib/backup-routes.js';
import plugin, { Config, createHostAdapter, captureId, WAKE_SECTION, CORE_SECTION, PREFERENCE_SECTION, toolSchemas } from '../lib/index.js';

function fixture(t, config = {}, configureHost = () => {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'feiyu-profile-host-'));
  const agents = new Map(), sessions = new Map(), roots = new Set(), handlers = new Map(), tools = new Map();
  const ctx = {
    agents: { get: id => agents.get(id), roots: () => [...roots], create: () => assert.fail('must not create agents') },
    sessions: { get: id => sessions.get(id) }, systemPrompt: {},
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } },
    on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); },
    llm: { stream: () => assert.fail('must not invoke an extra model') },
  };
  let adapter;
  t.after(async () => {
    try { await adapter?.close(); } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });
  configureHost(ctx);
  adapter = createHostAdapter(ctx, { dataDir, instanceId: 'profile-fish', sessionScope: 'profile', participation: 'interactive', ...config });
  let seq = 0;
  const add = (id, header = {}, options = {}, root = true) => {
    const session = { id, header: { id, ...header }, isOwnSeq: () => true };
    const agent = { id, session, options };
    sessions.set(id, session); agents.set(id, agent); if (root) roots.add(agent);
    return agent;
  };
  const emit = (agent, type, data) => adapter.onSessionEvent(agent.session, { seq: ++seq, time: Date.now(), type, data,
    ...(type.endsWith('/message') || type === 'tool/result' ? { surfaceOp: 'append' } : {}) });
  const user = (agent, text, id = 'message') => emit(agent, 'user/message', { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });
  const assembly = (agent, value = { sections: [] }) => handlers.get('system-prompt/assemble')(value, { agent, scope: agent }, async () => value);
  const execute = (agent, name, args = {}) => tools.get(name).execute(args, { agent });
  return { ...adapter, ctx, agents, sessions, roots, handlers, tools, add, emit, user, assembly, execute };
}

test('owner remains the default; profile explicitly allows omitting ownerSessionId', () => {
  const dataDir = join(tmpdir(), 'unused-feiyu-config');
  assert.ok(Config['~standard'].validate({ dataDir, instanceId: 'fish' }).issues);
  const owner = Config['~standard'].validate({ dataDir, instanceId: 'fish', ownerSessionId: 'one' }).value;
  assert.equal(owner.sessionScope, 'owner');
  assert.equal(owner.coreMaxChars, 2400);
  assert.equal(owner.preferenceMaxChars, 1600);
  assert.equal(owner.wakeMaxChars, 1800);
  const profile = Config['~standard'].validate({ dataDir, instanceId: 'fish', sessionScope: 'profile', wakeMaxChars: 280 }).value;
  assert.equal(profile.wakeMaxChars, 280);
  assert.equal(profile.ownerSessionId, undefined);
  for (const extra of [{ sessionScope: 'all' }, { coreMaxChars: 8001 }, { coreMaxChars: 511 }, { preferenceMaxChars: 511 }, { preferenceMaxChars: 8001 }]) {
    assert.ok(Config['~standard'].validate({ ...profile, ...extra }).issues);
  }
});

async function assertProfileDenied(f, agent, messageId = 'denied') {
  const count = f.store.listRaw().length;
  f.emit(agent, 'turn/start', { turn: 2 });
  f.user(agent, '合成拒绝样本', messageId);
  assert.equal(f.store.listRaw().length, count, agent.id);
  assert.equal((await f.assembly(agent)).sections.length, 0, agent.id);
  await assert.rejects(f.execute(agent, 'memory_review_queue'), /owner|root/, agent.id);
}

function withRootOf(ctx) {
  delete ctx.agents.roots;
  ctx.subagents = {
    rootByAgent: new Map(),
    rootOf(agent) { return this.rootByAgent.get(agent); },
  };
}

test('profile rootOf accepts the live root and an ordinary fork across capture, assembly and tools', async t => {
  const f = fixture(t, {}, withRootOf);
  const root = f.add('root'), fork = f.add('fork', { parentSession: root.id, isSeeded: true });
  for (const agent of [root, fork]) {
    f.ctx.subagents.rootByAgent.set(agent, agent);
    f.emit(agent, 'turn/start', { turn: 1 });
    f.user(agent, '合成主会话原文');
    assert.equal(f.store.getRaw(captureId('profile-fish', agent.id, 'message')).text, '合成主会话原文');
    assert.ok((await f.assembly(agent)).sections.some(section => section.name === WAKE_SECTION));
    const { candidates } = await f.execute(agent, 'memory_list', { pool: 'a1', limit: 20 });
    assert.ok(candidates.some(item => item.id === captureId('profile-fish', root.id, 'message')));
  }
  f.ctx.subagents.rootByAgent.delete(root);
  await assertProfileDenied(f, root, 'revoked');
});

test('profile rootOf rejects children, undefined, lookalikes, thrown lookups and stale identities', async t => {
  const f = fixture(t, {}, withRootOf);
  const root = f.add('root'), child = f.add('child'), lookalike = f.add('lookalike');
  const roots = f.ctx.subagents.rootByAgent;
  roots.set(child, root);
  roots.set(lookalike, { ...lookalike });
  const delegated = [f.add('origin', { origin: 'subagent' }), f.add('depth', { delegationDepth: 1 }),
    f.add('runtime-depth', {}, { subagentDepth: 1 })];
  const lostAgent = f.add('lost-agent'), staleSession = f.add('stale-session');
  for (const agent of [...delegated, lostAgent, staleSession, root]) roots.set(agent, agent);
  f.agents.delete(lostAgent.id);
  f.sessions.set(staleSession.id, { ...staleSession.session });
  for (const agent of [child, f.add('unknown'), lookalike, ...delegated, lostAgent, staleSession]) {
    await assertProfileDenied(f, agent);
  }
  f.ctx.subagents.rootOf = () => { throw new Error('synthetic registry failure'); };
  await assertProfileDenied(f, root);
});

test('missing both profile root APIs keeps the backup status route available and denies session access', async t => {
  const routes = new Map();
  const f = fixture(t, {}, ctx => {
    delete ctx.agents.roots;
    ctx.inject = (_services, install) => install({ connection: { fetch: {
      register(route) { routes.set(route.path, route); return () => routes.delete(route.path); },
    } } });
  });
  const path = BACKUP_API + '/status';
  const response = await routes.get(path).fetch(new Request('http://localhost' + path));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.instanceId, 'profile-fish');
  await assertProfileDenied(f, f.add('unverifiable'));
});

test('profile prefers the legacy roots registry and never retries rootOf after denial or exception', async t => {
  let broken = false, calls = 0;
  const f = fixture(t, {}, ctx => {
    const roots = ctx.agents.roots;
    ctx.agents.roots = () => {
      if (broken) throw new Error('synthetic registry failure');
      return roots();
    };
    ctx.subagents = { rootOf(agent) { calls++; return agent; } };
  });
  const root = f.add('legacy-root'), child = f.add('legacy-child', {}, {}, false);
  f.user(root, '合成旧宿主原文');
  assert.equal(f.store.listRaw().length, 1);
  await assertProfileDenied(f, child);
  broken = true;
  await assertProfileDenied(f, root, 'registry-failed');
  f.ctx.agents.roots = () => '[object Object]';
  await assertProfileDenied(f, root, 'malformed-registry');
  assert.equal(calls, 0);
});

test('profile roots share a store with independent turns, cross-session ids and live ownership gates', async t => {
  const f = fixture(t);
  const first = f.add('first'), second = f.add('second');
  f.emit(first, 'turn/start', { turn: 1 }); f.emit(second, 'turn/start', { turn: 1 });
  f.user(first, 'first original');
  f.emit(second, 'assistant/message', { turn: 1, message: { id: 'alone', role: 'assistant', content: [{ type: 'text', text: 'DO_NOT_CAPTURE_ALONE' }] } });
  f.user(second, 'second original');
  assert.equal(f.store.listRaw().length, 2);
  assert.equal(f.store.getRaw(captureId('profile-fish', 'first', 'message')).text, 'first original');
  assert.equal(f.store.getRaw(captureId('profile-fish', 'second', 'message')).text, 'second original');
  assert.ok((await f.execute(second, 'memory_search', { q: 'first original' })).candidates.some(item => item.id === captureId('profile-fish', 'first', 'message')));
  const forged = { ...first };
  await assert.rejects(f.execute(forged, 'memory_list'), /owner|root/);
  assert.equal((await f.assembly(forged)).sections.length, 0);
  f.roots.delete(first);
  f.user(first, 'not a root', 'blocked');
  assert.equal(f.store.listRaw().length, 2);
});

test('runtime children and resumed delegated sessions are excluded; ordinary fork new messages are captured', async t => {
  const f = fixture(t);
  const blocked = [f.add('child-owned', {}, {}, false), f.add('resumed-origin', { origin: 'subagent' }),
    f.add('durable-depth', { delegationDepth: 1 }), f.add('runtime-depth', {}, { subagentDepth: 1 })];
  for (const agent of blocked) {
    f.user(agent, 'delegated text must not enter shared memory');
    assert.equal((await f.assembly(agent)).sections.length, 0);
    await assert.rejects(f.execute(agent, 'memory_review_queue'), /owner|root/);
  }
  const fork = f.add('fork', { parentSession: 'original', isSeeded: true });
  fork.session.isOwnSeq = () => false;
  f.user(fork, 'inherited', 'old');
  fork.session.isOwnSeq = () => true;
  f.user(fork, 'new fork message', 'new');
  assert.deepEqual(f.store.listRaw().map(record => record.text), ['new fork message']);
  f.sessions.set(fork.id, { ...fork.session });
  f.user(fork, 'replaced session object', 'stale');
  assert.equal((await f.assembly(fork)).sections.length, 0);
  assert.equal(f.store.listRaw().length, 1);
});

const installedRoot = process.env.FEIYU_DSH_MODULES_ROOT;
test('opt-in actual DSH: profile roots share data, durable children are rejected, schemas and C DATA assemble', { skip: !installedRoot }, async t => {
  const load = name => import(pathToFileURL(join(installedRoot, name, 'lib/index.js')).href);
  const [{ Context }, { SessionStore }, { AgentRegistry }, { SystemPrompt }, { ToolRuntime, assertObjectJsonSchema }] = await Promise.all([
    load('cordis'), load('dsh-session'), load('dsh-agent'), load('dsh-system-prompt'), load('dsh-tools'),
  ]);
  const ctx = new Context();
  const dataDir = mkdtempSync(join(tmpdir(), 'feiyu-real-profile-host-'));
  const disposers = [];
  t.after(async () => {
    for (const dispose of disposers.reverse()) await dispose();
    await ctx.fiber.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  });
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false });
  await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(ToolRuntime, { mode: 'native' });
  const hostFiber = await ctx.plugin(plugin, { dataDir, instanceId: 'real-profile', sessionScope: 'profile', participation: 'interactive' });
  assert.equal(hostFiber.state, 2);
  disposers.push(() => hostFiber.dispose());
  const add = (id, meta = {}, owner) => {
    const session = ctx.sessions.create(id, { meta });
    const agent = { id, session, ctx, options: {} };
    disposers.push(ctx.agents.enter(agent, owner));
    return agent;
  };
  const one = add('one'), two = add('two'), resumedChild = add('resumed-child', { origin: 'subagent', delegationDepth: 1, parentSession: 'one' });
  const ownedChild = add('owned-child', {}, one);
  assert.ok(ctx.agents.roots().includes(resumedChild), 'durable lineage must be checked separately from runtime roots');
  const append = (agent, text) => {
    agent.session.append('turn/start', { turn: 1 });
    agent.session.append('user/message', { id: 'same-message', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }, { surfaceOp: 'append' });
  };
  append(one, '合成主人是此关系节点的来源'); append(two, '另一个主会话的原文');
  append(resumedChild, '不能采集的恢复子代理'); append(ownedChild, '不能采集的运行子代理');
  let call = 0;
  const execute = async (agent, name, args) => ctx.tools.execute({ callId: `test-${++call}`, name, arguments: args, agent, signal: new AbortController().signal });
  for (const name of Object.keys(toolSchemas)) assertObjectJsonSchema(ctx.tools.get(name, one).parameters);
  const all = await execute(two, 'memory_list', { pool: 'a1', limit: 20 });
  assert.equal(all.isError, false, JSON.stringify(all));
  assert.equal(all.value.candidates.length, 2);
  assert.equal((await execute(resumedChild, 'memory_review_queue', {})).isError, true);
  assert.equal((await ctx.systemPrompt.assemble({ agent: resumedChild, scope: resumedChild })).sections.some(item => item.name === CORE_SECTION), false);
  const written = await execute(two, 'memory_write', { id: 'test-owner-node', statementType: 'fact', kind: 'entity', text: '合成主人节点', hooks: ['主人'],
    sources: [{ rawId: captureId('real-profile', 'one', 'same-message'), quote: '合成主人', support: 'supports' }] });
  assert.equal(written.isError, false, JSON.stringify(written));
  const promoted = await execute(two, 'memory_core', { requestId: 'test-promote', id: written.value.id, expectedVersion: written.value.version,
    action: 'promote', reason: '合成测试明确支持此身份节点', category: 'identity' });
  assert.equal(promoted.isError, false, JSON.stringify(promoted));
  const ownPreference = await execute(two, 'memory_preference', { requestId: 'test-own-preference', id: 'test-preference', expectedVersion: 0,
    action: 'set', topic: '合成测试音乐', stance: 'like', text: '肥鱼这轮自述喜欢合成音乐', reason: '仅测试自己的表达', sources: [] });
  assert.equal(ownPreference.isError, false, JSON.stringify(ownPreference));
  for (const agent of [one, two]) {
    const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent });
    assert.equal(assembly.sections.filter(item => item.name === WAKE_SECTION).length, 1);
    const core = assembly.sections.filter(item => item.name === CORE_SECTION);
    assert.equal(core.length, 1);
    assert.match(core[0].text, /"total":1/);
    assert.equal((await execute(agent, 'memory_read', { id: written.value.id })).value.text, '合成主人节点');
    assert.doesNotMatch(assembly.sections.find(item => item.name === WAKE_SECTION).text, /合成主人节点/);
    const preferences = assembly.sections.filter(item => item.name === PREFERENCE_SECTION);
    assert.equal(preferences.length, 1);
    assert.match(preferences[0].text, /肥鱼这轮自述喜欢合成音乐/);
    assert.match(preferences[0].text, /self_report/);
  }
});

test('every new session assembly includes separate bounded core DATA and fixed routes without starting review', async t => {
  const f = fixture(t);
  const first = f.add('first'), newlyOpened = f.add('new');
  const dueTime = new Date(Date.now() - 8 * 86400000).toISOString();
  f.store.appendRaw({ id: 'due-original', pool: 'a', sessionId: first.id, role: 'user', text: 'due text is not a procedural instruction', recordedAt: dueTime });
  const before = f.store.listReviewQueue({ limit: 1 });
  const assembly = await f.assembly(newlyOpened);
  await f.assembly(newlyOpened, assembly);
  assert.deepEqual(assembly.sections.map(item => item.name), [WAKE_SECTION, CORE_SECTION, PREFERENCE_SECTION]);
  assert.ok(assembly.sections.every(item => item.interpolate === false));
  const wake = assembly.sections[0].text;
  assert.ok(wake.length <= 1800);
  assert.match(wake, /memory_review/);
  assert.match(wake, /A1/);
  assert.doesNotMatch(wake, /最近两天 A1/);
  assert.match(wake, /C仅关系网/);
  assert.doesNotMatch(wake, /due-original|due text/);
  assert.ok(assembly.sections[1].text.length <= 2400);
  assert.equal(f.store.listReviewQueue({ limit: 1 }).total, before.total);
});

test('legacy and compact entry schemas expose bounded review, graph and pools; own outputs stay derivative', async t => {
  const f = fixture(t), agent = f.add('root');
  assert.equal(f.tools.size, 24); // +memory_episode (hippocampus)
  assert.deepEqual(toolSchemas.memory_read.properties.kind.enum, ['raw', 'memory', 'doing', 'entity', 'relation', 'preference', 'a3', 'b2', 'knowledge']);
  assert.deepEqual(toolSchemas.memory_core.properties.category.enum, ['identity', 'relationship']);
  const queue = await f.execute(agent, 'memory_review_queue', {});
  assert.equal(queue.total, 0);
  const history = await f.execute(agent, 'memory_review', { action: 'history', limit: 1 });
  assert.equal(history.total, 0);
  await assert.rejects(f.execute(agent, 'memory_write', { statementType: 'fact', kind: 'entity', pool: 'c', text: 'bad', hooks: [], sources: [] }), /invalid/);
  f.emit(agent, 'turn/start', { turn: 1 }); f.user(agent, 'real human input');
  for (const name of Object.keys(toolSchemas)) {
    f.emit(agent, 'tool/call', { turn: 1, callId: name, name });
    const result = f.emit(agent, 'tool/result', { turn: 1, message: { id: `result-${name}`, role: 'tool', toolCallId: name, content: [{ type: 'text', text: 'derived contents' }] } });
    assert.equal(result.skipped, 'derived_memory_or_transport');
  }
  assert.equal(f.store.listRaw().length, 1);
});

test('B3 preferences appear across roots as self-report DATA, update with CAS and disappear after revoke', async t => {
  const f = fixture(t), first = f.add('first'), second = f.add('second');
  const saved = await f.execute(first, 'memory_preference', { requestId: 'preference-first', id: 'own-preference', expectedVersion: 0,
    action: 'set', topic: '合成音乐偏好', stance: 'like', text: '我现在喜欢合成测试音乐', reason: '本轮自己的表达', sources: [] });
  assert.equal(saved.committed, true);
  const assembly = await f.assembly(second);
  await f.assembly(second, assembly);
  assert.equal(assembly.sections.filter(item => item.name === PREFERENCE_SECTION).length, 1);
  const data = assembly.sections.find(item => item.name === PREFERENCE_SECTION).text;
  assert.match(data, /我现在喜欢合成测试音乐/);
  assert.match(data, /非客观事实/);
  assert.doesNotMatch(assembly.sections.find(item => item.name === WAKE_SECTION).text, /我现在喜欢合成测试音乐/);
  assert.ok(data.length <= 1600);
  const read = await f.execute(second, 'memory_read', { id: 'own-preference', kind: 'preference', pool: 'b3' });
  assert.equal(read.subject, 'self');
  await assert.rejects(f.execute(second, 'memory_write', { statementType: 'fact', kind: 'preference', text: 'bypass', hooks: [], sources: [] }), /invalid/);
  await assert.rejects(f.execute(second, 'memory_preference', { requestId: 'forged-subject', id: 'another', expectedVersion: 0,
    action: 'set', topic: '用户', stance: 'like', text: '用户喜欢', reason: '不得指定他人', subject: 'user' }), /第一|declaration|主体|直接|subject/);
  await f.execute(second, 'memory_preference', { requestId: 'preference-revoke', id: 'own-preference', expectedVersion: 1, action: 'revoke', reason: '已改变想法' });
  assert.doesNotMatch((await f.assembly(first)).sections.find(item => item.name === PREFERENCE_SECTION).text, /我现在喜欢合成测试音乐/);
  assert.equal((await f.execute(first, 'memory_read', { id: 'own-preference', version: 1 })).text, '我现在喜欢合成测试音乐');
});
