import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import plugin, { createHostAdapter, captureId, toolSchemas, WAKE_SECTION, CORE_SECTION, PREFERENCE_SECTION, RECALL_SECTION } from '../lib/index.js';
import { buildWake } from '../lib/lifecycle.js';

function fixture(t, config = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'feiyu-archive-host-'));
  const definitions = new Map(), handlers = new Map();
  const session = { id: 'main', header: { id: 'main' }, isOwnSeq: () => true };
  const agent = { id: session.id, session, options: {} };
  const ctx = {
    tools: { register(definition) { definitions.set(definition.name, definition); return () => definitions.delete(definition.name); } },
    sessions: { get: id => id === session.id ? session : undefined },
    agents: { get: id => id === agent.id ? agent : undefined, roots: () => [agent], create: () => assert.fail('no synthetic agent is allowed') },
    systemPrompt: {}, on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name); },
    llm: { stream: () => assert.fail('no background model is allowed') },
  };
  const adapter = createHostAdapter(ctx, { dataDir, instanceId: 'archive-fish', sessionScope: 'profile', participation: 'interactive', ...config });
  t.after(() => { adapter.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const execute = (name, args) => definitions.get(name).execute(args, { agent });
  let seq = 0;
  const event = (type, data) => adapter.onSessionEvent(session, { type, data, seq: ++seq, time: Date.now(),
    ...(['user/message', 'assistant/message', 'tool/result'].includes(type) ? { surfaceOp: 'append' } : {}) });
  const assemble = async (value = { sections: [] }) => {
    return handlers.get('system-prompt/assemble')(value, { agent, scope: agent }, async () => value);
  };
  return { ...adapter, agent, execute, event, assemble, definitions };
}

const userText = '合成测试项目选择方案甲，执行周期为每周一次。';
function archiveRequest(parent) {
  return { requestId: 'archive-request', id: 'archive-key-info', expectedVersion: 0, action: 'write', reason: '长期只需保留方案及执行周期',
    body: { time: '原文未说明具体日期', persons: ['合成测试项目参与者'], event: 'ARCHIVE_BODY_ONLY：每周维护方案甲。' }, derivedFrom: [parent.id], statementType: 'fact',
    coverage: { scope: [{ id: parent.id, version: parent.version }], covered: [parent.id], notCovered: [], scopeNote: '只讨论本次明确审阅的项目笔记，不声称找全其他相关条目' } };
}

test('A3 schema requires declared coverage, forbids raw sources and exposes only the six final tools', () => {
  assert.equal(Object.keys(toolSchemas).length, 23);
  for (const name of ['memory_search', 'memory_list', 'memory_read']) assert.ok(toolSchemas[name].properties.pool.enum.includes('a3'));
  assert.equal(toolSchemas.memory_graph.properties.pool.enum.includes('a3'), false);
  assert.equal(toolSchemas.memory_write.properties.pool.enum.includes('a3'), false);
  assert.equal(Object.hasOwn(toolSchemas, 'memory_archive'), false);
  assert.equal(Object.hasOwn(toolSchemas.memory_a3_write.properties, 'sources'), false);
  assert.deepEqual(toolSchemas.memory_a3_write.properties.coverage.required, ['scope', 'covered', 'notCovered', 'scopeNote']);
  assert.deepEqual(toolSchemas.memory_a3_write.properties.coverage.properties.scope.items.required, ['id', 'version']);
  assert.ok(toolSchemas.memory_read.properties.kind.enum.includes('a3'));
  for (const name of ['memory_a3_write', 'memory_a3_list', 'memory_a3_read', 'memory_a2_review_queue', 'memory_a2_review', 'memory_a2_cleanup']) assert.ok(toolSchemas[name]);
});

test('host archive tool preserves A1/A2 and history while preventing its derived output from becoming original evidence', async t => {
  const f = fixture(t);
  f.event('turn/start', { turn: 1 });
  f.event('user/message', { id: 'human', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: userText }] });
  const rawId = captureId('archive-fish', 'main', 'human');
  const parent = await f.execute('memory_write', { statementType: 'fact', kind: 'memory', id: 'a2-parent', text: 'A2_FIRST_PASS_ONLY：项目选择和执行细节。', hooks: ['合成项目'],
    sources: [{ rawId, quote: userText, support: 'supports' }] });
  const request = archiveRequest(parent);
  const result = await f.execute('memory_a3_write', request);
  assert.equal(result.committed, true);
  assert.equal(result.pool, 'a3');
  assert.equal(f.store.getEntry(parent.id).version, 1);
  assert.equal(f.store.getEntry(parent.id).pool, 'a2');
  assert.equal(f.store.getRaw(rawId).text, userText);
  assert.equal((await f.execute('memory_list', { pool: 'a3' })).candidates.length, 1);
  const read = await f.execute('memory_read', { id: result.id, pool: 'a3' });
  assert.deepEqual(read.body, request.body);
  assert.equal(read.kind, 'a3');
  assert.equal(read.evidenceStatus, 'derived_only');
  assert.equal(read.sourceEntries[0].id, parent.id);
  assert.equal(read.sourceEntries[0].version, 1);
  f.event('tool/call', { turn: 1, callId: 'archive-call', name: 'memory_a3_write' });
  const echoed = f.event('tool/result', { turn: 1, message: { id: 'archive-echo', role: 'tool', toolCallId: 'archive-call', content: [{ type: 'text', text: JSON.stringify(read) }] } });
  assert.equal(echoed.skipped, 'derived_memory_or_transport');
  assert.equal(f.store.listRaw().length, 1);
  await assert.rejects(f.execute('memory_a3_write', { ...request, requestId: 'raw-bypass', id: 'invalid', sources: [{ rawId, quote: '每周一次' }] }), /unknown/);
  await assert.rejects(f.execute('memory_a3_write', { ...request, requestId: 'coverage-missing', id: 'invalid', coverage: { scope: request.coverage.scope, covered: request.derivedFrom, notCovered: [] } }), /scopeNote/);
  await assert.rejects(f.execute('memory_write', { statementType: 'fact', kind: 'memory', pool: 'a3', text: 'bypass', hooks: [], sources: [] }), /invalid/);
  await f.execute('memory_a3_write', { requestId: 'archive-revoke', id: result.id, expectedVersion: 1, action: 'revoke', reason: '此关键记录不再适用' });
  assert.equal((await f.execute('memory_list', { pool: 'a3', status: 'active' })).candidates.length, 0);
  assert.deepEqual((await f.execute('memory_read', { id: result.id, version: 1 })).body, request.body);
});

test('normal prompt includes the A3 route and procedure, never its contents or an automatic archive mutation', async t => {
  const f = fixture(t);
  f.store.appendRaw({ id: 'source', pool: 'a', sessionId: 'main', role: 'user', text: userText });
  const parent = f.store.writeEntry({ id: 'parent', statementType: 'fact', kind: 'memory', text: 'A2_FIRST_PASS_ONLY', sources: [{ rawId: 'source', quote: userText, support: 'supports' }] });
  await f.execute('memory_a3_write', archiveRequest(parent));
  f.store.writeA3 = () => assert.fail('assembling a prompt must not archive automatically');
  f.store.reviewA2 = () => assert.fail('assembling a prompt must not approve cleanup automatically');
  const assembly = await f.assemble();
  assert.deepEqual(assembly.sections.map(item => item.name), [WAKE_SECTION, CORE_SECTION, PREFERENCE_SECTION]);
  const all = assembly.sections.map(item => item.text).join('\n');
  assert.doesNotMatch(all, /ARCHIVE_BODY_ONLY|A2_FIRST_PASS_ONLY|archive-key-info/);
  const wake = assembly.sections[0].text;
  assert.match(wake, /A1原文→A2提纯→A3三要素归档/);
  assert.match(wake, /memory_a3_write/);
  assert.match(wake, /memory_a3_list/);
  assert.match(wake, /A3归纳归档 1 条/);
  assert.match(wake, /derived_only不提高可信度/);
  assert.ok(wake.length <= 1800);
  for (const maxChars of [160, 280]) assert.ok(buildWake(f.store, { maxChars }).length <= maxChars);
});

const installedRoot = process.env.FEIYU_DSH_MODULES_ROOT;
test('opt-in actual DSH ToolRuntime accepts declared A3 coverage and exact A2 lineage without a model call', { skip: !installedRoot }, async t => {
  const load = name => import(pathToFileURL(join(installedRoot, name, 'lib/index.js')).href);
  const [{ Context }, { SessionStore }, { AgentRegistry }, { SystemPrompt }, { ToolRuntime }] = await Promise.all([
    load('cordis'), load('dsh-session'), load('dsh-agent'), load('dsh-system-prompt'), load('dsh-tools'),
  ]);
  const ctx = new Context(), dataDir = mkdtempSync(join(tmpdir(), 'feiyu-real-archive-host-'));
  let detach;
  t.after(async () => { detach?.(); await ctx.fiber.dispose(); rmSync(dataDir, { recursive: true, force: true }); });
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false });
  await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(ToolRuntime, { mode: 'native' });
  const fiber = await ctx.plugin(plugin, { dataDir, instanceId: 'real-archive', sessionScope: 'profile', participation: 'interactive' });
  assert.equal(fiber.state, 2);
  const session = ctx.sessions.create('main'), agent = { id: session.id, session, ctx, options: {} };
  detach = ctx.agents.enter(agent, undefined);
  session.append('turn/start', { turn: 1 });
  session.append('user/message', { id: 'human', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: userText }] }, { surfaceOp: 'append' });
  let calls = 0;
  const execute = async (name, args) => {
    const result = await ctx.tools.execute({ callId: `call-${++calls}`, name, arguments: args, agent, signal: new AbortController().signal });
    assert.equal(result.isError, false, JSON.stringify(result));
    return result.value;
  };
  const rawId = captureId('real-archive', 'main', 'human');
  const parent = await execute('memory_write', { statementType: 'fact', kind: 'memory', id: 'parent', text: '合成A2摘要', hooks: [], sources: [{ rawId, quote: userText, support: 'supports' }] });
  const archived = await execute('memory_a3_write', archiveRequest(parent));
  assert.equal(archived.pool, 'a3');
  assert.equal((await execute('memory_read', { id: archived.id, pool: 'a3' })).sourceEntries[0].version, 1);
  const discovery = await execute('memory_b2_write', { requestId: 'real-discovery', id: 'discovery', expectedVersion: 0, action: 'write',
    text: 'B2_PRIVATE_DISCOVERY', judgment: '仅为合成网页主张，尚未确认', reason: '合成冲浪关键发现', sources: [{ url: 'https://example.com/reference', title: '合成网页' }] });
  assert.equal(discovery.pool, 'b2');
  assert.equal((await execute('memory_read', { id: discovery.id, kind: 'b2' })).evidenceStatus, 'external_reference');
  const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent });
  assert.doesNotMatch(assembly.sections.find(section => section.name === WAKE_SECTION).text, /ARCHIVE_BODY_ONLY|B2_PRIVATE_DISCOVERY/);
  const related = assembly.sections.find(section => section.name === 'feiyu-memory:related-data');
  if (related) assert.ok(JSON.parse(related.text).items.every(item => item.id !== rawId), 'current input cannot be its own recalled source');
  await fiber.dispose();
});

test('normal assembly retires only approved due A2 versions, keeps pending items and never creates A3', async t => {
  const f = fixture(t);
  const old = new Date(Date.now() - 31 * 86400000).toISOString();
  const pending = f.store.writeEntry({ id: 'unreviewed', statementType: 'fact', kind: 'memory', text: '尚未审核需保留', recordedAt: old });
  const approved = f.store.writeEntry({ id: 'approved', statementType: 'fact', kind: 'memory', text: '已经明确审核', recordedAt: old });
  assert.equal((await f.execute('memory_a2_review_queue', {})).total, 2);
  await f.execute('memory_a2_review', { requestId: 'approval', reason: '合成审核', items: [{ id: approved.id, version: approved.version, decision: 'discard', reason: '已明确不需长期保留' }] });
  const preview = await f.execute('memory_a2_cleanup', {});
  assert.equal(preview.applied, false);
  f.store.writeA3 = () => assert.fail('cleanup must never invent A3');
  const assembly = await f.assemble();
  assert.equal(f.store.getEntry(approved.id).retired, true);
  assert.equal(Boolean(f.store.getEntry(pending.id).retired), false);
  assert.equal(f.store.listEntries({ pool: 'a3' }).length, 0);
  assert.match(assembly.sections[0].text, /A2待审 1 条/);
  assert.equal((await f.execute('memory_read', { id: approved.id, version: 1 })).text, '已经明确审核');
  const retried = await f.execute('memory_a2_cleanup', { apply: true });
  assert.equal(retried.retired, 0);
});

test('human recall cues keep one route and never inject the current raw message as its own history', async t => {
  const f = fixture(t);
  f.store.recordRecall = () => assert.fail('a cue must not itself perform a retrieval tool call');
  for (const [index, cue] of ['我记得', '之前', '上次', '以前', '去年'].entries()) {
    f.event('turn/start', { turn: index + 1 });
    f.event('user/message', { id: `cue-${index}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `PRIVATE_CUE_BODY ${cue} 的某个合成问题` }] });
    const assembly = await f.assemble();
    await f.assemble(assembly);
    assert.equal(assembly.sections.filter(section => section.name === RECALL_SECTION).length, 1);
    const related = assembly.sections.find(section => section.name === 'feiyu-memory:related-data');
    if (related) assert.ok(!JSON.parse(related.text).items.some(item => item.id === captureId('archive-fish', 'main', `cue-${index}`)));
    assert.match(assembly.sections.find(section => section.name === RECALL_SECTION).text, /按memory_search\/memory_list→memory_read核对/);
    f.event('turn/end', { turn: index + 1 });
    assert.equal((await f.assemble()).sections.some(section => section.name === RECALL_SECTION), false);
  }
});

test('solitude bodies and nonhuman user-role injections never trigger recall guidance', async t => {
  const alone = fixture(t, { participation: 'solitude' });
  const unreadableBlock = { type: 'text', get text() { assert.fail('solitude text must not be inspected for cue words'); } };
  alone.event('turn/start', { turn: 1 });
  alone.event('user/message', { id: 'alone', role: 'user', source: { kind: 'user' }, content: [unreadableBlock] });
  assert.equal((await alone.assemble()).sections.some(section => section.name === RECALL_SECTION), false);
  const injected = fixture(t);
  injected.event('turn/start', { turn: 1 });
  injected.event('user/message', { id: 'injected', role: 'user', source: { kind: 'subagent' }, content: [{ type: 'text', text: '我记得之前上次以前去年' }] });
  assert.equal((await injected.assemble()).sections.some(section => section.name === RECALL_SECTION), false);
});

test('B2 is an explicit bounded external-reference tool and its output never becomes original evidence', async t => {
  const f = fixture(t);
  const args = { requestId: 'discovery-write', id: 'discovery', expectedVersion: 0, action: 'write', text: 'B2_PRIVATE_DISCOVERY',
    judgment: '只有网页主张，不能据此认定属实', reason: '保存一个合成测试发现', sources: [{ url: 'https://example.com/reference', title: '合成网页' }] };
  for (const tool of ['memory_search', 'memory_list', 'memory_read']) assert.ok(toolSchemas[tool].properties.pool.enum.includes('b2'));
  assert.equal(Object.hasOwn(toolSchemas, 'memory_b2_cleanup'), false);
  assert.deepEqual(toolSchemas.memory_b2_write.properties.sources.items.required, ['url', 'title']);
  const result = await f.execute('memory_b2_write', args);
  const record = await f.execute('memory_read', { id: result.id, kind: 'b2' });
  assert.equal(record.text, args.text);
  assert.equal(record.evidenceStatus, 'external_reference');
  assert.equal(record.externalSources[0].url, args.sources[0].url);
  f.event('turn/start', { turn: 1 });
  f.event('user/message', { id: 'human-b2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '正常合成消息' }] });
  f.event('tool/call', { turn: 1, callId: 'b2-call', name: 'memory_b2_write' });
  assert.equal(f.event('tool/result', { turn: 1, message: { id: 'b2-echo', role: 'tool', toolCallId: 'b2-call', content: [{ type: 'text', text: JSON.stringify(record) }] } }).skipped, 'derived_memory_or_transport');
  assert.equal(f.store.listRaw().length, 1);
  f.store.writeB2 = () => assert.fail('normal assembly must not create discoveries');
  const assembly = await f.assemble();
  const all = assembly.sections.map(section => section.text).join('\n');
  assert.match(all, /memory_b2_write/);
  assert.match(all, /external_reference不等于网页验证/);
  assert.doesNotMatch(all, /B2_PRIVATE_DISCOVERY|example\.com/);
});

test('normal assembly removes B2 only at fourteen days without reading or inventing browsing content', async t => {
  const f = fixture(t);
  const initial = new Date('2026-09-01T00:00:00Z').getTime();
  let clock = initial;
  f.store.now = () => new Date(clock).toISOString();
  await f.execute('memory_b2_write', { requestId: 'expiry-write', id: 'expiry', expectedVersion: 0, action: 'write', text: '临时网页发现',
    judgment: '尚未验证', reason: '合成14天清理', sources: [{ url: 'https://example.com/reference', title: '合成网页' }] });
  clock = initial + 14 * 86400000 - 1;
  await f.assemble();
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM b2_notes').get().n, 1);
  clock++;
  await f.assemble();
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM b2_notes').get().n, 0);
  assert.equal(await f.execute('memory_read', { id: 'expiry', kind: 'b2', version: 1 }), null);
  assert.equal(f.store.listRaw().length, 0);
});

test('normal assembly retires reviewed A1 at 168 hours, retains cited evidence and leaves unreviewed originals pending', async t => {
  const f = fixture(t);
  const initial = new Date('2026-09-01T00:00:00Z').getTime();
  let clock = initial;
  f.store.now = () => new Date(clock).toISOString();
  for (const id of ['unreviewed-a1', 'omitted-a1', 'cited-a1']) f.store.appendRaw({ id, pool: 'a', sessionId: 'main', role: 'user', text: `合成原文 ${id}` });
  clock = initial + 7 * 86400000 - 1;
  await f.assemble();
  assert.equal(f.store.listRaw().length, 3);
  assert.equal((await f.execute('memory_review_queue', {})).total, 0);
  clock++;
  await f.execute('memory_review', { action: 'submit', requestId: 'a1-review', rawIds: ['omitted-a1', 'cited-a1'], reason: '合成七天自审',
    omissions: [{ rawId: 'omitted-a1', reason: '无长期关键信息' }], entries: [{ statementType: 'fact', kind: 'memory', id: 'cited-a2', text: '有原文支持的合成A2',
      sources: [{ rawId: 'cited-a1', quote: '合成原文 cited-a1', support: 'supports' }] }] });
  assert.equal(f.store.listRaw().length, 3, 'self-review itself does not delete');
  f.store.submitSelfReview = () => assert.fail('housekeeping must not create a self-review');
  await f.assemble();
  assert.deepEqual(f.store.listRaw().map(raw => raw.id), ['unreviewed-a1']);
  assert.equal(f.store.getRaw('omitted-a1'), null);
  assert.equal(f.store.getRaw('cited-a1').text, '合成原文 cited-a1');
  assert.equal((await f.execute('memory_review_queue', {})).total, 1);
  assert.equal((await f.execute('memory_read', { id: 'cited-a2' })).evidenceStatus, 'quote_verified');
  await f.assemble();
  assert.equal(f.store.listRaw().length, 1);
});
