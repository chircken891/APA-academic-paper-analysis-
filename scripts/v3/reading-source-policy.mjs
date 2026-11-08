import { createHash, randomUUID } from 'node:crypto';
import { linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertRegisteredCommit, PHASE22_COMMIT_PATH, readRegisteredCommit } from './phase22-active-version.mjs';

export const CLIPPINGS_SOURCE_POLICY = 'clippings-originals-1.0';

const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const fail = (code, details) => { throw Object.assign(new Error(code), { code, details }); };
const document = path => /\.(?:pdf|docx)$/i.test(path);
const forwardSlashes = path => path.split(sep).join('/');

function statIfPresent(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; return null; }
}

function physicalDirectory(path, create = false) {
  if (create) {
    try { mkdirSync(path); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const stat = statIfPresent(path);
  if (!stat) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) {
    fail('RF_CLIPPINGS_SOURCE_PATH_INVALID', { path });
  }
  return true;
}

function libraryPath(root, path, folder) {
  if (typeof path !== 'string') return null;
  const name = isAbsolute(path) ? forwardSlashes(relative(root, path)) : path.replaceAll('\\', '/');
  if (!name.startsWith(folder + '/') || !document(name) || /[<>:"|?*\x00-\x1f]/.test(name)
    || name.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return null;
  return name;
}

function fileStat(path) {
  const stat = statIfPresent(path);
  return stat?.isFile() && !stat.isSymbolicLink() && realpathSync(path) === path ? stat : null;
}

function documentInventory(root, folder) {
  const start = join(root, folder);
  if (!physicalDirectory(start)) return [];
  const files = [];
  function readDirectory(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolutePath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (physicalDirectory(absolutePath)) readDirectory(absolutePath);
      } else if (entry.isFile() && document(entry.name)) {
        const path = libraryPath(root, absolutePath, folder);
        const stat = path && fileStat(absolutePath);
        if (stat) files.push({ path, absolutePath, byte_length: stat.size });
      }
    }
  }
  readDirectory(start);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function fileHash(file) {
  if (file.sha256 === undefined) file.sha256 = sha(readFileSync(file.absolutePath));
  return file.sha256;
}

function matchHashes(files, sha256, byteLength) {
  return files.filter(file => (byteLength === undefined || file.byte_length === byteLength) && fileHash(file) === sha256);
}

/** Locate verified Clippings originals by byte identity, including when a Raw target is only planned. */
export function findClippingsByHash({ vaultRoot, sha256, byte_length } = {}) {
  const root = realpathSync(vaultRoot);
  return matchHashes(documentInventory(root, 'Clippings'), sha256, byte_length).map(file => file.path);
}

/** Validate paths already registered as Clippings assets and describe any recoverable moves. */
export function inspectClippingsSourceDrift({ vaultRoot, objects = [] } = {}) {
  const root = realpathSync(vaultRoot);
  const drift = [];
  let candidates;
  for (const object of objects) {
    if (object.kind !== 'asset' || !object.path.startsWith('Clippings/')) continue;
    const path = libraryPath(root, object.path, 'Clippings');
    if (path === null) fail('RF_CLIPPINGS_SOURCE_PATH_INVALID', { path: object.path });
    const absolutePath = join(root, path), stat = fileStat(absolutePath);
    if (stat && (object.byte_length === undefined || stat.size === object.byte_length)
      && sha(readFileSync(absolutePath)) === object.sha256) continue;
    candidates ??= documentInventory(root, 'Clippings');
    drift.push({
      path, registered_sha256: object.sha256,
      status: statIfPresent(absolutePath) ? 'changed' : 'missing',
      same_byte_candidates: matchHashes(candidates, object.sha256, object.byte_length).map(file => file.path),
      migration_entry: 'scripts/v3/note-relocation.mjs#buildNoteRelocationReview',
    });
  }
  return drift;
}

const normalizedText = value => typeof value === 'string'
  ? value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') : '';
function sourceDoi(source) {
  return (String(source?.doi ?? '').match(/10\.\d{4,9}\/\S+/i)?.[0] ?? '').toLowerCase();
}
function sourceTitles(source) {
  const value = source?.title;
  return (value && typeof value === 'object' ? Object.values(value) : [value]).map(normalizedText).filter(Boolean);
}

/** Read the bibliographies bound to the currently registered main source assets. */
export async function readRegisteredSourceMatchMetadata({ vaultRoot, registered } = {}) {
  const root = realpathSync(vaultRoot);
  const sources = [], rawSources = [];
  if (!registered && !statIfPresent(join(root, PHASE22_COMMIT_PATH))) return { sources, rawSources };
  const snapshot = registered ?? await readRegisteredCommit({ vaultRoot: root });
  if (!snapshot.ok) fail('RF_SOURCE_MATCH_REGISTRATION_INVALID', { errors: snapshot.errors });
  if (assertRegisteredCommit(snapshot).root !== root) fail('RF_SOURCE_MATCH_REGISTRATION_INVALID', { vaultRoot });
  const objects = new Map(snapshot.generation.objects.map(object => [object.path, object]));
  for (const paper of snapshot.generation.papers) {
    const manifest = paper.reader_presentation;
    if (!manifest) continue;
    const path = join(root, manifest.path);
    if (!fileStat(path)) fail('RF_SOURCE_MATCH_PRESENTATION_INVALID', { path: manifest.path });
    const bytes = readFileSync(path);
    if (sha(bytes) !== manifest.sha256) fail('RF_SOURCE_MATCH_PRESENTATION_INVALID', { path: manifest.path });
    const { citation } = JSON.parse(bytes.toString('utf8'));
    const original = citation?.sources?.[0];
    const asset = original && objects.get(original.path);
    if (!asset || asset.kind !== 'asset' || asset.sha256 !== original.sha256) continue;
    const { path: sourcePath, sha256, byte_length } = original;
    const { doi, title } = citation.bibliography ?? {};
    const row = { path: sourcePath, sha256, byte_length, doi, title };
    if (libraryPath(root, sourcePath, 'Raw')) rawSources.push(row);
    if (libraryPath(root, sourcePath, 'Clippings')) sources.push(row);
  }
  assertRegisteredCommit(snapshot);
  return { sources, rawSources };
}

function addSourceMetadata(root, folder, files, sources, planned = false) {
  const byPath = new Map(files.map(file => [file.path, file]));
  for (const source of sources) {
    const path = libraryPath(root, source.path, folder);
    if (!path) continue;
    const existing = byPath.get(path);
    if (existing) {
      if (source.sha256 !== undefined && (source.byte_length !== undefined && existing.byte_length !== source.byte_length
        || fileHash(existing) !== source.sha256)) continue;
      const doi = sourceDoi(source), titles = sourceTitles(source);
      if (doi) existing.doi = doi;
      if (titles.length) existing.titles = titles;
    } else if (planned && /^sha256:[a-f0-9]{64}$/.test(source.sha256) && Number.isSafeInteger(source.byte_length)) {
      byPath.set(path, { path, sha256: source.sha256, byte_length: source.byte_length, doi: sourceDoi(source), titles: sourceTitles(source) });
    }
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

/** Search local originals by bytes first. Bibliographic similarities stay separate for confirmation. */
export function findRawSourceMatches({ vaultRoot, sources = [], rawSources = [] } = {}) {
  const root = realpathSync(vaultRoot);
  const raw = addSourceMetadata(root, 'Raw', documentInventory(root, 'Raw'), rawSources, true);
  const exact_matches = [], possible_matches = [];
  if (!raw.length) return { exact_matches, possible_matches };
  const clippings = addSourceMetadata(root, 'Clippings', documentInventory(root, 'Clippings'), sources);
  for (const file of raw) {
    const sameSize = clippings.filter(candidate => candidate.byte_length === file.byte_length);
    const exact = sameSize.length ? matchHashes(sameSize, fileHash(file), file.byte_length) : [];
    if (exact.length) {
      for (const match of exact) exact_matches.push({
        raw_path: file.path, clippings_path: match.path, sha256: file.sha256, byte_length: file.byte_length, basis: 'sha256',
      });
      continue;
    }
    const filename = normalizedText(basename(file.path, extname(file.path)));
    for (const match of clippings) {
      const otherFilename = normalizedText(basename(match.path, extname(match.path)));
      const basis = file.doi && file.doi === match.doi ? 'doi'
        : file.titles?.some(title => match.titles?.includes(title) || title === otherFilename)
          || match.titles?.includes(filename) ? 'title'
          : filename && filename === otherFilename ? 'filename' : null;
      if (basis) possible_matches.push({ raw_path: file.path, clippings_path: match.path, basis });
    }
  }
  return { exact_matches, possible_matches };
}

function sourceNameConflict(source, targetPath, targetHash) {
  const code = 'RF_CLIPPINGS_SOURCE_NAME_CONFLICT';
  throw Object.assign(new Error(code + ': ' + source.path + ' (' + source.sha256 + ') -> ' + targetPath + ' (' + targetHash + ')'), {
    code, details: { source_path: source.path, source_sha256: source.sha256, target_path: targetPath, target_sha256: targetHash },
  });
}

function assertIdenticalTarget(target, source) {
  const stat = statIfPresent(target);
  if (!stat) return false;
  if (!stat.isFile() || stat.isSymbolicLink()) fail('RF_CLIPPINGS_SOURCE_PATH_INVALID', { path: target });
  const targetHash = sha(readFileSync(target));
  if (targetHash !== source.sha256 || stat.size !== source.byte_length) {
    sourceNameConflict(source, target, targetHash);
  }
  return true;
}

function copyOriginal(root, target, source, bytes) {
  if (assertIdenticalTarget(target, source)) return;
  physicalDirectory(join(root, 'Clippings'), true);
  physicalDirectory(join(root, '.tmp'), true);
  const staging = join(root, '.tmp', 'reading-source-prepare');
  physicalDirectory(staging, true);
  const temporary = join(staging, randomUUID());
  writeFileSync(temporary, bytes, { flag: 'wx' });
  try {
    try { linkSync(temporary, target); }
    catch (error) {
      if (error.code !== 'EEXIST' || !assertIdenticalTarget(target, source)) throw error;
    }
  } finally {
    unlinkSync(temporary);
  }
}

function rewriteSourcePaths(presentation, locations) {
  const byId = new Map(locations.map(source => [source.source_id, source.vault_path]));
  const main = locations[0].vault_path;
  const targets = new Map();
  if (presentation.source_pdf !== undefined) {
    targets.set(presentation.source_pdf, main);
    presentation.source_pdf = main;
  }
  for (const source of presentation.sources ?? []) {
    if (!byId.has(source.id)) continue;
    targets.set(source.path, byId.get(source.id));
    source.path = byId.get(source.id);
  }
  for (const visual of presentation.visuals ?? []) {
    if (visual.source_path !== undefined) {
      visual.source_path = byId.get(visual.source_id) ?? targets.get(visual.source_path) ?? visual.source_path;
    }
  }
}

/** Copy only external originals and bind the new reading to their actual Clippings paths. */
export function prepareReadingSources({ repoRoot, scientificInput, sourceMatchMetadata = {} } = {}) {
  const root = realpathSync(repoRoot);
  const sources = scientificInput?.sources;
  if (!Array.isArray(sources) || !sources.length || new Set(sources.map(source => source?.id)).size !== sources.length) {
    fail('RF_CLIPPINGS_SOURCES_REQUIRED');
  }
  physicalDirectory(join(root, 'Clippings'));
  const copies = new Map();
  const source_locations = sources.map(source => {
    if (typeof source?.id !== 'string' || !source.id || typeof source.path !== 'string' || !isAbsolute(source.path) || !document(source.path)) {
      fail('RF_CLIPPINGS_SOURCE_PATH_INVALID', { path: source?.path });
    }
    const original_path = resolve(source.path), path = realpathSync(original_path);
    if (!fileStat(path)) fail('RF_CLIPPINGS_SOURCE_PATH_INVALID', { path });
    const bytes = readFileSync(path);
    if (sha(bytes) !== source.sha256 || bytes.length !== source.byte_length) fail('READING_FIRST_SOURCE_CHANGED', { path: original_path });
    const target = libraryPath(root, path, 'Clippings') === null ? join(root, 'Clippings', basename(original_path)) : path;
    const vault_path = libraryPath(root, target, 'Clippings');
    if (vault_path === null) fail('RF_CLIPPINGS_SOURCE_PATH_INVALID', { path: target });
    let destination = target;
    if (target !== path && !assertIdenticalTarget(target, source)) {
      const key = process.platform === 'win32' ? target.toLowerCase() : target;
      const planned = copies.get(key);
      if (planned && planned.source.sha256 !== source.sha256) sourceNameConflict(source, target, planned.source.sha256);
      destination = planned?.target ?? target;
      copies.set(key, { target: destination, source, bytes });
    }
    return { source_id: source.id, original_path, path: destination, vault_path, sha256: source.sha256, byte_length: source.byte_length };
  });
  const input = structuredClone(scientificInput);
  for (const { target, source, bytes } of copies.values()) copyOriginal(root, target, source, bytes);
  input.sources.forEach((source, index) => {
    const location = source_locations[index];
    location.path = realpathSync(location.path);
    location.vault_path = libraryPath(root, location.path, 'Clippings');
    source.path = location.path;
  });
  if (input.presentation) rewriteSourcePaths(input.presentation, source_locations);
  const bibliographicSources = input.sources.map((source, index) => index === 0 ? { ...input.presentation?.bibliography, ...source } : source);
  const raw_source_matches = findRawSourceMatches({
    vaultRoot: root, sources: [...(sourceMatchMetadata.sources ?? []), ...bibliographicSources], rawSources: sourceMatchMetadata.rawSources,
  });
  return { scientificInput: input, source_locations, raw_source_matches };
}
