import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildConfiguredReadingInstructions } from '../../../scripts/v3/configured-reading.mjs';
import { createOwnedArtifactBroker, commitOwnedArtifact } from '../../../scripts/v3/owned-artifact-store.mjs';
import { readCommittedReadingFirstKnowledgeRegistry } from '../../../scripts/v3/reading-first-knowledge-registry.mjs';
import { compactionEnabled, compactionControlBindings } from '../../../scripts/v3/reading-compaction.mjs';
import {
  acceptReadingFirstResult, buildReadingFirstHandoff, createReadingFirstDraftRequests,
  createReadingFirstPresentationRequest, createReadingFirstRequests, createReadingFirstReviewRequest,
  createReadingFirstRunControl, fingerprintReadingFirst, renderReadingFirstNotes,
  snapshotReadingFirstRuntime, handleReadingCompactionBoundary,
  recordReadingFirstRequestEvent,
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
  let pdf = Buffer.from(options.sourceText ?? 'Synthetic original source: supported design, finding and limitation.');
  let image = Buffer.from('Synthetic registered figure bytes.');
  await writeFile(join(root, 'source.pdf'), pdf);
  await writeFile(join(root, 'figure.png'), image);
  const registeredDocx = options.visualProvenance === 'owned-registered-docx' || options.manifestDocx;
  let supplementBytes = Buffer.from('Synthetic original DOCX with a registered supplementary figure.');
  if (options.manifestDocx) {
    const script = `import sys,fitz,zipfile,base64
d=fitz.open(); d.new_page(); d.save(sys.argv[1])
with zipfile.ZipFile(sys.argv[2],'w') as z:
 z.writestr('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
 z.writestr('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
 z.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:v="urn:schemas-microsoft-com:vml"><w:body><w:p><w:r><w:t>Figure S4</w:t></w:r></w:p><w:p><w:r><w:pict><v:shape><v:imagedata r:id="rId1"/></v:shape></w:pict></w:r></w:p></w:body></w:document>')
 z.writestr('word/_rels/document.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>')
 z.writestr('word/media/image1.png',base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aX8AAAAASUVORK5CYII='))`;
    const result = spawnSync('python', ['-c', script, join(root,'source.pdf'), join(root,'supplement.docx')], {encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    pdf=await readFile(join(root,'source.pdf')); supplementBytes=await readFile(join(root,'supplement.docx'));
  }
  const source = { id: 'paper', path: join(root, 'source.pdf'), sha256: sha(pdf), byte_length: pdf.length };
  let figure = { path: join(root, 'figure.png'), sha256: sha(image), byte_length: image.length };
  const displayBytes = Buffer.from('Synthetic supplementary figure display PDF.');
  const supplement = { id: 'supplement', path: join(root, 'supplement.docx'), sha256: sha(supplementBytes), byte_length: supplementBytes.length };
  const display = { path: join(root, 'display.pdf'), sha256: sha(displayBytes), byte_length: displayBytes.length };
  if (registeredDocx) {
    if (!options.manifestDocx) await writeFile(supplement.path, supplementBytes);
    await writeFile(display.path, displayBytes);
  }
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
  let manifestRef, manifestBytes;
  const manifestTask={task_id:'results-resources',artifact_id:'results-resources',artifact_path:'science/results-resources.json',native_path:'native/results-resources.json',revision:'1',owner_actor_id:'results',role:'results'};
  if (options.manifestDocx) {
    const resourceRoot=join(root,'resources','results'); await mkdir(resourceRoot,{recursive:true});
    const request={source_id:supplement.id,source_path:supplement.path,resources_root:resourceRoot,items:[{id:'fig-one',locator:{kind:'docx-figure',figure:'S4',paragraph:1},media:'word/media/image1.png',filename:'figure.png',path:presentation.visuals[0].path}]};
    const result=spawnSync('python',[fileURLToPath(new URL('../../../scripts/lib/reading-resource-tool.py',import.meta.url))],{input:JSON.stringify(request),encoding:'utf8'});
    assert.equal(result.status,0,result.stderr); manifestBytes=Buffer.from(result.stdout.trim());
    const row=JSON.parse(manifestBytes).resources[0]; image=await readFile(row.source_path); figure={path:row.source_path,sha256:row.sha256,byte_length:row.byte_length};
    manifestRef={path:join(root,manifestTask.artifact_path),resources_root:resourceRoot,sha256:sha(manifestBytes),byte_length:manifestBytes.length};
    presentation.sources=[{id:source.id,path:presentation.source_pdf,kind:'main'},{id:supplement.id,path:'Raw/supplement.docx',kind:'supplementary'}];
    Object.assign(presentation.visuals[0],{source_id:supplement.id,locator:row.locator}); delete presentation.visuals[0].page;
  }
  const ownedVisualResources = ['owned-absolute', 'owned-asset-mapping', 'owned-registered-pdf', 'owned-registered-docx'].includes(options.visualProvenance) ? [{
    path: presentation.visuals[0].path, source_id: source.id, source_path: source.path, source_sha256: source.sha256,
    sha256: figure.sha256, byte_length: figure.byte_length,
  }] : null;
  if (ownedVisualResources) {
    presentation.sources = [{ id: source.id, path: presentation.source_pdf, kind: 'main' }];
    presentation.visuals[0].source_id = source.id;
    if (registeredDocx) {
      presentation.sources.push({ id: supplement.id, path: 'Raw/supplement-display.pdf', kind: 'supplementary' });
      presentation.visuals[0].source_id = supplement.id;
    }
  } else if (options.visualProvenance) Object.assign(presentation.visuals[0], {
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
    sources: [source, ...(registeredDocx ? [supplement] : [])],
    presentation_assets: [...(options.omitPresentationAssets || options.manifestDocx ? [] : [figure]), ...(registeredDocx && !options.manifestDocx && !options.unregisteredDisplay ? [display] : [])],
    context: 'Explain the registered source as one connected scientific account.', role_artifacts: roles,
  };
  const runBinding = (options.createRunControl ?? createReadingFirstRunControl)({ runId, scientificInput: input, mainSession: { model: 'gpt-6-astra', reasoning_effort: 'high' },
    authorizationId: 'synthetic-publication-source-only', deadline: options.deadline ?? '2099-01-01T00:00:00Z', maxCalls: 7,
    writingMode: 'source-first', sourceLanguage: 'en', presentationMode: 'reading-editor', taskBindings: tasks, ...options.controlOptions,
    ...(options.manifestDocx ? {maxTotalCalls:20,presentationProfile:'reading-editor-1.3',configuredSetup:{...buildConfiguredReadingInstructions({}, {instructionProfile:'configured-reading-2.2'}),paths:{runRoot:root},results_resources:{output_root:'resources/results',manifest_task:manifestTask}}} : {}),
    ...(options.currentRegistryRoot ? { configuredSetup: { paths: { runRoot: root }, writing_instructions: { en: '', 'zh-CN': '' },
      knowledge_registry: { policy: 'current-shared-nodes-1.0', vault_root: options.currentRegistryRoot } } } : {}) });
  const binding = runBinding.reading_first_binding;
  const authorizedBindings = [
    ...compactionControlBindings(runBinding),
    ...roles.map(role => ({ run_id: runId, actor_id: role, role, artifact_path: 'science/' + role + '.json', revision: '1' })),
    ...Object.values(tasks).map(task => ({ run_id: runId, actor_id: task.owner_actor_id, role: task.role, artifact_path: task.artifact_path, revision: task.revision })),
    ...(options.manifestDocx ? [{run_id:runId,actor_id:'results',role:'results',artifact_path:manifestTask.artifact_path,revision:'1'}] : []),
    { run_id: runId, actor_id: 'controller', role: 'control', artifact_path: 'checkpoint.json', revision: '1' },
    ...['before-writer', 'before-review'].map(id => ({ run_id: runId, actor_id: 'controller', role: 'control', artifact_path: 'control/check-' + id + '.json', revision: '1' })),
  ];
  const broker = createOwnedArtifactBroker({ control_actor_id: 'controller', artifact_root: root,
    authorized_bindings: authorizedBindings, run_controls: [{ run_id: runId, reading_first_binding: binding }] });
  const assetMapping = options.visualProvenance === 'owned-asset-mapping' ? ownedVisualResources.map(row => ({
    id: presentation.visuals[0].id, target_path: row.path, source_id: row.source_id,
    source_path: figure.path, source_pdf_sha256: row.source_sha256, sha256: row.sha256, byte_length: row.byte_length,
  })) : null;
  const registeredResources = ['owned-registered-pdf', 'owned-registered-docx'].includes(options.visualProvenance) ? [{
    id: presentation.visuals[0].id, path: presentation.visuals[0].path, source_path: figure.path,
    sha256: figure.sha256, byte_length: figure.byte_length,
    ...(registeredDocx ? { source_id: supplement.id, source_docx: supplement.path, source_docx_sha256: supplement.sha256.slice(7) }
      : { source_pdf: source.path, source_sha256: source.sha256.slice(7) }),
  }] : null;
  const ownedRegistration = options.manifestDocx ? {visual_handoff:{resource_manifest:manifestRef}} : registeredResources ? { visual_handoff: { registered_resources: options.registeredResourcesChange ? options.registeredResourcesChange(registeredResources) : registeredResources } }
    : assetMapping ? { resource_handoff: { asset_mapping: options.assetMappingChange ? options.assetMappingChange(assetMapping) : assetMapping } }
    : ownedVisualResources ? { visual_resources: ownedVisualResources } : {};
  if (options.manifestDocx) await commitOwnedArtifact({artifactRoot:root,dispatchContext:broker.dispatchContext,capability:broker.issueCapability({runId,actorId:'results',role:'results',artifactPath:manifestTask.artifact_path,revision:'1'}),artifact:{artifact_id:manifestTask.artifact_id,content:manifestBytes},expectedRevision:'1'});
  for (const role of roles) await commitOwnedArtifact({ artifactRoot: root, dispatchContext: broker.dispatchContext,
    capability: broker.issueCapability({ runId, actorId: role, role, artifactPath: 'science/' + role + '.json', revision: '1' }),
    artifact: { artifact_id: role, content: JSON.stringify({ context: 'Registered synthetic scientific output for ' + role,
      ...(role === 'integration' ? { presentation, ...ownedRegistration } : {}) }) }, expectedRevision: '1' });
  const scientificInput = { ...input, profile: 'reading-first-1.0' };
  const handoff = await buildReadingFirstHandoff({ run: { run_id: runId }, dispatchContext: broker.dispatchContext, artifactRoot: root, scientificInput });
  const runControl = { runId, artifactRoot: root, dispatchContext: broker.dispatchContext };
  const created = createReadingFirstRequests({ handoff, runControl, ...(options.manifestDocx ? {executionLedger:[]} : {}) });
  assert.equal(created.ok, true, JSON.stringify(created.errors));
  const controller = created.controller;
  const settleCompaction = async (id, candidate) => {
    if (!compactionEnabled(binding)) return;
    const snapshot = snapshotReadingFirstRuntime(controller);
    const receipt = await commitOwnedArtifact({ artifactRoot: root, dispatchContext: broker.dispatchContext,
      capability: broker.issueCapability({ runId, actorId: 'controller', role: 'control', artifactPath: 'control/check-' + id + '.json', revision: '1' }),
      artifact: { artifact_id: 'check-' + id, content: JSON.stringify(snapshot) }, expectedRevision: '1' });
    const task = binding.compaction_policy.checkpoints[id].decision;
    const result = await handleReadingCompactionBoundary({ controller, checkpointReceipt: receipt, presentation: candidate,
      hostRequests: snapshot.state.request_entries.filter(entry => !entry.consumed).map(entry => ({ action_id: entry.request.emittedStep.action_id, status: 'prepared' })),
      observation: { manual_compaction: { available: false, source: 'Synthetic host has no manual compaction.' } },
      capability: broker.issueCapability({ runId, actorId: 'controller', role: 'control', artifactPath: task.artifact_path, revision: task.revision }) });
    if (result.action === 'await-user') {
      const resume = binding.compaction_policy.checkpoints[id].resume;
      const continued = await handleReadingCompactionBoundary({ controller, checkpointReceipt: result.receipt, presentation: candidate,
        hostRequests: snapshot.state.request_entries.filter(entry => !entry.consumed).map(entry => ({ action_id: entry.request.emittedStep.action_id, status: 'prepared' })),
        userDecision: 'skip', capability: broker.issueCapability({ runId, actorId: 'controller', role: 'control', artifactPath: resume.artifact_path, revision: resume.revision }) });
      assert.equal(continued.action, 'continue');
      assert.equal(continued.record.reason, 'user-skipped');
    } else assert.equal(result.action, 'continue');
  };
  await settleCompaction('before-writer');
  const complete = async (request, value) => {
    await mkdir(join(root, 'native'), { recursive: true });
    await writeFile(join(root, request.task.native_path), JSON.stringify(value));
    const step = request.emittedStep;
    const raw=JSON.stringify({ agent_id: 'synthetic-' + request.task.task_id });
    const observation={
      action_id: step.action_id, run_id: runId, input_fingerprint: step.input_fingerprint, port: 'current-collaboration',
      tool_call: { name: step.action, arguments: step.arguments }, raw_result_text: raw,
    };
    if (options.manifestDocx) {
      const evidencePath=join(root,'native','evidence-'+request.task.task_id+'.txt'); await writeFile(evidencePath,raw);
      observation.evidence={kind:'raw',capture:'direct',sha256:sha(Buffer.from(raw)).slice(7),source_reference:evidencePath};
      recordReadingFirstRequestEvent({controller,request,eventKey:'intent',payload:{action_id:step.action_id}});
      recordReadingFirstRequestEvent({controller,request,eventKey:'host_observation',payload:observation});
    }
    return acceptReadingFirstResult({ controller, request, observation, capability: broker.issueCapability({ runId, actorId: request.task.owner_actor_id, role: request.task.role, artifactPath: request.task.artifact_path, revision: request.task.revision }) });
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
    ? await readCommittedReadingFirstKnowledgeRegistry({ vaultRoot: binding.configured_setup.knowledge_registry.vault_root, policy: binding.configured_setup.knowledge_registry.policy })
    : options.knowledgeRegistry ?? [];
  if (binding.configured_setup?.knowledge_registry && options.knowledgeRegistry !== undefined) {
    const supplied = options.knowledgeRegistry, byPath = new Map(knowledgeRegistry.map(row => [row.path, row]));
    assert.ok(Array.isArray(supplied) && new Set(supplied.map(row => row?.path)).size === supplied.length
      && supplied.every(row => byPath.has(row?.path) && fingerprintReadingFirst(row) === fingerprintReadingFirst(byPath.get(row.path))));
  }
  const renderOptions = { ...(options.targetRegistry ? { targetRegistry: options.targetRegistry } : {}), existingTargets: options.existingTargets ?? [], knowledgeRegistry };
  const candidate = renderReadingFirstNotes({ controller, ...renderOptions });
  const reviewRequest = createReadingFirstReviewRequest({ controller, presentation: candidate });
  await settleCompaction('before-review', candidate);
  const review = options.review ?? { overall: { complete: true, coherent: true, bilingual_consistent: true }, key_nodes: [
    { kind: 'main_conclusion', location: 'findings', finding: 'The supported main conclusion and its limitation are explained.' },
    { kind: 'key_design', location: 'design', finding: 'The key design is explained.' },
  ], issues: [], scope: 'Synthetic overall review of the exact complete bilingual candidate.' };
  const acceptedReview = options.completeReview === false ? null : await complete(reviewRequest, review);
  const resources = [
    { path: presentation.source_pdf, source_path: source.path, sha256: source.sha256, byte_length: source.byte_length },
    { path: presentation.visuals[0].path, source_path: figure.path, sha256: figure.sha256, byte_length: figure.byte_length },
    ...(registeredDocx ? [
      { path: 'Raw/supplement.docx', source_path: supplement.path, sha256: supplement.sha256, byte_length: supplement.byte_length },
      ...(!options.manifestDocx ? [{ path: 'Raw/supplement-display.pdf', source_path: display.path, sha256: display.sha256, byte_length: display.byte_length }] : []),
    ] : []),
  ];
  return { root, artifactRoot: root, runId, paperId, input: scientificInput, broker, binding, handoff, runControl, controller, created,
    candidate, presentation: candidate, presentationCatalog: presentation, renderOptions, views, editor, review, reviewRequest,
    reviewReceipt: acceptedReview?.receipt, resources, source, figure, complete, readNative: request => readFile(join(root, request.task.native_path)) };
}
