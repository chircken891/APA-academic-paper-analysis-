import { closeSync, constants, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Previews, backs up and (only with --confirm) writes one host setting.
// threshold_compaction: Claude Code "autoCompactWindow" in settings.json; Codex top-level "model_auto_compact_token_limit"
// in config.toml. Nothing here chooses a number: --tokens is required and is never defaulted or clamped.
// compact_hook: adds the SessionStart/compact entry that runs scripts/setup/apa-compact-context.mjs to the Claude Code
// project settings (no --tokens, project scope only).
const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = resolve(dirname(scriptPath), '../..');
const CLAUDE_RANGE = { min: 100000, max: 1000000 };
const CODEX_KEY = 'model_auto_compact_token_limit';
// $CLAUDE_PROJECT_DIR keeps the hook independent of the session's working directory; the hook shell must expand it.
const HOOK_COMMAND = 'node "$CLAUDE_PROJECT_DIR/scripts/setup/apa-compact-context.mjs"';
const HOOK_TIMEOUT = 10;
const HOOK_KEY = 'hooks.SessionStart';
const capabilities = ['threshold_compaction', 'compact_hook'];
const hookEntry = () => ({ matcher: 'compact', hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: HOOK_TIMEOUT }] });
// Equal means: a compact-matcher entry holding a command hook with this command and timeout (other hooks beside it are fine).
const hasHookEntry = list => Array.isArray(list) && list.some(item => item?.matcher === 'compact' && Array.isArray(item.hooks) && item.hooks.some(hook => hook?.type === 'command' && hook.command === HOOK_COMMAND && hook.timeout === HOOK_TIMEOUT));
const hosts = {
  'claude-code': { key: 'autoCompactWindow', ext: 'json', scopes: ['project', 'user'] },
  codex: { key: CODEX_KEY, ext: 'toml', scopes: ['user'] },
};
const valueFlags = new Set(['host', 'capability', 'scope', 'tokens', 'settings-file', 'backup-dir', 'backup']);
const booleanFlags = new Set(['confirm']);

export class HostSettingsError extends Error {
  constructor(code, message, { fileProblem = false } = {}) {
    super(message);
    this.code = code;
    this.fileProblem = fileProblem;
  }
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!['plan', 'apply', 'restore'].includes(command)) throw new HostSettingsError('APA_HOST_SETTINGS_UNKNOWN_COMMAND', `Unknown command ${command ?? '(none)'}; use plan, apply or restore.`);
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    const name = argument.startsWith('--') ? argument.slice(2) : null;
    if (name && booleanFlags.has(name)) options[name] = true;
    else if (name && valueFlags.has(name)) {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith('--')) throw new HostSettingsError('APA_HOST_SETTINGS_ARGUMENT_VALUE_MISSING', `--${name} needs a value.`);
      options[name] = value;
      index += 1;
    } else throw new HostSettingsError('APA_HOST_SETTINGS_UNKNOWN_ARGUMENT', `Unknown argument ${argument}.`);
  }
  return { command, options };
}

function validateHost(options, { needTokens, needCapability }) {
  const host = Object.hasOwn(hosts, options.host ?? '') ? hosts[options.host] : null;
  if (!host) throw new HostSettingsError('APA_HOST_SETTINGS_HOST_UNSUPPORTED', `Host ${options.host ?? '(none)'} is not supported; use claude-code or codex.`);
  if (needCapability && !capabilities.includes(options.capability)) throw new HostSettingsError('APA_HOST_SETTINGS_CAPABILITY_UNSUPPORTED', `Capability ${options.capability ?? '(none)'} is not supported by this script; use ${capabilities.join(' or ')}.`);
  const isHook = needCapability && options.capability === 'compact_hook';
  if (isHook) {
    if (options.host !== 'claude-code') throw new HostSettingsError('APA_HOST_SETTINGS_CAPABILITY_HOST_UNSUPPORTED', `compact_hook is only available for claude-code, not ${options.host}.`);
    if (options.scope !== 'project') throw new HostSettingsError('APA_HOST_SETTINGS_SCOPE_UNSUPPORTED', `compact_hook needs --scope project, got ${options.scope ?? '(none)'}; it is not installed into user settings.`);
    if (options.tokens !== undefined) throw new HostSettingsError('APA_HOST_SETTINGS_TOKENS_UNEXPECTED', 'compact_hook does not take --tokens.');
  }
  const scope = options.scope ?? (options.host === 'codex' ? 'user' : options['settings-file'] ? 'custom' : null);
  if (scope === null) throw new HostSettingsError('APA_HOST_SETTINGS_SCOPE_REQUIRED', `--scope is required for ${options.host}: ${host.scopes.join(' or ')}.`);
  if (scope !== 'custom' && !host.scopes.includes(scope)) throw new HostSettingsError('APA_HOST_SETTINGS_SCOPE_UNSUPPORTED', `Scope ${scope} is not supported for ${options.host}; use ${host.scopes.join(' or ')}.`);
  return { name: options.host, ...host, scope, capability: needCapability ? options.capability : null, ...(isHook ? { key: HOOK_KEY } : {}), tokens: needTokens && !isHook ? parseTokens(options.host, options.tokens) : null };
}

function parseTokens(host, text) {
  if (text === undefined) throw new HostSettingsError('APA_HOST_SETTINGS_TOKENS_REQUIRED', '--tokens is required; no default value exists.');
  if (!/^\d+$/.test(text)) throw new HostSettingsError('APA_HOST_SETTINGS_TOKENS_NOT_INTEGER', `--tokens must be a whole number of tokens, got "${text}".`);
  const tokens = Number(text);
  if (!Number.isSafeInteger(tokens) || tokens < 1) throw new HostSettingsError('APA_HOST_SETTINGS_TOKENS_OUT_OF_RANGE', `--tokens must be a positive integer, got ${text}.`);
  if (host === 'claude-code' && (tokens < CLAUDE_RANGE.min || tokens > CLAUDE_RANGE.max)) {
    throw new HostSettingsError('APA_HOST_SETTINGS_TOKENS_OUT_OF_RANGE', `--tokens ${tokens} is outside the Claude Code range ${CLAUDE_RANGE.min}-${CLAUDE_RANGE.max}; it is not clamped.`);
  }
  return tokens;
}

export function resolveTarget({ host, scope, settingsFile, repoRoot = defaultRepoRoot }) {
  if (settingsFile) return resolve(settingsFile);
  if (host === 'codex') return join(homedir(), '.codex', 'config.toml');
  return scope === 'project' ? join(repoRoot, '.claude', 'settings.json') : join(homedir(), '.claude', 'settings.json');
}

const eolOf = text => (text.includes('\r\n') ? '\r\n' : '\n');

// JSON: textual edit of the top-level member, so every other byte stays as it was.
function hasComments(text) {
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === '\\') index += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '/' && (text[index + 1] === '/' || text[index + 1] === '*')) return true;
  }
  return false;
}

function skipString(text, start) {
  let index = start + 1;
  while (text[index] !== '"') index += text[index] === '\\' ? 2 : 1;
  return index + 1;
}

function skipValue(text, start) {
  if (text[start] === '"') return skipString(text, start);
  if (text[start] === '{' || text[start] === '[') {
    let depth = 0;
    let index = start;
    while (index < text.length) {
      const char = text[index];
      if (char === '"') { index = skipString(text, index); continue; }
      if (char === '{' || char === '[') depth += 1;
      if (char === '}' || char === ']') depth -= 1;
      index += 1;
      if (depth === 0) break;
    }
    return index;
  }
  let index = start;
  while (index < text.length && !/[\s,}\]]/.test(text[index])) index += 1;
  return index;
}

// Members of the object (or elements of the array) opened at `open`; the default is the root object.
function containerMembers(text, open = text.indexOf('{')) {
  const skipSpace = from => { let index = from; while (/\s/.test(text[index] ?? '')) index += 1; return index; };
  const keyed = text[open] === '{';
  const closer = keyed ? '}' : ']';
  const members = [];
  let index = skipSpace(open + 1);
  while (text[index] !== closer) {
    const keyStart = index;
    let key = null;
    if (keyed) {
      index = skipString(text, keyStart);
      key = JSON.parse(text.slice(keyStart, index));
      index = skipSpace(skipSpace(index) + 1);
    }
    const valueStart = index;
    index = skipValue(text, valueStart);
    members.push({ key, keyStart, valueStart, valueEnd: index });
    index = skipSpace(index);
    if (text[index] === ',') index = skipSpace(index + 1);
  }
  return { open, close: index, members };
}

const problemOf = (code, message) => new HostSettingsError(code, message, { fileProblem: true });

function readSettingsObject(raw) {
  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
  const text = raw.slice(bom.length);
  const problem = problemOf;
  if (text.trim() === '') throw problem('APA_HOST_SETTINGS_FILE_EMPTY', 'The settings file exists but is empty; it is not overwritten. Remove it or add "{}" yourself, then retry.');
  if (hasComments(text)) throw problem('APA_HOST_SETTINGS_HAS_COMMENTS', 'The settings file contains comments; rewriting it would lose them, so it is not changed. Apply the value by hand or use /autocompact.');
  let parsed;
  try { parsed = JSON.parse(text); } catch (cause) {
    throw problem('APA_HOST_SETTINGS_INVALID_JSON', `The settings file is not valid JSON (${cause.message}); it is not overwritten.`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw problem('APA_HOST_SETTINGS_NOT_OBJECT', 'The settings file is not a JSON object; it is not overwritten.');
  return { bom, text, parsed };
}

function editJson(raw, key, tokens) {
  if (raw === null) return { before: null, text: `{\n  "${key}": ${tokens}\n}\n`, change: 'create-file' };
  const { bom, text, parsed } = readSettingsObject(raw);
  const { members, open, close } = containerMembers(text);
  const eol = eolOf(text);
  const existing = members.filter(member => member.key === key).at(-1);
  const before = Object.hasOwn(parsed, key) ? parsed[key] : null;
  if (existing) {
    const same = text.slice(existing.valueStart, existing.valueEnd) === String(tokens);
    return { before, text: bom + text.slice(0, existing.valueStart) + tokens + text.slice(existing.valueEnd), change: same ? 'unchanged' : 'update-key' };
  }
  const entry = `"${key}": ${tokens}`;
  if (members.length === 0) return { before, text: `${bom}${text.slice(0, open + 1)}${eol}  ${entry}${eol}${text.slice(close)}`, change: 'add-key' };
  const last = members.at(-1);
  const lineStart = text.lastIndexOf('\n', last.keyStart) + 1;
  const lead = text.slice(lineStart, last.keyStart);
  const separator = /^[ \t]*$/.test(lead) && lineStart > open ? `,${eol}${lead}` : ', ';
  return { before, text: bom + text.slice(0, last.valueEnd) + separator + entry + text.slice(last.valueEnd), change: 'add-key' };
}

// Hook insert: a structural edit done as text, so every other byte of the file stays as it was. The new text copies the
// file's own indent unit, EOL and BOM; a one-line file gets one-line JSON.
const detectUnit = text => /^([ \t]{1,10})\S/m.exec(text)?.[1] ?? '  ';

function lineLead(text, position, containerOpen) {
  const start = text.lastIndexOf('\n', position) + 1;
  const lead = text.slice(start, position);
  return start > containerOpen && /^[ \t]*$/.test(lead) ? lead : null;
}

// Appends as the last member/element. build(indent) renders it; indent is null when the container is written inline.
function appendToContainer(text, container, { eol, unit, parentIndent, build }) {
  const { open, close, members } = container;
  if (members.length) {
    const last = members.at(-1);
    const lead = lineLead(text, last.keyStart, open);
    return text.slice(0, last.valueEnd) + (lead === null ? ', ' : `,${eol}${lead}`) + build(lead) + text.slice(last.valueEnd);
  }
  if (parentIndent === null) return text.slice(0, open + 1) + build(null) + text.slice(close);
  const inner = parentIndent + unit;
  return text.slice(0, open + 1) + eol + inner + build(inner) + eol + parentIndent + text.slice(close);
}

function editHook(raw) {
  const entry = hookEntry();
  if (raw === null) return { before: null, text: `${JSON.stringify({ hooks: { SessionStart: [entry] } }, null, 2)}\n`, change: 'create-file' };
  const { bom, text, parsed } = readSettingsObject(raw);
  const { hooks } = parsed;
  if (hooks !== undefined && (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks))) throw problemOf('APA_HOST_SETTINGS_HOOKS_SHAPE', '"hooks" in the settings file is not an object; it is not overwritten.');
  const list = hooks?.SessionStart;
  if (list !== undefined && !Array.isArray(list)) throw problemOf('APA_HOST_SETTINGS_HOOKS_SHAPE', '"hooks.SessionStart" in the settings file is not an array; it is not overwritten.');
  const before = list ?? null;
  if (hasHookEntry(list)) return { before, text: raw, change: 'unchanged' };

  const eol = eolOf(text);
  const unit = detectUnit(text);
  const render = (value, indent) => (indent === null ? JSON.stringify(value) : JSON.stringify(value, null, unit).replaceAll('\n', eol + indent));
  const member = (key, value) => indent => `${JSON.stringify(key)}: ${render(value, indent)}`;
  const root = containerMembers(text);
  const rootOptions = { eol, unit, parentIndent: '' };
  const hooksMember = root.members.filter(item => item.key === 'hooks').at(-1);
  let updated;
  if (!hooksMember) updated = appendToContainer(text, root, { ...rootOptions, build: member('hooks', { SessionStart: [entry] }) });
  else {
    const hooksContainer = containerMembers(text, hooksMember.valueStart);
    const hooksIndent = lineLead(text, hooksMember.keyStart, root.open);
    const sessionMember = hooksContainer.members.filter(item => item.key === 'SessionStart').at(-1);
    if (!sessionMember) updated = appendToContainer(text, hooksContainer, { eol, unit, parentIndent: hooksIndent, build: member('SessionStart', [entry]) });
    else {
      const listContainer = containerMembers(text, sessionMember.valueStart);
      updated = appendToContainer(text, listContainer, { eol, unit, parentIndent: lineLead(text, sessionMember.keyStart, hooksContainer.open), build: indent => render(entry, indent) });
    }
  }
  // Safety net for the textual edit: the result must be the original plus exactly this entry.
  const expected = structuredClone(parsed);
  expected.hooks ??= {};
  (expected.hooks.SessionStart ??= []).push(entry);
  try {
    if (JSON.stringify(JSON.parse(updated)) !== JSON.stringify(expected)) throw new Error('result differs from the original plus the new entry');
  } catch (cause) {
    throw problemOf('APA_HOST_SETTINGS_EDIT_UNSAFE', `The settings file layout could not be edited safely (${cause.message}); it is not changed. Add the entry by hand.`);
  }
  return { before, text: bom + updated, change: 'add-key' };
}

// TOML: no parser dependency; only the top-level region before the first [table] is read or changed.
function scanToml(raw) {
  const strip = line => line.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, '""').replace(/#.*$/, '');
  let position = 0;
  let multiline = null;
  let depth = 0;
  while (position < raw.length) {
    const end = raw.indexOf('\n', position);
    const next = end === -1 ? raw.length : end + 1;
    const line = raw.slice(position, next).replace(/\r?\n$/, '');
    if (multiline) {
      if (line.includes(multiline)) multiline = null;
    } else {
      if (depth === 0 && /^\s*\[/.test(line)) return { header: position };
      for (const delimiter of ['"""', "'''"]) {
        if (line.split(delimiter).length % 2 === 0) multiline = delimiter;
      }
      if (!multiline) {
        const stripped = strip(line);
        depth = Math.max(0, depth + (stripped.match(/[[{]/g) ?? []).length - (stripped.match(/[\]}]/g) ?? []).length);
      }
    }
    position = next;
  }
  return { header: -1 };
}

// The key may be bare, "quoted" or 'quoted'; anything else that mentions it outside a comment line is refused, never appended beside.
const tomlKeyPattern = new RegExp(`^([ \\t]*(?:${CODEX_KEY}|"${CODEX_KEY}"|'${CODEX_KEY}')[ \\t]*=[ \\t]*)("[^"\\r\\n]*"|'[^'\\r\\n]*'|[^#\\s]*)`, 'gm');

function findTomlKey(raw) {
  const { header } = scanToml(raw);
  const region = header === -1 ? raw : raw.slice(0, header);
  const matches = [...region.matchAll(tomlKeyPattern)];
  const mentions = region.split(/\r?\n/).filter(line => line.includes(CODEX_KEY) && !line.trim().startsWith('#')).length;
  return { header, region, matches, mentions };
}

function editToml(source, key, tokens) {
  if (source === null) return { before: null, text: `${key} = ${tokens}\n`, change: 'create-file' };
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
  const raw = source.slice(bom.length);
  const { header, region, matches, mentions } = findTomlKey(raw);
  const eol = eolOf(raw);
  const problem = (code, message) => new HostSettingsError(code, message, { fileProblem: true });
  if (matches.length > 1) throw problem('APA_HOST_SETTINGS_TOML_DUPLICATE_KEY', `${key} appears more than once at the top level; fix the file by hand.`);
  if (mentions !== matches.length) throw problem('APA_HOST_SETTINGS_TOML_UNSAFE_KEY', `${key} appears at the top level in a form this script cannot rewrite safely (dotted key, key inside a value, ...); it is not changed. Edit the file by hand.`);
  if (matches.length === 1) {
    const [match] = matches;
    const valueStart = match.index + match[1].length;
    const old = match[2];
    const before = /^\d+$/.test(old) ? Number(old) : old;
    return { before, text: bom + raw.slice(0, valueStart) + tokens + raw.slice(valueStart + old.length), change: old === String(tokens) ? 'unchanged' : 'update-key' };
  }
  const line = `${key} = ${tokens}`;
  if (header === -1) {
    const ending = /\r?\n$/.test(raw) ? eol : '';
    const separator = raw === '' || /\n$/.test(raw) ? '' : eol;
    return { before: null, text: bom + raw + separator + line + (raw === '' ? eol : ending), change: 'add-key' };
  }
  // Insert after the last top-level content line, leaving blank lines and comments attached to the table where they were.
  const lines = region.split(/(?<=\n)/);
  let keep = lines.length;
  while (keep > 0 && lines[keep - 1].trim().startsWith('#')) keep -= 1;
  while (keep > 0 && lines[keep - 1].trim() === '') keep -= 1;
  const at = lines.slice(0, keep).join('').length;
  return { before: null, text: bom + raw.slice(0, at) + line + eol + (at === 0 ? eol : '') + raw.slice(at), change: 'add-key' };
}

function backupStamp(date) {
  const two = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}-${String(date.getMilliseconds()).padStart(3, '0')}`;
}

const backupName = (host, date) => `host-settings-${host.name}-${backupStamp(date)}.${host.ext}`;

// One helper for plan and apply. dryRun returns the first free name; otherwise copies with COPYFILE_EXCL so an
// existing backup is never replaced, retrying the next millisecond name on a clash.
function claimBackup(host, target, backupDir, { dryRun = false } = {}) {
  if (!dryRun) mkdirSync(backupDir, { recursive: true });
  const now = new Date();
  for (let attempt = 0; attempt < 5000; attempt += 1) {
    const candidate = join(backupDir, backupName(host, new Date(now.getTime() + attempt)));
    if (dryRun) {
      if (!existsSync(candidate)) return candidate;
      continue;
    }
    try {
      copyFileSync(target, candidate, constants.COPYFILE_EXCL);
      return candidate;
    } catch (cause) {
      if (cause.code !== 'EEXIST') throw cause;
    }
  }
  throw new HostSettingsError('APA_HOST_SETTINGS_BACKUP_NAME_EXHAUSTED', 'No free backup file name was found; nothing was written.');
}

function writeAtomic(target, content) {
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.apa-${process.pid}.tmp`;
  const descriptor = openSync(temporary, 'wx');
  try {
    try {
      writeSync(descriptor, content);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, target);
  } catch (cause) {
    rmSync(temporary, { force: true });
    throw cause;
  }
}

function readTarget(target) {
  if (!existsSync(target)) return null;
  if (!statSync(target).isFile()) throw new HostSettingsError('APA_HOST_SETTINGS_TARGET_NOT_FILE', `${target} exists but is not a file.`, { fileProblem: true });
  return readFileSync(target, 'utf8');
}

const isHookHost = host => host.capability === 'compact_hook';

const alternativesFor = (host, tokens) => isHookHost(host) ? []
  : host.name === 'codex'
    ? [`codex -c ${CODEX_KEY}=${tokens}`]
    : [`/autocompact ${tokens}`, `claude --autocompact ${tokens}`];

const notesFor = host => isHookHost(host)
  ? ['钩子只读：压缩后（SessionStart、matcher compact）重新注入进行中 APA 运行的路径、已接收结果和下一步，不写任何文件。', '写入的是已被 git 忽略的项目设置；新会话生效，压缩后的真实注入效果在实际观察前为 not_run。', '命令依赖钩子 shell 展开 $CLAUDE_PROJECT_DIR（本机为 Git Bash）；若钩子 shell 配成 PowerShell 或 cmd，该变量不会按此写法展开，须自行改写命令。']
  : host.name === 'codex'
  ? ['窗口为 258400 token 的模型留给压缩的余量很小，数值过大可能来不及压缩；越小压缩越早、保留的上下文越少。', '现有会话不受影响，须新开会话；键名有效性以 codex --strict-config 启动核验。']
  : ['Claude Code 允许范围 100000–1000000 token（不是比例）；越小压缩越早、保留的上下文越少。', '优先级：环境变量 CLAUDE_CODE_AUTO_COMPACT_WINDOW、/autocompact 与 --autocompact 高于此设置键；新会话生效。'];

function buildPlan(host, options) {
  const target = resolveTarget({ host: host.name, scope: host.scope, settingsFile: options['settings-file'] });
  const backupDir = resolve(options['backup-dir'] ?? join(defaultRepoRoot, 'config', 'backups', host.name === 'claude-code' ? 'claude' : host.name));
  const raw = readTarget(target);
  const edit = isHookHost(host) ? editHook : host.ext === 'json' ? editJson : editToml;
  const base = {
    host: host.name, capability: host.capability, scope: host.scope, key: host.key, target,
    alternatives: alternativesFor(host, host.tokens), notes: notesFor(host),
  };
  let result;
  try {
    result = edit(raw, host.key, host.tokens);
  } catch (cause) {
    if (!(cause instanceof HostSettingsError && cause.fileProblem)) throw cause;
    return { ...base, before: { exists: true, value: null }, after: null, change: null, backup_path: null, problem: { code: cause.code, message: cause.message }, error: cause };
  }
  const changed = result.change !== 'unchanged';
  return {
    ...base,
    before: { exists: raw !== null, value: result.before },
    after: { exists: true, value: isHookHost(host) ? hookEntry() : host.tokens },
    change: result.change,
    backup_path: raw !== null && changed ? claimBackup(host, target, backupDir, { dryRun: true }) : null,
    content: result.text, raw, backupDir,
  };
}

const publicPlan = ({ content, raw, backupDir, error, ...plan }) => plan;

// Reads the written file back and reports whether it now holds what was requested.
function readBack(host, target) {
  const raw = readFileSync(target, 'utf8');
  if (isHookHost(host)) {
    const list = JSON.parse(raw.replace(/^\uFEFF/, '')).hooks?.SessionStart;
    return hasHookEntry(list);
  }
  if (host.ext === 'json') return JSON.parse(raw.replace(/^\uFEFF/, ''))[host.key] === host.tokens;
  const [match] = findTomlKey(raw.replace(/^\uFEFF/, '')).matches;
  return (match ? Number(match[2]) : null) === host.tokens;
}

export function execute(argv) {
  const { command, options } = parseArguments(argv);
  if (command === 'restore') return restore(options);
  const host = validateHost(options, { needTokens: options.capability !== 'compact_hook', needCapability: true });
  const plan = buildPlan(host, options);
  if (command === 'plan') return { exitCode: plan.problem ? 1 : 0, output: publicPlan(plan) };
  if (!options.confirm) throw new HostSettingsError('APA_HOST_SETTINGS_CONFIRM_REQUIRED', 'apply writes a settings file and needs --confirm; run plan first and review the change.');
  if (plan.error) throw plan.error;
  if (plan.change === 'unchanged') return { exitCode: 0, output: { applied: false, changed: false, ...publicPlan(plan), verified: readBack(host, plan.target) } };
  const backupPath = plan.raw !== null ? claimBackup(host, plan.target, plan.backupDir) : null;
  writeAtomic(plan.target, plan.content);
  let verified;
  try {
    verified = readBack(host, plan.target);
  } catch (cause) {
    throw new HostSettingsError('APA_HOST_SETTINGS_VERIFY_FAILED', `The file was written but could not be read back (${cause.message}); restore it from the backup ${backupPath ?? '(none: the file did not exist before)'}.`);
  }
  return { exitCode: verified ? 0 : 1, output: { applied: true, changed: true, ...publicPlan({ ...plan, backup_path: backupPath }), verified } };
}

function restore(options) {
  const host = validateHost(options, { needTokens: false, needCapability: false });
  if (!options.confirm) throw new HostSettingsError('APA_HOST_SETTINGS_CONFIRM_REQUIRED', 'restore overwrites the settings file and needs --confirm.');
  if (!options.backup) throw new HostSettingsError('APA_HOST_SETTINGS_BACKUP_REQUIRED', '--backup <path> is required for restore.');
  const backup = resolve(options.backup);
  if (!existsSync(backup) || !statSync(backup).isFile()) throw new HostSettingsError('APA_HOST_SETTINGS_BACKUP_MISSING', `Backup file ${backup} does not exist.`);
  const name = basename(backup);
  if (!name.startsWith(`host-settings-${host.name}-`) || !name.endsWith(`.${host.ext}`)) {
    throw new HostSettingsError('APA_HOST_SETTINGS_BACKUP_NOT_RECOGNIZED', `${name} is not a host-settings backup for ${host.name} (host-settings-${host.name}-*.${host.ext}).`);
  }
  const target = resolveTarget({ host: host.name, scope: host.scope, settingsFile: options['settings-file'] });
  const backupDir = resolve(options['backup-dir'] ?? join(defaultRepoRoot, 'config', 'backups', host.name === 'claude-code' ? 'claude' : host.name));
  const replaced = existsSync(target) ? claimBackup(host, target, backupDir) : null;
  writeAtomic(target, readFileSync(backup));
  return { exitCode: 0, output: { restored: true, target, from: backup, replaced_file_backup: replaced } };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  try {
    const { exitCode, output } = execute(process.argv.slice(2));
    console.log(JSON.stringify(output, null, 2));
    process.exitCode = exitCode;
  } catch (cause) {
    console.error(JSON.stringify({ ok: false, error: { code: cause.code ?? 'APA_HOST_SETTINGS_FAILED', message: cause.message } }));
    process.exitCode = 1;
  }
}
