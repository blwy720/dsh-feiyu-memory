import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import plugin, { Config, createHostAdapter, captureId, RECENT_TURN_SECTION, CORE_SECTION, PREFERENCE_SECTION, WAKE_SECTION } from '../lib/index.js';

function fixture(t, overrides = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'feiyu-recent-host-'));
  const agents = new Map(), sessions = new Map(), roots = new Set(), handlers = new Map(), definitions = new Map(), reads = [];
  const ctx = {
    agents: { get: id => agents.get(id), roots: () => [...roots], create: () => assert.fail('no agent creation') },
    sessions: { get: id => sessions.get(id) }, systemPrompt: {},
    tools: { register(def) { definitions.set(def.name, def); return () => definitions.delete(def.name); } },
    on(name, fn) { handlers.set(name, fn); return () => { if (handlers.get(name) === fn) handlers.delete(name); }; },
    sessionQuery: { async readSession(id) {
      reads.push(id); const session = sessions.get(id);
      if (!session) throw new Error('synthetic session absent');
      return { session: session.header, inheritedEventCount: session.inheritedEventCount, events: session.events };
    } },
    llm: { stream: () => assert.fail('no model invocation') },
  };
  const config = { dataDir, instanceId: 'recent-fish', sessionScope: 'profile', participation: 'interactive', ...overrides };
  let adapter = createHostAdapter(ctx, config), now = Date.now() - 100000;
  t.after(() => { adapter.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const add = (id, { events = [], inherited = 0, header = {}, root = true } = {}) => {
    const session = { id, header: { id, ...header }, events: [...events], inheritedEventCount: inherited,
      get seq() { return this.events.length; }, eventAt(seq) { return this.events[seq]; },
      isOwnSeq(seq) { return seq >= this.inheritedEventCount && seq < this.seq; } };
    const agent = { id, session, options: {} };
    sessions.set(id, session); agents.set(id, agent); if (root) roots.add(agent);
    return agent;
  };
  const emit = (agent, type, data, { deliver = true, time } = {}) => {
    const event = { seq: agent.session.seq, time: time ?? ++now, type, data,
      ...(type.endsWith('/message') || type === 'tool/result' ? { surfaceOp: 'append' } : {}) };
    agent.session.events.push(event);
    if (deliver) adapter.onSessionEvent(agent.session, event);
    return event;
  };
  const start = (agent, turn = 1) => emit(agent, 'turn/start', { turn });
  const claim = (agent, turn = 1, source = { kind: 'user' }) => handlers.get('agent/inbox/claimed')({ agent, turn,
    message: { id: `claimed-${turn}`, role: 'user', source, content: [] } });
  const user = (agent, text, id = 'user', extra = []) => emit(agent, 'user/message', { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }, ...extra] });
  const answer = (agent, text, { id = 'assistant', turn = 1, interrupted = false, extra = [] } = {}) => emit(agent, 'assistant/message',
    { turn, interrupted, message: { id, role: 'assistant', content: [{ type: 'text', text }, ...extra] } });
  const end = (agent, turn = 1, reason = 'completed', options = {}) => emit(agent, 'turn/end', { turn, reason: { kind: reason } }, options);
  const round = (agent, { turn = 1, prefix = agent.id, endOptions, reason = 'completed' } = {}) => {
    start(agent, turn); user(agent, `${prefix}真人原文`, `${turn}-user`); answer(agent, `${prefix}肥鱼原文`, { turn, id: `${turn}-assistant` }); end(agent, turn, reason, endOptions);
  };
  const assemble = (agent, assembly = { sections: [] }) => handlers.get('system-prompt/assemble')(assembly, { agent, scope: agent }, async () => assembly);
  const recent = assembly => assembly.sections.find(section => section.name === RECENT_TURN_SECTION);
  return { ctx, config, agents, sessions, roots, handlers, definitions, reads, add, emit, start, claim, user, answer, end, round, assemble, recent,
    get store() { return adapter.store; }, get adapter() { return adapter; }, restart() { adapter.close(); adapter = createHostAdapter(ctx, config); } };
}

test('current human claim recalls a topic before the input is committed, without capturing the prompt', async t => {
  const f = fixture(t), target = f.add('claim-recall');
  f.store.appendRaw({ id: 'comfy-source', pool: 'a', sessionId: 'yesterday', role: 'user', text: 'ComfyUI 启动前需要进入虚拟环境。' });
  f.start(target);
  f.handlers.get('agent/inbox/claimed')({ agent: target, turn: 1, message: { id: 'current', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'ComfyUI 怎么启动' }] } });
  const assembly = await f.assemble(target);
  assert.match(assembly.sections.find(section => section.name === 'feiyu-memory:related-data').text, /comfy-source/);
  assert.equal(f.store.listRaw().length, 1);
  f.user(target, 'ComfyUI 怎么启动', 'current');
  await f.assemble(target, assembly);
  assert.equal(assembly.sections.filter(section => section.name === 'feiyu-memory:related-data').length, 1);
  assert.ok(!JSON.parse(assembly.sections.find(section => section.name === 'feiyu-memory:related-data').text).items.some(item => item.sessionId === target.id));
});

test('compact host exposes six tools then enables exact legacy capabilities without executing them', async t => {
  const f = fixture(t, { toolMode: 'compact' }), agent = f.add('compact');
  assert.equal(f.definitions.size, 6);
  assert.ok(!f.definitions.has('memory_core_write'));
  const discovery = f.definitions.get('memory_tools');
  const result = await discovery.execute({ names: ['memory_core_write', 'memory_read'] }, { agent });
  assert.deepEqual(result.added, ['memory_core_write', 'memory_read']);
  assert.equal(f.definitions.size, 8);
  assert.equal(f.store.listEntries().length, 0);
  await assert.rejects(discovery.execute({ names: ['run_code'] }, { agent }), /白名单/);
  assert.match((await f.assemble(agent)).sections.find(section => section.name === WAKE_SECTION).text, /memory_tools/);
});

test('first human claim before committed user message selects one durable latest A1 round; later turns remove DATA', async t => {
  const f = fixture(t), source = f.add('source'), target = f.add('target');
  f.round(source); f.start(target); f.claim(target);
  const first = await f.assemble(target);
  assert.match(f.recent(first).text, /source真人原文/);
  assert.match(f.recent(first).text, /source肥鱼原文/);
  assert.equal(f.recent(first).interpolate, false);
  assert.equal(f.store.listRaw().length, 2, 'injection is not captured as a new original');
  f.user(target, '本轮输入'); f.answer(target, '本轮回复');
  const other = f.add('newer'); f.round(other);
  await f.assemble(target, first);
  assert.equal(first.sections.filter(section => section.name === RECENT_TURN_SECTION).length, 1);
  assert.doesNotMatch(f.recent(first).text, /newer真人原文/);
  f.end(target); f.start(target, 2); f.claim(target, 2);
  await f.assemble(target, first);
  assert.equal(f.recent(first), undefined);
  assert.ok(first.sections.some(section => section.name === CORE_SECTION));
  assert.ok(first.sections.some(section => section.name === PREFERENCE_SECTION));
});

test('host forwards configured timezone to recent-turn display without changing captured originals', async t => {
  const f = fixture(t, { timezone: 'Asia/Kathmandu' }), source = f.add('source'), target = f.add('target');
  f.round(source); f.start(target); f.claim(target);
  const before = f.store.listRaw();
  const text = f.recent(await f.assemble(target)).text;
  const payload = JSON.parse(text.slice(text.indexOf('\n') + 1));
  assert.equal(payload.timeZone, 'Asia/Kathmandu');
  assert.match(payload.source.completedAt, /\+05:45$/);
  assert.equal(Date.parse(payload.source.completedAt), source.session.events.at(-1).time);
  assert.deepEqual(f.store.listRaw(), before);
});

test('solitude and injected input types never claim a selection or read their content', async t => {
  const f = fixture(t), source = f.add('source'); f.round(source);
  const target = f.add('target'); f.start(target);
  f.claim(target, 1, { kind: 'subagent' });
  assert.equal(f.recent(await f.assemble(target)), undefined);
  assert.equal(f.store.readPreinject({ targetSessionId: target.id, turnId: '1' }), null);
  f.end(target); f.start(target, 2); f.claim(target, 2);
  assert.equal(f.recent(await f.assemble(target)), undefined, 'first interactive turn is not the same as first own turn');
});

test('restart retains first-turn selection and restored old sessions cannot become new', async t => {
  const f = fixture(t), source = f.add('source'), target = f.add('target'); f.round(source);
  f.start(target); f.claim(target); const before = f.recent(await f.assemble(target)).text;
  f.user(target, '当前真人');
  f.restart();
  assert.equal(f.recent(await f.assemble(target)).text, before);
  f.answer(target, '当前回复'); f.end(target); f.start(target, 2); f.claim(target, 2);
  f.restart();
  assert.equal(f.recent(await f.assemble(target)), undefined);
  const stale = f.add('stale', { events: [...source.session.events] });
  f.start(stale, 2); f.claim(stale, 2);
  assert.equal(f.recent(await f.assemble(stale)), undefined);
});

test('ordinary fork uses first OWN turn; inherited and durable delegated histories are excluded', async t => {
  const f = fixture(t), source = f.add('source'); f.round(source);
  const fork = f.add('fork', { events: source.session.events, inherited: source.session.seq, header: { parentSession: source.id, isSeeded: true } });
  f.start(fork, 2); f.claim(fork, 2);
  assert.match(f.recent(await f.assemble(fork)).text, /source真人原文/);
  const child = f.add('child', { header: { origin: 'subagent', delegationDepth: 1 } });
  f.start(child); f.claim(child);
  assert.equal(f.recent(await f.assemble(child)), undefined);
});

test('bounded legacy verification covers all candidates and chooses by completion time, reading each session once', async t => {
  const f = fixture(t), slow = f.add('slow'), fast = f.add('fast');
  f.start(slow); f.user(slow, '慢轮真人'); f.answer(slow, '慢轮肥鱼');
  f.round(fast, { endOptions: { deliver: false } });
  f.end(slow, 1, 'completed', { deliver: false });
  const target = f.add('target'); f.start(target); f.claim(target);
  assert.match(f.recent(await f.assemble(target)).text, /慢轮真人/);
  assert.deepEqual(new Set(f.reads), new Set(['slow', 'fast']));
  assert.equal(f.reads.length, 2);
  assert.equal(f.store.readPreinject({ targetSessionId: 'target', turnId: '1' }).source.sessionId, 'slow');
});

test('legacy missing captured parts fail closed without backfilling raw content; interrupted rounds cannot win', async t => {
  const f = fixture(t), good = f.add('good'); f.round(good);
  const broken = f.add('broken'); f.round(broken, { endOptions: { deliver: false } });
  broken.session.events.find(event => event.type === 'user/message').data.content.push({ type: 'text', text: 'uncaptured secret' });
  const failed = f.add('failed'); f.round(failed, { reason: 'error' });
  const truncated = f.add('truncated'); f.start(truncated); f.user(truncated, '中断前真人'); f.answer(truncated, '中断助手', { interrupted: true }); f.end(truncated);
  const before = f.store.listRaw().length;
  const target = f.add('target'); f.start(target); f.claim(target);
  const text = f.recent(await f.assemble(target)).text;
  assert.match(text, /good真人原文/); assert.doesNotMatch(text, /uncaptured secret|中断助手|failed真人原文/);
  assert.equal(f.store.listRaw().length, before);
});

test('latest textual round with attachments is retained and explicitly marked incomplete for non-text', async t => {
  const f = fixture(t), source = f.add('source');
  f.start(source); f.user(source, '真人文字配图片', 'u', [{ type: 'image', url: 'synthetic-image' }]);
  f.answer(source, '肥鱼文字', { extra: [{ type: 'reasoning', text: 'not conversation' }, { type: 'tool-call', id: 'call' }] }); f.end(source);
  const target = f.add('target'); f.start(target); f.claim(target);
  const text = f.recent(await f.assemble(target)).text;
  assert.match(text, /真人文字配图片/); assert.doesNotMatch(text, /not conversation|synthetic-image/);
  assert.equal(f.store.readPreinject({ targetSessionId: 'target', turnId: '1' }).source.omittedNonText, true);
});

test('concurrent first assemblies share verification and existing receipt needs no optional history API', async t => {
  const f = fixture(t), old = f.add('old'); f.round(old, { endOptions: { deliver: false } });
  const target = f.add('target'); f.start(target); f.claim(target);
  const assemblies = await Promise.all([f.assemble(target), f.assemble(target)]);
  assert.equal(f.reads.length, 1); assert.equal(f.recent(assemblies[0]).text, f.recent(assemblies[1]).text);
  const shared = { sections: [] };
  await Promise.all([f.assemble(target, shared), f.assemble(target, shared)]);
  assert.equal(shared.sections.filter(section => section.name === RECENT_TURN_SECTION).length, 1);
  const blank = f.add('blank'); f.start(blank); f.claim(blank);
  // The already indexed source remains eligible even when cold access vanishes.
  delete f.ctx.sessionQuery;
  assert.ok(f.recent(await f.assemble(blank)));
});

test('missing or failed optional legacy API never breaks normal prompt assembly', async t => {
  const f = fixture(t), old = f.add('old'); f.round(old, { endOptions: { deliver: false } });
  delete f.ctx.sessionQuery;
  const first = f.add('first'); f.start(first); f.claim(first);
  const one = await f.assemble(first);
  assert.equal(f.recent(one), undefined);
  assert.ok(one.sections.some(section => section.name === CORE_SECTION));
  assert.equal(f.adapter.diagnostics().legacyPreinjectUnavailable, true);
  f.ctx.sessionQuery = { async readSession() { throw new Error('synthetic corrupt persistence'); } };
  const second = f.add('second'); f.start(second); f.claim(second);
  const two = await f.assemble(second);
  assert.equal(f.recent(two), undefined);
  assert.ok(f.adapter.diagnostics().recentTurnFailures > 0);
  assert.equal(f.store.listRaw().length, 2);
});

test('hung legacy history is time bounded and a late result cannot change frozen none or write a receipt', async t => {
  const f = fixture(t), old = f.add('old'); f.round(old, { endOptions: { deliver: false } });
  let resolveHistory, readCount = 0, recorded = 0;
  f.ctx.sessionQuery.readSession = () => { readCount++; return new Promise(resolve => { resolveHistory = resolve; }); };
  const original = f.store.recordCompletedRound.bind(f.store);
  f.store.recordCompletedRound = value => { recorded++; return original(value); };
  const target = f.add('target'); f.start(target); f.claim(target);
  const started = Date.now();
  const assembly = await f.assemble(target);
  assert.ok(Date.now() - started < 4500, 'two second read budget must release prompt assembly');
  assert.equal(f.recent(assembly), undefined);
  assert.equal(f.adapter.diagnostics().legacyPreinjectTimeouts, 1);
  assert.equal(f.store.readPreinject({ targetSessionId: target.id, turnId: '1' }).status, 'none');
  resolveHistory({ session: old.session.header, inheritedEventCount: 0, events: old.session.events });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(recorded, 0); assert.equal(readCount, 1);
  assert.equal(f.recent(await f.assemble(target)), undefined);
});

test('turn cancellation and close release pending legacy reads without writing selection or late rejection', async t => {
  const f = fixture(t), old = f.add('old'); f.round(old, { endOptions: { deliver: false } });
  let rejectHistory, entered;
  const began = new Promise(resolve => { entered = resolve; });
  f.ctx.sessionQuery.readSession = () => { entered(); return new Promise((_resolve, reject) => { rejectHistory = reject; }); };
  const target = f.add('target'); f.start(target); f.claim(target);
  const pending = f.assemble(target); await began;
  f.end(target, 1, 'aborted');
  const canceled = await pending;
  assert.equal(f.recent(canceled), undefined);
  assert.equal(f.store.readPreinject({ targetSessionId: target.id, turnId: '1' }), null);
  rejectHistory(new Error('late rejected read')); await new Promise(resolve => setImmediate(resolve));
  const another = f.add('another'); f.start(another); f.claim(another);
  let closeEntered;
  const closeBegan = new Promise(resolve => { closeEntered = resolve; });
  f.ctx.sessionQuery.readSession = () => { closeEntered(); return new Promise(() => {}); };
  const closing = f.assemble(another); await closeBegan; f.adapter.close();
  assert.equal(f.recent(await closing), undefined);
});

test('no eligible source freezes none; later data never changes the first-turn snapshot', async t => {
  const f = fixture(t), target = f.add('target'); f.start(target); f.claim(target);
  assert.equal(f.recent(await f.assemble(target)), undefined);
  const source = f.add('late'); f.round(source);
  assert.equal(f.recent(await f.assemble(target)), undefined);
  assert.equal(f.store.readPreinject({ targetSessionId: 'target', turnId: '1' }).status, 'none');
});

test('recent budget validation adds no mandatory host service and history absence is conservative', async t => {
  const f = fixture(t);
  assert.equal(Config['~standard'].validate(f.config).value.recentTurnMaxChars, 8000);
  for (const recentTurnMaxChars of [1023, 32001, 1.5]) assert.ok(Config['~standard'].validate({ ...f.config, recentTurnMaxChars }).issues);
  assert.deepEqual(plugin.inject, ['tools', 'sessions', 'agents', 'systemPrompt']);
  const source = f.add('source'); f.round(source);
  const target = f.add('target'); delete target.session.eventAt; f.start(target); f.claim(target);
  assert.equal(f.recent(await f.assemble(target)), undefined);
});

const runtime = process.env.FEIYU_DSH_MODULES_ROOT;
test('actual 0.2.1 Cordis dispatch claim precedes first prompt; restored log and fork keep durable first own semantics', { skip: !runtime }, async t => {
  const load = name => import(pathToFileURL(join(runtime, name, 'lib/index.js')).href);
  const [{ Context, Service }, { SessionStore }, { AgentRegistry, agentEvents }, { SystemPrompt }, { ToolRuntime }] = await Promise.all([
    load('cordis'), load('dsh-session'), load('dsh-agent'), load('dsh-system-prompt'), load('dsh-tools')]);
  const ctx = new Context(), dataDir = mkdtempSync(join(tmpdir(), 'feiyu-recent-real-')), exits = [];
  t.after(async () => { for (const exit of exits.reverse()) await exit(); await ctx.fiber.dispose(); rmSync(dataDir, { recursive: true, force: true }); });
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false }); await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(ToolRuntime, { mode: 'native' });
  const fiber = await ctx.plugin(plugin, { dataDir, instanceId: 'actual-recent', sessionScope: 'profile', participation: 'interactive' }); exits.push(() => fiber.dispose());
  assert.equal(fiber.state, 2);
  const add = id => { const session = ctx.sessions.create(id); const agent = { id, session, ctx, options: {} }; exits.push(ctx.agents.enter(agent)); return agent; };
  const source = add('actual-source'), target = add('actual-target');
  source.session.append('turn/start', { turn: 1 });
  source.session.append('user/message', { id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '真实API合成真人文本' }] }, { surfaceOp: 'append' });
  source.session.append('assistant/message', { turn: 1, step: 1, stream: [], message: { id: 'a', role: 'assistant', source: { kind: 'model', provider: 'synthetic', model: 'offline' }, content: [{ type: 'text', text: '真实API合成肥鱼回复' }] } }, { surfaceOp: 'append' });
  source.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  target.session.append('turn/start', { turn: 1 });
  agentEvents(ctx, target).emit('agent/inbox/claimed', { turn: 1, message: { id: 'next', role: 'user', source: { kind: 'user' }, content: [] } });
  const first = await ctx.systemPrompt.assemble({ agent: target, scope: target });
  assert.match(first.sections.find(section => section.name === RECENT_TURN_SECTION).text, /真实API合成真人文本/);
  assert.equal(target.session.snapshotEvents().some(event => event.type === 'user/message'), false, 'claim is before committed human input');
  target.session.append('turn/end', { turn: 1, reason: { kind: 'blocked' } });
  target.session.append('turn/start', { turn: 2 });
  agentEvents(ctx, target).emit('agent/inbox/claimed', { turn: 2, message: { role: 'user', source: { kind: 'user' } } });
  assert.equal((await ctx.systemPrompt.assemble({ agent: target, scope: target })).sections.some(section => section.name === RECENT_TURN_SECTION), false);
  const forkSession = ctx.sessions.fork(source.session, undefined, 'actual-fork');
  const fork = { id: forkSession.id, session: forkSession, ctx, options: {} }; exits.push(ctx.agents.enter(fork));
  forkSession.append('turn/start', { turn: 2 });
  agentEvents(ctx, fork).emit('agent/inbox/claimed', { turn: 2, message: { role: 'user', source: { kind: 'user' } } });
  assert.match((await ctx.systemPrompt.assemble({ agent: fork, scope: fork })).sections.find(section => section.name === RECENT_TURN_SECTION).text, /真实API合成真人文本/);
  const restoredSession = ctx.sessions.create('actual-restored', { seed: source.session.snapshotEvents(), inheritedEventCount: 0,
    eventState: 'shared-frozen', meta: { ...source.session.header, id: 'actual-restored' } });
  const restored = { id: restoredSession.id, session: restoredSession, ctx, options: {} }; exits.push(ctx.agents.enter(restored));
  restoredSession.append('turn/start', { turn: 2 });
  agentEvents(ctx, restored).emit('agent/inbox/claimed', { turn: 2, message: { role: 'user', source: { kind: 'user' } } });
  assert.equal((await ctx.systemPrompt.assemble({ agent: restored, scope: restored })).sections.some(section => section.name === RECENT_TURN_SECTION), false);

  // Capture originals on the old adapter, then complete while it is unloaded:
  // this requires the optional service path, not the live completed receipt.
  const legacy = add('actual-legacy');
  legacy.session.append('turn/start', { turn: 1 });
  legacy.session.append('user/message', { id: 'legacy-u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '真实Cordis可选历史服务的真人旧轮' }] }, { surfaceOp: 'append' });
  legacy.session.append('assistant/message', { turn: 1, step: 1, stream: [], message: { id: 'legacy-a', role: 'assistant',
    source: { kind: 'model', provider: 'synthetic', model: 'offline' }, content: [{ type: 'text', text: '可选历史服务旧轮回复' }] } }, { surfaceOp: 'append' });
  await fiber.dispose();
  legacy.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const historyReads = [];
  class OptionalQuery extends Service {
    constructor(serviceCtx) { super(serviceCtx, 'sessionQuery'); }
    async readSession(id) {
      historyReads.push(id); const session = ctx.sessions.get(id);
      return { session: session.header, inheritedEventCount: session.inheritedEventCount, events: session.snapshotEvents() };
    }
  }
  await ctx.plugin(OptionalQuery);
  const reloaded = await ctx.plugin(plugin, { dataDir, instanceId: 'actual-recent', sessionScope: 'profile', participation: 'interactive' });
  exits.push(() => reloaded.dispose()); assert.equal(reloaded.state, 2);
  const recipient = add('actual-legacy-recipient'); recipient.session.append('turn/start', { turn: 1 });
  agentEvents(ctx, recipient).emit('agent/inbox/claimed', { turn: 1, message: { role: 'user', source: { kind: 'user' } } });
  const legacyAssembly = await ctx.systemPrompt.assemble({ agent: recipient, scope: recipient });
  assert.ok(historyReads.includes(legacy.id), 'optional service is available without adding a mandatory inject dependency');
  assert.match(legacyAssembly.sections.find(section => section.name === RECENT_TURN_SECTION).text, /真实Cordis可选历史服务的真人旧轮/);
});
