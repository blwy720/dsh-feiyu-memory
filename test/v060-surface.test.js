import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolSurface, MEMORY_TOOLS_SCHEMA } from '../lib/tool-surface.js';

const schema = { type: 'object', properties: {}, required: [] };
const names = ['memory_search', 'memory_fetch', 'memory_prepare', 'memory_manage', 'memory_review', 'memory_write', 'memory_read', 'memory_correct'];
function fixture(options = {}) {
  const active = new Map([['other_plugin', 'untouched']]); const registrations = [], disposed = [];
  const schemas = Object.fromEntries(names.map(name => [name, structuredClone(schema)]));
  const register = (name, value, description) => {
    options.beforeRegister?.(name);
    assert.equal(active.has(name), false, `duplicate registration ${name}`);
    active.set(name, { value, description }); registrations.push(name);
    return () => { options.beforeDispose?.(name); disposed.push(name); active.delete(name); };
  };
  const surface = createToolSurface({ mode: options.mode ?? 'compact', schemas, descriptions: { memory_write: '写入记忆，保留来源。' }, register });
  return { surface, active, registrations, disposed, schemas };
}

test('compact starts six tools, discovers a short catalog, and enables old tools only on explicit request', () => {
  const { surface, active, registrations } = fixture();
  assert.equal(surface.catalog().state, 'not_started');
  assert.throws(() => surface.enable(['memory_write']), /start/);
  surface.start();
  assert.equal(registrations.length, 6);
  assert.equal(active.has('memory_tools'), true);
  assert.equal(active.has('memory_write'), false);
  const catalog = surface.enable();
  assert.ok(catalog.available.some(item => item.name === 'memory_write' && !item.enabled));
  const result = surface.enable(['memory_write', 'memory_write']);
  assert.deepEqual(result.added, ['memory_write']);
  assert.equal(active.has('memory_write'), true);
  assert.deepEqual(surface.enable(['memory_write']).alreadyEnabled, ['memory_write']);
  surface.start(); assert.equal(registrations.length, 7);
  surface.close(); assert.deepEqual([...active], [['other_plugin', 'untouched']]);
});

test('compatible starts all supplied legacy schemas without automatically registering discovery', () => {
  const { surface, registrations, active } = fixture({ mode: 'compatible' });
  surface.start();
  assert.deepEqual(registrations, names);
  assert.equal(active.has('memory_tools'), false);
  surface.enable(['memory_tools']);
  assert.equal(active.has('memory_tools'), true);
  surface.close();
});

test('all names are validated before registering any and injected schemas cannot expand the captured whitelist', () => {
  const { surface, active, schemas, registrations } = fixture();
  surface.start(); schemas.memory_foreign = schema;
  assert.throws(() => surface.enable(['memory_write', 'foreign_delete']), /白名单/);
  assert.equal(active.has('memory_write'), false);
  assert.throws(() => surface.enable(['memory_foreign']), /白名单/);
  assert.throws(() => surface.enable(['__proto__']), /白名单/);
  assert.throws(() => surface.enable('memory_write'), /数组/);
  assert.equal(registrations.length, 6);
  surface.close();
});

test('failed enabling rolls back only newly registered tools, leaving previously enabled and other plugins untouched', () => {
  let fail = true;
  const { surface, active, disposed } = fixture({ beforeRegister: name => { if (fail && name === 'memory_correct') throw new Error('registration failed'); } });
  surface.start(); surface.enable(['memory_read']);
  assert.throws(() => surface.enable(['memory_write', 'memory_correct']), /registration failed/);
  assert.deepEqual(disposed, ['memory_write']);
  assert.equal(active.has('memory_read'), true);
  assert.equal(active.has('memory_search'), true);
  assert.equal(active.get('other_plugin'), 'untouched');
  fail = false; surface.enable(['memory_write', 'memory_correct']);
  surface.close(); assert.deepEqual([...active], [['other_plugin', 'untouched']]);
});

test('failed initial registration cleans up and can restart without duplicate registrations', () => {
  let fail = true;
  const { surface, active } = fixture({ beforeRegister: name => { if (fail && name === 'memory_prepare') throw new Error('start failure'); } });
  assert.throws(() => surface.start(), /start failure/);
  assert.equal(surface.catalog().state, 'not_started');
  assert.deepEqual([...active], [['other_plugin', 'untouched']]);
  fail = false; surface.start(); assert.equal(surface.catalog().enabled.length, 6);
  surface.close();
});

test('close attempts every owned disposer, preserves failures for retry, and cannot disable another surface', () => {
  let fail = true;
  const { surface, active, disposed } = fixture({ beforeDispose: name => { if (fail && name === 'memory_fetch') throw new Error('dispose failure'); } });
  surface.start();
  assert.throws(() => surface.close(), AggregateError);
  assert.deepEqual(surface.catalog().enabled, ['memory_fetch']);
  assert.equal(surface.catalog().state, 'closing');
  assert.equal(disposed.length, 5);
  assert.equal(active.get('other_plugin'), 'untouched');
  assert.throws(() => surface.enable(['memory_write']), /停止/);
  fail = false; surface.close(); surface.close();
  assert.equal(surface.catalog().state, 'closed');
  assert.deepEqual([...active], [['other_plugin', 'untouched']]);
});

test('registration failure with a failing rollback exposes cleanup failure and remains closable', () => {
  let failDispose = true;
  const { surface, active } = fixture({
    beforeRegister: name => { if (name === 'memory_correct') throw new Error('register failed'); },
    beforeDispose: name => { if (failDispose && name === 'memory_write') throw new Error('rollback failed'); },
  });
  surface.start();
  assert.throws(() => surface.enable(['memory_write', 'memory_correct']), error => error instanceof AggregateError && error.errors.length === 2);
  assert.equal(surface.catalog().enabled.includes('memory_write'), true);
  failDispose = false; surface.close();
  assert.deepEqual([...active], [['other_plugin', 'untouched']]);
});

test('schema copies are isolated and invalid surfaces fail before registration', () => {
  const { surface, active } = fixture(); surface.start();
  active.get('memory_tools').value.properties.names.description = 'changed locally';
  assert.notEqual(MEMORY_TOOLS_SCHEMA.properties.names.description, 'changed locally');
  surface.close();
  assert.throws(() => createToolSurface({ mode: 'unknown', schemas: {}, register() {} }), /toolMode/);
  assert.throws(() => createToolSurface({ mode: 'compact', schemas: { memory_read: schema }, register() {} }), /缺少基础工具/);
  assert.throws(() => createToolSurface({ schemas: { other_plugin: schema }, register() {} }), /白名单/);
});
