import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { queryLibrary } from '../../scripts/v3/library-query.mjs';
import { readRegisteredCommit } from '../../scripts/v3/phase22-active-version.mjs';
import { applyBilingualPublication } from '../../scripts/v3/phase22-publication.mjs';
import { exportReadingFirstPreview } from '../../scripts/v3/reading-first-preview.mjs';
import { captureReadingFirstPublicationSource } from '../../scripts/v3/reading-first-runtime.mjs';
import { buildMapRefreshReview } from '../../scripts/v3/research-map-refresh.mjs';
import { isResearchMapStepEdge } from '../../scripts/v3/research-map-canvas.mjs';
import { applyReadingFirstFixture, readingFirstPublicationFixture } from './helpers/reading-first-publication-fixtures.mjs';
import { reviewedReadingFirstFixture } from './helpers/reading-first-publication-source-fixtures.mjs';

test('2.3 preserves method evidence from the Writer request through registered presentation', async t => {
  const legacy = await readingFirstPublicationFixture(t);
  assert.equal((await applyBilingualPublication(applyReadingFirstFixture(legacy))).status, 'committed');
  const current = await readingFirstPublicationFixture(t, {
    methodsFirst: true,
    generation: 'methods-first-generation',
    vaultRoot: legacy.vaultRoot, currentRegistryRoot: legacy.vaultRoot,
    runId: 'run_' + 'b'.repeat(32), paperId: 'pap_' + 'b'.repeat(32),
    title: { en: 'Fixed threshold study', 'zh-CN': '固定阈值研究' },
  });
  const writerMessage = current.created.requests[0].emittedStep.arguments.message;
  const writerInput = JSON.parse(writerMessage.split('\n\n').at(-1));
  const [integration] = writerInput.handoff.science;
  assert.equal(writerInput.handoff.science.length, 1);
  assert.equal(integration.receipt.role, 'integration');
  const [intermediate] = integration.content.method_steps;
  assert.equal(intermediate.step_id, 'select-threshold');
  assert.match(intermediate.operation, /median in each fold/);
  assert.equal(intermediate.sources[0].locator.page, 1);
  assert.ok(!writerInput.handoff.presentation.map.relations.some(row => row.step_id === intermediate.step_id));
  assert.ok(writerInput.handoff.presentation.map.step_links.some(row => row.from_step_id === intermediate.step_id));
  assert.equal(current.binding.presentation_profile, 'reading-editor-1.5');
  assert.equal(current.binding.configured_setup.expanded_method_index, true);
  assert.equal(current.binding.configured_setup.staged_research_map, true);
  assert.equal(legacy.binding.configured_setup?.staged_research_map, undefined);
  const englishStageMap = JSON.parse(current.candidate.generated_assets.find(asset => asset.language === 'en').content);
  assert.ok(englishStageMap.nodes.some(node => node.type === 'group' && node.label.includes('Validation folds')));
  assert.ok(englishStageMap.nodes.some(node => node.text?.includes('Carry the fixed threshold')));
  const chineseStageMap = JSON.parse(current.candidate.generated_assets.find(asset => asset.language === 'zh-CN').content);
  assert.ok(chineseStageMap.nodes.some(node => node.text?.includes('将固定阈值带入留出队列')));

  const preview = await exportReadingFirstPreview({
    outputRoot: join(current.root, 'methods-first-preview'), identity: current.input.identity,
    views: current.views, presentation: current.presentationCatalog, readingEditor: current.editor,
    instructionProfile: 'configured-reading-2.3', stagedResearchMap: true, resources: current.resources, ...current.renderOptions,
    historicalKnowledge: { vaultRoot: current.vaultRoot },
  });
  assert.equal(preview.validation.status, 'passed');
  assert.equal(preview.manifest.review.native_obsidian, 'not_run');
  for (const note of preview.notes) {
    const en = note.language === 'en';
    const contents = en ? /\[3\.1 Methods and concepts at a glance\]/ : /\[3\.1 方法与概念索引\]/;
    const body = en ? /averaged the fold thresholds of 4 and 8 to obtain a fixed threshold of 6/ : /两折得到的阈值 4 和 8 取平均，得到固定阈值 6/;
    const index = en ? '### 3.1 Methods and concepts at a glance' : '### 3.1 方法与概念索引';
    assert.match(note.content, contents);
    assert.match(note.content, body);
    assert.ok(note.content.indexOf(index) >= 0 && note.content.indexOf(index) < note.content.search(body));
    assert.match(note.content, en ? /\[!info\] 1\. Fold-based threshold/ : /\[!info\] 1\. 逐折定阈值/);
    assert.match(note.content, /\.pdf#page=1/);
    const overview = en ? 'fixed a decision rule on validation data' : '用验证数据确定固定的判定规则';
    const mapHeading = en ? '### 2.1 Research map' : '### 2.1 研究导图';
    assert.ok(note.content.indexOf(mapHeading) > note.content.indexOf(overview));
  }
  assert.equal(current.plan.evidence_mode, 'synthetic');
  assert.equal((await applyBilingualPublication(applyReadingFirstFixture(current))).status, 'committed');
  const snapshot = await readRegisteredCommit({ vaultRoot: current.vaultRoot });
  assert.equal(snapshot.ok, true, JSON.stringify(snapshot.errors));
  assert.deepEqual(snapshot.generation.papers.map(paper => paper.profile), ['reading-first-obsidian-1.0', 'reading-first-obsidian-1.0']);
  const query = await queryLibrary({ vaultRoot: current.vaultRoot, query: 'averaged the fold thresholds' });
  assert.ok(query.results.find(row => row.paper_id === current.paperId)?.hits.some(hit => hit.anchor === '3.2 Select the threshold'));

  const sectionTitles = fixture => Object.fromEntries(fixture.views.map(view => {
    const note = fixture.candidate.notes.find(note => note.language === view.language);
    const headings = [...note.content.matchAll(/^#{2,3} (\d+\.(?:\d+)? .+)$/gm)].map(match => match[1]);
    return [view.language, Object.fromEntries(view.sections.map(section => [section.id, headings.find(heading => fixture === current && section.id === 'design'
      ? heading.startsWith('2. ') : heading.endsWith(' ' + section.heading))]))];
  }));
  const map = structuredClone(current.presentationCatalog.map);
  map.step_links[0].label = { en: 'Transfer threshold of 6', 'zh-CN': '传入阈值 6' };
  const legacyArgument = structuredClone(legacy.editor.argument);
  legacyArgument.question.text.en = 'What was measured in the original design?';
  const refresh = await buildMapRefreshReview({ vaultRoot: current.vaultRoot, runId: 'methods-first-refresh',
    generation: 'methods-first-refresh', papers: [
      { paperId: current.paperId, map, argument: current.editor.argument,
        primaryFindingIds: current.editor.primary_finding_ids, sectionTitles: sectionTitles(current) },
      { paperId: legacy.paperId, map: legacy.presentationCatalog.map, argument: legacyArgument,
        primaryFindingIds: legacy.editor.primary_finding_ids, sectionTitles: sectionTitles(legacy) },
    ] });
  const englishCanvas = fixture => JSON.parse(refresh.outputInventory.find(row => row.path === `Figures/${fixture.runId}/research-map.en.canvas`).bytes);
  const canvas = englishCanvas(current);
  assert.ok(canvas.edges.some(edge => isResearchMapStepEdge(edge) && edge.label === 'Transfer threshold of 6'));
  const legacyCanvas = englishCanvas(legacy);
  assert.ok(legacyCanvas.nodes.some(node => node.text?.includes(legacyArgument.question.text.en)));
  assert.ok(!legacyCanvas.edges.some(isResearchMapStepEdge));
  const legacyEnglish = await readFile(join(current.vaultRoot, legacy.candidate.notes[0].path), 'utf8');
  assert.match(legacyEnglish, /3\.1 Methods and concepts at a glance/);
  assert.ok(!refresh.outputInventory.some(row => row.path === legacy.candidate.notes[0].path));
});

test('2.3 prevents publication when the Verifier cannot substantiate the method application', async t => {
  const cases = ['missing', 'invalid-source', 'writer-omission', 'unavailable'];
  for (const scenario of cases) await t.test(scenario, async t => {
    const fixture = await reviewedReadingFirstFixture(t, { methodsFirst: true, completeReview: false,
      controlOptions: { maxCalls: 8 },
      omitMethodProcedure: ['writer-omission', 'unavailable'].includes(scenario),
      ...(scenario === 'unavailable' ? { sourceText: 'Synthetic p. 1. We derived the threshold using validation data. The fold inputs and the cutoff computation are in an unavailable appendix.' } : {}) });
    const review = structuredClone(fixture.review), method = review.key_nodes.at(-1);
    if (scenario === 'missing') review.key_nodes.pop();
    if (scenario === 'invalid-source') method.source_refs[0].source_id = 'other';
    if (scenario === 'unavailable') {
      method.status = 'unavailable';
      method.finding = 'The inspected page says validation data supplied the threshold and points to an unavailable appendix for the fold inputs and cutoff computation. The rule used to set the fixed threshold cannot be checked.';
    }
    if (scenario === 'writer-omission') {
      method.status = 'material_issue';
      method.finding = 'The draft leaves out the two fold thresholds and how the fixed cut point was set.';
      review.overall.complete = false;
      review.issues.push({ severity: 'material', kind: 'method_application', repair_owner: 'writer',
        detail: method.finding, affected_languages: ['en', 'zh-CN'], repair_scope: { status: 'located',
          section_ids: ['methods'], visual_ids: [], knowledge_ids: [], editor_fields: [] } });
    }
    const accept = () => fixture.complete(fixture.reviewRequest, review);
    if (scenario === 'invalid-source') await assert.rejects(accept, { code: 'READING_FIRST_METHOD_REVIEW_INVALID' });
    else assert.equal((await accept()).status, scenario === 'writer-omission' ? 'revision_required' : 'completed_with_limits');
    await assert.rejects(captureReadingFirstPublicationSource({ controller: fixture.controller, presentation: fixture.candidate }),
      { code: 'READING_FIRST_PUBLICATION_NOT_READY' });
  });
});

test('2.3 handles a commentary with no method application and a located rationale', async t => {
  for (const withRationale of [true, false]) await t.test(withRationale ? 'reasoned' : 'unexplained', async t => {
    const fixture = await reviewedReadingFirstFixture(t, { methodsFirst: true, commentary: true, completeReview: false,
      sourceText: 'Synthetic editorial commentary, p. 1. A named algorithm is a general procedure. Its use in a study depends on how investigators operationalize it. This distinction helps interpret published claims.' });
    assert.deepEqual(fixture.handoff.science.find(row => row.receipt.role === 'integration').content.method_steps, []);
    for (const note of fixture.candidate.notes) assert.doesNotMatch(note.content, /Methods and concepts at a glance|方法与概念索引|Method index|方法索引/);
    const review = structuredClone(fixture.review);
    if (!withRationale) {
      delete review.key_nodes.at(-1).rationale;
      await assert.rejects(fixture.complete(fixture.reviewRequest, review), { code: 'READING_FIRST_METHOD_REVIEW_INVALID' });
      return;
    }
    assert.equal((await fixture.complete(fixture.reviewRequest, review)).status, 'reading_complete');
    await assert.doesNotReject(captureReadingFirstPublicationSource({ controller: fixture.controller, presentation: fixture.candidate }));
  });
});

test('2.3 Translation rejects moving a visual to a different paragraph of the same section', async t => {
  await assert.rejects(reviewedReadingFirstFixture(t, { methodsFirst: true, transformTranslation(view) {
    const shifted = structuredClone(view);
    shifted.placements.visuals[0].after_paragraph = 1;
    return shifted;
  } }), { code: 'READING_FIRST_VIEW_LAYOUT_INVALID' });
});

test('2.3 Writer-only flow passes review with numbered method prose and no Editor', async t => {
  const current = await readingFirstPublicationFixture(t, { methodsFirst: true, controlOptions: { presentationMode: 'writer' } });
  const note = current.candidate.notes.find(note => note.language === 'en');
  assert.match(note.content, /### 3\.1 Select the threshold/);
  const support = current.candidate.supportNotes.find(row => row.id === 'method');
  for (const language of ['en', 'zh-CN']) {
    const paper = current.candidate.notes.find(row => row.language === language);
    assert.ok(support.content.includes(paper.path.split('/').at(-1) + '#^rf-methods'));
    assert.match(paper.content, /\^rf-methods\b/);
  }
  assert.match(note.content, /### 3\.2 Test in an independent cohort/);
  assert.doesNotMatch(note.content, /Methods and concepts at a glance|Method index/);
  assert.doesNotMatch(note.content, /\[!\w+\]-|<details>/);
  assert.match(note.content, /select_threshold -->\|"Fixed threshold of 6"\| external_test/);
  assert.equal((await applyBilingualPublication(applyReadingFirstFixture(current))).status, 'committed');
});
