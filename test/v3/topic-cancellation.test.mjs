import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTopicFixture } from './helpers/topic-fixtures.mjs';
import * as publication from '../../scripts/v3/phase22-publication.mjs';
import { fingerprintV3Json as hash } from '../../scripts/v3/semantic-package-validator.mjs';
import { cancelTopicOperation } from '../../scripts/v3/topic-library.mjs';
import { prepareTopicPublication } from '../../scripts/v3/topic-publication.mjs';

test('unregistered topic cancellation preserves committed bytes and revokes preparation and old registration', async t => {
  const f = await createTopicFixture(t, { register: false });
  const markerPath = join(f.vaultRoot, '.apa-v3/phase22/COMMITTED.json');
  const before = await readFile(markerPath);
  const cancelled = await cancelTopicOperation({ repoRoot: f.vaultRoot, operationId: f.run,
    candidateFingerprint: hash(f.candidate), candidatePath: join(dirname(f.candidate.topic_path), 'candidate.json') });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.business_writes, 0);
  assert.deepEqual(await readFile(markerPath), before);
  await assert.rejects(prepareTopicPublication({ vaultRoot: f.vaultRoot, candidate: f.candidate }), /P24_OPERATION_CANCELLED/);
  await assert.rejects(publication.applyBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, plan: f.plan,
    ...f.authority }), /P24_OPERATION_CANCELLED/);
  await assert.rejects(publication.registerBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, plan: f.plan,
    sourceInputs: f.sourceInputs, ...f.authority }), /P24_OPERATION_CANCELLED/);
  assert.deepEqual(await readFile(markerPath), before);
});

test('registered topic cancellation revokes old owned plans and fresh-process loading without business writes', async t => {
  const f = await createTopicFixture(t);
  const markerPath = join(f.vaultRoot, '.apa-v3/phase22/COMMITTED.json');
  const before = await readFile(markerPath);
  const candidateFingerprint = hash(f.candidate);
  const grant = await publication.createTopicCancellationGrant({ plan: f.plan, candidateFingerprint });
  const inputs = { vaultRoot: f.vaultRoot, operationId: f.run, candidateFingerprint,
    cancellationGrant: grant, trustAnchor: f.registration.trust_anchor };
  assert.equal((await publication.cancelRegisteredTopicOperation(inputs)).status, 'cancelled');
  assert.equal((await publication.cancelRegisteredTopicOperation(inputs)).status, 'cancelled');
  assert.deepEqual(await readFile(markerPath), before);
  await assert.rejects(publication.applyBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, plan: f.plan, ...f.authority }), /P24_OPERATION_CANCELLED/);
  await assert.rejects(publication.registerBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, plan: f.plan,
    sourceInputs: f.sourceInputs, ...f.authority }), /P24_OPERATION_CANCELLED/);
  const url = new URL('../../scripts/v3/phase22-publication.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import assert from 'node:assert/strict';
    import {loadBilingualPublication} from ${JSON.stringify(url)};
    const [vaultRoot,run,anchor]=process.argv.slice(1);
    await assert.rejects(loadBilingualPublication({vaultRoot,run,trustAnchor:JSON.parse(anchor)}),/P24_OPERATION_CANCELLED/);`,
  f.vaultRoot, f.run, JSON.stringify(f.registration.trust_anchor)], { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
});

test('fresh-process topic cancellation cannot mint a replacement Controller key', async t => {
  const f = await createTopicFixture(t);
  const url = new URL('../../scripts/v3/phase22-publication.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import assert from 'node:assert/strict';
    import {loadBilingualPublication,createTopicCancellationGrant} from ${JSON.stringify(url)};
    const [vaultRoot,run,anchor,candidateFingerprint]=process.argv.slice(1);
    const loaded=await loadBilingualPublication({vaultRoot,run,trustAnchor:JSON.parse(anchor)});
    await assert.rejects(createTopicCancellationGrant({plan:loaded.plan,candidateFingerprint}),/P24_CANCELLATION_AUTHORITY_REQUIRED/);`,
  f.vaultRoot, f.run, JSON.stringify(f.registration.trust_anchor), hash(f.candidate)], { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  await assert.rejects(publication.createTopicCancellationGrant({ plan: f.plan, candidateFingerprint: hash({ wrong: true }) }), /P24_CANDIDATE_CHANGED/);
});

test('topic cancellation shares the apply lock and refuses a committed operation', async t => {
  const f = await createTopicFixture(t);
  const candidateFingerprint = hash(f.candidate);
  const cancellationGrant = await publication.createTopicCancellationGrant({ plan: f.plan, candidateFingerprint });
  const inputs = { vaultRoot: f.vaultRoot, operationId: f.run, candidateFingerprint,
    cancellationGrant, trustAnchor: f.registration.trust_anchor };
  let checked = false;
  const applied = await publication.applyBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, plan: f.plan, ...f.authority,
    onPromotionBoundary: async ({ timing }) => {
      if (timing !== 'before' || checked) return;
      checked = true;
      await assert.rejects(publication.cancelRegisteredTopicOperation(inputs), /P24_OPERATION_IN_PROGRESS/);
    } });
  assert.equal(checked, true);
  assert.equal(applied.status, 'committed');
  await assert.rejects(publication.cancelRegisteredTopicOperation(inputs), /P24_ALREADY_COMMITTED/);
});

test('unregistered topic cancellation refuses an apply holding the original publication lock', async t => {
  const f = await createTopicFixture(t, { register: false });
  const statePath = join(dirname(f.candidate.topic_path), 'operation.json');
  const stateBefore = await readFile(statePath);
  let checked = false;
  const applied = await publication.applyBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, plan: f.plan, ...f.authority,
    onPromotionBoundary: async ({ timing }) => {
      if (timing !== 'before' || checked) return;
      checked = true;
      await assert.rejects(cancelTopicOperation({ repoRoot: f.vaultRoot, operationId: f.run,
        candidateFingerprint: hash(f.candidate), candidatePath: join(dirname(f.candidate.topic_path), 'candidate.json') }), /P24_OPERATION_IN_PROGRESS/);
      assert.deepEqual(await readFile(statePath), stateBefore);
    } });
  assert.equal(checked, true);
  assert.equal(applied.status, 'committed');
});

test('unregistered topic cancellation refuses a directly committed operation without changing its envelope', async t => {
  const f = await createTopicFixture(t, { register: false });
  const statePath = join(dirname(f.candidate.topic_path), 'operation.json');
  const stateBefore = await readFile(statePath);
  assert.equal((await publication.applyBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, plan: f.plan, ...f.authority })).status, 'committed');
  const markerPath = join(f.vaultRoot, '.apa-v3/phase22/COMMITTED.json'), before = await readFile(markerPath);
  await assert.rejects(cancelTopicOperation({ repoRoot: f.vaultRoot, operationId: f.run,
    candidateFingerprint: hash(f.candidate), candidatePath: join(dirname(f.candidate.topic_path), 'candidate.json') }), /P24_ALREADY_COMMITTED/);
  assert.deepEqual(await readFile(statePath), stateBefore);
  assert.deepEqual(await readFile(markerPath), before);
});
