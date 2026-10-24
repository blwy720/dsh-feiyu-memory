import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { MemoryStore } from './store.js';
import { createTools } from './tools.js';
import { buildWake, buildCoreData, buildPreferenceData, buildRecentTurnData } from './lifecycle.js';
import { createBackupManager } from './backup-manager.js';
import { registerBackupRoutes } from './backup-routes.js';
import { searchRecall, buildRecallData, createSemanticRecall, semanticCandidates, refreshRecall } from './recall.js';
import { redactText } from './redaction.js';
import { extendToolSchemasV6, descriptionsV6 } from './tool-schemas-v6.js';
import { createToolSurface } from './tool-surface.js';

export { MemoryStore } from './store.js';
export { createTools } from './tools.js';
export { buildWake, buildCoreData, buildPreferenceData, buildRecentTurnData, generateDay, runSlide } from './lifecycle.js';

export const name = 'feiyu-memory';
export const inject = ['tools', 'sessions', 'agents', 'systemPrompt'];
export const WAKE_SECTION = 'feiyu-memory:wake';
export const CORE_SECTION = 'feiyu-memory:core-data';
export const PREFERENCE_SECTION = 'feiyu-memory:preference-data';
export const RECALL_SECTION = 'feiyu-memory:recall-route';
export const RECENT_TURN_SECTION = 'feiyu-memory:recent-turn-data';
export const RELATED_SECTION = 'feiyu-memory:related-data';
const recallCue = /我记得|之前|上次|以前|去年|上星期|上周|昨天|前天|最近|还记得/u;
const LEGACY_READ_BUDGET_MS = 2000;

/** No host dependencies: Cordis 4.0.4 accepts Standard Schema v1 validators. */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'feiyu-memory',
    validate(value) {
      try { return { value: validateConfig(value) }; }
      catch (error) { return { issues: [{ message: error.message }] }; }
    },
  },
};

function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('memory config must be an object');
  const allowed = new Set(['dataDir', 'instanceId', 'ownerSessionId', 'sessionScope', 'timezone', 'participation', 'wakeMaxChars', 'coreMaxChars', 'preferenceMaxChars', 'recentTurnMaxChars',
    'backupEnabled', 'backupDir', 'backupIntervalDays', 'backupSchedule', 'autoRecall', 'recallMaxChars', 'recallLimit',
    'semanticEndpoint', 'semanticModel', 'semanticApiKeyEnv', 'semanticTimeoutMs', 'toolMode']);
  for (const key of Object.keys(config)) if (!allowed.has(key)) throw new TypeError(`unknown memory config: ${key}`);
  const sessionScope = config.sessionScope ?? 'owner';
  if (!['owner', 'profile'].includes(sessionScope)) throw new TypeError('sessionScope must be owner or profile');
  for (const key of ['dataDir', 'instanceId', ...(sessionScope === 'owner' || config.ownerSessionId !== undefined ? ['ownerSessionId'] : [])]) {
    if (typeof config[key] !== 'string' || !config[key].trim() || /[\u0000-\u001f]/u.test(config[key])) throw new TypeError(`${key} must be an explicit nonempty string`);
  }
  if (!isAbsolute(config.dataDir)) throw new TypeError('dataDir must be absolute');
  const participation = config.participation ?? 'solitude';
  if (!['interactive', 'solitude'].includes(participation)) throw new TypeError('participation must be interactive or solitude');
  const timezone = config.timezone ?? 'Asia/Shanghai';
  new Intl.DateTimeFormat('en', { timeZone: timezone });
  const wakeMaxChars = config.wakeMaxChars ?? 1800;
  if (!Number.isSafeInteger(wakeMaxChars) || wakeMaxChars < 160 || wakeMaxChars > 2000) throw new RangeError('wakeMaxChars must be 160..2000');
  const coreMaxChars = config.coreMaxChars ?? 2400;
  if (!Number.isSafeInteger(coreMaxChars) || coreMaxChars < 512 || coreMaxChars > 8000) throw new RangeError('coreMaxChars must be 512..8000');
  const preferenceMaxChars = config.preferenceMaxChars ?? 1600;
  if (!Number.isSafeInteger(preferenceMaxChars) || preferenceMaxChars < 512 || preferenceMaxChars > 8000) throw new RangeError('preferenceMaxChars must be 512..8000');
  const recentTurnMaxChars = config.recentTurnMaxChars ?? 8000;
  if (!Number.isSafeInteger(recentTurnMaxChars) || recentTurnMaxChars < 1024 || recentTurnMaxChars > 32000) throw new RangeError('recentTurnMaxChars must be 1024..32000');
  const backupEnabled = config.backupEnabled ?? false;
  if (typeof backupEnabled !== 'boolean') throw new TypeError('backupEnabled must be boolean');
  const backupDir = config.backupDir ?? '';
  if (typeof backupDir !== 'string' || /[\u0000-\u001f]/u.test(backupDir) || (backupDir !== '' && !isAbsolute(backupDir))) throw new TypeError('backupDir must be an absolute directory');
  if (backupEnabled && !backupDir.trim()) throw new TypeError('enabled backup requires backupDir');
  const backupIntervalDays = config.backupIntervalDays ?? 1;
  if (!Number.isInteger(backupIntervalDays) || backupIntervalDays < 1 || backupIntervalDays > 30) throw new RangeError('backupIntervalDays must be 1..30');
  const backupSchedule = config.backupSchedule ?? 'interval';
  if (!['interval', 'monthly'].includes(backupSchedule)) throw new TypeError('backupSchedule must be interval or monthly');
  if (backupSchedule === 'monthly' && backupIntervalDays !== 1) throw new TypeError('monthly schedule must not also specify a non-default backupIntervalDays');
  const autoRecall = config.autoRecall ?? true;
  const toolMode = config.toolMode ?? 'compatible';
  if (!['compatible', 'compact'].includes(toolMode)) throw new TypeError('toolMode must be compatible or compact');
  if (typeof autoRecall !== 'boolean') throw new TypeError('autoRecall must be boolean');
  const recallMaxChars = config.recallMaxChars ?? 2400, recallLimit = config.recallLimit ?? 5;
  if (!Number.isSafeInteger(recallMaxChars) || recallMaxChars < 512 || recallMaxChars > 8000) throw new TypeError('recallMaxChars must be 512..8000');
  if (!Number.isSafeInteger(recallLimit) || recallLimit < 1 || recallLimit > 10) throw new TypeError('recallLimit must be 1..10');
  const semanticEndpoint = config.semanticEndpoint ?? '', semanticModel = config.semanticModel ?? '', semanticApiKeyEnv = config.semanticApiKeyEnv ?? '';
  if ([semanticEndpoint, semanticModel, semanticApiKeyEnv].some(value => typeof value !== 'string' || value.length > 2000)) throw new TypeError('Invalid semantic config');
  if (semanticApiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(semanticApiKeyEnv)) throw new TypeError('semanticApiKeyEnv must be an environment variable name');
  const semanticTimeoutMs = config.semanticTimeoutMs ?? 1500;
  if (!Number.isSafeInteger(semanticTimeoutMs) || semanticTimeoutMs < 100 || semanticTimeoutMs > 5000) throw new TypeError('semanticTimeoutMs must be 100..5000');
  createSemanticRecall({ endpoint: semanticEndpoint, model: semanticModel, apiKeyEnv: semanticApiKeyEnv, timeoutMs: semanticTimeoutMs });
  return { ...config, sessionScope, participation, timezone, wakeMaxChars, coreMaxChars, preferenceMaxChars, recentTurnMaxChars,
    autoRecall, recallMaxChars, recallLimit, semanticEndpoint, semanticModel, semanticApiKeyEnv, semanticTimeoutMs, toolMode,
    backupEnabled, backupDir, backupIntervalDays, backupSchedule };
}

const string = (description, values) => ({ type: 'string', description, ...(values ? { enum: values } : {}) });
const strings = (description) => ({ type: 'array', description, items: { type: 'string' } });
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const paging = { limit: { type: 'integer', description: '最多 20 条，默认 4 条。' }, offset: { type: 'integer' } };
const filters = {
  type: string('raw / memory / doing / entity / relation / preference / a3 / b2 或 user / assistant / tool；B仅接受后三种角色'),
  from: string('起始日期 YYYY-MM-DD 或带时区的 ISO 时间'), to: string('结束日期 YYYY-MM-DD 或带时区的 ISO 时间'),
  timeAxis: string('mentioned原对话时间；occurred发生时间；recorded入库/归档时间；either兼容联合查询', ['either', 'recorded', 'occurred', 'mentioned']),
  timeWindow: object({ preset: string('last_week上一个本地自然周；recent_7_days过去168小时', ['last_week', 'recent_7_days']),
    asOf: string('可选参考时刻，带时区ISO；默认当前时刻'), timeZone: string('可选IANA时区，默认记忆库时区') }, ['preset']),
  subject: string('记得的人物/主体线索，不记得时间时不加时间过滤'), topic: string('主题线索'),
  eventKeywords: string('事件关键词'), scopeEligible: { type: 'boolean', description: 'B3按当前self/第一层关系范围过滤。' },
  entity: string('实体名称或别名'), project: string('项目标识'),
  status: string('条目最后已知状态', ['pending', 'active', 'done', 'cancelled', 'archived']),
  includeHistory: { type: 'boolean', description: '包括不可变历史版本；有时间范围时默认包含，可显式 false 只查当前版本。' },
  pool: string('A1原文、A2初次提纯、A3关键信息归档、B仅统计、B2独处冲浪关键发现（14天）、B3肥鱼自述喜好、C关系网；B仅支持记录日期YYYY-MM-DD及角色，不支持正文/实体/状态筛选', ['a1', 'a2', 'a3', 'b', 'b2', 'b3', 'c']),
};
const sourceSchema = object({
  rawId: string('原始记录 ID；摘要 ID 不能作为原文证据'),
  quote: string('逐字摘录；仅校验定位，不代表语义支持'),
  support: string('显式支持判断', ['unassessed', 'supports', 'contradicts', 'context_only']),
}, ['rawId', 'quote']);

const entryProperties = {
  kind: string('只写 A2 人工整理条目，不得捕获原文或直接写 C', ['memory', 'doing', 'entity', 'relation']),
  pool: string('普通写入仅允许 A2；A3须memory_a3_write再次归纳，C关系网须memory_core审核', ['a2']),
  id: string('已有 ID 表示创建不可变的新版本'), text: string('内容，尚无证据时保留未验证状态'),
  expectedVersion: { type: 'integer', description: '更新时的预期当前版本，用于防止覆盖其他会话的新修改。' },
  hooks: strings('可检索的具体问题、实体或项目钩子'),
  sources: { type: 'array', items: sourceSchema },
  sourceNature: string('来源性质'), occurredAt: string('确知的发生时刻 ISO 8601；不确定则省略'),
  statementType: string('明确陈述fact或明确自述self_report；均不自动代表已核实；推测不得写入A2', ['fact', 'self_report']),
  status: string('doing: pending/active/done/cancelled；其他条目: active/archived'),
  entities: strings('实体名称'), aliases: strings('实体别名'), project: string('项目名'), tags: strings('检索标签'),
  from: string('关系起点：self 或已存在实体 ID；省略为 self'), to: string('关系终点：self 或已存在实体 ID'),
  rel: string('from认为/称呼to的关系，例如 主人/朋友；不能自动补反向'), note: string('一句注脚，可省略'),
};
const entrySchema = object(entryProperties, ['kind', 'text', 'hooks', 'sources', 'statementType']);
const reviewEntrySchema = object(entryProperties, ['kind', 'text', 'sources', 'statementType']);
const lineagePaging = {
  metadataOffset: { type: 'integer', description: '来源时间/更正事件/依赖元数据分页起点，默认0。' },
  metadataLimit: { type: 'integer', description: '元数据页大小1..10，默认5。' },
  sourceOffset: { type: 'integer', description: 'A3父条目非负分页起点，默认0。' },
  sourceLimit: { type: 'integer', description: 'A3父条目页大小1..10，默认5。' },
  coverageOffset: { type: 'integer', description: 'A3声明讨论范围的非负分页起点，默认0。' },
  coverageLimit: { type: 'integer', description: 'A3范围页大小1..10，默认5。' },
};

export const toolSchemas = Object.freeze(extendToolSchemasV6({
  memory_search: object({ q: string('检索词，可留空'), ...filters, date: string('单一日期 YYYY-MM-DD，不能与 from/to 同用'), ...paging }),
  memory_read: object({
    id: string('候选 ID'), kind: string('记录类型', ['raw', 'memory', 'doing', 'entity', 'relation', 'preference', 'a3', 'b2']), version: { type: 'integer', description: '历史版本号，必须大于 0；B2过期版本不可读取。' },
    pool: string('可验证目标池；A3为再次提纯的关键信息；B只有统计，不存在可读取正文；B2为14天冲浪发现；B3为肥鱼自述喜好', ['a1', 'a2', 'a3', 'b2', 'b3', 'c']),
    // DSH's schema subset does not support minimum/maximum. The tool API
    // validates ranges; descriptions expose them without unsupported keywords.
    offset: { type: 'integer', description: '非负正文起点，按 UTF-16 code units；默认 0。' },
    limit: { type: 'integer', description: '正文页长度 1..16000，默认 4000。' },
    evidenceOffset: { type: 'integer', description: '非负来源页起点，默认 0。' },
    evidenceLimit: { type: 'integer', description: '来源页大小 0..10，默认 4；原文按 originalId 另行分页读取。B2同页返回externalSources链接，不是原文引文或网页验证。' },
    ...lineagePaging,
  }, ['id']),
  memory_list: object({ ...filters, date: string('单一日期 YYYY-MM-DD，不能与 from/to 同用'), ...paging }),
  memory_write: entrySchema,
  memory_graph: object({ center: string('中心节点 ID，默认 self（肥鱼）'), depth: { type: 'integer', description: '沿已有连接展开 1..5 层，默认2；返回边仍保持原方向，不创造反向关系。' },
    limit: { type: 'integer', description: '边数上限 1..500，默认 100；同时返回这些边的端点节点。' }, pool: string('默认只查 C 关系网，可显式查 A2 或两者', ['c', 'a2', 'all']) }),
  memory_review_queue: object({ limit: { type: 'integer', description: '1..20，默认 4。' }, offset: { type: 'integer', description: '非负起点，默认 0。' } }),
  memory_review_request: object({ requestId: string('唯一幂等请求ID'), rawIds: strings('重要事件的A1原文ID；先读原文，不能只按词频判断'),
    reason: string('为何需要提前提炼：能力变化、承诺、决定、重要经历或明确更正等') }, ['requestId', 'rawIds', 'reason']),
  memory_review: object({
    action: string('submit 提交复盘；history 读取持久决定历史', ['submit', 'history']),
    requestId: string('submit 必填；唯一幂等请求 ID，重试须使用同一 ID 和完全相同输入'),
    rawIds: strings('submit 必填；已满168小时或已登记提前审查的原文ID，最多20个'),
    entries: { type: 'array', description: 'A2 提纯产物，须逐字引用原文并如实声明支持/反驳/上下文关系；不得直接写 C', items: reviewEntrySchema },
    omissions: { type: 'array', description: '未形成条目的输入须逐条说明原因；本次提交不直接删除。已审且满7天后维护可清理未引用原文，引用证据仍保留', items: object({ rawId: string('原文 ID'), reason: string('不提炼的理由') }, ['rawId', 'reason']) },
    reason: string('submit 必填；本批判断理由'),
    limit: { type: 'integer', description: 'history 的页大小 1..100，默认 20。' }, offset: { type: 'integer', description: 'history 的非负起点，默认 0。' },
    id: string('history 可筛选相关条目或原文 ID'),
  }, ['action']),
  memory_core: object({
    requestId: string('唯一幂等请求 ID'), id: string('已有 A2/C 条目 ID；C 仅允许 entity 节点和 relation 边'),
    expectedVersion: { type: 'integer', description: '必填当前版本，用于并发检查。' },
    action: string('promote: A2→C；revoke: C→A2（撤销仍保留历史）', ['promote', 'revoke']),
    reason: string('本次核心关系选择或撤销的具体理由'),
    category: string('提升 C 时必填：entity 可 identity/relationship；relation 仅 relationship', ['identity', 'relationship']),
  }, ['requestId', 'id', 'expectedVersion', 'action', 'reason']),
  memory_core_write: object({
    requestId: string('唯一幂等请求ID'), id: string('C实体或关系ID'), expectedVersion: { type: 'integer', description: '新建0，修改传当前版本。' },
    kind: string('C只允许节点和边', ['entity', 'relation']), text: string('节点说明或关系判断'),
    from: string('关系判断的一方，self或C实体ID'), to: string('被称呼/判断的一方，self或C实体ID'), rel: string('from认为to是什么关系'), note: string('关系注脚'),
    statementType: string('来源性质，推断须明确依据和不确定性', ['fact', 'self_report', 'inference']),
    inference: object({ reasoning: string('推断依据，最多2000字符'), uncertainty: string('不确定性，最多500字符') }, ['reasoning', 'uncertainty']),
    sources: { type: 'array', items: sourceSchema }, reason: string('本次自主判断或更新的理由'),
    category: string('实体可identity/relationship，关系仅relationship', ['identity', 'relationship']),
    dependencyEntries: { type: 'array', items: object({ id: string('相关记忆ID'), version: { type: 'integer' } }, ['id', 'version']) },
  }, ['requestId', 'id', 'expectedVersion', 'kind', 'text', 'statementType', 'reason', 'category']),
  memory_correct: object({
    requestId: string('唯一幂等请求ID'),
    targets: { type: 'array', items: object({ id: string('被更正条目ID'), version: { type: 'integer' } }, ['id', 'version']) },
    status: string('correction时必填；关联的下游条目只进入待复核，不直接改正文', ['needs_review', 'superseded', 'disputed']),
    changeType: string('correction纠正过去判断；state_change记录现在改变，不否认过去', ['correction', 'state_change']),
    reason: string('有依据的更正或状态变化理由'), sources: { type: 'array', items: sourceSchema },
    replacement: object({ id: string('替代条目ID'), version: { type: 'integer' } }, ['id', 'version']),
  }, ['requestId', 'targets', 'reason', 'sources']),
  memory_preference: object({
    requestId: string('唯一幂等请求 ID；重试保持同一 ID 和相同输入'), id: string('喜好条目 ID'),
    expectedVersion: { type: 'integer', description: '首次创建为 0，更新或撤销须传当前版本。' },
    action: string('set 创建或更新自述喜好；revoke 撤销并保留历史', ['set', 'revoke']),
    topic: string('set 必填；喜好主题，最多 120 字符'), stance: string('set 必填；喜好立场', ['like', 'dislike', 'neutral', 'mixed']),
    text: string('set 必填；肥鱼自己的最后自述，最多 500 字符；不是客观事实或永久性格'),
    reason: string('本次表达/修改/撤销喜好的理由，最多 2000 字符'),
    subject: string('喜好持有者：self或C关系网当前第一层实体ID；更新不得换持有者'),
    expressionKind: string('自身可记录喜好或情感表达；第一层人物记录明确喜好', ['preference', 'emotion']),
    target: string('可选表达指向：self或C实体ID，不自动生成关系'),
    declaration: object({ subject: string('必须与喜好持有者subject相同'), rawId: string('明确表达的A1来源'),
      quote: string('与sources中一条引文逐字一致；表明是谁表达喜好') }, ['subject', 'rawId', 'quote']),
    dependencyEntries: { type: 'array', items: object({ id: string('相关记忆ID'), version: { type: 'integer' } }, ['id', 'version']) },
    sources: { type: 'array', description: '可为空；若提供须逐字定位原文，仅作为 context_only 自述依据，不得声明事实支持',
      items: object({ rawId: string('原文 ID'), quote: string('逐字摘录'), support: string('仅能是上下文定位', ['context_only']) }, ['rawId', 'quote']) },
  }, ['requestId', 'id', 'expectedVersion', 'action', 'reason']),
  memory_a3_write: object({
    requestId: string('唯一幂等请求 ID；重试保持相同 ID 和完全相同输入'),
    id: string('A3归纳 ID；首次使用新ID，更新仅能针对已有kind:a3/pool:a3'),
    expectedVersion: { type: 'integer', description: '首次创建为0；修改、恢复或撤销须传当前A3版本。' },
    action: string('write 从A2再次归纳关键信息；revoke 撤销并保留历史', ['write', 'revoke']),
    reason: string('本次归档或撤销的理由，最多2000字符'),
    body: object({ time: string('发生时间或范围；不知道写不详，不使用归档时间冒充'),
      persons: strings('参与人物，明确身份'), event: string('关键事件、结果和必要条件；明确自述须保留归属和未验证状态') }, ['time', 'persons', 'event']),
    derivedFrom: strings('write必填；1..50个不同A2条目ID，只能来自当前A2；不能直接引用A1/A3/B3/C'),
    coverage: object({
      scope: { type: 'array', description: '声明本次实际审阅范围；1..50个当前A2精确版本，不得已归档/取消/退出活动池',
        items: object({ id: string('A2条目ID'), version: { type: 'integer', description: '已读取的精确当前版本。' } }, ['id', 'version']) },
      covered: strings('必须恰好等于derivedFrom；不为空'),
      notCovered: { type: 'array', description: '每个未归纳条目的ID和具体理由；无遗漏也必须显式传[]',
        items: object({ id: string('声明范围内未纳入的A2 ID'), reason: string('未纳入的具体理由，最多500字符') }, ['id', 'reason']) },
      scopeNote: string('声明范围的边界和未能列举其他相关条目的理由，1..1000字符；不得声称系统已找全所有相关项'),
    }, ['scope', 'covered', 'notCovered', 'scopeNote']),
    statementType: string('write必填：明确陈述fact或明确自述self_report；新A3不接受推测，仍标derived_only', ['fact', 'self_report']),
    hooks: strings('可检索钩子'), tags: strings('辅助检索标签'),
    occurredAt: string('确知发生时间ISO8601；不确定则省略'),
  }, ['requestId', 'id', 'expectedVersion', 'action', 'reason']),
  memory_a3_list: object({ status: string('当前或历史版本状态', ['active', 'archived']), orphaned: { type: 'boolean' },
    lineageBroken: { type: 'boolean' }, includeHistory: { type: 'boolean' }, ...paging }),
  memory_a3_read: object({ id: string('A3条目ID'), version: { type: 'integer', description: '可选精确历史版本，大于0。' },
    offset: { type: 'integer', description: '正文UTF-16非负起点，默认0。' }, limit: { type: 'integer', description: '正文页长度1..16000，默认4000。' },
    evidenceOffset: { type: 'integer' }, evidenceLimit: { type: 'integer', description: '0..10，默认4。' }, ...lineagePaging }, ['id']),
  memory_a2_review_queue: object({ limit: { type: 'integer', description: '1..20，默认4。' }, offset: { type: 'integer', description: '非负起点，默认0。' } }),
  memory_a2_review: object({ requestId: string('唯一幂等请求ID'), reason: string('本批审核的理由'),
    items: { type: 'array', description: '1..50个不同A2当前精确版本；审核不立即清理', items: object({
      id: string('A2条目ID'), version: { type: 'integer', description: '审核的当前精确版本。' },
      decision: string('archived已由有效A3归纳覆盖；discard明确不需长期保留', ['archived', 'discard']),
      a3Ids: strings('archived必填有效A3 ID，须引用此A2精确版本；discard不得提供'), reason: string('该条审核决定的具体理由'),
    }, ['id', 'version', 'decision', 'reason']) },
  }, ['requestId', 'items', 'reason']),
  memory_a2_cleanup: object({ apply: { type: 'boolean', description: '默认false预览；true仅使满30天且已获当前版本审核批准的A2退出活动池。保留不可变历史和原文。' } }),
  memory_b2_write: object({
    requestId: string('唯一幂等请求ID；重试保持相同ID和输入'), id: string('B2冲浪发现ID；已过期ID不得复用'),
    expectedVersion: { type: 'integer', description: '首次创建为0，修改或撤销须传当前版本。' },
    action: string('write显式写下关键发现；revoke撤销', ['write', 'revoke']),
    text: string('write必填；关键发现，1..600字符，不保存完整浏览或独处过程'),
    judgment: string('write必填；肥鱼自己的判断，1..600字符，须区分网页主张与自身判断'),
    reason: string('本次保存、修改或撤销的理由，1..2000字符'),
    sources: { type: 'array', description: 'write必填；1..10个无嵌入凭据的HTTP(S)来源。仅external_reference，不代表网页内容已验证。', items: object({
      url: string('HTTP(S)网址；不允许URL用户名/密码，不应提交含私密凭据的链接'), title: string('来源标题，1..200字符'),
      accessedAt: string('访问时刻，带时区ISO8601；可省略'),
    }, ['url', 'title']) },
    hooks: strings('可检索钩子'), tags: strings('辅助检索标签'),
  }, ['requestId', 'id', 'expectedVersion', 'action', 'reason']),
  memory_dict: object({}),
}));

const descriptions = {
  memory_search: '按词、实体、项目及发生/记录日期返回少量候选；时间范围包含历史版本，结果只是线索，需要 memory_read 看原文。',
  memory_read: '分页读取选定原文或版本及其来源；按 nextOffset 续读，以 originalId 单独读取原文。区分定位、支持、来源和有效性，重复读取不提高置信度。',
  memory_list: '按池查看A1原文、A2条目、A3归纳、B2冲浪发现、B3自述喜好或C关系网候选；可按状态筛选或包括历史版本。B仅返回统计，B2过期内容不可查。',
  memory_write: '记录或更新 A2 记忆、事项、实体和有向关系；C 关系网使用 memory_core。原文只由宿主提交事件采集，无证据不得写成已验证。',
  memory_graph: '读取 C 池关系图：以这个实例自己为中心，返回认识谁、什么关系、证据状态。关系不因重复写入而变得更可信。',
  memory_review_queue: '查看已登记的重要事件提前审查及满7×24小时的补审原文指针。先memory_read阅读；失败或未审继续保留。',
  memory_review_request: '将一次性重要事件登记为提前提炼待办；不按词频选择，不自动生成摘要，不代表完成审查。随后读取原文并用memory_review提交。',
  memory_review: '提交有原文出处的A2提纯或明确不提炼的理由，或读取审查/核心选择历史。所有输入须覆盖，重复同请求不会增加可信度。本次提交不直接删除；已审满7天后维护使其退出A1，引用或明确保留的原文继续作证据，其余可清理。',
  memory_core: '有理由地提升或撤销 C 关系网：仅 entity 节点和 relation 边。须有原文及声明支持，先节点后边；普通记忆、事项和A3归档不得进入C。撤销节点前先撤销关联 C 边。',
  memory_core_write: '独立维护C节点和有向关系，允许有依据且标注不确定性的推断；不经A2伪装成事实。from认为to是rel，不自动补反向、传递或循环证据。',
  memory_correct: '为精确版本登记有原文依据的更正/争议/状态改变，保留原正文和历史，并将依赖条目标记待复核。新说法不自动胜过旧说法。',
  memory_preference: '维护B3：肥鱼自身喜好/情感表达及C网第一层人物明确表达的喜好。subject各自归属，target为表达对象；非self须declaration与原文来源，移出第一层后停止普通注入，历史仍可查。',
  memory_a3_write: '只从A2精确版本再归纳时间/人物/关键事件三要素，保留完整覆盖/未覆盖记录。只接受明确陈述或明确自述，推测不进入；derived_only不等于验证事实。新A3独立于原文存活，仍可接收关联更正。',
  memory_a3_list: '分页查A3线索及孤立/断链标记；不会把A3正文注入常驻提示。',
  memory_a3_read: '分页读A3及其声明范围、精确A2父版本和最多200字父摘要、A1出处计数与读取指针；归纳和推断不增加证据可信度。',
  memory_a2_review_queue: '分页列记录满30×24小时的当前A2待处理版本；未审核到期先保留，不自动生成A3或丢弃。',
  memory_a2_review: '显式审核A2版本：已归纳到A3须给出覆盖精确版本的有效A3，或有理由地判断不需保留。A3的未覆盖说明不能替代此审核；更新A2后须重新审核。',
  memory_a2_cleanup: '预览或执行A2活动池清理，仅影响满30天且已有该版本审核批准的条目。保留历史证据；无批准的A2继续等待，不删除A1或A3。',
  memory_b2_write: 'B2仅显式保存肥鱼独处冲浪时值得留下的关键发现、HTTP(S)来源和自己的判断，保留14天；external_reference不是事实或网页验证。到期自动清理，不能把它当A1原文、A3归档或C关系证据。B独处全文仍不保存。',
  memory_dict: '读取记忆字典，了解原文、证据和检索路径。',
  ...descriptionsV6,
};

function rememberSeen(state, values) {
  let remaining = 400;
  function visit(value) {
    if (!value || typeof value !== 'object' || remaining-- <= 0) return;
    if (typeof value.rawId === 'string' && state.seenRaw.size < 50) state.seenRaw.add(value.rawId);
    if (typeof value.id === 'string') {
      if (Number.isSafeInteger(value.version) && value.version > 0 && state.seenEntries.size < 50) state.seenEntries.set(`${value.id}:${value.version}`, { id: value.id, version: value.version });
      else if ((value.kind === 'raw' || value.pool === 'a1' || value.pool === 'a') && state.seenRaw.size < 50) state.seenRaw.add(value.id);
    }
    for (const [key, child] of Object.entries(value)) if (!['text', 'quote', 'reason', 'body', 'method'].includes(key)) visit(child);
  }
  for (let value of Array.isArray(values) ? values : [values]) {
    if (typeof value === 'string') { try { value = JSON.parse(value.slice(value.indexOf('{'))); } catch { continue; } }
    visit(value);
  }
}

function repeatedMemorySpans(store, state, original) {
  const text = redactText(original).text, spans = [], entries = [], raws = [];
  function matches(source) {
    let matched = false;
    for (const sentence of String(source ?? '').split(/[\n。！？]/u).slice(0, 40)) {
      const phrase = sentence.trim();
      if (phrase.length < 20 || phrase.length > 2000) continue;
      const start = text.indexOf(phrase);
      if (start !== -1) { spans.push({ start, end: start + phrase.length }); matched = true; }
    }
    return matched;
  }
  for (const ref of state.seenEntries.values()) if (matches(store.getEntry(ref.id, { version: ref.version })?.text)) entries.push(ref);
  for (const id of state.seenRaw) if (matches(store.getRaw(id)?.text)) raws.push(id);
  return spans.length ? { derivedFromMemory: entries, derivedFromRaw: raws, derivedSpans: spans.slice(0, 100) } : {};
}

/** Direct ToolDefinition does not get defineTool's argument validator. */
function validateArguments(schema, value, path = 'arguments') {
  const fail = () => { throw new TypeError(`invalid ${path}`); };
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) fail();
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) throw new TypeError(`missing ${path}.${key}`);
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties, key)) throw new TypeError(`unknown ${path}.${key}`);
      validateArguments(schema.properties[key], value[key], `${path}.${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) fail();
    value.forEach((item, index) => validateArguments(schema.items, item, `${path}[${index}]`));
  } else if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value)) fail();
  } else if (typeof value !== schema.type) fail();
  if (schema.enum && !schema.enum.includes(value)) fail();
}

export function captureId(instanceId, sessionId, messageId) {
  return `dsh-${createHash('sha256').update(JSON.stringify([instanceId, sessionId, messageId])).digest('hex')}`;
}

function isHumanMessage(message) {
  const source = message?.source;
  return message?.role === 'user' && (source?.kind === 'user' ||
    (source?.kind === 'user-question-reply' && source.outcome === 'answered' && typeof source.callId === 'string' && source.callId.length > 0));
}

function isMainHeader(header, id) {
  return typeof id === 'string' && header?.id === id && header.origin !== 'subagent' && (header.delegationDepth ?? 0) === 0;
}

// Fold only event envelope/turn/source metadata. Never read message content here.
// The durable first own start, unlike firstLiveSeq, survives resume and forks.
function foldTurnMetadata(state, event, inherited) {
  if (event.seq < inherited) return;
  if (event.type === 'turn/start') {
    if (!state.firstOwnStart) state.firstOwnStart = event;
    state.currentStart = event;
    state.inputHuman = false;
  } else if (event.type === 'turn/end') {
    state.currentStart = null;
    state.inputHuman = false;
  } else if (event.type === 'user/message' && event.surfaceOp === 'append' && state.currentStart && isHumanMessage(event.data)) {
    state.inputHuman = true;
  }
}

/** Standalone use does not require Cordis or any installed DSH package. */
export function createMemoryModule(options) {
  const store = new MemoryStore(options);
  return { store, tools: createTools(store), wake: (options) => buildWake(store, options), close: () => store.close() };
}

/** Bind eligible live sessions; bounded legacy A1 candidates are verified lazily. */
export function createHostAdapter(ctx, options, { store: suppliedStore } = {}) {
  const config = validateConfig(options);
  for (const [key, method] of [['tools', 'register'], ['sessions', 'get'], ['agents', 'get']]) {
    if (typeof ctx?.[key]?.[method] !== 'function') throw new TypeError(`DSH ${key}.${method} is required`);
  }
  if (typeof ctx.on !== 'function' || !ctx.systemPrompt) throw new TypeError('DSH event and systemPrompt services are required');
  if (config.sessionScope === 'profile' && typeof ctx.agents.roots !== 'function') throw new TypeError('DSH agents.roots is required for profile scope');
  const store = suppliedStore ?? new MemoryStore(config);
  if (store.instanceId !== config.instanceId) {
    if (!suppliedStore) store.close();
    throw new Error('memory store instanceId mismatch');
  }
  const tools = createTools(store);
  const semanticRecall = createSemanticRecall({ endpoint: config.semanticEndpoint, model: config.semanticModel, apiKeyEnv: config.semanticApiKeyEnv, timeoutMs: config.semanticTimeoutMs });
  const states = new WeakMap();
  const disposers = [];
  let closed = false;
  let captureFailed = false;
  const omittedMessages = new Set();
  const recentSelections = new Map();
  const recentReadControllers = new Map();
  const verifiedRounds = new Set();
  let recentFailures = 0;
  let legacyUnavailable = false;
  let legacyTimeouts = 0;
  let backupManager = null, backupApi = null, backupTimer = null, backupInitError = null, toolSurface = null;

  function isLiveSession(session) {
    return !closed && typeof session?.id === 'string' && ctx.sessions.get(session.id) === session;
  }
  function isEligibleAgent(agent) {
    if (!agent || ctx.agents.get(agent.id) !== agent || !isLiveSession(agent.session) || agent.id !== agent.session.id) return false;
    if (config.sessionScope === 'owner') return agent.id === config.ownerSessionId;
    // Runtime roots and durable lineage are distinct: ordinary forks are roots,
    // while a cold-resumed delegated session may also be a runtime root.
    const header = agent.session.header;
    if (!header || header.origin === 'subagent' || !ctx.agents.roots().includes(agent)) return false;
    for (const depth of [header.delegationDepth ?? 0, agent.options?.subagentDepth ?? 0]) {
      if (!Number.isSafeInteger(depth) || depth !== 0) return false;
    }
    return true;
  }
  function isEligibleSession(session) {
    if (!isLiveSession(session)) return false;
    // Owner mode retains its original event-capture contract. Profile mode is
    // intentionally limited to exact, currently registered top-level agents.
    return config.sessionScope === 'owner' ? session.id === config.ownerSessionId : isEligibleAgent(ctx.agents.get(session.id));
  }
  function stateFor(session) {
    let state = states.get(session);
    if (!state) {
      state = { turn: null, participating: false, recallCue: false, toolCalls: new Map(), firstOwnStart: null, currentStart: null,
        inputHuman: false, historyAvailable: false, observedSeq: -1, query: '', previousQuery: '', querySeq: -1,
        related: null, relatedKey: null, seenEntries: new Map(), seenRaw: new Set(), noticeKey: null, capturedThisTurn: [] };
      // No new required DSH service: older/mocked hosts without this read face
      // retain all existing functions and conservatively omit pre-injection.
      if (typeof session.eventAt === 'function' && Number.isSafeInteger(session.seq) && session.seq >= 0 &&
        Number.isSafeInteger(session.inheritedEventCount) && session.inheritedEventCount >= 0 && session.inheritedEventCount <= session.seq) {
        state.historyAvailable = true;
        try {
          for (let seq = session.inheritedEventCount; seq < session.seq; seq++) {
            const event = session.eventAt(seq);
            if (!event || event.seq !== seq) { state.historyAvailable = false; break; }
            foldTurnMetadata(state, event, session.inheritedEventCount);
            state.observedSeq = seq;
          }
        } catch { state.historyAvailable = false; recentFailures++; }
        if (state.currentStart) {
          state.turn = state.currentStart.data.turn;
          state.participating = config.participation === 'interactive' && state.inputHuman;
        }
      }
      states.set(session, state);
    }
    return state;
  }

  function roundKey(sessionId, turnId) { return JSON.stringify([sessionId, String(turnId)]); }

  function verifyRound(header, inheritedEventCount, events, turnId, proof) {
    if (!isMainHeader(header, header?.id) || !Number.isSafeInteger(inheritedEventCount) || inheritedEventCount < 0) return false;
    if (config.participation !== 'interactive' || (config.sessionScope === 'owner' && header.id !== config.ownerSessionId)) return false;
    let start, end;
    for (const event of events) {
      if (event.seq < inheritedEventCount || String(event.data?.turn) !== String(turnId)) continue;
      if (event.type === 'turn/start') { if (start) return false; start = event; }
      if (event.type === 'turn/end') { if (end) return false; end = event; }
    }
    if (!start || !end || start.seq >= end.seq || end.data?.reason?.kind !== 'completed') return false;
    const captures = [];
    let humanSeen = false, hasUserText = false, hasAssistantText = false, omittedNonText = false, totalBlocks = 0;
    for (const event of events) {
      if (event.seq <= start.seq || event.seq >= end.seq) continue;
      if (event.type === 'turn/start' || event.type === 'turn/end') return false;
      if (event.type !== 'user/message' && event.type !== 'assistant/message') continue;
      if (event.surfaceOp !== 'append') continue;
      const role = event.type === 'user/message' ? 'user' : 'assistant';
      const message = role === 'user' ? event.data : event.data?.message;
      if (role === 'user') {
        if (!isHumanMessage(message)) continue; // Do not inspect injected/solitude bodies.
        humanSeen = true;
      } else {
        if (!humanSeen) continue;
        if (event.data.interrupted || String(event.data.turn) !== String(turnId)) return false;
      }
      if (message?.role !== role || typeof message.id !== 'string' || !message.id || !Array.isArray(message.content)) return false;
      const parts = [];
      for (let index = 0; index < message.content.length; index++) {
        const block = message.content[index];
        if (block?.type === 'text' && typeof block.text === 'string') parts.push({ text: block.text, index });
        else if (!(role === 'assistant' && ['reasoning', 'tool-call'].includes(block?.type))) omittedNonText = true;
      }
      totalBlocks += parts.length;
      if (totalBlocks > 4096 || captures.length >= 4096) return false;
      if (!parts.length) continue;
      const id = captureId(config.instanceId, header.id, message.id);
      const records = parts.map(({ text, index }) => ({ id: parts.length === 1 ? id : `${id}-part-${index}`,
        sessionId: header.id, turnId: String(turnId), role, text, pool: 'a', recordedAt: new Date(event.time).toISOString(), occurredAt: null,
        sourceRoot: id, sourceNature: role === 'user' ? 'user_statement' : 'model_output', tags: [`dsh:text-part:${index}`] }));
      if (!store.verifyCaptureMessage({ id, pool: 'a', role, records })) return false;
      captures.push({ id, role, seq: event.seq });
      if (parts.some(part => part.text.length > 0)) { if (role === 'user') hasUserText = true; else hasAssistantText = true; }
    }
    if (!hasUserText || !hasAssistantText) return false;
    store.recordCompletedRound({ sessionId: header.id, turnId: String(turnId), startedAt: new Date(start.time).toISOString(), completedAt: new Date(end.time).toISOString(),
      startSeq: start.seq, endSeq: end.seq, reason: 'completed', captures, omittedNonText, proof });
    verifiedRounds.add(roundKey(header.id, turnId));
    if (verifiedRounds.size > 4096) verifiedRounds.delete(verifiedRounds.values().next().value);
    return true;
  }

  function recordLiveRound(session, event, state) {
    if (!state.historyAvailable || !state.currentStart || event.data?.reason?.kind !== 'completed' ||
      !isMainHeader(session.header, session.id) || !isEligibleAgent(ctx.agents.get(session.id))) return;
    try {
      const events = [];
      for (let seq = state.currentStart.seq; seq <= event.seq; seq++) {
        const item = session.eventAt(seq);
        if (!item || item.seq !== seq) return;
        events.push(item);
      }
      verifyRound(session.header, session.inheritedEventCount, events, event.data.turn, 'live');
    } catch { recentFailures++; } // Optional indexing must never stop a model turn.
  }

  function optionalSessionQuery() {
    // Cordis rejects direct undeclared service property access, even with ?.
    // get() is its public optional lookup; plain fixtures have no such method.
    return typeof ctx.get === 'function' ? ctx.get('sessionQuery') : ctx.sessionQuery;
  }

  async function readLegacyWithinBudget(query, sessionId, deadline, signal) {
    if (signal.aborted || closed) return { status: 'aborted' };
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { status: 'timeout' };
    let timer, onAbort;
    const interrupted = new Promise(resolve => {
      timer = setTimeout(() => resolve({ status: 'timeout' }), remaining);
      onAbort = () => resolve({ status: 'aborted' });
      signal.addEventListener('abort', onAbort, { once: true });
    });
    // DSH readSession has no AbortSignal argument. A timed-out underlying read
    // may finish later; its result/rejection is consumed and never processed.
    const reading = Promise.resolve().then(() => query.readSession(sessionId))
      .then(history => ({ status: 'ready', history }), () => ({ status: 'error' }));
    try { return await Promise.race([reading, interrupted]); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); }
  }

  async function selectRecent(session, state, signal) {
    const firstTurnId = String(state.currentStart.data.turn), asOf = new Date(state.currentStart.time).toISOString();
    const firstStartSeq = state.currentStart.seq;
    const existing = store.readPreinject({ targetSessionId: session.id, turnId: firstTurnId, maxCodePoints: config.recentTurnMaxChars, maxBlocks: 32 });
    if (existing !== null) return existing;
    let pending = recentSelections.get(session.id);
    if (!pending) {
      const controller = new AbortController();
      recentReadControllers.set(session.id, controller);
      const cancel = () => controller.abort();
      if (signal?.aborted) cancel();
      else signal?.addEventListener('abort', cancel, { once: true });
      pending = (async () => {
        const candidates = store.listPreinjectCandidates({ excludeSessionId: session.id, asOf, limit: 32 });
        const groups = new Map(), deadline = Date.now() + LEGACY_READ_BUDGET_MS;
        // Raw timestamp ordering is not completion ordering. Verify the whole
        // bounded set within the time budget, then choose by actual completedAt.
        for (const candidate of candidates.items) {
          if (verifiedRounds.has(roundKey(candidate.sessionId, candidate.turnId)) || candidate.metadataTruncated) continue;
          if (config.sessionScope === 'owner' && candidate.sessionId !== config.ownerSessionId) continue;
          if (!groups.has(candidate.sessionId)) groups.set(candidate.sessionId, []);
          groups.get(candidate.sessionId).push(candidate);
        }
        // Retain metadata for 32 candidates, but only ONE full cold session at
        // a time. The host API reads the candidate session's whole log.
        legacy: for (const [sessionId, group] of groups) {
          if (closed || controller.signal.aborted) return;
          try {
            const query = optionalSessionQuery();
            if (typeof query?.readSession !== 'function') { legacyUnavailable = true; break; }
            const result = await readLegacyWithinBudget(query, sessionId, deadline, controller.signal);
            if (closed || controller.signal.aborted || result.status === 'aborted') return;
            if (result.status === 'timeout') { legacyTimeouts++; break; }
            if (result.status === 'error') { recentFailures++; continue; }
            const { history } = result;
            if (history?.session?.id !== sessionId || !Array.isArray(history.events)) { recentFailures++; continue; }
            for (const candidate of group) {
              if (Date.now() >= deadline) { legacyTimeouts++; break legacy; }
              verifyRound(history.session, history.inheritedEventCount, history.events, candidate.turnId, 'verified_history');
            }
          } catch { recentFailures++; }
        }
        if (closed || controller.signal.aborted || state.currentStart?.seq !== firstStartSeq) return;
        store.selectPreinject({ targetSessionId: session.id, firstTurnId, asOf });
      })();
      recentSelections.set(session.id, pending);
      pending.finally(() => {
        signal?.removeEventListener('abort', cancel);
        if (recentSelections.get(session.id) === pending) recentSelections.delete(session.id);
        if (recentReadControllers.get(session.id) === controller) recentReadControllers.delete(session.id);
      }).catch(() => {});
    }
    await pending;
    if (closed || signal?.aborted || state.currentStart?.seq !== firstStartSeq) return null;
    return store.readPreinject({ targetSessionId: session.id, turnId: firstTurnId, maxCodePoints: config.recentTurnMaxChars, maxBlocks: 32 });
  }

  function onInboxClaimed({ agent, message, turn } = {}) {
    if (config.participation !== 'interactive' || !isEligibleAgent(agent)) return;
    const state = stateFor(agent.session);
    if (state.currentStart?.data.turn !== turn || !isHumanMessage(message)) return;
    state.inputHuman = true;
    state.participating = true;
    state.query = redactText((message.content ?? []).filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')).text.slice(0, 8000);
    state.querySeq = message.id;
  }

  function onSessionEvent(session, event) {
    if (!isEligibleSession(session)) return;
    if (!event || !Number.isSafeInteger(event.seq) || event.seq < 0 || !Number.isSafeInteger(event.time) || event.time < 0) throw new TypeError('invalid committed session event envelope');
    if (typeof session.isOwnSeq !== 'function' || !session.isOwnSeq(event.seq)) return;
    const state = stateFor(session);
    if (event.type === 'turn/start' || event.type === 'turn/end') recentReadControllers.get(session.id)?.abort();
    if (event.type === 'turn/end') recordLiveRound(session, event, state);
    if (state.historyAvailable && event.seq > state.observedSeq) {
      foldTurnMetadata(state, event, session.inheritedEventCount);
      state.observedSeq = event.seq;
    }
    if (event.type === 'turn/start') {
      state.previousQuery = state.query; state.query = ''; state.related = null; state.relatedKey = null; state.relatedResult = null;
      state.recallUnavailable = false;
      state.seenEntries.clear(); state.seenRaw.clear(); state.capturedThisTurn = [];
      state.turn = event.data.turn; state.participating = false; state.recallCue = false; state.toolCalls.clear(); return;
    }
    if (event.type === 'turn/end') { state.turn = null; state.participating = false; state.recallCue = false; state.toolCalls.clear(); return; }
    if (event.type === 'tool/call') {
      if (event.data?.turn === state.turn && typeof event.data.callId === 'string' && typeof event.data.name === 'string') state.toolCalls.set(event.data.callId, event.data.name);
      return;
    }
    const role = { 'user/message': 'user', 'assistant/message': 'assistant', 'tool/result': 'tool' }[event.type];
    if (!role || event.surfaceOp !== 'append') return;
    const message = role === 'user' ? event.data : event.data?.message;
    if (!message || message.role !== role || typeof message.id !== 'string' || !message.id || !Array.isArray(message.content)) throw new TypeError('invalid committed message');
    // 0.2.0-rc.2 UserQuestionService.answer creates this user source for a
    // completed human answer. Other user-role injections remain nonhuman.
    const isHuman = role === 'user' && isHumanMessage(message);
    if (isHuman && config.participation === 'interactive' && state.turn !== null) state.participating = true;
    const sameTurn = role === 'user' || event.data.turn === state.turn;
    const participates = config.participation === 'interactive' && (isHuman || (state.participating && sameTurn && role !== 'user'));
    let originTool;
    if (participates && role === 'tool') {
      const toolName = originTool = state.toolCalls.get(message.toolCallId);
      // Search/read outputs are derived copies, not new original evidence.
      // PTC's run_code may mix nested memory outputs; fail closed on that
      // transport and on a missing call seen after loading mid-turn.
      if (!toolName) return { skipped: 'unknown_tool_origin' };
      if (Object.hasOwn(toolSchemas, toolName) || toolName === 'memory_tools' || toolName === 'run_code') return { skipped: 'derived_memory_or_transport' };
    }
    // Drop content BEFORE crossing the storage boundary for B; never serialize it.
    // Each textual block remains a separate original so no invented join can
    // become evidence. Attachments, reasoning, and tool-call blocks are omitted.
    const parts = participates ? message.content.flatMap((block, index) => block?.type === 'text' && typeof block.text === 'string' ? [{ text: block.text, index }] : []) : [];
    // Only an interactive human message can supply a recall cue. Solitude text
    // is never inspected; retain only a turn-local boolean, never a query/body.
    if (isHuman && participates) {
      state.recallCue ||= parts.some(part => recallCue.test(part.text));
      const query = redactText(parts.map(part => part.text).join('\n')).text.slice(0, 8000);
      if (state.query !== query || state.querySeq !== message.id) { state.related = null; state.relatedKey = null; }
      state.query = query; state.querySeq = message.id;
    }
    const id = captureId(config.instanceId, session.id, message.id);
    const pool = participates ? 'a' : 'b';
    const record = {
      id, sessionId: session.id,
      ...(state.turn === null ? {} : { turnId: String(state.turn) }),
      role, text: '', pool, recordedAt: new Date(event.time).toISOString(), occurredAt: null,
      sourceRoot: id,
      sourceNature: role === 'user' ? 'user_statement' : role === 'assistant' ? 'model_output' : 'tool_result',
      ...(originTool ? { tags: [`dsh:tool:${originTool}`] } : {}),
    };
    try {
      // Claim message pool + every part in ONE canonical transaction. This also
      // persists an empty A claim: an unsupported attachment cannot later turn
      // into B statistics merely because participation changed after restart.
      const records = participates ? parts.map(({ text, index }) => ({ ...record, text,
        ...(role === 'assistant' ? repeatedMemorySpans(store, state, text) : {}),
        id: parts.length === 1 ? id : `${id}-part-${index}`, tags: [...(record.tags ?? []), `dsh:text-part:${index}`] })) : [record];
      const result = store.captureMessage({ id, pool, role, records });
      if (participates && parts.length) {
        state.capturedThisTurn.push(...records.map(item => item.id));
        const text = parts.map(item => item.text).join('\n');
        if (typeof store.requestEarlyReview === 'function' && /安装|装好|升级|更新版本|修好|修复|接通|配置成功|验证通过|学会|解决了|决定|承诺|更正|说错|纠正/u.test(text)) {
          // A cue creates pending work only. It is not a distilled fact or a
          // claim that the task really succeeded.
          try { store.requestEarlyReview({ requestId: `cue-${id}`, rawIds: records.map(item => item.id).slice(0, 20), reason: '本轮出现环境/决定/更正/学习线索，请阅读原文判断是否提炼A2或记录D；线索本身不证明事实。' }); }
          catch { state.reviewRequestFailed = true; }
        }
      }
      if (participates && !parts.length) {
        omittedMessages.add(id);
        return { ...result, skipped: 'unsupported_nontext' };
      }
      return result;
    }
    catch (error) { captureFailed = true; throw error; }
  }

  async function assemble(_assembly, context, next) {
    const assembly = await next();
    if (!isEligibleAgent(context?.agent) || context.scope !== context.agent) return assembly;
    if (!assembly || !Array.isArray(assembly.sections)) throw new TypeError('invalid DSH prompt assembly');
    // Only previously approved, due A2 versions may leave the active pool.
    // This maintenance never approves an item or generates A3/model messages.
    store.cleanupA1({ apply: true });
    store.retireA2({ apply: true });
    store.cleanupB2({ apply: true });
    // Always contribute to EACH new assembly. Stable names replace old copies,
    // never skip unchanged text: skipped text would disappear from the prompt.
    const session = context.agent.session, state = stateFor(session);
    let recentText = '';
    if (config.participation === 'interactive' && state.historyAvailable && state.inputHuman &&
      isMainHeader(session.header, session.id) && state.currentStart?.seq === state.firstOwnStart?.seq) {
      try {
        const startSeq = state.currentStart.seq;
        const snapshot = await selectRecent(session, state, context.signal);
        // An awaited historical read may outlive a canceled first turn.
        if (!closed && state.currentStart?.seq === startSeq && isEligibleAgent(context.agent)) {
          recentText = buildRecentTurnData(snapshot, { maxChars: config.recentTurnMaxChars, timezone: store.timezone });
        }
      } catch { recentFailures++; }
    }
    if (closed || !isEligibleAgent(context.agent)) return assembly;
    // Filter after the awaited legacy lookup as concurrent assemblies may share
    // one result object. The replacement and all pushes below are synchronous.
    assembly.sections = assembly.sections.filter((section) => ![WAKE_SECTION, CORE_SECTION, PREFERENCE_SECTION, RECALL_SECTION, RECENT_TURN_SECTION, RELATED_SECTION].includes(section.name));
    const wakeIndex = assembly.sections.length + (recentText ? 1 : 0);
    if (recentText) assembly.sections.push({ name: RECENT_TURN_SECTION, text: recentText, interpolate: false });
    const warning = (captureFailed ? '警告：本次运行发生记忆采集失败，记录可能不完整，请检查宿主错误日志。\n' : '')
      + (omittedMessages.size ? `本次运行已跳过 ${omittedMessages.size} 条无文本的交互消息；附件未保存。\n` : '')
      + (store.projectionStatus().pending ? '数据库已提交；部分派生文件待修复，请运行管理员 rebuild。\n' : '')
      + (recentFailures ? '最近一轮的部分完成证据无法核验，已保守跳过；未补写原文。\n' : '')
      + (legacyTimeouts ? '旧轮核验超时，已跳过未完成核验的候选；近期原文可能未预注入。\n' : '')
      + (legacyUnavailable ? '宿主缺少只读历史接口；升级前未验证的旧轮未预注入。\n' : '')
      + (backupInitError || backupManager?.status()?.settingsError || backupManager?.status()?.lastError
        || backupManager?.status()?.scheduler?.lastError ? '备份设置或最近操作需要检查；主记忆继续写入，请查看设置中的肥鱼记忆备份页面。\n' : '');
    if (config.autoRecall && config.participation === 'interactive' && state.participating && state.query) {
      const key = `${state.turn}:${state.querySeq}`;
      if (state.relatedKey !== key) {
        state.relatedKey = key;
        state.related = (async () => {
          try {
            const result = searchRecall(store, { query: state.query, context: state.previousQuery, limit: config.recallLimit,
              excludeRawIds: state.capturedThisTurn, excludeSessionId: session.id, excludeTurnId: state.turn });
            if (result.method === 'no_substantive_query') return result;
            const bank = config.semanticEndpoint && config.semanticModel ? semanticCandidates(store, { resolvedTime: result.resolvedTime }) : [];
            const semantic = await semanticRecall(state.query, result.items, context.signal, bank);
            return { ...result, ...semantic, items: semantic.items.slice(0, config.recallLimit) };
          } catch { return { items: [], unavailable: true }; }
        })();
      }
      const cached = await state.related;
      if (closed || context.signal?.aborted || !isEligibleAgent(context.agent) || state.relatedKey !== key) return assembly;
      // A correction/update during this same turn must take effect immediately,
      // while optional embedding work remains cached for the human input.
      let related;
      try { related = { ...cached, items: refreshRecall(store, cached.items) }; }
      catch { related = { items: [], unavailable: true }; }
      state.relatedResult = related;
      const relatedText = buildRecallData({ ...related, items: related.items.filter(item => !['b3', 'c'].includes(item.pool)) }, { maxChars: config.recallMaxChars, timezone: store.timezone });
      if (relatedText) assembly.sections.push({ name: RELATED_SECTION, text: relatedText, interpolate: false });
      state.recallUnavailable = Boolean(related.unavailable);
    }
    const query = config.autoRecall && state.participating ? state.query : '';
    const selectedIds = state.relatedResult?.items ?? [];
    const coreText = buildCoreData(store, { maxChars: config.coreMaxChars, query, selectedIds });
    const preferenceText = buildPreferenceData(store, { maxChars: config.preferenceMaxChars, query, selectedIds });
    assembly.sections.push({ name: CORE_SECTION, text: coreText, interpolate: false });
    assembly.sections.push({ name: PREFERENCE_SECTION, text: preferenceText, interpolate: false });
    rememberSeen(state, [coreText, preferenceText, recentText, ...assembly.sections.filter(s => s.name === RELATED_SECTION).map(s => s.text)]);
    const status = { a1: store.listReviewQueue({ limit: 1 }).total, a2: store.listA2ReviewQueue({ limit: 1 }).total };
    const noticeKey = JSON.stringify(status), includeStatus = state.noticeKey !== noticeKey;
    state.noticeKey = noticeKey;
    const notices = [state.reviewRequestFailed ? '提前审查登记失败，请查询待办确认；原文采集仍独立保存。' : '',
      state.recallUnavailable ? '本轮自动召回不可用，可主动使用memory_search；正常对话继续。' : ''].filter(Boolean);
    assembly.sections.splice(wakeIndex, 0, { name: WAKE_SECTION, text: buildWake(store, { maxChars: config.wakeMaxChars, warnings: warning, includeStatus, notices, compactTools: config.toolMode === 'compact' }), interpolate: false });
    if (states.get(context.agent.session)?.recallCue) assembly.sections.push({ name: RECALL_SECTION,
      text: '本轮真人消息有回忆线索：只记得主体/事情就按关键词查，不强求时间；只记得时间就列时间范围内候选，两者都有结合。上星期说过用timeWindow:{preset:"last_week"},timeAxis:"mentioned"；发生过用occurred。按memory_search/memory_list→memory_read核对，扩大范围须明示，找不到不等于没发生。', interpolate: false });
    return assembly;
  }

  function close() {
    if (closed) return;
    closed = true;
    if (backupTimer) clearInterval(backupTimer);
    const backupClosing = Promise.all([backupApi?.close(), backupManager?.close()]);
    for (const controller of recentReadControllers.values()) controller.abort();
    const failures = [];
    for (const dispose of disposers.splice(0).reverse()) { try { dispose?.(); } catch (error) { failures.push(error); } }
    try { store.close(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'memory adapter disposal failed');
    return backupClosing;
  }

  try {
    toolSurface = createToolSurface({ mode: config.toolMode, schemas: toolSchemas, descriptions, register(toolName, parameters, description) {
      return ctx.tools.register({
        name: toolName, description, parameters,
        output: { schema: { description: '记忆工具 JSON；时间元数据按 timeZone 显示带偏移的本地时间，已换算，勿重复加减；历史原文不改写。' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        async execute(args, exec) {
          if (!isEligibleAgent(exec?.agent)) throw new Error('memory tool rejected: unexpected owner session or non-root profile agent');
          exec?.signal?.throwIfAborted();
          validateArguments(parameters, args);
          if (toolName === 'memory_tools') return toolSurface.enable(args.names ?? []);
          let result;
          try { result = tools[toolName](args); }
          catch (error) {
            if (error.code !== 'QUOTE_MISMATCH') throw error;
            return { committed: false, error: { code: error.code,
              message: '引文与保存的原文不一致。请按 candidates 的位置读取精确文字，保留标点和 Markdown 后重新提交；本次未写入。',
              ...error.details } };
          }
          rememberSeen(stateFor(exec.agent.session), result);
          // Native DSH requires lossless JSON; omit optional undefined fields.
          return JSON.parse(JSON.stringify(result));
        },
      });
    } });
    disposers.push(() => toolSurface.close());
    toolSurface.start();
    disposers.push(ctx.on('session/event', onSessionEvent));
    disposers.push(ctx.on('agent/inbox/claimed', onInboxClaimed));
    disposers.push(ctx.on('system-prompt/assemble', assemble));
    try {
      backupManager = createBackupManager({ dataDir: config.dataDir, expectedInstanceId: config.instanceId,
        timezone: config.timezone, fallbackSettings: { enabled: config.backupEnabled, backupDir: config.backupDir,
          intervalDays: config.backupIntervalDays, schedule: config.backupSchedule } });
      backupApi = registerBackupRoutes(ctx, backupManager, {
        dataDir: config.dataDir, instanceId: config.instanceId, timezone: config.timezone
      });
      const checkBackup = () => { if (!closed) void backupManager.check().catch(() => {}); };
      // A disabled schedule is cheap to check; saved UI settings can take effect without a restart.
      backupTimer = setInterval(checkBackup, 60000);
      backupTimer.unref?.();
      checkBackup();
    } catch (error) {
      // Optional management UI and backup configuration must never disable primary capture.
      backupInitError = /^[A-Z0-9_]{1,80}$/.test(error?.code ?? '') ? error.code : 'BACKUP_INIT';
    }
  } catch (error) { close(); throw error; }
  return { store, tools, close, onSessionEvent, diagnostics: () => ({ captureFailed, unsupportedMessages: omittedMessages.size,
    toolMode: config.toolMode, enabledMemoryTools: toolSurface?.catalog().enabled.length ?? 0,
    recentTurnFailures: recentFailures, legacyPreinjectUnavailable: legacyUnavailable, legacyPreinjectTimeouts: legacyTimeouts,
    backup: backupManager?.status()?.scheduler ?? { enabled: config.backupEnabled, lastError: backupInitError },
    backupManagement: backupManager?.status() ?? null, backupUi: backupApi?.diagnostics() ?? { available: false },
    projection: store.projectionStatus() }) };
}

/** Cordis named exports and default plugin object both retain injection metadata. */
// Cordis treats constructible functions as classes. Arrow form ensures the
// returned disposer is collected as the plugin's lifecycle effect.
export const apply = (ctx, config) => createHostAdapter(ctx, config).close;
export default { name, inject, Config, apply };
