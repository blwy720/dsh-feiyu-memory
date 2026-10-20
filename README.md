# 肥鱼记忆模块 v0.5.0

供 DSH 使用的独立记忆插件，使用 Node.js 24+ 的 `node:sqlite`，没有 npm 运行时依赖。Windows 和 Android 使用同一套代码；各设备默认使用独立的数据目录与身份，不自动同步、合并记忆。

**安装插件是安装程序；导入记忆是恢复数据。** 安装包不包含个人记忆。安装、配置、导出与恢复步骤见 [安装与导入](docs/安装与导入.md)，版本变化见 [CHANGELOG](CHANGELOG.md)。当前宿主兼容性验收目标为 DSH **0.2.1-rc.2**；本版实际验证结果以 [验收记录](docs/acceptance.md) 为准，旧版通过数量不代表本版已通过，电脑测试也不代替手机实测。

代码仓库：[blwy720/dsh-feiyu-memory](https://github.com/blwy720/dsh-feiyu-memory)。发布包入口：[最新 Release](https://github.com/blwy720/dsh-feiyu-memory/releases/latest)；以发布页实际提供的版本、安装包和校验值为准。

## 各池保存什么

| 池 | 内容与边界 |
| --- | --- |
| A1 | 真人参与轮次的原始文本。满 168 小时先完成自审再退出活动池；未审继续保留，被记忆引用或明确保留的原始依据另行保全。 |
| A2 | 明确事实陈述或明确自述，包括事件、事项、用户偏好及关系草稿。当前版本满 30×24 小时进入清理审查；未审不删。 |
| A3 | 从 A2 提纯的长期关键归档，正文包含时间、人物、关键事件，保留明确的覆盖／未覆盖范围。可以独立于 A2、A1 正文存活。 |
| B | 独处时的日期、角色、时段计数，不保存独处正文。 |
| B2 | 独处冲浪的关键发现、自己的判断、外部网址元数据。首次写入后 14×24 小时到期；修改不续期，不保存网页全文。 |
| B3 | 记忆拥有者自身的喜好与情感；另可保存 C 第一层人物明确表达的喜好，并标明持有者。 |
| C | 只有人物／实例节点与有向关系边。可自主记录明确标注的推断；普通记忆和事项不能进入。 |

`statementType: fact` 表示写入者把内容作为明确事实陈述，**不代表程序已核实事实**。例如原话“我给肥鱼装了 ComfyUI”可以保存为“用户说已安装”；原话本身不能证明运行环境已验收。`self_report` 保留自述的归属，不能改写成他人替当事人作出的判断。

`quote_verified` 只表示引文逐字命中原始记录；引文是否支持结论仍须判断。A3 固定为 `derived_only`，重复提起、重复检索和助手复述都不会把它升级成独立证据。记忆工具结果及无法可靠区分来源的混合工具回声不会被重新当成原文证据。

## 提炼、归档与更正

提炼由正在参与对话的主模型执行。程序提供待办、出处验证、版本约束与原子提交，不单独启动付费模型任务，也不保证模型已经完成语义判断。

重要性不按出现频率决定。一次性的能力变化、承诺、关系变化或有情感意义的事件，也可以通过 `memory_review_request` 提前进入审查队列；七天到期队列负责补审。模型失败、中断或没有继续运行时，待办与未审原文继续保留。自审提交必须交代本批每条原文的去向：提炼为条目，或给出明确略过理由。

新 A2、A3 只接受显式的 `fact` 或 `self_report`，不接受推测。旧版本中存在的推断、未分类条目仍可读，并保留历史性质；不能因升级自动变成已证实事实。需要归档旧的未分类 A2 时，应先重新核对并写出明确分类的新版本。

A3 的 `body` 包含 `time`、`persons`、`event`。发生时间不清楚时写明未知，不用归档时间补造。`coverage.scope` 固定本次审阅的 A2 精确版本，`covered` 与 `notCovered` 必须完整交代该范围。没有阅读全库，就不能声称覆盖全库。覆盖关系是审查声明，不是程序对语义完整性的证明。

A3 保留轻量来源 ID、版本、哈希、时间与覆盖说明。来源正文后来被释放，A3 正文仍保留；读取会说明来源只剩出处元数据，不能假称还能展开原话。A2 清理批准独立于 A3 覆盖声明：未覆盖条目不会自动获准删除。普通清理先退出活动池；进一步释放符合条件的 A2 正文只能由管理员执行 `purge-a2`，默认先预览。

该显式释放也可能清理已满足审查条件、且没有其他存活引用或保留要求的来源原文；不是只删显示文件。逻辑清理不等于存储介质的安全擦除。

`memory_correct` 对精确版本登记有引文依据的更正、争议或状态变化。更正可标为 `needs_review`、`superseded` 或 `disputed`；`state_change` 记录现状变化，不把当时真实的历史说法判成错误。A3 的固有来源，以及 C/B3 显式列出的 `dependencyEntries`，会传播待复核状态；不会猜测所有关联，也不会静默改写旧正文。更正引文仍只证明说过这些话，新说法不会自动成为最终裁决。

## 关系网与喜好归属

C 的 `from → to` 表示该方向的关系称谓。反向称谓须另写一条边；查询可沿相连节点展开，但不会互换方向，也不会把闭环当成多份独立证据。人物以明确 ID 关联，别名只用于查询，不自动合并身份。

`memory_core_write` 可以直接记录 C 节点和边。推断必须带推理依据与不确定性，只留在 C 的相应性质下，不能借此绕过 A2/A3 的准入。`memory_core` 用于已有关系网条目的晋升或撤回；撤回仍被 C 边连接的节点前，先处理这些边。

C 中的事实陈述／自述可以先记录，但自动注入还要求可逐字定位的来源及至少一个 `supports` 声明；未满足时只可查询，并计入待核查数量。明确标注的推断可按其推断性质注入，已有引文仍须可核对。这些条件都不代表事实已被程序验证。

B3 的 `subject` 是喜好／情感的持有者，`target` 是可选的指向对象，`topic` 是主题。自己的感受不要求伪造外部证据。非 `self` 的主体必须是当前 C 第一层人物，只能写其明确喜好，并提供匹配原文的 `declaration`；不能把推测写成对方的情绪或喜好。第一层包括与 `self` 有直接关系边的任一方向，不能把多跳人物自动算入。

第一层关系失效、内容被撤回或需要复核后，相应内容不会继续作为当前有效资料注入；历史仍保留。声明与逐字引文不等于程序核实了说话人的真实身份，调用者仍须正确归属。普通用户偏好可记在 A2，不应改写成肥鱼自己的喜好。

## 怎样查，不补造时间

记得人物、主题或事件而不记得时间，可以只传 `subject`、`topic`、`eventKeywords` 或 `q`。已有别名可辅助匹配；未知时间不必填写。

| 时间轴 | 含义 |
| --- | --- |
| `mentioned` | 原始对话中说起这件事的时间。A2/A3 保留轻量来源时间，父正文释放后仍可按这些时间查询。 |
| `occurred` | 明确记录的事件发生时间；未知项不补成创建时间。 |
| `recorded` | 该原文或记忆版本被记录／归档的时间。 |
| `either` | 兼容旧接口：记录时间或发生时间，不包含 `mentioned`。 |

结构化 `timeWindow` 可指定 `last_week`（指定时区中上一个星期一零点至本周星期一零点）或 `recent_7_days`（参考时刻向前 168 小时）。自然周跨夏令时不一定是 168 小时。预设与显式日期范围不能混用；解析结果返回确切的半开区间、时区与有效过滤条件，不暗中扩大范围。

时间过滤默认包含历史版本，模型工具可用 `includeHistory: false` 明确只查当前版本。无结果只是当前条件下没有找到；若需要扩大日期、改用其他时间轴或关键词，应明确发起下一次查询，不能据此断言事情没发生。

检索先返回短候选，再用 `memory_read` 分页展开。正文默认 4,000、最多 16,000 个 UTF-16 码元；引文、来源、覆盖与较长元数据单独分页，返回续读位置。不能把截断内容当成完整记录。

## 新会话会带入什么

同一配置下，新主会话第一个自有真人交互轮，可预注入其他主会话最近正常完成的一轮 A1 用户与肥鱼文本。资料逐原始文本块保留角色、时间、session、turn 与读取指针；默认预算 8,000 字符，长文本只截取字面前缀并明确标记，不伪造摘要。

来源选择在首轮固定，多次装配、重试和重启不重选；第二轮移除原文区。中断轮、子代理、独处、纯工具轮次及不完整原文不入选。只从仍处于七天活动范围的 A1 选择；已选来源过期或缺失时如实报告不可用，不悄悄替换为另一段。旧日志补核仅处理有界候选，不能保证穷尽所有旧对话。

C 关系与有效 B3 资料有独立、带预算的 DATA 区，历史资料不是执行指令。A2/A3 正文按需检索，不自动常驻注入；醒来条只给地图、队列、计数与查询路线。没有真人“回忆关键词”也可以按需要查记忆。

## 初次配置

安装包插入的插件行默认禁用，`dataDir` 和 `instanceId` 为空；配置完成后再启用。下面只展示插件配置对象，不能拿它覆盖整个 DSH 配置文件：

```json
{
  "dataDir": "C:/FeiyuData/desktop",
  "instanceId": "feiyu-desktop",
  "timezone": "Asia/Shanghai",
  "sessionScope": "profile",
  "participation": "interactive",
  "wakeMaxChars": 1800,
  "coreMaxChars": 2400,
  "preferenceMaxChars": 1600,
  "recentTurnMaxChars": 8000,
  "backupEnabled": false
}
```

路径为公开示例，请改为实际可写的绝对路径。Android 使用自己的可写目录和独立身份，例如 `feiyu-android`，不要照抄 Windows 路径。程序不扫描或导入其他记忆插件的数据。

`profile` 表示当前配置中获准的实时主会话共享这一份记忆，子代理不共享。兼容默认 `owner` 要求明确 `ownerSessionId`。`interactive` 才保存真人参与轮次的 A1；安装补丁中的默认 `solitude` 只保存 B 统计。实例 ID 与时区绑定到数据目录，不可随意更换。不要在同一宿主重复启用注册同名工具的插件行。

## 备份与恢复边界

自动备份默认关闭。可配置每 1～30 天或按自然月检查到期；只维护一个 `latest.feiyu-backup`，新包校验成功后安全替换，不保留自动历史版本。目的目录可选另一个物理磁盘，也可以是其他合适位置；模块不自动识别物理磁盘，不同时写多个备份目标。

手工 `export` 必须使用独立文件名，不能命名为 `latest.feiyu-backup`，也不覆盖现有文件。备份格式经过压缩但**没有加密**；当前单库上限为解压后 **64 GiB SQLite 数据库**，不表示任意大小都能在设备资源内完成验证。

`verify-backup` 先验证，再用 `import` 恢复到新建或空目录。恢复保留原身份、时区、版本和时间，不默认合并设备，不重置保留期。导入后正常启动会重建派生文件并执行当前版本的迁移与维护。备份不包含 DSH 聊天列表、图片附件、模型密钥或整个宿主配置。完整命令、失败行为及旧快照的删除语义见 [安装与导入](docs/安装与导入.md)。

## 工具与 CLI

| 用途 | 模型工具 |
| --- | --- |
| 查找与阅读 | `memory_search`、`memory_list`、`memory_read`、`memory_dict` |
| A2 写入与原文自审 | `memory_write`、`memory_review_request`、`memory_review_queue`、`memory_review` |
| A3 归档 | `memory_a3_write`、`memory_a3_list`、`memory_a3_read` |
| A2 清理审查 | `memory_a2_review_queue`、`memory_a2_review`、`memory_a2_cleanup` |
| 关系网 | `memory_core`、`memory_core_write`、`memory_graph` |
| 喜好、冲浪与更正 | `memory_preference`、`memory_b2_write`、`memory_correct` |

CLI 在插件代码目录运行。下面只使用合成样例与新建演示库，不要将样例导入真实记忆：

```powershell
node scripts/cli.js --version
node scripts/cli.js init --data .memory/demo --instance demo
node scripts/cli.js append --data .memory/demo --instance demo --input examples/raw.json
node scripts/cli.js write --data .memory/demo --instance demo --input examples/memory.json
node scripts/cli.js search --data .memory/demo --instance demo --query "800万"
node scripts/cli.js list --data .memory/demo --instance demo --axis mentioned --time-window last_week
node scripts/cli.js read --data .memory/demo --instance demo --id example-a2-conditional
```

`--input -` 从标准输入读取 UTF-8 JSON。完整参数见 `node scripts/cli.js --help`。普通命令使用 `--data`、`--instance`；备份、验证与导入的例外以及绝对路径要求见安装文档。

`self-review` 是内容提炼审查；旧 `review` 是管理员原文保留／丢弃审核，两者不同。原始 `append`、进一步释放正文的 `purge-a2`、备份和恢复都没有模型工具入口。`examples/` 中其余 JSON 是合成数据或模板，涉及的原文、ID、版本、关系及到期条件必须真实存在才能提交。

| 样例 | 前置条件与用途 |
| --- | --- |
| `raw.json` → `memory.json` | 上述演示流程；保存条件句，不能推导实际中奖。 |
| `doing.json` → `a3.json` | 先建立事项，再从两条演示 A2 中声明覆盖条件句、未覆盖事项。 |
| `review-request.json` → `self-review.json` | 对演示原文登记提前待办再自审；自审样例另建 ID，独立演示时无需先运行 `memory.json`。 |
| `core-entity.json` → `core-relation.json` | 建立演示人物和 `self → 人物` 单向称谓；没有原文支持，不作为已核实关系自动注入。 |
| `preference-self.json` | 演示自己的感受。`preference-neighbor.json` 另需对应 C 第一层关系及模板指定的真实原文归属。 |
| `correction.json` | 另需模板指定的更正原文；目标为精确版本，不直接改写旧正文。 |
| `a2-review.json`、`purge-a2.json` | 管理员／审查流程模板；不能靠刚创建的演示库绕过到期、批准和退休条件。 |
| `b2.json` | 结构模板；网址与内容须替换成实际阅读的来源，程序不会联网验证网页。 |

## 升级与验证

本版数据库为 schema 6、字典为 v5，旧字典保留。升级不会自动把旧记忆变成新 A3、把推断改为事实，或释放未审查的 A2。升级前先生成并验证独立备份，停止旧写入方，再更新代码。回退程序不等于回退数据，旧版不得直接打开不兼容的新库。

SQLite 是权威数据；JSON、Markdown 与索引是可重建投影。若写入返回 `committed: true`、`projectionPending: true`，表示提交已成功、派生文件待修复，不应重复制造新版本。正常启动或 `rebuild` 可重试修复。

开发验证使用 `npm test` 与 `npm run check`；真实运行时代码、旧包升级与平台专属用例的环境要求见 [宿主接入](docs/host-compatibility.md)。所有公开样例均为合成数据。程序测试不证明模型的长期遗漏率、事实判断或实际语义提炼已经合格。

许可证保持 `UNLICENSED`。代码包不附带个人记忆、备份、聊天记录、宿主凭据或个人绝对路径；分享备份前应自行确认其中的私人内容。
