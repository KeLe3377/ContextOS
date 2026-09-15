# ContextOS 前后端架构设计 - 上下文恢复文档

生成时间：2026-09-14
原始记录位置：Codex 桌面应用当前任务历史；当前工具环境未能解析具体 transcript 文件路径，原始记录未修改

## 任务目标

完成 ContextOS 产品的设计评审、前端设计与接口契约、后端整体架构、SQLite 数据库设计和后端实现计划，为下一阶段正式开发提供连续设计基线。

## 已完成

- Figma 中已复制并整理 9 个正式候选画板，原始 Stitch 导入画板保持不变。
- Figma 第一轮清理已完成：导航分组、非法菜单、endpoint 和部分术语已统一。
- 已确认 Figma 尚有下一轮视觉清理项，但因 Starter 免费额度用完暂未执行。
- 已创建 Git 仓库：D:\project\ContextOS\.git；当前还没有提交。
- 已确认并写入产品设计基线：
  - D:\project\ContextOS\DESIGN.md
- 已写入前端设计与接口契约：
  - D:\project\ContextOS\docs\2026-09-14-contextos-frontend-design-api.md
- 已写入后端整体架构：
  - D:\project\ContextOS\docs\2026-09-14-contextos-backend-architecture.md
- 已写入 SQLite 数据库设计：
  - D:\project\ContextOS\docs\2026-09-14-contextos-database-design.md
- 已写入后端实现计划：
  - D:\project\ContextOS\docs\superpowers\plans\2026-09-14-contextos-backend-implementation-plan.md
- 用户明确决定暂不开始开发。

## 当前状态

设计阶段已完成，开发阶段尚未开始。当前最晚确定的技术和架构方案如下：

- TypeScript + Node.js
- SQLite + better-sqlite3 + Drizzle ORM + Drizzle migrations
- 单机单用户、本地优先
- daemon 只监听 127.0.0.1:4721
- 模块化单体 daemon
- 内置可恢复后台 Job、lease、retry、outbox 和 audit
- 统一 Agent Adapter：Claude Code、Codex、Cursor
- Evidence Snapshot append-only
- Derived Context Item 必须有 provenance 和版本
- 所有可变资源使用 revision 并发控制
- 生命周期使用显式 action endpoint
- Domain 不直接依赖 SQLite、Drizzle、文件系统或具体 Agent

## 关键约束

- Figma 明天额度恢复后再完成 API footer 和 Settings 文案清理；不要现在修改 Figma。
- Figma 原始画板不要删除或覆盖，只修改复制后的正式候选画板。
- Settings 必须是一个页面，不拆 tabs 或子页面。
- 正式导航只能包含 Overview、Projects、Sessions、Review Inbox、Decisions、Work Items、Context、Rules。
- API/debug footer 不属于产品界面。
- 产品术语使用 Context Source、Evidence Snapshot、Context Item、Derived、Provenance；不要把 knowledge graph、triples 等作为主产品概念。
- ContextOS 是治理工作空间，不是聊天机器人、知识图谱、通用项目管理工具或营销 dashboard。
- 原始对话和 Evidence Snapshot 只读；派生内容只能通过版本化修改。
- 跨模块只展示 ID、短标题、计数、链接和 provenance，不嵌入其他模块的完整表格或编辑器。
- 本阶段不做账号、云同步、多人协作、公网监听、微服务或分布式消息队列。
- 暂不写代码；先完成设计审阅和后续开发计划确认。

## 关键决策记录

- 采用 Pure Light Workspace，而不是暗色侧栏或明暗混搭，因为 ContextOS 是高频、密集、技术型桌面工作工具。
- 采用模块化单体 daemon，而不是微服务，因为第一阶段是单机单用户，需要简单部署、事务一致和容易恢复。
- 采用 better-sqlite3 + Drizzle，而不是更重的 ORM，因为本地 SQLite daemon 需要简单、可审查的事务和 migration。
- 采用统一 Agent Adapter，而不是让核心层直接识别各 Agent 文件格式，因为后续增加 Agent 时不应改动 Session、Evidence 和 Context 核心。
- 第一阶段直接支持 Agent 的导入、启动和继续，而不是只做 transcript 导入，因为产品核心动作是 Continue in Agent。
- 采用资源状态加显式 action，而不是任意 PATCH status，因为生命周期变化需要验证、幂等和审计。
- 采用普通资源存储加 Domain Event/Activity/Audit/Outbox，而不是全量事件溯源，因为当前阶段需要可靠审计但不需要事件重放作为唯一状态来源。

## 精华对话

用户原话：

> “下面就是后端整体架构的设计，这是真实运作的部分”

用户原话：

> “直接支持是对的”

用户原话：

> “嗯，对，拆分后端实现计划”

用户原话：

> “先不开始开发。”

## 下一步任务

1. Figma 额度恢复后，完成复制画板中的 API footer 和 Settings 文案收尾。
2. 复核 Figma 正式画板与 DESIGN.md 的尺寸、导航、术语和页面职责一致性。
3. 用户审阅后端实现计划。
4. 用户选择 Subagent-Driven 或 Inline Execution。
5. 开始实现计划 Task 1：daemon 工作区、配置、健康检查和测试。
6. 随后依次实现 migration、Repository、核心资源、Evidence/Context、Rules、Jobs 和 Agent adapters。

## 涉及文件

- D:\project\ContextOS\DESIGN.md
- D:\project\ContextOS\docs\2026-09-14-contextos-frontend-design-api.md
- D:\project\ContextOS\docs\2026-09-14-contextos-backend-architecture.md
- D:\project\ContextOS\docs\2026-09-14-contextos-database-design.md
- D:\project\ContextOS\docs\superpowers\plans\2026-09-14-contextos-backend-implementation-plan.md
- D:\project\ContextOS\.archives\2026-09-14_设计ContextOS前后端架构_方案确定.md

## 工具和环境备注

- Figma MCP Starter 额度已用完，未进行本轮修改。
- 本轮 Codex 工具环境无法解析历史 transcript 的具体文件路径。
- 本轮未启动开发服务器、未创建后端代码、未执行开发计划。
