export const REQUIRED_SEARCH_SOURCES = Object.freeze(['tool-schema', 'system-context', 'host-config', 'runtime-log', 'installed-software', 'local-code', 'host-docs']);
const CATEGORIES = ['investigate', 'page-choice', 'authorize', 'known-limit'];
const LIMIT_STATUSES = ['blocked', 'unsupported', 'unknown'];

export function investigationGaps(capability) {
  const covered = new Set((capability?.investigation?.searched ?? [])
    .filter(item => item.result === 'not-applicable' || typeof item.location === 'string' && item.location.trim())
    .map(item => item.source));
  return REQUIRED_SEARCH_SOURCES.filter(source => !covered.has(source));
}

export function deriveSetupIssues(inspection, hostProfile) {
  const issues = [];
  const add = (category, kind, key, summary, detail) => issues.push({ id: `${category}:${kind}:${key}`, category, subject: key, summary, ...(detail ? { detail } : {}) });
  if (!hostProfile) add('investigate', 'host', 'no-profile', '没有提供宿主档案，宿主能力未检测。');
  const hostCheck = inspection.host_check;
  if (hostCheck && hostCheck.host !== 'match') add('page-choice', 'host', hostCheck.host, hostCheck.host === 'differs' ? '已保存的宿主声明与本次检测不一致。' : '尚未保存宿主声明。');
  for (const item of hostCheck?.issues ?? []) add('page-choice', 'host-issue', `${item.key}:${item.issue}`, `模型选择与宿主检测不符：${item.issue}${item.model ? `（${item.model}）` : ''}。`);
  for (const key of inspection.validation?.missing ?? []) add('page-choice', 'missing', key, `配置项 ${key} 尚未回答。`);
  for (const text of inspection.validation?.conflicts ?? []) add('page-choice', 'conflict', text.split(' ')[0], text);
  for (const item of inspection.dependencies ?? []) if (item.status !== 'available') add('authorize', 'dependency', item.key, `依赖 ${item.key} 状态为 ${item.status}：${item.path}`);
  if (hostProfile) for (const check of inspection.capability_check?.checks ?? []) {
    const input = hostProfile.capabilities?.[check.id];
    const achievement = check.achievement ?? input?.achievement;
    // The checker appends this phrase when the agent's own achievement lacks verifiable grounds.
    const redetect = /需要重新检测/.test(achievement?.summary ?? '') && !/需要重新检测/.test(input?.achievement?.summary ?? '');
    const unresolved = check.status === 'unknown' || achievement?.state === 'not-found' || input?.achievement?.state === 'not-found';
    const gaps = investigationGaps(input);
    const steps = achievement?.steps ?? [];
    if (!input?.achievement || redetect || unresolved && gaps.length) add('known-limit', 'capability', check.id, `${check.label ?? check.id} 尚未完成调查。`, gaps);
    else if (steps.some(step => step.actor === 'user')) add('page-choice', 'capability', check.id, achievement.summary);
    else if (achievement.state === 'needs-apa-change' || steps.some(step => step.persistent)) add('authorize', 'capability', check.id, achievement.summary);
    else if (['needs-setting', 'needs-user-action'].includes(achievement.state)) add('page-choice', 'capability', check.id, achievement.summary);
    else if (unresolved || LIMIT_STATUSES.includes(check.status)) add('known-limit', 'capability', check.id, achievement.summary);
  }
  return issues
    .map((item, index) => ({ item, index }))
    .sort((a, b) => CATEGORIES.indexOf(a.item.category) - CATEGORIES.indexOf(b.item.category) || a.index - b.index)
    .map(({ item }) => item);
}

export function checkPageGate(issues, { ledger, profileSha256 } = {}) {
  if (ledger && ledger.profile_sha256 !== profileSha256) return { ok: false, code: 'APA_ISSUE_LEDGER_STALE', pending: [] };
  return { ok: true, pending: [] };
}
