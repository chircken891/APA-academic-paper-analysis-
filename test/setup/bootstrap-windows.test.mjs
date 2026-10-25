import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('bootstrap follows the approved six-step order and exposes collision repair', async () => {
  const script = await readFile('scripts/setup/bootstrap-windows.ps1', 'utf8');
  const ordered = [
    'Assert-Prerequisites',
    'npm ci',
    'setup-mineru.ps1',
    'install-global-integrations.ps1',
    'setup:check',
  ].map(token => script.indexOf(token));

  assert(ordered.every(index => index >= 0));
  assert.deepEqual([...ordered].sort((left, right) => left - right), ordered);
  assert.match(script, /\[switch\]\$RepairGlobalIntegration/);
  assert.match(script, /-RepairGlobalIntegration:\$RepairGlobalIntegration/);
});

test('bootstrap resolves paths from its location and preserves interrupted runtime state', async () => {
  const script = await readFile('scripts/setup/bootstrap-windows.ps1', 'utf8');

  assert.match(script, /Join-Path \$PSScriptRoot '\.\.\\\.\.'/);
  assert.doesNotMatch(script, /D:\\文献知识库|D-drive/i);
  assert.doesNotMatch(script, /Remove-Item[^\r\n]*\.runtime/i);
  assert.doesNotMatch(script, /Start-Process[^\r\n]*-Verb\s+RunAs/i);
});

test('bootstrap reads all supported versions and disk policy from the central contract', async () => {
  const script = await readFile('scripts/setup/bootstrap-windows.ps1', 'utf8');

  for (const expression of [
    '$environment.node.major',
    '$environment.npm.major',
    '$environment.python.major',
    '$environment.python.minor',
    '$environment.disk.recommended_free_gib',
    '$environment.mineru.model_source',
  ]) assert.match(script, new RegExp(expression.replaceAll('.', '\\.').replace('$', '\\$')));
});
