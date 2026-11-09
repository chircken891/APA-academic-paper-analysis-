import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const id = 'better-embedded-canvas';
const releases = 'https://api.github.com/repos/kotaindah55/better-embedded-canvas/releases';
const names = ['main.js', 'manifest.json', 'styles.css'];
const versionPattern = /^\d+\.\d+\.\d+(?:[.-][\w.-]+)?$/;

async function entry(file, directory) {
  try {
    const state = await lstat(file);
    if (directory ? !state.isDirectory() : !state.isFile()) throw new Error(`Unexpected Obsidian path type: ${file}`);
    return true;
  } catch (cause) {
    if (cause.code === 'ENOENT') return false;
    throw cause;
  }
}

async function inspect(repoRoot) {
  const obsidian = join(resolve(repoRoot), '.obsidian');
  const plugins = join(obsidian, 'plugins');
  const pluginPath = join(plugins, id);
  const enablePath = join(obsidian, 'community-plugins.json');
  for (const directory of [obsidian, plugins, pluginPath]) await entry(directory, true);
  const enabledPlugins = await entry(enablePath, false)
    ? JSON.parse((await readFile(enablePath, 'utf8')).replace(/^\uFEFF/, ''))
    : [];
  if (!Array.isArray(enabledPlugins) || enabledPlugins.some(value => typeof value !== 'string')) throw new Error(`Expected an array of plugin IDs in ${enablePath}`);
  const files = await Promise.all(names.map(name => entry(join(pluginPath, name), false)));
  let version = null;
  if (files.every(Boolean)) {
    const manifest = JSON.parse(await readFile(join(pluginPath, 'manifest.json'), 'utf8'));
    if (manifest.id !== id || !versionPattern.test(manifest.version)) throw new Error(`Invalid Better Embedded Canvas manifest in ${pluginPath}`);
    version = manifest.version;
  }
  return { pluginPath, enablePath, version, enabledPlugins };
}

export async function inspectBetterEmbeddedCanvas({ repoRoot }) {
  const { pluginPath, enablePath, version, enabledPlugins } = await inspect(repoRoot);
  const enabled = enabledPlugins.includes(id);
  return { path: pluginPath, enable_path: enablePath, version, enabled,
    status: !version ? 'missing' : enabled ? 'installed-and-enabled' : 'installed-not-enabled' };
}

async function request(fetchImpl, url, accept, label) {
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: accept, 'User-Agent': 'APA-setup' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  } catch (cause) {
    throw new Error(`Better Embedded Canvas GitHub API ${label}: ${cause.message}`, { cause });
  }
}

export async function installBetterEmbeddedCanvas({ repoRoot, selected = true, fetchImpl = fetch }) {
  if (!selected) return { status: 'skipped' };
  const { pluginPath, enablePath, version, enabledPlugins } = await inspect(repoRoot);
  const response = await request(fetchImpl, `${releases}/latest`, 'application/vnd.github+json', 'release');
  const release = await response.json();
  const releaseVersion = release.tag_name?.replace(/^v/, '');
  if (!versionPattern.test(releaseVersion)) throw new Error('Better Embedded Canvas GitHub API release has no valid version tag');

  const alreadyInstalled = version === releaseVersion;
  if (!alreadyInstalled) {
    const assets = await Promise.all(names.map(async name => {
      const asset = release.assets?.find(item => item.name === name);
      if (!Number.isSafeInteger(asset?.id) || asset.id <= 0 || !/^sha256:[a-f\d]{64}$/i.test(asset.digest)) {
        throw new Error(`Better Embedded Canvas GitHub API missing asset or SHA-256 digest for ${name}`);
      }
      const response = await request(fetchImpl, `${releases}/assets/${asset.id}`, 'application/octet-stream', `asset ${name}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== asset.digest.toLowerCase()) {
        throw new Error(`Better Embedded Canvas SHA-256 mismatch for ${name}`);
      }
      return [name, bytes];
    }));
    const manifest = JSON.parse(new Map(assets).get('manifest.json').toString('utf8'));
    if (manifest.id !== id || manifest.version !== releaseVersion) throw new Error('Better Embedded Canvas manifest does not match the selected GitHub release');
    await mkdir(pluginPath, { recursive: true });
    for (const [name, bytes] of assets) await writeFile(join(pluginPath, name), bytes);
  }
  if (!enabledPlugins.includes(id)) {
    await writeFile(enablePath, `${JSON.stringify([...enabledPlugins, id], null, 2)}\n`);
  }
  return { status: alreadyInstalled ? 'already-installed' : 'installed', path: pluginPath, version: releaseVersion, enabled: true };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [mode, repoRoot, ...rest] = process.argv.slice(2);
    if (!repoRoot || rest.length || !['--check', '--install'].includes(mode)) throw new Error('Usage: install-better-embedded-canvas.mjs --check|--install <repo-root>');
    const result = mode === '--check'
      ? await inspectBetterEmbeddedCanvas({ repoRoot })
      : await installBetterEmbeddedCanvas({ repoRoot });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (cause) {
    process.stderr.write(`${cause.message}\n`);
    process.exitCode = 1;
  }
}
