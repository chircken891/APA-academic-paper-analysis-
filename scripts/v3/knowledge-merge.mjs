import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import YAML from 'yaml';
import MarkdownIt from 'markdown-it';
import { fingerprintV3Json as hash } from './semantic-package-validator.mjs';
import { freezePhase22Value } from './phase22-freeze.mjs';
import { assertActiveGeneration, assertActiveIndexContract, assertRegisteredCommit, INDEX_READING_FIRST_PROFILE,
  KNOWLEDGE_ALIASES_PATH, normalizeIndexPath, parseRegisteredKnowledgeAliases, phase22GenerationPaths,
  PHASE22_COMMIT_PATH, readRegisteredCommit, verifyReadingFirstPresentation } from './phase22-active-version.mjs';
import { readKnowledgeMergePreimages } from './phase22-publication.mjs';
import { assertReadingFirstPublicationManifest, registeredResearchMapPaths } from './reading-first-index.mjs';
import { bindPublishedKnowledgeReferences, registeredKnowledgeReference } from './reading-first-knowledge.mjs';
import { inspectManagedNote } from './phase22-managed-markdown.mjs';
import { buildBilingualIndex } from './phase22-search.mjs';
import { createPhase22ContractValidator } from './phase22-contract-loader.mjs';

export const KNOWLEDGE_MERGE_PROFILE = 'phase22-knowledge-merge-1.0';
const aliasKind = 'knowledge-aliases';
const aliasVersion = 'apa-knowledge-aliases-1.0';
const records = new WeakMap();
const languages = ['en', 'zh-CN'];
const start = '<!-- AUTO:START shared-knowledge -->';
const end = '<!-- AUTO:END shared-knowledge -->';
const statePattern = /<!-- KNOWLEDGE_STATE ([A-Za-z0-9+/=]+) -->/;
const markdown = new MarkdownIt();
const { parseLinkDestination, parseLinkTitle } = markdown.helpers;
const fail = (code, details = {}) => { throw Object.assign(new Error(code), { code, details }); };
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value) + '\n');
const decode = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
const pathKey = path => path.normalize('NFC').toLowerCase();
const encodePath = value => value.split('/').map(part => encodeURIComponent(part).replaceAll('(', '%28').replaceAll(')', '%29')).join('/');

function read(root, path, optional = false) {
  if (normalizeIndexPath(path) !== path) fail('P22_KNOWLEDGE_MERGE_PATH_INVALID', { path });
  const absolute = join(root, path);
  let stat;
  try { stat = lstatSync(absolute); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpathSync(absolute) !== absolute) fail('P22_KNOWLEDGE_MERGE_PATH_INVALID', { path });
  return readFileSync(absolute);
}

function toolHashes() {
  return Object.fromEntries(['./knowledge-merge.mjs', './reading-first-knowledge.mjs', './phase22-active-version.mjs', './phase22-publication.mjs', './phase22-review.mjs',
    './phase22-search.mjs', './reading-first-index.mjs', './phase22-managed-markdown.mjs', '../../Schema/phase22/review-manifest.schema.json',
    '../../Schema/phase22/active-index.schema.json', '../../Schema/phase22/reading-first-publication.schema.json',
    '../../Schema/phase22/publication-transaction.schema.json'].map(path => [path, sha(readFileSync(new URL(path, import.meta.url)))]));
}

function inventoryStamp(rows) { return rows.map(({ bytes, ...row }) => ({ ...row, observed_sha256: sha(bytes) })); }
function stamp(review) { return hash({ manifest: review.reviewManifest, output: inventoryStamp(review.outputInventory), hashes: review.hashes }); }
function freezeReview(result) {
  for (const row of result.outputInventory) Object.freeze(row);
  Object.freeze(result.outputInventory);
  freezePhase22Value(result.reviewManifest);
  freezePhase22Value(result.hashes);
  Object.freeze(result.diagnostics);
  return Object.freeze(result);
}
const reference = (path, bytes) => ({ path, byte_sha256: sha(bytes), byte_length: bytes.length });
const compareRefs = (row, bytes) => bytes && row.byte_sha256 === sha(bytes) && row.byte_length === bytes.length;

async function context({ repoRoot, runId, generationId }) {
  const root = resolve(repoRoot ?? '');
  if (!repoRoot || realpathSync(root) !== root || !lstatSync(root).isDirectory()
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(runId ?? '')) fail('P22_KNOWLEDGE_MERGE_SCOPE_INVALID');
  phase22GenerationPaths(generationId);
  const base = await readRegisteredCommit({ vaultRoot: root });
  if (!base.ok) fail('P22_KNOWLEDGE_MERGE_COMMITTED_REQUIRED', { errors: base.errors });
  if (generationId === base.generation_id) fail('P22_GENERATION_NOT_NEW');
  const files = new Map(), observed = new Map();
  const currentMaps = registeredResearchMapPaths(base.generation, path => read(root, path));
  for (const { path, kind, sha256 } of base.generation.objects) {
    if (currentMaps.has(path)) continue;
    const bytes = read(root, path), row = reference(path, bytes);
    if (!path.startsWith('Wiki/') && row.byte_sha256 !== sha256) fail('P22_OBJECT_HASH_MISMATCH', { path });
    observed.set(path, row);
    if (kind !== 'asset') files.set(path, bytes);
  }
  assertRegisteredCommit(base);
  return { root, base, files, observed, runId, generationId };
}

function sharedPage(bytes, path) {
  const text = decode(bytes), front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const from = text.indexOf(start), to = text.indexOf(end), region = text.slice(from, to);
  if (!front || from < 0 || to <= from || text.indexOf(start, from + start.length) >= 0 || text.indexOf(end, to + end.length) >= 0
    || (region.match(new RegExp(statePattern.source, 'g')) ?? []).length !== 1) fail('P22_KNOWLEDGE_MERGE_NODE_INVALID', { path });
  let metadata, state;
  try {
    metadata = YAML.parse(front[1]);
    state = JSON.parse(Buffer.from(statePattern.exec(region)[1], 'base64'));
  } catch { fail('P22_KNOWLEDGE_MERGE_NODE_INVALID', { path }); }
  if (metadata?.pipeline_version !== '3.0' || metadata.knowledge_id !== state?.item?.id
    || metadata.canonical_key !== state.item.canonical_key || metadata.type !== state.item.kind
    || !Array.isArray(state.applications)) fail('P22_KNOWLEDGE_MERGE_NODE_INVALID', { path });
  return { text, from, to, region, state, metadata };
}

function aliasesOf(node, path) {
  return [posix.basename(path, '.md'), node.metadata.knowledge_id, node.metadata.canonical_key,
    node.state.item.title?.en, node.state.item.title?.['zh-CN'], ...(node.metadata.aliases ?? []), ...(node.state.item.aliases ?? [])]
    .filter(value => typeof value === 'string' && /\S/.test(value));
}

function uniqueRows(rows, key = hash) { return [...new Map(rows.map(row => [key(row), row])).values()]; }

function mergePage(keep, removed, addition, aliases, papers) {
  const { state, region, text, from, to } = keep, items = [state.item, ...removed.map(page => page.state.item)];
  const item = { ...state.item, aliases: [...new Set([...items.flatMap(row => row.aliases ?? []), ...aliases])],
    paragraphs: Object.fromEntries(languages.map(language => [language, [...new Set(items.flatMap(row => row.paragraphs?.[language] ?? []))]])),
    sections: Object.fromEntries(languages.map(language => [language, uniqueRows(items.flatMap(row => row.sections?.[language] ?? []))])),
    formulas: uniqueRows(items.flatMap(row => row.formulas ?? [])), sources: uniqueRows(items.flatMap(row => row.sources ?? [])),
    paper_additions: uniqueRows(items.flatMap(row => row.paper_additions ?? [])) };
  const applications = uniqueRows([state, ...removed.map(page => page.state)].flatMap(row => row.applications), row => row.paper_id)
    .map(application => ({ ...application, targets: papers.get(application.paper_id)?.paths ?? application.targets }));
  const replacement = '<!-- KNOWLEDGE_STATE ' + Buffer.from(JSON.stringify({ item, applications })).toString('base64') + ' -->';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return text.slice(0, from) + region.replace(statePattern, replacement) + eol
    + addition.trim().replace(/\r?\n/g, eol) + eol + eol + text.slice(to);
}

function fragments(text) {
  return new Set([...text.matchAll(/^#{1,6}[ \t]+([^\r\n]+)$|\^([A-Za-z0-9-]+)(?=[ \t]*\r?$)/gm)]
    .map(row => row[2] ? '^' + row[2] : row[1].trim().replace(/[ \t]+#+$/, '').replace(/[ \t]+\^[\w-]+$/, '')));
}

function copyManagedPage(page, path, occupied) {
  const body = page.region.slice(start.length).replace(statePattern, '').trim();
  const localAnchors = new Map();
  const seen = new Set();
  const codeLines = new Set();
  for (const token of markdown.parse(body, {})) {
    if (['fence', 'code_block'].includes(token.type)) for (let line = token.map[0]; line < token.map[1]; line++) codeLines.add(line);
  }
  const unique = (anchor, suffix) => {
    let target = anchor;
    for (let n = 1; occupied.has(target); n++) target = anchor + suffix + (n > 1 ? '-' + n : '');
    occupied.add(target);
    if (target !== anchor && !seen.has(anchor)) localAnchors.set(anchor, target);
    seen.add(anchor);
    return target;
  };
  const title = posix.basename(path, '.md');
  const renamed = body.split(/(?<=\n)/).map((line, index) => {
    if (codeLines.has(index)) return line;
    const block = /([ \t]+)(\^[A-Za-z0-9-]+)(?=[ \t]*\r?$)/m;
    const heading = /^(#{1,6}[ \t]+)(.+?)(?=[ \t]+(?:#+|\^[A-Za-z0-9-]+)[ \t]*\r?$|[ \t]*\r?$)/m;
    return line.replace(heading, (_, prefix, anchor) => prefix + unique(anchor, ' · ' + title))
      .replace(block, (_, space, anchor) => space + unique(anchor, '-' + hash(path).slice(7, 15)));
  }).join('');
  const contents = rewriteLinks(renamed, path, new Map(), [], new Map(), new Map(), localAnchors);
  return { contents: `**${title.replace(/[\[\]*_`]/g, ' ')}**\n\n` + contents, localAnchors };
}

function inlineLinkAt(line, pos) {
  const skipSpace = start => start + (/^[ \t]*/.exec(line.slice(start))[0].length);
  const from = skipSpace(pos), destination = parseLinkDestination(line, from, line.length);
  if (!destination.ok) return null;
  let close = skipSpace(destination.pos);
  if (close > destination.pos && line[close] !== ')') {
    const title = parseLinkTitle(line, close, line.length);
    if (!title.ok) return null;
    close = skipSpace(title.pos);
  }
  return line[close] === ')' ? { from, to: destination.pos, close, href: destination.str } : null;
}

function rewriteLinks(text, path, mapping, activePaths, anchorOverrides, anchors, localAnchors) {
  const lookup = new Map(activePaths.map(value => [pathKey(value), value]));
  const split = raw => {
    const offset = raw.search(/[?#]/);
    if (offset < 0) return [raw, ''];
    return [raw.slice(0, offset), raw.slice(offset)];
  };
  const pathFrom = (value, wiki) => {
    const pathValue = wiki && !value.endsWith('.md') ? value + '.md' : value;
    const relative = lookup.get(pathKey(posix.normalize(posix.join(posix.dirname(path), pathValue))));
    if (relative || !wiki) return relative;
    const exact = lookup.get(pathKey(pathValue));
    if (exact || pathValue.startsWith('../') || pathValue.startsWith('./')) return exact;
    const matches = activePaths.filter(candidate => pathKey(candidate).endsWith('/' + pathKey(pathValue)));
    if (matches.length > 1 && matches.some(candidate => mapping.has(candidate))) fail('P22_KNOWLEDGE_MERGE_AMBIGUOUS_LINK', { path, target: value });
    return matches.length === 1 ? matches[0] : undefined;
  };
  const target = (raw, wiki, destination = null) => {
    const angle = !wiki && raw.startsWith('<') && raw.endsWith('>');
    const value = destination ?? (angle ? raw.slice(1, -1) : raw);
    if (localAnchors && value.startsWith('#')) {
      let anchor;
      try { anchor = localAnchors.get(decodeURIComponent(value.slice(1))); } catch { return raw; }
      if (!anchor) return raw;
      const href = '#' + (wiki ? anchor : encodeURIComponent(anchor));
      return angle ? '<' + href + '>' : href;
    }
    if (!value || /^[?#/]|^[a-z][a-z0-9+.-]*:/i.test(value)) return raw;
    const [rawPath, suffix] = split(value);
    let decoded, anchor;
    try { decoded = decodeURIComponent(rawPath); anchor = suffix.includes('#') ? decodeURIComponent(suffix.slice(suffix.indexOf('#') + 1)) : null; }
    catch { return raw; }
    const old = pathFrom(decoded, wiki), replacement = mapping.get(old);
    if (!replacement) return raw;
    const wanted = anchorOverrides.get(old)?.get(anchor) ?? anchor;
    if (wanted && !anchors.get(replacement).has(wanted)) fail('P22_KNOWLEDGE_MERGE_ANCHOR_MISSING', { path, old, replacement, anchor: wanted });
    const fragment = wanted === anchor ? suffix : suffix.slice(0, suffix.indexOf('#') + 1) + (wiki ? wanted : encodeURIComponent(wanted));
    const newPath = wiki ? (decoded.endsWith('.md') ? replacement : replacement.slice(0, -3))
      : encodePath(posix.relative(posix.dirname(path), replacement));
    return angle ? '<' + newPath + fragment + '>' : newPath + fragment;
  };
  // Rewrites real note links without treating examples inside code as inlinks.
  let fence = null;
  return text.split(/(?<=\n)/).map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) { if (marker?.[0] === fence[0] && marker.length >= fence.length && /^ {0,3}(?:`+|~+)[ \t]*\r?\n?$/.test(line)) fence = null; return line; }
    if (marker) { fence = marker; return line; }
    if (/^(?: {4}|\t)/.test(line)) return line;
    line = line.replace(/^( {0,3}\[[^\]\r\n]+\]:[ \t]*)(<[^>\r\n]+>|[^\s]+)/, (_, prefix, href) => prefix + target(href, false));
    const markers = /(`+)[^\r\n]*?\1|\[\[([^\]|\r\n]+)(\|[^\]\r\n]*)?\]\]|\]\(/g;
    let output = '', cursor = 0;
    for (let match = markers.exec(line); match; match = markers.exec(line)) {
      const [raw, code, wiki, label] = match;
      if (code) continue;
      if (wiki) {
        output += line.slice(cursor, match.index) + '[[' + target(wiki, true) + (label ?? '') + ']]';
        cursor = match.index + raw.length;
        continue;
      }
      const link = inlineLinkAt(line, markers.lastIndex);
      if (!link) continue;
      output += line.slice(cursor, link.from) + target(line.slice(link.from, link.to), false, link.href);
      cursor = link.to;
      // Titles are literal text even when they contain text resembling a link.
      markers.lastIndex = link.close + 1;
    }
    return output + line.slice(cursor);
  }).join('');
}

function rewriteNavigation(value, mapping) {
  if (Array.isArray(value)) return value.map(row => rewriteNavigation(row, mapping));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, row]) => [key, rewriteNavigation(row, mapping)]));
  return mapping.get(value) ?? value;
}

async function prepare(ctx, { desired, writes, mapping = new Map(), maintenance, extraDependencies = [], changedSupports = new Set(), referenceDiagnostics = [] }) {
  const { root, base, runId, generationId } = ctx;
  const active = structuredClone(desired), output = [], previews = [], papers = [];
  delete active.index_manifest;
  active.generation_id = generationId;
  const files = new Map(ctx.files), observed = new Map(ctx.observed);
  for (const row of extraDependencies) observed.set(row.path, row);
  const add = (path, kind, bytes, extra = {}, allowExisting = true) => {
    const previous = observed.get(path);
    if (!allowExisting && (previous || read(root, path, true))) fail('P22_KNOWLEDGE_MERGE_TARGET_OCCUPIED', { path });
    const row = { ...reference(path, bytes), kind, bytes: Buffer.from(bytes), before_sha256: previous?.byte_sha256 ?? null,
      before_byte_length: previous?.byte_length ?? null, ...extra };
    files.set(path, row.bytes); output.push(row);
    return row;
  };
  const activeObjects = new Map(active.objects.map(row => [row.path, row]));
  const sharedNodes = new Map(active.shared_nodes.map(row => [row.path, row]));
  for (const [path, bytes] of writes) {
    const object = activeObjects.get(path) ?? (path === KNOWLEDGE_ALIASES_PATH ? { kind: aliasKind } : null);
    const previous = ctx.files.get(path);
    if (['v3-note', 'topic'].includes(object?.kind)) {
      const before = inspectManagedNote(previous), after = inspectManagedNote(bytes);
      const topic = active.topics?.find(row => row.path === path);
      if (after.frontmatter.rendering_profile !== (topic?.schema_version ?? INDEX_READING_FIRST_PROFILE)) fail('P22_KNOWLEDGE_MERGE_NOTE_PROFILE', { path });
      const outputKind = topic ? 'topic' : 'paper';
      const row = add(path, outputKind, bytes, { language: after.frontmatter.language, managed_hash: after.managedHash, before_managed_hash: before.managedHash });
      object.sha256 = after.managedHash;
      if (topic) topic.managed_hash = after.managedHash;
      else previews.push({ path, language: row.language, byte_sha256: row.byte_sha256, managed_hash: row.managed_hash });
    } else if (['support', aliasKind].includes(object?.kind)) {
      const row = add(path, object.kind, bytes);
      object.sha256 = row.byte_sha256;
    } else fail('P22_KNOWLEDGE_MERGE_NOTE_PROFILE', { path });
  }
  for (const paper of active.papers.filter(row => row.profile === INDEX_READING_FIRST_PROFILE)) {
    const source = desired.papers.find(row => row.paper_id === paper.paper_id);
    const oldPath = source.reader_presentation.path;
    const previousBytes = files.get(oldPath) ?? read(root, oldPath);
    if (!files.has(oldPath)) {
      files.set(oldPath, previousBytes);
      observed.set(oldPath, reference(oldPath, previousBytes));
    }
    const previous = verifyReadingFirstPresentation(source, previousBytes, maintenance.operation === 'merge' ? base.generation : desired);
    const presentation = structuredClone(previous);
    presentation.targets.support = uniqueRows(previous.targets.support.map(node => sharedNodes.get(mapping.get(node.path) ?? node.path)), row => row.path);
    if (presentation.navigation) presentation.navigation = rewriteNavigation(presentation.navigation, mapping);
    const notes = Object.fromEntries(languages.map(language => [language, files.get(paper.paths[language])]));
    const restoredBinding = paper.reader_presentation.path !== base.generation.papers.find(row => row.paper_id === paper.paper_id)?.reader_presentation?.path;
    const changedSupport = presentation.targets.support.some(node => changedSupports.has(node.path));
    const affected = maintenance.operation === 'compensate'
      ? restoredBinding || changedSupport
      : Object.values(paper.paths).some(path => writes.has(path)) || previous.targets.support.some(node => changedSupports.has(node.path) || mapping.has(node.path))
        || hash(presentation.navigation ?? null) !== hash(previous.navigation ?? null);
    if (!affected) continue;
    const targets = Object.fromEntries(languages.map(language => [language, { path: paper.paths[language],
      managed_hash: inspectManagedNote(notes[language]).managedHash, byte_sha256: sha(notes[language]) }]));
    if (maintenance.operation !== 'compensate' || !restoredBinding || languages.some(language => targets[language].managed_hash !== previous.targets.notes[language].managed_hash)) {
      const path = '.apa-v3/reading-first/presentation/' + paper.paper_id + '-' + generationId + '.json';
      presentation.targets.presentation = path;
      presentation.targets.notes = targets;
      assertReadingFirstPublicationManifest(presentation);
      const row = add(path, 'reader-presentation', json(presentation), {}, false);
      paper.reader_presentation = { path, sha256: row.byte_sha256 };
      activeObjects.delete(oldPath);
      activeObjects.set(path, { path, kind: 'reader-presentation', sha256: row.byte_sha256 });
    }
    for (const row of presentation.targets.support) activeObjects.get(row.path).sha256 = sha(files.get(row.path));
    for (const row of Object.values(targets)) activeObjects.get(row.path).sha256 = row.managed_hash;
    papers.push({ readingFirst: presentation, notes });
  }
  active.objects = [...activeObjects.values()].sort((a, b) => a.path.localeCompare(b.path));
  assertActiveGeneration(active);
  const alias = files.get(KNOWLEDGE_ALIASES_PATH);
  if (activeObjects.has(KNOWLEDGE_ALIASES_PATH)) parseRegisteredKnowledgeAliases(alias, active);
  const built = await buildBilingualIndex({ generation: active, validatedInputs: { papers,
    files: [...files].map(([path, bytes]) => ({ path, bytes })), previousPrepared: base, carryHistoricalDocuments: true } });
  const paths = phase22GenerationPaths(generationId);
  const activeRow = add(paths.active, 'active', json(built.generation), {}, false);
  add(paths.index, 'index', built.bytes, {}, false);
  const written = new Set(output.map(row => row.path));
  const readDependencies = [...observed.values()].filter(row => !written.has(row.path)).sort((a, b) => a.path.localeCompare(b.path));
  const tools = toolHashes(), actual = base.evidence_mode === 'actual';
  const scientificReviewHash = hash({ kind: 'preserved-committed-reading', papers: base.generation.papers.map(({ paper_id, core_hash, dependencies }) => ({ paper_id, core_hash, dependencies })) });
  const reviewManifest = { schema_version: 'phase22/review-manifest-1.0', profile: KNOWLEDGE_MERGE_PROFILE,
    identity: { paper_id: 'library-knowledge-maintenance', run_id: runId, analysis_revision: 'knowledge_' + hash(maintenance).slice(7, 39) },
    status: actual ? 'review_ready' : 'synthetic_prepared', evidence_mode: base.evidence_mode,
    review_ready: actual, publishable: false, reading_accepted: true, native_presentation: { status: 'not_run' },
    scientific_review_hash: scientificReviewHash, generation: generationId, previous_generation: base.generation_id,
    previews, support_notes: active.shared_nodes, assets: [], read_dependencies: readDependencies,
    dependencies: { previous_generation: base.generation_id }, tools, index: { path: paths.index, byte_sha256: built.sha256 },
    active: { path: paths.active, byte_sha256: activeRow.byte_sha256 }, write_set: output.map(({ bytes, ...row }) => row), maintenance,
    diagnostics: referenceDiagnostics, provenance_limits: { scientific_review_scope: 'existing scientific acceptance retained', native_presentation: 'not_run' } };
  (await createPhase22ContractValidator()).assert('phase22/review-manifest-1.0', reviewManifest);
  add(posix.join(posix.dirname(paths.active), 'manifest.json'), 'manifest', json(reviewManifest), {}, false);
  output.sort((a, b) => a.path.localeCompare(b.path));
  assertRegisteredCommit(base);
  const hashes = { scientific_review_hash: scientificReviewHash, review_bundle_hash: hash({ reviewManifest, outputs: inventoryStamp(output) }),
    output_inventory_hash: hash({ generation: generationId, output: inventoryStamp(output), read_dependencies: readDependencies }) };
  const result = freezeReview({ ok: true, status: reviewManifest.status, reviewManifest, outputInventory: output, hashes, diagnostics: referenceDiagnostics });
  records.set(result, { stamp: stamp(result), tools });
  return result;
}

/** Prepare a new registration and exact writes without changing the selected vault. */
export async function buildKnowledgeMergeReview({ merges, copyRegisteredContent = false, ...options } = {}) {
  const ctx = await context(options), { base, files } = ctx;
  if (!Array.isArray(merges) || !merges.length) fail('P22_KNOWLEDGE_MERGE_GROUPS_REQUIRED');
  const nodes = new Map(base.generation.shared_nodes.map(row => [row.path, row]));
  const papers = new Map(base.generation.papers.map(row => [row.paper_id, row]));
  const mapping = new Map(), writes = new Map(), claimed = new Set(), anchors = new Map(), anchorOverrides = new Map(), proposedAliases = [];
  const selection = [];
  for (const row of merges) {
    const { keep_path: keep, remove_paths: remove, append_markdown: addition, aliases = [], anchors: overrides = {}, expected_inputs = [] } = row ?? {};
    if (!Array.isArray(remove) || !remove.length || (copyRegisteredContent ? addition !== undefined
      : typeof addition !== 'string' || !/\S/.test(addition) || /<!--\s*(?:AUTO|KNOWLEDGE_STATE)/.test(addition))
      || !Array.isArray(aliases) || aliases.some(value => typeof value !== 'string' || !/\S/.test(value))
      || !Array.isArray(expected_inputs)) fail('P22_KNOWLEDGE_MERGE_GROUP_INVALID');
    for (const path of [keep, ...remove]) {
      if (!nodes.has(path) || claimed.has(path) || posix.dirname(path) !== posix.dirname(keep)) fail('P22_KNOWLEDGE_MERGE_GROUP_INVALID', { path });
      claimed.add(path);
    }
    for (const expected of expected_inputs) {
      const actual = ctx.observed.get(expected?.path);
      if (![keep, ...remove].includes(expected?.path) || expected.sha256?.replace(/^sha256:/, '') !== actual?.byte_sha256.slice(7)
        || expected.byte_length !== actual.byte_length) fail('P22_KNOWLEDGE_MERGE_INPUT_CHANGED', { path: expected?.path });
    }
    const removed = remove.map(path => sharedPage(files.get(path), path));
    const retained = sharedPage(files.get(keep), keep);
    const occupied = fragments(retained.text);
    const copies = copyRegisteredContent ? removed.map((page, index) => copyManagedPage(page, remove[index], occupied)) : [];
    const aliasList = [...new Set([...aliases, ...removed.flatMap((page, index) => [...aliasesOf(page, remove[index]), nodes.get(remove[index]).entity_id])])];
    proposedAliases.push(...aliasList.map(alias => ({ alias, target_path: keep })));
    for (const [index, path] of remove.entries()) {
      mapping.set(path, keep);
      anchorOverrides.set(path, new Map([...(copies[index]?.localAnchors ?? []), ...Object.entries(overrides[path] ?? {})]));
    }
    const merged = mergePage(retained, removed, copyRegisteredContent ? copies.map(page => page.contents).join('\n\n') : addition, aliasList, papers);
    writes.set(keep, Buffer.from(merged));
    anchors.set(keep, fragments(merged));
    selection.push({ keep_path: keep, remove_paths: remove.slice() });
  }
  const activePaths = [...files.keys()].filter(path => /^Wiki\/.*\.md$/.test(path));
  for (const path of activePaths) {
    if (mapping.has(path)) continue;
    const previous = writes.get(path) ?? files.get(path), text = decode(previous);
    const rewritten = rewriteLinks(text, path, mapping, activePaths, anchorOverrides, anchors);
    if (rewritten !== text) writes.set(path, Buffer.from(rewritten));
  }
  const desired = structuredClone(base.generation);
  desired.shared_nodes = desired.shared_nodes.filter(row => !mapping.has(row.path));
  // Retain removed pages and old presentations on disk. Only their current registration changes.
  const priorAlias = files.get(KNOWLEDGE_ALIASES_PATH);
  const prior = priorAlias ? parseRegisteredKnowledgeAliases(priorAlias, base.generation) : [];
  if (!priorAlias) {
    const dormant = read(ctx.root, KNOWLEDGE_ALIASES_PATH, true);
    if (dormant) {
      // A previous compensation may have deactivated this reserved path. Its bytes are a write preimage, never input aliases.
      let version;
      try { version = JSON.parse(dormant).schema_version; } catch { /* Refuse an unrelated file at the reserved path. */ }
      if (version !== aliasVersion) fail('P22_KNOWLEDGE_MERGE_TARGET_OCCUPIED', { path: KNOWLEDGE_ALIASES_PATH });
      ctx.observed.set(KNOWLEDGE_ALIASES_PATH, reference(KNOWLEDGE_ALIASES_PATH, dormant));
      ctx.files.set(KNOWLEDGE_ALIASES_PATH, dormant);
    }
  }
  const aliasRows = uniqueRows([...prior.map(row => ({ ...row, target_path: mapping.get(row.target_path) ?? row.target_path })), ...proposedAliases])
    .sort((a, b) => a.alias.localeCompare(b.alias) || a.target_path.localeCompare(b.target_path));
  const referenceRegistry = desired.shared_nodes.map(row => ({ ...row,
    registered_aliases: aliasRows.filter(alias => alias.target_path === row.path).map(alias => alias.alias) }));
  const resolveReference = (id, kind) => registeredKnowledgeReference(referenceRegistry, id, kind)?.entity_id;
  const referenceDiagnostics = [];
  for (const { keep_path: path } of selection) {
    const bound = bindPublishedKnowledgeReferences(decode(writes.get(path)), {
      reused: true, resolveCurrent: resolveReference, resolveHistorical: resolveReference, registeredPapers: new Set(papers.keys()),
    });
    writes.set(path, Buffer.from(bound.content));
    for (const reference of bound.unresolved) referenceDiagnostics.push({ code: 'RF_KNOWLEDGE_REFERENCE_UNRESOLVED', path, details: { reference } });
  }
  const aliasBytes = json({ schema_version: aliasVersion, aliases: aliasRows });
  desired.objects = desired.objects.filter(row => !mapping.has(row.path) && row.path !== KNOWLEDGE_ALIASES_PATH);
  desired.objects.push({ path: KNOWLEDGE_ALIASES_PATH, kind: aliasKind, sha256: sha(aliasBytes) });
  writes.set(KNOWLEDGE_ALIASES_PATH, aliasBytes);
  const changedSupports = new Set([...writes.keys()].filter(path => nodes.has(path)));
  return prepare(ctx, { desired, writes, mapping, changedSupports, referenceDiagnostics,
    maintenance: { operation: 'merge', merges: selection, retired: [...mapping.keys()].map(path => ctx.observed.get(path)) } });
}

/** Restore exact preimages and the former registration through a fresh approved generation. */
export async function buildKnowledgeMergeCompensationReview({ transactionId, trustAnchor, ...options } = {}) {
  const ctx = await context(options);
  const before = await readKnowledgeMergePreimages({ vaultRoot: ctx.root, transactionId, trustAnchor });
  const previous = assertActiveIndexContract(JSON.parse(before.rows.find(row => row.path === PHASE22_COMMIT_PATH).bytes), 'commit');
  if (previous.generation_id !== before.previous_generation || previous.active.path !== phase22GenerationPaths(previous.generation_id).active) fail('P22_KNOWLEDGE_MERGE_PREIMAGE_INVALID');
  const original = read(ctx.root, previous.active.path);
  if (sha(original) !== previous.active.sha256) fail('P22_KNOWLEDGE_MERGE_PREIMAGE_INVALID', { path: previous.active.path });
  const originalGeneration = assertActiveGeneration(JSON.parse(original)), mergedGeneration = assertActiveGeneration(JSON.parse(before.active));
  if (mergedGeneration.generation_id !== before.generation || originalGeneration.generation_id !== previous.generation_id) fail('P22_KNOWLEDGE_MERGE_PREIMAGE_INVALID');
  const desired = structuredClone(ctx.base.generation), writes = new Map();
  // Restore only rows this transaction changed, while checking their current registered postimages.
  for (const [collection, key] of [['objects', row => row.path], ['shared_nodes', row => row.path],
    ['papers', row => row.paper_id], ['topics', row => row.project_id ?? row.topic_id]]) {
    if (!originalGeneration[collection] && !mergedGeneration[collection]) continue;
    const current = new Map((desired[collection] ?? []).map(row => [key(row), row]));
    const old = new Map((originalGeneration[collection] ?? []).map(row => [key(row), row]));
    const merged = new Map((mergedGeneration[collection] ?? []).map(row => [key(row), row]));
    for (const id of new Set([...old.keys(), ...merged.keys()])) {
      if (hash(old.get(id) ?? null) === hash(merged.get(id) ?? null)) continue;
      if (hash(current.get(id) ?? null) !== hash(merged.get(id) ?? null)) fail('P22_KNOWLEDGE_MERGE_POSTIMAGE_CHANGED', { collection, id });
      if (old.has(id)) current.set(id, old.get(id));
      else current.delete(id);
    }
    desired[collection] = [...current.values()].sort((a, b) => key(a).localeCompare(key(b)));
  }
  const extraDependencies = [...before.readDependencies, reference(previous.active.path, original)];
  const { retired, merges } = before.reviewManifest.maintenance;
  for (const row of retired) {
    const bytes = read(ctx.root, row.path, true);
    if (!compareRefs(row, bytes)) fail('P22_KNOWLEDGE_MERGE_RETIRED_CHANGED', { path: row.path });
    ctx.files.set(row.path, bytes);
    extraDependencies.push(row);
  }
  for (const row of before.rows.filter(item => item.kind !== 'commit')) {
    const current = ctx.files.get(row.path);
    if (!compareRefs(row, current)) fail('P22_KNOWLEDGE_MERGE_POSTIMAGE_CHANGED', { path: row.path });
    if (row.bytes !== null) writes.set(row.path, row.bytes);
    else if (row.path !== KNOWLEDGE_ALIASES_PATH || desired.objects.some(item => item.path === row.path)) fail('P22_KNOWLEDGE_MERGE_PREIMAGE_INVALID', { path: row.path });
  }
  return prepare(ctx, { desired, writes, extraDependencies,
    changedSupports: new Set([...writes.keys()].filter(path => desired.shared_nodes.some(node => node.path === path))),
    maintenance: { operation: 'compensate', merges, retired: [], compensates_transaction: transactionId } });
}

export function usesCurrentKnowledgeMerge(review) { return records.has(review); }

export function assertKnowledgeMergeReviewCurrent(review) {
  const record = records.get(review);
  if (!record) fail('P22_REVIEW_NOT_OWNED');
  if (stamp(review) !== record.stamp) fail('P22_REVIEW_OUTPUT_INVALIDATED');
  if (hash(record.tools) !== hash(toolHashes())) fail('P22_REVIEW_TOOL_INVALIDATED');
  return review;
}
