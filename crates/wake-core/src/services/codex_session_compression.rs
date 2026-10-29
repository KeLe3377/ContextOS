use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use toml_edit::{value, DocumentMut};

const FEATURE_KEY: &str = "local_thread_store_compression";

#[derive(Debug, Clone)]
pub struct CodexCompressionSnapshot {
    pub path: PathBuf,
    pub enabled: bool,
    pub error: Option<String>,
}

fn config_path() -> Result<PathBuf> {
    let home = dirs::home_dir().context("could not resolve home directory")?;
    let codex_home = std::env::var_os("CODEX_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"));
    Ok(codex_home.join("config.toml"))
}

fn read_enabled(path: &Path) -> Result<bool> {
    if !path.exists() {
        return Ok(false);
    }
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("could not read {}", path.display()))?;
    let document = raw
        .parse::<DocumentMut>()
        .with_context(|| format!("invalid TOML in {}", path.display()))?;
    let feature = &document["features"][FEATURE_KEY];
    Ok(feature.as_bool().unwrap_or_else(|| {
        feature
            .as_table()
            .and_then(|table| table.get("enabled"))
            .and_then(toml_edit::Item::as_bool)
            .or_else(|| {
                feature
                    .as_value()
                    .and_then(toml_edit::Value::as_inline_table)
                    .and_then(|table| table.get("enabled"))
                    .and_then(toml_edit::Value::as_bool)
            })
            .unwrap_or(false)
    }))
}

pub fn current_snapshot() -> CodexCompressionSnapshot {
    match config_path() {
        Ok(path) => match read_enabled(&path) {
            Ok(enabled) => CodexCompressionSnapshot {
                path,
                enabled,
                error: None,
            },
            Err(error) => CodexCompressionSnapshot {
                path,
                enabled: false,
                error: Some(format!("{error:#}")),
            },
        },
        Err(error) => CodexCompressionSnapshot {
            path: PathBuf::new(),
            enabled: false,
            error: Some(format!("{error:#}")),
        },
    }
}

pub fn set_current_enabled(enabled: bool) -> CodexCompressionSnapshot {
    let result = config_path().and_then(|path| {
        let raw = match std::fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(error) => {
                return Err(error).with_context(|| format!("could not read {}", path.display()))
            }
        };
        let mut document = if raw.is_empty() {
            DocumentMut::new()
        } else {
            raw.parse::<DocumentMut>()
                .with_context(|| format!("invalid TOML in {}", path.display()))?
        };
        if enabled {
            document["features"][FEATURE_KEY] = value(true);
        } else if let Some(features) = document
            .get_mut("features")
            .and_then(|item| item.as_table_mut())
        {
            features.remove(FEATURE_KEY);
        }
        atomic_write(&path, document.to_string().as_bytes())?;
        Ok(path)
    });

    match result {
        Ok(path) => match read_enabled(&path) {
            Ok(enabled) => CodexCompressionSnapshot {
                path,
                enabled,
                error: None,
            },
            Err(error) => CodexCompressionSnapshot {
                path,
                enabled: false,
                error: Some(format!("{error:#}")),
            },
        },
        Err(error) => {
            let mut snapshot = current_snapshot();
            snapshot.error = Some(format!("{error:#}"));
            snapshot
        }
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .context("Codex configuration path has no parent")?;
    std::fs::create_dir_all(parent)?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("config.toml");
    let temp = parent.join(format!(".{name}.contextos-{}.tmp", std::process::id()));
    std::fs::write(&temp, bytes)?;
    if let Err(error) = replace_file(&temp, path) {
        let _ = std::fs::remove_file(&temp);
        return Err(error).with_context(|| format!("could not replace {}", path.display()));
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(temp: &Path, path: &Path) -> std::io::Result<()> {
    std::fs::rename(temp, path)
}

#[cfg(windows)]
fn replace_file(temp: &Path, path: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "Kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }
    let from: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let ok = unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0x1 | 0x8) };
    if ok == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}
