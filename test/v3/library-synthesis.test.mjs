import test from 'node:test';
import assert from 'node:assert/strict';
import { checkStructuredClaims, checkIdeas, checkDraft, synthesisPrompt, moduleNumber, validateSynthesisOutput, compactKnowledge, ideaCoverage } from '../../scripts/v3/library-synthesis.mjs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readingFirstIndexFixture } from './helpers/reading-first-index-fixtures.mjs';
import { prepareLibraryQuery, executeLibraryQuery } from '../../scripts/v3/library-query.mjs';
import { readCurrentVaultContent, getCurrentNote } from '../../scripts/v3/current-vault-content.mjs';

const note = (paper, module = 4, content = 'Human cohort observed a benefit.') => ({ paper_id: paper, path: `Wiki/sources/${paper}.md`, anchor: `${module}. Findings`,
  module, content, sha256: 'sha256:' + 'a'.repeat(64), evidence_type: '直接证据' });
const a = note('a'), b = note('b');
const cite = (row, conditions = {}) => ({ paper_id: row.paper_id, path: row.path, anchor: row.anchor, sha256: row.sha256, quote: row.content, claim_origin: 'author', conditions });
const claim = (overrides = {}) => ({ claim_id: 'claim-1', text: 'Reported benefit.', attribution: '多篇一致', strength: '观察', evidence_type: '直接证据', citations: [cite(a), cite(b)], ...overrides });
const codes = issues => issues.map(row => row.code);

test('WQ-15a shared methods cannot establish agreement in findings', () => {
  const methods = [note('a', 3), note('b', 3)];
  assert.ok(codes(checkStructuredClaims({ claims: [claim({ citations: methods.map(row => cite(row)) })], evidence: methods })).includes('WQ_FINDING_MODULE_REQUIRED'));
});
test('WQ-15a one paper cannot be called multi-paper agreement or inference', () => {
  for (const attribution of ['多篇一致', '相互冲突', '跨篇推断']) assert.ok(codes(checkStructuredClaims({ claims: [claim({ attribution, citations: [cite(a), cite(a)] })], evidence: [a] })).includes('WQ_CROSS_PAPER_COUNT'));
});
test('WQ-15a different populations or measures cannot be merged silently', () => {
  const mouse = note('b', 4, 'Mouse experiment observed a benefit.');
  const data = claim({ citations: [cite(a, { population: 'Human' }), cite(mouse, { population: 'Mouse' })] });
  assert.ok(codes(checkStructuredClaims({ claims: [data], evidence: [a, mouse] })).includes('WQ_CONDITIONS_MERGED'));
  assert.deepEqual(checkStructuredClaims({ claims: [{ ...data, conditions_preserved: true }], evidence: [a, mouse] }), []);
});
test('WQ-15a speculation cannot be promoted to support or strong evidence', () => {
  const speculative = note('a', 7, 'This may improve outcomes.');
  for (const strength of ['支持', '较强']) assert.ok(codes(checkStructuredClaims({ claims: [claim({ attribution: '单篇发现', strength, citations: [cite(speculative)] })], evidence: [speculative] })).includes('WQ_SPECULATION_PROMOTED'));
});
test('WQ-15a validates actual anchors, bytes, quotes and direct evidence', () => {
  assert.deepEqual(checkStructuredClaims({ claims: [claim()], evidence: [a, b] }), []);
  const background = { ...a, paper_id: undefined, evidence_type: '背景知识' };
  const issues = checkStructuredClaims({ claims: [claim({ attribution: '单篇发现', strength: '较强', citations: [cite(background)] })], evidence: [background] });
  assert.ok(codes(issues).includes('WQ_DIRECT_EVIDENCE_REQUIRED'));
  assert.ok(codes(checkStructuredClaims({ claims: [claim({ citations: [{ ...cite(a), anchor: 'invented' }] })], evidence: [a] })).includes('WQ_CITATION_INVALID'));
  assert.ok(codes(checkStructuredClaims({ claims: [claim({ citations: [{ ...cite(a), quote: 'fabricated result' }] })], evidence: [a] })).includes('WQ_QUOTE_UNSUPPORTED'));
});
test('WQ-16 modes contain fixed sections and one-task structured evidence contract', () => {
  for (const mode of ['themes', 'dossier', 'compare', 'clues', 'ideas', 'draft', 'review']) {
    assert.match(synthesisPrompt(mode), /同一配置任务/);
    assert.match(synthesisPrompt(mode), /claims/);
    assert.match(synthesisPrompt(mode), /sha256/);
  }
  assert.equal(moduleNumber({ anchor: '2.2 Study design' }), 2);
  assert.equal(moduleNumber({ anchor: '6 局限' }), 6);
  assert.equal(moduleNumber({ anchor: 'Discussion', section_id: null }), null);
});

function ideasFixture() {
  const candidates = Array.from({ length: 8 }, (_, i) => ({ idea_id: 'idea-' + i, statement: 'Test direction ' + i, lens: '方法迁移', citations: [cite(a)] }));
  const ideas = candidates.slice(0, 3).map(row => ({ ...row, name: row.statement, hypothesis: 'Measurable hypothesis', minimum_validation: 'Compare controls.',
    contribution_type: '新发现', risk: { level: '低', source: '已有数据' }, effort: { level: '低', source: '小规模分析' }, scores: { interest: 5, feasibility: 5, novelty: 5 },
    most_similar_papers: [{ paper_id: 'a', overlap: 'method', difference: 'outcome', conditions: 'Synthetic cohort' }], reviewer_objection: 'Confounding', response: 'Controls', single_source: true, external_novelty: '未核对' }));
  return { candidates, ideas, discarded: candidates.slice(3).map(row => ({ idea_id: row.idea_id, reason: '明确缺少必要数据', criterion: '可行性', objective_infeasibility: true })) };
}
test('WQ-18 through WQ-21 idea anchors, existing directions, nearest work and fields', () => {
  const output = ideasFixture();
  assert.deepEqual(checkIdeas({ output, evidence: [a], paperIds: ['a'] }), []);
  const bad = structuredClone(output);
  bad.ideas[0].citations[0].anchor = 'missing';
  bad.ideas[1].single_source = false;
  bad.ideas[2].most_similar_papers[0].paper_id = 'not-registered';
  const issues = codes(checkIdeas({ output: bad, evidence: [a], paperIds: ['a'], existingIdeas: [{ statement: output.candidates[0].statement }] }));
  for (const code of ['WQ_IDEA_CITATION_INVALID', 'WQ_SINGLE_SOURCE_MISMATCH', 'WQ_NEAREST_PAPER_INVALID', 'WQ_IDEA_DUPLICATE']) assert.ok(issues.includes(code), code);
});
test('WQ-30 speculation written as established findings is flagged', () => {
  const issues = checkDraft({ output: { answer: '已经发现有效。[@e1]', statements: [{ text: '已经发现有效。', evidence_ids: ['e1'], strength: '支持' }] },
    evidenceRecords: [{ evidence_id: 'e1', strength: '推测', citations: [cite(a)] }] });
  assert.ok(codes(issues).includes('WQ_SPECULATION_AS_FINDING'));
  assert.ok(codes(issues).includes('WQ_DRAFT_STRENGTH_EXCEEDED'));
});
test('WQ-30 single paper written as field consensus and unknown evidence are flagged', () => {
  const issues = checkDraft({ output: { answer: '领域共识认为有效。[@e1] [@missing]', statements: [{ text: '领域共识认为有效。', evidence_ids: ['e1'], strength: '观察', attribution: '单篇发现' }] },
    evidenceRecords: [{ evidence_id: 'e1', strength: '观察', citations: [cite(a)] }] });
  assert.ok(codes(issues).includes('WQ_SINGLE_PAPER_AS_CONSENSUS'));
  assert.ok(codes(issues).includes('WQ_DRAFT_CITATION_UNREGISTERED'));
});
test('WQ-29 reviewer response preserves the supplied original draft', () => {
  assert.ok(codes(checkDraft({ output: { draft_text: 'changed', answer: '' }, originalDraft: 'Original.', review: true })).includes('WQ_REVIEW_CHANGED_PROSE'));
});

test('selected ideas cannot repeat one candidate to reach the required count', () => {
  const output = ideasFixture();
  output.ideas = Array.from({ length: 3 }, () => structuredClone(output.ideas[0]));
  assert.ok(codes(checkIdeas({ output, evidence: [a], paperIds: ['a'] })).includes('WQ_SELECTED_IDEA_DUPLICATE'));
});
test('draft citation must bind to its own statement and permitted wording', () => {
  const evidenceRecords = ['e1', 'e2'].map(evidence_id => ({ evidence_id, strength: '推测', allowed_statement: '可能相关', citations: [cite(a)] }));
  const result = checkDraft({ output: { answer: '该变化导致疾病。[@e2]', statements: [{ text: '该变化导致疾病。', evidence_ids: ['e1'], strength: '推测' }] }, evidenceRecords });
  assert.ok(codes(result).includes('WQ_DRAFT_CITATION_MISMATCH'));
  assert.ok(codes(result).includes('WQ_ALLOWED_WORDING_EXCEEDED'));
});
test('review answer may add comments but cannot change the original prose', () => {
  const originalDraft = 'Observed. [@e1]';
  const evidenceRecords = [{ evidence_id: 'e1', strength: '观察', allowed_statement: 'Observed.', citations: [cite(a)] }];
  const output = { draft_text: originalDraft, answer: originalDraft + '%% [open] Check the population. %%', comments: [{ paragraph: 1, comment: 'Check the population.', status: 'open' }], statements: [{ text: 'Observed.', evidence_ids: ['e1'], strength: '观察', attribution: '单篇发现' }] };
  assert.deepEqual(checkDraft({ output, originalDraft, evidenceRecords, review: true }), []);
  output.answer = output.answer.replace('Observed.', 'Changed.');
  assert.ok(codes(checkDraft({ output, originalDraft, evidenceRecords, review: true })).includes('WQ_REVIEW_CHANGED_ANSWER'));
});
test('output validation checks the prepared project bytes explicitly', async t => {
  const fixture = await readingFirstIndexFixture(t);
  await fixture.save(await fixture.build());
  await assert.rejects(validateSynthesisOutput({ repoRoot: fixture.vaultRoot, generationId: fixture.generation.generation_id,
    mode: 'draft', output: {}, materials: { project: { path: fixture.paper.paths.en, sha256: 'stale' } } }), { code: 'WQ_MATERIALS_CHANGED' });
});

test('WQ-14 each synthesis mode prepares registered materials and executes at most one task', async t => {
  const fixture = await readingFirstIndexFixture(t);
  await fixture.save(await fixture.build());
  const inputs = { repoRoot: fixture.vaultRoot, question: 'finalresultneedle', mainSession: { model: 'synthetic-main', reasoning_effort: 'high' }, hostCapabilities: { currentSession: true } };
  for (const mode of ['themes', 'dossier', 'compare', 'clues', 'ideas']) {
    const prepared = await prepareLibraryQuery({ ...inputs, mode, node: fixture.generation.shared_nodes[0].entity_id });
    assert.equal(prepared.status, 'prepared');
    assert.equal(prepared.task.evidence.materials.mode, mode);
    assert.equal(prepared.task.evidence.materials.generation_id, prepared.generation_id);
    assert.ok(prepared.task.evidence.materials.content_hash.startsWith('sha256:'));
    assert.match(prepared.task.prompt, /固定结构/);
  }
  let calls = 0;
  const result = await executeLibraryQuery({ ...inputs, mode: 'themes', executeHost: async () => { calls++; return { answer: 'Synthetic synthesis.', claims: [] }; } });
  assert.equal(calls, 1);
  assert.equal(result.status, 'answered');
  assert.equal(result.validation.status, 'issues');
  assert.equal(result.validation.issues[0].code, 'WQ_CLAIMS_REQUIRED');
});

test('WQ-28 draft and review preparation carry section rules and supplied results', async t => {
  const fixture = await readingFirstIndexFixture(t);
  await fixture.save(await fixture.build());
  const snapshot = await readCurrentVaultContent({ vaultRoot: fixture.vaultRoot });
  const path = fixture.paper.paths.en, note = getCurrentNote(snapshot, path), section = note.sections.find(row => row.anchor);
  const writingContext = { projectData: { evidence_records: [{ evidence_id: 'e1', citations: [{ paper_id: fixture.identity.paper_id, path, anchor: section.anchor, sha256: note.sha256 }],
    polarity: '支持', strength: '观察', allowed_statement: 'Synthetic observation.', forbidden_statement: 'Proved universally.', relationship: 'Background' }],
    ideas: [], discarded_ideas: [], sections: [], citation_plan: [] }, adoptedSources: [{ paper_id: fixture.identity.paper_id }] };
  const inputs = { repoRoot: fixture.vaultRoot, question: 'finalresultneedle', writingContext, mainSession: { model: 'synthetic-main', reasoning_effort: 'high' }, hostCapabilities: { currentSession: true } };
  await assert.rejects(prepareLibraryQuery({ ...inputs, mode: 'draft', section: 'discussion' }), { code: 'WQ_USER_RESULTS_REQUIRED' });
  const draft = await prepareLibraryQuery({ ...inputs, mode: 'draft', section: 'discussion', userResults: 'User-supplied synthetic result.' });
  assert.equal(draft.task.evidence.materials.user_results, 'User-supplied synthetic result.');
  assert.match(draft.task.prompt, /允许和禁止表述/);
  assert.equal(draft.task.evidence.materials.diagnostics[0].code, 'WQ_PROJECT_POSITIONING_INCOMPLETE');
  const withContext = await prepareLibraryQuery({ ...inputs, mode: 'draft', section: 'related-work', writingContext: { ...writingContext, current_markdown: '研究问题：何种条件下有效？\n核心论点：比较条件决定外推范围。' } });
  assert.match(withContext.task.evidence.materials.project.current_markdown, /核心论点/);
  assert.equal(withContext.task.evidence.materials.project.status, 'unsaved_context');
  assert.deepEqual(withContext.task.evidence.materials.diagnostics, []);
  const review = await prepareLibraryQuery({ ...inputs, mode: 'review', draftText: 'Original paragraph.' });
  assert.equal(review.task.evidence.materials.draft_text, 'Original paragraph.');
  assert.match(review.task.prompt, /不改原文/);
});

test('knowledge prompt projection stays bounded and exposes recovery for omitted rows', () => {
  const nodes = Array.from({ length: 200 }, (_, i) => ({ entity_id: String(i), title: 'node'.repeat(100), path: `Wiki/methods/${i}.md`,
    sha256: 'sha256:' + 'a'.repeat(64), body: 'full prose'.repeat(10000), paper_ids: ['p1', 'p2'] }));
  const compact = compactKnowledge({ status: 'matches', generation_id: 'g', content_hash: 'h', shared_nodes: nodes, isolated_methods: nodes, themes: [], bridges: [] }, 'themes');
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) < 25000);
  assert.equal(compact.text_omitted, true);
  assert.equal(compact.truncated, true);
  assert.equal(compact.omitted_counts.shared_nodes + compact.shared_nodes.length, 200);
  assert.equal(compact.retrieval.command, 'landscape');
  assert.ok(compact.shared_nodes[0].path);
  assert.equal(compact.shared_nodes[0].body, undefined);
});

test('knowledge projection keeps rows of selected or seed papers before the bounded cut', () => {
  const row = (i, paper) => ({ entity_id: 'n' + String(i).padStart(3, '0'), title: 'Method ' + i, path: `Wiki/methods/n${i}.md`, sha256: 'sha256:' + 'a'.repeat(64), paper_ids: [paper] });
  // Selected-paper rows sort after 40 unrelated rows, as hash-ordered identifiers can place them.
  const isolated = [...Array.from({ length: 40 }, (_, i) => row(i, 'other')), ...Array.from({ length: 5 }, (_, i) => row(100 + i, 'selected'))];
  const bridges = [...Array.from({ length: 30 }, (_, i) => ({ paper_ids: ['other', 'x' + i], shared_nodes: ['n000'], similarity: 0.2 })), { paper_ids: ['selected', 'other'], shared_nodes: ['n100'], similarity: 0.2 }];
  const knowledge = { status: 'matches', generation_id: 'g', content_hash: 'h', shared_nodes: [], isolated_methods: isolated, themes: [], bridges };
  const unprioritized = compactKnowledge(knowledge, 'ideas');
  assert.ok(!unprioritized.isolated_methods.some(node => node.paper_ids.includes('selected')));
  const ideas = compactKnowledge(knowledge, 'ideas', { paperIds: ['selected'] });
  assert.deepEqual(ideas.isolated_methods.slice(0, 5).map(node => node.entity_id), ['n100', 'n101', 'n102', 'n103', 'n104']);
  assert.equal(ideas.isolated_methods.length, 16);
  assert.equal(ideas.omitted_counts.isolated_methods, 29);
  assert.deepEqual(ideas.bridges[0].paper_ids, ['selected', 'other']);
  assert.deepEqual(ideas.prioritized_paper_ids, ['selected']);
  const clues = compactKnowledge({ ...knowledge, seed_papers: ['selected'], adjacent_nodes: [], papers: [] }, 'clues');
  assert.deepEqual(clues.bridges[0].paper_ids, ['selected', 'other']);
});

test('compact current-content fingerprint still rejects a changed map dependency', async t => {
  const fixture = await readingFirstIndexFixture(t);
  await fixture.save(await fixture.build());
  const prepared = await prepareLibraryQuery({ repoRoot: fixture.vaultRoot, question: 'finalresultneedle', mode: 'themes',
    mainSession: { model: 'synthetic-main', reasoning_effort: 'high' }, hostCapabilities: { currentSession: true } });
  const materials = prepared.task.evidence.materials;
  assert.match(materials.observed_notes_hash, /^sha256:/);
  assert.equal(materials.observed_notes, undefined);
  await appendFile(join(fixture.vaultRoot, fixture.generation.shared_nodes[0].path), '\nChanged current method.\n');
  await assert.rejects(validateSynthesisOutput({ repoRoot: fixture.vaultRoot, generationId: prepared.generation_id, mode: 'themes', output: {}, materials }), { code: 'P23_CURRENT_CHANGED' });
});

test('draft strength uses the same bilingual scale as writing projects', () => {
  const evidenceRecords = [{ evidence_id: 'e1', strength: 'observation', allowed_statement: 'Observed.', citations: [cite(a)] }];
  assert.deepEqual(checkDraft({ evidenceRecords, output: { answer: 'Observed.[@e1]', outline: ['Observation'], citation_plan: [{ evidence_ids: ['e1'] }], overstatements: [], statements: [{ text: 'Observed.', evidence_ids: ['e1'], strength: '观察', attribution: '单篇发现' }] } }), []);
});


test('W4 rejects free-form classifications, unlabelled risk and unsupported author attribution', () => {
  const output = ideasFixture();
  output.ideas[0].lens = '随意';
  output.ideas[0].risk = '中';
  output.ideas[0].contribution_type = '任意贡献';
  output.candidates[0].citations[0].claim_origin = 'author';
  const evidence = [{ ...a, content: 'Analyst-derived: Human cohort observed a benefit.' }];
  const found = codes(checkIdeas({ output, evidence, paperIds: ['a'] }));
  for (const code of ['WQ_IDEA_LENS', 'WQ_CONTRIBUTION_TYPE', 'WQ_RISK_EFFORT', 'WQ_CLAIM_ORIGIN_MISMATCH']) assert.ok(found.includes(code), code);
});

test('W4 rejects unsupported quote and ambiguous convergence', () => {
  const output = ideasFixture();
  output.candidates[0].citations[0].quote = 'Invented text';
  output.discarded[0].criterion = '新颖性';
  const found = codes(checkIdeas({ output, evidence: [a], paperIds: ['a'] }));
  assert.ok(found.includes('WQ_IDEA_QUOTE_UNSUPPORTED'));
  assert.ok(found.includes('WQ_CONVERGENCE_REASON'));
});

test('W6 validates attribution and required draft sections', () => {
  const found = codes(checkDraft({ output: { answer: 'Observed.[@e1]', statements: [{ text: 'Observed.', evidence_ids: ['e1'], strength: '观察', attribution: '任意归属' }] }, evidenceRecords: [{ evidence_id: 'e1', strength: '观察', citations: [cite(a)] }] }));
  assert.ok(found.includes('WQ_DRAFT_ATTRIBUTION'));
  assert.ok(found.includes('WQ_DRAFT_OUTPUT_FIELDS'));
});


test('W4 reports narrow material use and actual bridge or isolated node citation coverage', () => {
  const narrow = ideaCoverage(ideasFixture(), [a]);
  assert.equal(narrow.modules[4], 8);
  assert.equal(narrow.diagnostics[0].code, 'WQ_IDEAS_NARROW_MATERIAL_USE');
  const evidence = [{ ...a, module: 6 }, { path: 'Wiki/methods/m.md', anchor: 'Use', content: 'method', sha256: a.sha256 }];
  const output = ideasFixture();
  output.candidates[0].citations.push({ path: evidence[1].path, anchor: 'Use', sha256: a.sha256 });
  const coverage = ideaCoverage(output, evidence, { knowledge: { isolated_methods: [{ path: evidence[1].path }], shared_nodes: [{ entity_id: 'm', path: evidence[1].path }], bridges: [{ shared_nodes: ['m'] }] } });
  assert.equal(coverage.modules[6], 8);
  assert.equal(coverage.isolated_method_paths_cited, 1);
  assert.equal(coverage.bridge_nodes_cited, 1);
});


test('W4 accepts combined enumerated lenses', () => {
  const output = ideasFixture();
  output.candidates[0].lens = ['边界探查', '组合与拆分'];
  output.ideas[0].lens = ['边界探查', '组合与拆分'];
  assert.deepEqual(checkIdeas({ output, evidence: [a], paperIds: ['a'] }), []);
});

test('W4 distinguishes author and analyst paragraphs in the same research-directions section', () => {
  const content = 'Authors propose family studies.\n\nCompare free WT and variant protein. These analyst-derived experiments distinguish availability from activity.';
  const section = { ...a, anchor: '7.2 Research directions', content, module: 7 };
  const output = ideasFixture();
  const citation = { ...cite(section), quote: 'Compare free WT and variant protein.', claim_origin: 'author' };
  output.candidates[0].citations = [citation];
  const found = codes(checkIdeas({ output, evidence: [a, section], paperIds: ['a'] }));
  assert.ok(found.includes('WQ_CLAIM_ORIGIN_MISMATCH'));
  citation.quote = 'Authors propose family studies.';
  assert.ok(!codes(checkIdeas({ output, evidence: [a, section], paperIds: ['a'] })).includes('WQ_CLAIM_ORIGIN_MISMATCH'));
});

test('A2 rejects changed materials and requires draft materials', async t => {
  const fixture = await readingFirstIndexFixture(t);
  await fixture.save(await fixture.build());
  const args = { repoRoot: fixture.vaultRoot, generationId: fixture.generation.generation_id, mode: 'draft', output: {} };
  await assert.rejects(validateSynthesisOutput(args), { code: 'WQ_MATERIALS_REQUIRED' });
  await assert.rejects(validateSynthesisOutput({ ...args, materials: { content_hash: 'stale', project: { evidence_records: [] } } }), { code: 'WQ_MATERIALS_CHANGED' });
});

test('A4 preserves old comments and validates new paragraph comments', () => {
  const originalDraft = 'First.%% [resolved] old %%\n\nSecond.';
  const run = (answer, comments) => codes(checkDraft({ output: { answer, draft_text: originalDraft, statements: [], comments }, originalDraft, review: true }));
  assert.ok(!run(originalDraft, []).includes('WQ_REVIEW_CHANGED_ANSWER'));
  assert.ok(run(originalDraft.replace('old', 'changed'), []).includes('WQ_REVIEW_OLD_COMMENT_CHANGED'));
  assert.ok(run(originalDraft + '%% [open] new %%', []).includes('WQ_REVIEW_COMMENTS_MISMATCH'));
  assert.ok(run(originalDraft + '%% [open] new %%', [{ paragraph: 1, comment: 'new', status: 'open' }]).includes('WQ_REVIEW_COMMENT_POSITION'));
  assert.ok(!run(originalDraft + '%% [open] new %%', [{ paragraph: 2, comment: 'new', status: 'open' }]).some(code => code.startsWith('WQ_REVIEW_')));
});

test('A6 paraphrased forbidden wording and absent conditions are advisory', () => {
  const diagnostics = [];
  for (const text of ['在等量游离RSPO1条件下，R219W的内在活性已被证实更高', '等量游离蛋白比较显示R219W具有更强的内在活性']) {
    checkDraft({ output: { answer: text + '[@e1]', statements: [{ text, evidence_ids: ['e1'], strength: '观察', attribution: '单篇发现' }] }, evidenceRecords: [{ evidence_id: 'e1', strength: '观察', forbidden_statement: '等量游离蛋白下R219W具有更高的内在活性', citations: [cite(a)] }], diagnostics });
  }
  assert.equal(diagnostics.filter(row => row.code === 'WQ_FORBIDDEN_STATEMENT_SIMILAR').length, 2);
  checkStructuredClaims({ claims: [claim()], evidence: [a, b], diagnostics });
  assert.ok(diagnostics.some(row => row.code === 'WQ_CONDITIONS_UNREPORTED'));
});

test('A4 rejects changed status, illegal status and retains handled comments in preparation', async t => {
  const originalDraft = 'Original.%% [resolved] handled %%';
  for (const answer of [originalDraft.replace('resolved', 'open'), originalDraft.replace('handled', 'altered')]) {
    assert.ok(codes(checkDraft({ output: { answer, draft_text: originalDraft, comments: [], statements: [] }, originalDraft, review: true })).includes('WQ_REVIEW_OLD_COMMENT_CHANGED'));
  }
  assert.ok(codes(checkDraft({ output: { answer: 'Original.%% [closed] new %%', draft_text: 'Original.', comments: [{ paragraph: 1, comment: 'new', status: 'closed' }], statements: [] }, originalDraft: 'Original.', review: true })).includes('WQ_REVIEW_COMMENTS_MISMATCH'));
  const fixture = await readingFirstIndexFixture(t);
  await fixture.save(await fixture.build());
  const snapshot = await readCurrentVaultContent({ vaultRoot: fixture.vaultRoot });
  const path = fixture.paper.paths.en, note = getCurrentNote(snapshot, path), section = note.sections.find(row => row.anchor);
  const prepared = await prepareLibraryQuery({ repoRoot: fixture.vaultRoot, mode: 'review', question: 'review', draftText: originalDraft,
    mainSession: { model: 'synthetic-main', reasoning_effort: 'high' }, hostCapabilities: { currentSession: true },
    writingContext: { projectData: { evidence_records: [{ evidence_id: 'e1', citations: [{ paper_id: fixture.identity.paper_id, path, anchor: section.anchor, sha256: note.sha256 }], polarity: '支持', strength: '观察', allowed_statement: 'Observed.', forbidden_statement: 'Proved.', relationship: 'Background' }], ideas: [], discarded_ideas: [], sections: [], citation_plan: [] }, adoptedSources: [{ paper_id: fixture.identity.paper_id }] } });
  assert.equal(prepared.task.evidence.materials.draft_text, originalDraft);
  assert.equal(prepared.task.evidence.materials.review_comments[0].handled, true);
});

test('A4 review comments locate nonempty paragraphs with leading and trailing whitespace', () => {
  for (const [originalDraft, paragraph, answer] of [
    ['A段。\n\nB段。\n', 2, 'A段。\n\nB段。%% [open] check %%\n'],
    ['\n\nA段。\n\nB段。', 1, '\n\nA段。%% [open] check %%\n\nB段。'],
  ]) assert.ok(!codes(checkDraft({ originalDraft, review: true, output: { draft_text: originalDraft, answer, comments: [{ paragraph, comment: 'check', status: 'open' }], statements: [] } })).includes('WQ_REVIEW_COMMENT_POSITION'));
});

test('A6 limitations in another clause and not only do not suppress forbidden similarity', () => {
  const cases = [
    ['RSPO1直接抑制细胞分化。', 'RSPO1直接抑制细胞的分化，但受体仍需鉴定。'],
    ['RSPO1直接抑制细胞分化。', 'RSPO1直接抑制细胞的分化，受体仍需鉴定。'],
    ['RSPO1 directly suppresses cell differentiation.', 'RSPO1 not only directly suppresses cell differentiation but also changes signaling.'],
    ['目前无法确定RSPO1直接抑制细胞分化。', 'RSPO1直接抑制细胞分化目前仍无法确定。'],
  ];
  for (const [forbidden_statement, text] of cases) {
    const diagnostics = [];
    checkDraft({ output: { answer: text + '[@e1]', statements: [{ text, evidence_ids: ['e1'], strength: '观察', attribution: '单篇发现' }] }, evidenceRecords: [{ evidence_id: 'e1', strength: '观察', forbidden_statement, citations: [cite(a)] }], diagnostics });
    assert.ok(diagnostics.some(row => row.code === 'WQ_FORBIDDEN_STATEMENT_SIMILAR'), text);
  }
});

test('draft cross-paper attribution requires two distinct cited papers', () => {
  const text = 'Observed.';
  const output = { answer: text + '[@e1]', statements: [{ text, evidence_ids: ['e1'], strength: '观察', attribution: '跨篇推断' }] };
  assert.ok(codes(checkDraft({ output, evidenceRecords: [{ evidence_id: 'e1', strength: '观察', citations: [cite(a)] }] })).includes('WQ_DRAFT_CROSS_PAPER_COUNT'));
  assert.ok(!codes(checkDraft({ output, evidenceRecords: [{ evidence_id: 'e1', strength: '观察', citations: [cite(a), cite(b)] }] })).includes('WQ_DRAFT_CROSS_PAPER_COUNT'));
});

test('A6 ordinary Chinese negative forbidden wording remains comparable', () => {
  const text = 'RSPO1不能影响成熟脂肪细胞';
  const diagnostics = [];
  checkDraft({ output: { answer: text + '[@e1]', statements: [{ text, evidence_ids: ['e1'], strength: '观察', attribution: '单篇发现' }] }, evidenceRecords: [{ evidence_id: 'e1', strength: '观察', forbidden_statement: 'RSPO1 不影响成熟脂肪细胞', citations: [cite(a)] }], diagnostics });
  assert.ok(diagnostics.some(row => row.code === 'WQ_FORBIDDEN_STATEMENT_SIMILAR'));
  const limitedText = '目前无法确定RSPO1直接抑制细胞分化';
  const limitedDiagnostics = [];
  checkDraft({ output: { answer: limitedText + '[@e1]', statements: [{ text: limitedText, evidence_ids: ['e1'], strength: '观察', attribution: '单篇发现' }] }, evidenceRecords: [{ evidence_id: 'e1', strength: '观察', forbidden_statement: 'RSPO1直接抑制细胞分化', citations: [cite(a)] }], diagnostics: limitedDiagnostics });
  assert.ok(!limitedDiagnostics.some(row => row.code === 'WQ_FORBIDDEN_STATEMENT_SIMILAR'));

});

for (const [text, expected] of [
  ['RSPO1 抑制了脂肪细胞的分化', 1],
  ['RSPO1 不可逆地抑制了脂肪细胞的分化', 1],
  ['RSPO1 不断抑制了脂肪细胞的分化', 1],
  ['RSPO1 在营养不足时抑制了脂肪细胞的分化', 1],
  ['RSPO1 是否抑制脂肪细胞分化尚未确定', 0],
]) test(`A6 explicit limitation phrases: ${text}`, () => {
  const diagnostics = [];
  checkDraft({ output: { answer: text + '[@e1]', statements: [{ text, evidence_ids: ['e1'], strength: '观察', attribution: '单篇发现' }] }, evidenceRecords: [{ evidence_id: 'e1', strength: '观察', forbidden_statement: 'RSPO1 抑制脂肪细胞分化', citations: [cite(a)] }], diagnostics });
  assert.equal(diagnostics.filter(row => row.code === 'WQ_FORBIDDEN_STATEMENT_SIMILAR').length, expected);
});

test('A6 explicit negative phrases suppress only advisory paraphrase matches', () => {
  for (const phrase of ['不能', '不会', '不是', '不影响', '不支持', '不足以', '并不', '并未', '未见', '没有', '无证据', '尚未', '无法', '仍需', '未能', 'not', 'cannot', 'unproven']) {
    const diagnostics = [], text = `${phrase}证明RSPO1 抑制了脂肪细胞的分化`;
    checkDraft({ output: { answer: text + '[@e1]', statements: [{ text, evidence_ids: ['e1'], strength: '观察', attribution: '单篇发现' }] }, evidenceRecords: [{ evidence_id: 'e1', strength: '观察', forbidden_statement: 'RSPO1 抑制脂肪细胞分化', citations: [cite(a)] }], diagnostics });
    assert.equal(diagnostics.filter(row => row.code === 'WQ_FORBIDDEN_STATEMENT_SIMILAR').length, 0, phrase);
  }
  const text = '尚未证明RSPO1 抑制脂肪细胞分化';
  const issues = checkDraft({ output: { answer: text + '[@e1]', statements: [{ text, evidence_ids: ['e1'], strength: '观察', attribution: '单篇发现' }] }, evidenceRecords: [{ evidence_id: 'e1', strength: '观察', forbidden_statement: 'RSPO1 抑制脂肪细胞分化', citations: [cite(a)] }] });
  assert.ok(codes(issues).includes('WQ_FORBIDDEN_STATEMENT'));
});
