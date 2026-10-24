import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import YAML from 'yaml';
import { fingerprintV3Json as hash } from './semantic-package-validator.mjs';
import { inspectManagedNote, mergeManagedNote } from './phase22-managed-markdown.mjs';
import { readCommittedGeneration, assertActiveGeneration, assertIndexGeneration, phase22GenerationPaths,
  INDEX_READING_FIRST_PROFILE } from './phase22-active-version.mjs';
import { buildBilingualIndex } from './phase22-search.mjs';
import { assertReadingFirstPublicationManifest } from './reading-first-index.mjs';
import { captureReadingFirstPublicationSource, inspectReadingFirstPublicationSource,
  restoreReadingFirstPublicationSource } from './reading-first-runtime.mjs';
import { createPhase22ContractValidator } from './phase22-contract-loader.mjs';

const records = new WeakMap();
let contractValidator;
const profile = 'reading-first-obsidian-1.0';
const languages = ['en', 'zh-CN'];
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(JSON.stringify(value) + '\n');
const fail = (code, details = {}) => { throw Object.assign(new Error(code), { code, details }); };
const clone = value => structuredClone(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value);
function freeze(value) {
  if (value && typeof value === 'object' && !(value instanceof Uint8Array) && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
function safePath(path) {
  if (typeof path !== 'string' || !path || /[\\\x00-\x1f<>:"|?*]/.test(path) || path.startsWith('/')
    || path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('RF_PUBLICATION_PATH_INVALID', { path });
  return path;
}
function regularBytes(root, path, { missing = false } = {}) {
  safePath(path);
  let cursor = root;
  const parts = path.split('/');
  for (let i = 0; i < parts.length; i++) {
    cursor = join(cursor, parts[i]);
    let stat;
    try { stat = lstatSync(cursor); }
    catch (error) { if (missing && error.code === 'ENOENT') return null; throw error; }
    if (stat.isSymbolicLink() || realpathSync(cursor) !== cursor
      || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) fail('RF_PUBLICATION_FILE_TYPE', { path });
  }
  return readFileSync(cursor);
}
function rootPath(vaultRoot) {
  if (typeof vaultRoot !== 'string' || !vaultRoot) fail('RF_PUBLICATION_VAULT_REQUIRED');
  const root = resolve(vaultRoot), stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(root) !== root) fail('RF_PUBLICATION_VAULT_INVALID');
  return root;
}
function binding(path) {
  path = resolve(path);
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || realpathSync(path) !== path
    || realpathSync(dirname(path)) !== dirname(path)) fail('RF_PUBLICATION_SOURCE_FILE_INVALID', { path });
  const bytes = readFileSync(path);
  const after = lstatSync(path, { bigint: true });
  if (stat.dev !== after.dev || stat.ino !== after.ino || stat.size !== after.size || stat.mtimeNs !== after.mtimeNs) fail('RF_PUBLICATION_SOURCE_FILE_CHANGED', { path });
  return { path, sha256: sha(bytes), byte_length: bytes.length, identity: { dev: String(stat.dev), ino: String(stat.ino) } };
}
function currentBindings(bindings) {
  for (const row of bindings) if (!same(row, binding(row.path))) fail('P22_REGISTERED_DEPENDENCY_CHANGED', { path: row.path });
}
function tools() {
  return ['./reading-first-publication.mjs', './phase22-publication.mjs', './phase22-review.mjs',
    './phase22-active-version.mjs', './phase22-search.mjs', './reading-first-index.mjs', './phase22-managed-markdown.mjs',
    '../../Schema/phase22/active-index.schema.json', '../../Schema/phase22/reading-first-publication.schema.json',
    '../../Schema/phase22/review-manifest.schema.json'].map(path => binding(fileURLToPath(new URL(path, import.meta.url))));
}
function inventoryStamp(rows) {
  return rows.map(({ bytes, ...row }) => ({ ...row, observed_sha256: sha(bytes) }));
}
function decode(row) {
  if (row.bytes_base64 === null) return null;
  const bytes = Buffer.from(row.bytes_base64, 'base64');
  if (bytes.toString('base64') !== row.bytes_base64) fail('RF_PUBLICATION_RECIPE_INVALID');
  return bytes;
}
function encodeFiles(files) {
  return [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => ({ path, bytes_base64: bytes === null ? null : bytes.toString('base64') }));
}
function decodeFiles(rows) {
  if (!Array.isArray(rows)) fail('RF_PUBLICATION_RECIPE_INVALID');
  const result = new Map();
  for (const row of rows) {
    safePath(row.path);
    if (result.has(row.path)) fail('RF_PUBLICATION_RECIPE_INVALID');
    result.set(row.path, decode(row));
  }
  return result;
}
function sameHumanKnowledge(before, after) {
  const start = '<!-- AUTO:START shared-knowledge -->', end = '<!-- AUTO:END shared-knowledge -->';
  const split = value => {
    const from = value.indexOf(start), to = value.indexOf(end);
    if (from < 0 && to < 0) return null;
    if (from < 0 || to < from || value.indexOf(start, from + start.length) >= 0 || value.indexOf(end, to + end.length) >= 0) fail('RF_PUBLICATION_KNOWLEDGE_PREIMAGE_INVALID');
    return [value.slice(0, from), value.slice(to + end.length)];
  };
  const old = before.toString('utf8'), next = after.toString('utf8'), original = split(old), generated = split(next);
  if (!generated || (original ? !same(original, generated) : !next.startsWith(old))) fail('RF_PUBLICATION_HUMAN_CONTENT_CHANGED');
}
function requireV3Knowledge(bytes, path) {
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(bytes.toString('utf8'));
  if (!front || YAML.parse(front[1])?.pipeline_version !== '3.0') fail('RF_PUBLICATION_SUPPORT_VERSION_INVALID', { path });
}
async function baseFor(root) {
  if (regularBytes(root, '.apa-v3/phase22/COMMITTED.json', { missing: true }) === null) return { snapshot: null, generation: null, index: null, files: new Map() };
  const snapshot = await readCommittedGeneration({ vaultRoot: root });
  if (!snapshot.ok) fail('RF_PUBLICATION_PREVIOUS_GENERATION_INVALID', { errors: snapshot.errors });
  return { snapshot, generation: clone(snapshot.generation), index: clone(snapshot.index),
    files: new Map(snapshot.generation.objects.map(row => [row.path, regularBytes(root, row.path)])) };
}
function resourceBindings(data, resources) {
  if (!Array.isArray(resources)) fail('RF_PUBLICATION_RESOURCES_REQUIRED');
  const registered = [...data.sources, ...data.presentation_assets, ...data.enrichment_sources];
  const paths = new Set(), result = [];
  for (const resource of resources) {
    safePath(resource.path);
    if (paths.has(resource.path) || !/^(Raw|Figures)\//.test(resource.path) || typeof resource.source_path !== 'string') fail('RF_PUBLICATION_RESOURCE_INVALID');
    paths.add(resource.path);
    const found = registered.find(row => resolve(row.path) === resolve(resource.source_path)
      && row.sha256 === resource.sha256 && row.byte_length === resource.byte_length);
    if (!found) fail('RF_PUBLICATION_RESOURCE_UNREGISTERED', { path: resource.path });
    const current = binding(resource.source_path);
    if (current.sha256 !== resource.sha256 || current.byte_length !== resource.byte_length) fail('RF_PUBLICATION_RESOURCE_CHANGED', { path: resource.path });
    result.push({ ...clone(resource), source_path: current.path });
  }
  const expected = [...new Set(data.candidate.assetPaths ?? [])].sort();
  if (!same([...paths].sort(), expected)) fail('RF_PUBLICATION_RESOURCE_INVENTORY_INCOMPLETE');
  return result;
}

/** Prepare the exact accepted reading output for the existing V3 publication transaction. */
export async function buildReadingFirstPublicationReview({ source, vaultRoot, generation, evidenceMode = 'actual', resources } = {}) {
  const data = await inspectReadingFirstPublicationSource(source);
  if (data.origin !== 'live') fail('RF_PUBLICATION_LIVE_SOURCE_REQUIRED');
  const root = rootPath(vaultRoot), base = await baseFor(root);
  const options = { vaultRoot: root, generation, evidenceMode, resources: resourceBindings(data, resources) };
  return buildReview({ source, data, options, base, preimages: null });
}

async function buildReview({ source, data, options, base, preimages }) {
  const { candidate } = data, root = options.vaultRoot;
  if (!['actual', 'synthetic'].includes(options.evidenceMode) || !candidate?.notes || candidate.notes.length !== 2) fail('RF_PUBLICATION_INPUT_INVALID');
  const identity = { paper_id: data.identity.paper_id, run_id: data.identity.run_id,
    analysis_revision: data.identity.analysis_revision ?? 'rev_' + hash({ input: data.scientific_input_fingerprint, presentation: candidate.presentation_fingerprint }).slice(7, 39) };
  if (!identifier(identity.run_id)) fail('P22_RUN_REQUIRED');
  const generation = options.generation ?? 'rf-' + hash(identity).slice(7, 47);
  phase22GenerationPaths(generation);
  if (generation === base.generation?.generation_id) fail('P22_GENERATION_NOT_NEW');
  if (base.generation && base.generation.evidence_mode !== options.evidenceMode) fail('RF_PUBLICATION_EVIDENCE_MODE_MISMATCH');
  if (base.generation) { assertActiveGeneration(base.generation); assertIndexGeneration(base.index, base.generation); }
  const previousPaper = base.generation?.papers.find(row => row.paper_id === identity.paper_id);
  const beforeFiles = preimages ?? new Map();
  const before = path => {
    safePath(path);
    if (!beforeFiles.has(path)) {
      if (preimages) fail('RF_PUBLICATION_RECIPE_PREIMAGE_MISSING', { path });
      beforeFiles.set(path, regularBytes(root, path, { missing: true }));
    }
    return beforeFiles.get(path);
  };
  const output = [], readDependencies = [], files = new Map(base.files), previews = [];
  const written = new Set(), add = (path, kind, bytes, extra = {}) => {
    safePath(path); const key = path.normalize('NFC').toLowerCase();
    if (written.has(key)) fail('P22_PUBLICATION_TARGET_COLLISION', { path });
    written.add(key);
    const original = before(path), owned = Buffer.from(bytes);
    const row = { path, kind, bytes: owned, byte_sha256: sha(owned), byte_length: owned.length,
      before_sha256: original === null ? null : sha(original), before_byte_length: original?.length ?? null, ...extra };
    output.push(row); files.set(path, owned); return row;
  };
  const paths = {}, noteTargets = {};
  for (const language of languages) {
    const matches = candidate.notes.filter(row => row.language === language);
    if (matches.length !== 1 || typeof matches[0].content !== 'string') fail('RF_PUBLICATION_NOTES_REQUIRED');
    const note = matches[0], path = safePath(note.path), bytes = Buffer.from(note.content), original = before(path);
    if (!/^Wiki\/sources\/[^/]+\.md$/.test(path)) fail('RF_PUBLICATION_NOTE_PATH_INVALID');
    const inspected = inspectManagedNote(bytes);
    if (inspected.frontmatter.paper_id !== identity.paper_id || inspected.frontmatter.language !== language
      || inspected.frontmatter.rendering_profile !== profile || inspected.frontmatter.pipeline_version !== '3.0') fail('RF_PUBLICATION_NOTE_IDENTITY_MISMATCH');
    if (original !== null) {
      const old = inspectManagedNote(original);
      if (old.frontmatter.paper_id !== identity.paper_id || old.frontmatter.rendering_profile !== profile
        || !mergeManagedNote({ existingBytes: original, rendered: bytes, expectedManagedHash: old.managedHash }).bytes.equals(bytes)) fail('RF_PUBLICATION_HUMAN_PREIMAGE_MISMATCH');
    }
    if (previousPaper && previousPaper.paths[language] !== path) fail('RF_PUBLICATION_TARGET_REGISTRY_CHANGED');
    const row = add(path, 'paper', bytes, { language, managed_hash: inspected.managedHash,
      before_managed_hash: original === null ? null : inspectManagedNote(original).managedHash });
    paths[language] = path;
    noteTargets[language] = { path, managed_hash: inspected.managedHash, byte_sha256: row.byte_sha256 };
    previews.push({ language, path, byte_sha256: row.byte_sha256, byte_length: bytes.length, managed_hash: inspected.managedHash,
      human_ranges: inspected.humanRanges.map(range => ({ from: range.from, to: range.to, byte_sha256: sha(range.bytes) })) });
  }
  const shared = new Map((base.generation?.shared_nodes ?? []).map(row => [row.path, clone(row)]));
  const supportTargets = [];
  for (const note of candidate.supportNotes ?? []) {
    const path = safePath(note.path), bytes = Buffer.from(note.content), original = before(path);
    if (!/^Wiki\/(methods|concepts)\/[^/]+\.md$/.test(path)) fail('RF_PUBLICATION_SUPPORT_PATH_INVALID');
    requireV3Knowledge(bytes, path);
    if (original !== null && !original.equals(bytes)) { requireV3Knowledge(original, path); sameHumanKnowledge(original, bytes); }
    const entityId = shared.get(path)?.entity_id ?? 'rf_' + hash({ path }).slice(7, 39);
    shared.set(path, { entity_id: entityId, path }); supportTargets.push({ entity_id: entityId, path });
    add(path, 'support', bytes, { entity_id: entityId });
  }
  for (const resource of options.resources) {
    const bytes = readFileSync(resource.source_path), original = before(resource.path);
    if (sha(bytes) !== resource.sha256 || bytes.length !== resource.byte_length) fail('RF_PUBLICATION_RESOURCE_CHANGED', { path: resource.path });
    if (original !== null && !original.equals(bytes)) fail('RF_PUBLICATION_RESOURCE_TARGET_CONFLICT', { path: resource.path });
    if (original === null) add(resource.path, 'asset', bytes);
    else { files.set(resource.path, bytes); readDependencies.push({ path: resource.path, byte_sha256: sha(bytes), byte_length: bytes.length }); }
  }
  const dependencies = { scientific_input: data.scientific_input_fingerprint,
    reading_review: data.reading_review_fingerprint, presentation: candidate.presentation_fingerprint };
  const manifestPath = '.apa-v3/reading-first/presentation/' + identity.run_id + '-' + hash(identity).slice(7, 31) + '.json';
  const presentation = { schema_version: 'reading-first-publication-1.0', profile, identity,
    presentation_fingerprint: candidate.presentation_fingerprint, scientific_input_fingerprint: data.scientific_input_fingerprint,
    evidence_mode: options.evidenceMode, dependencies, qualification: { reading_status: 'reading_complete', native_status: data.native_presentation.status },
    targets: { presentation: manifestPath, notes: noteTargets, support: supportTargets, assets: options.resources.map(row => row.path) }, navigation: [] };
  assertReadingFirstPublicationManifest(presentation);
  const manifestBytes = jsonBytes(presentation);
  add(manifestPath, 'reader-presentation', manifestBytes);
  const paper = { ...identity, core_hash: data.scientific_input_fingerprint, pipeline_version: '3.0', profile: INDEX_READING_FIRST_PROFILE,
    dependencies, paths, reader_presentation: { path: manifestPath, sha256: sha(manifestBytes) } };
  const replacedPaths = new Set(previousPaper ? [...Object.values(previousPaper.paths), previousPaper.reader_presentation?.path].filter(Boolean) : []);
  const objects = new Map((base.generation?.objects ?? []).filter(row => !replacedPaths.has(row.path)).map(row => [row.path, clone(row)]));
  for (const row of output) objects.set(row.path, { path: row.path, kind: row.kind === 'paper' ? 'v3-note' : row.kind,
    sha256: row.kind === 'paper' ? row.managed_hash : row.byte_sha256 });
  for (const resource of options.resources) if (!objects.has(resource.path)) objects.set(resource.path, { path: resource.path, kind: 'asset', sha256: resource.sha256 });
  const active = { schema_version: 'phase22/active-index-1.0', kind: 'active', generation_id: generation, evidence_mode: options.evidenceMode,
    papers: [...(base.generation?.papers ?? []).filter(row => row.paper_id !== identity.paper_id), paper],
    objects: [...objects.values()].sort((a, b) => a.path.localeCompare(b.path)), shared_nodes: [...shared.values()].sort((a, b) => a.path.localeCompare(b.path)) };
  assertActiveGeneration(active);
  const finalFiles = [...files].map(([path, bytes]) => ({ path, bytes }));
  const built = await buildBilingualIndex({ validatedInputs: { papers: [{ readingFirst: presentation,
    notes: Object.fromEntries(candidate.notes.map(note => [note.language, Buffer.from(note.content)])) }], files: finalFiles,
    ...(base.snapshot ? { previousSnapshot: base.snapshot } : base.generation ? { previousPrepared: { generation: base.generation, index: base.index } } : {}) }, generation: active });
  const pairPaths = phase22GenerationPaths(generation);
  add(pairPaths.active, 'active', jsonBytes(built.generation));
  add(pairPaths.index, 'index', built.bytes);
  for (const object of active.objects.filter(row => !output.some(entry => entry.path === row.path))) {
    if (readDependencies.some(row => row.path === object.path)) continue;
    const bytes = files.get(object.path);
    if (!(bytes instanceof Uint8Array)) fail('RF_PUBLICATION_PREVIOUS_OBJECT_MISSING', { path: object.path });
    readDependencies.push({ path: object.path, byte_sha256: sha(bytes), byte_length: bytes.length });
  }
  readDependencies.sort((a, b) => a.path.localeCompare(b.path));
  const scientificReviewHash = hash({ input: data.scientific_input_fingerprint, reading_review: data.reading_review_fingerprint,
    review_receipt: data.review_receipt, view_receipts: data.view_receipts,
    ...(data.reading_editor_receipt ? { reading_editor_receipt: data.reading_editor_receipt } : {}), presentation: candidate.presentation_fingerprint });
  const toolBindings = tools(), sourceBindings = [...new Map([...data.source_bindings, ...options.resources.map(row => binding(row.source_path))]
    .map(row => [row.path, row])).values()];
  const status = options.evidenceMode === 'actual' ? 'review_ready' : 'synthetic_prepared';
  const reviewManifest = { schema_version: 'phase22/review-manifest-1.0', profile, identity, status,
    evidence_mode: options.evidenceMode, review_ready: options.evidenceMode === 'actual', publishable: false,
    reading_accepted: true, native_presentation: clone(data.native_presentation), scientific_review_hash: scientificReviewHash,
    generation, previous_generation: base.generation?.generation_id ?? null, previews,
    support_notes: supportTargets, assets: options.resources.map(({ path, sha256, byte_length }) => ({ path, byte_sha256: sha256, byte_length })),
    read_dependencies: readDependencies, dependencies, tools: Object.fromEntries(toolBindings.map(row => [row.path, row.sha256])),
    index: { path: pairPaths.index, byte_sha256: built.sha256 }, active: { path: pairPaths.active, byte_sha256: sha(jsonBytes(built.generation)) },
    write_set: output.map(({ bytes, ...row }) => row), diagnostics: [],
    provenance_limits: { native_presentation: data.native_presentation.status, scientific_review_scope: data.review.scope, independent_first_read: 'not_asserted' } };
  contractValidator ??= createPhase22ContractValidator();
  (await contractValidator).assert('phase22/review-manifest-1.0', reviewManifest);
  add('.apa-v3/phase22/generations/' + generation + '/manifest.json', 'manifest', jsonBytes(reviewManifest));
  output.sort((a, b) => a.path.localeCompare(b.path));
  const hashes = { scientific_review_hash: scientificReviewHash,
    review_bundle_hash: hash({ reviewManifest, outputs: inventoryStamp(output), read_dependencies: readDependencies }),
    output_inventory_hash: hash({ generation, previous_generation: reviewManifest.previous_generation, output: inventoryStamp(output), read_dependencies: readDependencies }) };
  const result = freeze({ ok: true, status, reviewManifest, outputInventory: output, hashes, diagnostics: [] });
  const recipe = { schema_version: 'reading-first-publication-registration-1.0', source: data.recipe,
    options: clone(options), preimages: encodeFiles(beforeFiles),
    base: { generation: base.generation, index: base.index, files: encodeFiles(base.files) } };
  records.set(result, { source, recipe, sourceBindings, toolBindings,
    stamp: hash({ manifest: reviewManifest, output: inventoryStamp(output), hashes }) });
  return result;
}

export async function assertReadingFirstPublicationReviewCurrent(review) {
  const record = records.get(review);
  if (!record) fail('P22_REVIEW_NOT_OWNED');
  if (record.stamp !== hash({ manifest: review.reviewManifest, output: inventoryStamp(review.outputInventory), hashes: review.hashes })) fail('P22_REVIEW_OUTPUT_INVALIDATED');
  await inspectReadingFirstPublicationSource(record.source);
  currentBindings(record.sourceBindings); currentBindings(record.toolBindings);
  return review;
}

/** Restored evidence can reload its signed plan, but cannot mint a new plan or approval source. */
export async function assertReadingFirstPublicationReviewLive(review) {
  await assertReadingFirstPublicationReviewCurrent(review);
  const data = await inspectReadingFirstPublicationSource(records.get(review).source);
  if (data.origin !== 'live') fail('RF_PUBLICATION_LIVE_SOURCE_REQUIRED');
  return review;
}

/** Capture an owned live review; no JSON request can substitute for its source capability. */
export async function captureReadingFirstPublicationRegistration({ review, sourceInputs } = {}) {
  await assertReadingFirstPublicationReviewCurrent(review);
  const record = records.get(review), data = await inspectReadingFirstPublicationSource(record.source);
  if (data.origin !== 'live' || sourceInputs?.readingFirst?.source !== record.source) fail('RF_PUBLICATION_LIVE_SOURCE_REQUIRED');
  return { reading_first_recipe: clone(record.recipe), source_bindings: clone(record.sourceBindings),
    tool_bindings: [...new Map([...data.tool_bindings, ...record.toolBindings].map(row => [row.path, row])).values()],
    control_snapshot: { schema_version: 'reading-first-publication-control-1.0', run_id: review.reviewManifest.identity.run_id,
      evidence_mode: review.reviewManifest.evidence_mode, source_fingerprint: hash(record.recipe.source) } };
}

function assertRegisteredProof(recipe, { registration, bundleBytes, trustAnchor } = {}) {
  try {
    const grant = registration.controller_grant, { controller_grant, ...pointer } = registration;
    const publicDer = Buffer.from(trustAnchor.public_key, 'base64');
    const payload = grant.payload;
    if (trustAnchor.schema_version !== 'phase22-controller-trust-1.0' || trustAnchor.vault_root !== recipe.options.vaultRoot
      || trustAnchor.run_id !== payload.run_id || payload.kind !== 'registration' || payload.vault_root !== trustAnchor.vault_root
      || payload.registration_hash !== hash(pointer) || grant.key_fingerprint !== sha(publicDer)
      || sha(bundleBytes) !== pointer.bundle.sha256
      || !same(JSON.parse(Buffer.from(bundleBytes)).reading_first_recipe, recipe)
      || !verify(null, Buffer.from(hash(payload)), createPublicKey({ key: publicDer, format: 'der', type: 'spki' }), Buffer.from(grant.signature, 'base64'))) fail('RF_PUBLICATION_REGISTERED_PROOF_REQUIRED');
  } catch { fail('RF_PUBLICATION_REGISTERED_PROOF_REQUIRED'); }
}

/** The caller must supply the Controller-signed registration, not merely a saved recipe. */
export async function rebuildRegisteredReadingFirstReview(recipe, proof) {
  if (recipe?.schema_version !== 'reading-first-publication-registration-1.0') fail('RF_PUBLICATION_RECIPE_INVALID');
  assertRegisteredProof(recipe, proof);
  const source = await restoreReadingFirstPublicationSource(recipe.source), data = await inspectReadingFirstPublicationSource(source);
  const options = { ...clone(recipe.options), resources: resourceBindings(data, recipe.options.resources) };
  return buildReview({ source, data, options,
    base: { snapshot: null, generation: recipe.base.generation, index: recipe.base.index, files: decodeFiles(recipe.base.files) },
    preimages: decodeFiles(recipe.preimages) });
}

/** Read-only preparation; registration and production apply retain their existing explicit authority. */
export async function prepareReadingFirstPublication(args = {}) {
  const source = args.source ?? await captureReadingFirstPublicationSource({ controller: args.controller, presentation: args.presentation });
  const review = await buildReadingFirstPublicationReview({ ...args, source });
  const { dryRunBilingualPublication } = await import('./phase22-publication.mjs');
  const dry = await dryRunBilingualPublication({ vaultRoot: args.vaultRoot, run: review.reviewManifest.identity.run_id, review });
  return { ...dry, review, sourceInputs: { readingFirst: { source } } };
}
