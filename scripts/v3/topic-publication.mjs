import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import Ajv2020 from 'ajv/dist/2020.js';
import { fingerprintV3Json as hash } from './semantic-package-validator.mjs';
import { inspectManagedNote, mergeManagedNote } from './phase22-managed-markdown.mjs';
import { readCommittedGeneration, assertActiveGeneration, assertIndexGeneration, phase22GenerationPaths } from './phase22-active-version.mjs';
import { buildBilingualIndex } from './phase22-search.mjs';
import { createPhase22ContractValidator } from './phase22-contract-loader.mjs';
import { readRegisteredTopicDependency, validateSourceChangeEvent, validateTopicEventResolutions, assertTopicCandidatePending } from './topic-library.mjs';

const records = new WeakMap();
const profile = 'phase24-topic-1.0';
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(JSON.stringify(value) + '\n');
const fail = (code, details = {}) => { throw Object.assign(new Error(code), { code, details }); };
const clone = value => structuredClone(value);
const topicValidator = new Ajv2020({ strict: true, allErrors: true });
// Relative schema IDs resolve ../phase22 from phase24 to this root-relative key.
topicValidator.addSchema(JSON.parse(readFileSync(new URL('../../Schema/phase22/active-index.schema.json', import.meta.url))), '/phase22/active-index-1.0');
topicValidator.addSchema(JSON.parse(readFileSync(new URL('../../Schema/phase24/topic.schema.json', import.meta.url))));
const checkCandidate = topicValidator.compile({ $ref: 'phase24/topic-1.0#/$defs/candidate' });
const checkRecipe = topicValidator.compile({ $ref: 'phase24/topic-1.0#/$defs/registration' });
const checkTopic = topicValidator.getSchema('phase24/topic-1.0');
const encode = files => [...files].map(([path, bytes]) => ({ path, bytes_base64: bytes === null ? null : bytes.toString('base64') }));
const decode = rows => new Map(rows.map(row => {
  const bytes = row.bytes_base64 === null ? null : Buffer.from(row.bytes_base64, 'base64');
  if (bytes !== null && bytes.toString('base64') !== row.bytes_base64) fail('P24_RECIPE_INVALID');
  return [row.path, bytes];
}));
function binding(path) {
  path = resolve(path);
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || realpathSync(path) !== path
    || realpathSync(dirname(path)) !== dirname(path)) fail('P24_FILE_TYPE_INVALID', { path });
  const bytes = readFileSync(path), after = lstatSync(path, { bigint: true });
  if (stat.ino !== after.ino || stat.dev !== after.dev || stat.mtimeNs !== after.mtimeNs || stat.size !== after.size) fail('P24_INPUT_CHANGED');
  return { path, sha256: sha(bytes), byte_length: bytes.length, identity: { dev: String(stat.dev), ino: String(stat.ino) } };
}
const current = rows => { for (const row of rows) if (!same(row, binding(row.path))) fail('P22_REGISTERED_DEPENDENCY_CHANGED', { path: row.path }); };
function bytesAt(root, path, missing = false) {
  if (typeof path !== 'string' || !path || /[\\\x00-\x1f:]/.test(path) || path.startsWith('/') || path.split('/').some(p => !p || p === '.' || p === '..')) fail('P24_PATH_INVALID');
  let cursor = root;
  for (const part of path.split('/')) {
    cursor = join(cursor, part);
    let stat;
    try { stat = lstatSync(cursor); } catch (e) { if (missing && e.code === 'ENOENT') return null; throw e; }
    if (stat.isSymbolicLink() || realpathSync(cursor) !== cursor) fail('P24_FILE_TYPE_INVALID');
  }
  binding(cursor);
  return readFileSync(cursor);
}
const toolBindings = () => ['./topic-publication.mjs', './topic-library.mjs', './phase22-publication.mjs', './phase22-review.mjs',
  './phase22-active-version.mjs', './phase22-managed-markdown.mjs', './phase22-search.mjs', '../../Schema/phase24/topic.schema.json',
  '../../Schema/phase22/active-index.schema.json', '../../Schema/phase22/review-manifest.schema.json', '../../Schema/phase22/publication-transaction.schema.json']
  .map(path => binding(fileURLToPath(new URL(path, import.meta.url))));
const stamp = rows => rows.map(({ bytes, ...row }) => ({ ...row, observed_sha256: sha(bytes) }));
function freeze(value) {
  if (value && typeof value === 'object' && !(value instanceof Uint8Array) && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

async function build({ options, base, preimages, restored = false }) {
  const { vaultRoot: root, candidate } = options;
  if (!checkCandidate(candidate)) fail('P24_CANDIDATE_INVALID', { errors: checkCandidate.errors });
  assertTopicCandidatePending(candidate);
  const sourceChange = candidate.operation === 'source-change';
  const sourceBindings = sourceChange ? [binding(candidate.candidate_path)] : [binding(candidate.topic_path), binding(candidate.note_path)];
  if (sourceChange ? !same(candidate, JSON.parse(readFileSync(candidate.candidate_path, 'utf8')))
    : candidate.topic_sha256 !== sourceBindings[0].sha256 || candidate.note_sha256 !== sourceBindings[1].sha256) fail('P24_CANDIDATE_CHANGED');
  const topic = sourceChange ? null : JSON.parse(readFileSync(candidate.topic_path, 'utf8')), note = sourceChange ? null : readFileSync(candidate.note_path);
  if (!sourceChange && (!checkTopic(topic) || !same(candidate.topic, topic) || !same(candidate.source_declaration, topic.dependencies))) fail('P24_CANDIDATE_INVALID');
  const run = options.operationId ?? candidate.operation_id;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(run ?? '')) fail('P24_OPERATION_INVALID');
  if (run !== candidate.operation_id || (!sourceChange && topic.revision === 1 && topic.topic_id !== 'topic-' + hash(run).slice(7, 31))) fail('P24_OPERATION_INVALID');
  if (candidate.expected_generation_id !== undefined && candidate.expected_generation_id !== base.generation.generation_id) fail('P24_GENERATION_CHANGED');
  if (!sourceChange && (!Array.isArray(topic.dependencies) || !topic.dependencies.length)) fail('P24_ADOPTED_SOURCES_REQUIRED');
  if (sourceChange) {
    if (!restored) await validateSourceChangeEvent({ vaultRoot: root, snapshot: base.snapshot, event: candidate.event });
    else {
      // The recipe binds the already validated exact target and original committed snapshots.
      const live = await readCommittedGeneration({ vaultRoot: root });
      await validateSourceChangeEvent({ vaultRoot: root, snapshot: live, event: candidate.event });
    }
  }
  for (const dependency of topic?.dependencies ?? []) {
    const registered = await readRegisteredTopicDependency({ vaultRoot: root, dependency, snapshot: base.snapshot ?? undefined });
    const sourceBinding = binding(registered.absolute_path);
    if (sourceBinding.sha256 !== dependency.source_sha256 || sourceBinding.byte_length !== registered.source.byte_length) fail('P24_ADOPTED_SOURCE_MISMATCH');
    if (!sourceBindings.some(row => row.path === sourceBinding.path)) sourceBindings.push(sourceBinding);
  }
  const inspected = sourceChange ? null : inspectManagedNote(note);
  if (!sourceChange && (inspected.managedHash !== topic.managed_hash || inspected.frontmatter.topic_id !== topic.topic_id
    || inspected.frontmatter.revision !== topic.revision || inspected.frontmatter.rendering_profile !== profile)) fail('P24_CANDIDATE_INVALID');
  const path = sourceChange ? null : 'Wiki/topics/' + topic.topic_id + '.md';
  const beforeFiles = preimages ?? new Map();
  const before = path => {
    if (!beforeFiles.has(path)) {
      if (preimages) fail('P24_RECIPE_PREIMAGE_MISSING');
      beforeFiles.set(path, bytesAt(root, path, true));
    }
    return beforeFiles.get(path);
  };
  const old = sourceChange ? null : before(path), previous = sourceChange ? null : base.generation.topics?.find(row => row.topic_id === topic.topic_id);
  if (!sourceChange && (previous ? topic.revision !== previous.revision + 1 || topic.previous_revision !== previous.revision : topic.revision !== 1 || topic.previous_revision !== null)) fail('P24_REVISION_INVALID');
  if (old !== null && !previous) fail('P24_TARGET_UNREGISTERED');
  if (previous) validateTopicEventResolutions({ topic, previous, answer: inspected.regions.find(r => r.id === 'topic').bytes.toString('utf8'),
    events: base.generation.source_events ?? [], inputFingerprint: candidate.execution?.input_hash });
  const merged = sourceChange ? null : mergeManagedNote({ existingBytes: old, rendered: note, expectedManagedHash: previous?.managed_hash });
  const generation = options.generation ?? 'topic-' + hash({ run, topic, ...(sourceChange ? { event: candidate.event } : {}) }).slice(7, 47);
  if (generation === base.generation.generation_id) fail('P22_GENERATION_NOT_NEW');
  phase22GenerationPaths(generation);
  const files = new Map(base.files), output = [];
  function add(path, kind, bytes, extra = {}) {
    const original = before(path);
    const row = { path, kind, bytes, byte_sha256: sha(bytes), byte_length: bytes.length,
      before_sha256: original === null ? null : sha(original), before_byte_length: original?.length ?? null, ...extra };
    files.set(path, bytes); output.push(row); return row;
  }
  const row = sourceChange ? null : add(path, 'topic', merged.bytes, { language: topic.language, managed_hash: merged.managedHash, before_managed_hash: previous?.managed_hash ?? null });
  const active = { ...clone(base.generation), generation_id: generation,
    ...(sourceChange ? { source_events: [...(base.generation.source_events ?? []), candidate.event] }
      : { topics: [...(base.generation.topics ?? []).filter(t => t.topic_id !== topic.topic_id), { ...topic, path }] }),
    objects: sourceChange ? clone(base.generation.objects) : [...base.generation.objects.filter(o => o.path !== path), { path, kind: 'topic', sha256: merged.managedHash }] };
  delete active.index_manifest;
  assertActiveGeneration(active);
  const built = await buildBilingualIndex({ generation: active, validatedInputs: { papers: [], files: [...files].map(([path, bytes]) => ({ path, bytes })),
    ...(base.snapshot ? { previousSnapshot: base.snapshot } : { previousPrepared: { generation: base.generation, index: base.index } }) } });
  const paths = phase22GenerationPaths(generation);
  add(paths.active, 'active', jsonBytes(built.generation)); add(paths.index, 'index', built.bytes);
  const dependencies = [...base.files].filter(([p]) => p !== path).map(([path, bytes]) => ({ path, byte_sha256: sha(bytes), byte_length: bytes.length }));
  const tools = toolBindings();
  const scientificReviewHash = hash({ topic, candidate: sourceBindings, ...(sourceChange ? { event: candidate.event } : { adopted_sources: topic.dependencies }) });
  const evidenceMode = base.generation.evidence_mode;
  const status = evidenceMode === 'actual' ? 'review_ready' : 'synthetic_prepared';
  const reviewManifest = { schema_version: 'phase22/review-manifest-1.0', profile,
    ...(sourceChange ? { operation: 'source-change' } : { operation: previous ? 'update' : 'save' }),
    identity: sourceChange ? { run_id: run, analysis_revision: 'source-change' } : { topic_id: topic.topic_id, topic_revision: topic.revision, run_id: run, analysis_revision: String(topic.revision) },
    status, evidence_mode: evidenceMode, review_ready: evidenceMode === 'actual', publishable: false,
    scientific_review_hash: scientificReviewHash, generation, previous_generation: base.generation.generation_id,
    previews: sourceChange ? [] : [{ language: topic.language, path, byte_sha256: row.byte_sha256, byte_length: row.byte_length, managed_hash: merged.managedHash,
      human_ranges: inspectManagedNote(merged.bytes).humanRanges.map(r => ({ from: r.from, to: r.to, byte_sha256: sha(r.bytes) })) }],
    support_notes: [], assets: [], read_dependencies: dependencies,
    dependencies: { topic_input: scientificReviewHash, ...(sourceChange ? { source_event: hash(candidate.event) } : { adopted_sources: hash(topic.dependencies) }) }, tools: Object.fromEntries(tools.map(r => [r.path, r.sha256])),
    index: { path: paths.index, byte_sha256: built.sha256 }, active: { path: paths.active, byte_sha256: sha(jsonBytes(built.generation)) },
    write_set: output.map(({ bytes, ...r }) => r), diagnostics: [],
    provenance_limits: { scientific_review_scope: 'topic-input-fingerprint-only', claim_verification: 'not_performed' } };
  (await createPhase22ContractValidator()).assert('phase22/review-manifest-1.0', reviewManifest);
  add('.apa-v3/phase22/generations/' + generation + '/manifest.json', 'manifest', jsonBytes(reviewManifest));
  output.sort((a, b) => a.path.localeCompare(b.path));
  const hashes = { scientific_review_hash: scientificReviewHash,
    review_bundle_hash: hash({ reviewManifest, outputs: stamp(output), read_dependencies: dependencies }),
    output_inventory_hash: hash({ generation, previous_generation: reviewManifest.previous_generation, output: stamp(output), read_dependencies: dependencies }) };
  const review = freeze({ ok: true, status, reviewManifest, outputInventory: output, hashes, diagnostics: [] });
  const source = {};
  const recipe = { schema_version: 'phase24-topic-registration-1.0', options: clone(options),
    base: { generation: base.generation, index: base.index, files: encode(base.files) }, preimages: encode(beforeFiles) };
  records.set(review, { source, restored, recipe, sourceBindings, tools, stamp: hash({ reviewManifest, output: stamp(output), hashes }) });
  return { review, source };
}

export async function prepareTopicPublication({ vaultRoot, candidate, operationId, generation } = {}) {
  const root = resolve(vaultRoot), snapshot = await readCommittedGeneration({ vaultRoot: root });
  if (!snapshot.ok) fail('P24_COMMITTED_GENERATION_REQUIRED', { errors: snapshot.errors });
  const base = { snapshot, generation: clone(snapshot.generation), index: clone(snapshot.index),
    files: new Map(snapshot.generation.objects.map(o => [o.path, bytesAt(root, o.path)])) };
  const { review, source } = await build({ options: { vaultRoot: root, candidate, operationId: operationId ?? candidate.operation_id, ...(generation ? { generation } : {}) }, base });
  const { dryRunBilingualPublication } = await import('./phase22-publication.mjs');
  const dry = await dryRunBilingualPublication({ vaultRoot: root, run: review.reviewManifest.identity.run_id, review });
  return { ...dry, review, sourceInputs: { topic: { source } } };
}
export function assertTopicPublicationReviewCurrent(review) {
  const record = records.get(review);
  if (!record) fail('P22_REVIEW_NOT_OWNED');
  assertTopicCandidatePending(record.recipe.options.candidate);
  if (record.stamp !== hash({ reviewManifest: review.reviewManifest, output: stamp(review.outputInventory), hashes: review.hashes })) fail('P22_REVIEW_OUTPUT_INVALIDATED');
  current(record.sourceBindings); current(record.tools);
  return review;
}
export function getTopicPublicationCandidate(review) {
  assertTopicPublicationReviewCurrent(review);
  return clone(records.get(review).recipe.options.candidate);
}
export async function assertTopicPublicationReviewLive(review) {
  assertTopicPublicationReviewCurrent(review);
  if (records.get(review).restored) fail('P24_LIVE_SOURCE_REQUIRED');
  const recipe = records.get(review).recipe;
  assertTopicCandidatePending(recipe.options.candidate);
  const { assertTopicOperationNotCancelled } = await import('./phase22-publication.mjs');
  await assertTopicOperationNotCancelled({ vaultRoot: recipe.options.vaultRoot, operationId: recipe.options.operationId });
  return review;
}
export async function captureTopicPublicationRegistration({ review, sourceInputs } = {}) {
  await assertTopicPublicationReviewLive(review);
  const r = records.get(review);
  if (sourceInputs?.topic?.source !== r.source) fail('P24_LIVE_SOURCE_REQUIRED');
  return { topic_recipe: clone(r.recipe), source_bindings: clone(r.sourceBindings), tool_bindings: clone(r.tools),
    control_snapshot: { schema_version: 'phase24-topic-control-1.0', run_id: review.reviewManifest.identity.run_id,
      evidence_mode: review.reviewManifest.evidence_mode, source_fingerprint: hash(r.recipe) } };
}
export async function rebuildRegisteredTopicReview(recipe, { registration, bundleBytes, trustAnchor } = {}) {
  if (!checkRecipe(recipe)) fail('P24_RECIPE_INVALID', { errors: checkRecipe.errors });
  try {
    const { controller_grant: grant, ...pointer } = registration;
    const key = Buffer.from(trustAnchor.public_key, 'base64');
    if (recipe?.schema_version !== 'phase24-topic-registration-1.0' || trustAnchor.schema_version !== 'phase22-controller-trust-1.0'
      || trustAnchor.vault_root !== recipe.options.vaultRoot || grant.payload.vault_root !== trustAnchor.vault_root
      || trustAnchor.run_id !== grant.payload.run_id || grant.payload.run_id !== recipe.options.operationId
      || grant.payload.kind !== 'registration' || grant.payload.registration_hash !== hash(pointer)
      || grant.key_fingerprint !== sha(key) || sha(bundleBytes) !== pointer.bundle.sha256 || !same(JSON.parse(Buffer.from(bundleBytes)).topic_recipe, recipe)
      || !verify(null, Buffer.from(hash(grant.payload)), createPublicKey({ key, format: 'der', type: 'spki' }), Buffer.from(grant.signature, 'base64'))) fail('P24_REGISTERED_PROOF_REQUIRED');
  } catch { fail('P24_REGISTERED_PROOF_REQUIRED'); }
  const built = await build({ options: recipe.options, base: { snapshot: null, generation: recipe.base.generation, index: recipe.base.index, files: decode(recipe.base.files) },
    preimages: decode(recipe.preimages), restored: true });
  return built.review;
}
