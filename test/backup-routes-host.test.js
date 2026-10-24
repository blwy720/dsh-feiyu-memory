import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { request as httpRequest } from 'node:http';
import { createBackupRoutes, registerBackupRoutes } from '../lib/backup-routes.js';

const installedRoot = process.env.FEIYU_DSH_MODULES_ROOT;
const integration = { skip: !installedRoot };
const prefix = '/api/feiyu-memory/backup';

async function fixture(t) {
  const load = name => import(pathToFileURL(join(installedRoot, name, 'lib/index.js')).href);
  const [{ Context, Service }, { WebServer }, connectionModule] = await Promise.all([
    load('cordis'), load('dsh-host-webserver'), load('dsh-client-connection'),
  ]);
  const ctx = new Context();
  const directory = mkdtempSync(join(tmpdir(), 'feiyu-route-host-'));
  const dataDir = join(directory, 'memory');
  const tempRoot = join(directory, 'transfers');
  mkdirSync(dataDir);
  mkdirSync(tempRoot);
  const counts = new Map();
  const count = name => counts.set(name, (counts.get(name) ?? 0) + 1);
  const settings = { enabled: false, backupDir: '', intervalDays: 1, schedule: 'interval' };
  const manager = {
    getSettings() { count('getSettings'); return { ...settings }; },
    status() {
      count('status');
      return { settings: { ...settings }, busy: false, operation: null, scheduler: {}, lastError: null, lastOperation: null, settingsError: null };
    },
    async saveSettings(value) { count('saveSettings'); Object.assign(settings, value); return this.status(); },
    async backupNow() { count('backupNow'); return this.status(); },
    async exportFile() { count('exportFile'); throw new Error('Unexpected export in authentication test'); },
    async verifyFile() { count('verifyFile'); throw new Error('Unexpected verification in authentication test'); },
    async restoreFile() { count('restoreFile'); throw new Error('Unexpected restore in authentication test'); },
  };
  // This is a fresh, purely in-memory credential provider. No Harness home,
  // profile credentials, or user authentication state is read by these tests.
  class InMemoryCredentials extends Service {
    constructor(context) {
      super(context, 'credentials');
      this.records = new Map();
    }
    async modifyRecord(key, update) {
      const next = await update(this.records.get(key));
      if (next !== undefined) this.records.set(key, next);
      return this.records.get(key);
    }
  }
  t.after(async () => {
    await ctx.fiber.dispose();
    assert.equal(resolve(directory).startsWith(resolve(tmpdir()) + '\\') || resolve(directory).startsWith(resolve(tmpdir()) + '/'), true);
    rmSync(directory, { recursive: true, force: true });
  });
  await ctx.plugin(InMemoryCredentials);
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0, compression: 'none' });
  await ctx.plugin(connectionModule);
  const carrier = ctx.get('connection');
  const webServer = ctx.get('webServer');
  // Newer host-webserver releases expose the bound host/port, and leave URL
  // composition to the application. Older supported releases had getOrigin().
  // Both paths refer only to this fixture's fresh loopback listener.
  const origin = typeof webServer.getOrigin === 'function' ? webServer.getOrigin()
    : `http://${webServer.host}:${webServer.port}`;
  assert.equal(new URL(origin).hostname, '127.0.0.1');
  assert.ok(Number(new URL(origin).port) > 0);
  const launch = new URL(carrier.authenticatedUrl(origin));
  let cookie;
  assert.equal(carrier.authorizeIndex({
    method: 'GET', url: launch.pathname + launch.search, headers: { host: launch.host },
  }, {
    writeHead(code, headers) {
      assert.equal(code, 303);
      cookie = headers['set-cookie'].split(';', 1)[0];
    },
    end() {},
  }), false);
  assert.equal(typeof cookie, 'string');
  const options = { dataDir, tempRoot, instanceId: 'backup-route-test', timezone: 'Asia/Shanghai' };
  return { ctx, carrier, origin, cookie, counts, manager, options };
}

async function registerDirect(t, f) {
  const owned = createBackupRoutes(f.manager, f.options);
  t.after(() => owned.close());
  const fiber = await f.ctx.plugin({
    name: 'feiyu-backup-routes-host-test',
    inject: ['connection'],
    apply(child) {
      for (const route of owned.routes) child.connection.fetch.register(route);
    },
  });
  assert.equal(fiber.state, 2);
  f.counts.clear();
  return { owned, fiber };
}

function argumentsFor(route) {
  const method = route.methods[0];
  return {
    method,
    ...(method === 'GET' || method === 'HEAD' ? {} : {
      headers: { 'content-type': route.path.endsWith('/upload') ? 'application/octet-stream' : 'application/json' },
      body: route.path.endsWith('/upload') ? 'unauthorized upload body' : '{}',
    }),
  };
}

function rawHttpStatus(url, { headers, body, method }) {
  return new Promise((resolveStatus, reject) => {
    // Native fetch normalizes Host, so use node:http to put this test's
    // deliberately untrusted authority on the wire unchanged.
    const request = httpRequest(url, { method, headers }, response => {
      response.resume();
      response.once('end', () => resolveStatus(response.statusCode));
      response.once('error', reject);
    });
    request.once('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('Isolated HTTP test timed out')));
    request.end(body);
  });
}

test('opt-in: actual DSH authenticates every backup route before running its handler', integration, async t => {
  const f = await fixture(t);
  const { owned } = await registerDirect(t, f);
  assert.ok(owned.routes.length >= 8);
  for (const route of owned.routes) {
    const response = await fetch(f.origin + route.path, argumentsFor(route));
    assert.equal(response.status, 401, route.path);
    await response.arrayBuffer();
  }
  assert.equal(f.counts.size, 0, 'unauthenticated routes must not read or mutate backup state');
  const response = await fetch(f.origin + prefix + '/status', {
    headers: { cookie: f.cookie, origin: f.origin },
  });
  assert.equal(response.status, 200);
  await response.json();
  assert.ok(f.counts.get('status') >= 1);
});

test('opt-in: actual DSH rejects cross-origin, cross-site and untrusted-host backup requests', integration, async t => {
  const f = await fixture(t);
  await registerDirect(t, f);
  for (const [label, headers] of [
    ['foreign origin', { cookie: f.cookie, origin: 'https://untrusted.example' }],
    ['null origin', { cookie: f.cookie, origin: 'null' }],
    ['cross-site', { cookie: f.cookie, origin: f.origin, 'sec-fetch-site': 'cross-site' }],
    ['untrusted host', { cookie: f.cookie, host: 'untrusted.example' }],
  ]) {
    const status = await rawHttpStatus(f.origin + prefix + '/settings', {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: '{"enabled":true,"backupDir":"/not-used","intervalDays":1,"schedule":"interval"}',
    });
    assert.equal(status, 403, label);
  }
  assert.equal(f.counts.size, 0);
  // Desktop's native HTTP carrier deliberately removes Origin and forwards
  // the host-issued cookie. This exercises that exact admitted request shape.
  const desktop = await fetch(f.origin + prefix + '/status', { headers: { cookie: f.cookie } });
  assert.equal(desktop.status, 200);
  await desktop.json();
});

test('opt-in: actual DSH admits only its owner/operator for all exact Fetch backup routes', integration, async t => {
  const f = await fixture(t);
  const { owned } = await registerDirect(t, f);
  if (typeof f.carrier.createPeer !== 'function') {
    // The current carrier has exactly one operator and no caller-selected
    // principal. Authentication happens before its internal Fetch dispatcher;
    // supplying an arbitrary second fetch() argument would not test admission.
    assert.ok(f.carrier.operator);
    const admitted = f.carrier.admit({ method: 'GET', url: prefix + '/status',
      headers: { host: new URL(f.origin).host, cookie: f.cookie } });
    assert.equal(admitted.peer, f.carrier.operator);
    for (const route of owned.routes) {
      const args = argumentsFor(route);
      const response = await fetch(f.origin + route.path, { ...args, headers: { ...args.headers,
        'x-peer-id': f.carrier.operator.id, 'x-principal': 'owner' } });
      assert.equal(response.status, 401, route.path);
      await response.arrayBuffer();
    }
    assert.equal(f.counts.size, 0, 'a forged operator label must not bypass carrier authentication');
    return;
  }
  // Earlier supported carriers exposed multiple peers and performed the
  // owner check at exact Fetch dispatch. Retain that integration assertion.
  const shared = f.carrier.createSharedFetchHandler('/api');
  const nonOwner = f.carrier.createPeer({ principal: { kind: 'test-non-owner' } });
  t.after(() => nonOwner.dispose());
  for (const route of owned.routes) {
    const response = await shared.fetch(new Request(f.origin + route.path, argumentsFor(route)), nonOwner);
    assert.equal(response.status, 403, route.path);
    await response.arrayBuffer();
  }
  assert.equal(f.counts.size, 0, 'an admitted non-owner still cannot use backup routes');
});

test('opt-in: backup registration participates in actual Cordis teardown and can reload cleanly', integration, async t => {
  const f = await fixture(t);
  let adapter;
  const plugin = {
    name: 'feiyu-backup-adapter-lifetime-test',
    apply(child) {
      adapter = registerBackupRoutes(child, f.manager, f.options);
    },
  };
  const fiber = await f.ctx.plugin(plugin);
  await fiber.await();
  assert.equal(fiber.state, 2);
  const request = () => fetch(f.origin + prefix + '/status', { headers: { cookie: f.cookie } });
  const before = await request();
  assert.equal(before.status, 200);
  await before.json();
  await fiber.dispose();
  await adapter.close();
  const after = await request();
  assert.equal(after.status, 404);
  await after.arrayBuffer();
  const reloaded = await f.ctx.plugin(plugin);
  await reloaded.await();
  assert.equal(reloaded.state, 2);
  const response = await request();
  assert.equal(response.status, 200);
  await response.json();
  await reloaded.dispose();
  await adapter.close();
});

test('opt-in: actual authenticated carrier streams opaque uploads and downloads without exposing temporary paths', integration, async t => {
  const f = await fixture(t);
  const bytes = Buffer.alloc(128 * 1024, 0x5a);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  f.manager.exportFile = async ({ file }) => {
    writeFileSync(file, bytes, { flag: 'wx' });
    return { validated: true, sha256, file };
  };
  f.manager.verifyFile = async ({ file }) => {
    assert.equal(resolve(file).startsWith(resolve(f.options.tempRoot)), true);
    assert.deepEqual(readFileSync(file), bytes);
    return { validated: true, sha256, bytes: bytes.length };
  };
  await registerDirect(t, f);
  const headers = { cookie: f.cookie, origin: f.origin, 'content-type': 'application/json' };
  const exported = await fetch(f.origin + prefix + '/export', {
    method: 'POST', headers, body: '{"download":true,"fileName":"isolated.feiyu-backup"}',
  });
  assert.equal(exported.status, 200);
  const exportBody = await exported.json();
  assert.equal(exportBody.ok, true);
  assert.equal(exportBody.data.sha256, sha256);
  assert.equal('file' in exportBody.data, false);
  const downloaded = await fetch(f.origin + prefix + '/download?id=' + encodeURIComponent(exportBody.data.downloadId), {
    headers: { cookie: f.cookie, origin: f.origin },
  });
  assert.equal(downloaded.status, 200);
  assert.match(downloaded.headers.get('content-disposition'), /attachment/);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
  const uploaded = await fetch(f.origin + prefix + '/upload', {
    method: 'POST',
    headers: { cookie: f.cookie, origin: f.origin, 'content-type': 'application/octet-stream', 'x-file-name': 'isolated.feiyu-backup' },
    body: bytes,
  });
  assert.equal(uploaded.status, 200);
  const uploadBody = await uploaded.json();
  assert.equal(uploadBody.ok, true);
  assert.match(uploadBody.data.file, /^upload:[a-f0-9-]+$/);
  assert.equal(uploadBody.data.bytes, bytes.length);
  const verified = await fetch(f.origin + prefix + '/verify', {
    method: 'POST', headers, body: JSON.stringify({ file: uploadBody.data.file }),
  });
  assert.equal(verified.status, 200);
  const verifiedBody = await verified.json();
  assert.equal(verifiedBody.data.validated, true);
  assert.equal(verifiedBody.data.file, uploadBody.data.file);
});
