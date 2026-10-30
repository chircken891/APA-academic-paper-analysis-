import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { runMineru as publicRunMineru } from '../lib/mineru-runner.mjs';
import { checkMineruRuntime as publicCheckMineruRuntime } from '../lib/mineru-runtime.mjs';
import { advanceRun as controlledAdvanceRun, resumeRun as controlledResumeRun } from './workflow-orchestrator.mjs';
import { getRunControlForDispatch } from './owned-artifact-store.mjs';
import { recordEvidenceCase, validateEvaluationApprovalPacket } from './phase21-evaluation-driver.mjs';
import { DEFAULT_APA_REASONING_EFFORT, APA_VERIFIER_ROLES, resolveApaRoleModel, validateApaRoleModelPolicy, hostDispatchArgumentsMatch, validHostDispatch, extractHostTaskHandle } from '../apa-model-policy.mjs';

const READING_FIRST_ROLE_ORDER = ['evidence', 'methods', 'results', 'interpretation', 'scientific-reading', 'integration'];
const READING_FIRST_HOST_ROLES = [...READING_FIRST_ROLE_ORDER, 'comparison', 'ledger', 'english-writer', 'chinese-writer', 'translation', 'reading-editor', 'independent-verifier'];
const ROLE_ORDER = ['source-check', 'evidence', 'methods', 'results', 'interpretation', 'scientific-reading', 'comparison', 'integration', 'ledger'];
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const p20 = () => ({ source_rule_binding: 'unverified', initial_delivery_binding: 'unverified', continuation_delivery_binding: 'unverified' });
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const stable = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
};
const packetFingerprint = packet => hash(Buffer.from(stable(packet)));
const same = (left, right) => stable(left) === stable(right);
const deepFreeze = value => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
};
const currentMineruConfiguration = Object.freeze({ formula: true, pipeline: 'pipeline', table: true });
const packetScope = packet => ({
  run_id: packet.run_id, user_approval_id: packet.user_approval_id, intended_evidence_tier: packet.intended_evidence_tier,
  ...(packet.workflow_profile !== undefined ? {workflow_profile:packet.workflow_profile} : {}),
  ...(packet.role_model_policy !== undefined ? { role_model_policy: packet.role_model_policy } : {}),
  source: packet.source, instruction_fingerprint: packet.instruction_fingerprint, configuration_fingerprint: packet.configuration_fingerprint,
  allowed_output_root: packet.allowed_output_root, backend: packet.backend, endpoint: packet.endpoint,
  host_action_scope: packet.host_action_scope, expected_resource_fields: packet.expected_resource_fields,
  estimate: packet.estimate, approved_budget_cap: packet.approved_budget_cap, retry_allowance: packet.retry_allowance,
});

function fail(code) { throw new Error(code); }
function contained(root, target) {
  const remainder = relative(root, target);
  return remainder === '' || (!remainder.startsWith('..') && !isAbsolute(remainder));
}

async function assertExistingPathIsNotLink(root, target, code) {
  if (!contained(root, target)) fail(code);
  let current = root;
  const suffix = relative(root, target).split(/[\\/]/).filter(Boolean);
  for (const segment of suffix) {
    current = join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) fail(`${code}_SYMLINK`);
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
  }
}

async function inventoryRawFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) fail('OUTPUT_SYMLINK_REJECTED');
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const bytes = await readFile(path);
        files.push({ path: relative(root, path).replaceAll('\\', '/'), byte_length: bytes.length, sha256: hash(bytes) });
      }
    }
  }
  await visit(root);
  if (files.length === 0) fail('APPROVED_OUTPUT_EMPTY');
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function validatedPacket(packet, { mineruOnly = false, modelFreeParser = false } = {}) {
  const validation = validateEvaluationApprovalPacket(packet, { modelFreeParser: mineruOnly && modelFreeParser });
  if (!validation.ok) fail(`APPROVAL_PACKET_INVALID:${validation.errors.join(',')}`);
  if (!mineruOnly && packet.backend.identity === 'current-collaboration') {
    validateHostScope(validation.packet);
    return validation.packet;
  }
  if (packet.backend.identity !== 'current-mineru' || packet.host_action_scope.action !== 'run_current_mineru') fail('CURRENT_MINERU_SCOPE_REQUIRED');
  if (packet.endpoint.value !== null || packet.endpoint.egress !== 'denied' || packet.endpoint.retention !== 'local_only') fail('CURRENT_MINERU_EGRESS_SCOPE_REQUIRED');
  const configuration = packet.backend.configuration;
  const { runtime_selection: selection, ...parserConfiguration } = configuration;
  if (!same(parserConfiguration, currentMineruConfiguration)
    || selection !== undefined && (Object.keys(selection).sort().join(',') !== 'configPath,python,runtimeHome'
      || Object.values(selection).some(value => typeof value !== 'string' || !isAbsolute(value)))) fail('CURRENT_MINERU_CONFIGURATION_REQUIRED');
  return validation.packet;
}

// A packet carrying the run's saved host dispatch is checked against that shape; packets without it keep the Codex rules below.
function validateDispatchedHostScope(packet) {
  const scope = packet.host_action_scope, dispatch = scope.dispatch, args = scope.arguments, rolePolicy = packet.role_model_policy;
  if (!validHostDispatch(dispatch)) fail('HOST_DISPATCH_INVALID');
  if (scope.action !== dispatch.tool) fail('HOST_ACTION_UNSUPPORTED');
  if (packet.workflow_profile !== 'reading-first-1.0' || !READING_FIRST_HOST_ROLES.includes(scope.role)) fail('HOST_READING_FIRST_ROLE_REQUIRED');
  if (!validateApaRoleModelPolicy(rolePolicy)) fail('HOST_ROLE_MODEL_POLICY_INVALID');
  const profile = resolveApaRoleModel(scope.role, rolePolicy.main_session, rolePolicy);
  if (packet.requested_model !== profile.model) fail('HOST_ROLE_MODEL_POLICY_MISMATCH');
  const message = args?.[dispatch.instruction_argument];
  if (typeof message !== 'string' || !message.trim() || !hostDispatchArgumentsMatch(dispatch, args, profile)
    || dispatch.task_name_argument && (typeof args[dispatch.task_name_argument] !== 'string' || !/^[a-z0-9_]+$/.test(args[dispatch.task_name_argument]))) fail('HOST_ARGUMENTS_INVALID');
  if (hash(Buffer.from(message)) !== packet.instruction_fingerprint) fail('HOST_INSTRUCTION_FINGERPRINT_MISMATCH');
  validateHostScopeLimits(packet);
  // The binding mirrors the saved dispatch: its declared result handle, or null when the host declares none.
  if (!same(scope.result_bindings?.agent_id, dispatch.result_handle ?? null)) fail('HOST_RESULT_BINDING_REQUIRED');
}

function validateHostScopeLimits(packet) {
  const scope = packet.host_action_scope;
  if (typeof scope.output_path !== 'string' || !scope.output_path || !contained(resolve(packet.allowed_output_root), resolve(scope.output_path))
    || resolve(scope.output_path) === resolve(packet.allowed_output_root)) fail('HOST_OUTPUT_SCOPE_MISMATCH');
  if (packet.endpoint.value !== 'current-session' || packet.endpoint.egress !== 'approved' || packet.endpoint.retention !== 'approved') fail('HOST_EGRESS_SCOPE_REQUIRED');
  if (!['local_dispatch', 'host_observation'].includes(packet.intended_evidence_tier)) fail('HOST_EVIDENCE_TIER_INVALID');
  if (packet.approved_budget_cap.unit !== 'tool_calls' || !Number.isInteger(packet.approved_budget_cap.value)
    || packet.approved_budget_cap.value < 1 + packet.retry_allowance) fail('HOST_CALL_BUDGET_INVALID');
  if (!same([...scope.permitted_result_fields].sort(), ['agent_id', 'raw_result_text'])) fail('HOST_RESULT_FIELDS_INVALID');
}

function validateHostScope(packet) {
  const scope = packet.host_action_scope;
  if (scope.dispatch !== undefined) return validateDispatchedHostScope(packet);
  const spawn = scope.action === 'collaboration.spawn_agent';
  if (!spawn && scope.action !== 'collaboration.followup_task') fail('HOST_ACTION_UNSUPPORTED');
  const args = scope.arguments;
  const rolePolicy = packet.role_model_policy;
  const readingFirstRole = packet.workflow_profile === 'reading-first-1.0' && READING_FIRST_HOST_ROLES.includes(scope.role);
  if (packet.workflow_profile === 'reading-first-1.0' && !readingFirstRole) fail('HOST_READING_FIRST_ROLE_REQUIRED');
  if (readingFirstRole && !rolePolicy) fail('HOST_ROLE_MODEL_POLICY_INVALID');
  if (rolePolicy !== undefined && (!validateApaRoleModelPolicy(rolePolicy) || !(APA_VERIFIER_ROLES.includes(scope.role) || readingFirstRole))) fail('HOST_ROLE_MODEL_POLICY_INVALID');
  const profile = rolePolicy === undefined ? null : resolveApaRoleModel(scope.role, rolePolicy.main_session, rolePolicy);
  if (profile && (packet.requested_model !== profile.model || spawn && args?.reasoning_effort !== profile.reasoning_effort)) fail('HOST_ROLE_MODEL_POLICY_MISMATCH');
  const keys = spawn ? ['task_name', 'message', 'fork_turns', 'model', 'reasoning_effort'] : ['target', 'message'];
  if (!args || Object.keys(args).some(key => !keys.includes(key)) || typeof args.message !== 'string' || !args.message.trim()
    || spawn && (typeof args.task_name !== 'string' || !/^[a-z0-9_]+$/.test(args.task_name) || args.fork_turns !== 'none' || args.model !== packet.requested_model)
    || spawn && Object.hasOwn(args, 'reasoning_effort') && args.reasoning_effort !== (profile?.reasoning_effort ?? DEFAULT_APA_REASONING_EFFORT)
    || !spawn && (typeof args.target !== 'string' || !args.target.trim())) fail('HOST_ARGUMENTS_INVALID');
  if (hash(Buffer.from(args.message)) !== packet.instruction_fingerprint) fail('HOST_INSTRUCTION_FINGERPRINT_MISMATCH');
  if (!ROLE_ORDER.includes(scope.role) && !(profile && (APA_VERIFIER_ROLES.includes(scope.role) || readingFirstRole))) fail('HOST_ROLE_REQUIRED');
  if (typeof scope.output_path !== 'string' || !scope.output_path || !contained(resolve(packet.allowed_output_root), resolve(scope.output_path))
    || resolve(scope.output_path) === resolve(packet.allowed_output_root)) fail('HOST_OUTPUT_SCOPE_MISMATCH');
  if (packet.endpoint.value !== 'current-session' || packet.endpoint.egress !== 'approved' || packet.endpoint.retention !== 'approved') fail('HOST_EGRESS_SCOPE_REQUIRED');
  if (!['local_dispatch', 'host_observation'].includes(packet.intended_evidence_tier)) fail('HOST_EVIDENCE_TIER_INVALID');
  if (packet.approved_budget_cap.unit !== 'tool_calls' || !Number.isInteger(packet.approved_budget_cap.value)
    || packet.approved_budget_cap.value < 1 + packet.retry_allowance) fail('HOST_CALL_BUDGET_INVALID');
  const path = scope.result_bindings?.agent_id;
  if (!Array.isArray(path) || !path.length || path.some(key => typeof key !== 'string' || !key || ['__proto__', 'prototype', 'constructor'].includes(key))) fail('HOST_RESULT_BINDING_REQUIRED');
  if (!same([...scope.permitted_result_fields].sort(), ['agent_id', 'raw_result_text'])) fail('HOST_RESULT_FIELDS_INVALID');
}

function observationFingerprint(record) {
  const { observation_fingerprint, ...content } = record;
  return hash(Buffer.from(stable(content)));
}

function validateContinuation(packet, previous) {
  if (packet.host_action_scope.action !== 'collaboration.followup_task') return;
  if (!previous) fail('CONTINUATION_OBSERVATION_REQUIRED');
  const scope = packet.host_action_scope;
  if (previous.status !== 'observed' || previous.port !== 'current-collaboration' || previous.run_id !== packet.run_id
    || !same(previous.source, packet.source)
    || previous.role !== scope.role || previous.output_path !== scope.output_path || previous.evidence_tier !== packet.intended_evidence_tier
    || previous.observation_fingerprint !== observationFingerprint(previous)
    || typeof previous.raw_result_text !== 'string' || previous.raw_result_sha256 !== hash(Buffer.from(previous.raw_result_text))
    || !same(scope.resumes, { action_id: previous.action_id, observation_fingerprint: previous.observation_fingerprint, agent_id: previous.agent_id })
    || scope.arguments.target !== previous.agent_id) fail('CONTINUATION_BINDING_MISMATCH');
}

function observedAgentId(raw, path) {
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  for (const key of path) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return null;
    value = value[key];
  }
  return typeof value === 'string' && value.trim() ? value : null;
}

/** Dependencies are constructor-only local-test seams; packets select no commands or backends.
 * `modelFreeParser` (configured reading only) also accepts `requested_model: null`; the historical default is unchanged. */
export function createCurrentMineruBaselinePort({ vaultRoot, dependencies = {}, modelFreeParser = false } = {}) {
  if (typeof vaultRoot !== 'string' || !vaultRoot) fail('VAULT_ROOT_REQUIRED');
  const root = resolve(vaultRoot);
  const checkMineruRuntime = dependencies.checkMineruRuntime ?? publicCheckMineruRuntime;
  const runMineru = dependencies.runMineru ?? publicRunMineru;
  if (typeof checkMineruRuntime !== 'function' || typeof runMineru !== 'function') fail('CURRENT_MINERU_PUBLIC_PORT_REQUIRED');
  return Object.freeze({
    port: 'current-mineru',
    async run(packet, { signal } = {}) {
      const approved = validatedPacket(packet, { mineruOnly: true, modelFreeParser });
      const sourcePath = resolve(approved.source.path);
      const outputPath = resolve(approved.allowed_output_root);
      await assertExistingPathIsNotLink(root, sourcePath, 'SOURCE_PATH_OUTSIDE_VAULT');
      await assertExistingPathIsNotLink(root, outputPath, 'OUTPUT_ROOT_OUTSIDE_VAULT');
      const sourceBytes = await readFile(sourcePath);
      if (sourceBytes.length !== approved.source.byte_length || hash(sourceBytes) !== approved.source.sha256) fail('SOURCE_BYTES_MISMATCH');
      try {
        await lstat(outputPath);
        fail('APPROVED_OUTPUT_ROOT_MUST_BE_EMPTY');
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      const selected = approved.backend.configuration.runtime_selection ?? {};
      const runtime = await checkMineruRuntime({ vaultRoot: root, ...selected });
      if (!runtime?.ok) fail(`CURRENT_MINERU_RUNTIME_UNAVAILABLE:${runtime?.reason ?? 'unknown'}`);
      if (runtime.version !== approved.backend.version) fail('BACKEND_VERSION_MISMATCH');
      if (runtime.configVersion !== approved.backend.runtime_configuration_version) fail('RUNTIME_CONFIGURATION_VERSION_MISMATCH');
      const parserVersion = await runMineru({ vaultRoot: root, sourcePath, outputPath, signal, ...selected });
      if (typeof parserVersion !== 'string' || !parserVersion) fail('CURRENT_MINERU_VERSION_UNOBSERVABLE');
      if (parserVersion !== approved.backend.version) fail('PARSER_VERSION_MISMATCH');
      const outputInventory = await inventoryRawFiles(outputPath);
      return Object.freeze({
        port: 'current-mineru', run_id: approved.run_id, parser_version: parserVersion,
        runtime: { version: runtime.version ?? 'unknown', config_version: runtime.configVersion ?? 'unknown' },
        output_path: outputPath, output_inventory: outputInventory, evidence_tier: approved.intended_evidence_tier,
        observed_model: 'unknown', delivery: 'unverified', context_isolation: 'unknown', resource_availability: 'unknown', p20_e12: p20(),
      });
    },
  });
}

export function emitApprovedRunStep({ packet, run, dispatchContext, approvedBudget, retryPolicy, previousObservation } = {}) {
  const approved = validatedPacket(packet);
  validateContinuation(approved, previousObservation);
  if (run?.run_id !== approved.run_id) fail('RUN_PACKET_MISMATCH');
  if (!dispatchContext || !approvedBudget || !retryPolicy) fail('CONTROL_CONTEXT_REQUIRED');
  if (JSON.stringify(approvedBudget) !== JSON.stringify(approved.approved_budget_cap)) fail('APPROVED_BUDGET_MISMATCH');
  if (retryPolicy.max_retries !== approved.retry_allowance) fail('RETRY_POLICY_MISMATCH');
  const inputFingerprint = packetFingerprint(approved);
  const scope = structuredClone(packetScope(approved));
  const scopeFingerprint = hash(Buffer.from(stable(scope)));
  return deepFreeze({
    action_id: `phase21-${randomUUID()}`, kind: 'phase21-approved-host-step', requires_plan07_approval: true,
    run_id: approved.run_id, user_approval_id: approved.user_approval_id, input_fingerprint: inputFingerprint,
    port: approved.backend.identity, action: approved.host_action_scope.action,
    ...(approved.backend.identity === 'current-collaboration' ? { arguments: structuredClone(approved.host_action_scope.arguments) } : {}),
    source: { path: approved.source.path, sha256: approved.source.sha256, byte_length: approved.source.byte_length },
    allowed_output_root: approved.allowed_output_root, permitted_result_fields: [...approved.host_action_scope.permitted_result_fields],
    approved_budget: structuredClone(approvedBudget), retry_policy: structuredClone(retryPolicy),
    packet_scope: scope, packet_scope_fingerprint: scopeFingerprint,
    observation_contract: 'actual host result only; unsupported fields remain unknown',
  });
}

export function ingestObservedRunStep({ packet, emittedStep, observation, store, ledger, run, dispatchContext, approvedBudget, retryPolicy, previousObservation, legacySourceComparison = false, now = new Date().toISOString() } = {}) {
  void store; void dispatchContext; void approvedBudget; void retryPolicy;
  const approved = validatedPacket(packet);
  validateContinuation(approved, previousObservation);
  const nativeHost = approved.backend.identity === 'current-collaboration';
  const expectedFingerprint = packetFingerprint(approved);
  const expectedScope = packetScope(approved);
  const expectedScopeFingerprint = hash(Buffer.from(stable(expectedScope)));
  const emittedSource = legacySourceComparison ? approved.source : { path: approved.source.path, sha256: approved.source.sha256, byte_length: approved.source.byte_length };
  const matching = emittedStep?.kind === 'phase21-approved-host-step' && typeof emittedStep.action_id === 'string' && emittedStep.action_id.trim().length > 0 && emittedStep.run_id === approved.run_id
    && emittedStep.input_fingerprint === expectedFingerprint && emittedStep.port === approved.backend.identity
    && emittedStep.action === approved.host_action_scope.action && run?.run_id === approved.run_id
    && emittedStep.packet_scope_fingerprint === expectedScopeFingerprint && same(emittedStep.packet_scope, expectedScope)
    && same(emittedStep.source, emittedSource) && emittedStep.allowed_output_root === approved.allowed_output_root
    && emittedStep.user_approval_id === approved.user_approval_id && same(emittedStep.approved_budget, approved.approved_budget_cap)
    && emittedStep.retry_policy?.max_retries === approved.retry_allowance
    && same(emittedStep.permitted_result_fields, approved.host_action_scope.permitted_result_fields)
    && (!approvedBudget || same(approvedBudget, approved.approved_budget_cap))
    && (!retryPolicy || retryPolicy.max_retries === approved.retry_allowance)
    && (!nativeHost || same(emittedStep.arguments, approved.host_action_scope.arguments));
  if (nativeHost) {
    const correlated = matching && observation?.action_id === emittedStep.action_id && observation?.run_id === approved.run_id
      && observation?.input_fingerprint === expectedFingerprint && observation?.port === approved.backend.identity
      && same(observation?.tool_call, { name: emittedStep.action, arguments: emittedStep.arguments });
    const raw = typeof observation?.raw_result_text === 'string' ? observation.raw_result_text : null;
    const resultHandle = approved.host_action_scope.dispatch?.result_handle;
    const idPath = resultHandle ? null : approved.host_action_scope.result_bindings.agent_id;
    const returnedId = raw && idPath ? observedAgentId(raw, idPath) : null;
    const continuation = approved.host_action_scope.action === 'collaboration.followup_task';
    // A returned empty string is observable; an absent return is not. Spawn still needs an identity.
    const hasReturn = raw !== null && (continuation || raw.trim().length > 0);
    // A declared result handle yields the real host task handle or null; it is never replaced by the Controller's action id.
    const hostHandle = resultHandle && hasReturn ? extractHostTaskHandle(raw, approved.host_action_scope.dispatch) : null;
    // Hosts whose return carries no parseable id are correlated by the Controller's own action id.
    const agentId = continuation ? previousObservation.agent_id : resultHandle ? hostHandle : idPath ? returnedId : hasReturn ? emittedStep?.action_id ?? null : null;
    const reason = !matching ? 'EMITTED_STEP_PACKET_SCOPE_MISMATCH' : !correlated ? 'OBSERVATION_CORRELATION_MISMATCH'
      : !hasReturn ? 'HOST_RAW_RESULT_REQUIRED' : !agentId && !resultHandle ? 'HOST_AGENT_ID_UNAVAILABLE'
        : continuation && returnedId && returnedId !== agentId ? 'HOST_AGENT_ID_MISMATCH' : null;
    const result = {
      status: reason ? 'blocked' : 'observed', blocked_reason: reason, observed_at: now,
      action_id: emittedStep?.action_id ?? null, action: approved.host_action_scope.action,
      run_id: approved.run_id, user_approval_id: approved.user_approval_id, input_fingerprint: expectedFingerprint,
      source: structuredClone(approved.source),
      port: approved.backend.identity, role: approved.host_action_scope.role, output_path: approved.host_action_scope.output_path,
      agent_id: reason ? null : agentId,
      ...(resultHandle ? { host_task_handle_status: reason ? 'not_observed' : hostHandle ? 'extracted' : 'not_found_in_result_text' } : {}),
      tool_call: structuredClone(observation?.tool_call ?? null),
      raw_result_text: raw, raw_result_sha256: raw !== null ? hash(Buffer.from(raw)) : null,
      evidence_tier: approved.intended_evidence_tier, execution_status: 'not_verified',
      correlation_basis: 'operator_recorded_not_platform_attested',
      observed_model: 'unknown', delivery: 'unverified', context_isolation: 'unknown', resource_availability: 'unknown', p20_e12: p20(),
    };
    result.observation_fingerprint = observationFingerprint(result);
    if (ledger) recordEvidenceCase({ ledger, caseId: 'P21-E12', expected: { host_observation: 'actual correlated tool return; delivery separately verified' }, actual: result, evidence: {
      source_or_fixture_fingerprint: approved.source.sha256, instruction_fingerprint: approved.instruction_fingerprint, configuration_fingerprint: approved.configuration_fingerprint,
      command_or_session_id: result.agent_id ?? emittedStep?.action_id ?? 'unemitted', observed_output_hash: result.raw_result_sha256,
      status: 'blocked', tier: approved.intended_evidence_tier, remaining_owner: 'approved-host-and-delivery-observation', resource_availability: 'unknown', p20_e12: p20(),
    } });
    return deepFreeze(result);
  }
  const observedMatching = matching && observation?.action_id === emittedStep.action_id && observation?.run_id === approved.run_id
    && observation?.input_fingerprint === expectedFingerprint && observation?.port === 'current-mineru';
  const outputMatches = observedMatching && Array.isArray(observation.output_inventory)
    && observation.output_inventory.every(item => typeof item?.path === 'string' && SHA256.test(item?.sha256 ?? '') && Number.isInteger(item?.byte_length) && item.byte_length >= 0);
  const reason = !matching ? 'EMITTED_STEP_PACKET_SCOPE_MISMATCH' : !observedMatching ? 'OBSERVATION_CORRELATION_MISMATCH'
    : !outputMatches ? 'OBSERVATION_OUTPUT_INCOMPLETE' : observation?.observed_model === 'self-report' || observation?.delivery_receipt ? 'HOST_DELIVERY_UNAUTHENTICATED' : 'HOST_CAPABILITY_UNAVAILABLE';
  const result = { status: 'blocked', blocked_reason: reason, observed_at: now, run_id: approved.run_id, port: 'current-mineru', evidence_tier: 'host_observation', observed_model: 'unknown', resource_availability: 'unknown', p20_e12: p20() };
  if (ledger) recordEvidenceCase({ ledger, caseId: 'P21-E12', expected: { host_observation: 'actual correlated host output' }, actual: { reason }, evidence: {
    source_or_fixture_fingerprint: approved.source.sha256, instruction_fingerprint: approved.instruction_fingerprint, configuration_fingerprint: approved.configuration_fingerprint,
    command_or_session_id: emittedStep?.action_id ?? 'unemitted', observed_output_hash: outputMatches ? hash(Buffer.from(JSON.stringify(observation.output_inventory))) : null,
    status: 'blocked', tier: 'host_observation', remaining_owner: 'approved-host-and-delivery-observation', resource_availability: 'unknown', p20_e12: p20(),
  } });
  return Object.freeze(result);
}

/** Drives a declared finite sequence through Plan 04 controls, never a duplicate scheduler. */
export async function runFiniteRoleSequence({ run, dispatchContext, artifactStore, actions, approvedBudget, retryPolicy, dependencies = {} } = {}) {
  const binding = getRunControlForDispatch({dispatchContext,runId:run?.run_id})?.reading_first_binding;
  const roleOrder = binding?.profile === 'reading-first-1.0' ? READING_FIRST_ROLE_ORDER : ROLE_ORDER;
  if (run?.workflow_profile === 'reading-first-1.0' && !binding) fail('READING_FIRST_CONTROL_REQUIRED');
  if (!Array.isArray(actions) || actions.length !== roleOrder.length) fail('DECLARED_ROLE_ACTIONS_REQUIRED');
  const advance = dependencies.advanceRun ?? controlledAdvanceRun;
  const resume = dependencies.resumeRun ?? controlledResumeRun;
  let current = run;
  let lastIndex = -1;
  for (const entry of actions) {
    const index = roleOrder.indexOf(entry?.role);
    if (index < 0 || index !== lastIndex + 1) fail('ROLE_SEQUENCE_INVALID');
    lastIndex = index;
    current = entry.resume ? await resume({ run: current, dispatchContext, artifactStore, approvedBudget, retryPolicy })
      : await advance({ run: current, dispatchContext, artifactStore, action: entry.action });
    if (current?.status === 'blocked') return current;
  }
  return current;
}
