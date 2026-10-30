import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { inspectReadingFirstPublicationSource } from '../../scripts/v3/reading-first-runtime.mjs';
import { readingFirstViewsFingerprint } from '../../scripts/v3/reading-first-editor.mjs';
import { buildReadingSessionTasks } from '../../scripts/v3/reading-session-tasks.mjs';
import { createReadingSession, resumeReadingSession, nextReadingAction, recordReadingEvent } from '../../scripts/v3/reading-session.mjs';
import { reviewedReadingFirstFixture } from './helpers/reading-first-publication-source-fixtures.mjs';

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

async function configuredFixture(t) {
  const base = join(process.cwd(), '.tmp', 'apa-session-enrichment-20261030');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'session-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
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
  return { root, profile, evidence, options: { repoRoot: root, runId: 'run', scientificInput, sourceLanguage: 'en', authorizationId: 'test', deadline: '2099-01-01T00:00:00Z', maxCalls: 8, maxTotalCalls: 14, sessionContext: { model: 'm', effort: 'high' }, hostProfile: profile, evidence, includeRepairs: true } };
}

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
  const observation = { action_id: first.action_id, run_id: first.run_id, input_fingerprint: first.input_fingerprint, port: first.port, tool_call: { name: first.host_action, arguments: first.arguments }, raw_result_text: JSON.stringify({ agent_id: 'host-evidence' }) };
  await recordReadingEvent(session, { kind: 'host_observation', action_id: first.action_id, observation });
  assert.equal((await nextReadingAction(session)).action, 'wait');
  const progress = { action_id: first.action_id, agent_id: 'host-evidence', raw_result_text: 'working', tool_call: { name: 'query', arguments: {} } };
  const progressEvent = { kind: 'host_update', action_id: first.action_id, host_event_id: 'event-1', observation: progress };
  assert.deepEqual(await recordReadingEvent(session, progressEvent), await recordReadingEvent(session, progressEvent));
  await assert.rejects(() => recordReadingEvent(session, { ...progressEvent, observation: { ...progress, raw_result_text: 'changed' } }), /SCIENCE_HOST_EVENT_CONFLICT/);
  await mkdir(join(f.root, 'runs', 'run', 'native'), { recursive: true });
  await writeFile(join(f.root, 'runs', 'run', 'native', 'evidence.json'), JSON.stringify({ role: 'evidence', text: 'synthetic' }));
  await recordReadingEvent(session, { kind: 'result', action_id: first.action_id });
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
  const f = await configuredFixture(t);
  const template = await reviewedReadingFirstFixture(t, { controlOptions: { presentationProfile: 'reading-editor-1.3' } });
  let session = await createReadingSession(f.options);
  const runRoot = join(f.root, 'runs', 'run');
  await mkdir(join(runRoot, 'native'), { recursive: true });
  const observe = action => ({ action_id: action.action_id, run_id: action.run_id, input_fingerprint: action.input_fingerprint, port: action.port, tool_call: { name: action.host_action, arguments: action.arguments }, raw_result_text: JSON.stringify({ agent_id: 'host-' + action.action_id }) });
  const accept = async (action, nativePath, value) => {
    const observation = observe(action);
    await recordReadingEvent(session, { kind: 'host_observation', action_id: action.action_id, observation });
    await writeFile(join(runRoot, 'native', nativePath + '.json'), JSON.stringify(value));
    return recordReadingEvent(session, { kind: 'result', action_id: action.action_id, observation });
  };
  for (let i = 0; i < 6; i++) {
    const action = await nextReadingAction(session);
    assert.equal(action.action, 'dispatch');
    await accept(action, action.role, { role: action.role, text: 'synthetic', ...(action.role === 'integration' ? { presentation: template.presentationCatalog } : {}) });
  }
  let action = await nextReadingAction(session);
  assert.equal(action.stage, 'reading');
  const writerObservation = observe(action);
  await recordReadingEvent(session, { kind: 'host_observation', action_id: action.action_id, observation: writerObservation });
  const update = { kind: 'host_update', action_id: action.action_id, agent_id: 'host-' + action.action_id, raw_result_text: 'working', tool_call: { name: 'query', arguments: {} } };
  const updateEvent = { kind: 'host_update', action_id: action.action_id, host_event_id: 'progress-1', observation: update };
  assert.deepEqual(await recordReadingEvent(session, updateEvent), await recordReadingEvent(session, updateEvent));
  await assert.rejects(() => recordReadingEvent(session, { ...updateEvent, observation: { ...update, raw_result_text: 'changed' } }), /REQUEST_EVENT_CONFLICT/);
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
  const resources = [{ path: template.presentationCatalog.source_pdf, source_path: source.path, sha256: source.sha256, byte_length: source.byte_length }, template.resources[1]];
  await recordReadingEvent(session, { kind: 'render-assets', resources, renderOptions: {} });
  action = await nextReadingAction(session);
  assert.equal(action.stage, 'reading');
  await accept(action, 'review', template.review);
  const done = await nextReadingAction(session);
  assert.equal(done.action, 'complete');
  assert.equal(done.status, 'reading_complete');
  assert.equal(done.publishable, false);
  session = await resumeReadingSession({ runRoot });
  await recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence });
  assert.equal((await nextReadingAction(session)).kind, 'render-assets');
  await recordReadingEvent(session, { kind: 'render-assets', resources, renderOptions: {} });
  assert.equal((await nextReadingAction(session)).status, 'reading_complete');
});

test('synthetic science completes in dependency order and restores the pending writer', async t => {
  const f = await configuredFixture(t);
  let session = await createReadingSession(f.options);
  const seen = [];
  for (let i = 0; i < 6; i++) {
    const action = await nextReadingAction(session);
    assert.equal(action.action, 'dispatch');
    seen.push(action.role);
    const observation = { action_id: action.action_id, run_id: action.run_id, input_fingerprint: action.input_fingerprint, port: action.port, tool_call: { name: action.host_action, arguments: action.arguments }, raw_result_text: JSON.stringify({ agent_id: `host-${action.role}` }) };
    await recordReadingEvent(session, { kind: 'host_observation', action_id: action.action_id, observation });
    await mkdir(join(f.root, 'runs', 'run', 'native'), { recursive: true });
    await writeFile(join(f.root, 'runs', 'run', 'native', action.role + '.json'), JSON.stringify({ role: action.role, text: 'synthetic' }));
    await recordReadingEvent(session, { kind: 'result', action_id: action.action_id });
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
  const f = await configuredFixture(t), template = await reviewedReadingFirstFixture(t, { controlOptions: { presentationProfile: 'reading-editor-1.3' } });
  let session = await createReadingSession(f.options);
  const runRoot = join(f.root, 'runs', 'run'); await mkdir(join(runRoot, 'native'), { recursive: true });
  const observationFor = action => ({ action_id: action.action_id, run_id: action.run_id, input_fingerprint: action.input_fingerprint, port: action.port, tool_call: { name: action.host_action, arguments: action.arguments }, raw_result_text: JSON.stringify({ agent_id: 'host-' + action.action_id }) });
  for (let i = 0; i < 6; i++) {
    const action = await nextReadingAction(session), observation = observationFor(action);
    await recordReadingEvent(session, { kind: 'host_observation', action_id: action.action_id, observation });
    await writeFile(join(runRoot, 'native', action.role + '.json'), JSON.stringify({ role: action.role, text: 'synthetic', ...(action.role === 'integration' ? { presentation: template.presentationCatalog } : {}) }));
    await recordReadingEvent(session, { kind: 'result', action_id: action.action_id });
  }
  const action = await nextReadingAction(session), observation = observationFor(action);
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
  const runRoot = join(f.root, 'runs', 'run'); await mkdir(join(runRoot, 'native'), { recursive: true });
  for (let i = 0; i < 6; i++) {
    const action = await nextReadingAction(session);
    const observation = { action_id: action.action_id, run_id: action.run_id, input_fingerprint: action.input_fingerprint, port: action.port, tool_call: { name: action.host_action, arguments: action.arguments }, raw_result_text: JSON.stringify({ agent_id: 'host-' + action.action_id }) };
    await recordReadingEvent(session, { kind: 'host_observation', action_id: action.action_id, observation });
    await writeFile(join(runRoot, 'native', action.role + '.json'), JSON.stringify({ role: action.role, text: 'synthetic' }));
    await recordReadingEvent(session, { kind: 'result', action_id: action.action_id });
  }
  const now = new Date().toISOString();
  await recordReadingEvent(session, { kind: 'compaction', input: { sessionId: 'main', observation: { session_id: 'main', observed_at: now, context: { tokens: 190000, kind: 'current-context', measured_at: now, fresh: true, source: 'synthetic meter' }, manual_compaction: { available: true, method: 'synthetic compact', source: 'synthetic host' } }, progress: { remaining_work: { multiple_responses: true, reason: 'writing remains' }, growth: { substantial: true, reason: 'science grew' } } } });
  assert.equal((await nextReadingAction(session)).action, 'await-user');
  session = await resumeReadingSession({ runRoot });
  await recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence });
  assert.equal((await nextReadingAction(session)).action, 'await-user');
  await recordReadingEvent(session, { kind: 'compaction', input: { userDecision: 'skip' } });
  assert.equal((await nextReadingAction(session)).action, 'dispatch');
});

test('control slot exhaustion blocks dispatch without changing the model-call budget', async t => {
  const f = await configuredFixture(t), session = await createReadingSession({ ...f.options, maxControlCheckpoints: 4 });
  const runRoot = join(f.root, 'runs', 'run'); await mkdir(join(runRoot, 'native'), { recursive: true });
  for (let i = 0; i < 6; i++) {
    const action = await nextReadingAction(session);
    const observation = { action_id: action.action_id, run_id: action.run_id, input_fingerprint: action.input_fingerprint, port: action.port, tool_call: { name: action.host_action, arguments: action.arguments }, raw_result_text: JSON.stringify({ agent_id: 'host-' + action.action_id }) };
    await recordReadingEvent(session, { kind: 'host_observation', action_id: action.action_id, observation });
    await writeFile(join(runRoot, 'native', action.role + '.json'), JSON.stringify({ role: action.role, text: 'synthetic' }));
    await recordReadingEvent(session, { kind: 'result', action_id: action.action_id });
  }
  const blocked = await nextReadingAction(session);
  assert.equal(blocked.action, 'reconcile');
  assert.equal(blocked.code, 'CONTROL_CHECKPOINT_CAPACITY');
});

test('material editor issue receives one bounded repair and a second candidate', async t => {
  const f = await configuredFixture(t), template = await reviewedReadingFirstFixture(t, { controlOptions: { presentationProfile: 'reading-editor-1.3' } });
  let session = await createReadingSession(f.options);
  const runRoot = join(f.root, 'runs', 'run'); await mkdir(join(runRoot, 'native'), { recursive: true });
  const accept = async (action, path, value) => {
    const observation = { action_id: action.action_id, run_id: action.run_id, input_fingerprint: action.input_fingerprint, port: action.port, tool_call: { name: action.host_action, arguments: action.arguments }, raw_result_text: JSON.stringify({ agent_id: 'host-' + action.action_id }) };
    await recordReadingEvent(session, { kind: 'host_observation', action_id: action.action_id, observation });
    await writeFile(join(runRoot, 'native', path + '.json'), JSON.stringify(value));
    return recordReadingEvent(session, { kind: 'result', action_id: action.action_id, observation });
  };
  for (let i = 0; i < 6; i++) {
    const action = await nextReadingAction(session);
    await accept(action, action.role, { role: action.role, text: 'synthetic', ...(action.role === 'integration' ? { presentation: template.presentationCatalog } : {}) });
  }
  await accept(await nextReadingAction(session), 'en', template.views[0]);
  await accept(await nextReadingAction(session), 'zh-CN', template.views[1]);
  await accept(await nextReadingAction(session), 'presentation', template.editor);
  const source = f.options.scientificInput.sources[0];
  const resources = [{ path: template.presentationCatalog.source_pdf, source_path: source.path, sha256: source.sha256, byte_length: source.byte_length }, template.resources[1]];
  await recordReadingEvent(session, { kind: 'render-assets', resources, renderOptions: {} });
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
  await recordReadingEvent(session, { kind: 'render-assets', resources, renderOptions: {} });
  assert.equal((await nextReadingAction(session)).status, 'reading_complete');
});

test('rejected review is checkpointed as completed with limits and stays terminal', async t => {
  const f = await configuredFixture(t), template = await reviewedReadingFirstFixture(t, { controlOptions: { presentationProfile: 'reading-editor-1.3' } });
  let session = await createReadingSession(f.options);
  const runRoot = join(f.root, 'runs', 'run'); await mkdir(join(runRoot, 'native'), { recursive: true });
  const accept = async (action, path, value) => {
    const observation = { action_id: action.action_id, run_id: action.run_id, input_fingerprint: action.input_fingerprint, port: action.port, tool_call: { name: action.host_action, arguments: action.arguments }, raw_result_text: JSON.stringify({ agent_id: 'host-' + action.action_id }) };
    await recordReadingEvent(session, { kind: 'host_observation', action_id: action.action_id, observation });
    await writeFile(join(runRoot, 'native', path + '.json'), JSON.stringify(value));
    return { result: await recordReadingEvent(session, { kind: 'result', action_id: action.action_id, observation }), observation };
  };
  for (let i = 0; i < 6; i++) {
    const action = await nextReadingAction(session);
    await accept(action, action.role, { role: action.role, text: 'synthetic', ...(action.role === 'integration' ? { presentation: template.presentationCatalog } : {}) });
  }
  await accept(await nextReadingAction(session), 'en', template.views[0]);
  await accept(await nextReadingAction(session), 'zh-CN', template.views[1]);
  await accept(await nextReadingAction(session), 'presentation', template.editor);
  const source = f.options.scientificInput.sources[0];
  await recordReadingEvent(session, { kind: 'render-assets', resources: [{ path: template.presentationCatalog.source_pdf, source_path: source.path, sha256: source.sha256, byte_length: source.byte_length }, template.resources[1]], renderOptions: {} });
  const action = await nextReadingAction(session);
  const review = { ...template.review, issues: [{ severity: 'material', kind: 'presentation', detail: 'Unknown location.', repair_owner: 'editor', repair_scope: { status: 'unresolved', section_ids: [], knowledge_ids: [], visual_ids: [], editor_fields: [] } }] };
  const { result, observation } = await accept(action, 'review', review);
  assert.equal(result.status, 'completed_with_limits');
  assert.equal(result.checkpoint_required, false);
  session = await resumeReadingSession({ runRoot });
  await recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence });
  assert.equal((await nextReadingAction(session)).status, 'completed_with_limits');
  assert.deepEqual(await recordReadingEvent(session, { kind: 'result', action_id: action.action_id, observation }), result);
});

test('renderer-only issue requests repaired inputs and performs one local review', async t => {
  const f = await configuredFixture(t), template = await reviewedReadingFirstFixture(t, { controlOptions: { presentationProfile: 'reading-editor-1.3' } });
  const session = await createReadingSession(f.options), runRoot = join(f.root, 'runs', 'run');
  await mkdir(join(runRoot, 'native'), { recursive: true });
  const accept = async (action, path, value) => {
    const observation = { action_id: action.action_id, run_id: action.run_id, input_fingerprint: action.input_fingerprint, port: action.port, tool_call: { name: action.host_action, arguments: action.arguments }, raw_result_text: JSON.stringify({ agent_id: 'host-' + action.action_id }) };
    await recordReadingEvent(session, { kind: 'host_observation', action_id: action.action_id, observation });
    await writeFile(join(runRoot, 'native', path + '.json'), JSON.stringify(value));
    return recordReadingEvent(session, { kind: 'result', action_id: action.action_id, observation });
  };
  for (let i = 0; i < 6; i++) {
    const action = await nextReadingAction(session);
    await accept(action, action.role, { role: action.role, text: 'synthetic', ...(action.role === 'integration' ? { presentation: template.presentationCatalog } : {}) });
  }
  await accept(await nextReadingAction(session), 'en', template.views[0]);
  await accept(await nextReadingAction(session), 'zh-CN', template.views[1]);
  await accept(await nextReadingAction(session), 'presentation', template.editor);
  const source = f.options.scientificInput.sources[0];
  await recordReadingEvent(session, { kind: 'render-assets', resources: [{ path: template.presentationCatalog.source_pdf, source_path: source.path, sha256: source.sha256, byte_length: source.byte_length }, template.resources[1]], renderOptions: {} });
  const review = { ...template.review, issues: [{ severity: 'material', kind: 'layout', detail: 'Correct the rendered finding.', repair_owner: 'renderer', affected_paths: [template.candidate.notes[0].path], repair_scope: { status: 'located', section_ids: ['findings'], knowledge_ids: [], visual_ids: [], editor_fields: [] } }] };
  assert.equal((await accept(await nextReadingAction(session), 'review', review)).status, 'revision_required');
  assert.equal((await nextReadingAction(session)).kind, 'renderer-repair');
  await recordReadingEvent(session, { kind: 'renderer-repair' });
  await assert.rejects(() => nextReadingAction(session), /RENDER_REPAIR_UNAVAILABLE/);
  const existingTargets = template.candidate.notes.map(note => ({ path: note.path, bytes: Buffer.from(note.content.replace(note.language === 'en' ? '## Personal Notes' : '## 个人笔记', 'Renderer correction.\n\n' + (note.language === 'en' ? '## Personal Notes' : '## 个人笔记'))), managedHash: note.managedHash }));
  await recordReadingEvent(session, { kind: 'renderer-repair', renderOptions: { targetRegistry: template.candidate.targetRegistry, existingTargets } });
  const localReview = await nextReadingAction(session);
  assert.equal(localReview.stage, 'reading');
  assert.equal((await accept(localReview, 'review-r2', template.review)).status, 'reading_complete');
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
  await mkdir(join(runRoot, 'native'), { recursive: true });
  const observe = action => ({ action_id: action.action_id, run_id: action.run_id, input_fingerprint: action.input_fingerprint, port: action.port, tool_call: { name: action.host_action, arguments: action.arguments }, raw_result_text: JSON.stringify({ agent_id: 'host-' + action.action_id }) });
  for (let i = 0; i < 6; i++) {
    const action = await nextReadingAction(session), observation = observe(action);
    await recordReadingEvent(session, { kind: 'host_observation', action_id: action.action_id, observation });
    await writeFile(join(runRoot, 'native', action.role + '.json'), JSON.stringify({ role: action.role, text: 'synthetic', ...(action.role === 'integration' ? { important_gaps: [gap] } : {}) }));
    await recordReadingEvent(session, { kind: 'result', action_id: action.action_id });
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
  await mkdir(join(runRoot, 'native'), { recursive: true });
  for (let i = 0; i < 6; i++) {
    const action = await nextReadingAction(session);
    const observation = { action_id: action.action_id, run_id: action.run_id, input_fingerprint: action.input_fingerprint, port: action.port, tool_call: { name: action.host_action, arguments: action.arguments }, raw_result_text: JSON.stringify({ agent_id: 'host-' + action.action_id }) };
    await recordReadingEvent(session, { kind: 'host_observation', action_id: action.action_id, observation });
    await writeFile(join(runRoot, 'native', action.role + '.json'), JSON.stringify({ role: action.role, text: 'synthetic', ...(action.role === 'integration' ? { important_gaps: [gap] } : {}) }));
    await recordReadingEvent(session, { kind: 'result', action_id: action.action_id });
  }
  const next = await nextReadingAction(session);
  if (total === 10) { assert.equal(next.action, 'reconcile'); assert.equal(next.code, 'READING_FIRST_CALL_BUDGET_EXHAUSTED'); }
  else { assert.equal(next.action, 'dispatch'); assert.match(next.arguments.prompt, /enrich-initial-evidence/); }
});

for (const scenario of [{ sourceLanguage: 'en' }, { sourceLanguage: 'zh-CN' }, { sourceLanguage: 'en', noRepairs: true }, { sourceLanguage: 'en', shortBudget: true }, { sourceLanguage: 'en', translationOnly: true }]) test(`late session repair ${JSON.stringify(scenario)}`, async t => {
  const { sourceLanguage, noRepairs, shortBudget, translationOnly } = scenario;
  const f = await configuredFixture(t), template = await reviewedReadingFirstFixture(t, { controlOptions: { presentationProfile: 'reading-editor-1.3' } });
  let session = await createReadingSession({ ...f.options, sourceLanguage, includeRepairs: !noRepairs, maxTotalCalls: shortBudget ? 14 : 15, enrichmentPolicy: { sources: [], allow_targeted_methods: true } });
  const runRoot = join(f.root, 'runs', 'run'); await mkdir(join(runRoot, 'native'), { recursive: true });
  const accept = async (action, path, value) => {
    assert.equal(action.action, 'dispatch');
    assert.match(action.arguments.prompt, new RegExp('native[\\\\/]' + path.replace('-', '\\-') + '\\.json'));
    const observation = { action_id: action.action_id, run_id: action.run_id, input_fingerprint: action.input_fingerprint, port: action.port, tool_call: { name: action.host_action, arguments: action.arguments }, raw_result_text: JSON.stringify({ agent_id: 'host-' + action.action_id }) };
    await recordReadingEvent(session, { kind: 'host_observation', action_id: action.action_id, observation });
    await writeFile(join(runRoot, 'native', path + '.json'), JSON.stringify(value));
    return recordReadingEvent(session, { kind: 'result', action_id: action.action_id, observation });
  };
  for (let i = 0; i < 6; i++) { const action = await nextReadingAction(session); await accept(action, action.role, { role: action.role, text: 'synthetic', ...(action.role === 'integration' ? { presentation: template.presentationCatalog } : {}) }); }
  const targetLanguage = sourceLanguage === 'en' ? 'zh-CN' : 'en';
  const viewFor = language => template.views.find(view => view.language === language);
  await accept(await nextReadingAction(session), sourceLanguage, viewFor(sourceLanguage));
  await accept(await nextReadingAction(session), targetLanguage, viewFor(targetLanguage));
  await accept(await nextReadingAction(session), 'presentation', template.editor);
  const source = f.options.scientificInput.sources[0];
  await recordReadingEvent(session, { kind: 'render-assets', resources: [{ path: template.presentationCatalog.source_pdf, source_path: source.path, sha256: source.sha256, byte_length: source.byte_length }, template.resources[1]], renderOptions: {} });
  const gap = { id: 'late', question: 'What allocation was used?', impact: 'Changes interpretation', severity: 'material', owner_role: 'evidence', source_kind: 'original_page', source_ids: [], target_sections: ['Study'] };
  const issue = { severity: 'material', kind: 'scientific-gap', detail: 'Allocation unclear', repair_owner: 'science', affected_languages: [targetLanguage], scientific_gap: gap, repair_scope: { status: 'located', section_ids: [template.views[1].sections[0].id], knowledge_ids: [], visual_ids: [], editor_fields: [] } };
  if (translationOnly) { issue.repair_owner = 'writer'; delete issue.scientific_gap; }
  const first = await accept(await nextReadingAction(session), 'review', { ...template.review, issues: [issue] });
  if (noRepairs || shortBudget) {
    assert.equal(first.status, 'completed_with_limits');
    session = await resumeReadingSession({ runRoot });
    await recordReadingEvent(session, { kind: 'runtime-evidence', hostProfile: f.profile, evidence: f.evidence });
    assert.equal((await nextReadingAction(session)).status, 'completed_with_limits');
    return;
  }
  assert.equal(first.status, 'revision_required');
  const answer = { gap_id: gap.id, classification: 'paper_fact', explanation: 'The source reports random allocation.', consequence: 'It supports the design account.', status: 'recovered', target_sections: ['Study'], source_ids: ['paper'] };
  if (!translationOnly) await accept(await nextReadingAction(session), 'enrich-late-evidence', { run_id: 'run', role: 'evidence', resolutions: [answer] });
  const en = structuredClone(template.views[0]), zh = structuredClone(template.views[1]);
  if (!translationOnly) {
    for (const view of [en, zh]) view.enrichment_consumption = [{ gap_id: 'late', section_heading: view.sections[0].heading }];
    await accept(await nextReadingAction(session), sourceLanguage + '-r2', sourceLanguage === 'en' ? en : zh);
  }
  await accept(await nextReadingAction(session), targetLanguage + '-r2', targetLanguage === 'en' ? en : zh);
  await accept(await nextReadingAction(session), 'presentation-r2', { ...template.editor, views_fingerprint: readingFirstViewsFingerprint([en, zh]) });
  await accept(await nextReadingAction(session), 'review-r2', template.review);
  assert.equal((await nextReadingAction(session)).status, 'reading_complete');
});

test('empty enrichment policy preserves exact requests and instructions without gaps', async t => {
  const f = await configuredFixture(t), template = await reviewedReadingFirstFixture(t, { controlOptions: { presentationProfile: 'reading-editor-1.3' } });
  const runRoot = join(f.root, 'runs', 'run');
  const run = async withPolicy => {
    const session = await createReadingSession({ ...f.options, ...(withPolicy ? { enrichmentPolicy: { sources: [], allow_targeted_methods: true } } : {}) });
    await mkdir(join(runRoot, 'native'), { recursive: true });
    const accept = async (action, path, value) => {
      const observation = { action_id: action.action_id, run_id: action.run_id, input_fingerprint: action.input_fingerprint, port: action.port, tool_call: { name: action.host_action, arguments: action.arguments }, raw_result_text: JSON.stringify({ agent_id: 'host-' + action.action_id }) };
      await recordReadingEvent(session, { kind: 'host_observation', action_id: action.action_id, observation });
      await writeFile(join(runRoot, 'native', path + '.json'), JSON.stringify(value));
      await recordReadingEvent(session, { kind: 'result', action_id: action.action_id, observation });
    };
    for (let i = 0; i < 6; i++) { const action = await nextReadingAction(session); await accept(action, action.role, { role: action.role, text: 'synthetic', ...(action.role === 'integration' ? { presentation: template.presentationCatalog } : {}) }); }
    const captured = [];
    for (const [path, value] of [['en', template.views[0]], ['zh-CN', template.views[1]], ['presentation', template.editor], ['review', template.review]]) {
      if (path === 'review') { const source = f.options.scientificInput.sources[0]; await recordReadingEvent(session, { kind: 'render-assets', resources: [{ path: template.presentationCatalog.source_pdf, source_path: source.path, sha256: source.sha256, byte_length: source.byte_length }, template.resources[1]], renderOptions: {} }); }
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
    }
    return captured;
  };
  const baseline = await run(false);
  await rm(join(f.root, 'runs'), { recursive: true, force: true });
  await rm(join(f.root, 'candidates'), { recursive: true, force: true });
  const withPolicy = await run(true);
  assert.deepEqual(withPolicy, baseline);
});
