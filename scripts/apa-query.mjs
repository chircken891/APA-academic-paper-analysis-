#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { queryLibrary, prepareLibraryQuery, readQuerySource } from './v3/library-query.mjs';
import { prepareTopicSave, readTopicSources, getTopicUpdateHints, prepareTopicUpdate, prepareSourceChange, cancelTopicOperation } from './v3/topic-library.mjs';
import { libraryInventory, libraryLandscape, libraryDossier, libraryClues } from './v3/library-map.mjs';
import { renderSynthesisOutput } from './v3/synthesis-renderer.mjs';
import { validateSynthesisOutput } from './v3/library-synthesis.mjs';
import { prepareExternalNovelty, executeExternalNovelty, assessExternalNovelty } from './v3/external-novelty.mjs';
import { prepareWritingProjectSave, prepareWritingProjectUpdate, exportWritingProjectReferences } from './v3/writing-project.mjs';

const defaultVaultRoot = fileURLToPath(new URL('../', import.meta.url));
const usage = 'node scripts/apa-query.mjs search --query <text> [--limit <n> --hits-per-paper <n> --snippet-chars <n> --full] | inventory | landscape [--canvas] | dossier --node <id|alias> | clues --from <paper|node|question> [--canvas] | request|draft|review|validate-result|render-result|project-save|project-update-request|project-update-candidate|novelty|topic-save|topic-update-request|topic-update-candidate|source-change|topic-cancel --input <json-file|-> [--section <section>] | export-refs --project-id <id> [--format bibtex|ris|both] | topic-hints --generation-id <id> | topic-sources --topic-id <id> --generation-id <id> | source --paper-id <id> --generation-id <id> [--source-id <id>] [--vault-root <path>]';
const inputCommands = ['request', 'render-result', 'validate-result', 'draft', 'review', 'novelty', 'project-save', 'project-update-request', 'project-update-candidate', 'topic-save', 'topic-update-request', 'topic-update-candidate', 'source-change', 'topic-cancel'];

function invalidArguments(topic = false) {
  throw Object.assign(new Error('Expected search arguments, a request JSON input, or generation-bound source identifiers.'), {
    code: topic ? 'P24_QUERY_ARGUMENT_INVALID' : 'P23_QUERY_ARGUMENT_INVALID', exitCode: 2, usage,
  });
}

export function parseQueryArguments(args) {
  const [command, ...tokens] = args;
  const invalid = () => invalidArguments(command?.startsWith('topic-'));
  const flags = {
    search: ['--query', '--vault-root', '--limit', '--hits-per-paper', '--snippet-chars', '--full', '--entity-type', '--module', '--year-from', '--year-to', '--paper-id'],
    inventory: ['--vault-root'],
    landscape: ['--vault-root', '--threshold', '--canvas'],
    dossier: ['--vault-root', '--node'],
    clues: ['--vault-root', '--from', '--canvas'],
    draft: ['--input', '--vault-root', '--section'],
    review: ['--input', '--vault-root', '--section'],
    novelty: ['--input', '--vault-root'],
    'project-save': ['--input', '--vault-root'],
    'project-update-request': ['--input', '--vault-root'],
    'project-update-candidate': ['--input', '--vault-root'],
    'export-refs': ['--project-id', '--format', '--vault-root'],
    request: ['--input', '--vault-root'],
    'render-result': ['--input', '--vault-root'],
    'validate-result': ['--input', '--vault-root'],
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
  for (let index = 0; index < tokens.length; index++) {
    const flag = tokens[index];
    const boolean = ['--full', '--canvas'].includes(flag);
    const value = boolean ? true : tokens[++index];
    if (!flags[command].includes(flag) || options.has(flag)
      || (!boolean && (typeof value !== 'string' || !value.trim() || value.startsWith('--')))) invalid();
    options.set(flag, value);
  }
  const vaultRoot = options.has('--vault-root') ? resolve(options.get('--vault-root')) : defaultVaultRoot;
  if (command === 'search') {
    if (!options.has('--query')) invalid();
    const result = { vaultRoot, query: options.get('--query').trim() };
    for (const [flag, key] of [['--limit', 'limit'], ['--hits-per-paper', 'hitsPerPaper'], ['--snippet-chars', 'snippetChars']]) if (options.has(flag)) {
      const value = Number(options.get(flag));
      if (!Number.isSafeInteger(value) || value < 1) invalid();
      result[key] = value;
    }
    if (options.has('--full')) result.full = true;
    const filters = {};
    if (options.has('--entity-type')) filters.entityTypes = options.get('--entity-type').split(',');
    if (options.has('--module')) filters.modules = options.get('--module').split(',').map(Number);
    if (options.has('--paper-id')) filters.paperIds = options.get('--paper-id').split(',');
    for (const [flag, key] of [['--year-from', 'yearFrom'], ['--year-to', 'yearTo']]) if (options.has(flag)) filters[key] = Number(options.get(flag));
    if (Object.keys(filters).length) result.filters = filters;
    return result;
  }
  if (['inventory', 'landscape', 'dossier', 'clues'].includes(command)) {
    if ((command === 'dossier' && !options.has('--node')) || (command === 'clues' && !options.has('--from'))) invalid();
    return { vaultRoot, ...(options.has('--node') ? { node: options.get('--node') } : {}),
      ...(options.has('--from') ? { from: options.get('--from') } : {}),
      ...(options.has('--threshold') ? { threshold: Number(options.get('--threshold')) } : {}),
      ...(options.has('--canvas') ? { canvas: true } : {}) };
  }
  if (command === 'export-refs') {
    if (!options.has('--project-id') || (options.has('--format') && !['bibtex', 'ris', 'both'].includes(options.get('--format')))) invalid();
    return { vaultRoot, projectId: options.get('--project-id'), format: options.get('--format') ?? 'both' };
  }
  if (inputCommands.includes(command)) {
    if (!options.has('--input')) invalid();
    return { vaultRoot, input: options.get('--input'), ...(options.has('--section') ? { section: options.get('--section') } : {}) };
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
  const queryKeys = ['question', 'searchQuery', 'preferences', 'mainSession', 'supportedModelPairs', 'hostCapabilities', 'mode', 'node', 'from', 'paperIds', 'projectId', 'writingContext', 'section', 'draftText', 'userResults', 'searchOptions'];
  if (['render-result', 'validate-result', 'project-save', 'project-update-request', 'project-update-candidate', 'novelty'].includes(command)) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ['repoRoot', 'vaultRoot', 'executeHost', 'adapter', 'fetch'].some(key => Object.hasOwn(value, key))) invalidArguments(true);
    return value;
  }
  const allowed = { request: queryKeys, draft: queryKeys, review: queryKeys, 'topic-save': saveKeys,
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

async function noveltyRequest(input) {
  if (input.phase === 'assess') return assessExternalNovelty(input);
  return input.network_authorized === true ? executeExternalNovelty(input) : prepareExternalNovelty(input);
}

async function exportReferences(options) {
  const input = { repoRoot: options.vaultRoot, projectId: options.projectId };
  if (options.format !== 'both') return exportWritingProjectReferences({ ...input, format: options.format });
  const bibtex = await exportWritingProjectReferences({ ...input, format: 'bibtex' });
  const ris = await exportWritingProjectReferences({ ...input, format: 'ris' });
  if (bibtex.generation_id !== ris.generation_id || bibtex.project_content_sha256 !== ris.project_content_sha256) throw Object.assign(new Error('P23_CURRENT_CHANGED'), { code: 'P23_CURRENT_CHANGED' });
  return { ok: true, generation_id: bibtex.generation_id, bibtex, ris };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = parseQueryArguments(args);
    const result = args[0] === 'search' ? await queryLibrary(options)
      : ['inventory', 'landscape', 'dossier', 'clues'].includes(args[0]) ? await ({ inventory: libraryInventory, landscape: libraryLandscape, dossier: libraryDossier, clues: libraryClues })[args[0]](options)
        : args[0] === 'novelty' ? await noveltyRequest(readRequest(options.input, args[0]))
        : args[0] === 'export-refs' ? await exportReferences(options)
        : ['project-save', 'project-update-candidate'].includes(args[0]) ? await prepareWritingProjectSave({ ...readRequest(options.input, args[0]), repoRoot: options.vaultRoot })
        : args[0] === 'project-update-request' ? await prepareWritingProjectUpdate({ ...readRequest(options.input, args[0]), repoRoot: options.vaultRoot })
        : args[0] === 'render-result' ? { ok: true, answer: renderSynthesisOutput(readRequest(options.input, args[0])), scientific_verification: 'not_performed' }
        : args[0] === 'validate-result' ? { ok: true, ...await validateSynthesisOutput({ ...readRequest(options.input, args[0]), repoRoot: options.vaultRoot }) }
        : ['draft', 'review'].includes(args[0]) ? await prepareLibraryQuery({ ...readRequest(options.input, args[0]), repoRoot: options.vaultRoot, mode: args[0], ...(options.section ? { section: options.section } : {}) })
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
