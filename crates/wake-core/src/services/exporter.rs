use crate::adapters::AgentAdapter;
use crate::models::*;
use crate::services::compression_settings::MechanicalRetentionMode;
use chrono::{Local, TimeZone};

/// 本地时区 `YYYY-MM-DD HH:MM:SS`;0/None 为空串(导出与 wake-mcp 共用)
pub fn fmt_time(ts: Option<i64>) -> String {
    match ts {
        Some(t) if t > 0 => Local
            .timestamp_millis_opt(t)
            .single()
            .map(|d| d.format("%Y-%m-%d %H:%M:%S").to_string())
            .unwrap_or_default(),
        _ => String::new(),
    }
}

pub fn fmt_tokens(n: Option<i64>) -> String {
    match n {
        None | Some(0) => "-".to_string(),
        Some(n) if n >= 1_000_000_000 => format!("{:.1}B", n as f64 / 1e9),
        Some(n) if n >= 1_000_000 => format!("{:.1}M", n as f64 / 1e6),
        Some(n) if n >= 1_000 => format!("{:.1}K", n as f64 / 1e3),
        Some(n) => n.to_string(),
    }
}

fn role_label(role: Role) -> String {
    let emoji = match role {
        Role::User => "👤",
        Role::Assistant => "🤖",
        Role::System => "⚙️",
    };
    format!("{emoji} {}", role.title())
}

fn human_readable_assistant_body(text: &str) -> String {
    let mut lines = Vec::new();
    let mut in_patch = false;
    let mut in_internal_fence = false;
    let has_patch_trace = text.contains("*** End Patch")
        || text.contains("diff --git")
        || text.contains("apply_patch verification failed")
        || text.contains("tools.apply_patch(");

    for line in text.lines() {
        let trimmed = line.trim();

        if in_patch {
            if trimmed.contains("*** End Patch") {
                in_patch = false;
            }
            continue;
        }
        if trimmed.contains("*** Begin Patch") || trimmed.starts_with("diff --git ") {
            in_patch = true;
            continue;
        }
        if has_patch_trace
            && (trimmed.starts_with('+')
                || trimmed.starts_with('-')
                || trimmed == "));"
                || trimmed.starts_with("\\n\\n"))
        {
            continue;
        }

        if in_internal_fence {
            if trimmed.starts_with("```") {
                in_internal_fence = false;
            }
            continue;
        }
        if trimmed.starts_with("```")
            && (trimmed.contains("apply_patch")
                || trimmed.contains("diff")
                || trimmed.contains("patch"))
        {
            in_internal_fence = true;
            continue;
        }

        let internal_trace = trimmed.contains("text(await tools.apply_patch")
            || trimmed.contains("tools.apply_patch(")
            || trimmed.contains("apply_patch verification failed")
            || trimmed.contains("*** End Patch")
            || trimmed.starts_with("Script completed")
            || trimmed.starts_with("Script failed")
            || trimmed.starts_with("Script error:")
            || (has_patch_trace
                && (trimmed == "Output:" || trimmed == "<details>" || trimmed == "</details>"));
        if internal_trace || trimmed.starts_with("@@") {
            continue;
        }

        lines.push(line);
    }

    lines.join("\n").trim().to_string()
}

fn render_message(
    m: &TranscriptMessage,
    out: &mut String,
    retention_mode: MechanicalRetentionMode,
    tool_mode: MechanicalRetentionMode,
    allow_jev_delete_assistant_body: bool,
    allow_jev_delete_user_messages: bool,
    jev_candidate_min_chars: usize,
) {
    if retention_mode != MechanicalRetentionMode::FullMechanical
        && m.role == Role::System
        && m.kind != MessageKind::CompactSummary
    {
        return;
    }
    if m.kind == MessageKind::CompactSummary {
        let summary_text = if retention_mode != MechanicalRetentionMode::FullMechanical
            && m.role == Role::Assistant
        {
            human_readable_assistant_body(&m.text)
        } else {
            m.text.clone()
        };
        out.push_str(&format!(
            "### {}{}\n\n",
            role_label(m.role),
            m.timestamp
                .map(|t| format!(" · {}", fmt_time(Some(t))))
                .unwrap_or_default()
        ));
        if !summary_text.is_empty() {
            out.push_str(&format!("> {}\n\n", summary_text));
        }
        return;
    }
    let cleaned_text = if retention_mode != MechanicalRetentionMode::FullMechanical
        && m.role == Role::Assistant
        && m.images.is_empty()
    {
        Some(human_readable_assistant_body(&m.text))
    } else {
        None
    };
    let visible_text = cleaned_text.as_deref().unwrap_or(&m.text);
    let body_candidate_role = match m.role {
        Role::Assistant if allow_jev_delete_assistant_body => Some("assistant"),
        Role::User if allow_jev_delete_user_messages => Some("user"),
        _ => None,
    };
    let body_candidate = m.images.is_empty()
        && jev_candidate_min_chars > 0
        && visible_text.chars().count() >= jev_candidate_min_chars
        && body_candidate_role.is_some();
    if visible_text.is_empty()
        && m.images.is_empty()
        && tool_mode == MechanicalRetentionMode::BodyOnly
    {
        return;
    }
    let timestamp = m
        .timestamp
        .map(|t| format!(" · {}", fmt_time(Some(t))))
        .unwrap_or_default();
    if !body_candidate {
        out.push_str(&format!("### {}{}\n\n", role_label(m.role), timestamp));
    }
    if retention_mode == MechanicalRetentionMode::FullMechanical {
        if let Some(th) = &m.thinking {
            out.push_str(&format!(
                "<details><summary>🧠 Thinking</summary>\n\n{th}\n\n</details>\n\n"
            ));
        }
    }
    let mut cursor = 0usize;
    for image in &m.images {
        let mut offset = image.text_offset.min(m.text.len());
        while offset > cursor && !m.text.is_char_boundary(offset) {
            offset -= 1;
        }
        offset = offset.max(cursor);
        if offset > cursor {
            out.push_str(&m.text[cursor..offset]);
            out.push_str("\n\n");
        }
        out.push_str(&format!(
            "> 🖼 Image attachment · {} · {} bytes\n\n",
            image.media_type,
            image.bytes.len()
        ));
        cursor = offset;
    }
    if cursor < visible_text.len() {
        let body = &visible_text[cursor..];
        if body_candidate {
            let role = body_candidate_role.unwrap_or("assistant");
            out.push_str(&format!(
                "<details><summary>jev-body-candidate:{role}{timestamp}</summary>\n\nBody:\n\n{body}\n\n</details>\n\n"
            ));
        } else {
            out.push_str(body);
            out.push_str("\n\n");
        }
    }
    match tool_mode {
        MechanicalRetentionMode::FullMechanical => {
            for tc in &m.tool_calls {
                out.push_str(&format!(
                    "<details><summary>🔧 {} — {}{}</summary>\n\n",
                    tc.name,
                    tc.input_preview.replace('<', "&lt;"),
                    if tc.is_error { " · source-error" } else { "" }
                ));
                if let Some(input) = &tc.input {
                    out.push_str(&format!("Input:\n\n```\n{input}\n```\n\n"));
                }
                if let Some(output) = &tc.output {
                    out.push_str(&format!("Output:\n\n```\n{output}\n```\n\n"));
                }
                out.push_str("</details>\n\n");
            }
        }
        MechanicalRetentionMode::BodyOnly => {}
        MechanicalRetentionMode::BodyWithStructure => {
            for tc in &m.tool_calls {
                out.push_str(&format!(
                    "<details><summary>🔧 {} — {}{}</summary>\n\n",
                    tc.name,
                    tc.input_preview.replace('<', "&lt;"),
                    if tc.is_error { " · source-error" } else { "" }
                ));
                let output_summary = match &tc.output {
                    Some(output) => format!("存在，{} 字符", output.chars().count()),
                    None => "无".into(),
                };
                out.push_str(&format!(
                    "结构摘要：Input 已省略；Output {}；源记录错误标记：{}。\n\n</details>\n\n",
                    output_summary,
                    if tc.is_error { "是" } else { "否" }
                ));
            }
        }
    }
}

/// Render complete transcript messages without session metadata. This is used when a caller
/// needs to preserve message boundaries while composing a larger export in blocks.
pub fn messages_to_markdown(messages: &[TranscriptMessage]) -> String {
    messages_to_markdown_with_retention(messages, MechanicalRetentionMode::FullMechanical)
}

pub fn messages_to_markdown_with_retention(
    messages: &[TranscriptMessage],
    retention_mode: MechanicalRetentionMode,
) -> String {
    messages_to_markdown_with_modes(messages, retention_mode, retention_mode)
}

/// Export raw tool blocks while applying the selected mode's message-level filters.
/// Compression uses this so Jev can inspect the mechanical candidate before retention.
pub fn messages_to_markdown_for_compression(
    messages: &[TranscriptMessage],
    retention_mode: MechanicalRetentionMode,
    allow_jev_delete_assistant_body: bool,
    allow_jev_delete_user_messages: bool,
    jev_candidate_min_chars: usize,
) -> String {
    let mut out = String::new();
    for message in messages {
        if message.kind != MessageKind::Meta {
            render_message(
                message,
                &mut out,
                retention_mode,
                MechanicalRetentionMode::FullMechanical,
                allow_jev_delete_assistant_body,
                allow_jev_delete_user_messages,
                jev_candidate_min_chars,
            );
        }
    }
    out
}

fn messages_to_markdown_with_modes(
    messages: &[TranscriptMessage],
    retention_mode: MechanicalRetentionMode,
    tool_mode: MechanicalRetentionMode,
) -> String {
    let mut out = String::new();
    for message in messages {
        if message.kind != MessageKind::Meta {
            render_message(
                message,
                &mut out,
                retention_mode,
                tool_mode,
                false,
                false,
                usize::MAX,
            );
        }
    }
    out
}

pub fn to_markdown(
    meta: &SessionMeta,
    messages: &[TranscriptMessage],
    sidechains: &[(SidechainInfo, Vec<TranscriptMessage>)],
) -> String {
    let mut out = String::new();
    out.push_str(&format!("# {}\n\n", meta.title));
    out.push_str(&format!(
        "> **Agent**: {} · **Project**: {}{} · **Time**: {} – {} · **Messages**: {} · **Tokens**: {}\n\n---\n\n",
        meta.agent.display_name(),
        if meta.project_path.is_empty() { "(unknown)" } else { &meta.project_path },
        meta.git_branch.as_deref().map(|b| format!("({b})")).unwrap_or_default(),
        fmt_time(Some(meta.created_at)),
        fmt_time(Some(meta.updated_at)),
        meta.message_count,
        fmt_tokens(meta.tokens_used),
    ));
    out.push_str(&messages_to_markdown(messages));
    for (sc, msgs) in sidechains {
        if msgs.is_empty() {
            continue;
        }
        let label = sc.label();
        out.push_str(&format!(
            "---\n\n## ⑂ Subagent: {}\n\n",
            if label.is_empty() { &sc.id } else { &label }
        ));
        out.push_str(&messages_to_markdown(msgs));
    }
    out
}

pub fn to_json(
    meta: &SessionMeta,
    messages: &[TranscriptMessage],
    sidechains: &[(SidechainInfo, Vec<TranscriptMessage>)],
) -> String {
    let sc_json: Vec<serde_json::Value> = sidechains
        .iter()
        .map(|(sc, msgs)| {
            serde_json::json!({
                "id": sc.id, "agentType": sc.agent_type, "description": sc.description,
                "messages": msgs,
            })
        })
        .collect();
    serde_json::to_string_pretty(&serde_json::json!({
        "exportedAt": chrono::Utc::now().to_rfc3339(),
        "exportedBy": "wake",
        "session": meta,
        "messages": messages,
        "sidechains": sc_json,
    }))
    .unwrap_or_default()
}

/// 导出默认文件名:agent-标题-日期.ext
pub fn default_file_name(meta: &SessionMeta, ext: &str) -> String {
    let title: String = meta
        .title
        .chars()
        .filter(|c| !r#"/\:*?"<>|"#.contains(*c))
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(40)
        .collect();
    let date = Local
        .timestamp_millis_opt(if meta.updated_at > 0 {
            meta.updated_at
        } else {
            crate::db::now_ms()
        })
        .single()
        .map(|d| d.format("%Y%m%d").to_string())
        .unwrap_or_default();
    format!(
        "{}-{}-{}.{ext}",
        meta.agent.as_str(),
        if title.is_empty() { "session" } else { &title },
        date
    )
}

/// 一站式导出:按 meta 解析主线与全部子会话,渲染成 Markdown。错误原样上抛,UI 拼进通知
pub fn render_markdown(adapter: &dyn AgentAdapter, meta: &SessionMeta) -> anyhow::Result<String> {
    // from_meta 对虚拟路径(SQLite 型)自动回退,导出不依赖真实文件存在
    let r = SessionFileRef::from_meta(meta);
    let t = adapter.parse_transcript(&r)?;
    let sidechains: Vec<(SidechainInfo, Vec<TranscriptMessage>)> = t
        .sidechains
        .iter()
        .map(|sc| {
            let msgs = adapter.load_sidechain(&r, &sc.id).unwrap_or_default();
            (sc.clone(), msgs)
        })
        .collect();
    Ok(to_markdown(&t.meta, &t.mainline, &sidechains))
}

/// Export the human conversation while preserving the same session and sidechain boundaries
/// as the full Markdown export. Thinking can be included explicitly; tool details remain hidden.
pub fn render_conversation_markdown(
    adapter: &dyn AgentAdapter,
    meta: &SessionMeta,
    include_thinking: bool,
) -> anyhow::Result<String> {
    let r = SessionFileRef::from_meta(meta);
    let t = adapter.parse_transcript(&r)?;
    let sidechains: Vec<(SidechainInfo, Vec<TranscriptMessage>)> = t
        .sidechains
        .iter()
        .map(|sc| {
            let msgs = adapter.load_sidechain(&r, &sc.id).unwrap_or_default();
            (sc.clone(), msgs)
        })
        .collect();
    let retention = if include_thinking {
        MechanicalRetentionMode::FullMechanical
    } else {
        MechanicalRetentionMode::BodyOnly
    };
    let mut out = String::new();
    out.push_str(&format!("# {}\n\n", t.meta.title));
    out.push_str(&format!(
        "> **Agent**: {} · **Project**: {}{} · **Time**: {} – {} · **Messages**: {} · **Tokens**: {}\n\n---\n\n",
        t.meta.agent.display_name(),
        if t.meta.project_path.is_empty() { "(unknown)" } else { &t.meta.project_path },
        t.meta.git_branch.as_deref().map(|b| format!("({b})")).unwrap_or_default(),
        fmt_time(Some(t.meta.created_at)),
        fmt_time(Some(t.meta.updated_at)),
        t.meta.message_count,
        fmt_tokens(t.meta.tokens_used),
    ));
    out.push_str(&messages_to_markdown_with_modes(
        &t.mainline,
        retention,
        MechanicalRetentionMode::BodyOnly,
    ));
    for (sc, msgs) in sidechains {
        if msgs.is_empty() {
            continue;
        }
        let label = sc.label();
        out.push_str(&format!(
            "---\n\n## ⑂ Subagent: {}\n\n",
            if label.is_empty() { &sc.id } else { &label }
        ));
        out.push_str(&messages_to_markdown_with_modes(
            &msgs,
            retention,
            MechanicalRetentionMode::BodyOnly,
        ));
    }
    Ok(out)
}

/// Export only file-changing tool calls as a compact review document.
/// The source transcript remains authoritative; this view is intentionally best-effort and
/// skips change-like calls whose structured input does not identify a file.
pub fn render_changed_files_markdown(
    adapter: &dyn AgentAdapter,
    meta: &SessionMeta,
) -> anyhow::Result<String> {
    let r = SessionFileRef::from_meta(meta);
    let t = adapter.parse_transcript(&r)?;
    let mut entries: Vec<(String, String)> = Vec::new();
    let mut collect = |messages: &[TranscriptMessage]| {
        for message in messages {
            for tool in &message.tool_calls {
                let name = tool.name.to_ascii_lowercase();
                let input = tool.input.as_deref().unwrap_or_default();
                let output = tool.output.as_deref().unwrap_or_default();
                let is_change = name.contains("edit")
                    || name.contains("write")
                    || name.contains("patch")
                    || input.contains("*** Begin Patch")
                    || input.contains("diff --git")
                    || output.contains("*** Begin Patch")
                    || output.contains("diff --git");
                if !is_change {
                    continue;
                }
                let parsed = serde_json::from_str::<serde_json::Value>(input).ok();
                let path = parsed
                    .as_ref()
                    .and_then(find_file_path)
                    .or_else(|| find_path_line(input));
                let Some(path) = path else { continue };
                let content = parsed
                    .as_ref()
                    .and_then(find_change_content)
                    .unwrap_or_else(|| {
                        if input.contains("*** Begin Patch") || input.contains("diff --git") {
                            input.to_string()
                        } else if !output.trim().is_empty() {
                            output.to_string()
                        } else {
                            input.to_string()
                        }
                    });
                entries.push((path, content));
            }
        }
    };
    collect(&t.mainline);
    for sidechain in &t.sidechains {
        let messages = adapter
            .load_sidechain(&r, &sidechain.id)
            .unwrap_or_default();
        collect(&messages);
    }

    let mut out = format!("# {}\n\n", t.meta.title);
    if entries.is_empty() {
        out.push_str("未识别到带文件路径的改动工具调用。\n");
        return Ok(out);
    }
    let mut seen = std::collections::HashSet::new();
    for (path, content) in entries {
        if !seen.insert((path.clone(), content.clone())) {
            continue;
        }
        out.push_str(&format!("## {path}\n\n```\n{content}\n```\n\n"));
    }
    Ok(out)
}

fn find_file_path(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::Object(map) => {
            for key in ["file_path", "filepath", "path", "file", "filename"] {
                if let Some(path) = map.get(key).and_then(serde_json::Value::as_str) {
                    if !path.trim().is_empty() {
                        return Some(path.to_string());
                    }
                }
            }
            map.values().find_map(find_file_path)
        }
        serde_json::Value::Array(items) => items.iter().find_map(find_file_path),
        _ => None,
    }
}

fn find_change_content(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::Object(map) => {
            for key in ["patch", "new_string", "content", "contents", "text"] {
                if let Some(content) = map.get(key).and_then(serde_json::Value::as_str) {
                    if !content.trim().is_empty() {
                        return Some(content.to_string());
                    }
                }
            }
            map.values().find_map(find_change_content)
        }
        serde_json::Value::Array(items) => items.iter().find_map(find_change_content),
        _ => None,
    }
}

fn find_path_line(input: &str) -> Option<String> {
    input.lines().find_map(|line| {
        let trimmed = line.trim();
        [
            "*** Update File:",
            "*** Add File:",
            "*** Delete File:",
            "diff --git ",
        ]
        .iter()
        .find_map(|prefix| trimmed.strip_prefix(prefix))
        .map(|path| path.trim().trim_matches('"').to_string())
        .filter(|path| !path.is_empty())
    })
}

// ---------------------------------------------------------------- 精简渲染(wake-mcp)

/// `render_compact` 的参数。默认值按"喂给另一个 agent 当上下文"调:不带工具
/// 输出与 thinking,单条与整页都有字符硬顶,免得一个大会话吃光对方的窗口
#[derive(Debug, Clone)]
pub struct CompactOptions {
    /// 从该 seq 起(含)
    pub from_seq: i64,
    /// 本页最多输出多少条消息(Meta 不计)
    pub max_messages: usize,
    /// 本页正文字符上限(至少给出一条,超出即停并给 next_seq)
    pub max_chars: usize,
    /// 单条消息正文字符上限,超出截断并标注
    pub max_message_chars: usize,
    /// 带工具调用的输入/输出正文(默认只留一行名称加输入预览)
    pub include_tools: bool,
    /// 带 thinking
    pub include_thinking: bool,
}

impl Default for CompactOptions {
    fn default() -> Self {
        Self {
            from_seq: 0,
            max_messages: 60,
            max_chars: 20_000,
            max_message_chars: 4_000,
            include_tools: false,
            include_thinking: false,
        }
    }
}

/// 一页精简转录
#[derive(Debug, Clone)]
pub struct CompactPage {
    pub text: String,
    /// 下一页起点 seq;None = 已到主线末尾
    pub next_seq: Option<i64>,
    /// 本页输出的消息数
    pub rendered: usize,
    /// 本页范围内被跳过的注入上下文(Meta)条数
    pub skipped_meta: usize,
    /// 本页首/末条消息的 seq(rendered = 0 时 None)
    pub seq_range: Option<(i64, i64)>,
}

/// 一条消息最多列出多少条工具调用(pi 系把一整轮助手回复合并成一条,里面可能
/// 有上百次调用);超出的只报条数
const MAX_TOOL_LINES: usize = 40;

/// 省 token 的转录渲染:只出 user/assistant 正文,工具调用折成一行,Meta(注入
/// 上下文)跳过并计数,CompactSummary 保留为引用块,图片略去;按 seq 分页。
/// `max_message_chars` 是**整条消息**的预算:正文、thinking、工具行与工具
/// 输入输出共用一份——分页对本页首条消息不查总量(保证前进),单条消息自身
/// 必须有界,否则一轮上百次工具调用能撑爆对方上下文
/// 与 `to_markdown`(全量导出)并存,seq 编号同源(`TranscriptMessage::seq`),
/// 搜索命中的 `wake://session/<key>#<seq>` 引用直接对得上这里的 `[seq N]`
pub fn render_compact(messages: &[TranscriptMessage], o: &CompactOptions) -> CompactPage {
    let mut text = String::new();
    let mut rendered = 0usize;
    let mut skipped_meta = 0usize;
    let mut chars = 0usize;
    let mut next_seq = None;
    let mut first_seq = None;
    let mut last_seq = None;
    for m in messages.iter().filter(|m| m.seq >= o.from_seq) {
        if m.kind == MessageKind::Meta {
            skipped_meta += 1;
            continue;
        }
        let block = compact_block(m, o);
        let block_chars = block.chars().count();
        if rendered > 0 && (rendered >= o.max_messages || chars + block_chars > o.max_chars) {
            next_seq = Some(m.seq);
            break;
        }
        text.push_str(&block);
        chars += block_chars;
        rendered += 1;
        first_seq.get_or_insert(m.seq);
        last_seq = Some(m.seq);
    }
    CompactPage {
        text,
        next_seq,
        rendered,
        skipped_meta,
        seq_range: first_seq.zip(last_seq),
    }
}

fn compact_block(m: &TranscriptMessage, o: &CompactOptions) -> String {
    let role = m.role.title();
    let when = m
        .timestamp
        .map(|t| format!(" · {}", fmt_time(Some(t))))
        .unwrap_or_default();
    let mut out = format!("### [seq {}] {role}{when}\n", m.seq);
    let mut budget = o.max_message_chars;
    if m.kind == MessageKind::CompactSummary {
        out.push_str("> [compacted summary] ");
        out.push_str(&spend(&m.text, &mut budget).replace('\n', "\n> "));
        out.push_str("\n\n");
        return out;
    }
    // 正文优先于 thinking 拿预算,输出顺序仍是 thinking 在前
    let body = spend(m.text.trim(), &mut budget);
    let thinking = if o.include_thinking {
        m.thinking
            .as_deref()
            .filter(|t| !t.trim().is_empty())
            .map(|t| spend(t, &mut budget))
    } else {
        None
    };
    if let Some(th) = thinking {
        out.push_str("> [thinking] ");
        out.push_str(&th.replace('\n', "\n> "));
        out.push_str("\n\n");
    }
    if !body.is_empty() {
        out.push_str(&body);
        out.push_str("\n\n");
    } else if m.tool_calls.is_empty() {
        out.push_str("(empty)\n\n");
    }
    if !m.images.is_empty() {
        out.push_str(&format!(
            "({} image attachment{} omitted)\n\n",
            m.images.len(),
            if m.images.len() == 1 { "" } else { "s" }
        ));
    }
    let mut shown = 0usize;
    for tc in &m.tool_calls {
        // input_preview 由 parse_utils::make_preview 生产,已折行并封顶 200 字符
        let status = if tc.is_error { " ✗" } else { "" };
        let line = format!("- 🔧 {}{status}: {}\n", tc.name, tc.input_preview);
        let line_chars = line.chars().count();
        // 首条工具行无论如何给出(读者要知道这条消息动过工具),之后按预算
        if shown >= MAX_TOOL_LINES || (shown > 0 && line_chars > budget) {
            break;
        }
        out.push_str(&line);
        budget = budget.saturating_sub(line_chars);
        shown += 1;
        if o.include_tools && budget > 0 {
            if let Some(input) = tc.input.as_deref().filter(|s| !s.trim().is_empty()) {
                out.push_str(&format!(
                    "  input:\n  ```\n{}\n  ```\n",
                    indent(&spend(input, &mut budget))
                ));
            }
            if let Some(output) = tc.output.as_deref().filter(|s| !s.trim().is_empty()) {
                out.push_str(&format!(
                    "  output:\n  ```\n{}\n  ```\n",
                    indent(&spend(output, &mut budget))
                ));
            }
        }
    }
    let hidden = m.tool_calls.len() - shown;
    if hidden > 0 {
        out.push_str(&format!(
            "- … {hidden} more tool call{} not shown\n",
            if hidden == 1 { "" } else { "s" }
        ));
    }
    if !m.tool_calls.is_empty() {
        out.push('\n');
    }
    out
}

/// 从消息预算里扣着截:返回按剩余预算截断的文本,并把用掉的字符数记账
fn spend(s: &str, budget: &mut usize) -> String {
    let clipped = clip_chars(s, *budget);
    *budget = budget.saturating_sub(clipped.chars().count());
    clipped
}

/// 按字符截断并标注(字节切会切坏 CJK)。字节数 ≤ max 时字符数必 ≤ max,
/// 先按字节放行,免得每条消息都整段数一遍字符
fn clip_chars(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    match s.char_indices().nth(max) {
        Some((ix, _)) => format!("{}… [truncated]", &s[..ix]),
        None => s.to_string(),
    }
}

fn indent(s: &str) -> String {
    s.lines()
        .map(|l| format!("  {l}"))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod compact_tests {
    use super::*;

    fn msg(seq: i64, role: Role, kind: MessageKind, text: &str) -> TranscriptMessage {
        TranscriptMessage {
            seq,
            role,
            kind,
            text: text.to_string(),
            truncated: false,
            tool_calls: Vec::new(),
            thinking: None,
            timestamp: Some(1_754_042_400_000 + seq * 1000),
            model: None,
            images: Vec::new(),
        }
    }

    fn transcript() -> Vec<TranscriptMessage> {
        let mut tool = msg(
            2,
            Role::Assistant,
            MessageKind::Text,
            "Let me edit the file.",
        );
        tool.tool_calls.push(ToolCallView {
            id: "t1".into(),
            name: "Edit".into(),
            input_preview: "src/db.rs".into(),
            input: Some("{\"path\":\"src/db.rs\"}".into()),
            output: Some("ok, 3 lines changed".into()),
            is_error: false,
            sidechain_ref: None,
        });
        tool.thinking = Some("私下想一想".into());
        vec![
            msg(0, Role::User, MessageKind::Text, "帮我实现二维码扫描登录"),
            msg(
                1,
                Role::User,
                MessageKind::Meta,
                "<system-reminder>injected</system-reminder>",
            ),
            tool,
            msg(
                3,
                Role::Assistant,
                MessageKind::Text,
                &"很长的回答。".repeat(50),
            ),
            msg(
                4,
                Role::System,
                MessageKind::CompactSummary,
                "Conversation compacted",
            ),
            msg(5, Role::User, MessageKind::Text, "继续"),
        ]
    }

    #[test]
    fn default_page_skips_meta_and_keeps_tool_names_only() {
        let page = render_compact(&transcript(), &CompactOptions::default());
        assert_eq!(page.rendered, 5);
        assert_eq!(page.skipped_meta, 1);
        assert_eq!(page.next_seq, None);
        assert_eq!(page.seq_range, Some((0, 5)));
        assert!(page.text.contains("### [seq 0] User"));
        assert!(!page.text.contains("injected"));
        assert!(page.text.contains("🔧 Edit: src/db.rs"));
        assert!(!page.text.contains("3 lines changed"), "工具输出默认不带");
        assert!(!page.text.contains("私下想一想"), "thinking 默认不带");
        assert!(page
            .text
            .contains("> [compacted summary] Conversation compacted"));
    }

    #[test]
    fn message_fragment_keeps_full_content_without_a_session_header() {
        let messages = transcript();

        let markdown = messages_to_markdown(&messages[..3]);

        assert!(markdown.contains("### 👤 User"));
        assert!(markdown.contains("帮我实现二维码扫描登录"));
        assert!(markdown.contains("### 🤖 Assistant"));
        assert!(markdown.contains("ok, 3 lines changed"));
        assert!(!markdown.contains("<system-reminder>injected</system-reminder>"));
        assert!(!markdown.starts_with("# "));
        assert!(!markdown.contains("**Agent**:"));
    }

    #[test]
    fn body_candidates_are_only_wrapped_when_the_matching_permission_is_enabled() {
        let messages = vec![msg(
            1,
            Role::User,
            MessageKind::Text,
            &"important user request ".repeat(8),
        )];
        let denied = messages_to_markdown_for_compression(
            &messages,
            MechanicalRetentionMode::BodyOnly,
            false,
            false,
            10,
        );
        let allowed = messages_to_markdown_for_compression(
            &messages,
            MechanicalRetentionMode::BodyOnly,
            false,
            true,
            10,
        );
        assert!(denied.contains("### 👤 User"));
        assert!(!denied.contains("jev-body-candidate"));
        assert!(!allowed.contains("### 👤 User"));
        assert!(allowed.contains("jev-body-candidate:user"));
    }

    #[test]
    fn body_only_filters_patch_and_tool_trace_from_assistant_text() {
        let mut assistant = msg(
            1,
            Role::Assistant,
            MessageKind::Text,
            "先说明修改结果。\n*** Begin Patch\n@@\n- old\n+ new\n*** End Patch\ntext(await tools.apply_patch(patch))\nScript error: patch failed",
        );
        assistant.tool_calls.push(ToolCallView {
            id: "t1".into(),
            name: "apply_patch".into(),
            input_preview: "patch".into(),
            input: Some("patch".into()),
            output: Some("patch failed".into()),
            is_error: true,
            sidechain_ref: None,
        });

        let markdown =
            messages_to_markdown_with_retention(&[assistant], MechanicalRetentionMode::BodyOnly);

        assert!(markdown.contains("先说明修改结果。"));
        assert!(!markdown.contains("Begin Patch"));
        assert!(!markdown.contains("apply_patch"));
        assert!(!markdown.contains("Script error"));
        assert!(!markdown.contains("patch failed"));
    }

    #[test]
    fn body_only_keeps_regular_assistant_code_examples() {
        let assistant = msg(
            1,
            Role::Assistant,
            MessageKind::Text,
            "示例代码：\n```rust\nlet answer = 42;\n```",
        );

        let markdown =
            messages_to_markdown_with_retention(&[assistant], MechanicalRetentionMode::BodyOnly);

        assert!(markdown.contains("示例代码："));
        assert!(markdown.contains("let answer = 42;"));
    }

    #[test]
    fn body_only_drops_assistant_messages_that_are_only_tool_trace() {
        let assistant = msg(
            1,
            Role::Assistant,
            MessageKind::Text,
            "text(await tools.apply_patch(patch))\n*** Begin Patch\n+ change\n*** End Patch",
        );

        let markdown =
            messages_to_markdown_with_retention(&[assistant], MechanicalRetentionMode::BodyOnly);

        assert!(markdown.is_empty());
    }

    #[test]
    fn body_only_filters_escaped_patch_end_and_standalone_script_trace() {
        let assistant = msg(
            1,
            Role::Assistant,
            MessageKind::Text,
            "修改已完成。\n*** Begin Patch\n+ change\n*** End Patch\";\ntext(await tools.apply_patch(patch));\nScript completed\nOutput:",
        );

        let markdown =
            messages_to_markdown_with_retention(&[assistant], MechanicalRetentionMode::BodyOnly);

        assert!(markdown.contains("修改已完成。"));
        assert!(!markdown.contains("End Patch"));
        assert!(!markdown.contains("Script completed"));
        assert!(!markdown.contains("Output:"));
    }

    #[test]
    fn body_only_cleans_compact_assistant_summaries() {
        let assistant = msg(
            1,
            Role::Assistant,
            MessageKind::CompactSummary,
            "已完成修改。\nScript completed\n*** End Patch\";",
        );

        let markdown =
            messages_to_markdown_with_retention(&[assistant], MechanicalRetentionMode::BodyOnly);

        assert!(markdown.contains("已完成修改。"));
        assert!(!markdown.contains("Script completed"));
        assert!(!markdown.contains("End Patch"));
    }

    #[test]
    fn include_flags_add_tool_io_and_thinking() {
        let o = CompactOptions {
            include_tools: true,
            include_thinking: true,
            ..Default::default()
        };
        let page = render_compact(&transcript(), &o);
        assert!(page.text.contains("3 lines changed"));
        assert!(page.text.contains("[thinking] 私下想一想"));
    }

    #[test]
    fn pagination_by_messages_and_chars_hands_back_next_seq() {
        let o = CompactOptions {
            max_messages: 2,
            ..Default::default()
        };
        let page = render_compact(&transcript(), &o);
        assert_eq!(page.rendered, 2);
        assert_eq!(page.next_seq, Some(3), "第三条非 Meta 消息的 seq");
        let o = CompactOptions {
            from_seq: 3,
            max_chars: 1,
            ..Default::default()
        };
        let page = render_compact(&transcript(), &o);
        assert_eq!(page.rendered, 1, "字符上限再小也至少给一条");
        assert_eq!(page.seq_range, Some((3, 3)));
        assert_eq!(page.next_seq, Some(4));
        let o = CompactOptions {
            from_seq: 5,
            ..Default::default()
        };
        let page = render_compact(&transcript(), &o);
        assert_eq!(page.rendered, 1);
        assert_eq!(page.next_seq, None);
    }

    #[test]
    fn tool_calls_share_the_message_budget() {
        let mut m = msg(
            7,
            Role::Assistant,
            MessageKind::Text,
            "Running the whole suite.",
        );
        for i in 0..120 {
            m.tool_calls.push(ToolCallView {
                id: format!("t{i}"),
                name: "Bash".into(),
                input_preview: format!("cargo test --test case_{i:03}"),
                input: Some(format!("cargo test --test case_{i:03}")),
                output: Some("ok. 12 passed; 0 failed\n".repeat(40)),
                is_error: false,
                sidechain_ref: None,
            });
        }
        let o = CompactOptions {
            max_message_chars: 400,
            include_tools: true,
            ..Default::default()
        };
        let page = render_compact(std::slice::from_ref(&m), &o);
        let tool_lines = page.text.matches("🔧").count();
        assert!(
            tool_lines >= 1 && tool_lines < 120,
            "{tool_lines} tool lines"
        );
        assert!(
            page.text.contains("more tool calls not shown"),
            "{}",
            page.text
        );
        assert!(
            page.text.chars().count() < 400 + 300,
            "block must stay near the per-message budget, got {} chars",
            page.text.chars().count()
        );
        // 预算充足时也不超过 MAX_TOOL_LINES 条
        let roomy = CompactOptions {
            max_message_chars: 100_000,
            ..Default::default()
        };
        let page = render_compact(std::slice::from_ref(&m), &roomy);
        assert_eq!(page.text.matches("🔧").count(), MAX_TOOL_LINES);
        assert!(page.text.contains("80 more tool calls not shown"));
    }

    #[test]
    fn long_messages_are_clipped_on_char_boundaries() {
        let o = CompactOptions {
            max_message_chars: 10,
            ..Default::default()
        };
        let page = render_compact(&transcript(), &o);
        assert!(page.text.contains("很长的回答。很长的回… [truncated]"));
    }
}
