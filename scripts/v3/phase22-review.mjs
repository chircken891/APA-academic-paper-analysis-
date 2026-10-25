import { assertTopicPublicationReviewCurrent } from './topic-publication.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual as same } from 'node:util';
import { canonicalizeV3Json, fingerprintV3Json as hash } from './semantic-package-validator.mjs';
import { assertBilingualParity } from './phase22-parity.mjs';
import { assertRenderedBilingualNotes } from './phase22-render.mjs';
import { inspectManagedNote, mergeManagedNote } from './phase22-managed-markdown.mjs';
import { assertActiveGeneration, assertActiveIndexContract, assertIndexGeneration, verifyIndexPaperBytes, verifyReaderPresentation, readerIndexDocuments } from './phase22-active-version.mjs';
import { getReaderPresentationContent, READER_PROFILE } from './phase221-presentation.mjs';
import { assertReaderReviewCurrent, assertPreparedReaderReviewCurrent } from './phase221-reading-review.mjs';
import { collectLanguageSpans } from './phase22-language.mjs';
import { readPhase22SourceAsset } from './phase22-input.mjs';
import { validatePhase22TargetPath } from './phase22-render-context.mjs';
import { buildReadingFirstPublicationReview, assertReadingFirstPublicationReviewCurrent } from './reading-first-publication.mjs';
import { NOTE_RELOCATION_PROFILE, assertNoteRelocationReviewCurrent } from './note-relocation.mjs';

const records = new WeakMap();
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const fail = (code, path = '/', details = {}) => { throw Object.assign(new Error(code), { code, path, details }); };
const languages = ['en', 'zh-CN'];
const byteArray = (value, path) => {
  if (!(value instanceof Uint8Array)) fail('P22_REVIEW_BYTES_REQUIRED', path);
  return Buffer.from(value);
};
function freeze(value) {
  if (value && typeof value === 'object' && !(value instanceof Uint8Array) && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
function safePath(path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || /[\x00-\x1f<>:"\\|?*#\[\]^]/.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..' || part.trim() !== part || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('P22_REVIEW_PATH_INVALID', '/path', { path });
  return path;
}
function toolManifest() {
  return Object.fromEntries([
    ['renderer', './phase22-render.mjs'], ['merger', './phase22-managed-markdown.mjs'],
    ['review', './phase22-review.mjs'], ['review_schema', '../../Schema/phase22/review-manifest.schema.json'],
  ].map(([name, path]) => [name, name === 'review' ? hash({
    implementation: digest(readFileSync(new URL(path, import.meta.url))),
    active_validator: digest(readFileSync(new URL('./phase22-active-version.mjs', import.meta.url))),
    active_schema: digest(readFileSync(new URL('../../Schema/phase22/active-index.schema.json', import.meta.url))),
  }) : digest(readFileSync(new URL(path, import.meta.url)))]));
}
function inventoryStamp(inventory) {
  return inventory.map(({ bytes, ...entry }) => ({ ...entry, observed_sha256: digest(bytes) }));
}
function descriptor(note) {
  const { bytes, ...metadata } = note;
  return structuredClone(metadata);
}
function jsonBytes(value) { return Buffer.from(canonicalizeV3Json(value) + '\n'); }
function parseJson(bytes, code, path) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail(code, path); }
}


// Validate the frozen05 pair without adding aliases or reserializing producer bytes.
function candidatePair({ index, active, generation, basis, context, views, parity, rendered, output, readDependencies }) {
  const read = (candidate, label) => {
    if (!candidate) return null;
    const bytes = byteArray(candidate.bytes, '/activeSnapshot/' + label);
    if (digest(bytes) !== candidate.byte_sha256) fail('P22_' + label.toUpperCase() + '_BINDING_INVALID');
    return parseJson(bytes, 'P22_' + label.toUpperCase() + '_BYTES_INVALID', '/activeSnapshot/' + label);
  };
  const indexPayload = read(index, 'index'), activePayload = read(active, 'active');
  const canonical = [indexPayload, activePayload].some(value => value && ['schema_version', 'kind', 'generation_id', 'active_fingerprint', 'index_manifest'].some(key => Object.hasOwn(value, key)));
  if (!canonical) {
    // Retained Plan04-only assembly fixtures cannot be treated as a real05 pair.
    if (parity.evidence_mode !== 'synthetic' || (indexPayload && (indexPayload.synthetic_only !== true
      || indexPayload.generation !== generation || !same(indexPayload.documents, index.manifest?.documents)))) fail('P22_SYNTHETIC_INDEX_FIXTURE_REQUIRED');
    return { canonical: false, projection: null };
  }
  if (activePayload) {
    assertActiveGeneration(activePayload);
    if (activePayload.generation_id !== generation || activePayload.evidence_mode !== parity.evidence_mode) fail('P22_ACTIVE_BINDING_INVALID');
  }
  if (indexPayload) {
    assertActiveIndexContract(indexPayload, 'index');
    if (indexPayload.generation_id !== generation || indexPayload.evidence_mode !== parity.evidence_mode) fail('P22_INDEX_BINDING_INVALID');
  }
  if (!activePayload) return { canonical: true, projection: null };
  if (indexPayload) assertIndexGeneration(indexPayload, activePayload);
  const paper = activePayload.papers.find(row => row.paper_id === basis.identity.paper_id);
  if (!paper || paper.pipeline_version !== '3.0' || Object.keys(basis.identity).some(key => paper[key] !== basis.identity[key])
    || paper.core_hash !== inspectManagedNote(rendered.en).frontmatter.core_fingerprint
    || paper.basis_fingerprint !== basis.basis_fingerprint || paper.context_fingerprint !== context.context_fingerprint) fail('P22_ACTIVE_VIEW_BINDING_INVALID');
  const objects = new Map(activePayload.objects.map(object => [object.path, object]));
  for (const entry of output) {
    const object = objects.get(entry.path), kind = entry.kind === 'paper' ? 'v3-note' : entry.kind;
    if (!object || object.kind !== kind || object.sha256 !== (entry.kind === 'paper' ? entry.managed_hash : entry.byte_sha256)) fail('P22_ACTIVE_OBJECT_BINDING_INVALID', '/', { path: entry.path });
  }
  for (const entry of readDependencies) {
    const object = objects.get(entry.path);
    if (!object || object.kind !== 'support' || object.sha256 !== entry.byte_sha256) fail('P22_ACTIVE_OBJECT_BINDING_INVALID', '/', { path: entry.path });
  }
  for (const note of rendered.supportNotes) {
    if (!activePayload.shared_nodes.some(row => row.entity_id === note.entity_id && row.path === note.target_path)) fail('P22_ACTIVE_SUPPORT_BINDING_INVALID');
  }
  for (const language of languages) {
    if (paper.paths[language] !== context.paper_targets[language]
      || paper.view_fingerprints[language] !== parity.dependencies[language === 'en' ? 'en_view' : 'zh_view']) fail('P22_ACTIVE_VIEW_BINDING_INVALID');
    const entry = output.find(row => row.path === paper.paths[language]);
    const binding = verifyIndexPaperBytes(paper, language, entry.bytes, activePayload);
    if (!indexPayload) continue;
    const documents = indexPayload.documents.filter(row => row.paper_id === paper.paper_id && row.language === language);
    const spans = collectLanguageSpans(views[language]);
    if (documents.length !== spans.length + binding.regions.length) fail('P22_INDEX_CONTENT_BINDING_INVALID');
    for (const region of binding.regions) {
      const found = documents.filter(row => row.section_id === region.id && row.span_id === 'section:' + region.id);
      if (found.length !== 1 || found[0].content !== region.content) fail('P22_INDEX_CONTENT_BINDING_INVALID');
    }
    for (const { section_id, span } of spans) {
      const found = documents.filter(row => row.section_id === section_id && row.span_id === span.span_id);
      if (found.length !== 1 || found[0].content !== span.text
        || !same(found[0].unit_ids, [...new Set([...span.semantic_refs, ...span.boundary_refs])])) fail('P22_INDEX_CONTENT_BINDING_INVALID');
    }
  }
  const projection = { generation: activePayload.generation_id, evidence_mode: activePayload.evidence_mode,
    documents: activePayload.papers.filter(row => row.pipeline_version === '3.0').flatMap(row => languages.map(language => ({
      paper_id: row.paper_id, language, target_path: row.paths[language], view_fingerprint: row.view_fingerprints[language], managed_hash: objects.get(row.paths[language]).sha256,
    }))) };
  if (index?.manifest !== undefined && !same(index.manifest, projection)) fail('P22_INDEX_PROJECTION_INVALID');
  return { canonical: true, projection };
}

/** In-memory review assembly. It writes no vault files and grants no publication authority. */
export function buildBilingualReview({ basis, context, views, parity, rendered, presentation, readingReview, readingFirst, existingTargets = [], activeSnapshot = {} } = {}) {
  if (readingFirst) return buildReadingFirstPublicationReview(readingFirst);
  if (presentation) return buildReaderReview({ presentation, readingReview, existingTargets, activeSnapshot });
  const args = { basis, context, views, parity, rendered, existingTargets, activeSnapshot };
  assertBilingualParity(parity, { basis, context, views, currentDependencies: activeSnapshot.currentDependencies });
  assertRenderedBilingualNotes(rendered, { basis, context, views, parity });
  const tools = toolManifest();
  if (!Array.isArray(existingTargets)) fail('P22_REVIEW_PREIMAGES_REQUIRED', '/existingTargets');
  const preimages = new Map(), collisions = new Set();
  for (const target of existingTargets) {
    const path = safePath(target.path), key = path.normalize('NFC').toLowerCase();
    if (collisions.has(key)) fail('P22_REVIEW_TARGET_COLLISION', '/existingTargets', { path });
    collisions.add(key);
    if (target.bytes !== null && !(target.bytes instanceof Uint8Array)) fail('P22_REVIEW_PREIMAGE_REQUIRED', '/existingTargets', { path });
    preimages.set(path, target);
  }
  const generation = activeSnapshot.generation ?? null;
  if (generation !== null && (typeof generation !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(generation))) fail('P22_GENERATION_INVALID');
  const previousGeneration = activeSnapshot.previous_generation ?? null;
  if (generation !== null && generation === previousGeneration) fail('P22_GENERATION_NOT_NEW');
  const output = [], previews = [], readDependencies = [], seen = new Set(), diagnostics = [];
  const preimage = path => {
    if (!preimages.has(path)) fail('P22_REVIEW_PREIMAGE_REQUIRED', '/existingTargets', { path });
    return preimages.get(path);
  };
  const add = (path, kind, bytes, extra = {}) => {
    safePath(path); const key = path.normalize('NFC').toLowerCase();
    if (seen.has(key)) fail('P22_REVIEW_TARGET_COLLISION', '/outputInventory', { path });
    seen.add(key);
    const before = preimage(path), owned = byteArray(bytes, '/outputInventory/' + path);
    const entry = { path, kind, bytes: owned, byte_sha256: digest(owned), byte_length: owned.length,
      before_sha256: before.bytes === null ? null : digest(before.bytes), before_byte_length: before.bytes === null ? null : before.bytes.length, ...extra };
    output.push(entry); return entry;
  };
  for (const language of languages) {
    const path = context.paper_targets[language], candidate = language === 'en' ? rendered.en : rendered.zhCN, before = preimage(path);
    const candidateInfo = inspectManagedNote(candidate);
    if (candidateInfo.frontmatter.language !== language || candidateInfo.frontmatter.paper_id !== basis.identity.paper_id
      || candidateInfo.frontmatter.view_fingerprint !== parity.dependencies[language === 'en' ? 'en_view' : 'zh_view']) fail('P22_REVIEW_VIEW_BINDING_INVALID', '/rendered/' + language);
    if (before.bytes !== null && !before.managedHash) fail('P22_REVIEW_MANAGED_PREIMAGE_REQUIRED', '/existingTargets', { path });
    const merged = mergeManagedNote({ existingBytes: before.bytes, rendered: candidate, expectedManagedHash: before.managedHash });
    const entry = add(path, 'paper', merged.bytes, { language, managed_hash: merged.managedHash, before_managed_hash: before.managedHash ?? null });
    previews.push({ language, path, byte_sha256: entry.byte_sha256, byte_length: entry.byte_length, managed_hash: entry.managed_hash,
      human_ranges: merged.humanRanges.map(range => ({ from: range.from, to: range.to, byte_sha256: digest(range.bytes) })) });
  }
  if (!Array.isArray(rendered.supportNotes) || rendered.supportNotes.length !== context.entityMappings.length) fail('P22_SUPPORT_INVENTORY_INCOMPLETE');
  const supportDescriptors = [];
  for (const note of rendered.supportNotes) {
    const expected = context.entityMappings.find(entity => entity.entity_id === note.entity_id);
    if (!expected || expected.target_path !== note.target_path || expected.disposition !== note.disposition
      || expected.entity_type !== note.entity_type || !same(expected.definition_unit_refs, note.definition_unit_refs)) fail('P22_SUPPORT_DEFINITION_BINDING_INVALID');
    validatePhase22TargetPath(note.target_path);
    if (!note.target_path.startsWith('Wiki/' + (note.entity_type === 'method' ? 'methods' : 'concepts') + '/')) fail('P22_SUPPORT_PATH_INVALID');
    const before = preimage(note.target_path);
    if (note.disposition === 'create') {
      if (before.bytes !== null) fail('P22_SUPPORT_EXISTING_TARGET', '/existingTargets', { path: note.target_path });
      const bytes = byteArray(note.bytes, '/supportNotes/bytes');
      if (digest(bytes) !== note.byte_sha256) fail('P22_SUPPORT_BYTES_INVALIDATED');
      add(note.target_path, 'support', bytes, { entity_id: note.entity_id });
    } else if (note.disposition === 'reuse') {
      const ref = context.existingSupportRefs.find(ref => ref.entity_id === note.entity_id);
      if (note.bytes !== undefined || before.bytes === null || !ref || ref.target_path !== note.target_path
        || digest(before.bytes) !== ref.byte_sha256 || note.byte_sha256 !== ref.byte_sha256
        || ref.definition_fingerprint !== expected.definition_fingerprint) fail('P22_SUPPORT_REUSE_INVALIDATED');
      readDependencies.push({ path: note.target_path, entity_id: note.entity_id, disposition: 'reuse', byte_sha256: ref.byte_sha256,
        byte_length: before.bytes.length, definition_fingerprint: ref.definition_fingerprint });
    } else fail('P22_SUPPORT_DISPOSITION_INVALID');
    supportDescriptors.push(descriptor(note));
  }
  // Both papers must resolve each support target; bindings also cover source-linked content.
  for (const language of languages) {
    const text = (language === 'en' ? rendered.en : rendered.zhCN).toString('utf8');
    for (const note of rendered.supportNotes) {
      const target = note.target_path.replace(/\.md$/, '');
      if (!text.includes('[[' + target + '|') && !text.includes('[[' + target + ']]')
        && !text.includes('[[' + note.target_path + '|') && !text.includes('[[' + note.target_path + ']]')) fail('P22_SUPPORT_TARGET_UNRESOLVED', '/rendered/' + language, { path: note.target_path });
    }
    for (const match of text.matchAll(/!?\[\[(Wiki\/(?:methods|concepts|measures)\/[^\]|#]+)(?:[^\]]*)\]\]/g)) {
      if (!rendered.supportNotes.some(note => note.target_path.replace(/\.md$/, '') === match[1].replace(/\.md$/, ''))) fail('P22_SUPPORT_TARGET_UNRESOLVED', '/rendered/' + language, { path: match[1] });
    }
  }
  if (!Array.isArray(rendered.assets)) fail('P22_ASSET_INVENTORY_REQUIRED');
  const assets = [], registeredAssets = basis.source_presentation?.assets ?? [];
  if (rendered.assets.length !== registeredAssets.length || new Set(rendered.assets.map(asset => asset.asset_id)).size !== registeredAssets.length) fail('P22_ASSET_INVENTORY_INCOMPLETE');
  for (const asset of rendered.assets) {
    const source = readPhase22SourceAsset(basis, asset.asset_id);
    if (Object.hasOwn(asset, 'source_path') || asset.target_path !== source.target_path || asset.byte_sha256 !== source.byte_sha256
      || asset.media_type !== source.media_type || asset.source_order !== source.source_order || !same(asset.source_ref, source.source_ref)) fail('P22_ASSET_SOURCE_BINDING_INVALID');
    const path = safePath(asset.target_path);
    if (!path.startsWith('Figures/')) fail('P22_ASSET_PATH_INVALID');
    if (!(asset.bytes instanceof Uint8Array)) {
      diagnostics.push({ code: 'P22_ASSET_BYTES_REQUIRED', path, details: { source_ref: asset.source_ref ?? null } });
      continue;
    }
    if (digest(asset.bytes) !== asset.byte_sha256 || !Buffer.from(asset.bytes).equals(source.bytes)) fail('P22_ASSET_BYTES_INVALIDATED');
    const entry = add(path, 'asset', asset.bytes, { asset_id: asset.asset_id });
    assets.push({ path, asset_id: asset.asset_id, media_type: asset.media_type, source_order: asset.source_order, source_ref: structuredClone(asset.source_ref),
      content_role_evidence: false, byte_sha256: entry.byte_sha256, byte_length: entry.byte_length });
  }
  const documents = languages.map(language => ({ paper_id: basis.identity.paper_id, language, target_path: context.paper_targets[language],
    view_fingerprint: parity.dependencies[language === 'en' ? 'en_view' : 'zh_view'], managed_hash: previews.find(row => row.language === language).managed_hash }));
  const base = generation === null ? null : '.apa-v3/phase22/generations/' + generation;
  let indexBinding = null, activeBinding = null;
  if (!generation) diagnostics.push({ code: 'P22_GENERATION_REQUIRED', path: '/activeSnapshot/generation' });
  const index = activeSnapshot.candidateIndex, active = activeSnapshot.candidateActive;
  const pair = candidatePair({ index, active, generation, basis, context, views, parity, rendered, output, readDependencies });
  if (!index) diagnostics.push({ code: 'P22_INDEX_REQUIRED', path: '/activeSnapshot/candidateIndex' });
  else {
    const bytes = byteArray(index.bytes, '/activeSnapshot/candidateIndex/bytes'), manifest = pair.projection ?? index.manifest;
    if (digest(bytes) !== index.byte_sha256 || manifest?.generation !== generation || !Array.isArray(manifest.documents)
      || manifest.evidence_mode !== parity.evidence_mode) fail('P22_INDEX_BINDING_INVALID');
    for (const doc of documents) {
      const rows = manifest.documents.filter(row => row.paper_id === doc.paper_id && row.language === doc.language);
      if (rows.length !== 1 || !Object.keys(doc).every(key => rows[0][key] === doc[key])) fail('P22_INDEX_VIEW_BINDING_INVALID');
    }
    indexBinding = { path: base + '/index.json', byte_sha256: index.byte_sha256, manifest_fingerprint: hash(manifest) };
    if (base) add(indexBinding.path, 'index', bytes);
  }
  if (!active) diagnostics.push({ code: 'P22_ACTIVE_REQUIRED', path: '/activeSnapshot/candidateActive' });
  else {
    const bytes = byteArray(active.bytes, '/activeSnapshot/candidateActive/bytes'), payload = parseJson(bytes, 'P22_ACTIVE_BYTES_INVALID', '/activeSnapshot/candidateActive');
    if (!pair.canonical && (digest(bytes) !== active.byte_sha256 || payload.generation !== generation || !Array.isArray(payload.papers))) fail('P22_ACTIVE_BINDING_INVALID');
    if (!pair.canonical) {
    const rows = payload.papers.filter(paper => paper.paper_id === basis.identity.paper_id), paper = rows[0];
    if (rows.length !== 1 || Object.keys(basis.identity).some(key => paper[key] !== basis.identity[key]) || paper.core_fingerprint !== inspectManagedNote(rendered.en).frontmatter.core_fingerprint
      || documents.some(doc => paper.views?.[doc.language]?.path !== doc.target_path || paper.views?.[doc.language]?.managed_hash !== doc.managed_hash)) fail('P22_ACTIVE_VIEW_BINDING_INVALID');
    }
    activeBinding = { path: base + '/active.json', byte_sha256: active.byte_sha256 };
    if (base) add(activeBinding.path, 'active', bytes);
  }
  const scientificReviewHash = hash({ basis: basis.basis_fingerprint, context: context.context_fingerprint, terms: context.terms_fingerprint,
    views: { en: parity.dependencies.en_view, 'zh-CN': parity.dependencies.zh_view }, parity: parity.parity_fingerprint,
    semantic_review: parity.semantic_review_fingerprint, semantic_review_receipt: parity.semantic_review_receipt });
  const complete = diagnostics.length === 0, reviewReady = complete && parity.review_ready && parity.evidence_mode === 'actual';
  const status = !complete ? 'not_approvable' : reviewReady ? 'review_ready' : 'synthetic_prepared';
  const reviewManifest = {
    schema_version: 'phase22/review-manifest-1.0', identity: basis.identity, status, evidence_mode: parity.evidence_mode,
    review_ready: reviewReady, publishable: false, scientific_review_hash: scientificReviewHash,
    basis_fingerprint: basis.basis_fingerprint, context_fingerprint: context.context_fingerprint, parity_fingerprint: parity.parity_fingerprint,
    generation, previous_generation: previousGeneration, previews, support_notes: supportDescriptors, assets, read_dependencies: readDependencies,
    dependencies: { ...basis.invalidation_dependencies, ...parity.dependencies }, tools,
    index: indexBinding, active: activeBinding,
    // The manifest does not embed its own physical hash or the final output hash.
    write_set: output.map(({ bytes, ...entry }) => entry), diagnostics,
    provenance_limits: { ...basis.provenance_limits, ...parity.provenance_limits },
  };
  if (base) add(base + '/manifest.json', 'manifest', jsonBytes(reviewManifest));
  output.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const bundleHash = hash({ reviewManifest, outputs: inventoryStamp(output), read_dependencies: readDependencies });
  const hashes = { scientific_review_hash: scientificReviewHash, review_bundle_hash: bundleHash,
    output_inventory_hash: complete ? hash({ generation, previous_generation: previousGeneration, output: inventoryStamp(output), read_dependencies: readDependencies }) : null };
  const result = freeze({ ok: complete, status, reviewManifest, outputInventory: output, hashes, diagnostics });
  records.set(result, { args, stamp: hash({ reviewManifest, inventory: inventoryStamp(output), hashes }), tools,
    preimages: hash([...preimages].filter(([path]) => output.some(row => row.path === path) || readDependencies.some(row => row.path === path))
      .map(([path, value]) => ({ path, sha256: value.bytes === null ? null : digest(value.bytes), managedHash: value.managedHash ?? null })).sort((a, b) => a.path.localeCompare(b.path))) });
  return result;
}

/** Revalidate a prepared in-memory review; exact authorization still belongs to the publisher. */
export function assertBilingualReviewCurrent(review, currentArgs) {
  if (review?.reviewManifest?.profile === 'phase24-topic-1.0') return assertTopicPublicationReviewCurrent(review);
  if (review?.reviewManifest?.profile === NOTE_RELOCATION_PROFILE) return assertNoteRelocationReviewCurrent(review);
  if (review?.reviewManifest?.profile === 'reading-first-obsidian-1.0') return assertReadingFirstPublicationReviewCurrent(review);
  const record = records.get(review);
  if (!record) fail('P22_REVIEW_NOT_OWNED');
  if (record.reader) return assertReaderPackageCurrent(review, currentArgs ?? record.args);
  if (record.stamp !== hash({ reviewManifest: review.reviewManifest, inventory: inventoryStamp(review.outputInventory), hashes: review.hashes })) fail('P22_REVIEW_OUTPUT_INVALIDATED');
  if (!same(record.tools, toolManifest())) fail('P22_REVIEW_TOOL_INVALIDATED');
  const args = currentArgs ?? record.args;
  const relevant = args.existingTargets.filter(target => review.outputInventory.some(row => row.path === target.path) || review.reviewManifest.read_dependencies.some(row => row.path === target.path));
  const preimages = hash(relevant.map(value => ({ path: value.path, sha256: value.bytes === null ? null : digest(value.bytes), managedHash: value.managedHash ?? null })).sort((a, b) => a.path.localeCompare(b.path)));
  if (preimages !== record.preimages) fail('P22_REVIEW_PREIMAGE_INVALIDATED');
  const current = buildBilingualReview(args);
  if (!same(current.hashes, review.hashes)) fail('P22_REVIEW_DEPENDENCY_INVALIDATED');
  return review;
}

/** Reader packages consume already-merged producer bytes and owned final-page judgments. */
async function buildReaderReview(args) {
  const { presentation, readingReview, existingTargets, activeSnapshot } = args;
  const data = await getReaderPresentationContent(presentation), manifest = presentation.manifest;
  if (!readingReview?.prepared || !readingReview.review) fail('P221_REVIEW_ASSESSMENT_REQUIRED');
  const prepared = await assertPreparedReaderReviewCurrent(readingReview.prepared);
  const checked = await assertReaderReviewCurrent({ ...readingReview, presentation });
  if (!checked.current || prepared.presentation_sha256 !== digest(presentation.presentationBytes)
    || !same(prepared.identity, manifest.identity) || !same(prepared.dependencies, manifest.dependencies)) fail('P221_REVIEW_READING_BINDING_INVALID');
  for (const language of languages) {
    const bytes = presentation[language === 'en' ? 'en' : 'zhCN'];
    if (prepared.pages.find(row => row.language === language)?.byte_sha256 !== digest(bytes)) fail('P221_REVIEW_FINAL_BYTES_MISMATCH');
  }
  if (!Array.isArray(existingTargets)) fail('P22_REVIEW_PREIMAGES_REQUIRED');
  const preimages = new Map(), seen = new Set(), output = [], readDependencies = [], previews = [];
  for (const row of existingTargets) {
    const path = safePath(row.path), key = path.normalize('NFC').toLowerCase();
    if (seen.has(key)) fail('P22_REVIEW_TARGET_COLLISION');
    if (row.bytes !== null && !(row.bytes instanceof Uint8Array)) fail('P22_REVIEW_PREIMAGE_REQUIRED');
    seen.add(key); preimages.set(path, row);
  }
  seen.clear();
  const before = path => {
    if (!preimages.has(path)) fail('P22_REVIEW_PREIMAGE_REQUIRED', '/', { path });
    return preimages.get(path);
  };
  const add = (path, kind, bytes, extra = {}) => {
    safePath(path); const key = path.normalize('NFC').toLowerCase();
    if (seen.has(key)) fail('P22_REVIEW_TARGET_COLLISION');
    seen.add(key); const original = before(path), owned = byteArray(bytes, path);
    const row = { path, kind, bytes: owned, byte_sha256: digest(owned), byte_length: owned.length,
      before_sha256: original.bytes === null ? null : digest(original.bytes), before_byte_length: original.bytes?.length ?? null, ...extra };
    output.push(row); return row;
  };
  for (const language of languages) {
    const path = manifest.targets.notes[language].path, bytes = presentation[language === 'en' ? 'en' : 'zhCN'];
    const prior = before(path), info = inspectManagedNote(bytes);
    if (prior.bytes !== null && (!prior.managedHash || inspectManagedNote(prior.bytes).managedHash !== prior.managedHash)) fail('P22_REVIEW_MANAGED_PREIMAGE_REQUIRED');
    // This is a preservation check only. Never replace the already-reviewed bytes with a second merge.
    if (prior.bytes !== null && !mergeManagedNote({ existingBytes: prior.bytes, rendered: bytes, expectedManagedHash: prior.managedHash }).bytes.equals(bytes)) fail('P221_REVIEW_HUMAN_PREIMAGE_MISMATCH');
    const row = add(path, 'paper', bytes, { language, managed_hash: info.managedHash, before_managed_hash: prior.managedHash ?? null });
    previews.push({ language, path, byte_sha256: row.byte_sha256, byte_length: row.byte_length, managed_hash: info.managedHash,
      human_ranges: info.humanRanges.map(range => ({ from: range.from, to: range.to, byte_sha256: digest(range.bytes) })) });
  }
  for (const note of presentation.supportNotes) {
    const path = note.target_path ?? note.path;
    if (note.disposition === 'reuse') {
      const prior = before(path);
      if (prior.bytes === null || digest(prior.bytes) !== note.byte_sha256) fail('P22_SUPPORT_REUSE_INVALIDATED');
      readDependencies.push({ path, entity_id: note.entity_id, disposition: 'reuse', byte_sha256: note.byte_sha256, byte_length: prior.bytes.length, definition_fingerprint: note.definition_fingerprint });
    } else {
      if (before(path).bytes !== null) fail('P22_SUPPORT_EXISTING_TARGET');
      add(path, 'support', note.bytes);
    }
  }
  for (const asset of presentation.assets) add(asset.target_path, 'asset', asset.bytes, { asset_id: asset.asset_id });
  for (const row of presentation.readingRecords) add(row.target_path, 'reader-record', row.bytes, { language: row.language });
  if (presentation.stylesheet) add(presentation.stylesheet.path, 'reader-style', presentation.stylesheet.bytes);
  const presentationRow = add(manifest.targets.presentation, 'reader-presentation', presentation.presentationBytes);
  const readingPath = '.apa-v3/phase221/reading-review/' + prepared.prepared_fingerprint.slice(7) + '.json';
  const readingRow = add(readingPath, 'reading-review', jsonBytes(readingReview.review));
  const generation = activeSnapshot.generation, previousGeneration = activeSnapshot.previous_generation ?? null;
  if (typeof generation !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(generation)) fail('P22_GENERATION_INVALID');
  if (generation === previousGeneration) fail('P22_GENERATION_NOT_NEW');
  const readCandidate = name => {
    const candidate = activeSnapshot[name];
    if (!candidate?.bytes || digest(candidate.bytes) !== candidate.byte_sha256) fail('P221_REVIEW_PAIR_REQUIRED');
    return parseJson(candidate.bytes, 'P221_REVIEW_PAIR_INVALID', name);
  };
  const active = assertActiveGeneration(readCandidate('candidateActive')), index = readCandidate('candidateIndex');
  assertIndexGeneration(index, active);
  const mode = readingReview.review.evidence_mode;
  if (active.generation_id !== generation || active.evidence_mode !== mode || mode !== data.qualification.evidence_mode) fail('P221_REVIEW_GENERATION_BINDING_INVALID');
  const paper = active.papers.find(row => row.paper_id === manifest.identity.paper_id);
  if (!paper || paper.profile !== READER_PROFILE || paper.core_hash !== hash(data.core)) fail('P221_REVIEW_PAPER_BINDING_INVALID');
  verifyReaderPresentation(paper, presentation.presentationBytes, active);
  const documents = readerIndexDocuments({ paper, presentation: manifest, notes: { en: presentation.en, 'zh-CN': presentation.zhCN }, generation: active, readingRecords: presentation.readingRecords }).sort((a, b) => a.id.localeCompare(b.id));
  if (!same(index.documents.filter(row => row.paper_id === paper.paper_id), documents)) fail('P221_REVIEW_INDEX_CONTENT_INVALID');
  const objects = new Map(active.objects.map(row => [row.path, row]));
  for (const row of [...output, ...readDependencies]) {
    const object = objects.get(row.path), kind = row.kind === 'paper' ? 'v3-note' : row.kind ?? 'support';
    if (!object || object.kind !== kind || object.sha256 !== (row.managed_hash ?? row.byte_sha256)) fail('P221_REVIEW_OBJECT_BINDING_INVALID', '/', { path: row.path });
  }
  const base = '.apa-v3/phase22/generations/' + generation;
  const indexRow = add(base + '/index.json', 'index', activeSnapshot.candidateIndex.bytes);
  const activeRow = add(base + '/active.json', 'active', activeSnapshot.candidateActive.bytes);
  const scientificReviewHash = hash({ dependencies: data.dependencies, qualification: data.qualification });
  const ready = mode === 'actual' && checked.accepted;
  const diagnostics = ready ? [] : [{ code: 'P221_READING_NOT_ACCEPTED', path: '/reading_gates', details: { gates: checked.gates } }];
  const status = mode === 'synthetic' ? 'synthetic_prepared' : ready ? 'review_ready' : 'not_approvable';
  const tools = { ...toolManifest(), ...prepared.review_tools, ...manifest.dependencies.reader_tools };
  const reviewManifest = { schema_version: 'phase22/review-manifest-1.0', profile: READER_PROFILE, identity: manifest.identity,
    status, evidence_mode: mode, review_ready: ready, publishable: false, scientific_review_hash: scientificReviewHash,
    generation, previous_generation: previousGeneration, previews, dependencies: manifest.dependencies, tools,
    reading_gates: checked.gates, reading_accepted: checked.accepted,
    presentation: { path: presentationRow.path, byte_sha256: presentationRow.byte_sha256 },
    reading_review: { path: readingRow.path, byte_sha256: readingRow.byte_sha256, prepared_fingerprint: prepared.prepared_fingerprint },
    read_dependencies: readDependencies, index: { path: indexRow.path, byte_sha256: indexRow.byte_sha256 },
    active: { path: activeRow.path, byte_sha256: activeRow.byte_sha256 }, write_set: output.map(({ bytes, ...row }) => row), diagnostics,
    provenance_limits: data.qualification.provenance_limits ?? {} };
  add(base + '/manifest.json', 'manifest', jsonBytes(reviewManifest));
  output.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const hashes = { scientific_review_hash: scientificReviewHash, review_bundle_hash: hash({ reviewManifest, outputs: inventoryStamp(output), read_dependencies: readDependencies }),
    output_inventory_hash: hash({ generation, previous_generation: previousGeneration, output: inventoryStamp(output), read_dependencies: readDependencies }) };
  const result = freeze({ ok: true, status, reviewManifest, outputInventory: output, hashes, diagnostics });
  records.set(result, { reader: true, args, stamp: hash({ reviewManifest, inventory: inventoryStamp(output), hashes }) });
  return result;
}

async function assertReaderPackageCurrent(review, args) {
  const record = records.get(review);
  if (record.stamp !== hash({ reviewManifest: review.reviewManifest, inventory: inventoryStamp(review.outputInventory), hashes: review.hashes })) fail('P22_REVIEW_OUTPUT_INVALIDATED');
  const current = await buildReaderReview(args);
  if (!same(current.hashes, review.hashes)) fail('P22_REVIEW_DEPENDENCY_INVALIDATED');
  return review;
}
