# ContextOS 真实 Codex 会话连续性 Smoke 验收

- 日期：2026-09-21
- 脚本：`scripts/smoke-codex-continuity.ts`
- 结论：**PASS**
- 隔离：临时 Project 目录 + 临时 dataDir + 一次性 Codex 会话；未接触用户正常数据库；报告仅含 ID、时间、计数、hash 与布尔结论。

## 验收链（全走正式生产路径）

1. 一次性真实 Codex 会话（`codex exec -`）产生真实 rollout。
2. 临时 dataDir 上启动守护进程，走正式 HTTP 入口建 Project、开自动化、跑 discovery。
3. 正式 discovery 把真实线程绑定成 ContextOS Session，绑定位置为 rollout EOF。
4. 绑定前不产生 Evidence、Resume Capsule 上下文为空（不摄入绑定前历史）。
5. 绑定后继续同一真实会话（`codex exec resume <id> -`）产生新事件，写入同一 rollout。
6. 正式调度在下一个合法轮询周期把新增事件捕获成 Evidence。
7. Resume Capsule 引用该 Evidence 并含刚捕获的连续性标记。
8. 正式 Continue：`resume` 回同一个真实 Codex 会话（`operation=resume`）。
9. 真实 Codex 侧证据：resume prompt（含连续性摘录）经**生产 Continue 路径**进入同一 rollout。
10. Continue 运行正常收尾（`status=COMPLETED`）。

## 关键事实（仅 ID / 计数 / hash / 时间）

| 项 | 值 |
| --- | --- |
| outcome | `PASS` |
| startedAt | `2026-09-21T09:34:47.905Z` |
| finishedAt | `2026-09-21T09:35:28.793Z` |
| projectId | `proj_455d319f-6c8a-47b6-8f03-2becb6eba1d5` |
| sessionId | `sess_89344a4b-313f-482b-aba8-c7b3add345a5` |
| externalSessionId (hash) | `sha256:2458d7e41` |
| bindByteOffset | `105611` |
| eventsIngestedAtBind | `0` |
| evidenceCount | `1` |
| capsuleChars | `69` |
| capsuleContext (hash) | `sha256:13064468c9136b210e8f77208daa57f69906f694bc79205cd07bd95396777164` |
| continueStatus | `200` |
| resumeDeliveryAttributedTo | `product-continue` |
| rolloutBytes(final) | `104951` |
| continueFinalStatus | `COMPLETED` |

## 检查点

| 检查点 | ok | 说明 |
| --- | --- | --- |
| codex-session-created | true | exit=0 |
| automation-enabled | true | pollIntervalMs=5000 |
| discovery-enqueued | true | status=202 |
| session-bound | true | 正式发现绑定到真实线程 |
| bound-at-rollout-eof | true | byteOffset=105611, eventsIngested=0 |
| no-pre-bind-history | true | evidence=0, capsuleContext=null |
| codex-session-continued | true | exit=0 |
| evidence-captured | true | evidenceId=ev_4b255da3-294f-498b-914f-9a6b74c5382b |
| capsule-references-evidence | true | evidenceIds=1 |
| capsule-has-captured-marker | true | contextChars=69 |
| continue-resumes-same-session | true | operation=resume, sameExternalSession=true |
| resume-prompt-reached-real-codex | true | deliveredByProduct=true, attributedTo=product-continue |
| continue-run-terminal | true | status=COMPLETED |

## 修复的缺陷（Task 7 关联）

- 根因：`ProcessSupervisor.launch` 在 Windows 上以 `detached: true` 启动 `cmd.exe /c codex.cmd ...`，导致管道化 prompt（`stdin.end(prompt)`）的 EOF 永远无法送达子进程，真实 Codex Continue 进程卡在 `RUNNING`、rollout 冻结、prompt 进不去。
- 隔离实验（4 种 spawn 组合，对 `cmd.exe /c node` 读 stdin 子进程）：`detached=true` 两组均不投递、`detached=false` 两组均成功投递；`windowsHide` 与投递无关。
- 修复：`detached` 仅在非 Windows（POSIX）保留（进程组信号所需），Windows 上让子进程留在守护进程进程组内；`windowsHide` 改为 `true`（无头守护进程不应弹出控制台窗口）。
- 验证：真实 smoke `resumeDeliveryAttributedTo` 由 `diagnostic-probe` 变为 `product-continue`，`continueFinalStatus` 由 `RUNNING` 变为 `COMPLETED`。

## 排除项（BLOCKED_EXTERNAL 不适用）

本次运行无登录 / 网络 / 额度问题，全部检查点为产品路径直接通过，结论记为 `PASS`。
