//! ZFileTimeMachine-style supervision for explicitly monitored folders.
//!
//! Each root owns its watcher, stop flag, retry loop and reconciliation scan.
//! The manager only reconciles the manually configured root list and never
//! consults the session roster.

use crate::workspace_changes::{WorkspaceFileObservation, WorkspaceObservationMode};
use crate::workspace_store::WorkspaceStore;
use notify::{RecursiveMode, Watcher};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, UNIX_EPOCH};

const ROOT_REFRESH: Duration = Duration::from_secs(1);
const EVENT_DEBOUNCE: Duration = Duration::from_millis(350);
const RESCAN_INTERVAL: Duration = Duration::from_secs(30);
const MAX_FILE_SIZE: u64 = 16 * 1024 * 1024;
const MAX_FILES_PER_SCAN: usize = 100_000;
const BATCH_SIZE: usize = 64;

type RootEvent = notify::Result<notify::Event>;

pub struct WorkspaceWatcher {
    stop: Option<mpsc::Sender<()>>,
    refresh: Option<mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl WorkspaceWatcher {
    pub fn request_refresh(&self) {
        if let Some(refresh) = &self.refresh {
            let _ = refresh.send(());
        }
    }
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

struct RootWorker {
    stop: Arc<AtomicBool>,
    thread: JoinHandle<()>,
    imported: bool,
}

impl RootWorker {
    fn stop(self) {
        self.stop.store(true, Ordering::Release);
        let _ = self.thread.join();
    }
}

pub fn start_workspace_watcher(
    store: Arc<WorkspaceStore>,
    on_change: Arc<dyn Fn() + Send + Sync>,
) -> Option<WorkspaceWatcher> {
    let (stop_tx, stop_rx) = mpsc::channel();
    let (refresh_tx, refresh_rx) = mpsc::channel();
    let thread = std::thread::Builder::new()
        .name("workspace-supervisor".into())
        .spawn(move || run_supervisor(store, stop_rx, refresh_rx, on_change))
        .ok()?;
    Some(WorkspaceWatcher {
        stop: Some(stop_tx),
        refresh: Some(refresh_tx),
        thread: Some(thread),
    })
}

fn run_supervisor(
    store: Arc<WorkspaceStore>,
    stop: mpsc::Receiver<()>,
    refresh: mpsc::Receiver<()>,
    on_change: Arc<dyn Fn() + Send + Sync>,
) {
    let mut workers: HashMap<PathBuf, RootWorker> = HashMap::new();
    let mut next_refresh = Instant::now();
    loop {
        let wait = next_refresh
            .saturating_duration_since(Instant::now())
            .min(Duration::from_millis(500));
        match stop.recv_timeout(wait) {
            Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if refresh.try_recv().is_ok() || Instant::now() >= next_refresh {
            if reconcile_roots(&store, &mut workers, &on_change) {
                on_change();
            }
            next_refresh = Instant::now() + ROOT_REFRESH;
        }
    }
    for (_, worker) in workers.drain() {
        worker.stop();
    }
}

fn reconcile_roots(
    store: &Arc<WorkspaceStore>,
    workers: &mut HashMap<PathBuf, RootWorker>,
    on_change: &Arc<dyn Fn() + Send + Sync>,
) -> bool {
    let configured = match store.list_workspace_roots_for_watcher() {
        Ok(value) => value,
        Err(error) => {
            eprintln!("workspace supervisor: could not list roots: {error:#}");
            return false;
        }
    };
    let wanted: HashMap<PathBuf, (String, bool)> = configured
        .into_iter()
        .filter_map(|(root, imported)| {
            let path = fs::canonicalize(&root.path).ok()?;
            path.is_dir().then_some((path, (root.path, imported)))
        })
        .collect();

    let removed: Vec<PathBuf> = workers
        .keys()
        .filter(|path| !wanted.contains_key(*path))
        .cloned()
        .collect();
    for path in removed {
        if let Some(worker) = workers.remove(&path) {
            worker.stop();
        }
    }

    let mut changed = false;
    for (root, (project_path, imported)) in wanted {
        let restart = workers
            .get(&root)
            .is_some_and(|worker| worker.imported != imported || worker.thread.is_finished());
        if restart {
            if let Some(worker) = workers.remove(&root) {
                worker.stop();
            }
        }
        if workers.contains_key(&root) {
            continue;
        }
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = stop.clone();
        let worker_store = store.clone();
        let worker_callback = on_change.clone();
        let worker_root = root.clone();
        let worker_project = project_path.clone();
        let thread = match std::thread::Builder::new()
            .name(format!(
                "workspace-root-{}",
                root.file_name().unwrap_or_default().to_string_lossy()
            ))
            .spawn(move || {
                run_root(
                    worker_store,
                    worker_root,
                    worker_project,
                    imported,
                    worker_stop,
                    worker_callback,
                )
            }) {
            Ok(thread) => thread,
            Err(error) => {
                eprintln!(
                    "workspace supervisor: could not start {}: {error}",
                    root.display()
                );
                continue;
            }
        };
        // A successful worker marks the root imported before the next manager
        // pass. Keeping the desired flag here avoids an immediate restart loop.
        workers.insert(
            root,
            RootWorker {
                stop,
                thread,
                imported: true,
            },
        );
        changed = true;
    }
    changed
}

fn run_root(
    store: Arc<WorkspaceStore>,
    root: PathBuf,
    project_path: String,
    imported: bool,
    stop: Arc<AtomicBool>,
    on_change: Arc<dyn Fn() + Send + Sync>,
) {
    let (events_tx, events_rx) = mpsc::channel::<RootEvent>();
    let callback = move |event: RootEvent| {
        let _ = events_tx.send(event);
    };
    let mut watcher = match notify::recommended_watcher(callback) {
        Ok(watcher) => watcher,
        Err(error) => {
            eprintln!(
                "workspace watcher: could not initialize {}: {error}",
                root.display()
            );
            return;
        }
    };
    if let Err(error) = watcher.watch(&root, RecursiveMode::Recursive) {
        eprintln!(
            "workspace watcher: could not watch {}: {error}",
            root.display()
        );
        return;
    }

    let mut changed = false;
    if !imported {
        changed |= scan_tree(
            &store,
            &root,
            &project_path,
            WorkspaceObservationMode::Import,
        );
        let _ = store.mark_workspace_root_imported(&project_path);
    }
    if changed {
        on_change();
    }

    let mut next_rescan = Instant::now() + RESCAN_INTERVAL;
    while !stop.load(Ordering::Acquire) {
        let timeout = next_rescan
            .saturating_duration_since(Instant::now())
            .min(Duration::from_millis(250));
        match events_rx.recv_timeout(timeout) {
            Ok(first) => {
                let mut batch = vec![first];
                let deadline = Instant::now() + EVENT_DEBOUNCE;
                while let Ok(event) =
                    events_rx.recv_timeout(deadline.saturating_duration_since(Instant::now()))
                {
                    batch.push(event);
                }
                let watcher_error = batch.iter().any(Result::is_err);
                if process_events(&store, &root, &project_path, batch) {
                    on_change();
                }
                if watcher_error {
                    // Let the manager restart this root with a fresh native
                    // watcher instead of continuing after a backend error.
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if Instant::now() >= next_rescan {
                    if reconcile_tree(&store, &root, &project_path) {
                        on_change();
                    }
                    next_rescan = Instant::now() + RESCAN_INTERVAL;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
}

fn process_events(
    store: &WorkspaceStore,
    root: &Path,
    project_path: &str,
    batch: Vec<RootEvent>,
) -> bool {
    let mut paths = HashSet::new();
    let mut rescan = false;
    for event in batch {
        match event {
            Ok(event) if event.need_rescan() => rescan = true,
            Ok(event) => paths.extend(event.paths),
            Err(error) => {
                eprintln!(
                    "workspace watcher: event error for {}: {error}",
                    root.display()
                );
                rescan = true;
            }
        }
    }
    if rescan {
        return reconcile_tree(store, root, project_path);
    }

    let mut changed = false;
    for path in paths {
        if ignored_path(&path) || path == root {
            continue;
        }
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_dir() => {
                changed |= scan_tree(store, root, project_path, WorkspaceObservationMode::Live);
            }
            Ok(metadata) if metadata.is_file() => {
                changed |= observe_path(store, root, project_path, &path);
            }
            Ok(_) => {
                changed |= delete_path(store, root, project_path, &path);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                changed |= delete_path(store, root, project_path, &path);
            }
            Err(error) => eprintln!(
                "workspace watcher: could not inspect {}: {error}",
                path.display()
            ),
        }
    }
    changed
}

fn scan_tree(
    store: &WorkspaceStore,
    root: &Path,
    project_path: &str,
    mode: WorkspaceObservationMode,
) -> bool {
    let mut pending = vec![root.to_path_buf()];
    let mut batch = Vec::with_capacity(BATCH_SIZE);
    let mut count = 0usize;
    let mut changed = false;
    while let Some(directory) = pending.pop() {
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if ignored_path(&path) {
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
            if count > MAX_FILES_PER_SCAN {
                eprintln!(
                    "workspace watcher: file limit reached for {}",
                    root.display()
                );
                break;
            }
            if let Some(observation) = file_observation(root, &path, mode) {
                batch.push(observation);
            }
            if batch.len() >= BATCH_SIZE {
                changed |= persist_batch(store, project_path, &mut batch, mode);
            }
        }
    }
    changed | persist_batch(store, project_path, &mut batch, mode)
}

fn reconcile_tree(store: &WorkspaceStore, root: &Path, project_path: &str) -> bool {
    let mut changed = scan_tree(store, root, project_path, WorkspaceObservationMode::Live);
    let Ok(indexed) = store.list_workspace_file_paths(project_path) else {
        return changed;
    };
    let missing: Vec<String> = indexed
        .into_iter()
        .filter(|relative| {
            let path = root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
            !fs::metadata(path).is_ok_and(|metadata| metadata.is_file())
        })
        .collect();
    if !missing.is_empty() {
        changed |= store
            .delete_workspace_files(project_path, &missing, crate::db::now_ms())
            .map(|events| !events.is_empty())
            .unwrap_or(false);
    }
    changed
}

fn observe_path(store: &WorkspaceStore, root: &Path, project_path: &str, path: &Path) -> bool {
    let Some((relative, observation)) =
        file_observation(root, path, WorkspaceObservationMode::Live)
    else {
        return false;
    };
    store
        .observe_workspace_files(
            project_path,
            vec![(relative, observation)],
            WorkspaceObservationMode::Live,
            crate::db::now_ms(),
        )
        .map(|events| !events.is_empty())
        .unwrap_or(false)
}

fn delete_path(store: &WorkspaceStore, root: &Path, project_path: &str, path: &Path) -> bool {
    let Some(relative) = relative_path(root, path) else {
        return false;
    };
    store
        .delete_workspace_path(project_path, &relative, crate::db::now_ms())
        .map(|events| !events.is_empty())
        .unwrap_or(false)
}

fn persist_batch(
    store: &WorkspaceStore,
    project_path: &str,
    batch: &mut Vec<(String, WorkspaceFileObservation)>,
    mode: WorkspaceObservationMode,
) -> bool {
    if batch.is_empty() {
        return false;
    }
    store
        .observe_workspace_files(
            project_path,
            std::mem::take(batch),
            mode,
            crate::db::now_ms(),
        )
        .map(|events| !events.is_empty())
        .unwrap_or(false)
}

fn file_observation(
    root: &Path,
    path: &Path,
    mode: WorkspaceObservationMode,
) -> Option<(String, WorkspaceFileObservation)> {
    if ignored_path(path) {
        return None;
    }
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_FILE_SIZE {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    let relative = relative_path(root, path)?;
    let file_mtime = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .and_then(|value| i64::try_from(value.as_millis()).ok())
        .unwrap_or_default();
    Some((
        relative,
        WorkspaceFileObservation::Present {
            bytes,
            file_mtime,
            // A first scan establishes only the comparison baseline.  Text is
            // captured after a real live change, so adding a large directory
            // does not import its existing source tree into the history CAS.
            capture_text: mode == WorkspaceObservationMode::Live && !sensitive_path(path),
        },
    ))
}

fn relative_path(root: &Path, path: &Path) -> Option<String> {
    if let Ok(relative) = path.strip_prefix(root) {
        return Some(relative.to_string_lossy().replace('\\', "/"));
    }

    // Windows notifications can spell the same path with different casing
    // from the canonical root.  The watcher is already scoped to this root,
    // so a normalized textual fallback is safe and avoids dropping the event.
    let root = root.to_string_lossy().replace('\\', "/");
    let path = path.to_string_lossy().replace('\\', "/");
    let root = root.trim_end_matches('/');
    let suffix = path.get(root.len()..)?;
    if path.len() > root.len()
        && path[..root.len()].eq_ignore_ascii_case(root)
        && suffix.starts_with('/')
    {
        return Some(suffix[1..].to_string());
    }
    None
}

fn ignored_path(path: &Path) -> bool {
    path.components().any(|component| {
        matches!(
            component.as_os_str().to_string_lossy().as_ref(),
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

fn sensitive_path(path: &Path) -> bool {
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
    use crate::workspace_store::WorkspaceStore;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn explicit_root_records_import_create_modify_delete() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("existing.txt"), "one").unwrap();
        let store = Arc::new(
            WorkspaceStore::open(&temp.path().join("workspace.db"), &temp.path().join("cas"))
                .unwrap(),
        );
        let root_row = store.add_workspace_root(&root).unwrap();
        assert!(!scan_tree(
            &store,
            &root,
            &root_row.path,
            WorkspaceObservationMode::Import
        ));
        fs::write(root.join("existing.txt"), "two").unwrap();
        assert!(observe_path(
            &store,
            &root,
            &root_row.path,
            &root.join("existing.txt")
        ));
        fs::remove_file(root.join("existing.txt")).unwrap();
        assert!(delete_path(
            &store,
            &root,
            &root_row.path,
            &root.join("existing.txt")
        ));
        let events = store
            .list_workspace_change_events(&root_row.path, None, 20)
            .unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(
            events[0].kind,
            crate::workspace_changes::WorkspaceChangeKind::Deleted
        );
        assert_eq!(
            events[1].kind,
            crate::workspace_changes::WorkspaceChangeKind::Modified
        );
    }

    #[test]
    fn supervisor_stops_and_observes_a_root() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        fs::create_dir_all(&root).unwrap();
        let store = Arc::new(
            WorkspaceStore::open(&temp.path().join("workspace.db"), &temp.path().join("cas"))
                .unwrap(),
        );
        let root_row = store.add_workspace_root(&root).unwrap();
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
        fs::write(root.join("live.txt"), "live").unwrap();
        for _ in 0..30 {
            if !store
                .list_workspace_change_events(&root_row.path, None, 20)
                .unwrap()
                .is_empty()
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(!store
            .list_workspace_change_events(&root_row.path, None, 20)
            .unwrap()
            .is_empty());
        assert!(notifications.load(Ordering::Relaxed) >= 1);
        drop(watcher);
    }
}
