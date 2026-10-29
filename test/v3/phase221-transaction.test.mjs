import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { readerTransactionFixture } from './helpers/phase221-transaction-fixtures.mjs';
import { registerBilingualPublication, loadBilingualPublication, dryRunBilingualPublication, applyBilingualPublication, recoverBilingualPublication, prepareBilingualPublicationTrustAnchor, getBilingualPublicationTrustAnchor } from '../../scripts/v3/phase22-publication.mjs';
import { readCommittedGeneration } from '../../scripts/v3/phase22-active-version.mjs';

const apply = f => ({ vaultRoot: f.vaultRoot, run: f.run, plan: f.plan, ...f.authority,
  expectedReviewSha256: f.plan.hashes.review_hash, expectedOutputSha256: f.plan.hashes.output_inventory_hash });

test('Controller public identity can be prepared without writes or grants and later registers with the same key', async t => {
  const f = await readerTransactionFixture(t, { register: false }), scope = { vaultRoot: f.vaultRoot, run: f.run };
  assert.throws(() => getBilingualPublicationTrustAnchor(scope), /P22_CONTROLLER_TRUST_REQUIRED/);
  const before = await readdir(f.artifactRoot, { recursive: true });
  const anchor = prepareBilingualPublicationTrustAnchor(scope);
  assert.deepEqual(prepareBilingualPublicationTrustAnchor(scope), anchor);
  assert.deepEqual(getBilingualPublicationTrustAnchor(scope), anchor);
  assert.deepEqual(Object.keys(anchor).sort(), ['public_key', 'run_id', 'schema_version', 'vault_root']);
  const absentRoot = join(f.vaultRoot, 'not-created-by-key-preparation');
  const otherRoot = prepareBilingualPublicationTrustAnchor({ vaultRoot: absentRoot, run: f.run });
  const otherRun = prepareBilingualPublicationTrustAnchor({ vaultRoot: f.vaultRoot, run: f.run + '-other' });
  assert.notEqual(otherRoot.public_key, anchor.public_key); assert.notEqual(otherRun.public_key, anchor.public_key);
  assert.deepEqual(await readdir(f.artifactRoot, { recursive: true }), before);
  await assert.rejects(lstat(absentRoot), { code: 'ENOENT' });
  await assert.rejects(lstat(join(f.vaultRoot, '.apa-v3')), { code: 'ENOENT' });
  for (const invalid of [{ run: f.run }, { vaultRoot: null, run: f.run }, { vaultRoot: f.vaultRoot, run: '../bad' }]) {
    assert.throws(() => prepareBilingualPublicationTrustAnchor(invalid), /P22_CONTROLLER_TRUST_REQUIRED/);
  }
  const registered = await registerBilingualPublication({ ...scope, plan: f.plan, sourceInputs: f.sourceInputs, ...f.authority });
  assert.deepEqual(registered.trust_anchor, anchor);
  const loaded = await loadBilingualPublication({ ...scope, trustAnchor: anchor });
  assert.deepEqual(loaded.plan.hashes, f.plan.hashes);
});

test('reader registered package reconstructs real producer capabilities and commits the whole inventory', async t => {
  const f = await readerTransactionFixture(t), loaded = await loadBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, trustAnchor: f.registration.trust_anchor });
  assert.deepEqual(loaded.plan.hashes, f.plan.hashes); assert.equal(loaded.reviewManifest.reading_accepted, false);
  const publicationUrl = new URL('../../scripts/v3/phase22-publication.mjs', import.meta.url).href;
  const reload = spawnSync(process.execPath, ['--input-type=module', '-e', `import {loadBilingualPublication} from ${JSON.stringify(publicationUrl)};const r=await loadBilingualPublication({vaultRoot:process.argv[1],run:process.argv[2],trustAnchor:JSON.parse(process.argv[3])});console.log(JSON.stringify({profile:r.reviewManifest.profile,hashes:r.plan.hashes}));`, f.vaultRoot, f.run, JSON.stringify(f.registration.trust_anchor)], { encoding: 'utf8', windowsHide: true });
  assert.equal(reload.status, 0, reload.stderr); assert.deepEqual(JSON.parse(reload.stdout).hashes, f.plan.hashes);
  const result = await applyBilingualPublication(apply(f)); assert.equal(result.status, 'committed');
  const snapshot = await readCommittedGeneration({ vaultRoot: f.vaultRoot }); assert.equal(snapshot.ok, true, JSON.stringify(snapshot.errors));
  for (const language of ['en', 'zh-CN']) assert.deepEqual(await readFile(join(f.vaultRoot, f.paper.paths[language])), f.notes[language]);
  const moduleUrl = new URL('../../scripts/v3/phase22-active-version.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import {readCommittedGeneration} from ${JSON.stringify(moduleUrl)}; const s=await readCommittedGeneration({vaultRoot:process.argv[1]}); console.log(JSON.stringify({ok:s.ok, generation:s.generation_id, errors:s.errors}));`, f.vaultRoot], { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr); assert.equal(JSON.parse(child.stdout).ok, true, child.stdout);
});

test('reader registration requires the explicit live recovery recipe', async t => {
  const f = await readerTransactionFixture(t, { register: false });
  await assert.rejects(registerBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, plan: f.plan, sourceInputs: {} }), /P221_REGISTRATION_RECIPE_REQUIRED/);
});

test('reader registration rejects a different renderer recipe', async t => {
  const f = await readerTransactionFixture(t, { register: false });
  f.sourceInputs.reader.renderer.presentationOptions = { localStyle: true };
  await assert.rejects(registerBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, plan: f.plan, sourceInputs: f.sourceInputs }), /P221_REGISTERED_RUNTIME_REJECTED|P221_REGISTERED_REBUILD_MISMATCH/);
});

test('reader registration rejects an unrelated owned review and runtime', async t => {
  const f = await readerTransactionFixture(t, { register: false });
  const other = await readerTransactionFixture(t, { register: false });
  f.sourceInputs.reader.ownedReview = other.sourceInputs.reader.ownedReview;
  f.sourceInputs.reader.runtime = other.sourceInputs.reader.runtime;
  await assert.rejects(registerBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, plan: f.plan, sourceInputs: f.sourceInputs }), /P221_REVIEW_OWNED_EVIDENCE_CHANGED/);
});

test('reader registration rejects substituted preparation and native evidence', async t => {
  const f = await readerTransactionFixture(t, { register: false });
  f.sourceInputs.reader.preparation = { sourceInventory: [{ paper_id: 'unrelated' }] };
  await assert.rejects(registerBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, plan: f.plan, sourceInputs: f.sourceInputs }), /P221_REVIEW_OWNED_EVIDENCE_CHANGED/);
  f.sourceInputs.reader.preparation = {};
  f.sourceInputs.reader.nativeObservationReceipt = { artifactRoot: f.artifactRoot, artifactId: 'unrelated' };
  await assert.rejects(registerBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, plan: f.plan, sourceInputs: f.sourceInputs }), /P221_NATIVE_CONTROL_REQUIRED|P221_REVIEW_OWNED_EVIDENCE_CHANGED/);
});

test('reader registration rejects a changed runtime checkpoint before binding producer files', async t => {
  const f = await readerTransactionFixture(t, { register: false });
  const path = join(f.artifactRoot, 'control/reader-publication-checkpoint.json');
  const checkpoint = JSON.parse(await readFile(path));
  checkpoint.tasks = [];
  await writeFile(path, JSON.stringify(checkpoint));
  await assert.rejects(registerBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, plan: f.plan, sourceInputs: f.sourceInputs }), /P22_REGISTERED_RECEIPT_MISMATCH/);
});

test('reader registration requires the actual quantity proof used by the presentation', async t => {
  const f = await readerTransactionFixture(t, { ...readerQuantityOptions(), register: false });
  delete f.sourceInputs.reader.renderer.presentationOptions.quantityEquivalence;
  delete f.sourceInputs.reader.quantityProofReceipt;
  await assert.rejects(registerBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, plan: f.plan, sourceInputs: f.sourceInputs }), /P221_QUANTITY_RESTORE_RECEIPT_REQUIRED|P221_REGISTERED_REBUILD_MISMATCH/);
});

test('reader registration rejects a modified runtime input', async t => {
  const f = await readerTransactionFixture(t, { register: false });
  f.sourceInputs.reader.runtime.readerInput = { ...f.sourceInputs.reader.runtime.readerInput, altered: true };
  await assert.rejects(registerBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, plan: f.plan, sourceInputs: f.sourceInputs }), /P221_READER_INPUT_BINDING_INVALID/);
});

for (const kind of ['reader-presentation', 'reading-review', 'reader-record']) test('committed reader rejects changed '+kind, async t => {
  const f = await readerTransactionFixture(t); await applyBilingualPublication(apply(f));
  const row = f.plan.inventory.find(row => row.kind === kind); await writeFile(join(f.vaultRoot, row.path), 'changed');
  const snapshot = await readCommittedGeneration({ vaultRoot: f.vaultRoot }); assert.equal(snapshot.ok, false);
});

test('reader registration rejects replaced current owned evidence and source bytes', async t => {
  const f = await readerTransactionFixture(t);
  await writeFile(join(f.artifactRoot, 'owned/reader-review.json'), '{}');
  await assert.rejects(loadBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, trustAnchor: f.registration.trust_anchor }), /P22_REGISTERED_DEPENDENCY_CHANGED/);
});

test('reader publication protects concurrent human note edits', async t => {
  const f = await readerTransactionFixture(t, { mergeHuman: true });
  const row = f.plan.inventory.find(row => row.kind === 'paper'), path = join(f.vaultRoot, row.path);
  const human = Buffer.concat([await readFile(path), Buffer.from('\nlate human edit\n')]); await writeFile(path, human);
  await assert.rejects(applyBilingualPublication(apply(f)), /P22_PUBLICATION_PREIMAGE_CHANGED/); assert.deepEqual(await readFile(path), human);
});


test('reader source and owned checkpoint corruption invalidate registration', async t => {
  for (const select of [f => f.currentControl.registry[f.currentControl.scientific_input_artifact_id].path, () => 'control/reader-publication-checkpoint.json']) {
    const f = await readerTransactionFixture(t); await writeFile(join(f.artifactRoot, select(f)), '{}');
    await assert.rejects(loadBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, trustAnchor: f.registration.trust_anchor }), /P22_REGISTERED_DEPENDENCY_CHANGED/);
  }
});

test('reader missing presentation and approval/hash mismatch do not expose a generation', async t => {
  const f = await readerTransactionFixture(t);
  await assert.rejects(applyBilingualPublication({ ...apply(f), expectedReviewSha256: 'sha256:' + '0'.repeat(64) }), /P22_PUBLICATION_APPROVAL_HASH_REQUIRED/);
  await writeFile(f.authority.approvalRecord, '{"revoked":true}');
  await assert.rejects(applyBilingualPublication(apply(f)), /P22_APPROVAL_RECORD_CHANGED/);
  assert.equal((await readCommittedGeneration({ vaultRoot: f.vaultRoot })).ok, false);
  const g = await readerTransactionFixture(t); await applyBilingualPublication(apply(g));
  await unlink(join(g.vaultRoot, g.presentation.manifest.targets.presentation));
  assert.equal((await readCommittedGeneration({ vaultRoot: g.vaultRoot })).ok, false);
});

test('reader crash between sidecar and notes recovers in a different process without visible half package', async t => {
  const f = await readerTransactionFixture(t, { mergeHuman: true });
  const moduleUrl = new URL('../../scripts/v3/phase22-publication.mjs', import.meta.url).href;
  const code = `import {loadBilingualPublication,applyBilingualPublication} from ${JSON.stringify(moduleUrl)};
    const [vaultRoot,run,anchor]=process.argv.slice(1),r=await loadBilingualPublication({vaultRoot,run,trustAnchor:JSON.parse(anchor),requireApproval:true});
    await applyBilingualPublication({vaultRoot,run,plan:r.plan,control:r.control,approvalRecord:r.authority.approval_record.path,maintenanceWindowRecord:r.authority.maintenance_window_record.path,
      expectedReviewSha256:r.plan.hashes.review_hash,expectedOutputSha256:r.plan.hashes.output_inventory_hash,
      onPersistentBoundary:async event=>{if(event.operation==='target.link'&&event.timing==='after'&&event.path===${JSON.stringify(f.presentation.manifest.targets.presentation)}){process.send({cut:true});await new Promise(()=>{});}}});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, f.vaultRoot, f.run, JSON.stringify(f.registration.trust_anchor)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let stderr = '', killed = false; child.stderr.on('data', bytes => { stderr += bytes; });
  child.on('message', event => { if (event.cut) { killed = true; child.kill('SIGKILL'); } });
  const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  assert.equal(killed, true, stderr); assert.equal(status.signal, 'SIGKILL', stderr);
  assert.equal((await readCommittedGeneration({ vaultRoot: f.vaultRoot })).ok, false);
  const recoveryCode = `import {recoverBilingualPublication} from ${JSON.stringify(moduleUrl)};console.log(JSON.stringify(await recoverBilingualPublication({vaultRoot:process.argv[1],run:process.argv[2],trustAnchor:JSON.parse(process.argv[3]),transactionId:process.argv[4]})));`;
  const recovery = spawnSync(process.execPath, ['--input-type=module', '-e', recoveryCode, f.vaultRoot, f.run, JSON.stringify(f.registration.trust_anchor), f.registration.transaction_id], { encoding: 'utf8', windowsHide: true });
  assert.equal(recovery.status, 0, recovery.stderr); assert.equal(JSON.parse(recovery.stdout).status, 'rolled_back');
  for (const row of f.existingTargets.filter(row => row.bytes !== null)) assert.deepEqual(await readFile(join(f.vaultRoot, row.path)), row.bytes);
  assert.equal((await readCommittedGeneration({ vaultRoot: f.vaultRoot })).ok, false);
  for (const receipt of Object.values(f.currentControl.registry)) assert.ok(await readFile(join(f.artifactRoot, receipt.path)));
});


import { inspectManagedNote } from '../../scripts/v3/phase22-managed-markdown.mjs';
import { sha, readerAssetOptions, readerQuantityOptions } from './helpers/phase221-package-fixtures.mjs';

test('reader regenerates a second committed generation with exact support reuse and both human notes', async t => {
  const f = await readerTransactionFixture(t, { mergeHuman: true }); await applyBilingualPublication(apply(f));
  const committedSnapshot = await readCommittedGeneration({ vaultRoot: f.vaultRoot }); assert.equal(committedSnapshot.ok, true);
  const support = f.presentation.supportNotes[0], supportPath = support.target_path ?? support.path, supportBytes = await readFile(join(f.vaultRoot, supportPath));
  const existingTargets = await Promise.all(Object.values(f.paper.paths).map(async path => { const bytes = await readFile(join(f.vaultRoot, path)); return { path, bytes, managedHash: inspectManagedNote(bytes).managedHash }; }));
  const g = await readerTransactionFixture(t, { vaultRoot: f.vaultRoot, generation: 'reader-package-g2', previousGeneration: f.built.generation.generation_id,
    existingTargets, fixtureOptions: { contextOptions: { committedSnapshot, mutate({ entities, data }) {
      entities[0].existing_support = { vault_root: f.vaultRoot, target_path: supportPath, byte_sha256: sha(supportBytes), existing_entity_id: entities[0].entity_id,
        definition_text: data.scientific_details.explanations[0].meaning_plain, compatibility_reason: 'Reuses the exact already committed synthetic definition and its unchanged scope.' };
    } } } });
  assert.ok(g.review.reviewManifest.read_dependencies.some(row => row.path === supportPath));
  const loaded = await loadBilingualPublication({ vaultRoot: g.vaultRoot, run: g.run, trustAnchor: g.registration.trust_anchor }); assert.deepEqual(loaded.plan.hashes, g.plan.hashes);
  await applyBilingualPublication(apply(g));
  const final = await readCommittedGeneration({ vaultRoot: g.vaultRoot }); assert.equal(final.ok, true, JSON.stringify(final.errors)); assert.equal(final.generation_id, 'reader-package-g2');
  assert.deepEqual(await readFile(join(g.vaultRoot, supportPath)), supportBytes);
  for (const path of Object.values(g.paper.paths)) assert.match((await readFile(join(g.vaultRoot, path))).toString(), /Personal observation 保留我的笔记。/);
  assert.equal(g.plan.inventory.some(row => row.kind === 'history'), false);
});


test('reader assets retain source-owned capture and deployed corruption rejects the full generation', async t => {
  const f = await readerTransactionFixture(t, readerAssetOptions());
  const bundle = JSON.parse(await readFile(join(f.vaultRoot, f.registration.bundle_path), 'utf8'));
  const binding = f.currentControl.registry['reader-source-image'];
  assert.ok(bundle.source_bindings.some(row => row.path === join(f.artifactRoot, binding.path)));
  assert.ok(bundle.source_bindings.some(row => row.path === join(f.artifactRoot, '.phase21-receipts', 'reader-source-image.json')));
  await applyBilingualPublication(apply(f));
  assert.equal((await readCommittedGeneration({ vaultRoot: f.vaultRoot })).ok, true);
  const asset = f.plan.inventory.find(row => row.kind === 'asset'); await writeFile(join(f.vaultRoot, asset.path), 'foreign paper image');
  assert.equal((await readCommittedGeneration({ vaultRoot: f.vaultRoot })).ok, false);
  await writeFile(join(f.artifactRoot, binding.path), 'source asset changed');
  await assert.rejects(loadBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, trustAnchor: f.registration.trust_anchor }), /P22_REGISTERED_DEPENDENCY_CHANGED/);
});

test('reader wrong paper or language owned return cannot be registered as the reviewed package', async t => {
  const f = await readerTransactionFixture(t, { register: false });
  const recipe = f.sourceInputs.reader;
  recipe.ownedReview = { ...recipe.ownedReview, value: { ...recipe.ownedReview.value, identity: { ...recipe.ownedReview.value.identity, paper_id: 'foreign-paper' } } };
  await assert.rejects(registerBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, plan: f.plan, sourceInputs: f.sourceInputs }), /P221_REVIEW_OWNED_EVIDENCE_CHANGED/);
  const g = await readerTransactionFixture(t, { register: false });
  const path = join(g.artifactRoot, g.tasks.en.artifact_path), view = JSON.parse(await readFile(path, 'utf8')); view.language = 'zh-CN'; await writeFile(path, JSON.stringify(view));
  await assert.rejects(registerBilingualPublication({ vaultRoot: g.vaultRoot, run: g.run, plan: g.plan, sourceInputs: g.sourceInputs }), /P22_OWNED_BYTES_MISMATCH/);
});


test('registered reader still refuses owned source changes during approved promotion and rolls back human notes', async t => {
  const f = await readerTransactionFixture(t, { mergeHuman: true }); let changed = false;
  const source = f.currentControl.registry[f.currentControl.scientific_input_artifact_id];
  await assert.rejects(applyBilingualPublication({ ...apply(f), onPersistentBoundary: async event => {
    if (event.operation === 'commit.link' && event.timing === 'before') { changed = true; await writeFile(join(f.artifactRoot, source.path), '{}'); }
  } }), /P22_REGISTERED_DEPENDENCY_CHANGED/);
  assert.equal(changed, true);
  for (const row of f.existingTargets.filter(row => row.bytes !== null)) assert.deepEqual(await readFile(join(f.vaultRoot, row.path)), row.bytes);
  assert.equal((await readCommittedGeneration({ vaultRoot: f.vaultRoot })).ok, false);
});


import { createRegisteredHistoricalFixture } from './helpers/phase221-fixtures.mjs';
import { readHistoricalReaderInput } from '../../scripts/v3/phase221-historical-input.mjs';

test('verified historical source chain survives current reader registration and fresh owned-runtime restoration', async t => {
  const old = await createRegisteredHistoricalFixture(t, readerAssetOptions().fixtureOptions.contextOptions);
  const historicalSourceInput = await readHistoricalReaderInput(old.args);
  const f = await readerTransactionFixture(t, { historicalSourceInput, historical: old.args,
    fixtureOptions: { existingContextFixture: old, namespace: 'reader_current_' }, mutateView: readerAssetOptions().mutateView });
  assert.equal(f.presentation.manifest.dependencies.registration, old.registered.bundle_sha256);
  const loaded = await loadBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, trustAnchor: f.registration.trust_anchor });
  assert.deepEqual(loaded.plan.hashes, f.plan.hashes);
  const bundle = JSON.parse(await readFile(join(f.vaultRoot, f.registration.bundle_path), 'utf8'));
  assert.ok(bundle.source_bindings.some(row => row.path === historicalSourceInput.registration.pointer.path));
  assert.ok(bundle.source_bindings.some(row => row.path === historicalSourceInput.registration.bundle.path));
  const original = await readFile(historicalSourceInput.registration.bundle.path);
  await applyBilingualPublication(apply(f));
  assert.deepEqual(await readFile(historicalSourceInput.registration.bundle.path), original);
  assert.equal((await readCommittedGeneration({ vaultRoot: f.vaultRoot })).ok, true);
});

test('owned quantity equivalence is re-admitted from its actual Integrator receipt on registered load', async t => {
  const f = await readerTransactionFixture(t, readerQuantityOptions());
  assert.ok(f.quantityProofReceipt);
  const loaded = await loadBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, trustAnchor: f.registration.trust_anchor });
  assert.deepEqual(loaded.plan.hashes, f.plan.hashes);
  assert.ok(f.presentation.manifest.ranges.some(row => row.display_transforms.some(value => value.rule === 'integer-thousands-separator')));
  const ref = f.quantityProofReceipt, receiptPath = join(ref.artifactRoot, '.phase21-receipts', encodeURIComponent(ref.artifactId) + '.json');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  await writeFile(join(ref.artifactRoot, receipt.path), '{}');
  await assert.rejects(loadBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, trustAnchor: f.registration.trust_anchor }), /P22_REGISTERED_DEPENDENCY_CHANGED/);
});


test('optional reader style persists in the complete transaction and deployed CSS changes invalidate it', async t => {
  const f = await readerTransactionFixture(t, { presentationOptions: { localStyle: true } });
  const bundle = JSON.parse(await readFile(join(f.vaultRoot, f.registration.bundle_path), 'utf8'));
  assert.ok(bundle.tool_bindings.some(row => row.path.replaceAll('\\', '/').endsWith('/Templates/apa-v3/apa-readable.css')));
  const loaded = await loadBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, trustAnchor: f.registration.trust_anchor }); assert.deepEqual(loaded.plan.hashes, f.plan.hashes);
  await applyBilingualPublication(apply(f));
  assert.equal((await readCommittedGeneration({ vaultRoot: f.vaultRoot })).ok, true);
  const style = f.plan.inventory.find(row => row.kind === 'reader-style'); assert.ok(style);
  assert.deepEqual(await readFile(join(f.vaultRoot, style.path)), f.presentation.stylesheet.bytes);
  await writeFile(join(f.vaultRoot, style.path), '/* changed deployed style */');
  assert.equal((await readCommittedGeneration({ vaultRoot: f.vaultRoot })).ok, false);
});
