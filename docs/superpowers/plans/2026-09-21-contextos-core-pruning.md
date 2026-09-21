# ContextOS 核心修剪设计与实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. 使用复选框更新每一步状态。

**目标：** 把 ContextOS 收缩成可靠的 Codex 会话连续性产品：自动发现、增量保存并恢复同一个 Codex 会话，不再让压缩、提取、Candidate 和 Review 成为核心闭环的前置条件。

**架构：** 保留本地模块化单体、持久化 Scheduler、Codex Adapter、增量 transcript tail、不可变 Evidence Store 和 Continue/Resume。用从已校验 canonical transcript Evidence 确定性构建的有界 Resume Capsule，替代强制执行的 Evidence -> Compaction Artifact -> Extractor -> Candidate -> Review -> Context Item 流水线。历史表和 migration 暂时保留兼容，先退出运行路径，验收通过后再物理删除无调用代码。

**技术栈：** TypeScript、Fastify、SQLite/better-sqlite3、Zod、React、Vitest、Playwright、Codex app-server adapter。

---

## 1. 产品边界

MVP 只完成一件事：

> ContextOS 自动发现并持续保存 Codex 会话；用户点击继续时，系统把最近的有效上下文带回同一个 Codex 会话。

唯一有效的完成证据是：

~~~text
Project 启用自动化
-> 发现 Codex thread
-> 创建并绑定 ContextOS Session（首次从 rollout EOF 开始）
-> 绑定后产生新事件
-> 正式调度同步捕获事件
-> Evidence 与 offset 一致提交
-> 确定性更新 Resume Capsule
-> Continue in Agent 恢复相同 externalSessionId
-> resume prompt 包含刚捕获的上下文
~~~

组件测试通过、Evidence 行创建成功或 Job 入队成功，都不能单独作为产品完成证据。

### 已确认的正式行为

- AutomationService.handleDiscoveryJob() 先执行 discoverCodexThreads()，再执行 enqueueDueSyncJobs()。
- Discovery 是重新武装失效同步链的正式周期入口。
- listDueForSync() 只选择 WATCHING、Project mode 非 OFF，且未同步或已超过 poll interval 的 Session。
- poll interval 最小合法值为 5,000 ms。
- 首次绑定从 rollout EOF 开始，绑定前事件不会自动摄入。
- Evidence、reader offset 和派生状态必须保持一致、可恢复的提交边界。
- Continue 根据 externalSessionId 恢复原 Codex 会话。

### 本轮不做

- Compaction Provider 和 Compaction Artifact；
- Codex Context Extractor；
- Extraction Candidate 与自动接受策略；
- 自动化专属 Review；
- 自动物化 Context Item；
- Jev、Codex error signal、新 Agent Adapter；
- 新页面、内部 Job 检查页面或分析看板；
- 删除数据库表、改写历史 migration。

Decision、Work Item、Rule、人工 Context Item 和普通 Review 可以保留，但本轮停止扩展。

## 2. 目标运行时

### 保留

| 组件 | 用途 |
|---|---|
| Project / Session | 工作区与连续性边界 |
| Codex Adapter / app-server discovery | 查找并恢复真实 Codex 会话 |
| DesktopSyncService / CodexTranscriptTailer | 读取绑定后的新增事件 |
| session_sync_state | 保存 offset、WATCHING 状态与同步时间 |
| Evidence Store | 保存可校验的 canonical 原始事实 |
| Automation Scheduler | 浏览器关闭后继续调度与重试 |
| DISCOVER_CODEX_THREADS | 发现并重新武装到期同步 |
| SYNC_SESSION_TRANSCRIPT | 捕获一个 transcript 批次 |
| Resume Capsule / Continue | 将捕获内容转化为用户可见结果 |

### 退出活跃路径

daemon 不再构造或注册：

- CompactionService
- 自动化执行用的 SqliteCompactionArtifactRepository
- CodexContextExtractor
- ExtractionService
- CandidateApplicationService
- COMPACT_EVIDENCE handler
- EXTRACT_EVIDENCE_CONTEXT handler

最终验收通过前保留源码和历史 migration，以便兼容和回滚。

### Resume Capsule 策略

每个新 transcript Evidence 批次都在 Evidence 与 offset 的同一 SQLite 事务中更新 Session Resume Capsule。构建器必须：

- 只读取通过 hash/size 校验的 canonical Evidence；
- 使用现有 codec，禁止再写第二套 transcript parser；
- 保持消息原始顺序；
- 保留最近的 user / assistant 消息；
- 保留失败或结果未知的 tool result；
- 字符预算不足时优先裁剪成功工具输出；
- 使用现有 sanitizer 去除 ContextOS 自身 handoff 前缀；
- contextText 上限 12,000 字符；
- nextAction 取最后一条非空 user 消息并限制 500 字符；
- 稳定记录来源 Evidence IDs；
- 相同输入必须生成相同输出；
- 不调用 Codex、模型 API 或外部 Provider。

它是“会话连续性摘录”，不是语义长期记忆，代码和 UI 必须使用准确名称。

### Continue 行为

ContinueSessionService.continue() 继续创建 Context Package 作为 provenance，但 resume prompt 还必须包含当前 Resume Capsule 的连续性摘录。即使没有 Candidate、Review 和自动 Context Item，自动捕获的 transcript 也必须对下一次 Continue 有用。

### 兼容与回滚

- 不编辑或删除 0012、0013、0014 migration。
- 不删除 automation、artifact 或 candidate 表。
- 旧 Artifact/Candidate 数据保持可读。
- 已发布的 Candidate API 统一返回 410 Gone 和稳定错误码 FEATURE_DEFERRED，不得伪装成功。
- 每个任务独立提交，只精确暂存本任务文件。

## 3. 文件范围

### 新建

- packages/application/src/core/session-continuity.ts
- tests/integration/session-continuity.test.ts
- docs/verification/2026-09-21-contextos-codex-continuity-smoke.md

### 修改

- packages/application/src/core/automation-service.ts
- packages/infrastructure/src/sqlite/runtime-repository.ts
- packages/application/src/core/runtime-services.ts
- apps/daemon/src/bootstrap.ts
- apps/daemon/src/http/routes/automation.ts
- packages/contracts/src/automation.ts
- packages/infrastructure/src/automation/automation-repository.ts
- frontend/src/automation.ts
- frontend/src/App.tsx
- frontend/src/components/automation/AutomationOverview.tsx
- frontend/src/components/automation/ProjectAutomationSettings.tsx
- 相关 integration tests
- tests/e2e/automation-workflow.spec.ts
- scripts/start-e2e-server.ts
- playwright.automation.config.ts
- README.md

### 仅在所有门禁通过后删除

- packages/application/src/core/compaction-service.ts
- packages/application/src/core/extraction-service.ts
- packages/application/src/core/candidate-application-service.ts
- packages/application/src/ports/context-extractor.ts
- packages/application/src/ports/transcript-compaction.ts
- packages/infrastructure/src/compaction/
- packages/infrastructure/src/extraction/
- Candidate 专属前端组件与测试

删除前必须用 CodeGraph 和 rg 检查每个 export 的剩余调用者。若仍服务于非自动化路径，保留或移动该符号。

## 4. 实施任务

### Task 0：恢复可信基线

**文件：** scripts/start-e2e-server.ts、playwright.automation.config.ts、tests/e2e/automation-workflow.spec.ts

- [x] 运行 git status --short 和三个文件的 git diff，记录用户已有改动。
- [x] 用精确补丁删除未验证的 fixture-only direct-SQL checkpoint，保留 prepare 和 append。
- [x] 若 Playwright 配置仍有重复 env 属性，只保留一项。
- [x] 运行 npm run build、npm run frontend:typecheck、git diff --check。
- [x] 预期全部 exit 0。
- [x] 精确暂存并提交：test: remove unverified automation checkpoint。

### Task 1：实现确定性会话连续性构建器

**文件：** 新建 session-continuity.ts 和 session-continuity.test.ts；复用现有 canonical codec 与 transcript-sanitizer.ts。

- [x] 先写测试：消息顺序、失败/未知工具结果、成功工具输出裁剪、handoff 前缀清理、12,000 字符上限、500 字符 nextAction、Evidence ID 稳定顺序、确定性。
- [x] 运行 npx vitest run tests/integration/session-continuity.test.ts，确认因实现缺失而失败。
- [x] 实现窄接口：

~~~ts
export type SessionContinuityInput = {
  evidence: Array<{ id: string; canonicalText: string }>;
  maxChars?: number;
};

export type SessionContinuity = {
  summary: string;
  nextAction: string | null;
  contextText: string;
  evidenceSnapshotIds: string[];
};

export function buildSessionContinuity(input: SessionContinuityInput): SessionContinuity;
~~~

- [ ] 再次运行聚焦测试，预期通过。
- [ ] 精确暂存并提交：feat: build deterministic session continuity。

### Task 2：同步时直接更新 Resume Capsule

**文件：** automation-service.ts、runtime-repository.ts、bootstrap.ts、automation-ingestion-atomicity.test.ts、automation-transcript-sync.test.ts。

- [x] 先把旧 COMPACT_EVIDENCE 断言改为连续性断言。
- [x] 测试证明 Evidence、offset、Resume Capsule、来源 Evidence IDs 在同一事务收敛。
- [x] 测试证明 Capsule 写入失败会回滚 Evidence 元数据和 offset，并清理 prepared blob。
- [x] 运行两个测试文件，确认旧实现无法满足新断言。
- [x] 将 commitRead() 改为：

~~~text
commit prepared Evidence
-> advance session_sync_state
-> read/decode verified Evidence
-> build bounded continuity
-> write Resume Capsule
~~~

- [x] 删除该路径中的 enqueueCompaction()；保留下一轮 sync 调度。
- [x] 通过构造参数注入窄 Resume Capsule writer；AutomationService 不得创建 repository。
- [x] 运行相关 ingestion、sync、Evidence Store、Evidence recovery 测试，预期通过。
- [x] 提交：feat: update session continuity during transcript sync。

### Task 3：活跃 Automation Job 从四类减到两类

**文件：** bootstrap.ts、automation contracts/repository、scheduler/status tests。

- [x] 先断言 Scheduler 只能 claim DISCOVER_CODEX_THREADS 和 SYNC_SESSION_TRANSCRIPT。
- [x] 旧的 queued compaction/extraction job 不得被 claim，也不得标记成功。
- [x] 删除 daemon 中 Compaction、Extraction、Candidate Application 的构造和 handler 注册。
- [x] 区分“历史可解析 job kind”和“当前可执行 job kind”，不改 migration CHECK。
- [x] 运行 scheduler/status tests 和 npm run build，预期通过。
- [x] 提交：refactor: reduce automation runtime to discovery and sync。

### Task 4：Continue 使用自动捕获的连续性

**文件：** runtime-services.ts、runtime-api.test.ts、transcript-import-api.test.ts。

- [x] 先写行为测试：绑定 Session 存在连续性 Capsule，Continue 后 adapter operation 必须为 resume、保持 external Session ID，并包含连续性文本。
- [x] 断言 prompt 不含 Evidence 文件路径、job payload 或无关内部 ID。
- [x] 运行新测试，确认旧 prompt 缺少该内容。
- [x] Continue 格式化 prompt 前读取 Resume Capsule；仅在非空时添加 Recent captured continuity 段落。
- [x] 分别运行 runtime-api.test.ts 和 transcript-import-api.test.ts。
- [x] 不得通过增加 timeout 掩盖生命周期失败。
- [x] 提交：feat: resume codex with captured session continuity。

### Task 5：简化生产 API 和 UI

**文件：** automation routes/contracts、frontend automation.ts、App.tsx、AutomationOverview、ProjectAutomationSettings 及相关测试。

- [x] 可见状态只保留：启用/关闭、Scheduler 状态、WATCHING Session 数、发现/同步 job 状态、最近同步、最近 Evidence、最后错误、运行发现。
- [x] 移除 Candidate 数、最近提取、accept/reject/retry 和自动化 Review UI。
- [x] 普通 Review 继续保留。
- [x] Candidate mutation API 统一返回 410 FEATURE_DEFERRED。
- [x] Settings 数据层兼容原 mode；UI 只表达自动化启用/关闭，不增加页面。
- [x] 运行 automation API/frontend contract tests、frontend:typecheck、frontend:build。
- [x] 预期通过。提交：refactor: focus automation ui on session continuity。

### Task 6：用一条生产路径 E2E 替换未完成规格

**文件：** automation-workflow.spec.ts、start-e2e-server.ts，必要时修改 Playwright automation config。

- [x] desktop/mobile 不得共享 Project、rollout、external Session ID、idempotency key 或 mutable fixture state。
- [x] fixture 只 stub 外部 Codex 协议和受控事件 append，不读写内部业务表。
- [x] 使用固定顺序：

~~~text
prepare fixture
-> UI 创建 Project
-> 正式 settings API 设置 enabled、pollIntervalMs=5000
-> 正式 discovery API/UI
-> Sessions API 等待绑定
-> fixture append（必须在绑定后）
-> 等待合法 poll interval 或再次调用正式 discovery
-> Session Evidence API 等待新批次
-> Resume Capsule API 等待引用该 Evidence
-> 正式 Continue API
-> 受控 adapter 断言 resume、相同 externalSessionId、包含预期上下文
~~~

- [x] 每个边界使用独立 expect.poll() 和明确失败信息。
- [x] 不查询 SQLite、job kind、Artifact 或 Candidate。
- [x] desktop 以 workers=1 连续运行两次，预期通过。
- [x] mobile 单独运行；locator 必须定位可见工作区，不得使用可能命中隐藏侧栏的 first()。
- [x] 提交：test: verify automatic codex session continuity。

### Task 7：真实 Codex smoke

**文件：** 新建 docs/verification/2026-09-21-contextos-codex-continuity-smoke.md。

- [ ] 使用临时 Project、临时 dataDir 和一次性 Codex 会话，不接触用户正常数据库。
- [ ] 用真实 Codex CLI/app-server 走完整验收链。
- [ ] 报告只记录 ID、时间、计数、hash 和 UI 结果，不记录 transcript 正文、凭据和私人路径。
- [ ] 结果只能是 PASS、FAIL_PRODUCT 或 BLOCKED_EXTERNAL。
- [ ] 登录、网络、额度问题属于 BLOCKED_EXTERNAL，不能记作 PASS。
- [ ] 只有真实 Continue 收到预期连续性摘录时才算 PASS。
- [ ] 提交：docs: record codex continuity smoke test。

### Task 8：验收后物理删除延后实现

- [ ] 只有 focused tests、完整 npm test、前后端 build、desktop/mobile E2E 和真实 smoke 全部通过后才执行。
- [ ] 对每个候选文件先跑 CodeGraph 和 rg，确认没有保留路径调用者。
- [ ] 删除 Compaction Artifact、Extractor、Candidate Application 的专属实现、导出、前端组件和测试。
- [ ] 保留 sanitizer、codec、Evidence、普通 Context Item/Review、Resume Capsule 和历史 migration。
- [ ] 更新 README，清楚区分当前功能与未来治理能力。
- [ ] 运行最终门禁：

~~~powershell
npm test
npm run build
npm run frontend:build
npx playwright test tests/e2e/automation-workflow.spec.ts --config=playwright.automation.config.ts --workers=1
git diff --check
git status --short
~~~

- [ ] 预期全部通过，无无关文件被暂存或覆盖。
- [ ] 提交：refactor: remove deferred context extraction pipeline。

## 5. 停止条件

出现以下任一情况，WorkBuddy 必须停止扩展并报告第一个失败边界：

- 正式 discovery 无法绑定受控 Codex thread；
- append 已写入 rollout，但正式 scheduled sync 无法捕获；
- Evidence、offset、Resume Capsule 无法形成一致事务；
- Continue 的 controlled adapter 测试无法观察 resume prompt；
- 修复要求改变首次绑定 EOF 语义；
- 修复要求改写或删除用户 schema；
- 测试必须直接 seed 数据库或直接调用内部 handler 才能通过；
- 只能通过增加 timeout、retry 或轮询频率掩盖失败。

报告必须包含执行命令和观察结果。后续验收未运行时，不得把当前阶段标记为完成。

## 6. 最终交付证据

| 证据 | 要求 |
|---|---|
| continuity builder tests | PASS |
| ingestion atomicity tests | PASS |
| runtime resume tests | PASS |
| 完整 Vitest | PASS；或单独复现并证明是既有失败 |
| backend build | PASS |
| frontend typecheck/build | PASS |
| desktop acceptance E2E | 连续两次 PASS |
| mobile acceptance E2E | PASS |
| real Codex smoke | PASS，否则产品仍未完成 |
| git diff --check | PASS |
| worktree audit | 无无关文件被暂存或覆盖 |

唯一允许的最终完成声明：

> 一个真实 Codex 会话已通过正式路径被发现并从 EOF 绑定；绑定后的新增事件被增量捕获并存成可校验 Evidence；本地确定性生成了有界会话连续性；Continue 通过生产路径把该连续性带回同一个 Codex 会话。
