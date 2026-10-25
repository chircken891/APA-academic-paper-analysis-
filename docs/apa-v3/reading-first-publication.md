# 最新阅读结果的 V3 发布

最新 APA 阅读结果沿用 `reading-first-obsidian-1.0` 的笔记结构，接入既有 V3 发布事务。正文、Reading Editor 的布局、双语共享知识和登记资源一起进入发布审阅，不转换为另一套 Writer 或 reader-note 输出，也不追加科学角色或模型审查。

## 从阅读完成到发布审阅

Controller 保留已接受整体审查所对应的原 `presentation` 对象，以及真实 Writer、Reading Editor 和 Verifier 的 owned 回执。`reading_complete` 表示可以准备发布审阅；阅读候选本身的 `publishable:false` 不授予写入正式库的权限。实质问题未解决、缺少关键审查或内容已改变的结果不能进入发布准备。

```js
import { captureReadingFirstPublicationSource } from '../../scripts/v3/reading-first-runtime.mjs';
import { prepareReadingFirstPublication } from '../../scripts/v3/reading-first-publication.mjs';
import { registerBilingualPublication } from '../../scripts/v3/phase22-publication.mjs';

// controller 与 presentation 来自本次已接受的真实阅读运行。
const source = await captureReadingFirstPublicationSource({ controller, presentation });
const prepared = await prepareReadingFirstPublication({
  source,
  vaultRoot,
  generation,
  evidenceMode: 'actual',
  resources,
});
const registration = await registerBilingualPublication({
  vaultRoot,
  run: prepared.plan.run_id,
  plan: prepared.plan,
  sourceInputs: prepared.sourceInputs,
});
```

这里的 `resources` 是 `{path, source_path, sha256, byte_length}` 数组：`path` 为笔记使用的 `Raw/` 或 `Figures/` 库内相对路径，`source_path` 指向已登记源文件，哈希带 `sha256:` 前缀。资源路径集合必须与审阅候选的 `assetPaths` 完全一致。PDF、图片均须保留来源与指纹；资源缺失、字节变化或目标处存在不同的原始文件时，先修正具体绑定。不能通过扫描目录自动收录未登记文件。合成测试使用 `evidenceMode:'synthetic'` 及系统临时库，不能写入生产知识库。

图表也可来自 Integrator 的真实 owned 输出：若其已审查 `visual_resources` 精确登记了图表路径、SHA-256、字节数以及父 PDF 的 `source_id`、`source_path`、`source_sha256`，发布接口会核对这些冻结字段与当前资源、登记 PDF 的对应关系。仅在临时目录找到图片或调用方另给一个哈希仍不足以入库；原候选和原审查不因此改写。

准备阶段校验原审查、文件与人工区域，构建完整清单和索引；注册保存可重载的运行配方与控制记录，不执行正式笔记写入。保留返回的 Controller trust anchor，跨进程读取时通过现有 `trustAnchor` 参数或 `APA_V3_PUBLICATION_TRUST_ANCHOR` 传递，不从待验证的注册文件自取信任锚。

已审查候选若复用了带 V2 元数据的既有共享节点，默认仍拒绝发布。用户明确批准这些具体节点的迁移后，可向准备接口传入 `knowledgeMetadataMigrations`，每项必须精确给出 `{path, before_sha256, candidate_sha256, output_sha256}`。适配仅把 YAML 头中的 `pipeline_version: 2.0.0` 改为字符串 `"3.0"`、`graph_scope: v2-canonical` 改为 `v3-candidate`；正文、原候选及科学审查指纹保持原样。原文件、已审查候选、转换输出三组字节都必须命中；转换记录进入发布写入清单和批准哈希，并在注册重载时重新验证。此参数本身不授予发布权限，也不允许迁移其他旧结果、改正文或跳过 V3 校验。

已完成阅读运行可以在模型调用窗口关闭后只读准备发布；这不续期模型预算。注册重载重新读取原始 owned 证据并重建输出，不能只凭一份自报“完成”的 JSON 或被修改的 Markdown 创建发布资格。

## 审阅、批准与事务

审阅返回的完整文件清单、`review_hash` 与 `output_inventory_hash`。共享知识的新建和增补、原始资源的新增，以及保留的人工内容都应能在这份清单中核对。已存在的知识节点沿用稳定身份和路径，两语论文共用同一节点。

实际写入沿用 `registerBilingualPublication`、`applyBilingualPublication` 与 `recoverBilingualPublication` 的现有批准记录、维护窗口和两个精确哈希。没有批准时，`review` 和 `dry-run` 可用于检查，`apply` 拒绝执行。当前 CLI 不承担论文模型派遣，也不接受随意的候选 JSON 作为已注册运行。

```powershell
node scripts/v3/bilingual.mjs review --vault-root <vault-root> --run <run> --profile reading-first-obsidian-1.0
node scripts/v3/bilingual.mjs dry-run --vault-root <vault-root> --run <run> --profile reading-first-obsidian-1.0
```

具体批准字段及恢复参数以 [发布 API](../../scripts/v3/phase22-publication.mjs) 与 [CLI](../../scripts/v3/bilingual.mjs) 为准。更换来源、改动审阅内容或出现并发文件变化后，原批准不再对应新输出；应重新准备并核对实际差异，不改旧回执或跳过检查。

## 发布后的索引与图谱

事务成功后，`.apa-v3/phase22/COMMITTED.json` 选择新代次。默认检索读取该代次中的中英文论文与共享知识内容，命中链接落到实际标题或块；图谱收录中文论文入口及共享节点。新增一篇论文或增补同一个知识节点时，其他已提交论文继续保留。

只放入 `Wiki/`、只改 `status` 或版本字段，均不建立已提交身份。未提交候选不进入默认检索和图谱。人工笔记不进入机器生成内容的索引，重发时保留；管理区或来源出现冲突时报告具体冲突。

阅读内容审查、发布事务与 Obsidian 原生显示检查分别记录。没有真实原生观察时仍为 `not_run`，发布不会将其改成通过；已接受的普通限制也不会因此消失。

## 已提交笔记的路径整理

新未绑定运行按原文语言分放：`Wiki/sources/` 保存原文同语言稿，`Wiki/translations/` 保存另一语言稿。旧绑定不自动重渲染或改变目标注册。

已提交 reading-first 笔记可在明确授权后使用 `buildNoteRelocationReview({vaultRoot, runId, generation, papers:[{paperId, sourceLanguage}]})`。该适配只接受当前有效提交，确定性改写链接目标、两语路径及相应清单/索引，不接受调用方正文或新的科学批准；`phase22-note-relocation-1.0` 审查与每篇manifest的 `path_migration` 明确记录其来源。科学依赖和原接受回执保留，不能把整理结果称为重新阅读或新的语言生产。

将此owned review交给既有 `dryRunBilingualPublication`，按具体清单与两个哈希形成批准及维护窗口，然后调用 `applyBilingualPublication`。本路径不重放旧语言运行、不使用旧注册重新签发阅读资格；它使用当前Controller的内存计划，执行前保存 `prepareBilingualPublicationTrustAnchor` 返回的公钥信任锚。中断时沿用 `recoverBilingualPublication` 的磁盘日志、精确批准与该信任锚。尚未开始或回滚后重新准备仍需核对同一明确授权范围。

提交事务自动保留上一代次的完整历史副本；旧可见路径不会被发布器删除。只有确认新代次、原文及历史副本有效后，才按精确旧路径/哈希清单将已退出当前代次的旧文件移到本次获批恢复目录。遇旧文件变化或目标占用时停止该项，不能覆盖人工修改。最后同步已获批图谱筛选并检查两语导航、知识反链与检索结果。普通查询和候选渲染均不执行迁移。
