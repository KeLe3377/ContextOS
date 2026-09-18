# 产品化 ContextOS 并确立 Codex Desktop 实时同步优先级

> 归档时间：2026-09-18 15:20（Asia/Shanghai）  
> 原始记录位置：`C:\Users\cxsy5\.codex\sessions\2026\09\17\rollout-2026-09-17T13-48-04-01a0ade8-6848-7d91-a328-b7780587365e.jsonl`（保持只读，未改动原始文件）  
> 会话时长：约 25 小时 32 分钟（含间歇等待）  
> 压缩率：原始约 39.8 MiB -> 归档约 16.1 KiB

---

## 🎯 任务目标

在 React 前端 first pass 基础上快速产品化 ContextOS，补齐 Sessions、Context/Evidence、Review、Decisions、Work Items、Rules、Overview、Runtime 和 Agent transcript 的真实前后端闭环；最终确认下一阶段最高优先级是让 ContextOS 与用户唯一使用的 Codex Desktop 当前任务真正同步，而不只是启动独立 Codex CLI 进程。

---

## ✅ 已完成的工作

### 1. 产品化计划和真实对象工作区

- 新增并持续维护 `CONTEXTOS_PRODUCTIZATION_PLAN.md`，作为设计边界和开发顺序的当前事实来源。
- Sessions、Context、Review Inbox、Decisions、Work Items、Rules 都从简单表格扩展为选中对象详情工作区。
- 保持页面所有权边界，没有新增 Jobs/Audit/Outbox 产品页。

### 2. Sessions 和 transcript 连续性

- Session 详情包含身份、Project、adapter、外部 Session ID、runtime、Context Package、Resume Capsule、Evidence、Activity 和 Run History。
- 支持创建、归档、Continue、Interrupt、手动粘贴 transcript、自动导入已有 agent session、显式同步 transcript、编辑/导出 Resume Capsule。
- 已绑定 Session 使用明确的 external session UUID 恢复；未绑定 Session 首次 launch 后可自动绑定。
- 运行期间 transcript bridge 会轮询同一 transcript，退出后 final reconcile；内容 hash 未变化时复用 Evidence。
- Run History 保留历史失败，不会被后续重试覆盖；Settings Runtime Health 可跳回所属 Session。

### 3. Context 和 Evidence

- Context Source 支持详情、编辑、同步、暂停、恢复、归档。
- Evidence 支持内容查看、完整性验证、同 Source 快照比较。
- 支持从 Evidence 派生 Context Item；Context Item 支持编辑、生命周期、版本历史和恢复。
- Evidence 文件丢失或 hash 不匹配会生成 Review Item；启动恢复会处理 temporary/orphaned/missing/mismatched Evidence。

### 4. Review Inbox

- Review Item 支持详情、source/trigger/priority/reviewer、操作历史。
- 支持 Start、Assign、Resolve、Dismiss，要求书面原因并记录 Activity/Audit。
- Evidence 完整性失败和 Rule `REQUIRE_REVIEW` 已能产生真实 Review Item。

### 5. Decisions

- 支持创建 Decision，记录 statement、rationale、problem context、alternatives、consequences、references。
- Draft/Proposed 可编辑，正文修改生成新版本；详情显示版本历史。
- 当前 UI 提供 Propose、Accept、Archive；后端还具备 supersede/reverse/review action，但前端尚未开放。

### 6. Work Items 和 Agent 执行闭环

- 支持创建、编辑、父子层级、依赖、验收条件、执行契约和 readiness。
- 支持 Backlog、Ready、In Progress、Blocked、In Review、Done、Canceled 生命周期。
- Block/Resolve Blocker 要求书面原因和解决说明并保留历史。
- Ready Work Item 可启动关联 Session；Agent Attempt 会随 Session/Run 回写 `SUCCEEDED`、`FAILED` 或 `CANCELED`。
- Work Item 详情显示 Child Items、Attempts、失败码、Run ID 和 Activity/Audit。

### 7. Rules 和 agent 指令文件

- Rule 详情显示版本、validation、scope、conditions、effect、enforcement、usage 和近期 evaluations。
- `WARNING`、`REQUIRE_REVIEW`、`BLOCK` 已作用于 runtime。
- 支持预览/应用项目 `AGENTS.md` 和 `CLAUDE.md`；只替换 `CONTEXTOS_RULES` 托管块，保留人工内容。
- 后端支持 project/global instruction targets；前端日常入口以项目文件为主。

### 8. Overview、Context Package 和 Runtime 可靠性

- `/api/workspace/overview` 提供真实 KPI、next work、pending reviews、context health、last Session 和 latest Context Package。
- Context Package 升级为不可变 v2 selection manifest，包含 Work Item/依赖、Accepted Decisions、ACTIVE Context/Evidence、ACTIVE Rules 和 selection reason。
- Agent handoff/resume prompt 包含可读摘要，而非只有 ID。
- daemon 优雅关闭会终止进程树并将 Session/Run/Job/Attempt 正确改为 PAUSED/CANCELED。
- 异常重启保留 orphan recovery；stale runtime lock 可自动清理。

### 9. Codex / Claude transcript 深化

- Codex parser 升级到 `codex-jsonl.v5`，支持当前真实格式：
  - message；
  - function/tool call 和 result；
  - `custom_tool_call` / `custom_tool_call_output`；
  - reasoning summary / `summary_text`；
  - ISO event timestamp。
- Claude Code parser 升级到 `claude-code-jsonl.v4`，达到同一标准化事件契约。
- 单条工具输入/输出限制为最终 20,000 字符，保留首尾、真实省略数量和 `truncated` 标志。
- transcript events API 返回最新 200 条而非最早 200 条；Session UI 展示最新 12 条并区分 import-size truncation 与 event-window truncation。
- 对当前真实 Codex transcript 的只读探针确认：保留窗口内 702/702 个事件带有效时间戳。

### 10. 浏览器 E2E 和移动端修复

- 新增隔离数据目录、确定性失败 Codex fixture 和 Playwright desktop/mobile 项目。
- E2E 覆盖 UI 创建 Project/Session、Continue、失败 Run History、Runtime Health。
- E2E 覆盖 Work Item 创建、Ready、Start Session、Agent Continue、失败 Attempt 回写。
- 修复移动端长弹窗高度、长 select intrinsic width、Grid 子项撑宽页面和 Badge wrapping。
- 当前 Playwright 结果：4/4 通过；Vitest：19 files、97 tests 通过。

### 11. 使用文档

- `CONTEXTOS_USAGE.md` 已同步真实 Review、Decision、Work Item、Rules、transcript event 和 E2E 工作流。
- README 已同步 Codex v5、Claude Code v4 和稳定启动/验证命令。

### 12. 本阶段关键提交

```text
300414f docs: sync product usage guide
1fbef74 feat: timestamp normalized transcript events
20e3298 feat: bound transcript tool output
a7bbaec feat: show latest transcript event window
e8e28a0 feat: support current codex transcript events
08ffaaf test: cover work item execution browser flow
1834673 test: cover project and session browser flow
9a1217e test: add browser workspace smoke coverage
e1b4cf9 feat: expose session run history and failures
770f190 feat: cancel managed runs on daemon shutdown
1567698 feat: add work item hierarchy and activity
58e2aad feat: complete work item blocker flow
4a36279 feat: enrich session context packages
8b26c2d feat: reconcile work item session attempts
ecaf149 feat: start sessions from work items
982018a feat: expose session transcript events
db854e3 feat: normalize claude transcript events
44cc455 feat: normalize codex transcript events
b755104 feat: surface runtime health and session activity
695dc70 feat: add workspace overview endpoint
0106660 feat: render rules to agent instruction files
4e46041 feat: add work item detail workspace
0fe4b90 feat: add decision detail versioning
36480b2 feat: add review inbox workspace
67fd6cb feat: edit context resources from workspace
0f36ee9 feat: derive context items from evidence
7e0688d feat: compare source evidence snapshots
7e786b2 feat: add context source detail workspace
bd28083 feat: sync agent transcripts from sessions
176a681 feat: complete session capsule workflow
70db907 feat: add selected session detail workspace
16539f9 docs: add ContextOS productization plan
```

---

## 🔧 当前代码/系统状态

- Repository：`D:\project\ContextOS`
- Branch：`master`
- 最近提交：`300414f docs: sync product usage guide`
- 已验证：

  ```powershell
  npm run build:all
  npm test
  npm run test:e2e
  git diff --check
  ```

- 最新测试基线：19 个 Vitest files、97 tests；4 个 Playwright desktop/mobile tests。
- 工作区只有一个与本阶段无关的未跟踪文件：

  ```text
  docs/2026-09-18-agent-chat-extractor-comparison.md
  ```

  不要擅自删除、修改或加入后续提交。

- ContextOS 已可作为本地 Agent workspace 使用，但当前 `Continue in Agent` 启动/恢复的是 daemon 管理的独立 Codex CLI 进程，不是用户当前正在操作的 Codex Desktop 任务。

---

## ⚠️ 关键约束与要求

- 用户现在只使用 Codex Desktop；下一阶段最高优先级不是 Cursor、安装器或普通 UI 收尾，而是 Codex Desktop 实时双向同步。
- 不要把“读取 Codex JSONL”“CLI resume 同一 UUID”“控制 Codex Desktop 当前任务”混成同一个能力，必须分别验证。
- 原始 Codex transcript 保持只读；ContextOS 只能写自己的 Evidence/DB，除非证明确有受支持的 Codex 接口允许写入。
- 不能用轮询后手动 Import Existing Session 冒充实时双向同步。
- 不要假设 Codex Desktop 会自动显示由 `codex exec resume <uuid>` 写入的内容；必须实测 Desktop UI、JSONL 和 CLI 三者行为。
- 先做可证伪的本地实验和技术边界说明，再修改产品合同和 UI 文案。
- 保持后端/前端同步；每个可交付增量验证后提交。
- Jobs/Audit/Outbox 仍是内部支持基础设施，不新增产品页。
- 不修改无关未跟踪文件 `docs/2026-09-18-agent-chat-extractor-comparison.md`。

---

## 🚧 未完成 / 下一步

### P0：Codex Desktop 实时双向同步（下一对话直接从这里开始）

目标不是再启动一个看不见的 CLI 会话，而是让 ContextOS 围绕用户正在使用的 Codex Desktop 当前任务保持连续同步。

第一步必须完成技术可行性调查：

1. 用当前任务 UUID `01a0ade8-6848-7d91-a328-b7780587365e` 观察 Desktop 对话时 JSONL 是否实时 append，以及写入延迟、原子性和 partial-line 行为。
2. 验证 ContextOS 能否仅凭 Project root 稳定识别“当前活跃 Desktop task”，还是必须由用户显式绑定 UUID。
3. 在安全 fixture/测试任务中验证 `codex exec resume <uuid> -` 是否：
   - append 到同一 JSONL；
   - 被 Codex Desktop 同一任务实时看到；
   - 会不会产生并发写、状态损坏或 UI 不刷新。
4. 调查 Codex Desktop 是否存在受支持的本地 API、IPC、数据库契约或 task/thread 接口。不能依赖未经验证的 SQLite 直接写入。
5. 将能力拆成三级并明确产品承诺：
   - Level A：Desktop -> ContextOS 实时只读同步（文件 watcher/tailer）；
   - Level B：ContextOS -> 同一 Codex UUID 的受管 CLI resume；
   - Level C：ContextOS -> 当前 Codex Desktop UI task 的真正消息发送/状态控制。
6. 如果 Level C 没有受支持接口，产品必须明确标注限制，优先把 Level A 做成可靠实时同步，再评估 Desktop 插件/官方 API/用户确认的桥接方案。

建议第一个实现增量：

- 新建独立、可测试的增量 JSONL tailer，按 byte offset 读取 append 内容，容忍 partial line、truncate/rotate、daemon restart。
- 将新增标准化事件增量写入 Session sync state，而不是每 1.5 秒重读并重新 hash 整个 transcript。
- Session UI 显示 Desktop binding、last observed event time、sync lag、watcher status 和明确的 one-way/two-way capability。
- 先用 fixture 和当前 transcript 的只读副本验证，不直接改真实 transcript。

### P1：现有产品收尾

- `confirmDestructiveActions` 已保存但尚未驱动 Archive/Cancel/Block 等确认 UI。
- `launchAtStartup` 已保存但没有 Windows startup/service 实现。
- Projects 缺少 selected Project detail workspace。
- Decision 后端 supersede/reverse/review 尚无前端入口；Compare Versions 未完成。
- 浏览器 E2E 尚未覆盖 Review、Decision、Context/Evidence、Rules 文件写入。
- Cursor adapter 明确暂缓。

---

## 💡 关键决策

- Codex 是主链路；Claude Code 做到共享 adapter parity，Cursor 暂缓。
- Context Package 必须不可变、可解释、可复现，选择理由随包保存。
- Evidence 不可变；Context/Decision 等派生对象通过版本更新，不能改写历史。
- Work Item Agent Attempt 必须绑定真实 Session/Run 生命周期，不能停留在假 `STARTED` 状态。
- daemon shutdown 应主动取消受管运行；startup recovery 只处理真正异常遗留。
- transcript 标准化采用 agent-neutral event schema，UI 不依赖 Codex/Claude 私有结构。
- 当前 Codex transcript 的真实格式以 `custom_tool_call`、reasoning summary 等为准，不能只测旧 function_call fixture。
- 单个 tool payload 必须有界，避免一个输出吞掉整个 transcript window。
- 用户已明确改变优先级：Codex Desktop 同步高于其余产品收尾。

---

## 🐛 踩坑与解决方案

- stale `.daemon.lock` 导致启动即退出 -> 启动时校验 owner PID，死进程锁自动清理；真实运行 daemon 的锁不删。
- PowerShell `node -e` 嵌套 SQL 引号不断损坏 -> 避免复杂 inline quoting，优先项目脚本、fixture 或直接读文件/API。
- 移动端 Work Item 弹窗按钮看得见但点不到 -> 长 Project option 的 intrinsic min-width 撑宽 Grid item；给 dialog/flex/grid children 加 `min-width: 0`，并把字段区改成可滚动区域。
- 移动端 Work Item 页面横向漂移 -> 720px table min-content 通过 Grid child 传播；给 `.grid > *` / `.stack` 加 `min-width: 0`，滚动限制在 `.table-scroll`。
- E2E desktop/mobile 并发时选错 Work Item -> 共享隔离 daemon 中默认 selected item 会受另一个 viewport 更新影响；测试必须按 title 找 row 并显式打开详情。
- 当前 Codex transcript 大量事件未解析 -> 真实文件使用 `custom_tool_call` / output 和 reasoning summary；Codex parser 升级到 v5。
- transcript events API 返回最早 200 条 -> 改为最新 200 条，前端展示最新 12 条并暴露窗口截断。
- 超大 tool output 独占 transcript -> 单事件最终文本严格限制 20,000 字符，首尾保留并标记真实省略量。

---

## 📁 涉及文件清单

核心计划与文档：

- `CONTEXTOS_PRODUCTIZATION_PLAN.md`
- `CONTEXTOS_USAGE.md`
- `README.md`
- `AGENT.md`

前端：

- `frontend/src/App.tsx`
- `frontend/styles.css`
- `playwright.config.ts`

Session / adapter / runtime：

- `packages/application/src/ports/agent-adapter.ts`
- `packages/application/src/core/runtime-services.ts`
- `packages/contracts/src/sessions.ts`
- `packages/infrastructure/src/adapters/codex-adapter.ts`
- `packages/infrastructure/src/adapters/claude-code-adapter.ts`
- `packages/infrastructure/src/sqlite/runtime-repository.ts`
- `apps/daemon/src/bootstrap.ts`
- `apps/daemon/src/runtime-lock.ts`

其他产品资源：

- `packages/application/src/core/core-services.ts`
- `packages/infrastructure/src/sqlite/core-repositories.ts`
- `packages/infrastructure/src/sqlite/context-repositories.ts`
- `apps/daemon/src/http/routes/core-resources.ts`

测试与脚本：

- `tests/integration/codex-adapter.test.ts`
- `tests/integration/claude-code-adapter.test.ts`
- `tests/integration/transcript-import-api.test.ts`
- `tests/integration/runtime-api.test.ts`
- `tests/integration/runtime-recovery.test.ts`
- `tests/e2e/workspace-smoke.spec.ts`
- `scripts/start-e2e-server.ts`

---

## 💬 精华对话片段

> 用户：“直接继续开发流程，产品化这个项目吧，快速开发，争取能快速实现原本设计功能，现在太简略了”

> 用户：“等等，这里后端没有，只改前端，有什么用？”

> 用户：“继续，现在关键是session功能残缺太多了，Sessions 做完整”

> 用户：“session最重要的实用功能，和codex对话真正同步呢”

> 用户：“对了，Rules有修改全局AGENT.md、claude.md，和项目里的AGENT.md、claude.md，这种功能吗”

> 用户：“老样子，列出现在还有什么残留，以前的设计文档是否都已覆盖”

> 助手：“原始本地产品愿景大约已经完成到 85%–90%。核心数据模型和主要工作闭环已经可用。”

> 用户：“归档这次对话，然后我会让新对话继续，Codex Desktop 仍不是实时双向同步 这个是现在最重要的（我现在只用Codex Desktop）”

---

*此文档由 conversation-archivist skill 自动生成*
