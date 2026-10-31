import { isDeepStrictEqual } from 'node:util';
import { validateHostReceiptEvidence } from './reading-host-evidence.mjs';
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const copy = value => structuredClone(value);
export const usesExecutionLedger = binding => ['configured-reading-2.1', 'configured-reading-2.2'].includes(binding?.configured_setup?.instruction_profile);
export function validateExecutionLedger(ledger, limit, options = {}) {
  if (!Array.isArray(ledger) || !Number.isSafeInteger(limit) || limit < 0 || ledger.length > limit) fail('EXECUTION_LEDGER_INVALID');
  const ids = new Set(), actions = new Set();
  for (const row of ledger) {
    if (!row || !['execution_id','task_id','action_id','tool'].every(key => typeof row[key] === 'string' && row[key].trim())
      || !['initial','continuation'].includes(row.kind) || !['prepared','issued','observed'].includes(row.status)
      || !(row.handle === null || typeof row.handle === 'string' && row.handle.trim())
      || !row.arguments || typeof row.arguments !== 'object' || Array.isArray(row.arguments)
      || row.kind === 'continuation' && !row.handle || row.status === 'observed' && !row.receipt
      || ids.has(row.execution_id) || actions.has(row.action_id)) fail('EXECUTION_LEDGER_INVALID');
    if (row.kind === 'continuation' && row.receipt && (row.receipt.execution_id !== row.execution_id || row.receipt.action_id !== row.action_id || row.receipt.agent_id !== row.handle || row.receipt.tool_call?.name !== row.tool || !isDeepStrictEqual(row.receipt.tool_call?.arguments,row.arguments) || typeof row.receipt.raw_result_text !== 'string' || !['observed','outcome_unknown'].includes(row.receipt.status) || (row.status === 'observed') !== (row.receipt.status === 'observed'))) fail('EXECUTION_LEDGER_INVALID');
    if (row.receipt) {
      validateHostReceiptEvidence(row.receipt, options);
      if (options.strict && ((row.status === 'observed') === (row.receipt.status === 'outcome_unknown'))) fail('EXECUTION_LEDGER_INVALID');
    }
    ids.add(row.execution_id); actions.add(row.action_id);
  }
  return ledger;
}
export function reserveExecution(ledger, request, limit) {
  validateExecutionLedger(ledger, limit);
  const existing = ledger.find(item => item.execution_id === request.execution_id);
  if (existing) {
    const {status, receipt, ...prior} = existing;
    if (!isDeepStrictEqual(prior, request)) fail('EXECUTION_LEDGER_CONFLICT');
    return copy(existing);
  }
  if (ledger.length >= limit) fail('EXECUTION_BUDGET_EXHAUSTED');
  if (request.kind === 'continuation' && ledger.some(row => row.kind === 'continuation' && row.task_id === request.task_id && row.status !== 'observed')) fail('EXECUTION_PENDING');
  const row = {...copy(request), status:'prepared'};
  validateExecutionLedger([...ledger, row], limit); ledger.push(row); return copy(row);
}
export function markExecutionDispatched(ledger, executionId) {
  const row = ledger.find(item => item.execution_id === executionId);
  if (!row || row.status === 'observed') fail('EXECUTION_INTENT_INVALID');
  row.status = 'issued'; return copy(row);
}
export function recordExecutionReceipt(ledger, executionId, receipt, options = {}) {
  const row = ledger.find(item => item.execution_id === executionId);
  if (!row || row.status === 'prepared' || !receipt || typeof receipt !== 'object') fail('EXECUTION_RECEIPT_INVALID');
  if (row.kind === 'continuation' && (receipt.execution_id !== row.execution_id || receipt.action_id !== row.action_id || receipt.agent_id !== row.handle
    || receipt.tool_call?.name !== row.tool || !isDeepStrictEqual(receipt.tool_call?.arguments, row.arguments)
    || typeof receipt.raw_result_text !== 'string' || !['observed','outcome_unknown'].includes(receipt.status))) fail('EXECUTION_RECEIPT_INVALID');
  validateHostReceiptEvidence(receipt, options);
  if (row.receipt && isDeepStrictEqual(row.receipt, receipt)) return copy(row);
  if (row.status === 'observed' || row.receipt && row.receipt.status !== 'outcome_unknown') fail('EXECUTION_RECEIPT_CONFLICT');
  row.receipt = copy(receipt); row.status = receipt.status === 'outcome_unknown' ? 'issued' : 'observed'; return copy(row);
}
export function executionBudgetSummary(ledger, limit) {
  validateExecutionLedger(ledger, limit);
  const reserved = ledger.filter(row => row.status === 'prepared').length;
  return {total_used:ledger.length-reserved, initial_dispatches:ledger.filter(row=>row.kind==='initial' && row.status!=='prepared').length, continuations:ledger.filter(row=>row.kind==='continuation' && row.status!=='prepared').length, reserved, occupied:ledger.length, total_limit:limit, remaining_total:limit-ledger.length};
}
