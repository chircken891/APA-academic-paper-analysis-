import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTopicFixture, publishTopicFixture } from './helpers/topic-fixtures.mjs';
import { readCurrentVaultContent } from '../../scripts/v3/current-vault-content.mjs';
import { readRegisteredTopicDependency, readTopicSources, validateSourceChangeEvent } from '../../scripts/v3/topic-library.mjs';

async function fixture(t) {
  const f = await createTopicFixture(t);
  const dependency = { ...f.candidate.topic.dependencies[0], adopted_generation_id: 'missing-generation' };
  const snapshot = await readCurrentVaultContent({ vaultRoot: f.vaultRoot });
  return { ...f, dependency, snapshot };
}

test('unchanged adopted source remains readable from current registration after generation changes without history', async t => {
  const f = await fixture(t);
  const result = await readRegisteredTopicDependency({ vaultRoot: f.vaultRoot, dependency: f.dependency, snapshot: f.snapshot });
  assert.equal(result.historical, false);
  assert.equal(result.absolute_path, join(f.vaultRoot, result.source.path));
  assert.equal(f.dependency.adopted_generation_id, 'missing-generation');
});

test('changed source identity or version cannot use current source when old history is unavailable', async t => {
  const f = await fixture(t);
  for (const change of [{ source_sha256: 'sha256:' + '0'.repeat(64) }, { source_version: 'different-version' },
    { analysis_revision: 'different-revision' }, { source_id: 'different-source' }, { locators: [{ kind: 'missing' }] }]) {
    const dependency = { ...f.dependency, ...change };
    await assert.rejects(readRegisteredTopicDependency({ vaultRoot: f.vaultRoot, dependency, snapshot: f.snapshot }),
      error => error.code === 'P24_REGISTERED_HISTORY_UNAVAILABLE');
  }
});

test('a changed current source file is rejected when the registered tuple matches', async t => {
  const f = await fixture(t);
  const source = f.currentSnapshot.generation.objects.find(row => row.kind === 'asset' && row.path.endsWith('.pdf'));
  await writeFile(join(f.vaultRoot, source.path), 'tampered source');
  await assert.rejects(readRegisteredTopicDependency({ vaultRoot: f.vaultRoot, dependency: f.dependency, snapshot: f.snapshot }),
    error => ['P22_OBJECT_HASH_MISMATCH', 'P24_ADOPTED_SOURCE_MISMATCH'].includes(error.code));
});

test('source events use an unchanged topic dependency after its adoption generation', async t => {
  const f = await createTopicFixture(t);
  await publishTopicFixture(f);
  const snapshot = await readCurrentVaultContent({ vaultRoot: f.vaultRoot });
  const topic = snapshot.generation.topics[0], dependency = topic.dependencies[0];
  const event = { event_id: 'synthetic-correction', kind: 'correction', target: {
    paper_id: dependency.paper_id, analysis_revision: dependency.analysis_revision,
    source_id: dependency.source_id, source_sha256: dependency.source_sha256 },
    target_generation_id: dependency.adopted_generation_id, reason: 'Synthetic correction', recorded_from: 'Synthetic source', replacement: null };
  assert.deepEqual(await validateSourceChangeEvent({ vaultRoot: f.vaultRoot, snapshot, event }), event);
  const sources = await readTopicSources({ vaultRoot: f.vaultRoot, topicId: topic.topic_id });
  assert.equal(sources.sources[0].status, 'identity_verified');
  assert.equal(sources.sources[0].adopted_generation_id, dependency.adopted_generation_id);
});

test('an earlier registered source remains readable from existing history after its paper changes', async t => {
  const { cp, mkdir, readFile } = await import('node:fs/promises');
  const { readingFirstPublicationFixture, applyReadingFirstFixture } = await import('./helpers/reading-first-publication-fixtures.mjs');
  const { readCommittedGeneration, readCommittedReadingFirstPresentations } = await import('../../scripts/v3/phase22-active-version.mjs');
  const { applyBilingualPublication } = await import('../../scripts/v3/phase22-publication.mjs');
  const first = await readingFirstPublicationFixture(t, { generation: 'old-source-generation' });
  await applyBilingualPublication(applyReadingFirstFixture(first));
  const original = await readCommittedGeneration({ vaultRoot: first.vaultRoot });
  const row = readCommittedReadingFirstPresentations(original)[0], source = row.presentation.citation.sources[0];
  const dependency = { paper_id: row.paper.paper_id, analysis_revision: row.paper.analysis_revision,
    adopted_generation_id: original.generation_id, source_id: source.source_id, source_sha256: source.sha256,
    source_version: source.source_version ?? null, locators: source.locators, adopted_for: ['historic claim'] };
  const archive = join(first.root, 'saved-old-snapshot');
  await cp(first.vaultRoot, archive, { recursive: true });
  const presentation = structuredClone(first.presentationCatalog);
  presentation.source_pdf = 'Raw/new-version.pdf';
  const shared = original.generation.shared_nodes[0];
  const second = await readingFirstPublicationFixture(t, { vaultRoot: first.vaultRoot, generation: 'new-source-generation',
    runId: 'run_' + 'b'.repeat(32), paperId: first.paperId, analysisRevision: 'revision-new', sourceText: 'New version of the synthetic source.',
    presentation, knowledgeRegistry: [{ id: 'method', canonical_key: 'synthetic-method', path: shared.path,
      content: await readFile(join(first.vaultRoot, shared.path), 'utf8') }] });
  await applyBilingualPublication(applyReadingFirstFixture(second));
  const destination = join(first.vaultRoot, '.apa-v3/phase22/history', original.generation_id, 'snapshot');
  await mkdir(join(destination, '..'), { recursive: true });
  await cp(archive, destination, { recursive: true });
  const result = await readRegisteredTopicDependency({ vaultRoot: first.vaultRoot, dependency });
  assert.equal(result.historical, true);
  assert.equal(result.absolute_path, join(destination, source.path));
  assert.equal((await readFile(result.absolute_path)).toString(), 'Synthetic original source: supported design, finding and limitation.');
});
