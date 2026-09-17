# ContextOS 完整现状与后续路线

生成时间：2026-09-16

## 1. 当前结论

ContextOS 已完成 Codex + Claude Code 本地 MVP 的第一阶段闭环：

```text
Project
  -> Session
  -> Context Package
  -> Continue in Agent
  -> Codex CLI launch
  -> Job / Run lifecycle
  -> Evidence / Handoff / Resume Capsule
  -> Rule evaluation / Review gate
  -> Activity / Audit / Outbox durable event
```

如果按“本地优先 Codex workspace loop”定义，当前版本已经可运行、可测试、可展示。

如果按最初完整设计定义，ContextOS 还没有完成多 Agent、正式前端、完整 scheduler/outbox dispatcher、深层 provenance/versioning 等产品能力。

## 2. 当前代码状态

最新已提交并推送到远端：

```text
8396025 feat: complete phase h reliability discipline
de222bc feat: deepen codex adapter loop
3c4152a feat: complete ContextOS Codex backend loop
```

当前未提交开发项：

- daemon data directory lock first pass。
- `/api/health` recovery 摘要。
- Evidence Store project 分区路径。
- Evidence Store 旧路径 verify 兼容测试。

未提交文件包括：

```text
apps/daemon/src/bootstrap.ts
apps/daemon/src/runtime-lock.ts
docs/superpowers/plans/2026-09-16-contextos-backend-completion-plan.md
packages/application/src/core/context-services.ts
packages/application/src/core/runtime-services.ts
packages/infrastructure/src/evidence/evidence-store.ts
tests/integration/context-resources-api.test.ts
tests/integration/daemon-health.test.ts
tests/integration/evidence-store.test.ts
```

最近验证通过：

```powershell
npm run build
npm test
node --check frontend/app.js
```

## 3. 已完成阶段

### Phase A: Codex Process Lifecycle

完成 first pass。

- Windows `codex.cmd` 处理。
- ProcessSupervisor 观察退出。
- run/job/session 可从 `RUNNING` 进入 `COMPLETED` 或 `FAILED`。
- 非零退出记录 failure metadata。

### Phase B: Runtime Recovery

完成 first pass。

- daemon 启动时恢复 orphan `RUNNING` continue runs。
- orphan run 标为 `FAILED`。
- recovery 写 activity/audit。
- health 现已暴露最小 recovery 摘要。

### Phase C: Context Package MVP

完成 first pass。

- Continue 前构建 Context Package。
- 记录 context item / evidence snapshot manifest。
- Session 关联 `context_package_id`。
- `GET /api/sessions/:id/context-pack` 可读。

### Phase D: Evidence Integrity

first pass 已完成，仍有深层硬化空间。

- evidence 写入使用临时文件、hash、atomic rename、fsync。
- verify 可重新计算 hash/size。
- 新 evidence 路径采用 `evidence/<projectId>/<snapshotId>.txt`。
- 旧 `evidence/<snapshotId>.txt` 仍可 verify。
- verify 发现文件缺失或内容不匹配时自动创建 Review Item。
- 重复 verify 复用活动中的同类 Review Item；关闭后故障复发会新建。
- `POST /api/evidence-snapshots/:id/compare` 可比较同 Project Snapshot 的 hash、size、type 和 source。
- `POST /api/evidence-snapshots/:id/compare-content` 可对通过完整性校验的同 Project 文本 Evidence 做行级正文比较，返回增删行位置/统计并限制响应字符数。
- `GET /api/context-items/:id/versions` 可读取连续编号的内容版本和创建者 provenance。
- `POST /api/context-items/:id/versions/:versionNumber/restore` 可将历史内容恢复为新版本，保留完整历史并记录恢复来源、Activity/Audit 与 revision 冲突。
- Evidence Snapshot 现由 SQLite trigger 禁止 UPDATE/DELETE，Evidence Store verify 也拒绝越出 `evidence/` 根目录的 storage reference。

已完成 DB/file 跨崩溃 recovery first pass：启动时清理未完成临时文件、隔离无 DB 引用的最终文件，并扫描已存储 Snapshot 的缺失/篡改状态，通过既有 Review Item 机制记录异常；health 暴露恢复计数且不泄露路径。

仍待后续：语义级 snapshot compare。

### Phase E: Session Evidence / Resume Capsule

完成 first pass。

- Codex output evidence。
- ContextOS handoff prompt evidence。
- Resume Capsule。
- `GET /api/sessions/:id/evidence`。
- `GET /api/sessions/:id/resume-capsule`。

当前边界：

- 已支持按 Project root 自动发现并显式导入本机 Codex transcript，首次导入后绑定 external session ID。
- 已绑定 Session 的 resume 进程退出后会 best-effort 自动回收同一 Codex transcript，按内容 hash 去重，并在回收失败时保留已落库 lifecycle 状态。
- 受管 Codex 进程运行期间会 best-effort 轮询 transcript，内容变化时导入新的 Evidence；进程退出后仍有 final reconcile 兜底。
- 不会采集非 ContextOS 受管的外部 Codex CLI 后续 transcript。

### Phase F: Core Resource Lifecycle

完成 first pass。

- Project archived 后拒绝新 session/continue。
- Session 状态转换加约束。
- Decision accepted 后禁止静默改写。
- Work Item 依赖 cycle/readiness 检查。
- Review resolve/dismiss 要求 reason 并写 action log。
- mutating route 使用 expected revision。

### Phase G: Rule Evaluation

完成 first pass。

- Rule evaluation 持久化。
- `POST /api/rules/:id/test`。
- `GET /api/rules/:id/evaluations`。
- BLOCK 阻断 runtime action。
- REQUIRE_REVIEW 生成 Review Item。

### Phase H: Reliability Discipline

完成 first pass。

- 通用 `Idempotency-Key` for `POST` / `PATCH`。
- 同 key 同请求 replay。
- 同 key 不同请求返回 `409 CONFLICT`。
- Project / Session / Runtime 关键路径写 Activity/Audit。
- Continue queued 写 durable outbox event：`session.continue.queued`。
- 当前只写 outbox，不派发；dispatcher 等真实消费者再做。

### Phase I: Static Frontend Action Wiring

完成 first pass。

- Add Project。
- New Session。
- New Session / Settings 使用 `/api/agent-adapters` 的动态 adapter 列表，可选择 Codex 或 Claude Code。
- Continue in Agent。
- Sessions 页显示 latest Session runtime status，并支持中断 RUNNING 的受管 agent 进程。
- Sessions 页支持对单个 Session 自动发现导入 transcript，或手动粘贴 transcript，并在 Evidence 列表显示 adapter/parser/message/turn metadata。
- Context 页支持创建 Context Source、同步 active Context Source，以及对 Evidence Snapshot 触发 verify。
- New Rule。
- Settings。
- Session Context Package / Evidence / Resume Capsule 展示。

### Phase J: Adapter Contract Deepening

完成 Codex + Claude Code first pass。

- 新增 `AgentAdapter` contract。
- registry 默认启用 Codex 和 Claude Code。
- Continue 通过 `session.agentAdapterId` 查 registry。
- Codex capability contract：
  - `discover`
  - `launch`
  - `resume`
  - `inspectStatus`
  - `interrupt`
  - `importTranscript`

当前边界：

- Cursor adapter 未实现。
- `inspectStatus` / `interrupt` / `importTranscript` 已有 Codex 和 Claude Code first pass 行为；已绑定 external session 的显式 UUID `resume` first pass 已完成。

### Phase K: Packaging / Docs / Verification

完成 first pass。

- `npm run start:local`。
- `scripts/start-contextos.ps1`。
- `.env.example`。
- README 补启动、测试、Codex/Claude Code adapter、transcript 边界。
- daemon SIGINT/SIGTERM graceful shutdown。
- local startup smoke 已通过。

## 4. 前端现状与遗留

当前前端仍是静态 HTML/CSS/JS：

```text
frontend/index.html
frontend/app.js
frontend/styles.css
```

已可做：

- 查看 Overview / Projects / Sessions / Review / Decisions / Work Items / Context / Rules / Settings。
- 创建 Project。
- 创建 Session。
- Continue in Agent。
- 创建 Rule。
- 查看 Session context package / evidence / resume capsule。

遗留：

- 没有 React/Vite 正式工程。
- 没有完整表单/详情页体验。
- transcript import 已有 Sessions 页最小 UI；仍缺更完整的导入历史和冲突处理体验。
- 没有 Evidence 内容查看/复制 handoff prompt 的完整交互。
- Context Source 创建、sync 和 Evidence verify 已有最小操作入口；仍缺 source 编辑/暂停/归档的完整 UI。
- 没有正式 loading/error/empty-state 设计系统。
- 没有端到端浏览器自动化截图验收。

建议后续前端顺序：

1. 继续静态前端补最小操作体验，不立刻 React 迁移。
2. 增加 Session detail：显示 handoff prompt 摘要和复制入口。
3. 增加 Context evidence detail：查看 verify 状态、storageRef、metadata。
4. 等 API DTO 稳定后，再迁移 React/Vite。

## 5. Adapter 现状与遗留

当前真实启用 Codex 和 Claude Code adapters。

已可做：

- `discover` Codex CLI。
- `discover` Claude Code CLI。
- Windows `codex.cmd` 处理。
- launch Codex CLI。
- launch Claude Code CLI。
- non-interactive output capture。
- 通过 registry 查询 adapter。
- inspect 受当前 daemon 管理的 Codex / Claude Code 进程。
- interrupt 受管进程树，并将 Session / Job / Run / attempt 原子记录为 `PAUSED` / `CANCELED`。
- Codex transcript 文件自动发现与 adapter `importTranscript` first pass。
- Codex transcript role/turn 解析 first pass：保留 user/assistant 正文，并输出 role counts、turn count、消息序号范围到 adapter response 和 Evidence metadata。
- Claude Code transcript 文件自动发现与 adapter `importTranscript` first pass：按 Project root 隔离，解析 `sessionId` / `cwd` 和 user/assistant 正文。
- runtime 生成的 handoff prompt、process output evidence、transcript evidence 标题和 Resume Capsule summary 已按 Session 选择的 adapter 使用 Codex 或 Claude Code 名称。
- 共享 adapter contract test harness，覆盖可用/不可用 discovery、launch/resume metadata、transcript normalization、stdout/stderr/exit、inspect 和 interrupt。
- 首次 Codex launch 会把 ContextOS handoff prompt 作为初始 prompt，并在退出后用唯一 Session marker 自动绑定产生的 Codex UUID。
- 已绑定 Session 的 Codex resume：Project 归属校验、增量 Context Package prompt、每次恢复独立 Job/Run、明确失败码且不静默降级为新会话。
- 已绑定 Session 的 resume 退出后自动回收 Codex transcript：内容变化写新 Evidence，未变化复用 Evidence，失败只记录 Activity/Audit。
- 运行中 transcript bridge first pass：受管 Codex 进程运行期间轮询同一 transcript，按内容 hash 去重写 Evidence。

遗留：

- Cursor adapter。
- adapter fixtures 仍需随新增 adapter 扩展。

建议后续 Adapter 顺序：

1. 完善 Codex tool event schema 和更细粒度增量事件模型。
2. 最后才加 Cursor，并复用 shared contract tests。

## 6. 后端遗留路线

### 6.1 Transcript Import

手动 text payload first pass 已完成。

已完成：

- `POST /api/sessions/:id/import-transcript`。
- 请求体支持 text payload、可选 title/summary。
- 写 `EvidenceSnapshot`：`evidenceType = AGENT_OUTPUT`。
- metadata 标记 `stream = imported-transcript`、sessionId、importedAt。
- 更新 Resume Capsule summary，并保留已有 evidence 与 lastRunId。
- project 分区文件、Activity/Audit、幂等回放和已结束 Session 导入均有集成测试。

自动发现与导入 first pass 已完成：

- `POST /api/sessions/:id/import-transcript/auto`。
- 从 Codex JSONL `session_meta` 或 Claude Code JSONL `sessionId` / `cwd` 读取外部 session 与 Project root，按 Session 的 adapter 隔离并选择最近匹配会话。
- 仅抽取 user/assistant 文本，排除 developer、推理密文、工具调用和工具输出。
- 记录 role counts、turn count、message ordinal 范围，供后续 UI 和 resume 逻辑使用。
- Session 绑定 external session ID；重复导入未变化内容时复用 Evidence。
- 首次 launch 后使用 handoff prompt 中的 `Session ID` marker 确定性匹配新 transcript 并自动绑定 Codex UUID；匹配不到或匹配不唯一时不会猜测绑定。
- 受管进程运行期间会启动 lightweight transcript bridge，找不到 transcript 时安静跳过，内容变化时导入 Evidence，退出后 final reconcile 兜底。
- 已绑定 Session 的 resume 退出后自动复用这套导入逻辑完成 transcript 回收；失败时记录 `TRANSCRIPT_RECONCILE_FAILED` Activity/Audit，不回滚 Run/Job 状态。

仍待后续：

- 更完整的 message schema 和 tool event 结构化解析。
- 前端 import UI。

### 6.2 Evidence / Context 深化

- Evidence Snapshot immutability 全链路约束。
- 正文或语义级 Snapshot compare。
- Context Item 更深层 provenance 与历史版本恢复。
- Context Source 的本地 `FILE` sync first pass 已完成：项目根目录边界校验、内容哈希去重、Evidence Snapshot 写入/复用、Source 乐观锁回写及 Activity/Audit 已闭环。

仍待后续：URL 抓取、目录递归、调度/重试和前端 sync UI。

### 6.3 Runtime / Jobs 深化

- job lease / claim。
- retry policy。
- outbox dispatcher。
- runtime health 细化。
- worker identity。

### 6.4 API Discipline

- idempotency 清理策略可配置。
- request hash/debug metadata。
- activity/audit query 内部 API。
- OpenAPI 或 typed client 生成。

## 7. 当前不要做的事

- 不要新增 Jobs / Audit / Outbox 产品页。
- 不要现在迁移 React，除非决定开始正式前端阶段。
- 不要现在加 Cursor，除非决定进入第三个 adapter 阶段。
- 不要把 ContextOS 宣传成完整多 Agent 记忆系统。

## 8. 推荐下一步

如果继续后端：完善 Codex tool event schema / 增量事件模型，或按前端集成反馈补齐 Context/Evidence API。

如果转前端：

1. Session detail 显示 handoff prompt。
2. Evidence detail/verify UI。
3. Context page 显示 derived/source 关系。

如果转 Adapter：

1. Codex tool event schema / 增量事件模型。
2. Cursor adapter 复用 shared contract tests。
