import { READING_FIRST_PROFILE, renderReadingFirstNotes } from './reading-first-runtime.mjs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fingerprintV3Json as hash } from './semantic-package-validator.mjs';
import { getHistoricalReaderContent } from './phase221-historical-input.mjs';
import { getReadingBasisContent, getReadingBasisSourceBindings, readPhase22SourceAsset } from './phase22-input.mjs';
import { assertFrozenRenderContext, PHASE22_REGIONS } from './phase22-render-context.mjs';
import { assertBilingualParity, assertReaderBilingualParity } from './phase22-parity.mjs';
import { collectLanguageSpans, getAcceptedReaderLanguageRecord } from './phase22-language.mjs';
import { getReviewedSupportContent, resolveReviewedExpression } from './phase221-reviewed-support.mjs';
import { inspectManagedNote, mergeManagedNote } from './phase22-managed-markdown.mjs';
import { createPhase22ContractValidator } from './phase22-contract-loader.mjs';
import { registerReaderTargets } from './phase221-targets.mjs';
import { displayReaderSpan, readReaderQuantityEquivalence, readerQuantityBindings } from './phase221-display.mjs';
import { buildReaderVisuals } from './phase221-visuals.mjs';
import { resolveReaderSourceAssets } from './phase221-source-assets.mjs';
import { buildReaderResearchMap } from './phase221-research-map.mjs';

export const READER_PROFILE = 'phase22-reader-note-1.0';
const languages = ['en', 'zh-CN'];
const presentations = new WeakMap();
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const fail = (code, details = {}) => { throw Object.assign(new Error(code), { code, details }); };
const titles = {
  en: ['Source', 'Structured Abstract', 'Research Question and Study Design', 'Key Findings', 'Methods, Concepts, and Measures', 'Figures, Tables, and Equations', 'Discussion', 'Limitations', 'Conclusion and Practical Implications', 'Evidence', 'Relation Ledger', 'Coverage Report'],
  'zh-CN': ['来源', '结构化摘要', '研究问题与研究设计', '主要发现', '方法、概念与测量', '图表与公式', '讨论', '局限', '结论与实践含义', '证据', '关系说明', '阅读覆盖与缺项'],
};
const dutyTitles = {
  en: ['Research position', 'Bounded summary', 'Research question', 'Background route', 'Core problem', 'Core idea', 'Method overview', 'Module responsibilities', 'Essential formulas', 'Analysis and claim chain', 'Conclusion boundary', 'Author limitations', 'Critical analysis', 'Transferable insight', 'Knowledge connections', 'Research candidates'],
  'zh-CN': ['研究定位', '有边界的概括', '研究问题', '背景路线', '核心痛点', '核心思路', '方法全貌', '模块职责', '必要公式', '分析与论断链', '结论边界', '作者局限', '批判性分析', '可迁移启示', '知识连接', '研究候选'],
};
const link = (path, label) => `[[${path}|${label}]]`;
// Obsidian attaches plain-paragraph block IDs inline; structured blocks use a separate line.
const blockAnchorSeparator = text => /^(?:>|```|~~~|\$\$|\||[-*+] |\d+\. )/m.test(text) ? '\n\n' : ' ';
const anchorFor = (kind, id) => kind + '-' + hash({ id }).slice(7, 31);
function sourceRef(data, origin, id, raw) {
  let document = 'science', pointer;
  if (origin === 'reader_support') return { document: 'reader_support', path: null, fingerprint: hash(data.reader_support), pointer: '/blocks/' + data.reader_support.blocks.indexOf(raw) };
  if (origin === 'obligation') pointer = '/reading_card/items/' + data.reading_card.items.findIndex(row => row.obligation_id === id);
  else if (origin === 'core') pointer = '/core/units/' + data.core.units.findIndex(row => row.unit_id === id);
  else if (origin === 'evidence') pointer = '/core/evidence/' + data.core.evidence.findIndex(row => row.evidence_id === id);
  else if (origin === 'required_manifest') pointer = '/scientific_details/required_semantic_units/' + data.science.scientific_details.required_semantic_units.findIndex(row => (row.semantic_unit_id ?? row.unit_id) === id);
  else if (origin === 'asset') {
    document = 'source_presentation'; pointer = '/assets/' + data.source_presentation.assets.findIndex(row => 'asset:' + row.asset_id === id);
  } else if (origin === 'basis_boundary') {
    document = 'qualification'; pointer = '/' + id.slice('basis:'.length);
    if (id === 'basis:important_disagreements' && data.producer && Object.hasOwn(data.producer, 'important_disagreements')) document = 'producer';
    // Missing original boundary data is recorded as a gap, never attributed to invented source bytes.
    if (!Object.hasOwn(data.qualification, id.slice('basis:'.length))) return { document, path: null, fingerprint: hash(data.qualification), pointer: null };
  } else pointer = '/scientific_details/' + origin + '/' + data.science.scientific_details[origin].indexOf(raw);
  if (pointer.endsWith('/-1')) fail('P221_SOURCE_POINTER_INVALID', { id });
  return { document, path: document === 'science' ? data.science_ref?.path ?? null : document === 'source_presentation' ? data.source_presentation.manifest_ref?.path ?? null : document === 'producer' ? data.producer_ref?.path ?? null : null,
    fingerprint: hash(data[document]), pointer };
}
function checkedText(value) {
  if (typeof value !== 'string') fail('P221_TEXT_REQUIRED');
  if (/<!--\s*AUTO|^---\s*$|^## (?:Personal Notes|个人备注|个人笔记)\s*$/m.test(value)) fail('P22_RENDER_MARKER_INJECTION');
  if (/(?:\]\(\s*|\[\[\s*|<\s*)(?:javascript|data|vbscript|file):/i.test(value) || /<\/?(?:script|iframe|style)\b/i.test(value)) fail('P22_UNSAFE_LINK');
  return value;
}
function label(value) { return checkedText(value).replace(/[\r\n|\[\]]/g, ' '); }
export function readerStateMessage({ state, language, reason, scope }) {
  const zh = language === 'zh-CN';
  if (!languages.includes(language)) fail('P221_LANGUAGE_INVALID');
  if (state === 'no_candidate') return zh ? '未形成通过条件的研究候选。' : 'No research candidate met the required conditions.';
  if (state === 'broken_source') return zh ? '无法打开此来源或图像。请从“来源”核对已登记文件；此项暂不算导航通过。'
    : 'This source or image could not be opened. Check the registered file under Source; this navigation remains unverified.';
  if (!reason?.trim()) fail('P221_READER_STATE_REASON_REQUIRED');
  const value = label(reason);
  if (state === 'not_applicable') return zh ? `不适用：${value}。` : `Not applicable: ${value}.`;
  if (state === 'not_assessable') return zh ? `现有材料不足以评估：${value}。` : `Available material does not support assessment: ${value}.`;
  if (state === 'missing_asset') return zh ? `尚无可显示的图表；${value}。查看原文位置。` : `The visual is not available for display: ${value}. Open its source location.`;
  if (state === 'partial' && scope?.trim()) return zh ? `当前阅读范围：${label(scope)}；未解决：${value}。` : `Current reading scope: ${label(scope)}. Unresolved: ${value}.`;
  fail('P221_READER_STATE_INVALID');
}
function freeze(value) {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function resourceFingerprint(output) {
  return hash({ assets: output.assets.map(row => ({ path: row.target_path, sha256: sha(row.bytes) })),
    records: output.readingRecords.map(row => ({ path: row.target_path, sha256: sha(row.bytes) })),
    support: output.supportNotes.map(row => ({ path: row.target_path ?? row.path, sha256: row.bytes ? sha(row.bytes) : row.byte_sha256 })),
    stylesheet: output.stylesheet ? { path: output.stylesheet.path, sha256: sha(output.stylesheet.bytes) } : null });
}

function checkAbstract(contract, data) {
  if (contract === undefined) return null;
  if (!['source_structured', 'analyst_summary'].includes(contract?.mode)
    || !languages.includes(contract.source_language) || !['available', 'missing'].includes(contract.source_status)
    || !Array.isArray(contract.source_structure)) fail('P221_ABSTRACT_CONTRACT_INVALID');
  if (contract.mode === 'analyst_summary' && contract.source_structure.length) fail('P221_ABSTRACT_MODE_CONFLICT');
  if (contract.mode === 'source_structured' && (contract.source_status !== 'available' || !contract.source_structure.length)) fail('P221_ABSTRACT_SOURCE_MISSING');
  if (!['structured', 'unstructured', 'unknown'].includes(contract.source_structure_status)
    || !['complete', 'partial', 'unknown'].includes(contract.source_completeness)) fail('P221_ABSTRACT_QUALIFICATION_REQUIRED');
  if (contract.mode === 'source_structured' && (contract.source_structure_status !== 'structured' || contract.source_completeness !== 'complete')) fail('P221_ABSTRACT_SOURCE_INCOMPLETE');
  if (contract.mode === 'analyst_summary' && contract.source_structure_status === 'structured') fail('P221_ABSTRACT_MODE_CONFLICT');
  if ((contract.source_status === 'missing' || contract.source_completeness !== 'complete') && (typeof contract.reason !== 'string' || !contract.reason.trim())) fail('P221_ABSTRACT_GAP_REQUIRED');
  const sourceSlice = ref => {
    const block = data.science.scientific_details.source_blocks.find(row => row.source_block_id === ref?.source_block_id);
    if (!block || !Number.isInteger(ref.start) || !Number.isInteger(ref.end) || ref.start < 0 || ref.end <= ref.start
      || block.text.slice(ref.start, ref.end) !== ref.text) fail('P221_ABSTRACT_SOURCE_RANGE_INVALID');
    return ref.text;
  };
  for (const item of contract.source_structure) {
    if (typeof item.label !== 'string' || !item.label.trim() || /^(?:abstract|摘要)\s*[:：]?$/i.test(item.label.trim()) || !sourceSlice(item.source).startsWith(item.label)) fail('P221_ABSTRACT_LABEL_INVALID');
  }
  for (const language of languages) {
    const rows = collectLanguageSpans(data.views[language]), paragraphs = contract.paragraphs?.[language], summary = contract.sr02_span_ids?.[language];
    if (!Array.isArray(paragraphs) || !paragraphs.length || !Array.isArray(summary) || !summary.length) fail('P221_ABSTRACT_PARAGRAPHS_REQUIRED');
    const bound = id => rows.find(row => row.span.span_id === id);
    if (summary.some(id => !bound(id) || !bound(id).span.applicability_refs.includes('SR-02'))) fail('P221_ABSTRACT_SR02_INVALID');
    const used = new Set();
    for (const [index, paragraph] of paragraphs.entries()) {
      if (!Array.isArray(paragraph.span_ids) || !paragraph.span_ids.length || paragraph.span_ids.some(id => used.has(id) || summary.includes(id) || bound(id)?.section_id !== 'abstract')) fail('P221_ABSTRACT_PARAGRAPH_INVALID');
      paragraph.span_ids.forEach(id => used.add(id));
      if (contract.mode === 'source_structured') {
        if (paragraphs.length !== contract.source_structure.length || paragraph.source_label !== contract.source_structure[index].label) fail('P221_ABSTRACT_ORDER_INVALID');
        if (language === contract.source_language) {
          if (paragraph.attribution !== 'author_original' || paragraph.span_ids.map(id => bound(id).span.text).join('') !== contract.source_structure[index].source.text) fail('P221_ABSTRACT_ORIGINAL_CHANGED');
        } else if (paragraph.attribution !== 'faithful_translation') fail('P221_ABSTRACT_ATTRIBUTION_INVALID');
      } else if (paragraph.attribution !== 'analyst_summary' || typeof contract.reason !== 'string' || !contract.reason.trim()) fail('P221_ABSTRACT_ATTRIBUTION_INVALID');
    }
    const actual = rows.filter(row => row.section_id === 'abstract' && !summary.includes(row.span.span_id)).map(row => row.span.span_id);
    if (JSON.stringify(actual) !== JSON.stringify(paragraphs.flatMap(row => row.span_ids))) fail('P221_ABSTRACT_UNDECLARED_CONTENT');
  }
  return structuredClone(contract);
}

/** Only actual renderer outputs can provide review authority. Re-read upstream evidence on every use. */
export async function getReaderPresentationContent(presentation) {
  const state = presentations.get(presentation);
  if (!state) fail('P221_PRESENTATION_CAPABILITY_REQUIRED');
  if (hash({ manifest: presentation.manifest, visualInput: presentation.visualInput, derivationRecords: presentation.derivationRecords, abstractContract: presentation.abstractContract }) !== state.fingerprint
    || sha(presentation.en) !== state.notes.en || sha(presentation.zhCN) !== state.notes['zh-CN']
    || sha(presentation.presentationBytes) !== state.sidecar) fail('P221_PRESENTATION_CHANGED');
  if (resourceFingerprint(presentation) !== state.resources) fail('P221_PRESENTATION_RESOURCE_CHANGED');
  const data = await readInput(state.input);
  if (hash(data.dependencies) !== state.dependencies) fail('P221_PRESENTATION_INPUT_CHANGED');
  if (state.quantityEquivalence) await readReaderQuantityEquivalence({ capability: state.quantityEquivalence, input: state.input });
  for (const [name, expected] of Object.entries(presentation.manifest.dependencies.reader_tools)) {
    if (sha(await readFile(new URL(name, import.meta.url))) !== expected) fail('P221_PRESENTATION_TOOL_CHANGED');
  }
  return data;
}

/** Historical capabilities never enter current basis/view/parity WeakMaps. */
async function readInput(input) {
  if (input?.schema_version === 'phase221-historical-reader-input-1.0') {
    const data = await getHistoricalReaderContent(input);
    return { ...data, qualification: { ...data.qualification, ...(Object.hasOwn(data.producer, 'important_disagreements') ? { important_disagreements: data.producer.important_disagreements } : {}) }, dependencies: { basis: data.original_review.basis_fingerprint, context: data.original_review.context_fingerprint,
      science: hash(data.science), terms: hash({ version: data.integrator.ledger_version, terms: [...data.integrator.term_candidates].sort((a, b) => a.term_id.localeCompare(b.term_id)) }), views: Object.fromEntries(languages.map(l => [l, hash(data.views[l])])), parity: data.original_review.parity_fingerprint, registration: data.registration.bundle.sha256 },
    assets: (data.source_presentation?.assets ?? []).map(a => ({ ...a, bytes: Buffer.from(data.original_outputs.find(row => row.kind === 'asset' && row.path === a.target_path).bytes_base64, 'base64') })), supportNotes: data.original_outputs.filter(row => row.kind === 'support').map(row => ({ ...row, target_path: row.path, bytes: Buffer.from(row.bytes_base64, 'base64') })) };
  }
  if (!input?.basis || !input.context || !input.views || !input.parity) fail('P221_READER_INPUT_REQUIRED');
  const currentReader = input.mode === 'reader';
  (currentReader ? assertReaderBilingualParity : assertBilingualParity)(input.parity, input);
  const metadata = currentReader ? languages.map(language => getAcceptedReaderLanguageRecord(input.views[language])) : [];
  if (currentReader && metadata[0].reviewed_support !== metadata[1].reviewed_support) fail('P221_REVIEWED_SUPPORT_BINDING_INVALID');
  const reviewedSupport = metadata[0]?.reviewed_support;
  const readerSupport = reviewedSupport ? getReviewedSupportContent(reviewedSupport) : undefined;
  assertFrozenRenderContext(input.context, input.basis);
  const science = getReadingBasisContent(input.basis);
  const currentSourceBindings = getReadingBasisSourceBindings(input.basis);
  const boundRef = ref => {
    const binding = currentSourceBindings.find(row => row.artifact_id === ref?.artifact_id && row.sha256 === ref.physical_sha256);
    if (!binding) fail('P221_SOURCE_BINDING_REQUIRED');
    return { ...ref, path: binding.path };
  };
  const scientificInputRef = boundRef(input.basis.scientific_input_ref), producerRef = boundRef(input.basis.producer_ref);
  const historicalSources = input.historicalSourceInput ? await getHistoricalReaderContent(input.historicalSourceInput) : null;
  if (historicalSources && (hash(historicalSources.science.source_package) !== hash(science.source_package)
    || hash(historicalSources.science.scientific_details.source_blocks) !== hash(science.scientific_details.source_blocks))) fail('P221_HISTORICAL_SOURCE_SCOPE_MISMATCH');
  const sourceBindings = new Map();
  for (const binding of [...(historicalSources?.source_bindings ?? []), ...currentSourceBindings]) {
    if (sourceBindings.has(binding.path) && sourceBindings.get(binding.path).sha256 !== binding.sha256) fail('P221_SOURCE_BINDING_CONFLICT');
    sourceBindings.set(binding.path, binding);
  }
  const { renderBilingualNotes, renderPhase22SupportNotes } = await import('./phase22-render.mjs');
  const previous = currentReader ? { supportNotes: renderPhase22SupportNotes(input.context, input.views, input.context.existingSupportRefs) }
    : renderBilingualNotes({ ...input, renderingProfile: 'phase22-managed-note-1.0' });
  return { identity: input.basis.identity, science, core: science.core, reading_card: science.reading_card,
    required_manifest: input.basis.required_semantic_units, views: input.views, integrator: input.context, parity: input.parity,
    qualification: { scientific_completeness: input.basis.scientific_completeness, source_status: input.basis.source_status, parser_evaluation_disposition: input.basis.parser_evaluation_disposition, provenance_limits: input.basis.provenance_limits, important_disagreements: input.basis.important_disagreements, evidence_mode: input.parity.evidence_mode },
    source_presentation: input.basis.source_presentation,
    source_bindings: [...sourceBindings.values()],
    scientific_input_ref: scientificInputRef, science_ref: scientificInputRef, producer_ref: producerRef,
    assets: (input.basis.source_presentation?.assets ?? []).map(a => readPhase22SourceAsset(input.basis, a.asset_id)),
    supportNotes: previous.supportNotes,
    ...(readerSupport ? { reader_support: readerSupport, reviewed_support: reviewedSupport } : {}),
    dependencies: { basis: input.basis.basis_fingerprint, context: input.context.context_fingerprint, science: hash(science), terms: input.context.terms_fingerprint, views: Object.fromEntries(languages.map(l => [l, hash(input.views[l])])), parity: input.parity.parity_fingerprint,
      ...(readerSupport ? { reviewed_support: readerSupport.support_fingerprint } : {}),
      ...(historicalSources ? { registration: historicalSources.registration.bundle.sha256 } : {}) } };
}

function recordsFor(data) {
  const details = data.science.scientific_details, records = new Map();
  const add = (id, origin, raw, refs = [id], duty) => {
    if (!id) fail('P221_RECORD_ID_REQUIRED');
    if (records.has(id)) { records.get(id).origins.push(origin); return; }
    records.set(id, { id, origins: [origin], applicability: { status: ['not_applicable', 'not_assessable'].includes(raw.status) ? raw.status : 'assessed', reason: raw.reason || 'Bound to the supplied qualified scientific input; presentation quality is not assessed.' },
      source_basis: sourceRef(data, origin, id, raw), refs, ...(duty ? { obligation_id: duty } : {}), expressions: { en: [], 'zh-CN': [] }, quality: 'not_run', raw });
  };
  for (let i = 1; i <= 16; i++) {
    const id = 'SR-' + String(i).padStart(2, '0'), card = data.reading_card?.items?.find(x => x.obligation_id === id);
    const related = details.records.filter(x => x.obligation_id === id);
    if (!card || !related.length) fail('P221_OBLIGATIONS_INCOMPLETE', { id });
    // Reading-card core links can be shared by all sixteen duties. Only the
    // duty's scientific record identifies its actual explanatory expression.
    add(id, 'obligation', card, related.map(x => x.semantic_unit_id), id);
  }
  for (const row of data.core.units) add(row.unit_id, 'core', row);
  const required = Array.isArray(data.required_manifest) ? data.required_manifest : data.required_manifest?.required_semantic_units ?? data.required_manifest?.units ?? data.required_manifest?.items;
  if (!Array.isArray(required)) fail('P221_REQUIRED_MANIFEST_MISSING');
  for (const row of required) add(row.semantic_unit_id ?? row.unit_id, 'required_manifest', row);
  for (const [collection, key] of [['records', 'semantic_unit_id'], ['claims', 'claim_id'], ['quantities', 'quantity_id'], ['statements', 'statement_id'], ['explanations', 'explanation_id'], ['research_candidates', 'candidate_id'], ['inventory', 'inventory_id'], ['source_blocks', 'source_block_id']]) {
    for (const row of details[collection] ?? []) add(row[key], collection, row, [row[key], ...(row.affected_ids ?? [])]);
  }
  for (const row of data.core.evidence) add(row.evidence_id, 'evidence', row);
  for (const row of data.source_presentation?.assets ?? []) add('asset:' + row.asset_id, 'asset', row);
  for (const boundary of ['source_status', 'parser_evaluation_disposition', 'provenance_limits', 'important_disagreements']) add('basis:' + boundary, 'basis_boundary', data.qualification[boundary] ?? {});
  for (const block of data.reader_support?.blocks ?? []) add(block.support_id, 'reader_support', block);
  return [...records.values()];
}

function spanPayload(span, data) {
  checkedText(span.text);
  if (span.immutable_ref?.authority === 'reviewed_expression') {
    if (span.kind !== 'formula' || resolveReviewedExpression(data.reviewed_support, { language: data.render_language, ref: span.immutable_ref }) !== span.text) fail('P22_IMMUTABLE_VALUE_MISMATCH');
    return span.text;
  }
  if (span.kind === 'asset') {
    const asset = data.assets.find(a => a.asset_id === span.immutable_ref?.id);
    if (!asset || asset.target_path !== span.text || span.asset_refs?.length !== 1 || span.asset_refs[0] !== asset.asset_id) fail('P22_ASSET_REFERENCE_INVALID');
    return `![[${asset.target_path}]]`;
  }
  if (span.kind === 'formula' || span.kind === 'code') {
    const ref = span.immutable_ref, entry = data.source_presentation?.immutable_ranges.find(r => r.classification_id === ref?.classification_id);
    const block = data.science.scientific_details.source_blocks.find(r => r.source_block_id === ref?.id);
    if (!entry || entry.kind !== span.kind || entry.start !== ref.start || entry.end !== ref.end || !block || block.text.slice(ref.start, ref.end) !== span.text) fail('P22_IMMUTABLE_VALUE_MISMATCH');
    if (span.kind === 'formula') return '$$\n' + span.text + '\n$$';
    const fence = '`'.repeat(Math.max(3, ...[...span.text.matchAll(/`+/g)].map(x => x[0].length + 1)));
    return fence + '\n' + span.text + '\n' + fence;
  }
  if (/!\[\[|!\[[^\]]*\]\(/.test(span.text)) fail('P22_ASSET_CONTRACT_REQUIRED');
  return span.text;
}

function selectSharedExplanations(selection, data, records, paperTargets) {
  if (selection === undefined) return { notes: data.supportNotes, removed: {} };
  if (!Array.isArray(selection) || !selection.length) fail('P221_SHARED_SELECTION_INVALID');
  const pairs = new Map(), bindings = [], removed = Object.fromEntries(languages.map(language => [language, new Set()]));
  const details = data.science.scientific_details;
  const supportedRows = Object.values(details).filter(Array.isArray).flat();
  const sourceRefsFor = span => [...new Set(span.semantic_refs.flatMap(id => supportedRows.filter(item => item && Object.entries(item).some(([key, value]) => /_id$/.test(key) && value === id)).flatMap(item => item.source_block_ids ?? [])))];
  for (const row of selection) {
    if (!row || Object.keys(row).some(key => !['entity_id', 'language', 'span_ids', 'support_only_span_ids'].includes(key))
      || !languages.includes(row.language) || !Array.isArray(row.span_ids) || !row.span_ids.length || !Array.isArray(row.support_only_span_ids)
      || [...row.span_ids, ...row.support_only_span_ids].some(id => typeof id !== 'string' || !id.trim())
      || new Set(row.span_ids).size !== row.span_ids.length || new Set(row.support_only_span_ids).size !== row.support_only_span_ids.length
      || row.support_only_span_ids.some(id => !row.span_ids.includes(id))) fail('P221_SHARED_SELECTION_INVALID');
    const entity = data.supportNotes.find(entity => entity.entity_id === row.entity_id), key = row.entity_id + ':' + row.language;
    if (!entity || pairs.has(key)) fail('P221_SHARED_SELECTION_INVALID');
    if (entity.disposition === 'reuse' || !entity.bytes) fail('P221_SHARED_EXISTING_UPDATE_UNSUPPORTED');
    const spans = collectLanguageSpans(data.views[row.language]).map(row => row.span);
    const selected = row.span_ids.map(id => spans.find(span => span.span_id === id));
    if (selected.some(span => !span || span.kind !== 'analysis' || !span.semantic_refs?.length)
      || entity.definition_unit_refs.some(id => !selected.some(span => span.semantic_refs.includes(id)))) fail('P221_SHARED_SELECTION_INVALID');
    for (const span of selected) {
      const sourceIds = sourceRefsFor(span), evidenceIds = span.evidence_refs ?? [];
      if ((!evidenceIds.length && !sourceIds.length) || sourceIds.some(id => !details.source_blocks.some(block => block.source_block_id === id))
        || evidenceIds.some(id => !data.core.evidence.some(evidence => evidence.evidence_id === id))) fail('P221_SHARED_SOURCE_REQUIRED');
      bindings.push({ entity_id: row.entity_id, language: row.language, span_id: span.span_id, source_block_ids: sourceIds, evidence_ids: [...evidenceIds] });
      checkedText(span.text);
    }
    pairs.set(key, selected);
    for (const id of row.support_only_span_ids) removed[row.language].add(id);
  }
  for (const entity of data.supportNotes) for (const language of languages) if (!pairs.has(entity.entity_id + ':' + language)) fail('P221_SHARED_SELECTION_INVALID');
  // A support document cannot substitute for any previously expressed paper obligation or scientific record.
  for (const language of languages) {
    const rows = collectLanguageSpans(data.views[language]);
    const refs = span => [...(span.semantic_refs ?? []), ...(span.boundary_refs ?? []), ...(span.claim_refs ?? []), ...(span.evidence_refs ?? []), ...(span.quantity_refs ?? []), ...(span.applicability_refs ?? [])];
    for (const record of records) {
      const matches = rows.filter(row => refs(row.span).some(ref => record.refs.includes(ref)));
      if (matches.length && matches.every(row => removed[language].has(row.span.span_id))) fail('P221_SHARED_PAPER_EXPRESSION_REQUIRED', { language, id: record.id });
    }
  }
  const notes = data.supportNotes.map(entity => {
    const definitions = Object.fromEntries(languages.map(language => [language, pairs.get(entity.entity_id + ':' + language).map(span => {
      const binding = bindings.find(row => row.entity_id === entity.entity_id && row.language === language && row.span_id === span.span_id);
      return span.text + '\n\n' + link(paperTargets[language], language === 'en' ? 'Paper application and attribution' : '本篇应用与归属')
        + '\n\n' + (language === 'en' ? 'Selected passage sources: ' : '所选段落来源：') + [...binding.source_block_ids, ...binding.evidence_ids].map(label).join(' · ');
    }).join('\n\n')]));
    const original = entity.bytes.toString('utf8'), from = original.indexOf('## Definition (English)\n\n'), to = original.indexOf('## Scope / 适用范围\n\n');
    if (from < 0 || to <= from) fail('P221_SHARED_NOTE_FORMAT_INVALID');
    const bytes = Buffer.from(original.slice(0, from) + '## Definition (English)\n\n' + definitions.en + '\n\n## 中文定义\n\n' + definitions['zh-CN'] + '\n\n' + original.slice(to));
    return { ...entity, bytes, byte_sha256: sha(bytes) };
  });
  return { notes, removed, bindings };
}

/** Pure render -> managed merge -> final UTF-8 mapping. No filesystem writes. */
export async function renderReaderNotes({ input, targetRegistry, existingTargets = [], presentationOptions = {} } = {}) {
  if (input?.profile === READING_FIRST_PROFILE) return renderReadingFirstNotes({controller:input.controller, targetRegistry, existingTargets, knowledgeRegistry:presentationOptions.knowledgeRegistry ?? []});
  if (presentationOptions.profile && presentationOptions.profile !== READER_PROFILE) fail('P221_PROFILE_UNKNOWN');
  const data = await readInput(input);
  const abstractContract = checkAbstract(presentationOptions.abstractContract, data);
  const quantityEquivalence = presentationOptions.quantityEquivalence === undefined ? undefined
    : await readReaderQuantityEquivalence({ capability: presentationOptions.quantityEquivalence, input });
  const terms = data.integrator.terminology_ledger ?? data.integrator.term_candidates;
  if (!targetRegistry || targetRegistry.paper_id !== data.identity.paper_id) fail('P221_TARGET_IDENTITY_MISMATCH');
  registerReaderTargets({ identity: data.identity, existingRegistry: targetRegistry, occupiedPaths: existingTargets.map(x => x.path) });
  const registry = targetRegistry, records = recordsFor(data), ranges = [], navigation = [], gaps = [], visualExpressions = [];
  if (presentationOptions.auditDisplay !== undefined && presentationOptions.auditDisplay !== 'compact') fail('P221_AUDIT_DISPLAY_INVALID');
  const compact = presentationOptions.auditDisplay === 'compact';
  const shared = selectSharedExplanations(presentationOptions.sharedExplanations, data, records, registry.paper_targets);
  const researchMap = presentationOptions.researchMap === undefined ? null : buildReaderResearchMap({ researchMap: presentationOptions.researchMap, views: data.views, paperTargets: registry.paper_targets });
  if (researchMap) for (const language of languages) {
    const mapped = researchMap.map.steps.flatMap(step => [...step.design_span_ids[language], ...step.finding_span_ids[language]]);
    if (mapped.some(id => shared.removed[language]?.has(id)) || researchMap.map.lanes?.some(lane => shared.removed[language]?.has(lane.labels[language].span_id))) fail('P221_MAP_PAPER_EXPRESSION_REQUIRED');
  }
  const mapRanges = [], auditDetails = {};
  const title = checkedText(data.science.source_package.paper_label);
  if (!title.trim() || /[\r\n]/.test(title)) fail('P221_TITLE_REQUIRED');
  const bibliography = presentationOptions.bibliography ?? {};
  if (bibliography.title && bibliography.title !== title) fail('P221_TITLE_NOT_BOUND');
  const manifestPath = `.apa-v3/phase221/presentation/${registry.discriminator}.json`;
  const recordPaths = Object.fromEntries(languages.map(language => [language, `Reading Records/${registry.human_slug}--${registry.discriminator}.${language}.md`]));
  const blocks = data.science.scientific_details.source_blocks;
  const registeredAssets = data.assets.map(asset => ({ ...asset, source_ref: asset.source_ref ?? {
    source_document_id: asset.source_document_id, source_hash: asset.source_hash, source_block_ids: asset.source_block_ids,
    evidence_ids: asset.evidence_ids, locators: blocks.filter(block => asset.source_block_ids.includes(block.source_block_id)) } }));
  const requestedInventory = data.science.scientific_details.inventory.filter(row => (row.kind !== 'essential_formula' || presentationOptions.visualUnits?.some(unit => unit.inventory_id === row.inventory_id && Object.hasOwn(unit, 'source_page_groups'))) && !presentationOptions.visualUnits?.some(unit => unit.inventory_id === row.inventory_id && Object.hasOwn(unit, 'table_grid'))).map(row => {
    const source_locations = blocks.filter(block => row.source_block_ids.includes(block.source_block_id));
    const available = source_locations.length && source_locations.every(block => data.science.source_package.source_documents.some(document => document.source_document_id === block.source_document_id && document.included && document.support_status === 'supported'));
    const mapping = presentationOptions.visualUnits?.find(unit => unit.inventory_id === row.inventory_id);
    const sourcePages = mapping && Object.hasOwn(mapping, 'source_page_groups');
    const evidence_ids = sourcePages ? [...new Set([...(row.evidence_ids ?? []), ...data.core.evidence.filter(evidence => source_locations.some(block => {
      const locator = block.native_locator ?? block;
      return evidence.locator.source_document_id === block.source_document_id && evidence.locator.source_hash === block.source_hash
        && evidence.locator.block_id === locator.block_id && evidence.locator.page_index === locator.page_index;
    })).map(evidence => evidence.evidence_id)])] : row.evidence_ids;
    return { ...row, source_locations, ...(sourcePages ? { source_page_groups: mapping.source_page_groups, evidence_ids } : {}), availability: available ? 'available' : 'not_assessable', ...(mapping && Object.hasOwn(mapping, 'asset_ids') ? { asset_ids: mapping.asset_ids } : {}), ...(mapping?.asset_id ? { asset_refs: [mapping.asset_id] } : {}) };
  });
  const sourceAssets = resolveReaderSourceAssets({ registeredAssets, requestedInventory, derivationRecords: presentationOptions.derivationRecords ?? [] });
  const visuals = buildReaderVisuals({ input: data, manifest: { visualUnits: presentationOptions.visualUnits ?? [] }, targetRegistry: registry, assets: sourceAssets });
  gaps.push(...visuals.gaps, ...sourceAssets.gaps.map(row => ({ id: row.code + ':' + row.inventory_id, kind: row.status === 'partial' ? 'source_unavailable' : 'not_displayed', reason: row.reason, impact: row.action, owner: 'Plan08' })));
  navigation.push(...visuals.navigation);
  const stylesheet = presentationOptions.localStyle === true ? { path: 'Templates/apa-v3/apa-readable.css', bytes: await readFile(new URL('../../Templates/apa-v3/apa-readable.css', import.meta.url)) } : null;
  const output = { paper_targets: registry.paper_targets, supportNotes: shared.notes, assets: data.assets, review: { completeness: 'not_run', readability: 'not_run', native_presentation: 'not_run' } };
  output.visualInput = structuredClone(presentationOptions.visualUnits ?? []);
  output.derivationRecords = structuredClone(presentationOptions.derivationRecords ?? []);
  output.visualBindings = visuals.bindings;
  output.sourceAssets = sourceAssets.records;
  output.stylesheet = stylesheet;
  output.abstractContract = abstractContract;
  if (researchMap) output.researchMap = researchMap;
  if (compact) output.auditDisplay = 'compact';
  if (presentationOptions.sharedExplanations !== undefined) output.sharedExplanations = structuredClone(presentationOptions.sharedExplanations);
  const noteTargets = {};
  for (const language of languages) {
    const headings = titles[language], other = language === 'en' ? 'zh-CN' : 'en';
    const view = data.views[language];
    if (!view || PHASE22_REGIONS.some(id => !view.sections.some(section => section.section_id === id))) fail('P221_SECTIONS_INCOMPLETE');
    const rows = collectLanguageSpans(view).filter(row => !shared.removed[language]?.has(row.span.span_id)), local = [], seen = new Set();
    auditDetails[language] = '';
    const relocatedVisualSpans = new Set(visuals.fragments[language].flatMap(fragment => fragment.relocated_span_ids));
    if (!rows.length) fail('P221_CONTENT_REQUIRED');
    const sections = Object.fromEntries(PHASE22_REGIONS.map(id => [id, []]));
    // Preserve supplied sections; only the fixture/controlled Writer chooses narrative placement.
    for (const row of rows) sections[row.section_id].push(row);
    let draft = `---\ntype: paper\npipeline_version: '3.0'\nrendering_profile: ${READER_PROFILE}\nlanguage: ${language}\ngraph_scope: v3-candidate\n---\n\n`;
    if (stylesheet && !existingTargets.some(row => row.path === registry.paper_targets[language] && row.bytes)) draft = draft.replace('graph_scope: v3-candidate\n', 'graph_scope: v3-candidate\ncssclasses: [apa-readable]\n');
    for (const [index, section] of PHASE22_REGIONS.entries()) {
      draft += `<!-- AUTO:START ${section} -->\n`;
      if (section === 'source') draft += '# ' + title + '\n\n';
      if (!compact || index < 9) draft += '## ' + headings[index] + '\n\n';
      else draft += '^' + anchorFor('audit', section) + '\n\n';
      if (section === 'study-design' && researchMap) draft += researchMap.fragments[language] + '\n\n';
      if (section === 'source') {
        if (data.qualification.evidence_mode === 'synthetic') draft += language === 'en' ? '**Synthetic layout example — unaccepted; this is not a real-paper scientific analysis.**\n\n' : '**合成布局示例，尚未验收；不是实际论文科学分析。**\n\n';
        const citation = [bibliography.first_author, bibliography.year, bibliography.journal].filter(x => x !== undefined).map(x => label(String(x))).join(' · ');
        if (citation) draft += citation + '\n\n';
        for (const document of data.science.source_package.source_documents) draft += label(document.source_label) + '\n\n';
        draft += link(compact ? recordPaths[language] + '#' + headings[9] : '#' + headings[9], language === 'en' ? 'Read the registered source passages' : '查看已登记来源摘录') + '\n\n';
        for (const key of ['doi', 'pmid']) if (data.science.source_package[key]) draft += key.toUpperCase() + ': ' + label(data.science.source_package[key]) + '\n\n';
        const quick = [[registry.paper_targets[other], language === 'en' ? 'Read Chinese version' : '阅读英文版'], ['#' + headings[2], language === 'en' ? 'Read the research logic' : '查看研究逻辑'], ['#' + headings[4], language === 'en' ? 'Understand key methods' : '理解关键方法']];
        draft += quick.map(([path, text]) => link(path, text)).join(' · ') + '\n\n';
        navigation.push(...quick.map(([target, text]) => ({ language, kind: 'quick', target, label: text })));
        draft += '> [!note]- ' + (language === 'en' ? 'Contents' : '全文目录') + '\n' + [...headings.slice(1, compact ? 9 : undefined), language === 'en' ? 'Personal Notes' : '个人笔记'].map(h => '> - ' + link('#' + h, h)).join('\n') + '\n\n';
      }
      for (const row of sections[section]) {
        const abstractParagraph = abstractContract?.paragraphs[language].find(paragraph => paragraph.span_ids[0] === row.span.span_id);
        if (abstractParagraph) draft += (language === 'en' ? abstractParagraph.attribution === 'author_original' ? '**Author abstract — original text**' : abstractParagraph.attribution === 'faithful_translation' ? '**Author abstract — faithful translation**' : '**Analyst summary**'
          : abstractParagraph.attribution === 'author_original' ? '**作者摘要——原文**' : abstractParagraph.attribution === 'faithful_translation' ? '**作者摘要——忠实翻译**' : '**整理摘要——分析者归纳**') + '\n\n';
        if (abstractContract?.sr02_span_ids[language][0] === row.span.span_id) draft += (language === 'en' ? '**Reading summary — analyst synthesis**' : '**阅读概括——分析者整理**') + '\n\n';
        const quantityBindings = quantityEquivalence === undefined ? undefined : readerQuantityBindings({ capability: quantityEquivalence, language, sectionId: section, paragraphId: row.paragraph_id, span: row.span });
        const originalAbstract = abstractContract?.mode === 'source_structured' && language === abstractContract.source_language && abstractContract.paragraphs[language].some(paragraph => paragraph.span_ids.includes(row.span.span_id));
        const display = originalAbstract || row.span.support_refs?.length ? { text: row.span.text, transforms: [], issues: [] } : displayReaderSpan({ span: row.span, sectionId: section, language, terms, quantityBindings, seen });
        const payload = spanPayload({ ...row.span, text: display.text }, { ...data, render_language: language });
        const relocatedDisplay = visuals.fragments[language].find(fragment => fragment.relocated_displays?.[row.span.span_id])?.relocated_displays[row.span.span_id];
        const text = relocatedDisplay ?? payload, anchor = anchorFor('p', row.span.span_id);
        for (const issue of display.issues) gaps.push({ id: issue.code + ':' + language + ':' + row.span.span_id, kind: 'not_displayed', owner: issue.owner,
          reason: issue.detail, impact: JSON.stringify(issue) });
        if (!text.trim()) fail('P221_EMPTY_EXPRESSION');
        if (!relocatedVisualSpans.has(row.span.span_id)) draft += text + blockAnchorSeparator(text) + '^' + anchor + '\n\n';
        if (researchMap?.backs[language][row.span.span_id]) draft += researchMap.backs[language][row.span.span_id].map(row => link(row.target, row.label)).join(' · ') + '\n\n';
        local.push({ language, section_id: relocatedVisualSpans.has(row.span.span_id) ? 'figures-tables' : section, paragraph_id: row.paragraph_id, span_id: row.span.span_id, anchor, text,
          source: { start: 0, end: row.span.text.length, text: row.span.text, unit: 'UTF-16' },
          ...(row.span.support_range ? { support_range: structuredClone(row.span.support_range) } : {}),
          ...(row.span.immutable_ref?.authority === 'reviewed_expression' ? { reviewed_expression: row.span.immutable_ref.classification_id } : {}),
          transform: row.span.immutable_ref?.authority === 'reviewed_expression' ? 'reviewed-expression' : row.span.kind === 'asset' ? 'registered-asset-embed' : ['formula', 'code'].includes(row.span.kind) ? 'immutable-fence' : display.transforms.length ? 'reader-display' : 'identity',
          display_transforms: display.transforms,
          quantity_bindings: row.span.quantity_bindings ?? [], core_quantity_bindings: row.span.core_quantity_bindings ?? [],
          refs: [...(row.span.semantic_refs ?? []), ...(row.span.boundary_refs ?? []), ...(row.span.claim_refs ?? []), ...(row.span.evidence_refs ?? []), ...(row.span.quantity_refs ?? []), ...(row.span.applicability_refs ?? []), ...(row.span.support_refs ?? []), ...(row.span.immutable_ref?.authority === 'source_block' ? [row.span.immutable_ref.id] : [])] });
      }
      const generatedStart = draft.length;
      if (section === 'methods-concepts-measures' && presentationOptions.sharedExplanations !== undefined) draft += output.supportNotes.map(row => link(row.target_path ?? row.path, row.labels[language])).join(' · ') + '\n\n';
      if (section === 'figures-tables') {
        draft += visuals.fragments[language].map(row => row.text).join('');
        for (const gap of sourceAssets.gaps) draft += readerStateMessage({ state: 'missing_asset', language, reason: gap.reason + ' ' + gap.action }) + '\n\n';
        if (visuals.gaps.length) draft += readerStateMessage({ state: 'not_assessable', language, reason: language === 'en'
          ? 'Some required visuals still lack complete source context or interpretation. Their original inventory remains unresolved; see the reading record for the named actions'
          : '部分必需图表仍缺少完整来源上下文或解释，原清单中的缺项尚未解决；具体行动见阅读记录' }) + '\n\n';
      }
      if (section === 'discussion' && !data.science.scientific_details.research_candidates.length) draft += readerStateMessage({ state: 'no_candidate', language }) + '\n\n';
      if (section === 'evidence') {
        for (const [ordinal, evidence] of data.core.evidence.entries()) {
          const anchor = anchorFor('e', evidence.evidence_id), text = checkedText(evidence.extracted_text);
          const heading = (language === 'en' ? 'Source passage ' : '来源片段 ') + (ordinal + 1);
          draft += '### ' + heading + '\n\n';
          const locator = evidence.locator ?? {};
          const location = Object.entries(locator).filter(([key, value]) => /page|section|paragraph|sheet|cell/.test(key) && ['string', 'number'].includes(typeof value)).map(([key, value]) => label(key + ': ' + value)).join(' · ') || (language === 'en' ? 'Source location not provided' : '来源位置未提供');
          draft += location + ' ^' + anchor + '\n\n';
          draft += (language === 'en' ? 'Expand the source evidence below to read the passage.\n\n' : '展开下方原文证据以阅读片段。\n\n');
          draft += '> [!quote]- ' + (language === 'en' ? 'Source evidence and location' : '原文证据与定位') + '\n' + text.split('\n').map(line => '> ' + line).join('\n') + '\n\n';
          const target = local.find(row => row.refs.includes(evidence.evidence_id));
          if (target) draft += link('#^' + target.anchor, language === 'en' ? 'Return to the explanation' : '返回对应解释') + '\n\n';
        }
        for (const record of records.filter(r => r.obligation_id)) {
          const bound = rows.find(row => row.span.semantic_refs.some(ref => record.refs.includes(ref)));
          if (!bound) fail('P221_OBLIGATION_EXPRESSION_MISSING', { id: record.id, language });
          const found = { anchor: anchorFor('p', bound.span.span_id) };
          const text = dutyTitles[language][Number(record.id.slice(3)) - 1], anchor = anchorFor('s', record.id);
          draft += link('#^' + found.anchor, text) + ' ^' + anchor + '\n\n';
          navigation.push({ language, kind: 'semantic', semantic_id: record.id, target: (compact ? recordPaths[language] : registry.paper_targets[language]) + '#^' + anchor, label: text });
        }
      }
      if (section === 'relations' && !sections[section].length) {
        draft += language === 'en' ? 'The registered evidence supports the linked explanations; a recorded relation is not proof of causation.\n\n' : '已登记证据支持上文相应解释；记录的关系不等于因果证明。\n\n';
      }
      if (section === 'relations') for (const [ordinal, unit] of data.core.units.entries()) {
        const directlyBound = local.filter(row => row.core_quantity_bindings.some(binding => binding.unit_id === unit.unit_id));
        const candidates = directlyBound.length ? directlyBound : local.filter(row => row.section_id === 'key-findings' && row.refs.includes(unit.unit_id));
        const target = candidates.length === 1 ? candidates[0] : undefined;
        if (!target) {
          gaps.push({ id: 'P221_CORE_NAVIGATION_AMBIGUOUS:' + language + ':' + unit.unit_id, kind: 'not_displayed', owner: 'Plan04/08', reason: 'A unique actual core-result paragraph could not be established; no generic reference is substituted.', impact: unit.unit_id });
          continue;
        }
        const unitLabel = (language === 'en' ? 'Comparison finding ' : '比较结果 ') + (ordinal + 1);
        const evidenceLinks = unit.evidence_ids.map(id => {
          const number = data.core.evidence.findIndex(row => row.evidence_id === id) + 1;
          return link('#^' + anchorFor('e', id), (language === 'en' ? 'Source passage ' : '来源片段 ') + number);
        });
        const provenance = language === 'en' ? unit.provenance === 'author_reported' ? 'author-reported' : 'analyst inference' : unit.provenance === 'author_reported' ? '作者报告' : '分析者推论';
        draft += link('#^' + target.anchor, unitLabel) + (language === 'en' ? ' is grounded in ' : '的依据为') + evidenceLinks.join(language === 'en' ? ', ' : '、') + `（${provenance}）` + (language === 'en' ? '; this evidence link alone does not establish causation.\n\n' : '；这种证据关联本身不构成因果证明。\n\n');
      }
      if (section === 'coverage') {
        const completeness = data.qualification.scientific_completeness;
        draft += (language === 'en' ? 'Registered scientific scope: ' : '已登记科学范围：') + label(completeness ?? 'unknown') + (language === 'en' ? '. Reader completeness, readability and native presentation have not yet been assessed.\n\n' : '。最终阅读完整性、可读性和原生呈现尚未评估。\n\n');
        const counts = Object.fromEntries(['assessed', 'not_applicable', 'not_assessable'].map(status => [status, records.filter(row => row.obligation_id && row.applicability.status === status).length]));
        draft += language === 'en' ? `The sixteen registered reading obligations retain their original applicability: ${counts.assessed} assessed, ${counts.not_applicable} not applicable, ${counts.not_assessable} not assessable. These statuses describe the input, not acceptance of this rendered page.\n\n`
          : `16项已登记阅读义务保留原适用状态：已分析${counts.assessed}项，不适用${counts.not_applicable}项，无法评估${counts.not_assessable}项。这些状态描述输入范围，不代表当前阅读页面已经验收。\n\n`;
        for (const record of records.filter(row => row.obligation_id && row.applicability.status !== 'assessed')) draft += dutyTitles[language][Number(record.id.slice(3)) - 1] + ' — '
          + readerStateMessage({ state: record.applicability.status, language, reason: record.applicability.reason }) + '\n\n';
        draft += link(recordPaths[language], language === 'en' ? 'Generation and validation record' : '生成与校验记录') + '\n\n';
      }
      if (compact && index >= 9) {
        let details = draft.slice(generatedStart);
        details = details.replace(/\[\[#\^([^|\]]+)\|/g, (match, anchor) => '[[' + (anchor.startsWith('e-') ? recordPaths[language] : registry.paper_targets[language]) + '#^' + anchor + '|');
        auditDetails[language] += '## ' + headings[index] + '\n\n' + details;
        draft = draft.slice(0, generatedStart);
        if (section === 'coverage') draft += link(recordPaths[language], language === 'en' ? 'Reading records' : '阅读记录') + '\n\n';
      }
      draft += `<!-- AUTO:END ${section} -->\n\n`;
    }
    for (const term of terms) {
      if (!local.some(range => range.display_transforms.some(tr => tr.proof.kind === 'term' && tr.proof.term_id === term.term_id))) continue;
      const names = [term.en_full_form, term.zh_full_form, term.abbreviation].filter(Boolean);
      const explanations = data.science.scientific_details.explanations.filter(explanation => term.definition_unit_refs.includes(explanation.explanation_id)
        && ['meaning_plain', 'role_in_this_paper', 'interpretation_boundary'].every(key => typeof explanation[key] === 'string' && explanation[key].trim() && !names.includes(explanation[key].trim()))
        && term.source_refs.every(id => explanation.source_block_ids.includes(id)));
      if (!explanations.some(explanation => local.some(range => range.refs.includes(explanation.explanation_id)))) gaps.push({
        id: 'P221_TERM_CONTENT_EXPLANATION_GAP:' + language + ':' + term.term_id, kind: 'not_displayed', owner: 'Plan05/08',
        reason: 'The expansion has no separately bound, displayed source-supported definition, paper use and interpretation boundary. Expanding a name does not fulfill SR-07/08/09.',
        impact: 'Methods/concepts explanation requires a targeted content review; terminology formatting is not content acceptance.' });
    }
    draft += '## ' + (language === 'en' ? 'Personal Notes' : '个人笔记') + '\n';
    const existing = existingTargets.find(row => row.path === registry.paper_targets[language]);
    if (existing?.bytes && !existing.managedHash) fail('P221_PREIMAGE_HASH_REQUIRED');
    const merged = mergeManagedNote({ existingBytes: existing?.bytes, rendered: Buffer.from(draft), expectedManagedHash: existing?.managedHash });
    const inspected = inspectManagedNote(merged.bytes), final = merged.bytes.toString('utf8');
    if (researchMap) {
      const text = final.includes('\r\n') ? researchMap.fragments[language].replace(/\r?\n/g, '\r\n') : researchMap.fragments[language];
      const start = final.indexOf(text), from = Buffer.byteLength(final.slice(0, start)), to = from + Buffer.byteLength(text);
      if (start < 0 || final.indexOf(text, start + 1) >= 0 || !inspected.regions.some(row => row.id === 'study-design' && row.from <= from && row.to >= to)) fail('P221_MAP_FINAL_MAPPING_INVALID');
      mapRanges.push({ language, section_id: 'study-design', from, to, sha256: sha(merged.bytes.subarray(from, to)) });
    }
    for (const fragment of visuals.fragments[language]) {
      const text = final.includes('\r\n') ? fragment.text.replace(/\r?\n/g, '\r\n') : fragment.text;
      const start = final.indexOf(text);
      if (start < 0 || final.indexOf(text, start + 1) >= 0) fail('P221_VISUAL_FINAL_MAPPING_INVALID');
      const from = Buffer.byteLength(final.slice(0, start)), to = from + Buffer.byteLength(text);
      if (!inspected.regions.some(row => row.id === 'figures-tables' && row.from <= from && row.to >= to)) fail('P221_MAPPING_OUTSIDE_MACHINE');
      visualExpressions.push({ inventory_id: fragment.inventory_id, language, span_id: 'visual-' + fragment.inventory_id, section_id: 'figures-tables',
        anchor: fragment.anchor, from, to, sha256: sha(merged.bytes.subarray(from, to)) });
    }
    for (const range of local) {
      const marker = range.text + blockAnchorSeparator(range.text) + '^' + range.anchor;
      const start = final.indexOf(marker);
      if (start < 0 || final.indexOf(marker, start + 1) >= 0) fail('P221_FINAL_MAPPING_AMBIGUOUS');
      const from = Buffer.byteLength(final.slice(0, start)), to = from + Buffer.byteLength(range.text);
      if (!inspected.regions.some(r => r.id === range.section_id && r.from <= from && r.to >= to)) fail('P221_MAPPING_OUTSIDE_MACHINE');
      const display_transforms = range.display_transforms.map(tr => ({ ...tr, output: { ...tr.output, from: from + tr.output.from, to: from + tr.output.to } }));
      for (const tr of display_transforms) if (merged.bytes.subarray(tr.output.from, tr.output.to).toString('utf8') !== tr.output.text) fail('P221_DISPLAY_MAPPING_INVALID');
      ranges.push({ ...range, display_transforms, from, to, unit: 'UTF-8', sha256: sha(merged.bytes.subarray(from, to)) });
    }
    noteTargets[language] = { path: registry.paper_targets[language], byte_sha256: sha(merged.bytes), managed_hash: merged.managedHash };
    output[language === 'en' ? 'en' : 'zhCN'] = merged.bytes;
  }
  for (const record of records) {
    if (record.source_basis.pointer === null) gaps.push({ id: record.id, kind: 'source_unavailable', reason: 'The supplied historical qualification does not expose this boundary as a separately addressable source record; existing rendered expressions are retained without inventing source identity.', impact: record.origins.join(', '), owner: 'Plan05/08' });
    for (const language of languages) record.expressions[language] = [...ranges.filter(range => range.language === language && ((!record.obligation_id && range.refs.includes(record.id)) || range.refs.some(ref => record.refs.includes(ref)))),
      ...visualExpressions.filter(range => range.language === language && range.inventory_id === record.id)].map(({ span_id, section_id, anchor, from, to, sha256 }) => ({ span_id, section_id, anchor, from, to, sha256 }));
    if (languages.some(l => !record.expressions[l].length)) gaps.push({ id: record.id, kind: 'not_displayed', reason: 'No bound final expression was located; this record remains in the denominator.', impact: record.origins.join(', '), owner: record.origins.includes('inventory') || record.origins.includes('asset') ? 'Plan04/08' : 'Plan05/08' });
    delete record.refs;
  }
  output.readingRecords = languages.map(language => {
    const zh = language === 'zh-CN';
    let text = '# ' + (zh ? '生成与校验记录' : 'Generation and validation record') + '\n\n' + title + '\n\n';
    text += (zh ? '此页展示已有生成事实与未解决项，不授予科学身份、科学批准或发布资格。\n\n' : 'This page records generation facts and unresolved items; it grants no scientific identity, approval or publication eligibility.\n\n');
    text += link(registry.paper_targets[language], zh ? '返回论文解读' : 'Return to the reading note') + '\n\n';
    text += (zh ? '阅读完整性：未运行。可读性：未运行。原生呈现：未运行。\n\n' : 'Reading completeness: not run. Readability: not run. Native presentation: not run.\n\n');
    text += (zh ? '机器记录由同一候选的受控清单保存；本页不提供隐藏JSON文件的原生链接。\n\n' : 'The controlled candidate inventory retains the machine record; this page does not link to hidden JSON as a native reading target.\n\n');
    text += '## ' + (zh ? '未解决项与下一步' : 'Unresolved items and next actions') + '\n\n';
    for (const reason of new Set(gaps.map(gap => gap.reason))) text += '- ' + label(reason) + '\n';
    if (data.reader_support) {
      const support = JSON.stringify(data.reader_support, null, 2);
      const fence = '`'.repeat(Math.max(3, ...[...support.matchAll(/`+/g)].map(match => match[0].length + 1)));
      text += '\n\n## ' + (zh ? '已审补充背景及来源' : 'Reviewed background and sources') + '\n\n' + fence + 'json\n' + support + '\n' + fence + '\n';
    }
    if (compact) {
      const audit = JSON.stringify({ evidence: data.core.evidence, relations: data.core.relations ?? [], unit_evidence: data.core.units.map(row => ({ unit_id: row.unit_id, evidence_ids: row.evidence_ids, provenance: row.provenance })),
        source_blocks: data.science.scientific_details.source_blocks, qualification: data.qualification, coverage: records.map(({ id, applicability, origins, source_basis }) => ({ id, applicability, origins, source_basis })), gaps }, null, 2);
      const fence = '`'.repeat(Math.max(3, ...[...audit.matchAll(/`+/g)].map(match => match[0].length + 1)));
      text += '\n\n' + auditDetails[language] + '\n\n## ' + (zh ? '完整底层记录' : 'Complete underlying records') + '\n\n' + fence + 'json\n' + audit + '\n' + fence + '\n';
    }
    return { kind: 'reader-record', language, target_path: recordPaths[language], bytes: Buffer.from(text), byte_sha256: sha(Buffer.from(text)) };
  });
  const tools = ['phase221-presentation.mjs', 'phase221-display.mjs', 'phase221-targets.mjs', 'phase221-visuals.mjs', 'phase221-source-assets.mjs', 'phase22-managed-markdown.mjs', 'phase22-render.mjs'];
  if (data.reader_support) tools.push('phase221-reviewed-support.mjs', 'phase22-language.mjs', 'phase22-parity.mjs', '../../Schema/phase22/reader-presentation.schema.json');
  if (researchMap) tools.push('phase221-research-map.mjs');
  const presentationBinding = researchMap || compact || presentationOptions.sharedExplanations !== undefined
    ? hash({ research_map: researchMap?.map ?? null, shared_explanations: presentationOptions.sharedExplanations ?? null, audit_display: presentationOptions.auditDisplay ?? null }) : null;
  if (presentationBinding) tools.push('../../Schema/phase22/reader-presentation.schema.json');
  const toolFingerprints = Object.fromEntries(await Promise.all(tools.map(async name => [name, sha(await readFile(new URL(name, import.meta.url)))])));
  const manifest = { schema_version: 'phase22/reader-presentation-1.0', profile: READER_PROFILE, identity: data.identity, qualification: data.qualification,
    dependencies: { ...data.dependencies, ...(presentationBinding ? { presentation_options: presentationBinding } : {}), reader_tools: toolFingerprints, targets: registry.registry_fingerprint, visuals: hash({ visualUnits: output.visualInput, derivationRecords: output.derivationRecords }), style: hash({ cssclasses: languages.map(l => inspectManagedNote(output[l === 'en' ? 'en' : 'zhCN']).frontmatter.cssclasses ?? null), stylesheet: stylesheet ? sha(stylesheet.bytes) : null }) },
    targets: { notes: noteTargets, presentation: manifestPath, reading_records: Object.fromEntries(output.readingRecords.map(row => [row.language, { path: row.target_path, byte_sha256: row.byte_sha256 }])), support: data.supportNotes.map(row => row.target_path ?? row.path), assets: data.assets.map(row => row.target_path) },
    target_registry: registry, records, ranges, navigation, gaps, review: output.review,
    ...(data.reader_support ? { reader_support: data.reader_support } : {}),
    ...(researchMap ? { research_map: { map: researchMap.map, bindings: researchMap.bindings, navigation: researchMap.navigation, ranges: mapRanges } } : {}),
    ...(compact ? { audit_display: 'compact' } : {}),
    ...(presentationOptions.sharedExplanations !== undefined ? { shared_explanations: structuredClone(presentationOptions.sharedExplanations), shared_explanation_bindings: shared.bindings } : {}) };
  const validator = await createPhase22ContractValidator();
  validator.assert('phase22/reader-presentation-1.0', manifest);
  output.manifest = manifest;
  output.presentationBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  presentations.set(output, { input, quantityEquivalence: presentationOptions.quantityEquivalence,
    dependencies: hash(data.dependencies), resources: resourceFingerprint(output), notes: { en: sha(output.en), 'zh-CN': sha(output.zhCN) }, sidecar: sha(output.presentationBytes),
    fingerprint: hash({ manifest, visualInput: output.visualInput, derivationRecords: output.derivationRecords, abstractContract }) });
  return freeze(output);
}
