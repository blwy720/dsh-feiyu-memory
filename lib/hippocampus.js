import { loadRounds, proposeEpisodes, EPISODE_CHUNKER_POLICY } from './hippocampus-chunker.js';
import { presentMemoryTimes } from './time-display.js';
import { createHash, randomUUID } from 'node:crypto';

// Hippocampus (仓管): encodes conversation into episodes, indexes them for
// recall and keeps the fish's own decisions. Original records are never
// changed. Program boundaries are recomputed from raw on demand; only her
// decisions are stored, append-only:
//   episode_revisions  her split / merge / reset at a round boundary
//   episode_notes      the names and reflections she writes (her private layer)
//   episode_events     the episodes she links into an event
// The read-only viewer interface does not read these tables.
export const HIPPOCAMPUS_VERSION = 'hippocampus/1';
export const HIPPOCAMPUS_LIMITS = Object.freeze({ nameChars: 60, noteChars: 2000, eventIdChars: 80, titleChars: 60,
  expandRounds: 30, expandChars: 16000, partChars: 1500, toolChars: 400, recentLimit: 20,
  cardEpisodes: 3, cardChars: 1200, cardNoteChars: 300, overviewPage: 30, overviewMax: 60, openingChars: 40 });
const NATURES = new Set(['experience', 'recollection', 'mixed']);
const ACTIONS = ['recent', 'overview', 'locate', 'expand', 'split', 'merge', 'reset', 'name', 'note', 'move_note', 'retract_note', 'retract_name', 'link_event', 'unlink_event', 'events'];
const fail = message => { throw new TypeError(message); };
const id = (value, name) => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f]/u.test(value) ? value : fail(`${name} 无效`);
const text = (value, name, max) => typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : fail(`${name} 需要 1..${max} 个字符`);

export function initializeHippocampus(store) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS episode_revisions (seq INTEGER PRIMARY KEY AUTOINCREMENT,request_id TEXT NOT NULL UNIQUE,before_raw_id TEXT NOT NULL,action TEXT NOT NULL CHECK(action IN ('split','merge','reset')),at TEXT NOT NULL,json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS episode_revisions_raw ON episode_revisions(before_raw_id,seq);
    CREATE TABLE IF NOT EXISTS episode_notes (seq INTEGER PRIMARY KEY AUTOINCREMENT,request_id TEXT NOT NULL UNIQUE,anchor_raw_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('name','reflection')),at TEXT NOT NULL,json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS episode_notes_anchor ON episode_notes(anchor_raw_id,seq);
    CREATE TABLE IF NOT EXISTS episode_events (seq INTEGER PRIMARY KEY AUTOINCREMENT,request_id TEXT NOT NULL UNIQUE,event_id TEXT NOT NULL,anchor_raw_id TEXT NOT NULL,action TEXT NOT NULL CHECK(action IN ('link','unlink')),at TEXT NOT NULL,json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS episode_events_event ON episode_events(event_id,seq);
    CREATE INDEX IF NOT EXISTS episode_events_anchor ON episode_events(anchor_raw_id,seq);
    CREATE TABLE IF NOT EXISTS sleep_log (seq INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL,kind TEXT NOT NULL,at TEXT NOT NULL,json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS sleep_log_run ON sleep_log(run_id,seq);
    CREATE TABLE IF NOT EXISTS episode_note_retractions (seq INTEGER PRIMARY KEY AUTOINCREMENT,request_id TEXT NOT NULL UNIQUE,note_seq INTEGER NOT NULL UNIQUE,at TEXT NOT NULL,json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS episode_reads (seq INTEGER PRIMARY KEY AUTOINCREMENT,anchor_raw_id TEXT NOT NULL,at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS episode_reads_anchor ON episode_reads(anchor_raw_id,seq);
  `);
  for (const table of ['episode_revisions', 'episode_notes', 'episode_events', 'sleep_log', 'episode_note_retractions', 'episode_reads']) for (const op of ['UPDATE', 'DELETE'])
    store.db.exec(`CREATE TRIGGER IF NOT EXISTS immutable_${table}_${op.toLowerCase()} BEFORE ${op} ON ${table} BEGIN SELECT RAISE(ABORT,'hippocampus history is append-only'); END;`);
}

// ---- effective episodes: program boundaries + her revisions --------------------------------
const caches = new WeakMap();
function signature(db) {
  const one = sql => Object.values(db.prepare(sql).get()).join(':');
  return [one('SELECT count(*),coalesce(max(rowid),0) FROM raw'), one('SELECT count(*),coalesce(max(rowid),0) FROM originals'),
    one('SELECT coalesce(max(seq),0) FROM episode_revisions')].join('|');
}
function latestRevisions(db) {
  const split = new Set(), merge = new Set();
  for (const row of db.prepare('SELECT before_raw_id,action FROM episode_revisions r WHERE seq=(SELECT max(seq) FROM episode_revisions WHERE before_raw_id=r.before_raw_id)').all()) {
    if (row.action === 'split') split.add(row.before_raw_id); else if (row.action === 'merge') merge.add(row.before_raw_id);
  }
  return { split, merge };
}
export function effectiveEpisodes(store) {
  const sig = signature(store.db), cached = caches.get(store);
  if (cached?.sig === sig) return cached.value;
  const rounds = loadRounds(store.db), result = proposeEpisodes(rounds, EPISODE_CHUNKER_POLICY, { ...latestRevisions(store.db), members: true });
  const byRaw = new Map(), roundStart = new Map(), roundOf = new Map();
  result.episodes.forEach((episode, index) => { for (const rawId of episode.members) byRaw.set(rawId, index); });
  for (const round of rounds) for (const part of round.parts) { roundStart.set(part.rawId, round.parts[0].rawId); roundOf.set(part.rawId, round); }
  const boundaryByRaw = new Map(result.boundaries.map(boundary => [boundary.beforeRawId, boundary]));
  const value = { ...result, rounds, byRaw, roundStart, roundOf, boundaryByRaw };
  caches.set(store, { sig, value });
  return value;
}

// The first human line of an episode, cut at the last punctuation within 40 characters.
function openingOf(view, episode) {
  for (const rawId of episode.members) {
    const part = view.roundOf.get(rawId)?.parts.find(p => p.rawId === rawId);
    if (part?.role !== 'user' || typeof part.text !== 'string' || !part.text.trim()) continue;
    const line = part.text.replace(/\s+/gu, ' ').trim(), max = HIPPOCAMPUS_LIMITS.openingChars;
    if (line.length <= max) return line;
    const head = line.slice(0, max), stop = Math.max(...[...'，。！？；,.!?;、…～~'].map(mark => head.lastIndexOf(mark)));
    return stop >= 8 ? head.slice(0, stop + 1) : head + '…';
  }
  return null;
}
// ---- her layer -------------------------------------------------------------------------------
// A moved note is a new row with movedFrom; the row it replaces is then superseded (kept, not shown).
// A retracted note stays in its row; an appended retraction (with her reason) takes it out of view and
// out of the counts. It can be pulled back into view with locate includeRetracted, marked as retracted.
function retractions(store) {
  return new Map(store.db.prepare('SELECT note_seq,at,json FROM episode_note_retractions ORDER BY seq').all()
    .map(row => [row.note_seq, { retractedAt: row.at, reason: JSON.parse(row.json).reason }]));
}
function allNotes(store, { retracted = false } = {}) {
  const rows = store.db.prepare('SELECT seq,anchor_raw_id,kind,at,json FROM episode_notes ORDER BY seq').all()
    .map(row => ({ ...row, value: JSON.parse(row.json) }));
  const superseded = new Set(rows.map(row => row.value.movedFrom).filter(Number.isSafeInteger)), withdrawn = retractions(store);
  return rows.filter(row => !superseded.has(row.seq) && withdrawn.has(row.seq) === retracted)
    .map(row => retracted ? { ...row, ...withdrawn.get(row.seq) } : row);
}
function notesFor(store, members, notes = allNotes(store), withdrawn = allNotes(store, { retracted: true })) {
  const set = new Set(members), names = [], reflections = [];
  for (const row of notes) {
    if (!set.has(row.anchor_raw_id)) continue;
    (row.kind === 'name' ? names : reflections).push({ seq: row.seq, writtenAt: row.at, anchorRawId: row.anchor_raw_id, ...row.value });
  }
  const retracted = withdrawn.filter(row => set.has(row.anchor_raw_id)).map(row => ({ seq: row.seq, kind: row.kind, anchorRawId: row.anchor_raw_id,
    writtenAt: row.at, retractedAt: row.retractedAt, reason: row.reason, text: row.value.text, ...(row.value.nature ? { nature: row.value.nature } : {}) }));
  return { name: names.at(-1)?.text ?? null, nameSeq: names.at(-1)?.seq ?? null, reflections, retracted };
}
// After a boundary change: which of the affected episodes now carry which notes, so an empty half is visible.
function notesNow(store, view, indexes) {
  return [...new Set(indexes.filter(index => Number.isSafeInteger(index) && index >= 0 && index < view.episodes.length))].sort((a, b) => a - b).map(index => {
    const episode = view.episodes[index], own = notesFor(store, episode.members);
    return { episodeId: episode.episodeId, startRawId: episode.startRawId, rounds: episode.rounds, name: own.name,
      reflections: own.reflections.map(note => ({ seq: note.seq, anchorRawId: note.anchorRawId, preview: note.text.slice(0, 40) })),
      ...(own.retracted.length ? { retractedNotes: own.retracted.length } : {}) };
  });
}
function eventsFor(store, members) {
  const set = new Set(members), state = new Map();
  for (const row of store.db.prepare('SELECT event_id,anchor_raw_id,action,json FROM episode_events ORDER BY seq').all()) {
    if (!set.has(row.anchor_raw_id)) continue;
    const key = `${row.event_id}\0${row.anchor_raw_id}`;
    if (row.action === 'link') state.set(key, { eventId: row.event_id, title: JSON.parse(row.json).title ?? null }); else state.delete(key);
  }
  return [...new Map([...state.values()].map(item => [item.eventId, item])).values()];
}
function summary(store, view, index, { notes = true, includeRetracted = false } = {}) {
  const episode = view.episodes[index], start = view.boundaryByRaw.get(episode.startRawId);
  const own = notes ? notesFor(store, episode.members) : null;
  return { episodeId: episode.episodeId, startRawId: episode.startRawId, endRawId: episode.endRawId, startAt: episode.startAt, endAt: episode.endAt,
    rounds: episode.rounds, activity: episode.activity, chapters: episode.chapterStarts.length, status: episode.status,
    startedBecause: start ? start.signals.map(signal => signal.kind) : ['beginning-of-memory'],
    prev: episode.prev, next: episode.next,
    ...(own ? { name: own.name, ...(own.nameSeq ? { nameSeq: own.nameSeq } : {}), reflections: own.reflections.map(({ seq, writtenAt, text, nature, anchorRawId }) => ({ seq, writtenAt, nature, anchorRawId, text })),
      // A bare trace so the view never pretends nothing was withdrawn; the text only on request.
      ...(own.retracted.length ? { retractedNotes: own.retracted.length } : {}),
      ...(includeRetracted ? { retracted: own.retracted } : {}),
      events: eventsFor(store, episode.members) } : {}),
    boundariesAreCandidates: true };
}
function findIndex(view, { episodeId, rawId }) {
  if (episodeId !== undefined) {
    const index = view.episodes.findIndex(episode => episode.episodeId === id(episodeId, 'episodeId'));
    return index >= 0 ? index : fail('找不到这段经历；经历编号可能因拆分或合并而改变，可用 rawId 定位');
  }
  const index = view.byRaw.get(id(rawId, 'rawId'));
  return index !== undefined ? index : fail('这条原文不在任何经历里（可能没有会话或回合信息）');
}
function anchorOf(view, args) {
  if (args.rawId !== undefined) { const rawId = id(args.rawId, 'rawId'); if (!view.byRaw.has(rawId)) fail('这条原文不在任何经历里'); return rawId; }
  return view.episodes[findIndex(view, args)].startRawId;
}
// requestId is optional: given, a retry is safe; omitted, one is generated.
const requestIdOf = args => args.requestId === undefined ? `auto-${randomUUID()}` : id(args.requestId, 'requestId');
function append(store, table, requestId, columns, values, payload) {
  const prior = store.db.prepare(`SELECT json FROM ${table} WHERE request_id=?`).get(requestId);
  const json = JSON.stringify(payload);
  if (prior) { if (prior.json !== json) fail('这个 requestId 已经用在另一次写入上了（比如挂接时用过的，撤销时不能再用）。换一个，或者直接省略 requestId。'); return { committed: false, duplicate: true }; }
  store._transaction(() => store.db.prepare(`INSERT INTO ${table}(request_id,${columns.join(',')},at,json) VALUES(?,${columns.map(() => '?').join(',')},?,?)`)
    .run(requestId, ...values, store.now(), json));
  return { committed: true, duplicate: false };
}
function expand(store, view, args) {
  const episode = view.episodes[findIndex(view, args)], keys = new Set(episode.members.map(rawId => view.roundStart.get(rawId)));
  // A read trace (her own wish: to see which episodes she has already thought about).
  store._transaction(() => store.db.prepare('INSERT INTO episode_reads(anchor_raw_id,at) VALUES(?,?)').run(episode.startRawId, store.now()));
  const rounds = view.rounds.filter(round => keys.has(round.parts[0].rawId))
    .sort((a, b) => Date.parse(a.parts[0].recordedAt) - Date.parse(b.parts[0].recordedAt));
  const offset = args.offset ?? 0, limit = args.limit ?? 10, includeTools = args.includeTools === true;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > HIPPOCAMPUS_LIMITS.expandRounds) fail(`offset ≥ 0，limit 1..${HIPPOCAMPUS_LIMITS.expandRounds}`);
  const items = [], stop = Math.min(rounds.length, offset + limit); let chars = 0, next = stop < rounds.length ? stop : null;
  for (let i = offset; i < stop; i++) {
    const round = rounds[i], tools = {}; let toolChars = 0;
    const parts = [];
    for (const part of round.parts) {
      const record = store.getRaw(part.rawId) ?? part;
      if (part.role === 'tool') {
        for (const tag of part.tags ?? []) if (tag.startsWith('dsh:tool:')) tools[tag.slice(9)] = (tools[tag.slice(9)] ?? 0) + 1;
        toolChars += (record.text ?? '').length;
        if (includeTools) parts.push({ rawId: part.rawId, role: 'tool', recordedAt: part.recordedAt, text: (record.text ?? '').slice(0, HIPPOCAMPUS_LIMITS.toolChars),
          truncated: (record.text ?? '').length > HIPPOCAMPUS_LIMITS.toolChars });
        continue;
      }
      const body = record.text ?? '';
      parts.push({ rawId: part.rawId, role: part.role, recordedAt: part.recordedAt, text: body.slice(0, HIPPOCAMPUS_LIMITS.partChars), truncated: body.length > HIPPOCAMPUS_LIMITS.partChars });
    }
    const item = { sessionId: round.sessionId, turnId: round.turnId, parts, ...(Object.keys(tools).length ? { tools: { used: tools, outputChars: toolChars, shown: includeTools } } : {}) };
    const size = JSON.stringify(item).length;
    if (items.length && chars + size > HIPPOCAMPUS_LIMITS.expandChars) { next = i; break; }
    items.push(item); chars += size;
  }
  return { episode: summary(store, view, findIndex(view, args)), rounds: items, totalRounds: rounds.length, offset, nextOffset: next,
    note: '原话原样展示，不改写；工具输出默认只显示用了什么，includeTools:true 才展示截断的输出。' };
}

/** The fish's own tool. Every write is append-only and idempotent by requestId. */
export function episodeTool(store, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !ACTIONS.includes(input.action)) fail(`action 必须是 ${ACTIONS.join(' / ')}`);
  const view = effectiveEpisodes(store), args = input;
  switch (args.action) {
    case 'recent': {
      const limit = args.limit ?? 10;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > HIPPOCAMPUS_LIMITS.recentLimit) fail(`limit 1..${HIPPOCAMPUS_LIMITS.recentLimit}`);
      const indexes = view.episodes.map((_, index) => index).slice(-limit).reverse();
      return { items: indexes.map(index => summary(store, view, index)), total: view.episodes.length, policy: view.policy,
        note: '经历由仓管按时间和会话切分，都是候选；你可以 split / merge / reset 断点，name / note 写下自己的理解。' };
    }
    case 'locate': return summary(store, view, findIndex(view, args), { includeRetracted: args.includeRetracted === true });
    case 'expand': return expand(store, view, args);
    case 'split': case 'merge': case 'reset': {
      const requestId = requestIdOf(args), before = view.roundStart.get(id(args.rawId, 'rawId'));
      if (!before) fail('这条原文不在任何回合里');
      const payload = { action: args.action, beforeRawId: before, ...(args.reason ? { reason: text(args.reason, 'reason', 500) } : {}) };
      // A replay is answered before validation: after it applied, the state check would differ.
      const prior = store.db.prepare('SELECT json FROM episode_revisions WHERE request_id=?').get(requestId);
      if (!prior) {
        const isCut = view.episodes.some(episode => episode.startRawId === before);
        if (args.action === 'split' && isCut) fail('这里已经是一段经历的开头');
        if (args.action === 'merge' && (!isCut || view.episodes[0].startRawId === before)) fail('merge 需要指向某段经历（不是第一段）的开头，它会和前一段合并');
      }
      const carry = args.action === 'split' && args.moveNoteSeqs !== undefined ? args.moveNoteSeqs : [];
      if (!Array.isArray(carry) || carry.length > 20 || carry.some(seq => !Number.isSafeInteger(seq))) fail('moveNoteSeqs 是要跟到后一半去的笔记 seq 列表');
      const visible = allNotes(store), episodeNow = view.episodes[view.byRaw.get(before)];
      for (const seq of carry) if (!visible.some(row => row.seq === seq && episodeNow.members.includes(row.anchor_raw_id))) fail(`笔记 ${seq} 不在这段经历里，或已被挪走、收回`);
      const result = append(store, 'episode_revisions', requestId, ['before_raw_id', 'action'], [before, args.action], payload);
      // Carried notes move to the first original of the new half (an appended movedFrom row, as move_note).
      for (const seq of result.committed ? carry : []) {
        const row = allNotes(store).find(item => item.seq === seq); if (!row || row.anchor_raw_id === before) continue;
        const { movedFrom: _earlier, ...value } = row.value;
        append(store, 'episode_notes', `${requestId}:carry:${seq}`, ['anchor_raw_id', 'kind'], [before, row.kind], { ...value, movedFrom: seq });
      }
      const after = effectiveEpisodes(store), here = after.byRaw.get(before);
      const halves = notesNow(store, after, args.action === 'merge' ? [here] : [here - 1, here]);
      // Silent misattribution is the costly case: name it out loud.
      let attention;
      if (args.action === 'split' && halves.length === 2) {
        const [front, back] = halves, frontHas = front.name || front.reflections.length, backHas = back.name || back.reflections.length;
        if (frontHas && !backHas) attention = `名字${front.name ? `「${front.name}」` : ''}和 ${front.reflections.length} 条体会现在只在前一半（${front.rounds} 轮），后一半（${back.rounds} 轮）是空的。如果它们指的是后一半：名字和体会都可以用 move_note 挪过去（名字用 nameSeq），或者给后一半重新起名；下次拆分时也可以直接带上 moveNoteSeqs。`;
      }
      return { ...result, ...payload, ...(carry.length ? { carried: carry } : {}), episode: summary(store, after, here, { notes: false }),
        notesNow: halves, ...(attention ? { attention } : {}),
        note: '笔记跟着它挂的那条原话走，不会自动跟着新的分段。' };
    }
    case 'retract_name': {
      // The name has its own way back: retract whichever name is current (the earlier one, or none, shows again).
      const anchor = anchorOf(view, args), current = notesFor(store, view.episodes[view.byRaw.get(anchor)].members);
      if (!current.nameSeq) fail('这段现在没有名字');
      return { ...episodeTool(store, { action: 'retract_note', requestId: args.requestId, noteSeq: current.nameSeq, reason: args.reason }), retractedName: current.name };
    }
    case 'retract_note': {
      // Withdraw one of her own names or reflections. Nothing is deleted: a retraction row with her
      // reason is appended; the note leaves every view and count, and stays readable via locate includeRetracted.
      const requestId = requestIdOf(args), seq = args.noteSeq;
      if (!Number.isSafeInteger(seq) || seq < 1) fail('noteSeq 需要是笔记的 seq（locate / overview 里能看到）');
      const reason = text(args.reason, '收回的理由', 500);
      const prior = store.db.prepare('SELECT note_seq,json FROM episode_note_retractions WHERE request_id=?').get(requestId);
      if (prior) {
        if (prior.note_seq !== seq || JSON.parse(prior.json).reason !== reason) fail('requestId 已用于不同内容');
        return { committed: false, duplicate: true, noteSeq: seq };
      }
      if (allNotes(store, { retracted: true }).some(row => row.seq === seq)) fail('这条已经收回过了');
      const current = allNotes(store).find(row => row.seq === seq);
      if (!current) fail('找不到这条笔记；被挪走的笔记请用挪过去后的新 seq');
      store._transaction(() => store.db.prepare('INSERT INTO episode_note_retractions(request_id,note_seq,at,json) VALUES(?,?,?,?)')
        .run(requestId, seq, store.now(), JSON.stringify({ reason, kind: current.kind })));
      const index = view.byRaw.get(current.anchor_raw_id);
      return { committed: true, noteSeq: seq, kind: current.kind, reason, kept: '原文一字未动，只是不再显示，也不再计数；locate 加 includeRetracted:true 可以看到',
        ...(index !== undefined ? { episode: summary(store, view, index) } : {}) };
    }
    case 'move_note': {
      const requestId = requestIdOf(args), seq = args.noteSeq, target = id(args.rawId, 'rawId');
      if (!Number.isSafeInteger(seq) || seq < 1) fail('noteSeq 需要是笔记的 seq（locate / overview 里能看到）');
      if (!view.byRaw.has(target)) fail('目标原文不在任何经历里');
      const prior = store.db.prepare('SELECT anchor_raw_id,json FROM episode_notes WHERE request_id=?').get(requestId);
      if (prior) {
        if (JSON.parse(prior.json).movedFrom !== seq || prior.anchor_raw_id !== target) fail('requestId 已用于不同内容');
        return { committed: false, duplicate: true, movedFrom: seq, anchorRawId: target };
      }
      const current = allNotes(store).find(row => row.seq === seq);
      if (!current) fail('找不到这条笔记，或它已经被挪走（请用挪过去后的新 seq）');
      if (current.anchor_raw_id === target) fail('笔记已经挂在这条原文上');
      const { movedFrom: _earlier, ...value } = current.value;
      const result = append(store, 'episode_notes', requestId, ['anchor_raw_id', 'kind'], [target, current.kind], { ...value, movedFrom: seq });
      const fresh = effectiveEpisodes(store);
      return { ...result, movedFrom: seq, anchorRawId: target, kept: '原记录保留在历史里，只是不再显示',
        notesNow: notesNow(store, fresh, [fresh.byRaw.get(target), fresh.byRaw.get(current.anchor_raw_id)]) };
    }
    case 'overview': {
      const offset = args.offset ?? 0, limit = args.limit ?? HIPPOCAMPUS_LIMITS.overviewPage, order = args.order ?? 'newest';
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > HIPPOCAMPUS_LIMITS.overviewMax) fail(`offset ≥ 0，limit 1..${HIPPOCAMPUS_LIMITS.overviewMax}`);
      if (!['newest', 'oldest', 'shuffle'].includes(order)) fail('order 是 newest、oldest 或 shuffle');
      const filter = args.filter ?? 'all';
      if (!['all', 'unread', 'untouched'].includes(filter)) fail('filter 是 all、unread（没展开读过的）或 untouched（没起名、没体会、没改过、不在事件里的）');
      // shuffle: a stable order for one seed, so paging works; a new seed gives a new order.
      const seed = order === 'shuffle' ? (Number.isSafeInteger(args.seed) ? args.seed : Math.floor(Math.random() * 1e9)) : null;
      const opening = episode => openingOf(view, episode);
      const reads = new Map(store.db.prepare('SELECT anchor_raw_id,max(at) AS at FROM episode_reads GROUP BY anchor_raw_id').all().map(row => [row.anchor_raw_id, row.at]));
      const lastRead = episode => episode.members.map(rawId => reads.get(rawId)).filter(Boolean).sort().at(-1) ?? null;
      const notes = allNotes(store), withdrawn = allNotes(store, { retracted: true }), linked = new Set(store.db.prepare("SELECT anchor_raw_id FROM episode_events e WHERE action='link' AND seq=(SELECT max(seq) FROM episode_events WHERE event_id=e.event_id AND anchor_raw_id=e.anchor_raw_id)").all().map(row => row.anchor_raw_id));
      const rows = view.episodes.map(episode => {
        const own = notesFor(store, episode.members, notes, withdrawn);
        return { episodeId: episode.episodeId, startRawId: episode.startRawId, startAt: episode.startAt, endAt: episode.endAt, rounds: episode.rounds,
          activity: episode.activity, opening: opening(episode), name: own.name, ...(own.nameSeq ? { nameSeq: own.nameSeq } : {}), reflections: own.reflections.length, revised: episode.status === 'fish-revised',
          inEvent: episode.members.some(rawId => linked.has(rawId)), lastReadAt: lastRead(episode),
          // Handled (named, reflected on, re-cut, linked) says more than having expanded it once.
          handled: Boolean(own.name || own.reflections.length || own.retracted.length || episode.status === 'fish-revised' || episode.members.some(rawId => linked.has(rawId))), ...(own.retracted.length ? { retracted: own.retracted.length } : {}) };
      });
      if (order === 'newest') rows.reverse();
      if (order === 'shuffle') {
        const key = row => createHash('sha256').update(`${seed}\0${row.episodeId}`).digest('hex');
        rows.sort((a, b) => key(a).localeCompare(key(b)));
      }
      const totals = { episodes: rows.length, named: rows.filter(r => r.name).length, withReflections: rows.filter(r => r.reflections).length,
        revised: rows.filter(r => r.revised).length, inEvents: rows.filter(r => r.inEvent).length,
        untouched: rows.filter(r => !r.name && !r.reflections && !r.revised && !r.inEvent).length, retractedNotes: withdrawn.length,
        read: rows.filter(r => r.lastReadAt || r.handled).length };
      const shown = filter === 'unread' ? rows.filter(r => !r.lastReadAt && !r.handled) : filter === 'untouched' ? rows.filter(r => !r.name && !r.reflections && !r.revised && !r.inEvent) : rows;
      const items = shown.slice(offset, offset + limit);
      return { totals, order, ...(seed !== null ? { seed } : {}), offset, items, filter, matching: shown.length, nextOffset: offset + items.length < shown.length ? offset + items.length : null,
        note: '这只是目录，不判断哪段重要；opening 是这段开头那句真人原话的前 40 个字。想换个顺序看可以 order:shuffle（翻页时带上同一个 seed）。' };
    }
    case 'name': case 'note': {
      const requestId = requestIdOf(args), anchor = anchorOf(view, args);
      // An empty name means "un-name it": point to the retraction that does exactly that.
      if (args.action === 'name' && typeof args.text === 'string' && !args.text.trim()) {
        const current = notesFor(store, view.episodes[view.byRaw.get(anchor)].members);
        fail(current.nameSeq ? `要清空名字，用 retract_note 收回 seq ${current.nameSeq}（需要写理由），会退回上一个名字或未命名。` : '这段本来就没有名字。');
      }
      const payload = args.action === 'name' ? { text: text(args.text, '名字', HIPPOCAMPUS_LIMITS.nameChars) }
        : { text: text(args.text, '体会', HIPPOCAMPUS_LIMITS.noteChars), nature: NATURES.has(args.nature) ? args.nature : fail('nature 必须是 experience（第一手经历）/ recollection（复述旧记忆）/ mixed') };
      const result = append(store, 'episode_notes', requestId, ['anchor_raw_id', 'kind'], [anchor, args.action === 'name' ? 'name' : 'reflection'], payload);
      return { ...result, anchorRawId: anchor, episode: summary(store, view, view.byRaw.get(anchor)) };
    }
    case 'link_event': case 'unlink_event': {
      const requestId = requestIdOf(args), anchor = anchorOf(view, args);
      const eventId = text(args.eventId, 'eventId', HIPPOCAMPUS_LIMITS.eventIdChars), action = args.action === 'link_event' ? 'link' : 'unlink';
      const payload = { action, eventId, ...(args.title ? { title: text(args.title, 'title', HIPPOCAMPUS_LIMITS.titleChars) } : {}) };
      if (action === 'link') {
        const result = append(store, 'episode_events', requestId, ['event_id', 'anchor_raw_id', 'action'], [eventId, anchor, 'link'], payload);
        return { ...result, anchorRawId: anchor, episode: summary(store, view, view.byRaw.get(anchor)) };
      }
      // Unlink: whatever anchors of this event lie inside this episode; no ids to manage.
      const index = view.byRaw.get(anchor), members = new Set(view.episodes[index].members), linked = new Map();
      for (const row of store.db.prepare('SELECT anchor_raw_id,action FROM episode_events WHERE event_id=? ORDER BY seq').all(eventId))
        if (members.has(row.anchor_raw_id)) { if (row.action === 'link') linked.set(row.anchor_raw_id, true); else linked.delete(row.anchor_raw_id); }
      if (store.db.prepare('SELECT 1 FROM episode_events WHERE request_id=?').get(requestId)) fail('这个 requestId 已经用在挂接上了，撤销时换一个，或者直接省略 requestId。');
      const prior = store.db.prepare("SELECT 1 FROM episode_events WHERE request_id LIKE ? AND action='unlink'").get(`${requestId}:%`);
      if (!prior && !linked.size) fail(`这段经历没有挂在事件「${eventId}」上`);
      const results = [...linked.keys()].map((rawId, i) => append(store, 'episode_events', `${requestId}:${i}`, ['event_id', 'anchor_raw_id', 'action'], [eventId, rawId, 'unlink'], payload));
      return { committed: results.some(r => r.committed), duplicate: Boolean(prior) && !results.some(r => r.committed), unlinkedAnchors: [...linked.keys()],
        episode: summary(store, effectiveEpisodes(store), index) };
    }
    case 'events': {
      const events = new Map();
      for (const row of store.db.prepare('SELECT event_id,anchor_raw_id,action,json FROM episode_events ORDER BY seq').all()) {
        if (!events.has(row.event_id)) events.set(row.event_id, { eventId: row.event_id, title: null, anchors: new Set() });
        const event = events.get(row.event_id), title = JSON.parse(row.json).title;
        if (title) event.title = title;
        if (row.action === 'link') event.anchors.add(row.anchor_raw_id); else event.anchors.delete(row.anchor_raw_id);
      }
      // Each link is anchored to one original; show it, so it is visible which part of an episode was linked.
      return { items: [...events.values()].map(event => {
        const indexes = [...new Set([...event.anchors].map(anchor => view.byRaw.get(anchor)).filter(index => index !== undefined))].sort((a, b) => a - b);
        // The timeline: every episode from the first linked one to the last, in order; only linked ones are part of the event.
        const span = indexes.length > 1 ? view.episodes.slice(indexes[0], indexes.at(-1) + 1).map((episode, offset) => ({ index: indexes[0] + offset, episode })) : [];
        const between = span.filter(({ index }) => !indexes.includes(index)), notes = allNotes(store), withdrawn = allNotes(store, { retracted: true });
        return { eventId: event.eventId, title: event.title, episodes: indexes.map(index => ({ ...summary(store, view, index, { notes: false }),
          anchors: [...event.anchors].filter(anchor => view.byRaw.get(anchor) === index).map(anchor => ({ rawId: anchor,
            recordedAt: view.roundOf.get(anchor)?.parts.find(p => p.rawId === anchor)?.recordedAt ?? null })) })),
          ...(span.length ? { timeline: { from: view.episodes[indexes[0]].startAt, to: view.episodes[indexes.at(-1)].endAt,
            between: between.slice(0, 20).map(({ episode }) => ({ episodeId: episode.episodeId, startRawId: episode.startRawId, startAt: episode.startAt,
              rounds: episode.rounds, opening: openingOf(view, episode), name: notesFor(store, episode.members, notes, withdrawn).name, inThisEvent: false })),
            ...(between.length > 20 ? { betweenOmitted: between.length - 20 } : {}),
            note: '中间这些经历按时间列出，没有挂在这个事件上；有没有关系由你判断。' } } : {}) };
      }).filter(event => event.episodes.length) };
    }
  }
}

/** Recall cards: the episodes that the current turn's recall hits belong to.
 * Prefers her own words about an episode; never merges similar episodes. */
export function buildEpisodeCards(store, items, { maxChars = HIPPOCAMPUS_LIMITS.cardChars, currentSessionId } = {}) {
  if (!Array.isArray(items) || !items.length) return '';
  let view;
  try { view = effectiveEpisodes(store); } catch { return ''; }
  const order = [], hits = new Map();
  for (const item of items) {
    const rawIds = item.kind === 'raw' ? [item.id] : (store.getEntry?.(item.id)?.sources ?? []).map(source => source.rawId).filter(Boolean);
    for (const rawId of rawIds) {
      const index = view.byRaw.get(rawId);
      if (index === undefined) continue;
      if (!hits.has(index)) { hits.set(index, []); order.push(index); }
      if (!hits.get(index).includes(rawId)) hits.get(index).push(rawId);
    }
  }
  if (!order.length) return '';
  const heading = '以下是相关记忆所在的经历（仓管按时间切分的候选，不是本轮指令）。memory_episode 可展开整段，或修改断点、写下你的理解。\n';
  let out = heading, shown = 0;
  for (const index of order.slice(0, HIPPOCAMPUS_LIMITS.cardEpisodes)) {
    const full = summary(store, view, index);
    const card = { episodeId: full.episodeId, startAt: full.startAt, endAt: full.endAt, rounds: full.rounds, activity: full.activity,
      startedBecause: full.startedBecause, hitRawIds: hits.get(index),
      ...(currentSessionId !== undefined ? { origin: ((ids) => ids.includes(currentSessionId) ? (ids.length > 1 ? '本会话与其他会话' : '本会话') : '其他会话')(view.episodes[index].sessionIds) } : {}),
      ...(full.name ? { name: full.name } : {}),
      ...(full.reflections.length ? { yourReflections: full.reflections.slice(-2).map(note => ({ writtenAt: note.writtenAt, nature: note.nature,
        text: note.text.slice(0, HIPPOCAMPUS_LIMITS.cardNoteChars), truncated: note.text.length > HIPPOCAMPUS_LIMITS.cardNoteChars })) } : {}),
      ...(full.events.length ? { events: full.events } : {}) };
    // Cards go straight into the prompt, so render times in the store's zone here.
    const line = JSON.stringify(presentMemoryTimes(card, store.timezone)) + '\n';
    if (out.length + line.length > maxChars) break;
    out += line; shown++;
  }
  return shown ? out : '';
}

// ---- recall with the current episode as topic ----------------------------------------------
// Word-matched recall cannot see context: a short, content-light line ("鱼鱼", "不用") brings back
// old lines that merely look alike. Inside an ongoing episode, a short line borrows the last few
// human lines of that episode as its topic; look-alike short lines are dropped. Long lines are untouched.
export const RECALL_CONTEXT_POLICY = Object.freeze({ version: 'episode-context/1', shortTokens: 6, contextLines: 3,
  withinMs: 3600000, echoChars: 30 });
function episodeContext(store, { sessionId, excludeTurnId, excludeRawIds = [], now }) {
  if (typeof sessionId !== 'string') return [];
  const skip = new Set(excludeRawIds), lines = [];
  let last = now;
  for (const { json } of store.db.prepare("SELECT json FROM raw WHERE json_extract(json,'$.sessionId')=? AND json_extract(json,'$.role')='user' ORDER BY rowid DESC LIMIT 12").all(sessionId)) {
    const raw = JSON.parse(json), at = Date.parse(raw.recordedAt);
    if (skip.has(raw.id) || String(raw.turnId) === String(excludeTurnId) || typeof raw.text !== 'string' || !raw.text.trim()) continue;
    if (!Number.isFinite(at) || last - at >= RECALL_CONTEXT_POLICY.withinMs) break;   // an hour's gap ends the episode
    lines.push(raw.text); last = at;
    if (lines.length === RECALL_CONTEXT_POLICY.contextLines) break;
  }
  return lines.reverse();
}
export function recallForTurn(store, options, { search: rawSearch, tokens, now = Date.now() } = {}) {
  // What was said in this same session within the hour is already in the conversation: recalling it
  // spends the few slots that older memories need. Such originals are skipped (and the slots refilled).
  const recent = item => item.kind === 'raw' && item.sessionId === options.excludeSessionId && now - Date.parse(item.recordedAt) < RECALL_CONTEXT_POLICY.withinMs;
  const search = (target, opts) => {
    const first = rawSearch(target, opts), skipped = first.items.filter(recent).length;
    if (!skipped) return first;
    const wider = rawSearch(target, { ...opts, limit: Math.min(20, (opts.limit ?? 5) + skipped) });
    return { ...wider, items: wider.items.filter(item => !recent(item)).slice(0, opts.limit ?? 5), recentSkipped: wider.items.filter(recent).length };
  };
  const direct = tokens(options.query ?? '');
  if (!direct.length || direct.length > RECALL_CONTEXT_POLICY.shortTokens) return search(store, options);
  // A look-alike: a short line that contains every content word of the line it was found by.
  const echoOf = source => { const words = tokens(source);
    return item => typeof item.text === 'string' && words.length > 0 && item.text.replace(/\s+/gu, '').length <= RECALL_CONTEXT_POLICY.echoChars
      && words.every(token => new Set(tokens(item.text)).has(token)); };
  const base = search(store, options);
  if (base.method === 'no_substantive_query' || base.contextBased) return base;   // 0.6.2's own follow-up handling stays
  const context = episodeContext(store, { sessionId: options.excludeSessionId, excludeTurnId: options.excludeTurnId, excludeRawIds: options.excludeRawIds, now });
  // Each borrowed line is searched on its own (the recall needs most query words to match), newest first.
  const borrowed = [...context].reverse().flatMap(line => { const echoLine = echoOf(line);
    return search(store, { ...options, query: line, context: '' }).items.filter(item => !echoLine(item)); });
  const echo = echoOf(options.query), seen = new Set(), items = [];
  for (const item of [...borrowed, ...base.items.filter(item => !echo(item))]) {
    if (seen.has(item.id)) continue; seen.add(item.id); items.push(item);
  }
  return { ...base, items: items.slice(0, options.limit ?? 5),
    episodeContext: { policy: RECALL_CONTEXT_POLICY.version, borrowedLines: context.length, echoesDropped: base.items.filter(echo).length } };
}

// ---- A1 review queue grouped by round ---------------------------------------------------------
// Her natural unit when deciding whether something is worth distilling is one exchange, not one
// original: a round split across hundreds of queue items invites half-sentence entries. This only
// regroups the existing queue (same order: early requests first, then oldest); it decides nothing.
export function reviewQueueByTurn(store, reviewQueue, { limit = 3, offset = 0 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10 || !Number.isSafeInteger(offset) || offset < 0) fail('limit 1..10（一次几轮），offset ≥ 0');
  const due = []; let page = reviewQueue(store, { limit: 100 });
  for (;;) { due.push(...page.items); if (!page.hasMore) break; page = reviewQueue(store, { limit: 100, cursor: page.nextCursor }); }
  const groups = new Map();
  for (const item of due) {
    const key = item.sessionId && item.turnId !== null && item.turnId !== undefined ? `${item.sessionId}\0${item.turnId}` : `raw\0${item.rawId}`;
    if (!groups.has(key)) groups.set(key, { sessionId: item.sessionId ?? null, turnId: item.turnId ?? null, items: [] });
    groups.get(key).items.push(item);
  }
  let view = null; try { view = effectiveEpisodes(store); } catch {}
  const all = [...groups.values()], page2 = all.slice(offset, offset + limit).map(group => {
    group.items.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.rawId.localeCompare(b.rawId));
    const queued = new Set(group.items.map(item => item.rawId));
    const round = group.sessionId && group.turnId !== null ? store.db.prepare("SELECT id FROM raw WHERE json_extract(json,'$.sessionId')=? AND json_extract(json,'$.turnId')=?").all(group.sessionId, group.turnId).map(row => row.id) : [];
    const index = view?.byRaw.get(group.items[0].rawId), episode = index !== undefined ? view.episodes[index] : null;
    // Tool outputs are folded by role only (a mechanical fact, not a judgement of worth): she said a
    // 7k-char tool result inflated what she had to read to judge one exchange. They stay in the queue
    // (every original still needs her disposition) and remain one includeTools:true away.
    const pick = ({ rawId, role, recordedAt, textLength, earlyRequested, dueAt }) => ({ rawId, role, recordedAt, textLength, earlyRequested, dueAt });
    const dialog = group.items.filter(item => item.role !== 'tool'), toolItems = group.items.filter(item => item.role === 'tool');
    let tools;
    if (toolItems.length) {
      const used = {};
      for (const item of toolItems) for (const tag of store.getRaw(item.rawId)?.tags ?? []) if (tag.startsWith('dsh:tool:')) used[tag.slice(9)] = (used[tag.slice(9)] ?? 0) + 1;
      tools = { count: toolItems.length, outputChars: toolItems.reduce((n, item) => n + (item.textLength ?? 0), 0), used, rawIds: toolItems.map(item => item.rawId) };
    }
    // One read that shows this exchange with tool output folded, the same view as memory_episode expand.
    let read = null;
    if (episode && group.sessionId && group.turnId !== null) {
      const keys = new Set(episode.members.map(rawId => view.roundStart.get(rawId)));
      const rounds = view.rounds.filter(r => keys.has(r.parts[0].rawId)).sort((a, b) => Date.parse(a.parts[0].recordedAt) - Date.parse(b.parts[0].recordedAt));
      const at = rounds.findIndex(r => r.parts.some(part => part.rawId === group.items[0].rawId));
      if (at >= 0) read = { tool: 'memory_episode', arguments: { action: 'expand', rawId: group.items[0].rawId, offset: at, limit: 1 } };
    }
    return { sessionId: group.sessionId, turnId: group.turnId, recordedAt: group.items[0].recordedAt,
      earlyRequested: group.items.some(item => item.earlyRequested), dueAt: group.items.map(item => item.dueAt).sort()[0],
      rawIds: group.items.map(item => item.rawId),
      items: dialog.map(pick),
      ...(tools ? { tools } : {}),
      ...(read ? { read } : {}),
      ...(round.filter(id => !queued.has(id)).length ? { alsoInThisRound: round.filter(id => !queued.has(id)).length } : {}),
      ...(episode ? { episode: { episodeId: episode.episodeId, name: notesFor(store, episode.members).name } } : {}),
      submit: { tool: 'memory_review', arguments: { rawIds: group.items.map(item => item.rawId).slice(0, 20) } } };
  });
  return { groupBy: 'turn', totalRounds: all.length, totalOriginals: due.length, offset, groups: page2,
    nextOffset: offset + page2.length < all.length ? offset + page2.length : null,
    note: '按一轮问答分组，顺序与原队列相同（标了重要的在前，再按时间）。items 只列对话；工具输出折叠在 tools 里，仍在本轮待审中。read 打开这一轮（工具只列名字，加 includeTools:true 可展开）。不提炼的工具输出可以在 omissions 里用一条 { rawIds, reason } 一起说明。alsoInThisRound 是这轮里已审或未到期、不在队列中的原文条数。提不提炼由你判断。' };
}
