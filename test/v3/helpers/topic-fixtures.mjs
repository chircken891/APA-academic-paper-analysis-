import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readingFirstPublicationFixture, readingFirstPublicationAuthority, applyReadingFirstFixture } from './reading-first-publication-fixtures.mjs';
import { applyBilingualPublication, registerBilingualPublication } from '../../../scripts/v3/phase22-publication.mjs';
import { readCommittedGeneration, readCommittedReadingFirstPresentations } from '../../../scripts/v3/phase22-active-version.mjs';
import { prepareTopicSave } from '../../../scripts/v3/topic-library.mjs';
import { prepareTopicPublication } from '../../../scripts/v3/topic-publication.mjs';

/** Real original transaction authority with synthetic papers and a temporary vault only. */
export async function createTopicFixture(t, options = {}) {
  const first = await readingFirstPublicationFixture(t, { evidenceMode: options.evidenceMode });
  await applyBilingualPublication(applyReadingFirstFixture(first));
  const original = await readCommittedGeneration({ vaultRoot: first.vaultRoot });
  const shared = original.generation.shared_nodes[0];
  const second = await readingFirstPublicationFixture(t, { vaultRoot: first.vaultRoot, generation: 'topic-papers-2', evidenceMode: options.evidenceMode,
    runId: 'run_' + 'b'.repeat(32), paperId: 'pap_' + 'b'.repeat(32), title: { en: 'Other synthetic paper', 'zh-CN': '另一合成论文' },
    knowledgeRegistry: [{ id: 'method', canonical_key: 'synthetic-method', path: shared.path, content: await readFile(join(first.vaultRoot, shared.path), 'utf8') }] });
  await applyBilingualPublication(applyReadingFirstFixture(second));
  const snapshot = await readCommittedGeneration({ vaultRoot: first.vaultRoot });
  const selected = readCommittedReadingFirstPresentations(snapshot).find(row => row.paper.paper_id === first.paperId);
  const source = selected.presentation.citation.sources[0];
  await mkdir(join(first.vaultRoot, 'config'), { recursive: true });
  await writeFile(join(first.vaultRoot, 'config/apa.local.json'), JSON.stringify({ schema_version: 'apa-local-config-1.0', paths: { candidates: 'candidates' } }));
  const operationId = options.operationId ?? 'topic-save-1';
  const adoptedSources = [{ paper_id: first.paperId, analysis_revision: selected.paper.analysis_revision,
    adopted_generation_id: snapshot.generation_id, source_id: source.source_id, source_sha256: source.sha256,
    source_version: source.source_version ?? null, locators: source.locators, adopted_for: ['answer paragraph 1'] }];
  const saved = await prepareTopicSave({ repoRoot: first.vaultRoot, operationId, question: 'What does the study support?',
    language: 'en', title: options.topicTitle ?? 'Synthetic topic', answer: 'The supported topiconlytoken answer explains the study and limits.',
    queryTerms: options.queryTerms ?? ['supported'], adoptedSources, expectedGenerationId: snapshot.generation_id, saveIntent: 'save' });
  const prepared = await prepareTopicPublication({ vaultRoot: first.vaultRoot, candidate: saved.candidate, operationId });
  const authority = await readingFirstPublicationAuthority({ root: second.root, vaultRoot: first.vaultRoot, runId: operationId }, prepared.plan);
  const registration = options.register === false ? null : await registerBilingualPublication({ vaultRoot: first.vaultRoot, run: operationId,
    plan: prepared.plan, sourceInputs: prepared.sourceInputs, ...authority });
  return { root: second.root, vaultRoot: first.vaultRoot, repoRoot: first.vaultRoot, run: operationId, candidate: saved.candidate,
    saved, papers: [first, second], currentSnapshot: snapshot, ...prepared, authority, registration };
}

export async function publishTopicFixture(f, { freshProcess = false } = {}) {
  if (freshProcess) {
    const url = new URL('../../../scripts/v3/phase22-publication.mjs', import.meta.url).href;
    const code = `import {loadBilingualPublication,applyBilingualPublication} from ${JSON.stringify(url)};
      const [vaultRoot,run,anchor]=process.argv.slice(1);
      const r=await loadBilingualPublication({vaultRoot,run,trustAnchor:JSON.parse(anchor),requireApproval:true});
      console.log(JSON.stringify(await applyBilingualPublication({vaultRoot,run,plan:r.plan,control:r.control,
        approvalRecord:r.authority.approval_record.path,maintenanceWindowRecord:r.authority.maintenance_window_record.path,
        expectedReviewSha256:r.plan.hashes.review_hash,expectedOutputSha256:r.plan.hashes.output_inventory_hash})));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, f.vaultRoot, f.run, JSON.stringify(f.registration.trust_anchor)], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'committed');
  } else assert.equal((await applyBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, plan: f.plan, ...f.authority })).status, 'committed');
  return readCommittedGeneration({ vaultRoot: f.vaultRoot });
}
