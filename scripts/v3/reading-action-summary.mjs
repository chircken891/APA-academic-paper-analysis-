const MAX_BYTES = 8192;
const numeric = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const authorization = Object.freeze({ desktop_control: 'explicit-user-authorization-required', native_observation: 'explicit-user-authorization-required',
  publication: 'separate-approval', model_policy: 'frozen', unknown_outcomes: 'reconcile-before-dispatch' });

/** A bounded projection for the Controller conversation; full records remain in the checkpoint. */
export function buildReadingActionSummary({ runId, stage, status, action, taskId, handle, budget = {}, blockCode, artifacts = [], statePath } = {}) {
  let truncated = false;
  const short = (value, limit = 512) => {
    if (typeof value !== 'string') return null;
    if (Buffer.byteLength(value, 'utf8') <= limit) return value;
    truncated = true;
    let result = '';
    for (const character of value) { if (Buffer.byteLength(result + character, 'utf8') > limit - 3) break; result += character; }
    return result + '…';
  };
  if (typeof statePath !== 'string' || Buffer.byteLength(statePath, 'utf8') > 4096) throw new Error('READING_SUMMARY_STATE_REFERENCE_INVALID');
  const known = numeric(budget.remaining_total) !== null;
  const summary = { run_id: short(runId), stage: short(stage), status: short(status), next_action: short(action), task: { id: short(taskId), handle: short(handle) },
    budget: { status: known ? 'known' : 'unknown', task_calls_used: numeric(budget.task_calls_used),
      initial_dispatches: numeric(budget.initial_dispatches), continuations: numeric(budget.continuations), total_used: numeric(budget.total_used),
      reserved: numeric(budget.reserved), occupied: numeric(budget.occupied), total_limit: numeric(budget.total_limit), remaining_total: numeric(budget.remaining_total),
      ...(budget.original_total_limit===undefined ? {} : {original_total_limit:numeric(budget.original_total_limit),additional_limit:numeric(budget.additional_limit),additional_used:numeric(budget.additional_used)}) },
    block_code: short(blockCode), artifacts: [], authorization: { ...authorization }, truncated: false, state_ref: statePath };
  for (const row of artifacts) {
    if (summary.artifacts.length >= 8) { truncated = true; break; }
    if (typeof row?.path !== 'string' || Buffer.byteLength(row.path, 'utf8') > 2048) { truncated = true; continue; }
    summary.artifacts.push({ path: row.path, sha256: /^sha256:[a-f0-9]{64}$/.test(row.sha256 ?? '') ? row.sha256 : null, byte_length: numeric(row.byte_length) });
  }
  while (Buffer.byteLength(JSON.stringify(summary), 'utf8') > MAX_BYTES && summary.artifacts.length) { summary.artifacts.pop(); truncated = true; }
  if (Buffer.byteLength(JSON.stringify(summary), 'utf8') > MAX_BYTES) {
    for (const key of ['run_id', 'stage', 'status', 'next_action', 'block_code']) summary[key] = short(summary[key], 128);
    summary.task = { id: short(summary.task.id, 128), handle: short(summary.task.handle, 128) };
  }
  summary.truncated = truncated;
  if (Buffer.byteLength(JSON.stringify(summary), 'utf8') > MAX_BYTES) throw new Error('READING_SUMMARY_SIZE_EXCEEDED');
  return summary;
}
