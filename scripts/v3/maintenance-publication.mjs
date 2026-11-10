import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { createOwnedArtifactBroker } from './owned-artifact-store.mjs';
import { readRegisteredCommit } from './phase22-active-version.mjs';
import { applyBilingualPublication, dryRunBilingualPublication, inspectBilingualPublicationRecovery,
  prepareBilingualPublicationTrustAnchor, registerBilingualPublication } from './phase22-publication.mjs';
import { buildNoteRelocationReview } from './note-relocation.mjs';
import { buildKnowledgeMergeReview, buildKnowledgeMergeCompensationReview } from './knowledge-merge.mjs';
import { buildMapRefreshReview } from './research-map-refresh.mjs';

const profile = 'phase22-maintenance-publication-1.0';
const optionsSchema = 'phase22-maintenance-options-1.0';
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const fail = (code, details) => { throw Object.assign(new Error(code), { code, details }); };
const isText = value => typeof value === 'string' && /\S/.test(value);
const identifier = value => isText(value) && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value);
const fingerprint = value => isText(value) && /^sha256:[a-f0-9]{64}$/.test(value);
const bytesLength = value => Number.isSafeInteger(value) && value > 0;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function keys(value, allowed, field) {
  if (!isObject(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('P22_MAINTENANCE_OPTIONS_INVALID', { field });
}
function list(value, check, field) {
  if (!Array.isArray(value) || !value.every(check)) fail('P22_MAINTENANCE_OPTIONS_INVALID', { field });
}
function checkOptions(mode, options) {
  if (mode === 'relocate') {
    keys(options, ['generation', 'papers', 'assetMappings', 'assetRetirements', 'restoreAssetRetirements'], mode);
    list(options.papers ?? [], row => {
      keys(row, ['paperId', 'sourceLanguage'], 'papers');
      return identifier(row.paperId) && ['en', 'zh-CN'].includes(row.sourceLanguage);
    }, 'papers');
    list(options.assetMappings ?? [], row => {
      keys(row, ['old_path', 'new_path', 'sha256', 'byte_length', 'source_id'], 'assetMappings');
      return isText(row.old_path) && isText(row.new_path) && fingerprint(row.sha256) && bytesLength(row.byte_length)
        && (!Object.hasOwn(row, 'source_id') || isText(row.source_id));
    }, 'assetMappings');
    list(options.assetRetirements ?? [], row => {
      keys(row, ['path', 'sha256', 'byte_length'], 'assetRetirements');
      return isText(row.path) && fingerprint(row.sha256) && bytesLength(row.byte_length);
    }, 'assetRetirements');
    list(options.restoreAssetRetirements ?? [], isText, 'restoreAssetRetirements');
  } else if (mode === 'map-refresh') {
    keys(options, ['generation', 'papers'], mode);
    list(options.papers, row => {
      keys(row, ['paperId', 'map', 'argument', 'primaryFindingIds', 'sectionTitles', 'noteWordingEdits', 'canvasLayout'], 'papers');
      if (Object.hasOwn(row, 'canvasLayout')) {
        keys(row, ['paperId', 'canvasLayout'], 'papers');
        keys(row.canvasLayout, ['language', 'before_sha256', 'nodes'], 'canvasLayout');
        list(row.canvasLayout.nodes, node => {
          keys(node, ['id', 'x', 'y', 'width', 'height'], 'canvasLayout.nodes');
          return isText(node.id) && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(node[key]))
            && node.width > 0 && node.height > 0;
        }, 'canvasLayout.nodes');
        return identifier(row.paperId) && ['en', 'zh-CN'].includes(row.canvasLayout.language)
          && fingerprint(row.canvasLayout.before_sha256) && row.canvasLayout.nodes.length > 0;
      }
      keys(row.sectionTitles, ['en', 'zh-CN'], 'sectionTitles');
      return identifier(row.paperId) && isObject(row.argument) && isObject(row.map)
        && ['steps', 'findings', 'relations'].every(key => Array.isArray(row.map[key]) && row.map[key].every(isObject))
        && Array.isArray(row.primaryFindingIds) && row.primaryFindingIds.every(isText)
        && ['en', 'zh-CN'].every(language => isObject(row.sectionTitles[language])
          && Object.values(row.sectionTitles[language]).every(isText));
    }, 'papers');
    if (!options.papers.length) fail('P22_MAINTENANCE_OPTIONS_INVALID', { field: 'papers' });
  } else if (mode === 'merge') {
    keys(options, ['generation', 'merges'], mode);
    list(options.merges, row => {
      keys(row, ['keep_path', 'remove_paths', 'aliases', 'anchors', 'expected_inputs'], 'merges');
      list(row.remove_paths, isText, 'remove_paths');
      list(row.aliases ?? [], isText, 'aliases');
      list(row.expected_inputs ?? [], input => {
        keys(input, ['path', 'sha256', 'byte_length'], 'expected_inputs');
        return isText(input.path) && fingerprint(input.sha256) && bytesLength(input.byte_length);
      }, 'expected_inputs');
      const anchors = row.anchors ?? {};
      keys(anchors, row.remove_paths, 'anchors');
      return isText(row.keep_path) && Object.values(anchors).every(map => isObject(map)
        && Object.entries(map).every(([from, to]) => isText(from) && isText(to)));
    }, 'merges');
  } else if (mode === 'compensate') {
    keys(options, ['generation', 'transactionId', 'trustAnchor'], mode);
    if (!identifier(options.transactionId)) fail('P22_MAINTENANCE_OPTIONS_INVALID', { field: 'transactionId' });
    if (Object.hasOwn(options, 'trustAnchor')) {
      keys(options.trustAnchor, ['schema_version', 'vault_root', 'run_id', 'public_key'], 'trustAnchor');
      if (options.trustAnchor.schema_version !== 'phase22-controller-trust-1.0' || !isText(options.trustAnchor.vault_root)
        || !identifier(options.trustAnchor.run_id) || !isText(options.trustAnchor.public_key)) fail('P22_MAINTENANCE_OPTIONS_INVALID', { field: 'trustAnchor' });
    }
  } else fail('P22_MAINTENANCE_MODE_INVALID', { mode });
  if (Object.hasOwn(options, 'generation') && !identifier(options.generation)) fail('P22_MAINTENANCE_OPTIONS_INVALID', { field: 'generation' });
  return options;
}

async function directory(root, run, { candidate = false, create = false } = {}) {
  if (!identifier(run) || !isText(root) || resolve(root) !== await realpath(root)) fail('P22_MAINTENANCE_SCOPE_INVALID', { run });
  let folder = resolve(root);
  const parts = ['Eval', 'apa-v3', 'runs', run, 'publication', ...(candidate ? ['candidate'] : [])];
  for (const part of parts) {
    folder = join(folder, part);
    if (create) {
      try { await mkdir(folder); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const entry = await lstat(folder);
    if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(folder) !== folder) fail('P22_MAINTENANCE_EVIDENCE_PATH_INVALID', { path: folder });
  }
  return folder;
}
async function readEvidence(path, { optional = false } = {}) {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || await realpath(path) !== path) fail('P22_MAINTENANCE_EVIDENCE_PATH_INVALID', { path });
    return await readFile(path);
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  }
}
function parseJson(bytes, path) {
  try { return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { fail('P22_MAINTENANCE_JSON_INVALID', { path }); }
}
const writeNew = (path, bytes) => writeFile(path, bytes, { flag: 'wx' });
async function requireMissing(path) {
  try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  fail('P22_MAINTENANCE_ATTEMPT_EXISTS', { path });
}
const registrationPath = (root, run) => join(root, '.apa-v3', 'phase22', 'runs', run, 'CURRENT.json');
async function saveResult(path, bytes) {
  try { await writeNew(path, bytes); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!(await readEvidence(path)).equals(Buffer.from(bytes))) fail('P22_MAINTENANCE_RESULT_MISMATCH', { path });
  }
}

async function build({ root, run, mode, options }) {
  const { generation = run, ...input } = checkOptions(mode, options);
  let review;
  if (mode === 'relocate') review = await buildNoteRelocationReview({ ...input, vaultRoot: root, runId: run, generation });
  else if (mode === 'map-refresh') review = await buildMapRefreshReview({ ...input, vaultRoot: root, runId: run, generation });
  else if (mode === 'merge') review = await buildKnowledgeMergeReview({ ...input, copyRegisteredContent: true, repoRoot: root, runId: run, generationId: generation });
  else review = await buildKnowledgeMergeCompensationReview({ ...input, repoRoot: root, runId: run, generationId: generation });
  const { plan } = await dryRunBilingualPublication({ vaultRoot: root, run, review });
  return { review, plan };
}
function inventory(plan, mode, recipeSha256) {
  const files = plan.inventory.map(({ path, kind, byte_sha256, byte_length, before_sha256, before_byte_length }) =>
    ({ path, kind, action: before_sha256 === null ? 'create' : 'overwrite', byte_sha256, byte_length, before_sha256, before_byte_length }));
  const counts = { create: files.filter(row => row.action === 'create').length, overwrite: files.filter(row => row.action === 'overwrite').length, delete: 0 };
  return { schema_version: profile, mode, vault_root: plan.vault_root, run_id: plan.run_id, analysis_revision: plan.analysis_revision,
    evidence_mode: plan.evidence_mode, generation: plan.generation, previous_generation: plan.previous_generation,
    options_sha256: recipeSha256, hashes: { review_hash: plan.hashes.review_hash, output_inventory_hash: plan.hashes.output_inventory_hash }, counts, files };
}
function displayInventory(summary, hash) {
  return ['**维护事务精确清单**', '', `模式 ${summary.mode}，运行 ${summary.run_id}，目标代次 ${summary.generation}。`,
    `新建 ${summary.counts.create} 项，覆盖 ${summary.counts.overwrite} 项，删除 ${summary.counts.delete} 项。`, '',
    '清单 SHA-256 `' + hash + '`', '审阅哈希 `' + summary.hashes.review_hash + '`', '输出哈希 `' + summary.hashes.output_inventory_hash + '`', '',
    ...summary.files.map(row => `- ${row.action} \`${row.path}\` · ${row.byte_length} B · \`${row.byte_sha256}\``), ''].join('\n');
}
async function checkUnused(folder) {
  for (const name of ['INTENT.json', 'APPROVAL.json', 'MAINTENANCE-WINDOW.json', 'RESULT.md', 'VERIFICATION.json']) {
    const path = join(folder, name), bytes = await readEvidence(path, { optional: true });
    if (bytes) fail('P22_MAINTENANCE_ATTEMPT_EXISTS', { path, ...(name === 'INTENT.json' ? parseJson(bytes, path) : {}) });
  }
}

export async function prepareMaintenanceReview({ vaultRoot, run, mode, optionsFile }) {
  if (!identifier(run)) fail('P22_MAINTENANCE_SCOPE_INVALID', { run });
  const root = resolve(vaultRoot);
  await requireMissing(join(root, 'Eval', 'apa-v3', 'runs', run));
  await requireMissing(registrationPath(root, run));
  const options = parseJson(await readFile(optionsFile), optionsFile);
  const { review, plan } = await build({ root, run, mode, options });
  const folder = await directory(root, run, { candidate: true, create: true });
  await checkUnused(join(folder, '..'));
  const recipe = json({ schema_version: optionsSchema, mode, options });
  const summary = inventory(plan, mode, sha(recipe)), bytes = json(summary), hash = sha(bytes);
  const inventoryPath = join(folder, 'INVENTORY.json'), reviewPath = join(folder, 'REVIEW.json'), displayPath = join(folder, 'INVENTORY.md');
  await writeNew(join(folder, 'OPTIONS.json'), recipe);
  await writeNew(reviewPath, json(review.reviewManifest));
  await writeNew(displayPath, displayInventory(summary, hash));
  await writeNew(inventoryPath, bytes);
  return { ok: true, status: 'review', run, mode, counts: summary.counts, targets: summary.files.map(row => row.path),
    hashes: summary.hashes, inventory_sha256: hash, inventory_path: inventoryPath, review_path: reviewPath, display_path: displayPath };
}

async function bindApproval(folder, summary, inventoryPath, inventorySha256, authorizationId, userReply) {
  const { vault_root, run_id, analysis_revision, evidence_mode } = summary;
  const synthetic = evidence_mode === 'synthetic';
  if (synthetic) {
    const rel = relative(await realpath(tmpdir()), vault_root);
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || resolve(await realpath(tmpdir()), rel) !== vault_root) fail('P22_SYNTHETIC_PUBLICATION_SCOPE');
  }
  const binding = { schema_version: 'phase22-publication-approval-1.0', authority: synthetic ? 'synthetic-fixture' : 'user',
    authorization_id: authorizationId, user_reply: userReply, vault_root, run_id, analysis_revision, evidence_mode,
    scope: synthetic ? 'temporary-fixture' : 'production', allowed_actions: ['apply', 'recover'], ...summary.hashes,
    inventory_path: inventoryPath, inventory_sha256: inventorySha256, inventory_paths: summary.files.map(row => row.path),
    original_source: { kind: profile, mode: summary.mode, options_sha256: summary.options_sha256 } };
  const approvalRecord = join(folder, 'APPROVAL.json'), approvalBytes = json(binding);
  const maintenanceWindowRecord = join(folder, 'MAINTENANCE-WINDOW.json'), now = Date.now();
  const window = json({ schema_version: 'phase22-maintenance-window-1.0', authorization_id: authorizationId,
    vault_root, run_id, analysis_revision, scope: binding.scope, starts_at: new Date(now).toISOString(),
    ends_at: new Date(now + 15 * 60_000).toISOString(), external_readers_acknowledged: true });
  await writeNew(approvalRecord, approvalBytes);
  await writeNew(maintenanceWindowRecord, window);
  const broker = createOwnedArtifactBroker({ control_actor_id: 'phase22-maintenance-controller', artifact_root: folder,
    authorized_bindings: [], run_controls: [{ run_id, phase22_publication_binding: { ...binding,
      approval_record: { path: approvalRecord, sha256: sha(approvalBytes) },
      maintenance_window_record: { path: maintenanceWindowRecord, sha256: sha(window) } } }] });
  return { control: { dispatchContext: broker.dispatchContext, runId: run_id }, approvalRecord, maintenanceWindowRecord,
    expectedReviewSha256: summary.hashes.review_hash, expectedOutputSha256: summary.hashes.output_inventory_hash };
}

async function verifyResult(folder, summary, transaction) {
  const committed = transaction.status === 'committed';
  if (!committed && transaction.status !== 'rolled_back') return transaction;
  const verified = [], current = await readRegisteredCommit({ vaultRoot: summary.vault_root });
  if (!current.ok || current.generation_id !== (committed ? summary.generation : summary.previous_generation)) {
    fail('P22_MAINTENANCE_COMMIT_VERIFICATION', { transaction_id: transaction.transaction_id, generation: current.generation_id,
      ...(current.errors ? { errors: current.errors } : {}) });
  }
  for (const row of summary.files) {
    const sha256 = committed ? row.byte_sha256 : row.before_sha256, byte_length = committed ? row.byte_length : row.before_byte_length;
    const bytes = await readEvidence(join(summary.vault_root, row.path), { optional: !sha256 });
    if (sha256 ? !bytes || sha(bytes) !== sha256 || bytes.length !== byte_length : bytes !== null) {
      fail('P22_MAINTENANCE_OUTPUT_VERIFICATION', { path: row.path, transaction_id: transaction.transaction_id });
    }
    verified.push({ path: row.path, sha256, byte_length });
  }
  const resultPath = join(folder, 'RESULT.md'), verificationPath = join(folder, 'VERIFICATION.json');
  await saveResult(verificationPath, json({ status: committed ? 'passed' : 'rolled_back', transaction_id: transaction.transaction_id,
    journal_path: transaction.journal_path, generation: current.generation_id, hashes: summary.hashes, verified_files: verified, native_obsidian: 'not_run' }));
  await saveResult(resultPath, ['**维护事务结果**', '', `事务 \`${transaction.transaction_id}\` ${committed ? '已提交' : '已回滚'}。`,
    `当前代次 \`${current.generation_id}\`。已核对 ${verified.length} 项${committed ? '输出' : '前像'}。`,
    '批准、维护窗口和文件核验分别保存在 [APPROVAL.json](APPROVAL.json)、[MAINTENANCE-WINDOW.json](MAINTENANCE-WINDOW.json) 和 [VERIFICATION.json](VERIFICATION.json)。', ''].join('\n'));
  return { ...transaction, result_path: resultPath, verification_path: verificationPath };
}

/** A single-line reply that starts with an approval word, such as “批准按该清单恢复布局”; questions are not approvals. */
export function isMaintenanceApprovalReply(value) {
  if (!isText(value)) return false;
  const reply = value.trim();
  return /^(?:我)?(?:批准|确认|同意)[^\r\n]*$/u.test(reply) && !/(?:[?？]|吗)[。！!]?$/u.test(reply);
}

export async function applyMaintenanceReview({ vaultRoot, run, inventorySha256, authorizationId, userReply, onRegistered, onPromotionBoundary }) {
  if (!isText(authorizationId) || !isMaintenanceApprovalReply(userReply)) fail('P22_MAINTENANCE_APPROVAL_REQUIRED');
  if (!fingerprint(inventorySha256)) fail('P22_MAINTENANCE_INVENTORY_MISMATCH');
  const root = resolve(vaultRoot), folder = await directory(root, run), candidate = await directory(root, run, { candidate: true });
  await checkUnused(folder);
  await requireMissing(registrationPath(root, run));
  const candidatePath = join(candidate, 'INVENTORY.json'), approvedBytes = await readEvidence(candidatePath);
  if (sha(approvedBytes) !== inventorySha256) fail('P22_MAINTENANCE_INVENTORY_MISMATCH');
  const recipePath = join(candidate, 'OPTIONS.json'), recipe = await readEvidence(recipePath);
  const { mode, options, schema_version } = parseJson(recipe, recipePath);
  if (schema_version !== optionsSchema) fail('P22_MAINTENANCE_OPTIONS_INVALID');
  const approved = parseJson(approvedBytes, candidatePath);
  if (approved.options_sha256 !== sha(recipe)) fail('P22_MAINTENANCE_INVENTORY_MISMATCH');
  const { review, plan } = await build({ root, run, mode, options });
  const summary = inventory(plan, mode, sha(recipe));
  if (!approvedBytes.equals(json(summary)) || !(await readEvidence(join(candidate, 'REVIEW.json'))).equals(json(review.reviewManifest))) {
    fail('P22_MAINTENANCE_REVIEW_CHANGED', { approved: approved.hashes, observed: summary.hashes });
  }
  const inventoryPath = join(folder, 'INVENTORY.json');
  await writeNew(inventoryPath, approvedBytes);
  const authority = await bindApproval(folder, summary, inventoryPath, inventorySha256, authorizationId, userReply);
  const transactionId = randomUUID(), trustAnchor = prepareBilingualPublicationTrustAnchor({ vaultRoot: root, run });
  const intent = { schema_version: profile, run_id: run, transaction_id: transactionId, trust_anchor: trustAnchor,
    hashes: summary.hashes, inventory_sha256: inventorySha256 };
  const intentPath = join(folder, 'INTENT.json');
  await writeNew(intentPath, json(intent));
  const args = { vaultRoot: root, run, plan, transactionId, ...authority };
  await registerBilingualPublication(args);
  await onRegistered?.(intent);
  const transaction = await applyBilingualPublication({ ...args, onPromotionBoundary });
  return { ...await verifyResult(folder, summary, transaction), trust_anchor: trustAnchor, intent_path: intentPath };
}

// The existing recover command owns journal and lock recovery. Only its signed
// maintenance approval can authorize completion of the corresponding evidence.
export async function finishMaintenanceRecovery({ vaultRoot, run, transaction }) {
  if (!transaction?.ok || !identifier(run)) return transaction;
  const intentPath = join(vaultRoot, 'Eval', 'apa-v3', 'runs', run, 'publication', 'INTENT.json');
  try { await lstat(intentPath); } catch (error) { if (error.code === 'ENOENT') return transaction; throw error; }
  const inspected = await inspectBilingualPublicationRecovery({ vaultRoot, run, transactionId: transaction.transaction_id, requireJournal: true });
  const authority = inspected.authority;
  if (authority.original_source?.kind !== profile) return transaction;
  const folder = await directory(vaultRoot, run), inventoryPath = join(folder, 'INVENTORY.json');
  const intent = parseJson(await readEvidence(intentPath), intentPath);
  if (intent.schema_version !== profile || intent.transaction_id !== transaction.transaction_id || authority.inventory_path !== inventoryPath
    || authority.inventory_sha256 !== intent.inventory_sha256 || !same(intent.hashes, {
      review_hash: inspected.hashes.review_hash, output_inventory_hash: inspected.hashes.output_inventory_hash })) fail('P22_MAINTENANCE_INVENTORY_MISMATCH');
  const approved = await readEvidence(inventoryPath);
  if (sha(approved) !== authority.inventory_sha256) fail('P22_MAINTENANCE_INVENTORY_MISMATCH');
  return verifyResult(folder, parseJson(approved, inventoryPath), transaction);
}
