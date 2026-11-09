import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { copyFile, mkdtemp, mkdir, writeFile, readFile, readdir, rename, rm, symlink, unlink } from 'node:fs/promises';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { inspectReadingFirstPublicationSource } from '../../scripts/v3/reading-first-runtime.mjs';
import * as readingRuntime from '../../scripts/v3/reading-first-runtime.mjs';
import { createOwnedArtifactBroker, commitOwnedArtifact, readOwnedArtifact } from '../../scripts/v3/owned-artifact-store.mjs';
import { readingFirstViewsFingerprint } from '../../scripts/v3/reading-first-editor.mjs';
import { buildReadingSessionTasks } from '../../scripts/v3/reading-session-tasks.mjs';
import { createReadingSession, resumeReadingSession, nextReadingAction as nextAction, recordReadingEvent } from '../../scripts/v3/reading-session.mjs';
import { reviewedReadingFirstFixture } from './helpers/reading-first-publication-source-fixtures.mjs';
import { applyReadingFirstFixture, readingFirstPublicationFixture } from './helpers/reading-first-publication-fixtures.mjs';
import { applyBilingualPublication } from '../../scripts/v3/phase22-publication.mjs';
import { publishReadingFirstCandidate } from '../../scripts/v3/reading-first-publish.mjs';
import { readingFirstIndexFixture } from './helpers/reading-first-index-fixtures.mjs';
import { writeTranslationProgress } from '../../scripts/v3/reading-translation-progress.mjs';

const continuationCapability = () => ({ status: 'detected', method: 'ContinueTask target prompt', scope: 'current-session',
  evidence: [{ source: 'tool-schema', reference: 'synthetic ContinueTask schema' }], limitations: [],
  continuation: { tool: 'ContinueTask', handle_argument: 'target', instruction_argument: 'prompt', same_context: true, original_host_accessible: true } });

// 2.2 accepts only host receipts whose raw text is captured in an absolute evidence file.
const receiptRoot = mkdtempSync(join(tmpdir(), 'apa-session-receipts-'));
after(() => rmSync(receiptRoot, { recursive: true, force: true }));
const withEvidence = observation => {
  const sha256 = createHash('sha256').update(observation.raw_result_text, 'utf8').digest('hex'), path = join(receiptRoot, sha256 + '.txt');
  writeFileSync(path, observation.raw_result_text);
  return { ...observation, evidence: { kind: 'raw', capture: 'direct', sha256, source_reference: path } };
};
const observe = (action, handle = 'host-' + action.action_id) => withEvidence({ action_id: action.action_id, run_id: action.run_id, input_fingerprint: action.input_fingerprint, port: action.port,
  tool_call: { name: action.host_action, arguments: action.arguments }, raw_result_text: JSON.stringify({ agent_id: handle }) });

const configuredSessionTemplate = async t => {
  const fixture = await reviewedReadingFirstFixture(t, {
    figurePath: 'Figures/run/figure.png', controlOptions: { presentationProfile: 'reading-editor-1.4' },
  });
  return { ...fixture, presentationCatalog: { ...fixture.presentationCatalog, source_pdf: 'Clippings/paper.pdf' } };
};

// 2.2 Results register a resource manifest and Integration hands off the matching visuals.
async function scienceOutputs(f, catalog) {
  const runRoot = join(f.root, 'runs', 'run'), resourceRoot = join(runRoot, 'resources', 'results'), source = f.options.scientificInput.sources[0];
  await mkdir(resourceRoot, { recursive: true }); await mkdir(join(runRoot, 'native'), { recursive: true });
  const image = Buffer.from('synthetic figure'), imagePath = join(resourceRoot, 'figure.png'); await writeFile(imagePath, image);
  const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
  const presentation = catalog ? structuredClone(catalog) : { visuals: [] };
  presentation.sources = [{ id: source.id, path: 'Clippings/paper.pdf', kind: 'main' }];
  presentation.visuals = presentation.visuals.map(visual => ({ ...visual, source_id: source.id, locator: { kind: 'pdf-page', page: 1 } }));
  const rows = presentation.visuals.map(visual => ({ id: visual.id, path: visual.path, source_id: source.id, source_path: imagePath, sha256: sha(image), byte_length: image.length, parent: source, locator: visual.locator }));
  const manifest = Buffer.from(JSON.stringify({ version: 'reading-resources-1.0', resources: rows }));
  await writeFile(join(runRoot, 'native', 'results-resources.json'), manifest);
  const ref = { path: join(runRoot, 'science', 'results-resources.json'), resources_root: resourceRoot, sha256: sha(manifest), byte_length: manifest.length };
  return (role, extra = {}) => ({ role, text: 'synthetic', ...(role === 'results' ? { resource_manifest: ref } : role === 'integration' ? { presentation, visual_handoff: { resource_manifest: ref } } : {}), ...extra });
}

test('2.2 continuation is budgeted before dispatch, emitted once and reconciled after recovery', async t => {
  const f = await configuredFixture(t);
  f.profile.capabilities = { task_continuation: continuationCapability() };
  let session = await createReadingSession(f.options);
  const first = await nextAction(session);
  await recordReadingEvent(session, { kind: 'host_observation', action_id: first.action_id, observation: observe(first, 'original-task') });
  const intent = { kind: 'continuation-intent', action_id: first.action_id, execution_id: 'continue-1', message: 'Finish the original evidence output.' };
  assert.deepEqual(await recordReadingEvent(session, intent), await recordReadingEvent(session, intent));
  const continuation = await nextAction(session);
  assert.equal(continuation.kind, 'continuation');
  assert.equal(continuation.host_action, 'ContinueTask');
  assert.equal(continuation.arguments.target, 'original-task');
  assert.equal(continuation.summary.budget.total_used, 2);
  assert.equal(continuation.summary.budget.continuations, 1);
  assert.equal((await nextAction(session)).action, 'reconcile');
  session = await resumeReadingSession({ runRoot: join(f.root, 'runs', 'run') });
  await recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence });
  assert.equal((await nextAction(session)).action, 'reconcile');
  const receipt = { kind: 'continuation-receipt', execution_id: 'continue-1', observation: withEvidence({ execution_id: 'continue-1', action_id: continuation.action_id,
    agent_id: 'original-task', tool_call: { name: continuation.host_action, arguments: continuation.arguments }, raw_result_text: 'continued', status: 'observed' }) };
  assert.deepEqual(await recordReadingEvent(session, receipt), await recordReadingEvent(session, receipt));
  assert.equal((await nextAction(session)).action, 'wait');
  assert.equal((await nextAction(session)).summary.budget.total_used, 2);
  await assert.rejects(() => recordReadingEvent(session, { ...receipt, observation: { ...receipt.observation, agent_id: 'different' } }));
});

test('unsupported continuation spends no budget and retired bindings are refused', async t => {
  const f = await configuredFixture(t), session = await createReadingSession(f.options);
  const first = await nextAction(session);
  await recordReadingEvent(session, { kind: 'host_observation', action_id: first.action_id, observation: observe(first, 'original-task') });
  const result = await recordReadingEvent(session, { kind: 'continuation-intent', action_id: first.action_id, execution_id: 'continue-1', message: 'Continue.' });
  assert.equal(result.action, 'provide-input');
  assert.equal(result.code, 'HOST_CONTINUATION_UNKNOWN');
  assert.equal((await nextAction(session)).summary.budget.occupied, 1);
  const old = await configuredFixture(t);
  for (const instructionProfile of ['configured-reading-2.0', 'configured-reading-2.1']) await assert.rejects(() => createReadingSession({ ...old.options, instructionProfile }), /READING_BINDING_RETIRED/);
});

for (const retries of [1,2]) test('translation continuation preserves completed fragments and projects '+retries+' observed calls',async t=>{
  const f = await configuredFixture(t), template = await configuredSessionTemplate(t);
  f.profile.capabilities = { task_continuation: continuationCapability() };
  let session = await createReadingSession({ ...f.options, maxTotalCalls:14 });
  const runRoot = join(f.root, 'runs', 'run'), content = await scienceOutputs(f, template.presentationCatalog);
  const accept = async (action, path, value) => {
    const observation = observe(action);
    await recordReadingEvent(session, { kind: 'host_observation', action_id: action.action_id, observation });
    await writeFile(join(runRoot, 'native', path + '.json'), JSON.stringify(value));
    return recordReadingEvent(session, { kind: 'result', action_id: action.action_id, observation });
  };
  for (let i = 0; i < 6; i++) {
    const action = await nextReadingAction(session);
    await accept(action, action.role, content(action.role));
  }
  await accept(await nextReadingAction(session), 'en', template.views[0]);
  const translation = await nextReadingAction(session), original = observe(translation);
  await recordReadingEvent(session, { kind: 'host_observation', action_id: translation.action_id, observation: original });
  const science = JSON.parse(await readFile(join(runRoot, 'control', 'science-state.json'), 'utf8'));
  const task = science.data.prepared.runControl.reading_first_binding.task_bindings['zh-CN'];
  const instruction = await readFile(join(runRoot, task.instruction_path), 'utf8');
  const packet = JSON.parse(instruction.split('\n\n').at(-1));
  assert.ok(packet.source_view_ref.path.endsWith('.json'));
  assert.equal(packet.source_view, undefined);
  assert.equal(packet.translation_context, undefined);
  assert.doesNotMatch(instruction, new RegExp(template.views[0].sections[0].paragraphs[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const partial = { ...structuredClone(template.views[1]), sections: structuredClone(template.views[1].sections.slice(0, 1)), knowledge_content: [] };
  await writeFile(join(runRoot, task.native_path), JSON.stringify(partial));
  const baseline = writeTranslationProgress({ artifactRoot: runRoot, task, runId: 'run', sourceView: template.views[0], nativeOutput: partial });
  const intent = { kind: 'continuation-intent', action_id: translation.action_id, execution_id: 'translate-rest', message: 'Complete the original translation.' };
  await recordReadingEvent(session, intent);
  session = await resumeReadingSession({ runRoot });
  await recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence });
  const continuation = await nextReadingAction(session);
  const scope = JSON.parse(continuation.arguments.prompt.split('\n').at(-1));
  assert.deepEqual(scope.remaining_sections, baseline.remaining_sections);
  assert.deepEqual(scope.remaining_knowledge, baseline.remaining_knowledge);
  assert.ok(!scope.remaining_sections.includes(partial.sections[0].id));
  assert.equal(continuation.summary.budget.total_used, 9);
  const receipt = { kind: 'continuation-receipt', execution_id: 'translate-rest', observation: withEvidence({ execution_id: 'translate-rest', action_id: continuation.action_id,
    agent_id: continuation.host_handle, tool_call: { name: continuation.host_action, arguments: continuation.arguments }, raw_result_text: 'finished', status: 'observed' }) };
  const changed = structuredClone(partial); changed.sections[0].paragraphs[0] += ' changed';
  await writeFile(join(runRoot, task.native_path), JSON.stringify(changed));
  await assert.rejects(() => recordReadingEvent(session, receipt), /READING_TRANSLATION_PROGRESS_RECONCILE/);
  const nextPartial={...partial,sections:structuredClone(template.views[1].sections.slice(0,2))};
  const firstResult=retries===1 ? template.views[1] : nextPartial;
  await writeFile(join(runRoot,task.native_path),JSON.stringify(firstResult));
  writeTranslationProgress({artifactRoot:runRoot,task,runId:'run',sourceView:template.views[0],nativeOutput:firstResult});
  await recordReadingEvent(session,receipt);
  if (retries===2) {
    await recordReadingEvent(session,{...intent,execution_id:'translate-finish'});
    const second=await nextReadingAction(session);
    await writeFile(join(runRoot,task.native_path),JSON.stringify(template.views[1]));
    writeTranslationProgress({artifactRoot:runRoot,task,runId:'run',sourceView:template.views[0],nativeOutput:template.views[1]});
    await recordReadingEvent(session,{kind:'continuation-receipt',execution_id:'translate-finish',observation:withEvidence({
      execution_id:'translate-finish',action_id:second.action_id,agent_id:second.host_handle,
      tool_call:{name:second.host_action,arguments:second.arguments},raw_result_text:'finished',status:'observed',
    })});
  }
  await recordReadingEvent(session,{kind:'result',action_id:translation.action_id,observation:original});
  await accept(await nextReadingAction(session),'presentation',template.editor);
  await recordReadingEvent(session,{kind:'render-assets',renderOptions:{}});
  const issue={severity:'material',kind:'scientific_limitation',detail:'Clarify findings.',repair_owner:'writer',
    affected_languages:['en','zh-CN'],repair_scope:{status:'located',section_ids:['findings'],knowledge_ids:[],visual_ids:[],editor_fields:[]}};
  await accept(await nextReadingAction(session),'review',{...template.review,issues:[issue]});
  const plan=(await nextReadingAction(session)).continuation;
  assert.equal(plan.required_additional_calls,retries);
  assert.equal(plan.translation_allowance,retries);
  assert.equal(plan.recommended_additional_calls,2*retries);
});

async function startSyntheticDrafting(t) {
  const f = await configuredFixture(t, { systemTemp: true }), template = await configuredSessionTemplate(t);
  f.profile.capabilities = { task_continuation: continuationCapability() };
  const session = await createReadingSession(f.options);
  const runRoot = join(f.root, 'runs', 'run'), content = await scienceOutputs(f, template.presentationCatalog);
  const resultEvent = (action, observation = observe(action)) => ({ kind: 'result', action_id: action.action_id, observation });
  const accept = async (currentSession, action, path, value) => {
    const event = resultEvent(action);
    await recordReadingEvent(currentSession, { ...event, kind: 'host_observation' });
    await writeFile(join(runRoot, 'native', path + '.json'), JSON.stringify(value));
    return recordReadingEvent(currentSession, event);
  };
  for (let i = 0; i < 6; i++) {
    const action = await nextReadingAction(session);
    await accept(session, action, action.role, content(action.role));
  }
  await accept(session, await nextReadingAction(session), 'en', template.views[0]);
  return { f, template, session, runRoot, accept, resultEvent };
}

test('finalize-only continuation dispatches the reserved execution after interrupted stop cleanup', async t => {
  const { f, template, session, runRoot, accept, resultEvent } = await startSyntheticDrafting(t);
  const translation = await nextReadingAction(session), event = resultEvent(translation);
  await recordReadingEvent(session, { ...event, kind: 'host_observation' });
  const control = join(runRoot, 'control');
  const science = JSON.parse(await readFile(join(control, 'science-state.json'), 'utf8'));
  const task = science.data.prepared.runControl.reading_first_binding.task_bindings['zh-CN'];
  const native = join(runRoot, task.native_path);
  const rejected = { ...template.views[1], language: 'en' };
  await writeFile(native, JSON.stringify(rejected));
  const progress = writeTranslationProgress({ artifactRoot: runRoot, task, runId: 'run', sourceView: template.views[0], nativeOutput: rejected });
  assert.deepEqual([progress.remaining_sections, progress.remaining_knowledge], [[], []]);
  const intent = { kind: 'continuation-intent', action_id: translation.action_id, execution_id: 'inspect-complete', message: 'Finalize the original translation.' };
  assert.equal((await recordReadingEvent(session, intent)).kind, 'accept-translation');
  await assert.rejects(() => recordReadingEvent(session, event), { code: 'READING_FIRST_VIEW_INVALID' });
  const before = await nextReadingAction(session);
  assert.equal(before.kind, 'accept-translation');
  const metadataFiles = async () => (await readdir(control)).filter(name => /^session-state-\d+\.json$/.test(name));
  assert.deepEqual((await metadataFiles()).sort(), ['session-state-1.json', 'session-state-2.json']);

  const finalizeIntent = { ...intent, execution_id: 'finalize-original' };
  const originalLink = fs.promises.link;
  const fault = t.mock.method(fs.promises, 'link', async (from, to) => {
    if (to === join(control, 'session-state-3.json')) throw Object.assign(new Error('Injected session metadata write failure'), { code: 'EIO' });
    return originalLink(from, to);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(() => recordReadingEvent(session, finalizeIntent), { code: 'EIO' });
    assert.equal(fault.mock.calls.filter(call => call.arguments[1] === join(control, 'session-state-3.json')).length, 1);
  } finally {
    fault.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal((await nextAction(session)).code, 'READING_SESSION_RESTORE_REQUIRED');
  assert.deepEqual((await metadataFiles()).sort(), ['session-state-1.json', 'session-state-2.json']);

  const recovered = await resumeReadingSession({ runRoot });
  await recordReadingEvent(recovered, { kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence });
  assert.deepEqual(await recordReadingEvent(recovered, finalizeIntent), {
    recorded: true, execution_id: finalizeIntent.execution_id, status: 'prepared',
  });
  const finalize = await nextReadingAction(recovered);
  assert.equal(finalize.action, 'dispatch');
  assert.equal(finalize.kind, 'continuation');
  assert.equal(finalize.original_action_id, translation.action_id);
  assert.equal(finalize.execution_id, finalizeIntent.execution_id);
  assert.equal(finalize.summary.budget.total_limit, before.summary.budget.total_limit);
  assert.equal(finalize.summary.budget.occupied, before.summary.budget.occupied + 1);
  assert.equal(finalize.summary.budget.total_used, before.summary.budget.total_used + 1);
  assert.equal(finalize.summary.budget.continuations, 1);
  assert.equal(finalize.summary.budget.reserved, 0);
  assert.equal((await nextAction(recovered)).code, 'HOST_CONTINUATION_OUTCOME_UNKNOWN');

  await writeFile(native, JSON.stringify(template.views[1]));
  await recordReadingEvent(recovered, {
    kind: 'continuation-receipt', execution_id: finalize.execution_id,
    observation: withEvidence({ execution_id: finalize.execution_id, action_id: finalize.action_id, agent_id: finalize.host_handle,
      tool_call: { name: finalize.host_action, arguments: finalize.arguments }, raw_result_text: 'Final translation corrected', status: 'observed' }),
  });
  assert.equal((await recordReadingEvent(recovered, event)).status, 'pending_presentation');
  await accept(recovered, await nextReadingAction(recovered), 'presentation', template.editor);
  await recordReadingEvent(recovered, { kind: 'render-assets', renderOptions: {} });
  await accept(recovered, await nextReadingAction(recovered), 'review', template.review);
  const done = await nextReadingAction(recovered);
  assert.equal(done.status, 'reading_complete');
  assert.equal(done.summary.budget.continuations, 1);
});

test('Editor structural rejection provides a CLI and API continuation on the original action', async t => {
  const { f, template, session, runRoot, accept, resultEvent } = await startSyntheticDrafting(t);
  await accept(session, await nextReadingAction(session), 'zh-CN', template.views[1]);
  const editor = await nextReadingAction(session), event = resultEvent(editor);
  await recordReadingEvent(session, { ...event, kind: 'host_observation' });
  const native = join(runRoot, 'native', 'presentation.json'), invalid = structuredClone(template.editor);
  invalid.languages.en.overview = [];
  await writeFile(native, JSON.stringify(invalid));

  const cli = fileURLToPath(new URL('../../scripts/v3/reading-session-cli.mjs', import.meta.url));
  const input = join(f.root, 'editor-result.json'), runtime = join(f.root, 'runtime-evidence.json');
  await writeFile(runtime, JSON.stringify({ kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence }));
  const cliEvent = async value => {
    await writeFile(input, JSON.stringify(value));
    return promisify(execFile)(process.execPath, [cli, 'event', '--run-root', runRoot, '--input', input, '--runtime-input', runtime]);
  };
  const code = 'READING_FIRST_EDITOR_CONTENT_INVALID';
  const recovery = { action: 'continuation-intent', action_id: editor.action_id, code };
  await assert.rejects(() => recordReadingEvent(session, event), { code, recovery });
  assert.equal((await nextAction(session)).action, 'wait');
  assert.equal(await readOwnedArtifact({ artifactRoot: runRoot, artifactId: 'reading-presentation' }), null);
  await assert.rejects(() => cliEvent(event), error => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, '');
    assert.deepEqual(JSON.parse(error.stderr), { code, message: code, recovery });
    return true;
  });
  await assert.rejects(() => cliEvent({ ...event, action_id: 'unknown-action' }), error => {
    assert.equal(error.code, 1);
    assert.equal(error.stderr, 'READING_SESSION_EVENT_ACTION_INVALID\n');
    return true;
  });

  const recovered = await resumeReadingSession({ runRoot });
  await recordReadingEvent(recovered, { kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence });
  const executionId = 'complete-original-editor';
  await recordReadingEvent(recovered, { kind: recovery.action, action_id: recovery.action_id, execution_id: executionId, message: 'Correct the original presentation.' });
  const continuation = await nextReadingAction(recovered);
  assert.equal(continuation.original_action_id, editor.action_id);
  assert.equal(continuation.host_handle, 'host-' + editor.action_id);
  await writeFile(native, JSON.stringify(template.editor));
  await recordReadingEvent(recovered, {
    kind: 'continuation-receipt', execution_id: executionId,
    observation: withEvidence({ execution_id: executionId, action_id: continuation.action_id, agent_id: continuation.host_handle,
      tool_call: { name: continuation.host_action, arguments: continuation.arguments }, raw_result_text: 'Editor output corrected', status: 'observed' }),
  });
  assert.equal((await recordReadingEvent(recovered, event)).status, 'pending_review');
});

// Synthetic scenarios explicitly choose to continue at each reminder.
async function nextReadingAction(session) {
  let action = await nextAction(session);
  if (action.action === 'provide-input' && action.kind === 'compaction-observation') {
    await recordReadingEvent(session, { kind: 'compaction', input: { observation: { manual_compaction: { available: false, source: 'synthetic host has no manual entry' } } } });
    action = await nextAction(session);
  }
  if (action.action === 'await-user') {
    await recordReadingEvent(session, { kind: 'compaction', input: { userDecision: 'skip' } });
    action = await nextAction(session);
  }
  return action;
}

test('generates distinct authorized tasks and bounded checkpoint slots from the input identities', () => {
  const input = { role_artifacts: ['a', 'b', 'c', 'd', 'e', 'f'] };
  const result = buildReadingSessionTasks({ runId: 'run1', scientificInput: input, sourceLanguage: 'en', checkpointCount: 4 });
  assert.deepEqual(Object.values(result.scienceTasks).map(task => task.artifact_id), input.role_artifacts);
  assert.equal(result.taskBindings.en.role, 'english-writer');
  assert.equal(result.taskBindings['zh-CN'].role, 'translation');
  assert.equal(result.taskBindings.presentation.role, 'reading-editor');
  assert.equal(result.checkpoints.length, 4);
  assert.equal(result.taskBindings['review-r2'], undefined);
  assert.equal(new Set(result.authorizedBindings.map(row => row.artifact_path)).size, result.authorizedBindings.length);
});

test('session requires explicit source and authorization and rejects nonexistent recovery', async () => {
  await assert.rejects(() => createReadingSession({}), /READING_SESSION_INPUT_INVALID/);
  await assert.rejects(() => resumeReadingSession({ runRoot: '' }), /READING_SESSION_ROOT_INVALID/);
});

async function configuredFixture(t, { systemTemp = false } = {}) {
  const base = systemTemp ? tmpdir() : join(process.cwd(), '.tmp', 'apa-session-enrichment-20261030');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'session-test-'));
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
  return { root, profile, evidence, options: { repoRoot: root, runId: 'run', scientificInput, sourceLanguage: 'en', instructionProfile: 'configured-reading-2.2', authorizationId: 'test', deadline: '2099-01-01T00:00:00Z', maxCalls: 8, maxTotalCalls: 14, sessionContext: { model: 'm', effort: 'high' }, hostProfile: profile, evidence, includeRepairs: true } };
}

test('session summary exposes source matches from preparation and after recovery', async t => {
  const f = await configuredFixture(t, { systemTemp: true });
  const raw = join(f.root, 'Raw');
  await mkdir(join(raw, 'possible'), { recursive: true });
  await copyFile(f.options.scientificInput.sources[0].path, join(raw, 'same-bytes.pdf'));
  await writeFile(join(raw, 'possible', 'paper.pdf'), 'different source bytes');
  const session = await createReadingSession(f.options);
  const first = (await nextReadingAction(session)).summary;
  const resumed = await resumeReadingSession({ runRoot: join(f.root, 'runs', 'run') });
  const recovered = (await nextReadingAction(resumed)).summary;
  const matches = first.raw_source_matches;
  assert.equal(matches.exact_count, 1);
  assert.equal(matches.exact_examples[0].raw_path, 'Raw/same-bytes.pdf');
  assert.equal(matches.possible_count, 1);
  assert.equal(matches.possible_examples[0].basis, 'filename');
  assert.deepEqual(recovered.raw_source_matches, matches);
  for (const summary of [first, recovered]) assert.ok(Buffer.byteLength(JSON.stringify(summary), 'utf8') <= 8192);
});

test('science intent survives recovery and is never automatically dispatched twice', async t => {
  const f = await configuredFixture(t);
  let session = await createReadingSession(f.options);
  const first = await nextReadingAction(session);
  assert.equal(first.action, 'dispatch');
  assert.equal(first.role, 'evidence');
  session = await resumeReadingSession({ runRoot: join(f.root, 'runs', 'run') });
  assert.equal((await nextReadingAction(session)).kind, 'runtime-evidence');
  await recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence });
  const pending = await nextReadingAction(session);
  assert.equal(pending.action, 'reconcile');
  assert.equal(pending.action_id, first.action_id);
  const observation = observe(first, 'host-evidence');
  await recordReadingEvent(session, { kind: 'host_observation', action_id: first.action_id, observation });
  assert.equal((await nextReadingAction(session)).action, 'wait');
  const progress = { action_id: first.action_id, agent_id: 'host-evidence', raw_result_text: 'working', tool_call: { name: 'query', arguments: {} } };
  const progressEvent = { kind: 'host_update', action_id: first.action_id, host_event_id: 'event-1', observation: withEvidence(progress) };
  assert.deepEqual(await recordReadingEvent(session, progressEvent), await recordReadingEvent(session, progressEvent));
  await assert.rejects(() => recordReadingEvent(session, { ...progressEvent, observation: withEvidence({ ...progress, raw_result_text: 'changed' }) }), /SCIENCE_HOST_EVENT_CONFLICT/);
  await mkdir(join(f.root, 'runs', 'run', 'native'), { recursive: true });
  await writeFile(join(f.root, 'runs', 'run', 'native', 'evidence.json'), JSON.stringify({ role: 'evidence', text: 'synthetic' }));
  await recordReadingEvent(session, { kind: 'result', action_id: first.action_id, observation });
  assert.equal((await nextReadingAction(session)).role, 'methods');
});

test('resumed preflight uses the frozen host and verifies the current main session', async t => {
  const f = await configuredFixture(t);
  const wrongSession = { ...f.profile, session: { model: 'other', reasoning_effort: 'high' } };
  let session = await createReadingSession({ ...f.options, hostProfile: wrongSession });
  assert.equal((await nextReadingAction(session)).kind, 'runtime-evidence');
  assert.equal((await recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence })).status, 'pass');
  assert.equal((await nextReadingAction(session)).action, 'dispatch');
  const configPath = join(f.root, 'config', 'apa.local.json');
  const config = JSON.parse(await readFile(configPath, 'utf8')); config.host.name = 'changed-host';
  await writeFile(configPath, JSON.stringify(config));
  session = await resumeReadingSession({ runRoot: join(f.root, 'runs', 'run') });
  const changedProfile = { ...f.profile, host: 'changed-host' };
  const changedEvidence = { ...f.evidence, current_host: { name: 'changed-host', reference: 'test changed host' } };
  assert.equal((await recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: changedProfile, evidence: changedEvidence })).status, 'blocked');
  assert.equal((await recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: wrongSession, evidence: f.evidence })).status, 'pass');
  assert.equal((await recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence })).status, 'pass');
  assert.equal((await nextReadingAction(session)).action, 'reconcile');
});

test('synthetic host runs both drafts, editor, candidate and review through the session', async t => {
  const f = await configuredFixture(t, { systemTemp: true });
  const earlier = await readingFirstPublicationFixture(t, { vaultRoot: f.root, evidenceMode: 'actual', generation: 'prior-one-step-cli',
    runId: 'run_' + 'c'.repeat(32), paperId: 'pap_' + 'c'.repeat(32) });
  assert.equal((await applyBilingualPublication(applyReadingFirstFixture(earlier))).status, 'committed');
  const template = await configuredSessionTemplate(t);
  let session = await createReadingSession(f.options);
  const runRoot = join(f.root, 'runs', 'run'), content = await scienceOutputs(f, template.presentationCatalog);
  const accept = async (action, nativePath, value) => {
    const observation = observe(action);
    await recordReadingEvent(session, { kind: 'host_observation', action_id: action.action_id, observation });
    await writeFile(join(runRoot, 'native', nativePath + '.json'), JSON.stringify(value));
    return recordReadingEvent(session, { kind: 'result', action_id: action.action_id, observation });
  };
  for (let i = 0; i < 6; i++) {
    const action = await nextReadingAction(session);
    assert.equal(action.action, 'dispatch');
    await accept(action, action.role, content(action.role));
  }
  let action = await nextReadingAction(session);
  assert.equal(action.stage, 'reading');
  const writerObservation = observe(action);
  await recordReadingEvent(session, { kind: 'host_observation', action_id: action.action_id, observation: writerObservation });
  const update = { kind: 'host_update', action_id: action.action_id, agent_id: 'host-' + action.action_id, raw_result_text: 'working', tool_call: { name: 'query', arguments: {} } };
  const updateEvent = { kind: 'host_update', action_id: action.action_id, host_event_id: 'progress-1', observation: withEvidence(update) };
  assert.deepEqual(await recordReadingEvent(session, updateEvent), await recordReadingEvent(session, updateEvent));
  await assert.rejects(() => recordReadingEvent(session, { ...updateEvent, observation: withEvidence({ ...update, raw_result_text: 'changed' }) }), /REQUEST_EVENT_CONFLICT/);
  await writeFile(join(runRoot, 'native', 'en.json'), JSON.stringify(template.views[0]));
  const writerResult = await recordReadingEvent(session, { kind: 'result', action_id: action.action_id, observation: writerObservation });
  session = await resumeReadingSession({ runRoot });
  await recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence });
  assert.deepEqual(await recordReadingEvent(session, { kind: 'result', action_id: action.action_id, observation: writerObservation }), writerResult);
  action = await nextReadingAction(session);
  assert.equal(action.stage, 'reading');
  await accept(action, 'zh-CN', template.views[1]);
  action = await nextReadingAction(session);
  assert.equal(action.stage, 'reading');
  await accept(action, 'presentation', template.editor);
  assert.equal((await nextReadingAction(session)).kind, 'render-assets');
  const source = f.options.scientificInput.sources[0];
  await recordReadingEvent(session, { kind: 'render-assets', renderOptions: {} });
  const reviewBoundary = await nextAction(session);
  assert.deepEqual({ ...reviewBoundary, summary: undefined }, { action: 'provide-input', kind: 'compaction-observation', boundary_id: 'before-review', summary: undefined });
  assert.equal(reviewBoundary.summary.next_action, 'provide-input');
  assert.deepEqual(await nextAction(session), reviewBoundary);
  session = await resumeReadingSession({ runRoot });
  await recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence });
  // 2.2 reloads the persisted render parameters, so recovery needs no new render input.
  assert.deepEqual(await nextAction(session), reviewBoundary);
  await recordReadingEvent(session, { kind: 'compaction', input: { observation: { manual_compaction: { available: false, source: 'synthetic host has no manual entry' } } } });
  action = await nextAction(session);
  assert.equal(action.action, 'await-user'); assert.match(action.message, /推荐.*压缩/);
  assert.ok(action.compaction_prompt.includes('before-review'));
  assert.ok(action.compaction_prompt.includes(JSON.stringify(source.path)));
  const reviewCapsule = JSON.parse(action.compaction_prompt.split('\n\n').find(part => part.startsWith('{')));
  assert.equal(reviewCapsule.presentation_profile, 'reading-editor-1.4');
  assert.equal(reviewCapsule.candidate_paths.length, 2);
  assert.equal((await nextAction(session)).action, 'await-user');
  const reviewPrompt = action.compaction_prompt;
  const reviewCheckpoint = action.receipt.path;
  session = await resumeReadingSession({ runRoot });
  await recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence });
  action = await nextAction(session);
  assert.equal(action.action, 'await-user');
  assert.equal(JSON.parse(await readFile(join(runRoot, reviewCheckpoint), 'utf8')).state.compaction_reminders['before-review'].compaction_prompt, reviewPrompt);
  await recordReadingEvent(session, { kind: 'compaction', input: { userDecision: 'skip' } });
  action = await nextAction(session);
  assert.equal(action.stage, 'reading');
  await accept(action, 'review', template.review);
  const done = await nextReadingAction(session);
  assert.equal(done.action, 'complete');
  assert.equal(done.status, 'reading_complete');
  assert.equal(done.publishable, false);
  session = await resumeReadingSession({ runRoot });
  await recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence });
  assert.equal((await nextReadingAction(session)).status, 'reading_complete');
  const sharedPath = join(f.root, earlier.candidate.supportNotes[0].path);
  const oldShared = await readFile(sharedPath, 'utf8');
  await writeFile(sharedPath, oldShared.replace('<!-- AUTO:END shared-knowledge -->',
    'Retain this in-region edit.\n<!-- AUTO:END shared-knowledge -->') + '\nRetain this personal addition.\n');
  const original = await inspectReadingFirstPublicationSource(done.publication_source);
  const resourceFile = join(f.root, 'one-step-resources.json');
  await writeFile(resourceFile, JSON.stringify([
    { path: original.presentation.source_pdf, source_path: source.path, sha256: source.sha256, byte_length: source.byte_length },
    ...original.results_resource_manifest.resources.map(({ path, source_path, sha256, byte_length }) => ({ path, source_path, sha256, byte_length })),
  ]));
  const staging = join(f.root, '.tmp', 'reading-first-candidates'), before = (await readdir(staging)).sort();
  assert.ok(before.length > 0);
  const unrelated = join(staging, 'unowned-fixture');
  await mkdir(unrelated);
  await writeFile(join(unrelated, 'keep.txt'), 'unrelated bytes');
  const controlRoot = join(runRoot, 'control');
  const snapshots = async () => Promise.all((await readdir(controlRoot)).sort().map(async name => [name, await readFile(join(controlRoot, name))]));
  const controlBefore = await snapshots();
  const cli = fileURLToPath(new URL('../../scripts/v3/bilingual.mjs', import.meta.url));
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [cli, 'publish', '--vault-root', f.root, '--run', 'run',
    '--run-root', runRoot, '--generation', 'one-step-cli', '--resources', resourceFile,
    '--authorization-id', 'owned-session-cli', '--user-reply', '发布']);
  const published = JSON.parse(stdout);
  assert.equal(published.status, 'committed', stdout);
  assert.equal(JSON.parse(stderr).event, 'publication-inventory');
  assert.equal((await readFile(published.rebase_record_path, 'utf8')).includes(original.recipe.recipe_fingerprint), true);
  assert.deepEqual(await readdir(staging), ['unowned-fixture']);
  assert.equal(await readFile(join(unrelated, 'keep.txt'), 'utf8'), 'unrelated bytes');
  assert.ok(before.every(name => published.runtime_cleanup.removed.some(path => path.startsWith(`.tmp/reading-first-candidates/${name}/`))));
  assert.ok(published.runtime_cleanup.archives.some(item => item.kind === 'reading-host-record'));
  assert.deepEqual(await snapshots(), controlBefore);
  assert.match(await readFile(sharedPath, 'utf8'), /Retain this in-region edit/);
  assert.match(await readFile(sharedPath, 'utf8'), /Retain this personal addition/);
});

test('synthetic science completes in dependency order and restores the pending writer', async t => {
  const f = await configuredFixture(t);
  let session = await createReadingSession(f.options);
  const content = await scienceOutputs(f), seen = [];
  for (let i = 0; i < 6; i++) {
    const action = await nextReadingAction(session);
    assert.equal(action.action, 'dispatch');
    seen.push(action.role);
    const observation = observe(action, `host-${action.role}`);
    await recordReadingEvent(session, { kind: 'host_observation', action_id: action.action_id, observation });
    await writeFile(join(f.root, 'runs', 'run', 'native', action.role + '.json'), JSON.stringify(content(action.role)));
    await recordReadingEvent(session, { kind: 'result', action_id: action.action_id, observation });
  }
  assert.deepEqual(seen, ['evidence', 'methods', 'results', 'interpretation', 'scientific-reading', 'integration']);
  const writer = await nextReadingAction(session);
  assert.equal(writer.action, 'dispatch');
  assert.equal(writer.stage, 'reading');
  session = await resumeReadingSession({ runRoot: join(f.root, 'runs', 'run') });
  await recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence });
  const pending = await nextReadingAction(session);
  assert.equal(pending.action, 'reconcile');
  assert.equal(pending.action_id, writer.action_id);
});

test('accepted result with failed checkpoint remains recoverable without redispatch', async t => {
  const f = await configuredFixture(t), template = await configuredSessionTemplate(t);
  let session = await createReadingSession(f.options);
  const runRoot = join(f.root, 'runs', 'run'), content = await scienceOutputs(f, template.presentationCatalog);
  for (let i = 0; i < 6; i++) {
    const action = await nextReadingAction(session), observation = observe(action);
    await recordReadingEvent(session, { kind: 'host_observation', action_id: action.action_id, observation });
    await writeFile(join(runRoot, 'native', action.role + '.json'), JSON.stringify(content(action.role)));
    await recordReadingEvent(session, { kind: 'result', action_id: action.action_id, observation });
  }
  const action = await nextReadingAction(session), observation = observe(action);
  await recordReadingEvent(session, { kind: 'host_observation', action_id: action.action_id, observation });
  await writeFile(join(runRoot, 'native', 'en.json'), JSON.stringify(template.views[0]));
  const occupied = join(runRoot, 'control', 'reading-checkpoint-7.json');
  await writeFile(occupied, 'test interference');
  await assert.rejects(() => recordReadingEvent(session, { kind: 'result', action_id: action.action_id, observation }));
  assert.equal((await nextReadingAction(session)).code, 'READING_SESSION_RESTORE_REQUIRED');
  await assert.rejects(() => resumeReadingSession({ runRoot }), /CHECKPOINT_ORPHAN/);
  await unlink(occupied);
  session = await resumeReadingSession({ runRoot });
  await recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence });
  assert.equal((await nextReadingAction(session)).action, 'wait');
  const accepted = await recordReadingEvent(session, { kind: 'result', action_id: action.action_id, observation });
  assert.ok(accepted.receipt);
  assert.equal((await nextReadingAction(session)).stage, 'reading');
});

test('before-writer compaction pause is recovered from the owned decision checkpoint', async t => {
  const f = await configuredFixture(t); let session = await createReadingSession(f.options);
  const runRoot = join(f.root, 'runs', 'run'), content = await scienceOutputs(f);
  for (let i = 0; i < 6; i++) {
    const action = await nextReadingAction(session);
    const observation = observe(action);
    await recordReadingEvent(session, { kind: 'host_observation', action_id: action.action_id, observation });
    await writeFile(join(runRoot, 'native', action.role + '.json'), JSON.stringify(content(action.role)));
    await recordReadingEvent(session, { kind: 'result', action_id: action.action_id, observation });
  }
  const now = new Date().toISOString();
  await recordReadingEvent(session, { kind: 'compaction', input: { sessionId: 'main', observation: { session_id: 'main', observed_at: now, context: { tokens: 190000, kind: 'current-context', measured_at: now, fresh: true, source: 'synthetic meter' }, manual_compaction: { available: true, method: 'synthetic compact', source: 'synthetic host' } }, progress: { remaining_work: { multiple_responses: true, reason: 'writing remains' }, growth: { substantial: true, reason: 'science grew' } } } });
  assert.equal((await nextAction(session)).action, 'await-user');
  session = await resumeReadingSession({ runRoot });
  await recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence });
  assert.equal((await nextAction(session)).action, 'await-user');
  await recordReadingEvent(session, { kind: 'compaction', input: { userDecision: 'skip' } });
  assert.equal((await nextReadingAction(session)).action, 'dispatch');
});

test('1.2 freezes the evidenced host entry and waits at science and Writer boundaries', async t => {
  const f = await configuredFixture(t);
  const entry = { status: 'detected', method: '/compact', scope: 'current-session', evidence: [{ source: 'host-docs', reference: 'synthetic host manual entry' }], limitations: [] };
  f.profile.capabilities = { manual_compaction: entry };
  let session = await createReadingSession(f.options);
  const runRoot = join(f.root, 'runs', 'run'), content = await scienceOutputs(f);
  const saved = JSON.parse(await readFile(join(runRoot, 'control', 'science-state.json'), 'utf8'));
  const policy = saved.data.prepared.runControl.reading_first_binding.compaction_policy;
  assert.equal(policy.profile, 'boundary-reminders-1.2');
  assert.equal(policy.manual_compaction.method, '/compact');
  assert.deepEqual(policy.manual_compaction.evidence, entry.evidence);
  entry.method = 'changed after binding';
  const boundaries = [];
  for (let i = 0; i < 6; i++) {
    let action = await nextAction(session);
    if (action.action === 'provide-input') {
      assert.equal(action.kind, 'compaction-observation'); boundaries.push(action.boundary_id);
      assert.deepEqual(await nextAction(session), action);
      await recordReadingEvent(session, { kind: 'compaction', input: { observation: { observed_at: new Date().toISOString() } } });
      action = await nextAction(session);
      assert.equal(action.action, 'await-user'); assert.match(action.message, /推荐.*压缩/);
      assert.equal((await nextAction(session)).action, 'await-user');
      await recordReadingEvent(session, { kind: 'compaction', input: { userDecision: 'skip' } });
      action = await nextAction(session);
    }
    assert.equal(action.action, 'dispatch');
    const observation = observe(action, 'host-' + action.role);
    await recordReadingEvent(session, { kind: 'host_observation', action_id: action.action_id, observation });
    await writeFile(join(runRoot, 'native', action.role + '.json'), JSON.stringify(content(action.role)));
    await recordReadingEvent(session, { kind: 'result', action_id: action.action_id, observation });
  }
  const missing = await nextAction(session);
  assert.equal(missing.action, 'provide-input'); assert.equal(missing.boundary_id, 'before-writer');
  await recordReadingEvent(session, { kind: 'compaction', input: { observation: { observed_at: new Date().toISOString() } } });
  const paused = await nextAction(session);
  assert.equal(paused.action, 'await-user'); assert.match(paused.message, /\/compact/);
  assert.ok(paused.compaction_prompt.includes('before-writer'));
  assert.ok(paused.compaction_prompt.includes(JSON.stringify(join(runRoot, 'control', 'compaction-before-writer-decision.json'))));
  assert.deepEqual(boundaries, ['evidence-accepted', 'methods-results-accepted']);
  const checkpointPath = join(runRoot, 'control', 'compaction-before-writer-decision.json');
  const checkpoint = await readFile(checkpointPath);
  assert.equal(JSON.parse(checkpoint.toString()).state.compaction_reminders['before-writer'].compaction_prompt, paused.compaction_prompt);
  session = await resumeReadingSession({ runRoot });
  await recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence });
  assert.equal((await nextAction(session)).action, 'await-user');
  assert.deepEqual(await readFile(checkpointPath), checkpoint);
  await recordReadingEvent(session, { kind: 'compaction', input: { userDecision: 'skip' } });
  const writer = await nextAction(session); assert.equal(writer.action, 'dispatch'); assert.equal(writer.stage, 'reading');
  const pending = await nextAction(session); assert.equal(pending.action, 'reconcile'); assert.equal(pending.action_id, writer.action_id);
});

test('1.2 never freezes an unsupported, unproven or different-host entry as available', async t => {
  for (const scenario of ['unknown', 'unsupported', 'missing-evidence', 'different-host']) {
    const f = await configuredFixture(t);
    f.profile.capabilities = { manual_compaction: { status: ['unknown', 'unsupported'].includes(scenario) ? scenario : 'detected', method: '/compact', scope: 'current-session', evidence: scenario === 'missing-evidence' ? [] : [{ source: 'host-docs', reference: 'host manual entry' }], limitations: [] } };
    if (scenario === 'different-host') f.profile.host = 'different-host';
    await createReadingSession(f.options);
    const saved = JSON.parse(await readFile(join(f.root, 'runs', 'run', 'control', 'science-state.json'), 'utf8'));
    assert.equal(saved.data.prepared.runControl.reading_first_binding.compaction_policy.manual_compaction.available, false, scenario);
  }
});

test('1.2 with an unknown entry persists a mandatory reminder and waits through recovery', async t => {
  const f = await configuredFixture(t);
  let session = await createReadingSession(f.options);
  const runRoot = join(f.root, 'runs', 'run'); await mkdir(join(runRoot, 'native'), { recursive: true });
  const action = await nextAction(session), observation = observe(action, 'host-evidence');
  await recordReadingEvent(session, { kind: 'host_observation', action_id: action.action_id, observation });
  await writeFile(join(runRoot, 'native', 'evidence.json'), JSON.stringify({ role: 'evidence', text: 'synthetic' }));
  await recordReadingEvent(session, { kind: 'result', action_id: action.action_id, observation });
  const evidenceBoundary = await nextAction(session);
  assert.deepEqual({ ...evidenceBoundary, summary: undefined }, { action: 'provide-input', kind: 'compaction-observation', boundary_id: 'evidence-accepted', summary: undefined });
  assert.equal(evidenceBoundary.summary.budget.status, 'known');
  await recordReadingEvent(session, { kind: 'compaction', input: { observation: {} } });
  const prompted = await nextAction(session);
  assert.equal(prompted.action, 'await-user'); assert.match(prompted.message, /推荐.*压缩/);
  assert.match(prompted.message, /入口.*未.*核实/); assert.doesNotMatch(prompted.message, /\/compact/);
  assert.ok(prompted.compaction_prompt.includes(JSON.stringify(runRoot))); assert.ok(prompted.compaction_prompt.includes('evidence-accepted'));
  const statePath = join(runRoot, 'control', 'science-state.json');
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(saved.data.compaction_reminders['evidence-accepted'].status, 'prompted');
  assert.equal(saved.data.compaction_reminders['evidence-accepted'].compaction_prompt, prompted.compaction_prompt);
  session = await resumeReadingSession({ runRoot });
  await recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence });
  assert.equal((await nextAction(session)).action, 'await-user');
  await recordReadingEvent(session, { kind: 'compaction', input: { userDecision: 'continue' } });
  assert.equal((await nextAction(session)).role, 'methods');
  const continued = JSON.parse(await readFile(statePath, 'utf8')).data.compaction_reminders['evidence-accepted'];
  assert.equal(continued.reason, 'continued-without-observed-compaction'); assert.equal(continued.compaction_verified, false);
});

test('control slot exhaustion blocks dispatch without changing the model-call budget', async t => {
  const f = await configuredFixture(t), session = await createReadingSession({ ...f.options, maxControlCheckpoints: 4 });
  const runRoot = join(f.root, 'runs', 'run'), content = await scienceOutputs(f);
  for (let i = 0; i < 6; i++) {
    const action = await nextReadingAction(session);
    const observation = observe(action);
    await recordReadingEvent(session, { kind: 'host_observation', action_id: action.action_id, observation });
    await writeFile(join(runRoot, 'native', action.role + '.json'), JSON.stringify(content(action.role)));
    await recordReadingEvent(session, { kind: 'result', action_id: action.action_id, observation });
  }
  const blocked = await nextReadingAction(session);
  assert.equal(blocked.action, 'reconcile');
  assert.equal(blocked.code, 'CONTROL_CHECKPOINT_CAPACITY');
});

test('material editor issue receives one bounded repair and a second candidate', async t => {
  const f = await configuredFixture(t), template = await configuredSessionTemplate(t);
  let session = await createReadingSession(f.options);
  const runRoot = join(f.root, 'runs', 'run'), content = await scienceOutputs(f, template.presentationCatalog);
  const accept = async (action, path, value) => {
    const observation = observe(action);
    await recordReadingEvent(session, { kind: 'host_observation', action_id: action.action_id, observation });
    await writeFile(join(runRoot, 'native', path + '.json'), JSON.stringify(value));
    return recordReadingEvent(session, { kind: 'result', action_id: action.action_id, observation });
  };
  for (let i = 0; i < 6; i++) {
    const action = await nextReadingAction(session);
    await accept(action, action.role, content(action.role));
  }
  await accept(await nextReadingAction(session), 'en', template.views[0]);
  await accept(await nextReadingAction(session), 'zh-CN', template.views[1]);
  await accept(await nextReadingAction(session), 'presentation', template.editor);
  await recordReadingEvent(session, { kind: 'render-assets', renderOptions: {} });
  const review = { ...template.review, issues: [{ severity: 'material', kind: 'presentation', detail: 'Clarify the finding overview.', repair_owner: 'editor', repair_scope: { status: 'located', section_ids: ['findings'], knowledge_ids: [], visual_ids: [], editor_fields: [] } }] };
  const first = await nextReadingAction(session);
  assert.equal((await accept(first, 'review', review)).status, 'revision_required');
  const editor = await nextReadingAction(session);
  assert.equal(editor.stage, 'reading');
  const revised = structuredClone(template.editor); revised.languages.en.overview[0].text = 'The supported finding and its limits are clear.';
  assert.equal((await accept(editor, 'presentation-r2', revised)).status, 'pending_review');
  const secondReview = await nextReadingAction(session);
  assert.equal(secondReview.stage, 'reading');
  assert.equal((await accept(secondReview, 'review-r2', template.review)).status, 'reading_complete');
  assert.equal((await nextReadingAction(session)).status, 'reading_complete');
  session = await resumeReadingSession({ runRoot });
  await recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence });
  await recordReadingEvent(session, { kind: 'render-assets', renderOptions: {} });
  assert.equal((await nextReadingAction(session)).status, 'reading_complete');
});

for (const scenario of ['wording','scientific','scientific-short','retain','number','unit','citation','figure','markdown-label','wikilink-label','age-unit','map-number','writer-fact','renderer-fact']) test('user revision separates request provenance and scientific recheck: '+scenario,async t=>{
  const scientific=scenario.startsWith('scientific');
  const f = await configuredFixture(t), template = await configuredSessionTemplate(t);
  const evidenceText=scenario==='markdown-label' ? 'See [12 mg](https://example.org/paper).'
    : scenario==='wikilink-label' ? 'See [['+template.presentationCatalog.source_pdf+'|Figure 1]].'
      : scenario==='age-unit' ? '小鼠高脂喂养 12 周。'
        : scenario==='map-number' ? 'The measured change was -2.5 mg.'
        : 'The change was -2.5 mg (12%). See Figure 1 and [the study](https://example.org/paper).';
  const changedFacts={number:['-2.5','-3.5'],unit:['mg','g'],citation:['/paper','/other'],figure:['Figure 1','Figure 2'],
    'markdown-label':['12 mg','13 g'],'wikilink-label':['Figure 1','Figure 2'],'age-unit':['12 周','12 周龄'],'map-number':['-2.5','-3.5']};
  template.editor.languages.en.overview[0].text=evidenceText;
  if (scenario==='map-number') template.editor.argument.claims[0].evidence.en=evidenceText;
  if (scenario==='writer-fact') {
    template.views[0].sections.find(row=>row.id==='findings').paragraphs[0]=evidenceText;
    template.editor.views_fingerprint=readingFirstViewsFingerprint(template.views);
  }
  let session = await createReadingSession(scenario==='retain' ? {...f.options,includeRepairs:false} : scenario==='scientific-short' ? {...f.options,maxCalls:5,maxTotalCalls:11} : f.options);
  const runRoot = join(f.root, 'runs', 'run'), content = await scienceOutputs(f, template.presentationCatalog);
  const accept = async (action, path, value) => {
    const observation = observe(action);
    await recordReadingEvent(session, { kind: 'host_observation', action_id: action.action_id, observation });
    await writeFile(join(runRoot, 'native', path + '.json'), JSON.stringify(value));
    return recordReadingEvent(session, { kind: 'result', action_id: action.action_id, observation });
  };
  for (let i = 0; i < 6; i++) {
    const action = await nextReadingAction(session);
    await accept(action, action.role, content(action.role));
  }
  await accept(await nextReadingAction(session), 'en', template.views[0]);
  await accept(await nextReadingAction(session), 'zh-CN', template.views[1]);
  await accept(await nextReadingAction(session), 'presentation', template.editor);
  await recordReadingEvent(session, { kind: 'render-assets', renderOptions: {} });

  await accept(await nextReadingAction(session),'review',template.review);
  const initial=await nextReadingAction(session);
  assert.equal(initial.status,'reading_complete');
  const original=await readFile(join(runRoot,'reading/review.json'));
  assert.equal((await recordReadingEvent(session,{kind:'inspect-candidate'})).status,'passed');
  const recorded=await recordReadingEvent(session,{kind:'user-revision',request:{
    revision_id:'user-overview',request:'Clarify the overview wording.',scientific,repair_owner:scenario==='writer-fact' ? 'writer' : scenario==='renderer-fact' ? 'renderer' : 'editor',
    ...(scenario==='renderer-fact' ? {affected_paths:[template.candidate.notes[0].path]} : {}),
    target_entries:scenario==='map-number' ? ['map'] : ['findings'],
    repair_scope:{status:'located',section_ids:['findings'],knowledge_ids:[],visual_ids:[],editor_fields:scenario==='map-number' ? ['map'] : []},
  }});
  if (scenario==='retain') {
    assert.equal(recorded.requires_authorization,true);
    assert.ok((await nextReadingAction(session)).zero_call_alternative);
    await recordReadingEvent(session,{kind:'retain-reviewed-candidate',revision_id:'user-overview'});
    const retained=await nextReadingAction(session);
    const source=await inspectReadingFirstPublicationSource(retained.publication_source);
    assert.equal(source.recipe.checkpoint.state.userRevisionWithdrawals.length,1);
    assert.equal(source.recipe.checkpoint.state.executionLedger.length,10);
    assert.equal(source.candidate.presentation_fingerprint,source.recipe.checkpoint.state.reviewedPresentationFingerprint);
    assert.equal((await recordReadingEvent(session,{kind:'inspect-candidate'})).status,'passed');
    const checkpoint=await readFile(retained.summary.state_ref);
    const cli=fileURLToPath(new URL('../../scripts/v3/reading-session-cli.mjs',import.meta.url));
    const output=await promisify(execFile)(process.execPath,[cli,'inspect-candidate','--run-root',runRoot,'--revision','1']);
    assert.equal(JSON.parse(output.stdout).status,'passed');
    assert.deepEqual(await readFile(retained.summary.state_ref),checkpoint);
    return;
  }
  if (scenario==='scientific') {
    assert.equal(recorded.requires_authorization,false);
    assert.equal(recorded.status,'revision_required');
  }
  if (scenario==='scientific-short') assert.equal(recorded.requires_authorization,true);
  if (scenario==='writer-fact') {
    const revised=structuredClone(template.views[0]);
    revised.sections.find(row=>row.id==='findings').paragraphs[0]=evidenceText.replace('12%','13%');
    const awaitable=await nextReadingAction(session);
    await assert.rejects(()=>accept(awaitable,'en-r2',revised),/USER_REVISION_FACT_CHANGED/);
    return;
  }
  if (scenario==='renderer-fact') {
    const note=template.candidate.notes[0];
    const marker=note.language==='en' ? '## Personal Notes' : '## 个人笔记';
    const existingTargets=[{path:note.path,bytes:Buffer.from(note.content.replace(marker,'Unsupported value 12 mg.\n\n'+marker)),managedHash:note.managedHash}];
    await recordReadingEvent(session,{kind:'renderer-repair',renderOptions:{targetRegistry:template.candidate.targetRegistry,existingTargets}});
    await assert.rejects(()=>nextReadingAction(session),/USER_REVISION_FACT_CHANGED/);
    return;
  }
  if (recorded.requires_authorization) {
    const action=await nextReadingAction(session);
    assert.equal(action.kind,'authorize-continuation');
    const plan=action.continuation;
    assert.equal(plan.includes_local_review,scientific);
    await recordReadingEvent(session,{kind:'authorize-continuation',authorization:{authorization_id:'user-overview-approved',
      reason:'Scoped revision',checkpoint_fingerprint:plan.checkpoint_fingerprint,issue_ids:plan.issue_ids,
      max_additional_calls:plan.recommended_additional_calls,max_additional_review_rounds:plan.max_additional_review_rounds}});
  } else assert.notEqual(scenario,'scientific-short');
  const revised=structuredClone(template.editor);
  if (changedFacts[scenario]) {
    const changed = evidenceText.replace(...changedFacts[scenario]);
    if (scenario==='map-number') revised.argument.claims[0].evidence.en=changed;
    else revised.languages.en.overview[0].text=changed;
    const result=await accept(await nextReadingAction(session),'presentation-r2',revised);
    assert.equal(result.rejection?.reason,'READING_FIRST_USER_REVISION_FACT_CHANGED');
    return;
  }
  revised.languages.en.overview[0].text=evidenceText.replace('The change was','The observed change was').replace('). See','); see');
  await accept(await nextReadingAction(session),'presentation-r2',revised);
  if (scientific) await accept(await nextReadingAction(session),'review-r2',template.review);
  const done=await nextReadingAction(session);
  assert.equal(done.status,'reading_complete');
  const source=await inspectReadingFirstPublicationSource(done.publication_source);
  assert.equal(source.recipe.checkpoint.state.reviews,scientific ? 2 : 1);
  assert.equal(source.recipe.checkpoint.state.user_revisions[0].source,'user');
  assert.deepEqual(await readFile(join(runRoot,'reading/review.json')),original);
  await readingRuntime.restoreReadingFirstPublicationSource(source.recipe);
  if (!scientific) {
    const bad=structuredClone(source.recipe);
    delete bad.checkpoint.state.userRevisionChecks;
    delete bad.checkpoint.checkpoint_fingerprint;
    bad.checkpoint.checkpoint_fingerprint=readingRuntime.fingerprintReadingFirst(bad.checkpoint);
    delete bad.recipe_fingerprint;
    bad.recipe_fingerprint=readingRuntime.fingerprintReadingFirst(bad);
    await assert.rejects(()=>readingRuntime.restoreReadingFirstPublicationSource(bad),/READING_FIRST_PUBLICATION_REVIEW_CHANGED/);
  }
  session=await resumeReadingSession({runRoot});
  await recordReadingEvent(session,{kind:'runtime-evidence',hostProfile:f.profile,evidence:f.evidence});
  assert.equal((await nextReadingAction(session)).status,'reading_complete');
});

test('explicit additional execution budget resumes the first scoped Writer repair', async t => {
  const f = await configuredFixture(t), template = await configuredSessionTemplate(t);
  f.profile.capabilities = { task_continuation: continuationCapability() };
  let session = await createReadingSession(f.options);
  const runRoot = join(f.root, 'runs', 'run'), science = await scienceOutputs(f, template.presentationCatalog);
  const accept = async (action, key, value) => {
    assert.equal(action.action, 'dispatch');
    const observation = observe(action);
    await recordReadingEvent(session, { kind: 'host_observation', action_id: action.action_id, observation });
    await writeFile(join(runRoot, 'native', key + '.json'), JSON.stringify(value));
    return recordReadingEvent(session, { kind: 'result', action_id: action.action_id, observation });
  };
  const evidence = await nextReadingAction(session), evidenceHandle = 'host-' + evidence.action_id;
  await recordReadingEvent(session, { kind: 'host_observation', action_id: evidence.action_id, observation: observe(evidence) });
  const executionId = 'evidence-continue';
  await recordReadingEvent(session, { kind: 'continuation-intent', action_id: evidence.action_id, execution_id: executionId, message: 'Finish the original Evidence task.' });
  const continuation = await nextReadingAction(session);
  await recordReadingEvent(session, { kind: 'continuation-receipt', execution_id: executionId, observation: withEvidence({ execution_id: executionId,
    action_id: continuation.action_id, agent_id: evidenceHandle, tool_call: { name: continuation.host_action, arguments: continuation.arguments }, raw_result_text: 'continued', status: 'observed' }) });
  await accept(evidence, evidence.role, science(evidence.role));
  for (let i = 1; i < 6; i++) {
    const action = await nextReadingAction(session);
    await accept(action, action.role, science(action.role));
  }
  await accept(await nextReadingAction(session), 'en', template.views[0]);
  await accept(await nextReadingAction(session), 'zh-CN', template.views[1]);
  await accept(await nextReadingAction(session), 'presentation', template.editor);
  await recordReadingEvent(session, { kind: 'render-assets', renderOptions: {} });
  const issue = { severity: 'material', kind: 'scientific_limitation', detail: 'Explain the bounded finding.', repair_owner: 'writer',
    affected_languages: ['en', 'zh-CN'], repair_scope: { status: 'located', section_ids: ['findings'], knowledge_ids: [], visual_ids: [], editor_fields: [] } };
  const first = await nextReadingAction(session);
  assert.equal((await accept(first, 'review', { ...template.review, issues: [issue] })).status, 'completed_with_limits');
  const terminal = await nextReadingAction(session);
  const baselineBytes = await readFile(terminal.summary.state_ref);
  const baseline = JSON.parse(baselineBytes);
  const inspection=await recordReadingEvent(session,{kind:'inspect-continuation'});
  assert.equal(inspection.can_continue,true);
  assert.equal(inspection.required_additional_calls,1);
  assert.equal(inspection.translation_allowance,0);
  assert.deepEqual(terminal.continuation,inspection);
  assert.equal(inspection.recommended_additional_calls,1+inspection.translation_allowance);
  const authorization = { authorization_id: 'user-approved-budget', reason: 'Approve the scoped repair and its reserve.',
    issue_ids:inspection.issue_ids,checkpoint_fingerprint:baseline.checkpoint_fingerprint,max_additional_calls:inspection.recommended_additional_calls,max_additional_review_rounds:0 };
  const approve = fields => recordReadingEvent(session, { kind: 'authorize-continuation', authorization: { ...authorization, ...fields } });
  await assert.rejects(() => approve({ issue_ids:['unknown'] }), /AUTHORIZATION_INVALID/);
  await assert.rejects(() => approve({ max_additional_calls:0 }), /BUDGET_INSUFFICIENT: 1/);
  await approve();
  await assert.rejects(() => approve({reason:'different'}), /AUTHORIZATION_CONFLICT/);
  assert.deepEqual(await readFile(terminal.summary.state_ref), baselineBytes);
  session = await resumeReadingSession({ runRoot });
  await recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence });
  await approve();
  const revised = structuredClone(template.views);
  revised[0].sections.find(row => row.id === 'findings').paragraphs[0] = 'This is the bounded synthetic finding.';
  revised[1].sections.find(row => row.id === 'findings').paragraphs[0] = '这个合成发现有明确的适用范围。';
  await accept(await nextReadingAction(session), 'en-r2', revised[0]);
  await accept(await nextReadingAction(session), 'zh-CN-r2', revised[1]);
  await accept(await nextReadingAction(session), 'presentation-r2', { ...template.editor, views_fingerprint: readingFirstViewsFingerprint(revised) });
  const local = await nextReadingAction(session);
  assert.match(await readFile(join(runRoot, 'instructions', 'review-r2.txt'), 'utf8'), /Explain the bounded finding/);
  await accept(local, 'review-r2', template.review);
  session = await resumeReadingSession({ runRoot });
  await recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence });
  const done = await nextReadingAction(session);
  assert.equal(done.status, 'reading_complete');
  assert.equal(done.summary.budget.total_used, 15);
  assert.equal(done.summary.budget.original_total_limit, 14);
  assert.equal(done.summary.budget.additional_used, 1);
  const prepared = await inspectReadingFirstPublicationSource(done.publication_source);
  assert.equal(prepared.recipe.checkpoint.state.reviews, 2);
  assert.deepEqual(prepared.recipe.checkpoint.state.executionLedger.slice(0, 11), baseline.state.executionLedger);
  assert.equal(prepared.recipe.binding.max_total_calls, 14);
  await readingRuntime.restoreReadingFirstPublicationSource(prepared.recipe);
  const legacy=structuredClone(prepared.recipe);
  const [row]=legacy.checkpoint.state.continuationAuthorizations;
  delete legacy.checkpoint.state.continuationAuthorizations;
  legacy.checkpoint.state.repairContinuation={authorization:row.authorization,prior_checkpoint:row.prior_checkpoint,
    original_total_limit:legacy.binding.max_total_calls,baseline_execution_count:row.baseline_execution_count,
    baseline_ledger_fingerprint:row.baseline_ledger_fingerprint};
  delete legacy.checkpoint.checkpoint_fingerprint;
  legacy.checkpoint.checkpoint_fingerprint=readingRuntime.fingerprintReadingFirst(legacy.checkpoint);
  delete legacy.recipe_fingerprint;
  legacy.recipe_fingerprint=readingRuntime.fingerprintReadingFirst(legacy);
  await readingRuntime.restoreReadingFirstPublicationSource(legacy);
});

for (const scenario of ['controller','verifier','missing-science','explicit-id']) test('unroutable review retains original bytes: '+scenario,async t=>{
  const verifier=scenario==='verifier', missingScience=scenario==='missing-science', explicit=scenario==='explicit-id';
  const f = await configuredFixture(t), template = await configuredSessionTemplate(t);
  if (verifier) f.profile.capabilities={task_continuation:continuationCapability()};
  let session = await createReadingSession(missingScience ? {...f.options,includeRepairs:false,enrichmentPolicy:{sources:[],allow_targeted_methods:true}} : f.options);
  const runRoot = join(f.root, 'runs', 'run'), content = await scienceOutputs(f, template.presentationCatalog);
  const accept = async (action, path, value) => {
    const observation = observe(action);
    await recordReadingEvent(session, { kind: 'host_observation', action_id: action.action_id, observation });
    await writeFile(join(runRoot, 'native', path + '.json'), JSON.stringify(value));
    return { result: await recordReadingEvent(session, { kind: 'result', action_id: action.action_id, observation }), observation };
  };
  for (let i = 0; i < 6; i++) {
    const action = await nextReadingAction(session);
    await accept(action, action.role, content(action.role));
  }
  await accept(await nextReadingAction(session), 'en', template.views[0]);
  await accept(await nextReadingAction(session), 'zh-CN', template.views[1]);
  await accept(await nextReadingAction(session), 'presentation', template.editor);
  await recordReadingEvent(session, { kind: 'render-assets', renderOptions: {} });
  const action = await nextReadingAction(session);
  const review = { ...template.review, issues: [{ severity: 'material', kind: 'presentation',
    detail:explicit ? 'Clarify '+String.fromCharCode(96)+'findings'+String.fromCharCode(96)+'.' : 'The findings need clarification.',
    ...(verifier ? {} : {repair_owner:missingScience ? 'science' : 'editor'}),
    ...(missingScience ? {scientific_gap:{id:'late',question:'What allocation was used?',impact:'Changes interpretation',severity:'material',
      owner_role:'evidence',source_kind:'original_page',source_ids:[],target_sections:['Study']}} : {}),
    repair_scope: { status: 'unresolved', section_ids: [], knowledge_ids: [], visual_ids: [], editor_fields: [] } }] };
  const { result, observation } = await accept(action, 'review', review);
  assert.equal(result.status, 'review_unroutable');
  assert.deepEqual(result.routing.gaps[0].missing_fields,verifier ? ['repair_owner','repair_scope'] : ['repair_scope']);
  assert.equal(!!result.routing.gaps[0].cited_targets,explicit);
  const bytes=await readFile(join(runRoot,'reading/review.json'));
  session = await resumeReadingSession({ runRoot });
  await recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence });
  const actionAfter=await nextReadingAction(session);
  assert.equal(actionAfter.kind,'review-scope');
  assert.deepEqual(await recordReadingEvent(session, { kind: 'result', action_id: action.action_id, observation }), result);
  const annotations=[{issue_id:'issue-1',fields:{
    ...(verifier ? {repair_owner:'editor'} : {}),
    repair_scope:{status:'located',section_ids:[actionAfter.routing.scope_options.section_ids[0]],knowledge_ids:[],visual_ids:[],editor_fields:[]},
  }}];
  let routed;
  if (verifier) {
    const execution_id='complete-verifier-scope';
    await recordReadingEvent(session,{kind:'continuation-intent',action_id:action.action_id,execution_id,message:'Complete the review routing.'});
    const continuation=await nextReadingAction(session);
    assert.equal(continuation.host_handle,'host-'+action.action_id);
    await recordReadingEvent(session,{kind:'continuation-receipt',execution_id,observation:withEvidence({execution_id,
      action_id:continuation.action_id,agent_id:continuation.host_handle,tool_call:{name:continuation.host_action,arguments:continuation.arguments},
      raw_result_text:'Synthetic continuation',status:'observed'})});
    await writeFile(join(runRoot,'native/review-scope.json'),JSON.stringify(annotations));
    routed=await recordReadingEvent(session,{kind:'accept-review-scope',execution_id});
  } else routed=await recordReadingEvent(session,{kind:'annotate-review-scope',...(explicit ? {} : {annotations})});
  assert.equal(routed.status,missingScience ? 'completed_with_limits' : 'revision_required');
  if (missingScience) {
    const stopped=await nextReadingAction(session);
    assert.equal(stopped.continuation.reason,'READING_FIRST_CONTINUATION_SCIENCE_SCOPE_UNAUTHORIZED');
    assert.equal(stopped.continuation.can_continue,false);
  }
  assert.deepEqual(await readFile(join(runRoot,'reading/review.json')),bytes);
});

for (const extended of [false,true]) test('renderer repairs compare against their latest reviewed candidate: '+extended, async t => {
  const f = await configuredFixture(t), template = await configuredSessionTemplate(t);
  const session = await createReadingSession(f.options), runRoot = join(f.root, 'runs', 'run');
  const content = await scienceOutputs(f, template.presentationCatalog);
  const accept = async (action, path, value) => {
    const observation = observe(action);
    await recordReadingEvent(session, { kind: 'host_observation', action_id: action.action_id, observation });
    await writeFile(join(runRoot, 'native', path + '.json'), JSON.stringify(value));
    return recordReadingEvent(session, { kind: 'result', action_id: action.action_id, observation });
  };
  for (let i = 0; i < 6; i++) {
    const action = await nextReadingAction(session);
    await accept(action, action.role, content(action.role));
  }
  await accept(await nextReadingAction(session), 'en', template.views[0]);
  await accept(await nextReadingAction(session), 'zh-CN', template.views[1]);
  await accept(await nextReadingAction(session), 'presentation', template.editor);
  await recordReadingEvent(session, { kind: 'render-assets', renderOptions: {} });
  const review = { ...template.review, issues: [{ severity: 'material', kind: 'layout', detail: 'Correct the rendered finding.', repair_owner: 'renderer', affected_paths: [template.candidate.notes[0].path], repair_scope: { status: 'located', section_ids: ['findings'], knowledge_ids: [], visual_ids: [], editor_fields: [] } }] };
  assert.equal((await accept(await nextReadingAction(session), 'review', review)).status, 'revision_required');
  assert.equal((await nextReadingAction(session)).kind, 'renderer-repair');
  await recordReadingEvent(session, { kind: 'renderer-repair' });
  await assert.rejects(() => nextReadingAction(session), /RENDER_REPAIR_UNAVAILABLE/);
  const existingTargets = template.candidate.notes.map(note => ({ path: note.path, bytes: Buffer.from(note.content.replace(note.language === 'en' ? '## Personal Notes' : '## 个人笔记', 'Renderer correction.\n\n' + (note.language === 'en' ? '## Personal Notes' : '## 个人笔记'))), managedHash: note.managedHash }));
  await recordReadingEvent(session, { kind: 'renderer-repair', renderOptions: { targetRegistry: template.candidate.targetRegistry, existingTargets } });
  const localReview = await nextReadingAction(session);
  assert.equal(localReview.stage, 'reading');
  const repeatReview={...review,issues:[...review.issues,{
    severity:'material',kind:'presentation',detail:'Clarify the reviewed finding.',repair_owner:'editor',
    repair_scope:{status:'located',section_ids:['findings'],knowledge_ids:[],visual_ids:[],editor_fields:[]},
  }]};
  assert.equal((await accept(localReview, 'review-r2', extended ? repeatReview : template.review)).status, extended ? 'completed_with_limits' : 'reading_complete');
  if (extended) {
    const inspection=await recordReadingEvent(session,{kind:'inspect-continuation'});
    await recordReadingEvent(session,{kind:'authorize-continuation',authorization:{authorization_id:'repair-renderer-again',
      reason:'Fix remaining renderer issue',checkpoint_fingerprint:inspection.checkpoint_fingerprint,issue_ids:inspection.issue_ids,
      max_additional_calls:inspection.required_additional_calls,max_additional_review_rounds:1}});
    await recordReadingEvent(session,{kind:'renderer-repair',renderOptions:{targetRegistry:template.candidate.targetRegistry,existingTargets}});
    const editor=structuredClone(template.editor);
    editor.languages.en.overview[0].text='This describes the bounded evidence and its limits.';
    await accept(await nextReadingAction(session),'presentation-r3',editor);
    await assert.rejects(()=>nextReadingAction(session),/RENDER_REPAIR_UNAVAILABLE/);
    const updatedTargets=existingTargets.map(row=>({...row,bytes:Buffer.from(row.bytes.toString().replace('Renderer correction.','Renderer second correction.'))}));
    await recordReadingEvent(session,{kind:'renderer-repair',renderOptions:{targetRegistry:template.candidate.targetRegistry,existingTargets:updatedTargets}});
    await accept(await nextReadingAction(session),'review-r3',template.review);
    assert.equal((await nextReadingAction(session)).status,'reading_complete');
  }
});

test('registers repair slots only when selected and validates science overrides', () => {
  const scientificInput = { role_artifacts: ['a', 'b', 'c', 'd', 'e', 'f'] };
  const options = { runId: 'run', scientificInput, sourceLanguage: 'zh-CN', checkpointCount: 2, includeRepairs: true };
  const result = buildReadingSessionTasks({ ...options, scienceTaskOverrides: { evidence: { native_path: 'other/evidence.json' } } });
  assert.equal(result.scienceTasks.evidence.native_path, 'other/evidence.json');
  assert.equal(result.taskBindings.en.role, 'translation');
  assert.equal(result.taskBindings['presentation-r2'].role, 'reading-editor');
  assert.throws(() => buildReadingSessionTasks({ ...options, scienceTaskOverrides: { evidence: { artifact_id: 'other' } } }), /TASK_OVERRIDE/);
  assert.throws(() => buildReadingSessionTasks({ ...options, taskOverrides: { en: { native_path: '../outside.json' } } }), /TASK_CONFLICT/);
});

test('rejects missing identities, unbounded checkpoints and conflicting task overrides', () => {
  const scientificInput = { role_artifacts: ['a', 'b', 'c', 'd', 'e', 'f'] };
  assert.throws(() => buildReadingSessionTasks({ runId: 'run', scientificInput, sourceLanguage: 'en' }), /CHECKPOINT_COUNT/);
  assert.throws(() => buildReadingSessionTasks({ runId: 'run', scientificInput: { role_artifacts: ['a'] }, sourceLanguage: 'en', checkpointCount: 1 }), /SCIENCE_IDENTITIES/);
  assert.throws(() => buildReadingSessionTasks({ runId: 'run', scientificInput, sourceLanguage: 'en', checkpointCount: 1, taskOverrides: { 'zh-CN': { role: 'chinese-writer' } } }), /TASK_OVERRIDE/);
});

test('predeclares independent enrichment tasks only for the selected policy and repair scope', () => {
  const options = { runId: 'run', scientificInput: { role_artifacts: ['a', 'b', 'c', 'd', 'e', 'f'] }, sourceLanguage: 'en', checkpointCount: 4 };
  const policy = { sources: [], allow_targeted_methods: true };
  const initial = buildReadingSessionTasks({ ...options, enrichmentPolicy: policy });
  for (const role of ['evidence', 'methods', 'results']) {
    const task = initial.taskBindings['enrich-initial-' + role];
    assert.equal(task.role, role);
    assert.equal(task.source_root, 'sources/enrich-initial-' + role);
    assert.equal(initial.taskBindings['enrich-late-' + role], undefined);
  }
  const repair = buildReadingSessionTasks({ ...options, enrichmentPolicy: policy, includeRepairs: true });
  assert.equal(repair.taskBindings['enrich-late-methods'].role, 'methods');
  assert.throws(() => buildReadingSessionTasks({ ...options, enrichmentPolicy: policy, taskOverrides: { 'enrich-initial-evidence': { source_root: '../outside' } } }), /TASK_CONFLICT/);
  assert.throws(() => buildReadingSessionTasks({ ...options, enrichmentPolicy: policy, taskOverrides: { 'enrich-initial-evidence': { source_root: 'native' } } }), /TASK_CONFLICT/);
  assert.throws(() => buildReadingSessionTasks({ ...options, enrichmentPolicy: policy, taskOverrides: { 'enrich-initial-evidence': { role: 'methods' } } }), /TASK_OVERRIDE/);
});

test('session freezes selected enrichment policy and profile', async t => {
  const f = await configuredFixture(t), policy = { sources: [], allow_targeted_methods: true };
  const session = await createReadingSession({ ...f.options, enrichmentPolicy: policy });
  assert.equal((await nextReadingAction(session)).role, 'evidence');
  const state = JSON.parse(await readFile(join(f.root, 'runs', 'run', 'control', 'science-state.json'), 'utf8'));
  const binding = state.data.prepared.runControl.reading_first_binding;
  assert.deepEqual(binding.enrichment_policy, policy);
  assert.equal(binding.enrichment_session_profile, 'reading-session-enrichment-1.0');
});

test('initial enrichment preserves the observed task across source snapshot recovery', async t => {
  const f = await configuredFixture(t), runRoot = join(f.root, 'runs', 'run');
  const gap = { id: 'design', question: 'What allocation was used?', impact: 'Changes interpretation', severity: 'material', owner_role: 'evidence', source_kind: 'cited_method', source_ids: [], target_sections: ['Study'] };
  let session = await createReadingSession({ ...f.options, enrichmentPolicy: { sources: [], allow_targeted_methods: true } });
  const content = await scienceOutputs(f);
  for (let i = 0; i < 6; i++) {
    const action = await nextReadingAction(session), observation = observe(action);
    await recordReadingEvent(session, { kind: 'host_observation', action_id: action.action_id, observation });
    await writeFile(join(runRoot, 'native', action.role + '.json'), JSON.stringify(content(action.role, action.role === 'integration' ? { important_gaps: [gap] } : {})));
    await recordReadingEvent(session, { kind: 'result', action_id: action.action_id, observation });
  }
  const action = await nextReadingAction(session), observation = observe(action);
  assert.equal(action.action, 'dispatch');
  assert.match(action.arguments.prompt, /enrich-initial-evidence/);
  await recordReadingEvent(session, { kind: 'host_observation', action_id: action.action_id, observation });
  await mkdir(join(runRoot, 'sources', 'enrich-initial-evidence'), { recursive: true });
  await writeFile(join(runRoot, 'sources', 'enrich-initial-evidence', 'snapshot.txt'), 'synthetic snapshot');
  session = await resumeReadingSession({ runRoot });
  await recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence });
  const pending = await nextReadingAction(session);
  assert.equal(pending.action, 'reconcile');
  assert.equal(pending.action_id, action.action_id);
  const snapshot = join(runRoot, 'sources', 'enrich-initial-evidence', 'snapshot.txt');
  const snapshotBytes = await readFile(snapshot);
  const source = { id: 'method', path: snapshot, sha256: 'sha256:' + createHash('sha256').update(snapshotBytes).digest('hex'), byte_length: snapshotBytes.length, version: 'v1', kind: 'cited_method', scope: 'synthetic method', reference: 'synthetic reference' };
  const answer = { gap_id: gap.id, classification: 'background', explanation: 'The source reports random allocation.', consequence: 'It supports the design account.', status: 'recovered', target_sections: ['Study'], source_ids: ['method'] };
  await writeFile(join(runRoot, 'native', 'enrich-initial-evidence.json'), JSON.stringify({ run_id: 'run', role: 'evidence', sources: [source], resolutions: [answer] }));
  await recordReadingEvent(session, { kind: 'result', action_id: action.action_id, observation });
  session = await resumeReadingSession({ runRoot });
  await recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence });
  const next = await nextReadingAction(session);
  assert.equal(next.action, 'dispatch');
  assert.match(await readFile(join(runRoot, 'instructions', 'en.txt'), 'utf8'), /random allocation/);
  await writeFile(snapshot, 'changed snapshot');
  await assert.rejects(() => resumeReadingSession({ runRoot }), /READING_FIRST_SOURCE_CHANGED/);
});

for (const total of [10, 11]) test(`initial enrichment reserves the full chain at total budget ${total}`, async t => {
  const f = await configuredFixture(t), runRoot = join(f.root, 'runs', 'run');
  const gap = { id: 'design', question: 'What allocation was used?', impact: 'Changes interpretation', severity: 'material', owner_role: 'evidence', source_kind: 'original_page', source_ids: [], target_sections: ['Study'] };
  const session = await createReadingSession({ ...f.options, maxCalls: 4, maxTotalCalls: total, enrichmentPolicy: { sources: [], allow_targeted_methods: true } });
  const content = await scienceOutputs(f);
  for (let i = 0; i < 6; i++) {
    const action = await nextReadingAction(session), observation = observe(action);
    await recordReadingEvent(session, { kind: 'host_observation', action_id: action.action_id, observation });
    await writeFile(join(runRoot, 'native', action.role + '.json'), JSON.stringify(content(action.role, action.role === 'integration' ? { important_gaps: [gap] } : {})));
    await recordReadingEvent(session, { kind: 'result', action_id: action.action_id, observation });
  }
  const next = await nextReadingAction(session);
  if (total === 10) { assert.equal(next.action, 'reconcile'); assert.equal(next.code, 'READING_FIRST_CALL_BUDGET_EXHAUSTED'); }
  else { assert.equal(next.action, 'dispatch'); assert.match(next.arguments.prompt, /enrich-initial-evidence/); }
});

for (const scenario of [{ sourceLanguage: 'en' }, { sourceLanguage: 'zh-CN' }, { sourceLanguage: 'en', noRepairs: true }, { sourceLanguage: 'en', shortBudget: true }, { sourceLanguage: 'en', translationOnly: true }, { sourceLanguage: 'en', translationOnly: true, extraReview: true }, { sourceLanguage: 'en', visualCorrection: true }, { sourceLanguage: 'en', visualCorrection: true, chartTypeCorrection: true }, { sourceLanguage: 'en', blockedRecovery: true }, { sourceLanguage: 'en', visualCorrection: true, editorRecovery: true }, { sourceLanguage: 'en', methodArchive: 'new' }, { sourceLanguage: 'en', methodArchive: 'duplicate' }]) test(`late session repair ${JSON.stringify(scenario)}`, async t => {
  const { sourceLanguage, noRepairs, shortBudget, translationOnly, visualCorrection, editorRecovery, chartTypeCorrection, blockedRecovery, extraReview, methodArchive } = scenario;
  const f = await configuredFixture(t, { systemTemp: Boolean(methodArchive) }), template = await configuredSessionTemplate(t);
  if (visualCorrection) {
    template.presentationCatalog.sources = [{ id: 'paper', path: template.presentationCatalog.source_pdf }];
    template.presentationCatalog.visuals[0].source_id = 'paper';
  }
  if (chartTypeCorrection || blockedRecovery) template.presentationCatalog.visuals[0].chart_types = [{ knowledge_id: 'method', label: { en: 'Intervals', 'zh-CN': '区间图' }, panel: 'b,d,e' }];
  if (blockedRecovery) f.profile.capabilities = { task_continuation: continuationCapability() };
  let session = await createReadingSession({ ...f.options, sourceLanguage, includeRepairs: !noRepairs, maxTotalCalls: shortBudget ? 14 : 15, enrichmentPolicy: { sources: [], allow_targeted_methods: true } });
  const runRoot = join(f.root, 'runs', 'run'), content = await scienceOutputs(f, template.presentationCatalog);
  const accept = async (action, path, value) => {
    assert.equal(action.action, 'dispatch');
    assert.match(action.arguments.prompt, new RegExp('native[\\\\/]' + path.replace('-', '\\-') + '\\.json'));
    const observation = observe(action);
    await recordReadingEvent(session, { kind: 'host_observation', action_id: action.action_id, observation });
    await writeFile(join(runRoot, 'native', path + '.json'), JSON.stringify(value));
    return recordReadingEvent(session, { kind: 'result', action_id: action.action_id, observation });
  };
  for (let i = 0; i < 6; i++) { const action = await nextReadingAction(session); await accept(action, action.role, content(action.role)); }
  const targetLanguage = sourceLanguage === 'en' ? 'zh-CN' : 'en';
  const viewFor = language => template.views.find(view => view.language === language);
  await accept(await nextReadingAction(session), sourceLanguage, viewFor(sourceLanguage));
  await accept(await nextReadingAction(session), targetLanguage, viewFor(targetLanguage));
  await accept(await nextReadingAction(session), 'presentation', template.editor);
  await recordReadingEvent(session, { kind: 'render-assets', renderOptions: {} });
  const gap = { id: 'late', question: 'What allocation was used?', impact: 'Changes interpretation', severity: 'material', owner_role: 'evidence', source_kind: 'original_page', source_ids: [], target_sections: ['Study'] };
  if (methodArchive) gap.source_kind = 'cited_method';
  const issue = { severity: 'material', kind: 'scientific-gap', detail: 'Allocation unclear', repair_owner: 'science', affected_languages: [targetLanguage], scientific_gap: gap, repair_scope: { status: 'located', section_ids: [template.views[1].sections[0].id], knowledge_ids: [], visual_ids: visualCorrection || blockedRecovery ? ['fig-one'] : [], editor_fields: [] } };
  if (translationOnly) { issue.repair_owner = 'writer'; delete issue.scientific_gap; }
  const first = await accept(await nextReadingAction(session), 'review', { ...template.review, issues: [issue] });
  if (noRepairs || shortBudget) {
    assert.equal(first.status, 'completed_with_limits');
    session = await resumeReadingSession({ runRoot });
    await recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence });
    const terminal=await nextReadingAction(session);
    assert.equal(terminal.status,'completed_with_limits');
    assert.equal(JSON.parse(await readFile(terminal.summary.state_ref)).state.enrichmentRound,null);
    if (noRepairs) {
      const bytes = await readFile(terminal.summary.state_ref);
      const closed = await recordReadingEvent(session, { kind: 'close-with-limits', authorization_id: 'synthetic-no-continuation', user_reply: '不再续接' });
      assert.equal(closed.terminal.status, 'completed_with_limits');
      assert.equal(closed.cleanup.snapshot_status, 'removed');
      assert.deepEqual(await readFile(terminal.summary.state_ref), bytes);
      await assert.rejects(resumeReadingSession({ runRoot }), /READING_SESSION_TERMINATED/);
      return;
    }
    const plan=await recordReadingEvent(session,{kind:'inspect-continuation'});
    assert.equal(plan.can_continue,true);
    assert.equal(plan.required_additional_calls,1);
    assert.equal(plan.remaining_task_keys[0],'enrich-late-evidence');
    await recordReadingEvent(session,{kind:'authorize-continuation',authorization:{authorization_id:'late-gap-budget',
      reason:'Approved late gap and downstream repairs',checkpoint_fingerprint:plan.checkpoint_fingerprint,issue_ids:plan.issue_ids,
      max_additional_calls:plan.recommended_additional_calls,max_additional_review_rounds:0}});
  } else assert.equal(first.status,'revision_required');
  const answer = { gap_id: gap.id, classification: 'paper_fact', explanation: 'The source reports random allocation.', consequence: 'It supports the design account.', status: 'recovered', target_sections: ['Study'], source_ids: ['paper'] };
  let archivedMethod;
  if (methodArchive) {
    const folder = join(runRoot, 'sources', 'enrich-late-evidence');
    await mkdir(folder, { recursive: true });
    const path = join(folder, 'method.pdf'), bytes = Buffer.from('Synthetic accepted method document');
    await writeFile(path, bytes);
    if (methodArchive === 'duplicate') await writeFile(join(f.root, 'Clippings', 'same-method.pdf'), bytes);
    archivedMethod = { id: 'used-method', path, sha256: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), byte_length: bytes.length,
      version: 'v1', kind: 'cited_method', scope: 'Allocation method', reference: 'Method reference', title: 'Verified synthetic method',
      doi: null, trace_reason: 'Explain the allocation method' };
    answer.classification = 'background';
    answer.source_ids = [archivedMethod.id];
  }
  const visualCorrections = [{ visual_id: 'fig-one', source_id: 'paper', page: 1, label: { en: 'Recovered figure', 'zh-CN': '恢复图像' }, caption: { en: 'Recovered original caption.', 'zh-CN': '已恢复的原始图注。' } }];
  if (chartTypeCorrection) visualCorrections[0].chart_types = [{ knowledge_id: 'method', label: { en: 'Intervals', 'zh-CN': '区间图' }, panel: 'd,e' }];
  if (!translationOnly) await accept(await nextReadingAction(session), 'enrich-late-evidence', { run_id: 'run', role: 'evidence', resolutions: [answer],
    ...(archivedMethod ? { sources: [archivedMethod] } : {}), ...(visualCorrection ? { visual_corrections: visualCorrections } : {}) });
  const en = structuredClone(template.views[0]), zh = structuredClone(template.views[1]);
  if (!translationOnly) {
    for (const view of [en, zh]) view.enrichment_consumption = [{ gap_id: 'late', section_heading: view.sections[0].heading }];
    await accept(await nextReadingAction(session), sourceLanguage + '-r2', sourceLanguage === 'en' ? en : zh);
  }
  await accept(await nextReadingAction(session), targetLanguage + '-r2', targetLanguage === 'en' ? en : zh);
  const editorAction = await nextReadingAction(session);
  if (!translationOnly) {
    const payload = JSON.parse((await readFile(join(runRoot, 'instructions', 'presentation-r2.txt'), 'utf8')).split('\n\n').at(-1));
    assert.deepEqual(payload.issues, [issue]);
  }
  const revisedEditor = { ...structuredClone(template.editor), views_fingerprint: readingFirstViewsFingerprint([en, zh]) };
  if (blockedRecovery) {
    const observation = observe(editorAction);
    await recordReadingEvent(session, { kind: 'host_observation', action_id: editorAction.action_id, observation });
    const intent = { kind: 'continuation-intent', action_id: editorAction.action_id, execution_id: 'editor-scope-recovery', message: 'Complete the original scoped Editor task.' };
    await assert.rejects(() => recordReadingEvent(session, intent), /CALL_BUDGET_EXHAUSTED/);
    const inspection = await recordReadingEvent(session,{kind:'inspect-continuation'});
    assert.equal(inspection.reason,'READING_FIRST_CONTINUATION_RECONCILIATION_REQUIRED');
    assert.deepEqual(inspection.unreconciled_tasks.map(row=>[row.task_id,row.reconcile_with]),[['presentation-r2','result']]);
    await assert.rejects(() => recordReadingEvent(session,{kind:'authorize-continuation',authorization:{
      authorization_id:'early',reason:'Repair',checkpoint_fingerprint:inspection.checkpoint_fingerprint,
      max_additional_calls:3,max_additional_review_rounds:0,issue_ids:inspection.issue_ids,
    }}),/RECONCILIATION_REQUIRED/);
    const invalid=structuredClone(revisedEditor);
    invalid.outside_scope=true;
    assert.equal((await accept(editorAction,'presentation-r2',invalid)).status,'completed_with_limits');
    const plan=await recordReadingEvent(session,{kind:'inspect-continuation'});
    assert.equal(plan.can_continue,true);
    assert.deepEqual(plan.remaining_task_keys,['presentation-r3','review-r2']);
    const authorization={authorization_id:'after-rejected-editor',reason:'Retry scoped Editor and recheck',
      checkpoint_fingerprint:plan.checkpoint_fingerprint,max_additional_calls:3,max_additional_review_rounds:0,issue_ids:plan.issue_ids,
      chart_type_corrections:[{visual_id:'fig-one',chart_types:[{knowledge_id:'method',label:{en:'Intervals','zh-CN':'Interval'},panel:'d,e'}]}]};
    await assert.rejects(()=>recordReadingEvent(session,{kind:'authorize-continuation',authorization:{...authorization,
      chart_type_corrections:[{...authorization.chart_type_corrections[0],visual_id:'unreviewed'}]}}),/VISUAL_CORRECTION_INVALID/);
    await recordReadingEvent(session,{kind:'authorize-continuation',authorization});
    await accept(await nextReadingAction(session),'presentation-r3',revisedEditor);
  }
  if (editorRecovery) {
    for (const language of ['en', 'zh-CN']) revisedEditor.languages[language].visuals = [{ id: 'fig-one', title: 'Recovered title', notes: [] }];
    const observation = observe(editorAction, 'synthetic-editor-r2');
    await recordReadingEvent(session, { kind: 'host_observation', action_id: editorAction.action_id, observation });
    await writeFile(join(runRoot, 'native/presentation-r2.json'), JSON.stringify(revisedEditor));
    const { data } = JSON.parse(await readFile(join(runRoot, 'control/science-state.json'), 'utf8'));
    assert.equal(data.prepared.runControl.reading_first_binding.presentation_profile, 'reading-editor-1.4');
    const broker = createOwnedArtifactBroker(data.brokerConfig);
    const controls = data.brokerConfig.authorized_bindings.filter(row => /^control\/reading-checkpoint-\d+\.json$/.test(row.artifact_path)).sort((a, b) => Number(a.revision) - Number(b.revision));
    let last, next;
    for (const row of controls) { const record = await readOwnedArtifact({ artifactRoot: runRoot, artifactId: 'reading-checkpoint-' + row.revision }); if (!record) { next = row; break; } last = record; }
    const handoff = await readingRuntime.buildReadingFirstHandoff({ run: { run_id: 'run' }, dispatchContext: broker.dispatchContext, artifactRoot: runRoot, scientificInput: data.prepared.scientificInput });
    const restored = await readingRuntime.restoreReadingFirstRuntime({ handoff, runControl: { runId: 'run', artifactRoot: runRoot, dispatchContext: broker.dispatchContext }, checkpointReceipt: last.receipt });
    assert.equal(restored.ok, true, JSON.stringify(restored.errors));
    const request = restored.requests.find(row => row.emittedStep.action_id === editorAction.action_id);
    readingRuntime.recordReadingFirstRequestEvent({ controller: restored.controller, request, eventKey: 'result', payload: observation });
    const accepted = await readingRuntime.acceptReadingFirstResult({ controller: restored.controller, request, observation, capability: broker.issueCapability({ runId: 'run', actorId: request.task.owner_actor_id, role: request.task.role, artifactPath: request.task.artifact_path, revision: request.task.revision }) });
    // Synthetic historical equal-length rejection, retaining the real synthetic
    // owned bytes and observations. The former runtime omitted readingEditor.
    const historical = structuredClone(readingRuntime.snapshotReadingFirstRuntime(restored.controller));
    if (accepted.status !== 'completed_with_limits') historical.state.draftsRevision--;
    delete historical.state.readingEditor;
    historical.state.status = 'completed_with_limits';
    historical.state.rejection = { reason: 'READING_FIRST_REPAIR_SCOPE_EXCEEDED', task_id: request.task.task_id, native_path: join(runRoot, request.task.native_path), sha256: accepted.receipt.sha256, byte_length: accepted.receipt.byte_length, receipt: accepted.receipt, host: historical.state.observations.at(-1).host };
    delete historical.checkpoint_fingerprint;
    historical.checkpoint_fingerprint = readingRuntime.fingerprintReadingFirst(historical);
    await commitOwnedArtifact({ artifactRoot: runRoot, dispatchContext: broker.dispatchContext, capability: broker.issueCapability({ runId: 'run', actorId: next.actor_id, role: next.role, artifactPath: next.artifact_path, revision: next.revision }), artifact: { artifact_id: 'reading-checkpoint-' + next.revision, content: JSON.stringify(historical) }, expectedRevision: next.revision });
    session = await resumeReadingSession({ runRoot });
    await recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence });
    assert.equal((await nextReadingAction(session)).status, 'completed_with_limits');
    const recovery = { kind: 'recover-rejected-editor', authorization: { authorization_id: 'synthetic-explicit-recovery', reason: 'User approved bounded recovery.', checkpoint_fingerprint: historical.checkpoint_fingerprint, rejection_fingerprint: readingRuntime.fingerprintReadingFirst(historical.state.rejection), max_additional_calls: 1 } };
    const recovered = await recordReadingEvent(session, recovery);
    assert.equal(recovered.status, 'pending_review');
    session = await resumeReadingSession({ runRoot });
    await recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence });
    assert.deepEqual(await recordReadingEvent(session, recovery), recovered);
    await recordReadingEvent(session, { kind: 'render-assets', renderOptions: {} });
  } else if (!blockedRecovery) await accept(editorAction, 'presentation-r2', revisedEditor);
  const local = await nextReadingAction(session);
  if (chartTypeCorrection || blockedRecovery) {
    const input = await readFile(join(runRoot, 'instructions', 'review-r2.txt'), 'utf8');
    assert.match(input, /d,e/);
    const { data } = JSON.parse(await readFile(join(runRoot, 'control/science-state.json'), 'utf8'));
    assert.equal(data.prepared.runControl.reading_first_binding.max_total_calls, 15);
  }
  if (visualCorrection) assert.match(await readFile(join(runRoot, 'instructions', 'review-r2.txt'), 'utf8'), /Recovered original caption/);
  const inventoryIssue = { severity: 'material', kind: 'method-inventory', repair_owner: 'editor', detail: 'Clarify the feeding duration in both method applications.',
    affected_languages: ['en', 'zh-CN'], repair_scope: { status: 'located', section_ids: ['methods'], knowledge_ids: [], visual_ids: [], editor_fields: [] } };
  await accept(local, 'review-r2', extraReview ? { ...template.review, issues: [inventoryIssue] } : template.review);
  if (extraReview) {
    const terminal = await nextReadingAction(session);
    assert.equal(terminal.status, 'completed_with_limits');
    const previous = await readFile(terminal.summary.state_ref);
    const inspection=await recordReadingEvent(session,{kind:'inspect-continuation'});
    assert.equal(inspection.can_continue,true);
    assert.deepEqual(inspection.remaining_task_keys,['presentation-r3','review-r3']);
    const authorization = { authorization_id: 'extra-local-review', reason: 'Explicit authorization for one more local review and its Editor repair.',
      checkpoint_fingerprint: JSON.parse(previous).checkpoint_fingerprint, max_additional_calls: 2, max_additional_review_rounds:1,issue_ids:inspection.issue_ids };
    await assert.rejects(() => recordReadingEvent(session, { kind: 'authorize-continuation', authorization: { ...authorization, issue_ids: ['unrelated'] } }), /AUTHORIZATION_INVALID/);
    await recordReadingEvent(session, { kind: 'authorize-continuation', authorization });
    assert.deepEqual(await readFile(terminal.summary.state_ref), previous);
    session = await resumeReadingSession({ runRoot });
    await recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence });
    const editor = structuredClone(revisedEditor);
    editor.languages.en.methods[0].application = 'Tested after eight weeks of feeding.';
    editor.languages['zh-CN'].methods[0].application = '喂养 8 周后测定。';
    await accept(await nextReadingAction(session), 'presentation-r3', editor);
    const recheck = await nextReadingAction(session);
    const instruction = await readFile(join(runRoot, 'instructions/review-r3.txt'), 'utf8');
    assert.match(instruction, /eight weeks of feeding/);
    assert.match(instruction, /Clarify the feeding duration/);
    await accept(recheck, 'review-r3', template.review);
    session = await resumeReadingSession({ runRoot });
    await recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence });
  }
  const done = await nextReadingAction(session);
  if (extraReview) {
    assert.equal(done.summary.budget.total_limit, 17);
    const ready = await inspectReadingFirstPublicationSource(done.publication_source);
    assert.equal(ready.recipe.checkpoint.state.reviews, 3);
    assert.equal(ready.review_receipt.path, 'reading/review-r3.json');
    await readingRuntime.restoreReadingFirstPublicationSource(ready.recipe);
    const legacy=structuredClone(ready.recipe);
    const [row]=legacy.checkpoint.state.continuationAuthorizations;
    delete legacy.checkpoint.state.continuationAuthorizations;
    legacy.checkpoint.state.reviewExtension={authorization:{...row.authorization,method_id:'method'},prior_checkpoint:row.prior_checkpoint,
      original_total_limit:legacy.binding.max_total_calls,baseline_execution_count:row.baseline_execution_count,
      baseline_ledger_fingerprint:row.baseline_ledger_fingerprint};
    delete legacy.checkpoint.checkpoint_fingerprint;
    legacy.checkpoint.checkpoint_fingerprint=readingRuntime.fingerprintReadingFirst(legacy.checkpoint);
    delete legacy.recipe_fingerprint;
    legacy.recipe_fingerprint=readingRuntime.fingerprintReadingFirst(legacy);
    await readingRuntime.restoreReadingFirstPublicationSource(legacy);
  }
  assert.equal(done.status, 'reading_complete');
  if (archivedMethod) {
    assert.equal(done.used_method_sources[0].raw_status, 'pending_publication');
    assert.equal(done.used_method_sources[0].doi, null);
    const inspected = await inspectReadingFirstPublicationSource(done.publication_source);
    const original = f.options.scientificInput.sources[0];
    const result = await publishReadingFirstCandidate({ source: done.publication_source, vaultRoot: f.root,
      generation: 'method-publication', evidenceMode: 'synthetic', authorization: { authorization_id: 'method-test', user_reply: '发布' }, onPrepared() {},
      resources: [{ path: inspected.presentation.source_pdf, source_path: original.path, sha256: original.sha256, byte_length: original.byte_length },
        ...inspected.results_resource_manifest.resources.map(({ path, source_path, sha256, byte_length }) => ({ path, source_path, sha256, byte_length }))] });
    assert.equal(result.status, 'committed', JSON.stringify(result.error));
    const report = result.publication_sources, target = methodArchive === 'new' ? 'Raw/run/method.pdf' : 'Clippings/same-method.pdf';
    for (const note of inspected.candidate.notes) assert.ok((await readFile(join(f.root, note.path), 'utf8')).includes('../../' + target));
    if (methodArchive === 'new') {
      assert.equal(report.raw_supplements[0].path, target);
      assert.equal(report.raw_supplements[0].title, archivedMethod.title);
      assert.equal(report.raw_supplements[0].trace_reason, archivedMethod.trace_reason);
      assert.equal(report.raw_supplements[0].notes.length, 2);
      assert.ok((await readFile(result.result_path, 'utf8')).includes(archivedMethod.title));
    } else {
      assert.equal(report.raw_supplements.length, 0);
      assert.equal(report.source_path_remaps[0].new_path, target);
      await assert.rejects(readFile(join(f.root, 'Raw', 'run', 'method.pdf')), /ENOENT/);
    }
  }

});

test('empty enrichment policy preserves exact requests and instructions without gaps', async t => {
  const f = await configuredFixture(t), template = await configuredSessionTemplate(t);
  const runRoot = join(f.root, 'runs', 'run');
  const run = async withPolicy => {
    const session = await createReadingSession({ ...f.options, ...(withPolicy ? { enrichmentPolicy: { sources: [], allow_targeted_methods: true } } : {}) });
    const content = await scienceOutputs(f, template.presentationCatalog);
    const accept = async (action, path, value) => {
      const observation = observe(action);
      await recordReadingEvent(session, { kind: 'host_observation', action_id: action.action_id, observation });
      await writeFile(join(runRoot, 'native', path + '.json'), JSON.stringify(value));
      await recordReadingEvent(session, { kind: 'result', action_id: action.action_id, observation });
    };
    for (let i = 0; i < 6; i++) { const action = await nextReadingAction(session); await accept(action, action.role, content(action.role)); }
    const captured = [];
    for (const [path, value] of [['en', template.views[0]], ['zh-CN', template.views[1]], ['presentation', template.editor], ['review', template.review]]) {
      if (path === 'review') await recordReadingEvent(session, { kind: 'render-assets', renderOptions: {} });
      const action = await nextReadingAction(session);
      assert.ok(action.action_id);
      captured.push({ name: action.host_action, arguments: action.arguments, instruction: await readFile(join(runRoot, 'instructions', path + '.txt')) });
      await accept(action, path, value);
    }
    if (withPolicy) {
      const done = await nextReadingAction(session);
      const publication = await inspectReadingFirstPublicationSource(done.publication_source);
      assert.equal(publication.calls_used, 10);
      assert.ok(publication.source_bindings.every(row => !row.path.includes('enrich-')));
      assert.ok(publication.recipe.checkpoint.state.observations.every(row => !JSON.stringify(row).includes('enrich-')));
    } else {
      const closed = await recordReadingEvent(session, { kind: 'terminate', authorization_id: 'synthetic-baseline-close', user_reply: '终止' });
      assert.equal(closed.cleanup.snapshot_status, 'removed');
    }
    return captured;
  };
  const baseline = await run(false);
  // Preserve the closed fixture while giving the second independent run the exact same input paths.
  const prior = join(f.root, 'closed-fixture');
  await mkdir(prior);
  await rename(runRoot, join(prior, 'run'));
  await rename(join(f.root, 'candidates', 'run'), join(prior, 'candidate'));
  const withPolicy = await run(true);
  assert.deepEqual(withPolicy, baseline);
});

for (const superseded of [false,true]) test('the committed paper rejects continuation, superseded='+superseded,async t=>{
  const vault=await readingFirstIndexFixture(t);
  const run=await reviewedReadingFirstFixture(t,{currentRegistryRoot:vault.vaultRoot,runId:superseded ? 'run_'+'b'.repeat(32) : vault.identity.run_id});
  await vault.save(vault.build());
  const inspection=await readingRuntime.inspectReadingFirstContinuation({controller:run.controller});
  assert.equal(inspection.reason,'READING_FIRST_CONTINUATION_PUBLISHED');
  await assert.rejects(()=>readingRuntime.authorizeReadingFirstContinuation({controller:run.controller,authorization:{authorization_id:'denied'}}),/CONTINUATION_PUBLISHED/);
});
