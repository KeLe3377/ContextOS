use std::collections::{BTreeSet, HashMap, HashSet};
use std::fmt;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::adapters::{adapter_for, AgentAdapter};
use crate::db::Store;
use crate::models::{SessionFileRef, SessionMeta};
use crate::services::compression_settings::{
    self, JevAction, JevFallback, JevScoreLevel, JevStrategySettings, LlmPromptSettings,
    MechanicalStrategySettings,
};
use crate::services::exporter;

const DETAIL_OPEN: &str = "<details><summary>";
const DETAIL_CLOSE: &str = "</details>";
pub const DEFAULT_LLM_INPUT_LIMIT_CHARS: usize = 1_000_000;

pub const BUILTIN_COMPRESSION_TAGS: [&str; 10] = [
    "development",
    "design",
    "testing",
    "research",
    "refactor",
    "bugfix",
    "product-decision",
    "paused",
    "completed",
    "continue-later",
];

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct MemoryCandidate {
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub target: String,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub trigger: String,
    #[serde(default)]
    pub boundary: String,
    #[serde(default)]
    pub next_action: String,
    #[serde(default)]
    pub related_paths: Vec<String>,
    #[serde(default)]
    pub evidence: String,
    #[serde(default)]
    pub confidence: String,
}

impl MemoryCandidate {
    pub fn kind_label(&self) -> &'static str {
        match self.kind.trim() {
            "decision" => "决定",
            "rule" => "规则",
            "todo" => "未完成",
            "project_fact" => "项目事实",
            "resume_hint" => "恢复提示",
            _ => "记忆",
        }
    }

    pub fn title_or_fallback(&self) -> String {
        let title = self.title.trim();
        if title.is_empty() {
            self.kind_label().to_string()
        } else {
            title.to_string()
        }
    }

    pub fn brief(&self) -> String {
        let value = if self.content.trim().is_empty() {
            &self.next_action
        } else {
            &self.content
        };
        value.trim().chars().take(120).collect()
    }
}

pub fn render_memory_candidate_markdown(
    candidate: &MemoryCandidate,
    source_title: Option<&str>,
    project_path: Option<&str>,
) -> String {
    fn value_or_dash(value: &str) -> &str {
        let value = value.trim();
        if value.is_empty() {
            "-"
        } else {
            value
        }
    }
    fn section(out: &mut String, title: &str, value: &str) {
        let value = value.trim();
        if !value.is_empty() {
            out.push_str(&format!("## {title}\n\n{value}\n\n"));
        }
    }
    let mut out = format!(
        "---\ncontextos_memory: true\ncontextos_kind: {}\ncontextos_scope: {}\n---\n\n# {}\n\n- 类型：{}\n- 范围：{}\n- 置信度：{}\n",
        candidate.kind_label(), value_or_dash(&candidate.scope), candidate.title_or_fallback(),
        candidate.kind_label(), value_or_dash(&candidate.scope), value_or_dash(&candidate.confidence),
    );
    if let Some(title) = source_title.filter(|value| !value.trim().is_empty()) {
        out.push_str(&format!("- 来源会话：{}\n", title.trim()));
    }
    if let Some(project) = project_path.filter(|value| !value.trim().is_empty()) {
        out.push_str(&format!("- 项目：{}\n", project.trim()));
    }
    out.push('\n');
    section(&mut out, "内容", &candidate.content);
    section(&mut out, "原因", &candidate.reason);
    section(&mut out, "触发条件", &candidate.trigger);
    section(&mut out, "边界", &candidate.boundary);
    section(&mut out, "下一步动作", &candidate.next_action);
    if !candidate.related_paths.is_empty() {
        out.push_str("## 相关路径\n\n");
        for path in &candidate.related_paths {
            if !path.trim().is_empty() {
                out.push_str(&format!("- {}\n", path.trim()));
            }
        }
        out.push('\n');
    }
    section(&mut out, "证据", &candidate.evidence);
    out
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompressionErrorKind {
    InvalidRequest,
    NotFound,
    Provider,
    Internal,
}

#[derive(Debug)]
pub struct CompressionError {
    pub kind: CompressionErrorKind,
    pub message: String,
    pub diagnostic: Value,
}

impl CompressionError {
    fn new(
        kind: CompressionErrorKind,
        stage: &str,
        message: impl Into<String>,
        mut diagnostic: Value,
    ) -> Self {
        if let Some(map) = diagnostic.as_object_mut() {
            map.insert("stage".into(), json!(stage));
        }
        Self {
            kind,
            message: message.into(),
            diagnostic,
        }
    }
    fn internal(stage: &str, error: impl fmt::Display) -> Self {
        Self::new(
            CompressionErrorKind::Internal,
            stage,
            error.to_string(),
            json!({}),
        )
    }
}

impl fmt::Display for CompressionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for CompressionError {}

#[derive(Debug, Clone, Default)]
pub struct RunOverrides {
    pub jev_enabled: Option<bool>,
    pub llm_enabled: Option<bool>,
    pub generate_memory_candidates: bool,
}

#[derive(Debug)]
pub struct RunResult {
    pub markdown: String,
    pub mode: &'static str,
    pub memory_candidates: Vec<MemoryCandidate>,
    pub stats: Value,
}

#[derive(Debug, Clone)]
pub struct SessionInput {
    pub session_key: String,
    /// One-based user/Agent conversation turns. `None` means the complete session.
    pub turn_numbers: Option<Vec<usize>>,
}

#[derive(Debug, Clone)]
pub struct TurnInfo {
    pub number: usize,
    pub start_seq: i64,
    pub end_seq: i64,
    pub message_count: usize,
    pub chars: usize,
    pub preview: String,
}

pub fn list_turns(
    store: &Store,
    adapters: &[Box<dyn AgentAdapter>],
    session_key: &str,
) -> Result<Vec<TurnInfo>> {
    let meta = store
        .get_session(session_key)?
        .with_context(|| format!("session `{session_key}` was not found"))?;
    let adapter = adapter_for(adapters, meta.agent, &meta.file_path)
        .with_context(|| format!("no adapter can read session `{session_key}`"))?;
    let transcript = adapter.parse_transcript(&SessionFileRef::from_meta(&meta))?;
    Ok(split_turns(&transcript.mainline)
        .into_iter()
        .enumerate()
        .map(|(index, messages)| {
            let preview = messages
                .iter()
                .find(|message| message.role == crate::models::Role::User)
                .map(|message| {
                    message
                        .text
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .unwrap_or_default();
            TurnInfo {
                number: index + 1,
                start_seq: messages
                    .first()
                    .map(|message| message.seq)
                    .unwrap_or_default(),
                end_seq: messages
                    .last()
                    .map(|message| message.seq)
                    .unwrap_or_default(),
                message_count: messages.len(),
                chars: messages
                    .iter()
                    .map(|message| message.text.chars().count())
                    .sum(),
                preview: preview.chars().take(240).collect(),
            }
        })
        .collect())
}

#[derive(Clone)]
struct RuntimeSettings {
    jev_enabled: bool,
    jev_url: String,
    jev_key: String,
    jev_timeout: u64,
    llm_enabled: bool,
    llm_url: String,
    llm_key: String,
    llm_model: String,
    llm_timeout: u64,
    llm_input_limit: usize,
    single_strategy: String,
    memory_generation_strategy: String,
    multi_strategy: String,
    tag_strategy: String,
    tag_specific_strategies: HashMap<String, String>,
    relation_strategy: String,
    active_provider_id: String,
    active_provider_name: String,
    mechanical: MechanicalStrategySettings,
    jev_strategy: JevStrategySettings,
    llm_prompt: LlmPromptSettings,
}

impl RuntimeSettings {
    fn load(store: &Store, overrides: &RunOverrides) -> Self {
        let settings = compression_settings::load_runtime_settings(store, overrides);
        let active_provider = settings.active_provider().cloned();
        let provider_id = active_provider
            .as_ref()
            .map(|provider| provider.id.clone())
            .unwrap_or_default();
        let provider_name = active_provider
            .as_ref()
            .map(|provider| provider.name.clone())
            .unwrap_or_default();
        let provider_url = active_provider
            .as_ref()
            .map(|provider| provider.api_url.clone())
            .unwrap_or_default();
        let provider_key = active_provider
            .as_ref()
            .map(|provider| provider.api_key.clone())
            .unwrap_or_default();
        let provider_model = active_provider
            .as_ref()
            .map(|provider| provider.model.clone())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "gpt-4.1-mini".into());
        Self {
            jev_enabled: settings.service.jev_enabled,
            jev_url: settings.service.jev_api_url,
            jev_key: settings.service.jev_api_key,
            jev_timeout: settings.service.jev_timeout_secs,
            llm_enabled: settings.service.llm_enabled,
            llm_url: provider_url,
            llm_key: provider_key,
            llm_model: provider_model,
            llm_timeout: settings.service.llm_timeout_secs,
            llm_input_limit: settings.service.llm_input_limit_chars,
            single_strategy: settings.strategy.llm.single_strategy.clone(),
            memory_generation_strategy: settings.strategy.llm.memory_generation_strategy.clone(),
            multi_strategy: settings.strategy.llm.multi_strategy.clone(),
            tag_strategy: settings.strategy.llm.tag_strategy.clone(),
            tag_specific_strategies: settings.strategy.llm.tag_specific_strategies.clone(),
            relation_strategy: settings.strategy.llm.relation_strategy.clone(),
            active_provider_id: provider_id,
            active_provider_name: provider_name,
            mechanical: settings.strategy.mechanical,
            jev_strategy: settings.strategy.jev,
            llm_prompt: settings.strategy.llm,
        }
    }

    fn mode(&self) -> &'static str {
        match (self.jev_enabled, self.llm_enabled) {
            (false, false) => "mechanical",
            (true, false) => "mechanical+jev",
            (false, true) => "mechanical+llm",
            (true, true) => "mechanical+jev+llm",
        }
    }

    fn validate(&self) -> Result<()> {
        if self.jev_enabled && (self.jev_url.trim().is_empty() || self.jev_key.trim().is_empty()) {
            bail!("Jev is enabled but its API URL or key is not configured");
        }
        if self.llm_enabled
            && (self.llm_url.trim().is_empty()
                || self.llm_key.trim().is_empty()
                || self.llm_model.trim().is_empty())
        {
            bail!("LLM is enabled but its API URL, key, or model is not configured");
        }
        let shared = compression_settings::RuntimeCompressionSettings {
            service: compression_settings::CompressionServiceSettings {
                llm_enabled: self.llm_enabled,
                llm_providers: vec![compression_settings::LlmProviderConfig {
                    id: self.active_provider_id.clone(),
                    name: self.active_provider_name.clone(),
                    api_url: self.llm_url.clone(),
                    api_key: self.llm_key.clone(),
                    model: self.llm_model.clone(),
                }],
                active_llm_provider_id: self.active_provider_id.clone(),
                llm_timeout_secs: self.llm_timeout,
                llm_input_limit_chars: self.llm_input_limit,
                jev_enabled: self.jev_enabled,
                jev_api_url: self.jev_url.clone(),
                jev_api_key: self.jev_key.clone(),
                jev_timeout_secs: self.jev_timeout,
            },
            strategy: compression_settings::CompressionStrategySettings {
                mechanical: self.mechanical.clone(),
                jev: self.jev_strategy.clone(),
                llm: self.llm_prompt.clone(),
            },
        };
        shared.validate()?;
        Ok(())
    }
}

pub fn tag_strategy_key(tag: &str) -> String {
    format!("compression_strategy_tag_{}", tag.replace('-', "_"))
}

pub fn default_specific_tag_strategy(tag: &str) -> String {
    match tag {
        "development" => "保留实现路径、关键文件、代码改动、命令、错误和验证结果。",
        "design" => "保留方案比较、取舍理由、用户偏好、界面/交互约束和最终决策。",
        "testing" => "保留复现步骤、预期/实际结果、测试命令、失败输出和通过结论。",
        "research" => "保留调查对象、来源线索、事实结论、不确定点和后续核验方向。",
        "refactor" => "保留重构目标、边界、兼容性约束、受影响模块和验证结果。",
        "bugfix" => "保留问题表现、根因判断、修复位置、回归风险和验证命令。",
        "product-decision" => "保留用户真实偏好、需求变更、放弃的方案、最终产品决策和原因。",
        "paused" => "重点生成恢复上下文：已完成、当前卡点、下一步、不要重复做的事。",
        "completed" => "重点生成阶段总结：最终状态、交付物、验证结果和残余风险。",
        "continue-later" => "重点生成下次接手入口：最近有效状态、待办顺序、必要文件和运行方式。",
        _ => "",
    }
    .to_string()
}

pub fn default_single_strategy() -> String {
    "你是 ContextOS 的会话压缩器。请保真压缩单个 agent 对话。\n保留用户目标、关键决策、代码改动、错误、验证结果、未完成事项。\n不要编造，不要省略会影响接手的信息。输出结构：当前结论、用户目标、关键决策、实施记录、验证结果、未完成事项、恢复提示。".into()
}

pub fn default_memory_generation_strategy() -> String {
    "你是 ContextOS 的会话压缩器。请保真压缩单个 agent 对话，并提取可由用户审核后写入记忆或 AGENT.md 的候选内容。\n\n\
     压缩必须遵守：\n\
     - 保留用户目标、关键决策、代码改动、错误、验证结果、未完成事项、恢复提示。\n\
     - 不要编造，不要把推测写成事实。\n\
     - 如果信息不确定，请标注“不确定”或“需验证”。\n\
     - 不要把临时过程、失败尝试、一次性命令误写成长期规则。\n\
     - Rule 只提取用户明确表达的长期偏好、项目约定、工作方式约束，不能从单次行为过度归纳。\n\n\
     请输出以下 Markdown 结构：当前结论、用户目标、关键决策、实施记录、验证结果、未完成事项、恢复提示、ContextOS 记忆候选。\n\n\
     最后必须追加一个 ```contextos-json fenced code block，内容为 JSON：\n\
     {\"memory_candidates\":[{\"kind\":\"decision | rule | todo | project_fact | resume_hint\",\"title\":\"...\",\"content\":\"...\",\"scope\":\"global | project | session\",\"target\":\"memory | global_agent | project_agent | both | none\",\"reason\":\"...\",\"trigger\":\"...\",\"boundary\":\"...\",\"next_action\":\"...\",\"related_paths\":[\"...\"],\"evidence\":\"...\",\"confidence\":\"high | medium | low\"}]}\n\n\
     字段说明：decision 是明确决定；rule 是以后应遵守的规则；todo 是未完成事项；project_fact 是稳定项目事实；resume_hint 是下次接手上下文。target 只是建议，最终由用户确认。".into()
}

pub fn default_multi_strategy() -> String {
    "你是 ContextOS 的项目脉络压缩器。压缩多个会话时保留各来源；有关联则按实际关系整理，无关联则按普通多会话合并。保留分歧和后续修正，输出面向下一位 agent 的接手指南。".into()
}

pub fn default_tag_strategy() -> String {
    "标签用于调整压缩重点，而不是替代基础策略。只启用当前会话实际拥有的标签专用策略；多个标签同时存在时，按用户意图、恢复可接手性、证据和验证合并。".into()
}

pub fn default_relation_strategy() -> String {
    "起点：说明背景、原始目标和初始约束。\n继续：并入主线，避免重复。\n分支：作为并行探索或备选方案。\n阻塞：单列阻塞原因、影响范围和需要的外部条件。\n解决：关联被解决的问题、解决方式和验证结果。\n相关：作为参考上下文，不强行并入主线。".into()
}

#[derive(Clone)]
struct Detail {
    start: usize,
    end: usize,
    summary: String,
    body: String,
    output: Option<String>,
}

pub fn run(
    store: &Store,
    adapters: &[Box<dyn AgentAdapter>],
    session_keys: &[String],
    overrides: &RunOverrides,
) -> std::result::Result<RunResult, CompressionError> {
    let inputs = session_keys
        .iter()
        .map(|session_key| SessionInput {
            session_key: session_key.clone(),
            turn_numbers: None,
        })
        .collect::<Vec<_>>();
    run_inputs(store, adapters, &inputs, overrides)
}

pub fn run_inputs(
    store: &Store,
    adapters: &[Box<dyn AgentAdapter>],
    inputs: &[SessionInput],
    overrides: &RunOverrides,
) -> std::result::Result<RunResult, CompressionError> {
    let settings = RuntimeSettings::load(store, overrides);
    settings.validate().map_err(|error| {
        CompressionError::new(
            CompressionErrorKind::InvalidRequest,
            "settings",
            error.to_string(),
            json!({}),
        )
    })?;
    let started = Instant::now();
    let mut prepared_turns = Vec::new();
    let mut source_stats = Vec::new();
    let mut metas = Vec::new();
    for input in inputs {
        let key = &input.session_key;
        let meta = store
            .get_session(key)
            .map_err(|error| CompressionError::internal("load_session", error))?
            .ok_or_else(|| {
                CompressionError::new(
                    CompressionErrorKind::NotFound,
                    "load_session",
                    format!("session `{key}` was not found"),
                    json!({"session_key": key}),
                )
            })?;
        let adapter = adapter_for(adapters, meta.agent, &meta.file_path).ok_or_else(|| {
            CompressionError::new(
                CompressionErrorKind::NotFound,
                "load_session",
                format!("no adapter can read session `{key}`"),
                json!({"session_key": key}),
            )
        })?;
        let reference = SessionFileRef::from_meta(&meta);
        let transcript = adapter
            .parse_transcript(&reference)
            .map_err(|error| CompressionError::internal("parse_transcript", error))?;
        let mut all_messages = transcript.mainline;
        if input.turn_numbers.is_none() {
            for sidechain in transcript.sidechains {
                all_messages.extend(
                    adapter
                        .load_sidechain(&reference, &sidechain.id)
                        .map_err(|error| CompressionError::internal("load_sidechain", error))?,
                );
            }
        }
        let turns = split_turns(&all_messages);
        let wanted =
            selected_turn_set(input.turn_numbers.as_deref(), turns.len()).map_err(|error| {
                CompressionError::new(
                    CompressionErrorKind::InvalidRequest,
                    "select_turns",
                    error.to_string(),
                    json!({"session_key": key}),
                )
            })?;
        let mut chars_before = 0usize;
        let mut chars_after = 0usize;
        let mut candidates = 0usize;
        let mut kept = 0usize;
        for (index, messages) in turns.into_iter().enumerate() {
            let number = index + 1;
            if !wanted.contains(&number) {
                continue;
            }
            let raw = exporter::messages_to_markdown(&messages);
            chars_before += raw.chars().count();
            let (mechanical, turn_candidates, turn_kept) = compact_details(&raw, &meta, &settings)
                .map_err(|error| CompressionError::new(
                    CompressionErrorKind::Provider, "jev", error.to_string(),
                    json!({"session_key": key, "turn_number": number, "provider": "Jev", "configured_timeout_secs": settings.jev_timeout})
                ))?;
            chars_after += mechanical.chars().count();
            candidates += turn_candidates;
            kept += turn_kept;
            prepared_turns.push(PreparedTurn {
                session_key: key.clone(),
                session_title: meta.title.clone(),
                number,
                start_seq: messages
                    .first()
                    .map(|message| message.seq)
                    .unwrap_or_default(),
                end_seq: messages
                    .last()
                    .map(|message| message.seq)
                    .unwrap_or_default(),
                markdown: mechanical,
            });
        }
        source_stats.push(json!({
            "session_key": key,
            "chars_before": chars_before,
            "chars_after": chars_after,
            "jev_candidates": candidates,
            "jev_kept_full": kept,
            "turn_numbers": input.turn_numbers
        }));
        metas.push(meta);
    }
    let block_limit = if settings.llm_enabled {
        settings.llm_input_limit
    } else {
        usize::MAX
    };
    let blocks = pack_turns(&prepared_turns, block_limit)?;
    let relation_context = relationship_context(store, &metas)
        .map_err(|error| CompressionError::internal("load_relationships", error))?;
    let mut llm_outputs = Vec::new();
    let markdown = if settings.llm_enabled {
        for (index, block) in blocks.iter().enumerate() {
            llm_outputs.push(call_llm(
                &settings,
                &metas,
                store,
                &block.markdown,
                overrides.generate_memory_candidates,
                &relation_context,
                index + 1,
                blocks.len(),
                &block.turns,
            )?);
        }
        assemble_blocks(&llm_outputs, &blocks)
    } else {
        blocks
            .iter()
            .map(|block| block.markdown.as_str())
            .collect::<Vec<_>>()
            .join("\n\n---\n\n")
    };
    let memory_candidates = if settings.llm_enabled {
        llm_outputs
            .iter()
            .flat_map(|output| parse_memory_candidates(output))
            .collect()
    } else {
        Vec::new()
    };
    Ok(RunResult {
        markdown,
        mode: settings.mode(),
        memory_candidates,
        stats: json!({
            "sources": source_stats,
            "blocks": blocks.iter().enumerate().map(|(index, block)| json!({
                "number": index + 1, "chars_sent": block.markdown.chars().count(),
                "turns": block.turns
            })).collect::<Vec<_>>(),
            "input_limit_chars": settings.llm_input_limit,
            "active_provider": {
                "id": settings.active_provider_id,
                "name": settings.active_provider_name,
                "model": settings.llm_model
            },
            "truncated": false,
            "elapsed_ms": started.elapsed().as_millis()
        }),
    })
}

#[derive(Debug)]
struct PreparedTurn {
    session_key: String,
    session_title: String,
    number: usize,
    start_seq: i64,
    end_seq: i64,
    markdown: String,
}

#[derive(Debug)]
struct CompressionBlock {
    markdown: String,
    turns: Vec<Value>,
}

fn selected_turn_set(requested: Option<&[usize]>, count: usize) -> Result<BTreeSet<usize>> {
    let requested = requested
        .map(|values| values.to_vec())
        .unwrap_or_else(|| (1..=count).collect());
    if requested.is_empty() {
        bail!("turn_numbers must not be empty");
    }
    if requested.contains(&0) {
        bail!("turn_numbers are one-based and must be greater than zero");
    }
    let wanted = requested.into_iter().collect::<BTreeSet<_>>();
    if let Some(missing) = wanted.iter().find(|number| **number > count) {
        bail!("turn {missing} does not exist; session has {count} turns");
    }
    Ok(wanted)
}

fn pack_turns(
    turns: &[PreparedTurn],
    limit: usize,
) -> std::result::Result<Vec<CompressionBlock>, CompressionError> {
    let mut blocks = Vec::new();
    let mut current = CompressionBlock {
        markdown: String::new(),
        turns: Vec::new(),
    };
    for turn in turns {
        let header = format!(
            "\n\n## {} ({}) - turn {} (seq {}-{})\n\n",
            turn.session_title, turn.session_key, turn.number, turn.start_seq, turn.end_seq
        );
        let fragment = format!("{header}{}", turn.markdown);
        let chars = fragment.chars().count();
        if chars > limit {
            return Err(CompressionError::new(
                CompressionErrorKind::InvalidRequest,
                "plan_blocks",
                format!(
                    "session `{}` turn {} exceeds the LLM input limit",
                    turn.session_key, turn.number
                ),
                json!({"session_key": turn.session_key, "turn_number": turn.number, "start_seq": turn.start_seq,
                    "end_seq": turn.end_seq, "characters": chars, "input_limit_chars": limit,
                    "truncated": false, "retryable": false}),
            ));
        }
        if !current.markdown.is_empty()
            && current.markdown.chars().count().saturating_add(chars) > limit
        {
            blocks.push(current);
            current = CompressionBlock {
                markdown: String::new(),
                turns: Vec::new(),
            };
        }
        current.markdown.push_str(&fragment);
        current.turns.push(
            json!({"session_key": turn.session_key, "turn_number": turn.number,
            "start_seq": turn.start_seq, "end_seq": turn.end_seq}),
        );
    }
    if !current.markdown.is_empty() {
        blocks.push(current);
    }
    if blocks.is_empty() {
        return Err(CompressionError::new(
            CompressionErrorKind::InvalidRequest,
            "plan_blocks",
            "compression input has no turns",
            json!({}),
        ));
    }
    Ok(blocks)
}

fn assemble_blocks(outputs: &[String], blocks: &[CompressionBlock]) -> String {
    if outputs.len() == 1 {
        return outputs[0].clone();
    }
    let mut out = String::from("# ContextOS 分块压缩结果\n\n");
    for (index, output) in outputs.iter().enumerate() {
        out.push_str(&format!(
            "## 块 {} / {}\n\n{}\n\n",
            index + 1,
            blocks.len(),
            output.trim()
        ));
    }
    out
}

fn relationship_context(store: &Store, metas: &[SessionMeta]) -> Result<String> {
    let selected = metas
        .iter()
        .map(|meta| meta.key.as_str())
        .collect::<HashSet<_>>();
    let mut seen = HashSet::new();
    let mut lines = Vec::new();
    for meta in metas {
        let (_, children) = store.session_relationships(&meta.key)?;
        for child in children {
            if selected.contains(child.session.key.as_str()) {
                let key = format!("{}\0{}\0{}", meta.key, child.session.key, child.relation);
                if seen.insert(key) {
                    lines.push(format!(
                        "- {} --[{}; source={}]--> {}",
                        meta.key, child.relation, child.source, child.session.key
                    ));
                }
            }
        }
    }
    Ok(lines.join("\n"))
}

fn split_turns(
    messages: &[crate::models::TranscriptMessage],
) -> Vec<Vec<crate::models::TranscriptMessage>> {
    let mut turns = Vec::new();
    let mut current = Vec::new();
    let mut current_has_user = false;
    for message in messages {
        if message.role == crate::models::Role::User && current_has_user {
            turns.push(std::mem::take(&mut current));
            current_has_user = false;
        }
        if message.role == crate::models::Role::User {
            current_has_user = true;
        }
        current.push(message.clone());
    }
    if !current.is_empty() {
        turns.push(current);
    }
    turns
}

fn parse_details(markdown: &str) -> Vec<Detail> {
    let mut details = Vec::new();
    let mut cursor = 0;
    while let Some(relative) = markdown[cursor..].find(DETAIL_OPEN) {
        let start = cursor + relative;
        let summary_start = start + DETAIL_OPEN.len();
        let Some(summary_relative) = markdown[summary_start..].find("</summary>") else {
            break;
        };
        let summary_end = summary_start + summary_relative;
        let body_start = summary_end + "</summary>".len();
        let Some(close_relative) = markdown[body_start..].find(DETAIL_CLOSE) else {
            break;
        };
        let close = body_start + close_relative;
        let end = close + DETAIL_CLOSE.len();
        let body = markdown[body_start..close].trim_matches('\n').to_string();
        details.push(Detail {
            start,
            end,
            summary: markdown[summary_start..summary_end].to_string(),
            output: fenced_output(&body),
            body,
        });
        cursor = end;
    }
    details
}

fn fenced_output(body: &str) -> Option<String> {
    let marker = "Output:\n\n```\n";
    let start = body.find(marker)? + marker.len();
    let end = body[start..].find("\n```")? + start;
    Some(body[start..end].to_string())
}

fn compact_details(
    markdown: &str,
    meta: &SessionMeta,
    settings: &RuntimeSettings,
) -> Result<(String, usize, usize)> {
    let details = parse_details(markdown);
    let candidate_min = settings.jev_strategy.jev_candidate_min_chars;
    let candidates: Vec<&Detail> = details
        .iter()
        .filter(|d| {
            settings.mechanical.generic_large_output_rule.mark_jev_candidate
                && candidate_min > 0
                &&
            d.output
                .as_ref()
                .is_some_and(|o| o.chars().count() >= candidate_min)
        })
        .collect();
    let actions = if settings.jev_enabled {
        jev_decisions(settings, meta, &candidates)?
    } else {
        vec![JevAction::UseMechanical; candidates.len()]
    };
    let candidate_count = candidates.len();
    drop(candidates);
    let mut out = String::with_capacity(markdown.len());
    let mut cursor = 0;
    let mut candidate_index = 0;
    let mut kept_count = 0;
    for detail in details {
        out.push_str(&markdown[cursor..detail.start]);
        let empty_rule = &settings.mechanical.empty_output_rule;
        let low_value = empty_rule.enabled
            && (detail.body.trim().is_empty() && empty_rule.drop_empty_output
                || detail.summary.contains("write_stdin")
                    && detail.body.len() < empty_rule.write_stdin_max_chars
                || detail.body.contains("Process exited with code 0")
                    && detail.body.len() < empty_rule.success_output_max_chars);
        if !low_value {
            let replacement = if let Some(output) = &detail.output {
                let chars = output.chars().count();
                if settings.mechanical.generic_large_output_rule.mark_jev_candidate
                    && chars >= candidate_min
                {
                    let action = actions
                        .get(candidate_index)
                        .copied()
                        .unwrap_or(JevAction::UseMechanical);
                    candidate_index += 1;
                    if action == JevAction::Verbatim {
                        kept_count += 1;
                    }
                    match action {
                        JevAction::Discard => {
                            cursor = detail.end;
                            continue;
                        }
                        JevAction::Stub => replace_output(&detail.body, &output_stub_with(output, 0, 0)),
                        JevAction::UseMechanical | JevAction::Evidence => replace_output(
                            &detail.body,
                            &output_stub_with(
                                output,
                                settings.mechanical.generic_large_output_rule.head_chars,
                                settings.mechanical.generic_large_output_rule.tail_chars,
                            ),
                        ),
                        JevAction::Expanded => replace_output(
                            &detail.body,
                            &output_stub_with(
                                output,
                                settings.mechanical.generic_large_output_rule.head_chars * 2,
                                settings.mechanical.generic_large_output_rule.tail_chars * 2,
                            ),
                        ),
                        JevAction::Verbatim => detail.body.clone(),
                    }
                } else if settings.mechanical.generic_large_output_rule.enabled
                    && chars >= settings.mechanical.generic_large_output_rule.min_output_chars
                {
                    replace_output(
                        &detail.body,
                        &output_stub_with(
                            output,
                            settings.mechanical.generic_large_output_rule.head_chars,
                            settings.mechanical.generic_large_output_rule.tail_chars,
                        ),
                    )
                } else {
                    detail.body.clone()
                }
            } else {
                detail.body.clone()
            };
            out.push_str(&format!(
                "{DETAIL_OPEN}{}</summary>\n\n{}\n\n{DETAIL_CLOSE}",
                detail.summary, replacement
            ));
        }
        cursor = detail.end;
    }
    out.push_str(&markdown[cursor..]);
    Ok((out, candidate_count, kept_count))
}

fn replace_output(body: &str, replacement: &str) -> String {
    let marker = "Output:\n\n```\n";
    let Some(start_marker) = body.find(marker) else {
        return body.to_string();
    };
    let start = start_marker + marker.len();
    let Some(relative_end) = body[start..].find("\n```") else {
        return body.to_string();
    };
    let end = start + relative_end;
    format!("{}{}{}", &body[..start], replacement, &body[end..])
}

fn output_stub_with(output: &str, head_chars: usize, tail_chars: usize) -> String {
    let chars = output.chars().count();
    if head_chars == 0 && tail_chars == 0 {
        return format!("[ContextOS omitted output; original {chars} chars]");
    }
    let head: String = output.chars().take(head_chars).collect();
    let tail: String = output
        .chars()
        .rev()
        .take(tail_chars)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("{head}\n\n[ContextOS mechanically omitted output; original {chars} chars]\n\n{tail}")
}

fn jev_decisions(
    settings: &RuntimeSettings,
    meta: &SessionMeta,
    details: &[&Detail],
) -> Result<Vec<JevAction>> {
    if details.is_empty() {
        return Ok(Vec::new());
    }
    let questions = details.iter().enumerate().map(|(index, detail)| {
        let output = detail.output.as_deref().unwrap_or_default();
        let head: String = output.chars().take(240).collect();
        let tail: String = output.chars().rev().take(160).collect::<Vec<_>>().into_iter().rev().collect();
        let levels = settings
            .jev_strategy
            .jev_score_levels
            .iter()
            .map(|level| format!("{} <= {:.2}: action={:?}", level.label, level.max_score, level.action))
            .collect::<Vec<_>>()
            .join("\n");
        (format!("score_{}", index + 1), json!({
            "type": "noul",
            "instructions": format!("{}\n\n评分等级：\n{}\n\nSummary: {}\nHead:\n{}\nTail:\n{}\n\nReturn JSON with score, reason, and evidence_hints.", settings.jev_strategy.jev_prompt_template, levels, detail.summary, head, tail)
        }))
    }).collect::<serde_json::Map<_, _>>();
    let body = json!({
        "model": "jev-latest",
        "state": {"title": meta.title, "agent": meta.agent.display_name(), "project": meta.project_path},
        "questions": questions
    });
    if body.to_string().len() > settings.jev_strategy.jev_request_char_limit {
        bail!("Jev request exceeds the configured request budget");
    }
    let endpoint = endpoint(&settings.jev_url, "/v1/systemone", "/v1/systemone");
    let response = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(settings.jev_timeout))
        .build()?
        .post(endpoint)
        .bearer_auth(settings.jev_key.trim())
        .json(&body)
        .send()
    {
        Ok(response) => response,
        Err(error) if settings.jev_strategy.jev_fallback_on_error == JevFallback::UseMechanical => {
            eprintln!("ContextOS Jev request failed; using mechanical fallback: {error}");
            return Ok(vec![JevAction::UseMechanical; details.len()]);
        }
        Err(error) => return Err(error.into()),
    };
    let status = response.status();
    let text = response.text()?;
    if !status.is_success() {
        if settings.jev_strategy.jev_fallback_on_error == JevFallback::UseMechanical {
            eprintln!("ContextOS Jev API returned {status}; using mechanical fallback: {text}");
            return Ok(vec![JevAction::UseMechanical; details.len()]);
        }
        bail!("Jev API returned {status}: {text}");
    }
    let value: Value = match serde_json::from_str(text.trim_start_matches('\u{feff}')) {
        Ok(value) => value,
        Err(error) if settings.jev_strategy.jev_fallback_on_error == JevFallback::UseMechanical => {
            eprintln!("ContextOS Jev response parse failed; using mechanical fallback: {error}");
            return Ok(vec![JevAction::UseMechanical; details.len()]);
        }
        Err(error) => return Err(error.into()),
    };
    Ok((0..details.len())
        .map(|index| {
            let key = format!("score_{}", index + 1);
            let score = value
                .pointer(&format!("/answers/{key}/score"))
                .and_then(Value::as_f64)
                .or_else(|| value.pointer(&format!("/answers/{key}/noul")).and_then(Value::as_f64))
                .or_else(|| {
                    value
                        .pointer(&format!("/answers/{key}/text"))
                        .and_then(Value::as_str)
                        .and_then(extract_score)
                })
                .unwrap_or(0.60);
            action_for_score(score, &settings.jev_strategy.jev_score_levels)
        })
        .collect())
}

fn action_for_score(score: f64, levels: &[JevScoreLevel]) -> JevAction {
    levels
        .iter()
        .find(|level| score <= level.max_score)
        .map(|level| level.action)
        .unwrap_or(JevAction::UseMechanical)
}

fn extract_score(text: &str) -> Option<f64> {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|value| value.get("score").and_then(Value::as_f64))
}

fn call_llm(
    settings: &RuntimeSettings,
    metas: &[SessionMeta],
    store: &Store,
    markdown: &str,
    generate_memory_candidates: bool,
    relationship_context: &str,
    block_number: usize,
    block_count: usize,
    turns: &[Value],
) -> std::result::Result<String, CompressionError> {
    let strategy = if generate_memory_candidates {
        &settings.memory_generation_strategy
    } else if metas.len() == 1 {
        &settings.single_strategy
    } else {
        &settings.multi_strategy
    };
    let source = metas
        .iter()
        .map(|meta| {
            let tags = store.session_tags(&meta.key).unwrap_or_default().join(", ");
            format!(
                "- {} | {} | {} | tags: {}",
                meta.key, meta.title, meta.project_path, tags
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let tags = metas
        .iter()
        .flat_map(|meta| store.session_tags(&meta.key).unwrap_or_default())
        .collect::<BTreeSet<_>>();
    let mut tag_strategy = format!("通用标签策略：{}", settings.tag_strategy.trim());
    for tag in &tags {
        if let Some(strategy) = settings
            .tag_specific_strategies
            .get(tag)
            .filter(|value| !value.trim().is_empty())
        {
            tag_strategy.push_str(&format!("\n- #{tag}: {}", strategy.trim()));
        }
    }
    let relation_strategy = if relationship_context.is_empty() {
        "输入会话之间没有已记录关系，按普通多会话处理。".to_string()
    } else {
        format!(
            "{}\n\n实际关系：\n{relationship_context}",
            settings.relation_strategy.trim()
        )
    };
    let memory_output = if generate_memory_candidates {
        settings.llm_prompt.llm_memory_candidate_contract.as_str()
    } else {
        ""
    };
    let turns_json = serde_json::to_string(turns).unwrap_or_default();
    let block_number_text = block_number.to_string();
    let block_count_text = block_count.to_string();
    let prompt = render_llm_template(
        &settings.llm_prompt.llm_user_prompt_template,
        &[
            ("task", settings.llm_prompt.llm_task_template.as_str()),
            ("strategy", strategy),
            ("tag_strategy", tag_strategy.as_str()),
            ("relationship_strategy", relation_strategy.as_str()),
            ("block_number", block_number_text.as_str()),
            ("block_count", block_count_text.as_str()),
            ("turns_json", turns_json.as_str()),
            ("sources", source.as_str()),
            ("markdown", markdown),
            ("memory_candidate_contract", memory_output),
        ],
    );
    let endpoint = endpoint(
        &settings.llm_url,
        "/chat/completions",
        "/v1/chat/completions",
    );
    let body = json!({
        "model": settings.llm_model.trim(),
        "messages": [
            {"role": "system", "content": settings.llm_prompt.llm_system_message.trim()},
            {"role": "user", "content": prompt}
        ],
        "temperature": settings.llm_prompt.llm_temperature
    });
    let request_started = Instant::now();
    let response = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(settings.llm_timeout))
        .build()
        .map_err(|error| CompressionError::new(CompressionErrorKind::Provider, "llm_client", error.to_string(), json!({
            "provider": "LLM", "model": settings.llm_model, "configured_timeout_secs": settings.llm_timeout,
            "block_number": block_number, "block_count": block_count, "retryable": false
        })))?
        .post(endpoint)
        .bearer_auth(settings.llm_key.trim())
        .header(reqwest::header::USER_AGENT, "ContextOS/0.8.0")
        .json(&body)
        .send()
        .map_err(|error| CompressionError::new(CompressionErrorKind::Provider, "llm_request", error.to_string(), json!({
            "provider": "LLM", "model": settings.llm_model, "configured_timeout_secs": settings.llm_timeout,
            "elapsed_ms": request_started.elapsed().as_millis(), "block_number": block_number,
            "block_count": block_count, "characters_sent": markdown.chars().count(),
            "input_limit_chars": settings.llm_input_limit, "truncated": false,
            "retryable": error.is_timeout() || error.is_connect()
        })))?;
    let status = response.status();
    let status_code = status.as_u16();
    let text = response.text().map_err(|error| {
        CompressionError::new(
            CompressionErrorKind::Provider,
            "llm_response",
            error.to_string(),
            json!({"provider": "LLM", "model": settings.llm_model, "http_status": status_code,
            "elapsed_ms": request_started.elapsed().as_millis(), "block_number": block_number,
            "block_count": block_count, "retryable": status_code >= 500}),
        )
    })?;
    if !status.is_success() {
        return Err(CompressionError::new(
            CompressionErrorKind::Provider,
            "llm_response",
            format!("LLM API returned {status}: {text}"),
            json!({"provider": "LLM", "model": settings.llm_model, "http_status": status_code,
                "elapsed_ms": request_started.elapsed().as_millis(), "configured_timeout_secs": settings.llm_timeout,
                "block_number": block_number, "block_count": block_count,
                "characters_sent": markdown.chars().count(), "input_limit_chars": settings.llm_input_limit,
                "truncated": false, "retryable": status_code == 429 || status_code >= 500}),
        ));
    }
    let value: Value = serde_json::from_str(&text).map_err(|error| {
        CompressionError::new(
            CompressionErrorKind::Provider,
            "llm_response_parse",
            error.to_string(),
            json!({"provider": "LLM", "model": settings.llm_model, "http_status": status_code,
            "block_number": block_number, "block_count": block_count, "retryable": false}),
        )
    })?;
    value
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            CompressionError::new(
                CompressionErrorKind::Provider,
                "llm_response_parse",
                "LLM API response missing choices[0].message.content",
                json!({"provider": "LLM", "model": settings.llm_model, "http_status": status_code,
                "block_number": block_number, "block_count": block_count, "retryable": false}),
            )
        })
}

fn endpoint(raw: &str, accepted_suffix: &str, suffix: &str) -> String {
    let raw = raw.trim().trim_end_matches('/');
    if raw.ends_with(accepted_suffix) {
        raw.to_string()
    } else {
        format!("{raw}{suffix}")
    }
}

fn render_llm_template(template: &str, variables: &[(&str, &str)]) -> String {
    let mut out = template.to_string();
    for (name, value) in variables {
        out = out.replace(&format!("{{{{{name}}}}}"), value);
    }
    out
}

fn parse_memory_candidates(markdown: &str) -> Vec<MemoryCandidate> {
    let marker = "```contextos-json";
    let Some(start) = markdown.rfind(marker).map(|i| i + marker.len()) else {
        return Vec::new();
    };
    let text = markdown[start..].trim_start_matches(['\r', '\n']);
    let Some(end) = text.find("```") else {
        return Vec::new();
    };
    serde_json::from_str::<Value>(text[..end].trim())
        .ok()
        .and_then(|value| {
            value
                .get("memory_candidates")
                .and_then(Value::as_array)
                .cloned()
        })
        .and_then(|values| serde_json::from_value(Value::Array(values)).ok())
        .unwrap_or_default()
}
