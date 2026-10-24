// Project policy, not an observation of any particular run's model.
export const DEFAULT_APA_MODEL = 'gpt-6.1-sol';
export const DEFAULT_APA_REASONING_EFFORT = 'medium';
// Preserve previously authorized executors and their exact historical identities.
export const FORMAL_APA_MODELS = Object.freeze([DEFAULT_APA_MODEL, 'gpt-6-sol', 'gpt-5.6-terra']);

export const APA_ROLE_MODEL_POLICY_VERSION = 'apa-role-model-policy-1.0';
export const APA_MAIN_SESSION_ROLES = Object.freeze(['english-writer', 'chinese-writer', 'reading-editor', 'bilingual-verifier', 'independent-verifier', 'source-check', 'scientific-audit', 'post-render-verifier']);
export const APA_VERIFIER_ROLES = Object.freeze(APA_MAIN_SESSION_ROLES.filter(role => !role.endsWith('-writer') && role !== 'reading-editor'));
const executionRoles = new Set(['evidence', 'methods', 'results', 'interpretation', 'comparison', 'integration', 'scientific-reading', 'ledger', 'quantity', 'mapping']);
const validMainSession = value => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === 2 && typeof value.model === 'string' && /^gpt-[a-zA-Z0-9.-]+$/.test(value.model)
  && ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value.reasoning_effort);

export const APA_CONFIGURED_MODEL_POLICY_VERSION = 'apa-configured-role-model-policy-1.0';
export const APA_CONFIGURED_ROLES = Object.freeze(['evidence', 'methods', 'results', 'interpretation', 'scientific-reading', 'integration', 'english-writer', 'chinese-writer', 'reading-editor', 'independent-verifier']);

export function resolveApaRoleModel(role, mainSession, policy) {
  if (policy?.version === APA_CONFIGURED_MODEL_POLICY_VERSION) {
    if (!validateApaRoleModelPolicy(policy) || !policy.roles[role]) throw new Error('APA_CONFIGURED_ROLE_MODEL_INVALID');
    return { ...policy.roles[role] };
  }
  if (APA_MAIN_SESSION_ROLES.includes(role)) {
    if (!validMainSession(mainSession)) throw new Error('APA_MAIN_SESSION_INVALID');
    return { model: mainSession.model, reasoning_effort: mainSession.reasoning_effort };
  }
  if (!executionRoles.has(role)) throw new Error('APA_ROLE_UNKNOWN');
  return { model: DEFAULT_APA_MODEL, reasoning_effort: DEFAULT_APA_REASONING_EFFORT };
}

export function validateApaRoleModelPolicy(policy) {
  if (policy?.version === APA_CONFIGURED_MODEL_POLICY_VERSION) return Object.keys(policy).length === 3
    && validMainSession(policy.main_session) && policy.roles && Object.keys(policy.roles).length === APA_CONFIGURED_ROLES.length
    && APA_CONFIGURED_ROLES.every(role => {
      const pair = policy.roles[role];
      return pair && Object.keys(pair).length === 2 && typeof pair.model === 'string' && !!pair.model.trim()
        && ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(pair.reasoning_effort);
    });
  return !!(policy && typeof policy === 'object' && !Array.isArray(policy) && Object.keys(policy).length === 2
    && policy.version === APA_ROLE_MODEL_POLICY_VERSION && validMainSession(policy.main_session));
}

export function createConfiguredApaRoleModelPolicy(mainSession, roles) {
  const policy = { version: APA_CONFIGURED_MODEL_POLICY_VERSION, main_session: structuredClone(mainSession), roles: structuredClone(roles) };
  if (!validateApaRoleModelPolicy(policy)) throw new Error('APA_CONFIGURED_ROLE_MODEL_INVALID');
  Object.values(policy.roles).forEach(Object.freeze);
  return Object.freeze({ ...policy, main_session: Object.freeze(policy.main_session), roles: Object.freeze(policy.roles) });
}

export function createApaRoleModelPolicy(mainSession) {
  if (!validMainSession(mainSession)) throw new Error('APA_MAIN_SESSION_INVALID');
  return Object.freeze({ version: APA_ROLE_MODEL_POLICY_VERSION, main_session: Object.freeze({ ...mainSession }) });
}
