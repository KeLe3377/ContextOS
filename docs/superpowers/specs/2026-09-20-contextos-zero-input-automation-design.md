# ContextOS 零录入自动化设计

日期：2026-09-20  
状态：已确认设计，待实施  
目标分支：`feature/zero-input-automation`

## 1. 摘要

ContextOS 当前已经具备 Project、Session、Evidence、Context Item、Decision、Work Item、Rule、Review 和 Context Package 等领域能力，但主要交互仍是人工创建表单、人工绑定会话、人工触发同步、人工填写派生内容。

本设计把产品主路径改为：

```text
自动发现 -> 自动采集 Evidence -> 自动生成候选 -> 策略判定/人工审查
         -> 正式领域对象 -> 自动装配 Context Package
```

系统默认运行在 `SUGGEST_ONLY` 模式。原始证据自动采集，模型或规则生成的内容先写入候选区；Decision、Rule 和具有执行影响的 Work Item 不允许绕过审查直接成为正式对象。

第一阶段聚焦 Codex 本地工作流，不扩展云账户、多机同步、协作权限或桌面 UI 控制。

## 2. 问题定义

目前用户必须完成以下机械操作：

- 先创建 Project，再填写真实根目录；
- 先创建 ContextOS Session，再从候选中绑定 Codex 线程；
- 停留在 Sessions 页面并开启前端轮询，才能持续同步；
- 为 README、AGENTS、设计文档逐个创建 Context Source 并点击 Sync；
- 从 transcript 手工整理 Resume Capsule、Context Item、Decision 和 Work Item；
- 在下一次 Continue 前人工确认哪些信息已经进入 Context Package。

已有的 Desktop Sync、Evidence Store、Review Inbox 和 Context Package 分别解决了局部问题，但缺少 daemon 内常驻、可恢复、幂等的自动编排层。

## 3. 设计目标

### 3.1 产品目标

- 首次确认一次项目根目录后，系统自动发现该项目关联的 Codex 线程。
- daemon 在后台增量同步已绑定线程，不依赖用户停留在某个页面。
- 新增事件先形成不可变 Evidence，再产生可追溯的结构化候选。
- 用户的主要动作从“填写”变为“接受、修改后接受、忽略”。
- 被接受的内容能够进入现有 Context Package，并用于后续 Continue/Resume。
- 自动化过程可暂停、恢复、观测和重试，不因 daemon 重启丢失状态。

### 3.2 工程目标

- 复用现有服务与仓储，不在前端复制领域逻辑。
- 所有后台任务持久化，具备幂等键、重试次数和明确终态。
- 外部模型调用不发生在 SQLite 写事务内。
- 自动生成的数据必须保留 Evidence、提取器版本和生成时间。
- 功能默认关闭或运行在建议模式，升级策略必须显式选择。

## 4. 非目标

- 不控制当前打开的 Codex Desktop 窗口，也不向其主动发送消息。
- 不把 ContextOS 改造成通用任务调度平台。
- 不在首期支持任意 URL、任意目录递归或全磁盘扫描。
- 不让模型直接启用 Rule、接受 Decision 或启动 Agent Session。
- 不引入向量数据库或跨项目语义检索。
- 不取代原始 transcript；压缩、摘要和候选始终是可重建的派生产物。

## 5. 方案选择

### 5.1 方案 A：前端自动填表

在现有九个页面加载时自动填写默认值并触发接口。实现快，但只有页面打开时工作，失败不可恢复，也会把自动化逻辑散落在 React 组件中。

结论：不采用。

### 5.2 方案 B：daemon 定时任务直接写正式对象

后台定时发现和同步，提取后直接创建 Context Item、Decision、Work Item。自动化程度高，但错误内容会立刻污染 Context Package，重跑也容易产生重复对象。

结论：不采用。

### 5.3 方案 C：持久化任务 + 候选层 + 策略门禁

daemon 负责发现与采集，提取器只生成候选，Reconciler 负责幂等与合并，Policy 决定自动接受或送审。该方案改动较大，但与现有 Evidence、Review 和 Context Package 边界一致。

结论：采用。

## 6. 总体架构

```text
Codex app-server       rollout JSONL       Project files
        |                    |                    |
        +---------- Discovery & Watchers --------+
                             |
                    Automation Scheduler
                     (persistent jobs)
                             |
                    Ingestion / Evidence
                             |
                  Compaction / Extraction
                             |
                  Extraction Candidates
                             |
                 Reconciler + Policy Engine
                    /                   \
          Domain Services          Review Inbox
                    \                   /
                     Governed Resources
                             |
                  Context Package Builder
                             |
                    Continue / Resume
```

### 6.1 层次职责

| 层 | 职责 | 明确不负责 |
|---|---|---|
| Discovery | 找到项目、线程和允许扫描的文件 | 不创建派生结论 |
| Scheduler | 入队、领取、重试、恢复、限流 | 不解释业务语义 |
| Ingestion | 将外部事实保存为 Evidence | 不直接写 Decision/Rule |
| Extractor | 从 Evidence 生成结构化候选 | 不决定是否正式生效 |
| Reconciler | 去重、更新、过期和来源合并 | 不绕过 Policy |
| Policy | 按风险和模式选择自动接受或送审 | 不修改原始 Evidence |
| Domain Services | 创建和流转正式对象 | 不调用模型 |

## 7. 核心组件

### 7.1 AutomationScheduler

新增 daemon 内常驻调度器。启动后恢复可重试任务，按固定间隔领取到期任务，并在关闭时停止领取新任务。

首期任务类型：

- `DISCOVER_CODEX_THREADS`
- `SYNC_SESSION_TRANSCRIPT`
- `DISCOVER_PROJECT_SOURCES`
- `SYNC_CONTEXT_SOURCE`
- `EXTRACT_EVIDENCE_CONTEXT`
- `RECONCILE_EXTRACTION_CANDIDATES`

任务必须具备：`id`、`kind`、`projectId`、资源引用、payload、幂等键、状态、可执行时间、尝试次数、失败码和时间戳。相同幂等键存在非终态任务时不得重复入队。

现有 `jobs` / `job_attempts` 继续承载 Agent Continue 的运行记录；自动化任务使用独立表，避免改变现有 `RuntimeJobDto` 的公开语义。

### 7.2 ThreadDiscoveryService

通过现有 `AgentAdapter.listExternalSessions()` 查询 Codex app-server，按规范化 cwd 将线程映射到 Project。

归属规则：

1. 精确等于 Project root 优先；
2. 线程 cwd 为 Project root 的父目录时，只生成待确认候选，不自动绑定；
3. 多个 Project 同时匹配时不自动选择，创建 Review Item；
4. 已绑定线程保持原绑定，不因名称或 cwd 后续变化迁移；
5. 已归档线程默认不自动建 Session。

唯一确定匹配时，系统创建 Session、写入 `externalSessionId`、建立 Desktop Sync 状态。自动创建的标题使用线程 `name`，缺失时回退 `preview`，再缺失时使用外部线程 ID 前八位。

### 7.3 BackgroundTranscriptSync

复用 `DesktopSyncService.sync()` 的解析和 byte offset 逻辑，但由 scheduler 调用。前端“自动同步”开关不再拥有计时器，只修改持久化设置并展示 daemon 状态。

每次同步的新增事件必须形成 Evidence 或追加到可追溯的增量证据中，然后才允许触发提取任务。半行 JSONL、offset 重置和文件暂时不可读沿用现有 tailer 语义，任务进入可重试失败而不是丢弃 offset。

### 7.4 ProjectSourceDiscovery

首期只自动发现以下受控路径：

- 根目录 `README.md`
- 根目录 `AGENTS.md`
- 根目录 `CLAUDE.md`
- 根目录已有的主要设计说明文件
- `docs/` 目录第一层 Markdown 文件

不递归扫描依赖目录、构建产物、隐藏目录和超过配置上限的文件。发现结果创建 FILE Source；内容 hash 未变化时不得生成新 Evidence。

### 7.5 ContextExtractor

内部端口：

```ts
export interface ContextExtractor {
  readonly id: string;
  readonly version: string;
  extract(input: ExtractionInput): Promise<ExtractionResult>;
}
```

`ExtractionInput` 包含 Project、Session、Evidence、结构化事件和已有候选摘要，不包含未限定的整个工作区。

`ExtractionResult` 使用 Zod 严格校验，包含：

- Resume Capsule 建议：当前状态、下一步；
- `CONTEXT_ITEM` 候选：FACT、SUMMARY、CONSTRAINT、OPEN_QUESTION、RISK、HANDOFF；
- `DECISION` 候选；
- `WORK_ITEM` 候选；
- 每条候选的置信度、证据引用、稳定指纹和解释。

第一实现通过本机 Codex CLI 执行结构化提取，不引入新的 API Key。超时、CLI 不可用或结构校验失败时，Evidence 仍然成功保存，提取任务按策略重试并在耗尽后显示错误。

既有完整状态压缩设计作为提取前的输入整形层：原始 events 保留，压缩 events 用于控制输入规模，不能替代 Evidence。

### 7.6 CandidateRepository 与 Reconciler

新增 `extraction_candidates`：

| 字段 | 含义 |
|---|---|
| `id` | 候选 ID |
| `project_id` / `session_id` | 所属边界 |
| `source_evidence_id` | 直接来源 Evidence |
| `kind` | `RESUME_CAPSULE`、`CONTEXT_ITEM`、`DECISION`、`WORK_ITEM` |
| `fingerprint` | 规范化内容和项目范围生成的稳定 hash |
| `payload_json` | 通过契约校验的候选内容 |
| `confidence` | 0 到 1 |
| `status` | `PENDING`、`ACCEPTED`、`REJECTED`、`SUPERSEDED` |
| `extractor_id/version` | 可复现来源 |
| `target_resource_type/id` | 接受后创建或更新的正式对象 |
| `created_at/updated_at/revision` | 并发控制 |

同一项目、kind、fingerprint 只能存在一个有效候选。后续 Evidence 再次支持同一结论时追加来源关系并提高新鲜度，不创建副本。明确冲突的候选并存并送审，不自动覆盖人工接受的对象。

### 7.7 AutomationPolicy

项目设置：

- `OFF`：不发现、不同步、不提取；手动能力保持不变。
- `SUGGEST_ONLY`：自动采集和生成候选，所有派生领域对象需人工接受。默认值。
- `AUTO_ACCEPT_HIGH_CONFIDENCE`：只允许低风险类型在阈值以上自动接受。

首期自动接受白名单仅包含 Resume Capsule 和 SUMMARY/HANDOFF 类型 Context Item。Decision、Rule、Work Item、CONSTRAINT 和 RISK 无论置信度多高都进入审查。

Rule 不属于首期提取输出。规则具有治理影响，必须由用户主动创建或由后续独立设计覆盖。

### 7.8 CandidateApplicationService

接受候选时必须调用现有 Domain Service，不允许 CandidateRepository 直接写正式表。应用动作与候选状态更新在一个数据库事务语义内完成，并写 Activity/Audit 记录。

Review Item 使用 `sourceType=EXTRACTION_CANDIDATE`、`sourceId=candidate.id`。解决为 `APPROVED` 时应用候选；`DISMISSED` 时标记候选 `REJECTED`。

### 7.9 Context Package 集成

现有 Context Package Builder 继续只读取正式对象：accepted Decision、ACTIVE Context Item、关联 Work Item、Evidence 和 ACTIVE Rule。PENDING 候选永远不进入包。

候选被接受后不主动修改已经生成的不可变 Context Package；只影响下一次 Continue/Resume 创建的新包。

## 8. 数据流

### 8.1 新 Codex 线程

```text
定时发现线程
-> 唯一 Project 匹配
-> 自动创建并绑定 Session
-> 从文件末尾建立 WATCHING 状态
-> 后台增量同步
-> 新事件形成 Evidence
-> 入队提取任务
-> 候选进入 Review Inbox
```

默认从文件末尾开始，避免首次启用时对历史线程产生大量提取调用。用户可对指定线程选择“导入历史”。

### 8.2 新 transcript 事件

```text
tail rows -> parse events -> persist Evidence -> commit
-> enqueue extraction by evidence hash
-> compact/fit input -> extractor
-> validate -> reconcile -> policy
-> pending review or domain service
```

任何模型调用都发生在 Evidence 事务提交之后。

### 8.3 文件变化

```text
source discovery -> FILE Source -> hash check -> Evidence Snapshot
-> extraction candidate -> review/application
```

## 9. API 与前端变化

新增 API：

- `GET/PATCH /api/projects/:id/automation-settings`
- `GET /api/automation/status`
- `POST /api/automation/run-discovery`
- `GET /api/extraction-candidates`
- `GET /api/extraction-candidates/:id`
- `POST /api/extraction-candidates/:id/accept`
- `POST /api/extraction-candidates/:id/reject`
- `POST /api/extraction-candidates/:id/retry`

前端变化限制在现有九页：

- Overview：自动化健康、最近同步、待审候选和失败任务；
- Sessions：显示自动发现/自动同步状态，移除页面计时器的职责；
- Review Inbox：展示候选差异，支持接受、编辑后接受和忽略；
- Context/Decision/Work Items：显示生成来源与 Evidence 链接；
- Settings：全局开关、轮询间隔、并发数、扫描上限；
- Projects：项目级模式和资料扫描范围。

不新增第十个一级页面。

## 10. 错误处理与恢复

- app-server 不可用：记录可重试错误，不影响 daemon 健康接口和手动功能。
- transcript 文件暂时不可读：保持上次成功 offset，指数退避。
- offset 重置：保存 reset 原因，重新读取后依赖 Evidence hash 和候选 fingerprint 去重。
- 提取超时或非法 JSON：保存失败码，不创建候选，不回滚 Evidence。
- daemon 重启：RUNNING 自动化任务恢复为可重试状态；超过最大次数进入 FAILED。
- 候选应用冲突：保留 PENDING，返回当前资源 revision，要求重新审查。
- 项目归属歧义：创建 Review Item，不自动绑定。

退避采用有上限的确定性序列：5 秒、30 秒、2 分钟、10 分钟；四次失败后等待用户重试或下一次源变化重新入队。

## 11. 安全与隐私

- 所有读取限定在已登记 Project root、Codex 自有会话目录和显式允许的文件范围。
- 不把密钥写入 Settings、日志、Evidence、任务 payload 或 API 响应。
- 提取器进程只收到完成当前任务所需的裁剪输入文件。
- 日志只记录资源 ID、hash、计数、耗时和失败类别，不打印 transcript 正文。
- 自动化不得触发 Continue、执行命令、修改项目文件或应用 Rule。
- 应用 Decision、Work Item 等持久领域对象必须经过策略门禁。

## 12. 可观测性

`GET /api/automation/status` 返回：

- scheduler 是否运行、上次 tick 时间；
- 各类任务的 queued/running/succeeded/failed 数量；
- 最近五个失败任务的脱敏信息；
- 每个 Project 最近发现、同步和提取时间；
- 提取器可用性和版本；
- 待审候选数。

Activity/Audit 记录自动创建 Session、Evidence 入库、候选创建、候选接受和候选拒绝。

## 13. 测试策略

### 13.1 单元测试

- cwd 归属与歧义判定；
- 任务幂等键、领取、重试和恢复；
- 提取结果 Zod 校验；
- 候选 fingerprint、合并和冲突；
- 策略矩阵；
- 文件发现 allowlist 与排除规则。

### 13.2 集成测试

- daemon 启动后自动发现、建 Session、绑定并同步；
- 新事件先落 Evidence，提取失败不破坏同步；
- daemon 重启后不重复创建 Session/Evidence/Candidate；
- Review 通过后只创建一个正式对象；
- PENDING 候选不进入 Context Package；
- `OFF` 模式保持现有手动行为。

### 13.3 端到端测试

- 从新建 Codex fixture thread 到 Review Inbox 出现候选；
- 接受 Context Item 后，新 Session 的 Context Package 包含该项；
- 前端关闭后后台同步仍继续；
- app-server 不可用时页面显示降级状态且手动绑定可用。

## 14. 交付阶段

### Phase 0：契约和任务底座

建立自动化设置、任务表、scheduler、状态 API 和恢复机制。此阶段不调用模型。

### Phase 1：零录入采集

自动发现唯一匹配的 Codex 线程、创建 Session、绑定并后台同步；自动发现受控项目资料。

### Phase 2：候选提取闭环

接入结构化提取器、候选表、去重、Review Inbox 和接受/拒绝动作。

### Phase 3：Context Package 与体验收口

完善候选来源展示、自动化健康、批量审查、下一次 Context Package 验证和教学文档。

## 15. 验收标准

- 用户登记 Project 后，无需手工创建 Session 即可看到唯一匹配的新 Codex 线程。
- 不打开网页持续写入 fixture rollout，daemon 仍能在配置周期内同步。
- 每批新增事件先产生可校验 Evidence，随后产生带来源的候选。
- 重复同步、daemon 重启和重复提取不会产生重复 Session、Evidence 或候选。
- 默认模式下 Decision、Work Item、CONSTRAINT、RISK 不会自动成为正式对象。
- 接受一个 Context Item 候选后，下一次创建的 Context Package 包含它。
- app-server 或提取器故障不阻断手动工作流。
- 所有新增 API、迁移、后台恢复和主要 UI 流程均有自动化测试。

## 16. 工作量

| 阶段 | 估算 |
|---|---:|
| Phase 0：任务底座 | 3-4 个开发日 |
| Phase 1：自动发现与采集 | 4-6 个开发日 |
| Phase 2：提取与候选治理 | 7-10 个开发日 |
| Phase 3：前端与体验收口 | 4-6 个开发日 |
| 回归、真实环境验证和修复 | 3-5 个开发日 |
| 合计 | 21-31 个开发日 |

一名熟悉代码库的工程师约需 4-6 周。8-12 天可以交付仅覆盖 Codex Session、后台同步、Resume Capsule 和 Context Item 建议的 MVP。

## 17. 决策记录

- D1：采用 daemon 后台编排，不依赖前端页面生命周期。
- D2：自动化任务使用独立持久化表，不扩张现有 Continue Job 的公开契约。
- D3：所有派生内容先进入 Candidate，不允许 Extractor 直接写正式领域表。
- D4：默认 `SUGGEST_ONLY`，高风险对象始终人工审查。
- D5：首期使用本机 Codex CLI 做结构化提取，不新增 API Key。
- D6：首期不生成 Rule，不自动启动 Agent，不控制 Desktop UI。
- D7：现有 Context Package 只消费正式对象，保持不可变快照语义。
- D8：自动发现从有限 allowlist 开始，不做无界目录递归。

