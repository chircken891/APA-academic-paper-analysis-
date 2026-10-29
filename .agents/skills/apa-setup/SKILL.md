---
name: apa-setup
description: Use for APA configuration requests such as 完善配置、为我配置、为某某 agent 配置, which require opening the local HTML for user selection, and for explicit inspection, export or removal, which do not require the page. Not for paper analysis or dependency installation.
---

# APA 本地配置

在用户选定的目标仓库运行；只管理该仓库忽略的 `config/apa.local.json`。先阅读仓库根目录的 [README](../../../README.md) 配置说明；安装详情见 [SETUP](../../../SETUP.md)。不修改全局设置、安装技能或依赖，不执行论文阅读和发布。

配置页上的模型、推理强度和子代理派发方式不预设固定值，选项来自你对自身环境的检测。先遵守第 0 步的目录和选择边界，再完成第 1 步的检测。

## 0. 用户选择目录与配置

选择项目位置时，提醒用户优先使用剩余容量充足的硬盘，为 PDF、解析图文、运行记录、笔记及所选本地环境预留增长空间。容量建议不替代用户对目录的选择，不预设盘符或仓库名称。

首次获取项目时，在克隆、解压、安装或任何配置准备写入前，必须让用户指定或明确确认项目文件夹的绝对路径。当前会话目录及其子目录不是默认目标；即使只有一个候选目录，也须用户确认。建议用户将选定的文件夹设为 agent 工作目录。已有工程使用用户明确选定的根目录；同一会话已确认的目标不重复询问。后续命令从该目录执行，并为本技能的 CLI 显式传入 `--repo-root "<用户确认的项目绝对路径>"`；本文相对路径均相对此目录。

**禁止代理自主完成配置选择。** 安装请求或“帮我配置”“你决定”“全部按推荐”均不能代替用户选择。可以只读检测并报告建议；检测结果、历史默认值、示例、推荐值以及唯一可用选项都不是用户答案。宿主档案仅记录检测事实；采用其派发方式写入个人配置仍须用户选择。不得自行生成一套默认答案后直接 apply、直接编辑 `config/apa.local.json`，或替用户操作页面制造选择与确认。

用户确认项目路径并同意将其作为 agent 工作目录后，三个 APA 技能应嵌入该目录的 `.agents/skills/`；工程自带的完整目录直接使用。三个技能为 `academic-paper-analysis`、`apa-query`、`apa-setup`，默认不安装到全局。若用户不打算采用该工作目录，或不愿将技能迁入项目作用域，须明确提醒技能发现和项目规则的作用范围可能变化，保留全局加载方式可能影响日常其他任务；后续仍固定使用已确认项目路径。已有全局副本的迁移或移除须单独确认。

**配置类请求必须打开 HTML。** 使用本技能时，“完善配置”“为我配置”“帮我配置”“为某某 agent 配置”等新建、完善、修改或导入配置请求，一律先完成第 3 步的问题处置，再执行第 4 步，生成并打开配置页供用户自主选择。会话内解释选项不能替代页面，也不能因为用户说“你决定”“全部按推荐”跳过页面。仅检查、自检、导出配置、挖空或去除配置不强制打开 HTML；去除范围仍须明确。用户已自行选择并提交完整操作且明确要求应用时，按第 5 步核对和应用，无需重新选择。

未选择项保持未配置或原值；用户只完成部分选择时，仅保留这些选择，提示回到页面补充或按用户要求暂缓。不得为达到 `ready` 补齐。已有明确配置不重新强制选择，修改时只处理拟改变的字段；换宿主或出现不兼容时，说明限制并等待用户在页面选择，不自动修复答案。

## 1. 检测自身环境，写成宿主档案

你要报告的是“我此刻能用什么”，不是“APA 过去用什么”或“这个产品一般支持什么”。只写你能在当前会话里核实的内容，不要凭记忆补全。“未知”是调查之后的结论，不是起点：留空或填 `unavailable`、`unknown` 之前，先按下文“调查来源”逐类查过并记录。

依次确定：

- **宿主**（`host`）：你运行的环境标识，依据系统提示或环境说明。
- **当前会话**（`session`）：主会话的模型标识和推理强度。系统上下文或宿主配置里写明了才填，否则填 `null`。
- **派发工具**（`dispatch`）：在你自己的工具列表里找能启动独立子代理的工具。工具定义需要先加载时，先加载再读。记录工具的确切名称，以及以下参数的确切名称。参数名只能取自本会话实际暴露的工具定义；工具源码、文档或其他配置里存在、但本会话的定义中没有的参数，一律视为不存在，只在 `notes` 里说明。宿主收到未知参数时常常静默丢弃，填进去的参数看似有效，实际不起作用。
  - `model_argument`：选择模型的参数。工具定义里没有这个参数、子代理只能沿用主会话时，填 `null`。
  - `effort_argument`：选择推理强度的参数；工具没有这个参数时填 `null`。`model_argument` 为 `null` 时它也必须为 `null`，因为子代理连推理强度也一并沿用主会话。
  - `instruction_argument`：传递完整任务正文的参数。
  - `task_name_argument`：任务名或描述参数；没有则填 `null`。
  - `fresh_context`：怎样保证子代理不继承主会话历史。工具用某个参数控制继承时，填 `{argument, value}`，`value` 是“完全不继承”的取值；新调用本来就从空白上下文开始时填 `null`。不要把会复制主会话历史的分叉方式当作新上下文。

  找不到能独立派发的工具时，`dispatch` 填 `null`。
- **可用模型**（`models`）：只列派发工具实际能接受的模型。`model_argument` 为 `null` 时，派发工具不接受任何模型选择，`models` 填空数组，所有角色只能“跟随主会话”；主会话用的是什么模型，写在 `session` 里。来源按可靠程度依次为：工具定义里的枚举值（`tool-schema`）、用户为本宿主配置的文件（`host-config`，如宿主配置或模型目录文件；只读取，不复制密钥、令牌或认证内容）、宿主官方文档（`host-docs`）。每个模型写出派发工具对它可用的推理强度档位，不支持推理强度时写空数组。档位只能取 `none minimal low medium high xhigh max ultra` 中的值；宿主用别的叫法时，在 `notes` 里写明对应关系，对应不上的不填。无法列举时 `models` 填空数组，来源写 `unavailable`。

重复自检时，先读取当前项目已保存配置、归属明确的旧宿主档案，以及 `config/backups/<owner>/` 中的自有适配说明和入口；旧档案按其已知路径读取，不按时间最新一份直接认定归属。核对当前工具定义、宿主版本、实际生效设置与入口是否变化。有效的自有补丁继续复用，将仍有效的 `capabilities`、`achievement` 和 `adapters` 声明及来源纳入本次档案；仅针对变化、缺失或失效项补充调查，必要时新建独立补丁。不得因再次自检而丢弃已有成果、重复安装或从头重建全部适配。旧档案缺少达成方式时补充该项证据，不将其他有效项一并重做。

检测只能读取，不能调用模型试探可用性，不能安装任何东西，也不能修改宿主设置。为每次检测选用未存在的 `.tmp/apa-setup/<owner>/<detection-id>/` 目录，`owner` 和 `detection-id` 使用 kebab-case，并确认不会碰撞已有目录；将结果写入该目录的 `host-profile.json`。检测完成后另存一份到 `config/backups/<owner>/host-profiles/<host>-<detection-id>.json`（不覆盖已有文件）；重复自检先读该目录同宿主的档案作为复用起点，只对变化项重查。旧档案仍可读取，不迁移或覆盖。本次报告说明复用项、变化项和仍未核实项；新报告目录不表示需要新建补丁。以下是档案格式：

```json
{
  "schema_version": "apa-host-profile-1.0",
  "host": "<host>",
  "detected_at": "2026-10-27T12:00:00Z",
  "session": { "model": "<session-model>", "reasoning_effort": null },
  "models": [
    { "model": "<model-1>", "reasoning_efforts": [] },
    { "model": "<model-2>", "reasoning_efforts": [] }
  ],
  "dispatch": {
    "tool": "<dispatch-tool>",
    "model_argument": "<model-argument>",
    "effort_argument": null,
    "instruction_argument": "<instruction-argument>",
    "task_name_argument": "<task-name-argument>",
    "fresh_context": null
  },
  "sources": { "session": "system-context", "models": "tool-schema", "dispatch": "tool-schema" },
  "notes": ["<检测限制>"]
}
```

示例只说明格式，不能照抄；每个值都要来自你自己的检测。档案结构见 `Schema/config/apa-config.schema.json` 的 `hostProfile`，CLI 读取档案时会校验，格式不符就停止。

### 检测并给出达成方式

在同一档案的可选 `capabilities` 中记录当前宿主六项能力的只读检查，供 `inspect` 和配置页显示。对每项写 `status`（`detected`、`blocked`、`unsupported` 或 `unknown`）、可操作的 `method`、作用范围 `scope`（`current-session`、`new-session`、`instance` 或 `unknown`）、带来源和具体位置的 `evidence`，以及 `limitations`。证据来源可为 `tool-schema`、`system-context`、`host-config`、`runtime-log`、`installed-software`、`local-code`、`host-docs`；不要仅因产品名称推断支持。

**调查来源。** 每项能力记录 `investigation.searched`，七类来源各一条 `{source, location, result, note}`，`result` 为 `found`、`absent` 或 `not-applicable`；`found`/`absent` 必须写出实际查过的 `location`，`not-applicable` 在 `note` 说明本宿主为何没有这类来源：

- `tool-schema`：本会话实际暴露的工具定义及参数。
- `system-context`：系统提示、环境说明中写明的宿主事实。
- `host-config`：宿主的用户级与项目级设置文件（只读，不复制凭据）。
- `runtime-log`：宿主本机的会话记录、事件日志或转录文件中的实际行为痕迹。
- `installed-software`：已安装宿主程序的版本、`--help` 输出、安装目录中的代码或说明。
- `local-code`：本仓库代码、`scripts/setup/` 中的现有工具。
- `host-docs`：宿主官方文档。

七类未查完就填 `unknown` 或 `not-found` 的能力，`inspect` 会列为 `investigate`，`page` 拒绝生成页面。六项能力都必须写入档案并带 `achievement`；未记录或缺少达成方式的项同样列为 `investigate`。检查器给出“需要重新检测”的项（如 `achieved` 缺方法、作用范围或步骤依据）也列为 `investigate`。检测依据仅从当前工具定义、已安装软件的版本和代码、无凭据配置或官方文档取得；不读取或复制凭据、令牌等秘密，也不启动模型试探。

对每项能力自行调查并记录可选 `achievement`：`state` 为 `achieved`、`needs-setting`、`needs-user-action`、`needs-apa-change` 或 `not-found`，另写一句 `summary` 和 `steps`。`not-found` 写明查过的位置和缺少的依据；公共接口确实缺失时使用 `needs-apa-change`，说明缺口。`achieved` 表示静态条件已具备，实际验证仍为 `not_run`。旧档案缺少 `achievement` 时提示重新检测，原有 `ready` 含义不变。

每个步骤必须记录 `actor`（`apa`、`script` 或 `user`）、`instruction`、`command`（字符串或 `null`）、`scope`（`current-session`、`new-session`、`instance`、`project-settings`、`user-settings` 或 `unknown`）、`persistent`、`verify` 和 `evidence`（每项含 `source` 与 `reference`）。可选 `adapter_id` 和 `range`；后者包含 `min`、`max`（数值或 `null`）及 `unit`（`tokens`、`ratio` 或 `percent`）。`threshold_compaction` 的非空 `step.command` 必须同时包含 `<N>` 并提供 `range`，否则屏蔽该命令；`effective_target_verified` 为 `false` 时屏蔽该能力的命令。只读调查命令写入 `instruction`、`verify` 或 `evidence`，`step.command` 可为 `null`。`range` 的单位是命令参数单位；页面根据用户输入的 token 候选值及已核实的公式换算，未知值保持未知，不填历史值。

先只读检查已有适配的归属及证据。可验证复用有效的自有补丁；需要新补丁时，只在 `config/backups/<owner>/adapters/<adapter-id>/` 新建独立目录，`owner` 为 agent 归属标识，`owner` 和 `adapter-id` 使用 kebab-case，避免与已有目录碰撞；依据 agent 身份及归属证据确定 `owner`，不从所选模型推断。说明须记录所属 agent、宿主、入口、用途、证据和验证方法。其他 agent、归属不明以及既有适配和脚本只读保留，不覆盖、改造、重命名或移动；自适配不修改公共核心。档案可选 `adapters` 数组，项含 `id`、`owner`、`host`、`root`、`entrypoints` 和 `evidence`；`root` 严格为上述归属目录，`entrypoints` 是该目录内非空相对路径数组，`evidence` 记录来源位置。`inspect` 只检查宿主一致、目录归属结构及入口存在与路径范围，显示 `available` 或 `blocked`，不执行入口，也不证明身份或实际效果。既有适配保留原路径，既存个人档案不自动重写。

补丁源码的准备与启用、写入宿主设置分开。宿主设置使用现有工具 `node scripts/setup/apa-host-settings.mjs plan|apply|restore --host <host> --capability threshold_compaction|compact_hook ...`：`plan` 只读，展示目标文件、键和值；`apply` 须 `--confirm`，写入前自动备份到 `config/backups/<owner>/` 并回读；`restore --backup <path> --confirm` 回滚。工具已支持的宿主，阈值和压缩钩子的达成方式应写成调用该工具的步骤，不得因档案缺少命令模板就报“未找到”。只修改用户选定的设置，未选择的值保持占位。检测不修改宿主设置，也不启动模型试验。

依次检查并报告：

1. `on_demand_reading`：当前宿主能否读取项目技能及按范围读取文件；核对控制器的按需读取规则。规则存在不能证明模型在真实运行中遵守。
2. `delegated_diagnostics`：实际派发工具、任务参数、独立上下文和可用回执；当前工具定义缺失时不能借用其他宿主的参数。
3. `manual_compaction`：当前会话是否有手动压缩入口、作用范围以及是否持久修改设置。技能中的阶段提示不等于宿主已执行压缩。
4. `concise_replies`：核对角色请求是否携带 `role-reply-1.0`，短回执的实际遵守情况仍须真实观察。
5. `science_recovery`：核对本库已保存的派发声明与本次检测一致，并检查 `dispatch.result_handle` 是否与真实派发结果匹配、查询或等待工具与参数是否明确，以及原宿主是否仍可访问；上述条件均成立才可标记 `achieved`。尚未保存时报告需要配置，继续第 4、5 步由用户选择和确认，不自行保存。代理依据真实宿主格式编写文本正则，提取第一捕获组；查不到时记录 `not-found`。已配置 `host` 的新科学请求仅在已保存的 host 段声明 `dispatch.result_handle` 时从派发结果文本提取真实句柄，否则记为 `null`；本地 `action_id` 不是可查询的宿主句柄，缺少真实句柄时自检报告该续接为 `blocked`。控制器不主动查询或等待宿主，本地持久化只覆盖控制器退出后原宿主仍可访问的情况，不证明宿主重启恢复。
6. `threshold_compaction`：核对**实际启用的压缩后端**、覆盖方法与参数单位、作用于当前会话还是新会话或整个实例、计量口径及阈值约束。记录用户指定的候选 token 数、上下文窗口 W、输出预留 O、压缩余量 headroom、保留预算 retained 和参数允许的上下限；未知值填 `null`，不能当作 0。`formula` 按证据选择绝对 token 触发 `absolute`、比例并受上限约束 `window-ratio-bounded` 或 `unknown`；公式必须与单位相符。对比例阈值，仅在已确认宿主公式与各值时换算并检查参数范围及取整。

阈值检测按现场安装版本、实际生效的后端及作用域核实，确认候选值的换算依据后再展示操作；无法核实有效目标时报告阻塞，不更换模型或覆盖其他设置绕过。

以下仅为档案内的未知项格式片段，不是检测结果或可直接使用的完整档案；核实后再填写具体值。`recovery` 和 `threshold` 的字段均属于检测证据，不进入个人配置答案：

```json
{
  "capabilities": {
    "science_recovery": {
      "status": "unknown", "method": null, "scope": "unknown", "evidence": [], "limitations": [],
      "recovery": { "task_handle_path": null, "lookup_tool": null, "lookup_argument": null, "original_host_accessible": null }
    },
    "threshold_compaction": {
      "status": "unknown", "method": null, "scope": "unknown", "evidence": [], "limitations": [],
      "threshold": {
        "candidate_tokens": null, "unit": "unknown", "formula": "unknown", "setting": null,
        "setting_min": null, "setting_max": null, "effective_target_verified": null,
        "context_window_tokens": null, "output_reserve_tokens": null, "headroom_tokens": null,
        "retained_tokens": null, "measurement": null
      }
    }
  }
}
```

`effective_target_verified` 只表示是否已核实覆盖指向启用的后端，不表示实际压缩已发生。自检不修改宿主设置，也不启动宿主或模型；真实试验及应用阈值须另获明确授权，并保留压缩事件、计量口径和压缩后关键信息的验证结果。

## 2. 检查当前配置

`inspect` 只校验本次传入档案中的声明，不会自动扫描、发现或合并旧档案和全部补丁。因此第 1 步须主动找回已有成果并重新引用；若漏传旧适配声明，检查器可能报告缺项，不能据此判定旧适配已失效或必须重建。

运行 `node scripts/apa-setup.mjs inspect --host-profile <本次档案实际路径>`，按第 0 步追加已确认的 `--repo-root`，向用户报告：

- `validation.missing`：缺少的必填项；`dependencies`：不可用的依赖。
- `host_check.host`：已保存的派发方式与这次检测是否一致（`match`、`differs` 或 `not-saved`）。
- `host_check.issues`：已保存的模型选择与本宿主不符的地方，包括模型未检测到、缺少推理强度、不支持所选强度、宿主不能选择模型（`model-selection-unavailable`，须请用户选择跟随主会话或暂缓）、没有可用派发工具。
- `validation.conflicts`：已保存的派发方式不能选择模型，但仍有角色指定了模型。存在冲突时配置不算完整，新论文运行会被阻止。
- `capability_check`：六项能力各自的状态、方法、作用范围、依据、限制及下一步；没有档案时未取得依据的能力为未知，本库代码中已知的恢复阻塞仍会报告。`conditional` 表示有条件或需进一步验证，`detected` 仅表示检测到方式；真实模型遵守、自动压缩事件与宿主任务续接均须独立实测。`runtime_validation: not_run` 不随静态检查改成通过。此报告不修改 `ready` 的既有含义，`ready` 不能证明上述能力可用。

宿主不能选择模型时，解释写入具体模型名不会传给子代理，记录的模型会与实际运行不一致；建议相应角色采用 `{"mode":"follow-main"}`，等待用户选择采用或暂缓。不得自行改成 follow-main，也不能换成另一个具体模型。

只查询相关配置时使用 `inspect --capability query`；普通查询不要求完整的阅读配置，详见 [apa-query 配置说明](../apa-query/references/configuration.md)。配置文件是唯一依据，不从旧机器路径或历史默认值猜答案。

- `setup_issues`：由以上结果归类的遗留问题，第 3 步逐类处置。

## 3. 处置自检问题，再生成页面

不要拿到 `inspect` 结果就生成页面。按 `setup_issues` 的 `category` 处理，处理后重新检测相关项并再次 `inspect`，直到只剩可交给页面的项：

- `investigate`：能力还没查完（`detail` 列出未查的来源）或档案缺少达成方式。继续按“调查来源”补查并更新档案，不向用户提问。
- `authorize`：需要执行持久操作（依赖缺失、写宿主设置、需要 APA 改动）。逐条向用户说明要做什么、作用范围、需要哪项授权、怎样验证；获批的执行后只对相关项重新检测，未获批的按用户答复写入台账。
- `page-choice`：需要用户在页面上选择的配置项和宿主声明，直接进入页面。
- `known-limit`：七类来源都已查过、确实无法达成的限制，在页面上照实列出。

台账是档案同目录的 `issue-ledger.json`：`{"schema_version":"apa-setup-issue-ledger-1.0","profile_sha256":"<档案文件字节的 SHA-256>","entries":[{"id":"<问题 id>","disposition":"deferred|declined|resolved-elsewhere","note":"<用户的答复>","decided_by":"user"}]}`。每条只记录用户在会话中的实际决定，`note` 引用用户的原话，不能代填；CLI 无法区分台账由谁写成，`decided_by` 只是你对如实记录的声明。档案改动后哈希失效，须按新档案重新确认。

循环的出口是 `page` 门禁通过：存在 `investigate` 项、`authorize` 项未进台账或台账哈希不符时，`page` 退出码为 1 且不生成 HTML。不得通过省略 `--host-profile` 跳过门禁；没有档案的手动回退只用于确实无法检测宿主的情况，并须向用户说明。

## 4. 必须打开 HTML，由用户填写配置页

运行 `node scripts/apa-setup.mjs page --host-profile <本次档案实际路径> [--ledger <同目录 issue-ledger.json>] --output <本次检测目录的index.html>`（按第 0 步追加已确认的 `--repo-root`），**必须用宿主支持的方式打开返回的本地 HTML，供用户自主选择**。只生成文件或发出路径不算已打开；宿主确实无法打开时，说明限制并提供完整路径，等待用户自行打开并提交选择，不能转为代选或会话问答配置。使用本次独立输出路径，保留其他代理的预览。页面第一步由用户确认项目文件夹，第二步核对工作目录和 MinerU 存放位置，之后才进入三个功能；页面生成的操作带 `repo_root`，与应用目标不符会被拒绝。“完善配置”中的“运行宿主与派发”一页由用户选择是否采用这次检测结果；各模型项从检测结果中选择，推理强度只显示所选模型支持的档位。没有档案时，页面退回手动填写，也无法设置派发方式。生成或打开页面不等于用户批准了其中的任何操作。

**会话只辅助理解页面**：按需解释以下分组的具体值、影响和现有值，由用户在 HTML 中作出选择，不通过会话选择工具或文字问答替代页面：

1. 宿主与派发：说明检测到的工具和参数，选择采用或暂缓。
2. 模型与推理强度：按关键判断（Evidence、Integrator、Independent Verifier）、专项分析（Methods、Results、Interpretation、Scientific Reading）、原文写作（English Writer、Chinese Writer）、呈现与翻译（Reading Editor、Translation）四组逐组选择，每组可整组设置或按角色单独设置，并说明各组相对强度；不能将某一个角色或某一组的回答扩展到其他角色。
3. 输出目录：运行、解析、候选三个目录，相对路径同时展示其在已选项目内的实际位置。
4. 解析器位置：选择已有环境及可选 Python/配置路径；说明留空可选项的派生规则，安装需求另按安装授权处理。
5. 呈现方式：选择是否使用 Reading Editor；不询问首先写作的语言，新运行忽略 `reading.source_language`，写作方向由每篇论文的实际原文语言决定。
6. 写作指导：六项逐项选择启用或不使用；启用项由用户选择实际路径，解释 Nature Shared 依赖，不能自动启用或停用。
7. 查询偏好：在页面的独立查询分组选择查询模型、回答语言、详略与讲解对象；允许用户明确选择暂不配置，既有只读查询的运行时默认不写回个人配置。

用户在页面完成选择后，只核对其提交的操作，展示项目绝对路径、修改前后差异及未完成项，等待明确应用确认；用户明确要求先保存已选部分时，也按相同预览与确认流程处理。已有明确选择无需重复询问，但不能从“你决定”或“全部按推荐”推导答案。

## 5. 应用、导出与导入

- 应用用户明确要求执行的操作：读取用户提供的文件或完整 JSON，核对目标、动作、字段和预览，然后运行 `node scripts/apa-setup.mjs apply --file <operation.json>`（按第 0 步追加已确认的 `--repo-root`）。用户粘贴 JSON 需要暂存时，使用仓库 `.tmp/apa-public-setup/` 下的任务文件。用户自行提交完整操作并明确要求应用时，不重复询问已确定的目标与字段；这不授权添加任何未选择的设置。不改动操作中的指纹；遇 stale 重新读取配置、展示更新后的差异并取得用户确认，再生成新操作，不能重建操作绕过拒绝。应用后再运行一次第 2 步的 `inspect`，以回读结果为准，报告实际的缺项和不可用依赖。
- 挖空或去除配置：不强制打开 HTML。先核对用户明确要求去除的全部答案或具体字段，展示目标和范围，再按明确授权使用既有 `remove` 操作及 `apply` CLI，回读确认结果；范围不清时先澄清。不删除笔记、补丁或依赖。
- 导出配置备份：`node scripts/apa-setup.mjs export --output <file.json>`。用户指定路径时使用该路径；只指定文件名时使用该文件名并保存至 `config/backups/<owner>/`。未指定时使用该目录及 `apa-config-backup-YYYYMMDD-HHmmss-SSS.json` 文件名。`owner` 是当前 agent 的 kebab-case 归属标识，按身份及证据确定，不从所选模型推断；将完整目标传给现有 `--output`，由 CLI 创建父目录。不覆盖已有文件，也不放进 `.tmp/` 或其他临时目录。该目录由 `.gitignore` 排除，不进入公开工程导出。导出后核对内容与当前配置一致，并返回完整路径。页面上的下载由浏览器决定保存位置。
- 导出格式和应用操作格式不同。导入配置须打开 HTML，由用户选择导入项目、预览前后差异并生成操作，再确认应用；未选择、未改变或未提供的字段保持原值。其他电脑的路径与选择不能自动采用。

## 边界

宿主档案是你对自身环境的报告，可以用来检查配置是否与当前宿主相符，但不能证明派发真的会成功，也不能证明模型身份；真实派发以实际运行的返回为准。已保存的 `host` 段决定之后新论文运行用哪个工具、哪些参数名派发角色；没有这一段时沿用现有兼容派发路径。已经开始的运行沿用当时冻结的派发方式；换宿主后要重新检测，由用户选择并确认更新这一段，新运行才会按新宿主派发。

分别报告工程已获取、依赖已安装、用户配置已保存及运行条件已就绪。CLI 格式和指纹校验不能证明选择来自用户；不得新增自行填写的“用户已同意”标记来代替真实回答。配置就绪不等于实际模型调用、PDF 解析或论文验收通过。

缺少完整可用的配置时，新论文的配置化运行会被阻止；已有绑定的运行继续使用原来冻结的配置，不要求重新配置，也不自动升级。保存配置不等于安装依赖或完成了实际解析验收。需要安装时，先检测并报告已有项、缺失项、计划安装位置和影响，由用户明确选择后再装；配置授权不能代替安装授权。不要通过修改科学规则、发布规则或旧绑定来补足配置。
