import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyReadingFirstFixture, readingFirstPublicationAuthority, readingFirstPublicationFixture } from './helpers/reading-first-publication-fixtures.mjs';
import { readRegisteredCommit } from '../../scripts/v3/phase22-active-version.mjs';
import { applyBilingualPublication, dryRunBilingualPublication, registerBilingualPublication } from '../../scripts/v3/phase22-publication.mjs';
import { buildNoteRelocationReview } from '../../scripts/v3/note-relocation.mjs';

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

test('existing recover rolls back a maintenance process interrupted during promotion', { timeout: 120_000 }, async t => {
  const f = await published(t), root = f.vaultRoot, run = 'interrupted-maintenance';
  const mapping = assetMapping(f), candidate = await review(root, run, 'relocate', { assetMappings: [mapping] });
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
  assert.ok((await readFile(join(root, mapping.new_path))).length > 0);
  child.kill('SIGKILL');
  assert.equal((await exit)[1], 'SIGKILL');
  const intent = await json(join(publicationFolder(root, run), 'INTENT.json'));
  const result = cli(root, 'recover', run, ['--transaction-id', intent.transaction_id],
    { ...process.env, APA_V3_PUBLICATION_TRUST_ANCHOR: JSON.stringify(intent.trust_anchor) });
  assert.equal(result.status, 'rolled_back', JSON.stringify(result));
  assert.deepEqual(await readFile(marker), prior);
  await assert.rejects(readFile(join(root, mapping.new_path)), { code: 'ENOENT' });
  assert.equal((await json(join(publicationFolder(root, run), 'VERIFICATION.json'))).status, 'rolled_back');
});
