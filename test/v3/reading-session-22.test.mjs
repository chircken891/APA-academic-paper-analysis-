import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { reviewedReadingFirstFixture } from './helpers/reading-first-publication-source-fixtures.mjs';
import { writeTranslationProgress } from '../../scripts/v3/reading-translation-progress.mjs';
import { createReadingSession, resumeReadingSession, nextReadingAction, recordReadingEvent } from '../../scripts/v3/reading-session.mjs';

async function configuredFixture(t) {
  // The copied runtime resolves the checkout's installed packages through its parent tree.
  const base = join(process.cwd(), '.tmp', 'apa-controller-handoff-20261031');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'session-22-'));
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
  const bytes = Buffer.from('synthetic source'), source = join(root, 'paper.pdf'); await writeFile(source, bytes);
  const scientificInput = { profile: 'reading-first-1.0', identity: { run_id: 'run', paper_id: 'pap_' + 'a'.repeat(32) }, sources: [{ id: 'paper', path: source, sha256: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), byte_length: bytes.length }], context: 'synthetic', role_artifacts: ['evidence', 'methods', 'results', 'interpretation', 'scientific-reading', 'integration'] };
  const evidence = { current_host: { name: profile.host, reference: 'test session' }, dispatch: { source: 'tool-schema', tool: 'Agent', reference: 'test schema' }, fresh_context: { source: 'host-docs', reference: 'test host docs', blank_context: true }, file_read: { status: 'pass', reference: 'test read' }, input: { status: 'pass', reference: 'test source and parser' } };
  const observedTool = { status: 'pass', source: 'tool-declaration', reference: 'synthetic', method: 'synthetic declaration', observation: 'declared available' };
  evidence.results_tools = { python: { ...observedTool, path: join(bin, process.platform === 'win32' ? 'python.exe' : 'python') }, libraries: { ...observedTool, names: ['fitz'] }, visual_read: observedTool, file_read: observedTool };
  return { root, profile, evidence, options: { repoRoot: root, runId: 'run', scientificInput, sourceLanguage: 'en', authorizationId: 'test', deadline: '2099-01-01T00:00:00Z', maxCalls: 8, maxTotalCalls: 14, sessionContext: { model: 'm', effort: 'high' }, hostProfile: profile, evidence, includeRepairs: true } };
}


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

test('runtime drift suspends dispatch and recovery requires an exact checkpoint approval', async t => {
  const f = await configuredFixture(t), runtime = join(f.root, 'runtime');
  await mkdir(runtime, { recursive: true });
  for (const directory of ['scripts', 'Schema', 'prompts']) await cp(join(process.cwd(), directory), join(runtime, directory), { recursive: true });
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

test('2.2 retains Results manifest and rejects changed resources on recovery', async t => {
  const f = await configuredFixture(t), template = await reviewedReadingFirstFixture(t, { controlOptions: { presentationProfile: 'reading-editor-1.3' } });
  f.profile.capabilities = { task_continuation: { status: 'detected', method: 'ContinueTask target prompt', scope: 'current-session', evidence: [{ source: 'tool-schema', reference: 'synthetic schema' }], limitations: [], continuation: { tool: 'ContinueTask', handle_argument: 'target', instruction_argument: 'prompt', same_context: true, original_host_accessible: true } } };
  let session = await createReadingSession({ ...f.options, instructionProfile: 'configured-reading-2.2', maxTotalCalls: 22 });
  const root = join(f.root, 'runs', 'run'), resourceRoot = join(root, 'resources', 'results');
  await mkdir(resourceRoot, { recursive: true }); await mkdir(join(root, 'native'), { recursive: true });
  const imagePath = join(resourceRoot, 'figure.png'), image = Buffer.from('synthetic figure'); await writeFile(imagePath, image);
  const hash = b => 'sha256:' + createHash('sha256').update(b).digest('hex');
  const source = f.options.scientificInput.sources[0];
  const row = { id: template.presentationCatalog.visuals[0].id, path: 'Figures/test/figure.png', source_id: source.id, source_path: imagePath, sha256: hash(image), byte_length: image.length, parent: source, locator: { kind: 'pdf-page', page: 1 } };
  const manifest = Buffer.from(JSON.stringify({ version: 'reading-resources-1.0', resources: [row] }));
  const ref = { path: join(root, 'science', 'results-resources.json'), resources_root: resourceRoot, sha256: hash(manifest), byte_length: manifest.length };
  await writeFile(join(root, 'native', 'results-resources.json'), manifest);
  const presentation = structuredClone(template.presentationCatalog);
  presentation.sources = [{ id: source.id, path: presentation.source_pdf, kind: 'main' }];
  presentation.visuals = [{ ...presentation.visuals[0], id: row.id, path: row.path, source_id: row.source_id, locator: row.locator }];
  for (let i = 0; i < 6; i++) {
    let action = await nextReadingAction(session);
    if (action.kind === 'compaction-observation') { await recordReadingEvent(session, { kind: 'compaction', input: { observation: { manual_compaction: { available: false, source: 'synthetic' } } } }); action = await nextReadingAction(session); }
    if (action.action === 'await-user') { await recordReadingEvent(session, { kind: 'compaction', input: { userDecision: 'skip' } }); action = await nextReadingAction(session); }
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
  if (next.kind === 'compaction-observation') { await recordReadingEvent(session, { kind: 'compaction', input: { observation: { manual_compaction: { available: false, source: 'synthetic' } } } }); next = await nextReadingAction(session); }
  if (next.action === 'await-user') { await recordReadingEvent(session, { kind: 'compaction', input: { userDecision: 'skip' } }); next = await nextReadingAction(session); }
  assert.equal(next.action, 'dispatch');
  async function hostObservation(action, label) {
    const raw = JSON.stringify({ agent_id: 'handle-' + label }), path = join(root, 'host-' + label + '.txt'); await writeFile(path, raw);
    return { action_id: action.action_id, run_id: action.run_id, input_fingerprint: action.input_fingerprint, port: action.port,
      tool_call: { name: action.host_action, arguments: action.arguments }, raw_result_text: raw, evidence: { kind: 'raw', capture: 'direct', sha256: hash(Buffer.from(raw)).slice(7), source_reference: path } };
  }
  const writerObservation = await hostObservation(next, 'writer');
  const { evidence: omitted, ...unknownWriterObservation } = writerObservation;
  await recordReadingEvent(session, { kind: 'host_observation', action_id: next.action_id, observation: unknownWriterObservation });
  assert.equal((await nextReadingAction(session)).action, 'reconcile');
  await recordReadingEvent(session, { kind: 'host_observation', action_id: next.action_id, observation: writerObservation });
  await writeFile(join(root, 'native', 'en.json'), JSON.stringify(template.views[0]));
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
  await recordReadingEvent(session, { kind: 'result', action_id: translation.action_id, observation: translationObservation });
  const editorAction = await nextReadingAction(session); assert.equal(editorAction.action, 'dispatch');
  const editorObservation = await hostObservation(editorAction, 'editor');
  await recordReadingEvent(session, { kind: 'host_observation', action_id: editorAction.action_id, observation: editorObservation });
  await writeFile(join(root, 'native', 'presentation.json'), JSON.stringify(template.editor));
  await recordReadingEvent(session, { kind: 'result', action_id: editorAction.action_id, observation: editorObservation });
  await recordReadingEvent(session, { kind: 'render-assets', renderOptions: {} });
  let reviewAction = await nextReadingAction(session);
  if (reviewAction.kind === 'compaction-observation') { await recordReadingEvent(session, { kind: 'compaction', input: { observation: { manual_compaction: { available: false, source: 'synthetic' } } } }); reviewAction = await nextReadingAction(session); }
  if (reviewAction.action === 'await-user') { await recordReadingEvent(session, { kind: 'compaction', input: { userDecision: 'skip' } }); reviewAction = await nextReadingAction(session); }
  assert.equal(reviewAction.action, 'dispatch');
  const reviewObservation = await hostObservation(reviewAction, 'review');
  await recordReadingEvent(session, { kind: 'host_observation', action_id: reviewAction.action_id, observation: reviewObservation });
  await writeFile(join(root, 'native', 'review.json'), JSON.stringify(template.review));
  await recordReadingEvent(session, { kind: 'result', action_id: reviewAction.action_id, observation: reviewObservation });
  assert.equal((await nextReadingAction(session)).status, 'reading_complete');
  await writeFile(imagePath, 'changed');
  await assert.rejects(() => resumeReadingSession({ runRoot: root }), /RF_RESOURCE_INVALID/);
});

test('2.2 preflight blocks dispatch without Results tool evidence and saves observed checks', async t => {
  const f = await configuredFixture(t), noTools = { ...f.evidence }; delete noTools.results_tools;
  const session = await createReadingSession({ ...f.options, instructionProfile: 'configured-reading-2.2', evidence: noTools });
  assert.equal((await nextReadingAction(session)).kind, 'runtime-evidence');
  await recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence });
  const seal = JSON.parse(await readFile(join(f.root, 'runs', 'run', 'control', 'reading-checkpoint-2.json'), 'utf8'));
  assert.deepEqual(seal.evidence.results_tools, f.evidence.results_tools);
});
