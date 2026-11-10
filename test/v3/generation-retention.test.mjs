import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneSupersededGenerations } from '../../scripts/v3/generation-retention.mjs';

const fake = 'sha256:' + '0'.repeat(64);

async function vault(generations, { current, previous, journals = [] }) {
  const root = await mkdtemp(join(tmpdir(), 'apa-generation-retention-'));
  const base = join(root, '.apa-v3', 'phase22');
  for (const id of generations) {
    await mkdir(join(base, 'generations', id), { recursive: true });
    await writeFile(join(base, 'generations', id, 'index.json'), '{"generation":"' + id + '"}');
    await writeFile(join(base, 'generations', id, 'manifest.json'), JSON.stringify({ previous_generation: id === current ? previous : null }));
  }
  await writeFile(join(base, 'COMMITTED.json'), JSON.stringify({
    schema_version: 'phase22/active-index-1.0', kind: 'commit', status: 'COMMITTED', generation_id: current, evidence_mode: 'synthetic',
    active: { path: '.apa-v3/phase22/generations/' + current + '/active.json', sha256: fake },
    index: { path: '.apa-v3/phase22/generations/' + current + '/index.json', sha256: fake },
    approval: { review_hash: fake, output_inventory_hash: fake, evidence_mode: 'synthetic' } }));
  for (const [id, journal] of journals) {
    await mkdir(join(base, 'transactions', id), { recursive: true });
    await writeFile(join(base, 'transactions', id, 'journal.json'), JSON.stringify(journal));
  }
  return root;
}

const listed = async root => (await readdir(join(root, '.apa-v3', 'phase22', 'generations'))).sort();

test('keeps the committed and previous generations and records removed files', async () => {
  const root = await vault(['g1', 'g2', 'g3', 'g4'], { current: 'g4', previous: 'g3', journals: [['t4', { state: 'committed' }]] });
  try {
    const result = await pruneSupersededGenerations({ vaultRoot: root, transactionId: 't4', previousGeneration: 'g3' });
    assert.deepEqual(await listed(root), ['g3', 'g4']);
    assert.deepEqual(result.removed.sort(), ['g1', 'g2']);
    const record = JSON.parse(await readFile(join(root, result.record_path), 'utf8'));
    assert.equal(record.removed.length, 2);
    assert.ok(record.removed.every(row => row.files.every(file => file.sha256.startsWith('sha256:'))));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('reads the previous generation from the committed manifest when not given', async () => {
  const root = await vault(['g1', 'g2', 'g3'], { current: 'g3', previous: 'g2' });
  try {
    await pruneSupersededGenerations({ vaultRoot: root });
    assert.deepEqual(await listed(root), ['g2', 'g3']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('keeps generations named by an unfinished transaction', async () => {
  const root = await vault(['g1', 'g2', 'g3', 'g4'], { current: 'g4', previous: 'g3',
    journals: [['open', { state: 'staged', generation: 'g2', previous_generation: 'g1' }]] });
  try {
    const result = await pruneSupersededGenerations({ vaultRoot: root, previousGeneration: 'g3' });
    assert.deepEqual(await listed(root), ['g1', 'g2', 'g3', 'g4']);
    assert.deepEqual(result.removed, []);
    assert.equal(result.record_path, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('leaves directories with nested entries in place', async () => {
  const root = await vault(['g1', 'g2', 'g3'], { current: 'g3', previous: 'g2' });
  try {
    await mkdir(join(root, '.apa-v3', 'phase22', 'generations', 'g1', 'nested'));
    const result = await pruneSupersededGenerations({ vaultRoot: root, previousGeneration: 'g2' });
    assert.deepEqual(await listed(root), ['g1', 'g2', 'g3']);
    assert.equal(result.skipped[0].reason, 'non_regular_entry');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('keeps the small files merge compensation reads', async () => {
  const root = await vault(['g1', 'g2', 'g3', 'g4'], { current: 'g4', previous: 'g3' });
  try {
    const dir = join(root, '.apa-v3', 'phase22', 'generations');
    await writeFile(join(dir, 'g2', 'manifest.json'), JSON.stringify({ profile: 'phase22-knowledge-merge-1.0', maintenance: { operation: 'merge' }, previous_generation: 'g1' }));
    for (const id of ['g1', 'g2']) await writeFile(join(dir, id, 'active.json'), '{}');
    const result = await pruneSupersededGenerations({ vaultRoot: root, previousGeneration: 'g3' });
    assert.deepEqual((await readdir(join(dir, 'g2'))).sort(), ['active.json', 'manifest.json']);
    assert.deepEqual(await readdir(join(dir, 'g1')), ['active.json']);
    assert.ok(result.removed.includes('g1') && result.removed.includes('g2'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
