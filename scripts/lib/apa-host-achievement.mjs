import fs from 'node:fs';
import path from 'node:path';
import { validHostDispatch } from '../apa-model-policy.mjs';

const within = (root, target) => {
  const rel = path.relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};
const normalized = value => process.platform === 'win32' ? value.toLowerCase() : value;
const canonical = value => JSON.stringify(value, (key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

// Check declared files without reading or executing an adapter.
export function inspectAdapters(repoRoot, profile) {
  const adapters = profile?.adapters ?? [];
  return adapters.map(adapter => {
    const issues = [];
    const expected = `config/backups/${adapter.owner}/adapters/${adapter.id}`;
    if (adapter.host !== profile.host) issues.push('补丁宿主与当前档案不一致。');
    if (adapters.filter(item => item.id === adapter.id).length !== 1) issues.push('补丁标识重复。');
    if (adapter.root !== expected) issues.push('补丁目录与声明的 owner 和 id 不一致。');
    if (!issues.length) {
      try {
        const repository = fs.realpathSync(repoRoot);
        const root = fs.realpathSync(path.resolve(repoRoot, expected));
        const canonicalRoot = path.resolve(repository, expected);
        if (normalized(root) !== normalized(canonicalRoot)) issues.push('补丁目录的真实路径超出声明目录。');
        for (const entry of adapter.entrypoints) {
          const portableEntry = entry.replaceAll('\\', '/');
          if (path.isAbsolute(entry) || path.win32.isAbsolute(entry) || !within(path.resolve(repoRoot, expected), path.resolve(repoRoot, expected, portableEntry))) {
            issues.push(`入口路径越界：${entry}`);
            continue;
          }
          try {
            const actual = fs.realpathSync(path.resolve(root, portableEntry));
            if (!within(root, actual) || !fs.statSync(actual).isFile()) issues.push(`入口真实路径越界或不是文件：${entry}`);
          } catch { issues.push(`入口不存在或无法读取：${entry}`); }
        }
      } catch { issues.push('补丁目录不存在或无法读取。'); }
    }
    return { ...structuredClone(adapter), status: issues.length ? 'blocked' : 'available', issues };
  });
}

// Extraction uses the first capture group; a pattern without one cannot return a handle.
function hasCapture(pattern) {
  let inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '\\') { index += 1; continue; }
    if (char === '[') { inClass = true; continue; }
    if (char === ']') { inClass = false; continue; }
    if (!inClass && char === '(' && (pattern[index + 1] !== '?' || pattern[index + 2] === '<' && !['=', '!'].includes(pattern[index + 3]))) return true;
  }
  return false;
}

function recoveryReady(config, profile, row) {
  const saved = config?.host;
  const detected = profile?.dispatch ? { name: profile.host, dispatch: profile.dispatch } : null;
  const recovery = row.recovery;
  return Boolean(saved && detected && canonical(saved) === canonical(detected)
    && validHostDispatch(saved.dispatch) && saved.dispatch.result_handle && hasCapture(saved.dispatch.result_handle.pattern)
    && ['task_handle_path', 'lookup_tool', 'lookup_argument'].every(key => typeof recovery?.[key] === 'string' && recovery[key].trim())
    && recovery.original_host_accessible === true);
}

// Consume the agent's declaration; do not infer a method from the host name.
export function inspectAchievement(row, input, config, profile, adapters) {
  if (!input?.achievement) return { state: 'needs-user-action', summary: '代理未提供达成方式，需要重新检测。', steps: [] };
  const result = structuredClone(input.achievement);
  const reasons = [];
  const evidence = row.evidence.length || result.steps.some(step => step.evidence.length);
  if (result.state === 'achieved' && (!evidence || !input.method?.trim() || input.scope === 'unknown' || ['blocked', 'unknown', 'unsupported'].includes(row.status))) reasons.push('能力状态或可核查依据不足，需要重新检测。');
  if (result.state === 'achieved' && result.steps.some(step => !step.evidence.length)) reasons.push('达成步骤缺少可核查依据，需要重新检测。');
  if (result.state === 'not-found' && !evidence && !input.limitations.some(value => value.trim())) reasons.push('未找到的结论缺少调查依据，需要重新检测。');
  if (result.state === 'achieved' && row.id === 'science_recovery' && !recoveryReady(config, profile, row)) reasons.push('科学阶段恢复需要保存与档案一致的宿主派发声明、有效任务句柄及完整查询和原宿主可访问信息。');
  if (row.id === 'threshold_compaction' && input.threshold?.effective_target_verified === false) {
    for (const step of result.steps) step.command = null;
    reasons.push('阈值设置未命中有效后端，已屏蔽全部命令。');
  }
  for (const step of result.steps) {
    if (row.id === 'threshold_compaction' && step.command && (!step.range || !step.command.includes('<N>'))) {
      step.command = null;
      reasons.push('阈值命令必须提供参数范围与 <N> 模板，已屏蔽命令。');
    }
    if (!step.range && step.command?.includes('<N>')) {
      step.command = null;
      reasons.push('含 <N> 模板的命令缺少参数范围，已屏蔽命令。');
    }
    if (step.range && step.command && !step.command.includes('<N>')) {
      step.command = null;
      reasons.push('含范围的命令必须使用 <N> 模板，已屏蔽命令。');
    }
    if (step.adapter_id && !adapters.some(adapter => adapter.id === step.adapter_id && adapter.status === 'available')) {
      step.command = null;
      reasons.push(`补丁 ${step.adapter_id} 未声明或不可用，已屏蔽命令。`);
    }
  }
  if (reasons.length) {
    result.state = 'needs-user-action';
    result.summary = `${result.summary} ${[...new Set(reasons)].join(' ')}`;
  }
  return result;
}
