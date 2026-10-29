/** Final-byte reader review. Source and role evidence are capabilities, never caller assertions. */
import { createHash } from 'node:crypto';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { fingerprintV3Json as hash } from './semantic-package-validator.mjs';
import { getReaderPresentationContent } from './phase221-presentation.mjs';
import { inspectManagedNote } from './phase22-managed-markdown.mjs';
import { createPhase22ContractValidator } from './phase22-contract-loader.mjs';
import { getRunControlForDispatch, readOwnedArtifact } from './owned-artifact-store.mjs';

const preparedStates = new WeakMap(), reviews = new WeakMap(), nativeStates = new WeakMap();
const languages = ['en', 'zh-CN'];
export const READER_RUBRIC_IDS = Object.freeze(Array.from({ length: 7 }, (_, i) => 'RB' + String(i + 1).padStart(2, '0')));
export const READER_CRITERIA_IDS = Object.freeze(Array.from({ length: 6 }, (_, i) => 'C' + String(i + 1).padStart(2, '0')));
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const fail = (code, details = {}) => { throw Object.assign(new Error(code), { code, details }); };
const nonblank = value => typeof value === 'string' && !!value.trim();
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const location = (language, row) => ({ language, section_id: row.section_id ?? row.id, from: row.from, to: row.to, sha256: row.sha256 ?? sha(row.bytes), ...(row.anchor ? { anchor: row.anchor } : {}), ...(row.span_id ? { span_id: row.span_id } : {}) });
const noteBytes = (notes, language) => Buffer.from(notes?.[language] ?? notes?.[language === 'en' ? 'en' : 'zhCN'] ?? []);
function finalPage(bytes, language, path) {
  const inspected = inspectManagedNote(bytes);
  if (inspected.frontmatter.language !== language || inspected.frontmatter.rendering_profile !== 'phase22-reader-note-1.0') fail('P221_REVIEW_PAGE_IDENTITY');
  return { language, path, text: bytes.toString('utf8'), byte_length: bytes.length, byte_sha256: sha(bytes), managed_hash: inspected.managedHash,
    machine_ranges: inspected.regions.map(row => location(language, row)), cssclasses: inspected.frontmatter.cssclasses ?? null,
    human_range_policy: 'Excluded from scientific judgments; preserve bytes and refresh whole-file CAS. Machine prose must remain in its managed region.' };
}
function resources(presentation) {
  const files = [...presentation.assets.map(row => ({ kind: 'asset', path: row.target_path, bytes: row.bytes })),
    ...presentation.readingRecords.map(row => ({ kind: 'reader-record', path: row.target_path, bytes: row.bytes })),
    ...presentation.supportNotes.filter(row => row.bytes).map(row => ({ kind: 'support', path: row.target_path ?? row.path, bytes: row.bytes }))];
  return files.map(row => ({ kind: row.kind, path: row.path, sha256: sha(row.bytes), byte_length: row.bytes.length }));
}
function visualConfigFor(presentation, pages) {
  return { stylesheet: presentation.stylesheet ? { path: presentation.stylesheet.path, sha256: sha(presentation.stylesheet.bytes) } : null,
    cssclasses: pages.map(page => ({ language: page.language, value: page.cssclasses })),
    visual_input: presentation.visualInput, derivation_records: presentation.derivationRecords, visual_bindings: presentation.visualBindings,
    source_assets: presentation.sourceAssets,
    ...(presentation.manifest.research_map ? { research_map: presentation.manifest.research_map } : {}),
    ...(presentation.auditDisplay ? { audit_display: presentation.auditDisplay } : {}),
    ...(presentation.sharedExplanations ? { shared_explanations: presentation.sharedExplanations, shared_explanation_bindings: presentation.manifest.shared_explanation_bindings } : {}) };
}
async function readBoundFile(binding) {
  const path = resolve(binding.path), stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || await realpath(path) !== path) fail('P221_REVIEW_SOURCE_PATH_INVALID');
  const bytes = await readFile(path);
  if (sha(bytes) !== binding.sha256) fail('P221_REVIEW_SOURCE_CHANGED', { path });
}

/** Prepare the real canonical merged producer bytes, retaining the complete union denominator. */
export async function prepareReaderReview({ finalNotes, presentation, sourceInventory = [], obligations, visualConfig } = {}) {
  const data = await getReaderPresentationContent(presentation), manifest = presentation.manifest;
  const pages = languages.map(language => {
    const bytes = finalNotes ? noteBytes(finalNotes, language) : presentation[language === 'en' ? 'en' : 'zhCN'];
    if (sha(bytes) !== manifest.targets.notes[language].byte_sha256) fail('P221_REVIEW_FINAL_BYTES_MISMATCH', { language });
    return finalPage(bytes, language, manifest.targets.notes[language].path);
  });
  const visual = visualConfigFor(presentation, pages);
  if (visualConfig && !same(visualConfig, visual)) fail('P221_REVIEW_VISUAL_CONFIG_MISMATCH');
  const expectedDuties = Array.from({ length: 16 }, (_, i) => 'SR-' + String(i + 1).padStart(2, '0'));
  if (obligations && !same(obligations.map(row => typeof row === 'string' ? row : row.id).sort(), expectedDuties)) fail('P221_REVIEW_OBLIGATIONS_INCOMPLETE');
  const targets = manifest.records.map(record => ({ id: record.id, origins: record.origins, applicability: record.applicability,
    source_basis: record.source_basis, original: record.raw, ...(record.obligation_id ? { obligation_id: record.obligation_id } : {}),
    expressions: Object.fromEntries(languages.map(language => [language, record.expressions[language].map(row => {
      const page = pages.find(page => page.language === language), bytes = Buffer.from(page.text);
      if (!page.machine_ranges.some(region => region.section_id === row.section_id && region.from <= row.from && region.to >= row.to)
        || sha(bytes.subarray(row.from, row.to)) !== row.sha256 || row.to <= row.from) fail('P221_REVIEW_TARGET_RANGE_INVALID');
      return { ...location(language, row), text: bytes.subarray(row.from, row.to).toString('utf8') };
    })])) }));
  if (expectedDuties.some(id => !targets.some(row => row.obligation_id === id)) || new Set(targets.map(row => row.id)).size !== targets.length) fail('P221_REVIEW_OBLIGATIONS_INCOMPLETE');
  const extraBindings = [];
  for (const source of sourceInventory) {
    if (source.paper_id !== data.identity.paper_id || !source.source_binding
      || !(data.source_bindings ?? []).some(binding => binding.path === source.source_binding.path && binding.sha256 === source.source_binding.sha256)) fail('P221_SOURCE_INVENTORY_NOT_BOUND');
    await readBoundFile(source.source_binding); extraBindings.push(source.source_binding);
    for (const asset of source.available_assets ?? []) { await readBoundFile(asset); extraBindings.push(asset); }
    const id = 'registered-source:' + hash(source);
    targets.push({ id, origins: ['registered_source_inventory'], applicability: { status: 'assessed', reason: 'Registered source remains in the source-inventory denominator.' },
      source_basis: source.source_binding, original: source, expressions: Object.fromEntries(languages.map(language => [language,
        targets.filter(row => row.origins.includes('source_blocks') && row.original.source_hash === source.source_binding.sha256).flatMap(row => row.expressions[language])])) });
  }
  const gaps = structuredClone(manifest.gaps);
  if (!presentation.abstractContract) gaps.push({ id: 'P221_ABSTRACT_CONTRACT_MISSING', kind: 'not_displayed', owner: 'Writer/Plan08', reason: 'The author abstract source structure, original/translation attribution and separate SR-02 summary have not been bound.' });
  else if (presentation.abstractContract.source_status === 'missing' || presentation.abstractContract.source_completeness !== 'complete') gaps.push({ id: 'P221_ABSTRACT_SOURCE_INCOMPLETE', kind: 'source_unavailable', owner: 'Integrator/Plan08', reason: presentation.abstractContract.reason });
  const allResources = resources(presentation);
  const body = { schema_version: 'phase221-prepared-reading-review-1.0', identity: data.identity, dependencies: manifest.dependencies,
    pages, targets, obligations: expectedDuties, source_inventory: { documents: data.science.source_package.source_documents, blocks: data.science.scientific_details.source_blocks,
      inventory: data.science.scientific_details.inventory, registered_sources: sourceInventory },
    scientific_input: data.science, qualification: data.qualification, visual_config: visual,
    ...(data.reader_support ? { reader_support: data.reader_support } : {}),
    assets: allResources.filter(row => row.kind === 'asset'), reading_records: presentation.readingRecords.map(row => ({ language: row.language, path: row.target_path, text: row.bytes.toString('utf8'), sha256: sha(row.bytes) })),
    support_notes: presentation.supportNotes.map(row => ({ entity_id: row.entity_id ?? null, path: row.target_path ?? row.path, disposition: row.disposition ?? null, text: row.bytes ? row.bytes.toString('utf8') : null, sha256: row.bytes ? sha(row.bytes) : row.byte_sha256 })),
    resources: allResources, gaps, abstract_contract: presentation.abstractContract, rubric_ids: READER_RUBRIC_IDS, criteria_ids: READER_CRITERIA_IDS,
    presentation_sha256: sha(presentation.presentationBytes), review_tools: Object.fromEntries(await Promise.all(['phase221-reading-review.mjs', '../../Schema/phase22/reading-review.schema.json'].map(async path => [path, sha(await readFile(new URL(path, import.meta.url)))]))),
    display_transforms: manifest.ranges.filter(row => row.display_transforms.length).map(row => ({ language: row.language, span_id: row.span_id, display_transforms: row.display_transforms })) };
  const payload = freeze(structuredClone({ ...body, prepared_fingerprint: hash(body) }));
  const prepared = Object.freeze({ schema_version: body.schema_version, prepared_fingerprint: payload.prepared_fingerprint });
  preparedStates.set(prepared, { payload, presentation, extraBindings: structuredClone(extraBindings), resourceHash: hash(allResources), visualHash: hash(visual) });
  return prepared;
}

export function getPreparedReaderReviewPayload(prepared) {
  const state = preparedStates.get(prepared);
  if (!state) fail('P221_REVIEW_PREPARED_REQUIRED');
  return state.payload;
}
export async function assertPreparedReaderReviewCurrent(prepared) {
  const state = preparedStates.get(prepared);
  if (!state) fail('P221_REVIEW_PREPARED_REQUIRED');
  await getReaderPresentationContent(state.presentation);
  for (const [path, expected] of Object.entries(state.payload.review_tools)) if (sha(await readFile(new URL(path, import.meta.url))) !== expected) fail('P221_REVIEW_TOOL_CHANGED');
  if (hash(resources(state.presentation)) !== state.resourceHash || hash(visualConfigFor(state.presentation, state.payload.pages)) !== state.visualHash) fail('P221_REVIEW_RESOURCE_CHANGED');
  for (const binding of state.extraBindings) await readBoundFile(binding);
  return state.payload;
}

function checkLocation(row, payload) {
  const page = payload.pages.find(page => page.language === row.language), bytes = Buffer.from(page?.text ?? '');
  if (!page || row.to <= row.from || !page.machine_ranges.some(region => region.section_id === row.section_id && row.from >= region.from && row.to <= region.to)
    || sha(bytes.subarray(row.from, row.to)) !== row.sha256) fail('P221_REVIEW_LOCATION_INVALID');
}
function checkReview(value, payload) {
  if (value.prepared_fingerprint !== payload.prepared_fingerprint || !same(value.identity, payload.identity)) fail('P221_REVIEW_BINDING_MISMATCH');
  const ranges = value.reviewed_ranges;
  for (const page of payload.pages) for (const region of page.machine_ranges) {
    const selected = ranges.filter(row => row.language === page.language && row.section_id === region.section_id);
    if (selected.length !== 1 || !same(selected[0], region)) fail('P221_REVIEW_BODY_NOT_FULLY_REVIEWED', { language: page.language, region: region.section_id });
  }
  if (ranges.length !== payload.pages.reduce((n, page) => n + page.machine_ranges.length, 0)) fail('P221_REVIEW_BODY_NOT_FULLY_REVIEWED');
  const expectedItems = new Set(payload.targets.flatMap(row => languages.map(language => row.id + ':' + language)));
  for (const item of value.items) {
    const key = item.id + ':' + item.language, target = payload.targets.find(row => row.id === item.id);
    if (!expectedItems.delete(key) || !target) fail('P221_REVIEW_ITEM_COVERAGE');
    if (!same(item.applicability, target.applicability) || !same(item.source_basis, target.source_basis)) fail('P221_REVIEW_SOURCE_DISPOSITION_CHANGED', { id: item.id });
    const required = target.expressions[item.language];
    if (!same(item.locations, required.map(({ text, ...row }) => row))) fail('P221_REVIEW_ITEM_LOCATION_MISMATCH', { id: item.id });
    item.locations.forEach(row => checkLocation(row, payload));
    if (!required.length && item.verdict === 'pass') fail('P221_REVIEW_MISSING_EXPRESSION', { id: item.id });
    if (item.critical && item.visibility !== 'visible' && item.verdict === 'pass') fail('P221_REVIEW_CRITICAL_HIDDEN', { id: item.id });
    if (item.affected_gaps.some(id => !payload.gaps.some(gap => gap.id === id))) fail('P221_REVIEW_GAP_UNBOUND');
    if (item.applicability.status !== 'assessed' && (!target.source_basis.pointer || !nonblank(target.applicability.reason)
      || /^(?:n\/?a|not applicable|not assessable|unknown)[.!\s]*$/i.test(target.applicability.reason))) fail('P221_REVIEW_APPLICABILITY_UNSUPPORTED');
    if (item.verdict !== 'pass' && item.revision_owner === 'none') fail('P221_REVIEW_REPAIR_OWNER_REQUIRED');
  }
  if (expectedItems.size) fail('P221_REVIEW_ITEM_COVERAGE');
  for (const [name, ids] of [['rubric', READER_RUBRIC_IDS], ['criteria', READER_CRITERIA_IDS]]) {
    const expected = new Set(ids.flatMap(id => languages.map(language => id + ':' + language)));
    for (const item of value[name]) {
      if (!expected.delete(item.id + ':' + item.language) || item.locations.some(row => row.language !== item.language)) fail('P221_REVIEW_JUDGMENT_COVERAGE');
      item.locations.forEach(row => checkLocation(row, payload));
      if (item.verdict !== 'pass' && item.revision_owner === 'none') fail('P221_REVIEW_REPAIR_OWNER_REQUIRED');
    }
    if (expected.size) fail('P221_REVIEW_JUDGMENT_COVERAGE');
  }
}
const gate = rows => rows.some(row => row.verdict === 'block') ? 'block' : rows.some(row => row.verdict === 'flag') ? 'flag' : rows.some(row => row.verdict === 'not_run') ? 'not_run' : 'pass';

/** Existing broker control evidence is the only admission for external native observations. */
export async function acceptReaderNativeObservation({ prepared, observationReceipt } = {}) {
  const payload = await assertPreparedReaderReviewCurrent(prepared);
  const { artifactRoot, dispatchContext, runId, artifactId } = observationReceipt ?? {};
  const binding = getRunControlForDispatch({ dispatchContext, runId })?.phase221_native_observation;
  if (!binding || binding.role !== 'control' || binding.artifact_id !== artifactId || resolve(binding.artifact_root) !== resolve(artifactRoot)) fail('P221_NATIVE_CONTROL_REQUIRED');
  const owned = await readOwnedArtifact({ artifactRoot, artifactId });
  if (owned.receipt.run_id !== runId || ['artifact_id', 'role', 'owner_actor_id', 'path', 'revision'].some(key => owned.receipt[key] !== binding[key]) || owned.receipt.sha256 !== binding.payload_sha256) fail('P221_NATIVE_RECEIPT_MISMATCH');
  const value = JSON.parse(owned.bytes.toString('utf8'));
  if (value.schema_version !== 'phase221-native-observation-1.0' || value.prepared_fingerprint !== payload.prepared_fingerprint
    || !same(value.identity, payload.identity) || value.visual_fingerprint !== hash(payload.visual_config)
    || !same(value.files, payload.pages.map(page => ({ language: page.language, path: page.path, sha256: page.byte_sha256 })))) fail('P221_NATIVE_BINDING_MISMATCH');
  if (!['synthetic', 'actual'].includes(value.evidence_mode) || !['human_observation', 'native_tool_observation', 'synthetic'].includes(value.method)
    || !nonblank(value.observer) || !nonblank(value.app_version) || !Array.isArray(value.observations) || !value.observations.length
    || (value.evidence_mode === 'actual' && value.method === 'synthetic')) fail('P221_NATIVE_OBSERVATION_INCOMPLETE');
  if (['evidence_mode', 'method', 'observer'].some(key => value[key] !== binding[key])) fail('P221_NATIVE_OBSERVER_NOT_BOUND');
  for (const item of value.observations) {
    if (!languages.includes(item.language) || !nonblank(item.mode) || !nonblank(item.action) || !nonblank(item.result)
      || !['pass', 'flag', 'block', 'not_run'].includes(item.verdict) || !Array.isArray(item.evidence) || !item.evidence.length) fail('P221_NATIVE_OBSERVATION_INCOMPLETE');
    for (const file of item.evidence) {
      const path = resolve(artifactRoot, file.path), rel = relative(resolve(artifactRoot), path);
      if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) fail('P221_NATIVE_EVIDENCE_PATH');
      await readBoundFile({ path, sha256: file.sha256 });
    }
  }
  if (languages.some(language => !value.observations.some(item => item.language === language))) fail('P221_NATIVE_OBSERVATION_INCOMPLETE');
  const result = Object.freeze({ schema_version: value.schema_version, evidence_mode: value.evidence_mode,
    native_observation_status: gate(value.observations), native_presentation: 'not_run' });
  nativeStates.set(result, { value: freeze(value), prepared, observationReceipt, receipt: owned.receipt });
  return result;
}

/** A model cannot provide the native gate. Semantic evidence must be an actual owned Verifier return. */
export async function assessReaderReview({ prepared, ownedReview, nativeObservation } = {}) {
  try {
    const payload = await assertPreparedReaderReviewCurrent(prepared);
    const { request, receipt, value, currentDependencies } = ownedReview ?? {};
    const { verifyReaderReviewArtifact } = await import('./phase22-language.mjs');
    const provenance = await verifyReaderReviewArtifact({ request, receipt, value, currentDependencies });
    if (!provenance.ok) return provenance;
    const validator = await createPhase22ContractValidator();
    validator.assert('phase22/reading-review-1.0', value);
    if (value.kind !== 'reader_semantic_review') fail('P221_REVIEW_SEMANTIC_RESULT_REQUIRED');
    checkReview(value, payload);
    let native = null;
    if (nativeObservation !== undefined) {
      const state = nativeStates.get(nativeObservation);
      if (!state || state.prepared !== prepared) fail('P221_NATIVE_CAPABILITY_REQUIRED');
      const fresh = await acceptReaderNativeObservation({ prepared, observationReceipt: state.observationReceipt });
      native = nativeStates.get(fresh);
    }
    const structural = payload.targets.flatMap(target => languages.filter(language => !target.expressions[language].length).map(language => ({ id: target.id, language, verdict: 'block' })));
    structural.push(...payload.gaps.filter(row => row.kind !== 'source_unavailable').map(row => ({ id: row.id, verdict: 'block' })));
    const gates = { completeness: gate([...value.items, ...value.criteria.filter(row => row.id === 'C04'), ...structural]),
      readability: gate([...value.rubric, ...value.criteria]), native_presentation: 'not_run' };
    const evidenceMode = provenance.evidence_mode ?? 'unknown';
    const report = freeze({ schema_version: 'phase22/reading-review-1.0', kind: 'reader_assessment', prepared_fingerprint: payload.prepared_fingerprint,
      identity: payload.identity, gates, accepted: false,
      native_observation_status: native ? gate(native.value.observations) : 'not_run',
      native_acceptance_dependency: 'Plan09 must bind its complete actual native matrix to this exact candidate; observation admission alone is not native acceptance.',
      evidence_mode: evidenceMode, native_evidence_mode: native?.value.evidence_mode ?? 'not_run', structural_findings: structural,
      receipt_binding: provenance.receipt_binding ?? provenance.receipt, review_fingerprint: hash(value), limitations: value.limitations });
    validator.assert('phase22/reading-review-1.0', report);
    reviews.set(report, { prepared, ownedReview, nativeObservation, evidenceMode });
    return { ok: true, accepted: report.accepted, review: report, errors: [] };
  } catch (error) { return { ok: false, errors: [{ code: error.code ?? error.message, details: error.details ?? error.errors ?? {} }] }; }
}

/** Scoped invalidation; unchanged machine regions retain review while human edits refresh CAS. */
export async function assertReaderReviewCurrent({ review, prepared, finalNotes, presentation, currentDependencies, visualConfig } = {}) {
  const state = reviews.get(review);
  if (!state || (prepared && prepared !== state.prepared)) fail('P221_REVIEW_CAPABILITY_REQUIRED');
  if (presentation) await getReaderPresentationContent(presentation);
  const { verifyReaderReviewArtifact } = await import('./phase22-language.mjs');
  const verified = await verifyReaderReviewArtifact(state.ownedReview);
  if (!verified.ok) fail(verified.errors[0].code, verified.errors[0].details);
  if (verified.receipt_binding.sha256 !== review.receipt_binding.sha256 || hash(state.ownedReview.value) !== review.review_fingerprint) fail('P221_REVIEW_OWNED_EVIDENCE_CHANGED');
  if (state.nativeObservation) {
    const native = nativeStates.get(state.nativeObservation);
    await acceptReaderNativeObservation({ prepared: state.prepared, observationReceipt: native.observationReceipt });
  }
  const payload = await assertPreparedReaderReviewCurrent(state.prepared), invalidated = new Set(), preimages = {}, relocated_ranges = [];
  const dependencies = currentDependencies ?? presentation?.manifest.dependencies ?? payload.dependencies;
  const scienceKeys = ['basis', 'context', 'science', 'terms', 'views', 'parity', 'registration', 'reviewed_support'];
  if (scienceKeys.some(key => !same(dependencies[key], payload.dependencies[key]))) ['language', 'parity', 'completeness', 'readability', 'native_presentation'].forEach(key => invalidated.add(key));
  for (const page of payload.pages) {
    const bytes = finalNotes ? noteBytes(finalNotes, page.language) : presentation ? presentation[page.language === 'en' ? 'en' : 'zhCN'] : Buffer.from(page.text);
    const current = finalPage(bytes, page.language, page.path); preimages[page.language] = current.byte_sha256;
    if (current.managed_hash !== page.managed_hash) ['completeness', 'readability', 'native_presentation'].forEach(key => invalidated.add(key));
    if (!same(current.cssclasses, page.cssclasses)) invalidated.add('native_presentation');
    for (const target of payload.targets) for (const row of target.expressions[page.language]) {
      const oldRegion = page.machine_ranges.find(region => region.section_id === row.section_id), newRegion = current.machine_ranges.find(region => region.section_id === row.section_id);
      relocated_ranges.push({ id: target.id, ...location(page.language, row), from: row.from - oldRegion.from + newRegion.from, to: row.to - oldRegion.from + newRegion.from });
    }
  }
  if (presentation && hash(resources(presentation)) !== hash(payload.resources)) ['completeness', 'readability', 'native_presentation'].forEach(key => invalidated.add(key));
  if (dependencies.visuals !== payload.dependencies.visuals || dependencies.targets !== payload.dependencies.targets || !same(dependencies.reader_tools, payload.dependencies.reader_tools)) ['completeness', 'readability', 'native_presentation'].forEach(key => invalidated.add(key));
  if (dependencies.presentation_options !== payload.dependencies.presentation_options) ['completeness', 'readability', 'native_presentation'].forEach(key => invalidated.add(key));
  const visual = visualConfig ?? (presentation ? visualConfigFor(presentation, payload.pages) : payload.visual_config);
  if (!same(visual, payload.visual_config) || dependencies.style !== payload.dependencies.style) invalidated.add('native_presentation');
  if (!same(visual.research_map, payload.visual_config.research_map) || !same(visual.shared_explanations, payload.visual_config.shared_explanations)
    || !same(visual.shared_explanation_bindings, payload.visual_config.shared_explanation_bindings)
    || visual.audit_display !== payload.visual_config.audit_display) ['completeness', 'readability', 'native_presentation'].forEach(key => invalidated.add(key));
  // Explicit observed hiding is content loss, not a cosmetic-only change.
  if (visual.machine_content_hidden === true) ['completeness', 'readability', 'native_presentation'].forEach(key => invalidated.add(key));
  return { current: invalidated.size === 0, invalidated: [...invalidated], preimages, relocated_ranges,
    gates: Object.fromEntries(Object.entries(review.gates).map(([key, value]) => [key, invalidated.has(key) ? 'not_run' : value])), accepted: invalidated.size === 0 && review.accepted };
}

/** Return physical evidence for the owned assessment after checking supplied runtime inputs. */
export async function getOwnedReaderReviewEvidence({ review, prepared, ownedReview, runtime, nativeObservationReceipt, preparation } = {}) {
  const state = reviews.get(review);
  if (!state || state.prepared !== prepared) fail('P221_REVIEW_CAPABILITY_REQUIRED');
  await assertReaderReviewCurrent({ review, prepared });
  const actual = state.ownedReview, actualReceipt = actual.receipt, runControl = runtime?.runControl;
  if (ownedReview?.request !== actual.request || !same(ownedReview?.receipt, actualReceipt)
    || hash(ownedReview?.value) !== hash(actual.value) || !same(ownedReview?.currentDependencies, actual.currentDependencies)
    || resolve(runControl?.artifactRoot ?? '') !== resolve(actualReceipt.artifactRoot)
    || runControl?.runId !== actualReceipt.runId) fail('P221_REVIEW_OWNED_EVIDENCE_CHANGED');
  const originalControl = getRunControlForDispatch(actualReceipt)?.phase22_language_binding;
  const suppliedControl = getRunControlForDispatch({ dispatchContext: runControl.dispatchContext, runId: runControl.runId })?.phase22_language_binding;
  if (!originalControl || !same(originalControl, suppliedControl)) fail('P221_REVIEW_OWNED_EVIDENCE_CHANGED');
  const preparedState = preparedStates.get(prepared);
  if (!same(preparation?.sourceInventory ?? [], preparedState.payload.source_inventory.registered_sources)) fail('P221_REVIEW_OWNED_EVIDENCE_CHANGED');
  const bindings = structuredClone(preparedState.extraBindings);
  let nativeReceipt = null;
  if (state.nativeObservation) {
    const native = nativeStates.get(state.nativeObservation), receipt = native.observationReceipt;
    if (!same(nativeObservationReceipt, receipt)) fail('P221_REVIEW_OWNED_EVIDENCE_CHANGED');
    nativeReceipt = { artifactRoot: receipt.artifactRoot, artifactId: receipt.artifactId };
    for (const observation of native.value.observations) for (const file of observation.evidence) {
      bindings.push({ path: resolve(receipt.artifactRoot, file.path), sha256: file.sha256 });
    }
  } else if (nativeObservationReceipt) fail('P221_REVIEW_OWNED_EVIDENCE_CHANGED');
  return { bindings, reviewReceipt: { artifactRoot: actualReceipt.artifactRoot, artifactId: actualReceipt.artifactId }, nativeReceipt };
}
