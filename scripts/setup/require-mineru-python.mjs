import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkMineruRuntime } from '../lib/mineru-runtime.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const result = await checkMineruRuntime({ vaultRoot: repoRoot });

if (!result.ok) {
  console.error(`MINERU_PYTHON must name an executable local Python interpreter with MinerU installed for required parser tests: ${result.python}`);
  process.exitCode = 1;
}
