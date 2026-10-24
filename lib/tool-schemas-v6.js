const string = (description, values) => ({ type: 'string', description, ...(values ? { enum: values } : {}) });
const integer = description => ({ type: 'integer', description });
const object = (properties, required = []) => ({ type: 'object', properties, required });
const array = (items, description) => ({ type: 'array', items, ...(description ? { description } : {}) });
const strings = description => array(string('字符串'), description);
const reference = object({ id: string('条目ID'), version: integer('精确版本') }, ['id', 'version']);
const source = object({ rawId: string('原文ID'), quote: string('逐字引文'), support: string('支持性质；不自动证明事实', ['unassessed', 'supports', 'contradicts', 'context_only']) }, ['rawId', 'quote']);

/** Extend the old schema without removing any old tool or changing its default.
 * The host's small schema dialect accepts only explicit objects and primitives. */
export function extendToolSchemasV6(legacy) {
  const schemas = structuredClone(legacy);
  for (const name of ['memory_search', 'memory_list', 'memory_read']) {
    const pool = schemas[name].properties.pool;
    if (pool?.enum && !pool.enum.includes('d')) pool.enum.push('d');
    if (pool) pool.description += '；D保存有适用条件和验证状态的学习经验';
  }
  schemas.memory_read.properties.kind.enum.push('knowledge');
  for (const name of ['memory_search', 'memory_list']) schemas[name].properties.type.description += '；D类型为knowledge';
  Object.assign(schemas.memory_core_write.properties, {
    displayName: string('实体可选短显示名，最多48个字符且单行；省略保留已有名称，不替代稳定实体ID'),
    aliases: strings('该实体自己的名称或别名；重名称谓仍需精确ID消歧'), hooks: strings('简短检索钩子'),
    entities: strings('明确相关主体'), tags: strings('辅助检索标签'),
  });
  schemas.memory_write.properties.displayName = structuredClone(schemas.memory_core_write.properties.displayName);
  schemas.memory_review.properties.entries.items.properties.displayName = structuredClone(schemas.memory_core_write.properties.displayName);
  schemas.memory_search.properties.fuzzy = { type: 'boolean', description: '可选英文名称轻微错字容错，默认false；近似命中只是候选，不证明身份或事实' };
  schemas.memory_read.properties.view = string('默认保持旧版完整输出；body简洁正文，evidence展开出处，history看版本及状态', ['body', 'evidence', 'history', 'full']);
  schemas.memory_read.properties.fields = strings('可选字段，例如text、role、recordedAt；始终保留ID/版本。详细核验使用view:evidence');
  schemas.memory_review_queue.properties.cursor = string('从上一页nextCursor继续；避免审核后旧offset跳过条目');
  schemas.memory_a2_review_queue.properties.cursor = string('从上一页nextCursor继续；审核完成导致队列缩短时不会跳项');
  schemas.memory_review.properties.action.description = 'submit原子提交一单元；history查历史；batch逐项提交独立单元并单独重试失败项';
  schemas.memory_review.properties.action.enum.push('batch');
  const reviewProperties = schemas.memory_review.properties;
  schemas.memory_review.properties.items = array(object({
    key: string('本批中稳定唯一的项标识，最多80字符；重试不变'),
    rawIds: reviewProperties.rawIds,
    entries: reviewProperties.entries,
    omissions: reviewProperties.omissions,
    reason: reviewProperties.reason,
  }, ['key', 'rawIds', 'reason']), 'batch必填，1..20个独立审查单元；共享原文或相互依赖的产物必须放同一单元');
  schemas.memory_fetch = object({
    ids: array(object({ id: string('原文或条目ID'), kind: string('可选明确类型，原文raw、D为knowledge'), version: integer('可选精确版本；首次读取固定版本后续不漂移') }, ['id']), '批量1..50项；默认简洁正文'),
    sessionId: string('按轮读取时与turnId一起提供'), turnId: string('同一会话内的轮标识'), anchorId: string('或用一条原文定位其session和turn'),
    budget: integer('整个JSON响应预算，800..48000字符，默认8000；必要元数据仍放不下时按minimumBudget用原cursor重试'), cursor: string('续读只传该值和可选budget；插件重启或一小时后失效'),
    fields: strings('可选字段；默认正文、角色、时间及必要状态，ID/版本固定保留'),
  });
  schemas.memory_prepare = object({
    text: string('准备记下的关键内容，最多4000字符；只预览，不写入'), rawIds: strings('已读原文ID，最多20个；精确匹配时自动填入引文'),
    pool: string('检索旧记忆的目标池，可省略', ['a2', 'b3', 'c', 'd']), entity: string('需要消歧的人名或称谓'), limit: integer('相关旧记忆数量1..10，默认5'),
  });
  schemas.memory_manage = object({
    action: string('经验/状态/事项线维护或只读进度；只传对应参数块', ['knowledge', 'revalidate', 'link_thread', 'unlink_thread', 'read_thread', 'merge', 'revoke_merge', 'progress', 'report']),
    requestId: string('写操作必填唯一幂等ID；重试保持相同ID与输入'), reason: string('写操作必填理由'),
    knowledge: object({
      id: string('已有经验ID，省略则创建'), expectedVersion: integer('创建0，更新需当前版本'), purpose: string('解决什么问题'), conditions: strings('适用条件'),
      method: string('关键方法、步骤或结论'), validationStatus: string('读过/尝试过/已验证，不能把读教程当作成功', ['learned', 'tried', 'verified']),
      validation: object({ method: string('怎样验证'), result: string('实际结果'), checkedAt: string('验证时间，带时区ISO'), sources: array(source, '验证结果的原文依据') }, ['method', 'result', 'sources']),
      sources: array(source, 'A1精确原文依据'), externalSources: array(object({ url: string('不含凭据的HTTP(S)链接'), title: string('资料名称'), accessedAt: string('访问时间，带时区ISO') }, ['url']), '外部引用不等于已验证'),
      environment: object({ name: string('设备/系统/软件环境'), version: string('已知版本'), notes: string('其他适用限制') }, ['name']),
      tags: strings('检索标签'), hooks: strings('常用提问或别名'), entities: strings('相关主体'), project: string('所属项目'), dependencyEntries: array(reference, '引用已有记忆时保留精确版本，不能增加独立证据'),
    }, ['purpose', 'conditions', 'method', 'validationStatus']),
    check: object({
      targets: array(reference), currentValidity: string('当前有效性；到复核期变待复查，不自动判错', ['unknown', 'valid', 'invalid']),
      check: object({ method: string('验证方式，如本人明确确认或工具实测'), result: string('实际验证结论'), actor: string('由谁确认') }, ['method', 'result']),
      sources: array(source), checkedAt: string('确认时间，带时区ISO，不能未来'), reviewAfter: string('下次复核时间，带时区ISO，不是保留期'),
    }, ['targets', 'currentValidity']),
    thread: object({
      threadId: string('持续事项ID，与聊天sessionId不同'), title: string('事项短名称；新事项必填'),
      entries: array(reference, '关联精确版本；可与rawIds混用，总共1..50项'), rawIds: strings('A1原文ID，可跨会话；只是导航弱引用，不改变原文或延长保留期'),
      linkRequestId: string('unlink_thread必填：精确撤销哪次挂接；可用entries/rawIds选子集，省略二者解除该次全部关联'),
      include: string('read_thread返回条目、原文或二者，默认both；续页保持一致', ['entries', 'raw', 'both']),
      limit: integer('读取项数1..100，默认20'), budget: integer('完整JSON预算800..48000字符，默认8000；太小时按错误提示增大'), cursor: string('固定事项事件快照的续页游标；原文清理后返回状态，不伪造正文'),
    }, ['threadId']),
    merge: object({ targets: array(reference, '仅同kind的当前A2 memory/doing，不合并人物身份'), entry: schemas.memory_write, mergeRequestId: string('撤销时指定之前合并的requestId') }),
    date: string('日报本地日期YYYY-MM-DD，默认今天；仅统计实际成功提交'),
    limit: integer('report每页事务数量，默认20'), cursor: string('report从上一页nextCursor继续，保持同一date'),
  }, ['action']);
  return schemas;
}

export const descriptionsV6 = {
  memory_fetch: '常用简洁阅读：多个ID一起读，或按session/turn读整轮。保留角色、时间与定位，受总预算限制，可用cursor续读，不把截断当完整。',
  memory_prepare: '写前检查：根据关键内容定位原文、找相关旧记忆，并区分同名人物。返回候选不判定矛盾、不自动写入。',
  memory_manage: '维护D经验、轻量复核、跨会话事项线及可撤销A2合并；或查progress/report。到期复核不等于删除，不因引文命中认定事实。',
};
