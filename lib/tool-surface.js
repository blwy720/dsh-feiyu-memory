export const MEMORY_TOOLS_SCHEMA = Object.freeze({
  type: 'object', properties: {
    names: { type: 'array', items: { type: 'string' }, description: '省略或空数组查看本插件工具目录；提供名称后启用对应工具，直到插件停止。只注册，不执行操作。' },
  }, required: [],
});
export const MEMORY_TOOLS_DESCRIPTION = '发现并按需启用肥鱼记忆工具。空参数查看短目录；names指定需要的工具。不会执行记忆操作，也不会更改其他插件。';
const COMPACT = ['memory_search', 'memory_fetch', 'memory_prepare', 'memory_manage', 'memory_review', 'memory_tools'];
const validName = name => typeof name === 'string' && /^memory_[a-z0-9_]+$/u.test(name);
const text = value => String(value ?? '').replace(/\s+/gu, ' ').trim();

/** Owns only the registrations created through this surface. The host supplies
 * register(name,schema,description), which must synchronously return a disposer.
 * Tool discovery/enablement never executes a tool or changes another plugin. */
export function createToolSurface({ mode = 'compatible', schemas, descriptions = {}, register } = {}) {
  if (!['compatible', 'compact'].includes(mode)) throw new TypeError('toolMode 必须是 compatible 或 compact');
  if (!schemas || typeof schemas !== 'object' || Array.isArray(schemas) || typeof register !== 'function') throw new TypeError('工具面需要schemas对象和同步register函数');
  if (!descriptions || typeof descriptions !== 'object' || Array.isArray(descriptions)) throw new TypeError('descriptions必须是对象');
  const originalNames = Object.keys(schemas);
  if (!originalNames.length || originalNames.some(name => !validName(name))) throw new TypeError('只接受本插件memory_*工具白名单');
  const catalogSchemas = new Map(originalNames.map(name => [name, structuredClone(schemas[name])]));
  for (const [name, schema] of catalogSchemas) if (!schema || typeof schema !== 'object' || schema.type !== 'object') throw new TypeError(`无效工具schema: ${name}`);
  catalogSchemas.set('memory_tools', structuredClone(MEMORY_TOOLS_SCHEMA));
  const catalogDescriptions = new Map(originalNames.map(name => [name, text(descriptions[name])]));
  catalogDescriptions.set('memory_tools', MEMORY_TOOLS_DESCRIPTION);
  if (mode === 'compact') for (const name of COMPACT) if (!catalogSchemas.has(name)) throw new TypeError(`精简模式缺少基础工具: ${name}`);
  const owned = new Map();
  let started = false, closing = false;

  function catalog() {
    return { mode, state: closing ? owned.size ? 'closing' : 'closed' : started ? 'started' : 'not_started',
      enabled: [...owned.keys()], available: [...catalogSchemas.keys()].map(name => ({ name, enabled: owned.has(name), description: catalogDescriptions.get(name).slice(0, 140) })),
      note: '仅此插件；启用只增加可调用工具，不执行操作。已启用工具在插件停止前持续可用，所有主会话共享此注册状态。' };
  }
  function normalizeNames(names) {
    if (!Array.isArray(names) || names.length > catalogSchemas.size) throw new TypeError(`names必须是最多${catalogSchemas.size}项的数组`);
    for (const name of names) if (!validName(name) || !catalogSchemas.has(name)) throw new TypeError(`不属于本插件工具白名单: ${String(name).slice(0, 100)}`);
    return [...new Set(names)];
  }
  function disposeNames(names) {
    const errors = [];
    for (const name of [...names].reverse()) {
      const dispose = owned.get(name); if (!dispose) continue;
      try { dispose(); owned.delete(name); } catch (error) { errors.push(error); }
    }
    return errors;
  }
  function registerNames(names) {
    const added = [];
    try {
      for (const name of names) {
        if (owned.has(name)) continue;
        const handle = register(name, structuredClone(catalogSchemas.get(name)), catalogDescriptions.get(name));
        const dispose = typeof handle === 'function' ? handle : handle && typeof handle.dispose === 'function' ? () => handle.dispose() : null;
        if (!dispose) throw new TypeError(`register(${name})必须同步返回disposer`);
        owned.set(name, dispose); added.push(name);
      }
      return added;
    } catch (error) {
      const cleanup = disposeNames(added);
      if (cleanup.length) throw new AggregateError([error, ...cleanup], '工具注册失败；本批部分注册清理失败，可调用close重试');
      throw error;
    }
  }
  function start() {
    if (closing) throw new Error('工具面已经停止');
    if (started) return catalog();
    registerNames(mode === 'compact' ? COMPACT : originalNames);
    started = true;
    return catalog();
  }
  function enable(names = []) {
    if (closing) throw new Error('工具面已经停止');
    if (!started) throw new Error('请先start工具面');
    const requested = normalizeNames(names);
    if (!requested.length) return catalog();
    const alreadyEnabled = requested.filter(name => owned.has(name));
    const added = registerNames(requested);
    return { mode, added, alreadyEnabled, enabled: [...owned.keys()], note: '工具已注册；未执行任何记忆操作。' };
  }
  function close() {
    closing = true;
    const errors = disposeNames([...owned.keys()]);
    if (errors.length) throw new AggregateError(errors, '部分记忆工具未能注销；再次close仅重试未清理项');
    return { closed: true };
  }
  return { start, enable, close, catalog };
}
