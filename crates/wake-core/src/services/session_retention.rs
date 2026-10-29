use anyhow::{anyhow, Context, Result};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetentionAgent {
    ClaudeCode,
    Gemini,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetentionSnapshot {
    pub agent: RetentionAgent,
    pub path: PathBuf,
    pub value: Option<String>,
    pub is_default: bool,
    pub error: Option<String>,
    pub min_retention: Option<String>,
}

pub fn config_paths(
    home: &Path,
    claude_config_dir: Option<&Path>,
) -> [(RetentionAgent, PathBuf); 2] {
    [
        (
            RetentionAgent::ClaudeCode,
            claude_config_dir
                .map(Path::to_path_buf)
                .unwrap_or_else(|| home.join(".claude"))
                .join("settings.json"),
        ),
        (
            RetentionAgent::Gemini,
            home.join(".gemini").join("settings.json"),
        ),
    ]
}

pub fn snapshots(home: &Path, claude_config_dir: Option<&Path>) -> Vec<RetentionSnapshot> {
    config_paths(home, claude_config_dir)
        .into_iter()
        .map(|(agent, path)| read_snapshot(agent, path))
        .collect()
}

pub fn current_snapshots() -> Vec<RetentionSnapshot> {
    let Some(home) = crate::adapters::home_dir() else {
        return Vec::new();
    };
    let claude = std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from);
    snapshots(&home, claude.as_deref())
}

pub fn write_current(agent: RetentionAgent, input: &str) -> Result<Vec<RetentionSnapshot>> {
    let snapshots = current_snapshots();
    let snapshot = snapshots
        .iter()
        .find(|item| item.agent == agent)
        .ok_or_else(|| anyhow!("could not resolve configuration path"))?;
    write_value(
        &snapshot.path,
        agent,
        input,
        snapshot.min_retention.as_deref(),
    )?;
    Ok(current_snapshots())
}

fn read_snapshot(agent: RetentionAgent, path: PathBuf) -> RetentionSnapshot {
    let mut snapshot = RetentionSnapshot {
        agent,
        path: path.clone(),
        value: None,
        is_default: false,
        error: None,
        min_retention: None,
    };
    if !path.exists() {
        snapshot.error = Some("Configuration file does not exist".into());
        return snapshot;
    }
    let result = std::fs::read_to_string(&path)
        .with_context(|| format!("could not read {}", path.display()))
        .and_then(|raw| serde_json::from_str::<Value>(&raw).context("invalid JSON"));
    let value = match result {
        Ok(value) => value,
        Err(error) => {
            snapshot.error = Some(format!("{error:#}"));
            return snapshot;
        }
    };
    match agent {
        RetentionAgent::ClaudeCode => match value.get("cleanupPeriodDays") {
            None => {
                snapshot.value = Some("30".into());
                snapshot.is_default = true;
            }
            Some(Value::Number(days)) if days.as_u64().is_some() => {
                snapshot.value = Some(days.as_u64().unwrap().to_string());
            }
            Some(_) => snapshot.error = Some("cleanupPeriodDays must be a positive integer".into()),
        },
        RetentionAgent::Gemini => {
            let retention = value.pointer("/general/sessionRetention");
            match retention.and_then(|v| v.get("maxAge")) {
                None => {
                    snapshot.value = Some("30d".into());
                    snapshot.is_default = true;
                }
                Some(Value::String(value)) if parse_duration(value).is_some() => {
                    snapshot.value = Some(value.clone());
                }
                Some(_) => {
                    snapshot.error =
                        Some("general.sessionRetention.maxAge must be a duration string".into())
                }
            }
            snapshot.min_retention = retention
                .and_then(|v| v.get("minRetention"))
                .and_then(Value::as_str)
                .map(str::to_string);
        }
    }
    snapshot
}

pub fn validate(agent: RetentionAgent, input: &str, min_retention: Option<&str>) -> Result<String> {
    let input = input.trim();
    match agent {
        RetentionAgent::ClaudeCode => {
            let days: u32 = input.parse().context("enter a whole number of days")?;
            if !(1..=100_000).contains(&days) {
                return Err(anyhow!(
                    "enter a value from 1 to 100000; 0 disables transcript storage"
                ));
            }
            Ok(days.to_string())
        }
        RetentionAgent::Gemini => {
            let (amount, unit) = parse_duration(input)
                .ok_or_else(|| anyhow!("use a duration such as 30d, 12w, or 24h"))?;
            if amount == 0 {
                return Err(anyhow!("duration must be greater than zero"));
            }
            if let Some(minimum) = min_retention.and_then(parse_duration) {
                if duration_hours((amount, unit)) < duration_hours(minimum) {
                    return Err(anyhow!(
                        "value is shorter than Gemini's minRetention ({})",
                        min_retention.unwrap_or_default()
                    ));
                }
            }
            Ok(format!("{amount}{unit}"))
        }
    }
}

fn parse_duration(value: &str) -> Option<(u64, char)> {
    let value = value.trim();
    let (unit, number) = value
        .chars()
        .next_back()
        .map(|unit| (unit, &value[..value.len() - unit.len_utf8()]))?;
    if !matches!(unit, 'd' | 'w' | 'h') {
        return None;
    }
    Some((number.parse().ok()?, unit))
}

fn duration_hours((amount, unit): (u64, char)) -> u64 {
    amount.saturating_mul(match unit {
        'h' => 1,
        'd' => 24,
        'w' => 168,
        _ => 1,
    })
}

pub fn write_value(
    path: &Path,
    agent: RetentionAgent,
    input: &str,
    min_retention: Option<&str>,
) -> Result<RetentionSnapshot> {
    let normalized = validate(agent, input, min_retention)?;
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => "{}".into(),
        Err(error) => {
            return Err(error).with_context(|| format!("could not read {}", path.display()))
        }
    };
    let mut value: Value = serde_json::from_str(&raw).context("invalid JSON")?;
    if !value.is_object() {
        return Err(anyhow!("settings JSON must be an object"));
    }
    match agent {
        RetentionAgent::ClaudeCode => {
            value.as_object_mut().unwrap().insert(
                "cleanupPeriodDays".into(),
                Value::Number(normalized.parse::<u64>()?.into()),
            );
        }
        RetentionAgent::Gemini => {
            let root = value.as_object_mut().unwrap();
            let general = root
                .entry("general")
                .or_insert_with(|| Value::Object(Map::new()));
            if !general.is_object() {
                return Err(anyhow!("general must be a JSON object"));
            }
            let retention = general
                .as_object_mut()
                .unwrap()
                .entry("sessionRetention")
                .or_insert_with(|| Value::Object(Map::new()));
            if !retention.is_object() {
                return Err(anyhow!("general.sessionRetention must be a JSON object"));
            }
            retention
                .as_object_mut()
                .unwrap()
                .insert("maxAge".into(), Value::String(normalized));
        }
    }
    let encoded = format!("{}\n", serde_json::to_string_pretty(&value)?);
    atomic_write(path, encoded.as_bytes())?;
    Ok(read_snapshot(agent, path.to_path_buf()))
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("settings path has no parent"))?;
    std::fs::create_dir_all(parent)?;
    let name = path
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("settings.json");
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_roundtrip_preserves_unknown_keys_and_rejects_zero() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, r#"{"hooks":{"SessionStart":[]},"env":{"X":"y"}}"#).unwrap();
        let updated = write_value(&path, RetentionAgent::ClaudeCode, "3650", None).unwrap();
        let value: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(value["hooks"]["SessionStart"], serde_json::json!([]));
        assert_eq!(value["env"]["X"], "y");
        assert_eq!(updated.value.as_deref(), Some("3650"));
        assert!(validate(RetentionAgent::ClaudeCode, "0", None).is_err());
    }

    #[test]
    fn gemini_duration_and_missing_or_invalid_configs_are_reported() {
        assert_eq!(
            validate(RetentionAgent::Gemini, "12w", Some("1d")).unwrap(),
            "12w"
        );
        assert!(validate(RetentionAgent::Gemini, "12", None).is_err());
        assert!(validate(RetentionAgent::Gemini, "1d", Some("48h")).is_err());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let missing = read_snapshot(RetentionAgent::Gemini, path.clone());
        assert!(missing.error.is_some());
        std::fs::write(&path, "{").unwrap();
        let invalid = read_snapshot(RetentionAgent::Gemini, path);
        assert!(invalid.error.as_deref().unwrap().contains("invalid JSON"));
    }
}
