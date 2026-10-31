// Host-neutral policy and dispatch guard. This module never invokes compaction or writes host settings.
export const COMPACTION_POLICY = 'boundary-reminders-1.2';
const boundaries = ['evidence-accepted', 'methods-results-accepted', 'before-writer', 'before-review'];
const referenceTokens = 150000;
const freshnessMs = 60000;
const guards = new WeakMap();
const text = value => typeof value === 'string' && !!value.trim();
const date = value => typeof value === 'string' ? Date.parse(value) : NaN;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const stageGuidance = {
  'evidence-accepted': ['Evidence 完成', '保留研究问题、研究设计、数据来源、证据定位与尚未报告的内容；下一步由 Methods 和 Results 基于已接受证据继续。'],
  'methods-results-accepted': ['Methods/Results 完成', '保留关键方法、结果、数值及单位、比较条件、公式和表图定位、方法背景与本文参数的区别、局限和待解决分歧；下一步继续 Interpretation、Synthesizer 和 Integrator。'],
  'before-writer': ['Writer 前', '保留六科学角色的综合主线、关键结论与证据、重要分歧和限制、当前知识复用依赖；下一步由原文语言 Writer 成稿，再由 Translation 翻译，并按冻结选择进行呈现。'],
  'before-review': ['整体审查前', '保留双语候选、图表及知识链接的真实路径、呈现版本和未决问题；下一步对完整候选做整体审查，只核对主结论、关键设计及会改变结论的数值，最多一次局部复核，不重开整篇或扩大审查范围。'],
};

function stageCompactionPrompt(boundary, continuation = {}) {
  const binding = continuation.binding ?? {};
  const executionProfile = binding.configured_setup?.instruction_profile === 'configured-reading-2.1';
  const metadata = {
    run_id: continuation.run_id ?? null, paper_id: continuation.paper_id ?? null,
    run_root: continuation.run_root ?? null, checkpoint_path: continuation.checkpoint_path ?? boundary.recovery.path ?? null,
    binding_source: continuation.binding_source ?? null, input_fingerprint: binding.input_fingerprint ?? null,
    deadline: binding.deadline ?? null, max_total_calls: binding.max_total_calls ?? null, max_calls: binding.max_calls ?? null,
    prior_calls: binding.prior_calls ?? 0, calls_reserved_or_used: continuation.calls_used ?? null,
    ...(executionProfile ? { execution_budget: continuation.budget_summary ?? { remaining_total: null } } : {}),
    main_session: binding.role_model_policy?.main_session ?? null,
    source_language: binding.source_language ?? null, presentation_mode: binding.presentation_mode ?? null,
    presentation_profile: binding.presentation_profile ?? null,
    sources: (continuation.sources ?? []).map(source => ({ path: source.path, sha256: source.sha256 })),
    accepted_artifacts: continuation.accepted_artifacts ?? [], candidate_paths: continuation.candidate_paths ?? [],
  };
  return [
    `请压缩当前 APA 会话，为同一运行继续工作保留交接摘要。当前阶段：${stageGuidance[boundary.id][0]}（${boundary.id}）。`,
    '保留用户目标、最新决定、授权范围、原预算与截止时间、冻结模型及推理强度；角色模型策略从下列绑定来源回读，禁止重置额度或重新绑定。',
    ...(executionProfile ? ['禁止自行控制所有桌面应用；obsidian-cli 的截图、eval 及其他原生观察同样需要用户明确授权。原 PDF 图片可通过文件工具检查。原生验收状态与已发生的电脑操作分别据实报告，缺失记录保持未知。保留首次派发、续接和预留的执行账本，未知结果先核对，不自动重派。'] : []),
    stageGuidance[boundary.id][1],
    '保留结论对应的证据位置、关键条件与研究限制、未完成事项和真实任务句柄。未知信息明确标为未知，区分已接受、待审查和未运行；以下 null 同样表示未知。',
    '以下为实际恢复锚点，仅包含元数据；保留路径与指纹，正文和角色全文留在产物中，需要时按下一步范围回读。',
    JSON.stringify(metadata),
    '恢复后先核对原进程、任务状态和最新检查点；沿原运行继续，已派发任务先协调实际结果，避免重复派发。只有观察到对应会话的成功事件才记压缩完成；用户可选择跳过。',
  ].join('\n\n');
}

export function createCompactionPolicy(controllerActorId, now = new Date().toISOString(), { profile = COMPACTION_POLICY, manualCompaction } = {}) {
  return { profile, started_at: now, ...(['boundary-reminders-1.1', COMPACTION_POLICY].includes(profile) && manualCompaction ? { manual_compaction: structuredClone(manualCompaction) } : {}), checkpoints: Object.fromEntries(['before-writer', 'before-review'].map(id => [id,
    Object.fromEntries(['decision', 'resume'].map(step => [step, {
      artifact_id: 'compaction-' + id + '-' + step, artifact_path: 'control/compaction-' + id + '-' + step + '.json',
      revision: '1', role: 'control', owner_actor_id: controllerActorId,
    }]))])) };
}

export function compactionEnabled(binding) {
  return ['boundary-reminders-1.0', 'boundary-reminders-1.1', COMPACTION_POLICY].includes(binding?.compaction_policy?.profile);
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
export function evaluateCompactionBoundary({ boundary, observation, sessionId, startedAt, progress = {}, history = {}, userDecision, policy, continuation, now = Date.now() } = {}) {
  if (!boundary || !boundaries.includes(boundary.id) || !boundary.reached || !boundary.recovery?.saved || boundary.running_count !== 0) {
    return { action: 'reconcile', record: null, message: null, reason: 'boundary-not-safely-saved' };
  }
  if (userDecision !== undefined && !['continue', 'skip'].includes(userDecision)) fail('APA_COMPACTION_USER_DECISION_INVALID');
  const prior = history[boundary.id] ?? boundary.reminder ?? { status: 'pending' };
  if (['completed', 'skipped'].includes(prior.status)) return { action: 'continue', record: null, message: null };
  const input = ['boundary-reminders-1.1', COMPACTION_POLICY].includes(policy?.profile) && observation?.manual_compaction === undefined && policy.manual_compaction
    ? { ...observation, manual_compaction: policy.manual_compaction } : observation;
  const observed = normalizeObservation(input, sessionId, startedAt, now, history);
  const at = new Date(now).toISOString();
  const finish = (status, reason, extra = {}) => ({
    action: status === 'prompted' ? 'await-user' : 'continue', message: null,
    record: { status, reason, observation: observed, recorded_at: at, ...extra },
  });
  if (prior.status === 'prompted') {
    if (!userDecision) return { action: 'await-user', record: null, message: null, reason: 'user-decision-required' };
    const verified = userDecision === 'continue' && observed.last_compaction && date(observed.last_compaction.occurred_at) > date(prior.prompted_at);
    return finish(verified ? 'completed' : 'skipped', verified ? 'host-compaction-observed' : userDecision === 'skip' ? 'user-skipped' : 'continued-without-observed-compaction',
      { prompted_at: prior.prompted_at, user_decision: userDecision, compaction_verified: !!verified,
        ...(prior.compaction_prompt ? { compaction_prompt: prior.compaction_prompt } : {}) });
  }
  if (userDecision !== undefined) fail('APA_COMPACTION_NOT_PROMPTED');
  const mandatory = policy?.profile === COMPACTION_POLICY;
  if (!mandatory && !observed.manual_compaction.available) return finish('skipped', 'manual-compaction-unavailable');
  const known = observed.context.status === 'known';
  if (!mandatory && !known) {
    const previouslyPrompted = Object.values(history).some(record => text(record.prompted_at) || ['prompted', 'completed'].includes(record.status));
    const previouslyCompacted = observed.last_compaction || Object.values(history).some(record => record.observation?.last_compaction?.status === 'succeeded');
    if (boundary.id !== 'before-writer' || previouslyPrompted || previouslyCompacted) return finish('skipped', 'unknown-context-fallback-not-due');
  } else if (!mandatory) {
    if (observed.context.tokens < referenceTokens) return finish('skipped', 'below-context-reference');
    if (progress.remaining_work?.multiple_responses !== true || !text(progress.remaining_work.reason)) return finish('skipped', 'remaining-work-not-established');
    if (progress.growth?.substantial !== true || !text(progress.growth.reason)) return finish('skipped', 'meaningful-growth-not-established');
  }
  const result = finish('prompted', mandatory ? 'boundary-reminder-required' : known ? 'large-context-with-work-remaining' : 'before-writer-context-unknown',
    { prompted_at: at, progress: structuredClone(progress) });
  const usage = !known ? '当前上下文用量未知，本次在 Writer 前进行阶段提醒。'
    : observed.context.kind === 'last-request-input' ? `最近一次请求输入为 ${observed.context.tokens} token。` : `宿主观测的当前上下文为 ${observed.context.tokens} token。`;
  if (mandatory) {
    const stage = stageGuidance[boundary.id][0];
    const entry = observed.manual_compaction.available ? `可使用已核实的入口：${observed.manual_compaction.method}。` : '当前宿主的可用手动压缩入口尚未核实。';
    result.compaction_prompt = stageCompactionPrompt(boundary, continuation);
    result.record.compaction_prompt = result.compaction_prompt;
    result.message = `已到达 ${stage}，推荐先压缩上下文。${known ? usage : '当前上下文用量未知。'}状态已保存。${entry}是否压缩由你决定；压缩后回复继续，或回复跳过并继续。\n\n可复制的阶段压缩提示词：\n\n\`\`\`text\n${result.compaction_prompt}\n\`\`\``;
    return result;
  }
  result.message = `${usage}状态已保存；本轮结束后可使用 ${observed.manual_compaction.method} 压缩，再回复继续；也可回复跳过并继续。`;
  return result;
}
