# ContextOS 完整现状与后续路线

生成时间：2026-09-16

## 1. 当前结论

ContextOS 已完成 Codex-only 本地 MVP 的第一阶段闭环：

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

如果按最初完整设计定义，ContextOS 还没有完成多 Agent、Codex transcript 自动发现/实时采集、正式前端、完整 scheduler/outbox dispatcher、深层 provenance/versioning 等产品能力。

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

仍待后续：

- DB/file 跨崩溃 recovery。
- 更完整的 snapshot compare。
- 更系统的 evidence immutability enforcement audit。

### Phase E: Session Evidence / Resume Capsule

完成 first pass。

- Codex output evidence。
- ContextOS handoff prompt evidence。
- Resume Capsule。
- `GET /api/sessions/:id/evidence`。
- `GET /api/sessions/:id/resume-capsule`。

当前边界：

- 不会自动导入 Codex GUI 当前对话。
- 不会实时采集 Codex CLI 后续 transcript。

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
- Continue in Agent。
- New Rule。
- Settings。
- Session Context Package / Evidence / Resume Capsule 展示。

### Phase J: Adapter Contract Deepening

完成 Codex-only first pass。

- 新增 `AgentAdapter` contract。
- 新增 Codex-only registry。
- Continue 通过 `session.agentAdapterId` 查 registry。
- Codex capability 位预留：
  - `discover`
  - `launch`
  - `resume`
  - `inspectStatus`
  - `interrupt`
  - `importTranscript`

当前边界：

- Claude Code adapter 未实现。
- Cursor adapter 未实现。
- `inspectStatus` / `interrupt` / `importTranscript` 只是 capability 预留，尚无完整行为。

### Phase K: Packaging / Docs / Verification

完成 first pass。

- `npm run start:local`。
- `scripts/start-contextos.ps1`。
- `.env.example`。
- README 补启动、测试、Codex adapter、transcript 边界。
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
- 没有 transcript import UI。
- 没有 Evidence 内容查看/复制 handoff prompt 的完整交互。
- 没有 Context Source sync 操作体验。
- 没有正式 loading/error/empty-state 设计系统。
- 没有端到端浏览器自动化截图验收。

建议后续前端顺序：

1. 继续静态前端补最小操作体验，不立刻 React 迁移。
2. 增加 Session detail：显示 handoff prompt 摘要和复制入口。
3. 增加 Context evidence detail：查看 verify 状态、storageRef、metadata。
4. 等 API DTO 稳定后，再迁移 React/Vite。

## 5. Adapter 现状与遗留

当前只有 Codex adapter 真实启用。

已可做：

- `discover` Codex CLI。
- Windows `codex.cmd` 处理。
- launch Codex CLI。
- non-interactive output capture。
- 通过 registry 查询 adapter。

遗留：

- Codex transcript 文件自动发现与导入（手动 text payload API 已完成）。
- Codex inspectStatus。
- Codex interrupt。
- Codex resume 的深层语义。
- Claude Code adapter。
- Cursor adapter。
- adapter fixtures / shared contract test suite 更完整化。

建议后续 Adapter 顺序：

1. 先做 Codex transcript 文件位置调查和 adapter importTranscript 接入。
2. 再做 Codex inspectStatus / interrupt。
3. 再抽 shared adapter contract tests。
4. 最后才加 Claude Code / Cursor。

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

仍待后续：

- Codex transcript 文件位置自动发现。
- adapter `importTranscript` 接入。
- 实时 transcript bridge。
- message role/turn 解析。
- 前端 import UI。

### 6.2 Evidence / Context 深化

- Evidence Snapshot immutability 全链路约束。
- Snapshot compare。
- Context Item version history。
- Context Source sync first pass。

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
- 不要在 Codex import 稳定前加 Claude/Cursor。
- 不要把 ContextOS 宣传成完整多 Agent 记忆系统。

## 8. 推荐下一步

如果继续后端：

1. Snapshot compare。
2. Context Item version history 查询。
3. Context Source sync first pass。
4. Evidence DB/file 跨崩溃 recovery。

如果转前端：

1. Session detail 显示 handoff prompt。
2. Evidence detail/verify UI。
3. Context page 显示 derived/source 关系。

如果转 Adapter：

1. Codex transcript 文件位置调查。
2. Codex importTranscript first pass。
3. inspectStatus / interrupt。
