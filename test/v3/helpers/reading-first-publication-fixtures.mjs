import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { reviewedReadingFirstFixture } from './reading-first-publication-source-fixtures.mjs';
import { captureReadingFirstPublicationSource } from '../../../scripts/v3/reading-first-runtime.mjs';
import { prepareReadingFirstPublication } from '../../../scripts/v3/reading-first-publication.mjs';
import { registerBilingualPublication } from '../../../scripts/v3/phase22-publication.mjs';
import { createOwnedArtifactBroker } from '../../../scripts/v3/owned-artifact-store.mjs';

const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
export async function readingFirstPublicationFixture(t, options = {}) {
  const f = await reviewedReadingFirstFixture(t, options);
  const vaultRoot = options.vaultRoot ?? join(f.root, 'publication-vault');
  await mkdir(vaultRoot, { recursive: true });
  for (const file of options.seedFiles ?? []) {
    await mkdir(dirname(join(vaultRoot, file.path)), { recursive: true });
    await writeFile(join(vaultRoot, file.path), file.bytes);
  }
  const source = await captureReadingFirstPublicationSource({ controller: f.controller, presentation: f.candidate });
  const prepared = await prepareReadingFirstPublication({ source, vaultRoot, generation: options.generation ?? 'reading-generation-1',
    evidenceMode: 'synthetic', resources: f.resources });
  const authority = await readingFirstPublicationAuthority({ ...f, vaultRoot }, prepared.plan);
  const registration = options.register === false ? null : await registerBilingualPublication({ vaultRoot, run: f.runId,
    plan: prepared.plan, sourceInputs: prepared.sourceInputs, ...authority });
  return { ...f, source, vaultRoot, run: f.runId, ...prepared, authority, registration };
}

export async function readingFirstPublicationAuthority(f, plan) {
  const approvalRecord = join(f.root, 'publication-approval.json'), maintenanceWindowRecord = join(f.root, 'publication-window.json');
  const approval = { schema_version: 'phase22-publication-approval-1.0', authority: 'synthetic-fixture', authorization_id: 'synthetic-reading-publication',
    vault_root: f.vaultRoot, run_id: f.runId, analysis_revision: plan.analysis_revision, evidence_mode: 'synthetic', scope: 'temporary-fixture',
    allowed_actions: ['apply', 'recover'], review_hash: plan.hashes.review_hash, output_inventory_hash: plan.hashes.output_inventory_hash,
    inventory_paths: plan.inventory.map(row => row.path) };
  const window = { schema_version: 'phase22-maintenance-window-1.0', authorization_id: approval.authorization_id,
    vault_root: f.vaultRoot, run_id: f.runId, analysis_revision: plan.analysis_revision, scope: 'temporary-fixture',
    starts_at: new Date(Date.now() - 60000).toISOString(), ends_at: new Date(Date.now() + 3600000).toISOString(), external_readers_acknowledged: true };
  const approvalBytes = Buffer.from(JSON.stringify(approval)), windowBytes = Buffer.from(JSON.stringify(window));
  await writeFile(approvalRecord, approvalBytes); await writeFile(maintenanceWindowRecord, windowBytes);
  const binding = { ...approval, approval_record: { path: approvalRecord, sha256: sha(approvalBytes) },
    maintenance_window_record: { path: maintenanceWindowRecord, sha256: sha(windowBytes) } };
  const broker = createOwnedArtifactBroker({ control_actor_id: 'synthetic-publication-controller', artifact_root: f.root,
    authorized_bindings: [], run_controls: [{ run_id: f.runId, phase22_publication_binding: binding }] });
  return { control: { dispatchContext: broker.dispatchContext, runId: f.runId }, approvalRecord, maintenanceWindowRecord,
    expectedReviewSha256: plan.hashes.review_hash, expectedOutputSha256: plan.hashes.output_inventory_hash };
}

export const applyReadingFirstFixture = f => ({ vaultRoot: f.vaultRoot, run: f.run, plan: f.plan, ...f.authority });
