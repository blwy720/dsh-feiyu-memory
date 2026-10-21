import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMemoryTime, presentMemoryTimes } from '../lib/time-display.js';

test('local display crosses Shanghai midnight with precise milliseconds and explicit offset', () => {
  for (const [input, expected] of [
    ['2026-10-21T15:59:59.999Z', '2026-10-21T23:59:59.999+08:00'],
    ['2026-10-21T16:00:00.000Z', '2026-10-22T00:00:00.000+08:00'],
    ['2026-10-21T16:00:00.123Z', '2026-10-22T00:00:00.123+08:00'],
    ['2026-10-22T00:00:00.1+08:00', '2026-10-22T00:00:00.100+08:00'],
    ['2026-10-21T12:00:00-04:00', '2026-10-22T00:00:00.000+08:00'],
  ]) {
    assert.equal(formatMemoryTime(input), expected);
    assert.equal(Date.parse(formatMemoryTime(input)), Date.parse(input));
  }
  assert.equal(formatMemoryTime('2026-10-21T16:00:00.123Z', 'UTC'), '2026-10-21T16:00:00.123+00:00');
  assert.equal(formatMemoryTime('2026-10-21T16:00:00Z', 'Asia/Kathmandu'), '2026-10-21T21:45:00.000+05:45');
});

test('DST offsets come from each historical instant, including repeated fall-back hours', () => {
  const first = formatMemoryTime('2026-11-01T05:30:00.001Z', 'America/New_York');
  const second = formatMemoryTime('2026-11-01T06:30:00.001Z', 'America/New_York');
  assert.equal(first, '2026-11-01T01:30:00.001-04:00');
  assert.equal(second, '2026-11-01T01:30:00.001-05:00');
  assert.equal(Date.parse(second) - Date.parse(first), 3600000);
  assert.equal(formatMemoryTime('2026-03-08T06:59:59.999Z', 'America/New_York'), '2026-03-08T01:59:59.999-05:00');
  assert.equal(formatMemoryTime('2026-03-08T07:00:00.000Z', 'America/New_York'), '2026-03-08T03:00:00.000-04:00');
});

test('unknown, incomplete, invalid and higher-precision values remain unchanged', () => {
  for (const value of [null, undefined, '', '未知', '2026-10-21', '2026-10-21T12:00:00',
    '2026-02-30T00:00:00Z', '2026-02-29T00:00:00Z', '2026-00-01T00:00:00Z',
    '2026-10-21T24:00:00Z', '2026-10-21T00:60:00Z', '2026-10-21T00:00:60Z',
    '2026-10-21T00:00:00+24:00', '2026-10-21T00:00:00+01:60',
    '2026-10-21T00:00:00.123456Z', 1792598400000]) assert.equal(formatMemoryTime(value), value);
  assert.equal(formatMemoryTime('2024-02-29T00:00:00Z'), '2024-02-29T08:00:00.000+08:00');
  assert.equal(formatMemoryTime('1900-01-01T00:00:00Z'), '1900-01-01T00:00:00Z', 'historic second-level offsets must not lose the exact instant');
  assert.throws(() => formatMemoryTime(null, 'Not/A_Timezone'), /timeZone/);
  assert.throws(() => presentMemoryTimes({}, ''), /timeZone/);
});

test('presentation deep-copies metadata while preserving literal text, parameters and unknown fields', () => {
  const stamp = '2026-10-21T16:00:00.123Z';
  const source = {
    recordedAt: stamp, occurredAt: null, text: `原文 ${stamp}`, quote: stamp, snippet: stamp, id: stamp, hash: stamp,
    arbitraryTime: stamp, body: { time: stamp, recordedAt: stamp },
    read: { arguments: { recordedAt: stamp, from: stamp } }, continueRead: { selectedAt: stamp },
    lookup: { recordedAt: stamp }, arguments: { recordedAt: stamp },
    sourceTimes: [{ rawId: stamp, recordedAt: stamp, occurredAt: stamp }],
    mentionedTimes: [stamp, '未知'], correctness: { events: [{ decidedAt: stamp }] },
    item: { dueAt: stamp, requestedAt: stamp, reviewedAt: stamp, clearedAt: stamp, asOf: stamp },
  };
  const before = structuredClone(source), output = presentMemoryTimes(source);
  assert.deepEqual(source, before);
  assert.equal(output.timeZone, 'Asia/Shanghai');
  assert.equal(output.recordedAt, '2026-10-22T00:00:00.123+08:00');
  assert.equal(output.occurredAt, null);
  assert.equal(output.sourceTimes[0].recordedAt, output.recordedAt);
  assert.deepEqual(output.mentionedTimes, [output.recordedAt, '未知']);
  assert.equal(output.correctness.events[0].decidedAt, output.recordedAt);
  for (const field of Object.keys(source.item)) assert.equal(output.item[field], output.recordedAt);
  for (const field of ['text', 'quote', 'snippet', 'id', 'hash', 'arbitraryTime', 'body', 'read', 'continueRead', 'lookup', 'arguments']) assert.deepEqual(output[field], source[field]);
  assert.notEqual(output.body, source.body);
  assert.notEqual(output.read.arguments, source.read.arguments);
  output.sourceTimes[0].recordedAt = 'changed';
  output.read.arguments.from = 'changed';
  assert.deepEqual(source, before);
});

test('query range timestamps use their explicit query timezone without changing the request', () => {
  const input = { recordedAt: '2026-11-01T05:30:00Z', resolvedTime: {
    timeZone: 'America/New_York', start: '2026-11-01T05:30:00Z', endExclusive: '2026-11-01T06:30:00Z',
    asOf: '2026-11-01T06:30:00Z', inputFrom: '2026-11-01T05:30:00Z', inputTo: '2026-11-01',
  }, another: { start: '2026-11-01T05:30:00Z' } };
  const output = presentMemoryTimes(input);
  assert.equal(output.recordedAt, '2026-11-01T13:30:00.000+08:00');
  assert.equal(output.resolvedTime.start, '2026-11-01T01:30:00.000-04:00');
  assert.equal(output.resolvedTime.endExclusive, '2026-11-01T01:30:00.000-05:00');
  assert.equal(output.resolvedTime.asOf, output.resolvedTime.endExclusive);
  assert.equal(output.resolvedTime.timeZone, 'America/New_York');
  assert.equal(output.resolvedTime.inputFrom, input.resolvedTime.inputFrom);
  assert.deepEqual(output.another, input.another);
});

test('arrays and primitives preserve their result shape and existing timeZone values survive', () => {
  const input = [{ recordedAt: '2026-10-21T16:00:00Z' }];
  const output = presentMemoryTimes(input);
  assert.ok(Array.isArray(output));
  assert.equal(Object.hasOwn(output, 'timeZone'), false);
  assert.equal(output[0].recordedAt, '2026-10-22T00:00:00.000+08:00');
  assert.equal(Object.hasOwn(output[0], 'timeZone'), false);
  assert.deepEqual(presentMemoryTimes({ timeZone: 'UTC', date: '2026-10-21' }), { timeZone: 'UTC', date: '2026-10-21' });
  for (const value of [null, undefined, '2026-10-21T00:00:00Z', 123, true]) assert.equal(presentMemoryTimes(value), value);
  const invalidMetadata = { recordedAt: { original: 'unknown' } };
  const copiedInvalid = presentMemoryTimes(invalidMetadata);
  assert.deepEqual(copiedInvalid.recordedAt, invalidMetadata.recordedAt);
  assert.notEqual(copiedInvalid.recordedAt, invalidMetadata.recordedAt);
});
