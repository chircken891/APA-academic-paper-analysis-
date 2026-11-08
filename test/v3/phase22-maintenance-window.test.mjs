import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { applyBilingualPublication, registerBilingualPublication } from '../../scripts/v3/phase22-publication.mjs';
import { applyReadingFirstFixture, readingFirstPublicationFixture } from './helpers/reading-first-publication-fixtures.mjs';

test('a maintenance window exactly 60 minutes long can register and apply', async t => {
  const fixture = await readingFirstPublicationFixture(t, { windowDurationMs: 60 * 60_000 });
  const result = await applyBilingualPublication(applyReadingFirstFixture(fixture));
  assert.equal(result.status, 'committed');
});

test('a legacy two-step publication can still use a 30-minute maintenance window', async t => {
  const fixture = await readingFirstPublicationFixture(t, { windowDurationMs: 30 * 60_000 });
  const result = await applyBilingualPublication(applyReadingFirstFixture(fixture));
  assert.equal(result.status, 'committed');
});

test('a window longer than 60 minutes rejects registration and apply before any vault writes', async t => {
  const fixture = await readingFirstPublicationFixture(t, { register: false, windowDurationMs: 60 * 60_000 + 1 });
  const args = applyReadingFirstFixture(fixture);
  const before = await readdir(fixture.vaultRoot);
  const isInvalidWindow = error => error.code === 'P22_MAINTENANCE_WINDOW_REQUIRED';
  await assert.rejects(registerBilingualPublication({ ...args, sourceInputs: fixture.sourceInputs }), isInvalidWindow);
  await assert.rejects(applyBilingualPublication(args), isInvalidWindow);
  assert.deepEqual(await readdir(fixture.vaultRoot), before);
});
