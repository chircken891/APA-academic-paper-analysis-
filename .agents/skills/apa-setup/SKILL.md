---
name: apa-setup
description: Inspect, complete, remove, export or import this repository's personal APA configuration through its local static setup page and CLI. Use for APA setup and explicit configuration operations, not paper analysis or dependency installation.
---

# APA 本地配置

在当前目标仓库运行；只管理该仓库忽略的 `config/apa.local.json`。先阅读仓库根目录的 [README](../../../README.md) 配置说明；安装详情见 [SETUP](../../../SETUP.md)。不修改全局设置、安装技能或依赖，不执行论文阅读和发布。

- 查看当前状态：`node scripts/apa-setup.mjs inspect`。仓库个人配置是唯一依据；不从旧机器路径或历史默认值猜答案。
- 查询专用配置：`node scripts/apa-setup.mjs inspect --capability query`。页面的“知识库查询”集中设置模型、默认语言、详略和讲解对象；候选目录与写作指导复用已有字段。普通查询不要求完整阅读配置；详见 [apa-query 配置说明](../apa-query/references/configuration.md)。
- 提供填写页面：`node scripts/apa-setup.mjs page`，打开返回的本地 HTML。页面包含完善配置、去除配置（默认全部，也可指定字段）、导出与差异导入。生成页面可随时进行，不代表用户批准应用其中的操作。
- 应用用户明确要求执行的操作：读取用户提供文件或完整 JSON，核对其动作、字段及预览，然后调用 `node scripts/apa-setup.mjs apply --file <operation.json>`。粘贴 JSON 时暂存至仓库 `.tmp/apa-public-setup/` 的任务文件；不改其指纹或偷偷重建操作绕过 stale 错误。已明确授权的相同范围无需再问一次。操作后的 `inspect` 是回读依据，报告实际缺项和不可用依赖。
- 导出配置备份：`node scripts/apa-setup.mjs export --output <file.json>`。用户指定路径或文件名时遵从其选择；未指定时创建本库长期备份目录 `config/backups/`，保存为 `apa-config-backup-YYYYMMDD-HHmmss-SSS.json`，不覆盖已有文件，不把备份默认放入 `.tmp/` 或其他临时目录。该目录应由 `.gitignore` 排除，不纳入公开工程导出。导出后核验内容与当前配置一致，并返回文件的完整路径。页面下载仍由浏览器决定保存位置；需要助手代为归档时使用上述目录。导出与应用操作是不同格式；导入先由页面展示前后差异，再生成用户选中的明确补丁。未选择、未改变或未提供的字段保持原值。

缺少完整且可用配置会阻断新论文配置运行；已有绑定运行仍消费原冻结配置，不要求重新配置或自动升级。保存不等于安装或实际解析验收；若需要安装，先检测并报告已有项、缺失项、计划目标及影响，再由用户明确选择安装；配置授权不代替安装授权。不要通过改科学规则、发布规则或旧绑定补足配置。
