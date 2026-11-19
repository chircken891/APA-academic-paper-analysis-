Prepare one bilingual reading presentation from the accepted original-language Writer view and its Translation. The request supplies the actual `views`, their `view_receipts`, the registered `presentation` and `output_schema` (`reading-editor-1.5`). Read the accepted paragraphs and the relevant admitted catalog before choosing placements. Keep every scientific paragraph, both original abstracts and their source wording. Presentation additions belong to separately versioned metadata. If a scientific explanation is missing, identify its section and the responsible role for the existing overall review.

Use one short linked paragraph per language to identify the research question, the study route, the consequential methodological choice and the main finding. Return this paragraph as one entry in the `overview` array. Preserve uncertainty and the paper's attribution. Highlight a few consequential conditions or distinctions in the prose. Add concise topic phrases only where the subject changes within a long section. The renderer shows them as bold lead-ins and keeps the table of contents expanded. Use supplied section identities for navigation. Do not insert manual numbers or links into headings.

The renderer shows these seven module titles in order.

| English | 中文 |
| --- | --- |
| Abstract | 摘要 |
| Research question and design | 研究问题与设计 |
| Research process and methods | 研究过程与方法 |
| Findings | 主要发现 |
| Discussion | 讨论 |
| Limitations | 局限 |
| Conclusions and implications | 结论与实践含义 |

Prepare the expanded, numbered Methods and concepts index at 3.1 in both languages. Include the methods the body actually explains, including a paper-specific measurement, sampling or decision rule where useful. Use each method's stable ID. Order the entries by their first substantive use across the paper body and use paragraph order within a section. Put the first substantive use first in `section_ids`, followed by other explanatory sections in paper reading order. A method may link both to its procedure in Methods and to the interpretation of that procedure in Findings. A chart type first explained in Findings can link directly there. For each new entry, provide `explanation` as a short explanation of the supported principle, and `application` as a concise statement of the purpose of its use in this paper. The renderer displays these as Principle and Use in this study, followed by links to the explanatory sections and any confirmed knowledge node. Keep the study's detailed procedure, parameter values, findings and consequential limitations in the accepted paper body.

Match method IDs, their order, section references and any linked knowledge IDs across languages. Link only IDs supplied by the catalog. Use an omitted or empty `knowledge_ids` list for a paper-specific method with no confirmed shared node. An index can be empty for an article with no registered research steps and no method use to index. Chart encodings belong beside their figures. Use the admitted chart type and existing figure-reading paragraphs. If an essential chart explanation exists only in the catalog, report that location for the Writer. Keep the original caption complete beside its visual.

Return this JSON shape using the supplied `views_fingerprint`, which can be verified with `readingFirstViewsFingerprint`.

```js
{
  schema_version: 'reading-editor-1.5',
  views_fingerprint,
  argument: {
    question: {text: {en, 'zh-CN': zh}, section_id},
    claims: [{id, title: {en, 'zh-CN': zh}, evidence: {en, 'zh-CN': zh},
      limit: {en, 'zh-CN': zh}, section_id, branch_id, finding_ids: ['registered-finding-id']}],
    branches: [{id, name: {en, 'zh-CN': zh}}],
    relations: [{from: 'question', to: 'claim-id', label: '提出问题'},
      {from: 'claim-id', to: 'conclusion', label: '结果整合'}],
    conclusion: {text: {en, 'zh-CN': zh}, section_id},
    stage_map: {
      stages: [{id: 'model', title: {en, 'zh-CN': zh}, entry: {en, 'zh-CN': zh},
        step_ids: ['registered-step-id'], claim_ids: ['claim-id']}],
      transitions: [], // When several stages connect: [{from: 'stage-id', to: 'stage-id', label: {en, 'zh-CN': zh}}]
      step_text: {'registered-step-id': {en, 'zh-CN': zh}},
      finding_text: {'registered-finding-id': {en, 'zh-CN': zh}},
    },
  },
  primary_finding_ids: ['registered-finding-id'],
  languages: {
    en: {
      overview: [{text, section_ids: ['registered-section-id']}],
      sections: [{section_id, takeaway,
        emphasis: [{paragraph_index: 0, text: 'exact existing fragment'}],
        subheadings: [{before_paragraph: 2, heading: 'Specific topic'}]}],
      methods: [{id, title, explanation, application,
        section_ids: ['method-section-id'], knowledge_ids: ['registered-knowledge-id']}],
      visuals: [{id: 'registered-visual-id', title: 'Figure 1 Short title',
        notes: [{section_id: 'registered-section-id', paragraph_index: 3}]}],
    },
    'zh-CN': {overview: [], sections: [], methods: [], visuals: []},
  },
}
```

Populate both language objects. Link each overview entry to at least one accepted section. Include editorial section entries only where they help presentation. Omit the abstract from these entries. Within each entry, `takeaway` is optional. `emphasis` and `subheadings` are arrays and may be empty. Paragraph indexes are zero-based. Each emphasized phrase must be an exact, unique, contiguous span of plain prose in its paragraph. Keep spans outside formulas, code, links, existing markup and other selected spans. Keep the overall paragraph available. A subheading applies before the indicated paragraph. Use each section and each subheading position once.

Give visuals short labels with their original figure or table number where useful. For a figure-reading note, reference a non-first paragraph of the section where that figure is placed in that language. Select paragraphs without subheadings, at most once per paragraph. The renderer moves the paragraph beside the corresponding visual and retains the original caption. It displays links to the original page and full-size visual. Omitted visuals retain their registered labels.

Create one bilingual argument for the research map. The renderer draws all steps, findings, step-to-finding relationships and step-to-step transfers from the admitted map. Build the argument from the actual accepted prose, using a research question, up to eight supported claims grouped into named branches, and a qualified conclusion. A short commentary with no distinct intermediate claim may use empty `claims` and `branches` and connect the question directly to the conclusion with its supported relationship. Give each claim a specific section present in both views, a brief evidence statement and its applicable limit. When the prose supplies no distinct limit, put an empty string in each language. Keep association, intervention and mechanistic support distinct.

Assign every registered finding to exactly one claim. A design or limitations claim can leave `finding_ids` empty. Select consequential findings by unique registered ID in `primary_finding_ids`. Use unique IDs for claims and branches, with `question` and `conclusion` reserved for the terminal cards. List branches and claims in reading order and use each named branch.

Connect claims to form directed acyclic paths from the question to the conclusion. Use one relation per ordered pair. Choose the most specific supported label from 提出问题, 机制推进, 体内检验, 干预检验, 人体旁证, 设计推导, 证据补充, 结果对照, 范围限定 and 结果整合. The renderer uses the matching English label for the English map. A procedure may contain an iterative loop recorded in the admitted steps. That loop belongs to the study workflow, while the argument links explain how the evidence supports the conclusion.

When the request supplies `staged_research_map: true`, return `argument.stage_map` as shown. Organize stages around the paper's actual tasks or comparisons. Put the concrete question, input or changed condition in each `entry`. Assign every registered step and every claim to exactly one stage. Findings belong to their claims' stages. A preparation stage may contain only steps; a stage explaining the evidence or a specific limitation may contain only claims. Stable stage IDs start with a lowercase letter and may contain lowercase letters, digits and hyphens. Reserve `question` and `conclusion` for the terminal cards. Use the source-supported order as the stage array's reading order. If the paper has neither steps nor claims, supply empty `stages`, `transitions`, `step_text` and `finding_text` collections. When the request omits the flag, follow the stage structure of the prior output during repairs, or omit this field for an earlier binding without that structure.

Each directed stage transition states the specific material, model, rule, changed condition or unresolved question that leads from one phase to the next. Support the same direction through an admitted step transfer, a step-to-finding link, or a claim-to-claim relation grounded in the prose. Every dependency that spans stages must have a direct or indirect path of stage transitions. Use one transition per ordered pair and keep the phase graph acyclic. Where the paper documents an iterative return, keep the forward phase path and show the return through the admitted step links. Place the whole loop in one phase where appropriate. Independent branches may start from the same research question and reach a shared conclusion without arrows between them. A methods paper may progress from a baseline to a comparison under changed conditions. An empirical study may share a model or sample across parallel validation tasks. Follow the paper's evidence path in either case. A caption such as “Synthesis” alone leaves the handoff unexplained.

Use `step_text` and `finding_text` as records keyed by every registered step and finding ID. Supply both languages for each value. For a step, give the actual input, operation and what was passed on when the prose reports it. For a finding, state the decisive observation with context such as the comparison, denominator, condition or uncertainty that changes its meaning. Use the accepted prose to write short stand-alone explanations in both columns. The admitted step and finding cards link to their accepted sections. Keep one map for the two languages, with the same stages, placements and connections.

Write brief, plain single-line map fields within these English and Chinese character limits.

| Field | English | 中文 |
| --- | --- | --- |
| Question | 240 | 120 |
| Claim title | 180 | 90 |
| Evidence | 260 | 130 |
| Limit | 220 | 110 |
| Branch name | 64 | 32 |
| Conclusion | 300 | 150 |
| Stage title | 96 | 48 |
| Stage entry, transition, step text, finding text | 240 | 120 |

Use only the declared output. Run deterministic Editor validation through Controller before returning the result. The existing overall review sees the rendered bilingual notes and may route a local correction to its owner. For a scoped repair, start from `prior_editor`, use the supplied material issues and change only the specified fields and entities. The `map` repair field governs `argument` and `primary_finding_ids`. Keep other fields intact and report an unresolved scope to Controller.
