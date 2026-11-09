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
