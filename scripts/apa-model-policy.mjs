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
// A configured model may omit reasoning_effort when its host has no such parameter.
const validConfiguredModelPair = value => !!(value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => key === 'model' || key === 'reasoning_effort') && typeof value.model === 'string' && value.model.trim()
  && (!Object.hasOwn(value, 'reasoning_effort') || ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value.reasoning_effort)));

/** The Codex collaboration call shape; runs without a saved host keep their original arguments. */
export const CODEX_HOST_DISPATCH = Object.freeze({ tool: 'collaboration.spawn_agent', model_argument: 'model', effort_argument: 'reasoning_effort',
  instruction_argument: 'message', task_name_argument: 'task_name', fresh_context: Object.freeze({ argument: 'fork_turns', value: 'none' }) });
const dispatchKeys = ['tool', 'model_argument', 'effort_argument', 'instruction_argument', 'task_name_argument', 'fresh_context'];
const named = value => typeof value === 'string' && value.trim().length > 0;
export function validHostDispatch(dispatch) {
  if (!dispatch || typeof dispatch !== 'object' || Array.isArray(dispatch) || Object.keys(dispatch).sort().join() !== [...dispatchKeys].sort().join()) return false;
  if (![dispatch.tool, dispatch.instruction_argument].every(named)
    || ![dispatch.model_argument, dispatch.effort_argument, dispatch.task_name_argument].every(value => value === null || named(value))) return false;
  // A tool that cannot choose the model runs the child on the main session's route, effort included.
  if (dispatch.model_argument === null && dispatch.effort_argument !== null) return false;
  const fresh = dispatch.fresh_context;
  if (fresh !== null && (!fresh || typeof fresh !== 'object' || Array.isArray(fresh) || Object.keys(fresh).sort().join() !== 'argument,value' || !named(fresh.argument))) return false;
  const used = [dispatch.model_argument, dispatch.effort_argument, dispatch.instruction_argument, dispatch.task_name_argument, fresh?.argument].filter(value => value !== null && value !== undefined);
  return new Set(used).size === used.length;
}

/**
 * Arguments for one fresh role call on the saved host; an effort the host cannot carry is refused, never dropped.
 * Without a model argument the child inherits the main session, so only follow-main roles reach here (checked at setup and run start).
 */
export function buildHostDispatchArguments(dispatch, { taskName, message, model }) {
  if (!validHostDispatch(dispatch)) throw new Error('APA_HOST_DISPATCH_INVALID');
  if (dispatch.model_argument && model.reasoning_effort !== undefined && !dispatch.effort_argument) throw new Error('APA_HOST_EFFORT_UNSUPPORTED');
  const args = {};
  if (dispatch.task_name_argument) args[dispatch.task_name_argument] = taskName;
  args[dispatch.instruction_argument] = message;
  if (dispatch.model_argument) args[dispatch.model_argument] = model.model;
  if (dispatch.model_argument && model.reasoning_effort !== undefined) args[dispatch.effort_argument] = model.reasoning_effort;
  if (dispatch.fresh_context) args[dispatch.fresh_context.argument] = structuredClone(dispatch.fresh_context.value);
  return args;
}

/** One fresh delegated call: the saved host's tool and argument names, or the Codex shape when no host is saved. */
export function hostDispatchCall(host, { taskName, message, model }) {
  const dispatch = host ? host.dispatch : CODEX_HOST_DISPATCH;
  return { tool: dispatch.tool, arguments: buildHostDispatchArguments(dispatch, { taskName, message, model }) };
}

export function hostDispatchArgumentsMatch(dispatch, args, model) {
  if (!validHostDispatch(dispatch) || !args || typeof args !== 'object' || Array.isArray(args)) return false;
  let expected;
  try { expected = buildHostDispatchArguments(dispatch, { taskName: dispatch.task_name_argument ? args[dispatch.task_name_argument] : undefined, message: args[dispatch.instruction_argument], model }); } catch { return false; }
  const keys = Object.keys(expected);
  return keys.length === Object.keys(args).length && keys.every(key => Object.hasOwn(args, key) && JSON.stringify(args[key]) === JSON.stringify(expected[key]));
}

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
  if (policy?.version === APA_CONFIGURED_MODEL_POLICY_VERSION) return !!(!Array.isArray(policy) && Object.keys(policy).length === 3
    && validConfiguredModelPair(policy.main_session) && policy.roles && typeof policy.roles === 'object' && !Array.isArray(policy.roles)
    && Object.keys(policy.roles).length === APA_CONFIGURED_ROLES.length
    && APA_CONFIGURED_ROLES.every(role => validConfiguredModelPair(policy.roles[role])));
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
