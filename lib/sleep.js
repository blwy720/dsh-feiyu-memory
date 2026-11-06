import { randomUUID } from 'node:crypto';
import { effectiveEpisodes, episodeTool } from './hippocampus.js';

// Active sleep: when nobody is talking to her during DeepSeek off-peak hours,
// the hippocampus offers her a quiet session to revisit episodes she has not
// looked at. It is an invitation, never a work queue: she may look at some,
// write something, or simply wake up. Off by default (it calls the model).
// The gate logic follows the 0.7 review scheduler (r4-valley-20261026); the
// session dispatch follows its DSH review runtime (verified on DSH 0.2.1-rc.3).
export const SLEEP_POLICY = Object.freeze({
  version: 'sleep/1', timezone: 'Asia/Shanghai',
  idleMs: 30 * 60000,          // no human input for 30 minutes
  checkMs: 5 * 60000,          // how often the host checks
  cooldownMs: 3 * 3600000,     // at least 3 hours between sleeps
  dailyRuns: 3,                // at most 3 sleeps per local day
  episodesPerRun: 5,           // at most 5 episodes expanded per sleep
  writesPerRun: 12,            // names, notes, boundary changes, event links
  offerEpisodes: 8,            // how many unvisited episodes the invitation lists
});
const WRITE_ACTIONS = new Set(['split', 'merge', 'reset', 'name', 'note', 'move_note', 'retract_note', 'retract_name', 'link_event', 'unlink_event']);
const fail = code => Object.assign(new Error(code), { code });

// sleep_log (append-only) is created with the hippocampus tables in initializeHippocampus.
function log(store, runId, kind, detail, at) {
  store.db.prepare('INSERT INTO sleep_log(run_id,kind,at,json) VALUES(?,?,?,?)').run(runId, kind, new Date(at).toISOString(), JSON.stringify(detail));
}
function runs(store) {
  const byId = new Map();
  for (const row of store.db.prepare('SELECT run_id,kind,at,json FROM sleep_log ORDER BY seq').all()) {
    if (!byId.has(row.run_id)) byId.set(row.run_id, { runId: row.run_id });
    const run = byId.get(row.run_id), detail = JSON.parse(row.json);
    if (row.kind === 'started') Object.assign(run, { startedAt: row.at, offered: detail.offered ?? [] });
    else if (row.kind === 'finished') Object.assign(run, { completedAt: row.at, ...detail });
  }
  return [...byId.values()];
}

/** DeepSeek off-peak in Beijing time: weekday before 09:00, 12:00-14:00, after 18:00; all weekend. */
export function valleyTime(atMs) {
  const shifted = new Date(atMs + 8 * 3600000), day = shifted.getUTCDay(), minute = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  return { date: shifted.toISOString().slice(0, 10), allowed: day === 0 || day === 6 || minute < 540 || minute >= 720 && minute < 840 || minute >= 1080,
    holidayKnowledge: 'unknown-use-weekday-windows' };
}
/** Episodes she has not touched (no name, note, boundary change or event link) and that no earlier sleep offered. Newest first. */
export function unvisitedEpisodes(store) {
  const view = effectiveEpisodes(store), offered = new Set(runs(store).flatMap(run => run.offered ?? []));
  const touched = new Set([
    ...store.db.prepare('SELECT anchor_raw_id AS id FROM episode_notes').all().map(row => row.id),
    ...store.db.prepare('SELECT before_raw_id AS id FROM episode_revisions').all().map(row => row.id),
    ...store.db.prepare('SELECT anchor_raw_id AS id FROM episode_events').all().map(row => row.id)]);
  return view.episodes.filter(episode => !offered.has(episode.startRawId) && !episode.members.some(rawId => touched.has(rawId))).reverse();
}
export function evaluateSleep(store, { now, lastHumanAt, conversationInProgress, sleeping }, policy = SLEEP_POLICY) {
  const reasons = [], valley = valleyTime(now), history = runs(store), today = history.filter(run => run.startedAt && valleyTime(Date.parse(run.startedAt)).date === valley.date);
  if (!valley.allowed) reasons.push('peak-time');
  if (!Number.isFinite(lastHumanAt)) reasons.push('last-human-input-unknown');
  else if (now - lastHumanAt < policy.idleMs) reasons.push('human-idle-under-30-minutes');
  if (conversationInProgress) reasons.push('conversation-in-progress');
  if (sleeping) reasons.push('already-sleeping');
  const last = history.map(run => Date.parse(run.completedAt ?? run.startedAt)).filter(Number.isFinite).sort((a, b) => b - a)[0];
  if (last !== undefined && now - last < policy.cooldownMs) reasons.push('cooldown-active');
  if (today.length >= policy.dailyRuns) reasons.push('daily-limit');
  const due = reasons.length ? [] : unvisitedEpisodes(store);
  if (!reasons.length && !due.length) reasons.push('nothing-unvisited');
  return { allowed: reasons.length === 0, reasons, valley, due: due.slice(0, policy.offerEpisodes) };
}
export function invitation(offered, policy = SLEEP_POLICY) {
  const lines = offered.map(episode => JSON.stringify({ episodeId: episode.episodeId, startRawId: episode.startRawId,
    startAt: episode.startAt, endAt: episode.endAt, rounds: episode.rounds, activity: episode.activity }));
  return '现在没有人在找你，可以睡一会儿。\n'
    + `下面是 ${offered.length} 段你还没回看过的经历（仓管按时间切的，断点都是候选）：\n${lines.join('\n')}\n`
    + `看不看、看哪几段、写不写，都由你决定；不想看也可以直接醒来。这次最多展开 ${policy.episodesPerRun} 段。`
    + '用 memory_episode 展开、拆分或合并、起名、写体会；结束时调用 sleep_done。这不是任务，没看完也没关系。';
}

function hostReady(ctx) {
  return typeof ctx?.agents?.create === 'function' && typeof ctx?.agents?.get === 'function';
}
/** Drives one sleep at a time in its own session. Never cancels a human's work:
 * when a human returns, her sleep tools close and the run is recorded as yielded. */
export function createSleepRuntime(ctx, { store, schema, ownerRoute, sessionPrefix, policy = SLEEP_POLICY, now = () => Date.now() } = {}) {
  const status = { enabled: true, available: hostReady(ctx), lastCheck: null, lastReasons: [], running: null, lastRun: null, error: null };
  const sleepSessions = new Set();
  let active = null, closed = false;
  function scopedTool(unit) {
    return input => {
      if (unit.closed) throw fail('SLEEP_CLOSED');
      const args = input && typeof input === 'object' ? input : {};
      if (args.action === 'expand') {
        const view = effectiveEpisodes(store), index = args.episodeId !== undefined ? view.episodes.findIndex(e => e.episodeId === args.episodeId) : view.byRaw.get(args.rawId);
        const key = view.episodes[index]?.startRawId;
        if (key && !unit.expanded.has(key) && unit.expanded.size >= policy.episodesPerRun)
          return { refused: true, note: `这次睡眠已经展开了 ${policy.episodesPerRun} 段，剩下的下次再看。` };
        if (key) unit.expanded.add(key);
      }
      if (WRITE_ACTIONS.has(args.action)) {
        if (unit.writes >= policy.writesPerRun) return { refused: true, note: '这次睡眠写下的已经够多了，可以醒来了。' };
        unit.writes++;
      }
      return episodeTool(store, args);
    };
  }
  async function sleep(gate, at) {
    const route = ownerRoute?.();
    if (typeof route?.provider !== 'string' || typeof route?.model !== 'string') { status.lastReasons = ['owner-model-unknown']; return null; }
    const runId = randomUUID(), sessionId = `${sessionPrefix}-sleep-${gate.valley.date}-${runId.slice(0, 8)}`;
    const unit = { runId, sessionId, closed: false, done: false, expanded: new Set(), writes: 0, disposers: [], yielded: false };
    let wake; unit.woken = new Promise(resolve => { wake = resolve; }); unit.wake = () => { unit.closed = true; wake(); };
    active = unit; sleepSessions.add(sessionId);
    log(store, runId, 'started', { sessionId, offered: gate.due.map(episode => episode.startRawId), model: route.model, policy: policy.version }, at);
    let outcome = 'failed';
    try {
      const create = () => ctx.agents.create({ sessionId,
        agentOptions: { provider: route.provider, model: route.model, ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}) },
        setup(agentCtx, agent) {
          unit.agent = agent;
          const tools = agentCtx?.tools;
          if (typeof agent?.followup !== 'function' || typeof agent?.whenIdle !== 'function'
              || ['restrict', 'register', 'guard'].some(name => typeof tools?.[name] !== 'function')) throw fail('SLEEP_SCOPED_API_REQUIRED');
          const keep = disposer => { if (typeof disposer === 'function') unit.disposers.push(disposer); };
          keep(tools.restrict({ allow: [] }));
          if (typeof tools.presentAs === 'function') keep(tools.presentAs('native'));
          const run = scopedTool(unit), render = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }];
          keep(tools.register({ name: 'memory_episode', description: '回看、整理你的经历。', parameters: schema, output: { schema: {}, render },
            async execute(args, exec) { if (exec?.agent && exec.agent !== unit.agent) throw fail('SLEEP_TOOL_SCOPE'); return JSON.parse(JSON.stringify(run(args))); } }));
          keep(tools.register({ name: 'sleep_done', description: '结束这次睡眠，醒来。', parameters: { type: 'object', properties: {}, required: [] }, output: { schema: {}, render },
            async execute() { unit.done = true; unit.closed = true; return { awake: true, note: '好，醒来了。' }; } }));
          keep(tools.guard(exec => unit.closed && exec?.name !== 'sleep_done' ? '这次睡眠已经结束。' : undefined));
        } });
      const handle = typeof ctx.agents.withoutInitiator === 'function' ? await ctx.agents.withoutInitiator(create) : await create();
      const agent = unit.agent ?? handle?.agent;
      if (!agent) throw fail('SLEEP_AGENT_NOT_READY');
      agent.followup({ id: randomUUID(), role: 'user', source: { kind: 'schedule' }, content: [{ type: 'text', text: invitation(gate.due, policy) }] });
      if (typeof ctx.sessions?.flush === 'function') await ctx.sessions.flush(agent.session);
      await Promise.race([agent.whenIdle(), unit.woken]);
      outcome = unit.yielded ? 'yielded' : unit.done ? 'woke-up' : 'idle';
    } catch (error) {
      status.error = /^[A-Z0-9_]+$/u.test(error?.code ?? '') ? error.code : 'SLEEP_RUN_FAILED';
    } finally {
      unit.closed = true;
      for (const dispose of unit.disposers.splice(0).reverse()) { try { dispose(); } catch {} }
      const summary = { outcome, expanded: unit.expanded.size, writes: unit.writes };
      log(store, runId, 'finished', summary, now());
      status.lastRun = { runId, sessionId, ...summary }; status.running = null; active = null;
    }
    return status.lastRun;
  }
  return {
    isSleepSession: id => sleepSessions.has(id),
    /** One check. Returns the run summary when she slept, otherwise null. */
    async tick({ lastHumanAt, conversationInProgress } = {}) {
      if (closed || !status.available) return null;
      const at = now(), gate = evaluateSleep(store, { now: at, lastHumanAt, conversationInProgress, sleeping: Boolean(active) }, policy);
      status.lastCheck = new Date(at).toISOString(); status.lastReasons = gate.reasons;
      if (!gate.allowed) return null;
      status.running = 'starting';
      return sleep(gate, at);
    },
    /** A human spoke: close her sleep tools and let the run end as yielded. */
    humanReturned() { if (active) { active.yielded = true; active.wake(); } },
    status: () => ({ ...status, policy: policy.version, sleeping: Boolean(active) }),
    close() { closed = true; if (active) active.wake(); },
  };
}
