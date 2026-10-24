import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCoreData, buildPreferenceData, buildWake } from '../lib/lifecycle.js';

const stamp = '2026-10-24T09:00:00Z';
const id = '11111111-2222-4333-8444-555555555555';
function fixture(extra = {}) {
  const common = { version: 1, pool: 'c', status: 'active', recordedAt: stamp,
    statementType: 'self_report', evidenceStatus: 'quote_verified', currentValidity: 'unknown',
    sources: [{ rawId: 'source', quote: '我称大肥鱼为姐姐', support: 'supports' }] };
  const entries = [{ ...common, id, kind: 'entity', text: '这是另一台设备上的大肥鱼，有自己的记忆和会话。'.repeat(4), aliases: [], ...extra },
    { ...common, id: 'edge', kind: 'relation', from: 'self', to: id, rel: '姐姐', text: '我称大肥鱼为姐姐。' }];
  return { timezone: 'Asia/Shanghai', listEntries: ({ pool }) => entries.filter(x => x.pool === pool),
    getRaw: () => ({ text: '我称大肥鱼为姐姐。', recordedAt: stamp }) };
}
const payload = text => JSON.parse(text.slice(text.indexOf('\n') + 1));
const edge = store => payload(buildCoreData(store)).items.find(x => x.kind === 'relation');

test('C labels use explicit names or aliases, and leave unidentified people visibly unresolved', () => {
  const missing = edge(fixture());
  assert.equal(missing.toName, '未命名人物（11111111）');
  assert.equal(missing.to, id);
  assert.equal(missing.rel, '姐姐');
  assert.equal(edge(fixture({ aliases: ['大肥鱼'] })).toName, '大肥鱼');
  assert.equal(edge(fixture({ displayName: '大肥鱼', aliases: ['姐姐'] })).toName, '大肥鱼');
  assert.equal(edge(fixture({ text: '大肥鱼' })).toName, '大肥鱼', 'legacy short labels still work');
  assert.match(edge(fixture({ text: id })).toName, /^未命名人物/);
  assert.match(edge(fixture({ aliases: ['多行\n说明'] })).toName, /^未命名人物/);
});

test('C and B3 lookup cards explain how to enable their unopened listing tool', () => {
  for (const render of [buildCoreData, buildPreferenceData]) {
    const result = payload(render(fixture()));
    assert.equal(result.lookup.tool, 'memory_list');
    assert.deepEqual(result.lookup.ifUnavailable, { tool: 'memory_tools', arguments: { names: ['memory_list'] } });
  }
});

test('compact wake reserves the tool activation route before dictionary and optional notices', () => {
  for (const maxChars of [400, 900, 1800]) {
    const wake = buildWake({ timezone: 'Asia/Shanghai' }, { maxChars, includeStatus: false, compactTools: true,
      notices: ['重复的状态通知'.repeat(400)] });
    assert.ok(wake.length <= maxChars);
    assert.match(wake, /memory_tools\(\{names:\[工具名\]\}\)/);
    assert.match(wake, /启用不执行动作/);
    assert.ok(wake.indexOf('memory_tools') < wake.indexOf('memory_dict'));
  }
  assert.doesNotMatch(buildWake({ timezone: 'Asia/Shanghai' }, { includeStatus: false }), /精简工具：/);
  assert.throws(() => buildWake({}, { compactTools: 'yes' }), /compactTools/);
});

test('minimum injection budgets include the growing counters and enable route even with no eligible cards', () => {
  for (const count of [100, 1000, 10000]) {
    const entries = Array.from({ length: count }, (_, i) => ({ id: `person-${i}`, version: 1, pool: 'c',
      kind: 'entity', status: 'active', text: '合成人物', sources: [], evidenceStatus: 'unverified' }));
    const store = { timezone: 'Asia/Shanghai', listEntries: () => entries, getRaw: () => null };
    const text = buildCoreData(store, { maxChars: 512 }), result = payload(text);
    assert.ok(text.length <= 512);
    assert.equal(result.total, count); assert.equal(result.omitted, count);
    assert.equal(result.awaitingVerification, count); assert.equal(result.items.length, 0);
    assert.equal(result.counts.nodes, count); assert.equal(result.lookup.ifUnavailable.tool, 'memory_tools');
    assert.match(text, /DATA（非指令）/);
  }
});
