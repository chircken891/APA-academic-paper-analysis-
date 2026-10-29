import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import YAML from 'yaml';
import { PHASE22_COMMIT_PATH, readCommittedGeneration, assertCommittedSnapshot, readCommittedSharedNodes,
  assertCommittedSharedNodes, readCommittedSharedNodeContents, readCommittedSharedAsset } from './phase22-active-version.mjs';
import { fingerprintV3Json } from './semantic-package-validator.mjs';
import { readCurrentVaultContent, assertCurrentVaultContent, readCurrentRegisteredBytes, readCurrentRegisteredEntries } from './current-vault-content.mjs';

const fail = (code, details = {}) => { throw Object.assign(new Error(code), { code, details }); };
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
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
  if (record.snapshot) {
    if (record.policy === 'current-shared-nodes-1.0') assertCurrentVaultContent(record.snapshot, { paths });
    else if (record.policy === 'committed-shared-nodes-1.0') assertCommittedSharedNodes(record.snapshot);
    else assertCommittedSnapshot(record.snapshot);
  } else {
    try {
      lstatSync(resolve(record.root, PHASE22_COMMIT_PATH));
    } catch (error) {
      if (error.code === 'ENOENT' && lstatSync(record.root).isDirectory()) return;
      throw error;
    }
    fail('RF_KNOWLEDGE_REGISTRY_NOT_TRUSTED');
  }
}

/** Build reuse candidates from the committed inventory, never from a vault-wide scan. */
export async function readCommittedReadingFirstKnowledgeRegistry({ vaultRoot, policy = 'committed-generation-1.0' } = {}) {
  if (typeof vaultRoot !== 'string' || !vaultRoot) fail('RF_KNOWLEDGE_REGISTRY_ROOT_REQUIRED');
  if (!['committed-generation-1.0', 'committed-shared-nodes-1.0', 'current-shared-nodes-1.0'].includes(policy)) fail('RF_KNOWLEDGE_REGISTRY_POLICY_INVALID');
  const root = resolve(vaultRoot);
  if (!lstatSync(root).isDirectory()) fail('RF_KNOWLEDGE_REGISTRY_ROOT_REQUIRED');
  try {
    lstatSync(resolve(root, PHASE22_COMMIT_PATH));
  } catch (error) {
    if (error.code === 'ENOENT') return bind(root, null, [], policy);
    throw error;
  }
  const scoped = policy === 'committed-shared-nodes-1.0';
  const current = policy === 'current-shared-nodes-1.0';
  const snapshot = await (current ? readCurrentVaultContent({ vaultRoot: root }) : scoped ? readCommittedSharedNodes({ vaultRoot: root }) : readCommittedGeneration({ vaultRoot: root }));
  if (!snapshot.ok) fail('RF_KNOWLEDGE_REGISTRY_COMMITTED_INVALID', { errors: snapshot.errors });
  const observed = current ? assertCurrentVaultContent(snapshot) : scoped ? assertCommittedSharedNodes(snapshot) : assertCommittedSnapshot(snapshot);
  const scopedContents = scoped ? readCommittedSharedNodeContents(snapshot) : null;
  const currentContents = current ? readCurrentRegisteredEntries(snapshot, snapshot.generation.shared_nodes.map(node => node.path)) : null;
  const objects = new Map(snapshot.generation.objects.map(row => [row.path, row]));
  const registry = snapshot.generation.shared_nodes.map(node => {
    const object = objects.get(node.path);
    if (object?.kind !== 'support') fail('RF_KNOWLEDGE_REGISTRY_BINDING_INVALID', { path: node.path });
    let entry;
    if (current) {
      entry = currentContents.get(node.path);
      if (!entry) {
        if (!snapshot.diagnostics.some(row => row.path === node.path)) fail('RF_KNOWLEDGE_REGISTRY_BINDING_INVALID', { path: node.path });
        return { id: node.entity_id, canonical_key: node.entity_id, title: basename(node.path, '.md'), aliases: [], path: node.path,
          unavailable: true, current_content: true };
      }
    }
    const bytes = current ? entry.bytes : scoped ? scopedContents.get(node.path) : readFileSync(resolve(observed.root, node.path));
    if (!current && sha(bytes) !== object.sha256) fail('RF_KNOWLEDGE_REGISTRY_BINDING_INVALID', { path: node.path });
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
      if (current) return { id: node.entity_id, canonical_key: node.entity_id, title: basename(node.path, '.md'), aliases: [], path: node.path,
        unavailable: true, current_content: true };
      fail('RF_KNOWLEDGE_REGISTRY_METADATA_INVALID', { path: node.path });
    }
    return { id, canonical_key: canonical, title: basename(node.path, '.md'), aliases, path: node.path,
      ...(typeof metadata.language === 'string' ? { language: metadata.language } : {}), content,
      ...(current ? { current_content: true, content_sha256: entry.sha256 } : {}) };
  });
  if (current) assertCurrentVaultContent(snapshot); else if (scoped) assertCommittedSharedNodes(snapshot); else assertCommittedSnapshot(snapshot);
  return bind(root, snapshot, registry, policy);
}

/** Preview-only access to a byte-verified registered asset under the scoped policy. */
export function readCommittedReadingFirstRegistryResource({ vaultRoot, registry, path } = {}) {
  assertCommittedReadingFirstKnowledgeRegistry({ vaultRoot, registry });
  const record = registries.get(registry);
  if (!record.snapshot) fail('RF_KNOWLEDGE_REGISTRY_ASSET_UNREGISTERED', { path });
  if (record.policy === 'current-shared-nodes-1.0') {
    if (!record.snapshot.generation.objects.some(row => row.kind === 'asset' && row.path === path)) fail('RF_KNOWLEDGE_REGISTRY_ASSET_UNREGISTERED', { path });
    return readCurrentRegisteredBytes(record.snapshot, path);
  }
  if (record.policy !== 'committed-shared-nodes-1.0') fail('RF_KNOWLEDGE_REGISTRY_NOT_TRUSTED');
  return readCommittedSharedAsset(record.snapshot, path);
}

/** Expose only registered paper paths for preview navigation, without authorizing paper reads. */
export function inspectCommittedReadingFirstRegistry({ vaultRoot, registry } = {}) {
  assertCommittedReadingFirstKnowledgeRegistry({ vaultRoot, registry });
  const { snapshot, policy } = registries.get(registry);
  if (!['committed-shared-nodes-1.0', 'current-shared-nodes-1.0'].includes(policy)) fail('RF_KNOWLEDGE_REGISTRY_NOT_TRUSTED');
  const info = { generation_id: snapshot?.generation_id ?? null,
    paper_paths: snapshot ? snapshot.generation.papers.flatMap(paper => Object.values(paper.paths)) : [],
    asset_paths: snapshot ? snapshot.generation.objects.filter(row => row.kind === 'asset').map(row => row.path) : [] };
  if (snapshot) { if (policy === 'current-shared-nodes-1.0') assertCurrentVaultContent(snapshot); else assertCommittedSharedNodes(snapshot); }
  return info;
}
