import { createHash } from 'node:crypto';
import { FORMAL_APA_MODELS, APA_VERIFIER_ROLES, resolveApaRoleModel, validateApaRoleModelPolicy, hostDispatchArgumentsMatch } from '../apa-model-policy.mjs';

const CASE_ID = /^P21-E(0[1-9]|1[0-2])$/;
const STATUSES = new Set(['pass', 'fail', 'not_run', 'blocked']);
const TIERS = new Set(['offline_fixture', 'local_dispatch', 'host_observation', 'real_corpus', 'human_gold']);
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const P20_UNVERIFIED = Object.freeze({
  source_rule_binding: 'unverified',
  initial_delivery_binding: 'unverified',
  continuation_delivery_binding: 'unverified',
});

const clone = value => structuredClone(value);
const digest = value => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const canonical = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
};
const canonicalHash = value => `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;

function fail(code) { throw new Error(code); }

function requiredString(value, code) {
  if (typeof value !== 'string' || !value) fail(code);
  return value;
}

function requiredFingerprint(value) {
  if (!SHA256.test(value ?? '')) fail('FINGERPRINT_SHA256_REQUIRED');
  return value;
}

function normalizeP20(value) {
  const result = { ...P20_UNVERIFIED, ...(value ?? {}) };
  if (Object.values(result).some(disposition => disposition !== 'unverified')) fail('P20_E12_CANNOT_BE_CLOSED_BY_PHASE21_LEDGER');
  return result;
}

export function createEvaluationLedger({ phase, cases } = {}) {
  requiredString(String(phase ?? ''), 'PHASE_REQUIRED');
  if (!Array.isArray(cases) || cases.length !== 12) fail('TWELVE_P21_CASES_REQUIRED');
  const definitions = new Map();
  for (const definition of cases) {
    if (!CASE_ID.test(definition?.case_id) || definitions.has(definition.case_id)) fail('P21_CASE_MAP_INVALID');
    if (!TIERS.has(definition.tier)) fail('P21_CASE_TIER_INVALID');
    definitions.set(definition.case_id, Object.freeze(clone(definition)));
  }
  for (let number = 1; number <= 12; number += 1) {
    const id = `P21-E${String(number).padStart(2, '0')}`;
    if (!definitions.has(id)) fail('P21_CASE_MAP_INCOMPLETE');
  }
  return {
    phase: String(phase),
    definitions,
    rows: new Map([...definitions.values()].map(definition => [definition.case_id, {
      case_id: definition.case_id,
      expected: null,
      actual: null,
      status: 'not_run',
      tier: definition.tier,
      remaining_owner: definition.remaining_owner,
      source_or_fixture_fingerprint: null,
      instruction_fingerprint: null,
      configuration_fingerprint: null,
      command_or_session_id: null,
      observed_output_hash: null,
      resource_availability: 'unknown',
      p20_e12: definition.case_id === 'P21-E12' ? clone(P20_UNVERIFIED) : undefined,
    }])),
  };
}

export function recordEvidenceCase({ ledger, caseId, expected, actual, evidence } = {}) {
  if (!ledger?.definitions || !ledger?.rows || !ledger.definitions.has(caseId)) fail('P21_CASE_UNKNOWN');
  const definition = ledger.definitions.get(caseId);
  if (!STATUSES.has(evidence?.status)) fail('EVIDENCE_STATUS_INVALID');
  if (!TIERS.has(evidence?.tier)) fail('EVIDENCE_TIER_INVALID');
  if (definition.tier === 'offline_fixture' && evidence.tier !== 'offline_fixture') fail('OFFLINE_TIER_PROMOTION');
  if (definition.tier === 'host_observation' && evidence.tier === 'offline_fixture' && evidence.status === 'pass') fail('HOST_EVIDENCE_CANNOT_BE_SYNTHETIC');
  const sourceOrFixture = evidence.source_or_fixture_fingerprint ?? evidence.fixture_fingerprint ?? evidence.source_fingerprint;
  const commandOrSession = evidence.command_or_session_id ?? evidence.command ?? evidence.actual_session_or_agent_id;
  requiredFingerprint(sourceOrFixture);
  requiredFingerprint(evidence.instruction_fingerprint);
  requiredFingerprint(evidence.configuration_fingerprint);
  const observedOutputHash = evidence.observed_output_hash ?? evidence.output_hash ?? null;
  const outputAbsenceReason = evidence.output_absence_reason ?? null;
  if (observedOutputHash !== null && !SHA256.test(observedOutputHash)) fail('FINGERPRINT_SHA256_REQUIRED');
  if (outputAbsenceReason !== null && (typeof outputAbsenceReason !== 'string' || !outputAbsenceReason)) fail('OUTPUT_ABSENCE_REASON_REQUIRED');
  if (evidence.status === 'pass' && !observedOutputHash && !outputAbsenceReason) fail('PASSING_OUTPUT_EVIDENCE_REQUIRED');
  requiredString(commandOrSession, 'COMMAND_OR_SESSION_REQUIRED');
  const row = {
    case_id: caseId,
    expected: clone(expected),
    actual: clone(actual),
    status: evidence.status,
    tier: evidence.tier,
    remaining_owner: requiredString(evidence.remaining_owner ?? definition.remaining_owner, 'REMAINING_OWNER_REQUIRED'),
    source_or_fixture_fingerprint: sourceOrFixture,
    instruction_fingerprint: evidence.instruction_fingerprint,
    configuration_fingerprint: evidence.configuration_fingerprint,
    command_or_session_id: commandOrSession,
    observed_output_hash: observedOutputHash,
    output_absence_reason: outputAbsenceReason,
    resource_availability: evidence.resource_availability ?? 'unknown',
    p20_e12: caseId === 'P21-E12' ? normalizeP20(evidence.p20_e12) : undefined,
  };
  ledger.rows.set(caseId, row);
  return clone(row);
}

export function summarizeEvaluationGate(ledger) {
  if (!ledger?.rows || !ledger?.definitions) fail('EVALUATION_LEDGER_REQUIRED');
  const rows = [...ledger.rows.values()].map(clone);
  const blockers = [];
  for (const row of rows) {
    if (row.status !== 'pass') blockers.push(`${row.case_id}:${row.status}:${row.remaining_owner}`);
    if (row.tier === 'offline_fixture' && row.status === 'pass') blockers.push(`${row.case_id}:offline evidence remains local`);
    if (row.resource_availability === 'unknown') blockers.push(`${row.case_id}:resource observation unknown`);
  }
  const e12 = ledger.rows.get('P21-E12');
  if (!e12 || Object.values(e12.p20_e12 ?? P20_UNVERIFIED).some(value => value !== 'unverified')) fail('P20_E12_DISPOSITION_CORRUPTED');
  blockers.push('P20-E12:source/rule, initial delivery, and continuation delivery remain unverified');
  return Object.freeze({
    phase: ledger.phase,
    phase_complete: false,
    status: 'incomplete',
    rows,
    blockers: [...new Set(blockers)],
    ledger_fingerprint: digest(rows),
  });
}

export function validateEvaluationApprovalPacket(packet) {
  const errors = [];
  const nonEmpty = (value, code) => {
    if (typeof value !== 'string' || !value) errors.push(code);
  };
  nonEmpty(packet?.run_id, 'RUN_ID_REQUIRED');
  nonEmpty(packet?.user_approval_id, 'USER_APPROVAL_ID_REQUIRED');
  if (!TIERS.has(packet?.intended_evidence_tier)) errors.push('EVIDENCE_TIER_REQUIRED');
  nonEmpty(packet?.source?.path, 'SOURCE_PATH_REQUIRED');
  if (!SHA256.test(packet?.source?.sha256 ?? '')) errors.push('SOURCE_HASH_REQUIRED');
  if (!Number.isInteger(packet?.source?.byte_length) || packet.source.byte_length < 0) errors.push('SOURCE_BYTES_REQUIRED');
  if (!SHA256.test(packet?.instruction_fingerprint ?? '')) errors.push('INSTRUCTION_FINGERPRINT_REQUIRED');
  if (!SHA256.test(packet?.configuration_fingerprint ?? '')) errors.push('CONFIGURATION_FINGERPRINT_REQUIRED');
  nonEmpty(packet?.allowed_output_root, 'OUTPUT_ROOT_REQUIRED');
  nonEmpty(packet?.backend?.identity, 'BACKEND_IDENTITY_REQUIRED');
  nonEmpty(packet?.backend?.version, 'BACKEND_VERSION_REQUIRED');
  nonEmpty(packet?.backend?.runtime_configuration_version, 'RUNTIME_CONFIGURATION_VERSION_REQUIRED');
  if (!packet?.backend?.configuration || typeof packet.backend.configuration !== 'object') errors.push('BACKEND_CONFIGURATION_REQUIRED');
  else if (packet.configuration_fingerprint !== canonicalHash(packet.backend.configuration)) errors.push('CONFIGURATION_FINGERPRINT_MISMATCH');
  if (!packet?.endpoint || !['approved', 'denied'].includes(packet.endpoint.egress) || !['local_only', 'approved'].includes(packet.endpoint.retention)) errors.push('EGRESS_RETENTION_REQUIRED');
  nonEmpty(packet?.host_action_scope?.action, 'HOST_ACTION_SCOPE_REQUIRED');
  if (!Array.isArray(packet?.host_action_scope?.permitted_result_fields)) errors.push('HOST_RESULT_FIELDS_REQUIRED');
  if (!Array.isArray(packet?.expected_resource_fields)) errors.push('RESOURCE_FIELDS_REQUIRED');
  if (packet?.role_model_policy !== undefined) {
    const policy = packet.role_model_policy, scope = packet.host_action_scope;
    const dispatched = scope?.dispatch !== undefined;
    if (!validateApaRoleModelPolicy(policy) || packet.backend?.identity !== 'current-collaboration'
      || !(dispatched ? scope.action === scope.dispatch?.tool : ['collaboration.spawn_agent', 'collaboration.followup_task'].includes(scope?.action))
      || !(APA_VERIFIER_ROLES.includes(scope?.role) || packet.workflow_profile === 'reading-first-1.0' && ['evidence','methods','results','interpretation','scientific-reading','integration','comparison','ledger','english-writer','chinese-writer','translation','reading-editor','independent-verifier'].includes(scope?.role))) errors.push('ROLE_MODEL_POLICY_INVALID');
    else {
      const profile = resolveApaRoleModel(scope.role, policy.main_session, policy);
      if (packet.requested_model !== profile.model || (dispatched ? !hostDispatchArgumentsMatch(scope.dispatch, scope.arguments, profile) : scope.action === 'collaboration.spawn_agent'
        && (scope.arguments?.model !== profile.model || scope.arguments?.reasoning_effort !== profile.reasoning_effort))) errors.push('ROLE_MODEL_POLICY_MISMATCH');
    }
  } else if (!FORMAL_APA_MODELS.includes(packet?.requested_model)) errors.push('FORMAL_MODEL_POLICY_REQUIRED');
  if (packet?.observed_model !== 'unknown') errors.push('OBSERVED_MODEL_MUST_REMAIN_UNKNOWN');
  const measure = value => Number.isFinite(value?.value) && value.value >= 0 && typeof value.unit === 'string' && value.unit;
  if (!measure(packet?.estimate) || !measure(packet?.approved_budget_cap)
    || packet.estimate.unit !== packet.approved_budget_cap.unit || packet.estimate.value > packet.approved_budget_cap.value) errors.push('APPROVAL_BUDGET_INVALID');
  if (!Number.isInteger(packet?.retry_allowance) || packet.retry_allowance < 0) errors.push('RETRY_ALLOWANCE_REQUIRED');
  return Object.freeze({ ok: errors.length === 0, errors, packet: errors.length === 0 ? clone(packet) : null });
}
