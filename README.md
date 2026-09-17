# ContextOS

> Local-first Agent Workspace and work-context governance for developers.

ContextOS 是一个本地优先的 Agent 工作空间。它面向每天使用 Claude Code、Codex、Cursor 等编码 Agent 的开发者，帮助你保存项目连续性、追踪真实工作过程、治理可复用上下文，并明确控制 Agent 可以自动做什么。

它不是“让 AI 记住你是谁”的个人记忆产品，而是“让工作知道做到哪里了”的项目上下文系统。

## 解决什么问题

开发者现在经常同时使用多个 AI 编程 Agent，但这些 Agent 之间天然是割裂的：

- 昨天的会话、今天的 Agent 不知道做到哪里了；
- 为什么采用某个方案、哪些方案已经否决、哪些问题还没收尾，常常散在聊天记录里；
- Claude Code、Codex、Cursor 各自有配置和规则，难以统一治理；
- 对话总结、项目记忆、规则、待办和决策容易混在一起，后续很难判断什么是原始证据，什么是 AI 派生内容；
- Agent 自动化越来越强，但哪些动作需要提示、警告、审核或阻止，需要一个可检查的控制层。

ContextOS 的目标是把这些内容放进一个本地、可追溯、可审阅的工作空间里。

## 产品定位

ContextOS 是：

- 本地运行的 Agent Workspace；
- 项目级工作上下文和治理容器；
- Agent 会话、证据、派生上下文、决策、工作项和规则的管理界面；
- Claude Code、Codex、Cursor 等 Agent 的统一接入层；
- 一个帮助用户“继续工作”的系统，而不是泛化知识库或聊天机器人。

与 OpenViking、Nowledge、EverMe 这类记忆管理产品相比，ContextOS 的边界更窄，也更工程化：

- 不是个人记忆库，而是项目级工作上下文；
- 不是让 AI 形成“我是谁”的长期画像，而是记录“这个项目做到哪里、为什么这样做、下一步是什么”；
- 不是把对话沉淀成泛化知识图谱，而是把原始证据、派生上下文、决策、工作项和规则分层治理；
- 不是跨应用的通用 AI 记忆层，而是围绕 Claude Code、Codex、Cursor 等编码 Agent 的工作连续性；
- 不是云端 AI Dashboard，而是本地 daemon + 本地数据库 + 可审计证据链；
- 不是聊天机器人或营销展示页，而是开发者每天继续工作的操作台。

## 核心对象

新版设计把 ContextOS 拆成几个清晰的产品对象：

| 对象 | 作用 |
|---|---|
| `Project` | 工作区边界和治理容器，定义项目根目录、可用 Agent、默认规则和上下文来源 |
| `Session` | 一次真实 Agent 工作 episode，记录意图、运行状态、加载的上下文、证据和产物 |
| `Review Item` | 需要人工处理的治理问题，例如规则冲突、证据变化或高风险动作 |
| `Decision` | 版本化的长期决策，记录选择、背景、理由、备选方案和后果 |
| `Work Item` | 可执行的工作单元，包含完成标准、依赖、就绪度、执行尝试和结果 |
| `Rule` | 声明式治理规则，定义条件、效果、适用范围、优先级和执行模式 |
| `Context Source` | 被纳入治理的上下文来源，例如项目文档、会话 transcript 或本地目录 |
| `Evidence Snapshot` | 不可变的原始证据快照 |
| `Context Item` | 从证据或其他来源派生出的上下文内容，必须带来源和版本 |

其中 Context 是支撑域，不再作为“记忆流”或“知识图谱”出现。Context 页面管理的是来源、快照、派生内容、新鲜度、可用性和 provenance。

## 工作方式

典型流程如下：

```text
Project
  -> 配置 Context Sources、Rules、Agent adapters
  -> 启动或继续 Session
  -> 构建 Context Package
  -> Agent 执行工作
  -> 保存原始 transcript / tool payload 为 Evidence Snapshot
  -> 生成 Resume Capsule、Context Item、Activity、Audit
  -> 触发 Rule evaluation
  -> 必要时进入 Review Inbox
  -> 形成 Decision 或更新 Work Item
```

用户可以在 Overview 中看到最近项目、最近会话、下一步 Work Items、待处理 Review Items 和上下文健康状态，然后用 `Continue in Agent` 继续工作。

## 页面结构

正式导航保持很小：

```text
WORKSPACE
Overview
Projects
Sessions

GOVERNANCE
Review Inbox
Decisions
Work Items
Context

SYSTEM
Rules
```

每个对象页面只拥有自己的对象。例如 Projects 页面只管理 Project，Sessions 页面只管理 Session，Rules 页面只管理 Rule。其他模块只能以 ID、短标题、数量、链接或 provenance 的形式出现，不能把别的模块的完整表格或编辑器嵌进来。

Overview 是唯一允许聚合多个对象的页面，但它只服务于“恢复工作”，不做大而全的分析看板。

## 设计原则

- **本地优先**：第一阶段单机单用户，daemon 只监听 `127.0.0.1:4721`，数据保存在本地。
- **证据不可变**：原始对话和 Evidence Snapshot 只读，不允许静默改写。
- **派生内容可治理**：Resume Capsule、Context Item、总结等派生内容可以编辑，但必须版本化并保留 provenance。
- **人控制关键动作**：AI 可以提议，用户控制激活、审核、归档、覆盖和破坏性动作。
- **显式生命周期**：重要状态变化通过 action endpoint 完成，例如 accept、archive、continue、activate，而不是随意 PATCH 一个 status。
- **跨 Agent 一致**：Agent 差异封装在 adapter 中，核心领域只关心统一的 Session、Evidence 和 Context 模型。
- **页面职责清晰**：每页只管理一个对象，跨模块关系保持为引用。

## 技术方向

当前设计基线采用：

- TypeScript + Node.js；
- 本地 daemon；
- SQLite + better-sqlite3 + Drizzle migrations；
- 模块化单体架构；
- 资源型 REST API；
- revision 并发控制；
- Idempotency-Key；
- append-only Evidence Store；
- 可恢复后台 Job、lease、retry 和 outbox；
- Claude Code、Codex、Cursor 统一 Agent Adapter。

前端当前已有一个静态原型，位于：

```text
frontend/index.html
```

这个原型用于确认信息架构、视觉密度和页面关系。后端稳定后，正式前端建议迁移为 React + TypeScript + Vite，并用真实 API 替换静态数据。

## 本地启动

Windows 上推荐使用一键脚本：

```powershell
cd D:\project\ContextOS
npm run start:local
```

脚本会在缺少依赖时运行 `npm install`，启动本地 daemon，并打开：

```text
http://127.0.0.1:4721/api/health
frontend/index.html
```

默认数据目录是 `.contextos/`，数据库是 `.contextos/contextos.sqlite`。这些本地运行数据已经被 `.gitignore` 排除。

也可以手动启动 daemon：

```powershell
npm install
npm run dev
```

## 基本测试流程

1. 打开 `frontend/index.html`。
2. 在 Projects 创建或确认一个项目，Root path 使用不带外层引号的绝对路径，例如 `D:\project\ContextOS`。
3. 在 Sessions 点击 `New Session`，填写 title 和 intent。
4. 点击该 session 行内的 `Continue in Agent`，ContextOS 会生成 Context Package 和 handoff evidence，然后启动 Codex CLI。
5. 回到 Sessions 页面刷新，可以在 Latest Session Context 里看到 Context Package ID 和 `ContextOS handoff prompt` evidence。

当前版本可通过 `POST /api/sessions/:id/import-transcript/auto` 从本机 Codex session 目录发现并导入 transcript。发现范围严格限制在 Session 所属 Project root；首次导入绑定 Codex session ID，后续只读取同一会话。它不会后台实时采集后续消息，也没有自动轮询。

运行中的 Codex Session 可通过 `GET /api/sessions/:id/runtime-status` 查询当前 Run 和受管进程状态，并通过 `POST /api/sessions/:id/interrupt`（请求体包含 `expectedRevision`）终止进程树。中断后 Session 进入 `PAUSED`，Job 和 Run 记录为 `CANCELED`。

`Continue in Agent` 会根据 Session 是否已绑定 `externalSessionId` 自动选择行为：未绑定时启动新 Codex 会话；已绑定时使用明确 UUID 执行 `codex resume`，校验该会话属于当前 Project，并为每次恢复创建新的 Job 和 Run。当前仍需先通过 transcript 自动导入绑定首次启动产生的 Codex UUID，resume 结束后的 transcript 也尚未自动回收。

## Codex Adapter

当前 registry 只启用 Codex adapter。Windows 默认命令是 `codex.cmd`，非 Windows 默认命令是 `codex`。可以用环境变量覆盖：

```powershell
$env:CONTEXTOS_CODEX_COMMAND="codex.cmd"
$env:CONTEXTOS_CODEX_ARGS='["--help"]'
npm run dev
```

Codex adapter 已实现 `discover`、`launch`、`resume`、`inspectStatus`、`interrupt` 和 `importTranscript` first pass，并通过共享 adapter contract tests。Claude Code 和 Cursor 尚未启用。

## 验证

提交前建议运行：

```powershell
node --check frontend/app.js
npm run build
npm test
```


