import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, join } from 'node:path';
import { inspectApaConfig, resolveApaConfig } from '../lib/apa-config.mjs';
import { createConfiguredApaRoleModelPolicy, resolveApaRoleModel, buildHostDispatchArguments } from '../apa-model-policy.mjs';
import { createReadingFirstRunControl, fingerprintReadingFirst, renderReadingFirstNotes, snapshotReadingFirstRuntime } from './reading-first-runtime.mjs';
import { exportReadingFirstPreview } from './reading-first-preview.mjs';
import { emitApprovedRunStep, createCurrentMineruBaselinePort } from './phase21-runner.mjs';

const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const sectionsOf = bytes => Object.fromEntries([...String(bytes).matchAll(/^## (.+)\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)].map(match => [match[1], match[2].trim()]));
const scienceSections = { evidence: 'Evidence/Coverage Mapper', methods: 'Design/Methods Specialist', results: 'Results/Visuals Specialist', interpretation: 'Interpretation/Appraisal Specialist', 'scientific-reading': 'Scientific Reading Synthesizer', integration: 'Integrator' };

/** Freeze selected guidance into the binding. Disabled skills contribute no optional instructions. */
export function buildConfiguredReadingInstructions(writingSkills = {}) {
  const sections = sectionsOf(readFileSync(new URL('../../prompts/v3/reading-first-contracts.md', import.meta.url), 'utf8'));
  for (const languageSection of ['English Writer', 'Chinese Writer']) {
    sections[languageSection] = sections[languageSection].split(/\r?\n\r?\n/).filter(paragraph => !/Nature Skills|Apply Humanizer|Apply stss|采用 Humanizer-zh|用 stss/.test(paragraph)).join('\n\n');
    sections[languageSection] += '\n\nKeep all scientific information, attribution, conditions, quantities, units, formulas and uncertainty. Preserve registered Obsidian links, images, anchors and table data. Produce only the assigned JSON for the final Obsidian note. No extra polishing task, role, source search or review round is authorized.';
  }
  delete sections['Writer module guidance'];
  sections['Reading Editor'] = sections['Reading Editor'].replace(/Meaningful emphasis is required where it helps comprehension;[^\r\n]*/g, 'Meaningful emphasis is required where it helps comprehension. Numbered hierarchy, tables, lists, callouts and navigable catalogues remain available.');
  const writingInstructions = Object.fromEntries(['en', 'zh-CN'].map(language => [language, Object.entries(writingSkills)
    .filter(([key]) => key !== (language === 'en' ? 'humanizer-zh' : 'humanizer'))
    .map(([key, guide]) => 'Selected optional writing guidance: ' + key + '\n' + JSON.stringify({ path: guide.path, sha256: sha(Buffer.from(guide.content)) })
      + '\nApply only guidance relevant to this language and the assigned article module, within the existing APA output contract. Do not run skill workflows, commands, extra roles or review loops.\n' + guide.content).join('\n\n')]));
  return { sections, writing_instructions: writingInstructions,
    writing_guides: Object.fromEntries(Object.entries(writingSkills).map(([key, guide]) => [key, { path: guide.path, sha256: sha(Buffer.from(guide.content)), byte_length: Buffer.byteLength(guide.content) }])) };
}

/** Required entry for NEW configured readings. Reopening a run uses its owned binding, never this factory. */
export function prepareConfiguredReading({ repoRoot, mainSession, sessionContext, supportedModelPairs, ...options } = {}) {
  if (sessionContext !== undefined) {
    if (!sessionContext || typeof sessionContext !== 'object' || Array.isArray(sessionContext)
      || sessionContext.effort !== undefined && sessionContext.reasoning_effort !== undefined && sessionContext.effort !== sessionContext.reasoning_effort) throw new Error('APA_CONFIGURED_SESSION_CONTEXT_INVALID');
    const effort = sessionContext.effort ?? sessionContext.reasoning_effort;
    const derived = { model: sessionContext.model, ...(effort === undefined ? {} : { reasoning_effort: effort }) };
    if (mainSession !== undefined && (mainSession?.model !== derived.model || mainSession?.reasoning_effort !== derived.reasoning_effort)) throw new Error('APA_CONFIGURED_MAIN_SESSION_MISMATCH');
    mainSession = derived;
  }
  const loaded = inspectApaConfig({ repoRoot });
  if (!loaded.exists) throw new Error('APA_LOCAL_CONFIG_REQUIRED');
  const resolvedConfig = resolveApaConfig({ config: loaded.config, repoRoot, mainSession, supportedModelPairs });
  if (!loaded.ready) throw new Error('APA_CONFIG_DEPENDENCIES_UNAVAILABLE: ' + loaded.dependencies.filter(item => item.status !== 'available').map(item => item.key + '=' + item.status).join(', '));
  if (!/^[a-zA-Z0-9_-]+$/.test(options.runId ?? '')) throw new Error('APA_CONFIGURED_RUN_ID_INVALID');
  if (!['en', 'zh-CN'].includes(options.sourceLanguage)) throw new Error('APA_CONFIGURED_SOURCE_LANGUAGE_REQUIRED');
  const paths = { runRoot: join(resolvedConfig.paths.runs, options.runId), parseRoot: join(resolvedConfig.paths.parse, options.runId), candidateRoot: join(resolvedConfig.paths.candidates, options.runId) };
  const parserOptions = { runtimeHome: resolvedConfig.parser.runtime_home,
    python: resolvedConfig.parser.python ?? join(resolvedConfig.parser.runtime_home, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    configPath: resolvedConfig.parser.config_path ?? join(resolvedConfig.parser.runtime_home, 'config.yaml') };
  const configuredSetup = { schema_version: 'apa-configured-reading-1.0', config_fingerprint: loaded.fingerprint, paths, parser: parserOptions,
    role_model_policy: createConfiguredApaRoleModelPolicy(mainSession, resolvedConfig.roles),
    ...buildConfiguredReadingInstructions(resolvedConfig.writingSkills) };
  const runControl = createReadingFirstRunControl({ ...options, ...(loaded.config.host ? { host: loaded.config.host } : {}), mainSession, configuredSetup, writingMode: 'source-first',
    firstWritingLanguage: resolvedConfig.reading.source_language, presentationMode: resolvedConfig.reading.presentation_mode });
  return freeze({ resolvedConfig, scientificInput: structuredClone(options.scientificInput), configurationFingerprint: loaded.fingerprint, paths, parserOptions, runControl });
}

function ownedPath(root, path) {
  const target = resolve(root, path), suffix = relative(root, target);
  if (isAbsolute(path) || !suffix || suffix.startsWith('..') || isAbsolute(suffix)) throw new Error('APA_CONFIGURED_OUTPUT_OUTSIDE_RUN');
  return target;
}

/** Emits the existing runner's approved host action with the resolved science model and role contract. */
export function createConfiguredScienceRequest({ prepared, role, task, dispatchContext, payload = {} } = {}) {
  if (!scienceSections[role]) throw new Error('APA_CONFIGURED_SCIENCE_ROLE_INVALID');
  const binding = prepared.runControl.reading_first_binding, source = prepared.scientificInput?.sources?.[0] ?? payload.sources?.[0];
  if (!source) throw new Error('APA_CONFIGURED_SCIENCE_SOURCE_REQUIRED');
  const sections = sectionsOf(readFileSync(new URL('../../prompts/v3/phase21-scientific-contracts.md', import.meta.url), 'utf8'));
  const outputPath = ownedPath(prepared.paths.runRoot, task.native_path);
  let message = [sections['Common scientific contract'], sections[scienceSections[role]], JSON.stringify(payload), 'Write only the assigned complete JSON to: ' + outputPath].join('\n\n');
  let instructionFile;
  if (task.instruction_path) {
    const path = ownedPath(prepared.paths.runRoot, task.instruction_path);
    mkdirSync(dirname(path), { recursive: true });
    try { writeFileSync(path, message, { flag: 'wx' }); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!readFileSync(path).equals(Buffer.from(message))) throw new Error('APA_CONFIGURED_INSTRUCTION_CONFLICT');
    }
    instructionFile = { path, sha256: sha(Buffer.from(message)), byte_length: Buffer.byteLength(message) };
    message = 'Read the complete instruction file: ' + path + '\nVerify SHA-256 before following it: ' + instructionFile.sha256 + '\nWrite only to: ' + outputPath;
  }
  const configuration = { profile: 'reading-first-1.0', config_fingerprint: prepared.configurationFingerprint, role, ...(instructionFile ? { instruction_file: instructionFile } : {}) };
  const model = resolveApaRoleModel(role, binding.role_model_policy.main_session, binding.role_model_policy);
  const packet = { workflow_profile: 'reading-first-1.0', run_id: prepared.runControl.run_id, user_approval_id: binding.authorization_id,
    intended_evidence_tier: 'local_dispatch', source, instruction_fingerprint: sha(Buffer.from(message)), configuration_fingerprint: fingerprintReadingFirst(configuration),
    allowed_output_root: prepared.paths.runRoot, backend: { identity: 'current-collaboration', version: 'native-collaboration', runtime_configuration_version: 'reading-first-1.0', configuration },
    endpoint: { value: 'current-session', egress: 'approved', retention: 'approved' }, host_action_scope: binding.host
      ? { action: binding.host.dispatch.tool, dispatch: structuredClone(binding.host.dispatch), role, output_path: outputPath,
        arguments: buildHostDispatchArguments(binding.host.dispatch, { taskName: task.task_name, message, model }), result_bindings: { agent_id: null }, permitted_result_fields: ['raw_result_text', 'agent_id'] }
      : { action: 'collaboration.spawn_agent', role, output_path: outputPath,
        arguments: { task_name: task.task_name, message, ...model, fork_turns: 'none' }, result_bindings: { agent_id: binding.host_result_agent_id_path }, permitted_result_fields: ['raw_result_text', 'agent_id'] },
    role_model_policy: binding.role_model_policy, expected_resource_fields: ['elapsed_ms'], requested_model: model.model, observed_model: 'unknown',
    estimate: { value: 1, unit: 'tool_calls' }, approved_budget_cap: { value: 1, unit: 'tool_calls' }, retry_allowance: 0 };
  const emittedStep = emitApprovedRunStep({ packet, run: { run_id: packet.run_id }, dispatchContext, approvedBudget: packet.approved_budget_cap, retryPolicy: { max_retries: 0 } });
  return freeze({ packet, emittedStep, ...(instructionFile ? { instruction_file: instructionFile } : {}) });
}

/** Return only the approved, correlated spawn arguments; this does not invoke the host tool. */
export function getConfiguredReadingDispatchArguments({ prepared, request } = {}) {
  const binding = prepared?.runControl?.reading_first_binding, packet = request?.packet, step = request?.emittedStep;
  if (!binding || !packet || !step || packet.run_id !== prepared.runControl.run_id
    || packet.user_approval_id !== binding.authorization_id || packet.workflow_profile !== binding.profile
    || packet.allowed_output_root !== prepared.paths.runRoot
    || packet.backend?.configuration?.config_fingerprint !== undefined && packet.backend.configuration.config_fingerprint !== prepared.configurationFingerprint
    || fingerprintReadingFirst(packet.role_model_policy) !== fingerprintReadingFirst(binding.role_model_policy)
    || packet.host_action_scope?.action !== (binding.host?.dispatch.tool ?? 'collaboration.spawn_agent')
    || fingerprintReadingFirst(packet.host_action_scope?.dispatch ?? null) !== fingerprintReadingFirst(binding.host?.dispatch ?? null)) throw new Error('APA_CONFIGURED_DISPATCH_MISMATCH');
  let expected;
  try { expected = emitApprovedRunStep({ packet, run: { run_id: prepared.runControl.run_id }, dispatchContext: {},
    approvedBudget: packet.approved_budget_cap, retryPolicy: { max_retries: packet.retry_allowance } }); }
  catch { throw new Error('APA_CONFIGURED_DISPATCH_MISMATCH'); }
  const { action_id: actualId, ...actualStep } = step;
  const { action_id: expectedId, ...expectedStep } = expected;
  if (typeof actualId !== 'string' || !actualId.trim() || !expectedId
    || fingerprintReadingFirst(actualStep) !== fingerprintReadingFirst(expectedStep)) throw new Error('APA_CONFIGURED_DISPATCH_MISMATCH');
  if (request.instruction_file) {
    const file = request.instruction_file;
    let bytes;
    try { bytes = readFileSync(file.path); } catch { throw new Error('APA_CONFIGURED_DISPATCH_MISMATCH'); }
    if (fingerprintReadingFirst(file) !== fingerprintReadingFirst(packet.backend.configuration.instruction_file)
      || sha(bytes) !== file.sha256 || bytes.length !== file.byte_length) throw new Error('APA_CONFIGURED_DISPATCH_MISMATCH');
  } else if (packet.backend.configuration.instruction_file) throw new Error('APA_CONFIGURED_DISPATCH_MISMATCH');
  return structuredClone(step.arguments);
}

/** Parser packet configuration is fingerprinted by the existing approval gate. */
export function configuredMineruConfiguration(prepared) {
  return { formula: true, pipeline: 'pipeline', table: true, runtime_selection: { ...prepared.parserOptions } };
}

export function createConfiguredMineruPort({ prepared, repoRoot, dependencies } = {}) {
  const port = createCurrentMineruBaselinePort({ vaultRoot: repoRoot, dependencies });
  return Object.freeze({ port: port.port, run(packet, options) {
    if (resolve(packet.allowed_output_root) !== prepared.paths.parseRoot
      || fingerprintReadingFirst(packet.backend?.configuration) !== fingerprintReadingFirst(configuredMineruConfiguration(prepared))) throw new Error('APA_CONFIGURED_PARSER_BINDING_MISMATCH');
    return port.run(packet, options);
  } });
}

/** Save the same rendered Obsidian candidate through the existing self-contained exporter; grants no publication authority. */
export async function materializeConfiguredReadingCandidate({ prepared, controller, handoff, resources, ...renderOptions } = {}) {
  const candidate = renderReadingFirstNotes({ controller, ...renderOptions });
  const checkpoint = snapshotReadingFirstRuntime(controller);
  if (checkpoint.control_fingerprint !== fingerprintReadingFirst(prepared.runControl.reading_first_binding)
    || checkpoint.handoff_fingerprint !== handoff?.handoff_fingerprint) throw new Error('APA_CONFIGURED_CANDIDATE_BINDING_MISMATCH');
  mkdirSync(dirname(prepared.paths.candidateRoot), { recursive: true });
  const exported = await exportReadingFirstPreview({ outputRoot: prepared.paths.candidateRoot, identity: handoff.identity,
    views: ['en', 'zh-CN'].map(language => checkpoint.state.views[language].value), presentation: handoff.presentation, resources,
    ...(checkpoint.state.readingEditor ? { readingEditor: checkpoint.state.readingEditor.value } : {}), ...renderOptions,
    targetRegistry: candidate.targetRegistry });
  if (candidate.notes.some(note => exported.notes.find(other => other.path === note.path)?.content !== note.content)) throw new Error('APA_CONFIGURED_CANDIDATE_RENDER_MISMATCH');
  return { candidate, exported };
}
