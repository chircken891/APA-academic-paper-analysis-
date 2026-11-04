import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseQueryArguments } from '../../scripts/apa-query.mjs';
import { readingFirstIndexFixture } from './helpers/reading-first-index-fixtures.mjs';

const cli = fileURLToPath(new URL('../../scripts/apa-query.mjs', import.meta.url));
test('writing query CLI exposes explicit filters, budgets and Canvas without boolean values', () => {
  const args = parseQueryArguments(['search', '--query', 'tumour', '--limit', '4', '--hits-per-paper', '2', '--snippet-chars', '80', '--full', '--module', '4,7', '--entity-type', 'paper', '--year-from', '2020', '--paper-id', 'p1,p2']);
  assert.equal(args.full, true);
  assert.equal(args.limit, 4);
  assert.deepEqual(args.filters, { entityTypes: ['paper'], modules: [4, 7], paperIds: ['p1', 'p2'], yearFrom: 2020 });
  assert.equal(parseQueryArguments(['landscape', '--canvas']).canvas, true);
  assert.equal(parseQueryArguments(['draft', '--section', 'related-work', '--input', '-']).section, 'related-work');
  assert.throws(() => parseQueryArguments(['search', '--query', 'x', '--limit', '0']), { code: 'P23_QUERY_ARGUMENT_INVALID' });
  assert.throws(() => parseQueryArguments(['dossier']), { code: 'P23_QUERY_ARGUMENT_INVALID' });
});
test('inventory, landscape, dossier and question clues dispatch through CLI', async t => {
  const fixture = await readingFirstIndexFixture(t);
  await fixture.save(await fixture.build());
  for (const args of [['inventory'], ['landscape', '--canvas'], ['dossier', '--node', 'SyntheticRateAlias'], ['clues', '--from', 'finalresultneedle']]) {
    const result = JSON.parse(execFileSync(process.execPath, [cli, ...args, '--vault-root', fixture.vaultRoot], { encoding: 'utf8' }));
    assert.equal(result.ok, true);
    assert.equal(result.generation_id, fixture.generation.generation_id);
    assert.match(result.content_hash, /^sha256:/);
  }
});
test('novelty CLI prepares without network authorization or model execution', () => {
  const input = { intent: 'check-external-novelty', idea: { id: 'one', statement: 'Synthetic idea' }, sources: ['pubmed'], budget: { max_calls: 15, search_rounds: 3 },
    claims: ['a', 'b', 'c'].map(id => ({ id, text: 'Synthetic ' + id, queries: ['first ' + id, 'second ' + id, 'third ' + id] })) };
  const result = JSON.parse(execFileSync(process.execPath, [cli, 'novelty', '--input', '-'], { input: JSON.stringify(input), encoding: 'utf8' }));
  assert.equal(result.status, 'prepared');
  assert.equal(result.queries.length, 9);
  assert.equal(result.calls, undefined);
});

test('A2 validate-result CLI rejects modified materials like the core function', async t => {
  const fixture = await readingFirstIndexFixture(t);
  await fixture.save(await fixture.build());
  const input = { generationId: fixture.generation.generation_id, mode: 'draft', output: {}, materials: { content_hash: 'changed', project: { evidence_records: [{ strength: 'strong' }] } } };
  try {
    execFileSync(process.execPath, [cli, 'validate-result', '--input', '-', '--vault-root', fixture.vaultRoot], { input: JSON.stringify(input), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    assert.fail('modified materials accepted');
  } catch (error) {
    assert.match(String(error.stdout) + String(error.stderr), /WQ_MATERIALS_CHANGED/);
  }
});
