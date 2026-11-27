# APA repository

Follow root `AGENTS.md`. Begin with `README.md` and `SETUP.md`. Configure this checkout through the repository `apa-setup` skill; do not invent model, parser or path answers for a new user.

Use `academic-paper-analysis` for reading papers. Use `apa-query` for writing-oriented questions about registered current library content, clues, synthesis, candidate ideas, requested section drafting, and topic or writing-project saving and selected updates. Follow the skill’s current interface availability. Each synthesis, ideation or drafting request uses one configured task in the current session or one supported native delegation. External novelty checks require an explicit request for one idea and a stated budget; saving and formal publication retain their separate intent and exact-approval requirements.

## Claude Code 宿主适配

The `.claude/skills/` entries for these three skills only let Claude Code load them; their single source is `.agents/skills/`. Read the source `SKILL.md` after invoking an entry, and change skill behavior only in `.agents/skills/`.

For a new configured reading, follow that skill's science Controller and recovery instructions. Preserve the original requests, host observations, task handles, accepted receipts and budget; conversation compaction alone is not a process restart. Historical runs are committed read-only evidence; retired bindings are rejected with `READING_BINDING_RETIRED`.

New single-paper and batch readings default to `configured-reading-2.4`. A new run may explicitly select `configured-reading-2.3`. Both profiles use `reading-editor-1.5` to generate a staged research-map Canvas for each language when the user selects Editor. Recover existing 2.2, 2.3 and 2.4 runs and prepared batches under their frozen contracts. New task dispatches use `instruction-path-1.0` and the frozen instruction path verified by the Controller. Read current registered Canvas content and preserve existing node geometry when refreshing through the approved `map-refresh` maintenance entry.

Paper notes explain the authors' actual procedures. In 2.4, retain the important results, comparison conditions, exceptions and authors’ explanations from each accepted module. Editor 1.5 combines the principle, its use in the paper and links to the relevant sections and registered knowledge node in each numbered, expanded section 3.1 entry. Shared nodes explain reusable methods, conditions and limits, with independent teaching examples where useful. Their paper indexes link to the sections that explain each application.

Single-paper and batch publication share the serial queue. Save approval under each run's `publication/` before waiting for the consumer lock; the waiting session enqueues and drains when it acquires the lock. Wait for live publication-lock owners and continue automatically with a new post-dry-run maintenance window. Follow `AGENTS.md` for exact `user_corrections`; report unsupported inputs without temporary bypass scripts.

The user may clear the default installation selections for MinerU, its global launcher, Better Embedded Canvas and companion writing skills. Report the available and missing items, targets and effects before installing the final selection. See `AGENTS.md` for the shared setup rules.
