import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareConfiguredReading, materializeConfiguredReadingCandidate } from '../../scripts/v3/configured-reading.mjs';
import { reviewedReadingFirstFixture } from './helpers/reading-first-publication-source-fixtures.mjs';
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


async function setup(t) {
 const {root} = await configuredRepo(t); const runId='run_'+ 'a'.repeat(32); let prepared;
 const fixture = await reviewedReadingFirstFixture(t,{artifactRoot:join(root,'.tmp/runs',runId),runId,createRunControl: options => {prepared=prepareConfiguredReading({...options,repoRoot:root,instructionProfile:'configured-reading-2.0'});return prepared.runControl;}});
 return {prepared,controller:fixture.controller,handoff:fixture.handoff,resources:fixture.resources};
}
test('candidate can be recovered only with identical complete bytes', async t=>{
 const args=await setup(t); const first=await materializeConfiguredReadingCandidate(args);
 const recovered=await materializeConfiguredReadingCandidate({...args,reuseExisting:true});
 assert.equal(recovered.candidate.presentation_fingerprint,first.candidate.presentation_fingerprint);
 assert.equal(recovered.exported.outputRoot,first.exported.outputRoot);
 await writeFile(join(first.exported.outputRoot,...first.exported.files[0].split('/')),'tampered');
 await assert.rejects(materializeConfiguredReadingCandidate({...args,reuseExisting:true}),/APA_CONFIGURED_CANDIDATE_REUSE_MISMATCH/);
});
test('partial candidate is rejected without overwrite',async t=>{
 const args=await setup(t); await mkdir(args.prepared.paths.candidateRoot,{recursive:true});
 await assert.rejects(materializeConfiguredReadingCandidate({...args,reuseExisting:true}),/APA_CONFIGURED_CANDIDATE_REUSE_MISMATCH/);
});
test('second revision needs a reviewed repair and uses the frozen root',async t=>{
 const args=await setup(t); const forged=structuredClone(args.prepared); forged.paths.candidateRoot += '-forged';
 await assert.rejects(materializeConfiguredReadingCandidate({...args,prepared:forged,candidateRevision:2}),/APA_CONFIGURED_CANDIDATE_BINDING_MISMATCH/);
 await assert.rejects(materializeConfiguredReadingCandidate({...args,candidateRevision:2}),/APA_CONFIGURED_CANDIDATE_REVISION_INVALID/);
});

test('changed resources and extra files reject reuse', async t => {
  const args=await setup(t); const first=await materializeConfiguredReadingCandidate(args);
  const changed=structuredClone(args.resources);
  changed[0]={path:changed[0].path,content:'changed source bytes'};
  await assert.rejects(materializeConfiguredReadingCandidate({...args,resources:changed,reuseExisting:true}),/APA_CONFIGURED_CANDIDATE_REUSE_MISMATCH/);
  await writeFile(join(first.exported.outputRoot,'unexpected.txt'),'extra');
  await assert.rejects(materializeConfiguredReadingCandidate({...args,reuseExisting:true}),/APA_CONFIGURED_CANDIDATE_REUSE_MISMATCH/);
});
