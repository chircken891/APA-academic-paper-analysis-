import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { inspectHostCapabilities } from './apa-host-capabilities.mjs';
import { deriveSetupIssues } from './apa-setup-issues.mjs';

export const APA_CONFIG_VERSION = 'apa-local-config-1.0';
export const APA_SCIENCE_ROLES = Object.freeze(['evidence', 'methods', 'results', 'interpretation', 'scientific-reading', 'integration']);
export const APA_CONFIG_ROLES = Object.freeze(['english-writer', 'chinese-writer', 'translation', 'reading-editor', 'independent-verifier']);
export const APA_WRITING_SKILLS = Object.freeze(['nature-writing', 'nature-polishing', 'nature-shared', 'humanizer', 'humanizer-zh', 'stss']);
const schemaPath = fileURLToPath(new URL('../../Schema/config/apa-config.schema.json', import.meta.url));
const configSchema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const checkSchema = new Ajv({ allErrors: true }).compile(configSchema);
const checkQueryPreferences = new Ajv({ allErrors: true }).compile(configSchema.properties.query);
const checkHostProfileShape = new Ajv({ allErrors: true }).addSchema(configSchema, 'apa-config').getSchema('apa-config#/definitions/hostProfile');
const checkIssueLedgerShape = new Ajv({ allErrors: true }).addSchema(configSchema, 'apa-config').getSchema('apa-config#/definitions/issueLedger');
export const APA_REASONING_EFFORTS = Object.freeze([...configSchema.definitions.reasoningEffort.enum]);
export const APA_QUERY_DEFAULTS = Object.freeze({ answer_language: 'question', detail: 'adaptive', audience: 'adaptive' });
const clone = value => structuredClone(value);
const blank = () => ({ schema_version: APA_CONFIG_VERSION });
const absolute = (root, value) => path.resolve(root, value);
function contained(root, target) {
  const relative = path.relative(path.resolve(root), target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
const error = (code, details) => Object.assign(new Error(`${code}${details ? `: ${details}` : ''}`), { code });

export function resolveQueryPreferences(configured = {}, overrides = {}) {
  if (!checkQueryPreferences(configured) || !checkQueryPreferences(overrides)) throw error('APA_QUERY_PREFERENCES_INVALID');
  return { ...APA_QUERY_DEFAULTS, ...configured, ...overrides };
}

export function validateApaConfig(config, { repoRoot = process.cwd(), complete = false, capability = 'reading' } = {}) {
  if (!['reading', 'query'].includes(capability)) throw error('APA_CONFIG_CAPABILITY_INVALID', 'use reading or query');
  const validShape = checkSchema(config);
  const errors = validShape ? [] : checkSchema.errors.map(item => `${item.instancePath || '/'} ${item.message}`);
  for (const [key, value] of Object.entries(config?.paths ?? {})) {
    if (typeof value === 'string' && !contained(repoRoot, absolute(repoRoot, value))) errors.push(`paths.${key} must be inside repository`);
  }
  const missing = [];
  // A saved host that cannot choose the model leaves explicit choices unenforceable; report them instead of refusing to load.
  const conflicts = config?.host?.dispatch?.model_argument === null
    ? modelChoiceEntries(config).filter(([key, choice]) => choice?.mode === 'explicit' && (capability === 'reading' || key === 'models.query')).map(([key]) => `${key} requires follow-main: host ${config.host.name} cannot select the model`)
    : [];
  if (capability === 'query') return { valid: errors.length === 0, complete: errors.length === 0 && conflicts.length === 0, errors, missing, conflicts };
  for (const key of ['models.science', ...APA_CONFIG_ROLES.map(role => `models.roles.${role}`), 'paths.runs', 'paths.parse', 'paths.candidates', 'parser.runtime_home', 'reading.presentation_mode', ...APA_WRITING_SKILLS.map(skill => `writing_skills.${skill}.enabled`)]) {
    if (get(config, key) === undefined) missing.push(key);
  }
  for (const key of APA_WRITING_SKILLS) if (config?.writing_skills?.[key]?.enabled && !config.writing_skills[key].path) missing.push(`writing_skills.${key}.path`);
  if (['nature-writing', 'nature-polishing'].some(key => config?.writing_skills?.[key]?.enabled) && !config?.writing_skills?.['nature-shared']?.enabled) missing.push('writing_skills.nature-shared.enabled');
  return { valid: errors.length === 0 && (!complete || missing.length === 0 && conflicts.length === 0), complete: errors.length === 0 && missing.length === 0 && conflicts.length === 0, errors, missing: [...new Set(missing)], conflicts };
}

function modelChoiceEntries(config) {
  return [['models.query', config?.models?.query], ['models.science', config?.models?.science],
    ...APA_SCIENCE_ROLES.map(role => [`models.overrides.${role}`, config?.models?.overrides?.[role]]),
    ...APA_CONFIG_ROLES.map(role => [`models.roles.${role}`, config?.models?.roles?.[role]])];
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
  const allowed = ['schema_version', 'base_fingerprint', 'repo_root', 'action', 'set', 'remove', 'all', 'answers', 'host_settings'];
  if (!operation || Object.keys(operation).some(key => !allowed.includes(key)) || operation.schema_version !== 'apa-config-operation-1.0' || !['patch', 'remove', 'import'].includes(operation.action)) throw error('APA_CONFIG_OPERATION_INVALID');
  // host_settings carries the user's page choice for host settings; it is reported back, never written to the config.
  const hostSettings = operation.host_settings;
  if (hostSettings !== undefined) {
    const threshold = hostSettings?.threshold_compaction;
    const keys = threshold && typeof threshold === 'object' ? Object.keys(threshold).sort().join(',') : '';
    if (operation.action !== 'patch' || !hostSettings || typeof hostSettings !== 'object' || Array.isArray(hostSettings) || Object.keys(hostSettings).join(',') !== 'threshold_compaction'
      || keys !== 'host,tokens' || typeof threshold.host !== 'string' || !threshold.host.trim() || !Number.isSafeInteger(threshold.tokens) || threshold.tokens < 1) throw error('APA_CONFIG_OPERATION_INVALID');
  }
  // Page operations carry the project folder the user confirmed; applying them to another checkout is refused.
  if (operation.repo_root !== undefined) {
    const same = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
    if (typeof operation.repo_root !== 'string' || !path.isAbsolute(operation.repo_root) || !same(path.resolve(operation.repo_root), path.resolve(repoRoot))) throw error('APA_CONFIG_REPO_MISMATCH');
  }
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
  const applied = loadApaConfig({ repoRoot });
  return hostSettings ? { ...applied, pending_host_settings: clone(hostSettings) } : applied;
}

export function exportApaConfig(config) {
  if (!validateApaConfig(config).valid) throw error('APA_CONFIG_INVALID');
  return { schema_version: 'apa-config-export-1.0', answers: clone(config) };
}

// A host profile is the agent's own report of what it can dispatch; it is evidence for setup, not a saved answer.
export function loadHostProfile(file) {
  let profile;
  try { profile = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw error('APA_HOST_PROFILE_INVALID', 'unreadable JSON'); }
  validateHostProfile(profile);
  return profile;
}

export function loadIssueLedger(file) {
  let ledger;
  try { ledger = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw error('APA_ISSUE_LEDGER_INVALID', 'unreadable JSON'); }
  if (!checkIssueLedgerShape(ledger)) throw error('APA_ISSUE_LEDGER_INVALID', checkIssueLedgerShape.errors.map(item => `${item.instancePath || '/'} ${item.message}`).join('; '));
  return ledger;
}

function validateHostProfile(profile) {
  if (!checkHostProfileShape(profile)) throw error('APA_HOST_PROFILE_INVALID', checkHostProfileShape.errors.map(item => `${item.instancePath || '/'} ${item.message}`).join('; '));
  if (new Set(profile.models.map(item => item.model)).size !== profile.models.length) throw error('APA_HOST_PROFILE_INVALID', 'duplicate model');
}

export function checkHostProfile(config, profile, capability = 'reading') {
  const issues = [];
  for (const [key, choice] of modelChoiceEntries(config)) {
    if (choice?.mode !== 'explicit' || capability === 'query' && key !== 'models.query') continue;
    if (profile.dispatch?.model_argument === null) { issues.push({ key, issue: 'model-selection-unavailable', model: choice.model }); continue; }
    const detected = profile.models.find(item => item.model === choice.model);
    if (!detected) { if (profile.models.length) issues.push({ key, issue: 'model-not-detected', model: choice.model }); continue; }
    if (choice.reasoning_effort === undefined) { if (detected.reasoning_efforts.length) issues.push({ key, issue: 'effort-missing', model: choice.model }); }
    else if (!detected.reasoning_efforts.includes(choice.reasoning_effort)) issues.push({ key, issue: 'effort-not-supported', model: choice.model, reasoning_effort: choice.reasoning_effort });
  }
  if (!profile.dispatch) issues.push({ key: 'host', issue: 'dispatch-unavailable' });
  const detectedHost = profile.dispatch ? { name: profile.host, dispatch: profile.dispatch } : null;
  const canonical = value => JSON.stringify(value, (key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  const host = !config.host ? 'not-saved' : detectedHost && canonical(config.host) === canonical(detectedHost) ? 'match' : 'differs';
  return { host, detected_host: profile.host, issues };
}

export function inspectApaConfig({ repoRoot = process.cwd(), capability = 'reading', hostProfile } = {}) {
  if (hostProfile) validateHostProfile(hostProfile);
  const snapshot = loadApaConfig({ repoRoot });
  const validation = validateApaConfig(snapshot.config, { repoRoot, capability });
  const hostCheck = { capability_check: inspectHostCapabilities(snapshot.config, hostProfile, repoRoot), ...(hostProfile ? { host_check: checkHostProfile(snapshot.config, hostProfile, capability) } : {}) };
  const withIssues = inspection => ({ ...inspection, setup_issues: deriveSetupIssues(inspection, hostProfile) });
  if (capability === 'query') return withIssues({ ...snapshot, capability, validation, dependencies: [], ready: validation.complete, model_availability: 'not_checked', ...hostCheck });
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
  return withIssues({ ...snapshot, capability, validation, dependencies, ready: validation.complete && dependencies.every(item => item.status === 'available'), model_availability: 'not_checked', ...hostCheck });
}

export function resolveApaConfig({ config, repoRoot = process.cwd(), mainSession, supportedModelPairs, capability = 'reading' } = {}) {
  const validation = validateApaConfig(config, { repoRoot, complete: true, capability });
  if (!validation.valid) throw error('APA_CONFIG_INCOMPLETE', [...validation.errors, ...validation.missing, ...validation.conflicts].join('; '));
  const resolveChoice = choice => {
    const pair = choice.mode === 'follow-main' ? mainSession : choice;
    // A host without a reasoning parameter saves no effort; the absence is kept rather than filled with a default.
    if (!pair || typeof pair.model !== 'string' || !pair.model.trim() || pair.reasoning_effort !== undefined && !APA_REASONING_EFFORTS.includes(pair.reasoning_effort)) throw error('APA_MAIN_SESSION_INVALID');
    const resolved = { model: pair.model, ...(pair.reasoning_effort === undefined ? {} : { reasoning_effort: pair.reasoning_effort }) };
    if (supportedModelPairs && !supportedModelPairs.some(item => item.model === resolved.model && item.reasoning_effort === resolved.reasoning_effort)) throw error('APA_MODEL_UNSUPPORTED', `${resolved.model}/${resolved.reasoning_effort}`);
    return resolved;
  };
  if (capability === 'query') {
    const choice = config.models?.query ?? { mode: 'follow-main' };
    if (choice.mode === 'explicit' && !Array.isArray(supportedModelPairs)) throw error('APA_MODEL_AVAILABILITY_UNKNOWN', 'provide current host supportedModelPairs to confirm the explicit query model');
    if (supportedModelPairs !== undefined && !Array.isArray(supportedModelPairs)) throw error('APA_MODEL_AVAILABILITY_UNKNOWN', 'supportedModelPairs must be a current host capability list');
    return { query: resolveChoice(choice), queryMode: choice.mode, queryPreferences: resolveQueryPreferences(config.query) };
  }
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
