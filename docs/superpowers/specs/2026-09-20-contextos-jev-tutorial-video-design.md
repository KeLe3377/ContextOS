# ContextOS 全功能 JEV 教学视频设计

日期：2026-09-20
状态：待用户复核
目标：录制进入 ContextOS 网页后的全部当前可用操作，输出无配音、无额外字幕、以鼠标操作为主体的紧凑教学视频。

## 1. 范围

### 1.1 包含

- ContextOS 九个页面：概览、项目、会话、审查收件箱、决策、工作项、上下文、规则、设置。
- 当前前端中可点击且后端已实现的操作。
- 互斥生命周期分支，例如 Decision 的 Accept、Supersede、Reverse、Archive。
- Session 的 transcript 导入、Desktop 线程发现和绑定、同步、Continue、中断、Capsule、Evidence 和运行信息。
- JEV 自动操作轨迹、连续 CDP screencast、章节录像、合并视频和独立结果验证。

### 1.2 不包含

- 安装程序、启动窗口、健康检查和卸载过程。
- 禁用的占位入口，例如当前不可用的 Project 默认值编辑。
- 真实 Codex/Claude 付费执行、真实 Windows 开机启动注册、用户日常数据目录和真实项目文件。
- 配音、旁白、额外步骤字幕、营销片头和装饰性转场。

## 2. 成功标准

1. 九个页面均在最终视频中出现。
2. `CONTEXTOS_USAGE.md` 中列出的所有当前有效网页操作均被实际触发。
3. 每个操作有可观察结果，或由录像外的独立断言确认状态变化。
4. 视频只显示 ContextOS 网页和鼠标操作，不泄露 API Key、终端、文件系统路径中的个人敏感信息。
5. 操作以原速录制；通过预置状态、章节切分、删除等待和紧凑衔接缩短总时长。
6. 最终 MP4 可播放、非空、画面完整，另保留九章原始录像、JEV trace 和验证报告。

## 3. 总体架构

```text
隔离教程服务器
  ├─ 临时 SQLite / Evidence 目录
  ├─ 临时 Project root
  ├─ Fake Agent Adapter / Process runtime
  ├─ Fake StartupRegistration
  └─ 可重复 seed 数据
           |
           v
ContextOS React UI
           |
           v
JEV Agent
  页面快照 -> 动态元素表 -> TypeSafe Choice -> 浏览器操作
           |
           +-> OpenAI-compatible 文本助手（仅 TYPE_TEXT）
           |
           v
CDP Screencast + JEV trace
           |
           v
章节独立验证 -> FFmpeg 拼接 -> Playwright 视频验收
```

## 4. JEV 使用原则

JEV 每轮只接收当前页面的结构化文本和可操作元素表。TypeSafe 在一个请求中选择 operation，并并行选择各 operation 的候选 target；代码只消费被选中的 target head。

约束：

- 不让模型生成 CSS selector、坐标、JavaScript 或 shell 命令。
- 所有 target 必须来自当前 observation 中的真实元素。
- `TYPE_TEXT` 才调用 Vercel AI Gateway 文本模型。
- 不重试已经发出的浏览器 mutation；失败后重新 observation，再决定下一步。
- 截图仅用于录像和人工检查，不发送给 TypeSafe 或文本模型。
- `DONE` 只是模型判断，不作为成功证据；每章必须独立验证。
- 每个 JEV run 使用一个短而完整的自然语言目标，不写站点专用点击脚本或硬编码 selector。
- 一个页面章节可以由多个已验证的 JEV run 组成，避免 Session、Decision、Work Item 等长流程超过合理步数；子片段按操作清单顺序合并为该章。
- 表单示例值写进章节目标，由文本助手生成；执行器本身不硬编码字段值。

## 5. 凭据与配置

在 `source/jev-ultrafast-main/.env` 中使用：

```dotenv
TYPESAFE_API_KEY=
TYPESAFE_MODEL=jev-latest

TEXT_MODEL_API_KEY=
TEXT_MODEL_BASE_URL=https://ai-gateway.vercel.sh/v1
TEXT_MODEL=
TEXT_MODEL_REASONING=none
```

- `TYPESAFE_API_KEY`：JEV 每步 action/target 决策。
- `TEXT_MODEL_API_KEY`：Vercel AI Gateway Key，仅用于填写表单文本。
- `TEXT_MODEL`：用户可用的 Vercel Gateway 模型 ID。
- `.env` 已被 `.gitignore` 排除，不提交、不打印、不进入 trace 或视频。
- 测试和 dry-run 不调用付费 API。

## 6. 隔离教程环境

新增专用 tutorial server，复用真实 Fastify routes、application services、SQLite repositories 和 React 构建，不使用日常 `.contextos`。

隔离项：

- 数据目录使用临时目录。
- Project root 指向临时教程工作区。
- FILE Source 使用教程工作区内的样例文件。
- Rule Apply 只写临时 `AGENTS.md` / `CLAUDE.md`。
- StartupRegistration 使用内存 fake，保存设置但不写 Windows Startup 文件夹。
- Agent Adapter 使用 fake：可模拟 discover、launch、resume、running、interrupt、exit 和 transcript。
- Desktop candidates 和 rollout 文件使用固定测试数据，不访问用户真实 `~/.codex/sessions`。
- 下载文件写入教程 artifacts 目录。

教程服务器必须保持与生产 UI 相同的 API 契约。隔离通过依赖注入实现，不在前端加入“演示模式”分支。

## 7. 数据预置策略

完整覆盖不能依赖一个对象走完所有分支，因为很多生命周期互斥。每章开始前通过 seed API 或数据库 fixture 创建可识别对象：

- Projects：Active、Paused、待 Archive 各一个。
- Sessions：Created、Running、Completed、已绑定和未绑定各一条。
- Reviews：Open 和 In Progress 多条，分别用于 Assign、Resolve、Dismiss。
- Decisions：Draft、Proposed、Accepted 多条，分别用于 Edit、Review、Accept、Supersede、Reverse、Archive。
- Work Items：Backlog、Ready、In Progress、Blocked、In Review、Done、Canceled，以及父子和依赖关系。
- Context：Active/Paused Source、至少两个不同文件 Snapshot、Draft/Active/Stale Context Item 和多版本 Item。
- Rules：Draft、Active、Disabled 各一条。
- Runtime：成功、失败、运行中 Run/Job 和 transcript events。

seed 数据只负责建立起始条件；所有被教程覆盖的用户动作必须由 JEV 在网页上实际执行。

## 8. 九章操作清单

### 8.1 概览

- 进入概览并展示聚合状态。
- 点击刷新上下文。
- 从最近 Session 或 Work Item 引用进入对应对象。

### 8.2 项目

- 创建 Project 并选择 Agent Adapter。
- 切换选中 Project。
- Pause、Activate、Archive。
- 查看关联对象计数和 root path。

### 8.3 会话

- 创建 Session。
- 手动 Import Transcript。
- Import Existing Agent Session。
- 打开 Desktop Sync，选择自动发现候选。
- 用另一条 Session 演示手填 UUID。
- 演示从文件末尾、从文件开头、立即同步、自动同步、停止自动同步、重新绑定、解除绑定。
- Continue 未绑定 Session，Continue 已绑定 UUID Session。
- 查看 Runtime 并 Interrupt Running Session。
- Sync Transcript。
- 编辑 Resume Capsule 并导出。
- 查看 Context Package、Evidence 内容、Run History、Activity、Transcript Events。
- Archive Session。

### 8.4 审查收件箱

- Start、Assign。
- Resolve/Approve 并填写原因。
- Dismiss/Reject 并填写原因。
- 查看 action log。

### 8.5 决策

- 创建、编辑 Decision，形成多个版本。
- 选择两个版本并 Compare。
- Review、Propose、Accept。
- 用独立 Accepted Decision 演示 Supersede 和 Reverse。
- Archive 可归档状态的 Decision。

### 8.6 工作项

- 创建、编辑 Work Item。
- 设置父项、依赖、验收条件和执行契约。
- Mark Ready、Start、Start Session。
- Block、Resolve Blocker。
- Send to Review、Complete。
- Reopen Done/Canceled Item。
- Cancel 可取消状态的 Item。
- 打开 Child Item、Dependency 和 Agent Attempt 关联 Session。

### 8.7 上下文

- 创建和编辑 FILE Source。
- Sync、Pause、Resume、Archive 和批量 Sync Active Sources。
- 查看、复制、比较、校验 Evidence。
- 从 Evidence 创建 Context Item，也演示手动创建。
- 编辑、Activate、Mark Stale、Archive。
- 查看版本并恢复历史版本。

### 8.8 规则

- 创建 Rule。
- Validate、Test、Activate、Disable。
- 查看版本、usage 和 evaluation。
- Preview AGENTS、Apply AGENTS、Preview CLAUDE、Apply CLAUDE。
- 验证只替换临时文件中的 `CONTEXTOS_RULES` 托管块。

### 8.9 设置

- 切换默认 Adapter。
- 切换破坏性操作确认。
- 切换 Launch at startup（由 fake 接收）。
- Reset Changes、Save Changes。
- 查看 Runtime Health、失败 Job/Run、Adapter availability 和数据目录。

## 9. 录制与合并

每个章节按一个或多个独立子流程执行：

1. reset/seed 对应状态；
2. 启动 JEV Agent，传入当前子流程的单一自然语言目标；
3. 开启 CDP `Page.startScreencast`，保存原始时间戳 JPEG；
4. 保存每步 observation、choice、probabilities、action、latency 和文本调用信息；
5. JEV 结束后停止 screencast；
6. 运行子流程 verifier；
7. 同章所有子流程通过后生成章节验证汇总；
8. 章节汇总通过才允许进入最终合并。

视频保持原速。缩短方式仅包括：

- 每章直接从已 seed 的有效起始状态开始；
- 不录教程服务器启动和 seed；
- 删除章节首尾静止帧；
- 删除章节之间的浏览器重置过程；
- 相邻章节硬切，不添加长转场。

最终使用 FFmpeg 合并九章为 H.264 MP4，`yuv420p`、`faststart`，同时保留原始章节文件。

## 10. 验证

### 10.1 每步验证

- mutation 执行前记录目标元素和当前状态；
- mutation 后重新 observation；
- 不把页面动画或 JEV `DONE` 当成成功。

### 10.2 每章验证

- 通过 API/SQLite 查询验证目标对象的最终状态、revision 和关联记录。
- 下载、规则文件写入等检查实际 artifact。
- 输出 `verification.json`，包含每项操作的 `passed/failed/evidence`。

### 10.3 最终视频验证

- 九章文件全部存在且可解码。
- 合并 MP4 时长大于零，音轨为空。
- 抽取首帧、中间帧、末帧检查非空和画面边界。
- 用 Playwright/trace 清单确认九页面和全部操作均出现。
- 任一必选操作缺失则不交付“完整教程”结论。

## 11. 失败与恢复

- TypeSafe 或 Vercel API 失败：停止当前章，不执行猜测操作；保留 trace 后重录该章。
- JEV 低置信或 BLOCKED：保留原始证据，检查当前可见元素和目标表达，不改成 selector 脚本绕过。
- 页面状态漂移：重新 seed 当前章，不重放可能已经成功的 mutation。
- 视频帧错误：章节 verifier 即使通过也不合并，重新录制该章。
- 单章失败不重录其他已验证章节。

## 12. 交付物

```text
artifacts/contextos-tutorial/
  final/contextos-full-workflow.mp4
  chapters/01-overview.mp4 ... 09-settings.mp4
  recordings/<chapter>/screencast/*.jpg
  traces/<chapter>.json
  verification/<chapter>.json
  verification/summary.json
```

仓库内新增：

- tutorial server / seed 工具；
- 九章 JEV goal runner；
- 通用 CDP recorder；
- 章节 verifier；
- renderer/concat 脚本；
- `.env` 空值配置文件（ignored）；
- 离线测试，不调用付费 API。

## 13. 关键取舍

- 选择 JEV 而非硬编码 Playwright 操作：验证自然语言浏览器 Agent 能否使用 ContextOS，也避免脚本只适配当前 DOM selector。
- 保留 Playwright：用于最终验收和已有回归，不作为主录像操作者。
- 选择章节化而非单镜头：完整覆盖互斥生命周期，同时只重录失败章节。
- 选择原速而非倍速：保留真实鼠标和页面反馈；通过状态预置与剪掉非操作等待控制时长。
- 使用 fake 外部副作用：操作真实 UI 和 API 契约，但不污染用户电脑、真实 Agent 会话或启动项。
