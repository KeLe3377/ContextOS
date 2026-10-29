//! User-level Agent Skills browser and editor. The filesystem is the source of truth;
//! this page never writes Skill data into the session index.

use super::*;
use gpui_component::{
    checkbox::Checkbox,
    menu::{DropdownMenu as _, PopupMenuItem},
};
use wake_core::services::mcp::{self, McpClientInfo, McpServer};
use wake_core::services::skills::{self, SkillEntry, SkillScanIssue};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(super) enum SkillsMode {
    #[default]
    Skills,
    Mcp,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum SkillsNav {
    All,
    User,
    Agent(AgentId),
    Project(String),
}

struct McpPasteItem {
    id: String,
    config: serde_json::Value,
    include: bool,
    exists: bool,
}

pub(super) struct SkillsState {
    entries: Vec<SkillEntry>,
    shown: Vec<usize>,
    issues: Vec<SkillScanIssue>,
    list_scroll: ScrollHandle,
    nav: SkillsNav,
    selected: Option<String>,
    loading: bool,
    loaded_once: bool,
    scan_task: Option<Task<()>>,
    editing_key: Option<String>,
    edit_textarea: Option<Entity<TextareaState>>,
    saving_key: Option<String>,
    mode: SkillsMode,
    mcp_servers: Vec<McpServer>,
    mcp_clients: Vec<McpClientInfo>,
    mcp_issues: Vec<String>,
    mcp_client_filter: Option<String>,
    mcp_loading: bool,
    mcp_loaded: bool,
    mcp_edit_id: Option<Entity<InputState>>,
    mcp_edit_name: Option<Entity<InputState>>,
    mcp_edit_config: Option<Entity<TextareaState>>,
    mcp_edit_original: Option<String>,
    mcp_paste_open: bool,
    mcp_paste_input: Option<Entity<TextareaState>>,
    mcp_paste_items: Vec<McpPasteItem>,
}

impl Default for SkillsState {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
            shown: Vec::new(),
            issues: Vec::new(),
            list_scroll: ScrollHandle::new(),
            nav: SkillsNav::All,
            selected: None,
            loading: false,
            loaded_once: false,
            scan_task: None,
            editing_key: None,
            edit_textarea: None,
            saving_key: None,
            mode: SkillsMode::Skills,
            mcp_servers: Vec::new(),
            mcp_clients: Vec::new(),
            mcp_issues: Vec::new(),
            mcp_client_filter: None,
            mcp_loading: false,
            mcp_loaded: false,
            mcp_edit_id: None,
            mcp_edit_name: None,
            mcp_edit_config: None,
            mcp_edit_original: None,
            mcp_paste_open: false,
            mcp_paste_input: None,
            mcp_paste_items: Vec::new(),
        }
    }
}

impl Workbench {
    pub(super) fn reset_skills_scope(&mut self, cx: &mut Context<Self>) {
        self.skills.nav = SkillsNav::All;
        self.skills.editing_key = None;
        self.skills.edit_textarea = None;
        self.rebuild_skill_rows(cx);
    }

    pub(super) fn reload_skills(&mut self, cx: &mut Context<Self>) {
        if self.page != Page::Skills
            || self.skills.mode != SkillsMode::Skills
            || self.skills.loaded_once
            || self.skills.loading
        {
            return;
        }
        self.start_skill_scan(None, cx);
    }

    pub(super) fn is_mcp_mode(&self) -> bool {
        self.skills.mode == SkillsMode::Mcp
    }

    pub(super) fn set_skills_mode(
        &mut self,
        mode: SkillsMode,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.skills.mode == mode || !self.allow_skill_navigation(window, cx) {
            return;
        }
        self.skills.mode = mode;
        if mode == SkillsMode::Mcp {
            self.skill_query.update(cx, |input, cx| {
                input.set_placeholder("搜索 MCP 名称、ID 或客户端", window, cx);
            });
            if !self.skills.mcp_loaded && !self.skills.mcp_loading {
                self.import_mcp(None, cx);
            }
        } else {
            self.skill_query.update(cx, |input, cx| {
                input.set_placeholder(t("搜索 Skill 名称、内容或路径"), window, cx);
            });
            if !self.skills.loaded_once {
                self.start_skill_scan(None, cx);
            }
        }
        cx.notify();
    }

    pub(super) fn refresh_mcp(&mut self, window: Option<AnyWindowHandle>, cx: &mut Context<Self>) {
        if self.skills.mcp_loading {
            return;
        }
        self.skills.mcp_loading = true;
        let store = self.store.clone();
        let detected = self
            .adapters
            .iter()
            .filter(|adapter| adapter.detect())
            .map(|adapter| adapter.agent())
            .collect::<Vec<_>>();
        let task = cx.background_spawn(async move {
            let servers = store.list_mcp_servers().unwrap_or_default();
            let clients = mcp::client_infos(&detected);
            (servers, clients)
        });
        cx.spawn(async move |this, cx| {
            let (servers, clients) = task.await;
            this.update(cx, |this, cx| {
                this.skills.mcp_servers = servers;
                this.skills.mcp_clients = clients;
                this.skills.mcp_loading = false;
                this.skills.mcp_loaded = true;
                cx.notify();
            })
            .ok();
            if let Some(window) = window {
                cx.update_window(window, |_, window, cx| {
                    window.push_notification(Notification::success(t("MCP 配置已刷新")), cx)
                })
                .ok();
            }
        })
        .detach();
    }

    fn import_mcp(&mut self, window: Option<AnyWindowHandle>, cx: &mut Context<Self>) {
        if self.skills.mcp_loading {
            return;
        }
        self.skills.mcp_loading = true;
        let store = self.store.clone();
        let detected = self
            .adapters
            .iter()
            .filter(|adapter| adapter.detect())
            .map(|adapter| adapter.agent())
            .collect::<Vec<_>>();
        let task = cx.background_spawn(async move {
            let issues = mcp::import_from_clients(&store, &detected)
                .unwrap_or_else(|error| vec![format!("{error:#}")]);
            (
                store.list_mcp_servers().unwrap_or_default(),
                mcp::client_infos(&detected),
                issues,
            )
        });
        cx.spawn(async move |this, cx| {
            let (servers, clients, issues) = task.await;
            this.update(cx, |this, cx| {
                this.skills.mcp_servers = servers;
                this.skills.mcp_clients = clients;
                this.skills.mcp_issues = issues.clone();
                this.skills.mcp_loading = false;
                this.skills.mcp_loaded = true;
                cx.notify();
            })
            .ok();
            if let Some(window) = window {
                cx.update_window(window, |_, window, cx| {
                    if issues.is_empty() {
                        window.push_notification(Notification::success("MCP 配置已导入"), cx);
                    } else {
                        window.push_notification(Notification::warning(issues.join("\n")), cx);
                    }
                })
                .ok();
            }
        })
        .detach();
    }

    fn resync_mcp(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.skills.mcp_loading {
            return;
        }
        self.skills.mcp_loading = true;
        let window_handle = window.window_handle();
        let store = self.store.clone();
        let detected = self
            .adapters
            .iter()
            .filter(|adapter| adapter.detect())
            .map(|adapter| adapter.agent())
            .collect::<Vec<_>>();
        let task = cx.background_spawn(async move { mcp::sync_all(&store, &detected) });
        cx.spawn_in(window, async move |this, cx| {
            let issues = task.await;
            this.update(cx, |this, cx| {
                this.skills.mcp_loading = false;
                this.skills.mcp_loaded = false;
                this.refresh_mcp(None, cx);
                cx.notify();
            })
            .ok();
            if issues.is_empty() {
                cx.update_window(window_handle, |_, window, cx| {
                    window.push_notification(Notification::success("MCP 已重新同步到客户端"), cx)
                })
                .ok();
            } else {
                cx.update_window(window_handle, |_, window, cx| {
                    window.push_notification(Notification::warning(issues.join("\n")), cx)
                })
                .ok();
            }
        })
        .detach();
    }

    fn refresh_skills(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.skills.loading || !self.allow_skill_navigation(window, cx) {
            return;
        }
        self.skills.loaded_once = false;
        self.start_skill_scan(Some(window.window_handle()), cx);
    }

    fn add_skill_project_folder(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.allow_skill_navigation(window, cx) {
            return;
        }
        let rx = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some(t("Choose").into()),
        });
        cx.spawn_in(window, async move |this, cx| {
            let directory = match rx.await {
                Ok(Ok(Some(paths))) if !paths.is_empty() => paths[0].clone(),
                Ok(Ok(_)) => return,
                Ok(Err(error)) => {
                    this.update_in(cx, |_, window, cx| {
                        window.push_notification(
                            Notification::error(crate::tf!(
                                "Could not add Skill project folder: {}",
                                error
                            )),
                            cx,
                        );
                    })
                    .ok();
                    return;
                }
                Err(error) => {
                    this.update_in(cx, |_, window, cx| {
                        window.push_notification(
                            Notification::error(crate::tf!(
                                "Could not add Skill project folder: {}",
                                error
                            )),
                            cx,
                        );
                    })
                    .ok();
                    return;
                }
            };
            this.update_in(cx, |this, window, cx| {
                let directory = match std::fs::canonicalize(&directory) {
                    Ok(path) if path.is_dir() => path,
                    Ok(_) => {
                        window.push_notification(
                            Notification::error(t("The selected path is not a folder")),
                            cx,
                        );
                        return;
                    }
                    Err(error) => {
                        window.push_notification(
                            Notification::error(crate::tf!(
                                "Could not add Skill project folder: {}",
                                error
                            )),
                            cx,
                        );
                        return;
                    }
                };
                match this.store.add_skill_project_root(&directory) {
                    Ok(true) => {
                        this.skills.loaded_once = false;
                        this.start_skill_scan(Some(window.window_handle()), cx);
                    }
                    Ok(false) => window.push_notification(
                        Notification::info(t("This Skill project folder is already added")),
                        cx,
                    ),
                    Err(error) => window.push_notification(
                        Notification::error(crate::tf!(
                            "Could not add Skill project folder: {}",
                            format!("{error:#}")
                        )),
                        cx,
                    ),
                }
            })
            .ok();
        })
        .detach();
    }

    fn start_skill_scan(&mut self, done: Option<AnyWindowHandle>, cx: &mut Context<Self>) {
        self.skills.loading = true;
        cx.notify();
        let store = self.store.clone();
        let task = cx.background_spawn(async move {
            let issue_path = store.db_dir().unwrap_or_else(|| PathBuf::from("."));
            let (projects, project_issue) = match store.local_project_roots() {
                Ok(projects) => (projects, None),
                Err(error) => (
                    Vec::new(),
                    Some(SkillScanIssue {
                        agent: None,
                        path: issue_path.clone(),
                        message: format!("could not load automatic project folders: {error:#}"),
                    }),
                ),
            };
            let (added_projects, added_issue) = match store.list_skill_project_roots() {
                Ok(projects) => (projects, None),
                Err(error) => (
                    Vec::new(),
                    Some(SkillScanIssue {
                        agent: None,
                        path: issue_path,
                        message: format!("could not load added Skill project folders: {error:#}"),
                    }),
                ),
            };
            let mut result = skills::scan_skills_with_added_projects(&projects, &added_projects);
            result.issues.extend(project_issue);
            result.issues.extend(added_issue);
            result
        });
        self.skills.scan_task = Some(cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| {
                let editor_is_stale = this.skills.editing_key.as_ref().is_some_and(|key| {
                    let before = this
                        .skills
                        .entries
                        .iter()
                        .find(|entry| &entry.key == key)
                        .map(|entry| entry.body.as_str());
                    let after = result
                        .skills
                        .iter()
                        .find(|entry| &entry.key == key)
                        .map(|entry| entry.body.as_str());
                    before != after
                });
                this.skills.entries = result.skills;
                this.skills.issues = result.issues;
                this.skills.loading = false;
                this.skills.loaded_once = true;
                if editor_is_stale {
                    this.skills.editing_key = None;
                    this.skills.edit_textarea = None;
                }
                this.rebuild_skill_rows(cx);
                cx.notify();
            })
            .ok();
            if let Some(window) = done {
                cx.update_window(window, |_, window, cx| {
                    window.push_notification(Notification::success(t("Skills refreshed")), cx)
                })
                .ok();
            }
        }));
    }

    fn rebuild_skill_rows(&mut self, cx: &mut Context<Self>) {
        let query = self.skill_query.read(cx).value().trim().to_string();
        self.skills.shown = self
            .skills
            .entries
            .iter()
            .enumerate()
            .filter_map(|(index, entry)| {
                let in_scope = match &self.skills.nav {
                    SkillsNav::All => true,
                    SkillsNav::User => entry.project_path.is_empty(),
                    SkillsNav::Agent(agent) => entry.agent == Some(*agent),
                    SkillsNav::Project(path) => entry.project_path == *path,
                };
                (in_scope && skill_matches_query(entry, &query)).then_some(index)
            })
            .collect();
        self.skills.list_scroll = ScrollHandle::new();

        let selected_is_visible = self.skills.selected.as_ref().is_some_and(|selected| {
            self.skills.shown.iter().any(|index| {
                self.skills
                    .entries
                    .get(*index)
                    .is_some_and(|entry| &entry.key == selected)
            })
        });
        if !selected_is_visible {
            self.skills.selected = self
                .skills
                .shown
                .first()
                .and_then(|index| self.skills.entries.get(*index))
                .map(|entry| entry.key.clone());
            self.cancel_skill_edit(cx);
        }
    }

    pub(super) fn on_skill_query_event(
        &mut self,
        _: &Entity<InputState>,
        event: &InputEvent,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if matches!(event, InputEvent::Change) {
            if self.skills.mode == SkillsMode::Skills {
                self.rebuild_skill_rows(cx);
            }
            cx.notify();
        }
    }

    fn begin_mcp_edit(&mut self, id: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        self.skills.mcp_paste_open = false;
        self.skills.mcp_paste_input = None;
        self.skills.mcp_paste_items.clear();
        let existing = id.as_ref().and_then(|id| {
            self.skills
                .mcp_servers
                .iter()
                .find(|server| &server.id == id)
        });
        let default_id = existing.map(|server| server.id.clone()).unwrap_or_default();
        let default_name = existing
            .map(|server| server.name.clone())
            .unwrap_or_default();
        let config = existing
            .map(|server| {
                serde_json::to_string_pretty(&server.config).unwrap_or_else(|_| "{}".into())
            })
            .unwrap_or_else(|| "{\n  \"command\": \"\",\n  \"args\": []\n}".into());
        self.skills.mcp_edit_id = Some(cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Server ID")
                .default_value(default_id)
        }));
        self.skills.mcp_edit_name = Some(cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("名称")
                .default_value(default_name)
        }));
        self.skills.mcp_edit_config = Some(cx.new(|cx| {
            TextareaState::new(window, cx)
                .rows(14)
                .default_value(config)
        }));
        self.skills.mcp_edit_original = id;
        cx.notify();
    }

    fn begin_mcp_paste(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.skills.mcp_edit_id = None;
        self.skills.mcp_edit_name = None;
        self.skills.mcp_edit_config = None;
        self.skills.mcp_edit_original = None;
        self.skills.mcp_paste_input = Some(cx.new(|cx| TextareaState::new(window, cx).rows(8)));
        self.skills.mcp_paste_items.clear();
        self.skills.mcp_paste_open = true;
        cx.notify();
    }

    fn cancel_mcp_paste(&mut self, cx: &mut Context<Self>) {
        self.skills.mcp_paste_open = false;
        self.skills.mcp_paste_input = None;
        self.skills.mcp_paste_items.clear();
        cx.notify();
    }

    fn parse_mcp_paste(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(input) = self.skills.mcp_paste_input.clone() else {
            return;
        };
        self.skills.mcp_paste_items.clear();
        let text = input.read(cx).value().to_string();
        let parsed = match mcp::parse_pasted_servers(&text) {
            Ok(parsed) => parsed,
            Err(error) => {
                window.push_notification(
                    Notification::error(format!("MCP 配置无法识别: {error:#}")),
                    cx,
                );
                return;
            }
        };

        if parsed.len() == 1 && parsed[0].id.is_none() {
            let server = &parsed[0];
            self.skills.mcp_edit_id =
                Some(cx.new(|cx| InputState::new(window, cx).placeholder("Server ID")));
            self.skills.mcp_edit_name =
                Some(cx.new(|cx| InputState::new(window, cx).placeholder("名称")));
            self.skills.mcp_edit_config = Some(cx.new(|cx| {
                TextareaState::new(window, cx).rows(14).default_value(
                    serde_json::to_string_pretty(&server.config).unwrap_or_else(|_| "{}".into()),
                )
            }));
            self.skills.mcp_edit_original = None;
            self.skills.mcp_paste_open = false;
            self.skills.mcp_paste_input = None;
            self.skills.mcp_paste_items.clear();
            cx.notify();
            return;
        }

        self.skills.mcp_paste_items = parsed
            .into_iter()
            .filter_map(|server| {
                let id = server.id?;
                let exists = self
                    .skills
                    .mcp_servers
                    .iter()
                    .any(|current| current.id == id);
                Some(McpPasteItem {
                    id,
                    config: server.config,
                    include: !exists,
                    exists,
                })
            })
            .collect();
        if self.skills.mcp_paste_items.is_empty() {
            window.push_notification(Notification::error("没有带 Server ID 的 MCP 配置"), cx);
        }
        cx.notify();
    }

    fn toggle_mcp_paste_item(&mut self, index: usize, include: bool, cx: &mut Context<Self>) {
        if let Some(item) = self.skills.mcp_paste_items.get_mut(index) {
            item.include = include;
            cx.notify();
        }
    }

    fn import_pasted_mcp(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let selected = self
            .skills
            .mcp_paste_items
            .iter()
            .filter(|item| item.include)
            .collect::<Vec<_>>();
        if selected.is_empty() {
            window.push_notification(Notification::warning("请选择要导入的 MCP 配置"), cx);
            return;
        }

        let mut imported = 0usize;
        let mut issues = Vec::new();
        for item in selected {
            let mut server = self
                .skills
                .mcp_servers
                .iter()
                .find(|current| current.id == item.id)
                .cloned()
                .unwrap_or_else(|| McpServer {
                    id: item.id.clone(),
                    name: item.id.clone(),
                    config: serde_json::Value::Object(Default::default()),
                    clients: Default::default(),
                });
            server.config = item.config.clone();
            match self.store.save_mcp_server(&server) {
                Ok(()) => imported += 1,
                Err(error) => issues.push(format!("{}: {error:#}", item.id)),
            }
        }

        self.skills.mcp_paste_open = false;
        self.skills.mcp_paste_input = None;
        self.skills.mcp_paste_items.clear();
        self.skills.mcp_loaded = false;
        self.refresh_mcp(None, cx);
        if issues.is_empty() {
            window.push_notification(
                Notification::success(format!(
                    "已导入 {} 条到 ContextOS；客户端配置未改动",
                    imported
                )),
                cx,
            );
        } else {
            window.push_notification(
                Notification::warning(format!(
                    "成功导入 {} 条；失败: {}",
                    imported,
                    issues.join(" · ")
                )),
                cx,
            );
        }
        cx.notify();
    }

    fn copy_mcp_servers(&self, window: &mut Window, cx: &mut Context<Self>) {
        match self
            .store
            .list_mcp_servers()
            .and_then(|servers| mcp::export_mcp_servers_json(&servers))
        {
            Ok(text) => {
                cx.write_to_clipboard(ClipboardItem::new_string(text));
                window.push_notification(
                    Notification::success("已复制全部 MCP 为 mcpServers JSON"),
                    cx,
                );
            }
            Err(error) => window.push_notification(
                Notification::error(format!("复制 MCP 配置失败: {error:#}")),
                cx,
            ),
        }
    }

    fn cancel_mcp_edit(&mut self, cx: &mut Context<Self>) {
        self.skills.mcp_edit_id = None;
        self.skills.mcp_edit_name = None;
        self.skills.mcp_edit_config = None;
        self.skills.mcp_edit_original = None;
        cx.notify();
    }

    fn save_mcp_edit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(id_input), Some(name_input), Some(config_input)) = (
            self.skills.mcp_edit_id.clone(),
            self.skills.mcp_edit_name.clone(),
            self.skills.mcp_edit_config.clone(),
        ) else {
            return;
        };
        let id = id_input.read(cx).value().trim().to_string();
        let name = name_input.read(cx).value().trim().to_string();
        let config =
            match serde_json::from_str::<serde_json::Value>(config_input.read(cx).value().as_ref())
            {
                Ok(value) if value.is_object() => value,
                Ok(_) => {
                    window.push_notification(Notification::error("MCP 配置必须是 JSON 对象"), cx);
                    return;
                }
                Err(error) => {
                    window.push_notification(
                        Notification::error(crate::tf!("JSON 无效: {}", error)),
                        cx,
                    );
                    return;
                }
            };
        if id.is_empty() {
            window.push_notification(Notification::error("Server ID 不能为空"), cx);
            return;
        }
        if self
            .skills
            .mcp_edit_original
            .as_ref()
            .is_some_and(|old| old != &id)
        {
            window.push_notification(Notification::error("编辑时不能更改 Server ID"), cx);
            return;
        }
        let mut server = self
            .skills
            .mcp_servers
            .iter()
            .find(|server| server.id == id)
            .cloned()
            .unwrap_or(McpServer {
                id: id.clone(),
                name: id.clone(),
                config: config.clone(),
                clients: Default::default(),
            });
        if self.skills.mcp_edit_original.is_none() {
            if let Some(agent) = self.skills.mcp_client_filter.as_ref() {
                server.clients.insert(agent.clone(), true);
            }
        }
        server.name = if name.is_empty() { id.clone() } else { name };
        server.config = config;
        let result = self.store.save_mcp_server(&server);
        match result {
            Ok(()) => {
                let detected = self
                    .adapters
                    .iter()
                    .filter(|adapter| adapter.detect())
                    .map(|adapter| adapter.agent())
                    .collect::<Vec<_>>();
                let issues = mcp::sync_all(&self.store, &detected);
                self.skills.mcp_edit_id = None;
                self.skills.mcp_edit_name = None;
                self.skills.mcp_edit_config = None;
                self.skills.mcp_edit_original = None;
                self.skills.mcp_loaded = false;
                self.refresh_mcp(None, cx);
                if issues.is_empty() {
                    window.push_notification(Notification::success("MCP 已保存并同步"), cx);
                } else {
                    window.push_notification(Notification::warning(issues.join("\n")), cx);
                }
            }
            Err(error) => window.push_notification(
                Notification::error(crate::tf!("保存 MCP 失败: {}", error)),
                cx,
            ),
        }
    }

    fn toggle_mcp_client(
        &mut self,
        id: String,
        agent_name: String,
        enabled: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(agent) = AgentId::ALL
            .iter()
            .copied()
            .find(|agent| agent.as_str() == agent_name)
        else {
            return;
        };
        let Some(mut server) = self
            .skills
            .mcp_servers
            .iter()
            .find(|server| server.id == id)
            .cloned()
        else {
            return;
        };
        match mcp::sync_server(&self.store, &server, agent, enabled) {
            Ok(()) => {
                server.clients.insert(agent.as_str().into(), enabled);
                if let Some(current) = self
                    .skills
                    .mcp_servers
                    .iter_mut()
                    .find(|item| item.id == id)
                {
                    current.clients = server.clients;
                }
                cx.notify();
            }
            Err(error) => window.push_notification(
                Notification::error(crate::tf!(
                    "同步到 {} 失败: {}",
                    agent.display_name(),
                    error
                )),
                cx,
            ),
        }
    }

    fn confirm_mcp_client_toggle(
        &self,
        id: String,
        agent_name: String,
        enabled: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(server) = self
            .skills
            .mcp_servers
            .iter()
            .find(|server| server.id == id)
        else {
            return;
        };
        let Some(client) = self
            .skills
            .mcp_clients
            .iter()
            .find(|client| client.agent == agent_name)
        else {
            return;
        };
        if server.clients.get(&agent_name).copied().unwrap_or(false) == enabled {
            return;
        }

        let server_name = server.name.clone();
        let server_id = server.id.clone();
        let client_name = client.name.clone();
        let client_path = client.path.clone();
        let entity = cx.entity();
        window.open_alert_dialog(cx, move |dialog, _window, cx| {
            let title = if enabled {
                format!("将 MCP 添加到 {}？", client_name)
            } else {
                format!("从 {} 移除 MCP？", client_name)
            };
            let action = if enabled {
                "确认后会把该 MCP 配置写入客户端配置文件。"
            } else {
                "确认后会从客户端配置文件中移除此 MCP 条目。"
            };
            let path = client_path.clone();
            let entity = entity.clone();
            let agent_name = agent_name.clone();
            let server_id = server_id.clone();
            dialog
                .title(div().text_size(FONT_HEADING).font_semibold().child(title))
                .width(px(500.))
                .confirm()
                .button_props(
                    gpui_component::dialog::DialogButtonProps::default()
                        .show_cancel(true)
                        .cancel_text("取消")
                        .ok_text(if enabled {
                            "确认添加"
                        } else {
                            "确认移除"
                        }),
                )
                .child(
                    v_flex()
                        .gap(SPACE_SM)
                        .text_size(FONT_BODY)
                        .child(format!("{} ({})", server_name, server_id))
                        .child(
                            div()
                                .text_size(FONT_CAPTION)
                                .text_color(cx.theme().muted_foreground)
                                .child(action),
                        )
                        .child(
                            div()
                                .px(SPACE_SM)
                                .py(SPACE_XS)
                                .rounded(cx.theme().radius)
                                .bg(cx.theme().muted)
                                .text_size(FONT_CAPTION)
                                .font_family(cx.theme().mono_font_family.clone())
                                .child(path),
                        ),
                )
                .on_ok(move |_, window, cx| {
                    let server_id = server_id.clone();
                    let agent_name = agent_name.clone();
                    entity.update(cx, |this, cx| {
                        this.toggle_mcp_client(server_id, agent_name, enabled, window, cx);
                    });
                    true
                })
        });
    }

    fn delete_mcp_server(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        let detected = self
            .adapters
            .iter()
            .filter(|adapter| adapter.detect())
            .map(|adapter| adapter.agent())
            .collect::<Vec<_>>();
        match mcp::delete_server(&self.store, &id, &detected) {
            Ok(issues) => {
                self.skills.mcp_servers.retain(|server| server.id != id);
                if issues.is_empty() {
                    window.push_notification(Notification::success("MCP 已删除"), cx);
                } else {
                    window.push_notification(Notification::warning(issues.join("\n")), cx);
                }
                cx.notify();
            }
            Err(error) => window.push_notification(
                Notification::error(crate::tf!("删除 MCP 失败: {}", error)),
                cx,
            ),
        }
    }

    pub(super) fn render_mcp_nav(&self, cx: &Context<Self>) -> AnyElement {
        let query = self.skill_query.read(cx).value().trim().to_lowercase();
        let clients = self.skills.mcp_clients.iter().filter(|client| {
            query.is_empty()
                || client.name.to_lowercase().contains(&query)
                || client.path.to_lowercase().contains(&query)
        });
        v_flex()
            .flex_1()
            .min_h_0()
            .child(
                div()
                    .flex_shrink_0()
                    .px(SIDEBAR_EDGE)
                    .pb(SPACE_MD)
                    .child(search_input_control(
                        &self.skill_query,
                        gpui_component::Size::Medium,
                        "mcp-search-clear",
                        cx,
                    )),
            )
            .child(
                v_flex()
                    .id("mcp-client-list")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .px(SIDEBAR_EDGE)
                    .pb(SPACE_LG)
                    .gap(SPACE_XS)
                    .child(sidebar_row(
                        "mcp-client-all",
                        RowLead::Icon(icon("icons/layers.svg")),
                        "全部 MCP".to_string(),
                        Some(self.skills.mcp_servers.len() as i64),
                        self.skills.mcp_client_filter.is_none(),
                        RowLevel::Primary,
                        cx.listener(|this, _, _, cx| {
                            this.skills.mcp_client_filter = None;
                            cx.notify();
                        }),
                        cx,
                    ))
                    .children(clients.map(|client| {
                        let error = client.error.is_some();
                        let filter = client.agent.clone();
                        let selected =
                            self.skills.mcp_client_filter.as_deref() == Some(filter.as_str());
                        let lead = AgentId::from_str(&client.agent)
                            .map(|agent| {
                                RowLead::Brand(agent.brand_icon(cx.theme().mode.is_dark()))
                            })
                            .unwrap_or_else(|| RowLead::Icon(icon("icons/server.svg")));
                        sidebar_row(
                            format!("mcp-client-{}", client.agent),
                            if error {
                                RowLead::Icon(icon("icons/circle-x.svg"))
                            } else {
                                lead
                            },
                            client.name.clone(),
                            Some(
                                self.skills
                                    .mcp_servers
                                    .iter()
                                    .filter(|server| {
                                        server.clients.get(&client.agent).copied().unwrap_or(false)
                                    })
                                    .count() as i64,
                            ),
                            selected,
                            RowLevel::Primary,
                            cx.listener(move |this, _, _window, cx| {
                                this.skills.mcp_client_filter = Some(filter.clone());
                                cx.notify();
                            }),
                            cx,
                        )
                    })),
            )
            .into_any_element()
    }

    fn render_mcp(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let query = self.skill_query.read(cx).value().trim().to_lowercase();
        let rows = self
            .skills
            .mcp_servers
            .iter()
            .filter(|server| {
                let matches_query = query.is_empty()
                    || server.id.to_lowercase().contains(&query)
                    || server.name.to_lowercase().contains(&query);
                let matches_agent = self
                    .skills
                    .mcp_client_filter
                    .as_ref()
                    .is_none_or(|agent| server.clients.contains_key(agent));
                matches_query && matches_agent
            })
            .cloned()
            .collect::<Vec<_>>();
        let mcp_issue_message = self.skills.mcp_issues.join(" · ");
        let editor_open = self.skills.mcp_edit_id.is_some();
        let editor = if self.skills.mcp_paste_open {
            let input = self.skills.mcp_paste_input.as_ref().unwrap();
            let entity = cx.entity();
            let paste_rows = self
                .skills
                .mcp_paste_items
                .iter()
                .enumerate()
                .map(|(index, item)| {
                    let id = item.id.clone();
                    let include = item.include;
                    let exists = item.exists;
                    let entity = entity.clone();
                    h_flex()
                        .min_h(px(48.))
                        .items_center()
                        .gap(SPACE_MD)
                        .border_b_1()
                        .border_color(theme.border)
                        .child(
                            Checkbox::new(SharedString::from(format!("mcp-paste-{index}")))
                                .checked(include)
                                .on_click(move |checked, _, cx| {
                                    entity.update(cx, |this, cx| {
                                        this.toggle_mcp_paste_item(index, *checked, cx)
                                    });
                                }),
                        )
                        .child(div().flex_1().min_w_0().font_medium().child(id.clone()))
                        .child(
                            div()
                                .text_size(FONT_CAPTION)
                                .text_color(theme.muted_foreground)
                                .child(if exists {
                                    "已有 ID；勾选将覆盖清单中的配置"
                                } else {
                                    "新增"
                                }),
                        )
                        .into_any_element()
                })
                .collect::<Vec<_>>();
            let has_paste_rows = !paste_rows.is_empty();
            v_flex().flex_1().min_w_0().h_full().p(SPACE_XXL).gap(SPACE_MD)
                .child(div().text_size(FONT_HEADING).font_semibold().child("粘贴 MCP 配置"))
                .child(div().text_size(FONT_CAPTION).text_color(theme.muted_foreground)
                    .child("支持 mcpServers、Codex JSON/TOML、OpenCode mcp 格式；解析后先预览，再导入到 ContextOS。"))
                .child(div().flex_1().min_h_0().h(px(220.)).child(Textarea::new(input).h_full()))
                .child(h_flex().flex_shrink_0().gap(SPACE_SM)
                    .child(Button::new("mcp-paste-parse").ghost().label("解析配置")
                        .on_click(cx.listener(|this, _, window, cx| this.parse_mcp_paste(window, cx))))
                    .child(Button::new("mcp-paste-clear").ghost().label("清除解析结果")
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.skills.mcp_paste_items.clear();
                            cx.notify();
                        })))
                )
                .when(has_paste_rows, |this| this
                    .child(div().flex_1().min_h_0().overflow_y_scrollbar().children(paste_rows))
                    .child(div().flex_shrink_0().text_size(FONT_CAPTION).text_color(theme.muted_foreground)
                        .child("导入只更新 ContextOS 清单，不会写入客户端配置；客户端可在列表中单独启用或同步。"))
                    .child(h_flex().flex_shrink_0().justify_end().gap(SPACE_SM)
                        .child(Button::new("mcp-paste-cancel").ghost().label("取消")
                            .on_click(cx.listener(|this, _, _, cx| this.cancel_mcp_paste(cx))))
                        .child(Button::new("mcp-paste-import").primary().label("导入选中")
                            .on_click(cx.listener(|this, _, window, cx| this.import_pasted_mcp(window, cx))))))
                .when(!has_paste_rows, |this| this
                    .child(h_flex().flex_shrink_0().justify_end()
                        .child(Button::new("mcp-paste-cancel-empty").ghost().label("取消")
                            .on_click(cx.listener(|this, _, _, cx| this.cancel_mcp_paste(cx))))))
                .into_any_element()
        } else if editor_open {
            let id = self.skills.mcp_edit_id.as_ref().unwrap();
            let name = self.skills.mcp_edit_name.as_ref().unwrap();
            let config = self.skills.mcp_edit_config.as_ref().unwrap();
            v_flex()
                .flex_1()
                .min_w_0()
                .h_full()
                .p(SPACE_XXL)
                .gap(SPACE_MD)
                .child(div().text_size(FONT_HEADING).font_semibold().child(
                    if self.skills.mcp_edit_original.is_some() {
                        "编辑 MCP"
                    } else {
                        "添加 MCP"
                    },
                ))
                .child(
                    h_flex()
                        .w_full()
                        .gap(SPACE_MD)
                        .child(
                            v_flex()
                                .flex_1()
                                .min_w_0()
                                .gap(SPACE_XS)
                                .child("Server ID")
                                .child(Input::new(id)),
                        )
                        .child(
                            v_flex()
                                .flex_1()
                                .min_w_0()
                                .gap(SPACE_XS)
                                .child("名称")
                                .child(Input::new(name)),
                        ),
                )
                .child(
                    v_flex()
                        .flex_1()
                        .min_h_0()
                        .gap(SPACE_XS)
                        .child("配置 JSON")
                        .child(
                            div()
                                .flex_1()
                                .min_h_0()
                                .h(px(480.))
                                .child(Textarea::new(config).h_full()),
                        ),
                )
                .child(
                    h_flex()
                        .flex_shrink_0()
                        .justify_end()
                        .gap(SPACE_SM)
                        .child(
                            Button::new("mcp-edit-cancel")
                                .ghost()
                                .label("取消")
                                .on_click(cx.listener(|this, _, _, cx| this.cancel_mcp_edit(cx))),
                        )
                        .child(
                            Button::new("mcp-edit-save")
                                .primary()
                                .label("保存")
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.save_mcp_edit(window, cx)
                                })),
                        ),
                )
                .into_any_element()
        } else {
            let client_headers = self
                .skills
                .mcp_clients
                .iter()
                .map(|client| {
                    let count = self
                        .skills
                        .mcp_servers
                        .iter()
                        .filter(|server| {
                            server.clients.get(&client.agent).copied().unwrap_or(false)
                        })
                        .count();
                    let brand = AgentId::from_str(&client.agent)
                        .map(|agent| agent.brand_icon(theme.mode.is_dark()));
                    let client_name = client.name.clone();
                    v_flex()
                        .id(format!("mcp-client-head-{}", client.agent))
                        .w(px(58.))
                        .flex_shrink_0()
                        .items_center()
                        .justify_center()
                        .gap(px(3.))
                        .tooltip(move |window, cx| {
                            gpui_component::tooltip::Tooltip::new(client_name.clone())
                                .build(window, cx)
                        })
                        .child(
                            brand
                                .map(|path| img(path).size(px(18.)).into_any_element())
                                .unwrap_or_else(|| {
                                    icon("icons/server.svg")
                                        .with_size(px(18.))
                                        .into_any_element()
                                }),
                        )
                        .child(
                            div()
                                .text_size(FONT_CAPTION)
                                .text_color(theme.muted_foreground)
                                .child(count.to_string()),
                        )
                        .into_any_element()
                })
                .collect::<Vec<_>>();
            let entity = cx.entity().clone();
            let server_rows = rows
                .iter()
                .map(|server| {
                    let id = server.id.clone();
                    let edit_id = server.id.clone();
                    let delete_id = server.id.clone();
                    let mut cells = Vec::with_capacity(self.skills.mcp_clients.len());
                    for client in &self.skills.mcp_clients {
                        let enabled = server.clients.get(&client.agent).copied().unwrap_or(false);
                        let server_id = id.clone();
                        let agent = client.agent.clone();
                        let entity = entity.clone();
                        cells.push(
                            div()
                                .w(px(58.))
                                .flex_shrink_0()
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(
                                    Checkbox::new(SharedString::from(format!(
                                        "mcp-{}-{}",
                                        id, client.agent
                                    )))
                                    .checked(enabled)
                                    .on_click(
                                        move |checked, window, cx| {
                                            entity.update(cx, |this, cx| {
                                                this.confirm_mcp_client_toggle(
                                                    server_id.clone(),
                                                    agent.clone(),
                                                    *checked,
                                                    window,
                                                    cx,
                                                );
                                            });
                                        },
                                    ),
                                )
                                .into_any_element(),
                        );
                    }
                    h_flex()
                        .id(format!("mcp-row-{}", server.id))
                        .min_w(px(800.))
                        .w_full()
                        .min_h(px(64.))
                        .items_center()
                        .gap(SPACE_SM)
                        .px(SPACE_MD)
                        .border_b_1()
                        .border_color(theme.border)
                        .child(
                            v_flex()
                                .flex_1()
                                .min_w_0()
                                .gap(px(3.))
                                .child(
                                    div()
                                        .text_size(FONT_LABEL)
                                        .font_medium()
                                        .truncate()
                                        .child(server.name.clone()),
                                )
                                .child(
                                    div()
                                        .text_size(FONT_CAPTION)
                                        .text_color(theme.muted_foreground)
                                        .truncate()
                                        .child(server.id.clone()),
                                ),
                        )
                        .children(cells)
                        .child(
                            h_flex()
                                .w(px(108.))
                                .flex_shrink_0()
                                .items_center()
                                .justify_end()
                                .gap(SPACE_XS)
                                .child(
                                    Button::new(format!("mcp-edit-{}", server.id))
                                        .ghost()
                                        .small()
                                        .label("编辑")
                                        .on_click(cx.listener(move |this, _, window, cx| {
                                            this.begin_mcp_edit(Some(edit_id.clone()), window, cx)
                                        })),
                                )
                                .child(
                                    Button::new(format!("mcp-delete-{}", server.id))
                                        .ghost()
                                        .small()
                                        .icon(icon("icons/trash-2.svg").with_size(px(14.)))
                                        .tooltip("删除")
                                        .on_click(cx.listener(move |this, _, window, cx| {
                                            this.delete_mcp_server(delete_id.clone(), window, cx)
                                        })),
                                ),
                        )
                        .into_any_element()
                })
                .collect::<Vec<_>>();
            let server_rows_empty = server_rows.is_empty();
            v_flex()
                .flex_1()
                .min_w_0()
                .h_full()
                .child(library_header(
                    "mcp-header",
                    "MCP",
                    format!("{} 个服务器", self.skills.mcp_servers.len()),
                    SPACE_LG,
                    Some(
                        h_flex()
                            .gap(SPACE_XS)
                            .child(
                                Button::new("mcp-add")
                                    .ghost()
                                    .small()
                                    .icon(icon("icons/plus.svg").with_size(px(16.)))
                                    .tooltip("添加 MCP")
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.begin_mcp_edit(None, window, cx)
                                    })),
                            )
                            .child(
                                Button::new("mcp-paste")
                                    .ghost()
                                    .small()
                                    .label("粘贴配置")
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.begin_mcp_paste(window, cx)
                                    })),
                            )
                            .child(
                                Button::new("mcp-import")
                                    .ghost()
                                    .small()
                                    .label("导入")
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.import_mcp(Some(window.window_handle()), cx)
                                    })),
                            )
                            .child(
                                Button::new("mcp-more")
                                    .ghost()
                                    .small()
                                    .icon(icon("icons/more-horizontal.svg").with_size(px(16.)))
                                    .tooltip("更多 MCP 操作")
                                    .dropdown_menu(move |menu, _, _| {
                                        let sync_entity = entity.clone();
                                        let copy_entity = entity.clone();
                                        menu.min_w(px(240.))
                                            .item(
                                                PopupMenuItem::new("按开关同步到客户端配置")
                                                    .on_click(move |_, window, cx| {
                                                        sync_entity.update(cx, |this, cx| {
                                                            this.resync_mcp(window, cx)
                                                        });
                                                    }),
                                            )
                                            .item(
                                                PopupMenuItem::new("复制全部为 mcpServers JSON")
                                                    .on_click(move |_, window, cx| {
                                                        copy_entity.update(cx, |this, cx| {
                                                            this.copy_mcp_servers(window, cx)
                                                        });
                                                    }),
                                            )
                                    }),
                            )
                            .child(self.refresh_button(
                                self.skills.mcp_loading,
                                |this, window, cx| {
                                    this.refresh_mcp(Some(window.window_handle()), cx)
                                },
                                cx,
                            ))
                            .into_any_element(),
                    ),
                    cx,
                ))
                .when(!mcp_issue_message.is_empty(), |this| {
                    this.child(
                        div()
                            .flex_shrink_0()
                            .px(SPACE_LG)
                            .pb(SPACE_SM)
                            .text_size(FONT_CAPTION)
                            .text_color(theme.muted_foreground)
                            .child(mcp_issue_message),
                    )
                })
                .child(
                    h_flex().flex_1().min_h_0().overflow_x_scrollbar().child(
                        v_flex()
                            .min_w(px(800.))
                            .w_full()
                            .flex_shrink_0()
                            .h_full()
                            .min_h_0()
                            .overflow_y_scrollbar()
                            .child(
                                h_flex()
                                    .min_h(px(58.))
                                    .items_center()
                                    .gap(SPACE_SM)
                                    .px(SPACE_MD)
                                    .border_b_1()
                                    .border_color(theme.border)
                                    .bg(theme.colors.list)
                                    .child(
                                        div()
                                            .flex_1()
                                            .min_w_0()
                                            .text_size(FONT_LABEL)
                                            .font_semibold()
                                            .child("名称"),
                                    )
                                    .children(client_headers)
                                    .child(div().w(px(108.)).flex_shrink_0().child("")),
                            )
                            .children(server_rows)
                            .when(server_rows_empty, |this| {
                                this.child(
                                    v_flex()
                                        .h(px(180.))
                                        .items_center()
                                        .justify_center()
                                        .text_color(theme.muted_foreground)
                                        .child(if self.skills.mcp_loading {
                                            "正在读取 MCP 配置…"
                                        } else if self.skills.mcp_client_filter.is_some() {
                                            "该客户端暂无 MCP 配置"
                                        } else {
                                            "暂无 MCP 配置"
                                        }),
                                )
                            }),
                    ),
                )
                .into_any_element()
        };
        editor
    }

    fn set_skills_scope(&mut self, nav: SkillsNav, window: &mut Window, cx: &mut Context<Self>) {
        if !self.allow_skill_navigation(window, cx) {
            return;
        }
        self.skills.nav = nav;
        self.rebuild_skill_rows(cx);
        cx.notify();
    }

    fn select_skill(&mut self, key: String, window: &mut Window, cx: &mut Context<Self>) {
        if self.skills.selected.as_deref() == Some(key.as_str()) {
            return;
        }
        if !self.allow_skill_navigation(window, cx) {
            return;
        }
        self.skills.selected = Some(key);
        self.cancel_skill_edit(cx);
        cx.notify();
    }

    fn skill_edit_is_dirty(&self, cx: &App) -> bool {
        let Some(key) = self.skills.editing_key.as_deref() else {
            return false;
        };
        let Some(input) = self.skills.edit_textarea.as_ref() else {
            return false;
        };
        let original = self
            .skills
            .entries
            .iter()
            .find(|entry| entry.key == key)
            .map(|entry| entry.body.as_str())
            .unwrap_or_default();
        input.read(cx).value().as_ref() != original
    }

    pub(super) fn allow_skill_navigation(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let message = if self.skills.saving_key.is_some() {
            Some(t("Wait for the Skill to finish saving."))
        } else if self.skill_edit_is_dirty(cx) {
            Some(t("Save or cancel your Skill edits before leaving."))
        } else {
            None
        };
        if let Some(message) = message {
            window.push_notification(Notification::warning(message), cx);
            false
        } else {
            true
        }
    }

    fn selected_skill(&self) -> Option<&SkillEntry> {
        let selected = self.skills.selected.as_deref()?;
        self.skills
            .entries
            .iter()
            .find(|entry| entry.key == selected)
    }

    fn begin_skill_edit(&mut self, key: String, window: &mut Window, cx: &mut Context<Self>) {
        if self.skills.loading {
            return;
        }
        let Some(body) = self
            .skills
            .entries
            .iter()
            .find(|entry| entry.key == key)
            .map(|entry| entry.body.clone())
        else {
            return;
        };
        let input = cx.new(|cx| TextareaState::new(window, cx).rows(24).default_value(body));
        input.update(cx, |state, cx| state.focus(window, cx));
        self.skills.editing_key = Some(key);
        self.skills.edit_textarea = Some(input);
        cx.notify();
    }

    fn cancel_skill_edit(&mut self, cx: &mut Context<Self>) {
        self.skills.editing_key = None;
        self.skills.edit_textarea = None;
        cx.notify();
    }

    fn save_skill_edit(&mut self, key: String, window: &mut Window, cx: &mut Context<Self>) {
        if self.skills.saving_key.is_some() {
            return;
        }
        let Some(entry) = self
            .skills
            .entries
            .iter()
            .find(|entry| entry.key == key)
            .cloned()
        else {
            return;
        };
        let Some(input) = self.skills.edit_textarea.clone() else {
            return;
        };
        let replacement = input.read(cx).value().to_string();
        self.skills.saving_key = Some(key.clone());
        cx.notify();
        let task = cx.background_spawn(async move { skills::save_skill(&entry, &replacement) });
        cx.spawn_in(window, async move |this, cx| {
            let result = task.await;
            this.update_in(cx, |this, window, cx| {
                if this.skills.saving_key.as_deref() == Some(key.as_str()) {
                    this.skills.saving_key = None;
                }
                match result {
                    Ok(()) => {
                        if this.skills.editing_key.as_deref() == Some(key.as_str()) {
                            this.skills.editing_key = None;
                            this.skills.edit_textarea = None;
                        }
                        this.skills.loaded_once = false;
                        this.start_skill_scan(None, cx);
                        window.push_notification(Notification::success(t("Skill saved")), cx);
                    }
                    Err(error) => window.push_notification(
                        Notification::error(crate::tf!(
                            "Could not save Skill: {}",
                            format!("{error:#}")
                        )),
                        cx,
                    ),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn delete_skill(&mut self, entry: SkillEntry, window: &mut Window, cx: &mut Context<Self>) {
        let entity = cx.entity();
        window.open_alert_dialog(cx, move |dialog, _window, _cx| {
            let path = entry.directory.to_string_lossy().to_string();
            let entry = entry.clone();
            let entity = entity.clone();
            dialog
                .title(t("Delete this Skill?"))
                .width(px(480.))
                .confirm()
                .button_props(
                    gpui_component::dialog::DialogButtonProps::default()
                        .cancel_text(t("Cancel"))
                        .ok_text(crate::ui::move_to_trash())
                        .ok_variant(gpui_component::button::ButtonVariant::Danger),
                )
                .child(
                    v_flex()
                        .gap(SPACE_SM)
                        .text_size(FONT_BODY)
                        .child(t(
                            "The entire Skill folder will be moved to the system trash. You can restore it anytime:",
                        ))
                        .child(
                            div()
                                .px(SPACE_SM)
                                .py(SPACE_XS)
                                .rounded(_cx.theme().radius)
                                .bg(_cx.theme().muted)
                                .text_size(FONT_CAPTION)
                                .font_family(_cx.theme().mono_font_family.clone())
                                .child(path),
                        ),
                )
                .on_ok(move |_, window, cx| {
                    let task = cx.background_spawn({
                        let entry = entry.clone();
                        async move { skills::trash_skill(&entry) }
                    });
                    let key = entry.key.clone();
                    entity.update(cx, |_this, cx| {
                        cx.spawn_in(window, async move |this, cx| {
                                let result = task.await;
                                this.update_in(cx, |this, window, cx| {
                                    match result {
                                        Ok(()) => {
                                            if this.skills.selected.as_deref() == Some(&key) {
                                                this.skills.selected = None;
                                            }
                                            this.skills.loaded_once = false;
                                            this.start_skill_scan(None, cx);
                                            window.push_notification(
                                                Notification::success(t("Skill moved to trash")),
                                                cx,
                                            );
                                        }
                                        Err(error) => window.push_notification(
                                            Notification::error(crate::tf!(
                                                "Could not delete Skill: {}",
                                                format!("{error:#}")
                                            )),
                                            cx,
                                        ),
                                    }
                                })
                                .ok();
                        })
                        .detach();
                    });
                    true
                })
        });
    }

    pub(super) fn render_skills(&mut self, cx: &mut Context<Self>) -> AnyElement {
        if self.skills.mode == SkillsMode::Mcp {
            return self.render_mcp(cx);
        }
        let theme = cx.theme().clone();
        let count = self.skills.shown.len();
        let query = self.skill_query.read(cx).value().trim().to_string();
        let subtitle: SharedString = crate::tp!("{} Skill", "{} Skills", count).into();
        let list: AnyElement = if self.skills.shown.is_empty() {
            div().flex_1().into_any_element()
        } else {
            self.render_skill_list(cx)
        };
        let selected = self.selected_skill();
        let pane = match selected {
            Some(entry) => self.render_skill_reader(entry, cx),
            None => v_flex()
                .flex_1()
                .h_full()
                .items_center()
                .justify_center()
                .bg(theme.background)
                .child(if self.skills.loading && self.skills.entries.is_empty() {
                    Spinner::new().into_any_element()
                } else {
                    if query.is_empty() {
                        empty_state_card(
                            "icons/file-text.svg",
                            px(58.),
                            px(24.),
                            t("No Skills found"),
                            t("Add a user-level or project Agent Skill and refresh to manage it here."),
                            cx,
                        )
                    } else {
                        empty_state_card(
                            "icons/search.svg",
                            px(58.),
                            px(24.),
                            crate::tf!("No results for \"{}\"", query),
                            t("Try a different or shorter query."),
                            cx,
                        )
                    }
                    .into_any_element()
                })
                .into_any_element(),
        };
        h_flex()
            .flex_1()
            .min_w_0()
            .h_full()
            .child(
                v_flex()
                    .w(SESSION_STREAM_WIDTH)
                    .h_full()
                    .flex_shrink_0()
                    .bg(theme.colors.list)
                    .child(library_header(
                        "skills-header",
                        self.skills_context_title(),
                        subtitle,
                        SPACE_LG,
                        Some(
                            h_flex()
                                .gap(SPACE_XS)
                                .child(
                                    Button::new("add-skill-project-folder")
                                        .ghost()
                                        .rounded(RADIUS_BUTTON)
                                        .icon(icon("icons/plus.svg").with_size(px(16.)))
                                        .tooltip(t("Add Skill project folder"))
                                        .disabled(self.skills.loading)
                                        .on_click(cx.listener(|this, _, window, cx| {
                                            this.add_skill_project_folder(window, cx)
                                        })),
                                )
                                .child(self.refresh_button(
                                    self.skills.loading,
                                    Self::refresh_skills,
                                    cx,
                                ))
                                .into_any_element(),
                        ),
                        cx,
                    ))
                    .children(self.render_skill_issues(cx))
                    .child(list),
            )
            .child(pane)
            .into_any_element()
    }

    fn skills_context_title(&self) -> String {
        match &self.skills.nav {
            SkillsNav::All => t("All Skills").to_string(),
            SkillsNav::User => t("User Skills").to_string(),
            SkillsNav::Agent(agent) => agent.display_name().to_string(),
            SkillsNav::Project(path) => self
                .skills
                .entries
                .iter()
                .find(|entry| entry.project_path == *path)
                .map(|entry| entry.project_name.clone())
                .unwrap_or_else(|| t("Projects").to_string()),
        }
    }

    fn render_skill_issues(&self, cx: &Context<Self>) -> Option<AnyElement> {
        if self.skills.issues.is_empty() {
            return None;
        }
        let theme = cx.theme();
        let detail: SharedString = self
            .skills
            .issues
            .iter()
            .map(|issue| {
                format!(
                    "{} · {}: {}",
                    issue
                        .agent
                        .map(|agent| agent.display_name())
                        .unwrap_or_else(|| t("Project Skill")),
                    tilde_path(&issue.path.to_string_lossy()),
                    issue.message
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
            .into();
        Some(
            h_flex()
                .id("skills-scan-issues")
                .mx(SPACE_LG)
                .mb(SPACE_SM)
                .px(SPACE_SM)
                .py(SPACE_XS)
                .gap(ICON_TEXT_GAP)
                .rounded(theme.radius)
                .bg(theme.warning.opacity(0.12))
                .text_color(theme.warning)
                .text_size(FONT_LABEL)
                .child(icon("icons/info.svg").with_size(px(13.)))
                .child(div().flex_1().min_w_0().truncate().child(crate::tf!(
                    "{} Skill issues found",
                    self.skills.issues.len()
                )))
                .child(
                    Button::new("dismiss-skill-issues")
                        .ghost()
                        .small()
                        .rounded(RADIUS_BUTTON)
                        .icon(icon("icons/close.svg").with_size(px(13.)))
                        .tooltip(t("Ignore"))
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.skills.issues.clear();
                            cx.notify();
                        })),
                )
                .tooltip(move |window, cx| {
                    gpui_component::tooltip::Tooltip::new(detail.clone()).build(window, cx)
                })
                .into_any_element(),
        )
    }

    fn render_skill_list(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let rows = (0..self.skills.shown.len())
            .map(|index| self.render_skill_row(index, cx))
            .collect::<Vec<_>>();
        div()
            .id("skills-list-scroll-frame")
            .flex_1()
            .min_h_0()
            .w_full()
            .relative()
            .child(
                v_flex()
                    .id("skills-list-scroll")
                    .size_full()
                    .overflow_y_scroll()
                    .track_scroll(&self.skills.list_scroll)
                    .children(rows),
            )
            .vertical_scrollbar(&self.skills.list_scroll)
            .into_any_element()
    }

    fn render_skill_row(&mut self, row_index: usize, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let Some(entry_index) = self.skills.shown.get(row_index).copied() else {
            return div().into_any_element();
        };
        let Some(entry) = self.skills.entries.get(entry_index) else {
            return div().into_any_element();
        };
        let key = entry.key.clone();
        let selected = self.skills.selected.as_deref() == Some(key.as_str());
        let name: SharedString = entry.name.clone().into();
        let description: SharedString = if entry.description.trim().is_empty() {
            tilde_path(&entry.directory.to_string_lossy()).into()
        } else {
            entry.description.clone().into()
        };
        let owner_icon = match entry.agent {
            Some(agent) => img(agent.brand_icon(theme.mode.is_dark()))
                .size(px(14.))
                .flex_shrink_0()
                .into_any_element(),
            None => icon("icons/folder.svg")
                .with_size(px(14.))
                .flex_shrink_0()
                .into_any_element(),
        };
        let owner_name = entry
            .agent
            .map(|agent| agent.display_name())
            .unwrap_or_else(|| t("Project Skill"));
        div()
            .w_full()
            .px(SPACE_SM)
            .child(
                v_flex()
                    .id(("skill-row", row_index))
                    .w_full()
                    .min_w_0()
                    .rounded(theme.radius)
                    .px(SPACE_MD + SPACE_XS)
                    .py(SPACE_SM)
                    .gap(SPACE_XS)
                    .cursor_pointer()
                    .when(selected, |row| row.bg(theme.list_active))
                    .when(!selected, |row| {
                        row.hover(|style| style.bg(theme.list_hover))
                    })
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.select_skill(key.clone(), window, cx)
                    }))
                    .child(
                        div()
                            .w_full()
                            .min_w_0()
                            .truncate()
                            .text_size(FONT_BODY)
                            .font_medium()
                            .child(name),
                    )
                    .child(
                        div()
                            .w_full()
                            .min_w_0()
                            .truncate()
                            .text_size(FONT_LABEL)
                            .text_color(theme.muted_foreground)
                            .child(description),
                    )
                    .child(
                        h_flex()
                            .gap(ICON_TEXT_GAP)
                            .text_size(FONT_LABEL)
                            .text_color(theme.muted_foreground)
                            .child(owner_icon)
                            .child(owner_name)
                            .when(!entry.project_path.is_empty(), |row| {
                                row.child("·").child(entry.project_name.clone())
                            }),
                    ),
            )
            .into_any_element()
    }

    fn render_skill_reader(&self, entry: &SkillEntry, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let dark = theme.mode.is_dark();
        let editing = self.skills.editing_key.as_deref() == Some(entry.key.as_str())
            && self.skills.edit_textarea.is_some();
        let mut actions = Vec::new();
        if editing {
            let key = entry.key.clone();
            actions.push(
                Button::new(format!("skill-save-{}", entry.key))
                    .ghost()
                    .rounded(RADIUS_BUTTON)
                    .icon(icon("icons/check.svg").with_size(px(16.)))
                    .tooltip(t("Save"))
                    .disabled(self.skills.saving_key.is_some())
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.save_skill_edit(key.clone(), window, cx)
                    }))
                    .into_any_element(),
            );
            actions.push(
                Button::new(format!("skill-cancel-{}", entry.key))
                    .ghost()
                    .rounded(RADIUS_BUTTON)
                    .icon(icon("icons/close.svg").with_size(px(16.)))
                    .tooltip(t("Cancel"))
                    .disabled(self.skills.saving_key.is_some())
                    .on_click(cx.listener(|this, _, _window, cx| this.cancel_skill_edit(cx)))
                    .into_any_element(),
            );
        } else {
            let edit_key = entry.key.clone();
            actions.push(
                Button::new(format!("skill-edit-{}", entry.key))
                    .ghost()
                    .rounded(RADIUS_BUTTON)
                    .icon(icon("icons/file-text.svg").with_size(px(16.)))
                    .tooltip(t("Edit"))
                    .disabled(self.skills.loading)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.begin_skill_edit(edit_key.clone(), window, cx)
                    }))
                    .into_any_element(),
            );
            if entry.directory_trash_allowed {
                let delete_entry = entry.clone();
                actions.push(
                    Button::new(format!("skill-delete-{}", entry.key))
                        .ghost()
                        .rounded(RADIUS_BUTTON)
                        .icon(icon("icons/trash-2.svg").with_size(px(16.)))
                        .tooltip(t("Delete"))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.delete_skill(delete_entry.clone(), window, cx)
                        }))
                        .into_any_element(),
                );
            }
            let reveal = entry.file.to_string_lossy().to_string();
            actions.push(
                Button::new(format!("skill-reveal-{}", entry.key))
                    .ghost()
                    .rounded(RADIUS_BUTTON)
                    .icon(icon("icons/folder.svg").with_size(px(16.)))
                    .tooltip(reveal_in_fm())
                    .on_click(move |_, _, _| terminal::reveal_in_file_manager(&reveal))
                    .into_any_element(),
            );
        }
        let mut meta_rows = Vec::new();
        if !entry.description.trim().is_empty() {
            meta_rows.push(
                h_flex()
                    .min_w_0()
                    .gap(ICON_TEXT_GAP)
                    .child(icon("icons/info.svg").with_size(px(12.)).flex_shrink_0())
                    .child(div().min_w_0().child(entry.description.clone()))
                    .into_any_element(),
            );
        }
        meta_rows.push(
            h_flex()
                .min_w_0()
                .gap(ICON_TEXT_GAP)
                .child(
                    icon("icons/file-text.svg")
                        .with_size(px(12.))
                        .flex_shrink_0(),
                )
                .child(
                    div()
                        .min_w_0()
                        .truncate()
                        .child(tilde_path(&entry.file.to_string_lossy())),
                )
                .into_any_element(),
        );
        meta_rows.push(
            h_flex()
                .min_w_0()
                .gap(ICON_TEXT_GAP)
                .child(
                    icon("icons/calendar.svg")
                        .with_size(px(12.))
                        .flex_shrink_0(),
                )
                .child(crate::tf!("Updated {}", smart_time(entry.updated_at)))
                .into_any_element(),
        );
        let mut lead = match entry.agent {
            Some(agent) => vec![
                img(agent.brand_icon(dark))
                    .size(px(15.))
                    .flex_shrink_0()
                    .into_any_element(),
                div()
                    .flex_shrink_0()
                    .child(agent.display_name())
                    .into_any_element(),
            ],
            None => vec![
                icon("icons/folder.svg")
                    .with_size(px(15.))
                    .flex_shrink_0()
                    .into_any_element(),
                div()
                    .flex_shrink_0()
                    .child(t("Project Skill"))
                    .into_any_element(),
            ],
        };
        if !entry.project_path.is_empty() {
            lead.push(project_badge(
                "skill-project",
                &entry.project_path,
                entry.project_name.clone(),
                &theme,
            ));
        }
        let header = detail_header_frame(
            "skill-detail-header",
            lead,
            actions,
            entry.name.clone().into(),
            meta_rows,
            &theme,
        );
        let content: AnyElement = if editing {
            let Some(input) = self.skills.edit_textarea.as_ref() else {
                return div().into_any_element();
            };
            let height =
                px(((entry.body.lines().count().max(24) + 2) as f32 * 13. * 1.45).max(560.));
            Textarea::new(input)
                .w_full()
                .h(height)
                .appearance(false)
                .bordered(false)
                .text_size(FONT_MSG_BODY)
                .line_height(relative(1.45))
                .into_any_element()
        } else {
            markdown_body(
                format!("skill-{}", entry.key).into(),
                skill_preview_body(&entry.body),
                "",
                &entry.directory.to_string_lossy(),
                FONT_MSG_BODY,
                gpui::rems(0.5),
                dark,
                cx,
            )
            .into_any_element()
        };
        v_flex()
            .flex_1()
            .min_w_0()
            .h_full()
            .bg(theme.background)
            .child(header)
            .child(
                div()
                    .id("skill-reader")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .bg(theme.popover)
                    .px(SPACE_XXL)
                    .pt(SPACE_LG)
                    .pb(SPACE_XXL)
                    .child(
                        div()
                            .w_full()
                            .flex()
                            .justify_center()
                            .child(div().w_full().max_w(READER_MAX_WIDTH).child(content)),
                    ),
            )
            .into_any_element()
    }

    pub(super) fn render_skills_nav(&self, cx: &Context<Self>) -> AnyElement {
        let mut agent_counts = std::collections::BTreeMap::<AgentId, i64>::new();
        let mut project_counts = std::collections::BTreeMap::<String, (String, i64)>::new();
        let mut user_count = 0i64;
        for entry in &self.skills.entries {
            if let Some(agent) = entry.agent {
                *agent_counts.entry(agent).or_default() += 1;
            }
            if entry.project_path.is_empty() {
                user_count += 1;
            } else {
                let project = project_counts
                    .entry(entry.project_path.clone())
                    .or_insert_with(|| (entry.project_name.clone(), 0));
                project.1 += 1;
            }
        }
        let dark = cx.theme().mode.is_dark();
        let nav = self.skills.nav.clone();
        v_flex()
            .flex_1()
            .min_h_0()
            .child(
                div()
                    .flex_shrink_0()
                    .px(SIDEBAR_EDGE)
                    .pb(SPACE_MD)
                    .child(search_input_control(
                        &self.skill_query,
                        gpui_component::Size::Medium,
                        "skills-search-clear",
                        cx,
                    )),
            )
            .child(
                v_flex()
                    .flex_shrink_0()
                    .px(SIDEBAR_EDGE)
                    .pb(SPACE_XS)
                    .gap(SPACE_XS)
                    .child(sidebar_row(
                        "skills-all",
                        RowLead::Icon(icon("icons/file-text.svg")),
                        t("All Skills"),
                        Some(self.skills.entries.len() as i64),
                        nav == SkillsNav::All,
                        RowLevel::Primary,
                        cx.listener(|this, _, window, cx| {
                            this.set_skills_scope(SkillsNav::All, window, cx)
                        }),
                        cx,
                    ))
                    .child(sidebar_row(
                        "skills-user",
                        RowLead::Icon(icon("icons/user.svg")),
                        t("User Skills"),
                        Some(user_count),
                        nav == SkillsNav::User,
                        RowLevel::Primary,
                        cx.listener(|this, _, window, cx| {
                            this.set_skills_scope(SkillsNav::User, window, cx)
                        }),
                        cx,
                    )),
            )
            .child(
                v_flex()
                    .id("skills-sidebar-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .px(SIDEBAR_EDGE)
                    .pt(SPACE_XS)
                    .pb(SPACE_LG)
                    .gap(SPACE_XS)
                    .child(group_header(
                        "skills-agents-header",
                        t("Agents"),
                        self.agents_collapsed,
                        cx.listener(|this, _, _window, cx| {
                            this.agents_collapsed = !this.agents_collapsed;
                            cx.notify();
                        }),
                        cx,
                    ))
                    .when(!self.agents_collapsed, |this| {
                        this.children(agent_counts.into_iter().map(|(agent, count)| {
                            let active = nav == SkillsNav::Agent(agent);
                            sidebar_row(
                                format!("skills-agent-{}", agent.as_str()),
                                RowLead::Brand(agent.brand_icon(dark)),
                                agent.display_name(),
                                Some(count),
                                active,
                                RowLevel::Sub,
                                cx.listener(move |this, _, window, cx| {
                                    this.set_skills_scope(
                                        if active {
                                            SkillsNav::All
                                        } else {
                                            SkillsNav::Agent(agent)
                                        },
                                        window,
                                        cx,
                                    )
                                }),
                                cx,
                            )
                        }))
                    })
                    .child(group_header(
                        "skills-projects-header",
                        t("Projects"),
                        self.projects_collapsed,
                        cx.listener(|this, _, _window, cx| {
                            this.projects_collapsed = !this.projects_collapsed;
                            cx.notify();
                        }),
                        cx,
                    ))
                    .when(!self.projects_collapsed, |this| {
                        this.children(project_counts.into_iter().map(|(path, (name, count))| {
                            let active = matches!(
                                &nav,
                                SkillsNav::Project(selected) if selected == &path
                            );
                            let next = (!active).then_some(path.clone());
                            sidebar_row(
                                format!("skills-project-{path}"),
                                RowLead::Icon(icon("icons/folder.svg")),
                                name,
                                Some(count),
                                active,
                                RowLevel::Sub,
                                cx.listener(move |this, _, window, cx| {
                                    this.set_skills_scope(
                                        next.clone().map_or(SkillsNav::All, SkillsNav::Project),
                                        window,
                                        cx,
                                    )
                                }),
                                cx,
                            )
                        }))
                    }),
            )
            .into_any_element()
    }
}

fn text_fields_match_query(query: &str, fields: &[&str]) -> bool {
    let terms = query
        .split_whitespace()
        .map(str::to_lowercase)
        .collect::<Vec<_>>();
    let normalized_fields = fields
        .iter()
        .map(|field| field.to_lowercase())
        .collect::<Vec<_>>();
    terms
        .iter()
        .all(|term| normalized_fields.iter().any(|field| field.contains(term)))
}

fn skill_matches_query(entry: &SkillEntry, query: &str) -> bool {
    let file = entry.file.to_string_lossy();
    let agent = entry
        .agent
        .map(|agent| agent.display_name())
        .unwrap_or_default();
    text_fields_match_query(
        query,
        &[
            &entry.name,
            &entry.description,
            &entry.body,
            &file,
            &entry.project_name,
            &agent,
        ],
    )
}

fn skill_preview_body(body: &str) -> SharedString {
    let mut lines = body.split_inclusive('\n');
    if lines.next().map(str::trim) != Some("---") {
        return body.to_string().into();
    }
    let mut offset = body.find('\n').map_or(body.len(), |index| index + 1);
    for line in lines {
        if line.trim() == "---" {
            let tail = &body[(offset + line.len()).min(body.len())..];
            return tail.trim_start_matches(['\r', '\n']).to_string().into();
        }
        offset = (offset + line.len()).min(body.len());
    }
    body.to_string().into()
}

#[cfg(test)]
mod tests {
    use super::{skill_preview_body, text_fields_match_query};

    #[test]
    fn skill_search_matches_all_terms_across_different_fields() {
        let fields = [
            "Conversation Archivist",
            "Archive and summarize coding sessions",
            "Use this skill for JSONL conversation files.",
            "C:/Users/demo/.codex/skills/conversation-archivist/SKILL.md",
            "ContextOS",
            "Codex",
        ];

        assert!(text_fields_match_query("ARCHIVE jsonl codex", &fields));
        assert!(text_fields_match_query("  ", &fields));
        assert!(!text_fields_match_query("archive pdf", &fields));
    }

    #[test]
    fn preview_hides_frontmatter_but_keeps_markdown() {
        let preview = skill_preview_body("---\nname: demo\ndescription: Demo\n---\n\n# Body\nText");
        assert_eq!(preview.as_ref(), "# Body\nText");
    }

    #[test]
    fn preview_handles_windows_line_endings() {
        let preview = skill_preview_body("---\r\nname: demo\r\n---\r\n\r\n# Body\r\nText");
        assert_eq!(preview.as_ref(), "# Body\r\nText");
    }
}
