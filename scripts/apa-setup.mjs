import fs from 'node:fs';
import path from 'node:path';
import { loadApaConfig, inspectApaConfig, applyApaConfigOperation, exportApaConfig, loadHostProfile } from './lib/apa-config.mjs';

function options(argv) {
  const [command, ...rest] = argv;
  if (!['inspect', 'page', 'apply', 'export'].includes(command)) throw new Error('Usage: apa-setup inspect|page|apply|export [--repo-root path] [--file path] [--output path] [--host-profile path]');
  const result = { command, repoRoot: process.cwd() };
  for (let index = 0; index < rest.length; index += 2) {
    const key = { '--repo-root': 'repoRoot', '--file': 'file', '--output': 'output', '--capability': 'capability', '--host-profile': 'hostProfile' }[rest[index]];
    if (!key || !rest[index + 1] || rest[index + 1].startsWith('--') || result[key] && key !== 'repoRoot') throw new Error('APA_SETUP_ARGUMENT_INVALID');
    result[key] = rest[index + 1];
  }
  if (result.file && command !== 'apply' || result.output && !['page', 'export'].includes(command)) throw new Error('APA_SETUP_ARGUMENT_INVALID');
  if (result.hostProfile && !['inspect', 'page'].includes(command)) throw new Error('APA_SETUP_ARGUMENT_INVALID');
  if (result.capability && (command !== 'inspect' || !['query', 'reading'].includes(result.capability))) throw new Error('APA_SETUP_ARGUMENT_INVALID');
  result.repoRoot = path.resolve(result.repoRoot);
  return result;
}

try {
  const args = options(process.argv.slice(2));
  let result;
  const hostProfile = args.hostProfile ? loadHostProfile(path.resolve(args.hostProfile)) : undefined;
  if (args.command === 'inspect') result = inspectApaConfig({ ...args, hostProfile });
  if (args.command === 'apply') {
    const raw = fs.readFileSync(args.file ? path.resolve(args.file) : 0, 'utf8');
    const operation = JSON.parse(raw);
    result = applyApaConfigOperation({ repoRoot: args.repoRoot, operation });
  }
  if (args.command === 'export') {
    result = exportApaConfig(loadApaConfig(args).config);
    if (args.output) {
      const output = path.resolve(args.output);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
      result = { output };
    }
  }
  if (args.command === 'page') {
    const taskRoot = path.resolve(args.repoRoot, '.tmp/apa-setup');
    const output = args.output ? path.resolve(args.output) : path.join(taskRoot, 'index.html');
    const relative = path.relative(taskRoot, output);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('APA_SETUP_OUTPUT_OUTSIDE_TASK');
    const snapshot = loadApaConfig(args);
    const inspection = inspectApaConfig({ ...args, hostProfile });
    const { renderApaSetupPage } = await import('./setup/apa-setup-page.mjs');
    const queryInspection = inspectApaConfig({ repoRoot: args.repoRoot, capability: 'query' });
    const html = renderApaSetupPage({ snapshot, inspection, queryInspection, hostProfile, repoRoot: args.repoRoot });
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, html);
    result = { output, fingerprint: snapshot.fingerprint };
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (cause) {
  process.stderr.write(`${cause.message}\n`);
  process.exitCode = 1;
}
