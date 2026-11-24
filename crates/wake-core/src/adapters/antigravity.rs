use super::parse_utils::*;
use super::sqlite_ro::{db_cache_stamp, open_sqlite_ro, virtual_path};
use super::AgentAdapter;
use crate::models::*;
use anyhow::{anyhow, Result};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

/// Antigravity CLI / IDE (Google, binary `agy`):
/// 元数据存储于 `~/.gemini/antigravity/conversation_summaries.db`（或兼容 `antigravity-cli` 路径）。
/// 明文会话与工具调用存储于 `~/.gemini/antigravity/brain/<id>/.system_generated/logs/transcript_full.jsonl`
/// （以及 `transcript.jsonl`）。若存在日志则解析完整多轮对话与工具调用；若无日志则回退至 SQLite preview。
pub struct AntigravityAdapter {
    db: PathBuf,
    /// 全表很小(元数据行),按 db mtime 缓存一轮扫描内的重复调用
    rows_cache: MtimeCache<Vec<AgRow>>,
}

impl AntigravityAdapter {
    pub fn new() -> Self {
        let home = super::home_dir().unwrap_or_default().join(".gemini");
        let ag_db = home.join("antigravity").join("conversation_summaries.db");
        let cli_db = home
            .join("antigravity-cli")
            .join("conversation_summaries.db");
        let db = if ag_db.is_file() {
            ag_db
        } else if cli_db.is_file() {
            cli_db
        } else {
            ag_db
        };
        Self {
            db,
            rows_cache: MtimeCache::new(),
        }
    }

    fn rows(&self) -> Option<Vec<AgRow>> {
        let mtime = super::sqlite_ro::db_cache_stamp(&self.db);
        self.rows_cache.get_or_try_build(mtime, || {
            let ro = open_sqlite_ro(&self.db, "antigravity")?;
            let mut stmt = ro
                .conn
                .prepare(
                    "SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris
                     FROM conversation_summaries
                     WHERE parent_conversation_id = '' AND nesting_depth = 0",
                )
                .ok()?;
            let rows = stmt
                .query_map([], |r| {
                    Ok(AgRow {
                        id: r.get(0)?,
                        title: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                        preview: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                        step_count: r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                        modified_ms: sqlite_dt_ms(r.get::<_, Option<String>>(4)?.unwrap_or_default().trim()),
                        cwd: first_workspace(&r.get::<_, Option<String>>(5)?.unwrap_or_default()),
                    })
                })
                .ok()?
                .collect::<rusqlite::Result<Vec<_>>>()
                .ok()?;
            Some(rows)
        })
    }

    fn find_transcript_log(&self, id: &str) -> Option<PathBuf> {
        if let Some(parent) = self.db.parent() {
            let brain_log = parent
                .join("brain")
                .join(id)
                .join(".system_generated")
                .join("logs");
            let full = brain_log.join("transcript_full.jsonl");
            if full.is_file() {
                return Some(full);
            }
            let reg = brain_log.join("transcript.jsonl");
            if reg.is_file() {
                return Some(reg);
            }
        }
        if let Some(home) = super::home_dir() {
            let brain_log = home
                .join(".gemini")
                .join("antigravity")
                .join("brain")
                .join(id)
                .join(".system_generated")
                .join("logs");
            let full = brain_log.join("transcript_full.jsonl");
            if full.is_file() {
                return Some(full);
            }
            let reg = brain_log.join("transcript.jsonl");
            if reg.is_file() {
                return Some(reg);
            }
        }
        None
    }

    fn build_meta(
        &self,
        r: &SessionFileRef,
        row: &AgRow,
        parsed_opt: Option<&AntigravityTranscriptParse>,
    ) -> SessionMeta {
        let title = Some(clean_title_candidate(&row.title))
            .filter(|t| !t.is_empty())
            .or_else(|| Some(clean_title_candidate(&row.preview)).filter(|t| !t.is_empty()))
            .unwrap_or_else(|| UNTITLED.to_string());

        let created_at = parsed_opt
            .and_then(|p| p.first_ts)
            .filter(|&t| t > 0)
            .unwrap_or(if row.modified_ms > 0 {
                row.modified_ms
            } else {
                r.mtime_ms
            });

        let updated_at = parsed_opt
            .and_then(|p| p.last_ts)
            .filter(|&t| t > 0)
            .unwrap_or(if row.modified_ms > 0 {
                row.modified_ms
            } else {
                r.mtime_ms
            });

        let message_count = parsed_opt
            .map(|p| p.messages.len() as i64)
            .unwrap_or(row.step_count);

        let model = parsed_opt.and_then(|p| p.model.clone());
        let tokens_used = parsed_opt.map(|p| p.total_tokens).filter(|&t| t > 0);

        SessionMeta {
            key: format!("antigravity:{}", row.id),
            host: String::new(),
            id: row.id.clone(),
            agent: AgentId::Antigravity,
            title,
            project_path: row.cwd.clone(),
            project_name: project_name_of(&row.cwd),
            file_path: r.file_path.clone(),
            created_at,
            updated_at,
            message_count,
            size_bytes: r.size,
            git_branch: None,
            model,
            tokens_used,
            archived: false,
            source: None,
            favorite: false,
            pinned: false,
        }
    }

    fn parse_summary_fallback(
        &self,
        r: &SessionFileRef,
        row: &AgRow,
    ) -> (SessionMeta, Vec<TranscriptMessage>) {
        let mut text = String::new();
        if !row.preview.trim().is_empty() {
            text.push_str(row.preview.trim());
            text.push_str("\n\n");
        }
        text.push_str(
            "Antigravity stores conversation content encrypted — only this summary is available in Wake.",
        );
        let mut messages = vec![text_msg(Role::System, &text, row.modified_ms)];
        assign_seq(&mut messages);
        (self.build_meta(r, row, None), messages)
    }
}

#[derive(Clone)]
struct AgRow {
    id: String,
    title: String,
    preview: String,
    step_count: i64,
    modified_ms: i64,
    cwd: String,
}

fn first_workspace(raw: &str) -> String {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else {
        return String::new();
    };
    let Some(uri) = v
        .as_array()
        .and_then(|a| a.first())
        .and_then(|x| x.as_str())
    else {
        return String::new();
    };
    let path = uri.strip_prefix("file://").unwrap_or(uri);
    percent_decode(path)
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn clean_user_text(raw: &str) -> String {
    let mut text = raw.trim();
    if let Some(start) = text.find("<USER_REQUEST>") {
        let after = &text[start + "<USER_REQUEST>".len()..];
        if let Some(end) = after.find("</USER_REQUEST>") {
            return after[..end].trim().to_string();
        }
    }
    if let Some(start) = text.find("<ADDITIONAL_METADATA>") {
        text = text[..start].trim();
    }
    text.to_string()
}

struct AntigravityTranscriptParse {
    messages: Vec<TranscriptMessage>,
    usage_events: Vec<SessionUsageEvent>,
    model: Option<String>,
    total_tokens: i64,
    first_ts: Option<i64>,
    last_ts: Option<i64>,
}

fn parse_antigravity_log(path: &Path, default_ts: i64) -> Result<AntigravityTranscriptParse> {
    let file = File::open(path)?;
    let reader = BufReader::with_capacity(512 * 1024, file);

    let mut messages: Vec<TranscriptMessage> = Vec::new();
    let mut usage_events: Vec<SessionUsageEvent> = Vec::new();
    let mut pending_tools: VecDeque<(usize, usize)> = VecDeque::new();
    let mut detected_model: Option<String> = None;
    let mut total_tokens = 0i64;
    let mut first_ts: Option<i64> = None;
    let mut last_ts: Option<i64> = None;

    for (line_idx, line) in reader.lines().enumerate() {
        let Ok(line) = line else { continue };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(row) = serde_json::from_str::<Value>(line) else {
            continue;
        };

        let step_type = row.get("type").and_then(Value::as_str).unwrap_or("");
        let step_index = row
            .get("step_index")
            .and_then(Value::as_i64)
            .unwrap_or(line_idx as i64);

        let ts = row
            .get("created_at")
            .and_then(Value::as_str)
            .map(iso_ms)
            .filter(|&t| t > 0)
            .unwrap_or(default_ts);

        if first_ts.is_none() && ts > 0 {
            first_ts = Some(ts);
        }
        if ts > 0 {
            last_ts = Some(ts);
        }

        match step_type {
            "USER_INPUT" => {
                let content = row.get("content").and_then(Value::as_str).unwrap_or("");
                let mut user_text = clean_user_text(content);

                if let Some(media_arr) = row.get("media").and_then(Value::as_array) {
                    for m in media_arr {
                        if let Some(uri) = m.get("uri").and_then(Value::as_str) {
                            let fname = Path::new(uri)
                                .file_name()
                                .map(|f| f.to_string_lossy().to_string())
                                .unwrap_or_else(|| uri.to_string());
                            user_text.push_str(&format!("\n\n📎 [{}]", fname));
                        }
                    }
                }

                messages.push(TranscriptMessage {
                    seq: 0,
                    role: Role::User,
                    kind: MessageKind::Text,
                    text: user_text,
                    truncated: false,
                    tool_calls: Vec::new(),
                    thinking: None,
                    timestamp: Some(ts),
                    model: None,
                    images: Vec::new(),
                });
            }
            "PLANNER_RESPONSE" => {
                let model_str = row.get("model").and_then(Value::as_str);
                if let Some(m) = model_str {
                    detected_model = Some(m.to_string());
                }

                let in_tok = row.get("input_tokens").and_then(Value::as_i64).unwrap_or(0);
                let out_tok = row
                    .get("output_tokens")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                let cache_tok = row
                    .get("cache_read_tokens")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                let step_tokens = in_tok + out_tok + cache_tok;

                if step_tokens > 0 {
                    total_tokens += step_tokens;
                    usage_events.push(SessionUsageEvent {
                        timestamp: Some(ts),
                        tokens_used: step_tokens,
                        model: model_str.map(ToString::to_string),
                    });
                }

                let content = row.get("content").and_then(Value::as_str).unwrap_or("");
                let thinking = row.get("thinking").and_then(Value::as_str);

                let mut tool_views = Vec::new();
                let msg_idx = messages.len();

                if let Some(tcs) = row.get("tool_calls").and_then(Value::as_array) {
                    for (ti, tc) in tcs.iter().enumerate() {
                        let name = tc.get("name").and_then(Value::as_str).unwrap_or("tool");
                        let args = tc.get("args").unwrap_or(&Value::Null);
                        let id = format!("call_{}_{}", step_index, ti);
                        tool_views.push(tool_call_view(id, name, args, None, false));
                        pending_tools.push_back((msg_idx, ti));
                    }
                }

                if !content.is_empty() || !tool_views.is_empty() || thinking.is_some() {
                    messages.push(TranscriptMessage {
                        seq: 0,
                        role: Role::Assistant,
                        kind: MessageKind::Text,
                        text: content.to_string(),
                        truncated: false,
                        tool_calls: tool_views,
                        thinking: thinking.map(|t| clip(t, MAX_TOOL_IO).0),
                        timestamp: Some(ts),
                        model: model_str.map(ToString::to_string),
                        images: Vec::new(),
                    });
                }
            }
            "GENERIC" => {
                let content = row.get("content").and_then(Value::as_str).unwrap_or("");
                if let Some((mi, ti)) = pending_tools.pop_front() {
                    if mi < messages.len() && ti < messages[mi].tool_calls.len() {
                        messages[mi].tool_calls[ti].output = Some(clip(content, MAX_TOOL_IO).0);
                    }
                } else if !content.trim().is_empty() {
                    messages.push(TranscriptMessage {
                        seq: 0,
                        role: Role::System,
                        kind: MessageKind::Text,
                        text: content.to_string(),
                        truncated: false,
                        tool_calls: Vec::new(),
                        thinking: None,
                        timestamp: Some(ts),
                        model: None,
                        images: Vec::new(),
                    });
                }
            }
            "ERROR_MESSAGE" => {
                let err = row.get("error").and_then(Value::as_str).unwrap_or("");
                if let Some((mi, ti)) = pending_tools.pop_front() {
                    if mi < messages.len() && ti < messages[mi].tool_calls.len() {
                        messages[mi].tool_calls[ti].output = Some(clip(err, MAX_TOOL_IO).0);
                        messages[mi].tool_calls[ti].is_error = true;
                    }
                } else if !err.trim().is_empty() {
                    messages.push(TranscriptMessage {
                        seq: 0,
                        role: Role::System,
                        kind: MessageKind::Text,
                        text: format!("Error: {}", err),
                        truncated: false,
                        tool_calls: Vec::new(),
                        thinking: None,
                        timestamp: Some(ts),
                        model: None,
                        images: Vec::new(),
                    });
                }
            }
            "SYSTEM_MESSAGE" => {
                let content = row.get("content").and_then(Value::as_str).unwrap_or("");
                if !content.trim().is_empty() {
                    messages.push(TranscriptMessage {
                        seq: 0,
                        role: Role::System,
                        kind: MessageKind::Text,
                        text: content.to_string(),
                        truncated: false,
                        tool_calls: Vec::new(),
                        thinking: None,
                        timestamp: Some(ts),
                        model: None,
                        images: Vec::new(),
                    });
                }
            }
            _ => {}
        }
    }

    assign_seq(&mut messages);

    Ok(AntigravityTranscriptParse {
        messages,
        usage_events,
        model: detected_model,
        total_tokens,
        first_ts,
        last_ts,
    })
}

impl AgentAdapter for AntigravityAdapter {
    fn agent(&self) -> AgentId {
        AgentId::Antigravity
    }

    fn begin_scan(&self) {
        self.rows_cache.invalidate();
    }

    fn list_session_files(&self) -> Result<Vec<SessionFileRef>> {
        let Some(rows) = self.rows() else {
            return Ok(Vec::new());
        };
        let source_stamp = db_cache_stamp(&self.db);
        Ok(rows
            .into_iter()
            .map(|row| {
                let (mtime_ms, size) = if let Some(path) = self.find_transcript_log(&row.id) {
                    if let Ok(meta) = std::fs::metadata(&path) {
                        (mtime_ms(&meta), meta.len() as i64)
                    } else {
                        (source_stamp, (row.title.len() + row.preview.len()) as i64)
                    }
                } else {
                    (source_stamp, (row.title.len() + row.preview.len()) as i64)
                };
                SessionFileRef {
                    agent: AgentId::Antigravity,
                    native_id: row.id.clone(),
                    file_path: virtual_path(&self.db, &row.id),
                    mtime_ms,
                    size,
                }
            })
            .collect())
    }

    fn quick_meta(&self, refs: &[SessionFileRef]) -> Option<HashMap<String, SessionMeta>> {
        let rows = self.rows()?;
        let by_id: HashMap<&str, &AgRow> = rows.iter().map(|r| (r.id.as_str(), r)).collect();
        let mut out = HashMap::new();
        for r in refs {
            if let Some(row) = by_id.get(r.native_id.as_str()) {
                out.insert(r.file_path.clone(), self.build_meta(r, row, None));
            }
        }
        Some(out)
    }

    fn parse_session(&self, r: &SessionFileRef) -> Result<ParsedSession> {
        let rows = self
            .rows()
            .ok_or_else(|| anyhow!("cannot open antigravity summaries store"))?;
        let row = rows
            .iter()
            .find(|x| x.id == r.native_id)
            .ok_or_else(|| anyhow!("antigravity conversation {} not in store", r.native_id))?;

        if let Some(log_path) = self.find_transcript_log(&r.native_id) {
            if let Ok(parsed) = parse_antigravity_log(&log_path, row.modified_ms) {
                if !parsed.messages.is_empty() {
                    let meta = self.build_meta(r, row, Some(&parsed));
                    return Ok(ParsedSession::derive(meta, &parsed.messages, 0));
                }
            }
        }

        let (meta, messages) = self.parse_summary_fallback(r, row);
        Ok(ParsedSession::derive(meta, &messages, 0))
    }

    fn parse_transcript(&self, r: &SessionFileRef) -> Result<ParsedTranscript> {
        let rows = self
            .rows()
            .ok_or_else(|| anyhow!("cannot open antigravity summaries store"))?;
        let row = rows
            .iter()
            .find(|x| x.id == r.native_id)
            .ok_or_else(|| anyhow!("antigravity conversation {} not in store", r.native_id))?;

        if let Some(log_path) = self.find_transcript_log(&r.native_id) {
            if let Ok(parsed) = parse_antigravity_log(&log_path, row.modified_ms) {
                if !parsed.messages.is_empty() {
                    let meta = self.build_meta(r, row, Some(&parsed));
                    return Ok(ParsedTranscript {
                        meta,
                        mainline: parsed.messages,
                        sidechains: Vec::new(),
                        usage_events: parsed.usage_events,
                        unknown_line_count: 0,
                    });
                }
            }
        }

        let (meta, messages) = self.parse_summary_fallback(r, row);
        Ok(ParsedTranscript {
            meta,
            mainline: messages,
            sidechains: Vec::new(),
            usage_events: Vec::new(),
            unknown_line_count: 0,
        })
    }

    fn with_custom_root(&self, dir: PathBuf) -> Box<dyn AgentAdapter> {
        let ag_nested = dir.join("antigravity").join("conversation_summaries.db");
        let cli_nested = dir
            .join("antigravity-cli")
            .join("conversation_summaries.db");
        let direct_db = dir.join("conversation_summaries.db");
        let db = if dir.is_file() {
            dir
        } else if direct_db.is_file() {
            direct_db
        } else if ag_nested.is_file() {
            ag_nested
        } else if cli_nested.is_file() {
            cli_nested
        } else {
            direct_db
        };
        Box::new(Self {
            db,
            rows_cache: MtimeCache::new(),
        })
    }

    fn data_roots(&self) -> Vec<PathBuf> {
        vec![self.db.clone()]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn test_clean_user_text() {
        let raw = "<USER_REQUEST>\n请帮我分析这份简历\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\ntime=now\n</ADDITIONAL_METADATA>";
        assert_eq!(clean_user_text(raw), "请帮我分析这份简历");

        let plain = "普通文本无标签";
        assert_eq!(clean_user_text(plain), "普通文本无标签");
    }

    #[test]
    fn test_parse_antigravity_log() {
        let dir = tempfile::tempdir().unwrap();
        let log_file = dir.path().join("transcript_full.jsonl");

        let lines = [
            r#"{"step_index":0,"type":"USER_INPUT","source":"USER_EXPLICIT","created_at":"2026-11-23T14:42:06Z","content":"<USER_REQUEST>\n查看这个简历\n</USER_REQUEST>","media":[{"mime_type":"application/pdf","uri":"C:/path/to/resume.pdf"}]}"#,
            r#"{"step_index":1,"type":"PLANNER_RESPONSE","source":"MODEL","created_at":"2026-11-23T14:42:08Z","model":"gemini-3.8-flash","input_tokens":100,"output_tokens":50,"cache_read_tokens":10,"content":"你的简历非常优秀","thinking":"分析中...","tool_calls":[{"name":"run_command","args":{"CommandLine":"dir"}}]}"#,
            r#"{"step_index":2,"type":"GENERIC","source":"MODEL","created_at":"2026-11-23T14:42:10Z","content":"file1.txt\nfile2.txt"}"#,
        ];

        {
            let mut f = File::create(&log_file).unwrap();
            for l in &lines {
                writeln!(f, "{}", l).unwrap();
            }
        }

        let parsed = parse_antigravity_log(&log_file, 1000).unwrap();
        assert_eq!(parsed.messages.len(), 2);

        // User message
        assert_eq!(parsed.messages[0].role, Role::User);
        assert!(parsed.messages[0].text.contains("查看这个简历"));
        assert!(parsed.messages[0].text.contains("resume.pdf"));

        // Assistant message with tool call matched to generic output
        assert_eq!(parsed.messages[1].role, Role::Assistant);
        assert_eq!(parsed.messages[1].text, "你的简历非常优秀");
        assert_eq!(parsed.messages[1].thinking.as_deref(), Some("分析中..."));
        assert_eq!(parsed.messages[1].tool_calls.len(), 1);
        assert_eq!(parsed.messages[1].tool_calls[0].name, "run_command");
        assert_eq!(
            parsed.messages[1].tool_calls[0].output.as_deref(),
            Some("file1.txt\nfile2.txt")
        );

        // Usage events
        assert_eq!(parsed.total_tokens, 160);
        assert_eq!(parsed.model.as_deref(), Some("gemini-3.8-flash"));
        assert_eq!(parsed.usage_events.len(), 1);
        assert_eq!(parsed.usage_events[0].tokens_used, 160);
    }
}
