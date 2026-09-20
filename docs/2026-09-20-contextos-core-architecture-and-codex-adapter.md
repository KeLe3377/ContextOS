# ContextOS 核心架构与 Codex 适配核心代码讲解

> 日期：2026-09-20  
> 文档定位：帮助项目所有者建立独立的架构判断，不再由具体功能或 Agent 建议反向定义产品。  
> 相关设计：[DESIGN.md](../DESIGN.md)、[README.md](../README.md)  
> 相关边界：[2026-09-18-codex-desktop-sync-boundaries.md](./2026-09-18-codex-desktop-sync-boundaries.md)  
> 相关计划：[2026-09-20-codex-appserver-readonly-sync-plan.md](./2026-09-20-codex-appserver-readonly-sync-plan.md)

## 0. 先记住一句话

**ContextOS 的核心不是控制 Codex Desktop，也不是再造一个聊天客户端，而是把不同 Agent 的工作过程转换成项目级、可追溯、可审阅、可继续的工作状态。**

Codex、Claude Code 和未来其他 Agent 都只是执行器。ContextOS 自己拥有的是：

- Project 定义的工作边界；
- Session 表达的一次工作过程；
- Evidence 保存的原始事实；
- Context Package 表达的本次交接上下文；
- Decision、Work Item、Rule、Review Item 构成的治理状态；
- 跨 Agent 保持一致的继续工作机制。

判断一个新功能是否重要时，应先问它是否加强了上述能力，而不是它是否让 ContextOS 更像某个 Agent 客户端。

---

## 1. 产品核心是什么

ContextOS 解决的问题可以压缩为三个问题：

1. 这个项目已经做到哪里？
2. 为什么做成现在这样？
3. 下一次由人或任意 Agent 接手时，需要知道什么？

因此，ContextOS 的核心产物不是聊天消息，而是一个可验证的连续性闭环：

```text
项目边界
  -> 收集原始来源
  -> 保存不可变证据
  -> 形成可治理的派生上下文
  -> 为一次 Session 构建 Context Package
  -> Agent 执行工作
  -> 回收 transcript 和运行输出
  -> 再次保存为证据
  -> 更新决策、工作项、审查状态和下一次交接信息
```

### 1.1 核心对象

| 对象 | 核心含义 | 不应该退化成 |
|---|---|---|
| `Project` | 工作区边界和治理容器 | 只有名称的项目列表 |
| `Session` | 一次真实的 Agent 工作 episode | 普通聊天窗口 |
| `Evidence Snapshot` | 不可变的原始事实 | 可随意编辑的总结 |
| `Context Item` | 有来源、可版本化的派生信息 | 无来源的 AI 记忆 |
| `Context Package` | 一次执行实际加载的上下文集合 | 随机拼接的 prompt |
| `Decision` | 可追溯的重要选择及理由 | 普通笔记 |
| `Work Item` | 有完成标准的执行单元 | 模糊待办 |
| `Rule` | 声明式治理约束 | 隐藏在 prompt 中的约定 |
| `Review Item` | 需要人处理的治理问题 | 通用通知 |

### 1.2 最核心的数据关系

```text
Project
  ├─ Session
  │    ├─ Context Package
  │    ├─ Session Run / Job
  │    └─ Evidence Snapshot
  ├─ Context Source
  │    ├─ Evidence Snapshot
  │    └─ Context Item
  ├─ Decision
  ├─ Work Item
  ├─ Rule
  └─ Review Item
```

这里最重要的不变式是：

- 原始 transcript 和 Evidence Snapshot 是只读证据；
- 总结、Resume Capsule、Context Item 是派生内容，必须保留来源；
- Session 记录“这一次怎么做”；
- Work Item 记录“要完成什么”；
- Project 是所有读取、启动、绑定和治理行为的安全边界。

---

## 2. 代码架构总览

ContextOS 当前是一个本地优先的模块化单体：

```text
frontend/src/App.tsx
        |
        | HTTP / JSON
        v
apps/daemon/src/http/routes
        |
        v
packages/application/src/core
        |
        +----------------------+
        |                      |
        v                      v
packages/contracts       application ports
                               |
                               v
packages/infrastructure
  ├─ sqlite repositories
  ├─ evidence file store
  ├─ process supervisor
  └─ agent adapters
```

| 层 | 输入 | 输出 | 主要职责 |
|---|---|---|---|
| Frontend | 用户操作、API 数据 | HTTP 请求、界面状态 | 操作台，不承载领域规则 |
| HTTP routes | HTTP 参数和请求体 | DTO / HTTP 错误 | 校验、路由、状态码映射 |
| Application services | DTO、当前状态、端口 | 状态转换、运行编排 | 核心用例和业务约束 |
| Contracts | 未验证的外部数据 | Zod 校验后的 DTO | 跨层契约和枚举 |
| Infrastructure | 应用层调用 | SQLite、文件、子进程结果 | 技术实现细节 |
| Agent adapters | 统一 Agent 操作 | CLI 启动、续跑、transcript | 隔离不同 Agent 的私有差异 |

### 2.1 启动装配点

入口是 [`createDaemonServer()`](../apps/daemon/src/bootstrap.ts#L91)。它负责：

1. 加载并校验本地 daemon 配置；
2. 获取数据目录单实例锁；
3. 打开 SQLite 并执行迁移；
4. 恢复 Evidence 文件和异常中断的运行记录；
5. 创建 repositories 和 application services；
6. 注册 `CodexAdapter`、`ClaudeCodeAdapter`；
7. 注册 HTTP routes；
8. 托管前端静态文件。

这个文件是全系统的 composition root。理解“某个对象到底由谁创建、注入给谁”，优先从这里查，不要从前端反推。

### 2.2 架构性质

当前结构是实用的模块化单体，不是严格的 Clean Architecture：

- `application` 定义用例和 Agent 接口；
- `infrastructure` 实现 SQLite、文件、进程和 Agent；
- 但 `AgentAdapter` 端口直接引用了基础设施层的 `ProcessSupervisor` 类型。

这不是当前必须修复的问题，但意味着以后不要把“已经完全端口化”当成事实。若要支持远程执行器或 daemon 重启后的进程接管，这个边界可能需要重新设计。

---

## 3. 最重要的主链路：Continue in Agent

这是最能体现 ContextOS 产品价值的代码链路。

```text
用户点击 Continue in Agent
  -> POST /api/sessions/:id/continue
  -> SessionService.transition(..., "continue")
  -> 校验 revision 和 Session 状态
  -> 校验 Project 是否允许执行
  -> 执行 Rule evaluation
  -> ContinueSessionService.continue(session)
  -> 创建 Context Package
  -> 格式化 handoff / resume prompt
  -> 保存 ContextOS handoff evidence
  -> 根据 externalSessionId 选择 launch 或 resume
  -> 创建 Job + SessionRun + Outbox event
  -> AgentAdapter 启动子进程
  -> 标记 RUNNING
  -> 进程退出后标记成功、失败或取消
  -> 回收 transcript 和进程输出为 Evidence
```

### 3.1 Session 状态门禁

入口逻辑位于 [`SessionService.transition()`](../packages/application/src/core/core-services.ts#L115)。

`continue` 不是随便 PATCH 一个 `status=RUNNING`，而是显式动作：

- 使用 `expectedRevision` 防止并发覆盖；
- 只有 `CREATED / PAUSED / FAILED / COMPLETED` 可以继续；
- Project 必须允许新 Session；
- Rules 可以在启动前产生治理效果。

这体现了 ContextOS 的核心设计：**生命周期变化必须显式、可审计，而不是让前端直接改状态字段。**

### 3.2 Context Package 与 handoff

核心编排位于 [`ContinueSessionService.continue()`](../packages/application/src/core/runtime-services.ts#L80)。

它先为当前 Session 创建 Context Package，再生成两种 prompt：

- `handoffPrompt`：第一次启动外部 Agent 时使用；
- `resumePrompt`：恢复已经绑定的外部 Agent 线程时使用。

handoff prompt 自己也会保存为 Evidence。这一点很重要，因为以后必须能回答：

> 当时 ContextOS 到底向 Agent 交付了什么？

如果只保存 Agent 的最终输出，而不保存输入上下文，就无法形成可信的执行证据链。

### 3.3 launch 与 resume 的分界

关键判断是：

```typescript
const launch = session.externalSessionId
  ? agentAdapter.buildResumeInfo(...)
  : agentAdapter.buildLaunchInfo(...);
```

因此：

- ContextOS Session ID 是内部工作记录 ID；
- Codex thread UUID 是外部执行器 ID；
- `sessions.external_session_id` 是二者之间最关键的绑定关系。

没有外部 ID，只能启动新线程；有外部 ID，才能保证继续同一条 Codex 线程。

---

## 4. Agent Adapter 的职责边界

统一端口定义在 [`AgentAdapter`](../packages/application/src/ports/agent-adapter.ts#L56)。

```text
Application Service
       |
       | 只认识统一方法
       v
AgentAdapter
  ├─ CodexAdapter
  └─ ClaudeCodeAdapter
```

| 方法 | 统一语义 |
|---|---|
| `discover()` | 判断 Agent 是否安装、版本是什么 |
| `buildLaunchInfo()` | 描述一次新启动将执行什么 |
| `buildResumeInfo()` | 描述一次续跑将执行什么 |
| `launch()` | 启动新外部会话 |
| `resume()` | 恢复指定外部会话 |
| `inspectStatus()` | 查询由 ContextOS 管理的进程 |
| `interrupt()` | 中止由 ContextOS 管理的进程树 |
| `importTranscript()` | 将外部记录导入统一 Evidence 模型 |
| `resolveTranscriptPath()` | 可选，找到实时只读同步所需的记录文件 |
| `parseTranscriptRows()` | 可选，把增量记录转成统一事件 |

Adapter 应该隔离的是 Agent 私有差异，例如命令参数、会话文件位置和 transcript 格式。它不应该决定 ContextOS 的 Session 生命周期、Evidence 规则或 Context Package 选择逻辑。

---

## 5. CodexAdapter 核心方法

实现位于 [`codex-adapter.ts`](../packages/infrastructure/src/adapters/codex-adapter.ts#L10)。

### 5.1 `discover()`：能力探测

```text
输入：配置的 codex 命令
执行：codex --version
输出：available / version / error / capabilities
```

Windows 默认命令是 `codex.cmd`。为避免 Node `spawn` 直接执行 `.cmd` 的兼容问题，代码会转换成：

```text
cmd.exe /d /s /c codex.cmd ...
```

### 5.2 `buildLaunchInfo()`：新建 Codex 线程

默认 `launchArgs` 是 `['exec']`，有 prompt 时最终形成：

```text
codex exec -
```

`-` 表示 prompt 通过 stdin 传入，而不是拼进命令行参数。这避免了复杂转义、命令长度和敏感内容暴露问题。

### 5.3 `buildResumeInfo()`：续跑同一 UUID

最终命令是：

```text
codex exec resume <externalSessionId> -
```

这里实现的是“同一 Codex UUID 的受管 CLI turn”，不是控制 Codex Desktop 当前窗口。

### 5.4 `resume()`：恢复前的项目边界检查

[`assertResumeTarget()`](../packages/infrastructure/src/adapters/codex-adapter.ts#L91) 会：

1. 遍历 Codex sessions 目录中的 JSONL；
2. 读取第一行 `session_meta`；
3. 匹配目标 UUID；
4. 检查该 transcript 的 `cwd` 与 Project root 是否重叠。

这一步防止 Project A 错误恢复 Project B 的 Codex 线程。它是安全边界，不只是文件查找。

### 5.5 `launch()` / `resume()`：进程执行

二者最终都进入 `start()`，再调用 [`ProcessSupervisor.launch()`](../packages/infrastructure/src/process-supervisor.ts#L35)：

- 使用目标 Project root 作为 `cwd`；
- stdin 写入 handoff 或 resume prompt；
- 有界捕获 stdout / stderr；
- 保存 PID；
- 注册退出回调；
- Windows 中断时使用 `taskkill /t /f` 终止进程树。

当前 `ProcessSupervisor` 的 PID 映射只存在内存里。daemon 重启后，SQLite 可以恢复并标记孤儿运行记录，但不能重新获得原子级的子进程控制权。

### 5.6 `importTranscript()`：完整导入

[`importTranscript()`](../packages/infrastructure/src/adapters/codex-adapter.ts#L135) 用于一次性导入或进程结束后的 reconcile：

1. 递归扫描 `~/.codex/sessions/**/*.jsonl`；
2. 按修改时间倒序；
3. 读取 `session_meta` 中的 UUID 和 cwd；
4. 按 external ID、Project root、correlation marker 过滤；
5. 调用 `parseCodexTranscript()`；
6. 返回统一的 `AgentTranscriptImportResult`。

导入限制：

- 单个 transcript 最大 50 MB；
- 聚合文本最大约 1,000,000 字符；
- 单个工具事件文本最大 20,000 字符，超出后保留首尾；
- malformed 或崩溃留下的半行会被忽略；
- 没有 user / assistant 消息的记录拒绝导入。

### 5.7 transcript 归一化

[`parseCodexTranscript()`](../packages/infrastructure/src/adapters/codex-adapter.ts#L200) 和 `readCodexEvent()` 将 Codex JSONL 映射为：

```text
message
tool_call
tool_result
summary
```

这层归一化非常重要。ContextOS 后续 Evidence、计数和 UI 不应该依赖 Codex 的 `response_item`、`function_call_output` 等私有枚举。

---

## 6. Desktop 只读同步的位置

Desktop 同步属于“获取 Codex 工作证据”的一种通道，不是独立产品核心。

当前 Level A 链路：

```text
Codex rollout JSONL
  -> CodexTranscriptTailer 按 byte offset 读取
  -> CodexAdapter.parseTranscriptRows()
  -> AgentTranscriptEvent[]
  -> session_sync_state 更新 offset 和计数
  -> 前端每 5 秒轮询
```

核心服务是 [`DesktopSyncService.sync()`](../packages/application/src/core/desktop-sync-service.ts#L132)。

它保证：

- 只消费完整行；
- 半行留到下次；
- 文件消失时记录 ERROR，不让 daemon 崩溃；
- 事件 ordinal 跨轮询递增；
- 同步状态独立持久化。

### 6.1 app-server 的正确定位

app-server 只读 RPC 可以改进三个工程痛点：

- `thread/list` 代替手填 UUID；
- 返回 rollout path，避免扫描全部 JSONL；
- `thread/read`、`thread/turns/list`、`thread/items/list` 提供结构化读取，减少私有 JSONL 解析耦合。

正确演进顺序是：

```text
G0：验证 Desktop 创建的线程确实出现在 thread/list
L0：增加候选线程发现，读取仍用文件 tail
L1：读取切换到 app-server，只保留文件 tail 兜底
L2：只对 ContextOS 自己创建的线程研究通知流
```

不应把“通知流”或“反向控制 Desktop UI”当成同步升级的默认目标。Desktop 持有线程时，另一个 app-server 对同一线程 `thread/resume` 会遇到 active-writer 锁；只读 list/read 不需要抢锁。

---

## 7. 哪些是核心，哪些不是

| 分类 | 内容 | 优先级判断 |
|---|---|---|
| 产品核心 | Project、Session、Evidence、Context Package、Decision、Work Item、Rule、Review | 必须长期稳定 |
| 核心闭环 | 构建上下文、启动/续跑 Agent、回收证据、形成下一次交接 | 最高优先级 |
| Agent 接入 | CLI 命令、UUID、transcript、app-server 只读 RPC | 服务于核心闭环 |
| 运行支撑 | Job、Run、Outbox、Audit、进程监督 | 必要基础设施，不应喧宾夺主 |
| 产品外壳 | React 页面、安装包、启动脚本 | 决定可用性，但不定义领域核心 |
| 非当前核心 | Codex Desktop UI 控制、通知流、云端多用户、通用聊天 | 没有明确收益前不应扩张 |

---

## 8. 当前架构的已知边界

| 位置 | 边界或风险 | 影响 |
|---|---|---|
| `frontend/src/App.tsx` | 大量页面和交互集中在单文件 | 修改容易产生跨页面回归 |
| `codex-adapter.ts` | 递归扫描所有 JSONL 查 UUID | sessions 数量增长后绑定和 resume 校验变慢 |
| `codex-adapter.ts` | 手工解析 Codex 私有 JSONL | Codex 格式变化会造成适配维护成本 |
| `ProcessSupervisor` | 进程表只在内存 | daemon 重启后不能重新接管原子进程控制 |
| `AgentAdapter` port | 引用了 infrastructure 的类型 | 端口边界不完全独立 |
| app-server | 协议仍标记 experimental | 必须保留 tail 回退，不宜侵入领域层 |
| Desktop 通知 | 只对当前 app-server 已 load 的线程可靠 | 不能把它宣传成读取 Desktop 线程的通用实时方案 |

这些边界不等于都要立即重构。只有当它们阻碍“工作连续性和证据闭环”时，才值得提升优先级。

---

## 9. 防止项目被功能牵着走的判断框架

面对新的功能建议，依次回答：

1. 它是否更准确地回答“项目做到哪里了”？
2. 它是否保存了可验证的原始 Evidence？
3. 它产生的派生内容是否带 provenance 和版本？
4. 它是否让下一个 Session 或另一个 Agent 更可靠地继续？
5. 它是否保持 Project 边界和用户控制？
6. 它是跨 Agent 能力，还是某个 Agent UI 的私有便利？
7. 如果 Codex 明天改变协议，这项功能会不会动摇 ContextOS 的领域核心？

前五项大多为“否”，或者第六项只是私有 UI 能力时，该功能通常不应成为主线。

### 9.1 当前建议优先级

```text
Context Package 的选择质量与可解释性
  > Evidence / provenance 完整性
  > Session 与外部线程的可靠绑定
  > Work Item / Decision 与 Session 结果的闭环
  > Codex L0 自动发现线程
  > Codex L1 结构化只读同步
  > Codex Desktop UI 控制
```

---

## 10. 推荐源码阅读顺序

### 第一遍：先理解产品，不碰 Codex 私有细节

1. [`DESIGN.md`](../DESIGN.md)：产品边界和对象定义；
2. [`README.md`](../README.md)：当前实际能力；
3. [`packages/contracts/src`](../packages/contracts/src)：对象、状态和输入契约；
4. [`core-services.ts`](../packages/application/src/core/core-services.ts)：生命周期规则。

### 第二遍：理解一次 Continue 如何完成

1. [`runtime-services.ts`](../packages/application/src/core/runtime-services.ts#L70)；
2. [`runtime-repository.ts`](../packages/infrastructure/src/sqlite/runtime-repository.ts)；
3. [`agent-adapter.ts`](../packages/application/src/ports/agent-adapter.ts#L56)；
4. [`process-supervisor.ts`](../packages/infrastructure/src/process-supervisor.ts#L32)。

### 第三遍：理解 Codex 差异如何被隔离

1. [`codex-adapter.ts`](../packages/infrastructure/src/adapters/codex-adapter.ts#L10)；
2. [`codex-transcript-tailer.ts`](../packages/infrastructure/src/adapters/codex-transcript-tailer.ts)；
3. [`desktop-sync-service.ts`](../packages/application/src/core/desktop-sync-service.ts)；
4. [`2026-09-20-codex-appserver-readonly-sync-plan.md`](./2026-09-20-codex-appserver-readonly-sync-plan.md)。

### 第四遍：需要核对上游行为时再看 Codex 源码

重点只看与当前适配有关的部分：

- thread metadata 和 rollout persistence；
- `thread/list`、`thread/read`、`thread/turns/list`、`thread/items/list`；
- `exec resume` 的参数和线程恢复；
- active-writer 锁；
- app-server 协议版本变化。

不要从 Codex 全仓库开始漫游。上游源码是验证适配假设的参考，不是 ContextOS 产品需求的来源。

---

## 11. 跨阶段对照表

| 上游设计 | 下游收益 |
|---|---|
| Project root 作为边界 | 防止导入或恢复其他项目的线程 |
| Evidence 不可变 | 能复盘 Agent 当时看到了什么、做了什么 |
| 派生内容保留 provenance | 总结错误时可以回到原始依据 |
| Context Package 显式落库 | 每次 handoff 可重复检查 |
| externalSessionId 独立保存 | ContextOS Session 可以续跑同一 Agent 线程 |
| Adapter 归一化事件 | 领域层不依赖 Codex JSONL 私有枚举 |
| Job / Run 与 Session 分离 | 一次 Session 可以有多次执行尝试 |
| revision 并发控制 | 防止多个界面静默覆盖状态 |
| app-server 只用于适配层 | 协议变化不会污染核心领域模型 |
| 文件 tail 保留兜底 | experimental RPC 失败时仍能读取证据 |

---

## 12. 最终心智模型

可以把整个项目记成四个盒子：

```text
1. ContextOS Domain
   Project / Session / Evidence / Context / Decision / Work / Rule / Review

2. Continuity Engine
   Context Package -> Handoff -> Run -> Transcript -> Evidence -> Resume

3. Agent Boundary
   discover / launch / resume / interrupt / import transcript

4. Local Runtime
   Fastify / SQLite / Evidence files / Jobs / ProcessSupervisor / React UI
```

其中第 1、2 层决定 ContextOS 是什么；第 3 层决定它能接哪些 Agent；第 4 层只是当前交付形态。

只要这个顺序不反过来，ContextOS 就不会因为 Codex Desktop、app-server 或某个临时协议变化而失去自己的产品核心。
