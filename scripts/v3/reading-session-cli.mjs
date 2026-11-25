import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CODE_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const SNAPSHOT_PROFILE = 'reading-runtime-snapshot-1.0';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code, details) => { throw Object.assign(new Error(code), { code, ...(details ? { details } : {}) }); };
const cliPath = 'scripts/v3/reading-session-cli.mjs';

async function verifyBootstrapFiles(manifest, repoRoot) {
  const { fingerprint, ...body } = manifest;
  const snapshotHash = manifest.snapshot_hash;
  if (!/^sha256:[a-f0-9]{64}$/.test(snapshotHash) || manifest.data_root !== resolve(repoRoot)
    || manifest.repo_root !== join(manifest.data_root, '.runtime', 'apa-code', snapshotHash.slice(7))
    || manifest.code_root !== manifest.repo_root || !Array.isArray(manifest.files)
    || snapshotHash !== 'sha256:' + hash(JSON.stringify(manifest.files)) || fingerprint !== 'sha256:' + hash(JSON.stringify(body))) fail('READING_RUNTIME_SNAPSHOT_INVALID');
  for (const relativePath of [cliPath, 'scripts/v3/reading-runtime-snapshot.mjs']) {
    const target = join(manifest.repo_root, relativePath);
    const row = manifest.files.find(item => item?.path === relativePath);
    if (!row || !(await lstat(target)).isFile() || await realpath(target) !== target) fail('READING_RUNTIME_SNAPSHOT_INVALID', { path: target });
    const bytes = await readFile(target);
    if (bytes.length !== row.byte_length || 'sha256:' + hash(bytes) !== row.sha256) fail('READING_RUNTIME_SNAPSHOT_INVALID', { path: target });
  }
}

function addSnapshotDiagnostic(error, codeRoot) {
  if (error.path || error.code === 'READING_RUNTIME_SNAPSHOT_INVALID') {
    error.details ??= { path: error.path ?? codeRoot, reason: error.message };
  }
  throw error;
}

export async function prepareReadingSessionExecution(options = {}) {
  const { repoRoot: selectedRoot, runId, instructionProfile, authorizationId, scientificInput, scienceMigration, sessionContext, maxTotalCalls, maxControlCheckpoints = 16 + 8 * maxTotalCalls, hostProfile } = options;
  if (typeof selectedRoot !== 'string' || !selectedRoot.trim() || !/^[a-zA-Z0-9_-]+$/.test(runId ?? '') || typeof authorizationId !== 'string' || !authorizationId.trim()
    || (!scientificInput && !scienceMigration) || !sessionContext || !Number.isSafeInteger(maxTotalCalls) || !Number.isSafeInteger(maxControlCheckpoints) || maxControlCheckpoints < 4) fail('READING_SESSION_INPUT_INVALID');
  const { DEFAULT_CONFIGURED_INSTRUCTION_PROFILE, configuredReadingProfile } = await import('../lib/reading-profiles.mjs');
  const selected = instructionProfile === undefined ? DEFAULT_CONFIGURED_INSTRUCTION_PROFILE : instructionProfile;
  const { inspectApaConfig } = await import('../lib/apa-config.mjs');
  const { resolveReadingSessionContinuation } = await import('./reading-session-continuation.mjs');
  const { prepareReadingRuntimeSnapshot, readReadingRuntimeSnapshotReference } = await import('./reading-runtime-snapshot.mjs');
  const { readReadingRuntimeTerminal, withReadingRuntimeConsumer } = await import('./reading-runtime-cleanup.mjs');
  const repoRoot = resolve(selectedRoot);
  const existing = readReadingRuntimeSnapshotReference({ repoRoot, runId });
  if (!existing?.batch_run_sha256 && !scienceMigration) configuredReadingProfile(selected, { creating: true });
  const inspection = inspectApaConfig({ repoRoot, hostProfile });
  if (!inspection.exists) fail('APA_LOCAL_CONFIG_REQUIRED');
  if (!inspection.validation.complete) fail('APA_CONFIG_INCOMPLETE');
  const runRoot = resolve(repoRoot, inspection.config.paths.runs, runId);
  if (!existing && !scienceMigration) {
    const { assertReadingSourceOutputPath } = await import('./reading-source-policy.mjs');
    const sources = Array.isArray(scientificInput.sources)
      ? scientificInput.sources.filter(source => typeof source?.path === 'string' && isAbsolute(source.path)) : [];
    assertReadingSourceOutputPath(runRoot, sources, { tree: true, vaultRoot: repoRoot });
  }
  await mkdir(runRoot, { recursive: true });
  return withReadingRuntimeConsumer({ repoRoot, runId, runRoot }, async () => {
    if (await readReadingRuntimeTerminal({ repoRoot, runId, runRoot })) fail('READING_SESSION_TERMINATED');
    const reference = readReadingRuntimeSnapshotReference({ repoRoot, runId });
    if (reference && resolve(reference.run_root) !== runRoot) fail('READING_SESSION_RUNTIME_REFERENCE_CONFLICT');
    const continuation = await resolveReadingSessionContinuation({ options: { ...options, repoRoot }, inspection, runRoot, reference });
    if (!continuation) configuredReadingProfile(selected, { creating: true });
    const manifest = reference?.manifest ?? prepareReadingRuntimeSnapshot({ repoRoot, codeRoot: CODE_ROOT, runRoot, runId, reference: {} });
    return { repoRoot, runId, runRoot, manifest, ...(continuation ? { instructionProfile: continuation.options.instructionProfile } : {}) };
  });
}

/** Resolve the registered code before loading a workflow module from the checkout. */
export async function readReadingSessionExecution(runRoot) {
  if (typeof runRoot !== 'string' || !isAbsolute(runRoot)) fail('READING_SESSION_ROOT_INVALID');
  runRoot = resolve(runRoot);
  const { data } = JSON.parse(await readFile(join(runRoot, 'control', 'science-state.json'), 'utf8'));
  if (!data?.prepared?.paths?.runRoot || resolve(data.prepared.paths.runRoot) !== runRoot) fail('READING_SESSION_STATE_INVALID');
  const { run_id: runId, reading_first_binding: binding } = data.prepared.runControl ?? {};
  const initial = binding?.configured_setup?.runtime_binding;
  if (initial?.profile !== SNAPSHOT_PROFILE) return null;
  const repoRoot = binding.configured_setup.knowledge_registry.vault_root;
  // A closed run can still be recognized after its last snapshot was reclaimed.
  try {
    const terminal = JSON.parse(await readFile(join(runRoot, 'runtime-terminal.json'), 'utf8'));
    if (terminal.profile !== 'reading-runtime-cleanup-1.0' || terminal.run_id !== runId) fail('READING_RUNTIME_TERMINAL_INVALID');
    return { repoRoot, runId, runRoot, terminal };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await verifyBootstrapFiles(initial, repoRoot).catch(error => addSnapshotDiagnostic(error, initial.code_root));
  if (resolve(initial.repo_root) !== CODE_ROOT) {
    const selector = await import(pathToFileURL(join(initial.repo_root, cliPath)).href);
    return selector.readReadingSessionExecution(runRoot).catch(error => addSnapshotDiagnostic(error, initial.code_root));
  }
  const { readReadingRuntimeSnapshotReference, verifyReadingRuntimeSnapshot } = await import('./reading-runtime-snapshot.mjs');
  const verifySnapshot = manifest => {
    try { return verifyReadingRuntimeSnapshot({ manifest, repoRoot, runRoot }); }
    catch (error) { addSnapshotDiagnostic(error, manifest.code_root); }
  };
  verifySnapshot(initial);
  const { readVerifiedReadingSessionRebindHistory } = await import('./reading-session.mjs');
  const reference = readReadingRuntimeSnapshotReference({ repoRoot, runId });
  if (!reference || resolve(reference.run_root) !== runRoot) fail('READING_SESSION_RUNTIME_REFERENCE_CONFLICT');
  const approvals = await readVerifiedReadingSessionRebindHistory({ repoRoot, runRoot, runId, expectedBinding: binding, allowPending: true });
  const expected = approvals.at(-1)?.current ?? initial;
  const manifest = [reference.manifest, reference.pending_manifest].find(item => item?.fingerprint === expected.fingerprint);
  if (!manifest) fail('READING_SESSION_RUNTIME_REFERENCE_CONFLICT');
  if (manifest.fingerprint !== initial.fingerprint) verifySnapshot(manifest);
  return { repoRoot, runId, runRoot, manifest, reference };
}

async function immutableWrite(path, bytes) {
  try { await writeFile(path, bytes, {flag:'wx'}); }
  catch (error) { if (error.code !== 'EEXIST') throw error; if (!(await readFile(path)).equals(bytes)) throw Object.assign(new Error('READING_EXPORT_CONFLICT'),{code:'READING_EXPORT_CONFLICT'}); }
}
export async function exportReadingAction(directory, action) {
  if (typeof action?.action_id !== 'string' || !action.action_id.trim()) throw new Error('READING_EXPORT_ACTION_INVALID');
  await mkdir(directory,{recursive:true});
  const prefix = action.action_id.replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,48) || 'action';
  const path = join(resolve(directory),`${prefix}-${hash(action.action_id).slice(0,16)}.json`);
  await immutableWrite(path,Buffer.from(JSON.stringify(action,null,2)+'\n'));
  return path;
}
async function inputBytes(path) {
  if (path && path !== '-') return readFile(path);
  const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk); return Buffer.concat(chunks);
}
async function run() {
  const [command,...args]=process.argv.slice(2); const options={};
  for (let i=0;i<args.length;i+=2) { if (!args[i]?.startsWith('--') || args[i+1] === undefined) throw new Error('READING_CLI_ARGUMENT_INVALID'); options[args[i].slice(2)]=args[i+1]; }
  // Check before opening a session: a dispatch intent persisted without an export target has no exit.
  if (['create','resume','next'].includes(command) && !options['export-dir']) throw new Error('READING_CLI_EXPORT_DIRECTORY_REQUIRED');
  const inspection=['inspect-candidate','inspect-continuation'].includes(command);
  if (inspection && options['runtime-input']) throw new Error('READING_CLI_READ_ONLY');
  if (!['create','resume','next','event','inspect-candidate','inspect-continuation'].includes(command)) fail('READING_CLI_COMMAND_INVALID');
  const bytes = command === 'create' ? await inputBytes(options.input) : null;
  const input = bytes && JSON.parse(bytes.toString('utf8'));
  const execution = command === 'create'
    ? await prepareReadingSessionExecution(input)
    : await readReadingSessionExecution(options['run-root']);
  if (execution?.terminal) {
    if (command !== 'event' || options['runtime-input'] || options['raw-result'] || options.source) fail('READING_SESSION_TERMINATED');
    const event = JSON.parse((await inputBytes(options.input)).toString('utf8'));
    const result = await retryReadingSessionCleanup(execution, event);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  if (execution) {
    if (process.env.APA_READING_CLI_SNAPSHOT && process.env.APA_READING_CLI_SNAPSHOT !== execution.manifest.fingerprint) fail('READING_SESSION_RUNTIME_RESTART_REQUIRED');
    if (command === 'create') {
      const { verifyReadingRuntimeSnapshot } = await import('./reading-runtime-snapshot.mjs');
      verifyReadingRuntimeSnapshot(execution);
    }
    if (resolve(execution.manifest.repo_root) !== CODE_ROOT) {
      const snapshotInput = execution.instructionProfile !== undefined && input.instructionProfile === undefined
        ? Buffer.from(JSON.stringify({ ...input, instructionProfile: execution.instructionProfile })) : bytes;
      await launchSnapshot({ execution, command, options, bytes: snapshotInput });
      return;
    }
  }
  const execute = () => executeCommand({ command, options, input, execution, inspection });
  const { withReadingRuntimeConsumer } = execution ? await import('./reading-runtime-cleanup.mjs') : {};
  const result = execution ? await withReadingRuntimeConsumer(execution, execute) : await execute();
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}

export async function retryReadingSessionCleanup(execution, event) {
  const { terminal } = execution;
  const status = event.kind === 'terminate' ? 'terminated' : event.kind === 'close-with-limits' ? 'completed_with_limits' : null;
  if (status !== terminal.status || event.authorization_id !== terminal.authorization_id || event.user_reply !== terminal.user_reply) fail('READING_SESSION_TERMINATED');
  const { cleanupReadingRuntimeRun } = await import('./reading-runtime-cleanup.mjs');
  const cleanup = await cleanupReadingRuntimeRun(execution);
  return { terminal, cleanup_pending: false, cleanup };
}

async function launchSnapshot({ execution, command, options, bytes }) {
  const cli = join(execution.manifest.repo_root, cliPath);
  const childOptions = bytes ? { ...options, input: '-' } : options;
  const argv = [cli, command, ...Object.entries(childOptions).flatMap(([name, value]) => [`--${name}`, value])];
  const child = spawn(process.execPath, argv, { stdio: [bytes ? 'pipe' : 'inherit', 'pipe', 'inherit'],
    env: { ...process.env, APA_READING_CLI_SNAPSHOT: execution.manifest.fingerprint } });
  const stdout = [];
  child.stdout.on('data', chunk => stdout.push(chunk));
  if (bytes) {
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') child.kill(); });
    child.stdin.end(bytes);
  }
  const status = await new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => accept(code ?? (signal ? 1 : 0)));
  });
  const output = Buffer.concat(stdout);
  if (status !== 0) { process.exitCode = status; if (output.length) process.stdout.write(output); return; }
  const result = JSON.parse(output.toString('utf8'));
  if (result.cleanup_pending === true) {
    const { cleanupReadingRuntimeRun } = await import('./reading-runtime-cleanup.mjs');
    const cleanup = await cleanupReadingRuntimeRun(execution);
    process.stdout.write(JSON.stringify({ ...result, cleanup_pending: false, cleanup }, null, 2) + '\n');
    return;
  }
  process.stdout.write(output);
}

async function executeCommand({ command, options, input, execution, inspection }) {
  const { readReadingRuntimeTerminal, registerReadingRuntimeCleanupFiles } = execution ? await import('./reading-runtime-cleanup.mjs') : {};
  if (execution && await readReadingRuntimeTerminal(execution)) fail('READING_SESSION_TERMINATED');
  const { assertReadingSessionOutputPath, createReadingSession, resumeReadingSession, nextReadingAction, recordReadingEvent } = await import('./reading-session.mjs');
  const { capturedHostEvidence, normalizeHostReceipt } = await import('./reading-host-evidence.mjs');
  const executionContext = execution && { ...execution, consumerHeld: true };
  let session;
  if (command === 'create') session=await createReadingSession(input, executionContext);
  else session=await resumeReadingSession({runRoot:options['run-root'],readOnly:inspection}, executionContext);
  if (!inspection && options['export-dir']) assertReadingSessionOutputPath(session, options['export-dir']);
  const registerHostFile = path => execution && registerReadingRuntimeCleanupFiles({ ...execution, files: [{ path, kind: 'host' }] });
  if (options['runtime-input']) {
    const runtimeEvent = JSON.parse((await inputBytes(options['runtime-input'])).toString('utf8'));
    if (runtimeEvent.kind !== 'runtime-evidence') throw new Error('READING_CLI_RUNTIME_INPUT_INVALID');
    await recordReadingEvent(session,runtimeEvent);
  }
  let result;
  if (inspection) {
    result=await recordReadingEvent(session,{kind:command,...(options.revision ? {revision:Number(options.revision)} : {})});
  } else if (command === 'event') {
    const event=JSON.parse((await inputBytes(options.input)).toString('utf8'));
    if (options['raw-result'] && options.source) throw new Error('READING_CLI_EVIDENCE_CONFLICT');
    if (options['raw-result']) {
      if (!options['export-dir'] || options['raw-result'] === '-' && (!options.input || options.input === '-')) throw new Error('READING_CLI_EVIDENCE_INPUT_INVALID');
      const bytes=await inputBytes(options['raw-result']), body=bytes.toString('utf8');
      if (!Buffer.from(body,'utf8').equals(bytes)) throw new Error('READING_CLI_UTF8_INVALID');
      assertReadingSessionOutputPath(session, options['export-dir'], bytes);
      await mkdir(options['export-dir'],{recursive:true});
      const path=join(resolve(options['export-dir']),`host-result-${execution ? execution.runId + '-' : ''}${hash(bytes)}.txt`); await immutableWrite(path,bytes);
      await registerHostFile(path);
      event.observation={...event.observation,raw_result_text:body,evidence:{...capturedHostEvidence(body),source_reference:path}};
    }
    if (options.source) {
      const path=resolve(options.source), bytes=await readFile(path);
      event.observation={...event.observation,evidence:{kind:'transcribed',source_reference:path,source_sha256:hash(bytes)}};
    }
    if (event.observation && (options['raw-result'] || options.source)) event.observation=normalizeHostReceipt(event.observation,{strict:true});
    result=await recordReadingEvent(session,event);
  } else {
    result=await nextReadingAction(session);
    if (result.action === 'dispatch') {
      const path=await exportReadingAction(options['export-dir'],result); await registerHostFile(path); result={...result,export_path:path};
    }
  }
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) run().catch(error => {
  const message = error.message ?? error.code;
  const output = error.recovery ? JSON.stringify({ code: error.code ?? error.recovery.code, message, recovery: error.recovery }) : message;
  process.stderr.write(output + '\n');
  process.exitCode = 1;
});
