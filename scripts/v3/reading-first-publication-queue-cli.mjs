import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { approveReadingFirstPublicationQueue, drainReadingFirstPublicationQueue, prepareReadingFirstPublicationQueue,
  readReadingFirstPublicationQueue } from './reading-first-publication-queue.mjs';

const commands = {
  prepare: ['entries', 'evidence-mode'],
  approve: ['proposal', 'proposal-sha256', 'authorization-id', 'user-reply'],
  drain: ['evidence-mode'],
  status: [],
};
const readJson = async path => JSON.parse(await readFile(resolve(path), 'utf8'));
const emit = (stream, value) => new Promise((done, reject) => stream.write(JSON.stringify(value) + '\n', error => error ? reject(error) : done()));
const fail = code => { throw Object.assign(new Error(code), { code }); };

async function main([command, ...args]) {
  if (!Object.hasOwn(commands, command)) fail('RF_QUEUE_CLI_COMMAND_REQUIRED');
  const keys = ['vault-root', ...commands[command]];
  const { values } = parseArgs({ args, options: Object.fromEntries(keys.map(key => [key, { type: 'string' }])) });
  for (const key of keys.filter(name => name !== 'evidence-mode')) if (!values[key]) fail('RF_QUEUE_CLI_ARGUMENT_REQUIRED:' + key);
  const vaultRoot = resolve(values['vault-root']);
  const evidenceMode = values['evidence-mode'];
  if (command === 'prepare') return prepareReadingFirstPublicationQueue({ vaultRoot, evidenceMode, entries: await readJson(values.entries) });
  if (command === 'approve') {
    const input = await readJson(values.proposal);
    return approveReadingFirstPublicationQueue({ vaultRoot, proposal: input.proposal, expectedProposalSha256: values['proposal-sha256'],
      authorization: { authorization_id: values['authorization-id'], user_reply: values['user-reply'] } });
  }
  if (command === 'drain') return drainReadingFirstPublicationQueue({ vaultRoot, evidenceMode,
    onPrepared: summary => emit(process.stderr, { event: 'publication-inventory', ...summary }),
    onPublished: result => emit(process.stderr, { event: 'publication-committed', ...result }) });
  const state = await readReadingFirstPublicationQueue({ vaultRoot });
  return { ok: true, queue_path: state.queue_path, entries: state.entries.map((row, index) => ({
    position: index + 1, run_id: row.run, status: row.status,
    ...(row.attempt ? { transaction_id: row.attempt.registration.transaction_id } : {}),
    ...(row.result ? { generation: row.result.generation, result_path: row.result.result_path } : {}),
    ...(row.error ? { error: row.error } : {}),
  })) };
}

try {
  const result = await main(process.argv.slice(2));
  await emit(process.stdout, result);
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  await emit(process.stdout, { ok: false, error: { code: error.code ?? error.message, ...(error.details ? { details: error.details } : {}) } });
  process.exitCode = 1;
}
