# APA repository

Follow root `AGENTS.md`. Begin with `README.md` and `SETUP.md`. Configure this checkout through the repository `apa-setup` skill; do not invent model, parser or path answers for a new user.

Use `academic-paper-analysis` for reading papers and `apa-query` for questions about committed library content, topic saving and selected updates.

## Claude Code 宿主适配

The `.claude/skills/` entries for these three skills only let Claude Code load them; their single source is `.agents/skills/`. Read the source `SKILL.md` after invoking an entry, and change skill behavior only in `.agents/skills/`.

For a new configured reading, follow that skill's science Controller and recovery instructions. Preserve the original requests, host observations, task handles, accepted receipts, budget and deadline; conversation compaction alone is not a process restart. Historical runs are committed read-only evidence; retired bindings are rejected with `READING_BINDING_RETIRED`.
