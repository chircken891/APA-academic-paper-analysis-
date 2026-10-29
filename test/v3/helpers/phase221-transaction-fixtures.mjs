import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { readerPackageFixture, sha } from './phase221-package-fixtures.mjs';
import { snapshotPhase22Runtime } from '../../../scripts/v3/phase22-language.mjs';
import { createOwnedArtifactBroker } from '../../../scripts/v3/owned-artifact-store.mjs';
import { dryRunBilingualPublication, registerBilingualPublication } from '../../../scripts/v3/phase22-publication.mjs';

export async function readerTransactionFixture(t, options = {}) {
  const f = await readerPackageFixture(t, options), run = f.basis.identity.run_id;
  const vaultRoot = options.vaultRoot ?? join(f.artifactRoot, 'reader-publication-vault'); await mkdir(vaultRoot, { recursive: true });
  for (const row of f.existingTargets.filter(row => row.bytes !== null)) {
    await mkdir(dirname(join(vaultRoot, row.path)), { recursive: true }); await writeFile(join(vaultRoot, row.path), row.bytes);
  }
  const checkpoint = snapshotPhase22Runtime(f.created.controller), bytes = Buffer.from(JSON.stringify(checkpoint));
  const expected = { artifact_id: 'reader-publication-checkpoint', path: 'control/reader-publication-checkpoint.json', revision: 'checkpoint-r1',
    role: 'control', owner_actor_id: f.binding.controller_actor_id, sha256: sha(bytes), byte_length: bytes.length };
  const broker = createOwnedArtifactBroker({ control_actor_id: f.binding.controller_actor_id, artifact_root: f.artifactRoot,
    authorized_bindings: [{ run_id: run, actor_id: expected.owner_actor_id, role: 'control', artifact_path: expected.path, revision: expected.revision }],
    run_controls: [{ run_id: run, phase22_language_binding: f.binding, phase22_runtime_checkpoint_binding: expected }] });
  await broker.artifactStore.commitOwnedArtifact({ artifactRoot: f.artifactRoot, dispatchContext: broker.dispatchContext,
    capability: broker.issueCapability({ runId: run, actorId: expected.owner_actor_id, role: 'control', artifactPath: expected.path, revision: expected.revision }),
    expectedRevision: expected.revision, artifact: { artifact_id: expected.artifact_id, content: bytes } });
  const runtimeControl = { ...f.runControl, dispatchContext: broker.dispatchContext };
  const sourceInputs = { basis: f.basis, context: f.context, currentControl: f.currentControl, integratorReceipt: f.integratorReceipt,
    reader: { renderer: { input_mode: 'reader', targetRegistry: f.presentation.manifest.target_registry,
      existingTargets: f.existingTargets.filter(row => row.kind === 'paper' || Object.values(f.paper.paths).includes(row.path)).filter(row => row.bytes !== null),
      presentationOptions: f.effectivePresentationOptions ?? options.presentationOptions ?? {} }, preparation: {},
      historical: options.historical, quantityProofReceipt: f.quantityProofReceipt,
      runtime: { readerInput: f.readerInput, runControl: runtimeControl,
        checkpointReceipt: { artifactRoot: f.artifactRoot, dispatchContext: broker.dispatchContext, runId: run, artifactId: expected.artifact_id } },
      ownedReview: f.ownedReview, review: { existingTargets: f.existingTargets, activeSnapshot: f.activeSnapshot } } };
  const dry = await dryRunBilingualPublication({ vaultRoot, run, review: f.review }); assert.equal(dry.ok, true);
  const authority = await readerPublicationAuthority({ ...f, run, vaultRoot }, dry.plan);
  const registration = options.register === false ? null : await registerBilingualPublication({ vaultRoot, run, plan: dry.plan, sourceInputs, ...authority });
  return { ...f, run, vaultRoot, plan: dry.plan, authority, sourceInputs, registration };
}
export async function readerPublicationAuthority(f, plan) {
  const approvalRecord = join(f.artifactRoot, 'reader-publication-approval.json'), maintenanceWindowRecord = join(f.artifactRoot, 'reader-publication-window.json');
  const approval = { schema_version: 'phase22-publication-approval-1.0', authority: 'synthetic-fixture', authorization_id: 'synthetic-reader-authorization',
    vault_root: f.vaultRoot, run_id: f.run, analysis_revision: f.basis.identity.analysis_revision, evidence_mode: 'synthetic', scope: 'temporary-fixture', allowed_actions: ['apply', 'recover'],
    review_hash: plan.hashes.review_hash, output_inventory_hash: plan.hashes.output_inventory_hash, inventory_paths: plan.inventory.map(row => row.path) };
  const window = { schema_version: 'phase22-maintenance-window-1.0', authorization_id: approval.authorization_id, vault_root: f.vaultRoot, run_id: f.run,
    analysis_revision: f.basis.identity.analysis_revision, starts_at: new Date(Date.now() - 60000).toISOString(), ends_at: new Date(Date.now() + 3600000).toISOString(),
    external_readers_acknowledged: true, scope: 'temporary-fixture' };
  const a = Buffer.from(JSON.stringify(approval)), w = Buffer.from(JSON.stringify(window)); await writeFile(approvalRecord, a); await writeFile(maintenanceWindowRecord, w);
  const binding = { ...approval, approval_record: { path: approvalRecord, sha256: sha(a) }, maintenance_window_record: { path: maintenanceWindowRecord, sha256: sha(w) } };
  const broker = createOwnedArtifactBroker({ control_actor_id: 'synthetic-reader-publication-controller', artifact_root: f.artifactRoot,
    authorized_bindings: [], run_controls: [{ run_id: f.run, phase22_publication_binding: binding }] });
  return { control: { dispatchContext: broker.dispatchContext, runId: f.run }, approvalRecord, maintenanceWindowRecord,
    expectedReviewSha256: plan.hashes.review_hash, expectedOutputSha256: plan.hashes.output_inventory_hash };
}
