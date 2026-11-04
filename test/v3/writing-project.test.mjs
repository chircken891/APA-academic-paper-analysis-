import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createTopicFixture, publishTopicFixture } from './helpers/topic-fixtures.mjs';
import { prepareWritingProjectSave, readWritingProject, exportWritingProjectReferences, executeWritingProjectUpdate, validateWritingProjectData, exportBibliographyRecords } from '../../scripts/v3/writing-project.mjs';
import { prepareTopicPublication } from '../../scripts/v3/topic-publication.mjs';
import { registerBilingualPublication } from '../../scripts/v3/phase22-publication.mjs';
import { readingFirstPublicationAuthority } from './helpers/reading-first-publication-fixtures.mjs';
import { getCurrentNote, readCurrentVaultContent } from '../../scripts/v3/current-vault-content.mjs';
import { buildGraphProposal } from '../../scripts/v3/phase22-graph.mjs';
import { prepareSynthesisMaterials } from '../../scripts/v3/library-synthesis.mjs';

test('writing projects publish with independent identity, indexed evidence and protected personal notes', async t => {
  const f = await createTopicFixture(t);
  const snapshot = await publishTopicFixture(f);
  const paper = snapshot.generation.papers[0], path = paper.paths.en;
  const bytes = await readFile(join(f.vaultRoot, path));
  const current = await readCurrentVaultContent({ vaultRoot: f.vaultRoot });
  const anchor = getCurrentNote(current, path).sections.find(row => row.anchor)?.anchor;
  const data = { evidence_records: [{ evidence_id: 'e1', citations: [{ paper_id: paper.paper_id, path, anchor,
    sha256: 'sha256:' + createHash('sha256').update(bytes).digest('hex') }], polarity: 'support', strength: 'observation',
    allowed_statement: 'Synthetic observation.', forbidden_statement: 'Causality.', relationship: 'direct', method: 'Initial method', data: 'Initial dataset', metrics: 'Initial metric', limitations: 'Initial limitation' }],
  ideas: [{ idea_id: 'idea1', evidence_ids: ['e1'], title: 'Initial idea', rationale: 'Initial rationale' }], discarded_ideas: [], sections: [{ section_id: 'intro', evidence_ids: ['e1'], outline: 'Observation', body: 'Synthetic observation.' }],
  citation_plan: [{ evidence_ids: ['e1'], section_id: 'intro' }] };
  const base = { repoRoot: f.vaultRoot, operationId: 'project-save-1', question: 'Study question', language: 'en', title: 'Writing project',
    answer: '## Research question\n\nStudy question.', adoptedSources: f.candidate.source_declaration,
    queryTerms: ['synthetic'], expectedGenerationId: snapshot.generation_id, saveIntent: 'save', projectData: data };
  // Use the adopted paper only.
  const adoptedPaper = snapshot.generation.papers.find(p => p.paper_id === base.adoptedSources[0].paper_id);
  data.evidence_records[0].citations[0].paper_id = adoptedPaper.paper_id;
  data.evidence_records[0].citations[0].path = adoptedPaper.paths.en;
  const adoptedBytes = await readFile(join(f.vaultRoot, adoptedPaper.paths.en));
  data.evidence_records[0].citations[0].sha256 = 'sha256:' + createHash('sha256').update(adoptedBytes).digest('hex');
  data.evidence_records[0].citations[0].anchor = getCurrentNote(current, adoptedPaper.paths.en).sections.find(row => row.anchor).anchor;
  // Rebind source identity to the selected generation as required by the save contract.
  base.adoptedSources = base.adoptedSources.map(row => ({ ...row, adopted_generation_id: snapshot.generation_id }));
  for (const [key, invalid] of [['strength', 'unlimited'], ['polarity', 'invented']]) {
    const badData = structuredClone(data); badData.evidence_records[0][key] = invalid;
    await assert.rejects(validateWritingProjectData({ repoRoot: f.vaultRoot, generationId: snapshot.generation_id, projectData: badData, adoptedSources: base.adoptedSources }), { code: 'WQ_PROJECT_EVIDENCE_INVALID' });
  }
  for (const strength of ['推测', 'tentative', '观察', 'observation', '支持', 'support', '较强', 'strong']) {
    const valid = structuredClone(data); valid.evidence_records[0].strength = strength;
    await validateWritingProjectData({ repoRoot: f.vaultRoot, generationId: snapshot.generation_id, projectData: valid, adoptedSources: base.adoptedSources });
  }
  const saved = await prepareWritingProjectSave(base);
  assert.match(saved.project.project_id, /^project-/);
  assert.equal(saved.project.topic_id, undefined);
  const prepared = await prepareTopicPublication({ vaultRoot: f.vaultRoot, candidate: saved.candidate });
  const authority = await readingFirstPublicationAuthority({ root: f.root, vaultRoot: f.vaultRoot, runId: base.operationId }, prepared.plan);
  await registerBilingualPublication({ vaultRoot: f.vaultRoot, run: base.operationId, plan: prepared.plan, sourceInputs: prepared.sourceInputs, ...authority });
  const committed = await publishTopicFixture({ ...f, run: base.operationId, ...prepared, authority });
  const project = committed.generation.topics.find(row => row.project_id);
  assert.equal(project.path, 'Wiki/writing/' + project.project_id + '.md');
  assert.ok(committed.index.documents.some(row => row.entity_type === 'writing-project' && row.project_id === project.project_id));
  const graph = buildGraphProposal({ activeSnapshot: committed, entityInventory: committed.generation.objects.filter(row => row.path.endsWith('.md')).map(row => ({ path: row.path })) });
  assert.ok(!graph.expectedNodes.includes(project.path));
  assert.ok(project.sections[0].sync_baseline);
  const baselinePath = join(f.vaultRoot, project.path);
  const originalProjectBytes = await readFile(baselinePath, 'utf8');
  assert.doesNotMatch(originalProjectBytes, /sync_baseline/);
  await writeFile(baselinePath, originalProjectBytes.replace('\nObservation\n', '\nChanged outline only\n'));
  const diverged = await readWritingProject({ repoRoot: f.vaultRoot, projectId: project.project_id });
  assert.equal(diverged.diagnostics[0].pending_side, 'body');
  const divergentMaterials = await prepareSynthesisMaterials({ repoRoot: f.vaultRoot, mode: 'draft', projectId: project.project_id, question: 'Synchronize.', section: 'introduction' });
  assert.ok(divergentMaterials.diagnostics.some(row => row.code === 'WQ_SECTION_OUTLINE_BODY_DIVERGED'));
  await writeFile(baselinePath, originalProjectBytes);
  await appendFile(join(f.vaultRoot, project.path), '\nHuman writing notes.\n');
  const read = await readWritingProject({ repoRoot: f.vaultRoot, projectId: project.project_id });
  assert.match(read.markdown, /Human writing notes/);
  assert.match(read.markdown, /Evidence register/);
  assert.match(read.markdown, /\| Evidence ID \| Sources \| Polarity \| Strength \| Allowed statement \|/);
  assert.doesNotMatch(read.markdown, /```apa-/);
  const refs = await exportWritingProjectReferences({ repoRoot: f.vaultRoot, projectId: project.project_id });
  assert.match(refs.content, /@article/);
  assert.equal(refs.model_calls, 0);
  assert.match((await exportWritingProjectReferences({ repoRoot: f.vaultRoot, projectId: project.project_id, format: 'ris' })).content, /TY  - JOUR/);
  const cli = JSON.parse(execFileSync(process.execPath, ['scripts/apa-query.mjs', 'export-refs', '--project-id', project.project_id, '--format', 'both', '--vault-root', f.vaultRoot], { encoding: 'utf8' }));
  assert.equal(cli.bibtex.generation_id, cli.ris.generation_id);
  assert.equal(cli.generation_id, committed.generation_id);
  assert.match(cli.bibtex.content, /@article/);
  assert.match(cli.ris.content, /TY  - JOUR/);
  const editedPath = join(f.vaultRoot, project.path);
  await writeFile(editedPath, (await readFile(editedPath, 'utf8')).replace('Initial rationale', 'Human idea rationale').replace('Initial idea', 'Human idea title').replace('Initial method', 'Human method').replace('Initial dataset', 'Human dataset').replace('Initial metric', 'Human metric').replace('Initial limitation', 'Human limitation').replace('\nObservation\n', '\nHuman outline\n').replace('\nSynthetic observation.\n', '\nHuman draft paragraph.\n'));
  const currentProject = (await readWritingProject({ repoRoot: f.vaultRoot, projectId: project.project_id })).project;
  assert.equal(currentProject.ideas[0].title, 'Human idea title');
  assert.equal(currentProject.ideas[0].rationale, 'Human idea rationale');
  assert.equal(currentProject.sections[0].outline, 'Human outline');
  assert.equal(currentProject.sections[0].body, 'Human draft paragraph.');
  assert.equal(currentProject.sections[0].section_id, 'intro');
  assert.equal(currentProject.evidence_records[0].method, 'Human method');
  assert.equal(currentProject.evidence_records[0].data, 'Human dataset');
  assert.equal(currentProject.evidence_records[0].metrics, 'Human metric');
  assert.equal(currentProject.evidence_records[0].limitations, 'Human limitation');
  Object.assign(data, Object.fromEntries(['ideas', 'discarded_ideas', 'sections', 'citation_plan', 'evidence_records'].map(key => [key, currentProject[key]])));
  const selectedSources = base.adoptedSources.map(row => ({ ...row, adopted_generation_id: committed.generation_id }));
  let calls = 0;
  const updated = await executeWritingProjectUpdate({ repoRoot: f.vaultRoot, projectId: project.project_id,
    baseRevision: 1, generationId: committed.generation_id, selectedSources, question: 'Update the introduction.',
    mainSession: { model: 'synthetic-main', reasoning_effort: 'high' }, hostCapabilities: { currentSession: true, nativeDelegation: true },
    executeHost: async () => { calls++; return { answer: 'Updated supported introduction.', adopted_sources: selectedSources, project_data: data, changes: {} }; } });
  assert.equal(calls, 1);
  const revised = await prepareWritingProjectSave({ ...base, projectId: project.project_id, operationId: 'project-update-1',
    saveIntent: 'update', baseRevision: 1, expectedGenerationId: committed.generation_id, answer: updated.answer,
    adoptedSources: updated.adopted_sources, projectData: updated.project_data, execution: updated.execution_record });
  const updatePrepared = await prepareTopicPublication({ vaultRoot: f.vaultRoot, candidate: revised.candidate });
  const updateAuthority = await readingFirstPublicationAuthority({ root: f.root, vaultRoot: f.vaultRoot, runId: 'project-update-1' }, updatePrepared.plan);
  const updateRegistration = await registerBilingualPublication({ vaultRoot: f.vaultRoot, run: 'project-update-1', plan: updatePrepared.plan, sourceInputs: updatePrepared.sourceInputs, ...updateAuthority });
  await publishTopicFixture({ ...f, run: 'project-update-1', ...updatePrepared, authority: updateAuthority, registration: updateRegistration }, { freshProcess: true });
  const afterUpdate = await readWritingProject({ repoRoot: f.vaultRoot, projectId: project.project_id });
  assert.match(afterUpdate.markdown, /Human writing notes/);
  assert.equal(afterUpdate.project.sections[0].body, 'Human draft paragraph.');
  assert.equal(afterUpdate.project.ideas[0].rationale, 'Human idea rationale');
  const projectPath = join(f.vaultRoot, project.path);
  await writeFile(projectPath, (await readFile(projectPath, 'utf8')).replace('| observation | Synthetic observation. |', '| tentative | Human corrected observation. |'));
  const edited = await readWritingProject({ repoRoot: f.vaultRoot, projectId: project.project_id });
  assert.equal(edited.project.evidence_records[0].allowed_statement, 'Human corrected observation.');
  assert.equal(edited.project.evidence_records[0].strength, 'tentative');
  const visibleBeforeCrLf = await readFile(projectPath, 'utf8');
  await writeFile(projectPath, visibleBeforeCrLf.replace(/\r?\n/g, '\r\n'));
  const windowsEdited = await readWritingProject({ repoRoot: f.vaultRoot, projectId: project.project_id });
  assert.equal(windowsEdited.project.evidence_records[0].allowed_statement, 'Human corrected observation.');
  const materials = await prepareSynthesisMaterials({ repoRoot: f.vaultRoot, mode: 'draft', projectId: project.project_id,
    question: 'Use current project.', section: 'related-work' });
  assert.match(materials.project.current_markdown, /Human corrected observation/);
  assert.doesNotMatch(materials.project.current_markdown, /APA_WRITING_PROJECT|APA_FIELD/);
  assert.doesNotMatch(materials.project.current_markdown, /Human writing notes/);
  const safeMarkdown = await readFile(projectPath, 'utf8');
  await writeFile(projectPath, safeMarkdown.replace('Human draft paragraph.', 'Human draft paragraph.\n<!-- APA_FIELD fake -->'));
  await assert.rejects(readWritingProject({ repoRoot: f.vaultRoot, projectId: project.project_id }), { code: 'WQ_PROJECT_CURRENT_DATA_INVALID' });
  await writeFile(projectPath, safeMarkdown);
  const bad = structuredClone(base);
  bad.operationId = 'project-invalid'; bad.projectData.evidence_records[0].citations[0].anchor = 'missing';
  bad.expectedGenerationId = (await readCurrentVaultContent({ vaultRoot: f.vaultRoot })).generation_id;
  await assert.rejects(prepareWritingProjectSave(bad), { code: 'WQ_PROJECT_CITATION_INVALID' });
  // A human edit to a cited paper note keeps the project usable; a save still has to rebind the citation.
  const citedPath = join(f.vaultRoot, adoptedPaper.paths.en);
  await appendFile(citedPath, '\nHuman clarification of the cited paper note.\n');
  const currentSha = 'sha256:' + createHash('sha256').update(await readFile(citedPath)).digest('hex');
  const stale = await readWritingProject({ repoRoot: f.vaultRoot, projectId: project.project_id });
  assert.deepEqual(stale.diagnostics.map(row => [row.code, row.evidence_id, row.reason, row.current_sha256]), [['WQ_PROJECT_CITATION_CHANGED', 'e1', 'note_changed', currentSha]]);
  assert.ok((await exportWritingProjectReferences({ repoRoot: f.vaultRoot, projectId: project.project_id })).diagnostics.some(row => row.code === 'WQ_PROJECT_CITATION_CHANGED'));
  const staleMaterials = await prepareSynthesisMaterials({ repoRoot: f.vaultRoot, mode: 'draft', projectId: project.project_id, question: 'Use current project.', section: 'related-work' });
  assert.ok(staleMaterials.diagnostics.some(row => row.code === 'WQ_PROJECT_CITATION_CHANGED'));
  const latestGeneration = (await readCurrentVaultContent({ vaultRoot: f.vaultRoot })).generation_id;
  const staleData = Object.fromEntries(['evidence_records', 'ideas', 'discarded_ideas', 'sections', 'citation_plan'].map(key => [key, stale.project[key]]));
  const reboundData = structuredClone(staleData);
  reboundData.evidence_records[0].citations[0].sha256 = currentSha;
  const latestSources = base.adoptedSources.map(row => ({ ...row, adopted_generation_id: latestGeneration }));
  let updateTask;
  const rebound = await executeWritingProjectUpdate({ repoRoot: f.vaultRoot, projectId: project.project_id, baseRevision: 2, generationId: latestGeneration,
    selectedSources: latestSources, question: 'Rebind the changed citation.', mainSession: { model: 'synthetic-main', reasoning_effort: 'high' },
    hostCapabilities: { currentSession: true, nativeDelegation: true },
    executeHost: async task => { updateTask = task; return { answer: 'Rebound supported introduction.', adopted_sources: latestSources, project_data: reboundData, changes: {} }; } });
  assert.deepEqual(updateTask.evidence.citation_changes.map(row => [row.evidence_id, row.current_sha256]), [['e1', currentSha]]);
  const rebindInputs = { ...base, projectId: project.project_id, saveIntent: 'update', baseRevision: 2, expectedGenerationId: latestGeneration,
    answer: rebound.answer, adoptedSources: rebound.adopted_sources, execution: rebound.execution_record };
  await assert.rejects(prepareWritingProjectSave({ ...rebindInputs, operationId: 'project-stale-save', projectData: staleData }),
    error => error.code === 'WQ_PROJECT_CITATION_INVALID' && error.details.reason === 'note_changed');
  assert.equal((await prepareWritingProjectSave({ ...rebindInputs, operationId: 'project-rebind-1', projectData: rebound.project_data })).status, 'candidate');
});

test('bibliography formatter preserves bilingual full citations and emits both reference formats', () => {
  const papers = [{ paper_id: 'paper-1', bibliography: { title: { en: 'Real title' }, first_author: 'Author', year: 2024, doi: '10.1/example', full_citation: { en: 'Author (2024). Real title.' } } }];
  for (const format of ['bibtex', 'ris']) {
    const result = exportBibliographyRecords({ papers, language: 'en', format });
    assert.match(result.content, /Author \(2024\). Real title./);
    assert.doesNotMatch(result.content, /\[object Object\]/);
  }
});
import { sectionBaselines, sectionChanges, validateSectionSync } from '../../scripts/v3/writing-project.mjs';

test('section baselines detect one-sided edits and require synchronization or a reason', () => {
  const original = { sections: [{ section_id: 'intro', outline: 'A', body: 'B' }] };
  original.section_baselines = sectionBaselines(original.sections);
  for (const [field, pending] of [['outline', 'body'], ['body', 'outline']]) {
    const edited = structuredClone(original); edited.sections[0][field] += ' edit';
    assert.equal(sectionChanges(edited).diagnostics[0].pending_side, pending);
    assert.throws(() => validateSectionSync(edited, edited), { code: 'WQ_SECTION_SYNC_REQUIRED' });
    const synced = structuredClone(edited); synced.sections[0][pending] += ' synced';
    assert.doesNotThrow(() => validateSectionSync(edited, synced));
    synced.section_baselines = sectionBaselines(synced.sections);
    assert.deepEqual(sectionChanges(synced).diagnostics, []);
    const explained = structuredClone(edited);
    explained.sections[0].sync_reason = 'The existing wording already covers the amended scope.';
    assert.doesNotThrow(() => validateSectionSync(edited, explained));
  }
  const both = structuredClone(original); both.sections[0].outline += ' edit'; both.sections[0].body += ' edit';
  assert.deepEqual(sectionChanges(both).diagnostics, []);
  assert.equal(sectionChanges(both).section_changes[0].status, 'both_manually_modified');
  assert.deepEqual(sectionChanges({ sections: original.sections }).diagnostics, []);
});
