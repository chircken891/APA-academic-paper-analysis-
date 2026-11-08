import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyBilingualPublication } from '../../scripts/v3/phase22-publication.mjs';
import { PHASE22_COMMIT_PATH, readRegisteredCommit } from '../../scripts/v3/phase22-active-version.mjs';
import { approveReadingFirstPublicationQueue, drainReadingFirstPublicationQueue, prepareReadingFirstPublicationQueue,
  readReadingFirstPublicationQueue } from '../../scripts/v3/reading-first-publication-queue.mjs';
import { captureReadingFirstPublicationSource } from '../../scripts/v3/reading-first-runtime.mjs';
import { publishReadingFirstCandidate, recoverRegisteredReadingFirstPublication } from '../../scripts/v3/reading-first-publish.mjs';
import { cleanupReadingRuntimeRun } from '../../scripts/v3/reading-runtime-cleanup.mjs';
import { prepareReadingRuntimeSnapshot, readReadingRuntimeSnapshotReference,
  registerReadingRuntimeSnapshotReference } from '../../scripts/v3/reading-runtime-snapshot.mjs';
import { applyReadingFirstFixture, readingFirstPublicationFixture } from './helpers/reading-first-publication-fixtures.mjs';
import { reviewedReadingFirstFixture } from './helpers/reading-first-publication-source-fixtures.mjs';

const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

async function fixture(t, count = 3, { sharedAsset = false, renamedNode = false, nearNode = false } = {}) {
  const first = await readingFirstPublicationFixture(t, { register: false });
  const entries = [], sources = new Map(), papers = [first];
  for (const [index, id] of ['a', 'b', 'c'].slice(0, count).entries()) {
    const presentation = structuredClone(first.presentationCatalog);
    if (index > 0) {
      presentation.bibliography.title = { en: 'Paper ' + id, 'zh-CN': '论文 ' + id };
      presentation.source_pdf = 'Raw/pap_' + id.repeat(32) + '.pdf';
      if (!sharedAsset) presentation.visuals[0].path = 'Figures/pap_' + id.repeat(32) + '/figure.png';
      if (renamedNode) {
        presentation.knowledge[0].title['zh-CN'] = '合成－方法';
        presentation.knowledge[0].title.en = 'SYNTHETIC method';
        presentation.knowledge[0].canonical_key = 'method-with-variant-spelling';
      }
      if (nearNode) {
        presentation.knowledge[0].title = { en: 'Applied Synthetic Method', 'zh-CN': '合成方法的实践' };
        presentation.knowledge[0].canonical_key = 'applied-synthetic-method';
        presentation.knowledge[0].aliases = [];
      }
    }
    presentation.knowledge[0].paragraphs.en.push('Independent addition for paper ' + id + '.');
    presentation.knowledge[0].paragraphs['zh-CN'].push('论文 ' + id + ' 的独立补充。');
    if (index > 0) papers.push(await reviewedReadingFirstFixture(t, { currentRegistryRoot: first.vaultRoot, presentation,
      runId: 'run_' + id.repeat(32), paperId: 'pap_' + id.repeat(32),
      sourceText: 'Independent source for paper ' + id + '.' }));
    const paper = papers[index];
    entries.push({ run: paper.runId, runRoot: paper.artifactRoot, resources: paper.resources, generation: 'queue-paper-' + id });
    sources.set(paper.runId, await captureReadingFirstPublicationSource({ controller: paper.controller, presentation: paper.candidate }));
  }
  const options = { vaultRoot: first.vaultRoot, evidenceMode: 'synthetic', captureSource: async ({ run }) => sources.get(run) };
  return { ...options, entries, papers, options };
}

async function approve(f, authorizationId = 'fixture-queue-approval') {
  const { proposal, proposal_sha256 } = await prepareReadingFirstPublicationQueue({ ...f.options, entries: f.entries });
  await approveReadingFirstPublicationQueue({ vaultRoot: f.vaultRoot, proposal, expectedProposalSha256: proposal_sha256,
    authorization: { authorization_id: authorizationId, user_reply: f.entries.length === 1 ? '发布' : '全部发布。' } });
  return proposal;
}

test('三篇共享节点的候选可预排演，并按批准顺序串行入库', async t => {
  const f = await fixture(t);
  const proposal = await approve(f);
  assert.deepEqual(proposal.entries.map(row => row.projected.summary.previous_generation), [null, 'queue-paper-a', 'queue-paper-b']);
  assert.deepEqual(proposal.entries.map(row => row.original.summary.previous_generation), [null, null, null]);
  await assert.rejects(lstat(join(f.vaultRoot, PHASE22_COMMIT_PATH)), { code: 'ENOENT' });
  const reports = [];
  const result = await drainReadingFirstPublicationQueue({ ...f.options, onPublished: report => reports.push(report) });
  assert.equal(result.status, 'complete', JSON.stringify(result));
  assert.deepEqual(reports.map(row => row.generation), ['queue-paper-a', 'queue-paper-b', 'queue-paper-c']);
  assert.deepEqual((await readRegisteredCommit({ vaultRoot: f.vaultRoot })).generation.papers.map(row => row.run_id),
    f.entries.map(row => row.run));
  assert.equal((await readRegisteredCommit({ vaultRoot: f.vaultRoot })).generation.shared_nodes.length, 1);
  for (const [index, report] of reports.entries()) {
    const original = await readJson(report.original_approval_record);
    assert.equal(original.output_inventory_hash, proposal.entries[index].original.summary.hashes.output_inventory_hash);
    const derived = await readJson(report.approval_record);
    if (index) {
      assert.equal(derived.original_approval_path, report.original_approval_record);
      assert.equal(derived.user_reply, '全部发布。');
      assert.ok(report.changes.some(row => row.kind === 'support'));
    }
    for (const note of f.papers[index].candidate.notes) {
      assert.equal(await readFile(join(f.vaultRoot, note.path), 'utf8'), note.content);
    }
  }
});

test('队首本篇笔记发生变化时等待重新批准，后续候选保持待发布', async t => {
  const f = await fixture(t, 2);
  await approve(f);
  const target = join(f.vaultRoot, f.papers[0].candidate.notes[0].path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, f.papers[0].candidate.notes[0].content);
  const result = await drainReadingFirstPublicationQueue(f.options);
  assert.equal(result.status, 'awaiting_reapproval', JSON.stringify(result));
  assert.deepEqual((await readReadingFirstPublicationQueue(f.options)).entries.map(row => row.status), ['awaiting_reapproval', 'queued']);
  await assert.rejects(lstat(join(f.vaultRoot, PHASE22_COMMIT_PATH)), { code: 'ENOENT' });
});

test('队列恢复保留先前提交事务，并从下一个待发布候选继续', async t => {
  const f = await fixture(t);
  await approve(f);
  let first;
  await assert.rejects(drainReadingFirstPublicationQueue({ ...f.options, onPublished: report => {
    first = report;
    throw new Error('interrupted after the durable commit');
  } }), /interrupted after the durable commit/);
  const before = await readReadingFirstPublicationQueue(f.options);
  assert.equal(before.entries[0].status, 'published');
  assert.equal(before.entries[0].result.transaction_id, first.transaction_id);
  const continued = [];
  const resumed = await drainReadingFirstPublicationQueue({ ...f.options, onPublished: report => continued.push(report) });
  assert.equal(resumed.status, 'complete', JSON.stringify(resumed));
  assert.deepEqual(continued.map(row => row.generation), ['queue-paper-b', 'queue-paper-c']);
  const after = await readReadingFirstPublicationQueue(f.options);
  assert.equal(after.entries[0].result.transaction_id, first.transaction_id);
});

test('先行提交使后续同字节资产写入消失时，需要重新批准该精确清单', async t => {
  const f = await fixture(t, 2, { sharedAsset: true });
  await approve(f);
  const result = await drainReadingFirstPublicationQueue(f.options);
  assert.equal(result.status, 'awaiting_reapproval');
  assert.equal(result.error.code, 'RF_ONE_STEP_REBASE_SCOPE');
  assert.equal(result.error.details.kind, 'asset');
  assert.deepEqual((await readReadingFirstPublicationQueue(f.options)).entries.map(row => row.status), ['published', 'awaiting_reapproval']);
  assert.equal((await readRegisteredCommit({ vaultRoot: f.vaultRoot })).generation.papers.length, 1);
});

test('批准顺序、原清单与其哈希重读时保持绑定', async t => {
  const f = await fixture(t, 2);
  const { proposal, proposal_sha256 } = await prepareReadingFirstPublicationQueue({ ...f.options, entries: f.entries });
  await assert.rejects(approveReadingFirstPublicationQueue({ vaultRoot: f.vaultRoot, proposal: { ...proposal, entries: proposal.entries.toReversed() },
    expectedProposalSha256: proposal_sha256, authorization: { authorization_id: 'order-check', user_reply: '全部发布' } }),
  { code: 'RF_QUEUE_PROPOSAL_CHANGED' });
  await approveReadingFirstPublicationQueue({ vaultRoot: f.vaultRoot, proposal, expectedProposalSha256: proposal_sha256,
    authorization: { authorization_id: 'order-check', user_reply: '全部发布' } });
  const { queue_path, ...state } = await readReadingFirstPublicationQueue(f.options);
  const original = structuredClone(state);
  state.entries.reverse();
  await writeFile(queue_path, JSON.stringify(state));
  await assert.rejects(drainReadingFirstPublicationQueue(f.options), { code: 'RF_QUEUE_APPROVED_ORDER_CHANGED' });
  original.approvals[0].proposal.entries[0].original.summary.files.pop();
  await writeFile(queue_path, JSON.stringify(original));
  await assert.rejects(drainReadingFirstPublicationQueue(f.options), { code: 'RF_QUEUE_APPROVAL_CHANGED' });
  await assert.rejects(lstat(join(f.vaultRoot, PHASE22_COMMIT_PATH)), { code: 'ENOENT' });
});

test('批准后的来源字节变化拦截论文写入，即使先行发布已经换代', async t => {
  const f = await fixture(t, 2);
  await approve(f);
  const result = await drainReadingFirstPublicationQueue({ ...f.options, onPublished: async report => {
    if (report.generation === 'queue-paper-a') await writeFile(f.papers[1].source.path, 'Changed scientific source bytes');
  } });
  assert.equal(result.status, 'awaiting_reapproval');
  assert.equal((await readRegisteredCommit({ vaultRoot: f.vaultRoot })).generation.papers.length, 1);
  await assert.rejects(lstat(join(f.vaultRoot, f.papers[1].candidate.notes[0].path)), { code: 'ENOENT' });
});

test('身份规范化改指已有节点，仅放行证明中的新旧共享路径和论文链接', async t => {
  const f = await fixture(t, 2, { renamedNode: true });
  const previous = f.papers[1].candidate.supportNotes[0].path;
  const canonical = f.papers[0].candidate.supportNotes[0].path;
  assert.notEqual(previous, canonical);
  await approve(f);
  const result = await drainReadingFirstPublicationQueue(f.options);
  assert.equal(result.status, 'complete', JSON.stringify(result.error));
  const proof = await readJson(result.published[1].rebase_record_path);
  assert.deepEqual(proof.identity_mappings.map(row => [row.from_path, row.to_path]), [[previous, canonical]]);
  const changed = result.published[1].changes;
  assert.deepEqual(changed.filter(row => row.kind === 'support').map(row => row.path).sort(), [previous, canonical].sort());
  assert.equal(changed.filter(row => row.kind === 'paper').length, 2);
  for (const note of f.papers[1].candidate.notes) {
    const output = await readFile(join(f.vaultRoot, note.path), 'utf8');
    assert.equal(output.replaceAll(encodeURIComponent(basename(canonical)), encodeURIComponent(basename(previous))), note.content);
  }
});

test('登记后未开始写入的尝试经原事务恢复，队首换代重试且前篇保持原事务', async t => {
  const f = await fixture(t, 2);
  await approve(f);
  const lock = join(f.vaultRoot, '.apa-v3', 'phase22', 'publication.lock');
  const stopped = await drainReadingFirstPublicationQueue({ ...f.options, onPrepared: async summary => {
    if (summary.generation === 'queue-paper-b') await writeFile(lock, JSON.stringify({ transaction_id: 'synthetic-held-lock' }), { flag: 'wx' });
  } });
  assert.equal(stopped.status, 'recovery_required', JSON.stringify(stopped.error));
  assert.equal(stopped.error.code, 'P22_VAULT_LOCKED');
  const state = await readReadingFirstPublicationQueue(f.options);
  assert.equal(state.entries[1].status, 'applying');
  const attemptId = state.entries[1].attempt.registration.transaction_id;
  await unlink(lock);
  const start = Date.now();
  t.mock.method(Date, 'now', () => start + 16 * 60_000);
  const resumed = await drainReadingFirstPublicationQueue(f.options);
  assert.equal(resumed.status, 'complete', JSON.stringify(resumed.error));
  assert.equal(resumed.published.length, 1);
  assert.notEqual(resumed.published[0].transaction_id, attemptId);
  const final = await readReadingFirstPublicationQueue(f.options);
  assert.equal(final.entries[0].result.transaction_id, state.entries[0].result.transaction_id);
  assert.equal(final.entries[1].recovered_attempts[0].recovery.status, 'rolled_back');
  const renewal = await readJson(final.entries[1].recovered_attempts[0].recovery.recovery_window_record);
  assert.equal(renewal.recovery.transaction_id, attemptId);
  assert.equal(Date.parse(renewal.ends_at) - Date.parse(renewal.starts_at), 15 * 60_000);
});

test('事务已提交但队列尚未记账时，从原核验记录确认，跳过已回收的来源', async t => {
  const f = await fixture(t, 1);
  await approve(f);
  const result = await drainReadingFirstPublicationQueue(f.options);
  assert.equal(result.status, 'complete', JSON.stringify(result.error));
  const { queue_path, ...state } = await readReadingFirstPublicationQueue(f.options);
  state.entries[0].status = 'applying';
  delete state.entries[0].result;
  await writeFile(queue_path, JSON.stringify(state));
  const journal = join(f.vaultRoot, result.published[0].journal_path);
  await rename(journal, journal + '.retained');
  const missing = await drainReadingFirstPublicationQueue({ ...f.options, captureSource: () => assert.fail('must not reopen a committed run') });
  assert.equal(missing.error?.code, 'P22_TRANSACTION_JOURNAL_REQUIRED');
  await rename(journal + '.retained', journal);
  const resumed = await drainReadingFirstPublicationQueue({ ...f.options, captureSource: () => assert.fail('must not reopen a committed run') });
  assert.equal(resumed.status, 'complete');
  assert.equal(resumed.published[0].transaction_id, result.published[0].transaction_id);
});

test('定义相近时保存待判断草稿，后续论文仍可发布新节点', async t => {
  const f = await fixture(t, 2, { nearNode: true });
  await approve(f);
  const result = await drainReadingFirstPublicationQueue(f.options);
  assert.equal(result.status, 'complete', JSON.stringify(result.error));
  const { knowledge_merge_drafts: draft } = result.published[1];
  assert.equal(draft.status, 'awaiting_judgment');
  const record = await readJson(draft.path);
  assert.equal(record.model_calls, 0);
  assert.equal(record.pairs[0].candidate_path, f.papers[1].candidate.supportNotes[0].path);
  assert.equal(record.pairs[0].registered_path, f.papers[0].candidate.supportNotes[0].path);
  assert.ok(record.pairs[0].candidate_definition.length && record.pairs[0].registered_definition.length);
  assert.equal((await readRegisteredCommit({ vaultRoot: f.vaultRoot })).generation.shared_nodes.length, 2);
});

test('双哈希相同也要核对批准时展示的实际文件清单', async t => {
  const f = await fixture(t, 1);
  const { proposal } = await prepareReadingFirstPublicationQueue({ ...f.options, entries: f.entries });
  const row = proposal.entries[0].original.summary.files.find(item => item.kind === 'paper');
  row.byte_sha256 = 'sha256:' + '0'.repeat(64);
  const claimed = 'sha256:' + createHash('sha256').update(JSON.stringify(proposal, null, 2) + '\n').digest('hex');
  await approveReadingFirstPublicationQueue({ vaultRoot: f.vaultRoot, proposal, expectedProposalSha256: claimed,
    authorization: { authorization_id: 'fixture-mismatched-files', user_reply: '发布' } });
  const result = await drainReadingFirstPublicationQueue(f.options);
  assert.equal(result.error.code, 'RF_ONE_STEP_QUEUE_INVENTORY_CHANGED');
  await assert.rejects(lstat(join(f.vaultRoot, PHASE22_COMMIT_PATH)), { code: 'ENOENT' });
});

test('已审复用后来变为多目标，旧批准暂停，精确重新批准后才按新节点发布', async t => {
  const first = await readingFirstPublicationFixture(t);
  assert.equal((await applyBilingualPublication(applyReadingFirstFixture(first))).status, 'committed');
  const makeCatalog = id => {
    const catalog = structuredClone(first.presentationCatalog);
    catalog.bibliography.title = { en: 'Paper ' + id, 'zh-CN': '论文 ' + id };
    catalog.source_pdf = 'Raw/pap_' + id.repeat(32) + '.pdf';
    catalog.visuals[0].path = 'Figures/pap_' + id.repeat(32) + '/figure.png';
    return catalog;
  };
  const next = await reviewedReadingFirstFixture(t, { currentRegistryRoot: first.vaultRoot, presentation: makeCatalog('b'),
    runId: 'run_' + 'b'.repeat(32), paperId: 'pap_' + 'b'.repeat(32), sourceText: 'Reviewed paper B.' });
  assert.equal(next.candidate.supportNotes[0].path, first.candidate.supportNotes[0].path);
  const source = await captureReadingFirstPublicationSource({ controller: next.controller, presentation: next.candidate });
  const options = { vaultRoot: first.vaultRoot, evidenceMode: 'synthetic', captureSource: async () => source };
  const f = { vaultRoot: first.vaultRoot, options, entries: [{ run: next.runId, runRoot: next.artifactRoot, generation: 'queued-review-b', resources: next.resources }] };
  await approve(f);
  const otherCatalog = makeCatalog('d');
  otherCatalog.knowledge[0].title['zh-CN'] = '另一登记候选';
  const other = await readingFirstPublicationFixture(t, { presentation: otherCatalog, vaultRoot: first.vaultRoot, generation: 'ambiguity-introduced',
    runId: 'run_' + 'd'.repeat(32), paperId: 'pap_' + 'd'.repeat(32), sourceText: 'Earlier registered paper D.' });
  assert.equal((await applyBilingualPublication(applyReadingFirstFixture(other))).status, 'committed');
  const paused = await drainReadingFirstPublicationQueue(options);
  assert.equal(paused.status, 'awaiting_reapproval');
  assert.equal(paused.error.code, 'RF_ONE_STEP_IDENTITY_REAPPROVAL_REQUIRED');
  assert.equal((await readRegisteredCommit(options)).generation.papers.length, 2);
  let displayed;
  const standalone = await publishReadingFirstCandidate({ source, vaultRoot: f.vaultRoot, resources: next.resources, evidenceMode: 'synthetic',
    generation: 'standalone-ambiguity', authorization: { authorization_id: 'fixture-standalone', user_reply: '发布' },
    onPrepared: summary => { displayed = summary; } });
  assert.equal(standalone.status, 'awaiting_reapproval');
  assert.equal(displayed.requires_reapproval, true);
  assert.ok(displayed.knowledge_merge_drafts?.count >= 2);
  const proposed = await approve(f, 'fixture-exact-ambiguity-reapproval');
  assert.equal(proposed.entries[0].original.rebase_proof.review_required, true);
  const resumed = await drainReadingFirstPublicationQueue(options);
  assert.equal(resumed.status, 'complete', JSON.stringify(resumed.error));
  assert.equal((await readRegisteredCommit(options)).generation.shared_nodes.length, 3);
});

test('已写发布终态但未回收时，验证原事务后完成同一运行的回收', async t => {
  const f = await fixture(t, 1);
  await approve(f);
  const result = await drainReadingFirstPublicationQueue(f.options);
  assert.equal(result.status, 'complete', JSON.stringify(result.error));
  const { run, runRoot } = f.entries[0], repoRoot = f.vaultRoot;
  const codeRoot = fileURLToPath(new URL('../../', import.meta.url));
  const execution = { repoRoot, runId: run, runRoot };
  const manifest = prepareReadingRuntimeSnapshot({ ...execution, codeRoot });
  registerReadingRuntimeSnapshotReference({ ...execution, manifest });
  const transaction = result.published[0];
  const terminal = { profile: 'reading-runtime-cleanup-1.0', run_id: run, status: 'published', runtime_fingerprint: manifest.fingerprint,
    recorded_at: new Date().toISOString(), publication: { transaction_id: transaction.transaction_id, generation: transaction.generation } };
  await writeFile(join(runRoot, 'runtime-terminal.json'), JSON.stringify(terminal), { flag: 'wx' });
  try {
    const { entries } = await readReadingFirstPublicationQueue(f.options);
    const recovered = await recoverRegisteredReadingFirstPublication({ vaultRoot: f.vaultRoot, run, attempt: entries[0].attempt,
      readExecution: async () => ({ ...execution, terminal }) });
    assert.equal(recovered.runtime_cleanup?.snapshot_status, 'removed', JSON.stringify(recovered.runtime_cleanup));
    assert.equal(readReadingRuntimeSnapshotReference(execution), null);
  } finally {
    if (readReadingRuntimeSnapshotReference(execution)) await cleanupReadingRuntimeRun(execution);
  }
});
