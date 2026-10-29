// Read-only interpretation of the current agent's evidence. Never invokes a host or applies settings.
import { inspectAchievement, inspectAdapters } from './apa-host-achievement.mjs';

const checks = [
  ['on_demand_reading', '按需读取', '核对文件读取工具与技能入口；实际运行时检查是否只读取所需范围。'],
  ['delegated_diagnostics', '子代理排查', '核对当前派发工具、独立上下文及返回方式；真实派发另行验证。'],
  ['manual_compaction', '阶段压缩', '核对本会话的手动压缩入口、作用范围及是否改变持久设置。'],
  ['concise_replies', '短回执', '核对请求携带 role-reply-1.0，实际回复是否遵守须在真实运行中观察。'],
  ['science_recovery', '科学阶段恢复', '核对真实任务句柄、查询或等待工具及参数；在原宿主仍可访问时验证退出续接。'],
  ['threshold_compaction', '阈值自动压缩', '核对安装版本、有效配置后端、计量口径及容量；获批实测时记录触发事件与压缩后信息保留。'],
];
const limited = row => { if (row.status === 'detected') row.status = 'conditional'; };

function inspectThreshold(row, input) {
  row.threshold = { ...(input ?? {}), candidate_value: null, effective_trigger_tokens: null, feasibility: 'unknown' };
  if (['blocked', 'unsupported', 'unknown'].includes(row.status)) return;
  if (input?.effective_target_verified === false) {
    row.status = 'blocked';
    row.limitations.push('覆盖未命中实际启用的压缩后端；不能仅凭字段存在或参数被接受判定可行。');
    return;
  }
  const required = ['candidate_tokens', 'context_window_tokens', 'output_reserve_tokens', 'headroom_tokens', 'retained_tokens'];
  if (!input || required.some(key => !Number.isInteger(input[key])) || !input.setting?.trim() || !input.measurement?.trim() || input.unit === 'unknown' || !input.formula || input.formula === 'unknown' || input.effective_target_verified !== true) {
    limited(row);
    row.limitations.push('候选阈值、容量、输出预留、余量、保留预算、公式、计量口径或有效覆盖目标尚未全部核实。未知项不能按零处理。');
    return;
  }
  const { candidate_tokens: target, context_window_tokens: window, output_reserve_tokens: output, headroom_tokens: headroom, retained_tokens: retained, unit } = input;
  if (input.formula === 'absolute' && unit !== 'tokens' || input.formula === 'window-ratio-bounded' && !['ratio', 'percent'].includes(unit)) {
    row.status = 'blocked';
    row.limitations.push('档案中的阈值单位与已核实公式不一致，不能计算可行值。');
    return;
  }
  const ceiling = window - output - headroom;
  row.threshold.candidate_value = unit === 'tokens' ? target : target / window * (unit === 'percent' ? 100 : 1);
  const fraction = row.threshold.candidate_value / (unit === 'percent' ? 100 : 1);
  // Only evaluate the formula explicitly identified in the host evidence; never infer it from a host name.
  row.threshold.effective_trigger_tokens = input.formula === 'absolute' ? target : Math.floor(Math.min(window * fraction, ceiling));
  const trigger = row.threshold.effective_trigger_tokens;
  const rangeKnown = Number.isFinite(input.setting_min) && Number.isFinite(input.setting_max);
  const inRange = !rangeKnown || input.setting_min <= row.threshold.candidate_value && row.threshold.candidate_value <= input.setting_max;
  const possible = target <= ceiling && retained < trigger && trigger === target && inRange;
  row.threshold.feasibility = possible ? 'within-reported-limits' : 'incompatible';
  if (!possible) {
    row.status = 'blocked';
    row.limitations.push('候选阈值超出容量或宿主参数范围、保留预算不小于触发值，或公式取整后无法达到精确目标；不得自动更换模型或修改其他设置。');
  } else if (!rangeKnown) {
    limited(row);
    row.limitations.push('宿主允许的参数范围尚未全部核实。');
  }
  row.limitations.push('计算只使用档案报告的上限；宿主公式、取整与 token 口径须另行核对，实际自动触发仍未验证。');
}

export function inspectHostCapabilities(config, profile, repoRoot = process.cwd()) {
  const adapters = inspectAdapters(repoRoot, profile);
  const rows = checks.map(([id, label, nextCheck]) => {
    const input = profile?.capabilities?.[id];
    const row = {
      id, label, status: input?.status ?? 'unknown', method: input?.method ?? null, scope: input?.scope ?? 'unknown',
      evidence: structuredClone(input?.evidence ?? []), limitations: [...(input?.limitations ?? [])], next_check: nextCheck,
    };
    if (input && !row.evidence.length) {
      row.status = 'unknown';
      row.limitations.push('档案没有提供可核查的依据。');
    }
    if (!input && id === 'delegated_diagnostics' && profile?.sources?.dispatch === 'tool-schema') {
      row.status = profile.dispatch ? 'detected' : 'unsupported';
      row.method = profile.dispatch ? `${profile.dispatch.tool}；任务参数 ${profile.dispatch.instruction_argument}` : null;
      row.scope = 'current-session';
      row.evidence.push({ source: 'tool-schema', reference: profile.dispatch?.tool ?? '当前工具列表未发现独立派发工具' });
    }
    if (row.status === 'detected' && (!row.method?.trim() || row.scope === 'unknown')) limited(row);
    if (['on_demand_reading', 'concise_replies'].includes(id)) {
      limited(row);
      row.limitations.push('这是依赖宿主与模型遵守的执行规则；静态检测不能证明实际遵守。');
    }
    if (id === 'science_recovery') {
      limited(row);
      if (input?.recovery) row.recovery = structuredClone(input.recovery);
      row.limitations.push('本地状态恢复仅覆盖 Controller 进程退出且原宿主仍可访问；不会自动查询或等待宿主任务。');
      if (config.host?.dispatch?.result_handle) {
        row.limitations.push('当前已配置 host 的请求按 dispatch.result_handle 从结果文本提取真实任务句柄；提取不到时记为 null 并在观察记录说明，实际续接尚未在真实运行中验证。');
        row.evidence.push({ source: 'local-code', reference: 'scripts/apa-model-policy.mjs:extractHostTaskHandle; scripts/v3/phase21-runner.mjs:ingestObservedRunStep' });
      } else if (config.host) {
        row.status = 'blocked';
        row.limitations.push('当前已配置 host 的请求将 result_bindings.agent_id 设为 null；本地 action_id 不等于可查询的真实宿主任务句柄，自动续接适配尚未完成。');
        row.evidence.push({ source: 'local-code', reference: 'scripts/v3/configured-reading.mjs:createConfiguredScienceRequest; scripts/v3/phase21-runner.mjs:ingestObservedRunStep' });
      } else if (!input?.recovery?.task_handle_path || !input?.recovery?.lookup_tool || !input?.recovery?.lookup_argument || input?.recovery?.original_host_accessible !== true) {
        row.limitations.push('真实任务句柄路径、查询工具及参数或原宿主可访问性尚未全部核实。');
      }
    }
    if (id === 'threshold_compaction') inspectThreshold(row, input?.threshold);
    if (id === 'on_demand_reading') row.apa_support = ['APA Controller 要求按需读取所需范围。'];
    if (id === 'concise_replies') row.apa_support = ['配置化运行使用 role-reply-1.0 短回执合同。'];
    row.achievement = inspectAchievement(row, input, config, profile, adapters);
    return row;
  });
  return { host: profile?.host ?? null, detected_at: profile?.detected_at ?? null, runtime_validation: 'not_run', adapters, checks: rows };
}
