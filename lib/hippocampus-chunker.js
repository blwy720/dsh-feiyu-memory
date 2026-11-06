import { createHash } from 'node:crypto';
import { recallTokens } from './recall.js';

// Hippocampus encoding, step one: propose episode boundaries from cheap local
// signals. No model, no writes. Every boundary is a candidate that takes effect
// by default; the fish may later merge, split or rename. The output carries
// record IDs, times and signal names only, never message text.
// Portable to the 0.6.x line: it depends only on recallTokens and raw/originals.
export const EPISODE_CHUNKER_POLICY = Object.freeze({
  version: 'episode-chunker/1',
  idleMs: 3600000,          // >= 1 hour between rounds: strong candidate
  chapterRounds: 30,        // a long episode gets a chapter mark, not a new episode
  // Tool use is interleaved with talk inside one topic (sampled on real data: most switches
  // were the same matter), so a switch is recorded but does not cut by itself.
  activityStrength: 'weak',
  windowRounds: 2,          // lexical comparison window
  lexicalEnabled: false,    // off: on real data it fired at over half of all round junctions
  lexicalJaccard: 0.04,     // overlap below this is a weak candidate only
  lexicalMinTokens: 6,
});
const TOOL_CLASSES = Object.freeze({
  code: ['pwsh', 'bash', 'edit', 'write', 'read', 'grep', 'glob', 'job_output', 'plugin_manager', 'skill'],
  media: ['read_image', 'read_video'],
  web: ['web_fetch', 'web_search'],
});
// A topic turn has to open a clause; "对了吗" in the middle of a sentence is not one.
const TOPIC_SHIFT = /(?:^|[。！？!?\n；;，,\s])(?:换个话题|换个话说|说回来|说回正题|回到刚才|回到之前|这个先放一边|先放一边|先不说这个|不说这个了|另外问一下|另外问个|问个不相干的|聊点别的|聊聊别的|对了[，,、\s])/u;
const STRENGTH = { strong: 3, medium: 2, weak: 1 };
const sha = value => createHash('sha256').update(value).digest('hex');
const time = value => { const at = Date.parse(value); return Number.isFinite(at) ? at : null; };

function toolName(tag) {
  if (typeof tag !== 'string' || !tag.startsWith('dsh:tool:')) return null;
  const name = tag.slice('dsh:tool:'.length);
  return name.startsWith('mcp__') ? name.split('__').at(-1) : name;
}
/** chat | code | media | web, by the most frequent tool class in the round. */
export function roundActivity(round) {
  const counts = {};
  for (const part of round.parts) {
    if (part.role !== 'tool') continue;
    for (const tag of part.tags ?? []) {
      const name = toolName(tag);
      const kind = name && Object.keys(TOOL_CLASSES).find(key => TOOL_CLASSES[key].includes(name));
      if (kind) counts[kind] = (counts[kind] ?? 0) + 1;
    }
  }
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return ranked[0]?.[0] ?? 'chat';
}
// Tool output (paths, logs) is excluded from the lexical signal.
const conversationTokens = round => new Set(recallTokens(round.parts.filter(part => part.role !== 'tool')
  .map(part => part.text ?? '').join('\n'), 512));
const humanText = round => round.parts.filter(part => part.role === 'user').map(part => part.text ?? '').join('\n');
const startAt = round => time(round.parts.find(part => part.role === 'user')?.recordedAt ?? round.parts[0]?.recordedAt);
const endAt = round => Math.max(...round.parts.map(part => time(part.recordedAt) ?? -Infinity));

function validRounds(rounds) {
  if (!Array.isArray(rounds)) throw new TypeError('EPISODE_ROUNDS_REQUIRED');
  for (const round of rounds) {
    if (!round || typeof round.sessionId !== 'string' || typeof round.turnId !== 'string' || !Array.isArray(round.parts) || !round.parts.length
        || round.parts.some(part => typeof part?.rawId !== 'string' || time(part.recordedAt) === null))
      throw new TypeError('EPISODE_ROUND_INVALID');
  }
  return [...rounds].sort((a, b) => startAt(a) - startAt(b) || a.sessionId.localeCompare(b.sessionId) || a.turnId.localeCompare(b.turnId));
}

/** Propose episodes and the candidate boundaries behind them. Deterministic.
 * revisions: the fish's own decisions, keyed by the first raw ID of a round:
 * split always cuts there, merge never does. members adds each episode's raw IDs. */
export function proposeEpisodes(rounds, policy = EPISODE_CHUNKER_POLICY, { split = new Set(), merge = new Set(), members = false } = {}) {
  const ordered = validRounds(rounds), boundaries = [], cuts = [0];
  if (!ordered.length) return { policy: policy.version, episodes: [], boundaries };   // a new, empty store
  const activity = ordered.map(roundActivity), tokens = ordered.map(conversationTokens);
  let sinceCut = 0;
  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1], current = ordered[i], signals = [];
    if (previous.sessionId !== current.sessionId) signals.push({ kind: 'session-boundary', strength: 'strong' });
    const gap = startAt(current) - endAt(previous);
    if (gap >= policy.idleMs) signals.push({ kind: 'idle-gap', strength: 'strong', minutes: Math.round(gap / 60000) });
    // A sustained switch only, on both sides: one chat question in the middle of
    // coding is not a new episode, and neither is the return to coding after it.
    const before = i - 2 < cuts.at(-1) || activity[i - 2] === activity[i - 1];
    if (activity[i] !== activity[i - 1] && before && i + 1 < ordered.length && activity[i + 1] === activity[i])
      signals.push({ kind: 'activity-switch', strength: policy.activityStrength, from: activity[i - 1], to: activity[i] });
    if (TOPIC_SHIFT.test(humanText(current))) signals.push({ kind: 'topic-phrase', strength: 'medium' });
    const window = new Set();
    for (let j = Math.max(cuts.at(-1), i - policy.windowRounds); j < i; j++) for (const token of tokens[j]) window.add(token);
    if (policy.lexicalEnabled && window.size >= policy.lexicalMinTokens && tokens[i].size >= policy.lexicalMinTokens) {
      let shared = 0; for (const token of tokens[i]) if (window.has(token)) shared++;
      const jaccard = shared / (window.size + tokens[i].size - shared);
      if (jaccard < policy.lexicalJaccard) signals.push({ kind: 'lexical-drop', strength: 'weak', jaccard: Math.round(jaccard * 1000) / 1000 });
    }
    const top = Math.max(0, ...signals.map(signal => STRENGTH[signal.strength]));
    sinceCut++;
    let decision = top >= STRENGTH.medium ? 'cut' : top === STRENGTH.weak ? 'weak-candidate' : null;
    const key = current.parts[0].rawId;
    if (decision === 'cut' && merge.has(key)) { decision = 'merged-by-fish'; signals.push({ kind: 'fish-merge', strength: 'fish' }); }
    else if (decision !== 'cut' && split.has(key)) { decision = 'cut'; signals.push({ kind: 'fish-split', strength: 'fish' }); }
    if (decision === 'cut') { cuts.push(i); sinceCut = 0; }
    else if (sinceCut > 0 && sinceCut % policy.chapterRounds === 0) decision = decision ? `${decision}+chapter` : 'chapter';
    if (decision) boundaries.push({ beforeRawId: current.parts[0].rawId, beforeRound: `${current.sessionId}:${current.turnId}`,
      at: new Date(startAt(current)).toISOString(), signals, strength: Object.keys(STRENGTH).find(key => STRENGTH[key] === top) ?? null, decision });
  }
  const episodes = cuts.map((start, index) => {
    const end = (cuts[index + 1] ?? ordered.length) - 1, slice = ordered.slice(start, end + 1);
    const first = slice[0].parts[0], last = slice.at(-1).parts.at(-1);
    const chapters = boundaries.filter(boundary => boundary.decision.includes('chapter')
      && slice.some(round => `${round.sessionId}:${round.turnId}` === boundary.beforeRound)).map(boundary => boundary.beforeRawId);
    const keys = new Set(slice.map(round => `${round.sessionId}:${round.turnId}`));
    const revised = boundaries.some(boundary => keys.has(boundary.beforeRound) && boundary.signals.some(signal => signal.strength === 'fish'));
    return { episodeId: `ep:${sha(`${EPISODE_CHUNKER_POLICY.version}\0${first.rawId}`).slice(0, 20)}`,
      startRawId: first.rawId, endRawId: last.rawId, startAt: new Date(startAt(slice[0])).toISOString(),
      endAt: new Date(endAt(slice.at(-1))).toISOString(), rounds: slice.length,
      sessionIds: [...new Set(slice.map(round => round.sessionId))], activity: [...new Set(slice.map(roundActivity))],
      chapterStarts: chapters, status: revised ? 'fish-revised' : 'program-candidate',
      ...(members ? { members: slice.flatMap(round => round.parts.map(part => part.rawId)) } : {}) };
  });
  episodes.forEach((episode, index) => { episode.prev = episodes[index - 1]?.episodeId ?? null; episode.next = episodes[index + 1]?.episodeId ?? null; });
  return { policy: policy.version, episodes, boundaries };
}

/** Read-only loader: groups raw and retained originals into rounds by sessionId + turnId.
 * Bodies stay in memory for the signals; nothing here is written or returned as text by proposeEpisodes. */
export function loadRounds(db) {
  const rows = db.prepare("SELECT json FROM raw UNION ALL SELECT json FROM originals WHERE NOT EXISTS (SELECT 1 FROM raw r WHERE r.id = originals.id)").all();
  const rounds = new Map();
  for (const { json } of rows) {
    const record = JSON.parse(json);
    if (typeof record.sessionId !== 'string' || record.turnId === undefined || record.turnId === null) continue;
    const key = `${record.sessionId}\0${record.turnId}`;
    if (!rounds.has(key)) rounds.set(key, { sessionId: record.sessionId, turnId: String(record.turnId), parts: [] });
    rounds.get(key).parts.push({ rawId: record.id, role: record.role, recordedAt: record.recordedAt, text: record.text, tags: record.tags ?? [] });
  }
  for (const round of rounds.values()) round.parts.sort((a, b) => time(a.recordedAt) - time(b.recordedAt) || a.rawId.localeCompare(b.rawId));
  return [...rounds.values()];
}
