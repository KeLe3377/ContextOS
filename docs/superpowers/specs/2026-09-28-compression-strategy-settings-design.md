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

每个规则组提供统一的可编辑形态：

```json
{
  "enabled": true,
  "min_output_chars": 3000,
  "head_chars": 700,
  "tail_chars": 500,
  "max_lines": 40,
  "keep_error_lines": true,
  "keep_path_lines": true,
  "mark_jev_candidate": true
}
```

不同规则组只暴露自己需要的字段。例如 `empty_output_rule` 暴露短输出删除阈值，`source_listing_rule` 暴露保留文件/符号/状态行的开关，`instruction_and_tool_spec_rule` 暴露保留标题层级和工具名列表的上限。

建议 public settings 结构：

```json
{
  "mechanical": {
    "empty_output_rule": {
      "enabled": true,
      "success_output_max_chars": 260,
      "write_stdin_max_chars": 220
    },
    "error_protection_rule": {
      "enabled": true,
      "head_chars": 2400,
      "tail_chars": 1200
    },
    "patch_rule": {
      "enabled": true,
      "head_chars": 2400,
      "tail_chars": 1200
    },
    "source_listing_rule": {
      "enabled": true,
      "max_lines": 60,
      "keep_status_lines": true,
      "keep_file_headers": true
    },
    "search_output_rule": {
      "enabled": true,
      "max_matches": 80,
      "keep_truncated_notice": true
    },
    "listing_output_rule": {
      "enabled": true,
      "max_items": 80,
      "keep_anomaly_items": true
    },
    "instruction_and_tool_spec_rule": {
      "enabled": true,
      "max_headings": 40,
      "keep_required_fields": true
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
- `jev_prompt_template`：Jev 判断提示词。
- `jev_fallback_on_error`：Jev 失败时的降级行为。
- `jev_score_levels`：评分等级到压缩动作的映射。

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
9. 更新 MCP Schema、CLI 文档、MCP 文档和 ContextOS skill。
10. 执行真实链路验证。

## 已确认边界

- 采用 B，不采用 C。
- GUI 中可以编辑 B 的参数和模板。
- 压缩引擎代码需要变得更容易被 Agent 修改。
- LLM 外层模板编辑纳入本阶段。
- 设置页面拆成 `压缩服务` 和 `压缩策略`。
- LLM Provider 配置改为不限数量的集中弹窗。
