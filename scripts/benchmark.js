import { MemoryStore } from '../lib/store.js';
import { createTools } from '../lib/tools.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const root = mkdtempSync(join(tmpdir(),'feiyu-benchmark-'));
let store;
try {
  store = new MemoryStore({dataDir:root,instanceId:'benchmark'});
  const api = createTools(store);
  const latencies = [];
  for (let i=0;i<500;i++) {
    const t=performance.now();
    store.appendRaw({id:`bench-${i}`,sessionId:'synthetic',role:i%2?'assistant':'user',pool:'a',text:`合成测试记录 ${i}：讨论记忆模块、项目进度与检索。${i%10===0?'冬天旅行 彩票中奖是假设。':''}`});
    latencies.push(performance.now()-t);
  }
  const t=performance.now();
  const result = api.memory_search({q:'冬天旅行',limit:4});
  const searchMs=performance.now()-t;
  const flushStart=performance.now();
  store.flush();
  const flushMs=performance.now()-flushStart;
  latencies.sort((a,b)=>a-b);
  console.log(JSON.stringify({node:process.version,platform:process.platform,syntheticRecords:500,appendMs:{p50:latencies[250],p95:latencies[475],max:latencies[499]},searchMs,candidates:result.candidates.length,flushMs,note:'本机合成测量，不承诺所有设备的 <10ms 热路径'},null,2));
} finally {
  store?.close();
  // Only the directory returned by mkdtemp is removed, never a configured user path.
  rmSync(root,{recursive:true,force:true});
}
