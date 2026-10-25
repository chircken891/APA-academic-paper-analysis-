import { fingerprintV3Json as hash } from './semantic-package-validator.mjs';
import { validatePhase22TargetPath } from './phase22-render-context.mjs';

export const READER_HUMAN_SLUG_MAX_CODEPOINTS = 80;
export const READER_TARGET_MAX_UTF16 = 200;
const schemaVersion = 'phase221-target-registry-1.0';
const languages = ['en', 'zh-CN'];
const fail = (code, details = {}) => { throw Object.assign(new Error(code), { code, details }); };
const identityFingerprint = paperId => hash({ type: 'paper', id: paperId });
const collisionKey = path => path.normalize('NFC').toLowerCase();

function safePart(value, preserveCase = false) {
  if (typeof value !== 'string' || !value.trim() || !value.isWellFormed()
    || /[\x00-\x1f\x7f<>:"/\\|?*#\[\]^]/.test(value)
    || /(?:^|\s)\.\.(?:$|\s)/.test(value) || /[. ]$/.test(value)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) fail('P221_TARGET_PATH_INVALID');
  const normalized = value.normalize('NFC').trim();
  return (preserveCase ? normalized : normalized.toLowerCase()).replace(/\s+/gu, '-');
}

/** Retain P22 filename safety while limiting reader pages to their own directory. */
export function validateReaderTargetPath(path) {
  if (typeof path !== 'string' || !path.isWellFormed() || path.length > READER_TARGET_MAX_UTF16
    || !/^Wiki\/(?:sources|translations)\/[^/]+\.(?:en|zh-CN)\.md$/.test(path)) fail('P221_TARGET_PATH_INVALID', { path });
  try {
    validatePhase22TargetPath('Wiki/concepts/' + path.split('/').at(-1));
  } catch (error) {
    if (error.code !== 'P22_TARGET_PATH_INVALID') throw error;
    fail('P221_TARGET_PATH_INVALID', { path });
  }
  return { target_path: path, collision_key: collisionKey(path) };
}

function freezeRegistry(value) {
  return Object.freeze({ ...value, paper_targets: Object.freeze({ ...value.paper_targets }) });
}

function validateLayout(noteLayout, sourceLanguage) {
  if (noteLayout !== undefined && !['legacy-flat-1.0', 'source-language-1.0'].includes(noteLayout)
    || noteLayout === 'source-language-1.0' && !languages.includes(sourceLanguage)) fail('P221_TARGET_LAYOUT_INVALID');
}

const targetDirectory = (noteLayout, sourceLanguage, language) => noteLayout === 'source-language-1.0' && language !== sourceLanguage ? 'translations' : 'sources';

function checkRegistry(value) {
  if (!value || value.schema_version !== schemaVersion || !/^pap_[0-9a-f]{32}$/.test(value.paper_id)
    || value.identity_fingerprint !== identityFingerprint(value.paper_id)
    || value.discriminator !== value.identity_fingerprint.slice(7, 19)
    || typeof value.human_slug !== 'string' || !value.human_slug.length
    || [...value.human_slug].length > READER_HUMAN_SLUG_MAX_CODEPOINTS
    || !value.paper_targets || Object.keys(value.paper_targets).length !== 2) fail('P221_TARGET_REGISTRY_INVALID');
  validateLayout(value.note_layout, value.source_language);
  for (const language of languages) {
    validateReaderTargetPath(value.paper_targets[language]);
    if (value.paper_targets[language] !== `Wiki/${targetDirectory(value.note_layout, value.source_language, language)}/${value.human_slug}--${value.discriminator}.${language}.md`) fail('P221_TARGET_REGISTRY_INVALID');
  }
  const { registry_fingerprint, ...body } = value;
  if (hash(body) !== registry_fingerprint) fail('P221_TARGET_REGISTRY_INVALID');
  return value;
}

/**
 * Register new candidate paths without filesystem mutation or historical renaming.
 * existingRegistry is a prior registry or an array of registries. occupiedPaths is
 * an array of actual relative path strings; only exact previously registered paths
 * for this paper may already be occupied. A display-title/revision edit never rekeys.
 */
export function registerReaderTargets({ identity, registeredBibliography, existingRegistry = [], occupiedPaths = [], namingStyle = 'lowercase', noteLayout, sourceLanguage } = {}) {
  validateLayout(noteLayout, sourceLanguage);
  if (!['lowercase', 'bibliographic'].includes(namingStyle)) fail('P221_TARGET_BIBLIOGRAPHY_INVALID');
  if (!identity || !/^pap_[0-9a-f]{32}$/.test(identity.paper_id)) fail('P221_TARGET_IDENTITY_INVALID');
  if (!Array.isArray(occupiedPaths) || occupiedPaths.some(path => typeof path !== 'string' || !path.isWellFormed())) fail('P221_TARGET_PATH_INVALID');
  const registries = Array.isArray(existingRegistry) ? existingRegistry : [existingRegistry];
  const seen = new Map(), identities = new Set(), discriminators = new Map();
  let previous;
  for (const registry of registries) {
    checkRegistry(registry);
    if (identities.has(registry.paper_id)) fail('P221_TARGET_REGISTRY_INVALID');
    identities.add(registry.paper_id);
    if (discriminators.has(registry.discriminator)) fail('P221_TARGET_COLLISION');
    discriminators.set(registry.discriminator, registry.paper_id);
    for (const path of Object.values(registry.paper_targets)) {
      const key = collisionKey(path);
      if (seen.has(key)) fail('P221_TARGET_COLLISION', { path });
      seen.set(key, registry.paper_id);
    }
    if (registry.paper_id === identity.paper_id) previous = registry;
  }
  let registry = previous;
  if (!registry) {
    const bibliography = registeredBibliography ?? {};
    if (!/^\d{4}$/.test(String(bibliography.year))) fail('P221_TARGET_BIBLIOGRAPHY_INVALID');
    const author = [...safePart(bibliography.first_author, namingStyle === 'bibliographic')].slice(0, 20).join('');
    const rawLabel = [author, String(bibliography.year), safePart(bibliography.title, namingStyle === 'bibliographic')].join('-');
    const label = namingStyle === 'bibliographic' ? rawLabel.charAt(0).toUpperCase() + rawLabel.slice(1) : rawLabel;
    const human_slug = [...label].slice(0, READER_HUMAN_SLUG_MAX_CODEPOINTS).join('').replace(/[-. ]+$/u, '');
    const identity_fingerprint = identityFingerprint(identity.paper_id), discriminator = identity_fingerprint.slice(7, 19);
    if (discriminators.has(discriminator)) fail('P221_TARGET_COLLISION');
    const body = { schema_version: schemaVersion, paper_id: identity.paper_id, identity_fingerprint, human_slug, discriminator,
      ...(noteLayout === 'source-language-1.0' ? { note_layout: noteLayout, source_language: sourceLanguage } : {}),
      paper_targets: Object.fromEntries(languages.map(language => [language, `Wiki/${targetDirectory(noteLayout, sourceLanguage, language)}/${human_slug}--${discriminator}.${language}.md`])) };
    registry = { ...body, registry_fingerprint: hash(body) };
  }
  const occupied = new Set(occupiedPaths.map(collisionKey));
  for (const path of Object.values(registry.paper_targets)) {
    const { collision_key: key } = validateReaderTargetPath(path);
    if (seen.has(key) && seen.get(key) !== identity.paper_id) fail('P221_TARGET_COLLISION', { path });
    if (occupied.has(key) && !(previous && occupiedPaths.filter(value => collisionKey(value) === key).every(value => value === path))) fail('P221_TARGET_COLLISION', { path });
  }
  return freezeRegistry(registry);
}

