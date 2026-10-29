/** Reader-only, range-bound display rules. Frozen scientific inputs are never edited. */
import { realpath, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { fingerprintV3Json as hash } from './semantic-package-validator.mjs';
import { getRunControlForDispatch, readOwnedArtifact } from './owned-artifact-store.mjs';
import { getHistoricalReaderContent } from './phase221-historical-input.mjs';
import { getReadingBasisContent } from './phase22-input.mjs';
import { assertFrozenRenderContext } from './phase22-render-context.mjs';
import { assertBilingualParity, assertReaderBilingualParity } from './phase22-parity.mjs';
import { collectLanguageSpans } from './phase22-language.mjs';

export const READER_DISPLAY_VERSION = 'phase221-display-1.0';
const proofs = new WeakMap(), spanProofs = new WeakMap();
const fail = (code, details = {}) => { throw Object.assign(new Error(code), { code, details }); };
const scientificFields = ['raw_precision', 'unit', 'denominator', 'groups', 'timepoint', 'analysis_set', 'metric_definition', 'uncertainty_type', 'uncertainty_value'];
const identityFields = [...scientificFields, 'comparison', 'population', 'conditions', 'uncertainty', 'qualifiers'];

async function proofInput(input) {
  if (input?.schema_version === 'phase221-historical-reader-input-1.0') {
    const data = await getHistoricalReaderContent(input);
    return { ...data, dependencies: { basis: data.original_review.basis_fingerprint, context: data.original_review.context_fingerprint,
      science: hash(data.science), core: hash(data.core), views: Object.fromEntries(Object.entries(data.views).map(([language, view]) => [language, hash(view)])) } };
  }
  (input?.mode === 'reader' ? assertReaderBilingualParity : assertBilingualParity)(input?.parity, input);
  assertFrozenRenderContext(input.context, input.basis);
  const science = getReadingBasisContent(input.basis);
  return { identity: input.basis.identity, science, core: science.core, views: input.views,
    dependencies: { basis: input.basis.basis_fingerprint, context: input.context.context_fingerprint, science: hash(science), core: hash(science.core),
      views: Object.fromEntries(Object.entries(input.views).map(([language, view]) => [language, hash(view)])) } };
}

async function ownedProof(receipt) {
  const { artifactRoot, dispatchContext, runId, artifactId } = receipt ?? {};
  const binding = getRunControlForDispatch({ dispatchContext, runId })?.phase221_quantity_equivalence;
  if (!binding || binding.role !== 'integration' || binding.artifact_id !== artifactId || resolve(binding.artifact_root) !== resolve(artifactRoot)) fail('P221_QUANTITY_PROOF_CONTROL_REQUIRED');
  const owned = await readOwnedArtifact({ artifactRoot, artifactId });
  if (!owned || owned.receipt.run_id !== runId || ['artifact_id', 'owner_actor_id', 'role', 'path', 'revision'].some(key => owned.receipt[key] !== binding[key])
    || owned.receipt.sha256 !== binding.payload_sha256) fail('P221_QUANTITY_PROOF_RECEIPT_MISMATCH');
  const path = resolve(artifactRoot, owned.receipt.path), stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || await realpath(path) !== path) fail('P221_QUANTITY_PROOF_PATH_INVALID');
  return { owned, payload: JSON.parse(owned.bytes.toString('utf8')) };
}
const validToken = (span, token, value) => token && Number.isInteger(token.start) && Number.isInteger(token.end) && token.start >= 0 && token.end > token.start && token.end <= span.text.length && span.text.slice(token.start, token.end) === value;
const integerDigits = value => typeof value === 'string' && /^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(value) ? value.replaceAll(',', '') : null;

function checkPair(pair, data) {
  const row = collectLanguageSpans(data.views[pair.language] ?? { sections: [] }).find(row => row.section_id === pair.section_id && row.paragraph_id === pair.paragraph_id && row.span.span_id === pair.span_id);
  if (!row || !editable.has(row.span.kind)) fail('P221_QUANTITY_PROOF_LOCATION_MISMATCH');
  const q = pair.scientific_binding, c = pair.core_binding;
  if (!row.span.quantity_bindings.some(value => same(value, q)) || !row.span.core_quantity_bindings.some(value => same(value, c))) fail('P221_QUANTITY_PROOF_BINDING_MISMATCH');
  const scientific = data.science.scientific_details.quantities.find(value => value.quantity_id === q.quantity_id);
  const unit = data.core.units.find(value => value.unit_id === c.unit_id);
  if (!scientific || !unit || !same(unit.quantity[c.quantity_index], c.quantity) || scientificFields.some(key => !same(q[key], scientific[key]))
    || q.raw_value !== scientific.raw_value || ['population', 'comparison', 'conditions', 'uncertainty'].some(key => !same(c[key], unit[key]))) fail('P221_QUANTITY_PROOF_BINDING_MISMATCH');
  const left = pair.scientific_identity, right = pair.core_identity;
  if (![left, right].every(identity => identity && same(Object.keys(identity).sort(), [...identityFields].sort()) && identityFields.every(key => identity[key] !== null && identity[key] !== undefined)
    && scientificFields.filter(key => key !== 'groups').every(key => nonblank(identity[key])) && Array.isArray(identity.groups))) fail('P221_QUANTITY_IDENTITY_INCOMPLETE');
  if (!same(left, right)) fail('P221_QUANTITY_IDENTITY_MISMATCH');
  if (scientificFields.some(key => !same(left[key], q[key])) || right.unit !== c.quantity.unit || right.metric_definition !== c.quantity.name
    || c.quantity.denominator === null || right.denominator !== String(c.quantity.denominator)
    || !same(right.groups, c.comparison.groups) || right.analysis_set !== c.population.description
    || ['comparison', 'population', 'conditions', 'uncertainty'].some(key => !same(right[key], c[key]))
    || !same(left.qualifiers, { scientific, core: unit })) fail('P221_QUANTITY_PROOF_IDENTITY_CONFLICT');
  if (pair.same_assertion?.judgment !== 'same' || !nonblank(pair.same_assertion.reason)
    || !Array.isArray(pair.source_refs) || !pair.source_refs.length || !pair.source_refs.includes(scientific.source_block_id)
    || pair.source_refs.some(id => !data.science.scientific_details.source_blocks.some(block => block.source_block_id === id))) fail('P221_QUANTITY_PROOF_ASSERTION_REQUIRED');
  if (!validToken(row.span, q.token, q.raw_value) || !validToken(row.span, c.token, String(c.quantity.value))) fail('P221_QUANTITY_PROOF_RANGE_INVALID');
  if (!Number.isSafeInteger(c.quantity.value) || !integerDigits(q.raw_value) || integerDigits(q.raw_value) !== integerDigits(String(c.quantity.value))) fail('P221_QUANTITY_FORMAT_UNSUPPORTED');
  return row;
}

/** Sole new evidence admission: an owned Integrator artifact, never an accepted:true JSON flag. */
export async function acceptReaderQuantityEquivalence({ input, integratorReceipt } = {}) {
  const data = await proofInput(input), { owned, payload } = await ownedProof(integratorReceipt);
  if (payload.schema_version !== 'phase221-quantity-equivalence-1.0' || !same(payload.identity, data.identity)
    || owned.receipt.run_id !== data.identity.run_id || !same(payload.dependencies, data.dependencies)) fail('P221_QUANTITY_PROOF_DEPENDENCY_MISMATCH');
  if (!Array.isArray(payload.pairs) || !payload.pairs.length) fail('P221_QUANTITY_PROOF_PAIRS_REQUIRED');
  const occupied = new Set(), spanFingerprints = new Map();
  for (const pair of payload.pairs) {
    const row = checkPair(pair, data);
    spanFingerprints.set(JSON.stringify([pair.language, pair.section_id, pair.paragraph_id, pair.span_id]), hash(row.span));
    const key = [pair.language, pair.span_id, pair.scientific_binding.token.start, pair.core_binding.token.start].join(':');
    if (occupied.has(key)) fail('P221_QUANTITY_PROOF_DUPLICATE');
    occupied.add(key);
  }
  const capability = Object.freeze({ schema_version: 'phase221-quantity-equivalence-capability-1.0', artifact_sha256: owned.receipt.sha256 });
  proofs.set(capability, { payload, integratorReceipt, receipt: owned.receipt, spanFingerprints,
    proofBinding: { artifactRoot: integratorReceipt.artifactRoot, runId: integratorReceipt.runId,
      artifactId: integratorReceipt.artifactId, sha256: owned.receipt.sha256 } });
  return capability;
}

/** Recheck physical proof bytes and the current input before each renderer consumption. */
export async function readReaderQuantityEquivalence({ capability, input } = {}) {
  const state = proofs.get(capability);
  if (!state) fail('P221_QUANTITY_PROOF_CAPABILITY_REQUIRED');
  const fresh = await acceptReaderQuantityEquivalence({ input, integratorReceipt: state.integratorReceipt });
  if (fresh.artifact_sha256 !== capability.artifact_sha256) fail('P221_QUANTITY_PROOF_CHANGED');
  return fresh;
}

/** Return the owned proof location without exposing its capability state. */
export function getReaderQuantityProofBinding(capability) {
  const state = proofs.get(capability);
  if (!state) fail('P221_QUANTITY_PROOF_CAPABILITY_REQUIRED');
  return { ...state.proofBinding };
}

export function readerQuantityBindings({ capability, language, sectionId, paragraphId, span } = {}) {
  const state = proofs.get(capability);
  if (!state) fail('P221_QUANTITY_PROOF_CAPABILITY_REQUIRED');
  const pairs = state.payload.pairs.filter(pair => pair.language === language && pair.section_id === sectionId && pair.paragraph_id === paragraphId && pair.span_id === span.span_id);
  if (pairs.length && state.spanFingerprints.get(JSON.stringify([language, sectionId, paragraphId, span.span_id])) !== hash(span)) fail('P221_QUANTITY_PROOF_SPAN_CHANGED');
  for (const pair of pairs) if (!span.quantity_bindings.some(row => same(row, pair.scientific_binding)) || !span.core_quantity_bindings.some(row => same(row, pair.core_binding))) fail('P221_QUANTITY_PROOF_BINDING_MISMATCH');
  const result = Object.freeze({});
  spanProofs.set(result, { pairs, artifact: { ...state.receipt }, dependencies: state.payload.dependencies });
  return result;
}
const editable = new Set(['analysis', 'link_label']);
const writer = language => language === 'en' ? 'English Writer' : 'Chinese Writer';
const nonblank = value => typeof value === 'string' && value.trim().length > 0;
const original = (text, start, end) => ({ start, end, text: text.slice(start, end), unit: 'UTF-16' });

function protectedRanges(text) {
  const ranges = [];
  // Conservatively protect whole inline code/math/wiki links, reference definitions and IDs.
  for (const match of text.matchAll(/(`+)[\s\S]*?\1|\$\$[\s\S]*?\$\$|\$[^$\r\n]+\$|https?:\/\/[^\s<>]+|\[\[[^\]]*\]\]|\^[\w-]+|^\s*\[[^\]]+\]:[^\n]*|\]\[[^\]]*\]/gm)) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  for (let i = 0; i < text.length - 1; i++) {
    if (text.slice(i, i + 2) !== '](') continue;
    let depth = 1, end = i + 2;
    for (; end < text.length; end++) {
      if (text[end] === '\\') { end++; continue; }
      if (text[end] === '(') depth++;
      if (text[end] === ')' && --depth === 0) { end++; break; }
    }
    ranges.push({ start: i, end });
    i = end - 1;
  }
  return ranges;
}
const overlap = (a, b) => a.start < b.end && b.start < a.end;
function occurrences(text, value) {
  const found = [];
  if (!nonblank(value)) return found;
  for (let start = text.indexOf(value); start >= 0; start = text.indexOf(value, start + value.length)) {
    const end = start + value.length;
    // Latin identifiers must be whole tokens. CJK prose may touch an abbreviation.
    if (/[A-Za-z0-9_]/.test(value[0]) && /[A-Za-z0-9_]/.test(text[start - 1] ?? '')) continue;
    if (/[A-Za-z0-9_]/.test(value.at(-1)) && /[A-Za-z0-9_]/.test(text[end] ?? '')) continue;
    found.push({ start, end });
  }
  return found;
}

/** seen is shared across paragraphs/subheadings; its keys include language and top-level section. */
export function displayReaderSpan({ span, sectionId, language, terms = [], quantityBindings, seen = new Set() }) {
  const text = span.text, issues = [], changes = [], protectedParts = protectedRanges(text);
  const issue = (code, owner, range, detail) => issues.push({ code, owner, span_id: span.span_id, section_id: sectionId, language, range: original(text, range.start, range.end), detail });
  if (!editable.has(span.kind)) return { text, original_ranges: [original(text, 0, text.length)], transforms: [], issues };
  const candidates = [];
  for (const term of terms) {
    const abbr = term.abbreviation, full = term.en_full_form, zh = term.zh_full_form;
    if (!nonblank(abbr) || !nonblank(full)) continue;
    const isFull = abbr === full || abbr === zh;
    const prefix = language === 'en' ? full + ' (' : (zh ? zh + '（' + full + '，' : full + '（');
    const suffix = language === 'en' ? ')' : '）';
    const canonical = isFull ? (language === 'en' || !zh ? full : zh + '（' + full + '）') : prefix + abbr + suffix;
    const atoms = [];
    if (!isFull) {
      for (let start = text.indexOf(prefix); start >= 0; start = text.indexOf(prefix, start + prefix.length)) {
        let cursor = start, depth = 0;
        while (text.startsWith(prefix, cursor)) { cursor += prefix.length; depth++; }
        if (!text.startsWith(abbr, cursor) || !text.startsWith(suffix.repeat(depth), cursor + abbr.length)) continue;
        const end = cursor + abbr.length + suffix.length * depth;
        atoms.push({ start, end, value: depth > 1 ? canonical : text.slice(start, end), rule: depth > 1 ? 'term-duplicate-expansion' : 'term-existing-atom' });
      }
    } else {
      for (const range of occurrences(text, prefix + abbr + suffix)) atoms.push({ ...range, value: canonical, rule: 'term-full-name-classification' });
    }
    candidates.push(...atoms.map(atom => ({ ...atom, term })));
    for (const range of occurrences(text, abbr)) {
      if (atoms.some(atom => overlap(atom, range))) continue;
      candidates.push({ ...range, term, value: isFull ? abbr : canonical, rule: isFull ? 'term-full-name-classification' : 'term-first-use' });
    }
  }
  candidates.sort((a, b) => a.start - b.start || b.end - a.end);
  let consumed = 0;
  for (const candidate of candidates) {
    if (candidate.start < consumed || protectedParts.some(part => overlap(part, candidate))) continue;
    const sameRange = candidates.filter(c => c.start === candidate.start && c.end === candidate.end);
    const selected = sameRange.filter(c => span.term_refs?.includes(c.term.term_id));
    const choices = [...new Map((selected.length ? selected : sameRange).map(c => [c.term.term_id, c])).values()];
    consumed = candidate.end;
    if (choices.length !== 1) { issue('P221_TERM_SENSE_AMBIGUOUS', 'Integrator', candidate, 'The same form has multiple supported senses; bind the intended term.'); continue; }
    const chosen = choices[0], term = chosen.term;
    if (!nonblank(term.sense) || !term.definition_unit_refs?.length || !term.source_refs?.length) {
      issue('P221_TERM_DEFINITION_UNSUPPORTED', 'Integrator', chosen, 'A supported definition and sense are required.'); continue;
    }
    if (language === 'zh-CN' && !(term.translation?.status === 'approved' && nonblank(term.zh_full_form) || term.translation?.status === 'no_stable_translation' && term.zh_full_form === null)) {
      issue('P221_TERM_TRANSLATION_UNKNOWN', 'Integrator', chosen, 'No supported Chinese translation disposition exists.'); continue;
    }
    if (chosen.rule === 'term-first-use') {
      const before = text.slice(0, chosen.start), open = Math.max(before.lastIndexOf('（'), before.lastIndexOf('('));
      const close = Math.max(before.lastIndexOf('）'), before.lastIndexOf(')'));
      if (open > close && [term.en_full_form, term.zh_full_form].filter(nonblank).some(form => before.slice(Math.max(0, open - form.length)).includes(form))) {
        issue('P221_TERM_REPETITION_AMBIGUOUS', writer(language), chosen, 'Unrecognized expansion or meaningful qualifier; preserve it for a targeted Writer revision.'); continue;
      }
    }
    const scope = language + ':' + sectionId + ':' + term.term_id;
    if (chosen.rule === 'term-first-use' && seen.has(scope)) continue;
    seen.add(scope);
    changes.push({ ...chosen, proof: { kind: 'term', term_id: term.term_id, sense: term.sense, section_id: sectionId,
      definition_unit_refs: [...term.definition_unit_refs], source_refs: [...term.source_refs] }, originals: [original(text, chosen.start, chosen.end)] });
  }
  const boundProof = quantityBindings === undefined ? undefined : spanProofs.get(quantityBindings);
  if (quantityBindings !== undefined && !boundProof) fail('P221_QUANTITY_PROOF_CAPABILITY_REQUIRED');
  for (const q of span.quantity_bindings ?? []) for (const c of span.core_quantity_bindings ?? []) {
    if (!validToken(span, q.token, q.raw_value) || !validToken(span, c.token, String(c.quantity?.value))) continue;
    const tokens = [q.token, c.token].sort((a, b) => a.start - b.start);
    if (overlap(tokens[0], tokens[1])) continue;
    const between = text.slice(tokens[0].end, tokens[1].start), closing = text[tokens[1].end];
    const adjacent = /^[ \t]*（[ \t]*$/.test(between) && closing === '）' || /^[ \t]*\([ \t]*$/.test(between) && closing === ')';
    if (!adjacent && integerDigits(q.raw_value) !== integerDigits(String(c.quantity.value))) continue;
    const location = { start: tokens[0].start, end: tokens[1].end + (adjacent ? 1 : 0) };
    const pair = boundProof?.pairs.find(pair => same(pair.scientific_binding, q) && same(pair.core_binding, c));
    if (!pair) { issue('P221_QUANTITY_IDENTITY_INCOMPLETE', 'Integrator', location, 'No owned Integrator proof binds these two complete quantity identities and this assertion.'); continue; }
    if (!adjacent) { issue('P221_QUANTITY_NOT_ADJACENT', writer(language), location, 'Equivalent quantities are not adjacent presentation fragments in this reviewed paragraph.'); continue; }
    if (!integerDigits(q.raw_value) || !Number.isSafeInteger(c.quantity.value) || integerDigits(q.raw_value) !== integerDigits(String(c.quantity.value))
      || !q.raw_value.includes(',') || tokens.some(token => /[\d.,eE%+\-−]/.test(text[token.start - 1] ?? '') || /[\d.,eE%+\-−]/.test(text[token.end] ?? ''))) {
      issue('P221_QUANTITY_FORMAT_UNSUPPORTED', writer(language), location, 'Only exact positive integer thousands-separator equivalence is permitted.'); continue;
    }
    if (protectedParts.some(part => overlap(part, location)) || changes.some(change => overlap(change, location))) {
      issue('P221_QUANTITY_PROTECTED_RANGE', writer(language), location, 'Protected or already transformed ranges cannot be coalesced.'); continue;
    }
    changes.push({ ...location, value: q.raw_value, rule: 'integer-thousands-separator',
      originals: tokens.map(token => original(text, token.start, token.end)),
      proof: { kind: 'quantity', ...structuredClone(pair), artifact: structuredClone(boundProof.artifact), dependencies: structuredClone(boundProof.dependencies),
        original_fragment: original(text, location.start, location.end) } });
  }
  let displayed = '', cursor = 0;
  const transforms = [];
  for (const change of changes.sort((a, b) => a.start - b.start)) {
    displayed += text.slice(cursor, change.start);
    const from = Buffer.byteLength(displayed);
    displayed += change.value;
    transforms.push({ rule: change.rule, version: READER_DISPLAY_VERSION, original_ranges: change.originals,
      output: { from, to: Buffer.byteLength(displayed), text: change.value, unit: 'UTF-8' }, proof: change.proof });
    cursor = change.end;
  }
  displayed += text.slice(cursor);
  return { text: displayed, original_ranges: [original(text, 0, text.length)], transforms, issues };
}
