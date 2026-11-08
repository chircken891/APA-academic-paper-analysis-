import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { publishReadingFirstCandidate } from '../../scripts/v3/reading-first-publish.mjs';
import { applyBilingualPublication } from '../../scripts/v3/phase22-publication.mjs';
import { inspectManagedNote } from '../../scripts/v3/phase22-managed-markdown.mjs';
import { prepareReadingFirstPublication } from '../../scripts/v3/reading-first-publication.mjs';
import { captureReadingFirstPublicationSource } from '../../scripts/v3/reading-first-runtime.mjs';
import { applyReadingFirstFixture, readingFirstPublicationFixture } from './helpers/reading-first-publication-fixtures.mjs';
import { reviewedReadingFirstFixture } from './helpers/reading-first-publication-source-fixtures.mjs';

const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const fileSha = async path => 'sha256:' + createHash('sha256').update(await readFile(path)).digest('hex');
const publicationRoot = (root, run) => join(root, 'Eval', 'apa-v3', 'runs', run, 'publication');
const approval = { authorization_id: 'test-one-step-publication', user_reply: '发布。' };
const parameters = fixture => ({
  source: fixture.source, vaultRoot: fixture.vaultRoot, resources: fixture.resources,
  evidenceMode: 'synthetic', generation: 'published-one-step', authorization: approval,
});
async function snapshotVault(root) {
  const result = {};
  async function visit(folder, prefix = '') {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (!prefix && entry.name === 'Eval') continue;
      const path = prefix + entry.name;
      if (entry.isDirectory()) await visit(join(folder, entry.name), path + '/');
      else result[path] = await readFile(join(folder, entry.name));
    }
  }
  await visit(root);
  return result;
}
async function write(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

test('一步发布先展示精确清单，再绑定原话、15 分钟窗口和提交结果', async t => {
  const fixture = await readingFirstPublicationFixture(t, { register: false });
  let displayed;
  const result = await publishReadingFirstCandidate({ ...parameters(fixture),
    onPrepared: async summary => {
      assert.deepEqual(await snapshotVault(fixture.vaultRoot), {});
      displayed = summary;
    },
  });
  assert.equal(result.status, 'committed');
  assert.equal(result.ok, true);
  const record = await readJson(result.approval_record);
  const manifest = await readJson(record.inventory_path);
  assert.deepEqual(record.inventory_paths, displayed.files.map(row => row.path));
  assert.deepEqual(manifest.hashes, displayed.hashes);
  assert.equal(record.review_hash, displayed.hashes.review_hash);
  assert.equal(record.output_inventory_hash, displayed.hashes.output_inventory_hash);
  assert.equal(record.user_reply, approval.user_reply);
  assert.equal(record.authorization_id, approval.authorization_id);
  assert.equal(record.inventory_sha256, await fileSha(record.inventory_path));
  const window = await readJson(result.maintenance_window_record);
  assert.equal(Date.parse(window.ends_at) - Date.parse(window.starts_at), 15 * 60_000);
  assert.equal((await readJson(join(publicationRoot(fixture.vaultRoot, fixture.run), 'VERIFICATION.json'))).status, 'passed');
  assert.match(await readFile(join(publicationRoot(fixture.vaultRoot, fixture.run), 'RESULT.md'), 'utf8'), /published-one-step/);
});

async function successivePapers(t) {
  const first = await readingFirstPublicationFixture(t);
  assert.equal((await applyBilingualPublication(applyReadingFirstFixture(first))).status, 'committed');
  const catalog = structuredClone(first.presentationCatalog);
  catalog.knowledge[0].paragraphs.en.push('A distinct publication addition.');
  catalog.knowledge[0].paragraphs['zh-CN'].push('本篇独立增补。');
  const next = await reviewedReadingFirstFixture(t, { currentRegistryRoot: first.vaultRoot, presentation: catalog,
    runId: 'run_' + 'b'.repeat(32), paperId: 'pap_' + 'b'.repeat(32),
    title: { en: 'Second paper', 'zh-CN': '第二篇论文' },
  });
  const source = await captureReadingFirstPublicationSource({ controller: next.controller, presentation: next.candidate });
  return { ...next, source, vaultRoot: first.vaultRoot, support: first.candidate.supportNotes[0].path };
}

for (const timing of ['before prepare', 'after original approval']) {
  test('共享页自动变基保留当前正文和人工区 ' + timing, async t => {
    const f = await successivePapers(t);
    const path = join(f.vaultRoot, f.support);
    const edit = async () => {
      const original = await readFile(path, 'utf8');
      await writeFile(path, original.replace('<!-- AUTO:END shared-knowledge -->',
        'Manual editing inside.\n<!-- AUTO:END shared-knowledge -->') + '\nManual editing outside.\n');
    };
    const summaries = [];
    if (timing === 'before prepare') await edit();
    const result = await publishReadingFirstCandidate({ ...parameters(f),
      onPrepared: async summary => {
        summaries.push(summary);
        if (timing === 'after original approval' && summaries.length === 1) await edit();
      },
    });
    assert.equal(result.status, 'committed', JSON.stringify(result.error));
    const output = await readFile(path, 'utf8');
    assert.match(output, /Manual editing inside/);
    assert.match(output, /Manual editing outside/);
    assert.match(output, /A distinct publication addition/);
    for (const note of f.candidate.notes) assert.equal(await readFile(join(f.vaultRoot, note.path), 'utf8'), note.content);
    const original = await readJson(result.original_approval_record);
    assert.equal(original.output_inventory_hash, summaries[0].hashes.output_inventory_hash);
    const record = await readJson(result.approval_record);
    if (timing === 'after original approval') {
      assert.equal(summaries.length, 2);
      assert.equal(record.original_approval_path, result.original_approval_record);
      assert.equal(record.original_approval_sha256, await fileSha(result.original_approval_record));
      assert.equal(record.original_hashes.output_inventory_hash, original.output_inventory_hash);
      assert.equal(record.new_hashes.output_inventory_hash, record.output_inventory_hash);
      assert.notEqual(record.output_inventory_hash, original.output_inventory_hash);
    } else assert.equal(result.approval_record, result.original_approval_record);
    assert.equal((await readJson(record.rebase_record_path)).original_recipe_fingerprint, original.original_source.recipe_fingerprint);
    assert.ok((await readFile(record.rebase_diff_path, 'utf8')).includes(f.support));
    const row = result.changes.find(change => change.path === f.support);
    const publishedReport = await readFile(result.result_path, 'utf8');
    assert.ok(publishedReport.includes(row.old_sha256));
    assert.ok(publishedReport.includes(row.new_sha256));
  });
}

test('两个先行审阅的论文陆续发布时，后一个从新建共享页转为增补', async t => {
  const first = await readingFirstPublicationFixture(t);
  const catalog = structuredClone(first.presentationCatalog);
  catalog.knowledge[0].paragraphs.en.push('Independent content reviewed before the first commit.');
  catalog.knowledge[0].paragraphs['zh-CN'].push('首篇提交前已经审阅的独立内容。');
  const next = await reviewedReadingFirstFixture(t, { currentRegistryRoot: first.vaultRoot, presentation: catalog,
    runId: 'run_' + 'e'.repeat(32), paperId: 'pap_' + 'e'.repeat(32) });
  assert.equal(next.candidate.supportNotes[0].path, first.candidate.supportNotes[0].path);
  const source = await captureReadingFirstPublicationSource({ controller: next.controller, presentation: next.candidate });
  assert.equal((await applyBilingualPublication(applyReadingFirstFixture(first))).status, 'committed');
  const result = await publishReadingFirstCandidate({ ...parameters({ ...next, source, vaultRoot: first.vaultRoot }), onPrepared() {} });
  assert.equal(result.status, 'committed', JSON.stringify(result.error));
  const rebase = await readJson(result.rebase_record_path);
  assert.deepEqual(rebase.nodes.map(row => [row.mode_before, row.mode_after]), [['created', 'reused']]);
  const shared = await readFile(join(first.vaultRoot, next.candidate.supportNotes[0].path), 'utf8');
  assert.match(shared, /An independent reusable explanation/);
  assert.match(shared, /Independent content reviewed before the first commit/);
});

for (const problem of ['paper', 'asset', 'generation']) {
  test('拒绝异常目标且正式库零写入 ' + problem, async t => {
    const f = await readingFirstPublicationFixture(t, { register: false });
    if (problem === 'paper') {
      const note = f.candidate.notes[0];
      await write(join(f.vaultRoot, note.path), note.content.replace('<!-- AUTO:START reading -->', '<!-- AUTO:START reading -->\nHuman edit.'));
    } else if (problem === 'asset') {
      await write(join(f.vaultRoot, f.resources[0].path), 'Foreign resource bytes');
    } else {
      await write(join(f.vaultRoot, '.apa-v3/phase22/generations/published-one-step/manifest.json'), 'Foreign manifest bytes');
    }
    const before = await snapshotVault(f.vaultRoot);
    const result = await publishReadingFirstCandidate({ ...parameters(f), onPrepared() {} });
    assert.equal(result.ok, false);
    assert.ok(['refused', 'awaiting_reapproval'].includes(result.status));
    assert.equal(result.business_writes, 0);
    assert.ok((await readJson(result.review_path)).error.code);
    assert.deepEqual(await snapshotVault(f.vaultRoot), before);
  });
}

test('摘要之后的本篇目标变化要求重新批准', async t => {
  const f = await readingFirstPublicationFixture(t, { register: false });
  let afterExternalEdit;
  const result = await publishReadingFirstCandidate({ ...parameters(f), onPrepared: async () => {
    const note = f.candidate.notes[0];
    await write(join(f.vaultRoot, note.path), note.content);
    afterExternalEdit = await snapshotVault(f.vaultRoot);
  } });
  assert.equal(result.status, 'awaiting_reapproval');
  assert.equal(result.business_writes, 0);
  assert.deepEqual(await snapshotVault(f.vaultRoot), afterExternalEdit);
});

test('已登记的本篇正文在重发候选生成后被人工编辑时保留原文', async t => {
  const first = await readingFirstPublicationFixture(t);
  assert.equal((await applyBilingualPublication(applyReadingFirstFixture(first))).status, 'committed');
  const existingTargets = await Promise.all(first.candidate.notes.map(async note => {
    const bytes = await readFile(join(first.vaultRoot, note.path));
    return { path: note.path, bytes, managedHash: inspectManagedNote(bytes).managedHash };
  }));
  const next = await reviewedReadingFirstFixture(t, {
    currentRegistryRoot: first.vaultRoot, paperId: first.paperId, runId: 'run_' + 'd'.repeat(32),
    targetRegistry: [first.candidate.targetRegistry], existingTargets,
  });
  const source = await captureReadingFirstPublicationSource({ controller: next.controller, presentation: next.candidate });
  const args = parameters({ ...next, source, vaultRoot: first.vaultRoot });
  const original = await prepareReadingFirstPublication(args);
  assert.equal(original.plan.inventory.filter(row => row.kind === 'paper' && row.before_sha256 !== null).length, 2);
  const path = join(first.vaultRoot, existingTargets[0].path);
  await writeFile(path, existingTargets[0].bytes.toString('utf8').replace('<!-- AUTO:START reading -->',
    '<!-- AUTO:START reading -->\nHuman edit in the registered paper.'));
  const before = await snapshotVault(first.vaultRoot);
  const result = await publishReadingFirstCandidate({ ...args, onPrepared: () => assert.fail('changed paper should not be approvable') });
  assert.equal(result.status, 'refused', JSON.stringify(result.error));
  assert.equal(result.error.code, 'RF_ONE_STEP_PAPER_CHANGED');
  assert.equal(result.business_writes, 0);
  assert.deepEqual(await snapshotVault(first.vaultRoot), before);
});

test('共享页在派生清单展示后又变化时，拦截最终 dry-run', async t => {
  const f = await successivePapers(t);
  const path = join(f.vaultRoot, f.support);
  let before, displays = 0;
  const result = await publishReadingFirstCandidate({ ...parameters(f), onPrepared: async () => {
    displays++;
    const current = await readFile(path, 'utf8');
    await writeFile(path, current + '\nManual edit ' + displays + '.\n');
    before = await snapshotVault(f.vaultRoot);
  } });
  assert.equal(displays, 2);
  assert.equal(result.status, 'awaiting_reapproval');
  assert.equal(result.business_writes, 0);
  assert.deepEqual(await snapshotVault(f.vaultRoot), before);
});

test('无法读取共享页底稿时停止变基，正式库文件维持原状', async t => {
  const f = await successivePapers(t);
  const path = join(f.vaultRoot, f.support);
  const old = await readFile(path, 'utf8');
  await writeFile(path, old.replace('<!-- AUTO:END shared-knowledge -->', ''));
  const before = await snapshotVault(f.vaultRoot);
  const result = await publishReadingFirstCandidate({ ...parameters(f), onPrepared: () => assert.fail('missing boundary is not approvable') });
  assert.equal(result.status, 'refused');
  assert.equal(result.business_writes, 0);
  assert.deepEqual(await snapshotVault(f.vaultRoot), before);
});

test('非明确发布回复与任意 JSON 来源无权生成发布记录', async t => {
  const f = await readingFirstPublicationFixture(t, { register: false });
  await assert.rejects(publishReadingFirstCandidate({ ...parameters(f), onPrepared() {},
    authorization: { ...approval, user_reply: '不要发布' } }), /RF_ONE_STEP_APPROVAL_REQUIRED/);
  await assert.rejects(publishReadingFirstCandidate({ ...parameters(f), onPrepared() {}, source: { ...f.source } }),
    /READING_FIRST_PUBLICATION_SOURCE_REQUIRED/);
  assert.deepEqual(await readdir(f.vaultRoot), []);
});
