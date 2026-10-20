import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../lib/store.js';
import { createBackupManager } from '../lib/backup-manager.js';
import { createBackupRoutes, BACKUP_API, TRANSFER_LIMIT } from '../lib/backup-routes.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-routes-test-'));
  const dataDir = path.join(root, 'memory'), store = new MemoryStore({ dataDir, instanceId: 'route-test' });
  store.appendRaw({ id: 'one', sessionId: 'main', role: 'user', text: '合成备份界面测试。', pool: 'a' });
  const manager = createBackupManager({ dataDir, expectedInstanceId: 'route-test' });
  const api = createBackupRoutes(manager, { dataDir, instanceId: 'route-test', tempRoot: root });
  t.after(async () => {
    await api.close(); await manager.close(); store.close();
    assert.equal(path.dirname(root), os.tmpdir());
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function request(name, body, extra = {}) {
    const method = ['status', 'download'].includes(name.split('?')[0]) ? 'GET' : 'POST';
    const req = new Request(`http://localhost${BACKUP_API}/${name}`, {
      method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}), ...extra
    });
    return api.routes.find(r => r.path === `${BACKUP_API}/${name.split('?')[0]}`).fetch(req);
  }
  return { root, dataDir, store, manager, api, request };
}

test('UI backs up while automatic is off, exports a download and restores only the verified snapshot', async t => {
  const f = fixture(t), backupDir = path.join(f.root, 'backups');
  let response = await f.request('settings', { enabled: false, backupDir, intervalDays: 7, schedule: 'interval' });
  assert.equal(response.status, 200);
  response = await f.request('now', {});
  const state = (await response.json()).data;
  assert.equal(state.settings.enabled, false);
  assert.ok(state.scheduler.lastSuccessAt);
  assert.equal(state.scheduler.nextDueAt, null);
  const exported = (await (await f.request('export', { download: true })).json()).data;
  assert.ok(exported.downloadId); assert.ok(exported.sha256);
  const downloaded = await f.request(`download?id=${exported.downloadId}`);
  assert.equal(downloaded.status, 200);
  const bytes = Buffer.from(await downloaded.arrayBuffer());
  assert.equal(bytes.length, exported.bytes);
  assert.equal((await f.request('download?file=' + encodeURIComponent(path.join(f.dataDir, 'memory.sqlite')))).status, 410);

  const uploaded = await f.request('upload', undefined, {
    body: bytes, headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent('自己的备份.feiyu-backup') }
  });
  const source = (await uploaded.json()).data;
  assert.match(source.file, /^upload:/);
  const verified = (await (await f.request('verify', { file: source.file })).json()).data;
  assert.equal(verified.validated, true); assert.equal(verified.sha256, exported.sha256);
  assert.equal((await f.request('restore', { file: source.file, targetDir: path.join(f.root, 'not-approved') })).status, 400);
  assert.equal((await f.request('restore', { file: source.file, targetDir: f.dataDir, expectedSha256: verified.sha256 })).status, 400);
  const restored = (await (await f.request('restore', {
    file: source.file, targetDir: path.join(f.root, 'restored'), expectedSha256: verified.sha256
  })).json()).data;
  assert.equal(restored.activated, false);
  assert.ok(fs.existsSync(path.join(restored.targetDir, 'memory.sqlite')));
  assert.equal(f.store.getRaw('one').text, '合成备份界面测试。');
});

test('UI JSON and transfer inputs are bounded and cannot export arbitrary host files', async t => {
  const f = fixture(t);
  assert.equal((await f.request('now', {}, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await f.request('now', { padding: 'a'.repeat(16384) })).status, 400);
  assert.equal((await f.request('now', {}, { method: 'PUT' })).status, 405);
  assert.equal((await f.request('status', undefined, { method: 'POST' })).status, 405);
  assert.equal((await f.request('export', { directory: f.root, fileName: '../secret.feiyu-backup' })).status, 400);
  assert.equal((await f.request('export', { directory: f.root, fileName: 'latest.feiyu-backup' })).status, 400);
  assert.equal((await f.request('upload', undefined, {
    body: new Uint8Array([1]), headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(TRANSFER_LIMIT + 1) }
  })).status, 413);
  const result = await (await f.request('verify', { file: path.join(f.root, 'absent.feiyu-backup') })).json();
  assert.equal(result.ok, false);
  assert.ok(!JSON.stringify(result.error).includes(f.root));
  assert.ok(!JSON.stringify(result.error).includes('Error:'));
});

test('directory chooser exposes only directories and backup files, never follows links', async t => {
  const f = fixture(t), chosen = path.join(f.root, 'picker');
  fs.mkdirSync(chosen);
  fs.mkdirSync(path.join(chosen, 'folder'));
  fs.writeFileSync(path.join(chosen, 'memory.feiyu-backup'), 'synthetic');
  fs.writeFileSync(path.join(chosen, 'private.txt'), 'not part of picker');
  fs.symlinkSync(f.dataDir, path.join(chosen, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const files = (await (await f.request('browse', { path: chosen, kind: 'file' })).json()).data;
  assert.deepEqual(files.entries.map(e => e.name), ['folder', 'memory.feiyu-backup']);
  const dirs = (await (await f.request('browse', { path: chosen, kind: 'directory' })).json()).data;
  assert.deepEqual(dirs.entries.map(e => e.name), ['folder']);
  assert.equal((await f.request('browse', { path: path.join(chosen, 'link'), kind: 'directory' })).status, 400);
});

test('shutdown cancels a stalled upload and removes private transfer files', async t => {
  const f = fixture(t);
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
    cancel() { cancelled = true; }
  });
  const upload = f.request('upload', undefined, {
    body: stream, duplex: 'half', headers: { 'Content-Type': 'application/octet-stream' }
  });
  await new Promise(resolve => setTimeout(resolve, 30));
  await f.api.close();
  assert.equal((await upload).status, 400);
  assert.equal(cancelled, true);
  assert.equal(fs.readdirSync(f.root).some(name => name.startsWith('feiyu-backup-ui-')), false);
  assert.equal((await f.request('status')).status, 503);
});

test('download reserves its file before async checks and rejects concurrent replacement', async t => {
  const f = fixture(t);
  const exported = (await (await f.request('export', { download: true })).json()).data;
  const originalLstat = fsp.lstat;
  let entered, release;
  const checking = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  fsp.lstat = async (...args) => {
    const stat = await originalLstat(...args);
    if (String(args[0]).endsWith(`${exported.downloadId}.feiyu-backup`)) {
      entered();
      await gate;
    }
    return stat;
  };
  try {
    const pending = f.request(`download?id=${exported.downloadId}`);
    await checking;
    assert.equal((await f.request(`download?id=${exported.downloadId}`)).status, 409);
    assert.equal((await f.request('export', { download: true })).status, 409);
    release();
    const response = await pending;
    assert.equal(response.status, 200);
    assert.equal((await response.arrayBuffer()).byteLength, exported.bytes);
    // A closed download releases the reservation for the next explicit export.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await f.request('export', { download: true })).status, 200);
  } finally {
    release();
    fsp.lstat = originalLstat;
  }
});

test('download validation failure releases its reservation for a retry', async t => {
  const f = fixture(t);
  const exported = (await (await f.request('export', { download: true })).json()).data;
  const originalLstat = fsp.lstat;
  fsp.lstat = async (...args) => {
    if (String(args[0]).endsWith(`${exported.downloadId}.feiyu-backup`)) {
      throw Object.assign(new Error('synthetic file access failure'), { code: 'EACCES' });
    }
    return originalLstat(...args);
  };
  try {
    const response = await f.request(`download?id=${exported.downloadId}`);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'EACCES');
  } finally {
    fsp.lstat = originalLstat;
  }
  const retry = await f.request(`download?id=${exported.downloadId}`);
  assert.equal(retry.status, 200);
  assert.equal((await retry.arrayBuffer()).byteLength, exported.bytes);
});
