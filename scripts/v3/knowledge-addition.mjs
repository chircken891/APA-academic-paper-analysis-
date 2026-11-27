import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import MarkdownIt from 'markdown-it';
import { normalizeIndexPath, phase22GenerationPaths, readRegisteredCommit } from './phase22-active-version.mjs';
import { createPhase22ContractValidator } from './phase22-contract-loader.mjs';
import { buildBilingualIndex } from './phase22-search.mjs';
import { assertReadingFirstPublicationManifest, verifyReadingFirstPaperIdentity, verifyReadingFirstPresentation } from './reading-first-index.mjs';
import { matchReadingFirstKnowledgeIdentity, renderSharedKnowledge } from './reading-first-knowledge.mjs';
import { readCommittedReadingFirstKnowledgeRegistry, readKnowledgeRegistryRow } from './reading-first-knowledge-registry.mjs';
import { fingerprintV3Json as hash } from './semantic-package-validator.mjs';

export const KNOWLEDGE_ADDITION_PROFILE = 'phase22-knowledge-addition-1.0';
export const KNOWLEDGE_ADDITION_TOOL_URLS = Object.freeze([
  './knowledge-addition.mjs', './reading-first-knowledge.mjs', './reading-first-knowledge-registry.mjs',
  './reading-first-index.mjs', './phase22-active-version.mjs', './phase22-search.mjs', './phase22-managed-markdown.mjs',
  './phase22-contract-loader.mjs', './maintenance-publication.mjs', './phase22-review.mjs', './phase22-publication.mjs',
  '../../Schema/phase22/reading-first-publication.schema.json', '../../Schema/phase22/review-manifest.schema.json',
].map(path => new URL(path, import.meta.url).href));

const records = new WeakMap();
const languages = ['en', 'zh-CN'];
const markdown = new MarkdownIt();
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value) + '\n');
const ref = (path, bytes) => ({ path, byte_sha256: sha(bytes), byte_length: bytes.length });
const fail = (code, details = {}) => { throw Object.assign(new Error(code), { code, details }); };
const text = value => typeof value === 'string' && /\S/u.test(value) && !/[\u0000\r\n\u2028\u2029]/u.test(value);
const plain = value => text(value) && !/[\[\]<>`]/u.test(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value);
const sectionId = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9-]*$/.test(value);
const fingerprint = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const unique = values => new Set(values).size === values.length;
const keys = (value, allowed) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => allowed.includes(key));
const localized = (value, valid) => keys(value, languages) && languages.every(language => valid(value[language]));
const toolHashes = () => Object.fromEntries(KNOWLEDGE_ADDITION_TOOL_URLS.map(path => [new URL(path).pathname.split('/').at(-1), sha(readFileSync(new URL(path)))]));
const inventoryStamp = rows => rows.map(({ bytes, ...row }) => ({ ...row, observed_sha256: sha(bytes) }));
const stamp = review => hash({ manifest: review.reviewManifest, output: inventoryStamp(review.outputInventory), hashes: review.hashes });
const href = (from, to) => posix.relative(posix.dirname(from), to).split('/').map(part => encodeURIComponent(part).replaceAll('(', '%28').replaceAll(')', '%29')).join('/');

function list(value, valid) {
  return Array.isArray(value) && value.every(valid);
}

export function validateKnowledgeAdditionOptions(input) {
  if (!keys(input, ['generation', 'paperId', 'before_sha256', 'methods_sha256', 'nodes']) || !identifier(input.paperId)
    || !localized(input.before_sha256, fingerprint) || !fingerprint(input.methods_sha256) || !Array.isArray(input.nodes) || !input.nodes.length) {
    fail('P22_MAINTENANCE_OPTIONS_INVALID', { field: 'knowledge-addition' });
  }
  for (const node of input.nodes) {
    if (!keys(node, ['id', 'candidate_index', 'title_zh', 'aliases', 'paragraphs_zh', 'page', 'applications', 'index_lines'])
      || !sectionId(node.id) || !Number.isSafeInteger(node.candidate_index) || node.candidate_index < 0
      || (node.title_zh !== undefined && !plain(node.title_zh)) || !list(node.aliases ?? [], plain)
      || !list(node.paragraphs_zh, plain) || !node.paragraphs_zh.length || !Number.isSafeInteger(node.page) || node.page < 1
      || !list(node.applications, sectionId) || !node.applications.length || !unique(node.applications)
      || !localized(node.index_lines, text)) fail('P22_MAINTENANCE_OPTIONS_INVALID', { field: 'knowledge-addition.nodes' });
  }
  if (!unique(input.nodes.map(node => node.id)) || !unique(input.nodes.map(node => node.candidate_index))) {
    fail('P22_MAINTENANCE_OPTIONS_INVALID', { field: 'knowledge-addition.nodes', reason: 'duplicate' });
  }
}

function bytesAt(root, path, optional = false) {
  if (normalizeIndexPath(path) !== path) fail('P22_KNOWLEDGE_ADDITION_PATH_INVALID', { path });
  const absolute = join(root, path);
  let entry;
  try { entry = lstatSync(absolute); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || realpathSync(absolute) !== absolute) {
    fail('P22_KNOWLEDGE_ADDITION_PATH_INVALID', { path });
  }
  return readFileSync(absolute);
}

function parseEvidence(bytes, path) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('P22_KNOWLEDGE_ADDITION_METHODS_INVALID', { path }); }
}

function prepareNote(root, paper, language, expected) {
  const path = paper.paths[language], bytes = bytesAt(root, path);
  if (sha(bytes) !== expected) fail('P22_KNOWLEDGE_ADDITION_PREIMAGE_CHANGED', { path });
  const binding = verifyReadingFirstPaperIdentity(paper, language, bytes);
  const region = binding.regions.find(row => row.id === 'reading');
  const lines = region.text.match(/[^\n]*\n|[^\n]+$/gu);
  const headings = markdown.parse(region.text, {}).flatMap((token, index, tokens) => token.type === 'heading_open' && token.level === 0
    ? [{ tag: token.tag, line: token.map[0], title: tokens[index + 1].content }] : []);
  const expectedTitle = language === 'en' ? '3.1 Methods and concepts at a glance' : '3.1 方法与概念索引';
  const matches = headings.filter(row => row.tag === 'h3' && row.title === expectedTitle);
  if (matches.length !== 1) fail('P22_KNOWLEDGE_ADDITION_INDEX_REQUIRED', { path });
  const start = matches[0].line;
  const end = headings.find(row => row.line > start && ['h1', 'h2', 'h3'].includes(row.tag))?.line ?? lines.length;
  return { path, bytes, binding, region, lines, headings, start, end, additions: new Map() };
}

function addIndexLink(note, before, label, link) {
  const indices = [];
  for (let i = note.start + 1; i < note.end; i++) {
    if (note.lines[i].replace(/\r?\n$/u, '') === before) indices.push(i);
  }
  if (indices.length !== 1 || !/^(?:> )?\[[^\]\r\n]+\]\(#[^)]+\)/u.test(before)) {
    fail('P22_KNOWLEDGE_ADDITION_INDEX_LINE_INVALID', { path: note.path });
  }
  const line = indices[0], additions = note.additions.get(line) ?? [];
  additions.push(` · [${label}](${link})`);
  note.additions.set(line, additions);
}

function applicationHeading(note, id) {
  const anchor = new RegExp(`(?:^|\\s)\\^rf-${id}[ \\t]*$`, 'u');
  const lines = note.lines.flatMap((line, index) => anchor.test(line.replace(/\r?\n$/u, '')) ? [index] : []);
  if (lines.length !== 1 || lines[0] < note.end) fail('P22_KNOWLEDGE_ADDITION_APPLICATION_INVALID', { path: note.path, id });
  const heading = note.headings.findLast(row => row.line < lines[0] && ['h2', 'h3'].includes(row.tag));
  if (!heading) fail('P22_KNOWLEDGE_ADDITION_APPLICATION_INVALID', { path: note.path, id });
  return heading.title.replace(/^\d+(?:\.\d+)*\.?\s+/u, '');
}

function finishNote(note, paper, language) {
  const { path, bytes, binding, region, lines, additions } = note;
  const patched = lines.map((line, index) => additions.has(index)
    ? line.replace(/(\r?\n)?$/u, ending => additions.get(index).join('') + ending) : line).join('');
  const output = Buffer.concat([bytes.subarray(0, region.from), Buffer.from(patched), bytes.subarray(region.to)]);
  const managedHash = verifyReadingFirstPaperIdentity(paper, language, output).managedHash;
  return { target: { path, byte_sha256: sha(output), managed_hash: managedHash }, output,
    extra: { language, managed_hash: managedHash, before_managed_hash: binding.managedHash } };
}

function buildItem(spec, candidate, source, bibliography) {
  const { id, aliases, paragraphs_zh: zh } = spec;
  const en = [candidate?.definition, candidate?.operation, candidate?.applicability_and_limit,
    ...(candidate?.teaching_example === undefined ? [] : [candidate.teaching_example])];
  const titleEn = candidate?.english_title, titleZh = spec.title_zh ?? candidate?.title;
  if (!['method', 'method_context'].includes(candidate?.type) || !plain(titleEn) || !plain(titleZh) || !en.every(plain)
    || !text(candidate.source_location)) fail('P22_KNOWLEDGE_ADDITION_METHOD_CANDIDATE_INVALID', { index: spec.candidate_index });
  const citation = [bibliography?.first_author, bibliography?.year].filter(Boolean).join(' ') || 'Registered paper';
  return { id, canonical_key: id, kind: 'method', title: { en: titleEn, 'zh-CN': titleZh }, aliases: aliases ?? [],
    source_kind: 'method-background', paragraphs: { en, 'zh-CN': zh }, sources: [{
      title: `${citation}, ${candidate.source_location}; explanatory synthesis from the accepted Methods record`, path: source.path, page: spec.page,
    }] };
}

export async function buildKnowledgeAdditionReview({ vaultRoot, runId, generation, input } = {}) {
  validateKnowledgeAdditionOptions(input);
  const root = resolve(vaultRoot ?? '');
  if (!vaultRoot || realpathSync(root) !== root || !lstatSync(root).isDirectory() || !identifier(runId)) fail('P22_KNOWLEDGE_ADDITION_SCOPE_INVALID');
  const paths = phase22GenerationPaths(generation);
  const base = await readRegisteredCommit({ vaultRoot: root });
  if (!base.ok) fail('P22_KNOWLEDGE_ADDITION_COMMITTED_REQUIRED', { errors: base.errors });
  if (base.generation_id === generation) fail('P22_GENERATION_NOT_NEW');
  const active = structuredClone(base.generation);
  active.generation_id = generation;
  delete active.index_manifest;
  const paper = active.papers.find(row => row.paper_id === input.paperId);
  if (paper?.profile !== 'reading-first-obsidian-1.0' || !identifier(paper.run_id) || paper.run_id === runId
    || !fingerprint(paper.dependencies.reading_review)) fail('P22_KNOWLEDGE_ADDITION_PAPER_INVALID', { paperId: input.paperId });

  const originalRun = `Eval/apa-v3/runs/${paper.run_id}`;
  const methodsPath = `${originalRun}/science/methods.json`;
  const receiptPath = `${originalRun}/.phase21-receipts/methods.json`;
  const methodsBytes = bytesAt(root, methodsPath), receiptBytes = bytesAt(root, receiptPath);
  if (sha(methodsBytes) !== input.methods_sha256) fail('P22_KNOWLEDGE_ADDITION_METHODS_CHANGED', { path: methodsPath });
  const methods = parseEvidence(methodsBytes, methodsPath), receipt = parseEvidence(receiptBytes, receiptPath);
  const candidates = methods?.reusable_knowledge_candidates?.items;
  if (methods?.role?.toLowerCase() !== 'methods' || methods.run_id !== paper.run_id || !Array.isArray(candidates)
    || receipt?.schema_version !== 'phase21-owned-artifact-receipt-1.0' || receipt.artifact_id !== 'methods'
    || receipt.owner_actor_id !== 'methods' || receipt.role !== 'methods' || receipt.run_id !== paper.run_id
    || receipt.path !== 'science/methods.json' || receipt.revision !== methods.revision || receipt.sha256 !== input.methods_sha256
    || receipt.byte_length !== methodsBytes.length) fail('P22_KNOWLEDGE_ADDITION_METHODS_INVALID', { path: methodsPath });

  const priorPresentationPath = paper.reader_presentation.path;
  const priorPresentationBytes = bytesAt(root, priorPresentationPath);
  const priorPresentation = verifyReadingFirstPresentation(paper, priorPresentationBytes, base.generation);
  const source = priorPresentation.citation?.sources.find(row => row.source_id === 'paper');
  const objects = new Map(active.objects.map(row => [row.path, row]));
  if (!source || !/\.pdf$/iu.test(source.path) || objects.get(source.path)?.kind !== 'asset'
    || objects.get(source.path).sha256 !== source.sha256) fail('P22_KNOWLEDGE_ADDITION_SOURCE_INVALID');
  const sourceBytes = bytesAt(root, source.path);
  if (sha(sourceBytes) !== source.sha256 || sourceBytes.length !== source.byte_length) fail('P22_KNOWLEDGE_ADDITION_SOURCE_INVALID', { path: source.path });

  const output = [], dependencies = new Map([[methodsPath, methodsBytes], [receiptPath, receiptBytes],
    [priorPresentationPath, priorPresentationBytes], [source.path, sourceBytes]]);
  const put = (path, kind, bytes, before = null, extra = {}) => {
    if (before === null && (objects.has(path) || output.some(row => row.path === path) || bytesAt(root, path, true) !== null)) {
      fail('P22_KNOWLEDGE_ADDITION_TARGET_OCCUPIED', { path });
    }
    const row = { ...ref(path, bytes), kind, bytes, before_sha256: before === null ? null : sha(before),
      before_byte_length: before?.length ?? null, ...extra };
    output.push(row);
    return row;
  };
  const notes = Object.fromEntries(languages.map(language => [language, prepareNote(root, paper, language, input.before_sha256[language])]));
  const paperTitle = notes.en.binding.frontmatter.title;
  if (!text(paperTitle)) fail('P22_KNOWLEDGE_ADDITION_PAPER_INVALID', { paperId: paper.paper_id });
  const knowledgeRegistry = [...await readCommittedReadingFirstKnowledgeRegistry({ vaultRoot: root })];
  const files = new Map(), nodes = [], additions = [];
  for (const spec of input.nodes) {
    const item = buildItem(spec, candidates[spec.candidate_index], source, priorPresentation.citation.bibliography);
    const identityMatch = matchReadingFirstKnowledgeIdentity({ item, knowledgeRegistry });
    const conflicts = [...identityMatch.paths, ...(identityMatch.ambiguous_paths ?? []), ...(identityMatch.candidate_paths ?? [])];
    if (conflicts.length) fail('P22_KNOWLEDGE_ADDITION_IDENTITY_CONFLICT', { id: spec.id, paths: conflicts });
    const applicationSections = spec.applications.map(id => ({ id, headings: Object.fromEntries(languages.map(language =>
      [language, applicationHeading(notes[language], id)])) }));
    const { note } = renderSharedKnowledge({ item, knowledgeRegistry, paperTargets: paper.paths, paperId: paper.paper_id,
      paperTitle, vaultPath: value => value, href, identityMatch, applicationSections });
    const entityId = 'rf_' + hash({ path: note.path }).slice(7, 39);
    const entry = { entity_id: entityId, path: note.path };
    const row = put(note.path, 'support', note.bytes, null, { entity_id: entityId });
    objects.set(note.path, { path: note.path, kind: 'support', sha256: row.byte_sha256 });
    files.set(note.path, note.bytes);
    knowledgeRegistry.push(readKnowledgeRegistryRow({ path: note.path, content: note.content, entityId }));
    additions.push(entry);
    nodes.push({ path: note.path, candidate_index: spec.candidate_index, applications: spec.applications });
    for (const language of languages) {
      const anchor = encodeURIComponent(language === 'en' ? 'English' : '中文');
      addIndexLink(notes[language], spec.index_lines[language], item.title[language], `${href(notes[language].path, note.path)}#${anchor}`);
    }
  }
  active.shared_nodes = [...active.shared_nodes, ...additions].sort((a, b) => a.path.localeCompare(b.path));

  const previews = [], patchedNotes = {}, targets = {};
  for (const language of languages) {
    const note = notes[language], { target, output: bytes, extra } = finishNote(note, paper, language);
    put(note.path, 'paper', bytes, note.bytes, extra);
    objects.get(note.path).sha256 = target.managed_hash;
    patchedNotes[language] = bytes;
    targets[language] = target;
    previews.push({ ...target, language });
  }
  for (const { path } of priorPresentation.targets.support) {
    const bytes = bytesAt(root, path);
    files.set(path, bytes);
    dependencies.set(path, bytes);
    objects.get(path).sha256 = sha(bytes);
  }
  const presentationPath = `.apa-v3/reading-first/presentation/${paper.paper_id}-${generation}.json`;
  const nextPresentation = assertReadingFirstPublicationManifest({ ...priorPresentation, targets: { ...priorPresentation.targets,
    presentation: presentationPath, notes: targets, support: [...priorPresentation.targets.support, ...additions] } });
  const presentationBytes = json(nextPresentation);
  const presentationRow = put(presentationPath, 'reader-presentation', presentationBytes);
  objects.delete(priorPresentationPath);
  objects.set(presentationPath, { path: presentationPath, kind: 'reader-presentation', sha256: presentationRow.byte_sha256 });
  paper.reader_presentation = { path: presentationPath, sha256: presentationRow.byte_sha256 };
  files.set(presentationPath, presentationBytes);
  active.objects = [...objects.values()].sort((a, b) => a.path.localeCompare(b.path));
  const built = buildBilingualIndex({ generation: active, validatedInputs: {
    papers: [{ readingFirst: nextPresentation, notes: patchedNotes }], previousPrepared: base,
    carryHistoricalDocuments: true, files: [...files].map(([path, bytes]) => ({ path, bytes })),
  } });

  const activeRow = put(paths.active, 'active', json(built.generation)), indexRow = put(paths.index, 'index', built.bytes);
  const scientificReviewHash = paper.dependencies.reading_review;
  const tools = toolHashes(), actual = base.evidence_mode === 'actual';
  const readDependencies = [...dependencies].map(([path, bytes]) => ref(path, bytes)).sort((a, b) => a.path.localeCompare(b.path));
  const reviewManifest = {
    schema_version: 'phase22/review-manifest-1.0', profile: KNOWLEDGE_ADDITION_PROFILE,
    identity: { paper_id: paper.paper_id, run_id: runId, analysis_revision: 'knowledge_' + hash({ previews, additions }).slice(7, 39) },
    status: actual ? 'review_ready' : 'synthetic_prepared', evidence_mode: base.evidence_mode, review_ready: actual,
    publishable: false, reading_accepted: true, native_presentation: { status: 'not_run' }, scientific_review_hash: scientificReviewHash,
    generation, previous_generation: base.generation_id, previews, support_notes: additions, assets: [], read_dependencies: readDependencies,
    dependencies: { previous_generation: base.generation_id, existing_scientific_input: paper.core_hash, existing_reading_review: scientificReviewHash },
    tools, index: { path: indexRow.path, byte_sha256: indexRow.byte_sha256 }, active: { path: activeRow.path, byte_sha256: activeRow.byte_sha256 },
    write_set: output.map(({ bytes, ...row }) => row),
    maintenance: { operation: 'knowledge-addition', paper_id: paper.paper_id, original_run_id: paper.run_id,
      methods: ref(methodsPath, methodsBytes), nodes }, diagnostics: [],
    provenance_limits: { scientific_review_scope: 'existing committed review retained; new method background reuses accepted Methods evidence',
      knowledge_authority: 'user-requested maintenance; new scientific review not performed', native_presentation: 'not_run' },
  };
  (await createPhase22ContractValidator()).assert('phase22/review-manifest-1.0', reviewManifest);
  put(`.apa-v3/phase22/generations/${generation}/manifest.json`, 'manifest', json(reviewManifest));
  output.sort((a, b) => a.path.localeCompare(b.path));
  const hashes = { scientific_review_hash: scientificReviewHash,
    review_bundle_hash: hash({ reviewManifest, outputs: inventoryStamp(output), read_dependencies: readDependencies }),
    output_inventory_hash: hash({ generation, previous_generation: base.generation_id, output: inventoryStamp(output), read_dependencies: readDependencies }) };
  const review = { ok: true, status: reviewManifest.status, reviewManifest, outputInventory: output, hashes, diagnostics: [] };
  records.set(review, { stamp: stamp(review), tools });
  return review;
}

export function assertKnowledgeAdditionReviewCurrent(review) {
  const record = records.get(review);
  if (!record) fail('P22_REVIEW_NOT_OWNED');
  if (stamp(review) !== record.stamp) fail('P22_REVIEW_OUTPUT_INVALIDATED');
  if (hash(record.tools) !== hash(toolHashes())) fail('P22_REVIEW_TOOL_INVALIDATED');
  return review;
}
