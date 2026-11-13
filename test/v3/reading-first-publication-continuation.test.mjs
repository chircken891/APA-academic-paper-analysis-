import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { commitOwnedArtifact } from '../../scripts/v3/owned-artifact-store.mjs';
import { readingFirstViewsFingerprint } from '../../scripts/v3/reading-first-editor.mjs';
import * as runtime from '../../scripts/v3/reading-first-runtime.mjs';
import { reviewedReadingFirstFixture } from './helpers/reading-first-publication-source-fixtures.mjs';

for (const scenario of ['unused-role', 'same-gap', 'new-gap']) test('explicit continuation adds science and a local review after the original exhausted second review: ' + scenario, async t => {
  const root = await mkdtemp(join(tmpdir(), 'apa-publication-continuation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const key = 'enrich-late-evidence';
  const repeatedRole = scenario !== 'unused-role', originalLimit = repeatedRole ? 9 : 7;
  const fixture = await reviewedReadingFirstFixture(t, { currentRegistryRoot: root, completeReview: false, instructionFiles: true, controlPaths: ['final-checkpoint.json'],
    createRunControl: input => runtime.createReadingFirstRunControl({ ...input, maxTotalCalls: originalLimit, maxCalls: repeatedRole ? 8 : 7,
      writingMode: 'source-translation', enrichmentPolicy: { sources: [], allow_targeted_methods: true },
      enrichmentSessionProfile: 'reading-session-enrichment-1.0',
      taskBindings: Object.assign(input.taskBindings, { [key]: {
        task_id: key, task_name: 'enrich_late_evidence', owner_actor_id: key, role: 'evidence', artifact_id: key,
        artifact_path: 'accepted/' + key + '.json', native_path: 'native/' + key + '.json',
        instruction_path: 'instructions/' + key + '.txt', source_root: 'sources/' + key, revision: '1',
      } }) }) });
  const { controller, complete, views, editor, review, reviewRequest, renderOptions, runId, artifactRoot, broker } = fixture;
  const render = () => runtime.renderReadingFirstNotes({ controller, ...renderOptions });
  const localReview = () => runtime.createReadingFirstReviewRequest({ controller, presentation: render() });
  const scope = { status: 'located', section_ids: ['findings'], knowledge_ids: [], visual_ids: [], editor_fields: [] };
  const issue = { severity: 'material', kind: 'science-comparison', repair_owner: 'writer',
    affected_languages: ['zh-CN'], detail: 'Clarify the comparator group.', repair_scope: scope };
  const gap = { id: 'comparator', severity: 'material', question: 'Which comparison identifies the incremental effect?',
    impact: 'Changes which conclusion is supported.', owner_role: 'evidence', source_kind: 'original_page',
    source_ids: ['paper'], target_sections: [views[0].sections[0].heading] };
  const initialGap = scenario === 'same-gap' ? gap : { ...gap, id: 'baseline-comparator', question: 'What baseline group was measured?' };
  const scienceIssue = scientific_gap => ({ ...issue, kind: 'scientific-gap', repair_owner: 'science', scientific_gap });
  const acceptEvidence = async (finding, taskId) => {
    const [evidence] = runtime.createReadingFirstEnrichmentRequests({ controller });
    assert.equal(evidence.task.task_id, taskId);
    await complete(evidence, { run_id: runId, role: 'evidence', resolutions: [{ gap_id: finding.id,
      classification: 'paper_fact', status: 'recovered', source_ids: ['paper'], target_sections: finding.target_sections,
      explanation: 'The direct comparison controls the treatment baseline.', consequence: 'Only the direct comparison identifies the added effect.' }] });
  };
  const revise = async findings => {
    const revised = views.map(view => ({ ...view, enrichment_consumption: findings.map(finding => ({
      gap_id: finding.id, section_heading: view.sections[0].heading,
    })) }));
    for (const view of revised) {
      const [request] = runtime.createReadingFirstRevisionRequests({ controller });
      assert.equal(request.language, view.language);
      await complete(request, view);
    }
    await complete(runtime.createReadingFirstPresentationRequest({ controller }), { ...editor, views_fingerprint: readingFirstViewsFingerprint(revised) });
  };
  await complete(reviewRequest, { ...review, issues: [repeatedRole ? scienceIssue(initialGap) : issue] });
  if (repeatedRole) {
    await acceptEvidence(initialGap, key);
    await revise([initialGap]);
  } else {
    const [translation] = runtime.createReadingFirstRevisionRequests({ controller });
    assert.equal(translation.task.task_id, 'zh-CN-r2');
    await complete(translation, views[1]);
    await complete(runtime.createReadingFirstPresentationRequest({ controller }), editor);
  }

  const r2 = await complete(localReview(), { ...review, issues: [scienceIssue(gap)] });
  assert.equal(r2.status, 'completed_with_limits');
  assert.equal(runtime.getReadingFirstState(controller).calls_used, originalLimit);
  await assert.rejects(runtime.captureReadingFirstPublicationSource({ controller }), /READING_FIRST_PUBLICATION_NOT_READY/);
  const checkpointReceipt = await commitOwnedArtifact({ artifactRoot, dispatchContext: broker.dispatchContext,
    capability: broker.issueCapability({ runId, actorId: 'controller', role: 'control', artifactPath: 'checkpoint.json', revision: '1' }),
    artifact: { artifact_id: 'checkpoint', content: JSON.stringify(runtime.snapshotReadingFirstRuntime(controller)) }, expectedRevision: '1' });
  const oldReview = await readFile(join(artifactRoot, r2.receipt.path));
  const inspection = await runtime.inspectReadingFirstContinuation({ controller, checkpointReceipt });
  assert.equal(inspection.can_continue, true, inspection.reason);
  const nextKey = repeatedRole ? key + '-r3' : key;
  assert.equal(inspection.remaining_task_keys[0], nextKey);
  assert.equal(inspection.required_additional_calls, 5);
  assert.equal(inspection.max_additional_review_rounds, 1);
  await runtime.authorizeReadingFirstContinuation({ controller, checkpointReceipt, authorization: {
    authorization_id: 'continue-r2-science', reason: 'Resolve the comparison reported in the local review.',
    checkpoint_fingerprint: inspection.checkpoint_fingerprint, issue_ids: inspection.issue_ids,
    max_additional_calls: inspection.required_additional_calls, max_additional_review_rounds: 1,
  } });
  await acceptEvidence(gap, nextKey);
  await revise(scenario === 'new-gap' ? [initialGap, gap] : [gap]);
  const candidate = render();
  await complete(runtime.createReadingFirstReviewRequest({ controller, presentation: candidate }), review);
  assert.equal(runtime.getReadingFirstState(controller).status, 'reading_complete');
  assert.equal(runtime.getReadingFirstState(controller).review_rounds, 3);
  const source = await runtime.captureReadingFirstPublicationSource({ controller, presentation: candidate });
  const { recipe } = await runtime.inspectReadingFirstPublicationSource(source);
  assert.ok(await runtime.restoreReadingFirstPublicationSource(recipe));
  const finalCheckpoint = await commitOwnedArtifact({ artifactRoot, dispatchContext: broker.dispatchContext,
    capability: broker.issueCapability({ runId, actorId: 'controller', role: 'control', artifactPath: 'final-checkpoint.json', revision: '1' }),
    artifact: { artifact_id: 'continuation-final-checkpoint', content: JSON.stringify(runtime.snapshotReadingFirstRuntime(controller)) }, expectedRevision: '1' });
  const restored = await runtime.restoreReadingFirstRuntime({ handoff: fixture.handoff, runControl: fixture.runControl, checkpointReceipt: finalCheckpoint });
  assert.equal(restored.ok, true, JSON.stringify(restored.errors));
  assert.deepEqual(await readFile(join(artifactRoot, r2.receipt.path)), oldReview);
});
