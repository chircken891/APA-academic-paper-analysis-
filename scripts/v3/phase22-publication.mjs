import { captureTopicPublicationRegistration, rebuildRegisteredTopicReview, assertTopicPublicationReviewLive, usesCurrentTopicPublication } from './topic-publication.mjs';
import { loadApaConfig } from '../lib/apa-config.mjs';
import { createHash, randomUUID, generateKeyPairSync, createPublicKey, sign, verify } from 'node:crypto';
import { readFile, writeFile, open, lstat, realpath, mkdir, rename, link, unlink } from 'node:fs/promises';
import { readFileSync, realpathSync, lstatSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertReadingBasisCurrent } from './phase22-input.mjs';
import { assertFrozenRenderContext } from './phase22-render-context.mjs';
import { assertBilingualParity } from './phase22-parity.mjs';
import { snapshotPhase22Runtime, getAcceptedLanguageRecord } from './phase22-language.mjs';
import { resolve, relative, dirname, basename, sep, join } from 'node:path';
import { hostname, tmpdir } from 'node:os';
import Ajv2020 from 'ajv/dist/2020.js';
import { isDeepStrictEqual as same } from 'node:util';
import { fingerprintV3Json as hash } from './semantic-package-validator.mjs';
import { assertBilingualReviewCurrent } from './phase22-review.mjs';
import { getRunControlForDispatch, createOwnedArtifactBroker } from './owned-artifact-store.mjs';
import { assertActiveGeneration, assertIndexGeneration, assertActiveIndexContract, readCommittedGeneration, readRegisteredCommit, PHASE22_COMMIT_PATH } from './phase22-active-version.mjs';
import { inspectManagedNote } from './phase22-managed-markdown.mjs';
import { captureReadingFirstPublicationRegistration, rebuildRegisteredReadingFirstReview,
  assertReadingFirstPublicationReviewLive, usesCurrentReadingFirstPublication } from './reading-first-publication.mjs';

const CONTROL = '.apa-v3/phase22';
const LOCK = CONTROL + '/publication.lock';
const plans = new WeakMap();
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(JSON.stringify(value) + '\n');
const fail = (code, details = {}) => { throw Object.assign(new Error(code), { code, details }); };
const schema = JSON.parse(readFileSync(new URL('../../Schema/phase22/publication-transaction.schema.json', import.meta.url), 'utf8'));
const validateJournal = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
const clone = value => structuredClone(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value);
const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino) });
const sameIdentity = (left, right) => left && right && left.ino !== '0' && left.dev === right.dev && left.ino === right.ino;
const inside = (root, path) => { const r = relative(root, path); return r !== '..' && !r.startsWith('..' + sep) && !r.startsWith(sep) && resolve(root, r) === path; };


const authoritySymbol = Symbol.for('apa-v3.phase22.controller-authorities.v1');
if (!globalThis[authoritySymbol]) Object.defineProperty(globalThis, authoritySymbol, { value: new Map(), writable: false });
const controllerAuthorities = globalThis[authoritySymbol];
const authorityKey = (vaultRoot, run) => JSON.stringify([resolve(vaultRoot), run]);
function controllerKey(vaultRoot, run, create = false) {
  const key = authorityKey(vaultRoot, run);
  if (!controllerAuthorities.has(key) && create) {
    const pair = generateKeyPairSync('ed25519');
    controllerAuthorities.set(key, { privateKey: pair.privateKey, publicDer: pair.publicKey.export({ type: 'spki', format: 'der' }) });
  }
  return controllerAuthorities.get(key);
}
/** Public, non-secret trust anchor delivered by the current controller, never loaded from a vault record. */
export function getBilingualPublicationTrustAnchor({ vaultRoot, run } = {}) {
  if (!identifier(run) || typeof vaultRoot !== 'string') fail('P22_CONTROLLER_TRUST_REQUIRED');
  const pair = controllerKey(vaultRoot, run);
  if (!pair) fail('P22_CONTROLLER_TRUST_REQUIRED');
  return Object.freeze({ schema_version: 'phase22-controller-trust-1.0', vault_root: resolve(vaultRoot),
    run_id: run, public_key: pair.publicDer.toString('base64') });
}
/** Prepare this Controller process's public identity; no files or grants are created. */
export function prepareBilingualPublicationTrustAnchor({ vaultRoot, run } = {}) {
  if (!identifier(run) || typeof vaultRoot !== 'string') fail('P22_CONTROLLER_TRUST_REQUIRED');
  controllerKey(vaultRoot, run, true);
  return getBilingualPublicationTrustAnchor({ vaultRoot, run });
}
function selectedTrustAnchor(vaultRoot, run, explicit) {
  let anchor = explicit;
  if (!anchor && process.env.APA_V3_PUBLICATION_TRUST_ANCHOR) {
    try { anchor = JSON.parse(process.env.APA_V3_PUBLICATION_TRUST_ANCHOR); }
    catch { fail('P22_CONTROLLER_TRUST_INVALID'); }
  }
  if (!anchor) anchor = getBilingualPublicationTrustAnchor({ vaultRoot, run });
  if (anchor.schema_version !== 'phase22-controller-trust-1.0' || anchor.vault_root !== resolve(vaultRoot)
    || anchor.run_id !== run || typeof anchor.public_key !== 'string') fail('P22_CONTROLLER_TRUST_INVALID');
  return anchor;
}
function signControllerGrant(payload) {
  const pair = controllerKey(payload.vault_root, payload.run_id, true);
  return { payload: clone(payload), key_fingerprint: digest(pair.publicDer),
    signature: sign(null, Buffer.from(hash(payload)), pair.privateKey).toString('base64') };
}
function verifyControllerGrant(grant, vaultRoot, run, explicit) {
  const anchor = selectedTrustAnchor(vaultRoot, run, explicit);
  try {
    const publicDer = Buffer.from(anchor.public_key, 'base64'), signature = Buffer.from(grant?.signature ?? '', 'base64');
    if (publicDer.toString('base64') !== anchor.public_key || signature.toString('base64') !== grant?.signature
      || grant?.payload?.schema_version !== 'phase22-controller-grant-1.0'
      || grant.payload.vault_root !== resolve(vaultRoot) || grant.payload.run_id !== run
      || grant.key_fingerprint !== digest(publicDer)
      || !verify(null, Buffer.from(hash(grant.payload)), createPublicKey({ key: publicDer, format: 'der', type: 'spki' }), signature)) {
      fail('P22_CONTROLLER_GRANT_INVALID');
    }
  } catch (error) { if (error.code === 'P22_CONTROLLER_GRANT_INVALID') throw error; fail('P22_CONTROLLER_GRANT_INVALID'); }
  return anchor;
}
function publicationGrantPayload(plan, authority, bundleSha256 = null) {
  return { schema_version: 'phase22-controller-grant-1.0', kind: 'publication', vault_root: plan.vault_root,
    run_id: plan.run_id, plan_fingerprint: planStamp(plan), binding_hash: hash(authority),
    output_inventory_hash: plan.hashes.output_inventory_hash, bundle_sha256: bundleSha256 };
}
function checkPublicationGrant(grant, plan, authority, anchor) {
  const trusted = verifyControllerGrant(grant, plan.vault_root, plan.run_id, anchor);
  const expected = publicationGrantPayload(plan, authority, grant.payload.bundle_sha256 ?? null);
  if (!same(grant.payload, expected)) fail('P22_CONTROLLER_GRANT_INVALID');
  return trusted;
}

function safeRelative(path) {
  if (typeof path !== 'string' || path.includes('\\') || !path || path.startsWith('/') || /[\x00-\x1f<>:"|?*]/.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('P22_PUBLICATION_PATH_INVALID', { path });
  return path;
}
async function rootState(vaultRoot) {
  if (typeof vaultRoot !== 'string' || !vaultRoot) fail('P22_VAULT_ROOT_REQUIRED');
  const root = resolve(vaultRoot), stat = await lstat(root, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(root) !== root) fail('P22_VAULT_ROOT_INVALID');
  return { root, identity: identity(stat) };
}
async function observe(root, path, { allowLinks = false } = {}) {
  safeRelative(path);
  const rootInfo = await rootState(root), parents = [{ path: '', ...rootInfo.identity }];
  const parts = path.split('/');
  let cursor = root;
  for (let index = 0; index < parts.length; index++) {
    cursor = join(cursor, parts[index]);
    let stat;
    try { stat = await lstat(cursor, { bigint: true }); }
    catch (error) {
      if (error.code === 'ENOENT') return { exists: false, bytes: null, sha256: null, byte_length: null, identity: null, parents };
      throw error;
    }
    if (stat.isSymbolicLink() || await realpath(cursor) !== cursor) fail('P22_PUBLICATION_LINK_REJECTED', { path });
    if (stat.dev.toString() !== rootInfo.identity.dev) fail('P22_PUBLICATION_CROSS_VOLUME', { path });
    if (index < parts.length - 1) {
      if (!stat.isDirectory()) fail('P22_PUBLICATION_PARENT_TYPE', { path });
      parents.push({ path: parts.slice(0, index + 1).join('/'), ...identity(stat) });
    } else {
      if (!stat.isFile() || (!allowLinks && stat.nlink !== 1n)) fail('P22_PUBLICATION_FILE_TYPE', { path });
      const bytes = await readFile(cursor), after = await lstat(cursor, { bigint: true });
      if (!sameIdentity(identity(stat), identity(after)) || stat.size !== after.size || stat.mtimeNs !== after.mtimeNs) fail('P22_PUBLICATION_READ_RACE', { path });
      return { exists: true, bytes, sha256: digest(bytes), byte_length: bytes.length, identity: identity(after), parents, nlink: Number(after.nlink) };
    }
  }
}
function matchingBytes(observed, expectedHash, expectedLength) {
  return expectedHash === null ? !observed.exists : observed.exists && observed.sha256 === expectedHash && observed.byte_length === expectedLength;
}
async function verifyParents(root, expected) {
  for (const parent of expected) {
    const path = parent.path ? join(root, parent.path) : root;
    const stat = await lstat(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path || !sameIdentity(identity(stat), parent)) {
      fail('P22_PUBLICATION_PARENT_CHANGED', { path: parent.path });
    }
  }
}
function inventoryStamp(inventory) {
  return inventory.map(({ bytes, ...entry }) => ({ ...entry, observed_sha256: digest(bytes) }));
}
function planStamp(plan) {
  return hash({ ...plan, inventory: inventoryStamp(plan.inventory) });
}
function freezePlan(plan) {
  for (const entry of plan.inventory) Object.freeze(entry);
  Object.freeze(plan.inventory); Object.freeze(plan.hashes); Object.freeze(plan.read_dependencies);
  return Object.freeze(plan);
}
async function currentPlan(plan, { promotion = false } = {}) {
  const record = plans.get(plan);
  if (!record) fail('P22_PUBLICATION_PLAN_NOT_OWNED');
  if (record.stamp !== planStamp(plan)) fail('P22_PUBLICATION_PLAN_CHANGED');
  await assertTopicOperationNotCancelled({ vaultRoot: plan.vault_root, operationId: plan.run_id, trustAnchor: record.trustAnchor });
  if (promotion && record.validatePromotion) record.validatePromotion();
  else if (record.validate) await record.validate();
  else await assertBilingualReviewCurrent(record.review);
  return record;
}
async function checkPreimages(root, plan) {
  for (const row of [...plan.inventory, ...plan.read_dependencies]) {
    await verifyParents(root, row.parents);
    const observed = await observe(root, row.path);
    const before = plan.inventory.includes(row);
    const expectedHash = before ? row.before_sha256 : row.byte_sha256;
    const expectedLength = before ? row.before_byte_length : row.byte_length;
    if (!matchingBytes(observed, expectedHash, expectedLength) || (observed.exists && !sameIdentity(observed.identity, row.before_identity))) {
      fail('P22_PUBLICATION_PREIMAGE_CHANGED', { path: row.path });
    }
  }
}
async function bindOutput(root, row) {
  const state = await observe(root, row.path);
  if (!matchingBytes(state, row.before_sha256, row.before_byte_length)) fail('P22_PUBLICATION_PREIMAGE_CHANGED', { path: row.path });
  return { ...row, bytes: Buffer.from(row.bytes), before_identity: state.identity, parents: state.parents };
}

/** Read-only complete-inventory preparation. It creates no control or business files. */
export async function dryRunBilingualPublication({ vaultRoot, run, review, plan: registeredPlan } = {}) {
  if (registeredPlan) {
    await currentPlan(registeredPlan);
    if (run !== registeredPlan.run_id || resolve(vaultRoot ?? '') !== registeredPlan.vault_root) fail('P22_PUBLICATION_SCOPE_CHANGED');
    await checkPreimages(registeredPlan.vault_root, registeredPlan);
    return { ok: true, status: 'dry_run', plan: registeredPlan, business_writes: 0, external_reader_atomicity: false };
  }
  if (!identifier(run)) fail('P22_RUN_REQUIRED');
  await assertBilingualReviewCurrent(review);
  if (review.reviewManifest.profile === 'phase24-topic-1.0') await assertTopicPublicationReviewLive(review);
  if (review.reviewManifest.profile === 'reading-first-obsidian-1.0') await assertReadingFirstPublicationReviewLive(review);
  if (!review.ok || !review.hashes.output_inventory_hash || review.reviewManifest.identity.run_id !== run) fail('P22_REVIEW_NOT_APPROVABLE');
  const rootInfo = await rootState(vaultRoot), root = rootInfo.root;
  const activeRow = review.outputInventory.find(row => row.kind === 'active');
  const indexRow = review.outputInventory.find(row => row.kind === 'index');
  if (!activeRow || !indexRow) fail('P22_PUBLICATION_PAIR_REQUIRED');
  const generation = assertActiveGeneration(JSON.parse(activeRow.bytes));
  assertIndexGeneration(JSON.parse(indexRow.bytes), generation);
  if (generation.generation_id !== review.reviewManifest.generation) fail('P22_PUBLICATION_GENERATION_MISMATCH');
  const previous = await observe(root, PHASE22_COMMIT_PATH);
  let previousGeneration = null;
  if (previous.exists) {
    const snapshot = (usesCurrentReadingFirstPublication(review) || usesCurrentTopicPublication(review))
      ? await readRegisteredCommit({ vaultRoot: root }) : await readCommittedGeneration({ vaultRoot: root });
    if (!snapshot.ok) fail('P22_PREVIOUS_GENERATION_NOT_CURRENT', { errors: snapshot.errors });
    previousGeneration = snapshot.generation_id;
  }
  if (previousGeneration !== review.reviewManifest.previous_generation) fail('P22_PREVIOUS_GENERATION_CHANGED');
  const inventory = [];
  for (const row of review.outputInventory) {
    if (!['paper', 'support', 'asset', 'active', 'index', 'manifest', 'reader-presentation', 'reading-review', 'reader-record', 'reader-style', 'topic'].includes(row.kind)) fail('P22_PUBLICATION_KIND_INVALID');
    const entry = await bindOutput(root, row);
    if (row.kind === 'paper' && entry.before_sha256 !== null) {
      const old = await observe(root, row.path);
      if (!/^---[\s\S]*?\bpipeline_version:\s*['"]?3\./.test(old.bytes.toString('utf8'))) fail('P22_V2_READONLY', { path: row.path });
    }
    inventory.push(entry);
  }
  const readDependencies = [];
  for (const row of review.reviewManifest.read_dependencies) {
    const state = await observe(root, row.path);
    if (!matchingBytes(state, row.byte_sha256, row.byte_length)) fail('P22_PUBLICATION_REUSE_CHANGED', { path: row.path });
    readDependencies.push({ ...clone(row), before_identity: state.identity, parents: state.parents });
  }
  const paths = inventory.map(row => row.path.normalize('NFC').toLowerCase());
  if (new Set(paths).size !== paths.length) fail('P22_PUBLICATION_TARGET_COLLISION');
  inventory.sort((a, b) => a.path.localeCompare(b.path));
  const commitRecipe = { schema_version: 'phase22/active-index-1.0', kind: 'commit', status: 'COMMITTED',
    generation_id: generation.generation_id, evidence_mode: generation.evidence_mode,
    active: { path: activeRow.path, sha256: activeRow.byte_sha256 }, index: { path: indexRow.path, sha256: indexRow.byte_sha256 },
    approval: { review_hash: review.hashes.review_bundle_hash, output_inventory_hash: null, evidence_mode: generation.evidence_mode } };
  // The exact marker is derived from this recipe and hash; no self-hashing cycle.
  const outputHash = hash({ inventory: inventoryStamp(inventory), read_dependencies: readDependencies,
    commit_recipe: commitRecipe, previous_commit_sha256: previous.sha256, previous_commit_identity: previous.identity });
  const commit = { ...commitRecipe, approval: { ...commitRecipe.approval, output_inventory_hash: outputHash } };
  assertActiveIndexContract(commit, 'commit');
  const commitBytes = jsonBytes(commit);
  inventory.push(await bindOutput(root, { path: PHASE22_COMMIT_PATH, kind: 'commit', bytes: commitBytes,
    byte_sha256: digest(commitBytes), byte_length: commitBytes.length, before_sha256: previous.sha256, before_byte_length: previous.byte_length }));
  const plan = freezePlan({ kind: 'phase22-publication-plan', vault_root: root, root_identity: rootInfo.identity,
    run_id: run, analysis_revision: review.reviewManifest.identity.analysis_revision,
    evidence_mode: generation.evidence_mode, generation: generation.generation_id, previous_generation: previousGeneration,
    hashes: { scientific_review_hash: review.hashes.scientific_review_hash, review_hash: review.hashes.review_bundle_hash,
      review_output_inventory_hash: review.hashes.output_inventory_hash, output_inventory_hash: outputHash },
    inventory, read_dependencies: readDependencies });
  plans.set(plan, { review, stamp: planStamp(plan) });
  await checkPreimages(root, plan);
  return { ok: true, status: 'dry_run', plan, business_writes: 0, external_reader_atomicity: false };
}
async function readAuthorityFile(binding, supplied) {
  if (!binding || typeof binding.path !== 'string' || supplied !== binding.path) fail('P22_APPROVAL_RECORD_REQUIRED');
  const path = resolve(binding.path), state = await observe(dirname(path), basename(path));
  if (!state.exists || state.sha256 !== binding.sha256) fail('P22_APPROVAL_RECORD_CHANGED', { path });
  let value;
  try { value = JSON.parse(state.bytes); } catch { fail('P22_APPROVAL_RECORD_INVALID'); }
  return value;
}
async function authorityFromBinding(binding, plan, args, { recovery = false } = {}) {
  if (!binding || binding.run_id !== plan.run_id || binding.analysis_revision !== plan.analysis_revision
    || resolve(binding.vault_root ?? '') !== plan.vault_root || binding.review_hash !== plan.hashes.review_hash
    || binding.output_inventory_hash !== plan.hashes.output_inventory_hash || binding.evidence_mode !== plan.evidence_mode
    || !same(binding.inventory_paths, plan.inventory.map(row => row.path))) fail('P22_PUBLICATION_APPROVAL_MISMATCH');
  const approval = await readAuthorityFile(binding.approval_record, args.approvalRecord);
  const expected = { ...binding };
  delete expected.approval_record; delete expected.maintenance_window_record;
  if (!same(approval, expected) || approval.schema_version !== 'phase22-publication-approval-1.0'
    || !approval.allowed_actions?.includes(recovery ? 'recover' : 'apply')) fail('P22_PUBLICATION_APPROVAL_MISMATCH');
  if (plan.evidence_mode === 'synthetic') {
    const temporaryRoot = await realpath(tmpdir());
    if (approval.authority !== 'synthetic-fixture' || approval.scope !== 'temporary-fixture'
      || plan.vault_root === temporaryRoot || !inside(temporaryRoot, plan.vault_root)) fail('P22_SYNTHETIC_PUBLICATION_SCOPE');
  } else if (approval.authority !== 'user' || approval.scope !== 'production') fail('P22_PUBLICATION_APPROVAL_MISMATCH');
  const window = await readAuthorityFile(binding.maintenance_window_record, args.maintenanceWindowRecord);
  const now = Date.now();
  if (window.schema_version !== 'phase22-maintenance-window-1.0' || window.authorization_id !== approval.authorization_id
    || resolve(window.vault_root ?? '') !== plan.vault_root || window.run_id !== plan.run_id
    || window.analysis_revision !== plan.analysis_revision || window.scope !== approval.scope
    || window.external_readers_acknowledged !== true || !Number.isFinite(Date.parse(window.starts_at))
    || !Number.isFinite(Date.parse(window.ends_at)) || now < Date.parse(window.starts_at) || now >= Date.parse(window.ends_at)) fail('P22_MAINTENANCE_WINDOW_REQUIRED');
  return clone(binding);
}
async function assertAuthority(args, plan) {
  const current = getRunControlForDispatch({ dispatchContext: args.control?.dispatchContext, runId: args.control?.runId });
  if (!current?.phase22_publication_binding || args.control.runId !== plan.run_id) fail('P22_PUBLICATION_CONTROL_REQUIRED');
  if (args.expectedReviewSha256 !== plan.hashes.review_hash || args.expectedOutputSha256 !== plan.hashes.output_inventory_hash) fail('P22_PUBLICATION_APPROVAL_HASH_REQUIRED');
  return authorityFromBinding(current.phase22_publication_binding, plan, args);
}
async function guardOperationParents(ctx, path) {
  safeRelative(path);
  const root = await rootState(ctx.root);
  if (ctx.root_identity && !sameIdentity(root.identity, ctx.root_identity)) fail('P22_PUBLICATION_SCOPE_CHANGED');
  ctx.root_identity ??= root.identity;
  const parts = path.split('/').slice(0, -1);
  let relativePath = '';
  for (const part of parts) {
    relativePath = relativePath ? relativePath + '/' + part : part;
    const absolute = join(ctx.root, relativePath), stat = await lstat(absolute, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(absolute) !== absolute
      || String(stat.dev) !== root.identity.dev) fail('P22_PUBLICATION_PARENT_CHANGED', { path: relativePath });
    const expected = ctx.parent_pins.get(relativePath);
    if (expected && !sameIdentity(expected, identity(stat))) fail('P22_PUBLICATION_PARENT_CHANGED', { path: relativePath });
    ctx.parent_pins.set(relativePath, identity(stat));
  }
}
async function verifyPayloadBeforeCommit(ctx, journal) {
  for (const row of journal.inventory.filter(row => row.kind !== 'commit')) {
    await verifyParents(ctx.root, row.parents);
    if (row.state !== 'completed' || !await ownedPostimage(ctx, row)) fail('P22_PUBLICATION_POSTIMAGE_CHANGED', { path: row.path });
  }
  const written = new Set(journal.inventory.map(row => row.path));
  for (const row of journal.read_dependencies.filter(row => !written.has(row.path))) {
    const observed = await observe(ctx.root, row.path);
    await verifyParents(ctx.root, row.parents);
    if (!matchingBytes(observed, row.byte_sha256, row.byte_length) || !sameIdentity(observed.identity, row.before_identity)) {
      fail('P22_PUBLICATION_REUSE_CHANGED', { path: row.path });
    }
  }
}

function runtime(root, transactionId, options = {}) {
  let ordinal = 0;
  return { root, transactionId, options, parent_pins: new Map(),
    async boundary(operation, timing, path) {
      await options.onPersistentBoundary?.({ ordinal: ++ordinal, operation, timing, path, transaction_id: transactionId });
    },
    async operation(operation, path, callback) {
      await this.boundary(operation, 'before', path);
      await guardOperationParents(this, path);
      const value = await callback();
      await this.boundary(operation, 'after', path);
      return value;
    },
  };
}
async function ensureDirectories(ctx, relativeDirectory) {
  if (!relativeDirectory || relativeDirectory === '.') return;
  safeRelative(relativeDirectory);
  let accumulated = '';
  for (const part of relativeDirectory.split('/')) {
    accumulated = accumulated ? accumulated + '/' + part : part;
    const path = join(ctx.root, accumulated);
    try {
      const stat = await lstat(path, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) fail('P22_PUBLICATION_PARENT_TYPE', { path: accumulated });
      const expected = ctx.parent_pins.get(accumulated);
      if (expected && !sameIdentity(expected, identity(stat))) fail('P22_PUBLICATION_PARENT_CHANGED', { path: accumulated });
      ctx.parent_pins.set(accumulated, identity(stat));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await ctx.operation('directory.mkdir', accumulated, async () => {
        await mkdir(path);
        ctx.parent_pins.set(accumulated, identity(await lstat(path, { bigint: true })));
      });
    }
  }
}
async function durableNew(ctx, path, bytes, label) {
  await ensureDirectories(ctx, path.split('/').slice(0, -1).join('/'));
  let handle;
  try {
    handle = await open(join(ctx.root, path), 'wx');
    await ctx.operation(label + '.write', path, () => handle.writeFile(bytes));
    await ctx.operation(label + '.sync', path, () => handle.sync());
  } finally { await handle?.close(); }
  return (await observe(ctx.root, path)).identity;
}
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
async function acquireLock(ctx, authorityHash, { recover = false } = {}) {
  await ensureDirectories(ctx, CONTROL);
  const old = await observe(ctx.root, LOCK, { allowLinks: true });
  if (old.exists) {
    let owner;
    try { owner = JSON.parse(old.bytes); } catch { fail('P22_VAULT_LOCK_UNKNOWN_OWNER'); }
    if (!recover || owner.host !== hostname() || owner.transaction_id !== ctx.transactionId || owner.authority_hash !== authorityHash
      || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string' || alive(owner.pid)) {
      fail('P22_VAULT_LOCKED', { transaction_id: owner.transaction_id ?? null });
    }
    if (!identifier(owner.token)) fail('P22_VAULT_LOCK_UNKNOWN_OWNER');
    if (old.nlink !== 1) {
      const stagePath = CONTROL + '/lock-' + owner.token + '.writing';
      const stage = await observe(ctx.root, stagePath, { allowLinks: true });
      if (old.nlink !== 2 || !stage.exists || stage.sha256 !== old.sha256 || !sameIdentity(stage.identity, old.identity)) fail('P22_VAULT_LOCK_UNKNOWN_OWNER');
      await ctx.operation('lock.stage_unlink', stagePath, () => unlink(join(ctx.root, stagePath)));
    }
    const retired = CONTROL + '/transactions/' + ctx.transactionId + '/retired-lock-' + owner.token + '.json';
    await ensureDirectories(ctx, retired.split('/').slice(0, -1).join('/'));
    const again = await observe(ctx.root, LOCK);
    if (!sameIdentity(again.identity, old.identity) || again.sha256 !== old.sha256) fail('P22_VAULT_LOCK_CHANGED');
    await ctx.operation('lock.retire', LOCK, () => rename(join(ctx.root, LOCK), join(ctx.root, retired)));
    const moved = await observe(ctx.root, retired);
    if (!sameIdentity(moved.identity, old.identity) || moved.sha256 !== old.sha256) fail('P22_VAULT_LOCK_CHANGED');
  }
  const owner = { version: 1, host: hostname(), pid: process.pid, token: randomUUID(), transaction_id: ctx.transactionId, authority_hash: authorityHash };
  try {
    const stagePath = CONTROL + '/lock-' + owner.token + '.writing';
    const id = await durableNew(ctx, stagePath, jsonBytes(owner), 'lock');
    await ctx.operation('lock.acquire', LOCK, () => link(join(ctx.root, stagePath), join(ctx.root, LOCK)));
    await ctx.operation('lock.stage_unlink', stagePath, () => unlink(join(ctx.root, stagePath)));
    return { owner, identity: id, sha256: digest(jsonBytes(owner)) };
  } catch (error) {
    if (error.code === 'EEXIST') fail('P22_VAULT_LOCKED');
    throw error;
  }
}
async function assertLock(ctx, lock) {
  const current = await observe(ctx.root, LOCK);
  if (!current.exists || current.sha256 !== lock.sha256 || !sameIdentity(current.identity, lock.identity)) fail('P22_VAULT_LOCK_LOST');
}
async function releaseLock(ctx, lock) {
  await assertLock(ctx, lock);
  await ctx.operation('lock.release', LOCK, async () => { await assertLock(ctx, lock); await unlink(join(ctx.root, LOCK)); });
}
function event(journal, type, path = null) {
  const entry = { seq: journal.events.length, type, path, previous_hash: journal.event_head,
    data_hash: hash({ state: journal.state, inventory: journal.inventory, blocked_paths: journal.blocked_paths }) };
  entry.event_hash = hash(entry);
  journal.events.push(entry); journal.event_head = entry.event_hash;
}
function verifyJournalApproval(journal) {
  const prepared = journal.prepared_inventory;
  if (!Array.isArray(prepared) || prepared.length !== journal.inventory.length) fail('P22_JOURNAL_APPROVAL_MISMATCH');
  const transactionRoot = CONTROL + '/transactions/' + journal.transaction_id;
  for (const [index, row] of journal.inventory.entries()) {
    const { state, stage_path, backup_path, displaced_path, after_identity, parents, ...fixed } = row;
    const { parents: originalParents, ...approved } = prepared[index];
    if (!same(fixed, approved) || stage_path !== transactionRoot + '/stage/' + index + '.bin'
      || backup_path !== transactionRoot + '/backup/' + index + '.bin'
      || displaced_path !== transactionRoot + '/backup/' + index + '.displaced') fail('P22_JOURNAL_APPROVAL_MISMATCH');
    safeRelative(row.path);
  }
  const marker = prepared.find(row => row.kind === 'commit');
  const active = prepared.find(row => row.kind === 'active'), index = prepared.find(row => row.kind === 'index');
  if (!marker || !active || !index || prepared.at(-1) !== marker
    || marker.path !== PHASE22_COMMIT_PATH || new Set(prepared.map(row => row.path)).size !== prepared.length) fail('P22_JOURNAL_APPROVAL_MISMATCH');
  const recipe = { schema_version: 'phase22/active-index-1.0', kind: 'commit', status: 'COMMITTED',
    generation_id: journal.generation, evidence_mode: journal.evidence_mode,
    active: { path: active.path, sha256: active.byte_sha256 }, index: { path: index.path, sha256: index.byte_sha256 },
    approval: { review_hash: journal.hashes.review_hash, output_inventory_hash: null, evidence_mode: journal.evidence_mode } };
  const expected = hash({ inventory: prepared.filter(row => row !== marker).map(row => ({ ...row, observed_sha256: row.byte_sha256 })),
    read_dependencies: journal.read_dependencies, commit_recipe: recipe,
    previous_commit_sha256: marker.before_sha256, previous_commit_identity: marker.before_identity });
  const markerBytes = jsonBytes({ ...recipe, approval: { ...recipe.approval, output_inventory_hash: expected } });
  if (expected !== journal.hashes.output_inventory_hash || expected !== journal.authority.output_inventory_hash
    || marker.byte_sha256 !== digest(markerBytes) || marker.byte_length !== markerBytes.length) fail('P22_JOURNAL_APPROVAL_MISMATCH');
}

function checkJournal(journal) {
  if (!validateJournal(journal)) fail('P22_TRANSACTION_SCHEMA_INVALID', { errors: validateJournal.errors });
  verifyJournalApproval(journal);
  let previous = null;
  for (const [index, entry] of journal.events.entries()) {
    const { event_hash: eventHash, ...body } = entry;
    if (entry.seq !== index || entry.previous_hash !== previous || hash(body) !== eventHash) fail('P22_JOURNAL_CHAIN_INVALID');
    previous = eventHash;
  }
  if (previous !== journal.event_head || journal.events.at(-1)?.data_hash !== hash({ state: journal.state, inventory: journal.inventory, blocked_paths: journal.blocked_paths })) fail('P22_JOURNAL_CHAIN_INVALID');
}
async function saveJournal(ctx, journal, lock, type, path = null) {
  await assertLock(ctx, lock);
  event(journal, type, path);
  checkJournal(journal);
  const journalPath = CONTROL + '/transactions/' + ctx.transactionId + '/journal.json';
  const next = journalPath + '.' + journal.events.length + '.' + randomUUID() + '.writing';
  await durableNew(ctx, next, jsonBytes(journal), 'journal');
  await assertLock(ctx, lock);
  await ctx.operation('journal.rename', journalPath, () => rename(join(ctx.root, next), join(ctx.root, journalPath)));
}
async function prePromotion(ctx, row, lock) {
  await assertLock(ctx, lock);
  await verifyParents(ctx.root, row.parents);
  const observed = await observe(ctx.root, row.path);
  if (!matchingBytes(observed, row.before_sha256, row.before_byte_length)
    || (observed.exists && !sameIdentity(observed.identity, row.before_identity))) fail('P22_PUBLICATION_PREIMAGE_CHANGED', { path: row.path });
}
async function ownedPostimage(ctx, row) {
  const target = await observe(ctx.root, row.path, { allowLinks: true });
  if (!matchingBytes(target, row.byte_sha256, row.byte_length) || !sameIdentity(target.identity, row.after_identity)) return false;
  if (target.nlink === 1) return true;
  const stage = await observe(ctx.root, row.stage_path, { allowLinks: true });
  return target.nlink === 2 && stage.exists && sameIdentity(stage.identity, target.identity);
}
async function restoreEntry(ctx, journal, row, lock) {
  if (row.state === 'pending' || row.state === 'staged' || row.state === 'restored') return;
  await assertLock(ctx, lock);
  await verifyParents(ctx.root, row.parents);
  const target = await observe(ctx.root, row.path, { allowLinks: true });
  if (target.exists && matchingBytes(target, row.before_sha256, row.before_byte_length)
    && sameIdentity(target.identity, row.before_identity)) {
    if (target.nlink !== 1) {
      const displaced = await observe(ctx.root, row.displaced_path, { allowLinks: true });
      if (target.nlink !== 2 || !displaced.exists || !sameIdentity(displaced.identity, row.before_identity)
        || !matchingBytes(displaced, row.before_sha256, row.before_byte_length)) {
        journal.blocked_paths.push(row.path); return;
      }
      await ctx.operation('restore.unlink', row.displaced_path, async () => {
        const current = await observe(ctx.root, row.path, { allowLinks: true });
        const held = await observe(ctx.root, row.displaced_path, { allowLinks: true });
        if (!sameIdentity(current.identity, row.before_identity) || !sameIdentity(held.identity, row.before_identity)
          || !matchingBytes(current, row.before_sha256, row.before_byte_length)
          || !matchingBytes(held, row.before_sha256, row.before_byte_length)) fail('P22_RESTORE_OWNERSHIP_CHANGED', { path: row.path });
        await unlink(join(ctx.root, row.displaced_path));
      });
    }
    row.state = 'restored'; await saveJournal(ctx, journal, lock, 'restore_already_original', row.path); return;
  }
  if (target.exists) {
    if (!await ownedPostimage(ctx, row)) { journal.blocked_paths.push(row.path); return; }
    row.state = 'restore_intent'; await saveJournal(ctx, journal, lock, 'restore_intent', row.path);
    await assertLock(ctx, lock);
    if (!await ownedPostimage(ctx, row)) { journal.blocked_paths.push(row.path); return; }
    await ctx.operation('rollback.unlink', row.path, () => unlink(join(ctx.root, row.path)));
  } else if (row.state !== 'restore_intent') {
    row.state = 'restore_intent'; await saveJournal(ctx, journal, lock, 'restore_intent', row.path);
  }
  if (row.before_sha256 !== null) {
    const backup = await observe(ctx.root, row.backup_path);
    if (!matchingBytes(backup, row.before_sha256, row.before_byte_length)) fail('P22_BACKUP_INVALID', { path: row.path });
    const original = await observe(ctx.root, row.displaced_path, { allowLinks: true });
    if (!matchingBytes(original, row.before_sha256, row.before_byte_length) || !sameIdentity(original.identity, row.before_identity)
      || original.nlink !== 1) { journal.blocked_paths.push(row.path); return; }
    await assertLock(ctx, lock);
    try {
      // Keep the original identity through restore. A new process can recognize
      // this exact before-image even if it dies immediately after this link.
      await ctx.operation('rollback.link', row.path, async () => {
        const held = await observe(ctx.root, row.displaced_path);
        if (!matchingBytes(held, row.before_sha256, row.before_byte_length)
          || !sameIdentity(held.identity, row.before_identity)) fail('P22_RESTORE_OWNERSHIP_CHANGED', { path: row.path });
        await link(join(ctx.root, row.displaced_path), join(ctx.root, row.path));
      });
      await ctx.operation('restore.unlink', row.displaced_path, async () => {
        const current = await observe(ctx.root, row.path, { allowLinks: true });
        const held = await observe(ctx.root, row.displaced_path, { allowLinks: true });
        if (!matchingBytes(current, row.before_sha256, row.before_byte_length)
          || !sameIdentity(current.identity, row.before_identity) || !sameIdentity(held.identity, row.before_identity)) {
          fail('P22_RESTORE_OWNERSHIP_CHANGED', { path: row.path });
        }
        await unlink(join(ctx.root, row.displaced_path));
      });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      journal.blocked_paths.push(row.path); return;
    }
  }
  row.state = 'restored'; await saveJournal(ctx, journal, lock, 'restored', row.path);
}
async function rollback(ctx, journal, lock) {
  journal.state = 'rolling_back';
  await saveJournal(ctx, journal, lock, 'rolling_back');
  for (const row of [...journal.inventory].reverse()) {
    try { await restoreEntry(ctx, journal, row, lock); }
    catch (error) {
      if (error.code === 'P22_VAULT_LOCK_LOST') throw error;
      journal.blocked_paths.push(row.path);
    }
  }
  journal.blocked_paths = [...new Set(journal.blocked_paths)];
  journal.state = journal.blocked_paths.length ? 'recovery_blocked' : 'rolled_back';
  await saveJournal(ctx, journal, lock, journal.state);
  return { status: journal.state, blocked_paths: journal.blocked_paths };
}
function journalFromPlan(plan, transactionId, authority, controllerGrant) {
  const base = CONTROL + '/transactions/' + transactionId;
  return { schema_version: 'phase22/publication-transaction-1.0', transaction_id: transactionId,
    vault_root: plan.vault_root, root_identity: plan.root_identity, run_id: plan.run_id, analysis_revision: plan.analysis_revision,
    generation: plan.generation, previous_generation: plan.previous_generation, evidence_mode: plan.evidence_mode,
    hashes: clone(plan.hashes), authority, authority_hash: hash(authority), controller_grant: clone(controllerGrant), state: 'prepared',
    inventory: plan.inventory.map(({ bytes, ...row }, index) => ({ ...clone(row), state: 'pending',
      stage_path: base + '/stage/' + index + '.bin', backup_path: base + '/backup/' + index + '.bin',
      displaced_path: base + '/backup/' + index + '.displaced', after_identity: null })),
    prepared_inventory: plan.inventory.map(({ bytes, ...row }) => clone(row)), read_dependencies: clone(plan.read_dependencies), events: [], event_head: null, blocked_paths: [] };
}
function resultFor(journal) {
  return { ok: journal.state === 'committed' || journal.state === 'rolled_back', status: journal.state,
    transaction_id: journal.transaction_id, journal_path: CONTROL + '/transactions/' + journal.transaction_id + '/journal.json',
    generation: journal.generation, evidence_mode: journal.evidence_mode, blocked_paths: journal.blocked_paths,
    cleanup_policy: 'retain_backups_and_journal_until_separately_approved', external_reader_atomicity: false };
}

async function withTopicHints(result, plan, record) {
  const paperId = record.review?.reviewManifest.identity.paper_id;
  if (result.status !== 'committed' || !paperId || record.review.reviewManifest.profile === 'phase24-topic-1.0') return result;
  try {
    const { getTopicUpdateHints } = await import('./topic-library.mjs');
    const hints = await getTopicUpdateHints({ vaultRoot: plan.vault_root, generationId: result.generation, changedPaperIds: [paperId] });
    return { ...result, relevance_hints: hints.relevance_hints ?? hints.hints ?? [], hint_status: hints.ok === false ? 'retryable' : 'available' };
  } catch (error) {
    return { ...result, relevance_hints: [], hint_status: 'retryable', hint_error: { code: error.code ?? error.message } };
  }
}

async function withCommittedGraph(result, vaultRoot) {
  if (result.status !== 'committed') return result;
  try {
    const { syncCommittedGraph } = await import('./obsidian-graph-sync.mjs');
    return { ...result, graph_sync: await syncCommittedGraph({ vaultRoot }) };
  } catch (error) {
    return { ...result, graph_sync: { ok: false, status: 'retryable', error: { code: error.code ?? error.message } } };
  }
}

/** Exact controller authority is required even for a synthetic temporary apply. */
export async function applyBilingualPublication(args = {}) {
  const { plan } = args;
  await currentPlan(plan);
  const rootInfo = await rootState(args.vaultRoot);
  if (rootInfo.root !== plan.vault_root || args.run !== plan.run_id || !sameIdentity(rootInfo.identity, plan.root_identity)) fail('P22_PUBLICATION_SCOPE_CHANGED');
  const planRecord = plans.get(plan);
  if (plan.evidence_mode === 'actual' && ['phase22-reader-note-1.0', 'reading-first-obsidian-1.0'].includes(planRecord.review?.reviewManifest.profile)
    && !planRecord.review.reviewManifest.reading_accepted) fail('P221_READER_NOT_ACCEPTED');
  const authority = await assertAuthority(args, plan);
  const controllerGrant = planRecord.controllerGrant ?? signControllerGrant(publicationGrantPayload(plan, authority));
  checkPublicationGrant(controllerGrant, plan, authority, planRecord.trustAnchor);
  const transactionId = args.transactionId ?? planRecord.transactionId ?? randomUUID();
  if (planRecord.transactionId && transactionId !== planRecord.transactionId) fail('P22_TRANSACTION_SCOPE_MISMATCH');
  if (!identifier(transactionId)) fail('P22_TRANSACTION_ID_INVALID');
  const ctx = runtime(rootInfo.root, transactionId, args);
  let lock, journal, committed = false;
  try {
    lock = await acquireLock(ctx, hash(authority));
    await currentPlan(plan); await assertAuthority(args, plan); await checkPreimages(ctx.root, plan);
    if (planRecord.review?.reviewManifest.profile === 'phase24-topic-1.0'
      && !(await observe(ctx.root, CONTROL + '/runs/' + plan.run_id + '/CURRENT.json')).exists) {
      const { getTopicPublicationCandidate } = await import('./topic-publication.mjs');
      const candidate = getTopicPublicationCandidate(planRecord.review);
      if (!controllerKey(ctx.root, plan.run_id, false)) fail('P24_CANCELLATION_AUTHORITY_REQUIRED');
      const payload = { schema_version: 'phase22-controller-grant-1.0', kind: 'topic-attempt', vault_root: ctx.root,
        run_id: plan.run_id, candidate_fingerprint: hash(candidate), generation: plan.generation, transaction_id: transactionId };
      await writeRegisteredRecord(ctx, CONTROL + '/runs/' + plan.run_id + '/TOPIC-ATTEMPT.json',
        jsonBytes({ schema_version: 'phase24-topic-attempt-1.0', controller_grant: signControllerGrant(payload) }));
    }
    journal = journalFromPlan(plan, transactionId, authority, controllerGrant);
    await ensureDirectories(ctx, CONTROL + '/transactions/' + transactionId);
    await saveJournal(ctx, journal, lock, 'prepared');
    for (const [index, row] of journal.inventory.entries()) {
      await assertLock(ctx, lock);
      row.after_identity = await durableNew(ctx, row.stage_path, plan.inventory[index].bytes, 'stage');
      if (row.before_sha256 !== null) {
        await prePromotion(ctx, row, lock);
        const original = await observe(ctx.root, row.path);
        await durableNew(ctx, row.backup_path, original.bytes, 'backup');
      }
      row.state = 'staged'; await saveJournal(ctx, journal, lock, 'staged', row.path);
    }
    // The original complete generation is still present until promotion begins.
    if (planRecord.validatePromotion) {
      await currentPlan(plan); await assertAuthority(args, plan); await checkPreimages(ctx.root, plan);
    }
    journal.state = 'staged'; await saveJournal(ctx, journal, lock, 'all_staged');
    for (const row of journal.inventory) {
      // Approved replacements invalidate the old generation's full-reader snapshot.
      // Registered reader inputs remain physically pinned throughout this transaction.
      await currentPlan(plan, { promotion: true }); await assertAuthority(args, plan);
      await args.onPromotionBoundary?.({ timing: 'before', path: row.path, kind: row.kind, transaction_id: transactionId });
      if (row.kind === 'commit') await verifyPayloadBeforeCommit(ctx, journal);
      await prePromotion(ctx, row, lock);
      await ensureDirectories(ctx, row.path.split('/').slice(0, -1).join('/'));
      row.parents = (await observe(ctx.root, row.path)).parents;
      journal.state = 'promoting'; row.state = 'intent';
      await saveJournal(ctx, journal, lock, 'promotion_intent', row.path);
      await prePromotion(ctx, row, lock);
      if (row.before_sha256 !== null) {
        await ctx.operation('target.displace', row.path, async () => {
          await assertAuthority(args, plan);
          await prePromotion(ctx, row, lock);
          await rename(join(ctx.root, row.path), join(ctx.root, row.displaced_path));
        });
        const displaced = await observe(ctx.root, row.displaced_path);
        if (!matchingBytes(displaced, row.before_sha256, row.before_byte_length) || !sameIdentity(displaced.identity, row.before_identity)) fail('P22_PUBLICATION_DISPLACED_CHANGED', { path: row.path });
      }
      await assertLock(ctx, lock);
      await ctx.operation(row.kind === 'commit' ? 'commit.link' : 'target.link', row.path,
        async () => {
          await assertAuthority(args, plan);
          await verifyParents(ctx.root, row.parents);
          const staged = await observe(ctx.root, row.stage_path);
          if (!matchingBytes(staged, row.byte_sha256, row.byte_length) || !sameIdentity(staged.identity, row.after_identity)) fail('P22_PUBLICATION_STAGE_CHANGED', { path: row.path });
          if (row.kind === 'commit') {
            if (planRecord.validatePromotion) await currentPlan(plan, { promotion: true });
            await verifyPayloadBeforeCommit(ctx, journal);
          }
          await link(join(ctx.root, row.stage_path), join(ctx.root, row.path));
        });
      if (row.kind === 'commit') committed = true;
      await ctx.operation('stage.unlink', row.stage_path, () => unlink(join(ctx.root, row.stage_path)));
      if (!await ownedPostimage(ctx, row)) fail('P22_PUBLICATION_POSTIMAGE_CHANGED', { path: row.path });
      row.state = 'completed';
      if (row.kind === 'commit') journal.state = 'committed';
      await saveJournal(ctx, journal, lock, row.kind === 'commit' ? 'committed' : 'promoted', row.path);
      await args.onPromotionBoundary?.({ timing: 'after', path: row.path, kind: row.kind, transaction_id: transactionId });
    }
    const observed = (planRecord.currentContentPolicy || usesCurrentReadingFirstPublication(planRecord.review) || usesCurrentTopicPublication(planRecord.review))
      ? await readRegisteredCommit({ vaultRoot: ctx.root }) : await readCommittedGeneration({ vaultRoot: ctx.root });
    if (!observed.ok) fail('P22_COMMITTED_READER_REJECTED', { errors: observed.errors });
    await ctx.operation('post_commit.retained', CONTROL + '/transactions/' + transactionId + '/retained.json',
      () => writeFile(join(ctx.root, CONTROL, 'transactions', transactionId, 'retained.json'), jsonBytes({ committed: true, cleanup_authorized: false }), { flag: 'wx' }));
    return await withCommittedGraph(await withTopicHints(resultFor(journal), plan, planRecord), ctx.root);
  } catch (error) {
    if (journal && !committed) {
      const marker = journal.inventory.find(row => row.kind === 'commit');
      try { committed = Boolean(marker && await ownedPostimage(ctx, marker)); } catch { /* Do not infer a commit from unreadable bytes. */ }
    }
    if (committed || journal?.state === 'committed') {
      return await withCommittedGraph(await withTopicHints({ ...resultFor({ ...journal, state: 'committed' }), cleanup_warnings: [{ code: error.code ?? error.message }] }, plan, planRecord), ctx.root);
    }
    if (journal && lock) {
      try { error.recovery = await rollback(ctx, journal, lock); }
      catch (recoveryError) { error.recovery = { status: 'recovery_blocked', code: recoveryError.code ?? recoveryError.message }; }
    }
    throw error;
  } finally {
    if (lock) {
      try { await releaseLock(ctx, lock); }
      catch { /* Lost/changed locks are retained; never remove another owner. */ }
    }
  }
}

async function recoverUnstartedRegistration(ctx, run, options) {
  const loaded = await loadBilingualPublication({ vaultRoot: ctx.root, run, requireApproval: true, trustAnchor: options.trustAnchor });
  const record = plans.get(loaded.plan);
  if (record.transactionId !== ctx.transactionId) fail('P22_TRANSACTION_NOT_REGISTERED');
  await authorityFromBinding(loaded.authority, loaded.plan, {
    approvalRecord: options.approvalRecord ?? loaded.authority.approval_record.path,
    maintenanceWindowRecord: options.maintenanceWindowRecord ?? loaded.authority.maintenance_window_record.path,
  }, { recovery: true });
  // With no durable journal, no target replacement was permitted. Verify that
  // invariant from actual disk before writing a recovery decision.
  await checkPreimages(ctx.root, loaded.plan);
  const lock = await acquireLock(ctx, hash(loaded.authority), { recover: true });
  try {
    const journal = journalFromPlan(loaded.plan, ctx.transactionId, loaded.authority, record.controllerGrant);
    await ensureDirectories(ctx, CONTROL + '/transactions/' + ctx.transactionId);
    await saveJournal(ctx, journal, lock, 'registered_unstarted_recovery');
    await rollback(ctx, journal, lock);
    return resultFor(journal);
  } finally { await releaseLock(ctx, lock); }
}

/** Disk-only recovery; no promoted[] state from the failed process is required. */
export async function recoverBilingualPublication({ vaultRoot, run, transactionId, ...options } = {}) {
  if (!identifier(run) || !identifier(transactionId)) fail('P22_RECOVERY_ID_REQUIRED');
  const rootInfo = await rootState(vaultRoot), ctx = runtime(rootInfo.root, transactionId, options);
  const path = CONTROL + '/transactions/' + transactionId + '/journal.json';
  const stored = await observe(ctx.root, path);
  if (!stored.exists) return recoverUnstartedRegistration(ctx, run, options);
  const journal = JSON.parse(stored.bytes); checkJournal(journal);
  if (journal.transaction_id !== transactionId || journal.run_id !== run || journal.vault_root !== ctx.root
    || !sameIdentity(journal.root_identity, rootInfo.identity) || hash(journal.authority) !== journal.authority_hash) fail('P22_TRANSACTION_BINDING_INVALID');
  const planShape = { ...journal, inventory: journal.inventory };
  const reconstructedPlan = { kind: 'phase22-publication-plan', vault_root: journal.vault_root, root_identity: journal.root_identity,
    run_id: journal.run_id, analysis_revision: journal.analysis_revision, evidence_mode: journal.evidence_mode,
    generation: journal.generation, previous_generation: journal.previous_generation, hashes: journal.hashes,
    inventory: journal.prepared_inventory.map(row => ({ ...row, observed_sha256: row.byte_sha256 })), read_dependencies: journal.read_dependencies };
  verifyControllerGrant(journal.controller_grant, ctx.root, run, options.trustAnchor);
  const grantPayload = journal.controller_grant.payload;
  if (grantPayload.kind !== 'publication' || grantPayload.plan_fingerprint !== hash(reconstructedPlan)
    || grantPayload.binding_hash !== journal.authority_hash || grantPayload.output_inventory_hash !== journal.hashes.output_inventory_hash) fail('P22_CONTROLLER_GRANT_INVALID');
  await authorityFromBinding(journal.authority, planShape, {
    approvalRecord: options.approvalRecord ?? journal.authority.approval_record.path,
    maintenanceWindowRecord: options.maintenanceWindowRecord ?? journal.authority.maintenance_window_record.path,
  }, { recovery: true });
  const lock = await acquireLock(ctx, journal.authority_hash, { recover: true });
  try {
    const commit = journal.inventory.find(row => row.kind === 'commit');
    const observed = await observe(ctx.root, PHASE22_COMMIT_PATH, { allowLinks: true });
    const markerMatches = commit && matchingBytes(observed, commit.byte_sha256, commit.byte_length);
    if (journal.state === 'committed' || markerMatches) {
      journal.state = 'committed';
      // A commit may have died before releasing its staging hardlink.
      if (markerMatches) {
        const stage = await observe(ctx.root, commit.stage_path, { allowLinks: true });
        if (stage.exists && sameIdentity(stage.identity, observed.identity) && observed.nlink === 2) {
          await ctx.operation('stage.unlink', commit.stage_path, () => unlink(join(ctx.root, commit.stage_path)));
        }
      }
      await saveJournal(ctx, journal, lock, 'committed_recovery_retained');
    } else if (journal.state !== 'rolled_back') {
      await rollback(ctx, journal, lock);
    }
    return await withCommittedGraph(resultFor(journal), ctx.root);
  } finally {
    await releaseLock(ctx, lock);
  }
}

/** Capture only registered source/role/tool files, never a scan or copy of a paper corpus. */
function fileBinding(path) {
  path = resolve(path);
  const root = realpathSync(dirname(path)), stat = lstatSync(path, { bigint: true });
  if (root !== dirname(path) || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || realpathSync(path) !== path) fail('P22_REGISTERED_FILE_INVALID', { path });
  const fd = openSync(path, 'r'), streamHash = createHash('sha256');
  let count = 0;
  try {
    const before = fstatSync(fd, { bigint: true }), buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) { const size = readSync(fd, buffer, 0, buffer.length, null); if (!size) break; streamHash.update(buffer.subarray(0, size)); count += size; }
    const after = fstatSync(fd, { bigint: true });
    if (!sameIdentity(identity(before), identity(after)) || before.size !== after.size || before.mtimeNs !== after.mtimeNs) fail('P22_REGISTERED_FILE_CHANGED', { path });
  } finally { closeSync(fd); }
  return { path, sha256: 'sha256:' + streamHash.digest('hex'), byte_length: count, identity: identity(stat) };
}
function assertFileBindings(bindings) {
  for (const expected of bindings) {
    const current = fileBinding(expected.path);
    if (!same(current, expected)) fail('P22_REGISTERED_DEPENDENCY_CHANGED', { path: expected.path });
  }
}
function captureSourceBindings(sourceInputs, review) {
  const { basis, context, views, parity, currentControl, integratorReceipt, languageRunControl, languageController } = sourceInputs ?? {};
  assertReadingBasisCurrent(basis);
  assertFrozenRenderContext(context, basis);
  assertBilingualParity(parity, { basis, context, views });
  const runtimeSnapshot = snapshotPhase22Runtime(languageController);
  if (basis.basis_fingerprint !== review.reviewManifest.basis_fingerprint || context.context_fingerprint !== review.reviewManifest.context_fingerprint
    || parity.parity_fingerprint !== review.reviewManifest.parity_fingerprint || runtimeSnapshot.evidence_mode !== review.reviewManifest.evidence_mode
    || runtimeSnapshot.dependencies.basis !== basis.basis_fingerprint || runtimeSnapshot.dependencies.context !== context.context_fingerprint
    || runtimeSnapshot.input_artifact_root !== realpathSync(currentControl.artifactRoot)
    || runtimeSnapshot.artifact_root !== realpathSync(languageRunControl.artifactRoot)) fail('P22_REGISTERED_INPUT_MISMATCH');
  const sourceControl = getRunControlForDispatch({ dispatchContext: currentControl.dispatchContext, runId: currentControl.run.run_id });
  const contextControl = getRunControlForDispatch(integratorReceipt)?.phase22_context_binding;
  const languageControl = getRunControlForDispatch({ dispatchContext: languageRunControl.dispatchContext, runId: languageRunControl.runId })?.phase22_language_binding;
  if (!sourceControl || !contextControl || !languageControl || hash(languageControl) !== runtimeSnapshot.binding_fingerprint
    || contextControl.artifact_id !== context.integrator_binding.artifact_id || contextControl.payload_sha256 !== context.integrator_binding.sha256) fail('P22_REGISTERED_CONTROL_REQUIRED');
  const files = new Map();
  const add = path => { const binding = fileBinding(path); files.set(binding.path, binding); return binding; };
  const addReceipt = (root, artifactId, expected) => {
    const path = join(root, '.phase21-receipts', encodeURIComponent(artifactId) + '.json');
    add(path);
    const receipt = JSON.parse(readFileSync(path, 'utf8'));
    if (expected && !Object.keys(expected).every(key => same(receipt[key], expected[key]))) fail('P22_REGISTERED_RECEIPT_MISMATCH', { artifactId });
    safeRelative(receipt.path);
    const file = add(join(root, receipt.path));
    if (file.sha256 !== receipt.sha256 || file.byte_length !== receipt.byte_length) fail('P22_REGISTERED_RECEIPT_MISMATCH', { artifactId });
    return receipt;
  };
  const registry = currentControl.registry;
  if (!registry || !Array.isArray(currentControl.run.receipts)
    || currentControl.run.receipts.some(receipt => !same(registry[receipt.artifact_id], receipt))) fail('P22_REGISTERED_SOURCE_REGISTRY_REQUIRED');
  for (const ref of [basis.producer_ref, basis.scientific_input_ref, basis.parser_evaluation_disposition.details_ref]) {
    if (!registry[ref.artifact_id] || registry[ref.artifact_id].sha256 !== ref.physical_sha256) fail('P22_REGISTERED_SOURCE_REGISTRY_REQUIRED');
  }
  for (const receipt of Object.values(registry)) addReceipt(currentControl.artifactRoot, receipt.artifact_id, receipt);
  addReceipt(integratorReceipt.artifactRoot, integratorReceipt.artifactId, context.integrator_binding);
  for (const seed of Object.values(languageControl.revision_seeds ?? {})) {
    addReceipt(languageRunControl.artifactRoot, seed.receipt.artifact_id, seed.receipt);
  }
  const tasks = [...Object.values(languageControl.task_bindings), ...(languageControl.revision_bindings ?? []).map(row => row.task)];
  for (const [language, taskId] of Object.entries(runtimeSnapshot.active_task_ids)) {
    const task = tasks.find(row => row.task_id === taskId), observed = runtimeSnapshot.tasks.find(row => row.task_id === taskId);
    if (!task || observed?.status !== 'completed') fail('P22_REGISTERED_LANGUAGE_INCOMPLETE', { taskId });
    const expected = language === 'verifier' ? parity.semantic_review_receipt : getAcceptedLanguageRecord(views[language]).receipt;
    const receipt = addReceipt(languageRunControl.artifactRoot, task.artifact_id,
      { artifact_id: expected.artifact_id, owner_actor_id: expected.owner_actor_id, role: expected.role, path: expected.path, revision: expected.revision, sha256: expected.sha256 });
    safeRelative(task.native_path);
    if (add(join(languageRunControl.artifactRoot, task.native_path)).sha256 !== receipt.sha256) fail('P22_REGISTERED_NATIVE_BYTES_MISMATCH');
  }
  if (context.invalidation_dependencies.committed_support) {
    const roots = new Set(context.entityMappings.filter(row => row.disposition === 'reuse').map(row => {
      const original = sourceInputs.entityMappings?.find(item => item.entity_id === row.entity_id);
      return original?.existing_support?.vault_root;
    }).filter(Boolean));
    // Runtime context may pin the previous marker; the publication plan also
    // binds that exact preimage. It is checked by the existing CAS at apply.
    if (roots.size > 1) fail('P22_REGISTERED_REUSE_ROOT_MISMATCH');
  }
  const toolFiles = [
    'phase22-publication.mjs', 'phase22-review.mjs', 'phase22-render.mjs', 'phase22-managed-markdown.mjs',
    'phase22-active-version.mjs', 'phase22-search.mjs', 'phase22-graph.mjs', 'phase22-input.mjs',
    'phase22-render-context.mjs', 'phase22-language.mjs', 'phase22-parity.mjs', 'phase22-contract-loader.mjs',
    'owned-artifact-store.mjs', 'semantic-package-validator.mjs',
  ].map(name => fileURLToPath(new URL('./' + name, import.meta.url)));
  const toolBindings = toolFiles.map(fileBinding);
  for (const name of ['reading-basis', 'render-context', 'language-view', 'parity-review', 'review-manifest', 'publication-transaction', 'active-index']) {
    toolBindings.push(fileBinding(fileURLToPath(new URL('../../Schema/phase22/' + name + '.schema.json', import.meta.url))));
  }
  toolBindings.push(fileBinding(fileURLToPath(new URL('../../prompts/v3/phase22-language-contracts.md', import.meta.url))));
  return { source_bindings: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)), tool_bindings: toolBindings,
    control_snapshot: { source: clone(sourceControl), integrator: clone(contextControl), language: clone(languageControl), runtime: clone(runtimeSnapshot) } };
}
// Only older registrations replay their frozen producer inputs.
function restoreRecipeData(value) {
  if (value && typeof value === 'object' && Object.keys(value).length === 1 && typeof value.reader_bytes_base64 === 'string') {
    const bytes = Buffer.from(value.reader_bytes_base64, 'base64');
    if (bytes.toString('base64') !== value.reader_bytes_base64) fail('P221_REGISTRATION_RECIPE_INVALID');
    return bytes;
  }
  if (Array.isArray(value)) return value.map(restoreRecipeData);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, restoreRecipeData(v)]));
  return value;
}
async function assertReaderPresentationPlan(proof, renderer, context, views) {
  if (!proof) return;
  const { readOwnedArtifact } = await import('./owned-artifact-store.mjs');
  const owned = await readOwnedArtifact({ artifactRoot: proof.artifactRoot, artifactId: proof.artifactId });
  if (!owned || owned.receipt.role !== 'integration' || owned.receipt.sha256 !== proof.sha256) fail('P221_PRESENTATION_OWNED_MAPPING_REQUIRED');
  const value = JSON.parse(owned.bytes), plan = value.presentation_plan, options = renderer.presentationOptions;
  if (!plan || !same(plan, { researchMap: options?.researchMap, sharedExplanations: options?.sharedExplanations, auditDisplay: options?.auditDisplay })) fail('P221_PRESENTATION_MAPPING_CHANGED');
  if (context && (value.dependencies?.context !== context.context_fingerprint || value.presentation_dependencies?.context !== hash(context)
    || value.presentation_dependencies?.target_registry !== hash(renderer.targetRegistry)
    || !same(value.dependencies?.views, Object.fromEntries(Object.entries(views).map(([language, view]) => [language, hash(view)]))))) fail('P221_PRESENTATION_MAPPING_DEPENDENCY_CHANGED');
}
async function captureReaderBindings(sourceInputs, review) {
  const { basis, context, currentControl, integratorReceipt, reader } = sourceInputs ?? {};
  if (!reader?.renderer || !reader.runtime?.runControl || !reader.runtime.checkpointReceipt || !reader.ownedReview || !reader.review) fail('P221_REGISTRATION_RECIPE_REQUIRED');
  assertReadingBasisCurrent(basis); assertFrozenRenderContext(context, basis);
  const source = getRunControlForDispatch({ dispatchContext: currentControl?.dispatchContext, runId: currentControl?.run?.run_id });
  const integrator = getRunControlForDispatch(integratorReceipt)?.phase22_context_binding;
  const runtimeControl = getRunControlForDispatch({ dispatchContext: reader.runtime.runControl.dispatchContext, runId: reader.runtime.runControl.runId });
  if (!source || !integrator || !runtimeControl?.phase22_runtime_checkpoint_binding || runtimeControl.phase22_language_binding?.mode !== 'reader') fail('P221_REGISTRATION_CONTROL_REQUIRED');
  const files = new Map(), add = path => { const row = fileBinding(path); files.set(row.path, row); return row; };
  const owned = (root, artifactId, expected) => {
    const receiptPath = join(root, '.phase21-receipts', encodeURIComponent(artifactId) + '.json'); add(receiptPath);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')); safeRelative(receipt.path);
    const artifact = add(join(root, receipt.path));
    if (receipt.artifact_id !== artifactId || receipt.sha256 !== artifact.sha256 || receipt.byte_length !== artifact.byte_length
      || (expected && !Object.keys(expected).every(key => same(receipt[key], expected[key])))) fail('P22_REGISTERED_RECEIPT_MISMATCH', { artifactId });
    return receipt;
  };
  for (const receipt of Object.values(currentControl.registry ?? {})) {
    const observed = owned(currentControl.artifactRoot, receipt.artifact_id);
    if (!same(observed, receipt)) fail('P22_REGISTERED_SOURCE_REGISTRY_REQUIRED');
  }
  owned(integratorReceipt.artifactRoot, integratorReceipt.artifactId);
  const sourcePresentation = currentControl.presentationControl ? getRunControlForDispatch(currentControl.presentationControl)?.phase22_source_presentation_binding : null;
  if (sourcePresentation) {
    owned(currentControl.artifactRoot, sourcePresentation.manifest_artifact_id);
    for (const asset of sourcePresentation.asset_bindings) owned(currentControl.artifactRoot, asset.artifact_id);
  }
  const language = runtimeControl.phase22_language_binding;
  if (hash(reader.runtime.readerInput) !== language.reader_input_fingerprint) fail('P221_READER_INPUT_BINDING_INVALID');
  if (reader.runtime.readerInput?.reviewed_support) {
    const { admitReviewedSupport, getReviewedSupportContent, getReviewedSupportBindings } = await import('./phase221-reviewed-support.mjs');
    const support = await admitReviewedSupport({ basis, descriptor: reader.runtime.readerInput.reviewed_support });
    if (getReviewedSupportContent(support).support_fingerprint !== language.reviewed_support_fingerprint) fail('P221_REVIEWED_SUPPORT_BINDING_INVALID');
    for (const binding of getReviewedSupportBindings(support)) add(binding.path);
  }
  owned(reader.runtime.runControl.artifactRoot, runtimeControl.phase22_runtime_checkpoint_binding.artifact_id, runtimeControl.phase22_runtime_checkpoint_binding);
  const snapshot = JSON.parse(readFileSync(join(reader.runtime.runControl.artifactRoot, runtimeControl.phase22_runtime_checkpoint_binding.path), 'utf8'));
  const tasks = [...Object.values(language.task_bindings), ...(language.revision_bindings ?? []).map(row => row.task)];
  for (const task of tasks) {
    if (snapshot.tasks.some(row => row.task_id === task.task_id && row.adoption)) continue;
    if (snapshot.tasks.some(row => row.task_id === task.task_id && row.status === 'completed')) {
      owned(reader.runtime.runControl.artifactRoot, task.artifact_id); safeRelative(task.native_path); add(join(reader.runtime.runControl.artifactRoot, task.native_path));
    }
    if (task.payload && snapshot.tasks.some(row => row.task_id === task.task_id)) owned(reader.runtime.runControl.artifactRoot, task.payload.artifact_id);
  }
  for (const seed of Object.values(language.revision_seeds ?? {})) owned(reader.runtime.runControl.artifactRoot, seed.receipt.artifact_id);
  if (language.consumption_contract) {
    const receipt = owned(reader.runtime.runControl.artifactRoot, language.consumption_contract.artifact_id);
    const contract = JSON.parse(readFileSync(join(reader.runtime.runControl.artifactRoot, receipt.path), 'utf8'));
    for (const ref of [contract.disposition_source, contract.span_source]) owned(reader.runtime.runControl.artifactRoot, ref.artifact_id);
  }
  const { quantityEquivalence, ...presentationOptions } = reader.renderer.presentationOptions ?? {};
  if (quantityEquivalence && !reader.quantityProofReceipt) fail('P221_QUANTITY_RESTORE_RECEIPT_REQUIRED');
  const rendererRecipe = { ...reader.renderer, presentationOptions };
  let presentationPlanProof = null;
  if (reader.presentationPlanReceipt) {
    const reference = reader.presentationPlanReceipt, receipt = owned(reference.artifactRoot, reference.artifactId);
    presentationPlanProof = { artifactRoot: reference.artifactRoot, artifactId: reference.artifactId, sha256: receipt.sha256 };
    await assertReaderPresentationPlan(presentationPlanProof, rendererRecipe);
  }
  const { getReaderReviewSourceBindings } = await import('./phase22-review.mjs');
  const evidence = await getReaderReviewSourceBindings(review, reader.renderer, reader);
  if (evidence.quantityProof) {
    const supplied = reader.quantityProofReceipt, actual = evidence.quantityProof;
    if (!supplied || ['artifactRoot', 'runId', 'artifactId'].some(key => supplied[key] !== actual[key])) fail('P221_QUANTITY_RESTORE_RECEIPT_REQUIRED');
    if (owned(actual.artifactRoot, actual.artifactId).sha256 !== actual.sha256) fail('P22_REGISTERED_RECEIPT_MISMATCH');
  } else if (reader.quantityProofReceipt) fail('P221_QUANTITY_RESTORE_RECEIPT_REQUIRED');
  owned(evidence.reviewReceipt.artifactRoot, evidence.reviewReceipt.artifactId);
  if (evidence.nativeReceipt) owned(evidence.nativeReceipt.artifactRoot, evidence.nativeReceipt.artifactId);
  for (const binding of evidence.bindings) {
    const observed = fileBinding(binding.path);
    if (observed.sha256 !== binding.sha256 || (binding.byte_length !== undefined && observed.byte_length !== binding.byte_length)) fail('P22_REGISTERED_DEPENDENCY_CHANGED', { path: binding.path });
    files.set(observed.path, observed);
  }
  if (reader.historical) {
    const { readHistoricalReaderInput } = await import('./phase221-historical-input.mjs');
    const historical = await readHistoricalReaderInput(reader.historical);
    for (const row of [...historical.source_bindings, historical.registration.pointer, historical.registration.bundle]) add(row.path);
  }
  for (const row of reader.preparation?.sourceInventory ?? []) {
    add(row.source_binding.path); for (const asset of row.available_assets ?? []) add(asset.path);
  }
  const toolNames = ['phase22-publication.mjs', 'phase22-review.mjs', 'phase22-render.mjs', 'phase22-managed-markdown.mjs',
    'phase22-active-version.mjs', 'phase22-search.mjs', 'phase22-graph.mjs', 'phase22-input.mjs', 'phase22-render-context.mjs',
    'phase22-language.mjs', 'phase22-parity.mjs', 'phase22-contract-loader.mjs', 'phase21-contract-loader.mjs', 'owned-artifact-store.mjs',
    'semantic-package-validator.mjs', 'phase221-historical-input.mjs', 'phase221-presentation.mjs', 'phase221-reading-review.mjs',
    'phase221-targets.mjs', 'phase221-display.mjs', 'phase221-visuals.mjs', 'phase221-source-assets.mjs'];
  if (reader.renderer.presentationOptions?.researchMap !== undefined) toolNames.push('phase221-research-map.mjs');
  if (reader.runtime.readerInput?.reviewed_support) toolNames.push('phase221-reviewed-support.mjs');
  const toolBindings = toolNames.map(name => fileBinding(fileURLToPath(new URL('./' + name, import.meta.url))));
  if (reader.renderer.presentationOptions?.localStyle === true) toolBindings.push(fileBinding(fileURLToPath(new URL('../../Templates/apa-v3/apa-readable.css', import.meta.url))));
  for (const name of ['reading-basis', 'render-context', 'language-view', 'parity-review', 'review-manifest', 'publication-transaction', 'active-index', 'reader-presentation', 'reading-review']) {
    const path = fileURLToPath(new URL('../../Schema/phase22/' + name + '.schema.json', import.meta.url));
    toolBindings.push(fileBinding(path));
  }
  toolBindings.push(fileBinding(fileURLToPath(new URL('../../Schema/phase21/proof-chain.schema.json', import.meta.url))));
  for (const name of ['phase22-language-contracts.md', 'phase221-reading-contracts.md']) toolBindings.push(fileBinding(fileURLToPath(new URL('../../prompts/v3/' + name, import.meta.url))));
  const options = rendererRecipe.presentationOptions ?? {};
  return { source_bindings: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)), tool_bindings: toolBindings,
    control_snapshot: { source: clone(source), integrator: clone(integrator), language: clone(language), runtime: snapshot },
    reader_evidence: { runtimeBinding: clone(runtimeControl), renderer: { targetRegistry: clone(rendererRecipe.targetRegistry),
      presentationOptions: { ...(options.researchMap === undefined ? {} : { researchMap: clone(options.researchMap) }),
        ...(options.sharedExplanations === undefined ? {} : { sharedExplanations: clone(options.sharedExplanations) }),
        ...(options.auditDisplay === undefined ? {} : { auditDisplay: clone(options.auditDisplay) }) } },
      presentationPlanProof } };
}
async function rebuildRegisteredReader(encoded, onAdoptedBindings) {
  const recipe = restoreRecipeData(encoded);
  if (recipe?.schema_version !== 'phase221-reader-registration-recipe-1.0') fail('P221_REGISTRATION_RECIPE_INVALID');
  const { createPhase21ContractValidator } = await import('./phase21-contract-loader.mjs');
  const { createPhase22ContractValidator } = await import('./phase22-contract-loader.mjs');
  const { consumePhase21Handoff } = await import('./phase22-input.mjs');
  const { freezeRenderContext } = await import('./phase22-render-context.mjs');
  const { readOwnedArtifact } = await import('./owned-artifact-store.mjs');
  const { restorePhase22Runtime } = await import('./phase22-language.mjs');
  const { assessReaderBilingualParity } = await import('./phase22-parity.mjs');
  const { renderReaderNotes } = await import('./phase221-presentation.mjs');
  const { prepareReaderReview, assessReaderReview, acceptReaderNativeObservation } = await import('./phase221-reading-review.mjs');
  const { buildBilingualReview } = await import('./phase22-review.mjs');
  const sourceBroker = createOwnedArtifactBroker({ control_actor_id: 'registered-reader-source-controller', artifact_root: recipe.source.control.artifactRoot,
    authorized_bindings: [], run_controls: [recipe.source.binding] });
  const currentControl = { ...recipe.source.control, dispatchContext: sourceBroker.dispatchContext, proofChain: recipe.source.control.run.chain };
  if (recipe.source.presentation_binding) {
    const p = recipe.source.presentation_binding;
    const broker = createOwnedArtifactBroker({ control_actor_id: 'registered-reader-presentation-controller', artifact_root: currentControl.artifactRoot,
      authorized_bindings: [], run_controls: [{ run_id: currentControl.run.run_id, phase22_source_presentation_binding: p }] });
    currentControl.presentationControl = { dispatchContext: broker.dispatchContext, runId: currentControl.run.run_id, artifactId: p.manifest_artifact_id };
  }
  const validator = await createPhase22ContractValidator();
  const handoff = JSON.parse((await readOwnedArtifact({ artifactRoot: currentControl.artifactRoot, artifactId: currentControl.producer_artifact_id })).bytes);
  const admitted = await consumePhase21Handoff({ handoff, currentControl,
    artifactResolver: artifactId => readOwnedArtifact({ artifactRoot: currentControl.artifactRoot, artifactId }),
    phase21Validator: await createPhase21ContractValidator({ schemas: [JSON.parse(await readFile(new URL('../../Schema/phase21/proof-chain.schema.json', import.meta.url), 'utf8'))] }), phase22Validator: validator });
  if (!admitted.ok) fail('P221_REGISTERED_SOURCE_REJECTED', { errors: admitted.errors });
  const basis = admitted.basis;
  const integratorBroker = createOwnedArtifactBroker({ control_actor_id: 'registered-reader-integrator-controller', artifact_root: recipe.integrator.receipt.artifactRoot,
    authorized_bindings: [], run_controls: [{ run_id: basis.identity.run_id, phase22_context_binding: recipe.integrator.binding }] });
  const integratorReceipt = { ...recipe.integrator.receipt, dispatchContext: integratorBroker.dispatchContext };
  const integration = JSON.parse((await readOwnedArtifact({ artifactRoot: integratorReceipt.artifactRoot, artifactId: integratorReceipt.artifactId })).bytes);
  let committedSnapshot;
  const reuseRoots = [...new Set(integration.entity_mappings.filter(row => row.existing_support?.vault_root).map(row => row.existing_support.vault_root))];
  if (reuseRoots.length > 1) fail('P22_REGISTERED_REUSE_ROOT_MISMATCH');
  if (reuseRoots.length) { committedSnapshot = await readCommittedGeneration({ vaultRoot: reuseRoots[0] }); if (!committedSnapshot.ok) fail('P22_REGISTERED_REUSE_ROOT_MISMATCH'); }
  const frozen = freezeRenderContext({ basis, termCandidates: integration.term_candidates, entityMappings: integration.entity_mappings, integratorReceipt, validator, committedSnapshot });
  if (!frozen.ok) fail('P221_REGISTERED_CONTEXT_REJECTED', { errors: frozen.errors });
  const context = frozen.context, rt = recipe.runtime;
  const runtimeBroker = createOwnedArtifactBroker({ control_actor_id: rt.binding.phase22_language_binding.controller_actor_id, artifact_root: rt.runControl.artifactRoot,
    authorized_bindings: [], run_controls: [rt.binding] });
  const runControl = { ...rt.runControl, dispatchContext: runtimeBroker.dispatchContext, validator };
  const rebind = receipt => ({ ...receipt, dispatchContext: runtimeBroker.dispatchContext });
  let historical;
  if (recipe.historical) historical = await (await import('./phase221-historical-input.mjs')).readHistoricalReaderInput(recipe.historical);
  if (!['reader', 'historical'].includes(recipe.renderer.input_mode)) fail('P221_REGISTRATION_RECIPE_INVALID');
  if (recipe.renderer.input_mode === 'historical' && !historical) fail('P221_REGISTRATION_RECIPE_REQUIRED');
  let presentation, prepared;
  const restored = await restorePhase22Runtime({ mode: 'reader', readerInput: rt.readerInput, basis, context, runControl,
    checkpointReceipt: rebind(rt.checkpointReceipt), restoreReaderReview: async ({ views, verifier_request }) => {
      const tasks = [...Object.values(rt.binding.phase22_language_binding.task_bindings), ...(rt.binding.phase22_language_binding.revision_bindings ?? []).map(row => row.task)];
      const task = tasks.find(row => row.task_id === verifier_request.task_id);
      const owned = await readOwnedArtifact({ artifactRoot: runControl.artifactRoot, artifactId: task.artifact_id });
      const checkpoint = JSON.parse((await readOwnedArtifact({ artifactRoot: runControl.artifactRoot, artifactId: rt.checkpointReceipt.artifactId })).bytes);
      const state = checkpoint.tasks.find(row => row.task_id === task.task_id);
      const receipt = { artifactRoot: runControl.artifactRoot, dispatchContext: runtimeBroker.dispatchContext, runId: runControl.runId, artifactId: task.artifact_id,
        task_id: task.task_id, call_id: state.call_id, return_id: state.return_id };
      const parity = await assessReaderBilingualParity({ basis, context, views, semanticReview: JSON.parse(owned.bytes),
        receipts: { verifier: { request: verifier_request, receipt } }, currentDependencies: verifier_request.dependencies });
      if (!parity.ok) fail('P221_REGISTERED_PARITY_REJECTED', { errors: parity.errors });
      const input = recipe.renderer.input_mode === 'historical' ? historical : { basis, context, views, parity, mode: 'reader', ...(historical ? { historicalSourceInput: historical } : {}) };
      const { input_mode, ...renderer } = recipe.renderer;
      await assertReaderPresentationPlan(recipe.presentationPlanProof, renderer, context, views);
      if (recipe.quantityProof) {
        const broker = createOwnedArtifactBroker({ control_actor_id: 'registered-reader-quantity-controller', artifact_root: recipe.quantityProof.receipt.artifactRoot,
          authorized_bindings: [], run_controls: [recipe.quantityProof.binding] });
        const { acceptReaderQuantityEquivalence } = await import('./phase221-display.mjs');
        const quantityEquivalence = await acceptReaderQuantityEquivalence({ input, integratorReceipt: { ...recipe.quantityProof.receipt, dispatchContext: broker.dispatchContext } });
        renderer.presentationOptions = { ...renderer.presentationOptions, quantityEquivalence };
      }
      presentation = await renderReaderNotes({ input, ...renderer });
      prepared = await prepareReaderReview({ presentation, ...recipe.preparation });
      return prepared;
    } });
  if (!restored.ok || !prepared) fail('P221_REGISTERED_RUNTIME_REJECTED', { errors: restored.errors });
  if (onAdoptedBindings) {
    const { getAcceptedReaderLanguageRecord } = await import('./phase22-language.mjs');
    onAdoptedBindings(Object.values(restored.views).flatMap(view => getAcceptedReaderLanguageRecord(view).physical_bindings ?? []));
  }
  const owned = await readOwnedArtifact({ artifactRoot: recipe.ownedReview.receipt.artifactRoot, artifactId: recipe.ownedReview.receipt.artifactId });
  const value = JSON.parse(owned.bytes), request = restored.verifier_request;
  if (request.request_fingerprint !== recipe.ownedReview.request_fingerprint || hash(value) !== recipe.ownedReview.value_fingerprint) fail('P221_REGISTERED_REVIEW_CHANGED');
  let nativeObservation;
  if (recipe.native) {
    const broker = createOwnedArtifactBroker({ control_actor_id: 'registered-reader-native-controller', artifact_root: recipe.native.receipt.artifactRoot,
      authorized_bindings: [], run_controls: [recipe.native.binding] });
    nativeObservation = await acceptReaderNativeObservation({ prepared, observationReceipt: { ...recipe.native.receipt, dispatchContext: broker.dispatchContext } });
  }
  const assessed = await assessReaderReview({ prepared, ownedReview: { request, receipt: rebind(recipe.ownedReview.receipt), value, currentDependencies: request.dependencies },
    ...(nativeObservation ? { nativeObservation } : {}) });
  if (!assessed.ok) fail('P221_REGISTERED_REVIEW_REJECTED', { errors: assessed.errors });
  return buildBilingualReview({ presentation, readingReview: { prepared, review: assessed.review }, ...recipe.review });
}
async function writeRegisteredRecord(ctx, path, bytes, { replace = false } = {}) {
  const before = await observe(ctx.root, path);
  if (before.exists && before.bytes.equals(bytes)) return;
  if (before.exists && !replace) fail('P22_REGISTERED_RECORD_EXISTS', { path });
  const staged = path + '.' + randomUUID() + '.writing';
  await durableNew(ctx, staged, bytes, 'registration');
  const current = await observe(ctx.root, path);
  if (current.sha256 !== before.sha256 || (before.exists && !sameIdentity(current.identity, before.identity))) fail('P22_REGISTERED_RECORD_CHANGED', { path });
  if (before.exists) await ctx.operation('registration.rename', path, () => rename(join(ctx.root, staged), join(ctx.root, path)));
  else {
    await ctx.operation('registration.link', path, () => link(join(ctx.root, staged), join(ctx.root, path)));
    await ctx.operation('registration.unlink', staged, () => unlink(join(ctx.root, staged)));
  }
}

async function topicRegistration(vaultRoot, operationId, trustAnchor) {
  const root = (await rootState(vaultRoot)).root;
  const registered = await observe(root, CONTROL + '/runs/' + operationId + '/CURRENT.json');
  if (!registered.exists) fail('P22_RUN_NOT_REGISTERED');
  const pointer = JSON.parse(registered.bytes), { controller_grant: grant, ...body } = pointer;
  const anchor = verifyControllerGrant(grant, root, operationId, trustAnchor);
  if (pointer.schema_version !== 'phase22-publication-registration-1.0' || pointer.vault_root !== root || pointer.run_id !== operationId
    || grant.payload.kind !== 'registration' || grant.payload.registration_hash !== hash(body)
    || !pointer.bundle?.path?.startsWith(CONTROL + '/runs/' + operationId + '/')) fail('P22_REGISTRATION_INVALID');
  const stored = await observe(root, pointer.bundle.path);
  if (!stored.exists || stored.sha256 !== pointer.bundle.sha256) fail('P22_REGISTERED_BUNDLE_CHANGED');
  const bundle = JSON.parse(stored.bytes);
  const candidateFingerprint = bundle.topic_candidate_fingerprint ?? (bundle.topic_recipe?.options?.candidate ? hash(bundle.topic_recipe.options.candidate) : null);
  if (bundle.reviewManifest?.profile !== 'phase24-topic-1.0' || !candidateFingerprint
    || bundle.vault_root !== root || bundle.run_id !== operationId || !identifier(bundle.transaction_id)) fail('P24_CANCELLATION_INPUT_INVALID');
  return { root, pointer, bundle, anchor, candidateFingerprint };
}

function cancellationPayload(registration, operationId, candidateFingerprint) {
  if (candidateFingerprint !== registration.candidateFingerprint) fail('P24_CANDIDATE_CHANGED');
  return { schema_version: 'phase22-controller-grant-1.0', kind: 'topic-cancellation', vault_root: registration.root,
    run_id: operationId, operation_id: operationId, candidate_fingerprint: candidateFingerprint,
    registration_bundle_hash: registration.pointer.bundle.sha256, status: 'cancelled' };
}

/** A signed control revocation is checked by both live and reloaded publication plans. */
export async function assertTopicOperationNotCancelled({ vaultRoot, operationId, candidateFingerprint, trustAnchor } = {}) {
  if (!identifier(operationId)) fail('P24_OPERATION_INVALID');
  const cancelled = await observe(resolve(vaultRoot), CONTROL + '/runs/' + operationId + '/TOPIC-CANCELLED.json');
  if (!cancelled.exists) return;
  const registration = await topicRegistration(vaultRoot, operationId, trustAnchor);
  const value = JSON.parse(cancelled.bytes);
  verifyControllerGrant(value.cancellation_grant, registration.root, operationId, registration.anchor);
  if (value.schema_version !== 'phase24-topic-cancellation-1.0'
    || !same(value.cancellation_grant.payload, cancellationPayload(registration, operationId, candidateFingerprint ?? registration.candidateFingerprint))) fail('P24_CANCELLATION_INPUT_INVALID');
  fail('P24_OPERATION_CANCELLED');
}

/** Only the existing Controller private key can authorize cancellation of its registered topic. */
export async function createTopicCancellationGrant({ plan, candidateFingerprint } = {}) {
  const record = plans.get(plan);
  if (!record) fail('P22_PUBLICATION_PLAN_NOT_OWNED');
  const pair = controllerKey(plan.vault_root, plan.run_id, false);
  if (!pair) fail('P24_CANCELLATION_AUTHORITY_REQUIRED');
  await currentPlan(plan);
  const registration = await topicRegistration(plan.vault_root, plan.run_id, record.trustAnchor);
  if (registration.anchor.public_key !== pair.publicDer.toString('base64')
    || registration.bundle.plan_fingerprint !== planStamp(plan)) fail('P24_CANCELLATION_AUTHORITY_REQUIRED');
  return signControllerGrant(cancellationPayload(registration, plan.run_id, candidateFingerprint));
}

/** The unregistered candidate path shares the publication lock and exact attempt/journal addressing. */
export async function cancelUnregisteredTopicOperation({ vaultRoot, operationId, candidateFingerprint, candidatePath, trustAnchor } = {}) {
  if (!identifier(operationId) || !/^sha256:[a-f0-9]{64}$/.test(candidateFingerprint ?? '')) fail('P24_CANCELLATION_INPUT_INVALID');
  if (typeof candidatePath !== 'string' || !candidatePath.trim()) fail('P24_CANDIDATE_PATH_REQUIRED');
  const root = (await rootState(vaultRoot)).root, config = loadApaConfig({ repoRoot: root });
  const configured = config.config.paths?.candidates;
  if (typeof configured !== 'string' || !configured.trim()) fail('P24_CANDIDATES_REQUIRED');
  const candidates = resolve(root, configured), candidateAbsolute = resolve(candidatePath);
  if (!inside(root, candidates) || candidates === root || !inside(candidates, candidateAbsolute) || candidates === candidateAbsolute
    || /^(?:Raw|Wiki|Figures|Clippings|Schema|Ontology|\.git|\.obsidian)(?:[\\/]|$)/i.test(relative(root, candidates))) fail('P24_CANDIDATE_PATH_INVALID');
  const path = relative(root, candidateAbsolute).split(sep).join('/');
  const statePath = relative(root, join(dirname(candidateAbsolute), 'operation.json')).split(sep).join('/');
  const ctx = runtime(root, 'cancellation-' + randomUUID());
  let lock;
  try {
    try { lock = await acquireLock(ctx, hash({ operationId, candidateFingerprint })); }
    catch (error) { if (error.code === 'P22_VAULT_LOCKED') fail('P24_OPERATION_IN_PROGRESS', error.details); throw error; }
    // Registration may have appeared after the library entry point selected this branch.
    if ((await observe(root, CONTROL + '/runs/' + operationId + '/CURRENT.json')).exists) fail('P24_CANCELLATION_AUTHORITY_REQUIRED');
    const candidateFile = await observe(root, path), candidate = JSON.parse(candidateFile.bytes);
    const stateFile = await observe(root, statePath), state = JSON.parse(stateFile.bytes);
    if (candidate.operation_id !== operationId || hash(candidate) !== candidateFingerprint) fail('P24_CANCELLATION_INPUT_INVALID');
    if (state.schema_version !== 'phase24-topic-operation-1.0' || state.operation_id !== operationId
      || state.candidate_fingerprint !== candidateFingerprint || !['pending', 'cancelled'].includes(state.status)) fail('P24_OPERATION_STATE_INVALID');
    const attempt = await observe(root, CONTROL + '/runs/' + operationId + '/TOPIC-ATTEMPT.json');
    if (attempt.exists) {
      const value = JSON.parse(attempt.bytes), grant = value.controller_grant;
      verifyControllerGrant(grant, root, operationId, trustAnchor);
      const payload = grant.payload;
      if (value.schema_version !== 'phase24-topic-attempt-1.0' || payload.kind !== 'topic-attempt'
        || payload.candidate_fingerprint !== candidateFingerprint || !identifier(payload.generation) || !identifier(payload.transaction_id)) fail('P24_CANCELLATION_INPUT_INVALID');
      const committed = await observe(root, PHASE22_COMMIT_PATH);
      if (committed.exists && JSON.parse(committed.bytes).generation_id === payload.generation) fail('P24_ALREADY_COMMITTED');
      const journal = await observe(root, CONTROL + '/transactions/' + payload.transaction_id + '/journal.json');
      if (journal.exists) {
        const value = JSON.parse(journal.bytes); checkJournal(value);
        if (value.run_id !== operationId || value.generation !== payload.generation || value.transaction_id !== payload.transaction_id) fail('P22_TRANSACTION_BINDING_INVALID');
        if (value.state === 'committed') fail('P24_ALREADY_COMMITTED');
        if (value.events.some(row => row.type === 'promotion_intent') || !['prepared', 'staged', 'rolled_back'].includes(value.state)) fail('P24_OPERATION_IN_PROGRESS');
      }
    }
    await assertLock(ctx, lock);
    await writeRegisteredRecord(ctx, statePath, jsonBytes({ ...state, status: 'cancelled' }), { replace: true });
    return { ok: true, status: 'cancelled', operation_id: operationId, candidate_fingerprint: candidateFingerprint, business_writes: 0 };
  } finally { if (lock) await releaseLock(ctx, lock); }
}

/** Cancel under the original publication lock, without changing any committed business bytes. */
export async function cancelRegisteredTopicOperation({ vaultRoot, operationId, candidateFingerprint, cancellationGrant, trustAnchor } = {}) {
  if (!identifier(operationId)) fail('P24_OPERATION_INVALID');
  const registration = await topicRegistration(vaultRoot, operationId, trustAnchor);
  verifyControllerGrant(cancellationGrant, registration.root, operationId, registration.anchor);
  const expected = cancellationPayload(registration, operationId, candidateFingerprint);
  if (!same(cancellationGrant.payload, expected)) fail('P24_CANCELLATION_INPUT_INVALID');
  const ctx = runtime(registration.root, 'cancellation-' + randomUUID());
  let lock;
  try {
    try { lock = await acquireLock(ctx, hash(cancellationGrant)); }
    catch (error) { if (error.code === 'P22_VAULT_LOCKED') fail('P24_OPERATION_IN_PROGRESS', error.details); throw error; }
    const again = await topicRegistration(vaultRoot, operationId, registration.anchor);
    if (!same(again.pointer, registration.pointer)) fail('P22_REGISTERED_RECORD_CHANGED');
    const path = CONTROL + '/runs/' + operationId + '/TOPIC-CANCELLED.json';
    const prior = await observe(registration.root, path);
    if (prior.exists) {
      const value = JSON.parse(prior.bytes);
      verifyControllerGrant(value.cancellation_grant, registration.root, operationId, registration.anchor);
      if (!same(value.cancellation_grant.payload, expected)) fail('P24_CANCELLATION_INPUT_INVALID');
      return { ok: true, status: 'cancelled', operation_id: operationId, candidate_fingerprint: candidateFingerprint, business_writes: 0 };
    }
    const committed = await observe(registration.root, PHASE22_COMMIT_PATH);
    if (committed.exists && JSON.parse(committed.bytes).generation_id === registration.bundle.plan.generation) fail('P24_ALREADY_COMMITTED');
    const journal = await observe(registration.root, CONTROL + '/transactions/' + registration.bundle.transaction_id + '/journal.json');
    if (journal.exists) {
      const value = JSON.parse(journal.bytes); checkJournal(value);
      if (value.state === 'committed') fail('P24_ALREADY_COMMITTED');
      if (value.events.some(row => row.type === 'promotion_intent') || !['prepared', 'staged', 'rolled_back'].includes(value.state)) fail('P24_OPERATION_IN_PROGRESS');
    }
    await assertLock(ctx, lock);
    await writeRegisteredRecord(ctx, path, jsonBytes({ schema_version: 'phase24-topic-cancellation-1.0', cancellation_grant: cancellationGrant }));
    return { ok: true, status: 'cancelled', operation_id: operationId, candidate_fingerprint: candidateFingerprint, business_writes: 0 };
  } finally { if (lock) await releaseLock(ctx, lock); }
}

/** Controller-only persistence bridge. JSON source text cannot create its live inputs. */
export async function registerBilingualPublication(args = {}) {
  const { plan, sourceInputs } = args, record = await currentPlan(plan);
  if (!record.review || args.run !== plan.run_id || resolve(args.vaultRoot ?? '') !== plan.vault_root) fail('P22_REGISTERED_LIVE_REVIEW_REQUIRED');
  await checkPreimages(plan.vault_root, plan);
  const captured = record.review.reviewManifest.profile === 'phase24-topic-1.0'
    ? await captureTopicPublicationRegistration({ sourceInputs, review: record.review })
    : record.review.reviewManifest.profile === 'reading-first-obsidian-1.0'
    ? await captureReadingFirstPublicationRegistration({ sourceInputs, review: record.review })
    : record.review.reviewManifest.profile === 'phase22-reader-note-1.0'
      ? await captureReaderBindings(sourceInputs, record.review) : captureSourceBindings(sourceInputs, record.review);
  const authority = args.control ? await assertAuthority(args, plan) : null;
  const root = CONTROL + '/runs/' + plan.run_id;
  const versionRoot = root + '/' + plan.hashes.output_inventory_hash.slice(7);
  const ctx = runtime(plan.vault_root, 'registration-' + randomUUID());
  const bundlePath = versionRoot + '/manifest.json';
  const priorBundle = await observe(plan.vault_root, bundlePath);
  const transactionId = args.transactionId ?? (priorBundle.exists ? JSON.parse(priorBundle.bytes).transaction_id : randomUUID());
  if (!identifier(transactionId)) fail('P22_TRANSACTION_ID_INVALID');
  const inventory = [];
  for (const [index, { bytes, ...row }] of plan.inventory.entries()) {
    const outputPath = versionRoot + '/outputs/' + index + '.bin';
    await writeRegisteredRecord(ctx, outputPath, bytes);
    inventory.push({ ...row, output_path: outputPath });
  }
  const bindings = captured;
  const bundle = { schema_version: 'phase22-registered-publication-2.0', transaction_id: transactionId, run_id: plan.run_id, vault_root: plan.vault_root,
    plan: { ...plan, inventory }, plan_fingerprint: planStamp(plan), reviewManifest: record.review.reviewManifest, ...bindings,
    current_content_policy: usesCurrentReadingFirstPublication(record.review) || usesCurrentTopicPublication(record.review) };
  const bundleBytes = jsonBytes(bundle);
  await writeRegisteredRecord(ctx, bundlePath, bundleBytes);
  let authorityRef = null;
  if (authority) {
    const bytes = jsonBytes({ schema_version: 'phase22-registered-publication-authority-1.0',
      run_id: plan.run_id, vault_root: plan.vault_root, bundle_sha256: digest(bundleBytes), binding: authority,
      controller_grant: signControllerGrant(publicationGrantPayload(plan, authority, digest(bundleBytes))) });
    const path = versionRoot + '/authority-' + digest(bytes).slice(7) + '.json';
    await writeRegisteredRecord(ctx, path, bytes);
    authorityRef = { path, sha256: digest(bytes) };
  }
  const pointer = { schema_version: 'phase22-publication-registration-1.0', run_id: plan.run_id, vault_root: plan.vault_root,
    bundle: { path: bundlePath, sha256: digest(bundleBytes) }, authority: authorityRef };
  await currentPlan(plan); assertFileBindings(captured.source_bindings); assertFileBindings(captured.tool_bindings);
  const registrationPath = root + '/CURRENT.json';
  const controllerGrant = signControllerGrant({ schema_version: 'phase22-controller-grant-1.0', kind: 'registration',
    vault_root: plan.vault_root, run_id: plan.run_id, registration_hash: hash(pointer) });
  await writeRegisteredRecord(ctx, registrationPath, jsonBytes({ ...pointer, controller_grant: controllerGrant }), { replace: true });
  {
    const ownBindings = [registrationPath, bundlePath, ...inventory.map(row => row.output_path), ...(authorityRef ? [authorityRef.path] : [])].map(path => fileBinding(join(plan.vault_root, path)));
    record.validatePromotion = () => { assertFileBindings(ownBindings); assertFileBindings(captured.source_bindings); assertFileBindings(captured.tool_bindings); };
  }
  return { ok: true, registration_path: registrationPath, bundle_path: bundlePath, bundle_sha256: digest(bundleBytes),
    run: plan.run_id, transaction_id: transactionId, hashes: plan.hashes, evidence_mode: plan.evidence_mode, trust_anchor: getBilingualPublicationTrustAnchor({ vaultRoot: plan.vault_root, run: plan.run_id }) };
}

/** Loads only the explicit controller registration within this vault/run. */
export async function loadBilingualPublication({ vaultRoot, run, requireApproval = false, trustAnchor } = {}) {
  if (!identifier(run)) fail('P22_RUN_REQUIRED');
  const root = (await rootState(vaultRoot)).root, registrationPath = CONTROL + '/runs/' + run + '/CURRENT.json';
  const registered = await observe(root, registrationPath);
  if (!registered.exists) fail('P22_RUN_NOT_REGISTERED');
  const pointer = JSON.parse(registered.bytes);
  if (!same(Object.keys(pointer).sort(), ['authority', 'bundle', 'controller_grant', 'run_id', 'schema_version', 'vault_root'])
    || pointer.schema_version !== 'phase22-publication-registration-1.0' || pointer.run_id !== run || pointer.vault_root !== root
    || typeof pointer.bundle?.path !== 'string' || !pointer.bundle.path.startsWith(CONTROL + '/runs/' + run + '/')) fail('P22_REGISTRATION_INVALID');
  const trustedAnchor = verifyControllerGrant(pointer.controller_grant, root, run, trustAnchor);
  await assertTopicOperationNotCancelled({ vaultRoot: root, operationId: run, trustAnchor: trustedAnchor });
  const { controller_grant: registrationGrant, ...pointerBody } = pointer;
  if (registrationGrant.payload.kind !== 'registration' || registrationGrant.payload.registration_hash !== hash(pointerBody)) fail('P22_CONTROLLER_GRANT_INVALID');
  const stored = await observe(root, pointer.bundle.path);
  if (!stored.exists || stored.sha256 !== pointer.bundle.sha256) fail('P22_REGISTERED_BUNDLE_CHANGED');
  const bundle = JSON.parse(stored.bytes);
  const simple = bundle.schema_version === 'phase22-registered-publication-2.0';
  if ((!simple && bundle.schema_version !== 'phase22-registered-publication-1.0') || !identifier(bundle.transaction_id) || bundle.run_id !== run || bundle.vault_root !== root
    || !Array.isArray(bundle.source_bindings) || !bundle.source_bindings.length || !Array.isArray(bundle.tool_bindings)
    || !bundle.tool_bindings.length || !bundle.control_snapshot) fail('P22_REGISTERED_BUNDLE_INVALID');
  assertFileBindings(bundle.source_bindings); assertFileBindings(bundle.tool_bindings);
  const outputBindings = [];
  const inventory = [];
  for (const { bytes_base64, output_path, ...row } of bundle.plan.inventory) {
    let bytes;
    if (simple) {
      if (typeof output_path !== 'string' || !output_path.startsWith(pointer.bundle.path.slice(0, pointer.bundle.path.lastIndexOf('/') + 1) + 'outputs/')) fail('P22_REGISTERED_OUTPUT_CHANGED');
      const output = await observe(root, output_path);
      if (!matchingBytes(output, row.byte_sha256, row.byte_length)) fail('P22_REGISTERED_OUTPUT_CHANGED');
      bytes = output.bytes;
      outputBindings.push(fileBinding(join(root, output_path)));
    } else {
      bytes = Buffer.from(bytes_base64, 'base64');
      if (bytes.toString('base64') !== bytes_base64 || digest(bytes) !== row.byte_sha256 || bytes.length !== row.byte_length) fail('P22_REGISTERED_OUTPUT_CHANGED');
    }
    inventory.push({ ...row, bytes });
  }
  const plan = freezePlan({ ...bundle.plan, inventory });
  if (plan.run_id !== run || plan.vault_root !== root || planStamp(plan) !== bundle.plan_fingerprint) fail('P22_REGISTERED_PLAN_CHANGED');
  const ownBindings = [fileBinding(join(root, registrationPath)), fileBinding(join(root, pointer.bundle.path)), ...outputBindings];
  let authority = null, control = null, controllerGrant = null;
  if (pointer.authority) {
    if (typeof pointer.authority.path !== 'string' || !pointer.authority.path.startsWith(CONTROL + '/runs/' + run + '/')) fail('P22_REGISTRATION_AUTHORITY_INVALID');
    const storedAuthority = await observe(root, pointer.authority.path);
    if (!storedAuthority.exists || storedAuthority.sha256 !== pointer.authority.sha256) fail('P22_REGISTRATION_AUTHORITY_INVALID');
    const value = JSON.parse(storedAuthority.bytes);
    if (value.schema_version !== 'phase22-registered-publication-authority-1.0' || value.vault_root !== root
      || value.run_id !== run || value.bundle_sha256 !== stored.sha256) fail('P22_REGISTRATION_AUTHORITY_INVALID');
    authority = value.binding; controllerGrant = value.controller_grant;
    checkPublicationGrant(controllerGrant, plan, authority, trustedAnchor);
    if (controllerGrant.payload.bundle_sha256 !== stored.sha256) fail('P22_CONTROLLER_GRANT_INVALID');
    ownBindings.push(fileBinding(join(root, pointer.authority.path)));
    // Rehydrate the original controller-only registration, not a handoff/source field.
    const broker = createOwnedArtifactBroker({ control_actor_id: 'phase22-registered-publication-controller',
      artifact_root: root, authorized_bindings: [], run_controls: [{ run_id: run, phase22_publication_binding: authority }] });
    control = { dispatchContext: broker.dispatchContext, runId: run };
  } else if (requireApproval) fail('P22_PUBLICATION_CONTROL_REQUIRED');
  let rebuiltReview = null;
  if (!simple && ['phase24-topic-1.0', 'phase22-reader-note-1.0', 'reading-first-obsidian-1.0'].includes(bundle.reviewManifest.profile)) {
    if (bundle.reviewManifest.profile === 'phase24-topic-1.0') {
      if (!bundle.topic_recipe) fail('P24_RECIPE_REQUIRED');
      rebuiltReview = await rebuildRegisteredTopicReview(bundle.topic_recipe, { registration: pointer,
        bundleBytes: stored.bytes, trustAnchor: trustedAnchor });
    } else if (bundle.reviewManifest.profile === 'reading-first-obsidian-1.0') {
      if (!bundle.reading_first_recipe) fail('RF_PUBLICATION_RECIPE_REQUIRED');
      rebuiltReview = await rebuildRegisteredReadingFirstReview(bundle.reading_first_recipe, { registration: pointer,
        bundleBytes: stored.bytes, trustAnchor: trustedAnchor });
    } else {
      if (!bundle.reader_recipe) fail('P221_REGISTRATION_RECIPE_REQUIRED');
      rebuiltReview = await rebuildRegisteredReader(bundle.reader_recipe);
    }
    if (!same(rebuiltReview.hashes, { scientific_review_hash: plan.hashes.scientific_review_hash, review_bundle_hash: plan.hashes.review_hash, output_inventory_hash: plan.hashes.review_output_inventory_hash })
      || !same(rebuiltReview.reviewManifest, bundle.reviewManifest)) fail('P221_REGISTERED_REBUILD_MISMATCH');
    const expected = plan.inventory.filter(row => !['history', 'commit'].includes(row.kind));
    if (!same(expected.map(row => ({ path: row.path, kind: row.kind, sha256: row.byte_sha256 })), rebuiltReview.outputInventory.map(row => ({ path: row.path, kind: row.kind, sha256: row.byte_sha256 })).sort((a, b) => a.path.localeCompare(b.path)))) fail('P221_REGISTERED_REBUILD_MISMATCH');
  }
  const validate = async () => {
    if (rebuiltReview) await assertBilingualReviewCurrent(rebuiltReview);
    assertFileBindings(ownBindings); assertFileBindings(bundle.source_bindings); assertFileBindings(bundle.tool_bindings);
  };
  const validatePromotion = (rebuiltReview || simple) ? () => { assertFileBindings(ownBindings); assertFileBindings(bundle.source_bindings); assertFileBindings(bundle.tool_bindings); } : null;
  plans.set(plan, { stamp: planStamp(plan), review: rebuiltReview ?? (simple ? { reviewManifest: bundle.reviewManifest } : null), currentContentPolicy: simple && bundle.current_content_policy, validate, validatePromotion, controllerGrant, trustAnchor: trustedAnchor, transactionId: bundle.transaction_id });
  await validate();
  return { plan, reviewManifest: bundle.reviewManifest, ...(rebuiltReview ? { review: rebuiltReview } : {}), authority, control };
}
