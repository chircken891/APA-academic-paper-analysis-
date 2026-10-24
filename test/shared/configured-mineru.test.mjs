import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMineru } from '../../scripts/lib/mineru-runner.mjs';
import { checkMineruRuntime } from '../../scripts/lib/mineru-runtime.mjs';
import { createConfiguredMineruPort, configuredMineruConfiguration } from '../../scripts/v3/configured-reading.mjs';
import { fingerprintReadingFirst } from '../../scripts/v3/reading-first-runtime.mjs';
import { createHash } from 'node:crypto';

test('configured MinerU uses the explicit Python and config in its actual subprocess without changing process environment', async t => {
  const root = await mkdtemp(join(tmpdir(), 'apa-configured-mineru-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeHome = join(root, 'selected-runtime');
  await mkdir(runtimeHome);
  const sourcePath = join(root, 'source.pdf');
  await writeFile(sourcePath, 'synthetic pdf');
  const before = { ...process.env };
  let invoked;
  await runMineru({ vaultRoot: root, runtimeHome, python: 'chosen-python', configPath: join(root, 'selected.yaml'), sourcePath,
    outputPath: join(root, 'parsed'), readVersion: async ({ python }) => { assert.equal(python, 'chosen-python'); return '4.0.12'; },
    runChild: async (executable, args, options) => { invoked = { executable, args, options }; } });
  assert.equal(invoked.executable, 'chosen-python');
  assert.equal(invoked.options.env.MINERU_CONFIG, join(root, 'selected.yaml'));
  assert.deepEqual(invoked.args.slice(-4), ['--tier', 'standard', '--pages', 'all']);
  assert.deepEqual({ ...process.env }, before);
});

test('configured parser packet binds output root and forwards the same runtime selection through check and parse', async t => {
  const root = await mkdtemp(join(tmpdir(), 'apa-configured-parser-port-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, 'source.pdf'), bytes = Buffer.from('synthetic parser input');
  await writeFile(sourcePath, bytes);
  const prepared = { paths: { parseRoot: join(root, 'selected-output') }, parserOptions: { runtimeHome: join(root, 'runtime'), python: join(root, 'python.exe'), configPath: join(root, 'config.yaml') } };
  const configuration = configuredMineruConfiguration(prepared), received = [];
  const port = createConfiguredMineruPort({ prepared, repoRoot: root, dependencies: {
    checkMineruRuntime: async options => { received.push(options); return { ok: true, version: '4.0.12', configVersion: 'observed-config' }; },
    runMineru: async options => { received.push(options); await mkdir(options.outputPath); await writeFile(join(options.outputPath, 'parsed.json'), '{}'); return '4.0.12'; },
  } });
  const packet = { run_id: 'configured-run', user_approval_id: 'synthetic-only', intended_evidence_tier: 'local_dispatch',
    source: { path: sourcePath, sha256: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), byte_length: bytes.length },
    instruction_fingerprint: 'sha256:' + 'a'.repeat(64), configuration_fingerprint: fingerprintReadingFirst(configuration), allowed_output_root: prepared.paths.parseRoot,
    backend: { identity: 'current-mineru', version: '4.0.12', runtime_configuration_version: 'observed-config', configuration },
    endpoint: { value: null, egress: 'denied', retention: 'local_only' }, host_action_scope: { action: 'run_current_mineru', permitted_result_fields: ['parser_version','output_inventory'] },
    expected_resource_fields: ['elapsed_ms'], requested_model: 'gpt-6.1-sol', observed_model: 'unknown', estimate: { value: 1, unit: 'runs' }, approved_budget_cap: { value: 1, unit: 'runs' }, retry_allowance: 0 };
  assert.equal((await port.run(packet)).parser_version, '4.0.12');
  for (const options of received) for (const [key, value] of Object.entries(prepared.parserOptions)) assert.equal(options[key], value);
  assert.throws(() => port.run({ ...packet, allowed_output_root: join(root, 'different-output') }), /BINDING_MISMATCH/);
  const changed = { ...configuration, runtime_selection: { ...prepared.parserOptions, python: join(root, 'other.exe') } };
  assert.throws(() => port.run({ ...packet, backend: { ...packet.backend, configuration: changed }, configuration_fingerprint: fingerprintReadingFirst(changed) }), /BINDING_MISMATCH/);
});

test('runtime availability probe receives the selected config explicitly at the effective Python command', async t => {
  const root = await mkdtemp(join(tmpdir(), 'apa-configured-runtime-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'); await mkdir(bin);
  const python = join(bin, process.platform === 'win32' ? 'python.exe' : 'python');
  for (const filename of [python, join(bin, process.platform === 'win32' ? 'mineru.exe' : 'mineru'), join(bin, process.platform === 'win32' ? 'mineru-kit.exe' : 'mineru-kit')]) await writeFile(filename, 'fixture');
  const runtimeHome = join(root, 'runtime'), configPath = join(root, 'chosen.yaml');
  const before = { ...process.env }, calls = [];
  const result = await checkMineruRuntime({ vaultRoot: root, python, runtimeHome, configPath, execute: async (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === 'version') return { stdout: JSON.stringify({ mineru_version: '4.0.12' }) };
    if (args[0] === 'models' || args.includes('check')) return { stdout: 'ok' };
    if (args[1].includes('importlib.metadata')) return { stdout: '4.0.12' };
    return { stdout: JSON.stringify({ exists: true, config_path: configPath, model: { source: 'local', base_dir: join(root, 'models'), small_backend: 'onnx', vlm: { engine: 'llama-cpp' } } }) };
  } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.configVersion, /^sha256:/);
  const probe = calls.find(call => call.args[1]?.includes('get_config_file_path'));
  assert.equal(probe.command, python);
  assert.equal(probe.options.env.MINERU_CONFIG, configPath);
  assert.equal(probe.options.env.MINERU_HOME, runtimeHome);
  assert.deepEqual({ ...process.env }, before);
});
