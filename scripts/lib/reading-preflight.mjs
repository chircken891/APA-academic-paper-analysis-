// Runtime evidence is supplied by the current host; it is never saved as configuration.
export function evaluateReadingPreflight({ inspection, hostProfile, evidence = {} } = {}) {
  const checks = [];
  const add = (id, status, reason) => checks.push({ id, status, reason });
  const ref = item => typeof item?.reference === 'string' && !!item.reference.trim();
  const observed = (id, item) => add(id, item?.status === 'blocked' ? 'blocked' : item?.status === 'pass' && ref(item) ? 'pass' : 'unknown', item?.status === 'blocked' ? `${id} failed` : item?.status === 'pass' && ref(item) ? `${id} verified` : `${id} evidence missing`);
  add('configuration', !inspection?.validation ? 'unknown' : inspection.validation.complete ? 'pass' : 'blocked', 'configuration completeness');
  add('dependencies', !Array.isArray(inspection?.dependencies) ? 'unknown' : inspection.dependencies.some(item => item.status !== 'available') ? 'blocked' : 'pass', 'selected dependencies');
  const host = evidence.current_host;
  const match = inspection?.host_check?.host;
  add('host', !hostProfile || !ref(host) || !host?.name ? 'unknown' : host.name !== hostProfile.host || match === 'differs' ? 'blocked' : match === 'match' ? 'pass' : 'unknown', 'current host and saved declaration');
  const dispatch = evidence.dispatch;
  add('dispatch', hostProfile && !hostProfile.dispatch && hostProfile.sources?.dispatch === 'tool-schema' ? 'blocked' : !hostProfile?.dispatch || !ref(dispatch) || dispatch?.source !== 'tool-schema' ? 'unknown' : dispatch.tool === hostProfile.dispatch.tool && hostProfile.sources?.dispatch === 'tool-schema' ? 'pass' : 'blocked', 'current dispatch tool schema');
  const fresh = evidence.fresh_context;
  const expected = hostProfile?.dispatch?.fresh_context;
  const freshValid = ref(fresh) && (expected ? fresh.source === 'tool-schema' && fresh.argument === expected.argument && JSON.stringify(fresh.value) === JSON.stringify(expected.value) : fresh?.source === 'host-docs' && fresh.blank_context === true);
  add('fresh_context', freshValid ? 'pass' : 'unknown', 'independent context evidence');
  const choices = [inspection?.config?.models?.science, ...Object.values(inspection?.config?.models?.overrides ?? {}), ...Object.values(inspection?.config?.models?.roles ?? {})].filter(Boolean);
  let models = 'pass';
  if (!hostProfile || !choices.length || (!hostProfile.sources?.models || hostProfile.sources.models === 'unavailable') && choices.some(c => c.mode === 'explicit')) models = 'unknown';
  else for (const choice of choices) {
    if (choice.mode === 'follow-main') {
      if (!hostProfile.session?.model || !hostProfile.sources?.session || hostProfile.sources.session === 'unavailable') models = 'unknown';
      else if (hostProfile.dispatch?.model_argument !== null) {
        const found = hostProfile.models?.find(item => item.model === hostProfile.session.model);
        if (!hostProfile.sources?.models || hostProfile.sources.models === 'unavailable' || !hostProfile.models?.length) models = 'unknown';
        else if (!found || (hostProfile.session.reasoning_effort ? !found.reasoning_efforts.includes(hostProfile.session.reasoning_effort) : found.reasoning_efforts.length > 0)) { models = 'blocked'; break; }
      }
    } else if (choice.mode === 'explicit') {
      const found = hostProfile.models?.find(item => item.model === choice.model);
      if (!hostProfile.models?.length) models = 'unknown';
      else if (!found || hostProfile.dispatch?.model_argument === null || choice.reasoning_effort && (hostProfile.dispatch?.effort_argument === null || !found.reasoning_efforts.includes(choice.reasoning_effort)) || !choice.reasoning_effort && found.reasoning_efforts.length) { models = 'blocked'; break; }
    }
  }
  if (inspection?.host_check?.issues?.some(issue => issue.key !== 'models.query')) models = 'blocked';
  add('models', models, 'model and reasoning effort availability');
  for (const id of ['file_read', 'control_write', 'input']) observed(id, evidence[id]);
  const status = checks.some(item => item.status === 'blocked') ? 'blocked' : checks.some(item => item.status === 'unknown') ? 'unknown' : 'pass';
  return { status, checks, reasons: checks.filter(item => item.status !== 'pass').map(item => `${item.id}: ${item.reason}`) };
}
