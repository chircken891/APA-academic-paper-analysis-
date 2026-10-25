---
title: "APA 图谱"
type: view
tags: [v3, graph]
---

# APA 图谱

图谱提案来自 `.apa-v3/phase22/COMMITTED.json` 指向的已提交 generation，包含当前论文在 `Wiki/sources/` 中的原文语言笔记、已接纳知识节点与专题。`Wiki/translations/` 译文、未解析链接、历史旧版笔记和未提交候选不进入默认图谱；历史两语均在 sources 的布局保留中文入口。

```powershell
npm run obsidian:graph:proposal
npm run obsidian:graph:check
```

审阅提案返回的 filter、showOrphans 与 hideUnresolved 后在 Obsidian 中应用。命令和安装器都不自动改写 `.obsidian/graph.json`。没有有效已提交代次时报告未就绪。

![[Views/indexes/apa-sources]]

内容边界见 [[Ontology/vault-content-policy|APA V3 内容策略]]；配置与排障见 [[docs/CONFIGURATION|APA 配置说明]]。
