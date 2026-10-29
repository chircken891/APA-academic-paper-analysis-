import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as policies from '../../scripts/apa-model-policy.mjs';

test('configured role models validate and resolve without changing historical policy semantics', () => {
  const main = { model: 'gpt-6-astra', reasoning_effort: 'high' };
  const roles = Object.fromEntries(['evidence','methods','results','interpretation','scientific-reading','integration','english-writer','chinese-writer','translation','reading-editor','independent-verifier'].map(role => [role, { model: 'gpt-6.1-sol', reasoning_effort: 'low' }]));
  const policy = policies.createConfiguredApaRoleModelPolicy(main, roles);
  assert.equal(policies.validateApaRoleModelPolicy(policy), true);
  assert.deepEqual(policies.resolveApaRoleModel('english-writer', main, policy), roles['english-writer']);
  assert.deepEqual(policies.resolveApaRoleModel('evidence', main, policy), roles.evidence);
  assert.deepEqual(policies.resolveApaRoleModel('english-writer', main), main);
  assert.deepEqual(policies.resolveApaRoleModel('evidence', main), { model: 'gpt-6.1-sol', reasoning_effort: 'medium' });
  assert.equal(policies.validateApaRoleModelPolicy({ ...policy, roles: {} }), false);
});

test('configured policy accepts host model IDs while historical main-session policy remains GPT-only', () => {
  const main = { model: 'synthetic-provider/main-model', reasoning_effort: 'high' };
  const roles = Object.fromEntries(policies.APA_CONFIGURED_ROLES.map(role => [role, { model: 'synthetic-provider/science-model', reasoning_effort: 'low' }]));
  roles['english-writer'] = { ...main };
  const policy = policies.createConfiguredApaRoleModelPolicy(main, roles);
  assert.deepEqual(policies.resolveApaRoleModel('english-writer', main, policy), main);
  assert.deepEqual(policies.resolveApaRoleModel('evidence', main, policy), { model: 'synthetic-provider/science-model', reasoning_effort: 'low' });
  assert.throws(() => policies.createApaRoleModelPolicy(main), /APA_MAIN_SESSION_INVALID/);
  assert.throws(() => policies.resolveApaRoleModel('english-writer', main), /APA_MAIN_SESSION_INVALID/);
  assert.equal(policies.validateApaRoleModelPolicy({ version: policies.APA_ROLE_MODEL_POLICY_VERSION, main_session: main }), false);
});

test('configured policy rejects malformed model pairs and policy structures', () => {
  const main = { model: 'gpt-6-astra', reasoning_effort: 'high' };
  const roles = Object.fromEntries(policies.APA_CONFIGURED_ROLES.map(role => [role, { model: 'synthetic-provider/science-model', reasoning_effort: 'low' }]));
  const valid = { version: policies.APA_CONFIGURED_MODEL_POLICY_VERSION, main_session: main, roles };
  const malformedPairs = [null, { model: '', reasoning_effort: 'high' }, { model: '   ', reasoning_effort: 'high' },
    { model: 42, reasoning_effort: 'high' }, { model: 'model', reasoning_effort: 'invalid' },
    { model: 'model', reasoning_effort: 'high', extra: true }, Object.assign([], main)];
  for (const pair of malformedPairs) {
    assert.equal(policies.validateApaRoleModelPolicy({ ...valid, main_session: pair }), false);
    assert.equal(policies.validateApaRoleModelPolicy({ ...valid, roles: { ...roles, evidence: pair } }), false);
  }
  assert.equal(policies.validateApaRoleModelPolicy({ ...valid, extra: true }), false);
  assert.equal(policies.validateApaRoleModelPolicy({ ...valid, roles: { ...roles, extra: main } }), false);
  assert.equal(policies.validateApaRoleModelPolicy({ ...valid, roles: Object.assign([], roles) }), false);
  assert.equal(policies.validateApaRoleModelPolicy(Object.assign([], valid)), false);
});

test('configured role policy accepts translation', () => {
  const main = { model: 'gpt-6-astra', reasoning_effort: 'high' };
  const roles = Object.fromEntries(policies.APA_CONFIGURED_ROLES.map(role => [role, { model: 'gpt-6.1-sol', reasoning_effort: 'low' }]));
  assert.ok(policies.APA_CONFIGURED_ROLES.includes('translation'));
  const policy = policies.createConfiguredApaRoleModelPolicy(main, roles);
  assert.deepEqual(policies.resolveApaRoleModel('translation', main, policy), roles.translation);
  assert.deepEqual(policies.resolveApaRoleModel('translation', main), main);
  assert.equal(policies.APA_VERIFIER_ROLES.includes('translation'), false);
});

test('a frozen legacy 10-role configured policy stays valid and does not resolve translation', () => {
  const policy = JSON.parse(readFileSync(new URL('./fixtures/apa-model-policy/legacy-configured-10-roles.json', import.meta.url), 'utf8'));
  assert.equal(Object.keys(policy.roles).length, 10);
  assert.equal(Object.hasOwn(policy.roles, 'translation'), false);
  assert.equal(policies.validateApaRoleModelPolicy(policy), true);
  assert.deepEqual(policies.resolveApaRoleModel('english-writer', undefined, policy), policy.roles['english-writer']);
  assert.deepEqual(policies.resolveApaRoleModel('independent-verifier', undefined, policy), policy.roles['independent-verifier']);
  assert.throws(() => policies.resolveApaRoleModel('translation', undefined, policy), /APA_CONFIGURED_ROLE_MODEL_INVALID/);
  // The optional translation entry must be a valid pair; any other extra or missing key is still rejected.
  const pair = { model: 'synthetic-provider/model', reasoning_effort: 'low' };
  assert.equal(policies.validateApaRoleModelPolicy({ ...policy, roles: { ...policy.roles, translation: pair } }), true);
  assert.equal(policies.validateApaRoleModelPolicy({ ...policy, roles: { ...policy.roles, translation: { model: '' } } }), false);
  assert.equal(policies.validateApaRoleModelPolicy({ ...policy, roles: { ...policy.roles, extra: pair } }), false);
  assert.equal(policies.validateApaRoleModelPolicy({ ...policy, roles: { ...policy.roles, extra: pair, translation: pair } }), false);
  const { evidence, ...missing } = policy.roles;
  assert.equal(policies.validateApaRoleModelPolicy({ ...policy, roles: { ...missing, translation: pair } }), false);
});
