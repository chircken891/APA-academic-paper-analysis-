import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { createCurrentMineruBaselinePort, emitApprovedRunStep, ingestObservedRunStep, runFiniteRoleSequence } from '../../scripts/v3/phase21-runner.mjs';
import { createOwnedArtifactBroker } from '../../scripts/v3/owned-artifact-store.mjs';
import { createPhase21ContractValidator } from '../../scripts/v3/phase21-contract-loader.mjs';
import { runMineru as publicRunMineru } from '../../scripts/lib/mineru-runner.mjs';
import { createEvaluationLedger } from '../../scripts/v3/phase21-evaluation-driver.mjs';

const execFileAsync = promisify(execFile);
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const fingerprintSet = char => Object.fromEntries(['source', 'parser_tool', 'permission', 'parent_revision', 'policy', 'authorization'].map(name => [name, `sha256:${char.repeat(64)}`]));
const currentMineruConfiguration = { formula: true, pipeline: 'pipeline', table: true };
const currentMineruConfigurationFingerprint = hash(Buffer.from(JSON.stringify(currentMineruConfiguration)));
const syntheticInstructionFingerprint = hash(Buffer.from('phase21 synthetic instruction'));
const packetFor = ({ sourcePath, sourceBytes, outputRoot }) => ({
  run_id: 'run-21-local', user_approval_id: 'approval-21-local', intended_evidence_tier: 'local_dispatch',
  source: { path: sourcePath, sha256: hash(sourceBytes), byte_length: sourceBytes.length },
  instruction_fingerprint: syntheticInstructionFingerprint, configuration_fingerprint: currentMineruConfigurationFingerprint, allowed_output_root: outputRoot,
  backend: { identity: 'current-mineru', version: 'simulated-1.0', runtime_configuration_version: 'synthetic', configuration: currentMineruConfiguration },
  endpoint: { value: null, egress: 'denied', retention: 'local_only' }, host_action_scope: { action: 'run_current_mineru', permitted_result_fields: ['parser_version', 'output_inventory'] },
  expected_resource_fields: ['elapsed_ms'], requested_model: 'gpt-5.6-terra', observed_model: 'unknown', estimate: { value: 1, unit: 'runs' }, approved_budget_cap: { value: 1, unit: 'runs' }, retry_allowance: 0,
});

// Synthetic packets and raw replies below never invoke a collaboration tool.
const hostPacket = () => {
  const packet = packetFor({ sourcePath: 'fixtures/source.json', sourceBytes: Buffer.from('synthetic source'), outputRoot: 'fixtures/host-output' });
  packet.backend = { identity: 'current-collaboration', version: 'fixture-tool-schema', runtime_configuration_version: 'fixture-only', configuration: {} };
  packet.configuration_fingerprint = hash(Buffer.from('{}'));
  packet.endpoint = { value: 'current-session', egress: 'approved', retention: 'approved' };
  packet.host_action_scope = {
    action: 'collaboration.spawn_agent', role: 'methods', output_path: 'fixtures/host-output/methods.json',
    arguments: { task_name: 'synthetic_methods', message: 'Synthetic task; no real paper or tool execution.', fork_turns: 'none', model: 'gpt-5.6-terra' },
    result_bindings: { agent_id: ['agent_id'] }, permitted_result_fields: ['raw_result_text', 'agent_id'],
  };
  packet.instruction_fingerprint = hash(Buffer.from(packet.host_action_scope.arguments.message));
  packet.estimate = { value: 1, unit: 'tool_calls' }; packet.approved_budget_cap = { value: 1, unit: 'tool_calls' };
  return packet;
};
const hostControls = packet => ({ packet, run: { run_id: packet.run_id }, dispatchContext: {}, approvedBudget: packet.approved_budget_cap, retryPolicy: { max_retries: packet.retry_allowance } });
const hostReply = (packet, step, raw = '{"agent_id":"fixture-agent","status":"running"}') => ({
  action_id: step.action_id, run_id: packet.run_id, input_fingerprint: step.input_fingerprint, port: 'current-collaboration',
  tool_call: { name: step.action, arguments: structuredClone(step.arguments) }, raw_result_text: raw,
});

test('native observation correlates registered source metadata while preserving the complete packet scope', () => {
  const packet = hostPacket();
  Object.assign(packet.source, { id: 'main', kind: 'main' });
  const step = emitApprovedRunStep(hostControls(packet));
  const observation = hostReply(packet, step);
  const result = ingestObservedRunStep({ ...hostControls(packet), emittedStep: step, observation });
  assert.equal(result.status, 'observed', result.blocked_reason);
  assert.equal(result.source.id, 'main');
  const tampered = structuredClone(step);
  tampered.source.sha256 = hash(Buffer.from('different source'));
  assert.equal(ingestObservedRunStep({ ...hostControls(packet), emittedStep: tampered, observation }).blocked_reason, 'EMITTED_STEP_PACKET_SCOPE_MISMATCH');
  const historical = ingestObservedRunStep({ ...hostControls(packet), emittedStep: step, observation, legacySourceComparison: true });
  assert.equal(historical.status, 'blocked');
  assert.equal(historical.blocked_reason, 'EMITTED_STEP_PACKET_SCOPE_MISMATCH');
});

test('native host spawn tracer emits exact parameters without executing and retains raw observations', () => {
  const packet = hostPacket(); const step = emitApprovedRunStep(hostControls(packet));
  assert.equal(step.port, 'current-collaboration');
  assert.deepEqual(step.arguments, packet.host_action_scope.arguments);
  assert.ok(Object.isFrozen(step.arguments));
  const observation = hostReply(packet, step);
  const result = ingestObservedRunStep({ ...hostControls(packet), emittedStep: step, observation });
  assert.equal(result.status, 'observed');
  assert.equal(result.agent_id, 'fixture-agent');
  assert.equal(result.raw_result_text, observation.raw_result_text);
  assert.equal(result.raw_result_sha256, hash(Buffer.from(observation.raw_result_text)));
  assert.equal(result.evidence_tier, 'local_dispatch');
  assert.equal(result.execution_status, 'not_verified');
  assert.equal(result.observed_model, 'unknown');
  assert.equal(result.p20_e12.initial_delivery_binding, 'unverified');
});

test('native host continuation tracer binds the prior raw observation and exact target', () => {
  const first = hostPacket(); const initialStep = emitApprovedRunStep(hostControls(first));
  const previousObservation = ingestObservedRunStep({ ...hostControls(first), emittedStep: initialStep, observation: hostReply(first, initialStep) });
  const packet = hostPacket(); packet.user_approval_id = 'synthetic-continuation-approval';
  packet.host_action_scope.action = 'collaboration.followup_task';
  packet.host_action_scope.arguments = { target: previousObservation.agent_id, message: 'Synthetic continuation only.' };
  packet.host_action_scope.resumes = { action_id: previousObservation.action_id, observation_fingerprint: previousObservation.observation_fingerprint, agent_id: previousObservation.agent_id };
  packet.instruction_fingerprint = hash(Buffer.from(packet.host_action_scope.arguments.message));
  const controls = { ...hostControls(packet), previousObservation };
  const step = emitApprovedRunStep(controls);
  const result = ingestObservedRunStep({ ...controls, emittedStep: step, observation: hostReply(packet, step, '{"status":"queued"}') });
  assert.equal(result.status, 'observed');
  assert.equal(result.agent_id, 'fixture-agent');
  assert.equal(result.execution_status, 'not_verified');
  assert.equal(result.p20_e12.continuation_delivery_binding, 'unverified');
  assert.throws(() => emitApprovedRunStep(hostControls(packet)), /CONTINUATION_OBSERVATION_REQUIRED/);
  const wrongTarget = structuredClone(packet); wrongTarget.host_action_scope.arguments.target = 'different-agent';
  assert.throws(() => emitApprovedRunStep({ ...hostControls(wrongTarget), previousObservation }), /CONTINUATION_BINDING_MISMATCH/);
  assert.throws(() => emitApprovedRunStep({ ...controls, previousObservation: { ...previousObservation, raw_result_text: '{"agent_id":"other"}' } }), /CONTINUATION_BINDING_MISMATCH/);
  const changedSource = structuredClone(packet); changedSource.source.sha256 = hash(Buffer.from('different source'));
  assert.throws(() => emitApprovedRunStep({ ...hostControls(changedSource), previousObservation }), /CONTINUATION_BINDING_MISMATCH/);
});

test('native host empty continuation retains exact bytes without promoting execution or delivery', async () => {
  const first = hostPacket(); const initialStep = emitApprovedRunStep(hostControls(first));
  const previousObservation = ingestObservedRunStep({ ...hostControls(first), emittedStep: initialStep, observation: hostReply(first, initialStep) });
  const packet = hostPacket();
  packet.host_action_scope.action = 'collaboration.followup_task';
  packet.host_action_scope.arguments = { target: previousObservation.agent_id, message: 'Synthetic continuation only.' };
  packet.host_action_scope.resumes = { action_id: previousObservation.action_id, observation_fingerprint: previousObservation.observation_fingerprint, agent_id: previousObservation.agent_id };
  packet.instruction_fingerprint = hash(Buffer.from(packet.host_action_scope.arguments.message));
  const controls = { ...hostControls(packet), previousObservation };
  const step = emitApprovedRunStep(controls);
  const cases = JSON.parse(await readFile(new URL('./fixtures/phase21/evaluation-cases.json', import.meta.url), 'utf8')).cases;
  for (const raw of ['', ' \r\n']) {
    const ledger = createEvaluationLedger({ phase: '21', cases });
    const result = ingestObservedRunStep({ ...controls, emittedStep: step, observation: hostReply(packet, step, raw), ledger });
    assert.equal(result.status, 'observed');
    assert.equal(result.blocked_reason, null);
    assert.equal(result.agent_id, previousObservation.agent_id);
    assert.equal(result.raw_result_text, raw);
    assert.equal(result.raw_result_sha256, hash(Buffer.from(raw)));
    assert.equal(result.execution_status, 'not_verified');
    assert.equal(result.delivery, 'unverified');
    assert.equal(result.observed_model, 'unknown');
    assert.equal(result.context_isolation, 'unknown');
    assert.equal(result.resource_availability, 'unknown');
    assert.ok(Object.values(result.p20_e12).every(value => value === 'unverified'));
    assert.equal(ledger.rows.get('P21-E12').status, 'blocked');
    // A later separately approved step can bind this record; this emits, never dispatches.
    const next = structuredClone(packet);
    next.user_approval_id = 'synthetic-next-approval';
    next.host_action_scope.resumes = { action_id: result.action_id, observation_fingerprint: result.observation_fingerprint, agent_id: result.agent_id };
    assert.equal(emitApprovedRunStep({ ...hostControls(next), previousObservation: result }).arguments.target, result.agent_id);
  }
});

test('native host empty continuation still rejects absent returns and mismatched correlation', () => {
  const first = hostPacket(); const initialStep = emitApprovedRunStep(hostControls(first));
  for (const raw of ['', ' \n', null, 0]) {
    assert.equal(ingestObservedRunStep({ ...hostControls(first), emittedStep: initialStep, observation: hostReply(first, initialStep, raw) }).status, 'blocked');
  }
  const previousObservation = ingestObservedRunStep({ ...hostControls(first), emittedStep: initialStep, observation: hostReply(first, initialStep) });
  const packet = hostPacket();
  packet.host_action_scope.action = 'collaboration.followup_task';
  packet.host_action_scope.arguments = { target: previousObservation.agent_id, message: 'Synthetic continuation only.' };
  packet.host_action_scope.resumes = { action_id: previousObservation.action_id, observation_fingerprint: previousObservation.observation_fingerprint, agent_id: previousObservation.agent_id };
  packet.instruction_fingerprint = hash(Buffer.from(packet.host_action_scope.arguments.message));
  const controls = { ...hostControls(packet), previousObservation }; const step = emitApprovedRunStep(controls);
  for (const change of [
    o => { delete o.raw_result_text; }, o => { o.raw_result_text = null; }, o => { o.raw_result_text = {}; },
    o => { o.action_id = 'wrong'; }, o => { o.run_id = 'wrong'; }, o => { o.input_fingerprint = hash(Buffer.from('wrong')); },
    o => { o.port = 'wrong'; }, o => { o.tool_call.arguments.target = 'wrong'; }, o => { o.tool_call.arguments.message = 'wrong'; },
    o => { o.raw_result_text = '{"agent_id":"wrong"}'; },
  ]) {
    const observation = hostReply(packet, step, ''); change(observation);
    assert.equal(ingestObservedRunStep({ ...controls, emittedStep: step, observation }).status, 'blocked');
  }
  assert.throws(() => ingestObservedRunStep({ ...controls, previousObservation: null, emittedStep: step, observation: hostReply(packet, step, '') }), /CONTINUATION_OBSERVATION_REQUIRED/);
});

test('native host emits explicitly approved medium effort without executing a model', () => {
  const packet = hostPacket();
  packet.requested_model = 'gpt-6-sol';
  Object.assign(packet.host_action_scope.arguments, { model: 'gpt-6-sol', reasoning_effort: 'medium' });
  const step = emitApprovedRunStep(hostControls(packet));
  assert.equal(step.arguments.reasoning_effort, 'medium');
});

test('native host binds GPT-6.1 Sol medium and rejects effort drift or invalid effort', () => {
  const packet = hostPacket();
  packet.requested_model = 'gpt-6.1-sol';
  Object.assign(packet.host_action_scope.arguments, { model: 'gpt-6.1-sol', reasoning_effort: 'medium' });
  const step = emitApprovedRunStep(hostControls(packet));
  assert.equal(step.arguments.model, 'gpt-6.1-sol');
  assert.equal(step.arguments.reasoning_effort, 'medium');
  const observed = hostReply(packet, step);
  observed.tool_call.arguments.reasoning_effort = 'high';
  assert.equal(ingestObservedRunStep({ ...hostControls(packet), emittedStep: step, observation: observed }).status, 'blocked');
  packet.host_action_scope.arguments.reasoning_effort = 1;
  assert.throws(() => emitApprovedRunStep(hostControls(packet)), /HOST_ARGUMENTS_INVALID/);
});

test('native host emits approved GPT-6 Sol but rejects replacing its bound model with Terra', () => {
  const packet = hostPacket();
  packet.requested_model = 'gpt-6-sol';
  packet.host_action_scope.arguments.model = 'gpt-6-sol';
  const step = emitApprovedRunStep(hostControls(packet));
  assert.equal(step.arguments.model, 'gpt-6-sol');
  packet.host_action_scope.arguments.model = 'gpt-5.6-terra';
  assert.throws(() => emitApprovedRunStep(hostControls(packet)), /HOST_ARGUMENTS_INVALID/);
});

test('native host refuses changed scope, unapproved parameters, model switches and escaped outputs', () => {
  for (const [change, error] of [
    [p => { p.host_action_scope.action = 'collaboration.send_message'; }, /HOST_ACTION_UNSUPPORTED/],
    [p => { p.host_action_scope.arguments.async = true; }, /HOST_ARGUMENTS_INVALID/],
    [p => { p.host_action_scope.arguments.task_name = 123; }, /HOST_ARGUMENTS_INVALID/],
    [p => { p.host_action_scope.arguments.model = 'gpt-6-astra'; }, /HOST_ARGUMENTS_INVALID/],
    [p => { p.host_action_scope.arguments.message += 'changed'; }, /HOST_INSTRUCTION_FINGERPRINT_MISMATCH/],
    [p => { p.host_action_scope.output_path = 'fixtures/escape.json'; }, /HOST_OUTPUT_SCOPE_MISMATCH/],
    [p => { p.endpoint.egress = 'denied'; }, /HOST_EGRESS_SCOPE_REQUIRED/],
  ]) {
    const packet = hostPacket(); change(packet);
    assert.throws(() => emitApprovedRunStep(hostControls(packet)), error);
  }
});

test('native host raw-result mapping supports nested observed shapes without assuming platform fields', () => {
  const packet = hostPacket(); packet.host_action_scope.result_bindings.agent_id = ['result', 'id'];
  const step = emitApprovedRunStep(hostControls(packet));
  const result = ingestObservedRunStep({ ...hostControls(packet), emittedStep: step, observation: hostReply(packet, step, '{"result":{"id":"nested-fixture"}}') });
  assert.equal(result.agent_id, 'nested-fixture');
  assert.equal(result.status, 'observed');
});

test('native host ingestion rejects mismatched call arguments, run, descriptor and missing returned identity', () => {
  const packet = hostPacket(); const step = emitApprovedRunStep(hostControls(packet));
  for (const change of [
    o => { o.run_id = 'other'; }, o => { o.action_id = 'other'; },
    o => { o.tool_call.arguments.message = 'unapproved'; },
    o => { o.raw_result_text = '{"error":"unavailable"}'; },
  ]) {
    const observation = hostReply(packet, step); change(observation);
    assert.equal(ingestObservedRunStep({ ...hostControls(packet), emittedStep: step, observation }).status, 'blocked');
  }
  const changedStep = structuredClone(step); changedStep.arguments.message = 'changed';
  assert.equal(ingestObservedRunStep({ ...hostControls(packet), emittedStep: changedStep, observation: hostReply(packet, step) }).blocked_reason, 'EMITTED_STEP_PACKET_SCOPE_MISMATCH');
  const missingId = structuredClone(step); delete missingId.action_id;
  assert.equal(ingestObservedRunStep({ ...hostControls(packet), emittedStep: missingId, observation: hostReply(packet, missingId) }).blocked_reason, 'EMITTED_STEP_PACKET_SCOPE_MISMATCH');
});

test('native host packet cannot invoke MinerU port', async () => {
  let invoked = false;
  const port = createCurrentMineruBaselinePort({ vaultRoot: process.cwd(), dependencies: { checkMineruRuntime: async () => { invoked = true; } } });
  await assert.rejects(() => port.run(hostPacket()), /CURRENT_MINERU_SCOPE_REQUIRED/);
  assert.equal(invoked, false);
});

test('native host ledger preserves local tier and cannot promote raw self-reported model or delivery', async () => {
  const cases = JSON.parse(await readFile(new URL('./fixtures/phase21/evaluation-cases.json', import.meta.url), 'utf8')).cases;
  const ledger = createEvaluationLedger({ phase: '21', cases });
  const packet = hostPacket(); const step = emitApprovedRunStep(hostControls(packet));
  const observation = hostReply(packet, step, '{"agent_id":"fixture-agent","model":"gpt-6-astra","delivery":"verified","usage":0}');
  const result = ingestObservedRunStep({ ...hostControls(packet), emittedStep: step, observation, ledger });
  const row = ledger.rows.get('P21-E12');
  assert.equal(result.observed_model, 'unknown');
  assert.equal(result.delivery, 'unverified');
  assert.equal(result.resource_availability, 'unknown');
  assert.equal(row.status, 'blocked');
  assert.equal(row.tier, 'local_dispatch');
  assert.equal(row.actual.raw_result_text, observation.raw_result_text);
  assert.equal(row.command_or_session_id, 'fixture-agent');
  assert.equal(row.p20_e12.continuation_delivery_binding, 'unverified');
});

test('native host rejects insufficient retry cap, context inheritance and malformed result contracts', () => {
  for (const [change, error] of [
    [p => { p.retry_allowance = 3; }, /HOST_CALL_BUDGET_INVALID/],
    [p => { p.host_action_scope.arguments.fork_turns = 'all'; }, /HOST_ARGUMENTS_INVALID/],
    [p => { p.host_action_scope.result_bindings.agent_id = []; }, /HOST_RESULT_BINDING_REQUIRED/],
    [p => { p.host_action_scope.permitted_result_fields.push('claimed_model'); }, /HOST_RESULT_FIELDS_INVALID/],
    [p => { p.intended_evidence_tier = 'real_corpus'; }, /HOST_EVIDENCE_TIER_INVALID/],
  ]) {
    const packet = hostPacket(); change(packet);
    assert.throws(() => emitApprovedRunStep(hostControls(packet)), error);
  }
});

test('approved runner tracer current MinerU port records a deterministic local subprocess output without claiming MinerU execution', async t => {
  const root = await mkdtemp(join(tmpdir(), 'phase21-runner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceBytes = Buffer.from('synthetic local source');
  const sourcePath = join(root, 'input.pdf');
  const outputRoot = join(root, 'output');
  await writeFile(sourcePath, sourceBytes);
  const port = createCurrentMineruBaselinePort({ vaultRoot: root, dependencies: {
    checkMineruRuntime: async () => ({ ok: true, version: 'simulated-1.0', configVersion: 'synthetic' }),
    runMineru: async ({ outputPath }) => {
      await mkdir(outputPath, { recursive: true });
      await execFileAsync(process.execPath, ['-e', "require('node:fs').writeFileSync(process.argv[1], 'synthetic parser payload')", join(outputPath, 'payload.json')]);
      return 'simulated-1.0';
    },
  } });
  const result = await port.run(packetFor({ sourcePath, sourceBytes, outputRoot }));
  assert.equal(result.parser_version, 'simulated-1.0');
  assert.equal(result.output_inventory[0].sha256, hash(Buffer.from('synthetic parser payload')));
  assert.equal(result.observed_model, 'unknown');
  assert.equal(result.evidence_tier, 'local_dispatch');
});

test('current MinerU port invokes the public runMineru wrapper with only its documented local seams', async t => {
  const root = await mkdtemp(join(tmpdir(), 'phase21-public-wrapper-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.runtime', 'mineru'), { recursive: true });
  const sourceBytes = Buffer.from('synthetic public wrapper source');
  const sourcePath = join(root, 'input.pdf'); const outputRoot = join(root, 'output');
  await writeFile(sourcePath, sourceBytes);
  const port = createCurrentMineruBaselinePort({ vaultRoot: root, dependencies: {
    checkMineruRuntime: async () => ({ ok: true, version: 'simulated-1.0', configVersion: 'synthetic' }),
    runMineru: args => publicRunMineru({ ...args,
      resolveCommand: async () => ({ python: process.execPath }),
      readVersion: async () => 'simulated-1.0',
      runChild: async (_executable, arguments_) => {
        const outputPath = arguments_[2];
        assert.ok(arguments_[0].endsWith('mineru-parse.py'));
        assert.deepEqual(arguments_.slice(3), ['--tier', 'standard', '--pages', 'all']);
        await mkdir(outputPath, { recursive: true });
        await execFileAsync(process.execPath, ['-e', "require('node:fs').writeFileSync(process.argv[1], 'public wrapper payload')", join(outputPath, 'payload.json')]);
      },
    }),
  } });
  const result = await port.run(packetFor({ sourcePath, sourceBytes, outputRoot }));
  assert.equal(result.parser_version, 'simulated-1.0');
  assert.equal(result.output_inventory[0].sha256, hash(Buffer.from('public wrapper payload')));
});

test('packet mismatch rejects source-byte and output-root substitution before action', async t => {
  const root = await mkdtemp(join(tmpdir(), 'phase21-mismatch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, 'input.pdf'); const outputRoot = join(root, 'output');
  await writeFile(sourcePath, 'a');
  const port = createCurrentMineruBaselinePort({ vaultRoot: root, dependencies: { checkMineruRuntime: async () => ({ ok: true }), runMineru: async () => 'never' } });
  await assert.rejects(() => port.run(packetFor({ sourcePath, sourceBytes: Buffer.from('different'), outputRoot })), /SOURCE_BYTES_MISMATCH/);
  await assert.rejects(() => port.run(packetFor({ sourcePath, sourceBytes: Buffer.from('a'), outputRoot: join(root, '..', 'escaped') })), /OUTPUT_ROOT_OUTSIDE_VAULT/);
});

test('current MinerU port rejects version drift and never converts denied egress into a fallback', async t => {
  const root = await mkdtemp(join(tmpdir(), 'phase21-version-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, 'input.pdf'); const outputRoot = join(root, 'output'); const sourceBytes = Buffer.from('a');
  await writeFile(sourcePath, sourceBytes);
  const port = createCurrentMineruBaselinePort({ vaultRoot: root, dependencies: { checkMineruRuntime: async () => ({ ok: true, version: 'other' }), runMineru: async () => 'other' } });
  await assert.rejects(() => port.run(packetFor({ sourcePath, sourceBytes, outputRoot })), /BACKEND_VERSION_MISMATCH/);
  const packet = packetFor({ sourcePath, sourceBytes, outputRoot });
  packet.endpoint.value = 'https://unapproved.example';
  assert.throws(() => emitApprovedRunStep({ packet, run: { run_id: packet.run_id }, dispatchContext: {}, approvedBudget: packet.approved_budget_cap, retryPolicy: { max_retries: 0 } }), /CURRENT_MINERU_EGRESS_SCOPE_REQUIRED/);
  const localPacket = packetFor({ sourcePath, sourceBytes, outputRoot });
  assert.throws(() => emitApprovedRunStep({ packet: localPacket, run: { run_id: localPacket.run_id }, dispatchContext: {}, approvedBudget: { value: 2, unit: 'runs' }, retryPolicy: { max_retries: 0 } }), /APPROVED_BUDGET_MISMATCH/);
});

test('current MinerU port blocks non-pipeline configuration and an estimate beyond its approved cap before action', async t => {
  const root = await mkdtemp(join(tmpdir(), 'phase21-controls-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceBytes = Buffer.from('a'); const sourcePath = join(root, 'input.pdf'); const outputRoot = join(root, 'output');
  await writeFile(sourcePath, sourceBytes);
  let invoked = false;
  const port = createCurrentMineruBaselinePort({ vaultRoot: root, dependencies: { checkMineruRuntime: async () => ({ ok: true, version: 'simulated-1.0', configVersion: 'synthetic' }), runMineru: async () => { invoked = true; return 'simulated-1.0'; } } });
  const packet = packetFor({ sourcePath, sourceBytes, outputRoot });
  packet.backend.configuration = { formula: false, pipeline: 'pipeline', table: true };
  packet.configuration_fingerprint = hash(Buffer.from(JSON.stringify(packet.backend.configuration)));
  await assert.rejects(() => port.run(packet), /CURRENT_MINERU_CONFIGURATION_REQUIRED/);
  assert.equal(invoked, false);
  const overBudget = packetFor({ sourcePath, sourceBytes, outputRoot });
  overBudget.estimate.value = 2;
  assert.throws(() => emitApprovedRunStep({ packet: overBudget, run: { run_id: overBudget.run_id }, dispatchContext: {}, approvedBudget: overBudget.approved_budget_cap, retryPolicy: { max_retries: 0 } }), /APPROVAL_BUDGET_INVALID/);
});

test('host observation blocked rejects self-reported delivery and preserves P20-E12', () => {
  const packet = packetFor({ sourcePath: 'fixtures/input.pdf', sourceBytes: Buffer.from('x'), outputRoot: 'fixtures/output' });
  const step = emitApprovedRunStep({ packet, run: { run_id: 'run-21-local' }, dispatchContext: { kind: 'opaque' }, approvedBudget: packet.approved_budget_cap, retryPolicy: { max_retries: 0 } });
  const result = ingestObservedRunStep({ packet, emittedStep: step, observation: { action_id: step.action_id, run_id: packet.run_id, input_fingerprint: step.input_fingerprint, port: 'current-mineru', delivery_receipt: 'approved', observed_model: 'self-report' }, run: { run_id: packet.run_id }, dispatchContext: { kind: 'opaque' }, approvedBudget: packet.approved_budget_cap, retryPolicy: { max_retries: 0 } });
  assert.equal(result.status, 'blocked');
  assert.equal(result.p20_e12.source_rule_binding, 'unverified');
});

test('host observation blocked rejects wrong action, run, input hash, and unsupported output', () => {
  const packet = packetFor({ sourcePath: 'fixtures/input.pdf', sourceBytes: Buffer.from('x'), outputRoot: 'fixtures/output' });
  const step = emitApprovedRunStep({ packet, run: { run_id: packet.run_id }, dispatchContext: { kind: 'opaque' }, approvedBudget: packet.approved_budget_cap, retryPolicy: { max_retries: 0 } });
  const result = ingestObservedRunStep({ packet, emittedStep: { ...step, action: 'other' }, observation: { action_id: step.action_id, run_id: 'wrong-run', input_fingerprint: 'sha256:wrong', port: 'current-mineru', output_inventory: [] }, run: { run_id: packet.run_id }, dispatchContext: {}, approvedBudget: packet.approved_budget_cap, retryPolicy: { max_retries: 0 } });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blocked_reason, 'EMITTED_STEP_PACKET_SCOPE_MISMATCH');
});

test('ingest blocks a cloned descriptor with a tampered nested packet scope', () => {
  const packet = packetFor({ sourcePath: 'fixtures/input.pdf', sourceBytes: Buffer.from('x'), outputRoot: 'fixtures/output' });
  const step = emitApprovedRunStep({ packet, run: { run_id: packet.run_id }, dispatchContext: { kind: 'opaque' }, approvedBudget: packet.approved_budget_cap, retryPolicy: { max_retries: 0 } });
  const tampered = structuredClone(step);
  tampered.source.path = 'fixtures/other.pdf';
  const result = ingestObservedRunStep({ packet, emittedStep: tampered, observation: { action_id: step.action_id, run_id: packet.run_id, input_fingerprint: step.input_fingerprint, port: 'current-mineru', output_inventory: [{ path: 'actual.json', sha256: hash(Buffer.from('actual')), byte_length: 6 }] }, run: { run_id: packet.run_id }, dispatchContext: {}, approvedBudget: packet.approved_budget_cap, retryPolicy: { max_retries: 0 } });
  assert.equal(result.blocked_reason, 'EMITTED_STEP_PACKET_SCOPE_MISMATCH');
});

test('finite role loop uses advanceRun and resumeRun in dependency order', async () => {
  const calls = [];
  const result = await runFiniteRoleSequence({ run: { run_id: 'r' }, dispatchContext: {}, artifactStore: {}, approvedBudget: { max_attempts: 1 }, retryPolicy: {},
    actions: [{ role: 'source-check', action: { type: 'seal_source_check' } }, { role: 'evidence', action: { type: 'write_artifact' } }, { role: 'methods', action: { type: 'write_artifact' } }, { role: 'results', action: { type: 'write_artifact' } }, { role: 'interpretation', action: { type: 'write_artifact' } }, { role: 'scientific-reading', action: { type: 'write_artifact' } }, { role: 'comparison', action: { type: 'compare' } }, { role: 'integration', action: { type: 'write_artifact' } }, { role: 'ledger', action: { type: 'compare' }, resume: true }],
    dependencies: { advanceRun: async ({ run, action }) => { calls.push(`advance:${action.type}`); return { ...run, action }; }, resumeRun: async ({ run }) => { calls.push('resume'); return { ...run, resumed: true }; } },
  });
  assert.deepEqual(calls, ['advance:seal_source_check', 'advance:write_artifact', 'advance:write_artifact', 'advance:write_artifact', 'advance:write_artifact', 'advance:write_artifact', 'advance:compare', 'advance:write_artifact', 'resume']);
  assert.equal(result.resumed, true);
});

test('finite role loop enters the actual Plan 04 broker, advanceRun, and resumeRun controls', async t => {
  const root = await mkdtemp(join(tmpdir(), 'phase21-role-controls-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const required = ['evidence', 'methods', 'results', 'interpretation', 'integration'].map(role => ({ artifact_id: `${role}-r1`, owner_actor_id: `${role}-agent`, path: `roles/${role}.json` }));
  const integration = { source_check_artifact_id: 'evidence-r1', analysis_draft_artifact_id: 'integration-r1', integration_artifact_id: 'integration-r1', approval_artifact_id: 'integration-r1' };
  const fingerprints = fingerprintSet('a');
  const bindings = required.map(item => ({ run_id: 'role-run', actor_id: item.owner_actor_id, role: item.artifact_id.replace('-r1', ''), artifact_path: item.path, revision: 'r1' }));
  const broker = createOwnedArtifactBroker({ control_actor_id: 'control', artifact_root: root, authorized_bindings: bindings, run_controls: [{ run_id: 'role-run', approved_fingerprints: fingerprints, required_artifacts: required, integration_prerequisites: integration }] });
  const schema = JSON.parse(await readFile(new URL('../../Schema/phase21/proof-chain.schema.json', import.meta.url), 'utf8'));
  const phase21Validator = await createPhase21ContractValidator({ schemas: [schema] });
  const run = { run_id: 'role-run', artifact_root: root, phase21Validator, declared_fingerprints: fingerprints, current_fingerprints: fingerprints, approved_budget: { max_attempts: 1 }, route_fingerprint: 'same', chain: { schema_version: 'phase21-proof-chain-1.0', run_id: 'role-run', delivery_status: 'pending_resolver', artifacts: [], dependencies: [{ artifact_id: 'upstream', fingerprints, status: 'current' }], required_artifacts: required, integration_prerequisites: integration, metadata: { requirement_refs: ['APA3-04'] }, p20_e12_status: 'unverified' } };
  const write = role => ({ type: 'write_artifact', actor_id: `${role}-agent`, role, artifact_path: `roles/${role}.json`, revision: 'r1', artifact: { artifact_id: `${role}-r1`, content: JSON.stringify({ role }) } });
  const result = await runFiniteRoleSequence({ run, dispatchContext: broker.dispatchContext, artifactStore: broker, approvedBudget: { max_attempts: 1 }, retryPolicy: { route_fingerprint: 'same', attempt: async () => ({ kind: 'recoverable_failure' }) }, actions: [
    { role: 'source-check', action: { type: 'seal_source_check' } }, { role: 'evidence', action: write('evidence') }, { role: 'methods', action: write('methods') }, { role: 'results', action: write('results') }, { role: 'interpretation', action: write('interpretation') }, { role: 'scientific-reading', action: { type: 'freeze_analysis_draft' } }, { role: 'comparison', action: { type: 'compare' } }, { role: 'integration', action: write('integration') }, { role: 'ledger', action: { type: 'compare' }, resume: true },
  ] });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blocked_reason, 'APPROVED_ATTEMPT_CAP_EXHAUSTED');
  assert.deepEqual(result.receipts.map(receipt => receipt.owner_actor_id), ['evidence-agent', 'methods-agent', 'results-agent', 'interpretation-agent', 'integration-agent']);
  assert.equal(await readFile(join(root, 'roles', 'evidence.json'), 'utf8'), JSON.stringify({ role: 'evidence' }));
});

test('finite role loop rejects a dependency-order bypass before Plan 04 action dispatch', async () => {
  await assert.rejects(() => runFiniteRoleSequence({ run: { run_id: 'r' }, dispatchContext: {}, artifactStore: {}, approvedBudget: {}, retryPolicy: {}, actions: [
    { role: 'methods', action: { type: 'write_artifact' } }, { role: 'source-check', action: { type: 'seal_source_check' } }, { role: 'evidence', action: { type: 'write_artifact' } }, { role: 'results', action: { type: 'write_artifact' } }, { role: 'interpretation', action: { type: 'write_artifact' } }, { role: 'scientific-reading', action: { type: 'freeze_analysis_draft' } }, { role: 'comparison', action: { type: 'compare' } }, { role: 'integration', action: { type: 'write_artifact' } }, { role: 'ledger', action: { type: 'compare' }, resume: true },
  ] }), /ROLE_SEQUENCE_INVALID/);
});

test('explicit verifier policy emits main reasoning and rejects role or profile mismatches',()=>{
 const packet=hostPacket();
 packet.role_model_policy={version:'apa-role-model-policy-1.0',main_session:{model:'gpt-6-astra',reasoning_effort:'high'}};
 packet.host_action_scope.role='source-check';
 packet.requested_model='gpt-6-astra';
 packet.host_action_scope.arguments.model='gpt-6-astra';
 packet.host_action_scope.arguments.reasoning_effort='high';
 assert.equal(emitApprovedRunStep(hostControls(packet)).arguments.reasoning_effort,'high');
 for(const role of ['scientific-audit','independent-verifier','bilingual-verifier','post-render-verifier']){
  const alias=structuredClone(packet);alias.host_action_scope.role=role;
  assert.equal(emitApprovedRunStep(hostControls(alias)).arguments.model,'gpt-6-astra');
 }
 for(const mutate of [
  p=>{delete p.role_model_policy;},
  p=>{p.role_model_policy.version='wrong';},
  p=>{p.host_action_scope.role='methods';},
  p=>{p.host_action_scope.arguments.reasoning_effort='medium';},
  p=>{delete p.host_action_scope.arguments.reasoning_effort;},
  p=>{p.requested_model='gpt-6.1-sol';p.host_action_scope.arguments.model='gpt-6.1-sol';},
 ]){
  const bad=structuredClone(packet);mutate(bad);
  assert.throws(()=>emitApprovedRunStep(hostControls(bad)));
 }
 const legacy=hostPacket();legacy.host_action_scope.arguments.reasoning_effort='high';
 assert.throws(()=>emitApprovedRunStep(hostControls(legacy)),/HOST_ARGUMENTS_INVALID/);
 assert.equal(emitApprovedRunStep(hostControls(hostPacket())).arguments.model,'gpt-5.6-terra');
});

test('removed parser role cannot dispatch', () => {
  const packet = hostPacket();
  packet.host_action_scope.role = 'parser-fidelity-check';
  assert.throws(() => emitApprovedRunStep(hostControls(packet)), /HOST_ROLE_REQUIRED/);
});
