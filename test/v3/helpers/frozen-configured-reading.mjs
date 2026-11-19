import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createReadingSession } from '../../../scripts/v3/reading-session.mjs';

const codeRoot = fileURLToPath(new URL('../../../', import.meta.url));
const frozenProfile = 'configured-reading-2.2';
const currentProfile = 'configured-reading-2.3';
const template = 'Templates/apa-v3/研究导图模板.canvas';

/** Build a synthetic pre-cutover checkout inside an existing test fixture. */
export async function copyFrozenReading22(destination) {
  for (const path of ['scripts', 'Schema', 'prompts', 'docs/apa-v3', 'package.json']) {
    await cp(join(codeRoot, path), join(destination, path), { recursive: true });
  }
  await mkdir(join(destination, 'Templates/apa-v3'), { recursive: true });
  await cp(join(codeRoot, template), join(destination, template));
  return enableFrozenReading22(destination);
}

export async function enableFrozenReading22(destination) {
  const file = join(destination, 'scripts/lib/reading-profiles.mjs');
  const current = await readFile(file, 'utf8');
  const historical = current
    .replace(/^export const DEFAULT_CONFIGURED_INSTRUCTION_PROFILE = .+;/m,
      `export const DEFAULT_CONFIGURED_INSTRUCTION_PROFILE = '${frozenProfile}';`)
    .replace(/('configured-reading-2\.2': Object\.freeze\(\{\s+allowCreation: )false,/, '$1true,');
  assert.notEqual(historical, current, `Expected the active ${currentProfile} profile at ${file}`);
  await writeFile(file, historical);
  // Frozen 2.2 prepared sources before the read-only binding and previews were introduced.
  const configuredFile = join(destination, 'scripts/v3/configured-reading.mjs');
  const configured = await readFile(configuredFile, 'utf8');
  const legacyConfigured = configured.replace('sourceOptions.sourceAccess === undefined ? READ_ONLY_SOURCE_ACCESS : sourceOptions.sourceAccess',
    'sourceOptions.sourceAccess === undefined ? null : sourceOptions.sourceAccess');
  assert.notEqual(legacyConfigured, configured);
  await writeFile(configuredFile, legacyConfigured);
  const batchFile = join(destination, 'scripts/v3/reading-batch.mjs');
  const batch = await readFile(batchFile, 'utf8');
  const legacyBatch = batch.replace('}, sourceMatchMetadata: metadata });', '}, sourceMatchMetadata: metadata, sourceAccess: null });')
    .replace('sources: prepared.scientificInput.sources, source_access: READ_ONLY_SOURCE_ACCESS, source_locations: prepared.source_locations,',
      'sources: prepared.scientificInput.sources,');
  assert.ok(legacyBatch.includes('sourceAccess: null') && !legacyBatch.includes('source_access: READ_ONLY_SOURCE_ACCESS'));
  await writeFile(batchFile, legacyBatch);
  return destination;
}

export async function createFrozenReading22(options) {
  const checkout = await copyFrozenReading22(join(options.repoRoot, 'frozen-reading-22'));
  const { prepareReadingSessionExecution } = await import(pathToFileURL(join(checkout, 'scripts/v3/reading-session-cli.mjs')).href);
  const input = { ...options, instructionProfile: frozenProfile };
  return createReadingSession(input, await prepareReadingSessionExecution(input));
}
