use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use anyhow::Context;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::adapters::{adapter_for, AgentAdapter};
use crate::cleanup;
use crate::db::Store;
use crate::models::{AgentId, MemoryFilter, SessionFilter};
use crate::services::exporter::{render_compact, CompactOptions};

pub const SETTINGS: &str = "contextos_settings";
pub const SESSIONS: &str = "contextos_sessions";
pub const RELATIONS: &str = "contextos_relations";
pub const COMPRESSION: &str = "contextos_compression";
pub const MEMORIES: &str = "contextos_memories";
pub const DATA_SOURCES: &str = "contextos_data_sources";
pub const NAMES: [&str; 6] = [
    SETTINGS,
    SESSIONS,
    RELATIONS,
    COMPRESSION,
    MEMORIES,
    DATA_SOURCES,
];

#[derive(Debug)]
struct ControlError {
    code: &'static str,
    message: String,
    details: Option<Value>,
}

impl ControlError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: None,
        }
    }
    fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }
    fn invalid(message: impl Into<String>) -> Self {
        Self::new("invalid_request", message)
    }
    fn not_found(message: impl Into<String>) -> Self {
        Self::new("not_found", message)
    }
    fn not_allowed(message: impl Into<String>) -> Self {
        Self::new("not_allowed", message)
    }
    fn conflict(message: impl Into<String>) -> Self {
        Self::new("conflict", message)
    }
    fn internal(error: impl std::fmt::Display) -> Self {
        Self::new("internal_error", error.to_string())
    }
}

type ControlResult = std::result::Result<Value, ControlError>;

pub fn invoke(
    store: &Store,
    adapters: &[Box<dyn AgentAdapter>],
    domain: &str,
    args: &Value,
) -> String {
    let result = match domain {
        SETTINGS => settings(store, args),
        SESSIONS => sessions(store, adapters, args),
        RELATIONS => relations(store, args),
        COMPRESSION => compression(store, adapters, args),
        MEMORIES => memories(store, args),
        DATA_SOURCES => data_sources(store, args),
        _ => Err(ControlError::invalid(format!("unknown domain `{domain}`"))),
    };
    match result {
        Ok(data) => json!({ "ok": true, "data": data, "warnings": [] }).to_string(),
        Err(error) => {
            let mut body = json!({"code": error.code, "message": error.message});
            if let Some(details) = error.details {
                body["details"] = details;
            }
            json!({"ok": false, "error": body}).to_string()
        }
    }
}

fn object<'a>(
    value: &'a Value,
    name: &str,
) -> std::result::Result<&'a Map<String, Value>, ControlError> {
    value
        .as_object()
        .ok_or_else(|| ControlError::invalid(format!("`{name}` must be an object")))
}

fn operation(args: &Value) -> std::result::Result<&str, ControlError> {
    args.get("operation")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ControlError::invalid("`operation` is required"))
}

fn text<'a>(args: &'a Value, name: &str) -> std::result::Result<&'a str, ControlError> {
    args.get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ControlError::invalid(format!("`{name}` is required")))
}

fn optional_text<'a>(
    args: &'a Value,
    name: &str,
) -> std::result::Result<Option<&'a str>, ControlError> {
    match args.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.trim()).filter(|v| !v.is_empty())),
        Some(_) => Err(ControlError::invalid(format!("`{name}` must be a string"))),
    }
}

fn agent(args: &Value) -> std::result::Result<AgentId, ControlError> {
    let raw = text(args, "agent")?;
    AgentId::from_str(raw).ok_or_else(|| ControlError::invalid(format!("unknown agent `{raw}`")))
}

fn settings(store: &Store, args: &Value) -> ControlResult {
    if args
        .get("section")
        .and_then(Value::as_str)
        .unwrap_or("compression")
        != "compression"
    {
        return Err(ControlError::invalid(
            "only the `compression` settings section is supported",
        ));
    }
    match operation(args)? {
        "get" => Ok(crate::services::compression_settings::public_settings(store)),
        "update" => {
            let data = args.get("data");
            let reset_defaults = args.get("reset_defaults");
            crate::services::compression_settings::update_settings(store, data, reset_defaults)
                .map_err(|error| {
                    let message = error.to_string();
                    if message.contains("API keys cannot be changed") {
                        ControlError::not_allowed(message)
                    } else {
                        ControlError::invalid(message)
                    }
                })?;
            Ok(json!({
                "section": "compression",
                "settings": crate::services::compression_settings::public_settings(store),
                "restart_required": true
            }))
        }
        other => Err(ControlError::invalid(format!(
            "unknown settings operation `{other}`"
        ))),
    }
}

fn session_json(store: &Store, session: &crate::models::SessionMeta) -> Value {
    let mut value = serde_json::to_value(session).unwrap_or(Value::Null);
    if let Some(map) = value.as_object_mut() {
        map.insert(
            "tags".into(),
            json!(store.session_tags(&session.key).unwrap_or_default()),
        );
    }
    value
}

fn sessions(store: &Store, adapters: &[Box<dyn AgentAdapter>], args: &Value) -> ControlResult {
    match operation(args)? {
        "list" => {
            let limit = args
                .get("limit")
                .and_then(Value::as_i64)
                .unwrap_or(20)
                .clamp(1, 200);
            let (items, total) = store
                .list_sessions(&SessionFilter {
                    limit,
                    roots_only: false,
                    ..Default::default()
                })
                .map_err(ControlError::internal)?;
            Ok(
                json!({ "total": total, "sessions": items.iter().map(|s| session_json(store, s)).collect::<Vec<_>>() }),
            )
        }
        "get" => {
            let key = text(args, "key")?;
            let meta = store
                .get_session(key)
                .map_err(ControlError::internal)?
                .ok_or_else(|| ControlError::not_found(format!("session `{key}` was not found")))?;
            let adapter = adapter_for(adapters, meta.agent, &meta.file_path)
                .ok_or_else(|| ControlError::not_found("no adapter can read this session"))?;
            let transcript = adapter
                .parse_transcript(&crate::models::SessionFileRef::from_meta(&meta))
                .map_err(ControlError::internal)?;
            let page = render_compact(
                &transcript.mainline,
                &CompactOptions {
                    max_messages: 10_000,
                    max_chars: 10_000_000,
                    max_message_chars: 1_000_000,
                    include_tools: true,
                    include_thinking: true,
                    ..Default::default()
                },
            );
            Ok(
                json!({ "session": session_json(store, &meta), "markdown": page.text, "unknown_line_count": transcript.unknown_line_count }),
            )
        }
        "search" => {
            let query = text(args, "query")?;
            let limit = args
                .get("limit")
                .and_then(Value::as_i64)
                .unwrap_or(20)
                .clamp(1, 100);
            let (hits, degraded) = store
                .search(query, &[], None, limit)
                .map_err(ControlError::internal)?;
            Ok(
                json!({ "degraded": degraded, "hits": hits.into_iter().map(|h| json!({"session": session_json(store, &h.session), "seq": h.seq, "role": h.role, "snippet": h.snippet, "timestamp": h.timestamp})).collect::<Vec<_>>() }),
            )
        }
        "list_projects" => {
            let projects = store.list_projects(false).map_err(ControlError::internal)?;
            Ok(
                json!({ "projects": projects.into_iter().map(|p| json!({"path": p.path, "name": p.name, "session_count": p.session_count, "last_active": p.last_active})).collect::<Vec<_>>() }),
            )
        }
        "update_metadata" => {
            let key = text(args, "key")?;
            if store
                .get_session(key)
                .map_err(ControlError::internal)?
                .is_none()
            {
                return Err(ControlError::not_found(format!(
                    "session `{key}` was not found"
                )));
            }
            let favorite = args
                .get("favorite")
                .map(|v| {
                    v.as_bool()
                        .ok_or_else(|| ControlError::invalid("`favorite` must be a boolean"))
                })
                .transpose()?;
            let pinned = args
                .get("pinned")
                .map(|v| {
                    v.as_bool()
                        .ok_or_else(|| ControlError::invalid("`pinned` must be a boolean"))
                })
                .transpose()?;
            store
                .set_user_data(key, favorite, pinned)
                .map_err(ControlError::internal)?;
            for name in ["add_tags", "remove_tags"] {
                if let Some(values) = args.get(name) {
                    let values = values.as_array().ok_or_else(|| {
                        ControlError::invalid(format!("`{name}` must be an array"))
                    })?;
                    for tag in values {
                        let tag = tag
                            .as_str()
                            .map(str::trim)
                            .filter(|v| !v.is_empty())
                            .ok_or_else(|| {
                                ControlError::invalid(format!(
                                    "`{name}` entries must be non-empty strings"
                                ))
                            })?;
                        store
                            .set_session_tag(key, tag, name == "add_tags")
                            .map_err(ControlError::internal)?;
                    }
                }
            }
            let session = store
                .get_session(key)
                .map_err(ControlError::internal)?
                .expect("checked session");
            Ok(session_json(store, &session))
        }
        "trash" => {
            let key = text(args, "key")?;
            let inventory = cleanup::inventory(store, adapters).map_err(ControlError::internal)?;
            let candidate = inventory
                .candidates
                .into_iter()
                .find(|c| c.sessions.iter().any(|s| s.key == key))
                .ok_or_else(|| {
                    ControlError::not_allowed(format!("session `{key}` cannot be moved to trash"))
                })?;
            let affected_sessions = candidate
                .sessions
                .iter()
                .map(|s| s.key.clone())
                .collect::<Vec<_>>();
            let mut batch = cleanup::CleanupBatch::new(vec![candidate], crate::db::now_ms());
            cleanup::execute(store, adapters, &mut batch, &AtomicBool::new(false), |_| {})
                .map_err(ControlError::internal)?;
            Ok(json!({ "affected_sessions": affected_sessions, "batch": batch }))
        }
        "cleanup_history" => {
            Ok(json!({ "batches": cleanup::history(store).map_err(ControlError::internal)? }))
        }
        other => Err(ControlError::invalid(format!(
            "unknown sessions operation `{other}`"
        ))),
    }
}

fn relations(store: &Store, args: &Value) -> ControlResult {
    match operation(args)? {
        "list" => {
            let key = text(args, "key")?;
            if store
                .get_session(key)
                .map_err(ControlError::internal)?
                .is_none()
            {
                return Err(ControlError::not_found(format!(
                    "session `{key}` was not found"
                )));
            }
            let (parents, children) = store
                .session_relationships(key)
                .map_err(ControlError::internal)?;
            let convert = |r: crate::db::SessionRelation| json!({"relation": r.relation, "source": r.source, "session": session_json(store, &r.session)});
            Ok(
                json!({ "parents": parents.into_iter().map(convert).collect::<Vec<_>>(), "children": children.into_iter().map(convert).collect::<Vec<_>>() }),
            )
        }
        "create" => {
            let parent = text(args, "parent")?;
            let child = text(args, "child")?;
            let relation = text(args, "relation")?;
            ensure_sessions(store, parent, child)?;
            if let Some(source) = store
                .session_link_source(parent, child, relation)
                .map_err(ControlError::internal)?
            {
                if source != "manual" {
                    return Err(ControlError::not_allowed(
                        "adapter-discovered relationships are read-only",
                    ));
                }
            }
            store
                .set_session_link(parent, child, relation)
                .map_err(|e| ControlError::invalid(e.to_string()))?;
            Ok(json!({"parent": parent, "child": child, "relation": relation, "source": "manual"}))
        }
        "update" => {
            let parent = text(args, "parent")?;
            let child = text(args, "child")?;
            let relation = text(args, "relation")?;
            let new_relation = text(args, "new_relation")?;
            require_manual_link(store, parent, child, relation)?;
            store
                .update_session_link_relation(parent, child, relation, new_relation)
                .map_err(ControlError::internal)?;
            Ok(
                json!({"parent": parent, "child": child, "relation": new_relation, "source": "manual"}),
            )
        }
        "delete" => {
            let parent = text(args, "parent")?;
            let child = text(args, "child")?;
            let relation = text(args, "relation")?;
            require_manual_link(store, parent, child, relation)?;
            store
                .delete_session_link(parent, child, relation)
                .map_err(ControlError::internal)?;
            Ok(json!({"deleted": true}))
        }
        other => Err(ControlError::invalid(format!(
            "unknown relations operation `{other}`"
        ))),
    }
}

fn ensure_sessions(
    store: &Store,
    parent: &str,
    child: &str,
) -> std::result::Result<(), ControlError> {
    if parent == child {
        return Err(ControlError::invalid("a session cannot link to itself"));
    }
    for key in [parent, child] {
        if store
            .get_session(key)
            .map_err(ControlError::internal)?
            .is_none()
        {
            return Err(ControlError::not_found(format!(
                "session `{key}` was not found"
            )));
        }
    }
    Ok(())
}

fn require_manual_link(
    store: &Store,
    parent: &str,
    child: &str,
    relation: &str,
) -> std::result::Result<(), ControlError> {
    match store
        .session_link_source(parent, child, relation)
        .map_err(ControlError::internal)?
    {
        Some(source) if source == "manual" => Ok(()),
        Some(_) => Err(ControlError::not_allowed(
            "adapter-discovered relationships are read-only",
        )),
        None => Err(ControlError::not_found("relationship was not found")),
    }
}

fn data_sources(store: &Store, args: &Value) -> ControlResult {
    let kind = args
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("sessions");
    match operation(args)? {
        "list" => match kind {
            "sessions" => Ok(
                json!({"kind": kind, "custom": store.list_custom_roots().map_err(ControlError::internal)?, "disabled": store.list_disabled_locations().map_err(ControlError::internal)?}),
            ),
            "memories" => {
                let (custom, disabled) = store
                    .memory_source_overrides()
                    .map_err(ControlError::internal)?;
                Ok(
                    json!({"kind": kind, "custom": custom.into_iter().map(|(a,p)| json!({"agent": a.as_str(), "path": p})).collect::<Vec<_>>(), "disabled": disabled.into_iter().map(|(a,s)| json!({"agent": a.as_str(), "source": s})).collect::<Vec<_>>() }),
                )
            }
            _ => Err(ControlError::invalid(
                "`kind` must be `sessions` or `memories`",
            )),
        },
        "add" => {
            let agent = agent(args)?;
            let path = canonical_source_path(text(args, "path")?)?;
            match kind {
                "sessions" => store.add_custom_root(agent.as_str(), &path.to_string_lossy()),
                "memories" => store.add_memory_source(agent.as_str(), &path.to_string_lossy()),
                _ => {
                    return Err(ControlError::invalid(
                        "`kind` must be `sessions` or `memories`",
                    ))
                }
            }
            .map_err(ControlError::internal)?;
            Ok(json!({"agent": agent.as_str(), "path": path, "restart_required": true}))
        }
        "set_enabled" => {
            let agent = agent(args)?;
            let enabled = args
                .get("enabled")
                .and_then(Value::as_bool)
                .ok_or_else(|| ControlError::invalid("`enabled` must be a boolean"))?;
            match kind {
                "sessions" => {
                    store.set_location_enabled(agent.as_str(), text(args, "path")?, enabled)
                }
                "memories" => {
                    store.set_memory_source_enabled(agent.as_str(), text(args, "source")?, enabled)
                }
                _ => {
                    return Err(ControlError::invalid(
                        "`kind` must be `sessions` or `memories`",
                    ))
                }
            }
            .map_err(ControlError::internal)?;
            Ok(json!({"enabled": enabled, "restart_required": true}))
        }
        "remove" => {
            let agent = agent(args)?;
            let path = text(args, "path")?;
            match kind {
                "sessions" => store.remove_custom_root(agent.as_str(), path),
                "memories" => store.remove_memory_source(agent.as_str(), path),
                _ => {
                    return Err(ControlError::invalid(
                        "`kind` must be `sessions` or `memories`",
                    ))
                }
            }
            .map_err(ControlError::internal)?;
            Ok(json!({"removed": true, "restart_required": true}))
        }
        "reset" => {
            match kind {
                "sessions" => store.clear_location_overrides(),
                "memories" => store.clear_memory_source_overrides(),
                _ => {
                    return Err(ControlError::invalid(
                        "`kind` must be `sessions` or `memories`",
                    ))
                }
            }
            .map_err(ControlError::internal)?;
            Ok(json!({"reset": true, "restart_required": true}))
        }
        other => Err(ControlError::invalid(format!(
            "unknown data_sources operation `{other}`"
        ))),
    }
}

fn canonical_source_path(raw: &str) -> std::result::Result<PathBuf, ControlError> {
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err(ControlError::invalid("data source path must be absolute"));
    }
    if !path.exists() {
        return Err(ControlError::not_found(format!(
            "path `{}` does not exist",
            path.display()
        )));
    }
    path.canonicalize().map_err(ControlError::internal)
}

const MEMORY_MARKER: &str = "contextos_memory: true";
const DOCUMENT_MARKER: &str = "contextos_document: true";

fn memories(store: &Store, args: &Value) -> ControlResult {
    match operation(args)? {
        "list" => {
            let docs = store
                .list_memories(&MemoryFilter::default())
                .map_err(ControlError::internal)?;
            Ok(json!({"memories": docs.into_iter().map(memory_json).collect::<Vec<_>>() }))
        }
        "get" => {
            let path = memory_path(store, args)?;
            let body = std::fs::read_to_string(&path).map_err(ControlError::internal)?;
            Ok(
                json!({"path": path, "content": body, "content_hash": content_hash(&body), "owned": body.contains(MEMORY_MARKER)}),
            )
        }
        "create" => {
            let candidate_value = args.get("candidate").unwrap_or(args);
            let candidate: crate::services::compression::MemoryCandidate =
                serde_json::from_value(candidate_value.clone()).map_err(|error| {
                    ControlError::invalid(format!("invalid memory candidate: {error}"))
                })?;
            if candidate.title.trim().is_empty() && candidate.content.trim().is_empty() {
                return Err(ControlError::invalid(
                    "memory candidate needs `title` or `content`",
                ));
            }
            let source_key = optional_text(args, "source_session_key")?;
            let source = source_key
                .map(|key| {
                    store
                        .get_session(key)
                        .map_err(ControlError::internal)?
                        .ok_or_else(|| {
                            ControlError::not_found(format!("session `{key}` was not found"))
                        })
                })
                .transpose()?;
            let dir = contextos_memory_dir();
            std::fs::create_dir_all(&dir).map_err(ControlError::internal)?;
            let path = dir.join(format!(
                "contextos-{}-{}.md",
                crate::db::now_ms(),
                safe_stem(&candidate.title_or_fallback())
            ));
            let body = crate::services::compression::render_memory_candidate_markdown(
                &candidate,
                source.as_ref().map(|meta| meta.title.as_str()),
                source.as_ref().map(|meta| meta.project_path.as_str()),
            );
            write_new(&path, &body)?;
            Ok(json!({"path": path, "content_hash": content_hash(&body), "candidate": candidate}))
        }
        "update" => {
            let path = memory_path(store, args)?;
            let expected = text(args, "content_hash")?;
            let content = text(args, "content")?;
            let old = std::fs::read_to_string(&path).map_err(ControlError::internal)?;
            require_marker(&old, MEMORY_MARKER, "memory")?;
            if content_hash(&old) != expected {
                return Err(ControlError::conflict("memory changed since it was read"));
            }
            atomic_replace(&path, content)?;
            Ok(json!({"path": path, "content_hash": content_hash(content)}))
        }
        "trash" => {
            let path = memory_path(store, args)?;
            let body = std::fs::read_to_string(&path).map_err(ControlError::internal)?;
            require_marker(&body, MEMORY_MARKER, "memory")?;
            crate::services::terminal::trash_paths(&[path.to_string_lossy().into_owned()])
                .map_err(ControlError::internal)?;
            Ok(json!({"trashed": true, "path": path}))
        }
        other => Err(ControlError::invalid(format!(
            "unknown memories operation `{other}`"
        ))),
    }
}

fn memory_json(doc: crate::models::MemoryDoc) -> Value {
    json!({"key": doc.key, "agent": doc.agent.as_str(), "host": doc.host, "scope": doc.scope.as_str(), "project_path": doc.project_path, "project_name": doc.project_name, "session_key": doc.session_key, "path": doc.path, "title": doc.title, "updated_at": doc.updated_at, "size_bytes": doc.size_bytes, "source": doc.source, "owned": doc.body.contains(MEMORY_MARKER)})
}

fn memory_path(store: &Store, args: &Value) -> std::result::Result<PathBuf, ControlError> {
    if let Some(path) = optional_text(args, "path")? {
        return Ok(PathBuf::from(path));
    }
    let key = text(args, "key")?;
    let doc = store
        .get_memory(key)
        .map_err(ControlError::internal)?
        .ok_or_else(|| ControlError::not_found(format!("memory `{key}` was not found")))?;
    Ok(PathBuf::from(doc.path))
}

fn contextos_memory_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".codex")
        .join("memories")
}

fn compression(store: &Store, adapters: &[Box<dyn AgentAdapter>], args: &Value) -> ControlResult {
    match operation(args)? {
        "list_turns" => {
            let session_key = text(args, "session_key")?;
            let turns = crate::services::compression::list_turns(store, adapters, session_key)
                .map_err(|error| {
                    let message = format!("{error:#}");
                    if message.contains("was not found") || message.contains("no adapter") {
                        ControlError::not_found(message)
                    } else {
                        ControlError::internal(message)
                    }
                })?;
            Ok(json!({
                "session_key": session_key,
                "turns": turns.into_iter().map(|turn| json!({
                    "number": turn.number,
                    "start_seq": turn.start_seq,
                    "end_seq": turn.end_seq,
                    "message_count": turn.message_count,
                    "chars": turn.chars,
                    "preview": turn.preview
                })).collect::<Vec<_>>()
            }))
        }
        "run" => {
            if args.get("session_keys").is_some() && args.get("session_inputs").is_some() {
                return Err(ControlError::invalid(
                    "use either `session_keys` or `session_inputs`, not both",
                ));
            }
            let inputs = if let Some(values) = args.get("session_inputs") {
                let values = values
                    .as_array()
                    .ok_or_else(|| ControlError::invalid("`session_inputs` must be an array"))?;
                values
                    .iter()
                    .map(|value| {
                        let value = object(value, "session_inputs entry")?;
                        let session_key = value
                            .get("session_key")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|value| !value.is_empty())
                            .ok_or_else(|| {
                                ControlError::invalid(
                                    "each session input needs a non-empty `session_key`",
                                )
                            })?
                            .to_string();
                        let turn_numbers = value
                            .get("turn_numbers")
                            .map(|turns| {
                                let turns = turns.as_array().ok_or_else(|| {
                                    ControlError::invalid("`turn_numbers` must be an array")
                                })?;
                                turns
                                    .iter()
                                    .map(|number| {
                                        number
                                            .as_u64()
                                            .and_then(|number| usize::try_from(number).ok())
                                            .filter(|number| *number > 0)
                                            .ok_or_else(|| {
                                                ControlError::invalid(
                                                    "turn numbers must be positive integers",
                                                )
                                            })
                                    })
                                    .collect::<std::result::Result<Vec<_>, _>>()
                            })
                            .transpose()?;
                        Ok(crate::services::compression::SessionInput {
                            session_key,
                            turn_numbers,
                        })
                    })
                    .collect::<std::result::Result<Vec<_>, ControlError>>()?
            } else {
                let keys = args
                    .get("session_keys")
                    .and_then(Value::as_array)
                    .ok_or_else(|| {
                        ControlError::invalid("`session_keys` or `session_inputs` must be an array")
                    })?;
                keys.iter()
                    .map(|value| {
                        value
                            .as_str()
                            .map(|session_key| crate::services::compression::SessionInput {
                                session_key: session_key.to_string(),
                                turn_numbers: None,
                            })
                            .ok_or_else(|| {
                                ControlError::invalid("`session_keys` entries must be strings")
                            })
                    })
                    .collect::<std::result::Result<Vec<_>, _>>()?
            };
            if inputs.is_empty() {
                return Err(ControlError::invalid("compression input must not be empty"));
            }
            let sources = inputs
                .iter()
                .map(|input| input.session_key.clone())
                .collect::<Vec<_>>();
            let output = PathBuf::from(text(args, "output")?);
            let overwrite = args
                .get("overwrite")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if output.exists() && !overwrite {
                return Err(ControlError::conflict(
                    "output already exists; pass `overwrite: true` to replace it",
                ));
            }
            let result = crate::services::compression::run_inputs(
                store,
                adapters,
                &inputs,
                &crate::services::compression::RunOverrides {
                    jev_enabled: args
                        .get("jev_enabled")
                        .map(|value| {
                            value.as_bool().ok_or_else(|| {
                                ControlError::invalid("`jev_enabled` must be a boolean")
                            })
                        })
                        .transpose()?,
                    llm_enabled: args
                        .get("llm_enabled")
                        .map(|value| {
                            value.as_bool().ok_or_else(|| {
                                ControlError::invalid("`llm_enabled` must be a boolean")
                            })
                        })
                        .transpose()?,
                    generate_memory_candidates: args
                        .get("generate_memory_candidates")
                        .map(|value| {
                            value.as_bool().ok_or_else(|| {
                                ControlError::invalid(
                                    "`generate_memory_candidates` must be a boolean",
                                )
                            })
                        })
                        .transpose()?
                        .unwrap_or(false),
                },
            )
            .map_err(|error| {
                use crate::services::compression::CompressionErrorKind;
                let code = match error.kind {
                    CompressionErrorKind::InvalidRequest => "invalid_request",
                    CompressionErrorKind::NotFound => "not_found",
                    CompressionErrorKind::Provider => "provider_error",
                    CompressionErrorKind::Internal => "internal_error",
                };
                ControlError::new(code, error.message).with_details(error.diagnostic)
            })?;
            let content = format!("---\n{DOCUMENT_MARKER}\ncontextos_sources: {}\ncontextos_mode: {}\ncontextos_settings: {}\n---\n\n{}", sources.join(","), result.mode, crate::services::compression_settings::public_settings(store), result.markdown);
            if output.exists() {
                atomic_replace(&output, &content)?;
            } else {
                write_new(&output, &content)?;
            }
            Ok(
                json!({"path": output, "content_hash": content_hash(&content), "mode": result.mode, "session_keys": sources, "stats": result.stats, "memory_candidates": result.memory_candidates}),
            )
        }
        "get_document" => document_get(Path::new(text(args, "path")?)),
        "update_document" => {
            let path = PathBuf::from(text(args, "path")?);
            let expected = text(args, "content_hash")?;
            let content = text(args, "content")?;
            let old = std::fs::read_to_string(&path).map_err(ControlError::internal)?;
            require_marker(&old, DOCUMENT_MARKER, "document")?;
            if content_hash(&old) != expected {
                return Err(ControlError::conflict("document changed since it was read"));
            }
            require_marker(content, DOCUMENT_MARKER, "document")?;
            atomic_replace(&path, content)?;
            Ok(json!({"path": path, "content_hash": content_hash(content)}))
        }
        "trash_document" => {
            let path = PathBuf::from(text(args, "path")?);
            let old = std::fs::read_to_string(&path).map_err(ControlError::internal)?;
            require_marker(&old, DOCUMENT_MARKER, "document")?;
            crate::services::terminal::trash_paths(&[path.to_string_lossy().into_owned()])
                .map_err(ControlError::internal)?;
            Ok(json!({"trashed": true, "path": path}))
        }
        other => Err(ControlError::invalid(format!(
            "unknown compression operation `{other}`"
        ))),
    }
}

fn document_get(path: &Path) -> ControlResult {
    let content = std::fs::read_to_string(path).map_err(ControlError::internal)?;
    require_marker(&content, DOCUMENT_MARKER, "document")?;
    Ok(json!({"path": path, "content": content, "content_hash": content_hash(&content)}))
}

fn require_marker(
    content: &str,
    marker: &str,
    kind: &str,
) -> std::result::Result<(), ControlError> {
    if content.lines().take(12).any(|line| line.trim() == marker) {
        Ok(())
    } else {
        Err(ControlError::not_allowed(format!(
            "this {kind} is not owned by ContextOS"
        )))
    }
}

fn safe_stem(raw: &str) -> String {
    let value: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let value = value.trim_matches('-');
    if value.is_empty() {
        "memory".into()
    } else {
        value.chars().take(48).collect()
    }
}

fn content_hash(content: &str) -> String {
    format!("{:x}", Sha256::digest(content.as_bytes()))
}

fn write_new(path: &Path, content: &str) -> std::result::Result<(), ControlError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(ControlError::internal)?;
    }
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .and_then(|mut f| std::io::Write::write_all(&mut f, content.as_bytes()))
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                ControlError::conflict(format!("{} already exists", path.display()))
            } else {
                ControlError::new("io_error", e.to_string())
            }
        })
}

fn atomic_replace(path: &Path, content: &str) -> std::result::Result<(), ControlError> {
    let parent = path
        .parent()
        .context("path has no parent")
        .map_err(ControlError::internal)?;
    let tmp = parent.join(format!(".contextos-{}.tmp", crate::db::now_ms()));
    std::fs::write(&tmp, content).map_err(|e| ControlError::new("io_error", e.to_string()))?;
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };

        let from = tmp
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let to = path
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let replaced = unsafe {
            MoveFileExW(
                from.as_ptr(),
                to.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if replaced == 0 {
            let error = std::io::Error::last_os_error();
            let _ = std::fs::remove_file(&tmp);
            return Err(ControlError::new("io_error", error.to_string()));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        std::fs::rename(&tmp, path).map_err(|e| ControlError::new("io_error", e.to_string()))
    }
}
