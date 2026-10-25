---
name: apa-query
description: Search and compare papers already in the current APA knowledge vault, answer research questions with source citations, and save or update requested Obsidian topics. Use for 库内检索、跨论文比较、保存专题、更新专题; use academic-paper-analysis for reading a new paper.
---

# APA Query

Answer the user's question from the current committed APA library. Use the same local entry from Codex or an existing Obsidian agent with local tools; keep the requested language, depth and evidence scope.

## Select the task

| Request | Read only the relevant guidance |
| --- | --- |
| Find papers, compare findings, answer a new research question, or return to original sources | [Query and evidence answers](references/query.md) |
| Explicitly save an existing answer, inspect topic sources, or prepare a selected update | [Topic saving and updates](references/topics.md) |
| Explain evidence in connected prose or write/revise a topic | Also use [Writing guidance](references/writing.md), selecting only applicable enabled Nature, Humanizer and stss guidance in the same task |
| Connect commands or diagnose an interface | [Contracts and tools](references/contracts-and-tools.md) |
| Configure query models, answer preferences, candidate paths or writing guidance | Read [Query configuration](references/configuration.md), then use the sibling [apa-setup skill](../apa-setup/SKILL.md); retain existing choices |
| Read or analyze a new paper | Use the sibling [APA reading skill](../academic-paper-analysis/SKILL.md) |

Locate the selected repository through its `scripts/apa-query.mjs`, `Schema/`, and `config/` files. Respect its `AGENTS.md` and [content policy](../../../Ontology/vault-content-policy.md). Resolve commands from that checkout; public use does not require private planning files. Do not use the historical V2 `query` skill or cache for V3 work.

For a lookup, run `node scripts/apa-query.mjs search --query "short search terms"`. For a configured evidence answer, follow the request/consume/source sequence in [query.md](references/query.md). The skill does not replace the executable contracts.

## Working boundaries

- Search only verified committed V3 content. Different language notes for one paper are one study; a topic is a synthesis, not another paper. No matches means this query found no indexed evidence, not that the idea is false or unstudied. A new idea can start a new question without an existing topic; external research requires the user's requested scope.
- Ordinary lookup and answering are read-only. Saving requires an explicit request and actual adopted sources. Prepare the candidate before seeking its exact publication approval; existing scope authorization persists, and a request to prepare is not approval to commit it.
- Evidence answering and a selected incremental update each use one configured task, in the current session when supported or one native delegation otherwise. Writing guidance is applied inside that task. No automatic model/provider fallback, paper-role chain or extra polishing/review call.
- Related-source hints use existing terms and source relationships without model calls or topic changes. The user selects the sources to update; preserve old revisions and personal notes.
- Cite the papers and actual source locations used. Preserve study conditions, disagreements and uncertainty; distinguish the author's findings from cross-paper inference. Source identity/hash validation alone is not verification of a scientific claim.

Return the requested explanation or usable Obsidian topic with relevant citations and meaningful limitations. Keep internal task records out of the prose. For a saved or updated result, report whether it is a candidate or a committed revision. A pending or failed task retains its actual state.
