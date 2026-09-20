# Codex app-server 只读同步改造计划

日期：2026-09-20
状态：待评审（**尚未动工**，本文只做设计与现状记录）
上游文档：`docs/2026-09-18-codex-desktop-sync-boundaries.md`

---

## 1. 摘要

一句话结论：**不要把 Level A 的读取升级成“app-server 通知流”，而要升级成“app-server 只读 RPC”；文件 tailer 降级为兜底。**

理由：

1. 通知流只对“本进程自己 load 的线程”推送，而 load 的入口是 `thread/resume` / `thread/start`，那就要抢单写者锁 —— 等于把 Level C 的老问题原样搬过来。对 Desktop 拥有的线程**拿不到**通知流。
2. 但 app-server 的**只读**方法是完全免费的：`thread/list` 能自动发现线程（含 rollout 绝对路径），`thread/read` 能跨进程读别人的线程并返回结构化 turns，二者都不受写锁限制。
3. 因此最大的收益不是“实时”，而是**“不用再让用户手填 UUID / 扫盘找文件 / 自己解析 JSONL”**。

分三档推进，**本轮只建议做 L0**：

| 档位 | 内容 | 风险 | 预估 |
|---|---|---|---|
| L0 | 只加“线程发现”，读取仍走文件 tail | 极低（不动同步链路） | 0.5–1 天 |
| L1 | 读取改走 app-server + cursor 记账，tail 保留兜底 | 中（新增常驻子进程） | 1.5–2 天 |
| L2 | 自起线程接通知流 | 高 | ≥3 天，暂不做 |

**前置门禁 G0**：Codex Desktop 当前未运行，实测到的线程 `source` 全是 `vscode`，“Desktop 建的线程是否出现在 `thread/list`”**未经验证**。L0 的核心假设依赖它，必须先验。

---

## 2. 现状

### 2.1 能力分层现状

沿用 `docs/2026-09-18-codex-desktop-sync-boundaries.md` 的三层划分：

| 层级 | 能力 | 现状 |
|---|---|---|
| Level A | Desktop → ContextOS 只读同步 | **已实现并交付**（文件 tail 增量读取） |
| Level B | ContextOS → 同一 Codex UUID 的 CLI resume | **已实现**。`packages/application/src/core/runtime-services.ts:89/113`：`session.externalSessionId` 存在时走 `buildResumeInfo()` / `resume()`，否则 `launch()`。测试覆盖见 `tests/integration/runtime-api.test.ts:347` “resumes the bound Codex session with an incremental context prompt” |
| Level C | ContextOS → Desktop 当前任务 UI 控制 | **未实现**，`capabilities.desktopUiControl` 恒为 `false`。受单写者锁约束，且 §7.3 的四个 open question 因 Desktop 未运行而无法实测 |

产品文案边界（不得越线）：

```text
Desktop read sync: supported first pass.
CLI resume same UUID: supported as managed CLI turn.
Desktop UI control: under investigation.
```

### 2.2 Level A 现有实现全貌

**文件清单**

| 文件 | 职责 |
|---|---|
| `packages/infrastructure/src/adapters/codex-transcript-tailer.ts` | 按 byte offset 增量读 rollout JSONL，处理半行、offset 越界重置 |
| `packages/infrastructure/src/adapters/codex-adapter.ts` | `resolveTranscriptPath()`（扫盘按 UUID 匹配）、`parseTranscriptRows()`（JSONL → `AgentTranscriptEvent`） |
| `packages/application/src/core/desktop-sync-service.ts` | `status()` / `bind()` / `sync()` / `unbind()` |
| `packages/infrastructure/src/sqlite/session-sync-repository.ts` | `session_sync_state` 表读写 |
| `migrations/0011_session_sync_state.sql` | 建表（schemaVersion 10 → 11） |
| `packages/contracts/src/sessions.ts` | `sessionSyncBindSchema`、`SessionSyncStateDto`、`SessionSyncResultDto`、`SessionSyncCapabilities` |
| `apps/daemon/src/http/routes/core-resources.ts:60-77` | 4 个 HTTP 路由 |
| `frontend/src/App.tsx` | Desktop 同步面板、绑定弹窗、5 秒自动轮询 |
| `tests/integration/desktop-sync.test.ts` | 5 个集成测试 |

**数据模型**（`migrations/0011_session_sync_state.sql`）

```sql
CREATE TABLE IF NOT EXISTS session_sync_state (
  session_id TEXT PRIMARY KEY,
  adapter_id TEXT NOT NULL,
  external_session_id TEXT,
  transcript_path TEXT NOT NULL,
  byte_offset INTEGER NOT NULL DEFAULT 0,
  events_ingested INTEGER NOT NULL DEFAULT 0,
  last_event_at TEXT,
  last_synced_at TEXT,
  status TEXT NOT NULL DEFAULT 'IDLE',
  last_error TEXT,
  updated_at TEXT NOT NULL
);
```

**绑定链路**（`DesktopSyncService.bind()`）

1. 取 `externalSessionId`（入参优先，否则用 `sessions.external_session_id`）；
2. 若 Session 已绑定别的 external id → `CONFLICT`（HTTP 409）；
3. `adapter.resolveTranscriptPath({ externalSessionId })` → **遍历 `~/.codex/sessions` 下全部 JSONL 逐个读 metadata 匹配**。当前该目录有 **373 个 rollout 文件**；
4. 默认从文件末尾开始（`byte_offset = fileSize`），`fromBeginning=true` 时从 0 开始；
5. upsert 后调用 `bindExternalSession` 把 external id 回写 `sessions` 行 —— 这一步是 Level B 能 resume 同一 UUID 的前提。

**同步链路**（`DesktopSyncService.sync()`）

`tailer.read(path, offset)` → 取完整行 → `adapter.parseTranscriptRows()` → upsert `byte_offset` / `events_ingested` / `last_event_at`。文件消失时记 `status=ERROR` 并返回，不抛异常。

**HTTP 路由**

```
GET    /api/sessions/:id/desktop-sync
POST   /api/sessions/:id/desktop-sync/bind     (201)
POST   /api/sessions/:id/desktop-sync/sync
DELETE /api/sessions/:id/desktop-sync
```

错误映射（`apps/daemon/src/bootstrap.ts:214`）：`NOT_FOUND → 404`，`CONFLICT → 409`，其余 `ContextOsError → 400`。

**前端**

- 面板（约 `App.tsx:1153-1161`）展示：同步状态徽章、已摄入事件数、读取位置（`已读字节 / 文件总字节`）、滞后 ms、对话记录文件、最近同步时间。
- 绑定弹窗（`App.tsx:1842`）要求用户**手工粘贴外部会话 ID**，对话记录路径可选（留空即扫盘）。
- 自动轮询：开关存 `localStorage["contextos.desktopSyncAuto"]`，已绑定且页面在会话页时每 **5000 ms** 调一次 `sync`。

### 2.3 现状的三个具体痛点

| # | 痛点 | 证据 |
|---|---|---|
| P1 | **绑定要手填 UUID**。用户得先从别处抄一个 32 位 UUID 粘进弹窗 | `App.tsx:1842` 的 `name="externalSessionId"` 输入框 |
| P2 | **扫盘找文件**。留空路径时要遍历读取 373 个 JSONL 的 metadata | `codex-adapter.ts:103-109` |
| P3 | **自己解析 JSONL**。要自己维护 rollout 行 → 事件类型的映射，还要处理半行、offset 越界、malformed 行 | `codex-transcript-tailer.ts` + `parseTranscriptRows()` |

注意：**“不够实时”不在其中**。5 秒轮询对“读别人的历史”这个场景已经够用；真正难用的是 P1/P2/P3 这一串。

---

## 3. 技术调研：app-server 只读 RPC 实测

环境：`codex-cli 0.153.4`，`codex app-server` 标记为 `[experimental]`。

### 3.1 协议形态

```
spawn('codex', ['app-server'], { shell: true, stdio: ['pipe','pipe','pipe'] })
```

- 传输：stdio，换行分隔的 JSON-RPC 2.0。
- 握手：`initialize`（带 `clientInfo`）→ 客户端发 `initialized` 通知 → 之后可 request/response。
- schema 可导出：`codex app-server generate-json-schema --out <dir>` 生成顶层 **37 个 JSON 文件** + `v1/`（2 个）+ `v2/`（265 个）两个子目录；总 schema 在 `codex_app_server_protocol.v2.schemas.json`。

### 3.2 实测结果（本次新做，只读，不抢锁）

**① `thread/list {cwd, limit}` 直接给出 rollout 路径**

```json
{"id":"01a0b216-4ed1-7492-b989-975ee394beb8","sessionId":"01a0b216-...",
 "cwd":"D:\\project",
 "path":"C:\\Users\\cxsy5\\.codex\\sessions\\2026\\09\\18\\rollout-2026-09-18T09-16-41-01a0b216-....jsonl",
 "updatedAt":1789722839,"preview":"查看agent_chat_extractor，对比ContextOS，看看有没有什么地方可以学习",
 "status":{"type":"notLoaded"},"source":"vscode","threadSource":null}
```

`Thread` 的完整字段：`agentNickname, agentRole, cliVersion, createdAt, cwd, ephemeral, forkedFromId, gitInfo, historyMode, id, model, modelProvider, name, parentThreadId, path, preview, projectId, reasoningEffort, recencyAt, section, sectionEnteredAt, sessionId, source, status, threadSource, turns, updatedAt`。

→ **P1 和 P2 一次性解决**：`preview` 给人看，`path` + `id` 直接填进 bind，不用扫盘。

**② `thread/read {threadId}` 能跨进程读别人的线程**

对一条 VS Code 建的线程（不是本探针创建的）调用，成功返回：

```json
{"id":"01a0b216-...","cwd":"D:\\project",
 "path":"\\\\?\\C:\\Users\\cxsy5\\.codex\\sessions\\...\\rollout-....jsonl",
 "updatedAt":1789722839,"status":{"type":"notLoaded"},"turns":31}
```

turn 结构：`{id, items, itemsView, status, error, startedAt, completedAt, durationMs}`，items 已是归一化类型（`userMessage` / `reasoning` / `agentMessage` …）。

→ **P3 解决**：不用再自己解析 JSONL。
→ 同时印证上游文档 §7.2 第 4 条：`thread/read` / `thread/list` 不受写锁限制。

**③ `status.type`——不是全局活跃状态（已实测更正）**

取值：`notLoaded / idle / active / systemError`。

原以为它能免费提供“这条线程现在有没有人在用”。**实测推翻**：用户在 Desktop 新建了一条线程（Desktop 很可能仍开着它），从另一个 app-server 进程 `thread/read` 返回的仍是 `{"type":"notLoaded"}`。

即 `status` 反映的是**当前这条连接**有没有 load 该线程，**不是全局的持有状态**。所以：

- 不能用它判断“Desktop 是否正在使用这条线程”；
- 真正要判断占用，只能尝试 `thread/resume` 看是否被写锁拒绝 —— 但那属于 Level C 的写入语义，不在只读范围内。

这一点也顺带说明：Level C 的“控制”价值确实无法被只读 RPC 替代。

**④ 服务端主动指定了增量读法**

探针收到一条 `deprecationNotice`：

> "Full-history hydration is deprecated for paginated threads; omit `includeTurns` or set it to `false`, then page with `thread/turns/list` and `thread/items/list`."

即官方设计的增量路径是：`thread/read`（不带 turns）做变更检测 → `thread/turns/list {cursor, limit, sortDirection}` 翻页（turns 默认 descending，items 默认 ascending）。

### 3.3 通知流为什么拿不到（关键更正）

`ServerNotification` 有 50+ 事件，包括：`item/agentMessage/delta`、`item/commandExecution/outputDelta`、`item/fileChange/outputDelta`、`item/reasoning/summaryTextDelta`、`item/reasoning/textDelta`、`item/started`、`item/completed`、`turn/started`、`turn/completed`、`turn/diff/updated`、`thread/status/changed`、`thread/tokenUsage/updated`、`thread/queue/changed`、`thread/compacted`、`fs/changed` …

但**只有本进程 load 的线程才会推**。load 的入口只有 `thread/resume` / `thread/start` —— 而上游文档 §7.2 第 4 条实测确认：

> 第二个 app-server 对同一线程 `thread/resume` 被拒绝：`code -32600 "thread ... already has an active writer"`。

所以对 Desktop 拥有的线程，**通知流不可得，只能轮询**。
→ 我上一轮说的“升级到通知流”是错的，特此更正。真正的流式只对**ContextOS 自己用 app-server 起的线程**成立（即 L2，另议）。

### 3.4 与上游文档 §7.4 的关系

上游 §7.4 已建议“新增 `CodexAppServerClient`”“Level A 读取面优先用协议，rollout tailer 作为交叉验证与兜底”。**本文是这个方向的落地拆解**，并把“通知流”这一条从中剔除。

---

## 4. 目标 / 非目标

**目标**

- G1：用户不用手填 UUID，从候选列表点一条即完成绑定。
- G2：不再扫 373 个文件找路径。
- G3：读取路径可切换，且切换失败能自动回退到文件 tail，用户无感。
- G4：面板能看到线程活跃状态（`notLoaded` / `idle` / `active`）。

**非目标（本轮明确不做）**

- 不改 Level B（CLI resume）的任何行为。
- 不抢写锁、不调用 `thread/resume` / `thread/start` / `turn/*`。
- 不做 Level C，不改 `desktopUiControl` 的 `false`。
- 不改产品文案边界，不宣传“双向同步”。
- 不删除文件 tailer（L1 之后也只是降级为兜底）。

---

## 5. 方案设计

### 5.1 总体架构

```
                  ┌─────────────────────────────┐
                  │  DesktopSyncService         │
                  │  bind / sync / status       │
                  └──────┬───────────────┬──────┘
                         │ 发现          │ 读取
              ┌──────────▼──────┐  ┌─────▼──────────────────┐
              │ CodexAppServer  │  │ transport = appserver  │
              │ Client (L0/L1)  │  │  thread/read + turns   │
              └─────────────────┘  ├────────────────────────┤
                                   │ transport = tail(兜底) │
                                   │  CodexTranscriptTailer │
                                   └────────────────────────┘
```

`session_sync_state` 增加 `transport` 列决定走哪条；未设置即 `tail`（向后兼容现有绑定）。

### 5.2 L0：只加“发现”

**范围**：新增候选列表接口 + 前端选择器。**`sync()` 一行不改。**

**契约新增**（`packages/contracts/src/sessions.ts`）

```ts
export type DesktopSyncCandidate = {
  externalSessionId: string;        // Thread.id
  transcriptPath: string | null;    // Thread.path（已规范化，见 5.5）
  cwd: string | null;
  preview: string | null;           // 首条用户消息，给用户认人
  updatedAt: string | null;         // ISO 8601
  status: "notLoaded" | "idle" | "active" | "systemError" | "unknown";
  source: string | null;            // vscode / desktop / cli ...
  turnCount: number | null;
  alreadyBound: boolean;            // 是否已被别的 ContextOS Session 绑定
};
```

**路由新增**

```
GET /api/sessions/:id/desktop-sync/candidates?cwd=<可选>&limit=<可选>
```

- 未传 `cwd` 时，用该 Session 所属 Project 的 `rootPath` 作为默认值；该目录通常是父目录（上游 §5：Desktop 线程 cwd 是 `D:\project`，而项目 root 是 `D:\project\ContextOS`），因此**再用父目录兜一次并合并去重**。
- 只读、不写任何状态。

**Adapter 扩展**（`AgentAdapterPort`，保持可选以免破坏 `ClaudeCodeAdapter`）

```ts
listExternalSessions?(input: { cwd?: string; limit?: number }): Promise<DesktopSyncCandidate[]>;
```

**前端**：绑定弹窗改为“候选列表 + 仍可手动粘贴”。选中一条即把 `externalSessionId` + `transcriptPath` 一起提交；`alreadyBound=true` 的置灰并标注“已被其他会话绑定”。

**数据模型**：无变更，不需要迁移。

**风险**：极低。app-server 不可用时该接口返回空数组 + 提示，手动粘贴路径完全保留。

### 5.2.1 实现时从实测修正的三点（与上面原始设计不同）

1. **必须显式传 `sourceKinds`**。协议的默认值是“只返回 interactive 来源”，实测漏掉了 20 条（默认 60 vs 显式 80）。`DEFAULT_SOURCE_KINDS = ["cli","vscode","exec","appServer","unknown"]`，刻意排除 `subAgent*`。
2. **`source` 不一定是字符串**。可能是对象，例如 `{"subAgent":{"other":"guardian"}}`。客户端统一取顶层键（`subAgent`），并在 adapter 层把这类线程过滤掉——它们是内部记账线程，不是用户工作。
3. **`turnCount` 对未加载线程不可信**。`thread/list` 对 `status=notLoaded` 的线程返回空 `turns` 数组，显示成“0 轮”会误导。客户端在这种情况下返回 `null`，真实轮数要走 `thread/read`。
4. **Desktop 线程报 `source: "vscode"`**（rollout 的 `session_meta.originator` 才是 `"Codex Desktop"`）。所以过滤条件必须保留 `vscode`，且不能指望用 `source` 区分 Desktop 与 VS Code 扩展。详见 §8。

### 5.3 L1：读取改走 app-server（含兜底）

**新增 `packages/infrastructure/src/adapters/codex-app-server-client.ts`**

```ts
export interface CodexAppServerClient {
  listThreads(input: { cwd?: string; limit?: number }): Promise<CodexThreadSummary[]>;
  readThread(input: { threadId: string }): Promise<{
    updatedAt: number | null;      // Unix 秒
    turnCount: number | null;
    status: string;
    path: string;
  }>;
  listTurns(input: { threadId: string; cursor?: string | null; limit?: number;
                     direction?: "asc" | "desc" }): Promise<{ turns: CodexTurn[]; nextCursor: string | null }>;
  listItems(input: { threadId: string; turnId?: string | null; cursor?: string | null;
                     limit?: number }): Promise<{ items: CodexItem[]; nextCursor: string | null }>;
  dispose(): Promise<void>;
}
```

**进程模型（需要拍板）**

| 方案 | 优点 | 缺点 |
|---|---|---|
| A. 常驻子进程，daemon 生命周期内复用 | 无握手开销 | 要管生命周期、僵尸进程、daemon 重启重连、异常重启 |
| B. 每次调用 spawn 短命进程 | 实现简单、无状态残留 | 每次 ~1–2 s 握手，5 秒轮询下开销显著 |

**建议选 B 起步**：L1 的轮询是 5 秒级，B 的复杂度代价远小于 A；等真的需要 sub-second 再换 A。

**增量算法**（`sync()` 内 transport=appserver 分支）

```
1. readThread(threadId)                       → { updatedAt, turnCount, status }
2. if updatedAt == state.last_event_epoch
      && turnCount == state.turn_count        → 无变化，直接返回（省一次全量拉取）
3. listTurns({ threadId, limit: 20, direction: 'desc' })
      逐页回退，直到命中 state.last_turn_id 或没有 nextCursor
4. 新 turn 按 ascending 排序，逐个 listItems({ threadId, turnId })
5. adapter.parseAppServerItems({ items, startOrdinal }) → AgentTranscriptEvent[]
6. upsert { last_turn_id, last_cursor, turn_count, events_ingested, last_event_at, last_synced_at }
```

**迁移 `migrations/0012_session_sync_transport.sql`**（schemaVersion 11 → 12）

```sql
ALTER TABLE session_sync_state ADD COLUMN transport TEXT NOT NULL DEFAULT 'tail';
ALTER TABLE session_sync_state ADD COLUMN last_turn_id TEXT;
ALTER TABLE session_sync_state ADD COLUMN last_cursor TEXT;
ALTER TABLE session_sync_state ADD COLUMN turn_count INTEGER;
ALTER TABLE session_sync_state ADD COLUMN external_status TEXT;
```

（SQLite 支持 `ADD COLUMN ... DEFAULT`，现有行自动填 `tail`，向后兼容。）

**Adapter 新增可选方法**

```ts
parseAppServerItems?(input: { items: unknown[]; startOrdinal: number }): AgentTranscriptEvent[];
```

**回退开关**

- 环境变量 `CONTEXTOS_SYNC_TRANSPORT=tail | appserver | auto`（默认 `tail`）。
- `auto` 模式：bind 时探测 app-server 可用性，可用则写 `appserver`，不可用写 `tail`。
- `sync()` 内 appserver 抛错 → 捕获后**降级为 tail** 并在本次结果里带 `transportFallback: true`，同时写 `last_error`。文件 tailer 的 `byte_offset` 继续维护，两条链路不互相污染（切换 transport 时按当前 `transcript_path` 重新定位：appserver→tail 取 `fileSize` 作为新 offset；tail→appserver 以 `last_turn_id` 为空触发一次受限回溯，默认只拉最近 20 个 turn）。

**可删除的部分**：L1 稳定后，`codex-transcript-tailer.ts` 的半行缓存与 `offset_beyond_eof` 重置逻辑在 appserver 路径下不再需要 —— 但作为兜底**保留代码**，不删。

### 5.4 L2：通知流（暂不做）

仅在“ContextOS 自己用 app-server 起线程”的场景成立：那时线程是本进程 load 的，能收到 `item/agentMessage/delta` 等事件。

阻塞项：协议 experimental、无版本钉住、Windows 下需确认命名管道/stdio 行为、以及它和现有 `ProcessSupervisor`（CLI 子进程管理）会形成两套并行的进程管理模型。**不排期。**

### 5.5 路径规范化（L0 和 L1 都要做）

实测：`thread/list` 返回 `C:\Users\...`，`thread/read` 返回 `\\?\C:\Users\...`（Win32 扩展长度前缀）。这两个字符串不同，直接存会变成两条“不同”的记录。

统一做法：入库前 `normalizeTranscriptPath()`，剥掉 `\\?\` 前缀并统一分隔符；比较时走同一个函数。同步时给 app-server 用 `threadId`（不是路径），因此路径只用于展示和 tail 兜底，风险可控但仍需规范化。

---

## 6. 兼容性与回退总表

| 场景 | 行为 |
|---|---|
| 已绑定的老数据（无 `transport` 列值） | 迁移默认 `tail`，行为完全不变 |
| app-server 不可用 / `codex` 不在 PATH | L0 候选接口返回空 + 提示；L1 走 tail |
| `thread/list` 返回 `source=desktop` 的线程（G0 通过后） | 正常展示，不做特殊处理 |
| 同一线程已被别的 Session 绑定 | `alreadyBound=true`，前端置灰；`bind()` 仍会按现有逻辑返回 `CONFLICT` |
| appserver 读取中途失败 | 降级 tail，记 `last_error`，面板显示 ERROR 但不停摆 |

---

## 7. 风险与缓解

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R1 | 协议 experimental，且**已在主动发 deprecationNotice**，v1/v2 并存 | 高 | 只读面很小（只用 list/read/turns/items）；全部调用包在 try/catch 里；失败即回退 tail；不把协议类型直接暴露进 contracts |
| R2 | **G0 未验证**：Desktop 建的线程是否出现在 `thread/list` | 高 | 设为门禁，未通过不动工 |
| R3 | 新增子进程（即便短命）带来进程管理与超时风险 | 中 | 每次调用带 requestTimeout（建议 8 s）+ 硬超时；spawn 失败直接回退 |
| R4 | `path` 格式不一致（`C:\` vs `\\?\C:\`） | 中 | 5.5 规范化函数 + 单测 |
| R5 | `updatedAt` 精度只到秒，同秒多次更新漏检 | 中 | 以 `turnCount` + `last_turn_id` 为主键，`updatedAt` 只做快速短路 |
| R6 | `cwd` 过滤是目录级（`D:\project`），一个目录下线程多 | 低 | 用 `preview` 给人认；限制 `limit`；不做自动绑定（沿用上游 §5 结论） |
| R7 | 候选列表可能暴露其他项目的会话 | 低 | 默认按项目 rootPath（及父目录）过滤，不全局列举 |

---

## 8. 验证计划

**G0（门禁）—— 已于 2026-09-20 在 Desktop 运行窗口内实测，结论：部分通过**

Desktop 当时确实在运行（`ChatGPT.exe` × 11、`codex` × 2、`codex-code-mode-host`）。实测结果：

#### 第一轮（Desktop 运行中，但还没建线程）

| 观察 | 结果 |
|---|---|
| `thread/list` 全量（显式传全部 `sourceKinds`） | 80 条：`vscode` 31 / `subAgent` 47 / `exec` 1 / `cli` 1 |
| 是否存在 `source=desktop` 的线程 | **没有**。`ThreadSourceKind` 枚举里也**没有** desktop 这个值 |
| `sourceKinds=["appServer"]` | **0 条** |
| 那 47 条是什么 | `source` 是对象 `{"subAgent":{"other":"guardian"}}`，即 guardian 子代理，`turns=0` |
| 默认查询（不传 `sourceKinds`） | 只返回 60 条，且**把非 interactive 的线程全过滤掉** |

当时无法归因任何线程到 Desktop，因此留了补测项。

#### 第二轮（用户在 Desktop 新建一条 “hello” 线程后）——**门禁通过**

新线程 `01a0bc9a-567b-72a1-9d18-7bcb2b73928a`，`cwd=D:\project`，10:17 创建。

- ✅ **出现在 `thread/list`**，而且是全表最新的一条（按 `updatedAt` 倒序第一）。
- ⚠️ **`source` 是 `"vscode"`，不是 `desktop`**。
- ✅ `thread/read` 可读：1 个 turn，items = `userMessage, agentMessage` —— L1 的结构化读取前提成立。
- ❌ `status` 仍为 `notLoaded`，尽管 Desktop 刚创建并很可能仍开着它。

rollout 首行 `session_meta` 给出了决定性的身份信息：

```json
{ "originator": "Codex Desktop",
  "cli_version": "0.155.0-alpha.9.2",
  "source": "vscode",
  "thread_source": "user" }
```

**结论：Codex Desktop 把自己的线程标成 `source: "vscode"`**（Desktop 复用了 VS Code 扩展的 source kind）。所以：

1. `DEFAULT_SOURCE_KINDS` **必须包含 `vscode`** —— 如果当初只找 `desktop`，会发现 0 条，直接误判为“不可用”。这一点现在已被实现覆盖。
2. **单靠 `source` 无法区分 Desktop 线程和 VS Code 扩展线程**。要区分只能读 rollout 的 `session_meta.originator`（`"Codex Desktop"`），而 ContextOS 导入 transcript 时本来就会解析这一行。
3. 顺带发现**版本错配**：Desktop 内置 `0.155.0-alpha.9.2`，而本机 CLI 是 `0.153.4`。协议按 experimental 对待是对的。

判定：**G0 通过** —— Desktop 线程可被发现，L0 对 Desktop 场景有效。

**L0 验收**

- 新增 `tests/integration/desktop-sync-candidates.test.ts`，用 fake app-server（起一个假 stdio 进程回放固定 JSON）覆盖：正常列表、空列表、`alreadyBound` 标记、app-server 不可用返回空。
- e2e：绑定弹窗能列出候选，点选后 `desktopSync.transcriptPath` 非空。
- 回归：现有 5 个 `desktop-sync.test.ts` 全绿（应完全不受影响）。

**L1 验收**

- 单元测试：`normalizeTranscriptPath`、`parseAppServerItems`、cursor 回退终止条件。
- 集成测试（fake app-server）：变更检测短路、新增 turn 增量摄入、重复 sync 不重复计数、app-server 抛错时降级 tail 且 `byte_offset` 仍推进。
- 手工：对一条真实线程开自动轮询，观察 `eventsIngested` 单调增长且不重复。

---

## 9. 工作量与排期建议

| 步骤 | 内容 | 预估 |
|---|---|---|
| G0 | Desktop 可见性验证 | 0.5 天（含等待窗口） |
| L0 | 候选接口 + 契约 + adapter + 前端选择器 + 测试 | 0.5–1 天 |
| L1 | `CodexAppServerClient` + 迁移 0012 + sync 分支 + 回退 + 测试 | 1.5–2 天 |
| L2 | 通知流 | ≥3 天，不排期 |

建议：**G0 → L0 → 观察一段时间 → 再决定 L1**。L1 的收益（去掉自己解析 JSONL）不如 L0 直观，主要价值是长期可维护性。

---

## 10. 决策记录

**Q：为什么不做 Level C？**
A：Level C 的全部价值是“控制 Desktop 当前任务”，但受单写者锁约束，Desktop 打开线程时 `thread/resume` 必被拒；退路 `codex queue` 只在持有方 turn 边界消费，且 §7.3 的四个 open question 因 Desktop 未运行而无法验证。投入产出比差。

**Q：这个方案和 Level C 冲突吗？**
A：不冲突，且是减压关系。Level C 想要的“知道 Desktop 在干什么”，其中“知道”这一大半（`thread/list` 发现 + `thread/read` 结构化历史 + `status` 活跃状态）用只读 RPC 就能拿到；剩下“控制”才需要抢锁。先把“知道”做扎实，Level C 的必要性会明显下降。

**Q：为什么不干脆等通知流成熟？**
A：协议带 `[experimental]` 标记且已在发 deprecationNotice，短期成熟不了；而 P1/P2/P3 是今天就在难受的问题。

---

## 11. 实现进度

**L0 已落地（2026-09-20）**

| 层 | 改动 |
|---|---|
| 新增 | `packages/infrastructure/src/adapters/codex-app-server-client.ts`（stdio JSON-RPC，`initialize` + `thread/list`，含路径/状态/来源/时间戳规范化） |
| 契约 | `packages/contracts/src/sessions.ts`：`desktopSyncCandidateSchema`、`DesktopSyncCandidate`、`desktopSyncCandidatesQuerySchema`；`SessionSyncCapabilities` 增加 `desktopThreadDiscovery` |
| 端口 | `agent-adapter.ts`：可选 `listExternalSessions?()`，返回 `ExternalSessionCandidate`（= 候选去掉 `alreadyBound`） |
| adapter | `codex-adapter.ts` 实现 `listExternalSessions`；失败静默返回 `[]`，保留手动输入路径 |
| 服务 | `desktop-sync-service.ts`：`listCandidates()` —— 项目 root + 父目录两次查询、按 id 合并去重、标记 `alreadyBound`（排除本会话自身的绑定） |
| 路由 | `GET /api/sessions/:id/desktop-sync/candidates?cwd=&limit=` |
| 装配 | `bootstrap.ts` 注入 `resolveProjectRoot` |
| 前端 | 绑定弹窗增加候选列表（点选填入，已绑定置灰），保留手动粘贴；新增 `.candidate-btn` 样式 |
| 测试 | `tests/integration/codex-app-server-client.test.ts`（9）、`tests/integration/desktop-sync-candidates.test.ts`（6） |

真实环境验证（Desktop 运行中，会话所属项目 rootPath `D:\work\gdPortMcp`）：接口返回 25 条候选，limit 生效，`turnCount` 为 `null`，`alreadyBound` 正常。

**未做**

- L1（读取换 app-server + cursor 记账 + 迁移 0012）。G0 已确认 `thread/read` 对 Desktop 线程可读（1 turn / `userMessage, agentMessage`），前提成立。
- L2（通知流）。

**G0 已通过**（见 §8）：Desktop 线程可被 `thread/list` 发现，`thread/read` 可读，但 `source` 报 `vscode`。

## 12. 附录：本次实测原始输出

```
$ codex --version
codex-cli 0.153.4

$ codex app-server generate-json-schema --out .workbuddy-ai/tmp/schema
exit=0。顶层 37 个 .json（含 codex_app_server_protocol.schemas.json 与
 .v2.schemas.json 两个总 schema），另加 v1/（2 个）与 v2/（265 个）两个子目录


$ initialize
{"userAgent":"contextos-probe/0.153.4 (Windows 10.0.26200; x86_64) dumb
 (contextos-probe; 0.1.0)","codexHome":"C:\\Users\\cxsy5\\.codex",
 "platformFamily":"windows","platformOs":"windows"}

$ thread/list { cwd: "D:\\project", limit: 5 }
count: 5，全部 source=vscode，status.type=notLoaded
（详见 3.2 ①）

$ thread/read { threadId: "01a0b216-4ed1-7492-b989-975ee394beb8", includeTurns: true }
turns: 31，path = \\\\?\\C:\\Users\\... （详见 3.2 ②）

$ 收到的通知
remoteControl/status/changed :: {"status":"disabled","serverName":"mozi",...}
deprecationNotice :: {"summary":"Full-history hydration is deprecated for
 paginated threads; omit `includeTurns` or set it to `false`, then page with
 `thread/turns/list` and `thread/items/list`.","details":null}
```

相关实测脚本（临时，未纳入仓库）：`.workbuddy-ai/tmp/probe-list.mjs`、`.workbuddy-ai/tmp/probe-read.mjs`。
此前的协议探针：`scripts/probe-codex-appserver*.mjs`。
