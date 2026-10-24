import { createHash } from 'node:crypto';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { readOwnedArtifact } from './owned-artifact-store.mjs';
import { assertReadingBasisCurrent, getReadingBasisContent, freezePhase22Value } from './phase22-input.mjs';
import { fingerprintV3Json as hash } from './semantic-package-validator.mjs';

const capabilities = new WeakMap();
const keys = ['cox', 'pca', 'mean-field', 'elbo'];
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const invalid = () => fail('P221_REVIEWED_SUPPORT_INVALID');
const parse = bytes => { try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { invalid(); } };
const decode = bytes => { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { invalid(); } };

function observe(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) invalid();
  path = resolve(path);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpathSync(path) !== path) invalid();
  const bytes = readFileSync(path), after = lstatSync(path);
  if (after.ino !== stat.ino || after.dev !== stat.dev || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) invalid();
  return { path, sha256: digest(bytes), byte_length: bytes.length, bytes };
}
function bindingMatches(actual, expected) {
  return expected && typeof expected.path === 'string' && resolve(expected.path) === actual.path && expected.sha256 === actual.sha256 && expected.byte_length === actual.byte_length;
}
function capture(binding, dependencies) {
  if (!binding || typeof binding.path !== 'string') invalid();
  const actual = observe(binding.path);
  if (!bindingMatches(actual, binding)) invalid();
  dependencies.push(actual);
  return actual;
}
function ownedPath(root, path) {
  if (typeof path !== 'string' || isAbsolute(path)) invalid();
  const target = resolve(root, path), rel = relative(resolve(root), target);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) invalid();
  return target;
}
async function owned(spec, role, runId, dependencies) {
  if (!spec?.artifact_root || !spec.artifact_id || !spec.sha256) invalid();
  const result = await readOwnedArtifact({ artifactRoot: spec.artifact_root, artifactId: spec.artifact_id });
  if (!result || result.receipt.role !== role || result.receipt.run_id !== runId || result.receipt.artifact_id !== spec.artifact_id
    || !result.receipt.owner_actor_id || result.receipt.sha256 !== spec.sha256 || result.receipt.byte_length !== result.bytes.length) invalid();
  const path = ownedPath(spec.artifact_root, result.receipt.path);
  const binding = { path, sha256: result.receipt.sha256, byte_length: result.receipt.byte_length };
  const file = capture(binding, dependencies);
  if (!file.bytes.equals(result.bytes)) invalid();
  const receipt = observe(resolve(spec.artifact_root, '.phase21-receipts', encodeURIComponent(spec.artifact_id) + '.json'));
  if (!same(parse(receipt.bytes), result.receipt)) invalid();
  dependencies.push(receipt);
  return { ...result, binding };
}
function block(text, key) {
  const start = `<!-- background:${key}:start -->`, end = `<!-- background:${key}:end -->`;
  const at = text.indexOf(start), stop = text.indexOf(end);
  if (at < 0 || stop < at + start.length || text.indexOf(start, at + 1) !== -1 || text.indexOf(end, stop + 1) !== -1) invalid();
  // Deliberately no trimming: offsets refer to exactly these protected UTF-16 bytes.
  const content = text.slice(at + start.length, stop);
  if (!content.trim()) invalid();
  return content;
}
function formulas(text) {
  const result = [];
  const escaped = index => { let count = 0; while (index > 0 && text[--index] === '\\') count++; return count % 2 === 1; };
  // A bounded scanner accepts only closed, nonempty $...$ / $$...$$ spans.
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '$' || escaped(i)) continue;
    const size = text[i + 1] === '$' ? 2 : 1, start = i;
    let end = i + size;
    while (end < text.length) {
      if (text[end] === '$' && !escaped(end) && (size === 2 ? text[end + 1] === '$' : text[end + 1] !== '$')) break;
      end++;
    }
    if (end === text.length || !text.slice(start + size, end).trim()) invalid();
    end += size;
    result.push({ text: text.slice(start, end), range: { start, end } });
    i = end - 1;
  }
  return result;
}
function textPointer(value, pointer) {
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) invalid();
  for (const token of pointer.slice(1).split('/')) {
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!value || !Object.hasOwn(value, key)) invalid();
    value = value[key];
  }
  if (typeof value !== 'string') invalid();
  return value;
}

/** Controller adapter only. Source text and reviewed prose are data, never tool grants. */
export async function admitReviewedSupport({ basis, descriptor } = {}) {
  assertReadingBasisCurrent(basis);
  if (!descriptor || descriptor.schema_version !== 'phase221-reviewed-support-1.0' || !same(descriptor.identity, basis.identity)) invalid();
  descriptor = structuredClone(descriptor);
  const dependencies = [], amendments = {}, writerBindings = {};
  for (const [language, role] of [['en', 'english-writer'], ['zh-CN', 'chinese-writer']]) {
    const value = await owned(descriptor.amendments?.[language], role, basis.identity.run_id, dependencies);
    amendments[language] = decode(value.bytes);
    writerBindings[language] = { ...value.binding, ...descriptor.amendments[language], receipt: value.receipt };
  }
  const reviewed = await owned(descriptor.review, 'bilingual-verifier', basis.identity.run_id, dependencies);
  const review = parse(reviewed.bytes), input = parse(capture(descriptor.review.input_binding, dependencies).bytes);
  const actualReadPaths = new Set((review.actual_read_paths ?? []).map(path => resolve(path)));
  const reviewedInput = (binding, digestBinding) => {
    if (!binding || !digestBinding || !actualReadPaths.has(resolve(binding.path)) || !actualReadPaths.has(resolve(digestBinding.path))) invalid();
    if (!same(parse(capture(digestBinding, dependencies).bytes), binding)) invalid();
    return parse(capture(binding, dependencies).bytes);
  };
  reviewedInput(descriptor.review.input_binding, descriptor.review.input_digest_binding);
  const legacy = Boolean(descriptor.review.original_input_binding);
  let sourceInput = input, sourceRanges = [];
  if (legacy) {
    const original = reviewedInput(descriptor.review.original_input_binding, descriptor.review.original_input_digest_binding);
    if (!review.task_id || review.task_id !== reviewed.receipt.artifact_id || original.assignment?.task_id !== review.task_id
      || original.assignment?.role !== 'bilingual-verifier' || input.same_active_review_task !== review.task_id
      || input.original_sources_and_deadline_unchanged !== true
      || typeof review.review_scope !== 'string' || !review.review_scope.includes(descriptor.review.input_binding.sha256)
      || !review.review_scope.includes(`${descriptor.review.input_binding.byte_length} bytes`)) invalid();
    sourceInput = original.read_only_data;
    if (sourceInput?.exact_source_range_check) {
      const rangeCheck = parse(capture(sourceInput.exact_source_range_check, dependencies).bytes);
      if (!Array.isArray(rangeCheck.spans)) invalid();
      sourceRanges = rangeCheck.spans;
    }
  }
  const reviewBlocks = Array.isArray(review.blocks) ? review.blocks : keys.map(id => ({ id, verdict: review.blocks?.[id] }));
  if ((!legacy && !same(review.identity, basis.identity)) || (review.identity && !same(review.identity, basis.identity)) || input.identity && !same(input.identity, basis.identity)
    || !['verdict', 'translation_verdict', 'provenance_verdict'].every(key => review[key] === 'pass')
    || review.original_application_preserved !== true || reviewBlocks.length !== 4
    || !keys.every(key => reviewBlocks.filter(row => row.id === key && row.verdict === 'pass').length === 1)
    || !bindingMatches(writerBindings.en, input.english) || !bindingMatches(writerBindings['zh-CN'], input.chinese)) invalid();
  if (!Array.isArray(descriptor.sources) || !descriptor.sources.length || !Array.isArray(sourceInput?.sources)) invalid();
  const science = getReadingBasisContent(basis), sourceIds = new Set();
  const sources = descriptor.sources.map(source => {
    if (typeof source.source_id !== 'string' || !source.source_id || sourceIds.has(source.source_id)) invalid();
    sourceIds.add(source.source_id);
    // The actual reviewed input, rather than descriptor assertions, registers primary bytes.
    if (!legacy && !sourceInput.sources.some(registered => same(registered, source))) invalid();
    if (source.origin === 'external_background') {
      let url;
      try { url = new URL(source.url); } catch { invalid(); }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) invalid();
      if (legacy && !sourceInput.sources.some(registered => registered.id === source.source_id && registered.url === source.url
        && registered.provenance === 'external_background_not_original_paper' && bindingMatches(source.raw_binding, registered)
        && resolve(registered.readable_path) === resolve(source.text_binding.path) && registered.readable_sha256 === source.text_binding.sha256)) invalid();
    } else if (source.origin !== 'original_paper' || !science.source_package.source_documents.some(document =>
      document.source_document_id === source.source_document_id && document.source_hash === source.source_hash)) invalid();
    if (legacy && source.origin === 'original_paper' && !sourceRanges.some(span =>
      span.source_document_id === source.source_document_id && span.source_hash === source.source_hash
      && bindingMatches(source.raw_binding, span.image) && bindingMatches(source.text_binding, span.file)
      && source.text_pointer === span.pointer && source.start === span.start && source.end === span.end)) invalid();
    capture(source.raw_binding, dependencies);
    const stored = capture(source.text_binding, dependencies);
    let text = source.text_pointer ? textPointer(parse(stored.bytes), source.text_pointer) : decode(stored.bytes);
    const start = source.start ?? 0, end = source.end ?? text.length;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > text.length || end <= start) invalid();
    text = text.slice(start, end);
    return { source_id: source.source_id, origin: source.origin,
      ...(source.url ? { url: source.url } : { source_document_id: source.source_document_id, source_hash: source.source_hash }),
      text, source_binding: structuredClone(source) };
  });
  const blocks = keys.map(key => {
    const ids = descriptor.block_sources?.[key];
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some(id => !sourceIds.has(id))) invalid();
    if (legacy) {
      const reviewedPaths = new Set((reviewBlocks.find(row => row.id === key).source_basis ?? []).filter(path => typeof path === 'string' && isAbsolute(path)).map(path => resolve(path)));
      if (ids.some(id => {
        const source = descriptor.sources.find(source => source.source_id === id);
        return !reviewedPaths.has(resolve(source.origin === 'original_paper' ? source.raw_binding.path : source.text_binding.path));
      })) invalid();
    }
    return { support_id: 'support:' + key, origin: ids.some(id => sources.find(source => source.source_id === id).origin === 'external_background') ? 'external_background' : 'original_paper',
      source_ids: [...ids], text: Object.fromEntries(['en', 'zh-CN'].map(language => [language, block(amendments[language], key)])), writer_bindings: writerBindings };
  });
  const expressions = blocks.flatMap(row => ['en', 'zh-CN'].flatMap(language => formulas(row.text[language]).map(formula => ({
    classification_id: 'reviewed-expression:' + hash({ support_id: row.support_id, language, ...formula, writer_binding: writerBindings[language] }).slice(7),
    support_id: row.support_id, language, kind: 'formula', ...formula, writer_binding: writerBindings[language], source_ids: row.source_ids,
    provenance: 'reviewed_typesetting_not_original_transcription' }))));
  const body = { schema_version: descriptor.schema_version, descriptor_fingerprint: hash(descriptor), basis_fingerprint: basis.basis_fingerprint, identity: descriptor.identity, sources, blocks, expressions };
  const content = freezePhase22Value({ ...body, support_fingerprint: hash(body) });
  const cap = Object.freeze({});
  capabilities.set(cap, { basis, descriptor, content, dependencies });
  assertReviewedSupportCurrent(cap);
  return cap;
}

export function assertReviewedSupportCurrent(cap) {
  const state = capabilities.get(cap);
  if (!state) fail('P221_REVIEWED_SUPPORT_NOT_ADMITTED');
  assertReadingBasisCurrent(state.basis);
  if (hash(state.descriptor) !== state.content.descriptor_fingerprint) invalid();
  const { support_fingerprint, ...body } = state.content;
  if (hash(body) !== support_fingerprint) invalid();
  for (const expected of state.dependencies) {
    const actual = observe(expected.path);
    if (!bindingMatches(actual, expected) || !actual.bytes.equals(expected.bytes)) fail('P221_REVIEWED_SUPPORT_CHANGED');
  }
  return true;
}
export function getReviewedSupportContent(cap) {
  assertReviewedSupportCurrent(cap);
  return capabilities.get(cap).content;
}
/** Exact captured dependencies for existing publication save/reload byte bindings. */
export function getReviewedSupportBindings(cap) {
  assertReviewedSupportCurrent(cap);
  return freezePhase22Value([...new Map(capabilities.get(cap).dependencies.map(({ path, sha256, byte_length }) =>
    [path, { path, sha256, byte_length }])).values()]);
}
export function resolveReviewedExpression(cap, { language, ref } = {}) {
  const content = getReviewedSupportContent(cap);
  const row = content.expressions.find(row => row.classification_id === ref?.id);
  if (!row || row.language !== language || ref.authority !== 'reviewed_expression' || ref.classification_id !== row.classification_id
    || ref.start !== 0 || ref.end !== row.text.length || row.kind !== 'formula') fail('P221_REVIEWED_EXPRESSION_INVALID');
  return row.text;
}
export function getReviewedSupportTargets(cap) {
  return freezePhase22Value(getReviewedSupportContent(cap).blocks.map((row, index) => ({ semantic_id: row.support_id,
    basis_pointer: '/reader_support/blocks/' + index, summary: row.support_id.slice(8) + ' reviewed background' })));
}
