# ContextOS 设计文档 V2.0

> Agent Workspace 与工作上下文治理系统

- 版本：V2.0
- 状态：Draft（方案已收敛，待实现评审）
- 日期：2026-09-14
- 作者：Adam
- 基于：`2026-09-07-contextos-design.md`、跨 Agent 记忆系统讨论、`conversation-archivist` skill 实践反馈

---

## 1. 设计结论

### 1.1 一句话定位

> ContextOS 是连接 Agent、项目、会话历史、工作状态和规则的个人工作上下文层，让多个 Agent 能够持续完成一个长期项目。

ContextOS **不是更强的 Memory Engine**，也不是 EverMe、OpenViking 或 Nowledge Mem 的替代品。它的核心价值是：

- 把 Agent 的真实工作过程沉淀为可追溯的会话资产；
- 把会话中的状态、决策、问题和下一步整理成可管理对象；
- 让用户可以审阅、修改、归档这些派生内容；
- 在下一次 Agent 启动时，按项目和任务交付恰当的上下文；
- 统一维护跨 Agent 的规则和项目约束。

### 1.2 重新定义核心对象

ContextOS 不再以“Memory”作为唯一中心对象。系统由五类一等对象组成：

```text
Project       我正在维护的项目
Session       一次 Agent 工作过程
Decision      为什么这样做，以及哪些方案已经否决
Work Item     当前状态、TODO、问题和下一步
Rule          Agent 必须遵守的长期约束
```

记忆仍然存在，但它是 Context Item 的一种形式，服务于上述工作对象，而不是产品的唯一入口。

### 1.3 与已试用产品的关系

以下结论来自 2026 年 9 月 14 日的实际试用反馈，不代表对这些产品全部能力的评价：

| 产品 | 观察到的优势 | ContextOS 不重复的部分 |
|-|-|-|
| OpenViking | 上下文文件系统、资源组织、底层能力强 | 不把用户直接暴露在复杂的上下文数据库操作中 |
| Nowledge Mem | 自动与手动记忆能力较好 | 不以知识图谱作为主要工作管理界面，增加固定规范和项目分类 |
| EverMe | 自动提取和个人记忆体验 | 不做复杂“被推断的你”，提升派生内容的可编辑性和可追溯性 |
| TeamAI CLI | Rules、Skills、MCP 和多 Agent 配置治理 | 聚焦个人开发者的会话连续性和项目工作状态，而不是团队 Harness 管理 |

ContextOS 可以在未来接入这些系统，但 V0.x 不依赖它们，也不与它们竞争记忆算法。

---

## 2. 要解决的问题

### 2.1 Agent 每次都是新人

用户昨天可能已经：

```text
阅读了项目架构
排查了一个问题
否决了两个方案
完成了一部分实现
留下了测试或验证任务
```

但今天重新打开 Agent 后，仍然需要重新解释：

- 当前项目是什么；
- 上次做到哪里；
- 为什么采用当前方案；
- 哪些方案已经失败或被否决；
- 下一步应该做什么。

### 2.2 多个 Agent 之间无法共享工作状态

Claude Code 可能负责调查和设计，Codex 负责实现，Cursor 负责局部修改。它们可以共享代码，却不天然共享：

- 项目当前状态；
- 历史决策及理由；
- 已知问题；
- 用户对输出和工作方式的要求；
- 其他 Agent 最近做过什么。

### 2.3 现有 Memory 产品的管理方式不适合长期开发

ContextOS 重点解决以下管理缺口：

- 记忆总结缺少稳定规范；
- 知识图谱不等于项目管理；
- 自动生成的 Skill 可能只是一次性工作产物；
- 个人画像容易复杂化，但不一定能帮助当前工作；
- 记忆可被调用，却不容易人工修改、替换、归档和解释来源。

---

## 3. 产品边界

### 3.1 核心用户

- 高频使用 Claude Code、Codex、Cursor 等 Agent 的开发者；
- 独立开发者和长期维护多个项目的人；
- 使用 Agent 进行源码分析、实验、写作或产品开发的人；
- 需要在不同 Agent 之间切换工作的人。

### 3.2 V0.x 做什么

- 自动或半自动采集 Agent 会话；
- 保存真实会话的只读证据；
- 生成结构化 Session Summary 和上下文恢复文档；
- 管理 Project、Decision、Work Item、Context Item 和 Rule；
- 在下一次会话开始时生成 Context Package；
- 支持用户审阅、修改、删除或归档派生内容；
- 统一生成 Claude Code、Codex 等 Agent 所需的规则文件。

### 3.3 明确不做什么

- 不做通用聊天机器人；
- 不做心理分析或复杂人格画像；
- 不把自动生成 Skill 作为核心产品对象；
- 不在第一版自研向量数据库、知识图谱或复杂记忆算法；
- 不替代 Claude Code、Codex、Cursor 的执行能力；
- 不允许 Web UI 伪造或篡改原始对话；
- 不要求用户直接理解底层上下文数据库的全部概念。

---

## 4. 核心设计原则

### 4.1 Evidence First：证据优先

真实会话是系统最底层的证据。会话原文、工具调用和工具结果来自 Agent 适配器或本地 transcript，Web UI 不允许凭空新增对话。

```text
真实 Agent 会话
        ↓
不可变会话证据
        ↓
摘要、恢复文档、候选对象
        ↓
用户审阅和治理
```

### 4.2 Derived Content Is Editable：派生内容可以编辑

摘要、上下文恢复文档、候选记忆、决策说明、TODO 和问题记录都是对会话的解释或整理，不等同于原始证据。它们可以被用户修改，但必须保留：

- 来源会话；
- 来源消息或片段；
- 修改者；
- 修改时间；
- 版本关系。



### 4.3 Human in Control：用户控制生效内容

AI 可以提取和推荐，但不能默认为用户建立复杂画像，也不能让未审核的候选内容影响所有 Agent。

- 会话提取的长期对象默认进入 `candidate`；
- 用户手动创建的 Preference、Project Context 和 Rule 可以直接生效；
- 用户可以确认、编辑、归档、删除或标记冲突；
- 已经生效的内容被修改时产生新版本，而不是覆盖历史。

### 4.4 Context over Profile：工作上下文优先于个人画像

系统只记录对工作有帮助的偏好，例如：

```text
回答技术问题时先给结论，再解释原理。
代码修改前先检查现有测试。
```

不生成类似“用户是分析驱动型人格”的复杂推断标签。

### 4.5 Local First：本地优先

默认数据保存在本机。原始会话可能包含代码、商业信息和隐私内容，因此：

- 不强制上传云端；
- LLM Provider 由用户配置；
- 支持本地模型或用户自己的 API；
- 总结和提取失败不阻塞 Agent 正常工作；
- 用户可以配置保留、归档和删除策略。

---

## 5. 领域模型

### 5.1 分层模型

```text
┌─────────────────────────────────────────┐
│ Delivery Layer                           │
│ Context Package / MCP / Hook / Rule File │
├─────────────────────────────────────────┤
│ Governance Layer                         │
│ Decision / Work Item / Rule / Active     │
│ Context Item                             │
├─────────────────────────────────────────┤
│ Interpretation Layer                     │
│ Summary / Resume Doc / Candidate / Draft │
├─────────────────────────────────────────┤
│ Evidence Layer                           │
│ Session / Message / Tool Event / Source  │
└─────────────────────────────────────────┘
```

### 5.2 Project

项目是上下文的主要边界。通过工作目录识别项目，也允许用户手动修正。

```text
Project
├── Overview
├── Current Status
├── Decisions
├── TODO / Problems
├── Sessions
├── Context Items
└── Rules
```

项目不等于代码仓库。一个项目可以包含多个工作目录，也可以关联多个 Agent。

### 5.3 Session

Session 是一次 Agent 工作过程，不只是聊天窗口。

核心信息包括：

- Agent 类型；
- 项目和工作目录；
- 开始、结束时间；
- 原始记录位置；
- 会话状态；
- 生成的 Summary；
- 产生的 Decision、Work Item 和 Context Item；
- 最后一次可恢复状态。

`conversation-archivist` 中的三类关键输出可以直接映射到 Session：

| conversation-archivist 输出 | ContextOS 对象 |
|-|-|
| 智能命名归档文件 | Session Archive |
| 压缩后的精华对话 | Session Summary / Evidence Projection |
| 上下文恢复文档 | Resume Artifact / Context Package 输入 |

### 5.4 Evidence：会话证据

Evidence 是从 Agent 原始记录中规范化出来的只读内容：

- 用户消息；
- Agent 回复；
- 工具调用；
- 工具结果；
- Agent 自己生成的压缩摘要；
- 会话元数据。

原始 transcript 可以保留在其原位置，ContextOS 保存路径、哈希、解析状态和必要的规范化索引。这样既能追溯，又不强制复制所有大型工具输出。

### 5.5 Artifact：派生文档

Artifact 是由会话证据生成、但允许用户修改的文档：

- Session Summary；
- Context Resume Document；
- Candidate Extraction；
- Project Overview Draft；
- 冲突分析或更新建议。

Artifact 的修改不会改变 Evidence。每次编辑产生版本，并保留上一版内容。

### 5.6 Context Item：上下文条目

Context Item 是可以被 Context Builder 选中并注入 Agent 的工作信息，分为：

| 类型 | 示例 | 默认来源 | 默认状态 |
|-|-|-|-|
| `fact` | 项目使用 TypeScript 和 SQLite | 会话 / 手动 | candidate 或 active |
| `preference` | 输出先给结论，再解释原理 | 手动为主 | active |
| `experience` | 某种 MCP 配置需要提高超时时间 | 会话提取 | candidate |
| `project_context` | 当前正在实现 Session 恢复 | 会话 + 人工维护 | active |

Decision、Work Item 和 Rule 不放进 Context Item 的文本堆里，而是独立对象，保证可筛选、可统计和可执行。

### 5.7 Decision

Decision 记录：

```text
决定了什么
为什么这样决定
考虑过哪些替代方案
什么条件变化后需要重新评估
来源于哪次会话
当前状态：proposed / accepted / superseded / archived
```

示例：

```text
决定：V0.1 使用 SQLite，不引入向量数据库
理由：先验证会话连续性，不提前承担检索基础设施复杂度
来源：2026-09-14 ContextOS 设计讨论
```

### 5.8 Work Item

Work Item 统一承载项目中的工作状态：

- `todo`：下一步要做什么；
- `problem`：当前未解决的问题；
- `milestone`：已完成或计划完成的阶段；
- `experiment`：待验证的假设。

它与普通 Memory 的差异在于：Work Item 有状态、优先级和完成条件。

### 5.9 Rule

Rule 是用户明确要求 Agent 长期遵守的约束，例如：

- 编码规范；
- 测试要求；
- 项目架构限制；
- 输出格式；
- 隐私和安全约束。

Rule 是可直接编辑的治理对象，最终可以渲染为：

```text
~/.claude/CLAUDE.md
~/.codex/AGENTS.md
<project>/CLAUDE.md
<project>/AGENTS.md
.cursor/rules/*
```

---

## 6. 关键用户流程

### 6.1 首次安装和导入

```text
contextos init
        ↓
检测本地 Agent
        ↓
导入已有 CLAUDE.md / AGENTS.md
        ↓
注册 Claude Code 适配器
        ↓
创建本地数据库和默认项目
```

首次导入只建立来源为 `imported` 的 Rule 或 Artifact，不覆盖用户原文件。

### 6.2 Session Start：恢复工作

```text
Agent 启动
    ↓
适配器取得 cwd、agent、session id
    ↓
ContextOS Daemon 按路径识别 Project
    ↓
Context Builder 读取：
    当前状态
    未完成 Work Items
    最近 Decisions
    最近 Session Summary
    生效 Rules
    必要的 Preferences
    ↓
生成 Context Package
    ↓
通过 Hook 或 MCP 交付给 Agent
```

上下文包必须包含来源标识，便于用户或 Agent 追问“这条信息从哪里来”。

### 6.3 Session During：工作过程

V0.1 主要依赖 Agent transcript 或 Hook 采集完整会话。MCP 只提供轻量的显式操作：

- 搜索历史上下文；
- 查看当前项目状态；
- 提交一条候选 Decision 或 Work Item；
- 请求重新生成当前会话摘要。

所有来自 Agent 的写入都默认是候选，不直接修改已确认对象。

### 6.4 Session End：归档和提取

```text
Session End / transcript 可用
        ↓
保存 Session Manifest
        ↓
解析真实对话和工具事件
        ↓
生成 Session Summary
        ↓
生成 Resume Artifact
        ↓
提取 Candidate Decision / Work Item / Context Item
        ↓
写入 Review Inbox
```

提取失败时保留 Session 和原始证据，状态标记为 `summary_failed`，用户仍然可以查看和手动整理。

### 6.5 Review：用户治理

Review Inbox 展示：

- 新候选；
- 与现有对象相似的更新建议；
- 冲突对象；
- 缺少来源的内容；
- 摘要或恢复文档的待修订版本。

用户可以：

- Confirm；
- Edit；
- Merge；
- Archive；
- Delete；
- Mark as incorrect；
- Open source session。

### 6.6 跨 Agent 恢复

Claude Code、Codex 和 Cursor 使用同一个 Project Context，但每个 Agent 可以拥有自己的适配器偏好：

```text
共享：
    Project / Decision / Work Item / Active Context / Rules

按 Agent 调整：
    注入格式 / 预算 / Hook 方式 / 工具名称 / 会话标识
```

---

## 7. 上下文构建

### 7.1 Context Package 结构

```json
{
  "project": {
    "id": "project_001",
    "name": "ContextOS",
    "path": "D:/project/ContextOS"
  },
  "currentStatus": {
    "summary": "正在收敛 Agent Workspace V2 设计",
    "source": ["session_2026_09_14"]
  },
  "nextSteps": [
    {
      "content": "确定 Session、Artifact 和 Context Item 的数据模型",
      "source": ["work_item_001"]
    }
  ],
  "decisions": [
    {
      "content": "V0.1 不引入向量数据库",
      "reason": "先验证会话连续性",
      "source": ["decision_001"]
    }
  ],
  "rules": [
    {
      "content": "实现前先检查已有文档和代码约定",
      "source": ["rule_001"]
    }
  ],
  "recentSessions": [
    {
      "summary": "完成产品定位和 V2 设计收敛",
      "source": ["session_002"]
    }
  ]
}
```

### 7.2 选择顺序

V0.x 不使用向量检索，采用项目边界加全文检索：

1. 当前项目的 active Work Item；
2. 当前项目最近的未归档 Decision；
3. 当前项目最近一次或数次 Session Summary；
4. 当前项目 Rules；
5. 与当前启动查询匹配的 Context Item；
6. 全局 Preferences；
7. 用户主动搜索的历史内容。

### 7.3 预算和压缩

Context Builder 必须有明确预算：

- V0.1 默认目标：不超过 2K tokens；
- 当前状态和下一步优先于历史细节；
- Decision 保留“决定 + 理由”，不注入全部讨论过程；
- 过长的 Summary 通过 Artifact 重新压缩；
- 每一段注入内容保留来源 ID，但不把完整路径和内部元数据全部暴露给 Agent。

### 7.4 交付记录

每次注入记录 `ContextDelivery`：

- 哪个 Agent；
- 哪个 Project；
- 使用了哪些对象；
- 通过 Hook、MCP 还是文件生成；
- 注入时间；
- 是否被用户或 Agent 主动查询。

这为后续“调用次数”和“有效性分析”提供数据，但 V0.1 不做复杂评分。

---

## 8. 记忆治理规则

### 8.1 来源规则

| 内容 | 是否必须来源 | 是否允许手动创建 |
|-|-|-|
| 原始对话 | 必须来自 Agent 采集 | 否 |
| Session Summary | 必须关联 Session | 否，允许编辑 |
| Resume Artifact | 必须关联 Session 或 Project | 可以基于项目手动维护 |
| Preference | 可以手动创建 | 是 |
| Project Context | 可以手动创建 | 是 |
| Decision | 建议关联 Session，也允许手动创建 | 是 |
| Work Item | 建议关联 Session，也允许手动创建 | 是 |
| Rule | 可以完全手动创建 | 是 |

### 8.2 状态机

```text
candidate
    ├── confirmed → active
    ├── rejected  → archived
    └── edited    → new version → candidate 或 active

active
    ├── edited      → old version superseded + new version active
    ├── archived    → archived
    └── deleted     → soft deleted
```

已确认内容被更新时不覆盖旧版本。这样可以回答：

- 这条信息什么时候生效；
- 后来为什么变化；
- 哪个 Agent 曾经使用过旧版本。

### 8.3 冲突处理

当新候选与 active 对象可能矛盾时，不自动覆盖：

```text
候选：项目准备迁移 PostgreSQL
已有：项目使用 SQLite
        ↓
生成 Conflict Proposal
        ↓
用户选择：
    保留旧内容
    接受新内容
    合并并补充条件
    两者并存但限定范围
```

### 8.4 删除策略

- 原始会话证据默认只读；
- 普通删除是软删除；
- 删除的派生对象不再注入，但仍可在审计或恢复视图中查看；
- 永久删除原始会话需要 CLI 的显式确认；
- 清理操作必须记录时间和范围。

---

## 9. 系统架构

### 9.1 总体结构

```text
Claude Code       Codex       Cursor
     │               │           │
     └──── Agent Adapters ───────┘
                    │
          Hook / MCP / CLI
                    │
          ContextOS Daemon
                    │
        ┌───────────┴───────────┐
        │                       │
   Core Domain              Storage
        │                 SQLite + FTS5
        │
  Project Service
  Session Service
  Artifact Service
  Context Service
  Decision Service
  Work Item Service
  Rule Service
  Review Service
        │
   HTTP API / MCP Server
        │
      Web UI
```

### 9.2 模块职责

| 模块 | 职责 | 不负责 |
|-|-|-|
| Agent Adapter | 处理不同 Agent 的 Hook、transcript、session id 和注入方式 | 不决定记忆是否生效 |
| Session Collector | 接收并规范化真实会话 | 不编辑原始证据 |
| Artifact Service | 生成和版本化摘要、恢复文档 | 不直接修改 Evidence |
| Context Service | 检索、排序、压缩和交付上下文 | 不负责会话采集 |
| Governance Service | 管理 Decision、Work Item、Context Item 的状态 | 不读取 Agent 私有实现细节 |
| Rule Service | 维护规则、导入和生成目标文件 | 不把普通 Memory 自动变成规则 |
| Review Service | 提供候选、冲突和版本审阅 | 不绕过用户确认 |
| LLM Provider | 生成摘要、提取候选和压缩 | 不拥有业务数据和最终写权限 |

### 9.3 传输层和核心逻辑分离

HTTP API、MCP Server 和 CLI 共享同一套 Core Domain 服务，但不直接互相调用：

```text
HTTP Controller ─┐
MCP Tool       ──┼──> Application Service ───> Repository
CLI Command    ──┘
```

这样可以避免把业务逻辑写死在 MCP Tool 或 Web Controller 中，也方便未来增加桌面端或其他 Agent 适配器。

---

## 10. 接入设计

### 10.1 Claude Code：V0.1 首个适配器

V0.1 以 Claude Code 为首个完整适配对象：

- SessionStart：识别 cwd 和 session 信息，确保 Daemon 可用，获取 Context Package；
- SessionEnd 或 transcript 可用事件：登记会话结束，异步生成摘要；
- 会话记录：解析用户、Agent、工具调用和工具结果；
- 兜底：提供 `contextos session import <path>` 导入历史 `.jsonl`。

解析逻辑沿用 `conversation-archivist` 的验证结果：

- JSONL 按行流式处理；
- `user`、`assistant`、`summary` 是主要对话事件；
- `tool_result` 是 user 消息中的内容块；
- `tool_use` 是 assistant 消息中的内容块；
- 工具结果做长度压缩，但保留错误标志和首尾信息；
- 元数据事件不作为普通对话展示。

### 10.2 Codex 和 Cursor：V0.4 接入

后续适配器只需要实现统一接口：

```typescript
interface AgentAdapter {
  readonly id: string
  detect(): Promise<boolean>
  install(): Promise<void>
  readSession(input: SessionInput): AsyncIterable<SessionEvent>
  loadContext(input: ContextLoadInput): Promise<ContextDelivery>
  uninstall(): Promise<void>
}
```

每个适配器可以拥有不同的采集和注入实现，但共享 Project、Decision、Work Item 和 Rule。

### 10.3 MCP 工具

V0.1-V0.2 只保留最必要的工具：

| Tool | 作用 | 写入权限 |
|-|-|-|
| `context_load` | 获取当前项目上下文 | 只读 |
| `context_search` | 搜索项目和历史上下文 | 只读 |
| `session_status` | 获取当前会话状态 | 只读 |
| `context_propose` | 提交 Decision、Work Item 或 Context Item 候选 | 仅 candidate |
| `session_summary_refresh` | 请求重新生成摘要 | 创建新 Artifact 版本 |

不提供可以绕过治理流程、直接写入 active Memory 的工具。

---

## 11. Web 工作台

### 11.1 导航结构

```text
Workspace
├── Projects
├── Sessions
├── Review Inbox
├── Decisions
├── Work Items
├── Context
└── Rules
```

不采用 EverMe 式的“记忆 / 技能 / 被推断的你”作为主导航。

### 11.2 首页

首页只展示当前工作最需要的信息：

```text
当前项目
当前状态
下一步
最近会话
待审阅候选
待处理冲突
```

不做营销式 Dashboard，不用复杂人格图表抢占首屏。

### 11.3 项目页

项目页是主要工作界面：

```text
左侧：项目对象树
右侧：当前选中内容

Overview
Current Status
Decisions
Work Items
Sessions
Context
Rules
```

树状图或知识图谱作为后续辅助视图，不作为 V0.1 的主要操作方式。

### 11.4 Session 页

Session 页分为两层：

```text
上层：Summary / Current State / Next Steps
下层：只读原始会话证据
```

用户可以修改 Summary 和恢复文档，但查看原始消息时必须明确区分：

- 用户原话；
- Agent 回复；
- 工具调用；
- 工具结果；
- 系统元数据。

### 11.5 Review Inbox

Review Inbox 是人机共管的核心界面。每个候选卡片显示：

- 内容；
- 类型；
- 来源 Session；
- 来源消息或片段；
- 置信度；
- 与现有对象的相似或冲突关系；
- 建议操作。

---

## 12. 数据库设计

以下为 SQLite + Prisma 的 V0.x 逻辑模型。字段可根据实际实现调整，但对象边界必须保持。

```prisma
model Project {
  id          String   @id @default(cuid())
  name        String
  path        String   @unique
  description String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  sessions    Session[]
  decisions   Decision[]
  workItems   WorkItem[]
  contextItems ContextItem[]
  rules       Rule[]
}

model Session {
  id              String   @id
  agent           String
  projectId       String?
  project         Project? @relation(fields: [projectId], references: [id])
  cwd             String?
  sourcePath      String?
  sourceHash      String?
  status          String   // active | ended | summary_pending | summary_failed
  startedAt       DateTime
  endedAt         DateTime?
  createdAt       DateTime @default(now())

  events          SessionEvent[]
  artifacts       Artifact[]
}

model SessionEvent {
  id              String   @id @default(cuid())
  sessionId       String
  session         Session  @relation(fields: [sessionId], references: [id])
  sequence        Int
  kind            String   // user | assistant | tool_use | tool_result | summary
  content         String
  metadataJson    String?
  sourceLocator   String?
  contentHash     String?
  createdAt       DateTime @default(now())

  @@unique([sessionId, sequence])
}

model Artifact {
  id              String   @id @default(cuid())
  sessionId       String?
  session         Session? @relation(fields: [sessionId], references: [id])
  projectId       String?
  kind            String   // summary | resume | extraction | conflict
  bodyJson        String
  status          String   // draft | active | superseded | archived
  version         Int      @default(1)
  basedOnId       String?
  createdBy       String   // system | user | agent
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}

model ContextItem {
  id              String   @id @default(cuid())
  projectId       String?
  project         Project? @relation(fields: [projectId], references: [id])
  kind            String   // fact | preference | experience | project_context
  content         String
  status          String   // candidate | active | superseded | archived | deleted
  confidence      Float    @default(1.0)
  versionOf       String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}

model Decision {
  id              String   @id @default(cuid())
  projectId       String
  project         Project  @relation(fields: [projectId], references: [id])
  title           String
  decision        String
  rationale       String?
  alternatives    String?
  status          String   // proposed | accepted | superseded | archived
  versionOf       String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}

model WorkItem {
  id              String   @id @default(cuid())
  projectId       String
  project         Project  @relation(fields: [projectId], references: [id])
  kind            String   // todo | problem | milestone | experiment
  title           String
  description     String?
  status          String   // open | in_progress | blocked | done | archived
  priority        Int      @default(0)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}

model Rule {
  id              String   @id @default(cuid())
  projectId       String?
  project         Project? @relation(fields: [projectId], references: [id])
  scope           String   // global | project
  target          String   // claude | codex | cursor | all
  content         String
  priority        Int      @default(0)
  status          String   // active | archived
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}

model SourceLink {
  id              String   @id @default(cuid())
  sourceType      String   // session | session_event | artifact
  sourceId        String
  targetType      String   // artifact | context_item | decision | work_item
  targetId        String
  locator         String?
  createdAt       DateTime @default(now())
}

model ContextDelivery {
  id              String   @id @default(cuid())
  sessionId       String?
  projectId       String?
  agent           String
  transport       String   // hook | mcp | generated_file
  packageJson     String
  createdAt       DateTime @default(now())
}
```

### 12.1 检索策略

V0.x 使用：

- SQLite 普通索引；
- SQLite FTS5；
- 项目路径和状态过滤；
- 时间、优先级和对象类型排序。

不因为“以后可能需要语义检索”而提前引入向量库。只有当全文检索无法满足实际恢复质量时，才评估 embedding 或外部上下文引擎。

---

## 13. LLM 与异步任务

### 13.1 LLM Provider

LLM 只负责三个可替换能力：

```text
summarize(session evidence)
extract(candidate objects)
compress(context package)
```

Provider 可以是：

- 用户配置的 Anthropic / OpenAI 等 API；
- 本地模型；
- 未来接入外部 Memory Engine；
- 手动模式（只归档，不自动提取）。

### 13.2 失败处理

LLM 任务是异步任务，不得阻塞 Session 采集或 Agent 工作：

```text
采集成功 + 总结失败
    → Session 保留
    → status = summary_failed
    → Web UI 提供重试或手动编辑
```

重试必须幂等，不重复创建相同版本的 Artifact 或候选对象。

### 13.3 隐私边界

在发送给外部 LLM 前，系统需要让用户知道：

- 发送了哪个项目；
- 包含哪些会话内容；
- 使用哪个 Provider；
- 是否包含工具结果和代码片段。

V0.1 可以先提供 Provider 配置和“仅本地归档”模式，脱敏和细粒度字段选择随后完善。

---

## 14. 技术选型

| 层 | 选型 | V2 结论 |
|-|-|-|
| 语言 | TypeScript | 保持，全栈共享类型，贴合 MCP、CLI 和 Node 生态 |
| Monorepo | pnpm workspace | 保持 |
| Daemon | Node.js + NestJS | 采用模块化应用服务，HTTP 和 MCP 共用领域服务 |
| Web | Next.js + Tailwind + shadcn/ui | 采用，首版以工作台和表格/时间线为主 |
| CLI | Node.js + TypeScript | 采用 `contextos init/start/status/session/context/rule` |
| 数据库 | SQLite + Prisma | 采用，适合本地优先和单用户 MVP |
| 全文检索 | SQLite FTS5 | V0.x 采用 |
| MCP | `@modelcontextprotocol/sdk` | 采用 |
| 可视化 | React Flow | V0.2+，不是首屏核心 |
| LLM | `LLMProvider` 抽象 | 支持 API、本地模型和手动模式 |

### 14.1 目录结构

```text
contextos/
├── apps/
│   ├── daemon/              # 本地服务、HTTP API、MCP、异步任务
│   ├── web/                 # Next.js 工作台
│   └── cli/                 # contextos 命令
├── packages/
│   ├── core/                # 领域对象和应用服务
│   ├── database/            # Prisma schema、迁移、Repository
│   ├── session-collector/   # 会话规范化和归档
│   ├── artifact-engine/     # Summary、Resume、Extraction
│   ├── context-builder/     # 检索、排序、预算和交付包
│   ├── rule-manager/        # Rule 导入、渲染、diff、备份
│   ├── mcp-server/          # MCP Tool 适配
│   ├── agent-adapters/      # Claude Code、Codex、Cursor
│   └── shared/              # DTO、错误码、Schema、工具类型
└── docs/
```

---

## 15. 分阶段路线

### V0.1 — Claude Code Session Continuity

验证命题：

> 昨天做了一半的项目，今天打开 Claude Code 后，能够在 30 秒内理解并继续工作。

必须完成：

- Claude Code 会话导入和采集；
- `conversation-archivist` 式 JSONL 流式解析；
- Session、SessionEvent、Session Summary；
- Resume Artifact；
- Project 和 Current Status；
- SessionStart 上下文加载；
- Web 只读工作台；
- SQLite + FTS5；
- LLM Provider 可关闭，支持纯归档模式。

暂不完成：

- 多 Agent；
- 向量检索；
- 知识图谱；
- 完整 Rule Manager；
- 复杂 Analytics；
- 自动 Skill 生成。

### V0.2 — Context Governance

- Review Inbox；
- Context Item；
- Decision；
- Work Item；
- 候选确认、编辑、版本、归档和冲突；
- Summary / Resume 的版本化；
- 基础调用记录；
- 简单项目树。

### V0.3 — Rule Manager

- 导入已有 CLAUDE.md / AGENTS.md；
- Rule 单一事实源；
- 目标平台渲染；
- diff 预览和旧文件备份；
- 处理外部文件被修改的情况；
- Web Rules 页面。

### V0.4 — Multi-Agent

- Codex 适配器；
- Cursor 适配器；
- 跨 Agent 共享项目状态；
- Agent-specific Context Package；
- 基础调用统计。

### 远期方向

- 语义检索或外部 Context Engine；
- 分层项目摘要和自动压缩；
- Memory/Context 有效性反馈；
- 云备份和团队共享；
- 权限、审计和团队 Rule 治理。

---

## 16. 成功标准

### V0.1 产品标准

- Claude Code 会话可以被自动或一条 CLI 命令归档；
- 原始会话可追溯，Web UI 不可伪造；
- 会话结束后能生成结构化 Summary；
- Summary 至少包含：完成事项、当前状态、问题、下一步；
- 下一次启动可以识别正确项目；
- 注入上下文默认不超过 2K tokens；
- 用户不需要重新解释上次工作的基本状态；
- 摘要生成失败不损坏会话记录。

### V0.2 治理标准

- 会话提取内容不会直接成为全局 active 内容；
- 用户可以在一个页面确认、修改、归档和删除候选；
- 每个 active 对象都能打开来源；
- 修改不会丢失旧版本；
- Decision、Work Item 和 Rule 可以独立管理。

---

## 17. 风险与对策

| 风险 | 对策 |
|-|-|
| 会话采集受 Agent 平台变化影响 | 适配器隔离；保留 CLI 导入兜底；核心域不依赖单个平台 |
| 摘要和提取质量不稳定 | 结构化 Schema、来源追踪、候选审核、可重试和手动模式 |
| 上下文注入反而干扰 Agent | 严格预算、项目边界、对象优先级和可关闭注入 |
| 规则生成覆盖用户文件 | 导入前备份、写入前 diff、记录生成来源、检测外部修改 |
| 本地数据暴露给外部 LLM | 本地模式优先、Provider 可配置、发送范围可见 |
| 功能范围膨胀 | V0.1 只验证 Session Continuity，不做图谱、向量和多 Agent |
| 用户不知道哪些内容可信 | Evidence 与派生内容分层；所有 active 内容显示来源和版本 |

---

## 18. 与 conversation-archivist 的映射

`conversation-archivist` 不是一次性脚本，而是 ContextOS 的第一个可复用原型。它已经验证了以下设计：

| 已有能力 | ContextOS 的正式化方向 |
|-|-|
| `/ca-archive` | Session 归档服务和 CLI |
| `/ca-summarize` | Artifact Service 的 Summary |
| `/ca-context` | Resume Artifact 和 Context Package |
| `/ca-scan` | Session 索引、价值评分和导入队列 |
| `/ca-resume` | Session 查询和启动上下文恢复 |
| 原始 JSONL 只读 | Evidence 层不可变约束 |
| 精华对话保留用户原话 | Evidence Projection 的可追溯展示 |
| 工具结果压缩 | Session Event 的展示层压缩，不破坏原始来源 |
| 智能标题 | Session 标题和项目检索字段 |

迁移原则：

1. 先复用已验证的解析和归档规则；
2. 再将文件输出升级为数据库中的 Session、Artifact 和 SourceLink；
3. 不把已有 skill 中的“归档文档”误当成新的原始对话；
4. 保留 CLI 离线归档能力，即使 Daemon 或 LLM 不可用；
5. 让 Web UI 成为 CLI 的可视化治理层，而不是替代底层可追溯性。

---

## 19. 最终产品定义

ContextOS 的核心不是让 AI 对用户产生更多推断，而是让用户能够管理 AI 参与工作的上下文：

```text
真实会话
    ↓
工作状态、决策、问题、下一步
    ↓
用户审阅和治理
    ↓
项目上下文与 Agent 规则
    ↓
下一个 Agent 继续工作
```

最终目标：

> 让 Claude Code、Codex、Cursor 等 Agent 不再只是一次性执行器，而成为能够持续参与同一个长期项目的工作成员。

