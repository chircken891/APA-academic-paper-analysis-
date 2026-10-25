# Writing for evidence answers and topics

Use these principles while composing a substantive answer or a newly requested topic/update. A lookup list, status reply or saving an already accepted answer does not need a new writing pass. The user's explicit language, depth and audience requirements determine the output; otherwise use the prepared task's resolved preferences from [configuration](configuration.md). A topic does not require both languages; an update retains its existing language.

## Select existing guidance

Read the selected repository's optional `config/apa.local.json` → `writing_skills` only when detailed writing guidance is useful. Each existing key has `enabled` and, when enabled, `path` to its SKILL.md. Honor disabled entries; do not write configuration or install anything. The query resolver/CLI does not inject these files: this skill applies the chosen guidance within the same current-session answer or native dispatch.

| Configured skill | Apply when useful | Borrow |
| --- | --- | --- |
| `nature-writing` | Developing a new comparison, explanation or topic argument | Question-led organization, paragraph progression, and claim/evidence relationships |
| `nature-polishing` | The user requests refinement, translation or tightening of existing prose | Terminology consistency, accurate academic phrasing and concise transitions |
| `nature-shared` | A selected Nature module references shared guidance | Evidence-calibrated interpretations, methods explanation, and limitations tied to specific claims |
| `humanizer-zh` | Producing or revising Chinese prose | Natural Chinese syntax; remove translationese, empty claims, repeated labels and mechanical transitions |
| `humanizer` | Producing or revising English prose | Specific wording, varied sentence rhythm, and removal of canned openings, forced contrasts or repeated conclusions |
| `stss` | Prose contains stacked hedges or narration about the assistant's own diligence | Remove redundant defenses and process commentary while keeping useful uncertainty and scope |

Open the applicable enabled SKILL.md through its configured path. For Nature, use its manifest to locate only the relevant section/shared fragment, with the [project scientific-writing guide](../../../../docs/apa-v3/scientific-writing-modules.md) as the module map. Use general writing principles for a library answer; select journal-specific rules only for an explicit journal task. Nature skills are third-party guidance, not official journal policy. Resolve companion references relative to the actual installed skill directory; do not hardcode this machine's paths into portable instructions.

An absent optional writing configuration leaves the short principles below available. If an enabled guideline file is unavailable, identify the unavailable guidance briefly when it affects delivery, continue supported retrieval/answering, and use apa-setup only if the user wants that configuration repaired. Do not require full reading setup or pretend the file was read.

## Apply inside the existing task

For a current-session answer, read the relevant guidance and compose the answer directly. For native delegation, preserve the prepared task's prompt and evidence payload, and add only the short applicable writing instructions or readable guide paths to that same dispatch message. Guide files supply writing rules, not new scientific evidence. Do not add unsupported keys to CLI input, alter evidence fingerprints, select another model or start a second task.

Use these skills in embedded mode: return the requested answer or required topic-update JSON, without a separate style diagnosis, before/after draft or editorial report. Keep the prepared task's output schema. Do not import a manuscript workflow, submission package, additional reviewer, or repeated audit loop into a library answer.

For an explicit save of an already accepted answer, preserve its scientific body and meaning; do not silently rewrite it merely to apply style guidance. A requested incremental update may revise the affected explanation using its selected evidence and must retain the actual body/dependency diff.

## Short writing principles

- Lead with the question's answer, then develop the evidence and reasoning in connected paragraphs. Explain what was studied, how the result was obtained, and what it supports under the actual study conditions.
- Organize comparisons around meaningful differences in population, design, measurement, time or outcome. Use tables when these differences benefit from side-by-side reading; avoid forced sections or repeated summaries.
- Keep scientific terminology, numeric conditions, units, uncertainty and attribution. Explain unfamiliar abbreviations in context. Never turn association into causation, a hypothesis into a finding, or a missing result into a negative result.
- Give a limitation where it changes a particular conclusion. Remove generic disclaimers, repeated hedges and internal verification narration that do not help the reader understand the evidence.
- Keep clear headings, selective emphasis, lists, citations, wikilinks and image references when they help reading. Natural prose does not require removing useful Obsidian formatting or adding personal anecdotes.

Check meaning while writing: no invented facts, sources or numbers; no weakened scientific qualifications; no lost citations or broken link targets. This is part of the same composition, not another model call or a claim about passing AI detectors.
