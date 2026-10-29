import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createTopicFixture, publishTopicFixture } from './helpers/topic-fixtures.mjs';
import * as topics from '../../scripts/v3/topic-library.mjs';
import { prepareTopicPublication } from '../../scripts/v3/topic-publication.mjs';
import { applyBilingualPublication, registerBilingualPublication, loadBilingualPublication } from '../../scripts/v3/phase22-publication.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { readingFirstPublicationAuthority, readingFirstPublicationFixture, applyReadingFirstFixture } from './helpers/reading-first-publication-fixtures.mjs';
import { queryLibrary } from '../../scripts/v3/library-query.mjs';
import { readCommittedGeneration, readCommittedReadingFirstPresentations } from '../../scripts/v3/phase22-active-version.mjs';
import { parseQueryArguments } from '../../scripts/apa-query.mjs';
import { fingerprintV3Json as hash } from '../../scripts/v3/semantic-package-validator.mjs';

const mainSession = { model: 'synthetic-main', reasoning_effort: 'high' };
const hostCapabilities = { currentSession: true, nativeDelegation: true };
test('topic update CLI accepts explicit request candidate event cancellation and read-only hints commands', () => {
  for (const command of ['topic-update-request', 'topic-update-candidate', 'source-change', 'topic-cancel']) {
    assert.equal(parseQueryArguments([command, '--input', '-']).input, '-');
  }
  assert.equal(parseQueryArguments(['topic-hints', '--generation-id', 'generation-1']).generationId, 'generation-1');
});
test('inherited event resolutions from revision two remain conditional on revision three body and dependencies', () => {
  const dependency = { paper_id: 'paper', analysis_revision: 'revision', source_id: 'source', source_sha256: 'sha256:' + 'a'.repeat(64),
    adopted_generation_id: 'source-generation', source_version: null, locators: [], adopted_for: ['claim'] };
  const event = { event_id: 'event-correction', target: dependency };
  const resolution = { event_id: event.event_id, disposition: 'corrected', base_revision: 1, input_fingerprint: 'sha256:' + '1'.repeat(64),
    statement_locator: 'The conclusion remains corrected.', replacement_dependency: null };
  const previous = { revision: 2, dependencies: [dependency], resolved_event_ids: [event.event_id], event_resolutions: [resolution] };
  const next = { revision: 3, previous_revision: 2, dependencies: [dependency], resolved_event_ids: [event.event_id], event_resolutions: [resolution] };
  const inputs = { topic: next, previous, events: [event], inputFingerprint: 'sha256:' + '3'.repeat(64) };
  assert.throws(() => topics.validateTopicEventResolutions({ ...inputs, answer: 'A new account omits all handling.' }), /P24_EVENT_RESOLUTION_INVALID/);
  assert.doesNotThrow(() => topics.validateTopicEventResolutions({ ...inputs, answer: resolution.statement_locator + ' Added study limitations.' }));
  const removed = { ...resolution, disposition: 'removed', statement_locator: 'The original source was removed.' };
  assert.throws(() => topics.validateTopicEventResolutions({ ...inputs, previous: { ...previous, dependencies: [], event_resolutions: [removed] },
    topic: { ...next, event_resolutions: [removed] }, answer: removed.statement_locator }), /P24_EVENT_RESOLUTION_INVALID/);
  assert.doesNotThrow(() => topics.validateTopicEventResolutions({ ...inputs, previous: { ...previous, dependencies: [], event_resolutions: [removed] },
    topic: { ...next, dependencies: [], event_resolutions: [removed] }, answer: removed.statement_locator }));
});
async function committed(t) {
  const f = await createTopicFixture(t);
  const snapshot = await publishTopicFixture(f);
  return { ...f, snapshot, topic: snapshot.generation.topics[0] };
}

test('topic update consumes presentation preferences while retaining the saved topic language', async t => {
  const f = await committed(t);
  await writeFile(join(f.vaultRoot, 'config/apa.local.json'), JSON.stringify({ schema_version: 'apa-local-config-1.0',
    paths: { candidates: 'candidates' }, query: { answer_language: 'zh-CN', detail: 'detailed', audience: 'beginner' } }));
  const inputs = { repoRoot: f.vaultRoot, topicId: f.topic.topic_id, baseRevision: f.topic.revision,
    generationId: f.snapshot.generation_id, selectedSources: [f.topic.dependencies[0]], question: 'Update this topic', mainSession, hostCapabilities };
  const configured = await topics.prepareTopicUpdate(inputs);
  assert.equal(f.topic.language, 'en');
  assert.deepEqual(configured.task.evidence.preferences, { answer_language: 'en', detail: 'detailed', audience: 'beginner' });
  const overridden = await topics.prepareTopicUpdate({ ...inputs, preferences: { answer_language: 'zh-CN', detail: 'concise', audience: 'researcher' } });
  assert.deepEqual(overridden.task.evidence.preferences, { answer_language: 'en', detail: 'concise', audience: 'researcher' });
  assert.notEqual(configured.input_hash, overridden.input_hash);
  assert.match(overridden.task.prompt, /Keep the saved topic language/);
  await assert.rejects(topics.prepareTopicUpdate({ ...inputs, preferences: { audience: 'anyone' } }), /APA_QUERY_PREFERENCES_INVALID/);
});
test('related new paper returns deterministic hints while unrelated source leaves topic current', async t => {
  const f = await createTopicFixture(t, { topicTitle: 'Photon uptake', queryTerms: ['photon'] });
  const original = await publishTopicFixture(f), topic = original.generation.topics[0], shared = original.generation.shared_nodes[0];
  let hints;
  for (const [index, related] of [true, false].entries()) {
    const p = await readingFirstPublicationFixture(t, { vaultRoot: f.vaultRoot, generation: 'new-paper-' + index,
      runId: 'run_' + (index ? 'd' : 'c').repeat(32), paperId: 'pap_' + (index ? 'd' : 'c').repeat(32),
      title: { en: related ? 'Photon uptake experiment' : 'Botanical taxonomy', 'zh-CN': related ? '光子实验' : '植物分类' },
      sourceText: related ? 'Registered photon evidence.' : 'Registered botanical evidence.',
      findingText: related ? 'Photon uptake is conditional on illumination.' : 'Botanical taxonomy separates plant families.',
      knowledgeRegistry: [{ id: 'method', canonical_key: 'synthetic-method', path: shared.path, content: await readFile(join(f.vaultRoot, shared.path), 'utf8') }] });
    const applied = await applyBilingualPublication(applyReadingFirstFixture(p));
    assert.equal(applied.status, 'committed');
    hints = applied.relevance_hints;
    assert.equal(hints.some(h => h.topic_id === topic.topic_id), related, JSON.stringify(hints));
    if (related) assert.ok(hints[0].matched_terms.includes('photon'));
    const current = await readCommittedGeneration({ vaultRoot: f.vaultRoot });
    assert.equal(topics.topicReviewState(current.generation.topics[0], current.generation.source_events).review_status, 'current');
  }
});
test('selected delta prepares one bounded update and deterministic differences preserve topic identity and human bytes', async t => {
  const f = await committed(t);
  const topicPath = join(f.vaultRoot, f.topic.path);
  await writeFile(topicPath, (await readFile(topicPath)) + '\nprivate-only-human-note\n');
  const hints = await topics.getTopicUpdateHints({ vaultRoot: f.vaultRoot, generationId: f.snapshot.generation_id,
    changedPaperIds: [f.papers[1].paperId] });
  assert.equal(hints.ok, true);
  const dependency = { ...f.topic.dependencies[0] };
  const deltaPaper = readCommittedReadingFirstPresentations(f.snapshot).find(r => r.paper.paper_id === f.papers[1].paperId);
  const deltaSource = deltaPaper.presentation.citation.sources[0];
  const delta = { paper_id: deltaPaper.paper.paper_id, analysis_revision: deltaPaper.paper.analysis_revision, adopted_generation_id: f.snapshot.generation_id,
    source_id: deltaSource.source_id, source_sha256: deltaSource.sha256, source_version: deltaSource.source_version ?? null,
    locators: deltaSource.locators, adopted_for: ['new comparison in answer paragraph 1'] };
  const inputs = { repoRoot: f.vaultRoot, topicId: f.topic.topic_id, baseRevision: 1,
    generationId: f.snapshot.generation_id, selectedSources: [delta], question: 'Update the supported result', mainSession, hostCapabilities };
  await assert.rejects(topics.prepareTopicUpdate({ ...inputs, selectedSources: [] }), /P24_SELECTED_SOURCES_REQUIRED/);
  let calls = 0;
  const updated = await topics.executeTopicUpdate({ ...inputs, executeHost: async task => {
    calls++;
    assert.equal(task.model, mainSession.model);
    assert.equal(task.fork_turns, 'none');
    assert.equal(JSON.stringify(task).includes('private-only-human-note'), false);
    assert.equal(task.evidence.selected_sources.length, 1);
    return { answer: 'The updated supported result retains its study limitations.', adopted_sources: [dependency, delta],
      changes: { added: ['invented'], removed: [], retained: [] }, observable_identity: mainSession };
  } });
  assert.equal(calls, 1);
  assert.equal(updated.status, 'answered');
  assert.equal(updated.changes.body_changed, true);
  assert.equal(updated.changes.added.length, 1);
  assert.equal(updated.changes.retained.length, 1);
  await assert.rejects(topics.prepareTopicUpdate({ ...inputs, baseRevision: 2 }), /P24_TOPIC_BASE_CHANGED/);
  await assert.rejects(topics.prepareTopicUpdate({ ...inputs, generationId: 'old-generation' }), /P23_QUERY_GENERATION_CHANGED/);
  const mismatch = await topics.executeTopicUpdate({ ...inputs, executeHost: async () => ({ answer: 'Wrong host', adopted_sources: [dependency],
    changes: {}, observable_identity: { model: 'different', reasoning_effort: 'high' } }) });
  assert.equal(mismatch.status, 'identity_mismatch');
  assert.equal(mismatch.execution_record, undefined);
  let failures = 0;
  await assert.rejects(topics.executeTopicUpdate({ ...inputs, executeHost: async () => { failures++; throw new Error('host unavailable'); } }), /host unavailable/);
  assert.equal(failures, 1);
  const saved = await topics.prepareTopicSave({ repoRoot: f.vaultRoot, operationId: 'topic-update-1', saveIntent: 'update',
    topicId: f.topic.topic_id, baseRevision: 1, question: f.topic.question, language: f.topic.language, title: f.topic.title,
    answer: updated.answer, adoptedSources: updated.adopted_sources, queryTerms: f.topic.query_terms,
    expectedGenerationId: f.snapshot.generation_id, execution: updated.execution_record });
  assert.equal(saved.topic.topic_id, f.topic.topic_id);
  assert.equal(saved.topic.revision, 2);
  const prepared = await prepareTopicPublication({ vaultRoot: f.vaultRoot, candidate: saved.candidate });
  const authority = await readingFirstPublicationAuthority({ root: f.root, vaultRoot: f.vaultRoot, runId: 'topic-update-1' }, prepared.plan);
  await registerBilingualPublication({ vaultRoot: f.vaultRoot, run: 'topic-update-1', plan: prepared.plan, sourceInputs: prepared.sourceInputs, ...authority });
  assert.equal((await applyBilingualPublication({ vaultRoot: f.vaultRoot, run: 'topic-update-1', plan: prepared.plan, ...authority })).status, 'committed');
  assert.match(await readFile(topicPath, 'utf8'), /private-only-human-note/);
});

test('source events require transactions and exact dependencies remain readable with needs review', async t => {
  const f = await committed(t), before = await readFile(join(f.vaultRoot, f.topic.path));
  let generation = f.snapshot.generation_id;
  const target = f.topic.dependencies[0];
  const second = readCommittedReadingFirstPresentations(f.snapshot).find(r => r.paper.paper_id === f.papers[1].paperId);
  const source = second.presentation.citation.sources[0];
  for (const [index, kind] of ['correction', 'replacement', 'withdrawal'].entries()) {
    const event = { event_id: 'event-' + kind, kind, target: { paper_id: target.paper_id, analysis_revision: target.analysis_revision,
      source_id: target.source_id, source_sha256: target.source_sha256 }, target_generation_id: target.adopted_generation_id,
      reason: 'Explicit synthetic ' + kind, recorded_from: 'Synthetic fixture declaration', replacement: kind === 'replacement'
        ? { paper_id: second.paper.paper_id, analysis_revision: second.paper.analysis_revision, source_id: source.source_id,
          source_sha256: source.sha256, generation_id: generation } : null };
    const operationId = 'source-change-' + index;
    const prepared = await topics.prepareSourceChange({ repoRoot: f.vaultRoot, operationId, generationId: generation, event, changeIntent: 'source-change' });
    assert.equal(prepared.review.reviewManifest.previews.length, 0);
    assert.equal((await readCommittedGeneration({ vaultRoot: f.vaultRoot })).generation.source_events?.length ?? 0, index);
    const authority = await readingFirstPublicationAuthority({ root: f.root, vaultRoot: f.vaultRoot, runId: operationId }, prepared.plan);
    const registered = await registerBilingualPublication({ vaultRoot: f.vaultRoot, run: operationId, plan: prepared.plan, sourceInputs: prepared.sourceInputs, ...authority });
    const restored = await loadBilingualPublication({ vaultRoot: f.vaultRoot, run: operationId, trustAnchor: registered.trust_anchor });
    assert.equal(restored.review.reviewManifest.operation, 'source-change');
    assert.equal((await applyBilingualPublication({ vaultRoot: f.vaultRoot, run: operationId, plan: restored.plan, ...authority })).status, 'committed');
    const snapshot = await readCommittedGeneration({ vaultRoot: f.vaultRoot });
    generation = snapshot.generation_id;
    assert.equal(snapshot.generation.source_events.length, index + 1);
    assert.deepEqual(await readFile(join(f.vaultRoot, f.topic.path)), before);
    const found = await queryLibrary({ vaultRoot: f.vaultRoot, query: 'topiconlytoken' });
    assert.equal(found.results[0].review_status, 'needs_review');
    assert.equal(found.results[0].review_reasons.length, index + 1);
  }
  const state = topics.topicReviewState({ ...f.topic, dependencies: [{ ...target, source_sha256: 'sha256:' + '0'.repeat(64) }] },
    (await readCommittedGeneration({ vaultRoot: f.vaultRoot })).generation.source_events);
  assert.equal(state.review_status, 'current', 'same paper with different exact source hash is unaffected');
  const events = (await readCommittedGeneration({ vaultRoot: f.vaultRoot })).generation.source_events;
  assert.throws(() => topics.validateTopicEventResolutions({ topic: { dependencies: f.topic.dependencies,
    resolved_event_ids: ['event-correction'], event_resolutions: [] }, previous: f.topic, answer: 'Updated', events, inputFingerprint: 'sha256:' + '1'.repeat(64) }), /P24_EVENT_RESOLUTION_INVALID/);
  assert.throws(() => topics.validateTopicEventResolutions({ topic: { dependencies: f.topic.dependencies, resolved_event_ids: ['event-withdrawal'],
    event_resolutions: [{ event_id: 'event-withdrawal', disposition: 'removed', base_revision: 1, input_fingerprint: 'sha256:' + '1'.repeat(64), statement_locator: 'Removed', replacement_dependency: null }] },
    previous: f.topic, answer: 'Removed', events, inputFingerprint: 'sha256:' + '1'.repeat(64) }), /P24_EVENT_RESOLUTION_INVALID/);
  await assert.rejects(topics.prepareTopicSave({ repoRoot: f.vaultRoot, operationId: 'fake-resolution', saveIntent: 'update',
    topicId: f.topic.topic_id, baseRevision: 1, question: f.topic.question, language: 'en', title: f.topic.title,
    answer: 'Resolved without evidence', adoptedSources: f.topic.dependencies, queryTerms: f.topic.query_terms,
    expectedGenerationId: generation, resolvedEventIds: ['event-correction'], eventResolutions: [] }), /P24_UPDATE_EXECUTION_REQUIRED/);
  const corrected = await topics.executeTopicUpdate({ repoRoot: f.vaultRoot, topicId: f.topic.topic_id, baseRevision: 1,
    generationId: generation, selectedSources: f.topic.dependencies, question: 'Handle only the correction event', mainSession, hostCapabilities,
    executeHost: async task => ({ answer: 'The original conclusion requires correction under the recorded event.',
      adopted_sources: f.topic.dependencies, changes: {}, resolved_event_ids: ['event-correction'],
      event_resolutions: [{ event_id: 'event-correction', disposition: 'corrected', base_revision: 1,
        input_fingerprint: hash(task.evidence), statement_locator: 'requires correction under the recorded event', replacement_dependency: null }] }) });
  const saved = await topics.prepareTopicSave({ repoRoot: f.vaultRoot, operationId: 'corrected-revision', saveIntent: 'update', topicId: f.topic.topic_id,
    baseRevision: 1, question: f.topic.question, language: 'en', title: f.topic.title, queryTerms: f.topic.query_terms, answer: corrected.answer,
    adoptedSources: corrected.adopted_sources, expectedGenerationId: generation, execution: corrected.execution_record,
    resolvedEventIds: corrected.resolved_event_ids, eventResolutions: corrected.event_resolutions });
  const prepared = await authorize(f, saved.candidate);
  const restored = await loadBilingualPublication({ vaultRoot: f.vaultRoot, run: prepared.run, trustAnchor: prepared.registration.trust_anchor });
  assert.equal((await applyBilingualPublication({ vaultRoot: f.vaultRoot, run: prepared.run, plan: restored.plan, ...prepared.authority })).status, 'committed');
  const reviewed = (await queryLibrary({ vaultRoot: f.vaultRoot, query: 'requires correction' })).results.find(r => r.entity_type === 'topic');
  assert.equal(reviewed.revision, 2);
  assert.deepEqual(reviewed.review_reasons.map(r => r.event_id).sort(), ['event-replacement', 'event-withdrawal']);
});

async function updateCandidate(f, operationId) {
  const result = await topics.executeTopicUpdate({ repoRoot: f.vaultRoot, topicId: f.topic.topic_id, baseRevision: 1,
    generationId: f.snapshot.generation_id, selectedSources: f.topic.dependencies, question: 'Update the study result', mainSession, hostCapabilities,
    executeHost: async () => ({ answer: 'The revised result explains supported conditions and limits.', adopted_sources: f.topic.dependencies, changes: {} }) });
  const saved = await topics.prepareTopicSave({ repoRoot: f.vaultRoot, operationId, question: f.topic.question, language: 'en', title: f.topic.title,
    answer: result.answer, adoptedSources: result.adopted_sources, queryTerms: f.topic.query_terms, expectedGenerationId: f.snapshot.generation_id,
    saveIntent: 'update', topicId: f.topic.topic_id, baseRevision: 1, execution: result.execution_record });
  return saved.candidate;
}
async function authorize(f, candidate) {
  const prepared = await prepareTopicPublication({ vaultRoot: f.vaultRoot, candidate });
  const root = join(f.root, candidate.operation_id);
  await mkdir(root, { recursive: true });
  const authority = await readingFirstPublicationAuthority({ root, vaultRoot: f.vaultRoot, runId: candidate.operation_id }, prepared.plan);
  const registration = await registerBilingualPublication({ vaultRoot: f.vaultRoot, run: candidate.operation_id,
    plan: prepared.plan, sourceInputs: prepared.sourceInputs, ...authority });
  return { ...prepared, authority, registration, run: candidate.operation_id };
}
test('same base competing updates and human preimages preserve the complete prior topic history', async t => {
  const f = await committed(t), path = join(f.vaultRoot, f.topic.path), original = await readFile(path);
  const first = await updateCandidate(f, 'competing-one'), second = await updateCandidate(f, 'competing-two');
  const stale = await authorize(f, first);
  const human = Buffer.concat([original, Buffer.from('\nnew human bytes\n')]);
  await writeFile(path, human);
  await assert.rejects(applyBilingualPublication({ vaultRoot: f.vaultRoot, run: stale.run, plan: stale.plan, ...stale.authority }), /P22_PUBLICATION_PREIMAGE_CHANGED/);
  const refreshed = await authorize(f, first), competitor = await authorize(f, second);
  assert.equal((await applyBilingualPublication({ vaultRoot: f.vaultRoot, run: refreshed.run, plan: refreshed.plan, ...refreshed.authority })).status, 'committed');
  await assert.rejects(applyBilingualPublication({ vaultRoot: f.vaultRoot, run: competitor.run, plan: competitor.plan, ...competitor.authority }), /P22_PUBLICATION_PREIMAGE_CHANGED/);
  assert.match(await readFile(path, 'utf8'), /new human bytes/);
  const archived = join(f.vaultRoot, '.apa-v3/phase22/history', f.snapshot.generation_id, 'snapshot');
  assert.deepEqual(await readFile(join(archived, f.topic.path)), human);
  const old = await readCommittedGeneration({ vaultRoot: archived });
  assert.equal(old.ok, true, JSON.stringify(old.errors));
  assert.equal(old.generation.topics[0].revision, 1);
});
test('topic promotion interruption recovers the complete old generation in a fresh process', async t => {
  const f = await committed(t), candidate = await updateCandidate(f, 'interrupted-update'), prepared = await authorize(f, candidate);
  const before = await readFile(join(f.vaultRoot, f.topic.path));
  const url = new URL('../../scripts/v3/phase22-publication.mjs', import.meta.url).href;
  const code = `import {loadBilingualPublication,applyBilingualPublication} from ${JSON.stringify(url)};
    const [vaultRoot,run,anchor]=process.argv.slice(1),r=await loadBilingualPublication({vaultRoot,run,trustAnchor:JSON.parse(anchor),requireApproval:true});
    await applyBilingualPublication({vaultRoot,run,plan:r.plan,control:r.control,approvalRecord:r.authority.approval_record.path,maintenanceWindowRecord:r.authority.maintenance_window_record.path,
      expectedReviewSha256:r.plan.hashes.review_hash,expectedOutputSha256:r.plan.hashes.output_inventory_hash,
      onPersistentBoundary:async e=>{if(e.operation==='target.link'&&e.timing==='after'&&e.path===${JSON.stringify(f.topic.path)}){process.send({cut:true});await new Promise(()=>{});}}});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, f.vaultRoot, prepared.run, JSON.stringify(prepared.registration.trust_anchor)],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let cut = false, stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  child.on('message', event => { if (event.cut) { cut = true; child.kill('SIGKILL'); } });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 20000);
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  clearTimeout(watchdog);
  assert.equal(cut, true, stderr);
  assert.equal((await readCommittedGeneration({ vaultRoot: f.vaultRoot })).ok, false);
  const recovery = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {recoverBilingualPublication} from ${JSON.stringify(url)};console.log(JSON.stringify(await recoverBilingualPublication({vaultRoot:process.argv[1],run:process.argv[2],trustAnchor:JSON.parse(process.argv[3]),transactionId:process.argv[4]})));`,
    f.vaultRoot, prepared.run, JSON.stringify(prepared.registration.trust_anchor), prepared.registration.transaction_id], { encoding: 'utf8', windowsHide: true });
  assert.equal(recovery.status, 0, recovery.stderr);
  assert.equal(JSON.parse(recovery.stdout).status, 'rolled_back');
  assert.deepEqual(await readFile(join(f.vaultRoot, f.topic.path)), before);
  assert.equal((await readCommittedGeneration({ vaultRoot: f.vaultRoot })).generation.topics[0].revision, 1);
});

test('topic updates reject managed edits after the model reply and after candidate creation', async t => {
  const f = await committed(t), path = join(f.vaultRoot, f.topic.path);
  const result = await topics.executeTopicUpdate({ repoRoot: f.vaultRoot, topicId: f.topic.topic_id, baseRevision: 1,
    generationId: f.snapshot.generation_id, selectedSources: f.topic.dependencies, question: 'Update the study result', mainSession, hostCapabilities,
    executeHost: async () => ({ answer: 'The revised result explains conditions.', adopted_sources: f.topic.dependencies, changes: {} }) });
  const original = await readFile(path, 'utf8');
  const edited = original.replace('<!-- AUTO:END topic -->', 'HumanEditAfterUpdateNeedle\n<!-- AUTO:END topic -->');
  const inputs = { repoRoot: f.vaultRoot, operationId: 'changed-topic-update', question: f.topic.question, language: 'en', title: f.topic.title,
    answer: result.answer, adoptedSources: result.adopted_sources, queryTerms: f.topic.query_terms, expectedGenerationId: f.snapshot.generation_id,
    saveIntent: 'update', topicId: f.topic.topic_id, baseRevision: 1, execution: result.execution_record };
  await writeFile(path, edited);
  await assert.rejects(topics.prepareTopicSave(inputs), /P24_TOPIC_BASE_CHANGED/);
  assert.equal(await readFile(path, 'utf8'), edited);
  await writeFile(path, original);
  const candidate = await topics.prepareTopicSave(inputs);
  await writeFile(path, edited);
  await assert.rejects(prepareTopicPublication({ vaultRoot: f.vaultRoot, candidate: candidate.candidate }), /P24_TOPIC_BASE_CHANGED/);
  assert.equal(await readFile(path, 'utf8'), edited);
});
