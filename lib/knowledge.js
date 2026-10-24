import { randomUUID } from 'node:crypto';
import { POLICY_VERSION, sourceTimes } from './policy.js';
import { wfId, wfText, wfTime, workflowHash, quotedEvidence, exactReferences } from './workflow.js';

function strings(value, name, max = 20) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw new TypeError(`Invalid ${name}`);
  return [...new Set(value.map(item => wfText(item, name, 500)))];
}
function externalEvidence(values = [], now) {
  if (!Array.isArray(values) || values.length > 20) throw new TypeError('externalSources must contain at most 20 references');
  return values.map(source => {
    const url = new URL(wfText(source?.url, 'url', 2000));
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new TypeError('External sources require HTTP(S) URLs without credentials');
    const accessedAt = wfTime(source.accessedAt ?? now, 'accessedAt'); if (accessedAt > now) throw new TypeError('accessedAt cannot be future');
    return { url: url.href, title: source.title == null ? null : wfText(source.title, 'source title', 200), accessedAt, evidenceStatus: 'external_reference' };
  });
}
export function writeKnowledge(store, input = {}) {
  wfId(input.requestId); wfText(input.reason, 'reason');
  if (!['learned', 'tried', 'verified'].includes(input.validationStatus)) throw new TypeError('D validationStatus must be learned, tried, or verified');
  const hash = workflowHash({ type: 'knowledge', ...input }); let created;
  const result = store._transaction(() => {
    const replay = store._policyReplay(input.requestId, hash); if (replay) return replay;
    const id = wfId(input.id ?? randomUUID()); if (id === 'self') throw new TypeError('self is reserved');
    const old = store.getEntry(id);
    if (old && (old.kind !== 'knowledge' || input.expectedVersion === undefined)) throw new Error('Updating D requires same kind and expectedVersion');
    const now = store.now(); const sources = quotedEvidence(store, input.sources);
    const externalSources = externalEvidence(input.externalSources, now);
    const dependencies = exactReferences(store, input.dependencyEntries ?? [], { min: 0 });
    if (!sources.length && !externalSources.length && !dependencies.length) throw new Error('D requires explicit original, external, or exact-version derived provenance');
    let validation = null;
    if (input.validationStatus !== 'learned') {
      const checkedAt = wfTime(input.validation?.checkedAt ?? now, 'validation.checkedAt'); if (checkedAt > now) throw new TypeError('Validation cannot be future');
      const validationSources = quotedEvidence(store, input.validation?.sources, { required: true });
      if (input.validationStatus === 'verified' && !validationSources.some(source => source.independent !== false)) throw new Error('Derived recollections alone cannot verify knowledge');
      validation = { method: wfText(input.validation?.method, 'validation.method'), result: wfText(input.validation?.result, 'validation.result'), checkedAt, sources: validationSources, semanticStatus: 'declared_check', autoVerified: false };
      for (const source of validationSources) if (!sources.some(existing => existing.rawId === source.rawId && existing.quote === source.quote)) sources.push(source);
    } else if (input.validation != null) throw new TypeError('learned knowledge must not claim validation');
    const purpose = wfText(input.purpose, 'purpose', 600); const conditions = strings(input.conditions, 'conditions'); const method = wfText(input.method, 'method', 10000);
    const environment = input.environment == null ? null : { name: wfText(input.environment.name, 'environment.name', 200), version: input.environment.version == null ? null : wfText(input.environment.version, 'environment.version', 200), notes: input.environment.notes == null ? null : wfText(input.environment.notes, 'environment.notes', 1000) };
    created = { id, version: 0, instanceId: store.instanceId, kind: 'knowledge', pool: 'd', purpose, conditions, method, validationStatus: input.validationStatus, validation, environment,
      text: [purpose, conditions.length ? `适用条件：${conditions.join('；')}` : '', method].filter(Boolean).join('\n'),
      status: 'active', sources: sources.map(source => ({ ...source, support: 'context_only' })), externalSources, dependencyEntries: dependencies,
      evidenceStatus: sources.length ? 'quote_verified' : externalSources.length ? 'external_reference' : 'derived_only', sourceNature: 'learned_experience', statementType: 'self_report', semanticStatus: 'declared_only', independentSourceCount: null, currentValidity: 'unknown',
      hooks: strings(input.hooks, 'hooks'), tags: strings(input.tags, 'tags'), entities: strings(input.entities, 'entities'), aliases: [], project: input.project == null ? null : wfText(input.project, 'project', 200), occurredAt: null,
      recordedAt: now, createdAt: old?.createdAt ?? now, date: store._local(now).date, dictVersion: 'v6', policyVersion: POLICY_VERSION, sourceTimes: sourceTimes(store, sources), knowledgeDecision: { requestId: input.requestId, reason: input.reason, decidedAt: now, sourceVersion: old?.version ?? 0 } };
    created.mentionedTimes = [...new Set(created.sourceTimes.map(source => source.recordedAt))].sort();
    const derived = sources.flatMap(source => source.derivedFromMemory ?? []);
    if (sources.some(source => source.independent === false)) {
      created.derivedFromMemory = [...new Map(derived.map(ref => [`${ref.id}:${ref.version}`, ref])).values()];
      created.derivedFromRaw = [...new Set(sources.flatMap(source => source.derivedFromRaw ?? []))];
      created.dependencyEntries = [...new Map([...dependencies, ...created.derivedFromMemory].map(ref => [`${ref.id}:${ref.version}`, ref])).values()];
      created.nonIndependentEvidence = true;
      if (!externalSources.length && sources.every(source => source.independent === false)) created.evidenceStatus = 'derived_only';
    }
    store._commitPolicyEntry(created, { expectedVersion: input.expectedVersion ?? 0 });
    const saved = { id, version: created.version, pool: 'd', kind: 'knowledge', validationStatus: created.validationStatus, duplicate: false, entry: created };
    store._policySaveDecision({ requestId: input.requestId, type: 'knowledge', id, version: created.version, reason: input.reason, decidedAt: now }, hash, saved); return saved;
  });
  if (created) store._projectEntry(created); store._projectEntryIndex(); store._projectDecisions(); return store._writeResult(result);
}
