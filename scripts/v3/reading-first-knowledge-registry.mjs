import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import YAML from 'yaml';
import { PHASE22_COMMIT_PATH, readCommittedGeneration, assertCommittedSnapshot } from './phase22-active-version.mjs';
import { fingerprintV3Json } from './semantic-package-validator.mjs';

const fail = (code, details = {}) => { throw Object.assign(new Error(code), { code, details }); };
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const registries = new WeakMap();
const bind = (root, snapshot, registry) => {
  registries.set(registry, { root, snapshot, fingerprint: fingerprintV3Json(registry) });
  return registry;
};

/** Only this process's current, unchanged committed read can authorize a configured render. */
export function assertCommittedReadingFirstKnowledgeRegistry({ vaultRoot, registry } = {}) {
  const record = registry && typeof registry === 'object' ? registries.get(registry) : undefined;
  if (typeof vaultRoot !== 'string' || !vaultRoot || !record || resolve(vaultRoot) !== record.root
    || fingerprintV3Json(registry) !== record.fingerprint) fail('RF_KNOWLEDGE_REGISTRY_NOT_TRUSTED');
  if (record.snapshot) {
    assertCommittedSnapshot(record.snapshot);
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
export async function readCommittedReadingFirstKnowledgeRegistry({ vaultRoot } = {}) {
  if (typeof vaultRoot !== 'string' || !vaultRoot) fail('RF_KNOWLEDGE_REGISTRY_ROOT_REQUIRED');
  const root = resolve(vaultRoot);
  if (!lstatSync(root).isDirectory()) fail('RF_KNOWLEDGE_REGISTRY_ROOT_REQUIRED');
  try {
    lstatSync(resolve(root, PHASE22_COMMIT_PATH));
  } catch (error) {
    if (error.code === 'ENOENT') return bind(root, null, []);
    throw error;
  }
  const snapshot = await readCommittedGeneration({ vaultRoot: root });
  if (!snapshot.ok) fail('RF_KNOWLEDGE_REGISTRY_COMMITTED_INVALID', { errors: snapshot.errors });
  const observed = assertCommittedSnapshot(snapshot);
  const objects = new Map(snapshot.generation.objects.map(row => [row.path, row]));
  const registry = snapshot.generation.shared_nodes.map(node => {
    const object = objects.get(node.path);
    if (object?.kind !== 'support') fail('RF_KNOWLEDGE_REGISTRY_BINDING_INVALID', { path: node.path });
    const bytes = readFileSync(resolve(observed.root, node.path));
    if (sha(bytes) !== object.sha256) fail('RF_KNOWLEDGE_REGISTRY_BINDING_INVALID', { path: node.path });
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
    const document = front && YAML.parseDocument(front[1], { uniqueKeys: true });
    if (!document || document.errors.length || !YAML.isMap(document.contents)) fail('RF_KNOWLEDGE_REGISTRY_METADATA_INVALID', { path: node.path });
    const metadata = document.toJS({ maxAliasCount: 100 });
    const id = metadata.knowledge_id ?? metadata.measure_id ?? metadata.concept_id ?? node.entity_id;
    const canonical = metadata.canonical_key ?? metadata.measure_id ?? metadata.concept_id ?? id;
    const aliases = metadata.aliases ?? [];
    if (typeof id !== 'string' || !id || typeof canonical !== 'string' || !canonical
      || !Array.isArray(aliases) || aliases.some(value => typeof value !== 'string')) fail('RF_KNOWLEDGE_REGISTRY_METADATA_INVALID', { path: node.path });
    return { id, canonical_key: canonical, title: basename(node.path, '.md'), aliases, path: node.path,
      ...(typeof metadata.language === 'string' ? { language: metadata.language } : {}), content };
  });
  assertCommittedSnapshot(snapshot);
  return bind(root, snapshot, registry);
}
