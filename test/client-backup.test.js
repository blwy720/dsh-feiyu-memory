import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const HASH = 'a'.repeat(64);
const baseStatus = () => ({
  settings: { enabled: false, backupDir: '/synthetic/backups', intervalDays: 7, schedule: 'interval' },
  dataDir: '/synthetic/memory', instanceId: 'synthetic-self', timezone: 'Asia/Shanghai', platform: 'linux',
  busy: false, scheduler: { lastSuccessAt: null, lastError: null },
  capabilities: { uploadMaxBytes: 512 * 1024 * 1024, downloadMaxBytes: 512 * 1024 * 1024 },
});
function allNodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(allNodes);
  return [tree, ...(tree.children || []).flatMap(allNodes)];
}
function textOf(tree) {
  if (tree === null || tree === undefined || tree === false) return '';
  if (typeof tree !== 'object') return String(tree);
  if (Array.isArray(tree)) return tree.map(textOf).join('');
  if (tree.type === 'style') return '';
  return (tree.children || []).map(textOf).join('');
}
function success(data) { return { ok: true, status: 200, json: async () => ({ ok: true, data }) }; }
function failure(code, message = '') { return { ok: false, status: 400, json: async () => ({ ok: false, error: { code, message } }) }; }

function harness(t, custom) {
  const hooks = [];
  let cursor = 0, Component, tree, registration, definition;
  const requests = [], downloads = [];
  const state = { status: baseStatus() };
  const pendingEffects = [];
  const timers = new Map();
  let nextTimer = 0;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
    useState(initial) {
      const index = cursor++;
      if (!hooks[index]) hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[index].value, value => {
        hooks[index].value = typeof value === 'function' ? value(hooks[index].value) : value;
      }];
    },
    useRef(value) {
      const index = cursor++;
      if (!hooks[index]) hooks[index] = { current: value };
      return hooks[index];
    },
    useEffect(effect, dependencies) {
      const index = cursor++;
      const previous = hooks[index];
      if (!previous || dependencies.some((value, item) => !Object.is(value, previous.dependencies[item]))) {
        previous?.cleanup?.();
        hooks[index] = { dependencies };
        pendingEffects.push(() => { hooks[index].cleanup = effect(); });
      }
    },
  };
  const document = {
    activeElement: { focus() {} },
    body: { appendChild() {} },
    createElement: () => ({ style: {}, click() { downloads.push({ href: this.href, download: this.download }); }, remove() {} }),
  };
  vm.runInNewContext(SOURCE, {
    window: { __ModuleLoader__: { load(value) { definition = value; } } },
    document, Date, Intl, URL: { createObjectURL: () => 'blob:synthetic', revokeObjectURL() {} },
    setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; },
    setInterval: callback => { timers.set(++nextTimer, callback); return nextTimer; },
    clearInterval: id => timers.delete(id),
    fetch: async (url, options) => {
      const name = url.split('/backup/')[1];
      const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
      const request = { url, name, options, body };
      requests.push(request);
      if (custom) {
        const result = await custom(request, state);
        if (result !== undefined) return result;
      }
      if (name === 'status') return success(structuredClone(state.status));
      if (name === 'settings') {
        state.status.settings = { ...body };
        return success(structuredClone(state.status));
      }
      if (name === 'now') {
        state.status.scheduler.lastSuccessAt = '2026-10-20T10:00:00Z';
        return success({ file: '/synthetic/backups/latest.feiyu-backup', validated: true });
      }
      return failure('UNEXPECTED', '测试收到未预期的请求');
    },
  }, { filename: 'client.js' });
  assert.equal(definition.id, 'dsh-feiyu-memory');
  const plugin = definition.factory(name => {
    assert.equal(name, 'react');
    return React;
  });
  assert.deepEqual(Array.from(plugin.inject), ['slots']);
  plugin.apply({ slots: {
    inject(name, callback) { assert.equal(name, 'settings.section'); callback(); },
    register(slot, view) { registration = slot; Component = view; },
  } });
  function render() { cursor = 0; tree = Component({ close() {} }); while (pendingEffects.length) pendingEffects.shift()(); return tree; }
  async function settle() {
    for (let round = 0; round < 4; round++) { await new Promise(resolve => setImmediate(resolve)); render(); }
  }
  const result = {
    requests, state, downloads, registration, render, settle,
    text: () => textOf(tree),
    node: id => {
      const found = allNodes(tree).find(node => node.props.id === id);
      assert.ok(found, `missing field ${id}`); return found;
    },
    button: label => {
      const found = allNodes(tree).find(node => node.type === 'button' && textOf(node) === label);
      assert.ok(found, `missing button ${label}`); return found;
    },
    async click(label) {
      const button = result.button(label);
      assert.ok(!button.props.disabled, `${label} unexpectedly disabled`);
      await button.props.onClick(); await settle();
    },
    change(id, value) { result.node(id).props.onChange({ target: { value } }); render(); },
  };
  t.after(() => { for (const hook of hooks) hook?.cleanup?.(); });
  render();
  return result;
}

test('native settings slot renders scoped backup controls and authenticated status without inventing chat backup', async t => {
  const app = harness(t);
  await app.settle();
  assert.equal(app.registration.name, 'settings.section');
  assert.equal(app.registration.label(), '肥鱼记忆备份');
  assert.match(app.text(), /不包含 DSH 聊天列表、图片附件和模型设置/);
  assert.match(app.text(), /尚无成功备份/);
  assert.match(app.text(), /关闭自动备份后，仍可手动立即备份/);
  const request = app.requests.find(item => item.name === 'status');
  assert.equal(request.options.credentials, 'same-origin');
  assert.equal(request.options.cache, 'no-store');
  assert.equal(app.node('fy-backup-dir').props.value, '/synthetic/backups');
});

test('settings validation prevents bad days; monthly removes the prior custom interval and saves atomically', async t => {
  const app = harness(t);
  await app.settle();
  app.change('fy-interval', '31');
  await app.click('保存设置');
  assert.equal(app.requests.filter(item => item.name === 'settings').length, 0);
  assert.match(app.text(), /1～30 的整数/);
  app.change('fy-schedule', 'monthly');
  await app.click('保存设置');
  const saved = app.requests.find(item => item.name === 'settings').body;
  assert.equal(saved.schedule, 'monthly');
  assert.equal(saved.intervalDays, 1);
  assert.equal(saved.enabled, false);
  assert.match(app.text(), /备份设置已保存/);
});

test('immediate backup works with auto disabled and coalesces a double click before React rerenders', async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const app = harness(t, async request => request.name === 'now' ? pending : undefined);
  await app.settle();
  const handler = app.button('立即备份').props.onClick;
  const first = handler();
  const second = handler();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.requests.filter(item => item.name === 'now').length, 1);
  assert.equal(app.state.status.settings.enabled, false);
  release(success({ file: '/synthetic/backups/latest.feiyu-backup', validated: true }));
  await Promise.all([first, second]); await app.settle();
  assert.match(app.text(), /最新备份已生成并通过检查/);
});

test('directory browser selects an optional new child without silently saving; cancel leaves settings intact', async t => {
  const app = harness(t, request => request.name === 'browse' ? success({
    path: request.body.path || '/synthetic', parent: '/', entries: [{ name: 'exports', path: '/synthetic/exports', type: 'directory' }],
  }) : undefined);
  await app.settle();
  const choose = allNodes(app.render()).find(node => node.type === 'button' && textOf(node) === '选择');
  choose.props.onClick(); await app.settle();
  assert.equal(app.requests.at(-1).body.kind, 'directory');
  app.change('fy-new-folder', 'private-copies');
  await app.click('使用此位置');
  assert.equal(app.node('fy-backup-dir').props.value, '/synthetic/backups/private-copies');
  assert.equal(app.requests.filter(item => item.name === 'settings').length, 0);
  const nextChoose = allNodes(app.render()).find(node => node.type === 'button' && textOf(node) === '选择');
  nextChoose.props.onClick(); await app.settle();
  await app.click('取消');
  assert.equal(app.node('fy-backup-dir').props.value, '/synthetic/backups/private-copies');
});

test('restore is gated by verification and sends the reviewed hash, without changing current-memory settings', async t => {
  const app = harness(t, request => {
    if (request.name === 'verify') return success({ validated: true, sha256: HASH,
      manifest: { createdAt: '2026-10-19T09:00:00Z', identity: { instanceId: 'other-memory', timezone: 'Asia/Shanghai' } } });
    if (request.name === 'restore') return success({ targetDir: request.body.targetDir, identity: { instanceId: 'other-memory' }, needsRebuild: true });
  });
  await app.settle();
  assert.ok(!allNodes(app.render()).some(node => node.type === 'button' && textOf(node) === '确认恢复到新目录'));
  app.change('fy-source', '/synthetic/old.feiyu-backup');
  await app.click('验证备份');
  assert.match(app.text(), /这是另一份记忆/);
  assert.match(app.text(), /不会覆盖、合并或切换当前记忆/);
  app.change('fy-restore-dir', '/synthetic/restored');
  await app.click('确认恢复到新目录');
  const request = app.requests.find(item => item.name === 'restore');
  assert.equal(request.body.expectedSha256, HASH);
  assert.equal(request.body.expectedInstanceId, 'other-memory');
  assert.equal(request.body.file, '/synthetic/old.feiyu-backup');
  assert.equal(request.body.targetDir, '/synthetic/restored');
  assert.match(app.text(), /恢复完成，当前仍在使用原记忆/);
  assert.equal(app.requests.filter(item => item.name === 'settings').length, 0);
  app.change('fy-source', '/synthetic/different.feiyu-backup');
  assert.ok(!allNodes(app.render()).some(node => node.type === 'button' && textOf(node) === '确认恢复到新目录'));
});

test('nonempty restore failure does not claim success or overwrite a current directory', async t => {
  const app = harness(t, request => {
    if (request.name === 'verify') return success({ validated: true, sha256: HASH, manifest: { identity: { instanceId: 'synthetic-self' } } });
    if (request.name === 'restore') return failure('BACKUP_TARGET');
  });
  await app.settle();
  app.change('fy-source', '/synthetic/old.feiyu-backup');
  await app.click('验证备份');
  app.change('fy-restore-dir', '/synthetic/memory');
  await app.click('确认恢复到新目录');
  assert.match(app.text(), /请选择新建或空文件夹/);
  assert.ok(!app.text().includes('恢复完成'));
  assert.equal(app.requests.filter(item => item.name === 'settings').length, 0);
});

test('browser import streams the selected file, keeps opaque paths out of the text field and enforces upload limit', async t => {
  const app = harness(t, request => {
    if (request.name === 'upload') return success({ file: 'upload:opaque', fileName: '合成.feiyu-backup', bytes: 42 });
    if (request.name === 'verify') return success({ validated: true, sha256: HASH, manifest: { identity: { instanceId: 'synthetic-self' } } });
  });
  app.state.status.capabilities.uploadMaxBytes = 100;
  await app.settle();
  let event = { target: { files: [{ name: 'big.feiyu-backup', size: 101 }], value: 'synthetic' } };
  await app.node('fy-import-file').props.onChange(event); await app.settle();
  assert.equal(app.requests.filter(item => item.name === 'upload').length, 0);
  const file = { name: '合成.feiyu-backup', size: 42 };
  event = { target: { files: [file], value: 'synthetic' } };
  await app.node('fy-import-file').props.onChange(event); await app.settle();
  const upload = app.requests.find(item => item.name === 'upload');
  assert.equal(upload.body, file);
  assert.equal(upload.options.headers['Content-Type'], 'application/octet-stream');
  assert.equal(upload.options.headers['X-File-Name'], encodeURIComponent(file.name));
  assert.equal(app.node('fy-source').props.value, '合成.feiyu-backup');
  assert.ok(!app.text().includes('upload:opaque'));
  await app.click('验证备份');
  assert.equal(app.requests.find(item => item.name === 'verify').body.file, 'upload:opaque');
});

test('export rejects latest and downloads only with an opaque token, reporting system handoff rather than saved-file certainty', async t => {
  const app = harness(t, request => {
    if (request.name === 'export') return success({ downloadId: 'opaque-id', fileName: 'copy.feiyu-backup', bytes: 20, sha256: HASH });
    if (request.name === 'download?id=opaque-id') return {
      ok: true, headers: { get: () => '20' }, blob: async () => ({ size: 20 }),
    };
  });
  await app.settle();
  app.change('fy-export-name', 'latest.feiyu-backup');
  await app.click('保存到文件夹');
  assert.match(app.text(), /不能使用 latest/);
  assert.equal(app.requests.filter(item => item.name === 'export').length, 0);
  await app.click('下载副本');
  assert.equal(app.requests.find(item => item.name === 'export').body.download, true);
  assert.equal(app.requests.filter(item => item.name.startsWith('download?')).length, 1);
  assert.equal(app.downloads[0].download, 'copy.feiyu-backup');
  assert.match(app.text(), /已将副本交给浏览器／系统保存/);
});

test('status retains last success and warns about an unconfirmed operation without promising old backups survived', async t => {
  const app = harness(t);
  await app.settle();
  app.state.status.scheduler.lastSuccessAt = '2026-10-18T01:00:00Z';
  app.state.status.lastError = { code: 'ENOSPC', at: '2026-10-20T01:00:00Z' };
  app.state.status.lastOperation = { completion: 'unconfirmed' };
  app.state.status.settingsWarning = { code: 'EIO' };
  await app.click('刷新状态');
  assert.match(app.text(), /2026\/10\/18|2026-10-18/);
  assert.match(app.text(), /空间不足/);
  assert.match(app.text(), /文件可能已经生成/);
  assert.match(app.text(), /设置已生效/);
  assert.ok(!app.text().includes('旧备份未被替换'));
});

test('a quick operation failure refreshes server completion status instead of leaving a stale success display', async t => {
  const app = harness(t, (request, state) => {
    if (request.name === 'now') {
      state.status.lastOperation = { completion: 'unconfirmed', outcome: 'error' };
      state.status.lastError = { code: 'EIO' };
      return failure('EIO', '未能确认操作完成，请验证目标文件。');
    }
  });
  await app.settle();
  await app.click('立即备份');
  assert.match(app.text(), /未能确认操作完成/);
  assert.match(app.text(), /文件可能已经生成/);
  assert.ok(!app.text().includes('最新备份已生成并通过检查'));
  assert.equal(app.requests.at(-1).name, 'status');
});
