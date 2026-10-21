import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryStore } from '../lib/store.js';
import { createTools } from '../lib/tools.js';
import { buildCoreData, buildPreferenceData, buildRecentTurnData } from '../lib/lifecycle.js';
import { presentMemoryTimes } from '../lib/time-display.js';

const UTC = '2026-10-21T21:00:00.123Z';
const LOCAL = '2026-10-22T05:00:00.123+08:00';
const ZONE = 'Asia/Shanghai';
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/u;

// These three fields belong only to the host's private indexing/selection work;
// source() and buildRecentTurnData intentionally do not expose them to a model.
// Exceptions are file-scoped: reusing a name in a new output module must fail.
const INTERNAL = new Map([['preinject.js', new Set(['indexedAt', 'earliestRecordedAt', 'latestRecordedAt'])]]);

function metadataNames(source) {
  // Also catches quoted key lists, JSON paths and SQL `AS ...At` aliases.
  // This is a conservative naming-convention guard, not a JavaScript parser.
  return new Set([...source.matchAll(/\b(?:[a-z][A-Za-z0-9]*At|asOf)\b(?!\s*\()/gu)].map(match => match[0]));
}

function modelSourceFiles() {
  const files = new Map();
  function visit(url) {
    if (basename(fileURLToPath(url)) === 'time-display.js' || files.has(url.href)) return;
    const source = readFileSync(url, 'utf8');
    files.set(url.href, source);
    for (const match of source.matchAll(/\bfrom\s+['"](\.\.?\/[^'"]+\.js)['"]/gu)) visit(new URL(match[1], url));
  }
  // Store is injected into tools, so it is an explicit root alongside builders.
  for (const name of ['tools', 'lifecycle', 'store']) visit(new URL(`../lib/${name}.js`, import.meta.url));
  return files;
}

test('timestamp whitelist covers independently discovered model metadata names, including SQL aliases', () => {
  const names = new Set();
  const locations = new Map();
  for (const [url, source] of modelSourceFiles()) {
    const file = basename(fileURLToPath(url));
    const found = metadataNames(source);
    for (const exception of INTERNAL.get(file) ?? []) assert.ok(found.has(exception), `Remove stale internal exception: ${file}:${exception}`);
    if (file === 'preinject.js') {
      const occurrences = name => source.split('\n').filter(line => new RegExp(`\\b${name}\\b`, 'u').test(line));
      assert.equal(occurrences('indexedAt').length, 2, 'Re-audit indexedAt if it acquires another use');
      assert.ok(occurrences('indexedAt').every(line => /const \{ proof, totalBlocks, indexedAt, \.\.\.oldIdentity \} = old;|const record = \{ \.\.\.identity, proof: input\.proof, totalBlocks: parts\.length, indexedAt: store\.now\(\) \};/u.test(line)), 'indexedAt must remain private stored index metadata');
      for (const name of ['earliestRecordedAt', 'latestRecordedAt']) {
        assert.equal(occurrences(name).length, 1, `Re-audit any new use of ${name}`);
        assert.match(occurrences(name)[0], /const groups = store\.db\.prepare\(.+min\(.+ AS earliestRecordedAt,max\(.+ AS latestRecordedAt.+ GROUP BY sessionId,turnId ORDER BY latestRecordedAt/u);
      }
    }
    for (const name of found) {
      if (INTERNAL.get(file)?.has(name)) continue;
      names.add(name);
      locations.set(name, `${locations.get(name) ?? ''} ${file}`.trim());
    }
  }
  assert.ok(names.size >= 15, 'The source inventory must not silently become empty or narrow');
  // Never read/export/copy TIME_FIELDS: production output declarations provide
  // the independent inventory. A new fooAt field fails until explicitly handled.
  const input = Object.fromEntries([...names].map(name => [name, UTC]));
  const output = presentMemoryTimes(input, ZONE);
  const missing = [...names].filter(name => output[name] !== LOCAL);
  assert.deepEqual(missing.map(name => `${name} (${locations.get(name)})`), [], 'Unconverted model metadata; update time-display or document a genuinely private field');
  assert.deepEqual(input, Object.fromEntries([...names].map(name => [name, UTC])));
  // Verify that both future object fields and SQL-only aliases enter the guard.
  assert.deepEqual([...metadataNames('return { confirmedAt: now }; SELECT completed_at AS deliveredAt;')], ['confirmedAt', 'deliveredAt']);
  assert.equal(presentMemoryTimes({ confirmedAt: UTC }, ZONE).confirmedAt, UTC, 'An unknown field must actually be detectable as an uncovered field');
});

// Literal content and executable read arguments must remain verbatim. Unlike
// the production whitelist, the walker recognizes ANY ISO-valued metadata leaf,
// so it can catch a new name that does not follow the *At naming convention.
const LITERAL = new Set(['body', 'text', 'textPreview', 'snippet', 'quote', 'quotePreview', 'read', 'continueRead', 'lookup', 'arguments']);
function assertLocalMetadata(value, path = '$', seen = new Set()) {
  if (!value || typeof value !== 'object') return seen;
  for (const [key, item] of Object.entries(value)) {
    if (LITERAL.has(key)) continue;
    const here = `${path}.${key}`;
    if (typeof item === 'string' && ISO.test(item)) {
      assert.match(item, /\+08:00$/u, `${here} leaked a UTC/nonlocal timestamp: ${item}`);
      seen.add(key === '0' && path.endsWith('.mentionedTimes') ? 'mentionedTimes' : key);
    } else if (item && typeof item === 'object') assertLocalMetadata(item, here, seen);
  }
  return seen;
}

test('real pool tools, decision histories and injections contain no unconverted timestamp metadata', t => {
  const root = mkdtempSync(join(tmpdir(), 'feiyu-time-field-coverage-'));
  const store = new MemoryStore({ dataDir: root, instanceId: 'time-coverage', timezone: ZONE, now: () => UTC });
  t.after(() => { store.close(); assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  const tools = createTools(store), outputs = [];
  const call = (name, args) => { const result = tools[name](args); outputs.push([name, result]); return result; };
  const source = { rawId: 'old', quote: UTC, support: 'supports' };
  store.appendRaw({ id: 'old', sessionId: 'old-session', pool: 'a', role: 'user', text: UTC, recordedAt: '2026-09-10T21:00:00.123Z', occurredAt: '2026-09-09T21:00:00.123Z' });
  call('memory_review_queue', {});
  call('memory_review_request', { requestId: 'early', rawIds: ['old'], reason: 'Synthetic evidence' });
  call('memory_review', { action: 'submit', requestId: 'review', rawIds: ['old'], reason: 'Synthetic review', entries: [{ id: 'reviewed', kind: 'memory', text: UTC, statementType: 'self_report', sources: [source] }] });
  call('memory_write', { id: 'parent', kind: 'memory', text: UTC, statementType: 'self_report', sources: [source], recordedAt: '2026-09-10T21:00:00.123Z' });
  const body = { time: UTC, persons: ['synthetic-user'], event: UTC };
  call('memory_a3_write', { requestId: 'archive', id: 'archive', expectedVersion: 0, action: 'write', reason: 'Synthetic archive', statementType: 'self_report', body, derivedFrom: ['parent'], coverage: { scope: [{ id: 'parent', version: 1 }], covered: ['parent'], notCovered: [], scopeNote: 'Synthetic single parent' } });
  call('memory_a2_review_queue', {});
  call('memory_a2_review', { requestId: 'retire-review', reason: 'Archived', items: [{ id: 'parent', version: 1, decision: 'archived', a3Ids: ['archive'], reason: 'Covered' }] });
  call('memory_a2_cleanup', { apply: true });
  call('memory_b2_write', { requestId: 'surf', id: 'surf', expectedVersion: 0, action: 'write', text: UTC, judgment: 'Synthetic discovery', reason: 'Synthetic source', sources: [{ url: 'https://example.org/', title: 'Synthetic', accessedAt: UTC }] });
  call('memory_preference', { requestId: 'like', id: 'like', expectedVersion: 0, action: 'set', topic: 'time', stance: 'like', text: UTC, reason: 'Synthetic preference' });
  call('memory_core_write', { requestId: 'person', id: 'person', expectedVersion: 0, kind: 'entity', category: 'identity', text: 'Synthetic person', statementType: 'fact', reason: 'Synthetic entity', sources: [source] });
  call('memory_core_write', { requestId: 'edge', id: 'edge', expectedVersion: 0, kind: 'relation', category: 'relationship', from: 'self', to: 'person', rel: 'friend', text: 'Synthetic relationship', statementType: 'fact', reason: 'Synthetic edge', sources: [source] });
  call('memory_graph', { center: 'self' });
  call('memory_correct', { requestId: 'correct', targets: [{ id: 'reviewed', version: 1 }], status: 'needs_review', reason: 'Synthetic recheck', sources: [source] });
  call('memory_review', { action: 'history', limit: 100 });
  for (const id of ['old', 'reviewed', 'parent', 'surf', 'like', 'person', 'edge']) call('memory_read', { id });
  const archive = call('memory_a3_read', { id: 'archive' });
  assert.deepEqual(archive.body, body, 'A3 time/person/event text is literal content');
  assert.equal(call('memory_read', { id: 'old' }).text, UTC, 'A1 original text remains UTC literally');
  call('memory_list', { timeWindow: { preset: 'recent_7_days' } });

  const captures = [];
  for (const [i, role] of ['user', 'assistant'].entries()) {
    const id = `capture-${role}`;
    store.captureMessage({ id, role, pool: 'a', records: [{ id, sessionId: 'source', turnId: 'turn', sourceRoot: id, role, pool: 'a', text: UTC, recordedAt: `2026-10-21T20:59:0${i + 1}.123Z` }] });
    captures.push({ id, role, seq: i + 1 });
  }
  store.recordCompletedRound({ sessionId: 'source', turnId: 'turn', startSeq: 0, endSeq: 3, startedAt: '2026-10-21T20:59:00.123Z', completedAt: '2026-10-21T20:59:03.123Z', reason: 'completed', proof: 'live', captures });
  store.selectPreinject({ targetSessionId: 'target', firstTurnId: 'first' });
  const parseData = text => JSON.parse(text.slice(text.indexOf('\n') + 1));
  outputs.push(['C injection', parseData(buildCoreData(store, { maxChars: 8000 }))]);
  outputs.push(['B3 injection', parseData(buildPreferenceData(store, { maxChars: 8000 }))]);
  const recent = parseData(buildRecentTurnData(store.readPreinject({ targetSessionId: 'target', turnId: 'first' }), { timezone: ZONE }));
  outputs.push(['A1 injection', recent]);
  assert.equal(recent.blocks[0].text, UTC);

  const seen = new Set(), failures = [];
  for (const [name, result] of outputs) {
    assert.equal(result.timeZone, ZONE, name);
    try { assertLocalMetadata(result, name, seen); }
    catch (error) { failures.push(error.message); }
  }
  assert.deepEqual(failures, [], 'Unconverted model-facing metadata across the exercised routes');
  for (const name of ['recordedAt', 'occurredAt', 'createdAt', 'expiresAt', 'accessedAt', 'asOf', 'dueAt', 'reviewedAt', 'requestedAt', 'retiredAt', 'decidedAt', 'selectedAt', 'startedAt', 'completedAt', 'mentionedTimes', 'start', 'endExclusive', 'since']) {
    assert.ok(seen.has(name), `Fixture must exercise ${name}, not pass vacuously`);
  }
  assert.throws(() => assertLocalMetadata({ nested: { newTimestamp: UTC } }), /newTimestamp leaked/u, 'Unknown names are caught without consulting TIME_FIELDS');
  assert.equal(store.getRaw('old').recordedAt, '2026-09-10T21:00:00.123Z', 'Stored evidence remains UTC');
});
