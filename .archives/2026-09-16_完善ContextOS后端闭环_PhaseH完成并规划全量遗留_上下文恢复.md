# 完善 ContextOS 后端闭环 - 上下文恢复文档

生成时间：2026-09-16 15:30
原始记录位置：Codex Desktop 当前任务；本地状态库位于 `C:\Users\cxsy5\.codex\state_5.sqlite` / `C:\Users\cxsy5\.codex\logs_2.sqlite`，未解析到单独 JSONL transcript 文件。

## 任务目标

继续完善 ContextOS 后端，从 Phase E 之后推进到 Codex-only 完整闭环，并在完成 H/J/K 后整理完整遗留路线，供新对话继续开发。

## 已完成

- 完成 Phase F/G/I：
  - core lifecycle hardening。
  - rule evaluation MVP。
  - static frontend action wiring。
- 完成 Phase J first pass：
  - `AgentAdapter` contract。
  - Codex-only registry。
  - adapter capability 位预留。
- 完成 Phase K first pass：
  - `npm run start:local`。
  - `.env.example`。
  - README 启动/测试文档。
  - daemon graceful shutdown。
- 完成 Phase H first pass：
  - `Idempotency-Key`。
  - Project / Session / Runtime Activity + Audit。
  - durable outbox event：`session.continue.queued`。
- 当前未提交但已验证完成：
  - daemon data directory lock。
  - `/api/health` recovery 摘要。
  - Evidence Store project 分区路径。
  - legacy evidence storageRef verify 兼容。
- 生成完整路线文档：
  - `docs/2026-09-16-contextos-complete-status-and-roadmap.md`

## 当前状态

最新已推送提交：

```text
8396025 feat: complete phase h reliability discipline
de222bc feat: deepen codex adapter loop
3c4152a feat: complete ContextOS Codex backend loop
```

当前未提交变更：

```text
apps/daemon/src/bootstrap.ts
apps/daemon/src/runtime-lock.ts
docs/2026-09-16-contextos-complete-status-and-roadmap.md
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

## 关键约束

- 用户明确要求：不要用 CodeGraph。
- 用户曾明确要求：Codex-only 完整闭环优先，暂不做多 Agent。
- 最近阶段要求：除了前端和 Adapter 先不做；后续又要求完整文档中把前端和 Adapter 遗留也加上。
- 不新增 Jobs / Audit / Outbox 产品页。
- 静态前端保留，React 迁移后置。
- 本地运行数据 `.contextos*` 不进 git。
- 当前 daemon 只应监听 loopback。

## 下一步任务

推荐在新对话中按此顺序继续：

1. 提交当前未提交的 daemon lock + evidence partition + docs/archive 变更。
2. 做后端 transcript import first pass：
   - `POST /api/sessions/:id/import-transcript`
   - text payload -> Evidence Snapshot
   - metadata `stream = imported-transcript`
   - 更新 Resume Capsule。
3. 再做 Evidence/Context 深化：
   - snapshot compare。
   - evidence mismatch review item。
   - context item version history。
4. 如转前端：
   - Session detail 展示/copy handoff prompt。
   - Evidence detail + verify UI。
5. 如转 Adapter：
   - Codex transcript 文件位置调查。
   - Codex importTranscript。

## 关键决策记录

- Session 不是普通 chat，而是 ContextOS 管理的一次 Agent work episode。
- Create Session 和 Continue in Agent 分离：
  - Create Session 登记任务。
  - Continue in Agent 才启动 Codex。
- 当前 Codex CLI 不会自动知道 Codex GUI 对话，这是已知边界，不是 bug。
- 先做 handoff evidence，而不是立即做实时 transcript bridge。
- Adapter registry 只启用 Codex；Claude/Cursor 后置。
- Outbox 当前只写 durable event，不做 dispatcher。
- Evidence 新路径按 project 分区，同时保留旧路径 verify 兼容。

## 踩坑记录

- Project root path 如果保存成带引号的 `"D:\project\ContextOS"`，Codex launch 会失败。已在前端创建 project 时去掉外层引号。
- Codex launch 失败后 session 曾假 `RUNNING`。已修复为同步变 `FAILED`。
- Windows temp dir 删除 evidence 目录可能 ENOTEMPTY。`runtime-recovery.test.ts` 增加 `rmWithRetry`。
- Codex Desktop 当前对话 transcript 不像旧 sessions JSONL 那样容易定位；归档中记录了本地状态库位置。

## 涉及文件

- `apps/daemon/src/bootstrap.ts`
- `apps/daemon/src/http/idempotency.ts`
- `apps/daemon/src/main.ts`
- `apps/daemon/src/runtime-lock.ts`
- `frontend/app.js`
- `packages/application/src/core/context-services.ts`
- `packages/application/src/core/runtime-services.ts`
- `packages/application/src/ports/agent-adapter.ts`
- `packages/infrastructure/src/adapters/codex-adapter.ts`
- `packages/infrastructure/src/adapters/registry.ts`
- `packages/infrastructure/src/evidence/evidence-store.ts`
- `packages/infrastructure/src/sqlite/core-repositories.ts`
- `packages/infrastructure/src/sqlite/project-repository.ts`
- `packages/infrastructure/src/sqlite/runtime-repository.ts`
- `tests/integration/*`
- `README.md`
- `.env.example`
- `docs/superpowers/plans/2026-09-16-contextos-backend-completion-plan.md`
- `docs/2026-09-16-contextos-complete-status-and-roadmap.md`

