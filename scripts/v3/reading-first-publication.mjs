import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import YAML from 'yaml';
import { fingerprintV3Json as hash } from './semantic-package-validator.mjs';
import { inspectManagedNote, mergeManagedNote } from './phase22-managed-markdown.mjs';
import { readCommittedGeneration, assertActiveGeneration, assertIndexGeneration, phase22GenerationPaths,
  readRegisteredCommit, INDEX_READING_FIRST_PROFILE } from './phase22-active-version.mjs';
import { buildBilingualIndex } from './phase22-search.mjs';
import { assertReadingFirstPublicationManifest, verifyReadingFirstPresentation } from './reading-first-index.mjs';
import { captureReadingFirstPublicationSource, createExternalReadingFirstPublicationSource,
  getReadingFirstRuntimePublicationToolBindings, inspectReadingFirstPublicationSource,
  restoreReadingFirstPublicationSource } from './reading-first-runtime.mjs';
import { createPhase22ContractValidator } from './phase22-contract-loader.mjs';
import { readOwnedArtifact } from './owned-artifact-store.mjs';
import { renderReadingFirstObsidian } from './reading-first-obsidian.mjs';

export { deriveRebasedReadingFirstPublicationSource } from './reading-first-runtime.mjs';

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
  return ['./reading-first-publication.mjs', './reading-resources.mjs', './phase22-publication.mjs', './phase22-review.mjs',
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
function metadataMigrations(rows, candidate) {
  if (!Array.isArray(rows)) fail('RF_PUBLICATION_METADATA_MIGRATION_INVALID');
  const result = new Map();
  for (const row of rows) {
    if (!row || !same(Object.keys(row).sort(), ['candidate_sha256', 'before_sha256', 'output_sha256', 'path'].sort())
      || !candidate.supportNotes?.some(note => note.path === row.path) || result.has(row.path)
      || ['before_sha256', 'candidate_sha256', 'output_sha256'].some(key => !/^sha256:[a-f0-9]{64}$/.test(row[key]))) fail('RF_PUBLICATION_METADATA_MIGRATION_INVALID');
    result.set(row.path, clone(row));
  }
  return result;
}
function migrateKnowledgeMetadata(bytes, path) {
  const text = bytes.toString('utf8'), front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const metadata = front && YAML.parse(front[1]);
  if (!metadata || metadata.pipeline_version !== '2.0.0' || metadata.graph_scope !== 'v2-canonical'
    || !/^pipeline_version: 2\.0\.0\r?$/m.test(front[0]) || !/^graph_scope: v2-canonical\r?$/m.test(front[0])) fail('RF_PUBLICATION_METADATA_MIGRATION_INVALID', { path });
  const header = front[0].replace(/^pipeline_version: 2\.0\.0\r?$/m, 'pipeline_version: "3.0"')
    .replace(/^graph_scope: v2-canonical\r?$/m, 'graph_scope: v3-candidate');
  return Buffer.from(header + text.slice(front[0].length));
}
async function baseFor(root, currentPolicy = false) {
  if (regularBytes(root, '.apa-v3/phase22/COMMITTED.json', { missing: true }) === null) return { snapshot: null, generation: null, index: null, files: new Map() };
  if (currentPolicy) {
    const registered = await readRegisteredCommit({ vaultRoot: root });
    if (!registered.ok) fail('RF_PUBLICATION_PREVIOUS_GENERATION_INVALID', { errors: registered.errors });
    // Registered Wiki notes accept later human edits; every other registered object must keep its committed bytes.
    const files = new Map(registered.generation.objects.map(row => {
      const bytes = regularBytes(root, row.path);
      if (!row.path.startsWith('Wiki/') && sha(bytes) !== row.sha256) fail('RF_PUBLICATION_PREVIOUS_OBJECT_CHANGED', { path: row.path });
      return [row.path, bytes];
    }));
    return { snapshot: null, generation: clone(registered.generation), index: clone(registered.index), carryHistoricalDocuments: true, files };
  }
  const snapshot = await readCommittedGeneration({ vaultRoot: root });
  if (!snapshot.ok) fail('RF_PUBLICATION_PREVIOUS_GENERATION_INVALID', { errors: snapshot.errors });
  return { snapshot, generation: clone(snapshot.generation), index: clone(snapshot.index),
    files: new Map(snapshot.generation.objects.map(row => [row.path, regularBytes(root, row.path)])) };
}
async function integratorVisualResources(data, resources) {
  if (data.recipe.schema_version !== 'reading-first-publication-source-1.0') return [];
  if (data.recipe.binding?.configured_setup?.results_resources) {
    const manifest = data.results_resource_manifest;
    if (!manifest || !data.source_bindings.some(row => row.path === manifest.path
      && row.sha256 === manifest.sha256 && row.byte_length === manifest.byte_length)) fail('RF_PUBLICATION_RESOURCE_MANIFEST_INVALID');
    return manifest.resources.map(row => ({ id: row.id, locator: row.locator, path: row.path, source_id: row.source_id, source_path: row.parent.path,
      source_sha256: row.parent.sha256, sha256: row.sha256, byte_length: row.byte_length, image_source_path: row.source_path }));
  }
  const artifacts = await Promise.all(data.recipe.scientific_input.role_artifacts.map(artifactId =>
    readOwnedArtifact({ artifactRoot: data.recipe.artifact_root, artifactId })));
  const integrated = artifacts.filter(row => row?.receipt.role === 'integration' && row.receipt.run_id === data.identity.run_id);
  if (integrated.length !== 1) return [];
  const value = JSON.parse(integrated[0].bytes);
  if (Array.isArray(value.visual_resources)) return value.visual_resources;
  if (!Array.isArray(value.resource_handoff?.asset_mapping)) {
    if (!Array.isArray(value.visual_handoff?.registered_resources)) return [];
    return value.visual_handoff.registered_resources.flatMap(row => {
      const declarations = [[row.source_pdf, row.source_sha256], [row.source_docx, row.source_docx_sha256]]
        .filter(([path, digest]) => typeof path === 'string' && isAbsolute(path)
          && typeof digest === 'string' && /^(?:sha256:)?[a-f0-9]{64}$/.test(digest));
      if (declarations.length !== 1) return [];
      const [parentPath, digest] = declarations[0];
      const parentHash = digest.startsWith('sha256:') ? digest : 'sha256:' + digest;
      const parents = data.sources.filter(source => resolve(source.path) === resolve(parentPath)
        && source.sha256 === parentHash && (row.source_id === undefined || row.source_id === source.id));
      if (parents.length !== 1) return [];
      const parent = parents[0];
      const targets = resources.filter(resource => /^Raw\//.test(resource.path)
        && typeof resource.source_path === 'string' && isAbsolute(resource.source_path)
        && resolve(resource.source_path) === resolve(parent.path)
        && resource.sha256 === parent.sha256 && resource.byte_length === parent.byte_length);
      if (targets.length !== 1) return [];
      return [{ path: row.path, source_id: parent.id, source_path: targets[0].path,
        source_sha256: parent.sha256, sha256: row.sha256, byte_length: row.byte_length,
        image_source_path: row.source_path ?? null }];
    });
  }
  return value.resource_handoff.asset_mapping.map(row => {
    const parent = data.sources.find(source => source.id === row.source_id && source.sha256 === row.source_pdf_sha256);
    return { path: row.target_path, source_id: row.source_id, source_path: parent?.path,
      source_sha256: row.source_pdf_sha256, sha256: row.sha256, byte_length: row.byte_length,
      image_source_path: row.source_path ?? null };
  });
}

function presentationAssetRegistrations(data, resources, approvals = []) {
  try {
    if (!Array.isArray(approvals)) throw new Error('approval references required');
    const checked = ref => {
      if (!ref || typeof ref.path !== 'string' || !isAbsolute(ref.path)) throw new Error('absolute approval path required');
      const current = binding(ref.path);
      if (current.sha256 !== ref.sha256 || current.byte_length !== ref.byte_length) throw new Error('approval bytes changed');
      return current;
    };
    const paths = new Set();
    return approvals.map(ref => {
      const approvalBinding = checked(ref);
      const value = JSON.parse(readFileSync(approvalBinding.path, 'utf8'));
      const candidateBinding = checked(value.approved_candidate);
      const candidate = JSON.parse(readFileSync(candidateBinding.path, 'utf8'));
      const { resource, scientific_parent: parent } = value;
      if (value.schema_version !== 'reading-first-presentation-asset-approval-1.0'
        || !identifier(value.authorization_id) || typeof value.user_reply !== 'string' || !value.user_reply.trim()
        || value.run_id !== data.identity.run_id || value.presentation_fingerprint !== data.candidate.presentation_fingerprint
        || candidate.run_id !== value.run_id || !same(candidate.resource, resource) || !same(candidate.scientific_parent, parent)
        || !resource || !/^Raw\/.+\.pdf$/i.test(resource.path) || paths.has(resource.path)
        || typeof resource.source_path !== 'string' || !isAbsolute(resource.source_path)
        || !data.candidate.assetPaths.includes(resource.path) || resource.path === data.presentation.source_pdf
        || !data.presentation.sources?.some(row => row.id === parent?.source_id && row.path === resource.path)
        || !resources.some(row => same(row, resource))) throw new Error('approval scope mismatch');
      const parents = data.sources.filter(row => row.id === parent.source_id && row.sha256 === parent.sha256
        && typeof parent.path === 'string' && isAbsolute(parent.path) && resolve(row.path) === resolve(parent.path));
      if (parents.length !== 1) throw new Error('scientific parent mismatch');
      const targets = resources.filter(row => /^Raw\//.test(row.path) && typeof row.source_path === 'string'
        && isAbsolute(row.source_path) && resolve(row.source_path) === resolve(parents[0].path)
        && row.sha256 === parents[0].sha256 && row.byte_length === parents[0].byte_length);
      if (targets.length !== 1) throw new Error('original source resource required');
      paths.add(resource.path);
      return { ...value, approved_candidate: candidateBinding, approval_binding: approvalBinding, parent_resource_path: targets[0].path };
    });
  } catch { fail('RF_PUBLICATION_PRESENTATION_ASSET_APPROVAL_INVALID'); }
}

async function resourceBindings(data, resources, approvedAssets = []) {
  if (!Array.isArray(resources)) fail('RF_PUBLICATION_RESOURCES_REQUIRED');
  const registered = [...data.sources, ...data.presentation_assets, ...data.enrichment_sources,
    ...approvedAssets.map(row => ({ ...row.resource, path: row.resource.source_path }))];
  const paths = new Set(), parentPaths = new Set(approvedAssets.map(row => row.parent_resource_path)), result = [];
  let ownedVisuals;
  const manifestRequired = Boolean(data.recipe.binding?.configured_setup?.results_resources);
  if (manifestRequired) ownedVisuals = await integratorVisualResources(data, resources);
  for (const resource of resources) {
    safePath(resource.path);
    if (paths.has(resource.path) || !/^(Raw|Figures)\//.test(resource.path) || typeof resource.source_path !== 'string') fail('RF_PUBLICATION_RESOURCE_INVALID');
    paths.add(resource.path);
    const found = registered.find(row => resolve(row.path) === resolve(resource.source_path)
      && row.sha256 === resource.sha256 && row.byte_length === resource.byte_length);
    if (!found) {
      // Use the reviewed catalogue or its accepted Integrator artifact to bind
      // image bytes and the exact registered parent PDF without changing the candidate.
      let visuals = manifestRequired ? [] : (data.candidate.visual_resources ?? []).filter(row => row.path === resource.path
        && row.sha256 === resource.sha256 && row.byte_length === resource.byte_length);
      if (!visuals.length) {
        ownedVisuals ??= await integratorVisualResources(data, resources);
        const shown = (data.candidate.visual_resources ?? []).find(row => row.path === resource.path);
        visuals = ownedVisuals.filter(row => row.path === resource.path && row.sha256 === resource.sha256
          && row.byte_length === resource.byte_length && shown?.source_id === row.source_id
          && (!manifestRequired || shown.id === row.id && same(shown.locator, row.locator))
          && (row.image_source_path === undefined || typeof row.image_source_path === 'string' && isAbsolute(row.image_source_path)
            && resolve(row.image_source_path) === resolve(resource.source_path)));
      }
      const visual = visuals.length === 1 ? visuals[0] : null;
      const parent = visual && data.sources.find(row => row.id === visual.source_id && row.sha256 === visual.source_sha256);
      const parentTarget = parent && typeof visual.source_path === 'string' && isAbsolute(visual.source_path)
        && resolve(visual.source_path) === resolve(parent.path)
        ? (data.presentation.sources ?? []).find(row => row.id === parent.id)?.path : visual?.source_path;
      const parentResource = parent && resources.find(row => row.path === parentTarget
        && typeof row.source_path === 'string' && resolve(row.source_path) === resolve(parent.path)
        && row.sha256 === parent.sha256 && row.byte_length === parent.byte_length);
      if (!parentResource) fail('RF_PUBLICATION_RESOURCE_UNREGISTERED', { path: resource.path });
      parentPaths.add(parentResource.path);
    }
    const current = binding(resource.source_path);
    if (current.sha256 !== resource.sha256 || current.byte_length !== resource.byte_length) fail('RF_PUBLICATION_RESOURCE_CHANGED', { path: resource.path });
    result.push({ ...clone(resource), source_path: current.path });
  }
  const expected = [...new Set([...(data.candidate.assetPaths ?? []), ...parentPaths])].sort();
  if (!same([...paths].sort(), expected)) fail('RF_PUBLICATION_RESOURCE_INVENTORY_INCOMPLETE');
  return result;
}
function publicationCitation(data, resources, approvals = []) {
  const catalog = data.presentation;
  if (!catalog) return undefined;
  const resource = resources.find(row => row.path === catalog.source_pdf);
  const source = resource && data.sources.find(row => resolve(row.path) === resource.source_path
    && row.sha256 === resource.sha256 && row.byte_length === resource.byte_length);
  if (!source) fail('RF_PUBLICATION_CITATION_SOURCE_UNREGISTERED');
  // Each visual cites its own source: the registered original, or an approved derived display asset of that source.
  const visuals = catalog.visuals ?? [];
  const configured22 = data.recipe.binding?.configured_setup?.instruction_profile === 'configured-reading-2.2';
  const ids = [...new Set([source.id, ...visuals.map(row => row.source_id ?? source.id)])];
  return { bibliography: clone(catalog.bibliography), sources: ids.map(id => {
    const original = data.sources.find(row => row.id === id);
    const path = id === source.id ? catalog.source_pdf : catalog.sources?.find(row => row.id === id)?.path;
    const approved = approvals.find(row => row.scientific_parent?.source_id === id && row.resource?.path === path);
    // Pre-2.2 bindings registered display PDFs as input assets; 2.2 requires the original or an approved derived asset.
    const registeredAsset = row => id !== source.id && !configured22 && data.presentation_assets.some(asset => resolve(asset.path) === resolve(row.source_path)
      && asset.sha256 === row.sha256 && asset.byte_length === row.byte_length);
    const target = approved ? resources.find(row => row.path === approved.resource.path && row.sha256 === approved.resource.sha256
      && row.byte_length === approved.resource.byte_length && resolve(row.source_path) === resolve(approved.resource.source_path))
      : resources.find(row => row.path === path && (original && resolve(row.source_path) === resolve(original.path)
        && row.sha256 === original.sha256 && row.byte_length === original.byte_length || registeredAsset(row)));
    if (!target || !original) fail('RF_PUBLICATION_CITATION_SOURCE_UNREGISTERED');
    return { source_id: id, path: target.path, sha256: target.sha256, byte_length: target.byte_length,
      source_version: typeof original.version === 'string' ? original.version : null,
      locators: visuals.filter(row => (row.source_id ?? source.id) === id).map(row => row.locator?.kind === 'docx-figure'
        ? { kind: row.kind, id: row.id, label: clone(row.label), locator: clone(row.locator) }
        : { kind: row.kind, id: row.id, page: row.locator?.kind === 'pdf-page' ? row.locator.page : row.page, label: clone(row.label) }) };
  }) };
}

/** Prepare the exact accepted reading output for the existing V3 publication transaction. */
export async function buildReadingFirstPublicationReview({ source, vaultRoot, generation, evidenceMode = 'actual', resources, knowledgeMetadataMigrations, presentationAssetRegistrations: assetApprovals } = {}) {
  const data = await inspectReadingFirstPublicationSource(source);
  if (data.origin !== 'live') fail('RF_PUBLICATION_LIVE_SOURCE_REQUIRED');
  const root = rootPath(vaultRoot);
  const policy = data.recipe.binding?.configured_setup?.knowledge_registry;
  const currentPolicy = policy?.policy === 'current-shared-nodes-1.0' && resolve(policy.vault_root) === root;
  const base = await baseFor(root, currentPolicy);
  const approvedAssets = presentationAssetRegistrations(data, resources, assetApprovals);
  const options = { vaultRoot: root, generation, evidenceMode, resources: await resourceBindings(data, resources, approvedAssets),
    ...(approvedAssets.length ? { presentationAssetRegistrations: approvedAssets } : {}),
    ...(knowledgeMetadataMigrations === undefined ? {} : { knowledgeMetadataMigrations: clone(knowledgeMetadataMigrations) }) };
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
    if (!/^Wiki\/(sources|translations)\/[^/]+\.md$/.test(path)) fail('RF_PUBLICATION_NOTE_PATH_INVALID');
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
  const migrations = metadataMigrations(options.knowledgeMetadataMigrations ?? [], candidate);
  for (const note of candidate.supportNotes ?? []) {
    const path = safePath(note.path), reviewed = Buffer.from(note.content), original = before(path), migration = migrations.get(path);
    if (!/^Wiki\/(methods|concepts)\/[^/]+\.md$/.test(path)) fail('RF_PUBLICATION_SUPPORT_PATH_INVALID');
    if (data.recipe.binding?.configured_setup?.knowledge_registry?.policy === 'current-shared-nodes-1.0' && original !== null && !migration) {
      const matches = ((data.recipe.knowledge_rebase?.rendering ?? data.recipe.rendering)?.knowledgeRegistry ?? []).filter(row => row.path === path || row.canonical_path === path);
      if (matches.length !== 1 || matches[0].current_content !== true || typeof matches[0].content !== 'string'
        || sha(Buffer.from(matches[0].content)) !== matches[0].content_sha256
        || sha(original) !== matches[0].content_sha256) {
        fail('RF_PUBLICATION_KNOWLEDGE_CHANGED_SINCE_RENDER', { path, action: 'refresh_candidate', next: 'deriveRebasedReadingFirstPublicationSource' });
      }
    }
    let bytes = reviewed, comparison = original;
    if (migration) {
      if (original === null || sha(original) !== migration.before_sha256 || sha(reviewed) !== migration.candidate_sha256) fail('RF_PUBLICATION_METADATA_MIGRATION_MISMATCH', { path });
      bytes = migrateKnowledgeMetadata(reviewed, path);
      comparison = migrateKnowledgeMetadata(original, path);
      if (sha(bytes) !== migration.output_sha256) fail('RF_PUBLICATION_METADATA_MIGRATION_MISMATCH', { path });
    }
    requireV3Knowledge(bytes, path);
    if (comparison !== null && !comparison.equals(bytes)) { requireV3Knowledge(comparison, path); sameHumanKnowledge(comparison, bytes); }
    const entityId = shared.get(path)?.entity_id ?? 'rf_' + hash({ path }).slice(7, 39);
    shared.set(path, { entity_id: entityId, path });
    supportTargets.push({ entity_id: entityId, path });
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
    reading_review: data.reading_review_fingerprint, presentation: candidate.presentation_fingerprint,
    ...(data.recipe.knowledge_rebase ? { knowledge_rebase: data.recipe.knowledge_rebase.rebase_fingerprint } : {}) };
  if (options.presentationAssetRegistrations?.length) dependencies.presentation_asset_registrations = hash(options.presentationAssetRegistrations);
  const manifestPath = '.apa-v3/reading-first/presentation/' + identity.run_id + '-' + hash(identity).slice(7, 31) + '.json';
  const presentation = { schema_version: 'reading-first-publication-1.0', profile, identity,
    presentation_fingerprint: candidate.presentation_fingerprint, scientific_input_fingerprint: data.scientific_input_fingerprint,
    evidence_mode: options.evidenceMode, dependencies, qualification: { reading_status: 'reading_complete', native_status: data.native_presentation.status },
    targets: { presentation: manifestPath, notes: noteTargets, support: supportTargets, assets: options.resources.map(row => row.path) }, navigation: [] };
  const citation = publicationCitation(data, options.resources, options.presentationAssetRegistrations ?? []);
  if (citation) presentation.citation = citation;
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
    ...(base.generation?.topics ? { topics: clone(base.generation.topics) } : {}),
    ...(base.generation?.source_events ? { source_events: clone(base.generation.source_events) } : {}),
    objects: [...objects.values()].sort((a, b) => a.path.localeCompare(b.path)), shared_nodes: [...shared.values()].sort((a, b) => a.path.localeCompare(b.path)) };
  assertActiveGeneration(active);
  const finalFiles = [...files].map(([path, bytes]) => ({ path, bytes }));
  const built = await buildBilingualIndex({ validatedInputs: { papers: [{ readingFirst: presentation,
    notes: Object.fromEntries(candidate.notes.map(note => [note.language, Buffer.from(note.content)])) }], files: finalFiles,
    ...(base.carryHistoricalDocuments ? { carryHistoricalDocuments: true } : {}),
    ...(base.snapshot ? { previousSnapshot: base.snapshot } : base.generation ? { previousPrepared: { generation: base.generation, index: base.index } } : {}) }, generation: active });
  const pairPaths = phase22GenerationPaths(generation);
  add(pairPaths.active, 'active', jsonBytes(built.generation));
  add(pairPaths.index, 'index', built.bytes);
  for (const object of active.objects.filter(row => !output.some(entry => entry.path === row.path))) {
    if (readDependencies.some(row => row.path === object.path)) continue;
    if (base.carryHistoricalDocuments && object.path.startsWith('Wiki/')) continue;
    const bytes = files.get(object.path);
    if (!(bytes instanceof Uint8Array)) fail('RF_PUBLICATION_PREVIOUS_OBJECT_MISSING', { path: object.path });
    readDependencies.push({ path: object.path, byte_sha256: sha(bytes), byte_length: bytes.length });
  }
  readDependencies.sort((a, b) => a.path.localeCompare(b.path));
  const scientificReviewHash = hash({ input: data.scientific_input_fingerprint, reading_review: data.reading_review_fingerprint,
    review_receipt: data.review_receipt, view_receipts: data.view_receipts,
    ...(data.reading_editor_receipt ? { reading_editor_receipt: data.reading_editor_receipt } : {}),
    ...(data.user_revision_checks ? { user_revision_checks: data.user_revision_checks } : {}),
    ...(data.recipe.knowledge_rebase ? { knowledge_rebase: data.recipe.knowledge_rebase.rebase_fingerprint } : {}), presentation: candidate.presentation_fingerprint });
  const assetApprovals = options.presentationAssetRegistrations ?? [];
  const toolBindings = tools(), sourceBindings = [...new Map([...data.source_bindings, ...options.resources.map(row => binding(row.source_path)),
    ...assetApprovals.flatMap(row => [row.approval_binding, row.approved_candidate])]
    .map(row => [row.path, row])).values()];
  const status = options.evidenceMode === 'actual' ? 'review_ready' : 'synthetic_prepared';
  const reviewManifest = { schema_version: 'phase22/review-manifest-1.0', profile, identity, status,
    evidence_mode: options.evidenceMode, review_ready: options.evidenceMode === 'actual', publishable: false,
    reading_accepted: true, native_presentation: clone(data.native_presentation), scientific_review_hash: scientificReviewHash,
    generation, previous_generation: base.generation?.generation_id ?? null, previews,
    support_notes: supportTargets.map(row => ({ ...row, ...(migrations.has(row.path) ? { metadata_migration: migrations.get(row.path) } : {}) })),
    assets: options.resources.map(({ path, sha256, byte_length }) => {
      const approval = assetApprovals.find(row => row.resource.path === path);
      return { path, byte_sha256: sha256, byte_length, ...(approval ? { presentation_asset_registration: clone(approval) } : {}) };
    }),
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
  const recipe = { source: data.recipe };
  records.set(result, { source, recipe, sourceBindings, toolBindings,
    stamp: hash({ manifest: reviewManifest, output: inventoryStamp(output), hashes }) });
  return result;
}

export async function assertReadingFirstPublicationReviewCurrent(review) {
  const record = records.get(review);
  if (!record) fail('P22_REVIEW_NOT_OWNED');
  if (record.stamp !== hash({ manifest: review.reviewManifest, output: inventoryStamp(review.outputInventory), hashes: review.hashes })) fail('P22_REVIEW_OUTPUT_INVALIDATED');
  if (record.correction) { currentBindings(record.sourceBindings); currentBindings(record.toolBindings); return review; }
  await inspectReadingFirstPublicationSource(record.source);
  currentBindings(record.sourceBindings); currentBindings(record.toolBindings);
  return review;
}

/** A current-content publication is selected only by its frozen reading binding. */
export function usesCurrentReadingFirstPublication(review) {
  const record = records.get(review);
  return record?.correction === true || record?.recipe?.source?.binding?.configured_setup?.knowledge_registry?.policy === 'current-shared-nodes-1.0';
}

/** Restored evidence can reload its signed plan, but cannot mint a new plan or approval source. */
export async function assertReadingFirstPublicationReviewLive(review) {
  await assertReadingFirstPublicationReviewCurrent(review);
  if (records.get(review).correction) return review;
  const data = await inspectReadingFirstPublicationSource(records.get(review).source);
  if (data.origin !== 'live') fail('RF_PUBLICATION_LIVE_SOURCE_REQUIRED');
  return review;
}

/** Capture an owned live review; no JSON request can substitute for its source capability. */
export async function captureReadingFirstPublicationRegistration({ review, sourceInputs } = {}) {
  await assertReadingFirstPublicationReviewCurrent(review);
  const record = records.get(review);
  if (record.correction) {
    if (sourceInputs?.readingFirst?.correction !== review) fail('RF_PUBLICATION_LIVE_SOURCE_REQUIRED');
    return { source_bindings: clone(record.sourceBindings), tool_bindings: clone(record.toolBindings),
      control_snapshot: { schema_version: 'reading-first-publication-control-1.0', run_id: review.reviewManifest.identity.run_id,
        evidence_mode: review.reviewManifest.evidence_mode, source_fingerprint: hash(record.sourceBindings) } };
  }
  const data = await inspectReadingFirstPublicationSource(record.source);
  if (data.origin !== 'live' || sourceInputs?.readingFirst?.source !== record.source) fail('RF_PUBLICATION_LIVE_SOURCE_REQUIRED');
  return { source_bindings: clone(record.sourceBindings),
    ...(data.recipe.knowledge_rebase ? { reading_first_source: clone(data.recipe) } : {}),
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
  const approvedAssets = presentationAssetRegistrations(data, recipe.options.resources,
    recipe.options.presentationAssetRegistrations?.map(row => row.approval_binding));
  const options = { ...clone(recipe.options), resources: await resourceBindings(data, recipe.options.resources, approvedAssets),
    ...(approvedAssets.length ? { presentationAssetRegistrations: approvedAssets } : {}) };
  return buildReview({ source, data, options,
    base: { snapshot: null, generation: recipe.base.generation, index: recipe.base.index, files: decodeFiles(recipe.base.files),
      carryHistoricalDocuments: recipe.base.carryHistoricalDocuments === true },
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

// The record must belong to the corrected run, and every catalog in it must agree on which source each visual belongs to.
function frozenVisualSources(value, mainPath, runId) {
  const catalogs = [], runs = new Set(), walk = item => {
    if (Array.isArray(item)) item.forEach(walk);
    else if (item && typeof item === 'object') {
      if (Array.isArray(item.visuals) && item.source_pdf === mainPath) catalogs.push(item);
      if (typeof item.run_id === 'string') runs.add(item.run_id);
      Object.values(item).forEach(walk);
    }
  };
  walk(value);
  if (!runs.has(runId)) fail('RF_CITATION_CORRECTION_SCOPE', { reason: 'catalog record does not belong to the run' });
  if (!catalogs.length) fail('RF_CITATION_CORRECTION_SCOPE');
  const visuals = new Map(), sources = new Map();
  for (const catalog of catalogs) {
    for (const row of catalog.visuals) {
      if (visuals.has(row.id) && visuals.get(row.id) !== (row.source_id ?? null)) fail('RF_CITATION_CORRECTION_SCOPE', { visual: row.id });
      visuals.set(row.id, row.source_id ?? null);
    }
    for (const row of catalog.sources ?? []) {
      if (sources.has(row.id) && sources.get(row.id) !== row.path) fail('RF_CITATION_CORRECTION_SCOPE', { source: row.id });
      sources.set(row.id, row.path);
    }
  }
  return { visuals, sources };
}

// Committed locators keep their exact bytes; only their grouping under sources changes.
function correctedCitation(manifest, frozen, generation, files) {
  const old = manifest.citation, main = old?.sources?.[0];
  if (!main) fail('RF_CITATION_CORRECTION_SCOPE');
  const locators = old.sources.flatMap(row => row.locators);
  if (locators.some(row => !frozen.visuals.has(row.id))) fail('RF_CITATION_CORRECTION_SCOPE');
  const sourceOf = row => frozen.visuals.get(row.id) ?? main.source_id;
  return { ...clone(old), sources: [...new Set([main.source_id, ...locators.map(sourceOf)])].map(id => {
    const prior = old.sources.find(row => row.source_id === id), path = prior?.path ?? frozen.sources.get(id);
    const object = generation.objects.find(row => row.path === path);
    if (!manifest.targets.assets.includes(path) || object?.kind !== 'asset' || !files.has(path)) fail('RF_PUBLICATION_CITATION_SOURCE_UNREGISTERED', { source_id: id });
    return { source_id: id, path, sha256: prior?.sha256 ?? object.sha256, byte_length: prior?.byte_length ?? files.get(path).length,
      source_version: prior?.source_version ?? null, locators: locators.filter(row => sourceOf(row) === id).map(clone) };
  }) };
}

/** Re-group one committed paper's citation by the run's frozen visual sources; notes, knowledge and assets stay as committed. */
export async function prepareReadingFirstCitationCorrection({ vaultRoot, runId, catalogPath, generation, evidenceMode = 'actual' } = {}) {
  const root = rootPath(vaultRoot);
  if (!identifier(runId) || !['actual', 'synthetic'].includes(evidenceMode)) fail('RF_PUBLICATION_INPUT_INVALID');
  const pairPaths = phase22GenerationPaths(generation);
  const base = await baseFor(root, true);
  if (!base.generation || generation === base.generation.generation_id) fail('P22_GENERATION_NOT_NEW');
  if (base.generation.evidence_mode !== evidenceMode) fail('RF_PUBLICATION_EVIDENCE_MODE_MISMATCH');
  const paper = base.generation.papers.find(row => row.run_id === runId && row.profile === profile);
  if (!paper) fail('RF_CITATION_CORRECTION_SCOPE');
  const oldPath = paper.reader_presentation.path, oldBytes = base.files.get(oldPath);
  const manifest = verifyReadingFirstPresentation(paper, oldBytes, base.generation);
  const catalogBinding = binding(catalogPath);
  const frozen = frozenVisualSources(JSON.parse(readFileSync(catalogBinding.path, 'utf8')), manifest.citation?.sources?.[0]?.path, runId);
  const citation = correctedCitation(manifest, frozen, base.generation, base.files);
  if (same(citation, manifest.citation)) fail('RF_CITATION_CORRECTION_NOOP');
  const path = '.apa-v3/reading-first/presentation/' + runId + '-' + hash(manifest.identity).slice(7, 31) + '-citation-' + hash(citation).slice(7, 19) + '.json';
  const corrected = { ...clone(manifest), citation, targets: { ...clone(manifest.targets), presentation: path } };
  assertReadingFirstPublicationManifest(corrected);
  const bytes = jsonBytes(corrected);
  const active = { ...clone(base.generation), generation_id: generation,
    papers: base.generation.papers.map(row => row === paper ? { ...clone(row), reader_presentation: { ...clone(row.reader_presentation), path, sha256: sha(bytes) } } : clone(row)),
    objects: [...base.generation.objects.filter(row => row.path !== oldPath), { path, kind: 'reader-presentation', sha256: sha(bytes) }]
      .sort((a, b) => a.path.localeCompare(b.path)) };
  delete active.index_manifest;
  assertActiveGeneration(active);
  const files = new Map(base.files); files.delete(oldPath); files.set(path, bytes);
  const built = await buildBilingualIndex({ generation: active, validatedInputs: { papers: [{ readingFirst: corrected }],
    files: [...files].map(([file, content]) => ({ path: file, bytes: content })), carryHistoricalDocuments: true,
    previousPrepared: { generation: base.generation, index: base.index } } });
  // Paper-note documents must not move; shared-node documents follow the current registered prose, as any new publication would.
  const notePaths = new Set(Object.values(paper.paths));
  const documents = index => index.documents.filter(row => row.paper_id === paper.paper_id && notePaths.has(row.path));
  if (!same(documents(JSON.parse(built.bytes)), documents(base.index))) fail('RF_CITATION_CORRECTION_SCOPE', { reason: 'paper note documents changed' });
  const output = [], add = (file, kind, content) => {
    if (regularBytes(root, file, { missing: true }) !== null) fail('RF_CITATION_CORRECTION_TARGET_EXISTS', { path: file });
    output.push({ path: file, kind, bytes: Buffer.from(content), byte_sha256: sha(content), byte_length: content.length, before_sha256: null, before_byte_length: null });
  };
  add(path, 'reader-presentation', bytes);
  add(pairPaths.active, 'active', jsonBytes(built.generation));
  add(pairPaths.index, 'index', built.bytes);
  const readDependencies = built.generation.objects.filter(row => row.path !== path)
    .map(row => ({ path: row.path, byte_sha256: sha(files.get(row.path)), byte_length: files.get(row.path).length }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const toolBindings = tools(), sourceBindings = [catalogBinding];
  const scientificReviewHash = hash({ citation_correction: { run_id: runId, previous_presentation: sha(oldBytes), citation } });
  const reviewManifest = { schema_version: 'phase22/review-manifest-1.0', profile, identity: clone(manifest.identity),
    status: evidenceMode === 'actual' ? 'review_ready' : 'synthetic_prepared', evidence_mode: evidenceMode, review_ready: evidenceMode === 'actual',
    publishable: false, reading_accepted: true, native_presentation: { status: 'not_run' }, scientific_review_hash: scientificReviewHash,
    generation, previous_generation: base.generation.generation_id, support_notes: [], assets: [],
    previews: languages.map(language => {
      const note = files.get(paper.paths[language]), inspected = inspectManagedNote(note);
      return { language, path: paper.paths[language], byte_sha256: sha(note), byte_length: note.length, managed_hash: inspected.managedHash,
        human_ranges: inspected.humanRanges.map(range => ({ from: range.from, to: range.to, byte_sha256: sha(range.bytes) })) };
    }),
    read_dependencies: readDependencies, dependencies: clone(manifest.dependencies), tools: Object.fromEntries(toolBindings.map(row => [row.path, row.sha256])),
    index: { path: pairPaths.index, byte_sha256: built.sha256 }, active: { path: pairPaths.active, byte_sha256: sha(jsonBytes(built.generation)) },
    write_set: output.map(({ bytes: _, ...row }) => row), diagnostics: [],
    provenance_limits: { native_presentation: 'not_run', scientific_review_scope: 'citation regrouping of a committed reading', independent_first_read: 'not_asserted' } };
  contractValidator ??= createPhase22ContractValidator();
  (await contractValidator).assert('phase22/review-manifest-1.0', reviewManifest);
  add('.apa-v3/phase22/generations/' + generation + '/manifest.json', 'manifest', jsonBytes(reviewManifest));
  output.sort((a, b) => a.path.localeCompare(b.path));
  const hashes = { scientific_review_hash: scientificReviewHash,
    review_bundle_hash: hash({ reviewManifest, outputs: inventoryStamp(output), read_dependencies: readDependencies }),
    output_inventory_hash: hash({ generation, previous_generation: reviewManifest.previous_generation, output: inventoryStamp(output), read_dependencies: readDependencies }) };
  const review = freeze({ ok: true, status: reviewManifest.status, reviewManifest, outputInventory: output, hashes, diagnostics: [] });
  records.set(review, { correction: true, sourceBindings, toolBindings, stamp: hash({ manifest: reviewManifest, output: inventoryStamp(output), hashes }) });
  const { dryRunBilingualPublication } = await import('./phase22-publication.mjs');
  const dry = await dryRunBilingualPublication({ vaultRoot: root, run: runId, review });
  return { ...dry, review, sourceInputs: { readingFirst: { correction: review } },
    correction: { previous_path: oldPath, path, moved_locators: citation.sources.slice(1).reduce((sum, row) => sum + row.locators.length, 0)
      - manifest.citation.sources.slice(1).reduce((sum, row) => sum + row.locators.length, 0) } };
}

/** Prepare a reviewed candidate completed by an external host transport without claiming native dispatch. */
export async function prepareExternalReviewedReadingFirstPublication({
  vaultRoot, generation, evidenceMode = 'actual', resources, runRoot, candidateRoot,
  scientificInput, candidate, presentation, review, reviewReceipt, viewReceipts, readingEditorReceipt, readingFirstBinding, callsUsed = 0, rendering,
} = {}) {
  const receiptValid = receipt => typeof receipt?.path === 'string' && receipt.path.length > 0
    && typeof receipt?.artifact_id === 'string' && receipt.artifact_id.length > 0;
  if (!scientificInput?.identity?.run_id || !Array.isArray(scientificInput.sources)
    || scientificInput.sources.some(row => typeof row?.path !== 'string' || !row.path)
    || !Array.isArray(candidate?.notes) || candidate.notes.length !== 2 || !Array.isArray(candidate.supportNotes)
    || [...candidate.notes, ...candidate.supportNotes].some(note => typeof note?.path !== 'string' || typeof note.content !== 'string')
    || !Array.isArray(candidate.assetPaths) || !Array.isArray(resources)
    || resources.some(row => typeof row?.source_path !== 'string' || !row.source_path)
    || typeof candidateRoot !== 'string' || !candidateRoot || typeof runRoot !== 'string' || !runRoot
    || !presentation || !review || !receiptValid(reviewReceipt) || !receiptValid(viewReceipts?.en)
    || !receiptValid(viewReceipts?.['zh-CN']) || !receiptValid(readingEditorReceipt)) {
    fail('RF_PUBLICATION_EXTERNAL_INPUT_INVALID');
  }
  const root = rootPath(vaultRoot);
  const candidateRootAbs = resolve(candidateRoot);
  for (const note of [...candidate.notes, ...candidate.supportNotes]) {
    const bytes = regularBytes(candidateRootAbs, note.path);
    if (!bytes.equals(Buffer.from(note.content))) fail('RF_PUBLICATION_EXTERNAL_CANDIDATE_CHANGED', { path: note.path });
  }
  const sourceBindings = [...new Map([
    ...scientificInput.sources.map(row => binding(row.path)),
    ...resources.map(row => binding(row.source_path)),
    ...[...candidate.notes, ...candidate.supportNotes].map(row => binding(join(candidateRootAbs, row.path))),
    ...[viewReceipts.en, viewReceipts['zh-CN'], readingEditorReceipt, reviewReceipt].flatMap(receipt => [
      binding(join(runRoot, receipt.path)),
      binding(join(runRoot, '.phase21-receipts', encodeURIComponent(receipt.artifact_id) + '.json')),
    ]),
  ].map(row => [row.path, row])).values()];
  const editorValue = JSON.parse(readFileSync(join(runRoot, readingEditorReceipt.path), 'utf8'));
  if (editorValue.schema_version === 'reading-editor-1.3' && !readingFirstBinding) fail('RF_PUBLICATION_EXTERNAL_BINDING_REQUIRED');
  if (readingFirstBinding && ((readingFirstBinding.presentation_profile ?? 'reading-editor-1.3') !== editorValue.schema_version
    || readingFirstBinding.input_fingerprint !== hash(scientificInput))) fail('RF_PUBLICATION_EXTERNAL_BINDING_INVALID');
  const renderOptions = rendering ?? { existingTargets: [], knowledgeRegistry: [] };
  if (!Array.isArray(renderOptions.existingTargets) || !Array.isArray(renderOptions.knowledgeRegistry)) fail('READING_FIRST_PUBLICATION_RENDERING_INVALID');
  const ownedValue = async receipt => {
    const artifact = await readOwnedArtifact({ artifactRoot: runRoot, artifactId: receipt.artifact_id });
    if (!artifact || !same(artifact.receipt, receipt)) fail('READING_FIRST_PUBLICATION_RECEIPT_CHANGED');
    return JSON.parse(artifact.bytes.toString('utf8'));
  };
  const renderInputs = { identity: clone(scientificInput.identity), views: await Promise.all(languages.map(language => ownedValue(viewReceipts[language]))),
    presentation: clone(presentation), readingEditor: await ownedValue(readingEditorReceipt),
    ...(readingFirstBinding?.note_layout ? { noteLayout: readingFirstBinding.note_layout } : {}),
    ...(readingFirstBinding?.source_language ? { sourceLanguage: readingFirstBinding.source_language } : {}) };
  const rendered = renderReadingFirstObsidian({ ...renderInputs, ...renderOptions });
  const { notes, supportNotes, ...renderedRest } = rendered;
  const content = { ...renderedRest, notes: notes.map(({ bytes, ...note }) => ({ ...note, draft_receipt: viewReceipts[note.language] })),
    ...(supportNotes ? { supportNotes: supportNotes.map(({ bytes, ...note }) => note) } : {}) };
  const { profile: candidateProfile, identity: candidateIdentity, review_status, publishable, presentation_fingerprint, ...candidateContent } = candidate;
  if (!same(content, candidateContent) || hash(content) !== presentation_fingerprint) fail('READING_FIRST_PUBLICATION_CANDIDATE_CHANGED');
  const encodedRendering = { ...clone(renderOptions), existingTargets: renderOptions.existingTargets.map(({ bytes, bytes_base64, ...row }) => ({
    ...row, bytes_base64: bytes == null ? bytes_base64 ?? null : Buffer.from(bytes).toString('base64'),
  })) };
  const sourceRecipe = {
    schema_version: 'external-reviewed-reading-first-publication-source-1.0',
    rendering: encodedRendering, render_inputs: renderInputs,
    run_id: scientificInput.identity.run_id,
    identity_fingerprint: hash(scientificInput),
    reading_review_fingerprint: hash({ review, receipt: reviewReceipt, presentation: candidate.presentation_fingerprint }),
    scientific_input: clone(scientificInput),
    run_root: resolve(runRoot), ...(readingFirstBinding ? { binding: clone(readingFirstBinding) } : {}),
    candidate: clone(candidate),
    review: clone(review),
    review_receipt: clone(reviewReceipt),
    view_receipts: clone(viewReceipts),
    reading_editor_receipt: clone(readingEditorReceipt),
    presentation: clone(presentation),
    presentation_assets: clone(candidate.presentation_assets ?? []),
    calls_used: callsUsed,
    source_bindings: sourceBindings,
    tool_bindings: [...new Map([...tools(), ...getReadingFirstRuntimePublicationToolBindings(readingFirstBinding)]
      .map(row => [row.path, row])).values()],
  };
  sourceRecipe.recipe_fingerprint = hash(sourceRecipe);
  let source = createExternalReadingFirstPublicationSource(sourceRecipe);
  let data = await inspectReadingFirstPublicationSource(source);
  const policy = readingFirstBinding?.configured_setup?.knowledge_registry;
  const base = await baseFor(root, policy?.policy === 'current-shared-nodes-1.0' && resolve(policy.vault_root) === root);
  const options = { vaultRoot: root, generation, evidenceMode, resources: await resourceBindings(data, resources) };
  const resultReview = await buildReview({ source, data, options, base, preimages: null });
  source = createExternalReadingFirstPublicationSource(sourceRecipe);
  data = await inspectReadingFirstPublicationSource(source);
  const record = records.get(resultReview);
  record.recipe = { source: sourceRecipe };
  record.source = source;
  record.sourceBindings = [...new Map([...sourceBindings, ...options.resources.map(row => binding(row.source_path))]
    .map(row => [row.path, row])).values()];
  record.toolBindings = [...new Map([...tools(), ...getReadingFirstRuntimePublicationToolBindings(readingFirstBinding)]
    .map(row => [row.path, row])).values()];
  record.stamp = hash({ manifest: resultReview.reviewManifest, output: inventoryStamp(resultReview.outputInventory), hashes: resultReview.hashes });
  const { dryRunBilingualPublication } = await import('./phase22-publication.mjs');
  const dry = await dryRunBilingualPublication({ vaultRoot: root, run: resultReview.reviewManifest.identity.run_id, review: resultReview });
  return { ...dry, review: resultReview, sourceInputs: { readingFirst: { source } }, external_source_recipe: sourceRecipe };
}
