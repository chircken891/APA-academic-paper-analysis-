// Forced stage compaction reminders. The Controller only builds the reminder text; it never measures context,
// invokes compaction, records the user's reply or writes host settings. Automatic compaction is the host threshold setting.
export const COMPACTION_POLICY = 'boundary-reminders-2.0';
const stageGuidance = {
  'evidence-accepted': ['Evidence 完成', '保留研究问题、研究设计、数据来源、证据定位与尚未报告的内容；下一步由 Methods 和 Results 基于已接受证据继续。'],
  'methods-results-accepted': ['Methods/Results 完成', '保留关键方法、结果、数值及单位、比较条件、公式和表图定位、方法背景与本文参数的区别、局限和待解决分歧；下一步继续 Interpretation、Synthesizer 和 Integrator。'],
  'before-writer': ['Writer 前', '保留六科学角色的综合主线、关键结论与证据、重要分歧和限制、当前知识复用依赖；下一步由原文语言 Writer 成稿，再由 Translation 翻译，并按冻结选择进行呈现。'],
  'before-review': ['整体审查前', '保留双语候选、图表及知识链接的真实路径、呈现版本和未决问题；下一步对完整候选做整体审查，只核对主结论、关键设计及会改变结论的数值，最多一次局部复核，不重开整篇或扩大审查范围。'],
};
export const COMPACTION_BOUNDARIES = Object.freeze(Object.keys(stageGuidance));

function stageCompactionPrompt(id, continuation = {}) {
  const binding = continuation.binding ?? {};
  const metadata = {
    run_id: continuation.run_id ?? null, paper_id: continuation.paper_id ?? null,
    run_root: continuation.run_root ?? null, checkpoint_path: continuation.checkpoint_path ?? null,
    binding_source: continuation.binding_source ?? null, input_fingerprint: binding.input_fingerprint ?? null,
    max_total_calls: binding.max_total_calls ?? null, max_calls: binding.max_calls ?? null,
    prior_calls: binding.prior_calls ?? 0, calls_reserved_or_used: continuation.calls_used ?? null,
    execution_budget: continuation.budget_summary ?? { remaining_total: null },
    main_session: binding.role_model_policy?.main_session ?? null,
    source_language: binding.source_language ?? null, presentation_mode: binding.presentation_mode ?? null,
    presentation_profile: binding.presentation_profile ?? null,
    sources: (continuation.sources ?? []).map(source => ({ path: source.path, sha256: source.sha256 })),
    accepted_artifacts: continuation.accepted_artifacts ?? [], candidate_paths: continuation.candidate_paths ?? [],
  };
  return [
    `请压缩当前 APA 会话，为同一运行继续工作保留交接摘要。当前阶段：${stageGuidance[id][0]}（${id}）。`,
    '保留用户目标、最新决定、授权范围、原预算、冻结模型及推理强度；角色模型策略从下列绑定来源回读，禁止重置额度或重新绑定。',
    '禁止自行控制所有桌面应用；obsidian-cli 的截图、eval 及其他原生观察同样需要用户明确授权。原 PDF 图片可通过文件工具检查。原生验收状态与已发生的电脑操作分别据实报告，缺失记录保持未知。保留首次派发、续接和预留的执行账本，未知结果先核对，不自动重派。',
    stageGuidance[id][1],
    '保留结论对应的证据位置、关键条件与研究限制、未完成事项和真实任务句柄。未知信息明确标为未知，区分已接受、待审查和未运行；以下 null 同样表示未知。',
    '以下为实际恢复锚点，仅包含元数据；保留路径与指纹，正文和角色全文留在产物中，需要时按下一步范围回读。',
    JSON.stringify(metadata),
    '压缩后沿原 Controller 进程继续：先核对原进程、任务状态和最新检查点，已派发任务先协调实际结果，避免重复派发。',
  ].join('\n\n');
}

export function createCompactionPolicy() {
  return { profile: COMPACTION_POLICY };
}

export function compactionEnabled(binding) {
  return binding?.compaction_policy?.profile === COMPACTION_POLICY;
}

/** The reminder shown once per stage boundary; the session pauses and continues on the user's next reply. */
export function compactionReminder(id, continuation) {
  if (!stageGuidance[id]) throw Object.assign(new Error('APA_COMPACTION_BOUNDARY_INVALID'), { code: 'APA_COMPACTION_BOUNDARY_INVALID' });
  const compaction_prompt = stageCompactionPrompt(id, continuation);
  const message = `已到达 ${stageGuidance[id][0]}，进入下一阶段前请压缩上下文。状态已保存；压缩后回复继续。\n\n可复制的阶段压缩提示词：\n\n\`\`\`text\n${compaction_prompt}\n\`\`\``;
  return { boundary_id: id, message, compaction_prompt };
}
