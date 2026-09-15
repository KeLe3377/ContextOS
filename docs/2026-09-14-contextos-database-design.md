# ContextOS SQLite 数据库详细设计

状态：数据库与持久化设计基线
日期：2026-09-14
范围：第一阶段单机单用户 daemon
方案：SQLite + better-sqlite3 + Drizzle ORM + Drizzle migrations

本文承接后端整体架构设计，定义结构化数据、文件证据、索引、事务、并发、幂等和 migration。它不锁定最终 ORM 代码组织，但 Repository 实现不得违反本文不变量。

## 1. 数据分层

SQLite 是结构化状态的唯一权威来源，保存资源元数据、生命周期、revision、引用关系、Job、lease、attempt、Activity、Audit、Outbox、Rule evaluation、设置和 adapter 健康摘要。

Evidence Store 保存大内容：原始 Agent transcript、工具 payload、Evidence Snapshot 内容、派生 artifact 和导出文件。SQLite 只保存 `storageRef`、hash、大小、来源、版本和治理状态。前端永远不直接访问 SQLite 或 Evidence Store。

## 2. 数据目录和全局约定

```text
<data-dir>/
  contextos.sqlite
  evidence/<project-id>/<snapshot-id>.jsonl
  evidence/<project-id>/<snapshot-id>.meta.json
  artifacts/<project-id>/<artifact-id>
  exports/  logs/  locks/
```

- 所有 ID 使用后端生成的 opaque string，推荐 UUID v7 或等价的时间有序 ID。
- 数据库时间统一为 epoch milliseconds，API 层转换为 ISO 8601 UTC。
- 可变资源包含 id、created_at、updated_at、revision；状态资源额外包含 status 和 archived_at。
- JSON 字段必须有 runtime schema 和 schema version，不能把关系数据整体塞入 JSON。
- 用户输入只能作为 metadata，不能作为文件路径片段。

## 3. 关系总览

```text
projects
  ├── sessions ── session_runs
  │       └── context_packages
  ├── review_items
  ├── decisions ── decision_versions
  ├── work_items ── dependencies / attempts
  ├── context_sources ── evidence_snapshots
  ├── context_items ── context_item_versions
  ├── rules ── rule_versions ── conflicts / evaluations
  ├── activity_events / audit_events
  └── jobs ── job_attempts
```

跨模块关系使用 ID 或专用 reference，不复制完整实体作为唯一来源。

## 4. 核心业务表

### 4.1 projects

```text
id                  TEXT PRIMARY KEY
name                TEXT NOT NULL
description         TEXT NULL
root_path           TEXT NOT NULL
root_path_hash      TEXT NOT NULL
status              TEXT NOT NULL -- ACTIVE | PAUSED | ARCHIVED
default_rule_ids    TEXT NOT NULL -- versioned JSON array
agent_adapter_ids   TEXT NOT NULL -- versioned JSON array
created_at          INTEGER NOT NULL
updated_at          INTEGER NOT NULL
revision            INTEGER NOT NULL DEFAULT 1
archived_at         INTEGER NULL
```

`root_path` 必须是规范化真实路径。Project archive 不级联删除 Session、Evidence、Decision 或 Audit。索引：status、root_path_hash、updated_at。

### 4.2 sessions 和 session_runs

```text
sessions
  id                   TEXT PRIMARY KEY
  project_id           TEXT NOT NULL REFERENCES projects(id)
  agent_adapter_id     TEXT NOT NULL
  external_session_id  TEXT NULL
  title                TEXT NULL
  intent               TEXT NULL
  status               TEXT NOT NULL
  runtime_state        TEXT NOT NULL -- versioned JSON
  context_package_id   TEXT NULL
  resume_capsule_id    TEXT NULL
  started_at           INTEGER NULL
  completed_at         INTEGER NULL
  last_activity_at     INTEGER NULL
  created_at           INTEGER NOT NULL
  updated_at           INTEGER NOT NULL
  revision             INTEGER NOT NULL DEFAULT 1
  archived_at          INTEGER NULL

session_runs
  id                 TEXT PRIMARY KEY
  session_id         TEXT NOT NULL REFERENCES sessions(id)
  job_id             TEXT NULL REFERENCES jobs(id)
  external_run_id    TEXT NULL
  status             TEXT NOT NULL
  pid                INTEGER NULL
  started_at         INTEGER NULL
  ended_at           INTEGER NULL
  exit_code          INTEGER NULL
  failure_code       TEXT NULL
  failure_message    TEXT NULL
  adapter_version    TEXT NOT NULL
  created_at         INTEGER NOT NULL
  updated_at         INTEGER NOT NULL
  revision            INTEGER NOT NULL DEFAULT 1
```

`external_session_id` 的唯一性限定在 adapter 范围。索引：sessions 的 project_id + updated_at、project_id + status；runs 的 session_id + created_at、status。

### 4.3 review_items

```text
id                   TEXT PRIMARY KEY
project_id           TEXT NOT NULL REFERENCES projects(id)
source_type          TEXT NOT NULL
source_id            TEXT NOT NULL
trigger_type         TEXT NOT NULL
status               TEXT NOT NULL -- OPEN | IN_PROGRESS | RESOLVED | DISMISSED
priority             TEXT NOT NULL
summary              TEXT NOT NULL
evidence_delta_ref   TEXT NULL
proposed_resolution  TEXT NULL
reviewer_id          TEXT NULL
resolution_type      TEXT NULL
resolution_reason    TEXT NULL
due_at               INTEGER NULL
created_at           INTEGER NOT NULL
updated_at           INTEGER NOT NULL
resolved_at          INTEGER NULL
revision             INTEGER NOT NULL DEFAULT 1
```

`source_type + source_id` 是多态 reference，由 Application Service 验证来源。索引：project_id + status + priority、source_type + source_id。

### 4.4 decisions 和 decision_versions

```text
decisions
  id                 TEXT PRIMARY KEY
  project_id         TEXT NOT NULL REFERENCES projects(id)
  current_version_id TEXT NULL
  status             TEXT NOT NULL
  title              TEXT NOT NULL
  created_at         INTEGER NOT NULL
  updated_at         INTEGER NOT NULL
  revision           INTEGER NOT NULL DEFAULT 1
  archived_at        INTEGER NULL

decision_versions
  id                    TEXT PRIMARY KEY
  decision_id           TEXT NOT NULL REFERENCES decisions(id)
  version_number        INTEGER NOT NULL
  state                 TEXT NOT NULL
  statement             TEXT NOT NULL
  problem_context       TEXT NULL
  rationale             TEXT NOT NULL
  alternatives_json     TEXT NOT NULL
  consequences          TEXT NULL
  references_json       TEXT NOT NULL
  content_hash          TEXT NOT NULL
  created_by_type       TEXT NOT NULL
  created_by_id         TEXT NULL
  created_at            INTEGER NOT NULL
  accepted_at           INTEGER NULL
  supersedes_version_id TEXT NULL REFERENCES decision_versions(id)
  reverses_version_id   TEXT NULL REFERENCES decision_versions(id)
```

唯一约束为 decision_id + version_number。Accepted version 内容不可 UPDATE；重大变化必须产生新版本。

### 4.5 work_items、dependencies、attempts

```text
work_items
  id                 TEXT PRIMARY KEY
  project_id         TEXT NOT NULL REFERENCES projects(id)
  parent_id          TEXT NULL REFERENCES work_items(id)
  title              TEXT NOT NULL
  description        TEXT NULL
  status             TEXT NOT NULL
  assignee_type      TEXT NULL
  assignee_id        TEXT NULL
  acceptance_json    TEXT NOT NULL
  execution_contract TEXT NULL
  readiness_state    TEXT NOT NULL
  scheduled_at       INTEGER NULL
  completed_at       INTEGER NULL
  created_at         INTEGER NOT NULL
  updated_at         INTEGER NOT NULL
  revision           INTEGER NOT NULL DEFAULT 1

work_item_dependencies
  work_item_id       TEXT NOT NULL REFERENCES work_items(id)
  depends_on_id      TEXT NOT NULL REFERENCES work_items(id)
  dependency_type    TEXT NOT NULL
  created_at         INTEGER NOT NULL
  PRIMARY KEY (work_item_id, depends_on_id)

work_item_attempts
  id                 TEXT PRIMARY KEY
  work_item_id       TEXT NOT NULL REFERENCES work_items(id)
  session_id         TEXT NULL REFERENCES sessions(id)
  status             TEXT NOT NULL
  summary            TEXT NULL
  result_ref         TEXT NULL
  started_at         INTEGER NULL
  ended_at           INTEGER NULL
  created_at         INTEGER NOT NULL
```

禁止自依赖；Application Service 必须检测新增依赖造成的环。Work Item 只保存尝试摘要，运行时细节属于 Session/Evidence。

## 5. Context 和 Evidence

### 5.1 context_sources

```text
id                 TEXT PRIMARY KEY
project_id         TEXT NOT NULL REFERENCES projects(id)
source_type        TEXT NOT NULL
display_name       TEXT NOT NULL
locator            TEXT NOT NULL
scope_json         TEXT NOT NULL
status             TEXT NOT NULL -- ACTIVE | DISABLED | ARCHIVED | ERROR
freshness_state    TEXT NOT NULL
last_synced_at     INTEGER NULL
last_error_code    TEXT NULL
last_error_message TEXT NULL
created_at         INTEGER NOT NULL
updated_at         INTEGER NOT NULL
revision           INTEGER NOT NULL DEFAULT 1
archived_at        INTEGER NULL
```

`locator` 必须由 source adapter 规范化并通过路径安全检查。

### 5.2 evidence_snapshots

```text
id                 TEXT PRIMARY KEY
project_id         TEXT NOT NULL REFERENCES projects(id)
session_id         TEXT NULL REFERENCES sessions(id)
context_source_id  TEXT NULL REFERENCES context_sources(id)
source_type        TEXT NOT NULL
source_locator     TEXT NOT NULL
captured_at        INTEGER NOT NULL
content_hash       TEXT NOT NULL
storage_ref        TEXT NOT NULL UNIQUE
byte_size          INTEGER NOT NULL
content_type       TEXT NOT NULL
parser_version     TEXT NOT NULL
metadata_json      TEXT NOT NULL
verification_state TEXT NOT NULL -- UNVERIFIED | VERIFIED | REJECTED
created_at         INTEGER NOT NULL
```

这是 append-only 表：创建后不允许修改内容字段，不允许普通 DELETE。至少一个 session_id 或 context_source_id 必须存在。索引：project_id + captured_at、session_id + captured_at、context_source_id + captured_at、content_hash。

### 5.3 context_items、versions、packages

```text
context_items
  id                 TEXT PRIMARY KEY
  project_id         TEXT NOT NULL REFERENCES projects(id)
  current_version_id TEXT NULL
  item_type          TEXT NOT NULL
  status             TEXT NOT NULL
  derived            INTEGER NOT NULL DEFAULT 1
  created_at         INTEGER NOT NULL
  updated_at         INTEGER NOT NULL
  revision           INTEGER NOT NULL DEFAULT 1

context_item_versions
  id                  TEXT PRIMARY KEY
  context_item_id     TEXT NOT NULL REFERENCES context_items(id)
  version_number      INTEGER NOT NULL
  content_ref         TEXT NOT NULL
  content_hash        TEXT NOT NULL
  source_snapshot_ids TEXT NOT NULL
  derived_item_ids    TEXT NOT NULL
  derivation_method   TEXT NOT NULL
  derivation_version  TEXT NOT NULL
  generated_at        INTEGER NOT NULL
  created_by_type     TEXT NOT NULL
  created_by_id       TEXT NULL

context_packages
  id                   TEXT PRIMARY KEY
  project_id           TEXT NOT NULL REFERENCES projects(id)
  session_id           TEXT NOT NULL REFERENCES sessions(id)
  schema_version       TEXT NOT NULL
  manifest_json         TEXT NOT NULL
  selection_reason_json TEXT NOT NULL
  content_ref          TEXT NOT NULL
  content_hash         TEXT NOT NULL
  byte_size             INTEGER NOT NULL
  truncated             INTEGER NOT NULL DEFAULT 0
  created_at            INTEGER NOT NULL
```

Context Item version 必须有 provenance；旧 Package 永远指向当时版本，不能随当前 Context 自动漂移。

## 6. Rules 和评估

```text
rules
  id                  TEXT PRIMARY KEY
  project_id          TEXT NOT NULL REFERENCES projects(id)
  current_version_id  TEXT NULL
  title               TEXT NOT NULL
  status              TEXT NOT NULL -- DRAFT | ACTIVE | DISABLED | ARCHIVED
  created_at          INTEGER NOT NULL
  updated_at          INTEGER NOT NULL
  revision            INTEGER NOT NULL DEFAULT 1

rule_versions
  id                  TEXT PRIMARY KEY
  rule_id             TEXT NOT NULL REFERENCES rules(id)
  version_number      INTEGER NOT NULL
  scope_json          TEXT NOT NULL
  conditions_json     TEXT NOT NULL
  effect_json         TEXT NOT NULL
  enforcement_mode    TEXT NOT NULL
  precedence          INTEGER NOT NULL
  exceptions_json     TEXT NOT NULL
  validation_state    TEXT NOT NULL -- UNKNOWN | VALID | INVALID
  validation_errors   TEXT NOT NULL
  content_hash        TEXT NOT NULL
  created_at          INTEGER NOT NULL
  activated_at        INTEGER NULL

rule_conflicts
  id                  TEXT PRIMARY KEY
  project_id          TEXT NOT NULL REFERENCES projects(id)
  rule_version_a      TEXT NOT NULL REFERENCES rule_versions(id)
  rule_version_b      TEXT NOT NULL REFERENCES rule_versions(id)
  conflict_type       TEXT NOT NULL
  status              TEXT NOT NULL -- OPEN | RESOLVED | IGNORED
  resolution_reason   TEXT NULL
  detected_at         INTEGER NOT NULL
  resolved_at         INTEGER NULL

rule_evaluations
  id                  TEXT PRIMARY KEY
  project_id          TEXT NOT NULL REFERENCES projects(id)
  rule_version_id     TEXT NOT NULL REFERENCES rule_versions(id)
  session_id          TEXT NULL REFERENCES sessions(id)
  source_event_ref    TEXT NOT NULL
  input_hash          TEXT NOT NULL
  result              TEXT NOT NULL
  explanation_json    TEXT NOT NULL
  evaluator_version   TEXT NOT NULL
  created_at          INTEGER NOT NULL
```

Rule 只有在 validation 为 VALID 且无未解决冲突时才能激活。Conflict 的两个版本 ID 按排序规范化，避免重复。

## 7. Runtime、Settings 和记录表

```text
settings
  id                          TEXT PRIMARY KEY -- singleton
  launch_at_startup           INTEGER NOT NULL
  start_minimized             INTEGER NOT NULL
  confirm_destructive_actions INTEGER NOT NULL
  local_endpoint              TEXT NOT NULL
  default_adapter_id          TEXT NULL
  context_config_json         TEXT NOT NULL
  privacy_config_json         TEXT NOT NULL
  data_directory              TEXT NOT NULL
  created_at                  INTEGER NOT NULL
  updated_at                  INTEGER NOT NULL
  revision                    INTEGER NOT NULL DEFAULT 1

agent_adapters
  id                  TEXT PRIMARY KEY
  display_name        TEXT NOT NULL
  implementation      TEXT NOT NULL
  adapter_version     TEXT NOT NULL
  enabled             INTEGER NOT NULL
  capabilities_json   TEXT NOT NULL
  last_checked_at     INTEGER NULL
  last_error_code     TEXT NULL
  last_error_message  TEXT NULL
  created_at          INTEGER NOT NULL
  updated_at          INTEGER NOT NULL
```

第一阶段 endpoint 固定为 `127.0.0.1:4721`。影响端口、数据目录、开机自启动或进程策略的设置更新返回 `requiresRestart`。

```text
jobs
  id                 TEXT PRIMARY KEY
  type               TEXT NOT NULL
  project_id         TEXT NULL REFERENCES projects(id)
  resource_type      TEXT NULL
  resource_id        TEXT NULL
  payload_json       TEXT NOT NULL
  payload_version    TEXT NOT NULL
  status              TEXT NOT NULL
  attempt             INTEGER NOT NULL DEFAULT 0
  max_attempts        INTEGER NOT NULL
  available_at        INTEGER NOT NULL
  lease_owner         TEXT NULL
  lease_expires_at    INTEGER NULL
  last_error_code     TEXT NULL
  last_error_message  TEXT NULL
  created_at          INTEGER NOT NULL
  updated_at          INTEGER NOT NULL
  revision            INTEGER NOT NULL DEFAULT 1
```

Job 状态为 QUEUED、RUNNING、SUCCEEDED、FAILED、RETRY_WAIT 或 CANCELED。attempt 记录 worker、时间和错误；lease 过期后可重新领取。

Activity、Audit、Outbox 和幂等表分别保存前端时间线、治理记录、可靠投递和请求去重。Audit/Outbox append-only；同一幂等 key 的 request hash 相同则返回第一次结果，不同则 CONFLICT。

## 8. 外键、删除和 SQLite 参数

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA temp_store = MEMORY;
```

删除默认使用 RESTRICT：Project、Session、Decision、Rule、Context Item 使用归档或 supersede；Evidence Snapshot 第一阶段禁止 DELETE；Audit 禁止 DELETE；Activity、成功 Job、过期 idempotency key 可按 retention 清理。

## 9. 事务和一致性协议

所有更新使用 `id + expectedRevision`，成功后 revision 加 1。资源更新、Audit、Activity 和必要 Outbox 必须同一 transaction；影响行数为 0 时回滚并返回 CONFLICT。

Evidence 写入顺序为：临时文件 -> hash/size -> flush/fsync -> 原子 rename -> SQLite metadata/Audit/Outbox -> commit。启动恢复器检查临时文件、孤儿文件和 active metadata 引用。

Continue Session 的 HTTP transaction 只创建 Context Package、Session Run、Job、runtime state 和记录；Agent 执行不持有 SQLite 长事务。

## 10. Migration 和 Drizzle 规则

```text
0001_base: projects, settings, agent_adapters
0002_sessions: sessions, session_runs
0003_governance: review_items, decisions, work_items and relations
0004_context: context_sources, evidence, context_items, packages
0005_rules: rules, versions, conflicts, evaluations
0006_runtime: jobs, attempts, activity, audit, outbox, idempotency
0007_indexes: compound indexes and final constraints
```

- migration 文件提交到 Git；启动时只执行已提交 migration
- 不使用自动 schema push，不静默重建数据库
- 每个 migration 有失败回滚和 schema version 测试
- Drizzle schema 只描述 persistence schema，不直接充当 Domain entity
- JSON 读写经过 runtime schema 校验
- Repository 是 Application 唯一的数据访问入口

## 11. 启动恢复、安全和测试

启动顺序：data-dir lock -> SQLite/pragmas -> migrations -> evidence recovery -> expired lease recovery -> orphan RUNNING run handling -> pending outbox replay -> adapter registry -> scheduler -> HTTP listener。

Project root 使用 realpath、allowlist 和符号链接逃逸检查；子进程使用 argv，不拼接 shell 字符串；adapter 只能读取声明范围内的 transcript；日志不写 API key、完整 transcript、prompt 或工具 payload。

测试必须覆盖：空库 migration、历史版本升级、外键和约束、Repository CRUD/分页/revision、事务回滚、版本不可覆盖、Evidence provenance、Rule activation、依赖环、Evidence 崩溃恢复、Job lease、outbox 重发、daemon 重启、Agent 退出和幂等请求。

## 12. 实现顺序和验收标准

1. daemon bootstrap、data directory lock、Drizzle 配置和 migration runner
2. migration 0001-0003 与 Repository contract
3. Project、Session、Decision、Work Item、Review Item
4. Evidence Store、Context Source、Snapshot、Context Item、Package
5. Rule validation、conflict 和 evaluation persistence
6. Job、Outbox、lease、retry、recovery
7. Claude Code、Codex、Cursor adapter 和 process supervisor
8. API contract、crash/recovery 和证据完整性测试

验收要求：SQLite 管理结构化业务状态；Evidence append-only；Derived Context 有 provenance 和版本；可变资源有 revision；重要动作有 Audit；跨进程事件有 Outbox；长任务有 Job/attempt/lease/recovery；外键开启且删除默认 RESTRICT；Domain 不依赖 Drizzle、SQLite、文件系统或具体 Agent；数据库支持前端的列表、详情、action、版本、比较和审计接口。
