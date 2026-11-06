/** Owner-only routes on DSH's authenticated connection.fetch, never on public webServer. */
import { createViewerService } from './viewer-service.js';

export const VIEWER_API = '/api/feiyu-memory/viewer/v1';
const MAX_BODY = 32 * 1024;
const MESSAGES = {
  VIEWER_INPUT: '查看请求格式无效。', VIEWER_CURSOR: '分页位置已失效，请重新查询。',
  VIEWER_SNAPSHOT_EXPIRED: '查看快照已到期，请刷新记忆库。', VIEWER_SNAPSHOT_LIMIT: '查看窗口已达上限，请关闭旧窗口后重试。',
  VIEWER_CLOSED: '记忆查看服务已关闭。', VIEWER_IDENTITY: '无法确认记忆库身份。', VIEWER_SCHEMA: '暂不支持此记忆库结构。',
  VIEWER_SOURCE_NOT_REFERENCED: '此原文不在快照记忆的直接引用范围内。', VIEWER_BUSY: '查看请求较多，请稍后重试。',
  VIEWER_METHOD: '查看接口只接受 POST 请求。', VIEWER_BODY_LIMIT: '查看请求过大。', VIEWER_DATA: '无法读取这条记忆数据。', VIEWER_FAILED: '读取记忆失败，请稍后刷新。'
};
const reply = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
function failure(code) { const error = new Error(code); error.code = code; return error; }

export function createViewerRoutes(options = {}) {
  const service = createViewerService(options), readers = new Set(), requests = new Set();
  const maxRequests = options.maxRequests ?? 8;
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 32) { service.close(); throw failure('VIEWER_INPUT'); }
  let closed = false, active = 0;
  async function read(request) {
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw failure('VIEWER_INPUT');
    if (!request.body) return {};
    const reader = request.body.getReader(); readers.add(reader);
    const cancel = () => { void reader.cancel().catch(() => {}); };
    request.signal.addEventListener('abort', cancel, { once: true });
    try {
      const chunks = []; let length = 0;
      while (true) {
        request.signal.throwIfAborted();
        if (closed) throw failure('VIEWER_CLOSED');
        const chunk = await reader.read(); if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > MAX_BODY) { cancel(); throw failure('VIEWER_BODY_LIMIT'); }
        chunks.push(Buffer.from(chunk.value));
      }
      if (!length) return {};
      let result; try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure('VIEWER_INPUT'); }
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw failure('VIEWER_INPUT');
      return result;
    } finally { readers.delete(reader); request.signal.removeEventListener('abort', cancel); try { reader.releaseLock(); } catch {} }
  }
  const methods = { open: 'open', entries: 'entries', relations: 'relations', entry: 'entry', raw: 'raw', bind: 'bind', close: 'closeSnapshot' };
  const routes = Object.entries(methods).map(([name, method]) => ({
    path: `${VIEWER_API}/${name}`, methods: ['POST'], requestBody: 'streaming',
    async fetch(request) {
      if (closed) return reply({ ok: false, error: { code: 'VIEWER_CLOSED', message: MESSAGES.VIEWER_CLOSED } }, 503);
      if (request.method !== 'POST') return reply({ ok: false, error: { code: 'VIEWER_METHOD', message: MESSAGES.VIEWER_METHOD } }, 405);
      if (active >= maxRequests) return reply({ ok: false, error: { code: 'VIEWER_BUSY', message: MESSAGES.VIEWER_BUSY } }, 429);
      active++;
      const task = (async () => {
        try {
          const input = await read(request); request.signal.throwIfAborted();
          if (closed) throw failure('VIEWER_CLOSED');
          return reply({ ok: true, data: service[method](input) });
        } catch (error) {
          const code = Object.hasOwn(MESSAGES, error?.code ?? '') ? error.code : 'VIEWER_FAILED';
          const status = code === 'VIEWER_SNAPSHOT_EXPIRED' ? 410 : code === 'VIEWER_SOURCE_NOT_REFERENCED' ? 404 : code === 'VIEWER_SNAPSHOT_LIMIT' ? 429 : code === 'VIEWER_CLOSED' ? 503 : code === 'VIEWER_BODY_LIMIT' ? 413 : 400;
          return reply({ ok: false, error: { code, message: MESSAGES[code] } }, status);
        } finally { active--; }
      })();
      requests.add(task); try { return await task; } finally { requests.delete(task); }
    }
  }));
  return { routes, diagnostics: () => ({ ...service.diagnostics(), activeRequests: active }),
    async close() { if (closed) return; closed = true; for (const reader of readers) void reader.cancel().catch(() => {}); service.close(); await Promise.allSettled([...requests]); } };
}

/** Connection is optional; registration errors must never stop conversation capture. */
export function registerViewerRoutes(ctx, options) {
  let api = null, binding = null, available = false, code = null;
  const bindings = new Set(), pendingClose = new Set();
  try {
    if (typeof ctx.inject !== 'function') return { diagnostics: () => ({ available: false, error: 'VIEWER_TRANSPORT' }), close: async () => {} };
    binding = ctx.inject(['connection'], child => {
      if (typeof child.connection?.fetch?.register !== 'function') { code = 'VIEWER_TRANSPORT'; return; }
      let localApi;
      try { localApi = createViewerRoutes(options); } catch { code = 'VIEWER_INIT'; return; }
      api = localApi;
      const localReleases = [];
      let disposed = false, closing = null;
      const disposeLocal = () => {
        if (disposed) return closing;
        disposed = true;
        for (const release of localReleases.splice(0).reverse()) { try { release?.(); } catch {} }
        if (api === localApi) available = false;
        bindings.delete(disposeLocal);
        closing = localApi.close(); pendingClose.add(closing);
        void closing.finally(() => pendingClose.delete(closing));
        return closing;
      };
      bindings.add(disposeLocal);
      try {
        for (const route of localApi.routes) localReleases.push(child.connection.fetch.register(route));
        available = true; code = null;
      } catch {
        void disposeLocal(); code = 'VIEWER_REGISTER';
      }
      // Cordis collects an injected plugin's returned disposer. Do not use an
      // ordinary `on('dispose')` event: dependency unload must release routes/DBs.
      return disposeLocal;
    });
  } catch { available = false; code = 'VIEWER_INIT'; for (const dispose of [...bindings]) void dispose(); }
  return { diagnostics: () => ({ available, error: code, ...(api?.diagnostics() ?? {}) }),
    async close() {
      available = false;
      for (const dispose of [...bindings]) void dispose();
      try { if (typeof binding === 'function') binding(); else binding?.dispose?.(); } catch {}
      await Promise.allSettled([...pendingClose]);
    } };
}
