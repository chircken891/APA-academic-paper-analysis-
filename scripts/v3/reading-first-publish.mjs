import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { createOwnedArtifactBroker } from './owned-artifact-store.mjs';
import { PHASE22_COMMIT_PATH, phase22GenerationPaths, readRegisteredCommit } from './phase22-active-version.mjs';
import { applyBilingualPublication, dryRunBilingualPublication, inspectBilingualPublicationRecovery,
  recoverBilingualPublication, registerBilingualPublication } from './phase22-publication.mjs';
import { applyReadingFirstSourceDerivation, applyReadingFirstUserCorrections, assertReadingFirstPublicationSourceChoicesCurrent, assertReadingFirstRegisteredSourcesCurrent,
  prepareReadingFirstPublication } from './reading-first-publication.mjs';
import { deriveRebasedReadingFirstPublicationSource, inspectReadingFirstKnowledgeMergeCandidates,
  inspectReadingFirstPublicationSource } from './reading-first-runtime.mjs';
import { cleanupPublishedReadingRuntime, cleanupReadingRuntimeRun, withReadingRuntimePublicationConsumer } from './reading-runtime-cleanup.mjs';

const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value);
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const fail = (code, details) => { throw Object.assign(new Error(code), { code, details }); };
const hashesOf = ({ hashes }) => ({ review_hash: hashes.review_hash, output_inventory_hash: hashes.output_inventory_hash });
const generationKinds = new Set(['active', 'index', 'manifest', 'commit']);
const driftCodes = new Set(['RF_PUBLICATION_KNOWLEDGE_CHANGED_SINCE_RENDER', 'RF_PUBLICATION_PREIMAGE_CHANGED',
  'P22_PUBLICATION_PREIMAGE_CHANGED', 'P22_PUBLICATION_REUSE_CHANGED', 'P22_PREVIOUS_GENERATION_CHANGED']);
const writeJson = (path, value) => writeFile(path, json(value), { flag: 'wx' });

async function publicationDirectory(root, run) {
  let folder = root;
  for (const segment of ['Eval', 'apa-v3', 'runs', run, 'publication']) {
    folder = join(folder, segment);
    try { await mkdir(folder); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const entry = await lstat(folder);
    if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(folder) !== folder) fail('RF_ONE_STEP_EVIDENCE_PATH_INVALID');
  }
  return folder;
}

export async function persistReadingFirstQueueApproval(root, run, record) {
  const folder = await publicationDirectory(root, run);
  const path = join(folder, 'QUEUE-APPROVAL-' + sha(record.authorization.authorization_id).slice(7) + '.json');
  const bytes = json(record);
  try { await writeFile(path, bytes, { flag: 'wx', flush: true }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !(await readFile(path)).equals(bytes)) {
      fail('RF_QUEUE_APPROVAL_CHANGED', { path });
    }
  }
  return path;
}

async function requireUnusedResult(folder) {
  for (const name of ['RESULT.md', 'VERIFICATION.json']) {
    try { await lstat(join(folder, name)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    fail('RF_ONE_STEP_RESULT_EXISTS', { path: join(folder, name) });
  }
}

function verifySharedAddition(row, data) {
  const registry = data.knowledge_rebase?.rendering.knowledgeRegistry ?? data.recipe.rendering?.knowledgeRegistry ?? [];
  const before = registry.find(item => item.path === row.path || item.canonical_path === row.path);
  if (before?.current_content !== true || typeof before.content !== 'string' || sha(before.content) !== row.before_sha256) {
    fail('RF_ONE_STEP_SHARED_PREIMAGE_REQUIRED', { path: row.path });
  }
  // The renderer can refresh the invisible knowledge state and append within the managed region.
  // Preserve all visible bytes, including edits within that region.
  const withoutState = value => value.replace(/<!-- KNOWLEDGE_STATE [A-Za-z0-9+/=]+ -->/, '');
  const end = '<!-- AUTO:END shared-knowledge -->', at = before.content.indexOf(end);
  const output = row.bytes.toString('utf8');
  const prior = withoutState(at < 0 ? before.content : before.content.slice(0, at));
  const suffix = at < 0 ? '' : before.content.slice(at);
  const next = withoutState(output);
  if (!next.startsWith(prior) || !next.endsWith(suffix) || next.length < prior.length + suffix.length) {
    fail('RF_ONE_STEP_SHARED_CONTENT_CHANGED', { path: row.path });
  }
}

function checkScope(plan, data) {
  const rendering = data.recipe.rendering;
  const pairs = phase22GenerationPaths(plan.generation);
  const requiredTargets = { active: pairs.active, index: pairs.index,
    manifest: '.apa-v3/phase22/generations/' + plan.generation + '/manifest.json', commit: PHASE22_COMMIT_PATH };
  const paperPaths = new Set(data.candidate.notes.map(note => note.path));
  const supportPaths = new Set((data.candidate.supportNotes ?? []).map(note => note.path));
  for (const row of plan.inventory) {
    const overwrite = row.before_sha256 !== null;
    if (!(row.bytes instanceof Uint8Array) || typeof row.byte_sha256 !== 'string') fail('RF_ONE_STEP_WRITE_SCOPE', { path: row.path });
    if (row.kind === 'paper' && paperPaths.has(row.path)) {
      const original = rendering?.existingTargets?.find(note => note.path === row.path)?.bytes_base64;
      const expected = typeof original === 'string' ? sha(Buffer.from(original, 'base64')) : null;
      if (row.before_sha256 !== expected) fail('RF_ONE_STEP_PAPER_CHANGED', { path: row.path, expected, observed: row.before_sha256 });
    } else if (row.kind === 'support' && supportPaths.has(row.path)) {
      if (overwrite) verifySharedAddition(row, data);
    } else if (row.kind === 'asset' && !overwrite) {
      continue;
    } else if (requiredTargets[row.kind] === row.path && (!overwrite || row.kind === 'commit')) {
      continue;
    } else if (row.kind === 'reader-presentation' && !overwrite && row.path.startsWith('.apa-v3/reading-first/presentation/' + plan.run_id + '-')) {
      continue;
    } else fail('RF_ONE_STEP_WRITE_SCOPE', { path: row.path, kind: row.kind, overwrite });
  }
}

export function summarizeReadingFirstPublication(plan, publicationSources, review) {
  const counts = { create: 0, augment: 0, overwrite: 0 };
  const files = plan.inventory.map(({ path, kind, byte_sha256, byte_length, before_sha256, before_byte_length }) => {
    const operation = before_sha256 === null ? 'create' : kind === 'support' ? 'augment' : 'overwrite';
    counts[operation]++;
    return { path, kind, operation, byte_sha256, byte_length, before_sha256, before_byte_length };
  });
  return { run_id: plan.run_id, analysis_revision: plan.analysis_revision, generation: plan.generation,
    previous_generation: plan.previous_generation, hashes: hashesOf(plan), counts, files,
    ...(review?.reviewManifest.provenance_limits.user_corrections ? { user_corrections: review.reviewManifest.provenance_limits.user_corrections } : {}),
    ...(review?.reviewManifest.provenance_limits.knowledge_render_hashes ? { knowledge_render_hashes: review.reviewManifest.provenance_limits.knowledge_render_hashes } : {}),
    ...(review?.diagnostics.length ? { diagnostics: review.diagnostics } : {}),
    ...(review ? { candidate_source_bindings: { assets: review.reviewManifest.assets,
      derivation: review.reviewManifest.dependencies.source_derivation ?? null } } : {}),
    ...(publicationSources && Object.values(publicationSources).some(rows => rows.length) ? { publication_sources: publicationSources } : {}) };
}

function comparePlans(original, derived, record, originalRecord, data) {
  if (original.run_id !== derived.run_id || original.analysis_revision !== derived.analysis_revision
    || !same(original.candidate_source_bindings, derived.candidate_source_bindings)
    || !same(original.user_corrections, derived.user_corrections)) fail('RF_ONE_STEP_REBASE_SOURCE_SCOPE');
  const old = new Map(original.files.map(row => [row.path, row]));
  const next = new Map(derived.files.map(row => [row.path, row]));
  const knownPapers = new Map(data.candidate.notes.map(note => [note.path, sha(note.content)]));
  const derivation = original.candidate_source_bindings?.derivation;
  const paperHashes = candidate => new Map(applyReadingFirstSourceDerivation({
    ...data, candidate: applyReadingFirstUserCorrections(candidate, original.user_corrections),
  }, derivation).notes.map(note => [note.path, sha(note.content)]));
  const publicationBefore = paperHashes(data.candidate);
  const publicationAfter = record ? paperHashes(record.candidate) : publicationBefore;
  const knownNodes = new Map((data.candidate.supportNotes ?? []).map(note => [note.path, sha(note.content)]));
  const rebaseNode = (nodes, path) => nodes?.find(row => row.path === path);
  const changes = [];
  for (const path of new Set([...old.keys(), ...next.keys()])) {
    const before = old.get(path), after = next.get(path);
    if (before?.byte_sha256 === after?.byte_sha256 && before?.before_sha256 === after?.before_sha256 && before?.kind === after?.kind) continue;
    const kind = after?.kind ?? before.kind;
    const change = { path, kind, old_sha256: before?.byte_sha256 ?? null, new_sha256: after?.byte_sha256 ?? null,
      old_preimage_sha256: before?.before_sha256 ?? null, new_preimage_sha256: after?.before_sha256 ?? null };
    changes.push(change);
    const node = rebaseNode(record?.nodes, path);
    const priorNode = rebaseNode(originalRecord?.nodes, path);
    const removedNode = before?.kind === 'support' && !after && (record?.nodes.some(row => (row.previous_path ?? row.path)
      === (priorNode?.previous_path ?? path) && row.path !== path) || priorNode?.previous_path && next.get(priorNode.previous_path)?.kind === 'support')
      && (priorNode?.output_sha256 ?? knownNodes.get(path)) === (original.knowledge_render_hashes?.[path] ?? before.byte_sha256);
    const addedNode = !before && after?.kind === 'support' && (node?.previous_path
      ? [...old.values()].some(row => row.kind === 'support' && (rebaseNode(originalRecord?.nodes, row.path)?.previous_path ?? row.path) === node.previous_path)
      : originalRecord?.nodes.some(row => row.previous_path === path && row.path !== path && old.get(row.path)?.kind === 'support'));
    const currentNode = node?.base_sha256 === after?.before_sha256
      && node?.output_sha256 === (derived.knowledge_render_hashes?.[path] ?? after?.byte_sha256);
    const originalBase = data.recipe.rendering?.knowledgeRegistry?.find(row => row.path === path || row.canonical_path === path);
    const returnedToOriginal = !node && (addedNode || priorNode)
      && (originalBase?.content_sha256 ?? null) === after?.before_sha256
      && knownNodes.get(path) === (derived.knowledge_render_hashes?.[path] ?? after?.byte_sha256);
    const shared = removedNode || ((before?.kind === 'support' && after?.kind === 'support') || addedNode)
      && (currentNode || returnedToOriginal);
    const paperBefore = originalRecord?.papers?.find(row => row.path === path);
    const paperAfter = record?.papers?.find(row => row.path === path);
    const originalNote = knownPapers.get(path);
    const linkOnly = before?.kind === 'paper' && after?.kind === 'paper' && (paperBefore || paperAfter)
      && before.before_sha256 === after.before_sha256
      && before.byte_sha256 === (paperBefore?.publication_sha256 ?? publicationBefore.get(path))
      && after.byte_sha256 === publicationAfter.get(path)
      && (!paperBefore || paperBefore.before_sha256 === originalNote)
      && (!paperAfter || paperAfter.before_sha256 === originalNote
        && paperAfter.after_sha256 === sha(record.candidate.notes.find(note => note.path === path).content));
    const registration = (generationKinds.has(kind) || kind === 'reader-presentation')
      && (!before || before.kind === kind) && (!after || after.kind === kind);
    if (!shared && !linkOnly && !registration) fail('RF_ONE_STEP_REBASE_SCOPE', { ...change, changes });
  }
  return changes;
}

const sourceStamp = data => ({ recipe_fingerprint: data.recipe.recipe_fingerprint,
  candidate_fingerprint: data.candidate.presentation_fingerprint, reading_review_fingerprint: data.reading_review_fingerprint });
const rebaseProof = (record, summary) => record ? { nodes: record.nodes, rebase_fingerprint: record.rebase_fingerprint,
  ...(record.review_required ? { review_required: true } : {}),
  papers: (record.papers ?? []).map(row => ({ ...row,
    publication_sha256: summary.files.find(file => file.kind === 'paper' && file.path === row.path)?.byte_sha256 })) } : null;

async function prepareCandidate({ source, initial, request, directory }) {
  const generationBefore = (await readRegisteredCommit({ vaultRoot: request.vaultRoot })).generation_id ?? null;
  const rebase = initial.recipe.rendering
    ? await deriveRebasedReadingFirstPublicationSource({ source, vaultRoot: request.vaultRoot, publicationDirectory: directory })
    : { status: 'not_needed' };
  const selected = rebase.source ?? source;
  const data = selected === source ? initial : await inspectReadingFirstPublicationSource(selected);
  const prepared = await prepareReadingFirstPublication({ ...request, source: selected });
  const observed = Object.hasOwn(rebase, 'base_generation_id') ? rebase.base_generation_id : generationBefore;
  if (!rebase.record && observed !== prepared.plan.previous_generation) {
    fail('RF_PUBLICATION_KNOWLEDGE_CHANGED_SINCE_RENDER', { expected_generation: observed,
      observed_generation: prepared.plan.previous_generation, action: 'refresh_candidate' });
  }
  checkScope(prepared.plan, data);
  return { prepared, rebase, selected,
    summary: summarizeReadingFirstPublication(prepared.plan, prepared.publication_sources, prepared.review) };
}

/** Read-only formal-vault preparation for an exact queue proposal. */
export async function inspectReadingFirstQueueCandidate({ source, vaultRoot, ...options }) {
  const initial = await inspectReadingFirstPublicationSource(source);
  if (initial.recipe.knowledge_rebase) fail('RF_REBASE_ORIGINAL_SOURCE_REQUIRED');
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'apa-queue-preview-'));
  try {
    // Pass the result back as evidence, while retaining no temporary candidate or live token.
    const plan = await prepareCandidate({ source, initial, request: { vaultRoot, ...options }, directory });
    return { paper_id: initial.identity.paper_id, summary: plan.summary,
      original_source: sourceStamp(initial), rebase_proof: rebaseProof(plan.rebase.record, plan.summary) };
  } finally {
    for (const name of await readdir(directory)) {
      if (!/^rebase-\d+\.(?:json|diff\.md)$/.test(name)) fail('RF_ONE_STEP_PREVIEW_PATH_INVALID');
      await unlink(join(directory, name));
    }
    await rmdir(directory);
  }
}

async function bindApproval({ root, evidenceMode, summary, attempt, authorization, originalSource, rebase, original, changes, queueApproval }) {
  const prefix = original ? 'DERIVED-' : '';
  const inventoryPath = join(attempt, prefix + 'INVENTORY.json');
  const inventoryBytes = json(summary);
  await writeFile(inventoryPath, inventoryBytes, { flag: 'wx' });
  const binding = { schema_version: 'phase22-publication-approval-1.0', authority: evidenceMode === 'actual' ? 'user' : 'synthetic-fixture',
    authorization_id: authorization.authorization_id, user_reply: authorization.user_reply, vault_root: root,
    run_id: summary.run_id, analysis_revision: summary.analysis_revision, evidence_mode: evidenceMode,
    scope: evidenceMode === 'actual' ? 'production' : 'temporary-fixture', allowed_actions: ['apply', 'recover'],
    ...summary.hashes, inventory_path: inventoryPath, inventory_sha256: sha(inventoryBytes),
    inventory_paths: summary.files.map(row => row.path), original_source: originalSource,
    ...(queueApproval ? { queue_approval: queueApproval } : {}),
    ...(rebase ? { rebase_record_path: rebase.record_path, rebase_diff_path: rebase.diff_path,
      ...(rebase.record ? { rebase_fingerprint: rebase.record.rebase_fingerprint } : {}) } : {}),
    ...(original ? { original_approval_path: original.path, original_approval_sha256: sha(original.bytes),
      original_hashes: original.summary.hashes, new_hashes: summary.hashes, changes } : {}) };
  const path = join(attempt, prefix + 'APPROVAL.json');
  const bytes = json(binding);
  await writeFile(path, bytes, { flag: 'wx' });
  return { path, bytes, binding, summary };
}

function maintenanceWindow(binding) {
  const now = Date.now();
  return { schema_version: 'phase22-maintenance-window-1.0', authorization_id: binding.authorization_id,
    vault_root: binding.vault_root, run_id: binding.run_id, analysis_revision: binding.analysis_revision, scope: binding.scope,
    starts_at: new Date(now).toISOString(), ends_at: new Date(now + 15 * 60_000).toISOString(), external_readers_acknowledged: true };
}

async function transactionAuthority(approval, attempt) {
  const { binding } = approval;
  const window = json(maintenanceWindow(binding));
  const path = join(attempt, 'MAINTENANCE-WINDOW.json');
  await writeFile(path, window, { flag: 'wx' });
  const broker = createOwnedArtifactBroker({ control_actor_id: 'reading-first-publication-controller',
    artifact_root: attempt, authorized_bindings: [], run_controls: [{ run_id: binding.run_id, phase22_publication_binding: { ...binding,
      approval_record: { path: approval.path, sha256: sha(approval.bytes) }, maintenance_window_record: { path, sha256: sha(window) } } }] });
  return { control: { dispatchContext: broker.dispatchContext, runId: binding.run_id }, approvalRecord: approval.path,
    maintenanceWindowRecord: path, expectedReviewSha256: binding.review_hash, expectedOutputSha256: binding.output_inventory_hash };
}

async function renewRecoveryWindow({ authority, transaction_id: transactionId }) {
  const folder = dirname(authority.maintenance_window_record.path);
  const path = join(folder, 'RECOVERY-WINDOW-' + randomUUID() + '.json');
  const bytes = json({ ...maintenanceWindow(authority), recovery: { action: 'recover', transaction_id: transactionId,
    original_window: authority.maintenance_window_record } });
  await writeFile(path, bytes, { flag: 'wx' });
  const broker = createOwnedArtifactBroker({ control_actor_id: 'reading-first-publication-controller', artifact_root: folder,
    authorized_bindings: [], run_controls: [{ run_id: authority.run_id, phase22_publication_binding: { ...authority,
      maintenance_window_record: { path, sha256: sha(bytes) } } }] });
  return { recoveryWindowControl: { dispatchContext: broker.dispatchContext, runId: authority.run_id }, recoveryWindowRecord: path };
}

async function verifyCommit(plan, transaction) {
  const current = await readRegisteredCommit({ vaultRoot: plan.vault_root });
  if (!current.ok || current.generation_id !== transaction.generation) fail('RF_ONE_STEP_COMMIT_VERIFICATION', { expected: transaction.generation });
  const verified = [];
  for (const row of plan.inventory) {
    const bytes = await readFile(join(plan.vault_root, row.path));
    if (sha(bytes) !== row.byte_sha256 || bytes.length !== row.byte_length) fail('RF_ONE_STEP_OUTPUT_VERIFICATION', { path: row.path });
    verified.push({ path: row.path, sha256: row.byte_sha256, byte_length: row.byte_length });
  }
  return verified;
}

function evidencePaths(folder) {
  return { verification_path: join(folder, 'VERIFICATION.json'), result_path: join(folder, 'RESULT.md') };
}

async function optionalEvidence(path) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || await realpath(path) !== path) fail('RF_ONE_STEP_EVIDENCE_PATH_INVALID', { path });
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function finishRuntimeCleanup({ execution, transaction, consumerHeld }) {
  if (!execution) return {};
  try {
    const options = { ...execution, consumerHeld, publication: { transaction_id: transaction.transaction_id, generation: transaction.generation } };
    const cleanup = execution.terminal ? await cleanupReadingRuntimeRun(options) : await cleanupPublishedReadingRuntime(options);
    return cleanup.status === 'unregistered-runtime' ? {} : { runtime_cleanup: cleanup };
  } catch (error) {
    return { runtime_cleanup: { status: 'retryable', code: error.code ?? error.message,
      ...(error.details ? { details: error.details } : {}) } };
  }
}

async function finishReadingFirstPublication({ folder, transaction, receipt, verified, execution, consumerHeld = false, existingVerification }) {
  const result = { ...transaction, ...receipt };
  const paths = evidencePaths(folder);
  if (!existingVerification) {
    await writeJson(paths.verification_path, { ...result, status: 'passed', verified_files: verified, native_obsidian: 'not_run' });
  }
  const lines = ['**发布结果**', '', '已提交代次 ' + transaction.generation + '，事务 ' + transaction.transaction_id + '。',
    '', '已核验 ' + verified.length + ' 个正式文件及当前提交登记。', '', '[核验结果](VERIFICATION.json)'];
  if (receipt.rebase_record_path) {
    const subfolder = receipt.rebase_record_path.slice(folder.length + 1).replaceAll('\\', '/');
    const diff = receipt.rebase_diff_path.slice(folder.length + 1).replaceAll('\\', '/');
    lines.push('', '[变基记录](' + subfolder + ')与[差异](' + diff + ')。');
    if (receipt.changes?.length) {
      lines.push('', '| 文件 | 原 SHA-256 | 新 SHA-256 |', '| --- | --- | --- |',
        ...receipt.changes.map(row => '| ' + row.path + ' | ' + (row.old_sha256 ?? '无') + ' | ' + (row.new_sha256 ?? '无') + ' |'));
    }
  }
  if (receipt.knowledge_merge_drafts?.path) {
    const drafts = receipt.knowledge_merge_drafts;
    const relative = drafts.path.slice(folder.length + 1).replaceAll('\\', '/');
    lines.push('', '**待判断的共享节点**', '', '[候选定义对照](' + relative + ')共 ' + drafts.count + ' 对，等待主会话给出建议。');
  }
  const supplements = result.publication_sources?.raw_supplements ?? [];
  if (supplements.length) {
    lines.push('', '**本次写入 Raw 的补缺文献**', '', ...supplements.flatMap(row => [
      '- ' + row.path + ' · ' + row.title + ' · DOI ' + (row.doi ?? '未登记'),
      '  追溯原因　' + row.trace_reason,
      '  引用笔记　' + row.notes.join('、'),
    ]));
  }
  await writeFile(paths.result_path, lines.join('\n') + '\n', { flag: 'wx' });
  return { ...result, ...paths, ...await finishRuntimeCleanup({ execution, transaction, consumerHeld }) };
}

/** Recover only the already registered transaction, before accessing a possibly reclaimed session. */
export async function recoverRegisteredReadingFirstPublication({ vaultRoot, run, attempt, readExecution }) {
  if (!identifier(run) || attempt.registration.run !== run || attempt.summary.run_id !== run
    || !same(hashesOf(attempt.registration), attempt.summary.hashes)) fail('RF_ONE_STEP_RECOVERY_BINDING_MISMATCH');
  const root = await realpath(vaultRoot), folder = await publicationDirectory(root, run);
  const paths = evidencePaths(folder);
  const savedVerification = await optionalEvidence(paths.verification_path);
  const savedResult = await optionalEvidence(paths.result_path);
  const { registration, receipt, summary } = attempt;
  const expected = summary.files.map(row => ({ path: row.path, sha256: row.byte_sha256, byte_length: row.byte_length }));
  const options = { vaultRoot: root, run, transactionId: registration.transaction_id,
    trustAnchor: registration.trust_anchor, approvalRecord: receipt.approval_record, maintenanceWindowRecord: receipt.maintenance_window_record };
  const inspected = await inspectBilingualPublicationRecovery({ ...options, requireJournal: !!(savedVerification || savedResult) });
  if (inspected.generation !== summary.generation || !same(hashesOf(inspected), summary.hashes)) fail('RF_ONE_STEP_RECOVERY_BINDING_MISMATCH');
  let transaction;
  if (savedVerification) {
    const { status, verified_files, native_obsidian, ...verified } = JSON.parse(savedVerification);
    const current = await readRegisteredCommit({ vaultRoot: root });
    if (status !== 'passed' || inspected.status !== 'committed'
      || verified.transaction_id !== registration.transaction_id || verified.generation !== summary.generation
      || !same(verified.hashes, summary.hashes) || !same(verified_files, expected)
      || !current.ok || !current.generation.papers.some(paper => paper.run_id === run)) fail('RF_ONE_STEP_RECOVERY_BINDING_MISMATCH');
    transaction = { ...verified, status: 'committed' };
  } else if (savedResult) fail('RF_ONE_STEP_RECOVERY_BINDING_MISMATCH');
  if (!transaction) {
    const renewed = inspected.maintenance_window_current ? null : await renewRecoveryWindow(inspected);
    transaction = await recoverBilingualPublication({ ...options, ...renewed });
    if (renewed) transaction = { ...transaction, recovery_window_record: renewed.recoveryWindowRecord };
  }
  if (transaction.status !== 'committed') return transaction;
  let execution, cleanupError;
  try { execution = await readExecution?.(); }
  catch (error) { cleanupError = { runtime_cleanup: { status: 'retryable', code: error.code ?? error.message } }; }
  const result = savedResult ? { ...transaction, ...paths, ...await finishRuntimeCleanup({ execution, transaction }) }
    : await finishReadingFirstPublication({ folder, transaction, receipt, execution, existingVerification: savedVerification,
      verified: savedVerification ? expected : await verifyCommit({ vault_root: root, inventory: summary.files }, transaction) });
  return { ...result, ...cleanupError };
}

/** Publish a single owned, reviewed candidate with explicit user authority. */
export async function publishReadingFirstCandidate({ source, vaultRoot, generation, resources, authorization,
  onPrepared, onRegistered, queuedApproval, evidenceMode = 'actual', presentationAssetRegistrations, user_corrections, run: expectedRun } = {}) {
  if (typeof authorization?.authorization_id !== 'string' || !authorization.authorization_id.trim()
    || typeof authorization.user_reply !== 'string' || !/^(?:请|确认|同意)?(?:全部)?发布[。！!]?$/u.test(authorization.user_reply.trim())) {
    fail('RF_ONE_STEP_APPROVAL_REQUIRED');
  }
  if (typeof onPrepared !== 'function') fail('RF_ONE_STEP_SUMMARY_REQUIRED');
  const root = await realpath(vaultRoot);
  await assertReadingFirstRegisteredSourcesCurrent({ vaultRoot: root });
  const initial = await inspectReadingFirstPublicationSource(source);
  const run = initial.identity.run_id;
  if (!identifier(run) || expectedRun !== undefined && expectedRun !== run) fail('RF_ONE_STEP_RUN_MISMATCH');
  const boundRoot = initial.recipe.binding?.configured_setup?.knowledge_registry?.vault_root;
  if (boundRoot && await realpath(boundRoot) !== root) fail('RF_ONE_STEP_VAULT_MISMATCH');
  if (initial.recipe.knowledge_rebase) fail('RF_REBASE_ORIGINAL_SOURCE_REQUIRED');
  const execution = { repoRoot: root, runId: run, runRoot: initial.recipe.artifact_root,
    manifest: initial.recipe.execution_runtime ?? initial.recipe.binding?.configured_setup?.runtime_binding };
  return withReadingRuntimePublicationConsumer(execution, () => publishBoundReadingFirstCandidate({ source, root, run, initial,
    execution, generation, resources, authorization, onPrepared, onRegistered, queuedApproval, evidenceMode, presentationAssetRegistrations, user_corrections }));
}

async function publishBoundReadingFirstCandidate({ source, root, run, initial, execution, generation, resources,
  authorization, onPrepared, onRegistered, queuedApproval, evidenceMode, presentationAssetRegistrations, user_corrections }) {
  const folder = await publicationDirectory(root, run), attempt = await mkdtemp(join(folder, 'attempt-'));
  const originalSource = sourceStamp(initial);
  const request = { vaultRoot: root, generation, resources, evidenceMode, presentationAssetRegistrations, user_corrections };
  let initialApproval, approval, rebase, summary, registration, transaction, changes, authority, selected, mergeDrafts;
  let displayed = 0;
  let applying = false;
  const reprepare = async () => {
    const plan = await prepareCandidate({ source, initial, request, directory: attempt });
    rebase = plan.rebase;
    summary = plan.summary;
    selected = plan.selected;
    return plan.prepared;
  };
  const display = async (extra = {}) => {
    displayed++;
    mergeDrafts = undefined;
    let pairs;
    try { pairs = await inspectReadingFirstKnowledgeMergeCandidates({ source: selected, vaultRoot: root }); }
    catch (error) { mergeDrafts = { status: 'retryable', code: error.code ?? error.message }; }
    const ambiguityPairs = rebase.record?.identity_ambiguities?.flatMap(row => row.draft_pairs) ?? [];
    const drafts = [...new Map([...ambiguityPairs, ...(pairs ?? [])].map(pair =>
      [JSON.stringify([pair.candidate_path, pair.registered_path]), pair])).values()];
    if (drafts.length) {
      const path = join(attempt, 'KNOWLEDGE-MERGE-DRAFTS' + (displayed === 1 ? '' : '-' + displayed) + '.json');
      const bytes = json({ schema_version: 'reading-first-knowledge-merge-drafts-1.0', run_id: run,
        status: 'awaiting_judgment', model_calls: 0, pairs: drafts });
      await writeFile(path, bytes, { flag: 'wx' });
      mergeDrafts = { status: 'awaiting_judgment', path, count: drafts.length, sha256: sha(bytes) };
    }
    await onPrepared(structuredClone({ ...summary, ...extra, ...(mergeDrafts ? { knowledge_merge_drafts: mergeDrafts } : {}) }));
  };
  const requireIdentityApproval = async () => {
    if (rebase.record?.review_required && (!queuedApproval || !same(queuedApproval.original.summary.hashes, summary.hashes))) {
      await display({ requires_reapproval: true });
      fail('RF_ONE_STEP_IDENTITY_REAPPROVAL_REQUIRED', { proposed_hashes: summary.hashes });
    }
  };
  try {
    await requireUnusedResult(folder);
    if (queuedApproval && (!same(queuedApproval.original.original_source, originalSource)
      || queuedApproval.original.summary.run_id !== run)) fail('RF_ONE_STEP_QUEUE_REVIEW_CHANGED', { run });
    let prepared;
    try { prepared = await reprepare(); }
    catch (error) {
      if (!driftCodes.has(error.code)) throw error;
      prepared = await reprepare();
    }
    const approvalBase = { root, evidenceMode, attempt, authorization, originalSource, queueApproval: queuedApproval?.binding };
    if (queuedApproval) {
      initialApproval = await bindApproval({ ...approvalBase, summary: queuedApproval.original.summary });
      await requireIdentityApproval();
    } else {
      await requireIdentityApproval();
      await display();
      initialApproval = await bindApproval({ ...approvalBase, summary, rebase: rebase.record ? rebase : undefined });
    }
    approval = initialApproval;
    const assess = () => {
      const original = initialApproval.summary;
      if (!same(original.hashes, summary.hashes)) {
        return comparePlans(original, summary, rebase.record, queuedApproval?.original.rebase_proof ?? firstRebase, initial);
      }
      if (!same(original.files, summary.files) || !same(original.candidate_source_bindings, summary.candidate_source_bindings)
        || !same(original.user_corrections, summary.user_corrections)) {
        fail('RF_ONE_STEP_QUEUE_INVENTORY_CHANGED');
      }
      return null;
    };
    const firstRebase = queuedApproval ? null : rebaseProof(rebase.record, summary);
    if (queuedApproval) {
      changes = assess();
      await display(changes ? { derived: true, changes } : {});
    }
    const dryRun = async () => {
      await assertReadingFirstPublicationSourceChoicesCurrent(prepared.review);
      return dryRunBilingualPublication({ vaultRoot: root, run, plan: prepared.plan });
    };
    try { await dryRun(); }
    catch (error) {
      if (!driftCodes.has(error.code)) throw error;
      prepared = await reprepare();
      await requireIdentityApproval();
      changes = assess();
      if (changes) await display({ derived: true, changes });
      await dryRun();
    }
    if (changes) {
      if (!rebase.record) {
        const record_path = join(attempt, 'GENERATION-REBASE.json'), diff_path = join(attempt, 'GENERATION-DIFF.json');
        await writeJson(record_path, { original_source: originalSource, previous_generation: initialApproval.summary.previous_generation,
          current_generation: summary.previous_generation, original_hashes: initialApproval.summary.hashes, new_hashes: summary.hashes });
        await writeJson(diff_path, changes);
        rebase = { ...rebase, record_path, diff_path };
      }
      approval = await bindApproval({ ...approvalBase, summary, rebase,
        original: initialApproval, changes });
    }
    authority = await transactionAuthority(approval, attempt);
    const options = { vaultRoot: root, run, plan: prepared.plan, ...authority };
    registration = await registerBilingualPublication({ ...options, sourceInputs: prepared.sourceInputs });
    await writeJson(join(attempt, 'REGISTRATION.json'), registration);
    const affected = changes ?? rebase?.record?.nodes.map(node => {
      const previous = initial.candidate.supportNotes.find(note => note.path === (node.previous_path ?? node.path));
      return { path: node.path, kind: 'support', old_sha256: previous ? sha(previous.content) : null,
        new_sha256: node.output_sha256, old_preimage_sha256: node.render_sha256, new_preimage_sha256: node.base_sha256 };
    }) ?? [];
    const receipt = { original_approval_record: initialApproval.path, approval_record: approval.path,
      maintenance_window_record: authority.maintenanceWindowRecord, inventory_path: approval.binding.inventory_path,
      hashes: summary.hashes, ...(summary.publication_sources ? { publication_sources: summary.publication_sources } : {}),
      ...(mergeDrafts ? { knowledge_merge_drafts: mergeDrafts } : {}),
      ...(rebase?.record_path ? { rebase_record_path: rebase.record_path, rebase_diff_path: rebase.diff_path, changes: affected } : {}) };
    await onRegistered?.(structuredClone({ registration, receipt, summary }));
    applying = true;
    transaction = await applyBilingualPublication({ ...options, transactionId: registration.transaction_id });
    if (transaction.status !== 'committed') fail('RF_ONE_STEP_TRANSACTION_INCOMPLETE', { status: transaction.status });
    const verified = await verifyCommit(prepared.plan, transaction);
    return await finishReadingFirstPublication({ folder, transaction, receipt, verified, execution, consumerHeld: true });
  } catch (error) {
    const reviewPath = join(attempt, 'REVIEW.json');
    const result = { ok: false, status: transaction?.status === 'committed' ? 'committed_verification_failed'
      : applying || registration ? 'transaction_failed'
        : initialApproval || queuedApproval || error.code === 'RF_ONE_STEP_IDENTITY_REAPPROVAL_REQUIRED' ? 'awaiting_reapproval' : 'refused',
      error: { code: error.code ?? error.message, ...(error.details ? { details: error.details } : {}) },
      ...(error.recovery ? { recovery: error.recovery } : {}),
      ...(applying ? {} : { business_writes: 0 }), ...(registration ? { registration } : {}), ...(transaction ? { transaction } : {}),
      ...(initialApproval ? { original_approval_record: initialApproval.path } : {}), ...(summary ? { summary } : {}),
      ...(mergeDrafts ? { knowledge_merge_drafts: mergeDrafts } : {}),
      ...(rebase?.record_path ? { rebase_record_path: rebase.record_path, rebase_diff_path: rebase.diff_path } : {}), review_path: reviewPath };
    await writeJson(reviewPath, result);
    return result;
  }
}
