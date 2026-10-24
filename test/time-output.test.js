import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { MemoryStore } from '../lib/store.js';
import { createTools } from '../lib/tools.js';
import { generateDay, buildPreferenceData } from '../lib/lifecycle.js';

function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'feiyu-time-output-'));
  const store = new MemoryStore({ dataDir, instanceId: 'time-output', timezone: 'Asia/Shanghai', now: () => '2026-10-21T16:05:00.123Z' });
  t.after(() => { store.close(); assert.equal(dirname(resolve(dataDir)), resolve(tmpdir())); rmSync(dataDir, { recursive: true, force: true }); });
  return { store, tools: createTools(store) };
}

test('model reads and search use local midnight while stored originals and literal timestamps remain exact', t => {
  const { store, tools } = fixture(t);
  const text = '原文说 2026-10-21T16:05:00.123Z；不得改写这句话。😀';
  store.appendRaw({ id: 'midnight', sessionId: 'session', role: 'user', pool: 'a', text });
  const before = store.getRaw('midnight');
  const page = tools.memory_read({ id: 'midnight' });
  assert.equal(page.timeZone, 'Asia/Shanghai');
  assert.equal(page.recordedAt, '2026-10-22T00:05:00.123+08:00');
  assert.equal(Date.parse(page.recordedAt), Date.parse(before.recordedAt));
  assert.equal(page.text, text);
  const nextDay = tools.memory_search({ q: '原文', pool: 'a1', date: '2026-10-22' });
  assert.equal(nextDay.candidates.length, 1);
  assert.equal(nextDay.candidates[0].recordedAt, page.recordedAt);
  assert.equal(nextDay.resolvedTime.start, '2026-10-22T00:00:00.000+08:00');
  assert.equal(tools.memory_search({ q: '原文', pool: 'a1', date: '2026-10-21' }).candidates.length, 0);
  assert.deepEqual(store.getRaw('midnight'), before);
  assert.equal(before.recordedAt, '2026-10-21T16:05:00.123Z');
});

test('review queues and day projections convert metadata but never convert quoted original text', t => {
  const { store, tools } = fixture(t);
  store.appendRaw({ id: 'old', sessionId: 'session', role: 'assistant', pool: 'a', text: '我在 2026-10-13T16:05:00.123Z 说过这句话。', recordedAt: '2026-10-13T16:05:00.123Z' });
  const queue = tools.memory_review_queue({ limit: 20 });
  const item = queue.items.find(item => item.rawId === 'old');
  assert.ok(item);
  assert.equal(item.recordedAt, '2026-10-14T00:05:00.123+08:00');
  assert.equal(item.dueAt, '2026-10-21T00:05:00.123+08:00');
  const day = readFileSync(generateDay(store, '2026-10-14').path, 'utf8');
  assert.match(day, /记录 "2026-10-14T00:05:00\.123\+08:00"/);
  assert.match(day, /2026-10-13T16:05:00\.123Z/);
  assert.equal(store.getRaw('old').recordedAt, '2026-10-13T16:05:00.123Z');
});

test('compact B3 self-report time is local, with unchanged declaration and persisted decision metadata', t => {
  const { store, tools } = fixture(t);
  const input = { id: 'like-night', action: 'set', topic: '夜晚', stance: 'like', text: '我喜欢夜晚，尤其原文写的 16:05Z。', reason: '我的自述' };
  // Use the existing preference action schema, including its normal attribution.
  tools.memory_preference({ ...input, requestId: 'like-night-request', expectedVersion: 0, subject: 'self' });
  const before = store.getEntry('like-night');
  const rendered = buildPreferenceData(store, { maxChars: 8000 });
  const payload = JSON.parse(rendered.slice(rendered.indexOf('\n') + 1));
  assert.equal(payload.timeZone, 'Asia/Shanghai');
  assert.equal(payload.items[0].recordedAt, '2026-10-22T00:05:00.123+08:00');
  assert.equal(payload.items[0].decision, undefined, 'detailed decision is read on demand');
  assert.equal(payload.items[0].text, input.text);
  assert.deepEqual(store.getEntry('like-night'), before);
});
