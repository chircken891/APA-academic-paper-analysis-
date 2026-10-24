# APA project rules

- Work from this repository root. Keep task scratch files below `.tmp/<task>/`.
- Read root `README.md`, `SETUP.md`, and `docs/CONFIGURATION.md` before first use. Use the repository `apa-setup` skill to inspect or change personal configuration.
- Personal configuration belongs only in ignored `config/apa.local.json`. A public export deliberately contains no personal answers. Missing required settings block a new configured reading; existing bound runs keep their frozen configuration.
- Before any installation, produce a read-only report of available and missing prerequisites, exact selected targets and expected effects. Install only after the user explicitly authorizes that selection.
- Preserve source files, human notes, evidence and unrelated changes. Reading candidates do not authorize publication. Dependency installation, external writes, publication and Git operations require explicit user authorization.
- Use the V3 reading-first workflow and its source/evidence boundaries. Deliver coherent bilingual Obsidian notes. Keep scientific limits and unresolved issues visible; synthetic tests do not establish real-paper acceptance.
- Put reusable modules in `scripts/`, tests in `test/`, documentation in `docs/`, sources in `Raw/`, final authorized notes in `Wiki/`, and assets in `Figures/`. Method nodes belong in `Wiki/methods/`.
- Run the smallest relevant tests. Report changed files, validation and remaining limitations. Do not install dependencies or make global changes as a side effect of configuration.
