---
title: "APA V3 Vault Content Policy"
type: ontology
tags: [v3, architecture, content-policy]
---

# APA V3 内容边界

当前版本只执行 V3 工作流。旧论文、原始材料、人工笔记和历史证据保留原文件；它们的存在不构成旧流程兼容入口，也不自动转为当前正式知识。

## 当前内容分类

| 内容 | 边界 |
| --- | --- |
| 原始资料与人工内容 | `Raw/`、`Clippings/`、人工 Markdown 和 Obsidian 配置受保护。 |
| 阅读候选 | reading-first 双语笔记与知识节点可供阅读，仍为 candidate；不能据文件位置或版本号升级为正式发布。 |
| 专题候选 | 仅按用户明确保存要求生成，采用问题语言及实际来源依赖；准备或审阅候选不构成正式提交。 |
| V3 已提交内容 | 由 `.apa-v3/phase22/COMMITTED.json` 选择当前代次，绑定发布批准、对象清单与索引，实际字节通过校验。 |
| 历史材料 | 旧笔记、旧 profile 回执、阶段与评估记录保留真实状态，不默认进入当前索引或图谱。 |
| 派生缓存与临时文件 | 只按其实际来源、归属和精确清理范围处理，不凭扩展名或目录名删除。 |

## 发布、检索与图谱

V3 发布使用当前 schema、语义验证、批准绑定和确定性事务。受支持的输出 profile 包含 `phase22-managed-note-1.0`、`phase22-reader-note-1.0` 与 `reading-first-obsidian-1.0`。reading-first 使用自身真实阅读回执、原样笔记和完整资源清单准备发布，不转换成另一套语言合同；所有 profile 都以已提交代次确认正式身份。详见[最新阅读发布接口](../docs/apa-v3/reading-first-publication.md)。

默认检索和图谱只读取校验通过的已提交 V3 代次；不扫描旧流程笔记、不使用旧缓存、不自动收录 `Eval/`。无提交或绑定失效时明确报告未就绪。旧文件不因此被删除或改写。

方法节点位于 `Wiki/methods/`，概念与测量节点位于 `Wiki/concepts/`。候选和正式节点均需区分论文具体应用与可复用定义，只有经当前合同接纳的 V3 节点可进入正式代次。

专题位于 `Wiki/topics/`，使用独立 `topic_id`、revision 和 `phase24-topic-1.0` 托管 profile，按实际采用的论文 revision、source identity/hash 登记依赖。专题不冒充论文或方法/概念节点，不增加独立论文计数。专题专用 review 接入原发布事务，正文、依赖登记和索引同代次提交；普通查询不生成专题。`Personal Notes` 等人工区保留原字节，不纳入机器正文哈希或检索。默认图谱只纳入当前代次登记的专题路径，候选与历史版本继续排除。

新阅读的原文同语言笔记位于 `Wiki/sources/`，另一语言版本位于 `Wiki/translations/`。目录不决定论文身份：两语仍按同一 paper_id 去重。默认图谱选择当前已提交论文唯一的 `Wiki/sources/` 原文语言笔记，排除 `Wiki/translations/` 译文；历史两语均在 sources 的布局保留中文入口。共享知识与专题继续按已提交清单纳入。已有正式笔记的路径迁移须生成新的受控代次并同步两语互链、知识反链和索引；科学接受回执与历史代次不改写。

## 修改和清理

安装、发布、外部写入与 Git 操作分别按授权执行。清理前确认精确路径、大小和 SHA-256，取得对计划哈希的批准；源文件变化后重新核对，不扩大范围。本次 V2 退役按用户指示使用已有 Git 历史恢复，不另建旧技能的本地备份或新归档。此例外不取消对其他用户文件的保护。

## 入口

- [[Views/indexes/apa-sources|APA 已发布论文]]
- [[Views/graph/apa-only|APA 图谱]]
- [[docs/CONFIGURATION|配置与运行说明]]
- [[Ontology/relation-types|关系语义]]
- [[Ontology/method-taxonomy|方法分类]]
- [[Ontology/concept-taxonomy|概念分类]]
