import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactText } from '../lib/redaction.js';
import { MemoryStore } from '../lib/store.js';

test('credentials are removed before clipping without logging their values', () => {
  const secret = 'sk-' + 'veryprivatevalue'.repeat(4);
  const original = `用户说已接通 API；api_key=${secret}，下次仍需确认可用。`;
  const result = redactText(original);
  assert.ok(result.changed);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.match(result.text, /已接通 API/);
  assert.match(result.text, /下次仍需确认/);
  assert.match(result.text, /REDACTED/);
  assert.deepEqual(redactText(result.text), { text: result.text, redactions: [], changed: false });
});

test('scrubbing preserves ordinary technical prose and handles multiline keys', () => {
  const ordinary = 'API key 尚未配置，password 是字段名。ComfyUI 版本 0.3.6。';
  assert.equal(redactText(ordinary).text, ordinary);
  for (const text of ['Authorization: Bearer abcdefghijklmnop12345',
    '-----BEGIN ' + 'PRIVATE KEY-----\nTHIS IS A PRIVATE KEY\n-----END PRIVATE KEY-----',
    'https://alice:verysecret@example.test/path']) {
    const result = redactText(text);
    assert.ok(result.changed);
    assert.ok(!result.text.includes('verysecret'));
    assert.ok(!result.text.includes('THIS IS A PRIVATE KEY'));
    assert.deepEqual(redactText(result.text), { text: result.text, redactions: [], changed: false });
  }
});

test('new originals scrub credentials and secondary writes reject them atomically', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-redaction-'));
  const store = new MemoryStore({ dataDir, instanceId: 'synthetic-redaction' });
  t.after(() => { store.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const secret = 'sk-' + 'synthetic-credential-'.repeat(3);
  store.appendRaw({ id: 'r', pool: 'a', role: 'user', sessionId: 's', text: `我已配置服务，密钥=${secret}` });
  assert.ok(!store.getRaw('r').text.includes(secret));
  const rejected = error => error.code === 'MEMORY_SENSITIVE_CONTENT' && !error.message.includes(secret);
  const before = store.db.prepare('SELECT count(*) AS n FROM workflow_events').get().n;
  assert.throws(() => store.writeEntry({ id: 'unsafe', kind: 'memory', text: `保存密钥=${secret}` }), rejected);
  assert.equal(store.getEntry('unsafe'), null);
  assert.throws(() => store.writeKnowledge({ requestId: 'unsafe-d', id: 'unsafe-method', purpose: '配置服务', conditions: ['测试'], method: `使用密钥=${secret}`, validationStatus: 'learned', reason: '合成检查', externalSources: [{ url: 'https://example.test/guide', title: '指南' }] }), rejected);
  assert.equal(store.getEntry('unsafe-method'), null);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM workflow_events').get().n, before);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM memory_decisions').get().n, 0);
  store.writeEntry({ id: 'safe', kind: 'memory', text: '用户说已配置服务，密钥已脱敏', sources: [{ rawId: 'r', quote: store.getRaw('r').text }] });
  assert.equal(store.getEntry('safe').evidenceStatus, 'quote_verified');
  const original = store.db.prepare('SELECT json FROM entries WHERE id=?').get('safe').json;
  assert.throws(() => store.reviewValidity({ requestId: 'unsafe-check', targets: [{ id: 'safe', version: 1 }], currentValidity: 'valid', check: { method: '测试', result: `密码=${secret}` }, sources: [{ rawId: 'r', quote: store.getRaw('r').text }], reason: '测试' }), rejected);
  assert.equal(store.getEntry('safe').currentValidity, 'unknown');
  assert.equal(store.db.prepare('SELECT json FROM entries WHERE id=?').get('safe').json, original);
});
