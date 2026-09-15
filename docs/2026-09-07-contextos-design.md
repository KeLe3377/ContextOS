# ContextOS 设计文档

> 跨 Agent 智能工作记忆与上下文管理系统

- 版本：V1.0
- 状态：Draft（待评审）
- 日期：2026-09-07
- 作者：Adam
- 来源：基于《跨Agent记忆系统》构想讨论整理

---

## 1. 概述

### 1.1 一句话定位

> 让 Claude Code、Codex 等 Agent 拥有持续、可管理、可迁移的工作记忆——**"AI 不知道我做到哪里" 的问题，由它来解决。**

### 1.2 产品定位

ContextOS 是一个**本地优先**的 Agent 上下文中间层基础设施，介于 Agent 客户端与本地数据之间：

```
  Claude Code    Codex    Cursor    (未来更多 MCP Client)
        |           |          |
        +-----------+----------+
                    |
             MCP / Hooks（Agent Gateway）
                    |
            ContextOS Daemon
                    |
      +-------------+-------------+
      |             |             |
 Memory Engine  Project Context  Rule Manager
      |             |             |
            SQLite (Prisma ORM)
                    |
                Web UI
```

### 1.3 与竞品的差异

| 产品 | 定位 | ContextOS 的差异 |
|-|-|-|
| EverMe | AI 个人记忆（"AI 记住我是谁"） | 我们做工作上下文（"AI 记住我做到哪里"） |
| Mem0 / LangMem | Memory API / 框架组件 | 我们是面向开发者的完整工作空间，含 UI 与规则管理 |
| Notion AI | 知识管理 | 我们绑定 Agent 工作流，自动采集而非手动记录 |

核心差异点：
- **入口是 Session 连续性**，不是"拥有记忆"；
- **Human in Control**：记忆可人工审阅、修改、删除，带来源追踪；
- **不做 AI 人格画像**，只做工作偏好与项目事实；
- **本地优先**：我的记忆属于我，不属于某个平台。

### 1.4 非目标

- ❌ 通用聊天机器人
- ❌ AI 人格分析 / "被推断的你"
- ❌ 自动生成大量技能（Skill）碎片
- ❌ 替代 Claude Code / Codex 本身

---

## 2. 核心设计原则

### 2.1 Local First

所有数据（对话记录、记忆、项目上下文、规则）默认存本地 SQLite，不上传云端。Agent 上下文包含项目代码与商业数据，隐私是底线。云端同步作为远期可选能力。

### 2.2 Human in Control

AI 负责**提取、总结、推荐**；用户负责**确认、修改、删除**。记忆写入遵循类 Git 的提交模型：

```
Conversation → Extractor → Candidate Memory → User Review → Permanent Memory
（类比：working tree → staged → commit）
```

### 2.3 Source Traceability

每条记忆必须有来源（某次会话、某条消息、或用户手动创建）。用户任何时候都能回答"AI 凭什么认为这样"。对话记录本身**只读不可伪造**（不能手动新增对话，只能由真实会话采集产生）。

### 2.4 Context over Profile

记忆模型四类（Facts / Preferences / Project Context / Rules），全部服务于"帮助 Agent 更好地继续工作"，不做心理画像式标签。

---

## 3. 记忆模型

### 3.1 四类记忆

| 类型 | 说明 | 来源 | 可编辑性 |
|-|-|-|-|
| **Facts（事实）** | 用户使用 Python、项目叫 Agent 拆解 | 会话提取 / 手动 | 修改需保留来源或标注手动 |
| **Preferences（偏好）** | 喜欢深入原理、先结论后分析 | 手动为主，会话可建议 | 自由编辑（等同 Custom Instructions） |
| **Project Context（项目上下文）** | 项目状态、架构决定、TODO、踩坑记录 | 会话提取 + 人工维护 | 自由编辑（人工维护是刚需） |
| **Rules（规则）** | 生成 CLAUDE.md / AGENTS.md 的规则源 | 手动 | 自由编辑，同步生成 |

### 3.2 记忆生命周期

```
active（生效中）
  → candidate（候选，待用户确认）
  → superseded（被更新版本替代，保留历史）
  → archived（归档，不再注入但可查）
  → deleted（软删除）
```

每条记忆带 `confidence`（提取置信度）与 `source`（来源引用）。修改产生新版本，旧版本标记 superseded 而非覆盖——记忆的 Git 历史。

---

## 4. 总体架构

### 4.1 服务组成

```
ContextOS（pnpm monorepo）
├── Agent Gateway        # MCP Server + Hooks 接入层
├── Session Collector    # 会话采集与总结
├── Memory Engine        # 提取 / 分类 / 评分 / 生命周期
├── Context Builder      # 启动时组装上下文包
├── Rule Manager         # 规则统一管理 + 多平台同步
├── Storage Layer        # Prisma + SQLite（FTS5 全文检索）
└── Web Interface        # 管理界面
```

### 4.2 运行模型：Daemon + 无感启动

用户不显式启动。安装后：

- **Claude Code**：`~/.claude/settings.json` 注册 SessionStart Hook → 检测 daemon 未运行则拉起 → 注入恢复上下文；SessionEnd Hook → 触发会话总结与记忆提取。
- **Codex**：全局 `~/.codex/AGENTS.md` 注入引导块 + MCP 配置接入。
- **兜底**：daemon 掉线时，Hook/MCP 调用方自动尝试拉起（单实例锁 + 端口探测，监听 `localhost:7777`）。
- **开机自启**（V0.2+）：Windows 服务 / launchd / systemd。

### 4.3 关键数据流

**流程 A：会话记录（Session End）**

```
SessionEnd Hook / 会话文件变更
  → Session Collector 落库原始对话（只读归档）
  → LLM 异步生成 Session Summary
  → Memory Engine 提取候选记忆（带来源与置信度）
  → 状态 candidate，等用户在 Web UI 审阅
```

**流程 B：上下文恢复（Session Start）**

```
SessionStart Hook（携带 cwd）
  → 解析当前项目（按 path 匹配 Project）
  → Context Builder 组包：
      项目 Overview / 最近 Decision / 未完成 TODO
      + 最近 N 次 Session Summary
      + 用户 Preferences
      + 该项目 Rules
  → 排序压缩至预算（约 2K tokens）
  → 注入 Agent 上下文
```

**流程 C：规则同步（Rule Manager）**

```
用户在 Web UI 维护规则事实（单一事实源）
  → 按 target（claude / codex / cursor）渲染
  → 生成 ~/.claude/CLAUDE.md、~/.codex/AGENTS.md、<project>/CLAUDE.md 等
  → 写入前 diff 预览 / 备份旧文件
```

---

## 5. 模块设计

### 5.1 Agent Gateway（MCP Server）

MCP Tools：

| Tool | 用途 | 说明 |
|-|-|-|
| `context_load` | Agent 启动加载上下文 | 入参 cwd，返回项目状态 + 最近工作 + 相关规则 |
| `memory_search` | Agent 主动查询记忆 | 全文（V0.x）/ 向量（远期）检索 |
| `memory_write` | 写入候选记忆 | 一律进 candidate，不直接生效 |
| `session_log` | 会话事件上报 | 供无 Hook 能力的 Agent 补录 |

MCP 是首选通道（未来所有 Agent 都会支持）；Hooks 是 Claude Code 侧的增强（无感启动 + 自动采集）。

### 5.2 Session Collector

- 输入：Claude Code Hook 事件、transcript 文件、或 MCP `session_log`。
- 落库策略：原始对话只读归档（messages 表），绝不允许 UI 新增/改写对话原文；仅 summary 与提取物可编辑。
- 总结：会话结束后异步调用 LLM（用户可配 API 或复用本机 Agent），生成结构化 Summary（做了什么 / 决定了什么 / 待办 / 遗留问题）。

### 5.3 Memory Engine

- **提取**：LLM 结构化输出（type / content / confidence / source_span）。
- **评分（Context Builder 排序用）**：
  `score = 0.4·relevance + 0.3·recency + 0.2·frequency + 0.1·importance`
- **去重与冲突**：新候选与既有记忆语义相近时进入"更新建议"而非新增；矛盾时标记冲突待用户裁决。
- **压缩**：分层摘要（session → project → global），控制注入预算。

### 5.4 Context Builder

Agent 启动场景的核心价值模块。输入 = 当前项目 + 用户偏好 + 相关记忆 + 规则；输出 = 预算内的上下文包。所有注入内容记录 memory_event（供"复用/有效性分析"）。

### 5.5 Rule Manager

- 内部统一规则格式（scope: global/project × target: claude/codex/cursor × content × priority）。
- 单一事实源在库内，`*.md` 是**生成物**，生成时 diff 预览 + 备份。
- 首次接入可反向导入既有 CLAUDE.md / AGENTS.md。

### 5.6 Web Interface

页面结构（左侧导航，非人格画像式仪表盘）：

```
Workspace
├── Projects     # 项目树：Overview / Decisions / TODO / Problems / Sessions / Rules
├── Sessions     # 会话时间线（今天 / 昨天 / 历史），只读 + Summary 可修正
├── Memory       # 记忆管理：审阅候选 / 编辑 / 删除 / 查看来源与调用统计
├── Rules        # 规则管理 + 目标文件同步预览
└── Analytics    # 记忆调用次数、被哪些 Agent 使用、有效性（远期）
```

记忆卡片必须展示：类型 / 来源（会话 ID 或"手动创建"）/ 置信度 / 更新时间 / 调用次数。

---

## 6. 数据库设计（SQLite + Prisma）

```prisma
model Project {
  id          String   @id @default(cuid())
  name        String
  path        String   @unique      // 工作目录，识别当前项目
  description String?
  createdAt   DateTime @default(now())
  sessions    Session[]
  memories    Memory[]
}

model Session {
  id        String    @id            // 沿用 Agent 侧 session id
  agent     String                   // claude-code | codex | ...
  projectId String?
  project   Project?  @relation(fields: [projectId], references: [id])
  cwd       String?
  startTime DateTime
  endTime   DateTime?
  summary   String?                  // LLM 生成，可人工修正
  messages  Message[]
}

model Message {
  id        String   @id
  sessionId String
  session   Session  @relation(fields: [sessionId], references: [id])
  role      String                 // user | assistant | tool | ...
  content   String
  timestamp DateTime
}

model Memory {
  id         String   @id @default(cuid())
  type       String                 // fact | preference | project | rule | session_summary
  content    String
  projectId  String?
  project    Project? @relation(fields: [projectId], references: [id])
  sourceType String                 // session | manual
  sourceRef  String?                // session/message id
  confidence Float    @default(1.0)
  status     String   @default("active")  // candidate|active|superseded|archived|deleted
  versionOf  String?                // 指向被替代的旧版本
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
  events     MemoryEvent[]
}

model Rule {
  id       String @id @default(cuid())
  scope    String              // global | project
  target   String              // claude | codex | cursor | all
  content  String
  priority Int    @default(0)
}

model MemoryEvent {             // 调用/有效性追踪（Analytics 数据源）
  id        String   @id @default(cuid())
  memoryId  String
  memory    Memory   @relation(fields: [memoryId], references: [id])
  event     String              // injected | searched | edited | confirmed
  agent     String?
  createdAt DateTime @default(now())
}
```

检索：V0.x 用 SQLite FTS5 全文检索（记忆量级下够用，避免第一版引入向量库）；远期迁移 PostgreSQL + pgvector。

---

## 7. 技术选型

| 层 | 选型 | 理由 |
|-|-|-|
| 语言 | TypeScript 全栈 | MCP 生态天然偏 TS；前后端共享类型；目标用户全在 Node 生态；CLI/daemon 一体 |
| Monorepo | pnpm workspace | 多包（daemon / web / cli / mcp-server / shared）共享类型与工具链 |
| 后端 | NestJS | 模块多（Memory/Project/Session/Rule），需要结构化分层；daemon 与 MCP Server 同进程部署 |
| 前端 | Next.js + Tailwind + shadcn/ui | 标准组合；未来登录/分享/云同步留余地 |
| 图可视化 | React Flow（V0.2+） | 记忆树/知识树 |
| ORM/DB | Prisma + SQLite | 本地零依赖；后续平滑切 PostgreSQL |
| 检索 | SQLite FTS5 | 第一版不引入向量库 |
| MCP | @modelcontextprotocol/sdk | 官方 TS SDK |
| LLM 调用 | 统一 LLMProvider 封装（Anthropic / OpenAI / 复用本机 Agent） | 总结与提取 |

目录结构：

```
contextos/
├── apps/
│   ├── daemon/        # 常驻服务：API + 采集调度 + MCP Server
│   ├── web/           # Next.js 管理界面
│   └── cli/           # contextos init/start/status/memory/project
├── packages/
│   ├── database/      # Prisma schema + client
│   ├── memory-engine/ # 提取/评分/生命周期
│   ├── mcp-server/    # MCP tools 定义
│   └── shared/        # 共享类型
└── docs/
```

---

## 8. 分阶段路线（总路线）

### V0.1 — Session 连续性（核心闭环验证）

> 验证命题：**"昨天干了一半的项目，今天打开 Claude Code，它真的能接着干。"**

- Claude Code 接入（SessionStart/SessionEnd Hooks + MCP）
- 会话采集落库 + LLM 自动总结
- Context Builder：启动时注入项目状态 + 最近工作 + 待办
- Web UI：仅查看（项目列表 / 会话时间线 / Summary）
- 技术：daemon + SQLite + Prisma + 最小 Next.js

不做：多 Agent、记忆树、规则管理、Analytics、向量检索。

### V0.2 — 记忆管理与树状 UI

- Memory Engine 完整版：候选审阅流（Human in Control 闭环）、版本化、冲突提示
- Web UI 完整版：Memory 管理（编辑/删除/来源展示）、项目树（开发/测试/维护等统一分类格式）、React Flow 树状图
- 开机自启（Windows 服务 / launchd / systemd）

### V0.3 — Agent 规则管理

- Rule Manager：单一事实源 → 生成 CLAUDE.md / AGENTS.md / .cursor/rules
- 生成 diff 预览 + 备份；反向导入既有文件
- Web UI Rules 页面

### V0.4 — 跨 Agent 同步

- Codex / Cursor 接入（MCP + 各自 Hook/规则机制）
- 跨 Agent 共享项目记忆；MemoryEvent 调用统计（"被哪些 Agent 使用"）

### 远期方向

- PostgreSQL + pgvector 向量检索、记忆分层压缩（RLM-Switch 工程版）
- Memory Evolution：过期/冲突检测与更新建议
- 云备份 / 团队共享版（权限、审计）
- 有效性分析：记忆 → 调用 → 结果反馈（★★★★★ 评级）

---

## 9. 风险与对策

| 风险 | 对策 |
|-|-|
| 用户是否真需要 | V0.1 只验证 Session 连续性单一命题；先自用（"Agent 拆解"系列实验平台） |
| Agent 平台接口变化 | MCP 抽象为主通道，Hook 适配层薄封装，按 Agent 隔离 |
| 记忆质量（记什么/忘什么） | 候选审阅制 + 来源追踪 + 版本化，人工可纠偏 |
| 上下文过长 | Context Builder 预算压缩 + 分层摘要（session→project→global） |
| LLM 总结成本/隐私 | 本地调用优先；API Key 用户自配；总结异步不阻塞会话 |

---

## 10. 成功指标（V0.1 自用阶段）

- 每天 Claude Code 会话结束后，无需手工整理即产生可用 Summary
- 次日启动，恢复上下文准确反映"上次做到哪里 / 下一步"（自评 ≥80% 会话可用）
- 注入上下文 ≤2K tokens，不显著拖慢启动

---

## 附：命名

- 项目名：**ContextOS**（Context = 上下文，OS = 操作系统定位）
- CLI 命令：`contextos`
- npm 包名（若发布）：`contextos`
- 备注：项目开发完成后，视情况决定是否改为 **Adam-ContextOS**（个人 IP 前缀），仅影响仓库名/包名，不影响代码内部命名
