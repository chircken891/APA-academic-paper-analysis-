import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, mkdir, readFile, readdir, rename, writeFile, rm } from 'node:fs/promises';
import { tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { runMineru } from '../../scripts/lib/mineru-runner.mjs';
import { checkMineruRuntime } from '../../scripts/lib/mineru-runtime.mjs';
import { createConfiguredMineruPort, configuredMineruConfiguration } from '../../scripts/v3/configured-reading.mjs';
import { fingerprintReadingFirst } from '../../scripts/v3/reading-first-runtime.mjs';
import { createHash } from 'node:crypto';
import { validateApaConfig } from '../../scripts/lib/apa-config.mjs';
import { fields, fieldValue } from '../../Templates/apa-setup/page.js';

async function isolatedVault(t) {
  const vaultRoot = await mkdtemp(join(tmpdir(), 'mineru-runner-'));
  t.after(() => rm(vaultRoot, { recursive: true, force: true }));
  await mkdir(join(vaultRoot, 'Clippings'), { recursive: true });
  const sourcePath = join(vaultRoot, 'Clippings', 'new.pdf');
  await writeFile(sourcePath, '%PDF-1.7\nsynthetic paper\n', 'utf8');
  return { vaultRoot, sourcePath };
}

const workerScript = `
  import { spawn } from 'node:child_process';
  import { once } from 'node:events';
  import { join } from 'node:path';
  import { runMineru } from ${JSON.stringify(new URL('../../scripts/lib/mineru-runner.mjs', import.meta.url).href)};
  const [vaultRoot, sourcePath, id] = process.argv.slice(1);
  await runMineru({ vaultRoot, sourcePath, outputPath: join(vaultRoot, id), python: process.execPath,
    readVersion: async () => { process.send({ type: 'ready' }); return '4.0.12'; },
    runChild: async (command, args, options) => {
      const child = spawn(command, ['-e', "const fs = require('node:fs'); const timer = setInterval(() => { if (fs.existsSync(process.argv[1])) clearInterval(timer); }, 25); setTimeout(() => process.exit(1), 15000).unref();", join(vaultRoot, id + '-release')], { detached: true, windowsHide: true, stdio: 'ignore' });
      options.onSpawn?.(child);
      process.send({ type: 'started', pid: child.pid });
      const [code] = await once(child, 'exit');
      if (code !== 0) throw new Error('synthetic parser did not complete');
    },
  });
`;

async function startWorkers(t) {
  const workers = [];
  t.after(async () => {
    await Promise.all(workers.map(worker => worker.release()));
    await Promise.all(workers.map(worker => worker.exit));
  });
  const { vaultRoot, sourcePath } = await isolatedVault(t);
  const workerTemp = join(vaultRoot, 'temp');
  await mkdir(workerTemp);
  await mkdir(join(vaultRoot, '.runtime', 'mineru'), { recursive: true });
  await mkdir(join(vaultRoot, 'config'));
  const setLimit = async limit => {
    const target = join(vaultRoot, 'config', 'apa.local.json');
    const pending = target + '.tmp';
    await writeFile(pending, JSON.stringify({ schema_version: 'apa-local-config-1.0', parser: { max_concurrent: limit } }));
    await rename(pending, target);
  };
  await setLimit(1);
  const start = id => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', workerScript, vaultRoot, sourcePath, id], {
      env: { ...process.env, TMP: workerTemp, TEMP: workerTemp, TMPDIR: workerTemp },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
    });
    const messages = [];
    let stderr = '';
    child.on('message', message => messages.push(message));
    child.stderr.on('data', chunk => { stderr += chunk; });
    const worker = {
      child, exit: once(child, 'exit'),
      release: () => writeFile(join(vaultRoot, id + '-release'), ''),
      seen: type => messages.find(message => message.type === type),
      async expect(type) {
        for (let i = 0; i < 200; i++) {
          const message = this.seen(type);
          if (message) return message;
          if (child.exitCode !== null || child.signalCode !== null) break;
          await delay(25);
        }
        assert.fail(`${id} did not emit ${type}: ${stderr}`);
      },
    };
    workers.push(worker);
    return worker;
  };
  return { start, vaultRoot, setLimit };
}

test('MinerU starts one parser at a time across independent runner processes', async t => {
  const { start, vaultRoot } = await startWorkers(t);
  const first = start('first');
  await first.expect('started');
  const slot = join(vaultRoot, '.runtime', 'mineru-slots', 'slot-1');
  const runner = (await readdir(slot)).find(name => name.endsWith('-runner.json'));
  assert.deepEqual(JSON.parse(await readFile(join(slot, runner), 'utf8')), {
    pid: first.child.pid, max_concurrent: 1, limit_source: 'configuration',
  });
  const second = start('second');
  await second.expect('ready');
  await delay(600);
  assert.equal(second.seen('started'), undefined, 'second parser started while the first held the only slot');
  await first.release();
  assert.deepEqual(await first.exit, [0, null]);
  await second.expect('started');
  await second.release();
  assert.deepEqual(await second.exit, [0, null]);
});

test('MinerU reclaims the slot of a terminated runner after its parser exits', async t => {
  const { start } = await startWorkers(t);
  const first = start('first');
  const { pid } = await first.expect('started');
  assert.ok(first.child.kill('SIGKILL'));
  assert.deepEqual(await first.exit, [null, 'SIGKILL']);
  assert.doesNotThrow(() => process.kill(pid, 0));
  const second = start('second');
  await second.expect('ready');
  await delay(600);
  assert.equal(second.seen('started'), undefined, 'second parser overlapped the terminated runner’s surviving parser');
  await first.release();
  await second.expect('started');
  await second.release();
  assert.deepEqual(await second.exit, [0, null]);
});

test('reducing the MinerU limit applies to waiting runners while higher slots are still occupied', async t => {
  const { start, setLimit } = await startWorkers(t);
  await setLimit(2);
  const first = start('first');
  await first.expect('started');
  const second = start('second');
  await second.expect('started');
  const third = start('third');
  await third.expect('ready');
  await delay(400);
  assert.equal(third.seen('started'), undefined);
  await setLimit(1);
  await first.release();
  assert.deepEqual(await first.exit, [0, null]);
  await delay(600);
  assert.equal(third.seen('started'), undefined, 'a queued runner used the lower slot while the higher slot was still active');
  await second.release();
  assert.deepEqual(await second.exit, [0, null]);
  await third.expect('started');
  await third.release();
  assert.deepEqual(await third.exit, [0, null]);
});

test('records the memory-derived limit and releases a failed parse without changing its error', async t => {
  const { vaultRoot, sourcePath } = await isolatedVault(t);
  await mkdir(join(vaultRoot, '.runtime', 'mineru'), { recursive: true });
  const slotRoot = join(vaultRoot, '.runtime', 'mineru-slots');
  const failure = new Error('synthetic parser memory exhaustion');
  await assert.rejects(runMineru({ vaultRoot, sourcePath, outputPath: join(vaultRoot, 'output'),
    python: process.execPath,
    readVersion: async () => '4.0.12',
    runChild: async () => {
      const slot = join(slotRoot, 'slot-1');
      const [owner] = await readdir(slot);
      const memoryGiB = totalmem() / (2 ** 30);
      assert.deepEqual(JSON.parse(await readFile(join(slot, owner), 'utf8')), {
        pid: process.pid, max_concurrent: Math.max(1, Math.floor((memoryGiB - 8) / 12)), limit_source: 'memory',
      });
      throw failure;
    },
  }), error => error === failure);
  assert.deepEqual(await readdir(slotRoot), []);
});

test('the setup page and local configuration accept only positive integer MinerU limits', () => {
  const field = fields.find(entry => entry.key === 'parser.max_concurrent');
  assert.equal(fieldValue(field, { value: '2' }), 2);
  for (const value of ['0', '-1', '1.5', '1e2', '9007199254740992']) {
    assert.throws(() => fieldValue(field, { value }), /正整数/u);
  }
  const validate = max_concurrent => validateApaConfig({ schema_version: 'apa-local-config-1.0', parser: { max_concurrent } }).valid;
  assert.equal(validate(2), true);
  for (const value of [0, -1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1]) assert.equal(validate(value), false);
});

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
