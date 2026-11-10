import { lstatSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import MarkdownIt from 'markdown-it';
import YAML from 'yaml';
import { KNOWLEDGE_ALIASES_PATH, parseRegisteredKnowledgeAliases, PHASE22_COMMIT_PATH } from './phase22-active-version.mjs';
import { fingerprintV3Json } from './semantic-package-validator.mjs';
import { readCurrentVaultContent, assertCurrentVaultContent, readCurrentRegisteredBytes, readCurrentRegisteredEntries } from './current-vault-content.mjs';

const fail = (code, details = {}) => { throw Object.assign(new Error(code), { code, details }); };
const POLICY = 'current-shared-nodes-1.0';
const markdown = new MarkdownIt();
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
    assertCurrentVaultContent(record.snapshot, { paths });
    if (record.snapshot.generation.objects.some(row => row.path === KNOWLEDGE_ALIASES_PATH && row.kind === 'knowledge-aliases')) {
      readCurrentRegisteredBytes(record.snapshot, KNOWLEDGE_ALIASES_PATH);
    }
  }
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

function registeredAliases(snapshot) {
  const object = snapshot.generation.objects.find(row => row.path === KNOWLEDGE_ALIASES_PATH && row.kind === 'knowledge-aliases');
  const aliases = new Map();
  if (!object) return aliases;
  const { bytes } = readCurrentRegisteredBytes(snapshot, object.path);
  for (const row of parseRegisteredKnowledgeAliases(bytes, snapshot.generation)) {
    const values = aliases.get(row.target_path) ?? [];
    values.push(row.alias);
    aliases.set(row.target_path, values);
  }
  return aliases;
}

/** Parse the current Markdown and preserve signed aliases separately from display aliases. */
export function readKnowledgeRegistryRow({ path, content, entityId, registeredAliases = [] }) {
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  const document = front && YAML.parseDocument(front[1], { uniqueKeys: true });
  if (!document || document.errors.length || !YAML.isMap(document.contents)) fail('RF_KNOWLEDGE_REGISTRY_METADATA_INVALID', { path });
  const metadata = document.toJS({ maxAliasCount: 100 });
  const id = metadata.knowledge_id ?? metadata.measure_id ?? metadata.concept_id ?? entityId;
  const canonical = metadata.canonical_key ?? metadata.measure_id ?? metadata.concept_id ?? id;
  const aliases = metadata.aliases ?? [];
  const title = basename(path, '.md');
  if (typeof id !== 'string' || !id || typeof canonical !== 'string' || !canonical
    || !Array.isArray(aliases) || aliases.some(value => typeof value !== 'string')) {
    return { id: entityId, entity_id: entityId, canonical_key: entityId, title, aliases: [], path, unavailable: true, current_content: true };
  }
  const body = content.slice(front[0].length);
  const tokens = markdown.parse(body, {}), definitions = [];
  let titleZh = metadata.title?.['zh-CN'], titleEn = metadata.title?.en, eligible = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === 'heading_open' && token.tag === 'h1') {
      const name = tokens[i + 1]?.content;
      titleEn ??= name?.startsWith(title + ' / ') ? name.slice(title.length + 3) : undefined;
      eligible = true;
    } else if (token.type === 'heading_open' && token.tag === 'h2') {
      eligible = /^(?:English|中文|定义|概念定义|Definition)(?:\s|$)/i.test(tokens[i + 1]?.content ?? '');
    } else if (eligible && token.type === 'paragraph_open' && definitions.length < 2) {
      const paragraph = tokens[i + 1];
      if (paragraph?.children?.some(child => child.type === 'text' && /[\p{L}\p{N}]{2}/u.test(child.content))) {
        const value = paragraph.content.trim();
        if (!/^\[中文\]\(/.test(value)) { definitions.push(value); eligible = false; }
      }
    }
  }
  const state = /<!-- KNOWLEDGE_STATE ([A-Za-z0-9+/=]+) -->/.exec(body);
  if (state) {
    try {
      const embedded = JSON.parse(Buffer.from(state[1], 'base64')).item.title;
      titleZh = embedded?.['zh-CN'] ?? titleZh;
      titleEn = embedded?.en ?? titleEn;
    }
    catch { fail('RF_KNOWLEDGE_REGISTRY_METADATA_INVALID', { path }); }
  }
  return { id, entity_id: entityId, canonical_key: canonical, title, ...(typeof titleZh === 'string' ? { title_zh: titleZh } : {}),
    ...(typeof titleEn === 'string' ? { title_en: titleEn } : {}), aliases, path,
    ...(registeredAliases.length ? { registered_aliases: [...registeredAliases] } : {}), ...(definitions.length ? { definitions } : {}),
    ...(typeof metadata.language === 'string' ? { language: metadata.language } : {}), content, current_content: true,
    content_sha256: 'sha256:' + createHash('sha256').update(content).digest('hex') };
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
  const signedAliases = registeredAliases(snapshot);
  const registry = snapshot.generation.shared_nodes.map(node => {
    const object = objects.get(node.path);
    if (object?.kind !== 'support') fail('RF_KNOWLEDGE_REGISTRY_BINDING_INVALID', { path: node.path });
    const entry = currentContents.get(node.path);
    if (!entry) {
      if (!snapshot.diagnostics.some(row => row.path === node.path)) fail('RF_KNOWLEDGE_REGISTRY_BINDING_INVALID', { path: node.path });
      return { id: node.entity_id, entity_id: node.entity_id, canonical_key: node.entity_id, title: basename(node.path, '.md'), aliases: [], path: node.path,
        ...(signedAliases.has(node.path) ? { registered_aliases: signedAliases.get(node.path) } : {}),
        unavailable: true, current_content: true };
    }
    const bytes = entry.bytes;
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { ...readKnowledgeRegistryRow({ path: node.path, content, entityId: node.entity_id, registeredAliases: signedAliases.get(node.path) }), content_sha256: entry.sha256 };
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
