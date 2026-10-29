import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { verifyApaSkillSync } from '../../scripts/setup/verify-apa-skill-sync.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const guidePath = path.join(root, 'docs/CONFIGURATION.md');
const skillPath = path.join(root, '.agents/skills/academic-paper-analysis/SKILL.md');
const setupPath = path.join(root, 'SETUP.md');
const installerPath = path.join(root, 'scripts/setup/install-global-integrations.ps1');

test('APA configuration links and documented environment fields resolve to their actual owners', async () => {
  const guide = await readFile(guidePath, 'utf8');
  for (const [, target] of guide.matchAll(/\]\(([^)]+)\)/g)) {
    assert.equal((await stat(path.resolve(path.dirname(guidePath), target.split('#')[0]))).isFile(), true, target);
  }
  const contract = JSON.parse(await readFile(path.join(root, 'config/environment.json'), 'utf8'));
  const table = guide.split('## 环境合同')[1].split('不得只修改')[0];
  const fields = [...table.matchAll(/`([^`]+)`/g)].map(match => match[1]);
  assert.ok(fields.length > 10, 'environment field table must be present');
  for (const field of fields) {
    const value = field.split('.').reduce((object, key) => object?.[key], contract);
    assert.notEqual(value, undefined, `unknown environment field: ${field}`);
  }
  for (const entry of ['README.md', 'SETUP.md', 'Ontology/vault-content-policy.md', 'Views/graph/apa-only.md']) {
    const source = await readFile(path.join(root, entry), 'utf8');
    const targets = [...source.matchAll(/\]\(([^)]+CONFIGURATION\.md)\)/g)]
      .map(match => path.resolve(path.dirname(path.join(root, entry)), match[1]));
    targets.push(...[...source.matchAll(/\[\[([^|\]]+CONFIGURATION)(?:\|[^\]]+)?\]\]/g)]
      .map(match => path.join(root, `${match[1]}.md`)));
    assert.ok(targets.includes(guidePath), entry);
  }
});

test('global repair behavior and documentation distinguish skill and launcher backup locations', async t => {
  const targetRoot = await mkdtemp(path.join(tmpdir(), 'apa-doc-global-repair-'));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));
  const profileRoot = path.join(targetRoot, 'profile');
  const skillRoot = path.join(profileRoot, '.agents', 'skills', 'academic-paper-analysis');
  const binRoot = path.join(profileRoot, 'npm');
  const skillBytes = Buffer.from('documented skill conflict');
  const cmdBytes = Buffer.from('documented cmd conflict');
  const launcherBytes = Buffer.from('documented launcher conflict');
  await mkdir(skillRoot, { recursive: true });
  await mkdir(binRoot, { recursive: true });
  await writeFile(path.join(skillRoot, 'SKILL.md'), skillBytes);
  await writeFile(path.join(binRoot, 'mineru.cmd'), cmdBytes);
  await writeFile(path.join(binRoot, 'mineru-local.ps1'), launcherBytes);

  const repaired = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installerPath,
    '-RepoRoot', root,
    '-GlobalSkillRoot', skillRoot,
    '-GlobalBinRoot', binRoot,
    '-RepairGlobalIntegration',
  ], {
    env: { ...process.env, PATH: `${binRoot};${process.env.PATH ?? ''}` },
    encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  assert.ifError(repaired.error);
  assert.equal(repaired.status, 0, `${repaired.stderr}\n${repaired.stdout}`);
  assert.equal((await verifyApaSkillSync({ repoRoot: root, deployedRoot: skillRoot })).ok, true);

  const skillBackupRelative = '.agents/backups/skills/academic-paper-analysis';
  const skillBackupRoot = path.join(profileRoot, ...skillBackupRelative.split('/'));
  assert.equal(path.relative(profileRoot, skillBackupRoot).replaceAll('\\', '/'), skillBackupRelative);
  const skillBackupTimestamps = await readdir(skillBackupRoot);
  assert.equal(skillBackupTimestamps.length, 1);
  assert.deepEqual(await readFile(path.join(skillBackupRoot, skillBackupTimestamps[0], 'SKILL.md')), skillBytes);
  const scannedSkillEntries = await readdir(path.dirname(skillRoot));
  assert.equal(scannedSkillEntries.filter(name => name.startsWith('academic-paper-analysis.backup-')).length, 0);
  for (const [name, bytes] of [['mineru.cmd', cmdBytes], ['mineru-local.ps1', launcherBytes]]) {
    const backups = (await readdir(binRoot)).filter(entry => entry.startsWith(`${name}.backup-`));
    assert.equal(backups.length, 1);
    assert.deepEqual(await readFile(path.join(binRoot, backups[0])), bytes);
  }

  const [setup, guide] = await Promise.all([setupPath, guidePath].map(file => readFile(file, 'utf8')));
  for (const document of [setup, guide]) {
    assert.ok(document.includes(`${skillBackupRelative}/<UTC timestamp>`));
    assert.ok(document.includes('.backup-<timestamp>'));
  }
});

test('documented V3 publication/query CLI examples reject missing input without mutation', async t => {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), 'apa-doc-contract-'));
  t.after(() => rm(vaultRoot, { recursive: true, force: true }));
  const sources = await Promise.all([guidePath, skillPath].map(file => readFile(file, 'utf8')));
  const commands = new Set(sources.flatMap(source => [...source.matchAll(/^node scripts\/v3\/bilingual\.mjs (.+)$/gm)]
    .map(match => match[1].trim())));
  assert.ok(commands.size > 0, 'current V3 CLI examples must be present');
  for (const command of commands) {
    const concrete = command.replace(/<([^>]+)>/g, (_, name) => {
      if (/hash|sha256/.test(name)) return `sha256:${'a'.repeat(64)}`;
      if (name === 'run' || name === 'run-name') return 'synthetic-run';
      return 'unreported';
    });
    const args = concrete.match(/'[^']*'|"[^"]*"|\S+/g).map(token => token.replace(/^['"]|['"]$/g, ''));
    const index = args.indexOf('--vault-root');
    if (index < 0) args.push('--vault-root', vaultRoot);
    else args[index + 1] = vaultRoot;
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/v3/bilingual.mjs'), ...args], {
      cwd: vaultRoot, encoding: 'utf8', windowsHide: true, timeout: 15000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1, `${command}\n${result.stderr}\n${result.stdout}`);
    assert.deepEqual(await readdir(vaultRoot), [], command);
  }
  const invalid = spawnSync(process.execPath, [path.join(root, 'scripts/v3/bilingual.mjs'), 'review', '--unknown-doc-flag', 'value'], {
    cwd: vaultRoot, encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  assert.equal(invalid.status, 2);
});
