import MiniSearch from 'minisearch';
import { createHash } from 'node:crypto';
import { fingerprintV3Json as hash } from './semantic-package-validator.mjs';
import { freezePhase22Value, getReadingBasisContent, assertReadingBasisCurrent } from './phase22-input.mjs';
import { assertFrozenRenderContext } from './phase22-render-context.mjs';
import { assertBilingualParity } from './phase22-parity.mjs';
import { collectLanguageSpans } from './phase22-language.mjs';
import { assertActiveGeneration, assertActiveIndexContract, assertIndexGeneration, assertCommittedSnapshot, verifyIndexPaperBytes,
  INDEX_READER_PROFILE, INDEX_READING_FIRST_PROFILE, verifyReaderPresentation, readerIndexDocuments,
  verifyReadingFirstPresentation, readingFirstIndexDocuments, assertV3SupportBytes } from './phase22-active-version.mjs';
import { getReaderPresentationContent } from './phase221-presentation.mjs';

const fail = (code, details = {}) => { throw Object.assign(new Error(code), { code, details }); };
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const engines = new WeakMap();

function tokenize(text) {
  const tokens = [];
  let word = '';
  const flush = () => { if (word) tokens.push(word.toLowerCase()); word = ''; };
  for (const character of String(text ?? '')) {
    if (/\p{Script=Han}/u.test(character)) { flush(); tokens.push(character); }
    else if (/[\p{L}\p{N}]/u.test(character)) word += character;
    else flush();
  }
  flush();
  return tokens;
}
function engine(index) {
  let search = engines.get(index);
  if (!search) {
    search = new MiniSearch({ fields: ['content', 'aliases', 'title'], tokenize,
      searchOptions: { boost: { content: 2, aliases: 2, title: 1 }, combineWith: 'AND' } });
    search.addAll(index.documents);
    engines.set(index, search);
  }
  return search;
}

function documentFor(paper, language, path, { sectionId, spanId, content, unitIds = [], anchor = null, aliases = '', title = '' }) {
  const identity = { paper_id: paper.paper_id, run_id: paper.run_id, analysis_revision: paper.analysis_revision,
    core_hash: paper.core_hash, pipeline_version: paper.pipeline_version, language, path,
    section_id: sectionId, span_id: spanId, unit_ids: [...new Set(unitIds)], anchor, content, aliases, title };
  return { id: hash({ paper_id: paper.paper_id, run_id: paper.run_id, revision: paper.analysis_revision, language, sectionId, spanId }), ...identity };
}

/**
 * Candidate-only producer. No Wiki scan, publication or read of a previous cache.
 * papers carry admitted basis/context/views/parity + rendered/merged note bytes.
 * files carries all support/asset bytes in the candidate generation.
 */
export function buildBilingualIndex({ validatedInputs, generation } = {}) {
  assertActiveGeneration(generation);
  if (!validatedInputs || !Array.isArray(validatedInputs.papers)) fail('P22_VALIDATED_INPUTS_REQUIRED');
  if (validatedInputs.v2 !== undefined && (!Array.isArray(validatedInputs.v2) || validatedInputs.v2.length)) fail('P22_V3_INPUTS_ONLY');
  const previous = previousInputs(validatedInputs, generation);
  // Existing callers keep the synchronous old-profile API. Reader consumers must await.
  if (generation.papers.some(paper => paper.profile === INDEX_READER_PROFILE)) return buildReaderIndex(validatedInputs, generation, previous);
  return buildIndex(validatedInputs, generation, new Map(), previous);
}

function previousInputs(inputs, generation) {
  if (inputs.previousSnapshot && inputs.previousPrepared) fail('P22_PREVIOUS_INPUT_AMBIGUOUS');
  let previous;
  if (inputs.previousSnapshot) {
    assertCommittedSnapshot(inputs.previousSnapshot);
    previous = inputs.previousSnapshot;
  } else if (inputs.previousPrepared) {
    // A candidate-only base captured in an authenticated publication recipe. It
    // never creates a committed snapshot capability for queries or graph reads.
    previous = inputs.previousPrepared;
    assertActiveGeneration(previous.generation);
    assertIndexGeneration(previous.index, previous.generation);
  }
  if (!previous) return null;
  if (previous.generation.evidence_mode !== generation.evidence_mode) fail('P22_PREVIOUS_EVIDENCE_MODE_CHANGED');
  if (previous.generation.papers.some(paper => !generation.papers.some(row => row.paper_id === paper.paper_id))) fail('P22_PREVIOUS_PAPER_MISSING');
  return previous;
}
function retainedPaper(previous, paper) {
  return previous?.generation.papers.some(row => row.paper_id === paper.paper_id && hash(row) === hash(paper));
}
function fileBytes(inputs, path) {
  const rows = (inputs.files ?? []).filter(row => row.path === path);
  if (rows.length !== 1 || !(rows[0].bytes instanceof Uint8Array)) fail('P22_CANDIDATE_OBJECT_MISSING', { path });
  return Buffer.from(rows[0].bytes);
}
function presentationBytes(inputs, paper) {
  const bytes = fileBytes(inputs, paper.reader_presentation.path);
  return { bytes, manifest: JSON.parse(bytes.toString('utf8')) };
}

async function buildReaderIndex(validatedInputs, generation, previous) {
  const prepared = structuredClone(generation), readers = new Map();
  for (const paper of prepared.papers.filter(row => row.profile === INDEX_READER_PROFILE)) {
    const matches = validatedInputs.papers.filter(input => input.presentation?.manifest.identity.paper_id === paper.paper_id);
    if (!matches.length && retainedPaper(previous, paper)) {
      const { bytes } = presentationBytes(validatedInputs, paper);
      const manifest = verifyReaderPresentation(paper, bytes, prepared);
      const notes = Object.fromEntries(Object.entries(paper.paths).map(([language, path]) => [language, fileBytes(validatedInputs, path)]));
      const readingRecords = Object.values(manifest.targets.reading_records ?? {}).map(row => ({ path: row.path, bytes: fileBytes(validatedInputs, row.path) }));
      readers.set(paper.paper_id, readerIndexDocuments({ paper, presentation: manifest, notes, generation: prepared, readingRecords }));
      continue;
    }
    if (matches.length !== 1) fail('P22_CANDIDATE_PAPER_MISSING', { paper_id: paper.paper_id });
    const { presentation, notes } = matches[0];
    const data = await getReaderPresentationContent(presentation);
    const registered = (validatedInputs.files ?? []).filter(row => row.path === paper.reader_presentation.path);
    if (registered.length !== 1 || sha(registered[0].bytes) !== sha(presentation.presentationBytes)) fail('P221_READER_PRESENTATION_BINDING');
    const manifest = verifyReaderPresentation(paper, registered[0].bytes, prepared);
    if (paper.core_hash !== hash(data.core) || hash(data.identity) !== hash(manifest.identity)) fail('P22_CANDIDATE_IDENTITY_MISMATCH');
    const terminology = { version: data.integrator.ledger_version, terms: [...(data.integrator.terminology_ledger ?? data.integrator.term_candidates)].sort((a, b) => a.term_id.localeCompare(b.term_id)) };
    if (hash(terminology) !== manifest.dependencies.terms || (paper.terminology && hash(paper.terminology) !== hash(terminology))) fail('P221_READER_TERMS_MISMATCH');
    paper.terminology = terminology;
    readers.set(paper.paper_id, readerIndexDocuments({ paper, presentation: manifest, notes, generation: prepared, readingRecords: presentation.readingRecords }));
  }
  return buildIndex(validatedInputs, prepared, readers, previous);
}

function buildIndex(validatedInputs, generation, readers = new Map(), previous) {
  const documents = [], coveredPaths = new Set();
  for (const paper of generation.papers) {
    if (paper.profile === INDEX_READING_FIRST_PROFILE) {
      const matches = validatedInputs.papers.filter(input => input.readingFirst?.identity.paper_id === paper.paper_id);
      if (matches.length > 1 || (!matches.length && !retainedPaper(previous, paper))) fail('P22_CANDIDATE_PAPER_MISSING', { paper_id: paper.paper_id });
      const { bytes } = presentationBytes(validatedInputs, paper), manifest = verifyReadingFirstPresentation(paper, bytes, generation);
      if (matches.length && hash(manifest) !== hash(matches[0].readingFirst)) fail('RF_INDEX_PRESENTATION_MISMATCH');
      const notes = matches[0]?.notes ?? Object.fromEntries(Object.entries(paper.paths).map(([language, path]) => [language, fileBytes(validatedInputs, path)]));
      documents.push(...readingFirstIndexDocuments({ paper, presentation: manifest, notes, generation, files: validatedInputs.files }));
      Object.values(paper.paths).forEach(path => coveredPaths.add(path));
    } else if (paper.profile === INDEX_READER_PROFILE) {
      documents.push(...readers.get(paper.paper_id));
      Object.values(paper.paths).forEach(path => coveredPaths.add(path));
    } else if (paper.pipeline_version === '3.0') {
      const matches = validatedInputs.papers.filter(input => input.basis?.identity.paper_id === paper.paper_id);
      if (!matches.length && retainedPaper(previous, paper)) {
        for (const [language, path] of Object.entries(paper.paths)) {
          const bytes = fileBytes(validatedInputs, path), binding = verifyIndexPaperBytes(paper, language, bytes, generation);
          const priorObject = previous.generation.objects.find(row => row.path === path), object = generation.objects.find(row => row.path === path);
          if (hash(priorObject) !== hash(object)) fail('P22_RETAINED_NOTE_CHANGED', { path });
          const prior = previous.index.documents.filter(row => row.paper_id === paper.paper_id && row.path === path);
          if (binding.regions.some(region => !prior.some(doc => doc.section_id === region.id && doc.span_id === 'section:' + region.id && doc.content === region.content))) fail('P22_RETAINED_INDEX_CHANGED', { path });
          documents.push(...prior.map(row => structuredClone(row))); coveredPaths.add(path);
        }
        continue;
      }
      if (matches.length !== 1) fail('P22_CANDIDATE_PAPER_MISSING', { paper_id: paper.paper_id });
      const { basis, context, views, parity, notes } = matches[0];
      assertReadingBasisCurrent(basis);
      assertFrozenRenderContext(context, basis);
      assertBilingualParity(parity, { basis, context, views });
      if (parity.evidence_mode !== generation.evidence_mode || (generation.evidence_mode === 'actual' && !parity.review_ready)) fail('P22_CANDIDATE_EVIDENCE_MODE');
      if (['paper_id', 'run_id', 'analysis_revision'].some(key => paper[key] !== basis.identity[key])
        || paper.core_hash !== hash(getReadingBasisContent(basis).core)
        || paper.basis_fingerprint !== basis.basis_fingerprint || paper.context_fingerprint !== context.context_fingerprint) fail('P22_CANDIDATE_IDENTITY_MISMATCH');
      const anchors = new Map(context.anchorMappings.map(row => [row.semantic_id, row.anchor]));
      for (const language of ['en', 'zh-CN']) {
        if (!(notes?.[language] instanceof Uint8Array)) fail('P22_CANDIDATE_NOTE_MISSING', { language });
        if (paper.paths[language] !== context.paper_targets[language] || paper.view_fingerprints[language] !== hash(views[language])) fail('P22_CANDIDATE_VIEW_MISMATCH', { language });
        const path = paper.paths[language], binding = verifyIndexPaperBytes(paper, language, Buffer.from(notes[language]), generation);
        const rows = collectLanguageSpans(views[language]);
        for (const { section_id: sectionId, span } of rows) {
          const unitIds = [...span.semantic_refs, ...span.boundary_refs];
          const aliases = context.terminology_ledger.filter(term => span.term_refs.includes(term.term_id)
            || term.definition_unit_refs.some(id => span.semantic_refs.includes(id)))
            .flatMap(term => [term.abbreviation, term.en_full_form, term.zh_full_form ?? '', ...term.aliases.en, ...term.aliases['zh-CN']]).join(' ');
          documents.push(documentFor(paper, language, path, { sectionId, spanId: span.span_id, content: span.text,
            unitIds, anchor: unitIds.map(id => anchors.get(id)).find(Boolean) ?? null, aliases, title: binding.frontmatter.title ?? '' }));
        }
        // Also cover deterministic headings/expanded terms/link labels and all other
        // managed text. Span records remain the precise preferred hit when possible.
        for (const region of binding.regions) {
          const units = rows.filter(row => row.section_id === region.id).flatMap(row => [...row.span.semantic_refs, ...row.span.boundary_refs]);
          documents.push(documentFor(paper, language, path, { sectionId: region.id, spanId: 'section:' + region.id, content: region.content,
            unitIds: units, title: binding.frontmatter.title ?? '' }));
        }
        coveredPaths.add(path);
      }
    }
  }
  for (const object of generation.objects.filter(object => !coveredPaths.has(object.path))) {
    const matches = (validatedInputs.files ?? []).filter(file => file.path === object.path);
    if (matches.length !== 1 || !(matches[0].bytes instanceof Uint8Array) || sha(matches[0].bytes) !== object.sha256) fail('P22_CANDIDATE_OBJECT_MISSING', { path: object.path });
    if (object.kind === 'support') assertV3SupportBytes(matches[0].bytes, object.path);
  }
  documents.sort((a, b) => a.id.localeCompare(b.id));
  // The inventory derives from accepted complete inputs before approval; it is
  // bound by active_fingerprint without a cycle through index file bytes.
  const preparedGeneration = freezePhase22Value({ ...structuredClone(generation),
    index_manifest: documents.map(document => ({ id: document.id, sha256: hash(document) })) });
  const index = { schema_version: 'phase22/active-index-1.0', kind: 'index', generation_id: generation.generation_id,
    evidence_mode: generation.evidence_mode, active_fingerprint: hash(preparedGeneration), documents };
  assertIndexGeneration(index, preparedGeneration);
  freezePhase22Value(index);
  engine(index); // An actual index failure must fail candidate preparation.
  const bytes = Buffer.from(JSON.stringify(index) + '\n');
  return { generation: preparedGeneration, index, bytes, sha256: sha(bytes), manifest: { generation_id: generation.generation_id,
    active_fingerprint: index.active_fingerprint, index_sha256: sha(bytes), document_count: documents.length, evidence_mode: generation.evidence_mode } };
}

export function queryBilingualIndex({ index, activeSnapshot, query } = {}) {
  const observed = assertCommittedSnapshot(activeSnapshot);
  assertActiveIndexContract(index, 'index');
  if (hash(index) !== observed.indexHash) fail('P22_INDEX_STALE');
  assertIndexGeneration(index, activeSnapshot.generation);
  if (typeof query !== 'string') fail('P22_QUERY_INVALID');
  const docs = new Map(index.documents.map(document => [document.id, document]));
  const groups = new Map(), papers = new Map(activeSnapshot.generation.papers.map(paper => [paper.paper_id, paper]));
  for (const match of engine(index).search(query)) {
    const doc = docs.get(match.id), paper = papers.get(doc.paper_id);
    let group = groups.get(doc.paper_id);
    if (!group) {
      group = { paper_id: doc.paper_id, run_id: doc.run_id, analysis_revision: doc.analysis_revision,
        path: paper.paths['zh-CN'], score: match.score, hits: [] };
      groups.set(doc.paper_id, group);
    }
    group.score = Math.max(group.score, match.score);
    group.hits.push({ language: doc.language, section_id: doc.section_id, span_id: doc.span_id,
      ...([INDEX_READER_PROFILE, INDEX_READING_FIRST_PROFILE].includes(doc.profile) ? { anchor_type: doc.anchor_type } : {}),
      ...(doc.entity_id ? { entity_id: doc.entity_id } : {}),
      unit_ids: doc.unit_ids, anchor: doc.anchor, path: doc.path, text: doc.content, score: match.score, matched_terms: match.terms });
  }
  for (const group of groups.values()) group.hits.sort((a, b) =>
    b.score - a.score || Number(a.span_id.startsWith('section:')) - Number(b.span_id.startsWith('section:')) || a.span_id.localeCompare(b.span_id));
  return { generation_id: index.generation_id, evidence_mode: index.evidence_mode,
    scientific_approval: index.evidence_mode === 'actual',
    results: [...groups.values()].sort((a, b) => b.score - a.score || a.paper_id.localeCompare(b.paper_id)) };
}

