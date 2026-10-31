import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('2.1 predeclares separate translation progress paths and legacy stays unchanged', async () => {
  const {buildReadingSessionTasks} = await import('../../scripts/v3/reading-session-tasks.mjs');
  const options = {runId:'run',scientificInput:{role_artifacts:['a','b','c','d','e','f']},sourceLanguage:'en',checkpointCount:1,includeRepairs:true};
  const modern = buildReadingSessionTasks({...options,instructionProfile:'configured-reading-2.1'});
  const legacy = buildReadingSessionTasks(options);
  assert.ok(modern.taskBindings['zh-CN'].progress_path);
  assert.notEqual(modern.taskBindings['zh-CN'].progress_path,modern.taskBindings['zh-CN-r2'].progress_path);
  assert.equal(legacy.taskBindings['zh-CN'].progress_path,undefined);
});

test('2.1 freezes on-demand instructions and correct map examples', async () => {
  const {buildConfiguredReadingInstructions} = await import('../../scripts/v3/configured-reading.mjs');
  const result = buildConfiguredReadingInstructions({}, {instructionProfile:'configured-reading-2.1'});
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

test('2.1 refuses missing progress paths and collisions', async () => {
  const {buildReadingSessionTasks} = await import('../../scripts/v3/reading-session-tasks.mjs');
  const options = {runId:'run',scientificInput:{role_artifacts:['a','b','c','d','e','f']},sourceLanguage:'en',checkpointCount:1,instructionProfile:'configured-reading-2.1'};
  assert.throws(()=>buildReadingSessionTasks({...options,taskOverrides:{'zh-CN':{progress_path:''}}}),/TASK_CONFLICT/);
  assert.throws(()=>buildReadingSessionTasks({...options,taskOverrides:{'zh-CN':{progress_path:'native/zh-CN.json'}}}),/TASK_CONFLICT/);
});
