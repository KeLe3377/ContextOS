# ContextOS 前端详细设计与接口契约

状态：前端实现基线，等待 Figma 最后一轮视觉复核
日期：2026-09-14
范围：桌面端前端页面、交互、状态、资源型 API 契约

本文只规定前端如何消费后端能力，以及前后端之间的稳定契约。不规定数据库表、ORM、后端模块拆分、任务队列或具体存储实现。

## 1. 实现边界

ContextOS 是本地优先的 Agent Workspace 和工作上下文治理工具。前端面向使用 Claude Code、Codex、Cursor 等编码 Agent 的开发者，负责：

- 展示项目、会话、审核项、决策、工作项、上下文和规则
- 支持用户明确发起的创建、编辑、审核和生命周期操作
- 区分原始证据、不可变快照和派生内容
- 在跨模块场景中只展示引用、短标题、计数和跳转链接
- 为后端提供稳定、可验证、可追踪的请求

前端不负责：

- 自行推断或修改后端领域状态
- 把会话内容直接转换为权威事实
- 在页面内嵌其他模块的完整表格或编辑器
- 通过模糊的 `PATCH status` 代替有审计意义的生命周期动作
- 暴露数据库路径、内部 SQL、调试 API 或实现细节

## 2. 设计基线

### 2.1 桌面 Shell

- 参考尺寸：1440 x 1024
- 白色固定侧栏：244px
- 白色固定工具栏：64px
- 主背景：`#F8FAFC`
- 主表面：`#FFFFFF`
- 默认边框：`#E2E8F0`
- 主文字：`#0F172A`
- 次要文字：`#475569`
- 主色：`#2563EB`
- 选中背景：`#EDF4FE`
- 界面字体：IBM Plex Sans
- 技术元数据：IBM Plex Mono
- 默认圆角：4px，最大 8px
- 目标设备：桌面端；本阶段不实现移动端和响应式移动布局

### 2.2 导航

```text
WORKSPACE
Overview
Projects
Sessions

GOVERNANCE
Review Inbox
Decisions
Work Items
Context

SYSTEM
Rules
```

侧栏底部可显示 Daemon 状态、本地 endpoint 和 Settings。`Connectors`、`SQLite Store` 等实验性菜单不属于正式导航。

### 2.3 页面路由

```text
/overview
/projects
/sessions
/review-inbox
/decisions
/work-items
/context
/rules
/settings
```

列表页通过 URL query 保存筛选、排序和选中对象，刷新后应保持可恢复。例如：

```text
/work-items?projectId=p_1&status=READY&selected=w_12
```

## 3. 页面通用结构

除 Overview 外，正式对象页面均采用：

1. 页面标题、简短说明、搜索和一个主要创建操作
2. 紧凑筛选栏
3. 左侧对象 register
4. 右侧选中对象 detail workspace
5. 对象相关生命周期操作
6. 必要时显示 Activity、Version History 或 Audit Log

对象页面不得用大面积 KPI 卡片替代表格。相关对象只以 `id`、短标题、状态、数量和链接显示。

### 3.1 通用页面状态

所有数据页面必须定义：

- `loading`：保留稳定的行高和列宽，使用骨架行或加载指示
- `empty`：说明当前没有对象，并提供一个相关操作
- `no_results`：说明筛选无结果，提供清除筛选
- `read_only`：保留浏览能力，隐藏或禁用写操作并说明原因
- `saving`：保存按钮进入进行中状态，防止重复提交
- `save_error`：保留用户草稿，显示错误和重试
- `conflict`：提示服务端版本较新，允许查看差异后重新加载
- `missing_reference`：引用对象不存在时显示 ID 和降级文本
- `unsaved_changes`：离开编辑区或切换对象前确认

### 3.2 通用请求行为

- 所有请求带 `Accept: application/json`
- 产生变更的请求带 `Content-Type: application/json`
- 写请求使用 `Idempotency-Key`；重试必须复用同一个 key
- 更新带 `If-Match: <revision>` 或请求体中的 `expectedRevision`
- 前端不对生命周期动作做无条件乐观更新；以服务端响应为准
- 成功后失效当前资源、相关列表和 Overview 聚合缓存
- 错误提示优先使用后端 `message`，同时根据 `code` 映射可操作的界面行为

## 4. 通用数据约定

### 4.1 标识与时间

所有资源至少包含：

```ts
type ResourceMeta = {
  id: string;
  createdAt: string; // ISO 8601 UTC
  updatedAt: string; // ISO 8601 UTC
  revision: number;
};
```

时间在 API 中统一使用 ISO 8601 UTC；前端按本地时区展示，同时保留完整时间的 tooltip。长 ID、路径和 hash 必须安全截断。

### 4.2 列表响应

```ts
type PageInfo = {
  nextCursor: string | null;
  hasMore: boolean;
};

type ListResponse<T> = {
  items: T[];
  page: PageInfo;
};
```

列表参数统一支持：

```text
projectId, status, q, sort, direction, cursor, limit
```

默认 `limit=50`，最大 `limit=200`。分页使用 cursor，不允许前端假设页码连续。

### 4.3 错误响应

```ts
type ApiError = {
  error: {
    code:
      | 'INVALID_ARGUMENT'
      | 'UNAUTHENTICATED'
      | 'FORBIDDEN'
      | 'NOT_FOUND'
      | 'CONFLICT'
      | 'PRECONDITION_FAILED'
      | 'UNAVAILABLE'
      | 'INTERNAL';
    message: string;
    fieldErrors?: Record<string, string[]>;
    currentRevision?: number;
    requestId: string;
  };
};
```

前端处理规则：

- `INVALID_ARGUMENT`：定位字段并显示校验信息
- `FORBIDDEN`：切换只读状态，不反复重试
- `NOT_FOUND`：显示对象缺失状态，并刷新引用列表
- `CONFLICT` / `PRECONDITION_FAILED`：保留草稿，显示服务端版本和差异入口
- `UNAVAILABLE`：保留页面状态，显示重试
- `INTERNAL`：显示 request ID，允许重试，不展示堆栈

## 5. 共享前端组件

### 5.1 AppShell

职责：渲染 Sidebar、UtilityHeader、页面容器和全局 Toast。它不请求业务对象数据，只请求 daemon health 和当前设置摘要。

### 5.2 Register

职责：展示拥有页面对象的密集列表。支持固定列宽、排序、选中行、键盘焦点、加载行、空行和无结果状态。Register 不直接实现领域写操作。

### 5.3 DetailWorkspace

职责：展示选中对象的可编辑字段、引用字段、状态和上下文操作。编辑草稿与服务端对象分离，保存成功前不覆盖本地草稿。

### 5.4 LifecycleAction

显式调用对象动作 API。危险动作先显示确认对话框；确认文本包含对象名称、结果和不可逆影响。

### 5.5 EvidenceTrace

只读展示证据来源、快照 ID、采集时间和 provenance。不得出现编辑按钮。派生 Context Item 必须有明显的 `Derived` 标识和来源链接。

### 5.6 Activity、VersionHistory、AuditLog

这些区域只显示 actor、时间、动作和简短变更元数据。不能删除历史记录，也不能把审计记录设计成普通可编辑文本。

## 6. 页面详细设计与接口

## 6.1 Overview

职责：帮助用户恢复最近一次工作，不承担完整分析看板职责。

主要区域：Current Project、Last Session、Next Work Items、Pending Review count、Recent Activity、Compact Context health。

主要操作：`Continue in Agent`。该操作跳转或调用 Session continue，不在 Overview 内嵌会话编辑器。

```http
GET /api/workspace/overview?projectId=:projectId
```

```ts
type Overview = {
  currentProject: ProjectSummary | null;
  lastSession: SessionSummary | null;
  nextWorkItems: WorkItemSummary[];
  pendingReviewCount: number;
  recentActivity: ActivityEvent[];
  contextHealth: ContextHealthSummary;
};
```

## 6.2 Projects

拥有对象：`Project`。页面重点是 workspace boundary、治理配置和项目健康度。

项目可展示 Sessions、Decisions、Work Items、Rules、Review Items 的小计数和链接，但不得嵌入这些对象的完整内容。

```http
GET    /api/projects
POST   /api/projects
GET    /api/projects/:id
PATCH  /api/projects/:id
POST   /api/projects/:id/activate
POST   /api/projects/:id/pause
POST   /api/projects/:id/archive
POST   /api/projects/:id/restore
GET    /api/projects/:id/health
GET    /api/projects/:id/linked-counts
```

创建和编辑请求：

```ts
type ProjectInput = {
  name: string;
  description?: string;
  rootPath: string;
  defaultRuleIds: string[];
  agentAdapterIds: string[];
};
```

## 6.3 Sessions

拥有对象：`Session`。页面重点是一次具体 Agent work episode 的意图、运行状态、证据和 resume capsule。

```http
GET    /api/sessions
POST   /api/sessions
GET    /api/sessions/:id
PATCH  /api/sessions/:id
POST   /api/sessions/:id/continue
POST   /api/sessions/:id/review
POST   /api/sessions/:id/archive
GET    /api/sessions/:id/context-pack
GET    /api/sessions/:id/evidence
GET    /api/sessions/:id/artifacts
GET    /api/sessions/:id/resume-capsule
PATCH  /api/sessions/:id/resume-capsule
POST   /api/sessions/import-transcript
```

`continue` 响应必须返回新的运行状态和必要的 agent launch information；前端不自行拼接 daemon 命令。

## 6.4 Review Inbox

拥有对象：`Review Item`。页面重点是待人工处理的治理问题。来源对象只以引用显示。

```http
GET    /api/review-items
POST   /api/review-items
GET    /api/review-items/:id
PATCH  /api/review-items/:id
POST   /api/review-items/:id/assign
POST   /api/review-items/:id/start
POST   /api/review-items/:id/resolve
POST   /api/review-items/:id/dismiss
GET    /api/review-items/:id/evidence-delta
GET    /api/review-items/:id/action-log
POST   /api/review-items/claim-next
POST   /api/review-items/bulk-assign
POST   /api/review-items/bulk-status
```

批量操作必须返回每个对象的成功或失败结果，不能用一个整体成功状态掩盖部分失败。

## 6.5 Decisions

拥有对象：`Decision`。Decision 是有版本的持久化选择。Accepted Decision 不允许静默覆盖，重大变化必须 supersede 或 reverse。

生命周期：`Draft -> Proposed -> Accepted -> Superseded/Reversed/Archived`。

```http
GET    /api/decisions
POST   /api/decisions
GET    /api/decisions/:id
PATCH  /api/decisions/:id
POST   /api/decisions/:id/propose
POST   /api/decisions/:id/accept
POST   /api/decisions/:id/supersede
POST   /api/decisions/:id/reverse
POST   /api/decisions/:id/archive
POST   /api/decisions/:id/review
GET    /api/decisions/:id/versions
GET    /api/decisions/:id/compare
```

## 6.6 Work Items

拥有对象：`Work Item`。页面重点是可执行定义、完成标准、readiness、依赖和执行尝试摘要。

生命周期：`Backlog`、`Ready`、`In Progress`、`Blocked`、`In Review`、`Done`、`Canceled`。

```http
GET    /api/work-items
POST   /api/work-items
GET    /api/work-items/:id
PATCH  /api/work-items/:id
POST   /api/work-items/:id/mark-ready
POST   /api/work-items/:id/start
POST   /api/work-items/:id/block
POST   /api/work-items/:id/resolve-blocker
POST   /api/work-items/:id/send-to-review
POST   /api/work-items/:id/complete
POST   /api/work-items/:id/reopen
POST   /api/work-items/:id/cancel
GET    /api/work-items/:id/readiness
GET    /api/work-items/:id/dependencies
GET    /api/work-items/:id/attempts
```

Session 只作为 execution attempt reference 出现；Work Item 不嵌入 runtime trace。

## 6.7 Context

主要拥有对象：`Context Source`。关联对象为不可变 `Evidence Snapshot` 和明确标记为派生内容的 `Context Item`。

```http
GET    /api/context-sources
POST   /api/context-sources
GET    /api/context-sources/:id
PATCH  /api/context-sources/:id
POST   /api/context-sources/:id/test-connection
POST   /api/context-sources/:id/sync
POST   /api/context-sources/:id/enable
POST   /api/context-sources/:id/disable
POST   /api/context-sources/:id/archive
GET    /api/context-sources/:id/sync-history
GET    /api/context-sources/:id/snapshots
GET    /api/context-sources/:id/context-items
GET    /api/context-sources/:id/usage-counts
GET    /api/evidence-snapshots/:id
GET    /api/evidence-snapshots/:id/compare/:otherSnapshotId
POST   /api/evidence-snapshots/:id/verify
GET    /api/context-items/:id
PATCH  /api/context-items/:id
GET    /api/context-items/:id/versions
POST   /api/context-items/:id/versions
POST   /api/context-items/:id/archive
```

Evidence Snapshot 不提供编辑和删除接口。`verify` 是对快照的治理动作，不改变快照内容。

Context 页面不得使用 knowledge graph、graph nodes、triples 等作为主产品概念；界面使用 `Context Source`、`Evidence Snapshot`、`Context Item`、`Derived` 和 `Provenance`。

## 6.8 Rules

拥有对象：`Rule`。页面重点是结构化条件、效果、作用范围、优先级、验证、冲突分析和版本历史。

支持的 enforcement mode：`Advisory`、`Warning`、`Require Review`、`Block`。

```http
GET    /api/rules
POST   /api/rules
GET    /api/rules/:id
PATCH  /api/rules/:id
POST   /api/rules/:id/validate
POST   /api/rules/:id/activate
POST   /api/rules/:id/disable
POST   /api/rules/:id/archive
POST   /api/rules/:id/restore
POST   /api/rules/:id/new-version
GET    /api/rules/:id/conflicts
GET    /api/rules/:id/usage
GET    /api/rules/:id/evaluations
POST   /api/rules/:id/test
GET    /api/rules/:id/versions
GET    /api/rules/:id/compare
GET    /api/rules/:id/audit-log
POST   /api/rules/validate-all
```

规则编辑使用 condition builder 和只读 expression preview，不使用对话式规则输入，也不使用全屏代码编辑器。无效规则或存在未解决优先级冲突的规则不能 activate。

## 6.9 Settings

拥有对象：本地 ContextOS 运行与用户偏好设置。Settings 是一个页面，不拆分 tabs，不拆分子页面。

页面分为三个垂直区段：

### General

- Launch at startup：开机自启动 toggle
- Start minimized：启动时最小化 toggle
- Confirm destructive actions：危险操作确认 toggle，默认开启
- Local endpoint：只读显示 `127.0.0.1:4721`
- Daemon status：运行、停止、异常及重试入口

### Agents & Context

- Agent adapters：显示已连接数量和可用 adapter 数量
- 默认 Agent adapter
- 自动加载 Context toggle
- 会话结束时生成 Resume Capsule toggle
- Context refresh behavior：manual / on session start / scheduled
- Context package size limit：数字输入或 stepper

### Storage & Privacy

- Local data directory：只读或通过系统选择器修改
- Evidence retention：保留策略选择
- Derived context retention：保留策略选择
- Telemetry：本地 telemetry 开关及说明
- Clear local cache：需要二次确认
- Export local data：导出操作

设置页只显示：`1 connected · 2 adapters available`、`3 agent adapters` 等准确产品文案。不得显示 REST API、`/api/settings`、`knowledge graph`、`triples` 等实现术语。

```http
GET   /api/settings
PATCH /api/settings
POST  /api/settings/test-daemon
POST  /api/settings/clear-cache
POST  /api/settings/export
```

```ts
type Settings = ResourceMeta & {
  launchAtStartup: boolean;
  startMinimized: boolean;
  confirmDestructiveActions: boolean;
  localEndpoint: string;
  daemon: { status: 'RUNNING' | 'STOPPED' | 'ERROR'; version: string };
  agentAdapters: {
    connectedIds: string[];
    availableIds: string[];
    defaultId: string | null;
  };
  context: {
    autoLoad: boolean;
    generateResumeCapsule: boolean;
    refresh: 'MANUAL' | 'SESSION_START' | 'SCHEDULED';
    packageSizeLimit: number;
  };
  privacy: {
    dataDirectory: string;
    evidenceRetention: 'UNTIL_ARCHIVED' | 'DAYS_30' | 'DAYS_90' | 'FOREVER';
    derivedRetention: 'DAYS_30' | 'DAYS_90' | 'FOREVER';
    telemetry: boolean;
  };
};
```

## 7. 前端状态管理

### 7.1 服务端状态

按资源缓存：`overview`、`projects`、`sessions`、`review-items`、`decisions`、`work-items`、`context-sources`、`rules`、`settings`。缓存 key 必须包含 project、筛选、排序、cursor 和 selected ID 等影响结果的参数。

### 7.2 本地 UI 状态

- 当前页面和选中 ID：URL
- 筛选和排序：URL query
- 表单草稿：组件或页面级状态
- 对话框、toast、展开区：UI 状态
- 未保存草稿不得写入服务端缓存

### 7.3 更新与失效

创建、编辑、生命周期动作成功后：

1. 使用响应替换当前资源
2. 失效当前对象列表
3. 失效 linked counts 和 Overview（若受影响）
4. 保留 Activity、Version History 和 Audit Log 的服务端顺序

## 8. 权限、证据和并发

- 后端返回 `readOnly` 或 capability 信息时，前端以 capability 为准隐藏/禁用操作
- 证据快照和原始对话永远只读
- 派生内容必须显示来源、生成时间和版本
- 编辑前保存对象 `revision`
- `PATCH` 失败为冲突时保留用户输入，不直接覆盖
- 用户确认后的生命周期动作必须带 actor context、request ID 和 idempotency key
- 具有破坏性的操作需要明确确认，清空缓存和导出也应显示结果状态

## 9. 视觉复核项

以下项目不改变 API 契约，只在 Figma 下一次有额度时完成视觉清理：

- 从正式页面中隐藏开发者 API footer：REST interface、`GET /api`、`POST /api`、`PATCH /api`、API ready、Contract dependency
- Settings 文案统一为 `1 connected · 2 adapters available`、`3 agent adapters`、`Storage & Privacy`
- 检查所有正式页的 1440 x 1024、244px sidebar、64px header 是否一致
- 保持白色 Sidebar/Header、冷白色工作区、细边框和紧凑表格
- 保留证据、版本、验证、冲突和审计区域，不因清理 API 文案而删除产品能力
- 原始 Stitch 导入画板继续保留；正式候选画板使用复制后的 01-09 页面

## 10. 前端验收标准

- 9 个正式页面共享同一 Shell、导航、字体、尺寸和状态语言
- 每个页面的拥有对象清晰，跨模块内容只以引用、计数或链接显示
- Settings 是单页面，包含开机自启动、Agent adapters、Context 和 Storage & Privacy
- 所有列表支持 loading、empty、no results、read-only、error 和 conflict 状态
- 所有危险操作都有确认和失败反馈
- API 错误可根据 code 转换为稳定的界面行为
- 写请求具备 revision 检查和幂等重试能力
- Evidence Snapshot 无编辑、无删除；Derived Context Item 有明确 provenance
- Lifecycle 通过显式动作接口完成，不能靠任意 status patch 绕过治理
- 页面不出现 REST footer、数据库实现细节、knowledge graph 或 triples 等内部术语
- 1440 x 1024 桌面参考下无文字截断、重叠、布局跳动或不稳定列宽

## 11. 下一阶段后端对齐输入

后端设计应以本文的资源边界和动作接口为输入，下一步单独确定：

- 各资源的持久化模型和外键关系
- revision、幂等 key 和并发冲突的服务端实现
- 证据快照不可变约束
- 派生内容版本和 provenance 存储
- 生命周期动作的事务边界和审计事件
- daemon、Agent adapter、同步和导出的任务执行方式

后端不得为了方便数据库建模而把多个页面对象合并成一个前端资源，也不得将内部表名直接暴露为 API 字段。
