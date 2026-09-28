# ContextOS 压缩策略可编辑化与压缩服务设置设计

## 当前结论

本阶段不实现运行时规则 DSL，不做多策略包、导入导出、图形化规则编辑器或任意脚本。ContextOS 采用更直接的方案：

1. 产品层实现 B：让 GUI、MCP、CLI 可编辑机械压缩、Jev 判断、LLM 提示词的关键参数和模板。
2. 工程层重构压缩引擎：把硬编码逻辑拆成清晰的 Rust 模块和操作函数，让 Codex/Agent 后续通过改代码、编译、真实验证来扩展新压缩能力。
3. 设置界面拆成两个页面：`压缩服务` 管模型/Jev 连接和运行参数，`压缩策略` 管压缩判断、裁剪、评分和提示词内容。
4. LLM Provider 配置改为不限数量的模型配置弹窗，替代当前固定 3 个 Provider 和逐项设置行。

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
4. LLM Provider 支持不限数量，集中在模型配置弹窗中新增、编辑、复制、删除、启用和测试。
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

新增 v2 存储：

```json
[
  {
    "id": "stable-id",
    "name": "OpenRouter",
    "api_url": "https://openrouter.ai/api/v1",
    "api_key": "...",
    "model": "anthropic/claude-sonnet-4"
  }
]
```

建议 prefs key：

- `compression_llm_providers_v2`
- `compression_llm_active_provider_id`

兼容逻辑：

- 如果 v2 不存在，则从旧 `compression_llm_providers` 和 `compression_llm_active_provider` 读取并转换。
- 保存后写入 v2。
- 旧 key 暂不删除，避免回滚版本无法读取。

### MCP/CLI 边界

MCP/CLI 不返回明文 API Key，也不允许修改 API Key。

可返回：

```json
{
  "providers": [
    {
      "id": "stable-id",
      "name": "OpenRouter",
      "api_url": "https://openrouter.ai/api/v1",
      "model": "anthropic/claude-sonnet-4",
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

机械压缩继续由 Rust 实现具体操作，不开放运行时规则 DSL。本阶段将硬编码参数和开关提取为可编辑设置。

建议字段：

- `mechanical_generic_output_min_chars`：普通 Output 超过该长度才裁剪。
- `mechanical_generic_output_head_chars`：普通 Output 头部保留字符数。
- `mechanical_generic_output_tail_chars`：普通 Output 尾部保留字符数。
- `mechanical_low_value_success_max_chars`：短成功输出丢弃阈值。
- `mechanical_low_value_write_stdin_max_chars`：短 `write_stdin` 输出丢弃阈值。
- `mechanical_patch_special_enabled`：是否启用 patch 特殊处理。
- `mechanical_patch_head_chars`：patch 输出头部保留字符数。
- `mechanical_patch_tail_chars`：patch 输出尾部保留字符数。
- `mechanical_codegraph_special_enabled`：是否启用 CodeGraph 特殊处理。
- `mechanical_skill_special_enabled`：是否启用 skill 输出特殊处理。
- `mechanical_skill_head_chars`：skill 输出无标题时头部保留字符数。
- `mechanical_skill_tail_chars`：skill 输出无标题时尾部保留字符数。
- `mechanical_jev_candidate_min_chars`：机械裁剪后标记 Jev 候选的最小 Output 字符数。

字段值需要在 `wake-core` 中定义默认值、校验范围和 public settings 输出，GUI/MCP/CLI 使用同一套定义。

### Jev 判断策略

Jev 连接信息仍在 `压缩服务` 页面；Jev 判断策略进入 `压缩策略` 页面。

建议字段：

- `jev_request_char_limit`：单次 Jev 请求最大字符数。
- `jev_keep_full_threshold`：评分达到该阈值时恢复全文。
- `jev_prompt_template`：Jev 判断提示词。
- `jev_fallback_on_error`：Jev 失败时的降级行为。

`jev_fallback_on_error` 第一版建议只支持：

- `use_mechanical`：Jev 失败时使用机械压缩结果继续。
- `fail`：Jev 失败时压缩失败并返回结构化错误。

默认保持当前行为：Jev 失败不阻断 LLM 压缩，即 `use_mechanical`。

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

1. 现有策略 key 继续读取。
2. 新增字段不存在时使用 `wake-core` 默认值。
3. LLM Provider v2 不存在时，从旧固定 Provider 配置转换。
4. 旧字段保留一段时间，不做破坏性删除。
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
- Jev 恢复全文数量。
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
2. 实现 LLM Provider v2 模型和兼容读取。
3. 拆分设置页为 `压缩服务` 与 `压缩策略`。
4. 实现模型配置弹窗。
5. 提取机械压缩参数并接入运行链路。
6. 提取 Jev 判断策略并接入运行链路。
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
