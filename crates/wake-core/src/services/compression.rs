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
    self, DecisionModelProvider, DecisionScoringMode, JevAction, JevFallback, JevScoreLevel,
    JevStrategySettings, LlmPromptSettings, MechanicalRetentionMode, MechanicalStrategySettings,
};
use crate::services::exporter;
use crate::services::laya_runtime::{self, LayaRuntimeMode};

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
    /// Existing derived output used only to preserve continuity during an
    /// incremental LLM update. It is never included in non-LLM output.
    pub continuation_context: Option<String>,
}

#[derive(Debug)]
pub struct RunResult {
    pub markdown: String,
    pub mode: &'static str,
    pub memory_candidates: Vec<MemoryCandidate>,
    pub stats: Value,
}

impl RunResult {
    pub fn processing_report_markdown(&self) -> String {
        let decision = self.stats.get("decision").unwrap_or(&Value::Null);
        let enabled = decision
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let provider = decision
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or("未启用");
        let model = decision.get("model").and_then(Value::as_str).unwrap_or("-");
        let candidates = decision
            .get("candidates")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let fallback_count = decision
            .get("fallback_count")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let scoring_mode = match decision
            .get("scoring_mode")
            .and_then(Value::as_str)
            .unwrap_or("absolute")
        {
            "relative" => "相对评分",
            _ => "绝对评分",
        };
        let request_count = decision
            .get("request_count")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let request_format = decision
            .get("request_format")
            .and_then(Value::as_str)
            .unwrap_or("-");
        let input_tokens = decision
            .get("input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let truncated_count = decision
            .get("truncated_count")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let average_confidence = decision
            .get("average_confidence")
            .and_then(Value::as_f64)
            .map(|value| format!("{value:.3}"))
            .unwrap_or_else(|| "-".into());
        let valid_decisions = if enabled {
            candidates.saturating_sub(fallback_count)
        } else {
            0
        };
        let status = if !enabled {
            "未启用".to_string()
        } else if candidates == 0 {
            "未调用（没有达到候选阈值的工具输出或正文）".to_string()
        } else if fallback_count == candidates {
            "调用未产生有效决策，已全部使用机械回退".to_string()
        } else if fallback_count > 0 {
            format!("部分成功（{fallback_count} 个候选使用机械回退）")
        } else {
            "调用成功".to_string()
        };
        let action_count = |name: &str| {
            decision
                .pointer(&format!("/action_counts/{name}"))
                .and_then(Value::as_u64)
                .unwrap_or(0)
        };

        let fragment_report = decision
            .get("fragments")
            .and_then(Value::as_array)
            .filter(|fragments| !fragments.is_empty())
            .map(|fragments| {
                let mut report = String::from(
                    "## Jev/Laya 片段分级\n\n|来源 / 轮次|片段|分级|保留动作|\n|---|---|---|---|\n",
                );
                for fragment in fragments {
                    let source = fragment
                        .get("source")
                        .and_then(Value::as_str)
                        .unwrap_or("-");
                    let turn = fragment.get("turn").and_then(Value::as_u64).unwrap_or(0);
                    let item = fragment
                        .get("fragment")
                        .and_then(Value::as_str)
                        .unwrap_or("-")
                        .replace('|', "\\|")
                        .replace('\n', " ");
                    let grade = fragment.get("grade").and_then(Value::as_str).unwrap_or("-");
                    let action = fragment
                        .get("action")
                        .and_then(Value::as_str)
                        .unwrap_or("-");
                    report.push_str(&format!("|`{source}` / {turn}|{item}|{grade}|{action}|\n"));
                }
                report.push('\n');
                report
            })
            .unwrap_or_default();

        format!(
            "# ContextOS 压缩处理报告\n\n\
- 模式：{}\n\
- 决策模型：{} (`{}`)\n\
- 最终分档：{}\n\
- 调用状态：{}\n\
- 请求格式：{}\n\
- 请求次数：{}，输入 tokens：{}，截断候选：{}，平均置信度：{}\n\
- 候选输出：{}\n\
- 有效决策：{}\n\
- 机械回退：{}\n\
- 六档结果：删除 {}、极简占位 {}、机械裁剪 {}、关键证据 {}、扩展片段 {}、近全文 {}\n\n\
{}\
---\n\n",
            self.mode,
            provider,
            model,
            scoring_mode,
            status,
            request_format,
            request_count,
            input_tokens,
            truncated_count,
            average_confidence,
            candidates,
            valid_decisions,
            fallback_count,
            action_count("discard"),
            action_count("stub"),
            action_count("use_mechanical"),
            action_count("evidence"),
            action_count("expanded"),
            action_count("verbatim"),
            fragment_report,
        )
    }
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
    decision_provider: DecisionModelProvider,
    decision_model: String,
    jev_url: String,
    jev_key: String,
    laya_runtime_mode: LayaRuntimeMode,
    laya_runtime_error: Option<String>,
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
    retention_mode: MechanicalRetentionMode,
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
        let (decision_url, decision_key, laya_runtime_error) = match (
            settings.service.decision_provider,
            settings.service.laya_runtime_mode,
        ) {
            (DecisionModelProvider::Jev, _) => (
                settings.service.jev_api_url.clone(),
                settings.service.jev_api_key.clone(),
                None,
            ),
            (DecisionModelProvider::Laya, LayaRuntimeMode::External) => (
                settings.service.external_laya_api_url.clone(),
                settings.service.external_laya_api_key.clone(),
                None,
            ),
            (DecisionModelProvider::Laya, LayaRuntimeMode::Managed) => {
                match laya_runtime::manager().ready_endpoint() {
                    Ok(endpoint) => (endpoint, String::new(), None),
                    Err(error) => (String::new(), String::new(), Some(error.to_string())),
                }
            }
        };
        Self {
            jev_enabled: settings.service.jev_enabled,
            decision_provider: settings.service.decision_provider,
            decision_model: settings.service.decision_model,
            jev_url: decision_url,
            jev_key: decision_key,
            laya_runtime_mode: settings.service.laya_runtime_mode,
            laya_runtime_error,
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
            retention_mode: settings.strategy.mechanical.retention_mode,
            mechanical: settings.strategy.mechanical,
            jev_strategy: settings.strategy.jev,
            llm_prompt: settings.strategy.llm,
        }
    }

    fn mode(&self) -> &'static str {
        match (self.jev_enabled, self.llm_enabled, self.decision_provider) {
            (false, false, _) => "mechanical",
            (false, true, _) => "mechanical+llm",
            (true, false, DecisionModelProvider::Jev) => "mechanical+jev",
            (true, true, DecisionModelProvider::Jev) => "mechanical+jev+llm",
            (true, false, DecisionModelProvider::Laya) => "mechanical+laya",
            (true, true, DecisionModelProvider::Laya) => "mechanical+laya+llm",
        }
    }

    fn validate(&self) -> Result<()> {
        if self.jev_enabled
            && self.decision_provider == DecisionModelProvider::Laya
            && self.laya_runtime_mode == LayaRuntimeMode::Managed
        {
            if let Some(error) = &self.laya_runtime_error {
                bail!("managed Laya is unavailable: {error}");
            }
        }
        if self.jev_enabled
            && (self.jev_url.trim().is_empty()
                || self.decision_model.trim().is_empty()
                || self.decision_provider.requires_api_key() && self.jev_key.trim().is_empty())
        {
            bail!(
                "{} is enabled but its API URL, model, or required API key is not configured",
                self.decision_provider.display_name()
            );
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
                decision_provider: self.decision_provider,
                decision_model: self.decision_model.clone(),
                laya_runtime_mode: self.laya_runtime_mode,
                external_laya_api_url: if self.laya_runtime_mode == LayaRuntimeMode::External {
                    self.jev_url.clone()
                } else {
                    String::new()
                },
                external_laya_api_key: if self.laya_runtime_mode == LayaRuntimeMode::External {
                    self.jev_key.clone()
                } else {
                    String::new()
                },
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

fn legacy_default_memory_generation_strategy() -> String {
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

pub fn default_memory_generation_strategy() -> String {
    "你是 ContextOS 的会话压缩器。请保真压缩单个 agent 对话，并识别可由用户审核后写入记忆或 AGENT.md 的候选内容。\n\n\
     压缩必须遵守：\n\
     - 保留用户目标、关键决策、代码改动、错误、验证结果、未完成事项和恢复提示。\n\
     - 不要编造，不要把推测写成事实；信息不确定时标注“不确定”或“需验证”。\n\n\
     候选判断必须遵守：\n\
     - decision 只记录明确决定；rule 只记录用户明确表达的长期偏好、项目约定或工作方式约束。\n\
     - todo 只记录仍需执行的事项；project_fact 只记录稳定项目事实；resume_hint 只记录下次接手必需的上下文。\n\
     - 不要把临时过程、失败尝试、一次性命令或单次行为过度归纳为长期规则。\n\
     - 没有耐久、可复用或恢复价值的信息时，不要勉强生成候选。\n\n\
     请输出事实准确、可供后续接手的压缩 Markdown。记忆候选的输出格式只遵守独立的 Memory candidate output 契约。".into()
}

pub(crate) fn migrate_memory_generation_strategy(value: String) -> String {
    if value.trim() == legacy_default_memory_generation_strategy().trim() {
        default_memory_generation_strategy()
    } else {
        value
    }
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

#[derive(Clone, Default)]
struct CompactionStats {
    jev_candidates: usize,
    jev_kept_full: usize,
    decision_requests: usize,
    decision_input_tokens: u64,
    decision_truncated: usize,
    decision_confidence_sum: f64,
    decision_confidence_count: usize,
    mechanical_rule_hits: HashMap<String, usize>,
    jev_level_counts: HashMap<String, usize>,
    jev_action_counts: HashMap<String, usize>,
}

impl CompactionStats {
    fn hit_rule(&mut self, rule: &str) {
        *self
            .mechanical_rule_hits
            .entry(rule.to_string())
            .or_default() += 1;
    }

    fn merge(&mut self, other: Self) {
        self.jev_candidates += other.jev_candidates;
        self.jev_kept_full += other.jev_kept_full;
        self.decision_requests += other.decision_requests;
        self.decision_input_tokens += other.decision_input_tokens;
        self.decision_truncated += other.decision_truncated;
        self.decision_confidence_sum += other.decision_confidence_sum;
        self.decision_confidence_count += other.decision_confidence_count;
        merge_counts(&mut self.mechanical_rule_hits, other.mechanical_rule_hits);
        merge_counts(&mut self.jev_level_counts, other.jev_level_counts);
        merge_counts(&mut self.jev_action_counts, other.jev_action_counts);
    }
}

fn merge_counts(target: &mut HashMap<String, usize>, source: HashMap<String, usize>) {
    for (key, count) in source {
        *target.entry(key).or_default() += count;
    }
}

fn average_confidence(stats: &CompactionStats) -> Option<f64> {
    (stats.decision_confidence_count > 0)
        .then(|| stats.decision_confidence_sum / stats.decision_confidence_count as f64)
}

#[derive(Clone)]
struct JevDecision {
    level_id: String,
    action: JevAction,
}

#[derive(Clone, Debug, Default)]
struct CandidateAssessment {
    preservation_score: Option<f64>,
    irreplaceable_evidence: Option<f64>,
    confidence: Option<f64>,
}

impl CandidateAssessment {
    fn combined_score(&self) -> Option<f64> {
        let preservation = self.preservation_score?;
        let evidence = self.irreplaceable_evidence?;
        Some(preservation.max(evidence * 0.92).clamp(0.0, 1.0))
    }
}

#[derive(Clone, Debug, Default)]
struct DecisionDiagnostics {
    requests: usize,
    input_tokens: u64,
    truncated: usize,
    confidence_sum: f64,
    confidence_count: usize,
}

#[derive(Debug)]
struct PendingTurn {
    source_index: usize,
    session_key: String,
    session_title: String,
    number: usize,
    start_seq: i64,
    end_seq: i64,
    markdown: String,
    assessments: Vec<CandidateAssessment>,
    diagnostics: DecisionDiagnostics,
}

#[derive(Default)]
struct SourceCompaction {
    session_key: String,
    chars_before: usize,
    chars_after: usize,
    stats: CompactionStats,
    turn_numbers: Option<Vec<usize>>,
}

fn jev_action_name(action: JevAction) -> &'static str {
    match action {
        JevAction::Discard => "discard",
        JevAction::Stub => "stub",
        JevAction::UseMechanical => "use_mechanical",
        JevAction::Evidence => "evidence",
        JevAction::Expanded => "expanded",
        JevAction::Verbatim => "verbatim",
    }
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
    let mut pending_turns = Vec::new();
    let mut sources = Vec::new();
    let mut decision_stats = CompactionStats::default();
    let mut metas = Vec::new();
    for (source_index, input) in inputs.iter().enumerate() {
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
        sources.push(SourceCompaction {
            session_key: key.clone(),
            turn_numbers: input.turn_numbers.clone(),
            ..SourceCompaction::default()
        });
        for (index, messages) in turns.into_iter().enumerate() {
            let number = index + 1;
            if !wanted.contains(&number) {
                continue;
            }
            let raw = exporter::messages_to_markdown_for_compression(
                &messages,
                settings.retention_mode,
                settings.mechanical.allow_jev_delete_assistant_body,
                settings.mechanical.allow_jev_delete_user_messages,
                settings.jev_strategy.jev_candidate_min_chars,
            );
            sources[source_index].chars_before += raw.chars().count();
            let (assessments, diagnostics) = assess_candidates(&raw, &meta, &settings)
                .map_err(|error| CompressionError::new(
                    CompressionErrorKind::Provider, "jev", error.to_string(),
                    json!({"session_key": key, "turn_number": number, "provider": settings.decision_provider.display_name(), "model": settings.decision_model, "configured_timeout_secs": settings.jev_timeout})
                ))?;
            pending_turns.push(PendingTurn {
                source_index,
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
                markdown: raw,
                assessments,
                diagnostics,
            });
        }
        metas.push(meta);
    }
    let turn_decisions = finalize_decisions(&pending_turns, &settings);
    let fragment_decisions = build_fragment_decisions(&pending_turns, &turn_decisions, &settings);
    let mut prepared_turns = Vec::with_capacity(pending_turns.len());
    for (pending, decisions) in pending_turns.into_iter().zip(turn_decisions) {
        let (markdown, mut turn_stats) = compact_details(&pending.markdown, &settings, &decisions);
        turn_stats.decision_requests = pending.diagnostics.requests;
        turn_stats.decision_input_tokens = pending.diagnostics.input_tokens;
        turn_stats.decision_truncated = pending.diagnostics.truncated;
        turn_stats.decision_confidence_sum = pending.diagnostics.confidence_sum;
        turn_stats.decision_confidence_count = pending.diagnostics.confidence_count;
        let source = &mut sources[pending.source_index];
        source.chars_after += markdown.chars().count();
        source.stats.merge(turn_stats.clone());
        decision_stats.merge(turn_stats);
        prepared_turns.push(PreparedTurn {
            session_key: pending.session_key,
            session_title: pending.session_title,
            number: pending.number,
            start_seq: pending.start_seq,
            end_seq: pending.end_seq,
            markdown,
        });
    }
    let source_stats = sources
        .into_iter()
        .map(|source| {
            json!({
                "session_key": source.session_key,
                "chars_before": source.chars_before,
                "chars_after": source.chars_after,
                "jev_candidates": source.stats.jev_candidates,
                "jev_kept_full": source.stats.jev_kept_full,
                "decision_requests": source.stats.decision_requests,
                "decision_input_tokens": source.stats.decision_input_tokens,
                "decision_truncated": source.stats.decision_truncated,
                "decision_average_confidence": average_confidence(&source.stats),
                "mechanical_rule_hits": source.stats.mechanical_rule_hits,
                "jev_level_counts": source.stats.jev_level_counts,
                "jev_action_counts": source.stats.jev_action_counts,
                "turn_numbers": source.turn_numbers
            })
        })
        .collect::<Vec<_>>();
    let continuation_context = if settings.llm_enabled {
        overrides
            .continuation_context
            .as_deref()
            .map(|context| {
                bounded_continuation_context(
                    context,
                    (settings.llm_input_limit / 4).clamp(1_000, 100_000),
                )
            })
            .filter(|context| !context.trim().is_empty())
            .unwrap_or_default()
    } else {
        String::new()
    };
    let block_limit = if settings.llm_enabled {
        settings
            .llm_input_limit
            .saturating_sub(continuation_context.chars().count())
            .max(1)
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
                &continuation_context,
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
    let fallback_count = decision_stats
        .jev_level_counts
        .get("fallback")
        .copied()
        .unwrap_or(0);
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
            "continuation_context_chars": continuation_context.chars().count(),
            "active_provider": {
                "id": settings.active_provider_id,
                "name": settings.active_provider_name,
                "model": settings.llm_model
            },
            "decision": {
                "enabled": settings.jev_enabled,
                "provider": settings.decision_provider.display_name(),
                "provider_id": settings.decision_provider.as_str(),
                "model": settings.decision_model,
                "request_format": decision_request_format(&settings),
                "scoring_mode": match settings.jev_strategy.scoring_mode {
                    DecisionScoringMode::Absolute => "absolute",
                    DecisionScoringMode::Relative => "relative",
                },
                "candidates": decision_stats.jev_candidates,
                "kept_full": decision_stats.jev_kept_full,
                "request_count": decision_stats.decision_requests,
                "input_tokens": decision_stats.decision_input_tokens,
                "truncated_count": decision_stats.decision_truncated,
                "average_confidence": average_confidence(&decision_stats),
                "level_counts": decision_stats.jev_level_counts,
                "action_counts": decision_stats.jev_action_counts,
                "fallback_count": fallback_count,
                "fragments": fragment_decisions
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

fn bounded_continuation_context(value: &str, limit: usize) -> String {
    let chars = value.chars().collect::<Vec<_>>();
    if chars.len() <= limit {
        return value.to_string();
    }
    let head = (limit / 4).max(1);
    let tail = limit.saturating_sub(head);
    let mut out = chars[..head].iter().collect::<String>();
    out.push_str("\n\n[... earlier summary context omitted ...]\n\n");
    out.extend(&chars[chars.len().saturating_sub(tail)..]);
    out
}

#[cfg(test)]
mod continuation_context_tests {
    use super::bounded_continuation_context;

    #[test]
    fn bounded_context_keeps_overview_and_recent_tail_on_character_boundaries() {
        let value = format!("overview-{}-recent", "上下文".repeat(100));
        let bounded = bounded_continuation_context(&value, 80);
        assert!(bounded.starts_with("overview-"));
        assert!(bounded.ends_with("-recent"));
        assert!(bounded.contains("earlier summary context omitted"));
        assert!(bounded.chars().count() < 140);
    }
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

fn body_candidate_role(detail: &Detail) -> Option<&'static str> {
    if detail.summary.contains("jev-body-candidate:assistant") {
        Some("assistant")
    } else if detail.summary.contains("jev-body-candidate:user") {
        Some("user")
    } else {
        None
    }
}

fn candidate_content(detail: &Detail) -> Option<String> {
    if body_candidate_role(detail).is_some() {
        detail.body.strip_prefix("Body:\n\n").map(str::to_string)
    } else {
        detail.output.clone()
    }
}

fn compact_details(
    markdown: &str,
    settings: &RuntimeSettings,
    actions: &[JevDecision],
) -> (String, CompactionStats) {
    let details = parse_details(markdown);
    let candidate_min = settings.jev_strategy.jev_candidate_min_chars;
    let candidate_count = candidate_details(&details, settings).len();
    let mut stats = CompactionStats {
        jev_candidates: candidate_count,
        ..CompactionStats::default()
    };
    let mut out = String::with_capacity(markdown.len());
    let mut cursor = 0;
    let mut candidate_index = 0;
    let mut kept_count = 0;
    for detail in details {
        out.push_str(&markdown[cursor..detail.start]);
        let is_candidate = is_jev_candidate(&detail, settings, candidate_min);
        let decision = if is_candidate {
            let decision = actions
                .get(candidate_index)
                .cloned()
                .unwrap_or(JevDecision {
                    level_id: "fallback".into(),
                    action: JevAction::UseMechanical,
                });
            candidate_index += 1;
            *stats
                .jev_level_counts
                .entry(decision.level_id.clone())
                .or_default() += 1;
            *stats
                .jev_action_counts
                .entry(jev_action_name(decision.action).into())
                .or_default() += 1;
            Some(decision)
        } else {
            None
        };
        let decision_was_made = decision
            .as_ref()
            .is_some_and(|decision| !matches!(decision.level_id.as_str(), "fallback" | "disabled"));
        let decision_annotation = decision
            .as_ref()
            .map(|decision| decision_annotation(decision, settings));

        if let Some(role) = body_candidate_role(&detail) {
            let should_discard = decision.as_ref().is_some_and(|decision| {
                should_discard_body_candidate(
                    role,
                    decision.action,
                    decision_was_made,
                    settings.mechanical.allow_jev_delete_assistant_body,
                    settings.mechanical.allow_jev_delete_user_messages,
                )
            });
            if !should_discard {
                if let Some(body) = candidate_content(&detail) {
                    let label = if role == "user" {
                        "👤 User"
                    } else {
                        "🤖 Assistant"
                    };
                    let timestamp = detail
                        .summary
                        .strip_prefix(&format!("jev-body-candidate:{role}"))
                        .unwrap_or_default();
                    out.push_str(&format!("### {label}{timestamp}\n\n"));
                    if let Some(annotation) = &decision_annotation {
                        out.push_str(annotation);
                        out.push_str("\n\n");
                    }
                    out.push_str(&body);
                    out.push_str("\n\n");
                }
            }
            cursor = detail.end;
            continue;
        }

        if settings.retention_mode == MechanicalRetentionMode::BodyOnly && !decision_was_made {
            cursor = detail.end;
            continue;
        }
        if settings.retention_mode == MechanicalRetentionMode::BodyWithStructure
            && !decision_was_made
        {
            out.push_str(&render_structural_detail(&detail));
            cursor = detail.end;
            continue;
        }

        let empty_rule = &settings.mechanical.empty_output_rule;
        let low_value = empty_rule.enabled
            && (detail.body.trim().is_empty() && empty_rule.drop_empty_output
                || detail.summary.contains("write_stdin")
                    && detail.body.len() < empty_rule.write_stdin_max_chars
                || detail.body.contains("Process exited with code 0")
                    && detail.body.len() < empty_rule.success_output_max_chars);
        if low_value {
            stats.hit_rule("empty_output_rule");
        }
        if low_value
            && empty_rule.keep_exit_code_line
            && detail.body.contains("Process exited with code")
        {
            let exit_line = detail
                .body
                .lines()
                .find(|line| line.contains("Process exited with code"))
                .unwrap_or("Process exited with code 0");
            out.push_str(&format!(
                "{DETAIL_OPEN}{}</summary>\n\n{}\n\n{DETAIL_CLOSE}",
                detail.summary, exit_line
            ));
        } else if !low_value {
            let replacement = if let Some(output) = &detail.output {
                if let Some(decision) = decision {
                    if decision.action == JevAction::Verbatim {
                        kept_count += 1;
                    }
                    match decision.action {
                        JevAction::Discard => {
                            cursor = detail.end;
                            continue;
                        }
                        JevAction::Stub => {
                            replace_output(&detail.body, &output_stub_with(output, 0, 0))
                        }
                        JevAction::UseMechanical | JevAction::Evidence => {
                            if let Some((rule, replacement)) =
                                mechanical_output_replacement(&detail, output, &settings.mechanical)
                            {
                                stats.hit_rule(rule);
                                if decision.action == JevAction::Evidence {
                                    let evidence = extract_evidence(
                                        &replacement,
                                        settings.mechanical.evidence_max_chars,
                                    );
                                    replace_output(&detail.body, &evidence.unwrap_or(replacement))
                                } else {
                                    replace_output(&detail.body, &replacement)
                                }
                            } else {
                                let evidence = extract_evidence(
                                    output,
                                    settings.mechanical.evidence_max_chars,
                                );
                                if decision.action == JevAction::Evidence {
                                    replace_output(
                                        &detail.body,
                                        &evidence.unwrap_or_else(|| output.clone()),
                                    )
                                } else {
                                    detail.body.clone()
                                }
                            }
                        }
                        JevAction::Expanded => {
                            replace_output(&detail.body, &expanded_output(output, settings))
                        }
                        JevAction::Verbatim => detail.body.clone(),
                    }
                } else if let Some((rule, replacement)) =
                    mechanical_output_replacement(&detail, output, &settings.mechanical)
                {
                    stats.hit_rule(rule);
                    replace_output(&detail.body, &replacement)
                } else {
                    detail.body.clone()
                }
            } else {
                detail.body.clone()
            };
            if settings.retention_mode == MechanicalRetentionMode::FullMechanical {
                out.push_str(&format!(
                    "{DETAIL_OPEN}{}</summary>\n\n{}{}\n\n{DETAIL_CLOSE}",
                    detail.summary,
                    decision_annotation
                        .as_deref()
                        .map(|line| format!("{line}\n\n"))
                        .unwrap_or_default(),
                    replacement,
                ));
            } else if settings.retention_mode == MechanicalRetentionMode::BodyOnly {
                let body = fenced_output(&replacement).unwrap_or(replacement);
                if !body.trim().is_empty() {
                    if let Some(annotation) = &decision_annotation {
                        out.push_str(annotation);
                        out.push_str("\n\n");
                    }
                    out.push_str(body.trim());
                    out.push_str("\n\n");
                }
            } else {
                out.push_str(&format!(
                    "{DETAIL_OPEN}{}</summary>\n\n{}Output:\n\n```\n{}\n```\n\n{DETAIL_CLOSE}\n\n",
                    detail.summary,
                    decision_annotation
                        .as_deref()
                        .map(|line| format!("{line}\n\n"))
                        .unwrap_or_default(),
                    fenced_output(&replacement).unwrap_or(replacement)
                ));
            }
        }
        cursor = detail.end;
    }
    out.push_str(&markdown[cursor..]);
    stats.jev_kept_full = kept_count;
    (out, stats)
}

fn decision_annotation(decision: &JevDecision, settings: &RuntimeSettings) -> String {
    decision_annotation_for_levels(decision, &settings.jev_strategy.jev_score_levels)
}

fn decision_annotation_for_levels(decision: &JevDecision, levels: &[JevScoreLevel]) -> String {
    let (label, action) = if decision.level_id == "fallback" {
        ("机械回退", jev_action_label(decision.action))
    } else if decision.level_id == "disabled" {
        ("未启用", jev_action_label(decision.action))
    } else if let Some(level) = levels.iter().find(|level| level.id == decision.level_id) {
        (level.label.as_str(), jev_action_label(level.action))
    } else {
        (
            decision.level_id.as_str(),
            jev_action_label(decision.action),
        )
    };
    format!("> Jev/Laya 分级：{label} · 保留动作：{action}")
}

fn build_fragment_decisions(
    turns: &[PendingTurn],
    decisions: &[Vec<JevDecision>],
    settings: &RuntimeSettings,
) -> Vec<Value> {
    if !settings.jev_enabled {
        return Vec::new();
    }
    let mut fragments = Vec::new();
    for (turn, turn_decisions) in turns.iter().zip(decisions) {
        let details = parse_details(&turn.markdown);
        let candidates = candidate_details(&details, settings);
        for (index, (detail, decision)) in candidates.iter().zip(turn_decisions).enumerate() {
            let annotation = decision_annotation(decision, settings);
            let grade = annotation
                .strip_prefix("> Jev/Laya 分级：")
                .and_then(|value| value.split(" · 保留动作：").next())
                .unwrap_or("-");
            fragments.push(json!({
                "source": turn.session_key,
                "turn": turn.number,
                "index": index + 1,
                "fragment": detail.summary,
                "grade": grade,
                "action": jev_action_label(decision.action),
                "decision": decision.level_id,
            }));
        }
    }
    fragments
}

fn jev_action_label(action: JevAction) -> &'static str {
    match action {
        JevAction::Discard => "删除",
        JevAction::Stub => "极简占位",
        JevAction::UseMechanical => "机械裁剪",
        JevAction::Evidence => "关键证据",
        JevAction::Expanded => "扩展片段",
        JevAction::Verbatim => "近全文",
    }
}

fn render_structural_detail(detail: &Detail) -> String {
    let output_summary = match &detail.output {
        Some(output) => format!("存在，{} 字符", output.chars().count()),
        None => "无".into(),
    };
    let source_error = if detail.summary.contains("source-error") {
        "是"
    } else {
        "否"
    };
    format!(
        "{DETAIL_OPEN}{}</summary>\n\n结构摘要：Input 已省略；Output {}；源记录错误标记：{}。\n\n{DETAIL_CLOSE}\n\n",
        detail.summary, output_summary, source_error
    )
}

fn expanded_output(output: &str, settings: &RuntimeSettings) -> String {
    let limit = settings.mechanical.expanded_max_chars.max(1);
    if output.chars().count() <= limit {
        return output.to_string();
    }
    let head = limit * 2 / 3;
    let tail = limit.saturating_sub(head);
    output_stub_with(output, head, tail)
}

fn extract_evidence(output: &str, max_chars: usize) -> Option<String> {
    let evidence_terms = [
        "error",
        "failed",
        "panic",
        "traceback",
        "exit code",
        "process exited",
        "error:",
        "失败",
        "错误",
        "退出码",
        "测试通过",
        "test result",
        "diff --git",
        "+++ ",
        "--- ",
        "path:",
        "file:",
        "warning:",
    ];
    let lines = output
        .lines()
        .filter(|line| {
            let lower = line.to_ascii_lowercase();
            evidence_terms.iter().any(|term| lower.contains(term))
        })
        .take(80)
        .collect::<Vec<_>>();
    if lines.is_empty() {
        return None;
    }
    let mut evidence = String::new();
    for line in lines {
        let separator = if evidence.is_empty() { "" } else { "\n" };
        let remaining = max_chars.saturating_sub(evidence.chars().count());
        if remaining == 0 {
            break;
        }
        evidence.push_str(separator);
        evidence.extend(line.chars().take(remaining));
    }
    (!evidence.is_empty()).then_some(evidence)
}

fn mechanical_output_replacement(
    detail: &Detail,
    output: &str,
    settings: &MechanicalStrategySettings,
) -> Option<(&'static str, String)> {
    let context = format!("{}\n{}", detail.summary, output).to_ascii_lowercase();

    let error = &settings.error_protection_rule;
    if error.enabled
        && (error
            .failure_keywords
            .iter()
            .any(|keyword| context.contains(&keyword.to_ascii_lowercase()))
            || context.contains("process exited with code 1")
            || context.contains("exit code: 1"))
    {
        let mut priority = if error.keep_failure_lines {
            error.failure_keywords.clone()
        } else {
            Vec::new()
        };
        if error.keep_command {
            priority.extend(["command:".into(), "命令：".into()]);
        }
        if error.keep_exit_code {
            priority.extend(["exit code".into(), "process exited".into(), "退出码".into()]);
        }
        return Some((
            "error_protection_rule",
            output_stub_with_priority(output, error.head_chars, error.tail_chars, &priority),
        ));
    }

    let patch = &settings.patch_rule;
    if patch.enabled
        && (context.contains("apply_patch")
            || context.contains("diff --git")
            || context.contains("*** begin patch")
            || context.contains("@@"))
    {
        let mut priority = Vec::new();
        if patch.keep_file_headers {
            priority.extend(["diff --git", "--- ", "+++ ", "*** update file"]);
        }
        return Some(("patch_rule", compact_patch_output(output, patch, &priority)));
    }

    let source = &settings.source_listing_rule;
    if source.enabled
        && [
            "codegraph",
            "source",
            "read file",
            "ast",
            "symbol",
            "call graph",
            "blast radius",
        ]
        .iter()
        .any(|keyword| context.contains(keyword))
    {
        let mut priority = Vec::new();
        if source.keep_query_summary {
            priority.extend(["query", "search"]);
        }
        if source.keep_file_headers {
            priority.extend(["file:", "path:"]);
        }
        if source.keep_blast_radius {
            priority.extend(["blast radius", "caller", "callee"]);
        }
        if source.keep_staleness_warnings {
            priority.extend(["stale", "outdated", "warning"]);
        }
        let by_lines = bounded_line_output(
            output,
            source.max_lines,
            source.max_lines,
            0,
            &priority,
            true,
        );
        let replacement = if by_lines == output
            && output.chars().count() > source.head_chars + source.tail_chars
        {
            output_stub_with_priority(output, source.head_chars, source.tail_chars, &priority)
        } else {
            by_lines
        };
        return Some(("source_listing_rule", replacement));
    }

    let search = &settings.search_output_rule;
    if search.enabled
        && [" rg ", "grep", "search", "find ", "findstr"]
            .iter()
            .any(|keyword| context.contains(keyword))
    {
        let mut priority = search.priority_keywords.clone();
        if search.keep_truncated_notice {
            priority.extend(["truncated".into(), "截断".into(), "omitted".into()]);
        }
        return Some((
            "search_output_rule",
            bounded_line_output(
                output,
                search.max_matches,
                search.head_matches,
                search.tail_matches,
                &priority,
                search.keep_truncated_notice,
            ),
        ));
    }

    let listing = &settings.listing_output_rule;
    if listing.enabled
        && [
            "list sessions",
            "list projects",
            "list files",
            "table",
            "directory listing",
        ]
        .iter()
        .any(|keyword| context.contains(keyword))
    {
        return Some((
            "listing_output_rule",
            bounded_line_output(
                output,
                listing.max_items,
                listing.head_items,
                listing.tail_items,
                &listing.anomaly_keywords,
                listing.keep_count_summary,
            ),
        ));
    }

    let spec = &settings.instruction_and_tool_spec_rule;
    if spec.enabled
        && [
            "skill.md",
            "inputschema",
            "openapi",
            "readme",
            "tools/list",
            "cli help",
            "usage:",
        ]
        .iter()
        .any(|keyword| context.contains(keyword))
    {
        let mut priority = Vec::new();
        if spec.keep_required_fields {
            priority.extend(["required", "必填"]);
        }
        if spec.keep_safety_hints {
            priority.extend(["safety", "permission", "权限", "安全", "must", "必须"]);
        }
        if spec.keep_command_examples {
            priority.extend(["example", "示例", "```"]);
        }
        let by_lines = bounded_line_output(
            output,
            spec.max_headings + spec.max_tool_names,
            spec.max_headings,
            spec.max_tool_names,
            &priority,
            true,
        );
        let replacement =
            if by_lines == output && output.chars().count() > spec.head_chars + spec.tail_chars {
                output_stub_with_priority(output, spec.head_chars, spec.tail_chars, &priority)
            } else {
                by_lines
            };
        return Some(("instruction_and_tool_spec_rule", replacement));
    }

    let generic = &settings.generic_large_output_rule;
    (generic.enabled && output.chars().count() >= generic.min_output_chars).then(|| {
        (
            "generic_large_output_rule",
            output_stub_with(output, generic.head_chars, generic.tail_chars),
        )
    })
}

fn output_stub_with_priority(
    output: &str,
    head_chars: usize,
    tail_chars: usize,
    priority_keywords: &[impl AsRef<str>],
) -> String {
    let mut compacted = output_stub_with(output, head_chars, tail_chars);
    let priority = output
        .lines()
        .filter(|line| {
            let lower = line.to_ascii_lowercase();
            priority_keywords
                .iter()
                .any(|keyword| lower.contains(&keyword.as_ref().to_ascii_lowercase()))
        })
        .take(40)
        .collect::<Vec<_>>();
    if !priority.is_empty() {
        compacted.push_str("\n\n[ContextOS preserved priority lines]\n");
        compacted.push_str(&priority.join("\n"));
    }
    compacted
}

fn compact_patch_output(
    output: &str,
    rule: &compression_settings::PatchRule,
    priority_keywords: &[impl AsRef<str>],
) -> String {
    let mut compacted =
        output_stub_with_priority(output, rule.head_chars, rule.tail_chars, priority_keywords);
    if rule.keep_hunk_headers {
        let mut hunks = Vec::new();
        let mut hunks_in_file = 0usize;
        for line in output.lines() {
            let trimmed = line.trim_start();
            if trimmed.starts_with("diff --git")
                || trimmed.starts_with("*** Update File:")
                || trimmed.starts_with("*** Add File:")
            {
                hunks_in_file = 0;
            } else if trimmed.starts_with("@@") && hunks_in_file < rule.max_hunks_per_file {
                hunks.push(line);
                hunks_in_file += 1;
            }
        }
        if !hunks.is_empty() {
            compacted.push_str("\n\n[ContextOS preserved Hunk positions]\n");
            compacted.push_str(&hunks.join("\n"));
        }
    }
    compacted
}

fn bounded_line_output<T: AsRef<str>>(
    output: &str,
    max_lines: usize,
    head_lines: usize,
    tail_lines: usize,
    priority_keywords: &[T],
    include_notice: bool,
) -> String {
    let lines = output.lines().collect::<Vec<_>>();
    if lines.len() <= max_lines {
        return output.to_string();
    }
    let mut selected = BTreeSet::new();
    for index in 0..head_lines.min(lines.len()) {
        selected.insert(index);
    }
    for index in lines.len().saturating_sub(tail_lines)..lines.len() {
        selected.insert(index);
    }
    for (index, line) in lines.iter().enumerate() {
        let lower = line.to_ascii_lowercase();
        if priority_keywords
            .iter()
            .any(|keyword| lower.contains(&keyword.as_ref().to_ascii_lowercase()))
        {
            selected.insert(index);
        }
        if selected.len() >= max_lines {
            break;
        }
    }
    let kept = selected
        .into_iter()
        .take(max_lines)
        .map(|index| lines[index])
        .collect::<Vec<_>>();
    let mut result = kept.join("\n");
    if include_notice {
        result.push_str(&format!(
            "\n\n[ContextOS mechanically omitted lines; original {} lines]",
            lines.len()
        ));
    }
    result
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

fn candidate_details<'a>(details: &'a [Detail], settings: &RuntimeSettings) -> Vec<&'a Detail> {
    let min_chars = settings.jev_strategy.jev_candidate_min_chars;
    details
        .iter()
        .filter(|detail| is_jev_candidate(detail, settings, min_chars))
        .collect()
}

fn is_jev_candidate(detail: &Detail, settings: &RuntimeSettings, min_chars: usize) -> bool {
    if min_chars == 0 {
        return false;
    }
    let permitted = match body_candidate_role(detail) {
        Some("assistant") => settings.mechanical.allow_jev_delete_assistant_body,
        Some("user") => settings.mechanical.allow_jev_delete_user_messages,
        Some(_) => false,
        None => {
            settings
                .mechanical
                .generic_large_output_rule
                .mark_jev_candidate
        }
    };
    permitted
        && candidate_content(detail).is_some_and(|content| content.chars().count() >= min_chars)
}

fn should_discard_body_candidate(
    role: &str,
    action: JevAction,
    decision_was_made: bool,
    allow_assistant: bool,
    allow_user: bool,
) -> bool {
    let allowed = match role {
        "assistant" => allow_assistant,
        "user" => allow_user,
        _ => false,
    };
    allowed && decision_was_made && action == JevAction::Discard
}

fn assess_candidates(
    markdown: &str,
    meta: &SessionMeta,
    settings: &RuntimeSettings,
) -> Result<(Vec<CandidateAssessment>, DecisionDiagnostics)> {
    let details = parse_details(markdown);
    let candidates = candidate_details(&details, settings);
    if candidates.is_empty() {
        return Ok((Vec::new(), DecisionDiagnostics::default()));
    }
    if !settings.jev_enabled {
        return Ok((
            vec![CandidateAssessment::default(); candidates.len()],
            DecisionDiagnostics::default(),
        ));
    }
    match systemone_transport(settings.decision_provider, settings.laya_runtime_mode) {
        SystemOneTransport::Batch => assess_laya_batch(settings, meta, &candidates),
        SystemOneTransport::Single => assess_systemone_single(settings, meta, &candidates),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SystemOneTransport {
    Batch,
    Single,
}

fn systemone_transport(
    provider: DecisionModelProvider,
    laya_runtime_mode: LayaRuntimeMode,
) -> SystemOneTransport {
    match (provider, laya_runtime_mode) {
        (DecisionModelProvider::Laya, LayaRuntimeMode::Managed) => SystemOneTransport::Batch,
        (DecisionModelProvider::Laya, LayaRuntimeMode::External)
        | (DecisionModelProvider::Jev, _) => SystemOneTransport::Single,
    }
}

fn decision_request_format(settings: &RuntimeSettings) -> &'static str {
    match (settings.decision_provider, settings.laya_runtime_mode) {
        (DecisionModelProvider::Laya, LayaRuntimeMode::Managed) => "systemone_batch",
        (DecisionModelProvider::Laya, LayaRuntimeMode::External) => "systemone_single_compat",
        (DecisionModelProvider::Jev, _) => "systemone_single",
    }
}

fn assessment_questions(settings: &RuntimeSettings) -> Value {
    let criteria = settings
        .jev_strategy
        .jev_score_levels
        .iter()
        .map(|level| format!("{}：执行 {:?}", level.label, level.action))
        .collect::<Vec<_>>();
    json!({
        "preservation_level": {
            "type": "score",
            "instructions": settings.jev_strategy.jev_prompt_template,
            "criteria": criteria
        },
        "irreplaceable_evidence": {
            "type": "noul",
            "instructions": "这段输出是否包含难以从其他上下文恢复、重新生成或可靠概括的关键证据？例如唯一错误现场、补丁、验证结果、精确路径、版本或环境事实。"
        }
    })
}

fn candidate_state(
    detail: &Detail,
    meta: &SessionMeta,
    settings: &RuntimeSettings,
    max_output_chars: usize,
) -> Value {
    let raw_output = candidate_content(detail).unwrap_or_default();
    let mechanical_output = if body_candidate_role(detail).is_some() {
        raw_output.clone()
    } else {
        mechanical_output_replacement(detail, &raw_output, &settings.mechanical)
            .map(|(_, replacement)| replacement)
            .unwrap_or_else(|| raw_output.clone())
    };
    json!({
        "conversation": {
            "title": meta.title,
            "agent": meta.agent.display_name(),
            "project": meta.project_path
        },
        "tool_output": {
            "summary": detail.summary,
            "content": clip_middle(&mechanical_output, max_output_chars),
            "mechanical_chars": mechanical_output.chars().count(),
            "original_chars": raw_output.chars().count(),
            "truncated": mechanical_output.chars().count() > max_output_chars
        }
    })
}

fn clip_middle(value: &str, max_chars: usize) -> String {
    let count = value.chars().count();
    if count <= max_chars {
        return value.to_string();
    }
    let head_chars = max_chars * 2 / 3;
    let tail_chars = max_chars.saturating_sub(head_chars);
    let head = value.chars().take(head_chars).collect::<String>();
    let tail = value
        .chars()
        .rev()
        .take(tail_chars)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<String>();
    format!("{head}\n\n[ContextOS clipped candidate; original {count} chars]\n\n{tail}")
}

fn assess_laya_batch(
    settings: &RuntimeSettings,
    meta: &SessionMeta,
    details: &[&Detail],
) -> Result<(Vec<CandidateAssessment>, DecisionDiagnostics)> {
    let mut assessments = Vec::with_capacity(details.len());
    let mut diagnostics = DecisionDiagnostics::default();
    let questions = assessment_questions(settings);
    let batch_size = jev_batch_size(settings.jev_strategy.jev_request_char_limit);
    let max_output_chars =
        jev_candidate_char_budget(settings.jev_strategy.jev_request_char_limit, batch_size);
    for chunk in details.chunks(batch_size) {
        let states = chunk
            .iter()
            .map(|detail| candidate_state(detail, meta, settings, max_output_chars))
            .collect::<Vec<_>>();
        let body = json!({
            "model": settings.decision_model,
            "states": states,
            "questions": questions
        });
        diagnostics.requests += 1;
        let Some(value) = post_decision_json(settings, &body, true)? else {
            assessments.extend(vec![CandidateAssessment::default(); chunk.len()]);
            continue;
        };
        let results = value
            .get("results")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for index in 0..chunk.len() {
            let result = results.get(index).unwrap_or(&Value::Null);
            collect_usage(result.get("usage"), &mut diagnostics);
            let assessment = parse_assessment(result, settings);
            collect_confidence(&assessment, &mut diagnostics);
            assessments.push(assessment);
        }
        if let Some(total) = value.get("total_usage") {
            let total_tokens = total
                .get("input_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            if total_tokens > 0 {
                diagnostics.input_tokens = diagnostics.input_tokens.saturating_sub(
                    results
                        .iter()
                        .filter_map(|result| {
                            result
                                .pointer("/usage/input_tokens")
                                .and_then(Value::as_u64)
                        })
                        .sum::<u64>(),
                ) + total_tokens;
            }
        }
    }
    Ok((assessments, diagnostics))
}

fn assess_systemone_single(
    settings: &RuntimeSettings,
    meta: &SessionMeta,
    details: &[&Detail],
) -> Result<(Vec<CandidateAssessment>, DecisionDiagnostics)> {
    let mut assessments = Vec::with_capacity(details.len());
    let mut diagnostics = DecisionDiagnostics::default();
    let batch_size = jev_batch_size(settings.jev_strategy.jev_request_char_limit);
    let max_output_chars =
        jev_candidate_char_budget(settings.jev_strategy.jev_request_char_limit, batch_size);
    for chunk in details.chunks(batch_size) {
        let states = chunk
            .iter()
            .enumerate()
            .map(|(index, detail)| {
                (
                    format!("candidate_{}", index + 1),
                    candidate_state(detail, meta, settings, max_output_chars),
                )
            })
            .collect::<serde_json::Map<_, _>>();
        let mut questions = serde_json::Map::new();
        for index in 0..chunk.len() {
            let number = index + 1;
            questions.insert(format!("preservation_{number}"), json!({
                "type": "score",
                "instructions": format!("只评估 state.candidate_{number}。{}", settings.jev_strategy.jev_prompt_template),
                "criteria": settings.jev_strategy.jev_score_levels.iter().map(|level| level.label.clone()).collect::<Vec<_>>()
            }));
            questions.insert(format!("irreplaceable_{number}"), json!({
                "type": "noul",
                "instructions": format!("state.candidate_{number} 是否包含难以从其他上下文恢复、重新生成或可靠概括的关键证据？")
            }));
        }
        let body = json!({
            "model": settings.decision_model,
            "state": states,
            "questions": questions
        });
        diagnostics.requests += 1;
        let Some(value) = post_decision_json(settings, &body, false)? else {
            assessments.extend(vec![CandidateAssessment::default(); chunk.len()]);
            continue;
        };
        collect_usage(value.get("usage"), &mut diagnostics);
        for index in 0..chunk.len() {
            let assessment = parse_named_assessment(&value, index + 1, settings);
            collect_confidence(&assessment, &mut diagnostics);
            assessments.push(assessment);
        }
    }
    Ok((assessments, diagnostics))
}

fn jev_batch_size(request_char_limit: usize) -> usize {
    match request_char_limit {
        0..=20_000 => 1,
        20_001..=50_000 => 2,
        _ => 3,
    }
}

fn jev_candidate_char_budget(request_char_limit: usize, batch_size: usize) -> usize {
    request_char_limit
        .saturating_sub(4_000)
        .checked_div(batch_size.saturating_mul(2).max(1))
        .unwrap_or_default()
        .clamp(256, 12_000)
}

fn post_decision_json(
    settings: &RuntimeSettings,
    body: &Value,
    batch: bool,
) -> Result<Option<Value>> {
    if body.to_string().len() > settings.jev_strategy.jev_request_char_limit {
        if settings.jev_strategy.jev_fallback_on_error == JevFallback::UseMechanical {
            eprintln!("ContextOS {} request exceeds the configured request budget; using mechanical fallback", settings.decision_provider.display_name());
            return Ok(None);
        }
        bail!(
            "{} request exceeds the configured request budget",
            settings.decision_provider.display_name()
        );
    }
    let endpoint = laya_runtime::systemone_endpoint(&settings.jev_url, batch)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(settings.jev_timeout))
        .build()?;
    let mut request = client.post(endpoint).json(body);
    if !settings.jev_key.trim().is_empty() {
        request = request.bearer_auth(settings.jev_key.trim());
    }
    let response = match request.send() {
        Ok(response) => response,
        Err(error) if settings.jev_strategy.jev_fallback_on_error == JevFallback::UseMechanical => {
            eprintln!(
                "ContextOS {} request failed; using mechanical fallback: {error}",
                settings.decision_provider.display_name()
            );
            return Ok(None);
        }
        Err(error) => return Err(error.into()),
    };
    let status = response.status();
    let text = response.text()?;
    if !status.is_success() {
        if settings.jev_strategy.jev_fallback_on_error == JevFallback::UseMechanical {
            eprintln!(
                "ContextOS {} API returned {status}; using mechanical fallback: {text}",
                settings.decision_provider.display_name()
            );
            return Ok(None);
        }
        bail!(
            "{} API returned {status}: {text}",
            settings.decision_provider.display_name()
        );
    }
    match serde_json::from_str(text.trim_start_matches('\u{feff}')) {
        Ok(value) => Ok(Some(value)),
        Err(error) if settings.jev_strategy.jev_fallback_on_error == JevFallback::UseMechanical => {
            eprintln!(
                "ContextOS {} response parse failed; using mechanical fallback: {error}",
                settings.decision_provider.display_name()
            );
            Ok(None)
        }
        Err(error) => Err(error.into()),
    }
}

fn parse_assessment(value: &Value, settings: &RuntimeSettings) -> CandidateAssessment {
    let max_index = settings
        .jev_strategy
        .jev_score_levels
        .len()
        .saturating_sub(1)
        .max(1) as f64;
    CandidateAssessment {
        preservation_score: value
            .pointer("/answers/preservation_level/score")
            .and_then(Value::as_f64)
            .map(|score| (score / max_index).clamp(0.0, 1.0)),
        irreplaceable_evidence: value
            .pointer("/answers/irreplaceable_evidence/noul")
            .and_then(Value::as_f64)
            .map(|score| score.clamp(0.0, 1.0)),
        confidence: value
            .pointer("/answers/preservation_level/answer_confidence")
            .and_then(Value::as_f64),
    }
}

fn parse_named_assessment(
    value: &Value,
    number: usize,
    settings: &RuntimeSettings,
) -> CandidateAssessment {
    let max_index = settings
        .jev_strategy
        .jev_score_levels
        .len()
        .saturating_sub(1)
        .max(1) as f64;
    CandidateAssessment {
        preservation_score: value
            .pointer(&format!("/answers/preservation_{number}/score"))
            .and_then(Value::as_f64)
            .map(|score| (score / max_index).clamp(0.0, 1.0)),
        irreplaceable_evidence: value
            .pointer(&format!("/answers/irreplaceable_{number}/noul"))
            .and_then(Value::as_f64)
            .map(|score| score.clamp(0.0, 1.0)),
        confidence: value
            .pointer(&format!("/answers/preservation_{number}/answer_confidence"))
            .and_then(Value::as_f64),
    }
}

fn collect_usage(usage: Option<&Value>, diagnostics: &mut DecisionDiagnostics) {
    let Some(usage) = usage else {
        return;
    };
    diagnostics.input_tokens += usage
        .get("input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if usage
        .get("truncated")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        diagnostics.truncated += 1;
    }
}

fn collect_confidence(assessment: &CandidateAssessment, diagnostics: &mut DecisionDiagnostics) {
    if let Some(confidence) = assessment.confidence {
        diagnostics.confidence_sum += confidence;
        diagnostics.confidence_count += 1;
    }
}

fn finalize_decisions(turns: &[PendingTurn], settings: &RuntimeSettings) -> Vec<Vec<JevDecision>> {
    if !settings.jev_enabled {
        return turns
            .iter()
            .map(|turn| {
                vec![
                    JevDecision {
                        level_id: "disabled".into(),
                        action: JevAction::UseMechanical,
                    };
                    turn.assessments.len()
                ]
            })
            .collect();
    }

    let mut scored = Vec::new();
    for (turn_index, turn) in turns.iter().enumerate() {
        for (candidate_index, assessment) in turn.assessments.iter().enumerate() {
            if let Some(score) = assessment.combined_score() {
                scored.push((turn_index, candidate_index, score));
            }
        }
    }
    let mut decisions = turns
        .iter()
        .map(|turn| jev_fallback_decisions(turn.assessments.len()))
        .collect::<Vec<_>>();
    if scored.is_empty() {
        return decisions;
    }

    let relative_enabled =
        settings.jev_strategy.scoring_mode == DecisionScoringMode::Relative && scored.len() >= 5;
    let mut percentiles = HashMap::new();
    if relative_enabled {
        let mut ordered = scored.clone();
        ordered.sort_by(|left, right| left.2.total_cmp(&right.2));
        let denominator = ordered.len().saturating_sub(1).max(1) as f64;
        let mut start = 0;
        while start < ordered.len() {
            let mut end = start + 1;
            while end < ordered.len() && (ordered[end].2 - ordered[start].2).abs() < 1e-9 {
                end += 1;
            }
            let percentile = ((start + end - 1) as f64 / 2.0) / denominator;
            for item in &ordered[start..end] {
                percentiles.insert((item.0, item.1), percentile);
            }
            start = end;
        }
    }
    let min_score = scored
        .iter()
        .map(|item| item.2)
        .fold(f64::INFINITY, f64::min);
    let max_score = scored
        .iter()
        .map(|item| item.2)
        .fold(f64::NEG_INFINITY, f64::max);
    let span = max_score - min_score;
    let relative_strength = if span < 0.03 {
        0.04
    } else if span < 0.10 {
        0.08
    } else {
        0.15
    };

    for (turn_index, candidate_index, absolute_score) in scored {
        let mut final_score = absolute_score;
        if let Some(percentile) = percentiles.get(&(turn_index, candidate_index)) {
            final_score =
                (absolute_score + (percentile - 0.5) * 2.0 * relative_strength).clamp(0.0, 1.0);
        }
        let absolute = action_for_score(absolute_score, &settings.jev_strategy.jev_score_levels);
        let relative = action_for_score(final_score, &settings.jev_strategy.jev_score_levels);
        let absolute_index =
            decision_level_index(&absolute, &settings.jev_strategy.jev_score_levels);
        let mut final_index =
            decision_level_index(&relative, &settings.jev_strategy.jev_score_levels)
                .max(absolute_index.saturating_sub(1));
        let assessment = &turns[turn_index].assessments[candidate_index];
        if assessment.irreplaceable_evidence.unwrap_or(0.0) >= 0.80 {
            final_index = final_index.max(action_level_index(
                JevAction::Evidence,
                &settings.jev_strategy.jev_score_levels,
            ));
        }
        if assessment.preservation_score.unwrap_or(0.0) >= 0.90 {
            final_index = final_index.max(action_level_index(
                JevAction::Expanded,
                &settings.jev_strategy.jev_score_levels,
            ));
        }
        decisions[turn_index][candidate_index] =
            decision_for_level_index(final_index, &settings.jev_strategy.jev_score_levels);
    }
    decisions
}

fn decision_level_index(decision: &JevDecision, levels: &[JevScoreLevel]) -> usize {
    levels
        .iter()
        .position(|level| level.id == decision.level_id)
        .unwrap_or(0)
}

fn action_level_index(action: JevAction, levels: &[JevScoreLevel]) -> usize {
    levels
        .iter()
        .position(|level| level.action == action)
        .unwrap_or(0)
}

fn decision_for_level_index(index: usize, levels: &[JevScoreLevel]) -> JevDecision {
    levels
        .get(index.min(levels.len().saturating_sub(1)))
        .map(|level| JevDecision {
            level_id: level.id.clone(),
            action: level.action,
        })
        .unwrap_or(JevDecision {
            level_id: "fallback".into(),
            action: JevAction::UseMechanical,
        })
}

fn jev_fallback_decisions(count: usize) -> Vec<JevDecision> {
    vec![
        JevDecision {
            level_id: "fallback".into(),
            action: JevAction::UseMechanical,
        };
        count
    ]
}

fn action_for_score(score: f64, levels: &[JevScoreLevel]) -> JevDecision {
    levels
        .iter()
        .find(|level| score <= level.max_score)
        .map(|level| JevDecision {
            level_id: level.id.clone(),
            action: level.action,
        })
        .unwrap_or(JevDecision {
            level_id: "fallback".into(),
            action: JevAction::UseMechanical,
        })
}

fn call_llm(
    settings: &RuntimeSettings,
    metas: &[SessionMeta],
    store: &Store,
    markdown: &str,
    generate_memory_candidates: bool,
    relationship_context: &str,
    continuation_context: &str,
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
    let markdown_with_context = if continuation_context.is_empty() {
        markdown.to_string()
    } else {
        format!(
            "<existing-summary-context>\n{}\n</existing-summary-context>\n\n\
             The block above is read-only continuity context. Do not repeat or rewrite it. \
             Produce only the continuation derived from the new turns below.\n\n\
             <new-turns>\n{}\n</new-turns>",
            continuation_context, markdown
        )
    };
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
            ("markdown", markdown_with_context.as_str()),
            ("memory_candidate_contract", memory_output),
        ],
    );
    let prompt = format!(
        "{prompt}\n\n# Decision annotations\nPreserve every `> Jev/Laya 分级：...` line in the output and keep it directly beside its associated retained fragment. Do not merge annotations from different fragments."
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
            "block_count": block_count, "characters_sent": markdown_with_context.chars().count(),
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

#[cfg(test)]
mod systemone_transport_tests {
    use super::*;

    #[test]
    fn processing_report_lists_grade_for_each_candidate_fragment() {
        let result = RunResult {
            markdown: String::new(),
            mode: "mechanical+jev".into(),
            memory_candidates: Vec::new(),
            stats: json!({
                "decision": {
                    "enabled": true,
                    "provider": "Jev",
                    "model": "test-model",
                    "fragments": [{
                        "source": "codex:test",
                        "turn": 2,
                        "fragment": "🔧 Bash — cargo test",
                        "grade": "关键证据",
                        "action": "关键证据"
                    }]
                }
            }),
        };

        let report = result.processing_report_markdown();

        assert!(report.contains("## Jev/Laya 片段分级"));
        assert!(report.contains("`codex:test` / 2|🔧 Bash — cargo test|关键证据|关键证据"));
    }

    #[test]
    fn managed_laya_uses_batch_and_external_laya_uses_single() {
        assert_eq!(
            systemone_transport(DecisionModelProvider::Laya, LayaRuntimeMode::Managed),
            SystemOneTransport::Batch
        );
        assert_eq!(
            systemone_transport(DecisionModelProvider::Laya, LayaRuntimeMode::External),
            SystemOneTransport::Single
        );
        assert_eq!(
            systemone_transport(DecisionModelProvider::Jev, LayaRuntimeMode::Managed),
            SystemOneTransport::Single
        );
    }

    #[test]
    fn decision_batches_shrink_with_the_configured_request_budget() {
        assert_eq!(jev_batch_size(10_000), 1);
        assert_eq!(jev_batch_size(30_000), 2);
        assert_eq!(jev_batch_size(80_000), 3);
        assert!(jev_candidate_char_budget(30_000, 2) < 12_000);
    }

    #[test]
    fn body_deletion_requires_matching_permission_and_a_real_discard_decision() {
        assert!(should_discard_body_candidate(
            "user",
            JevAction::Discard,
            true,
            false,
            true
        ));
        assert!(!should_discard_body_candidate(
            "user",
            JevAction::Discard,
            true,
            true,
            false
        ));
        assert!(!should_discard_body_candidate(
            "assistant",
            JevAction::Discard,
            false,
            true,
            true
        ));
        assert!(!should_discard_body_candidate(
            "assistant",
            JevAction::Expanded,
            true,
            true,
            true
        ));
    }

    #[test]
    fn each_fragment_annotation_uses_the_configured_grade_and_action() {
        let decision = JevDecision {
            level_id: "evidence".into(),
            action: JevAction::Evidence,
        };
        let levels = vec![JevScoreLevel {
            id: "evidence".into(),
            label: "关键证据级".into(),
            max_score: 0.8,
            action: JevAction::Evidence,
        }];
        assert_eq!(
            decision_annotation_for_levels(&decision, &levels),
            "> Jev/Laya 分级：关键证据级 · 保留动作：关键证据"
        );
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
