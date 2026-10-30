// Host-neutral policy and dispatch guard. This module never invokes compaction or writes host settings.
export const COMPACTION_POLICY = 'boundary-reminders-1.0';
const boundaries = ['evidence-accepted', 'methods-results-accepted', 'before-writer', 'before-review'];
const referenceTokens = 150000;
const freshnessMs = 60000;
const guards = new WeakMap();
const text = value => typeof value === 'string' && !!value.trim();
const date = value => typeof value === 'string' ? Date.parse(value) : NaN;
const fail = code => { throw Object.assign(new Error(code), { code }); };

export function createCompactionPolicy(controllerActorId, now = new Date().toISOString()) {
  return { profile: COMPACTION_POLICY, started_at: now, checkpoints: Object.fromEntries(['before-writer', 'before-review'].map(id => [id,
    Object.fromEntries(['decision', 'resume'].map(step => [step, {
      artifact_id: 'compaction-' + id + '-' + step, artifact_path: 'control/compaction-' + id + '-' + step + '.json',
      revision: '1', role: 'control', owner_actor_id: controllerActorId,
    }]))])) };
}

export function compactionEnabled(binding) {
  return binding?.compaction_policy?.profile === COMPACTION_POLICY;
}

export function compactionControlBindings(runControl) {
  const policy = runControl?.reading_first_binding?.compaction_policy;
  if (!policy) return [];
  return Object.values(policy.checkpoints).flatMap(steps => Object.values(steps)).map(task => ({
    run_id: runControl.run_id, actor_id: task.owner_actor_id, role: task.role, artifact_path: task.artifact_path, revision: task.revision,
  }));
}

/** Register the live owner of a request; serialized requests must be recovered through that owner. */
export function registerCompactionDispatch(request, check) {
  guards.set(request, check);
  return request;
}

export function assertCompactionDispatchAllowed(binding, request) {
  if (!compactionEnabled(binding)) return;
  const check = guards.get(request);
  if (!check) fail('APA_COMPACTION_CONTROLLER_REQUIRED');
  check();
}

export function assertCompactionSettled(history, id) {
  if (Object.values(history ?? {}).some(record => record.status === 'prompted')) fail('APA_COMPACTION_AWAITING_USER');
  if (id && !['skipped', 'completed'].includes(history?.[id]?.status)) fail('APA_COMPACTION_BOUNDARY_REQUIRED');
}

function normalizeObservation(observation, sessionId, startedAt, now, history) {
  const readAt = date(observation?.observed_at);
  const fresh = Number.isFinite(readAt) && readAt <= now && now - readAt <= freshnessMs;
  const correlated = text(sessionId) && observation?.session_id === sessionId;
  const event = observation?.last_compaction;
  const eventAt = date(event?.occurred_at);
  let last = fresh && correlated && event?.session_id === sessionId && event.status === 'succeeded' && text(event.id) && text(event.source)
    && Number.isFinite(eventAt) && eventAt >= date(startedAt) && eventAt <= readAt ? structuredClone(event) : null;
  for (const record of Object.values(history)) {
    const saved = record.observation?.last_compaction;
    const savedAt = date(saved?.occurred_at);
    if (text(sessionId) && saved?.session_id === sessionId && saved.status === 'succeeded' && text(saved.id) && text(saved.source)
      && Number.isFinite(savedAt) && savedAt >= date(startedAt) && savedAt <= now && (!last || savedAt > date(last.occurred_at))) last = structuredClone(saved);
  }
  const measurement = observation?.context;
  const measuredAt = date(measurement?.measured_at);
  let reason = !correlated ? 'session-unavailable-or-mismatched' : !fresh ? 'observation-stale-or-unavailable'
    : !measurement ? 'context-unavailable' : !['current-context', 'last-request-input'].includes(measurement.kind) ? 'unsupported-measurement-kind'
    : !Number.isSafeInteger(measurement.tokens) || measurement.tokens < 0 ? 'invalid-token-count'
    : measurement.fresh !== true || !text(measurement.source) || !Number.isFinite(measuredAt) || measuredAt > readAt || now - measuredAt > freshnessMs ? 'measurement-stale-or-unverified'
    : last && measuredAt <= date(last.occurred_at) ? 'measurement-precedes-compaction' : null;
  const manual = observation?.manual_compaction;
  return {
    session_id: correlated ? sessionId : null, observed_at: fresh ? observation.observed_at : null,
    context: reason ? { status: 'unknown', reason } : { status: 'known', ...structuredClone(measurement) },
    manual_compaction: { available: manual?.available === true && text(manual.method) && text(manual.source),
      method: text(manual?.method) ? manual.method : null, source: text(manual?.source) ? manual.source : null },
    last_compaction: last,
  };
}

/** Decisions are persisted by the owning Controller before an await-user result reaches the caller. */
export function evaluateCompactionBoundary({ boundary, observation, sessionId, startedAt, progress = {}, history = {}, userDecision, now = Date.now() } = {}) {
  if (!boundary || !boundaries.includes(boundary.id) || !boundary.reached || !boundary.recovery?.saved || boundary.running_count !== 0) {
    return { action: 'reconcile', record: null, message: null, reason: 'boundary-not-safely-saved' };
  }
  if (userDecision !== undefined && !['continue', 'skip'].includes(userDecision)) fail('APA_COMPACTION_USER_DECISION_INVALID');
  const prior = history[boundary.id] ?? boundary.reminder ?? { status: 'pending' };
  if (['completed', 'skipped'].includes(prior.status)) return { action: 'continue', record: null, message: null };
  const observed = normalizeObservation(observation, sessionId, startedAt, now, history);
  const at = new Date(now).toISOString();
  const finish = (status, reason, extra = {}) => ({
    action: status === 'prompted' ? 'await-user' : 'continue', message: null,
    record: { status, reason, observation: observed, recorded_at: at, ...extra },
  });
  if (prior.status === 'prompted') {
    if (!userDecision) return { action: 'await-user', record: null, message: null, reason: 'user-decision-required' };
    const verified = userDecision === 'continue' && observed.last_compaction && date(observed.last_compaction.occurred_at) > date(prior.prompted_at);
    return finish(verified ? 'completed' : 'skipped', verified ? 'host-compaction-observed' : userDecision === 'skip' ? 'user-skipped' : 'continued-without-observed-compaction',
      { prompted_at: prior.prompted_at, user_decision: userDecision, compaction_verified: !!verified });
  }
  if (userDecision !== undefined) fail('APA_COMPACTION_NOT_PROMPTED');
  if (!observed.manual_compaction.available) return finish('skipped', 'manual-compaction-unavailable');
  const known = observed.context.status === 'known';
  if (!known) {
    const previouslyPrompted = Object.values(history).some(record => text(record.prompted_at) || ['prompted', 'completed'].includes(record.status));
    const previouslyCompacted = observed.last_compaction || Object.values(history).some(record => record.observation?.last_compaction?.status === 'succeeded');
    if (boundary.id !== 'before-writer' || previouslyPrompted || previouslyCompacted) return finish('skipped', 'unknown-context-fallback-not-due');
  } else {
    if (observed.context.tokens < referenceTokens) return finish('skipped', 'below-context-reference');
    if (progress.remaining_work?.multiple_responses !== true || !text(progress.remaining_work.reason)) return finish('skipped', 'remaining-work-not-established');
    if (progress.growth?.substantial !== true || !text(progress.growth.reason)) return finish('skipped', 'meaningful-growth-not-established');
  }
  const result = finish('prompted', known ? 'large-context-with-work-remaining' : 'before-writer-context-unknown',
    { prompted_at: at, progress: structuredClone(progress) });
  const usage = !known ? '当前上下文用量未知，本次在 Writer 前进行阶段提醒。'
    : observed.context.kind === 'last-request-input' ? `最近一次请求输入为 ${observed.context.tokens} token。` : `宿主观测的当前上下文为 ${observed.context.tokens} token。`;
  result.message = `${usage}状态已保存；本轮结束后可使用 ${observed.manual_compaction.method} 压缩，再回复继续；也可回复跳过并继续。`;
  return result;
}
