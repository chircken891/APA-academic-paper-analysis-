---
title: "APA Relation Types"
type: ontology
tags:
  - v3
  - relation-types
---

# APA Relation Types

APA paper analyses use only the following controlled predicates. Each relation is a typed edge from the source paper unless a later cross-paper publisher explicitly creates a permitted non-paper source.

| Predicate | Meaning | Allowed domain | Allowed range | Evidence requirement |
| --- | --- | --- | --- | --- |
| `uses_method` | employs a method or instrument | paper, knowledge | method | Required |
| `studies` | investigates a concept or phenomenon | paper | concept | Required |
| `measures` | operationalizes or measures a concept | paper, method | concept | Required |
| `reports` | reports a promoted finding | paper | knowledge | Required |
| `supports` | provides supporting evidence | paper, knowledge | knowledge | Required |
| `contradicts` | provides materially conflicting evidence | paper, knowledge | knowledge | Required |
| `extends` | extends a prior method or finding | paper, knowledge | paper, method, knowledge | Required |
| `replicates` | attempts or reports replication | paper | paper, knowledge | Required |
| `cites` | bibliographically cites | paper | paper | Not required |
| `derived_from` | is generated or synthesized from | knowledge, synthesis | paper, knowledge | Required |

## Evidence rule

Every predicate except `cites` must name at least one resolvable Evidence record. `cites` may be imported from bibliographic tooling without a semantic endorsement.

## 当前合同

以上定义关系的科学语义。具体结构和身份字段以当前 V3 schema 与所用 profile 为准；不要求新 profile 生成旧版 Relation Ledger。
