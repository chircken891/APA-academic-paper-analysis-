import { readFile } from 'node:fs/promises';
import { prepareReadingBatch, readReadingBatchStatus } from './reading-batch.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

async function run() {
  const [command, ...args] = process.argv.slice(2);
  if (!['prepare', 'status'].includes(command)) fail('READING_BATCH_CLI_COMMAND_INVALID');
  const allowed = command === 'prepare' ? ['--root', '--batch', '--manifest', '--pdf', '--options'] : ['--root', '--batch'];
  const options = new Map();
  const pdfPaths = [];
  for (let index = 0; index < args.length; index += 2) {
    const [flag, value] = args.slice(index, index + 2);
    if (!allowed.includes(flag) || !value || value.startsWith('--') || options.has(flag)) fail('READING_BATCH_CLI_ARGUMENT_INVALID');
    if (flag === '--pdf') pdfPaths.push(value);
    else options.set(flag, value);
  }
  const vaultRoot = options.get('--root');
  const batchId = options.get('--batch');
  if (command === 'status') return readReadingBatchStatus({ vaultRoot, batchId });
  const manifestPath = options.get('--manifest');
  const optionsPath = options.get('--options');
  if (manifestPath && (pdfPaths.length || optionsPath) || !manifestPath && (!pdfPaths.length || !optionsPath)) fail('READING_BATCH_CLI_ARGUMENT_INVALID');
  if (manifestPath) {
    const input = await readJson(manifestPath);
    if (input?.schema_version !== 'reading-batch-request-1.0' || !Array.isArray(input.papers)) fail('READING_BATCH_MANIFEST_INVALID');
    if (batchId !== undefined && input.batchId !== undefined && batchId !== input.batchId) fail('READING_BATCH_ID_CONFLICT');
    return prepareReadingBatch({ vaultRoot, batchId: batchId ?? input.batchId, defaults: input.defaults, papers: input.papers });
  }
  return prepareReadingBatch({ vaultRoot, batchId, defaults: await readJson(optionsPath), pdfPaths });
}

try {
  const result = await run();
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.papers.some(row => ['preparation_failed', 'status_unavailable'].includes(row.status))) process.exitCode = 1;
} catch (error) {
  process.stderr.write(JSON.stringify({ code: error.code ?? 'READING_BATCH_CLI_FAILED', message: error.message, details: error.details }) + '\n');
  process.exitCode = 1;
}
