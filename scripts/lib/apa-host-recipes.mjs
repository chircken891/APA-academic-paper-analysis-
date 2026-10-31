// Pure data: how each host capability can be achieved. Never invokes a host or writes settings.
// States describe the path only; runtime validation stays not_run until a real run leaves evidence.
const CLAUDE_RESULT_HANDLE = { source: 'text', pattern: 'agentId:\\s*([A-Za-z0-9_-]+)' };
const CLAUDE_RANGE ={ min: 100000, max: 1000000, unit: 'tokens' };
const evidenceNeeded = {
  on_demand_reading: '文件读取工具、技能入口及其读取范围的工具清单或文档依据',
  delegated_diagnostics: '派发工具名、任务参数、独立上下文与返回方式的工具清单依据',
  manual_compaction: '手动压缩入口、作用范围及是否改变持久设置的文档或实测依据',
  concise_replies: '请求能否携带 role-reply-1.0 及回执长度的观察方式',
  science_recovery: '真实任务句柄的取得路径、查询或续接工具及参数、原宿主可访问性',
  threshold_compaction: '自动压缩阈值的配置入口、计量口径、允许范围及有效后端',
};

const step = (actor, instruction, { command = null, scope = 'current-session', persistent = false, verify, range } = {}) => ({
  actor, instruction, command, scope, persistent, verify, ...(range ? { range } : {}),
});
const result = (state, summary, steps = []) => ({ state, summary, steps });
const fill = (template, tokens) => template.replaceAll('<N>', Number.isInteger(tokens) ? String(tokens) : '<N>');
// A user-given value is used only when it is inside the host range; otherwise the placeholder stays.
const chosen = (profile, range, row) => {
  if (row?.threshold?.feasibility === 'incompatible') return null;
  const value = profile?.capabilities?.threshold_compaction?.threshold?.candidate_tokens;
  if (!Number.isInteger(value)) return null;
  if (Number.isInteger(range.min) && value < range.min) return null;
  if (Number.isInteger(range.max) && value > range.max) return null;
  return value;
};

const incompatible = row => row?.threshold?.feasibility === 'incompatible' ? '档案中记录的候选值与容量或允许范围不兼容，须由用户在允许范围内重新输入数值。' : '';
const apaRule = (what, verify) => result('achieved', `APA 规则已内置：${what}；这只说明达成路径，实际遵守须在真实运行中观察。`, [
  step('apa', what, { scope: 'new-session', verify }),
]);

// Evidence-dependent rows are achieved only when the row is neither blocked nor unknown.
const redetect = (label, row) => result('needs-user-action', `${label}的检测依据不足（当前状态 ${row.status ?? 'unknown'}）；先重新检测，再评估达成方式。`, [
  step('user', '重新运行 apa-setup 检测当前宿主，并提供该能力的工具清单或文档依据。', { command: 'npm run apa:setup -- inspect', verify: '重新检测后该能力状态不再是 blocked 或 unknown。' }),
]);
const evidenceMissing = row => ['blocked', 'unknown'].includes(row.status);

function common(id, row) {
  if (id === 'on_demand_reading') return evidenceMissing(row) ? redetect('按需读取', row) : apaRule('Controller 预算一节要求按需读取，不整篇灌入上下文', '下次运行记录 Controller 读取范围，核对是否只读取所需部分。');
  if (id === 'delegated_diagnostics') return evidenceMissing(row) ? redetect('子代理排查', row) : result('achieved', '当前宿主的派发工具可直接使用；需要只读排查时派发子代理。', [
    step('apa', `使用宿主派发工具${row.method ? `（${row.method}）` : ''}派发只读排查，不扩大文件范围。`, { verify: '真实派发一次只读排查，确认任务能返回结果。' }),
  ]);
  if (id === 'concise_replies') return apaRule('新配置化运行已冻结 role-reply-1.0，要求角色回执简短', '下次运行统计各角色回执字节，核对是否简短。');
  return null;
}

function claudeCode(id, row, profile, savedHost) {
  const shared = common(id, row);
  if (shared) return shared;
  if (id === 'manual_compaction') return result('needs-user-action', '压缩需用户在 Claude Code 会话中执行 /compact；新 APA 1.2 运行冻结该宿主档案中已检测且有依据的入口，四个安全边界保存状态后均推荐压缩，由用户决定压缩或跳过。压缩后的运行状态可由可选的 SessionStart 钩子自动重新注入（安装前预览，经确认才写入）。', [
    step('apa', '在 APA 安全边界由 Controller 输出可复制的阶段压缩提示词，包含可用的运行身份、预算期限和恢复路径，并要求保留阶段结果、下一步、关键证据与限制；角色模型策略按绑定路径回读。', { verify: '边界处看到完整的保留说明文本。' }),
    step('user', '把 Controller 给出的文本粘贴到会话并执行；压缩后若上下文缺少运行状态，再按 checkpoint 路径恢复。', { command: '/compact 保留 APA 运行 <run_id>：…', verify: '压缩完成后询问当前运行的下一步，确认运行状态仍在。' }),
    step('script', '可选：预览把只读钩子（SessionStart、matcher compact，运行 scripts/setup/apa-compact-context.mjs，命令经 $CLAUDE_PROJECT_DIR 定位，超时 10 秒）加入已被 git 忽略的项目 .claude/settings.json；确认后用 apply --confirm 写入，不保留备份，已有钩子与其他键保持不变。', { command: 'node scripts/setup/apa-host-settings.mjs plan --host claude-code --capability compact_hook --scope project', scope: 'project-settings', persistent: true, verify: '真实压缩后的注入效果为 not_run，须在下次获批运行中观察；新会话后确认 .claude/settings.json 的 hooks.SessionStart 含 matcher compact。' }),
  ]);
  if (id === 'science_recovery') {
    // Achieved only when the saved host segment, which new runs actually freeze, carries the handle; a detected profile alone is not enough.
    if (savedHost?.dispatch?.result_handle) return result('achieved', 'APA 已按本库已保存 host 段的 dispatch.result_handle 从 Agent 派发结果文本提取 agentId。这只说明达成路径，实际续接须在真实运行中观察。', [
      step('apa', '新配置化运行按 result_handle 从 Agent 结果文本提取 agentId，记入观察记录的 agent_id；续接时用 SendMessage({to: agentId})。提取不到时 agent_id 记为 null，host_task_handle_status 写明 not_found_in_result_text。', { scope: 'new-session', verify: '新配置化运行的观察记录中 agent_id 为真实句柄、host_task_handle_status 为 extracted；原会话可访问时可续接。已绑定的旧运行不受影响。' }),
    ]);
    if (profile?.dispatch?.result_handle) return result('needs-user-action', '检测到的宿主档案记录了 dispatch.result_handle，但本库已保存的 host 段没有；新运行按已保存的 host 段派发，不会提取任务句柄，须先保存检测到的 host 段。', [
      step('user', '通过 apa-setup 把检测到的 host 段（含 dispatch.result_handle）保存到本库配置；保存前核对差异并确认应用。', { command: 'npm run apa:setup -- inspect', scope: 'new-session', persistent: true, verify: '保存后重新 inspect：配置中的 host.dispatch.result_handle 存在，host_check.host 为 match，且科学阶段恢复为 achieved。' }),
    ]);
    return result('needs-user-action', '宿主档案的 dispatch 没有记录 result_handle，APA 无从提取 Agent 任务句柄；重新检测后才能续接科学阶段。', [
      step('user', `重新运行 apa-setup 检测，让宿主档案的 dispatch 记录 result_handle（Claude Code 为 ${JSON.stringify(CLAUDE_RESULT_HANDLE)}，JSON 写法），再把检测到的 host 段保存到本库配置。`, { command: 'npm run apa:setup -- inspect', scope: 'new-session', verify: 'inspect 的 host_check.host 为 match，且 capability_check 中科学阶段恢复为 achieved。' }),
    ]);
  }
  if (id === 'threshold_compaction') {
    const value = chosen(profile, CLAUDE_RANGE, row);
    const range = CLAUDE_RANGE;
    const scale = '数值由用户选择，范围 100000–1000000 token（不是比例，超过模型窗口按窗口截断）；越小压缩越早、保留的上下文越少。';
    return result('needs-user-action', `阈值由用户选择并执行，APA 不预设数值；以下方式依据官方文档（未实测）。${incompatible(row)}${value === null ? '尚未给出有效数值，命令保留 <N>。' : ''}`, [
      step('user', `在会话中输入 /autocompact 立即生效并存入用户设置。${scale}桌面端是否支持该命令待用户试一次确认。`, { command: fill('/autocompact <N>', value), scope: 'current-session', persistent: true, range, verify: '输入后宿主应确认已设置；不确认则改用下一种方式。' }),
      step('user', `单次启动不写设置。${scale}`, { command: fill('claude --autocompact <N>', value), scope: 'new-session', range, verify: '以官方文档或本机 `claude --help` 核实该参数。' }),
      step('script', `只对本项目持久：脚本预览后，经确认写入已被 git 忽略的 .claude/settings.json 的 autoCompactWindow；新会话生效。${scale}`, { command: fill('node scripts/setup/apa-host-settings.mjs plan --host claude-code --capability threshold_compaction --scope project --tokens <N>', value), scope: 'project-settings', persistent: true, range, verify: '新开会话后检查 autoCompactWindow 已为所选值；优先级低于环境变量 CLAUDE_CODE_AUTO_COMPACT_WINDOW（2.1.278 只接受纯数字 token）与 /autocompact。' }),
      step('script', '对所有项目持久：同样经脚本预览、确认后写入 ~/.claude/settings.json 的 autoCompactWindow；影响所有项目，不作为默认选择。', { command: fill('node scripts/setup/apa-host-settings.mjs plan --host claude-code --capability threshold_compaction --scope user --tokens <N>', value), scope: 'user-settings', persistent: true, range, verify: '确认用户设置中该键只在你明确同意的值上。' }),
    ]);
  }
  return null;
}

function codex(id, row, profile) {
  if (id === 'science_recovery') return result('needs-apa-change', 'APA 的配置 host 请求只在档案声明 dispatch.result_handle 时提取任务句柄，否则把 result_bindings.agent_id 写为 null；Codex 的真实任务句柄绑定补进代码前不能续接科学阶段。', [
    step('apa', '让配置 host 请求写入 Codex 派发返回的真实任务句柄到 result_bindings.agent_id；取不到时记为 null 并在运行记录说明。', { scope: 'new-session', verify: '新配置化运行的请求记录中 result_bindings.agent_id 为真实句柄；原宿主可访问时可续接。' }),
  ]);
  if (id === 'manual_compaction') return result('needs-user-action', '阶段压缩由用户使用 Codex 已核实的手动入口执行；新 APA 1.2 运行仅冻结该宿主自身有依据的入口，在四个安全边界保存状态后均推荐压缩，由用户决定压缩或跳过；入口未知时说明未知。', [
    step('apa', '在 APA 安全边界由 Controller 输出可复制的阶段压缩提示词，包含可用的运行身份、预算期限和恢复路径，并要求保留阶段结果、下一步、关键证据与限制；角色模型策略按绑定路径回读。', { verify: '边界处看到完整的保留说明文本。' }),
    step('user', '在当前 Codex 宿主确认手动压缩入口（如 /compact）可用，并把文本交给它；入口名称以本机帮助为准。', { command: '/compact', verify: '压缩后询问当前运行的下一步，确认运行状态仍在。' }),
  ]);
  if (id === 'threshold_compaction') {
    const window = profile?.capabilities?.threshold_compaction?.threshold?.context_window_tokens;
    const range = { min: null, max: Number.isInteger(window) ? window : null, unit: 'tokens' };
    const value = chosen(profile, range, row);
    const scale = `数值由用户选择，不超过检测到的模型窗口${Number.isInteger(window) ? `（${window}）` : '（尚未检测到）'}；窗口为 258400 的模型余量很小；越小压缩越早、保留的上下文越少。现有桌面会话不受影响，须新开会话。`;
    return result('needs-user-action', `阈值由用户选择并执行，APA 不预设数值；键名有效性须先用 codex --strict-config 核验，核验前不标为已达成。${incompatible(row)}${value === null ? '尚未给出有效数值，命令保留 <N>。' : ''}`, [
      step('user', `单次启动传入配置。${scale}`, { command: fill('codex -c model_auto_compact_token_limit=<N>', value), scope: 'new-session', range, verify: '加 --strict-config 启动，键名无效会报错；有效后再依赖该方式。' }),
      step('script', `持久：脚本预览后，经确认写入 ~/.codex/config.toml 的 model_auto_compact_token_limit。${scale}`, { command: fill('node scripts/setup/apa-host-settings.mjs plan --host codex --capability threshold_compaction --scope user --tokens <N>', value), scope: 'user-settings', persistent: true, range, verify: '新开会话后检查该键为所选值，并以 --strict-config 启动无报错。' }),
    ]);
  }
  return common(id, row);
}

const recipes = { 'claude-code': claudeCode, 'codex-desktop': codex, 'codex-cli': codex };

export function achievementFor(host, capabilityId, row, profile, savedHost) {
  const build = recipes[host];
  if (!build) {
    return result('unavailable', `宿主${host ? ` ${host}` : '尚未确定，'}没有内置配方，不借用其他宿主的做法；需要的检测证据：${evidenceNeeded[capabilityId] ?? '该能力的宿主依据'}。`);
  }
  if (row?.status === 'unsupported') return result('unavailable', '检测结果显示当前宿主不支持该能力；需先取得新的宿主证据再评估。');
  return build(capabilityId, row ?? {}, profile ?? null, savedHost ?? null) ?? result('unavailable', `没有该能力的配方；需要的检测证据：${evidenceNeeded[capabilityId] ?? '该能力的宿主依据'}。`);
}
