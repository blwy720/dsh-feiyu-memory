# 只读查看接口 v1

此接口只注册在 DSH 的已认证 `connection.fetch`，不注册公共 HTTP 服务。独立查看插件不创建 `MemoryStore`，也不调用会写 recall 日志的模型工具。查看功能是可选组件，挂接失败不会停止记忆采集。

统一前缀为 `/api/feiyu-memory/viewer/v1`。全部请求使用 POST、`Content-Type: application/json`，参数在 JSON 请求体中。成功返回 `{ok:true,data}`；失败返回 `{ok:false,error:{code,message}}`，错误不回显正文、路径或请求参数。

| 路径 | 请求 | data |
| --- | --- | --- |
| `/open` | `{}` | `schema:"feiyu-library/1"`、`library`、`snapshot`、`snapshotId`、`expiresAt`、`entities`、`counts`、`capabilities` |
| `/entries` | `{snapshotId,filter,cursor}` | `{items,total,nextCursor}`，当前条目的元数据 |
| `/entries` | `{snapshotId,mode:"timeline",filter,cursor}` | `{items:[{e,h,when,ms}],total,nextCursor}`；e 为当前元数据，h 为保留版本元数据，按版本时间升序 |
| `/relations` | `{snapshotId,filter,cursor}` | `{items,total,nextCursor}`；来源、社交关系、明确替代更正、后续版本 |
| `/entry` | `{snapshotId,id,version?}` | `{entry,detail,version,versionState,resolution}`，resolution 为 current/exact/not-found/not-recorded |
| `/raw` | `{snapshotId,id}` | 证据对象，包含归属及来源状态；现存正文有 `originalText`、`originalTextState`、`originalTextChars`、`originalTextLimit`、`originalTextRedacted` |
| `/bind` | `{snapshotId,sessionId}` | `{libraryId,binding,evidence:{matchedRawCount,conflictingCount,reason,scope}}` |
| `/close` | `{snapshotId}` | `{closed:true}`，可重复关闭 |

`filter` 支持 `q`（空串表示不筛选）、`pools`、`status`、`from`、`to`、`sort:"updated-desc"`、`limit:1..200`。条目支持 `ids`（最多 70 个）；关系支持 `type`、`entryId`、`entryIds`（最多 36 个）、`entityId`。也接受同义请求键 `filters`。分页游标绑定当前快照、接口、模式和完整筛选，不能跨快照或改变筛选后沿用。

条目列表不返回正文或来源全文。`/entry` 只返回所选条目/精确版本的正文、引用及证据元数据。`/raw` 只允许读取快照中保留条目版本的 sources、declaration 或更正事件直接引用的来源，不能枚举整库 A1。原文先完整脱敏再截取最多 8000 个 Unicode 字符；`full` 表示完整的脱敏文本，`truncated` 表示截断，不代表原文本身被清理。来源不在库里且没有明确清理凭据时为 `unknown`，不补造原文。

`entry` 元数据与 `detail` 保留精确版本的 `subject/target/topic/stance/expressionKind`（string|null），绝不根据正文或 topic 推测持有者。`subjectState/targetState/declarationState` 分别保留 present/null/absent/invalid；规范值为 null 不会抹去字段原本缺失与显式 null 的区别。`declaration` 是 object|null，包含 `subject/rawId/attribution/semanticStatus/quoteState:"detail-only"`；原话单独置于 `detail.evidence` 的 `evidenceType:"declaration"` 项，附 subject/attribution/semanticStatus。普通来源项为 `evidenceType:"source"`，保留 support，尤其 `context_only` 不可呈现为事实证明。声明与上下文可指向同一原文，两个角色不会被合成两条独立证据。

`originCounts:{available,cleared,unknown,total}` 按 sources 与 declaration 的唯一 rawId 统计。total>0 且全部可读才是 `originState:"available"`，全部有明确清理凭据才是 cleared；无引用或混合状态为 unknown。条目清理的 `bodyState:"cleared"` 不代表原文已清理。实体显示名优先 displayName/name/短 aliases，缺失回退稳定 ID，不用描述正文充当名称。

open 的 `counts` 包括每池当前条目数 `pools`、`entries`、`versions`、`relations` 和 `entities`。实体名称列表最多 500 个，超出时 `entitiesTruncated:true`，计数仍为实际总数。条目/版本/关系列表没有前 1000 条的假上限，按 SQL 分页。B2 只提供快照时点未到期的当前版本。

每个快照持有独立只读 SQLite 事务，绝对有效期 15 分钟，同一核心实例同时最多 3 个快照。请求到期返回 `VIEWER_SNAPSHOT_EXPIRED`（410），页面应明确提示重新打开，不暗中把新库内容混进旧快照。关闭和到期会回滚只读事务、关闭该连接，不关闭核心写连接。WAL 下正常追加写入仍可进行；活跃读快照可能延后旧 WAL 页回收，所以查看完应调用 close。路由最多同时处理 8 个请求，请求体上限 32 KiB。

`bind` 仅证明该 session 的原文记录归属于当前记忆实例；匹配记录必须至少一条且所有 instanceId 一致。它不证明某条记忆来自该轮、不证明模型采用或回答引用。回放数据仍须来自真实会话日志。历史条目的复核状态是当前快照中的已记录状态，不能冒充历史当时的状态；页面不得把明确更正和当前有效性混同。

元数据复用核心的只读复核/更正计算，并应用审计降级、退休及清理墓碑：`retired`、`pruned`、`auditDowngraded`、`contextAuditDowngraded`、`dependencyReviewPending`、`mergeState`、`policyWarnings` 应展示给用户。已清理最新版本仍作为墓碑出现，绝不把较旧正文冒充当前版本；详情 `bodyState:"cleared"` 且 `body:null`。合并撤销产生的 archived 状态也用于 SQL 筛选。

A3 的旧原文沿袭完整性未在此门面重算，因此明确返回 `lineageState:"not-recomputed"`；其原始复核事件值保留在 `recordedCurrentValidity`，不能确认当前可用时 `currentValidity` 为 unknown。审计降级、已退休、依赖待复核或已更正条目同样不将历史 valid 声明直接展示成当前有效。`invalid` 仍保留。此限制不等于驳斥条目。

此包不包含用户记忆、私有快照、会话文件或凭证。
