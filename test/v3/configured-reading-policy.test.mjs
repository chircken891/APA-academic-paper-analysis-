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
