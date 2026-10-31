import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadingFirstRunControl } from '../../scripts/v3/reading-first-runtime.mjs';
import { createApaRoleModelPolicy } from '../../scripts/apa-model-policy.mjs';
import { buildConfiguredReadingInstructions } from '../../scripts/v3/configured-reading.mjs';
import { createScienceController, restoreScienceController, prepareScienceRequests, recordScienceDispatchIntent, recordScienceHostObservation, acceptScienceResult, getScienceState, reserveScienceContinuation, markScienceContinuationDispatched, recordScienceContinuationReceipt } from '../../scripts/v3/science-controller.mjs';

const roles = ['evidence', 'methods', 'results', 'interpretation', 'scientific-reading', 'integration'];
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'science-22-'));
  await mkdir(join(root, 'native'));
  const source = Buffer.from('source'), prompt = Buffer.from('prompt');
  await writeFile(join(root, 'paper.pdf'), source); await writeFile(join(root, 'prompt.md'), prompt);
  const tasks = Object.fromEntries(roles.map(role => [role, { task_id: role, task_name: role.replace('-', '_'), owner_actor_id: role, role, artifact_id: role, artifact_path: 'science/' + role + '.json', native_path: 'native/' + role + '.json', revision: '1' }]));
  const downstream = Object.fromEntries(['en', 'zh-CN', 'review'].map(key => [key, { task_id: key, task_name: 'writer_' + key.replace('-', '_').toLowerCase(), owner_actor_id: key, role: key === 'en' ? 'english-writer' : key === 'zh-CN' ? 'chinese-writer' : 'independent-verifier', artifact_id: key, artifact_path: 'writer/' + key + '.json', native_path: 'native/' + key + '.json', revision: '1' }]));
  const scientificInput = { profile: 'reading-first-1.0', identity: { paper_id: 'synthetic', run_id: 'run' }, sources: [{ id: 'paper', path: join(root, 'paper.pdf'), sha256: hash(source), byte_length: source.length }], context: 'synthetic', role_artifacts: roles };
  const mainSession = { model: 'gpt-6-astra', reasoning_effort: 'high' };
  const manifestTask = { task_id: 'results-resources', artifact_id: 'results-resources', artifact_path: 'science/results-resources.json', native_path: 'native/results-resources.json', revision: '1', owner_actor_id: 'results', role: 'results' };
  const config = { schema_version: 'apa-configured-reading-1.0', config_fingerprint: hash(Buffer.from('config')), paths: { runRoot: root }, role_model_policy: createApaRoleModelPolicy(mainSession), ...buildConfiguredReadingInstructions({}), instruction_profile: 'configured-reading-2.2', prompt_files: [{ path: join(root, 'prompt.md'), sha256: hash(prompt), byte_length: prompt.length }], results_resources: { output_root: 'resources/results', manifest_task: manifestTask } };
  const runControl = createReadingFirstRunControl({ runId: 'run', scientificInput, mainSession, configuredSetup: config, authorizationId: 'synthetic', deadline: '2099-01-01T00:00:00Z', taskBindings: downstream, writingMode: 'source-first', maxCalls: 6, priorCalls: 6, maxTotalCalls: 12 });
  const prepared = { runControl, scientificInput, configurationFingerprint: config.config_fingerprint, paths: { runRoot: root } };
  const authorized_bindings = [...Object.values(tasks), ...Object.values(downstream), manifestTask].map(task => ({ run_id: 'run', actor_id: task.owner_actor_id, role: task.role, artifact_path: task.artifact_path, revision: task.revision }));
  return { root, options: { prepared, tasks, brokerConfig: { control_actor_id: 'controller', artifact_root: root, authorized_bindings, run_controls: [runControl] }, statePath: join(root, 'state.json') } };
}
test('2.2 unproven host return remains unknown through restore without redispatch', async () => {
  const f = await fixture(), controller = await createScienceController(f.options);
  const [{ request }] = await prepareScienceRequests({ controller });
  await recordScienceDispatchIntent({ controller, role: 'evidence' });
  const step = request.emittedStep;
  const result = await recordScienceHostObservation({ controller, role: 'evidence', observation: { action_id: step.action_id, run_id: 'run', input_fingerprint: step.input_fingerprint, port: 'current-collaboration', tool_call: { name: step.action, arguments: step.arguments }, raw_result_text: '{"agent_id":"host-evidence"}' } });
  assert.equal(result.status, 'outcome_unknown');
  const restored = await restoreScienceController(f.options);
  assert.equal(getScienceState(restored).roles.evidence.status, 'outcome_unknown');
  assert.deepEqual(await prepareScienceRequests({ controller: restored }), []);
  const raw = '{"agent_id":"host-evidence"}', evidencePath = join(f.root, 'raw.txt'); await writeFile(evidencePath, raw);
  const accepted = await recordScienceHostObservation({ controller: restored, role: 'evidence', observation: { action_id: step.action_id, run_id: 'run', input_fingerprint: step.input_fingerprint, port: 'current-collaboration', tool_call: { name: step.action, arguments: step.arguments }, raw_result_text: raw, evidence: { kind: 'raw', capture: 'direct', sha256: hash(Buffer.from(raw)).slice(7), source_reference: evidencePath } } });
  assert.equal(accepted.status, 'observed');
  const emptyPath = join(f.root, 'empty.txt'); await writeFile(emptyPath, '');
  const update = await recordScienceHostObservation({ controller: restored, role: 'evidence', observation: { kind: 'host_update', action_id: step.action_id, agent_id: 'host-evidence', tool_call: { name: 'wait', arguments: {} }, raw_result_text: '', evidence: { kind: 'raw', capture: 'direct', sha256: hash(Buffer.from('')).slice(7), source_reference: emptyPath } } });
  assert.equal(update.status, 'outcome_unknown'); assert.equal(update.evidence.source_reference, emptyPath);
  const args = { target: 'host-evidence' };
  await reserveScienceContinuation({ controller: restored, role: 'evidence', executionId: 'continuation', actionId: 'action-continuation', handle: 'host-evidence', tool: 'followup', arguments: args });
  await markScienceContinuationDispatched({ controller: restored, executionId: 'continuation' });
  await assert.rejects(() => markScienceContinuationDispatched({ controller: restored, executionId: 'continuation' }), /EXECUTION_INTENT_INVALID/);
  const receipt = { execution_id: 'continuation', action_id: 'action-continuation', agent_id: 'host-evidence', tool_call: { name: 'followup', arguments: args }, status: 'observed', raw_result_text: 'done' };
  assert.equal((await recordScienceContinuationReceipt({ controller: restored, executionId: 'continuation', receipt })).status, 'issued');
  const again = await restoreScienceController(f.options);
  await assert.rejects(() => markScienceContinuationDispatched({ controller: again, executionId: 'continuation' }), /EXECUTION_INTENT_INVALID/);
  await writeFile(evidencePath, 'drift');
  await assert.rejects(() => restoreScienceController(f.options), /HOST_RECEIPT_EVIDENCE_INVALID/);
});

test('2.2 Results manifest is owned and passed to Integrator after source validation', async () => {
  const f = await fixture(), controller = await createScienceController(f.options);
  const root = f.root, images = join(root, 'resources', 'results'); await mkdir(images, { recursive: true });
  const image = Buffer.from('image'); await writeFile(join(images, 'figure.png'), image);
  const source = f.options.prepared.scientificInput.sources[0];
  const manifest = { version: 'reading-resources-1.0', resources: [{ id: 'fig-1', source_id: 'paper', locator: { kind: 'pdf-page', page: 1 }, source_path: join(images, 'figure.png'), path: 'Figures/paper/figure.png', ...{ sha256: hash(image), byte_length: image.length }, parent: { path: source.path, sha256: source.sha256, byte_length: source.byte_length } }] };
  const manifestBytes = Buffer.from(JSON.stringify(manifest)); await writeFile(join(root, 'native/results-resources.json'), manifestBytes);
  const ref = { path: join(root, 'science/results-resources.json'), resources_root: images, sha256: hash(manifestBytes), byte_length: manifestBytes.length };
  for (let batch = 0; batch < 5; batch++) {
    for (const { role, request } of await prepareScienceRequests({ controller })) {
      await recordScienceDispatchIntent({ controller, role });
      const step = request.emittedStep, raw = JSON.stringify({ agent_id: 'host-' + role }), evidencePath = join(root, 'evidence-' + role + '.txt');
      await writeFile(evidencePath, raw);
      await recordScienceHostObservation({ controller, role, observation: { action_id: step.action_id, run_id: 'run', input_fingerprint: step.input_fingerprint, port: 'current-collaboration', tool_call: { name: step.action, arguments: step.arguments }, raw_result_text: raw, evidence: { kind: 'raw', capture: 'direct', sha256: hash(Buffer.from(raw)).slice(7), source_reference: evidencePath } } });
      if (role === 'integration') assert.match(JSON.stringify(request), /results-resources\.json/);
      const content = role === 'results' ? { role, resource_manifest: ref } : role === 'integration' ? { role, visual_handoff: { resource_manifest: ref }, visual_resources: [{ id: 'fig-1', path: manifest.resources[0].path, source_id: 'paper', locator: manifest.resources[0].locator }] } : { role };
      await writeFile(join(root, f.options.tasks[role].native_path), JSON.stringify(content));
      await acceptScienceResult({ controller, role });
    }
  }
  assert.deepEqual(JSON.parse(await readFile(ref.path, 'utf8')), manifest);
  await writeFile(join(images, 'figure.png'), 'drift');
  await assert.rejects(() => restoreScienceController(f.options));
});

test('2.2 science request retains frozen prompt sections after prompt file changes', async () => {
  const f = await fixture(); await createScienceController(f.options);
  await writeFile(join(f.root, 'prompt.md'), 'changed external file');
  const restored = await restoreScienceController(f.options);
  const [{ request }] = await prepareScienceRequests({ controller: restored });
  const frozen = f.options.prepared.runControl.reading_first_binding.configured_setup.science_sections['Common scientific contract'];
  assert.ok(JSON.stringify(request).includes(JSON.stringify(frozen).slice(1, -1)));
  assert.doesNotMatch(JSON.stringify(request), /changed external file/);
});

async function interruptedManifest(crashAt = 'body') {
  const f = await fixture(), controller = await createScienceController(f.options);
  const [{request:evidence}] = await prepareScienceRequests({controller});
  async function observe(role, request) {
    await recordScienceDispatchIntent({controller,role});
    const step=request.emittedStep, raw=JSON.stringify({agent_id:'host-'+role}), evidencePath=join(f.root,'host-'+role+'.txt');
    await writeFile(evidencePath,raw);
    await recordScienceHostObservation({controller,role,observation:{action_id:step.action_id,run_id:'run',input_fingerprint:step.input_fingerprint,port:'current-collaboration',tool_call:{name:step.action,arguments:step.arguments},raw_result_text:raw,evidence:{kind:'raw',capture:'direct',sha256:hash(Buffer.from(raw)).slice(7),source_reference:evidencePath}}});
  }
  await observe('evidence',evidence); await writeFile(join(f.root,'native/evidence.json'),JSON.stringify({role:'evidence'})); await acceptScienceResult({controller,role:'evidence'});
  const results=(await prepareScienceRequests({controller})).find(item=>item.role==='results');
  await observe('results',results.request);
  const source=f.options.prepared.scientificInput.sources[0], output=join(f.root,'resources/results'), image=Buffer.from('image');
  await writeFile(join(output,'figure.png'),image);
  const manifest=Buffer.from(JSON.stringify({version:'reading-resources-1.0',resources:[{id:'fig-1',source_id:source.id,locator:{kind:'pdf-page',page:1},source_path:join(output,'figure.png'),path:'Figures/paper/figure.png',sha256:hash(image),byte_length:image.length,parent:{path:source.path,sha256:source.sha256,byte_length:source.byte_length}}]}));
  await writeFile(join(f.root,'native/results-resources.json'),manifest);
  await writeFile(join(f.root,'native/results.json'),JSON.stringify({role:'results',resource_manifest:{path:join(f.root,'science/results-resources.json'),resources_root:output,sha256:hash(manifest),byte_length:manifest.length}}));
  const optionsPath=join(f.root,'crash-options.json'); await writeFile(optionsPath,JSON.stringify(f.options));
  const driver=`import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const original=fs.promises.link; fs.promises.link=async(...args)=>{await original(...args); if(String(args[1]).replaceAll('\\\\','/').endsWith(process.argv[3])) process.exit(77);}; syncBuiltinESMExports(); const api=await import(process.argv[2]); const c=await api.restoreScienceController(JSON.parse(fs.readFileSync(process.argv[1],'utf8'))); await api.acceptScienceResult({controller:c,role:'results'});`;
  const target=crashAt==='receipt' ? '/.phase21-receipts/results-resources.json' : '/science/results-resources.json';
  const child=spawnSync(process.execPath,['--input-type=module','-e',driver,optionsPath,new URL('../../scripts/v3/science-controller.mjs',import.meta.url).href,target],{encoding:'utf8'});
  assert.equal(child.status,77,child.stderr);
  return {...f,manifest};
}
test('2.2 repairs only the exact manifest after interruption before its receipt', async () => {
  const f=await interruptedManifest();
  const controller=await restoreScienceController(f.options);
  await acceptScienceResult({controller,role:'results'});
  assert.deepEqual(await readFile(join(f.root,'science/results-resources.json')),f.manifest);
  assert.equal(getScienceState(await restoreScienceController(f.options)).roles.results.status,'accepted');
});
test('2.2 refuses an altered orphan manifest after interruption', async () => {
  const f=await interruptedManifest();
  await writeFile(join(f.root,'science/results-resources.json'),'tampered');
  const controller=await restoreScienceController(f.options);
  await assert.rejects(()=>acceptScienceResult({controller,role:'results'}),/RECOVERY_CONTENT_MISMATCH/);
});
test('2.2 reuses an exact manifest receipt written before interruption', async () => {
  const f=await interruptedManifest('receipt');
  const controller=await restoreScienceController(f.options);
  await acceptScienceResult({controller,role:'results'});
  assert.deepEqual(await readFile(join(f.root,'science/results-resources.json')),f.manifest);
});
test('2.2 refuses a changed native manifest after interruption', async () => {
  const f=await interruptedManifest();
  await writeFile(join(f.root,'native/results-resources.json'),'changed');
  await assert.rejects(()=>restoreScienceController(f.options),/SCIENCE_RESOURCE_MANIFEST_CHANGED/);
});
