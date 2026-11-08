import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareReadingBatch, readReadingBatchStatus } from '../../scripts/v3/reading-batch.mjs';
import { writeBatchCheckpoint } from '../../scripts/v3/reading-batch-summary.mjs';
import { captureReadingFirstPublicationSource, createReadingFirstRunControl } from '../../scripts/v3/reading-first-runtime.mjs';
import { publishReadingFirstCandidate } from '../../scripts/v3/reading-first-publish.mjs';
import { reviewedReadingFirstFixture } from './helpers/reading-first-publication-source-fixtures.mjs';

const CODE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const dispatch = { tool: 'Agent', model_argument: 'model', effort_argument: 'effort', instruction_argument: 'prompt',
  task_name_argument: 'description', fresh_context: null, result_handle: { source: 'text', pattern: '"agent_id":"([^"]+)"' } };

async function fixture(t) {
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(join(parent, 'apa-reading-batch-'));
  t.after(async () => {
    assert.equal(await realpath(root), root);
    assert.equal(dirname(root), parent);
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'config'));
  await mkdir(join(root, 'Clippings'));
  const parser = join(root, 'mineru');
  const bin = join(parser, 'venv', process.platform === 'win32' ? 'Scripts' : 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, process.platform === 'win32' ? 'python.exe' : 'python'), 'fixture');
  await writeFile(join(parser, 'config.yaml'), 'fixture');
  const choice = { mode: 'explicit', model: 'test-model', reasoning_effort: 'high' };
  const config = {
    schema_version: 'apa-local-config-1.0',
    models: { science: choice, overrides: {}, roles: Object.fromEntries(
      ['english-writer', 'chinese-writer', 'translation', 'reading-editor', 'independent-verifier'].map(role => [role, choice])) },
    paths: { runs: 'runs', parse: 'parse', candidates: 'candidates' },
    parser: { runtime_home: parser },
    reading: { source_language: 'en', presentation_mode: 'reading-editor' },
    writing_skills: Object.fromEntries(['nature-writing', 'nature-polishing', 'nature-shared', 'humanizer', 'humanizer-zh', 'stss'].map(key => [key, { enabled: false }])),
    host: { name: 'test-host', dispatch },
  };
  await writeFile(join(root, 'config', 'apa.local.json'), JSON.stringify(config));
  const paths = [join(root, 'Clippings', 'one.pdf'), join(root, 'two.pdf')];
  await writeFile(paths[0], 'synthetic one');
  await writeFile(paths[1], 'synthetic two');
  return { root, paths, input: { batchId: 'batch-1', defaults: { authorizationId: 'user-approval', maxTotalCalls: 14,
    sessionContext: { model: 'test-model', effort: 'high' } } } };
}

test('batch refuses duplicate bytes before preparing any run', async t => {
  const { root, paths, input } = await fixture(t);
  await writeFile(paths[1], await readFile(paths[0]));
  await assert.rejects(prepareReadingBatch({ vaultRoot: root, ...input, pdfPaths: paths }), {
    code: 'READING_BATCH_DUPLICATE_SOURCE',
  });
  await assert.rejects(readFile(join(root, 'Clippings', 'two.pdf')), { code: 'ENOENT' });
});

test('batch prepares separate run roots with one code snapshot and bounded body-free status', async t => {
  const { root, paths, input } = await fixture(t);
  const batch = await prepareReadingBatch({ vaultRoot: root, ...input, pdfPaths: paths });
  assert.equal(batch.papers.length, 2);
  assert.notEqual(batch.papers[0].run_root, batch.papers[1].run_root);
  assert.ok(batch.papers.every(row => row.snapshot_hash === batch.snapshot_hash));
  assert.equal(await readFile(join(root, 'Clippings', 'two.pdf'), 'utf8'), 'synthetic two');
  assert.ok(batch.papers.every(row => row.startup_prompt.includes(row.run_id)));
  for (const row of batch.papers) {
    const control = join(row.run_root, 'control');
    await mkdir(control);
    // A status implementation opening the main checkpoint would fail on this directory.
    await mkdir(join(control, 'science-state.json'));
  }
  const status = await readReadingBatchStatus({ vaultRoot: root, batchId: input.batchId });
  assert.ok(status.papers.every(row => row.status === 'prepared' && Buffer.byteLength(JSON.stringify(row)) <= 8192));
  const run = batch.papers[0];
  await writeBatchCheckpoint(run.run_root, { runId: run.run_id, stage: 'reading', status: 'awaiting',
    action: 'await-user', kind: '审核😀'.repeat(3000), code: '\u0000'.repeat(3000), task: '复核'.repeat(3000) });
  const publication = join(root, 'Eval', 'apa-v3', 'runs', run.run_id, 'publication');
  await mkdir(publication, { recursive: true });
  const raw = { path: 'Raw/本次写入.pdf', title: '追溯文献', doi: '10.1000/example', trace_reason: '证据缺口'.repeat(3000),
    notes: ['Wiki/sources/论文.md'] };
  await writeFile(join(publication, 'VERIFICATION.json'), JSON.stringify({ status: 'passed', publication_sources: { raw_supplements: [raw] } }));
  const published = await readReadingBatchStatus({ vaultRoot: root, batchId: input.batchId });
  assert.equal(published.papers[0].raw_supplement_count, 1);
  assert.equal(published.papers[0].status, 'published');
  assert.equal(published.papers[1].status, 'prepared');
  assert.deepEqual(published.raw_supplements, [{ run_id: run.run_id, ...raw }]);
  assert.ok(published.papers.every(row => Buffer.byteLength(JSON.stringify(row)) <= 8192));
  await writeFile(join(run.run_root, 'reading-batch-checkpoint.json'), '坏'.repeat(8192));
  const damaged = await readReadingBatchStatus({ vaultRoot: root, batchId: input.batchId });
  assert.equal(damaged.papers[0].status, 'status_unavailable');
  assert.equal(damaged.papers[1].status, 'prepared');
});

test('a source unavailable for one paper leaves other runs ready', async t => {
  const { root, paths, input } = await fixture(t);
  const result = await prepareReadingBatch({ vaultRoot: root, ...input, pdfPaths: [join(root, 'missing.pdf'), paths[1]] });
  assert.equal(result.papers[0].status, 'preparation_failed');
  assert.equal(result.papers[1].status, 'prepared');
  const status = await readReadingBatchStatus({ vaultRoot: root, batchId: input.batchId });
  assert.deepEqual(status.papers.map(row => row.status), ['preparation_failed', 'prepared']);
});

test('batch checks the committed source fingerprint and reports moved Clippings originals before writing', async t => {
  const { root, paths, input } = await fixture(t);
  const original = 'Clippings/intake/source.pdf';
  const template = await reviewedReadingFirstFixture(t);
  const presentation = { ...template.presentationCatalog, source_pdf: original,
    sources: [{ id: template.source.id, path: original, kind: 'main' }] };
  const published = await reviewedReadingFirstFixture(t, { currentRegistryRoot: root, presentation, translationLanguage: null,
    artifactRoot: join(root, 'Clippings', 'intake'),
    createRunControl: args => createReadingFirstRunControl({ ...args, configuredSetup: {
      ...args.configuredSetup, source_policy: 'clippings-originals-1.0',
      source_locations: args.scientificInput.sources.map(source => ({
        source_id: source.id, path: source.path, vault_path: original,
        original_path: source.path, sha256: source.sha256, byte_length: source.byte_length,
      })),
    } }),
  });
  const source = await captureReadingFirstPublicationSource({ controller: published.controller, presentation: published.candidate });
  const result = await publishReadingFirstCandidate({ source, vaultRoot: root, resources: published.resources,
    evidenceMode: 'synthetic', generation: 'batch-duplicate-fixture',
    authorization: { authorization_id: 'batch-test', user_reply: '发布' }, onPrepared() {} });
  assert.equal(result.status, 'committed');
  await writeFile(paths[1], await readFile(join(root, original)));
  await assert.rejects(prepareReadingBatch({ vaultRoot: root, ...input, pdfPaths: paths }), error => {
    assert.equal(error.code, 'READING_BATCH_DUPLICATE_SOURCE');
    assert.equal(error.details.existing, original);
    return true;
  });
  const moved = 'Clippings/intake/renamed.pdf';
  await rename(join(root, original), join(root, moved));
  await assert.rejects(prepareReadingBatch({ vaultRoot: root, ...input, pdfPaths: [paths[0]] }), error => {
    assert.equal(error.code, 'RF_PUBLICATION_PREVIOUS_OBJECT_CHANGED');
    assert.equal(error.details.path, original);
    assert.equal(error.details.status, 'missing');
    assert.ok(error.details.same_byte_candidates.includes(moved));
    return true;
  });
  await assert.rejects(readFile(join(root, '.runtime', 'apa-reading-batches', input.batchId + '.json')), { code: 'ENOENT' });
});

test('batch CLI freezes the session against checkout and parameter changes and updates the short checkpoint', async t => {
  const { root, paths, input } = await fixture(t);
  const checkout = join(root, 'checkout');
  const dependencyRoot = resolve(CODE_ROOT, 'node_modules');
  await mkdir(join(checkout, 'docs'), { recursive: true });
  for (const path of ['scripts', 'Schema', 'prompts', 'docs/apa-v3', 'package.json']) {
    await cp(join(CODE_ROOT, path), join(checkout, path), { recursive: true });
  }
  await symlink(dependencyRoot, join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const cli = (script, ...args) => JSON.parse(execFileSync(process.execPath, [join(checkout, 'scripts', 'v3', script), ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const manifest = join(root, 'batch-input.json');
  await writeFile(manifest, JSON.stringify({ schema_version: 'reading-batch-request-1.0', ...input, papers: [{ pdf: paths[0] },
    { pdf: paths[1], maxTotalCalls: 10 }] }));
  const batch = cli('reading-batch-cli.mjs', 'prepare', '--root', root, '--manifest', manifest);
  assert.deepEqual(batch.papers.map(row => row.budget.max_total_calls), [14, 10]);
  const first = batch.papers[0];
  const frozen = JSON.parse(await readFile(join(first.run_root, 'reading-batch-run.json')));
  const configuration = JSON.parse(await readFile(join(root, 'config', 'apa.local.json')));
  const hostProfile = { schema_version: 'apa-host-profile-1.0', host: 'test-host', detected_at: '2026-11-08T00:00:00Z',
    session: { model: 'test-model', reasoning_effort: 'high' }, models: [{ model: 'test-model', reasoning_efforts: ['high'] }],
    dispatch, sources: { session: 'system-context', models: 'tool-schema', dispatch: 'tool-schema' } };
  const observedTool = { status: 'pass', source: 'tool-declaration', reference: 'fixture', method: 'fixture', observation: 'fixture' };
  const evidence = { current_host: { name: hostProfile.host, reference: 'fixture' },
    dispatch: { source: 'tool-schema', tool: 'Agent', reference: 'fixture' },
    fresh_context: { source: 'host-docs', reference: 'fixture', blank_context: true },
    file_read: { status: 'pass', reference: 'fixture' }, input: { status: 'pass', reference: 'fixture' },
    results_tools: { python: { ...observedTool, path: join(configuration.parser.runtime_home, 'venv',
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python') },
    libraries: { ...observedTool, names: ['fitz'] }, visual_read: observedTool, file_read: observedTool } };
  const sessionInput = { repoRoot: root, runId: first.run_id, ...frozen.options, sourceLanguage: 'zh-CN', hostProfile, evidence,
    scientificInput: { profile: 'reading-first-1.0', identity: { run_id: first.run_id, paper_id: 'pap_' + 'a'.repeat(32) },
      sources: frozen.sources, context: 'synthetic', role_artifacts: ['evidence', 'methods', 'results', 'interpretation', 'scientific-reading', 'integration'] } };
  await writeFile(join(checkout, 'scripts', 'v3', 'reading-session.mjs'), 'throw new Error("live checkout session loaded");\n');
  const createPath = join(root, 'create-input.json');
  const exportDir = join(first.run_root, 'host', 'export');
  const create = () => cli('reading-session-cli.mjs', 'create', '--input', createPath, '--export-dir', exportDir);
  await writeFile(createPath, JSON.stringify({ ...sessionInput, maxCalls: 4 }));
  assert.throws(create, error => error.stderr.includes('READING_BATCH_RUN_OPTIONS_CHANGED'));
  await writeFile(createPath, JSON.stringify(sessionInput));
  const action = create();
  assert.equal(action.action, 'dispatch', action.preflight?.reasons.join(', '));
  const getStatus = () => JSON.parse(execFileSync(process.execPath, [
    join(CODE_ROOT, 'scripts', 'v3', 'reading-batch-cli.mjs'), 'status', '--root', root, '--batch', input.batchId,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const status = getStatus();
  assert.equal(status.papers[0].stage, 'science');
  assert.equal(status.papers[0].budget.total_used, 1);
  assert.equal(status.papers[0].budget.issued_unconfirmed, 1);
  assert.equal(status.papers[1].status, 'prepared');
  const eventPath = join(root, 'event-input.json');
  const receiptPath = join(root, 'synthetic-host-result.json');
  await writeFile(receiptPath, JSON.stringify({ agent_id: 'synthetic-host-task' }));
  await writeFile(eventPath, JSON.stringify({ kind: 'host_observation', action_id: action.action_id, observation: {
    action_id: action.action_id, run_id: action.run_id, input_fingerprint: action.input_fingerprint, port: action.port,
    tool_call: { name: action.host_action, arguments: action.arguments },
  } }));
  cli('reading-session-cli.mjs', 'event', '--run-root', first.run_root, '--input', eventPath, '--raw-result', receiptPath, '--export-dir', exportDir);
  assert.equal(getStatus().papers[0].budget.observed_calls, 1);
  assert.equal(getStatus().papers[0].budget.issued_unconfirmed, 0);
  await writeFile(eventPath, JSON.stringify({ kind: 'runtime-evidence', hostProfile, evidence: {} }));
  cli('reading-session-cli.mjs', 'event', '--run-root', first.run_root, '--input', eventPath);
  assert.equal(getStatus().papers[0].pending_decision.kind, 'runtime-evidence');
  assert.equal(getStatus().papers[0].budget.total_used, 1);
  const science = JSON.parse(await readFile(join(first.run_root, 'control', 'science-state.json')));
  const binding = science.data.prepared.runControl.reading_first_binding;
  assert.equal(binding.source_language, 'zh-CN');
  assert.equal(binding.configured_setup.runtime_binding.fingerprint, frozen.snapshot_fingerprint);
});
