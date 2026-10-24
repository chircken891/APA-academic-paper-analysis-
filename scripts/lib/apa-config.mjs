import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

export const APA_CONFIG_VERSION = 'apa-local-config-1.0';
export const APA_SCIENCE_ROLES = Object.freeze(['evidence', 'methods', 'results', 'interpretation', 'scientific-reading', 'integration']);
export const APA_CONFIG_ROLES = Object.freeze(['english-writer', 'chinese-writer', 'reading-editor', 'independent-verifier']);
export const APA_WRITING_SKILLS = Object.freeze(['nature-writing', 'nature-polishing', 'nature-shared', 'humanizer', 'humanizer-zh', 'stss']);
const schemaPath = fileURLToPath(new URL('../../Schema/config/apa-config.schema.json', import.meta.url));
const checkSchema = new Ajv({ allErrors: true }).compile(JSON.parse(fs.readFileSync(schemaPath, 'utf8')));
const clone = value => structuredClone(value);
const blank = () => ({ schema_version: APA_CONFIG_VERSION });
const absolute = (root, value) => path.resolve(root, value);
function contained(root, target) {
  const relative = path.relative(path.resolve(root), target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
const error = (code, details) => Object.assign(new Error(`${code}${details ? `: ${details}` : ''}`), { code });

export function validateApaConfig(config, { repoRoot = process.cwd(), complete = false } = {}) {
  const validShape = checkSchema(config);
  const errors = validShape ? [] : checkSchema.errors.map(item => `${item.instancePath || '/'} ${item.message}`);
  for (const [key, value] of Object.entries(config?.paths ?? {})) {
    if (typeof value === 'string' && !contained(repoRoot, absolute(repoRoot, value))) errors.push(`paths.${key} must be inside repository`);
  }
  const missing = [];
  for (const key of ['models.science', ...APA_CONFIG_ROLES.map(role => `models.roles.${role}`), 'paths.runs', 'paths.parse', 'paths.candidates', 'parser.runtime_home', 'reading.source_language', 'reading.presentation_mode', ...APA_WRITING_SKILLS.map(skill => `writing_skills.${skill}.enabled`)]) {
    if (get(config, key) === undefined) missing.push(key);
  }
  for (const key of APA_WRITING_SKILLS) if (config?.writing_skills?.[key]?.enabled && !config.writing_skills[key].path) missing.push(`writing_skills.${key}.path`);
  if (['nature-writing', 'nature-polishing'].some(key => config?.writing_skills?.[key]?.enabled) && !config?.writing_skills?.['nature-shared']?.enabled) missing.push('writing_skills.nature-shared.enabled');
  return { valid: errors.length === 0 && (!complete || missing.length === 0), complete: errors.length === 0 && missing.length === 0, errors, missing: [...new Set(missing)] };
}

export function loadApaConfig({ repoRoot = process.cwd() } = {}) {
  const configPath = path.resolve(repoRoot, 'config/apa.local.json');
  const exists = fs.existsSync(configPath);
  const raw = exists ? fs.readFileSync(configPath, 'utf8') : '';
  let config;
  try { config = exists ? JSON.parse(raw) : blank(); } catch { throw error('APA_CONFIG_JSON_INVALID'); }
  const validation = validateApaConfig(config, { repoRoot });
  if (!validation.valid) throw error('APA_CONFIG_INVALID', validation.errors.join('; '));
  return { config, fingerprint: digest(exists ? raw : 'apa-config-absent'), path: configPath, exists };
}

function get(object, key) { return key.split('.').reduce((value, part) => value?.[part], object); }
function set(object, key, value, remove = false) {
  const parts = key.split('.');
  if (!parts.length || parts.some(part => !part || ['__proto__', 'prototype', 'constructor'].includes(part)) || parts[0] === 'schema_version') throw error('APA_CONFIG_OPERATION_INVALID');
  let target = object;
  for (const part of parts.slice(0, -1)) {
    if (!target[part] || typeof target[part] !== 'object' || Array.isArray(target[part])) target[part] = {};
    target = target[part];
  }
  if (remove) delete target[parts.at(-1)]; else target[parts.at(-1)] = clone(value);
}
function merge(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (key === 'schema_version') continue;
    if (value && typeof value === 'object' && !Array.isArray(value) && !Object.hasOwn(value, 'mode')) {
      target[key] ??= {};
      merge(target[key], value);
    } else target[key] = clone(value);
  }
}

export function applyApaConfigOperation({ repoRoot = process.cwd(), operation }) {
  const allowed = ['schema_version', 'base_fingerprint', 'action', 'set', 'remove', 'all', 'answers'];
  if (!operation || Object.keys(operation).some(key => !allowed.includes(key)) || operation.schema_version !== 'apa-config-operation-1.0' || !['patch', 'remove', 'import'].includes(operation.action)) throw error('APA_CONFIG_OPERATION_INVALID');
  const snapshot = loadApaConfig({ repoRoot });
  if (operation.base_fingerprint !== snapshot.fingerprint) throw error('APA_CONFIG_STALE');
  let config = clone(snapshot.config);
  if (operation.action === 'patch') {
    if (!operation.set || typeof operation.set !== 'object' || Array.isArray(operation.set) || operation.remove !== undefined || operation.all !== undefined || operation.answers !== undefined) throw error('APA_CONFIG_OPERATION_INVALID');
    for (const [key, value] of Object.entries(operation.set)) set(config, key, value);
  } else if (operation.action === 'remove') {
    if (operation.set !== undefined || operation.answers !== undefined || (operation.all !== undefined && typeof operation.all !== 'boolean') || (!operation.all && !Array.isArray(operation.remove))) throw error('APA_CONFIG_OPERATION_INVALID');
    if (operation.all) config = blank();
    else for (const key of operation.remove) { if (typeof key !== 'string') throw error('APA_CONFIG_OPERATION_INVALID'); set(config, key, undefined, true); }
  } else {
    if (operation.set !== undefined || operation.remove !== undefined || operation.all !== undefined || !validateApaConfig(operation.answers, { repoRoot }).valid) throw error('APA_CONFIG_IMPORT_INVALID');
    merge(config, operation.answers);
  }
  const validation = validateApaConfig(config, { repoRoot });
  if (!validation.valid) throw error('APA_CONFIG_INVALID', validation.errors.join('; '));
  // Recheck before atomic replacement; stale page operations never overwrite newer answers.
  if (loadApaConfig({ repoRoot }).fingerprint !== snapshot.fingerprint) throw error('APA_CONFIG_STALE');
  fs.mkdirSync(path.dirname(snapshot.path), { recursive: true });
  const temporary = `${snapshot.path}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, snapshot.path);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return loadApaConfig({ repoRoot });
}

export function exportApaConfig(config) {
  if (!validateApaConfig(config).valid) throw error('APA_CONFIG_INVALID');
  return { schema_version: 'apa-config-export-1.0', answers: clone(config) };
}

export function inspectApaConfig({ repoRoot = process.cwd() } = {}) {
  const snapshot = loadApaConfig({ repoRoot });
  const dependencies = [];
  const inspect = (key, value, kind) => {
    if (!value) return;
    const target = absolute(repoRoot, value);
    let status = 'missing';
    try { const stat = fs.statSync(target); status = (kind === 'directory' ? stat.isDirectory() : stat.isFile()) ? 'available' : 'wrong-type'; } catch (cause) { if (cause.code !== 'ENOENT') status = 'unavailable'; }
    dependencies.push({ key, path: target, status });
  };
  inspect('parser.runtime_home', snapshot.config.parser?.runtime_home, 'directory');
  const runtimeHome = snapshot.config.parser?.runtime_home;
  const parserDefaults = runtimeHome ? { python: path.join(runtimeHome, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), config_path: path.join(runtimeHome, 'config.yaml') } : {};
  for (const key of ['python', 'config_path']) inspect(`parser.${key}`, snapshot.config.parser?.[key] ?? parserDefaults[key], 'file');
  for (const key of APA_WRITING_SKILLS) if (snapshot.config.writing_skills?.[key]?.enabled) inspect(`writing_skills.${key}`, snapshot.config.writing_skills[key].path, 'file');
  const validation = validateApaConfig(snapshot.config, { repoRoot });
  return { ...snapshot, validation, dependencies, ready: validation.complete && dependencies.every(item => item.status === 'available') };
}

export function resolveApaConfig({ config, repoRoot = process.cwd(), mainSession, supportedModelPairs } = {}) {
  const validation = validateApaConfig(config, { repoRoot, complete: true });
  if (!validation.valid) throw error('APA_CONFIG_INCOMPLETE', [...validation.errors, ...validation.missing].join('; '));
  const resolveChoice = choice => {
    const pair = choice.mode === 'follow-main' ? mainSession : choice;
    if (!pair || typeof pair.model !== 'string' || !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(pair.reasoning_effort)) throw error('APA_MAIN_SESSION_INVALID');
    const resolved = { model: pair.model, reasoning_effort: pair.reasoning_effort };
    if (supportedModelPairs && !supportedModelPairs.some(item => item.model === resolved.model && item.reasoning_effort === resolved.reasoning_effort)) throw error('APA_MODEL_UNSUPPORTED', `${resolved.model}/${resolved.reasoning_effort}`);
    return resolved;
  };
  const roles = {};
  for (const role of APA_SCIENCE_ROLES) roles[role] = resolveChoice(config.models.overrides?.[role] ?? config.models.science);
  for (const role of APA_CONFIG_ROLES) roles[role] = resolveChoice(config.models.roles[role]);
  const writingSkills = {};
  for (const key of APA_WRITING_SKILLS) {
    const skill = config.writing_skills[key];
    if (!skill.enabled) continue;
    const skillPath = absolute(repoRoot, skill.path);
    try { writingSkills[key] = { path: skillPath, content: fs.readFileSync(skillPath, 'utf8') }; } catch { throw error('APA_SKILL_UNAVAILABLE', key); }
  }
  return { roles, paths: Object.fromEntries(Object.entries(config.paths).map(([key, value]) => [key, absolute(repoRoot, value)])), parser: Object.fromEntries(Object.entries(config.parser).map(([key, value]) => [key, absolute(repoRoot, value)])), reading: clone(config.reading), writingSkills };
}
