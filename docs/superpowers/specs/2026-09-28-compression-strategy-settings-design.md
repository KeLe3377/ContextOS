# ContextOS 压缩策略可编辑化与压缩服务设置设计

## 当前结论

本阶段不实现运行时规则 DSL，不做多策略包、导入导出、图形化规则编辑器或任意脚本。ContextOS 采用更直接的方案：

1. 产品层实现 B：让 GUI、MCP、CLI 可编辑机械压缩、Jev 判断、LLM 提示词的关键参数和模板。
2. 工程层重构压缩引擎：把硬编码逻辑拆成清晰的 Rust 模块和操作函数，让 Codex/Agent 后续通过改代码、编译、真实验证来扩展新压缩能力。
3. 设置界面拆成两个页面：`压缩服务` 管模型/Jev 连接和运行参数，`压缩策略` 管压缩判断、裁剪、评分和提示词内容。
4. LLM Provider 配置改为不限数量的 OpenAI-compatible 模型配置弹窗，替代当前固定 3 个 Provider 和逐项设置行。

## 背景

ContextOS 已经完成 MCP、CLI、GUI 共用 `wake-core` 压缩服务的基础改造，但仍存在策略可编辑边界不完整的问题：

- 机械压缩可以运行，但低价值判断、裁剪阈值、头尾保留长度、特殊输出处理仍硬编码。
- Jev 可以配置开关、URL、Key、超时，但候选阈值、请求大小、判断提示词、保留逻辑仍硬编码。
- LLM 已支持编辑单会话、多会话、记忆生成、标签、关系等策略段，但外层 `system message`、`Task`、`Block`、`Sources`、`Session Markdown`、记忆候选契约等 prompt 骨架仍硬编码。
- 设置页目前把 LLM Provider、Jev 配置、LLM 策略文本、标签策略、关系策略堆在一个 `压缩策略` 页面中，继续新增字段会使页面过长且概念混杂。
- 当前 LLM Provider 固定 3 个，通过“切换 Provider + 单字段设置行”编辑，不适合长期使用。

## 目标

1. 用户可以在 GUI 中编辑常用压缩参数和 prompt 模板，不需要改代码。
2. Agent 可以通过 MCP/CLI 读取和更新同一套策略字段，且不暴露或修改 API Key。
3. 压缩服务连接配置与压缩策略配置分离，界面职责清晰。
4. LLM Provider 支持不限数量的 OpenAI-compatible 端点，集中在模型配置弹窗中新增、编辑、复制、删除、启用和测试。
5. 压缩引擎代码拆成更清晰的模块，新增真实压缩行为时优先改 Rust 操作函数，而不是发明运行时规则语言。

## 非目标

本阶段明确不做：

- 图形化规则编辑器。
- 策略导入/导出。
- 多 profile 比较。
- 多策略包管理。
- 规则市场或模板库。
- 任意脚本执行。
- 运行时 JSON 规则 DSL。

这些能力不是当前用户目标的一部分，也会显著增加策略校验、兼容、诊断和 UI 复杂度。

## 页面划分

### 压缩服务

`压缩服务` 页面只处理外部服务和运行参数：

- LLM 生成开关。
- 当前模型配置摘要。
- `模型配置` 按钮，打开 LLM Provider 管理弹窗。
- LLM Timeout。
- LLM 输入上限。
- Jev 辅助评分开关。
- Jev API URL。
- Jev API Key。
- Jev Timeout。

该页面不展示单会话策略、标签策略、机械裁剪参数或 prompt 模板。

### 压缩策略

`压缩策略` 页面处理压缩决策和提示词：

- 机械压缩参数。
- Jev 判断策略。
- LLM 基础策略段。
- LLM 外层 prompt 模板。

长文本字段通过弹窗编辑，页面行内只展示摘要或状态，避免长卷轴。

## LLM Provider 配置

### 现状问题

当前实现使用固定数量的 Provider 配置，且通过多个单字段设置行编辑：

- LLM Provider 切换。
- Provider 名称。
- LLM API URL。
- LLM API Key。
- LLM Model。

这会把一个 Provider 的完整配置拆散，也限制了 Provider 数量。

### 新设计

新增 `模型配置` 弹窗，参考 CC Switch 的列表式体验，但保持 ContextOS 当前设计风格：

- 列表展示所有 Provider。
- 每行显示名称、URL、模型、Key 是否已配置、是否当前启用。
- 行操作包含启用、编辑、复制、删除、测试。
- 顶部提供添加 Provider。
- 编辑表单包含名称、API URL、API Key、模型名称。
- API Key 默认不明文展示；空 Key 保存时默认保持旧值；清空 Key 使用单独动作。

### 存储模型

新增 Provider List v2 存储。这里的 `v2` 只表示 ContextOS 的第二版 Provider 存储结构，不表示 OpenRouter 或某个供应商协议；所有 Provider 都按 OpenAI-compatible chat completions 端点处理。

```json
[
  {
    "id": "stable-id",
    "name": "My Provider",
    "api_url": "https://example.com/v1",
    "api_key": "...",
    "model": "model-name"
  }
]
```

建议 prefs key：

- `compression_llm_providers_v2`
- `compression_llm_active_provider_id`

兼容逻辑：

- 如果 v2 不存在，则从旧 `compression_llm_providers` 和 `compression_llm_active_provider` 读取当前已填的 Provider，转换为 v2。
- 如果旧配置中只有一个有效 Provider，就只迁移这一项，不补空槽位。
- 保存后只写入 v2，不再双写旧 `compression_llm_providers` 和 `compression_llm_active_provider`。
- 迁移时必须保留当前已填写的 URL、API Key、Model、Provider 名称，不能因为换存储结构丢失现有配置。
- 旧 key 可以留在 prefs 中不主动删除，但后续运行逻辑不再依赖旧 key。

### MCP/CLI 边界

MCP/CLI 不返回明文 API Key，也不允许修改 API Key。

可返回：

```json
{
  "providers": [
    {
      "id": "stable-id",
      "name": "My Provider",
      "api_url": "https://example.com/v1",
      "model": "model-name",
      "api_key_configured": true,
      "active": true
    }
  ]
}
```

可通过 MCP/CLI 修改：

- active provider。
- provider name。
- api_url。
- model。

不可通过 MCP/CLI 修改：

- api_key。

## 压缩策略字段

### 机械压缩

机械压缩继续由 Rust 实现具体操作，不开放运行时规则 DSL。本阶段不是只提取几个 head/tail 参数，而是把现有硬编码判断整理成内置规则组。用户和 Agent 可以启用/停用规则组，并编辑每组的关键参数；如果需要新增一种全新操作，仍然通过修改 Rust operation 实现。

机械规则组参考旧设计文档，第一版内置：

- `empty_output_rule`：删除空 output、空轮询、短成功输出。
- `error_protection_rule`：识别错误、失败、panic、traceback、非 0 exit code、编译/测试失败，保留更长证据。
- `patch_rule`：识别 apply_patch、diff、文件修改证据，保留 patch header 和关键 hunks。
- `source_listing_rule`：处理大段源码、行号源码片段、AST/符号/调用链输出；CodeGraph 是该规则的特例而不是唯一对象。
- `search_output_rule`：处理 rg/grep/find/search 命中和 truncated notice。
- `listing_output_rule`：处理 sessions/projects/files/table/list 等列表类输出。
- `instruction_and_tool_spec_rule`：处理 SKILL.md、MCP tools/list、inputSchema、系统说明、README、CLI help、OpenAPI/schema/tool manifest。
- `generic_large_output_rule`：兜底大 Output 裁剪。

不同规则组只暴露自己需要的字段。GUI 页面中所有规则名称、字段名称、说明文字都使用中文；内部 JSON/MCP/CLI 字段继续使用稳定英文 key，便于 Agent 调用和文档检索。

#### GUI 展示方式

`压缩策略` 页面不直接铺开所有机械字段。页面只显示规则组列表，每组一行：

```text
空/低信息输出        已启用 · 成功输出 < 260 字符删除 · write_stdin < 220 字符删除    [编辑]
错误/失败保护        已启用 · 头 2400 / 尾 1200 · 保留命令/退出码/失败行              [编辑]
Patch/Diff 证据      已启用 · 头 2400 / 尾 1200 · 每文件最多 8 个 hunk               [编辑]
源码/代码分析输出    已启用 · 最多 80 行 · 保留文件标题/影响范围/状态提示             [编辑]
搜索输出             已启用 · 最多 80 条 · 保留截断提示和关键词命中                  [编辑]
列表/表格输出        已启用 · 最多 80 项 · 保留总数和异常项                          [编辑]
说明/工具规格        已启用 · 最多 40 个标题 · 保留必填字段/安全提示                 [编辑]
通用大输出           已启用 · 超过 3000 字符裁剪 · 头 700 / 尾 500 · 送 Jev           [编辑]
```

点击 `编辑` 打开弹窗，弹窗标题和字段均为中文。弹窗底部提供：

- `保存`
- `恢复本组默认`
- `取消`

不在第一版提供规则顺序编辑、自定义条件、自定义 action 或正则输入。

#### 空/低信息输出

页面名称：`空/低信息输出`

作用：删除明显没价值的工具输出，例如空 output、空轮询、短成功退出和短 `write_stdin`。

暴露字段：

```json
{
  "enabled": true,
  "drop_empty_output": true,
  "success_output_max_chars": 260,
  "write_stdin_max_chars": 220,
  "keep_exit_code_line": true
}
```

中文字段：

- `启用规则`
- `删除空 Output`
- `成功输出删除阈值`
- `write_stdin 删除阈值`
- `删除正文时保留退出码摘要`

#### 错误/失败保护

页面名称：`错误/失败保护`

作用：识别错误、失败、panic、traceback、非 0 退出码、编译/测试失败，避免把排错证据裁掉。

暴露字段：

```json
{
  "enabled": true,
  "head_chars": 2400,
  "tail_chars": 1200,
  "keep_command": true,
  "keep_exit_code": true,
  "keep_failure_lines": true,
  "failure_keywords": ["error", "failed", "panic", "traceback", "FAILED"]
}
```

中文字段：

- `启用规则`
- `头部保留字符数`
- `尾部保留字符数`
- `保留执行命令`
- `保留退出码`
- `保留失败关键词行`
- `失败关键词`

#### Patch/Diff 证据

页面名称：`Patch/Diff 证据`

作用：保留代码修改证据，但避免巨大 patch 原样进入压缩结果。

暴露字段：

```json
{
  "enabled": true,
  "head_chars": 2400,
  "tail_chars": 1200,
  "keep_file_headers": true,
  "keep_hunk_headers": true,
  "max_hunks_per_file": 8
}
```

中文字段：

- `启用规则`
- `头部保留字符数`
- `尾部保留字符数`
- `保留文件头`
- `保留 Hunk 位置`
- `每个文件最多保留 Hunk 数`

#### 源码/代码分析输出

页面名称：`源码/代码分析输出`

作用：处理 CodeGraph、AST、符号索引、行号源码片段、调用链和 blast radius 等输出。CodeGraph 是该规则的特例，不再单独作为一个规则。

暴露字段：

```json
{
  "enabled": true,
  "max_lines": 80,
  "keep_query_summary": true,
  "keep_file_headers": true,
  "keep_blast_radius": true,
  "keep_staleness_warnings": true,
  "head_chars": 900,
  "tail_chars": 500
}
```

中文字段：

- `启用规则`
- `最多保留关键行数`
- `保留查询摘要`
- `保留文件/符号标题`
- `保留影响范围`
- `保留索引状态提示`
- `兜底头部字符数`
- `兜底尾部字符数`

#### 搜索输出

页面名称：`搜索输出`

作用：处理 `rg`、`grep`、`find`、`search`、`path:line:` 命中和截断提示。

暴露字段：

```json
{
  "enabled": true,
  "max_matches": 80,
  "head_matches": 40,
  "tail_matches": 20,
  "keep_truncated_notice": true,
  "priority_keywords": ["error", "failed", "session", "path", "TODO"]
}
```

中文字段：

- `启用规则`
- `最多保留命中数`
- `前部命中保留数`
- `尾部命中保留数`
- `保留截断提示`
- `优先保留关键词`

#### 列表/表格输出

页面名称：`列表/表格输出`

作用：处理会话列表、项目列表、文件列表、表格和多项条目输出。

暴露字段：

```json
{
  "enabled": true,
  "max_items": 80,
  "head_items": 40,
  "tail_items": 20,
  "keep_count_summary": true,
  "anomaly_keywords": ["error", "failed", "unknown", "stale", "archived"]
}
```

中文字段：

- `启用规则`
- `最多保留条目数`
- `前部条目保留数`
- `尾部条目保留数`
- `保留总数摘要`
- `异常条目关键词`

#### 说明/工具规格

页面名称：`说明/工具规格`

作用：处理 SKILL.md、MCP tools/list、inputSchema、系统/开发者说明、README、CLI help、OpenAPI/schema/tool manifest。

暴露字段：

```json
{
  "enabled": true,
  "max_headings": 40,
  "max_tool_names": 80,
  "keep_required_fields": true,
  "keep_safety_hints": true,
  "keep_command_examples": false,
  "head_chars": 800,
  "tail_chars": 500
}
```

中文字段：

- `启用规则`
- `最多保留标题数`
- `最多保留工具名数`
- `保留必填字段`
- `保留安全/权限提示`
- `保留命令示例`
- `兜底头部字符数`
- `兜底尾部字符数`

#### 通用大输出

页面名称：`通用大输出`

作用：其它规则未命中时的兜底裁剪。

暴露字段：

```json
{
  "enabled": true,
  "min_output_chars": 3000,
  "head_chars": 700,
  "tail_chars": 500,
  "mark_jev_candidate": true
}
```

中文字段：

- `启用规则`
- `裁剪触发字符数`
- `头部保留字符数`
- `尾部保留字符数`
- `标记为 Jev 候选`

#### Public Settings 结构

建议 public settings 结构：

```json
{
  "mechanical": {
    "empty_output_rule": {
      "enabled": true,
      "drop_empty_output": true,
      "success_output_max_chars": 260,
      "write_stdin_max_chars": 220,
      "keep_exit_code_line": true
    },
    "error_protection_rule": {
      "enabled": true,
      "head_chars": 2400,
      "tail_chars": 1200,
      "keep_command": true,
      "keep_exit_code": true,
      "keep_failure_lines": true,
      "failure_keywords": ["error", "failed", "panic", "traceback", "FAILED"]
    },
    "patch_rule": {
      "enabled": true,
      "head_chars": 2400,
      "tail_chars": 1200,
      "keep_file_headers": true,
      "keep_hunk_headers": true,
      "max_hunks_per_file": 8
    },
    "source_listing_rule": {
      "enabled": true,
      "max_lines": 80,
      "keep_query_summary": true,
      "keep_file_headers": true,
      "keep_blast_radius": true,
      "keep_staleness_warnings": true,
      "head_chars": 900,
      "tail_chars": 500
    },
    "search_output_rule": {
      "enabled": true,
      "max_matches": 80,
      "head_matches": 40,
      "tail_matches": 20,
      "keep_truncated_notice": true,
      "priority_keywords": ["error", "failed", "session", "path", "TODO"]
    },
    "listing_output_rule": {
      "enabled": true,
      "max_items": 80,
      "head_items": 40,
      "tail_items": 20,
      "keep_count_summary": true,
      "anomaly_keywords": ["error", "failed", "unknown", "stale", "archived"]
    },
    "instruction_and_tool_spec_rule": {
      "enabled": true,
      "max_headings": 40,
      "max_tool_names": 80,
      "keep_required_fields": true,
      "keep_safety_hints": true,
      "keep_command_examples": false,
      "head_chars": 800,
      "tail_chars": 500
    },
    "generic_large_output_rule": {
      "enabled": true,
      "min_output_chars": 3000,
      "head_chars": 700,
      "tail_chars": 500,
      "mark_jev_candidate": true
    }
  }
}
```

规则执行顺序由 Rust 固定为默认安全顺序，避免用户在 B 阶段通过运行时配置制造不可预测的叠加行为。规则命中后默认第一条命中返回；只有通用统计和 Jev 候选标记可以作为附加结果记录。

### Jev 判断策略

Jev 连接信息仍在 `压缩服务` 页面；Jev 判断策略进入 `压缩策略` 页面。

Jev 的关键设计变更：Jev 不再只负责“是否恢复全文”。Jev 的核心目标是帮助压缩，而不是把内容变大。Jev 输出信息价值评分和保留等级，Rust 根据等级决定删除、stub、保留机械裁剪、抽取证据、扩展片段或近全文保留。

建议字段：

- `jev_request_char_limit`：单次 Jev 请求最大字符数。
- `jev_candidate_min_chars`：超过该长度的机械候选才送 Jev。
- `jev_prompt_template`：Jev 评分提示词，必须配合评分等级解释每个分数段的含义。
- `jev_fallback_on_error`：Jev 失败时的降级行为。
- `jev_score_levels`：评分等级到压缩动作的映射。

#### Jev 评分提示词编辑

Jev 提示词不作为普通单行设置展示。`压缩策略` 页面只显示一行：

```text
Jev 评分提示词        已配置 · 6 个评分等级 · 删除/占位/机械/证据/扩展/近全文       [编辑]
```

点击 `编辑` 打开专门页面或大弹窗，标题为 `Jev 评分提示词`。页面包含三块：

1. `评分提示词`
   - 多行文本编辑器。
   - 用来描述 Jev 应如何判断一个候选 Output 的信息价值。
   - 必须说明评分范围、评分依据和输出格式。
2. `评分等级`
   - 表格展示固定 6 个等级：删除、极简占位、机械裁剪、关键证据、扩展片段、近全文。
   - 每行可编辑最高分、中文说明和对应动作。
   - 动作必须来自固定白名单。
3. `示例`
   - 展示 2 到 3 个典型评分例子，帮助用户理解“多少分对应什么处理”。
   - 示例只是说明，不参与运行。

默认提示词应内置评分要求，而不是只说“判断是否重要”。示例：

```text
你是 ContextOS 的工具输出信息价值评估器。你的任务不是决定是否恢复全文，
而是判断该 Output 在压缩交接中应该保留到什么程度。

请根据以下维度给出 0.0 到 1.0 的 score：
- 是否包含用户目标、关键决定、未完成事项或恢复上下文。
- 是否包含错误、失败、测试结果、编译结果、异常堆栈或修复证据。
- 是否包含文件路径、代码修改、patch、命令输出、版本/环境信息。
- 是否只是成功退出、空轮询、重复列表、长源码全文或完整说明文档。

评分含义：
- 0.00-0.25：删除。没有接手价值，或机械结果仍然偏冗余。
- 0.25-0.45：极简占位。只需要标题、工具名、字符数和一句理由。
- 0.45-0.60：机械裁剪。机械压缩结果已经足够。
- 0.60-0.78：关键证据。需要保留错误行、路径、命令、结论或少量关键片段。
- 0.78-0.92：扩展片段。需要更长 head/tail 或多个相关片段，但不需要全文。
- 0.92-1.00：近全文。只有当全文本身就是关键证据且无法可靠摘要时使用。

请返回 JSON：
{"score":0.0,"reason":"简短理由","evidence_hints":["需要保留的关键词或片段"]}
```

评分等级表默认值：

默认评分等级：

```json
{
  "jev_score_levels": [
    {
      "id": "discard",
      "label": "删除",
      "max_score": 0.25,
      "action": "discard"
    },
    {
      "id": "stub",
      "label": "极简占位",
      "max_score": 0.45,
      "action": "stub"
    },
    {
      "id": "mechanical",
      "label": "机械裁剪",
      "max_score": 0.60,
      "action": "use_mechanical"
    },
    {
      "id": "evidence",
      "label": "关键证据",
      "max_score": 0.78,
      "action": "evidence"
    },
    {
      "id": "expanded",
      "label": "扩展片段",
      "max_score": 0.92,
      "action": "expanded"
    },
    {
      "id": "verbatim",
      "label": "近全文",
      "max_score": 1.0,
      "action": "verbatim"
    }
  ]
}
```

字段含义：

- `max_score` 表示该等级覆盖的最高分，按数组顺序匹配。
- `action=discard`：比机械结果还低价值，输出中删除该 detail 或只保留删除报告。
- `action=stub`：只保留标题、工具名、字符数、Jev 理由。
- `action=use_mechanical`：保留机械裁剪结果。
- `action=evidence`：保留 Jev/Rust 抽取的关键证据行或关键片段。
- `action=expanded`：保留更长 head/tail 和相关片段。
- `action=verbatim`：预算允许时保留原文或接近全文。

第一版可以允许编辑等级阈值、标签和 action，但 action 必须来自固定白名单。是否允许增删等级有两种方案：

1. 固定 6 个等级，只允许改阈值和 action，GUI 简单、诊断稳定。
2. 允许增删等级，但必须覆盖 `0.0..=1.0`，按 `max_score` 升序校验。

推荐第一版采用固定 6 个等级。这样已经解决“几个评级、多少评分对应什么压缩动作”的关键问题，同时不会变成完整规则 DSL。

`jev_fallback_on_error` 第一版建议只支持：

- `use_mechanical`：Jev 失败时使用机械压缩结果继续。
- `fail`：Jev 失败时压缩失败并返回结构化错误。

默认保持当前行为：Jev 失败不阻断 LLM 压缩，即 `use_mechanical`。

LLM 关闭时默认输出：

```text
mechanical_report
jev_report
mechanical_or_jev_compressed_markdown
```

其中 Jev 只按等级压缩候选块，不再简单恢复全文。Jev report 记录每个候选的 score、level、action、reason 和节省/增加字符数。

### LLM 提示词策略

保留现有策略字段：

- `single_strategy`
- `memory_generation_strategy`
- `multi_strategy`
- `tag_strategy`
- `tag_specific_strategies`
- `relation_strategy`

新增外层模板字段：

- `llm_system_message`
- `llm_task_template`
- `llm_user_prompt_template`
- `llm_memory_candidate_contract`
- `llm_temperature`

`llm_user_prompt_template` 使用简单变量替换，不支持脚本：

- `{{task}}`
- `{{strategy}}`
- `{{tag_strategy}}`
- `{{relationship_strategy}}`
- `{{block_number}}`
- `{{block_count}}`
- `{{turns_json}}`
- `{{sources}}`
- `{{markdown}}`
- `{{memory_candidate_contract}}`

校验规则：

- `{{markdown}}` 必须存在。
- `{{strategy}}` 必须存在。
- 启用记忆候选生成时，最终 prompt 必须包含 `{{memory_candidate_contract}}` 或等效默认追加逻辑。
- 未识别变量返回 `invalid_request` 或 GUI 表单错误。
- `llm_temperature` 限制在合理范围，例如 `0.0..=2.0`。

## 代码结构重构

当前不做 C 的 JSON 操作编排，但需要让压缩引擎更适合 Agent 修改。建议将 `wake-core/src/services/compression.rs` 拆分为目录模块：

```text
crates/wake-core/src/services/compression/
  mod.rs
  settings.rs
  mechanical.rs
  jev.rs
  llm_prompt.rs
  diagnostics.rs
```

职责：

- `settings.rs`：加载服务设置与策略设置，提供默认值、校验、public view。
- `mechanical.rs`：解析 detail、机械裁剪、低价值删除、特殊输出处理、Jev 候选标记。
- `jev.rs`：Jev 请求组装、评分解析、阈值判断、失败降级。
- `llm_prompt.rs`：LLM prompt 模板变量、变量校验、system/user message 构造。
- `diagnostics.rs`：阶段统计、规则命中摘要、结构化错误。
- `mod.rs`：保留 `run_inputs`、`list_turns`、`MemoryCandidate` 等对外 API。

机械压缩内部应整理为清晰的 Rust 操作序列，例如：

```text
drop_low_value_details
compress_patch_output
compress_codegraph_output
compress_skill_output
truncate_generic_output
mark_jev_candidates
```

后续如果需要新增真实压缩行为，由 Agent 修改 Rust operation 并通过编译与真实链路验证，而不是在运行时 JSON 中发明新动作。

## MCP/CLI 接口

继续沿用六个领域入口，不新增大量细碎工具。

建议将策略相关能力放在 `contextos_settings` 的 compression section 中，或在 `contextos_compression` 中提供策略操作。为了语义清晰，推荐：

- 服务设置继续在 `contextos_settings`：
  - `settings.get section=compression`
  - `settings.update section=compression`
- 压缩策略也通过 `settings.get/update section=compression` 暴露在同一 public settings 中，但字段分为 `service` 与 `strategy` 两组。

返回结构建议：

```json
{
  "service": {
    "llm_enabled": true,
    "llm_providers": [],
    "llm_timeout_secs": 600,
    "llm_input_limit_chars": 1000000,
    "jev_enabled": false,
    "jev_api_url": "",
    "jev_api_key_configured": false,
    "jev_timeout_secs": 60
  },
  "strategy": {
    "mechanical": {},
    "jev": {},
    "llm": {}
  }
}
```

API Key 规则不变：

- MCP/CLI 不返回明文 Key。
- MCP/CLI 不修改 Key。
- GUI 可以修改 Key。

### MCP/CLI 具体契约

MCP 和 CLI 使用同一套 handler、同一套 JSON 请求结构、同一套校验逻辑。CLI 是 shell 入口，MCP 是 Agent 工具入口；二者不分叉实现。

CLI 形态：

```powershell
contextos-cli settings get --input request.json
contextos-cli settings update --input request.json
```

MCP 形态：

```json
{
  "name": "contextos_settings",
  "arguments": {
    "operation": "get",
    "section": "compression"
  }
}
```

`settings.get section=compression` 返回完整 public settings。`settings.update section=compression` 接收局部 patch：只修改传入字段，未传字段保持不变。对象递归合并，数组整体替换，字符串按原样保存但 trim 首尾空白。`null` 不表示删除；需要恢复默认时使用单独的 `reset_defaults` 字段，避免把 `null` 变成隐式规则语言。

更新示例：

```json
{
  "operation": "update",
  "section": "compression",
  "data": {
    "service": {
      "llm_enabled": true,
      "active_llm_provider_id": "openrouter",
      "llm_timeout_secs": 900
    },
    "strategy": {
      "mechanical": {
        "generic_large_output_rule": {
          "min_output_chars": 4000,
          "head_chars": 900,
          "tail_chars": 700
        }
      },
      "jev": {
        "jev_candidate_min_chars": 2500,
        "jev_fallback_on_error": "use_mechanical"
      },
      "llm": {
        "llm_temperature": 0.2
      }
    }
  }
}
```

恢复默认示例：

```json
{
  "operation": "update",
  "section": "compression",
  "reset_defaults": [
    "strategy.mechanical.empty_output_rule",
    "strategy.jev.jev_score_levels",
    "strategy.llm.llm_user_prompt_template"
  ]
}
```

`reset_defaults` 只接受明确白名单路径，不能接受通配符、表达式或脚本。

### Public Settings 结构

最终返回结构应稳定为：

```json
{
  "service": {
    "llm_enabled": true,
    "llm_providers": [
      {
        "id": "stable-id",
        "name": "My Provider",
        "api_url": "https://example.com/v1",
        "model": "model-name",
        "api_key_configured": true,
        "active": true
      }
    ],
    "active_llm_provider_id": "stable-id",
    "llm_timeout_secs": 600,
    "llm_input_limit_chars": 1000000,
    "jev_enabled": false,
    "jev_api_url": "",
    "jev_api_key_configured": false,
    "jev_timeout_secs": 60
  },
  "strategy": {
    "mechanical": {},
    "jev": {},
    "llm": {}
  }
}
```

`strategy.mechanical` 使用前文机械规则组结构。`strategy.jev` 使用 Jev 判断策略结构。`strategy.llm` 使用 LLM 策略段和外层 prompt 模板结构。

### 字段权限

| 字段范围 | GUI | MCP/CLI | 说明 |
|---|---|---|---|
| `service.llm_enabled` | 读写 | 读写 | 控制是否启用 LLM 压缩。 |
| `service.llm_providers[].name` | 读写 | 读写 | Provider 显示名称。 |
| `service.llm_providers[].api_url` | 读写 | 读写 | OpenAI-compatible API 基址。 |
| `service.llm_providers[].model` | 读写 | 读写 | 模型名。 |
| `service.llm_providers[].api_key` | 读写 | 不可见/不可写 | MCP/CLI 只返回 `api_key_configured`。 |
| `service.active_llm_provider_id` | 读写 | 读写 | 当前启用 Provider。 |
| `service.llm_timeout_secs` | 读写 | 读写 | 数值范围由 core 校验。 |
| `service.llm_input_limit_chars` | 读写 | 读写 | 控制 LLM 分块输入上限。 |
| `service.jev_enabled` | 读写 | 读写 | 控制是否启用 Jev 辅助评分。 |
| `service.jev_api_url` | 读写 | 读写 | Jev API 地址。 |
| `service.jev_api_key` | 读写 | 不可见/不可写 | MCP/CLI 只返回 `jev_api_key_configured`。 |
| `service.jev_timeout_secs` | 读写 | 读写 | Jev 请求超时。 |
| `strategy.mechanical.*` | 读写 | 读写 | 内置机械规则组参数。 |
| `strategy.jev.*` | 读写 | 读写 | Jev 候选阈值、评分提示词、评分等级和降级策略。 |
| `strategy.llm.*` | 读写 | 读写 | LLM 策略段、外层 prompt 模板和 temperature。 |

MCP/CLI 的设计原则是开放业务能力和必要参数，而不是复制 GUI 的弹窗流程。GUI 需要通过“编辑”弹窗组织信息；MCP/CLI 则直接暴露结构化字段，方便 Agent 批量读取、修改、运行压缩、查看诊断并再次调整。

### MCP/CLI 与压缩运行联动

Agent 推荐流程：

1. 调用 `contextos_settings get section=compression` 读取当前策略和服务设置。
2. 调用 `contextos_settings update section=compression` 修改非密钥字段。
3. 调用 `contextos_compression run` 用真实会话运行压缩。
4. 查看压缩结果中的 diagnostics，确认机械规则命中、Jev 等级分布、LLM block 数量和 active provider。
5. 必要时再次更新 settings。

`contextos_compression run` 可以继续支持单次运行 override，例如 `jev_enabled`、`llm_enabled`、输出路径、是否生成 memory candidates。单次 override 不应修改持久设置，也不能覆盖 API Key。

### ContextOS Skill 更新设计

本阶段不直接修改 `skills/contextos/SKILL.md`。Skill 应在实际代码实现、CLI/MCP schema 更新、真实调用验证完成后再更新，避免文档提前描述不存在的字段。

实现完成后，ContextOS skill 需要补充：

- Agent 可以通过 `contextos-cli settings get/update` 或 MCP `contextos_settings` 读取和修改压缩设置。
- API Key 不会通过 MCP/CLI 返回，也不能通过 MCP/CLI 修改；需要用户在 GUI 中配置。
- 压缩策略分为 `service` 与 `strategy`：
  - `service` 管 LLM/Jev 连接和运行参数。
  - `strategy` 管机械规则、Jev 评分、LLM prompt。
- 调整策略后，应通过真实 `contextos_compression run` 验证，并查看 diagnostics。
- 不要尝试通过 JSON 发明新压缩操作、运行脚本或构造规则 DSL。
- 如果需要新增真实压缩行为，优先修改 Rust 压缩引擎操作函数，编译并通过真实 MCP/CLI/GUI 链路验证。
- 压缩引擎会拆成更清晰的模块；Agent 应优先查找 `settings.rs`、`mechanical.rs`、`jev.rs`、`llm_prompt.rs`、`diagnostics.rs` 这类模块边界。

如果兼容发布仍包含 `skills/wake/SKILL.md`，实现完成后同步更新同一段说明，避免旧 skill 给 Agent 过期指导。

## 数据迁移与兼容

1. 现有策略 key 继续读取，新增字段不存在时使用 `wake-core` 默认值。
2. LLM Provider v2 不存在时，从旧固定 Provider 配置转换当前有效项；转换后运行逻辑只使用 v2。
3. 旧 Provider key 不再双写、不再作为运行期配置来源；可以留在 prefs 中不主动删除，但不是兼容目标。
4. 迁移必须保留当前已填写的 URL、API Key、Model、Provider 名称。
5. 文档派生 frontmatter 中记录 public settings 时，继续排除 API Key 明文。

## 错误与诊断

策略设置更新需要返回结构化错误：

- 字段类型错误：`invalid_request`
- 数值越界：`invalid_request`
- 未识别模板变量：`invalid_request`
- 缺少必要模板变量：`invalid_request`
- Jev/LLM provider 调用失败：`provider_error`

压缩运行结果应继续包含阶段统计，并增加可选诊断字段：

- 机械压缩前后字符数。
- 删除 detail 数量。
- 裁剪 Output 数量。
- Jev 候选数量。
- Jev 各评分等级数量。
- Jev 删除、stub、证据、扩展、近全文等动作数量。
- LLM block 数量。
- 使用的 active provider id/name/model。

这些诊断用于 Agent 判断策略调整是否生效。

## 验证策略

遵循项目当前原则：不采用红灯测试流程，不创建额外临时隔离环境；实现后进行必要编译和真实链路验证。

建议验证：

1. `cargo check -p wake-core --all-targets`
2. `cargo build -p wake-core --bin contextos-cli --bin contextos-mcp`
3. `cargo build -p wake`
4. GUI 打开设置，确认出现 `压缩服务` 与 `压缩策略` 两页。
5. GUI 模型配置弹窗可以新增、编辑、启用、删除 Provider。
6. CLI/MCP `settings get` 不返回明文 API Key。
7. CLI/MCP 能修改非密钥 Provider 字段与策略字段。
8. 纯机械压缩验证参数生效。
9. Jev 关闭时不影响机械/LLM。
10. LLM prompt 模板修改后，真实压缩请求使用新模板。

## 实施顺序建议

1. 提取 compression settings 默认值、校验和 public view。
2. 实现 LLM Provider v2 模型和一次性迁移读取，保留当前 URL、API Key、Model。
3. 拆分设置页为 `压缩服务` 与 `压缩策略`。
4. 实现模型配置弹窗。
5. 提取机械规则组设置并接入运行链路。
6. 提取 Jev 评分等级和判断策略并接入运行链路。
7. 提取 LLM 外层模板并接入 prompt 构造。
8. 重构压缩服务模块边界。
9. 更新 MCP Schema、CLI 文档和 MCP 文档。
10. 执行真实链路验证，确认字段、命令、诊断和密钥隐藏规则都与实现一致。
11. 验证完成后再更新 ContextOS skill，把实际可用的 MCP/CLI 能力和压缩引擎修改边界写给 Agent。

## 已确认边界

- 采用 B，不采用 C。
- GUI 中可以编辑 B 的参数和模板。
- 压缩引擎代码需要变得更容易被 Agent 修改。
- LLM 外层模板编辑纳入本阶段。
- 设置页面拆成 `压缩服务` 和 `压缩策略`。
- LLM Provider 配置改为不限数量的集中弹窗。
