# ContextOS 使用指南

这份文档面向日常使用，不是架构设计稿。目标是让你打开 ContextOS 后知道每个页面能做什么、按钮是什么意思、常见状态如何判断。

## 启动

在项目根目录运行：

```powershell
cd D:\project\ContextOS
npm run start:local
```

保持这个 PowerShell 窗口打开。浏览器访问：

```text
http://127.0.0.1:4721/
```

如果浏览器提示 `ERR_CONNECTION_REFUSED`，说明 daemon 没启动。先看启动窗口报错。新版启动时会自动清理 pid 已不存在的 `.contextos\.daemon.lock` 残留。

如果仍然提示 data directory 正在使用，先确认是不是已有 daemon 在运行：

```powershell
curl.exe http://127.0.0.1:4721/api/health
```

如果健康检查能返回 JSON，直接打开前端即可：

```text
http://127.0.0.1:4721/
```

如果健康检查失败，但仍然报锁冲突，可以查看锁 owner：

```powershell
Get-Content -Raw ".contextos\.daemon.lock\owner.json"
```

如果里面的 pid 已经不存在，可以删除锁再启动；正常情况下这一步已经由启动过程自动完成：

```powershell
Remove-Item -Recurse -Force ".contextos\.daemon.lock"
npm run start:local
```

## 核心概念

`Project` 是一个项目工作区边界，通常就是一个代码仓库根目录。

`Session` 是一次 Agent 工作 episode。它记录这次工作的意图、状态、导入的 transcript、生成的 Context Package、Evidence 和 Resume Capsule。

`Evidence Snapshot` 是不可变证据。原始 transcript、handoff prompt、命令输出、文件快照都会作为 Evidence 保存。

`Resume Capsule` 是 Session 的继续工作摘要。它告诉下一次继续时应该记住什么。

`Context Source` 是上下文来源，例如 `README.md`、`docs/`、某个本地文件、URL 或用户笔记。

`Context Item` 是从 Evidence 或 Source 派生出来的可用上下文，例如事实、总结、约束、风险。

`Rule` 是治理规则。它可以在某些动作发生时给出提示、要求 review，或阻止动作。

## 推荐使用流程

日常推荐先按这个顺序用：

1. 在 `Projects` 确认项目存在，Root path 是 `D:\project\ContextOS`。
2. 在 `Sessions` 创建一个 Session，写清楚 title 和 intent。
3. 如果你已经在 Codex 里有一段对话，优先用 `Import Existing Session` 绑定这段已有对话。
4. 如果只是想保存一段摘要或手动整理内容，用 `Import Transcript` 粘贴文本。
5. 在 `Context` 添加重要文件为 Source，例如 `README.md` 或设计文档。
6. 点击 Source 的 sync，生成 Evidence Snapshot。
7. 在 `Rules` 创建、validate、activate 规则。
8. 后续再用 `Continue in Agent` 从已绑定的 Session 继续。

## Sessions 页面

Sessions 是目前最重要的页面。

### New Session

创建一个 ContextOS Session。常见填写：

```text
Project: ContextOS · D:\project\ContextOS
Title: ContextOS 前端测试
Intent: 测试已有 Codex 会话导入和 Continue in Agent 闭环
Agent: Codex
```

创建后状态通常是 `CREATED`。

如果列表里有多个 Project，一定先选对 Project。Session 的 transcript 导入、规则、Evidence 都会按这个 Project 边界归属；选到别的项目时，导入当前 ContextOS 对话会提示找不到 transcript。

### Import Existing Session

用于导入并绑定本机已有的 Codex 或 Claude Code 对话。

这和 `Import Transcript` 不一样。`Import Existing Session` 会走 adapter 自动解析本机 transcript 文件，并把外部 agent session ID 绑定到 ContextOS Session。

以这次 Codex 对话为例：

```text
Transcript 文件:
C:\Users\cxsy5\.codex\sessions\2026\09\17\rollout-2026-09-17T13-48-04-01a0ade8-6848-7d91-a328-b7780587365e.jsonl

External session ID:
01a0ade8-6848-7d91-a328-b7780587365e
```

操作：

1. 在 `Sessions` 找到目标 ContextOS Session。
2. 点行内 `manage_search` 图标，或顶部 `Import Existing Session`。
3. `External session ID` 填：

   ```text
   01a0ade8-6848-7d91-a328-b7780587365e
   ```

4. `Title` 可以写：

   ```text
   Imported Codex transcript
   ```

5. `Summary` 写这段对话希望 Resume Capsule 记住的内容。
6. 提交后看 `Latest Session Context`：
   - `EXTERNAL AGENT SESSION` 应显示该 ID；
   - Evidence 里应出现 imported transcript；
   - Resume Capsule 会更新。

如果不填 External session ID，系统会尝试找当前 Project root 下最新的 transcript。

如果 Codex Desktop 是从父目录打开的，例如 transcript metadata 里的 cwd 是 `D:\project`，而 ContextOS Project root 是 `D:\project\ContextOS`，请显式填写 External session ID。显式导入会允许这种父子目录匹配；不填 ID 的自动发现仍然只扫描 Project root 内的 transcript，避免误导入隔壁项目。

### Import Transcript

用于手动粘贴文本。它只会新增 Evidence，并更新 Resume Capsule；不会绑定外部 Codex session。

适合保存：

- 手工总结；
- 别处复制来的对话片段；
- 临时结论；
- 不能被 adapter 自动解析的文本。

不适合用来接管已有 Codex 会话。

### Continue in Agent

每次 Continue 都会生成一个不可变的 Context Package。普通 Session 会选择项目中已接受的 Decisions、ACTIVE Context Items、这些 Context 对应的 Evidence，以及 ACTIVE Rules；从 Work Item 启动的 Session 还会加入当前 Work Item 和它的阻塞依赖。

在 Sessions 的 `Context Package Selection` 中可以查看每个对象、内联摘要和选择原因。该包生成后不会随原对象后续编辑而变化，因此可以复现当次 Agent 实际收到的上下文。交接 Evidence `ContextOS handoff prompt` 保存了发送给 Agent 的完整文本。

继续一个 Session。

如果 Session 没有绑定 `externalSessionId`，ContextOS 会启动一个新的 Codex exec 进程，并尝试在退出后自动导入 transcript。

如果 Session 已绑定 `externalSessionId`，ContextOS 会执行类似：

```text
codex exec resume <externalSessionId> -
```

并通过 stdin 传入 ContextOS 的最新 handoff/resume prompt。

状态含义：

| 状态 | 含义 |
|---|---|
| `CREATED` | 已创建，还没运行 |
| `RUNNING` | ContextOS 管理的 agent 进程还活着 |
| `PAUSED` | 被中断 |
| `COMPLETED` | 进程正常退出 |
| `FAILED` | 进程非 0 退出或启动失败 |
| `ARCHIVED` | 已归档，默认列表隐藏 |

如果 Session 长时间 `RUNNING`，说明受管进程还没退出。可以点 `stop_circle` 中断。

### Runtime 信息

`Latest Session Context` 里有一块 `RUNTIME`：

```text
RUNNING
pid 12345 · managed true · running true
```

这说明 ContextOS 还在管理该进程。

如果显示：

```text
No managed process
```

说明没有当前 daemon 可管理的运行进程，通常是已退出、daemon 重启过，或该 Session 是手动导入的。

### Evidence 列表

Evidence 里常见项目：

| Evidence | 含义 |
|---|---|
| `ContextOS handoff prompt` | Continue 时传给 agent 的上下文 |
| `Codex process output` | Codex 子进程 stdout/stderr/exitCode |
| `Imported Codex transcript` | 从本机 Codex JSONL 自动导入的 transcript |
| `Imported transcript` | 手动粘贴的 transcript |

## 找到当前 Codex transcript

Codex 本地 transcript 通常在：

```text
C:\Users\cxsy5\.codex\sessions\YYYY\MM\DD\
```

列出今天最新的文件：

```powershell
Get-ChildItem -Recurse -File "C:\Users\cxsy5\.codex\sessions\2026\09\17" -Filter "rollout-*.jsonl" |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 10 FullName,Length,LastWriteTime
```

按关键词查：

```powershell
rg -n "ContextOS|Continue in Agent|Imported transcript" "C:\Users\cxsy5\.codex\sessions\2026\09\17" -S
```

文件名里这段就是可用于导入的外部 session ID：

```text
rollout-2026-09-17T13-48-04-01a0ade8-6848-7d91-a328-b7780587365e.jsonl
                               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
```

## Projects 页面

Projects 管理项目边界。

常用操作：

- `Add Project`：添加一个工作区。
- `Archive project`：归档项目。归档后默认列表隐藏。

Root path 要填真实项目根目录，例如：

```text
D:\project\ContextOS
```

不要带外层引号。

Project 的意义是限制 transcript 自动发现范围。ContextOS 只会导入 cwd 属于该 Project root 的 agent transcript，避免把别的项目对话混进来。

## Context 页面

Context 页面管理上下文来源和 Evidence。

### Add Source

可以添加：

| 类型 | 用途 |
|---|---|
| `FILE` | 单个文件，例如 `README.md` |
| `DIRECTORY` | 目录，例如 `docs/` |
| `URL` | 网页 |
| `USER_NOTE` | 手工说明 |
| `AGENT_OUTPUT` | Agent 输出 |

建议先添加：

```text
Type: FILE
Name: README
Locator: README.md
```

### Sync Source

点击 source 行内的 sync 图标会抓取当前内容，生成 Evidence Snapshot。

Evidence Snapshot 是只读证据，用来支撑后续 Context Item、Resume Capsule、Decision 等内容。

### Verify Evidence

Evidence 行内 verify 会检查文件型 Evidence 是否仍存在且 hash 匹配。

如果 Evidence 文件丢失或不匹配，系统会生成 Review Item。

## Rules 页面

Rules 是治理规则。当前 UI 支持基础链路：

1. `New Rule` 创建草稿。
2. 行内 `rule` 图标 validate。
3. 行内 `science` 图标用 `session.continue` 样例测试。
4. 行内 `toggle_on` 激活。
5. 行内 `toggle_off` 禁用。

规则 enforcement mode：

| 模式 | 含义 |
|---|---|
| `ADVISORY` | 建议 |
| `WARNING` | 警告 |
| `REQUIRE_REVIEW` | 需要 review |
| `BLOCK` | 阻止动作 |

当前最实用的规则场景是拦截或标记 `session.continue`。

## Review Inbox

Review Inbox 展示需要人工处理的事项。

当前会出现的典型 Review Item：

- Evidence 文件丢失；
- Evidence hash 不匹配；
- Rule 要求 review。

当前前端主要是查看列表，resolve/dismiss UI 还未完整做完。

## Decisions

Decisions 是长期决策登记。

当前前端主要是查看已有 Decision。创建、编辑、状态流转后续还需要补 UI。

适合记录：

- 为什么采用某个技术方案；
- 为什么放弃某个方案；
- 某个模块的长期约束；
- 产品边界决策。

## Work Items

Work Items 是可执行工作项。

当前前端主要是查看列表。完整创建、编辑、状态流转 UI 后续还需要补。

适合记录：

- 一个明确的功能；
- 一个 bug 修复；
- 一个可验收的任务；
- 一个后续增强。

## Settings 页面

Settings 管理本地默认设置。

常用：

- Default adapter：默认 agent adapter；
- Review gate：破坏性操作是否要求确认；
- Launch at startup：是否开机启动；
- Agent Adapters：查看 Codex / Claude Code 是否可用。

Codex adapter 正常应显示 `Available` 和版本号。

## 当前已支持的能力

现在 ContextOS 可以做：

- 本地 daemon + React 前端运行；
- 创建、归档 Project；
- 创建、归档 Session；
- 启动、继续、中断 Codex managed process；
- 通过 stdin 给 Codex exec 传 handoff/resume prompt；
- 自动导入并绑定已有 Codex transcript；
- 手动粘贴 transcript 作为 Evidence；
- 查看 Session context package、runtime、resume capsule、Evidence；
- 添加和同步 Context Source；
- 创建 Evidence Snapshot；
- 校验 Evidence 文件完整性；
- 创建、验证、测试、激活、禁用 Rule；
- 查看 Review Items、Decisions、Work Items；
- 使用 Codex 和 Claude Code adapter first pass。

## 当前限制

现在还不完善的地方：

- `Continue in Agent` 启动的后台进程不是当前 Codex UI 对话本身；
- 已有 Codex 对话需要通过 `Import Existing Session` 绑定；
- Review Inbox 还缺少完整 resolve/dismiss 操作 UI；
- Decisions 还缺少完整创建/编辑/状态流转 UI；
- Work Items 还缺少完整创建/编辑/状态流转 UI；
- Context Item 派生和编辑 UI 仍是 first pass；
- `Export Capsule` 按钮还不是完整产品功能；
- 没有浏览器 E2E 自动验收。

## 常见问题

### 浏览器打不开

先确认 `npm run start:local` 的窗口还开着。

检查：

```powershell
curl.exe http://127.0.0.1:4721/api/health
```

如果拒绝连接，daemon 没启动。

### 提示 data directory is already in use

新版会自动清理 pid 已不存在的残留锁。先检查是否已有 daemon 正在运行：

```powershell
curl.exe http://127.0.0.1:4721/api/health
```

如果能返回 JSON，说明服务已经可用，不需要再启动第二个 daemon。

如果健康检查失败，再查看锁 owner：

```powershell
Get-Content -Raw ".contextos\.daemon.lock\owner.json"
```

如果 pid 不存在：

```powershell
Remove-Item -Recurse -Force ".contextos\.daemon.lock"
```

### Continue 后一直 RUNNING

说明 ContextOS 管理的进程还活着。可以等待，也可以点 `stop_circle` 中断。

### Continue 后 FAILED

看 Evidence 里的 `Codex process output`。它会记录：

```text
exitCode
signal
stdout
stderr
```

如果只有 `exitCode: 2`，通常是 Codex 参数或运行环境错误。

### 手动 Import Transcript 后 Session 没绑定

正常。手动导入只是存 Evidence，不绑定外部 agent session。

要绑定已有 Codex 对话，用 `Import Existing Session`。

### 怎么把这次 Codex 对话导入

找到 transcript 文件：

```text
C:\Users\cxsy5\.codex\sessions\2026\09\17\rollout-2026-09-17T13-48-04-01a0ade8-6848-7d91-a328-b7780587365e.jsonl
```

在 `Sessions` 点 `Import Existing Session`，External session ID 填：

```text
01a0ade8-6848-7d91-a328-b7780587365e
```

导入成功后，`EXTERNAL AGENT SESSION` 会显示该 ID。

## 开发验证命令

改代码后建议运行：

```powershell
npm run build:all
npm test
git diff --check
```

当前健康基线：

```text
Test Files  19 passed
Tests       84 passed
```
