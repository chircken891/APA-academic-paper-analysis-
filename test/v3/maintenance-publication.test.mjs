import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyReadingFirstFixture, readingFirstPublicationAuthority, readingFirstPublicationFixture } from './helpers/reading-first-publication-fixtures.mjs';
import { readCommittedGeneration, readRegisteredCommit } from '../../scripts/v3/phase22-active-version.mjs';
import { applyBilingualPublication, dryRunBilingualPublication, registerBilingualPublication } from '../../scripts/v3/phase22-publication.mjs';
import { buildNoteRelocationReview } from '../../scripts/v3/note-relocation.mjs';
import { inspectManagedNote } from '../../scripts/v3/phase22-managed-markdown.mjs';
import { buildBilingualIndex } from '../../scripts/v3/phase22-search.mjs';
import { verifyReadingFirstPaperBytes, verifyReadingFirstPresentation } from '../../scripts/v3/reading-first-index.mjs';
import { syncCommittedGraph } from '../../scripts/v3/obsidian-graph-sync.mjs';
import { buildMapRefreshReview } from '../../scripts/v3/research-map-refresh.mjs';
import { researchMapCanvasSection } from '../../scripts/v3/research-map-canvas.mjs';

const script = fileURLToPath(new URL('../../scripts/v3/bilingual.mjs', import.meta.url));
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const publicationFolder = (root, run) => join(root, 'Eval', 'apa-v3', 'runs', run, 'publication');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
function cli(root, command, run, args, env = process.env) {
  const result = spawnSync(process.execPath, [script, command, '--vault-root', root, '--run', run, ...args], { encoding: 'utf8', env, timeout: 120_000 });
  assert.ifError(result.error);
  assert.ok(result.stdout, result.stderr);
  return { exit: result.status, ...JSON.parse(result.stdout) };
}
async function review(root, run, mode, options, expected = 'review') {
  const optionsPath = join(root, run + '-options.json');
  await writeFile(optionsPath, JSON.stringify(options));
  const result = cli(root, 'maintenance-review', run, ['--mode', mode, '--options', optionsPath]);
  if (expected !== 'review') { assert.equal(result.error?.code, expected, JSON.stringify(result)); return result; }
  assert.equal(result.exit, 0, JSON.stringify(result));
  assert.equal(result.status, 'review');
  const folder = publicationFolder(root, run);
  assert.equal(result.inventory_sha256, sha(await readFile(join(folder, 'candidate/INVENTORY.json'))));
  assert.equal(typeof (await json(join(folder, 'candidate/REVIEW.json'))).profile, 'string');
  assert.ok((await readFile(join(folder, 'candidate/INVENTORY.md'), 'utf8')).includes(result.hashes.output_inventory_hash));
  assert.equal(result.counts.create + result.counts.overwrite + result.counts.delete, result.targets.length);
  return result;
}
const apply = (root, run, hash) => cli(root, 'maintenance-apply', run,
  ['--inventory-sha256', hash, '--authorization-id', 'synthetic-approval-1', '--user-reply', '批准']);
async function published(t, options) {
  const fixture = await readingFirstPublicationFixture(t, options);
  assert.equal((await applyBilingualPublication(applyReadingFirstFixture(fixture))).status, 'committed');
  return fixture;
}
function assetMapping(fixture) {
  const { path, sha256, byte_length } = fixture.resources.find(row => row.path.startsWith('Figures/'));
  return { old_path: path, new_path: `Figures/${fixture.runId}/${posix.basename(path)}`, sha256, byte_length };
}

test('map refresh CLI rejects an empty paper selection', async t => {
  const root = await mkdtemp(join(tmpdir(), 'apa-map-refresh-empty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await review(root, 'empty-map-refresh', 'map-refresh', { papers: [] }, 'P22_MAINTENANCE_OPTIONS_INVALID');
});

async function legacyMapFixture(t) {
  const f = await published(t, { controlOptions: { presentationMode: 'writer', maxCalls: 6 } });
  const bilingual = (en, zh) => ({ en, 'zh-CN': zh });
  const map = structuredClone(f.presentationCatalog.map);
  map.findings = Array.from({ length: 4 }, (_, i) => ({ id: 'finding-' + (i + 1), section_id: 'findings',
    label: bilingual('Synthetic finding ' + (i + 1), '合成发现 ' + (i + 1)) }));
  map.relations = map.findings.map(row => ({ step_id: map.steps[0].id, finding_id: row.id }));
  const claims = map.findings.map(({ id }, i) => ({ id: 'claim-' + (i + 1), title: bilingual('Claim ' + (i + 1), '论点 ' + (i + 1)),
    evidence: bilingual('Synthetic evidence', '合成证据'), limit: bilingual('Synthetic limits', '合成限制'),
    finding_ids: [id], branch_id: i < 2 ? 'design-branch' : 'findings-branch', section_id: 'findings' }));
  const sectionTitles = Object.fromEntries(f.views.map(view => [view.language,
    Object.fromEntries(view.sections.map(section => [section.id, section.heading]))]));
  const argument = { question: { text: bilingual('What does the study test?', '研究检验了什么？'), section_id: 'design' }, claims,
    branches: [{ id: 'design-branch', name: bilingual('Design', '设计') }, { id: 'findings-branch', name: bilingual('Findings', '发现') }],
    relations: ['question', ...claims.map(row => row.id)].map((from, i) => ({ from, to: claims[i]?.id ?? 'conclusion', label: '机制推进' })),
    conclusion: { text: bilingual('The data support the synthetic finding.', '数据支持这项合成发现。'), section_id: 'conclusion' } };
  const primaryFindingIds = [map.findings[0].id];
  return { f, options: { papers: [{ paperId: f.paperId, map, argument, primaryFindingIds, sectionTitles }] } };
}

test('map refresh registers two exact Canvas assets and replaces only the old diagram and its navigation', async t => {
  const { f, options } = await legacyMapFixture(t), root = f.vaultRoot, run = 'map-maintenance';
  const prior = await readCommittedGeneration({ vaultRoot: root });
  assert.equal(prior.ok, true);
  const before = prior.generation.papers.find(paper => paper.paper_id === f.paperId);
  const beforePresentation = await readFile(join(root, before.reader_presentation.path));
  const priorNotes = new Map();
  for (const path of Object.values(before.paths)) {
    const absolute = join(root, path);
    const text = await readFile(absolute, 'utf8') + '\nUser annotation 🧪   \r\n';
    assert.match(text, /```mermaid\nflowchart TD\n/);
    await writeFile(absolute, text);
    priorNotes.set(path, text);
  }
  const obsidian = new Map([['graph.json', '{"private_setting":true}'], ['community-plugins.json', '["better-embedded-canvas"]'],
    ['plugins/better-embedded-canvas/main.js', '// local test bytes']]);
  for (const [path, bytes] of obsidian) {
    const target = join(root, '.obsidian', path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  const graph = await syncCommittedGraph({ vaultRoot: root, enableAutoSync: true });
  assert.equal(graph.status, 'synchronized');
  obsidian.set('graph.json', await readFile(join(root, '.obsidian/graph.json'), 'utf8'));
  const candidate = await review(root, run, 'map-refresh', options);
  assert.deepEqual(candidate.counts, { create: 6, overwrite: 3, delete: 0 });
  assert.equal((await readRegisteredCommit({ vaultRoot: root })).generation_id, prior.generation_id);
  for (const [path, text] of priorNotes) assert.equal(await readFile(join(root, path), 'utf8'), text);
  const transaction = apply(root, run, candidate.inventory_sha256);
  assert.equal(transaction.status, 'committed', JSON.stringify(transaction));
  assert.equal(transaction.graph_sync.status, 'current');
  assert.equal(transaction.graph_sync.nativeNodeCount, graph.nativeNodeCount);
  const committed = await readCommittedGeneration({ vaultRoot: root });
  assert.equal(committed.generation_id, run, JSON.stringify(committed.errors));
  const paper = committed.generation.papers.find(row => row.paper_id === f.paperId);
  assert.deepEqual(paper.dependencies, before.dependencies);
  assert.equal(paper.core_hash, before.core_hash);
  const presentation = verifyReadingFirstPresentation(paper, await readFile(join(root, paper.reader_presentation.path)), committed.generation);
  assert.deepEqual(await readFile(join(root, before.reader_presentation.path)), beforePresentation);
  for (const language of ['en', 'zh-CN']) {
    const path = paper.paths[language], text = await readFile(join(root, path), 'utf8');
    const oldMap = /^(?:#{2,3} (?:2\.1 )?(?:Research map|研究导图)\n\n)?```mermaid\n[\s\S]*?^```\n\n(?:- \[[^\r\n]*\]\(#[^\r\n]*\)\n)+\n/m;
    const newMap = /^### (?:2\.1 )?(?:Research map|研究导图)\n\n[^\n]+\n\n!\[\[Figures\/[^\n]+\.canvas\|(?:Research map|研究导图)\|640\]\]\n\n\[\[Figures\/[^\n]+\.canvas\|[^\n]+\]\]\n\n/m;
    assert.match(priorNotes.get(path), oldMap);
    assert.match(text, newMap);
    assert.equal(text.replace(newMap, ''), priorNotes.get(path).replace(oldMap, ''));
    verifyReadingFirstPaperBytes(paper, language, Buffer.from(text), committed.generation, presentation);
    const assetPath = `Figures/${f.runId}/research-map.${language}.canvas`, asset = await readFile(join(root, assetPath));
    assert.deepEqual(presentation.presentation_assets.find(row => row.language === language),
      { kind: 'research-map-canvas', language, path: assetPath, sha256: sha(asset), byte_length: asset.length });
    assert.ok(presentation.targets.assets.includes(assetPath));
    assert.ok(committed.generation.objects.some(row => row.kind === 'asset' && row.path === assetPath && row.sha256 === sha(asset)));
    const title = /^### ([^\r\n]+)\n/.exec(newMap.exec(text)[0])[1];
    assert.ok(committed.index.documents.some(row => row.path === path && row.anchor === title));
  }
  for (const [path, bytes] of obsidian) assert.equal(await readFile(join(root, '.obsidian', path), 'utf8'), bytes);
  const journal = await readFile(join(root, transaction.journal_path));
  assert.equal(apply(root, run, candidate.inventory_sha256).error?.code, 'P22_MAINTENANCE_ATTEMPT_EXISTS');
  assert.deepEqual(await readFile(join(root, transaction.journal_path)), journal);
  assert.equal((await json(join(publicationFolder(root, run), 'VERIFICATION.json'))).status, 'passed');
});

async function registerLegacyCanvas(root, options) {
  const run = 'initial-map-maintenance';
  const first = await review(root, run, 'map-refresh', options);
  const transaction = apply(root, run, first.inventory_sha256);
  assert.equal(transaction.status, 'committed', JSON.stringify(transaction));
  const base = await readCommittedGeneration({ vaultRoot: root });
  assert.equal(base.generation_id, run, JSON.stringify(base.errors));
  return base;
}

test('registered map refresh overwrites its assets in place and changes only the selected reading paragraph', async t => {
  const { f, options } = await legacyMapFixture(t), root = f.vaultRoot, run = 'registered-map-maintenance';
  const base = await registerLegacyCanvas(root, options), [paper] = base.generation.papers;
  const previousPresentation = await readFile(join(root, paper.reader_presentation.path));
  const priorManifest = verifyReadingFirstPresentation(paper, previousPresentation, base.generation);
  const priorNotes = {};
  for (const [language, path] of Object.entries(paper.paths)) {
    const note = join(root, path);
    priorNotes[language] = await readFile(note, 'utf8') + '\nUser annotation 🧪   \r\n';
    await writeFile(note, priorNotes[language]);
  }
  const selection = options.papers[0];
  selection.map.steps[0].label.en = 'Updated map display label';
  selection.map.steps[0].label['zh-CN'] = '更新的导图展示标签';
  const oldCanvasPath = priorManifest.presentation_assets.find(row => row.language === 'en').path;
  const [before] = researchMapCanvasSection({ canvasPath: oldCanvasPath, language: 'en' }).split('\n');
  const after = 'Read the research map from the left column, then follow the findings to the claims and conclusion.';
  const edit = { before, after };
  selection.noteWordingEdits = { en: [edit] };

  const candidate = await review(root, run, 'map-refresh', options);
  assert.deepEqual(candidate.counts, { create: 4, overwrite: 4, delete: 0 });
  const folder = publicationFolder(root, run);
  const inventory = await json(join(folder, 'candidate/INVENTORY.json'));
  assert.ok(!inventory.files.some(row => row.path === paper.paths['zh-CN']));
  for (const asset of priorManifest.presentation_assets) {
    const row = inventory.files.find(item => item.path === asset.path);
    assert.equal(row.action, 'overwrite');
    assert.equal(row.before_sha256, asset.sha256);
    assert.equal(row.before_byte_length, asset.byte_length);
    assert.equal(sha(await readFile(join(root, asset.path))), asset.sha256);
  }
  const reviewManifest = await json(join(folder, 'candidate/REVIEW.json'));
  assert.deepEqual(reviewManifest.provenance_limits.note_wording_edits,
    [{ paper_id: f.paperId, language: 'en', path: paper.paths.en, ...edit }]);
  const transaction = apply(root, run, candidate.inventory_sha256);
  assert.equal(transaction.status, 'committed', JSON.stringify(transaction));
  assert.equal(apply(root, run, candidate.inventory_sha256).error?.code, 'P22_MAINTENANCE_ATTEMPT_EXISTS');

  const committed = await readCommittedGeneration({ vaultRoot: root });
  assert.equal(committed.generation_id, run, JSON.stringify(committed.errors));
  const [updated] = committed.generation.papers;
  const presentation = verifyReadingFirstPresentation(updated, await readFile(join(root, updated.reader_presentation.path)), committed.generation);
  assert.notEqual(updated.reader_presentation.path, paper.reader_presentation.path);
  assert.deepEqual(await readFile(join(root, paper.reader_presentation.path)), previousPresentation);
  assert.deepEqual(updated.dependencies, paper.dependencies);
  assert.equal(updated.core_hash, paper.core_hash);
  assert.deepEqual(presentation.targets.assets, priorManifest.targets.assets);
  assert.deepEqual(presentation.targets.support, priorManifest.targets.support);
  assert.deepEqual(presentation.presentation_assets.map(row => row.path), priorManifest.presentation_assets.map(row => row.path));
  for (const asset of presentation.presentation_assets) {
    const bytes = await readFile(join(root, asset.path));
    assert.equal(asset.sha256, sha(bytes));
    assert.equal(asset.byte_length, bytes.length);
    assert.equal(committed.generation.objects.filter(row => row.path === asset.path).length, 1);
  }
  assert.notEqual(presentation.presentation_assets.find(row => row.language === 'en').sha256,
    priorManifest.presentation_assets.find(row => row.language === 'en').sha256);
  for (const [language, path] of Object.entries(updated.paths)) {
    const bytes = await readFile(join(root, path));
    assert.equal(bytes.toString('utf8'), language === 'en' ? priorNotes.en.replace(before, after) : priorNotes[language]);
    verifyReadingFirstPaperBytes(updated, language, bytes, committed.generation, presentation);
  }
});

test('registered map refresh refuses wording edits outside a unique, structurally unchanged map paragraph', async t => {
  const { f, options } = await legacyMapFixture(t), root = f.vaultRoot;
  const base = await registerLegacyCanvas(root, options), [paper] = base.generation.papers;
  const notePath = join(root, paper.paths.en);
  await writeFile(notePath, await readFile(notePath, 'utf8') + '\nRead the research map in my own way.\n');
  const canvasPath = `Figures/${f.runId}/research-map.en.canvas`;
  const [before] = researchMapCanvasSection({ canvasPath, language: 'en' }).split('\n');
  const after = 'Read the research map from the left column.';
  const edit = { before, after };
  const attempts = [
    { en: [{ before: before.slice(0, -1), after }] },
    { en: [{ before: 'Read the research map in my own way.', after }] },
    { en: [{ ...edit, after: `### ${after}` }] },
    { en: [{ ...edit, after: `${after}\n\nNew paragraph.` }] },
    { en: [{ ...edit, after: `${after} [[Unregistered destination]]` }] },
    { en: [{ ...edit, after: `${after} See 7 results.` }] },
    { en: [edit, edit] },
    { fr: [edit] },
  ];
  for (const noteWordingEdits of attempts) {
    await assert.rejects(buildMapRefreshReview({ vaultRoot: root, runId: 'invalid-map-maintenance', generation: 'invalid-map-maintenance',
      papers: [{ ...options.papers[0], noteWordingEdits }] }), { code: 'P22_MAP_REFRESH_WORDING_INVALID' });
  }
  assert.equal((await readRegisteredCommit({ vaultRoot: root })).generation_id, base.generation_id);
});

test('compact map refresh moves the map ahead of design and synchronizes bilingual anchors', async t => {
  const { f, options } = await legacyMapFixture(t), root = f.vaultRoot, run = 'compact-map-maintenance';
  const commitPath = join(root, '.apa-v3/phase22/COMMITTED.json'), commit = await json(commitPath);
  const generation = await json(join(root, commit.active.path)), [paper] = generation.papers;
  const manifestPath = join(root, paper.reader_presentation.path), manifest = await json(manifestPath);
  const notes = {}, expected = [];
  for (const [language, path] of Object.entries(paper.paths)) {
    const en = language === 'en', design = en ? 'Study design' : '研究设计';
    const next = en ? 'Measurements (in vivo)' : '测量（体内）';
    const mapTitle = en ? 'Research map' : '研究导图';
    const href = title => '#' + encodeURIComponent(title).replaceAll('(', '%28').replaceAll(')', '%29');
    const entry = title => `>   - [${title}](${href(title)})\n`;
    const module = `## 2. ${design}\n\n`;
    const first = `2.1 ${design}`, second = `2.2 ${next}`;
    const oldMap = `\`\`\`mermaid\nflowchart LR\n  design["Design"]\n\`\`\`\n\n${en ? 'Findings not shown in the map: example' : '未画入导图的发现：示例'}\n\n`;
    const lead = en ? 'Follow the main line from left to right, then consult **the 7 linked details**.' : '沿主线从左向右看，再查阅 **7 项关联细节**。';
    const revisedLead = en ? 'Follow the main steps in order, then consult **the 7 linked details**.' : '按顺序阅读主要步骤，再查阅 **7 项关联细节**。';
    const links = `${lead} [${next}](${href(second)})\n\n`;
    const duplicate = 'Duplicate map wording.';
    const personal = `\nUser annotation 🧪 [${first}](${href(first)})   \n`;
    const original = (await readFile(join(root, path), 'utf8'))
      .replace('<!-- AUTO:END source -->', `> [!note] ${en ? 'Contents' : '目录'}\n${entry(first)}${entry(second)}\n`
        + `> [${design}](${href(first)})\n\n<!-- AUTO:END source -->`)
      .replace(new RegExp(`^## ${design}\\n\\n### ${mapTitle}\\n\\n` + '```mermaid\\n[\\s\\S]*?^\`\`\`\\n\\n(?:- [^\\n]+\\n)+\\n', 'm'), module)
      .replace(`### ${design}\n\n`, `### ${first}\n\n`)
      .replace(en ? '## Methods\n' : '## 方法\n', `${oldMap}${links}${duplicate}\n\n### ${second}\n\n${duplicate}\n\nMeasurement details.\n\n$&`)
      + personal;
    assert.match(original, /\`\`\`mermaid\nflowchart LR\n/);
    assert.ok(original.includes(module + `### ${first}\n`));
    options.papers[0].sectionTitles[language].design = first;
    notes[language] = Buffer.from(original.replaceAll('\n', '\r\n'));
    await writeFile(join(root, path), notes[language]);
    const managedHash = inspectManagedNote(notes[language]).managedHash;
    generation.objects.find(row => row.path === path).sha256 = managedHash;
    Object.assign(manifest.targets.notes[language], { managed_hash: managedHash, byte_sha256: sha(notes[language]) });
    const mapHeading = `2.1 ${mapTitle}`, afterFirst = `2.2 ${design}`, afterSecond = `2.3 ${next}`;
    const text = original
      .replace(entry(first) + entry(second), entry(mapHeading) + entry(afterFirst) + entry(afterSecond))
      .replace(`[${design}](${href(first)})`, `[${design}](${href(afterFirst)})`)
      .replace(`### ${first}\n`, `### ${afterFirst}\n`)
      .replace(`### ${second}\n`, `### ${afterSecond}\n`)
      .replace(oldMap + links, links.replace(href(second), href(afterSecond)));
    const before = links.trimEnd().replace(href(second), href(afterSecond));
    expected.push({ language, path, text: text.replaceAll('\n', '\r\n'), module: module.replaceAll('\n', '\r\n'), mapHeading, afterFirst,
      edit: { before, after: before.replace(lead, revisedLead) }, duplicate });
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(manifestPath, manifestBytes);
  generation.objects.find(row => row.path === paper.reader_presentation.path).sha256 = paper.reader_presentation.sha256 = sha(manifestBytes);
  const files = [{ path: paper.reader_presentation.path, bytes: manifestBytes }];
  for (const path of [...manifest.targets.assets, ...manifest.targets.support.map(row => row.path)]) {
    files.push({ path, bytes: await readFile(join(root, path)) });
  }
  const index = buildBilingualIndex({ generation, validatedInputs: { papers: [{ readingFirst: manifest, notes }], files } });
  const activeBytes = Buffer.from(JSON.stringify(index.generation));
  await writeFile(join(root, commit.active.path), activeBytes);
  await writeFile(join(root, commit.index.path), index.bytes);
  commit.active.sha256 = sha(activeBytes);
  commit.index.sha256 = sha(index.bytes);
  await writeFile(commitPath, JSON.stringify(commit));

  const candidate = await review(root, run, 'map-refresh', options);
  const transaction = apply(root, run, candidate.inventory_sha256);
  assert.equal(transaction.status, 'committed', JSON.stringify(transaction));
  const committed = await readCommittedGeneration({ vaultRoot: root });
  assert.equal(committed.generation_id, run, JSON.stringify(committed.errors));
  for (const { language, path, text, module, mapHeading, afterFirst } of expected) {
    const note = await readFile(join(root, path), 'utf8');
    assert.ok(note.includes(module + `### ${mapHeading}\r\n`), 'map must lead module 2');
    assert.equal(note.replace(/^### 2\.1 (?:Research map|研究导图)\r\n\r\n[\s\S]*?(?=^### 2\.2 )/m, ''), text);
    const canvas = await json(join(root, `Figures/${f.runId}/research-map.${language}.canvas`));
    assert.ok(canvas.nodes.some(node => node.text?.includes(`[[${path.replace(/\.md$/, '')}#${afterFirst}|`)));
    assert.ok(committed.index.documents.some(row => row.path === path && row.anchor === mapHeading));
  }
  const selection = options.papers[0];
  const sectionTitles = structuredClone(selection.sectionTitles);
  for (const { language, afterFirst } of expected) sectionTitles[language].design = afterFirst;
  const noteWordingEdits = Object.fromEntries(expected.map(({ language, edit }) => [language, [edit]]));
  const input = { vaultRoot: root, runId: 'compact-map-wording', generation: 'compact-map-wording' };
  const refresh = await buildMapRefreshReview({ ...input, papers: [{ ...selection, sectionTitles, noteWordingEdits }] });
  for (const { path, edit } of expected) {
    const before = await readFile(join(root, path), 'utf8');
    assert.equal(refresh.outputInventory.find(row => row.path === path).bytes.toString('utf8'), before.replace(edit.before, edit.after));
  }
  const [{ duplicate }] = expected;
  await assert.rejects(buildMapRefreshReview({ ...input, papers: [{ ...selection, sectionTitles,
    noteWordingEdits: { en: [{ before: duplicate, after: 'Revised duplicate map wording.' }] } }] }),
  { code: 'P22_MAP_REFRESH_WORDING_INVALID', details: { path: expected[0].path, reason: 'paragraph-scope', matches: 2 } });
});

test('map refresh refuses out-of-scope writes and rereads the approved preimages', async t => {
  const { f, options } = await legacyMapFixture(t), root = f.vaultRoot, run = 'map-maintenance-drift';
  await review(root, 'map-maintenance-override', 'map-refresh', {
    papers: [{ ...options.papers[0], target: '.obsidian/graph.json' }],
  }, 'P22_MAINTENANCE_OPTIONS_INVALID');
  const candidate = await review(root, run, 'map-refresh', options);
  const note = join(root, f.candidate.notes[0].path);
  await writeFile(note, await readFile(note, 'utf8') + '\nNew user annotation after approval preview.\n');
  assert.equal(apply(root, run, candidate.inventory_sha256).error?.code, 'P22_MAINTENANCE_REVIEW_CHANGED');
  await assert.rejects(readFile(join(publicationFolder(root, run), 'APPROVAL.json')), { code: 'ENOENT' });
  assert.notEqual((await readRegisteredCommit({ vaultRoot: root })).generation_id, run);
});

test('maintenance CLI approves the exact asset relocation and does not rewrite it on repeat', async t => {
  const f = await published(t), root = f.vaultRoot, run = 'asset-maintenance';
  const mapping = assetMapping(f), old = await readFile(join(root, mapping.old_path));
  const marker = join(root, '.apa-v3/phase22/COMMITTED.json'), prior = await readFile(marker);
  const candidate = await review(root, run, 'relocate', { assetMappings: [mapping] });
  assert.deepEqual(await readFile(marker), prior);
  assert.ok(candidate.targets.includes(mapping.new_path));
  assert.equal(candidate.counts.delete, 0);
  assert.equal(apply(root, run, 'sha256:' + '0'.repeat(64)).error?.code, 'P22_MAINTENANCE_INVENTORY_MISMATCH');
  await assert.rejects(readFile(join(publicationFolder(root, run), 'APPROVAL.json')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(marker), prior);
  const transaction = apply(root, run, candidate.inventory_sha256);
  assert.equal(transaction.status, 'committed', JSON.stringify(transaction));
  assert.deepEqual(await readFile(join(root, mapping.new_path)), old);
  assert.deepEqual(await readFile(join(root, mapping.old_path)), old);
  const current = await readRegisteredCommit({ vaultRoot: root });
  assert.equal(current.generation_id, run);
  assert.ok(current.generation.objects.some(row => row.path === mapping.new_path));
  assert.ok(!current.generation.objects.some(row => row.path === mapping.old_path));
  const folder = publicationFolder(root, run);
  const approval = await json(join(folder, 'APPROVAL.json')), window = await json(join(folder, 'MAINTENANCE-WINDOW.json'));
  assert.equal(approval.user_reply, '批准');
  assert.equal(approval.inventory_sha256, candidate.inventory_sha256);
  assert.equal(Date.parse(window.ends_at) - Date.parse(window.starts_at), 15 * 60_000);
  const verification = await json(join(folder, 'VERIFICATION.json'));
  assert.equal(verification.status, 'passed');
  assert.equal(verification.verified_files.length, candidate.targets.length);
  const paths = [marker, join(root, transaction.journal_path), join(folder, 'APPROVAL.json'), join(folder, 'RESULT.md')];
  const committed = await Promise.all(paths.map(path => readFile(path)));
  assert.equal(apply(root, run, candidate.inventory_sha256).error?.code, 'P22_MAINTENANCE_ATTEMPT_EXISTS');
  assert.deepEqual(await Promise.all(paths.map(path => readFile(path))), committed);
});

test('maintenance apply rebuilds the review and refuses current output drift', async t => {
  const f = await published(t), root = f.vaultRoot, run = 'stale-maintenance';
  const mapping = assetMapping(f), candidate = await review(root, run, 'relocate', { assetMappings: [mapping] });
  const target = join(root, mapping.new_path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, await readFile(join(root, mapping.old_path)));
  const result = apply(root, run, candidate.inventory_sha256);
  assert.equal(result.error?.code, 'P22_MAINTENANCE_REVIEW_CHANGED', JSON.stringify(result));
  await assert.rejects(readFile(join(publicationFolder(root, run), 'APPROVAL.json')), { code: 'ENOENT' });
  assert.notEqual((await readRegisteredCommit({ vaultRoot: root })).generation_id, run);
});

test('a path-only maintenance plan registers through its owned relocation review', async t => {
  const f = await published(t, { controlOptions: { noteLayout: 'legacy-flat-1.0' } }), root = f.vaultRoot, run = 'note-maintenance';
  const papers = [{ paperId: f.paperId, sourceLanguage: 'en' }];
  await review(root, f.runId, 'relocate', { papers }, 'P22_MAINTENANCE_ATTEMPT_EXISTS');
  const owned = await buildNoteRelocationReview({ vaultRoot: root, runId: run, generation: run, papers });
  await assert.rejects(dryRunBilingualPublication({ vaultRoot: root, run, review: structuredClone(owned) }), { code: 'P22_REVIEW_NOT_OWNED' });
  const { plan } = await dryRunBilingualPublication({ vaultRoot: root, run, review: owned });
  await assert.rejects(registerBilingualPublication({ vaultRoot: root, run, plan: structuredClone(plan) }), { code: 'P22_PUBLICATION_PLAN_NOT_OWNED' });
  await assert.rejects(registerBilingualPublication({ vaultRoot: root, run, plan }), { code: 'P22_PUBLICATION_CONTROL_REQUIRED' });
  const candidate = await review(root, run, 'relocate', { papers });
  assert.equal(apply(root, run, candidate.inventory_sha256).status, 'committed');
  const current = await readRegisteredCommit({ vaultRoot: root });
  assert.match(current.generation.papers[0].paths['zh-CN'], /^Wiki\/translations\//);
});

test('structured merge retains registered content and permits exact compensation', async t => {
  const first = await published(t), root = first.vaultRoot;
  const presentation = structuredClone(first.presentationCatalog);
  const item = presentation.knowledge[0];
  item.canonical_key = 'maintenance-second-method';
  item.title = { en: 'Maintenance second method', 'zh-CN': '第二种维护方法' };
  item.aliases = ['MaintenanceSecondMethodAlias'];
  item.paragraphs.en = ['Existing qualification must survive the merge.'];
  item.sections = { en: [{ heading: 'Specific qualification', paragraphs: ['Retain this section.'] }], 'zh-CN': [] };
  item.sources = [{ title: 'Existing method source', url: 'https://example.com/existing-method' }];
  const second = await readingFirstPublicationFixture(t, { presentation, vaultRoot: root,
    generation: 'maintenance-reading-2', runId: 'run_' + 'b'.repeat(32), paperId: 'pap_' + 'b'.repeat(32) });
  assert.equal((await applyBilingualPublication(applyReadingFirstFixture(second))).status, 'committed');
  const keep = first.candidate.supportNotes[0].path, remove = second.candidate.supportNotes[0].path;
  const paper = first.candidate.notes[0].path, paperPath = join(root, paper);
  const humanLink = `[[${remove.slice(0, -3)}#Specific qualification|qualification]]`;
  const languageLink = `[[${remove.slice(0, -3)}#English|definition]]`;
  const anchoredLink = `[[${remove.slice(0, -3)}#^source-evidence|evidence]]`;
  const anchoredInternal = '[Evidence paragraph](#%5Esource-evidence)';
  const removedPath = join(root, remove);
  const removedNote = (await readFile(removedPath, 'utf8')).replace('Retain this section.', `Retain this section. ^source-evidence\n\n${anchoredInternal}`)
    + '\n## Personal Notes\n\nPersonal content in the retired page.\n';
  await writeFile(removedPath, removedNote);
  await writeFile(paperPath, (await readFile(paperPath, 'utf8')) + '\n' + [humanLink, anchoredLink, languageLink].join('\n\n') + '\n');
  const keepPath = join(root, keep), before = await readFile(keepPath), paperBefore = await readFile(paperPath);
  const options = { merges: [{ keep_path: keep, remove_paths: [remove] }] }, run = 'merge-maintenance';
  await review(root, 'invalid-merge-maintenance', 'merge', { merges: [{ ...options.merges[0], append_markdown: 'Arbitrary new content.' }] },
    'P22_MAINTENANCE_OPTIONS_INVALID');
  const candidate = await review(root, run, 'merge', options);
  const transaction = apply(root, run, candidate.inventory_sha256);
  assert.equal(transaction.status, 'committed', JSON.stringify(transaction));
  const content = await readFile(keepPath, 'utf8');
  assert.match(content, /Existing qualification must survive the merge/);
  assert.match(content, /Existing method source/);
  assert.match(content, /## Specific qualification/);
  const languageAnchor = `English · ${posix.basename(remove, '.md')}`;
  assert.ok(content.includes(`## ${languageAnchor}\n`));
  assert.ok(content.includes(`[English](#${encodeURIComponent(languageAnchor)})`));
  assert.ok(content.includes(anchoredInternal));
  assert.ok(!content.includes('Personal content in the retired page.'));
  assert.ok((await readFile(paperPath, 'utf8')).includes(`[[${keep.slice(0, -3)}#Specific qualification|qualification]]`));
  assert.ok((await readFile(paperPath, 'utf8')).includes(`[[${keep.slice(0, -3)}#^source-evidence|evidence]]`));
  assert.ok((await readFile(paperPath, 'utf8')).includes(`[[${keep.slice(0, -3)}#${languageAnchor}|definition]]`));
  assert.equal(await readFile(removedPath, 'utf8'), removedNote);
  const compensate = 'compensate-maintenance';
  const reversal = await review(root, compensate, 'compensate', { transactionId: transaction.transaction_id });
  const restored = apply(root, compensate, reversal.inventory_sha256);
  assert.equal(restored.status, 'committed', JSON.stringify(restored));
  assert.deepEqual(await readFile(keepPath), before);
  assert.deepEqual(await readFile(paperPath), paperBefore);
  assert.ok((await readRegisteredCommit({ vaultRoot: root })).generation.shared_nodes.some(row => row.path === remove));
});

test('maintenance registration rejects an overlong window before business writes', async t => {
  const f = await published(t), root = f.vaultRoot, run = 'overlong-maintenance';
  const candidate = await buildNoteRelocationReview({ vaultRoot: root, runId: run, generation: run, assetMappings: [assetMapping(f)] });
  const { plan } = await dryRunBilingualPublication({ vaultRoot: root, run, review: candidate });
  const authority = await readingFirstPublicationAuthority({ ...f, runId: run }, plan, { windowDurationMs: 60 * 60_000 + 1 });
  await assert.rejects(registerBilingualPublication({ vaultRoot: root, run, plan, ...authority }), { code: 'P22_MAINTENANCE_WINDOW_REQUIRED' });
  assert.notEqual((await readRegisteredCommit({ vaultRoot: root })).generation_id, run);
});

for (const [mode, existingCanvas] of [['relocate', false], ['map-refresh', false], ['map-refresh', true]]) test(
  `existing recover rolls back ${existingCanvas ? 'registered map refresh' : mode} interrupted during promotion`, { timeout: 120_000 }, async t => {
  const legacy = mode === 'map-refresh' ? await legacyMapFixture(t) : null;
  const f = legacy?.f ?? await published(t), root = f.vaultRoot, run = 'interrupted-maintenance';
  const mapping = assetMapping(f), options = legacy?.options ?? { assetMappings: [mapping] };
  if (existingCanvas) {
    await registerLegacyCanvas(root, options);
    options.papers[0].map.steps[0].label.en = 'Updated map label before interruption';
  }
  const candidate = await review(root, run, mode, options);
  const firstAsset = candidate.targets.find(path => path === mapping.new_path || path.endsWith('.canvas'));
  const beforeAsset = existingCanvas ? await readFile(join(root, firstAsset)) : null;
  const notePaths = f.candidate.notes.map(note => note.path);
  const notes = await Promise.all(notePaths.map(path => readFile(join(root, path))));
  const marker = join(root, '.apa-v3/phase22/COMMITTED.json'), prior = await readFile(marker);
  const module = new URL('../../scripts/v3/maintenance-publication.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { applyMaintenanceReview } from ${JSON.stringify(module)};
    const [vaultRoot, run, inventorySha256] = process.argv.slice(1);
    const idle = setInterval(() => {}, 1000);
    try {
      await applyMaintenanceReview({ vaultRoot, run, inventorySha256, authorizationId: 'crash-approved', userReply: '批准',
        async onPromotionBoundary({ timing, kind }) {
          if (timing === 'after' && kind === 'asset') {
            process.send('promoted');
            await new Promise(() => {});
          }
        } });
    } finally { clearInterval(idle); }
  `, root, run, candidate.inventory_sha256], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exit = once(child, 'exit');
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  await Promise.race([
    once(child, 'message').then(([message]) => assert.equal(message, 'promoted')),
    once(child, 'close').then(([code]) => assert.fail(`maintenance process exited before interruption (${code}): ${stderr}`)),
  ]);
  const promotedAsset = await readFile(join(root, firstAsset));
  assert.ok(promotedAsset.length > 0);
  if (beforeAsset) assert.notDeepEqual(promotedAsset, beforeAsset);
  child.kill('SIGKILL');
  assert.equal((await exit)[1], 'SIGKILL');
  const intent = await json(join(publicationFolder(root, run), 'INTENT.json'));
  const result = cli(root, 'recover', run, ['--transaction-id', intent.transaction_id],
    { ...process.env, APA_V3_PUBLICATION_TRUST_ANCHOR: JSON.stringify(intent.trust_anchor) });
  assert.equal(result.status, 'rolled_back', JSON.stringify(result));
  assert.deepEqual(await readFile(marker), prior);
  if (beforeAsset) assert.deepEqual(await readFile(join(root, firstAsset)), beforeAsset);
  else await assert.rejects(readFile(join(root, firstAsset)), { code: 'ENOENT' });
  assert.deepEqual(await Promise.all(notePaths.map(path => readFile(join(root, path)))), notes);
  assert.equal((await readCommittedGeneration({ vaultRoot: root })).ok, true);
  assert.equal((await json(join(publicationFolder(root, run), 'VERIFICATION.json'))).status, 'rolled_back');
});
