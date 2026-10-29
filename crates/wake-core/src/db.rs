use crate::models::*;
use crate::workspace_changes::{
    WorkspaceChangeDetail, WorkspaceChangeEvent, WorkspaceChangeKind, WorkspaceFileObservation,
    WorkspaceObservationMode, WorkspaceRoot,
};
use anyhow::{Context as _, Result};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub type LocationOverrides = (
    Vec<(AgentId, std::path::PathBuf)>,
    Vec<AgentId>,
    Vec<(AgentId, std::path::PathBuf)>,
);

#[derive(Debug, Clone)]
pub struct SessionRelation {
    pub relation: String,
    pub source: String,
    pub session: SessionMeta,
}

#[derive(Debug, Clone)]
pub struct SessionRelationNode {
    pub depth: usize,
    pub relation: String,
    pub session: SessionMeta,
}

#[derive(Debug, Clone)]
pub struct SessionRelationEdge {
    pub relation: String,
    pub source: String,
    pub parent: SessionMeta,
    pub child: SessionMeta,
}

/// remote_hosts 表的一行(Settings → Remote hosts / roster 组装共用)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteHost {
    pub name: String,
    pub enabled: bool,
    /// epoch ms;None = 从未成功同步过
    pub last_sync_at: Option<i64>,
    pub last_sync_error: Option<String>,
}

const DDL: &str = r#"
CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS sessions (
  key            TEXT PRIMARY KEY,
  agent_id       TEXT NOT NULL,
  native_id      TEXT NOT NULL,
  title          TEXT NOT NULL DEFAULT '',
  project_path   TEXT NOT NULL DEFAULT '',
  project_name   TEXT NOT NULL DEFAULT '',
  git_branch     TEXT,
  created_at     INTEGER DEFAULT 0,
  updated_at     INTEGER DEFAULT 0,
  message_count  INTEGER DEFAULT 0,
  tokens_used    INTEGER,
  model          TEXT,
  source         TEXT,
  archived       INTEGER DEFAULT 0,
  file_path      TEXT NOT NULL UNIQUE,
  file_size      INTEGER DEFAULT 0,
  file_mtime     INTEGER DEFAULT 0,
  unknown_lines  INTEGER DEFAULT 0,
  parent_key     TEXT NOT NULL DEFAULT '',
  host           TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_agent   ON sessions(agent_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_path, updated_at DESC);

-- Agent 用量独立于会话全文索引维护。源日志是唯一事实来源,mtime/size 是
-- 增量同步游标;单独更新用量不需要重新解析 messages_fts。
CREATE TABLE IF NOT EXISTS session_usage (
  file_path   TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  has_usage   INTEGER NOT NULL DEFAULT 1,
  source      TEXT NOT NULL DEFAULT 'adapter-session-source-v1',
  file_mtime  INTEGER NOT NULL DEFAULT 0,
  file_size   INTEGER NOT NULL DEFAULT 0,
  scanned_at  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_session_usage_agent ON session_usage(agent_id);

-- 每个源文件解析出的逐请求 Token 事件。session_usage 仍保存会话级快照供会话视图使用；
-- Insights 按 timestamp_ms 统计，不把会话累计值归到创建日。
CREATE TABLE IF NOT EXISTS session_usage_events (
  file_path    TEXT NOT NULL,
  event_index  INTEGER NOT NULL,
  timestamp_ms INTEGER,
  tokens_used  INTEGER NOT NULL DEFAULT 0,
  model        TEXT,
  PRIMARY KEY (file_path, event_index)
);
CREATE INDEX IF NOT EXISTS idx_session_usage_events_time
  ON session_usage_events(timestamp_ms);

CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY,
  session_key  TEXT NOT NULL,
  sidechain_id TEXT,
  seq          INTEGER NOT NULL,
  role         TEXT, ts INTEGER,
  text         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_key);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text,
  content='messages', content_rowid='id',
  tokenize="trigram case_sensitive 0"
);

CREATE TABLE IF NOT EXISTS user_data (
  session_key TEXT PRIMARY KEY,
  favorite    INTEGER DEFAULT 0,
  pinned      INTEGER DEFAULT 0,
  updated_at  INTEGER
);

CREATE TABLE IF NOT EXISTS session_tags (
  session_key TEXT NOT NULL,
  tag         TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'manual',
  confidence  REAL,
  updated_at  INTEGER,
  PRIMARY KEY (session_key, tag)
);
CREATE INDEX IF NOT EXISTS idx_session_tags_tag ON session_tags(tag, session_key);

CREATE TABLE IF NOT EXISTS session_links (
  parent_session_key TEXT NOT NULL,
  child_session_key  TEXT NOT NULL,
  relation           TEXT NOT NULL DEFAULT 'related',
  source             TEXT NOT NULL DEFAULT 'manual',
  created_at         INTEGER,
  PRIMARY KEY (parent_session_key, child_session_key, relation)
);
CREATE INDEX IF NOT EXISTS idx_session_links_child ON session_links(child_session_key);

CREATE TABLE IF NOT EXISTS tombstones (
  file_path          TEXT PRIMARY KEY,
  key                TEXT,
  deleted_at         INTEGER,
  deleted_file_mtime INTEGER,
  deleted_file_size  INTEGER
);

CREATE TABLE IF NOT EXISTS custom_roots (
  agent    TEXT NOT NULL,
  path     TEXT NOT NULL,
  added_at INTEGER,
  PRIMARY KEY (agent, path)
);

CREATE TABLE IF NOT EXISTS removed_defaults (
  agent      TEXT PRIMARY KEY,
  removed_at INTEGER
);

CREATE TABLE IF NOT EXISTS removed_default_roots (
  agent      TEXT NOT NULL,
  path       TEXT NOT NULL,
  removed_at INTEGER,
  PRIMARY KEY (agent, path)
);

-- 应用级 UI 偏好。与 schema_meta 同形但语义不同:schema_meta 是索引
-- 自身的迁移状态,迁移代码可随意增删;prefs 是用户数据(user_data 同类,
-- 只是不挂在会话上),勿合并两表
CREATE TABLE IF NOT EXISTS prefs (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS disabled_locations (
  agent       TEXT NOT NULL,
  path        TEXT NOT NULL,
  disabled_at INTEGER,
  PRIMARY KEY (agent, path)
);

CREATE TABLE IF NOT EXISTS skill_project_roots (
  path     TEXT PRIMARY KEY,
  added_at INTEGER
);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  config_json TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_server_clients (
  server_id TEXT NOT NULL,
  agent_id  TEXT NOT NULL,
  enabled   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (server_id, agent_id),
  FOREIGN KEY (server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS remote_hosts (
  name            TEXT PRIMARY KEY,
  enabled         INTEGER DEFAULT 1,
  added_at        INTEGER,
  last_sync_at    INTEGER,
  last_sync_error TEXT
);

-- 标题的全文索引。独立一张表而不挂在 messages 上:标题不是转录消息、没有 seq
-- 可对,塞成假消息会破坏 seq 契约。key 不索引、只用来回查/删除
CREATE VIRTUAL TABLE IF NOT EXISTS titles_fts USING fts5(
  key UNINDEXED,
  title,
  tokenize="trigram case_sensitive 0"
);

-- agent 自己写下的记忆(Claude Code auto-memory、Codex memories)的只读镜像:
-- 扫描收尾按 (agent, host) 整组替换(2026-09-17)。正文一并入库(小 Markdown),
-- 搜索走 memories_fts(rowid = memories.id,删改按 rowid 定位——FTS 表里
-- UNINDEXED 列的 WHERE 是整表扫描,正文列在里面扫不起);阅读时文件型先读
-- 磁盘、读不到再用这份。project_path 多半为空,读时按 session_key 连 sessions 解析
CREATE TABLE IF NOT EXISTS memories (
  id           INTEGER PRIMARY KEY,
  key          TEXT NOT NULL UNIQUE,
  agent_id     TEXT NOT NULL,
  host         TEXT NOT NULL DEFAULT '',
  scope        TEXT NOT NULL,
  project_path TEXT NOT NULL DEFAULT '',
  project_name TEXT NOT NULL DEFAULT '',
  session_key  TEXT NOT NULL DEFAULT '',
  path         TEXT NOT NULL,
  title        TEXT NOT NULL DEFAULT '',
  updated_at   INTEGER DEFAULT 0,
  size_bytes   INTEGER DEFAULT 0,
  source       TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_memories_group ON memories(agent_id, host);
CREATE TABLE IF NOT EXISTS memory_sources_custom (
  agent    TEXT NOT NULL,
  path     TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (agent, path)
);
CREATE TABLE IF NOT EXISTS memory_sources_disabled (
  agent       TEXT NOT NULL,
  source      TEXT NOT NULL,
  disabled_at INTEGER NOT NULL,
  PRIMARY KEY (agent, source)
);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  title,
  body,
  tokenize="trigram case_sensitive 0"
);

-- ContextOS 自有压缩 Markdown 的派生全文索引。文件仍是真实来源；这里保存
-- 可重建镜像，以便 GUI/MCP/CLI 共用 BM25、snippet 和关系扩展。
CREATE TABLE IF NOT EXISTS compression_documents (
  id           INTEGER PRIMARY KEY,
  path         TEXT NOT NULL UNIQUE,
  root_path    TEXT NOT NULL,
  scope        TEXT NOT NULL,
  project_path TEXT NOT NULL DEFAULT '',
  title        TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL DEFAULT '',
  sources      TEXT NOT NULL DEFAULT '[]',
  modified_at  INTEGER NOT NULL DEFAULT 0,
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  indexed_at   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_compression_documents_root
  ON compression_documents(root_path, modified_at DESC);
CREATE TABLE IF NOT EXISTS compression_document_sources (
  document_id INTEGER NOT NULL,
  session_key TEXT NOT NULL,
  PRIMARY KEY (document_id, session_key)
);
CREATE INDEX IF NOT EXISTS idx_compression_document_sources_session
  ON compression_document_sources(session_key, document_id);
CREATE VIRTUAL TABLE IF NOT EXISTS compression_documents_fts USING fts5(
  path,
  title,
  body,
  sources,
  tokenize="trigram case_sensitive 0"
);

-- agent 查 Wake 的每一次调用(解析时从工具调用里认出,2026-09-17)。与 messages
-- 同一事务写、同 key 删;channel = mcp | cli,tool = MCP 工具名或命令行二进制名,
-- ts = 所在消息的时间(缺则 NULL,归窗时退回会话 updated_at)。老库首开由
-- FTS_FORMAT 换代的全量重解析回填
CREATE TABLE IF NOT EXISTS wake_lookups (
  session_key TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  ts          INTEGER,
  channel     TEXT NOT NULL,
  tool        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wake_lookups_session ON wake_lookups(session_key);
"#;

const WORKSPACE_TEXT_SNAPSHOT_LIMIT: usize = 1024 * 1024;
const INDEX_WAL_CHECKPOINT_THRESHOLD: u64 = 8 * 1024 * 1024;
const INDEX_WAL_VACUUM_THRESHOLD: u64 = 64 * 1024 * 1024;

/// 会话元数据和 FTS 单元的派生规则版本(`adapters::units_from_messages` 及其上游解析)。改了派生
/// 规则就换个值:旧库首开时挂 fts_reindex 旗子,下一轮扫描强制重解析全部文件。
/// "1" = 2026-09-14 前(工具段不过滤 Wake 自指),"2" = 过滤自指回声,
/// "3" = Pi / omp / OpenClaw 累计每次 assistant 调用的 token,
/// "4" = Cursor 项目路径优先读取工作区元数据,并恢复 slug 中的空格,
/// "5" / "6" = 未发布分支各自用过的中间态(#42 用过 5;meter-handoff 用过 6:同一派生里
///       记下 agent 查 Wake 的每次调用,落 wake_lookups 表,老库靠这轮重解析回填),
/// "7" = 三条分支合到 main 时对齐(2026-09-21/22):Codex spawn_agent 子线程折叠、
///       wake_lookups、记忆层一起回填——开发库可能戳着 5 或 6,换代判据是精确不等,
///       两个都跳过。
pub const FTS_FORMAT: &str = "7";

fn open_conn(path: &Path) -> Result<Connection> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.busy_timeout(std::time::Duration::from_millis(3000))?;
    let sessions_existed: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions')",
        [],
        |row| row.get(0),
    )?;
    conn.execute_batch(DDL)
        .context("failed to initialize SQLite schema")?;
    conn.execute_batch(
        "DROP TABLE IF EXISTS workspace_change_session_links;
         DROP TABLE IF EXISTS workspace_change_events;
         DROP TABLE IF EXISTS workspace_file_state;
         DROP TABLE IF EXISTS workspace_file_snapshots;
         DROP TABLE IF EXISTS workspace_roots;",
    )?;
    if !table_has_column(&conn, "session_usage", "source")? {
        conn.execute(
            "ALTER TABLE session_usage ADD COLUMN source TEXT NOT NULL DEFAULT 'legacy-session-usage'",
            [],
        )?;
    }
    if !table_has_column(&conn, "session_usage", "has_usage")? {
        conn.execute(
            "ALTER TABLE session_usage ADD COLUMN has_usage INTEGER NOT NULL DEFAULT 1",
            [],
        )?;
    }
    // tombstones.key 迁移(2026-08-24 加列,老库无此列;重复加列报错即忽略):
    // 墓碑按逻辑会话(key)+物理路径双轨屏蔽,多 location 副本不得复活已删会话
    let _ = conn.execute("ALTER TABLE tombstones ADD COLUMN key TEXT", []);
    if !table_has_column(&conn, "tombstones", "deleted_file_mtime")? {
        conn.execute(
            "ALTER TABLE tombstones ADD COLUMN deleted_file_mtime INTEGER",
            [],
        )?;
    }
    if !table_has_column(&conn, "tombstones", "deleted_file_size")? {
        conn.execute(
            "ALTER TABLE tombstones ADD COLUMN deleted_file_size INTEGER",
            [],
        )?;
    }
    if !table_has_column(&conn, "sessions", "parent_key")? {
        let tx = conn.transaction()?;
        tx.execute(
            "ALTER TABLE sessions ADD COLUMN parent_key TEXT NOT NULL DEFAULT ''",
            [],
        )?;
        // 只有从旧 schema 升级时才需要强制重解析 Grok；新库第一次增量扫描
        // 本来就会解析全部文件，不应额外记一个永久升级状态。
        if sessions_existed {
            tx.execute(
                "INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('grok_parent_backfill', '1')",
                [],
            )?;
        }
        tx.commit()?;
    }
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_key)",
        [],
    )?;
    // FTS 派生规则换代:库里记的版本与 FTS_FORMAT 不一致且已有会话 → 挂 fts_reindex
    // 旗子,下一轮扫描把全部文件重解析一遍(增量按 mtime/size 跳过的也重来),否则
    // 旧行会按旧规则一直留着,直到用户手动全量刷新(Codex review 2026-09-14)
    let stored_format: Option<String> = conn
        .query_row(
            "SELECT value FROM schema_meta WHERE key = 'fts_format'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if stored_format.as_deref() != Some(FTS_FORMAT) {
        if sessions_existed {
            conn.execute(
                "INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('fts_reindex', '1')",
                [],
            )?;
        }
        conn.execute(
            "INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('fts_format', ?1)",
            params![FTS_FORMAT],
        )?;
    }
    // Existing transcripts need one pass to populate the independent session
    // change history without rewriting indexed session bodies.
    let session_change_format: Option<String> = conn
        .query_row(
            "SELECT value FROM schema_meta WHERE key = 'session_file_change_format'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if session_change_format.as_deref() != Some("1") {
        let has_sessions: bool =
            conn.query_row("SELECT EXISTS(SELECT 1 FROM sessions)", [], |r| r.get(0))?;
        if sessions_existed && has_sessions {
            conn.execute(
                "INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('session_file_change_backfill', '1')",
                [],
            )?;
        }
        conn.execute(
            "INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('session_file_change_format', '1')",
            [],
        )?;
    }
    conn.execute(
        "DELETE FROM schema_meta WHERE key IN
         ('workspace_session_event_backfill', 'workspace_session_event_format')",
        [],
    )?;
    // host 迁移(2026-09-01 远程会话加列;空串 = 本地)。老库首扫时既有行
    // 全部落 '',与远程装饰器生产的非空 host 天然分域,无需回填
    if !table_has_column(&conn, "sessions", "host")? {
        conn.execute(
            "ALTER TABLE sessions ADD COLUMN host TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    // 记忆来源列(记忆可见层二期,2026-09-21):source = 所属来源的 id。memories 表还
    // 没发布过,但开发机上的库已按旧 DDL 建过;老行 source 为空,下一轮扫描按来源
    // 指纹重写(开发机上短暂存在过的 origin 列留着不碍事,DDL 与读写都不再提它)
    // 守卫写死列名、不引用 NEWEST_COLUMN:那个常量下次迁移就会改指别的列,这里跟着改指
    // 就会对已迁移的库再 ALTER 一次,duplicate column 让 open_or_rebuild 把好端端的索引
    // 当坏库重建(2026-09-22 review)
    if !table_has_column(&conn, "memories", "source")? {
        conn.execute(
            "ALTER TABLE memories ADD COLUMN source TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    // 部分索引须在 host 列就位后建(放 DDL 里对未迁移老库会 no such column):
    // host_counts 的 GROUP BY 从全表扫降为远小于全表的索引扫
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_sessions_host ON sessions(host) WHERE host != ''",
        [],
    )?;
    // titles_fts 回填(2026-09-14 加表):老库首次打开时表是空的而 sessions 不空,
    // 把既有标题一次性灌进去;之后由 upsert_session 逐行维护。判据是"空表且有
    // 会话",不记 schema_meta 旗子——全删过的库再开也只是白查一次 count
    let needs_titles: bool = conn.query_row(
        "SELECT (SELECT count(*) FROM titles_fts) = 0 AND EXISTS (SELECT 1 FROM sessions)",
        [],
        |r| r.get(0),
    )?;
    if needs_titles {
        conn.execute(
            "INSERT INTO titles_fts(key, title) SELECT key, title FROM sessions WHERE title != ''",
            [],
        )?;
    }
    Ok(conn)
}

/// 最近一次迁移加的、**只读读者(wake-mcp / wake-cli)会查的**列——`open_read_only`
/// 用它判断库够不够新。加了只读路径要读的新列就改这里,否则只读入口会放行老库、
/// 深处查询才报 no such column;只有 GUI 读的表/列(如 wake_lookups)不算,否则
/// 一次 GUI 侧的加表就让旁路二进制对所有老库拒开
const NEWEST_COLUMN: (&str, &str) = ("memories", "source");
/// 最近一次迁移加的、只读读者会查的表(wake_list_memories 读 memories),与
/// NEWEST_COLUMN 同一用途、同一维护规矩
const NEWEST_TABLE: &str = "compression_documents";

fn table_exists(conn: &Connection, table: &str) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?1)",
        params![table],
        |r| r.get(0),
    )?)
}

fn has_tombstone_fingerprint_columns(conn: &Connection) -> Result<bool> {
    Ok(table_has_column(conn, "tombstones", "deleted_file_mtime")?
        && table_has_column(conn, "tombstones", "deleted_file_size")?)
}

/// 只读连接:不建表、不迁移、不改 journal_mode(旁路进程用;`open_read_only`
/// 与只读 Store 的 insights 临时连接共用,别的入口不要直开)
fn open_conn_ro(path: &Path) -> Result<Connection> {
    let conn = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(std::time::Duration::from_millis(3000))?;
    Ok(conn)
}

/// 读写打开既有库，但不创建文件、不初始化 schema、不迁移，也不修改
/// journal_mode。MCP/CLI 的业务写入口使用它，数据库生命周期仍归 GUI。
fn open_conn_existing(path: &Path) -> Result<Connection> {
    let conn = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(std::time::Duration::from_millis(3000))?;
    Ok(conn)
}

fn table_has_column(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
    for name in names {
        if name? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

/// 打开索引库;打不开就把它连同 WAL/SHM 一起挪到 `.corrupt` 旁路再建一个空的。
/// 索引本来就能从磁盘全量重扫恢复,重建的真实损失只有 user_data(收藏/置顶)
/// 与 location 配置——而它远好过 GUI 无提示秒退。
/// 返回的 `Some(_)` 是给用户看的说明文案。
pub fn open_or_rebuild(path: &Path) -> Result<(Store, Option<String>)> {
    let first = match Store::open(path) {
        Ok(store) => return Ok((store, None)),
        Err(e) => e,
    };
    // 三件套一起挪:留下 WAL 或 SHM 任何一个,新库都会接着读旧日志
    let backup = std::path::PathBuf::from(format!("{}.corrupt", path.display()));
    let _ = std::fs::remove_file(&backup);
    let _ = std::fs::rename(path, &backup);
    for suffix in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
    let store = Store::open(path).with_context(|| format!("rebuild failed after: {first}"))?;
    Ok((
        store,
        Some(format!(
            "Index was damaged and has been rebuilt — stars, pins and location \
             settings are gone. The old file is kept at {}",
            backup.display()
        )),
    ))
}

/// 读写分连接(WAL 单写多读);Connection 非 Sync,各自套 Mutex
pub struct Store {
    write: Mutex<Connection>,
    read: Mutex<Connection>,
    /// insights() 开临时连接用:统计要连扫 messages 几十毫秒,共用唯一
    /// 读连接会让 UI 线程的列表查询排队等它(2026-08-27 Codex review)
    path: std::path::PathBuf,
    /// `open_read_only` 建的实例:所有连接(含 insights 的临时连接)都只读,
    /// 写方法在运行期报 SQLITE_READONLY
    read_only: bool,
    tombstone_fingerprints: bool,
    workspace_root_sources: bool,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        Ok(Self {
            write: Mutex::new(open_conn(path)?),
            read: Mutex::new(open_conn(path)?),
            path: path.to_path_buf(),
            read_only: false,
            tombstone_fingerprints: true,
            workspace_root_sources: true,
        })
    }

    /// 只读打开既有索引库(wake-mcp 这类旁路读者用):不建表、不迁移、不改
    /// journal_mode;库不存在或 schema 太老直接报错——重建权只归 GUI 的
    /// `open_or_rebuild`,旁路进程绝不能把正在被 GUI 写的库挪走重建
    /// (唯一的例外是**库根本不存在**时建一个:`scanner::build_index`)。
    /// WAL 下读者不阻塞 GUI 写入;只读连接要能建 -shm,同用户下目录可写即可
    pub fn open_read_only(path: &Path) -> Result<Self> {
        if !path.is_file() {
            anyhow::bail!(
                "no Wake index at {} — launch Wake once to build it",
                path.display()
            );
        }
        let read = open_conn_ro(path)?;
        if !table_has_column(&read, NEWEST_COLUMN.0, NEWEST_COLUMN.1)?
            || !table_exists(&read, NEWEST_TABLE)?
            || !table_exists(&read, "session_usage")?
            || !table_has_column(&read, "session_usage", "has_usage")?
            || !table_has_column(&read, "session_usage", "source")?
        {
            anyhow::bail!(
                "Wake index at {} is empty or from an older version — launch Wake once to upgrade it",
                path.display()
            );
        }
        let tombstone_fingerprints = has_tombstone_fingerprint_columns(&read)?;
        let workspace_root_sources = table_has_column(&read, "workspace_roots", "source")?;
        Ok(Self {
            // Store 的形状要求有 write 连接;这里给的同样是只读句柄
            write: Mutex::new(open_conn_ro(path)?),
            read: Mutex::new(read),
            path: path.to_path_buf(),
            read_only: true,
            tombstone_fingerprints,
            workspace_root_sources,
        })
    }

    /// 读写打开现有且与当前二进制兼容的索引。与 `open_read_only` 一样，
    /// 旁路进程无权创建、迁移、修复或重建数据库。
    pub fn open_existing(path: &Path) -> Result<Self> {
        if !path.is_file() {
            anyhow::bail!(
                "no Wake index at {} — launch Wake once to build it",
                path.display()
            );
        }
        let read = open_conn_ro(path)?;
        if !table_has_column(&read, NEWEST_COLUMN.0, NEWEST_COLUMN.1)?
            || !table_exists(&read, NEWEST_TABLE)?
            || !table_exists(&read, "session_usage")?
            || !table_has_column(&read, "session_usage", "has_usage")?
            || !table_has_column(&read, "session_usage", "source")?
        {
            anyhow::bail!(
                "Wake index at {} is empty or from an older version — launch Wake once to upgrade it",
                path.display()
            );
        }
        let tombstone_fingerprints = has_tombstone_fingerprint_columns(&read)?;
        let workspace_root_sources = table_has_column(&read, "workspace_roots", "source")?;
        Ok(Self {
            write: Mutex::new(open_conn_existing(path)?),
            read: Mutex::new(read),
            path: path.to_path_buf(),
            read_only: false,
            tombstone_fingerprints,
            workspace_root_sources,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 用量同步只需在源文件指纹变化时解析;与会话索引游标分表维护。
    pub fn session_usage_fingerprints(
        &self,
        agent: AgentId,
    ) -> Result<HashMap<String, (i64, i64, String)>> {
        let conn = self.read.lock().unwrap();
        let mut stmt = conn.prepare_cached(
            "SELECT file_path, file_mtime, file_size, source FROM session_usage WHERE agent_id = ?1",
        )?;
        let rows = stmt.query_map([agent.as_str()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                (row.get(1)?, row.get(2)?, row.get(3)?),
            ))
        })?;
        Ok(rows.collect::<rusqlite::Result<HashMap<_, _>>>()?)
    }

    pub fn write_session_usage(
        &self,
        file_path: &str,
        agent: AgentId,
        tokens: Option<i64>,
        usage_events: &[SessionUsageEvent],
        file_mtime: i64,
        file_size: i64,
        source: &str,
    ) -> Result<()> {
        let mut conn = self.write.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO session_usage(file_path, agent_id, tokens_used, has_usage, source, file_mtime, file_size, scanned_at)
             VALUES (?1, ?2, COALESCE(?3,0), CASE WHEN ?3 IS NULL THEN 0 ELSE 1 END, ?4, ?5, ?6, ?7)
             ON CONFLICT(file_path) DO UPDATE SET
               agent_id = excluded.agent_id,
               tokens_used = excluded.tokens_used,
               has_usage = excluded.has_usage,
               source = excluded.source,
               file_mtime = excluded.file_mtime,
               file_size = excluded.file_size,
               scanned_at = excluded.scanned_at",
            params![file_path, agent.as_str(), tokens.map(|value| value.max(0)), source, file_mtime, file_size, now_ms()],
        )?;
        tx.execute(
            "DELETE FROM session_usage_events WHERE file_path = ?1",
            [file_path],
        )?;
        {
            let mut insert = tx.prepare_cached(
                "INSERT INTO session_usage_events(file_path, event_index, timestamp_ms, tokens_used, model)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            )?;
            for (index, event) in usage_events.iter().enumerate() {
                insert.execute(params![
                    file_path,
                    index as i64,
                    event.timestamp,
                    event.tokens_used.max(0),
                    event.model,
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// 完整成功列举某 Agent 的所有文件后调用,清理已从磁盘消失的同步记录。
    pub fn prune_session_usage(&self, agent: AgentId, live_paths: &[String]) -> Result<()> {
        let mut conn = self.write.lock().unwrap();
        let tx = conn.transaction()?;
        if live_paths.is_empty() {
            tx.execute(
                "DELETE FROM session_usage_events WHERE file_path IN (
                    SELECT file_path FROM session_usage WHERE agent_id = ?1
                 )",
                [agent.as_str()],
            )?;
            tx.execute(
                "DELETE FROM session_usage WHERE agent_id = ?1",
                [agent.as_str()],
            )?;
        } else {
            let stale = format!(
                "SELECT file_path FROM session_usage WHERE agent_id = ?1 AND file_path NOT IN ({})",
                placeholders(live_paths.len())
            );
            let stale_params = || {
                rusqlite::params_from_iter(
                    std::iter::once(agent.as_str().to_string()).chain(live_paths.iter().cloned()),
                )
            };
            tx.execute(
                &format!("DELETE FROM session_usage_events WHERE file_path IN ({stale})"),
                stale_params(),
            )?;
            tx.execute(
                &format!("DELETE FROM session_usage WHERE file_path IN ({stale})"),
                stale_params(),
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn list_mcp_servers(&self) -> Result<Vec<crate::services::mcp::McpServer>> {
        let conn = self.read.lock().unwrap();
        let mut statement = conn.prepare(
            "SELECT id, name, config_json FROM mcp_servers ORDER BY name COLLATE NOCASE, id",
        )?;
        let rows = statement.query_map([], |row| {
            let config: String = row.get(2)?;
            Ok(crate::services::mcp::McpServer {
                id: row.get(0)?,
                name: row.get(1)?,
                config: serde_json::from_str(&config).unwrap_or(serde_json::Value::Null),
                clients: HashMap::new(),
            })
        })?;
        let mut servers = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        drop(conn);

        let conn = self.read.lock().unwrap();
        let mut statement = conn.prepare(
            "SELECT server_id, agent_id, enabled FROM mcp_server_clients ORDER BY agent_id",
        )?;
        let flags = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, bool>(2)?,
            ))
        })?;
        let flags = flags.collect::<rusqlite::Result<Vec<_>>>()?;
        for (server_id, agent, enabled) in flags {
            if let Some(server) = servers.iter_mut().find(|server| server.id == server_id) {
                server.clients.insert(agent, enabled);
            }
        }
        Ok(servers)
    }

    pub fn save_mcp_server(&self, server: &crate::services::mcp::McpServer) -> Result<()> {
        let mut conn = self.write.lock().unwrap();
        let tx = conn.transaction()?;
        let config = serde_json::to_string(&server.config)?;
        tx.execute(
            "INSERT INTO mcp_servers(id, name, config_json, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, config_json=excluded.config_json, updated_at=excluded.updated_at",
            params![server.id, server.name, config, chrono::Utc::now().timestamp_millis()],
        )?;
        for (agent, enabled) in &server.clients {
            tx.execute(
                "INSERT INTO mcp_server_clients(server_id, agent_id, enabled) VALUES (?1, ?2, ?3)
                 ON CONFLICT(server_id, agent_id) DO UPDATE SET enabled=excluded.enabled",
                params![server.id, agent, enabled],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn delete_mcp_server(&self, id: &str) -> Result<()> {
        self.write
            .lock()
            .unwrap()
            .execute("DELETE FROM mcp_servers WHERE id = ?1", [id])?;
        self.write
            .lock()
            .unwrap()
            .execute("DELETE FROM mcp_server_clients WHERE server_id = ?1", [id])?;
        Ok(())
    }

    /// 索引覆盖到的最新会话活动时间(epoch ms;空库 None)。wake-mcp 把它随
    /// 每次工具返回带给 agent,让对方知道索引有多新——GUI 没跑时 watcher 不在,
    /// 搜索/列表只反映到这个时刻(读会话是现场解析,不受影响)
    pub fn latest_activity(&self) -> Result<Option<i64>> {
        let conn = self.read.lock().unwrap();
        let latest: Option<i64> =
            conn.query_row("SELECT MAX(updated_at) FROM sessions", [], |r| r.get(0))?;
        Ok(latest.filter(|t| *t > 0))
    }

    // ---------- 写路径(扫描器/用户操作) ----------

    pub fn write_session(
        &self,
        meta: &SessionMeta,
        file_mtime: i64,
        units: &[IndexUnit],
    ) -> Result<()> {
        let mut conn = self.write.lock().unwrap();
        let tx = conn.transaction()?;
        // 不经裁决的直写只有测试在用(生产路径全走 write_session_guarded),
        // 不带 Wake 调用记录
        write_session_tx(&tx, meta, file_mtime, units, &[])?;
        tx.commit()?;
        Ok(())
    }

    /// 增量写入的并发安全版:胜者比较与写入**同一事务**——先查后写分开时,
    /// 败方副本的事件能与全量扫描交错、后发落库,让 file_path 违背 mtime 裁决
    /// (2026-08-24 Codex review)。裁决与 scanner 枚举时的候选排序是同一把尺子:
    /// 先比副本所属实例的 `dedup_rank`(`rank_of` 按 file_path 给出,小者胜),
    /// 同级再比 mtime 新者、平局路径字典序——两条路径尺子不一,会话就会在两份
    /// 副本之间摇摆(2026-09-15 Codex review)。`supersedes` 是刚解析失败的那份
    /// 副本(路径 + 枚举时看到的 mtime,scanner 回退分支传入):库里这条 key 的行
    /// 若正是它——同路径,且 file_mtime 不晚于枚举时看到的 mtime(quick 阶段占位
    /// 的 0、早先入库后来损坏的旧版本都算)——它已不是竞争者,本次写入直接接管;
    /// 期间 watcher 已把修好的同路径文件成功入库(mtime 更新)则不让位,照常裁决。判定与写入必须
    /// 同一事务,先查再删再写会让并发写入的第三份副本被误删;单凭 file_mtime=0
    /// 推断占位也不行,真实文件同样可能给 0(Codex review 二、三、四轮)。
    /// 返回 false = 本次是败方副本,一字未写
    pub fn write_session_guarded(
        &self,
        meta: &SessionMeta,
        file_mtime: i64,
        units: &[IndexUnit],
        lookups: &[WakeLookup],
        rank_of: &dyn Fn(&str) -> u8,
        supersedes: Option<(&str, i64)>,
    ) -> Result<bool> {
        let mut conn = self.write.lock().unwrap();
        let tx = conn.transaction()?;
        let cur: Option<(String, i64)> = tx
            .query_row(
                "SELECT file_path, file_mtime FROM sessions WHERE key = ?1",
                params![meta.key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((cur_path, cur_mtime)) = cur {
            // 让位只认"库里还是我们解析失败的那个版本或更旧的":同路径且行上的
            // file_mtime ≤ 枚举时看到的 mtime(quick 占位的 0 自然包含;早先入库、
            // 后来损坏的转录是"更旧");期间 watcher 已把修好的同路径文件成功入库
            //(mtime 更新)就不让位,照常裁决(Codex review 第四轮)
            let yields = supersedes
                .is_some_and(|(failed, seen_mtime)| failed == cur_path && cur_mtime <= seen_mtime);
            if cur_path != meta.file_path && !yields {
                let (cur_rank, new_rank) = (rank_of(&cur_path), rank_of(&meta.file_path));
                let loses = cur_rank < new_rank
                    || (cur_rank == new_rank
                        && (cur_mtime > file_mtime
                            || (cur_mtime == file_mtime
                                && cur_path.as_str() < meta.file_path.as_str())));
                if loses {
                    return Ok(false); // 事务未提交即弃
                }
            }
        }
        write_session_tx(&tx, meta, file_mtime, units, lookups)?;
        tx.commit()?;
        Ok(true)
    }

    pub fn write_meta_only(&self, metas: &[(SessionMeta, i64)]) -> Result<()> {
        let mut conn = self.write.lock().unwrap();
        let tx = conn.transaction()?;
        for (meta, mtime) in metas {
            upsert_session(&tx, meta, *mtime)?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Sidecar-only updates must not replace transcript contents or steal a
    /// session from another copy. Changed files go through normal parsing;
    /// children inherit their project through replace_parent_links instead.
    pub(crate) fn update_project_paths(
        &self,
        refs: &[SessionFileRef],
        paths: &HashMap<String, String>,
    ) -> Result<bool> {
        if paths.is_empty() {
            return Ok(false);
        }
        let mut conn = self.write.lock().unwrap();
        let tx = conn.transaction()?;
        let mut changed = false;
        for r in refs {
            let Some(project) = paths.get(&r.file_path).filter(|p| !p.is_empty()) else {
                continue;
            };
            let name = crate::adapters::parse_utils::project_name_of(project);
            changed |= tx.execute(
                "UPDATE sessions SET project_path = ?1, project_name = ?2
                 WHERE file_path = ?3 AND file_mtime = ?4 AND file_size = ?5
                   AND parent_key = '' AND (project_path <> ?1 OR project_name <> ?2)",
                params![project, name, r.file_path, r.mtime_ms, r.size],
            )? > 0;
        }
        tx.commit()?;
        Ok(changed)
    }

    /// schema_meta 里的一次性旗子(升级后要补做的事),做完由 scanner 清掉
    fn has_meta_flag(&self, key: &str) -> bool {
        let conn = self.read.lock().unwrap();
        conn.query_row(
            "SELECT 1 FROM schema_meta WHERE key = ?1",
            params![key],
            |_| Ok(()),
        )
        .optional()
        .map(|value| value.is_some())
        .unwrap_or(false)
    }

    fn clear_meta_flag(&self, key: &str) -> Result<()> {
        let conn = self.write.lock().unwrap();
        conn.execute("DELETE FROM schema_meta WHERE key = ?1", params![key])?;
        Ok(())
    }

    /// 旧索引第一次升级到父子会话 schema 后，现有 Grok 行需要强制重解析，
    /// 才能把临时 worktree cwd 统一回主会话项目。
    pub fn needs_grok_parent_backfill(&self) -> bool {
        self.has_meta_flag("grok_parent_backfill")
    }

    pub fn finish_grok_parent_backfill(&self) -> Result<()> {
        self.clear_meta_flag("grok_parent_backfill")
    }

    /// FTS 派生规则换代后(见 `FTS_FORMAT`)全部文件要重解析一遍;由 scanner 在
    /// 一轮没有解析失败的扫描后清掉,失败过就留着下次再来
    pub fn needs_fts_reindex(&self) -> bool {
        self.has_meta_flag("fts_reindex")
    }

    pub fn finish_fts_reindex(&self) -> Result<()> {
        self.clear_meta_flag("fts_reindex")
    }

    pub fn needs_session_file_change_backfill(&self) -> bool {
        self.has_meta_flag("session_file_change_backfill")
    }

    pub fn finish_session_file_change_backfill(&self) -> Result<()> {
        self.clear_meta_flag("session_file_change_backfill")
    }

    /// 当前胜出副本的 `(key, file_path)`，scanner 用 file_path 把同一 agent
    /// 的多 location 会话交回真正拥有它的 adapter 快照。
    pub fn session_sources_for_agent(&self, agent: AgentId) -> Result<Vec<(String, String)>> {
        let conn = self.read.lock().unwrap();
        let mut stmt = conn.prepare_cached(
            "SELECT key, file_path FROM sessions WHERE agent_id = ?1 ORDER BY key",
        )?;
        let rows = stmt.query_map(params![agent.as_str()], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// scanner 在替换全量关系前用它找出解除/换父的 child；这些会话必须先
    /// 从自己的源文件重解析，恢复被父项目覆盖前的 canonical project。
    pub fn parent_links_for_agent(&self, agent: AgentId) -> Result<HashMap<String, String>> {
        let conn = self.read.lock().unwrap();
        let mut stmt = conn.prepare_cached(
            "SELECT key, parent_key FROM sessions
             WHERE agent_id = ?1 AND parent_key != '' ORDER BY key",
        )?;
        let rows = stmt.query_map(params![agent.as_str()], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// 用某家 adapter 的全量快照原子替换父子关系。只接受库内存在、同 agent、
    /// 非自指的父子键；陈旧关系会被清空。返回是否真的改变了任何行。
    pub fn replace_parent_links(&self, agent: AgentId, links: &[(String, String)]) -> Result<bool> {
        let mut conn = self.write.lock().unwrap();
        let tx = conn.transaction()?;
        let before: Vec<(String, String)> = {
            let mut stmt = tx.prepare_cached(
                "SELECT key, parent_key FROM sessions
                 WHERE agent_id = ?1 AND parent_key != '' ORDER BY key",
            )?;
            let rows = stmt.query_map(params![agent.as_str()], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        tx.execute(
            "UPDATE sessions SET parent_key = '' WHERE agent_id = ?1 AND parent_key != ''",
            params![agent.as_str()],
        )?;
        let mut update = tx.prepare_cached(
            "UPDATE sessions AS child SET
               parent_key = ?1,
               project_path = COALESCE((
                 SELECT NULLIF(parent.project_path, '') FROM sessions parent WHERE parent.key = ?1
               ), child.project_path),
               project_name = COALESCE((
                 SELECT NULLIF(parent.project_name, '') FROM sessions parent WHERE parent.key = ?1
               ), child.project_name)
             WHERE child.key = ?2 AND child.agent_id = ?3 AND child.key != ?1
               AND EXISTS (
                 SELECT 1 FROM sessions parent
                 WHERE parent.key = ?1 AND parent.agent_id = child.agent_id
               )",
        )?;
        let mut unique = std::collections::HashSet::new();
        for (child, parent) in links {
            if unique.insert(child.as_str()) {
                update.execute(params![parent, child, agent.as_str()])?;
            }
        }
        drop(update);
        let after: Vec<(String, String)> = {
            let mut stmt = tx.prepare_cached(
                "SELECT key, parent_key FROM sessions
                 WHERE agent_id = ?1 AND parent_key != '' ORDER BY key",
            )?;
            let rows = stmt.query_map(params![agent.as_str()], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        tx.commit()?;
        Ok(before != after)
    }

    pub fn remove_session(&self, key: &str, tombstone: bool) -> Result<()> {
        self.remove_sessions(&[key.to_string()], tombstone)
    }

    /// 一棵会话树在索引侧原子删除。磁盘路径由调用方先整体移入废纸篓；若
    /// 任一索引步骤失败，所有 session/message/FTS/tombstone 改动一起回滚。
    pub fn remove_sessions(&self, keys: &[String], tombstone: bool) -> Result<()> {
        self.remove_sessions_recorded(keys, tombstone, &[], now_ms())
    }

    /// Keep the reviewed paths even if the watcher already removed a missing
    /// source row. File moves and watcher delivery cannot share a transaction.
    pub fn complete_cleanup(&self, sessions: &[SessionMeta], stamp: i64) -> Result<()> {
        let keys = sessions.iter().map(|s| s.key.clone()).collect::<Vec<_>>();
        self.remove_sessions_recorded(&keys, true, sessions, stamp)
    }

    fn remove_sessions_recorded(
        &self,
        keys: &[String],
        tombstone: bool,
        recorded: &[SessionMeta],
        stamp: i64,
    ) -> Result<()> {
        let mut conn = self.write.lock().unwrap();
        let tx = conn.transaction()?;
        for key in keys {
            if let Some(expected) = recorded.iter().find(|s| s.key == *key) {
                let sql=format!("SELECT {SESSION_COLS} FROM sessions s LEFT JOIN user_data u ON u.session_key = s.key WHERE s.key = ?1");
                if let Some(current) = tx.query_row(&sql, params![key], row_to_meta).optional()? {
                    anyhow::ensure!(
                        current.file_path == expected.file_path
                            && current.updated_at == expected.updated_at
                            && current.created_at == expected.created_at
                            && current.favorite == expected.favorite
                            && current.pinned == expected.pinned,
                        "Session changed before index update: {}",
                        current.title
                    );
                }
            }
            let file: Option<(String, Option<i64>, i64)> = tx
                .query_row(
                    "SELECT file_path, file_mtime, file_size FROM sessions WHERE key = ?1",
                    params![key],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;
            clear_session_rows(&tx, key)?;
            if let Some((file_path, _, _)) = &file {
                tx.execute(
                    "DELETE FROM session_usage WHERE file_path = ?1",
                    params![file_path],
                )?;
                tx.execute(
                    "DELETE FROM session_usage_events WHERE file_path = ?1",
                    params![file_path],
                )?;
            }
            tx.execute("DELETE FROM titles_fts WHERE key = ?1", params![key])?;
            tx.execute("DELETE FROM sessions WHERE key = ?1", params![key])?;
            if tombstone {
                if let Some((fp, mtime, size)) = file.or_else(|| {
                    recorded
                        .iter()
                        .find(|s| s.key == *key)
                        .map(|s| (s.file_path.clone(), None, s.size_bytes))
                }) {
                    if self.tombstone_fingerprints {
                        tx.execute(
                            "INSERT OR REPLACE INTO tombstones(
                               file_path, key, deleted_at, deleted_file_mtime, deleted_file_size
                             ) VALUES (?1, ?2, ?3, ?4, ?5)",
                            params![fp, key, stamp, mtime, size],
                        )?;
                    } else {
                        tx.execute(
                            "INSERT OR REPLACE INTO tombstones(file_path, key, deleted_at)
                             VALUES (?1, ?2, ?3)",
                            params![fp, key, stamp],
                        )?;
                    }
                }
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// 路径 → 现行 key(watcher 增量的易主清理用)
    pub fn key_for_path(&self, file_path: &str) -> Result<Option<String>> {
        let conn = self.read.lock().unwrap();
        Ok(conn
            .query_row(
                "SELECT key FROM sessions WHERE file_path = ?1",
                params![file_path],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// 按路径删行,返回被删会话的 key——watcher 用它触发幸存副本上位
    ///(同 key 的另一 location 副本接管,Codex review P2)
    pub fn remove_by_path(&self, file_path: &str) -> Result<Option<String>> {
        let key: Option<String> = {
            let conn = self.read.lock().unwrap();
            conn.query_row(
                "SELECT key FROM sessions WHERE file_path = ?1",
                params![file_path],
                |r| r.get(0),
            )
            .optional()?
        };
        if let Some(k) = &key {
            self.remove_session(k, false)?;
        }
        Ok(key)
    }

    pub fn set_user_data(
        &self,
        key: &str,
        favorite: Option<bool>,
        pinned: Option<bool>,
    ) -> Result<()> {
        let conn = self.write.lock().unwrap();
        conn.execute(
            "INSERT INTO user_data(session_key, favorite, pinned, updated_at)
             VALUES (?1, COALESCE(?2, 0), COALESCE(?3, 0), ?4)
             ON CONFLICT(session_key) DO UPDATE SET
               favorite = COALESCE(?2, user_data.favorite),
               pinned   = COALESCE(?3, user_data.pinned),
               updated_at = excluded.updated_at",
            params![
                key,
                favorite.map(|v| v as i64),
                pinned.map(|v| v as i64),
                now_ms()
            ],
        )?;
        Ok(())
    }

    pub fn session_tags(&self, key: &str) -> Result<Vec<String>> {
        let conn = self.read.lock().unwrap();
        let mut stmt = conn
            .prepare_cached("SELECT tag FROM session_tags WHERE session_key = ?1 ORDER BY tag")?;
        let rows = stmt.query_map(params![key], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn session_tags_for(&self, keys: &[String]) -> Result<HashMap<String, Vec<String>>> {
        if keys.is_empty() {
            return Ok(HashMap::new());
        }
        let conn = self.read.lock().unwrap();
        let sql = format!(
            "SELECT session_key, tag FROM session_tags
             WHERE session_key IN ({})
             ORDER BY session_key, tag",
            placeholders(keys.len())
        );
        let mut stmt = conn.prepare_cached(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(keys.iter()), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        let mut out: HashMap<String, Vec<String>> = HashMap::new();
        for row in rows {
            let (key, tag) = row?;
            out.entry(key).or_default().push(tag);
        }
        Ok(out)
    }

    pub fn set_session_tag(&self, key: &str, tag: &str, enabled: bool) -> Result<()> {
        let conn = self.write.lock().unwrap();
        if enabled {
            conn.execute(
                "INSERT INTO session_tags(session_key, tag, source, confidence, updated_at)
                 VALUES (?1, ?2, 'manual', 1.0, ?3)
                 ON CONFLICT(session_key, tag) DO UPDATE SET
                   source = 'manual',
                   confidence = 1.0,
                   updated_at = excluded.updated_at",
                params![key, tag, now_ms()],
            )?;
        } else {
            conn.execute(
                "DELETE FROM session_tags WHERE session_key = ?1 AND tag = ?2",
                params![key, tag],
            )?;
        }
        Ok(())
    }

    pub fn session_tag_counts(&self, include_archived: bool) -> Result<Vec<(String, i64)>> {
        let conn = self.read.lock().unwrap();
        let archived = if include_archived {
            ""
        } else {
            "WHERE s.archived = 0"
        };
        let mut stmt = conn.prepare_cached(&format!(
            "SELECT t.tag, COUNT(*)
             FROM session_tags t
             JOIN sessions s ON s.key = t.session_key
             {archived}
             GROUP BY t.tag
             ORDER BY t.tag"
        ))?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn set_session_link(&self, parent: &str, child: &str, relation: &str) -> Result<()> {
        if parent == child {
            anyhow::bail!("a session cannot link to itself");
        }
        let conn = self.write.lock().unwrap();
        conn.execute(
            "INSERT INTO session_links(parent_session_key, child_session_key, relation, source, created_at)
             VALUES (?1, ?2, ?3, 'manual', ?4)
             ON CONFLICT(parent_session_key, child_session_key, relation) DO UPDATE SET
               source = 'manual',
               created_at = excluded.created_at",
            params![parent, child, relation, now_ms()],
        )?;
        Ok(())
    }

    pub fn session_link_source(
        &self,
        parent: &str,
        child: &str,
        relation: &str,
    ) -> Result<Option<String>> {
        let conn = self.read.lock().unwrap();
        Ok(conn
            .query_row(
                "SELECT source FROM session_links
                 WHERE parent_session_key = ?1 AND child_session_key = ?2 AND relation = ?3",
                params![parent, child, relation],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub fn update_session_link_relation(
        &self,
        parent: &str,
        child: &str,
        old_relation: &str,
        new_relation: &str,
    ) -> Result<()> {
        if parent == child {
            anyhow::bail!("a session cannot link to itself");
        }
        let conn = self.write.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM session_links
             WHERE parent_session_key = ?1 AND child_session_key = ?2 AND relation = ?3",
            params![parent, child, old_relation],
        )?;
        tx.execute(
            "INSERT INTO session_links(parent_session_key, child_session_key, relation, source, created_at)
             VALUES (?1, ?2, ?3, 'manual', ?4)
             ON CONFLICT(parent_session_key, child_session_key, relation) DO UPDATE SET
               source = 'manual',
               created_at = excluded.created_at",
            params![parent, child, new_relation, now_ms()],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn delete_session_link(&self, parent: &str, child: &str, relation: &str) -> Result<()> {
        let conn = self.write.lock().unwrap();
        conn.execute(
            "DELETE FROM session_links
             WHERE parent_session_key = ?1 AND child_session_key = ?2 AND relation = ?3",
            params![parent, child, relation],
        )?;
        Ok(())
    }

    pub fn session_link_counts(&self, key: &str) -> Result<(i64, i64)> {
        let conn = self.read.lock().unwrap();
        let parents = conn.query_row(
            "SELECT COUNT(*) FROM session_links WHERE child_session_key = ?1",
            params![key],
            |r| r.get(0),
        )?;
        let children = conn.query_row(
            "SELECT COUNT(*) FROM session_links WHERE parent_session_key = ?1",
            params![key],
            |r| r.get(0),
        )?;
        Ok((parents, children))
    }

    pub fn session_relationships(
        &self,
        key: &str,
    ) -> Result<(Vec<SessionRelation>, Vec<SessionRelation>)> {
        let conn = self.read.lock().unwrap();
        let parent_sql = format!(
            "SELECT l.relation, l.source, {SESSION_COLS}
             FROM session_links l
             JOIN sessions s ON s.key = l.parent_session_key
             LEFT JOIN user_data u ON u.session_key = s.key
             WHERE l.child_session_key = ?1
             ORDER BY l.created_at DESC, s.updated_at DESC"
        );
        let child_sql = format!(
            "SELECT l.relation, l.source, {SESSION_COLS}
             FROM session_links l
             JOIN sessions s ON s.key = l.child_session_key
             LEFT JOIN user_data u ON u.session_key = s.key
             WHERE l.parent_session_key = ?1
             ORDER BY l.created_at DESC, s.updated_at DESC"
        );
        let mut parent_stmt = conn.prepare_cached(&parent_sql)?;
        let parents = parent_stmt
            .query_map(params![key], relation_row_to_meta)?
            .collect::<rusqlite::Result<_>>()?;
        let mut child_stmt = conn.prepare_cached(&child_sql)?;
        let children = child_stmt
            .query_map(params![key], relation_row_to_meta)?
            .collect::<rusqlite::Result<_>>()?;
        Ok((parents, children))
    }

    pub fn all_session_relationships(&self) -> Result<Vec<SessionRelationEdge>> {
        let conn = self.read.lock().unwrap();
        let sql = format!(
            "SELECT l.relation, l.source, {parent_cols}, {child_cols}
             FROM session_links l
             JOIN sessions p ON p.key = l.parent_session_key
             LEFT JOIN user_data pu ON pu.session_key = p.key
             JOIN sessions c ON c.key = l.child_session_key
             LEFT JOIN user_data cu ON cu.session_key = c.key
             ORDER BY l.created_at DESC, p.updated_at DESC, c.updated_at DESC",
            parent_cols = SESSION_COLS.replace("s.", "p.").replace("u.", "pu."),
            child_cols = SESSION_COLS.replace("s.", "c.").replace("u.", "cu."),
        );
        let mut stmt = conn.prepare_cached(&sql)?;
        let rows = stmt.query_map([], |row| {
            Ok(SessionRelationEdge {
                relation: row.get(0)?,
                source: row.get(1)?,
                parent: relation_session_meta(row, 2)?,
                child: relation_session_meta(row, 21)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn session_relationship_tree(
        &self,
        key: &str,
        max_depth: usize,
    ) -> Result<(Vec<SessionRelationNode>, Vec<SessionRelationNode>)> {
        let mut parent_tree = Vec::new();
        let mut child_tree = Vec::new();
        let mut seen_parents = HashSet::from([key.to_string()]);
        let mut seen_children = HashSet::from([key.to_string()]);
        self.push_relationship_tree(key, max_depth, 1, true, &mut seen_parents, &mut parent_tree)?;
        self.push_relationship_tree(
            key,
            max_depth,
            1,
            false,
            &mut seen_children,
            &mut child_tree,
        )?;
        Ok((parent_tree, child_tree))
    }

    fn push_relationship_tree(
        &self,
        key: &str,
        max_depth: usize,
        depth: usize,
        parents: bool,
        seen: &mut HashSet<String>,
        out: &mut Vec<SessionRelationNode>,
    ) -> Result<()> {
        if depth > max_depth {
            return Ok(());
        }
        let (parent_links, child_links) = self.session_relationships(key)?;
        let links = if parents { parent_links } else { child_links };
        for link in links {
            if !seen.insert(link.session.key.clone()) {
                continue;
            }
            let next_key = link.session.key.clone();
            out.push(SessionRelationNode {
                depth,
                relation: link.relation,
                session: link.session,
            });
            self.push_relationship_tree(&next_key, max_depth, depth + 1, parents, seen, out)?;
        }
        Ok(())
    }

    /// 应用级 KV 偏好(Open In 目标记忆等 UI 状态)。value 语义由调用方定
    /// (多为 json),不存在回 None
    pub fn pref_get(&self, key: &str) -> Option<String> {
        let conn = self.write.lock().unwrap();
        conn.query_row(
            "SELECT value FROM prefs WHERE key = ?1",
            params![key],
            |r| r.get(0),
        )
        .optional()
        .ok()
        .flatten()
    }

    pub fn pref_set(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.write.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO prefs(key, value) VALUES (?1, ?2)",
            params![key, value],
        )?;
        Ok(())
    }

    /// Cleanup journals survive ordinary index rebuilds, like other user prefs.
    pub fn cleanup_journals(&self) -> Result<Vec<String>> {
        let conn = self.read.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT value FROM prefs WHERE key LIKE 'cleanup.batch.%' ORDER BY key DESC",
        )?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Fresh ownership metadata for inventory and each deletion check. Deliberately
    /// independent of the message index, which can contain millions of rows.
    pub fn cleanup_index(&self) -> Result<Vec<crate::cleanup::IndexedSession>> {
        let conn = self.read.lock().unwrap();
        let sql = format!("SELECT {SESSION_COLS}, s.parent_key FROM sessions s LEFT JOIN user_data u ON u.session_key = s.key");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], |r| {
            Ok(crate::cleanup::IndexedSession {
                meta: row_to_meta(r)?,
                parent: r.get(19)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Display-only counts, collected once per cleanup inventory, never per tree
    /// during review or execution. Sidechain prompts do not belong to the mainline.
    pub fn cleanup_prompt_counts(&self) -> Result<std::collections::HashMap<String, i64>> {
        let conn = self.read.lock().unwrap();
        let mut stmt = conn.prepare("SELECT session_key, COUNT(*) FROM messages WHERE role = 'user' AND sidechain_id IS NULL GROUP BY session_key")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Check before moving restored files, then check again in the transaction.
    pub fn validate_cleanup_restore(&self, sessions: &[SessionMeta], stamp: i64) -> Result<()> {
        let conn = self.read.lock().unwrap();
        for s in sessions {
            let conflict: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM tombstones WHERE (key = ?1 OR file_path = ?2) AND deleted_at != ?3)", params![s.key, s.file_path, stamp], |r| r.get(0))?;
            anyhow::ensure!(!conflict, "A newer deletion protects {}", s.file_path);
        }
        Ok(())
    }

    /// Only undo the tombstones written by this cleanup, never later deletions.
    pub fn restore_cleanup(&self, sessions: &[SessionMeta], stamp: i64) -> Result<()> {
        let mut conn = self.write.lock().unwrap();
        let tx = conn.transaction()?;
        for s in sessions {
            let conflict: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM tombstones WHERE (key = ?1 OR file_path = ?2) AND deleted_at != ?3)", params![s.key, s.file_path, stamp], |r| r.get(0))?;
            anyhow::ensure!(!conflict, "A newer deletion protects {}", s.file_path);
            tx.execute(
                "DELETE FROM tombstones WHERE key = ?1 AND file_path = ?2 AND deleted_at = ?3",
                params![s.key, s.file_path, stamp],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    // ---------- 自定义 location(Session locations 面板的 Add location) ----------

    /// 与收藏/置顶同层级的用户数据:索引重扫不动它,只有索引文件本体损坏
    /// 重建才丢(open_or_rebuild 的提示文案已列入)
    pub fn list_custom_roots(&self) -> Result<Vec<(String, String)>> {
        let conn = self.read.lock().unwrap();
        let mut stmt =
            conn.prepare_cached("SELECT agent, path FROM custom_roots ORDER BY added_at, path")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.flatten().collect())
    }

    pub fn add_custom_root(&self, agent: &str, path: &str) -> Result<()> {
        let conn = self.write.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO custom_roots(agent, path, added_at) VALUES (?1, ?2, ?3)",
            params![agent, path, now_ms()],
        )?;
        Ok(())
    }

    /// location 配置一次取齐(自定义根 + 被移除预设/预设路径),解析成模型层类型;
    /// 未识别的 agent 名(库被降级版本写过)静默跳过。GUI 与 scan CLI 共用
    pub fn location_overrides(&self) -> LocationOverrides {
        let customs = self
            .list_custom_roots()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|(a, p)| AgentId::from_str(&a).map(|a| (a, std::path::PathBuf::from(p))))
            .collect();
        let removed = self
            .list_removed_defaults()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|a| AgentId::from_str(&a))
            .collect();
        let removed_roots = self
            .list_removed_default_roots()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|(a, p)| AgentId::from_str(&a).map(|a| (a, std::path::PathBuf::from(p))))
            .collect();
        (customs, removed, removed_roots)
    }

    /// 被用户暂时停用的数据根。与 removed_defaults 不同：停用只控制扫描，
    /// location 配置本身仍在，因此管理面板可以原位重新开启。
    pub fn disabled_locations(&self) -> Vec<(AgentId, std::path::PathBuf)> {
        self.list_disabled_locations()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|(a, p)| AgentId::from_str(&a).map(|a| (a, std::path::PathBuf::from(p))))
            .collect()
    }

    pub fn list_disabled_locations(&self) -> Result<Vec<(String, String)>> {
        let conn = self.read.lock().unwrap();
        let mut stmt = conn.prepare_cached(
            "SELECT agent, path FROM disabled_locations ORDER BY disabled_at, agent, path",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.flatten().collect())
    }

    /// location 开关的唯一写入口。enabled=true 删除停用标记；false 幂等记入。
    pub fn set_location_enabled(&self, agent: &str, path: &str, enabled: bool) -> Result<()> {
        let conn = self.write.lock().unwrap();
        if enabled {
            conn.execute(
                "DELETE FROM disabled_locations WHERE agent = ?1 AND path = ?2",
                params![agent, path],
            )?;
        } else {
            conn.execute(
                "INSERT OR IGNORE INTO disabled_locations(agent, path, disabled_at)
                 VALUES (?1, ?2, ?3)",
                params![agent, path, now_ms()],
            )?;
        }
        Ok(())
    }

    /// 编辑 location 的全形态原子写入(2026-08-24 Codex review:分开自动提交
    /// 时第二步失败会把配置改成半生效)。旧单元:自定义 = 删记录,普通预设 =
    /// 压整家默认,多产品库预设 = 只压该 root;新单元一律记自定义——含换
    /// agent 的编辑,全在一个事务里
    pub fn replace_location(
        &self,
        old_agent: &str,
        old_custom_path: Option<&str>,
        old_default_root: Option<&str>,
        old_data_root: &str,
        new_agent: &str,
        new_path: &str,
    ) -> Result<()> {
        let mut conn = self.write.lock().unwrap();
        let tx = conn.transaction()?;
        // 编辑被停用的 location 后，新路径按启用状态开始；旧路径留下停用记录
        // 会在用户日后重新添加同一路径时意外继承，因此随旧配置一并清理。
        let disabled: Vec<String> = {
            let mut stmt = tx.prepare_cached(
                "SELECT path FROM disabled_locations WHERE agent = ?1 ORDER BY path",
            )?;
            let rows = stmt.query_map(params![old_agent], |r| r.get(0))?;
            rows.flatten().collect()
        };
        // 自定义配置可能派生多个数据根，按落库父路径整组清；内置配置则按
        // 用户正在编辑的真实数据根清。old_default_root 只管 Remove/替换语义，
        // 不能兼任这里的状态键（多数 adapter 在该参数中是 None）。
        let disabled_unit = old_custom_path.unwrap_or(old_data_root);
        for path in disabled
            .iter()
            .filter(|path| crate::adapters::path_owns(disabled_unit, path))
        {
            tx.execute(
                "DELETE FROM disabled_locations WHERE agent = ?1 AND path = ?2",
                params![old_agent, path],
            )?;
        }
        match (old_custom_path, old_default_root) {
            (Some(p), _) => {
                tx.execute(
                    "DELETE FROM custom_roots WHERE agent = ?1 AND path = ?2",
                    params![old_agent, p],
                )?;
            }
            (None, Some(root)) => {
                tx.execute(
                    "INSERT OR IGNORE INTO removed_default_roots(agent, path, removed_at) VALUES (?1, ?2, ?3)",
                    params![old_agent, root, now_ms()],
                )?;
            }
            (None, None) => {
                tx.execute(
                    "INSERT OR IGNORE INTO removed_defaults(agent, removed_at) VALUES (?1, ?2)",
                    params![old_agent, now_ms()],
                )?;
            }
        }
        tx.execute(
            "INSERT OR IGNORE INTO custom_roots(agent, path, added_at) VALUES (?1, ?2, ?3)",
            params![new_agent, new_path, now_ms()],
        )?;
        tx.commit()?;
        Ok(())
    }

    // ---------- 远程 host(Settings → Remote hosts,SSH 会话聚合) ----------

    /// 与 location 配置同层级的用户数据:重扫不动,索引重建才丢。
    /// name 即 ssh 目标(`~/.ssh/config` 的 Host 别名或 user@host),
    /// 字符集校验在 add_remote_host 那道门
    pub fn list_remote_hosts(&self) -> Result<Vec<RemoteHost>> {
        let conn = self.read.lock().unwrap();
        let mut stmt = conn.prepare_cached(
            "SELECT name, enabled, last_sync_at, last_sync_error
             FROM remote_hosts ORDER BY added_at, name",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(RemoteHost {
                name: r.get(0)?,
                enabled: r.get::<_, i64>(1)? != 0,
                last_sync_at: r.get(2)?,
                last_sync_error: r.get(3)?,
            })
        })?;
        Ok(rows.flatten().collect())
    }

    /// roster 组装(create_adapter_roster_for)与 UI 起同步共用——远程实例
    /// 集合与同步目标集合必须同源,别各自 filter 一遍。
    pub fn enabled_remote_host_names(&self) -> Vec<String> {
        self.list_remote_hosts()
            .unwrap_or_default()
            .into_iter()
            .filter(|h| h.enabled)
            .map(|h| h.name)
            .collect()
    }

    pub fn add_remote_host(&self, name: &str) -> Result<()> {
        // 校验在写库这道门(而非各入口自记):host 名进 session key 作中段、
        // 直接当 ssh/rsync 参数,任何未来入口(CLI/导入)都不得绕过
        if !crate::remote::valid_host_name(name) {
            return Err(anyhow::anyhow!("invalid host name: {name:?}"));
        }
        let conn = self.write.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO remote_hosts(name, enabled, added_at) VALUES (?1, 1, ?2)",
            params![name, now_ms()],
        )?;
        Ok(())
    }

    /// 移除 host 配置本身。缓存目录与已入库会话由调用方另行清理
    /// (Workbench 删缓存目录后补扫,run_scan 的删除检测出清库内行)
    pub fn remove_remote_host(&self, name: &str) -> Result<()> {
        let conn = self.write.lock().unwrap();
        conn.execute("DELETE FROM remote_hosts WHERE name = ?1", params![name])?;
        Ok(())
    }

    pub fn set_remote_host_enabled(&self, name: &str, enabled: bool) -> Result<()> {
        let conn = self.write.lock().unwrap();
        conn.execute(
            "UPDATE remote_hosts SET enabled = ?2 WHERE name = ?1",
            params![name, enabled as i64],
        )?;
        Ok(())
    }

    /// 同步收尾统一写状态:成功清 error,失败保留上次成功时间
    pub fn record_remote_sync(&self, name: &str, error: Option<&str>) -> Result<()> {
        let conn = self.write.lock().unwrap();
        match error {
            None => conn.execute(
                "UPDATE remote_hosts SET last_sync_at = ?2, last_sync_error = NULL WHERE name = ?1",
                params![name, now_ms()],
            )?,
            Some(e) => conn.execute(
                "UPDATE remote_hosts SET last_sync_error = ?2 WHERE name = ?1",
                params![name, e],
            )?,
        };
        Ok(())
    }

    /// 每个远程 host 的库内会话数(Remote hosts 面板;不滤 archived,
    /// 与 locations 面板的 counts_by_path_prefix 同口径)
    pub fn host_counts(&self) -> Result<HashMap<String, i64>> {
        let conn = self.read.lock().unwrap();
        let mut stmt = conn
            .prepare_cached("SELECT host, COUNT(*) FROM sessions WHERE host != '' GROUP BY host")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        Ok(rows.flatten().collect())
    }

    /// 索引库文件所在目录(远程缓存 `remotes/<host>` 挂在它下面)。
    /// 打开哪个库就用哪个库旁边的缓存——GUI 与 scan CLI 的 --tmp 隔离库
    /// 由此天然分开,互不读写对方的缓存树
    pub fn db_dir(&self) -> Option<std::path::PathBuf> {
        self.path.parent().map(|p| p.to_path_buf())
    }

    /// 恢复初始:清空全部 location 偏离（自定义、被移除预设与停用状态）。
    pub fn clear_location_overrides(&self) -> Result<()> {
        let conn = self.write.lock().unwrap();
        conn.execute_batch(
            "DELETE FROM custom_roots;
             DELETE FROM removed_defaults;
             DELETE FROM removed_default_roots;
             DELETE FROM disabled_locations;",
        )?;
        Ok(())
    }

    /// 预设 location 的移除是"压制该家默认实例"而非删路径——默认根随
    /// env(CODEX_HOME 等)在构造时活解析,不能物化落库,故只记偏离
    pub fn list_removed_defaults(&self) -> Result<Vec<String>> {
        let conn = self.read.lock().unwrap();
        let mut stmt = conn.prepare_cached("SELECT agent FROM removed_defaults ORDER BY agent")?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        Ok(rows.flatten().collect())
    }

    pub fn add_removed_default(&self, agent: &str) -> Result<()> {
        let conn = self.write.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO removed_defaults(agent, removed_at) VALUES (?1, ?2)",
            params![agent, now_ms()],
        )?;
        Ok(())
    }

    /// 多默认根 adapter 可只压制其中一条；路径保留为构造时解析出的绝对值，
    /// 不会因为移除 next 库而连带关掉同一 agent 的 stable 库。
    pub fn list_removed_default_roots(&self) -> Result<Vec<(String, String)>> {
        let conn = self.read.lock().unwrap();
        let mut stmt = conn.prepare_cached(
            "SELECT agent, path FROM removed_default_roots ORDER BY removed_at, path",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.flatten().collect())
    }

    pub fn add_removed_default_root(&self, agent: &str, path: &str) -> Result<()> {
        let conn = self.write.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO removed_default_roots(agent, path, removed_at) VALUES (?1, ?2, ?3)",
            params![agent, path, now_ms()],
        )?;
        Ok(())
    }

    pub fn remove_custom_root(&self, agent: &str, path: &str) -> Result<()> {
        let mut conn = self.write.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM custom_roots WHERE agent = ?1 AND path = ?2",
            params![agent, path],
        )?;
        // 同一配置可能派生多个真实根（如 Codex sessions + archived）；真正
        // Remove 时一并清掉这些根的停用标记，今后重新添加应默认启用。
        let disabled: Vec<String> = {
            let mut stmt = tx.prepare_cached(
                "SELECT path FROM disabled_locations WHERE agent = ?1 ORDER BY path",
            )?;
            let rows = stmt.query_map(params![agent], |r| r.get(0))?;
            rows.flatten().collect()
        };
        for disabled_path in disabled
            .iter()
            .filter(|disabled_path| crate::adapters::path_owns(path, disabled_path))
        {
            tx.execute(
                "DELETE FROM disabled_locations WHERE agent = ?1 AND path = ?2",
                params![agent, disabled_path],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn rebuild_all(&self) -> Result<()> {
        let conn = self.write.lock().unwrap();
        conn.execute_batch(
            "DELETE FROM messages; DELETE FROM messages_fts; DELETE FROM titles_fts;
             DELETE FROM memories; DELETE FROM memories_fts; DELETE FROM wake_lookups;
             DELETE FROM sessions;",
        )?;
        Ok(())
    }

    // ---------- 读路径(UI 查询) ----------

    pub fn known_files(&self) -> Result<HashMap<String, (i64, i64, String)>> {
        let conn = self.read.lock().unwrap();
        let mut stmt =
            conn.prepare_cached("SELECT file_path, file_mtime, file_size, key FROM sessions")?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, (r.get(1)?, r.get(2)?, r.get(3)?)))
        })?;
        let mut map = HashMap::new();
        for row in rows {
            let (path, v) = row?;
            map.insert(path, v);
        }
        Ok(map)
    }

    /// Perform bounded maintenance after a successful session scan.
    ///
    /// Session writes intentionally replace derived rows, so a crash or an
    /// older binary can leave orphaned FTS/index rows behind. Repair those
    /// rows here, after the scan has released all write transactions. WAL
    /// checkpointing is threshold-based; an unconditional VACUUM would make
    /// every refresh expensive and would create needless SSD writes.
    pub fn compact_after_scan(&self, force_vacuum: bool) -> Result<()> {
        if self.read_only {
            return Ok(());
        }

        let wal_path = std::path::PathBuf::from(format!("{}-wal", self.path.display()));
        let wal_bytes = std::fs::metadata(&wal_path)
            .map(|meta| meta.len())
            .unwrap_or(0);

        let mut conn = self.write.lock().unwrap();
        let tx = conn.transaction()?;
        let mut cleaned = 0usize;

        cleaned += tx.execute(
            "DELETE FROM titles_fts
             WHERE key NOT IN (SELECT key FROM sessions)",
            [],
        )?;
        cleaned += tx.execute(
            "DELETE FROM memories_fts
             WHERE rowid NOT IN (SELECT id FROM memories)",
            [],
        )?;
        cleaned += tx.execute(
            "DELETE FROM compression_documents_fts
             WHERE rowid NOT IN (SELECT id FROM compression_documents)",
            [],
        )?;
        cleaned += tx.execute(
            "DELETE FROM wake_lookups
             WHERE NOT EXISTS (
                 SELECT 1 FROM sessions WHERE sessions.key = wake_lookups.session_key
             )",
            [],
        )?;
        cleaned += tx.execute(
            "DELETE FROM session_usage_events
             WHERE NOT EXISTS (
                 SELECT 1 FROM session_usage
                 WHERE session_usage.file_path = session_usage_events.file_path
             )",
            [],
        )?;

        let orphan_messages: i64 = tx.query_row(
            "SELECT COUNT(*) FROM messages
             WHERE NOT EXISTS (
                 SELECT 1 FROM sessions WHERE sessions.key = messages.session_key
             )",
            [],
            |row| row.get(0),
        )?;
        if orphan_messages > 0 {
            cleaned += tx.execute(
                "DELETE FROM messages
                 WHERE NOT EXISTS (
                     SELECT 1 FROM sessions WHERE sessions.key = messages.session_key
                 )",
                [],
            )?;
        }

        let messages_fts_mismatch: bool = tx.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM messages m
                WHERE NOT EXISTS (
                    SELECT 1 FROM messages_fts f WHERE f.rowid = m.id
                )
            ) OR EXISTS(
                SELECT 1 FROM messages_fts f
                WHERE NOT EXISTS (
                    SELECT 1 FROM messages m WHERE m.id = f.rowid
                )
            )",
            [],
            |row| row.get(0),
        )?;
        if orphan_messages > 0 || messages_fts_mismatch {
            tx.execute("DELETE FROM messages_fts", [])?;
            tx.execute(
                "INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')",
                [],
            )?;
            cleaned += 1;
        }

        let titles_fts_mismatch: bool = tx.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM sessions s
                WHERE s.title != '' AND NOT EXISTS(
                    SELECT 1 FROM titles_fts t WHERE t.key = s.key
                )
            ) OR EXISTS(
                SELECT 1 FROM titles_fts t
                WHERE NOT EXISTS(
                    SELECT 1 FROM sessions s WHERE s.key = t.key
                )
            )",
            [],
            |row| row.get(0),
        )?;
        if titles_fts_mismatch {
            tx.execute("DELETE FROM titles_fts", [])?;
            tx.execute(
                "INSERT INTO titles_fts(key, title)
                 SELECT key, title FROM sessions WHERE title != ''",
                [],
            )?;
            cleaned += 1;
        }

        tx.commit()?;
        drop(conn);

        let checkpoint_needed = cleaned > 0 || wal_bytes >= INDEX_WAL_CHECKPOINT_THRESHOLD;
        let vacuum_needed = force_vacuum || cleaned > 0 || wal_bytes >= INDEX_WAL_VACUUM_THRESHOLD;

        let conn = self.write.lock().unwrap();
        conn.execute_batch("PRAGMA optimize")?;
        if checkpoint_needed {
            // Step the pragma so SQLite actually performs the checkpoint. The
            // returned busy/page counts are diagnostic only.
            conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
        }
        if vacuum_needed {
            conn.execute_batch("VACUUM")?;
        }
        Ok(())
    }

    /// 逻辑会话级墓碑:同 key 的任何副本(别的 location 里的拷贝)都不得
    /// 让已删会话复活(2026-08-24 Codex review P1,不变量 3 的多副本延伸)
    pub fn is_key_tombstoned(&self, key: &str) -> bool {
        let conn = self.read.lock().unwrap();
        conn.query_row(
            "SELECT 1 FROM tombstones WHERE key = ?1",
            params![key],
            |_| Ok(()),
        )
        .optional()
        .map(|o| o.is_some())
        .unwrap_or(false)
    }

    pub fn is_tombstoned(&self, file_path: &str) -> bool {
        let conn = self.read.lock().unwrap();
        conn.query_row(
            "SELECT 1 FROM tombstones WHERE file_path = ?1",
            params![file_path],
            |_| Ok(()),
        )
        .optional()
        .map(|o| o.is_some())
        .unwrap_or(false)
    }

    /// Returns whether a tombstone still matches this exact file snapshot. A
    /// changed file at the tombstoned path is treated as a revived session.
    /// Legacy tombstones without a snapshot remain hidden until explicitly
    /// restored, since their prior file state cannot be inferred safely.
    pub fn is_session_tombstoned(
        &self,
        key: &str,
        file_path: &str,
        file_mtime: i64,
        file_size: i64,
    ) -> Result<bool> {
        let rows: Vec<(String, Option<i64>, Option<i64>, i64)> = {
            let conn = self.read.lock().unwrap();
            if self.tombstone_fingerprints {
                let mut stmt = conn.prepare_cached(
                    "SELECT file_path, deleted_file_mtime, deleted_file_size, deleted_at
                     FROM tombstones WHERE key = ?1 OR file_path = ?2",
                )?;
                let rows = stmt
                    .query_map(params![key, file_path], |row| {
                        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                    })?
                    .collect::<rusqlite::Result<_>>()?;
                rows
            } else {
                let mut stmt = conn.prepare_cached(
                    "SELECT file_path, deleted_at FROM tombstones
                     WHERE key = ?1 OR file_path = ?2",
                )?;
                let rows = stmt
                    .query_map(params![key, file_path], |row| {
                        Ok((row.get(0)?, None, None, row.get(1)?))
                    })?
                    .collect::<rusqlite::Result<_>>()?;
                rows
            }
        };
        if rows.is_empty() {
            return Ok(false);
        }

        let changed = rows.iter().any(|(deleted_path, mtime, size, deleted_at)| {
            if !same_tombstone_path(deleted_path, file_path) {
                return false;
            }
            match mtime.zip(*size) {
                Some((mtime, size)) => mtime != file_mtime || size != file_size,
                None => file_mtime > *deleted_at,
            }
        });
        if !changed {
            return Ok(true);
        }

        let conn = self.write.lock().unwrap();
        conn.execute(
            "DELETE FROM tombstones WHERE key = ?1 OR file_path = ?2",
            params![key, file_path],
        )?;
        Ok(false)
    }

    pub fn list_sessions(&self, f: &SessionFilter) -> Result<(Vec<SessionMeta>, i64)> {
        let mut wheres: Vec<String> = Vec::new();
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

        // 根会话的"活动时间"是连子会话一起聚合的(排序、返回值都如此),since
        // 过滤必须用同一口径——只看父行会把"父旧子新"的整棵树滤掉
        let updated_col = match (f.roots_only, f.include_archived) {
            (true, false) => ROOT_UPDATED_ACTIVE,
            (true, true) => ROOT_UPDATED_ALL,
            _ => "s.updated_at",
        };
        push_session_filters(f, updated_col, &mut wheres, &mut args);
        if f.roots_only {
            wheres.push(if f.include_archived {
                ROOT_IGNORING_ARCHIVED.into()
            } else {
                ROOT_WHEN_HIDING_ARCHIVED.into()
            });
        }
        let where_sql = if wheres.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", wheres.join(" AND "))
        };
        let order_col = match (f.roots_only, f.sort, f.include_archived) {
            (true, SortKey::Updated, false) => ROOT_UPDATED_ACTIVE,
            (true, SortKey::Updated, true) => ROOT_UPDATED_ALL,
            (true, SortKey::Messages, false) => ROOT_MESSAGES_ACTIVE,
            (true, SortKey::Messages, true) => ROOT_MESSAGES_ALL,
            (true, SortKey::Tokens, false) => ROOT_TOKENS_ACTIVE,
            (true, SortKey::Tokens, true) => ROOT_TOKENS_ALL,
            (_, SortKey::Updated, _) => "s.updated_at",
            (_, SortKey::Created, _) => "s.created_at",
            (_, SortKey::Messages, _) => "s.message_count",
            (_, SortKey::Tokens, _) => "COALESCE(s.tokens_used, 0)",
        };
        let order_dir = if f.ascending { "ASC" } else { "DESC" };
        let pin_order = pin_order(f);

        let conn = self.read.lock().unwrap();
        let total: i64 = conn.query_row(
            &format!(
                "SELECT COUNT(*) FROM sessions s LEFT JOIN user_data u ON u.session_key = s.key {where_sql}"
            ),
            rusqlite::params_from_iter(args.iter().map(|b| b.as_ref())),
            |r| r.get(0),
        )?;

        let selected_cols = if f.roots_only {
            if f.include_archived {
                ROOT_SESSION_COLS_ALL
            } else {
                ROOT_SESSION_COLS_ACTIVE
            }
        } else {
            SESSION_COLS
        };
        let sql = format!(
            "SELECT {selected_cols} FROM sessions s LEFT JOIN user_data u ON u.session_key = s.key
             {where_sql}
             ORDER BY {pin_order}{order_col} {order_dir}, s.key ASC LIMIT ? OFFSET ?"
        );
        let mut stmt = conn.prepare_cached(&sql)?;
        let limit = if f.limit > 0 { f.limit } else { 500 };
        args.push(Box::new(limit));
        args.push(Box::new(f.offset));
        let rows = stmt.query_map(
            rusqlite::params_from_iter(args.iter().map(|b| b.as_ref())),
            row_to_meta,
        )?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok((out, total))
    }

    /// 当前筛选下各根会话可见的直接子会话数。Grok 关系在入库时已扁平到
    /// root，因此一次 GROUP BY 足够覆盖任意原始嵌套深度。
    pub fn child_counts(&self, f: &SessionFilter) -> Result<HashMap<String, i64>> {
        let (where_sql, args) = child_filter_sql(f, None);
        let conn = self.read.lock().unwrap();
        let sql = format!(
            "SELECT s.parent_key, COUNT(*)
             FROM sessions s LEFT JOIN user_data u ON u.session_key = s.key
             {where_sql} GROUP BY s.parent_key"
        );
        let mut stmt = conn.prepare_cached(&sql)?;
        let rows = stmt.query_map(
            rusqlite::params_from_iter(args.iter().map(|arg| arg.as_ref())),
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )?;
        let mut counts = HashMap::new();
        for row in rows {
            let (key, count) = row?;
            if !key.is_empty() {
                counts.insert(key, count);
            }
        }
        Ok(counts)
    }

    pub fn list_children(&self, parent_key: &str, f: &SessionFilter) -> Result<Vec<SessionMeta>> {
        let (where_sql, args) = child_filter_sql(f, Some(parent_key));
        let order_col = match f.sort {
            SortKey::Updated => "s.updated_at",
            SortKey::Created => "s.created_at",
            SortKey::Messages => "s.message_count",
            SortKey::Tokens => "COALESCE(s.tokens_used, 0)",
        };
        let order_dir = if f.ascending { "ASC" } else { "DESC" };
        let pin_order = pin_order(f);
        let conn = self.read.lock().unwrap();
        let sql = format!(
            "SELECT {SESSION_COLS}
             FROM sessions s LEFT JOIN user_data u ON u.session_key = s.key
             {where_sql}
             ORDER BY {pin_order}{order_col} {order_dir}, s.key ASC"
        );
        let mut stmt = conn.prepare_cached(&sql)?;
        let rows = stmt.query_map(
            rusqlite::params_from_iter(args.iter().map(|arg| arg.as_ref())),
            row_to_meta,
        )?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn parent_key_of(&self, key: &str) -> Result<Option<String>> {
        let conn = self.read.lock().unwrap();
        let value: Option<String> = conn
            .prepare_cached("SELECT NULLIF(parent_key, '') FROM sessions WHERE key = ?1")?
            .query_row(params![key], |row| row.get(0))
            .optional()?
            .flatten();
        Ok(value)
    }

    /// 删除确认使用：不受当前列表筛选和 archived 状态影响，递归取完整子树。
    pub fn all_descendants(&self, key: &str) -> Result<Vec<SessionMeta>> {
        let conn = self.read.lock().unwrap();
        let sql = format!(
            "WITH RECURSIVE descendants(key) AS (
               SELECT key FROM sessions WHERE parent_key = ?1
               UNION
               SELECT child.key FROM sessions child
               JOIN descendants parent ON child.parent_key = parent.key
             )
             SELECT {SESSION_COLS}
             FROM sessions s
             JOIN descendants d ON d.key = s.key
             LEFT JOIN user_data u ON u.session_key = s.key
             ORDER BY s.created_at, s.key"
        );
        let mut stmt = conn.prepare_cached(&sql)?;
        let rows = stmt.query_map(params![key], row_to_meta)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn get_session(&self, key: &str) -> Result<Option<SessionMeta>> {
        let conn = self.read.lock().unwrap();
        let sql = format!(
            "SELECT {SESSION_COLS} FROM sessions s LEFT JOIN user_data u ON u.session_key = s.key WHERE s.key = ?1"
        );
        Ok(conn.query_row(&sql, params![key], row_to_meta).optional()?)
    }

    /// 按原生 id 反查(wake-mcp 的 key 兜底:对方常只拿到 resume 用的那个 id)。
    /// 同 UUID 在多台 host 各续跑过会多于一行,由调用方裁决
    pub fn find_by_native_id(&self, native_id: &str) -> Result<Vec<SessionMeta>> {
        let conn = self.read.lock().unwrap();
        let sql = format!(
            "SELECT {SESSION_COLS} FROM sessions s LEFT JOIN user_data u ON u.session_key = s.key
             WHERE s.native_id = ?1 ORDER BY s.key"
        );
        let mut stmt = conn.prepare_cached(&sql)?;
        let rows = stmt.query_map(params![native_id], row_to_meta)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// 项目清单(根会话按 project_path 聚合)。GUI 侧栏与 wake_list_projects 传
    /// false 只算未归档;wake-mcp 解析 `project` 参数时传 true——搜索本身覆盖
    /// 归档会话,只剩归档会话的项目不能在解析这一步就被挡掉
    pub fn list_projects(&self, include_archived: bool) -> Result<Vec<ProjectInfo>> {
        let (root_updated, root_cond, archived) = if include_archived {
            (ROOT_UPDATED_ALL, ROOT_IGNORING_ARCHIVED, "")
        } else {
            (
                ROOT_UPDATED_ACTIVE,
                ROOT_WHEN_HIDING_ARCHIVED,
                "s.archived = 0 AND ",
            )
        };
        let conn = self.read.lock().unwrap();
        let mut stmt = conn.prepare_cached(&format!(
            "SELECT s.project_path, s.project_name, COUNT(*), MAX({root_updated}) AS activity
             FROM sessions s
             WHERE {archived}{root_cond}
             GROUP BY s.project_path ORDER BY activity DESC"
        ))?;
        let rows = stmt.query_map([], |r| {
            Ok(ProjectInfo {
                path: r.get(0)?,
                name: r.get(1)?,
                session_count: r.get(2)?,
                last_active: r.get(3)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn list_workspace_roots(&self) -> Result<Vec<WorkspaceRoot>> {
        let conn = self.read.lock().unwrap();
        let sql = if self.workspace_root_sources {
            "SELECT path, name FROM workspace_roots WHERE source = 'manual' ORDER BY lower(name), lower(path)"
        } else {
            // A sidecar MCP/CLI may open a database before the GUI has run
            // the lightweight schema migration. Treat legacy rows as hidden
            // here; the GUI will classify them as session_seed on next open.
            "SELECT path, name FROM workspace_roots WHERE 0"
        };
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map([], |row| {
            Ok(WorkspaceRoot {
                path: row.get(0)?,
                name: row.get(1)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub(crate) fn list_workspace_roots_for_watcher(&self) -> Result<Vec<(WorkspaceRoot, bool)>> {
        let conn = self.read.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT path, name, imported_at FROM workspace_roots
             WHERE source = 'manual' ORDER BY lower(name), lower(path)",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                WorkspaceRoot {
                    path: row.get(0)?,
                    name: row.get(1)?,
                },
                row.get::<_, Option<i64>>(2)?.is_some(),
            ))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub(crate) fn mark_workspace_root_imported(&self, path: &str) -> Result<()> {
        let conn = self.write.lock().unwrap();
        conn.execute(
            "UPDATE workspace_roots SET imported_at = ?1
             WHERE path = ?2 COLLATE NOCASE AND source = 'manual'",
            params![now_ms(), path],
        )?;
        Ok(())
    }

    pub fn add_workspace_root(&self, path: &Path) -> Result<WorkspaceRoot> {
        let canonical = std::fs::canonicalize(path)
            .with_context(|| format!("could not resolve workspace path {}", path.display()))?;
        anyhow::ensure!(
            canonical.is_dir(),
            "workspace path is not a directory: {}",
            canonical.display()
        );
        let path = canonical.to_string_lossy().to_string();
        let name = canonical
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or(&path)
            .to_string();
        let conn = self.write.lock().unwrap();
        conn.execute(
            "INSERT INTO workspace_roots(path, name, added_at, source, imported_at)
             VALUES (?1, ?2, ?3, 'manual', NULL)
             ON CONFLICT(path) DO UPDATE SET
               name = excluded.name, source = 'manual', imported_at = NULL",
            params![path, name, now_ms()],
        )?;
        let (path, name) = conn.query_row(
            "SELECT path, name FROM workspace_roots WHERE path = ?1 COLLATE NOCASE",
            params![path],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?;
        Ok(WorkspaceRoot { path, name })
    }

    pub fn remove_workspace_root(&self, path: &str) -> Result<()> {
        let conn = self.write.lock().unwrap();
        conn.execute(
            "DELETE FROM workspace_roots WHERE path = ?1 COLLATE NOCASE",
            params![path],
        )?;
        Ok(())
    }

    /// Persist an observed file state and emit an event when its content differs
    /// from the last indexed state. Initial imports use the same snapshot/event
    /// path as live changes, matching ZFileTimeMachine's activity model.
    pub fn observe_workspace_file(
        &self,
        project_path: &str,
        file_path: &str,
        observation: WorkspaceFileObservation,
        mode: WorkspaceObservationMode,
        observed_at: i64,
    ) -> Result<Option<WorkspaceChangeEvent>> {
        Ok(self
            .observe_workspace_files(
                project_path,
                vec![(file_path.to_string(), observation)],
                mode,
                observed_at,
            )?
            .into_iter()
            .next())
    }

    pub fn observe_workspace_files(
        &self,
        project_path: &str,
        observations: Vec<(String, WorkspaceFileObservation)>,
        mode: WorkspaceObservationMode,
        observed_at: i64,
    ) -> Result<Vec<WorkspaceChangeEvent>> {
        anyhow::ensure!(!project_path.is_empty(), "workspace project path is empty");
        anyhow::ensure!(
            observations.iter().all(|(path, _)| !path.is_empty()),
            "workspace file path is empty"
        );

        let mut conn = self.write.lock().unwrap();
        let tx = conn.transaction()?;
        let mut events = Vec::new();
        for (file_path, observation) in observations {
            let previous: Option<(String, i64)> = tx
                .query_row(
                    "SELECT content_hash, size_bytes FROM workspace_file_state
                     WHERE project_path = ?1 COLLATE NOCASE
                       AND file_path = ?2 COLLATE NOCASE",
                    params![project_path, file_path],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;

            let event = match observation {
                WorkspaceFileObservation::Present {
                    bytes,
                    file_mtime,
                    capture_text,
                } => {
                    let hash = format!("{:x}", Sha256::digest(&bytes));
                    let size_bytes = i64::try_from(bytes.len()).unwrap_or(i64::MAX);
                    let text_content = (capture_text
                        && bytes.len() <= WORKSPACE_TEXT_SNAPSHOT_LIMIT
                        && !bytes.contains(&0)
                        && std::str::from_utf8(&bytes).is_ok())
                    .then_some(bytes.as_slice());
                    tx.execute(
                        "INSERT OR IGNORE INTO workspace_file_snapshots
                           (content_hash, content, is_text, size_bytes, captured_at)
                         VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![
                            hash,
                            text_content,
                            text_content.is_some() as i64,
                            size_bytes,
                            observed_at
                        ],
                    )?;

                    let kind = if mode == WorkspaceObservationMode::Import {
                        Some(WorkspaceChangeKind::Created)
                    } else {
                        match previous.as_ref() {
                            Some((previous_hash, _)) if previous_hash == &hash => None,
                            Some(_) => Some(WorkspaceChangeKind::Modified),
                            None => Some(WorkspaceChangeKind::Created),
                        }
                    };
                    let event = if kind.is_some()
                        && (mode == WorkspaceObservationMode::Import || previous.is_some())
                    {
                        Some(insert_workspace_change(
                            &tx,
                            project_path,
                            &file_path,
                            kind.unwrap(),
                            observed_at,
                            (mode != WorkspaceObservationMode::Import)
                                .then(|| previous.as_ref().map(|(hash, _)| hash.as_str()))
                                .flatten(),
                            Some(&hash),
                        )?)
                    } else {
                        None
                    };

                    tx.execute(
                        "DELETE FROM workspace_file_state
                         WHERE project_path = ?1 COLLATE NOCASE
                           AND file_path = ?2 COLLATE NOCASE",
                        params![project_path, file_path],
                    )?;
                    tx.execute(
                        "INSERT INTO workspace_file_state
                           (project_path, file_path, content_hash, file_mtime, size_bytes, observed_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                         ON CONFLICT(project_path, file_path) DO UPDATE SET
                           content_hash = excluded.content_hash,
                           file_mtime = excluded.file_mtime,
                           size_bytes = excluded.size_bytes,
                           observed_at = excluded.observed_at",
                        params![project_path, file_path, hash, file_mtime, size_bytes, observed_at],
                    )?;
                    event
                }
                WorkspaceFileObservation::Deleted => {
                    let event = if let Some((previous_hash, _)) = previous.as_ref() {
                        tx.execute(
                            "DELETE FROM workspace_file_state WHERE project_path = ?1 AND file_path = ?2",
                            params![project_path, file_path],
                        )?;
                        Some(insert_workspace_change(
                            &tx,
                            project_path,
                            &file_path,
                            WorkspaceChangeKind::Deleted,
                            observed_at,
                            Some(previous_hash),
                            None,
                        )?)
                    } else {
                        None
                    };
                    event
                }
            };
            if let Some(event) = event {
                events.push(event);
            }
        }
        tx.commit()?;
        Ok(events)
    }

    pub fn list_workspace_file_paths(&self, project_path: &str) -> Result<Vec<String>> {
        let conn = self.read.lock().unwrap();
        let mut stmt = conn.prepare_cached(
            "SELECT file_path FROM workspace_file_state WHERE project_path = ?1 COLLATE NOCASE",
        )?;
        let rows = stmt.query_map(params![project_path], |row| row.get(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn delete_workspace_files(
        &self,
        project_path: &str,
        file_paths: &[String],
        observed_at: i64,
    ) -> Result<Vec<WorkspaceChangeEvent>> {
        anyhow::ensure!(!project_path.is_empty(), "workspace project path is empty");
        let mut conn = self.write.lock().unwrap();
        let tx = conn.transaction()?;
        let mut events = Vec::new();
        for file_path in file_paths {
            let hash: Option<String> = tx
                .query_row(
                    "SELECT content_hash FROM workspace_file_state
                     WHERE project_path = ?1 COLLATE NOCASE
                       AND file_path = ?2 COLLATE NOCASE",
                    params![project_path, file_path],
                    |row| row.get(0),
                )
                .optional()?;
            let Some(hash) = hash else {
                continue;
            };
            tx.execute(
                "DELETE FROM workspace_file_state
                 WHERE project_path = ?1 COLLATE NOCASE AND file_path = ?2 COLLATE NOCASE",
                params![project_path, file_path],
            )?;
            events.push(insert_workspace_change(
                &tx,
                project_path,
                file_path,
                WorkspaceChangeKind::Deleted,
                observed_at,
                Some(&hash),
                None,
            )?);
        }
        tx.commit()?;
        Ok(events)
    }

    /// Record a removed file or directory and all indexed descendants.
    pub fn delete_workspace_path(
        &self,
        project_path: &str,
        file_path: &str,
        observed_at: i64,
    ) -> Result<Vec<WorkspaceChangeEvent>> {
        anyhow::ensure!(!project_path.is_empty(), "workspace project path is empty");

        let mut conn = self.write.lock().unwrap();
        let tx = conn.transaction()?;
        let mut stmt = tx.prepare(
            "SELECT file_path, content_hash FROM workspace_file_state
             WHERE project_path = ?1 COLLATE NOCASE
               AND (?2 = '' OR file_path = ?2
                    OR substr(file_path, 1, length(?2) + 1) = ?2 || '/')",
        )?;
        let rows = stmt.query_map(params![project_path, file_path], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let files = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);

        let mut events = Vec::with_capacity(files.len());
        for (path, hash) in files {
            tx.execute(
                "DELETE FROM workspace_file_state
                 WHERE project_path = ?1 COLLATE NOCASE AND file_path = ?2 COLLATE NOCASE",
                params![project_path, path],
            )?;
            events.push(insert_workspace_change(
                &tx,
                project_path,
                &path,
                WorkspaceChangeKind::Deleted,
                observed_at,
                Some(&hash),
                None,
            )?);
        }
        tx.commit()?;
        Ok(events)
    }

    /// List one project's timeline newest-first. `before` is the last
    /// (observed_at, id) pair from the previous page.
    pub fn list_workspace_change_events(
        &self,
        project_path: &str,
        from_ms: Option<i64>,
        to_ms: Option<i64>,
        before: Option<(i64, i64)>,
        limit: i64,
    ) -> Result<Vec<WorkspaceChangeEvent>> {
        let conn = self.read.lock().unwrap();
        let mut stmt = conn.prepare_cached(
            "SELECT id, project_path, file_path, change_kind, observed_at,
                    before_hash, after_hash
             FROM workspace_change_events
             WHERE project_path = ?1 COLLATE NOCASE
               AND (?2 IS NULL OR observed_at >= ?2)
               AND (?3 IS NULL OR observed_at < ?3)
               AND (?4 IS NULL OR observed_at < ?4 OR (observed_at = ?4 AND id < ?5))
             ORDER BY observed_at DESC, id DESC LIMIT ?6",
        )?;
        let rows = stmt.query_map(
            params![
                project_path,
                from_ms,
                to_ms,
                before.map(|(timestamp, _)| timestamp),
                before.map(|(_, id)| id),
                limit.clamp(1, 500)
            ],
            |row| {
                let kind: String = row.get(3)?;
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    kind,
                    row.get::<_, i64>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            },
        )?;
        rows.map(|row| {
            let (id, project_path, file_path, kind, observed_at, before_hash, after_hash) =
                row?;
            Ok(WorkspaceChangeEvent {
                id,
                project_path,
                file_path,
                kind: WorkspaceChangeKind::parse(&kind)?,
                observed_at,
                before_hash,
                after_hash,
            })
        })
        .collect()
    }

    pub fn workspace_change_detail(&self, id: i64) -> Result<Option<WorkspaceChangeDetail>> {
        let conn = self.read.lock().unwrap();
        let row = conn
            .query_row(
                "SELECT e.id, e.project_path, e.file_path, e.change_kind,
                        e.observed_at, e.before_hash, e.after_hash,
                        before.content, after.content
                 FROM workspace_change_events e
                 LEFT JOIN workspace_file_snapshots before ON before.content_hash = e.before_hash
                 LEFT JOIN workspace_file_snapshots after ON after.content_hash = e.after_hash
                 WHERE e.id = ?1",
                params![id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, Option<Vec<u8>>>(7)?,
                        row.get::<_, Option<Vec<u8>>>(8)?,
                    ))
                },
            )
            .optional()?;
        row.map(
            |(
                id,
                project_path,
                file_path,
                kind,
                observed_at,
                before_hash,
                after_hash,
                before_text,
                after_text,
            )| {
                Ok(WorkspaceChangeDetail {
                    event: WorkspaceChangeEvent {
                        id,
                        project_path,
                        file_path,
                        kind: WorkspaceChangeKind::parse(&kind)?,
                        observed_at,
                        before_hash,
                        after_hash,
                    },
                    before_text: before_text
                        .map(String::from_utf8)
                        .transpose()
                        .context("stored workspace snapshot is not UTF-8")?,
                    after_text: after_text
                        .map(String::from_utf8)
                        .transpose()
                        .context("stored workspace snapshot is not UTF-8")?,
                })
            },
        )
        .transpose()
    }

    pub fn starred_count(&self) -> Result<i64> {
        let conn = self.read.lock().unwrap();
        Ok(conn.query_row(
            // archived 过滤与 agent_counts/list_projects 同口径,徽标数 = 点开后可见数
            "SELECT COUNT(*) FROM user_data u JOIN sessions s ON s.key = u.session_key WHERE u.favorite = 1 AND s.archived = 0",
            [],
            |r| r.get(0),
        )?)
    }

    // ---------- 记忆(agent 写的 Markdown,只读镜像) ----------

    /// 一组 (agent, host) 的记忆整体对齐到 `docs`:多出的删、变了的换(按 updated_at、
    /// size 与归属锚点 / 项目判,正文不比)、没变的不动;返回有没有改动。同 key
    /// 重复后者胜。这是 memories / memories_fts 的**唯一写点**(rebuild_all 只清空)
    pub fn replace_memories(
        &self,
        agent: AgentId,
        host: &str,
        docs: &[MemoryDoc],
        frozen: &[String],
    ) -> Result<bool> {
        let mut conn = self.write.lock().unwrap();
        let tx = conn.transaction()?;
        // key → (id, 指纹);指纹 = (updated_at, size, session_key, project_path, source, title):
        // 锚点换了(目录里来了更新的会话)同样要重写,否则项目归属定格在首次入库那一刻;
        // 来源换了(同一文件从自定义变成默认)也重写;标题也在指纹里——标题是从文件派生
        // 的,派生规则换了(2026-09-21 改成文件名带扩展名)文件没变也要跟上,正文不比
        type Stamp = (i64, i64, String, String, String, String);
        let existing: HashMap<String, (i64, Stamp)> = {
            let mut stmt = tx.prepare_cached(
                "SELECT key, id, updated_at, size_bytes, session_key, project_path, source, title
                 FROM memories WHERE agent_id = ?1 AND host = ?2",
            )?;
            let rows = stmt.query_map(params![agent.as_str(), host], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    (
                        r.get::<_, i64>(1)?,
                        (
                            r.get(2)?,
                            r.get(3)?,
                            r.get(4)?,
                            r.get(5)?,
                            r.get(6)?,
                            r.get(7)?,
                        ),
                    ),
                ))
            })?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let unchanged = |s: &Stamp, d: &MemoryDoc| {
            s.0 == d.updated_at
                && s.1 == d.size_bytes
                && s.2 == d.session_key
                && s.3 == d.project_path
                && s.4 == d.source
                && s.5 == d.title
        };
        // 同 key 重复**前者胜**:docs 按来源计划的顺序读入(默认来源 → 项目模式 → 自定义,
        // 默认实例 → 自定义实例),先到的是默认那份——自定义目录盖住默认文件(加 ~/.claude
        // 当自定义目录,里面的 CLAUDE.md 已是默认来源)时计数与开关才落在默认行上,而不是
        // 默认行显示 0 份、关掉也不生效(2026-09-22 review)。先按 key 收成一份再写,不然
        // 写了第一份、第二份与库里相同被跳过,胜负就看谁先到库里
        let mut latest: std::collections::BTreeMap<&str, &MemoryDoc> =
            std::collections::BTreeMap::new();
        for d in docs {
            latest.entry(d.key.as_str()).or_insert(d);
        }
        let mut changed = false;
        for d in latest.values() {
            if existing.get(&d.key).is_some_and(|(_, s)| unchanged(s, d)) {
                continue;
            }
            upsert_memory(&tx, d)?;
            changed = true;
        }
        // `frozen` 是这一轮读失败的实例的来源 id:那些来源的行不删(它们没出现在 docs
        // 里只是因为读不出,不是文件没了)
        let mut stmt_fts = tx.prepare_cached("DELETE FROM memories_fts WHERE rowid = ?1")?;
        let mut stmt_row = tx.prepare_cached("DELETE FROM memories WHERE key = ?1")?;
        for (key, (id, stamp)) in existing.iter() {
            if latest.contains_key(key.as_str()) || frozen.contains(&stamp.4) {
                continue;
            }
            stmt_fts.execute(params![id])?;
            stmt_row.execute(params![key])?;
            changed = true;
        }
        drop(stmt_fts);
        drop(stmt_row);
        tx.commit()?;
        Ok(changed)
    }

    /// Settings → Memory locations 的计数:每个 (agent, 来源 id) 有多少份
    pub fn memory_source_counts(&self) -> Result<HashMap<(String, String), i64>> {
        let conn = self.read.lock().unwrap();
        let mut stmt =
            conn.prepare_cached("SELECT agent_id, source, COUNT(*) FROM memories GROUP BY 1, 2")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                (r.get::<_, String>(0)?, r.get::<_, String>(1)?),
                r.get::<_, i64>(2)?,
            ))
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// 已索引的本地项目根(host 为空、路径非空),给记忆的项目模式(`<project>/CLAUDE.md`
    /// 一类)展开;远程会话的项目是别的机器上的路径,不在其中
    pub fn local_project_roots(&self) -> Result<Vec<PathBuf>> {
        let conn = self.read.lock().unwrap();
        let mut stmt = conn.prepare_cached(
            "SELECT DISTINCT project_path FROM sessions
             WHERE host = '' AND project_path != '' ORDER BY project_path",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        Ok(rows
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .map(PathBuf::from)
            .collect())
    }

    // ---------- Skill project folders ----------

    /// Project roots explicitly added from the Skills page. Only the roots are persisted;
    /// Skill contents remain filesystem-backed.
    pub fn list_skill_project_roots(&self) -> Result<Vec<PathBuf>> {
        let conn = self.read.lock().unwrap();
        let mut stmt =
            conn.prepare_cached("SELECT path FROM skill_project_roots ORDER BY added_at, path")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        Ok(rows
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .map(PathBuf::from)
            .collect())
    }

    /// Returns true when a new root was inserted and false when it was already present.
    pub fn add_skill_project_root(&self, path: &Path) -> Result<bool> {
        let conn = self.write.lock().unwrap();
        Ok(conn.execute(
            "INSERT OR IGNORE INTO skill_project_roots(path, added_at) VALUES (?1, ?2)",
            params![path.to_string_lossy(), now_ms()],
        )? > 0)
    }

    pub fn remove_skill_project_root(&self, path: &Path) -> Result<()> {
        let conn = self.write.lock().unwrap();
        conn.execute(
            "DELETE FROM skill_project_roots WHERE path = ?1",
            params![path.to_string_lossy()],
        )?;
        Ok(())
    }

    // ---------- 记忆来源配置(Settings → Memory locations) ----------

    /// 与 Session locations 同一层级的用户数据:自定义来源(目录或文件)与被停用的
    /// 默认来源(按 `MemorySource::id`),重扫不动它。对外只有 `memory_source_overrides`
    /// 一次取齐
    fn list_memory_sources_custom(&self) -> Result<Vec<(String, String)>> {
        let conn = self.read.lock().unwrap();
        let mut stmt = conn.prepare_cached(
            "SELECT agent, path FROM memory_sources_custom ORDER BY added_at, path",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn add_memory_source(&self, agent: &str, path: &str) -> Result<()> {
        let conn = self.write.lock().unwrap();
        insert_memory_source(&conn, agent, path)
    }

    /// 删自定义来源,连同它的停用记录(日后重新添加同一路径要按启用开始)
    pub fn remove_memory_source(&self, agent: &str, path: &str) -> Result<()> {
        let mut conn = self.write.lock().unwrap();
        let tx = conn.transaction()?;
        delete_memory_source(&tx, agent, path)?;
        tx.commit()?;
        Ok(())
    }

    /// 编辑自定义来源:删旧记新,一个事务(半程失败不得半生效)
    pub fn replace_memory_source(
        &self,
        old_agent: &str,
        old_path: &str,
        new_agent: &str,
        new_path: &str,
    ) -> Result<()> {
        let mut conn = self.write.lock().unwrap();
        let tx = conn.transaction()?;
        delete_memory_source(&tx, old_agent, old_path)?;
        insert_memory_source(&tx, new_agent, new_path)?;
        tx.commit()?;
        Ok(())
    }

    fn list_memory_sources_disabled(&self) -> Result<Vec<(String, String)>> {
        let conn = self.read.lock().unwrap();
        let mut stmt = conn.prepare_cached(
            "SELECT agent, source FROM memory_sources_disabled ORDER BY disabled_at, source",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// 来源开关的唯一写入口。enabled=true 删停用标记;false 幂等记入
    pub fn set_memory_source_enabled(
        &self,
        agent: &str,
        source: &str,
        enabled: bool,
    ) -> Result<()> {
        let conn = self.write.lock().unwrap();
        if enabled {
            conn.execute(
                "DELETE FROM memory_sources_disabled WHERE agent = ?1 AND source = ?2",
                params![agent, source],
            )?;
        } else {
            conn.execute(
                "INSERT OR IGNORE INTO memory_sources_disabled(agent, source, disabled_at)
                 VALUES (?1, ?2, ?3)",
                params![agent, source, now_ms()],
            )?;
        }
        Ok(())
    }

    /// Restore defaults:清空自定义来源与停用记录
    pub fn clear_memory_source_overrides(&self) -> Result<()> {
        let conn = self.write.lock().unwrap();
        conn.execute_batch(
            "DELETE FROM memory_sources_custom;
             DELETE FROM memory_sources_disabled;",
        )?;
        Ok(())
    }

    /// 记忆来源配置一次取齐,解析成模型层类型;未识别的 agent 名静默跳过。停用表给
    /// 集合——调用方都是按 (agent, 来源 id) 查它。scanner 与 Settings 共用。读失败原样
    /// 报 Err:scanner 拿它做"按缺席删",折成"什么都没配置"会删光项目指令文件、把停用的
    /// 来源重新索引进来(2026-09-22 review);Settings 只是显示,自己 unwrap_or_default
    pub fn memory_source_overrides(
        &self,
    ) -> Result<(
        Vec<(AgentId, PathBuf)>,
        std::collections::HashSet<(AgentId, String)>,
    )> {
        let customs = self
            .list_memory_sources_custom()?
            .into_iter()
            .filter_map(|(a, p)| AgentId::from_str(&a).map(|a| (a, PathBuf::from(p))))
            .collect();
        let disabled = self
            .list_memory_sources_disabled()?
            .into_iter()
            .filter_map(|(a, s)| AgentId::from_str(&a).map(|a| (a, s)))
            .collect();
        Ok((customs, disabled))
    }

    /// 库里现有记忆的 (agent, host) 分组——scanner 拿它对照当前 roster,不再配置的来源
    /// (删掉的远程 host、停用的 agent)整组清掉
    pub fn memory_groups(&self) -> Result<Vec<(AgentId, String)>> {
        let conn = self.read.lock().unwrap();
        let mut stmt = conn.prepare_cached("SELECT DISTINCT agent_id, host FROM memories")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut out = Vec::new();
        for r in rows {
            let (agent, host) = r?;
            if let Some(agent) = AgentId::from_str(&agent) {
                out.push((agent, host));
            }
        }
        Ok(out)
    }

    /// Memory 页侧栏的计数:agent 按 AgentId 声明序(与会话侧栏同序,计数平局不抖),
    /// 项目按最近更新降序、没归属的一项(path 为空)垫底。项目按读时解析的归属算,
    /// 与 list_memories 同一口径:**项目行只数项目记忆**(GUI 的项目行喂
    /// `UserMemories::Excluded`),用户级另给 `user`——曾把用户级加进每个项目行
    /// (2026-09-21 review),用户 2026-09-22 定用户记忆不进项目、自成一行;两种口径
    /// 下都是点开看到多少行、徽章就是多少
    pub fn memory_counts(&self) -> Result<MemoryCounts> {
        let conn = self.read.lock().unwrap();
        let mut stmt = conn.prepare_cached(&format!(
            "SELECT m.agent_id, {MEMORY_PROJECT},
                    COALESCE(NULLIF(m.project_name, ''), s.project_name, ''),
                    m.scope, COUNT(*), MAX(m.updated_at)
             FROM memories m {MEMORY_SESSION_JOIN}
             GROUP BY 1, 2, 3, 4"
        ))?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, i64>(5)?,
            ))
        })?;
        let mut counts = MemoryCounts::default();
        let mut agents: HashMap<AgentId, i64> = HashMap::new();
        let mut projects: HashMap<String, MemoryProject> = HashMap::new();
        let mut user_level = 0i64;
        for r in rows {
            let (agent, path, name, scope, n, last) = r?;
            let Some(agent) = AgentId::from_str(&agent) else {
                continue;
            };
            counts.total += n;
            *agents.entry(agent).or_default() += n;
            if scope == MemoryScope::User.as_str() {
                user_level += n;
                continue;
            }
            let p = projects
                .entry(path.clone())
                .or_insert_with(|| MemoryProject {
                    path,
                    name,
                    count: 0,
                    updated_at: 0,
                });
            p.count += n;
            p.updated_at = p.updated_at.max(last);
        }
        counts.user = user_level;
        counts.agents = agents.into_iter().collect();
        counts.agents.sort_by_key(|(agent, _)| *agent);
        counts.projects = projects.into_values().collect();
        counts.projects.sort_by(|a, b| {
            a.path
                .is_empty()
                .cmp(&b.path.is_empty())
                .then_with(|| b.updated_at.cmp(&a.updated_at))
                .then_with(|| a.path.cmp(&b.path))
        });
        Ok(counts)
    }

    /// 记忆列表:项目级按项目路径成组、组内新到旧,没归属的一组排在项目之后,
    /// 用户级(对每个项目都成立)最后;项目筛选下用户级照列(`f.user` 默认 Alongside,
    /// GUI 的项目行 Excluded、User memory 行 Only)。**`limit` 只封项目级**:
    /// 用户级排在最后,一刀切的 LIMIT 砍掉的正是筛选特意放进来的那几份(2026-09-21
    /// review),所以项目级带 LIMIT 查、用户级不限量另查再接上。**行里 body 是空串**
    /// (`MEMORY_LIST_COLS`),要正文走 `get_memory`
    pub fn list_memories(&self, f: &MemoryFilter) -> Result<Vec<MemoryDoc>> {
        let (filter_sql, args) = memory_filter(f);
        let user = MemoryScope::User.as_str();
        let conn = self.read.lock().unwrap();
        let order = format!(
            "ORDER BY m.scope = '{user}', {MEMORY_PROJECT} = '', {MEMORY_PROJECT},
                      m.updated_at DESC, m.key"
        );
        if f.limit <= 0 {
            let mut stmt = conn.prepare_cached(&format!(
                "SELECT {MEMORY_LIST_COLS} FROM memories m {MEMORY_SESSION_JOIN}
                 WHERE 1 = 1{filter_sql} {order}"
            ))?;
            let rows = stmt.query_map(
                rusqlite::params_from_iter(args.iter().map(|b| b.as_ref())),
                row_to_memory,
            )?;
            return Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?);
        }
        let mut out = {
            let mut stmt = conn.prepare_cached(&format!(
                "SELECT {MEMORY_LIST_COLS} FROM memories m {MEMORY_SESSION_JOIN}
                 WHERE m.scope != '{user}'{filter_sql} {order} LIMIT ?"
            ))?;
            let limit: Box<dyn rusqlite::ToSql> = Box::new(f.limit);
            let rows = stmt.query_map(
                rusqlite::params_from_iter(
                    args.iter()
                        .chain(std::iter::once(&limit))
                        .map(|b| b.as_ref()),
                ),
                row_to_memory,
            )?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        let mut stmt = conn.prepare_cached(&format!(
            "SELECT {MEMORY_LIST_COLS} FROM memories m {MEMORY_SESSION_JOIN}
             WHERE m.scope = '{user}'{filter_sql} {order}"
        ))?;
        let rows = stmt.query_map(
            rusqlite::params_from_iter(args.iter().map(|b| b.as_ref())),
            row_to_memory,
        )?;
        out.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);
        Ok(out)
    }

    pub fn get_memory(&self, key: &str) -> Result<Option<MemoryDoc>> {
        let conn = self.read.lock().unwrap();
        let mut stmt = conn.prepare_cached(&format!(
            "SELECT {MEMORY_COLS} FROM memories m {MEMORY_SESSION_JOIN} WHERE m.key = ?1"
        ))?;
        Ok(stmt.query_row(params![key], row_to_memory).optional()?)
    }

    /// 记忆全文搜索(标题 + 正文),与会话搜索同一套分词与 <3 码点降级规则;命中按
    /// bm25 排、snippet 取自正文。筛选同 list_memories
    pub fn search_memories(&self, q: &str, f: &MemoryFilter) -> Result<Vec<MemoryHit>> {
        let segs = fts_terms(q);
        if segs.is_empty() {
            return Ok(Vec::new());
        }
        let limit = if f.limit > 0 { f.limit } else { 20 };
        let (filter_sql, filter_args) = memory_filter(f);
        let conn = self.read.lock().unwrap();
        let mut out = Vec::new();
        if !needs_like_fallback(&segs) {
            let mut stmt = conn.prepare_cached(&format!(
                "SELECT {MEMORY_COLS}, snippet(memories_fts, 1, ?, ?, '…', 16)
                 FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
                 {MEMORY_SESSION_JOIN}
                 WHERE memories_fts MATCH ?{filter_sql}
                 ORDER BY bm25(memories_fts) LIMIT ?"
            ))?;
            let mut all_args: Vec<Box<dyn rusqlite::ToSql>> = vec![
                Box::new(HL_OPEN.to_string()),
                Box::new(HL_CLOSE.to_string()),
                Box::new(fts_match_expr(&segs)),
            ];
            all_args.extend(filter_args);
            all_args.push(Box::new(limit));
            let rows = stmt.query_map(
                rusqlite::params_from_iter(all_args.iter().map(|b| b.as_ref())),
                |r| {
                    Ok(MemoryHit {
                        doc: row_to_memory(r)?,
                        // snippet 是 SELECT 里跟在 memory_cols! 后面的最后一列,按列数取——写死下标加列时
                        // 顶错过一次(2026-09-21)
                        snippet: r.get(r.as_ref().column_count() - 1)?,
                    })
                },
            )?;
            for r in rows {
                out.push(r?);
            }
        } else {
            let like_where = like_where(&["m.title", "m.body"], segs.len());
            let mut stmt = conn.prepare_cached(&format!(
                "SELECT {MEMORY_COLS} FROM memories m {MEMORY_SESSION_JOIN}
                 WHERE {like_where}{filter_sql}
                 ORDER BY m.updated_at DESC LIMIT ?"
            ))?;
            let mut all_args = like_args(&segs, 2);
            all_args.extend(filter_args);
            all_args.push(Box::new(limit));
            let rows = stmt.query_map(
                rusqlite::params_from_iter(all_args.iter().map(|b| b.as_ref())),
                row_to_memory,
            )?;
            for r in rows {
                let doc = r?;
                let snippet = make_like_snippet(&doc.body, segs[0]);
                out.push(MemoryHit { doc, snippet });
            }
        }
        Ok(out)
    }

    pub fn agent_counts(&self) -> Result<HashMap<String, i64>> {
        let conn = self.read.lock().unwrap();
        let mut stmt = conn.prepare_cached(
            "SELECT s.agent_id, COUNT(*) FROM sessions s
             WHERE s.archived = 0 AND (s.parent_key = '' OR NOT EXISTS (
               SELECT 1 FROM sessions p WHERE p.key = s.parent_key AND p.archived = 0
             ))
             GROUP BY s.agent_id",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        let mut map = HashMap::new();
        for r in rows {
            let (k, v) = r?;
            map.insert(k, v);
        }
        Ok(map)
    }

    /// 各数据源目录下的会话数(Session locations 面板用):一次扫表按
    /// **(agent, 数据根)** 归属,免去每个目录一次往返。**不过滤 archived**
    /// ——归档目录本就该显示自己的量,那正是 agent_counts(WHERE archived = 0)
    /// 看不见的那部分。
    /// 必须连 agent 一起比,且边界走 adapters::path_owns:CODEX_HOME / XDG_DATA_HOME
    /// 允许把一家的数据根搬进另一家的树下,只认裸路径前缀会把整批会话静默
    /// 记到别家行上
    pub fn counts_by_path_prefix(&self, sources: &[(String, String)]) -> Result<Vec<i64>> {
        let conn = self.read.lock().unwrap();
        let mut stmt = conn.prepare_cached("SELECT agent_id, file_path FROM sessions")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut counts = vec![0i64; sources.len()];
        for row in rows {
            let (agent, path) = row?;
            if let Some(i) = sources
                .iter()
                .position(|(a, root)| *a == agent && crate::adapters::path_owns(root, &path))
            {
                counts[i] += 1;
            }
        }
        Ok(counts)
    }

    /// Insights 页统计快照。`today` 由调用方传入(streak 相对它计算,
    /// 也让测试不依赖真实时钟);SQL 侧 `'localtime'` 与 chrono `Local`
    /// 同取系统时区,日界一致。messages 全表恰扫两遍(日×时分桶 + 榜单
    /// prompts),量级几十万行、几十毫秒——调用方走后台任务,别在 UI
    /// 线程等它。
    pub fn insights(&self, today: chrono::NaiveDate) -> Result<InsightsData> {
        self.insights_for_agent(today, None)
    }

    pub fn insights_for_agent(
        &self,
        today: chrono::NaiveDate,
        agent: Option<AgentId>,
    ) -> Result<InsightsData> {
        use chrono::Datelike as _;
        // SQL 侧 date() 出来的本地日 → 可进分桶的日。时钟漂移的脏数据可能带
        // 未来日期:不进任何分桶(prompts 总数无日期语义仍计入)。热力图不画
        // 未来格,streak/活跃天数若认了就会与它互相矛盾(2026-08-27 Codex review)
        let day_of = |s: &str| {
            chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
                .ok()
                .filter(|d| *d <= today)
        };
        // "一条 prompt" 的行集(主线用户消息)——整页口径共用这一个片段,
        // 内联多份的话谓词一漂移,总数就会与分桶/榜单悄悄不一致
        const PROMPT_ROWS: &str = "FROM messages m JOIN sessions s ON s.key = m.session_key
             WHERE s.archived = 0 AND m.role = 'user' AND m.sidechain_id IS NULL
               AND s.key IN canonical_sessions";

        // 临时连接,不与 UI 的 read 连接抢锁:WAL 多读并发,几十毫秒的
        // 统计扫描不该让导航点击的列表查询排队(2026-08-27 Codex review)
        let conn = if self.read_only {
            open_conn_ro(&self.path)?
        } else {
            open_conn(&self.path)?
        };
        // 同一会话在多台 host 上各有一份镜像时(两个远程 host 指向同一台机器,
        // 或本地与远程都有)只算一次:按 (agent, native_id, created_at) 认同一会话
        // ——native_id 单独不够(Hermes 的 id 是小整数,两台机器的 1 号会话不是
        // 同一个),created_at 出自文件内容,同 id 同起点即同一会话;没有 created_at
        // 的不合并。取更新时间最新的那份(最完整),平局按 host 名(本地 '' 最小)。
        // scanner 层有意保留全部副本(不变量 8⑦:各机续跑会分叉),只是统计口径
        // 不能把一份对话数两遍(2026-09-14,0.4.0 遗留)。算一次放临时表——这条
        // 连接是本次调用私有的,只读连接也能建 temp 表;内联成子查询的话下面
        // 七条语句会各排一遍序
        create_canonical_sessions(&conn, agent)?;
        let mut data = InsightsData {
            as_of: today,
            // Agents asking Wake:窗同 Last 7 days,按调用时刻归窗;与其余语句同一
            // 连接、同一张 canonical_sessions
            wake_lookups_7d: tally_wake_lookups(&conn, week_window_start_ms(today))?,
            ..Default::default()
        };

        (
            data.sessions,
            data.tokens,
            data.first_ts,
            data.project_count,
        ) = conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(
                       CASE WHEN u.has_usage = 1 THEN u.tokens_used
                            ELSE COALESCE(s.tokens_used,0) END),0),
                    COALESCE(MIN(NULLIF(created_at,0)),0),
                    COUNT(DISTINCT NULLIF(project_path,''))
             FROM sessions s LEFT JOIN session_usage u ON u.file_path = s.file_path
             WHERE s.archived = 0 AND s.key IN canonical_sessions",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
        (data.scanned_tokens, data.session_tokens) = conn.query_row(
            "SELECT COALESCE(SUM(CASE WHEN u.has_usage = 1 THEN u.tokens_used ELSE 0 END),0),
                    COALESCE(SUM(COALESCE(s.tokens_used,0)),0)
             FROM sessions s LEFT JOIN session_usage u ON u.file_path = s.file_path
             WHERE s.archived = 0 AND s.key IN canonical_sessions",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;

        // 第一遍:按(日,时)组合分桶(行数 = 活跃日×活跃时段,千级)。
        // 无 ts 的行落 NULL 桶只计入总数;weekday/monthly 由日期在 Rust 侧
        // 派生,省去再让 SQL 各扫一遍 + 每行多次 strftime 时区换算
        let mut stmt = conn.prepare_cached(&format!(
            "SELECT CASE WHEN m.ts > 0 THEN date(m.ts/1000,'unixepoch','localtime') END d,
                    CASE WHEN m.ts > 0 THEN CAST(strftime('%H', m.ts/1000,'unixepoch','localtime') AS INTEGER) END h,
                    COUNT(*)
             {PROMPT_ROWS}
             GROUP BY d, h ORDER BY d"
        ))?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, Option<String>>(0)?,
                r.get::<_, Option<i64>>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })?;
        for row in rows {
            let (d, h, n) = row?;
            data.prompts += n;
            let Some(day) = d.as_deref().and_then(day_of) else {
                continue;
            };
            if let Some(h) = h.filter(|h| (0..24).contains(h)) {
                data.hourly[h as usize] += n;
            }
            data.weekday[day.weekday().num_days_from_monday() as usize] += n;
            data.monthly[day.month0() as usize] += n;
            // ORDER BY d 保证同日相邻,尾项聚合即可
            match data.daily.last_mut() {
                Some((last, c)) if *last == day => *c += n,
                _ => data.daily.push((day, n)),
            }
        }
        drop(stmt);

        // 第二遍:榜单 prompts 按(agent,项目,模型,日)一次分组(行数 = 组合数×
        // 活跃日,千级),拆三张榜单 map + agent 周桶回填——榜单求和不看日期
        // (无 ts / 未来行也计),周桶只收落在趋势窗内的日。模型不出周桶:
        // s.model 是会话末态,按它切周会把整段历史归给最后用的模型
        let mut prompts_by_agent: HashMap<String, i64> = HashMap::new();
        let mut prompts_by_project: HashMap<String, i64> = HashMap::new();
        let mut prompts_by_model: HashMap<String, i64> = HashMap::new();
        let mut by_agent: HashMap<String, Vec<i64>> = HashMap::new();
        let mut stmt = conn.prepare_cached(&format!(
            "SELECT s.agent_id, s.project_path, COALESCE(s.model,''),
                    CASE WHEN m.ts > 0 THEN date(m.ts/1000,'unixepoch','localtime') END d,
                    COUNT(*)
             {PROMPT_ROWS}
             GROUP BY 1, 2, 3, 4"
        ))?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, i64>(4)?,
            ))
        })?;
        for row in rows {
            let (agent, project, model, d, n) = row?;
            *prompts_by_agent.entry(agent.clone()).or_default() += n;
            *prompts_by_project.entry(project).or_default() += n;
            if !model.is_empty() {
                *prompts_by_model.entry(model).or_default() += n;
            }
            let Some(ix) = d
                .as_deref()
                .and_then(day_of)
                .and_then(|day| trend_week_index(today, day))
            else {
                continue;
            };
            by_agent
                .entry(agent)
                .or_insert_with(|| vec![0; TREND_WEEKS])[ix] += n;
        }
        drop(stmt);
        data.trend_agents = by_agent
            .into_iter()
            .map(|(name, weekly)| TrendSeries { name, weekly })
            .collect();
        data.trend_agents
            .sort_by(|a, b| b.total().cmp(&a.total()).then_with(|| a.name.cmp(&b.name)));

        // 榜单主体只查 sessions 表(几百行),prompts 由上面的 map 回填。
        // display 与 group 分开传:项目按 path 分组、按名展示(同名异路径
        // 各占一行,合并会把两个真实目录混作一处)。全量返回不截断——
        // top-N 由 UI 按当前度量排序后取,否则换度量会漏项
        let usage = |display: &str,
                     group: &str,
                     filter: &str,
                     prompts: &HashMap<String, i64>|
         -> Result<Vec<UsageTally>> {
            let sql = format!(
                "SELECT {group}, {display}, COUNT(*), COALESCE(SUM(
                     CASE WHEN u.has_usage = 1 THEN u.tokens_used
                          ELSE COALESCE(s.tokens_used,0) END),0),
                     COALESCE(SUM(CASE WHEN u.has_usage = 1 THEN u.tokens_used ELSE 0 END),0),
                     COALESCE(SUM(COALESCE(s.tokens_used,0)),0)
                 FROM sessions s LEFT JOIN session_usage u ON u.file_path = s.file_path
                 WHERE s.archived = 0 AND s.key IN canonical_sessions{filter}
                 GROUP BY {group} ORDER BY COUNT(*) DESC, {display}"
            );
            let mut stmt = conn.prepare_cached(&sql)?;
            let rows = stmt.query_map([], |r| {
                Ok((
                    UsageTally {
                        key: r.get(0)?,
                        name: r.get(1)?,
                        sessions: r.get(2)?,
                        tokens: r.get(3)?,
                        scanned_tokens: r.get(4)?,
                        session_tokens: r.get(5)?,
                        prompts: 0,
                    },
                    r.get::<_, String>(0)?,
                ))
            })?;
            rows.map(|row| {
                let (mut tally, key) = row?;
                tally.prompts = prompts.get(&key).copied().unwrap_or(0);
                Ok(tally)
            })
            .collect()
        };
        data.agents = usage("s.agent_id", "s.agent_id", "", &prompts_by_agent)?;
        // 无 cwd 的会话 project_path 为空、name 是 "Unknown project" 占位:
        // 概览 project_count 按空 path 排除,榜单必须同谓词——按 name 滤会
        // 让页面一边数 0 一边列出 Unknown project(2026-08-27 Codex review)
        data.projects = usage(
            "s.project_name",
            "s.project_path",
            " AND s.project_path != ''",
            &prompts_by_project,
        )?;
        data.models = usage(
            "s.model",
            "s.model",
            " AND s.model IS NOT NULL AND s.model != ''",
            &prompts_by_model,
        )?;

        // 会话按创建日分桶(Last 7 days 的 sessions 对比用)。date() 对超出
        // 其范围的正数(微秒戳、脏值)返回 NULL——按 Option 读,坏行跳过,
        // 不能让一条脏 created_at 掀翻整张快照(2026-09-03 Codex review)
        let mut stmt = conn.prepare_cached(
            "SELECT date(created_at/1000,'unixepoch','localtime'), COUNT(*)
             FROM sessions WHERE archived = 0 AND created_at > 0
               AND key IN canonical_sessions
             GROUP BY 1 ORDER BY 1",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, Option<String>>(0)?, r.get::<_, i64>(1)?))
        })?;
        for row in rows {
            let (d, n) = row?;
            if let Some(day) = d.as_deref().and_then(day_of) {
                data.daily_sessions.push((day, n));
            }
        }
        drop(stmt);

        (data.current_streak, data.longest_streak) = compute_streaks(&data.daily, today);
        Ok(data)
    }

    /// 在统一的时间范围内统计 Insights。会话按范围内的用户发言判断活跃，
    /// Token 按逐请求事件时间归属；无时间戳事件不进入日期范围统计。
    pub fn insights_for_agent_range(
        &self,
        today: chrono::NaiveDate,
        agent: Option<AgentId>,
        start_ms: Option<i64>,
        end_ms: Option<i64>,
    ) -> Result<InsightsData> {
        use chrono::{Datelike as _, Local, TimeZone as _};
        let mut data = self.insights_for_agent(today, agent)?;
        let conn = if self.read_only {
            open_conn_ro(&self.path)?
        } else {
            open_conn(&self.path)?
        };
        create_canonical_sessions(&conn, agent)?;
        conn.execute(
            "CREATE TEMP TABLE active_sessions AS
             SELECT DISTINCT s.key FROM sessions s
             JOIN messages m ON m.session_key = s.key
             WHERE s.key IN canonical_sessions AND m.role = 'user'
               AND m.sidechain_id IS NULL
               AND (?1 IS NULL OR m.ts > 0)
               AND (?1 IS NULL OR m.ts >= ?1)
               AND (?2 IS NULL OR m.ts IS NULL OR m.ts = 0 OR m.ts < ?2)",
            params![start_ms, end_ms],
        )?;
        conn.execute(
            "CREATE INDEX idx_active_sessions_key ON active_sessions(key)",
            [],
        )?;

        data.sessions = conn.query_row("SELECT COUNT(*) FROM active_sessions", [], |r| r.get(0))?;
        data.project_count = conn.query_row(
            "SELECT COUNT(DISTINCT NULLIF(s.project_path,''))
             FROM sessions s JOIN active_sessions a ON a.key = s.key",
            [],
            |r| r.get(0),
        )?;
        data.prompts = 0;
        data.range_active_days = 0;
        data.hourly = [0; 24];
        data.weekday = [0; 7];
        data.monthly = [0; 12];
        let mut active_days = HashSet::new();
        {
            let mut stmt = conn.prepare(
                "SELECT CASE WHEN m.ts > 0 THEN date(m.ts/1000,'unixepoch','localtime') END d,
                        CASE WHEN m.ts > 0 THEN CAST(strftime('%H', m.ts/1000,'unixepoch','localtime') AS INTEGER) END h,
                        COUNT(*)
                 FROM messages m JOIN sessions s ON s.key = m.session_key
                 WHERE s.key IN canonical_sessions AND m.role = 'user'
                   AND m.sidechain_id IS NULL
                   AND (?1 IS NULL OR m.ts > 0)
                   AND (?1 IS NULL OR m.ts >= ?1)
                   AND (?2 IS NULL OR m.ts IS NULL OR m.ts = 0 OR m.ts < ?2)
                 GROUP BY d, h ORDER BY d",
            )?;
            let rows = stmt.query_map(params![start_ms, end_ms], |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, Option<i64>>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })?;
            for row in rows {
                let (date, hour, count) = row?;
                data.prompts += count;
                let (Some(date), Some(hour)) = (date, hour) else {
                    continue;
                };
                let Ok(date) = chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d") else {
                    continue;
                };
                if date > today {
                    continue;
                }
                data.hourly[hour.clamp(0, 23) as usize] += count;
                data.weekday[date.weekday().num_days_from_monday() as usize] += count;
                data.monthly[date.month0() as usize] += count;
                active_days.insert(date);
            }
        }
        data.range_active_days = active_days.len() as i64;

        data.hourly_tokens = [0; 24];
        data.weekday_tokens = [0; 7];
        data.monthly_tokens = [0; 12];
        data.weekly_tokens = vec![0; TREND_WEEKS];
        {
            let mut stmt = conn.prepare(
                "SELECT date(e.timestamp_ms/1000,'unixepoch','localtime'),
                        CAST(strftime('%H', e.timestamp_ms/1000,'unixepoch','localtime') AS INTEGER),
                        SUM(e.tokens_used)
                 FROM session_usage_events e JOIN sessions s ON s.file_path = e.file_path
                 WHERE s.key IN canonical_sessions AND e.timestamp_ms IS NOT NULL
                   AND e.timestamp_ms > 0
                   AND (?1 IS NULL OR e.timestamp_ms >= ?1)
                   AND (?2 IS NULL OR e.timestamp_ms < ?2)
                 GROUP BY 1, 2 ORDER BY 1",
            )?;
            let rows = stmt.query_map(params![start_ms, end_ms], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })?;
            for row in rows {
                let (date, hour, tokens) = row?;
                let Ok(date) = chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d") else {
                    continue;
                };
                if date > today {
                    continue;
                }
                data.hourly_tokens[hour.clamp(0, 23) as usize] += tokens;
                data.weekday_tokens[date.weekday().num_days_from_monday() as usize] += tokens;
                data.monthly_tokens[date.month0() as usize] += tokens;
                if let Some(ix) = trend_week_index(today, date) {
                    data.weekly_tokens[ix] += tokens;
                }
            }
        }

        let mut agent_sessions: HashMap<String, i64> = HashMap::new();
        let mut project_sessions: HashMap<String, (String, i64)> = HashMap::new();
        {
            let mut stmt = conn.prepare(
                "SELECT s.agent_id, s.project_path, MAX(s.project_name), COUNT(DISTINCT s.key)
                 FROM sessions s JOIN active_sessions a ON a.key = s.key
                 GROUP BY s.agent_id, s.project_path",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            })?;
            for row in rows {
                let (agent_id, path, name, count) = row?;
                *agent_sessions.entry(agent_id).or_default() += count;
                if !path.is_empty() {
                    project_sessions.insert(path, (name, count));
                }
            }
        }

        let mut agent_prompts = HashMap::new();
        let mut project_prompts = HashMap::new();
        {
            let mut stmt = conn.prepare(
                "SELECT s.agent_id, s.project_path, COUNT(*)
                 FROM messages m JOIN sessions s ON s.key = m.session_key
                 WHERE s.key IN canonical_sessions AND m.role = 'user'
                   AND m.sidechain_id IS NULL
                   AND (?1 IS NULL OR m.ts > 0)
                   AND (?1 IS NULL OR m.ts >= ?1)
                   AND (?2 IS NULL OR m.ts IS NULL OR m.ts = 0 OR m.ts < ?2)
                 GROUP BY s.agent_id, s.project_path",
            )?;
            let rows = stmt.query_map(params![start_ms, end_ms], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })?;
            for row in rows {
                let (agent_id, path, count) = row?;
                *agent_prompts.entry(agent_id).or_insert(0) += count;
                if !path.is_empty() {
                    *project_prompts.entry(path).or_insert(0) += count;
                }
            }
        }

        let mut agent_tokens = HashMap::new();
        let mut project_tokens = HashMap::new();
        let mut model_tokens = HashMap::new();
        let mut model_sessions: HashMap<String, HashSet<String>> = HashMap::new();
        data.tokens = 0;
        {
            let mut stmt = conn.prepare(
                "SELECT s.agent_id, s.project_path, COALESCE(e.model,''), s.key, e.tokens_used
                 FROM session_usage_events e JOIN sessions s ON s.file_path = e.file_path
                 WHERE s.key IN canonical_sessions AND e.timestamp_ms IS NOT NULL
                   AND e.timestamp_ms > 0
                   AND (?1 IS NULL OR e.timestamp_ms >= ?1)
                   AND (?2 IS NULL OR e.timestamp_ms < ?2)",
            )?;
            let rows = stmt.query_map(params![start_ms, end_ms], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            })?;
            for row in rows {
                let (agent_id, path, model, session_key, tokens) = row?;
                data.tokens += tokens;
                *agent_tokens.entry(agent_id).or_insert(0) += tokens;
                if !path.is_empty() {
                    *project_tokens.entry(path).or_insert(0) += tokens;
                }
                if !model.is_empty() {
                    *model_tokens.entry(model.clone()).or_insert(0) += tokens;
                    model_sessions.entry(model).or_default().insert(session_key);
                }
            }
        }

        let mut agent_names: HashSet<String> = agent_sessions.keys().cloned().collect();
        agent_names.extend(agent_tokens.keys().cloned());
        data.agents = agent_names
            .into_iter()
            .map(|key| UsageTally {
                name: key.clone(),
                key: key.clone(),
                sessions: agent_sessions.get(&key).copied().unwrap_or(0),
                prompts: agent_prompts.get(&key).copied().unwrap_or(0),
                tokens: agent_tokens.get(&key).copied().unwrap_or(0),
                ..Default::default()
            })
            .collect();
        data.agents.sort_by(|a, b| {
            b.sessions
                .cmp(&a.sessions)
                .then_with(|| a.name.cmp(&b.name))
        });

        let mut project_keys: HashSet<String> = project_sessions.keys().cloned().collect();
        project_keys.extend(project_tokens.keys().cloned());
        data.projects = project_keys
            .into_iter()
            .map(|key| {
                let (name, sessions) = project_sessions
                    .get(&key)
                    .cloned()
                    .unwrap_or_else(|| (key.clone(), 0));
                UsageTally {
                    key: key.clone(),
                    name,
                    sessions,
                    prompts: project_prompts.get(&key).copied().unwrap_or(0),
                    tokens: project_tokens.get(&key).copied().unwrap_or(0),
                    ..Default::default()
                }
            })
            .collect();
        data.projects.sort_by(|a, b| {
            b.sessions
                .cmp(&a.sessions)
                .then_with(|| a.name.cmp(&b.name))
        });
        data.models = model_tokens
            .into_iter()
            .map(|(name, tokens)| UsageTally {
                key: name.clone(),
                name: name.clone(),
                sessions: model_sessions
                    .get(&name)
                    .map_or(0, |sessions| sessions.len() as i64),
                tokens,
                ..Default::default()
            })
            .collect();
        data.models
            .sort_by(|a, b| b.tokens.cmp(&a.tokens).then_with(|| a.name.cmp(&b.name)));

        data.daily_tokens.clear();
        let heat_start = data
            .trend_start()
            .and_hms_opt(0, 0, 0)
            .and_then(|dt| Local.from_local_datetime(&dt).single())
            .map(|dt| dt.timestamp_millis())
            .unwrap_or(0);
        let heat_end = Local::now().timestamp_millis();
        {
            let mut stmt = conn.prepare(
                "SELECT date(e.timestamp_ms/1000,'unixepoch','localtime'), SUM(e.tokens_used)
                 FROM session_usage_events e JOIN sessions s ON s.file_path = e.file_path
                 WHERE s.key IN canonical_sessions AND e.timestamp_ms IS NOT NULL
                   AND e.timestamp_ms >= ?1 AND e.timestamp_ms < ?2
                 GROUP BY 1 ORDER BY 1",
            )?;
            let rows = stmt.query_map(params![heat_start, heat_end], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
            })?;
            for row in rows {
                let (date, tokens) = row?;
                if let Ok(date) = chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d") {
                    data.daily_tokens.push((date, tokens));
                }
            }
        }

        data.trend_agents.clear();
        let mut weekly: HashMap<String, Vec<i64>> = HashMap::new();
        {
            let mut stmt = conn.prepare(
                "SELECT s.agent_id, date(m.ts/1000,'unixepoch','localtime'), COUNT(*)
                 FROM messages m JOIN sessions s ON s.key = m.session_key
                 WHERE s.key IN canonical_sessions AND m.role = 'user'
                   AND m.sidechain_id IS NULL AND m.ts > 0
                   AND (?1 IS NULL OR m.ts >= ?1) AND (?2 IS NULL OR m.ts < ?2)
                 GROUP BY s.agent_id, 2",
            )?;
            let rows = stmt.query_map(params![start_ms, end_ms], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })?;
            for row in rows {
                let (agent_id, date, count) = row?;
                let Ok(date) = chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d") else {
                    continue;
                };
                if let Some(ix) = trend_week_index(today, date) {
                    weekly
                        .entry(agent_id)
                        .or_insert_with(|| vec![0; TREND_WEEKS])[ix] += count;
                }
            }
        }
        data.trend_agents = weekly
            .into_iter()
            .map(|(name, weekly)| TrendSeries { name, weekly })
            .collect();
        data.trend_agents
            .sort_by(|a, b| b.total().cmp(&a.total()).then_with(|| a.name.cmp(&b.name)));

        data.wake_lookups_7d.clear();
        {
            let mut stmt = conn.prepare(
                "SELECT s.agent_id, SUM(l.channel = 'mcp'), SUM(l.channel = 'cli')
                 FROM wake_lookups l JOIN sessions s ON s.key = l.session_key
                 WHERE s.key IN canonical_sessions
                   AND COALESCE(l.ts, s.updated_at) >= COALESCE(?1, 0)
                   AND COALESCE(l.ts, s.updated_at) < COALESCE(?2, 9223372036854775807)
                 GROUP BY s.agent_id ORDER BY COUNT(*) DESC, s.agent_id",
            )?;
            let rows = stmt.query_map(params![start_ms, end_ms], |r| {
                Ok(LookupTally {
                    name: r.get(0)?,
                    mcp: r.get(1)?,
                    cli: r.get(2)?,
                })
            })?;
            data.wake_lookups_7d = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        }
        Ok(data)
    }

    /// 选中日所在周期的细分分布(热力图点击联动的数据源)。一次查询覆盖三档
    /// 视图:`day_hours`(当天逐时 24 桶)、`week_days`(所在周逐日 7 桶)、
    /// `month_days`(所在月逐日)。口径与 insights() 同:主线 user 消息、
    /// archived 不计、未来时间戳不认;无 ts 的行无周期可归,自然缺席
    pub fn period_breakdown(&self, day: chrono::NaiveDate) -> Result<PeriodBreakdown> {
        self.period_breakdown_for_agent(day, None)
    }

    pub fn period_breakdown_for_agent(
        &self,
        day: chrono::NaiveDate,
        agent: Option<AgentId>,
    ) -> Result<PeriodBreakdown> {
        use chrono::{Datelike as _, Days};
        // 三个视图各自的窗口:当天 / 周一~周日 / 月初~月末。查询窗取三者并集
        // ——月初那周的周一周二落在上月,月末那周的周末落在下月,只按当月开窗
        // 会让 week_days 的两端日漏数
        let monday = day - chrono::Duration::days(day.weekday().num_days_from_monday() as i64);
        let month_start = day.with_day(1).unwrap_or(day);
        let next_month = if month_start.month() == 12 {
            chrono::NaiveDate::from_ymd_opt(month_start.year() + 1, 1, 1)
        } else {
            chrono::NaiveDate::from_ymd_opt(month_start.year(), month_start.month() + 1, 1)
        }
        .unwrap_or(month_start + Days::new(31));
        let month_end = next_month - Days::new(1);
        let week_end = monday + Days::new(6);
        let (lo, hi_day) = (monday.min(month_start), week_end.max(month_end));
        // 本地日历日 → epoch 秒。`'localtime'`(SQL 侧)与 chrono::Local 同取
        // 系统时区,日界与 insights() 一致
        let secs = |d: chrono::NaiveDate, h: u32| {
            use chrono::TimeZone as _;
            chrono::Local
                .with_ymd_and_hms(d.year(), d.month(), d.day(), h, 0, 0)
                .single()
                .map(|dt| dt.timestamp())
                .unwrap_or(0)
        };
        let conn = if self.read_only {
            open_conn_ro(&self.path)?
        } else {
            open_conn(&self.path)?
        };
        create_canonical_sessions(&conn, agent)?;
        // (时, 日) 两列一次扫;落哪个视图由 Rust 侧按窗口归属切分,窗口外的行
        // (跨月补白)不落任何桶
        let mut stmt = conn.prepare_cached(
            "SELECT CASE WHEN m.ts > 0 THEN CAST(strftime('%H', m.ts/1000,'unixepoch','localtime') AS INTEGER) END h,
                    CASE WHEN m.ts > 0 THEN date(m.ts/1000,'unixepoch','localtime') END d,
                    COUNT(*)
             FROM messages m JOIN sessions s ON s.key = m.session_key
             WHERE s.archived = 0 AND m.role = 'user' AND m.sidechain_id IS NULL
               AND s.key IN canonical_sessions
               AND m.ts >= ?1 AND m.ts < ?2
             GROUP BY 1, 2",
        )?;
        let mut out = PeriodBreakdown {
            day,
            ..Default::default()
        };
        let rows = stmt.query_map(
            params![secs(lo, 0) * 1000, secs(hi_day, 23) * 1000 + 3_600_000],
            |r| {
                Ok((
                    r.get::<_, Option<i64>>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            },
        )?;
        for row in rows {
            let (h, d, n) = row?;
            let Some(d) = d
                .as_deref()
                .and_then(|s| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
            else {
                continue;
            };
            if h.is_none() {
                continue;
            }
            let h = h.unwrap().clamp(0, 23) as usize;
            if d == day {
                out.day_hours[h] += n;
            }
            let week_ix = (d - monday).num_days();
            if (0..7).contains(&week_ix) {
                out.week_days[week_ix as usize] += n;
            }
            let month_ix = (d - month_start).num_days();
            if (0..31).contains(&month_ix) {
                out.month_days[month_ix as usize] += n;
            }
        }
        drop(stmt);

        let mut token_rows = conn.prepare_cached(
            "SELECT CAST(strftime('%H', e.timestamp_ms/1000,'unixepoch','localtime') AS INTEGER) h,
                    date(e.timestamp_ms/1000,'unixepoch','localtime') d,
                    SUM(e.tokens_used)
             FROM session_usage_events e JOIN sessions s ON s.file_path = e.file_path
             WHERE e.timestamp_ms IS NOT NULL AND s.archived = 0
               AND s.key IN canonical_sessions
               AND e.timestamp_ms >= ?1 AND e.timestamp_ms < ?2
             GROUP BY h, d",
        )?;
        let mut token_rows = token_rows.query(params![
            secs(lo, 0) * 1000,
            secs(hi_day + Days::new(1), 0) * 1000
        ])?;
        while let Some(row) = token_rows.next()? {
            let hour: i64 = row.get(0)?;
            let date: String = row.get(1)?;
            let tokens: i64 = row.get(2)?;
            let Some(date) = chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d").ok() else {
                continue;
            };
            if date == day {
                out.day_hour_tokens[hour.clamp(0, 23) as usize] += tokens;
            }
            let week_ix = (date - monday).num_days();
            if (0..7).contains(&week_ix) {
                out.week_day_tokens[week_ix as usize] += tokens;
            }
            let month_ix = (date - month_start).num_days();
            if (0..31).contains(&month_ix) {
                out.month_day_tokens[month_ix as usize] += tokens;
            }
        }
        Ok(out)
    }

    /// 全文搜索:trigram MATCH(每段 ≥3 码点)或 LIKE 降级。返回 (hits, degraded)
    pub fn search(
        &self,
        q: &str,
        agents: &[AgentId],
        project_path: Option<&str>,
        limit: i64,
    ) -> Result<(Vec<SearchHit>, bool)> {
        self.search_with(
            q,
            &SearchFilter {
                agents: agents.to_vec(),
                project_paths: project_path
                    .map(|p| vec![p.to_string()])
                    .unwrap_or_default(),
                updated_since: None,
                limit,
            },
        )
    }

    /// 全文搜索的完整筛选形态(多项目并集 + 时间下界);`search` 是它的便捷壳。
    /// 命中按 bm25 排序、消息级一行一条;archived 会话不排除(meta.archived 标出)
    pub fn search_with(&self, q: &str, f: &SearchFilter) -> Result<(Vec<SearchHit>, bool)> {
        let segs = fts_terms(q);
        if segs.is_empty() {
            return Ok((Vec::new(), false));
        }
        let degraded = needs_like_fallback(&segs);
        let limit = if f.limit > 0 { f.limit } else { 60 };
        // 近因加权:bm25 是负数、越小越相关,乘上 (1 + W / (1 + 距今天数 / H)) 让
        // 新会话的命中"更负"。W = 1、H = 30 天:今天的会话 ×2、一个月前 ×1.5、
        // 一年前 ×1.08——同等文本相关性下新会话在前,文本相关性差一倍以上的老命中
        // 仍然赢得过。按会话的 updated_at 而不是消息自己的 ts:排的是"该翻哪场
        // 对话",同一会话内各命中的相对顺序不受影响。只用四则运算与 max(),不依赖
        // SQLite 的数学扩展;`?` 是当前时间(毫秒)。降级的 LIKE 路径本来就按时间排
        const RECENCY_BOOST: &str = "(1.0 + 1.0 / (1.0 + max(0, ? - s.updated_at) / 2592000000.0))";
        let now = now_ms();

        // 会话侧筛选(agent / 项目并集 / 时间下界):SQL 片段拼一次,参数按需重建
        // ——正文与标题是两条查询,Box<dyn ToSql> 不能 clone
        let mut filter_sql = String::new();
        if !f.agents.is_empty() {
            filter_sql.push_str(&format!(
                " AND s.agent_id IN ({})",
                placeholders(f.agents.len())
            ));
        }
        if !f.project_paths.is_empty() {
            filter_sql.push_str(&format!(
                " AND s.project_path IN ({})",
                placeholders(f.project_paths.len())
            ));
        }
        if f.updated_since.is_some() {
            filter_sql.push_str(" AND s.updated_at >= ?");
        }
        let filter_args = |f: &SearchFilter| -> Vec<Box<dyn rusqlite::ToSql>> {
            let mut v: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
            for a in &f.agents {
                v.push(Box::new(a.as_str().to_string()));
            }
            for p in &f.project_paths {
                v.push(Box::new(p.clone()));
            }
            if let Some(t) = f.updated_since {
                v.push(Box::new(t));
            }
            v
        };
        // FTS 的 MATCH 表达式(正文与标题两张表共用)
        let match_expr = fts_match_expr(&segs);

        let conn = self.read.lock().unwrap();
        let mut raw: Vec<(String, i64, Option<String>, String, Option<i64>, String)> = Vec::new();

        if !degraded {
            let sql = format!(
                "SELECT m.session_key, m.seq, m.sidechain_id, m.role, m.ts,
                        snippet(messages_fts, 0, ?, ?, '…', 16)
                 FROM messages_fts
                 JOIN messages m ON m.id = messages_fts.rowid
                 JOIN sessions s ON s.key = m.session_key
                 WHERE messages_fts MATCH ?{filter_sql}
                 ORDER BY bm25(messages_fts) * {RECENCY_BOOST} LIMIT ?"
            );
            let mut stmt = conn.prepare_cached(&sql)?;
            let mut all_args: Vec<Box<dyn rusqlite::ToSql>> = vec![
                Box::new(HL_OPEN.to_string()),
                Box::new(HL_CLOSE.to_string()),
                Box::new(match_expr.clone()),
            ];
            all_args.extend(filter_args(f));
            all_args.push(Box::new(now));
            all_args.push(Box::new(limit));
            let rows = stmt.query_map(
                rusqlite::params_from_iter(all_args.iter().map(|b| b.as_ref())),
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                },
            )?;
            for r in rows {
                raw.push(r?);
            }
        } else {
            let like_where = like_where(&["m.text"], segs.len());
            let sql = format!(
                "SELECT m.session_key, m.seq, m.sidechain_id, m.role, m.ts, m.text
                 FROM messages m JOIN sessions s ON s.key = m.session_key
                 WHERE {like_where}{filter_sql}
                 ORDER BY m.ts DESC LIMIT ?"
            );
            let mut stmt = conn.prepare_cached(&sql)?;
            let mut all_args = like_args(&segs, 1);
            all_args.extend(filter_args(f));
            all_args.push(Box::new(limit));
            let rows = stmt.query_map(
                rusqlite::params_from_iter(all_args.iter().map(|b| b.as_ref())),
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                },
            )?;
            for r in rows {
                let (k, seq, sc, role, ts, text): (
                    String,
                    i64,
                    Option<String>,
                    String,
                    Option<i64>,
                    String,
                ) = r?;
                raw.push((k, seq, sc, role, ts, make_like_snippet(&text, segs[0])));
            }
        }

        // 标题命中:独立的 titles_fts。排在正文命中之前——词出现在标题里是最强的
        // 相关性信号;role 记 "title"、seq 记 0,跳转落到会话开头(标题没有对应的
        // 转录行,不伪造 seq)
        let mut title_raw: Vec<(String, String)> = Vec::new();
        if !degraded {
            let sql = format!(
                "SELECT t.key, highlight(titles_fts, 1, ?, ?)
                 FROM titles_fts t JOIN sessions s ON s.key = t.key
                 WHERE titles_fts MATCH ?{filter_sql}
                 ORDER BY bm25(titles_fts) * {RECENCY_BOOST} LIMIT ?"
            );
            let mut stmt = conn.prepare_cached(&sql)?;
            let mut all_args: Vec<Box<dyn rusqlite::ToSql>> = vec![
                Box::new(HL_OPEN.to_string()),
                Box::new(HL_CLOSE.to_string()),
                Box::new(match_expr),
            ];
            all_args.extend(filter_args(f));
            all_args.push(Box::new(now));
            all_args.push(Box::new(limit));
            let rows = stmt.query_map(
                rusqlite::params_from_iter(all_args.iter().map(|b| b.as_ref())),
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )?;
            for r in rows {
                title_raw.push(r?);
            }
        } else {
            let like_where = like_where(&["s.title"], segs.len());
            let sql = format!(
                "SELECT s.key, s.title FROM sessions s
                 WHERE {like_where}{filter_sql}
                 ORDER BY s.updated_at DESC LIMIT ?"
            );
            let mut stmt = conn.prepare_cached(&sql)?;
            let mut all_args = like_args(&segs, 1);
            all_args.extend(filter_args(f));
            all_args.push(Box::new(limit));
            let rows = stmt.query_map(
                rusqlite::params_from_iter(all_args.iter().map(|b| b.as_ref())),
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )?;
            for r in rows {
                let (key, title) = r?;
                title_raw.push((key, make_like_snippet(&title, segs[0])));
            }
        }

        // 补齐 session meta:按会话只查一次(一个会话常占几十行命中),语句走
        // prepare_cached——Connection::query_row 每次都是裸 prepare
        let mut hits = Vec::new();
        let mut metas: HashMap<String, Option<SessionMeta>> = HashMap::new();
        let sql = format!(
            "SELECT {SESSION_COLS} FROM sessions s LEFT JOIN user_data u ON u.session_key = s.key WHERE s.key = ?1"
        );
        let mut stmt = conn.prepare_cached(&sql)?;
        let mut hydrate = |key: &str| -> Result<Option<SessionMeta>> {
            if let Some(cached) = metas.get(key) {
                return Ok(cached.clone());
            }
            let meta = stmt.query_row(params![key], row_to_meta).optional()?;
            metas.insert(key.to_string(), meta.clone());
            Ok(meta)
        };
        for (key, snippet) in title_raw {
            if let Some(session) = hydrate(&key)? {
                let timestamp = Some(session.updated_at);
                hits.push(SearchHit {
                    session,
                    seq: 0,
                    sidechain_id: None,
                    role: "title".to_string(),
                    snippet,
                    timestamp,
                });
            }
        }
        for (key, seq, sidechain_id, role, ts, snippet) in raw {
            if let Some(session) = hydrate(&key)? {
                hits.push(SearchHit {
                    session,
                    seq,
                    sidechain_id,
                    role,
                    snippet,
                    timestamp: ts,
                });
            }
        }
        Ok((hits, degraded))
    }

    pub fn compression_document_fingerprints(
        &self,
        roots: &[String],
    ) -> Result<HashMap<String, (i64, i64)>> {
        if roots.is_empty() {
            return Ok(HashMap::new());
        }
        let conn = self.read.lock().unwrap();
        let sql = format!(
            "SELECT path, modified_at, size_bytes FROM compression_documents WHERE root_path IN ({})",
            placeholders(roots.len())
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(roots), |row| {
            Ok((
                row.get::<_, String>(0)?,
                (row.get::<_, i64>(1)?, row.get::<_, i64>(2)?),
            ))
        })?;
        Ok(rows.collect::<rusqlite::Result<HashMap<_, _>>>()?)
    }

    /// Synchronize the rebuildable compression-document mirror for the roots scanned by
    /// the caller. `documents` contains only new or changed files; `seen_paths` includes
    /// unchanged files as well, so files removed from disk can be deleted transactionally.
    pub fn sync_compression_documents(
        &self,
        roots: &[String],
        seen_paths: &HashSet<String>,
        documents: &[CompressionDocumentRecord],
    ) -> Result<usize> {
        if roots.is_empty() {
            return Ok(0);
        }
        let mut conn = self.write.lock().unwrap();
        let tx = conn.transaction()?;
        let sql = format!(
            "SELECT id, path FROM compression_documents WHERE root_path IN ({})",
            placeholders(roots.len())
        );
        let existing = {
            let mut stmt = tx.prepare(&sql)?;
            let rows = stmt.query_map(rusqlite::params_from_iter(roots), |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for (id, path) in existing {
            if seen_paths.contains(&path) {
                continue;
            }
            tx.execute(
                "DELETE FROM compression_document_sources WHERE document_id = ?1",
                params![id],
            )?;
            tx.execute(
                "DELETE FROM compression_documents_fts WHERE rowid = ?1",
                params![id],
            )?;
            tx.execute(
                "DELETE FROM compression_documents WHERE id = ?1",
                params![id],
            )?;
        }

        for document in documents {
            let sources_json = serde_json::to_string(&document.sources)?;
            let id: i64 = tx.query_row(
                "INSERT INTO compression_documents(
                   path, root_path, scope, project_path, title, body, sources,
                   modified_at, size_bytes, indexed_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(path) DO UPDATE SET
                   root_path=excluded.root_path, scope=excluded.scope,
                   project_path=excluded.project_path, title=excluded.title,
                   body=excluded.body, sources=excluded.sources,
                   modified_at=excluded.modified_at, size_bytes=excluded.size_bytes,
                   indexed_at=excluded.indexed_at
                 RETURNING id",
                params![
                    document.path,
                    document.root_path,
                    document.scope,
                    document.project_path,
                    document.title,
                    document.body,
                    sources_json,
                    document.modified_at,
                    document.size_bytes,
                    now_ms(),
                ],
                |row| row.get(0),
            )?;
            tx.execute(
                "DELETE FROM compression_document_sources WHERE document_id = ?1",
                params![id],
            )?;
            for source in &document.sources {
                tx.execute(
                    "INSERT OR IGNORE INTO compression_document_sources(document_id, session_key)
                     VALUES (?1, ?2)",
                    params![id, source],
                )?;
            }
            tx.execute(
                "DELETE FROM compression_documents_fts WHERE rowid = ?1",
                params![id],
            )?;
            tx.execute(
                "INSERT INTO compression_documents_fts(rowid, path, title, body, sources)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    id,
                    document.path,
                    document.title,
                    document.body,
                    document.sources.join("\n"),
                ],
            )?;
        }
        tx.commit()?;

        let conn = self.read.lock().unwrap();
        let sql = format!(
            "SELECT COUNT(*) FROM compression_documents WHERE root_path IN ({})",
            placeholders(roots.len())
        );
        Ok(
            conn.query_row(&sql, rusqlite::params_from_iter(roots), |row| {
                row.get::<_, i64>(0)
            })? as usize,
        )
    }

    pub fn get_compression_document(
        &self,
        path: &str,
    ) -> Result<Option<CompressionDocumentRecord>> {
        let conn = self.read.lock().unwrap();
        Ok(conn
            .query_row(
                "SELECT path, root_path, scope, project_path, title, body, sources,
                        modified_at, size_bytes
                 FROM compression_documents WHERE path = ?1",
                params![path],
                compression_document_from_row,
            )
            .optional()?)
    }

    pub fn compression_documents_for_sessions(
        &self,
        session_keys: &[String],
    ) -> Result<Vec<(String, String, String)>> {
        if session_keys.is_empty() {
            return Ok(Vec::new());
        }
        let sql = format!(
            "SELECT cds.session_key, d.path, d.title
             FROM compression_document_sources cds
             JOIN compression_documents d ON d.id = cds.document_id
             WHERE cds.session_key IN ({})
             ORDER BY d.modified_at DESC, d.path",
            placeholders(session_keys.len())
        );
        let conn = self.read.lock().unwrap();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(session_keys), |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn last_exchange(&self, key: &str) -> Result<(Option<String>, Option<String>)> {
        let conn = self.read.lock().unwrap();
        let last = |role: &str, limit: i64| -> Result<Option<String>> {
            let mut stmt = conn.prepare_cached(
                "SELECT text FROM messages WHERE session_key = ?1 AND sidechain_id IS NULL AND role = ?2 ORDER BY id DESC LIMIT ?3",
            )?;
            let rows = stmt.query_map(params![key, role, limit], |row| row.get::<_, String>(0))?;
            for row in rows {
                let value = row?;
                let value = value.trim();
                if !value.is_empty() && !value.starts_with('<') && !value.starts_with('[') {
                    return Ok(Some(value.chars().take(320).collect()));
                }
            }
            Ok(None)
        };
        Ok((last("user", 50)?, last("assistant", 200)?))
    }

    pub fn search_compression_documents(
        &self,
        query: &str,
        roots: &[String],
        limit: usize,
    ) -> Result<(Vec<CompressionSearchHit>, bool)> {
        if roots.is_empty() || limit == 0 {
            return Ok((Vec::new(), false));
        }
        let segments = fts_terms(query);
        let degraded = !segments.is_empty() && needs_like_fallback(&segments);
        let roots_sql = placeholders(roots.len());
        let conn = self.read.lock().unwrap();
        let mut hits = Vec::new();

        if segments.is_empty() {
            let sql = format!(
                "SELECT path, scope, project_path, title, body, sources, modified_at
                 FROM compression_documents WHERE root_path IN ({roots_sql})
                 ORDER BY modified_at DESC, path LIMIT ?"
            );
            let mut args: Vec<Box<dyn rusqlite::ToSql>> = roots
                .iter()
                .cloned()
                .map(|root| Box::new(root) as _)
                .collect();
            args.push(Box::new(limit as i64));
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(
                rusqlite::params_from_iter(args.iter().map(|arg| arg.as_ref())),
                compression_hit_from_plain_row,
            )?;
            hits.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);
            return Ok((hits, false));
        }

        if !degraded {
            let sql = format!(
                "SELECT d.path, d.scope, d.project_path,
                        highlight(compression_documents_fts, 1, ?, ?),
                        snippet(compression_documents_fts, 2, ?, ?, '…', 24),
                        d.sources, d.modified_at,
                        -bm25(compression_documents_fts, 2.0, 5.0, 1.0, 2.0)
                 FROM compression_documents_fts
                 JOIN compression_documents d ON d.id = compression_documents_fts.rowid
                 WHERE compression_documents_fts MATCH ?
                   AND d.root_path IN ({roots_sql})
                 ORDER BY bm25(compression_documents_fts, 2.0, 5.0, 1.0, 2.0),
                          d.modified_at DESC LIMIT ?"
            );
            let mut args: Vec<Box<dyn rusqlite::ToSql>> = vec![
                Box::new(HL_OPEN.to_string()),
                Box::new(HL_CLOSE.to_string()),
                Box::new(HL_OPEN.to_string()),
                Box::new(HL_CLOSE.to_string()),
                Box::new(fts_match_expr(&segments)),
            ];
            args.extend(roots.iter().cloned().map(|root| Box::new(root) as _));
            args.push(Box::new(limit as i64));
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(
                rusqlite::params_from_iter(args.iter().map(|arg| arg.as_ref())),
                compression_hit_from_search_row,
            )?;
            hits.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);
        } else {
            let like = like_where(
                &["d.path", "d.title", "d.body", "d.sources"],
                segments.len(),
            );
            let sql = format!(
                "SELECT d.path, d.scope, d.project_path, d.title, d.body, d.sources,
                        d.modified_at
                 FROM compression_documents d
                 WHERE {like} AND d.root_path IN ({roots_sql})
                 ORDER BY d.modified_at DESC LIMIT ?"
            );
            let mut args = like_args(&segments, 4);
            args.extend(roots.iter().cloned().map(|root| Box::new(root) as _));
            args.push(Box::new(limit as i64));
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(
                rusqlite::params_from_iter(args.iter().map(|arg| arg.as_ref())),
                |row| {
                    let body = row.get::<_, String>(4)?;
                    Ok(CompressionSearchHit {
                        path: row.get(0)?,
                        scope: row.get(1)?,
                        project_path: row.get(2)?,
                        title: mark_like_match(&row.get::<_, String>(3)?, segments[0]),
                        snippet: make_like_snippet(&body, segments[0]),
                        sources: parse_compression_sources(&row.get::<_, String>(5)?),
                        modified_at: row.get(6)?,
                        score: 0.0,
                        direct_match: true,
                        related_by: Vec::new(),
                    })
                },
            )?;
            hits.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);
        }
        Ok((hits, degraded))
    }

    pub fn compression_documents_by_sources(
        &self,
        source_keys: &[String],
        roots: &[String],
        excluded_paths: &HashSet<String>,
        limit: usize,
    ) -> Result<Vec<(CompressionSearchHit, String)>> {
        if source_keys.is_empty() || roots.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        let sql = format!(
            "SELECT d.path, d.scope, d.project_path, d.title, d.body, d.sources,
                    d.modified_at, cds.session_key
             FROM compression_document_sources cds
             JOIN compression_documents d ON d.id = cds.document_id
             WHERE cds.session_key IN ({}) AND d.root_path IN ({})
             ORDER BY d.modified_at DESC LIMIT ?",
            placeholders(source_keys.len()),
            placeholders(roots.len())
        );
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = source_keys
            .iter()
            .cloned()
            .map(|key| Box::new(key) as _)
            .collect();
        args.extend(roots.iter().cloned().map(|root| Box::new(root) as _));
        args.push(Box::new((limit.saturating_mul(3)) as i64));
        let conn = self.read.lock().unwrap();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            rusqlite::params_from_iter(args.iter().map(|arg| arg.as_ref())),
            |row| {
                let body = row.get::<_, String>(4)?;
                Ok((
                    CompressionSearchHit {
                        path: row.get(0)?,
                        scope: row.get(1)?,
                        project_path: row.get(2)?,
                        title: row.get(3)?,
                        snippet: compression_body_preview(&body),
                        sources: parse_compression_sources(&row.get::<_, String>(5)?),
                        modified_at: row.get(6)?,
                        score: 0.0,
                        direct_match: false,
                        related_by: Vec::new(),
                    },
                    row.get::<_, String>(7)?,
                ))
            },
        )?;
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for row in rows {
            let (hit, source) = row?;
            if excluded_paths.contains(&hit.path) || !seen.insert(hit.path.clone()) {
                continue;
            }
            out.push((hit, source));
            if out.len() == limit {
                break;
            }
        }
        Ok(out)
    }
}

fn parse_compression_sources(raw: &str) -> Vec<String> {
    serde_json::from_str(raw).unwrap_or_default()
}

fn compression_document_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<CompressionDocumentRecord> {
    Ok(CompressionDocumentRecord {
        path: row.get(0)?,
        root_path: row.get(1)?,
        scope: row.get(2)?,
        project_path: row.get(3)?,
        title: row.get(4)?,
        body: row.get(5)?,
        sources: parse_compression_sources(&row.get::<_, String>(6)?),
        modified_at: row.get(7)?,
        size_bytes: row.get(8)?,
    })
}

fn compression_body_preview(body: &str) -> String {
    body.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(240)
        .collect()
}

fn compression_hit_from_plain_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<CompressionSearchHit> {
    let body = row.get::<_, String>(4)?;
    Ok(CompressionSearchHit {
        path: row.get(0)?,
        scope: row.get(1)?,
        project_path: row.get(2)?,
        title: row.get(3)?,
        snippet: compression_body_preview(&body),
        sources: parse_compression_sources(&row.get::<_, String>(5)?),
        modified_at: row.get(6)?,
        score: 0.0,
        direct_match: true,
        related_by: Vec::new(),
    })
}

fn compression_hit_from_search_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<CompressionSearchHit> {
    Ok(CompressionSearchHit {
        path: row.get(0)?,
        scope: row.get(1)?,
        project_path: row.get(2)?,
        title: row.get(3)?,
        snippet: row.get(4)?,
        sources: parse_compression_sources(&row.get::<_, String>(5)?),
        modified_at: row.get(6)?,
        score: row.get(7)?,
        direct_match: true,
        related_by: Vec::new(),
    })
}

fn mark_like_match(text: &str, needle: &str) -> String {
    make_like_snippet(text, needle)
}

const SESSION_COLS: &str =
    "s.key, s.agent_id, s.native_id, s.title, s.project_path, s.project_name,
    s.git_branch, s.created_at, s.updated_at, s.message_count, s.tokens_used, s.model, s.source,
    s.archived, s.file_path, s.file_size, COALESCE(u.favorite,0), COALESCE(u.pinned,0), s.host";

const ROOT_WHEN_HIDING_ARCHIVED: &str = "(s.parent_key = '' OR NOT EXISTS (
       SELECT 1 FROM sessions p WHERE p.key = s.parent_key AND p.archived = 0
     ))";
const ROOT_IGNORING_ARCHIVED: &str =
    "(s.parent_key = '' OR NOT EXISTS (SELECT 1 FROM sessions p WHERE p.key = s.parent_key))";
const ROOT_UPDATED_ACTIVE: &str =
    "MAX(s.updated_at, COALESCE((SELECT MAX(c.updated_at) FROM sessions c
      WHERE c.parent_key = s.key AND c.archived = 0), 0))";
const ROOT_UPDATED_ALL: &str =
    "MAX(s.updated_at, COALESCE((SELECT MAX(c.updated_at) FROM sessions c
      WHERE c.parent_key = s.key), 0))";
const ROOT_MESSAGES_ACTIVE: &str =
    "s.message_count + COALESCE((SELECT SUM(c.message_count) FROM sessions c
      WHERE c.parent_key = s.key AND c.archived = 0), 0)";
const ROOT_MESSAGES_ALL: &str =
    "s.message_count + COALESCE((SELECT SUM(c.message_count) FROM sessions c
      WHERE c.parent_key = s.key), 0)";
/// token 与消息数同形制:根自带的加上活跃/全部子会话的。没报 token 的行
/// (tokens_used 为 NULL)当 0——排序沉底,列表值展示也让位给"未报"语义
const ROOT_TOKENS_ACTIVE: &str =
    "COALESCE(s.tokens_used, 0) + COALESCE((SELECT SUM(c.tokens_used) FROM sessions c
      WHERE c.parent_key = s.key AND c.archived = 0), 0)";
const ROOT_TOKENS_ALL: &str =
    "COALESCE(s.tokens_used, 0) + COALESCE((SELECT SUM(c.tokens_used) FROM sessions c
      WHERE c.parent_key = s.key), 0)";
const ROOT_SESSION_COLS_ACTIVE: &str =
    "s.key, s.agent_id, s.native_id, s.title, s.project_path, s.project_name,
     s.git_branch, s.created_at,
     MAX(s.updated_at, COALESCE((SELECT MAX(c.updated_at) FROM sessions c
       WHERE c.parent_key = s.key AND c.archived = 0), 0)),
     s.message_count + COALESCE((SELECT SUM(c.message_count) FROM sessions c
       WHERE c.parent_key = s.key AND c.archived = 0), 0),
     COALESCE(s.tokens_used, 0) + COALESCE((SELECT SUM(c.tokens_used) FROM sessions c
       WHERE c.parent_key = s.key AND c.archived = 0), 0),
     s.model, s.source, s.archived, s.file_path, s.file_size,
     COALESCE(u.favorite,0), COALESCE(u.pinned,0), s.host";
const ROOT_SESSION_COLS_ALL: &str =
    "s.key, s.agent_id, s.native_id, s.title, s.project_path, s.project_name,
     s.git_branch, s.created_at,
     MAX(s.updated_at, COALESCE((SELECT MAX(c.updated_at) FROM sessions c
       WHERE c.parent_key = s.key), 0)),
     s.message_count + COALESCE((SELECT SUM(c.message_count) FROM sessions c
       WHERE c.parent_key = s.key), 0),
     COALESCE(s.tokens_used, 0) + COALESCE((SELECT SUM(c.tokens_used) FROM sessions c
       WHERE c.parent_key = s.key), 0),
     s.model, s.source, s.archived, s.file_path, s.file_size,
     COALESCE(u.favorite,0), COALESCE(u.pinned,0), s.host";

fn relation_row_to_meta(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionRelation> {
    Ok(SessionRelation {
        relation: row.get(0)?,
        source: row.get(1)?,
        session: SessionMeta {
            key: row.get(2)?,
            agent: AgentId::from_str(&row.get::<_, String>(3)?).unwrap_or(AgentId::Codex),
            id: row.get(4)?,
            title: row.get(5)?,
            project_path: row.get(6)?,
            project_name: row.get(7)?,
            git_branch: row.get(8)?,
            created_at: row.get(9)?,
            updated_at: row.get(10)?,
            message_count: row.get(11)?,
            tokens_used: row.get(12)?,
            model: row.get(13)?,
            source: row.get(14)?,
            archived: row.get::<_, i64>(15)? != 0,
            file_path: row.get(16)?,
            size_bytes: row.get(17)?,
            favorite: row.get::<_, i64>(18)? != 0,
            pinned: row.get::<_, i64>(19)? != 0,
            host: row.get(20)?,
        },
    })
}

fn relation_session_meta(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<SessionMeta> {
    Ok(SessionMeta {
        key: row.get(offset)?,
        agent: AgentId::from_str(&row.get::<_, String>(offset + 1)?).unwrap_or(AgentId::Codex),
        id: row.get(offset + 2)?,
        title: row.get(offset + 3)?,
        project_path: row.get(offset + 4)?,
        project_name: row.get(offset + 5)?,
        git_branch: row.get(offset + 6)?,
        created_at: row.get(offset + 7)?,
        updated_at: row.get(offset + 8)?,
        message_count: row.get(offset + 9)?,
        tokens_used: row.get(offset + 10)?,
        model: row.get(offset + 11)?,
        source: row.get(offset + 12)?,
        archived: row.get::<_, i64>(offset + 13)? != 0,
        file_path: row.get(offset + 14)?,
        size_bytes: row.get(offset + 15)?,
        favorite: row.get::<_, i64>(offset + 16)? != 0,
        pinned: row.get::<_, i64>(offset + 17)? != 0,
        host: row.get(offset + 18)?,
    })
}

fn child_filter_sql(
    filter: &SessionFilter,
    parent_key: Option<&str>,
) -> (String, Vec<Box<dyn rusqlite::ToSql>>) {
    let mut wheres = Vec::new();
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    match parent_key {
        Some(parent) => {
            wheres.push("s.parent_key = ?".to_string());
            args.push(Box::new(parent.to_string()));
        }
        None => wheres.push("s.parent_key != ''".to_string()),
    }
    push_session_filters(filter, "s.updated_at", &mut wheres, &mut args);
    (format!("WHERE {}", wheres.join(" AND ")), args)
}

/// ORDER BY 里置顶优先的那一段;`ignore_pins` 时为空,纯按排序键
fn pin_order(f: &SessionFilter) -> &'static str {
    if f.ignore_pins {
        ""
    } else {
        "COALESCE(u.pinned,0) DESC, "
    }
}

/// `?,?,?` 占位串
fn placeholders(n: usize) -> String {
    vec!["?"; n].join(",")
}

/// SessionFilter 里作用于会话行本身的谓词(agents / 项目并集 / 时间下界 /
/// 收藏 / 归档 / 标题词)。list_sessions 与 child_filter_sql 共用这一份,
/// roots_only 与 parent 谓词由各自追加——新增筛选字段只改这里(再教会
/// workbench 的两面镜子,见 models.rs SessionFilter 注释)。
/// `updated_col` 是时间下界作用的表达式:根会话列表传聚合后的活动时间
fn push_session_filters(
    f: &SessionFilter,
    updated_col: &str,
    wheres: &mut Vec<String>,
    args: &mut Vec<Box<dyn rusqlite::ToSql>>,
) {
    if !f.agents.is_empty() {
        wheres.push(format!("s.agent_id IN ({})", placeholders(f.agents.len())));
        for a in &f.agents {
            args.push(Box::new(a.as_str().to_string()));
        }
    }
    if !f.project_paths.is_empty() {
        wheres.push(format!(
            "s.project_path IN ({})",
            placeholders(f.project_paths.len())
        ));
        for p in &f.project_paths {
            args.push(Box::new(p.clone()));
        }
    }
    if !f.tags.is_empty() {
        wheres.push(format!(
            "EXISTS (
               SELECT 1 FROM session_tags st
               WHERE st.session_key = s.key AND st.tag IN ({})
             )",
            placeholders(f.tags.len())
        ));
        for tag in &f.tags {
            args.push(Box::new(tag.clone()));
        }
    }
    if !f.models.is_empty() {
        wheres.push(format!("s.model IN ({})", placeholders(f.models.len())));
        for m in &f.models {
            args.push(Box::new(m.clone()));
        }
    }
    if let Some(t) = f.updated_since {
        wheres.push(format!("{updated_col} >= ?"));
        args.push(Box::new(t));
    }
    if f.favorite_only {
        wheres.push("COALESCE(u.favorite, 0) = 1".into());
    }
    if !f.include_archived {
        wheres.push("s.archived = 0".into());
    }
    if let Some(q) = f
        .title_query
        .as_deref()
        .map(str::trim)
        .filter(|q| !q.is_empty())
    {
        wheres.push("(s.title LIKE ? ESCAPE '\\' OR s.project_name LIKE ? ESCAPE '\\')".into());
        let like = format!("%{}%", escape_like(q));
        args.push(Box::new(like.clone()));
        args.push(Box::new(like));
    }
}

/// memories 连它的归属会话:项目路径在读时解析——adapter 填了就用 adapter 的,
/// 否则取 `session_key` 指向的会话的(线程级记忆是它所属的会话,Claude 项目级是
/// 同目录最新的会话)。归属随索引走,会话被重新归属、晚于记忆才入库都自动跟上
const MEMORY_SESSION_JOIN: &str = "LEFT JOIN sessions s ON s.key = m.session_key";
const MEMORY_PROJECT: &str = "COALESCE(NULLIF(m.project_path, ''), s.project_path, '')";

/// memories 的列(带 `m.` 前缀:搜索要与 memories_fts 连表,裸 key 会歧义);
/// 必须带上 `MEMORY_SESSION_JOIN` 选,项目两列就是 `MEMORY_PROJECT` 那个表达式。
/// 最后一列是正文的位置,`row_to_memory` 按位读
macro_rules! memory_cols {
    ($body:literal) => {
        concat!(
            "m.key, m.agent_id, m.host, m.scope,
    COALESCE(NULLIF(m.project_path, ''), s.project_path, ''),
    COALESCE(NULLIF(m.project_name, ''), s.project_name, ''),
    m.session_key, m.path, m.title, m.updated_at, m.size_bytes, m.source, ",
            $body
        )
    };
}
const MEMORY_COLS: &str = memory_cols!("m.body");
/// 列表用的同一组列,只是正文给空串:列表谁都不看正文(GUI 阅读时经 get_memory
/// 另取,MCP 的 wake_list_memories 只打标题),没必要每次刷新把几百 KB 文本拉出来
const MEMORY_LIST_COLS: &str = memory_cols!("''");

fn row_to_memory(r: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryDoc> {
    let agent: String = r.get(1)?;
    let scope: String = r.get(3)?;
    Ok(MemoryDoc {
        key: r.get(0)?,
        agent: AgentId::from_str(&agent).unwrap_or(AgentId::ClaudeCode),
        host: r.get(2)?,
        scope: MemoryScope::parse(&scope).unwrap_or(MemoryScope::Project),
        project_path: r.get(4)?,
        project_name: r.get(5)?,
        session_key: r.get(6)?,
        path: r.get(7)?,
        title: r.get(8)?,
        updated_at: r.get(9)?,
        size_bytes: r.get(10)?,
        source: r.get(11)?,
        body: r.get(12)?,
    })
}

/// list_memories / search_memories 共用的筛选谓词(表别名 m):agent 并集;项目并集
/// 之外用户级记忆默认放行——它对每个项目都成立;`f.user` 可以把它剔掉(GUI 的
/// 项目行)或只留它(GUI 的 User memory 行)
fn memory_filter(f: &MemoryFilter) -> (String, Vec<Box<dyn rusqlite::ToSql>>) {
    let mut sql = String::new();
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    let user = MemoryScope::User.as_str();
    match f.user {
        UserMemories::Alongside => {}
        UserMemories::Excluded => sql.push_str(&format!(" AND m.scope != '{user}'")),
        UserMemories::Only => sql.push_str(&format!(" AND m.scope = '{user}'")),
    }
    if !f.agents.is_empty() {
        sql.push_str(&format!(
            " AND m.agent_id IN ({})",
            placeholders(f.agents.len())
        ));
        for a in &f.agents {
            args.push(Box::new(a.as_str().to_string()));
        }
    }
    if let Some(since) = f.updated_since {
        sql.push_str(" AND m.updated_at >= ?");
        args.push(Box::new(since));
    }
    if f.scopes_projects() {
        // 项目并集 ∪ 没归属的一组(显式的 unattributed,不拿空串当暗号:空串什么都
        // 不匹配)∪ 用户级(对每个项目都成立;只有 Alongside 放行——Excluded 上面已
        // 剔掉,Only 与项目筛选本就没有交集)
        let mut terms: Vec<String> = Vec::new();
        if !f.project_paths.is_empty() {
            terms.push(format!(
                "({MEMORY_PROJECT} != '' AND {MEMORY_PROJECT} IN ({}))",
                placeholders(f.project_paths.len())
            ));
            for p in &f.project_paths {
                args.push(Box::new(p.clone()));
            }
        }
        if f.unattributed {
            terms.push(format!("{MEMORY_PROJECT} = ''"));
        }
        if f.user == UserMemories::Alongside {
            terms.push(format!("m.scope = '{user}'"));
        }
        sql.push_str(&format!(" AND ({})", terms.join(" OR ")));
    }
    (sql, args)
}

/// 自定义记忆来源的两条写语句,add / remove / replace 共用(replace = 同一事务里先删后加)
fn insert_memory_source(conn: &rusqlite::Connection, agent: &str, path: &str) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO memory_sources_custom(agent, path, added_at) VALUES (?1, ?2, ?3)",
        params![agent, path, now_ms()],
    )?;
    Ok(())
}

/// 连同它的停用记录一起删(日后重新添加同一路径要按启用开始)
fn delete_memory_source(conn: &rusqlite::Connection, agent: &str, path: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM memory_sources_custom WHERE agent = ?1 AND path = ?2",
        params![agent, path],
    )?;
    conn.execute(
        "DELETE FROM memory_sources_disabled WHERE agent = ?1 AND source = ?2",
        params![agent, path],
    )?;
    Ok(())
}

/// 写一份记忆:memories 行按 key 就地更新(id 不变,memories_fts 的 rowid 就是它),
/// FTS 那份先按 rowid 删再插。语句都走 prepare_cached——一次冷建一百多份,逐条
/// 编译 SQL 白费
fn upsert_memory(tx: &rusqlite::Transaction<'_>, d: &MemoryDoc) -> Result<()> {
    let id: i64 = tx
        .prepare_cached(
            "INSERT INTO memories(key, agent_id, host, scope, project_path, project_name,
           session_key, path, title, updated_at, size_bytes, source, body)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
         ON CONFLICT(key) DO UPDATE SET agent_id = excluded.agent_id, host = excluded.host,
           scope = excluded.scope, project_path = excluded.project_path,
           project_name = excluded.project_name, session_key = excluded.session_key,
           path = excluded.path, title = excluded.title, updated_at = excluded.updated_at,
           size_bytes = excluded.size_bytes, source = excluded.source, body = excluded.body
         RETURNING id",
        )?
        .query_row(
            params![
                d.key,
                d.agent.as_str(),
                d.host,
                d.scope.as_str(),
                d.project_path,
                d.project_name,
                d.session_key,
                d.path,
                d.title,
                d.updated_at,
                d.size_bytes,
                d.source,
                d.body,
            ],
            |r| r.get::<_, i64>(0),
        )?;
    tx.prepare_cached("DELETE FROM memories_fts WHERE rowid = ?1")?
        .execute(params![id])?;
    tx.prepare_cached("INSERT INTO memories_fts(rowid, title, body) VALUES (?1, ?2, ?3)")?
        .execute(params![id, d.title, d.body])?;
    Ok(())
}

fn row_to_meta(r: &rusqlite::Row<'_>) -> rusqlite::Result<SessionMeta> {
    let agent_str: String = r.get(1)?;
    Ok(SessionMeta {
        key: r.get(0)?,
        agent: AgentId::from_str(&agent_str).unwrap_or(AgentId::ClaudeCode),
        id: r.get(2)?,
        title: r.get(3)?,
        project_path: r.get(4)?,
        project_name: r.get(5)?,
        git_branch: r.get(6)?,
        created_at: r.get(7)?,
        updated_at: r.get(8)?,
        message_count: r.get(9)?,
        tokens_used: r.get(10)?,
        model: r.get(11)?,
        source: r.get(12)?,
        archived: r.get::<_, i64>(13)? == 1,
        file_path: r.get(14)?,
        size_bytes: r.get(15)?,
        favorite: r.get::<_, i64>(16)? == 1,
        pinned: r.get::<_, i64>(17)? == 1,
        host: r.get(18)?,
    })
}

/// Insights 与日期细分共用的会话范围:去重远程副本,并可选限制到一家 Agent。
fn create_canonical_sessions(conn: &Connection, agent: Option<AgentId>) -> Result<()> {
    conn.execute(
        "CREATE TEMP TABLE canonical_sessions AS
         SELECT key FROM (
             SELECT key, ROW_NUMBER() OVER (
                 PARTITION BY agent_id, native_id, created_at,
                              CASE WHEN created_at > 0 THEN '' ELSE key END
                 ORDER BY updated_at DESC, host) AS rn
             FROM sessions WHERE archived = 0
               AND (?1 IS NULL OR agent_id = ?1)
         ) WHERE rn = 1",
        params![agent.map(|agent| agent.as_str())],
    )?;
    Ok(())
}

/// Insights 的 "Agents asking Wake":各家 agent 在 `since_ms` 之后查 Wake 的次数,按接入
/// 渠道分列,总数降序、只含 >0 的家。按每次调用所在消息的时刻归窗,缺时间戳的退回
/// 会话 updated_at。跑在 insights 的私有连接上,`canonical_sessions` 是它建的 temp 表
/// (归档不计、多 host 镜像只算一份)。这是 mcp-roadmap 定的"阶段 A 有没有真实使用"的仪表
fn tally_wake_lookups(conn: &Connection, since_ms: i64) -> Result<Vec<LookupTally>> {
    let mut stmt = conn.prepare(
        "SELECT s.agent_id, SUM(l.channel = 'mcp'), SUM(l.channel = 'cli')
         FROM wake_lookups l JOIN sessions s ON s.key = l.session_key
         WHERE s.archived = 0 AND COALESCE(l.ts, s.updated_at) >= ?1
           AND s.key IN canonical_sessions
         GROUP BY s.agent_id ORDER BY COUNT(*) DESC, s.agent_id",
    )?;
    let rows = stmt
        .query_map(params![since_ms], |r| {
            Ok(LookupTally {
                name: r.get(0)?,
                mcp: r.get(1)?,
                cli: r.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// 清掉一条会话在库里的全部派生行:messages 及其 FTS 影子、wake_lookups。写入前
/// (write_session_tx)与删除时(remove_sessions_recorded)共用;titles_fts 不在这里,
/// 它随 upsert_session 走(quick 路径也要改标题)。再加一张派生表只改这里和写入侧
fn clear_session_rows(tx: &rusqlite::Transaction<'_>, key: &str) -> Result<()> {
    // FTS external content 需要显式 delete 旧行
    let rows: Vec<(i64, String)> = tx
        .prepare_cached("SELECT id, text FROM messages WHERE session_key = ?1")?
        .query_map(params![key], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut fts_del = tx.prepare_cached(
        "INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', ?1, ?2)",
    )?;
    for (id, text) in rows {
        fts_del.execute(params![id, text])?;
    }
    drop(fts_del);
    tx.prepare_cached("DELETE FROM messages WHERE session_key = ?1")?
        .execute(params![key])?;
    tx.prepare_cached("DELETE FROM wake_lookups WHERE session_key = ?1")?
        .execute(params![key])?;
    Ok(())
}

/// write_session / write_session_guarded 共用的事务内核
fn write_session_tx(
    tx: &rusqlite::Transaction<'_>,
    meta: &SessionMeta,
    file_mtime: i64,
    units: &[IndexUnit],
    lookups: &[WakeLookup],
) -> Result<()> {
    clear_session_rows(tx, &meta.key)?;
    upsert_session(tx, meta, file_mtime)?;

    let mut ins_msg = tx.prepare_cached(
        "INSERT INTO messages(session_key, sidechain_id, seq, role, ts, text) VALUES (?1,?2,?3,?4,?5,?6)",
    )?;
    let mut ins_fts = tx.prepare_cached("INSERT INTO messages_fts(rowid, text) VALUES (?1, ?2)")?;
    for u in units {
        ins_msg.execute(params![
            meta.key,
            u.sidechain_id,
            u.seq,
            u.role.as_str(),
            u.timestamp,
            u.text
        ])?;
        let rowid = tx.last_insert_rowid();
        ins_fts.execute(params![rowid, u.text])?;
    }
    // Wake 调用记录与 messages 同事务、同 key 删插;quick 路径(write_meta_only)
    // 不经这里,所以不会把记录冲掉。绝大多数会话一次都没有,别为它白取一次语句
    if !lookups.is_empty() {
        let mut ins_lookup = tx.prepare_cached(
            "INSERT INTO wake_lookups(session_key, seq, ts, channel, tool) VALUES (?1,?2,?3,?4,?5)",
        )?;
        for l in lookups {
            ins_lookup.execute(params![
                meta.key,
                l.seq,
                l.timestamp,
                l.channel.as_str(),
                l.tool
            ])?;
        }
    }
    Ok(())
}

fn upsert_session(tx: &rusqlite::Transaction<'_>, m: &SessionMeta, file_mtime: i64) -> Result<()> {
    // titles_fts 与 sessions.title 同步的**唯一写点**:全量、增量、quick(write_meta_only)
    // 三条路都经这里,标题一改索引即跟上。按 key 删再插(UNINDEXED 列的 DELETE 是
    // 整表扫,几千行也就微秒级),空标题不入索引
    tx.execute("DELETE FROM titles_fts WHERE key = ?1", params![m.key])?;
    if !m.title.is_empty() {
        tx.execute(
            "INSERT INTO titles_fts(key, title) VALUES (?1, ?2)",
            params![m.key, m.title],
        )?;
    }
    tx.execute(
        "INSERT INTO sessions(key, agent_id, native_id, title, project_path, project_name,
           git_branch, created_at, updated_at, message_count, tokens_used, model, source,
           archived, file_path, file_size, file_mtime, unknown_lines, host)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,0,?18)
         ON CONFLICT(key) DO UPDATE SET
           title=excluded.title, project_path=excluded.project_path,
           project_name=excluded.project_name, git_branch=excluded.git_branch,
           created_at=excluded.created_at, updated_at=excluded.updated_at,
           message_count=excluded.message_count, tokens_used=excluded.tokens_used,
           model=excluded.model, source=excluded.source, archived=excluded.archived,
           file_path=excluded.file_path, file_size=excluded.file_size,
           file_mtime=excluded.file_mtime, host=excluded.host",
        params![
            m.key,
            m.agent.as_str(),
            m.id,
            m.title,
            m.project_path,
            m.project_name,
            m.git_branch,
            m.created_at,
            m.updated_at,
            m.message_count,
            m.tokens_used,
            m.model,
            m.source,
            m.archived as i64,
            m.file_path,
            m.size_bytes,
            file_mtime,
            m.host,
        ],
    )?;
    Ok(())
}

fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// 搜索串按空白切成词项(会话搜索与记忆搜索同一套分词)
fn fts_terms(q: &str) -> Vec<&str> {
    q.split_whitespace().filter(|s| !s.is_empty()).collect()
}

/// 有词项短于 3 码点就走 LIKE 子串扫描——trigram 分词对更短的词无能为力
fn needs_like_fallback(segs: &[&str]) -> bool {
    segs.iter().any(|s| s.chars().count() < 3)
}

/// FTS5 的 MATCH 表达式:每个词项加引号(内部引号翻倍)、AND 连接。三张 FTS 表共用,
/// 转义规则只此一处
fn fts_match_expr(segs: &[&str]) -> String {
    segs.iter()
        .map(|s| format!("\"{}\"", s.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" AND ")
}

/// LIKE 降级路径的 WHERE:每个词项对每一列各一个 `LIKE ? ESCAPE '\'`(列之间 OR、
/// 词项之间 AND),参数由 `like_args` 按同一顺序给。正文、标题、记忆三条降级路径共用
fn like_where(cols: &[&str], terms: usize) -> String {
    let per_term = cols
        .iter()
        .map(|c| format!("{c} LIKE ? ESCAPE '\\'"))
        .collect::<Vec<_>>()
        .join(" OR ");
    let per_term = if cols.len() > 1 {
        format!("({per_term})")
    } else {
        per_term
    };
    std::iter::repeat_n(per_term, terms)
        .collect::<Vec<_>>()
        .join(" AND ")
}

/// `like_where` 的参数:每个词项转义成 `%term%`,每列一份
fn like_args(segs: &[&str], cols: usize) -> Vec<Box<dyn rusqlite::ToSql>> {
    segs.iter()
        .flat_map(|s| {
            let pat = format!("%{}%", escape_like(s));
            std::iter::repeat_n(pat, cols)
        })
        .map(|pat| Box::new(pat) as Box<dyn rusqlite::ToSql>)
        .collect()
}

/// LIKE 降级路径的 snippet:不区分大小写找首个词项,前 40 / 后 80 字符开窗并高亮。
/// 全程按**字符**下标走:逐字符小写并记下每个小写字符来自原文第几个字符——小写
/// 不保长(Ω→ω、İ→i̇、K→k 字节数与字符数都会变),拿小写串里的字节偏移去切原文正是
/// 2026-09-21 review 复现的 panic(⌘K 逐字键入 CJK 查询必经此路,后台线程 panic
/// 直接 abort 整个 app)
fn make_like_snippet(text: &str, first_seg: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let needle: Vec<char> = first_seg.to_lowercase().chars().collect();
    let mut lower: Vec<char> = Vec::with_capacity(chars.len());
    let mut origin: Vec<usize> = Vec::with_capacity(chars.len());
    for (i, c) in chars.iter().enumerate() {
        for lc in c.to_lowercase() {
            lower.push(lc);
            origin.push(i);
        }
    }
    let hit = (!needle.is_empty())
        .then(|| {
            lower
                .windows(needle.len())
                .position(|w| w == needle.as_slice())
        })
        .flatten();
    let Some(pos) = hit else {
        return chars.iter().take(120).collect();
    };
    let char_idx = origin[pos];
    let match_end = origin[pos + needle.len() - 1] + 1;
    let start = char_idx.saturating_sub(40);
    let end = (match_end + 80).min(chars.len());
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.extend(&chars[start..char_idx]);
    out.push(HL_OPEN);
    out.extend(&chars[char_idx..match_end]);
    out.push(HL_CLOSE);
    out.extend(&chars[match_end..end]);
    if end < chars.len() {
        out.push('…');
    }
    out
}

/// (current, longest) 连续活跃天数。`daily` 须按日期升序(insights 的
/// SQL 保证)。current 从 today 往回数;今天尚无活动时允许从昨天起算
/// (GitHub 惯例:一天没结束不清零),更早断档即为 0。
fn compute_streaks(daily: &[(chrono::NaiveDate, i64)], today: chrono::NaiveDate) -> (i64, i64) {
    let mut longest = 0i64;
    let mut run = 0i64;
    let mut prev: Option<chrono::NaiveDate> = None;
    for &(d, _) in daily {
        run = match prev {
            Some(p) if (d - p).num_days() == 1 => run + 1,
            _ => 1,
        };
        longest = longest.max(run);
        prev = Some(d);
    }
    let current = match prev {
        Some(last) if (today - last).num_days() <= 1 => run,
        _ => 0,
    };
    (current, longest)
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn insert_workspace_change(
    tx: &rusqlite::Transaction<'_>,
    project_path: &str,
    file_path: &str,
    kind: WorkspaceChangeKind,
    observed_at: i64,
    before_hash: Option<&str>,
    after_hash: Option<&str>,
) -> Result<WorkspaceChangeEvent> {
    tx.execute(
        "INSERT INTO workspace_change_events
           (project_path, file_path, change_kind, observed_at, before_hash, after_hash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            project_path,
            file_path,
            kind.as_str(),
            observed_at,
            before_hash,
            after_hash
        ],
    )?;
    let change_id = tx.last_insert_rowid();
    Ok(WorkspaceChangeEvent {
        id: change_id,
        project_path: project_path.to_string(),
        file_path: file_path.to_string(),
        kind,
        observed_at,
        before_hash: before_hash.map(str::to_string),
        after_hash: after_hash.map(str::to_string),
    })
}

fn same_tombstone_path(left: &str, right: &str) -> bool {
    let normalize = |path: &str| {
        let path = path.replace('\\', "/");
        path.strip_prefix("//?/").unwrap_or(&path).to_string()
    };
    let left = normalize(left);
    let right = normalize(right);
    #[cfg(windows)]
    {
        left.eq_ignore_ascii_case(&right)
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

/// `--db` 给了就用它,否则取 GUI 那份。调用点一律**惰性**求值:
/// `--help` 不该触发目录创建。
pub fn path_or_default(db: Option<&Path>) -> PathBuf {
    db.map(Path::to_path_buf).unwrap_or_else(default_db_path)
}

/// 索引库路径:macOS 为 ~/Library/Application Support/ContextOS,Linux 为
/// ~/.local/share/ContextOS,Windows 为 %LOCALAPPDATA%\ContextOS。
///
/// Windows 取 data_local_dir 而非 data_dir:后者是漫游 %APPDATA%,而本库
/// 开 WAL——WAL 要 -shm 共享内存映射,重定向到网络盘的漫游目录上根本打不开
/// (域环境 Folder Redirection 是标配),Wake 会在启动即致命退出;何况这是
/// 可随时重建的索引,几百 MB 跟着登录/注销来回同步纯属浪费(2026-08-25 review)
pub fn default_db_path() -> std::path::PathBuf {
    crate::storage::root().join("contextos.db")
}
