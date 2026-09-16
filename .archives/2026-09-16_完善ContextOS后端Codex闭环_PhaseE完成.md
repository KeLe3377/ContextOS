# 2026-09-16_完善ContextOS后端Codex闭环_PhaseE完成

> 归档时间：2026-09-16（Asia/Shanghai）  
> 原始记录位置：Codex Desktop 当前任务；本轮工具环境未暴露精确本地 transcript 路径，未改动任何原始会话记录。  
> 归档目的：为新对话恢复 ContextOS 后端开发上下文，继续 Phase F/G/I。

---

## 🎯 任务目标

在 ContextOS 简略版已经跑通后，重新对照原始设计计划，补齐被简化跳过的后端能力；优先把单 Codex 路线做成可日常使用的闭环，而不是先扩 Claude Code / Cursor 等多 Agent。

---

## ✅ 已完成

### 1. 重新梳理并生成完善计划

新增计划文档：

- `D:\project\ContextOS\docs\superpowers\plans\2026-09-16-contextos-backend-completion-plan.md`

该文档对照了原始后端实现计划 Task 1-8，明确当前简略版已完成、简化完成、未完成的部分，并拆成后续 Phase A-K。

关键结论：

- 先做 Phase F/G/I，使项目成为可操作的本地 Agent Workspace。
- Phase J 暂不做多 Agent，优先让 Codex 一个 adapter 能完整运行。
- Jobs / Audit / Outbox 是内部基础设施，不新增产品页面。
- 前端暂不迁移 React，先继续用现有静态前端接真实 API。

### 2. Phase A：Codex process lifecycle first pass complete

修改/新增：

- `packages/infrastructure/src/adapters/codex-adapter.ts`
- `packages/infrastructure/src/process-supervisor.ts`
- `packages/application/src/core/runtime-services.ts`
- `packages/infrastructure/src/sqlite/runtime-repository.ts`
- `tests/integration/codex-adapter.test.ts`
- `tests/integration/runtime-api.test.ts`

已完成能力：

- Windows 下 Codex 默认使用 `codex.cmd`。
- `.cmd/.bat` 通过 `cmd.exe /d /s /c ...` 包装执行，避免 `spawnSync("codex") ENOENT`。
- `ProcessSupervisor` 监听进程 exit。
- `ContinueSessionService` 在进程退出后回写：
  - exit code `0` → job/run `SUCCEEDED`，session `COMPLETED`
  - 非零退出或 signal → job/run/session `FAILED`
- 自动测试使用 `process.execPath` fake command，不依赖真实 Codex。

### 3. Phase B：minimal runtime recovery first pass complete

修改/新增：

- `apps/daemon/src/bootstrap.ts`
- `packages/infrastructure/src/sqlite/runtime-repository.ts`
- `tests/integration/runtime-recovery.test.ts`

已完成能力：

- daemon 启动时调用 `recoverOrphanRunningContinues(nowMs())`。
- 数据库里遗留的 `RUNNING` continue job/run 会被标成：
  - `FAILED`
  - `failureCode = DAEMON_RESTARTED`
- 同步更新 session 为 `FAILED`。
- 写入 Activity / Audit 记录。

这是最小恢复，不是完整 lease/retry scheduler。

### 4. Phase C：Context Package MVP first pass complete

修改/新增：

- `packages/contracts/src/context.ts`
- `packages/infrastructure/src/sqlite/runtime-repository.ts`
- `packages/application/src/core/runtime-services.ts`
- `packages/application/src/core/core-services.ts`
- `apps/daemon/src/http/routes/core-resources.ts`
- `tests/integration/runtime-api.test.ts`

已完成能力：

- Continue Session 前生成 Context Package。
- 选择当前 Project 下 `ACTIVE` Context Items。
- 自动纳入 Context Items 关联的 Evidence Snapshots。
- 写入 `context_packages`。
- 回填 `sessions.context_package_id`。
- 新增 API：

```text
GET /api/sessions/:id/context-pack
```

返回：

- `contextItems`
- `evidenceSnapshots`
- `manifest`
- `purpose`
- `sessionId`
- `projectId`

### 5. Phase D：Evidence integrity hardening first pass complete

修改/新增：

- `packages/infrastructure/src/evidence/evidence-store.ts`
- `packages/application/src/core/context-services.ts`
- `apps/daemon/src/http/routes/context-resources.ts`
- `tests/integration/context-resources-api.test.ts`
- `tests/integration/runtime-api.test.ts`

已完成能力：

- Evidence Store 由后端计算 `sha256`。
- 如果请求传入 `contentHash`，必须和 `contentText` 匹配，否则返回 `INVALID_ARGUMENT`。
- 写入流程改为 temp file → fsync → atomic rename → directory fsync（Windows 下不支持时降级）。
- 新增 verify API：

```text
POST /api/evidence-snapshots/:id/verify
```

返回：

- `exists`
- `verified`
- `expectedHash`
- `actualHash`
- `expectedSizeBytes`
- `actualSizeBytes`
- `failureCode`
- `failureMessage`

### 6. Phase E：Session evidence + Resume Capsule MVP first pass complete

修改/新增：

- `packages/infrastructure/src/process-supervisor.ts`
- `packages/infrastructure/src/adapters/codex-adapter.ts`
- `packages/contracts/src/sessions.ts`
- `packages/application/src/core/runtime-services.ts`
- `packages/application/src/core/core-services.ts`
- `packages/infrastructure/src/sqlite/runtime-repository.ts`
- `apps/daemon/src/bootstrap.ts`
- `apps/daemon/src/http/routes/core-resources.ts`
- `tests/integration/runtime-api.test.ts`

已完成能力：

- `ProcessSupervisor` 支持 bounded stdout/stderr capture，最多 64KB。
- Codex short/non-interactive run 输出会保存为 `AGENT_OUTPUT` Evidence Snapshot。
- 新增 Session evidence API：

```text
GET /api/sessions/:id/evidence
```

- 新增 Resume Capsule API：

```text
GET /api/sessions/:id/resume-capsule
```

- Resume Capsule 目前存储在 `sessions.runtime_state.resumeCapsule`，包含：
  - `summary`
  - `nextAction`
  - `lastRunId`
  - `evidenceSnapshotIds`
  - `updatedAt`

注意：真实交互式 Codex 的完整 transcript capture 还没做，后续属于 Codex adapter 深化，不先扩多 Agent。

---

## 🔧 当前状态

### 最近已验证

最后一次完整验证通过：

```powershell
npm run build
npm test
```

结果：

```text
10 test files passed
23 tests passed
```

### 当前 Git 状态

最近提交基线：

```text
0ee1563 feat: connect frontend to daemon APIs
```

当前工作区未提交，包含 Phase A-E 的全部改动和归档文档。

`git status --short` 当前主要为：

```text
 M apps/daemon/src/bootstrap.ts
 M apps/daemon/src/http/routes/context-resources.ts
 M apps/daemon/src/http/routes/core-resources.ts
 M packages/application/src/core/context-services.ts
 M packages/application/src/core/core-services.ts
 M packages/application/src/core/runtime-services.ts
 M packages/contracts/src/context.ts
 M packages/contracts/src/sessions.ts
 M packages/infrastructure/src/adapters/codex-adapter.ts
 M packages/infrastructure/src/evidence/evidence-store.ts
 M packages/infrastructure/src/process-supervisor.ts
 M packages/infrastructure/src/sqlite/runtime-repository.ts
 M tests/integration/context-resources-api.test.ts
 M tests/integration/runtime-api.test.ts
?? docs/superpowers/plans/2026-09-16-contextos-backend-completion-plan.md
?? tests/integration/codex-adapter.test.ts
?? tests/integration/runtime-recovery.test.ts
```

### 刚刚暂停点

用户要求先暂停并归档，因为当前对话空间不多。

暂停前刚开始 Phase F：Core resource lifecycle hardening。只读取了相关文件，还没有写入 Phase F 代码。

已读取/关注文件：

- `packages/infrastructure/src/sqlite/core-repositories.ts`
- `packages/application/src/core/core-services.ts`
- `packages/infrastructure/src/sqlite/project-repository.ts`
- `packages/application/src/project/project-service.ts`
- `packages/contracts/src/review-items.ts`
- `packages/contracts/src/decisions.ts`
- `packages/contracts/src/work-items.ts`
- `tests/integration/core-resources-api.test.ts`

---

## ⚠️ 关键约束

- 不要使用 CodeGraph，除非用户明确初始化或要求。
- 不要再做红灯测试 / failing-test-first 循环；实现后做 targeted verification。
- 工具不稳定时减少碎动作，批量读取/写入。
- 不新增前端页面和产品模块。
- Jobs / Audit / Outbox 是内部基础设施，不是产品页。
- 现有正式产品页仍然是：Overview、Projects、Sessions、Review Inbox、Decisions、Work Items、Context、Rules。
- 前端暂时不迁移 React；后端稳定后再迁移。
- 后续不优先做 Claude Code / Cursor，多 Agent 暂缓。
- 用户明确表示：Codex 一个能完整运行就不错了。
- 后续优先完成 Phase F/G/I。

---

## 🚧 下一步任务

用户最新明确方向：

> “对，先完成Phase F/G/I，后面的J，多agent不需要先做，codex一个能运行完整就不错了。”

因此新对话应继续：

### Phase F：Core resource lifecycle hardening

优先补基础约束：

1. Session lifecycle
   - 只允许 `CREATED / PAUSED / FAILED / COMPLETED` 等合理状态继续。
   - `ARCHIVED` session 不允许 continue。
   - 正在 `RUNNING` 的 session 不允许重复 continue。

2. Project boundary
   - `ARCHIVED` project 不允许创建新 session。
   - `ARCHIVED` project 下 session 不允许 continue。

3. Decision lifecycle
   - `ACCEPTED` decision 不允许普通 PATCH 静默改写。
   - 后续重大变化必须用 supersede/reverse。第一版可先拒绝 PATCH accepted。

4. Work Item lifecycle
   - `DONE / CANCELED` 不允许 start/block/send-to-review/complete 等无效动作。
   - 第一版暂不做完整 dependency cycle。

5. Review Item lifecycle
   - `resolve` 已要求 `resolutionReason`。
   - 建议让 `dismiss` 也要求 reason，写入 `resolutionReason`。

建议测试：扩展 `tests/integration/core-resources-api.test.ts`。

### Phase G：Rule evaluation MVP

目标：Rules 不只是 CRUD，而是能在 runtime 中产生最小治理效果。

第一版建议：

1. `POST /api/rules/:id/test`
2. `GET /api/rules/:id/evaluations`
3. 在 session continue 事件上运行 active rules
4. `REQUIRE_REVIEW` 创建 Review Item
5. `BLOCK` 阻止 continue

注意：不新增 Rules 外的新页面，只服务现有 Rules / Review Inbox。

### Phase I：Frontend action wiring

目标：现有静态前端不只是读 API，还能做基础操作。

优先：

1. `Continue in Agent` 按钮调用真实 continue API。
2. Settings 显示 Codex adapter 状态。
3. Sessions 页面能看到 context pack / evidence / resume capsule 的基础信息或刷新后数据。
4. 不迁移 React，不新增页面。

---

## 💡 关键决策记录

- 决定先写完整完善计划，再继续补后端，避免盲目开发。
- 决定 Phase A-E 都做 first pass，不追求一次完成原设计所有深度。
- 决定 `context_packages` 第一版复用现有表字段，不新增 migration；manifest 由 API DTO 展开。
- 决定 Evidence Hash 以后端计算为准，前端/调用方传 hash 时只作为校验。
- 决定 Resume Capsule 第一版存入 `sessions.runtime_state`，不新增独立表。
- 决定真实交互式 Codex transcript capture 暂不做，先捕获短命令/非交互输出。
- 决定多 Agent 暂缓，Codex-only 完整闭环优先。

---

## 🐛 踩坑记录

- Windows 下 Node `spawnSync("codex")` 找不到 npm global CLI，原因是需要 `.cmd` shim。已修为 `codex.cmd`。
- `shell: true` 会触发 Node 安全警告。已改成显式 `cmd.exe /d /s /c ...` 包装。
- `cmd.exe` 参数如果给普通 `codex.cmd` 加错引号，会变成字面量 `"codex.cmd"`，导致找不到命令。已修 quote 策略。
- 测试中真实 Codex 曾被打开。用户后来说明不必单独扩“隔离真实 Codex”，继续原设计即可。
- Windows 下文件 `fsync` 可能 `EPERM`。Evidence Store 已对 Windows 做兼容降级。
- `tsx -e` 顶层 await 在当前环境报 CJS 限制，用 IIFE 调试。
- PowerShell 字符串替换曾产生 TS 字符串转义问题，已修正。

---

## 📁 涉及文件

### 新增

- `D:\project\ContextOS\docs\superpowers\plans\2026-09-16-contextos-backend-completion-plan.md`
- `D:\project\ContextOS\tests\integration\codex-adapter.test.ts`
- `D:\project\ContextOS\tests\integration\runtime-recovery.test.ts`
- 本归档：`D:\project\ContextOS\.archives\2026-09-16_完善ContextOS后端Codex闭环_PhaseE完成.md`

### 重点修改

- `D:\project\ContextOS\apps\daemon\src\bootstrap.ts`
- `D:\project\ContextOS\apps\daemon\src\http\routes\context-resources.ts`
- `D:\project\ContextOS\apps\daemon\src\http\routes\core-resources.ts`
- `D:\project\ContextOS\packages\application\src\core\context-services.ts`
- `D:\project\ContextOS\packages\application\src\core\core-services.ts`
- `D:\project\ContextOS\packages\application\src\core\runtime-services.ts`
- `D:\project\ContextOS\packages\contracts\src\context.ts`
- `D:\project\ContextOS\packages\contracts\src\sessions.ts`
- `D:\project\ContextOS\packages\infrastructure\src\adapters\codex-adapter.ts`
- `D:\project\ContextOS\packages\infrastructure\src\evidence\evidence-store.ts`
- `D:\project\ContextOS\packages\infrastructure\src\process-supervisor.ts`
- `D:\project\ContextOS\packages\infrastructure\src\sqlite\runtime-repository.ts`
- `D:\project\ContextOS\tests\integration\context-resources-api.test.ts`
- `D:\project\ContextOS\tests\integration\runtime-api.test.ts`

---

## 💬 精华对话片段

> 用户：“好了，这样我们之前的简略版的跑通了。我们重新梳理一下，之前跳过的步骤然后开始完善”

> 用户：“不对，不是直接就开始补，还是先生成一份文档，针对之前一开始设计的计划没做的，完整的完善计划，然后开始补”

> 助手：“先回到计划层：我会先查 README、.archives 和现有任务/文档，把最初设计里被简化版跳过的部分整理成一份可执行的完善计划文档，再按这个文档继续补。”

> 用户：“必要性不大，先继续之前设计的”

这句是针对“把真实 Codex launch 和测试/smoke 更明确隔离”的建议，用户表示不必单独展开，继续主计划。

> 用户：“对，先完成Phase F/G/I ，后面的J，多agent不需要先做，codex一个能运行完整就不错了。”

这是最新执行方向。

---

## ✅ 新会话恢复建议

新对话开头可以直接说：

```text
继续 ContextOS 后端完善。请读取 .archives/2026-09-16_完善ContextOS后端Codex闭环_PhaseE完成.md 和 docs/superpowers/plans/2026-09-16-contextos-backend-completion-plan.md。不要用 CodeGraph。先完成 Phase F/G/I，暂不做多 Agent，Codex-only 完整闭环优先。
```
