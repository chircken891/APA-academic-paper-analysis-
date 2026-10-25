#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { queryLibrary, prepareLibraryQuery, readQuerySource } from './v3/library-query.mjs';
import { prepareTopicSave, readTopicSources, getTopicUpdateHints, prepareTopicUpdate, prepareSourceChange, cancelTopicOperation } from './v3/topic-library.mjs';

const defaultVaultRoot = fileURLToPath(new URL('../', import.meta.url));
const usage = 'node scripts/apa-query.mjs search --query <text> | request|topic-save|topic-update-request|topic-update-candidate|source-change|topic-cancel --input <json-file|-> | topic-hints --generation-id <id> | topic-sources --topic-id <id> --generation-id <id> | source --paper-id <id> --generation-id <id> [--source-id <id>] [--vault-root <path>]';
const inputCommands = ['request', 'topic-save', 'topic-update-request', 'topic-update-candidate', 'source-change', 'topic-cancel'];

function invalidArguments(topic = false) {
  throw Object.assign(new Error('Expected search arguments, a request JSON input, or generation-bound source identifiers.'), {
    code: topic ? 'P24_QUERY_ARGUMENT_INVALID' : 'P23_QUERY_ARGUMENT_INVALID', exitCode: 2, usage,
  });
}

export function parseQueryArguments(args) {
  const [command, ...tokens] = args;
  const invalid = () => invalidArguments(command?.startsWith('topic-'));
  const flags = {
    search: ['--query', '--vault-root'],
    request: ['--input', '--vault-root'],
    'topic-save': ['--input', '--vault-root'],
    'topic-update-request': ['--input', '--vault-root'],
    'topic-update-candidate': ['--input', '--vault-root'],
    'source-change': ['--input', '--vault-root'],
    'topic-cancel': ['--input', '--vault-root'],
    'topic-hints': ['--generation-id', '--vault-root'],
    'topic-sources': ['--topic-id', '--generation-id', '--vault-root'],
    source: ['--paper-id', '--source-id', '--generation-id', '--vault-root'],
  };
  if (!Object.hasOwn(flags, command)) invalid();
  const options = new Map();
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index], value = tokens[index + 1];
    if (!flags[command].includes(flag) || options.has(flag)
      || typeof value !== 'string' || !value.trim() || value.startsWith('--')) invalid();
    options.set(flag, value);
  }
  const vaultRoot = options.has('--vault-root') ? resolve(options.get('--vault-root')) : defaultVaultRoot;
  if (command === 'search') {
    if (!options.has('--query')) invalid();
    return { vaultRoot, query: options.get('--query').trim() };
  }
  if (inputCommands.includes(command)) {
    if (!options.has('--input')) invalid();
    return { vaultRoot, input: options.get('--input') };
  }
  if (command === 'topic-hints') {
    if (!options.has('--generation-id')) invalid();
    return { vaultRoot, generationId: options.get('--generation-id') };
  }
  if (command === 'topic-sources') {
    if (!options.has('--topic-id') || !options.has('--generation-id')) invalid();
    return { vaultRoot, topicId: options.get('--topic-id'), generationId: options.get('--generation-id') };
  }
  if (!options.has('--paper-id') || !options.has('--generation-id')) invalidArguments();
  return { vaultRoot, paperId: options.get('--paper-id'), generationId: options.get('--generation-id'),
    ...(options.has('--source-id') ? { sourceId: options.get('--source-id') } : {}) };
}

function readRequest(input, command = 'request') {
  const topicSave = command !== 'request';
  let value;
  try { value = JSON.parse(readFileSync(input === '-' ? 0 : resolve(input), 'utf8')); }
  catch (error) {
    if (error instanceof SyntaxError) invalidArguments(topicSave);
    throw error;
  }
  const saveKeys = ['operationId', 'question', 'language', 'title', 'answer', 'adoptedSources', 'queryTerms', 'expectedGenerationId', 'saveIntent'];
  const allowed = { request: ['question', 'searchQuery', 'preferences', 'mainSession', 'supportedModelPairs', 'hostCapabilities'], 'topic-save': saveKeys,
    'topic-update-request': ['topicId', 'baseRevision', 'generationId', 'selectedSources', 'question', 'preferences', 'mainSession', 'supportedModelPairs', 'hostCapabilities'],
    'topic-update-candidate': [...saveKeys, 'topicId', 'baseRevision', 'execution', 'resolvedEventIds', 'eventResolutions'],
    'source-change': ['operationId', 'generationId', 'event', 'changeIntent'],
    'topic-cancel': ['operationId', 'candidateFingerprint', 'cancellationGrant', 'candidatePath'] }[command];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key))
    || (!['source-change', 'topic-cancel'].includes(command) && (typeof value.question !== 'string' || !value.question.trim()))
    || (Object.hasOwn(value, 'searchQuery') && (typeof value.searchQuery !== 'string' || !value.searchQuery.trim()))) invalidArguments(topicSave);
  return value;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = parseQueryArguments(args);
    const result = args[0] === 'search' ? await queryLibrary(options)
      : args[0] === 'source' ? await readQuerySource(options)
        : args[0] === 'topic-sources' ? await readTopicSources(options)
          : args[0] === 'topic-hints' ? await getTopicUpdateHints(options)
            : args[0] === 'topic-update-request' ? await prepareTopicUpdate({ repoRoot: options.vaultRoot, ...readRequest(options.input, args[0]) })
              : args[0] === 'source-change' ? await prepareSourceChange({ repoRoot: options.vaultRoot, ...readRequest(options.input, args[0]) })
                : args[0] === 'topic-cancel' ? await cancelTopicOperation({ repoRoot: options.vaultRoot, ...readRequest(options.input, args[0]) })
                  : ['topic-save', 'topic-update-candidate'].includes(args[0]) ? await prepareTopicSave({ repoRoot: options.vaultRoot, ...readRequest(options.input, args[0]) })
        : await prepareLibraryQuery({ repoRoot: options.vaultRoot, ...readRequest(options.input) });
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, status: 'error', error: {
      code: error.code ?? 'P23_QUERY_FAILED', message: error.message,
      ...(error.usage ? { usage: error.usage } : {}),
    } }) + '\n');
    process.exitCode = error.exitCode ?? 1;
  }
}
