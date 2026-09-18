# Codex Desktop 同步能力边界记录

日期：2026-09-18

## 1. 当前结论

P0 目标应拆成三个层级，不应把它们混称为“实时双向同步”：

| 层级 | 能力 | 当前结论 |
|---|---|---|
| Level A | Codex Desktop -> ContextOS 实时只读同步 | 可行。Codex Desktop 当前任务会持续 append rollout JSONL，且本机 SQLite 记录了 thread、turn、byte offset 等状态。另有受支持的 app-server 协议可读（见第 7 节）。 |
| Level B | ContextOS -> 同一 Codex UUID 的 CLI resume | 可行，但这是另起 CLI 进程向同一 UUID 追加，不等于控制 Desktop 当前 UI。 |
| Level C | ContextOS -> Codex Desktop 当前任务 UI 控制 | 部分证实。发现受支持的 app-server JSON-RPC 协议：`turn/start` 可直接驱动任意线程，但受单写者锁约束（Desktop 打开线程时会被拒绝）；`codex queue` 是跨进程投递通道，但只在持有方 turn 结束时被消费（见第 7 节）。Desktop 打开时的真实行为仍需实测。 |

当前第一实现增量只做 Level A 的增量 tailer，不改变产品承诺。

## 7. 2026-09-18 补充：app-server 协议实测（Claude Code 探针）

Desktop 已退出的窗口期内完成四轮实测（探针脚本在 `scripts/probe-codex-appserver*.mjs`，日志在 `scripts/probe-output/`）。

### 7.1 受支持的本地 API 确实存在：app-server JSON-RPC 协议

- `codex app-server`（stdio/ws/unix transport）就是 VS Code 扩展（`openai.chatgpt`）实际使用的本地协议；本机常驻进程证实：`codex.exe -c features.code_mode_host=true app-server`。
- `codex app-server generate-json-schema --out <dir>` 可导出完整协议 schema（v1/v2 两套）。
- v2 协议方法面（ClientRequest 共 100+ 方法），与同步相关的核心：
  - `thread/start` / `thread/resume`（按 UUID 加载线程，响应含 `thread.path` = rollout 文件绝对路径）
  - `thread/list`（支持 `cwd` 过滤、`sourceKinds` 过滤、分页；含 status/source/updatedAt）
  - `thread/read` / `thread/turns/list` / `thread/items/list`（分页读历史；全量 hydration 已 deprecated）
  - `turn/start`（threadId + input 直接开一轮，可覆盖 approvalPolicy/sandbox/model）
  - `turn/steer`（向进行中的 turn 注入输入，带 expectedTurnId 前置条件）
  - `turn/interrupt`（中断进行中的 turn）
  - `thread/inject_items`（直接向 model-visible 历史追加 raw items）
- 通知流：`thread/started`、`turn/started`、`item/started`、`item/completed`、`item/agentMessage/delta`、`turn/completed`、`thread/status/changed`、`thread/tokenUsage/updated` 等，实时推送。

### 7.2 实测确认的能力

新建探针线程 `01a0b3e2-f844-7940-97de-e8ece300bea3`（cwd=临时目录）实测：

1. **turn/start 全链路可用**：initialize → thread/start → turn/start → 收到完整通知流 → turn/completed，rollout 文件实时 append。两轮均成功（PROBE_APPSERVER_OK / PROBE_TURN2_OK）。
2. **rollout append 时序（Level A 数据）**：item/completed 通知 → 文件 append 延迟约 14~80ms；100ms 轮询粒度下每次观察到的事件都是完整行（tailComplete=true），未见 partial line。`thread_history_1.sqlite.thread_turns` 按 turn 记录 `rollout_byte_offset`。
3. **中断/崩溃安全**：probe 杀掉持有方进程时进行中的 turn 被干净记为 `interrupted`（rollout 尾部有 `turn_aborted` 事件 + DB 状态一致），无损坏。
4. **单写者锁（关键约束）**：第二个 app-server 对同一线程 `thread/resume` 被拒绝：`code -32600 "thread ... already has an active writer"`。`thread/read`/`thread/list` 不受锁限制（只读任意线程随时可行）。锁在持有方进程退出后自动清理（实测：杀 A 后 B resume 成功），但 `thread/unsubscribe` 不释放锁。
5. **codex queue 真实语义**：
   - `codex queue --thread <UUID> --message <TEXT>` 写 `queue_1.sqlite.queued_items`（pending），rollout 不动；
   - **消费触发点 = 持有方 app-server 的 turn 完成时**：probe 1 中 turn2 完成后队列消息自动作为 turn3 启动；
   - 持有方空闲时不轮询外部队列变化（等 30s 无 `thread/queueChanged`、无自动 turn）；
   - `thread/resume` 加载线程也不消费队列（等 30s 无动静）。
6. **cwd 过滤可用**：`thread/list {cwd:"D:\\project"}` 返回该目录线程（含 source=vscode/desktop 标记）。但 Desktop 关闭时全部 `notLoaded`，"当前活跃 Desktop task" 仍无法可靠自动识别，显式 UUID 绑定仍是首选。

### 7.3 对 Level C 的修正判断

- **Desktop 未持有线程时**：ContextOS 可用自己的 app-server 连接直接 `thread/resume` + `turn/start` 驱动任意线程 —— 已证明。
- **Desktop 持有线程时**（推测，待 Desktop 打开实测）：ContextOS 的 resume/turn 会被写锁拒绝；此时可用路径是 `codex queue`（消息落 SQLite，Desktop 在下一个 turn 边界消费）。
- **仍未知、需 Desktop 打开后实测**：
  1. Desktop 对打开的线程是否持续持有写锁（空闲时是否释放）；
  2. Desktop UI 是否展示/提示 pending queue 消息（两条 fixture 已就位：`01a0b371` 上的 `QUEUE_PROBE_CONTEXTOS_DO_NOT_RUN`、`01a0b3e2` 上的 `QUEUE_DRAIN_OK_SAY_IT_BACK`）；
  3. Desktop 在 turn 完成后是否自动消费 queue（若会，则 queue 即完整的"ContextOS → Desktop 当前任务"写入通道）；
  4. Desktop 重新打开线程时是否实时显示 CLI/app-server 追加的 turn（probe 线程上已有 5 个 turn 可供肉眼核对）。

### 7.4 实现方向更新

- ContextOS 应新增 `CodexAppServerClient`（stdio JSON-RPC）：initialize、thread/list、thread/read、thread/resume、turn/start、turn/steer、turn/interrupt + 通知订阅。
- Level A 读取面优先用协议（thread/read + turns/items 分页 + 通知流），rollout tailer 作为文件级交叉验证与兜底。
- Level C 写入面策略：先试 `thread/resume`+`turn/start`（拿到锁则直接驱动）；被拒（active writer）则降级 `codex queue` 并在 UI 明示"消息已投递，将在该任务下一个 turn 边界执行"。

## 2. Level A: Desktop 到 ContextOS

只读探针确认：

- 当前 Desktop 线程 `01a0b216-4ed1-7492-b989-975ee394beb8` 在 `state_5.sqlite.threads` 中存在。
- 对应 rollout 文件位于 `.codex/sessions/2026/09/18/rollout-2026-09-18T09-16-41-01a0b216-4ed1-7492-b989-975ee394beb8.jsonl`。
- rollout 会随当前任务继续 append。
- 文件尾部保持完整换行。
- `thread_history_1.sqlite.thread_turns` 记录当前 turn 的 `rollout_byte_offset`，正在进行的 turn 状态为 `inProgress`。

这说明 Level A 不应该继续靠“每隔一段时间重读整个 transcript 并 hash”，而应使用 byte offset 增量读取完整 JSONL 行。

已新增 first pass：

- `packages/infrastructure/src/adapters/codex-transcript-tailer.ts`
- `tests/integration/codex-transcript-tailer.test.ts`

覆盖：

- 只读取新增完整 JSONL 行；
- partial line 留到下次；
- offset 超过文件大小时按 truncate/rotate 重置；
- malformed 完整行可见但不阻塞后续行。

## 3. Level B: CLI resume 同一 UUID

安全 probe 实测：

1. 用临时目录创建 `codex exec` 会话。
2. 新线程 UUID：`01a0b371-a745-75f0-b68a-013e5541e505`。
3. 首轮输出 `PROBE_OK`。
4. 执行 `codex exec resume 01a0b371-a745-75f0-b68a-013e5541e505 ...`。
5. 第二轮输出 `RESUME_OK`。

核对结果：

- resume 输出的 `thread_id` 仍是同一个 UUID。
- 同一个 rollout 文件从 101,885 bytes 增长到 107,345 bytes。
- `thread_turns` 出现两个 completed turn。
- 第二轮 user/assistant message 追加在同一个 rollout ordinal 序列中。

结论：CLI resume 可以作为“向同一 Codex UUID 追加一个受管 CLI turn”的能力。

限制：它不是 Desktop 当前 UI 控制。不能假设 Desktop 正在打开的任务会实时显示或消费这个 CLI turn，除非另行实测 UI 行为。

## 4. Level C: Desktop 当前任务 UI 控制

已发现的本机能力：

- `codex queue --thread <UUID> --message <TEXT>` 存在。
- `codex debug app-server send-message-v2` 存在，但 help 未暴露 thread 参数。
- Windows 上 `codex app-server daemon version` 返回：daemon lifecycle 只支持 Unix。
- 本机存在 `\\.\pipe\codex-ipc`。
- Codex Desktop 进程为 `ChatGPT.exe`，并有运行中的 `codex.exe` / `codex-code-mode-host.exe`。

安全 probe 对 `codex queue` 的结果：

- 对临时 thread `01a0b371-a745-75f0-b68a-013e5541e505` 执行 queue。
- CLI 返回 queued message ID `01a0b372-b9e8-7e62-99ea-de3518ebb8e6`。
- `queue_1.sqlite.queued_items` 中出现 pending `UserInput`。
- rollout 未 append，thread history 未新增 item。

结论：

- `codex queue` 是一个真实的受支持入口，但目前只证明能排队。
- 还没有证明 Desktop UI 会对任意 pending queue 实时消费。
- 更没有证明 ContextOS 可以直接控制“当前正在打开的 Desktop task”。

因此，当前产品文案只能说：

```text
Desktop read sync: supported first pass.
CLI resume same UUID: supported as managed CLI turn.
Desktop UI control: under investigation.
```

不能说：

```text
Codex Desktop real-time two-way sync is complete.
```

## 5. Project root 识别边界

当前 Desktop 线程的 `cwd` 是 `D:\project`，而 ContextOS 项目 root 是 `D:\project\ContextOS`。

这意味着：

- 只凭 ContextOS Project root 自动识别“当前活跃 Desktop task”不稳定；
- `D:\project` 下可能有多个 ContextOS 相关线程；
- 未显式 UUID 时只能做谨慎候选推荐，不能自动绑定；
- 可靠绑定应优先使用用户显式选择/粘贴 UUID，或后续通过 Desktop/app-server 当前选中线程接口验证。

## 6. 下一步

> 2026-09-18 晚更新：第 3、4 条已被第 7 节的 app-server 实测推进——受支持接口已找到，Level C 不再是"无接口"，而是"受单写者锁约束的条件可用"。实现方向见 7.4。

建议顺序：

1. 将 `CodexTranscriptTailer` 接入 Session sync state，记录 rollout path、byte offset、last observed event time、lag、watcher status。
2. Session UI 明确显示 capability：
   - read-only Desktop sync；
   - managed CLI resume；
   - Desktop UI control unavailable / investigating。
3. 再调查 `codex queue` 对已打开 Desktop 任务的消费行为。
4. 如果 Level C 无受支持接口，产品层保持 Level A + Level B，不宣传双向同步。
