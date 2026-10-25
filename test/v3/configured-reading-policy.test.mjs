import assert from 'node:assert/strict';
import test from 'node:test';
import * as policies from '../../scripts/apa-model-policy.mjs';

test('configured role models validate and resolve without changing historical policy semantics', () => {
  const main = { model: 'gpt-6-astra', reasoning_effort: 'high' };
  const roles = Object.fromEntries(['evidence','methods','results','interpretation','scientific-reading','integration','english-writer','chinese-writer','reading-editor','independent-verifier'].map(role => [role, { model: 'gpt-6.1-sol', reasoning_effort: 'low' }]));
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
