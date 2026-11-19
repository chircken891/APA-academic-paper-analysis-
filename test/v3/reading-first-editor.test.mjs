import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReadingFirstEditor, readingFirstViewsFingerprint } from '../../scripts/v3/reading-first-editor.mjs';
import * as editorApi from '../../scripts/v3/reading-first-editor.mjs';
import { assertEditorRepairScope } from '../../scripts/v3/reading-first-repair-scope.mjs';
const views=['en','zh-CN'].map(language=>({language,sections:[{id:'abstract',module_id:'abstract',paragraphs:['Original abstract.']},{id:'design',module_id:'design',paragraphs:['The design supports the main finding.']}]}));
const editor=()=>({schema_version:'reading-editor-1.3',views_fingerprint:readingFirstViewsFingerprint(views),map:{nodes:[]},languages:Object.fromEntries(['en','zh-CN'].map(language=>[language,{visuals:[],overview:[{text:'Main finding',section_ids:['design']}],sections:[{section_id:'design',takeaway:'The design supports inference.',emphasis:[{paragraph_index:0,text:'main finding'}],subheadings:[{before_paragraph:0,heading:'Design'}]}],methods:[{id:'method',title:'Method',explanation:'Known method.',application:'Used for the design.',section_ids:['design'],knowledge_id:'method'}]}]))});
const validate=value=>validateReadingFirstEditor({editor:value,views,presentation:{knowledge:[{id:'method'}]}});
test('reading editor binds accepted bilingual views and preserves prose via metadata',()=>{
  const value=editor(); assert.equal(validate(value),value);
  assert.equal(readingFirstViewsFingerprint([...views].reverse()),value.views_fingerprint);
  assert.throws(()=>validate({...value,views_fingerprint:'stale'}),/FINGERPRINT_INVALID/);
});
test('reading editor rejects invented emphasis, changed abstract and unresolved method references',()=>{
  const changed=editor();changed.languages.en.sections[0].emphasis[0].text='invented';assert.throws(()=>validate(changed),/EMPHASIS_INVALID/);
  const abstract=editor();abstract.languages.en.sections[0].section_id='abstract';assert.throws(()=>validate(abstract),/SECTION_INVALID/);
  const method=editor();method.languages.en.methods[0].knowledge_id='missing';assert.throws(()=>validate(method),/METHOD_INVALID/);
  const bilingual=editor();bilingual.languages.en.methods[0].id='other';assert.throws(()=>validate(bilingual),/BILINGUAL_METHODS_INVALID/);
});
test('reading editor validates figure notes and a shared staged map selection',()=>{
  const placed=views.map(view=>({...view,sections:[...view.sections.slice(0,1),{...view.sections[1],paragraphs:[...view.sections[1].paragraphs,'Read the panel as counts.']}],placements:{visuals:[{id:'fig',section_id:'design',after_paragraph:0}],knowledge:[]}}));
  const presentation={knowledge:[{id:'method'}],visuals:[{id:'fig'}],map:{steps:[{id:'step'}],findings:[{id:'finding'}],relations:[]}};
  const make=()=>{const value=editor();value.views_fingerprint=readingFirstViewsFingerprint(placed);value.map={nodes:[{id:'step',stage:'design'},{id:'finding',stage:'finding',primary:true}]};
    for (const language of ['en','zh-CN']) {value.languages[language].sections[0].subheadings=[];value.languages[language].visuals=[{id:'fig',title:'Figure 1',notes:[{section_id:'design',paragraph_index:1}]}];}
    return value;};
  const check=value=>validateReadingFirstEditor({editor:value,views:placed,presentation});
  const value=make();assert.equal(check(value),value);
  for (const [name,mutate,code] of [
    ['first paragraph',value=>{value.languages.en.visuals[0].notes[0].paragraph_index=0;},/VISUAL_INVALID/],
    ['unplaced section',value=>{value.languages.en.visuals[0].notes[0].section_id='abstract';},/VISUAL_INVALID/],
    ['unknown visual',value=>{value.languages.en.visuals[0].id='missing';},/VISUAL_INVALID/],
    ['headed note',value=>{value.languages.en.sections[0].subheadings=[{before_paragraph:1,heading:'Reading'}];},/VISUAL_INVALID/],
    ['missing visuals',value=>{delete value.languages.en.visuals;},/VISUAL_INVALID/],
    ['step as finding',value=>{value.map.nodes[0].stage='finding';},/MAP_INVALID/],
    ['primary step',value=>{value.map.nodes[0].primary=true;},/MAP_INVALID/],
    ['unknown node',value=>{value.map.nodes.push({id:'other',stage:'design'});},/MAP_INVALID/],
    ['empty map',value=>{value.map.nodes=[];},/MAP_INVALID/],
  ]) {const changed=make();mutate(changed);assert.throws(()=>check(changed),code,name);}
});
test('reading editor requires every step while allowing omitted findings',()=>{
  const presentation={knowledge:[{id:'method'}],visuals:[],map:{steps:[{id:'step'},{id:'step-two'}],findings:[{id:'finding'}],relations:[]}};
  const value=editor(); value.map={nodes:[{id:'step',stage:'design'},{id:'step-two',stage:'measurement'}]};
  const check=()=>validateReadingFirstEditor({editor:value,views,presentation});
  assert.equal(check(),value);
  value.map.nodes.pop();
  assert.throws(check,error=>error.code==='READING_FIRST_EDITOR_MAP_INVALID' && error.details?.missing_steps?.includes('step-two'));
  value.map.nodes.push({id:'step',stage:'design'});
  assert.throws(check,/MAP_INVALID/);
});
test('reading editor covers a fourteen-step map without requiring thirteen findings',()=>{
  const steps=Array.from({length:14},(_,i)=>({id:`d${i+1}`}));
  const findings=Array.from({length:13},(_,i)=>({id:`r${i+1}`}));
  const presentation={knowledge:[{id:'method'}],visuals:[],map:{steps,findings,relations:[]}};
  const value=editor();
  value.map={nodes:[...steps.map(node=>({id:node.id,stage:'measurement'})),{id:'r1',stage:'finding',primary:true}]};
  assert.equal(validateReadingFirstEditor({editor:value,views,presentation}),value);
  value.map.nodes=value.map.nodes.filter(node=>node.id!=='d7');
  assert.throws(()=>validateReadingFirstEditor({editor:value,views,presentation}),error=>error.details?.missing_steps?.includes('d7'));
  for (const schema of ['reading-editor-1.0','reading-editor-1.1','reading-editor-1.2']) assert.throws(()=>validateReadingFirstEditor({editor:{...value,schema_version:schema},views,presentation}),/FINGERPRINT_INVALID/);
});
test('shared bilingual inventory validates nonempty knowledge links and matching association sets',()=>{
  const presentation={knowledge_layout:'shared-bilingual-1.0',knowledge:[{id:'method'},{id:'measure'}]};
  const check=value=>validateReadingFirstEditor({editor:value,views,presentation});
  const value=editor();
  for (const language of ['en','zh-CN']) {
    delete value.languages[language].methods[0].knowledge_id;
    value.languages[language].methods[0].knowledge_ids=['method','measure'];
  }
  assert.equal(check(value),value);
  value.languages.en.methods[0].knowledge_ids.reverse();
  assert.equal(check(value),value);
  value.languages.en.methods[0].knowledge_ids=['method'];
  assert.throws(()=>check(value),/BILINGUAL_METHODS_INVALID/);
  value.languages.en.methods[0].knowledge_ids=['unknown'];
  assert.throws(()=>check(value),/METHOD_INVALID/);
  value.languages.en.methods[0].knowledge_ids=[];
  assert.throws(()=>check(value),/BILINGUAL_METHODS_INVALID/);
  delete value.languages.en.methods[0].knowledge_ids;
  value.languages['zh-CN'].methods[0].knowledge_ids=[];
  assert.equal(check(value),value);
  value.languages.en.methods[0].explanation='';
  assert.throws(()=>check(value),/METHOD_INVALID/);
});
test('legacy inventory supports optional links and rejects malformed knowledge arrays',()=>{
  const value=editor(); delete value.languages.en.methods[0].knowledge_id;
  assert.equal(validate(value),value);
  value.languages.en.methods[0].knowledge_ids=['method','method'];
  assert.throws(()=>validate(value),/METHOD_INVALID/);
  value.languages.en.methods[0].knowledge_ids='method';
  assert.throws(()=>validate(value),/METHOD_INVALID/);
});

const bilingual = (en, zh) => ({ en, 'zh-CN': zh });
const argumentInput = () => ({
  map: { steps: [], findings: ['f1', 'f2', 'f3', 'f4', 'f5'].map(id => ({ id })), relations: [] },
  sectionIds: ['design'],
  primaryFindingIds: ['f1', 'f4'],
  argument: {
    question: { text: bilingual('Which estimates agree?', '哪些估计结果一致？'), section_id: 'design' },
    branches: [
      { id: 'main', name: bilingual('Primary model', '主要模型') },
      { id: 'checks', name: bilingual('Sensitivity checks', '敏感性分析') },
    ],
    claims: [
      { id: 'estimate', title: bilingual('The primary model estimated a difference.', '主要模型估计出差异。'), finding_ids: ['f1', 'f2'], branch_id: 'main' },
      { id: 'adjust', title: bilingual('Adjustment attenuated the difference.', '调整后差异减小。'), finding_ids: ['f3'], branch_id: 'main' },
      { id: 'compare', title: bilingual('The estimates agreed across models.', '各模型估计结果一致。'), finding_ids: ['f4'], branch_id: 'checks' },
      { id: 'uncertainty', title: bilingual('The small sample widened uncertainty.', '样本较少导致不确定性增加。'), finding_ids: ['f5'], branch_id: 'checks' },
    ].map(claim => ({ ...claim, section_id: 'design', evidence: bilingual('The study reports model estimates.', '研究报告了模型估计。'), limit: bilingual('The sample was small.', '样本较少。') })),
    relations: [
      { from: 'question', to: 'estimate', label: '提出问题' },
      { from: 'estimate', to: 'adjust', label: '结果对照' },
      { from: 'adjust', to: 'compare', label: '证据补充' },
      { from: 'compare', to: 'uncertainty', label: '范围限定' },
      { from: 'uncertainty', to: 'conclusion', label: '结果整合' },
    ],
    conclusion: { text: bilingual('The findings warrant qualified interpretation.', '解释结果时须保留限定条件。'), section_id: 'design' },
  },
});

const stagedArgumentInput = () => {
  const input = argumentInput();
  input.methodsFirst = true;
  input.stagedResearchMap = true;
  input.map.steps = ['prepare', 'fit'].map(id => ({ id, section_id: 'design' }));
  input.map.findings.forEach(finding => { finding.section_id = 'design'; });
  const stages = [
    { id: 'model', title: bilingual('Build the model', '建立模型'), step_ids: ['prepare'], claim_ids: ['estimate', 'adjust'] },
    { id: 'check', title: bilingual('Check the estimates', '检验估计'), step_ids: ['fit'], claim_ids: ['compare', 'uncertainty'] },
  ].map(stage => ({ ...stage, entry: bilingual('Compare estimates across analytic choices.', '比较不同分析选择下的估计结果。') }));
  input.argument.stage_map = {
    stages,
    transitions: [{ from: 'model', to: 'check', label: bilingual('Carry adjusted estimates into the sensitivity comparison.', '用调整后的估计开展敏感性比较。') }],
    step_text: Object.fromEntries(input.map.steps.map(({ id }) => [id, bilingual('Fit and adjust the model.', '拟合并调整模型。')])),
    finding_text: Object.fromEntries(input.map.findings.map(({ id }) => [id, bilingual('The estimates agree within uncertainty.', '估计在不确定性范围内一致。')])),
  };
  return input;
};

test('stage layout accepts a supported phase handoff and unlinked independent phases', () => {
  const input = stagedArgumentInput();
  assert.equal(editorApi.validateReadingArgument(input), input.argument);
  input.argument.stage_map.transitions = [];
  input.argument.relations[2] = { from: 'question', to: 'compare', label: '提出问题' };
  input.argument.relations.push({ from: 'adjust', to: 'conclusion', label: '结果整合' });
  assert.equal(editorApi.validateReadingArgument(input), input.argument);
});

test('stage layout may link phases by an admitted workflow transfer or evidence link', () => {
  const input = stagedArgumentInput();
  input.argument.relations[2] = { from: 'question', to: 'compare', label: '提出问题' };
  input.argument.relations.push({ from: 'adjust', to: 'conclusion', label: '结果整合' });
  input.map.step_links = [{ from_step_id: 'prepare', to_step_id: 'fit' }];
  assert.equal(editorApi.validateReadingArgument(input), input.argument);
  input.map.step_links = [];
  input.map.relations = [{ step_id: 'prepare', finding_id: 'f4' }];
  assert.equal(editorApi.validateReadingArgument(input), input.argument);
});

test('stage layout preserves a longer dependency through successive handoffs', () => {
  const input = stagedArgumentInput();
  const staged = input.argument.stage_map;
  const check = staged.stages[1];
  check.claim_ids.pop();
  staged.stages.push({ ...check, id: 'report', step_ids: [], claim_ids: ['uncertainty'] });
  staged.transitions.push({ from: 'check', to: 'report', label: bilingual('Carry the comparison into the uncertainty analysis.', '把比较结果带入不确定性分析。') });
  input.map.relations = [{ step_id: 'prepare', finding_id: 'f5' }];
  assert.equal(editorApi.validateReadingArgument(input), input.argument);
});

test('stage layout permits a documented iterative return without requiring a reverse phase arrow', () => {
  const input = stagedArgumentInput();
  input.map.step_links = [
    { from_step_id: 'prepare', to_step_id: 'fit' },
    { from_step_id: 'fit', to_step_id: 'prepare' },
  ];
  assert.equal(editorApi.validateReadingArgument(input), input.argument);
  input.map.step_links.shift();
  assert.throws(() => editorApi.validateReadingArgument(input), /ARGUMENT_RELATIONS_INVALID/);
});

for (const [label, mutate, code] of [
  ['missing stage data on a new binding', input => { delete input.argument.stage_map; }, 'INVALID'],
  ['a step placed twice', input => input.argument.stage_map.stages[1].step_ids.push('prepare'), 'INVALID'],
  ['an omitted claim', input => input.argument.stage_map.stages[1].claim_ids.pop(), 'INVALID'],
  ['an empty extra stage', input => input.argument.stage_map.stages.push({ ...input.argument.stage_map.stages[0], id: 'extra', step_ids: [], claim_ids: [] }), 'INVALID'],
  ['an unregistered finding text', input => { input.argument.stage_map.finding_text.fake = bilingual('New result', '新增结果'); }, 'INVALID'],
  ['an unlinked finding', input => { input.map.findings[0].section_id = 'absent'; }, 'SECTION_INVALID'],
  ['a missing language', input => { delete input.argument.stage_map.step_text.prepare['zh-CN']; }, 'TEXT_INVALID'],
  ['a missing handoff between dependent phases', input => { input.argument.stage_map.transitions = []; }, 'RELATIONS_INVALID'],
  ['a phase handoff without scientific or argument support', input => input.argument.stage_map.transitions[0] = { ...input.argument.stage_map.transitions[0], from: 'check', to: 'model' }, 'RELATIONS_INVALID'],
  ['a cycle in the phase graph', input => {
    input.map.step_links = [{ from_step_id: 'fit', to_step_id: 'prepare' }];
    input.argument.stage_map.transitions.push({ ...input.argument.stage_map.transitions[0], from: 'check', to: 'model' });
  }, 'CYCLE'],
]) test(`stage layout rejects ${label}`, () => {
  const input = stagedArgumentInput();
  mutate(input);
  assert.throws(() => editorApi.validateReadingArgument(input), { code: `READING_FIRST_EDITOR_ARGUMENT_${code}` });
});

test('1.4 binds the argument and principal findings to both accepted views', () => {
  const input = argumentInput();
  const { map: legacyMap, ...priorEditor } = editor();
  const value = { ...priorEditor, schema_version: 'reading-editor-1.4', argument: input.argument, primary_finding_ids: input.primaryFindingIds };
  const presentation = { knowledge: [{ id: 'method' }], map: input.map };
  assert.equal(validateReadingFirstEditor({ editor: value, views, presentation }), value);
  assert.equal(editorApi.validateReadingArgument(input), input.argument);
  assert.throws(() => validateReadingFirstEditor({ editor: { ...value, map: legacyMap }, views, presentation }), /ARGUMENT_INVALID/);
  const missingTranslationSection = [views[0], { ...views[1], sections: views[1].sections.slice(0, 1) }];
  const noOtherSectionReferences = structuredClone(value);
  noOtherSectionReferences.views_fingerprint = readingFirstViewsFingerprint(missingTranslationSection);
  const zh = noOtherSectionReferences.languages['zh-CN'];
  zh.sections = [];
  zh.overview[0].section_ids = ['abstract'];
  zh.methods[0].section_ids = ['abstract'];
  assert.throws(() => validateReadingFirstEditor({ editor: noOtherSectionReferences, views: missingTranslationSection, presentation }), /ARGUMENT_SECTION_INVALID/);
});

test('1.5 indexes concrete method sections in mirrored first-use order', () => {
  const { map, argument, primaryFindingIds } = argumentInput();
  map.steps.push({ id: 'records', section_id: 'prepare' });
  const adapted = views.map(view => ({ ...view, sections: [...view.sections,
    { id: 'prepare', module_id: 'methods', heading: 'Prepare observations', paragraphs: ['One row per patient.'] },
    { id: 'analyze', module_id: 'methods', heading: 'Estimate differences', paragraphs: ['The model used those rows.'] },
    { id: 'compare', module_id: 'findings', heading: 'Compare estimates', paragraphs: ['The estimates were compared.'] },
  ] }));
  const make = () => {
    const value = editor();
    delete value.map;
    return { ...value, schema_version: 'reading-editor-1.5', argument, primary_finding_ids: primaryFindingIds,
      views_fingerprint: readingFirstViewsFingerprint(adapted), languages: Object.fromEntries(
        Object.entries(value.languages).map(([language, view]) => [language, { ...view, methods: [
          { id: 'aggregation', title: 'Aggregation', explanation: 'Summaries combine records by unit.', application: 'Constructs patient records.', section_ids: ['prepare', 'analyze'] },
          { id: 'model', title: 'Model', explanation: 'Parameterized models describe associations.', application: 'Estimates differences.', section_ids: ['analyze'], knowledge_ids: ['method'] },
        ] }])) };
  };
  const check = editor => validateReadingFirstEditor({ editor, views: adapted, presentation: { knowledge: [{ id: 'method' }], map } });
  assert.doesNotThrow(() => check(make()));
  for (const change of [
    value => value.languages.en.methods[0].section_ids = ['abstract'],
    value => value.languages.en.methods[0].section_ids = [],
    value => value.languages.en.methods[0].section_ids.reverse(),
    value => value.languages.en.methods.reverse(),
    value => value.languages.en.methods[0].application = '  ',
    value => value.languages.en.methods[0].explanation = '  ',
    value => value.languages.en.methods[0].explanation = 'Line one.\nLine two.',
    value => value.languages.en.methods[0].explanation = null,
  ]) {
    const value = make();
    change(value);
    assert.throws(() => check(value), /METHOD_INVALID/);
  }
  const differentSection = make();
  differentSection.languages.en.methods[0].section_ids.pop();
  assert.throws(() => check(differentSection), /BILINGUAL_METHODS_INVALID/);
  const differentKnowledge = make();
  differentKnowledge.languages.en.methods[1].knowledge_ids = [];
  assert.throws(() => check(differentKnowledge), /BILINGUAL_METHODS_INVALID/);
  const incompletePrinciple = make();
  delete incompletePrinciple.languages.en.methods[0].explanation;
  assert.throws(() => check(incompletePrinciple), /METHOD_INVALID|BILINGUAL_METHODS_INVALID/);
  const historical = make();
  for (const view of Object.values(historical.languages)) {
    for (const method of view.methods) delete method.explanation;
  }
  assert.doesNotThrow(() => check(historical));
  assert.throws(() => validateReadingFirstEditor({ editor: historical, views: adapted,
    presentation: { knowledge: [{ id: 'method' }], map }, expandedMethodIndex: true }), /METHOD_INVALID/);
  for (const view of Object.values(historical.languages)) view.methods[0].section_ids.push('compare');
  assert.throws(() => check(historical), /METHOD_INVALID/);
  const acrossModules = make();
  for (const view of Object.values(acrossModules.languages)) {
    view.methods[0].section_ids.unshift('design');
    view.methods[1].section_ids.push('compare');
  }
  assert.doesNotThrow(() => check(acrossModules));
  const missingMethod = make();
  for (const language of ['en', 'zh-CN']) missingMethod.languages[language].methods = [];
  assert.throws(() => check(missingMethod), /CONTENT_INVALID/);
});

test('1.5 accommodates a brief argument without inventing methods or claims', () => {
  const input = argumentInput();
  input.argument.claims = [];
  input.argument.branches = [];
  input.argument.relations = [{ from: 'question', to: 'conclusion', label: '范围限定' }];
  input.map.findings = [];
  input.primaryFindingIds = [];
  const value = editor();
  delete value.map;
  value.schema_version = 'reading-editor-1.5';
  value.argument = input.argument;
  value.primary_finding_ids = [];
  for (const language of ['en', 'zh-CN']) value.languages[language].methods = [];
  assert.equal(validateReadingFirstEditor({ editor: value, views, presentation: { map: input.map } }), value);
  const staged = { editor: value, views, presentation: { map: input.map }, stagedResearchMap: true };
  assert.throws(() => validateReadingFirstEditor(staged), /ARGUMENT_INVALID/);
  input.argument.stage_map = { stages: [], transitions: [], step_text: {}, finding_text: {} };
  assert.equal(validateReadingFirstEditor(staged), value);
  assert.throws(() => editorApi.validateReadingArgument(input), /CLAIMS_INVALID/);
  input.map.findings.push({ id: 'unassigned' });
  assert.throws(() => validateReadingFirstEditor({ editor: value, views, presentation: { map: input.map } }), /FINDINGS_INVALID/);
});

for (const [label, change, code] of [
  ['omitted finding', input => input.argument.claims[0].finding_ids.pop(), 'FINDINGS_INVALID'],
  ['duplicate finding', input => input.argument.claims[1].finding_ids.push('f1'), 'FINDINGS_INVALID'],
  ['unknown finding', input => input.argument.claims[0].finding_ids.push('missing'), 'FINDINGS_INVALID'],
  ['unknown primary finding', input => input.primaryFindingIds.push('missing'), 'FINDINGS_INVALID'],
  ['too few claims', input => input.argument.claims.pop(), 'CLAIMS_INVALID'],
  ['too many claims', input => input.argument.claims.push(...input.argument.claims, input.argument.claims[0]), 'CLAIMS_INVALID'],
  ['unknown label', input => { input.argument.relations[0].label = '造词'; }, 'RELATIONS_INVALID'],
  ['cycle', input => input.argument.relations.push({ from: 'uncertainty', to: 'estimate', label: '证据补充' }), 'CYCLE'],
  ['unreachable from question', input => input.argument.relations.shift(), 'PATH_INVALID'],
  ['unable to reach conclusion', input => input.argument.relations.pop(), 'PATH_INVALID'],
  ['excessive length', input => { input.argument.question.text.en = 'a'.repeat(400); }, 'TEXT_INVALID'],
  ['missing translation', input => { delete input.argument.claims[0].evidence['zh-CN']; }, 'TEXT_INVALID'],
  ['unknown branch', input => { input.argument.claims[0].branch_id = 'missing'; }, 'BRANCHES_INVALID'],
  ['unknown section', input => { input.argument.conclusion.section_id = 'missing'; }, 'SECTION_INVALID'],
]) test(`1.4 rejects an argument with ${label}`, () => {
  const input = argumentInput();
  change(input);
  assert.throws(() => editorApi.validateReadingArgument(input), { code: `READING_FIRST_EDITOR_ARGUMENT_${code}` });
});

test('1.4 uses the existing map repair scope for the argument and principal findings', () => {
  const input = argumentInput();
  const { map: legacyMap, ...priorEditor } = editor();
  const base = { ...priorEditor, schema_version: 'reading-editor-1.4', argument: input.argument, primary_finding_ids: input.primaryFindingIds };
  const revised = structuredClone(base);
  revised.argument.question.text.en = 'Which models give similar estimates?';
  revised.primary_finding_ids = ['f1'];
  const scope = { status: 'located', section_ids: [], knowledge_ids: [], visual_ids: [], editor_fields: ['map'] };
  const verdict = repair_scope => ({ issues: [{ severity: 'material', repair_owner: 'editor', repair_scope }] });
  assert.doesNotThrow(() => assertEditorRepairScope(base, revised, verdict(scope)));
  assert.throws(() => assertEditorRepairScope(base, revised, verdict({ ...scope, section_ids: ['design'], editor_fields: [] })), /REPAIR_SCOPE_EXCEEDED/);
  revised.languages.en.methods[0].title = 'Unrelated title';
  assert.throws(() => assertEditorRepairScope(base, revised, verdict(scope)), /REPAIR_SCOPE_EXCEEDED/);
});
