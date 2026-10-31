import test from 'node:test';
import assert from 'node:assert/strict';
import { reserveExecution, markExecutionDispatched, recordExecutionReceipt, validateExecutionLedger, executionBudgetSummary } from '../../scripts/v3/reading-execution-budget.mjs';
test('reservations count once, reject conflicts and retain unknown outcomes', () => {
  const ledger = [], request = { execution_id:'one', task_id:'task', action_id:'action', handle:'agent', tool:'host.resume', arguments:{x:1}, kind:'continuation' };
  reserveExecution(ledger, request, 2); reserveExecution(ledger, request, 2);
  assert.deepEqual(executionBudgetSummary(ledger, 2), {total_used:0,initial_dispatches:0,continuations:0,reserved:1,occupied:1,total_limit:2,remaining_total:1});
  assert.throws(() => reserveExecution(ledger, {...request, handle:'other'}, 2));
  assert.throws(() => reserveExecution(ledger, {...request, execution_id:'two', action_id:'action2'}, 2));
  markExecutionDispatched(ledger, 'one');
  const receipt = {execution_id:'one',action_id:'action',agent_id:'agent',tool_call:{name:'host.resume',arguments:{x:1}},raw_result_text:'',status:'outcome_unknown'};
  recordExecutionReceipt(ledger, 'one', receipt); recordExecutionReceipt(ledger, 'one', receipt);
  assert.equal(ledger[0].status, 'issued');
  recordExecutionReceipt(ledger, 'one', {...receipt,status:'observed'});
  assert.throws(() => recordExecutionReceipt(ledger, 'one', {...receipt,status:'observed',raw_result_text:'conflict'}));
  reserveExecution(ledger, {...request, execution_id:'two', action_id:'action2'}, 2);
  assert.throws(() => reserveExecution(ledger, {...request, execution_id:'three', task_id:'other', action_id:'action3'}, 2));
  validateExecutionLedger(ledger, 2);
});
