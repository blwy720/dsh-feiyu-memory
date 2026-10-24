import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore, DICTIONARY_V2, DICTIONARY_V3, DICTIONARY_V4 } from '../lib/store.js';

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-preinject-'));
  const clock = { now: '2026-10-19T12:00:00.000Z' }, stores = [];
  const open = () => { const store = new MemoryStore({ dataDir, instanceId: 'synthetic-preinject', now: () => new Date(clock.now) }); stores.push(store); return store; };
  t.after(() => { stores.forEach(store => store.close()); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { store: open(), open, clock, dataDir };
}
function turn(store, { sessionId = 'source', turnId = '1', start = '2026-10-18T00:00:00.000Z', messages = [{ role: 'user', texts: ['真人原话😀'] }, { role: 'assistant', texts: ['肥鱼原话🐟'] }], omittedNonText = false, index = true } = {}) {
  const captures = [], inputs = [];
  messages.forEach((message, position) => {
    const captureId = `${sessionId}-${turnId}-${position}`;
    const input = { id: captureId, pool: message.pool ?? 'a', role: message.role, records: message.texts.map((text, part) => ({ id: message.texts.length === 1 ? captureId : `${captureId}-part-${part}`, pool: message.pool ?? 'a', sessionId, turnId, role: message.role, text, sourceRoot: captureId, recordedAt: new Date(Date.parse(start) + (position + 1) * 1000).toISOString() })) };
    if (input.pool === 'b') input.records = [{ id: captureId, pool: 'b', sessionId, role: message.role, text: '', recordedAt: new Date(Date.parse(start) + (position + 1) * 1000).toISOString() }];
    store.captureMessage(input); inputs.push(input); captures.push({ id: captureId, role: message.role, seq: position + 1 });
  });
  const request = { sessionId, turnId, startedAt: start, completedAt: new Date(Date.parse(start) + (messages.length + 1) * 1000).toISOString(), startSeq: 0, endSeq: messages.length + 1, reason: 'completed', captures, omittedNonText, proof: 'live' };
  if (index) store.recordCompletedRound(request);
  return { request, inputs };
}
function select(store, values = {}) { return store.selectPreinject({ targetSessionId: 'recipient', firstTurnId: '1', asOf: store.now(), ...values }); }
function read(store, values = {}) { return store.readPreinject({ targetSessionId: 'recipient', turnId: '1', ...values }); }
function contents(store, tables) { return tables.map(table => store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()); }

test('completed rounds persist only exact ordered original references and accept non-text omission metadata', t => {
  const { store } = fixture(t);
  const { request } = turn(store, { messages: [{ role: 'user', texts: ['第一段', '第二段😀'] }, { role: 'assistant', texts: ['答复一', '答复二🐟'] }], omittedNonText: true });
  assert.equal(store.recordCompletedRound({ ...request, proof: 'verified_history' }).duplicate, true);
  const chosen = select(store); assert.equal(chosen.status, 'selected'); assert.equal(chosen.source.totalBlocks, 4);
  const snapshot = read(store);
  assert.equal(snapshot.status, 'ready'); assert.equal(snapshot.source.omittedNonText, true);
  assert.deepEqual(snapshot.blocks.map(block => block.text), ['第一段', '第二段😀', '答复一', '答复二🐟']);
  assert.deepEqual(snapshot.blocks.map(block => block.ordinal), [0, 1, 2, 3]);
  assert.equal(snapshot.omittedBlocks, 0);
  const metadata = JSON.stringify(contents(store, ['completed_rounds', 'completed_round_parts', 'preinject_choices']));
  assert.equal(metadata.includes('第二段'), false); assert.equal(metadata.includes('答复二'), false);
  for (const table of ['completed_rounds', 'completed_round_parts', 'preinject_choices']) assert.throws(() => store.db.exec(`DELETE FROM ${table}`), /immutable/);
});

test('raw user and assistant rows alone never imply successful completion; only committed A captures qualify', t => {
  const { store } = fixture(t);
  const { request } = turn(store, { index: false });
  assert.equal(store.listPreinjectCandidates().items.length, 1);
  assert.equal(select(store).status, 'none');
  for (const reason of ['aborted', 'error', 'interrupted', 'max-tokens', 'blocked']) assert.throws(() => store.recordCompletedRound({ ...request, reason }), /normal completed/);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM completed_rounds').get().n, 0);
  const b = turn(store, { sessionId: 'b', index: false, messages: [{ role: 'user', texts: [''], pool: 'b' }, { role: 'assistant', texts: [''], pool: 'b' }] });
  assert.throws(() => store.recordCompletedRound(b.request), /committed A/);
  const image = turn(store, { sessionId: 'image', index: false, messages: [{ role: 'user', texts: [] }, { role: 'assistant', texts: ['有助手文本'] }] });
  assert.throws(() => store.recordCompletedRound(image.request), /both human and assistant text/);
  const tool = turn(store, { sessionId: 'tool', index: false, messages: [{ role: 'user', texts: ['问题'] }, { role: 'tool', texts: ['工具结果'] }] });
  assert.throws(() => store.recordCompletedRound(tool.request), /allowed roles/);
});

test('capture verification is read-only, compares every exact part and cannot backfill missing history', t => {
  const { store } = fixture(t); const { inputs } = turn(store);
  const tables = ['raw', 'receipts', 'captures', 'completed_rounds', 'projection_pending']; const before = contents(store, tables);
  assert.equal(store.verifyCaptureMessage(inputs[0]), true);
  const changed = structuredClone(inputs[0]); changed.records[0].text += '改动';
  assert.equal(store.verifyCaptureMessage(changed), false);
  assert.equal(store.verifyCaptureMessage({ ...inputs[0], id: 'unknown', records: inputs[0].records.map(record => ({ ...record, id: 'unknown' })) }), false);
  assert.equal(store.verifyCaptureMessage({ ...inputs[0], records: [] }), false);
  assert.deepEqual(contents(store, tables), before);
  const multipart = turn(store, { sessionId: 'multipart', messages: [{ role: 'user', texts: ['a', 'b'] }, { role: 'assistant', texts: ['c'] }] });
  assert.equal(store.verifyCaptureMessage(multipart.inputs[0]), true);
  assert.equal(store.verifyCaptureMessage({ ...multipart.inputs[0], records: multipart.inputs[0].records.slice(1) }), false);
});

test('completed interval validation rejects reordered captures, mismatches and missing parts without partial receipts', t => {
  const { store } = fixture(t); const { request } = turn(store, { index: false });
  for (const variant of [
    { captures: [...request.captures].reverse() }, { captures: [...request.captures, request.captures[0]] },
    { sessionId: 'wrong' }, { turnId: '2' }, { completedAt: request.startedAt },
    { captures: [request.captures[0], { ...request.captures[1], seq: request.endSeq }] },
    { proof: 'inferred' }, { omittedNonText: 'yes' }, { startSeq: -1 }, { endSeq: 0 },
  ]) assert.throws(() => store.recordCompletedRound({ ...request, ...variant }));
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM completed_rounds').get().n, 0);
  store.recordCompletedRound(request);
  assert.throws(() => store.recordCompletedRound({ ...request, omittedNonText: true }), /different metadata/);
  assert.throws(() => store.recordCompletedRound({ ...request, endSeq: 9 }), /different metadata/);
});

test('one target freezes latest completed eligible source across repeated assembly, restart and another store handle', t => {
  const { store, open } = fixture(t);
  turn(store, { sessionId: 'older', start: '2026-10-17T00:00:00Z' });
  turn(store, { sessionId: 'latest', start: '2026-10-18T00:00:00Z' });
  turn(store, { sessionId: 'recipient', start: '2026-10-19T00:00:00Z' });
  const selected = select(store); assert.equal(selected.source.sessionId, 'latest');
  turn(store, { sessionId: 'newer', start: '2026-10-19T01:00:00Z' });
  const other = open(); const replay = select(other);
  assert.equal(replay.duplicate, true); assert.equal(replay.source.sessionId, 'latest');
  assert.equal(read(other).source.sessionId, 'latest');
  assert.equal(read(other, { turnId: '2' }), null);
  assert.equal(select(other, { firstTurnId: '2' }).firstTurnId, '1');
  store.close(); other.close(); assert.equal(read(open()).source.sessionId, 'latest');
});

test('explicit no-source choice stays empty even when history is later indexed', t => {
  const { store, open } = fixture(t);
  assert.equal(select(store).status, 'none');
  turn(store); assert.equal(select(store).status, 'none');
  assert.equal(read(store).status, 'none'); assert.deepEqual(read(store).blocks, []);
  store.close(); assert.equal(read(open()).status, 'none');
});

test('selection excludes already expired completed metadata in SQL rather than scanning all archived rounds', t => {
  const { store } = fixture(t);
  turn(store, { sessionId: 'expired-round-marker', start: '2020-01-01T00:00:00Z' });
  const parse = JSON.parse;
  const mock = t.mock.method(JSON, 'parse', (...args) => { assert.ok(!String(args[0]).includes('expired-round-marker'), 'expired completed metadata must be excluded before JS parsing'); return parse(...args); });
  try { assert.equal(select(store).status, 'none'); } finally { mock.mock.restore(); }
});

test('selection respects asOf and exact 168-hour age; due unreviewed raw cannot extend injection retention', t => {
  const { store, clock } = fixture(t);
  const { request } = turn(store, { start: '2026-10-12T11:59:59Z' });
  assert.equal(store.listRaw().length, 2);
  assert.equal(select(store).status, 'none', 'first raw reached 168h exactly');
  clock.now = '2026-10-19T11:59:59.999Z';
  assert.equal(select(store, { targetSessionId: 'one-ms-younger' }).status, 'selected');
  assert.equal(store.readPreinject({ targetSessionId: 'one-ms-younger', turnId: '1' }).status, 'ready');
  clock.now = '2026-10-19T12:00:00Z';
  assert.equal(store.readPreinject({ targetSessionId: 'one-ms-younger', turnId: '1' }).status, 'unavailable');
  assert.equal(select(store, { targetSessionId: 'before-end', asOf: request.startedAt }).status, 'none');
});

test('a single missing or retained-only original makes frozen selection unavailable without replacement or partial text', t => {
  const { store } = fixture(t); const { inputs, request } = turn(store);
  select(store);
  const rawId = inputs[0].records[0].id;
  store.reviewRetention({ ids: [rawId], decision: 'retain', reason: '保留引用测试原文。' });
  store.slide({ apply: true, days: 1 });
  assert.ok(store.getRaw(rawId)); assert.equal(store.verifyCaptureMessage(inputs[0]), false);
  assert.equal(read(store).status, 'unavailable'); assert.deepEqual(read(store).blocks, []);
  turn(store, { sessionId: 'replacement', start: '2026-10-19T01:00:00Z' });
  assert.equal(select(store).source.sessionId, 'source'); assert.equal(read(store).status, 'unavailable');
  assert.equal(store.recordCompletedRound(request).duplicate, true, 'historical receipt stays idempotent after retention');
  assert.equal(select(store, { targetSessionId: 'fresh' }).source.sessionId, 'replacement');
});

test('read budgets are Unicode codepoints and fairly retain both roles without inventing ellipses or splits', t => {
  const { store } = fixture(t);
  turn(store, { messages: [{ role: 'user', texts: ['😀'.repeat(100)] }, { role: 'assistant', texts: ['🐟'.repeat(100)] }] });
  select(store); const snapshot = read(store, { maxCodePoints: 7, maxBlocks: 2 });
  assert.equal(snapshot.blocks[0].originalCodePoints, 100); assert.equal(snapshot.blocks[1].originalCodePoints, 100);
  assert.equal([...snapshot.blocks[0].text].length, 4); assert.equal(snapshot.blocks[0].text.length, 8);
  assert.equal([...snapshot.blocks[1].text].length, 3); assert.equal(snapshot.blocks[1].text.length, 6);
  assert.ok(snapshot.blocks.every(block => block.textTruncated));
  assert.equal(snapshot.blocks.some(block => block.text.includes('…')), false);
  assert.equal(read(store, { maxCodePoints: 2 }).blocks.every(block => [...block.text].length === 1), true);
});

test('block cap preserves first user and last assistant then fills in chronological order with explicit omissions', t => {
  const { store } = fixture(t);
  const messages = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', texts: [`消息${i}`] }));
  turn(store, { messages }); select(store);
  const snapshot = read(store, { maxBlocks: 3 });
  assert.deepEqual(snapshot.blocks.map(block => block.ordinal), [0, 1, 9]);
  assert.equal(snapshot.omittedBlocks, 7); assert.equal(snapshot.source.totalBlocks, 10);
  assert.ok(snapshot.blocks.every(block => !block.textTruncated));
  const tiny = read(store, { maxBlocks: 3, maxCodePoints: 2 });
  assert.equal(tiny.blocks.find(block => block.ordinal === 0).text, '消');
  assert.equal(tiny.blocks.find(block => block.ordinal === 9).text, '消');
  assert.equal(tiny.blocks.find(block => block.ordinal === 1).text, '');
});

test('missing multipart raw and oversized capture metadata never create a completed receipt', t => {
  const { store } = fixture(t);
  const { request, inputs } = turn(store, { index: false, messages: [{ role: 'user', texts: ['一段', '二段'] }, { role: 'assistant', texts: ['回复'] }] });
  store.reviewRetention({ ids: [inputs[0].records[1].id], decision: 'retain', reason: '移出活动池但保存证据。' });
  store.slide({ apply: true, days: 1 });
  assert.ok(store.getRaw(inputs[0].records[1].id));
  assert.equal(store.verifyCaptureMessage(inputs[0]), false);
  assert.throws(() => store.recordCompletedRound(request), /missing or mismatched/);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM completed_rounds').get().n, 0);
  assert.throws(() => store.recordCompletedRound({ ...request, captures: Array.from({ length: 4097 }, () => request.captures[0]) }), /2\.\.4096/);
  const other = turn(store, { sessionId: 'oversized', index: false });
  store.db.prepare('UPDATE captures SET json=? WHERE id=?').run(JSON.stringify({ partIds: Array.from({ length: 4097 }, (_, i) => `synthetic-${i}`) }), other.inputs[0].id);
  assert.throws(() => store.recordCompletedRound(other.request), /4096 original-block/);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM completed_rounds').get().n, 0);
});

test('large body lookup remains SQL-bounded and candidates never load original bodies into JavaScript', t => {
  const { store } = fixture(t);
  const marker = 'SYNTHETIC_LARGE_BODY';
  const { request } = turn(store, { index: false, messages: [{ role: 'user', texts: [marker.repeat(40000)] }, { role: 'assistant', texts: [marker.repeat(40000)] }] });
  const parse = JSON.parse;
  const mock = t.mock.method(JSON, 'parse', (...args) => { assert.ok(!String(args[0]).includes(marker), 'raw body must not be deserialized'); return parse(...args); });
  try {
    const candidates = store.listPreinjectCandidates({ limit: 1 });
    assert.equal(candidates.items[0].totalBlocks, 2); assert.equal(JSON.stringify(candidates).includes(marker), false);
    store.recordCompletedRound(request); select(store);
    const snapshot = read(store, { maxCodePoints: 8 });
    assert.equal(snapshot.blocks.reduce((n, block) => n + [...block.text].length, 0), 8);
  } finally { mock.mock.restore(); }
});

test('completion and selection failures roll back their whole metadata transactions and permit retry', t => {
  const { store } = fixture(t); const { request } = turn(store, { index: false });
  store.db.exec("CREATE TRIGGER fail_parts BEFORE INSERT ON completed_round_parts WHEN NEW.ordinal=1 BEGIN SELECT RAISE(ABORT,'synthetic part failure'); END;");
  assert.throws(() => store.recordCompletedRound(request), /synthetic part failure/);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM completed_rounds').get().n, 0);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM completed_round_parts').get().n, 0);
  store.db.exec('DROP TRIGGER fail_parts'); store.recordCompletedRound(request);
  store.db.exec("CREATE TRIGGER fail_selection BEFORE INSERT ON preinject_choices BEGIN SELECT RAISE(ABORT,'synthetic choice failure'); END;");
  assert.throws(() => select(store), /synthetic choice failure/);
  assert.equal(read(store), null); store.db.exec('DROP TRIGGER fail_selection');
  assert.equal(select(store).status, 'selected');
});

test('candidate discovery is bounded, excludes target/B/null-turn and preserves complete grouping metadata', t => {
  const { store } = fixture(t);
  turn(store, { sessionId: 'one', index: false }); turn(store, { sessionId: 'two', start: '2026-10-19T00:00:00Z', index: false });
  store.appendRaw({ id: 'missing-turn', pool: 'a', role: 'user', sessionId: 'legacy', text: '无轮次不能推断' });
  store.appendRaw({ id: 'solitude', pool: 'b', role: 'assistant', sessionId: 'private', text: '不得持久化' });
  const candidates = store.listPreinjectCandidates({ limit: 1 });
  assert.equal(candidates.items[0].sessionId, 'two'); assert.equal(candidates.hasMore, true);
  assert.equal(candidates.items[0].captureIds.length, 2); assert.equal(candidates.items[0].rawIds.length, 2);
  assert.equal(store.listPreinjectCandidates({ excludeSessionId: 'two' }).items[0].sessionId, 'one');
  for (const options of [{ limit: 0 }, { limit: 129 }, { asOf: 'today' }]) assert.throws(() => store.listPreinjectCandidates(options));
  for (const options of [{ maxCodePoints: 1 }, { maxCodePoints: 32001 }, { maxBlocks: 1 }, { maxBlocks: 257 }]) assert.throws(() => read(store, options));
});

test('schema6 migration preserves reference tables and all canonical payloads and v1/v2/v3/v4 bytes', t => {
  const { store, open, dataDir } = fixture(t); turn(store, { index: false });
  store.writeEntry({ id: 'legacy', kind: 'memory', text: '旧记忆', sources: [] });
  const tables = ['raw', 'receipts', 'captures', 'entries', 'evidence']; const before = contents(store, tables);
  const dictionaries = ['v1', 'v2', 'v3'].map(version => fs.readFileSync(path.join(dataDir, `dict/${version}.md`), 'utf8'));
  store.db.prepare("UPDATE meta SET value=json_set(value,'$.schema',4) WHERE key='identity'").run(); store.close();
  const reopened = open(); assert.equal(reopened.metadata().schema, 7); assert.deepEqual(contents(reopened, tables), before);
  assert.deepEqual(['v1', 'v2', 'v3'].map(version => fs.readFileSync(path.join(dataDir, `dict/${version}.md`), 'utf8')), dictionaries);
  assert.equal(dictionaries[1], DICTIONARY_V2); assert.equal(dictionaries[2], DICTIONARY_V3);
  assert.equal(fs.readFileSync(path.join(dataDir, 'dict/v4.md'), 'utf8'), DICTIONARY_V4);
  assert.equal(reopened.writeEntry({ id: 'new', kind: 'memory', text: '新记忆', sources: [] }).dictVersion, 'v6');
  assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM completed_rounds').get().n, 0, 'migration does not infer completion');
  assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM preinject_choices').get().n, 0);
});
