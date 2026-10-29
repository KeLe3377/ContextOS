use crate::adapters::AgentAdapter;
use crate::db::Store;
use crate::models::*;
use crate::scanner::{refresh_parent_links, scan_files, ScanEvents};
use crate::workspace_changes::{WorkspaceFileObservation, WorkspaceObservationMode};
use notify::{RecursiveMode, Watcher};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Arc;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const WORKSPACE_MAX_FILE_SIZE: u64 = 16 * 1024 * 1024;
const WORKSPACE_MAX_BASELINE_FILES: usize = 100_000;
const WORKSPACE_BASELINE_BATCH_SIZE: usize = 64;
const WORKSPACE_ROOT_REFRESH: Duration = Duration::from_secs(2);
const WORKSPACE_WATCH_RETRY: Duration = Duration::from_secs(2);

type WorkspaceEvent = (PathBuf, notify::Result<notify::Event>);

/// Monitors explicitly configured workspace roots independently from agent
/// transcript roots.
pub struct WorkspaceWatcher {
    stop: Option<mpsc::Sender<()>>,
    refresh: Option<mpsc::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for WorkspaceWatcher {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        self.refresh.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

pub fn start_workspace_watcher(
    store: Arc<Store>,
    on_change: Arc<dyn Fn() + Send + Sync>,
) -> Option<WorkspaceWatcher> {
    let (events_tx, events_rx) = mpsc::channel::<WorkspaceEvent>();
    let (refresh_tx, refresh_rx) = mpsc::channel();
    workspace_watcher_log("workspace watcher started");
    let (stop_tx, stop_rx) = mpsc::channel();
    let thread = std::thread::spawn(move || {
        run_workspace_watcher(store, events_tx, events_rx, refresh_rx, stop_rx, on_change);
    });
    Some(WorkspaceWatcher {
        stop: Some(stop_tx),
        refresh: Some(refresh_tx),
        thread: Some(thread),
    })
}

impl WorkspaceWatcher {
    /// Reconcile explicit roots immediately instead of waiting for the poll.
    pub fn request_refresh(&self) {
        if let Some(refresh) = &self.refresh {
            let _ = refresh.send(());
        }
    }
}

fn run_workspace_watcher(
    store: Arc<Store>,
    events_tx: mpsc::Sender<WorkspaceEvent>,
    events: mpsc::Receiver<WorkspaceEvent>,
    refresh: mpsc::Receiver<()>,
    stop: mpsc::Receiver<()>,
    on_change: Arc<dyn Fn() + Send + Sync>,
) {
    let mut roots = HashMap::<PathBuf, String>::new();
    let mut watchers = HashMap::<PathBuf, notify::RecommendedWatcher>::new();
    if sync_workspace_roots(&store, &events_tx, &mut watchers, &mut roots) {
        on_change();
    }
    let mut refresh_at = std::time::Instant::now() + WORKSPACE_ROOT_REFRESH;

    loop {
        if stop.try_recv().is_ok() {
            break;
        }
        let wait = refresh_at
            .saturating_duration_since(std::time::Instant::now())
            .min(Duration::from_millis(500));
        match events.recv_timeout(wait) {
            Ok((event_root, Ok(event))) => {
                // A fixed debounce window can collapse create+delete of a
                // short-lived file before any state exists. Process events as
                // they arrive; hash comparison suppresses duplicate writes.
                let changed = roots.get(&event_root).is_some_and(|project_path| {
                    observe_workspace_event(&store, &event_root, project_path, event)
                });
                if changed {
                    on_change();
                }
            }
            Ok((root, Err(error))) => {
                workspace_watcher_log(format!(
                    "watch error root={}: {error}; rescanning and restarting",
                    root.display()
                ));
                let changed = roots
                    .get(&root)
                    .is_some_and(|project_path| rescan_workspace_root(&store, &root, project_path));
                watchers.remove(&root);
                if roots.contains_key(&root) {
                    if let Some(watcher) = create_workspace_root_watcher(&root, &events_tx) {
                        watchers.insert(root.clone(), watcher);
                        workspace_watcher_log(format!("watch restarted root={}", root.display()));
                    }
                }
                if changed {
                    on_change();
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if refresh.try_recv().is_ok() {
            if sync_workspace_roots(&store, &events_tx, &mut watchers, &mut roots) {
                on_change();
            }
            refresh_at = std::time::Instant::now() + WORKSPACE_ROOT_REFRESH;
        }
        if std::time::Instant::now() >= refresh_at {
            if sync_workspace_roots(&store, &events_tx, &mut watchers, &mut roots) {
                on_change();
            }
            refresh_at = std::time::Instant::now() + WORKSPACE_ROOT_REFRESH;
        }
    }
}

fn sync_workspace_roots(
    store: &Store,
    events_tx: &mpsc::Sender<WorkspaceEvent>,
    watchers: &mut HashMap<PathBuf, notify::RecommendedWatcher>,
    roots: &mut HashMap<PathBuf, String>,
) -> bool {
    let configured = match store.list_workspace_roots_for_watcher() {
        Ok(roots) => roots,
        Err(error) => {
            eprintln!("workspace watcher: could not list monitored roots: {error:#}");
            return false;
        }
    };
    let wanted = configured
        .into_iter()
        .filter_map(|root| {
            let path = std::fs::canonicalize(&root.0.path).ok()?;
            path.is_dir().then_some((path, root))
        })
        .collect::<HashMap<_, _>>();

    let removed = roots
        .keys()
        .filter(|root| !wanted.contains_key(*root) || !root.is_dir())
        .cloned()
        .collect::<Vec<_>>();
    for root in removed {
        watchers.remove(&root);
        roots.remove(&root);
    }

    let mut changed = false;
    for (root, (workspace_root, imported)) in wanted {
        let project_path = workspace_root.path.clone();
        if !root.is_dir() {
            continue;
        }
        if watchers.contains_key(&root) {
            roots.insert(root, project_path);
            continue;
        }
        let Some(watcher) = create_workspace_root_watcher(&root, events_tx) else {
            continue;
        };
        watchers.insert(root.clone(), watcher);
        let is_new_root = !roots.contains_key(&root);
        roots.insert(root.clone(), project_path.clone());
        workspace_watcher_log(format!("watching root {}", root.display()));
        if is_new_root {
            changed |= import_workspace_root(store, &root, &project_path);
            if let Err(error) = store.mark_workspace_root_imported(&project_path) {
                eprintln!(
                    "workspace watcher: could not mark {} imported: {error:#}",
                    project_path
                );
            }
        } else if !imported {
            changed |= import_workspace_root(store, &root, &project_path);
            if let Err(error) = store.mark_workspace_root_imported(&project_path) {
                eprintln!(
                    "workspace watcher: could not mark {} imported: {error:#}",
                    project_path
                );
            }
        }
    }
    changed
}

fn create_workspace_root_watcher(
    root: &Path,
    events_tx: &mpsc::Sender<WorkspaceEvent>,
) -> Option<notify::RecommendedWatcher> {
    let event_root = root.to_path_buf();
    let sender = events_tx.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if let Ok(event) = &event {
            for path in &event.paths {
                if is_workspace_monitor_probe(path) {
                    workspace_watcher_log(format!(
                        "notify received probe event: kind={:?}, path={}, root={}",
                        event.kind,
                        path.display(),
                        event_root.display()
                    ));
                }
            }
        }
        let _ = sender.send((event_root.clone(), event));
    })
    .map_err(|error| {
        workspace_watcher_log(format!(
            "failed to create watcher root={}: {error}",
            root.display()
        ));
        error
    })
    .ok()?;
    if let Err(error) = watcher.watch(root, RecursiveMode::Recursive) {
        workspace_watcher_log(format!(
            "failed to watch root={}: {error}; retrying in {}ms",
            root.display(),
            WORKSPACE_WATCH_RETRY.as_millis()
        ));
        return None;
    }
    Some(watcher)
}

fn import_workspace_root(store: &Store, root: &Path, project_path: &str) -> bool {
    capture_workspace_tree(
        store,
        root,
        project_path,
        root,
        WorkspaceObservationMode::Import,
    )
}

fn capture_workspace_tree(
    store: &Store,
    root: &Path,
    project_path: &str,
    start: &Path,
    mode: WorkspaceObservationMode,
) -> bool {
    let mut pending = vec![start.to_path_buf()];
    let mut count = 0usize;
    let mut changed = false;
    let mut batch = Vec::with_capacity(WORKSPACE_BASELINE_BATCH_SIZE);
    while let Some(directory) = pending.pop() {
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if ignored_workspace_path(&path) {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                pending.push(path);
                continue;
            }
            if !kind.is_file() {
                continue;
            }
            count += 1;
            if count > WORKSPACE_MAX_BASELINE_FILES {
                eprintln!(
                    "workspace watcher: baseline limit reached for {}",
                    root.display()
                );
                changed |= persist_workspace_batch(store, project_path, &mut batch, mode);
                return changed;
            }
            if let Some((relative, observation)) = workspace_file_observation(root, &path, true) {
                batch.push((relative, observation));
            }
            if batch.len() == WORKSPACE_BASELINE_BATCH_SIZE {
                changed |= persist_workspace_batch(store, project_path, &mut batch, mode);
            }
        }
    }
    changed |= persist_workspace_batch(store, project_path, &mut batch, mode);
    changed
}

fn persist_workspace_batch(
    store: &Store,
    project_path: &str,
    batch: &mut Vec<(String, WorkspaceFileObservation)>,
    mode: WorkspaceObservationMode,
) -> bool {
    if batch.is_empty() {
        return false;
    }
    match store.observe_workspace_files(
        project_path,
        std::mem::take(batch),
        mode,
        crate::db::now_ms(),
    ) {
        Ok(events) => !events.is_empty(),
        Err(error) => {
            eprintln!("workspace watcher: could not record baseline batch: {error:#}");
            false
        }
    }
}

fn observe_workspace_event(
    store: &Store,
    root: &Path,
    project_path: &str,
    event: notify::Event,
) -> bool {
    if event.need_rescan() {
        return rescan_workspace_root(store, root, project_path);
    }

    let observed_at = crate::db::now_ms();
    let mut changed = false;
    for path in event.paths {
        let is_probe = is_workspace_monitor_probe(&path);
        if is_probe {
            workspace_watcher_log(format!(
                "processing probe event: kind={:?}, path={}, roots={}",
                event.kind,
                path.display(),
                1
            ));
        }
        if ignored_workspace_path(&path) {
            if is_probe {
                workspace_watcher_log("probe ignored by path filter");
            }
            continue;
        }
        let Some(relative) = relative_workspace_path(root, &path) else {
            if is_probe {
                workspace_watcher_log(format!(
                    "probe path did not match watcher root: path={} root={}",
                    path.display(),
                    root.display()
                ));
            }
            continue;
        };
        let relative = relative.to_string_lossy().replace('\\', "/");
        if is_probe {
            workspace_watcher_log(format!(
                "probe matched project={} root={} relative={relative}",
                project_path,
                root.display()
            ));
        }
        if relative.is_empty() {
            continue;
        }
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_dir() => {
                changed |= capture_workspace_tree(
                    store,
                    root,
                    project_path,
                    &path,
                    WorkspaceObservationMode::Live,
                );
            }
            Ok(metadata) if metadata.file_type().is_file() => {
                let observed = observe_workspace_file(
                    store,
                    root,
                    project_path,
                    &path,
                    WorkspaceObservationMode::Live,
                );
                if is_probe {
                    workspace_watcher_log(format!("probe observation persisted_change={observed}"));
                }
                changed |= observed;
            }
            Ok(_) => changed |= delete_workspace_path(store, project_path, &relative, observed_at),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                changed |= delete_workspace_path(store, project_path, &relative, observed_at);
            }
            Err(error) => eprintln!(
                "workspace watcher: could not inspect {}: {error}",
                path.display()
            ),
        }
    }
    changed
}

fn relative_workspace_path(root: &Path, path: &Path) -> Option<PathBuf> {
    if let Ok(relative) = path.strip_prefix(root) {
        return Some(relative.to_path_buf());
    }
    #[cfg(windows)]
    {
        let root = root.components().collect::<Vec<_>>();
        let path = path.components().collect::<Vec<_>>();
        if path.len() < root.len()
            || !root.iter().zip(&path).all(|(left, right)| {
                left.as_os_str()
                    .to_string_lossy()
                    .eq_ignore_ascii_case(&right.as_os_str().to_string_lossy())
            })
        {
            return None;
        }
        let relative = path[root.len()..]
            .iter()
            .fold(PathBuf::new(), |mut relative, component| {
                relative.push(component.as_os_str());
                relative
            });
        return Some(relative);
    }
    #[cfg(not(windows))]
    None
}

fn rescan_workspace_root(store: &Store, root: &Path, project_path: &str) -> bool {
    let mut changed = capture_workspace_tree(
        store,
        root,
        project_path,
        root,
        WorkspaceObservationMode::Live,
    );
    let paths = match store.list_workspace_file_paths(project_path) {
        Ok(paths) => paths,
        Err(error) => {
            eprintln!("workspace watcher: could not list indexed paths: {error:#}");
            return changed;
        }
    };
    let missing = paths
        .into_iter()
        .filter(|relative| match fs::symlink_metadata(root.join(relative)) {
            Ok(metadata) => !metadata.file_type().is_file(),
            Err(error) => error.kind() == std::io::ErrorKind::NotFound,
        })
        .collect::<Vec<_>>();
    if missing.is_empty() {
        return changed;
    }
    match store.delete_workspace_files(project_path, &missing, crate::db::now_ms()) {
        Ok(events) => changed |= !events.is_empty(),
        Err(error) => eprintln!("workspace watcher: could not reconcile removed files: {error:#}"),
    }
    changed
}

fn delete_workspace_path(
    store: &Store,
    project_path: &str,
    relative: &str,
    observed_at: i64,
) -> bool {
    match store.delete_workspace_path(project_path, relative, observed_at) {
        Ok(events) => !events.is_empty(),
        Err(error) => {
            eprintln!("workspace watcher: could not record deletion: {error:#}");
            false
        }
    }
}

fn observe_workspace_file(
    store: &Store,
    root: &Path,
    project_path: &str,
    path: &Path,
    mode: WorkspaceObservationMode,
) -> bool {
    let Some((relative, observation)) = workspace_file_observation(root, path, true) else {
        if is_workspace_monitor_probe(path) {
            workspace_watcher_log(format!(
                "probe observation unavailable: path={} exists={} size={:?}",
                path.display(),
                path.exists(),
                fs::metadata(path).ok().map(|metadata| metadata.len())
            ));
        }
        return false;
    };
    match store.observe_workspace_file(
        project_path,
        &relative,
        observation,
        mode,
        crate::db::now_ms(),
    ) {
        Ok(event) => {
            if is_workspace_monitor_probe(path) {
                workspace_watcher_log(format!(
                    "probe database result: event_created={}",
                    event.is_some()
                ));
            }
            event.is_some()
        }
        Err(error) => {
            eprintln!(
                "workspace watcher: could not record {}: {error:#}",
                path.display()
            );
            if is_workspace_monitor_probe(path) {
                workspace_watcher_log(format!("probe database write failed: {error:#}"));
            }
            false
        }
    }
}

fn workspace_file_observation(
    root: &Path,
    path: &Path,
    capture_text: bool,
) -> Option<(String, WorkspaceFileObservation)> {
    if ignored_workspace_path(path) {
        return None;
    }
    let Ok(metadata) = fs::metadata(path) else {
        return None;
    };
    if !metadata.is_file() || metadata.len() > WORKSPACE_MAX_FILE_SIZE {
        return None;
    }
    let Ok(bytes) = fs::read(path) else {
        return None;
    };
    let relative = relative_workspace_path(root, path)?;
    let relative = relative.to_string_lossy().replace('\\', "/");
    let file_mtime = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or_default();
    Some((
        relative,
        WorkspaceFileObservation::Present {
            bytes,
            file_mtime,
            capture_text: capture_text && !sensitive_workspace_file(path),
        },
    ))
}

fn is_workspace_monitor_probe(path: &Path) -> bool {
    path.file_name()
        .is_some_and(|name| name.eq_ignore_ascii_case("workspace-monitor-check.md"))
}

fn workspace_watcher_log(message: impl AsRef<str>) {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let _guard = LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let path = crate::db::default_db_path()
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("workspace-watcher.log");
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let _ = writeln!(file, "{} {}", crate::db::now_ms(), message.as_ref());
}

fn sensitive_workspace_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return true;
    };
    let name = name.to_ascii_lowercase();
    name == ".env"
        || name.starts_with(".env.")
        || matches!(
            name.as_str(),
            ".npmrc"
                | ".pypirc"
                | "credentials.json"
                | "secrets.json"
                | "id_rsa"
                | "id_ed25519"
                | "id_ecdsa"
        )
        || name.ends_with(".pem")
        || name.ends_with(".key")
        || name.ends_with(".p12")
        || name.ends_with(".pfx")
        || name.ends_with(".secret")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_changes::WorkspaceChangeKind;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    #[ignore = "workspace history moved to WorkspaceStore; covered by workspace_supervisor tests"]
    fn explicit_root_imports_existing_files_and_records_live_create_delete() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        fs::create_dir_all(&root).unwrap();
        let store = Store::open(&temp.path().join("contextos.db")).unwrap();
        let root = store.add_workspace_root(&root).unwrap();
        let root_path = PathBuf::from(&root.path);

        let existing = root_path.join("existing.txt");
        fs::write(&existing, "baseline").unwrap();
        assert!(import_workspace_root(&store, &root_path, &root.path));
        let imported = store
            .list_workspace_change_events(&root.path, None, None, None, 100)
            .unwrap();
        assert_eq!(imported.len(), 1);
        assert_eq!(imported[0].kind, WorkspaceChangeKind::Created);
        assert_eq!(imported[0].file_path, "existing.txt");

        let created = root_path.join("created.txt");
        fs::write(&created, "hello").unwrap();
        assert!(observe_workspace_file(
            &store,
            &root_path,
            &root.path,
            &created,
            WorkspaceObservationMode::Live,
        ));
        fs::remove_file(&created).unwrap();
        assert!(delete_workspace_path(
            &store,
            &root.path,
            "created.txt",
            crate::db::now_ms(),
        ));

        let events = store
            .list_workspace_change_events(&root.path, None, None, None, 100)
            .unwrap();
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].kind, WorkspaceChangeKind::Deleted);
        assert_eq!(events[1].kind, WorkspaceChangeKind::Created);
        assert_eq!(events[0].file_path, "created.txt");
        assert_eq!(events[1].file_path, "created.txt");
    }

    #[test]
    #[ignore = "workspace history moved to WorkspaceStore; covered by workspace_supervisor tests"]
    fn supervisor_observes_filesystem_events_for_an_explicit_root() {
        let temp = tempfile::tempdir().unwrap();
        let root_path = temp.path().join("project");
        fs::create_dir_all(&root_path).unwrap();
        let store = Arc::new(Store::open(&temp.path().join("contextos.db")).unwrap());
        let root = store.add_workspace_root(&root_path).unwrap();
        let notifications = Arc::new(AtomicUsize::new(0));
        let seen = notifications.clone();
        let watcher = start_workspace_watcher(
            store.clone(),
            Arc::new(move || {
                seen.fetch_add(1, Ordering::Relaxed);
            }),
        )
        .unwrap();

        std::thread::sleep(Duration::from_millis(300));
        fs::write(root_path.join("live.txt"), "live").unwrap();
        for _ in 0..30 {
            if !store
                .list_workspace_change_events(&root.path, None, None, None, 100)
                .unwrap()
                .is_empty()
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }

        let events = store
            .list_workspace_change_events(&root.path, None, None, None, 100)
            .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, WorkspaceChangeKind::Created);
        assert!(notifications.load(Ordering::Relaxed) >= 1);
        drop(watcher);
    }
}

fn ignored_workspace_path(path: &Path) -> bool {
    path.components().any(|component| {
        let name = component.as_os_str().to_string_lossy();
        matches!(
            name.as_ref(),
            ".git"
                | ".codegraph"
                | "node_modules"
                | "target"
                | "dist"
                | "build"
                | "coverage"
                | ".next"
                | ".turbo"
                | ".cache"
                | ".venv"
                | "venv"
        )
    })
}

/// 监听 adapter 数据目录,800ms 去抖后做单文件增量。
/// drop 即停:先撤事件源(通道关闭、线程退出循环),再 **join 等线程真正
/// 退出**——roster 换代时旧线程可能正持旧 roster/Store 在写库,不等它收尾,
/// 已移除根的会话会在新 roster 补扫之后被写回、复活到下次手动刷新
/// (2026-08-24 Codex review P1)。在批处理粒度上等待,通常毫秒级
pub struct SessionWatcher {
    watcher: Option<notify::RecommendedWatcher>,
    thread: Option<std::thread::JoinHandle<()>>,
    watched: std::collections::BTreeSet<PathBuf>,
}

impl SessionWatcher {
    /// 实际 watch 成功的根(缺目录等失败被静默跳过的不在内)——"挂了哪些"
    /// 的唯一真话。远程同步收工后据此判断缓存树是否长出了监听外的新根。
    pub fn watched_roots(&self) -> &std::collections::BTreeSet<PathBuf> {
        &self.watched
    }
}

impl Drop for SessionWatcher {
    fn drop(&mut self) {
        self.watcher.take();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// 事件路径 → 归属 agent:取**最长匹配根**,不是第一个命中。env 自定义根
/// (CODEX_HOME/XDG_DATA_HOME)可以落在别家数据树内,此时事件路径同时匹配
/// 两个根,按 roster 顺序取首个会把事件分给外层那家——file_ref 又对 .jsonl
/// 很宽松,会以错误的 agent 入库(错 key + 同 file_path 还会触发 UNIQUE 冲突)。
/// 更深的根必然是更具体的归属;Path::starts_with 按组件比较,同名前缀兄弟
/// 目录不会误匹配
pub fn resolve_watch_agent<T: Copy>(roots: &[(PathBuf, T)], path: &Path) -> Option<T> {
    roots
        .iter()
        .filter(|(root, _)| path.starts_with(root))
        .max_by_key(|(root, _)| root.components().count())
        .map(|(_, tag)| *tag)
}

/// 胜者副本被删后的幸存者上位:按被删 key 反查同家实例枚举里的同 native_id
/// 引用,交常规增量收编(该 key 已无既有行,scan_files 的副本裁决自然放行)。
/// 期望 key 经 session_key 按实例 host 构造——远程三段 key 也走名字快路径。
/// codex 经 state DB 改写过的 key(thread-id ≠ 文件 native_id)反查不到,由
/// 下一次全量扫描兜底;删除事件罕见,逐家枚举(纯 stat)代价可忽略
pub fn promote_survivors(
    adapters: &[Box<dyn AgentAdapter>],
    store: &Arc<Store>,
    events: &dyn ScanEvents,
    removed_keys: &[String],
) {
    let mut seen = std::collections::HashSet::new();
    let mut survivors: Vec<SessionFileRef> = Vec::new();
    for key in removed_keys {
        if !seen.insert(key.as_str()) {
            continue;
        }
        let Some(agent) = key.split(':').next().and_then(AgentId::from_str) else {
            continue;
        };
        let mut agent_refs: Vec<SessionFileRef> = Vec::new();
        let mut by_name: Vec<SessionFileRef> = Vec::new();
        for a in adapters.iter().filter(|a| a.agent() == agent) {
            // host 段对不上的实例整个跳过(本地实例对远程 key、A 机对 B 机):
            // 名字与解析比对都不可能命中——实例出口的 key 恒带自己的 host
            let Some(native_id) = strip_key_prefix(key, agent, a.host()) else {
                continue;
            };
            if let Ok(refs) = a.list_session_files() {
                by_name.extend(refs.iter().filter(|r| r.native_id == native_id).cloned());
                agent_refs.extend(refs);
            }
        }
        if !by_name.is_empty() {
            survivors.extend(by_name);
            continue;
        }
        // key 后缀是**内容 id** 的家(gemini 的 sessionId、pi/dsh 的首行 id)
        // 文件名对不上——退而解析比对,规模封顶防重罚(超限交下次全量扫描)
        if agent_refs.len() <= 32 {
            for r in agent_refs {
                let Some(owner) = crate::adapters::adapter_for(adapters, r.agent, &r.file_path)
                else {
                    continue;
                };
                if owner
                    .parse_session(&r)
                    .is_ok_and(|p| p.meta.key.as_str() == key.as_str())
                {
                    survivors.push(r);
                    break;
                }
            }
        }
    }
    if !survivors.is_empty() {
        scan_files(adapters, store, events, survivors);
    }
}

pub fn start_watcher(
    adapters: Arc<Vec<Box<dyn AgentAdapter>>>,
    store: Arc<Store>,
    events: Arc<dyn ScanEvents>,
) -> Option<SessionWatcher> {
    // 根携带实例下标而非 AgentId:同 agent 多实例(自定义 location)时,
    // file_ref 也必须由拥有该根的实例执行——dsh 的 file_ref 要读文件首行,
    // 实例相对的判据按 agent 找第一个会拿默认实例跑偏
    let mut roots: Vec<(PathBuf, usize)> = Vec::new();
    for (ix, a) in adapters.iter().enumerate() {
        for p in a.watch_paths() {
            roots.push((p, ix));
        }
    }
    if roots.is_empty() {
        return None;
    }

    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(tx).ok()?;
    let mut watched = std::collections::BTreeSet::new();
    for (root, _) in &roots {
        // 失败(常见:目录还不存在,如未同步的远程缓存)跳过不算挂上
        if watcher.watch(root, RecursiveMode::Recursive).is_ok() {
            watched.insert(root.clone());
        }
    }

    let thread = std::thread::spawn(move || {
        let resolve_ix = |path: &Path| resolve_watch_agent(&roots, path);

        let mut pending: HashMap<PathBuf, usize> = HashMap::new();
        let mut removed: Vec<PathBuf> = Vec::new();
        loop {
            // 等首个事件(阻塞),然后 800ms 窗口收敛
            let first = match rx.recv() {
                Ok(e) => e,
                Err(_) => break, // watcher dropped
            };
            let mut batch = vec![first];
            let deadline = std::time::Instant::now() + Duration::from_millis(800);
            while let Ok(ev) =
                rx.recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
            {
                batch.push(ev);
                if std::time::Instant::now() >= deadline {
                    break;
                }
            }

            let mut parent_link_agents = HashSet::new();
            let mut rescan = false;
            for ev in batch {
                let Ok(ev) = ev.inspect_err(|e| eprintln!("watcher: notify error: {e}")) else {
                    continue;
                };
                // 后端丢过事件(FSEvents MustScanSubDirs / inotify Q_OVERFLOW):
                // 这条不指向具体会话文件——macOS 挂的是出事的目录、Linux 干脆
                // 无路径——按路径处理会被 file_ref 静默丢弃,改由整轮增量兜底
                if ev.need_rescan() {
                    rescan = true;
                    continue;
                }
                for path in ev.paths {
                    let owner_ix = resolve_ix(&path);
                    if let Some(adapter) = owner_ix.and_then(|ix| adapters.get(ix)) {
                        if adapter.is_parent_link_event(&path) {
                            parent_link_agents.insert(adapter.agent());
                        }
                    }
                    if matches!(ev.kind, notify::EventKind::Remove(_)) {
                        pending.remove(&path);
                        removed.push(path.clone());
                    } else if let Some(ix) = owner_ix {
                        pending.insert(path.clone(), ix);
                    }
                }
            }

            let mut removed_keys: Vec<String> = Vec::new();
            for path in removed.drain(..) {
                if let Ok(Some(key)) = store.remove_by_path(&path.to_string_lossy()) {
                    removed_keys.push(key);
                }
                events.on_sessions_changed();
            }
            promote_survivors(&adapters, &store, events.as_ref(), &removed_keys);

            // 路径是否本 agent 的会话文件、native_id 怎么取,统一问**拥有
            // 该根的实例**(下标即 roots 表登记的归属)
            let refs: Vec<SessionFileRef> = pending
                .drain()
                .filter_map(|(path, ix)| adapters.get(ix).and_then(|a| a.file_ref(&path)))
                .collect();
            let scanned_agents: HashSet<AgentId> =
                refs.iter().map(|reference| reference.agent).collect();
            if !refs.is_empty() {
                scan_files(&adapters, &store, events.as_ref(), refs);
            }
            parent_link_agents.retain(|agent| !scanned_agents.contains(agent));
            if !parent_link_agents.is_empty() {
                let agents: Vec<AgentId> = parent_link_agents.into_iter().collect();
                refresh_parent_links(&adapters, &store, events.as_ref(), &agents);
            }
            if rescan {
                events.on_rescan_needed();
            }
        }
    });

    Some(SessionWatcher {
        watcher: Some(watcher),
        thread: Some(thread),
        watched,
    })
}
