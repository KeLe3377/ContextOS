use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const CONFIG_NAME: &str = "storage-location.json";

#[derive(Default, Serialize, Deserialize)]
struct StorageConfig {
    root: Option<PathBuf>,
    pending_root: Option<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct StorageStats {
    pub root: PathBuf,
    pub total_bytes: u64,
    pub index_db: PathBuf,
    pub index_bytes: u64,
    pub index_backup: PathBuf,
    pub index_backup_bytes: u64,
    pub workspace_db: PathBuf,
    pub workspace_bytes: u64,
    pub cas_dir: PathBuf,
    pub cas_bytes: u64,
    pub cas_files: u64,
    pub remotes_dir: PathBuf,
    pub remotes_bytes: u64,
}

pub fn default_root() -> PathBuf {
    #[cfg(target_os = "windows")]
    let base = dirs::data_local_dir();
    #[cfg(not(target_os = "windows"))]
    let base = dirs::data_dir();
    base.unwrap_or_else(|| PathBuf::from(".")).join("ContextOS")
}

fn config_path() -> PathBuf {
    dirs::config_dir()
        .or_else(dirs::data_dir)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("ContextOS")
        .join(CONFIG_NAME)
}

fn read_config() -> StorageConfig {
    std::fs::read(config_path())
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write_config(config: &StorageConfig) -> Result<()> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec_pretty(config)?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, bytes)?;
    if path.exists() {
        let backup = path.with_extension("json.bak");
        if backup.exists() {
            std::fs::remove_file(&backup)?;
        }
        std::fs::rename(&path, &backup)?;
        if let Err(error) = std::fs::rename(&temp, &path) {
            let _ = std::fs::rename(&backup, &path);
            return Err(error.into());
        }
        let _ = std::fs::remove_file(backup);
    } else {
        std::fs::rename(temp, path)?;
    }
    Ok(())
}

pub fn root() -> PathBuf {
    read_config().root.unwrap_or_else(default_root)
}

pub fn pending_root() -> Option<PathBuf> {
    read_config().pending_root
}

pub fn clear_pending_root() -> Result<()> {
    let mut config = read_config();
    config.pending_root = None;
    write_config(&config)
}

pub fn set_pending_root(target: &Path) -> Result<()> {
    let target = target
        .canonicalize()
        .or_else(|_| {
            std::fs::create_dir_all(target)?;
            target.canonicalize()
        })
        .with_context(|| format!("could not resolve storage directory {}", target.display()))?;
    let current = root().canonicalize().unwrap_or_else(|_| root());
    anyhow::ensure!(target != current, "selected directory is already in use");
    validate_destination(&current, &target)?;
    let mut config = read_config();
    config.pending_root = Some(target);
    write_config(&config)
}

pub fn apply_pending_root() -> Result<bool> {
    let mut config = read_config();
    let Some(target) = config.pending_root.clone() else {
        return Ok(false);
    };
    let source = config.root.clone().unwrap_or_else(default_root);
    let source_canonical = source.canonicalize().unwrap_or(source.clone());
    let target_canonical = target.canonicalize().unwrap_or(target.clone());
    anyhow::ensure!(
        !source_canonical.starts_with(&target_canonical)
            && !target_canonical.starts_with(&source_canonical),
        "storage directory cannot contain or be inside the current directory"
    );

    validate_destination(&source_canonical, &target_canonical)?;
    let filenames = [
        "contextos.db",
        "contextos.db-wal",
        "contextos.db.corrupt",
        "workspace.db",
        "workspace.db-wal",
    ];
    let source_cas = source.join("workspace-cas");
    let target_cas = target.join("workspace-cas");
    let source_remotes = source.join("remotes");
    let target_remotes = target.join("remotes");

    std::fs::create_dir_all(&target)?;
    let mut copied = Vec::new();
    let result = (|| -> Result<()> {
        for name in filenames {
            let from = source.join(name);
            let to = target.join(name);
            if from.is_file() {
                std::fs::copy(&from, &to)
                    .with_context(|| format!("could not copy {}", from.display()))?;
                copied.push(to);
            }
        }
        if source_cas.is_dir() {
            copied.push(target_cas.clone());
            copy_dir(&source_cas, &target_cas)?;
        }
        if source_remotes.is_dir() {
            copied.push(target_remotes.clone());
            copy_dir(&source_remotes, &target_remotes)?;
        }
        Ok(())
    })();
    if let Err(error) = result {
        for path in copied.into_iter().rev() {
            if path.is_dir() {
                let _ = std::fs::remove_dir_all(path);
            } else {
                let _ = std::fs::remove_file(path);
            }
        }
        return Err(error);
    }

    config.root = Some(target);
    config.pending_root = None;
    if let Err(error) = write_config(&config) {
        for path in copied.into_iter().rev() {
            if path.is_dir() {
                let _ = std::fs::remove_dir_all(path);
            } else {
                let _ = std::fs::remove_file(path);
            }
        }
        return Err(error);
    }
    Ok(true)
}

fn validate_destination(source: &Path, target: &Path) -> Result<()> {
    anyhow::ensure!(
        !source.starts_with(target) && !target.starts_with(source),
        "storage directory cannot contain or be inside the current directory"
    );
    for name in [
        "contextos.db",
        "contextos.db-wal",
        "contextos.db-shm",
        "contextos.db.corrupt",
        "workspace.db",
        "workspace.db-wal",
        "workspace.db-shm",
    ] {
        let to = target.join(name);
        anyhow::ensure!(
            !to.exists(),
            "destination already contains {}",
            to.display()
        );
    }
    anyhow::ensure!(
        !target.join("workspace-cas").exists(),
        "destination already contains {}",
        target.join("workspace-cas").display()
    );
    anyhow::ensure!(
        !target.join("remotes").exists(),
        "destination already contains {}",
        target.join("remotes").display()
    );
    Ok(())
}

fn copy_dir(source: &Path, target: &Path) -> Result<()> {
    std::fs::create_dir_all(target)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let from = entry.path();
        let to = target.join(entry.file_name());
        if from.is_dir() {
            copy_dir(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

fn file_set_size(path: &Path) -> u64 {
    let mut wal = path.as_os_str().to_os_string();
    wal.push("-wal");
    let mut shm = path.as_os_str().to_os_string();
    shm.push("-shm");
    [path.to_path_buf(), PathBuf::from(wal), PathBuf::from(shm)]
        .iter()
        .filter_map(|path| std::fs::metadata(path).ok())
        .map(|metadata| metadata.len())
        .sum()
}

pub fn stats() -> StorageStats {
    let root = root();
    let index_db = root.join("contextos.db");
    let index_backup = PathBuf::from(format!("{}.corrupt", index_db.display()));
    let workspace_db = root.join("workspace.db");
    let cas_dir = root.join("workspace-cas");
    let remotes_dir = root.join("remotes");
    let mut cas_bytes = 0;
    let mut cas_files = 0;
    if cas_dir.is_dir() {
        for entry in walkdir::WalkDir::new(&cas_dir).follow_links(false) {
            let Ok(entry) = entry else { continue };
            if entry.file_type().is_file() {
                cas_files += 1;
                cas_bytes += entry.metadata().map(|meta| meta.len()).unwrap_or(0);
            }
        }
    }
    let remotes_bytes = directory_size(&remotes_dir);
    let index_bytes = file_set_size(&index_db);
    let index_backup_bytes = std::fs::metadata(&index_backup)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let workspace_bytes = file_set_size(&workspace_db);
    let total_bytes = [
        index_bytes,
        index_backup_bytes,
        workspace_bytes,
        cas_bytes,
        remotes_bytes,
    ]
    .into_iter()
    .fold(0_u64, u64::saturating_add);
    StorageStats {
        root,
        total_bytes,
        index_bytes,
        index_backup_bytes,
        workspace_bytes,
        cas_bytes,
        cas_files,
        remotes_bytes,
        index_db,
        index_backup,
        workspace_db,
        cas_dir,
        remotes_dir,
    }
}

fn directory_size(path: &Path) -> u64 {
    walkdir::WalkDir::new(path)
        .follow_links(false)
        .into_iter()
        .filter_map(std::result::Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .filter_map(|entry| entry.metadata().ok())
        .map(|metadata| metadata.len())
        .sum()
}
