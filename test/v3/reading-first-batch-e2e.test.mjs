import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import * as queue from '../../scripts/v3/reading-first-publication-queue.mjs';
import { readRegisteredCommit } from '../../scripts/v3/phase22-active-version.mjs';
import { queryLibrary } from '../../scripts/v3/library-query.mjs';
import { checkCommittedIndex } from '../../scripts/check-bm25-index.mjs';
import { inspectV3Graph } from '../../scripts/v3/obsidian-graph.mjs';
import { syncCommittedGraph } from '../../scripts/v3/obsidian-graph-sync.mjs';
import { readingFirstPublicationFixture } from './helpers/reading-first-publication-fixtures.mjs';

const childScript = `
import { readFile } from 'node:fs/promises';
import { reviewedReadingFirstFixture } from ${JSON.stringify(new URL('./helpers/reading-first-publication-source-fixtures.mjs', import.meta.url).href)};
import { captureReadingFirstPublicationSource } from ${JSON.stringify(new URL('../../scripts/v3/reading-first-runtime.mjs', import.meta.url).href)};
import { prepareReadingFirstPublicationQueue, approveAndDrainReadingFirstPublicationQueue } from ${JSON.stringify(new URL('../../scripts/v3/reading-first-publication-queue.mjs', import.meta.url).href)};
const input = JSON.parse(await readFile(process.argv[1], 'utf8'));
const commands = new Set(), waiting = new Map();
process.on('message', command => { commands.add(command); waiting.get(command)?.(); });
const waitFor = command => commands.has(command) ? Promise.resolve() : new Promise(resolve => waiting.set(command, resolve));
try {
  const f = await reviewedReadingFirstFixture({ after() { throw Error('Unexpected fixture cleanup'); } }, input.fixture);
  const source = await captureReadingFirstPublicationSource({ controller: f.controller, presentation: f.candidate });
  const captureSource = async () => source;
  process.send({ event: 'reviewed' });
  await waitFor('prepare');
  const prepared = await prepareReadingFirstPublicationQueue({ vaultRoot: input.vaultRoot, evidenceMode: 'synthetic', captureSource,
    entries: [{ run: f.runId, runRoot: f.artifactRoot, resources: f.resources, generation: input.generation }] });
  process.send({ event: 'prepared' });
  await waitFor('approve');
  const result = await approveAndDrainReadingFirstPublicationQueue({ vaultRoot: input.vaultRoot,
    proposal: prepared.proposal, expectedProposalSha256: prepared.proposal_sha256,
    authorization: { authorization_id: input.authorizationId, user_reply: '发布' }, captureSource,
    onPrepared: async () => { if (input.hold) { process.send({ event: 'holding' }); await waitFor('release'); } },
    onWait: event => process.send({ event: 'waiting', data: event }) });
  process.send({ event: 'finished', result });
} catch (error) {
  process.send({ event: 'failed', error: { code: error.code, message: error.message, details: error.details, stack: error.stack } });
  process.exitCode = 1;
} finally { process.disconnect(); }
`;

function childSession(path, children) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', childScript, path], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.add(child);
  const events = new Map(), waiters = new Map();
  let errors = '', failure;
  child.stderr.on('data', bytes => { errors += bytes; });
  child.stdout.resume();
  child.on('message', message => {
    events.set(message.event, message);
    if (message.event === 'failed') {
      failure = Error(JSON.stringify(message.error));
      for (const waiter of waiters.values()) waiter.reject(failure);
    } else waiters.get(message.event)?.resolve(message);
  });
  const closed = new Promise(resolve => child.on('close', code => {
    children.delete(child);
    if (!events.has('finished')) {
      failure ??= Error('Publication child exited ' + code + ': ' + errors);
      for (const waiter of waiters.values()) waiter.reject(failure);
    }
    resolve(code);
  }));
  return { child, closed, send: value => child.send(value), wait: event => {
    if (failure) return Promise.reject(failure);
    if (events.has(event)) return Promise.resolve(events.get(event));
    return new Promise((resolve, reject) => waiters.set(event, { resolve, reject }));
  } };
}

test('编辑已发布笔记、共享页和 Canvas 后，两个独立会话排队发布并通过查询、索引和图谱检查', { timeout: 120_000 }, async t => {
  assert.equal(typeof queue.approveAndDrainReadingFirstPublicationQueue, 'function');
  const children = new Set();
  t.after(async () => {
    await Promise.all([...children].map(child => new Promise(resolve => {
      child.once('close', resolve);
      child.kill();
    })));
  });
  const first = await readingFirstPublicationFixture(t, { register: false });
  const options = { vaultRoot: first.vaultRoot, evidenceMode: 'synthetic', captureSource: async () => first.source };
  const initial = await queue.prepareReadingFirstPublicationQueue({ ...options,
    entries: [{ run: first.runId, runRoot: first.artifactRoot, resources: first.resources, generation: 'batch-e2e-a' }] });
  const committed = await queue.approveAndDrainReadingFirstPublicationQueue({ ...options,
    proposal: initial.proposal, expectedProposalSha256: initial.proposal_sha256,
    authorization: { authorization_id: 'batch-e2e-approval-a', user_reply: '发布' } });
  assert.equal(committed.status, 'complete', JSON.stringify(committed));
  await mkdir(join(first.vaultRoot, '.obsidian'), { recursive: true });
  await writeFile(join(first.vaultRoot, '.obsidian/graph.json'), '{}');
  assert.equal((await syncCommittedGraph({ vaultRoot: first.vaultRoot, enableAutoSync: true })).ok, true);

  const sessions = [];
  for (const id of ['b', 'c']) {
    const catalog = structuredClone(first.presentationCatalog);
    catalog.bibliography.title = { en: 'Publication ' + id, 'zh-CN': '发布论文 ' + id };
    catalog.source_pdf = 'Raw/pap_' + id.repeat(32) + '.pdf';
    catalog.visuals[0].path = 'Figures/pap_' + id.repeat(32) + '/figure.png';
    catalog.knowledge[0].paragraphs.en.push('Independent contribution ' + id + '.');
    catalog.knowledge[0].paragraphs['zh-CN'].push('独立贡献 ' + id + '。');
    const input = { vaultRoot: first.vaultRoot, generation: 'batch-e2e-' + id, authorizationId: 'batch-e2e-approval-' + id,
      hold: id === 'b', fixture: { artifactRoot: join(first.root, 'child-' + id), currentRegistryRoot: first.vaultRoot,
        presentation: catalog, runId: 'run_' + id.repeat(32), paperId: 'pap_' + id.repeat(32), sourceText: 'Independent original ' + id } };
    const path = join(first.root, 'child-' + id + '.json');
    await writeFile(path, JSON.stringify(input));
    sessions.push(childSession(path, children));
  }
  const [second, third] = sessions;
  await Promise.all(sessions.map(session => session.wait('reviewed')));
  const snapshot = await readRegisteredCommit(options);
  const paperPath = snapshot.generation.papers[0].paths.en;
  const paperBytes = await readFile(join(first.vaultRoot, paperPath), 'utf8');
  const editedPaper = paperBytes.replace('<!-- AUTO:END reading -->', '\nHumanpapereditmarker.\n<!-- AUTO:END reading -->');
  assert.notEqual(editedPaper, paperBytes);
  await writeFile(join(first.vaultRoot, paperPath), editedPaper);
  const sharedPath = snapshot.generation.shared_nodes[0].path;
  const sharedBytes = await readFile(join(first.vaultRoot, sharedPath), 'utf8');
  const editedShared = sharedBytes.replace('<!-- AUTO:END shared-knowledge -->', '\nHumansharededitmarker.\n<!-- AUTO:END shared-knowledge -->');
  assert.notEqual(editedShared, sharedBytes);
  await writeFile(join(first.vaultRoot, sharedPath), editedShared);
  const canvasPath = snapshot.generation.objects.find(row => row.path.endsWith('research-map.en.canvas')).path;
  const canvas = JSON.parse(await readFile(join(first.vaultRoot, canvasPath), 'utf8'));
  canvas.nodes[0].x += 37;
  canvas.edges.forEach(edge => { if (edge.toEnd === 'arrow') delete edge.toEnd; });
  const editedCanvas = JSON.stringify(canvas);
  await writeFile(join(first.vaultRoot, canvasPath), editedCanvas);
  sessions.forEach(session => session.send('prepare'));
  await Promise.all(sessions.map(session => session.wait('prepared')));
  second.send('approve');
  await second.wait('holding');
  third.send('approve');
  const waiting = await third.wait('waiting');
  assert.equal(waiting.data.lock, 'runtime-consumer');
  const approvalId = 'batch-e2e-approval-c';
  const approvalFile = 'QUEUE-APPROVAL-' + createHash('sha256').update(approvalId).digest('hex') + '.json';
  const saved = JSON.parse(await readFile(join(first.vaultRoot, 'Eval/apa-v3/runs', 'run_' + 'c'.repeat(32), 'publication', approvalFile)));
  assert.equal(saved.authorization.authorization_id, approvalId);
  second.send('release');
  const finished = await Promise.all(sessions.map(session => session.wait('finished')));
  assert.deepEqual(finished.map(row => row.result.status), ['complete', 'complete']);
  assert.deepEqual(await Promise.all(sessions.map(session => session.closed)), [0, 0]);
  const state = await queue.readReadingFirstPublicationQueue(options);
  assert.deepEqual(state.entries.map(row => row.status), ['published', 'published', 'published']);
  assert.equal(new Set(state.entries.map(row => row.result.transaction_id)).size, 3);
  assert.deepEqual(state.entries.map(row => row.result.generation), ['batch-e2e-a', 'batch-e2e-b', 'batch-e2e-c']);
  assert.equal(await readFile(join(first.vaultRoot, paperPath), 'utf8'), editedPaper);
  assert.equal(await readFile(join(first.vaultRoot, canvasPath), 'utf8'), editedCanvas);
  const shared = await readFile(join(first.vaultRoot, sharedPath), 'utf8');
  assert.ok(shared.includes('Humansharededitmarker'));
  assert.ok(shared.includes('Independent contribution b.'));
  assert.ok(shared.includes('Independent contribution c.'));
  const query = await queryLibrary({ vaultRoot: first.vaultRoot, query: 'Humanpapereditmarker' });
  assert.equal(query.ok, true, JSON.stringify(query));
  assert.equal(query.results[0].paper_id, first.paperId);
  assert.equal((await checkCommittedIndex(first.vaultRoot)).paper_count, 3);
  assert.equal((await inspectV3Graph({ vaultRoot: first.vaultRoot })).ok, true);
});
