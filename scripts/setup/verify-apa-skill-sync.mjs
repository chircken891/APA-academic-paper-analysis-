import { createHash } from 'node:crypto';
import { access, lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = resolve(dirname(scriptPath), '../..');

export async function apaSkillInventory(root, { projectReferences = false } = {}) {
  if (await realpath(root) !== root) throw new Error(`Skill root must not resolve through a link: ${root}`);
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Skill deployment contains a link: ${path}`);
      if (entry.isDirectory()) await visit(path);
      if (entry.isFile()) {
        const stats = await lstat(path);
        if (stats.nlink !== 1 || await realpath(path) !== path) throw new Error(`Skill file must be unlinked: ${path}`);
        let bytes = await readFile(path);
        if (projectReferences && /\.md$/i.test(path)) {
          let text = bytes.toString('utf8');
          for (const match of text.matchAll(/\]\(((?:\.\.\/)+[^)]+)\)/g)) {
            const [target, ...fragment] = match[1].split('#');
            const absolute = resolve(dirname(path), target);
            if (!absolute.startsWith(`${root}\\`) && !absolute.startsWith(`${root}/`)) {
              await access(absolute);
              const suffix = fragment.length ? `#${fragment.join('#')}` : '';
              text = text.replace(match[0], `](<${absolute.replaceAll('\\', '/')}${suffix}>)`);
            }
          }
          bytes = Buffer.from(text, 'utf8');
        }
        files.push({ path: relative(root, path).replaceAll('\\', '/'), sha256: createHash('sha256').update(bytes).digest('hex') });
      }
    }
  }
  await visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

export async function verifyApaSkillSync({
  repoRoot = defaultRepoRoot,
  deployedRoot = resolve(process.env.APA_GLOBAL_SKILL ?? join(homedir(), '.agents', 'skills', 'academic-paper-analysis')),
} = {}) {
  const canonicalRoot = join(repoRoot, '.agents', 'skills', 'academic-paper-analysis');
  const [canonical, deployed] = await Promise.all([
    apaSkillInventory(canonicalRoot, { projectReferences: true }),
    apaSkillInventory(deployedRoot),
  ]);
  if (JSON.stringify(canonical) !== JSON.stringify(deployed)) throw new Error('Global APA skill is missing, contains extras, or differs from the repository installation projection.');
  return { ok: true, files: canonical.length, canonicalRoot, deployedRoot, comparison: 'repository-reference-projection' };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  try {
    console.log(JSON.stringify(await verifyApaSkillSync()));
  } catch (cause) {
    console.error(JSON.stringify({ ok: false, error: cause.message }));
    process.exitCode = 1;
  }
}
