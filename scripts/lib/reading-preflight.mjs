import { statSync } from 'node:fs';
import { resolve } from 'node:path';

// Runtime evidence is supplied by the current host; it is never saved as configuration.
export function evaluateReadingPreflight({ inspection, hostProfile, evidence = {}, instructionProfile } = {}) {
  const checks = [];
  const add = (id, status, reason) => checks.push({ id, status, reason });
  const ref = item => typeof item?.reference === 'string' && !!item.reference.trim();
  const observed = (id, item) => add(id, item?.status === 'blocked' ? 'blocked' : item?.status === 'pass' && ref(item) ? 'pass' : 'unknown', item?.status === 'blocked' ? `${id} failed` : item?.status === 'pass' && ref(item) ? `${id} verified` : `${id} evidence missing`);
  const configProblems = ['missing', 'conflicts', 'errors'].flatMap(key => inspection?.validation?.[key] ?? []).map(String);
  const dependencyProblems = (inspection?.dependencies ?? []).filter(item => item.status !== 'available').map(item => `${item.key}=${item.status}`);
  add('configuration', !inspection?.validation ? 'unknown' : inspection.validation.complete ? 'pass' : 'blocked', configProblems.length ? configProblems.join('; ') : 'configuration completeness');
  add('dependencies', !Array.isArray(inspection?.dependencies) ? 'unknown' : dependencyProblems.length ? 'blocked' : 'pass', dependencyProblems.length ? dependencyProblems.join('; ') : 'selected dependencies');
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
  if (instructionProfile === 'configured-reading-2.2') {
    const tools = evidence.results_tools ?? {};
    const selectedPython = inspection?.dependencies?.find(item => item.key === 'parser.python');
    const pythonMatches = item => {
      if (!selectedPython || selectedPython.status !== 'available' || typeof item.path !== 'string') return false;
      try {
        const normalize = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
        return normalize(item.path) === normalize(selectedPython.path) && statSync(item.path).isFile();
      } catch { return false; }
    };
    for (const [id, item, valid, missing] of [
      ['results_python', tools.python, pythonMatches, 'selected parser Python path or file unavailable/mismatched'],
      ['results_libraries', tools.libraries, item => Array.isArray(item.names) && item.names.length > 0 && item.names.every(name => typeof name === 'string' && name.trim()) && item.names.includes('fitz'), 'fitz library evidence missing'],
      ['results_visual_read', tools.visual_read, () => true, 'visual reading evidence missing'],
      ['results_file_read', tools.file_read, () => true, 'file reading evidence missing'],
    ]) {
      const supported = item && ['observed', 'tool-declaration'].includes(item.source) && ref(item) && typeof item.method === 'string' && !!item.method.trim() && typeof item.observation === 'string' && !!item.observation.trim() && valid(item);
      add(id, item?.status === 'blocked' ? 'blocked' : item?.status === 'pass' && supported ? 'pass' : 'unknown', item?.status === 'blocked' ? `${id} unavailable` : supported && item?.status === 'pass' ? `${id} supported by ${item.source}` : `${missing} or source/reference/method/observation missing`);
      checks.at(-1).route = 'setup';
    }
  }
  for (const check of checks) if (check.status !== 'pass' && !check.route) check.route = ['configuration', 'dependencies', 'host', 'dispatch', 'fresh_context', 'models', 'file_read'].includes(check.id) ? 'setup' : 'engineering';
  const status = checks.some(item => item.status === 'blocked') ? 'blocked' : checks.some(item => item.status === 'unknown') ? 'unknown' : 'pass';
  return { status, checks, reasons: checks.filter(item => item.status !== 'pass').map(item => `${item.id}: ${item.reason}`) };
}
