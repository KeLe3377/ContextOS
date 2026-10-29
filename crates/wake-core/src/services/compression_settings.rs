use std::collections::{HashMap, HashSet};

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::db::Store;
use crate::services::compression::{self, RunOverrides, DEFAULT_LLM_INPUT_LIMIT_CHARS};
use crate::services::laya_runtime::LayaRuntimeMode;

pub const PROVIDERS_V2_KEY: &str = "compression_llm_providers_v2";
pub const ACTIVE_PROVIDER_ID_KEY: &str = "compression_llm_active_provider_id";
pub const DECISION_PROVIDER_KEY: &str = "compression_decision_provider";
pub const DECISION_MODEL_KEY: &str = "compression_decision_model";
pub const LAYA_RUNTIME_MODE_KEY: &str = "compression_laya_runtime_mode";
pub const EXTERNAL_LAYA_API_URL_KEY: &str = "compression_external_laya_api_url";
const EXTERNAL_LAYA_API_KEY_KEY: &str = "compression_external_laya_api_key";
const MECHANICAL_KEY: &str = "compression_strategy_mechanical_v1";
const JEV_STRATEGY_KEY: &str = "compression_strategy_jev_v1";
const LLM_PROMPT_KEY: &str = "compression_strategy_llm_prompt_v1";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LlmProviderConfig {
    pub id: String,
    pub name: String,
    pub api_url: String,
    pub api_key: String,
    pub model: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LlmProviderPublic {
    pub id: String,
    pub name: String,
    pub api_url: String,
    pub model: String,
    pub api_key_configured: bool,
    pub active: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DecisionModelProvider {
    #[default]
    Jev,
    Laya,
}

impl DecisionModelProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Jev => "jev",
            Self::Laya => "laya",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Self::Jev => "Jev",
            Self::Laya => "Laya",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "jev" => Some(Self::Jev),
            "laya" => Some(Self::Laya),
            _ => None,
        }
    }

    pub fn default_model(self) -> &'static str {
        match self {
            Self::Jev => "jev-latest",
            Self::Laya => "laya-multilingual",
        }
    }

    pub fn requires_api_key(self) -> bool {
        matches!(self, Self::Jev)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CompressionServiceSettings {
    pub llm_enabled: bool,
    pub llm_providers: Vec<LlmProviderConfig>,
    pub active_llm_provider_id: String,
    pub llm_timeout_secs: u64,
    pub llm_input_limit_chars: usize,
    pub jev_enabled: bool,
    pub decision_provider: DecisionModelProvider,
    pub decision_model: String,
    pub laya_runtime_mode: LayaRuntimeMode,
    pub external_laya_api_url: String,
    pub external_laya_api_key: String,
    pub jev_api_url: String,
    pub jev_api_key: String,
    pub jev_timeout_secs: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CompressionServicePublic {
    pub llm_enabled: bool,
    pub llm_providers: Vec<LlmProviderPublic>,
    pub active_llm_provider_id: String,
    pub llm_timeout_secs: u64,
    pub llm_input_limit_chars: usize,
    pub jev_enabled: bool,
    pub decision_provider: DecisionModelProvider,
    pub decision_model: String,
    pub laya_runtime_mode: LayaRuntimeMode,
    pub external_laya_api_url: String,
    pub external_laya_api_key_configured: bool,
    pub jev_api_url: String,
    pub jev_api_key_configured: bool,
    pub jev_timeout_secs: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CompressionStrategySettings {
    pub mechanical: MechanicalStrategySettings,
    pub jev: JevStrategySettings,
    pub llm: LlmPromptSettings,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CompressionSettingsPublic {
    pub service: CompressionServicePublic,
    pub strategy: CompressionStrategySettings,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FullCompressionSettings {
    pub service: CompressionServiceSettings,
    pub strategy: CompressionStrategySettings,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RuntimeCompressionSettings {
    pub service: CompressionServiceSettings,
    pub strategy: CompressionStrategySettings,
}

impl RuntimeCompressionSettings {
    pub fn mode(&self) -> &'static str {
        match (
            self.service.jev_enabled,
            self.service.llm_enabled,
            self.service.decision_provider,
        ) {
            (false, false, _) => "mechanical",
            (false, true, _) => "mechanical+llm",
            (true, false, DecisionModelProvider::Jev) => "mechanical+jev",
            (true, true, DecisionModelProvider::Jev) => "mechanical+jev+llm",
            (true, false, DecisionModelProvider::Laya) => "mechanical+laya",
            (true, true, DecisionModelProvider::Laya) => "mechanical+laya+llm",
        }
    }

    pub fn active_provider(&self) -> Option<&LlmProviderConfig> {
        self.service
            .llm_providers
            .iter()
            .find(|provider| provider.id == self.service.active_llm_provider_id)
            .or_else(|| self.service.llm_providers.first())
    }

    pub fn validate(&self) -> Result<()> {
        if self.service.jev_enabled {
            let provider = self.service.decision_provider;
            let connection_missing = match provider {
                DecisionModelProvider::Jev => {
                    self.service.jev_api_url.trim().is_empty()
                        || self.service.jev_api_key.trim().is_empty()
                }
                DecisionModelProvider::Laya => {
                    self.service.laya_runtime_mode == LayaRuntimeMode::External
                        && self.service.external_laya_api_url.trim().is_empty()
                }
            };
            if connection_missing || self.service.decision_model.trim().is_empty() {
                bail!(
                    "{} is enabled but its API URL, model, or required API key is not configured",
                    provider.display_name()
                );
            }
        }
        if self.service.llm_enabled {
            let Some(provider) = self.active_provider() else {
                bail!("LLM is enabled but no provider is configured");
            };
            if provider.api_url.trim().is_empty()
                || provider.api_key.trim().is_empty()
                || provider.model.trim().is_empty()
            {
                bail!("LLM is enabled but its API URL, key, or model is not configured");
            }
        }
        validate_llm_templates(&self.strategy.llm)?;
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MechanicalStrategySettings {
    #[serde(default)]
    pub retention_mode: MechanicalRetentionMode,
    #[serde(default)]
    pub allow_jev_delete_assistant_body: bool,
    #[serde(default)]
    pub allow_jev_delete_user_messages: bool,
    #[serde(default = "default_expanded_max_chars")]
    pub expanded_max_chars: usize,
    #[serde(default = "default_evidence_max_chars")]
    pub evidence_max_chars: usize,
    pub empty_output_rule: EmptyOutputRule,
    pub error_protection_rule: ErrorProtectionRule,
    pub patch_rule: PatchRule,
    pub source_listing_rule: SourceListingRule,
    pub search_output_rule: SearchOutputRule,
    pub listing_output_rule: ListingOutputRule,
    pub instruction_and_tool_spec_rule: InstructionAndToolSpecRule,
    pub generic_large_output_rule: GenericLargeOutputRule,
}

fn default_expanded_max_chars() -> usize {
    6_000
}

fn default_evidence_max_chars() -> usize {
    2_000
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MechanicalRetentionMode {
    #[default]
    FullMechanical,
    BodyOnly,
    BodyWithStructure,
}

impl MechanicalRetentionMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FullMechanical => "full_mechanical",
            Self::BodyOnly => "body_only",
            Self::BodyWithStructure => "body_with_structure",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::FullMechanical => "完整机械裁剪",
            Self::BodyOnly => "正文",
            Self::BodyWithStructure => "正文 + 结构摘要",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EmptyOutputRule {
    pub enabled: bool,
    pub drop_empty_output: bool,
    pub success_output_max_chars: usize,
    pub write_stdin_max_chars: usize,
    pub keep_exit_code_line: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ErrorProtectionRule {
    pub enabled: bool,
    pub head_chars: usize,
    pub tail_chars: usize,
    pub keep_command: bool,
    pub keep_exit_code: bool,
    pub keep_failure_lines: bool,
    pub failure_keywords: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PatchRule {
    pub enabled: bool,
    pub head_chars: usize,
    pub tail_chars: usize,
    pub keep_file_headers: bool,
    pub keep_hunk_headers: bool,
    pub max_hunks_per_file: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SourceListingRule {
    pub enabled: bool,
    pub max_lines: usize,
    pub keep_query_summary: bool,
    pub keep_file_headers: bool,
    pub keep_blast_radius: bool,
    pub keep_staleness_warnings: bool,
    pub head_chars: usize,
    pub tail_chars: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SearchOutputRule {
    pub enabled: bool,
    pub max_matches: usize,
    pub head_matches: usize,
    pub tail_matches: usize,
    pub keep_truncated_notice: bool,
    pub priority_keywords: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ListingOutputRule {
    pub enabled: bool,
    pub max_items: usize,
    pub head_items: usize,
    pub tail_items: usize,
    pub keep_count_summary: bool,
    pub anomaly_keywords: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InstructionAndToolSpecRule {
    pub enabled: bool,
    pub max_headings: usize,
    pub max_tool_names: usize,
    pub keep_required_fields: bool,
    pub keep_safety_hints: bool,
    pub keep_command_examples: bool,
    pub head_chars: usize,
    pub tail_chars: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GenericLargeOutputRule {
    pub enabled: bool,
    pub min_output_chars: usize,
    pub head_chars: usize,
    pub tail_chars: usize,
    pub mark_jev_candidate: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct JevStrategySettings {
    pub jev_request_char_limit: usize,
    pub jev_candidate_min_chars: usize,
    pub jev_prompt_template: String,
    pub jev_fallback_on_error: JevFallback,
    #[serde(default)]
    pub scoring_mode: DecisionScoringMode,
    pub jev_score_levels: Vec<JevScoreLevel>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DecisionScoringMode {
    Absolute,
    #[default]
    Relative,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JevFallback {
    UseMechanical,
    Fail,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct JevScoreLevel {
    pub id: String,
    pub label: String,
    pub max_score: f64,
    pub action: JevAction,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JevAction {
    Discard,
    Stub,
    UseMechanical,
    Evidence,
    Expanded,
    Verbatim,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LlmPromptSettings {
    pub single_strategy: String,
    pub memory_generation_strategy: String,
    pub multi_strategy: String,
    pub tag_strategy: String,
    pub tag_specific_strategies: HashMap<String, String>,
    pub relation_strategy: String,
    pub llm_system_message: String,
    pub llm_task_template: String,
    pub llm_user_prompt_template: String,
    pub llm_memory_candidate_contract: String,
    pub llm_temperature: f64,
}

pub fn load_runtime_settings(
    store: &Store,
    overrides: &RunOverrides,
) -> RuntimeCompressionSettings {
    let mut settings = load_settings(store);
    if let Some(enabled) = overrides.jev_enabled {
        settings.service.jev_enabled = enabled;
    }
    if let Some(enabled) = overrides.llm_enabled {
        settings.service.llm_enabled = enabled;
    }
    RuntimeCompressionSettings {
        service: settings.service,
        strategy: settings.strategy,
    }
}

pub fn load_settings(store: &Store) -> FullCompressionSettings {
    FullCompressionSettings {
        service: load_service_settings(store),
        strategy: CompressionStrategySettings {
            mechanical: load_json_pref(store, MECHANICAL_KEY).unwrap_or_else(default_mechanical),
            jev: load_json_pref(store, JEV_STRATEGY_KEY)
                .map(migrate_jev_strategy)
                .unwrap_or_else(default_jev_strategy),
            llm: load_llm_prompt_settings(store),
        },
    }
}

pub fn public_settings(store: &Store) -> Value {
    let settings = load_settings(store);
    serde_json::to_value(CompressionSettingsPublic {
        service: public_service(&settings.service),
        strategy: settings.strategy,
    })
    .unwrap_or_else(|_| json!({}))
}

pub fn update_settings(
    store: &Store,
    data: Option<&Value>,
    reset_defaults: Option<&Value>,
) -> Result<()> {
    if let Some(value) = data {
        reject_api_keys(value)?;
    }
    if let Some(paths) = reset_defaults {
        apply_resets(store, paths)?;
    }
    if let Some(value) = data {
        let object = value
            .as_object()
            .ok_or_else(|| anyhow::anyhow!("`data` must be an object"))?;
        if let Some(service) = object.get("service") {
            update_service(store, service)?;
        }
        if let Some(strategy) = object.get("strategy") {
            update_strategy(store, strategy)?;
        }
        update_legacy_flat(store, object)?;
        for key in object.keys() {
            if key != "service" && key != "strategy" && !is_legacy_flat_key(key) {
                bail!("unknown compression setting `{key}`");
            }
        }
    }
    Ok(())
}

fn load_service_settings(store: &Store) -> CompressionServiceSettings {
    let providers = load_providers_v2(store);
    let active = store
        .pref_get(ACTIVE_PROVIDER_ID_KEY)
        .filter(|id| providers.iter().any(|provider| provider.id == *id))
        .unwrap_or_else(|| providers.first().map(|p| p.id.clone()).unwrap_or_default());
    let decision_provider = store
        .pref_get(DECISION_PROVIDER_KEY)
        .as_deref()
        .and_then(DecisionModelProvider::parse)
        .unwrap_or_default();
    let decision_model = store
        .pref_get(DECISION_MODEL_KEY)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| decision_provider.default_model().into());
    let legacy_url = store.pref_get("jev_api_url").unwrap_or_default();
    let legacy_key = store.pref_get("jev_api_key").unwrap_or_default();
    let saved_laya_runtime_mode = store.pref_get(LAYA_RUNTIME_MODE_KEY);
    let legacy_laya_config = saved_laya_runtime_mode.is_none()
        && decision_provider == DecisionModelProvider::Laya
        && !legacy_url.trim().is_empty();
    let laya_runtime_mode = saved_laya_runtime_mode
        .as_deref()
        .and_then(LayaRuntimeMode::parse)
        .unwrap_or_else(|| {
            if legacy_laya_config {
                LayaRuntimeMode::External
            } else {
                LayaRuntimeMode::Managed
            }
        });
    let external_laya_api_url = store
        .pref_get(EXTERNAL_LAYA_API_URL_KEY)
        .unwrap_or_else(|| {
            if legacy_laya_config {
                legacy_url.clone()
            } else {
                String::new()
            }
        });
    let external_laya_api_key = store
        .pref_get(EXTERNAL_LAYA_API_KEY_KEY)
        .unwrap_or_else(|| {
            if legacy_laya_config {
                legacy_key.clone()
            } else {
                String::new()
            }
        });
    CompressionServiceSettings {
        llm_enabled: pref_bool(store, "compression_llm_enabled", true),
        llm_providers: providers,
        active_llm_provider_id: active,
        llm_timeout_secs: pref_u64(store, "compression_llm_timeout_secs", 600).clamp(30, 3600),
        llm_input_limit_chars: pref_u64(
            store,
            "compression_llm_input_limit_chars",
            DEFAULT_LLM_INPUT_LIMIT_CHARS as u64,
        )
        .max(1) as usize,
        jev_enabled: pref_bool(store, "compression_jev_enabled", false),
        decision_provider,
        decision_model,
        laya_runtime_mode,
        external_laya_api_url,
        external_laya_api_key,
        jev_api_url: legacy_url,
        jev_api_key: legacy_key,
        jev_timeout_secs: pref_u64(store, "jev_timeout_secs", 60).clamp(10, 1800),
    }
}

fn load_providers_v2(store: &Store) -> Vec<LlmProviderConfig> {
    if let Some(mut providers) = store
        .pref_get(PROVIDERS_V2_KEY)
        .and_then(|raw| serde_json::from_str::<Vec<LlmProviderConfig>>(&raw).ok())
        .filter(|providers| !providers.is_empty())
    {
        normalize_provider_ids(&mut providers);
        return providers;
    }
    let mut migrated = legacy_providers(store);
    if migrated.is_empty() {
        migrated.push(LlmProviderConfig {
            id: "default".into(),
            name: "Provider 1".into(),
            api_url: store
                .pref_get("compression_llm_api_url")
                .unwrap_or_default(),
            api_key: store
                .pref_get("compression_llm_api_key")
                .unwrap_or_default(),
            model: store
                .pref_get("compression_llm_model")
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "gpt-4.1-mini".into()),
        });
    }
    normalize_provider_ids(&mut migrated);
    migrated
}

fn legacy_providers(store: &Store) -> Vec<LlmProviderConfig> {
    let legacy = store
        .pref_get("compression_llm_providers")
        .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
        .unwrap_or_default();
    let active_index = store
        .pref_get("compression_llm_active_provider")
        .and_then(|raw| raw.parse::<usize>().ok())
        .unwrap_or(0);
    let mut providers = legacy
        .iter()
        .enumerate()
        .filter_map(|(index, value)| {
            let name =
                text_field(value, "name").unwrap_or_else(|| format!("Provider {}", index + 1));
            let api_url = text_field(value, "api_url").unwrap_or_default();
            let api_key = text_field(value, "api_key").unwrap_or_default();
            let model = text_field(value, "model").unwrap_or_else(|| "gpt-4.1-mini".into());
            let is_active = index == active_index;
            let has_data = [api_url.as_str(), api_key.as_str(), model.as_str()]
                .iter()
                .any(|value| !value.trim().is_empty() && *value != "gpt-4.1-mini")
                || is_active;
            has_data.then(|| LlmProviderConfig {
                id: stable_provider_id(&name, index),
                name,
                api_url,
                api_key,
                model,
            })
        })
        .collect::<Vec<_>>();
    if let Some(first) = providers.first_mut() {
        if first.api_url.trim().is_empty() {
            first.api_url = store
                .pref_get("compression_llm_api_url")
                .unwrap_or_default();
        }
        if first.api_key.trim().is_empty() {
            first.api_key = store
                .pref_get("compression_llm_api_key")
                .unwrap_or_default();
        }
        if first.model.trim().is_empty() || first.model == "gpt-4.1-mini" {
            if let Some(model) = store
                .pref_get("compression_llm_model")
                .filter(|value| !value.trim().is_empty())
            {
                first.model = model;
            }
        }
    }
    providers
}

fn public_service(settings: &CompressionServiceSettings) -> CompressionServicePublic {
    CompressionServicePublic {
        llm_enabled: settings.llm_enabled,
        llm_providers: settings
            .llm_providers
            .iter()
            .map(|provider| LlmProviderPublic {
                id: provider.id.clone(),
                name: provider.name.clone(),
                api_url: provider.api_url.clone(),
                model: provider.model.clone(),
                api_key_configured: !provider.api_key.trim().is_empty(),
                active: provider.id == settings.active_llm_provider_id,
            })
            .collect(),
        active_llm_provider_id: settings.active_llm_provider_id.clone(),
        llm_timeout_secs: settings.llm_timeout_secs,
        llm_input_limit_chars: settings.llm_input_limit_chars,
        jev_enabled: settings.jev_enabled,
        decision_provider: settings.decision_provider,
        decision_model: settings.decision_model.clone(),
        laya_runtime_mode: settings.laya_runtime_mode,
        external_laya_api_url: settings.external_laya_api_url.clone(),
        external_laya_api_key_configured: !settings.external_laya_api_key.trim().is_empty(),
        jev_api_url: settings.jev_api_url.clone(),
        jev_api_key_configured: !settings.jev_api_key.trim().is_empty(),
        jev_timeout_secs: settings.jev_timeout_secs,
    }
}

fn update_service(store: &Store, value: &Value) -> Result<()> {
    let object = value
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("`service` must be an object"))?;
    let mut service = load_service_settings(store);
    for (key, value) in object {
        match key.as_str() {
            "llm_enabled" => service.llm_enabled = bool_value(key, value)?,
            "llm_providers" => {
                let mut incoming = serde_json::from_value::<Vec<LlmProviderConfig>>(value.clone())?;
                for provider in &mut incoming {
                    provider.api_key.clear();
                }
                merge_public_providers(&mut service.llm_providers, incoming);
            }
            "active_llm_provider_id" => {
                let id = string_value(key, value)?;
                if !service
                    .llm_providers
                    .iter()
                    .any(|provider| provider.id == id)
                {
                    bail!("`active_llm_provider_id` does not match a provider");
                }
                service.active_llm_provider_id = id;
            }
            "llm_timeout_secs" => {
                service.llm_timeout_secs = u64_value(key, value)?.clamp(30, 3600);
            }
            "llm_input_limit_chars" => {
                service.llm_input_limit_chars = usize_value(key, value)?.max(1);
            }
            "jev_enabled" => service.jev_enabled = bool_value(key, value)?,
            "decision_provider" => {
                let provider = string_value(key, value)?;
                service.decision_provider =
                    DecisionModelProvider::parse(&provider).ok_or_else(|| {
                        anyhow::anyhow!("`decision_provider` must be `jev` or `laya`")
                    })?;
            }
            "decision_model" => service.decision_model = string_value(key, value)?,
            "laya_runtime_mode" => {
                let mode = string_value(key, value)?;
                service.laya_runtime_mode = LayaRuntimeMode::parse(&mode).ok_or_else(|| {
                    anyhow::anyhow!("`laya_runtime_mode` must be `managed` or `external`")
                })?;
            }
            "external_laya_api_url" => {
                service.external_laya_api_url = string_value(key, value)?;
            }
            "jev_api_url" => service.jev_api_url = string_value(key, value)?,
            "jev_timeout_secs" => {
                service.jev_timeout_secs = u64_value(key, value)?.clamp(10, 1800);
            }
            "jev_api_key" | "external_laya_api_key" | "api_key" => {
                bail!("API keys cannot be changed through MCP/CLI")
            }
            _ => bail!("unknown compression service setting `{key}`"),
        }
    }
    save_service_settings(store, &service, false)
}

fn merge_public_providers(existing: &mut Vec<LlmProviderConfig>, incoming: Vec<LlmProviderConfig>) {
    let mut by_id = existing
        .iter()
        .map(|provider| (provider.id.clone(), provider.api_key.clone()))
        .collect::<HashMap<_, _>>();
    let mut providers = incoming
        .into_iter()
        .map(|mut provider| {
            provider.api_key = by_id.remove(&provider.id).unwrap_or_default();
            if provider.model.trim().is_empty() {
                provider.model = "gpt-4.1-mini".into();
            }
            provider
        })
        .collect::<Vec<_>>();
    if providers.is_empty() {
        providers.push(default_provider());
    }
    normalize_provider_ids(&mut providers);
    *existing = providers;
}

pub fn save_service_settings(
    store: &Store,
    service: &CompressionServiceSettings,
    write_api_keys: bool,
) -> Result<()> {
    let mut providers = service.llm_providers.clone();
    normalize_provider_ids(&mut providers);
    if providers.is_empty() {
        providers.push(default_provider());
    }
    let active = if providers
        .iter()
        .any(|provider| provider.id == service.active_llm_provider_id)
    {
        service.active_llm_provider_id.clone()
    } else {
        providers.first().map(|p| p.id.clone()).unwrap_or_default()
    };
    store.pref_set("compression_llm_enabled", bool_str(service.llm_enabled))?;
    store.pref_set("compression_jev_enabled", bool_str(service.jev_enabled))?;
    store.pref_set(DECISION_PROVIDER_KEY, service.decision_provider.as_str())?;
    store.pref_set(DECISION_MODEL_KEY, service.decision_model.trim())?;
    store.pref_set(LAYA_RUNTIME_MODE_KEY, service.laya_runtime_mode.as_str())?;
    store.pref_set(
        EXTERNAL_LAYA_API_URL_KEY,
        service.external_laya_api_url.trim(),
    )?;
    store.pref_set(
        "compression_llm_timeout_secs",
        &service.llm_timeout_secs.to_string(),
    )?;
    store.pref_set(
        "compression_llm_input_limit_chars",
        &service.llm_input_limit_chars.to_string(),
    )?;
    store.pref_set("jev_api_url", service.jev_api_url.trim())?;
    store.pref_set("jev_timeout_secs", &service.jev_timeout_secs.to_string())?;
    if write_api_keys {
        store.pref_set("jev_api_key", service.jev_api_key.trim())?;
        store.pref_set(
            EXTERNAL_LAYA_API_KEY_KEY,
            service.external_laya_api_key.trim(),
        )?;
    }
    store.pref_set(PROVIDERS_V2_KEY, &serde_json::to_string(&providers)?)?;
    store.pref_set(ACTIVE_PROVIDER_ID_KEY, &active)?;
    if let Some(active_provider) = providers.iter().find(|provider| provider.id == active) {
        store.pref_set("compression_llm_api_url", active_provider.api_url.trim())?;
        if write_api_keys {
            store.pref_set("compression_llm_api_key", active_provider.api_key.trim())?;
        }
        store.pref_set("compression_llm_model", active_provider.model.trim())?;
    }
    Ok(())
}

fn update_strategy(store: &Store, value: &Value) -> Result<()> {
    let object = value
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("`strategy` must be an object"))?;
    for (key, value) in object {
        match key.as_str() {
            "mechanical" => {
                let current = serde_json::to_value(
                    load_json_pref::<MechanicalStrategySettings>(store, MECHANICAL_KEY)
                        .unwrap_or_else(default_mechanical),
                )?;
                let merged = merge_patch(current, value.clone())?;
                let settings: MechanicalStrategySettings = serde_json::from_value(merged)?;
                validate_mechanical(&settings)?;
                store.pref_set(MECHANICAL_KEY, &serde_json::to_string(&settings)?)?;
            }
            "jev" => {
                let current = serde_json::to_value(
                    load_json_pref::<JevStrategySettings>(store, JEV_STRATEGY_KEY)
                        .map(migrate_jev_strategy)
                        .unwrap_or_else(default_jev_strategy),
                )?;
                let merged = merge_patch(current, value.clone())?;
                let settings: JevStrategySettings = serde_json::from_value(merged)?;
                validate_jev_strategy(&settings)?;
                store.pref_set(JEV_STRATEGY_KEY, &serde_json::to_string(&settings)?)?;
            }
            "llm" => {
                update_llm_settings(store, value)?;
            }
            _ => bail!("unknown compression strategy setting `{key}`"),
        }
    }
    Ok(())
}

fn update_llm_settings(store: &Store, value: &Value) -> Result<()> {
    let current = serde_json::to_value(load_llm_prompt_settings(store))?;
    let merged = merge_patch(current, value.clone())?;
    let settings: LlmPromptSettings = serde_json::from_value(merged)?;
    validate_llm_templates(&settings)?;
    save_llm_prompt_settings(store, &settings)
}

fn update_legacy_flat(store: &Store, object: &Map<String, Value>) -> Result<()> {
    let mut service_patch = Map::new();
    let mut llm_patch = Map::new();
    for (key, value) in object {
        match key.as_str() {
            "llm_enabled"
            | "jev_enabled"
            | "decision_provider"
            | "decision_model"
            | "laya_runtime_mode"
            | "external_laya_api_url"
            | "llm_timeout_secs"
            | "llm_input_limit_chars"
            | "jev_api_url"
            | "jev_timeout_secs" => {
                service_patch.insert(key.clone(), value.clone());
            }
            "llm_provider_index" => {
                let index = usize_value(key, value)?;
                let service = load_service_settings(store);
                let id = service
                    .llm_providers
                    .get(index)
                    .map(|provider| provider.id.clone())
                    .ok_or_else(|| anyhow::anyhow!("`llm_provider_index` is out of range"))?;
                service_patch.insert("active_llm_provider_id".into(), Value::String(id));
            }
            "llm_provider_name" | "llm_api_url" | "llm_model" => {
                let service = load_service_settings(store);
                let mut providers = service.llm_providers.clone();
                let active = service.active_llm_provider_id.clone();
                let Some(provider_index) = providers
                    .iter()
                    .position(|provider| provider.id == active)
                    .or_else(|| (!providers.is_empty()).then_some(0))
                else {
                    continue;
                };
                let provider = &mut providers[provider_index];
                let text = string_value(key, value)?;
                match key.as_str() {
                    "llm_provider_name" => provider.name = text,
                    "llm_api_url" => provider.api_url = text,
                    _ => provider.model = text,
                }
                service_patch.insert("llm_providers".into(), serde_json::to_value(providers)?);
            }
            "single_strategy"
            | "memory_generation_strategy"
            | "multi_strategy"
            | "tag_strategy"
            | "tag_specific_strategies"
            | "relation_strategy" => {
                llm_patch.insert(key.clone(), value.clone());
            }
            _ => {}
        }
    }
    if !service_patch.is_empty() {
        update_service(store, &Value::Object(service_patch))?;
    }
    if !llm_patch.is_empty() {
        let mut strategy = Map::new();
        strategy.insert("llm".into(), Value::Object(llm_patch));
        update_strategy(store, &Value::Object(strategy))?;
    }
    Ok(())
}

fn is_legacy_flat_key(key: &str) -> bool {
    matches!(
        key,
        "llm_enabled"
            | "jev_enabled"
            | "decision_provider"
            | "decision_model"
            | "laya_runtime_mode"
            | "external_laya_api_url"
            | "llm_timeout_secs"
            | "llm_input_limit_chars"
            | "jev_api_url"
            | "jev_timeout_secs"
            | "llm_provider_index"
            | "llm_provider_name"
            | "llm_api_url"
            | "llm_model"
            | "single_strategy"
            | "memory_generation_strategy"
            | "multi_strategy"
            | "tag_strategy"
            | "tag_specific_strategies"
            | "relation_strategy"
    )
}

fn apply_resets(store: &Store, value: &Value) -> Result<()> {
    let paths = value
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("`reset_defaults` must be an array"))?;
    for path in paths {
        let path = path
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("reset paths must be strings"))?;
        match path {
            "strategy.mechanical" => store.pref_set(
                MECHANICAL_KEY,
                &serde_json::to_string(&default_mechanical())?,
            )?,
            "strategy.mechanical.empty_output_rule" => reset_mechanical_rule(store, path)?,
            "strategy.mechanical.error_protection_rule" => reset_mechanical_rule(store, path)?,
            "strategy.mechanical.patch_rule" => reset_mechanical_rule(store, path)?,
            "strategy.mechanical.source_listing_rule" => reset_mechanical_rule(store, path)?,
            "strategy.mechanical.search_output_rule" => reset_mechanical_rule(store, path)?,
            "strategy.mechanical.listing_output_rule" => reset_mechanical_rule(store, path)?,
            "strategy.mechanical.instruction_and_tool_spec_rule" => {
                reset_mechanical_rule(store, path)?
            }
            "strategy.mechanical.generic_large_output_rule" => reset_mechanical_rule(store, path)?,
            "strategy.jev" => store.pref_set(
                JEV_STRATEGY_KEY,
                &serde_json::to_string(&default_jev_strategy())?,
            )?,
            "strategy.jev.jev_score_levels" => reset_jev_field(store, "jev_score_levels")?,
            "strategy.jev.jev_prompt_template" => reset_jev_field(store, "jev_prompt_template")?,
            "strategy.llm" => save_llm_prompt_settings(store, &default_llm_prompt_settings())?,
            "strategy.llm.llm_user_prompt_template" => {
                reset_llm_field(store, "llm_user_prompt_template")?
            }
            "strategy.llm.llm_system_message" => reset_llm_field(store, "llm_system_message")?,
            "strategy.llm.llm_task_template" => reset_llm_field(store, "llm_task_template")?,
            "strategy.llm.llm_memory_candidate_contract" => {
                reset_llm_field(store, "llm_memory_candidate_contract")?
            }
            _ => bail!("unknown reset path `{path}`"),
        }
    }
    Ok(())
}

fn reset_mechanical_rule(store: &Store, path: &str) -> Result<()> {
    let mut current = load_json_pref::<MechanicalStrategySettings>(store, MECHANICAL_KEY)
        .unwrap_or_else(default_mechanical);
    let defaults = default_mechanical();
    match path.rsplit('.').next().unwrap_or_default() {
        "empty_output_rule" => current.empty_output_rule = defaults.empty_output_rule,
        "error_protection_rule" => current.error_protection_rule = defaults.error_protection_rule,
        "patch_rule" => current.patch_rule = defaults.patch_rule,
        "source_listing_rule" => current.source_listing_rule = defaults.source_listing_rule,
        "search_output_rule" => current.search_output_rule = defaults.search_output_rule,
        "listing_output_rule" => current.listing_output_rule = defaults.listing_output_rule,
        "instruction_and_tool_spec_rule" => {
            current.instruction_and_tool_spec_rule = defaults.instruction_and_tool_spec_rule
        }
        "generic_large_output_rule" => {
            current.generic_large_output_rule = defaults.generic_large_output_rule
        }
        _ => bail!("unknown mechanical reset path `{path}`"),
    }
    store.pref_set(MECHANICAL_KEY, &serde_json::to_string(&current)?)?;
    Ok(())
}

fn reset_jev_field(store: &Store, field: &str) -> Result<()> {
    let mut current = load_json_pref::<JevStrategySettings>(store, JEV_STRATEGY_KEY)
        .map(migrate_jev_strategy)
        .unwrap_or_else(default_jev_strategy);
    let defaults = default_jev_strategy();
    match field {
        "jev_score_levels" => current.jev_score_levels = defaults.jev_score_levels,
        "jev_prompt_template" => current.jev_prompt_template = defaults.jev_prompt_template,
        _ => bail!("unknown Jev reset field `{field}`"),
    }
    store.pref_set(JEV_STRATEGY_KEY, &serde_json::to_string(&current)?)?;
    Ok(())
}

fn reset_llm_field(store: &Store, field: &str) -> Result<()> {
    let mut current = load_llm_prompt_settings(store);
    let defaults = default_llm_prompt_settings();
    match field {
        "llm_user_prompt_template" => {
            current.llm_user_prompt_template = defaults.llm_user_prompt_template
        }
        "llm_system_message" => current.llm_system_message = defaults.llm_system_message,
        "llm_task_template" => current.llm_task_template = defaults.llm_task_template,
        "llm_memory_candidate_contract" => {
            current.llm_memory_candidate_contract = defaults.llm_memory_candidate_contract
        }
        _ => bail!("unknown LLM reset field `{field}`"),
    }
    save_llm_prompt_settings(store, &current)
}

fn load_llm_prompt_settings(store: &Store) -> LlmPromptSettings {
    let mut settings = load_json_pref::<LlmPromptSettings>(store, LLM_PROMPT_KEY)
        .unwrap_or_else(default_llm_prompt_settings);
    settings.single_strategy = store
        .pref_get("compression_strategy_single")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(compression::default_single_strategy);
    settings.memory_generation_strategy = compression::migrate_memory_generation_strategy(
        store
            .pref_get("compression_strategy_memory_generation")
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(compression::default_memory_generation_strategy),
    );
    settings.multi_strategy = store
        .pref_get("compression_strategy_multi")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(compression::default_multi_strategy);
    settings.tag_strategy = store
        .pref_get("compression_strategy_tags")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(compression::default_tag_strategy);
    settings.relation_strategy = store
        .pref_get("compression_strategy_relations")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(compression::default_relation_strategy);
    settings.tag_specific_strategies = load_tag_specific_strategies(store);
    settings
}

fn save_llm_prompt_settings(store: &Store, settings: &LlmPromptSettings) -> Result<()> {
    store.pref_set(
        "compression_strategy_single",
        settings.single_strategy.trim(),
    )?;
    store.pref_set(
        "compression_strategy_memory_generation",
        settings.memory_generation_strategy.trim(),
    )?;
    store.pref_set("compression_strategy_multi", settings.multi_strategy.trim())?;
    store.pref_set("compression_strategy_tags", settings.tag_strategy.trim())?;
    store.pref_set(
        "compression_strategy_relations",
        settings.relation_strategy.trim(),
    )?;
    let mut custom = Map::new();
    for (tag, strategy) in &settings.tag_specific_strategies {
        if compression::BUILTIN_COMPRESSION_TAGS.contains(&tag.as_str()) {
            store.pref_set(&compression::tag_strategy_key(tag), strategy.trim())?;
        } else {
            custom.insert(tag.clone(), Value::String(strategy.trim().to_string()));
        }
    }
    store.pref_set(
        "compression_strategy_tag_custom",
        &serde_json::to_string(&custom)?,
    )?;
    let outer = LlmPromptSettings {
        single_strategy: String::new(),
        memory_generation_strategy: String::new(),
        multi_strategy: String::new(),
        tag_strategy: String::new(),
        tag_specific_strategies: HashMap::new(),
        relation_strategy: String::new(),
        llm_system_message: settings.llm_system_message.clone(),
        llm_task_template: settings.llm_task_template.clone(),
        llm_user_prompt_template: settings.llm_user_prompt_template.clone(),
        llm_memory_candidate_contract: settings.llm_memory_candidate_contract.clone(),
        llm_temperature: settings.llm_temperature,
    };
    store.pref_set(LLM_PROMPT_KEY, &serde_json::to_string(&outer)?)?;
    Ok(())
}

fn load_tag_specific_strategies(store: &Store) -> HashMap<String, String> {
    let mut strategies = compression::BUILTIN_COMPRESSION_TAGS
        .into_iter()
        .map(|tag| {
            let value = store
                .pref_get(&compression::tag_strategy_key(tag))
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| compression::default_specific_tag_strategy(tag));
            (tag.to_string(), value)
        })
        .collect::<HashMap<_, _>>();
    if let Some(custom) = store
        .pref_get("compression_strategy_tag_custom")
        .and_then(|raw| serde_json::from_str::<HashMap<String, String>>(&raw).ok())
    {
        strategies.extend(custom);
    }
    strategies
}

fn default_mechanical() -> MechanicalStrategySettings {
    MechanicalStrategySettings {
        retention_mode: MechanicalRetentionMode::FullMechanical,
        allow_jev_delete_assistant_body: false,
        allow_jev_delete_user_messages: false,
        expanded_max_chars: default_expanded_max_chars(),
        evidence_max_chars: default_evidence_max_chars(),
        empty_output_rule: EmptyOutputRule {
            enabled: true,
            drop_empty_output: true,
            success_output_max_chars: 260,
            write_stdin_max_chars: 220,
            keep_exit_code_line: true,
        },
        error_protection_rule: ErrorProtectionRule {
            enabled: true,
            head_chars: 2400,
            tail_chars: 1200,
            keep_command: true,
            keep_exit_code: true,
            keep_failure_lines: true,
            failure_keywords: vec![
                "error".into(),
                "failed".into(),
                "panic".into(),
                "traceback".into(),
                "FAILED".into(),
            ],
        },
        patch_rule: PatchRule {
            enabled: true,
            head_chars: 2400,
            tail_chars: 1200,
            keep_file_headers: true,
            keep_hunk_headers: true,
            max_hunks_per_file: 8,
        },
        source_listing_rule: SourceListingRule {
            enabled: true,
            max_lines: 80,
            keep_query_summary: true,
            keep_file_headers: true,
            keep_blast_radius: true,
            keep_staleness_warnings: true,
            head_chars: 900,
            tail_chars: 500,
        },
        search_output_rule: SearchOutputRule {
            enabled: true,
            max_matches: 80,
            head_matches: 40,
            tail_matches: 20,
            keep_truncated_notice: true,
            priority_keywords: vec![
                "error".into(),
                "failed".into(),
                "session".into(),
                "path".into(),
                "TODO".into(),
            ],
        },
        listing_output_rule: ListingOutputRule {
            enabled: true,
            max_items: 80,
            head_items: 40,
            tail_items: 20,
            keep_count_summary: true,
            anomaly_keywords: vec![
                "error".into(),
                "failed".into(),
                "unknown".into(),
                "stale".into(),
                "archived".into(),
            ],
        },
        instruction_and_tool_spec_rule: InstructionAndToolSpecRule {
            enabled: true,
            max_headings: 40,
            max_tool_names: 80,
            keep_required_fields: true,
            keep_safety_hints: true,
            keep_command_examples: false,
            head_chars: 800,
            tail_chars: 500,
        },
        generic_large_output_rule: GenericLargeOutputRule {
            enabled: true,
            min_output_chars: 3000,
            head_chars: 700,
            tail_chars: 500,
            mark_jev_candidate: true,
        },
    }
}

fn default_jev_strategy() -> JevStrategySettings {
    JevStrategySettings {
        jev_request_char_limit: 45_000,
        jev_candidate_min_chars: 3_000,
        jev_prompt_template: default_jev_prompt_template(),
        jev_fallback_on_error: JevFallback::UseMechanical,
        scoring_mode: DecisionScoringMode::Relative,
        jev_score_levels: vec![
            JevScoreLevel {
                id: "discard".into(),
                label: "删除".into(),
                max_score: 0.25,
                action: JevAction::Discard,
            },
            JevScoreLevel {
                id: "stub".into(),
                label: "极简占位".into(),
                max_score: 0.45,
                action: JevAction::Stub,
            },
            JevScoreLevel {
                id: "mechanical".into(),
                label: "机械裁剪".into(),
                max_score: 0.60,
                action: JevAction::UseMechanical,
            },
            JevScoreLevel {
                id: "evidence".into(),
                label: "关键证据".into(),
                max_score: 0.78,
                action: JevAction::Evidence,
            },
            JevScoreLevel {
                id: "expanded".into(),
                label: "扩展片段".into(),
                max_score: 0.92,
                action: JevAction::Expanded,
            },
            JevScoreLevel {
                id: "verbatim".into(),
                label: "近全文".into(),
                max_score: 1.0,
                action: JevAction::Verbatim,
            },
        ],
    }
}

fn default_jev_prompt_template() -> String {
    "判断这段工具输出在压缩后的项目交接中应保留到什么程度。重点考虑：是否包含用户目标、关键决定、未完成事项、错误与修复证据、测试或编译结果、文件路径、代码修改、版本和环境信息；降低空轮询、重复列表、可重新生成的长源码或完整说明文档的等级。只评估当前候选，不推测其他候选是否重复或已被取代。".into()
}

fn migrate_jev_strategy(mut settings: JevStrategySettings) -> JevStrategySettings {
    let legacy = "你是 ContextOS 的工具输出信息价值评估器。你的任务不是决定是否恢复全文，而是判断该 Output 在压缩交接中应该保留到什么程度。\n\n请根据以下维度给出 0.0 到 1.0 的 score：\n- 是否包含用户目标、关键决定、未完成事项或恢复上下文。\n- 是否包含错误、失败、测试结果、编译结果、异常堆栈或修复证据。\n- 是否包含文件路径、代码修改、patch、命令输出、版本/环境信息。\n- 是否只是成功退出、空轮询、重复列表、长源码全文或完整说明文档。\n\n请返回 JSON：{\"score\":0.0,\"reason\":\"简短理由\",\"evidence_hints\":[\"需要保留的关键词或片段\"]}";
    if settings.jev_prompt_template.trim() == legacy {
        settings.jev_prompt_template = default_jev_prompt_template();
    }
    settings
}

fn default_llm_prompt_settings() -> LlmPromptSettings {
    LlmPromptSettings {
        single_strategy: compression::default_single_strategy(),
        memory_generation_strategy: compression::default_memory_generation_strategy(),
        multi_strategy: compression::default_multi_strategy(),
        tag_strategy: compression::default_tag_strategy(),
        tag_specific_strategies: compression::BUILTIN_COMPRESSION_TAGS
            .into_iter()
            .map(|tag| (tag.to_string(), compression::default_specific_tag_strategy(tag)))
            .collect(),
        relation_strategy: compression::default_relation_strategy(),
        llm_system_message:
            "You are the ContextOS compression engine. Preserve actionable facts and uncertainty."
                .into(),
        llm_task_template:
            "Compress these ContextOS sessions into a factual engineering handoff. Do not invent facts."
                .into(),
        llm_user_prompt_template: "# Task\n{{task}}{{memory_candidate_contract}}\n\n# Strategy\n{{strategy}}\n\n# Tag strategy\n{{tag_strategy}}\n\n# Relationship strategy\n{{relationship_strategy}}\n\n# Block\n{{block_number}}/{{block_count}}; complete turns only: {{turns_json}}\n\n# Sources\n{{sources}}\n\n# Session Markdown\n{{markdown}}".into(),
        llm_memory_candidate_contract: "\n\n# Memory candidate output\nAfter the compressed Markdown, append exactly one fenced `contextos-json` block:\n\n```contextos-json\n{\"memory_candidates\":[{\"kind\":\"decision|rule|todo|project_fact|resume_hint\",\"title\":\"short title\",\"content\":\"durable fact\",\"scope\":\"user|project\",\"target\":\"optional target\",\"reason\":\"why this matters\",\"trigger\":\"when it applies\",\"boundary\":\"when it does not apply\",\"next_action\":\"optional next action\",\"related_paths\":[\"path\"],\"evidence\":\"source evidence\",\"confidence\":\"high|medium|low\"}]}\n```\n\nReturn an empty array when there is no durable candidate. Candidates are suggestions only and are never saved automatically.".into(),
        llm_temperature: 0.2,
    }
}

fn validate_mechanical(settings: &MechanicalStrategySettings) -> Result<()> {
    ensure_positive(settings.expanded_max_chars, "expanded_max_chars")?;
    ensure_positive(settings.evidence_max_chars, "evidence_max_chars")?;
    ensure_positive(
        settings.error_protection_rule.head_chars,
        "error_protection_rule.head_chars",
    )?;
    ensure_positive(
        settings.error_protection_rule.tail_chars,
        "error_protection_rule.tail_chars",
    )?;
    ensure_positive(
        settings.patch_rule.max_hunks_per_file,
        "patch_rule.max_hunks_per_file",
    )?;
    ensure_positive(
        settings.source_listing_rule.max_lines,
        "source_listing_rule.max_lines",
    )?;
    ensure_positive(
        settings.search_output_rule.max_matches,
        "search_output_rule.max_matches",
    )?;
    ensure_positive(
        settings.listing_output_rule.max_items,
        "listing_output_rule.max_items",
    )?;
    ensure_positive(
        settings.generic_large_output_rule.min_output_chars,
        "generic_large_output_rule.min_output_chars",
    )?;
    Ok(())
}

fn validate_jev_strategy(settings: &JevStrategySettings) -> Result<()> {
    ensure_positive(settings.jev_request_char_limit, "jev_request_char_limit")?;
    ensure_positive(settings.jev_candidate_min_chars, "jev_candidate_min_chars")?;
    if settings.jev_score_levels.is_empty() {
        bail!("`jev_score_levels` must not be empty");
    }
    let mut previous = 0.0;
    let mut ids = HashSet::new();
    for level in &settings.jev_score_levels {
        if !ids.insert(level.id.trim().to_string()) {
            bail!("duplicate Jev score level id `{}`", level.id);
        }
        if !(0.0..=1.0).contains(&level.max_score) || level.max_score < previous {
            bail!("Jev score levels must be sorted within 0.0..=1.0");
        }
        previous = level.max_score;
    }
    if (previous - 1.0).abs() > f64::EPSILON {
        bail!("last Jev score level must end at 1.0");
    }
    Ok(())
}

fn validate_llm_templates(settings: &LlmPromptSettings) -> Result<()> {
    if !settings.llm_user_prompt_template.contains("{{markdown}}") {
        bail!("`llm_user_prompt_template` must contain {{markdown}}");
    }
    if !settings.llm_user_prompt_template.contains("{{strategy}}") {
        bail!("`llm_user_prompt_template` must contain {{strategy}}");
    }
    if !(0.0..=2.0).contains(&settings.llm_temperature) {
        bail!("`llm_temperature` must be between 0.0 and 2.0");
    }
    let known = [
        "task",
        "strategy",
        "tag_strategy",
        "relationship_strategy",
        "block_number",
        "block_count",
        "turns_json",
        "sources",
        "markdown",
        "memory_candidate_contract",
    ];
    for variable in template_variables(&settings.llm_user_prompt_template) {
        if !known.contains(&variable.as_str()) {
            bail!("unknown LLM prompt template variable `{{{{{variable}}}}}`");
        }
    }
    Ok(())
}

fn template_variables(template: &str) -> Vec<String> {
    let mut vars = Vec::new();
    let mut cursor = 0;
    while let Some(start) = template[cursor..].find("{{") {
        let start = cursor + start + 2;
        let Some(end) = template[start..].find("}}") else {
            break;
        };
        vars.push(template[start..start + end].trim().to_string());
        cursor = start + end + 2;
    }
    vars
}

fn merge_patch(mut base: Value, patch: Value) -> Result<Value> {
    match (&mut base, patch) {
        (Value::Object(base), Value::Object(patch)) => {
            for (key, value) in patch {
                if value.is_null() {
                    bail!("`null` is not supported for `{key}`; use reset_defaults");
                }
                let merged = if let Some(existing) = base.remove(&key) {
                    merge_patch(existing, value)?
                } else {
                    value
                };
                base.insert(key, merged);
            }
            Ok(Value::Object(base.clone()))
        }
        (_, value) => Ok(value),
    }
}

fn reject_api_keys(value: &Value) -> Result<()> {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                if key.contains("api_key") {
                    bail!("API keys cannot be changed through MCP/CLI");
                }
                reject_api_keys(value)?;
            }
        }
        Value::Array(items) => {
            for item in items {
                reject_api_keys(item)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn load_json_pref<T: for<'de> Deserialize<'de>>(store: &Store, key: &str) -> Option<T> {
    store
        .pref_get(key)
        .and_then(|raw| serde_json::from_str::<T>(&raw).ok())
}

fn pref_bool(store: &Store, key: &str, default: bool) -> bool {
    store
        .pref_get(key)
        .map(|value| value == "true")
        .unwrap_or(default)
}

fn pref_u64(store: &Store, key: &str, default: u64) -> u64 {
    store
        .pref_get(key)
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(default)
}

fn text_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn bool_value(name: &str, value: &Value) -> Result<bool> {
    value
        .as_bool()
        .ok_or_else(|| anyhow::anyhow!("`{name}` must be a boolean"))
}

fn string_value(name: &str, value: &Value) -> Result<String> {
    value
        .as_str()
        .map(str::trim)
        .map(str::to_string)
        .ok_or_else(|| anyhow::anyhow!("`{name}` must be a string"))
}

fn u64_value(name: &str, value: &Value) -> Result<u64> {
    value
        .as_u64()
        .filter(|value| *value > 0)
        .ok_or_else(|| anyhow::anyhow!("`{name}` must be a positive integer"))
}

fn usize_value(name: &str, value: &Value) -> Result<usize> {
    usize::try_from(u64_value(name, value)?).map_err(|_| anyhow::anyhow!("`{name}` is too large"))
}

fn ensure_positive(value: usize, name: &str) -> Result<()> {
    if value == 0 {
        bail!("`{name}` must be greater than zero");
    }
    Ok(())
}

fn bool_str(value: bool) -> &'static str {
    if value {
        "true"
    } else {
        "false"
    }
}

fn default_provider() -> LlmProviderConfig {
    LlmProviderConfig {
        id: "default".into(),
        name: "Provider 1".into(),
        api_url: String::new(),
        api_key: String::new(),
        model: "gpt-4.1-mini".into(),
    }
}

fn normalize_provider_ids(providers: &mut [LlmProviderConfig]) {
    let mut seen = HashSet::new();
    for (index, provider) in providers.iter_mut().enumerate() {
        if provider.id.trim().is_empty() {
            provider.id = stable_provider_id(&provider.name, index);
        }
        provider.id = provider.id.trim().to_string();
        if !seen.insert(provider.id.clone()) {
            provider.id = format!("{}-{}", provider.id, index + 1);
            seen.insert(provider.id.clone());
        }
        if provider.name.trim().is_empty() {
            provider.name = format!("Provider {}", index + 1);
        }
        if provider.model.trim().is_empty() {
            provider.model = "gpt-4.1-mini".into();
        }
    }
}

fn stable_provider_id(name: &str, index: usize) -> String {
    let mut id = name
        .chars()
        .filter_map(|c| {
            if c.is_ascii_alphanumeric() {
                Some(c.to_ascii_lowercase())
            } else if c.is_whitespace() || c == '-' || c == '_' {
                Some('-')
            } else {
                None
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    if id.is_empty() {
        id = format!("provider-{}", index + 1);
    }
    id
}

#[cfg(test)]
mod laya_runtime_mode_tests {
    use super::*;

    fn store() -> (tempfile::TempDir, Store) {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::open(&temp.path().join("settings.db")).unwrap();
        (temp, store)
    }

    #[test]
    fn legacy_laya_url_migrates_to_external_behavior() {
        let (_temp, store) = store();
        store.pref_set(DECISION_PROVIDER_KEY, "laya").unwrap();
        store
            .pref_set("jev_api_url", "http://127.0.0.1:1337")
            .unwrap();
        let service = load_settings(&store).service;
        assert_eq!(service.laya_runtime_mode, LayaRuntimeMode::External);
        assert_eq!(service.external_laya_api_url, "http://127.0.0.1:1337");
    }

    #[test]
    fn saved_laya_mode_does_not_reuse_jev_connection() {
        let (_temp, store) = store();
        store.pref_set(DECISION_PROVIDER_KEY, "laya").unwrap();
        store.pref_set(LAYA_RUNTIME_MODE_KEY, "external").unwrap();
        store
            .pref_set("jev_api_url", "https://jev.example.test")
            .unwrap();
        store.pref_set("jev_api_key", "jev-secret").unwrap();

        let service = load_settings(&store).service;

        assert_eq!(service.laya_runtime_mode, LayaRuntimeMode::External);
        assert!(service.external_laya_api_url.is_empty());
        assert!(service.external_laya_api_key.is_empty());
        assert_eq!(service.jev_api_url, "https://jev.example.test");
        assert_eq!(service.jev_api_key, "jev-secret");
    }

    #[test]
    fn url_less_laya_defaults_to_managed() {
        let (_temp, store) = store();
        store.pref_set(DECISION_PROVIDER_KEY, "laya").unwrap();
        let service = load_settings(&store).service;
        assert_eq!(service.laya_runtime_mode, LayaRuntimeMode::Managed);
        assert!(service.external_laya_api_url.is_empty());
    }

    #[test]
    fn structured_settings_expose_and_update_laya_provider_fields() {
        let (_temp, store) = store();
        update_settings(
            &store,
            Some(&json!({
                "service": {
                    "decision_provider": "laya",
                    "decision_model": "laya-multilingual",
                    "laya_runtime_mode": "managed"
                }
            })),
            None,
        )
        .unwrap();

        let public = public_settings(&store);
        assert_eq!(
            public.pointer("/service/decision_provider"),
            Some(&json!("laya"))
        );
        assert_eq!(
            public.pointer("/service/decision_model"),
            Some(&json!("laya-multilingual"))
        );
        let service = load_settings(&store).service;
        assert_eq!(service.decision_provider, DecisionModelProvider::Laya);
        assert_eq!(service.decision_model, "laya-multilingual");
    }
}
