import { createHash, createPublicKey, verify } from 'node:crypto';
import { open, lstat, realpath } from 'node:fs/promises';
import { resolve, relative, sep, join, dirname, basename, isAbsolute } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { fingerprintV3Json as hash } from './semantic-package-validator.mjs';
import { createPhase22ContractValidator } from './phase22-contract-loader.mjs';
import { decodeWholePaperArtifact } from './whole-paper-storage.mjs';

const capabilities = new WeakMap();
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const fail = (code, details = {}) => { throw Object.assign(new Error(code), { code, details }); };
const inside = (root, target) => { const r = relative(root, target); return r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r); };
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value);
const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino) });
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function safeRelative(path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || isAbsolute(path) || /[\x00-\x1f<>:"|?*]/.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('P221_HISTORY_PATH_INVALID', { path });
  return path;
}
async function observe(path) {
  path = resolve(path);
  const stat = await lstat(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || await realpath(path) !== path) fail('P221_HISTORY_FILE_INVALID', { path });
  const file = await open(path, 'r');
  try {
    const before = await file.stat({ bigint: true });
    const bytes = await file.readFile();
    const after = await file.stat({ bigint: true });
    if (!same(identity(stat), identity(before)) || !same(identity(before), identity(after))
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || !same(identity(after), identity(await lstat(path, { bigint: true })))) fail('P221_HISTORY_DEPENDENCY_CHANGED', { path });
    return { path, sha256: digest(bytes), byte_length: bytes.length, identity: identity(after), bytes };
  } finally { await file.close(); }
}
const bindingOf = ({ bytes, ...binding }) => binding;
function parse(bytes, path) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('P221_HISTORY_JSON_INVALID', { path }); }
}
function logical(observed) {
  const value = parse(observed.bytes, observed.path);
  return value.storage_contract ? decodeWholePaperArtifact(observed.bytes, { expectedKind: value.logical_kind }).value : value;
}
function verifyGrant(grant, anchor, root, run) {
  try {
    const key = Buffer.from(anchor.public_key, 'base64'), signature = Buffer.from(grant?.signature ?? '', 'base64');
    if (key.toString('base64') !== anchor.public_key || signature.toString('base64') !== grant?.signature
      || grant.payload.schema_version !== 'phase22-controller-grant-1.0' || grant.payload.vault_root !== root || grant.payload.run_id !== run
      || grant.key_fingerprint !== digest(key)
      || !verify(null, Buffer.from(hash(grant.payload)), createPublicKey({ key, format: 'der', type: 'spki' }), signature)) throw new Error();
  } catch { fail('P221_HISTORY_SIGNATURE_INVALID'); }
}

/** Verify a signed historical 1.0 envelope without executing old code or restoring any current P22 capability.
 * registration is {vaultRoot, run, bundle_sha256?}; sourceRoots are explicit allowed absolute source roots.
 * trustAnchor must arrive independently from the Controller, never from the registration itself.
 */
export async function readHistoricalReaderInput({ registration, trustAnchor, sourceRoots } = {}) {
  if (!trustAnchor) fail('P221_HISTORY_TRUST_REQUIRED');
  if (!registration || typeof registration.vaultRoot !== 'string' || !id(registration.run)) fail('P221_HISTORY_REGISTRATION_REQUIRED');
  const root = resolve(registration.vaultRoot), run = registration.run;
  if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) fail('P221_HISTORY_PATH_INVALID', { path: root });
  if (trustAnchor.schema_version !== 'phase22-controller-trust-1.0' || trustAnchor.vault_root !== root
    || trustAnchor.run_id !== run || typeof trustAnchor.public_key !== 'string') fail('P221_HISTORY_TRUST_INVALID');
  if (!Array.isArray(sourceRoots) || !sourceRoots.length) fail('P221_HISTORY_SOURCE_ROOTS_REQUIRED');
  const roots = await Promise.all(sourceRoots.map(async path => {
    if (typeof path !== 'string' || !isAbsolute(path)) fail('P221_HISTORY_PATH_INVALID', { path });
    const target = resolve(path);
    if (await realpath(target) !== target || !(await lstat(target)).isDirectory()) fail('P221_HISTORY_PATH_INVALID', { path });
    return target;
  }));
  const own = [], source = new Map();
  const capture = async path => { const value = await observe(path); own.push(bindingOf(value)); return value; };
  const prefix = '.apa-v3/phase22/runs/' + run + '/';
  const pointerFile = await capture(join(root, prefix, 'CURRENT.json'));
  const pointer = parse(pointerFile.bytes, pointerFile.path);
  if (!same(Object.keys(pointer).sort(), ['authority', 'bundle', 'controller_grant', 'run_id', 'schema_version', 'vault_root'])
    || pointer.schema_version !== 'phase22-publication-registration-1.0' || pointer.run_id !== run || pointer.vault_root !== root
    || !pointer.bundle?.path?.startsWith(prefix)) fail('P221_HISTORY_REGISTRATION_INVALID');
  safeRelative(pointer.bundle.path);
  verifyGrant(pointer.controller_grant, trustAnchor, root, run);
  const { controller_grant: grant, ...body } = pointer;
  if (grant.payload.kind !== 'registration' || grant.payload.registration_hash !== hash(body)) fail('P221_HISTORY_SIGNATURE_INVALID');
  const stored = await capture(join(root, pointer.bundle.path));
  if (stored.sha256 !== pointer.bundle.sha256 || registration.bundle_sha256 && stored.sha256 !== registration.bundle_sha256) fail('P221_HISTORY_BUNDLE_CHANGED');
  const bundle = parse(stored.bytes, stored.path);
  const separateOutputs = bundle.schema_version === 'phase22-registered-publication-2.0';
  if ((!separateOutputs && bundle.schema_version !== 'phase22-registered-publication-1.0') || !id(bundle.transaction_id)
    || bundle.run_id !== run || bundle.vault_root !== root || !bundle.source_bindings?.length || !bundle.tool_bindings?.length
    || !bundle.control_snapshot) fail('P221_HISTORY_BUNDLE_INVALID');
  for (const expected of bundle.source_bindings) {
    if (!isAbsolute(expected.path) || !roots.some(allowed => inside(allowed, resolve(expected.path)))) fail('P221_HISTORY_SOURCE_OUTSIDE_ROOTS', { path: expected.path });
    if (source.has(expected.path)) fail('P221_HISTORY_SOURCE_DUPLICATE', { path: expected.path });
    const observed = await capture(expected.path);
    if (!same(bindingOf(observed), expected)) fail('P221_HISTORY_DEPENDENCY_CHANGED', { path: expected.path });
    source.set(expected.path, observed);
  }
  // Schemas are data, and are usable only while their exact signed original bytes match.
  // A changed schema needs a named version adapter; a changed implementation is reported as drift.
  const toolDrift = [], schemas = new Set();
  for (const expected of bundle.tool_bindings) {
    let observed;
    try { observed = await observe(expected.path); } catch (error) {
      toolDrift.push({ path: expected.path, original_sha256: expected.sha256, current_sha256: null, status: 'unavailable', code: error.code });
    }
    const schema = basename(expected.path).endsWith('.schema.json');
    if (schema) {
      if (!observed || observed.sha256 !== expected.sha256) fail('P221_HISTORY_SCHEMA_VERSION_UNAVAILABLE', { path: expected.path });
      schemas.add(basename(expected.path)); own.push(bindingOf(observed));
    }
    if (observed && !same(bindingOf(observed), expected)) toolDrift.push({ path: expected.path,
      original_sha256: expected.sha256, current_sha256: observed.sha256, status: observed.sha256 === expected.sha256 ? 'identity_changed' : 'changed' });
  }
  for (const name of ['reading-basis', 'render-context', 'language-view', 'parity-review', 'review-manifest', 'publication-transaction', 'active-index']) {
    if (!schemas.has(name + '.schema.json')) fail('P221_HISTORY_SCHEMA_VERSION_UNAVAILABLE', { schema: name });
  }
  const schemaDir = dirname(bundle.tool_bindings.find(row => basename(row.path) === 'reading-basis.schema.json').path);
  const validator = await createPhase22ContractValidator(schemaDir);
  validator.assert('phase22/review-manifest-1.0', bundle.reviewManifest);
  const originalOutputs = [], inventory = [];
  for (const { bytes_base64: encoded, output_path: outputPath, ...row } of bundle.plan.inventory) {
    safeRelative(row.path);
    let bytes;
    if (separateOutputs) {
      safeRelative(outputPath);
      const outputPrefix = pointer.bundle.path.slice(0, pointer.bundle.path.lastIndexOf('/') + 1) + 'outputs/';
      if (!outputPath.startsWith(outputPrefix)) fail('P221_HISTORY_OUTPUT_CHANGED', { path: row.path });
      try { bytes = (await capture(join(root, outputPath))).bytes; }
      catch { fail('P221_HISTORY_OUTPUT_CHANGED', { path: row.path }); }
    } else {
      bytes = Buffer.from(encoded, 'base64');
      if (bytes.toString('base64') !== encoded) fail('P221_HISTORY_OUTPUT_CHANGED', { path: row.path });
    }
    if (digest(bytes) !== row.byte_sha256 || bytes.length !== row.byte_length) fail('P221_HISTORY_OUTPUT_CHANGED', { path: row.path });
    originalOutputs.push({ ...row, ...(row.kind === 'paper' || row.kind === 'support' ? { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) } : {}), bytes_base64: bytes.toString('base64') });
    inventory.push({ ...row, observed_sha256: digest(bytes) });
  }
  if (bundle.plan.run_id !== run || bundle.plan.vault_root !== root || hash({ ...bundle.plan, inventory }) !== bundle.plan_fingerprint) fail('P221_HISTORY_PLAN_CHANGED');
  if (pointer.authority) {
    safeRelative(pointer.authority.path);
    if (!pointer.authority.path.startsWith(prefix)) fail('P221_HISTORY_AUTHORITY_INVALID');
    const observed = await capture(join(root, pointer.authority.path)), value = parse(observed.bytes, observed.path);
    if (observed.sha256 !== pointer.authority.sha256 || value.schema_version !== 'phase22-registered-publication-authority-1.0'
      || value.run_id !== run || value.vault_root !== root || value.bundle_sha256 !== stored.sha256) fail('P221_HISTORY_AUTHORITY_INVALID');
    verifyGrant(value.controller_grant, trustAnchor, root, run);
    if (!same(value.controller_grant.payload, { schema_version: 'phase22-controller-grant-1.0', kind: 'publication', vault_root: root,
      run_id: run, plan_fingerprint: bundle.plan_fingerprint, binding_hash: hash(value.binding),
      output_inventory_hash: bundle.plan.hashes.output_inventory_hash, bundle_sha256: stored.sha256 })) fail('P221_HISTORY_AUTHORITY_INVALID');
  }
  const { runtime, language, source: sourceControl, integrator } = bundle.control_snapshot;
  const { checkpoint_fingerprint: checkpointFingerprint, ...checkpointBody } = runtime;
  if (runtime.schema_version !== 'phase22-runtime-checkpoint-1.0' || runtime.binding_fingerprint !== hash(language)
    || checkpointFingerprint !== hash(checkpointBody)
    || runtime.dependencies.basis !== bundle.reviewManifest.basis_fingerprint
    || runtime.dependencies.context !== bundle.reviewManifest.context_fingerprint) fail('P221_HISTORY_RUNTIME_INVALID');
  const receipts = new Map();
  for (const observed of source.values()) if (basename(dirname(observed.path)) === '.phase21-receipts') {
    const receipt = parse(observed.bytes, observed.path), receiptRoot = dirname(dirname(observed.path));
    safeRelative(receipt.path);
    if (basename(observed.path) !== encodeURIComponent(receipt.artifact_id) + '.json' || receipt.run_id !== run
      || !receipt.owner_actor_id || !receipt.role || !receipt.revision) fail('P221_HISTORY_RECEIPT_INVALID', { path: observed.path });
    const artifact = source.get(resolve(receiptRoot, receipt.path));
    if (!artifact || artifact.sha256 !== receipt.sha256 || artifact.byte_length !== receipt.byte_length) fail('P221_HISTORY_RECEIPT_INVALID', { path: observed.path });
    receipts.set(resolve(receiptRoot, '.phase21-receipts', encodeURIComponent(receipt.artifact_id) + '.json'), { receipt, artifact, receipt_ref: bindingOf(observed) });
  }
  const requireReceipt = (receiptRoot, expected) => {
    const found = receipts.get(resolve(receiptRoot, '.phase21-receipts', encodeURIComponent(expected.artifact_id) + '.json'));
    if (!found || !['artifact_id', 'owner_actor_id', 'role', 'path', 'revision', 'sha256', 'byte_length'].every(key => expected[key] === undefined || same(expected[key], found.receipt[key]))) fail('P221_HISTORY_OWNER_MISMATCH', { artifact_id: expected.artifact_id });
    return found;
  };
  if (sourceControl.run_id !== run || !sourceControl.required_artifacts?.length) fail('P221_HISTORY_SOURCE_CONTROL_INVALID');
  for (const expected of sourceControl.required_artifacts) requireReceipt(runtime.input_artifact_root, expected);
  const integratorArtifact = requireReceipt(runtime.input_artifact_root, { ...integrator, sha256: integrator.payload_sha256 });
  for (const seed of Object.values(language.revision_seeds ?? {})) requireReceipt(runtime.artifact_root, seed.receipt);
  const views = {}, viewRefs = {}, tasks = [...Object.values(language.task_bindings ?? {}), ...(language.revision_bindings ?? []).map(row => row.task)];
  let parity;
  if (!same(Object.keys(runtime.active_task_ids).sort(), ['en', 'verifier', 'zh-CN'])) fail('P221_HISTORY_LANGUAGE_INCOMPLETE');
  for (const [name, taskId] of Object.entries(runtime.active_task_ids)) {
    const task = tasks.find(row => row.task_id === taskId), observed = runtime.tasks.find(row => row.task_id === taskId);
    if (!task || observed?.status !== 'completed' || !observed.call_id || !observed.return_id) fail('P221_HISTORY_LANGUAGE_INCOMPLETE', { taskId });
    const found = requireReceipt(runtime.artifact_root, { ...task, path: task.artifact_path });
    safeRelative(task.native_path);
    if (source.get(resolve(runtime.artifact_root, task.native_path))?.sha256 !== found.receipt.sha256) fail('P221_HISTORY_NATIVE_BYTES_CHANGED', { taskId });
    const value = logical(found.artifact);
    validator.assert(name === 'verifier' ? 'phase22/parity-review-1.0' : 'phase22/language-view-1.0', value);
    if (value.basis_fingerprint !== runtime.dependencies.basis || value.context_fingerprint !== runtime.dependencies.context
      || value.identity.run_id !== run || !same(value.identity, bundle.reviewManifest.identity)) fail('P221_HISTORY_LANGUAGE_BINDING_INVALID', { taskId });
    const events = runtime.events.map(row => row.event ?? row), call = events.find(row => row.payload?.type === 'function_call' && row.payload.call_id === observed.call_id);
    const returned = events.find(row => row.payload?.type === 'function_call_output' && row.payload.call_id === observed.call_id);
    const completed = events.find(row => row.payload?.type === 'phase22_host_completion' && row.payload.return_id === observed.return_id);
    if (!call || !returned || !completed || completed.payload.observed_from !== 'collaboration.final_answer'
      || completed.payload.host_task_name !== observed.host_task_name || completed.payload.raw_return !== observed.raw_return) fail('P221_HISTORY_HOST_EVIDENCE_INVALID');
    const args = typeof call.payload.arguments === 'string' ? JSON.parse(call.payload.arguments) : call.payload.arguments;
    const result = typeof returned.payload.output === 'string' ? JSON.parse(returned.payload.output) : returned.payload.output;
    if (call.payload.name !== 'collaboration.spawn_agent' || args.task_name !== task.task_name || args.model !== runtime.requested_model
      || args.reasoning_effort !== runtime.requested_reasoning || args.fork_turns !== 'none' || result.task_name !== observed.host_task_name
      || !observed.host_task_name.endsWith('/' + task.task_name)) fail('P221_HISTORY_HOST_EVIDENCE_INVALID');
    if (name === 'verifier') parity = value;
    else {
      if (value.language !== name || hash(value) !== observed.accepted_fingerprint) fail('P221_HISTORY_VIEW_CHANGED');
      views[name] = value; viewRefs[name] = { ...bindingOf(found.artifact), receipt: found.receipt, receipt_ref: found.receipt_ref };
    }
  }
  if (!same(parity.view_fingerprints, { en: hash(views.en), 'zh-CN': hash(views['zh-CN']) })) fail('P221_HISTORY_PARITY_BINDING_INVALID');
  const byHash = sha => [...source.values()].find(row => row.sha256 === sha);
  const scienceFile = byHash(bundle.reviewManifest.dependencies.scientific_input_bytes), producerFile = byHash(bundle.reviewManifest.dependencies.producer_bytes);
  if (!scienceFile || !producerFile) fail('P221_HISTORY_SCIENCE_MISSING');
  const rawScience = logical(scienceFile), producer = logical(producerFile);
  const profiles = new Map([
    ['phase21-pre-render-handoff-1.0', 'phase21-scientific-input-1.0'],
    ['phase21-pre-render-handoff-workbook-1.0', 'phase21-scientific-input-workbook-1.0'],
    ['phase21-pre-render-handoff-whole-paper-1.0', 'phase21-scientific-input-whole-paper-1.0'],
    ['phase21-pre-render-handoff-source-evidence-1.0', 'phase21-scientific-input-source-evidence-1.0'],
  ]);
  if (profiles.get(producer.schema_version) !== rawScience.schema_version) fail('P221_HISTORY_SCIENCE_VERSION_UNSUPPORTED', { producer: producer.schema_version, science: rawScience.schema_version });
  const science = rawScience, manifest = science.scientific_details?.required_semantic_units;
  if (!Array.isArray(manifest) || hash(manifest) !== bundle.reviewManifest.dependencies.required_semantic_unit_manifest) fail('P221_HISTORY_MANIFEST_INVALID');
  // Named 1.0 semantic bindings: the signed receipt chain preserves the old
  // qualification; it is not a new scientific evaluation under today's tools.
  const { input_fingerprint: inputFingerprint, ...scienceBody } = science;
  const { handoff_fingerprint: handoffFingerprint, ...producerBody } = producer;
  if (inputFingerprint !== hash(scienceBody) || handoffFingerprint !== hash(producerBody)
    || producer.scientific_input_fingerprint !== inputFingerprint || bundle.reviewManifest.dependencies.scientific_input !== inputFingerprint
    || producer.required_semantic_unit_manifest_fingerprint !== hash(manifest)
    || !same(science.identity, producer.identity) || !same(science.identity, bundle.reviewManifest.identity)
    || !same(producer.source_status, science.scientific_details.source_status)
    || producer.scientific_completeness !== science.scientific_details.source_status.completeness) fail('P221_HISTORY_SCIENCE_BINDING_INVALID');
  for (const role of ['evidence', 'methods', 'results', 'interpretation', 'scientific-reading', 'integration']) {
    if (!producer.role_artifacts?.[role]) fail('P221_HISTORY_SOURCE_ROLE_MISSING', { role });
    const found = requireReceipt(runtime.input_artifact_root, { ...producer.role_artifacts[role], role });
    if (bundle.reviewManifest.dependencies['role:' + role] !== found.receipt.sha256) fail('P221_HISTORY_SOURCE_ROLE_CHANGED', { role });
  }
  const sourceCheck = requireReceipt(runtime.input_artifact_root, { artifact_id: sourceControl.integration_prerequisites.source_check_artifact_id,
    role: 'source-check', sha256: producer.source_check.artifact_sha256 });
  if (bundle.reviewManifest.dependencies.source_check_receipt !== sourceCheck.receipt.sha256) fail('P221_HISTORY_SOURCE_ROLE_CHANGED', { role: 'source-check' });
  if (producer.scientific_evidence_qualification) {
    const { qualification_fingerprint: qualificationFingerprint, ...qualificationBody } = producer.scientific_evidence_qualification;
    if (hash(qualificationBody) !== qualificationFingerprint || qualificationBody.scientific_input_fingerprint !== inputFingerprint
      || qualificationBody.source_check_receipt_sha256 !== sourceCheck.receipt.sha256) fail('P221_HISTORY_QUALIFICATION_CHANGED');
  }
  const presentations = [...receipts.values()].filter(row => row.receipt.role === 'integration' && row.artifact.path.endsWith('.json'))
    .map(row => ({ ...row, value: logical(row.artifact) })).filter(row => row.value.schema_version === 'phase22-source-presentation-1.0');
  if (presentations.length > 1) fail('P221_HISTORY_PRESENTATION_AMBIGUOUS');
  let presentation = null;
  if (presentations.length) {
    const { value, artifact } = presentations[0];
    if (!same(value.identity, science.identity) || value.scientific_input_fingerprint !== inputFingerprint
      || !Array.isArray(value.assets) || !Array.isArray(value.immutable_ranges)) fail('P221_HISTORY_PRESENTATION_INVALID');
    const blocks = new Map(science.scientific_details.source_blocks.map(row => [row.source_block_id, row]));
    const assets = value.assets.map(asset => {
      const found = requireReceipt(runtime.input_artifact_root, { artifact_id: asset.artifact_id, role: 'source-asset', sha256: asset.byte_sha256, byte_length: asset.byte_length });
      if (asset.origin !== 'registered_source_asset' || !asset.source_block_ids?.length
        || asset.source_block_ids.some(id => blocks.get(id)?.source_document_id !== asset.source_document_id || blocks.get(id)?.source_hash !== asset.source_hash)) fail('P221_HISTORY_PRESENTATION_INVALID');
      const output = originalOutputs.find(row => row.kind === 'asset' && row.byte_sha256 === asset.byte_sha256);
      return { ...asset, artifact_ref: bindingOf(found.artifact), target_path: output?.path ?? null };
    });
    for (const entry of value.immutable_ranges) {
      const block = blocks.get(entry.source_block_id);
      if (!block || !['formula', 'code'].includes(entry.kind) || !Number.isInteger(entry.start) || !Number.isInteger(entry.end)
        || entry.start < 0 || entry.end <= entry.start || entry.end > block.text.length
        || digest(Buffer.from(block.text.slice(entry.start, entry.end))) !== entry.text_sha256) fail('P221_HISTORY_PRESENTATION_INVALID');
    }
    presentation = { ...value, manifest_ref: bindingOf(artifact), assets };
  }
  const descriptor = freeze({ schema_version: 'phase221-historical-reader-input-1.0', identity: bundle.reviewManifest.identity,
    historical_only: true, publishable: false, budget_authority: false,
    registration: { vault_root: root, run_id: run, pointer: bindingOf(pointerFile), bundle: bindingOf(stored), trust_anchor: structuredClone(trustAnchor) },
    qualification: { scientific_completeness: producer.scientific_completeness ?? science.scientific_details?.scientific_completeness ?? null,
      source_status: science.scientific_details?.source_status ?? null, parser_evaluation_disposition: producer.parser_evaluation_disposition ?? producer.parser_comparison ?? null,
      scientific_evidence_qualification: producer.scientific_evidence_qualification ?? null,
      provenance_limits: bundle.reviewManifest.provenance_limits, evidence_mode: runtime.evidence_mode },
    original_tool_manifest: bundle.tool_bindings, tool_drift: toolDrift, source_bindings: bundle.source_bindings,
    receipts: [...receipts.values()].map(row => ({ ...row.receipt, receipt_ref: row.receipt_ref, artifact_ref: bindingOf(row.artifact) })),
    original_runtime: runtime, original_outputs: originalOutputs, original_review: bundle.reviewManifest,
    science, science_ref: bindingOf(scienceFile), producer, producer_ref: bindingOf(producerFile),
    core: science.core, reading_card: science.reading_card, required_manifest: manifest,
    source_presentation: presentation,
    integrator: logical(integratorArtifact.artifact), views, view_refs: viewRefs, parity });
  capabilities.set(descriptor, { bindings: own });
  await assertHistoricalReaderInputCurrent(descriptor);
  return descriptor;
}

/** No current accepted-object registration is performed. Only this module's distinct capability is recognized. */
export async function assertHistoricalReaderInputCurrent(descriptor) {
  const record = capabilities.get(descriptor);
  if (!record) fail('P221_HISTORY_NOT_VERIFIED');
  for (const expected of record.bindings) {
    let current;
    try { current = bindingOf(await observe(expected.path)); } catch (error) { fail('P221_HISTORY_DEPENDENCY_CHANGED', { path: expected.path, cause: error.code }); }
    if (!same(current, expected)) fail('P221_HISTORY_DEPENDENCY_CHANGED', { path: expected.path });
  }
  return true;
}

export async function getHistoricalReaderContent(descriptor) {
  await assertHistoricalReaderInputCurrent(descriptor);
  return descriptor;
}
