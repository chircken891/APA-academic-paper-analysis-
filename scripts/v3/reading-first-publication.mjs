import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, dirname, join, basename, posix, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import YAML from 'yaml';
import { fingerprintV3Json as hash } from './semantic-package-validator.mjs';
import { inspectManagedNote, mergeManagedNote } from './phase22-managed-markdown.mjs';
import { readCommittedGeneration, assertActiveGeneration, assertIndexGeneration, phase22GenerationPaths,
  readRegisteredCommit, INDEX_READING_FIRST_PROFILE } from './phase22-active-version.mjs';
import { buildBilingualIndex } from './phase22-search.mjs';
import { assertReadingFirstPublicationManifest, parseRegisteredResearchMap, registeredResearchMapPaths, verifyReadingFirstPresentation } from './reading-first-index.mjs';
import { captureReadingFirstPublicationSource, createExternalReadingFirstPublicationSource,
  getReadingFirstRuntimePublicationToolBindings, inspectReadingFirstPublicationSource,
  previewReadingFirstPublicationRebase, readingFirstUsedMethodSources, restoreReadingFirstPublicationSource } from './reading-first-runtime.mjs';
import { readCommittedReadingFirstKnowledgeRegistry, readKnowledgeRegistryRow } from './reading-first-knowledge-registry.mjs';
import { bindPublishedKnowledgeReferences, registeredKnowledgeReference } from './reading-first-knowledge.mjs';
import { createPhase22ContractValidator } from './phase22-contract-loader.mjs';
import { readOwnedArtifact } from './owned-artifact-store.mjs';
import { renderReadingFirstObsidian } from './reading-first-obsidian.mjs';
import { relocateNoteLinks } from './note-relocation.mjs';
import { findRawSourceMatches, inspectClippingsSourceDrift, readRegisteredSourceMatchMetadata } from './reading-source-policy.mjs';

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
const paperSourcePath = path => /^(Raw|Clippings)\/.+\.(pdf|docx)$/i.test(path);
const canonicalSources = data => data.recipe.binding?.configured_setup?.source_policy === 'clippings-originals-1.0';
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
  return ['./reading-first-publication.mjs', './reading-first-knowledge.mjs', './research-map-canvas.mjs', './reading-source-policy.mjs', './note-relocation.mjs', './reading-resources.mjs', './phase22-publication.mjs', './phase22-review.mjs',
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
/** Check registered originals before inspecting a candidate's own frozen inputs. */
export async function assertReadingFirstRegisteredSourcesCurrent({ vaultRoot } = {}) {
  const root = rootPath(vaultRoot);
  if (regularBytes(root, '.apa-v3/phase22/COMMITTED.json', { missing: true }) === null) return null;
  const registered = await readRegisteredCommit({ vaultRoot: root });
  if (!registered.ok) fail('RF_PUBLICATION_PREVIOUS_GENERATION_INVALID', { errors: registered.errors });
  const drifts = inspectClippingsSourceDrift({ vaultRoot: root, objects: registered.generation.objects });
  if (drifts.length) fail('RF_PUBLICATION_PREVIOUS_OBJECT_CHANGED', { ...drifts[0], drifts });
  return registered;
}
async function baseFor(root, currentPolicy = false, checked) {
  const registered = checked === undefined ? await assertReadingFirstRegisteredSourcesCurrent({ vaultRoot: root }) : checked;
  if (!registered) return { snapshot: null, generation: null, index: null, files: new Map() };
  if (currentPolicy) {
    const maps = registeredResearchMapPaths(registered.generation, path => {
      const bytes = regularBytes(root, path, { missing: true });
      const object = registered.generation.objects.find(row => row.path === path);
      if (bytes === null || sha(bytes) !== object?.sha256) fail('RF_PUBLICATION_PREVIOUS_OBJECT_CHANGED', { path });
      return bytes;
    });
    const files = new Map();
    for (const row of registered.generation.objects) {
      const editable = row.path.startsWith('Wiki/') || maps.has(row.path);
      const bytes = regularBytes(root, row.path, { missing: editable });
      if (!editable && sha(bytes) !== row.sha256) fail('RF_PUBLICATION_PREVIOUS_OBJECT_CHANGED', { path: row.path });
      if (bytes !== null) files.set(row.path, bytes);
    }
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
    const current = manifest.resources.map(row => manifest.resource_repair?.resources.find(item => item.id === row.id) ?? row);
    return current.map(row => ({ id: row.id, locator: row.locator, path: row.path, source_id: row.source_id, source_path: row.parent.path,
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
      const targets = resources.filter(resource => paperSourcePath(resource.path)
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
        || !resource || !/^(Raw|Clippings)\/.+\.pdf$/i.test(resource.path) || paths.has(resource.path)
        || typeof resource.source_path !== 'string' || !isAbsolute(resource.source_path)
        || !data.candidate.assetPaths.includes(resource.path) || resource.path === data.presentation.source_pdf
        || !data.presentation.sources?.some(row => row.id === parent?.source_id && row.path === resource.path)
        || !resources.some(row => same(row, resource))) throw new Error('approval scope mismatch');
      const parents = data.sources.filter(row => row.id === parent.source_id && row.sha256 === parent.sha256
        && typeof parent.path === 'string' && isAbsolute(parent.path) && resolve(row.path) === resolve(parent.path));
      if (parents.length !== 1) throw new Error('scientific parent mismatch');
      const targets = resources.filter(row => paperSourcePath(row.path) && typeof row.source_path === 'string'
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
    if (paths.has(resource.path) || (!paperSourcePath(resource.path) && !/^Figures\//.test(resource.path)) || typeof resource.source_path !== 'string') fail('RF_PUBLICATION_RESOURCE_INVALID');
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
  const generatedPaths = new Set((data.candidate.generated_assets ?? []).map(row => row.path));
  const expected = [...new Set([...(data.candidate.assetPaths ?? []).filter(path => !generatedPaths.has(path)), ...parentPaths])].sort();
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
  const ids = [...new Set([source.id, ...visuals.map(row => row.source_id ?? source.id),
    ...(canonicalSources(data) ? (catalog.sources ?? []).map(row => row.id) : [])])];
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

function usedMethodSources(data) {
  return readingFirstUsedMethodSources(data.recipe.checkpoint?.state).map(source => ({ ...source,
    path: safePath('Raw/' + data.identity.run_id + '/' + basename(source.source_path)) }));
}

function sourcePlan(root, data, supplied, base, approvals = [], matchMetadata = {}, before = path => regularBytes(root, path, { missing: true })) {
  const strict = canonicalSources(data);
  const extras = strict ? usedMethodSources(data) : [];
  if (strict) {
    for (const resource of supplied.filter(row => paperSourcePath(row.path))) {
      if (resource.path.startsWith('Raw/')) fail('RF_PUBLICATION_RAW_WRITE_FORBIDDEN', { path: resource.path });
      if (resolve(root, resource.path) !== resolve(resource.source_path)) fail('RF_PUBLICATION_CLIPPINGS_ORIGINAL_REQUIRED', { path: resource.path });
    }
    const declared = new Map((data.presentation.sources ?? []).map(row => [row.id, row.path]));
    for (const source of data.sources) {
      const location = data.recipe.binding.configured_setup.source_locations?.find(row => row.source_id === source.id);
      const resource = supplied.find(row => row.path === location?.vault_path);
      const display = approvals.some(row => row.scientific_parent.source_id === source.id && row.resource.path === declared.get(source.id)
        && row.parent_resource_path === resource?.path);
      if (!resource || !resource.path.startsWith('Clippings/') || source.path !== location.path || location.sha256 !== source.sha256
        || location.byte_length !== source.byte_length || resource.sha256 !== source.sha256 || resource.byte_length !== source.byte_length
        || resolve(resource.source_path) !== resolve(source.path) || declared.has(source.id) && declared.get(source.id) !== resource.path && !display) {
        fail('RF_PUBLICATION_CLIPPINGS_ORIGINAL_REQUIRED', { source_id: source.id, path: location?.vault_path });
      }
    }
  }
  const resources = [...supplied, ...extras];
  const raw = resources.filter(row => row.path.startsWith('Raw/'));
  const ids = new Map([...(data.presentation.sources ?? []).map(row => [row.path, row.id]),
    ...extras.map(row => [row.path, row.source_id])]);
  for (const row of resources.filter(item => paperSourcePath(item.path))) {
    const boundSource = data.sources.find(source => resolve(source.path) === resolve(row.source_path) && source.sha256 === row.sha256);
    if (!ids.has(row.path) && boundSource) ids.set(row.path, boundSource.id);
  }
  const main = resources.find(row => row.path === data.presentation.source_pdf);
  if (main) ids.set(main.path, data.sources.find(row => resolve(row.path) === resolve(main.source_path))?.id);
  const metadata = row => {
    const source = data.sources.find(item => item.id === ids.get(row.path));
    return { path: row.path, sha256: row.sha256, byte_length: row.byte_length,
      ...(row.path === main?.path ? { doi: data.presentation.bibliography.doi, title: data.presentation.bibliography.title } : {}),
      ...(source?.doi ? { doi: source.doi } : {}), ...(source?.title ? { title: source.title } : {}),
      ...(row.doi ? { doi: row.doi } : {}), ...(row.title ? { title: row.title } : {}) };
  };
  const duplicates = findRawSourceMatches({ vaultRoot: root,
    sources: [...(matchMetadata.sources ?? []), ...resources.filter(row => row.path.startsWith('Clippings/')).map(metadata)],
    rawSources: [...(matchMetadata.rawSources ?? []), ...raw.map(metadata)] });
  const remaps = raw.flatMap(row => {
    const match = duplicates.exact_matches.filter(item => item.raw_path === row.path
      && item.sha256 === row.sha256 && item.byte_length === row.byte_length)
      .sort((a, b) => a.clippings_path.localeCompare(b.clippings_path, 'en'))[0];
    if (!match) return [];
    const source_id = ids.get(row.path);
    if (!source_id) fail('RF_PUBLICATION_SOURCE_REMAP_IDENTITY', { path: row.path });
    return [{ old_path: row.path, new_path: match.clippings_path, source_id, sha256: row.sha256, byte_length: row.byte_length }];
  });
  const byOld = new Map(remaps.map(row => [row.old_path, row.new_path]));
  const finalResources = new Map();
  for (const row of resources) {
    const path = byOld.get(row.path) ?? row.path;
    const source_path = byOld.has(row.path) ? resolve(root, path) : row.source_path;
    const prior = finalResources.get(path);
    if (prior && (prior.sha256 !== row.sha256 || prior.byte_length !== row.byte_length)) fail('RF_PUBLICATION_RESOURCE_TARGET_CONFLICT', { path });
    finalResources.set(path, { path, source_path, sha256: row.sha256, byte_length: row.byte_length });
  }
  const supplements = extras.map(({ source_path, ...row }) => ({ ...row, path: byOld.get(row.path) ?? row.path,
    notes: data.candidate.notes.map(note => note.path) }));
  const bound = new Set(resources.flatMap(row => [row.path, byOld.get(row.path)]).filter(Boolean));
  const committedAssets = new Set((base.generation?.objects ?? []).filter(row => row.kind === 'asset').map(row => row.path));
  const relevant = row => bound.has(row.raw_path) || bound.has(row.clippings_path) || committedAssets.has(row.raw_path);
  const exact = duplicates.exact_matches.filter(relevant)
    .filter(row => {
      const bytes = before(row.raw_path);
      return bytes !== null && bytes.length === row.byte_length && sha(bytes) === row.sha256;
    });
  return {
    resources: [...finalResources.values()], citationResources: supplied, sourceDerivation: { remaps, supplements }, sourceMatchMetadata: matchMetadata,
    publicationSources: { source_path_remaps: remaps, raw_supplements: supplements.filter(row => row.path.startsWith('Raw/')
      && before(row.path) === null),
    raw_cleanup_candidates: exact.filter(row => !committedAssets.has(row.raw_path)),
    migration_candidates: exact.filter(row => committedAssets.has(row.raw_path)),
    possible_matches: duplicates.possible_matches.filter(relevant) },
  };
}

/** Recompute only approved link-target changes and source navigation from the signed derivation. */
export function applyReadingFirstSourceDerivation(data, derivation) {
  if (!derivation) return data.candidate;
  const { remaps, supplements } = derivation;
  if (!Array.isArray(remaps) || !Array.isArray(supplements)) fail('RF_PUBLICATION_SOURCE_REMAP_INVALID');
  const byOld = new Map();
  for (const row of remaps) {
    safePath(row.old_path); safePath(row.new_path);
    if (!row.old_path.startsWith('Raw/') || !row.new_path.startsWith('Clippings/')
      || !paperSourcePath(row.old_path) || !paperSourcePath(row.new_path) || byOld.has(row.old_path)
      || typeof row.source_id !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(row.sha256) || !Number.isSafeInteger(row.byte_length)) {
      fail('RF_PUBLICATION_SOURCE_REMAP_INVALID', { path: row.old_path });
    }
    byOld.set(row.old_path, row.new_path);
  }
  const originals = usedMethodSources(data);
  if (supplements.length !== (canonicalSources(data) ? originals.length : 0)) fail('RF_PUBLICATION_SOURCE_REMAP_INVALID');
  for (const extra of supplements) {
    const original = originals.find(row => row.source_id === extra.source_id);
    if (!original) fail('RF_PUBLICATION_SOURCE_REMAP_INVALID');
    const { source_path, ...fields } = original;
    if (!same(extra, { ...fields, path: byOld.get(original.path) ?? original.path, notes: data.candidate.notes.map(note => note.path) })) fail('RF_PUBLICATION_SOURCE_REMAP_INVALID');
  }
  const notes = data.candidate.notes.map(note => {
    let bytes = Buffer.from(note.content);
    const { regions } = inspectManagedNote(bytes);
    for (const region of [...regions].reverse()) {
      let content = relocateNoteLinks(region.bytes.toString('utf8'), note.path, note.path, byOld);
      if (region.id === 'source' && supplements.length) {
        const end = '<!-- AUTO:END source -->';
        const lines = supplements.map(row => {
          const label = row.title.replace(/[\[\]\r\n]/g, ' ');
          const href = posix.relative(posix.dirname(note.path), row.path).split('/').map(encodeURIComponent).join('/');
          return '- [' + label + '](' + href + ')';
        });
        const heading = note.language === 'en' ? 'Method sources consulted' : '补缺方法文献';
        content = content.slice(0, -end.length) + '\n' + heading + '\n\n' + lines.join('\n') + '\n' + end;
      }
      bytes = Buffer.concat([bytes.subarray(0, region.from), Buffer.from(content), bytes.subarray(region.to)]);
    }
    return { ...note, content: bytes.toString('utf8'), managedHash: inspectManagedNote(bytes).managedHash };
  });
  const assetPaths = [...new Set([...data.candidate.assetPaths.map(path => byOld.get(path) ?? path), ...supplements.map(row => row.path)])];
  return { ...data.candidate, notes, assetPaths };
}

const pointNumber = /^(?:\\(?:dfrac|tfrac|frac)(?:\{\d+\}\{\d+\}|\d{2})|[+\-−]?(?:\d+(?:[.,]\d+)*(?:[eE][+\-]?\d+)?(?:\/\d+)?|\.\d+)|[¼½¾⅐-⅞])$/u;
const pointSymbol = /^(?:<=|>=|[<>=≤≥±×÷−+%％]|\\(?:leq?|geq?|pm|times|div))$/u;
const pointUnit = /^(?:[kcmnµμ]?g|[mdµμ]?L|[munµμ]?M|[µμnmkc]?(?:m|mol|s)|min|h|d|day|days|weeks?|months?|years?|mmHg|bpm|Hz|Pa|kPa|°C|°F|岁|年|天|日|周|月|秒|分钟|小时|毫克|微克)(?:[·/](?:[kcmnµμ]?g|[mdµμ]?L|[munµμ]?M|[µμnmkc]?(?:m|mol|s)|min|h|d))*$/u;
const pointDirection = /^(?:increase[sd]?|decrease[sd]?|increasing|decreasing|higher|lower|greater|less|positive|negative|above|below|more|fewer|up|down|增加|减少|升高|降低|上升|下降|上调|下调|高于|低于|大于|小于|正向|负向|阳性|阴性)$/iu;
const pointTokens = /\\(?:dfrac|tfrac|frac)(?:\{\d+\}\{\d+\}|\d{2})|[+\-−]?(?:\d+(?:[.,]\d+)*(?:[eE][+\-]?\d+)?(?:\/\d+)?|\.\d+)|\\[a-zA-Z]+|<=|>=|(?:增加|减少|升高|降低|上升|下降|上调|下调|高于|低于|大于|小于|正向|负向|阳性|阴性|分钟|小时|毫克|微克)|[°a-zA-Zµμ]+(?:[·/][a-zA-Zµμ]+)*|[^\s]/gu;

function singlePointCorrection(before, after) {
  const old = [...before.matchAll(pointTokens)], next = [...after.matchAll(pointTokens)];
  let first = 0, suffix = 0;
  while (first < Math.min(old.length, next.length) && old[first][0] === next[first][0]) first++;
  while (suffix < Math.min(old.length, next.length) - first && old.at(-1 - suffix)[0] === next.at(-1 - suffix)[0]) suffix++;
  const edits = [old, next].map((tokens, index) => {
    const value = index ? after : before;
    const changed = tokens.slice(first, tokens.length - suffix);
    const from = tokens[first]?.index ?? value.length;
    return { changed, from, to: changed.length === 1 ? from + changed[0][0].length : from };
  });
  const [a, b] = edits;
  if (edits.some(edit => edit.changed.length > 1) || a.changed.length + b.changed.length === 0
    || ![pointNumber, pointSymbol, pointUnit, pointDirection].some(pattern => edits.every(edit => !edit.changed.length || pattern.test(edit.changed[0][0])))
    || before.slice(0, a.from).replace(/[ \t]+$/u, '') !== after.slice(0, b.from).replace(/[ \t]+$/u, '')
    || before.slice(a.to).replace(/^[ \t]+/u, '') !== after.slice(b.to).replace(/^[ \t]+/u, '')) fail('RF_PUBLICATION_USER_CORRECTION_SCOPE');
  return a;
}

/** Apply exact user facts to the owned candidate while leaving its review evidence intact. */
export function applyReadingFirstUserCorrections(candidate, corrections = []) {
  if (!Array.isArray(corrections)) fail('RF_PUBLICATION_USER_CORRECTIONS_INVALID');
  if (!corrections.length) return candidate;
  const byPath = new Map();
  for (const row of corrections) {
    const required = ['path', 'before', 'after', 'source_location', 'user_reply'];
    if (!row || !same(Object.keys(row).sort(), required.slice().sort()) || required.some(key => typeof row[key] !== 'string' || !/\S/.test(row[key]))
      || row.before === row.after || !candidate.notes.some(note => note.path === row.path)) {
      fail('RF_PUBLICATION_USER_CORRECTIONS_INVALID', { path: row?.path });
    }
    const rows = byPath.get(row.path) ?? [];
    rows.push(row); byPath.set(row.path, rows);
  }
  const notes = candidate.notes.map(note => {
    const rows = byPath.get(note.path);
    if (!rows) return note;
    const { content, path } = note;
    const { regions } = inspectManagedNote(Buffer.from(content));
    const matches = rows.map(({ before, after }) => {
      const at = content.indexOf(before);
      if (at < 0 || content.indexOf(before, at + 1) !== -1) fail('RF_PUBLICATION_USER_CORRECTION_NOT_UNIQUE', { path, before });
      const point = singlePointCorrection(before, after), from = at + point.from, to = at + point.to;
      const byteFrom = Buffer.byteLength(content.slice(0, from)), byteTo = Buffer.byteLength(content.slice(0, to));
      const region = regions.find(row => ['reading', 'resources'].includes(row.id) && byteFrom > row.from && byteTo < row.to);
      const start = content.lastIndexOf('\n', from - 1) + 1;
      const line = content.slice(start, content.indexOf('\n', from) < 0 ? undefined : content.indexOf('\n', from));
      const protectedSyntax = [...line.matchAll(/!?\[\[[^\]\r\n]+\]\]|!?\[[^\]\r\n]*\]\([^)\r\n]*\)|\^[\w-]+|<!--[\s\S]*?-->|<\/?[A-Za-z][^>\r\n]*>/gu)];
      const inCodeFence = [...content.slice(0, start).matchAll(/^[ \t]*(?:\x60{3,}|~{3,})/gm)].length % 2 !== 0;
      if (!region || /^(?:\s*(?:>\s*)?#{1,6}\s|\s*\x60{3})/u.test(line)
        || inCodeFence
        || protectedSyntax.some(match => from <= start + match.index + match[0].length && to >= start + match.index)) {
        fail('RF_PUBLICATION_USER_CORRECTION_SCOPE', { path, before });
      }
      return { at, before, after };
    }).sort((a, b) => b.at - a.at);
    let result = content, last = content.length;
    for (const { at, before, after } of matches) {
      if (at + before.length > last) fail('RF_PUBLICATION_USER_CORRECTION_OVERLAP', { path, before });
      result = result.slice(0, at) + after + result.slice(at + before.length);
      last = at;
    }
    return { ...note, content: result, managedHash: inspectManagedNote(Buffer.from(result)).managedHash };
  });
  return { ...candidate, notes };
}

/** Prepare the exact accepted reading output for the existing V3 publication transaction. */
export async function buildReadingFirstPublicationReview({ source, vaultRoot, generation, evidenceMode = 'actual', resources,
  knowledgeMetadataMigrations, user_corrections, presentationAssetRegistrations: assetApprovals } = {}) {
  const root = rootPath(vaultRoot);
  const checked = await assertReadingFirstRegisteredSourcesCurrent({ vaultRoot: root });
  const data = await inspectReadingFirstPublicationSource(source);
  if (data.origin !== 'live') fail('RF_PUBLICATION_LIVE_SOURCE_REQUIRED');
  const policy = data.recipe.binding?.configured_setup?.knowledge_registry;
  const currentPolicy = policy?.policy === 'current-shared-nodes-1.0' && resolve(policy.vault_root) === root;
  const base = await baseFor(root, currentPolicy, checked);
  const approvedAssets = presentationAssetRegistrations(data, resources, assetApprovals);
  const matchMetadata = await readRegisteredSourceMatchMetadata({ vaultRoot: root, registered: checked ?? undefined });
  const sourceOptions = sourcePlan(root, data, await resourceBindings(data, resources, approvedAssets), base, approvedAssets, matchMetadata);
  const options = { vaultRoot: root, generation, evidenceMode, ...sourceOptions,
    ...(user_corrections === undefined ? {} : { user_corrections: clone(user_corrections) }),
    ...(approvedAssets.length ? { presentationAssetRegistrations: approvedAssets } : {}),
    ...(knowledgeMetadataMigrations === undefined ? {} : { knowledgeMetadataMigrations: clone(knowledgeMetadataMigrations) }) };
  return buildReview({ source, data, options, base, preimages: null });
}

async function buildReview({ source, data, options, base, preimages, projected }) {
  if (!preimages && data.recipe.knowledge_rebase
    && data.recipe.knowledge_rebase.base_generation_id !== (base.generation?.generation_id ?? null)) {
    fail('RF_PUBLICATION_KNOWLEDGE_CHANGED_SINCE_RENDER', { expected_generation: data.recipe.knowledge_rebase.base_generation_id,
      observed_generation: base.generation?.generation_id ?? null, action: 'refresh_candidate' });
  }
  const derivation = options.sourceDerivation;
  const changed = derivation?.remaps.length || derivation?.supplements.length;
  const corrected = applyReadingFirstUserCorrections(data.candidate, options.user_corrections);
  const corrections = corrected === data.candidate ? null : options.user_corrections;
  const candidate = changed ? applyReadingFirstSourceDerivation({ ...data, candidate: corrected }, derivation) : corrected;
  const root = options.vaultRoot;
  if (!['actual', 'synthetic'].includes(options.evidenceMode) || !candidate?.notes || candidate.notes.length !== 2) fail('RF_PUBLICATION_INPUT_INVALID');
  const identity = { paper_id: data.identity.paper_id, run_id: data.identity.run_id,
    analysis_revision: data.identity.analysis_revision ?? 'rev_' + hash({ input: data.scientific_input_fingerprint,
      presentation: data.recipe.candidate.presentation_fingerprint }).slice(7, 39) };
  if (!identifier(identity.run_id)) fail('P22_RUN_REQUIRED');
  const generation = options.generation ?? 'rf-' + hash(identity).slice(7, 47);
  phase22GenerationPaths(generation);
  if (generation === base.generation?.generation_id) fail('P22_GENERATION_NOT_NEW');
  if (base.generation && base.generation.evidence_mode !== options.evidenceMode) fail('RF_PUBLICATION_EVIDENCE_MODE_MISMATCH');
  if (base.generation) { assertActiveGeneration(base.generation); assertIndexGeneration(base.index, base.generation); }
  const previousPaper = base.generation?.papers.find(row => row.paper_id === identity.paper_id);
  const registeredPaths = new Set(base.generation?.objects.map(row => row.path));
  const existingCanvases = base.generation ? registeredResearchMapPaths(base.generation, path => base.files.get(path)) : new Set();
  const beforeFiles = preimages ?? new Map();
  const before = path => {
    safePath(path);
    if (!beforeFiles.has(path)) {
      if (preimages) fail('RF_PUBLICATION_RECIPE_PREIMAGE_MISSING', { path });
      beforeFiles.set(path, projected?.has(path) ? projected.get(path) : regularBytes(root, path, { missing: true }));
    }
    const bytes = beforeFiles.get(path);
    if (bytes === null && registeredPaths.has(path)) fail('RF_PUBLICATION_PREVIOUS_OBJECT_MISSING', { path });
    if (existingCanvases.has(path)) parseRegisteredResearchMap(bytes, path);
    return bytes;
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
  const sharedNotes = candidate.supportNotes ?? [];
  const entityIdFor = path => shared.get(path)?.entity_id ?? 'rf_' + hash({ path }).slice(7, 39);
  const renderedRegistry = (data.recipe.knowledge_rebase?.rendering ?? data.recipe.rendering)?.knowledgeRegistry ?? [];
  const referenceRegistry = renderedRegistry.flatMap(row => {
    const entity = shared.get(row.canonical_path) ?? shared.get(row.path);
    return entity ? [{ ...row, entity_id: entity.entity_id }] : [];
  });
  const ownReferences = new Map(sharedNotes.map(note => [note.id, entityIdFor(note.path)]));
  const registeredPapers = new Set([identity.paper_id, ...(base.generation?.papers ?? []).map(paper => paper.paper_id)]);
  const resolveHistorical = (id, kind) => registeredKnowledgeReference(referenceRegistry, id, kind)?.entity_id;
  const resolveCurrent = (id, kind) => (kind === 'knowledge' ? ownReferences.get(id) : undefined) ?? resolveHistorical(id, kind);
  const knowledgeRenderHashes = {}, diagnostics = [];
  const migrations = metadataMigrations(options.knowledgeMetadataMigrations ?? [], candidate);
  for (const note of sharedNotes) {
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
    if (!migration && data.presentation.knowledge_layout === 'shared-bilingual-1.0') {
      const bound = bindPublishedKnowledgeReferences(bytes.toString('utf8'), {
        paperId: identity.paper_id, reused: original !== null, resolveCurrent, resolveHistorical, registeredPapers,
      });
      if (bound.content !== note.content) {
        knowledgeRenderHashes[path] = sha(reviewed);
        bytes = Buffer.from(bound.content);
      }
      for (const reference of bound.unresolved) diagnostics.push({ code: 'RF_KNOWLEDGE_REFERENCE_UNRESOLVED', path, details: { reference } });
    }
    requireV3Knowledge(bytes, path);
    if (comparison !== null && !comparison.equals(bytes)) { requireV3Knowledge(comparison, path); sameHumanKnowledge(comparison, bytes); }
    const entityId = entityIdFor(path);
    shared.set(path, { entity_id: entityId, path });
    supportTargets.push({ entity_id: entityId, path });
    add(path, 'support', bytes, { entity_id: entityId });
  }
  for (const resource of options.resources) {
    const bytes = readFileSync(resource.source_path), original = before(resource.path);
    if (sha(bytes) !== resource.sha256 || bytes.length !== resource.byte_length) fail('RF_PUBLICATION_RESOURCE_CHANGED', { path: resource.path });
    if (original !== null && !original.equals(bytes)) fail('RF_PUBLICATION_RESOURCE_TARGET_CONFLICT', { path: resource.path });
    if (original === null && resource.path.startsWith('Clippings/')) fail('RF_PUBLICATION_CLIPPINGS_ORIGINAL_REQUIRED', { path: resource.path });
    if (original === null) add(resource.path, 'asset', bytes);
    else { files.set(resource.path, bytes); readDependencies.push({ path: resource.path, byte_sha256: sha(bytes), byte_length: bytes.length }); }
  }
  const presentationAssets = [];
  for (const asset of candidate.generated_assets ?? []) {
    const { content, ...metadata } = asset;
    const bytes = Buffer.from(content), original = before(asset.path);
    if (asset.kind !== 'research-map-canvas' || !languages.includes(asset.language)
      || asset.path !== `Figures/${identity.run_id}/research-map.${asset.language}.canvas`
      || sha(bytes) !== asset.sha256 || bytes.length !== asset.byte_length
      || !candidate.assetPaths.includes(asset.path)) fail('RF_PUBLICATION_PRESENTATION_ASSET_INVALID', { path: asset.path });
    if (original !== null && !original.equals(bytes)) fail('RF_PUBLICATION_RESOURCE_TARGET_CONFLICT', { path: asset.path });
    if (original === null) add(asset.path, 'asset', bytes);
    else { files.set(asset.path, bytes); readDependencies.push({ path: asset.path, byte_sha256: sha(bytes), byte_length: bytes.length }); }
    presentationAssets.push(metadata);
  }
  const dependencies = { scientific_input: data.scientific_input_fingerprint,
    reading_review: data.reading_review_fingerprint, presentation: data.candidate.presentation_fingerprint,
    ...(corrections ? { user_corrections: hash(corrections) } : {}),
    ...(changed ? { source_derivation: clone(derivation) } : {}),
    ...(data.recipe.knowledge_rebase ? { knowledge_rebase: data.recipe.knowledge_rebase.rebase_fingerprint } : {}) };
  if (options.presentationAssetRegistrations?.length) dependencies.presentation_asset_registrations = hash(options.presentationAssetRegistrations);
  const manifestPath = '.apa-v3/reading-first/presentation/' + identity.run_id + '-' + hash(identity).slice(7, 31) + '.json';
  const outputFingerprint = changed || corrections ? hash({ original: data.candidate.presentation_fingerprint,
    ...(changed ? { source_derivation: derivation } : {}), ...(corrections ? { user_corrections: corrections } : {}), notes: noteTargets })
    : candidate.presentation_fingerprint;
  const presentation = { schema_version: 'reading-first-publication-1.0', profile, identity,
    presentation_fingerprint: outputFingerprint, scientific_input_fingerprint: data.scientific_input_fingerprint,
    evidence_mode: options.evidenceMode, dependencies, qualification: { reading_status: 'reading_complete', native_status: data.native_presentation.status },
    targets: { presentation: manifestPath, notes: noteTargets, support: supportTargets,
      assets: [...options.resources.map(row => row.path), ...presentationAssets.map(row => row.path)] },
    ...(presentationAssets.length ? { presentation_assets: presentationAssets } : {}), navigation: [] };
  const citation = publicationCitation(data, options.citationResources ?? options.resources, options.presentationAssetRegistrations ?? []);
  if (citation) {
    if (changed) {
      const byOld = new Map(derivation.remaps.map(row => [row.old_path, row.new_path]));
      citation.sources = [...citation.sources.map(row => ({ ...row, path: byOld.get(row.path) ?? row.path })),
        ...derivation.supplements.map(row => ({ source_id: row.source_id, path: row.path, sha256: row.sha256,
          byte_length: row.byte_length, source_version: null, locators: [] }))];
    }
    presentation.citation = citation;
  }
  assertReadingFirstPublicationManifest(presentation);
  const manifestBytes = jsonBytes(presentation);
  add(manifestPath, 'reader-presentation', manifestBytes);
  const paper = { ...identity, core_hash: data.scientific_input_fingerprint, pipeline_version: '3.0', profile: INDEX_READING_FIRST_PROFILE,
    dependencies, paths, reader_presentation: { path: manifestPath, sha256: sha(manifestBytes) } };
  const replacedPaths = new Set(previousPaper ? [...Object.values(previousPaper.paths), previousPaper.reader_presentation?.path].filter(Boolean) : []);
  const objects = new Map((base.generation?.objects ?? []).filter(row => !replacedPaths.has(row.path)).map(row => [row.path, clone(row)]));
  for (const path of existingCanvases) {
    const bytes = files.get(path);
    try { parseRegisteredResearchMap(bytes, path); } catch (error) {
      // The old registration remains when an unrelated Canvas cannot be observed.
      if (!['RF_PUBLICATION_PRESENTATION_ASSET_MISSING', 'RF_PUBLICATION_PRESENTATION_ASSET_INVALID'].includes(error.code)) throw error;
      continue;
    }
    objects.get(path).sha256 = sha(bytes);
  }
  for (const row of output) objects.set(row.path, { path: row.path, kind: row.kind === 'paper' ? 'v3-note' : row.kind,
    sha256: row.kind === 'paper' ? row.managed_hash : row.byte_sha256 });
  for (const resource of options.resources) if (!objects.has(resource.path)) objects.set(resource.path, { path: resource.path, kind: 'asset', sha256: resource.sha256 });
  for (const asset of presentationAssets) if (!objects.has(asset.path)) objects.set(asset.path, { path: asset.path, kind: 'asset', sha256: asset.sha256 });
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
    if (existingCanvases.has(object.path) || base.carryHistoricalDocuments && object.path.startsWith('Wiki/')) continue;
    const bytes = files.get(object.path);
    if (!(bytes instanceof Uint8Array)) fail('RF_PUBLICATION_PREVIOUS_OBJECT_MISSING', { path: object.path });
    readDependencies.push({ path: object.path, byte_sha256: sha(bytes), byte_length: bytes.length });
  }
  readDependencies.sort((a, b) => a.path.localeCompare(b.path));
  const scientificReviewHash = hash({ input: data.scientific_input_fingerprint, reading_review: data.reading_review_fingerprint,
    review_receipt: data.review_receipt, view_receipts: data.view_receipts,
    ...(data.reading_editor_receipt ? { reading_editor_receipt: data.reading_editor_receipt } : {}),
    ...(data.user_revision_checks ? { user_revision_checks: data.user_revision_checks } : {}),
    ...(data.recipe.knowledge_rebase ? { knowledge_rebase: data.recipe.knowledge_rebase.rebase_fingerprint } : {}),
    presentation: corrections ? data.candidate.presentation_fingerprint : outputFingerprint });
  const assetApprovals = options.presentationAssetRegistrations ?? [];
  const toolBindings = tools(), sourceBindings = [...new Map([...data.source_bindings, ...options.resources.map(row => binding(row.source_path)),
    ...(options.citationResources ?? []).map(row => binding(row.source_path)),
    ...assetApprovals.flatMap(row => [row.approval_binding, row.approved_candidate])]
    .map(row => [row.path, row])).values()];
  const status = options.evidenceMode === 'actual' ? 'review_ready' : 'synthetic_prepared';
  const reviewManifest = { schema_version: 'phase22/review-manifest-1.0', profile, identity, status,
    evidence_mode: options.evidenceMode, review_ready: options.evidenceMode === 'actual', publishable: false,
    reading_accepted: true, native_presentation: clone(data.native_presentation), scientific_review_hash: scientificReviewHash,
    generation, previous_generation: base.generation?.generation_id ?? null, previews,
    support_notes: supportTargets.map(row => ({ ...row, ...(migrations.has(row.path) ? { metadata_migration: migrations.get(row.path) } : {}) })),
    assets: [...options.resources, ...presentationAssets].map(({ path, sha256, byte_length }) => {
      const approval = assetApprovals.find(row => row.resource.path === path);
      return { path, byte_sha256: sha256, byte_length, ...(approval ? { presentation_asset_registration: clone(approval) } : {}) };
    }),
    read_dependencies: readDependencies, dependencies, tools: Object.fromEntries(toolBindings.map(row => [row.path, row.sha256])),
    index: { path: pairPaths.index, byte_sha256: built.sha256 }, active: { path: pairPaths.active, byte_sha256: sha(jsonBytes(built.generation)) },
    write_set: output.map(({ bytes, ...row }) => row), diagnostics,
    provenance_limits: { native_presentation: data.native_presentation.status, scientific_review_scope: data.review.scope, independent_first_read: 'not_asserted',
      ...(corrections ? { user_corrections: corrections } : {}),
      ...(Object.keys(knowledgeRenderHashes).length ? { knowledge_render_hashes: knowledgeRenderHashes } : {}) } };
  contractValidator ??= createPhase22ContractValidator();
  (await contractValidator).assert('phase22/review-manifest-1.0', reviewManifest);
  add('.apa-v3/phase22/generations/' + generation + '/manifest.json', 'manifest', jsonBytes(reviewManifest));
  output.sort((a, b) => a.path.localeCompare(b.path));
  const hashes = { scientific_review_hash: scientificReviewHash,
    review_bundle_hash: hash({ reviewManifest, outputs: inventoryStamp(output), read_dependencies: readDependencies }),
    output_inventory_hash: hash({ generation, previous_generation: reviewManifest.previous_generation, output: inventoryStamp(output), read_dependencies: readDependencies }) };
  const result = freeze({ ok: true, status, reviewManifest, outputInventory: output, hashes, diagnostics });
  if (projected) return result;
  const recipe = { source: data.recipe };
  records.set(result, { source, recipe, sourceBindings, toolBindings, sourcePlan: options.sourceDerivation,
    publicationSources: options.publicationSources, sourceOptions: options.citationResources ? {
      vaultRoot: root, resources: options.citationResources, approvals: options.presentationAssetRegistrations, base, matchMetadata: options.sourceMatchMetadata,
    } : null,
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

/** A new same-byte original after the displayed inventory requires a fresh approval. */
export async function assertReadingFirstPublicationSourceChoicesCurrent(review) {
  const record = records.get(review);
  if (!record?.sourceOptions) return;
  const { vaultRoot, resources, approvals, base, matchMetadata } = record.sourceOptions;
  const data = await inspectReadingFirstPublicationSource(record.source);
  const next = sourcePlan(vaultRoot, data, resources, base, approvals, matchMetadata);
  if (!same(record.sourcePlan, next.sourceDerivation)) fail('RF_PUBLICATION_SOURCE_SELECTION_CHANGED', { proposed: next.publicationSources });
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
    ...(data.recipe.knowledge_rebase || review.reviewManifest.dependencies.source_derivation || review.reviewManifest.dependencies.user_corrections
      ? { reading_first_source: clone(data.recipe) } : {}),
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
  return { ...dry, review, sourceInputs: { readingFirst: { source } }, publication_sources: records.get(review).publicationSources };
}

/** Plan sequential writes in memory. Projected outputs never acquire a live review or transaction capability. */
export async function projectReadingFirstPublicationQueue({ vaultRoot, requests, evidenceMode = 'actual' }) {
  const root = rootPath(vaultRoot);
  const checked = await assertReadingFirstRegisteredSourcesCurrent({ vaultRoot: root });
  const registry = new Map((await readCommittedReadingFirstKnowledgeRegistry({ vaultRoot: root })).map(row => [row.path, row]));
  const matchMetadata = await readRegisteredSourceMatchMetadata({ vaultRoot: root, registered: checked ?? undefined });
  const projected = new Map();
  const before = path => projected.has(path) ? projected.get(path) : regularBytes(root, path, { missing: true });
  let base = { ...await baseFor(root, true, checked), carryHistoricalDocuments: true };
  const outputs = [];
  for (const { source, generation, resources, user_corrections, presentationAssetRegistrations: assetApprovals } of requests) {
    const data = await inspectReadingFirstPublicationSource(source);
    const boundRoot = data.recipe.binding?.configured_setup?.knowledge_registry?.vault_root;
    if (data.origin !== 'live' || data.recipe.knowledge_rebase || boundRoot && resolve(boundRoot) !== root) {
      fail('RF_PUBLICATION_LIVE_SOURCE_REQUIRED');
    }
    const preview = base.generation && data.recipe.rendering
      ? await previewReadingFirstPublicationRebase({ source, vaultRoot: root, registry: [...registry.values()], generationId: base.generation.generation_id })
      : { status: 'not_needed' };
    const selected = preview.record
      ? { ...data, recipe: { ...data.recipe, knowledge_rebase: preview.record }, candidate: preview.record.candidate }
      : data;
    const approvals = presentationAssetRegistrations(selected, resources, assetApprovals);
    const sourceOptions = sourcePlan(root, selected, await resourceBindings(selected, resources, approvals), base, approvals, matchMetadata, before);
    const review = await buildReview({ source, data: selected, options: { vaultRoot: root, generation, evidenceMode, ...sourceOptions,
      ...(user_corrections === undefined ? {} : { user_corrections: clone(user_corrections) }),
      ...(approvals.length ? { presentationAssetRegistrations: approvals } : {}) }, base, preimages: null, projected });
    const { outputInventory: inventory, reviewManifest: manifest } = review;
    const active = JSON.parse(inventory.find(row => row.kind === 'active').bytes);
    const index = JSON.parse(inventory.find(row => row.kind === 'index').bytes);
    assertActiveGeneration(active);
    assertIndexGeneration(index, active);
    for (const row of inventory) {
      projected.set(row.path, row.bytes);
      if (row.kind === 'support') {
        registry.set(row.path, readKnowledgeRegistryRow({ path: row.path, content: row.bytes.toString('utf8'),
          entityId: row.entity_id, registeredAliases: registry.get(row.path)?.registered_aliases }));
      }
    }
    const selectedObjectPaths = new Set(active.objects.map(row => row.path));
    const files = new Map([...base.files].filter(([path]) => selectedObjectPaths.has(path)));
    for (const row of inventory) if (selectedObjectPaths.has(row.path)) files.set(row.path, row.bytes);
    // Existing input assets (such as a Clippings original) can enter the projected registration without a write.
    for (const object of active.objects) if (!files.has(object.path)) files.set(object.path, before(object.path));
    const { citation } = JSON.parse(inventory.find(row => row.kind === 'reader-presentation').bytes);
    const original = citation?.sources?.[0];
    if (original) {
      const list = original.path.startsWith('Clippings/') ? matchMetadata.sources : original.path.startsWith('Raw/') ? matchMetadata.rawSources : null;
      list?.push({ path: original.path, sha256: original.sha256, byte_length: original.byte_length,
        doi: citation.bibliography.doi, title: citation.bibliography.title });
    }
    base = { snapshot: null, generation: active, index, files, carryHistoricalDocuments: true };
    outputs.push({ status: 'projected_dry_run', business_writes: 0, model_calls: 0,
      summary: { run_id: manifest.identity.run_id, generation: manifest.generation, previous_generation: manifest.previous_generation,
        files: inventory.map(({ bytes, ...row }) => row),
        projected_review_hash: review.hashes.review_bundle_hash,
        projected_output_inventory_hash: review.hashes.output_inventory_hash },
      ...(preview.record ? { rebase_fingerprint: preview.record.rebase_fingerprint,
        ...(preview.record.review_required ? { requires_reapproval: true } : {}) } : {}) });
  }
  return outputs;
}

// The record must belong to the corrected run, and every catalog in it must agree on which source each visual belongs to.
function frozenVisualSources(value, main, runId, migration) {
  const mainPath = main?.path;
  const mapped = (path, sourceId) => {
    const row = migration.get(path);
    if (!row) return path;
    if (!sourceId || row.source_id !== sourceId) {
      fail('RF_PUBLICATION_CITATION_MIGRATION_INVALID', { path, source_id: sourceId });
    }
    return row.new_path;
  };
  const catalogs = [], runs = new Set(), walk = item => {
    if (Array.isArray(item)) item.forEach(walk);
    else if (item && typeof item === 'object') {
      if (Array.isArray(item.visuals) && (item.source_pdf === mainPath || migration.get(item.source_pdf)?.new_path === mainPath)) {
        if (mapped(item.source_pdf, main?.source_id) === mainPath) catalogs.push(item);
      }
      if (typeof item.run_id === 'string') runs.add(item.run_id);
      Object.values(item).forEach(walk);
    }
  };
  walk(value);
  if (!runs.has(runId)) fail('RF_CITATION_CORRECTION_SCOPE', { reason: 'catalog record does not belong to the run' });
  if (!catalogs.length && mainPath?.startsWith('Clippings/')) fail('RF_PUBLICATION_CITATION_MIGRATION_REQUIRED', { path: mainPath, run_id: runId });
  if (!catalogs.length) fail('RF_CITATION_CORRECTION_SCOPE');
  const visuals = new Map(), sources = new Map();
  for (const catalog of catalogs) {
    for (const row of catalog.visuals) {
      if (visuals.has(row.id) && visuals.get(row.id) !== (row.source_id ?? null)) fail('RF_CITATION_CORRECTION_SCOPE', { visual: row.id });
      visuals.set(row.id, row.source_id ?? null);
    }
    for (const row of catalog.sources ?? []) {
      const path = mapped(row.path, row.id);
      if (sources.has(row.id) && sources.get(row.id) !== path) fail('RF_CITATION_CORRECTION_SCOPE', { source: row.id });
      sources.set(row.id, path);
    }
  }
  return { visuals, sources };
}

function citationMigration(manifest, generation, files) {
  const result = new Map();
  for (const row of manifest.path_migration?.assets ?? []) {
    if (!paperSourcePath(row.old_path) && !paperSourcePath(row.new_path)) continue;
    safePath(row.old_path); safePath(row.new_path);
    const bytes = files.get(row.new_path), asset = generation.objects.find(item => item.path === row.new_path);
    const citation = manifest.citation?.sources.find(item => item.path === row.new_path);
    if (!paperSourcePath(row.old_path) || !paperSourcePath(row.new_path) || row.old_path === row.new_path
      || !manifest.targets.assets.includes(row.new_path) || asset?.kind !== 'asset' || asset.sha256 !== row.sha256
      || !bytes || bytes.length !== row.byte_length || sha(bytes) !== row.sha256 || result.has(row.old_path)
      || (citation && (citation.sha256 !== row.sha256 || citation.byte_length !== row.byte_length
        || citation.source_id !== row.source_id))) {
      fail('RF_PUBLICATION_CITATION_MIGRATION_INVALID', { path: row.old_path, target: row.new_path, source_id: row.source_id });
    }
    result.set(row.old_path, row);
  }
  return result;
}

// Committed locators keep their exact bytes; only their grouping under sources changes.
function correctedCitation(manifest, frozen, generation, files) {
  const old = manifest.citation, main = old?.sources?.[0];
  if (!main) fail('RF_CITATION_CORRECTION_SCOPE');
  const locators = old.sources.flatMap(row => row.locators);
  if (locators.some(row => !frozen.visuals.has(row.id))) fail('RF_CITATION_CORRECTION_SCOPE');
  const sourceOf = row => frozen.visuals.get(row.id) ?? main.source_id;
  return { ...clone(old), sources: [...new Set([main.source_id, ...locators.map(sourceOf),
    ...old.sources.filter(row => !row.locators.length).map(row => row.source_id)])].map(id => {
    const prior = old.sources.find(row => row.source_id === id), path = prior?.path ?? frozen.sources.get(id);
    const object = generation.objects.find(row => row.path === path);
    if (!manifest.targets.assets.includes(path) || object?.kind !== 'asset' || !files.has(path)
      || (prior && (prior.sha256 !== object.sha256 || prior.byte_length !== files.get(path).length))
      || (prior && frozen.sources.has(id) && frozen.sources.get(id) !== path)) fail('RF_PUBLICATION_CITATION_SOURCE_UNREGISTERED', { source_id: id, path });
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
  const migration = citationMigration(manifest, base.generation, base.files);
  const frozen = frozenVisualSources(JSON.parse(readFileSync(catalogBinding.path, 'utf8')), manifest.citation?.sources?.[0], runId, migration);
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
  for (const note of [...candidate.notes, ...candidate.supportNotes, ...(candidate.generated_assets ?? [])]) {
    const bytes = regularBytes(candidateRootAbs, note.path);
    if (!bytes.equals(Buffer.from(note.content))) fail('RF_PUBLICATION_EXTERNAL_CANDIDATE_CHANGED', { path: note.path });
  }
  const sourceBindings = [...new Map([
    ...scientificInput.sources.map(row => binding(row.path)),
    ...resources.map(row => binding(row.source_path)),
    ...[...candidate.notes, ...candidate.supportNotes, ...(candidate.generated_assets ?? [])].map(row => binding(join(candidateRootAbs, row.path))),
    ...[viewReceipts.en, viewReceipts['zh-CN'], readingEditorReceipt, reviewReceipt].flatMap(receipt => [
      binding(join(runRoot, receipt.path)),
      binding(join(runRoot, '.phase21-receipts', encodeURIComponent(receipt.artifact_id) + '.json')),
    ]),
  ].map(row => [row.path, row])).values()];
  const editorValue = JSON.parse(readFileSync(join(runRoot, readingEditorReceipt.path), 'utf8'));
  if (['reading-editor-1.3', 'reading-editor-1.4'].includes(editorValue.schema_version) && !readingFirstBinding) fail('RF_PUBLICATION_EXTERNAL_BINDING_REQUIRED');
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
  const matchMetadata = await readRegisteredSourceMatchMetadata({ vaultRoot: root });
  const options = { vaultRoot: root, generation, evidenceMode, ...sourcePlan(root, data, await resourceBindings(data, resources), base, [], matchMetadata) };
  const resultReview = await buildReview({ source, data, options, base, preimages: null });
  source = createExternalReadingFirstPublicationSource(sourceRecipe);
  data = await inspectReadingFirstPublicationSource(source);
  const record = records.get(resultReview);
  record.recipe = { source: sourceRecipe };
  record.source = source;
  record.sourceBindings = [...new Map([...sourceBindings, ...options.resources.map(row => binding(row.source_path)),
    ...options.citationResources.map(row => binding(row.source_path))]
    .map(row => [row.path, row])).values()];
  record.toolBindings = [...new Map([...tools(), ...getReadingFirstRuntimePublicationToolBindings(readingFirstBinding)]
    .map(row => [row.path, row])).values()];
  record.stamp = hash({ manifest: resultReview.reviewManifest, output: inventoryStamp(resultReview.outputInventory), hashes: resultReview.hashes });
  const { dryRunBilingualPublication } = await import('./phase22-publication.mjs');
  const dry = await dryRunBilingualPublication({ vaultRoot: root, run: resultReview.reviewManifest.identity.run_id, review: resultReview });
  return { ...dry, review: resultReview, sourceInputs: { readingFirst: { source } }, external_source_recipe: sourceRecipe,
    publication_sources: record.publicationSources };
}
