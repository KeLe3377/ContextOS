# Codex Desktop 同步能力边界记录

日期：2026-09-18

## 1. 当前结论

P0 目标应拆成三个层级，不应把它们混称为“实时双向同步”：

| 层级 | 能力 | 当前结论 |
|---|---|---|
| Level A | Codex Desktop -> ContextOS 实时只读同步 | 可行。Codex Desktop 当前任务会持续 append rollout JSONL，且本机 SQLite 记录了 thread、turn、byte offset 等状态。 |
| Level B | ContextOS -> 同一 Codex UUID 的 CLI resume | 可行，但这是另起 CLI 进程向同一 UUID 追加，不等于控制 Desktop 当前 UI。 |
| Level C | ContextOS -> Codex Desktop 当前任务 UI 控制 | 尚未证明。`codex queue` 是更接近 UI/app-server 的入口，但目前只验证到 pending queue，不可宣称已实现 UI 双向同步。 |

当前第一实现增量只做 Level A 的增量 tailer，不改变产品承诺。

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

建议顺序：

1. 将 `CodexTranscriptTailer` 接入 Session sync state，记录 rollout path、byte offset、last observed event time、lag、watcher status。
2. Session UI 明确显示 capability：
   - read-only Desktop sync；
   - managed CLI resume；
   - Desktop UI control unavailable / investigating。
3. 再调查 `codex queue` 对已打开 Desktop 任务的消费行为。
4. 如果 Level C 无受支持接口，产品层保持 Level A + Level B，不宣传双向同步。
