import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import plugin, { Config, createHostAdapter, captureId, WAKE_SECTION, toolSchemas } from '../lib/index.js';

function temporary() {
  const directory = mkdtempSync(join(tmpdir(), 'feiyu-host-test-'));
  return directory;
}

function cleanup(t, directory) {
  t.after(() => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.includes('feiyu-host-test-'));
    rmSync(directory, { recursive: true, force: true });
  });
}

function fixture(t, options = {}) {
  const dataDir = temporary(t);
  const handlers = new Map(), definitions = new Map();
  const session = { id: 'owner', isOwnSeq: () => true };
  const agent = { id: session.id, session };
  const agents = new Map([[agent.id, agent]]), sessions = new Map([[session.id, session]]);
  const ctx = {
    tools: { register(definition) { definitions.set(definition.name, definition); return () => definitions.delete(definition.name); } },
    sessions: { get: (id) => sessions.get(id) }, agents: { get: (id) => agents.get(id) }, systemPrompt: {},
    on(event, handler) { handlers.set(event, handler); return () => { if (handlers.get(event) === handler) handlers.delete(event); }; },
  };
  const adapter = createHostAdapter(ctx, { dataDir, instanceId: 'test-fish', ownerSessionId: 'owner', participation: 'interactive', ...options });
  const adapters = [adapter];
  t.after(() => { for (const item of adapters.toReversed()) item.close(); });
  cleanup(t, dataDir);
  let seq = 0;
  const event = (type, data) => ({ type, seq: seq++, time: Date.parse('2026-10-16T10:00:00Z'), data, ...(type.endsWith('/message') || type === 'tool/result' ? { surfaceOp: 'append' } : {}) });
  const send = (type, data) => { const item = event(type, data); handlers.get('session/event')(session, item); return item; };
  const message = (role, text, id, source = role === 'user' ? 'user' : role === 'tool' ? 'tool' : 'model') => ({ id, role, source: { kind: source }, content: [{ type: 'text', text }] });
  const assemble = (context = { agent, scope: agent }, value = { sections: [], contexts: [], tools: [], variables: {} }) => handlers.get('system-prompt/assemble')(value, context, async () => value);
  return { ...adapter, adapter, trackAdapter: item => { adapters.push(item); return item; }, ctx, dataDir, handlers, definitions, session, agent, sessions, agents, event, send, message, assemble };
}

test('configuration requires explicit ownership and fails closed by default', t => {
  assert.ok(Config['~standard'].validate({}).issues);
  const dataDir = temporary(t);
  cleanup(t, dataDir);
  const result = Config['~standard'].validate({ dataDir, ownerSessionId: 'owner', instanceId: 'fish' });
  assert.equal(result.value.participation, 'solitude');
  assert.equal(result.value.wakeMaxChars, 1800);
  assert.ok(Config['~standard'].validate({ ...result.value, unexpected: true }).issues);
  assert.deepEqual(plugin.inject, ['tools', 'sessions', 'agents', 'systemPrompt']);
});

test('actual DSH ordering: turn/start, user/message, assistant/message; capture only committed originals once', t => {
  const f = fixture(t);
  f.send('turn/start', { turn: 1 });
  const user = f.send('user/message', f.message('user', '原文\n保持空格  和换行', 'm-user'));
  f.send('agent/assistant-stream', { text: 'uncommitted partial' });
  f.send('assistant/attempt', { turn: 1, step: 1 });
  const answer = f.send('assistant/message', { turn: 1, step: 1, message: f.message('assistant', '最终原文', 'm-assistant'), stream: [] });
  f.handlers.get('session/event')(f.session, user);
  f.handlers.get('session/event')(f.session, answer);
  const raw = f.store.listRaw();
  assert.equal(raw.length, 2);
  assert.equal(f.store.getRaw(captureId('test-fish', 'owner', 'm-user')).text, '原文\n保持空格  和换行');
  assert.equal(raw.find(x => x.role === 'assistant').sourceNature, 'model_output');
  assert.equal(raw.every(x => x.occurredAt === null), true);
  f.send('turn/end', { turn: 1 });
  f.send('turn/start', { turn: 2 });
  f.send('assistant/message', { turn: 2, message: f.message('assistant', 'SOLITUDE_SECRET', 'm-alone') });
  assert.equal(f.store.dayStats('2026-10-16').b.total, 1);
  assert.equal(f.store.listRaw().length, 2);
});

test('B content never enters captureMessage; injected user-role context does not count as participation', t => {
  const f = fixture(t);
  const original = f.store.captureMessage.bind(f.store), observed = [];
  f.store.captureMessage = (value) => { observed.push(value); return original(value); };
  f.send('turn/start', { turn: 4 });
  f.send('user/message', f.message('user', 'INJECTED_SECRET', 'injected', 'subagent'));
  const assistant = f.send('assistant/message', { turn: 4, message: f.message('assistant', 'ALONE_SECRET', 'alone') });
  f.handlers.get('session/event')(f.session, assistant);
  assert.equal(observed.length, 3);
  assert.equal(observed.every(value => value.pool === 'b' && value.records.length === 1 && value.records[0].text === ''), true);
  assert.equal(JSON.stringify(observed).includes('SECRET'), false);
  assert.equal(f.store.dayStats('2026-10-16').b.total, 2);
  assert.equal(f.store.listRaw().length, 0);
});

test('answered user-question-reply is human participation; malformed or injected sources remain B', t => {
  const f = fixture(t);
  f.send('turn/start', { turn: 1 });
  const reply = f.message('user', '{"answers":[{"id":"q1","value":"同意"}]}', 'human-reply');
  reply.source = { kind: 'user-question-reply', callId: 'question-call', outcome: 'answered' };
  f.send('user/message', reply);
  f.send('assistant/message', { turn: 1, message: f.message('assistant', '已收到回复', 'reply-answer') });
  assert.equal(f.store.listRaw().length, 2);
  assert.equal(f.store.getRaw(captureId('test-fish', 'owner', reply.id)).sourceNature, 'user_statement');
  for (const [index, source] of [
    { kind: 'user-question-reply', callId: 'question-call', outcome: 'aborted' },
    { kind: 'user-question-reply', outcome: 'answered' },
    { kind: 'user-approval' }, { kind: 'subagent' },
  ].entries()) {
    f.send('turn/start', { turn: index + 2 });
    f.send('user/message', { ...f.message('user', 'not confirmed human', `injected-${index}`), source });
    f.send('assistant/message', { turn: index + 2, message: f.message('assistant', 'not participating', `injected-answer-${index}`) });
  }
  assert.equal(f.store.listRaw().length, 2);
  assert.equal(f.store.dayStats('2026-10-16').b.total, 8);
});

test('solitude is explicit and applies even to user sources; missed turn classification never stores assistant text', t => {
  const solitary = fixture(t, { participation: 'solitude' });
  solitary.send('turn/start', { turn: 1 });
  solitary.send('user/message', solitary.message('user', 'private', 'u'));
  solitary.send('assistant/message', { turn: 1, message: solitary.message('assistant', 'private answer', 'a') });
  assert.equal(solitary.store.listRaw().length, 0);
  assert.equal(solitary.store.dayStats('2026-10-16').b.total, 2);
  const missed = fixture(t);
  missed.send('user/message', missed.message('user', 'loaded in middle', 'u'));
  missed.send('assistant/message', { turn: 1, message: missed.message('assistant', 'unknown participation', 'a') });
  assert.equal(missed.store.listRaw().length, 1);
  assert.equal(missed.store.dayStats('2026-10-16').b.total, 1);
});

test('text blocks stay separate originals with one source root; unsupported attachments are explicit omissions', async t => {
  const f = fixture(t);
  f.send('turn/start', { turn: 1 });
  const message = f.message('user', '第一段', 'multi');
  message.content.push({ type: 'image', attachment: { id: 'opaque' } }, { type: 'text', text: '第二段\n原格式' });
  const multi = f.send('user/message', message);
  f.handlers.get('session/event')(f.session, multi);
  const raw = f.store.listRaw();
  assert.equal(raw.length, 2);
  assert.equal(new Set(raw.map(x => x.sourceRoot)).size, 1);
  assert.deepEqual(raw.map(x => x.text).sort(), ['第一段', '第二段\n原格式'].sort());
  const image = f.event('user/message', { ...f.message('user', '', 'image'), content: [{ type: 'image', attachment: { id: 'opaque' } }] });
  assert.equal(f.onSessionEvent(f.session, image).skipped, 'unsupported_nontext');
  f.onSessionEvent(f.session, image);
  assert.equal(f.diagnostics().unsupportedMessages, 1);
  assert.equal(f.store.dayStats('2026-10-16').b.total, 0);
  assert.match((await f.assemble()).sections[0].text, /附件未保存/);
});

test('message-level pool claims survive restart, including multipart and unsupported A messages', t => {
  const f = fixture(t);
  f.send('turn/start', { turn: 1 });
  const content = f.message('user', 'first exact block', 'durable-multipart');
  content.content.push({ type: 'text', text: 'second exact block' });
  const multi = f.send('user/message', content);
  const image = f.send('user/message', { ...f.message('user', '', 'durable-image'), content: [{ type: 'image' }] });
  f.close();
  const solitary = f.trackAdapter(createHostAdapter(f.ctx, { dataDir: f.dataDir, instanceId: 'test-fish', ownerSessionId: 'owner', participation: 'solitude' }));
  for (const event of [multi, image]) assert.throws(() => solitary.onSessionEvent(f.session, event), /capture|different|classification|pool/i);
  assert.equal(solitary.store.dayStats('2026-10-16').b.total, 0);
  assert.equal(solitary.store.listRaw().length, 2);
  const b = f.event('user/message', f.message('user', 'NEVER_CAPTURE_B_BODY', 'durable-b'));
  assert.equal(solitary.onSessionEvent(f.session, b).duplicate, false);
  assert.equal(solitary.onSessionEvent(f.session, b).duplicate, true);
  assert.equal(solitary.store.dayStats('2026-10-16').b.total, 1);
  solitary.close();
  const interactive = f.trackAdapter(createHostAdapter(f.ctx, { dataDir: f.dataDir, instanceId: 'test-fish', ownerSessionId: 'owner', participation: 'interactive' }));
  interactive.onSessionEvent(f.session, f.event('turn/start', { turn: 1 }));
  assert.equal(interactive.onSessionEvent(f.session, multi).duplicate, true);
  assert.equal(interactive.onSessionEvent(f.session, image).duplicate, true);
  assert.throws(() => interactive.onSessionEvent(f.session, b), /capture|different|classification|pool/i);
  assert.equal(interactive.store.dayStats('2026-10-16').b.total, 1);
  assert.equal(interactive.store.listRaw().length, 2);
  assert.equal(interactive.store.listRaw().some(record => record.text.includes('NEVER_CAPTURE_B_BODY')), false);
});

test('multipart capture validates every part before committing any text or claiming the message', t => {
  const f = fixture(t);
  f.send('turn/start', { turn: 1 });
  const message = f.message('user', 'first valid part', 'atomic-message');
  message.content.push({ type: 'text', text: 'a'.repeat(10000001) });
  const event = f.event('user/message', message);
  assert.throws(() => f.onSessionEvent(f.session, event), /10 million/);
  assert.equal(f.store.listRaw().length, 0);
  message.content[1].text = 'second valid part';
  const committed = f.onSessionEvent(f.session, event);
  assert.equal(committed.committed, true);
  assert.equal(committed.duplicate, false);
  assert.equal(committed.records.length, 2);
  assert.deepEqual(f.store.listRaw().map(record => record.text), ['first valid part', 'second valid part']);
});

test('memory tool echoes and mixed PTC outputs cannot become fresh originals; external tools keep source attribution', t => {
  const f = fixture(t);
  f.send('turn/start', { turn: 1 });
  f.send('user/message', f.message('user', '开始', 'u'));
  const result = (callId, text, id) => ({ turn: 1, step: 1, message: { ...f.message('tool', text, id), toolCallId: callId } });
  for (const toolName of ['memory_search', 'memory_read', 'memory_write', 'memory_list', 'memory_dict', 'run_code']) {
    f.send('tool/call', { turn: 1, step: 1, callId: toolName, name: toolName, arguments: '{}' });
    const event = f.event('tool/result', result(toolName, 'copied old evidence', `result-${toolName}`));
    assert.equal(f.onSessionEvent(f.session, event).skipped, 'derived_memory_or_transport');
  }
  assert.equal(f.onSessionEvent(f.session, f.event('tool/result', result('unknown', 'unknown copy', 'result-unknown'))).skipped, 'unknown_tool_origin');
  f.send('tool/call', { turn: 1, step: 1, callId: 'read-file', name: 'read_file', arguments: '{}' });
  f.send('tool/result', result('read-file', 'external observed output', 'external-result'));
  const raw = f.store.listRaw();
  assert.equal(raw.length, 2);
  assert.equal(raw.find(record => record.role === 'tool').sourceNature, 'tool_result');
  assert.ok(raw.find(record => record.role === 'tool').tags.includes('dsh:tool:read_file'));
  assert.equal(raw.some(record => record.text.includes('copied')), false);
});

test('each assembly always receives exactly one stable wake section, with scope and live object identity gates', async t => {
  const f = fixture(t);
  const first = await f.assemble(), second = await f.assemble();
  assert.equal(first.sections[0].name, WAKE_SECTION);
  assert.equal(first.sections[0].text, second.sections[0].text);
  assert.equal(first.sections[0].interpolate, false);
  assert.ok(first.sections[0].text.length <= 1800);
  await f.assemble(undefined, second);
  assert.equal(second.sections.length, 3);
  for (const context of [{}, { agent: f.agent }, { agent: f.agent, scope: {} }, { agent: { ...f.agent }, scope: f.agent }]) {
    assert.equal((await f.assemble(context)).sections.length, 0);
  }
  f.sessions.set('owner', { ...f.session });
  assert.equal((await f.assemble()).sections.length, 0);
});

test('pending projections are visible without misreporting a committed capture as lost', async t => {
  const f = fixture(t);
  f.send('turn/start', { turn: 1 });
  const event = f.event('user/message', f.message('user', 'committed original', 'pending-projection'));
  assert.equal(f.onSessionEvent(f.session, event).committed, true);
  const pending = { pending: true, count: 1, paths: [{ path: 'index/entries.json', operation: 'rebuild', errorCode: 'EPERM' }] };
  f.store.projectionStatus = () => pending;
  assert.equal(f.diagnostics().captureFailed, false);
  assert.equal(f.diagnostics().projection.pending, true);
  const text = (await f.assemble()).sections[0].text;
  assert.match(text, /数据库已提交.*派生文件待修复/);
  assert.doesNotMatch(text, /采集失败/);
  assert.ok(text.length <= 1800);
});

test('foreign session events, inherited messages and replacement summaries are never captured', t => {
  const f = fixture(t);
  const item = f.event('user/message', f.message('user', 'not mine', 'foreign'));
  f.onSessionEvent({ ...f.session }, item);
  f.onSessionEvent({ id: 'other', isOwnSeq: () => true }, item);
  f.session.isOwnSeq = () => false;
  f.onSessionEvent(f.session, item);
  f.session.isOwnSeq = () => true;
  f.onSessionEvent(f.session, { ...item, surfaceOp: { replace: [] } });
  assert.equal(f.store.listRaw().length, 0);
  assert.equal(f.store.dayStats('2026-10-16').b.total, 0);
});

test('registered JSON schemas match actual APIs and tools reject missing or forged owners and unsafe writes', async t => {
  const f = fixture(t);
  assert.equal(f.definitions.size, 20);
  const search = f.definitions.get('memory_search');
  assert.equal(search.parameters.type, 'object');
  assert.equal(typeof search.output.render, 'function');
  await assert.rejects(search.execute({}, {}), /owner/);
  await assert.rejects(search.execute({}, { agent: { ...f.agent } }), /owner/);
  const result = await search.execute({}, { agent: f.agent });
  assert.deepEqual(result.candidates, []);
  await assert.rejects(search.execute({ madeUp: true }, { agent: f.agent }), /unknown/);
  const write = f.definitions.get('memory_write');
  await assert.rejects(write.execute({ statementType: 'fact', kind: 'raw', text: 'fake', hooks: [], sources: [] }, { agent: f.agent }), /invalid/);
  await assert.rejects(write.execute({ statementType: 'fact', kind: 'retention_review', text: '', hooks: [], sources: [] }, { agent: f.agent }), /invalid/);
  const entry = await write.execute({ statementType: 'fact', kind: 'doing', text: '待确认事项', hooks: ['核对'], sources: [], entities: ['测试实体'] }, { agent: f.agent });
  assert.equal(entry.evidenceStatus, 'unverified');
  assert.deepEqual(entry.entities, ['测试实体']);
  const list = await f.definitions.get('memory_list').execute({ type: 'doing' }, { agent: f.agent });
  assert.equal(list.candidates.length, 1);
  assert.ok(toolSchemas.memory_list.properties.date);
  assert.ok(toolSchemas.memory_list.properties.status);
  assert.ok(toolSchemas.memory_search.properties.includeHistory);
  f.close();
  assert.equal(f.definitions.size, 0);
  assert.equal(f.handlers.size, 0);
});

test('registered tools accept bounded read pages and historical/status filters', async t => {
  const f = fixture(t);
  f.send('turn/start', { turn: 1 });
  const exactText = '第一段\n' + 'X'.repeat(5000);
  f.send('user/message', f.message('user', exactText, 'paged-original'));
  const rawId = captureId('test-fish', 'owner', 'paged-original');
  const execute = (name, args) => f.definitions.get(name).execute(args, { agent: f.agent });
  const first = await execute('memory_read', { id: rawId });
  assert.equal(first.text, exactText.slice(0, 4000));
  assert.equal(first.hasMore, true);
  const second = await execute('memory_read', { id: rawId, offset: first.nextOffset, limit: 16000 });
  assert.equal(first.text + second.text, exactText);
  assert.equal(second.hasMore, false);
  await assert.rejects(execute('memory_read', { id: rawId, limit: 16001 }), /16000/);
  await assert.rejects(execute('memory_search', { includeHistory: 'yes' }), /invalid/);
  await execute('memory_write', { id: 'versioned-task', statementType: 'fact', kind: 'doing', text: 'first status', hooks: ['versioned'], sources: [{ rawId, quote: '第一段' }], status: 'active' });
  await execute('memory_write', { id: 'versioned-task', statementType: 'fact', kind: 'doing', text: 'second status', hooks: ['versioned'], sources: [{ rawId, quote: '第一段' }], status: 'done' });
  const latest = await execute('memory_list', { type: 'doing' });
  assert.deepEqual(latest.candidates.map(item => item.version), [2]);
  const history = await execute('memory_search', { type: 'doing', includeHistory: true, status: 'active' });
  assert.deepEqual(history.candidates.map(item => item.version), [1]);
  const entry = await execute('memory_read', { id: 'versioned-task', version: 1, evidenceOffset: 0, evidenceLimit: 1 });
  assert.equal(entry.evidence.length, 1);
  assert.equal(entry.evidence[0].originalId, rawId);
  assert.equal(JSON.stringify(entry).includes('X'.repeat(4000)), false);
});

test('oversized A originals fail visibly instead of truncating or silently losing records', async t => {
  const f = fixture(t);
  f.send('turn/start', { turn: 1 });
  assert.throws(() => f.send('user/message', f.message('user', 'a'.repeat(10000001), 'oversize')), /10 million/);
  assert.equal(f.diagnostics().captureFailed, true);
  assert.equal(f.store.listRaw().length, 0);
  assert.match((await f.assemble()).sections[0].text, /采集失败/);
});

const installedRoot = process.env.FEIYU_DSH_MODULES_ROOT;
test('opt-in: real installed Cordis, SessionStore, AgentRegistry, SystemPrompt and ToolRuntime contracts', { skip: !installedRoot }, async t => {
  const load = (name) => import(pathToFileURL(join(installedRoot, name, 'lib/index.js')).href);
  const [{ Context }, { SessionStore }, { AgentRegistry }, { SystemPrompt }, { ToolRuntime, assertObjectJsonSchema, assertSupportedJsonSchema }] = await Promise.all([
    load('cordis'), load('dsh-session'), load('dsh-agent'), load('dsh-system-prompt'), load('dsh-tools'),
  ]);
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  const [{ Entry }, { applyEntryPatches, entryListSchema }, yaml] = await Promise.all([
    load('cordis-plugin-loader'), load('cordis-plugin-include'),
    import(pathToFileURL(join(installedRoot, '../js-yaml/index.js')).href),
  ]);
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  const patches = yaml.load(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), { schema: entryListSchema });
  const rows = applyEntryPatches([], patches, (...args) => assert.fail(args.join(' ')));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].disabled, true);
  assert.ok(Config['~standard'].validate(rows[0].config).issues);
  const dormant = new Entry({ ctx });
  dormant.options = rows[0];
  dormant.init = () => assert.fail('disabled bundle must not initialize its plugin');
  await dormant.refresh();
  assert.equal(dormant.fiber, undefined);
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false });
  await ctx.plugin(SessionStore);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(ToolRuntime, { mode: 'native' });
  const dataDir = temporary(t);
  cleanup(t, dataDir);
  const hostFiber = await ctx.plugin(plugin, { dataDir, instanceId: 'integration', ownerSessionId: 'live-owner', participation: 'interactive' });
  assert.equal(hostFiber.state, 2);
  const session = ctx.sessions.create('live-owner');
  const agent = { id: session.id, session, ctx };
  const detach = ctx.agents.enter(agent, undefined);
  t.after(detach);
  session.append('turn/start', { turn: 1 });
  session.append('user/message', { id: 'live-message', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '真实宿主测试原文' }] }, { surfaceOp: 'append' });
  for (const toolName of Object.keys(toolSchemas)) {
    const definition = ctx.tools.get(toolName, agent);
    assert.ok(definition);
    assertObjectJsonSchema(definition.parameters);
    assertSupportedJsonSchema(definition.output.schema);
  }
  const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent });
  assert.equal(assembly.sections.filter(x => x.name === WAKE_SECTION).length, 1);
  assert.equal((await ctx.systemPrompt.assemble({ agent, scope: agent })).sections.filter(x => x.name === WAKE_SECTION).length, 1);
  const outcome = await ctx.tools.execute({ callId: 'call-search', name: 'memory_search', arguments: { q: '真实宿主' }, agent, signal: new AbortController().signal });
  assert.equal(outcome.isError, false, JSON.stringify(outcome));
  assert.equal(outcome.value.candidates.length, 1);
  session.append('turn/start', { turn: 2 });
  const answerText = '问答回复\n' + '原'.repeat(5000);
  session.append('user/message', { id: 'live-question-reply', role: 'user', source: { kind: 'user-question-reply', callId: 'live-question', outcome: 'answered' }, content: [{ type: 'text', text: answerText }] }, { surfaceOp: 'append' });
  session.append('assistant/message', { turn: 2, step: 1, message: { id: 'live-reply-followup', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: '真人回复后继续处理' }] } }, { surfaceOp: 'append' });
  const rawId = captureId('integration', session.id, 'live-question-reply');
  const firstPage = await ctx.tools.execute({ callId: 'call-read-page', name: 'memory_read', arguments: { id: rawId, limit: 4000, evidenceLimit: 0 }, agent, signal: new AbortController().signal });
  assert.equal(firstPage.isError, false, JSON.stringify(firstPage));
  assert.equal(firstPage.value.text, answerText.slice(0, 4000));
  assert.equal(firstPage.value.hasMore, true);
  const nextPage = await ctx.tools.execute({ callId: 'call-read-next', name: 'memory_read', arguments: { id: rawId, offset: firstPage.value.nextOffset, limit: 16000 }, agent, signal: new AbortController().signal });
  assert.equal(nextPage.isError, false, JSON.stringify(nextPage));
  assert.equal(firstPage.value.text + nextPage.value.text, answerText);
  const followup = await ctx.tools.execute({ callId: 'call-reply-followup', name: 'memory_search', arguments: { q: '真人回复后', includeHistory: true }, agent, signal: new AbortController().signal });
  assert.equal(followup.isError, false, JSON.stringify(followup));
  assert.ok(followup.value.candidates.some(candidate => candidate.id === captureId('integration', session.id, 'live-reply-followup')));
  const foreign = await ctx.tools.execute({ callId: 'call-foreign', name: 'memory_search', arguments: {}, signal: new AbortController().signal });
  assert.equal(foreign.isError, true);
  await hostFiber.dispose();
});
