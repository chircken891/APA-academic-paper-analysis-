import test from 'node:test';
import assert from 'node:assert/strict';
import { createTopicFixture, publishTopicFixture } from './helpers/topic-fixtures.mjs';
import { readCommittedGeneration } from '../../scripts/v3/phase22-active-version.mjs';
import { queryLibrary } from '../../scripts/v3/library-query.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readTopicSources } from '../../scripts/v3/topic-library.mjs';
import { readingFirstPublicationFixture, applyReadingFirstFixture, readingFirstPublicationAuthority } from './helpers/reading-first-publication-fixtures.mjs';
import { applyBilingualPublication, registerBilingualPublication, loadBilingualPublication, dryRunBilingualPublication } from '../../scripts/v3/phase22-publication.mjs';
import { rebuildRegisteredTopicReview } from '../../scripts/v3/topic-publication.mjs';
import { spawnSync } from 'node:child_process';
import { queryBilingualIndex } from '../../scripts/v3/phase22-search.mjs';

test('fresh-process topic loading restores an owned review and refuses minting a live plan', async t => {
  const f = await createTopicFixture(t);
  const publicationUrl = new URL('../../scripts/v3/phase22-publication.mjs', import.meta.url).href;
  const topicUrl = new URL('../../scripts/v3/topic-publication.mjs', import.meta.url).href;
  const code = `import assert from 'node:assert/strict';
    import {loadBilingualPublication,dryRunBilingualPublication} from ${JSON.stringify(publicationUrl)};
    import {assertTopicPublicationReviewCurrent} from ${JSON.stringify(topicUrl)};
    const [vaultRoot,run,anchor]=process.argv.slice(1);
    const loaded=await loadBilingualPublication({vaultRoot,run,trustAnchor:JSON.parse(anchor)});
    assertTopicPublicationReviewCurrent(loaded.review);
    assert.equal(loaded.review.reviewManifest.profile,'phase24-topic-1.0');
    assert.deepEqual(loaded.review.reviewManifest,loaded.reviewManifest);
    assert.equal(loaded.review.hashes.review_bundle_hash,loaded.plan.hashes.review_hash);
    await assert.rejects(dryRunBilingualPublication({vaultRoot,run,review:loaded.review}),/P24_LIVE_SOURCE_REQUIRED/);
    console.log('owned topic review rebuilt');`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, f.vaultRoot, f.run, JSON.stringify(f.registration.trust_anchor)], { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /owned topic review rebuilt/);
});

test('temporary synthetic actual-mode topic hits do not inherit paper scientific approval', async t => {
  const f = await createTopicFixture(t, { evidenceMode: 'actual' });
  const snapshot = await publishTopicFixture(f);
  assert.equal(snapshot.ok, true, JSON.stringify(snapshot.errors));
  const topicOnly = queryBilingualIndex({ index: snapshot.index, activeSnapshot: snapshot, query: 'topiconlytoken' });
  assert.equal(topicOnly.evidence_mode, 'actual');
  assert.equal(topicOnly.results.length, 1);
  assert.equal(topicOnly.results[0].entity_type, 'topic');
  assert.equal(topicOnly.scientific_approval, false);
  assert.equal(topicOnly.results[0].claim_verification, 'not_performed');
  const paperOnly = queryBilingualIndex({ index: snapshot.index, activeSnapshot: snapshot, query: 'abstract' });
  assert.ok(paperOnly.results.length);
  assert.equal(paperOnly.results.every(row => row.entity_type !== 'topic'), true);
  assert.equal(paperOnly.scientific_approval, true);
  const mixed = queryBilingualIndex({ index: snapshot.index, activeSnapshot: snapshot, query: 'supported' });
  assert.equal(mixed.results.some(row => row.entity_type === 'topic'), true);
  assert.equal(mixed.results.some(row => row.paper_id), true);
  assert.equal(mixed.scientific_approval, false);
});

test('explicit topic save registers, restores in a fresh process, and preserves papers', async t => {
  const f = await createTopicFixture(t);
  await assert.rejects(dryRunBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, review: structuredClone(f.review) }), /P22_REVIEW_NOT_OWNED/);
  await assert.rejects(applyBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, plan: f.plan }), /P22_PUBLICATION_CONTROL_REQUIRED/);
  const pending = await queryLibrary({ vaultRoot: f.vaultRoot, query: 'topiconlytoken' });
  assert.equal(pending.results.length, 0, 'candidate is not searchable');
  await publishTopicFixture(f, { freshProcess: true });
  const snapshot = await readCommittedGeneration({ vaultRoot: f.vaultRoot });
  assert.equal(snapshot.ok, true, JSON.stringify(snapshot.errors));
  assert.equal(snapshot.generation.topics.length, 1);
  assert.equal(snapshot.generation.papers.length, 2);
  assert.equal(snapshot.generation.topics[0].dependencies.length, 1);
  const found = await queryLibrary({ vaultRoot: f.vaultRoot, query: 'topiconlytoken' });
  assert.equal(found.results[0].entity_type, 'topic');
  assert.equal(found.results[0].underlying_papers.length, 1);
  const topic = snapshot.generation.topics[0];
  assert.equal(snapshot.index.documents.filter(d => d.entity_type === 'topic').every(d => d.paper_id === undefined && d.core_hash === undefined), true);
  const expanded = await readTopicSources({ vaultRoot: f.vaultRoot, topicId: topic.topic_id, generationId: snapshot.generation_id });
  assert.equal(expanded.ok, true);
  const topicPath = join(f.vaultRoot, topic.path);
  await writeFile(topicPath, (await readFile(topicPath)) + '\nprivatepersonalonlytoken 人工备注。\n');
  assert.equal((await readCommittedGeneration({ vaultRoot: f.vaultRoot })).ok, true, 'human edits preserve committed managed binding');
  assert.equal((await queryLibrary({ vaultRoot: f.vaultRoot, query: 'privatepersonalonlytoken' })).results.length, 0);
  const shared = snapshot.generation.shared_nodes[0];
  const third = await readingFirstPublicationFixture(t, { vaultRoot: f.vaultRoot, generation: 'topic-later-paper',
    runId: 'run_' + 'c'.repeat(32), paperId: 'pap_' + 'c'.repeat(32), title: { en: 'Third paper', 'zh-CN': '第三篇论文' },
    knowledgeRegistry: [{ id: 'method', canonical_key: 'synthetic-method', path: shared.path, content: await readFile(join(f.vaultRoot, shared.path), 'utf8') }] });
  await applyBilingualPublication(applyReadingFirstFixture(third));
  const later = await readCommittedGeneration({ vaultRoot: f.vaultRoot });
  assert.equal(later.ok, true, JSON.stringify(later.errors));
  assert.equal(later.generation.papers.length, 3);
  assert.deepEqual(later.generation.topics, snapshot.generation.topics);
  assert.match(await readFile(topicPath, 'utf8'), /privatepersonalonlytoken/);
  assert.equal((await queryLibrary({ vaultRoot: f.vaultRoot, query: 'topiconlytoken' })).results[0].topic_id, topic.topic_id);
});

test('topic registration rejects bare recipes, candidate edits, and adopted source edits', async t => {
  const f = await createTopicFixture(t, { register: false });
  await assert.rejects(registerBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, plan: f.plan, sourceInputs: {} }), /P24_LIVE_SOURCE_REQUIRED/);
  const registration = await registerBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, plan: f.plan, sourceInputs: f.sourceInputs, ...f.authority });
  const bundle = JSON.parse(await readFile(join(f.vaultRoot, registration.bundle_path)));
  await assert.rejects(rebuildRegisteredTopicReview(bundle.topic_recipe), /P24_REGISTERED_PROOF_REQUIRED/);
  const original = await readFile(f.candidate.note_path);
  await writeFile(f.candidate.note_path, Buffer.concat([original, Buffer.from('changed')]));
  await assert.rejects(loadBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, trustAnchor: registration.trust_anchor }), /P22_REGISTERED_DEPENDENCY_CHANGED/);
  await writeFile(f.candidate.note_path, original);
  const sourcePath = f.currentSnapshot.generation.objects.find(o => o.kind === 'asset' && o.path.endsWith('.pdf')).path;
  await writeFile(join(f.vaultRoot, sourcePath), 'changed source');
  await assert.rejects(loadBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, trustAnchor: registration.trust_anchor }), /P22_REGISTERED_DEPENDENCY_CHANGED/);
});

test('topic source expansion survives an unrelated managed note edit', async t => {
  const f = await createTopicFixture(t);
  const snapshot = await publishTopicFixture(f);
  const topic = snapshot.generation.topics[0];
  const paperPath = join(f.vaultRoot, snapshot.generation.papers[1].paths.en);
  const previous = await readFile(paperPath, 'utf8');
  await writeFile(paperPath, previous.replace('<!-- AUTO:END reading -->', '\nUser changed this explanation.\n<!-- AUTO:END reading -->'));
  const unrelatedSidecar = join(f.vaultRoot, snapshot.generation.papers[1].reader_presentation.path);
  await writeFile(unrelatedSidecar, 'damaged unrelated presentation');
  const expanded = await readTopicSources({ vaultRoot: f.vaultRoot, topicId: topic.topic_id, generationId: snapshot.generation_id });
  assert.equal(expanded.ok, true);
  assert.equal(expanded.sources[0].status, 'historical_reference');
});

test('new topic publication can be prepared while a registered paper contains user edits', async t => {
  const f = await createTopicFixture(t, { register: false });
  const paperPath = join(f.vaultRoot, f.currentSnapshot.generation.papers[1].paths.en);
  const original = await readFile(paperPath, 'utf8');
  const edited = original.replace('<!-- AUTO:END reading -->', '\nA user edit retained.\n<!-- AUTO:END reading -->');
  await writeFile(paperPath, edited);
  const { prepareTopicPublication } = await import('../../scripts/v3/topic-publication.mjs');
  const prepared = await prepareTopicPublication({ vaultRoot: f.vaultRoot, candidate: f.candidate });
  assert.equal(prepared.ok, true);
  const authority = await readingFirstPublicationAuthority({ root: f.root, vaultRoot: f.vaultRoot, runId: f.run }, prepared.plan);
  await registerBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, plan: prepared.plan, sourceInputs: prepared.sourceInputs, ...authority });
  const result = await applyBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, plan: prepared.plan, ...authority });
  assert.equal(result.status, 'committed');
  assert.equal(await readFile(paperPath, 'utf8'), edited);
  const found = await queryLibrary({ vaultRoot: f.vaultRoot, query: 'topiconlytoken' });
  assert.ok(found.results.some(row => row.topic_id === f.candidate.topic.topic_id));
});
