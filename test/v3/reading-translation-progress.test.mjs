import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as progress from '../../scripts/v3/reading-translation-progress.mjs';

test('2.2 permits one unexplained zero-progress continuation and distinguishes capacity evidence', () => {
  const current = { completed_sections:{}, completed_knowledge:{}, remaining_sections:['a'], remaining_knowledge:['k'] };
  const first = progress.evaluateTranslationContinuation({progress:current});
  assert.equal(first.action, 'continue');
  assert.equal(first.unknown_zero_progress_retry, true);
  assert.equal(progress.evaluateTranslationContinuation({progress:current, priorUnknownZeroProgress:1}).action, 'reconcile');
  const advanced = {...current,completed_sections:{a:{translation_fingerprint:'a'}},remaining_sections:[]};
  assert.equal(progress.evaluateTranslationContinuation({progress:advanced,previousProgress:current,priorUnknownZeroProgress:1}).action, 'continue');
  const role = progress.evaluateTranslationContinuation({progress:current,stopReason:{kind:'role_report',detail:'role reports capacity reached'}});
  assert.equal(role.reason_kind, 'role_report');
  assert.throws(() => progress.evaluateTranslationContinuation({progress:current,stopReason:{kind:'host_confirmed',detail:'capacity'}}), /STOP_REASON_INVALID/);
  const host = progress.evaluateTranslationContinuation({progress:current,stopReason:{kind:'host_confirmed',detail:'capacity',source_reference:'host-log:123'}});
  assert.equal(host.reason_kind, 'host_confirmed');
  assert.equal(progress.evaluateTranslationContinuation({progress:{...advanced,remaining_knowledge:[]}}).action, 'complete');
});

test('translation input references and partial progress retain source and completed fragments', () => {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'apa-translation-'));
  const task = { task_id:'zh-CN', source_view_path:'inputs/zh/source.json', translation_context_path:'inputs/zh/context.json', progress_path:'inputs/zh/progress.json', native_path:'native/zh.json' };
  const sourceView = { sections:[{id:'a',paragraphs:['source a']},{id:'b',paragraphs:['source b']}], knowledge_content:[{id:'k',paragraphs:['source k']}] };
  const nativeOutput = { sections:[{id:'a',paragraphs:['译文 a']}], knowledge_content:[] };
  const payload = {language:'zh-CN', source_view:sourceView, translation_context:{knowledge:[{id:'k',title:'知识'}]}};
  const prepared = progress.prepareTranslationInputs({artifactRoot,task,runId:'run',payload});
  assert.equal(JSON.stringify(prepared.instructionPayload).includes('source a'),false);
  assert.deepEqual(JSON.parse(readFileSync(prepared.instructionPayload.source_view_ref.path)),sourceView);
  assert.deepEqual(progress.checkTranslationProgress({artifactRoot,task,runId:'run',sourceView}).remaining_sections,['a','b']);
  progress.writeTranslationProgress({artifactRoot,task,runId:'run',sourceView,nativeOutput});
  const baseline = progress.checkTranslationProgress({artifactRoot,task,runId:'run',sourceView,nativeOutput});
  assert.deepEqual(baseline.remaining_sections,['b']);
  assert.deepEqual(baseline.remaining_knowledge,['k']);
  assert.throws(()=>progress.checkTranslationProgress({artifactRoot,task,runId:'run',sourceView:{...sourceView,sections:[{id:'a',paragraphs:['changed']},sourceView.sections[1]]},nativeOutput}),/RECONCILE/);
  assert.throws(()=>progress.checkTranslationProgress({artifactRoot,task,runId:'run',sourceView,nativeOutput:{...nativeOutput,sections:[{id:'a',paragraphs:['改动']}]} }),/RECONCILE/);
  assert.throws(()=>progress.checkTranslationProgress({artifactRoot,task,runId:'run',sourceView}),/RECONCILE/);
  assert.throws(()=>progress.checkTranslationProgress({artifactRoot,task:{...task,task_id:'zh-CN-r2'},runId:'run',sourceView,nativeOutput}),/RECONCILE/);
  assert.deepEqual(progress.checkTranslationProgress({artifactRoot,task,runId:'run',sourceView,nativeOutput,expectedCompleted:baseline}).completed_sections,baseline.completed_sections);
});

test('2.2 predeclares separate translation progress paths and retired profiles are refused', async () => {
  const {buildReadingSessionTasks} = await import('../../scripts/v3/reading-session-tasks.mjs');
  const options = {runId:'run',scientificInput:{role_artifacts:['a','b','c','d','e','f']},sourceLanguage:'en',checkpointCount:1,includeRepairs:true};
  const current = buildReadingSessionTasks(options);
  assert.ok(current.taskBindings['zh-CN'].progress_path);
  assert.notEqual(current.taskBindings['zh-CN'].progress_path,current.taskBindings['zh-CN-r2'].progress_path);
  assert.throws(()=>buildReadingSessionTasks({...options,instructionProfile:'configured-reading-2.1'}),/READING_BINDING_RETIRED/);
});

test('2.2 freezes on-demand instructions and correct map examples', async () => {
  const {buildConfiguredReadingInstructions} = await import('../../scripts/v3/configured-reading.mjs');
  const result = buildConfiguredReadingInstructions({}, {instructionProfile:'configured-reading-2.2'});
  assert.match(result.sections.Translation,/checkpoint/);
  assert.match(result.sections['Reading Editor'],/primary.*finding/);
  assert.match(result.science_sections['Common scientific contract'],/desktop control/i);
});

test('updated progress preserves prior completed fragments and allows remaining content', () => {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'apa-translation-'));
  const task = {task_id:'en-r2',progress_path:'r2/progress.json'};
  const sourceView = {sections:[{id:'one',paragraphs:['one']},{id:'two',paragraphs:['two']}],knowledge_content:[]};
  const first = {sections:[{id:'one',paragraphs:['一']}],knowledge_content:[]};
  const baseline = progress.writeTranslationProgress({artifactRoot,task,runId:'r',sourceView,nativeOutput:first});
  const full = {sections:[...first.sections,{id:'two',paragraphs:['二']}],knowledge_content:[]};
  progress.writeTranslationProgress({artifactRoot,task,runId:'r',sourceView,nativeOutput:full});
  assert.deepEqual(progress.checkTranslationProgress({artifactRoot,task,runId:'r',sourceView,nativeOutput:full,expectedCompleted:baseline}).remaining_sections,[]);
  const other = {...task,progress_path:'initial/progress.json',task_id:'en'};
  assert.deepEqual(progress.checkTranslationProgress({artifactRoot,task:other,runId:'r',sourceView}).remaining_sections,['one','two']);
});

test('2.2 refuses missing progress paths and collisions', async () => {
  const {buildReadingSessionTasks} = await import('../../scripts/v3/reading-session-tasks.mjs');
  const options = {runId:'run',scientificInput:{role_artifacts:['a','b','c','d','e','f']},sourceLanguage:'en',checkpointCount:1};
  assert.throws(()=>buildReadingSessionTasks({...options,taskOverrides:{'zh-CN':{progress_path:''}}}),/TASK_CONFLICT/);
  assert.throws(()=>buildReadingSessionTasks({...options,taskOverrides:{'zh-CN':{progress_path:'native/zh-CN.json'}}}),/TASK_CONFLICT/);
});

const strictInstructionProfile = 'configured-reading-2.4';
const strictProgressProfile = 'reading-translation-progress-1.1';
const cli = fileURLToPath(new URL('../../scripts/v3/reading-translation-progress.mjs', import.meta.url));
const translatedSection = { id: 'findings', module_id: 'findings', heading: '发现', paragraphs: ['第一段。', '第二段。'] };
const translatedKnowledge = {
  id: 'contrast', paragraphs: ['定义。', '用途。'], application_section_ids: ['findings'],
  sections: [{ heading: '示例', paragraphs: ['输入。', '解读。'] }],
};

function checkpointFixture(t, instructionProfile) {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'apa-translation-structure-'));
  t.after(() => rmSync(artifactRoot, { recursive: true, force: true }));
  const task = { task_id: 'zh-CN', source_view_path: 'input/source.json', translation_context_path: 'input/context.json', progress_path: 'input/progress.json', native_path: 'native/zh.json' };
  const sourceView = {
    sections: [{ id: 'findings', module_id: 'findings', heading: 'Findings', paragraphs: ['One observation.', 'Its contrasting condition.'] }],
    knowledge_content: [{ id: 'contrast', paragraphs: ['Definition.', 'Use.'], application_section_ids: ['findings'],
      sections: [{ heading: 'Example', paragraphs: ['Input.', 'Interpretation.'] }] }],
  };
  const runId = 'structure-test';
  const options = { artifactRoot, task, runId, sourceView, instructionProfile };
  const payload = { language: 'zh-CN', source_view: sourceView };
  mkdirSync(join(artifactRoot, 'native'));
  const prepare = () => progress.prepareTranslationInputs({ ...options, payload });
  const saveNative = nativeOutput => writeFileSync(join(artifactRoot, task.native_path), JSON.stringify(nativeOutput));
  const checkpoint = nativeOutput => {
    saveNative(nativeOutput);
    const args = [cli, 'checkpoint', artifactRoot, runId, task.task_id, task.source_view_path, task.native_path, task.progress_path];
    return spawnSync(process.execPath, args, { encoding: 'utf8' });
  };
  return { ...options, prepare, saveNative, checkpoint, progressPath: join(artifactRoot, task.progress_path) };
}

test('2.3 checkpoint writes an unchanged v1.0 manifest and preserves existing correction boundaries', t => {
  const fixture = checkpointFixture(t, 'configured-reading-2.3');
  const compressed = { sections: [{ id: 'findings', paragraphs: ['一段合译。'] }] };
  fixture.prepare();
  const outcome = fixture.checkpoint(compressed);
  assert.equal(outcome.status, 0, outcome.stderr);
  const manifest = JSON.parse(readFileSync(fixture.progressPath));
  assert.equal(manifest.profile, 'translation-progress-1.0');
  assert.deepEqual(JSON.parse(outcome.stdout).remaining_sections, []);
  assert.throws(() => progress.checkTranslationProgress({ ...fixture, instructionProfile: strictInstructionProfile, nativeOutput: compressed }), /RECONCILE/);
});

test('2.4 CLI leaves a merged result fragment unlocked and accepts the corrected paragraphs', t => {
  const fixture = checkpointFixture(t, strictInstructionProfile);
  const compressed = { sections: [{ ...translatedSection, paragraphs: ['一段合译。'] }] };
  assert.throws(() => progress.checkTranslationProgress(fixture), /RECONCILE/);
  fixture.prepare();
  const initialBytes = readFileSync(fixture.progressPath);
  const initial = JSON.parse(initialBytes);
  assert.equal(initial.profile, strictProgressProfile);
  assert.deepEqual(initial.completed_sections, {});
  const outcome = fixture.checkpoint(compressed);
  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /READING_FIRST_TRANSLATION_STRUCTURE_INVALID/);
  assert.ok(readFileSync(fixture.progressPath).equals(initialBytes));
  assert.deepEqual(progress.checkTranslationProgress({ ...fixture, nativeOutput: compressed }).remaining_sections, ['findings']);
  const corrected = { sections: [translatedSection] };
  const resumed = fixture.checkpoint(corrected);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.deepEqual(JSON.parse(resumed.stdout).remaining_sections, []);
  assert.deepEqual(JSON.parse(resumed.stdout).remaining_knowledge, ['contrast']);
  assert.throws(() => progress.checkTranslationProgress({ ...fixture, sourceView: {
    ...fixture.sourceView, sections: [{ ...fixture.sourceView.sections[0], paragraphs: ['Changed observation.', 'Its contrasting condition.'] }],
  }, nativeOutput: corrected }), /RECONCILE/);
});

test('2.4 CLI leaves earlier fragments intact when a knowledge subsection is missing or compressed', t => {
  const fixture = checkpointFixture(t, strictInstructionProfile);
  const first = { sections: [translatedSection] };
  fixture.prepare();
  const checkpoint = fixture.checkpoint(first);
  assert.equal(checkpoint.status, 0, checkpoint.stderr);
  const locked = readFileSync(fixture.progressPath);
  const prior = JSON.parse(checkpoint.stdout);
  for (const sections of [[], [{ heading: '示例', paragraphs: ['合译。'] }]]) {
    const draft = { ...first, knowledge_content: [{ ...translatedKnowledge, sections }] };
    const invalid = fixture.checkpoint(draft);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /READING_FIRST_TRANSLATION_STRUCTURE_INVALID/);
    assert.ok(readFileSync(fixture.progressPath).equals(locked));
    assert.deepEqual(progress.checkTranslationProgress({ ...fixture, nativeOutput: draft, expectedCompleted: prior }).remaining_knowledge, ['contrast']);
  }
  const good = fixture.checkpoint({ ...first, knowledge_content: [translatedKnowledge] });
  assert.equal(good.status, 0, good.stderr);
  assert.deepEqual(JSON.parse(good.stdout).remaining_knowledge, []);
});

test('2.4 CLI will not lock missing headings or changed module and knowledge application IDs', t => {
  const fixture = checkpointFixture(t, strictInstructionProfile);
  fixture.prepare();
  const initialBytes = readFileSync(fixture.progressPath);
  const complete = { sections: [translatedSection], knowledge_content: [translatedKnowledge] };
  for (const [field, mutate] of [
    ['heading', draft => { delete draft.sections[0].heading; }],
    ['module_id', draft => { draft.sections[0].module_id = 'discussion'; }],
    ['module_id', draft => { delete draft.sections[0].module_id; }],
    ['sections.heading', draft => { draft.knowledge_content[0].sections[0].heading = ' '; }],
    ['application_section_ids', draft => { draft.knowledge_content[0].application_section_ids = ['discussion']; }],
    ['application_section_ids', draft => { delete draft.knowledge_content[0].application_section_ids; }],
  ]) {
    const draft = structuredClone(complete);
    mutate(draft);
    const invalid = fixture.checkpoint(draft);
    assert.equal(invalid.status, 1, `${field} was locked`);
    assert.match(invalid.stderr, /READING_FIRST_TRANSLATION_STRUCTURE_INVALID/);
    assert.ok(readFileSync(fixture.progressPath).equals(initialBytes));
    const pending = progress.checkTranslationProgress({ ...fixture, nativeOutput: draft });
    assert.deepEqual(pending.remaining_sections, ['findings']);
    assert.deepEqual(pending.remaining_knowledge, ['contrast']);
    assert.throws(() => progress.assertTranslationStructure(fixture.sourceView, draft), error =>
      error.code === 'READING_FIRST_TRANSLATION_STRUCTURE_INVALID' && error.details.field === field);
  }
  const corrected = fixture.checkpoint(complete);
  assert.equal(corrected.status, 0, corrected.stderr);
  assert.deepEqual(JSON.parse(corrected.stdout).remaining_sections, []);
  assert.deepEqual(JSON.parse(corrected.stdout).remaining_knowledge, []);
});

test('2.4 complete structure compares all section and knowledge IDs and top-level knowledge paragraphs', t => {
  const { sourceView } = checkpointFixture(t, strictInstructionProfile);
  assert.doesNotThrow(() => progress.assertTranslationStructure(sourceView, { sections: sourceView.sections }, { partial: true }));
  assert.throws(() => progress.assertTranslationStructure(sourceView, { sections: sourceView.sections }), { code: 'READING_FIRST_TRANSLATION_STRUCTURE_INVALID' });
  const draft = { ...sourceView, knowledge_content: [{ ...sourceView.knowledge_content[0], paragraphs: ['一段合译。'] }] };
  assert.throws(() => progress.assertTranslationStructure(sourceView, draft), { code: 'READING_FIRST_TRANSLATION_STRUCTURE_INVALID' });
  assert.doesNotThrow(() => progress.assertTranslationStructure(sourceView, structuredClone(sourceView)));
});
