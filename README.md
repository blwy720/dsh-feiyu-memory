# 肥鱼记忆模块 v0.6.1

[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/License-PolyForm%20Noncommercial%201.0.0-blue)](https://polyformproject.org/licenses/noncommercial/1.0.0)

供 DSH 使用的独立记忆插件，使用 Node.js 24+ 的 `node:sqlite`，没有 npm 运行时依赖。Windows 和 Android 使用同一套代码；各设备默认使用独立的数据目录与身份，不自动同步、合并记忆。

**安装插件是安装程序；导入记忆是恢复数据。** 安装包不包含个人记忆。安装、配置、导出与恢复步骤见 [安装与导入](docs/安装与导入.md)，版本变化见 [CHANGELOG](CHANGELOG.md)。支持 DSH **0.2.1-rc.2 / 0.2.1-rc.3**；Windows 与 Android 使用同一安装包，实际验证的平台、宿主版本和范围见 [验收记录](docs/acceptance.md)。

代码仓库：[blwy720/dsh-feiyu-memory](https://github.com/blwy720/dsh-feiyu-memory)。发布包入口：[最新 Release](https://github.com/blwy720/dsh-feiyu-memory/releases/latest)；以发布页实际提供的版本、安装包和校验值为准。

v0.6.0 增加 D 经验池、每轮相关记忆召回、批量阅读与提炼、事项线、轻量复核和可选精简工具模式。常用操作和 JSON 示例见[工具与经验池](docs/工具与经验池.md)。它帮助肥鱼找到并整理已有资料；相关性分数、逐字引文和“已验证”声明都不等于程序已经证明现实中的事实。

v0.6.1 修复人物名称显示、低预算批读和 B3 引用定位，补齐 A1 原文事项关联及工具启用提示，并减少泛词引发的无关召回。从 v0.6.0 升级继续使用 schema 7 和字典 v6，旧记忆无需重新导入。

## 在界面中管理备份

安装、配置并启用插件后，打开 **DSH 设置 → 肥鱼记忆备份**。Windows 与 Android 使用同一个设置页；插件详情页的开关是整个插件的开关。

- **自动备份**：选择本设备可写的文件夹，设置每隔 1～30 天或每个自然月，打开开关后点“保存设置”。也可以关闭；只保留一份最新备份。
- **立即备份**：先保存目标文件夹，再手动执行。关闭自动备份时也能使用。
- **导出独立副本**：另存一个 `.feiyu-backup` 文件，用于迁移或单独保留。手机建议优先“保存到文件夹”。
- **从备份恢复**：选择文件，先验证，再确认身份、时间与目标空目录。恢复完成不会自动切换当前记忆，使用恢复结果的方法见 [安装与导入](docs/安装与导入.md#用界面备份导出与导入)。

设置页保存后立即生效，重启仍保留；自动计划只在 DSH 运行时检查。备份包含肥鱼记忆，不包含 DSH 聊天列表、附件或模型设置。文件未加密，请只交给可信任的人。

## 各池保存什么

时间戳在数据库和备份中统一保存为 UTC。给模型的注入、查询结果及日索引按记忆库时区显示带偏移的本地时间，默认 `Asia/Shanghai`（北京时间）：例如 `2026-10-21T08:00:00.123Z` 显示为 `2026-10-21T16:00:00.123+08:00`，两个值表示同一时刻，无须再次加八小时。历史原文、引用和 A3 正文中的时间说法保持原样；原始文件里的 `Z` 仍表示 UTC。日期归档、上个自然周、滚动保留期的规则不变。

| 池 | 内容与边界 |
| --- | --- |
| A1 | 真人参与轮次的原始文本。满 168 小时先完成自审再退出活动池；未审继续保留，被记忆引用或明确保留的原始依据另行保全。 |
| A2 | 明确事实陈述或明确自述，包括事件、事项、用户偏好及关系草稿。当前版本满 30×24 小时进入清理审查；未审不删。 |
| A3 | 从 A2 提纯的长期关键归档，正文包含时间、人物、关键事件，保留明确的覆盖／未覆盖范围。可以独立于 A2、A1 正文存活。 |
| B | 独处时的日期、角色、时段计数，不保存独处正文。 |
| B2 | 独处冲浪的关键发现、自己的判断、外部网址元数据。首次写入后 14×24 小时到期；修改不续期，不保存网页全文。 |
| B3 | 记忆拥有者自身的喜好与情感；另可保存 C 第一层人物明确表达的喜好，并标明持有者。 |
| C | 只有人物／实例节点与有向关系边。可自主记录明确标注的推断；普通记忆和事项不能进入。 |
| D | 学会的方法、经验与适用条件。区分学到、尝试过、声明验证成功，保留资料来源、验证记录与环境；设备或版本变化后可复核。 |

`statementType: fact` 表示写入者把内容作为明确事实陈述，**不代表程序已核实事实**。例如原话“我给肥鱼装了 ComfyUI”可以保存为“用户说已安装”；原话本身不能证明运行环境已验收。`self_report` 保留自述的归属，不能改写成他人替当事人作出的判断。

`quote_verified` 只表示引文逐字命中原始记录；引文是否支持结论仍须判断。A3 固定为 `derived_only`，重复提起、重复检索和助手复述都不会把它升级成独立证据。记忆工具结果及无法可靠区分来源的混合工具回声不会被重新当成原文证据。

对助手复用已读取记忆的情况，程序保留显式来源链，并检测至少 20 个字符的逐句原样复用，标记已识别片段的派生来源。该规则不能识别所有改写、近义转述或遗漏的来源，不能据此保证所有复述都已被拦住。

## 提炼、归档与更正

提炼由正在参与对话的主模型执行。程序提供待办、出处验证、版本约束与原子提交，不单独启动付费模型任务，也不保证模型已经完成语义判断。

重要性不按出现频率决定。一次性的能力变化、承诺、关系变化或有情感意义的事件，也可以通过 `memory_review_request` 提前进入审查队列；七天到期队列负责补审。模型失败、中断或没有继续运行时，待办与未审原文继续保留。自审提交必须交代本批每条原文的去向：提炼为条目，或给出明确略过理由。

新 A2、A3 只接受显式的 `fact` 或 `self_report`，不接受推测。旧版本中存在的推断、未分类条目仍可读，并保留历史性质；不能因升级自动变成已证实事实。需要归档旧的未分类 A2 时，应先重新核对并写出明确分类的新版本。

A3 的 `body` 包含 `time`、`persons`、`event`。发生时间不清楚时写明未知，不用归档时间补造。`coverage.scope` 固定本次审阅的 A2 精确版本，`covered` 与 `notCovered` 必须完整交代该范围。没有阅读全库，就不能声称覆盖全库。覆盖关系是审查声明，不是程序对语义完整性的证明。

A3 保留轻量来源 ID、版本、哈希、时间与覆盖说明。来源正文后来被释放，A3 正文仍保留；读取会说明来源只剩出处元数据，不能假称还能展开原话。A2 清理批准独立于 A3 覆盖声明：未覆盖条目不会自动获准删除。普通清理先退出活动池；进一步释放符合条件的 A2 正文只能由管理员执行 `purge-a2`，默认先预览。

该显式释放也可能清理已满足审查条件、且没有其他存活引用或保留要求的来源原文；不是只删显示文件。逻辑清理不等于存储介质的安全擦除。

`memory_correct` 对精确版本登记有引文依据的更正、争议或状态变化。更正可标为 `needs_review`、`superseded` 或 `disputed`；`state_change` 记录现状变化，不把当时真实的历史说法判成错误。A3 的固有来源，以及 C/B3 显式列出的 `dependencyEntries`，会传播待复核状态；不会猜测所有关联，也不会静默改写旧正文。更正引文仍只证明说过这些话，新说法不会自动成为最终裁决。

可以用 `memory_manage` 把精确条目版本或 A1 原文 ID 关联到同一 `threadId` 事项线，或追加复核事件而不重写正文。原文事项关联只是可撤销的导航，不充当证据，不延长 A1 保留期；来源清理后明确显示不可用。`currentValidity: valid` 是上次复核的声明；同时检查 `reviewDue` 和 `dependencyReviewPending`，不能把已到期或依据变化的内容继续当作当前确定结论。合并目前只支持同类型的 A2 `memory` 或 `doing`，保留来源、版本和可撤销事件；不自动合并人物身份、关系或喜好持有者。

## 关系网与喜好归属

C 的 `from → to` 表示该方向的关系称谓。反向称谓须另写一条边；查询可沿相连节点展开，但不会互换方向，也不会把闭环当成多份独立证据。人物以明确 ID 关联，别名只用于查询，不自动合并身份。

人物节点可写 `displayName`（最多 48 字符、单行）。注入优先使用明确名称，其次短别名和旧版短文本；缺名称时显示“未命名人物（短 ID）”，完整 ID 仍保留用于准确定位，不从长描述猜名字。

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

检索先返回短候选，再用 `memory_fetch` 批量展开，或用 `memory_read` 的 `body`／`evidence`／`history` 视图分别阅读。旧 `memory_read` 默认完整视图兼容，正文默认 4,000、最多 16,000 个 UTF-16 码元；长正文与来源可分页，不能把截断内容当成完整记录。`memory_search` 可加 `fuzzy:true` 补充有限的错字候选；模糊匹配不会放宽逐字引用验证或自动合并同名人物。

## 新会话会带入什么

同一配置下，新主会话第一个自有真人交互轮，可预注入其他主会话最近正常完成的一轮 A1 用户与肥鱼文本。资料逐原始文本块保留角色、时间、session、turn 与读取指针；默认预算 8,000 字符，长文本只截取字面前缀并明确标记，不伪造摘要。

来源选择在首轮固定，多次装配、重试和重启不重选；第二轮移除原文区。中断轮、子代理、独处、纯工具轮次及不完整原文不入选。只从仍处于七天活动范围的 A1 选择；已选来源过期或缺失时如实报告不可用，不悄悄替换为另一段。旧日志补核仅处理有界候选，不能保证穷尽所有旧对话。

C、B3 和每轮相关召回各有独立、带预算的 DATA 区。C/B3 使用紧凑卡片，优先保留少量自身连续性信息及当前话题相关项，出处和决策详情按需展开。C 的总条数包括人物节点与关系边，分别返回 `counts.nodes`、`counts.relations`，不能把“9 条”理解成“9 个人”。`shown` 是已显示条目；其余数量分别说明待核查、超出主体范围、未选入当前话题或预算不足，不伪装成整库已读。

`autoRecall` 默认开启：收到真人消息后，按当前话题和有限上下文查找相关候选，默认最多 5 条、2400 字符。A1、A2、A3、B2、B3、C、D 中符合条件的内容可以按相关性出现；不会每轮塞入整个池。首轮“最近完成一轮 A1 原文”与此召回区分开，仍只预注入一次。没有“我记得”等关键词也可召回；招呼或缺乏实质线索时可以没有结果。候选带来源性质和读取指针，历史资料不是新的执行指令。

默认检索使用本地关键词、别名与有限错字匹配，不调用额外模型、不产生检索 API 费用。需要更深入查阅时，肥鱼仍可主动查询或打开事项线；自动召回不保证每次都找全，未命中不能证明没有发生。

### 可选语义辅助

高级用户可设置 `semanticEndpoint`、`semanticModel` 和可选 `semanticApiKeyEnv`（环境变量名，不是密钥本身），使用兼容 embeddings 接口的服务。默认留空关闭。启用后会发送脱敏、截断后的当前查询与精炼候选文本给指定服务，可能产生其 API 费用；本机服务也会占用本机资源。A1 原文候选保留本地检索，不用于该向量请求。

当前语义范围是最多 64 条当前精炼条目，加上本地词法候选，合计最多 80 条，不是整库向量索引；脱敏模式也不能保证识别所有私人内容。单次默认等待 1500ms，可通过 `semanticTimeoutMs` 调整为 100～5000ms；超时、凭据缺失或服务失败时回退本地结果。远程地址须 HTTPS，本机回环地址可 HTTP。相似度不是事实验证。

## 初次配置

安装包插入的插件行默认禁用，`dataDir` 和 `instanceId` 为空；配置完成后再启用。下面只展示插件配置对象，不能拿它覆盖整个 DSH 配置文件：

```json
{
  "dataDir": "C:/FeiyuData/desktop",
  "instanceId": "feiyu-desktop",
  "timezone": "Asia/Shanghai",
  "sessionScope": "profile",
  "participation": "interactive",
  "toolMode": "compact",
  "autoRecall": true,
  "recallLimit": 5,
  "recallMaxChars": 2400,
  "wakeMaxChars": 1800,
  "coreMaxChars": 2400,
  "preferenceMaxChars": 1600,
  "recentTurnMaxChars": 8000,
  "backupEnabled": false
}
```

路径为公开示例，请改为实际可写的绝对路径。Android 使用自己的可写目录和独立身份，例如 `feiyu-android`，不要照抄 Windows 路径。程序不扫描或导入其他记忆插件的数据。

`profile` 表示当前配置中获准的实时主会话共享这一份记忆，子代理不共享。兼容默认 `owner` 要求明确 `ownerSessionId`。`interactive` 才保存真人参与轮次的 A1；安装补丁中的默认 `solitude` 只保存 B 统计。实例 ID 与时区绑定到数据目录，不可随意更换。不要在同一宿主重复启用注册同名工具的插件行。

新配置模板使用 `toolMode: compact`；旧配置未写该字段时保持 `compatible`。设置 `autoRecall:false` 可关闭每轮相关召回，不关闭首轮最近一轮原文、C/B3 或主动记忆工具。

## 新采集内容与历史隐私

新 A1 文本在进入本模块存储前，对已知密钥、令牌、私钥和凭据模式做脱敏。相关召回卡片也过滤已识别模式；这不等于全部历史读取接口都已清洗。规则可能漏检或误判，不是任意秘密识别器；逐字引用应以插件实际保存的脱敏文本为准。

升级不会回写既有 A1、旧导出或旧备份，也不清理 DSH 自己保存的聊天历史。可运行 `privacy-audit --data <目录>` 只读统计当前 SQLite 已知权威文本中的敏感模式，报告只含数量，不打印秘密正文；旧备份、派生文件和宿主聊天记录需要另外处理。备份恢复校验不等于隐私检查，分享时仍只分享程序包。

## 备份与恢复边界

自动备份默认关闭。可配置每 1～30 天或按自然月检查到期；只维护一个 `latest.feiyu-backup`，新包校验成功后安全替换，不保留自动历史版本。目的目录可选另一个物理磁盘，也可以是其他合适位置；模块不自动识别物理磁盘，不同时写多个备份目标。

手工 `export` 必须使用独立文件名，不能命名为 `latest.feiyu-backup`，也不覆盖现有文件。备份格式经过压缩但**没有加密**；当前单库上限为解压后 **64 GiB SQLite 数据库**，不表示任意大小都能在设备资源内完成验证。

`verify-backup` 先验证，再用 `import` 恢复到新建或空目录。恢复保留原身份、时区、版本和时间，不默认合并设备，不重置保留期。导入后正常启动会重建派生文件并执行当前版本的迁移与维护。备份不包含 DSH 聊天列表、图片附件、模型密钥或整个宿主配置。完整命令、失败行为及旧快照的删除语义见 [安装与导入](docs/安装与导入.md)。

## 工具与 CLI

精简模式开始只显示 `memory_search`、`memory_fetch`、`memory_prepare`、`memory_manage`、`memory_review` 和发现入口 `memory_tools`。调用 `memory_tools({"names":["memory_preference"]})` 按需开启；开启只注册工具，不执行写入，本次插件运行内有效。兼容模式启动时保留全部 23 个业务工具。完整用法见[工具与经验池](docs/工具与经验池.md)。

| 用途 | 模型工具 |
| --- | --- |
| 查找与阅读 | `memory_search`、`memory_list`、`memory_read`、`memory_dict` |
| 简洁批读、写前定位 | `memory_fetch`、`memory_prepare` |
| D、事项线、复核、合并、进度日报 | `memory_manage` |
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
node scripts/cli.js read --data .memory/demo --instance demo --id example-a2-conditional --view body
node scripts/cli.js privacy-audit --data .memory/demo --instance demo
```

`--input -` 从标准输入读取 UTF-8 JSON。完整参数见 `node scripts/cli.js --help`。普通命令使用 `--data`、`--instance`；备份、验证与导入的例外以及绝对路径要求见安装文档。

`fetch`、`prepare`、`manage` 接受对应工具的 JSON 参数，例如把 `{"action":"progress"}` 保存为 UTF-8 的 `progress.json`，运行 `node scripts/cli.js manage --data .memory/demo --instance demo --input progress.json`。`fetch` 续读游标只存在于当前插件运行实例，不能跨独立 CLI 进程复用；CLI 阅读长正文请固定 ID／版本，用 `read --offset ... --limit ...` 继续。

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

本版数据库为 schema 7、字典为 v6，旧字典及旧条目性质保留。升级不会自动把旧记忆变成新 A3、把推断改为事实，或释放未审查的 A2。升级前保留旧代码、宿主插件配置和已验证的数据快照，停止旧写入方，再更新代码；不要把私人配置放入公开包。若回退，必须把升级前兼容快照恢复到新目录并搭配原代码／配置使用，旧代码不得直接打开已经升级到 schema 7 的库。

SQLite 是权威数据；JSON、Markdown 与索引是可重建投影。若写入返回 `committed: true`、`projectionPending: true`，表示提交已成功、派生文件待修复，不应重复制造新版本。正常启动或 `rebuild` 可重试修复。

开发验证使用 `npm test` 与 `npm run check`；真实运行时代码、旧包升级与平台专属用例的环境要求见 [宿主接入](docs/host-compatibility.md)。所有公开样例均为合成数据。程序测试不证明模型的长期遗漏率、事实判断或实际语义提炼已经合格。

许可证为 [PolyForm Noncommercial 1.0.0](LICENSE)，具体使用与分发条件以许可证全文为准。代码包不附带个人记忆、备份、聊天记录、宿主凭据或个人绝对路径；分享备份前应自行确认其中的私人内容。
