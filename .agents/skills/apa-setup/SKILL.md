---
name: apa-setup
description: Detect the current host's own dispatch tool and usable models, then inspect, complete, remove, export or import this repository's personal APA configuration through its local setup page and CLI. Use for APA setup and explicit configuration operations, not paper analysis or dependency installation.
---

# APA 本地配置

在当前目标仓库运行；只管理该仓库忽略的 `config/apa.local.json`。先阅读仓库根目录的 [README](../../../README.md) 配置说明；安装详情见 [SETUP](../../../SETUP.md)。不修改全局设置、安装技能或依赖，不执行论文阅读和发布。

配置页上的模型、推理强度和子代理派发方式不预设固定值，选项来自你对自身环境的检测。所以每次提供配置页或检查配置前，先完成第 1 步。

## 1. 检测自身环境，写成宿主档案

你要报告的是“我此刻能用什么”，不是“APA 过去用什么”或“这个产品一般支持什么”。只写你能在当前会话里核实的内容；核实不了的留空并注明来源为 `unavailable`，不要凭记忆补全。

依次确定：

- **宿主**（`host`）：你运行在哪个环境，如 `codex-desktop`、`claude-code`。依据系统提示或环境说明。
- **当前会话**（`session`）：主会话的模型标识和推理强度。系统上下文或宿主配置里写明了才填，否则填 `null`。
- **派发工具**（`dispatch`）：在你自己的工具列表里找能启动独立子代理的工具。工具定义需要先加载时，先加载再读。记录工具的确切名称，以及以下参数的确切名称。参数名只能取自本会话实际暴露的工具定义；工具源码、文档或其他配置里存在、但本会话的定义中没有的参数，一律视为不存在，只在 `notes` 里说明。宿主收到未知参数时常常静默丢弃，填进去的参数看似有效，实际不起作用。
  - `model_argument`：选择模型的参数。工具定义里没有这个参数、子代理只能沿用主会话时，填 `null`。
  - `effort_argument`：选择推理强度的参数；工具没有这个参数时填 `null`。`model_argument` 为 `null` 时它也必须为 `null`，因为子代理连推理强度也一并沿用主会话。
  - `instruction_argument`：传递完整任务正文的参数。
  - `task_name_argument`：任务名或描述参数；没有则填 `null`。
  - `fresh_context`：怎样保证子代理不继承主会话历史。工具用某个参数控制继承时，填 `{argument, value}`，`value` 是“完全不继承”的取值；新调用本来就从空白上下文开始时填 `null`。不要把会复制主会话历史的分叉方式当作新上下文。

  找不到能独立派发的工具时，`dispatch` 填 `null`。
- **可用模型**（`models`）：只列派发工具实际能接受的模型。`model_argument` 为 `null` 时，派发工具不接受任何模型选择，`models` 填空数组，所有角色只能“跟随主会话”；主会话用的是什么模型，写在 `session` 里。来源按可靠程度依次为：工具定义里的枚举值（`tool-schema`）、用户为本宿主配置的文件（`host-config`，如宿主配置或模型目录文件；只读取，不复制密钥、令牌或认证内容）、宿主官方文档（`host-docs`）。每个模型写出派发工具对它可用的推理强度档位，不支持推理强度时写空数组。档位只能取 `none minimal low medium high xhigh max ultra` 中的值；宿主用别的叫法时，在 `notes` 里写明对应关系，对应不上的不填。无法列举时 `models` 填空数组，来源写 `unavailable`。

检测只能读取，不能调用模型试探可用性，不能安装任何东西，也不能修改宿主设置。把结果写入 `.tmp/apa-setup/host-profile.json`：

```json
{
  "schema_version": "apa-host-profile-1.0",
  "host": "claude-code",
  "detected_at": "2026-10-27T12:00:00Z",
  "session": { "model": "claude-opus-5-5", "reasoning_effort": null },
  "models": [
    { "model": "opus", "reasoning_efforts": [] },
    { "model": "sonnet", "reasoning_efforts": [] }
  ],
  "dispatch": {
    "tool": "Agent",
    "model_argument": "model",
    "effort_argument": null,
    "instruction_argument": "prompt",
    "task_name_argument": "description",
    "fresh_context": null
  },
  "sources": { "session": "system-context", "models": "tool-schema", "dispatch": "tool-schema" },
  "notes": ["Agent 的 model 参数只接受别名；新调用默认不继承主会话。"]
}
```

示例只说明格式，不能照抄；每个值都要来自你自己的检测。档案结构见 `Schema/config/apa-config.schema.json` 的 `hostProfile`，CLI 读取档案时会校验，格式不符就停止。

## 2. 检查当前配置

运行 `node scripts/apa-setup.mjs inspect --host-profile .tmp/apa-setup/host-profile.json`，向用户报告：

- `validation.missing`：缺少的必填项；`dependencies`：不可用的依赖。
- `host_check.host`：已保存的派发方式与这次检测是否一致（`match`、`differs` 或 `not-saved`）。
- `host_check.issues`：已保存的模型选择与本宿主不符的地方，包括模型未检测到、缺少推理强度、不支持所选强度、宿主不能选择模型（`model-selection-unavailable`，需改为跟随主会话）、没有可用派发工具。
- `validation.conflicts`：已保存的派发方式不能选择模型，但仍有角色指定了模型。存在冲突时配置不算完整，新论文运行会被阻止。

提修改建议时，宿主不能选择模型的，把相应角色改成 `{"mode":"follow-main"}`，不要换成另一个具体模型：写进配置的模型名不会被传给子代理，记录的模型就会与实际运行的不一致。

只查询相关配置时使用 `inspect --capability query`；普通查询不要求完整的阅读配置，详见 [apa-query 配置说明](../apa-query/references/configuration.md)。配置文件是唯一依据，不从旧机器路径或历史默认值猜答案。

## 3. 提供配置页

运行 `node scripts/apa-setup.mjs page --host-profile .tmp/apa-setup/host-profile.json`，把返回的本地 HTML 交给用户。页面的“运行宿主与派发”一页可以采用这次检测到的派发方式；各模型项改成从检测结果中选择，推理强度只显示所选模型支持的档位。没有档案时，页面退回手动填写，也无法设置派发方式。生成页面不等于用户批准了其中的任何操作。

## 4. 应用、导出与导入

- 应用用户明确要求执行的操作：读取用户提供的文件或完整 JSON，核对动作、字段和预览，然后运行 `node scripts/apa-setup.mjs apply --file <operation.json>`。用户粘贴 JSON 时，先暂存为仓库 `.tmp/apa-public-setup/` 下的任务文件；不改动其中的指纹，也不重建操作来绕过 stale 错误。已明确授权的相同范围不必再问。应用后再运行一次第 2 步的 `inspect`，以回读结果为准，报告实际的缺项和不可用依赖。
- 导出配置备份：`node scripts/apa-setup.mjs export --output <file.json>`。用户指定了路径或文件名就照办；没有指定时，保存到本库长期备份目录 `config/backups/`，文件名为 `apa-config-backup-YYYYMMDD-HHmmss-SSS.json`，不覆盖已有文件，也不放进 `.tmp/` 或其他临时目录。该目录由 `.gitignore` 排除，不进入公开工程导出。导出后核对内容与当前配置一致，并返回完整路径。页面上的下载由浏览器决定保存位置。
- 导出格式和应用操作格式不同。导入时先由页面展示前后差异，再只为用户选中的项目生成补丁；未选择、未改变或未提供的字段保持原值。

## 边界

宿主档案是你对自身环境的报告，可以用来检查配置是否与当前宿主相符，但不能证明派发真的会成功，也不能证明模型身份；真实派发以实际运行的返回为准。已保存的 `host` 段决定之后新论文运行用哪个工具、哪些参数名派发角色；没有这一段时仍按 Codex 方式派发。已经开始的运行沿用当时冻结的派发方式；换宿主后要重新检测并更新这一段，新运行才会按新宿主派发。

缺少完整可用的配置时，新论文的配置化运行会被阻止；已有绑定的运行继续使用原来冻结的配置，不要求重新配置，也不自动升级。保存配置不等于安装依赖或完成了实际解析验收。需要安装时，先检测并报告已有项、缺失项、计划安装位置和影响，由用户明确选择后再装；配置授权不能代替安装授权。不要通过修改科学规则、发布规则或旧绑定来补足配置。
