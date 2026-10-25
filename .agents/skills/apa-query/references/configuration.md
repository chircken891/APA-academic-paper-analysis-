# Query configuration

Use the sibling [apa-setup skill](../../apa-setup/SKILL.md) to inspect or change the selected repository's optional `config/apa.local.json`. Keep configuration instructions here; the main APA skill only routes to query/setup.

## Available choices

| Setting | Choices and effective default | Use |
| --- | --- | --- |
| `models.query` | Follow current session when absent; or explicit model and reasoning effort supported by the current host | One evidence-answer or selected topic-update task |
| `query.answer_language` | `question` (follow the question, default), `zh-CN`, `en` | Default language for a new answer |
| `query.detail` | `adaptive` (respond to the question, default), `concise`, `detailed` | Default explanation depth; retain consequential conditions and limitations at every depth |
| `query.audience` | `adaptive` (respond to the question, default), `beginner`, `researcher` | Background/abbreviation explanations or professional detail, without changing evidence standards |
| `paths.candidates` | Existing shared repository-contained candidate root | Needed only when explicitly saving or preparing an updated topic candidate |
| `writing_skills` | Existing six enabled/path choices | Applicable Nature, Humanizer and stss guidance inside the same task; see [writing](writing.md) |

Explicit requirements for the current question take priority over saved defaults. For a structured request, pass only the specified overrides as `preferences:{answer_language,detail,audience}`; each key uses the enums above. The query runtime merges omitted keys with saved defaults and records the resolved preferences in the task evidence and input fingerprint. No override writes configuration. With no saved settings, behavior stays question-language and adaptive. Configured values are defaults, not instructions to disregard the user's question.

`topic-update-request` accepts the same optional preference object, but always retains the existing topic's language; detail and audience may affect its new explanation. A language change is a separate requested edit, not an automatic consequence of changing defaults. `topic-save` saves the accepted answer and actual adopted sources; it does not translate, rewrite or start a model task to satisfy new defaults.

## Configure through the existing page

1. Run `node scripts/apa-setup.mjs inspect --capability query`. Query readiness does not prove model availability or require MinerU, science roles or reading paths. Read enabled writing files only when useful for composition; unavailable guidance is reported as described in [writing](writing.md).
2. Run `node scripts/apa-setup.mjs page` and open its returned local HTML. Choose 完善配置 → 知识库查询 for model and answer preferences. Shared candidate paths and writing guides remain in their existing sections. An absent preference displays its default without selecting it for saving.
3. Preserve existing answers. Generate only the selected changes, show their preview, and use apa-setup to apply the exact operation when authorized. Apply uses the original base fingerprint; do not regenerate it to bypass a stale operation. This skill does not write personal configuration as a side effect of a query.
4. 去除配置 can remove selected query fields to restore defaults; its 全部 option removes all configuration answers, including reading settings, so inspect the chosen scope. It does not delete papers or uninstall dependencies. 导出 and difference-based 导入 include query preferences with the existing config; absent imported keys leave current answers untouched.
5. Read back the resulting query inspection. Saving does not install guides or enable unsupported models. Changes affect subsequent preparations; an already prepared task keeps its captured values.

The page and CLI share the existing local schema and operation format. Do not add global settings, automatic saving/publication, background updating, external source expansion, model retries, or another writing/review call as configuration options. These remain explicit task scope and evidence/publication boundaries. For all field and operation details see [repository configuration](../../../../docs/CONFIGURATION.md).
