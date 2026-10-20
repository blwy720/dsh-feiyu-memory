import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { initializeB2, writeB2, getB2, listB2, cleanupB2, projectB2 } from './b2.js';
import { initializePreinject, recordCompletedRound, listPreinjectCandidates, selectPreinject, readPreinject } from './preinject.js';
import { POLICY_VERSION, initializePolicy, explicitStatement, normalizeBody, sourceTimes, dependencyEntries, decoratePolicy, inPreferenceScope, requestEarlyReview, applyCorrection, assertCore } from './policy.js';

const SCHEMA = 6;
const REVIEW_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const A2_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CORE_CATEGORIES = new Set(['identity', 'relationship', 'boundary', 'commitment', 'turning_point', 'other']);
const RECOVERABLE_IO = new Set(['EPERM', 'EACCES', 'EBUSY', 'EAGAIN', 'ENOSPC', 'EDQUOT', 'EMFILE', 'ENFILE']);
const UUID_SUFFIX = /\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i;
const ROLES = new Set(['user', 'assistant', 'tool']);
const KINDS = new Set(['memory', 'doing', 'entity', 'relation', 'preference', 'a3', 'b2']);
const PREFERENCE_STANCES = new Set(['like', 'dislike', 'neutral', 'mixed']);
const SUPPORTS = new Set(['unassessed', 'supports', 'contradicts', 'context_only']);
const DICTIONARY = '# 肥鱼记忆字典 v1\n\n本版使用完整中文，不使用压缩符号。\n\n- raw：原始消息，仅表示对应角色当时说过什么。\n- memory：人工写入的记忆条目。\n- doing：最后已知的事项状态；不代表当前已确认。\n- entity：人工维护的实体与别名，不自动合并。\n- quote_verified：仅表示引文在原文逐字命中，不表示主张成立。\n- unverified：缺少原始证据或审计未通过。\n- sourceRoot：可识别的来源沿袭；不同值不自动代表独立。\n\n字典版本不可原地改变。未来变更须创建新的版本。\n';
export const DICTIONARY_V2 = '# 肥鱼记忆字典 v2\n\n- A1：交互原文，存储 pool=a；按 recordedAt 满 168 小时后进入自审查队列，发生时间独立保留。\n- A2：自审查提取或普通写入的记忆、事项、实体、关系；默认归属，不自动进入核心。\n- B：独处统计，仅按日期、角色和小时聚合，不保存正文。\n- B3：肥鱼自己的喜好，kind=preference、subject=self、sourceNature=model_self_report；只记录明确自述，可修改、撤回或恢复，每次决定保留历史。B3 不会开启 B 池全文保存。\n- self_report：喜好自述，不是经事实验证的结论。B3 可不附来源；可选原文只作为 context_only，上下文引文是否命中由 contextEvidenceStatus 单独表示。\n- C：仅核心关系网的 entity 节点和 relation 有向边；肥鱼可用有理由、有版本的独立决策自主晋升或撤销。普通 memory、doing 和 preference 不得加入 C。\n- 自审查：逐条有原文产物或明确省略理由，原子提交并保存不可变审查记录；不授予删除原文的权限。\n- relation：from → to 表示该方向的关系；不补反向边、不推导传递关系，别名不自动合并实体。\n- quote_verified：仅表示引文逐字定位到原文，不证明主张成立。supports 是支持关系的声明，也不是事实验证。\n- sourceRoot：来源沿袭标识；不同标识不自动代表独立。重复读取或重复摘要不增加可信度。\n- currentValidity=unknown：历史陈述、核心选择和喜好自述均不证明当前仍有效。\n- archive：C 的不可变版本历史；撤销后历史 C 版本留存，当前条目回到 a2。\n- b3：喜好的不可变版本历史；撤回后当前版本标 archived，历史喜好仍可查。\n\n字典版本不可原地改变。v1 和旧版本条目原样保留。\n';
export const DICTIONARY_V3 = DICTIONARY_V2.replace('肥鱼记忆字典 v2', '肥鱼记忆字典 v3')
  .replace('- B：', '- A2 活动池：最新版本记录满 30×24 小时后待清理；未明确审查先保留。批准后只退出活动索引和当前投影，原文、不可变版本与证据历史保留，不是物理擦除。归档覆盖声明不等于清理批准。\n- A3：仅从当前 A2 条目再次提纯关键信息，kind=a3、pool=a3、depth=2；只在显式 memory_a3_write 调用后产生。不允许原文直接进入 A3、A3 作为后续层输入或进入 C。\n- derived_only：A3 永远是归纳而非原始证据，不得标为 quote_verified。推断必须标 statementType=inference 并写明推理和不确定性；用户或助手原话均不自动成为事实。\n- derivedFrom/sourceEntries：A2 父条目 ID 与精确版本、哈希及读取指针；只需两步即可追查 A2 与其原文。缺失或无效原文标 lineageBroken；当前父条目归档、退休或移池标 orphaned，A3 本身保留。\n- coverage：必须声明此次审查的 scope 精确版本，covered 必须等于 derivedFrom，每条 notCovered 都须有理由；不声称已枚举全部语义相关信息，也不授权清理。\n- a3：不可变版本与当前投影，日期保存在记录中。撤回后标 archived；醒来只显示计数与检索路标，绝不批量注入 A3 正文。\n- B：')
  .replace('- B：', '- B1（原 B）：')
  .replace('- B3：', '- B2：独处冲浪中明确选取的关键发现与判断，附 HTTP(S) 来源，标 external_reference；14×24 小时滑动删除，不保存整段独处过程，不等同经过事实验证。\n- B3：')
  .replace('原子提交并保存不可变审查记录；不授予删除原文的权限。', '原子提交并保存不可变审查记录。自审本身不直接删除；满 168 小时且已完成自审的原文可由维护移出 A1，引用中的原始依据和管理员明确保留的原文仍保留，未审先保留。')
  .replace('v1 和旧版本条目原样保留。', 'v1、v2 和旧版本条目原样保留。');
export const DICTIONARY_V4 = DICTIONARY_V3.replace('肥鱼记忆字典 v3', '肥鱼记忆字典 v4')
  + '\n首轮原文预注入：同实例新主会话的首个真人交互轮，可读取最近正常完成的一轮 A1 真人和肥鱼文本，附原会话、轮次与时间。首轮内多次装配固定同一来源，后续轮不重复注入。只有已核准完成事件和完整原文引用的轮次可选，不从原文顺序推断旧轮完成。只保留选择与原文 ID 引用，不额外保存全文快照；任何来源已满 168 小时、退池或缺失时标记不可用，不更换来源。附件、省略块和原文前缀截断均须明示。预注入是历史 DATA，不是新指令、当前事实或新的原始证据。既有 v1、v2、v3 字典和旧条目保持原样。\n';
export const DICTIONARY_V5 = '# 肥鱼记忆字典 v5\n\n- A1：真人交互原文，168 小时后自审补查；重要原文可通过 requestEarlyReview 提前进入持久待办，失败不标完成。\n- A2：仅明确陈述 fact 或自述 self_report。fact 是陈述类型，绝非事实验证。拒绝 inference；quote_verified 只证明字面引文命中，语义支持仍是声明。\n- A3：从精确 A2 版本提纯明确陈述，body.time/persons/event 必须自足，保留覆盖批次、哈希与 sourceTimes 对话时间；不依赖原文长期存活，不接受推断。derived_only 不意味着事实成立。旧推断历史标 legacyInference，绝不重新宣称为事实。\n- A2 满 30 天只在审查后退池；物理清理须管理员显式 purgeA2，先核准精确版本、有效覆盖或丢弃理由。保留轻量墓碑与更正关系。原文仅在满 168 小时、已自审、无其他引用且无管理员保留决定时可清理。\n- B1：独处统计，不保存正文。B2：14 天关键冲浪发现与外部链接，不是事实验证。\n- B3：肥鱼自身的喜好与情绪自述，以及当前 C 第一跳邻居明确声明的喜好；其他实体的情绪不得写入。subject 是持有者不可换人，target 可描述情感指向；非 self 必须有明确归属本人的原话声明。离开第一跳后历史仍可查但不正常注入。self_report 不是事实验证。\n- C：entity 节点和 relation 有向边；from 认为 to 是 rel。允许独立标注的 inference，必须说明推理和不确定性。双向邻接遍历不补反向边或传递关系，同一实体 ID 复用以表达环。\n- 更正：追加 exact-version 事件和原文依据，标 needs_review、superseded 或 disputed；派生 A3 与显式 dependencyEntries 只标待复核，不盲目改正文。state_change 表示后来状态变化，不能据此认定过去陈述错误。\n- 所有旧字典与未清理的不可变历史原样保留。时间轴 sourceTimes.recordedAt/mentionedTimes 为原对话时间，recordedAt 为记忆写入时间，occurredAt 为声明的事件时间。\n';

function requiredString(value, name, max = 1000000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw new TypeError(`${name} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function identifier(value, name = 'id') {
  requiredString(value, name, 200);
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._:@-]*$/u.test(value)) throw new TypeError(`Invalid ${name}`);
  return value;
}

function stringList(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1000) throw new TypeError(`${name} must be an array`);
  return [...new Set(value.map(item => requiredString(item, name, 1000)))];
}

function optionalString(value, name) {
  return value === undefined || value === null ? null : requiredString(value, name, 2000);
}

function archiveLabels(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) throw new TypeError(`${name} must contain at most 20 strings`);
  return [...new Set(value.map(item => requiredString(item, name, 200)))];
}

export function validateDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TypeError('Date must be YYYY-MM-DD');
  const instant = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString().slice(0, 10) !== value) throw new TypeError('Invalid calendar date');
  return value;
}

function instant(value, name) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new TypeError(`Invalid ${name}`);
    return value.toISOString();
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new TypeError(`${name} must be an ISO timestamp with timezone`);
  }
  validateDate(value.slice(0, 10));
  if (+value.slice(11, 13) > 23 || +value.slice(14, 16) > 59 || +value.slice(17, 19) > 59) throw new TypeError(`Invalid ${name}`);
  if (/[+-]\d{2}:\d{2}$/.test(value) && (+value.slice(-5, -3) > 23 || +value.slice(-2) > 59)) throw new TypeError(`Invalid ${name}`);
  const result = new Date(value);
  if (!Number.isFinite(result.getTime())) throw new TypeError(`Invalid ${name}`);
  return result.toISOString();
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

function digest(value) { return createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex'); }
function parse(row) { return row ? JSON.parse(row.json) : null; }
function jsonl(records) { return records.map(record => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''); }
function pageArgs(limit, offset, maximum = 100) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum || !Number.isSafeInteger(offset) || offset < 0) throw new TypeError('Invalid pagination');
}
function clipped(value, length) {
  if (value == null) return value;
  const text = String(value);
  if (text.length <= length) return text;
  let end = length - 1;
  if (/[\uD800-\uDBFF]/u.test(text[end - 1] ?? '')) end--;
  return text.slice(0, end) + '…';
}
function readPointer(id, version) { return { tool: 'memory_read', arguments: { id, ...(version === undefined ? {} : { version }) } }; }

/** No global instance state. SQLite is authoritative; all other files are projections. */
export class MemoryStore {
  #retentionDeleteIds = new Set();
  #entryPurgeIds = new Set();
  #originalPurgeIds = new Set();
  constructor({ dataDir, instanceId, timezone = 'Asia/Shanghai', now = () => new Date() } = {}) {
    requiredString(dataDir, 'dataDir', 32767);
    this.instanceId = identifier(instanceId, 'instanceId');
    this.timezone = requiredString(timezone, 'timezone', 100);
    this._clock = now;
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this._formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
    this.dataDir = path.resolve(dataDir);
    this._assertPath(this.dataDir);
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this._assertPath(this.dataDir);
    this._closed = false;
    const manifestPath = this.safePath('identity.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.instanceId !== this.instanceId || manifest.timezone !== this.timezone) throw new Error('Memory identity/timezone mismatch');
    }
    const dbPath = this.safePath('memory.sqlite');
    for (const suffix of ['-wal', '-shm', '-journal']) this._assertPath(`${dbPath}${suffix}`);
    this.db = new DatabaseSync(dbPath);
    try {
      // Validate an existing identity before any persistent schema/pragma change.
      const hasMeta = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get();
      const identity = hasMeta ? this.db.prepare('SELECT value FROM meta WHERE key=?').get('identity') : null;
      const stored = identity ? JSON.parse(identity.value) : null;
      if (stored && (stored.instanceId !== this.instanceId || stored.timezone !== this.timezone || ![1, 2, 3, 4, 5, SCHEMA].includes(stored.schema))) throw new Error('Memory identity/timezone/schema mismatch');
      this.db.function('feiyu_retention_allowed', id => this.#retentionDeleteIds.has(id) ? 1 : 0);
      this.db.function('feiyu_entry_purge_allowed', (id, version) => this.#entryPurgeIds.has(`${id}:${version}`) ? 1 : 0);
      this.db.function('feiyu_original_purge_allowed', id => this.#originalPurgeIds.has(id) ? 1 : 0);
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA recursive_triggers=ON;');
      this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS raw (id TEXT PRIMARY KEY, date TEXT NOT NULL, json TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS raw_date ON raw(date);
        CREATE TABLE IF NOT EXISTS originals (id TEXT PRIMARY KEY, json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, pool TEXT NOT NULL, hash TEXT NOT NULL, json TEXT);
        CREATE TABLE IF NOT EXISTS b_stats (date TEXT NOT NULL, role TEXT NOT NULL, hour TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(date,role,hour));
        CREATE TABLE IF NOT EXISTS entries (id TEXT NOT NULL, version INTEGER NOT NULL, kind TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(id,version));
        CREATE TABLE IF NOT EXISTS evidence (entry_id TEXT NOT NULL, version INTEGER NOT NULL, raw_id TEXT NOT NULL, PRIMARY KEY(entry_id,version,raw_id));
        CREATE INDEX IF NOT EXISTS evidence_raw ON evidence(raw_id);
        CREATE TABLE IF NOT EXISTS reviews (seq INTEGER PRIMARY KEY AUTOINCREMENT, raw_id TEXT NOT NULL, decision TEXT NOT NULL, json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS recalls (seq INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS audits (seq INTEGER PRIMARY KEY AUTOINCREMENT, entry_id TEXT NOT NULL, version INTEGER NOT NULL, json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS dirty_days (date TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS projection_pending (path TEXT PRIMARY KEY, operation TEXT NOT NULL, error_code TEXT, updated_at TEXT NOT NULL, owner_pid INTEGER);
        CREATE TABLE IF NOT EXISTS captures (id TEXT PRIMARY KEY, pool TEXT NOT NULL, role TEXT NOT NULL, hash TEXT NOT NULL, json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS deletion_tombstones (raw_id TEXT PRIMARY KEY, review_seq INTEGER NOT NULL, decision TEXT NOT NULL, raw_hash TEXT NOT NULL, deleted_at TEXT NOT NULL, json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS integrity_audits (seq INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS memory_decisions (seq INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, entry_id TEXT, hash TEXT NOT NULL, json TEXT NOT NULL, result_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS self_review_completed (raw_id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES memory_decisions(request_id));
        CREATE TABLE IF NOT EXISTS a2_reviews (seq INTEGER PRIMARY KEY AUTOINCREMENT, entry_id TEXT NOT NULL, version INTEGER NOT NULL, request_id TEXT NOT NULL REFERENCES memory_decisions(request_id), json TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS a2_reviews_version ON a2_reviews(entry_id,version,seq);
        CREATE TABLE IF NOT EXISTS a2_retirements (entry_id TEXT NOT NULL, version INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY(entry_id,version));
        CREATE TRIGGER IF NOT EXISTS immutable_a2_reviews_update BEFORE UPDATE ON a2_reviews BEGIN SELECT RAISE(ABORT,'A2 reviews are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS immutable_a2_reviews_delete BEFORE DELETE ON a2_reviews BEGIN SELECT RAISE(ABORT,'A2 reviews are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS immutable_a2_retirements_update BEFORE UPDATE ON a2_retirements BEGIN SELECT RAISE(ABORT,'A2 retirements are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS immutable_a2_retirements_delete BEFORE DELETE ON a2_retirements BEGIN SELECT RAISE(ABORT,'A2 retirements are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS immutable_decisions_update BEFORE UPDATE ON memory_decisions BEGIN SELECT RAISE(ABORT,'memory decisions are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS immutable_decisions_delete BEFORE DELETE ON memory_decisions BEGIN SELECT RAISE(ABORT,'memory decisions are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS immutable_self_review_update BEFORE UPDATE ON self_review_completed BEGIN SELECT RAISE(ABORT,'self reviews are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS immutable_self_review_delete BEFORE DELETE ON self_review_completed BEGIN SELECT RAISE(ABORT,'self reviews are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS immutable_raw BEFORE UPDATE ON raw BEGIN SELECT RAISE(ABORT,'raw is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS immutable_raw_reinsert BEFORE INSERT ON raw WHEN EXISTS (SELECT 1 FROM raw WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'raw is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS immutable_originals_update BEFORE UPDATE ON originals BEGIN SELECT RAISE(ABORT,'originals are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS immutable_originals_delete BEFORE DELETE ON originals BEGIN SELECT RAISE(ABORT,'originals are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS immutable_entries_update BEFORE UPDATE ON entries BEGIN SELECT RAISE(ABORT,'entry versions are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS immutable_entries_delete BEFORE DELETE ON entries BEGIN SELECT RAISE(ABORT,'entry versions are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS immutable_tombstones_update BEFORE UPDATE ON deletion_tombstones BEGIN SELECT RAISE(ABORT,'deletion tombstones are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS immutable_tombstones_delete BEFORE DELETE ON deletion_tombstones BEGIN SELECT RAISE(ABORT,'deletion tombstones are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS guarded_raw_delete BEFORE DELETE ON raw BEGIN
          SELECT CASE WHEN feiyu_retention_allowed(OLD.id) <> 1 THEN RAISE(ABORT,'raw deletion requires retention API transaction') END;
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM deletion_tombstones d JOIN reviews r ON r.seq=d.review_seq JOIN receipts p ON p.id=OLD.id
            WHERE d.raw_id=OLD.id AND r.raw_id=OLD.id AND r.seq=(SELECT max(seq) FROM reviews WHERE raw_id=OLD.id) AND d.raw_hash=p.hash
            AND d.decision=CASE WHEN r.decision='retain' OR EXISTS(SELECT 1 FROM evidence WHERE raw_id=OLD.id) THEN 'retain' ELSE 'discard' END
          ) THEN RAISE(ABORT,'raw deletion requires matching review and tombstone') END;
          SELECT CASE WHEN (SELECT decision FROM deletion_tombstones WHERE raw_id=OLD.id)='retain'
            AND NOT EXISTS (SELECT 1 FROM originals WHERE id=OLD.id AND json=OLD.json)
            THEN RAISE(ABORT,'retained original must be rescued before deletion') END;
        END;
      `);
      if (!this.db.prepare('PRAGMA table_info(projection_pending)').all().some(column => column.name === 'owner_pid')) this.db.exec('ALTER TABLE projection_pending ADD COLUMN owner_pid INTEGER');
      initializePreinject(this);
      initializePolicy(this);
      this.db.exec(`
        DROP TRIGGER IF EXISTS immutable_entries_delete;
        CREATE TRIGGER immutable_entries_delete BEFORE DELETE ON entries BEGIN
          SELECT CASE WHEN feiyu_entry_purge_allowed(OLD.id,OLD.version)<>1 OR NOT EXISTS(SELECT 1 FROM a2_purges p WHERE p.entry_id=OLD.id AND p.version=OLD.version) THEN RAISE(ABORT,'entry versions are immutable; explicit reviewed purge required') END;
        END;
        DROP TRIGGER IF EXISTS immutable_originals_delete;
        CREATE TRIGGER immutable_originals_delete BEFORE DELETE ON originals BEGIN
          SELECT CASE WHEN feiyu_original_purge_allowed(OLD.id)<>1 OR NOT EXISTS(SELECT 1 FROM original_purges p WHERE p.raw_id=OLD.id) OR EXISTS(SELECT 1 FROM evidence e WHERE e.raw_id=OLD.id) THEN RAISE(ABORT,'originals are immutable; explicit unreferenced purge required') END;
        END;
      `);
      this._metadata = stored ? { ...stored, schema: SCHEMA } : { schema: SCHEMA, instanceId: this.instanceId, timezone: this.timezone, createdAt: this.now() };
      this.db.prepare('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('identity', JSON.stringify(this._metadata));
      if (stored?.schema === 1) {
        // v0.1.0 had no durable deletion tombstones. Do not invent proof of
        // authorization; invalidate possibly stale excerpts and audit gaps later.
        for (const row of this.db.prepare("SELECT r.json FROM receipts r LEFT JOIN raw a ON a.id=r.id WHERE r.pool='a' AND a.id IS NULL").all()) {
          const date = this._local(JSON.parse(row.json).recordedAt).date;
          this.db.prepare('INSERT OR IGNORE INTO dirty_days(date) VALUES (?)').run(date);
        }
      }
      this.db.exec('COMMIT');
      initializeB2(this);
      for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(`${dbPath}${suffix}`)) fs.chmodSync(`${dbPath}${suffix}`, 0o600);
      this.writeProjection('identity.json', JSON.stringify(this._metadata, null, 2) + '\n');
      this.flush();
    } catch (error) {
      this.db.close();
      this._closed = true;
      throw error;
    }
  }

  now() { return instant(this._clock(), 'now'); }
  metadata() { this._assertOpen(); return structuredClone(this._metadata); }
  writeB2(input) { const result = writeB2(this, input); this._projectEntryIndex(); return { ...result, projectionPending: this.projectionStatus().projectionPending }; }
  getB2(id, options) { return getB2(this, id, options); }
  listB2(options) { return listB2(this, options); }
  cleanupB2(options) { const result = cleanupB2(this, options); if (result.removed) this._projectEntryIndex(); return { ...result, projectionPending: this.projectionStatus().projectionPending }; }
  recordCompletedRound(input) { return recordCompletedRound(this, input); }
  listPreinjectCandidates(options) { return listPreinjectCandidates(this, options); }
  selectPreinject(input) { return selectPreinject(this, input); }
  readPreinject(input) { return readPreinject(this, input); }
  requestEarlyReview(input) { return requestEarlyReview(this, input); }
  applyCorrection(input) { return applyCorrection(this, input); }
  assertCore(input) { return assertCore(this, input); }
  _policyReplay(requestId, hash) { return this.#decisionReplay(requestId, hash); }
  _policySaveDecision(record, hash, result) { return this.#saveDecision(record, hash, result); }
  _commitPolicyEntry(record, options) { return this.#commitEntry(record, options); }
  _assertOpen() { if (this._closed) throw new Error('Memory store is closed'); }

  _local(iso) {
    const parts = Object.fromEntries(this._formatter.formatToParts(new Date(iso)).map(p => [p.type, p.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: parts.hour };
  }

  _assertPath(target) {
    const absolute = path.resolve(target);
    const parsed = path.parse(absolute);
    let current = parsed.root;
    for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) throw new Error(`Symlink paths are not allowed: ${current}`);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return absolute;
  }

  safePath(relative, { directory = false, create = true } = {}) {
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\0') || relative.includes(':') || relative.split(/[\\/]/).some(s => s === '..' || s === '.')) throw new TypeError('Unsafe relative path');
    const target = path.resolve(this.dataDir, relative);
    if (!target.startsWith(this.dataDir + path.sep)) throw new Error('Path escapes memory directory');
    this._assertPath(target);
    const parent = directory ? target : path.dirname(target);
    if (create) fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    this._assertPath(target);
    return target;
  }

  writeProjection(relative, content) {
    this._assertOpen();
    const target = this.safePath(relative, { create: false });
    this._queueProjection(relative);
    let temporaryRelative;
    try {
      this.safePath(relative);
      if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === content) {
        this._retryIo(() => fs.chmodSync(target, 0o600));
      } else {
        temporaryRelative = `${relative}.${randomUUID()}.tmp`;
        const temporary = this.safePath(temporaryRelative);
        // Register cleanup before writing any plaintext, including crash leftovers.
        this._queueProjection(temporaryRelative, 'cleanup', null, process.pid);
        fs.writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        this._retryIo(() => { this._assertPath(target); fs.renameSync(temporary, target); });
        this._retryIo(() => fs.chmodSync(target, 0o600));
      }
      this._clearProjection(relative);
    } catch (error) {
      if (!RECOVERABLE_IO.has(error.code)) throw error;
      this._queueProjection(relative, 'write', error.code);
    } finally {
      if (temporaryRelative) this._removeProjection(temporaryRelative, 'cleanup');
    }
    return target;
  }

  _retryIo(callback) {
    const delays = [0, 5, 15];
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt]) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delays[attempt]);
      try { return callback(); }
      catch (error) { if (!RECOVERABLE_IO.has(error.code) || attempt === delays.length - 1) throw error; }
    }
  }

  _queueProjection(relative, operation = 'write', errorCode = null, ownerPid = null) {
    this.db.prepare('INSERT INTO projection_pending(path,operation,error_code,updated_at,owner_pid) VALUES (?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET operation=excluded.operation,error_code=excluded.error_code,updated_at=excluded.updated_at,owner_pid=excluded.owner_pid').run(relative.replaceAll('\\', '/'), operation, errorCode, this.now(), ownerPid);
  }

  _clearProjection(relative) { this.db.prepare('DELETE FROM projection_pending WHERE path=?').run(relative.replaceAll('\\', '/')); }

  projectionStatus() {
    this._assertOpen();
    const paths = this.db.prepare('SELECT path,operation,error_code AS errorCode,owner_pid AS ownerPid FROM projection_pending ORDER BY path').all().map(row => ({ ...row }));
    return { projectionPending: paths.length > 0, pendingCount: paths.length, pending: paths.length > 0, count: paths.length, paths };
  }

  _writeResult(record) { return { ...record, committed: true, projectionPending: this.projectionStatus().projectionPending }; }

  _removeProjection(relative, operation = 'delete') {
    const target = this.safePath(relative, { create: false });
    if (operation === 'cleanup') {
      const pending = this.db.prepare('SELECT owner_pid FROM projection_pending WHERE path=?').get(relative);
      if (pending?.owner_pid && pending.owner_pid !== process.pid) {
        let alive = true;
        try { process.kill(pending.owner_pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
        if (alive) {
          this._queueProjection(relative, 'cleanup', 'OWNER_ALIVE', pending.owner_pid);
          return false;
        }
      }
    }
    this._queueProjection(relative, operation, null, operation === 'cleanup' ? process.pid : null);
    try {
      this._retryIo(() => { this._assertPath(target); if (fs.existsSync(target)) fs.unlinkSync(target); });
      this._clearProjection(relative);
      return true;
    } catch (error) {
      if (!RECOVERABLE_IO.has(error.code)) throw error;
      this._queueProjection(relative, operation, error.code, operation === 'cleanup' ? process.pid : null);
      return false;
    }
  }

  _ownedProjection(relative) {
    return /^(?:identity\.json|_wake\.md|dict\/v[12345]\.md|(?:a3|b2)\/index\.json|index\/(?:entries|projections)\.json|logs\/(?:recall|audit|retention|integrity|decisions|a2-retirement)\.jsonl|(?:a|b)\/\d{4}\/\d{2}\/\d{2}\/(?:raw\.jsonl|stats\.json|_day\.md)|(?:doing|entities|originals)\/[a-f0-9]{64}\.json|(?:archive|a2|a3|b2|b3)\/[a-f0-9]{64}\/(?:v\d+|current)\.json)$/.test(relative);
  }

  _cleanupTemps() {
    const walk = (directory, relative = '') => {
      let items;
      try { items = this._retryIo(() => fs.readdirSync(directory, { withFileTypes: true })); this._clearProjection(`@cleanup/${relative}`); }
      catch (error) {
        if (!RECOVERABLE_IO.has(error.code)) throw error;
        this._queueProjection(`@cleanup/${relative}`, 'scan', error.code); return;
      }
      for (const item of items) {
        const next = relative ? `${relative}/${item.name}` : item.name;
        if (item.isDirectory()) {
          if (relative || ['a', 'b', 'a2', 'a3', 'b2', 'b3', 'dict', 'index', 'logs', 'doing', 'entities', 'originals', 'archive'].includes(item.name)) walk(this._assertPath(path.join(directory, item.name)), next);
        } else if (UUID_SUFFIX.test(next) && this._ownedProjection(next.replace(UUID_SUFFIX, ''))) this._removeProjection(next, 'cleanup');
      }
    };
    walk(this.dataDir);
    // Include cleanup paths whose directory enumeration was interrupted earlier.
    for (const row of this.db.prepare("SELECT path FROM projection_pending WHERE operation='cleanup'").all()) {
      if (!UUID_SUFFIX.test(row.path) || !this._ownedProjection(row.path.replace(UUID_SUFFIX, ''))) throw new Error('Invalid owned temporary cleanup task');
      this._removeProjection(row.path, 'cleanup');
    }
  }

  _appendProjection(relative, record, wasPending = false, rebuild) {
    const target = this.safePath(relative, { create: false });
    this._queueProjection(relative);
    if (wasPending && rebuild) return this.writeProjection(relative, rebuild());
    try {
      this.safePath(relative);
      // Append is not retried after an uncertain partial write; rebuild later.
      fs.appendFileSync(target, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 });
      fs.chmodSync(target, 0o600);
      this._clearProjection(relative);
    } catch (error) {
      if (!RECOVERABLE_IO.has(error.code)) throw error;
      this._queueProjection(relative, 'write', error.code);
    }
  }

  _transaction(callback) {
    this._assertOpen();
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = callback(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  _prepareRaw(input) {
    this._assertOpen();
    if (!input || typeof input !== 'object') throw new TypeError('Raw input is required');
    const id = identifier(input.id ?? randomUUID());
    if (!ROLES.has(input.role)) throw new TypeError('Invalid raw role');
    if (!['a', 'b'].includes(input.pool)) throw new TypeError('Pool must be a or b');
    identifier(input.sessionId, 'sessionId');
    const previous = this.db.prepare('SELECT * FROM receipts WHERE id=?').get(id);
    const priorRecord = previous?.json ? JSON.parse(previous.json) : null;
    const recordedAt = instant(input.recordedAt ?? priorRecord?.recordedAt ?? this.now(), 'recordedAt');
    let { date, hour } = this._local(recordedAt);
    let record;
    if (input.pool === 'b') {
      // Intentionally never inspect, hash, serialize, or persist B-pool text or session metadata.
      // Exact timestamps are also omitted: replay receipts retain only the bucket.
      if (input.recordedAt === undefined && previous?.pool === 'b' && priorRecord?.date) {
        date = priorRecord.date; hour = priorRecord.hour;
      }
      record = { id, instanceId: this.instanceId, pool: 'b', date, role: input.role, hour };
    } else {
      if (typeof input.text !== 'string' || input.text.includes('\0') || input.text.length > 10000000) throw new TypeError('Raw text must be a string (max 10 million characters)');
      record = {
        id, instanceId: this.instanceId, pool: 'a', sessionId: input.sessionId,
        turnId: input.turnId == null ? null : identifier(input.turnId, 'turnId'),
        role: input.role, text: input.text, recordedAt,
        occurredAt: input.occurredAt == null ? null : instant(input.occurredAt, 'occurredAt'), date,
        sourceRoot: identifier(input.sourceRoot ?? id, 'sourceRoot'),
        sourceNature: optionalString(input.sourceNature, 'sourceNature') ?? ({ user: 'user_statement', assistant: 'assistant_statement', tool: 'tool_output' }[input.role]),
        project: optionalString(input.project, 'project'), entities: stringList(input.entities, 'entities'), tags: stringList(input.tags, 'tags')
      };
    }
    return record;
  }

  _rawPath(record) { return `${record.pool}/${record.date.replaceAll('-', '/')}/${record.pool === 'a' ? 'raw.jsonl' : 'stats.json'}`; }

  _commitRaw(record, captureId) {
    const { id, pool, date } = record;
    if (this.db.prepare('SELECT 1 FROM b2_notes WHERE id=? UNION ALL SELECT 1 FROM b2_expirations WHERE id=?').get(id, id)) throw new Error('Raw id collides with B2 id');
    if (this.db.prepare('SELECT 1 FROM entries WHERE id=? UNION ALL SELECT 1 FROM a2_purges WHERE entry_id=? LIMIT 1').get(id, id)) throw new Error('Raw id collides with entry id');
    if (id !== captureId && this.db.prepare('SELECT 1 FROM captures WHERE id=?').get(id) && !this.db.prepare('SELECT 1 FROM receipts WHERE id=?').get(id)) throw new Error('Raw id collides with captured message');
    const hash = digest(record);
    const receipt = this.db.prepare('SELECT * FROM receipts WHERE id=?').get(id);
    if (receipt) {
      if (receipt.hash !== hash || receipt.pool !== pool) throw new Error('Raw id already exists with different data');
      return { inserted: false };
    }
    const relative = this._rawPath(record);
    const wasPending = Boolean(this.db.prepare('SELECT 1 FROM projection_pending WHERE path=?').get(relative));
    this.db.prepare('INSERT INTO receipts(id,pool,hash,json) VALUES (?,?,?,?)').run(id, pool, hash, JSON.stringify(pool === 'a' ? { recordedAt: record.recordedAt } : { date, hour: record.hour }));
    if (pool === 'a') this.db.prepare('INSERT INTO raw(id,date,json) VALUES (?,?,?)').run(id, date, JSON.stringify(record));
    else this.db.prepare('INSERT INTO b_stats(date,role,hour,count) VALUES (?,?,?,1) ON CONFLICT(date,role,hour) DO UPDATE SET count=count+1').run(date, record.role, record.hour);
    this._queueProjection(relative);
    return { inserted: true, wasPending };
  }

  _projectRaw(record, { inserted, wasPending }) {
    if (!inserted) return;
    const relative = this._rawPath(record);
    if (record.pool === 'a') this._appendProjection(relative, record, wasPending, () => jsonl(this.db.prepare('SELECT json FROM raw WHERE date=? ORDER BY rowid').all(record.date).map(parse)));
    else this.writeProjection(relative, JSON.stringify(this.dayStats(record.date).b, null, 2) + '\n');
  }

  _rawResult(record) {
    if (record.pool === 'b') return this._writeResult({ ...record, count: this.db.prepare('SELECT count FROM b_stats WHERE date=? AND role=? AND hour=?').get(record.date, record.role, record.hour)?.count ?? 0 });
    return this._writeResult(this.getRaw(record.id) ?? { ...record, deleted: true });
  }

  appendRaw(input) {
    const record = this._prepareRaw(input);
    const committed = this._transaction(() => this._commitRaw(record));
    this._projectRaw(record, committed);
    return this._rawResult(record);
  }

  captureMessage({ id, pool, role, records } = {}) {
    this._assertOpen(); identifier(id);
    if (!['a', 'b'].includes(pool) || !ROLES.has(role) || !Array.isArray(records) || records.length > 1000 || (pool === 'b' && records.length !== 1)) throw new TypeError('Invalid captured message envelope');
    const prepared = records.map(input => {
      if (input.pool !== pool || input.role !== role) throw new TypeError('Captured message role/pool mismatch');
      return this._prepareRaw(input);
    });
    const partIds = prepared.map(record => record.id);
    if (new Set(partIds).size !== partIds.length) throw new TypeError('Captured message parts must have unique IDs');
    const hash = digest({ id, pool, role, parts: prepared.map(record => ({ id: record.id, hash: digest(record) })) });
    let duplicate = false;
    const committed = this._transaction(() => {
      const old = this.db.prepare('SELECT * FROM captures WHERE id=?').get(id);
      if (old && (old.pool !== pool || old.role !== role || old.hash !== hash)) throw new Error('Captured message already exists with different pool or data');
      if (this.db.prepare('SELECT 1 FROM entries WHERE id=? UNION ALL SELECT 1 FROM a2_purges WHERE entry_id=?').get(id, id)) throw new Error('Captured message id collides with entry');
      if (this.db.prepare('SELECT 1 FROM b2_notes WHERE id=? UNION ALL SELECT 1 FROM b2_expirations WHERE id=?').get(id, id)) throw new Error('Captured message id collides with B2 id');
      if (!old) {
        // v0.1.0 did not claim parent IDs for multiple text blocks. Recognize
        // both its parent receipt and its stable suffixed part receipts.
        const prefix = `${id}-part-`;
        const legacy = this.db.prepare('SELECT id,pool FROM receipts WHERE id=? OR substr(id,1,?)=?').all(id, prefix.length, prefix);
        if (legacy.length && (legacy.some(row => row.pool !== pool) || canonical(legacy.map(row => row.id).sort()) !== canonical([...partIds].sort()))) throw new Error('Legacy captured message already exists with different pool or parts');
        this.db.prepare('INSERT INTO captures(id,pool,role,hash,json) VALUES (?,?,?,?,?)').run(id, pool, role, hash, JSON.stringify({ partIds }));
      } else duplicate = true;
      return prepared.map(record => this._commitRaw(record, id));
    });
    // Multiple parts of one day are rebuilt together after their atomic commit.
    const byPath = new Map();
    prepared.forEach((record, index) => { if (committed[index].inserted) byPath.set(this._rawPath(record), record); });
    for (const [relative, record] of byPath) {
      if (prepared.length > 1 && record.pool === 'a') this.writeProjection(relative, jsonl(this.db.prepare('SELECT json FROM raw WHERE date=? ORDER BY rowid').all(record.date).map(parse)));
      else this._projectRaw(record, committed[prepared.indexOf(record)]);
    }
    return { id, pool, records: prepared.map(record => this._rawResult(record)), duplicate, committed: true, projectionPending: this.projectionStatus().projectionPending };
  }

  getRaw(id) {
    this._assertOpen(); identifier(id);
    return parse(this.db.prepare('SELECT json FROM raw WHERE id=?').get(id)) ?? parse(this.db.prepare('SELECT json FROM originals WHERE id=?').get(id));
  }

  verifyCaptureMessage({ id, pool, role, records } = {}) {
    this._assertOpen(); identifier(id, 'capture id');
    if (pool !== 'a' || !['user', 'assistant'].includes(role) || !Array.isArray(records) || records.length > 4096) throw new TypeError('Verification requires bounded A user/assistant records');
    const prepared = records.map(record => this._prepareRaw(record));
    if (prepared.some(record => record.pool !== pool || record.role !== role) || new Set(prepared.map(record => record.id)).size !== prepared.length) throw new TypeError('Captured parts must have matching pool/role and unique IDs');
    const hash = digest({ id, pool, role, parts: prepared.map(record => ({ id: record.id, hash: digest(record) })) });
    const receipt = this.db.prepare('SELECT pool,role,hash FROM captures WHERE id=?').get(id);
    if (!receipt || receipt.pool !== pool || receipt.role !== role || receipt.hash !== hash) return false;
    return prepared.every(record => {
      const row = this.db.prepare("SELECT p.hash FROM raw r JOIN receipts p ON p.id=r.id AND p.pool='a' WHERE r.id=?").get(record.id);
      return row?.hash === digest(record);
    });
  }

  listRaw({ pool, date, from, to, timeAxis = 'either', type, entity, project, limit, offset = 0, includeRetained = false } = {}) {
    this._assertOpen();
    if (typeof includeRetained !== 'boolean') throw new TypeError('includeRetained must be boolean');
    if (pool !== undefined && !['a', 'b'].includes(pool)) throw new TypeError('Invalid pool');
    if (date !== undefined) validateDate(date);
    if (!['either', 'recorded', 'occurred'].includes(timeAxis)) throw new TypeError('Invalid timeAxis');
    if (!Number.isSafeInteger(offset) || offset < 0 || (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0))) throw new TypeError('Invalid pagination');
    const bound = value => value === undefined ? null : /^\d{4}-\d{2}-\d{2}$/.test(value) ? { date: validateDate(value) } : { iso: instant(value, 'date filter') };
    const lower = bound(from); const upper = bound(to);
    const matchesTime = value => {
      if (!value) return false;
      const day = this._local(value).date;
      return (!lower || (lower.date ? day >= lower.date : value >= lower.iso)) && (!upper || (upper.date ? day <= upper.date : value <= upper.iso));
    };
    if (pool === 'b') return [];
    const rows = this.db.prepare(date ? 'SELECT json FROM raw WHERE date=? ORDER BY rowid' : 'SELECT json FROM raw ORDER BY rowid').all(...(date ? [date] : []));
    if (includeRetained) rows.push(...this.db.prepare(date ? "SELECT json FROM originals WHERE json_extract(json,'$.date')=? ORDER BY rowid" : 'SELECT json FROM originals ORDER BY rowid').all(...(date ? [date] : [])));
    let records = rows.map(parse).filter(record => {
      if (type && !['raw', record.role].includes(type)) return false;
      if (entity && !record.entities.includes(entity)) return false;
      if (project && record.project !== project) return false;
      if (!lower && !upper) return true;
      return timeAxis === 'recorded' ? matchesTime(record.recordedAt) : timeAxis === 'occurred' ? matchesTime(record.occurredAt) : matchesTime(record.recordedAt) || matchesTime(record.occurredAt);
    });
    records.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || a.id.localeCompare(b.id));
    return records.slice(offset, limit === undefined ? undefined : offset + limit);
  }

  _prepareEntry(input) {
    this._assertOpen();
    if (!input || !KINDS.has(input.kind)) throw new TypeError('Entry kind must be memory, doing, entity, or relation');
    if (input.kind === 'preference') throw new TypeError('Preferences require setPreference');
    if (input.kind === 'a3') throw new TypeError('A3 requires writeA3');
    if (input.kind === 'b2') throw new TypeError('B2 requires writeB2');
    if (input.pool !== undefined && input.pool !== 'a2') throw new TypeError('Ordinary writes require pool a2; use setCore to promote');
    const statementType = explicitStatement(input);
    const id = identifier(input.id ?? randomUUID());
    if (id === 'self') throw new Error('self is the reserved virtual Feiyu identity; legacy entries with this ID are read-only');
    const text = requiredString(input.text, 'text');
    const hooks = stringList(input.hooks, 'hooks');
    if (input.sources !== undefined && !Array.isArray(input.sources)) throw new TypeError('sources must be an array');
    if ((input.sources?.length ?? 0) > 1000) throw new TypeError('Too many sources');
    const sources = (input.sources ?? []).map(source => {
      if (!source || typeof source !== 'object') throw new TypeError('Invalid source');
      const rawId = identifier(source.rawId, 'rawId');
      const quote = requiredString(source.quote, 'quote');
      const raw = this.getRaw(rawId);
      if (!raw) throw new Error(`Source must resolve to original raw: ${rawId}`);
      if (!raw.text.includes(quote)) throw new Error(`Quote does not occur verbatim in original: ${rawId}`);
      const support = source.support ?? 'unassessed';
      if (!SUPPORTS.has(support)) throw new TypeError('Invalid support judgment');
      return { rawId, quote, support, sourceRoot: raw.sourceRoot, sourceNature: raw.sourceNature, role: raw.role };
    });
    const status = input.status ?? (input.kind === 'doing' ? 'pending' : 'active');
    const allowed = input.kind === 'doing' ? ['pending', 'active', 'done', 'cancelled'] : ['active', 'archived'];
    if (!allowed.includes(status)) throw new TypeError('Invalid entry status');
    let relation = {};
    if (input.kind === 'relation') {
      const from = identifier(input.from ?? 'self', 'from');
      const to = identifier(input.to, 'to');
      for (const endpoint of [from, to]) if (endpoint !== 'self' && this.getEntry(endpoint)?.kind !== 'entity') throw new Error(`Relation endpoint must resolve to an entity: ${endpoint}`);
      relation = { from, to, rel: requiredString(input.rel, 'rel', 200), note: optionalString(input.note, 'note') };
    }
    const record = {
      id, instanceId: this.instanceId, version: 0, kind: input.kind, pool: 'a2', text, hooks, sources, status,
      ...relation,
      recordedAt: instant(input.recordedAt ?? this.now(), 'recordedAt'),
      occurredAt: input.occurredAt == null ? null : instant(input.occurredAt, 'occurredAt'),
      sourceNature: optionalString(input.sourceNature, 'sourceNature') ?? 'manual_entry',
      evidenceStatus: sources.length ? 'quote_verified' : 'unverified', independentSourceCount: null,
      currentValidity: 'unknown', project: optionalString(input.project, 'project'),
      entities: stringList(input.entities, 'entities'), aliases: stringList(input.aliases, 'aliases'), tags: stringList(input.tags, 'tags'),
      legacy: input.legacy === undefined ? null : JSON.parse(JSON.stringify(input.legacy)), dictVersion: 'v5',
      statementType, semanticStatus: 'declared_only', policyVersion: POLICY_VERSION
    };
    record.sourceTimes = sourceTimes(this, sources);
    record.mentionedTimes = [...new Set(record.sourceTimes.map(source => source.recordedAt))].sort();
    record.date = this._local(record.recordedAt).date;
    return record;
  }

  #commitEntry(record, { expectedVersion, core = false, archive = false, requireNew = false, allowMissingSources = false } = {}) {
    if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)) throw new TypeError('expectedVersion must be a nonnegative integer');
    const { id, sources } = record;
    if (this.db.prepare('SELECT 1 FROM b2_notes WHERE id=? UNION ALL SELECT 1 FROM b2_expirations WHERE id=?').get(id, id)) throw new Error('Entry id collides with B2 id');
    if (this.db.prepare('SELECT 1 FROM receipts WHERE id=?').get(id) || this.db.prepare('SELECT 1 FROM captures WHERE id=?').get(id)) throw new Error('Entry id collides with raw id');
    const old = this.getEntry(id);
    if (requireNew && old) throw new Error('Self review entries must use new IDs');
    if (old && old.kind !== record.kind) throw new Error('Entry kind cannot change');
    if (expectedVersion !== undefined && expectedVersion !== (old?.version ?? 0)) throw new Error('Entry version conflict');
    if (!core && old?.pool === 'c') throw new Error('Core entries require setCore revoke before editing');
    if (!archive && old?.pool === 'a3') throw new Error('A3 entries require setArchive; ordinary writes cannot edit archived information');
    record.version = (old?.version ?? 0) + 1;
    for (const source of sources) if (!this.getRaw(source.rawId) && !allowMissingSources) throw new Error('Source was removed before entry commit');
    this.db.prepare('INSERT INTO entries(id,version,kind,json) VALUES (?,?,?,?)').run(id, record.version, record.kind, JSON.stringify(record));
    for (const rawId of new Set(sources.map(source => source.rawId))) this.db.prepare('INSERT INTO evidence(entry_id,version,raw_id) VALUES (?,?,?)').run(id, record.version, rawId);
    for (const relative of this._entryPaths(record)) this._queueProjection(relative);
    if (['a2', 'c'].includes(record.pool)) this._queueProjection(`${record.pool === 'c' ? 'a2' : 'archive'}/${digest(id)}/current.json`, 'delete');
    this._queueProjection('index/entries.json');
  }

  writeEntry(input) {
    let record;
    this._transaction(() => {
      record = this._prepareEntry(input);
      this.#commitEntry(record, { expectedVersion: input.expectedVersion });
    });
    this._projectEntry(record);
    this._projectEntryIndex();
    return this._writeResult(record);
  }

  getEntry(id, { version } = {}) {
    this._assertOpen(); identifier(id);
    if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) throw new TypeError('Invalid version');
    return this.#readEntry(id, version, this._lineageContext()) ?? (id === 'self' ? null : getB2(this, id, { version }));
  }

  #readEntry(id, version, context) {
    const row = version === undefined ? this.db.prepare('SELECT json FROM entries WHERE id=? ORDER BY version DESC LIMIT 1').get(id) : this.db.prepare('SELECT json FROM entries WHERE id=? AND version=?').get(id, version);
    let entry = parse(row);
    const purge = version === undefined ? this.db.prepare('SELECT version,json FROM a2_purges WHERE entry_id=? ORDER BY version DESC LIMIT 1').get(id) : this.db.prepare('SELECT version,json FROM a2_purges WHERE entry_id=? AND version=?').get(id, version);
    if (purge && (!entry || purge.version > entry.version)) {
      const marker = parse(purge);
      entry = { ...marker, id, kind: marker.kind, pool: 'a2', text: '', sources: [], hooks: [], aliases: [], tags: [], entities: [], status: 'archived', evidenceStatus: 'pruned', retired: true, pruned: true, provenanceOnly: true };
    }
    // Migration is a read default: never rewrite immutable historical JSON.
    if (entry) entry.pool ??= 'a2';
    if (entry?.id === 'self') entry.identityConflict = true;
    if (entry && this.db.prepare('SELECT 1 FROM audits WHERE entry_id=? AND version=? LIMIT 1').get(entry.id, entry.version)) {
      if (entry.kind === 'preference') { entry.contextEvidenceStatus = 'unverified'; entry.contextAuditDowngraded = true; }
      else if (entry.kind !== 'a3') { entry.evidenceStatus = 'unverified'; entry.auditDowngraded = true; }
    }
    if (entry?.pool === 'a2') {
      const retirement = parse(this.db.prepare('SELECT json FROM a2_retirements WHERE entry_id=? AND version=?').get(entry.id, entry.version));
      if (retirement) { entry.retired = true; entry.retirement = retirement; }
    }
    if (entry?.kind === 'a3') Object.assign(entry, this._a3State(entry, context), { evidenceStatus: 'derived_only', depth: 2 });
    return decoratePolicy(this, entry);
  }

  _lineageContext() { return { parents: new Map(), latest: new Map(), quotes: new Map() }; }

  _a3State(entry, context = this._lineageContext()) {
    let lineageBroken = !Array.isArray(entry.sourceEntries) || !entry.sourceEntries.length;
    let orphaned = false; let sourceChanged = false;
    for (const source of entry.sourceEntries ?? []) {
      const key = `${entry.policyVersion ?? 'legacy'}:${source.id}:${source.version}:${source.hash ?? ''}`;
      if (!context.parents.has(key)) {
        // Read parent metadata directly: an invalid A3 parent never recursively
        // invokes getEntry, and cached values never retain original message text.
        const row = this.db.prepare("SELECT kind,coalesce(json_extract(json,'$.pool'),'a2') AS pool,json_extract(json,'$.sources') AS sources,json FROM entries WHERE id=? AND version=?").get(source.id, source.version);
        let broken = !row || row.pool !== 'a2' || row.kind === 'a3';
        if (entry.policyVersion === POLICY_VERSION) {
          const tombstone = !row && parse(this.db.prepare('SELECT json FROM a2_purges WHERE entry_id=? AND version=?').get(source.id, source.version));
          broken = row ? row.pool !== 'a2' || row.kind === 'a3' || digest(row.json) !== source.hash : !tombstone || tombstone.hash !== source.hash;
        } else if (!broken) {
          const sources = JSON.parse(row.sources ?? '[]');
          broken = !sources.length || Boolean(this.db.prepare('SELECT 1 FROM audits WHERE entry_id=? AND version=? LIMIT 1').get(source.id, source.version));
          for (const original of sources) {
            const quoteKey = digest({ rawId: original.rawId, quote: original.quote });
            if (!context.quotes.has(quoteKey)) {
              const raw = typeof original.rawId === 'string' ? this.getRaw(original.rawId) : null;
              context.quotes.set(quoteKey, Boolean(raw && typeof original.quote === 'string' && original.quote.length && raw.text.includes(original.quote)));
            }
            if (!context.quotes.get(quoteKey)) broken = true;
          }
        }
        context.parents.set(key, broken);
      }
      if (context.parents.get(key)) lineageBroken = true;
      if (!context.latest.has(source.id)) {
        const latest = this.db.prepare("SELECT version,kind,coalesce(json_extract(json,'$.pool'),'a2') AS pool,json_extract(json,'$.status') AS status FROM entries WHERE id=? ORDER BY version DESC LIMIT 1").get(source.id);
        const retired = latest && Boolean(this.db.prepare('SELECT 1 FROM a2_retirements WHERE entry_id=? AND version=?').get(source.id, latest.version));
        context.latest.set(source.id, { ...latest, unavailable: !latest || latest.pool !== 'a2' || latest.kind === 'a3' || ['archived', 'cancelled'].includes(latest.status) || retired });
      }
      const latest = context.latest.get(source.id);
      if (latest.unavailable) orphaned = true;
      if (latest.version > source.version) sourceChanged = true;
    }
    return { lineageBroken, orphaned, sourceChanged };
  }

  a3Stats({ status = 'active' } = {}) {
    this._assertOpen();
    if (!['active', 'archived', 'all'].includes(status)) throw new TypeError('Invalid A3 status');
    const rows = this.db.prepare("SELECT json_extract(json,'$.sourceEntries') AS sources,json_extract(json,'$.policyVersion') AS policyVersion FROM entries e WHERE kind='a3' AND version=(SELECT max(version) FROM entries WHERE id=e.id) AND (?='all' OR json_extract(json,'$.status')=?)").all(status, status);
    const context = this._lineageContext(); let orphaned = 0; let lineageBroken = 0;
    for (const row of rows) { const state = this._a3State({ sourceEntries: JSON.parse(row.sources ?? '[]'), policyVersion: row.policyVersion }, context); orphaned += Number(state.orphaned); lineageBroken += Number(state.lineageBroken); }
    return { status, total: rows.length, orphaned, lineageBroken };
  }

  listEntries({ kind, status, pool, includeHistory = false, includeRetired = false } = {}) {
    this._assertOpen();
    if (typeof includeHistory !== 'boolean') throw new TypeError('includeHistory must be boolean');
    if (typeof includeRetired !== 'boolean') throw new TypeError('includeRetired must be boolean');
    if (kind !== undefined && !KINDS.has(kind)) throw new TypeError('Invalid entry kind');
    if (pool !== undefined && !['a2', 'a3', 'b2', 'b3', 'c', 'all'].includes(pool)) throw new TypeError('Invalid entry pool');
    const rows = this.db.prepare(includeHistory ? 'SELECT id,version FROM entries ORDER BY id,version' : 'SELECT id FROM entries GROUP BY id ORDER BY id').all();
    const context = this._lineageContext();
    const records = rows.map(row => this.#readEntry(row.id, includeHistory ? row.version : undefined, context));
    if (includeHistory) for (const row of this.db.prepare('SELECT entry_id,version FROM a2_purges ORDER BY entry_id,version').all()) records.push(this.#readEntry(row.entry_id, row.version, context));
    if ((!pool || pool === 'all' || pool === 'b2') && (!kind || kind === 'b2')) records.push(...listB2(this, { includeHistory }));
    return records.filter(entry => (includeHistory || includeRetired || !entry.retired) && (!kind || entry.kind === kind) && (!status || entry.status === status) && (!pool || pool === 'all' || entry.pool === pool));
  }

  _entryDirectory(entry) { return ['a3', 'b3'].includes(entry.pool) ? entry.pool : entry.pool === 'c' ? 'archive' : 'a2'; }

  _entryPaths(entry) {
    const filename = digest(entry.id);
    const directory = this._entryDirectory(entry);
    return [`${directory}/${filename}/v${entry.version}.json`, `${directory}/${filename}/current.json`, ...(entry.kind === 'doing' ? [`doing/${filename}.json`] : entry.kind === 'entity' ? [`entities/${filename}.json`] : [])];
  }

  _projectEntry(entry, { current = true } = {}) {
    const filename = digest(entry.id);
    const relative = `${this._entryDirectory(entry)}/${filename}/v${entry.version}.json`;
    this.writeProjection(relative, JSON.stringify({ ...entry, pool: entry.pool ?? 'a2' }, null, 2) + '\n');
    // Only old, known non-core files are moved. Core history remains immutable.
    if (!entry.pool && !this.db.prepare('SELECT 1 FROM projection_pending WHERE path=?').get(relative)) this._removeProjection(`archive/${filename}/v${entry.version}.json`);
    if (current) this._projectEntryCurrent(this.getEntry(entry.id));
  }

  _projectEntryCurrent(entry) {
    const filename = digest(entry.id);
    if (entry.retired && entry.pool === 'a2') {
      for (const relative of this._entryPaths(entry).slice(1)) this._removeProjection(relative);
      return;
    }
    this.writeProjection(`${this._entryDirectory(entry)}/${filename}/current.json`, JSON.stringify(entry, null, 2) + '\n');
    if (['a2', 'c'].includes(entry.pool)) this._removeProjection(`${entry.pool === 'c' ? 'a2' : 'archive'}/${filename}/current.json`);
    if (entry.kind === 'doing') this.writeProjection(`doing/${filename}.json`, JSON.stringify(entry, null, 2) + '\n');
    if (entry.kind === 'entity') this.writeProjection(`entities/${filename}.json`, JSON.stringify(entry, null, 2) + '\n');
  }

  _projectEntryIndex() {
    const entries = this.listEntries();
    this.writeProjection('index/entries.json', JSON.stringify(entries.map(({ id, kind, pool, version, hooks, aliases, project, entities, from, to, rel, subject, topic, stance, contextEvidenceStatus, contextAuditDowngraded, recordedAt, occurredAt, status, evidenceStatus, auditDowngraded }) => ({ id, kind, pool, version, hooks, aliases, project, entities, ...(kind === 'relation' ? { from, to, rel } : {}), ...(kind === 'preference' ? { subject, topic, stance, contextEvidenceStatus, ...(contextAuditDowngraded ? { contextAuditDowngraded } : {}) } : {}), recordedAt, occurredAt, status, evidenceStatus, ...(auditDowngraded ? { auditDowngraded } : {}) })), null, 2) + '\n');
    const archives = entries.filter(entry => entry.kind === 'a3');
    for (const entry of archives) this._projectEntryCurrent(entry);
    this.writeProjection('a3/index.json', JSON.stringify(archives.map(entry => ({ id: entry.id, version: entry.version, text: clipped(entry.text, 80), derivedFromCount: entry.derivedFrom.length, status: entry.status, orphaned: entry.orphaned, lineageBroken: entry.lineageBroken })), null, 2) + '\n');
  }

  listProjectionDates() {
    this._assertOpen();
    const dates = this.db.prepare("SELECT date FROM raw UNION SELECT json_extract(json,'$.date') AS date FROM originals UNION SELECT date FROM b_stats UNION SELECT date FROM dirty_days").all().map(row => validateDate(row.date));
    for (const row of this.db.prepare("SELECT json FROM receipts WHERE pool='a'").all()) dates.push(this._local(JSON.parse(row.json).recordedAt).date);
    return [...new Set(dates)].sort();
  }

  listReviewQueue({ limit = 4, offset = 0 } = {}) {
    this._assertOpen(); pageArgs(limit, offset, 100);
    const asOf = this.now();
    const cutoff = new Date(new Date(asOf).getTime() - REVIEW_AGE_MS).toISOString();
    const candidates = "FROM (SELECT id,json FROM raw UNION ALL SELECT id,json FROM originals WHERE NOT EXISTS (SELECT 1 FROM raw WHERE raw.id=originals.id)) r WHERE (json_extract(r.json,'$.recordedAt')<=? OR EXISTS(SELECT 1 FROM early_reviews q WHERE q.raw_id=r.id)) AND NOT EXISTS (SELECT 1 FROM self_review_completed s WHERE s.raw_id=r.id)";
    const total = this.db.prepare(`SELECT count(*) AS n ${candidates}`).get(cutoff).n;
    // SQLite computes metadata and pages before crossing into JavaScript. Large
    // backlogs never deserialize every original body just to build a reminder.
    const rows = this.db.prepare(`SELECT r.id AS rawId,json_extract(r.json,'$.role') AS role,json_extract(r.json,'$.recordedAt') AS recordedAt,length(json_extract(r.json,'$.text')) AS textLength,EXISTS(SELECT 1 FROM early_reviews q WHERE q.raw_id=r.id) AS earlyRequested ${candidates} ORDER BY earlyRequested DESC,json_extract(r.json,'$.recordedAt'),r.id LIMIT ? OFFSET ?`).all(cutoff, limit, offset);
    const items = rows.map(row => ({ ...row, earlyRequested: Boolean(row.earlyRequested), dueAt: new Date(new Date(row.recordedAt).getTime() + REVIEW_AGE_MS).toISOString(), read: readPointer(row.rawId) }));
    const hasMore = offset + items.length < total;
    return { total, items, hasMore, nextOffset: hasMore ? offset + items.length : null, asOf };
  }

  #decisionReplay(requestId, hash) {
    if (this.db.prepare('SELECT 1 FROM b2_requests WHERE request_id=?').get(requestId)) throw new Error('requestId belongs to a B2 decision');
    const old = this.db.prepare('SELECT hash,result_json FROM memory_decisions WHERE request_id=?').get(requestId);
    if (!old) return null;
    if (old.hash !== hash) throw new Error('requestId already exists with different payload');
    return { ...JSON.parse(old.result_json), duplicate: true };
  }

  #saveDecision(record, hash, result) {
    this.db.prepare('INSERT INTO memory_decisions(request_id,kind,entry_id,hash,json,result_json) VALUES (?,?,?,?,?,?)').run(record.requestId, record.type, record.id ?? null, hash, JSON.stringify(record), JSON.stringify(result));
    this._queueProjection('logs/decisions.jsonl');
  }

  _projectDecisions() {
    this.writeProjection('logs/decisions.jsonl', jsonl(this.db.prepare('SELECT json FROM memory_decisions ORDER BY seq').all().map(parse)));
  }

  submitSelfReview({ requestId, rawIds, entries = [], omissions = [], reason } = {}) {
    this._assertOpen(); identifier(requestId, 'requestId');
    requiredString(reason, 'reason', 2000);
    if (!Array.isArray(rawIds) || !rawIds.length || rawIds.length > 20 || new Set(rawIds).size !== rawIds.length) throw new TypeError('rawIds must contain 1..20 unique IDs');
    rawIds.forEach(id => identifier(id, 'rawId'));
    if (!Array.isArray(entries) || entries.length > 40 || !Array.isArray(omissions) || omissions.length > rawIds.length) throw new TypeError('Invalid self review products');
    const hash = digest({ type: 'self_review', requestId, rawIds, entries, omissions, reason });
    const created = [];
    const result = this._transaction(() => {
      const replay = this.#decisionReplay(requestId, hash);
      if (replay) return replay;
      const reviewedAt = this.now();
      const rawSet = new Set(rawIds);
      const originals = rawIds.map(id => {
        const raw = this.getRaw(id);
        if (!raw || (new Date(reviewedAt).getTime() - new Date(raw.recordedAt).getTime() < REVIEW_AGE_MS && !this.db.prepare('SELECT 1 FROM early_reviews WHERE raw_id=?').get(id))) throw new Error(`Raw is missing or not due for review: ${id}`);
        if (this.db.prepare('SELECT 1 FROM self_review_completed WHERE raw_id=?').get(id)) throw new Error(`Raw already reviewed: ${id}`);
        return raw;
      });
      const omitted = new Set();
      const normalizedOmissions = omissions.map(omission => {
        const id = identifier(omission?.rawId, 'omission rawId');
        if (!rawSet.has(id) || omitted.has(id)) throw new Error('Omissions must uniquely refer to this review batch');
        omitted.add(id);
        return { rawId: id, reason: requiredString(omission.reason, 'omission reason', 2000) };
      });
      const covered = new Set();
      // Entities in the same atomic batch can be referenced regardless of input order.
      for (const input of [...entries].sort((a, b) => Number(a?.kind === 'relation') - Number(b?.kind === 'relation'))) {
        if (!input?.sources?.length) throw new Error('Self review products require original sources');
        for (const source of input.sources) {
          if (!rawSet.has(source?.rawId)) throw new Error('Self review sources must belong to this batch');
          covered.add(source.rawId);
        }
        const record = this._prepareEntry(input);
        record.selfReview = { requestId, reviewedAt };
        this.#commitEntry(record, { expectedVersion: input.expectedVersion, requireNew: true });
        created.push(record);
      }
      for (const id of rawIds) if (!covered.has(id) && !omitted.has(id)) throw new Error(`Raw requires an output or explicit omission: ${id}`);
      for (const id of omitted) if (covered.has(id)) throw new Error('A raw cannot be both cited and omitted');
      const references = created.map(entry => ({ id: entry.id, version: entry.version, pool: entry.pool, read: readPointer(entry.id, entry.version) }));
      const saved = { requestId, type: 'self_review', rawIds: [...rawIds], completed: rawIds.length, entries: references, duplicate: false };
      this.#saveDecision({ requestId, type: 'self_review', reviewedAt, reason, rawIds: [...rawIds], inputs: originals.map(raw => ({ rawId: raw.id, recordedAt: raw.recordedAt, hash: digest(raw) })), entries: references, omissions: normalizedOmissions }, hash, saved);
      for (const id of rawIds) this.db.prepare('INSERT INTO self_review_completed(raw_id,request_id) VALUES (?,?)').run(id, requestId);
      return saved;
    });
    for (const record of created) this._projectEntry(record);
    this._projectEntryIndex(); this._projectDecisions();
    return this._writeResult(result);
  }

  setCore({ requestId, id, expectedVersion, action, reason, category } = {}) {
    this._assertOpen(); identifier(requestId, 'requestId'); identifier(id);
    if (id === 'self') throw new Error('self is the reserved virtual Feiyu identity; legacy entries with this ID are read-only');
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new TypeError('expectedVersion is required');
    if (!['promote', 'revoke'].includes(action)) throw new TypeError('Invalid core action');
    requiredString(reason, 'reason', 2000);
    if (action === 'promote' && !CORE_CATEGORIES.has(category)) throw new TypeError('A core category is required');
    if (category !== undefined && !CORE_CATEGORIES.has(category)) throw new TypeError('Invalid core category');
    const hash = digest({ type: 'core', requestId, id, expectedVersion, action, reason, category });
    let created;
    const result = this._transaction(() => {
      const replay = this.#decisionReplay(requestId, hash);
      if (replay) return replay;
      const old = this.getEntry(id);
      if (!old || old.version !== expectedVersion) throw new Error('Entry version conflict');
      if (action === 'promote') {
        if (old.pool !== 'a2' || old.retired || old.status !== 'active' || !['entity', 'relation'].includes(old.kind)) throw new Error('Promotion requires an active A2 entity or relation; C contains only the relationship graph');
        if (old.correctness.status !== 'unreviewed') throw new Error('Corrected entries require a new reviewed version before promotion');
        if (old.kind === 'entity' && (!['identity', 'relationship'].includes(category) || old.text.length > 200)) throw new Error('Core entities require identity/relationship category and a name of at most 200 characters');
        if (old.kind === 'relation') {
          if (category !== 'relationship') throw new Error('Core relations require relationship category');
          for (const endpoint of [old.from ?? 'self', old.to]) {
            const entity = endpoint === 'self' ? null : this.getEntry(identifier(endpoint, 'relation endpoint'));
            if (endpoint !== 'self' && (!entity || entity.kind !== 'entity' || entity.pool !== 'c' || entity.status !== 'active' || entity.auditDowngraded)) throw new Error('Core relation endpoints must be self or active core entities without audit downgrade');
          }
          requiredString(old.rel, 'rel', 200); optionalString(old.note, 'note');
        }
        if (!old.sources.length || !old.sources.some(source => source.support === 'supports')) throw new Error('Promotion requires original evidence and a declared supports judgment');
        if (old.auditDowngraded) throw new Error('Audited evidence must be repaired before promotion');
        for (const source of old.sources) {
          const raw = this.getRaw(source.rawId);
          if (!raw || !raw.text.includes(source.quote)) throw new Error('Promotion requires valid original evidence');
        }
      } else {
        if (old.pool !== 'c') throw new Error('Revocation requires a core entry');
        if (old.kind === 'entity' && this.listEntries({ kind: 'relation', pool: 'c', status: 'active' }).some(edge => edge.from === id || edge.to === id)) throw new Error('Revoke incident core relations before revoking this entity');
      }
      const decidedAt = this.now();
      const selectedCategory = category ?? old.coreDecision?.category ?? null;
      const decision = { requestId, type: 'core', id, sourceVersion: old.version, action, reason, category: selectedCategory, decidedAt };
      // Inference assertions stay in C history when revoked; they must never
      // become a fresh A2 inference through the legacy promotion route.
      const keepCoreHistory = !['fact', 'self_report'].includes(old.statementType);
      created = { ...old, pool: action === 'promote' || keepCoreHistory ? 'c' : 'a2', ...(action === 'revoke' && keepCoreHistory ? { status: 'archived' } : {}), recordedAt: decidedAt, date: this._local(decidedAt).date, dictVersion: 'v5', coreDecision: { requestId, sourceVersion: old.version, action, category: selectedCategory, reason, decidedAt } };
      delete created.auditDowngraded;
      // A broken historical source must never prevent removing a record from C.
      if (action === 'revoke' && created.sources.some(source => !this.getRaw(source.rawId)?.text.includes(source.quote))) created.evidenceStatus = 'unverified';
      this.#commitEntry(created, { expectedVersion, core: true, allowMissingSources: action === 'revoke' });
      const saved = { requestId, type: 'core', id, version: created.version, pool: created.pool, action, duplicate: false, read: readPointer(id, created.version) };
      this.#saveDecision({ ...decision, version: created.version, pool: created.pool }, hash, saved);
      return saved;
    });
    if (created) this._projectEntry(created);
    this._projectEntryIndex(); this._projectDecisions();
    return this._writeResult(result);
  }

  setPreference({ requestId, id, expectedVersion, action, topic, stance, text, reason, sources, subject, target, expressionKind = 'preference', declaration, dependencyEntries: dependencies } = {}) {
    this._assertOpen(); identifier(requestId, 'requestId'); identifier(id);
    if (id === 'self') throw new Error('self is the reserved virtual Feiyu identity; use a separate preference ID');
    const suppliedSubject = subject;
    subject ??= 'self';
    identifier(subject, 'subject');
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new TypeError('expectedVersion is required and must be nonnegative');
    if (!['set', 'revoke'].includes(action)) throw new TypeError('Invalid preference action');
    requiredString(reason, 'reason', 2000);
    if (action === 'set') {
      requiredString(topic, 'topic', 120); requiredString(text, 'text', 500);
      if (!PREFERENCE_STANCES.has(stance)) throw new TypeError('Invalid preference stance');
      if (!['preference', 'emotion'].includes(expressionKind)) throw new TypeError('Invalid expressionKind');
      if (subject !== 'self' && expressionKind === 'emotion') throw new TypeError('Only self may record emotion; neighbours may declare preferences');
      if (sources !== undefined && (!Array.isArray(sources) || sources.length > 20)) throw new TypeError('Preference sources must be an array of at most 20 context references');
    }
    const hash = digest({ type: 'preference', requestId, id, expectedVersion, action, topic, stance, text, reason, sources, subject, target, expressionKind, declaration, dependencies });
    let created;
    const result = this._transaction(() => {
      const replay = this.#decisionReplay(requestId, hash);
      if (replay) return replay;
      const old = this.getEntry(id);
      if (old && (old.kind !== 'preference' || old.pool !== 'b3')) throw new Error('Preference ID belongs to another entry kind');
      if (old && action === 'revoke' && suppliedSubject === undefined) subject = old.subject;
      if (old && old.subject !== subject) throw new Error('Preference subject is immutable');
      if ((old?.version ?? 0) !== expectedVersion) throw new Error('Entry version conflict');
      if (action === 'revoke' && !old) throw new Error('Cannot revoke a missing preference');
      const asOf = this.now();
      if (action === 'set') {
        if (!inPreferenceScope(this, subject)) throw new Error('Preference subject must be self or an active first-degree C neighbour');
        if (target !== undefined && target !== 'self') {
          const node = this.getEntry(identifier(target, 'target'));
          if (!node || node.kind !== 'entity' || node.pool !== 'c' || node.status !== 'active') throw new Error('Preference target must be self or an active C entity');
        }
        const context = (sources ?? []).map(source => {
          if (!source || typeof source !== 'object') throw new TypeError('Invalid preference context');
          const rawId = identifier(source.rawId, 'rawId');
          const quote = requiredString(source.quote, 'quote');
          if (source.support !== undefined && source.support !== 'context_only') throw new TypeError('Preference references are context_only, not proof of the self report');
          const raw = this.getRaw(rawId);
          if (!raw) throw new Error(`Source must resolve to original raw: ${rawId}`);
          if (!raw.text.includes(quote)) throw new Error(`Quote does not occur verbatim in original: ${rawId}`);
          return { rawId, quote, support: 'context_only', sourceRoot: raw.sourceRoot, sourceNature: raw.sourceNature, role: raw.role };
        });
        let attributedDeclaration = null;
        if (subject !== 'self') {
          if (declaration?.subject !== subject) throw new Error('Nonself preference requires an explicitly attributed declaration');
          const original = context.find(source => source.rawId === declaration.rawId && source.quote === declaration.quote);
          if (!original || original.role === 'tool') throw new Error('Declaration must match an original user/assistant quotation in sources');
          attributedDeclaration = { subject, rawId: original.rawId, quote: original.quote, attribution: 'declared_by_writer', semanticStatus: 'declared_only' };
        }
        created = { id, instanceId: this.instanceId, version: 0, kind: 'preference', pool: 'b3', subject, ...(target === undefined ? {} : { target }), expressionKind, declaration: attributedDeclaration, dependencyEntries: dependencyEntries(this, dependencies), topic, stance, text, status: 'active', sources: context, sourceNature: subject === 'self' ? 'model_self_report' : 'attributed_self_report', evidenceStatus: 'self_report', contextEvidenceStatus: context.length ? 'quote_verified' : 'none', currentValidity: 'unknown', semanticStatus: 'declared_only', policyVersion: POLICY_VERSION, independentSourceCount: null, hooks: [topic], aliases: [], entities: [], tags: [], project: null, occurredAt: null, legacy: null };
        created.sourceTimes = sourceTimes(this, context); created.mentionedTimes = [...new Set(created.sourceTimes.map(source => source.recordedAt))].sort();
      } else {
        created = { ...old, status: 'archived' };
        if (created.sources.some(source => !this.getRaw(source.rawId)?.text.includes(source.quote))) {
          created.contextEvidenceStatus = 'unverified'; created.contextAuditDowngraded = true;
        }
      }
      created.recordedAt = asOf; created.date = this._local(asOf).date; created.dictVersion = 'v5';
      created.preferenceDecision = { requestId, action, reason, asOf, sourceVersion: old?.version ?? 0 };
      this.#commitEntry(created, { expectedVersion, allowMissingSources: action === 'revoke' });
      const saved = { requestId, type: 'preference', id, version: created.version, pool: 'b3', status: created.status, action, duplicate: false, read: readPointer(id, created.version) };
      this.#saveDecision({ requestId, type: 'preference', id, subject, action, reason, asOf, sourceVersion: old?.version ?? 0, version: created.version, pool: 'b3', status: created.status, read: readPointer(id, created.version) }, hash, saved);
      return saved;
    });
    if (created) this._projectEntry(created);
    this._projectEntryIndex(); this._projectDecisions();
    return this._writeResult(result);
  }

  writeA3({ requestId, id, expectedVersion, action, reason, text, body, derivedFrom, coverage, statementType, inference, hooks, tags, occurredAt } = {}) {
    this._assertOpen(); identifier(requestId, 'requestId'); identifier(id);
    if (id === 'self') throw new Error('self is the reserved virtual Feiyu identity');
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new TypeError('expectedVersion is required and must be nonnegative');
    if (!['write', 'revoke'].includes(action)) throw new TypeError('Invalid A3 action');
    requiredString(reason, 'reason', 2000);
    const hash = digest({ type: 'a3', requestId, id, expectedVersion, action, reason, text, body, derivedFrom, coverage, statementType, inference, hooks, tags, occurredAt });
    let created;
    const result = this._transaction(() => {
      const replay = this.#decisionReplay(requestId, hash);
      if (replay) return replay;
      const old = this.getEntry(id);
      if (old && (old.kind !== 'a3' || old.pool !== 'a3')) throw new Error('A3 requires a new ID or an existing A3 entry');
      if ((old?.version ?? 0) !== expectedVersion) throw new Error('Entry version conflict');
      if (action === 'revoke' && !old) throw new Error('Cannot revoke a missing A3 entry');
      const decidedAt = this.now();
      if (action === 'write') {
        explicitStatement({ statementType, inference }, { required: true });
        const structuredBody = normalizeBody(body);
        const archiveText = text === undefined ? `${structuredBody.time}；${structuredBody.persons.join('、')}；${structuredBody.event}` : requiredString(text, 'text', 2600);
        if (!Array.isArray(derivedFrom) || !derivedFrom.length || derivedFrom.length > 50 || new Set(derivedFrom).size !== derivedFrom.length) throw new TypeError('derivedFrom must contain 1..50 unique A2 IDs');
        derivedFrom.forEach(parent => identifier(parent, 'derivedFrom ID'));
        if (!coverage || !Array.isArray(coverage.scope) || !coverage.scope.length || coverage.scope.length > 50 || !Array.isArray(coverage.covered) || !Array.isArray(coverage.notCovered)) throw new TypeError('Complete coverage with scope, covered and notCovered is required');
        const scopeNote = requiredString(coverage.scopeNote, 'scopeNote', 1000);
        const scope = []; const parents = new Map();
        for (const item of coverage.scope) {
          const parentId = identifier(item?.id, 'scope ID');
          if (!Number.isSafeInteger(item.version) || item.version < 1 || parents.has(parentId)) throw new TypeError('Scope must contain unique versioned A2 IDs');
          const parent = this.getEntry(parentId);
          if (!parent || parent.version !== item.version || parent.pool !== 'a2' || parent.kind === 'a3' || parent.retired || !['active', 'pending', 'done'].includes(parent.status)) throw new Error(`Scope requires a current active A2 version: ${parentId}`);
          if (!['fact', 'self_report'].includes(parent.statementType) || parent.inference != null) throw new Error('A3 requires explicitly classified A2 fact/self_report; legacy unclassified or inference inputs require a new reviewed A2 version');
          if (parent.correctness.status !== 'unreviewed') throw new Error('A2 with an unresolved correction requires review before A3 writing');
          parents.set(parentId, parent); scope.push({ id: parentId, version: item.version });
        }
        if (coverage.covered.length !== derivedFrom.length || new Set(coverage.covered).size !== coverage.covered.length || coverage.covered.some(parent => !derivedFrom.includes(parent))) throw new Error('coverage.covered must equal derivedFrom');
        const included = new Set(coverage.covered);
        for (const parentId of included) if (!parents.has(parentId)) throw new Error('Covered A2 must be in the declared scope');
        const omitted = new Set();
        const notCovered = coverage.notCovered.map(item => {
          const parentId = identifier(item?.id, 'notCovered ID');
          if (!parents.has(parentId) || included.has(parentId) || omitted.has(parentId)) throw new Error('Coverage lists must be unique and disjoint within scope');
          omitted.add(parentId);
          return { id: parentId, reason: requiredString(item.reason, 'notCovered reason', 500) };
        });
        if (included.size + omitted.size !== parents.size) throw new Error('Coverage must account for every declared scope entry');
        const sourceEntries = derivedFrom.map(parentId => {
          const parent = parents.get(parentId);
          const canonicalParent = this.db.prepare('SELECT json FROM entries WHERE id=? AND version=?').get(parentId, parent.version).json;
          return { id: parentId, version: parent.version, hash: digest(canonicalParent), read: readPointer(parentId, parent.version) };
        });
        const conversationTimes = [...new Map(derivedFrom.flatMap(parentId => {
          const parent = parents.get(parentId);
          return parent.sourceTimes ?? sourceTimes(this, parent.sources ?? []);
        }).map(source => [source.rawId, source])).values()];
        created = { id, instanceId: this.instanceId, version: 0, kind: 'a3', pool: 'a3', text: archiveText, body: structuredBody, sourceTimes: conversationTimes, mentionedTimes: [...new Set(conversationTimes.map(source => source.recordedAt))].sort(), policyVersion: POLICY_VERSION, semanticStatus: 'declared_only', derivedFrom: [...derivedFrom], sourceEntries, coverage: { scope, covered: [...coverage.covered], notCovered, scopeNote }, statementType, depth: 2, sources: [], status: 'active', sourceNature: 'second_distillation', evidenceStatus: 'derived_only', currentValidity: 'unknown', independentSourceCount: null, hooks: archiveLabels(hooks, 'hooks'), tags: archiveLabels(tags, 'tags'), entities: [], aliases: [], project: null, occurredAt: occurredAt == null ? null : instant(occurredAt, 'occurredAt'), legacy: null };
        Object.assign(created, this._a3State(created));
      } else created = { ...old, status: 'archived' };
      created.recordedAt = decidedAt; created.date = this._local(decidedAt).date; created.dictVersion = 'v5';
      created.archiveDecision = { requestId, action, reason, decidedAt, sourceVersion: old?.version ?? 0 };
      this.#commitEntry(created, { expectedVersion, archive: true, allowMissingSources: action === 'revoke' });
      const saved = { requestId, type: 'a3', id, kind: 'a3', version: created.version, pool: 'a3', status: created.status, evidenceStatus: 'derived_only', depth: 2, action, duplicate: false, read: readPointer(id, created.version) };
      this.#saveDecision({ requestId, type: 'a3', id, action, reason, decidedAt, sourceVersion: old?.version ?? 0, version: created.version, derivedFrom: created.derivedFrom, scopeCount: created.coverage.scope.length, coveredCount: created.coverage.covered.length, notCoveredCount: created.coverage.notCovered.length, read: readPointer(id, created.version) }, hash, saved);
      return saved;
    });
    if (created) this._projectEntry(created);
    this._projectEntryIndex(); this._projectDecisions();
    return this._writeResult(result);
  }

  #latestA2Review(id, version) {
    const row = this.db.prepare('SELECT seq,json FROM a2_reviews WHERE entry_id=? AND version=? ORDER BY seq DESC LIMIT 1').get(id, version);
    return row ? { ...parse(row), seq: row.seq } : null;
  }

  #a3Covers(a3Id, id, version, cache = new Map()) {
    if (!cache.has(a3Id)) {
      const row = this.db.prepare("SELECT kind,json_extract(json,'$.pool') AS pool,json_extract(json,'$.status') AS status,json_extract(json,'$.sourceEntries') AS sources,json_extract(json,'$.coverage.covered') AS covered FROM entries WHERE id=? ORDER BY version DESC LIMIT 1").get(a3Id);
      cache.set(a3Id, row ? { ...row, sources: JSON.parse(row.sources ?? '[]'), covered: JSON.parse(row.covered ?? '[]') } : null);
    }
    const archive = cache.get(a3Id);
    return Boolean(archive?.kind === 'a3' && archive.pool === 'a3' && archive.status === 'active' && archive.covered.includes(id) && archive.sources.some(source => source.id === id && source.version === version) && this.getEntry(a3Id)?.correctness.status === 'unreviewed');
  }

  #a2ReviewValid(review, cache = new Map()) {
    return Boolean(review && (review.decision === 'discard' || (review.decision === 'archived' && review.a3Ids.some(id => this.#a3Covers(id, review.id, review.version, cache)))));
  }

  _a2DueQuery() {
    return "FROM entries e WHERE e.version=(SELECT max(version) FROM entries WHERE id=e.id) AND coalesce(json_extract(e.json,'$.pool'),'a2')='a2' AND json_extract(e.json,'$.recordedAt')<=? AND NOT EXISTS (SELECT 1 FROM a2_retirements r WHERE r.entry_id=e.id AND r.version=e.version)";
  }

  listA2ReviewQueue({ limit = 4, offset = 0 } = {}) {
    this._assertOpen(); pageArgs(limit, offset, 100);
    const asOf = this.now(); const cutoff = new Date(new Date(asOf).getTime() - A2_AGE_MS).toISOString();
    const query = this._a2DueQuery(); const cache = new Map();
    const total = this.db.prepare(`SELECT count(*) AS n ${query}`).get(cutoff).n;
    const rows = this.db.prepare(`SELECT e.id,e.version,json_extract(e.json,'$.recordedAt') AS recordedAt ${query} ORDER BY recordedAt,e.id LIMIT ? OFFSET ?`).all(cutoff, limit, offset);
    const items = rows.map(row => ({ ...row, dueAt: new Date(new Date(row.recordedAt).getTime() + A2_AGE_MS).toISOString(), reviewed: this.#a2ReviewValid(this.#latestA2Review(row.id, row.version), cache), read: readPointer(row.id, row.version) }));
    const hasMore = offset + items.length < total;
    return { total, items, hasMore, nextOffset: hasMore ? offset + items.length : null, asOf };
  }

  reviewA2({ requestId, items, reason } = {}) {
    this._assertOpen(); identifier(requestId, 'requestId'); requiredString(reason, 'reason', 2000);
    if (!Array.isArray(items) || !items.length || items.length > 50) throw new TypeError('items must contain 1..50 current A2 versions');
    const normalized = items.map(item => {
      const id = identifier(item?.id);
      if (!Number.isSafeInteger(item.version) || item.version < 1 || !['archived', 'discard'].includes(item.decision)) throw new TypeError('Invalid A2 review item');
      const a3Ids = item.a3Ids ?? [];
      if (!Array.isArray(a3Ids) || a3Ids.length > 50 || new Set(a3Ids).size !== a3Ids.length) throw new TypeError('Invalid A3 archive references');
      a3Ids.forEach(archive => identifier(archive, 'a3Id'));
      if (item.decision === 'archived' ? !a3Ids.length : a3Ids.length) throw new Error('Archived review requires A3 references; discard must not include them');
      return { id, version: item.version, decision: item.decision, a3Ids: [...a3Ids].sort(), reason: requiredString(item.reason, 'item reason', 2000) };
    });
    if (new Set(normalized.map(item => item.id)).size !== normalized.length) throw new TypeError('A2 review IDs must be unique');
    const hash = digest({ type: 'a2_review', requestId, items: normalized, reason });
    const result = this._transaction(() => {
      const replay = this.#decisionReplay(requestId, hash); if (replay) return replay;
      const reviewedAt = this.now(); const insertions = []; const cache = new Map();
      for (const item of normalized) {
        const entry = this.getEntry(item.id);
        if (!entry || entry.pool !== 'a2' || entry.version !== item.version || entry.retired) throw new Error('Review requires a current non-retired A2 version');
        if (item.decision === 'archived' && item.a3Ids.some(a3Id => !this.#a3Covers(a3Id, item.id, item.version, cache))) throw new Error('A3 must currently cover the exact A2 version');
        const previous = this.#latestA2Review(item.id, item.version);
        if (previous && this.#a2ReviewValid(previous, cache)) {
          if (canonical({ id: previous.id, version: previous.version, decision: previous.decision, a3Ids: previous.a3Ids, reason: previous.reason }) !== canonical(item)) throw new Error('A current valid A2 approval cannot be overwritten');
        } else insertions.push({ ...item, requestId, reviewedAt });
      }
      const references = normalized.map(({ id, version, decision }) => ({ id, version, decision, read: readPointer(id, version) }));
      const saved = { requestId, type: 'a2_review', reviewed: normalized.length, items: references, duplicate: false };
      this.#saveDecision({ requestId, type: 'a2_review', reason, reviewedAt, items: normalized }, hash, saved);
      for (const item of insertions) this.db.prepare('INSERT INTO a2_reviews(entry_id,version,request_id,json) VALUES (?,?,?,?)').run(item.id, item.version, requestId, JSON.stringify(item));
      return saved;
    });
    this._projectDecisions(); return this._writeResult(result);
  }

  retireA2({ apply = false } = {}) {
    this._assertOpen(); if (typeof apply !== 'boolean') throw new TypeError('apply must be boolean');
    const changed = [];
    const result = this._transaction(() => {
      const retiredAt = this.now(); const cutoff = new Date(new Date(retiredAt).getTime() - A2_AGE_MS).toISOString();
      const due = this.db.prepare(`SELECT e.id,e.version,e.kind ${this._a2DueQuery()} ORDER BY e.id`).all(cutoff);
      const cache = new Map(); let ready = 0; let pendingReview = 0;
      for (const row of due) {
        const review = this.#latestA2Review(row.id, row.version);
        if (!this.#a2ReviewValid(review, cache)) { pendingReview++; continue; }
        ready++;
        if (apply) {
          const retirement = { id: row.id, version: row.version, decision: review.decision, reason: review.reason, reviewRequestId: review.requestId, reviewSeq: review.seq, retiredAt, read: readPointer(row.id, row.version) };
          this.db.prepare('INSERT INTO a2_retirements(entry_id,version,json) VALUES (?,?,?)').run(row.id, row.version, JSON.stringify(retirement));
          for (const relative of this._entryPaths({ ...row, pool: 'a2' }).slice(1)) this._queueProjection(relative, 'delete');
          changed.push(row.id);
        }
      }
      if (changed.length) { this._queueProjection('logs/a2-retirement.jsonl'); this._queueProjection('index/entries.json'); this._queueProjection('a3/index.json'); }
      return { eligible: due.length, ready, retired: changed.length, pendingReview, applied: apply };
    });
    if (changed.length) {
      for (const id of changed) this._projectEntryCurrent(this.getEntry(id));
      this.writeProjection('logs/a2-retirement.jsonl', jsonl(this.db.prepare('SELECT json FROM a2_retirements ORDER BY entry_id,version').all().map(parse)));
      this._projectEntryIndex();
    }
    return { ...result, projectionPending: this.projectionStatus().projectionPending };
  }

  purgeA2({ requestId, items, reason, apply = false } = {}) {
    this._assertOpen(); identifier(requestId, 'requestId'); requiredString(reason, 'reason', 2000);
    if (typeof apply !== 'boolean' || !Array.isArray(items) || !items.length || items.length > 50) throw new TypeError('Explicit purge requires 1..50 exact versions and apply boolean');
    const keys = new Set();
    const normalized = items.map(item => {
      const id = identifier(item?.id);
      if (!Number.isSafeInteger(item.version) || item.version < 1 || keys.has(`${id}:${item.version}`)) throw new TypeError('Invalid purge version');
      keys.add(`${id}:${item.version}`); return { id, version: item.version };
    });
    const hash = digest({ type: 'a2_purge', requestId, items: normalized, reason });
    const result = this._transaction(() => {
      const replay = this.#decisionReplay(requestId, hash); if (replay) return replay;
      const purgedAt = this.now(); const cutoff = new Date(Date.parse(purgedAt) - A2_AGE_MS).toISOString();
      const ready = []; const blocked = [];
      for (const item of normalized) {
        const row = this.db.prepare('SELECT json FROM entries WHERE id=? AND version=?').get(item.id, item.version);
        const entry = parse(row);
        let why;
        if (!entry || (entry.pool ?? 'a2') !== 'a2') why = 'not_retained_a2';
        else if (entry.recordedAt > cutoff) why = 'not_due';
        else if (!this.db.prepare('SELECT 1 FROM a2_retirements WHERE entry_id=? AND version=?').get(item.id, item.version)) why = 'not_retired';
        else if (!this.#a2ReviewValid(this.#latestA2Review(item.id, item.version))) why = 'review_no_longer_valid';
        else {
          const legacyDependent = this.db.prepare("SELECT 1 FROM entries e,json_each(e.json,'$.sourceEntries') s WHERE e.kind='a3' AND coalesce(json_extract(e.json,'$.policyVersion'),0)<>? AND json_extract(s.value,'$.id')=? AND json_extract(s.value,'$.version')=? LIMIT 1").get(POLICY_VERSION, item.id, item.version);
          if (legacyDependent) why = 'legacy_archive_requires_parent';
        }
        if (why) blocked.push({ ...item, reason: why }); else ready.push({ ...item, entry, canonical: row.json });
      }
      if (!apply) return { requestId, applied: false, ready: ready.length, blocked, purged: 0, removedRaw: 0 };
      if (blocked.length) throw new Error(`Purge blocked: ${blocked.map(item => `${item.id}@${item.version}:${item.reason}`).join(', ')}`);
      const rawIds = new Set();
      for (const item of ready) {
        const entry = item.entry;
        const marker = { id: item.id, version: item.version, kind: entry.kind, pool: 'a2', hash: digest(item.canonical), recordedAt: entry.recordedAt, occurredAt: entry.occurredAt ?? null, sourceTimes: entry.sourceTimes ?? sourceTimes(this, entry.sources), statementType: entry.statementType ?? null, policyVersion: entry.policyVersion ?? null, requestId, reason, purgedAt, review: this.#latestA2Review(item.id, item.version), read: readPointer(item.id, item.version) };
        this.db.prepare('INSERT INTO a2_purges(entry_id,version,json) VALUES (?,?,?)').run(item.id, item.version, JSON.stringify(marker));
        for (const source of entry.sources) rawIds.add(source.rawId);
        this.db.prepare('DELETE FROM evidence WHERE entry_id=? AND version=?').run(item.id, item.version);
        this.#entryPurgeIds.add(`${item.id}:${item.version}`);
        try { this.db.prepare('DELETE FROM entries WHERE id=? AND version=?').run(item.id, item.version); }
        finally { this.#entryPurgeIds.delete(`${item.id}:${item.version}`); }
        this._queueProjection(`a2/${digest(item.id)}/v${item.version}.json`, 'delete');
        this._queueProjection(`archive/${digest(item.id)}/v${item.version}.json`, 'delete');
        // Remove current only if this was the latest retained/current version.
        if (!this.db.prepare('SELECT 1 FROM entries WHERE id=? AND version>?').get(item.id, item.version)) for (const relative of this._entryPaths(entry).slice(1)) this._queueProjection(relative, 'delete');
      }
      let removedRaw = 0;
      for (const rawId of rawIds) {
        const raw = this.getRaw(rawId);
        if (!raw || Date.parse(purgedAt) - Date.parse(raw.recordedAt) < REVIEW_AGE_MS || !this.db.prepare('SELECT 1 FROM self_review_completed WHERE raw_id=?').get(rawId)) continue;
        if (this.db.prepare('SELECT 1 FROM evidence WHERE raw_id=? LIMIT 1').get(rawId)) continue;
        if (this.db.prepare("SELECT 1 FROM correction_events c,json_each(c.json,'$.evidence') s WHERE json_extract(s.value,'$.rawId')=? LIMIT 1").get(rawId)) continue;
        const prior = this.db.prepare('SELECT seq,decision,json FROM reviews WHERE raw_id=? ORDER BY seq DESC LIMIT 1').get(rawId);
        if (prior?.decision === 'retain' && parse(prior)?.source !== 'reviewed_a1_maintenance') continue;
        const rawHash = this.db.prepare('SELECT hash FROM receipts WHERE id=?').get(rawId)?.hash;
        const marker = { rawId, rawHash, requestId, reason: '已审到期 A2 清理后无其他保留引用', purgedAt };
        this.db.prepare('INSERT INTO original_purges(raw_id,json) VALUES (?,?)').run(rawId, JSON.stringify(marker));
        if (this.db.prepare('SELECT 1 FROM raw WHERE id=?').get(rawId)) {
          const review = { rawId, instanceId: this.instanceId, decision: 'discard', reason: marker.reason, reviewedAt: purgedAt, source: 'explicit_a2_purge', requestId };
          const inserted = this.db.prepare('INSERT INTO reviews(raw_id,decision,json) VALUES (?,?,?)').run(rawId, 'discard', JSON.stringify(review));
          const reviewSeq = Number(inserted.lastInsertRowid);
          const tombstone = { rawId, rawHash, reviewSeq, decision: 'discard', deletedAt: purgedAt, requestId };
          this.db.prepare('INSERT INTO deletion_tombstones(raw_id,review_seq,decision,raw_hash,deleted_at,json) VALUES (?,?,?,?,?,?)').run(rawId, reviewSeq, 'discard', rawHash, purgedAt, JSON.stringify(tombstone));
          this.#retentionDeleteIds.add(rawId);
          try { this.db.prepare('DELETE FROM raw WHERE id=?').run(rawId); } finally { this.#retentionDeleteIds.delete(rawId); }
        } else {
          this.#originalPurgeIds.add(rawId);
          try { this.db.prepare('DELETE FROM originals WHERE id=?').run(rawId); } finally { this.#originalPurgeIds.delete(rawId); }
        }
        this.db.prepare('INSERT OR IGNORE INTO dirty_days(date) VALUES (?)').run(raw.date);
        this._queueProjection(`originals/${digest(rawId)}.json`, 'delete');
        this._queueProjection(`a/${raw.date.replaceAll('-', '/')}/raw.jsonl`);
        this._queueProjection(`a/${raw.date.replaceAll('-', '/')}/_day.md`, 'delete');
        removedRaw++;
      }
      const saved = { requestId, type: 'a2_purge', applied: true, items: normalized, ready: ready.length, blocked: [], purged: ready.length, removedRaw, duplicate: false };
      this.#saveDecision({ ...saved, reason, purgedAt }, hash, saved); return saved;
    });
    if (apply && !result.duplicate) this.flush();
    return this._writeResult(result);
  }

  reviewHistory({ limit = 20, offset = 0, id } = {}) {
    this._assertOpen(); pageArgs(limit, offset);
    if (id !== undefined) identifier(id);
    const rows = this.db.prepare('SELECT seq,json FROM memory_decisions ORDER BY seq DESC').all().map(row => ({ seq: row.seq, ...parse(row) })).filter(record => id === undefined || record.id === id || record.rawIds?.includes(id) || record.derivedFrom?.includes(id) || record.entries?.some(entry => entry.id === id) || record.items?.some(entry => entry.id === id) || record.targets?.some(entry => entry.id === id));
    const items = rows.slice(offset, offset + limit).map(record => ({ ...record, reason: clipped(record.reason, 512), ...(record.evidence ? { evidence: record.evidence.map(source => ({ rawId: source.rawId, role: source.role, sourceNature: source.sourceNature, quoteLength: source.quote.length, quoteStatus: source.quoteStatus, semanticStatus: source.semanticStatus, read: readPointer(source.rawId) })) } : {}), ...(record.omissions ? { omissions: record.omissions.map(item => ({ ...item, reason: clipped(item.reason, 256) })) } : {}), ...(record.items ? { items: record.items.map(item => ({ ...item, ...(item.reason ? { reason: clipped(item.reason, 256) } : {}) })) } : {}), truncated: record.reason.length > 512 || Boolean(record.evidence) || Boolean(record.omissions?.some(item => item.reason.length > 256)) || Boolean(record.items?.some(item => item.reason?.length > 256)) }));
    const hasMore = offset + items.length < rows.length;
    return { total: rows.length, items, hasMore, nextOffset: hasMore ? offset + items.length : null };
  }

  recordRecall(event = {}) {
    this._assertOpen();
    // An allowlist keeps queries, excerpts, and raw text out of logs by default.
    const record = { timestamp: this.now(), instanceId: this.instanceId, action: optionalString(event.action ?? event.tool ?? event.operation, 'action') ?? 'recall' };
    for (const key of ['id', 'type', 'timeAxis']) if (event[key] !== undefined) record[key] = requiredString(event[key], key, 200);
    for (const key of ['ids', 'candidateIds']) if (event[key] !== undefined) record[key] = stringList(event[key], key);
    for (const key of ['count', 'resultCount', 'durationMs']) if (typeof event[key] === 'number' && Number.isFinite(event[key]) && event[key] >= 0) record[key] = event[key];
    for (const key of ['hasMore', 'found']) if (typeof event[key] === 'boolean') record[key] = event[key];
    const wasPending = Boolean(this.db.prepare('SELECT 1 FROM projection_pending WHERE path=?').get('logs/recall.jsonl'));
    this._transaction(() => { this.db.prepare('INSERT INTO recalls(json) VALUES (?)').run(JSON.stringify(record)); this._queueProjection('logs/recall.jsonl'); });
    this._appendProjection('logs/recall.jsonl', record, wasPending, () => jsonl(this.db.prepare('SELECT json FROM recalls ORDER BY seq').all().map(parse)));
    return record;
  }

  audit() {
    this._assertOpen();
    const findings = [];
    this._transaction(() => {
      const lineageContext = this._lineageContext();
      for (const row of this.db.prepare('SELECT json FROM entries ORDER BY id,version').all()) {
        const entry = parse(row);
        const reasons = [];
        if (entry.kind === 'a3') { if (this._a3State(entry, lineageContext).lineageBroken) reasons.push('broken_derivation_lineage'); }
        else if (!entry.sources.length && entry.kind !== 'preference' && entry.sourceNature !== 'core_assertion') reasons.push('no_original_evidence');
        for (const source of entry.sources) {
          const raw = this.getRaw(source.rawId);
          if (!raw) reasons.push(this.db.prepare('SELECT 1 FROM entries WHERE id=?').get(source.rawId) ? 'summary_only_or_circular_source' : 'missing_original');
          else if (!raw.text.includes(source.quote)) reasons.push('quote_mismatch');
        }
        if (reasons.length) {
          const finding = { entryId: entry.id, version: entry.version, timestamp: this.now(), reasons: [...new Set(reasons)], action: entry.kind === 'a3' ? 'flag_lineage_only' : 'downgrade_only', ...(entry.kind === 'a3' ? { evidenceStatus: 'derived_only', lineageBroken: true } : entry.kind === 'preference' ? { scope: 'context', evidenceStatus: 'self_report', contextEvidenceStatus: 'unverified' } : { evidenceStatus: 'unverified' }) };
          this.db.prepare('INSERT INTO audits(entry_id,version,json) VALUES (?,?,?)').run(entry.id, entry.version, JSON.stringify(finding));
          findings.push(finding);
          for (const relative of this._entryPaths(entry).slice(1)) this._queueProjection(relative);
        }
      }
      for (const row of this.db.prepare("SELECT r.id,r.json FROM receipts r LEFT JOIN raw a ON a.id=r.id LEFT JOIN originals o ON o.id=r.id LEFT JOIN deletion_tombstones t ON t.raw_id=r.id WHERE r.pool='a' AND a.id IS NULL AND o.id IS NULL AND t.raw_id IS NULL").all()) {
        const review = this.db.prepare('SELECT seq,decision FROM reviews WHERE raw_id=? ORDER BY seq DESC LIMIT 1').get(row.id);
        const finding = { rawId: row.id, timestamp: this.now(), reasons: ['orphaned_raw_receipt'], action: 'record_integrity_gap', deletionAuthorization: 'unproven', historicalReview: review ? { seq: review.seq, decision: review.decision } : null };
        this.db.prepare('INSERT INTO integrity_audits(json) VALUES (?)').run(JSON.stringify(finding));
        findings.push(finding);
      }
      this._queueProjection('logs/audit.jsonl'); this._queueProjection('logs/integrity.jsonl'); this._queueProjection('index/entries.json');
    });
    this.writeProjection('logs/audit.jsonl', jsonl(this.db.prepare('SELECT json FROM audits ORDER BY seq').all().map(parse)));
    this.writeProjection('logs/integrity.jsonl', jsonl(this.db.prepare('SELECT json FROM integrity_audits ORDER BY seq').all().map(parse)));
    for (const id of new Set(findings.map(finding => finding.entryId).filter(Boolean))) this._projectEntryCurrent(this.getEntry(id));
    this._projectEntryIndex();
    return findings;
  }

  reviewRetention({ ids, decision, reason } = {}) {
    this._assertOpen();
    if (!Array.isArray(ids) || !ids.length || ids.length > 10000) throw new TypeError('ids must be a nonempty array');
    const uniqueIds = [...new Set(ids.map(id => identifier(id)))];
    if (!['retain', 'discard'].includes(decision)) throw new TypeError('Decision must be retain or discard');
    requiredString(reason, 'reason', 10000);
    const records = [];
    this._transaction(() => {
      for (const id of uniqueIds) {
        if (!this.db.prepare('SELECT 1 FROM raw WHERE id=?').get(id)) throw new Error(`Review requires active raw: ${id}`);
        if (decision === 'discard' && this.db.prepare('SELECT 1 FROM evidence WHERE raw_id=? LIMIT 1').get(id)) throw new Error(`Cited original must be retained: ${id}`);
        const record = { rawId: id, instanceId: this.instanceId, decision, reason, reviewedAt: this.now() };
        this.db.prepare('INSERT INTO reviews(raw_id,decision,json) VALUES (?,?,?)').run(id, decision, JSON.stringify(record));
        records.push(record);
      }
      this._queueProjection('logs/retention.jsonl');
    });
    this.writeProjection('logs/retention.jsonl', jsonl(this.db.prepare('SELECT json FROM reviews ORDER BY seq').all().map(parse)));
    return records;
  }

  cleanupA1({ apply = false } = {}) {
    this._assertOpen();
    if (typeof apply !== 'boolean') throw new TypeError('apply must be boolean');
    const asOf = this.now();
    const cutoff = new Date(Date.parse(asOf) - REVIEW_AGE_MS).toISOString();
    const result = { asOf, eligible: 0, ready: 0, removed: 0, retained: 0, pendingReview: 0, applied: apply };
    this._transaction(() => {
      // Count and enumerate only metadata. A completed self-review is mandatory
      // even when an older administrator retention decision already exists.
      result.eligible = this.db.prepare("SELECT count(*) AS n FROM raw WHERE json_extract(json,'$.recordedAt')<=?").get(cutoff).n;
      const ready = this.db.prepare("SELECT r.id,r.date,s.request_id FROM raw r JOIN self_review_completed s ON s.raw_id=r.id WHERE json_extract(r.json,'$.recordedAt')<=? ORDER BY json_extract(r.json,'$.recordedAt'),r.id").all(cutoff);
      result.ready = ready.length; result.pendingReview = result.eligible - ready.length;
      for (const row of ready) {
        let review = this.db.prepare('SELECT seq,decision FROM reviews WHERE raw_id=? ORDER BY seq DESC LIMIT 1').get(row.id);
        const cited = Boolean(this.db.prepare('SELECT 1 FROM evidence WHERE raw_id=? LIMIT 1').get(row.id));
        const decision = review?.decision === 'retain' || cited ? 'retain' : 'discard';
        if (decision === 'retain') result.retained++;
        if (!apply) continue;
        // Preserve an administrator's existing decision; automatic decisions
        // are made only for reviewed raw records with no retention review yet.
        if (!review) {
          const record = { rawId: row.id, instanceId: this.instanceId, decision, reason: `满 168 小时且已完成自审 ${row.request_id}，移出 A1 活动池；${decision === 'retain' ? '保留原始依据' : '无引用且无管理员保留决定' }。`, reviewedAt: asOf, source: 'reviewed_a1_maintenance', selfReviewRequestId: row.request_id };
          const inserted = this.db.prepare('INSERT INTO reviews(raw_id,decision,json) VALUES (?,?,?)').run(row.id, decision, JSON.stringify(record));
          review = { seq: Number(inserted.lastInsertRowid), decision };
          this._queueProjection('logs/retention.jsonl');
        }
        const raw = this.db.prepare('SELECT json FROM raw WHERE id=?').get(row.id);
        if (decision === 'retain') this.db.prepare('INSERT OR IGNORE INTO originals(id,json) VALUES (?,?)').run(row.id, raw.json);
        const rawHash = this.db.prepare('SELECT hash FROM receipts WHERE id=?').get(row.id).hash;
        const tombstone = { rawId: row.id, reviewSeq: review.seq, decision, rawHash, deletedAt: asOf, source: 'reviewed_a1_maintenance', selfReviewRequestId: row.request_id };
        this.db.prepare('INSERT INTO deletion_tombstones(raw_id,review_seq,decision,raw_hash,deleted_at,json) VALUES (?,?,?,?,?,?)').run(row.id, review.seq, decision, rawHash, asOf, JSON.stringify(tombstone));
        this.#retentionDeleteIds.add(row.id);
        try { this.db.prepare('DELETE FROM raw WHERE id=?').run(row.id); }
        finally { this.#retentionDeleteIds.delete(row.id); }
        this.db.prepare('INSERT OR IGNORE INTO dirty_days(date) VALUES (?)').run(row.date);
        this._queueProjection(`a/${row.date.replaceAll('-', '/')}/raw.jsonl`);
        this._queueProjection(`a/${row.date.replaceAll('-', '/')}/_day.md`, 'delete');
        if (decision === 'retain') this._queueProjection(`originals/${digest(row.id)}.json`);
        result.removed++;
      }
    });
    if (apply && result.removed) this.flush();
    return { ...result, committed: apply, projectionPending: this.projectionStatus().pending };
  }

  slide({ now = this.now(), apply = false, days = 7 } = {}) {
    this._assertOpen();
    if (!Number.isSafeInteger(days) || days < 1 || days > 36500) throw new TypeError('days must be 1..36500');
    if (typeof apply !== 'boolean') throw new TypeError('apply must be boolean');
    const today = this._local(instant(now, 'now')).date;
    const cutoffInstant = new Date(`${today}T00:00:00.000Z`);
    cutoffInstant.setUTCDate(cutoffInstant.getUTCDate() - days + 1);
    const cutoff = cutoffInstant.toISOString().slice(0, 10);
    const result = { cutoff, eligible: 0, blocked: 0, removed: 0, retained: 0 };
    this._transaction(() => {
      const expired = this.db.prepare('SELECT id,json FROM raw WHERE date<? ORDER BY date,id').all(cutoff);
      result.eligible = expired.length;
      for (const raw of expired) {
        const review = this.db.prepare('SELECT seq,decision FROM reviews WHERE raw_id=? ORDER BY seq DESC LIMIT 1').get(raw.id);
        if (!review) { result.blocked++; continue; }
        const cited = Boolean(this.db.prepare('SELECT 1 FROM evidence WHERE raw_id=? LIMIT 1').get(raw.id));
        if (review.decision === 'retain' || cited) {
          result.retained++;
          if (apply) this.db.prepare('INSERT OR IGNORE INTO originals(id,json) VALUES (?,?)').run(raw.id, raw.json);
        }
        if (apply) {
          const decision = review.decision === 'retain' || cited ? 'retain' : 'discard';
          const rawHash = this.db.prepare('SELECT hash FROM receipts WHERE id=?').get(raw.id).hash;
          const tombstone = { rawId: raw.id, reviewSeq: review.seq, decision, rawHash, deletedAt: this.now() };
          this.db.prepare('INSERT INTO deletion_tombstones(raw_id,review_seq,decision,raw_hash,deleted_at,json) VALUES (?,?,?,?,?,?)').run(raw.id, review.seq, decision, rawHash, tombstone.deletedAt, JSON.stringify(tombstone));
          this.#retentionDeleteIds.add(raw.id);
          try { this.db.prepare('DELETE FROM raw WHERE id=?').run(raw.id); }
          finally { this.#retentionDeleteIds.delete(raw.id); }
          const date = JSON.parse(raw.json).date;
          this.db.prepare('INSERT OR IGNORE INTO dirty_days(date) VALUES (?)').run(date);
          this._queueProjection(`a/${date.replaceAll('-', '/')}/raw.jsonl`);
          this._queueProjection(`a/${date.replaceAll('-', '/')}/_day.md`, 'delete');
          if (decision === 'retain') this._queueProjection(`originals/${digest(raw.id)}.json`);
          result.removed++;
        }
      }
    });
    if (apply && result.removed) this.flush();
    return { ...result, ...(apply ? { committed: true, projectionPending: this.projectionStatus().projectionPending } : {}) };
  }

  graph({ center = 'self', depth = 2, limit = 100, pool = 'c' } = {}) {
    this._assertOpen(); identifier(center, 'center'); pageArgs(limit, 0, 500);
    if (!Number.isSafeInteger(depth) || depth < 1 || depth > 5) throw new TypeError('depth must be 1..5');
    if (!['a2', 'c', 'all'].includes(pool)) throw new TypeError('Invalid graph pool');
    const entities = new Map(this.listEntries({ kind: 'entity' }).map(entry => [entry.id, entry]));
    if (center !== 'self' && !entities.has(center)) throw new Error('Graph center must be self or an entity ID');
    const outgoing = new Map();
    for (const edge of this.listEntries({ kind: 'relation', status: 'active', pool })) {
      const from = edge.from ?? 'self';
      if (edge.correctness.status !== 'unreviewed' || edge.auditDowngraded) continue;
      if ([from, edge.to].some(endpoint => endpoint !== 'self' && entities.has(endpoint) && (entities.get(endpoint).auditDowngraded || entities.get(endpoint).correctness.status !== 'unreviewed'))) continue;
      if (!outgoing.has(from)) outgoing.set(from, []);
      outgoing.get(from).push(edge);
      if (edge.to !== from) {
        if (!outgoing.has(edge.to)) outgoing.set(edge.to, []);
        outgoing.get(edge.to).push(edge);
      }
    }
    const nodes = new Map(); const edges = []; const seen = new Set([center]); const emitted = new Set();
    let truncated = false; let depthLimited = false;
    const addNode = id => {
      if (nodes.has(id)) return;
      if (id === 'self') { nodes.set(id, { id: 'self', name: '肥鱼', pool: 'identity', status: 'active', placeholder: false }); return; }
      const entity = entities.get(id);
      const name = entity?.text ?? id;
      const boundedId = entity ? id : `@legacy:${digest(id)}`;
      nodes.set(id, { id: boundedId, name: clipped(name, 200), pool: entity?.pool ?? null, status: entity?.status ?? 'unknown', placeholder: !entity, truncated: name.length > 200 || id.length > 200, ...(entity ? { version: entity.version, read: readPointer(entity.id, entity.version) } : {}) });
      if (name.length > 200 || id.length > 200) truncated = true;
    };
    addNode(center);
    const queue = [{ id: center, distance: 0 }];
    for (let index = 0; index < queue.length; index++) {
      const { id, distance } = queue[index];
      const next = outgoing.get(id) ?? [];
      if (distance >= depth) { if (next.length) depthLimited = true; continue; }
      for (const edge of next) {
        if (emitted.has(edge.id)) continue;
        if (edges.length >= limit) { truncated = true; continue; }
        const from = edge.from ?? 'self'; const to = edge.to;
        // Legacy endpoints remain distinct; never merge them through aliases.
        if (typeof to !== 'string' || !to) { truncated = true; continue; }
        addNode(from); addNode(to);
        const textTruncated = edge.rel.length > 200 || (edge.note?.length ?? 0) > 500;
        if (textTruncated) truncated = true;
        edges.push({ id: edge.id, version: edge.version, from: nodes.get(from).id, to: nodes.get(to).id, rel: clipped(edge.rel, 200), note: clipped(edge.note ?? null, 500), pool: edge.pool, status: edge.status, since: edge.occurredAt ?? edge.recordedAt, evidenceStatus: edge.evidenceStatus, currentValidity: edge.currentValidity, truncated: textTruncated, read: readPointer(edge.id, edge.version) });
        emitted.add(edge.id);
        for (const endpoint of [from, to]) if (!seen.has(endpoint)) { seen.add(endpoint); queue.push({ id: endpoint, distance: distance + 1 }); }
      }
    }
    return { center, depth, limit, pool, nodes: [...nodes.values()], edges, nodeCount: nodes.size, edgeCount: edges.length, truncated, depthLimited, legacySelfConflict: entities.has('self'), note: '按双向邻接展开，边仍保留原 from→to：from 认为 to 是 rel；不补反向边或传递关系。核心选择和引文命中均不表示事实确认。旧 self 条目若存在仅作兼容读取，不替代肥鱼虚拟中心。' };
  }
  dayStats(date, { role } = {}) {
    this._assertOpen(); validateDate(date);
    if (role !== undefined && !ROLES.has(role)) throw new TypeError('Invalid role');
    const a = { total: 0, roles: {}, hours: {} }; const b = { total: 0, roles: {}, hours: {} };
    // Retained originals count as past participation even after leaving the sliding window.
    const rows = this.db.prepare('SELECT json FROM raw WHERE date=? UNION ALL SELECT json FROM originals WHERE json_extract(json,\'$.date\')=?').all(date, date);
    for (const row of rows) { const raw = parse(row); if (role && raw.role !== role) continue; const hour = this._local(raw.recordedAt).hour; a.total++; a.roles[raw.role] = (a.roles[raw.role] ?? 0) + 1; a.hours[hour] = (a.hours[hour] ?? 0) + 1; }
    for (const row of this.db.prepare('SELECT * FROM b_stats WHERE date=?').all(date)) { if (role && row.role !== role) continue; b.total += row.count; b.roles[row.role] = (b.roles[row.role] ?? 0) + row.count; b.hours[row.hour] = (b.hours[row.hour] ?? 0) + row.count; }
    return { date, a, b };
  }

  flush() {
    this._assertOpen();
    cleanupB2(this, { apply: true });
    this._cleanupTemps();
    this.writeProjection('identity.json', JSON.stringify(this._metadata, null, 2) + '\n');
    // Cleanup/delete tasks are replayable without storing discarded plaintext.
    for (const row of this.db.prepare("SELECT path,operation FROM projection_pending WHERE operation='delete'").all()) {
      if (!this._ownedProjection(row.path)) throw new Error('Invalid projection deletion task');
      this._removeProjection(row.path);
    }
    // Invalidation is committed with retention changes. A restart after the SQL
    // commit therefore cannot leave an old excerpt in a partially retained day.
    const dirtyDates = this.db.prepare('SELECT date FROM dirty_days').all().map(row => validateDate(row.date));
    for (const date of dirtyDates) {
      this._removeProjection(`a/${date.replaceAll('-', '/')}/_day.md`);
    }
    // The projection inventory is not trusted to name arbitrary paths for deletion.
    // Only known raw.jsonl paths are cleared; user-authored files are never traversed/deleted.
    const dateRows = this.db.prepare('SELECT DISTINCT date FROM raw UNION SELECT DISTINCT json_extract(json,\'$.date\') AS date FROM originals UNION SELECT DISTINCT date FROM b_stats').all();
    const oldInventoryPath = this.safePath('index/projections.json');
    let previousDates = [];
    if (fs.existsSync(oldInventoryPath)) try {
      const oldInventory = JSON.parse(fs.readFileSync(oldInventoryPath, 'utf8'));
      if (Array.isArray(oldInventory.rawDates)) previousDates = oldInventory.rawDates.map(validateDate);
    } catch (error) {
      if (!(error instanceof SyntaxError || error instanceof TypeError || RECOVERABLE_IO.has(error.code))) throw error;
      this._queueProjection('index/projections.json', 'write', error.code ?? 'INVALID_PROJECTION');
    }
    const rawRows = this.db.prepare('SELECT json FROM raw ORDER BY rowid').all().map(parse);
    const rawDates = [...new Set(rawRows.map(raw => raw.date))].sort();
    // Receipts retain no content but allow recovery of a removed day's stale projection.
    const receiptDates = this.db.prepare("SELECT json FROM receipts WHERE pool='a'").all().map(parse).map(record => this._local(record.recordedAt).date);
    for (const date of new Set([...rawDates, ...previousDates, ...receiptDates])) {
      const records = rawRows.filter(raw => raw.date === date);
      this.writeProjection(`a/${date.replaceAll('-', '/')}/raw.jsonl`, jsonl(records));
    }
    for (const row of this.db.prepare('SELECT json FROM originals ORDER BY id').all()) {
      const original = parse(row);
      this.writeProjection(`originals/${digest(original.id)}.json`, JSON.stringify(original, null, 2) + '\n');
    }
    for (const row of this.db.prepare('SELECT json FROM entries ORDER BY id,version').all()) this._projectEntry(parse(row), { current: false });
    for (const entry of this.listEntries({ includeRetired: true })) if (entry.kind !== 'b2') this._projectEntryCurrent(entry);
    projectB2(this);
    for (const { date } of dateRows) if (this.dayStats(date).b.total) this.writeProjection(`b/${date.replaceAll('-', '/')}/stats.json`, JSON.stringify(this.dayStats(date).b, null, 2) + '\n');
    for (const [table, file] of [['recalls', 'recall'], ['audits', 'audit'], ['reviews', 'retention'], ['integrity_audits', 'integrity'], ['memory_decisions', 'decisions']]) this.writeProjection(`logs/${file}.jsonl`, jsonl(this.db.prepare(`SELECT json FROM ${table} ORDER BY seq`).all().map(parse)));
    this.writeProjection('logs/a2-retirement.jsonl', jsonl(this.db.prepare('SELECT json FROM a2_retirements ORDER BY entry_id,version').all().map(parse)));
    for (const [version, content] of [['v1', DICTIONARY], ['v2', DICTIONARY_V2], ['v3', DICTIONARY_V3], ['v4', DICTIONARY_V4], ['v5', DICTIONARY_V5]]) {
      const relative = `dict/${version}.md`;
      const dictionaryPath = this.safePath(relative);
      try {
        if (fs.existsSync(dictionaryPath) && fs.readFileSync(dictionaryPath, 'utf8') !== content) throw new Error(`Immutable dictionary ${version} was changed; use a new version`);
      } catch (error) {
        if (!RECOVERABLE_IO.has(error.code)) throw error;
        this._queueProjection(relative, 'write', error.code);
      }
      this.writeProjection(relative, content);
    }
    const entries = this.listEntries();
    this._projectEntryIndex();
    this.writeProjection('index/projections.json', JSON.stringify({ rawDates }, null, 2) + '\n');
    this._transaction(() => {
      for (const date of dirtyDates) if (!this.db.prepare('SELECT 1 FROM projection_pending WHERE path=?').get(`a/${date.replaceAll('-', '/')}/_day.md`)) this.db.prepare('DELETE FROM dirty_days WHERE date=?').run(date);
    });
    return { raw: rawRows.length, entries: entries.length, originalEvidence: this.db.prepare('SELECT count(*) AS n FROM originals').get().n, projectionPending: this.projectionStatus().projectionPending, pendingCount: this.projectionStatus().pendingCount };
  }

  close() {
    if (this._closed) return;
    this.db.close();
    this._closed = true;
  }
}

export default MemoryStore;
