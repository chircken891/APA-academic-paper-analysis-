import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { applyReadingFirstFixture, readingFirstPublicationAuthority, readingFirstPublicationFixture } from './helpers/reading-first-publication-fixtures.mjs';
import { applyBilingualPublication, dryRunBilingualPublication, getBilingualPublicationTrustAnchor } from '../../scripts/v3/phase22-publication.mjs';
import { readCommittedGeneration, readRegisteredCommit, readRegisteredObject } from '../../scripts/v3/phase22-active-version.mjs';
import { buildKnowledgeMergeReview, buildKnowledgeMergeCompensationReview } from '../../scripts/v3/knowledge-merge.mjs';
import { readCurrentVaultContent } from '../../scripts/v3/current-vault-content.mjs';
import { readCommittedReadingFirstKnowledgeRegistry } from '../../scripts/v3/reading-first-knowledge-registry.mjs';
import { buildRegisteredGraphProposal } from '../../scripts/v3/phase22-graph.mjs';
import { checkCommittedIndex } from '../../scripts/check-bm25-index.mjs';

const aliasPath = 'Ontology/knowledge-aliases.json';
const stateOf = bytes => JSON.parse(Buffer.from(/<!-- KNOWLEDGE_STATE ([A-Za-z0-9+/=]+) -->/.exec(bytes.toString())[1], 'base64'));

async function fixture(t, { removedTitle = '第二种方法' } = {}) {
  const first = await readingFirstPublicationFixture(t);
  await applyBilingualPublication(applyReadingFirstFixture(first));
  const presentation = structuredClone(first.presentationCatalog), method = presentation.knowledge[0];
  method.canonical_key = 'second-synthetic-method';
  method.title = { en: 'Second synthetic method', 'zh-CN': removedTitle };
  method.aliases = ['SecondMethodAlias'];
  method.sources = [{ title: 'Second method source', url: 'https://example.com/second-method' }];
  method.paragraphs.en = ['Distinct synthetic qualification and finding.'];
  const second = await readingFirstPublicationFixture(t, { presentation, vaultRoot: first.vaultRoot,
    generation: 'reading-generation-2', runId: 'run_' + 'b'.repeat(32), paperId: 'pap_' + 'b'.repeat(32) });
  await applyBilingualPublication(applyReadingFirstFixture(second));
  const vaultRoot = first.vaultRoot;
  const snapshot = await readCommittedGeneration({ vaultRoot });
  assert.equal(snapshot.ok, true, JSON.stringify(snapshot.errors));
  const keep = first.candidate.supportNotes[0].path, remove = second.candidate.supportNotes[0].path;
  const runId = 'synthetic-knowledge-merge';
  const options = { repoRoot: vaultRoot, runId, generationId: 'knowledge-merge-1',
    merges: [{ keep_path: keep, remove_paths: [remove], append_markdown: '**合并补充 / Merged material**\n\nDistinct synthetic qualification and finding.\n\n- [Second method source](https://example.com/second-method)' }] };
  const publish = async (review, authorized = true) => {
    const run = review.reviewManifest.identity.run_id;
    const { plan } = await dryRunBilingualPublication({ vaultRoot, run, review });
    const authority = authorized ? await readingFirstPublicationAuthority({ ...first, runId: run }, plan) : {};
    return applyBilingualPublication({ vaultRoot, run, plan, ...authority });
  };
  return { vaultRoot, first, second, snapshot, keep, remove, options, publish };
}

test('knowledge merge rewrites registered links and support bindings, records aliases and compensates from exact preimages', async t => {
  const f = await fixture(t);
  const before = new Map();
  const edited = f.first.candidate.notes[0].path;
  const oldName = posix.basename(f.remove, '.md');
  const oldLink = '../methods/' + encodeURIComponent(oldName) + '.md#English';
  const paperBefore = await readFile(join(f.vaultRoot, edited), 'utf8');
  const human = `\nPersonal link [[${oldName}#English|original label]] and [relative](${oldLink})\n\n\`[[${oldName}]]\`\n`;
  await writeFile(join(f.vaultRoot, edited), paperBefore + human);
  for (const item of f.snapshot.generation.objects) before.set(item.path, await readFile(join(f.vaultRoot, item.path)));
  const review = await buildKnowledgeMergeReview(f.options);
  assert.ok(!review.outputInventory.some(row => row.path === f.remove));
  assert.ok(review.reviewManifest.read_dependencies.some(row => row.path === f.remove));
  await assert.rejects(f.publish(review, false), /P22_PUBLICATION_CONTROL_REQUIRED/);
  const committed = await f.publish(review);
  assert.equal(committed.status, 'committed');
  const merged = await readCommittedGeneration({ vaultRoot: f.vaultRoot });
  assert.equal(merged.ok, true, JSON.stringify(merged.errors));
  assert.ok(!merged.generation.shared_nodes.some(row => row.path === f.remove));
  assert.ok(!merged.index.documents.some(row => row.path === f.remove));
  const registered = await readRegisteredCommit({ vaultRoot: f.vaultRoot });
  assert.ok(JSON.parse(readRegisteredObject(registered, aliasPath).bytes).aliases.some(row => row.alias === 'SecondMethodAlias' && row.target_path === f.keep));
  assert.equal((await readCurrentVaultContent({ vaultRoot: f.vaultRoot })).status, 'current');
  const registry = await readCommittedReadingFirstKnowledgeRegistry({ vaultRoot: f.vaultRoot });
  for (const alias of ['SecondMethodAlias', 'second-synthetic-method', '第二种方法']) {
    assert.ok(registry.find(row => row.path === f.keep)?.registered_aliases.includes(alias));
  }
  assert.ok(!registry.some(row => row.path === f.remove));
  assert.equal((await checkCommittedIndex(f.vaultRoot)).status, 'registered_index_valid');
  const graph = buildRegisteredGraphProposal({ activeSnapshot: registered, entityInventory: registered.generation.objects.filter(row => row.path.startsWith('Wiki/')) });
  assert.ok(graph.expectedNodes.includes(f.keep) && !graph.expectedNodes.includes(f.remove));
  const keepBytes = await readFile(join(f.vaultRoot, f.keep));
  assert.match(keepBytes.toString(), /Distinct synthetic qualification/);
  assert.ok(stateOf(keepBytes).item.sources.some(row => row.url === 'https://example.com/second-method'));
  assert.deepEqual(stateOf(keepBytes).applications.map(row => row.paper_id).sort(), [f.first.paperId, f.second.paperId].sort());
  assert.deepEqual(await readFile(join(f.vaultRoot, f.remove)), before.get(f.remove));
  const paperAfter = await readFile(join(f.vaultRoot, edited), 'utf8');
  assert.ok(paperAfter.includes(`[[${f.keep.slice(0, -3)}#English|original label]]`));
  assert.ok(paperAfter.includes(') and [relative](') || paperAfter.includes('|original label]] and [relative]('));
  assert.ok(!paperAfter.includes(oldLink));
  assert.ok(paperAfter.includes('`[[' + oldName + ']]`'));
  const keepPath = f.keep;
  assert.equal(merged.index.documents.filter(row => row.paper_id === f.second.paperId && row.path === keepPath).length, 2);
  const compensation = await buildKnowledgeMergeCompensationReview({ repoRoot: f.vaultRoot, runId: 'synthetic-compensation',
    generationId: 'knowledge-merge-compensated', transactionId: committed.transaction_id });
  assert.equal((await f.publish(compensation)).status, 'committed');
  const restored = await readCommittedGeneration({ vaultRoot: f.vaultRoot });
  assert.equal(restored.ok, true, JSON.stringify(restored.errors));
  assert.deepEqual(restored.generation.shared_nodes, f.snapshot.generation.shared_nodes);
  assert.deepEqual(restored.index.documents, f.snapshot.index.documents);
  assert.ok(!restored.generation.objects.some(row => row.path === aliasPath));
  const restoredRegistry = await readCommittedReadingFirstKnowledgeRegistry({ vaultRoot: f.vaultRoot });
  assert.ok(!(restoredRegistry.find(row => row.path === f.keep)?.registered_aliases ?? []).includes('second-synthetic-method'));
  for (const [path, bytes] of before) assert.deepEqual(await readFile(join(f.vaultRoot, path)), bytes, path);
});

test('knowledge merge retargets balanced and escaped Markdown destinations while preserving anchors and titles', async t => {
  const f = await fixture(t, { removedTitle: '第二种(方法)' });
  const path = f.first.candidate.notes[0].path, absolute = join(f.vaultRoot, path);
  const oldHref = posix.relative(posix.dirname(path), f.remove);
  const newHref = posix.relative(posix.dirname(path), f.keep).split('/').map(encodeURIComponent).join('/');
  const escaped = oldHref.replaceAll('(', '\\(').replaceAll(')', '\\)');
  const title = `"Same title (preserved), example [label](${oldHref})"`;
  const lines = [`[bare label](${oldHref})`, `[titled label]( ${oldHref}#English ${title} )`, `[escaped label](${escaped}#English)`,
    `[angle label](<${oldHref}#English> 'A title')`, '`[code sample](' + oldHref + ')`'];
  await writeFile(absolute, (await readFile(absolute, 'utf8')) + '\n' + lines.join('\n\n') + '\n');
  const review = await buildKnowledgeMergeReview(f.options);
  const paper = review.outputInventory.find(row => row.path === path)?.bytes.toString() ?? await readFile(absolute, 'utf8');
  const expected = [`[bare label](${newHref})`, `[titled label]( ${newHref}#English ${title} )`, `[escaped label](${newHref}#English)`,
    `[angle label](<${newHref}#English> 'A title')`, lines.at(-1)];
  assert.ok(paper.endsWith('\n' + expected.join('\n\n') + '\n'), paper.slice(-850));
});

test('knowledge merge stops on a missing destination anchor and compensation stops on a newer human edit', async t => {
  const f = await fixture(t);
  const path = f.second.candidate.notes[0].path, absolute = join(f.vaultRoot, path);
  const prior = await readFile(absolute, 'utf8');
  await writeFile(absolute, prior + `\n[[${f.remove}#MissingDestination|anchor link]]\n`);
  await assert.rejects(buildKnowledgeMergeReview(f.options), /P22_KNOWLEDGE_MERGE_ANCHOR_MISSING/);
  await writeFile(absolute, prior);
  const committed = await f.publish(await buildKnowledgeMergeReview(f.options));
  const changed = (await readFile(absolute, 'utf8')) + '\nA new personal edit.\n';
  await writeFile(absolute, changed);
  await assert.rejects(buildKnowledgeMergeCompensationReview({ repoRoot: f.vaultRoot, runId: 'synthetic-compensation',
    generationId: 'knowledge-merge-compensated', transactionId: committed.transaction_id }), /P22_KNOWLEDGE_MERGE_POSTIMAGE_CHANGED/);
  assert.equal(await readFile(absolute, 'utf8'), changed);
});

test('compensation preserves an unrelated paper published after the merge and restores only affected preimages', async t => {
  const f = await fixture(t);
  const original = await readFile(join(f.vaultRoot, f.keep));
  const merged = await f.publish(await buildKnowledgeMergeReview(f.options));
  const trustAnchor = getBilingualPublicationTrustAnchor({ vaultRoot: f.vaultRoot, run: f.options.runId });
  const presentation = structuredClone(f.first.presentationCatalog), method = presentation.knowledge[0];
  method.canonical_key = 'third-synthetic-method';
  method.title = { en: 'Third synthetic method', 'zh-CN': '第三种方法' };
  method.aliases = ['ThirdMethodAlias'];
  const unrelated = await readingFirstPublicationFixture(t, { presentation, vaultRoot: f.vaultRoot,
    generation: 'reading-generation-3', runId: 'run_' + 'c'.repeat(32), paperId: 'pap_' + 'c'.repeat(32) });
  await applyBilingualPublication(applyReadingFirstFixture(unrelated));
  const unrelatedPath = unrelated.candidate.notes[0].path, unrelatedBefore = await readFile(join(f.vaultRoot, unrelatedPath));
  const compensation = await buildKnowledgeMergeCompensationReview({ repoRoot: f.vaultRoot, runId: 'synthetic-compensation',
    generationId: 'knowledge-merge-compensated', transactionId: merged.transaction_id, trustAnchor });
  assert.ok(!compensation.outputInventory.some(row => row.path === unrelatedPath));
  assert.equal((await f.publish(compensation)).status, 'committed');
  const restored = await readCommittedGeneration({ vaultRoot: f.vaultRoot });
  assert.equal(restored.ok, true, JSON.stringify(restored.errors));
  assert.equal(restored.generation.papers.length, 3);
  assert.ok(restored.generation.shared_nodes.some(row => row.path === f.remove));
  assert.deepEqual(await readFile(join(f.vaultRoot, unrelatedPath)), unrelatedBefore);
  assert.deepEqual(await readFile(join(f.vaultRoot, f.keep)), original);
});
