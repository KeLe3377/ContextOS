# agent_chat_extractor 与 ContextOS 对比记录

日期：2026-09-18

## 1. 结论

`agent_chat_extractor` 值得 ContextOS 学习，但不适合在当前阶段直接并入主线设计。

当前 ContextOS 原设计已经接近完成，重点应继续沿既有 Productization Plan 收口：先完成现有 Sessions、Context、Evidence、Review、Decision、Work Item、Rules 和 UI detail workspace，而不是现在扩展成多来源 transcript 采集平台。

本次对比的定位是：

- 记录 `agent_chat_extractor` 在多 Agent transcript 发现、解析和容错上的经验。
- 作为后续 Adapter / Transcript Import 深化的参考材料。
- 不改变当前阶段的架构边界。
- 不新增当前迭代范围内的复杂度。

## 2. 两个项目的定位差异

### agent_chat_extractor

`agent_chat_extractor` 是一个轻量 Python CLI，用于从本机多种 AI 编码工具中提取历史会话，并统一输出 JSONL。

它的核心优势是覆盖面和格式知识：

- 支持 Claude Code、Codex CLI、Cursor、Windsurf、Trae、Continue、Gemini CLI、OpenCode、Cline / Roo Code、Aider、DeepSeek Harness、ZCode 等来源。
- 每个来源只需要实现 `find_installations()` 和 `extract()`。
- 对未知或变化频繁的本地存储格式采用 best-effort 解析。
- 更适合“备份 / 训练数据 / 个人分析 / 一次性导出”。

### ContextOS

ContextOS 是本地优先的 Agent Workspace 和项目级工作上下文治理系统。

它的核心优势是产品化闭环和治理：

- Project / Session / Evidence / Context Item / Decision / Work Item / Review Item / Rule 等领域对象清晰。
- Transcript import 进入 Evidence Snapshot，并带有 hash、storageRef、metadata、Activity、Audit 和 Resume Capsule。
- Codex 和 Claude Code adapter 已经有 launch、resume、inspect、interrupt、importTranscript 的 first pass。
- 重点是“继续工作”和“证据可追溯”，不是单纯导出所有历史聊天。

因此，两者不是替代关系。`agent_chat_extractor` 可以作为 ContextOS 后续扩展 transcript source 的参考实现，但 ContextOS 不应把当前主线改成通用采集器。

## 3. 当前不调整设计的原因

当前 ContextOS 已经接近原设计完成态，贸然吸收 `agent_chat_extractor` 的全部能力会带来三个风险：

1. **架构范围膨胀**

   如果现在引入 Cursor、Cline、OpenCode、Aider、DSH、ZCode 等 import source，ContextOS 会从“Codex / Claude Code 可运行 Agent Workspace”扩成“多工具 transcript ingestion hub”。这会改变 Phase 10 之前的工作重心。

2. **数据模型过早复杂化**

   `agent_chat_extractor` 保留了 tool calls、tool results、reasoning、usage、source_kind、subagent lineage 等结构化字段。它们很有价值，但如果现在进入 ContextOS Evidence / Resume Capsule / UI，会牵动 contracts、metadata、Evidence detail、Context Package 选择逻辑和前端展示。

3. **影响收口节奏**

   Productization Plan 当前强调先完成已有产品对象的 detail workspace 和真实工作流。现在新增多来源解析会拉长 Adapter 深化阶段，推迟核心产品闭环完成。

所以当前决策是：**先按原设计继续做完；本次对比只沉淀为后续参考。**

## 4. ContextOS 可以学习的点

这些点适合后续进入 Phase 10: Adapter Deepening 或更晚阶段再考虑。

### 4.1 区分可运行 Adapter 和只读 Transcript Source

ContextOS 当前的 `AgentAdapter` 同时承担：

- discover
- launch
- resume
- inspectStatus
- interrupt
- importTranscript

这适合 Codex 和 Claude Code，但不一定适合所有工具。

`agent_chat_extractor` 的来源模块更轻，只关心发现安装位置和抽取会话。后续 ContextOS 可以考虑增加一个独立概念，例如：

```text
Runnable Agent Adapter:
  discover / launch / resume / inspect / interrupt / import current transcript

Transcript Source:
  discover / import historical transcripts only
```

这样 Cursor、Cline、OpenCode、Aider、DSH 等可以作为 import-only source 进入 ContextOS，而不必伪装成能被启动或恢复的 Agent。

当前阶段不做这个拆分。

### 4.2 保留结构化 transcript 的经验

ContextOS 当前 import 主要把 transcript 转成 `USER:` / `ASSISTANT:` 文本，并把 message count、role count、turn count、ordinal 范围写进 metadata。

这对 Resume Capsule 和 Evidence first pass 足够。

`agent_chat_extractor` 展示了后续可以保留的结构化信息：

- Claude Code 的 `tool_use` 和 `tool_results`。
- DSH 的 `reasoning`、`model`、`provider`、`usage`。
- DSH 的 `source_kind`，用于区分真实用户输入和运行时注入上下文。
- subagent lineage，例如 parent session、origin、delegation depth、seeded flag。

后续如果 ContextOS 要做更精细的 replay、训练数据导出、tool event timeline 或 agent behavior analytics，可以参考这些字段。

当前阶段不把这些字段提升为核心合同。

### 4.3 多来源发现路径

`agent_chat_extractor` 对不同工具的本地存储路径有较多经验：

- macOS / Linux / Windows app data roots。
- VS Code 系工具的 `globalStorage` / `workspaceStorage`。
- Codex 的 `~/.codex/sessions/**/rollout-*.jsonl`。
- Claude Code 的 `~/.claude/projects/**/*.jsonl`。
- Cline / Roo Code 的 task 文件夹。
- OpenCode 的 session / message / part 树。
- Aider 的项目内 `.aider.chat.history.md`。

这些可以作为后续新增 transcript source 时的路径参考。

当前阶段继续只维护 Codex 和 Claude Code first pass。

### 4.4 容错解析细节

`agent_chat_extractor` 里有几类很实用的容错经验：

- JSON / JSONL 读取处理 UTF-8 BOM。
- SQLite 读取先复制临时文件，避免运行中 app 锁库。
- 日期过滤统一处理 ISO、epoch seconds、epoch milliseconds、compact date 等格式。
- DSH zstd 日志是多帧拼接，不能只读第一帧。
- malformed JSONL 行跳过，不让一条坏记录中断整次导入。
- heuristic parser 只作为 best-effort，文档明确其不稳定边界。

ContextOS 后续做更广泛 transcript import 时，可以直接把这些转成测试 fixture 和 parser 约束。

当前阶段不引入通用 heuristic parser。

## 5. ContextOS 已经更强的点

这些能力不需要从 `agent_chat_extractor` 迁移，应该保持 ContextOS 现有方向。

### 5.1 Evidence-first 存储

ContextOS 的 transcript import 不是简单写 JSONL，而是写 Evidence Snapshot：

- 文件内容 hash。
- project 分区 storageRef。
- atomic write。
- verify。
- recovery。
- metadata。
- Activity / Audit。

这比 `agent_chat_extractor` 的导出文件更适合长期治理。

### 5.2 Session 绑定和 Resume Capsule

ContextOS 会把导入 transcript 绑定到 Session 和 external agent session，并更新 Resume Capsule。

这符合 ContextOS 的产品目标：让用户知道一个项目工作做到哪里、下一步是什么。

`agent_chat_extractor` 没有这个产品对象层。

### 5.3 Adapter contract 和集成测试

ContextOS 已经有共享 adapter contract tests，并覆盖 discovery、launch metadata、resume metadata、transcript normalization、process output、inspect 和 interrupt。

后续新增 adapter/source 时，应优先延续 ContextOS 的 contract/test 风格，而不是复制 `agent_chat_extractor` 的脚本式测试结构。

## 6. 后续建议，但不进入当前迭代

等原设计完成后，可以按下面顺序吸收 `agent_chat_extractor` 的经验。

### Step 1: 深化 Codex / Claude Code transcript schema

先不要加新来源。

优先把已有 Codex / Claude Code 解析做深：

- message-level normalized schema。
- tool calls。
- tool results。
- output truncation。
- parser version。
- fixture-based parser tests。

这与 Productization Plan 的 Phase 10 一致。

### Step 2: 再抽象 import-only Transcript Source

当 Codex / Claude Code 的结构化 transcript 稳定后，再考虑把 `AgentAdapter.importTranscript` 下沉成复用 parser，并新增 import-only source。

### Step 3: 按风险选择新来源

建议顺序：

1. Cursor：产品定位中最重要的第三个编码 Agent。
2. Cline / Roo Code：文件结构简单，适合作为 import-only source。
3. OpenCode：树状 JSON 存储，解析边界清晰。
4. Aider：markdown transcript，形态不同但实现轻。
5. DSH：信息最丰富，但格式复杂，适合晚一点做。

### Step 4: 再考虑导出或训练数据能力

如果 ContextOS 后续要支持个人训练数据导出，可以参考 `agent_chat_extractor` 的 normalized JSONL 输出。

但这应作为独立能力，不应干扰 Evidence / Resume Capsule 主流程。

## 7. 当前行动项

当前不新增代码任务。

本次对比只产生以下记录：

- `agent_chat_extractor` 是后续 transcript source / parser 的参考项目。
- ContextOS 当前继续按 Productization Plan 推进。
- Cursor、Cline、OpenCode、Aider、DSH 等多来源导入全部延后。
- 结构化 transcript schema 只在 Phase 10 或后续进入。
- 当前阶段不拆 `AgentAdapter`，不新增 `TranscriptSource`，不改变 Evidence / Resume Capsule 合同。

## 8. 复盘判断

这次对比的真正价值不是“现在要加更多功能”，而是帮 ContextOS 确认边界：

```text
ContextOS 当前阶段：
  做完整、可追溯、能继续工作的本地 Agent Workspace。

不是当前阶段：
  做覆盖所有 AI 编码工具的 transcript ingestion hub。
```

先把原设计做完，后面再判断是否把 `agent_chat_extractor` 的经验产品化进 ContextOS。
