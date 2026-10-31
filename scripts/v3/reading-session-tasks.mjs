import { isAbsolute, normalize, win32 } from 'node:path';

const scienceRoles = ['evidence', 'methods', 'results', 'interpretation', 'scientific-reading', 'integration'];
const nonempty = value => typeof value === 'string' && Boolean(value.trim());
const fail = code => { throw Object.assign(new Error(code), { code }); };

/** Predeclare task identities and finite control slots before any role dispatch. */
export function buildReadingSessionTasks({ runId, scientificInput, sourceLanguage, checkpointCount, controllerActorId = 'controller', taskOverrides = {}, scienceTaskOverrides = {}, includeRepairs = false, presentationMode = 'reading-editor', enrichmentPolicy, instructionProfile } = {}) {
  const modern = instructionProfile === 'configured-reading-2.2';
  const translationProgress = ['configured-reading-2.1', 'configured-reading-2.2'].includes(instructionProfile);
  if (!/^[a-zA-Z0-9_-]+$/.test(runId ?? '') || !['en', 'zh-CN'].includes(sourceLanguage) || !nonempty(controllerActorId)) fail('READING_SESSION_INPUT_INVALID');
  const ids = scientificInput?.role_artifacts;
  if (!Array.isArray(ids) || ids.length !== 6 || ids.some(id => !nonempty(id)) || new Set(ids).size !== ids.length) fail('READING_SESSION_SCIENCE_IDENTITIES');
  if (!Number.isSafeInteger(checkpointCount) || checkpointCount < 1) fail('READING_SESSION_CHECKPOINT_COUNT');
  const task = (key, role, artifactId, category) => ({ task_id: key, task_name: ('task_' + key).replace(/[^a-z0-9_]/gi, '_').toLowerCase(), owner_actor_id: key, role, artifact_id: artifactId,
    artifact_path: `${category}/${key}.json`, native_path: `native/${key}.json`, instruction_path: `instructions/${key}.txt`, revision: '1' });
  if (!['writer', 'reading-editor'].includes(presentationMode) || typeof includeRepairs !== 'boolean') fail('READING_SESSION_INPUT_INVALID');
  if (Object.keys(scienceTaskOverrides).some(key => !scienceRoles.includes(key))) fail('READING_SESSION_TASK_OVERRIDE');
  const scienceTasks = Object.fromEntries(scienceRoles.map((role, i) => {
    const override = scienceTaskOverrides[role] ?? {};
    if (!override || typeof override !== 'object' || Array.isArray(override) || override.role !== undefined && override.role !== role || override.artifact_id !== undefined && override.artifact_id !== ids[i]) fail('READING_SESSION_TASK_OVERRIDE');
    return [role, { ...task(role, role, ids[i], 'science'), ...override }];
  }));
  const other = sourceLanguage === 'en' ? 'zh-CN' : 'en';
  const roleByKey = { [sourceLanguage]: sourceLanguage === 'en' ? 'english-writer' : 'chinese-writer', [other]: 'translation', review: 'independent-verifier', ...(presentationMode === 'reading-editor' ? { presentation: 'reading-editor' } : {}) };
  const taskBindings = {};
  for (const [key, role] of Object.entries(roleByKey)) {
    for (const suffix of includeRepairs ? ['', '-r2'] : ['']) {
      const name = key + suffix;
      const base = task(name, role, 'reading-' + name, 'reading');
      if (translationProgress && role === 'translation') Object.assign(base, { source_view_path: `translation/${name}/source.json`, translation_context_path: `translation/${name}/context.json`, progress_path: `translation/${name}/progress.json` });
      const override = taskOverrides[name] ?? {};
      if (!override || typeof override !== 'object' || Array.isArray(override) || override.role !== undefined && override.role !== role) fail('READING_SESSION_TASK_OVERRIDE');
      taskBindings[name] = { ...base, ...override };
      if (translationProgress && role === 'translation' && !['source_view_path', 'translation_context_path', 'progress_path'].every(field => nonempty(taskBindings[name][field]))) fail('READING_SESSION_TASK_CONFLICT');
    }
  }
  if (enrichmentPolicy !== undefined) {
    for (const round of includeRepairs ? ['initial', 'late'] : ['initial']) {
      for (const role of ['evidence', 'methods', 'results']) {
        const key = `enrich-${round}-${role}`, override = taskOverrides[key] ?? {};
        if (!override || typeof override !== 'object' || Array.isArray(override) || override.role !== undefined && override.role !== role) fail('READING_SESSION_TASK_OVERRIDE');
        taskBindings[key] = { ...task(key, role, 'reading-' + key, 'reading'), source_root: `sources/${key}`, ...override };
        if (!nonempty(taskBindings[key].source_root)) fail('READING_SESSION_TASK_CONFLICT');
      }
    }
  }
  if (Object.keys(taskOverrides).some(key => !Object.hasOwn(taskBindings, key))) fail('READING_SESSION_TASK_OVERRIDE');
  const checkpoints = Array.from({ length: checkpointCount }, (_, i) => ({ artifact_id: `reading-checkpoint-${i + 1}`, artifact_path: `control/reading-checkpoint-${i + 1}.json`, revision: String(i + 1), owner_actor_id: controllerActorId, role: 'control' }));
  const sessionCheckpoints = modern ? checkpoints.map((row, i) => ({ ...row, artifact_id: `session-state-${i + 1}`, artifact_path: `control/session-state-${i + 1}.json` })) : [];
  const resultsResources = modern ? { output_root: 'resources/results', manifest_task: { ...task('results-resources', 'results', 'results-resources', 'science'), owner_actor_id: 'results' } } : undefined;
  const all = [...Object.values(scienceTasks), ...Object.values(taskBindings), ...checkpoints, ...sessionCheckpoints, ...(resultsResources ? [resultsResources.manifest_task] : [])];
  const paths = new Set(), artifactIds = new Set(), taskIds = new Set(), names = new Set();
  for (const item of all) {
    if (!['artifact_id', 'artifact_path', 'revision', 'owner_actor_id', 'role'].every(key => nonempty(item[key])) || artifactIds.has(item.artifact_id)) fail('READING_SESSION_TASK_CONFLICT');
    artifactIds.add(item.artifact_id);
    if (item.role !== 'control') {
      if (!['task_id', 'task_name', 'native_path', 'instruction_path'].every(key => nonempty(item[key])) || !/^[a-z0-9_]+$/.test(item.task_name) || taskIds.has(item.task_id) || names.has(item.task_name)) fail('READING_SESSION_TASK_CONFLICT');
      taskIds.add(item.task_id); names.add(item.task_name);
    }
    for (const path of [item.artifact_path, item.native_path, item.instruction_path, item.source_view_path, item.translation_context_path, item.progress_path].filter(Boolean)) {
      const normalized = normalize(path).replaceAll('\\', '/').toLowerCase();
      if (isAbsolute(path) || win32.isAbsolute(path) || normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.split('/')[0] === '.phase21-receipts' || paths.has(normalized)) fail('READING_SESSION_TASK_CONFLICT');
      paths.add(normalized);
    }
  }
  const roots = new Set();
  for (const item of Object.values(taskBindings).filter(item => item.source_root !== undefined)) {
    const path = item.source_root;
    if (!nonempty(path) || isAbsolute(path) || win32.isAbsolute(path)) fail('READING_SESSION_TASK_CONFLICT');
    const normalized = normalize(path).replaceAll('\\', '/').toLowerCase();
    if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.split('/')[0] === '.phase21-receipts' || [...paths, ...roots].some(other => other === normalized || other.startsWith(normalized + '/') || normalized.startsWith(other + '/'))) fail('READING_SESSION_TASK_CONFLICT');
    roots.add(normalized);
  }
  const authorizedBindings = all.map(item => ({ run_id: runId, actor_id: item.owner_actor_id, role: item.role, artifact_path: item.artifact_path, revision: item.revision }));
  return { scienceTasks, taskBindings, checkpoints, authorizedBindings, ...(modern ? { resultsResources, sessionCheckpoints } : {}) };
}
