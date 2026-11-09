import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import MarkdownIt from 'markdown-it';
import { normalizeIndexPath, phase22GenerationPaths, readCommittedGeneration } from './phase22-active-version.mjs';
import { createPhase22ContractValidator } from './phase22-contract-loader.mjs';
import { inspectManagedNote } from './phase22-managed-markdown.mjs';
import { buildBilingualIndex } from './phase22-search.mjs';
import { validateReadingArgument } from './reading-first-editor.mjs';
import { assertReadingFirstPublicationManifest, verifyReadingFirstPaperBytes, verifyReadingFirstPresentation } from './reading-first-index.mjs';
import { buildResearchMapCanvas, researchMapCanvasSection, serializeResearchMapCanvas } from './research-map-canvas.mjs';
import { fingerprintV3Json as hash } from './semantic-package-validator.mjs';

export const MAP_REFRESH_PROFILE = 'phase22-map-refresh-1.0';
export const MAP_REFRESH_TOOL_URLS = Object.freeze([
  './research-map-refresh.mjs', './research-map-canvas.mjs', './reading-first-editor.mjs', './reading-first-index.mjs',
  './phase22-active-version.mjs', './phase22-search.mjs', './phase22-managed-markdown.mjs', './maintenance-publication.mjs',
  './phase22-review.mjs', './phase22-publication.mjs', '../../Schema/phase22/reading-first-publication.schema.json',
  '../../Schema/phase22/review-manifest.schema.json',
].map(path => new URL(path, import.meta.url).href));
const records = new WeakMap();
const markdown = new MarkdownIt();
const languages = ['en', 'zh-CN'];
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value) + '\n');
const fail = (code, details = {}) => { throw Object.assign(new Error(code), { code, details }); };
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value);
const toolHashes = () => Object.fromEntries(MAP_REFRESH_TOOL_URLS.map(path => [new URL(path).pathname.split('/').at(-1), sha(readFileSync(new URL(path)))]));
const inventoryStamp = rows => rows.map(({ bytes, ...row }) => ({ ...row, observed_sha256: sha(bytes) }));
const stamp = review => hash({ manifest: review.reviewManifest, output: inventoryStamp(review.outputInventory), hashes: review.hashes });
const reference = (path, bytes) => ({ path, byte_sha256: sha(bytes), byte_length: bytes.length });
const headingAnchor = title => encodeURIComponent(title).replaceAll('%2F', '/').replaceAll('(', '%28').replaceAll(')', '%29');

function bytesAt(root, path, optional = false) {
  if (normalizeIndexPath(path) !== path) fail('P22_MAP_REFRESH_PATH_INVALID', { path });
  const absolute = join(root, path);
  let entry;
  try { entry = lstatSync(absolute); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || realpathSync(absolute) !== absolute) {
    fail('P22_MAP_REFRESH_PATH_INVALID', { path });
  }
  return readFileSync(absolute);
}

function readingHeadings(text) {
  const lines = text.split(/\r?\n/u);
  return new Set(markdown.parse(text, {}).filter(token => token.type === 'heading_open')
    .map(token => /^#{1,6}[ \t]+([^\r\n]+)$/u.exec(lines[token.map[0]])?.[1]
      ?.replace(/[ \t]+#+[ \t]*$/u, '').replace(/[ \t]+\^[A-Za-z0-9-]+$/u, '').trim())
    .filter(Boolean));
}

function wordingByLanguage(value, paperId) {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.entries(value).some(([language, edits]) => !languages.includes(language) || !Array.isArray(edits)
      || edits.some(edit => !edit || typeof edit !== 'object' || Object.keys(edit).length !== 2
        || typeof edit.before !== 'string' || typeof edit.after !== 'string' || edit.before === edit.after))) {
    fail('P22_MAP_REFRESH_WORDING_INVALID', { paperId });
  }
  return value;
}

function paragraphShape(value) {
  if (!value.trim() || value !== value.trim() || /[\u0000\u2028\u2029]/u.test(value)) return null;
  const tokens = markdown.parse(value, {});
  if (tokens.length !== 3 || tokens[0].type !== 'paragraph_open') return null;
  const inline = tokens[1].children.filter(row => row.type !== 'text')
    .map(({ type, markup, attrs, content }) => ({ type, markup, attrs, content }));
  // Obsidian syntax and source spelling can be invisible to, or normalized by, the Markdown parser.
  const links = value.match(/!?\[\[[^\]\r\n]+\]\]|!?\[[^\]\r\n]*\]\((?:\\.|[^\\()\r\n]|\([^()\r\n]*\))*\)|!?\[[^\]\r\n]*\]|https?:\/\/[^\s<>\]]+/gu) ?? [];
  const literals = value.match(/<[^>\r\n]+>|\$[^$\r\n]+\$|==[^=\r\n]+==|\\[^\r\n]|\^[A-Za-z0-9-]+(?=$|\r?\n)|(?:[+\-−±≈~<>≤≥][ \t]*)?\p{N}+(?:[.,]\p{N}+)*[%％]?|\r?\n/gu) ?? [];
  return JSON.stringify({ inline, links, literals });
}

function applyMapWordingEdits(original, binding, { language, path, edits }) {
  if (!edits.length) return original;
  const region = binding.regions.find(row => row.id === 'reading');
  const text = region.bytes.toString('utf8');
  const lines = text.match(/[^\n]*\n|[^\n]+$/gu);
  const tokens = markdown.parse(text, {});
  const headings = tokens.filter(row => row.type === 'heading_open' && row.level === 0 && ['h1', 'h2', 'h3'].includes(row.tag));
  const title = language === 'en' ? 'Research map' : '研究导图';
  const mapIndex = headings.findIndex(row => row.tag === 'h3'
    && [`### ${title}`, `### 2.1 ${title}`].includes(lines[row.map[0]].trimEnd()));
  if (mapIndex < 0) fail('P22_MAP_REFRESH_WORDING_INVALID', { path, reason: 'map-heading' });
  const start = headings[mapIndex].map[0];
  const next = headings[mapIndex + 1];
  const designFollows = next?.tag === 'h3' && (/^### 2\.2 /u.test(lines[next.map[0]]) || !lines[start].startsWith('### 2.1 '));
  const end = headings[mapIndex + (designFollows ? 2 : 1)]?.map[0] ?? lines.length;
  const paragraphs = tokens.filter(row => row.type === 'paragraph_open' && row.level === 0).map(({ map: [from, to] }) => {
    const paragraph = lines.slice(from, to).join('');
    const eol = /\r?\n$/u.exec(paragraph)?.[0] ?? '';
    return { from, to, text: paragraph.slice(0, paragraph.length - eol.length), eol };
  });
  const occupied = new Set();
  const patches = edits.map(({ before, after }) => {
    const shape = paragraphShape(before);
    if (!shape || shape !== paragraphShape(after)) fail('P22_MAP_REFRESH_WORDING_INVALID', { path, reason: 'paragraph-structure' });
    const matches = paragraphs.filter(row => row.text === before);
    const [match] = matches;
    if (matches.length !== 1 || match.from <= start || match.to > end || occupied.has(match.from)) {
      fail('P22_MAP_REFRESH_WORDING_INVALID', { path, reason: 'paragraph-scope', matches: matches.length });
    }
    occupied.add(match.from);
    return { ...match, after };
  });
  for (const { from, to, after, eol } of patches.sort((a, b) => b.from - a.from)) lines.splice(from, to - from, after + eol);
  return Buffer.concat([original.subarray(0, region.from), Buffer.from(lines.join('')), original.subarray(region.to)]);
}

function renumberCompactDesign(reading, { path, inserted }) {
  const lines = reading.split('\n');
  const headings = markdown.parse(reading, {}).filter(token => token.type === 'heading_open');
  const start = headings.findIndex(token => token.tag === 'h2' && /^## 2\. /u.test(lines[token.map[0]]));
  const titleChanges = new Map();
  let firstLine;
  if (start >= 0) for (const token of headings.slice(start + 1)) {
    if (token.tag === 'h1' || token.tag === 'h2') break;
    if (token.tag !== 'h3') continue;
    const line = token.map[0];
    const match = /^### (2\.(\d+) [^\r\n]+)(\r?)$/u.exec(lines[line]);
    if (!match || Number(match[2]) !== titleChanges.size + 1) fail('P22_MAP_REFRESH_DESIGN_NUMBERING_INVALID', { path });
    const next = `2.${titleChanges.size + 2}` + match[1].slice(2 + match[2].length);
    titleChanges.set(match[1], next);
    lines[line] = `### ${next}${match[3]}`;
    firstLine ??= line;
  }
  if (firstLine === undefined) fail('P22_MAP_REFRESH_DESIGN_NUMBERING_INVALID', { path });
  lines[firstLine] = inserted + lines[firstLine];
  return { reading: lines.join('\n'), titleChanges };
}

function replaceMap(original, binding, { language, canvasPath, path }) {
  const region = binding.regions.find(row => row.id === 'reading');
  const text = region.bytes.toString('utf8');
  const fences = [...text.matchAll(/^```mermaid[ \t]*(\r?\n)flowchart (LR|TD)\r?\n[\s\S]*?^```[ \t]*(?:\r?\n|$)/gm)];
  if (fences.length !== 1) fail('P22_MAP_REFRESH_LEGACY_MAP_REQUIRED', { path });
  const [fence] = fences, eol = fence[1], legacy = fence[2] === 'TD';
  const title = language === 'en' ? 'Research map' : '研究导图';
  const start = text.slice(0, fence.index);
  const hasHeading = new RegExp(`(?:^|\\n)#{2,3} (?:2\\.1 )?${title}\\r?\\n(?:\\r?\\n)?$`, 'u').test(start);
  if (legacy && !hasHeading) fail('P22_MAP_REFRESH_LEGACY_MAP_REQUIRED', { path });
  let tail = text.slice(fence.index + fence[0].length);
  if (tail.startsWith(eol)) tail = tail.slice(eol.length);
  const oldNav = legacy ? /^(?:- \[[^\r\n]*\]\(#[^\r\n]*\)[ \t]*(?:\r?\n|$))+(?:\r?\n)?/u
    : /^(?:Findings not shown in the map:|未画入导图的发现：)[^\r\n]*(?:\r?\n|$)(?:\r?\n)?/u;
  tail = tail.replace(oldNav, '');
  const section = (researchMapCanvasSection({ canvasPath, language }) + '\n\n').replaceAll('\n', eol);
  if (hasHeading) {
    const after = Buffer.concat([original.subarray(0, region.from), Buffer.from(start + section + tail), original.subarray(region.to)]);
    return { bytes: after, managedHash: inspectManagedNote(after).managedHash, titleChanges: new Map() };
  }
  const mapHeading = `2.1 ${title}`;
  const inserted = `### ${mapHeading}${eol}${eol}` + section;
  const { reading, titleChanges } = renumberCompactDesign(start + tail, { path, inserted });
  const anchors = new Map([...titleChanges].map(([before, after]) => [headingAnchor(before), { before, after }]));
  const updateLinks = value => value.replace(/\[([^\]\r\n]*)\]\(#([^\s)]+)\)/gu, (match, label, anchor) => {
    const change = anchors.get(anchor);
    if (!change) return match;
    return `[${label === change.before ? change.after : label}](#${headingAnchor(change.after)})`;
  });
  const firstTitle = titleChanges.keys().next().value;
  const entry = heading => `>   - [${heading}](#${headingAnchor(heading)})${eol}`;
  const source = binding.regions.find(row => row.id === 'source');
  if (!source.text.includes(entry(firstTitle))) fail('P22_MAP_REFRESH_DESIGN_CONTENTS_MISSING', { path });
  const nextSource = updateLinks(source.text.replace(entry(firstTitle), entry(mapHeading) + entry(firstTitle)));
  const after = Buffer.concat([original.subarray(0, source.from), Buffer.from(nextSource), original.subarray(source.to, region.from),
    Buffer.from(updateLinks(reading)), original.subarray(region.to)]);
  return { bytes: after, managedHash: inspectManagedNote(after).managedHash, titleChanges };
}

/** Derive a bounded display-only maintenance review from the current committed generation. */
export async function buildMapRefreshReview({ vaultRoot, runId, generation, papers } = {}) {
  const root = resolve(vaultRoot ?? '');
  if (!vaultRoot || realpathSync(root) !== root || !lstatSync(root).isDirectory() || !identifier(runId)) fail('P22_MAP_REFRESH_SCOPE_INVALID');
  if (!Array.isArray(papers) || !papers.length || papers.some(row => !identifier(row?.paperId))
    || new Set(papers.map(row => row.paperId)).size !== papers.length) fail('P22_MAP_REFRESH_PAPERS_INVALID');
  const paths = phase22GenerationPaths(generation);
  const base = await readCommittedGeneration({ vaultRoot: root });
  if (!base.ok) fail('P22_MAP_REFRESH_COMMITTED_REQUIRED', { errors: base.errors });
  if (base.generation_id === generation) fail('P22_GENERATION_NOT_NEW');
  const active = structuredClone(base.generation), objects = new Map(active.objects.map(row => [row.path, row]));
  active.generation_id = generation;
  delete active.index_manifest;
  const changed = [], previews = [], assets = [], output = [], selected = [], wordingEdits = [];
  const files = new Map();
  const add = (path, kind, bytes, before = null, extra = {}) => {
    if (before === null && (objects.has(path) || bytesAt(root, path, true) !== null)) fail('P22_MAP_REFRESH_TARGET_OCCUPIED', { path });
    const row = { ...reference(path, bytes), kind, bytes, before_sha256: before === null ? null : sha(before),
      before_byte_length: before?.length ?? null, ...extra };
    output.push(row);
    return row;
  };

  for (const selection of [...papers].sort((a, b) => a.paperId.localeCompare(b.paperId))) {
    const { paperId, map, argument, primaryFindingIds, sectionTitles } = selection;
    const paper = active.papers.find(row => row.paper_id === paperId);
    if (paper?.profile !== 'reading-first-obsidian-1.0' || !identifier(paper.run_id)) fail('P22_MAP_REFRESH_PAPER_INVALID', { paperId });
    const previousPresentation = paper.reader_presentation.path, priorPaper = base.generation.papers.find(row => row.paper_id === paperId);
    const manifest = verifyReadingFirstPresentation(priorPaper, bytesAt(root, previousPresentation), base.generation);
    const registeredCanvases = manifest.presentation_assets ?? [];
    const wording = wordingByLanguage(selection.noteWordingEdits, paperId);
    if (!registeredCanvases.length && Object.values(wording).some(rows => rows.length)) {
      fail('P22_MAP_REFRESH_WORDING_INVALID', { paperId, reason: 'registered-map-required' });
    }
    const sharedSections = Object.keys(sectionTitles.en).filter(id => Object.hasOwn(sectionTitles['zh-CN'], id));
    validateReadingArgument({ argument, primaryFindingIds, map, sectionIds: sharedSections });

    const notes = {}, presentationAssets = [];
    for (const language of languages) {
      const notePath = paper.paths[language], original = bytesAt(root, notePath);
      const binding = verifyReadingFirstPaperBytes(priorPaper, language, original, base.generation, manifest);
      const headings = readingHeadings(binding.regions.find(row => row.id === 'reading').text);
      const targets = sectionTitles[language];
      for (const { section_id } of [...map.steps, ...map.findings, argument.question, ...argument.claims, argument.conclusion]) {
        if (!headings.has(targets[section_id])) fail('P22_MAP_REFRESH_HEADING_MISSING', { paperId, language, section_id, title: targets[section_id] });
      }
      const priorAsset = registeredCanvases.find(row => row.language === language);
      const canvasPath = priorAsset?.path ?? `Figures/${paper.run_id}/research-map.${language}.canvas`;
      const priorCanvas = priorAsset ? bytesAt(root, priorAsset.path) : null;
      if (priorAsset && (sha(priorCanvas) !== priorAsset.sha256 || priorCanvas.length !== priorAsset.byte_length)) {
        fail('P22_MAP_REFRESH_CANVAS_PREIMAGE_INVALID', { path: priorAsset.path });
      }
      const edits = wording[language] ?? [];
      const note = priorAsset
        ? { bytes: applyMapWordingEdits(original, binding, { language, path: notePath, edits }), titleChanges: new Map() }
        : replaceMap(original, binding, { language, canvasPath, path: notePath });
      const { bytes, titleChanges } = note;
      const managedHash = note.managedHash ?? (edits.length ? inspectManagedNote(bytes).managedHash : binding.managedHash);
      wordingEdits.push(...edits.map(edit => ({ paper_id: paperId, language, path: notePath, ...edit })));
      const currentTitles = Object.fromEntries(Object.entries(targets).map(([id, title]) => [id, titleChanges.get(title) ?? title]));
      const canvas = buildResearchMapCanvas({ paperId, map, argument, primaryFindingIds, language, notePath, sectionTitles: currentTitles });
      const canvasBytes = Buffer.from(serializeResearchMapCanvas(canvas));
      const asset = { kind: 'research-map-canvas', language, path: canvasPath, sha256: sha(canvasBytes), byte_length: canvasBytes.length };
      if (!priorCanvas?.equals(canvasBytes)) add(canvasPath, 'asset', canvasBytes, priorCanvas);
      objects.set(canvasPath, { path: canvasPath, kind: 'asset', sha256: asset.sha256 });
      files.set(canvasPath, canvasBytes);
      presentationAssets.push(asset);
      assets.push(asset);
      if (!bytes.equals(original)) add(notePath, 'paper', bytes, original,
        { language, managed_hash: managedHash, before_managed_hash: binding.managedHash });
      else files.set(notePath, original);
      const target = { path: notePath, byte_sha256: sha(bytes), managed_hash: managedHash };
      previews.push({ ...target, language });
      objects.get(notePath).sha256 = managedHash;
      notes[language] = bytes;
    }
    const presentationPath = `.apa-v3/reading-first/presentation/${paperId}-${generation}.json`;
    const next = { ...manifest, targets: { ...manifest.targets, presentation: presentationPath,
      notes: Object.fromEntries(languages.map(language => {
        const path = paper.paths[language];
        return [language, { path, byte_sha256: sha(notes[language]), managed_hash: objects.get(path).sha256 }];
      })), assets: registeredCanvases.length ? manifest.targets.assets : [...manifest.targets.assets, ...presentationAssets.map(row => row.path)] },
      presentation_assets: presentationAssets };
    assertReadingFirstPublicationManifest(next);
    const manifestBytes = json(next);
    add(presentationPath, 'reader-presentation', manifestBytes);
    objects.delete(previousPresentation);
    objects.set(presentationPath, { path: presentationPath, kind: 'reader-presentation', sha256: sha(manifestBytes) });
    paper.reader_presentation = { path: presentationPath, sha256: sha(manifestBytes) };
    files.set(presentationPath, manifestBytes);
    changed.push({ readingFirst: next, notes });
    selected.push(paperId);
    for (const { path } of manifest.targets.support) if (!files.has(path)) files.set(path, bytesAt(root, path));
  }
  active.objects = [...objects.values()].sort((a, b) => a.path.localeCompare(b.path));
  const built = buildBilingualIndex({ generation: active, validatedInputs: { papers: changed, previousSnapshot: base,
    carryHistoricalDocuments: true, files: [...files].map(([path, bytes]) => ({ path, bytes })) } });
  const activeRow = add(paths.active, 'active', json(built.generation));
  const indexRow = add(paths.index, 'index', built.bytes);
  const written = new Set(output.map(row => row.path));
  const readDependencies = base.generation.objects.filter(row => !written.has(row.path))
    .map(({ path }) => reference(path, files.get(path) ?? bytesAt(root, path)));
  const scientificReviewHash = hash({ previous_generation: base.generation_id,
    papers: base.generation.papers.map(({ paper_id, core_hash, dependencies }) => ({ paper_id, core_hash, dependencies })) });
  const tools = toolHashes(), actual = base.evidence_mode === 'actual';
  const reviewManifest = { schema_version: 'phase22/review-manifest-1.0', profile: MAP_REFRESH_PROFILE,
    identity: { paper_id: 'library-map-maintenance', run_id: runId,
      analysis_revision: 'maps_' + hash({ selected, previews, assets }).slice(7, 39) },
    status: actual ? 'review_ready' : 'synthetic_prepared', evidence_mode: base.evidence_mode, review_ready: actual,
    publishable: false, reading_accepted: true, native_presentation: { status: 'not_run' }, scientific_review_hash: scientificReviewHash,
    generation, previous_generation: base.generation_id, previews, support_notes: active.shared_nodes, assets,
    read_dependencies: readDependencies, dependencies: { previous_generation: base.generation_id }, tools,
    index: { path: indexRow.path, byte_sha256: indexRow.byte_sha256 }, active: { path: activeRow.path, byte_sha256: activeRow.byte_sha256 },
    write_set: output.map(({ bytes, ...row }) => row), maintenance: { operation: 'map-refresh', papers: selected }, diagnostics: [],
    provenance_limits: { scientific_review_scope: 'existing committed acceptance retained; research map display only', native_presentation: 'not_run',
      ...(wordingEdits.length ? { note_wording_edits: wordingEdits } : {}) } };
  (await createPhase22ContractValidator()).assert('phase22/review-manifest-1.0', reviewManifest);
  add(`.apa-v3/phase22/generations/${generation}/manifest.json`, 'manifest', json(reviewManifest));
  output.sort((a, b) => a.path.localeCompare(b.path));
  const hashes = { scientific_review_hash: scientificReviewHash,
    review_bundle_hash: hash({ reviewManifest, outputs: inventoryStamp(output), read_dependencies: readDependencies }),
    output_inventory_hash: hash({ generation, previous_generation: base.generation_id, output: inventoryStamp(output), read_dependencies: readDependencies }) };
  const review = { ok: true, status: reviewManifest.status, reviewManifest, outputInventory: output, hashes, diagnostics: [] };
  records.set(review, { stamp: stamp(review), tools });
  return review;
}

export function assertMapRefreshReviewCurrent(review) {
  const record = records.get(review);
  if (!record) fail('P22_REVIEW_NOT_OWNED');
  if (stamp(review) !== record.stamp) fail('P22_REVIEW_OUTPUT_INVALIDATED');
  if (hash(record.tools) !== hash(toolHashes())) fail('P22_REVIEW_TOOL_INVALIDATED');
  return review;
}
