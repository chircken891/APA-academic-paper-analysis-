import { createHash } from 'node:crypto';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, join, posix } from 'node:path';
import { fingerprintV3Json as hash } from './semantic-package-validator.mjs';
import { readCommittedGeneration, assertActiveGeneration, phase22GenerationPaths } from './phase22-active-version.mjs';
import { inspectManagedNote } from './phase22-managed-markdown.mjs';
import { assertReadingFirstPublicationManifest } from './reading-first-index.mjs';
import { buildBilingualIndex } from './phase22-search.mjs';
import { createPhase22ContractValidator } from './phase22-contract-loader.mjs';

export const NOTE_RELOCATION_PROFILE = 'phase22-note-relocation-1.0';
const records = new WeakMap();
const languages = ['en', 'zh-CN'];
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(JSON.stringify(value) + '\n');
const fail = (code, details = {}) => { throw Object.assign(new Error(code), { code, details }); };
function freeze(value) {
  if (value && typeof value === 'object' && !(value instanceof Uint8Array) && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
function bytesAt(root, path, missing = false) {
  if (typeof path !== 'string' || !path || /[\\\x00-\x1f<>:"|?*]/.test(path)
    || path.startsWith('/') || path.split('/').some(part => !part || ['.', '..'].includes(part))) fail('P22_RELOCATION_PATH_INVALID', { path });
  let cursor = root;
  for (const [index, part] of path.split('/').entries()) {
    cursor = join(cursor, part);
    let stat;
    try { stat = lstatSync(cursor); } catch (error) { if (missing && error.code === 'ENOENT') return null; throw error; }
    if (stat.isSymbolicLink() || realpathSync(cursor) !== cursor
      || (index < path.split('/').length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) fail('P22_RELOCATION_FILE_TYPE', { path });
  }
  return readFileSync(cursor);
}
function toolHashes() {
  return Object.fromEntries(['./note-relocation.mjs', './phase22-review.mjs', './phase22-publication.mjs',
    './phase22-active-version.mjs', './phase22-search.mjs', './reading-first-index.mjs', './phase22-managed-markdown.mjs',
    '../../Schema/phase22/review-manifest.schema.json', '../../Schema/phase22/reading-first-publication.schema.json']
    .map(path => [path, sha(readFileSync(new URL(path, import.meta.url)))]));
}
function inventoryStamp(rows) { return rows.map(({ bytes, ...row }) => ({ ...row, observed_sha256: sha(bytes) })); }
function stamp(review) { return hash({ manifest: review.reviewManifest, output: inventoryStamp(review.outputInventory), hashes: review.hashes }); }

// Only link destinations and the explicit alternate-language property change.
// Labels, paragraphs, scientific values, anchors and personal prose stay byte-for-byte.
export function relocateNoteLinks(text, from, to, paths) {
  const mapping = new Map(paths);
  const href = raw => {
    const angle = raw.startsWith('<') && raw.endsWith('>');
    const value = angle ? raw.slice(1, -1) : raw;
    if (!value || value.startsWith('#') || /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(value)) return raw;
    const offset = value.search(/[?#]/), pathPart = offset < 0 ? value : value.slice(0, offset), suffix = offset < 0 ? '' : value.slice(offset);
    let decoded;
    try { decoded = decodeURIComponent(pathPart); } catch { return raw; }
    const absolute = posix.normalize(posix.join(posix.dirname(from), decoded));
    const target = mapping.get(absolute) ?? absolute;
    if (target === absolute && posix.dirname(from) === posix.dirname(to)) return raw;
    const relative = posix.relative(posix.dirname(to), target).split('/').map(encodeURIComponent).join('/') + suffix;
    return angle ? '<' + relative + '>' : relative;
  };
  let result = text.replace(/(\]\()(<[^>\r\n]+>|[^\s)]+)(?=[\s)])/g, (_, prefix, target) => prefix + href(target));
  result = result.replace(/\[\[([^\]|\r\n]+)(\|[^\]\r\n]*)?\]\]/g, (whole, target, label = '') => {
    const offset = target.indexOf('#'), base = offset < 0 ? target : target.slice(0, offset), suffix = offset < 0 ? '' : target.slice(offset);
    const destination = mapping.get(base) ?? mapping.get(base + '.md');
    return destination ? '[[' + (base.endsWith('.md') ? destination : destination.replace(/\.md$/, '')) + suffix + label + ']]' : whole;
  });
  result = result.replace(/^(alternate_language_path: *)([^\r\n]+)$/m, (whole, prefix, value) => {
    const quote = /^(['"])(.*)\1$/.exec(value), path = quote ? quote[2] : value;
    const target = mapping.get(path);
    return target ? prefix + (quote ? quote[1] + target + quote[1] : target) : whole;
  });
  return result;
}

/** Prepare a deterministic path-only revision of an already committed reading.
 * No caller-supplied prose or scientific approval is accepted. The existing
 * transaction supplies exact authorization, history snapshots and crash recovery.
 * Superseded visible files remain until a separately inventoried retirement move.
 */
export async function buildNoteRelocationReview({ vaultRoot, runId, generation, papers } = {}) {
  const root = resolve(vaultRoot ?? '');
  if (!vaultRoot || realpathSync(root) !== root || !lstatSync(root).isDirectory()
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(runId ?? '')) fail('P22_RELOCATION_SCOPE_INVALID');
  const base = await readCommittedGeneration({ vaultRoot: root });
  if (!base.ok) fail('P22_RELOCATION_COMMITTED_REQUIRED', { errors: base.errors });
  if (!Array.isArray(papers) || !papers.length || new Set(papers.map(row => row.paperId)).size !== papers.length) fail('P22_RELOCATION_PAPERS_REQUIRED');
  const generationPaths = phase22GenerationPaths(generation);
  if (generation === base.generation_id) fail('P22_GENERATION_NOT_NEW');
  const mapping = new Map(), relocations = [];
  const files = new Map(base.generation.objects.map(row => [row.path, bytesAt(root, row.path)]));
  const active = structuredClone(base.generation);
  delete active.index_manifest;
  active.generation_id = generation;
  for (const selection of papers) {
    const paper = active.papers.find(row => row.paper_id === selection.paperId);
    if (!paper || paper.profile !== 'reading-first-obsidian-1.0' || !languages.includes(selection.sourceLanguage)) fail('P22_RELOCATION_PAPER_INVALID');
    for (const language of languages) {
      const from = paper.paths[language], folder = language === selection.sourceLanguage ? 'sources' : 'translations';
      if (!/^Wiki\/(sources|translations)\/[^/]+\.(en|zh-CN)\.md$/.test(from)) fail('P22_RELOCATION_PATH_INVALID', { path: from });
      const to = 'Wiki/' + folder + '/' + posix.basename(from);
      if (from === to) continue;
      if (bytesAt(root, to, true) !== null || [...mapping.values()].some(value => value.normalize('NFC').toLowerCase() === to.normalize('NFC').toLowerCase())) fail('P22_RELOCATION_TARGET_OCCUPIED', { path: to });
      const original = files.get(from);
      relocations.push({ paper_id: paper.paper_id, source_language: selection.sourceLanguage, language, from, to,
        before_sha256: sha(original), before_byte_length: original.length });
      mapping.set(from, to); paper.paths[language] = to;
    }
  }
  if (!mapping.size) fail('P22_RELOCATION_NO_CHANGES');
  const output = [], previews = [];
  const add = (path, kind, bytes, extra = {}) => {
    const previous = bytesAt(root, path, true), owned = Buffer.from(bytes);
    const row = { path, kind, bytes: owned, byte_sha256: sha(owned), byte_length: owned.length,
      before_sha256: previous === null ? null : sha(previous), before_byte_length: previous?.length ?? null, ...extra };
    output.push(row); files.set(path, owned); return row;
  };
  for (const object of active.objects) {
    const from = object.path, to = mapping.get(from) ?? from;
    if (!from.endsWith('.md')) continue;
    const original = files.get(from), bytes = Buffer.from(relocateNoteLinks(original.toString('utf8'), from, to, mapping));
    if (from === to && bytes.equals(original)) continue;
    if (object.kind === 'v3-note') {
      const inspected = inspectManagedNote(bytes), previous = inspectManagedNote(original);
      if (inspected.frontmatter.rendering_profile !== 'reading-first-obsidian-1.0') fail('P22_RELOCATION_PROFILE_UNSUPPORTED');
      add(to, 'paper', bytes, { language: inspected.frontmatter.language, managed_hash: inspected.managedHash,
        before_managed_hash: from === to ? previous.managedHash : null });
      object.sha256 = inspected.managedHash;
      previews.push({ path: to, language: inspected.frontmatter.language, byte_sha256: sha(bytes), managed_hash: inspected.managedHash });
    } else if (object.kind === 'support') {
      add(to, 'support', bytes); object.sha256 = sha(bytes);
    } else fail('P22_RELOCATION_PROFILE_UNSUPPORTED', { path: from });
    object.path = to;
    if (from !== to) files.delete(from);
  }
  const transformedPapers = [];
  for (const paper of active.papers) {
    if (paper.profile !== 'reading-first-obsidian-1.0') fail('P22_RELOCATION_PROFILE_UNSUPPORTED');
    const oldManifest = paper.reader_presentation.path;
    const manifest = JSON.parse(files.get(oldManifest));
    const originalManifestHash = paper.reader_presentation.sha256;
    const changed = languages.some(language => output.some(row => row.path === paper.paths[language]));
    if (changed) {
      const path = '.apa-v3/reading-first/presentation/' + paper.paper_id + '-' + generation + '.json';
      if (bytesAt(root, path, true) !== null) fail('P22_RELOCATION_TARGET_OCCUPIED', { path });
      manifest.targets.presentation = path;
      for (const language of languages) {
        const note = files.get(paper.paths[language]);
        manifest.targets.notes[language] = { path: paper.paths[language], managed_hash: inspectManagedNote(note).managedHash, byte_sha256: sha(note) };
      }
      manifest.path_migration = { previous_generation: base.generation_id, previous_presentation_sha256: originalManifestHash,
        path_mapping_fingerprint: hash([...mapping]) };
      const bytes = jsonBytes(manifest);
      assertReadingFirstPublicationManifest(manifest);
      add(path, 'reader-presentation', bytes);
      active.objects = active.objects.filter(row => row.path !== oldManifest);
      active.objects.push({ path, kind: 'reader-presentation', sha256: sha(bytes) });
      paper.reader_presentation = { path, sha256: sha(bytes) };
      files.delete(oldManifest);
    }
    transformedPapers.push({ readingFirst: manifest, notes: Object.fromEntries(languages.map(language => [language, files.get(paper.paths[language])])) });
  }
  active.objects.sort((a, b) => a.path.localeCompare(b.path));
  assertActiveGeneration(active);
  const built = await buildBilingualIndex({ generation: active, validatedInputs: { papers: transformedPapers,
    files: [...files].map(([path, bytes]) => ({ path, bytes })), previousSnapshot: base } });
  add(generationPaths.active, 'active', jsonBytes(built.generation));
  add(generationPaths.index, 'index', built.bytes);
  const written = new Set(output.map(row => row.path));
  const readDependencies = base.generation.objects.filter(row => !written.has(row.path)).map(row => {
    const bytes = bytesAt(root, row.path);
    return { path: row.path, byte_sha256: sha(bytes), byte_length: bytes.length };
  });
  const toolBindings = toolHashes();
  const scientificReviewHash = hash({ kind: 'preserved-committed-reading', previous_generation: base.generation_id,
    papers: base.generation.papers.map(({ paper_id, core_hash, dependencies }) => ({ paper_id, core_hash, dependencies })) });
  const reviewManifest = { schema_version: 'phase22/review-manifest-1.0', profile: NOTE_RELOCATION_PROFILE,
    identity: { paper_id: 'library-path-maintenance', run_id: runId, analysis_revision: 'paths_' + hash(relocations).slice(7, 39) },
    status: base.evidence_mode === 'actual' ? 'review_ready' : 'synthetic_prepared', evidence_mode: base.evidence_mode,
    review_ready: base.evidence_mode === 'actual', publishable: false, reading_accepted: true,
    native_presentation: { status: 'not_run' }, scientific_review_hash: scientificReviewHash,
    generation, previous_generation: base.generation_id, previews, support_notes: active.shared_nodes,
    assets: [], read_dependencies: readDependencies, dependencies: { previous_generation: base.generation_id }, tools: toolBindings,
    index: { path: generationPaths.index, byte_sha256: built.sha256 },
    active: { path: generationPaths.active, byte_sha256: sha(jsonBytes(built.generation)) },
    write_set: output.map(({ bytes, ...row }) => row), relocations,
    diagnostics: [], provenance_limits: { scientific_review_scope: 'existing committed acceptance retained; deterministic paths and link targets only', native_presentation: 'not_run' } };
  (await createPhase22ContractValidator()).assert('phase22/review-manifest-1.0', reviewManifest);
  add('.apa-v3/phase22/generations/' + generation + '/manifest.json', 'manifest', jsonBytes(reviewManifest));
  output.sort((a, b) => a.path.localeCompare(b.path));
  const hashes = { scientific_review_hash: scientificReviewHash,
    review_bundle_hash: hash({ reviewManifest, outputs: inventoryStamp(output), read_dependencies: readDependencies }),
    output_inventory_hash: hash({ generation, previous_generation: base.generation_id, output: inventoryStamp(output), read_dependencies: readDependencies }) };
  const result = freeze({ ok: true, status: reviewManifest.status, reviewManifest, outputInventory: output, hashes, diagnostics: [] });
  records.set(result, { stamp: stamp(result), tools: toolBindings });
  return result;
}

export function assertNoteRelocationReviewCurrent(review) {
  const record = records.get(review);
  if (!record) fail('P22_REVIEW_NOT_OWNED');
  if (stamp(review) !== record.stamp) fail('P22_REVIEW_OUTPUT_INVALIDATED');
  if (hash(record.tools) !== hash(toolHashes())) fail('P22_REVIEW_TOOL_INVALIDATED');
  return review;
}
