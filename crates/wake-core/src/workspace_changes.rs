use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceRoot {
    pub path: String,
    pub name: String,
}

/// File content observed while seeding a workspace baseline or handling a live
/// change.  The importer can disable text capture while still retaining the
/// hash needed to detect the first later modification.
#[derive(Debug, Clone)]
pub enum WorkspaceFileObservation {
    Present {
        bytes: Vec<u8>,
        file_mtime: i64,
        capture_text: bool,
    },
    Deleted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceObservationMode {
    /// Files already present when a directory is added seed comparison state
    /// silently; they do not appear in the activity timeline.
    Import,
    /// A live filesystem event is recorded, including a newly created file.
    Live,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceChangeKind {
    Created,
    Modified,
    Deleted,
}

impl WorkspaceChangeKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Modified => "modified",
            Self::Deleted => "deleted",
        }
    }

    pub(crate) fn parse(value: &str) -> anyhow::Result<Self> {
        match value {
            "created" => Ok(Self::Created),
            "modified" => Ok(Self::Modified),
            "deleted" => Ok(Self::Deleted),
            _ => anyhow::bail!("unknown workspace change kind `{value}`"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceChangeEvent {
    pub id: i64,
    pub project_path: String,
    /// Path relative to the project root.
    pub file_path: String,
    pub kind: WorkspaceChangeKind,
    pub observed_at: i64,
    pub before_hash: Option<String>,
    pub after_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionFileChangeEvent {
    pub id: i64,
    pub session_key: String,
    pub project_path: String,
    /// Path relative to the session's project root.
    pub file_path: String,
    pub kind: WorkspaceChangeKind,
    pub observed_at: i64,
    pub after_hash: Option<String>,
    #[serde(default)]
    pub source_event_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionChangeSelection {
    pub session_key: String,
    pub selected_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionChangeFileGroup {
    pub path: String,
    pub events: Vec<SessionFileChangeEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionChangeFolderGroup {
    pub path: String,
    pub files: Vec<SessionChangeFileGroup>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionChangeSessionGroup {
    pub session_key: String,
    pub metadata: Option<crate::models::SessionMeta>,
    pub selected_at: i64,
    pub latest_change_at: Option<i64>,
    pub change_count: usize,
    pub folders: Vec<SessionChangeFolderGroup>,
    pub root_files: Vec<SessionChangeFileGroup>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceChangeDetail {
    pub event: WorkspaceChangeEvent,
    /// Available only for UTF-8 text snapshots within the capture size limit.
    pub before_text: Option<String>,
    pub after_text: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ExplicitSessionFileChange {
    pub file_path: String,
    pub kind: WorkspaceChangeKind,
    pub observed_at: i64,
    pub after_hash: Option<String>,
    pub source_event_key: String,
}

pub fn explicit_session_file_changes(
    transcript: &crate::models::ParsedTranscript,
) -> Vec<ExplicitSessionFileChange> {
    let root = transcript.meta.project_path.replace('\\', "/");
    let mut changes = Vec::new();
    for message in &transcript.mainline {
        for call in &message.tool_calls {
            if call.is_error {
                continue;
            }
            let Some(observed_at) = message.timestamp else {
                continue;
            };
            let tool = call.name.to_ascii_lowercase();
            let patch = if tool == "apply_patch" {
                call.input.as_deref().and_then(decode_patch_input)
            } else if tool == "exec" {
                call.input.as_deref().and_then(extract_exec_apply_patch)
            } else {
                None
            };
            if let Some(patch) = patch {
                for (raw_path, kind, after_hash) in parse_apply_patch(&patch) {
                    let Some(file_path) = relative_workspace_path(&root, &raw_path) else {
                        continue;
                    };
                    changes.push(ExplicitSessionFileChange {
                        source_event_key: format!(
                            "{}:{}:{}:{file_path}",
                            transcript.meta.key, message.seq, call.id
                        ),
                        file_path,
                        kind,
                        observed_at,
                        after_hash,
                    });
                }
                continue;
            }
            let kind = match tool.as_str() {
                "create" | "create_file" | "write_new_file" => WorkspaceChangeKind::Created,
                "delete" | "delete_file" | "remove_file" => WorkspaceChangeKind::Deleted,
                "write" | "write_file" | "edit" | "edit_file" | "multiedit" | "replace_in_file" => {
                    WorkspaceChangeKind::Modified
                }
                _ => continue,
            };
            let Some(input) = call
                .input
                .as_deref()
                .and_then(|input| serde_json::from_str::<Value>(input).ok())
            else {
                continue;
            };
            let Some(path) = ["file_path", "filePath", "path", "filename"]
                .iter()
                .find_map(|key| input.get(key).and_then(Value::as_str))
                .and_then(|path| relative_workspace_path(&root, path))
            else {
                continue;
            };
            changes.push(ExplicitSessionFileChange {
                file_path: path.clone(),
                kind,
                observed_at,
                after_hash: input
                    .get("content")
                    .or_else(|| input.get("text"))
                    .and_then(Value::as_str)
                    .map(|content| format!("{:x}", Sha256::digest(content.as_bytes()))),
                source_event_key: format!(
                    "{}:{}:{}:{path}",
                    transcript.meta.key, message.seq, call.id
                ),
            });
        }
    }
    changes
}

fn decode_patch_input(input: &str) -> Option<String> {
    serde_json::from_str::<Value>(input)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .or_else(|| Some(input.to_string()))
}

fn extract_exec_apply_patch(input: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(input).ok();
    let command = value
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|object| {
            ["cmd", "command", "script", "code"]
                .iter()
                .find_map(|key| object.get(*key).and_then(Value::as_str))
        })
        .unwrap_or(input);

    extract_js_apply_patch_block(command).or_else(|| extract_apply_patch_block(command))
}

fn extract_apply_patch_block(command: &str) -> Option<String> {
    if !command.contains("apply_patch") {
        return None;
    }
    let start = command.find("*** Begin Patch")?;
    let end = command[start..].find("*** End Patch")? + start + "*** End Patch".len();
    Some(command[start..end].to_string())
}

fn extract_js_apply_patch_block(command: &str) -> Option<String> {
    if !command.contains("tools.apply_patch(") {
        return None;
    }
    let assignment = command.find("const patch = ")? + "const patch = ".len();
    let literal = command[assignment..].trim_start();
    if !literal.starts_with('"') {
        return None;
    }
    let mut escaped = false;
    let end = literal.char_indices().skip(1).find_map(|(index, ch)| {
        if escaped {
            escaped = false;
            None
        } else if ch == '\\' {
            escaped = true;
            None
        } else if ch == '"' {
            Some(index + ch.len_utf8())
        } else {
            None
        }
    })?;
    let patch = serde_json::from_str::<String>(&literal[..end]).ok()?;
    extract_apply_patch_block(&format!("apply_patch {patch}"))
}

fn parse_apply_patch(patch: &str) -> Vec<(String, WorkspaceChangeKind, Option<String>)> {
    let mut changes = Vec::new();
    let mut lines = patch.lines().peekable();
    while let Some(line) = lines.next() {
        let (path, kind) = if let Some(path) = line.strip_prefix("*** Add File: ") {
            (path, WorkspaceChangeKind::Created)
        } else if let Some(path) = line.strip_prefix("*** Delete File: ") {
            (path, WorkspaceChangeKind::Deleted)
        } else if let Some(path) = line.strip_prefix("*** Update File: ") {
            (path, WorkspaceChangeKind::Modified)
        } else {
            continue;
        };
        let after_hash = if kind == WorkspaceChangeKind::Created {
            let mut content = Vec::new();
            let mut has_final_newline = true;
            while let Some(next) = lines.peek().copied() {
                if next.starts_with("*** ") {
                    break;
                }
                let next = lines.next().unwrap_or_default();
                if next == "\\ No newline at end of file" {
                    has_final_newline = false;
                } else if let Some(text) = next.strip_prefix('+') {
                    content.push(text);
                }
            }
            let mut text = content.join("\n");
            if has_final_newline && !content.is_empty() {
                text.push('\n');
            }
            Some(format!("{:x}", Sha256::digest(text.as_bytes())))
        } else {
            None
        };
        changes.push((path.to_string(), kind, after_hash));
    }
    changes
}

fn relative_workspace_path(root: &str, path: &str) -> Option<String> {
    let root = root.trim_end_matches('/');
    let path = path.replace('\\', "/");
    let relative = if path.starts_with('/') || path.as_bytes().get(1) == Some(&b':') {
        let (prefix, suffix) = path.split_at(root.len().min(path.len()));
        if !prefix.eq_ignore_ascii_case(root) {
            return None;
        }
        suffix.strip_prefix('/')?
    } else {
        path.as_str()
    };
    let mut parts = Vec::new();
    for part in relative.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            value => parts.push(value),
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_add_file_from_codex_exec_patch_wrapper() {
        let input = r#"const patch = "*** Begin Patch\n*** Add File: D:\\Wake\\workspace-change-test.txt\n+ContextOS workspace change test\n*** End Patch"; text(await tools.apply_patch(patch))"#;
        let patch = extract_exec_apply_patch(input).expect("apply_patch wrapper");
        let changes = parse_apply_patch(&patch);

        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].0, r"D:\Wake\workspace-change-test.txt");
        assert_eq!(changes[0].1, WorkspaceChangeKind::Created);
        assert_eq!(
            changes[0].2.as_deref(),
            Some(format!("{:x}", Sha256::digest(b"ContextOS workspace change test\n")).as_str())
        );
    }

    #[test]
    fn ignores_exec_without_apply_patch_tool_call() {
        assert!(extract_exec_apply_patch("const cmd = 'apply_patch';").is_none());
    }
}
