use crate::i18n::t;
use gpui::prelude::FluentBuilder as _;
use gpui::*;
use gpui_component::button::{Button, ButtonCustomVariant, ButtonVariants as _};
use gpui_component::input::{Input, InputEvent, InputState};
use gpui_component::menu::{DropdownMenu as _, PopupMenuItem};
use gpui_component::switch::Switch;
use gpui_component::{
    h_flex, v_flex, ActiveTheme as _, Disableable as _, Icon, Selectable as _, Sizable as _,
    StyledExt as _, TitleBar, WindowExt as _,
};

use wake_core::models::AgentId;

use crate::format::tilde_path;
use crate::ui::{
    action_button, overlay_layers, show_in_fm, BUTTON_SM_H, FONT_BODY, FONT_CAPTION, FONT_DISPLAY,
    FONT_HEADING, FONT_LABEL, FONT_TITLE, ICON_TEXT_GAP, RADIUS_BUTTON, SPACE_LG, SPACE_MD,
    SPACE_SM, SPACE_XL, SPACE_XS, SPACE_XXL,
};
use crate::update::{self, UpdateStatus};
use crate::workbench::{
    CompressionConfigField, CompressionStrategyField, DataSourceRow, JevConfigField,
    LocationSettingsSnapshot, MechanicalRuleKind, MemoryLocationRow,
    MemoryLocationSettingsSnapshot, OpenAbout, OpenSettings, OpenUpdates, Workbench,
};
use crate::{theme, theme::AppearancePreference};
use std::rc::Rc;

const SETTINGS_SIDEBAR_W: Pixels = px(180.);
const SETTINGS_PAGE_TOP: Pixels = px(38.);
fn icon(path: &'static str) -> Icon {
    Icon::empty().path(path)
}

fn format_storage_size(bytes: u64) -> String {
    const KIB: f64 = 1024.;
    const MIB: f64 = KIB * 1024.;
    const GIB: f64 = MIB * 1024.;
    let bytes = bytes as f64;
    if bytes >= GIB {
        format!("{:.1} GB", bytes / GIB)
    } else if bytes >= MIB {
        format!("{:.1} MB", bytes / MIB)
    } else if bytes >= KIB {
        format!("{:.1} KB", bytes / KIB)
    } else {
        format!("{} bytes", bytes as u64)
    }
}

fn retention_index(agent: wake_core::services::session_retention::RetentionAgent) -> usize {
    match agent {
        wake_core::services::session_retention::RetentionAgent::ClaudeCode => 0,
        wake_core::services::session_retention::RetentionAgent::Gemini => 1,
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum SettingsPage {
    General,
    CompressionService,
    CompressionStrategy,
    Locations,
    MemoryLocations,
    Remotes,
    Connect,
    Retention,
    Data,
    Updates,
    About,
}

/// Settings 内常规文字按钮共用一套尺寸和材质；避免页面各自混用
/// outline / primary / 默认 ButtonGroup 后形成多套视觉语言。
/// pub(crate):详情页的单段 Open In 按钮(workbench)用同一配方。
pub(crate) fn settings_button(button: Button, cx: &App) -> Button {
    let theme = cx.theme();
    button
        .custom(
            ButtonCustomVariant::new(cx)
                .color(theme.secondary)
                .foreground(theme.secondary_foreground)
                .hover(theme.secondary_hover)
                .active(theme.secondary_active),
        )
        .border_1()
        .border_color(theme.border)
        .small()
        .rounded(RADIUS_BUTTON)
}

/// 设置页里真正需要用户继续完成的主操作。保持 6px 圆角，但使用中号高度、
/// primary 填充和轻阴影，让它与普通的重试 / 再检查动作拉开层级。
pub(crate) fn settings_primary_button(button: Button, cx: &App) -> Button {
    let theme = cx.theme();
    button
        .custom(
            ButtonCustomVariant::new(cx)
                .color(theme.primary)
                .foreground(theme.primary_foreground)
                .hover(theme.primary_hover)
                .active(theme.primary_active)
                .shadow(true),
        )
        .border_1()
        .border_color(theme.primary)
        .rounded(RADIUS_BUTTON)
        .map(action_button)
}

/// Settings 各页顶部的标题 + 一句说明(版式只写一次:SPACE_XXL 边距、
/// SETTINGS_PAGE_TOP 顶距、FONT_TITLE semibold + FONT_CAPTION muted)
fn settings_page_header(title: &'static str, subtitle: &'static str, cx: &App) -> Div {
    let theme = cx.theme();
    v_flex()
        .flex_shrink_0()
        .px(SPACE_XXL)
        .pt(SETTINGS_PAGE_TOP)
        .pb(SPACE_XL)
        .gap(px(5.))
        .child(
            div()
                .text_size(FONT_TITLE)
                .font_semibold()
                .text_color(theme.foreground)
                .child(title),
        )
        .child(
            div()
                .text_size(FONT_CAPTION)
                .text_color(theme.muted_foreground)
                .child(subtitle),
        )
}

/// "一张卡一行"的信息卡(Data 的 Storage、Connect 的 MCP server 共用):popover
/// 底圆角卡,84px 行,主信息 FONT_BODY,副行由调用方给(caption 级),右侧一个操作
fn settings_info_card(
    primary: impl IntoElement,
    details: Vec<AnyElement>,
    trailing: AnyElement,
    min_h: Pixels,
    cx: &App,
) -> Div {
    let theme = cx.theme();
    // overflow_hidden 让 taffy 把这张卡的 min-height 当 0,放进滚动列里会被
    // 压扁到只剩一行;固定内容的卡必须 flex_shrink_0(CLAUDE.md 的 flex 陷阱)
    v_flex()
        .w_full()
        .flex_shrink_0()
        .overflow_hidden()
        .rounded(theme.radius_lg)
        .border_1()
        .border_color(theme.border)
        .bg(theme.popover)
        .child(
            h_flex()
                .min_h(min_h)
                .px(SPACE_LG)
                .gap(SPACE_LG)
                .items_center()
                .child(
                    v_flex()
                        .flex_1()
                        .min_w_0()
                        .gap(px(3.))
                        .child(
                            div()
                                .text_size(FONT_BODY)
                                .text_color(theme.foreground)
                                .child(primary),
                        )
                        .children(details),
                )
                .child(trailing),
        )
}

/// 一个并排辅助二进制的三件事。两张卡同构,所以探测也只写一遍
struct BinaryFacts {
    path: String,
    display: SharedString,
    exists: bool,
}

impl BinaryFacts {
    fn probe(primary: &str, fallback: Option<&str>) -> Self {
        let found = wake_core::mcp::sibling_named(primary)
            .filter(|p| p.is_file())
            .or_else(|| fallback.and_then(|stem| wake_core::mcp::sibling_named(stem)))
            .filter(|p| p.is_file());
        let exists = found.as_ref().is_some_and(|p| p.is_file());
        // 找不到就退回裸名,展示时至少还是个可辨认的东西
        let path = found
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| primary.to_string());
        Self {
            display: tilde_path(&path).into(),
            exists,
            path,
        }
    }
}

/// Connect 页展示的事实,开窗时算一次:current_exe/stat/片段拼装都不该跑在
/// 每帧的 render 里(CLAUDE.md:render 里的路径探测必须缓存)
struct ConnectInfo {
    mcp: BinaryFacts,
    cli: BinaryFacts,
    /// 把 contextos-cli 放进 PATH 的那条命令;deb/tar 已在 `…/bin` 里、或 Windows
    /// 上没有一行命令能说清时为 None,那时就不给这个按钮
    cli_path_command: Option<String>,
    /// MCP clients 卡的三行:文案与片段来自 wake-core,与 `contextos-mcp setup`
    /// 同源;GUI 只展示与复制,不代写别家配置
    snippets: Vec<wake_core::mcp::SetupSnippet>,
    session_hooks: Vec<wake_core::mcp::SetupSnippet>,
}

impl ConnectInfo {
    fn probe() -> Self {
        let mcp = BinaryFacts::probe("contextos-mcp", None);
        let cli = BinaryFacts::probe("contextos-cli", None);
        Self {
            snippets: wake_core::mcp::setup_snippets(std::path::Path::new(&mcp.path)),
            session_hooks: wake_core::cli::session_start_snippets(std::path::Path::new(&cli.path)),
            cli_path_command: wake_core::cli::path_command(std::path::Path::new(&cli.path)),
            mcp,
            cli,
        }
    }
}

pub(crate) struct SettingsView {
    focus_handle: FocusHandle,
    workbench: Entity<Workbench>,
    appearance: AppearancePreference,
    show_unavailable: bool,
    connect: ConnectInfo,
    /// Connect 页里展开了代码片段的行(按 snippets 下标);Settings 重开即复位
    connect_shown: std::collections::HashSet<usize>,
    /// 刚复制过的按钮 id:按钮原地显示 "Copied" 1.6s。不用 toast——gpui-component 的
    /// 通知在窗口失活或被悬停时会暂停自动关闭,Settings 这种从属窗里它常常就
    /// 挂着不走(用户 2026-09-08 反馈);主界面的 Copy Session ID / Copy code 也
    /// 从不弹通知
    copied: Option<SharedString>,
    /// 连点时只有最后一次的定时器能清掉 copied
    copied_generation: u64,
    /// Session locations / Memory locations 两页的快照:各是三条 SQL + 每路径一次 stat,
    /// 在 observe Workbench 的回调里取一次(配置变更、扫描进度、记忆同步收尾都会
    /// notify),不在 render 里每帧算——原先 hover 一下就重查一遍库(2026-09-22 /simplify)
    locations: LocationSettingsSnapshot,
    memory_locations: MemoryLocationSettingsSnapshot,
    storage_stats: Option<wake_core::storage::StorageStats>,
    storage_loading: bool,
    storage_pending: Option<std::path::PathBuf>,
    storage_error: Option<String>,
    retention: Vec<wake_core::services::session_retention::RetentionSnapshot>,
    codex_compression:
        Option<wake_core::services::codex_session_compression::CodexCompressionSnapshot>,
    retention_inputs: [Entity<InputState>; 2],
    retention_errors: [Option<String>; 2],
    retention_loaded: bool,
    _workbench_observer: Option<Subscription>,
}

/// location 行菜单里的一个动作(Edit… / Remove):Settings 只转发给 Workbench
type RowAction = Rc<dyn Fn(&mut Window, &mut App)>;

/// 行末的 `…` 菜单(两页共用):Edit…(可编辑的行)、Show in Finder(路径存在时)、分隔线 +
/// Remove(可删的自定义行);每项都是 Option,两页按自己的规则给
fn row_menu(
    ix: usize,
    edit: Option<RowAction>,
    reveal: Option<SharedString>,
    remove: Option<RowAction>,
) -> impl IntoElement {
    Button::new(("settings-location-menu", ix))
        .ghost()
        .small()
        .rounded(RADIUS_BUTTON)
        .icon(icon("icons/more-horizontal.svg").with_size(px(14.)))
        .dropdown_menu(move |menu, _, _| {
            let mut menu = menu.min_w(px(180.));
            if let Some(edit) = edit.clone() {
                menu = menu.item(
                    PopupMenuItem::new(t("Edit…")).on_click(move |_, window, cx| edit(window, cx)),
                );
            }
            if let Some(path) = reveal.clone() {
                menu = menu.item(PopupMenuItem::new(show_in_fm()).on_click(move |_, _, _| {
                    wake_core::services::terminal::open_in_file_manager(path.as_ref())
                }));
            }
            if let Some(remove) = remove.clone() {
                menu = menu.separator().item(
                    PopupMenuItem::new(t("Remove"))
                        .on_click(move |_, window, cx| remove(window, cx)),
                );
            }
            menu
        })
}

/// 快照的行按 agent 成组(快照已按 AgentId 声明序排好,相邻同家即一组)
fn group_by_agent<R>(rows: Vec<R>, agent: impl Fn(&R) -> AgentId) -> Vec<(AgentId, Vec<R>)> {
    let mut groups: Vec<(AgentId, Vec<R>)> = Vec::new();
    for row in rows {
        match groups.last_mut() {
            Some((a, rows)) if *a == agent(&row) => rows.push(row),
            _ => groups.push((agent(&row), vec![row])),
        }
    }
    groups
}

impl SettingsView {
    pub(crate) fn new(
        workbench: Entity<Workbench>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let observed = workbench.clone();
        // Settings 是在 Workbench::open_settings 的 update 栈内创建的；此处
        // 立即 observe 会尝试反读仍被独占借用的 Workbench，触发 double lease。
        // 下一帧注册时外层 update 已退出。
        let retention_inputs = [
            cx.new(|cx| InputState::new(window, cx).placeholder("30")),
            cx.new(|cx| InputState::new(window, cx).placeholder("30d")),
        ];
        for (ix, input) in retention_inputs.iter().enumerate() {
            cx.subscribe_in(input, window, move |this, _, event, _, cx| {
                if matches!(event, InputEvent::Change) {
                    this.retention_errors[ix] = None;
                    cx.notify();
                }
            })
            .detach();
        }
        cx.on_next_frame(window, move |this, window, cx| {
            this.refresh_snapshots(observed.read(cx));
            this.storage_pending = wake_core::storage::pending_root();
            this.refresh_storage_stats(cx);
            this.initialize_retention_inputs(window, cx);
            this._workbench_observer = Some(cx.observe(&observed, |this, workbench, cx| {
                this.refresh_snapshots(workbench.read(cx));
                cx.notify()
            }));
            cx.notify();
        });
        Self {
            focus_handle: cx.focus_handle(),
            workbench,
            appearance: theme::appearance_preference(),
            show_unavailable: false,
            connect: ConnectInfo::probe(),
            connect_shown: Default::default(),
            copied: None,
            copied_generation: 0,
            locations: LocationSettingsSnapshot {
                rows: Vec::new(),
                diverged: false,
            },
            memory_locations: MemoryLocationSettingsSnapshot {
                rows: Vec::new(),
                diverged: false,
            },
            storage_stats: None,
            storage_loading: false,
            storage_pending: None,
            storage_error: None,
            retention: Vec::new(),
            codex_compression: None,
            retention_inputs,
            retention_errors: [None, None],
            retention_loaded: false,
            _workbench_observer: None,
        }
    }

    fn render_nav_item(
        &self,
        id: &'static str,
        label: &'static str,
        icon_path: &'static str,
        page: SettingsPage,
        cx: &Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme();
        let active = self.workbench.read(cx).settings_page() == page;
        let workbench = self.workbench.clone();
        h_flex()
            .id(id)
            .h(px(34.))
            .w_full()
            .px(SPACE_MD)
            .gap(SPACE_SM)
            .items_center()
            .rounded(theme.radius)
            .cursor_pointer()
            .when(active, |this| {
                this.bg(theme.sidebar_accent)
                    .text_color(theme.sidebar_accent_foreground)
            })
            .when(!active, |this| {
                this.text_color(theme.sidebar_foreground)
                    .hover(|style| style.bg(theme.sidebar_accent.opacity(0.55)))
            })
            .on_click(move |_, _, cx| {
                workbench.update(cx, |this, cx| this.select_settings_page(page, cx));
            })
            .child(icon(icon_path).with_size(px(15.)).flex_shrink_0())
            .child(div().text_size(FONT_BODY).font_medium().child(label))
            .into_any_element()
    }

    fn render_sidebar(&self, window: &Window, cx: &Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let show_titlebar = cfg!(target_os = "macos")
            || matches!(window.window_decorations(), Decorations::Client { .. });

        v_flex()
            .w(SETTINGS_SIDEBAR_W)
            .h_full()
            .flex_shrink_0()
            .bg(theme.sidebar)
            .border_r_1()
            .border_color(theme.sidebar_border)
            .when(show_titlebar, |this| this.child(TitleBar::new()))
            .child(
                div()
                    .px(SPACE_LG)
                    .pt(SPACE_SM)
                    .pb(SPACE_XL)
                    .text_size(FONT_HEADING)
                    .font_semibold()
                    .text_color(theme.sidebar_foreground)
                    .child(t("Settings")),
            )
            .child(
                v_flex()
                    .flex_1()
                    .px(SPACE_SM)
                    .gap(px(2.))
                    .child(self.render_nav_item(
                        "settings-general-nav",
                        t("General"),
                        "icons/settings.svg",
                        SettingsPage::General,
                        cx,
                    ))
                    .child(self.render_nav_item(
                        "settings-compression-service-nav",
                        "压缩服务",
                        "icons/plug.svg",
                        SettingsPage::CompressionService,
                        cx,
                    ))
                    .child(self.render_nav_item(
                        "settings-compression-strategy-nav",
                        "压缩策略",
                        "icons/file-text.svg",
                        SettingsPage::CompressionStrategy,
                        cx,
                    ))
                    .child(self.render_nav_item(
                        "settings-locations-nav",
                        t("Session locations"),
                        "icons/hard-drive.svg",
                        SettingsPage::Locations,
                        cx,
                    ))
                    .child(self.render_nav_item(
                        "settings-memory-locations-nav",
                        t("Memory locations"),
                        "icons/brain.svg",
                        SettingsPage::MemoryLocations,
                        cx,
                    ))
                    .child(self.render_nav_item(
                        "settings-connect-nav",
                        t("Connect"),
                        "icons/plug.svg",
                        SettingsPage::Connect,
                        cx,
                    ))
                    .child(self.render_nav_item(
                        "settings-retention-nav",
                        t("Session retention"),
                        "icons/clock-3.svg",
                        SettingsPage::Retention,
                        cx,
                    ))
                    .child(self.render_nav_item(
                        "settings-data-nav",
                        t("Data"),
                        "icons/database.svg",
                        SettingsPage::Data,
                        cx,
                    )),
            )
            .into_any_element()
    }

    /// General 页的设置行:与 Data/Connect 的信息卡同一张卡,只是矮一档
    /// (72 是 Appearance 行的用户定稿值),副行是 caption 级说明
    fn setting_row(
        title: impl Into<SharedString>,
        subtitle: impl Into<SharedString>,
        control: impl IntoElement,
        cx: &Context<Self>,
    ) -> AnyElement {
        let title: SharedString = title.into();
        let subtitle: SharedString = subtitle.into();
        let caption = div()
            .text_size(FONT_CAPTION)
            .text_color(cx.theme().muted_foreground)
            .child(subtitle)
            .into_any_element();
        settings_info_card(
            div().child(title),
            vec![caption],
            control.into_any_element(),
            px(72.),
            cx,
        )
        .into_any_element()
    }

    fn explained_setting_row(
        title: &'static str,
        explanation: &'static str,
        summary: impl Into<SharedString>,
        control: impl IntoElement,
        cx: &Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme();
        let title_line = h_flex()
            .min_w_0()
            .flex_wrap()
            .items_center()
            .gap_x(SPACE_SM)
            .gap_y(px(2.))
            .child(
                div()
                    .flex_shrink_0()
                    .text_size(FONT_BODY)
                    .text_color(theme.foreground)
                    .child(title),
            )
            .child(
                div()
                    .min_w(px(220.))
                    .flex_1()
                    .text_size(FONT_CAPTION)
                    .text_color(theme.muted_foreground)
                    .child(explanation),
            );
        let summary = div()
            .text_size(FONT_CAPTION)
            .text_color(theme.muted_foreground)
            .child(summary.into())
            .into_any_element();
        settings_info_card(
            title_line,
            vec![summary],
            control.into_any_element(),
            px(84.),
            cx,
        )
        .into_any_element()
    }

    /// 语言选择:System + English + 装好的语言包。选项数量随语言包增减,
    /// 所以是下拉而不是 Appearance 那样的分段控件
    fn language_control(&self) -> AnyElement {
        // 直接读全局:镜像成字段就要在每个切换点写回,而 `apply_language`
        // 改的是全局(appearance 那个字段正是这么漂的)
        let current = crate::i18n::preference().map(|locale| locale.tag);
        Button::new("settings-language")
            .outline()
            .small()
            .rounded(RADIUS_BUTTON)
            .label(current.map_or(t("System"), |tag| {
                crate::i18n::available()
                    .iter()
                    .find(|locale| locale.tag == tag)
                    .map_or(t("System"), |locale| locale.name)
            }))
            .icon(icon("icons/chevron-down.svg").with_size(px(14.)))
            .dropdown_menu(move |mut menu, _, _| {
                // 选项只在菜单打开时才需要,`available()` 又是 'static 切片
                // ——留在闭包里就不必每帧建一个 Vec 再 clone 一份进来
                menu = menu.min_w(px(160.));
                let options = std::iter::once((None, t("System"))).chain(
                    crate::i18n::available()
                        .iter()
                        .map(|locale| (Some(locale.tag), locale.name)),
                );
                for (tag, name) in options {
                    menu = menu.item(PopupMenuItem::new(name).checked(tag == current).on_click(
                        move |_, window, cx| {
                            if let Err(error) = crate::i18n::set_language(tag, cx) {
                                window.push_notification(
                                    gpui_component::notification::Notification::error(crate::tf!(
                                        "Couldn't save language: {}",
                                        error
                                    )),
                                    cx,
                                );
                            }
                        },
                    ));
                }
                menu
            })
            .into_any_element()
    }

    fn jev_config_control(
        &self,
        id: &'static str,
        field: JevConfigField,
        status: SharedString,
        cx: &Context<Self>,
    ) -> AnyElement {
        let workbench = self.workbench.clone();
        h_flex()
            .gap(SPACE_SM)
            .items_center()
            .child(
                div()
                    .max_w(px(220.))
                    .truncate()
                    .text_size(FONT_CAPTION)
                    .text_color(cx.theme().muted_foreground)
                    .child(status),
            )
            .child(settings_button(Button::new(id).label("设置"), cx).on_click(
                move |_, window, cx| {
                    workbench.update(cx, |this, cx| {
                        this.open_jev_config_form(field, window, cx);
                    });
                },
            ))
            .into_any_element()
    }

    fn compression_config_control(
        &self,
        id: &'static str,
        field: CompressionConfigField,
        status: SharedString,
        cx: &Context<Self>,
    ) -> AnyElement {
        let workbench = self.workbench.clone();
        h_flex()
            .gap(SPACE_SM)
            .items_center()
            .child(
                div()
                    .max_w(px(220.))
                    .truncate()
                    .text_size(FONT_CAPTION)
                    .text_color(cx.theme().muted_foreground)
                    .child(status),
            )
            .child(settings_button(Button::new(id).label("设置"), cx).on_click(
                move |_, window, cx| {
                    workbench.update(cx, |this, cx| {
                        this.open_compression_config_form(field, window, cx);
                    });
                },
            ))
            .into_any_element()
    }

    fn compression_strategy_control(
        &self,
        id: &'static str,
        field: CompressionStrategyField,
        cx: &Context<Self>,
    ) -> AnyElement {
        let workbench = self.workbench.clone();
        settings_button(Button::new(id).label("编辑"), cx)
            .on_click(move |_, window, cx| {
                workbench.update(cx, |this, cx| {
                    this.open_compression_strategy_form(field, window, cx);
                });
            })
            .into_any_element()
    }

    fn mechanical_rule_control(
        &self,
        id: &'static str,
        rule: MechanicalRuleKind,
        cx: &Context<Self>,
    ) -> AnyElement {
        let workbench = self.workbench.clone();
        settings_button(Button::new(id).label("编辑"), cx)
            .on_click(move |_, window, cx| {
                workbench.update(cx, |this, cx| {
                    this.open_mechanical_rule_form(rule, window, cx);
                });
            })
            .into_any_element()
    }

    fn render_compression_service(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let settings = self.workbench.read(cx).compression_settings();
        let decision = self.workbench.read(cx).jev_config();
        let is_laya = decision.provider
            == wake_core::services::compression_settings::DecisionModelProvider::Laya;
        let managed_laya = is_laya
            && decision.laya_runtime_mode
                == wake_core::services::laya_runtime::LayaRuntimeMode::Managed;
        let show_connection = !is_laya || !managed_laya;
        let laya_status = wake_core::services::laya_runtime::manager().status();
        let external_capabilities = self.workbench.read(cx).laya_external_capabilities();
        let external_capability_status: SharedString = external_capabilities
            .as_ref()
            .map(|capabilities| {
                let compatibility = if capabilities.single && capabilities.batch {
                    "Single 兼容可用 · Batch 可用"
                } else if capabilities.single {
                    "Single 兼容可用 · Batch 不可用"
                } else {
                    "Single 兼容不可用"
                };
                format!(
                    "{} · 模型 {}",
                    compatibility,
                    capabilities.model.as_deref().unwrap_or("unknown")
                )
            })
            .unwrap_or_else(|| "尚未检测".into())
            .into();
        let external_capability_error: SharedString = external_capabilities
            .as_ref()
            .and_then(|capabilities| {
                if capabilities.single {
                    None
                } else {
                    capabilities
                        .single_error
                        .as_ref()
                        .or(capabilities.health_error.as_ref())
                }
            })
            .cloned()
            .unwrap_or_default()
            .into();
        let laya_install_status: SharedString = match laya_status.install_state {
            wake_core::services::laya_runtime::LayaInstallState::NotInstalled => "未安装".into(),
            wake_core::services::laya_runtime::LayaInstallState::Installing => {
                let stage = match laya_status.current_stage.as_deref() {
                    Some("download_uv") => "下载安装器",
                    Some("verify_uv") => "校验安装器",
                    Some("install_python") => "安装 Python",
                    Some("create_venv") => "创建运行环境",
                    Some("install_laya") => "安装 Laya",
                    Some("download_model") => "下载并加载模型",
                    Some("health_check") => "检查服务健康",
                    Some("batch_smoke_test") => "验证批量推理",
                    Some("activate_installation") => "切换运行时",
                    Some("complete") => "完成",
                    _ => "安装中",
                };
                match laya_status.progress {
                    Some(progress) => format!("{stage} · {:.0}%", progress * 100.0).into(),
                    None => stage.into(),
                }
            }
            wake_core::services::laya_runtime::LayaInstallState::Installed => "已安装".into(),
            wake_core::services::laya_runtime::LayaInstallState::Broken => "安装损坏".into(),
        };
        let laya_service_status: SharedString = match laya_status.service_state {
            wake_core::services::laya_runtime::LayaServiceState::Stopped => "已停止".into(),
            wake_core::services::laya_runtime::LayaServiceState::Starting => "正在启动".into(),
            wake_core::services::laya_runtime::LayaServiceState::Ready => "已就绪".into(),
            wake_core::services::laya_runtime::LayaServiceState::Failed => "启动失败".into(),
        };
        let laya_version_status: SharedString = laya_status
            .installed_version
            .clone()
            .unwrap_or_else(|| "-".into())
            .into();
        let laya_model_status: SharedString = laya_status
            .model_revision
            .as_ref()
            .map(|revision| format!("laya-multilingual · {revision}"))
            .unwrap_or_else(|| "laya-multilingual".into())
            .into();
        let laya_error_status: SharedString = laya_status
            .error
            .as_ref()
            .map(|error| format!("{}：{}", error.stage, error.message))
            .unwrap_or_default()
            .into();
        let laya_install_dir = wake_core::services::laya_runtime::manager()
            .installation_dir()
            .to_string_lossy()
            .to_string();
        let laya_log_path = laya_status
            .error
            .as_ref()
            .and_then(|error| error.log_path.as_ref())
            .map(|path| path.to_string_lossy().to_string());
        let llm_provider_status: SharedString = crate::tf!(
            "{} / {}",
            settings.llm_provider_index + 1,
            settings.llm_provider_name
        )
        .into();
        let llm_timeout_status: SharedString = format!("{} 秒", settings.llm_timeout_secs).into();
        let llm_input_limit_status: SharedString =
            format!("{} 字符", settings.llm_input_limit_chars).into();
        let decision_url_status: SharedString = if decision.api_url.trim().is_empty() {
            "未配置".into()
        } else {
            decision.api_url.clone().into()
        };
        let decision_key_status: SharedString = if decision.api_key.trim().is_empty() {
            if decision.provider.requires_api_key() {
                "未配置".into()
            } else {
                "无需配置".into()
            }
        } else {
            "已配置".into()
        };
        let decision_model_status: SharedString = decision.model.clone().into();
        let decision_timeout_status: SharedString = format!("{} 秒", decision.timeout_secs).into();
        let toggle_entity = self.workbench.clone();
        let llm_toggle_entity = self.workbench.clone();
        let provider_entity = self.workbench.clone();
        let jev_provider_entity = self.workbench.clone();
        let laya_provider_entity = self.workbench.clone();
        let managed_mode_entity = self.workbench.clone();
        let external_mode_entity = self.workbench.clone();
        let install_laya_entity = self.workbench.clone();
        let reinstall_laya_entity = self.workbench.clone();
        let start_laya_entity = self.workbench.clone();
        let stop_laya_entity = self.workbench.clone();
        let uninstall_laya_entity = self.workbench.clone();
        let purge_laya_entity = self.workbench.clone();
        let probe_laya_entity = self.workbench.clone();

        v_flex()
            .flex_1()
            .min_w_0()
            .h_full()
            .bg(theme.background)
            .child(settings_page_header(
                "压缩服务",
                "配置 LLM 和决策模型的连接、开关、模型和运行上限。",
                cx,
            ))
            .child(
                v_flex()
                    .id("settings-compression-service-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .px(SPACE_XXL)
                    .pb(SPACE_XXL)
                    .gap(SPACE_MD)
                    .child(Self::setting_row(
                        "LLM 生成",
                        "关闭后只执行基础机械压缩，不调用 LLM。",
                        h_flex()
                            .gap(SPACE_SM)
                            .items_center()
                            .child(Switch::new("compression-service-llm-enabled").checked(settings.llm_enabled))
                            .child(settings_button(
                                Button::new("compression-service-llm-toggle").label(if settings.llm_enabled { "关闭" } else { "启用" }),
                                cx,
                            ).on_click(move |_, window, cx| {
                                llm_toggle_entity.update(cx, |this, cx| {
                                    this.toggle_compression_llm(window, cx);
                                });
                            })),
                        cx,
                    ))
                    .child(Self::setting_row(
                        "模型配置",
                        "不限数量的 OpenAI-compatible Provider；名称、URL、Key 和模型在同一弹窗中管理。",
                        h_flex()
                            .gap(SPACE_SM)
                            .items_center()
                            .child(div().max_w(px(220.)).truncate().text_size(FONT_CAPTION).text_color(theme.muted_foreground).child(llm_provider_status))
                            .child(settings_button(Button::new("compression-service-llm-provider-manager").label("模型配置"), cx).on_click(move |_, window, cx| {
                                provider_entity.update(cx, |this, cx| {
                                    this.open_llm_provider_manager(window, cx);
                                });
                            })),
                        cx,
                    ))
                    .child(Self::setting_row(
                        "LLM Timeout",
                        "LLM 压缩生成的请求超时时间，长对话建议 600 秒或更高。",
                        self.compression_config_control("compression-service-llm-timeout", CompressionConfigField::LlmTimeoutSecs, llm_timeout_status, cx),
                        cx,
                    ))
                    .child(Self::setting_row(
                        "LLM 输入上限",
                        "送入 LLM 的最大字符数，不是 token；默认 1,000,000，超长会更慢且更耗 token。",
                        self.compression_config_control("compression-service-llm-input-limit", CompressionConfigField::LlmInputLimitChars, llm_input_limit_status, cx),
                        cx,
                    ))
                    .child(Self::setting_row(
                        "决策模型辅助评分",
                        "启用后先评分工具输出，再按六档动作处理并交给 LLM。",
                        h_flex()
                            .gap(SPACE_SM)
                            .items_center()
                            .child(Switch::new("compression-service-jev-enabled").checked(settings.jev_enabled))
                            .child(settings_button(
                                Button::new("compression-service-jev-toggle").label(if settings.jev_enabled { "关闭" } else { "启用" }),
                                cx,
                            ).on_click(move |_, window, cx| {
                                toggle_entity.update(cx, |this, cx| {
                                    this.toggle_compression_jev(window, cx);
                                });
                            })),
                        cx,
                    ))
                    .child(Self::setting_row(
                        "决策模型提供方",
                        "Jev 使用云端 Key；Laya 可连接本地 /v1/systemone 服务。",
                        h_flex()
                            .gap(SPACE_SM)
                            .items_center()
                            .child(settings_button(Button::new("compression-service-provider-jev").label("Jev"), cx).selected(
                                decision.provider == wake_core::services::compression_settings::DecisionModelProvider::Jev,
                            ).on_click(move |_, window, cx| {
                                jev_provider_entity.update(cx, |this, cx| {
                                    this.set_decision_provider(
                                        wake_core::services::compression_settings::DecisionModelProvider::Jev,
                                        window,
                                        cx,
                                    );
                                });
                            }))
                            .child(settings_button(Button::new("compression-service-provider-laya").label("Laya"), cx).selected(
                                decision.provider == wake_core::services::compression_settings::DecisionModelProvider::Laya,
                            ).on_click(move |_, window, cx| {
                                laya_provider_entity.update(cx, |this, cx| {
                                    this.set_decision_provider(
                                        wake_core::services::compression_settings::DecisionModelProvider::Laya,
                                        window,
                                        cx,
                                    );
                                });
                            })),
                        cx,
                    ))
                    .when(is_laya, |this| this.child(Self::setting_row(
                        "Laya 运行方式",
                        "托管模式由 ContextOS 安装和管理；外部服务保留完整自部署能力。",
                        h_flex()
                            .gap(SPACE_SM)
                            .items_center()
                            .child(settings_button(Button::new("compression-service-laya-managed").label("ContextOS 托管"), cx).selected(
                                decision.laya_runtime_mode == wake_core::services::laya_runtime::LayaRuntimeMode::Managed,
                            ).on_click(move |_, window, cx| {
                                managed_mode_entity.update(cx, |this, cx| {
                                    this.set_laya_runtime_mode(
                                        wake_core::services::laya_runtime::LayaRuntimeMode::Managed,
                                        window,
                                        cx,
                                    );
                                });
                            }))
                            .child(settings_button(Button::new("compression-service-laya-external").label("外部服务"), cx).selected(
                                decision.laya_runtime_mode == wake_core::services::laya_runtime::LayaRuntimeMode::External,
                            ).on_click(move |_, window, cx| {
                                external_mode_entity.update(cx, |this, cx| {
                                    this.set_laya_runtime_mode(
                                        wake_core::services::laya_runtime::LayaRuntimeMode::External,
                                        window,
                                        cx,
                                    );
                                });
                            })),
                        cx,
                    )))
                    .child(Self::setting_row(
                        "决策模型",
                        "发送到 System 1 服务的模型名。",
                        self.jev_config_control("compression-service-decision-model", JevConfigField::Model, decision_model_status, cx),
                        cx,
                    ))
                    .when(show_connection, |this| this
                        .child(Self::setting_row(
                            "决策模型 API URL",
                            if is_laya { "外部 Laya 使用 /v1/systemone Single 兼容接口。" } else { "SystemOne 服务基址。" },
                            self.jev_config_control("compression-service-decision-url", if is_laya { JevConfigField::LayaApiUrl } else { JevConfigField::JevApiUrl }, decision_url_status, cx),
                            cx,
                        ))
                        .child(Self::setting_row(
                            "决策模型 API Key",
                            if decision.provider.requires_api_key() { "本地保存，不在界面明文展示。" } else { "外部 Laya 服务未启用认证时可留空。" },
                            self.jev_config_control("compression-service-decision-key", if is_laya { JevConfigField::LayaApiKey } else { JevConfigField::JevApiKey }, decision_key_status, cx),
                            cx,
                        )))
                    .when(is_laya && !managed_laya, |this| this.child(Self::setting_row(
                        "外部服务能力",
                        "外部 Laya 需要 single 能力；batch 仅作为附加诊断信息。",
                        h_flex()
                            .gap(SPACE_SM)
                            .items_center()
                            .child(div().max_w(px(330.)).truncate().text_size(FONT_CAPTION).text_color(
                                if external_capabilities.as_ref().is_some_and(|capabilities| capabilities.single) {
                                    theme.success
                                } else {
                                    theme.muted_foreground
                                }
                            ).child(if external_capability_error.is_empty() {
                                external_capability_status
                            } else {
                                external_capability_error
                            }))
                            .child(settings_button(Button::new("compression-service-laya-probe").label("检测能力"), cx).on_click(move |_, _, cx| {
                                probe_laya_entity.update(cx, |this, cx| this.probe_external_laya(cx));
                            })),
                        cx,
                    )))
                    .when(managed_laya, |this| this
                        .child(Self::setting_row(
                            "安装状态",
                            "Python、PyTorch、Laya 和模型合计为数 GB；只有真实批量推理通过才算安装成功。",
                            div().text_size(FONT_CAPTION).text_color(theme.muted_foreground).child(laya_install_status),
                            cx,
                        ))
                        .child(Self::setting_row(
                            "服务状态",
                            "应用启动后在后台加载；未就绪时压缩会返回明确错误。",
                            div().text_size(FONT_CAPTION).text_color(theme.muted_foreground).child(laya_service_status),
                            cx,
                        ))
                        .child(Self::setting_row(
                            "运行时版本",
                            "ContextOS 固定并验证的托管运行时版本。",
                            div().text_size(FONT_CAPTION).text_color(theme.muted_foreground).child(laya_version_status),
                            cx,
                        ))
                        .child(Self::setting_row(
                            "模型",
                            "托管模式固定使用 multilingual checkpoint。",
                            div().max_w(px(280.)).truncate().text_size(FONT_CAPTION).text_color(theme.muted_foreground).child(laya_model_status),
                            cx,
                        ))
                        .when(laya_status.error.is_some(), |this| this.child(Self::setting_row(
                            "最近错误",
                            "完整诊断保存在本地日志。",
                            h_flex()
                                .gap(SPACE_SM)
                                .items_center()
                                .child(div().max_w(px(260.)).truncate().text_size(FONT_CAPTION).text_color(theme.muted_foreground).child(laya_error_status))
                                .when_some(laya_log_path.clone(), |this, path| this.child(settings_button(Button::new("compression-service-laya-log").label("打开日志"), cx).on_click(move |_, _, _| {
                                    wake_core::services::terminal::open_in_file_manager(&path);
                                }))),
                            cx,
                        )))
                        .child(Self::setting_row(
                            "运行时管理",
                            "卸载默认保留模型缓存；删除模型会释放更多磁盘空间。",
                            h_flex()
                                .flex_wrap()
                                .gap(SPACE_SM)
                                .items_center()
                                .when(matches!(laya_status.install_state, wake_core::services::laya_runtime::LayaInstallState::NotInstalled | wake_core::services::laya_runtime::LayaInstallState::Broken), |this| this.child(
                                    settings_button(Button::new("compression-service-laya-install").label(if laya_status.install_state == wake_core::services::laya_runtime::LayaInstallState::Broken { "重试安装" } else { "安装 Laya" }), cx)
                                        .on_click(move |_, _, cx| install_laya_entity.update(cx, |this, cx| this.install_managed_laya(cx)))
                                ))
                                .when(laya_status.install_state == wake_core::services::laya_runtime::LayaInstallState::Installing, |this| this.child(
                                    settings_button(Button::new("compression-service-laya-installing").label("安装中"), cx).disabled(true)
                                ))
                                .when(laya_status.install_state == wake_core::services::laya_runtime::LayaInstallState::Installed, |this| this
                                    .child(settings_button(Button::new("compression-service-laya-reinstall").label("重新安装"), cx)
                                        .on_click(move |_, _, cx| reinstall_laya_entity.update(cx, |this, cx| this.install_managed_laya(cx))))
                                    .when(laya_status.service_state == wake_core::services::laya_runtime::LayaServiceState::Stopped
                                        || laya_status.service_state == wake_core::services::laya_runtime::LayaServiceState::Failed && !laya_status.cleanup_required, |this| this.child(
                                        settings_button(Button::new("compression-service-laya-start").label("启动"), cx)
                                            .on_click(move |_, _, cx| start_laya_entity.update(cx, |this, cx| this.start_managed_laya(cx)))
                                    ))
                                    .when(laya_status.service_state == wake_core::services::laya_runtime::LayaServiceState::Ready
                                        || laya_status.service_state == wake_core::services::laya_runtime::LayaServiceState::Failed && laya_status.cleanup_required, |this| this.child(
                                        settings_button(Button::new("compression-service-laya-stop").label("停止"), cx)
                                            .on_click(move |_, _, cx| stop_laya_entity.update(cx, |this, cx| this.stop_managed_laya(cx)))
                                    ))
                                    .child(settings_button(Button::new("compression-service-laya-reveal").label("打开文件位置"), cx).on_click(move |_, _, _| {
                                        wake_core::services::terminal::open_in_file_manager(&laya_install_dir);
                                    }))
                                    .child(settings_button(Button::new("compression-service-laya-uninstall").label("卸载"), cx)
                                        .on_click(move |_, _, cx| uninstall_laya_entity.update(cx, |this, cx| this.uninstall_managed_laya(false, cx))))
                                    .child(settings_button(Button::new("compression-service-laya-purge").label("卸载并删除模型"), cx)
                                        .on_click(move |_, _, cx| purge_laya_entity.update(cx, |this, cx| this.uninstall_managed_laya(true, cx))))
                                ),
                            cx,
                        )))
                    .child(Self::setting_row(
                        "决策模型 Timeout",
                        "System 1 请求超时时间，单位秒。",
                        self.jev_config_control("compression-service-decision-timeout", JevConfigField::TimeoutSecs, decision_timeout_status, cx),
                        cx,
                    )),
            )
            .into_any_element()
    }

    fn render_compression_strategy(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let strategy = self.workbench.read(cx).compression_strategy_settings();
        let mechanical = &strategy.mechanical;
        let jev_entity = self.workbench.clone();
        let temperature_entity = self.workbench.clone();
        let retention_mode = mechanical.retention_mode;
        let allow_assistant_body_delete = mechanical.allow_jev_delete_assistant_body;
        let allow_user_message_delete = mechanical.allow_jev_delete_user_messages;
        let retention_entity = self.workbench.clone();
        let assistant_delete_entity = self.workbench.clone();
        let user_delete_entity = self.workbench.clone();
        let limits_entity = self.workbench.clone();
        let enabled = |value: bool| if value { "已启用" } else { "已停用" };
        let mechanical_rows = vec![
            (
                "空/低信息输出",
                "删除空输出和短小成功回执，仅保留必要的退出状态。",
                format!(
                    "{} · 成功输出 < {} 字符 · write_stdin < {} 字符",
                    enabled(mechanical.empty_output_rule.enabled),
                    mechanical.empty_output_rule.success_output_max_chars,
                    mechanical.empty_output_rule.write_stdin_max_chars
                ),
                "mechanical-empty-output",
                MechanicalRuleKind::EmptyOutput,
            ),
            (
                "错误/失败保护",
                "识别失败输出，保留命令、错误关键行和头尾上下文。",
                format!(
                    "{} · 头 {} / 尾 {} · {} 个失败关键词",
                    enabled(mechanical.error_protection_rule.enabled),
                    mechanical.error_protection_rule.head_chars,
                    mechanical.error_protection_rule.tail_chars,
                    mechanical.error_protection_rule.failure_keywords.len()
                ),
                "mechanical-error-protection",
                MechanicalRuleKind::ErrorProtection,
            ),
            (
                "Patch/Diff 证据",
                "裁剪较大的补丁，按文件和 Hunk 保留修改证据。",
                format!(
                    "{} · 头 {} / 尾 {} · 每文件最多 {} 个 Hunk",
                    enabled(mechanical.patch_rule.enabled),
                    mechanical.patch_rule.head_chars,
                    mechanical.patch_rule.tail_chars,
                    mechanical.patch_rule.max_hunks_per_file
                ),
                "mechanical-patch",
                MechanicalRuleKind::Patch,
            ),
            (
                "源码/代码分析输出",
                "缩减源码读取和代码分析长文本，保留关键头尾内容。",
                format!(
                    "{} · 最多 {} 行 · 头 {} / 尾 {}",
                    enabled(mechanical.source_listing_rule.enabled),
                    mechanical.source_listing_rule.max_lines,
                    mechanical.source_listing_rule.head_chars,
                    mechanical.source_listing_rule.tail_chars
                ),
                "mechanical-source-listing",
                MechanicalRuleKind::SourceListing,
            ),
            (
                "搜索输出",
                "对搜索结果去重并限制条数，保留前后匹配。",
                format!(
                    "{} · 最多 {} 条 · 前 {} / 尾 {}",
                    enabled(mechanical.search_output_rule.enabled),
                    mechanical.search_output_rule.max_matches,
                    mechanical.search_output_rule.head_matches,
                    mechanical.search_output_rule.tail_matches
                ),
                "mechanical-search-output",
                MechanicalRuleKind::SearchOutput,
            ),
            (
                "列表/表格输出",
                "缩减目录、列表和表格输出，保留前后项目。",
                format!(
                    "{} · 最多 {} 项 · 前 {} / 尾 {}",
                    enabled(mechanical.listing_output_rule.enabled),
                    mechanical.listing_output_rule.max_items,
                    mechanical.listing_output_rule.head_items,
                    mechanical.listing_output_rule.tail_items
                ),
                "mechanical-listing-output",
                MechanicalRuleKind::ListingOutput,
            ),
            (
                "说明/工具规格",
                "从长说明中保留标题、工具名称和关键规范。",
                format!(
                    "{} · 最多 {} 个标题 / {} 个工具名",
                    enabled(mechanical.instruction_and_tool_spec_rule.enabled),
                    mechanical.instruction_and_tool_spec_rule.max_headings,
                    mechanical.instruction_and_tool_spec_rule.max_tool_names
                ),
                "mechanical-tool-spec",
                MechanicalRuleKind::InstructionAndToolSpec,
            ),
            (
                "通用大输出",
                "处理未命中专用规则的大输出，并可交给决策模型继续判断。",
                format!(
                    "{} · 超过 {} 字符 · 头 {} / 尾 {}{}",
                    enabled(mechanical.generic_large_output_rule.enabled),
                    mechanical.generic_large_output_rule.min_output_chars,
                    mechanical.generic_large_output_rule.head_chars,
                    mechanical.generic_large_output_rule.tail_chars,
                    if mechanical.generic_large_output_rule.mark_jev_candidate {
                        " · 送决策模型"
                    } else {
                        ""
                    }
                ),
                "mechanical-generic-large",
                MechanicalRuleKind::GenericLargeOutput,
            ),
        ];
        let mechanical_elements = mechanical_rows
            .into_iter()
            .map(|(title, explanation, description, id, rule)| {
                Self::explained_setting_row(
                    title,
                    explanation,
                    description,
                    self.mechanical_rule_control(id, rule, cx),
                    cx,
                )
            })
            .collect::<Vec<_>>();
        let jev_summary = format!(
            "{} 个评分等级 · 候选至少 {} 字符 · 单次最多 {} 字符",
            strategy.jev.jev_score_levels.len(),
            strategy.jev.jev_candidate_min_chars,
            strategy.jev.jev_request_char_limit
        );

        v_flex()
            .flex_1()
            .min_w_0()
            .h_full()
            .bg(theme.background)
            .child(settings_page_header(
                "压缩策略",
                "配置机械裁剪、决策模型评分和 LLM 提示词；服务连接信息在“压缩服务”页面。",
                cx,
            ))
            .child(
                v_flex()
                    .id("settings-compression-strategy-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .px(SPACE_XXL)
                    .pb(SPACE_XXL)
                    .gap(SPACE_MD)
                    .child(
                        div()
                            .text_size(FONT_LABEL)
                            .font_semibold()
                            .text_color(theme.foreground)
                            .child("机械压缩规则"),
                    )
                    .child(Self::setting_row(
                        "保留模式",
                        "控制 Thinking、Input、Output、System 与工具结构的机械保留方式。",
                        settings_button(
                            Button::new("compression-retention-mode").label(retention_mode.label()),
                            cx,
                        )
                        .on_click(move |_, window, cx| {
                            let next = match retention_mode {
                                wake_core::services::compression_settings::MechanicalRetentionMode::FullMechanical => wake_core::services::compression_settings::MechanicalRetentionMode::BodyOnly,
                                wake_core::services::compression_settings::MechanicalRetentionMode::BodyOnly => wake_core::services::compression_settings::MechanicalRetentionMode::BodyWithStructure,
                                wake_core::services::compression_settings::MechanicalRetentionMode::BodyWithStructure => wake_core::services::compression_settings::MechanicalRetentionMode::FullMechanical,
                            };
                            retention_entity.update(cx, |this, cx| {
                                this.update_mechanical_compression_setting(
                                    serde_json::json!({ "retention_mode": next }),
                                    "保留模式已更新", window, cx,
                                );
                            });
                        }),
                        cx,
                    ))
                    .child(Self::setting_row(
                        "允许 Jev 删除 Agent 正文",
                        "默认关闭；开启后 Jev 可按整条消息删除 Agent 正文。",
                        h_flex().gap(SPACE_SM).items_center()
                            .child(Switch::new("compression-jev-delete-assistant-body").checked(allow_assistant_body_delete))
                            .child(settings_button(Button::new("compression-jev-delete-assistant-body-toggle").label(if allow_assistant_body_delete { "允许" } else { "禁止" }), cx)
                                .on_click(move |_, window, cx| assistant_delete_entity.update(cx, |this, cx| {
                                    this.update_mechanical_compression_setting(serde_json::json!({ "allow_jev_delete_assistant_body": !allow_assistant_body_delete }), "Jev 正文删除权限已更新", window, cx);
                                }))),
                        cx,
                    ))
                    .child(Self::setting_row(
                        "允许 Jev 删除用户消息",
                        "默认关闭；这是独立权限，不随 Agent 正文权限联动。",
                        h_flex().gap(SPACE_SM).items_center()
                            .child(Switch::new("compression-jev-delete-user-messages").checked(allow_user_message_delete))
                            .child(settings_button(Button::new("compression-jev-delete-user-messages-toggle").label(if allow_user_message_delete { "允许" } else { "禁止" }), cx)
                                .on_click(move |_, window, cx| user_delete_entity.update(cx, |this, cx| {
                                    this.update_mechanical_compression_setting(serde_json::json!({ "allow_jev_delete_user_messages": !allow_user_message_delete }), "Jev 用户消息删除权限已更新", window, cx);
                                }))),
                        cx,
                    ))
                    .child(Self::setting_row(
                        "恢复输出上限",
                        format!("expanded {} 字符 · evidence {} 字符", mechanical.expanded_max_chars, mechanical.evidence_max_chars),
                        settings_button(Button::new("compression-retention-limits").label("编辑"), cx)
                            .on_click(move |_, window, cx| limits_entity.update(cx, |this, cx| this.open_mechanical_retention_limits_form(window, cx))),
                        cx,
                    ))
                    .children(mechanical_elements)
                    .child(
                        div()
                            .pt(SPACE_SM)
                            .text_size(FONT_LABEL)
                            .font_semibold()
                            .text_color(theme.foreground)
                            .child("决策模型判断策略"),
                    )
                    .child(Self::setting_row(
                        "决策模型评分提示词",
                        jev_summary,
                        settings_button(Button::new("compression-jev-strategy-edit").label("编辑"), cx)
                            .on_click(move |_, window, cx| {
                                jev_entity.update(cx, |this, cx| {
                                    this.open_jev_strategy_form(window, cx);
                                });
                            }),
                        cx,
                    ))
                    .child(
                        div()
                            .pt(SPACE_SM)
                            .text_size(FONT_LABEL)
                            .font_semibold()
                            .text_color(theme.foreground)
                            .child("LLM 提示词"),
                    )
                    .child(Self::setting_row("单会话策略", "单个会话压缩使用的重点说明。", self.compression_strategy_control("compression-strategy-single", CompressionStrategyField::Single, cx), cx))
                    .child(Self::setting_row("生成记忆策略", "判断哪些信息值得成为记忆候选；不定义 JSON 输出格式。", self.compression_strategy_control("compression-strategy-memory-generation", CompressionStrategyField::MemoryGeneration, cx), cx))
                    .child(Self::setting_row("多会话策略", "多个关联会话压缩使用的重点说明。", self.compression_strategy_control("compression-strategy-multi", CompressionStrategyField::Multi, cx), cx))
                    .child(Self::setting_row("标签策略", "编辑通用标签策略和各标签专用策略。", self.compression_strategy_control("compression-strategy-tags", CompressionStrategyField::Tags, cx), cx))
                    .child(Self::setting_row("关系策略", "按会话关系调整压缩重点。", self.compression_strategy_control("compression-strategy-relations", CompressionStrategyField::Relations, cx), cx))
                    .child(Self::setting_row("System Message", "发送给 LLM 的 system message。", self.compression_strategy_control("compression-llm-system", CompressionStrategyField::LlmSystemMessage, cx), cx))
                    .child(Self::setting_row("Task 模板", "定义压缩任务和总体目标。", self.compression_strategy_control("compression-llm-task", CompressionStrategyField::LlmTaskTemplate, cx), cx))
                    .child(Self::setting_row("用户提示词外层模板", "组织策略、分块、Sources 和 Session Markdown；必须包含 {{strategy}} 与 {{markdown}}。", self.compression_strategy_control("compression-llm-user-template", CompressionStrategyField::LlmUserPromptTemplate, cx), cx))
                    .child(Self::setting_row("记忆候选输出契约", "唯一负责候选 JSON 的字段、取值和代码块格式。", self.compression_strategy_control("compression-llm-memory-contract", CompressionStrategyField::LlmMemoryCandidateContract, cx), cx))
                    .child(Self::setting_row(
                        "Temperature",
                        format!("当前 {:.2}；允许范围 0.0 到 2.0。", strategy.llm.llm_temperature),
                        settings_button(Button::new("compression-llm-temperature").label("编辑"), cx)
                            .on_click(move |_, window, cx| {
                                temperature_entity.update(cx, |this, cx| {
                                    this.open_llm_temperature_form(window, cx);
                                });
                            }),
                        cx,
                    )),
            )
            .into_any_element()
    }

    #[allow(dead_code)]
    fn render_compression_strategy_legacy(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let settings = self.workbench.read(cx).compression_settings();
        let jev = self.workbench.read(cx).jev_config();
        let llm_provider_status: SharedString = crate::tf!(
            "{} / {}",
            settings.llm_provider_index + 1,
            settings.llm_provider_name
        )
        .into();
        let llm_url_status: SharedString = if settings.llm_api_url.trim().is_empty() {
            "未配置".into()
        } else {
            settings.llm_api_url.clone().into()
        };
        let llm_key_status: SharedString = if settings.llm_api_key.trim().is_empty() {
            "未配置".into()
        } else {
            "已配置".into()
        };
        let model_status: SharedString = settings.llm_model.clone().into();
        let llm_timeout_status: SharedString = format!("{} 秒", settings.llm_timeout_secs).into();
        let llm_input_limit_status: SharedString =
            format!("{} 字符", settings.llm_input_limit_chars).into();
        let jev_url_status: SharedString = if jev.api_url.trim().is_empty() {
            "未配置".into()
        } else {
            jev.api_url.clone().into()
        };
        let jev_key_status: SharedString = if jev.api_key.trim().is_empty() {
            "未配置".into()
        } else {
            "已配置".into()
        };
        let jev_timeout_status: SharedString = format!("{} 秒", jev.timeout_secs).into();
        let toggle_entity = self.workbench.clone();
        let llm_toggle_entity = self.workbench.clone();
        let provider_entity = self.workbench.clone();
        v_flex()
            .flex_1()
            .min_w_0()
            .h_full()
            .bg(theme.background)
            .child(settings_page_header(
                "压缩策略",
                "配置 LLM、Jev 辅助评分，以及按标签/关系分类的压缩说明。",
                cx,
            ))
            .child(
                v_flex()
                    .id("settings-compression-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .px(SPACE_XXL)
                    .pb(SPACE_XXL)
                    .gap(SPACE_MD)
                    .child(Self::setting_row(
                        "LLM 生成",
                        "关闭后只执行基础机械压缩，不调用 LLM。",
                        h_flex()
                            .gap(SPACE_SM)
                            .items_center()
                            .child(
                                Switch::new("compression-llm-enabled")
                                    .checked(settings.llm_enabled),
                            )
                            .child(
                                settings_button(
                                    Button::new("compression-llm-toggle").label(
                                        if settings.llm_enabled {
                                            "关闭"
                                        } else {
                                            "启用"
                                        },
                                    ),
                                    cx,
                                )
                                .on_click(move |_, window, cx| {
                                    llm_toggle_entity.update(cx, |this, cx| {
                                        this.toggle_compression_llm(window, cx);
                                    });
                                }),
                            ),
                        cx,
                    ))
                    .child(Self::setting_row(
                        "LLM Provider",
                        "可配置 3 个提供商；压缩时使用当前选中的这一组 URL、Key、Model。",
                        h_flex()
                            .gap(SPACE_SM)
                            .items_center()
                            .child(
                                div()
                                    .max_w(px(220.))
                                    .truncate()
                                    .text_size(FONT_CAPTION)
                                    .text_color(theme.muted_foreground)
                                    .child(llm_provider_status),
                            )
                            .child(
                                settings_button(Button::new("compression-llm-provider-next").label("切换"), cx)
                                    .on_click(move |_, window, cx| {
                                        provider_entity.update(cx, |this, cx| {
                                            this.select_next_llm_provider(window, cx);
                                        });
                                    }),
                            ),
                        cx,
                    ))
                    .child(Self::setting_row(
                        "Provider 名称",
                        "当前 LLM Provider 的显示名称。",
                        self.compression_config_control(
                            "compression-llm-provider-name",
                            CompressionConfigField::LlmProviderName,
                            settings.llm_provider_name.clone().into(),
                            cx,
                        ),
                        cx,
                    ))
                    .child(Self::setting_row(
                        "LLM API URL",
                        "当前 Provider 的 OpenAI-compatible API 基址，程序会自动补 /v1/chat/completions。",
                        self.compression_config_control(
                            "compression-llm-url",
                            CompressionConfigField::LlmApiUrl,
                            llm_url_status,
                            cx,
                        ),
                        cx,
                    ))
                    .child(Self::setting_row(
                        "LLM API Key",
                        "本地保存，不在界面明文展示。",
                        self.compression_config_control(
                            "compression-llm-key",
                            CompressionConfigField::LlmApiKey,
                            llm_key_status,
                            cx,
                        ),
                        cx,
                    ))
                    .child(Self::setting_row(
                        "LLM Model",
                        "用于生成压缩文档的模型名称。",
                        self.compression_config_control(
                            "compression-llm-model",
                            CompressionConfigField::LlmModel,
                            model_status,
                            cx,
                        ),
                        cx,
                    ))
                    .child(Self::setting_row(
                        "LLM Timeout",
                        "LLM 压缩生成的请求超时时间，长对话建议 600 秒或更高。",
                        self.compression_config_control(
                            "compression-llm-timeout",
                            CompressionConfigField::LlmTimeoutSecs,
                            llm_timeout_status,
                            cx,
                        ),
                        cx,
                    ))
                    .child(Self::setting_row(
                        "LLM 输入上限",
                        "送入 LLM 的最大字符数，不是 token；默认 1,000,000，超长会更慢且更耗 token。",
                        self.compression_config_control(
                            "compression-llm-input-limit",
                            CompressionConfigField::LlmInputLimitChars,
                            llm_input_limit_status,
                            cx,
                        ),
                        cx,
                    ))
                    .child(Self::setting_row(
                        "Jev 辅助评分",
                        "启用后先尝试用 Jev 评分/摘取，再交给 LLM；失败时不阻断 LLM 压缩。",
                        h_flex()
                            .gap(SPACE_SM)
                            .items_center()
                            .child(
                                Switch::new("compression-jev-enabled")
                                    .checked(settings.jev_enabled),
                            )
                            .child(
                                settings_button(
                                    Button::new("compression-jev-toggle").label(
                                        if settings.jev_enabled {
                                            "关闭"
                                        } else {
                                            "启用"
                                        },
                                    ),
                                    cx,
                                )
                                .on_click(move |_, window, cx| {
                                    toggle_entity.update(cx, |this, cx| {
                                        this.toggle_compression_jev(window, cx);
                                    });
                                }),
                            ),
                        cx,
                    ))
                    .child(Self::setting_row(
                        "Jev API URL",
                        "Jev 服务地址；可与 LLM 组合使用。",
                        self.jev_config_control(
                            "compression-jev-url",
                            JevConfigField::JevApiUrl,
                            jev_url_status,
                            cx,
                        ),
                        cx,
                    ))
                    .child(Self::setting_row(
                        "Jev API Key",
                        "本地保存，不在界面明文展示。",
                        self.jev_config_control(
                            "compression-jev-key",
                            JevConfigField::JevApiKey,
                            jev_key_status,
                            cx,
                        ),
                        cx,
                    ))
                    .child(Self::setting_row(
                        "Jev Timeout",
                        "Jev 请求超时时间，单位秒。",
                        self.jev_config_control(
                            "compression-jev-timeout",
                            JevConfigField::TimeoutSecs,
                            jev_timeout_status,
                            cx,
                        ),
                        cx,
                    ))
                    .child(Self::setting_row(
                        "单会话策略",
                        "右上角压缩导出使用的基础说明。",
                        self.compression_strategy_control(
                            "compression-strategy-single",
                            CompressionStrategyField::Single,
                            cx,
                        ),
                        cx,
                    ))
                    .child(Self::setting_row(
                        "压缩并生成记忆提示词",
                        "新增入口使用的独立提示词；普通压缩导出不受影响。",
                        self.compression_strategy_control(
                            "compression-strategy-memory-generation",
                            CompressionStrategyField::MemoryGeneration,
                            cx,
                        ),
                        cx,
                    ))
                    .child(Self::setting_row(
                        "多会话策略",
                        "关系树压缩导出使用的基础说明。",
                        self.compression_strategy_control(
                            "compression-strategy-multi",
                            CompressionStrategyField::Multi,
                            cx,
                        ),
                        cx,
                    ))
                    .child(Self::setting_row(
                        "标签策略",
                        "点击后编辑通用标签策略和各标签专用策略。",
                        self.compression_strategy_control(
                            "compression-strategy-tags",
                            CompressionStrategyField::Tags,
                            cx,
                        ),
                        cx,
                    ))
                    .child(Self::setting_row(
                        "关系策略",
                        "按起点、继续、分支、阻塞、解决、相关调整压缩重点。",
                        self.compression_strategy_control(
                            "compression-strategy-relations",
                            CompressionStrategyField::Relations,
                            cx,
                        ),
                        cx,
                    )),
            )
            .into_any_element()
    }

    fn appearance_button(
        &self,
        id: &'static str,
        label: &'static str,
        preference: AppearancePreference,
        cx: &Context<Self>,
    ) -> Button {
        let theme = cx.theme();
        let selected = self.appearance == preference;
        Button::new(id)
            .custom(
                ButtonCustomVariant::new(cx)
                    .color(theme.transparent)
                    .foreground(if selected {
                        theme.foreground
                    } else {
                        theme.muted_foreground
                    })
                    .hover(theme.secondary_hover)
                    .active(theme.popover),
            )
            .small()
            .w(px(64.))
            .rounded(RADIUS_BUTTON)
            .label(label)
            .selected(selected)
            .when(selected, |this| this.shadow_xs())
            .on_click(cx.listener(move |this, _, window, cx| {
                match theme::set_appearance(preference, Some(window), cx) {
                    Ok(()) => {
                        this.appearance = preference;
                        cx.notify();
                    }
                    Err(error) => window.push_notification(
                        gpui_component::notification::Notification::error(crate::tf!(
                            "Couldn't save appearance: {}",
                            error
                        )),
                        cx,
                    ),
                }
            }))
    }

    fn render_general(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        v_flex()
            .flex_1()
            .min_w_0()
            .h_full()
            .bg(theme.background)
            .child(
                v_flex()
                    .flex_shrink_0()
                    .px(SPACE_XXL)
                    .pt(SETTINGS_PAGE_TOP)
                    .pb(SPACE_XL)
                    .gap(px(5.))
                    .child(
                        div()
                            .text_size(FONT_TITLE)
                            .font_semibold()
                            .text_color(theme.foreground)
                            .child(t("General")),
                    )
                    .child(
                        div()
                            .text_size(FONT_CAPTION)
                            .text_color(theme.muted_foreground)
                            .child(t("Customize how ContextOS looks and reads.")),
                    ),
            )
            .child(
                v_flex()
                    .px(SPACE_XXL)
                    .gap(SPACE_MD)
                    .child(Self::setting_row(
                        t("Appearance"),
                        t("Follow the system or keep ContextOS light or dark."),
                        h_flex()
                            .h(BUTTON_SM_H + px(4.))
                            .p(px(2.))
                            .rounded(theme.radius)
                            .border_1()
                            .border_color(theme.border)
                            .bg(theme.secondary)
                            .child(self.appearance_button(
                                "appearance-system",
                                t("System"),
                                AppearancePreference::System,
                                cx,
                            ))
                            .child(self.appearance_button(
                                "appearance-light",
                                t("Light"),
                                AppearancePreference::Light,
                                cx,
                            ))
                            .child(self.appearance_button(
                                "appearance-dark",
                                t("Dark"),
                                AppearancePreference::Dark,
                                cx,
                            )),
                        cx,
                    ))
                    .child(Self::setting_row(
                        t("Language"),
                        t("Follow the system language, or pick one."),
                        self.language_control(),
                        cx,
                    )),
            )
            .into_any_element()
    }

    fn render_data(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let snapshot = self.workbench.read(cx).data_settings_snapshot();
        let stats = self.storage_stats.clone();
        let storage_summary = stats
            .as_ref()
            .map(|stats| format!("总占用 {}", format_storage_size(stats.total_bytes)))
            .unwrap_or_else(|| {
                if self.storage_loading {
                    "正在统计空间占用…".to_string()
                } else {
                    "空间统计尚未加载".to_string()
                }
            });
        let pending = self.storage_pending.clone();
        let error = self.storage_error.clone();
        let loading = self.storage_loading;
        let root_path = stats
            .as_ref()
            .map(|stats| stats.root.clone())
            .unwrap_or_else(wake_core::storage::root);
        let root_text = root_path.to_string_lossy().to_string();
        let reveal_root = root_path.to_string_lossy().to_string();
        let show_root = settings_button(
            Button::new("settings-show-data")
                .icon(icon("icons/folder.svg").with_size(px(13.)))
                .label(show_in_fm()),
            cx,
        )
        .on_click(move |_, _, _| wake_core::services::terminal::open_in_file_manager(&reveal_root));
        let view = cx.entity();
        let choose_root = settings_button(
            Button::new("settings-change-data-root")
                .icon(icon("icons/folder.svg").with_size(px(13.)))
                .label("选择总目录"),
            cx,
        )
        .on_click(move |_, _, cx| {
            let rx = cx.prompt_for_paths(PathPromptOptions {
                files: false,
                directories: true,
                multiple: false,
                prompt: Some("选择 ContextOS 数据总目录".into()),
            });
            let view = view.clone();
            cx.spawn(async move |cx| {
                let selected = match rx.await {
                    Ok(Ok(Some(paths))) => paths.into_iter().next(),
                    _ => None,
                };
                let Some(path) = selected else { return };
                let result = cx
                    .background_executor()
                    .spawn(async move { wake_core::storage::set_pending_root(&path) })
                    .await;
                view.update(cx, |this, cx| {
                    match result {
                        Ok(()) => {
                            this.storage_pending = wake_core::storage::pending_root();
                            this.storage_error = None;
                        }
                        Err(error) => this.storage_error = Some(format!("{error:#}")),
                    }
                    cx.notify();
                });
            })
            .detach();
        });
        let storage_rows = if let Some(stats) = stats {
            let snapshots_label = format!("快照文件 · {} 个", stats.cas_files);
            let mut rows = vec![
                self.storage_row(
                    "contextos-index-db",
                    "索引数据库",
                    &stats.index_db,
                    stats.index_bytes,
                    cx,
                ),
                self.storage_row(
                    "contextos-workspace-db",
                    "工作区数据库",
                    &stats.workspace_db,
                    stats.workspace_bytes,
                    cx,
                ),
                self.storage_row(
                    "contextos-snapshots",
                    snapshots_label,
                    &stats.cas_dir,
                    stats.cas_bytes,
                    cx,
                ),
            ];
            if stats.index_backup_bytes > 0 {
                rows.insert(
                    1,
                    self.storage_row(
                        "contextos-index-backup",
                        "损坏索引备份",
                        &stats.index_backup,
                        stats.index_backup_bytes,
                        cx,
                    ),
                );
            }
            rows
        } else {
            vec![div()
                .text_size(FONT_CAPTION)
                .text_color(theme.muted_foreground)
                .child(if loading {
                    "正在统计空间占用…"
                } else {
                    "空间统计尚未加载"
                })
                .into_any_element()]
        };
        let pending_note = pending.map(|path| {
            div()
                .text_size(FONT_CAPTION)
                .text_color(theme.primary)
                .child(format!("重启 ContextOS 后迁移到：{}", path.display()))
                .into_any_element()
        });
        let error_note = error.map(|error| {
            div()
                .text_size(FONT_CAPTION)
                .text_color(theme.danger)
                .child(error)
                .into_any_element()
        });
        let refresh = settings_button(
            Button::new("settings-refresh-storage-stats")
                .icon(icon("icons/refresh-cw.svg").with_size(px(13.)))
                .label("刷新统计"),
            cx,
        )
        .on_click(cx.listener(|this, _, _, cx| this.refresh_storage_stats(cx)));

        v_flex()
            .flex_1()
            .min_w_0()
            .h_full()
            .bg(theme.background)
            .child(settings_page_header(
                t("Data"),
                t("查看 ContextOS 数据位置与空间占用。"),
                cx,
            ))
            .child(
                v_flex()
                    .px(SPACE_XXL)
                    .gap(SPACE_SM)
                    .child(
                        h_flex()
                            .items_center()
                            .gap(SPACE_SM)
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .truncate()
                                    .text_size(FONT_CAPTION)
                                    .text_color(theme.muted_foreground)
                                    .child(root_text),
                            )
                            .child(self.copy_button(
                                "settings-data-root-copy".into(),
                                "复制路径",
                                root_path.to_string_lossy().to_string(),
                                cx,
                            ))
                            .child(show_root)
                            .child(choose_root),
                    )
                    .children(pending_note)
                    .children(error_note)
                    .child(
                        div()
                            .text_size(FONT_CAPTION)
                            .font_semibold()
                            .text_color(theme.foreground)
                            .child(t("Storage")),
                    )
                    .child(settings_info_card(
                        t("存储空间"),
                        storage_rows,
                        refresh.into_any_element(),
                        px(72.),
                        cx,
                    ))
                    .child(
                        div()
                            .text_size(FONT_CAPTION)
                            .text_color(theme.foreground)
                            .child(format!(
                                "{} · 已索引会话 {} 条",
                                storage_summary,
                                crate::workbench::session_tally(snapshot.session_count)
                            )),
                    ),
            )
            .into_any_element()
    }

    fn storage_row(
        &self,
        id: &'static str,
        label: impl Into<SharedString>,
        path: &std::path::Path,
        bytes: u64,
        cx: &Context<Self>,
    ) -> AnyElement {
        let raw = path.to_string_lossy().to_string();
        let display = raw.clone();
        let label: SharedString = label.into();
        h_flex()
            .w_full()
            .min_w_0()
            .gap(SPACE_SM)
            .items_center()
            .child(
                div()
                    .w(px(128.))
                    .flex_shrink_0()
                    .text_size(FONT_CAPTION)
                    .text_color(cx.theme().foreground)
                    .child(label),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_size(FONT_CAPTION)
                    .text_color(cx.theme().muted_foreground)
                    .font_family(cx.theme().mono_font_family.clone())
                    .child(display.clone()),
            )
            .child(
                div()
                    .w(px(96.))
                    .flex_shrink_0()
                    .text_right()
                    .text_size(FONT_CAPTION)
                    .child(format_storage_size(bytes)),
            )
            .child(self.copy_button(format!("{id}-copy").into(), "复制", display, cx))
            .child(
                settings_button(
                    Button::new(format!("{id}-reveal"))
                        .icon(icon("icons/folder.svg").with_size(px(13.)))
                        .label(show_in_fm()),
                    cx,
                )
                .on_click(move |_, _, _| wake_core::services::terminal::open_in_file_manager(&raw)),
            )
            .into_any_element()
    }

    fn refresh_storage_stats(&mut self, cx: &mut Context<Self>) {
        self.storage_loading = true;
        let task = cx.background_spawn(async { wake_core::storage::stats() });
        cx.spawn(async move |this, cx| {
            let stats = task.await;
            this.update(cx, |this, cx| {
                this.storage_stats = Some(stats);
                this.storage_loading = false;
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn render_retention(&self, cx: &Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let labels = [t("Claude Code"), t("Gemini CLI")];
        let mut cards = Vec::new();
        for (ix, snapshot) in self.retention.iter().enumerate() {
            let title = labels[ix];
            let path: SharedString = snapshot.path.to_string_lossy().to_string().into();
            let status = if let Some(error) = &snapshot.error {
                crate::tf!("Configuration status: {}", error)
            } else if snapshot.is_default {
                t("Using the default retention period").to_string()
            } else {
                t("Custom retention period").to_string()
            };
            let value_label = if ix == 0 { t("Days") } else { t("Duration") };
            let error = self.retention_errors[ix].as_ref().map(|message| {
                div()
                    .text_size(FONT_CAPTION)
                    .text_color(theme.danger)
                    .child(message.clone())
                    .into_any_element()
            });
            let input = Input::new(&self.retention_inputs[ix]);
            let save = settings_button(
                Button::new(SharedString::from(format!("retention-save-{ix}"))).label(t("Save")),
                cx,
            )
            .on_click(cx.listener(move |this, _, _, cx| this.save_retention(ix, cx)));
            let mut details = vec![
                div()
                    .w_full()
                    .truncate()
                    .text_size(FONT_CAPTION)
                    .text_color(theme.muted_foreground)
                    .child(path)
                    .into_any_element(),
                div()
                    .text_size(FONT_CAPTION)
                    .text_color(theme.muted_foreground)
                    .child(status)
                    .into_any_element(),
                h_flex()
                    .items_center()
                    .gap(SPACE_SM)
                    .child(div().w(px(90.)).text_size(FONT_CAPTION).child(value_label))
                    .child(div().w(px(180.)).child(input))
                    .into_any_element(),
            ];
            if let Some(error) = error {
                details.push(error);
            }
            cards.push(settings_info_card(
                div().child(title),
                details,
                save.into_any_element(),
                px(116.),
                cx,
            ));
        }
        let compression = self.codex_compression.as_ref();
        let compression_enabled = compression.is_some_and(|snapshot| snapshot.enabled);
        let compression_path: SharedString = compression
            .map(|snapshot| snapshot.path.to_string_lossy().to_string())
            .unwrap_or_default()
            .into();
        let mut compression_details = vec![
            div()
                .w_full()
                .truncate()
                .text_size(FONT_CAPTION)
                .text_color(theme.muted_foreground)
                .child(compression_path)
                .into_any_element(),
            div()
                .text_size(FONT_CAPTION)
                .text_color(theme.muted_foreground)
                .child(t("Restart Codex to apply this setting. Codex controls when inactive sessions are compressed."))
                .into_any_element(),
        ];
        if let Some(error) = compression.and_then(|snapshot| snapshot.error.as_ref()) {
            compression_details.push(
                div()
                    .text_size(FONT_CAPTION)
                    .text_color(theme.danger)
                    .child(error.clone())
                    .into_any_element(),
            );
        }
        let compression_toggle = Switch::new("retention-codex-compression")
            .checked(compression_enabled)
            .tooltip(if compression_enabled {
                t("Disable Codex session compression")
            } else {
                t("Enable Codex session compression")
            })
            .on_click(cx.listener(|this, _, _, cx| this.toggle_codex_compression(cx)));
        cards.push(settings_info_card(
            div().child(t("Codex session compression")),
            compression_details,
            compression_toggle.into_any_element(),
            px(116.),
            cx,
        ));
        v_flex()
            .flex_1()
            .min_w_0()
            .h_full()
            .bg(theme.background)
            .child(settings_page_header(
                t("Session retention"),
                t("Configure transcript retention and Codex session compression."),
                cx,
            ))
            .child(
                v_flex()
                    .id("settings-retention-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .px(SPACE_XXL)
                    .pb(SPACE_XXL)
                    .gap(SPACE_MD)
                    .children(cards),
            )
            .into_any_element()
    }

    /// Settings → Connect 的复制按钮:写剪贴板,按钮原地变 "Copied" 片刻后复原
    fn copy_button(
        &self,
        id: SharedString,
        label: &'static str,
        text: String,
        cx: &Context<Self>,
    ) -> Button {
        let copied = self.copied.as_ref() == Some(&id);
        let clicked_id = id.clone();
        settings_button(
            Button::new(id)
                .icon(
                    icon(if copied {
                        "icons/check.svg"
                    } else {
                        "icons/copy.svg"
                    })
                    .with_size(px(13.)),
                )
                .label(if copied { t("Copied") } else { label }),
            cx,
        )
        .on_click(cx.listener(move |this, _, _, cx| {
            cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
            this.show_copied(clicked_id.clone(), cx);
        }))
    }

    fn show_copied(&mut self, id: SharedString, cx: &mut Context<Self>) {
        self.copied_generation = self.copied_generation.wrapping_add(1);
        let generation = self.copied_generation;
        self.copied = Some(id);
        cx.notify();
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(1_600))
                .await;
            this.update(cx, |this, cx| {
                if this.copied_generation == generation {
                    this.copied = None;
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    /// Settings → Connect:把 ContextOS 的索引以 MCP 只读暴露给 coding agent。页面只放
    /// **状态与动作**:server 卡(路径 + Copy path)、Agents 卡(每家一行一个
    /// Copy 钮)、命令行与 skill 导出。代码块与工具表都不放——那是
    /// README 的内容,塞进设置窗怎么排都像教程(用户 2026-09-08 三轮定稿)。
    /// 只展示与复制,不代写别家配置;片段与 `contextos-mcp setup` 同源(wake-core mcp)
    fn render_connect(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let dark = theme.mode.is_dark();
        let info = &self.connect;
        let mono = theme.mono_font_family.clone();
        let count = info.snippets.len();

        let agent_rows: Vec<AnyElement> = info
            .snippets
            .iter()
            .enumerate()
            .map(|(ix, s)| {
                let shown = self.connect_shown.contains(&ix);
                let copy = self.copy_button(
                    format!("connect-copy-{ix}").into(),
                    t(s.copy_label),
                    s.text.clone(),
                    cx,
                );
                // 低强调的展开切换:片段默认收起,想核对再看
                let toggle = Button::new(SharedString::from(format!("connect-show-{ix}")))
                    .custom(
                        ButtonCustomVariant::new(cx)
                            .color(theme.transparent)
                            .foreground(theme.muted_foreground)
                            .hover(theme.secondary_hover)
                            .active(theme.popover),
                    )
                    .small()
                    .rounded(RADIUS_BUTTON)
                    .icon(
                        icon(if shown {
                            "icons/chevron-down.svg"
                        } else {
                            "icons/chevron-right.svg"
                        })
                        .with_size(px(13.)),
                    )
                    .label(if shown { t("Hide") } else { t("Show") })
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if !this.connect_shown.remove(&ix) {
                            this.connect_shown.insert(ix);
                        }
                        cx.notify();
                    }));
                v_flex()
                    .w_full()
                    .when(ix + 1 < count, |this| {
                        this.border_b_1().border_color(theme.border)
                    })
                    .child(
                        h_flex()
                            .w_full()
                            .min_h(px(52.))
                            .px(SPACE_LG)
                            .py(SPACE_SM)
                            .gap(ICON_TEXT_GAP)
                            .items_center()
                            .child(img(s.agent.brand_icon(dark)).size(px(17.)).flex_shrink_0())
                            .child(
                                v_flex()
                                    .flex_1()
                                    .min_w_0()
                                    .gap(px(2.))
                                    .child(
                                        div()
                                            .text_size(FONT_BODY)
                                            .text_color(theme.foreground)
                                            .child(s.client),
                                    )
                                    .child(
                                        div()
                                            .text_size(FONT_CAPTION)
                                            .text_color(theme.muted_foreground)
                                            .child(t(s.hint)),
                                    ),
                            )
                            .child(toggle)
                            .child(copy),
                    )
                    .when(shown, |this| {
                        // 默认收起,所以行元素只在展开时才建
                        let lines = s
                            .text
                            .lines()
                            .map(|l| div().child(l.to_string()).into_any_element());
                        this.child(
                            // 左缘对齐到文字轴:行内边距 + 图标 17 + 间距 12
                            v_flex()
                                .ml(SPACE_LG + px(17.) + SPACE_MD)
                                .mr(SPACE_LG)
                                .mb(SPACE_MD)
                                .px(SPACE_MD)
                                .py(SPACE_SM)
                                .rounded(theme.radius)
                                .bg(theme.secondary)
                                .font_family(mono.clone())
                                .text_size(FONT_CAPTION)
                                .text_color(theme.foreground)
                                .children(lines),
                        )
                    })
                    .into_any_element()
            })
            .collect();

        let hook_rows: Vec<AnyElement> =
            info.session_hooks
                .iter()
                .enumerate()
                .map(|(ix, hook)| {
                    let key = count + ix;
                    let shown = self.connect_shown.contains(&key);
                    let toggle = Button::new(SharedString::from(format!("connect-show-hook-{ix}")))
                        .custom(
                            ButtonCustomVariant::new(cx)
                                .color(theme.transparent)
                                .foreground(theme.muted_foreground)
                                .hover(theme.secondary_hover)
                                .active(theme.popover),
                        )
                        .small()
                        .rounded(RADIUS_BUTTON)
                        .icon(
                            icon(if shown {
                                "icons/chevron-down.svg"
                            } else {
                                "icons/chevron-right.svg"
                            })
                            .with_size(px(13.)),
                        )
                        .label(if shown { t("Hide") } else { t("Show") })
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if !this.connect_shown.remove(&key) {
                                this.connect_shown.insert(key);
                            }
                            cx.notify();
                        }));
                    let copy = self.copy_button(
                        format!("connect-copy-hook-{ix}").into(),
                        t(hook.copy_label),
                        hook.text.clone(),
                        cx,
                    );
                    let mut row = v_flex().w_full().flex_shrink_0().child(
                        h_flex()
                            .w_full()
                            .min_h(px(52.))
                            .px(SPACE_LG)
                            .py(SPACE_SM)
                            .gap(ICON_TEXT_GAP)
                            .items_center()
                            .child(
                                img(hook.agent.brand_icon(dark))
                                    .size(px(17.))
                                    .flex_shrink_0(),
                            )
                            .child(
                                v_flex()
                                    .flex_1()
                                    .min_w_0()
                                    .gap(px(2.))
                                    .child(
                                        div()
                                            .text_size(FONT_BODY)
                                            .text_color(theme.foreground)
                                            .child(t(hook.client)),
                                    )
                                    .child(
                                        div()
                                            .text_size(FONT_CAPTION)
                                            .text_color(theme.muted_foreground)
                                            .child(t(hook.hint)),
                                    ),
                            )
                            .child(toggle)
                            .child(copy),
                    );
                    if shown {
                        row =
                            row.child(
                                v_flex()
                                    .ml(SPACE_LG + px(17.) + SPACE_MD)
                                    .mr(SPACE_LG)
                                    .mb(SPACE_MD)
                                    .px(SPACE_MD)
                                    .py(SPACE_SM)
                                    .rounded(theme.radius)
                                    .bg(theme.secondary)
                                    .font_family(mono.clone())
                                    .text_size(FONT_CAPTION)
                                    .text_color(theme.foreground)
                                    .children(hook.text.lines().map(|line| {
                                        div().child(line.to_string()).into_any_element()
                                    })),
                            );
                    }
                    row.into_any_element()
                })
                .collect();

        // 信息卡里那条 mono 副信息;exists=false 再补一句红字
        let mono_details = |display: SharedString, exists: bool| {
            let mut out = vec![div()
                .w_full()
                .truncate()
                .text_size(FONT_CAPTION)
                .font_family(mono.clone())
                .text_color(theme.muted_foreground)
                .child(display)
                .into_any_element()];
            if !exists {
                out.push(
                    div()
                        .text_size(FONT_CAPTION)
                        .text_color(theme.danger)
                        .child(t(
                            "Not found next to the ContextOS app — reinstall ContextOS",
                        ))
                        .into_any_element(),
                );
            }
            out
        };
        // 设置页展示并复制发布的 ContextOS 二进制路径。
        let binary_card = |primary: &'static str,
                           id: &'static str,
                           f: &BinaryFacts,
                           extra: Option<AnyElement>| {
            settings_info_card(
                primary,
                mono_details(f.display.clone(), f.exists),
                // Copy path 恒在最右,两张卡的同名动作才对得齐;附加动作放它左边
                h_flex()
                    .flex_shrink_0()
                    .gap(SPACE_SM)
                    .items_center()
                    .children(extra)
                    .child(self.copy_button(id.into(), t("Copy path"), f.path.clone(), cx))
                    .into_any_element(),
                px(84.),
                cx,
            )
        };
        let copy_cli_command = info.cli_path_command.clone().map(|cmd| {
            self.copy_button(
                "connect-copy-cli-command".into(),
                t("Copy command"),
                cmd,
                cx,
            )
            .into_any_element()
        });
        let skill_entity = self.workbench.clone();
        let skill_card = settings_info_card(
            t("ContextOS skill"),
            vec![
                div()
                    .w_full()
                    .truncate()
                    .text_size(FONT_CAPTION)
                    .font_family(mono.clone())
                    .text_color(theme.muted_foreground)
                    .child("contextos-skill.zip")
                    .into_any_element(),
                div()
                    .text_size(FONT_CAPTION)
                    .text_color(theme.muted_foreground)
                    .child("导出后可手动安装到支持 skill 的 agent。")
                    .into_any_element(),
            ],
            settings_button(Button::new("connect-export-skill").label("导出 ZIP"), cx)
                .on_click(move |_, window, cx| {
                    skill_entity.update(cx, |this, cx| {
                        this.export_contextos_skill_package(window, cx);
                    });
                })
                .into_any_element(),
            px(84.),
            cx,
        );

        let section = |label: &'static str| {
            div()
                .flex_shrink_0()
                .text_size(FONT_CAPTION)
                .font_semibold()
                .text_color(theme.foreground)
                .child(label)
        };
        let titled = |label: &'static str| {
            h_flex()
                .flex_shrink_0()
                .gap(SPACE_SM)
                .items_center()
                .child(section(label).flex_1())
        };

        v_flex()
            .flex_1()
            .min_w_0()
            .h_full()
            .bg(theme.background)
            .child(settings_page_header(
                t("Connect"),
                t("Let your coding agents look up your past sessions from ContextOS."),
                cx,
            ))
            .child(
                v_flex()
                    .id("settings-connect-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .px(SPACE_XXL)
                    .pb(SPACE_XXL)
                    .gap(SPACE_SM)
                    .child(titled(t("Session start")).pt(SPACE_LG))
                    .child(
                        v_flex()
                            .w_full()
                            .flex_shrink_0()
                            .overflow_hidden()
                            .rounded(theme.radius_lg)
                            .border_1()
                            .border_color(theme.border)
                            .bg(theme.popover)
                            .children(hook_rows),
                    )
                    .child(titled(t("MCP server")))
                    .child(binary_card(
                        "ContextOS MCP",
                        "connect-copy-path",
                        &info.mcp,
                        None,
                    ))
                    .child(titled(t("MCP clients")).pt(SPACE_LG))
                    .child(
                        v_flex()
                            .w_full()
                            .flex_shrink_0()
                            .overflow_hidden()
                            .rounded(theme.radius_lg)
                            .border_1()
                            .border_color(theme.border)
                            .bg(theme.popover)
                            .children(agent_rows),
                    )
                    .child(titled(t("Command line")).pt(SPACE_LG))
                    .child(binary_card(
                        "ContextOS CLI",
                        "connect-copy-cli-path",
                        &info.cli,
                        copy_cli_command,
                    ))
                    .child(titled(t("Skill")).pt(SPACE_LG))
                    .child(skill_card),
            )
            .into_any_element()
    }

    fn about_link(
        &self,
        id: &'static str,
        label: &'static str,
        url: &'static str,
        cx: &Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme();
        div()
            .id(id)
            .cursor_pointer()
            .text_size(FONT_LABEL)
            .font_family(theme.mono_font_family.clone())
            .text_color(theme.foreground)
            .hover(|style| style.text_decoration_1())
            .on_click(move |_, _, cx| cx.open_url(url))
            .child(label)
            .into_any_element()
    }

    /// 与 Kooky / Birth 的 About 面板使用同一信息层级，但落在 ContextOS 已有的
    /// Settings 场景内：产品图标、名称、版本、tagline、仓库和作者署名。
    fn render_about(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let faint = theme.muted_foreground.opacity(0.72);
        let version: SharedString = crate::tf!("Version {}", env!("CARGO_PKG_VERSION")).into();

        v_flex()
            .flex_1()
            .min_w_0()
            .h_full()
            .items_center()
            .bg(theme.background)
            .child(
                v_flex()
                    .w(px(360.))
                    .items_center()
                    .pt(px(52.))
                    .child(
                        img("brands/wake.svg")
                            .size(px(78.))
                            .flex_shrink_0()
                            .mb(SPACE_MD),
                    )
                    .child(
                        div()
                            .text_size(FONT_DISPLAY)
                            .font_medium()
                            .text_color(theme.foreground)
                            .child("ContextOS"),
                    )
                    .child(
                        div()
                            .mt(SPACE_XS)
                            .text_size(FONT_LABEL)
                            .font_family(theme.mono_font_family.clone())
                            .text_color(theme.muted_foreground)
                            .child(version),
                    )
                    .child(
                        div()
                            .mt(SPACE_MD)
                            .text_size(FONT_CAPTION)
                            .text_color(theme.muted_foreground)
                            .child(t("All your AI agent sessions, in one place.")),
                    )
                    .child(div().mt(px(14.)).child(self.about_link(
                        "about-github",
                        "GitHub ↗",
                        "https://github.com/iAmCorey/Wake",
                        cx,
                    )))
                    .child(div().w(px(32.)).h(px(1.)).my(SPACE_LG).bg(theme.border))
                    .child(
                        div()
                            .text_size(FONT_LABEL)
                            .font_family(theme.mono_font_family.clone())
                            .text_color(faint)
                            .child(t("© 2026 Corey Chiu · MIT License")),
                    )
                    .child(
                        h_flex()
                            .mt(SPACE_XS)
                            .text_size(FONT_LABEL)
                            .font_family(theme.mono_font_family.clone())
                            .text_color(faint)
                            .child(t("Built with ❤️ by "))
                            .child(self.about_link(
                                "about-author",
                                "Corey Chiu",
                                "https://coreychiu.com?utm_source=wake",
                                cx,
                            )),
                    ),
            )
            .into_any_element()
    }

    fn render_updates(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let status = self.workbench.read(cx).update_status().clone();
        let checking = matches!(status, UpdateStatus::Checking);
        let update_available = matches!(status, UpdateStatus::Available { .. });
        let status_message: SharedString = match &status {
            UpdateStatus::Idle => t("Check GitHub Releases for a newer version.").into(),
            UpdateStatus::Checking => t("Checking GitHub Releases…").into(),
            UpdateStatus::UpToDate { latest } => {
                crate::tf!("No newer release is available (latest: {}).", latest).into()
            }
            UpdateStatus::Available { latest } => crate::tf!(
                "ContextOS {} is available. Open the release page to download it.",
                latest
            )
            .into(),
            UpdateStatus::Failed => {
                t("Couldn't check for updates. Check your connection and try again.").into()
            }
        };
        let button_label = match status {
            UpdateStatus::Idle => t("Check for Updates"),
            UpdateStatus::Checking => t("Checking…"),
            UpdateStatus::UpToDate { .. } => t("Check Again"),
            UpdateStatus::Available { .. } => t("View Update"),
            UpdateStatus::Failed => t("Try Again"),
        };
        let button = Button::new("settings-check-updates")
            .icon(icon(if update_available {
                "icons/download.svg"
            } else {
                "icons/refresh-cw.svg"
            }))
            .label(button_label)
            .disabled(checking);
        let mut action = if update_available {
            settings_primary_button(button, cx)
        } else {
            settings_button(button, cx)
        };
        if update_available {
            action = action.on_click(|_, _, cx| cx.open_url(update::LATEST_RELEASE_PAGE));
        } else {
            let workbench = self.workbench.clone();
            action = action.on_click(move |_, _, cx| {
                workbench.update(cx, |this, cx| this.check_for_updates(cx));
            });
        }

        v_flex()
            .flex_1()
            .min_w_0()
            .h_full()
            .bg(theme.background)
            .child(
                v_flex()
                    .flex_shrink_0()
                    .px(SPACE_XXL)
                    .pt(SETTINGS_PAGE_TOP)
                    .pb(SPACE_XL)
                    .gap(px(5.))
                    .child(
                        div()
                            .text_size(FONT_TITLE)
                            .font_semibold()
                            .text_color(theme.foreground)
                            .child(t("Updates")),
                    )
                    .child(
                        div()
                            .text_size(FONT_CAPTION)
                            .text_color(theme.muted_foreground)
                            .child(t("Keep ContextOS up to date.")),
                    ),
            )
            .child(
                v_flex().px(SPACE_XXL).child(
                    h_flex()
                        .min_h(px(84.))
                        .w_full()
                        .px(SPACE_LG)
                        .gap(SPACE_LG)
                        .items_center()
                        .rounded(theme.radius_lg)
                        .border_1()
                        .border_color(theme.border)
                        .bg(theme.popover)
                        .child(
                            v_flex()
                                .flex_1()
                                .min_w_0()
                                .gap(px(3.))
                                .child(
                                    div()
                                        .text_size(FONT_BODY)
                                        .text_color(theme.foreground)
                                        .child(format!("ContextOS {}", env!("CARGO_PKG_VERSION"))),
                                )
                                .child(
                                    div()
                                        .text_size(FONT_CAPTION)
                                        .text_color(if matches!(status, UpdateStatus::Failed) {
                                            theme.danger
                                        } else {
                                            theme.muted_foreground
                                        })
                                        .child(status_message),
                                ),
                        )
                        .child(action),
                ),
            )
            .into_any_element()
    }

    /// 两页 location 面板的快照重读(见字段注释):只刷当前显示的那页——切页走 Workbench
    /// 的 select_settings_page、本身就 notify,目标页在那一次刷到;设置窗开着时主窗的每次
    /// notify(敲一个搜索字)都会到这里,两页都刷是白付两遍 SQL + stat
    fn refresh_snapshots(&mut self, workbench: &Workbench) {
        match workbench.settings_page() {
            SettingsPage::Locations => self.locations = workbench.location_settings_snapshot(),
            SettingsPage::MemoryLocations => {
                self.memory_locations = workbench.memory_location_settings_snapshot()
            }
            SettingsPage::Retention => {
                self.retention = workbench.retention_settings_snapshot();
                self.codex_compression = Some(workbench.codex_compression_snapshot());
            }
            _ => {}
        }
    }

    fn initialize_retention_inputs(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.retention_loaded {
            return;
        }
        self.retention = self.workbench.read(cx).retention_settings_snapshot();
        self.codex_compression = Some(self.workbench.read(cx).codex_compression_snapshot());
        for snapshot in &self.retention {
            let ix = retention_index(snapshot.agent);
            if let Some(value) = &snapshot.value {
                self.retention_inputs[ix]
                    .update(cx, |input, cx| input.set_value(value.clone(), window, cx));
            }
        }
        self.retention_loaded = true;
    }

    fn save_retention(&mut self, ix: usize, cx: &mut Context<Self>) {
        let agent = if ix == 0 {
            wake_core::services::session_retention::RetentionAgent::ClaudeCode
        } else {
            wake_core::services::session_retention::RetentionAgent::Gemini
        };
        let value = self.retention_inputs[ix].read(cx).value().to_string();
        match self.workbench.read(cx).save_retention_period(agent, &value) {
            Ok(rows) => {
                self.retention = rows;
                self.retention_errors[ix] = None;
            }
            Err(error) => self.retention_errors[ix] = Some(error),
        }
        cx.notify();
    }

    fn toggle_codex_compression(&mut self, cx: &mut Context<Self>) {
        let enabled = !self
            .codex_compression
            .as_ref()
            .is_some_and(|snapshot| snapshot.enabled);
        self.codex_compression = Some(
            self.workbench
                .read(cx)
                .set_codex_compression_enabled(enabled),
        );
        cx.notify();
    }

    /// Session locations 的一行:Edit… 恒有,Show in Finder 挂存在的路径,Remove 只给自定义行
    fn render_location_row(&self, row: DataSourceRow, ix: usize, cx: &Context<Self>) -> AnyElement {
        let workbench = self.workbench.clone();
        let edit: RowAction = {
            let workbench = workbench.clone();
            let row = row.clone();
            Rc::new(move |window, cx| {
                let row = row.clone();
                workbench.update(cx, |this, cx| this.open_edit_location_form(row, window, cx));
            })
        };
        let reveal = row.exists.then(|| row.raw.clone());
        let remove: Option<RowAction> = row.custom.clone().map(|stored| {
            let workbench = workbench.clone();
            let agent = row.agent;
            Rc::new(move |window: &mut Window, cx: &mut App| {
                let stored = stored.clone();
                workbench.update(cx, |this, cx| {
                    this.delete_location(agent, stored, window, cx)
                });
            }) as RowAction
        });
        let toggle = {
            let (agent, path) = (row.agent, row.raw.clone());
            move |enabled: &bool, window: &mut Window, cx: &mut App| {
                let path = path.clone();
                workbench.update(cx, |this, cx| {
                    this.set_location_enabled(agent, path, *enabled, window, cx)
                });
            }
        };
        self.location_row(
            ix,
            row.display,
            row.tally,
            row.enabled,
            row.exists,
            row_menu(ix, Some(edit), reveal, remove),
            toggle,
            cx,
        )
    }

    /// Memory locations 的一行:默认来源只有开关与 Show in Finder,自定义来源多 Edit /
    /// Remove;项目模式行(`<project>/CLAUDE.md`)没有 Finder
    fn render_memory_location_row(
        &self,
        row: MemoryLocationRow,
        ix: usize,
        cx: &Context<Self>,
    ) -> AnyElement {
        let workbench = self.workbench.clone();
        let edit: Option<RowAction> = row.custom.then(|| {
            let workbench = workbench.clone();
            let row = row.clone();
            Rc::new(move |window: &mut Window, cx: &mut App| {
                let row = row.clone();
                workbench.update(cx, |this, cx| {
                    this.open_edit_memory_location_form(row, window, cx)
                });
            }) as RowAction
        });
        let reveal = (!row.pattern && row.exists).then(|| row.raw.clone());
        let remove: Option<RowAction> = row.custom.then(|| {
            let workbench = workbench.clone();
            let (agent, stored) = (row.agent, row.raw.clone());
            Rc::new(move |window: &mut Window, cx: &mut App| {
                let stored = stored.clone();
                workbench.update(cx, |this, cx| {
                    this.delete_memory_source(agent, stored, window, cx)
                });
            }) as RowAction
        });
        let toggle = {
            let (agent, id) = (row.agent, row.raw.clone());
            move |enabled: &bool, window: &mut Window, cx: &mut App| {
                let id = id.clone();
                workbench.update(cx, |this, cx| {
                    this.set_memory_source_enabled(agent, id, *enabled, window, cx)
                });
            }
        };
        self.location_row(
            ix,
            row.display,
            row.tally,
            row.enabled,
            row.exists,
            row_menu(ix, edit, reveal, remove),
            toggle,
            cx,
        )
    }

    /// location 行的壳(Session locations 与 Memory locations 共用):路径 + 计数 / 状态词、
    /// `…` 菜单、开关;停用的行文字降为 muted,路径不在时状态词用 warning 色。两页从不
    /// 同时渲染,元素 id 共用一套
    #[allow(clippy::too_many_arguments)]
    fn location_row(
        &self,
        ix: usize,
        display: SharedString,
        tally: SharedString,
        enabled: bool,
        exists: bool,
        menu: impl IntoElement,
        on_toggle: impl Fn(&bool, &mut Window, &mut App) + 'static,
        cx: &Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme();
        h_flex()
            .id(("settings-location-row", ix))
            .min_h(px(60.))
            .w_full()
            .px(SPACE_LG)
            .gap(SPACE_MD)
            .items_center()
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .gap(px(3.))
                    .child(
                        div()
                            .w_full()
                            .truncate()
                            .text_size(FONT_BODY)
                            .text_color(if enabled {
                                theme.foreground
                            } else {
                                theme.muted_foreground
                            })
                            .child(display),
                    )
                    .child(
                        div()
                            .text_size(FONT_CAPTION)
                            .text_color(if !enabled || exists {
                                theme.muted_foreground
                            } else {
                                theme.warning
                            })
                            .child(tally),
                    ),
            )
            .child(menu)
            .child(
                Switch::new(("settings-location-enabled", ix))
                    .checked(enabled)
                    .small()
                    .tooltip(if enabled {
                        t("Disable location")
                    } else {
                        t("Enable location")
                    })
                    .on_click(on_toggle),
            )
            .into_any_element()
    }

    /// 一家的一组行(Session locations 与 Memory locations 共用):品牌图 + 名字的组头,
    /// 下面一张圆角卡,行与行之间一条 hairline
    fn render_agent_group(
        &self,
        agent: AgentId,
        rows: Vec<AnyElement>,
        cx: &Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme();
        let dark = theme.mode.is_dark();
        v_flex()
            .gap(SPACE_SM)
            .child(
                h_flex()
                    .h(px(24.))
                    .gap(ICON_TEXT_GAP)
                    .items_center()
                    .child(img(agent.brand_icon(dark)).size(px(17.)).flex_shrink_0())
                    .child(
                        div()
                            .text_size(FONT_CAPTION)
                            .font_semibold()
                            .text_color(theme.foreground)
                            .child(agent.display_name()),
                    ),
            )
            .child(
                v_flex()
                    .w_full()
                    .overflow_hidden()
                    .rounded(theme.radius_lg)
                    .border_1()
                    .border_color(theme.border)
                    .bg(theme.popover)
                    .children(rows.into_iter().enumerate().map(|(ix, row)| {
                        div()
                            .w_full()
                            .when(ix > 0, |this| this.border_t_1().border_color(theme.border))
                            .child(row)
                    })),
            )
            .into_any_element()
    }

    /// Settings → Memory locations:Session locations 同形制的页(页壳 `locations_page`)
    fn render_memory_locations(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let snapshot = self.memory_locations.clone();
        let mut row_offset = 0usize;
        let list = self.render_agent_groups(
            group_by_agent(snapshot.rows, |row| row.agent),
            &mut row_offset,
            Self::render_memory_location_row,
            cx,
        );
        self.locations_page(
            t("Memory locations"),
            t("Choose which memory and instruction files ContextOS indexes."),
            snapshot.diverged,
            Workbench::open_add_memory_location_form,
            Workbench::restore_default_memory_locations,
            list,
            cx,
        )
    }

    fn render_locations(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let snapshot = self.locations.clone();
        let (available, unavailable): (Vec<_>, Vec<_>) =
            group_by_agent(snapshot.rows, |row| row.agent)
                .into_iter()
                .partition(|(_, rows)| rows.iter().any(|row| row.exists || row.custom.is_some()));
        let unavailable_count = unavailable.len();
        let mut row_offset = 0usize;
        let mut list =
            self.render_agent_groups(available, &mut row_offset, Self::render_location_row, cx);
        if unavailable_count > 0 {
            let unavailable_elements = if self.show_unavailable {
                self.render_agent_groups(
                    unavailable,
                    &mut row_offset,
                    Self::render_location_row,
                    cx,
                )
            } else {
                Vec::new()
            };
            list.push(
                v_flex()
                    .gap(SPACE_LG)
                    .child(
                        h_flex()
                            .id("settings-unavailable-locations")
                            .h(px(36.))
                            .w_full()
                            .pr(SPACE_SM)
                            .gap(SPACE_SM)
                            .items_center()
                            .rounded(theme.radius)
                            .cursor_pointer()
                            .text_color(theme.muted_foreground)
                            .hover(|style| style.bg(theme.secondary_hover))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.show_unavailable = !this.show_unavailable;
                                cx.notify();
                            }))
                            .child(
                                div()
                                    .w(px(17.))
                                    .flex_shrink_0()
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .child(
                                        icon(if self.show_unavailable {
                                            "icons/chevron-down.svg"
                                        } else {
                                            "icons/chevron-right.svg"
                                        })
                                        .with_size(px(13.)),
                                    ),
                            )
                            .child(
                                div()
                                    .flex_1()
                                    .text_size(FONT_CAPTION)
                                    .font_medium()
                                    .child(t("Not detected")),
                            )
                            .child(
                                div()
                                    .text_size(FONT_LABEL)
                                    .child(unavailable_count.to_string()),
                            ),
                    )
                    .children(unavailable_elements)
                    .into_any_element(),
            );
        }
        self.locations_page(
            t("Session locations"),
            t("Choose where ContextOS looks for local agent sessions."),
            snapshot.diverged,
            Workbench::open_add_location_form,
            Workbench::restore_default_locations,
            list,
            cx,
        )
    }

    /// 按 agent 成组渲染(两页共用):行号在整页内连续,各组的元素 id 不重叠
    fn render_agent_groups<R>(
        &self,
        groups: Vec<(AgentId, Vec<R>)>,
        row_offset: &mut usize,
        render_row: impl Fn(&Self, R, usize, &Context<Self>) -> AnyElement,
        cx: &Context<Self>,
    ) -> Vec<AnyElement> {
        groups
            .into_iter()
            .map(|(agent, rows)| {
                let start = *row_offset;
                *row_offset += rows.len();
                let rendered = rows
                    .into_iter()
                    .enumerate()
                    .map(|(ix, row)| render_row(self, row, start + ix, cx))
                    .collect();
                self.render_agent_group(agent, rendered, cx)
            })
            .collect()
    }

    /// location 页的壳(Session locations 与 Memory locations 共用):页头 = 标题 + 一句
    /// 说明 + Add location + `…` 里的 Restore defaults(没有偏离时禁用),下面是可滚动的
    /// 分组列表。两页从不同时渲染,元素 id 共用一套
    #[allow(clippy::too_many_arguments)]
    fn locations_page(
        &self,
        title: &'static str,
        caption: &'static str,
        diverged: bool,
        on_add: fn(&mut Workbench, &mut Window, &mut Context<Workbench>),
        on_restore: fn(&mut Workbench, &mut Window, &mut Context<Workbench>),
        list: Vec<AnyElement>,
        cx: &Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme();
        let add_workbench = self.workbench.clone();
        let restore_workbench = self.workbench.clone();
        v_flex()
            .flex_1()
            .min_w_0()
            .h_full()
            .bg(theme.background)
            .child(
                h_flex()
                    .flex_shrink_0()
                    .px(SPACE_XXL)
                    .pt(SETTINGS_PAGE_TOP)
                    .pb(SPACE_XL)
                    .gap(SPACE_LG)
                    .items_start()
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .gap(px(5.))
                            .child(
                                div()
                                    .text_size(FONT_TITLE)
                                    .font_semibold()
                                    .text_color(theme.foreground)
                                    .child(title),
                            )
                            .child(
                                div()
                                    .text_size(FONT_CAPTION)
                                    .text_color(theme.muted_foreground)
                                    .child(caption),
                            ),
                    )
                    .child(
                        settings_button(
                            Button::new("settings-add-location")
                                .icon(icon("icons/plus.svg").with_size(px(13.)))
                                .label(t("Add location")),
                            cx,
                        )
                        .on_click(move |_, window, cx| {
                            add_workbench.update(cx, |this, cx| on_add(this, window, cx));
                        }),
                    )
                    .child(
                        Button::new("settings-location-more")
                            .ghost()
                            .small()
                            .rounded(RADIUS_BUTTON)
                            .icon(icon("icons/more-horizontal.svg").with_size(px(14.)))
                            .dropdown_menu(move |menu, _, _| {
                                let workbench = restore_workbench.clone();
                                menu.min_w(px(180.)).item(
                                    PopupMenuItem::new(t("Restore defaults"))
                                        .disabled(!diverged)
                                        .on_click(move |_, window, cx| {
                                            workbench.update(cx, |this, cx| {
                                                on_restore(this, window, cx)
                                            });
                                        }),
                                )
                            }),
                    ),
            )
            .child(
                v_flex()
                    .id("settings-location-list")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .px(SPACE_XXL)
                    .pb(px(40.))
                    .gap(SPACE_XL)
                    .children(list),
            )
    }

    /// Settings → Remote hosts:SSH 会话聚合(阶段 1:只读镜像)。版式与
    /// Locations 页同一套:标题 + 说明,右侧低强调的 Sync now / Add host;host
    /// 列表是一张 popover 底的圆角卡,一行一台——名字为主信息、同步状态为
    /// muted 副信息(失败用 danger),`…` 菜单集中 Sync now / Remove,最右是
    /// 开关;添加走与 location 同材质的表单弹窗(2026-09-03 用户要求统一)。
    fn render_remotes(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let rows = self.workbench.read(cx).remote_hosts_snapshot();
        let syncing = self.workbench.read(cx).remote_sync_in_progress();
        let sync_workbench = self.workbench.clone();
        let add_workbench = self.workbench.clone();
        let has_hosts = !rows.is_empty();

        let row_elements: Vec<AnyElement> = rows
            .into_iter()
            .enumerate()
            .map(|(ix, row)| {
                let menu_workbench = self.workbench.clone();
                let toggle_workbench = self.workbench.clone();
                let menu_name = row.name.clone();
                let toggle_name = row.name.clone();
                let enabled = row.enabled;
                let menu = Button::new(("settings-remote-host-menu", ix))
                    .ghost()
                    .small()
                    .rounded(RADIUS_BUTTON)
                    .icon(icon("icons/more-horizontal.svg").with_size(px(14.)))
                    .dropdown_menu(move |menu, _, _| {
                        let sync_workbench = menu_workbench.clone();
                        let sync_name = menu_name.clone();
                        let remove_workbench = menu_workbench.clone();
                        let remove_name = menu_name.clone();
                        menu.min_w(px(180.))
                            .item(
                                PopupMenuItem::new(t("Sync now"))
                                    .disabled(syncing || !enabled)
                                    .on_click(move |_, _, cx| {
                                        let name = sync_name.to_string();
                                        sync_workbench.update(cx, |this, cx| {
                                            this.spawn_remote_sync(vec![name], cx)
                                        });
                                    }),
                            )
                            .separator()
                            .item(
                                PopupMenuItem::new(t("Remove")).on_click(move |_, window, cx| {
                                    let name = remove_name.clone();
                                    remove_workbench.update(cx, |this, cx| {
                                        this.confirm_remove_remote_host(name, window, cx)
                                    });
                                }),
                            )
                    });
                div()
                    .w_full()
                    .when(ix > 0, |this| this.border_t_1().border_color(theme.border))
                    .child(
                        h_flex()
                            .id(("settings-remote-host-row", ix))
                            .min_h(px(60.))
                            .w_full()
                            .px(SPACE_LG)
                            .gap(SPACE_MD)
                            .items_center()
                            .child(
                                v_flex()
                                    .flex_1()
                                    .min_w_0()
                                    .gap(px(3.))
                                    .child(
                                        div()
                                            .w_full()
                                            .truncate()
                                            .text_size(FONT_BODY)
                                            .text_color(if enabled {
                                                theme.foreground
                                            } else {
                                                theme.muted_foreground
                                            })
                                            .child(row.name.clone()),
                                    )
                                    .child(
                                        div()
                                            .w_full()
                                            .truncate()
                                            .text_size(FONT_CAPTION)
                                            .text_color(if row.failed && enabled {
                                                theme.danger
                                            } else {
                                                theme.muted_foreground
                                            })
                                            .child(row.status.clone()),
                                    ),
                            )
                            .child(menu)
                            .child(
                                Switch::new(("settings-remote-host-enabled", ix))
                                    .checked(enabled)
                                    .small()
                                    .tooltip(if enabled {
                                        t("Disable host")
                                    } else {
                                        t("Enable host")
                                    })
                                    .on_click(move |checked, window, cx| {
                                        let enabled = *checked;
                                        toggle_workbench.update(cx, |this, cx| {
                                            this.set_remote_host_enabled(
                                                toggle_name.as_ref(),
                                                enabled,
                                                window,
                                                cx,
                                            );
                                        });
                                    }),
                            ),
                    )
                    .into_any_element()
            })
            .collect();

        v_flex()
            .flex_1()
            .min_w_0()
            .h_full()
            .bg(theme.background)
            .child(
                h_flex()
                    .flex_shrink_0()
                    .px(SPACE_XXL)
                    .pt(SETTINGS_PAGE_TOP)
                    .pb(SPACE_XL)
                    .gap(SPACE_LG)
                    .items_start()
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .gap(px(5.))
                            .child(
                                div()
                                    .text_size(FONT_TITLE)
                                    .font_semibold()
                                    .text_color(theme.foreground)
                                    .child(t("Remote hosts")),
                            )
                            .child(
                                div()
                                    .text_size(FONT_CAPTION)
                                    .text_color(theme.muted_foreground)
                                    .child(
                                        "Mirror agent sessions from other machines over SSH. \
                                         Read-only: nothing on the remote is ever written.",
                                    ),
                            ),
                    )
                    .when(has_hosts, |this| {
                        this.child(
                            settings_button(
                                Button::new("settings-sync-remotes")
                                    .icon(icon("icons/refresh-cw.svg").with_size(px(13.)))
                                    .label(if syncing { t("Syncing…") } else { t("Sync now") }),
                                cx,
                            )
                            .disabled(syncing)
                            .on_click(move |_, _, cx| {
                                sync_workbench
                                    .update(cx, |this, cx| this.sync_all_remote_hosts(cx));
                            }),
                        )
                    })
                    .child(
                        settings_button(
                            Button::new("settings-add-remote-host")
                                .icon(icon("icons/plus.svg").with_size(px(13.)))
                                .label(t("Add host")),
                            cx,
                        )
                        .on_click(move |_, window, cx| {
                            add_workbench
                                .update(cx, |this, cx| this.open_add_remote_host_form(window, cx));
                        }),
                    ),
            )
            .child(
                v_flex()
                    .id("settings-remote-list")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .px(SPACE_XXL)
                    .pb(px(40.))
                    .gap(SPACE_XL)
                    .when(has_hosts, |this| {
                        this.child(
                            v_flex()
                                .w_full()
                                // 同 Connect 页:overflow_hidden 的卡在滚动列里 min-height
                                // 视为 0,host 一多会被压扁裁切而不是滚动
                                .flex_shrink_0()
                                .overflow_hidden()
                                .rounded(theme.radius_lg)
                                .border_1()
                                .border_color(theme.border)
                                .bg(theme.popover)
                                .children(row_elements),
                        )
                    })
                    .when(!has_hosts, |this| {
                        this.child(
                            div()
                                .text_size(FONT_CAPTION)
                                .text_color(theme.muted_foreground)
                                .child(t("No remote hosts yet. Add one to mirror its sessions into ContextOS.")),
                        )
                    }),
            )
            .into_any_element()
    }
}

impl Focusable for SettingsView {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for SettingsView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let background = cx.theme().background;
        let foreground = cx.theme().foreground;
        let sidebar = self.render_sidebar(window, cx);
        let selected_page = self.workbench.read(cx).settings_page();
        let content = match selected_page {
            SettingsPage::General => self.render_general(cx),
            SettingsPage::CompressionService => self.render_compression_service(cx),
            SettingsPage::CompressionStrategy => self.render_compression_strategy(cx),
            SettingsPage::Locations => self.render_locations(cx).into_any_element(),
            SettingsPage::MemoryLocations => self.render_memory_locations(cx).into_any_element(),
            SettingsPage::Remotes => self.render_remotes(cx),
            SettingsPage::Connect => self.render_connect(cx),
            SettingsPage::Retention => self.render_retention(cx),
            SettingsPage::Data => self.render_data(cx),
            SettingsPage::Updates => self.render_updates(cx),
            SettingsPage::About => self.render_about(cx),
        };
        div()
            .id("wake-settings")
            .track_focus(&self.focus_handle)
            .on_action(cx.listener(|this, _: &OpenSettings, _window, cx| {
                this.workbench
                    .update(cx, |workbench, cx| workbench.open_settings(cx));
            }))
            .on_action(cx.listener(|this, _: &OpenAbout, _window, cx| {
                this.workbench
                    .update(cx, |workbench, cx| workbench.open_about(cx));
            }))
            .on_action(cx.listener(|this, _: &OpenUpdates, _window, cx| {
                this.workbench
                    .update(cx, |workbench, cx| workbench.open_updates(cx));
            }))
            .size_full()
            .bg(background)
            .text_color(foreground)
            .child(h_flex().size_full().child(sidebar).child(content))
            .children(overlay_layers(window, cx))
    }
}
