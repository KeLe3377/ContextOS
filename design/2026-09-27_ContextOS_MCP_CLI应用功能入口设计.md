# ContextOS MCP / CLI 应用功能入口设计

> 时间：2026-09-27  
> 状态：设计确认 / 待实现  
> 范围：让 Agent 通过 MCP 和 CLI 使用当前 ContextOS 的业务功能

---

## 1. 背景

ContextOS 当前已经提供 MCP、CLI 和 GUI：

- MCP 具有搜索、会话读取、项目和 Memory 查询等只读工具。
- CLI 与 MCP 共用部分工具调用逻辑。
- 收藏、置顶、标签、关系、Cleanup、Memory 编辑和压缩等能力已经存在于 GUI 或 `wake-core`，但尚未完整开放给 MCP/CLI。
- 部分压缩逻辑仍位于 GUI `Workbench`，无法被 MCP/CLI 直接复用。

本设计不建立独立控制服务，也不要求 MCP、CLI 与应用独立发布。应用、MCP 和 CLI 使用同一代码仓库、同一版本，一起编译和发布。

---

## 2. 目标

1. Agent 可以通过 MCP 或 CLI 使用当前 ContextOS 页面中的业务功能。
2. GUI、MCP、CLI 共用 `wake-core` 中的业务实现，不重复实现规则。
3. 新增 ContextOS 功能时，可以在对应业务领域增加 operation，并随应用一起编译发布。
4. 压缩设置、机械压缩、Jev、LLM、Chunk 和派生文件逻辑可以脱离 GUI 运行。
5. Agent 可以修改业务设置，并通过真实执行结果自行验证。

---

## 3. 非目标

本设计明确不包含：

- 独立 daemon 或本地 IPC 服务。
- 动态 Capability Registry 或运行时插件系统。
- MCP、CLI 与 GUI 的独立版本兼容。
- 通用权限、审批、confirmation token 或 dry-run 框架。
- 面向用户或 Agent 的 `test` 命令。
- 原始用户/Agent 会话内容编辑。
- 永久删除、清空回收站或恢复操作。
- 搜索索引重建入口。
- Remote Hosts 及其他已从 ContextOS 页面移除的旧 Wake 功能。
- 主题、语言、窗口尺寸等界面偏好设置。

---

## 4. 产品范围原则

当前 ContextOS UI 可到达的业务功能是 MCP/CLI 能力范围的来源。

```text
当前 ContextOS 页面可见的业务功能
    -> 可以开放 MCP / CLI operation

只存在于旧 Wake 代码、当前页面不可达的功能
    -> 视为废弃
    -> 不开放 MCP / CLI
    -> 本次不负责删除遗留代码
```

底层存在某个 `Store` 方法，不代表 Agent 自动获得该能力。只有领域分发器显式实现的 operation 才能调用。

---

## 5. 总体架构

```text
GUI -------------------> wake-core services ---> Store / 文件系统 / Jev / LLM
MCP domain tools ------> wake-core services
CLI domain commands ---> 与 MCP 共用 handler ---> wake-core services
```

职责划分：

- `wake-core::services`：业务规则、数据修改、压缩执行和文件操作。
- `mcp`：MCP Schema、参数解析、领域 operation 分发和结果格式化。
- `cli`：把 CLI 参数或输入 JSON 转交给同一个领域 handler。
- GUI：保留界面状态、文件选择、通知、进度和后台线程，业务动作调用相同 service。
- `db`：提供数据库读写，不包含 MCP/CLI 特有规则。

只下沉 GUI、MCP、CLI 需要共同使用的逻辑，不对无关 GUI 代码做全面重构。

建议的核心模块：

```text
wake-core/src/services/
├── compression/
├── session_actions.rs
├── relations.rs
├── memories.rs
└── settings.rs
```

---

## 6. MCP / CLI 领域入口

不为每个动作创建一个工具，也不把整个应用压进两个松散的 read/write 工具。按业务领域提供六个稳定入口：

```text
contextos_settings
contextos_sessions
contextos_relations
contextos_compression
contextos_memories
contextos_data_sources
```

CLI 一一对应：

```text
contextos-cli settings
contextos-cli sessions
contextos-cli relations
contextos-cli compression
contextos-cli memories
contextos-cli data-sources
```

每个入口通过 `operation` 选择领域内动作。复杂参数由 `--input <json-file>` 或 stdin 提供，MCP 与 CLI 使用相同请求结构。

### 6.1 settings

```text
get
update
```

范围仅限业务设置。第一版主要是 compression 分区。

```json
{
  "operation": "update",
  "section": "compression",
  "data": {
    "jev_enabled": true,
    "llm_enabled": false,
    "llm_input_limit_chars": 120000
  }
}
```

设置采用字段级更新。修改后返回 `restart_required: true`：

- 当前运行的 GUI 不重新加载外部设置。
- GUI 下次启动时使用新设置。
- CLI/MCP 下次执行压缩时直接读取最新持久化设置。

API Key 只返回 `api_key_configured`，不返回明文，也不通过 MCP/CLI 修改。

### 6.2 sessions

```text
list
get
search
list_projects
update_metadata
trash
cleanup_history
```

`update_metadata` 支持：

- `favorite`
- `pinned`
- `add_tags`
- `remove_tags`

不提供原始消息编辑。标签允许预设标签和非空自定义标签。

`trash` 一次提交一个会话。底层 Cleanup 如果必须连带处理同一会话树或共享文件，结果必须返回完整 `affected_sessions` 和文件状态。

删除使用操作系统回收站。恢复操作现在不提供，以后也不规划。

### 6.3 relations

```text
list
create
update
delete
```

- Adapter 自动发现的父子关系只读。
- Agent 只能创建、修改和删除 `source = manual` 的关系。
- 关系不能指向自身。

### 6.4 compression

```text
run
get_document
update_document
trash_document
```

不提供 `test` operation。Agent 通过真实执行验证设置：

```text
settings update
-> compression run
-> compression get_document
-> 根据结果继续调整
```

`run` 支持单会话和多会话。关系会话必须显式传入，不自动扩大处理范围。

### 6.5 memories

```text
list
get
create
update
trash
```

写操作仅适用于 ContextOS 创建的用户 Memory。Claude、Codex 等 Agent 自己维护的项目记忆、系统记忆和指令文件保持只读。

### 6.6 data_sources

```text
list
add
set_enabled
remove
reset
```

使用 `kind` 区分：

```text
sessions
memories
```

仅支持本地、真实存在且类型受支持的路径。Remote Hosts 不属于合法类型。修改后返回 `restart_required: true`。

### 6.7 现有工具兼容

现有只读 MCP 工具和 CLI 命令可以作为兼容入口保留，并逐步改为调用相同领域 handler：

```text
contextos_search
contextos_list_sessions
contextos_get_session
contextos_list_projects
contextos_list_memories
```

新能力统一通过六个领域入口提供。

---

## 7. 请求与结果

每个领域定义自己的强类型请求，避免业务 service 直接处理松散 JSON。

统一成功结果：

```json
{
  "ok": true,
  "data": {},
  "warnings": []
}
```

统一失败结果：

```json
{
  "ok": false,
  "error": {
    "code": "invalid_request",
    "message": "session_key is required"
  }
}
```

错误类别保持精简：

```text
invalid_request
not_found
conflict
not_allowed
io_error
provider_error
internal_error
```

新增 CLI 命令默认向 stdout 输出 JSON；诊断日志写入 stderr。现有只读命令的文本输出暂时保持兼容。

---

## 8. 数据库写入

当前 MCP 使用只读 Store。增加写 operation 后，需要提供“打开已有数据库进行业务写入”的路径：

- 数据库必须已经存在。
- Schema 必须与当前二进制兼容。
- MCP/CLI 不负责迁移、修复或重建数据库。
- 数据库不存在时提示先启动 ContextOS，或使用现有首次 `index` 命令。
- GUI、MCP、CLI 依赖现有 SQLite WAL 和事务并发访问。
- 同一字段由多个入口修改时采用最后写入生效。
- 不增加 revision、锁服务或冲突合并系统。

---

## 9. 压缩服务下沉

当前压缩设置、Jev、LLM 和 Chunk 逻辑仍有较多位于 GUI。目标结构：

```text
wake-core/src/services/compression/
├── mod.rs
├── settings.rs
├── details.rs
├── chunks.rs
├── llm.rs
└── documents.rs
```

GUI 保留：

- 会话和 Turn 的界面选择状态。
- 文件选择窗口。
- 进度、通知和取消按钮。
- 后台线程调度。

`wake-core` 负责：

- 设置加载和字段更新。
- 标准 Markdown 渲染。
- 机械压缩。
- Jev 请求、判断和应用。
- Chunk 打包与字符预算。
- 可选 LLM 请求。
- 最终 Markdown 组装。
- Memory candidates 提取。
- 派生文件读写。

### 9.1 压缩执行流程

```text
读取最新持久化设置 + 单次覆盖参数
-> 读取会话并生成标准 Markdown
-> 机械压缩
-> 可选 Jev
-> 可选 LLM
-> 组装最终 Markdown
-> 原子写入输出文件
-> 返回统计和 Memory candidates
```

支持四种模式：

| Jev | LLM | 输出 |
|---:|---:|---|
| 关闭 | 关闭 | 机械压缩文件 |
| 开启 | 关闭 | 机械压缩 + Jev 后的文件 |
| 关闭 | 开启 | 机械压缩 + LLM 文件 |
| 开启 | 开启 | 机械压缩 + Jev + LLM 文件 |

Jev adapter 返回 Detail 判断；Rust 压缩服务应用判断、组装并写入最终 Markdown。因此 Jev 不依赖 LLM，也可以独立参与生成最终文件。

### 9.2 设置模型

内部运行设置与公开设置分开：

```text
CompressionRuntimeSettings
  - 执行使用
  - 可包含从本机配置读取的凭据

CompressionPublicSettings
  - GUI / MCP / CLI 展示与修改
  - 不包含密钥明文
  - 只包含 api_key_configured
```

不新增独立 JSON/TOML Policy 文件，继续使用当前 ContextOS 设置存储。单次 `compression run` 可以提供临时覆盖参数，但不能覆盖 API Key。

### 9.3 输出文件

- `run` 必须明确提供输出文件或目录。
- 默认不覆盖已有文件；`overwrite: true` 才允许覆盖。
- 先写同目录临时文件，再原子替换。
- 新生成文件包含 ContextOS 来源标记、来源 session keys、设置摘要和内容哈希。
- 没有来源标记的旧 Markdown 默认只读。
- 编辑派生文档时提交上次读取到的内容哈希，文件已变化则拒绝覆盖。
- 删除进入操作系统回收站，不提供永久删除或恢复。

### 9.4 Memory candidates

压缩只生成并返回候选，不自动写入 Memory：

```text
compression run
-> 返回 memory_candidates
-> Agent 判断
-> memories create
```

---

## 10. 能力边界与必要检查

不建设额外安全框架。MCP/CLI 暴露的领域和 operation 就是能力边界。

实现只保留功能正确运行所必需的检查：

- operation 必须是代码中显式允许的分支。
- 必填参数和类型必须正确。
- 目标会话、关系或文件必须存在。
- 关系不能指向自身。
- 自动关系不能通过写 operation 修改。
- 非 ContextOS Memory 和非 ContextOS 派生文档不能修改。
- 默认不能覆盖已有文件。

不存在以下 operation：

- 原始消息更新。
- 永久删除。
- 回收站恢复。
- 索引重建。
- Remote Hosts。
- 旧 Wake 隐藏功能。

---

## 11. 验证策略

不新增面向用户或 Agent 的测试功能，也不建设新的大型自动化测试体系。

采用以下方式：

1. 保留并更新项目现有的 MCP stdio、工具定义和 CLI 合约测试。
2. 接口变化导致现有测试失效时，同步更新断言。
3. 可在现有临时数据库端到端测试中保留一条最小写链路，确认 MCP/CLI 确实能写入。
4. 开发 Agent 使用临时或样本数据，通过真实 MCP/CLI 调用验证各领域 operation。
5. 压缩通过真实 `run -> get_document` 链路验证，不增加 `test` operation。

Agent 的实际调用是主要功能验证方式；现有自动化测试只承担基础协议和回归保障。

---

## 12. 实施方式

六个领域可以一起开始，但共享基础先完成：

### 12.1 共享基础

- 增加已有数据库的可写打开方式。
- 定义统一结果与错误映射。
- 建立六个领域 handler。
- CLI 与 MCP 使用相同请求结构和 handler。

### 12.2 可并行领域

共享基础稳定后，可并行推进：

- sessions + relations
- settings + data_sources
- memories
- compression

Cleanup 的 `trash` 复用现有 `wake-core::cleanup`，不实现 restore。

### 12.3 集成收尾

- GUI 将需要共享的动作切换到 `wake-core service`。
- 现有 MCP 查询工具切换到领域 handler 或保留兼容转发。
- 更新 CLI/MCP 使用说明。
- 通过真实 MCP/CLI 调用完成验收。

预计一名熟悉项目的 Rust 开发者需要约 4-7 周。压缩逻辑从 GUI 下沉是主要工作量和风险来源。

---

## 13. 新功能开发规则

应用、MCP 和 CLI 一起编译发布。新增功能时：

```text
实现或修改 wake-core service
-> 在对应领域增加 operation
-> 更新 MCP Schema 与 CLI 帮助
-> 更新受影响的现有测试
-> Agent 通过真实 MCP/CLI 调用验证
-> 一起编译发布
```

属于现有领域的新功能不增加 MCP Tool 或 CLI 顶级命令。只有出现新的独立业务领域时，才考虑增加新的领域入口。

---

## 14. 验收标准

1. GUI、MCP、CLI 对共享业务调用同一 `wake-core service`。
2. 六个领域入口可以完成当前 ContextOS 页面中的业务操作。
3. MCP/CLI 可以读取和更新业务设置；GUI 重启后生效。
4. 原始会话不可编辑，会话只能移入系统回收站。
5. 不存在永久删除和恢复入口。
6. 手工关系可管理，自动关系保持只读。
7. ContextOS Memory 和派生文档可创建、读取、编辑并移入回收站。
8. 压缩支持机械、Jev-only、LLM-only、Jev + LLM 四种模式并输出文件。
9. Agent 可以通过 `settings update -> compression run -> get_document` 自行调整和验证压缩效果。
10. 旧 Wake 隐藏功能不会因底层代码仍存在而被 MCP/CLI 暴露。

