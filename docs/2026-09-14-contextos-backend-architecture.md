# ContextOS 后端整体架构设计

状态：后端架构设计基线
日期：2026-09-14
技术栈：TypeScript + Node.js + SQLite
运行模式：单机单用户、本地 daemon
监听地址：`127.0.0.1:4721`

本文是 ContextOS 后端真实运行部分的设计基线，承接：

- [DESIGN.md](../DESIGN.md)
- [前端详细设计与接口契约](2026-09-14-contextos-frontend-design-api.md)

本文规定后端的模块边界、数据流、持久化约束、运行时和可靠性。数据库表的最终字段、ORM 选择和具体代码实现属于后续实现计划，但不得违反本文定义的领域不变量和接口语义。

## 1. 目标与边界

### 1.1 第一阶段目标

ContextOS 后端必须能够：

- 管理 Project、Session、Review Item、Decision、Work Item、Context Source、Evidence Snapshot、Context Item、Rule 和 Settings
- 启动、继续、观察和结束 Claude Code、Codex、Cursor Agent 会话
- 将原始 Agent transcript 和工具结果保存为不可变证据
- 生成带 provenance 的派生 Context Item、Resume Capsule 和 Context Package
- 对规则执行验证、冲突分析和运行时评估
- 在治理问题出现时创建 Review Item
- 记录所有重要生命周期动作和配置变更
- 在 daemon 或外部 Agent 进程重启后恢复可恢复任务
- 通过前端约定的 REST API 提供稳定资源和显式 action endpoint

### 1.2 明确不做

第一阶段不做：

- 账号系统、登录、云同步和多人协作
- 远程部署或公网监听
- 把 ContextOS 做成聊天机器人
- 把原始对话直接当作权威知识
- 全量事件溯源替代普通资源存储
- 分布式消息队列、微服务和多节点一致性
- 让前端直接读取 SQLite 或本地文件

### 1.3 单机安全边界

daemon 只绑定 `127.0.0.1`，拒绝非本机连接。所有文件路径必须经过项目根目录和允许目录校验，避免 Agent 或用户配置把 ContextOS 读写范围扩展到任意路径。

本地监听不等于不需要边界：每个请求仍然需要 project scope、资源归属和 capability 校验。未来加入远程模式时，可以在 Transport 层增加认证，不修改 Domain 层。

## 2. 总体架构

```text
                     +----------------------+
                     |  ContextOS Desktop UI |
                     +----------+-----------+
                                |
                         REST 127.0.0.1
                                |
+-------------------------------v-------------------------------+
|                         contextosd                             |
|                                                               |
|  +-------------+   +------------------+   +----------------+  |
|  | HTTP        |-->| Application      |-->| Runtime        |  |
|  | Transport   |   | Use Cases        |   | Jobs/Adapters  |  |
|  +-------------+   +--------+---------+   +-------+--------+  |
|                             |                       |           |
|                      +------v------+         +------v-------+  |
|                      | Domain      |         | Adapter      |  |
|                      | Invariants  |         | Registry     |  |
|                      +------+------+         +------+-------+  |
|                             |                       |           |
|                      +------v-----------------------v------+    |
|                      | Ports / Repository Interfaces       |    |
|                      +------+-----------------------+------+    |
|                             |                       |           |
|                      +------v------+         +------v-------+  |
|                      | SQLite      |         | File Evidence|  |
|                      | Repositories|         | Store        |  |
|                      +-------------+         +--------------+  |
+---------------------------------------------------------------+
```

架构形态是：**模块化单体 daemon + 可恢复后台任务 + 统一事件记录**。

所有模块运行在一个 Node.js 进程中，使用同一个 SQLite 数据库和任务协调器。模块之间通过 Application Service、Domain Event 和明确的 ID/reference 通信，不通过跨模块直接访问内部表或实体。

## 3. 分层和依赖规则

### 3.1 Transport

职责：

- 创建 HTTP server 和路由
- 解析 path、query、headers 和 JSON body
- 做 schema validation
- 注入 request context、request ID、actor 和 project scope
- 把应用错误映射为统一 HTTP 错误
- 输出稳定 DTO

Transport 不负责：

- 直接查询 SQLite
- 判断生命周期是否允许
- 拼接 Agent 命令
- 创建审计记录
- 处理长任务的内部重试

### 3.2 Application

Application Service 表示一个完整用户用例，例如：

- `CreateProject`
- `ContinueSession`
- `SyncContextSource`
- `ResolveReviewItem`
- `AcceptDecision`
- `ActivateRule`
- `UpdateSettings`

一个用例负责：

1. 加载所需资源
2. 检查 project scope 和 capability
3. 调用 Domain 方法执行不变量检查
4. 在一个明确事务边界内保存资源和审计事件
5. 创建或调度后台任务
6. 发布前端需要的 Activity/Event
7. 返回 Resource DTO 或 Job DTO

Application 不把长时间运行的 Agent、同步和导出工作阻塞在 HTTP 请求中。

### 3.3 Domain

Domain 是后端可信规则的所在地，至少包含：

- 状态转换
- 不可变证据约束
- 版本化约束
- provenance 完整性
- Project 边界规则
- Rule activation 条件
- Decision supersede/reverse 约束
- Work Item readiness 条件

Domain 不依赖 Node HTTP、SQLite client、具体 Agent、环境变量和文件路径。

### 3.4 Runtime

Runtime 管理非瞬时过程：

- Agent adapter 调用
- 外部进程启动、终止和健康检查
- Context Source 同步
- transcript 导入
- Context 派生
- Rule evaluation batch
- export 和 cache 清理
- Job retry、lease、恢复和取消

Runtime 只能通过 Application/Domain 提供的 command 或 port 修改业务资源，不能绕过治理直接写表。

### 3.5 Infrastructure

Infrastructure 实现端口：

- SQLite transaction 和 repositories
- Evidence blob/file store
- Agent adapter 的本地文件和进程实现
- 时钟、UUID、hash、日志和子进程 launcher
- schema migration

## 4. 推荐目录结构

```text
ContextOS/
  apps/
    daemon/
      src/
        main.ts
        bootstrap.ts
        http/
        runtime/
  packages/
    contracts/
    shared/
    domain/
      project/
      session/
      review-item/
      decision/
      work-item/
      context/
      rule/
      audit/
    application/
      project-service/
      session-service/
      review-service/
      decision-service/
      work-item-service/
      context-service/
      rule-service/
      settings-service/
    infrastructure/
      sqlite/
      evidence-store/
      adapters/
      process/
      jobs/
      clock/
  migrations/
  tests/
    contract/
    integration/
    fixtures/
```

实际 monorepo 工具可调整目录，但职责边界必须保持。`contracts` 只放前后端共享的请求、响应、错误和事件 schema，不放 SQLite model。

## 5. 核心领域模型

### 5.1 Project

Project 是 workspace boundary 和治理容器。

关键数据：

- `id`
- `name`
- `rootPath`
- `description`
- `status`: `ACTIVE | PAUSED | ARCHIVED`
- `defaultRuleIds`
- `agentAdapterIds`
- `revision`

不变量：

- `rootPath` 必须是规范化的本地路径
- 资源只能被一个 Project 所拥有，或明确标记为系统级资源
- Project archive 前必须处理仍在运行的 Session 和任务
- 已归档 Project 默认不可创建新 Session

### 5.2 Session

Session 是一个具体 Agent work episode。

关键数据：

- `id`
- `projectId`
- `agentAdapterId`
- `externalSessionId`
- `intent`
- `status`: `CREATED | RUNNING | PAUSED | COMPLETED | FAILED | ARCHIVED`
- `runtimeState`
- `contextPackageId`
- `resumeCapsuleId`
- `revision`

Session 不保存未经处理的大型 transcript 作为普通字段。原始内容进入 Evidence Store，数据库保存引用、范围、hash、摘要和导入状态。

### 5.3 Evidence Snapshot

Evidence Snapshot 是不可变原始证据的治理记录。

关键数据：

- `id`
- `projectId`
- `sessionId` 或 `contextSourceId`
- `sourceType`
- `sourceLocator`
- `capturedAt`
- `contentHash`
- `storageRef`
- `byteSize`
- `parserVersion`
- `metadata`
- `verificationState`

不变量：

- 创建后不允许 UPDATE 内容字段
- 不允许物理删除仍被任何完成对象引用的快照
- 比较必须基于 hash、版本和内容，不基于可变摘要
- Snapshot 的原始文件和数据库记录必须采用写入临时文件、fsync/rename、事务提交的顺序保证可恢复

### 5.4 Context Source

Context Source 是被治理的来源，例如项目文档、会话 transcript、规则输入或本地目录。

它保存来源连接、包含范围、刷新状态、快照引用和使用计数，不直接等同于 Context Item。

### 5.5 Context Item

Context Item 是从 Evidence Snapshot 或其他受信来源派生的内容。

必须保存：

- `sourceSnapshotIds`
- `derivedFromItemIds`
- `derivationMethod`
- `derivationVersion`
- `generatedAt`
- `contentHash`
- `status`
- `revision`

派生内容必须显式标记 `Derived`。更新 Context Item 必须创建新 version，不能修改历史版本后伪装成原内容。

### 5.6 Context Package

Context Package 是某次 Session 启动或继续时选定的输入集合。

它不是 Evidence，也不是永久事实。它记录：

- 使用了哪些 Context Item
- 使用了哪些 Evidence Snapshot
- 选择原因和排序
- 生成时间和 package schema version
- 大小限制和截断信息

Agent 收到的是 Context Package 的稳定序列化结果；Session 保留 package 引用用于复现和审计。

### 5.7 Decision

Decision 是持久化、版本化的选择和理由。

接受后的重大变化必须走 `supersede` 或 `reverse`，不能通过普通 PATCH 静默改写。

### 5.8 Work Item

Work Item 是有明确完成标准的可执行单元。Readiness 是可计算的投影，但最终状态转换必须由 Domain 校验：依赖、验收标准和阻塞条件不能被绕过。

### 5.9 Rule

Rule 是声明式治理指令，包含 scope、structured conditions、effect、precedence、exception、version 和 enforcement mode。

只有同时满足以下条件才能 activate：

- schema 有效
- 条件可编译/可解释
- precedence 冲突已解决
- 引用的 Project、Context Source 或其他资源存在
- 当前 Draft 版本完整且通过验证

### 5.10 Review Item

Review Item 是需要人工处理的治理问题。它保存触发来源、证据差异、建议方案、人工决策、负责人、状态和 action log。

Review Item 不能代替来源对象的编辑器；resolve 只解决治理问题，来源对象仍由其所属 Application Service 修改。

## 6. 持久化设计

### 6.1 SQLite 职责

SQLite 保存结构化元数据和事务性状态：

- 资源 identity、状态、revision 和生命周期
- ID 关系、引用、hash、时间和版本
- Job、lease、attempt 和 retry 状态
- Activity、Audit Event 和 rule evaluation result
- Settings 和 adapter capability cache

SQLite 不保存：

- 任意大小的原始 transcript blob
- 未截断的 Agent stdout/stderr
- 可直接执行的 shell 命令作为唯一事实

### 6.2 Evidence Store

Evidence Store 默认使用本地文件系统，目录由系统设置决定，但必须位于受允许的本地数据根目录。

建议布局：

```text
<data-dir>/
  contextos.sqlite
  evidence/
    <project-id>/
      <snapshot-id>.jsonl
      <snapshot-id>.meta.json
  exports/
  logs/
  locks/
```

文件名只使用后端生成的 ID，不直接使用用户输入或 Agent 提供的文件名。

### 6.3 写入顺序

Evidence Snapshot 使用以下流程：

1. 在 evidence 临时目录写入内容
2. 计算 byte size 和 content hash
3. flush 并原子 rename 到最终路径
4. 在 SQLite transaction 中写入 Snapshot metadata
5. 提交事务
6. 发布 `evidence.snapshot.created`

如果数据库提交失败，启动恢复扫描会根据 metadata 和临时文件清理或补登记；不能留下数据库指向不存在文件的 active snapshot。

### 6.4 Migration

- 每个 schema migration 有单调版本号
- daemon 启动时先获取本地 migration lock
- migration 在 transaction 中执行，能失败回滚
- 数据库版本不兼容时 daemon 不启动业务 listener，只返回明确的启动错误
- 不允许启动时静默删除或重建用户数据

## 7. Repository 与事务

### 7.1 Repository 规则

每个 Domain module 定义自己的 repository interface，例如：

```ts
interface SessionRepository {
  getById(id: SessionId): Promise<Session | null>;
  list(input: SessionListQuery): Promise<Page<SessionSummary>>;
  save(session: Session, expectedRevision: number): Promise<void>;
}
```

SQLite 实现只能出现在 Infrastructure。Repository 返回 Domain 或专用 persistence mapper 的结果，不把 SQLite row 泄漏到 Application。

### 7.2 事务端口

Application 使用抽象事务：

```ts
interface TransactionRunner {
  run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T>;
}
```

一个用户可见动作需要同时更新资源、审计事件和必要的 outbox/job record 时，必须处于同一个 SQLite transaction。

### 7.3 并发控制

所有可变资源带 `revision`。更新时必须匹配期望 revision：

```text
UPDATE resource
SET ..., revision = revision + 1
WHERE id = :id AND revision = :expectedRevision
```

受影响行数为 0 时返回 `CONFLICT` 或 `PRECONDITION_FAILED`，不能覆盖服务端更新。

后台 Job 也使用 revision 和 lease，防止 daemon 重启或重复 worker 同时处理同一任务。

## 8. Agent Adapter 架构

### 8.1 统一接口

```ts
interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;

  discover(input: DiscoverSessionsInput): Promise<DiscoverResult>;
  importTranscript(input: ImportTranscriptInput): Promise<ImportedSessionResult>;
  launch(input: LaunchInput): Promise<AgentRunHandle>;
  resume(input: ResumeInput): Promise<AgentRunHandle>;
  inspectStatus(input: InspectStatusInput): Promise<AgentStatus>;
  interrupt(input: InterruptInput): Promise<InterruptResult>;
  capabilities(): AdapterCapabilities;
}
```

每个 adapter 还必须提供：

- transcript parser version
- 本地路径发现规则
- 命令和参数构造器
- stdout/stderr 转结构化 event 的解析器
- session identity 映射策略
- capability 列表
- 失败类型映射

### 8.2 三个首批适配器

```text
AgentAdapterRegistry
├── ClaudeCodeAdapter
├── CodexAdapter
└── CursorAdapter
```

核心服务只依赖 `AgentAdapter`，不依赖具体目录名、命令名或 transcript JSON 结构。所有本地格式差异封装在对应 adapter 内。

### 8.3 启动和继续流程

```text
ContinueSession command
  -> validate Project and Session
  -> build Context Package
  -> create AgentRun Job
  -> persist runtime state + audit event
  -> scheduler claims Job
  -> adapter.resume()
  -> supervisor starts process
  -> adapter emits normalized Agent Events
  -> Evidence writer appends immutable source events
  -> Session projection updates
  -> Rule evaluator evaluates relevant events
  -> Review Item may be created
  -> job completes or enters retry/failure
```

Agent adapter 只产生规范化事件，例如：

```ts
type AgentEvent =
  | { type: 'run.started'; externalRunId: string; at: string }
  | { type: 'message.received'; contentRef: string; at: string }
  | { type: 'tool.called'; toolName: string; inputRef: string; at: string }
  | { type: 'tool.completed'; resultRef: string; at: string }
  | { type: 'run.completed'; outcome: string; at: string }
  | { type: 'run.failed'; code: string; message: string; at: string };
```

原始 payload 进入 Evidence Store，规范化事件进入结构化事件记录。前端只消费摘要和引用，不直接读取未经授权的进程输出。

### 8.4 进程监督

`AdapterProcessSupervisor` 负责：

- 生成受控环境变量
- 使用 argv 数组启动，禁止未经处理的 shell 拼接
- 记录 pid、start time、external run ID
- 读取 stdout/stderr 并设置上限和 backpressure
- 超时、退出码和 signal 映射为统一错误
- daemon 关闭时先发送 graceful interrupt，再按超时强制结束
- 将未完成 run 标记为可恢复或需要人工处理

## 9. 后台任务系统

### 9.1 为什么需要 Job

Agent 运行、文件同步、transcript 导入、Context 派生、导出和规则批处理都可能超过 HTTP 请求生命周期，必须由可恢复 Job 承担。

### 9.2 Job 状态

```text
QUEUED
  -> RUNNING
  -> SUCCEEDED
  -> FAILED
  -> RETRY_WAIT
  -> CANCELED
```

Job 必须保存：

- `id`
- `type`
- `projectId`
- `resourceId`
- `payloadVersion`
- `status`
- `attempt`
- `maxAttempts`
- `availableAt`
- `leaseOwner`
- `leaseExpiresAt`
- `lastErrorCode`
- `lastErrorMessage`
- `createdAt`、`updatedAt`

### 9.3 Claim 和 lease

Worker claim 使用短事务：找到可执行 Job、设置 owner 和 lease、提交。执行过程不持有 SQLite 长事务。

lease 过期后，恢复器可以重新入队 Job。任务处理器必须是幂等的，至少按 `jobId`、`resourceId` 和操作类型检查已完成结果。

### 9.4 重试

只对临时错误重试：

- Agent 进程暂时不可用
- 文件暂时锁定
- daemon 内部短暂资源不足
- 可恢复的网络或 adapter 启动错误

不对以下错误盲目重试：

- invalid input
- permission denied
- unsupported capability
- rule validation failure
- revision conflict
- 路径越界

使用指数退避加上限，最终失败必须写 Audit/Event，并保留可操作的错误信息。

## 10. 事件、Activity 和 Audit

### 10.1 三类记录

1. **Domain Event**：描述领域状态变化，例如 `decision.accepted`
2. **Activity Event**：供前端展示的简短活动摘要
3. **Audit Event**：治理和安全记录，包含 actor、request、时间、动作和变更元数据

三者可以由同一事务产生，但用途不同，不能用 Activity 替代 Audit。

### 10.2 必要审计字段

```ts
type AuditEvent = {
  id: string;
  projectId: string | null;
  actor: { type: 'USER' | 'SYSTEM' | 'AGENT'; id: string };
  requestId: string;
  idempotencyKey: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  beforeRevision: number | null;
  afterRevision: number | null;
  metadata: Record<string, unknown>;
  occurredAt: string;
};
```

Audit metadata 只保存必要摘要，敏感 payload 和大型 transcript 使用 Evidence Store 引用。

### 10.3 Outbox

在同一 SQLite transaction 中写入资源变更和 outbox event。后台 dispatcher 发布成功后标记 outbox 状态。这样即使 daemon 在提交后立即崩溃，事件仍能恢复发布。

Outbox 不是全量事件溯源；资源当前状态仍保存在资源记录中。

## 11. 关键业务流程

### 11.1 导入 transcript

```text
POST /api/sessions/import-transcript
  -> AdapterRegistry 选择 adapter
  -> 校验文件路径位于允许范围
  -> parser 读取并验证格式
  -> 生成原始 Evidence Snapshot
  -> 创建或匹配 Project/Session
  -> 保存 externalSessionId 和 parser version
  -> 生成 Session summary / Resume Capsule Job
  -> 写导入 Activity 和 Audit
```

导入必须支持重复执行：相同 source locator 和 content hash 不重复创建相同快照；格式变化或内容 hash 变化创建新快照。

### 11.2 构建 Context Package

```text
Session continue
  -> 查找有效 Context Sources
  -> 读取已验证 Evidence Snapshot 和有效 Context Item
  -> 按 Project scope、Rule 和 freshness 筛选
  -> 生成固定 schema package
  -> 记录每项 provenance 和 selection reason
  -> 应用大小限制和确定性截断
  -> 保存 package manifest
```

Context Package 必须可复现：相同 manifest、版本和输入应得到可解释的相同内容；不能因为一次运行而静默替换证据。

### 11.3 Rule evaluation

Rule evaluation 接受规范化事件、资源摘要和 Context Package metadata，不直接读取任意数据库表。

输出：

- `PASS`
- `ADVISORY`
- `WARNING`
- `REQUIRE_REVIEW`
- `BLOCK`
- `EVALUATION_ERROR`

`REQUIRE_REVIEW` 创建 Review Item；`BLOCK` 阻止对应 Application action 或 Agent run 继续。每次重要评估保存 rule version、input reference、result 和 evaluator version。

### 11.4 Resolve Review Item

resolve 请求必须包含：

- reviewer actor
- resolution type
- written reason
- expected revision
- 可选的 source action reference

Review Service 只关闭治理项并写 action log；若需要修改 Decision、Rule、Work Item 或 Context Item，调用相应模块的 Application Service。

### 11.5 Settings 更新

Settings 是单例本地资源，但仍使用 revision。影响运行时的配置变更分两类：

- 可即时生效：UI 偏好、确认开关、默认 adapter
- 需要重载或重启：监听端口、数据目录、开机自启动、adapter 进程策略

API 返回 `applied: true`、`requiresRestart: boolean` 和当前 daemon 状态。设置更新不能直接修改正在运行 Agent 的环境；新配置从下一个 run 生效，除非明确执行 restart action。

## 12. REST API 实现规则

### 12.1 路由组织

```text
/api/workspace/overview
/api/projects
/api/sessions
/api/review-items
/api/decisions
/api/work-items
/api/context-sources
/api/evidence-snapshots
/api/context-items
/api/rules
/api/settings
/api/health
```

资源列表和资源详情返回前端契约中的 DTO，不返回内部 row、绝对数据库路径、进程命令或未经脱敏的 stderr。

### 12.2 Action endpoint

生命周期动作使用明确路径：

```text
POST /api/sessions/:id/continue
POST /api/decisions/:id/accept
POST /api/work-items/:id/complete
POST /api/rules/:id/activate
POST /api/context-sources/:id/sync
```

Action endpoint 必须：

- 验证当前状态和权限
- 接受 expected revision
- 记录 request/idempotency key
- 写 Audit Event
- 返回新的资源状态或 Job receipt

### 12.3 长任务响应

长任务返回：

```ts
type JobReceipt = {
  jobId: string;
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  resourceType: string;
  resourceId: string;
  acceptedAt: string;
};
```

前端通过资源刷新和后续状态查询获取结果。第一阶段不强制 WebSocket；可以先采用轮询，之后增加本地事件流而不改变 Job 数据模型。

## 13. 错误和可观测性

### 13.1 错误层次

内部错误分为：

- Domain error：状态或业务不变量失败
- Validation error：输入 schema 或字段失败
- Authorization error：Project/capability 不允许
- Adapter error：外部 Agent 不支持、启动失败或格式错误
- Storage error：SQLite、文件或锁失败
- Runtime error：任务 lease、进程或调度失败

Transport 将它们映射到前端契约中的 `ApiError`，不把内部 stack trace 返回客户端。

### 13.2 日志

每条日志至少带：

- `timestamp`
- `level`
- `requestId`
- `projectId`（可用时）
- `resourceType/resourceId`（可用时）
- `jobId`（可用时）
- `event`

默认日志不记录 API key、完整 transcript、Agent prompt 或完整工具输入输出。需要调试时只写受控 Evidence reference。

### 13.3 Health

```text
GET /api/health
```

返回 daemon 版本、数据库 schema version、运行状态、Job scheduler 状态和 adapter capability summary。Health endpoint 不返回本地敏感路径；Settings 页面需要路径时走受控 Settings DTO。

## 14. 启动、关闭和恢复

### 14.1 启动顺序

```text
load config
  -> acquire data-dir lock
  -> run migrations
  -> recover incomplete evidence writes
  -> recover expired jobs and adapter runs
  -> initialize repositories
  -> register adapters
  -> initialize scheduler and outbox dispatcher
  -> bind 127.0.0.1:4721
  -> publish daemon.ready
```

如果 migration、data directory 或恢复检查失败，不绑定业务 API，返回明确启动失败原因。

### 14.2 Graceful shutdown

```text
stop accepting new requests
  -> mark daemon draining
  -> stop claiming new jobs
  -> finish short transactions
  -> request adapters interrupt
  -> persist resumable run state
  -> flush outbox/logs
  -> close SQLite
  -> release lock
```

关闭超时后，未完成的 Job 由 lease recovery 接管；不得把正在运行的 Session 伪装为 completed。

## 15. 权限与路径安全

- 所有资源操作验证 `projectId` 归属
- Project root path 使用 `realpath` 和 allowlist 校验
- 禁止通过 `..`、符号链接或非规范化路径逃逸根目录
- 子进程使用明确 argv，默认最小环境变量
- 不把用户输入作为 shell 命令片段
- Agent adapter 的 transcript 只能读取其声明的路径范围
- 导出文件使用用户明确指定的目录，并在 UI 显示完整结果
- 清理 cache、archive、删除来源和修改 retention 都需要明确 action
- API key 和 credential 只存储在操作系统允许的安全配置位置，不进入普通 Activity、Evidence 或日志

## 16. 测试策略

### 16.1 Domain tests

不依赖 Node HTTP、SQLite 或真实 Agent，覆盖：

- 合法/非法生命周期转换
- Evidence Snapshot 不可变
- Derived Context Item provenance 完整性
- Decision accept/supersede/reverse
- Rule activate 前验证和冲突条件
- Work Item readiness 和依赖
- Project boundary

### 16.2 Repository contract tests

同一套 contract tests 运行于 SQLite repository 和测试内存实现，验证：

- revision conflict
- transaction rollback
- cursor 分页稳定性
- unique/idempotency 约束
- 时间和 hash 持久化
- migration 后读取

### 16.3 Adapter contract tests

每个 adapter 必须通过统一测试：

- discover 输出规范化
- transcript parser fixture
- import 幂等
- launch/resume capability
- stdout/stderr 事件解析
- 退出码和 signal 映射
- unsupported capability 错误

### 16.4 Runtime integration tests

使用 fake adapter 和 fake process supervisor 测试：

- Job claim、lease 和恢复
- daemon 重启后的未完成任务
- Agent run 到 Evidence Snapshot 的完整链路
- Rule evaluation 创建 Review Item
- outbox 重发
- graceful shutdown

### 16.5 API contract tests

前端契约文档中的每个 route 至少验证：

- status code
- request schema
- response schema
- error schema
- revision header/body
- idempotency behavior
- read-only 和 missing reference 状态

## 17. 分阶段实现顺序

### Phase 1：运行骨架

- Node daemon bootstrap
- localhost HTTP server
- config、data directory、lock
- SQLite connection、migration runner、health
- shared error、request ID、revision 和 idempotency primitives

### Phase 2：核心资源

- Project
- Session
- Decision
- Work Item
- Review Item
- Settings
- REST list/detail/action routes
- Audit 和 Activity

### Phase 3：证据和上下文

- Evidence Store
- Context Source
- Evidence Snapshot
- Context Item version
- Context Package manifest
- transcript import

### Phase 4：Agent runtime

- Adapter interface and registry
- Claude Code adapter
- Codex adapter
- Cursor adapter
- process supervisor
- launch/resume/status/interrupt
- normalized Agent Event

### Phase 5：治理运行时

- Rule domain and validation
- conflict analysis
- deterministic test
- runtime evaluation
- Review Item generation
- Job scheduler、lease、retry、recovery
- outbox dispatcher

### Phase 6：联调和可靠性

- 前端九页完整联调
- 并发冲突和断电恢复测试
- evidence integrity audit
- adapter fixture expansion
- settings and startup behavior verification
- packaging and local installation

## 18. 后端设计验收标准

- daemon 默认只监听 `127.0.0.1:4721`
- 前端每个正式 API 都有对应 Application Service 和 contract test
- HTTP handler 不直接访问数据库
- Domain 不依赖具体存储和 Agent
- Evidence Snapshot 创建后不可修改
- Derived Context Item 有 provenance 和版本
- 生命周期动作使用显式 action endpoint
- 所有可变资源使用 revision 并发控制
- 长任务由可恢复 Job 承担
- Agent 进程由 supervisor 管理，adapter 差异被隔离
- 资源变更、审计和 outbox 在明确事务边界内完成
- daemon 重启不会把未完成任务伪装为成功
- 错误包含稳定 code、message 和 requestId，不泄漏 stack 或 secret
- Project 路径、Agent 进程和 Evidence Store 均有本地安全边界
- 不使用全量事件溯源，不引入当前阶段不需要的微服务和云依赖

## 19. 与前端契约的对齐结论

前端以资源和 action 为中心；后端以 Application Service 和 Domain invariant 承担真实行为。前端看到的 `JobReceipt`、`revision`、`Audit Event`、`Evidence Snapshot`、`Derived` 和 `Provenance` 都是后端必须兑现的语义，不是展示层的装饰字段。

下一步可以基于本文开始后端实现计划和数据库详细设计，顺序应为：先确定 migration/Repository contract，再实现核心资源和事务边界，最后接入 Agent adapter 与长任务运行时。
