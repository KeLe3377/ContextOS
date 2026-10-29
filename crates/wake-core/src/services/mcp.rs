use crate::models::AgentId;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub id: String,
    pub name: String,
    pub config: Value,
    #[serde(default)]
    pub clients: HashMap<String, bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpClientInfo {
    pub agent: String,
    pub name: String,
    pub path: String,
    pub server_count: usize,
    pub error: Option<String>,
}

#[derive(Clone, Copy)]
enum Format {
    Json,
    Toml,
    Yaml,
}

#[derive(Clone, Copy)]
struct ClientSpec {
    agent: AgentId,
    relative_path: &'static str,
    format: Format,
    servers_key: &'static str,
}

const CLIENTS: &[ClientSpec] = &[
    ClientSpec {
        agent: AgentId::ClaudeCode,
        relative_path: ".claude.json",
        format: Format::Json,
        servers_key: "mcpServers",
    },
    ClientSpec {
        agent: AgentId::Codex,
        relative_path: ".codex/config.toml",
        format: Format::Toml,
        servers_key: "mcp_servers",
    },
    ClientSpec {
        agent: AgentId::Qoder,
        relative_path: ".qoder/mcp.json",
        format: Format::Json,
        servers_key: "mcpServers",
    },
    ClientSpec {
        agent: AgentId::Copilot,
        relative_path: ".copilot/mcp-config.json",
        format: Format::Json,
        servers_key: "mcpServers",
    },
    ClientSpec {
        agent: AgentId::Cursor,
        relative_path: ".cursor/mcp.json",
        format: Format::Json,
        servers_key: "mcpServers",
    },
    ClientSpec {
        agent: AgentId::Opencode,
        relative_path: ".config/opencode/opencode.json",
        format: Format::Json,
        servers_key: "mcp",
    },
    ClientSpec {
        agent: AgentId::Kiro,
        relative_path: ".kiro/settings/mcp.json",
        format: Format::Json,
        servers_key: "mcpServers",
    },
    ClientSpec {
        agent: AgentId::Gemini,
        relative_path: ".gemini/settings.json",
        format: Format::Json,
        servers_key: "mcpServers",
    },
    ClientSpec {
        agent: AgentId::Pi,
        relative_path: ".pi/agent/mcp.json",
        format: Format::Json,
        servers_key: "mcpServers",
    },
    ClientSpec {
        agent: AgentId::Omp,
        relative_path: ".omp/agent/mcp.json",
        format: Format::Json,
        servers_key: "mcpServers",
    },
    ClientSpec {
        agent: AgentId::Grok,
        relative_path: ".grok/config.toml",
        format: Format::Toml,
        servers_key: "mcp_servers",
    },
    ClientSpec {
        agent: AgentId::Kimi,
        relative_path: ".kimi/config.toml",
        format: Format::Toml,
        servers_key: "mcp_servers",
    },
    ClientSpec {
        agent: AgentId::Antigravity,
        relative_path: ".gemini/antigravity/mcp_config.json",
        format: Format::Json,
        servers_key: "mcpServers",
    },
    ClientSpec {
        agent: AgentId::Dsh,
        relative_path: ".dsh/config.toml",
        format: Format::Toml,
        servers_key: "mcp_servers",
    },
    ClientSpec {
        agent: AgentId::Hermes,
        relative_path: ".hermes/config.yaml",
        format: Format::Yaml,
        servers_key: "mcp_servers",
    },
    ClientSpec {
        agent: AgentId::Openclaw,
        relative_path: ".openclaw/openclaw.json",
        format: Format::Json,
        servers_key: "mcpServers",
    },
    ClientSpec {
        agent: AgentId::Codebuddy,
        relative_path: ".codebuddy/mcp.json",
        format: Format::Json,
        servers_key: "mcpServers",
    },
    ClientSpec {
        agent: AgentId::Workbuddy,
        relative_path: ".workbuddy/mcp.json",
        format: Format::Json,
        servers_key: "mcpServers",
    },
    ClientSpec {
        agent: AgentId::Zcode,
        relative_path: ".zcode/mcp.json",
        format: Format::Json,
        servers_key: "mcpServers",
    },
];

fn app_home() -> Option<PathBuf> {
    dirs::home_dir()
}

fn client_path(spec: &ClientSpec) -> Option<PathBuf> {
    let home = app_home()?;
    match spec.agent {
        AgentId::ClaudeCode => Some(
            std::env::var_os("CLAUDE_CONFIG_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.clone())
                .join(".claude.json"),
        ),
        AgentId::Codex => Some(
            std::env::var_os("CODEX_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".codex"))
                .join("config.toml"),
        ),
        AgentId::Opencode => Some(
            std::env::var_os("XDG_CONFIG_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".config"))
                .join("opencode/opencode.json"),
        ),
        _ => Some(home.join(spec.relative_path)),
    }
}

fn supported(spec: &ClientSpec, detected: &[AgentId]) -> bool {
    detected.contains(&spec.agent)
}

fn server_map(value: &Value, key: &str) -> Map<String, Value> {
    value
        .get(key)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn from_opencode(mut config: Value) -> Value {
    let Some(object) = config.as_object_mut() else {
        return config;
    };
    match object
        .remove("type")
        .and_then(|value| value.as_str().map(str::to_owned))
        .as_deref()
    {
        Some("local") => {
            if let Some(Value::Array(command)) = object.remove("command") {
                let mut command = command.into_iter();
                if let Some(executable) = command.next() {
                    object.insert("command".into(), executable);
                    let args = command.collect::<Vec<_>>();
                    if !args.is_empty() {
                        object.insert("args".into(), Value::Array(args));
                    }
                }
            }
            if let Some(environment) = object.remove("environment") {
                object.insert("env".into(), environment);
            }
        }
        Some("remote") => {
            object.insert("type".into(), Value::String("http".into()));
        }
        _ => {}
    }
    object.remove("enabled");
    config
}

#[derive(Debug, Clone)]
pub struct PastedMcpServer {
    pub id: Option<String>,
    pub config: Value,
}

fn looks_like_server_config(value: &Value) -> bool {
    value.as_object().is_some_and(|object| {
        object.contains_key("url")
            || object
                .get("command")
                .is_some_and(|command| command.is_string() || command.is_array())
            || matches!(
                object.get("type").and_then(Value::as_str),
                Some("local" | "remote")
            )
    })
}

fn is_opencode_config(value: &Value) -> bool {
    value.as_object().is_some_and(|object| {
        matches!(
            object.get("type").and_then(Value::as_str),
            Some("local" | "remote")
        ) || object.get("command").is_some_and(Value::is_array)
            || object.contains_key("environment")
    })
}

fn normalize_pasted_config(mut config: Value, opencode: bool) -> Value {
    if opencode {
        config = from_opencode(config);
    }
    let Some(object) = config.as_object_mut() else {
        return config;
    };
    if matches!(
        object.get("type").and_then(Value::as_str),
        Some("streamable-http" | "streamableHttp")
    ) {
        object.insert("type".into(), Value::String("http".into()));
    }
    if !object.contains_key("headers") {
        if let Some(headers) = object.remove("http_headers") {
            object.insert("headers".into(), headers);
        }
    }
    config
}

fn pasted_servers_from_map(value: &Value, key: &str, opencode: bool) -> Vec<PastedMcpServer> {
    value
        .get(key)
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|servers| servers.iter())
        .filter_map(|(id, config)| {
            if !looks_like_server_config(config) {
                return None;
            }
            Some(PastedMcpServer {
                id: Some(id.clone()),
                config: normalize_pasted_config(config.clone(), opencode),
            })
        })
        .collect()
}

pub fn parse_pasted_servers(text: &str) -> Result<Vec<PastedMcpServer>> {
    let text = text.trim();
    anyhow::ensure!(!text.is_empty(), "粘贴内容为空");

    if let Ok(document) = text.parse::<toml::Value>() {
        if let Some(servers) = document.get("mcp_servers").and_then(toml::Value::as_table) {
            let mut parsed = Vec::new();
            for (id, config) in servers {
                let config = serde_json::to_value(config)?;
                if looks_like_server_config(&config) {
                    parsed.push(PastedMcpServer {
                        id: Some(id.clone()),
                        config: normalize_pasted_config(config, false),
                    });
                }
            }
            anyhow::ensure!(!parsed.is_empty(), "没有找到 MCP 服务器配置");
            return Ok(parsed);
        }
    }

    let value = serde_json::from_str::<Value>(text).or_else(|_| {
        serde_json::from_str::<Value>(&format!("{{{}}}", text.trim_end_matches(',').trim()))
    })?;
    let object = value.as_object().context("MCP 配置必须是 JSON 对象")?;

    let parsed = if object.contains_key("mcpServers") {
        pasted_servers_from_map(&value, "mcpServers", false)
    } else if object.contains_key("mcp_servers") {
        pasted_servers_from_map(&value, "mcp_servers", false)
    } else if object.contains_key("mcp") {
        pasted_servers_from_map(&value, "mcp", true)
    } else if looks_like_server_config(&value) {
        vec![PastedMcpServer {
            id: None,
            config: normalize_pasted_config(value.clone(), is_opencode_config(&value)),
        }]
    } else {
        object
            .iter()
            .filter(|(_, config)| looks_like_server_config(config))
            .map(|(id, config)| PastedMcpServer {
                id: Some(id.clone()),
                config: normalize_pasted_config(config.clone(), is_opencode_config(config)),
            })
            .collect()
    };

    anyhow::ensure!(!parsed.is_empty(), "没有识别到 MCP 服务器配置");
    Ok(parsed)
}

pub fn export_mcp_servers_json(servers: &[McpServer]) -> Result<String> {
    let mut entries = Map::new();
    for server in servers {
        entries.insert(server.id.clone(), server.config.clone());
    }
    let mut root = Map::new();
    root.insert("mcpServers".into(), Value::Object(entries));
    Ok(serde_json::to_string_pretty(&Value::Object(root))?)
}

fn to_opencode(mut config: Value) -> Value {
    let Some(object) = config.as_object_mut() else {
        return config;
    };
    let kind = object
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("stdio");
    match kind {
        "stdio" => {
            object.insert("type".into(), Value::String("local".into()));
            let mut command = Vec::new();
            if let Some(executable) = object.remove("command") {
                command.push(executable);
            }
            if let Some(Value::Array(args)) = object.remove("args") {
                command.extend(args);
            }
            object.insert("command".into(), Value::Array(command));
            if let Some(environment) = object.remove("env") {
                object.insert("environment".into(), environment);
            }
        }
        "sse" | "http" => {
            object.insert("type".into(), Value::String("remote".into()));
        }
        _ => {}
    }
    object.insert("enabled".into(), Value::Bool(true));
    config
}

fn read_json(path: &Path, key: &str) -> Result<Map<String, Value>> {
    if !path.exists() {
        return Ok(Map::new());
    }
    let bytes = fs::read(path).with_context(|| format!("读取 {} 失败", path.display()))?;
    let value: Value =
        serde_json::from_slice(&bytes).with_context(|| format!("解析 {} 失败", path.display()))?;
    Ok(server_map(&value, key))
}

fn read_yaml(path: &Path, key: &str) -> Result<Map<String, Value>> {
    if !path.exists() {
        return Ok(Map::new());
    }
    let text = fs::read_to_string(path).with_context(|| format!("读取 {} 失败", path.display()))?;
    let root: serde_yaml::Value =
        serde_yaml::from_str(&text).with_context(|| format!("解析 {} 失败", path.display()))?;
    let value = serde_json::to_value(root)?;
    Ok(server_map(&value, key))
}

fn read_toml(path: &Path, key: &str) -> Result<Map<String, Value>> {
    if !path.exists() {
        return Ok(Map::new());
    }
    let text = fs::read_to_string(path).with_context(|| format!("读取 {} 失败", path.display()))?;
    let document = text
        .parse::<toml::Value>()
        .with_context(|| format!("解析 {} 失败", path.display()))?;
    let Some(table) = document.get(key).and_then(toml::Value::as_table) else {
        return Ok(Map::new());
    };
    table
        .iter()
        .map(|(id, item)| {
            let value = serde_json::to_value(item)?;
            Ok((id.to_string(), value))
        })
        .collect()
}

fn read_servers(spec: &ClientSpec, path: &Path) -> Result<Map<String, Value>> {
    let servers = match spec.format {
        Format::Json => read_json(path, spec.servers_key),
        Format::Toml => read_toml(path, spec.servers_key),
        Format::Yaml => read_yaml(path, spec.servers_key),
    }?;
    if spec.agent == AgentId::Opencode {
        Ok(servers
            .into_iter()
            .map(|(id, config)| (id, from_opencode(config)))
            .collect())
    } else {
        Ok(servers)
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().context("配置路径没有父目录")?;
    fs::create_dir_all(parent)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    temp.persist(path)
        .map(|_| ())
        .map_err(|error| error.error.into())
}

fn write_servers(spec: &ClientSpec, path: &Path, servers: &Map<String, Value>) -> Result<()> {
    let converted;
    let servers = if spec.agent == AgentId::Opencode {
        converted = servers
            .iter()
            .map(|(id, config)| (id.clone(), to_opencode(config.clone())))
            .collect::<Map<_, _>>();
        &converted
    } else {
        servers
    };
    match spec.format {
        Format::Json => {
            let mut root = if path.exists() {
                let bytes = fs::read(path)?;
                serde_json::from_slice::<Value>(&bytes)
                    .with_context(|| format!("解析 {} 失败", path.display()))?
            } else {
                Value::Object(Map::new())
            };
            let root = root.as_object_mut().context("MCP 配置根节点必须是对象")?;
            root.insert(spec.servers_key.into(), Value::Object(servers.clone()));
            write_atomic(
                path,
                serde_json::to_string_pretty(&Value::Object(root.clone()))?.as_bytes(),
            )
        }
        Format::Yaml => {
            let mut root = if path.exists() {
                serde_yaml::from_str::<serde_yaml::Value>(&fs::read_to_string(path)?)?
            } else {
                serde_yaml::Value::Mapping(serde_yaml::Mapping::new())
            };
            let root = root.as_mapping_mut().context("YAML 配置根节点必须是映射")?;
            root.insert(
                serde_yaml::Value::String(spec.servers_key.into()),
                serde_yaml::to_value(servers)?,
            );
            write_atomic(path, serde_yaml::to_string(&root)?.as_bytes())
        }
        Format::Toml => {
            let mut document = if path.exists() {
                fs::read_to_string(path)?.parse::<toml_edit::DocumentMut>()?
            } else {
                toml_edit::DocumentMut::new()
            };
            let mut table = toml::map::Map::new();
            for (id, value) in servers {
                table.insert(id.clone(), toml::Value::try_from(value.clone())?);
            }
            let mut wrapper = toml::map::Map::new();
            wrapper.insert(spec.servers_key.into(), toml::Value::Table(table));
            let wrapper = toml::Value::Table(wrapper);
            let parsed = toml::to_string(&wrapper)?.parse::<toml_edit::DocumentMut>()?;
            document[spec.servers_key] = parsed[spec.servers_key].clone();
            write_atomic(path, document.to_string().as_bytes())
        }
    }
}

pub fn client_infos(detected: &[AgentId]) -> Vec<McpClientInfo> {
    CLIENTS
        .iter()
        .filter(|spec| supported(spec, detected))
        .filter_map(|spec| {
            let path = client_path(spec)?;
            let (count, error) = match read_servers(spec, &path) {
                Ok(servers) => (servers.len(), None),
                Err(error) => (0, Some(format!("{error:#}"))),
            };
            Some(McpClientInfo {
                agent: spec.agent.as_str().into(),
                name: spec.agent.display_name().into(),
                path: path.to_string_lossy().into_owned(),
                server_count: count,
                error,
            })
        })
        .collect()
}

pub fn import_from_clients(store: &crate::db::Store, detected: &[AgentId]) -> Result<Vec<String>> {
    let existing = store.list_mcp_servers()?;
    let mut by_id = existing
        .into_iter()
        .map(|server| (server.id.clone(), server))
        .collect::<HashMap<_, _>>();
    let mut issues = Vec::new();
    for spec in CLIENTS.iter().filter(|spec| supported(spec, detected)) {
        let Some(path) = client_path(spec) else {
            continue;
        };
        let servers = match read_servers(spec, &path) {
            Ok(servers) => servers,
            Err(error) => {
                issues.push(format!("{}: {error:#}", spec.agent.display_name()));
                continue;
            }
        };
        for (id, config) in servers {
            let server = by_id.entry(id.clone()).or_insert_with(|| McpServer {
                id: id.clone(),
                name: id.clone(),
                config,
                clients: HashMap::new(),
            });
            server.clients.insert(spec.agent.as_str().into(), true);
        }
    }
    for server in by_id.values() {
        store.save_mcp_server(server)?;
    }
    Ok(issues)
}

pub fn sync_server(
    store: &crate::db::Store,
    server: &McpServer,
    agent: AgentId,
    enabled: bool,
) -> Result<()> {
    let spec = CLIENTS
        .iter()
        .find(|spec| spec.agent == agent)
        .context("该 agent 不支持 MCP 配置管理")?;
    let path = client_path(spec).context("无法确定 MCP 配置路径")?;
    let mut servers = read_servers(spec, &path)?;
    if enabled {
        servers.insert(server.id.clone(), server.config.clone());
    } else {
        servers.remove(&server.id);
    }
    write_servers(spec, &path, &servers)?;
    let mut saved = server.clone();
    saved.clients.insert(agent.as_str().into(), enabled);
    store.save_mcp_server(&saved)
}

pub fn sync_all(store: &crate::db::Store, detected: &[AgentId]) -> Vec<String> {
    let mut issues = Vec::new();
    let Ok(servers) = store.list_mcp_servers() else {
        return vec!["读取 MCP 清单失败".into()];
    };
    for spec in CLIENTS.iter().filter(|spec| supported(spec, detected)) {
        let Some(path) = client_path(spec) else {
            continue;
        };
        let mut managed = match read_servers(spec, &path) {
            Ok(servers) => servers,
            Err(error) => {
                issues.push(format!("{}: {error:#}", spec.agent.display_name()));
                continue;
            }
        };
        for server in &servers {
            if server
                .clients
                .get(spec.agent.as_str())
                .copied()
                .unwrap_or(false)
            {
                managed.insert(server.id.clone(), server.config.clone());
            } else {
                managed.remove(&server.id);
            }
        }
        match write_servers(spec, &path, &managed) {
            Ok(()) => {}
            Err(error) => issues.push(format!("{}: {error:#}", spec.agent.display_name())),
        }
    }
    issues
}

pub fn delete_server(
    store: &crate::db::Store,
    id: &str,
    detected: &[AgentId],
) -> Result<Vec<String>> {
    let server = store
        .list_mcp_servers()?
        .into_iter()
        .find(|server| server.id == id)
        .context("MCP 服务器不存在")?;
    let mut issues = Vec::new();
    for spec in CLIENTS.iter().filter(|spec| supported(spec, detected)) {
        if !server
            .clients
            .get(spec.agent.as_str())
            .copied()
            .unwrap_or(false)
        {
            continue;
        }
        let Some(path) = client_path(spec) else {
            continue;
        };
        match read_servers(spec, &path).and_then(|mut servers| {
            servers.remove(id);
            write_servers(spec, &path, &servers)
        }) {
            Ok(()) => {}
            Err(error) => issues.push(format!("{}: {error:#}", spec.agent.display_name())),
        }
    }
    store.delete_mcp_server(id)?;
    Ok(issues)
}

pub fn discovered_agents(all: &[AgentId], detected: &[AgentId]) -> Vec<AgentId> {
    let available = CLIENTS
        .iter()
        .map(|spec| spec.agent)
        .collect::<HashSet<_>>();
    all.iter()
        .copied()
        .filter(|agent| detected.contains(agent) && available.contains(agent))
        .collect()
}
