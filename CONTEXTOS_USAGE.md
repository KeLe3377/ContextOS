# ContextOS 使用指南

这份文档面向日常使用，不是架构设计稿。目标是让你打开 ContextOS 后知道每个页面能做什么、按钮是什么意思、常见状态如何判断。

更新时间：2026-09-20。当前版本：`0.1.3`。

## 页面与能力总览

| 页面 | 主要用途 | 当前可执行操作 |
|---|---|---|
| 概览 | 恢复最近工作 | 查看当前项目、最近 Session、待审查项、就绪 Work Item、Context 健康状态，刷新数据 |
| 项目 | 定义工作区边界 | 创建、选择、暂停、启用、归档 Project |
| 会话 | 管理 Agent 工作过程 | 创建、继续、中断、归档、导入或同步 transcript、Desktop 只读同步、编辑和导出 Resume Capsule |
| 审查收件箱 | 处理治理问题 | 开始、指派、批准、解决、驳回 Review Item，查看操作日志 |
| 决策 | 保存长期选择 | 创建、编辑、送审、提交审议、接受、取代、撤销、归档，查看版本与对比 |
| 工作项 | 管理可验收任务 | 创建、编辑、设置父子项和依赖、就绪、开始、阻塞、解阻、送审、完成、重开、取消、启动 Agent Session |
| 上下文 | 管理证据和派生信息 | 创建/编辑/暂停/恢复/归档 Source，同步文件，查看/比较/校验 Evidence，创建/编辑/版本化 Context Item |
| 规则 | 管理 Agent 治理指令 | 创建、校验、试算、启用、停用，预览或应用到 `AGENTS.md` / `CLAUDE.md` |
| 设置 | 管理本地运行选项 | 默认 Adapter、破坏性操作确认、Windows 开机启动、运行健康和 Adapter 可用性 |

## 启动

### 已安装版本

运行 `inst\contextos-installer.exe` 后，ContextOS 默认安装到 `%LOCALAPPDATA%\ContextOS`，用户数据保存在 `%APPDATA%\ContextOS\.contextos`。

从桌面或开始菜单的 ContextOS 快捷方式启动。启动窗口必须保持打开，然后访问：

```text
http://127.0.0.1:4721/
```

卸载会删除安装目录和运行依赖，但保留用户数据。安装版仍要求本机可用 Node.js；首次安装运行时依赖需要网络，尚未覆盖“未安装 Node 且完全离线”的全新机器。

### 从源码启动

在项目根目录运行：

```powershell
cd D:\project\ContextOS
npm run start:local
```

保持这个 PowerShell 窗口打开。浏览器访问：

```text
http://127.0.0.1:4721/
```

`start:local` 会优先运行 `dist/apps/daemon/src/main.js`；没有构建产物时回退到 `tsx apps/daemon/src/main.ts`。源码模式默认数据目录是仓库下的 `.contextos/`。

开发验证可运行 `npm test` 做后端/集成回归，运行 `npm run test:e2e` 做桌面与移动视口的浏览器主流程检查。首次运行 E2E 前需要执行一次 `npx playwright install chromium`。

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

如果里面的 pid 已经不存在，可以删除锁再启动；正常情况下这一步已经由启动过程自动完成。删除前必须确认 owner 中的 PID 已不存在：

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
3. 如果你已经在 Codex 或 Claude Code 里有一段对话，用 `Import Existing Session` 导入并绑定它。
4. 如果你希望持续读取 Codex Desktop 后续新事件，再使用 `Desktop 同步` 选择候选线程或手填 UUID。
5. 如果只是保存一段摘要或复制来的内容，用 `Import Transcript` 手动粘贴，不要把它当成外部会话绑定。
6. 在 `Context` 添加重要的 `FILE` Source，例如 `README.md` 或设计文档，并同步生成 Evidence Snapshot。
7. 从 Evidence 派生 Context Item，按需要启用、标记过期、恢复版本或归档。
8. 在 `Rules` 创建、校验、试算并启用规则；应用到规则文件前先预览。
9. 用 `Work Items` 定义可验收任务，必要时从就绪项启动 Session。
10. 用 `Continue in Agent` 构建不可变 Context Package 并启动或续跑 Agent。

## 概览页面

概览是恢复工作的入口，不用于编辑完整对象。它会显示：

- 当前活动 Project；
- Session、待处理 Review、就绪 Work Item、活动 Context Item 和活动 Rule 数量；
- 最近一次 Session；
- 下一批可执行 Work Item；
- Context Source 和 Evidence 的健康摘要；
- 最近 Activity。

点击 `刷新上下文` 会重新加载当前工作区数据。对象的具体修改仍应进入各自页面完成。

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

### Desktop 同步

Desktop 同步用于持续、只读地摄入 Codex rollout 文件中新追加的结构化事件。它不会向 Codex Desktop 写消息，也不会控制当前 Desktop 窗口。

操作步骤：

1. 在 `Sessions` 选择目标 Session。
2. 点击顶部 `Desktop 同步`，或详情中的 `绑定会话`。
3. 等待候选列表加载。ContextOS 会通过 Codex app-server 的只读 `thread/list` 查询项目目录及其父目录下的线程。
4. 从候选中点击正确线程；候选会显示 UUID 前缀、对话摘要和 cwd。
5. 如果没有候选，手动粘贴 External session ID。
6. 选择起始位置后点击绑定。

起始位置：

| 选项 | 行为 | 适用场景 |
|---|---|---|
| 从文件末尾开始 | 绑定时不导入历史，只读取绑定后的新内容 | 默认推荐，避免重复摄入大量历史 |
| 从文件开头重新读取 | 从 byte offset 0 开始读取 | 首次需要完整回放该线程时 |

候选标记“已被其他会话绑定”时不可选择，避免同一外部线程同时绑定多个 ContextOS Session。

绑定成功后可以：

- `立即同步`：读取一次新增的完整 JSONL 行；
- `自动同步`：停留在 Sessions 页面且会话已绑定时，每 5 秒读取一次；
- `停止自动同步`：停止轮询，绑定关系仍保留；
- `重新绑定`：选择另一个路径或重新设定读取起点；
- `解除绑定`：删除 Desktop 同步状态。

面板会显示同步状态、已摄入事件数、已读字节/文件总字节、最近事件时间、滞后、transcript 路径和最近错误。

需要区分三种相关功能：

| 功能 | 是否绑定 UUID | 是否保存 Evidence | 是否持续增量读取 |
|---|---:|---:|---:|
| Import Existing Session | 是 | 是 | 否 |
| Sync Transcript | 使用现有绑定 | 是 | 手动执行一次完整导入/reconcile |
| Desktop 同步 | 是，并回写 Session | 否；只持久化同步状态、offset 和计数 | 是，按 byte offset 增量读取 |

候选发现依赖本机 `codex app-server`。如果 app-server 不可用，候选列表会为空，但手动输入 UUID 和文件 tail 同步仍然保留。

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

使用 `Ctrl+C` 正常关闭 ContextOS 时，仍在运行的受管 Agent 进程会被终止；对应 Run 和 Job 会记录为 `CANCELED / DAEMON_SHUTDOWN`，Session 回到 `PAUSED`，下次启动后可以继续。只有 daemon 异常退出、来不及执行关闭流程时，遗留的 `RUNNING` 记录才会在下次启动时恢复为 `FAILED / DAEMON_RESTARTED`。

### Resume Capsule

Resume Capsule 是 Session 的可编辑继续工作摘要。它与不可变 Evidence 不同：可以点击编辑按钮更新摘要、下一步、风险等派生信息，并通过 revision 防止并发覆盖。

点击 `导出摘要胶囊` 会下载当前 Session 的 Capsule 文件，适合交接、归档或交给不直接连接 ContextOS 的 Agent。导出不会修改 Session。

### Sync Transcript

`同步对话记录` 会让当前 Adapter 再次查找已绑定外部会话的 transcript，并按完整导入逻辑进行 reconcile：

- 内容有变化时创建新的 transcript Evidence；
- 内容未变化时复用已有 Evidence；
- 更新规范化事件、计数和 Resume Capsule；
- 不等同于 Desktop 同步的 byte-offset 增量读取。

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

`Run History` 会保留这个 Session 的每次 Agent 运行，包括状态、Run ID、开始/结束时间、PID、退出码和失败原因。失败后再次 Continue 不会覆盖之前的失败记录。Settings 的 `Runtime Health` 也可以从失败记录直接打开所属 Session。

`Transcript Events` 会显示 adapter 从原始 JSONL 规范化出的最新事件，包括 user/assistant message、tool call、tool result 和 summary。事件带原始发生时间；详情优先显示最新 12 条。单个超大工具输入或输出会保留首尾并标记 `output truncated`，避免一条日志挤掉整段会话。页面会分别提示 transcript 是否触及 1 MB 导入限制，以及事件列表是否来自最新 200 条窗口。

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

列出最近的文件：

```powershell
Get-ChildItem -Recurse -File "$env:USERPROFILE\.codex\sessions" -Filter "rollout-*.jsonl" |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 10 FullName,Length,LastWriteTime
```

按关键词查：

```powershell
rg -n "ContextOS|Continue in Agent|Imported transcript" "$env:USERPROFILE\.codex\sessions" -S
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
- `Pause`：暂停项目；暂停时不能继续启动该项目的 Session。
- `Activate`：重新启用暂停的项目。
- `Archive project`：归档项目。归档后默认列表隐藏。

Root path 要填真实项目根目录，例如：

```text
D:\project\ContextOS
```

不要带外层引号。

Project 的意义是限制 transcript 自动发现范围。ContextOS 只会导入 cwd 属于该 Project root 的 agent transcript，避免把别的项目对话混进来。

创建 Project 时可以指定允许的 Agent Adapter。Project 详情还会显示关联 Session、Decision、Work Item、Review Item、Context Source 和 Rule 的数量。当前前端没有 Project 编辑表单，顶部 `编辑默认值` 也是禁用入口；全局默认 Adapter 应到 Settings 修改。

## Context 页面

Context 页面管理上下文来源和 Evidence。

### Add Source

可以添加：

| 类型 | 当前用途 |
|---|---|
| `FILE` | 单个本地文件，例如 `README.md`；当前唯一支持 Sync 的类型 |
| `DIRECTORY` | 可登记目录位置，但当前不能执行 Sync |
| `URL` | 可登记网页地址，但当前没有网页抓取器 |
| `USER_NOTE` | 可登记手工说明来源，但当前没有专用内容编辑器 |
| `AGENT_OUTPUT` | 可登记 Agent 输出来源；实际运行输出通常由 Session 自动保存为 Evidence |

建议先添加：

```text
Type: FILE
Name: README
Locator: README.md
```

### Sync Source

点击 source 行内的 sync 图标会抓取当前内容，生成 Evidence Snapshot。

当前只支持同步 `ACTIVE + FILE` Source。Locator 可以是 Project root 下的相对路径，也可以是项目边界内的绝对文件路径。`DIRECTORY`、`URL`、`USER_NOTE` 和 `AGENT_OUTPUT` 目前只能登记，点击 Sync 会被后端拒绝。

Evidence Snapshot 是只读证据，用来支撑后续 Context Item、Resume Capsule、Decision 等内容。

内容 hash 与已有 Snapshot 相同时会复用现有 Evidence，不重复写入相同内容。Source 还可以执行编辑、暂停、恢复和归档。

### Verify Evidence

Evidence 行内 verify 会检查文件型 Evidence 是否仍存在且 hash 匹配。

如果 Evidence 文件丢失或不匹配，系统会生成 Review Item。

Evidence 还支持：

- 查看经过完整性校验的证据正文和 metadata；
- 复制 Evidence ID、storage ref 和 hash；
- 将历史 Snapshot 与该 Source 的最新 Snapshot 做文本对比；
- 从 Snapshot 派生 Context Item。

### Context Item

Context Item 是可治理的派生内容，可以来自 Evidence Snapshot，也可以手动创建。支持的类型包括 `FACT`、`SUMMARY`、`CONSTRAINT`、`OPEN_QUESTION`、`RISK` 和 `HANDOFF`。

可以执行：

- 创建和编辑标题、摘要、正文、置信度；
- 启用 Draft Item；
- 将 Active Item 标记为 Stale；
- 归档 Item；
- 查看版本历史；
- 恢复指定历史版本。

只有 `ACTIVE` Context Item 会进入后续 Context Package 的候选集合。Context Item 是派生信息，不应替代它引用的原始 Evidence。

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

选中 Rule 后可以查看当前版本、校验状态、scope、effect、使用位置、版本历史和最近 evaluation。`Preview AGENTS` / `Preview CLAUDE` 用于预览 ACTIVE Rules 生成的托管规则块；确认内容后可 Apply 到项目根目录的 `AGENTS.md` 或 `CLAUDE.md`。ContextOS 只替换 `CONTEXTOS_RULES` 标记块，不覆盖文件里的其他人工内容。全局目标也由后端支持，但日常应优先使用项目级规则文件。

## Review Inbox

Review Inbox 展示需要人工处理的事项。

当前会出现的典型 Review Item：

- Evidence 文件丢失；
- Evidence hash 不匹配；
- Rule 要求 review。

选择 Review Item 后可以查看 source、trigger、priority、reviewer、proposed resolution 和操作历史。可执行：

- `Start`：进入处理中状态；
- `Assign`：指定 reviewer ID；
- `Resolve`：以 `APPROVED`、`FIXED` 或 `ACKNOWLEDGED` 结案，并填写原因；
- `Dismiss`：说明不再适用的原因后关闭。

Review 的 start、assign、resolve、dismiss 都会保留 Activity/Audit 记录。

## Decisions

Decisions 是长期决策登记。

可以通过 `Record Decision` 创建 Decision，填写 statement、rationale、problem context、alternatives、consequences 和 references。Draft/Proposed Decision 可以编辑，每次正文修改都会生成新版本；详情中可以查看版本历史并选择两个版本对比。

当前生命周期操作：

- `Review`：将 Draft 或 Proposed Decision 送审并创建 Review Item；
- `Propose`：把 Draft 提交为 Proposed；
- `Accept`：接受 Draft 或 Proposed Decision；
- `Supersede`：将已接受决策标记为已被后续决策取代；
- `Reverse`：撤销已接受决策；
- `Archive`：归档 Draft、Proposed、Superseded 或 Reversed Decision。

已接受或关闭的版本不会被静默改写；需要改变结果时使用 Supersede 或 Reverse。

适合记录：

- 为什么采用某个技术方案；
- 为什么放弃某个方案；
- 某个模块的长期约束；
- 产品边界决策。

## Work Items

通过 `Create Item` 创建 Work Item，填写描述、验收条件、执行契约和可选父项。选中后可以编辑父项、依赖、描述、验收条件和执行契约，并执行 Ready、Start、Block、Resolve Blocker、Send to Review、Done、Reopen、Cancel 等状态动作。

进行中的 Work Item 可以点击 `Block` 并填写无法继续的原因。阻塞原因会显示在详情中；问题处理后点击 `Resolve Blocker`，填写处理结果，Work Item 会回到 `IN_PROGRESS`，原始原因和解决说明都会保留。

父 Work Item 的详情会列出 Child Work Items，可直接进入子项。`Work Item Activity` 汇总创建、编辑、状态变化、阻塞处理和 Agent Attempt 的活动及审计记录。

Ready Work Item 可以点击 `Start Session` 创建与工作项绑定的 Agent Session。之后从 Attempt 打开 Session、执行 `Continue`；Session 成功、失败或取消后，Attempt 会同步为 `SUCCEEDED`、`FAILED` 或 `CANCELED`，失败码、Run ID 和完成时间会显示在 Work Item 详情中。

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
- Launch at startup：是否在 Windows 登录后通过 Startup 文件夹启动本地 daemon；关闭后会删除 ContextOS 自己的启动项；
- Agent Adapters：查看 Codex / Claude Code 是否可用。

Codex adapter 正常应显示 `Available` 和版本号。

## 当前已支持的能力

现在 ContextOS 可以做：

- 通过源码或 Windows Inno Setup 安装包运行本地 daemon + React 前端；
- 使用 SQLite、本地 Evidence 文件和单实例数据目录锁；
- 创建、暂停、启用、归档 Project；
- 创建、编辑摘要、归档 Session；
- 启动、继续、中断 Codex 或 Claude Code managed process；
- 通过 stdin 给 Codex exec 传 handoff/resume prompt；
- 根据已绑定 UUID 执行 Codex CLI resume；
- 自动导入并绑定已有 Codex 或 Claude Code transcript；
- 手动粘贴 transcript 作为 Evidence；
- 手动同步已绑定 Agent transcript，并去重 Evidence；
- 通过 Codex app-server 只读发现候选线程，仍可手填 UUID；
- 从文件末尾或开头绑定 rollout，立即同步或每 5 秒自动增量读取；
- 查看 Desktop 同步 offset、文件大小、事件计数、滞后和错误；
- 查看 Session Context Package、选择原因、runtime、Run History、Activity、Resume Capsule 和 Evidence；
- 编辑和导出 Resume Capsule；
- 查看带时间戳和截断标记的 message、tool call、tool result、summary 事件；
- 添加、编辑、暂停、恢复、归档 Context Source；
- 同步 FILE Source，按内容 hash 创建或复用 Evidence Snapshot；
- 查看、复制、比较和校验 Evidence；
- 从 Evidence 创建 Context Item，编辑、启用、标记过期、归档、查看和恢复版本；
- 创建、验证、测试、激活、禁用 Rule；
- 将 ACTIVE Rules 预览并应用到项目 `AGENTS.md` / `CLAUDE.md` 托管块；
- 完整处理 Review Item 的 start、assign、resolve、dismiss；
- 创建、编辑、版本化、对比并完整流转 Decision；
- 创建、编辑、分层、阻塞并执行 Work Item；
- 从 Work Item 启动 Session，并回写 Agent Attempt 结果；
- 使用 Codex 和 Claude Code adapter；
- 在 Windows 登录后自动启动本地 daemon；
- 查看 Runtime Health、失败 Job 和失败 Run；
- 运行隔离数据目录的桌面/移动端 Playwright 主流程测试；
- 卸载程序时保留 `%APPDATA%\ContextOS\.contextos` 用户数据。

## 当前限制

现在还不完善的地方：

- `Continue in Agent` 启动的是受管 CLI turn，不是当前 Codex Desktop UI 对话；
- ContextOS 不能向已打开的 Desktop 任务发消息、点击按钮或控制其 UI；`desktopUiControl` 仍为 false；
- Desktop 同步是只读文件 tail。app-server 当前只用于发现候选线程，不用于通知流或同步读取；
- 候选发现依赖 experimental app-server；不可用时需要手填 External session ID；
- 已绑定的 Desktop 线程仍通过 CLI `resume` 继续，不会让焦点切回 Desktop 原窗口；
- Cursor adapter 尚未启用；
- Claude Code 已具备共享 adapter 生命周期和 transcript 规范化，但真实日常主链路仍以 Codex 验证为主；
- Context Source 目前只有 `FILE` 类型支持实际 Sync；没有 Directory crawler、URL fetcher 或 User Note 专用编辑器；
- daemon 重启后会恢复数据库中的孤儿 Run 状态，但不能重新接管旧进程的内存控制句柄；
- 当前没有 Windows Service；开机启动通过 Startup 文件夹中的 `ContextOS.cmd`；
- 安装包仍依赖本机 Node.js，尚未完成无 Node、无网络全新机器的完整验证；
- 当前是单机单用户本地产品，不提供云端账户、多机同步或协作权限系统。

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

### Desktop 同步没有候选会话

先确认 Codex CLI 可用：

```powershell
codex --version
```

候选发现使用 `codex app-server` 的只读 `thread/list`，默认查询 Project root 及其父目录。没有候选不影响手动绑定：从 rollout 文件名复制 UUID，粘贴到 `外部会话 ID`。

如果 UUID 正确但仍无法绑定，检查该线程是否属于当前 Project 或父子 cwd，以及对应 JSONL 是否仍存在。

### Desktop 同步绑定后没有历史事件

默认的“从文件末尾开始”只读取绑定后新增的内容，这是预期行为。需要读取历史时重新绑定并选择“从文件开头重新读取”。

若自动同步已开启但没有变化，确认当前仍停留在 Sessions 页面；5 秒轮询只在会话页、已绑定且开关开启时运行。

### Context Source 无法同步

当前只有 `ACTIVE + FILE` Source 支持 Sync。确认 Locator 指向 Project root 内实际存在的文件。`DIRECTORY`、`URL`、`USER_NOTE` 和 `AGENT_OUTPUT` 暂时不能同步。

### 安装版提示找不到 Node 或依赖

安装版启动脚本会先执行 `node -v`，并检查 `fastify`、`better-sqlite3`、`zod` 等运行依赖。确认 Node.js 已安装并位于 PATH，然后在有网络的环境中重新运行安装程序或启动脚本完成 `npm install --omit=dev`。

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
Test Files  24 passed
Tests       124 passed
```
