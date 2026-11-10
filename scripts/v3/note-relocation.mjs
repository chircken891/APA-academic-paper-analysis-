import { createHash } from 'node:crypto';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, join, posix } from 'node:path';
import { fingerprintV3Json as hash } from './semantic-package-validator.mjs';
import { readRegisteredCommit, assertRegisteredCommit, assertActiveGeneration, phase22GenerationPaths } from './phase22-active-version.mjs';
import { inspectManagedNote } from './phase22-managed-markdown.mjs';
import { assertReadingFirstPublicationManifest, parseRegisteredResearchMap, registeredResearchMapPaths, verifyReadingFirstPresentation } from './reading-first-index.mjs';
import { buildBilingualIndex } from './phase22-search.mjs';
import { createPhase22ContractValidator } from './phase22-contract-loader.mjs';

export const NOTE_RELOCATION_PROFILE = 'phase22-note-relocation-1.0';
const records = new WeakMap();
const languages = ['en', 'zh-CN'];
const sourcePath = path => /^(Raw|Clippings)\/.+\.(pdf|docx)$/i.test(path);
const figurePath = path => /^Figures\/.+/.test(path);
const pathKey = path => path.normalize('NFC').toLowerCase();
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
  return relocateLinks(text, from, to, mapping, base => {
    const destination = mapping.get(base) ?? mapping.get(base + '.md');
    return base.endsWith('.md') ? destination : destination?.replace(/\.md$/, '');
  });
}

function relocateLinks(text, from, to, mapping, wikiDestination) {
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
    const relative = posix.relative(posix.dirname(to), target).split('/').map(part => encodeURIComponent(part)
      .replaceAll('(', '%28').replaceAll(')', '%29')).join('/') + suffix;
    return angle ? '<' + relative + '>' : relative;
  };
  let result = text.replace(/(\]\()(<[^>\r\n]+>|[^\s)]+)(?=[\s)])/g, (_, prefix, target) => prefix + href(target));
  result = result.replace(/\[\[([^\]|\r\n]+)(\|[^\]\r\n]*)?\]\]/g, (whole, target, label = '') => {
    const offset = target.indexOf('#'), base = offset < 0 ? target : target.slice(0, offset), suffix = offset < 0 ? '' : target.slice(offset);
    const destination = wikiDestination(base);
    return destination ? '[[' + destination + suffix + label + ']]' : whole;
  });
  result = result.replace(/^(alternate_language_path: *)([^\r\n]+)$/m, (whole, prefix, value) => {
    const quote = /^(['"])(.*)\1$/.exec(value), path = quote ? quote[2] : value;
    const target = mapping.get(path);
    return target ? prefix + (quote ? quote[1] + target + quote[1] : target) : whole;
  });
  return result;
}

export function relocateCanvasLinks(bytes, from, to, mapping, registeredPaths) {
  const canvas = parseRegisteredResearchMap(bytes, from);
  const wikiDestination = base => {
    let path;
    try { path = decodeURIComponent(base); } catch { return undefined; }
    if (!path) return undefined;
    const relative = /^\.\.?\//.test(path);
    const absolute = relative ? posix.normalize(posix.join(posix.dirname(from), path)) : path;
    let target = mapping.get(absolute) ?? mapping.get(absolute + '.md');
    if (!target && !path.includes('/')) {
      // A short link has no vault path. Use the committed set to identify its old target.
      const basename = value => pathKey(posix.basename(value)).replace(/\.md$/, '');
      const matches = registeredPaths.filter(value => basename(value) === basename(path));
      if (matches.some(value => mapping.has(value))) {
        if (matches.length !== 1) fail('P22_RELOCATION_CANVAS_LINK_AMBIGUOUS', { canvas: from, target: base });
        target = mapping.get(matches[0]);
      }
    }
    if (!target && relative && posix.dirname(from) !== posix.dirname(to) && !absolute.startsWith('../')) target = absolute;
    return target && (path.endsWith('.md') ? target : target.replace(/\.md$/, '')).replace(/[%#\[\]|]/g, encodeURIComponent);
  };
  let changed = false;
  for (const node of canvas.nodes) {
    if (node.type === 'text') {
      const text = relocateLinks(node.text, from, to, mapping, wikiDestination);
      if (text !== node.text) { node.text = text; changed = true; }
    } else if (node.type === 'file' && mapping.has(node.file)) {
      node.file = mapping.get(node.file); changed = true;
    }
  }
  return changed ? Buffer.from(JSON.stringify(canvas, null, 2) + '\n') : bytes;
}

function assertFigureDestination(row, presentations) {
  const { old_path: from, new_path: to } = row;
  const owners = presentations.filter(({ manifest }) => manifest.targets.assets.includes(from));
  const current = owners.filter(({ paper }) => paper);
  const runIds = new Set((current.length ? current : owners).map(({ manifest }) => manifest.identity.run_id));
  if (runIds.size === 1 && to === 'Figures/' + [...runIds][0] + '/' + posix.basename(from)) return;
  if (owners.length && owners.every(({ manifest }) => manifest.path_migration?.assets?.some(previous => previous.old_path === to
    && previous.new_path === from && previous.sha256 === row.sha256 && previous.byte_length === row.byte_length))) return;
  fail('P22_RELOCATION_FIGURE_TARGET_INVALID', { from, to, owner_runs: [...runIds] });
}

function assetChanges(root, objects, files, mappings, retirements, presentations, currentMaps) {
  const registered = new Map(objects.map(row => [pathKey(row.path), row]));
  const moves = new Map(), retired = new Map(), destinations = new Set();
  const boundAsset = (path, row) => {
    const bytes = files.get(path), registeredAsset = registered.get(pathKey(path));
    if (registeredAsset?.kind !== 'asset' || registeredAsset.path !== path || !currentMaps.has(path) && registeredAsset.sha256 !== row.sha256
      || !bytes || bytes.length !== row.byte_length || sha(bytes) !== row.sha256) fail('P22_RELOCATION_ASSET_INVALID', { path });
    return bytes;
  };
  for (const row of mappings) {
    if (!row || typeof row.old_path !== 'string' || typeof row.new_path !== 'string') fail('P22_RELOCATION_ASSET_INVALID');
    const { old_path: from, new_path: to } = row;
    const documents = sourcePath(from) && sourcePath(to) && (from.startsWith('Clippings/') || to.startsWith('Clippings/'))
      && posix.extname(from).toLowerCase() === posix.extname(to).toLowerCase();
    const figures = figurePath(from) && figurePath(to) && posix.basename(from) === posix.basename(to);
    if ((!documents && !figures) || pathKey(from) === pathKey(to) || moves.has(from)
      || destinations.has(pathKey(to)) || registered.has(pathKey(to))
      || row.source_id !== undefined && (!documents || typeof row.source_id !== 'string' || !/\S/.test(row.source_id))) {
      fail('P22_RELOCATION_ASSET_INVALID', { from, to });
    }
    if (figures) assertFigureDestination(row, presentations);
    const bytes = boundAsset(from, row), target = bytesAt(root, to, true);
    if (target !== null && !target.equals(bytes)) fail('P22_RELOCATION_TARGET_OCCUPIED', { path: to });
    if (target === null && to.startsWith('Clippings/')) fail('P22_RELOCATION_CLIPPINGS_ORIGINAL_REQUIRED', { path: to });
    moves.set(from, { old_path: from, new_path: to, sha256: row.sha256, byte_length: row.byte_length,
      ...(row.source_id === undefined ? {} : { source_id: row.source_id }), targetExists: target !== null });
    destinations.add(pathKey(to));
  }
  for (const row of retirements) {
    const path = row?.path;
    if (typeof path !== 'string' || !/^Raw\/.+\.docx$/i.test(path) || moves.has(path) || retired.has(path)) fail('P22_RELOCATION_ASSET_INVALID', { path });
    boundAsset(path, row);
    retired.set(path, { path, sha256: row.sha256, byte_length: row.byte_length });
  }
  return { moves, retired };
}

function navigationPaths(value, mapping, retired) {
  if (Array.isArray(value)) return value.map(row => navigationPaths(row, mapping, retired));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, row]) => [key, navigationPaths(row, mapping, retired)]));
  if (retired.has(value)) fail('P22_RELOCATION_ASSET_STILL_REFERENCED', { path: value });
  return mapping.get(value) ?? value;
}

function assetHistory(manifest, moves, retired, restore, rewrites) {
  const history = new Map();
  for (const row of manifest.path_migration?.assets ?? []) {
    if (retired.has(row.new_path)) continue;
    const target = moves.get(row.new_path)?.new_path ?? row.new_path;
    if (target !== row.old_path) history.set(row.old_path, { ...row, new_path: target, ...rewrites.get(row.new_path) });
  }
  for (const [path, row] of moves) {
    if (!manifest.targets.assets.includes(path)) continue;
    const { targetExists, source_id: declaredId, ...fields } = row;
    const source = manifest.citation?.sources.find(source => source.path === path);
    if (source && (source.sha256 !== row.sha256 || source.byte_length !== row.byte_length)) fail('P22_RELOCATION_ASSET_INVALID', { path });
    const prior = manifest.path_migration?.assets?.filter(previous => previous.new_path === path) ?? [];
    const boundId = source?.source_id ?? prior.find(previous => previous.source_id)?.source_id;
    if (boundId && declaredId !== undefined && boundId !== declaredId) {
      fail('P22_RELOCATION_SOURCE_ID_CONFLICT', { path, run_id: manifest.identity.run_id, expected: boundId, supplied: declaredId });
    }
    const sourceId = boundId ?? declaredId;
    const resourceId = prior.find(previous => previous.resource_id)?.resource_id ?? path;
    history.set(path, { ...fields, ...rewrites.get(path), ...(sourceId ? { source_id: sourceId } : { resource_id: resourceId }) });
  }
  const retirementHistory = (manifest.path_migration?.retired_assets ?? []).filter(row => !restore.has(row.path));
  for (const [path, row] of retired) {
    const index = manifest.targets.assets.indexOf(path);
    if (index !== -1) retirementHistory.push({ ...row, asset_index: index });
  }
  return { ...(history.size ? { assets: [...history.values()] } : {}), ...(retirementHistory.length ? { retired_assets: retirementHistory } : {}) };
}

/** Prepare a deterministic path-only revision of an already committed reading.
 * No caller-supplied prose or scientific approval is accepted. The existing
 * transaction supplies exact authorization, history snapshots and crash recovery.
 * Superseded visible files remain until a separately inventoried retirement move.
 */
export async function buildNoteRelocationReview({ vaultRoot, runId, generation, papers = [], assetMappings = [], assetRetirements = [], restoreAssetRetirements = [] } = {}) {
  const root = resolve(vaultRoot ?? '');
  if (!vaultRoot || realpathSync(root) !== root || !lstatSync(root).isDirectory()
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(runId ?? '')) fail('P22_RELOCATION_SCOPE_INVALID');
  if (![assetMappings, assetRetirements, restoreAssetRetirements].every(Array.isArray)) fail('P22_RELOCATION_ASSET_INVALID');
  const hasAssetChanges = Boolean(assetMappings.length || assetRetirements.length || restoreAssetRetirements.length);
  const base = await readRegisteredCommit({ vaultRoot: root });
  if (!base.ok) fail('P22_RELOCATION_COMMITTED_REQUIRED', { errors: base.errors });
  if (!Array.isArray(papers) || !papers.length && !hasAssetChanges || new Set(papers.map(row => row.paperId)).size !== papers.length) fail('P22_RELOCATION_PAPERS_REQUIRED');
  const generationPaths = phase22GenerationPaths(generation);
  if (generation === base.generation_id) fail('P22_GENERATION_NOT_NEW');
  const mapping = new Map(), relocations = [];
  const missingSources = new Set();
  const clippingMoves = new Map(assetMappings.filter(row => typeof row?.old_path === 'string' && row.old_path.startsWith('Clippings/')
    && typeof row.new_path === 'string' && row.new_path.startsWith('Clippings/'))
    .map(row => [row.old_path, row.new_path]));
  const currentMaps = registeredResearchMapPaths(base.generation, path => bytesAt(root, path));
  const baseFiles = new Map(base.generation.objects.map(row => {
    const replacement = row.kind === 'asset' && clippingMoves.get(row.path);
    let bytes = bytesAt(root, row.path, Boolean(replacement) || currentMaps.has(row.path));
    if (currentMaps.has(row.path)) parseRegisteredResearchMap(bytes, row.path);
    if (bytes === null) {
      bytes = bytesAt(root, replacement, true);
      if (bytes === null) fail('P22_RELOCATION_CLIPPINGS_ORIGINAL_REQUIRED', { path: replacement });
      missingSources.add(row.path);
    }
    if (!row.path.startsWith('Wiki/') && !currentMaps.has(row.path) && sha(bytes) !== row.sha256) fail('P22_RELOCATION_COMMITTED_REQUIRED', { path: row.path });
    return [row.path, bytes];
  }));
  assertRegisteredCommit(base);
  const files = new Map(baseFiles);
  const active = structuredClone(base.generation);
  delete active.index_manifest;
  active.generation_id = generation;
  const manifests = active.objects.filter(row => row.kind === 'reader-presentation').map(object => {
    const paper = active.papers.find(row => row.reader_presentation?.path === object.path), bytes = files.get(object.path);
    const manifest = paper ? verifyReadingFirstPresentation(base.generation.papers.find(row => row.paper_id === paper.paper_id), bytes, base.generation)
      : assertReadingFirstPublicationManifest(JSON.parse(bytes));
    return { object, manifest, paper };
  });
  const { moves, retired } = assetChanges(root, active.objects, files, assetMappings, assetRetirements, manifests, currentMaps);
  const restore = new Map();
  for (const path of restoreAssetRetirements) {
    const records = manifests.flatMap(({ manifest }) => manifest.path_migration?.retired_assets?.filter(row => row.path === path) ?? []);
    const bytes = records.length ? bytesAt(root, path, true) : null;
    if (!bytes || files.has(path) || restore.has(path) || [...moves.values()].some(row => row.new_path === path)
      || records.some(row => row.sha256 !== sha(bytes) || row.byte_length !== bytes.length)) fail('P22_RELOCATION_ASSET_INVALID', { path });
    restore.set(path, { path, sha256: records[0].sha256, byte_length: bytes.length });
    files.set(path, bytes);
  }
  for (const [path, row] of moves) mapping.set(path, row.new_path);
  const retirementProbe = new Map([...retired].map(([path]) => [path, 'Clippings/__retirement_probe__.docx']));
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
  if (!mapping.size && !retired.size && !restore.size) fail('P22_RELOCATION_NO_CHANGES');
  const output = [], previews = [];
  const add = (path, kind, bytes, extra = {}) => {
    const previous = baseFiles.get(path) ?? null, owned = Buffer.from(bytes);
    if (previous === null && bytesAt(root, path, true) !== null) fail('P22_RELOCATION_TARGET_OCCUPIED', { path });
    const row = { path, kind, bytes: owned, byte_sha256: sha(owned), byte_length: owned.length,
      before_sha256: previous === null ? null : sha(previous), before_byte_length: previous?.length ?? null, ...extra };
    output.push(row); files.set(path, owned); return row;
  };
  for (const object of active.objects) {
    const from = object.path, to = mapping.get(from) ?? from;
    if (!from.endsWith('.md')) continue;
    const original = files.get(from), text = original.toString('utf8');
    if (retired.size && relocateNoteLinks(text, from, from, retirementProbe) !== text) fail('P22_RELOCATION_ASSET_STILL_REFERENCED', { path: from });
    const bytes = Buffer.from(relocateNoteLinks(text, from, to, mapping));
    if (from === to && bytes.equals(original)) continue;
    if (object.kind === 'v3-note' || object.kind === 'topic') {
      let previous, inspected;
      try {
        previous = inspectManagedNote(original);
        inspected = inspectManagedNote(bytes);
      } catch (error) {
        error.details = { ...error.details, path: from };
        throw error;
      }
      if (previous.humanRanges.length !== inspected.humanRanges.length
        || previous.humanRanges.some((row, index) => !row.bytes.equals(inspected.humanRanges[index].bytes))) {
        fail('P22_RELOCATION_PERSONAL_LINK', { path: from });
      }
      const topic = active.topics?.find(row => row.path === from);
      const kind = object.kind === 'topic' ? 'topic' : 'paper';
      if (inspected.frontmatter.rendering_profile !== (kind === 'topic' ? topic?.schema_version : 'reading-first-obsidian-1.0')) {
        fail('P22_RELOCATION_PROFILE_UNSUPPORTED', { path: from });
      }
      add(to, kind, bytes, { language: inspected.frontmatter.language, managed_hash: inspected.managedHash,
        before_managed_hash: from === to ? previous.managedHash : null });
      object.sha256 = inspected.managedHash;
      if (topic) topic.managed_hash = inspected.managedHash;
      else previews.push({ path: to, language: inspected.frontmatter.language, byte_sha256: sha(bytes), managed_hash: inspected.managedHash });
    } else if (object.kind === 'support') {
      add(to, 'support', bytes); object.sha256 = sha(bytes);
    } else fail('P22_RELOCATION_PROFILE_UNSUPPORTED', { path: from });
    object.path = to;
    if (from !== to) files.delete(from);
  }
  const rewrites = new Map(), registeredPaths = [...baseFiles.keys()];
  for (const object of active.objects.filter(row => row.kind === 'asset')) {
    const from = object.path, move = moves.get(from), to = move?.new_path ?? from;
    const original = files.get(from);
    const bytes = mapping.size && /\.canvas$/i.test(from) ? relocateCanvasLinks(original, from, to, mapping, registeredPaths) : original;
    const changed = !bytes.equals(original);
    if (currentMaps.has(from)) object.sha256 = sha(bytes);
    if (!move && !changed) continue;
    if (move?.targetExists && !changed) files.set(to, bytes);
    else add(to, 'asset', bytes);
    if (move) files.delete(from);
    object.path = to;
    if (changed) {
      object.sha256 = sha(bytes);
      rewrites.set(from, { sha256: object.sha256, byte_length: bytes.length });
    }
  }
  active.objects = active.objects.filter(row => !retired.has(row.path));
  for (const path of retired.keys()) files.delete(path);
  for (const row of restore.values()) active.objects.push({ path: row.path, kind: 'asset', sha256: row.sha256 });
  const transformedPapers = [], writtenNotes = new Set(previews.map(row => row.path));
  const assetsSeen = new Set();
  for (const { object, manifest, paper } of manifests) {
    const oldManifest = object.path;
    const affectedAssets = manifest.targets.assets.filter(path => moves.has(path) || retired.has(path) || rewrites.has(path));
    for (const path of affectedAssets) assetsSeen.add(path);
    const restoredRows = (manifest.path_migration?.retired_assets ?? []).filter(row => restore.has(row.path));
    const navigation = navigationPaths(manifest.navigation, mapping, retired);
    const changed = affectedAssets.length || restoredRows.length || hash(navigation ?? null) !== hash(manifest.navigation ?? null)
      || languages.some(language => paper && writtenNotes.has(paper.paths[language]));
    if (changed) {
      const identifier = paper?.paper_id ?? manifest.identity.paper_id + '-' + object.sha256.slice(7, 19);
      const path = '.apa-v3/reading-first/presentation/' + identifier + '-' + generation + '.json';
      if (bytesAt(root, path, true) !== null) fail('P22_RELOCATION_TARGET_OCCUPIED', { path });
      manifest.targets.presentation = path;
      for (const language of languages) {
        const notePath = paper?.paths[language] ?? mapping.get(manifest.targets.notes[language].path) ?? manifest.targets.notes[language].path;
        const note = files.get(notePath);
        if (!paper && notePath === manifest.targets.notes[language].path) continue;
        const managedHash = inspectManagedNote(note).managedHash;
        manifest.targets.notes[language] = { path: notePath, managed_hash: managedHash, byte_sha256: sha(note) };
        if (paper) active.objects.find(row => row.path === notePath).sha256 = managedHash;
      }
      manifest.path_migration = { previous_generation: base.generation_id, previous_presentation_sha256: object.sha256,
        path_mapping_fingerprint: hash(hasAssetChanges ? { mapping: [...mapping], retired: [...retired.values()], restored: [...restore.values()] } : [...mapping]),
        ...assetHistory(manifest, moves, retired, restore, rewrites) };
      manifest.targets.assets = manifest.targets.assets.filter(path => !retired.has(path)).map(path => mapping.get(path) ?? path);
      if (manifest.presentation_assets) manifest.presentation_assets = manifest.presentation_assets
        .map(row => ({ ...row, path: mapping.get(row.path) ?? row.path, ...rewrites.get(row.path) }));
      for (const row of restoredRows.sort((left, right) => left.asset_index - right.asset_index)) manifest.targets.assets.splice(row.asset_index, 0, row.path);
      if (manifest.navigation) manifest.navigation = navigation;
      for (const source of manifest.citation?.sources ?? []) {
        if (retired.has(source.path)) fail('P22_RELOCATION_ASSET_STILL_REFERENCED', { path: source.path });
        source.path = mapping.get(source.path) ?? source.path;
      }
      const bytes = jsonBytes(manifest);
      assertReadingFirstPublicationManifest(manifest);
      add(path, 'reader-presentation', bytes);
      object.path = path;
      object.sha256 = sha(bytes);
      if (paper) paper.reader_presentation = { path, sha256: sha(bytes) };
      files.delete(oldManifest);
    }
    if (paper && changed) transformedPapers.push({ readingFirst: manifest,
      notes: Object.fromEntries(languages.map(language => [language, files.get(paper.paths[language])])) });
  }
  if ([...moves.keys(), ...retired.keys()].some(path => !assetsSeen.has(path))) fail('P22_RELOCATION_ASSET_UNBOUND');
  for (const path of new Set(transformedPapers.flatMap(row => row.readingFirst.targets.support.map(node => node.path)))) {
    active.objects.find(row => row.path === path).sha256 = sha(files.get(path));
  }
  active.objects.sort((a, b) => a.path.localeCompare(b.path));
  assertActiveGeneration(active);
  const built = await buildBilingualIndex({ generation: active, validatedInputs: { papers: transformedPapers,
    files: [...files].map(([path, bytes]) => ({ path, bytes })), previousPrepared: base, carryHistoricalDocuments: true } });
  add(generationPaths.active, 'active', jsonBytes(built.generation));
  add(generationPaths.index, 'index', built.bytes);
  const written = new Set(output.map(row => row.path));
  const dependencies = new Map(baseFiles);
  for (const path of missingSources) dependencies.delete(path);
  for (const row of moves.values()) if (row.targetExists) dependencies.set(row.new_path, files.get(row.new_path));
  for (const row of restore.values()) dependencies.set(row.path, files.get(row.path));
  const readDependencies = [...dependencies].filter(([path]) => !written.has(path))
    .map(([path, bytes]) => ({ path, byte_sha256: sha(bytes), byte_length: bytes.length }));
  const assetRelocations = [...moves.values()].map(({ targetExists, ...row }) => row);
  const assetRetirementChanges = { retired_assets: [...retired.values()], restored_assets: [...restore.values()] };
  const toolBindings = toolHashes();
  const scientificReviewHash = hash({ kind: 'preserved-committed-reading', previous_generation: base.generation_id,
    papers: base.generation.papers.map(({ paper_id, core_hash, dependencies }) => ({ paper_id, core_hash, dependencies })) });
  const reviewManifest = { schema_version: 'phase22/review-manifest-1.0', profile: NOTE_RELOCATION_PROFILE,
    identity: { paper_id: 'library-path-maintenance', run_id: runId,
      analysis_revision: 'paths_' + hash(hasAssetChanges ? { relocations, assetRelocations, ...assetRetirementChanges } : relocations).slice(7, 39) },
    status: base.evidence_mode === 'actual' ? 'review_ready' : 'synthetic_prepared', evidence_mode: base.evidence_mode,
    review_ready: base.evidence_mode === 'actual', publishable: false, reading_accepted: true,
    native_presentation: { status: 'not_run' }, scientific_review_hash: scientificReviewHash,
    generation, previous_generation: base.generation_id, previews, support_notes: active.shared_nodes,
    assets: [], read_dependencies: readDependencies, dependencies: { previous_generation: base.generation_id }, tools: toolBindings,
    index: { path: generationPaths.index, byte_sha256: built.sha256 },
    active: { path: generationPaths.active, byte_sha256: sha(jsonBytes(built.generation)) },
    write_set: output.map(({ bytes, ...row }) => row), relocations,
    ...(hasAssetChanges ? { asset_relocations: assetRelocations, ...assetRetirementChanges } : {}),
    diagnostics: [], provenance_limits: { scientific_review_scope: 'existing committed acceptance retained; deterministic paths and link targets only', native_presentation: 'not_run' } };
  (await createPhase22ContractValidator()).assert('phase22/review-manifest-1.0', reviewManifest);
  add('.apa-v3/phase22/generations/' + generation + '/manifest.json', 'manifest', jsonBytes(reviewManifest));
  output.sort((a, b) => a.path.localeCompare(b.path));
  const hashes = { scientific_review_hash: scientificReviewHash,
    review_bundle_hash: hash({ reviewManifest, outputs: inventoryStamp(output), read_dependencies: readDependencies }),
    output_inventory_hash: hash({ generation, previous_generation: base.generation_id, output: inventoryStamp(output), read_dependencies: readDependencies }) };
  const result = freeze({ ok: true, status: reviewManifest.status, reviewManifest, outputInventory: output, hashes, diagnostics: [] });
  records.set(result, { stamp: stamp(result), tools: toolBindings, currentContent: true });
  return result;
}

export function usesCurrentNoteRelocation(review) {
  return records.get(review)?.currentContent === true;
}

export function assertNoteRelocationReviewCurrent(review) {
  const record = records.get(review);
  if (!record) fail('P22_REVIEW_NOT_OWNED');
  if (stamp(review) !== record.stamp) fail('P22_REVIEW_OUTPUT_INVALIDATED');
  if (hash(record.tools) !== hash(toolHashes())) fail('P22_REVIEW_TOOL_INVALIDATED');
  return review;
}
