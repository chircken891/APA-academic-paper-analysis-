import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, cp, mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { fingerprintV3Json } from '../../scripts/v3/semantic-package-validator.mjs';
import { createRegisteredHistoricalFixture } from './helpers/phase221-fixtures.mjs';
import { readHistoricalReaderInput, assertHistoricalReaderInputCurrent } from '../../scripts/v3/phase221-historical-input.mjs';
import { getReadingBasisContent } from '../../scripts/v3/phase22-input.mjs';
import { getAcceptedLanguageRecord } from '../../scripts/v3/phase22-language.mjs';

test('real signed producer registration survives disk and fresh-process historical consumption', async t => {
  const f = await createRegisteredHistoricalFixture(t);
  const pointer = JSON.parse(await readFile(join(f.vaultRoot, f.registered.registration_path)));
  const bundle = JSON.parse(await readFile(join(f.vaultRoot, pointer.bundle.path)));
  assert.equal(bundle.schema_version, 'phase22-registered-publication-2.0');
  const input = await readHistoricalReaderInput(f.args);
  assert.equal(input.schema_version, 'phase221-historical-reader-input-1.0');
  assert.deepEqual(input.core, f.data.core);
  assert.deepEqual(input.views.en, f.views.en);
  assert.equal(input.qualification.provenance_limits.actual_observable_identity, 'unknown');
  assert.equal(await assertHistoricalReaderInputCurrent(input), true);
  assert.throws(() => getReadingBasisContent(input), { code: 'P22_BASIS_NOT_ADMITTED' });
  assert.throws(() => getAcceptedLanguageRecord(input.views.en));
  await assert.rejects(assertHistoricalReaderInputCurrent(JSON.parse(JSON.stringify(input))), { code: 'P221_HISTORY_NOT_VERIFIED' });
  const code = `import {readHistoricalReaderInput} from ${JSON.stringify(new URL('../../scripts/v3/phase221-historical-input.mjs', import.meta.url).href)};const x=await readHistoricalReaderInput(JSON.parse(process.argv[1]));console.log(JSON.stringify({schema:x.schema_version,core:x.core,views:x.views}));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, JSON.stringify(f.args)], { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout).views, input.views);
  const outputPath = join(f.vaultRoot, bundle.plan.inventory[0].output_path);
  const original = await readFile(outputPath);
  await writeFile(outputPath, Buffer.concat([original, Buffer.from('tampered')]));
  await assert.rejects(assertHistoricalReaderInputCurrent(input), { code: 'P221_HISTORY_DEPENDENCY_CHANGED' });
  await assert.rejects(readHistoricalReaderInput(f.args), { code: 'P221_HISTORY_OUTPUT_CHANGED' });
});

test('signed legacy embedded-output registration remains readable', async t => {
  const f = await createRegisteredHistoricalFixture(t);
  const pointerPath = join(f.vaultRoot, f.registered.registration_path);
  const pointer = JSON.parse(await readFile(pointerPath));
  const bundlePath = join(f.vaultRoot, pointer.bundle.path);
  const bundle = JSON.parse(await readFile(bundlePath));
  bundle.schema_version = 'phase22-registered-publication-1.0';
  bundle.plan.inventory = await Promise.all(bundle.plan.inventory.map(async ({ output_path, ...row }) => ({
    ...row, bytes_base64: (await readFile(join(f.vaultRoot, output_path))).toString('base64'),
  })));
  const bundleBytes = Buffer.from(JSON.stringify(bundle));
  await writeFile(bundlePath, bundleBytes);
  const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicBytes = publicKey.export({ type: 'spki', format: 'der' });
  pointer.bundle.sha256 = sha(bundleBytes);
  pointer.authority = null;
  const { controller_grant: ignored, ...body } = pointer;
  const payload = { schema_version: 'phase22-controller-grant-1.0', kind: 'registration', vault_root: f.vaultRoot,
    run_id: f.run, registration_hash: fingerprintV3Json(body) };
  pointer.controller_grant = { payload, key_fingerprint: sha(publicBytes),
    signature: sign(null, Buffer.from(fingerprintV3Json(payload)), privateKey).toString('base64') };
  await writeFile(pointerPath, JSON.stringify(pointer));
  const trustAnchor = { ...f.args.trustAnchor, public_key: publicBytes.toString('base64') };
  const input = await readHistoricalReaderInput({ ...f.args, registration: { vaultRoot: f.vaultRoot, run: f.run }, trustAnchor });
  assert.deepEqual(input.core, f.data.core);
  assert.deepEqual(input.views.en, f.views.en);
});

test('trusted anchor, source ownership, receipts and immutable payload are mandatory', async t => {
  const f = await createRegisteredHistoricalFixture(t);
  await assert.rejects(readHistoricalReaderInput({ ...f.args, trustAnchor: undefined }), { code: 'P221_HISTORY_TRUST_REQUIRED' });
  await assert.rejects(readHistoricalReaderInput({ ...f.args, sourceRoots: [f.vaultRoot] }), { code: 'P221_HISTORY_SOURCE_OUTSIDE_ROOTS' });
  const input = await readHistoricalReaderInput(f.args);
  const pointerPath = join(f.vaultRoot, f.registered.registration_path);
  const pointer = JSON.parse(await readFile(pointerPath));
  const bundle = JSON.parse(await readFile(join(f.vaultRoot, pointer.bundle.path)));
  const targets = [pointerPath, join(f.vaultRoot, pointer.bundle.path),
    bundle.source_bindings.find(x => x.path.includes('.phase21-receipts')).path,
    bundle.source_bindings.find(x => !x.path.includes('.phase21-receipts')).path];
  for (const path of targets) {
    const before = await readFile(path);
    try {
      await writeFile(path, Buffer.concat([before, Buffer.from(' ')]));
      await assert.rejects(assertHistoricalReaderInputCurrent(input), { code: 'P221_HISTORY_DEPENDENCY_CHANGED' });
      if (path !== pointerPath) await assert.rejects(readHistoricalReaderInput(f.args));
    } finally { await writeFile(path, before); }
  }
  const original = await readFile(pointerPath);
  try {
    pointer.controller_grant.signature = Buffer.alloc(64).toString('base64');
    await writeFile(pointerPath, JSON.stringify(pointer));
    await assert.rejects(readHistoricalReaderInput(f.args), { code: 'P221_HISTORY_SIGNATURE_INVALID' });
  } finally { await writeFile(pointerPath, original); }
});

test('isolated tool drift survives historical fresh-process reading while original current restore rejects', async t => {
  const root = await mkdtemp(join(tmpdir(), 'p221-tool-drift-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('p221-tool-drift-'));
    await rm(root, { recursive: true, force: true });
  });
  const checkout = fileURLToPath(new URL('../../', import.meta.url));
  for (const dir of ['scripts', 'Schema', 'prompts', 'test/v3/helpers', 'test/v3/fixtures']) {
    await mkdir(dirname(join(root, dir)), { recursive: true });
    await cp(join(checkout, dir), join(root, dir), { recursive: true });
  }
  await symlink(join(checkout, 'node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const isolated = await import(pathToFileURL(join(root, 'test/v3/helpers/phase221-fixtures.mjs')));
  const f = await isolated.createRegisteredHistoricalFixture(t);
  const toolPath = join(root, 'scripts/v3/phase22-render.mjs');
  await writeFile(toolPath, Buffer.concat([await readFile(toolPath), Buffer.from('\n// Synthetic current-tool upgrade, only in an isolated temporary copy.\n')]));
  const code = `import {readHistoricalReaderInput} from ${JSON.stringify(new URL('../../scripts/v3/phase221-historical-input.mjs', import.meta.url).href)};
    import {loadBilingualPublication} from ${JSON.stringify(new URL('../../scripts/v3/phase22-publication.mjs', import.meta.url).href)};
    const args=JSON.parse(process.argv[1]);const result=await readHistoricalReaderInput(args);let current;
    try{await loadBilingualPublication({vaultRoot:args.registration.vaultRoot,run:args.registration.run,trustAnchor:args.trustAnchor});current='accepted';}catch(e){current=e.code;}
    console.log(JSON.stringify({historical:result.schema_version,drift:result.tool_drift,current}));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, JSON.stringify(f.args)], { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.historical, 'phase221-historical-reader-input-1.0');
  assert.equal(result.drift.length, 1);
  assert.equal(result.drift[0].path, toolPath);
  assert.equal(result.drift[0].status, 'changed');
  assert.equal(result.current, 'P22_REGISTERED_DEPENDENCY_CHANGED');
  // A changed schema cannot be silently treated as the original version.
  const schema = join(root, 'Schema/phase22/language-view.schema.json');
  await writeFile(schema, Buffer.concat([await readFile(schema), Buffer.from(' ')]));
  await assert.rejects(readHistoricalReaderInput(f.args), { code: 'P221_HISTORY_SCHEMA_VERSION_UNAVAILABLE' });
});
