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

准备阶段校验原审查、文件与人工区域，构建完整清单和索引；注册保存可重载的运行配方与控制记录，不执行正式笔记写入。保留返回的 Controller trust anchor，跨进程读取时通过现有 `trustAnchor` 参数或 `APA_V3_PUBLICATION_TRUST_ANCHOR` 传递，不从待验证的注册文件自取信任锚。

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
