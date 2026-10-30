import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateReadingPreflight } from '../../scripts/lib/reading-preflight.mjs';
import { checkPageGate } from '../../scripts/lib/apa-setup-issues.mjs';

const dispatch = { tool: 'Agent', model_argument: 'model', effort_argument: 'effort', instruction_argument: 'prompt', task_name_argument: null, fresh_context: { argument: 'fork', value: 'none' } };
const profile = { host: 'host', dispatch, sources: { dispatch: 'tool-schema', models: 'tool-schema' }, models: [{ model: 'm', reasoning_efforts: ['high'] }], session: { model: 'm', reasoning_effort: 'high' } };
const inspection = { config: { host: { name: 'host', dispatch }, models: { science: { mode: 'explicit', model: 'm', reasoning_effort: 'high' } } }, validation: { complete: true }, dependencies: [], host_check: { host: 'match', issues: [] }, ready: true };
const evidence = { current_host: { name: 'host', reference: 'current session' }, dispatch: { tool: 'Agent', source: 'tool-schema', reference: 'schema' }, fresh_context: { source: 'tool-schema', reference: 'schema', argument: 'fork', value: 'none' }, file_read: { status: 'pass', reference: 'read' }, control_write: { status: 'pass', reference: 'write and read back' }, input: { status: 'pass', reference: 'pdf' } };

test('preflight requires current runtime evidence independently of ready', () => {
  assert.equal(inspection.ready, true);
  assert.equal(evaluateReadingPreflight({ inspection, hostProfile: profile }).status, 'unknown');
  assert.equal(evaluateReadingPreflight({ inspection, hostProfile: profile, evidence }).status, 'pass');
  assert.equal(evaluateReadingPreflight({ inspection, hostProfile: profile, evidence: { ...evidence, current_host: { name: 'other', reference: 'current' } } }).status, 'blocked');
  assert.equal(evaluateReadingPreflight({ inspection: { ...inspection, validation: { complete: false } }, hostProfile: profile, evidence }).status, 'blocked');
  assert.equal(evaluateReadingPreflight({ inspection, hostProfile: profile, evidence: { ...evidence, control_write: undefined } }).status, 'unknown');
  assert.equal(evaluateReadingPreflight({ inspection, hostProfile: { ...profile, dispatch: null }, evidence }).status, 'blocked');
  assert.equal(evaluateReadingPreflight({ inspection, hostProfile: { ...profile, models: [{ model: 'm', reasoning_efforts: ['low'] }] }, evidence }).status, 'blocked');
  assert.equal(evaluateReadingPreflight({ inspection, hostProfile: profile, evidence: { ...evidence, input: { status: 'blocked', reference: 'unreadable' } } }).status, 'blocked');
  assert.equal(evaluateReadingPreflight({ inspection, hostProfile: profile, evidence: { ...evidence, fresh_context: { source: 'tool-schema', reference: 'schema', argument: 'fork', value: 'all' } } }).status, 'unknown');
});

test('advanced investigation and dependency authorization do not prevent the basic page', () => {
  const issues = [{ id: 'investigate:capability:manual_compaction', category: 'investigate' }, { id: 'authorize:dependency:parser.python', category: 'authorize' }];
  assert.equal(checkPageGate(issues).ok, true);
});

test('follow-main uses a supported session pair when dispatch selects models', () => {
  const follow = { ...inspection, config: { ...inspection.config, models: { science: { mode: 'follow-main' } } } };
  const hostProfile = { ...profile, sources: { ...profile.sources, session: 'system-context' }, session: { model: 'missing', reasoning_effort: 'high' } };
  assert.equal(evaluateReadingPreflight({ inspection: follow, hostProfile, evidence }).status, 'blocked');
  assert.equal(evaluateReadingPreflight({ inspection: follow, hostProfile: { ...hostProfile, session: { model: 'm', reasoning_effort: 'high' } }, evidence }).status, 'pass');
  assert.equal(evaluateReadingPreflight({ inspection: follow, hostProfile: { ...hostProfile, sources: { ...hostProfile.sources, models: 'unavailable' }, models: [] }, evidence }).status, 'unknown');
  assert.equal(evaluateReadingPreflight({ inspection: follow, hostProfile: { ...hostProfile, session: { model: 'm', reasoning_effort: 'low' } }, evidence }).status, 'blocked');
  const inheritedDispatch = { ...dispatch, model_argument: null, effort_argument: null };
  const inherited = { ...hostProfile, dispatch: inheritedDispatch, models: [] };
  assert.equal(evaluateReadingPreflight({ inspection: follow, hostProfile: inherited, evidence }).status, 'pass');
});

test('query-only host issues do not block reading', () => {
  const queryIssue = { ...inspection, host_check: { host: 'match', issues: [{ key: 'models.query', issue: 'model-not-detected' }] } };
  assert.equal(evaluateReadingPreflight({ inspection: queryIssue, hostProfile: profile, evidence }).status, 'pass');
  const readingIssue = { ...inspection, host_check: { host: 'match', issues: [{ key: 'models.science', issue: 'model-not-detected' }] } };
  assert.equal(evaluateReadingPreflight({ inspection: readingIssue, hostProfile: profile, evidence }).status, 'blocked');
});
