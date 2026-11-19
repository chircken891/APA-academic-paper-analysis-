import { configuredReadingProfile } from '../lib/reading-profiles.mjs';
import { assertBatchRunOptions, readBatchRun } from './reading-batch-summary.mjs';
import { READ_ONLY_SOURCE_ACCESS } from './reading-source-policy.mjs';

const verifiedContinuations = new WeakMap();
const fail = code => { throw Object.assign(new Error(code), { code }); };

/** Re-read saved evidence in the process that will consume it. */
export async function resolveReadingSessionContinuation({ options, inspection, runRoot, reference, manifest = reference?.manifest }) {
  let migration;
  if (options.scienceMigration) {
    if (['scientificInput', 'sciencePayloads', 'sourceLanguage', 'maxCalls', 'presentationMode', 'includeRepairs', 'enrichmentPolicy', 'scienceTaskOverrides'].some(key => options[key] !== undefined)) fail('SCIENCE_MIGRATION_INPUT_INVALID');
    const { prepareScienceHostMigration } = await import('./science-controller.mjs');
    migration = await prepareScienceHostMigration({ ...options, runsPath: inspection.config.paths.runs, host: inspection.config.host });
    options = { ...options, ...migration };
  } else if (options.scientificInput?.science_migration !== undefined) fail('SCIENCE_MIGRATION_INPUT_INVALID');

  const batchRun = runRoot && readBatchRun(runRoot, options.runId, reference?.batch_run_sha256);
  if (!batchRun && !migration) return null;
  const instructionProfile = batchRun
    ? assertBatchRunOptions(batchRun, options, { manifest, configurationFingerprint: inspection.fingerprint })
    : migration.instructionProfile;
  configuredReadingProfile(instructionProfile);
  const context = {};
  if (batchRun?.source_access !== undefined && (batchRun.source_access !== READ_ONLY_SOURCE_ACCESS
    || !Array.isArray(batchRun.source_locations))) fail('READING_BATCH_RUN_RECORD_INVALID');
  verifiedContinuations.set(context, { runId: options.runId, repoRoot: options.repoRoot, instructionProfile, batchRun });
  return { options: { ...options, instructionProfile }, batchRun, context };
}

export function readingSessionSourcePreparation(context) {
  const batch = verifiedContinuations.get(context)?.batchRun;
  if (!batch) return {};
  return batch.source_access === READ_ONLY_SOURCE_ACCESS
    ? { sourceAccess: batch.source_access, frozenLocations: batch.source_locations } : { sourceAccess: null };
}

export function hasReadingSessionContinuation(context, { runId, instructionProfile, repoRoot }) {
  const admitted = verifiedContinuations.get(context);
  return admitted !== undefined && admitted.runId === runId && admitted.instructionProfile === instructionProfile
    && (repoRoot === undefined || repoRoot === admitted.repoRoot);
}
