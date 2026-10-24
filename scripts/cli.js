#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync, existsSync, lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore } from '../lib/store.js';
import { createTools } from '../lib/tools.js';
import { buildWake, generateDay, runSlide, rebuildDerived } from '../lib/lifecycle.js';
import { exportBackup, restoreBackup, verifyBackup, readBackupStatus, createBackupScheduler } from '../lib/backup.js';
import { sensitiveInventory } from '../lib/redaction.js';

const help = `肥鱼记忆 v0.6.0（Node 24+，零运行时依赖；schema 7、字典 v6）
用法：node scripts/cli.js <命令> --data <专属目录> --instance <身份ID> [选项]

init                   创建身份绑定的数据目录
append --input 文件|-  管理员采集原始消息，JSON 对象；不供模型调用
search --query 文本    查找短候选；--subject/--topic/--event-keywords 可单独使用
                       --axis mentioned|occurred|recorded|either；--time-window last_week|recent_7_days
read --id ID           分页展开；--version-number N，--offset/--limit 字符数
                       --view body|evidence|history|full；--fields text,role,recordedAt
                       --evidence-offset/--evidence-limit 分页查看引文
                       A3: --source-offset/--source-limit、--coverage-offset/--coverage-limit
list                   列目录；--pool a1|a2|a3|b|b2|b3|c|d，--date/--type/--status/--entity/--project/--limit
fetch --input 文件|-   简洁批读或精确 session/turn 读取；模型游标不能跨独立CLI进程
prepare --input 文件|- 写前来源定位、相关旧记忆及同名实体候选，不写内容
manage --input 文件|-  D经验、复核、事项线、合并/撤销、进度及日报；参数见工具与经验池文档
write --input 文件|-   写入 A2 的 memory/doing/entity/relation（带明确来源）
review-queue           查看满七天的待自审查原文指针；--limit/--cursor；旧--offset兼容
review-request --input 文件|-  登记重要事件提前审查；不自动生成提纯内容
self-review --input 文件|-  提交提炼或明确略过理由（不会批准删除原文）
self-review --action history  查看自审查、A3归档、C关系网与喜好决策；--id/--limit/--offset
self-review --action batch --input 文件|-  独立单元分别提交；共享来源/依赖须放同一单元
a3-write --input 文件|- 从 A2 显式写入/撤销 A3，须说明完整声明批次的覆盖范围
a3-list                列 A3；--status、--orphaned true|false、--lineage-broken true|false
a3-read --id ID        分页读取 A3 与父 A2 短摘要和原文指针
a2-review-queue        查看满30天的 A2 待清理审查条目；--limit/--cursor；旧--offset兼容
a2-review --input 文件|- 明确逐条审查为 archived/discard；不会生成A3或删除原文
a2-cleanup [--apply]   预览/执行到期且已批准的 A2 活动池清理；版本历史与原文保留
purge-a2 --input 文件|- [--apply]  管理员预览/释放已到期、已审且退出活动池的精确A2正文
core --input 文件|-    晋升或撤销 C 关系网节点/边
core-write --input 文件|-  自主记录C节点/有向关系，推断须注明依据及不确定性
correct --input 文件|-  登记有原文依据的更正、争议或状态变化，关联下游待复核
preference --input 文件|-  B3自身喜好/情感及C第一层人物明确喜好，分别标subject
b2-write --input 文件|- 保存/撤销独处冲浪关键记忆与判断、外部网址引用，首次写入后14天到期
b2-cleanup [--apply]   预览/清理已到期 B2；修改不延长期限
graph                  有向关系网；--center self，--depth 2，--pool c|a2|all，--limit
day-end --date 日期    生成规则日记（带角色的摘录，不作事实提纯）
wake                   查看有长度上限的常驻醒来条
slide                  预览七天滑动；显式 --apply 才执行，未审核原文会阻止删除
review --input 文件|-  管理员审核 {ids:[...],decision:"retain"|"discard",reason:"..."}
audit                  审计出处；只降级，不删除
dict                   显示固定版本字典
rebuild                从 SQLite 修复文件投影
doctor                 输出本模块与 Node 环境信息（不探测其他实例）
privacy-audit --data 目录  直接只读扫描现存SQLite权威文本；仅模式计数，不打印正文、不迁移、不清理
export --file 文件     导出单个完整.feiyu-backup记忆包，拒绝覆盖已有导出文件
verify-backup --file 文件  校验备份完整性和兼容性；不需要--data
import --file 文件 --target 新目录  导入记忆备份；restore同义；仅新/空目录，不合并、不覆盖原库
backup-status          只读显示自动备份状态；可带--backup-dir，不打开数据库
backup-check --backup-dir 目录  按计划检查/补做最新覆盖备份；--interval-days 1..30或--schedule monthly

通用：--timezone Asia/Shanghai（默认），--help，--version
搜索／列表：时间过滤自动包含历史版本；--include-history 显式包含历史；search --fuzzy 开启有限错字候选
B 只返回参与统计；支持日期边界和 --type user|assistant|tool，不保存正文。
B3分别记录表达持有者；非self须是C第一层人物且明确引用自述；--type preference可检索。
B2 只保留关键记忆、判断和网址元数据，不保留冲浪全文，不是原文证据。
A3正文为body:{time,persons,event}，只接受statementType:fact|self_report，固定derived_only。
新A3可独立于原文存活，保留覆盖/未覆盖和来源时间；原文已释放时如实说明不能回查。
import不包含DSH聊天列表、图片附件或模型密钥；导入后按identity配置新dataDir，再启动插件重建。
JSON 输入使用 UTF-8。--input - 从标准输入读取；普通命令的相对路径相对当前目录；备份/导出/验证/导入命令的目录和文件必须使用绝对路径。
不连接模型、不读取旧灵枢、不运行定时器。`;

/** Read-only inventory, deliberately independent of MemoryStore initialization.
 * Never return a matched value, record ID, SQL parameter, or body excerpt. */
function privacyAudit({ dataDir, expectedInstanceId }) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) throw new Error('privacy-audit需要--data');
  const file = join(resolve(dataDir), 'memory.sqlite');
  if (!existsSync(file) || !lstatSync(file).isFile()) throw new Error('privacy-audit只接受已存在的普通memory.sqlite文件；不会创建目录或数据库');
  const db = new DatabaseSync(file, { readOnly: true });
  const authoritative = ['meta', 'raw', 'originals', 'receipts', 'captures', 'entries', 'reviews', 'recalls', 'audits',
    'deletion_tombstones', 'integrity_audits', 'memory_decisions', 'self_review_completed', 'a2_reviews', 'a2_retirements',
    'early_reviews', 'correction_events', 'a2_purges', 'original_purges', 'b2_notes', 'b2_requests', 'b2_expirations',
    'workflow_events', 'workflow_sources', 'entry_commits'];
  try {
    db.exec('PRAGMA query_only=ON; BEGIN');
    const existing = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(item => item.name));
    let identity = null;
    if (existing.has('meta')) {
      const value = db.prepare("SELECT value FROM meta WHERE key='identity'").get()?.value;
      if (value) { try { identity = JSON.parse(value); } catch { throw new Error('记忆身份元数据无效；只读审查已停止'); } }
    }
    if (expectedInstanceId && identity?.instanceId !== expectedInstanceId) throw new Error('记忆实例身份不匹配；只读审查已停止');
    const result = { readOnly: true, authority: 'memory.sqlite', schema: Number.isSafeInteger(identity?.schema) ? identity.schema : null,
      rowsScanned: 0, fieldsScanned: 0, matchedFields: 0, patterns: {}, tables: [], backupsScanned: false, projectionsScanned: false,
      note: '仅统计已知权威表的敏感模式，重复存储可能重复计数；未命中不代表没有秘密。既有备份/导出、派生文件与DSH聊天记录未扫描，也不会改写。' };
    for (const table of authoritative) {
      if (!existing.has(table)) continue;
      // Table names are static; column names come from metadata but are quoted.
      const columns = db.prepare(`PRAGMA table_info("${table}")`).all().filter(item => String(item.type).toUpperCase().includes('TEXT')).map(item => item.name);
      if (!columns.length) continue;
      const quote = name => `"${name.replaceAll('"', '""')}"`;
      const stats = { table, rowsScanned: 0, fieldsScanned: 0, matchedFields: 0, patterns: {} };
      for (const row of db.prepare(`SELECT ${columns.map(quote).join(',')} FROM "${table}"`).iterate()) {
        stats.rowsScanned++;
        for (const value of Object.values(row)) if (typeof value === 'string') {
          stats.fieldsScanned++;
          const inventory = sensitiveInventory(value);
          if (inventory.detected) stats.matchedFields++;
          for (const { type, count } of inventory.redactions) stats.patterns[type] = (stats.patterns[type] ?? 0) + count;
        }
      }
      result.rowsScanned += stats.rowsScanned; result.fieldsScanned += stats.fieldsScanned; result.matchedFields += stats.matchedFields;
      for (const [type, count] of Object.entries(stats.patterns)) result.patterns[type] = (result.patterns[type] ?? 0) + count;
      result.tables.push(stats);
    }
    result.tablesOutsideContentScan = [...existing].filter(name => !authoritative.includes(name)).length;
    return result;
  } finally { db.close(); }
}

export async function main(argv = process.argv.slice(2)) {
  let store;
  try {
    const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true,
      options: {
        data: { type: 'string' }, instance: { type: 'string' }, timezone: { type: 'string' },
        input: { type: 'string' }, query: { type: 'string' }, id: { type: 'string' },
        date: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' },
        axis: { type: 'string' }, type: { type: 'string' }, status: { type: 'string' }, entity: { type: 'string' },
        project: { type: 'string' }, pool: { type: 'string' }, center: { type: 'string' }, depth: { type: 'string' }, action: { type: 'string' },
        subject: { type: 'string' }, topic: { type: 'string' }, 'event-keywords': { type: 'string' },
        'time-window': { type: 'string' }, 'reference-time': { type: 'string' },
        file: { type: 'string' }, target: { type: 'string' }, 'backup-dir': { type: 'string' },
        'interval-days': { type: 'string' }, schedule: { type: 'string' },
        limit: { type: 'string' }, offset: { type: 'string' },
        cursor: { type: 'string' }, view: { type: 'string' }, fields: { type: 'string' }, fuzzy: { type: 'boolean' },
        'version-number': { type: 'string' }, apply: { type: 'boolean', default: false },
        'evidence-offset': { type: 'string' }, 'evidence-limit': { type: 'string' },
        'source-offset': { type: 'string' }, 'source-limit': { type: 'string' },
        'coverage-offset': { type: 'string' }, 'coverage-limit': { type: 'string' },
        'metadata-offset': { type: 'string' }, 'metadata-limit': { type: 'string' },
        orphaned: { type: 'string' }, 'lineage-broken': { type: 'string' },
        'include-history': { type: 'boolean' },
        help: { type: 'boolean' }, version: { type: 'boolean' }
      }
    });
    if (v.help || positionals.length === 0 && !v.version) { console.log(help); return; }
    if (v.version) { console.log('0.6.0'); return; }
    const command = positionals[0];
    const commands = ['init','append','search','read','list','fetch','prepare','manage','privacy-audit','write','review-queue','review-request','self-review','a3-write','a3-list','a3-read','a2-review-queue','a2-review','a2-cleanup','purge-a2','core','core-write','correct','preference','b2-write','b2-cleanup','graph','day-end','wake','slide','review','audit','dict','rebuild','doctor','export','import','restore','verify-backup','backup-status','backup-check'];
    if (positionals.length !== 1 || !commands.includes(command)) throw new Error(`未知命令：${positionals.join(' ')}；使用 --help`);
    if (!['import','restore','verify-backup','backup-status','privacy-audit'].includes(command) && (!v.data || !v.instance)) throw new Error('必须显式提供 --data 与 --instance，避免混用不同实例的记忆。');
    if (command === 'privacy-audit') {
      if (v.apply || v.input || v.file || v.target || v['backup-dir']) throw new Error('privacy-audit只读扫描--data中的现存数据库，不接受修改、备份或输入文件选项');
      console.log(JSON.stringify(privacyAudit({ dataDir: v.data, expectedInstanceId: v.instance }), null, 2));
      return;
    }
    const integer = (key, fallback) => {
      if (v[key] === undefined) return fallback;
      if (!/^\d+$/.test(v[key])) throw new Error(`--${key} 必须为非负整数`);
      const value = Number(v[key]);
      if (!Number.isSafeInteger(value)) throw new Error(`--${key} 超出安全整数范围`);
      return value;
    };
    const boolean = key => {
      if (v[key] === undefined) return undefined;
      if (!['true', 'false'].includes(v[key])) throw new Error(`--${key} 必须为 true 或 false`);
      return v[key] === 'true';
    };
    const input = () => {
      if (!v.input) throw new Error('该命令需要 --input 文件或 --input -');
      const value = JSON.parse(readFileSync(v.input === '-' ? 0 : v.input, 'utf8').replace(/^\uFEFF/, ''));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('输入必须为 JSON 对象');
      return value;
    };
    // Backup/restore must not initialize, migrate, or run retention on the source database.
    if (['export','import','restore','verify-backup','backup-status','backup-check'].includes(command)) {
      let result;
      if (command === 'export') result = await exportBackup({dataDir:v.data,file:v.file,expectedInstanceId:v.instance});
      if (command === 'import' || command === 'restore') result = await restoreBackup({file:v.file,targetDir:v.target,expectedInstanceId:v.instance});
      if (command === 'verify-backup') result = await verifyBackup({file:v.file,expectedInstanceId:v.instance});
      if (command === 'backup-status') {
        if (!v.data) throw new Error('backup-status需要--data');
        result = readBackupStatus({dataDir:v.data,backupDir:v['backup-dir']});
      }
      if (command === 'backup-check') {
        const scheduler = createBackupScheduler({dataDir:v.data,backupDir:v['backup-dir'],expectedInstanceId:v.instance,
          enabled:true,intervalDays:integer('interval-days',1),schedule:v.schedule ?? 'interval',timezone:v.timezone ?? 'Asia/Shanghai'});
        try { result = await scheduler.check(); if (result.lastError) process.exitCode = 1; }
        finally { await scheduler.close(); }
      }
      console.log(JSON.stringify(result,null,2)); return;
    }
    store = new MemoryStore({dataDir:v.data,instanceId:v.instance,timezone:v.timezone || 'Asia/Shanghai'});
    const api = createTools(store);
    const filters = Object.fromEntries(Object.entries({q:v.query || '',type:v.type,pool:v.pool,status:v.status,date:v.date,from:v.from,to:v.to,timeAxis:v.axis,
      subject:v.subject,topic:v.topic,eventKeywords:v['event-keywords'],
      timeWindow:v['time-window'] ? {preset:v['time-window'],...(v['reference-time'] ? {asOf:v['reference-time']} : {})} : undefined,
      entity:v.entity,project:v.project,includeHistory:v['include-history'],limit:integer('limit',4),offset:integer('offset',0)}).filter(([,value]) => value !== undefined));
    let result;
    switch (command) {
      case 'init': store.flush(); result = {ok:true,dataDir:store.dataDir,instanceId:store.instanceId}; break;
      case 'append': result = store.appendRaw(input()); store.flush(); break;
      case 'search': result = api.memory_search({ ...filters, ...(v.fuzzy === undefined ? {} : { fuzzy: v.fuzzy }) }); break;
      case 'fetch': result = api.memory_fetch(input()); break;
      case 'prepare': result = api.memory_prepare(input()); break;
      case 'manage': result = api.memory_manage(input()); store.flush(); break;
      case 'read':
      case 'a3-read':
        if (!v.id) throw new Error('read 需要 --id');
        result = api[command === 'a3-read' ? 'memory_a3_read' : 'memory_read']({id:v.id,kind:v.type,pool:v.pool,version:integer('version-number',undefined),offset:integer('offset',0),limit:integer('limit',undefined),evidenceOffset:integer('evidence-offset',0),evidenceLimit:integer('evidence-limit',undefined),sourceOffset:integer('source-offset',0),sourceLimit:integer('source-limit',undefined),coverageOffset:integer('coverage-offset',0),coverageLimit:integer('coverage-limit',undefined),
          metadataOffset:integer('metadata-offset',0),metadataLimit:integer('metadata-limit',undefined),
          ...(v.view === undefined ? {} : { view: v.view }), ...(v.fields === undefined ? {} : { fields: v.fields.split(',').map(value => value.trim()) })}); break;
      case 'list': result = api.memory_list(filters); break;
      case 'write': result = api.memory_write(input()); store.flush(); break;
      case 'review-queue': result = api.memory_review_queue({limit:integer('limit',undefined),offset:integer('offset',0),...(v.cursor === undefined ? {} : {cursor:v.cursor})}); break;
      case 'review-request': result = api.memory_review_request(input()); store.flush(); break;
      case 'self-review': {
        if (v.action === 'history') {
          if (v.input) throw new Error('self-review --action history 不接受 --input');
          result = api.memory_review({action:'history',id:v.id,limit:integer('limit',undefined),offset:integer('offset',0)});
        } else {
          if (v.action !== undefined && !['submit', 'batch'].includes(v.action)) throw new Error('self-review --action 必须为 submit、batch 或 history');
          const submission = input();
          const action = v.action ?? submission.action ?? 'submit';
          if (!['submit', 'batch'].includes(action) || submission.action !== undefined && submission.action !== action) throw new Error('自审查 JSON 与命令行 action 须一致并为 submit 或 batch；历史查询使用 --action history');
          result = api.memory_review({...submission,action});
          store.flush();
        }
        break;
      }
      case 'core': result = api.memory_core(input()); store.flush(); break;
      case 'core-write': result = api.memory_core_write(input()); store.flush(); break;
      case 'correct': result = api.memory_correct(input()); store.flush(); break;
      case 'a3-write': result = api.memory_a3_write(input()); store.flush(); break;
      case 'a3-list': result = api.memory_a3_list({status:v.status,orphaned:boolean('orphaned'),lineageBroken:boolean('lineage-broken'),includeHistory:v['include-history'],limit:integer('limit',4),offset:integer('offset',0)}); break;
      case 'a2-review-queue': result = api.memory_a2_review_queue({limit:integer('limit',undefined),offset:integer('offset',0),...(v.cursor === undefined ? {} : {cursor:v.cursor})}); break;
      case 'a2-review': result = api.memory_a2_review(input()); store.flush(); break;
      case 'a2-cleanup': result = api.memory_a2_cleanup({apply:v.apply}); break;
      case 'purge-a2': result = store.purgeA2({...input(),apply:v.apply}); break;
      case 'preference': result = api.memory_preference(input()); store.flush(); break;
      case 'b2-write': result = api.memory_b2_write(input()); store.flush(); break;
      case 'b2-cleanup': result = store.cleanupB2({apply:v.apply}); break;
      case 'graph': result = api.memory_graph({center:v.center,pool:v.pool,depth:integer('depth',undefined),limit:integer('limit',undefined)}); break;
      case 'day-end':
        if (!v.date) throw new Error('day-end 需要 --date YYYY-MM-DD');
        store.flush(); result = generateDay(store,v.date); break;
      case 'wake': result = {text:buildWake(store)}; break;
      case 'slide': result = runSlide(store,{apply:v.apply}); break;
      case 'review': result = store.reviewRetention(input()); break;
      case 'audit': result = store.audit(); store.flush(); break;
      case 'dict': result = api.memory_dict(); break;
      case 'rebuild': result = {ok:true,...rebuildDerived(store)}; break;
      case 'doctor': result = {moduleVersion:'0.6.0',schema:store.metadata().schema,dictVersion:'v6',node:process.version,platform:process.platform,sqlite:'available',instanceId:store.instanceId,dataDir:store.dataDir,timezone:store.timezone,encrypted:false,hostInstalledByThisCommand:false}; break;
    }
    if (['init','append','write','a3-write','a2-review','a2-cleanup','core','preference','b2-write','b2-cleanup','day-end','slide','review','audit','rebuild','doctor'].includes(command) || command === 'self-review' && v.action !== 'history') {
      result = Array.isArray(result)
        ? { [command === 'audit' ? 'findings' : 'reviews']: result, committed: true, ...store.projectionStatus() }
        : { ...result, ...store.projectionStatus() };
    }
    console.log(JSON.stringify(result,null,2));
  } catch (error) {
    console.error(JSON.stringify({error:error.message,...(error.code === 'QUOTE_MISMATCH' ? {code:error.code,details:error.details} : {})}));
    process.exitCode = 1;
  } finally { store?.close(); }
}

await main();
