import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { reviewedReadingFirstFixture } from './helpers/reading-first-publication-source-fixtures.mjs';
import { readingFirstPublicationAuthority } from './helpers/reading-first-publication-fixtures.mjs';
import { captureReadingFirstPublicationSource } from '../../scripts/v3/reading-first-runtime.mjs';
import { prepareReadingFirstPublication } from '../../scripts/v3/reading-first-publication.mjs';
import { applyBilingualPublication, registerBilingualPublication } from '../../scripts/v3/phase22-publication.mjs';
import { readCommittedGeneration } from '../../scripts/v3/phase22-active-version.mjs';
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

async function fixture(t, options = {}) {
  const f = await reviewedReadingFirstFixture(t, { omitPresentationAssets: true, visualProvenance: true, ...options });
  const vaultRoot = join(f.root, 'publication-vault'); await mkdir(vaultRoot);
  const source = await captureReadingFirstPublicationSource({ controller: f.controller, presentation: f.candidate });
  return { ...f, run: f.runId, vaultRoot, source, args: { source, vaultRoot, resources: f.resources, evidenceMode: 'synthetic' } };
}

test('owned reviewed visual provenance binds exact image bytes to a registered PDF through publication and fresh reload', async t => {
  const f = await fixture(t), frozen = JSON.stringify(f.candidate);
  const prepared = await prepareReadingFirstPublication(f.args);
  assert.equal(JSON.stringify(f.candidate), frozen);
  const authority = await readingFirstPublicationAuthority(f, prepared.plan);
  const registration = await registerBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, plan: prepared.plan, sourceInputs: prepared.sourceInputs, ...authority });
  const moduleUrl = new URL('../../scripts/v3/phase22-publication.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import{loadBilingualPublication}from ${JSON.stringify(moduleUrl)};const r=await loadBilingualPublication({vaultRoot:process.argv[1],run:process.argv[2],trustAnchor:JSON.parse(process.argv[3])});console.log(JSON.stringify(r.plan.hashes));`,
    f.vaultRoot, f.run, JSON.stringify(registration.trust_anchor)], { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr); assert.deepEqual(JSON.parse(child.stdout), prepared.plan.hashes);
  assert.equal((await applyBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, plan: prepared.plan, ...authority })).status, 'committed');
  assert.equal((await readCommittedGeneration({ vaultRoot: f.vaultRoot })).ok, true);
  assert.deepEqual(await readFile(join(f.vaultRoot, f.resources[1].path)), await readFile(f.figure.path));
});

test('an unbound visual or different image bytes cannot become registered merely by supplying a resource mapping', async t => {
  const bare = await fixture(t, { visualProvenance: false });
  await assert.rejects(prepareReadingFirstPublication(bare.args), /RF_PUBLICATION_RESOURCE_UNREGISTERED/);
  const f = await fixture(t), replacement = Buffer.from('Different image with a caller-provided hash');
  await writeFile(f.figure.path, replacement);
  await assert.rejects(prepareReadingFirstPublication({ ...f.args, resources: [f.resources[0], { ...f.resources[1], sha256: sha(replacement), byte_length: replacement.length }] }), /RF_PUBLICATION_RESOURCE_UNREGISTERED/);
});

test('reviewed image provenance still requires its exact registered parent PDF mapping', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareReadingFirstPublication({ ...f.args, resources: [{ ...f.resources[0], path: 'Raw/incorrect-parent.pdf' }, f.resources[1]] }), /RF_PUBLICATION_RESOURCE_UNREGISTERED/);
});
