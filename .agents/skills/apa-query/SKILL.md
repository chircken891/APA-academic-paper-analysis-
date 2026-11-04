---
name: apa-query
description: Find research clues, synthesize themes and shared knowledge, propose research ideas, and support writing from the current APA vault with traceable evidence. Use for 库内检索、找线索、找共同点、跨论文比较、有什么创新点、帮我写相关工作、写作项目、保存专题、更新专题; use academic-paper-analysis for reading a new paper.
---

# APA Query

Turn the current content of registered APA notes into research clues, shared themes, candidate ideas and writing-ready arguments. Synthesis and ideation include usable scholarly wording by default; draft a complete section when requested. Saved edits to registered Wiki prose are effective immediately; published receipts retain their historical meaning. Use the same local entry from Codex or an existing Obsidian agent with local tools; keep the requested language, depth and evidence scope.

## Select the task

| Request | Read only the relevant guidance |
| --- | --- |
| Find papers, compare findings, answer a new research question, or return to original sources | [Query and evidence answers](references/query.md) |
| Find common themes, trace a concept, interpret connections, or build a knowledge map | [Knowledge maps and synthesis](references/synthesis.md) |
| Propose research ideas or explicitly check one idea against external literature | [Ideation and novelty](references/ideation.md) |
| Maintain a writing project, draft a section, request reviewer comments, or export references | [Writing projects](references/writing-project.md) |
| Explicitly save an existing answer, inspect topic sources, or prepare a selected update | [Topic saving and updates](references/topics.md) |
| Explain evidence in connected prose or write/revise a topic | Also use [Writing guidance](references/writing.md), selecting only applicable enabled Nature, Humanizer and stss guidance in the same task |
| Connect commands or diagnose an interface | [Contracts and tools](references/contracts-and-tools.md) |
| Configure query models, answer preferences, candidate paths or writing guidance | Read [Query configuration](references/configuration.md), then use the sibling [apa-setup skill](../apa-setup/SKILL.md); retain existing choices |
| Read or analyze a new paper | Use the sibling [APA reading skill](../academic-paper-analysis/SKILL.md) |

Locate the selected repository through its `scripts/apa-query.mjs`, `Schema/`, and `config/` files. Respect its `AGENTS.md` and [content policy](../../../Ontology/vault-content-policy.md). Resolve commands from that checkout; public use does not require private planning files. Do not use the historical V2 `query` skill or cache for V3 work.

The map, synthesis, ideation and external-novelty interfaces are implemented. Preparation, deterministic validation and synthetic tests remain separate from real model/network acceptance. Check the writing-project reference for its current implementation status.

For a lookup, run `node scripts/apa-query.mjs search --query "short search terms"`. For a configured evidence answer, follow the request/consume/source sequence in [query.md](references/query.md). The skill does not replace the executable contracts.

## Working boundaries

- Search current Markdown within the verified registered V3 inventory. Use returned current paths, anchors and content hashes; preserve partial-result diagnostics and independently checked source identities. Old review receipts do not certify later edits. Different language notes for one paper are one study; a topic is a synthesis, not another paper. No matches means this query found no indexed evidence. A new idea can start a new question without an existing topic. Describe library synthesis as library synthesis. External novelty checking requires explicit approval for one concrete idea, its sources and search/call budget; ordinary requests do not expand the literature.
- Ordinary lookup and answering are read-only. Saving requires an explicit request and actual adopted sources. Prepare the candidate before seeking its exact publication approval; existing scope authorization persists, and a request to prepare is not approval to commit it.
- Each answer, synthesis, ideation, section draft, reviewer-comment request or selected incremental update uses one configured task, in the current session when supported or one native delegation otherwise. Writing guidance is applied inside that task. No automatic model/provider fallback, paper-role chain or extra polishing/review call.
- Related-source hints use existing terms and source relationships without model calls or topic changes. The user selects the sources to update; preserve old revisions and personal notes.
- Never invent sources or numbers. Distinguish no evidence found in this library from evidence of absence. Cite the papers and actual source locations used. Preserve study conditions, disagreements and uncertainty; distinguish the author's findings from cross-paper inference. Source identity/hash validation alone is not verification of a scientific claim.

Return the requested explanation or usable Obsidian topic with relevant citations and meaningful limitations. Keep internal task records out of the prose. For a saved or updated result, report whether it is a candidate or a committed revision. A pending or failed task retains its actual state.
