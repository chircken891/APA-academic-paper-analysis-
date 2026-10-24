---
title: "APA Concept Taxonomy"
type: ontology
tags:
  - v3
  - concept
  - taxonomy
---

# APA Concept Taxonomy

APA 概念节点位于 `Wiki/concepts/`，表示跨论文可复用的研究对象或理论构念。论文通过 `studies` 或 `measures` 关系连接概念，关系必须带可解析 Evidence。

## 概念角色

| 角色 | 说明 | 例子 |
| --- | --- | --- |
| `population` | 被研究的人群、地点或时间范围 | older adults、China 1990–2019 |
| `exposure` | 暴露、干预或风险因素 | air pollution、screen time |
| `outcome` | 疾病、行为或其他结局 | colorectal cancer mortality |
| `construct` | 理论或心理社会构念 | resilience、decision fatigue |
| `mechanism` | 解释变量间作用路径的机制 | inflammation pathway |
| `measure` | 有明确定义、尺度或单位的量 | net drift、relative risk |
| `data_source` | 可跨论文复用的数据来源概念 | Global Burden of Disease database |
| `temporal_effect` | 年龄、时期、队列或趋势效应 | age effect、cohort effect |

角色用于消除同名概念的歧义，不替代 `domain`。同一概念可跨多个领域，但定义必须稳定；只对单篇论文成立的结果应保留为 Claim/Knowledge，不升级为 Concept。

## APA 链接要求

- Paper → Concept 使用 `studies` 表示研究对象，使用 `measures` 表示操作化或测量。
- Measure 条目必须说明定义、尺度或单位、解释方式及在论文中的角色。
- 不因旧 v1 笔记存在就自动把它认定为 APA canonical Concept；正式采用前必须经过 APA 发布或明确人工审核。
