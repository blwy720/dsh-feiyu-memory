import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

export const BACKUP_API = '/api/feiyu-memory/backup';
export const TRANSFER_LIMIT = 512 * 1024 * 1024;
const JSON_LIMIT = 16 * 1024;
const SESSION_TTL = 30 * 60 * 1000;
const messages = {
  BACKUP_BUSY: '已有备份操作正在进行，请完成后再试。',
  BACKUP_CLOSED: '记忆插件已关闭，请重新打开设置页。',
  BACKUP_PATH: '请选择有效的绝对路径；备份目录应位于当前记忆目录之外。',
  BACKUP_LINK: '请选择实际目录，暂不支持符号链接或目录联接。',
  BACKUP_SETTINGS: '设置无效，请检查备份目录、开关与周期。',
  BACKUP_SCHEDULE: '请选择 1～30 天，或每个自然月。',
  BACKUP_FORMAT: '这不是受支持的记忆备份文件。',
  BACKUP_HASH: '备份校验未通过，或文件已经变化，请重新验证。',
  BACKUP_IDENTITY: '这份备份的记忆身份与当前实例不一致。',
  BACKUP_MEMORY_LIMIT: '当前设备资源不足，未能完成验证。',
  BACKUP_EXISTS: '目标已存在，请使用新的文件名或空目录。',
  BACKUP_TARGET: '恢复目标必须是新建或空目录。',
  BACKUP_EXPIRED: '临时文件已过期，请重新选择或导出。',
  BACKUP_TRANSFER_LIMIT: '文件选择和下载最多支持 512 MiB；更大文件请使用设备上的文件路径。',
  BACKUP_INPUT: '输入不完整或格式不正确，请检查后再试。',
  BACKUP_MEDIA: '请求格式不受支持，请刷新页面后再试。',
  ENOENT: '文件或目录不存在，请重新选择。',
  EACCES: 'DSH 无权访问这个位置，请选择可访问的目录。',
  EPERM: '系统暂时不允许操作这个位置，请检查权限或文件占用。',
  ENOSPC: '空间不足，请腾出空间或选择其他目录。',
  EEXIST: '文件已存在，请换一个名称。',
};
function failure(code) { return Object.assign(new Error(code), { code }); }
function errorCode(error) { return /^[A-Z0-9_]{1,80}$/.test(error?.code ?? '') ? error.code : 'BACKUP_FAILED'; }
function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) throw failure('BACKUP_INPUT');
  return value;
}
function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\u0000-\u001f]/u.test(value)) throw failure('BACKUP_PATH');
  const result = path.resolve(value), root = path.parse(result).root;
  let current = root;
  for (const part of result.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw failure('BACKUP_LINK'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return result;
}
async function readJson(request, chunksOf) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw failure('BACKUP_MEDIA');
  if (Number(request.headers.get('content-length')) > JSON_LIMIT) throw failure('BACKUP_INPUT');
  const chunks = []; let size = 0;
  if (request.body) for await (const chunk of chunksOf(request)) {
    request.signal.throwIfAborted();
    size += chunk.byteLength;
    if (size > JSON_LIMIT) throw failure('BACKUP_INPUT');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw failure('BACKUP_INPUT'); }
}
function filename(value, prefix = 'feiyu-memory') {
  if (value === undefined) return `${prefix}-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}.feiyu-backup`;
  if (typeof value !== 'string' || value.length > 180 || /[\\/:*?"<>|\u0000-\u001f]/u.test(value)
    || !value.endsWith('.feiyu-backup') || value.toLowerCase() === 'latest.feiyu-backup' || value.startsWith('.')) throw failure('BACKUP_INPUT');
  return value;
}

/**
 * Owner-only routes for DSH's authenticated connection.fetch carrier.
 * These handlers must never be mounted on an unauthenticated webServer route.
 */
export function createBackupRoutes(manager, { dataDir, instanceId, timezone = 'Asia/Shanghai', tempRoot = fs.realpathSync(os.tmpdir()) } = {}) {
  const memoryDir = absolute(dataDir);
  const transfers = new Map(), requests = new Set(), downloadStreams = new Set(), bodyReaders = new Set();
  let temporary = null, closed = false, transferBusy = false;
  async function* chunksOf(request) {
    const reader = request.body.getReader(), cancel = () => { void reader.cancel().catch(() => {}); };
    bodyReaders.add(reader); request.signal.addEventListener('abort', cancel, { once: true });
    try {
      while (true) {
        if (closed) throw failure('BACKUP_CLOSED');
        request.signal.throwIfAborted();
        const chunk = await reader.read();
        if (closed) throw failure('BACKUP_CLOSED');
        request.signal.throwIfAborted();
        if (chunk.done) break;
        yield chunk.value;
      }
    } finally {
      bodyReaders.delete(reader); request.signal.removeEventListener('abort', cancel);
      await reader.cancel().catch(() => {}); reader.releaseLock();
    }
  }
  const tempDirectory = async () => {
    if (!temporary) {
      const parent = absolute(tempRoot);
      temporary = await fsp.mkdtemp(path.join(parent, 'feiyu-backup-ui-'));
      await fsp.chmod(temporary, 0o700);
    }
    return temporary;
  };
  async function dropTransfer(id) {
    const item = transfers.get(id);
    if (!item) return;
    transfers.delete(id);
    if (temporary && path.dirname(item.file) === temporary) await fsp.unlink(item.file).catch(() => {});
  }
  async function pruneTransfers() {
    for (const [id, item] of transfers) if (Date.now() - item.createdAt > SESSION_TTL && !item.inUse) await dropTransfer(id);
  }
  async function holdTransfer(type, operation) {
    if (transferBusy || manager.status().busy) throw failure('BACKUP_BUSY');
    transferBusy = true;
    try {
      await pruneTransfers();
      if ([...transfers.values()].some(item => item.type === type && item.inUse)) throw failure('BACKUP_BUSY');
      // Bound retained bytes/count: each UI holds at most one upload and one download.
      for (const [id, item] of transfers) if (item.type === type && !item.inUse) await dropTransfer(id);
      return await operation();
    } finally { transferBusy = false; }
  }
  function resolveSource(value) {
    if (typeof value === 'string' && value.startsWith('upload:')) {
      const id = value.slice(7), item = transfers.get(id);
      if (!item || item.type !== 'upload' || Date.now() - item.createdAt > SESSION_TTL) throw failure('BACKUP_EXPIRED');
      return { file: item.file, item };
    }
    return { file: absolute(value), item: null };
  }
  async function sourceOperation(value, operation) {
    const { file, item } = resolveSource(value);
    if (item) item.inUse = true;
    try { return await operation(file); }
    finally { if (item) item.inUse = false; }
  }
  function status() {
    const current = manager.status();
    return { ...current, busy: current.busy || transferBusy, dataDir: memoryDir, instanceId, timezone,
      platform: process.platform, capabilities: { uploadMaxBytes: TRANSFER_LIMIT, downloadMaxBytes: TRANSFER_LIMIT } };
  }
  async function browse(input) {
    fields(input, ['path', 'kind']);
    if (!['directory', 'file'].includes(input.kind)) throw failure('BACKUP_INPUT');
    const candidates = process.platform === 'win32'
      ? Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:\\`)
      : ['/', os.homedir(), path.dirname(memoryDir), '/storage/emulated/0/Download', '/sdcard/Download'];
    const roots = [];
    for (const candidate of [...new Set(candidates)]) {
      try {
        const full = absolute(candidate);
        if (fs.statSync(full).isDirectory()) { await fsp.access(full, fs.constants.R_OK); roots.push({ name: full, path: full }); }
      } catch { /* Only advertise locations this host can access. */ }
    }
    const folder = absolute(input.path || path.dirname(memoryDir));
    const entries = [], names = await fsp.readdir(folder, { withFileTypes: true });
    for (const entry of names) {
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !(input.kind === 'file' && entry.isFile() && entry.name.endsWith('.feiyu-backup')))) continue;
      entries.push({ name: entry.name, path: path.join(folder, entry.name), type: entry.isDirectory() ? 'directory' : 'file' });
    }
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
    return { path: folder, parent: path.dirname(folder) === folder ? null : path.dirname(folder), roots,
      entries: entries.slice(0, 1000), truncated: entries.length > 1000 };
  }
  async function upload(request) {
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/octet-stream') throw failure('BACKUP_MEDIA');
    if (Number(request.headers.get('content-length')) > TRANSFER_LIMIT) throw failure('BACKUP_TRANSFER_LIMIT');
    if (!request.body) throw failure('BACKUP_INPUT');
    return holdTransfer('upload', async () => {
      const id = randomUUID(), file = path.join(await tempDirectory(), `${id}.feiyu-backup`);
      let handle, bytes = 0, succeeded = false;
      try {
        handle = await fsp.open(file, 'wx', 0o600);
        for await (const chunk of chunksOf(request)) {
          request.signal.throwIfAborted();
          bytes += chunk.byteLength;
          if (bytes > TRANSFER_LIMIT) throw failure('BACKUP_TRANSFER_LIMIT');
          await handle.writeFile(chunk);
        }
        if (!bytes) throw failure('BACKUP_INPUT');
        await handle.sync(); await handle.close(); handle = null;
        let displayName = '已选择的备份.feiyu-backup';
        try {
          const provided = decodeURIComponent(request.headers.get('x-file-name') ?? '');
          if (provided.length <= 180 && provided.endsWith('.feiyu-backup') && !/[\\/\u0000-\u001f]/u.test(provided)) displayName = provided;
        } catch { /* Optional display label never controls a host filesystem path. */ }
        transfers.set(id, { file, fileName: displayName, type: 'upload', bytes, createdAt: Date.now(), inUse: false });
        succeeded = true;
        return { file: `upload:${id}`, fileName: displayName, bytes };
      } finally {
        if (handle) await handle.close().catch(() => {});
        if (!succeeded) await fsp.unlink(file).catch(() => {});
      }
    });
  }
  async function exportFile(input) {
    fields(input, ['directory', 'fileName', 'download']);
    if (input.download !== undefined && typeof input.download !== 'boolean') throw failure('BACKUP_INPUT');
    if (input.download && input.directory !== undefined) throw failure('BACKUP_INPUT');
    const fileName = filename(input.fileName);
    if (!input.download) {
      const file = path.join(absolute(input.directory), fileName);
      const result = await manager.exportFile({ file });
      return { ...result, file, fileName, bytes: (await fsp.stat(file)).size };
    }
    return holdTransfer('download', async () => {
      const id = randomUUID(), file = path.join(await tempDirectory(), `${id}.feiyu-backup`);
      let retained = false;
      try {
        const result = await manager.exportFile({ file }), bytes = (await fsp.stat(file)).size;
        if (bytes > TRANSFER_LIMIT) throw failure('BACKUP_TRANSFER_LIMIT');
        transfers.set(id, { file, fileName, bytes, type: 'download', createdAt: Date.now(), inUse: false });
        retained = true;
        return { fileName, bytes, sha256: result.sha256, downloadId: id };
      } finally { if (!retained) await fsp.unlink(file).catch(() => {}); }
    });
  }
  async function download(request) {
    const id = new URL(request.url).searchParams.get('id'), item = transfers.get(id);
    if (!item || item.type !== 'download' || Date.now() - item.createdAt > SESSION_TTL) throw failure('BACKUP_EXPIRED');
    if (item.inUse) throw failure('BACKUP_BUSY');
    // Reserve before filesystem awaits so another export cannot replace this
    // transfer while the download is being checked or its stream is opening.
    item.inUse = true;
    let stream;
    try {
      const stat = await fsp.lstat(item.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > TRANSFER_LIMIT) throw failure('BACKUP_TRANSFER_LIMIT');
      request.signal.throwIfAborted();
      stream = fs.createReadStream(item.file);
      const abort = () => stream.destroy();
      downloadStreams.add(stream);
      request.signal.addEventListener('abort', abort, { once: true });
      stream.once('close', () => { item.inUse = false; downloadStreams.delete(stream); request.signal.removeEventListener('abort', abort); });
      return new Response(Readable.toWeb(stream), { headers: {
        'Content-Type': 'application/octet-stream', 'Content-Length': String(stat.size),
        'Content-Disposition': `attachment; filename="feiyu-memory.feiyu-backup"; filename*=UTF-8''${encodeURIComponent(item.fileName)}`,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
      } });
    } catch (error) {
      if (stream) stream.destroy();
      else item.inUse = false;
      throw error;
    }
  }
  const handlers = {
    status: async () => status(),
    settings: async input => { fields(input, ['enabled', 'backupDir', 'intervalDays', 'schedule']); await manager.saveSettings(input); return status(); },
    now: async input => { fields(input, []); await manager.backupNow(); return status(); },
    export: exportFile,
    verify: async input => {
      fields(input, ['file']);
      return sourceOperation(input.file, async file => ({ ...await manager.verifyFile({ file }), file: input.file, validated: true }));
    },
    restore: async input => {
      fields(input, ['file', 'targetDir', 'expectedSha256', 'expectedInstanceId']);
      if (typeof input.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedSha256)) throw failure('BACKUP_HASH');
      return sourceOperation(input.file, async file => ({ ...await manager.restoreFile({
        file, targetDir: absolute(input.targetDir), expectedSha256: input.expectedSha256,
        ...(input.expectedInstanceId !== undefined ? { expectedBackupInstanceId: input.expectedInstanceId } : {})
      }), targetDir: path.resolve(input.targetDir), activated: false }));
    },
    browse,
  };
  const routes = [...Object.keys(handlers), 'upload', 'download'].map(name => {
    const method = ['status', 'download'].includes(name) ? 'GET' : 'POST';
    return {
      path: `${BACKUP_API}/${name}`, methods: [method], requestBody: method === 'GET' ? 'buffered' : 'streaming',
      async fetch(request) {
        if (closed) return json({ ok: false, error: { code: 'BACKUP_CLOSED', message: messages.BACKUP_CLOSED } }, 503);
        const task = (async () => {
          try {
            if (request.method !== method) return json({ ok: false, error: { code: 'BACKUP_METHOD', message: '请求方式不受支持。' } }, 405);
            if (!['status', 'download', 'browse'].includes(name) && transferBusy) throw failure('BACKUP_BUSY');
            if (name === 'download') return await download(request);
            const result = name === 'upload' ? await upload(request)
              : await handlers[name](method === 'GET' ? undefined : await readJson(request, chunksOf));
            return json({ ok: true, data: result });
          } catch (error) {
            const code = errorCode(error);
            const statusCode = code === 'BACKUP_BUSY' ? 409 : code === 'BACKUP_MEDIA' ? 415
              : code === 'BACKUP_TRANSFER_LIMIT' ? 413 : code === 'BACKUP_EXPIRED' ? 410 : 400;
            return json({ ok: false, error: { code, message: messages[code] ?? '未能确认操作完成，请检查备份状态；必要时验证目标文件。' } }, statusCode);
          }
        })();
        requests.add(task);
        try { return await task; } finally { requests.delete(task); }
      }
    };
  });
  return {
    routes,
    async close() {
      closed = true;
      for (const reader of bodyReaders) void reader.cancel().catch(() => {});
      await Promise.allSettled([...requests]);
      for (const stream of downloadStreams) stream.destroy();
      for (const id of [...transfers.keys()]) await dropTransfer(id);
      if (temporary && path.dirname(temporary) === path.resolve(tempRoot) && path.basename(temporary).startsWith('feiyu-backup-ui-')) {
        await fsp.rm(temporary, { recursive: true, force: true });
      }
    }
  };
}

/** Optional UI transport: absence never disables raw memory capture. */
export function registerBackupRoutes(ctx, manager, options) {
  if (typeof ctx.inject !== 'function') return { close: async () => {}, diagnostics: () => ({ available: false }) };
  const api = createBackupRoutes(manager, options);
  let available = false, error = null;
  const binding = ctx.inject(['connection'], child => {
    if (typeof child.connection?.fetch?.register !== 'function') { error = 'BACKUP_TRANSPORT'; return; }
    const releases = [];
    try {
      for (const route of api.routes) releases.push(child.connection.fetch.register(route));
      available = true;
    } catch (cause) {
      for (const release of releases.reverse()) release?.();
      error = errorCode(cause); available = false;
    }
  });
  return {
    diagnostics: () => ({ available, error }),
    async close() {
      available = false;
      if (typeof binding === 'function') binding();
      else binding?.dispose?.();
      await api.close();
    }
  };
}
