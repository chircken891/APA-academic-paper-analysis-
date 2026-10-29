import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOwnedArtifactBroker, commitOwnedArtifact } from '../../../scripts/v3/owned-artifact-store.mjs';
import { readCommittedReadingFirstKnowledgeRegistry } from '../../../scripts/v3/reading-first-knowledge-registry.mjs';
import {
  acceptReadingFirstResult, buildReadingFirstHandoff, createReadingFirstDraftRequests,
  createReadingFirstPresentationRequest, createReadingFirstRequests, createReadingFirstReviewRequest,
  createReadingFirstRunControl, fingerprintReadingFirst, renderReadingFirstNotes,
} from '../../../scripts/v3/reading-first-runtime.mjs';

const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const roles = ['evidence', 'methods', 'results', 'interpretation', 'scientific-reading', 'integration'];
const languages = ['en', 'zh-CN'];
const modules = ['abstract', 'design', 'methods', 'findings', 'discussion', 'limitations', 'conclusion'];
const titles = {
  en: ['Abstract', 'Study design', 'Methods', 'Findings', 'Discussion', 'Limitations', 'Conclusion'],
  'zh-CN': ['摘要', '研究设计', '方法', '主要发现', '讨论', '局限', '结论'],
};

/** Synthetic owned artifacts and host observations; never dispatches a real model. */
export async function reviewedReadingFirstFixture(t, options = {}) {
  const root = options.artifactRoot ?? await mkdtemp(join(tmpdir(), 'apa-rf-publication-'));
  if (!options.artifactRoot) t.after(() => rm(root, { recursive: true, force: true }));
  const runId = options.runId ?? 'run_' + 'a'.repeat(32);
  const paperId = options.paperId ?? 'pap_' + 'a'.repeat(32);
  await mkdir(root, { recursive: true });
  const pdf = Buffer.from(options.sourceText ?? 'Synthetic original source: supported design, finding and limitation.');
  const image = Buffer.from('Synthetic registered figure bytes.');
  await writeFile(join(root, 'source.pdf'), pdf);
  await writeFile(join(root, 'figure.png'), image);
  const source = { id: 'paper', path: join(root, 'source.pdf'), sha256: sha(pdf), byte_length: pdf.length };
  const figure = { path: join(root, 'figure.png'), sha256: sha(image), byte_length: image.length };
  const presentation = options.presentation ?? {
    schema_version: 'reading-first-obsidian-1.0', layout: 'writer-modules-1.0',
    knowledge_layout: 'shared-bilingual-1.0',
    bibliography: { title: options.title ?? { en: 'Synthetic publication study', 'zh-CN': '合成发布研究' }, first_author: 'Tester', year: 2026 },
    modules: modules.map((id, index) => ({ id, label: Object.fromEntries(languages.map(language => [language, titles[language][index]])) })),
    source_pdf: 'Raw/' + paperId + '.pdf',
    visuals: [{ id: 'fig-one', kind: 'figure', label: { en: 'Figure one', 'zh-CN': '图一' }, caption: { en: 'Complete original caption.', 'zh-CN': '完整原始图注。' }, path: 'Figures/' + paperId + '/figure.png', page: 1 }],
    knowledge: [{ id: 'method', canonical_key: 'synthetic-method', kind: 'method', source_kind: 'method-background', title: { en: 'Synthetic method', 'zh-CN': '合成方法' }, aliases: ['SyntheticMethodAlias'], paragraphs: { en: ['An independent reusable explanation with supportonlytoken.'], 'zh-CN': ['可独立理解的通用解释，包含仅知识页词。'] } }],
    map: { steps: [{ id: 'design-step', section_id: 'design', label: { en: 'Design', 'zh-CN': '设计' } }], findings: [{ id: 'main-finding', section_id: 'findings', label: { en: 'Finding', 'zh-CN': '发现' } }], relations: [{ step_id: 'design-step', finding_id: 'main-finding' }] },
  };
  if (options.visualProvenance) Object.assign(presentation.visuals[0], {
    source_id: source.id, source_path: presentation.source_pdf, source_sha256: source.sha256,
    sha256: figure.sha256, byte_length: figure.byte_length,
  });
  // A configured run (createRunControl) translates the non-source language; its tasks declare the translation role. options.translationLanguage overrides this (null for none).
  const sourceLanguage = options.sourceLanguage ?? options.controlOptions?.sourceLanguage ?? 'en';
  const translationLanguage = options.translationLanguage !== undefined ? options.translationLanguage : options.createRunControl ? (sourceLanguage === 'en' ? 'zh-CN' : 'en') : null;
  const tasks = Object.fromEntries(['en', 'zh-CN', 'presentation', 'review', 'en-r2', 'zh-CN-r2', 'presentation-r2', 'review-r2'].map(key => [key, {
    task_id: key, task_name: 'publication_' + key.replaceAll('-', '_').toLowerCase(), owner_actor_id: key,
    role: key.startsWith('presentation') ? 'reading-editor' : translationLanguage && key.startsWith(translationLanguage === 'en' ? 'en' : 'zh') ? 'translation' : key.startsWith('en') ? 'english-writer' : key.startsWith('zh') ? 'chinese-writer' : 'independent-verifier',
    artifact_id: key, artifact_path: 'accepted/' + key + '.json', native_path: 'native/' + key + '.json', revision: '1',
    ...(options.instructionFiles ? { instruction_path: 'instructions/' + key + '.txt' } : {}),
  }]));
  const input = {
    identity: { paper_id: paperId, run_id: runId, ...(options.analysisRevision ? { analysis_revision: options.analysisRevision } : {}) },
    sources: [source], ...(options.omitPresentationAssets ? {} : { presentation_assets: [figure] }),
    context: 'Explain the registered source as one connected scientific account.', role_artifacts: roles,
  };
  const runBinding = (options.createRunControl ?? createReadingFirstRunControl)({ runId, scientificInput: input, mainSession: { model: 'gpt-6-astra', reasoning_effort: 'high' },
    authorizationId: 'synthetic-publication-source-only', deadline: options.deadline ?? '2099-01-01T00:00:00Z', maxCalls: 7,
    writingMode: 'source-first', sourceLanguage: 'en', presentationMode: 'reading-editor', taskBindings: tasks, ...options.controlOptions });
  const binding = runBinding.reading_first_binding;
  const authorizedBindings = [
    ...roles.map(role => ({ run_id: runId, actor_id: role, role, artifact_path: 'science/' + role + '.json', revision: '1' })),
    ...Object.values(tasks).map(task => ({ run_id: runId, actor_id: task.owner_actor_id, role: task.role, artifact_path: task.artifact_path, revision: task.revision })),
    { run_id: runId, actor_id: 'controller', role: 'control', artifact_path: 'checkpoint.json', revision: '1' },
  ];
  const broker = createOwnedArtifactBroker({ control_actor_id: 'controller', artifact_root: root,
    authorized_bindings: authorizedBindings, run_controls: [{ run_id: runId, reading_first_binding: binding }] });
  for (const role of roles) await commitOwnedArtifact({ artifactRoot: root, dispatchContext: broker.dispatchContext,
    capability: broker.issueCapability({ runId, actorId: role, role, artifactPath: 'science/' + role + '.json', revision: '1' }),
    artifact: { artifact_id: role, content: JSON.stringify({ context: 'Registered synthetic scientific output for ' + role, ...(role === 'integration' ? { presentation } : {}) }) }, expectedRevision: '1' });
  const scientificInput = { ...input, profile: 'reading-first-1.0' };
  const handoff = await buildReadingFirstHandoff({ run: { run_id: runId }, dispatchContext: broker.dispatchContext, artifactRoot: root, scientificInput });
  const runControl = { runId, artifactRoot: root, dispatchContext: broker.dispatchContext };
  const created = createReadingFirstRequests({ handoff, runControl });
  assert.equal(created.ok, true, JSON.stringify(created.errors));
  const controller = created.controller;
  const complete = async (request, value) => {
    await mkdir(join(root, 'native'), { recursive: true });
    await writeFile(join(root, request.task.native_path), JSON.stringify(value));
    const step = request.emittedStep;
    return acceptReadingFirstResult({ controller, request, observation: {
      action_id: step.action_id, run_id: runId, input_fingerprint: step.input_fingerprint, port: 'current-collaboration',
      tool_call: { name: step.action, arguments: step.arguments }, raw_result_text: JSON.stringify({ agent_id: 'synthetic-' + request.task.task_id }),
    }, capability: broker.issueCapability({ runId, actorId: request.task.owner_actor_id, role: request.task.role, artifactPath: request.task.artifact_path, revision: request.task.revision }) });
  };
  const views = languages.map(language => ({ language,
    sections: modules.map((id, index) => ({ id, module_id: id, heading: titles[language][index], paragraphs: [options.findingText ?? (language === 'en' ? 'The supported ' + id + ' explains the synthetic result and its limits.' : '有依据的' + titles[language][index] + '说明合成研究结果及其限制。')] })),
    placements: { visuals: [{ id: 'fig-one', section_id: 'findings', after_paragraph: 0 }], knowledge: [{ id: 'method', section_id: 'methods', after_paragraph: 0 }] },
  }));
  for (const request of created.requests) await complete(request, views.find(view => view.language === request.language));
  for (const request of createReadingFirstDraftRequests({ controller })) await complete(request, views.find(view => view.language === request.language));
  const editor = { schema_version: binding.presentation_profile ?? 'reading-editor-1.0', views_fingerprint: fingerprintReadingFirst(views), map: { nodes: [...(presentation.map?.steps ?? []).map(node => ({ id: node.id, stage: 'design' })), ...(presentation.map?.findings ?? []).map(node => ({ id: node.id, stage: 'finding', primary: true }))] }, languages: Object.fromEntries(languages.map(language => [language, {
    overview: [{ text: language === 'en' ? 'Supported finding and its limits.' : '有依据的发现及其限制。', section_ids: ['findings'] }], sections: [],
    methods: [{ id: 'method', knowledge_id: 'method', title: language === 'en' ? 'Method' : '方法', explanation: language === 'en' ? 'A known method.' : '已知方法。', application: language === 'en' ? 'Used in the study.' : '用于本研究。', section_ids: ['methods'] }],
    visuals: [],
  }])) };
  if (binding.presentation_mode === 'reading-editor') await complete(createReadingFirstPresentationRequest({ controller }), editor);
  const knowledgeRegistry = binding.configured_setup?.knowledge_registry
    ? await readCommittedReadingFirstKnowledgeRegistry({ vaultRoot: binding.configured_setup.knowledge_registry.vault_root })
    : options.knowledgeRegistry ?? [];
  if (binding.configured_setup?.knowledge_registry && options.knowledgeRegistry !== undefined) {
    const supplied = options.knowledgeRegistry, byPath = new Map(knowledgeRegistry.map(row => [row.path, row]));
    assert.ok(Array.isArray(supplied) && new Set(supplied.map(row => row?.path)).size === supplied.length
      && supplied.every(row => byPath.has(row?.path) && fingerprintReadingFirst(row) === fingerprintReadingFirst(byPath.get(row.path))));
  }
  const renderOptions = { ...(options.targetRegistry ? { targetRegistry: options.targetRegistry } : {}), existingTargets: options.existingTargets ?? [], knowledgeRegistry };
  const candidate = renderReadingFirstNotes({ controller, ...renderOptions });
  const reviewRequest = createReadingFirstReviewRequest({ controller, presentation: candidate });
  const review = options.review ?? { overall: { complete: true, coherent: true, bilingual_consistent: true }, key_nodes: [
    { kind: 'main_conclusion', location: 'findings', finding: 'The supported main conclusion and its limitation are explained.' },
    { kind: 'key_design', location: 'design', finding: 'The key design is explained.' },
  ], issues: [], scope: 'Synthetic overall review of the exact complete bilingual candidate.' };
  const acceptedReview = options.completeReview === false ? null : await complete(reviewRequest, review);
  const resources = [
    { path: presentation.source_pdf, source_path: source.path, sha256: source.sha256, byte_length: source.byte_length },
    { path: presentation.visuals[0].path, source_path: figure.path, sha256: figure.sha256, byte_length: figure.byte_length },
  ];
  return { root, artifactRoot: root, runId, paperId, input: scientificInput, broker, binding, handoff, runControl, controller, created,
    candidate, presentation: candidate, presentationCatalog: presentation, renderOptions, views, editor, review, reviewRequest,
    reviewReceipt: acceptedReview?.receipt, resources, source, figure, complete, readNative: request => readFile(join(root, request.task.native_path)) };
}
