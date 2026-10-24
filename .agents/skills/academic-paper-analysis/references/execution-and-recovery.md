# Bounded execution and recovery

For new unbound `reading-first-1.0`, follow the [Controller call chain below](#controller-call-chain-for-a-new-authorized-run): create/freeze run control, use six actual science artifacts, accept source-first Writers and, when configured, the bound Reading Editor, render and sample native behavior when available, then one overall review with at most one material local recheck. Independent source-first/scientific-audit/pre-render parity and per-fragment auditing are historical bound-contract behavior only. Use the current checked-out repository root; preserve historical registered paths and original budget/handles.

Use the current package's existing RUN, authorization, checkpoint, and results files. Do not introduce another mandatory ledger or duplicate the source bundle just to follow this guide.

## Before work

Recover the paper/run/revision, input and dependency fingerprints, authorized source ranges, owned outputs, model/effort, allowed calls, deadline, and stopping point from the actual package. Distinguish a proposed budget from a started one, and an interrupted run from a closed run. Do not infer active permission from unused capacity.

Keep three permissions distinct when reusing a source snapshot: its original acquisition permission, the current scientific execution permission, and downstream consumption/publication permission. A capacity test or old acquisition receipt cannot authorize a new content run. Use existing explicit reuse/binding interfaces when supported; do not edit old authorization hashes to make them equal to the new run.

## Reuse before rerun

Reuse unchanged evidence within its original scope after checking the dependencies relevant to the next action. For a delta review, identify the newly examined pages/cells/claims and the historical evidence adopted; retain `partial` coverage when warranted. Do not label adopted material newly read or claim a full-paper review from a bounded window.

When metadata or source IDs need normalization, use the approved run-local adapter/binding layer. Preserve raw role returns and scientific content. A content change requires a new revision and invalidates affected downstream reviews/receipts; a metadata repair is not an excuse to rerun all content or rewrite its provenance.

Before another source read, parse, or comparison, state what unresolved item it can actually resolve. If a proposed parser run cannot repair a known baseline or supply the consumer's missing evidence, do not run it merely because it is available. Keep evaluated failures as results, with their original denominators and lineage.

## Delegate only a useful bounded unit

Use a subagent when the approved role contract requires real role execution or an independent, bounded task benefits from delegation. A small local edit needs no extra review agent by default. Supply:

- the task's purpose, exact input/revision and relevant user decisions;
- output and file ownership, preserved artifacts, prohibited operations, and peer ownership;
- source scope, model/effort when prescribed, remaining budget and stopping condition;
- the relevant contracts and sufficient acceptance checks.

Agents are not alone in the workspace and must not revert peers' changes. Content roles follow the paper's model policy; development roles do not automatically inherit formal paper-executor status. The parent integrates and verifies results. Prompted ownership is not evidence of OS isolation.

A source-first review seals its initial observation before seeing the upstream interpretation when required by its contract. A fresh agent is not automatically blind or independent. Preserve actual exposure and `not_independent`/unknown states rather than relabelling a non-blind review.

## Bounded enrichment and recovery

For new runs whose approved binding permits enrichment, follow [the active gap guide](../../../../docs/apa-v3/active-gap-enrichment.md). Freeze allowed source kinds/scope and the available original total call allowance, not a blanket promise to fetch anything. Newly obtained direct method/official source snapshots are registered on actual receipt and bound separately from the main paper. Keep original main-text-only scope; no automatic supplements or citation-tree expansion.

Save the compact gap batch, accepted source identities/versions, scientific owned receipts, shared context revision, pending native steps and consumed counters with the existing Controller checkpoint. Resume the same batch and actual task handles without reissuing already emitted calls. A late science gap requires owner recovery before affected Writer repair; a style/organization omission does not reopen science. Keep the existing one overall review and maximum one localized recheck. The total budget already accounts for earlier science calls; this feature does not open a new window or enlarge the original cap.

## On interruption or capacity failure

1. Record the actual failure, completed outputs/receipts, active agent or command IDs, pending actions, original deadline/call usage, and the smallest remaining step in the existing checkpoint.
2. Reconcile any unknown write outcome using saved bytes and receipts before retrying. A missing acknowledgment is not proof that nothing was written; a draft is not a completed return.
3. With a valid remaining budget, recover only the missing step using the same authorized model, service, source, route and criteria. Check current agent capacity; do not repeatedly spawn into a known limit or replace required independent work with parent-authored results.
4. If the deadline expired or the package closed, preserve the checkpoint and prepare the exact continuation scope. Obtain a new explicit budget before budgeted execution; do not reset the old clock, reuse a closed balance, or count elapsed waiting as approval.

Never manufacture review/decision/validation files to fill an interrupted sequence. Do not start another model or data source in response to quota or network failure. Do not keep an automation watching capacity unless the user requests it.

An explicitly authorized reading-first continuation may adopt one or both compatible reading-first Writer receipts through `adopted_views`; the runtime validates the original owned bytes, view format and receipt. With one source-language view, dispatch only the missing counterpart and keep the original receipt in the source-first payload. With both views, proceed to the Reading Editor. Preserve the failed predecessor call and old deadline; freeze the new authorization separately, without re-running completed scientific roles or Writers.

Legacy P22 `phase22-adopted-views-1.0` uses its saved binding and the distinct adoption interface in `scripts/v3/phase22-language.mjs`, including its required pair of checkpoint-bound Writer views. That interface and reading-first `adopted_views` are not interchangeable; do not cast or relabel old view bytes to satisfy the new format.

## Storage and handoff

Large artifacts must survive actual save, reload, integrity checks, and consumption by the existing consumer before claiming durable handoff. In-memory equality alone does not cover serialization limits or out-of-memory failures. Reuse the established codec or reference interface when available; a new storage mechanism needs a concrete consumer gap and implementation scope. Do not rebuild or duplicate large validated bundles to refresh a wrapper.

Compose from the final saved role artifacts and their actual dependencies, not solely parent-side in-memory objects. Preserve raw returns, revision ancestry, source/parser/config fingerprints and actual receipt bindings. Recheck affected dependencies at the consumption boundary; do not attach an old revision's successful receipts to a new scientific input.

## Close without expanding

Close the package when its authorized outputs and sufficient checks are complete, or at its defined genuine blocker. Record completion, failure, `not_run`, and remaining owner separately. Stop owned work using supported tools and reflect actual budget closure. A user's decision to stop one paper does not grant general limited-case acceptance, remove its parser failure, or issue a handoff.

For example: if revision 1 is frozen and only review 2 was interrupted, resume review 2 after confirming scope and budget. Do not recreate revision 1, repeat its source reading, or extend the run into publication.

## Controller call chain for a new authorized run

Work from the current checked-out repository root. First use `node scripts/apa-setup.mjs inspect`; missing/incomplete configuration or unavailable selected dependencies blocks new dispatch and routes to [apa-setup](../../apa-setup/SKILL.md). The [configuration guide](../../../../docs/CONFIGURATION.md) explains the local file. Existing bindings never reload this file on resume. The following uses values from the current approved proposal; it is not a command to dispatch a real paper. `scientificInput` contains `profile: 'reading-first-1.0'`, identity, exact source paths/hashes/byte lengths, the shared context and the six predeclared science artifact IDs. `taskBindings` declares `en`, `zh-CN`, `review`, and `presentation` in reading-editor mode. Predeclare only the authorized repair slots: `en-r2`, `zh-CN-r2`, `review-r2`, and `presentation-r2` for an Editor repair; each value has `task_id`, `task_name`, `owner_actor_id`, `role`, `artifact_id`, `artifact_path`, `native_path`, and `revision`. Declare unique relative native/owned paths and corresponding broker `authorized_bindings` before writing. Use real task/source identities, not placeholders carried into execution.

```js
import { createOwnedArtifactBroker } from './scripts/v3/owned-artifact-store.mjs';
import { buildPreRenderHandoff } from './scripts/v3/workflow-composer.mjs';
import { createLanguageRequests } from './scripts/v3/phase22-language.mjs';
import { renderReaderNotes } from './scripts/v3/phase221-presentation.mjs';
import {
  acceptReadingFirstResult,
  createReadingFirstEnrichmentRequests, createReadingFirstDraftRequests,
  acceptReadingFirstEnrichmentArtifact,
  createReadingFirstPresentationRequest,
  createReadingFirstReviewRequest, createReadingFirstRevisionRequests,
  getReadingFirstState, snapshotReadingFirstRuntime, restoreReadingFirstRuntime,
} from './scripts/v3/reading-first-runtime.mjs';

import {
  prepareConfiguredReading, createConfiguredScienceRequest,
  configuredMineruConfiguration, createConfiguredMineruPort,
  materializeConfiguredReadingCandidate,
} from './scripts/v3/configured-reading.mjs';

const prepared = prepareConfiguredReading({
  repoRoot,
  runId, scientificInput, mainSession, authorizationId, deadline,
  maxCalls, taskBindings, controllerActorId,
  // Only for a new run with explicitly approved enrichment scope:
  enrichmentPolicy, maxTotalCalls,
});
const control = prepared.runControl;
const artifactRoot = prepared.paths.runRoot;
const broker = createOwnedArtifactBroker({
  control_actor_id: controllerActorId,
  artifact_root: artifactRoot,
  authorized_bindings: authorizedBindings,
  run_controls: [control],
});
// For each authorized science role, emit the configured host request:
const scienceRequest = createConfiguredScienceRequest({
  prepared, role, task, dispatchContext: broker.dispatchContext, payload,
});
// Execute scienceRequest.emittedStep through the real host and commit the actual
// native return through its owned broker capability. Repeat only authorized roles.
// Each scientificInput.role_artifacts ID must resolve to its actual owned receipt.
// For an authorized parser packet, bind packet.backend.configuration to
// configuredMineruConfiguration(prepared) and allowed_output_root to
// prepared.paths.parseRoot; execute via createConfiguredMineruPort({prepared,repoRoot}).
const handoff = await buildPreRenderHandoff({
  run: { run_id: runId, workflow_profile: 'reading-first-1.0' },
  dispatchContext: broker.dispatchContext, artifactRoot, scientificInput,
});
const created = createLanguageRequests({
  handoff, runControl: { runId, artifactRoot, dispatchContext: broker.dispatchContext },
});
if (!created.ok) throw new Error(JSON.stringify(created.errors));
const { controller, requests } = created;
```

In source-first mode `requests` initially contains only the source-language Writer. Accept its genuine result, then call `createReadingFirstDraftRequests({controller})` for the other language; its payload binds the accepted `source_view` and receipt. A source-language local repair similarly precedes the counterpart repair through another `createReadingFirstRevisionRequests` call. Do not render or review while either required repair is pending. The configured factory binds `source-first` and reads source language/presentation mode from the saved local choices; low-level compatibility defaults are not new-paper configuration.

An explicitly authorized saved-science revision can provide `scientificInput.adopted_science: [{artifact_root,artifact_id,receipt}]` instead of `role_artifacts`. The handoff reads and verifies the original owned bytes and exact receipts without reissuing scientific roles or minting new science ownership. In that path, `scientificInput.presentation` binds the current layout/resource adaptation separately; it is not a new Integrator scientific result. Use a new finite budget and preserve the closed source run.

For approved active recovery, read [the enrichment guide](../../../../docs/apa-v3/active-gap-enrichment.md). Freeze `enrichmentPolicy: {sources: [], allow_targeted_methods: true}` only when the proposal permits targeted method sources. Set `maxTotalCalls` to the remaining original aggregate allowance after prior scientific calls; `maxCalls` still independently caps Writer/review calls. Omitting enrichment policy preserves the existing source scope. Predeclare required `enrich-initial-evidence|methods|results` and `enrich-late-evidence|methods|results` tasks, using the corresponding existing role, exact native/owned bindings and a task-owned relative `source_root` for newly retrieved snapshots. Do not create all tasks or calls for ordinary details.

Integrator supplies only material unresolved questions through `scientificInput.important_gaps` (or actual science output `important_gaps`), each `{id,question,impact,severity,owner_role,source_kind,source_ids,target_sections}`. Supported source kinds are `original_page`, `cited_method`, `authoritative_method`, `official_method`, and `unreported`; severity is `material` or `minor`. Resolve different methods separately, and merge repeated questions and their target sections. Enrichment-enabled inputs require a unique `id` on every original source as well as its path/hash/byte length. New method sources need not have a known hash before retrieval; admit the actual snapshot through its assigned role output. An additional registered original-page source must identify its `parent_source_id` and `locator` in the existing main source.

If `created.requests` is empty and state is `enrichment_required`, call `createReadingFirstEnrichmentRequests({controller})`, execute those existing-role requests through the same host/owned path, and accept with `acceptReadingFirstResult`. The request carries the assigned questions, permitted sources and compact `Scientific Enrichment` output contract. Once the batch is accepted, `createReadingFirstDraftRequests({controller})` emits the next eligible Writer with the versioned `enrichment_context`; in source-first mode, the counterpart follows acceptance of the first Writer and receives its source_view. If the exact same-run, predeclared role-owned enrichment artifact already exists, use `acceptReadingFirstEnrichmentArtifact({controller,artifactId})`; its earlier production must already be charged to the original budget. Adoption is not authority to manufacture an artifact or obtain free new calls. Dispatch only still-needed role requests; never reissue an unfinished request.

Both Writers must put the useful explanation or concrete limitation into actual prose and return `enrichment_consumption: [{gap_id,section_heading}]` pointing to the corresponding section. This small location map is not semantic proof. The existing overall review reads the same enrichment context and judges whether the explanation works.

The control factory above binds the reading-first Writer/review stage. Six scientific outputs may be committed through their predeclared broker capabilities after actual role returns. When using `runFiniteRoleSequence` with the existing orchestrator, also merge the approved scientific-stage `approved_fingerprints`, `required_artifacts` and `integration_prerequisites` into the same broker run control and matching science run. Keep its legacy chain `pending_resolver`; unused legacy review/approval slots remain unfulfilled, never alias a science artifact as a source-check/approval or request legacy delivery. The new handoff reads the six actual owned receipts directly.

For each returned Writer request, execute exactly its `emittedStep` through the approved host and retain the real task/call/return observation; the emission itself is not execution. After the task has written its assigned native output, call `acceptReadingFirstResult({controller,request,observation,capability})`, where capability is issued by this broker for that request's exact owner/role/owned path/revision. Do not synthesize an observation from the expected arguments or write another role's return. Both accepted Writer outputs are required before rendering:

When the actual host returns its task identity under `task_name`, freeze `hostResultAgentIdPath: ['task_name']` in the control factory before dispatch. The default remains `['agent_id']` for compatible hosts and old bindings. Preserve the raw host return unchanged; this explicit path selects the real returned identity and does not authorize a fabricated identity or relaxed tool-argument correlation.

```js
// In reading-editor mode, after both accepted views:
const editing = prepared.resolvedConfig.reading.presentation_mode === 'reading-editor'
  ? createReadingFirstPresentationRequest({ controller }) : null;
// Execute and accept this one real native/owned editor output before rendering.
// Its payload includes accepted views/receipts, context, sources and the merged
// knowledge/resource presentation. Use that inventory instead of rebuilding it.
let presentation = renderReaderNotes({
  input: { profile: 'reading-first-1.0', controller },
  targetRegistry, existingTargets,
  presentationOptions: { knowledgeRegistry },
});
// Save the same candidate in prepared.paths.candidateRoot before review:
const savedCandidate = await materializeConfiguredReadingCandidate({
  prepared, controller, handoff, resources, targetRegistry, existingTargets,
  presentationOptions: { knowledgeRegistry },
});
// Before the one overall review, perform available, authorized native sampling
// on the saved candidate and record the exact scope and revision (see below).
const request = createReadingFirstReviewRequest({ controller, presentation });
// Execute this one overall request and accept its real native/owned result
// with acceptReadingFirstResult, exactly as for Writers.
let state = getReadingFirstState(controller);
```

`state.status === 'reading_complete'` means this bounded review route completed; the candidate remains `publishable:false` and carries no publication authority. Preserve the exact reviewed `presentation` and use `captureReadingFirstPublicationSource` followed by `prepareReadingFirstPublication` for the [registered publication call chain](../../../../docs/apa-v3/reading-first-publication.md). This read-only preparation may use a completed run after its model-call deadline without extending its budget or repeating roles. It does not certify native display or phase completion. `completed_with_limits` retains material issues or insufficient repair budget and is not a pass. There is no separate legacy `createReaderParityRequest`, `prepareReaderReview` or `assessReaderBilingualParity` call on this route.

### Route a repair to its owner

- Material science/content issue: if `scientific_gap` requires authorized recovery, emit/accept the late enrichment batch first. Call `createReadingFirstRevisionRequests({controller})` for affected Writers, accepting source-language repair before its counterpart. In Editor mode, create/accept `createReadingFirstPresentationRequest({controller})` again after repaired Writer views; the runtime uses `presentation-r2`. Then render the new candidate and issue the one local review.
- Material presentation-only issue: when every material issue is `presentation`, `layout`, `navigation`, `emphasis` or `method-inventory`, use `createReadingFirstPresentationRequest({controller})` directly for the predeclared Editor repair, preserving Writer bytes. Accept, render and locally review.
- Renderer-only correction: the existing `renderRepair:true` branch is available only in Editor mode after exactly one overall review, while state is `reading_complete`, with previously reported minor `layout`, `navigation` or `presentation` issues and a changed rendered fingerprint. Preserve accepted Writers and Editor; render the corrected candidate, then call `createReadingFirstReviewRequest({controller,presentation,renderRepair:true})`. It consumes the same one local review slot, `review-r2` binding, remaining calls and original deadline. An unreported defect or an exhausted slot does not satisfy this branch. Ordinary minor issues do not require a call merely to eliminate them.

After acceptance, read state and verify the actual final bytes against the reviewed candidate. Never loosen the runtime or copy an old verdict to make a second local recheck possible. A user-approved exceptional addendum must retain its own exact scope, real execution and budget; it does not change the default review limit.

Before each actual host call and after each accepted result, save `snapshotReadingFirstRuntime(controller)` through the existing `commitOwnedArtifact` under a predeclared Controller-owned `control` path/revision. Keep the resulting `checkpointReceipt`. On process interruption, recreate the original broker/run binding and handoff, then use `restoreReadingFirstRuntime({handoff,runControl,checkpointReceipt})` rather than initializing a fresh run. Adopt the saved accepted results, original call counters/deadline and already emitted unfinished host steps; correlate/wait for those actual tasks, never reissue them to reset budget. Check the live snapshot/restore exports and save only current owned checkpoint bytes. The receipt and sources must still match the original bindings.

Enrichment records, source versions, merged questions, consumed/existing owned outputs and pending requests are part of that same snapshot. Keep new source files in place for fingerprint validation. Restoration does not reopen source scope, reset either call cap or grant another overall review/local repair round.

The configured factory freezes the selected local choices and resolves follow-main once; the underlying factory rejects `existingBinding`; never use it to reopen an old run. Its `maxCalls` range is 3–6 in compatible Writer-only mode and 4–7 in reading-editor mode. These bounds are not granted calls: the actual proposal fixes the finite cap and deadline, including editing and any repair/local recheck. Science-stage calls and all elapsed time still count against the proposal's actual aggregate limits. Keep ownership/source bindings and read live signatures if implementation changes.

The old C-path junction preserves file access, not seamless runtime recovery: historical Phase22 checkpoints bound physical `artifact_root` to C while the current real path is D, so restore may reject the original binding. Preserve historical source bytes/results and expired budget; any future continuation must use the existing explicit recovery/rebinding approval path, never edit history to manufacture a pass.


### Native observations before the overall review

Save the final candidate and, when authorized and available, sample actual Obsidian behavior before issuing the one overall review: paper-to-knowledge language jumps, overview/back-links, important image crops and full-size links, table orientation/continuations, and formulas. Use the affected subset; do not click every link by default. Record actual candidate paths/revision, observed actions/results and unobserved scope in the existing task record. Let the Verifier reference those observations through the existing supported review-material path; do not invent a runtime field or alter an emitted request. The Verifier attributes Controller observations instead of claiming personal GUI inspection. If native access is unavailable, record `not_run` or `partial` and preserve that limit. See [presentation-and-reading-review.md](presentation-and-reading-review.md).
