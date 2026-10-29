//! Storage for the manually monitored workspace history.
//!
//! Workspace history deliberately lives outside the session index.  A file
//! watcher can therefore import or remove a large directory without taking
//! the session database write lock.

use crate::workspace_changes::{
    ExplicitSessionFileChange, SessionChangeSelection, SessionFileChangeEvent,
    WorkspaceChangeDetail, WorkspaceChangeEvent, WorkspaceChangeKind, WorkspaceFileObservation,
    WorkspaceObservationMode, WorkspaceRoot,
};
use anyhow::{Context as _, Result};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const SESSION_CHANGE_SELECTIONS_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS session_change_selections (
  session_key TEXT PRIMARY KEY,
  selected_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_change_selections_time
  ON session_change_selections(selected_at DESC, session_key);
"#;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS workspace_roots (
  path        TEXT PRIMARY KEY COLLATE NOCASE,
  name        TEXT NOT NULL,
  added_at    INTEGER NOT NULL,
  imported_at INTEGER
);
CREATE TABLE IF NOT EXISTS workspace_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_snapshots (
  content_hash TEXT PRIMARY KEY,
  is_text      INTEGER NOT NULL,
  size_bytes   INTEGER NOT NULL,
  captured_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_files (
  project_path TEXT NOT NULL COLLATE NOCASE,
  file_path    TEXT NOT NULL COLLATE NOCASE,
  content_hash TEXT NOT NULL,
  file_mtime   INTEGER NOT NULL,
  size_bytes   INTEGER NOT NULL,
  observed_at  INTEGER NOT NULL,
  PRIMARY KEY (project_path, file_path)
);
CREATE TABLE IF NOT EXISTS workspace_activity (
  id           INTEGER PRIMARY KEY,
  project_path TEXT NOT NULL COLLATE NOCASE,
  file_path    TEXT NOT NULL COLLATE NOCASE,
  change_kind  TEXT NOT NULL CHECK (change_kind IN ('created','modified','deleted')),
  observed_at  INTEGER NOT NULL,
  before_hash  TEXT,
  after_hash   TEXT
);
CREATE INDEX IF NOT EXISTS idx_workspace_activity_project_time
  ON workspace_activity(project_path, observed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_activity_file
  ON workspace_activity(project_path, file_path, observed_at DESC);
CREATE TABLE IF NOT EXISTS session_file_changes (
  id           INTEGER PRIMARY KEY,
  session_key  TEXT NOT NULL,
  project_path TEXT NOT NULL COLLATE NOCASE,
  file_path    TEXT NOT NULL COLLATE NOCASE,
  change_kind  TEXT NOT NULL CHECK (change_kind IN ('created','modified','deleted')),
  observed_at  INTEGER NOT NULL,
  after_hash   TEXT,
  source_event_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_session_file_changes_time
  ON session_file_changes(observed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_session_file_changes_session
  ON session_file_changes(session_key, observed_at DESC);
"#;

pub struct WorkspaceStore {
    write: Mutex<Connection>,
    read: Mutex<Connection>,
    path: PathBuf,
    cas_dir: PathBuf,
}

#[derive(Debug, Default)]
pub struct WorkspaceChangeDeleteResult {
    pub deleted: bool,
    pub unreferenced_snapshots_removed: usize,
    pub bytes_reclaimed: u64,
    pub cleanup_warnings: Vec<String>,
}

impl WorkspaceStore {
    pub fn open(path: &Path, cas_dir: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::create_dir_all(cas_dir)?;
        let write = open_connection(path)?;
        write.execute_batch(SCHEMA)?;
        write.execute_batch(SESSION_CHANGE_SELECTIONS_SCHEMA)?;
        migrate_workspace_activity(&write)?;
        let read = open_connection(path)?;
        Ok(Self {
            write: Mutex::new(write),
            read: Mutex::new(read),
            path: path.to_path_buf(),
            cas_dir: cas_dir.to_path_buf(),
        })
    }

    /// Open an existing workspace database without creating or migrating it.
    /// MCP and CLI use this path so a read-only query does not create an empty
    /// workspace database beside an index that has never monitored a project.
    pub fn open_existing(path: &Path, cas_dir: &Path) -> Result<Self> {
        anyhow::ensure!(
            path.is_file(),
            "workspace change database does not exist: {}",
            path.display()
        );
        let flags =
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let read = Connection::open_with_flags(path, flags)?;
        read.busy_timeout(std::time::Duration::from_secs(3))?;
        let write = Connection::open_with_flags(path, flags)?;
        write.busy_timeout(std::time::Duration::from_secs(3))?;
        Ok(Self {
            write: Mutex::new(write),
            read: Mutex::new(read),
            path: path.to_path_buf(),
            cas_dir: cas_dir.to_path_buf(),
        })
    }

    pub(crate) fn open_existing_writable(path: &Path, cas_dir: &Path) -> Result<Self> {
        anyhow::ensure!(
            path.is_file(),
            "workspace change database does not exist: {}",
            path.display()
        );
        fs::create_dir_all(cas_dir)?;
        let write = open_connection(path)?;
        write.execute_batch(SESSION_CHANGE_SELECTIONS_SCHEMA)?;
        migrate_workspace_activity(&write)?;
        let read = open_connection(path)?;
        Ok(Self {
            write: Mutex::new(write),
            read: Mutex::new(read),
            path: path.to_path_buf(),
            cas_dir: cas_dir.to_path_buf(),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn list_workspace_roots(&self) -> Result<Vec<WorkspaceRoot>> {
        let conn = self.read.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT path, name FROM workspace_roots ORDER BY lower(name), lower(path)")?;
        let rows = stmt
            .query_map([], |row| {
                Ok(WorkspaceRoot {
                    path: row.get(0)?,
                    name: row.get(1)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub(crate) fn list_workspace_roots_for_watcher(&self) -> Result<Vec<(WorkspaceRoot, bool)>> {
        let conn = self.read.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT path, name, imported_at FROM workspace_roots
             ORDER BY lower(name), lower(path)",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    WorkspaceRoot {
                        path: row.get(0)?,
                        name: row.get(1)?,
                    },
                    row.get::<_, Option<i64>>(2)?.is_some(),
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub(crate) fn mark_workspace_root_imported(&self, path: &str) -> Result<()> {
        self.write.lock().unwrap().execute(
            "UPDATE workspace_roots SET imported_at = ?1 WHERE path = ?2 COLLATE NOCASE",
            params![crate::db::now_ms(), path],
        )?;
        Ok(())
    }

    pub fn add_workspace_root(&self, path: &Path) -> Result<WorkspaceRoot> {
        let canonical = fs::canonicalize(path)
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
        self.write.lock().unwrap().execute(
            "INSERT INTO workspace_roots(path, name, added_at, imported_at)
             VALUES (?1, ?2, ?3, NULL)
             ON CONFLICT(path) DO UPDATE SET name = excluded.name, imported_at = NULL",
            params![path, name, crate::db::now_ms()],
        )?;
        Ok(WorkspaceRoot { path, name })
    }

    /// Removing a root stops monitoring and clears its live file state, while
    /// retaining activity and CAS history for future cleanup/migration.
    pub fn remove_workspace_root(&self, path: &str) -> Result<()> {
        let mut conn = self.write.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM workspace_files WHERE project_path = ?1 COLLATE NOCASE",
            params![path],
        )?;
        tx.execute(
            "DELETE FROM workspace_roots WHERE path = ?1 COLLATE NOCASE",
            params![path],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn observe_workspace_files(
        &self,
        project_path: &str,
        observations: Vec<(String, WorkspaceFileObservation)>,
        mode: WorkspaceObservationMode,
        observed_at: i64,
    ) -> Result<Vec<WorkspaceChangeEvent>> {
        anyhow::ensure!(!project_path.is_empty(), "workspace project path is empty");
        let mut prepared = Vec::with_capacity(observations.len());
        for (file_path, observation) in observations {
            anyhow::ensure!(!file_path.is_empty(), "workspace file path is empty");
            prepared.push((file_path, observation));
        }

        let mut conn = self.write.lock().unwrap();
        let tx = conn.transaction()?;
        let mut events = Vec::new();
        for (file_path, observation) in prepared {
            let previous: Option<(String, i64)> = tx
                .query_row(
                    "SELECT content_hash, size_bytes FROM workspace_files
                     WHERE project_path = ?1 COLLATE NOCASE AND file_path = ?2 COLLATE NOCASE",
                    params![project_path, file_path],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;

            match observation {
                WorkspaceFileObservation::Present {
                    bytes,
                    file_mtime,
                    capture_text,
                } => {
                    let hash = format!("{:x}", Sha256::digest(&bytes));
                    let size_bytes = i64::try_from(bytes.len()).unwrap_or(i64::MAX);
                    let is_text = capture_text
                        && bytes.len() <= 1024 * 1024
                        && !bytes.contains(&0)
                        && std::str::from_utf8(&bytes).is_ok();
                    if is_text {
                        self.put_cas(&hash, &bytes)?;
                    }
                    tx.execute(
                        "INSERT INTO workspace_snapshots
                         (content_hash, is_text, size_bytes, captured_at)
                         VALUES (?1, ?2, ?3, ?4)
                         ON CONFLICT(content_hash) DO UPDATE SET
                           is_text = MAX(workspace_snapshots.is_text, excluded.is_text),
                           size_bytes = excluded.size_bytes,
                           captured_at = MAX(workspace_snapshots.captured_at, excluded.captured_at)",
                        params![hash, is_text as i64, size_bytes, observed_at],
                    )?;

                    let kind = match mode {
                        // Import only seeds the comparison state.  Existing
                        // files are not user changes and must stay out of the
                        // activity timeline.
                        WorkspaceObservationMode::Import => None,
                        WorkspaceObservationMode::Live => match previous.as_ref() {
                            Some((old, _)) if old == &hash => None,
                            Some(_) => Some(WorkspaceChangeKind::Modified),
                            None => Some(WorkspaceChangeKind::Created),
                        },
                    };
                    if let Some(kind) = kind {
                        let before = (mode == WorkspaceObservationMode::Live)
                            .then(|| previous.as_ref().map(|(hash, _)| hash.as_str()))
                            .flatten();
                        events.push(insert_activity(
                            &tx,
                            project_path,
                            &file_path,
                            kind,
                            observed_at,
                            before,
                            Some(&hash),
                        )?);
                    }
                    tx.execute(
                        "INSERT INTO workspace_files
                         (project_path, file_path, content_hash, file_mtime, size_bytes, observed_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                         ON CONFLICT(project_path, file_path) DO UPDATE SET
                           content_hash = excluded.content_hash, file_mtime = excluded.file_mtime,
                           size_bytes = excluded.size_bytes, observed_at = excluded.observed_at",
                        params![project_path, file_path, hash, file_mtime, size_bytes, observed_at],
                    )?;
                }
                WorkspaceFileObservation::Deleted => {
                    if let Some((old_hash, _)) = previous {
                        tx.execute(
                            "DELETE FROM workspace_files
                             WHERE project_path = ?1 COLLATE NOCASE AND file_path = ?2 COLLATE NOCASE",
                            params![project_path, file_path],
                        )?;
                        events.push(insert_activity(
                            &tx,
                            project_path,
                            &file_path,
                            WorkspaceChangeKind::Deleted,
                            observed_at,
                            Some(&old_hash),
                            None,
                        )?);
                    }
                }
            }
        }
        tx.commit()?;
        Ok(events)
    }

    pub fn delete_workspace_files(
        &self,
        project_path: &str,
        file_paths: &[String],
        observed_at: i64,
    ) -> Result<Vec<WorkspaceChangeEvent>> {
        let observations = file_paths
            .iter()
            .cloned()
            .map(|path| (path, WorkspaceFileObservation::Deleted))
            .collect();
        self.observe_workspace_files(
            project_path,
            observations,
            WorkspaceObservationMode::Live,
            observed_at,
        )
    }

    pub fn record_session_file_changes(
        &self,
        project_path: &str,
        session_key: &str,
        changes: &[ExplicitSessionFileChange],
    ) -> Result<bool> {
        let mut conn = self.write.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM session_file_changes WHERE session_key = ?1",
            params![session_key],
        )?;
        for change in changes {
            tx.execute(
                "INSERT INTO session_file_changes
                   (session_key, project_path, file_path, change_kind, observed_at, after_hash, source_event_key)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    session_key,
                    project_path,
                    change.file_path,
                    change.kind.as_str(),
                    change.observed_at,
                    change.after_hash,
                    change.source_event_key
                ],
            )?;
        }
        tx.commit()?;
        Ok(!changes.is_empty())
    }

    pub fn list_session_file_changes(&self, limit: usize) -> Result<Vec<SessionFileChangeEvent>> {
        let conn = self.read.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, session_key, project_path, file_path, change_kind, observed_at, after_hash, source_event_key
             FROM session_file_changes
             ORDER BY observed_at DESC, id DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit.clamp(1, 5000) as i64], row_to_session_event)?;
        let events = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(events)
    }

    pub fn select_session_changes(&self, session_key: &str) -> Result<bool> {
        let inserted = self.write.lock().unwrap().execute(
            "INSERT OR IGNORE INTO session_change_selections(session_key, selected_at)
             VALUES (?1, ?2)",
            params![session_key, crate::db::now_ms()],
        )?;
        Ok(inserted != 0)
    }

    pub fn deselect_session_changes(&self, session_key: &str) -> Result<bool> {
        let deleted = self.write.lock().unwrap().execute(
            "DELETE FROM session_change_selections WHERE session_key = ?1",
            params![session_key],
        )?;
        Ok(deleted != 0)
    }

    pub fn list_session_change_selections(&self) -> Result<Vec<SessionChangeSelection>> {
        let conn = self.read.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT session_key, selected_at FROM session_change_selections
             ORDER BY selected_at DESC, session_key",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(SessionChangeSelection {
                session_key: row.get(0)?,
                selected_at: row.get(1)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn list_session_file_changes_for_session(
        &self,
        session_key: &str,
        limit: usize,
    ) -> Result<Vec<SessionFileChangeEvent>> {
        let conn = self.read.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, session_key, project_path, file_path, change_kind, observed_at, after_hash, source_event_key
             FROM session_file_changes
             WHERE session_key = ?1
             ORDER BY observed_at DESC, id DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(
            params![session_key, limit.clamp(1, 5000) as i64],
            row_to_session_event,
        )?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn delete_workspace_path(
        &self,
        project_path: &str,
        relative: &str,
        observed_at: i64,
    ) -> Result<Vec<WorkspaceChangeEvent>> {
        let conn = self.read.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT file_path FROM workspace_files
             WHERE project_path = ?1 COLLATE NOCASE",
        )?;
        let paths = stmt
            .query_map(params![project_path], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        drop(stmt);
        drop(conn);
        let prefix = format!("{relative}/");
        let paths = paths
            .into_iter()
            .filter(|path| path.eq_ignore_ascii_case(relative) || path.starts_with(&prefix))
            .collect::<Vec<_>>();
        self.delete_workspace_files(project_path, &paths, observed_at)
    }

    pub fn list_workspace_file_paths(&self, project_path: &str) -> Result<Vec<String>> {
        let conn = self.read.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT file_path FROM workspace_files WHERE project_path = ?1 COLLATE NOCASE",
        )?;
        let rows = stmt
            .query_map(params![project_path], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn list_workspace_change_events(
        &self,
        project_path: &str,
        before: Option<(i64, i64)>,
        limit: usize,
    ) -> Result<Vec<WorkspaceChangeEvent>> {
        self.list_workspace_change_events_filtered(Some(project_path), None, before, limit)
    }

    /// List activity across one or all monitored projects. The cursor is the
    /// `(observed_at, id)` pair from the last row, so equal timestamps remain
    /// stable across pages.
    pub fn list_workspace_change_events_filtered(
        &self,
        project_path: Option<&str>,
        since: Option<i64>,
        before: Option<(i64, i64)>,
        limit: usize,
    ) -> Result<Vec<WorkspaceChangeEvent>> {
        let conn = self.read.lock().unwrap();
        let limit = limit.clamp(1, 500) as i64;
        let mut stmt = conn.prepare(
            "SELECT id, project_path, file_path, change_kind, observed_at,
                    before_hash, after_hash
             FROM workspace_activity
             WHERE (?1 IS NULL OR project_path = ?1 COLLATE NOCASE)
               AND (?2 IS NULL OR observed_at >= ?2)
               AND (?3 IS NULL OR observed_at < ?3 OR (observed_at = ?3 AND id < ?4))
             ORDER BY observed_at DESC, id DESC LIMIT ?5",
        )?;
        let rows = stmt.query_map(
            params![
                project_path,
                since,
                before.map(|v| v.0),
                before.map(|v| v.1),
                limit
            ],
            row_to_event,
        )?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    /// Delete one timeline entry and reclaim snapshots no longer referenced by
    /// any activity event or monitored-file baseline.
    pub fn delete_workspace_change(&self, id: i64) -> Result<bool> {
        Ok(self.delete_workspace_change_with_cleanup(id)?.deleted)
    }

    pub fn delete_workspace_change_with_cleanup(
        &self,
        id: i64,
    ) -> Result<WorkspaceChangeDeleteResult> {
        let mut conn = self.write.lock().unwrap();
        let tx = conn.transaction()?;
        let hashes = tx
            .query_row(
                "SELECT before_hash, after_hash FROM workspace_activity WHERE id = ?1",
                params![id],
                |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()?;
        let Some((before_hash, after_hash)) = hashes else {
            return Ok(WorkspaceChangeDeleteResult::default());
        };
        tx.execute("DELETE FROM workspace_activity WHERE id = ?1", params![id])?;

        let mut unique_hashes = Vec::with_capacity(2);
        for hash in [before_hash, after_hash].into_iter().flatten() {
            if !unique_hashes.contains(&hash) {
                unique_hashes.push(hash);
            }
        }
        let mut orphaned = Vec::new();
        for hash in unique_hashes {
            anyhow::ensure!(
                hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()),
                "invalid workspace snapshot hash `{hash}`"
            );
            let still_referenced: bool = tx.query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM workspace_activity
                    WHERE before_hash = ?1 OR after_hash = ?1
                 ) OR EXISTS(
                    SELECT 1 FROM workspace_files WHERE content_hash = ?1
                 ) OR EXISTS(
                    SELECT 1 FROM session_file_changes WHERE after_hash = ?1
                 )",
                params![hash],
                |row| row.get(0),
            )?;
            if still_referenced {
                continue;
            }
            let size_bytes: Option<i64> = tx
                .query_row(
                    "SELECT size_bytes FROM workspace_snapshots WHERE content_hash = ?1",
                    params![hash],
                    |row| row.get(0),
                )
                .optional()?;
            tx.execute(
                "DELETE FROM workspace_snapshots WHERE content_hash = ?1",
                params![hash],
            )?;
            orphaned.push((hash, size_bytes.unwrap_or_default().max(0) as u64));
        }
        tx.commit()?;

        let mut result = WorkspaceChangeDeleteResult {
            deleted: true,
            ..Default::default()
        };
        for (hash, size_bytes) in orphaned {
            match fs::remove_file(self.cas_dir.join(&hash)) {
                Ok(()) => {
                    result.unreferenced_snapshots_removed += 1;
                    result.bytes_reclaimed += size_bytes;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    result.unreferenced_snapshots_removed += 1;
                }
                Err(error) => result.cleanup_warnings.push(format!(
                    "could not remove snapshot {hash}: {error}"
                )),
            }
        }
        Ok(result)
    }

    pub fn workspace_change_detail(&self, id: i64) -> Result<Option<WorkspaceChangeDetail>> {
        let event = {
            let conn = self.read.lock().unwrap();
            conn.query_row(
                "SELECT id, project_path, file_path, change_kind, observed_at,
                            before_hash, after_hash
                     FROM workspace_activity WHERE id = ?1",
                params![id],
                row_to_event,
            )
            .optional()?
        };
        let Some(event) = event else { return Ok(None) };
        Ok(Some(WorkspaceChangeDetail {
            before_text: self.snapshot_text(event.before_hash.as_deref())?,
            after_text: self.snapshot_text(event.after_hash.as_deref())?,
            event,
        }))
    }

    fn put_cas(&self, hash: &str, bytes: &[u8]) -> Result<()> {
        let path = self.cas_dir.join(hash);
        if path.is_file() {
            return Ok(());
        }
        let temp = self
            .cas_dir
            .join(format!(".{hash}.{}.tmp", std::process::id()));
        fs::write(&temp, bytes)?;
        if let Err(error) = fs::rename(&temp, &path) {
            let _ = fs::remove_file(&temp);
            if !path.is_file() {
                return Err(error.into());
            }
        }
        Ok(())
    }

    fn snapshot_text(&self, hash: Option<&str>) -> Result<Option<String>> {
        let Some(hash) = hash else { return Ok(None) };
        let is_text: Option<bool> = self
            .read
            .lock()
            .unwrap()
            .query_row(
                "SELECT is_text FROM workspace_snapshots WHERE content_hash = ?1",
                params![hash],
                |row| row.get::<_, i64>(0).map(|value| value != 0),
            )
            .optional()?;
        if is_text != Some(true) {
            return Ok(None);
        }
        Ok(fs::read(self.cas_dir.join(hash))
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok()))
    }
}

fn open_connection(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.busy_timeout(std::time::Duration::from_secs(3))?;
    Ok(conn)
}

fn table_has_column(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = stmt.query_map([], |row| row.get::<_, String>(1))?;
    let has_column = columns
        .filter_map(|column| column.ok())
        .any(|name| name == column);
    Ok(has_column)
}

fn migrate_workspace_activity(conn: &Connection) -> Result<()> {
    if table_has_column(conn, "workspace_activity", "evidence")? {
        conn.execute_batch(
            "UPDATE workspace_activity SET evidence = 'filesystem' WHERE evidence = 'both';
             DELETE FROM workspace_activity WHERE evidence = 'session_log';
             ALTER TABLE workspace_activity DROP COLUMN evidence;",
        )?;
    }
    if table_has_column(conn, "workspace_activity", "session_key")? {
        conn.execute("UPDATE workspace_activity SET session_key = NULL", [])?;
        conn.execute_batch("ALTER TABLE workspace_activity DROP COLUMN session_key")?;
    }
    if table_has_column(conn, "workspace_activity", "source_event_key")? {
        conn.execute_batch(
            "DROP INDEX IF EXISTS idx_workspace_activity_source_event;
             ALTER TABLE workspace_activity DROP COLUMN source_event_key;",
        )?;
    }
    Ok(())
}

fn row_to_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkspaceChangeEvent> {
    let kind: String = row.get(3)?;
    let kind = match kind.as_str() {
        "created" => WorkspaceChangeKind::Created,
        "modified" => WorkspaceChangeKind::Modified,
        "deleted" => WorkspaceChangeKind::Deleted,
        other => {
            return Err(rusqlite::Error::InvalidColumnType(
                3,
                other.into(),
                rusqlite::types::Type::Text,
            ))
        }
    };
    Ok(WorkspaceChangeEvent {
        id: row.get(0)?,
        project_path: row.get(1)?,
        file_path: row.get(2)?,
        kind,
        observed_at: row.get(4)?,
        before_hash: row.get(5)?,
        after_hash: row.get(6)?,
    })
}

fn row_to_session_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionFileChangeEvent> {
    let kind: String = row.get(4)?;
    let kind = WorkspaceChangeKind::parse(&kind)
        .map_err(|_| rusqlite::Error::InvalidColumnType(4, kind, rusqlite::types::Type::Text))?;
    Ok(SessionFileChangeEvent {
        id: row.get(0)?,
        session_key: row.get(1)?,
        project_path: row.get(2)?,
        file_path: row.get(3)?,
        kind,
        observed_at: row.get(5)?,
        after_hash: row.get(6)?,
        source_event_key: row.get(7)?,
    })
}

fn insert_activity(
    tx: &rusqlite::Transaction<'_>,
    project_path: &str,
    file_path: &str,
    kind: WorkspaceChangeKind,
    observed_at: i64,
    before_hash: Option<&str>,
    after_hash: Option<&str>,
) -> Result<WorkspaceChangeEvent> {
    tx.execute(
        "INSERT INTO workspace_activity
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
    Ok(WorkspaceChangeEvent {
        id: tx.last_insert_rowid(),
        project_path: project_path.to_string(),
        file_path: file_path.to_string(),
        kind,
        observed_at,
        before_hash: before_hash.map(str::to_string),
        after_hash: after_hash.map(str::to_string),
    })
}

pub fn default_workspace_db_path() -> PathBuf {
    workspace_db_path_for(&crate::db::default_db_path())
}

pub fn workspace_db_path_for(index_path: &Path) -> PathBuf {
    index_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("workspace.db")
}

pub fn default_workspace_cas_path() -> PathBuf {
    workspace_cas_path_for(&crate::db::default_db_path())
}

pub fn workspace_cas_path_for(index_path: &Path) -> PathBuf {
    index_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("workspace-cas")
}
