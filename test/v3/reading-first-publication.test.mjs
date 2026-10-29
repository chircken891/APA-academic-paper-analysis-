import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { reviewedReadingFirstFixture } from './helpers/reading-first-publication-source-fixtures.mjs';
import { buildBilingualReview } from '../../scripts/v3/phase22-review.mjs';
import { captureReadingFirstPublicationSource } from '../../scripts/v3/reading-first-runtime.mjs';
import { readingFirstPublicationFixture, applyReadingFirstFixture } from './helpers/reading-first-publication-fixtures.mjs';
import { applyBilingualPublication, recoverBilingualPublication, loadBilingualPublication, registerBilingualPublication, dryRunBilingualPublication } from '../../scripts/v3/phase22-publication.mjs';
import { readCommittedGeneration } from '../../scripts/v3/phase22-active-version.mjs';
import { queryBilingualIndex } from '../../scripts/v3/phase22-search.mjs';
import { buildGraphProposal } from '../../scripts/v3/phase22-graph.mjs';
import { inspectManagedNote } from '../../scripts/v3/phase22-managed-markdown.mjs';
import { buildReadingFirstPublicationReview, rebuildRegisteredReadingFirstReview, prepareReadingFirstPublication } from '../../scripts/v3/reading-first-publication.mjs';

test('publication CLI accepts the current reading-first profile before loading a registration', async t => {
  const root = await mkdtemp(join(tmpdir(), 'apa-reading-publication-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = new URL('../../scripts/v3/bilingual.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [fileURLToPath(cli),
    'review', '--vault-root', root, '--run', 'reading-run', '--profile', 'reading-first-obsidian-1.0'],
  { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.stdout.trim(), result.stderr);
  assert.equal(JSON.parse(result.stdout).error.code, 'P22_RUN_NOT_REGISTERED');
});

test('accepted reading output registers, reloads in another process, publishes and enters both-language search and graph', async t => {
  const f = await readingFirstPublicationFixture(t);
  const url = new URL('../../scripts/v3/phase22-publication.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {loadBilingualPublication} from ${JSON.stringify(url)};const r=await loadBilingualPublication({vaultRoot:process.argv[1],run:process.argv[2],trustAnchor:JSON.parse(process.argv[3])});console.log(JSON.stringify({profile:r.reviewManifest.profile,hashes:r.plan.hashes}));`,
    f.vaultRoot, f.run, JSON.stringify(f.registration.trust_anchor)], { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout).hashes, f.plan.hashes);
  assert.equal(JSON.parse(child.stdout).profile, 'reading-first-obsidian-1.0');
  const result = await applyBilingualPublication(applyReadingFirstFixture(f));
  assert.equal(result.status, 'committed');
  const snapshot = await readCommittedGeneration({ vaultRoot: f.vaultRoot });
  assert.equal(snapshot.ok, true, JSON.stringify(snapshot.errors));
  for (const note of f.candidate.notes) assert.equal((await readFile(join(f.vaultRoot, note.path))).toString(), note.content);
  for (const query of ['supported', '研究结果', 'supportonlytoken', '仅知识页词']) {
    const found = queryBilingualIndex({ index: snapshot.index, activeSnapshot: snapshot, query });
    assert.ok(found.results.length, query);
    if (query === 'supportonlytoken') assert.ok(found.results.some(row => row.hits.some(hit => hit.path.startsWith('Wiki/methods/'))));
  }
  const graph = buildGraphProposal({ activeSnapshot: snapshot, entityInventory: snapshot.generation.objects.filter(row => row.path.endsWith('.md')).map(row => ({ path: row.path })) });
  assert.equal(graph.logicalPaperCount, 1); assert.equal(graph.expectedNodes.length, 2);
  assert.equal(graph.native_gui, 'not_run');
  const reloaded = await loadBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, trustAnchor: f.registration.trust_anchor });
  assert.deepEqual(reloaded.plan.hashes, f.plan.hashes, 'registration remains reconstructable after promotion');
});

test('publication refuses missing approval, unowned sources and resource drift before business writes', async t => {
  const f = await readingFirstPublicationFixture(t, { register: false });
  await assert.rejects(applyBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, plan: f.plan }), /P22_PUBLICATION_CONTROL_REQUIRED/);
  for (const note of f.candidate.notes) await assert.rejects(lstat(join(f.vaultRoot, note.path)), { code: 'ENOENT' });
  await assert.rejects(buildReadingFirstPublicationReview({ source: structuredClone(f.source), vaultRoot: f.vaultRoot,
    resources: f.resources, evidenceMode: 'synthetic' }), /READING_FIRST_PUBLICATION_SOURCE_REQUIRED/);
  await assert.rejects(registerBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, plan: f.plan, sourceInputs: {} }), /RF_PUBLICATION_LIVE_SOURCE_REQUIRED/);
  await writeFile(f.figure.path, 'changed registered image');
  await assert.rejects(registerBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, plan: f.plan, sourceInputs: f.sourceInputs }), /READING_FIRST_SOURCE_CHANGED|P22_REGISTERED_DEPENDENCY_CHANGED/);
});

test('another reading paper preserves the first paper and updates one shared bilingual node', async t => {
  const f = await readingFirstPublicationFixture(t);
  await applyBilingualPublication(applyReadingFirstFixture(f));
  const original = await readCommittedGeneration({ vaultRoot: f.vaultRoot });
  const shared = original.generation.shared_nodes[0], knowledgeContent = await readFile(join(f.vaultRoot, shared.path), 'utf8');
  const g = await readingFirstPublicationFixture(t, { vaultRoot: f.vaultRoot, generation: 'reading-generation-2',
    runId: 'run_' + 'b'.repeat(32), paperId: 'pap_' + 'b'.repeat(32),
    title: { en: 'Another synthetic paper', 'zh-CN': '另一篇合成论文' },
    knowledgeRegistry: [{ id: 'method', canonical_key: 'synthetic-method', path: shared.path, content: knowledgeContent }] });
  assert.equal(g.review.outputInventory.filter(row => row.kind === 'support').length, 1);
  const loaded = await loadBilingualPublication({ vaultRoot: g.vaultRoot, run: g.run, trustAnchor: g.registration.trust_anchor });
  assert.deepEqual(loaded.plan.hashes, g.plan.hashes);
  await applyBilingualPublication(applyReadingFirstFixture(g));
  const result = await readCommittedGeneration({ vaultRoot: f.vaultRoot });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.generation.papers.length, 2);
  assert.deepEqual(result.generation.shared_nodes, original.generation.shared_nodes);
  for (const note of f.candidate.notes) assert.equal(await readFile(join(f.vaultRoot, note.path), 'utf8'), note.content);
  const support = await readFile(join(f.vaultRoot, shared.path), 'utf8');
  const state = JSON.parse(Buffer.from(/<!-- KNOWLEDGE_STATE ([A-Za-z0-9+/=]+) -->/.exec(support)[1], 'base64'));
  assert.deepEqual(state.applications.map(row => row.paper_id).sort(), [f.paperId, g.paperId].sort());
  assert.equal(queryBilingualIndex({ index: result.index, activeSnapshot: result, query: 'supportonlytoken' }).results.length, 2);
  const after = await loadBilingualPublication({ vaultRoot: g.vaultRoot, run: g.run, trustAnchor: g.registration.trust_anchor });
  assert.deepEqual(after.plan.hashes, g.plan.hashes);
});

test('enabled graph follows the next committed paper and committed recovery', async t => {
  const f = await readingFirstPublicationFixture(t, { generation: 'graph-publication-1', controlOptions: { sourceLanguage: 'en' } });
  await applyBilingualPublication(applyReadingFirstFixture(f));
  const original = await readCommittedGeneration({ vaultRoot: f.vaultRoot });
  const proposal = buildGraphProposal({ activeSnapshot: original,
    entityInventory: original.generation.objects.filter(row => row.path.endsWith('.md')).map(({ path }) => ({ path })) });
  const policy = { search: proposal.filter, hideUnresolved: true, showOrphans: true };
  const graphPath = join(f.vaultRoot, '.obsidian/graph.json');
  const statePath = join(f.vaultRoot, '.apa-v3/phase22/graph/MANAGED.json');
  await mkdir(dirname(graphPath), { recursive: true });
  await mkdir(dirname(statePath), { recursive: true });
  const oldGraph = JSON.stringify({ ...policy, colorGroups: [{ query: 'tag:important', color: { a: 1, rgb: 123 } }], scale: 0.75 });
  const oldState = JSON.stringify({ schema_version: 'phase22-managed-graph-1.0', enabled: true,
    generation_id: original.generation.generation_id, policy });
  await writeFile(graphPath, oldGraph);
  await writeFile(statePath, oldState);
  const shared = original.generation.shared_nodes[0];
  const g = await readingFirstPublicationFixture(t, { vaultRoot: f.vaultRoot, generation: 'graph-publication-2',
    runId: 'run_' + 'd'.repeat(32), paperId: 'pap_' + 'd'.repeat(32), controlOptions: { sourceLanguage: 'en' },
    title: { en: 'Next graph paper', 'zh-CN': '新增图谱论文' },
    knowledgeRegistry: [{ id: 'method', canonical_key: 'synthetic-method', path: shared.path, content: await readFile(join(f.vaultRoot, shared.path), 'utf8') }] });
  const published = await applyBilingualPublication(applyReadingFirstFixture(g));
  assert.equal(published.status, 'committed');
  assert.equal(published.graph_sync?.status, 'synchronized');
  const current = await readCommittedGeneration({ vaultRoot: f.vaultRoot });
  const expected = buildGraphProposal({ activeSnapshot: current,
    entityInventory: current.generation.objects.filter(row => row.path.endsWith('.md')).map(({ path }) => ({ path })) });
  const actual = JSON.parse(await readFile(graphPath));
  assert.equal(actual.search, expected.filter);
  assert.equal(actual.scale, 0.75);
  assert.deepEqual(actual.colorGroups, JSON.parse(oldGraph).colorGroups);
  const regex = new RegExp(actual.search.slice(6, -1));
  for (const paper of current.generation.papers) {
    assert.equal(regex.test(paper.paths.en), true);
    assert.equal(regex.test(paper.paths['zh-CN']), false);
  }
  assert.equal(regex.test('Wiki/sources/uncommitted.md'), false);
  // Recreate the derived state left behind when a process stops after committing its marker.
  await writeFile(graphPath, oldGraph);
  await writeFile(statePath, oldState);
  const recovered = await recoverBilingualPublication({ vaultRoot: g.vaultRoot, run: g.run,
    transactionId: published.transaction_id, trustAnchor: g.registration.trust_anchor });
  assert.equal(recovered.status, 'committed');
  assert.equal(recovered.graph_sync?.status, 'synchronized');
  assert.equal(JSON.parse(await readFile(graphPath)).search, expected.filter);
});

test('a derived graph failure is reported without rolling back a committed paper', async t => {
  const f = await readingFirstPublicationFixture(t);
  const graphPath = join(f.vaultRoot, '.obsidian/graph.json');
  const statePath = join(f.vaultRoot, '.apa-v3/phase22/graph/MANAGED.json');
  await mkdir(dirname(graphPath), { recursive: true });
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(graphPath, 'invalid graph json');
  await writeFile(statePath, JSON.stringify({ schema_version: 'phase22-managed-graph-1.0', enabled: true, policy: {} }));
  const published = await applyBilingualPublication(applyReadingFirstFixture(f));
  assert.equal(published.status, 'committed');
  assert.equal(published.graph_sync.status, 'retryable');
  assert.equal((await readCommittedGeneration({ vaultRoot: f.vaultRoot })).ok, true);
  assert.equal(await readFile(graphPath, 'utf8'), 'invalid graph json');
});

test('republication preserves both Personal Notes and manual knowledge bytes and excludes them from search', async t => {
  const sharedPath = 'Wiki/methods/合成方法.md';
  const manual = '---\ntype: method\npipeline_version: "3.0"\n---\n# 合成方法\n\nmanualknowledgeonlytoken 人工知识备注。\n';
  const f = await readingFirstPublicationFixture(t, {
    knowledgeRegistry: [{ id: 'method', canonical_key: 'synthetic-method', path: sharedPath, content: manual }],
    seedFiles: [{ path: sharedPath, bytes: Buffer.from(manual) }],
  });
  await applyBilingualPublication(applyReadingFirstFixture(f));
  const existingTargets = [];
  for (const note of f.candidate.notes) {
    const path = join(f.vaultRoot, note.path), bytes = Buffer.concat([await readFile(path), Buffer.from('\nprivatepersonalonlytoken 私人笔记。\n')]);
    await writeFile(path, bytes); existingTargets.push({ path: note.path, bytes, managedHash: inspectManagedNote(bytes).managedHash });
  }
  const committed = await readCommittedGeneration({ vaultRoot: f.vaultRoot });
  assert.equal(committed.ok, true, JSON.stringify(committed.errors));
  const shared = committed.generation.shared_nodes[0], supportPath = join(f.vaultRoot, shared.path);
  const content = await readFile(supportPath, 'utf8');
  assert.ok(content.startsWith(manual));
  const g = await readingFirstPublicationFixture(t, { vaultRoot: f.vaultRoot, generation: 'reading-generation-republish',
    runId: 'run_' + 'c'.repeat(32), paperId: f.paperId, targetRegistry: f.candidate.targetRegistry, existingTargets,
    knowledgeRegistry: [{ id: 'method', canonical_key: 'synthetic-method', path: shared.path, content }] });
  await applyBilingualPublication(applyReadingFirstFixture(g));
  const snapshot = await readCommittedGeneration({ vaultRoot: g.vaultRoot });
  assert.equal(snapshot.ok, true, JSON.stringify(snapshot.errors)); assert.equal(snapshot.generation.papers.length, 1);
  for (const note of g.candidate.notes) assert.match(await readFile(join(g.vaultRoot, note.path), 'utf8'), /privatepersonalonlytoken/);
  assert.ok((await readFile(supportPath, 'utf8')).startsWith(manual));
  assert.equal(queryBilingualIndex({ index: snapshot.index, activeSnapshot: snapshot, query: 'privatepersonalonlytoken' }).results.length, 0);
  assert.equal(queryBilingualIndex({ index: snapshot.index, activeSnapshot: snapshot, query: 'manualknowledgeonlytoken' }).results.length, 0);
});

test('reading-first interruption after a resource write recovers in another process', async t => {
  const f = await readingFirstPublicationFixture(t);
  const url = new URL('../../scripts/v3/phase22-publication.mjs', import.meta.url).href;
  const asset = f.plan.inventory.find(row => row.kind === 'asset');
  const code = `import {loadBilingualPublication,applyBilingualPublication} from ${JSON.stringify(url)};
    const [vaultRoot,run,anchor]=process.argv.slice(1),r=await loadBilingualPublication({vaultRoot,run,trustAnchor:JSON.parse(anchor),requireApproval:true});
    await applyBilingualPublication({vaultRoot,run,plan:r.plan,control:r.control,approvalRecord:r.authority.approval_record.path,maintenanceWindowRecord:r.authority.maintenance_window_record.path,
      expectedReviewSha256:r.plan.hashes.review_hash,expectedOutputSha256:r.plan.hashes.output_inventory_hash,
      onPersistentBoundary:async e=>{if(e.operation==='target.link'&&e.timing==='after'&&e.path===${JSON.stringify(asset.path)}){process.send({cut:true});await new Promise(()=>{});}}});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, f.vaultRoot, f.run, JSON.stringify(f.registration.trust_anchor)],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let stderr = '', cut = false;
  child.stderr.on('data', bytes => { stderr += bytes; });
  child.on('message', event => { if (event.cut) { cut = true; child.kill('SIGKILL'); } });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 15000);
  const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  clearTimeout(watchdog);
  assert.equal(cut, true, stderr); assert.equal(status.signal, 'SIGKILL', stderr);
  assert.equal((await readCommittedGeneration({ vaultRoot: f.vaultRoot })).ok, false);
  const recovery = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {recoverBilingualPublication} from ${JSON.stringify(url)};console.log(JSON.stringify(await recoverBilingualPublication({vaultRoot:process.argv[1],run:process.argv[2],trustAnchor:JSON.parse(process.argv[3]),transactionId:process.argv[4]})));`,
    f.vaultRoot, f.run, JSON.stringify(f.registration.trust_anchor), f.registration.transaction_id], { encoding: 'utf8', windowsHide: true });
  assert.equal(recovery.status, 0, recovery.stderr); assert.equal(JSON.parse(recovery.stdout).status, 'rolled_back');
  for (const row of f.plan.inventory.filter(row => row.before_sha256 === null)) await assert.rejects(lstat(join(f.vaultRoot, row.path)), { code: 'ENOENT' });
});

test('registered reading source and unsigned reconstruction recipes cannot be substituted', async t => {
  const f = await readingFirstPublicationFixture(t);
  const bundle = JSON.parse(await readFile(join(f.vaultRoot, f.registration.bundle_path)));
  await assert.rejects(rebuildRegisteredReadingFirstReview(bundle.reading_first_recipe), /RF_PUBLICATION_REGISTERED_PROOF_REQUIRED/);
  await writeFile(join(f.root, f.reviewReceipt.path), '{}');
  await assert.rejects(loadBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, trustAnchor: f.registration.trust_anchor }), /P22_REGISTERED_DEPENDENCY_CHANGED/);
});

test('a restored registration cannot mint a new publication plan from registered-only evidence', async t => {
  const f = await readingFirstPublicationFixture(t);
  const bundleBytes = await readFile(join(f.vaultRoot, f.registration.bundle_path));
  const bundle = JSON.parse(bundleBytes), registration = JSON.parse(await readFile(join(f.vaultRoot, f.registration.registration_path)));
  const restored = await rebuildRegisteredReadingFirstReview(bundle.reading_first_recipe,
    { registration, bundleBytes, trustAnchor: f.registration.trust_anchor });
  await assert.rejects(dryRunBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, review: restored }), /RF_PUBLICATION_LIVE_SOURCE_REQUIRED/);
  const loaded = await loadBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, trustAnchor: f.registration.trust_anchor });
  assert.equal((await dryRunBilingualPublication({ vaultRoot: f.vaultRoot, run: f.run, plan: loaded.plan })).ok, true);
});

test('a different existing Raw source is never overwritten during publication preparation', async t => {
  const f = await reviewedReadingFirstFixture(t);
  const vaultRoot = await mkdtemp(join(tmpdir(), 'apa-reading-raw-conflict-'));
  t.after(() => rm(vaultRoot, { recursive: true, force: true }));
  await mkdir(join(vaultRoot, 'Raw'));
  const path = join(vaultRoot, 'Raw', f.paperId + '.pdf'), original = Buffer.from('Existing protected Raw source from another registration.');
  await writeFile(path, original);
  await assert.rejects(prepareReadingFirstPublication({ controller: f.controller, presentation: f.candidate,
    vaultRoot, generation: 'reading-raw-conflict', evidenceMode: 'synthetic', resources: f.resources }), /RF_PUBLICATION_RESOURCE_TARGET_CONFLICT/);
  assert.deepEqual(await readFile(path), original);
  for (const note of f.candidate.notes) await assert.rejects(lstat(join(vaultRoot, note.path)), { code: 'ENOENT' });
  await assert.rejects(lstat(join(vaultRoot, '.apa-v3')), { code: 'ENOENT' });
});

test('the V3 review entry consumes the accepted latest reading source without a legacy reader conversion', async t => {
  const f = await reviewedReadingFirstFixture(t);
  const vaultRoot = await mkdtemp(join(tmpdir(), 'apa-reading-publication-review-'));
  t.after(() => rm(vaultRoot, { recursive: true, force: true }));
  const source = await captureReadingFirstPublicationSource({ controller: f.controller, presentation: f.candidate });
  const review = await buildBilingualReview({ readingFirst: { source, vaultRoot,
    generation: 'reading-generation', evidenceMode: 'synthetic', resources: f.resources } });
  assert.equal(review.ok, true);
  assert.equal(review.reviewManifest.profile, 'reading-first-obsidian-1.0');
  assert.deepEqual(review.outputInventory.filter(row => row.kind === 'paper').map(row => row.bytes.toString('utf8')),
    [...f.candidate.notes].sort((a, b) => a.path.localeCompare(b.path)).map(row => row.content));
  assert.ok(review.outputInventory.some(row => row.kind === 'active'));
  assert.ok(review.outputInventory.some(row => row.kind === 'index'));
});

test('a later publication preserves prior managed edits and archives the prior approved bytes', async t => {
  const f = await readingFirstPublicationFixture(t);
  await applyBilingualPublication(applyReadingFirstFixture(f));
  const original = await readCommittedGeneration({ vaultRoot: f.vaultRoot });
  const note = f.candidate.notes[0], notePath = join(f.vaultRoot, note.path);
  const approved = await readFile(notePath, 'utf8');
  const edited = approved.replace('<!-- AUTO:END reading -->', '\n用户补充保留。\n<!-- AUTO:END reading -->');
  assert.notEqual(edited, approved);
  await writeFile(notePath, edited);
  const shared = original.generation.shared_nodes[0];
  const g = await readingFirstPublicationFixture(t, { vaultRoot: f.vaultRoot, generation: 'reading-edited-next',
    currentRegistryRoot: f.vaultRoot,
    runId: 'run_' + 'e'.repeat(32), paperId: 'pap_' + 'e'.repeat(32),
    title: { en: 'Next after edit', 'zh-CN': '编辑后的新论文' } });
  const secondNotePath = join(f.vaultRoot, f.candidate.notes[1].path);
  const secondBefore = await readFile(secondNotePath, 'utf8');
  const secondEdit = secondBefore.replace('<!-- AUTO:END reading -->', '\n批准后补充。\n<!-- AUTO:END reading -->');
  await writeFile(secondNotePath, secondEdit);
  await applyBilingualPublication(applyReadingFirstFixture(g));
  assert.equal(await readFile(notePath, 'utf8'), edited);
  assert.equal(await readFile(secondNotePath, 'utf8'), secondEdit);
  const archived = join(f.vaultRoot, '.apa-v3/phase22/history', original.generation_id, 'snapshot', note.path);
  assert.equal(await readFile(archived, 'utf8'), approved);
  const currentArchive = join(f.vaultRoot, '.apa-v3/phase22/history', original.generation_id, 'current', note.path);
  assert.equal(await readFile(currentArchive, 'utf8'), edited);
});

test('a legacy reading binding keeps its original strict publication contract after an old note edit', async t => {
  const f = await readingFirstPublicationFixture(t);
  await applyBilingualPublication(applyReadingFirstFixture(f));
  const original = await readCommittedGeneration({ vaultRoot: f.vaultRoot });
  const path = join(f.vaultRoot, f.candidate.notes[0].path);
  const before = await readFile(path, 'utf8');
  await writeFile(path, before.replace('<!-- AUTO:END reading -->', '\nLegacy drift.\n<!-- AUTO:END reading -->'));
  const shared = original.generation.shared_nodes[0];
  await assert.rejects(readingFirstPublicationFixture(t, { vaultRoot: f.vaultRoot, generation: 'legacy-after-edit',
    runId: 'run_' + 'f'.repeat(32), paperId: 'pap_' + 'f'.repeat(32),
    knowledgeRegistry: [{ id: 'method', canonical_key: 'synthetic-method', path: shared.path,
      content: await readFile(join(f.vaultRoot, shared.path), 'utf8') }] }), /RF_PUBLICATION_PREVIOUS_GENERATION_INVALID/);
});

test('current shared content changed after rendering cannot be overwritten by publication preparation', async t => {
  const f = await readingFirstPublicationFixture(t);
  await applyBilingualPublication(applyReadingFirstFixture(f));
  const g = await reviewedReadingFirstFixture(t, { currentRegistryRoot: f.vaultRoot,
    runId: 'run_' + 'e'.repeat(32), paperId: 'pap_' + 'e'.repeat(32),
    title: { en: 'New reading', 'zh-CN': '新论文' } });
  const path = join(f.vaultRoot, g.candidate.supportNotes[0].path);
  const original = await readFile(path, 'utf8');
  const edited = original.replace('<!-- AUTO:END shared-knowledge -->', 'HumanChangedAfterRenderNeedle\n<!-- AUTO:END shared-knowledge -->');
  assert.notEqual(original, edited);
  await writeFile(path, edited);
  const source = await captureReadingFirstPublicationSource({ controller: g.controller, presentation: g.candidate });
  await assert.rejects(prepareReadingFirstPublication({ source, vaultRoot: f.vaultRoot, generation: 'new-after-edit',
    evidenceMode: 'synthetic', resources: g.resources }), /RF_PUBLICATION_KNOWLEDGE_CHANGED_SINCE_RENDER/);
  assert.equal(await readFile(path, 'utf8'), edited);
});
