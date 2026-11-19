import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir, link, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareConfiguredReading, materializeConfiguredReadingCandidate } from '../../scripts/v3/configured-reading.mjs';
import { reviewedReadingFirstFixture } from './helpers/reading-first-publication-source-fixtures.mjs';
import { inspectReadingFirstSavedCandidate, restoreReadingFirstRuntime, snapshotReadingFirstRuntime } from '../../scripts/v3/reading-first-runtime.mjs';
import { commitOwnedArtifact } from '../../scripts/v3/owned-artifact-store.mjs';
async function configuredRepo(t, enabled = false) {
  const root = await mkdtemp(join(tmpdir(), 'apa-configured-reading-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'config'));
  const guide = join(root, 'humanizer.md');
  await writeFile(guide, 'ENGLISH_OPTIONAL_GUIDANCE: explain concrete actions.');
  const choice = { mode: 'explicit', model: 'gpt-6.1-sol', reasoning_effort: 'low' };
  const config = { schema_version: 'apa-local-config-1.0', models: { science: choice, overrides: { results: { ...choice, reasoning_effort: 'high' } },
    roles: Object.fromEntries(['english-writer','chinese-writer','translation','reading-editor','independent-verifier'].map(role => [role, choice])) },
    paths: { runs: '.tmp/runs', parse: '.tmp/parse', candidates: '.tmp/candidates' }, parser: { runtime_home: join(root, 'mineru') },
    reading: { source_language: 'zh-CN', presentation_mode: 'reading-editor' },
    writing_skills: Object.fromEntries(['nature-writing','nature-polishing','nature-shared','humanizer','humanizer-zh','stss'].map(key => [key, { enabled: enabled && key === 'humanizer', ...(enabled && key === 'humanizer' ? { path: guide } : {}) }])) };
  await writeFile(join(root, 'config/apa.local.json'), JSON.stringify(config));
  const bin = join(root, 'mineru', 'venv', process.platform === 'win32' ? 'Scripts' : 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, process.platform === 'win32' ? 'python.exe' : 'python'), 'synthetic executable presence only');
  await writeFile(join(root, 'mineru', 'config.yaml'), 'synthetic config presence only');
  return { root, config };
}


async function setup(t, { completeReview = true } = {}) {
 const {root} = await configuredRepo(t); const runId='run_'+ 'a'.repeat(32); let prepared;
 const fixture = await reviewedReadingFirstFixture(t,{artifactRoot:join(root,'.tmp/runs',runId),clippingsRoot:join(root,'Clippings'),
  supplementPdf:true,methodsFirst:true,runId,instructionFiles:true,completeReview,createRunControl: options => {prepared=prepareConfiguredReading({...options,repoRoot:root,maxTotalCalls:20});return prepared.runControl;}});
 return {prepared,controller:fixture.controller,handoff:fixture.handoff,resources:fixture.resources,fixture};
}
test('candidate can be recovered only with identical complete bytes', async t=>{
 const {fixture,...args}=await setup(t);
 const originals=args.prepared.runControl.reading_first_binding.configured_setup.source_locations;
 const signature=async source=>{
   const observed=await stat(source.path,{bigint:true});
   return {dev:observed.dev,ino:observed.ino,mtimeNs:observed.mtimeNs,size:observed.size,
     sha256:createHash('sha256').update(await readFile(source.path)).digest('hex')};
 };
 const signatures=await Promise.all(originals.map(signature));
 const first=await materializeConfiguredReadingCandidate(args);
 const checkpoint=snapshotReadingFirstRuntime(args.controller);
 const capability=fixture.broker.issueCapability({runId:fixture.runId,actorId:'controller',role:'control',artifactPath:'checkpoint.json',revision:'1'});
 const receipt=await commitOwnedArtifact({artifactRoot:fixture.root,dispatchContext:fixture.broker.dispatchContext,capability,
   artifact:{artifact_id:'checkpoint',content:JSON.stringify(checkpoint)},expectedRevision:'1'});
 const restored=await restoreReadingFirstRuntime({handoff:args.handoff,runControl:fixture.runControl,checkpointReceipt:receipt});
 assert.equal(restored.ok,true,JSON.stringify(restored.errors));
 const recovered=await materializeConfiguredReadingCandidate({...args,controller:restored.controller,reuseExisting:true});
 assert.equal(recovered.candidate.presentation_fingerprint,first.candidate.presentation_fingerprint);
 assert.equal(recovered.exported.outputRoot,first.exported.outputRoot);
 assert.equal((await inspectReadingFirstSavedCandidate(args)).status,'passed');
 for (const root of [first.staging_root,first.exported.outputRoot,recovered.staging_root]) {
   assert.ok((await readdir(root,{recursive:true})).every(path=>!/\.pdf$/i.test(path)));
   for (const note of first.candidate.notes) {
     const content=await readFile(join(root,note.path),'utf8');
     assert.ok(content.includes('[['+originals[0].vault_path+'|'));
     assert.ok(content.includes('[['+originals[1].vault_path+'#page=2|'));
     assert.doesNotMatch(note.content,/\[\[Clippings\//);
   }
 }
 assert.deepEqual(await Promise.all(originals.map(signature)),signatures);
 await writeFile(join(first.exported.outputRoot,...first.exported.files[0].split('/')),'tampered');
 await assert.rejects(materializeConfiguredReadingCandidate({...args,reuseExisting:true}),/APA_CONFIGURED_CANDIDATE_REUSE_MISMATCH/);
});
test('partial candidate is rejected without overwrite',async t=>{
 const args=await setup(t); await mkdir(args.prepared.paths.candidateRoot,{recursive:true});
 await assert.rejects(materializeConfiguredReadingCandidate({...args,reuseExisting:true}),/APA_CONFIGURED_CANDIDATE_REUSE_MISMATCH/);
});

test('inspection refuses an output alias and reports source drift independently of candidate bytes', async t => {
  const args = await setup(t);
  const { exported } = await materializeConfiguredReadingCandidate(args);
  const source = args.prepared.runControl.reading_first_binding.configured_setup.source_locations[0];
  const original = await readFile(source.path);
  const alias = join(exported.outputRoot, 'shared-source-alias');
  await link(source.path, alias);
  await assert.rejects(inspectReadingFirstSavedCandidate(args), { code: 'RF_READ_ONLY_SOURCE_OUTPUT_CONFLICT' });
  assert.deepEqual(await readFile(source.path), original);
  await unlink(alias);
  await writeFile(source.path, 'External synthetic drift');
  const report = await inspectReadingFirstSavedCandidate(args);
  assert.equal(report.consistency.status, 'passed');
  assert.equal(report.links.code, 'READING_FIRST_SOURCE_CHANGED');
  assert.equal(report.links.details.path, source.path);
});
test('second revision needs a reviewed repair and uses the frozen root',async t=>{
 const args=await setup(t); const forged=structuredClone(args.prepared); forged.paths.candidateRoot += '-forged';
 await assert.rejects(materializeConfiguredReadingCandidate({...args,prepared:forged,candidateRevision:2}),/APA_CONFIGURED_CANDIDATE_BINDING_MISMATCH/);
 await assert.rejects(materializeConfiguredReadingCandidate({...args,candidateRevision:2}),/APA_CONFIGURED_CANDIDATE_REVISION_INVALID/);
});

test('an authorized renderer revision keeps PDF dependencies outside its files', async t => {
  const { fixture, ...args } = await setup(t, { completeReview: false });
  const first = await materializeConfiguredReadingCandidate(args);
  const note = first.candidate.notes.find(row => row.language === 'en');
  await fixture.complete(fixture.reviewRequest, { ...fixture.review, issues: [{
    severity: 'material', kind: 'layout', detail: 'Restore the personal notes heading layout.',
    repair_owner: 'renderer', affected_paths: [note.path],
    repair_scope: { status: 'located', section_ids: ['findings'], knowledge_ids: [], visual_ids: [], editor_fields: [] },
  }] });
  const existingTargets = [{ path: note.path, bytes: Buffer.from(note.content.replace('## Personal Notes', 'Reader note.\n\n## Personal Notes')), managedHash: note.managedHash }];
  const revised = await materializeConfiguredReadingCandidate({ ...args, candidateRevision: 2, existingTargets, targetRegistry: first.candidate.targetRegistry });
  assert.equal((await inspectReadingFirstSavedCandidate(args)).status, 'passed');
  assert.equal(revised.exported.outputRoot, first.exported.outputRoot + '-r2');
  assert.deepEqual(revised.exported.manifest.source_dependencies, first.exported.manifest.source_dependencies);
  const paths = await readdir(revised.exported.outputRoot, { recursive: true });
  assert.ok(paths.every(path => !/\.pdf$/i.test(path)));
});

test('changed resources and extra files reject reuse', async t => {
  const args=await setup(t); const first=await materializeConfiguredReadingCandidate(args);
  const changed=structuredClone(args.resources);
  changed[0]={path:changed[0].path,content:'changed source bytes'};
  await assert.rejects(materializeConfiguredReadingCandidate({...args,resources:changed,reuseExisting:true}),{code:'RF_PREVIEW_PDF_ORIGINAL_REQUIRED'});
  await writeFile(join(first.exported.outputRoot,'unexpected.txt'),'extra');
  await assert.rejects(materializeConfiguredReadingCandidate({...args,reuseExisting:true}),/APA_CONFIGURED_CANDIDATE_REUSE_MISMATCH/);
});
