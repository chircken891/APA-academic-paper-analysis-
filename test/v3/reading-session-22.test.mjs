import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, appendFile, rm, readdir, chmod, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { reviewedReadingFirstFixture } from './helpers/reading-first-publication-source-fixtures.mjs';
import { applyReadingFirstFixture, readingFirstPublicationFixture } from './helpers/reading-first-publication-fixtures.mjs';
import { applyBilingualPublication } from '../../scripts/v3/phase22-publication.mjs';
import { fingerprintReadingFirst, inspectReadingFirstPublicationSource, restoreReadingFirstPublicationSource } from '../../scripts/v3/reading-first-runtime.mjs';
import { buildReadingFirstPublicationReview } from '../../scripts/v3/reading-first-publication.mjs';
import { publishReadingFirstCandidate } from '../../scripts/v3/reading-first-publish.mjs';
import { readRegisteredCommit } from '../../scripts/v3/phase22-active-version.mjs';
import { inspectV3Graph } from '../../scripts/v3/obsidian-graph.mjs';
import { checkCommittedIndex } from '../../scripts/check-bm25-index.mjs';
import { prepareReadingRuntimeSnapshot, readReadingRuntimeSnapshotReference, registerReadingRuntimeSnapshotReference } from '../../scripts/v3/reading-runtime-snapshot.mjs';
import { writeTranslationProgress } from '../../scripts/v3/reading-translation-progress.mjs';
import { executionBudgetSummary } from '../../scripts/v3/reading-execution-budget.mjs';
import { createReadingSession, resumeReadingSession, nextReadingAction, recordReadingEvent } from '../../scripts/v3/reading-session.mjs';

async function configuredFixture(t, { systemTemp = false, tempBase } = {}) {
  // The copied runtime resolves the checkout's installed packages through its parent tree.
  const base = tempBase ?? (systemTemp ? tmpdir() : join(process.cwd(), '.tmp', 'apa-controller-handoff-20261031'));
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'session-22-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (systemTemp) await symlink(join(process.cwd(), 'node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await mkdir(join(root, 'config'), { recursive: true });
  const parser = join(root, 'mineru'), bin = join(parser, 'venv', process.platform === 'win32' ? 'Scripts' : 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, process.platform === 'win32' ? 'python.exe' : 'python'), 'synthetic');
  await writeFile(join(parser, 'config.yaml'), 'synthetic');
  const dispatch = { tool: 'Agent', model_argument: 'model', effort_argument: 'effort', instruction_argument: 'prompt', task_name_argument: 'description', fresh_context: null, result_handle: { source: 'text', pattern: '"agent_id":"([^"]+)"' } };
  const profile = { schema_version: 'apa-host-profile-1.0', host: 'test-host', detected_at: '2026-10-30T10:00:00Z', session: { model: 'm', reasoning_effort: 'high' }, models: [{ model: 'm', reasoning_efforts: ['high'] }], dispatch, sources: { session: 'system-context', models: 'tool-schema', dispatch: 'tool-schema' } };
  const choice = { mode: 'explicit', model: 'm', reasoning_effort: 'high' };
  const config = { schema_version: 'apa-local-config-1.0', models: { science: choice, overrides: {}, roles: Object.fromEntries(['english-writer', 'chinese-writer', 'translation', 'reading-editor', 'independent-verifier'].map(role => [role, choice])) }, paths: { runs: 'runs', parse: 'parse', candidates: 'candidates' }, parser: { runtime_home: parser }, reading: { source_language: 'en', presentation_mode: 'reading-editor' }, writing_skills: Object.fromEntries(['nature-writing', 'nature-polishing', 'nature-shared', 'humanizer', 'humanizer-zh', 'stss'].map(key => [key, { enabled: false }])), host: { name: profile.host, dispatch } };
  await writeFile(join(root, 'config', 'apa.local.json'), JSON.stringify(config));
  await mkdir(join(root, 'Clippings'));
  const bytes = Buffer.from('synthetic source'), source = join(root, 'Clippings', 'paper.pdf'); await writeFile(source, bytes);
  const scientificInput = { profile: 'reading-first-1.0', identity: { run_id: 'run', paper_id: 'pap_' + 'a'.repeat(32) }, sources: [{ id: 'paper', path: source, sha256: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), byte_length: bytes.length }], context: 'synthetic', role_artifacts: ['evidence', 'methods', 'results', 'interpretation', 'scientific-reading', 'integration'] };
  const evidence = { current_host: { name: profile.host, reference: 'test session' }, dispatch: { source: 'tool-schema', tool: 'Agent', reference: 'test schema' }, fresh_context: { source: 'host-docs', reference: 'test host docs', blank_context: true }, file_read: { status: 'pass', reference: 'test read' }, input: { status: 'pass', reference: 'test source and parser' } };
  const observedTool = { status: 'pass', source: 'tool-declaration', reference: 'synthetic', method: 'synthetic declaration', observation: 'declared available' };
  evidence.results_tools = { python: { ...observedTool, path: join(bin, process.platform === 'win32' ? 'python.exe' : 'python') }, libraries: { ...observedTool, names: ['fitz'] }, visual_read: observedTool, file_read: observedTool };
  return { root, profile, evidence, options: { repoRoot: root, runId: 'run', scientificInput, sourceLanguage: 'en', authorizationId: 'test', deadline: '2099-01-01T00:00:00Z', maxCalls: 8, maxTotalCalls: 14, sessionContext: { model: 'm', effort: 'high' }, hostProfile: profile, evidence, includeRepairs: true } };
}

test('the 1.4 presentation binding preserves 2.2 session preparation, budget and stage reminders', async t => {
  const f = await configuredFixture(t, { systemTemp: true });
  const session = await createReadingSession({ ...f.options, instructionProfile: 'configured-reading-2.2' });
  const root = join(f.root, 'runs', 'run');
  const readState = async () => JSON.parse(await readFile(join(root, 'control', 'science-state.json'), 'utf8')).data;
  const initial = await readState();
  const binding = initial.prepared.runControl.reading_first_binding;
  assert.equal(binding.configured_setup.instruction_profile, 'configured-reading-2.2');
  assert.equal(binding.configured_setup.dispatch_message_profile, 'instruction-path-1.0');
  assert.deepEqual([binding.prior_calls, binding.max_calls, binding.max_total_calls], [6, 8, 14]);
  assert.deepEqual(Object.values(binding.task_bindings).map(task => [task.task_id, task.role, task.artifact_path]), [
    ['en', 'english-writer', 'reading/en.json'], ['en-r2', 'english-writer', 'reading/en-r2.json'],
    ['zh-CN', 'translation', 'reading/zh-CN.json'], ['zh-CN-r2', 'translation', 'reading/zh-CN-r2.json'],
    ['review', 'independent-verifier', 'reading/review.json'], ['review-r2', 'independent-verifier', 'reading/review-r2.json'],
    ['presentation', 'reading-editor', 'reading/presentation.json'], ['presentation-r2', 'reading-editor', 'reading/presentation-r2.json'],
  ]);
  assert.deepEqual(initial.executionLedger, []);
  const dispatch = await nextReadingAction(session);
  assert.equal(dispatch.action, 'dispatch');
  assert.equal(dispatch.role, 'evidence');
  const instructionPath = join(root, 'instructions', 'evidence.txt');
  const instructions = await readFile(instructionPath);
  assert.equal(dispatch.arguments.prompt, instructionPath);
  assert.ok(instructions.toString('utf8').includes(join(root, 'native', 'evidence.json')));
  const raw = JSON.stringify({ agent_id: 'synthetic-evidence' });
  const rawPath = join(root, 'evidence-return.txt');
  await writeFile(rawPath, raw);
  const observation = {
    action_id: dispatch.action_id, run_id: dispatch.run_id, input_fingerprint: dispatch.input_fingerprint, port: dispatch.port,
    tool_call: { name: dispatch.host_action, arguments: dispatch.arguments }, raw_result_text: raw,
    evidence: { kind: 'raw', capture: 'direct', sha256: createHash('sha256').update(raw).digest('hex'), source_reference: rawPath },
  };
  await writeFile(instructionPath, Buffer.concat([instructions, Buffer.from('changed')]));
  await assert.rejects(() => recordReadingEvent(session, { kind: 'host_observation', action_id: dispatch.action_id, observation }), /APA_CONFIGURED_DISPATCH_MISMATCH/);
  await writeFile(instructionPath, instructions);
  await recordReadingEvent(session, { kind: 'host_observation', action_id: dispatch.action_id, observation });
  await mkdir(join(root, 'native'), { recursive: true });
  await writeFile(join(root, 'native', 'evidence.json'), JSON.stringify({ role: 'evidence' }));
  await writeFile(instructionPath, Buffer.concat([instructions, Buffer.from('changed')]));
  await assert.rejects(() => recordReadingEvent(session, { kind: 'result', action_id: dispatch.action_id, observation }), /APA_CONFIGURED_DISPATCH_MISMATCH/);
  await writeFile(instructionPath, instructions);
  await recordReadingEvent(session, { kind: 'result', action_id: dispatch.action_id, observation });
  const budget = { total_used: 1, initial_dispatches: 1, continuations: 0, reserved: 0, occupied: 1, total_limit: 14, remaining_total: 13 };
  assert.deepEqual(executionBudgetSummary((await readState()).executionLedger, binding.max_total_calls), budget);
  const reminder = await nextReadingAction(session);
  assert.equal(reminder.action, 'await-user');
  assert.equal(reminder.kind, 'compaction-reminder');
  assert.equal(reminder.boundary_id, 'evidence-accepted');
  const next = await nextReadingAction(session);
  assert.equal(next.action, 'dispatch');
  assert.equal(next.role, 'methods');
  const resumed = await readState();
  assert.equal(resumed.compaction_reminders, undefined);
  assert.equal(resumed.executionLedger.filter(row => row.task_id === 'evidence').length, 1);
  assert.equal(binding.presentation_profile, 'reading-editor-1.4');
});

test('2.2 rejects receipt without verified host evidence and blocks untrusted assets', async t => {
  const f = await configuredFixture(t), session = await createReadingSession({ ...f.options, instructionProfile: 'configured-reading-2.2' });
  const action = await nextReadingAction(session);
  assert.equal(action.action, 'dispatch');
  const observation = { action_id: action.action_id, run_id: action.run_id, input_fingerprint: action.input_fingerprint, port: action.port,
    tool_call: { name: action.host_action, arguments: action.arguments }, raw_result_text: '{\"agent_id\":\"synthetic\"}' };
  await recordReadingEvent(session, { kind: 'host_observation', action_id: action.action_id, observation });
  assert.equal((await nextReadingAction(session)).action, 'reconcile');
  await assert.rejects(() => recordReadingEvent(session, { kind: 'render-assets', resources: [], renderOptions: {} }), /READING_SESSION_RESOURCE_INPUT_INVALID/);
});

test('2.2 persists render parameters and reloads them across resume', async t => {
  const f = await configuredFixture(t); let session = await createReadingSession({ ...f.options, instructionProfile: 'configured-reading-2.2' });
  await recordReadingEvent(session, { kind: 'render-assets', renderOptions: { existingTargets: ['one'] } });
  const root = join(f.root, 'runs', 'run');
  const saved = JSON.parse(await readFile(join(root, 'control', 'session-state-1.json'), 'utf8'));
  assert.deepEqual(saved.render_options, { existingTargets: ['one'] });
  session = await resumeReadingSession({ runRoot: root });
  await recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence });
  await recordReadingEvent(session, { kind: 'render-assets', renderOptions: { existingTargets: ['two'] } });
  const next = JSON.parse(await readFile(join(root, 'control', 'session-state-2.json'), 'utf8'));
  assert.deepEqual(next.render_options, { existingTargets: ['two'] });
});

test('session CLI uses frozen code, validates batch rebind scope, and refuses a changed snapshot', async t => {
  const f = await configuredFixture(t, { systemTemp: true }), runtime = join(f.root, 'runtime');
  for (const directory of ['scripts', 'Schema', 'prompts', 'docs/apa-v3']) {
    await cp(join(process.cwd(), directory), join(runtime, directory), { recursive: true });
  }
  await cp(join(process.cwd(), 'package.json'), join(runtime, 'package.json'));
  const cli = join(runtime, 'scripts/v3/reading-session-cli.mjs');
  const runRoot = join(f.root, 'runs', 'run'), exportDir = join(f.root, '.tmp', 'exports');
  const runCli = (command, args, input, error) => {
    const result = spawnSync(process.execPath, [cli, command, ...args], { encoding: 'utf8', input });
    if (error) {
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, error);
      return;
    }
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const first = runCli('create', ['--export-dir', exportDir], JSON.stringify(f.options));
  assert.equal(first.action, 'dispatch');
  const state = JSON.parse(await readFile(join(runRoot, 'control', 'science-state.json'), 'utf8'));
  const runtimeBinding = state.data.prepared.runControl.reading_first_binding.configured_setup.runtime_binding;
  assert.equal(runtimeBinding.profile, 'reading-runtime-snapshot-1.0');
  assert.equal(runtimeBinding.data_root, f.root);
  assert.equal(runtimeBinding.repo_root.startsWith(join(f.root, '.runtime', 'apa-code')), true);
  const checkoutSession = join(runtime, 'scripts/v3/reading-session.mjs');
  const changedFiles = [checkoutSession, join(runtime, 'scripts/v3/reading-runtime-binding.mjs'), join(runtime, 'scripts/v3/reading-runtime-cleanup.mjs')];
  const originals = await Promise.all(changedFiles.map(path => readFile(path)));
  for (const path of changedFiles) await appendFile(path, '\nthrow new Error("checkout runtime loaded");\n');
  const event = (input, error) => runCli('event', ['--run-root', runRoot, '--input', '-'], JSON.stringify(input), error);
  const evidence = event({ kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence });
  assert.equal(evidence.status, 'pass');
  event({ kind: 'terminate', authorization_id: 'synthetic-pending-terminate', user_reply: '终止' }, /READING_SESSION_TERMINAL_HOST_ACTIVE/);
  const next = runCli('next', ['--run-root', runRoot, '--export-dir', exportDir]);
  assert.equal(next.action, 'provide-input');
  assert.equal(next.kind, 'runtime-evidence');
  await Promise.all(changedFiles.map((path, index) => writeFile(path, originals[index])));
  await appendFile(join(runtime, 'scripts/lib/reading-resource-tool.py'), '\n# synthetic rebind\n');
  const api = await import(pathToFileURL(checkoutSession).href);
  const session = await api.resumeReadingSession({ runRoot });
  const { checkpoint_fingerprint, current_snapshot_hash, ...scope } = await api.recordReadingEvent(session, { kind: 'inspect-runtime-rebind' });
  const testEvidence = Buffer.from('synthetic scoped tests passed');
  const testPath = join(f.root, 'test-evidence.txt');
  await writeFile(testPath, testEvidence);
  const approval = { ...scope, authorization_id: 'synthetic-rebind', run_ids: ['run', 'another-run'],
    checkpoint_fingerprints: { run: checkpoint_fingerprint, 'another-run': 'sha256:' + 'a'.repeat(64) },
    test_evidence: [{ path: testPath, sha256: 'sha256:' + createHash('sha256').update(testEvidence).digest('hex'), byte_length: testEvidence.length }] };
  await assert.rejects(api.recordReadingEvent(session, { kind: 'rebind', approval: { ...approval, checkpoint_fingerprints: { ...approval.checkpoint_fingerprints, run: 'sha256:' + 'b'.repeat(64) } } }), /READING_SESSION_APPROVAL_INVALID/);
  assert.equal((await api.recordReadingEvent(session, { kind: 'rebind', approval })).code, 'READING_SESSION_RUNTIME_RESTART_REQUIRED');
  const metadataPath = join(runRoot, 'control', 'session-state-1.json');
  const metadata = await readFile(metadataPath);
  const rebound = JSON.parse(metadata).approvals[0].current;
  const location = { repoRoot: f.root, runId: 'run', runRoot };
  // Simulate interruption after the receipt was committed but before the pending reference was promoted.
  registerReadingRuntimeSnapshotReference({ ...location, manifest: runtimeBinding, expectedFingerprint: rebound.fingerprint });
  registerReadingRuntimeSnapshotReference({ ...location, manifest: rebound, expectedFingerprint: runtimeBinding.fingerprint, pending: true,
    pendingCheckpoint: { artifact_id: 'session-state-1', sha256: 'sha256:' + createHash('sha256').update(metadata).digest('hex'), byte_length: metadata.length } });
  assert.equal((await api.nextReadingAction(await api.resumeReadingSession({ runRoot }))).code, 'READING_SESSION_RUNTIME_RESTART_REQUIRED');
  assert.equal(readReadingRuntimeSnapshotReference(location).fingerprint, rebound.fingerprint);
  assert.equal(readReadingRuntimeSnapshotReference(location).pending_manifest, undefined);
  assert.deepEqual(await readFile(metadataPath), metadata);
  assert.equal(event({ kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence }).status, 'pass');
  assert.equal(rebound.snapshot_hash, current_snapshot_hash);
  assert.notEqual(rebound.repo_root, runtimeBinding.repo_root);
  const changed = join(rebound.repo_root, 'scripts/lib/reading-resource-tool.py');
  await chmod(changed, 0o644);
  await appendFile(changed, '\n# changed after snapshot\n');
  event({ kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence }, /READING_RUNTIME_SNAPSHOT_INVALID|READING_RUNTIME_SNAPSHOT_CHANGED/);
});

test('runtime drift suspends dispatch and recovery requires an exact checkpoint approval', async t => {
  const f = await configuredFixture(t), runtime = join(f.root, 'runtime');
  await mkdir(runtime, { recursive: true });
  for (const directory of ['scripts', 'Schema', 'prompts']) await cp(join(process.cwd(), directory), join(runtime, directory), { recursive: true });
  // Build a pre-snapshot run through the original live-binding creation behavior.
  const sessionPath = join(runtime, 'scripts/v3/reading-session.mjs');
  const sessionSource = await readFile(sessionPath, 'utf8');
  await writeFile(sessionPath, sessionSource.replace('execution ??= await prepareReadingSessionExecution(options);', 'if (!execution) return createSession(options);'));
  const configuredPath = join(runtime, 'scripts/v3/configured-reading.mjs');
  const configuredSource = await readFile(configuredPath, 'utf8');
  await writeFile(configuredPath, configuredSource.replace('import { inspectReadingRuntime }', 'import { captureReadingRuntime, inspectReadingRuntime }')
    .replace('runtimeBinding ?? prepareReadingRuntimeSnapshot({ repoRoot, codeRoot: CODE_ROOT, runRoot: paths.runRoot, runId: options.runId })', 'runtimeBinding ?? captureReadingRuntime()'));
  const api = await import(pathToFileURL(join(runtime, 'scripts/v3/reading-session.mjs')).href);
  let session = await api.createReadingSession({ ...f.options, instructionProfile: 'configured-reading-2.2' });
  const first = await api.nextReadingAction(session); assert.equal(first.action, 'dispatch');
  await appendFile(join(runtime, 'scripts/lib/reading-resource-tool.py'), '\n# synthetic drift\n');
  const drift = await api.nextReadingAction(session);
  assert.equal(drift.code, 'READING_SESSION_RUNTIME_DRIFT');
  await assert.rejects(() => api.recordReadingEvent(session, { kind: 'result', action_id: first.action_id, observation: {} }), /READING_SESSION_RUNTIME_DRIFT/);
  const evidencePath = join(runtime, 'test-evidence.txt'), evidence = Buffer.from('synthetic test passed');
  await writeFile(evidencePath, evidence);
  const approval = { authorization_id: 'repair-1', run_id: 'run', checkpoint_fingerprint: drift.checkpoint_fingerprint,
    previous_runtime_fingerprint: drift.runtime.previous.fingerprint, current_runtime_fingerprint: drift.runtime.current.fingerprint,
    changed_files: drift.runtime.changed_files, test_evidence: [{ path: evidencePath, sha256: 'sha256:' + createHash('sha256').update(evidence).digest('hex'), byte_length: evidence.length }] };
  await assert.rejects(() => api.recordReadingEvent(session, { kind: 'runtime-repair-approval', approval: { ...approval, checkpoint_fingerprint: 'wrong' } }), /READING_SESSION_APPROVAL_INVALID/);
  session = await api.resumeReadingSession({ runRoot: join(f.root, 'runs', 'run') });
  assert.equal((await api.nextReadingAction(session)).code, 'READING_SESSION_RUNTIME_DRIFT');
  assert.equal((await api.recordReadingEvent(session, { kind: 'runtime-repair-approval', approval })).recorded, true);
  assert.equal((await api.nextReadingAction(session)).kind, 'runtime-evidence');
  await api.recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence });
  assert.equal((await api.nextReadingAction(session)).action, 'reconcile');
  session = await api.resumeReadingSession({ runRoot: join(f.root, 'runs', 'run') });
  assert.equal((await api.nextReadingAction(session)).kind, 'runtime-evidence');
  await appendFile(join(runtime, 'scripts/lib/mineru-parse.py'), '\n# second synthetic drift\n');
  const second = await api.nextReadingAction(session);
  const secondApproval = { ...approval, authorization_id: 'repair-2', checkpoint_fingerprint: second.checkpoint_fingerprint, previous_runtime_fingerprint: second.runtime.previous.fingerprint, current_runtime_fingerprint: second.runtime.current.fingerprint, changed_files: second.runtime.changed_files };
  assert.equal((await api.recordReadingEvent(session, { kind: 'runtime-repair-approval', approval: secondApproval })).recorded, true);
  session = await api.resumeReadingSession({ runRoot: join(f.root, 'runs', 'run') });
  await appendFile(join(runtime, 'scripts/lib/apa-config.mjs'), '\n// third synthetic drift\n');
  const third = await api.nextReadingAction(session);
  const thirdApproval = { ...approval, authorization_id: 'repair-3', checkpoint_fingerprint: third.checkpoint_fingerprint, previous_runtime_fingerprint: third.runtime.previous.fingerprint, current_runtime_fingerprint: third.runtime.current.fingerprint, changed_files: third.runtime.changed_files };
  assert.equal((await api.recordReadingEvent(session, { kind: 'runtime-repair-approval', approval: thirdApproval })).code, 'READING_SESSION_RUNTIME_RESTART_REQUIRED');
  assert.equal((await api.nextReadingAction(session)).code, 'READING_SESSION_RUNTIME_RESTART_REQUIRED');
  await writeFile(evidencePath, 'changed');
  await assert.rejects(() => api.resumeReadingSession({ runRoot: join(f.root, 'runs', 'run') }), /READING_SESSION_APPROVAL_INVALID/);
});

test('an explicitly terminated session releases its snapshot and refuses resumption', async t => {
  const f = await configuredFixture(t, { systemTemp: true });
  const session = await createReadingSession(f.options), runRoot = join(f.root, 'runs', 'run');
  const saved = JSON.parse(await readFile(join(runRoot, 'control', 'science-state.json'), 'utf8'));
  const manifest = saved.data.prepared.runControl.reading_first_binding.configured_setup.runtime_binding;
  const authorization = { authorization_id: 'synthetic-terminate', user_reply: '终止' };
  await assert.rejects(recordReadingEvent(session, { kind: 'close-with-limits', ...authorization }), /READING_SESSION_TERMINAL_STATUS_INVALID/);
  const closed = await recordReadingEvent(session, { kind: 'terminate', ...authorization });
  assert.equal(closed.terminal.status, 'terminated');
  assert.equal(closed.cleanup.snapshot_status, 'removed');
  await assert.rejects(readFile(join(manifest.code_root, 'package.json')), { code: 'ENOENT' });
  await assert.rejects(resumeReadingSession({ runRoot }), /READING_SESSION_TERMINATED/);
  assert.deepEqual(await recordReadingEvent(session, { kind: 'terminate', ...authorization }), closed);
});

test('rebind checkpoint exhaustion leaves no pending snapshot and the run can still close', async t => {
  const f = await configuredFixture(t, { systemTemp: true }), runtime = join(f.root, 'runtime');
  for (const directory of ['scripts', 'Schema', 'prompts', 'docs/apa-v3']) {
    await cp(join(process.cwd(), directory), join(runtime, directory), { recursive: true });
  }
  await cp(join(process.cwd(), 'package.json'), join(runtime, 'package.json'));
  const api = await import(pathToFileURL(join(runtime, 'scripts/v3/reading-session.mjs')).href);
  const location = { repoRoot: f.root, runId: 'run', runRoot: join(f.root, 'runs', 'run') };
  const session = await api.createReadingSession({ ...f.options, maxControlCheckpoints: 4 });
  for (let i = 0; i < 4; i++) {
    await api.recordReadingEvent(session, { kind: 'render-assets', renderOptions: { existingTargets: [`fixture-${i}`] } });
  }
  await writeFile(join(runtime, 'docs/apa-v3/rebind-fixture.md'), 'synthetic changed runtime');
  const { current_snapshot_hash, ...scope } = await api.recordReadingEvent(session, { kind: 'inspect-runtime-rebind' });
  const evidence = Buffer.from('synthetic regression passed'), evidencePath = join(f.root, 'rebind-evidence.txt');
  await writeFile(evidencePath, evidence);
  const approval = { ...scope, run_id: 'run', authorization_id: 'synthetic-rebind-capacity', test_evidence: [{
    path: evidencePath, sha256: 'sha256:' + createHash('sha256').update(evidence).digest('hex'), byte_length: evidence.length }] };
  await assert.rejects(api.recordReadingEvent(session, { kind: 'rebind', approval }), { code: 'CONTROL_CHECKPOINT_CAPACITY' });
  const active = readReadingRuntimeSnapshotReference(location);
  assert.equal(active.pending_manifest, undefined);
  assert.equal((await readdir(join(f.root, '.runtime', 'apa-code'))).includes(current_snapshot_hash.slice(7)), false);

  // A different interruption can leave a pending reference before any receipt exists.
  const abandoned = prepareReadingRuntimeSnapshot({ ...location, codeRoot: runtime });
  registerReadingRuntimeSnapshotReference({ ...location, manifest: abandoned, expectedFingerprint: active.fingerprint, pending: true });
  await api.resumeReadingSession({ runRoot: location.runRoot, readOnly: true });
  assert.equal(readReadingRuntimeSnapshotReference(location).pending_manifest.fingerprint, abandoned.fingerprint);
  const resumed = await api.resumeReadingSession({ runRoot: location.runRoot });
  const recovered = readReadingRuntimeSnapshotReference(location);
  assert.equal(recovered.fingerprint, active.fingerprint);
  assert.equal(recovered.pending_manifest, undefined);
  assert.ok(recovered.previous_manifests.some(item => item.fingerprint === abandoned.fingerprint));
  const closed = await api.recordReadingEvent(resumed, { kind: 'terminate', authorization_id: 'synthetic-capacity-close', user_reply: '终止' });
  assert.equal(closed.cleanup.snapshot_status, 'removed');
  assert.ok(closed.cleanup.snapshots.some(item => item.snapshot_hash === abandoned.snapshot_hash && item.status === 'removed'));
});

test('interrupted rebind preserves only the registered unreceipted metadata bytes', async t => {
  const f = await configuredFixture(t, { systemTemp: true });
  const location = { repoRoot: f.root, runId: 'run', runRoot: join(f.root, 'runs', 'run') };
  await createReadingSession(f.options);
  const active = readReadingRuntimeSnapshotReference(location);
  const codeRoot = join(f.root, 'pending-source');
  for (const directory of ['scripts', 'Schema', 'prompts', 'docs/apa-v3']) await mkdir(join(codeRoot, directory), { recursive: true });
  await writeFile(join(codeRoot, 'package.json'), '{"name":"pending-fixture"}');
  const pending = prepareReadingRuntimeSnapshot({ ...location, codeRoot });
  const partial = Buffer.from('synthetic bytes written before the owned receipt');
  const digest = createHash('sha256').update(partial).digest('hex');
  registerReadingRuntimeSnapshotReference({ ...location, manifest: pending, expectedFingerprint: active.fingerprint, pending: true,
    pendingCheckpoint: { artifact_id: 'session-state-1', sha256: 'sha256:' + digest, byte_length: partial.length } });
  const original = join(location.runRoot, 'control', 'session-state-1.json');
  const abandoned = original + '.abandoned-' + digest;
  await writeFile(original, 'unrelated bytes');
  await assert.rejects(resumeReadingSession({ runRoot: location.runRoot }), /READING_SESSION_CHECKPOINT_ORPHAN/);
  assert.equal(await readFile(original, 'utf8'), 'unrelated bytes');
  await assert.rejects(readFile(abandoned), { code: 'ENOENT' });
  await writeFile(original, partial);
  const resumed = await resumeReadingSession({ runRoot: location.runRoot });
  assert.deepEqual(await readFile(abandoned), partial);
  const mapping = JSON.parse(await readFile(abandoned + '.json', 'utf8'));
  assert.equal(mapping.original_path, 'control/session-state-1.json');
  assert.equal(mapping.archive_path, 'control/session-state-1.json.abandoned-' + digest);
  await assert.rejects(readFile(original), { code: 'ENOENT' });
  await recordReadingEvent(resumed, { kind: 'render-assets', renderOptions: { existingTargets: ['restored-slot'] } });
  assert.deepEqual(JSON.parse(await readFile(original, 'utf8')).render_options.existingTargets, ['restored-slot']);
  assert.equal(readReadingRuntimeSnapshotReference(location).pending_manifest, undefined);
});

for (const repairResources of [false, true]) test(`2.2 retains Results resources${repairResources ? ' with a scoped renderer repair' : ''} across recovery`, async t => {
  const f = await configuredFixture(t, { systemTemp: true }), template = await reviewedReadingFirstFixture(t, { controlOptions: { presentationProfile: 'reading-editor-1.4' } });
  f.profile.capabilities = { task_continuation: { status: 'detected', method: 'ContinueTask target prompt', scope: 'current-session', evidence: [{ source: 'tool-schema', reference: 'synthetic schema' }], limitations: [], continuation: { tool: 'ContinueTask', handle_argument: 'target', instruction_argument: 'prompt', same_context: true, original_host_accessible: true } } };
  let session = await createReadingSession({ ...f.options, instructionProfile: 'configured-reading-2.2', maxTotalCalls: 22 });
  const root = join(f.root, 'runs', 'run'), resourceRoot = join(root, 'resources', 'results');
  await mkdir(resourceRoot, { recursive: true }); await mkdir(join(root, 'native'), { recursive: true });
  const imagePath = join(resourceRoot, 'figure.png'), image = Buffer.from('synthetic figure'); await writeFile(imagePath, image);
  const hash = b => 'sha256:' + createHash('sha256').update(b).digest('hex');
  const source = f.options.scientificInput.sources[0];
  const row = { id: template.presentationCatalog.visuals[0].id, path: 'Figures/run/figure.png', source_id: source.id, source_path: imagePath, sha256: hash(image), byte_length: image.length, parent: source, locator: { kind: 'pdf-page', page: 1 } };
  const manifest = Buffer.from(JSON.stringify({ version: 'reading-resources-1.0', resources: [row] }));
  const ref = { path: join(root, 'science', 'results-resources.json'), resources_root: resourceRoot, sha256: hash(manifest), byte_length: manifest.length };
  await writeFile(join(root, 'native', 'results-resources.json'), manifest);
  const presentation = structuredClone(template.presentationCatalog);
  presentation.source_pdf = 'Clippings/paper.pdf';
  const incomingKnowledge = presentation.knowledge[0];
  incomingKnowledge.id = 'incoming-method';
  incomingKnowledge.canonical_key = 'incoming-canonical-method';
  for (const view of template.views) view.placements.knowledge[0].id = incomingKnowledge.id;
  for (const language of Object.keys(template.editor.languages)) {
    template.editor.languages[language].methods[0].knowledge_id = incomingKnowledge.id;
  }
  template.editor.views_fingerprint = fingerprintReadingFirst(template.views);
  presentation.sources = [{ id: source.id, path: presentation.source_pdf, kind: 'main' }];
  presentation.visuals = [{ ...presentation.visuals[0], id: row.id, path: row.path, source_id: row.source_id, locator: row.locator }];
  for (let i = 0; i < 6; i++) {
    let action = await nextReadingAction(session);
    if (action.kind === 'compaction-reminder') action = await nextReadingAction(session);
    assert.equal(action.action, 'dispatch');
    const raw = JSON.stringify({ agent_id: 'agent-' + i }), evidencePath = join(root, 'host-' + i + '.txt'); await writeFile(evidencePath, raw);
    const observation = { action_id: action.action_id, run_id: action.run_id, input_fingerprint: action.input_fingerprint, port: action.port,
      tool_call: { name: action.host_action, arguments: action.arguments }, raw_result_text: raw, evidence: { kind: 'raw', capture: 'direct', sha256: hash(Buffer.from(raw)).slice(7), source_reference: evidencePath } };
    await recordReadingEvent(session, { kind: 'host_observation', action_id: action.action_id, observation });
    const content = action.role === 'results' ? { role: action.role, resource_manifest: ref } : action.role === 'integration' ? { role: action.role, presentation, visual_handoff: { resource_manifest: ref } } : { role: action.role };
    await writeFile(join(root, 'native', action.role + '.json'), JSON.stringify(content));
    await recordReadingEvent(session, { kind: 'result', action_id: action.action_id, observation });
  }
  let next = await nextReadingAction(session);
  if (next.kind === 'compaction-reminder') next = await nextReadingAction(session);
  assert.equal(next.action, 'dispatch');
  async function hostObservation(action, label) {
    const raw = JSON.stringify({ agent_id: 'handle-' + label }), path = join(root, 'host-' + label + '.txt'); await writeFile(path, raw);
    return { action_id: action.action_id, run_id: action.run_id, input_fingerprint: action.input_fingerprint, port: action.port,
      tool_call: { name: action.host_action, arguments: action.arguments }, raw_result_text: raw, evidence: { kind: 'raw', capture: 'direct', sha256: hash(Buffer.from(raw)).slice(7), source_reference: path } };
  }
  const writerObservation = await hostObservation(next, 'writer');
  const writerInstructionPath = join(root, 'instructions', 'en.txt');
  const writerInstructions = await readFile(writerInstructionPath);
  assert.equal(next.arguments.prompt, writerInstructionPath);
  assert.ok(writerInstructions.toString('utf8').includes(join(root, 'native', 'en.json')));
  for (const changes of [
    { prompt: writerInstructionPath + '.bak' },
    { prompt: writerInstructionPath + '\n' + join(root, 'instructions', 'zh-CN.txt') },
    { description: 'wrong_task' },
    { model: 'other-model' },
    { effort: 'low' },
    { extra: true },
  ]) {
    const observation = { ...writerObservation, tool_call: { ...writerObservation.tool_call, arguments: { ...next.arguments, ...changes } } };
    await assert.rejects(() => recordReadingEvent(session, { kind: 'host_observation', action_id: next.action_id, observation }), /OBSERVATION_CORRELATION_MISMATCH/);
  }
  writerObservation.tool_call.arguments = { ...next.arguments, prompt: ' \t' + writerInstructionPath + '\r\n' };
  const { evidence: omitted, ...unknownWriterObservation } = writerObservation;
  await recordReadingEvent(session, { kind: 'host_observation', action_id: next.action_id, observation: unknownWriterObservation });
  assert.equal((await nextReadingAction(session)).action, 'reconcile');
  await assert.rejects(recordReadingEvent(session, { kind: 'continuation-intent', action_id: next.action_id, execution_id: 'unknown-writer', message: 'Continue.' }), /READING_SESSION_CONTINUATION_INVALID/);
  await writeFile(writerInstructionPath, Buffer.concat([writerInstructions, Buffer.from('changed')]));
  await assert.rejects(() => recordReadingEvent(session, { kind: 'host_observation', action_id: next.action_id, observation: writerObservation }), /READING_FIRST_INSTRUCTION_CHANGED/);
  await writeFile(writerInstructionPath, writerInstructions);
  await recordReadingEvent(session, { kind: 'host_observation', action_id: next.action_id, observation: writerObservation });
  await writeFile(join(root, 'native', 'en.json'), JSON.stringify(template.views[0]));
  await writeFile(writerInstructionPath, Buffer.concat([writerInstructions, Buffer.from('changed')]));
  await assert.rejects(() => recordReadingEvent(session, { kind: 'result', action_id: next.action_id, observation: writerObservation }), /READING_FIRST_INSTRUCTION_CHANGED/);
  await writeFile(writerInstructionPath, writerInstructions);
  await recordReadingEvent(session, { kind: 'result', action_id: next.action_id, observation: writerObservation });
  session = await resumeReadingSession({ runRoot: root });
  await recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence });
  const translation = await nextReadingAction(session); assert.equal(translation.action, 'dispatch');
  const translationObservation = await hostObservation(translation, 'translation');
  await recordReadingEvent(session, { kind: 'host_observation', action_id: translation.action_id, observation: translationObservation });
  const science = JSON.parse(await readFile(join(root, 'control', 'science-state.json'), 'utf8'));
  const task = science.data.prepared.runControl.reading_first_binding.task_bindings['zh-CN'];
  const partial = { ...structuredClone(template.views[1]), sections: [], knowledge_content: [] };
  await writeFile(join(root, task.native_path), JSON.stringify(partial));
  writeTranslationProgress({ artifactRoot: root, task, runId: 'run', sourceView: template.views[0], nativeOutput: partial });
  await recordReadingEvent(session, { kind: 'continuation-intent', action_id: translation.action_id, execution_id: 'first-zero', message: 'Continue.' });
  const continuation = await nextReadingAction(session); assert.equal(continuation.kind, 'continuation');
  const raw = 'continuation returned without progress', path = join(root, 'host-continuation.txt'); await writeFile(path, raw);
  await recordReadingEvent(session, { kind: 'continuation-receipt', execution_id: 'first-zero', observation: { execution_id: 'first-zero', action_id: continuation.action_id,
    agent_id: continuation.host_handle, tool_call: { name: continuation.host_action, arguments: continuation.arguments }, raw_result_text: raw, status: 'observed',
    evidence: { kind: 'raw', capture: 'direct', sha256: hash(Buffer.from(raw)).slice(7), source_reference: path } } });
  const stop = await recordReadingEvent(session, { kind: 'continuation-intent', action_id: translation.action_id, execution_id: 'second-zero', message: 'Continue.' });
  assert.equal(stop.code, 'READING_TRANSLATION_ZERO_PROGRESS');
  session = await resumeReadingSession({ runRoot: root });
  await recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence });
  assert.equal((await nextReadingAction(session)).code, 'READING_TRANSLATION_ZERO_PROGRESS');
  await writeFile(join(root, task.native_path), JSON.stringify(template.views[1]));
  writeTranslationProgress({ artifactRoot: root, task, runId: 'run', sourceView: template.views[0], nativeOutput: template.views[1] });
  const ready = await recordReadingEvent(session, { kind: 'continuation-intent', action_id: translation.action_id, execution_id: 'already-translated', message: 'Continue if needed.' });
  assert.equal(ready.action, 'provide-input');
  assert.equal(ready.kind, 'accept-translation');
  assert.equal((await nextReadingAction(session)).action, 'provide-input');
  await rm(join(root, task.native_path));
  await assert.rejects(recordReadingEvent(session, { kind: 'result', action_id: translation.action_id, observation: translationObservation }), /ENOENT/);
  await writeFile(join(root, task.native_path), JSON.stringify(template.views[1]));
  const notContent = await recordReadingEvent(session, { kind: 'continuation-intent', action_id: translation.action_id, execution_id: 'not-content', message: 'Finalize.' });
  assert.equal(notContent.kind, 'accept-translation');
  const invalid = structuredClone(template.views[1]);
  invalid.placements = { ...(invalid.placements ?? {}), visuals: [...(invalid.placements?.visuals ?? []), { id: 'extra-visual', section_id: 'nowhere' }] };
  await writeFile(join(root, task.native_path), JSON.stringify(invalid));
  await assert.rejects(recordReadingEvent(session, { kind: 'result', action_id: translation.action_id, observation: translationObservation }), /READING_FIRST_VIEW_/);
  await recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: { ...f.profile, capabilities: {} }, evidence: f.evidence });
  const noHost = await recordReadingEvent(session, { kind: 'continuation-intent', action_id: translation.action_id, execution_id: 'no-host', message: 'Finalize.' });
  assert.equal(noHost.kind, 'host-continuation');
  await recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence });
  await recordReadingEvent(session, { kind: 'continuation-intent', action_id: translation.action_id, execution_id: 'finalize-1', message: 'Finalize.' });
  const finalize = await nextReadingAction(session); assert.equal(finalize.kind, 'continuation');
  assert.match(JSON.stringify(finalize.arguments), /previous final output was rejected/);
  const finalRaw = 'finalized again', finalPath = join(root, 'host-finalize.txt'); await writeFile(finalPath, finalRaw);
  await recordReadingEvent(session, { kind: 'continuation-receipt', execution_id: 'finalize-1', observation: { execution_id: 'finalize-1', action_id: finalize.action_id,
    agent_id: finalize.host_handle, tool_call: { name: finalize.host_action, arguments: finalize.arguments }, raw_result_text: finalRaw, status: 'observed',
    evidence: { kind: 'raw', capture: 'direct', sha256: hash(Buffer.from(finalRaw)).slice(7), source_reference: finalPath } } });
  await assert.rejects(recordReadingEvent(session, { kind: 'result', action_id: translation.action_id, observation: translationObservation }));
  assert.equal((await nextReadingAction(session)).code, 'READING_TRANSLATION_FINAL_INVALID');
  const controlFiles = async () => (await readdir(join(root, 'control'))).length;
  const filesBefore = await controlFiles();
  await assert.rejects(recordReadingEvent(session, { kind: 'result', action_id: translation.action_id, observation: translationObservation }));
  assert.equal(await controlFiles(), filesBefore);
  const exhausted = await recordReadingEvent(session, { kind: 'continuation-intent', action_id: translation.action_id, execution_id: 'finalize-2', message: 'Finalize.' });
  assert.equal(exhausted.code, 'READING_TRANSLATION_FINAL_INVALID');
  await writeFile(join(root, task.native_path), JSON.stringify(template.views[1]));
  await recordReadingEvent(session, { kind: 'result', action_id: translation.action_id, observation: translationObservation });
  const editorAction = await nextReadingAction(session); assert.equal(editorAction.action, 'dispatch');
  const editorObservation = await hostObservation(editorAction, 'editor');
  await recordReadingEvent(session, { kind: 'host_observation', action_id: editorAction.action_id, observation: editorObservation });
  await writeFile(join(root, 'native', 'presentation.json'), JSON.stringify(template.editor));
  await recordReadingEvent(session, { kind: 'result', action_id: editorAction.action_id, observation: editorObservation });
  await recordReadingEvent(session, { kind: 'render-assets', renderOptions: {} });
  const prior = await readingFirstPublicationFixture(t, { vaultRoot: f.root, paperId: 'pap_' + 'b'.repeat(32),
    title: { en: 'Earlier registered study', 'zh-CN': '已登记的研究' } });
  await applyBilingualPublication(applyReadingFirstFixture(prior));
  const target = 'Wiki/methods/合成方法.md';
  const registered = await readFile(join(f.root, target));
  const resolution = { authorization_id: 'approved-reuse', knowledge_id: 'incoming-method',
    from_canonical_key: 'incoming-canonical-method', to_canonical_key: 'synthetic-method', target_path: target };
  await assert.rejects(recordReadingEvent(session, { kind: 'knowledge-identity-resolution',
    resolution: { ...resolution, target_path: 'Wiki/methods/unregistered.md' } }), { code: 'READING_FIRST_KNOWLEDGE_RESOLUTION_INVALID' });
  assert.deepEqual(await recordReadingEvent(session, { kind: 'knowledge-identity-resolution', resolution }), { recorded: true });
  session = await resumeReadingSession({ runRoot: root });
  await recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence });
  assert.deepEqual(await recordReadingEvent(session, { kind: 'knowledge-identity-resolution', resolution }), { recorded: false });
  let reviewAction = await nextReadingAction(session);
  const preview = await readFile(join(f.root, 'candidates', 'run', target), 'utf8');
  assert.match(preview, /supportonlytoken/);
  assert.match(preview, /Earlier registered study · English/);
  assert.match(preview, /Synthetic publication study · English/);
  assert.deepEqual(await readFile(join(f.root, target)), registered);
  if (reviewAction.kind === 'compaction-reminder') reviewAction = await nextReadingAction(session);
  assert.equal(reviewAction.action, 'dispatch');
  const reviewObservation = await hostObservation(reviewAction, 'review');
  await recordReadingEvent(session, { kind: 'host_observation', action_id: reviewAction.action_id, observation: reviewObservation });
  const review = structuredClone(template.review);
  if (repairResources) {
    review.overall.complete = false;
    review.issues = [{ severity: 'material', kind: 'layout', detail: 'The figure top was cropped.', repair_owner: 'renderer',
      affected_paths: template.candidate.notes.map(note => note.path), affected_languages: ['en', 'zh-CN'],
      repair_scope: { status: 'located', section_ids: ['findings'], knowledge_ids: [], visual_ids: [row.id], editor_fields: [] } }];
  }
  await writeFile(join(root, 'native', 'review.json'), JSON.stringify(review));
  await recordReadingEvent(session, { kind: 'result', action_id: reviewAction.action_id, observation: reviewObservation });
  if (repairResources) {
    assert.equal((await nextReadingAction(session)).kind, 'renderer-repair');
    const repairedRoot = join(root, 'resources', 'renderer-repair'); await mkdir(repairedRoot);
    const repairedPath = join(repairedRoot, 'figure-repaired.png'), bytes = Buffer.from('Complete synthetic figure');
    await writeFile(repairedPath, bytes);
    const replacement = { ...row, path: 'Figures/run/figure-repaired.png', source_path: repairedPath,
      sha256: hash(bytes), byte_length: bytes.length, locator: { ...row.locator, rect: [0, 0, 100, 100] } };
    const repair = { resources_root: repairedRoot, resources: [replacement] };
    await assert.rejects(recordReadingEvent(session, { kind: 'renderer-repair', resourceRepair: { ...repair,
      resources: [{ ...replacement, path: 'Figures/other/figure-repaired.png' }] } }), /RF_RESOURCE_INVALID/);
    await assert.rejects(recordReadingEvent(session, { kind: 'renderer-repair', resourceRepair: { ...repair,
      resources: [{ ...replacement, id: 'unreviewed' }] } }), /READING_FIRST_RESOURCE_REPAIR_INVALID/);
    await assert.rejects(recordReadingEvent(session, { kind: 'renderer-repair', resourceRepair: { ...repair,
      resources: [{ ...replacement, locator: { kind: 'pdf-page', page: 2 } }] } }), /READING_FIRST_RESOURCE_REPAIR_INVALID/);
    await recordReadingEvent(session, { kind: 'renderer-repair', resourceRepair: repair });
    session = await resumeReadingSession({ runRoot: root });
    await recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence });
    await recordReadingEvent(session, { kind: 'renderer-repair', resourceRepair: repair });
    await assert.rejects(recordReadingEvent(session, { kind: 'renderer-repair', resourceRepair: { ...repair,
      resources: [{ ...replacement, path: 'Figures/run/conflicting.png' }] } }), /READING_FIRST_RESOURCE_REPAIR_CONFLICT/);
    const local = await nextReadingAction(session); assert.equal(local.action, 'dispatch');
    const repairedNotes = await Promise.all(template.candidate.notes.map(note => readFile(join(f.root, 'candidates', 'run-r2', note.path), 'utf8')));
    for (const note of repairedNotes) assert.match(note, /figure-repaired\.png/);
    const originalNotes = await Promise.all(template.candidate.notes.map(note => readFile(join(f.root, 'candidates', 'run', note.path), 'utf8')));
    for (const note of originalNotes) assert.doesNotMatch(note, /figure-repaired\.png/);
    assert.deepEqual(await readFile(ref.path), manifest);
    assert.deepEqual(await readFile(imagePath), image);
    const localObservation = await hostObservation(local, 'local-review');
    await recordReadingEvent(session, { kind: 'host_observation', action_id: local.action_id, observation: localObservation });
    await writeFile(join(root, 'native', 'review-r2.json'), JSON.stringify(template.review));
    await recordReadingEvent(session, { kind: 'result', action_id: local.action_id, observation: localObservation });
    const completed = await nextReadingAction(session); assert.equal(completed.status, 'reading_complete');
    const sourceData = await inspectReadingFirstPublicationSource(completed.publication_source);
    assert.equal(sourceData.results_resource_manifest.resources[0].path, row.path);
    assert.deepEqual(sourceData.results_resource_manifest.resource_repair.resources, [replacement]);
    const publicationResources = [{ path: presentation.source_pdf, source_path: source.path,
      sha256: source.sha256, byte_length: source.byte_length }, replacement];
    await buildReadingFirstPublicationReview({ source: completed.publication_source, vaultRoot: f.root,
      generation: 'repaired-generation', evidenceMode: 'synthetic', resources: publicationResources });
    await writeFile(repairedPath, 'tampered');
    await assert.rejects(resumeReadingSession({ runRoot: root }), /RF_RESOURCE_INVALID/);
    await writeFile(repairedPath, bytes);
  }
  assert.equal((await nextReadingAction(session)).status, 'reading_complete');
  session = await resumeReadingSession({ runRoot: root });
  await recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence });
  assert.equal((await nextReadingAction(session)).status, 'reading_complete');
  await writeFile(imagePath, 'changed');
  await assert.rejects(() => resumeReadingSession({ runRoot: root }), /RF_RESOURCE_INVALID/);
  if (!repairResources) {
    await writeFile(imagePath, image);
    const completed = await nextReadingAction(session);
    const data = await inspectReadingFirstPublicationSource(completed.publication_source);
    const frozenTool = data.tool_bindings.find(item => item.path.startsWith(data.recipe.execution_runtime.code_root));
    assert.ok(frozenTool);
    const restoredSource = await restoreReadingFirstPublicationSource(data.recipe);
    assert.equal((await inspectReadingFirstPublicationSource(restoredSource)).origin, 'registered');
    const publication = await publishReadingFirstCandidate({ source: completed.publication_source, vaultRoot: f.root, generation: 'frozen-reading-generation',
      evidenceMode: 'synthetic', resources: [{ path: presentation.source_pdf, source_path: source.path, sha256: source.sha256, byte_length: source.byte_length }, row],
      authorization: { authorization_id: 'synthetic-frozen-publication', user_reply: '发布' }, onPrepared: () => assert.rejects(
        recordReadingEvent(session, { kind: 'terminate', authorization_id: 'synthetic-conflicting-close', user_reply: '终止' }), { code: 'READING_RUNTIME_CONSUMER_ACTIVE' }) });
    assert.equal(publication.status, 'committed');
    assert.equal(publication.runtime_cleanup?.snapshot_status, 'removed', JSON.stringify(publication.runtime_cleanup));
    assert.ok(publication.runtime_cleanup.archives.some(item => item.kind === 'science-host-record'));
    assert.ok(publication.runtime_cleanup.archives.some(item => item.kind === 'reading-host-record'));
    await assert.rejects(readFile(frozenTool.path), { code: 'ENOENT' });
    assert.equal((await readRegisteredCommit({ vaultRoot: f.root })).ok, true);
    assert.equal((await checkCommittedIndex(f.root)).status, 'registered_index_valid');
    assert.equal((await inspectV3Graph({ vaultRoot: f.root, checkConfiguration: false })).ok, true);
  }
});

test('2.2 preflight blocks dispatch without Results tool evidence and saves observed checks', async t => {
  const f = await configuredFixture(t), noTools = { ...f.evidence }; delete noTools.results_tools;
  const session = await createReadingSession({ ...f.options, instructionProfile: 'configured-reading-2.2', evidence: noTools });
  assert.equal((await nextReadingAction(session)).kind, 'runtime-evidence');
  await recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence });
  const seal = JSON.parse(await readFile(join(f.root, 'runs', 'run', 'control', 'reading-checkpoint-2.json'), 'utf8'));
  assert.deepEqual(seal.evidence.results_tools, f.evidence.results_tools);
});
