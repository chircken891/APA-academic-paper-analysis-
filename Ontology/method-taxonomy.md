---
title: "APA Method Taxonomy"
type: ontology
tags:
  - v3
  - method
  - taxonomy
---

# APA Method Taxonomy

APA 方法节点位于 `Wiki/methods/`，由论文的 `uses_method` 关系引用。`Schema/methods/` 仅包含旧架构生成物，不再作为方法权威来源。

## 规范类别

| `category` | 范围 | 例子 |
| --- | --- | --- |
| `study_design` | 抽样、随访、对照和研究设计 | cohort study、ecological study |
| `statistical_model` | 描述数据生成过程或关联结构的模型 | APC model、Cox model、mixed model |
| `estimation` | 参数、效应量或不确定性的估计方法 | inverse probability weighting、bootstrap |
| `hypothesis_test` | 明确原假设与检验统计量的方法 | Wald test、chi-square test |
| `measurement` | 量表、仪器、编码或结局测量程序 | questionnaire、assay、diagnostic rule |
| `data_processing` | 清理、插补、变换和特征工程 | multiple imputation、normalization |
| `qualitative_method` | 访谈、编码和质性综合 | thematic analysis |
| `computational_method` | 算法、机器学习和数值程序 | gradient boosting、path planning |
| `visualization` | 承担分析解释作用的图形方法 | joinpoint plot、effect plot |

方法标题描述可复用程序，不使用单篇论文结论作为方法名。软件名称记录在方法说明中，不把软件本身当作统计方法。新增类别必须先更新本表，避免同义类别并存。

## APA 链接要求

- Paper → Method 使用 `uses_method`，并引用支持该判断的 Evidence。
- Measure 不等同于 Method；量、指标和单位通过 `measures` 关系连接到 Concept/Measure 节点。
- 方法节点只说明可复用定义、步骤、假设和局限，不复制论文的 Key Findings。
