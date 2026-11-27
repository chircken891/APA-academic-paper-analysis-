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
import {
  acceptReadingFirstResult, buildReadingFirstHandoff, createReadingFirstDraftRequests,
  createReadingFirstPresentationRequest, createReadingFirstRequests, createReadingFirstReviewRequest,
  createReadingFirstRunControl, fingerprintReadingFirst, renderReadingFirstNotes,
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
const cutoffLocator = { source_id: 'paper', locator: { kind: 'pdf-page', page: 1 } };
const cutoffProse = {
  en: {
    design: 'The researchers fixed a decision rule on validation data and evaluated it in a separate cohort.',
    methods: 'In each of two validation folds the researchers selected the median score among participants without the outcome. They averaged the fold thresholds of 4 and 8 to obtain a fixed threshold of 6. [Source](apa-source:paper#page=1)',
    'held-out-test': 'The researchers marked everyone with a score of 6 or above as positive in the independent cohort. They held the threshold fixed while counting how many participants with the outcome screened positive. [Source](apa-source:paper#page=1)',
    findings: 'Using the fixed threshold, the rule marked 8 of 10 participants with the outcome as positive in the independent cohort. [Source](apa-source:paper#page=1)',
  },
  'zh-CN': {
    design: '研究者用验证数据确定固定的判定规则，然后在独立队列中评估。',
    methods: '研究者在两个验证折中分别取无结局参与者的评分中位数，再对两折得到的阈值 4 和 8 取平均，得到固定阈值 6。[原文](apa-source:paper#page=1)',
    'held-out-test': '研究者将独立队列中评分至少为 6 的参与者判为阳性。在计数有结局参与者中筛查为阳性的人数时，研究者保持阈值不变。[原文](apa-source:paper#page=1)',
    findings: '使用固定阈值后，独立队列有结局的 10 名参与者中，有 8 人被判为阳性。[原文](apa-source:paper#page=1)',
  },
};
const cutoffSteps = [
  { step_id: 'select-threshold', purpose: 'Fix the decision rule before testing.', input: 'Outcome-negative participants in two validation folds.',
    operation: 'Take the median in each fold and average the fold thresholds.', key_choices: ['Fold thresholds of 4 and 8.'],
    output: 'Fixed threshold of 6.', next_use: 'Transfer the fixed threshold to the independent test.', sources: [cutoffLocator] },
  { step_id: 'external-test', purpose: 'Evaluate the fixed rule in an independent cohort.', input: 'Test cohort scores and threshold 6.',
    operation: 'Classify scores at least 6 as positive and count the positives among participants with the outcome.', key_choices: ['Keep the threshold fixed.'],
    output: '8 of 10 participants with the outcome screened positive.', next_use: 'Report held-out performance.', sources: [cutoffLocator] },
];

export function syntheticReadingMapArgument({ sectionId, findingIds = [] }) {
  const claims = [
    ['design', 'The design addresses the study question.', '设计针对研究问题。'],
    ['measurements', 'Measurements support the comparison.', '测量支持比较。'],
    ['results', 'The comparison supports a qualified finding.', '比较支持带有限定的发现。'],
    ['limits', 'The finding applies within the study scope.', '发现适用于研究范围。'],
  ].map(([id, en, zh], index) => ({
    id, title: { en, 'zh-CN': zh },
    evidence: { en: 'See the accepted explanation.', 'zh-CN': '见已接受的正文。' },
    limit: { en: '', 'zh-CN': '' },
    section_id: sectionId, branch_id: 'main', finding_ids: findingIds.filter((_, i) => i % 4 === index),
  }));
  const ids = ['question', ...claims.map(claim => claim.id), 'conclusion'];
  return {
    argument: {
      question: { text: { en: 'What does the design establish?', 'zh-CN': '研究设计说明了什么？' }, section_id: sectionId },
      claims,
      branches: [{ id: 'main', name: { en: 'Main evidence', 'zh-CN': '主要证据' } }],
      relations: ids.slice(1).map((to, i) => ({ from: ids[i], to, label: '证据补充' })),
      conclusion: { text: { en: 'The evidence supports a qualified result.', 'zh-CN': '证据支持带有限定的结果。' }, section_id: sectionId },
    },
    primary_finding_ids: findingIds,
  };
}

export function syntheticThresholdStages(argument, map) {
  const [threshold, test] = map.steps;
  if (!threshold) return { stages: [], transitions: [], step_text: {}, finding_text: {} };
  const localized = (en, zh) => ({ en, 'zh-CN': zh });
  return {
    stages: [
      { id: 'validation', title: localized('Validation folds', '验证折'),
        entry: localized('Fix a threshold without consulting the test data.', '预先固定阈值，留出测试数据。'),
        step_ids: [threshold.id], claim_ids: [] },
      { id: 'independent-test', title: localized('Independent test cohort', '独立测试队列'),
        entry: localized('Evaluate the fixed decision rule on new participants.', '用新入组者检验固定判定规则。'),
        step_ids: [test.id], claim_ids: argument.claims.map(row => row.id) },
    ],
    transitions: [{ from: 'validation', to: 'independent-test',
      label: localized('Carry the fixed threshold into the held-out cohort without refitting.',
        '将固定阈值带入留出队列，沿用原阈值。') }],
    step_text: {
      [threshold.id]: localized('Average the thresholds selected on the validation folds.', '对验证折选出的阈值取平均。'),
      [test.id]: localized('Apply the fixed cutoff to held-out scores and compare with reference labels.', '用固定阈值判定留出集评分，再与参照标签比较。'),
    },
    finding_text: Object.fromEntries(map.findings.map(row => [row.id,
      localized('Compare test-set classifications to the observed outcomes.', '比较测试集判定与观察到的结局。')])),
  };
}

/** Synthetic owned artifacts and host observations; never dispatches a real model. */
export async function reviewedReadingFirstFixture(t, options = {}) {
  const adopted = options.adoptedFrom;
  const contentComplete = options.instructionProfile === 'configured-reading-2.4';
  const methodsFirst = options.methodsFirst === true || contentComplete;
  const commentary = methodsFirst && options.commentary === true;
  const root = options.artifactRoot ?? await mkdtemp(join(tmpdir(), 'apa-rf-publication-'));
  if (!options.artifactRoot) t.after(() => rm(root, { recursive: true, force: true }));
  const runId = options.runId ?? 'run_' + 'a'.repeat(32);
  const paperId = options.paperId ?? 'pap_' + 'a'.repeat(32);
  await mkdir(root, { recursive: true });
  let pdf = Buffer.from(options.sourceText ?? (methodsFirst
    ? 'Synthetic p. 1. The medians of the outcome-negative scores in the two validation folds were 4 and 8. We averaged these medians to fix a threshold of 6. In an independent cohort we used this threshold without refitting. A score of 6 or above was positive and 8 of 10 participants with the outcome screened positive.'
    : 'Synthetic original source: supported design, finding and limitation.'));
  let image = Buffer.from('Synthetic registered figure bytes.');
  const sourcePath = options.clippingsRoot ? join(options.clippingsRoot, '原件 ' + runId + ' (主文).pdf') : join(root, 'source.pdf');
  if (options.clippingsRoot) await mkdir(options.clippingsRoot, { recursive: true });
  await writeFile(sourcePath, pdf);
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
    const result = spawnSync('python', ['-c', script, sourcePath, join(root,'supplement.docx')], {encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    pdf=await readFile(sourcePath); supplementBytes=await readFile(join(root,'supplement.docx'));
  }
  const source = { id: 'paper', path: sourcePath, sha256: sha(pdf), byte_length: pdf.length };
  let figure = { path: join(root, 'figure.png'), sha256: sha(image), byte_length: image.length };
  const displayBytes = Buffer.from('Synthetic supplementary figure display PDF.');
  const supplement = { id: 'supplement', path: join(root, 'supplement.docx'), sha256: sha(supplementBytes), byte_length: supplementBytes.length };
  const display = { path: join(root, 'display.pdf'), sha256: sha(displayBytes), byte_length: displayBytes.length };
  const displayTarget = options.displayTarget ?? 'Raw/supplement-display.pdf';
  if (registeredDocx) {
    if (!options.manifestDocx) await writeFile(supplement.path, supplementBytes);
    await writeFile(display.path, displayBytes);
  }
  const presentation = options.presentation ?? (adopted ? structuredClone(adopted.presentationCatalog) : undefined) ?? {
    schema_version: 'reading-first-obsidian-1.0', layout: 'writer-modules-1.0',
    knowledge_layout: 'shared-bilingual-1.0',
    bibliography: { title: options.title ?? { en: 'Synthetic publication study', 'zh-CN': '合成发布研究' }, first_author: 'Tester', year: 2026 },
    modules: modules.map((id, index) => ({ id, label: Object.fromEntries(languages.map(language => [language, titles[language][index]])) })),
    source_pdf: 'Raw/' + paperId + '.pdf',
    visuals: [{ id: 'fig-one', kind: 'figure', label: { en: 'Figure one', 'zh-CN': '图一' }, caption: { en: 'Complete original caption.', 'zh-CN': '完整原始图注。' }, path: options.figurePath ?? 'Figures/' + paperId + '/figure.png', page: 1 }],
    knowledge: [{ id: 'method', canonical_key: 'synthetic-method', kind: 'method', source_kind: 'method-background', title: { en: 'Synthetic method', 'zh-CN': '合成方法' }, aliases: options.knowledgeAliases ?? ['SyntheticMethodAlias'], paragraphs: { en: ['An independent reusable explanation with supportonlytoken.'], 'zh-CN': ['可独立理解的通用解释，包含仅知识页词。'] } }],
    map: { steps: [{ id: 'design-step', section_id: 'design', label: { en: 'Design', 'zh-CN': '设计' } }], findings: [{ id: 'main-finding', section_id: 'findings', label: { en: 'Finding', 'zh-CN': '发现' } }], relations: [{ step_id: 'design-step', finding_id: 'main-finding' }] },
  };
  if (methodsFirst) {
    const label = (en, zh) => ({ en, 'zh-CN': zh });
    presentation.sources ??= [{ id: 'paper', path: presentation.source_pdf, kind: 'main' }];
    presentation.sections = [...modules, 'held-out-test'].map(id => ({ id }));
    presentation.map.steps = [
      { id: 'select-threshold', section_id: 'methods', label: label('Select the threshold', '选择阈值') },
      { id: 'external-test', section_id: 'held-out-test', label: label('Independent test', '独立队列检验') },
    ];
    presentation.map.relations = [{ step_id: 'external-test', finding_id: 'main-finding' }];
    presentation.map.step_links = [{ from_step_id: 'select-threshold', to_step_id: 'external-test', label: label('Fixed threshold of 6', '固定阈值 6') }];
    if (commentary) {
      presentation.sections = modules.map(id => ({ id }));
      presentation.map = { steps: [], findings: [], relations: [], step_links: [] };
    }
  }
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
      presentation.sources.push({ id: supplement.id, path: displayTarget, kind: 'supplementary' });
      presentation.visuals[0].source_id = supplement.id;
    }
  } else if (options.visualProvenance) Object.assign(presentation.visuals[0], {
    source_id: source.id, source_path: presentation.source_pdf, source_sha256: source.sha256,
    sha256: figure.sha256, byte_length: figure.byte_length,
  });
  // A configured run (createRunControl) translates the non-source language; its tasks declare the translation role. options.translationLanguage overrides this (null for none).
  const sourceLanguage = options.sourceLanguage ?? options.controlOptions?.sourceLanguage ?? 'en';
  const translationLanguage = options.translationLanguage !== undefined ? options.translationLanguage : options.createRunControl || methodsFirst ? (sourceLanguage === 'en' ? 'zh-CN' : 'en') : null;
  const presentationMode = options.controlOptions?.presentationMode ?? 'reading-editor';
  const editorTask = presentationMode === 'reading-editor';
  const keys = ['en', 'zh-CN', ...(editorTask ? ['presentation'] : []), 'review', 'en-r2', 'zh-CN-r2', ...(editorTask ? ['presentation-r2'] : []), 'review-r2'];
  const tasks = Object.fromEntries(keys.map(key => [key, {
    task_id: key, task_name: 'publication_' + key.replaceAll('-', '_').toLowerCase(), owner_actor_id: key,
    role: key.startsWith('presentation') ? 'reading-editor' : translationLanguage && key.startsWith(translationLanguage === 'en' ? 'en' : 'zh') ? 'translation' : key.startsWith('en') ? 'english-writer' : key.startsWith('zh') ? 'chinese-writer' : 'independent-verifier',
    artifact_id: key, artifact_path: 'accepted/' + key + '.json', native_path: 'native/' + key + '.json', revision: '1',
    ...(options.instructionFiles ? { instruction_path: 'instructions/' + key + '.txt' } : {}),
    ...(translationLanguage && key.startsWith(translationLanguage === 'en' ? 'en' : 'zh') ? { source_view_path: 'translation/' + key + '/source.json', translation_context_path: 'translation/' + key + '/context.json', progress_path: 'translation/' + key + '/progress.json' } : {}),
  }]));
  const supplementPdf = options.clippingsRoot && options.supplementPdf ? {
    id: 'supplement-pdf', path: join(options.clippingsRoot, '补充材料 (附录).pdf'), bytes: Buffer.from('%PDF-1.7 synthetic supplement'),
  } : undefined;
  if (supplementPdf) {
    await writeFile(supplementPdf.path, supplementPdf.bytes);
    presentation.sources ??= [{ id: source.id, path: presentation.source_pdf, kind: 'main' }];
    presentation.sources.push({ id: supplementPdf.id, path: 'Raw/synthetic-supplement.pdf', kind: 'supplementary' });
    Object.assign(presentation.visuals[0], { source_id: supplementPdf.id, page: 2 });
  }
  let input = {
    identity: { paper_id: paperId, run_id: runId, ...(options.analysisRevision ? { analysis_revision: options.analysisRevision } : {}) },
    sources: adopted?.input.sources ?? [source, ...(registeredDocx ? [supplement] : []),
      ...(supplementPdf ? [{ id: supplementPdf.id, path: supplementPdf.path, sha256: sha(supplementPdf.bytes), byte_length: supplementPdf.bytes.length }] : [])],
    presentation_assets: adopted?.input.presentation_assets ?? [...(options.omitPresentationAssets || options.manifestDocx ? [] : [figure]), ...(registeredDocx && !options.manifestDocx && !options.unregisteredDisplay ? [display] : [])],
    context: 'Explain the registered source as one connected scientific account.', role_artifacts: adopted ? [] : roles,
    ...(adopted ? { presentation, adopted_science: adopted.handoff.science.map(({ receipt }) => ({
      artifact_root: adopted.root, artifact_id: receipt.artifact_id, receipt,
    })) } : {}),
  };
  const runBinding = (options.createRunControl ?? createReadingFirstRunControl)({ runId, scientificInput: input, mainSession: { model: 'gpt-6-astra', reasoning_effort: 'high' },
    authorizationId: 'synthetic-publication-source-only', deadline: options.deadline ?? '2099-01-01T00:00:00Z', maxCalls: editorTask ? 7 : 6,
    writingMode: 'source-first', sourceLanguage: 'en', presentationMode, taskBindings: tasks, ...options.controlOptions,
    ...(options.manifestDocx || adopted ? {maxTotalCalls:20,configuredSetup:{...buildConfiguredReadingInstructions({}, {instructionProfile:'configured-reading-2.2'}),paths:{runRoot:root},results_resources:{output_root:'resources/results',manifest_task:manifestTask}}} : {}),
    ...(options.currentRegistryRoot ? { maxTotalCalls: 20, configuredSetup: { ...buildConfiguredReadingInstructions({}, { instructionProfile: 'configured-reading-2.2' }), paths: { runRoot: root },
      knowledge_registry: { policy: 'current-shared-nodes-1.0', vault_root: options.currentRegistryRoot } } } : {}),
    ...(methodsFirst ? {
      sourceLanguage, writingMode: 'source-translation', maxTotalCalls: 20, presentationProfile: 'reading-editor-1.5',
      handoffProfile: contentComplete ? 'science-index-1.1' : 'science-index-1.0',
      configuredSetup: { ...buildConfiguredReadingInstructions({}, { instructionProfile: options.instructionProfile ?? 'configured-reading-2.3' }), paths: { runRoot: root },
        ...(options.currentRegistryRoot ? { knowledge_registry: { policy: 'current-shared-nodes-1.0', vault_root: options.currentRegistryRoot } } : {}) },
    } : {}),
  });
  const binding = runBinding.reading_first_binding;
  const sourceLocations = binding.configured_setup?.source_locations;
  const supplementTarget = sourceLocations?.find(row => row.source_id === supplement.id)?.vault_path ?? 'Raw/supplement.docx';
  if (sourceLocations) {
    const byId = new Map(sourceLocations.map(row => [row.source_id, row]));
    input = { ...input, sources: input.sources.map(row => ({ ...row, path: byId.get(row.id).path })) };
    source.path = byId.get(source.id).path;
    if (byId.has(supplement.id)) supplement.path = byId.get(supplement.id).path;
    const targetPaths = new Map([[presentation.source_pdf, byId.get(source.id).vault_path]]);
    presentation.source_pdf = byId.get(source.id).vault_path;
    for (const row of presentation.sources ?? []) {
      if (options.displayTarget && row.path === displayTarget) continue;
      targetPaths.set(row.path, byId.get(row.id).vault_path);
      row.path = byId.get(row.id).vault_path;
    }
    for (const visual of presentation.visuals) {
      if (visual.source_path !== undefined) visual.source_path = targetPaths.get(visual.source_path) ?? visual.source_path;
    }
    for (const row of ownedVisualResources ?? []) row.source_path = byId.get(row.source_id).path;
    if (manifestBytes) {
      const manifest = JSON.parse(manifestBytes);
      for (const row of manifest.resources) row.parent.path = byId.get(row.source_id).path;
      manifestBytes = Buffer.from(JSON.stringify(manifest));
      Object.assign(manifestRef, { sha256: sha(manifestBytes), byte_length: manifestBytes.length });
    }
  }
  const authorizedBindings = [
    ...roles.map(role => ({ run_id: runId, actor_id: role, role, artifact_path: 'science/' + role + '.json', revision: '1' })),
    ...Object.values(tasks).map(task => ({ run_id: runId, actor_id: task.owner_actor_id, role: task.role, artifact_path: task.artifact_path, revision: task.revision })),
    ...(options.manifestDocx ? [{run_id:runId,actor_id:'results',role:'results',artifact_path:manifestTask.artifact_path,revision:'1'}] : []),
    { run_id: runId, actor_id: 'controller', role: 'control', artifact_path: 'checkpoint.json', revision: '1' },
    ...(options.controlPaths ?? []).map(path => ({ run_id: runId, actor_id: 'controller', role: 'control', artifact_path: path, revision: '1' })),
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
  const resultModule = { id: 'held-out-performance', title: 'Held-out performance', question: 'Does the fixed rule retain sensitivity?', sources: [cutoffLocator],
    comparisons: [{ objects: ['Participants with the outcome'], conditions: ['Independent cohort; fixed threshold of 6'],
      observations: [{ statement: '8 of 10 participants screened positive.', direction: 'Positive classification in 8 of 10.', attribution: 'author_report', sources: [cutoffLocator] }] }],
    explanations: [{ statement: 'The fixed threshold separates validation and evaluation.', attribution: 'author_interpretation', sources: [cutoffLocator] }] };
  for (const role of input.role_artifacts) await commitOwnedArtifact({ artifactRoot: root, dispatchContext: broker.dispatchContext,
    capability: broker.issueCapability({ runId, actorId: role, role, artifactPath: 'science/' + role + '.json', revision: '1' }),
    artifact: { artifact_id: role, content: JSON.stringify({ context: 'Registered synthetic scientific output for ' + role,
      ...(contentComplete && ['results', 'interpretation', 'integration'].includes(role) ? { result_modules: [{ ...resultModule,
        ...(role === 'integration' ? { section_ids: ['findings'], upstream_refs: ['results', 'interpretation'].map(role => ({ role, module_id: resultModule.id })) } : {}) }] } : {}),
      ...(role === 'integration' ? { presentation, ...ownedRegistration, ...(methodsFirst ? { method_steps: commentary ? [] : cutoffSteps } : {}) } : {}) }) }, expectedRevision: '1' });
  const scientificInput = { ...input, profile: 'reading-first-1.0' };
  const handoff = await buildReadingFirstHandoff({ run: { run_id: runId }, dispatchContext: broker.dispatchContext, artifactRoot: root, scientificInput });
  const runControl = { runId, artifactRoot: root, dispatchContext: broker.dispatchContext };
  const created = createReadingFirstRequests({ handoff, runControl, ...(binding.configured_setup ? {executionLedger:[]} : {}) });
  assert.equal(created.ok, true, JSON.stringify(created.errors));
  const controller = created.controller;
  const complete = async (request, value) => {
    await mkdir(join(root, 'native'), { recursive: true });
    await writeFile(join(root, request.task.native_path), JSON.stringify(value));
    const step = request.emittedStep;
    const raw=JSON.stringify({ agent_id: 'synthetic-' + request.task.task_id });
    const observation={
      action_id: step.action_id, run_id: runId, input_fingerprint: step.input_fingerprint, port: 'current-collaboration',
      tool_call: { name: step.action, arguments: step.arguments }, raw_result_text: raw,
    };
    if (binding.configured_setup) {
      const evidencePath=join(root,'native','evidence-'+request.task.task_id+'.txt'); await writeFile(evidencePath,raw);
      observation.evidence={kind:'raw',capture:'direct',sha256:sha(Buffer.from(raw)).slice(7),source_reference:evidencePath};
      recordReadingFirstRequestEvent({controller,request,eventKey:'intent',payload:{action_id:step.action_id}});
      recordReadingFirstRequestEvent({controller,request,eventKey:'host_observation',payload:observation});
    }
    return acceptReadingFirstResult({ controller, request, observation, capability: () => broker.issueCapability({ runId, actorId: request.task.owner_actor_id, role: request.task.role, artifactPath: request.task.artifact_path, revision: request.task.revision }) });
  };
  const views = languages.map(language => ({ language,
    sections: modules.flatMap((id, index) => {
      const generic = language === 'en' ? 'The supported ' + id + ' explains the synthetic result and its limits.' : '有依据的' + titles[language][index] + '说明合成研究结果及其限制。';
      if (commentary) return [{ id, module_id: id, heading: titles[language][index], paragraphs: [language === 'en'
        ? 'The editorial makes a conceptual distinction between an algorithm and the way a particular article uses it. [Source](apa-source:paper#page=1)'
        : '这篇短评讨论算法与具体文章使用该算法的方式有何区别。[原文](apa-source:paper#page=1)'] }];
      const paragraph = methodsFirst ? cutoffProse[language][id] ?? generic : generic;
      const hiddenProcedure = methodsFirst && id === 'methods' && options.omitMethodProcedure;
      const paragraphs = [options.findingText ?? (hiddenProcedure ? (language === 'en' ? 'The researchers used a screening threshold.' : '研究者使用了筛查阈值。') : paragraph)];
      if (methodsFirst && id === 'findings') paragraphs.push(language === 'en' ? 'The denominator counts only participants with the outcome.' : '分母仅计入发生结局的参与者。');
      const body = { id, module_id: id, heading: titles[language][index], paragraphs };
      if (!methodsFirst || id !== 'methods') return [body];
      return [{ ...body, heading: language === 'en' ? 'Select the threshold' : '选择阈值' },
        { id: 'held-out-test', module_id: 'methods', heading: language === 'en' ? 'Test in an independent cohort' : '在独立队列中检验',
          paragraphs: [cutoffProse[language]['held-out-test']] }];
    }),
    placements: { visuals: [{ id: 'fig-one', section_id: 'findings', after_paragraph: 0 }],
      knowledge: (options.knowledgePlacementIds ?? ['method']).map(id => ({ id, section_id: 'methods', after_paragraph: 0 })) },
  }));
  for (const request of created.requests) await complete(request, views.find(view => view.language === request.language));
  for (const request of createReadingFirstDraftRequests({ controller })) {
    const view = views.find(view => view.language === request.language);
    await complete(request, request.task.role === 'translation' && options.transformTranslation ? options.transformTranslation(view) : view);
  }
  const editor = { schema_version: binding.presentation_profile, views_fingerprint: fingerprintReadingFirst(views),
    ...syntheticReadingMapArgument({ sectionId: 'findings', findingIds: (presentation.map?.findings ?? []).map(node => node.id) }),
    languages: Object.fromEntries(languages.map(language => [language, {
    overview: [{ text: language === 'en' ? 'Supported finding and its limits.' : '有依据的发现及其限制。', section_ids: ['findings'] }], sections: [],
    methods: commentary ? [] : methodsFirst ? [{ id: 'method', title: language === 'en' ? 'Fold-based threshold' : '逐折定阈值',
      explanation: language === 'en' ? 'A threshold turns a score into a classification.' : '阈值把评分转为分类判断。',
      application: language === 'en' ? 'Sets a fixed rule for independent testing.' : '为独立检验设定固定规则。',
      section_ids: ['methods', 'held-out-test'] }] :
      [{ id: 'method', knowledge_id: 'method', title: language === 'en' ? 'Method' : '方法', explanation: language === 'en' ? 'A known method.' : '已知方法。', application: language === 'en' ? 'Used in the study.' : '用于本研究。', section_ids: ['methods'] }],
    visuals: [],
  }])) };
  if (methodsFirst) editor.argument.question.section_id = 'design';
  if (commentary) {
    editor.argument.question.text = { en: 'How does an algorithm differ from a use of it?', 'zh-CN': '算法与具体用法有何区别？' };
    editor.argument.conclusion.text = { en: 'Evaluating a use of an algorithm depends on its study context.', 'zh-CN': '评估算法的用法需要考虑研究情境。' };
    editor.argument.claims = [];
    editor.argument.branches = [];
    editor.argument.relations = [{ from: 'question', to: 'conclusion', label: '范围限定' }];
  }
  if (binding.presentation_mode === 'reading-editor') {
    if (binding.configured_setup?.staged_research_map) {
      editor.argument.stage_map = syntheticThresholdStages(editor.argument, presentation.map);
    }
    await complete(createReadingFirstPresentationRequest({ controller }), editor);
  }
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
  const review = options.review ?? { overall: { complete: true, coherent: true, bilingual_consistent: true }, key_nodes: [
    { kind: 'main_conclusion', location: 'findings', finding: 'The supported main conclusion and its limitation are explained.' },
    { kind: 'key_design', location: 'design', finding: 'The key design is explained.' },
    ...(commentary ? [{ kind: 'method_application', status: 'not_applicable', location: '3.1',
      finding: 'The editorial discusses a conceptual distinction without describing a study procedure.', article_type: 'Editorial commentary',
      rationale: 'The source develops a conceptual argument and does not report selection, collection, analysis or evidence synthesis.',
      step_ids: [], section_ids: ['methods'], source_refs: [cutoffLocator] }] : methodsFirst ? [{ kind: 'method_application', status: 'checked', location: presentationMode === 'reading-editor' ? '3.2–3.3' : '3.1–3.2',
      finding: 'The two validation-fold medians among participants without the outcome were averaged to fix the threshold of 6. The independent evaluation used this fixed threshold and counted positives among participants with the outcome.',
      step_ids: ['select-threshold', 'external-test'], section_ids: ['methods', 'held-out-test'], source_refs: [cutoffLocator] }] : []),
  ], issues: [], scope: 'Synthetic overall review of the exact complete bilingual candidate.' };
  const acceptedReview = options.completeReview === false ? null : await complete(reviewRequest, review);
  const resources = adopted?.resources ?? [
    { path: presentation.source_pdf, source_path: source.path, sha256: source.sha256, byte_length: source.byte_length },
    { path: presentation.visuals[0].path, source_path: figure.path, sha256: figure.sha256, byte_length: figure.byte_length },
    ...(supplementPdf ? [{ path: presentation.sources.find(row => row.id === supplementPdf.id).path,
      source_path: supplementPdf.path, sha256: sha(supplementPdf.bytes), byte_length: supplementPdf.bytes.length }] : []),
    ...(registeredDocx ? [
      { path: supplementTarget, source_path: supplement.path, sha256: supplement.sha256, byte_length: supplement.byte_length },
      ...(!options.manifestDocx ? [{ path: displayTarget, source_path: display.path, sha256: display.sha256, byte_length: display.byte_length }] : []),
    ] : []),
  ];
  return { root, artifactRoot: root, runId, paperId, input: scientificInput, broker, binding, handoff, runControl, controller, created,
    candidate, presentation: candidate, presentationCatalog: presentation, renderOptions, views, editor, review, reviewRequest,
    reviewReceipt: acceptedReview?.receipt, resources, source, figure, complete, readNative: request => readFile(join(root, request.task.native_path)) };
}
