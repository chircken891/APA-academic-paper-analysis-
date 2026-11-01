import { lstatSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import YAML from 'yaml';
import { PHASE22_COMMIT_PATH } from './phase22-active-version.mjs';
import { fingerprintV3Json } from './semantic-package-validator.mjs';
import { readCurrentVaultContent, assertCurrentVaultContent, readCurrentRegisteredBytes, readCurrentRegisteredEntries } from './current-vault-content.mjs';

const fail = (code, details = {}) => { throw Object.assign(new Error(code), { code, details }); };
const POLICY = 'current-shared-nodes-1.0';
const registries = new WeakMap();
const bind = (root, snapshot, registry, policy) => {
  registries.set(registry, { root, snapshot, policy, fingerprint: fingerprintV3Json(registry) });
  return registry;
};

/** Only this process's current, unchanged committed read can authorize a configured render. */
export function assertCommittedReadingFirstKnowledgeRegistry({ vaultRoot, registry, policy, paths = [] } = {}) {
  const record = registry && typeof registry === 'object' ? registries.get(registry) : undefined;
  if (typeof vaultRoot !== 'string' || !vaultRoot || !record || resolve(vaultRoot) !== record.root
    || (policy !== undefined && policy !== record.policy)
    || fingerprintV3Json(registry) !== record.fingerprint) fail('RF_KNOWLEDGE_REGISTRY_NOT_TRUSTED');
  if (record.snapshot) assertCurrentVaultContent(record.snapshot, { paths });
  else {
    try {
      lstatSync(resolve(record.root, PHASE22_COMMIT_PATH));
    } catch (error) {
      if (error.code === 'ENOENT' && lstatSync(record.root).isDirectory()) return;
      throw error;
    }
    fail('RF_KNOWLEDGE_REGISTRY_NOT_TRUSTED');
  }
}

/** Build reuse candidates from the committed inventory and current registered content, never from a vault-wide scan.
 * A supplied `binding` (reading_first_binding, run control or prepared run) supplies its frozen policy and vault root. */
export async function readCommittedReadingFirstKnowledgeRegistry({ vaultRoot, policy, binding } = {}) {
  if (binding !== undefined) {
    const frozen = (binding?.runControl?.reading_first_binding ?? binding?.reading_first_binding ?? binding)?.configured_setup?.knowledge_registry;
    if (!frozen) fail('RF_KNOWLEDGE_REGISTRY_BINDING_POLICY_REQUIRED');
    if (policy !== undefined && policy !== frozen.policy) fail('RF_KNOWLEDGE_REGISTRY_POLICY_MISMATCH');
    if (vaultRoot !== undefined && typeof frozen.vault_root === 'string' && resolve(vaultRoot) !== resolve(frozen.vault_root)) fail('RF_KNOWLEDGE_REGISTRY_ROOT_MISMATCH');
    policy = frozen.policy; vaultRoot ??= frozen.vault_root;
  }
  policy ??= POLICY;
  if (typeof vaultRoot !== 'string' || !vaultRoot) fail('RF_KNOWLEDGE_REGISTRY_ROOT_REQUIRED');
  if (['committed-generation-1.0', 'committed-shared-nodes-1.0'].includes(policy)) fail('READING_BINDING_RETIRED');
  if (policy !== POLICY) fail('RF_KNOWLEDGE_REGISTRY_POLICY_INVALID');
  const root = resolve(vaultRoot);
  if (!lstatSync(root).isDirectory()) fail('RF_KNOWLEDGE_REGISTRY_ROOT_REQUIRED');
  try {
    lstatSync(resolve(root, PHASE22_COMMIT_PATH));
  } catch (error) {
    if (error.code === 'ENOENT') return bind(root, null, [], policy);
    throw error;
  }
  const snapshot = await readCurrentVaultContent({ vaultRoot: root });
  if (!snapshot.ok) fail('RF_KNOWLEDGE_REGISTRY_COMMITTED_INVALID', { errors: snapshot.errors });
  assertCurrentVaultContent(snapshot);
  const currentContents = readCurrentRegisteredEntries(snapshot, snapshot.generation.shared_nodes.map(node => node.path));
  const objects = new Map(snapshot.generation.objects.map(row => [row.path, row]));
  const registry = snapshot.generation.shared_nodes.map(node => {
    const object = objects.get(node.path);
    if (object?.kind !== 'support') fail('RF_KNOWLEDGE_REGISTRY_BINDING_INVALID', { path: node.path });
    const entry = currentContents.get(node.path);
    if (!entry) {
      if (!snapshot.diagnostics.some(row => row.path === node.path)) fail('RF_KNOWLEDGE_REGISTRY_BINDING_INVALID', { path: node.path });
      return { id: node.entity_id, canonical_key: node.entity_id, title: basename(node.path, '.md'), aliases: [], path: node.path,
        unavailable: true, current_content: true };
    }
    const bytes = entry.bytes;
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
    const document = front && YAML.parseDocument(front[1], { uniqueKeys: true });
    if (!document || document.errors.length || !YAML.isMap(document.contents)) fail('RF_KNOWLEDGE_REGISTRY_METADATA_INVALID', { path: node.path });
    const metadata = document.toJS({ maxAliasCount: 100 });
    const id = metadata.knowledge_id ?? metadata.measure_id ?? metadata.concept_id ?? node.entity_id;
    const canonical = metadata.canonical_key ?? metadata.measure_id ?? metadata.concept_id ?? id;
    const aliases = metadata.aliases ?? [];
    if (typeof id !== 'string' || !id || typeof canonical !== 'string' || !canonical
      || !Array.isArray(aliases) || aliases.some(value => typeof value !== 'string')) {
      return { id: node.entity_id, canonical_key: node.entity_id, title: basename(node.path, '.md'), aliases: [], path: node.path,
        unavailable: true, current_content: true };
    }
    return { id, canonical_key: canonical, title: basename(node.path, '.md'), aliases, path: node.path,
      ...(typeof metadata.language === 'string' ? { language: metadata.language } : {}), content,
      current_content: true, content_sha256: entry.sha256 };
  });
  assertCurrentVaultContent(snapshot);
  return bind(root, snapshot, registry, policy);
}

/** Preview-only access to a registered asset under the current-content policy. */
export function readCommittedReadingFirstRegistryResource({ vaultRoot, registry, path } = {}) {
  assertCommittedReadingFirstKnowledgeRegistry({ vaultRoot, registry });
  const record = registries.get(registry);
  if (!record.snapshot) fail('RF_KNOWLEDGE_REGISTRY_ASSET_UNREGISTERED', { path });
  if (!record.snapshot.generation.objects.some(row => row.kind === 'asset' && row.path === path)) fail('RF_KNOWLEDGE_REGISTRY_ASSET_UNREGISTERED', { path });
  return readCurrentRegisteredBytes(record.snapshot, path);
}

/** Expose only registered paper paths for preview navigation, without authorizing paper reads. */
export function inspectCommittedReadingFirstRegistry({ vaultRoot, registry } = {}) {
  assertCommittedReadingFirstKnowledgeRegistry({ vaultRoot, registry });
  const { snapshot } = registries.get(registry);
  const info = { generation_id: snapshot?.generation_id ?? null,
    paper_paths: snapshot ? snapshot.generation.papers.flatMap(paper => Object.values(paper.paths)) : [],
    asset_paths: snapshot ? snapshot.generation.objects.filter(row => row.kind === 'asset').map(row => row.path) : [] };
  if (snapshot) assertCurrentVaultContent(snapshot);
  return info;
}
