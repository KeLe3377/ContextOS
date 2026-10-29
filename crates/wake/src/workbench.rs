// ============================================================================
// DIRECTION CONTRACT (impeccable)
// THESIS: 找回任何一段 agent 对话只需几秒;界面以 macOS 原生语言隐入背景,
//   拒绝"开发者工具=黑底霓虹终端风"的品类默认。
// OWN-WORLD: Things/Bear + Claude 客户端基准的原生 macOS 质感——暖白/暖黑双模式、
//   色差分区(无 hairline 依赖)、8px 圆角胶囊选中态(按钮 6px)、系统蓝 accent、
//   lucide 单线图标、SF 系统字体 14px 基准;agent 品牌色仅作识别圆点。
// STORY: 打开即见全部会话按时间流动;左栏收窄范围,中栏定位会话,右栏读全文;
//   ⌘K 直达任意一句话;一键回到终端继续。
// FIRST VIEWPORT: 全高三栏——224px 侧栏(全局搜索/全部/收藏/智能体/项目)、
//   336px 会话列表(上下文标题+会话数量+双行列表)，余宽为详情阅读器。
// FORM: brief-pinned canon(用户指定"现代 macOS 设计规范",对标 Things/Bear);
//   concept tournament 依规跳过,canon at full fidelity。
// FINISH: unreviewed and undocumented is unfinished; this build ends with the
//   finish review, the verdict, and DESIGN.md
// ============================================================================
use crate::i18n::t;
mod chunk_compression;
mod cleanup;
mod memory;
mod skills;
use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::ops::Range;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::Duration;

use chrono::{Datelike as _, Local, NaiveDate, TimeZone as _};
use futures::StreamExt;
use gpui::prelude::FluentBuilder as _;
use gpui::*;
use gpui_component::button::{Button, ButtonCustomVariant, ButtonVariants as _};
use gpui_component::highlighter::HighlightTheme;
use gpui_component::input::{Input, InputEvent, InputState, Textarea, TextareaState};
use gpui_component::list::{List, ListDelegate, ListEvent, ListItem, ListState};
use gpui_component::menu::{ContextMenuExt as _, DropdownMenu as _, PopupMenuItem};
use gpui_component::notification::Notification;
use gpui_component::progress::Progress;
use gpui_component::scroll::{AutoScroll, ScrollableElement as _};
use gpui_component::spinner::Spinner;
use gpui_component::text::{TextView, TextViewStyle};
use gpui_component::{
    h_flex, v_flex, ActiveTheme as _, Disableable as _, Icon, IndexPath, Root, Sizable as _,
    StyledExt as _, TitleBar, WindowExt as _,
};

use wake_core::adapters::{
    adapter_for, create_adapter_roster_for, path_owns, session_source_path, AdapterLocation,
    AgentAdapter,
};
use wake_core::db::{SessionRelation, SessionRelationEdge, SessionRelationNode, Store};
use wake_core::models::Role as MessageRole;
use wake_core::models::*;
use wake_core::scanner::{run_scan, ScanEvents, ScanProgress};
use wake_core::services::{exporter, terminal};
use wake_core::watcher::{start_watcher, SessionWatcher};
use wake_core::workspace_changes::{
    SessionChangeSessionGroup, SessionFileChangeEvent, WorkspaceChangeDetail,
    WorkspaceChangeEvent, WorkspaceChangeKind, WorkspaceRoot,
};
use wake_core::workspace_store::{
    default_workspace_cas_path, default_workspace_db_path, WorkspaceStore,
};
use wake_core::workspace_supervisor::{start_workspace_watcher, WorkspaceWatcher};

use crate::format::{
    abs_date, clip_display, expand_tilde, fmt_tokens, month_year, one_line, smart_time, thousands,
    tilde_path,
};
use crate::settings::{settings_button, SettingsPage, SettingsView};
use crate::ui::*;
use crate::update::{self, UpdateStatus};

actions!(
    wake,
    [
        ToggleSearch,
        RefreshSessions,
        OpenSettings,
        OpenUpdates,
        OpenAbout,
        PaletteUp,
        PaletteDown
    ]
);

pub const KEY_CONTEXT: &str = "Workbench";
/// ⌘K 面板容器的 key context(main.rs 的 ↑↓ 绑定与 dialog 元素共用)
pub const PALETTE_CONTEXT: &str = "WakePalette";
/// ⌘K 面板内容总高(输入行 + 结果列表 + footer);列表 flex_1 吃剩余空间
const PALETTE_HEIGHT: Pixels = px(492.);
/// location 表单标签列宽(Agent/Folder 两行共用)
const FORM_LABEL_W: Pixels = px(52.);
/// 左栏顶部由 44px 窗口控制区 + 44px 品牌行组成；中栏标题区共享总高度。
const LIBRARY_IDENTITY_HEIGHT: Pixels = px(88.);
/// 侧栏底部常态工具栏内容高；加上父容器 1px 顶部分隔线，总高 44px。
const SIDEBAR_FOOTER_ROW_HEIGHT: Pixels = px(43.);
/// 三栏固定结构宽度；工具摘要需要从窗口宽度反算真实可用空间。
const SIDEBAR_WIDTH: Pixels = px(224.);
const SIDEBAR_COLLAPSED_WIDTH: Pixels = px(40.);
const SESSION_STREAM_WIDTH: Pixels = px(336.);
const READER_MAX_WIDTH: Pixels = px(720.);
const DETAIL_OUTLINE_WIDTH: Pixels = px(232.);
const DETAIL_OUTLINE_COLLAPSED_WIDTH: Pixels = px(40.);
const DETAIL_OUTLINE_MIN_READER_WIDTH: Pixels = px(400.);
/// FONT_MSG_THINKING 使用等宽字体时，一个 ASCII 显示格的实测近似宽度。
const TOOL_MONO_CELL_WIDTH: f32 = 6.9;
/// Insights 主区块间距，明确落在 4px 网格上。
const INSIGHTS_SECTION_GAP: Pixels = px(32.);
const COMPRESSION_DIALOG_EDGE_GAP: Pixels = px(16.);
const COMPRESSION_DIALOG_MIN_WIDTH: Pixels = px(280.);
const COMPRESSION_DIALOG_MIN_BODY_HEIGHT: Pixels = px(160.);

fn compression_dialog_width(window: &Window, preferred: Pixels) -> Pixels {
    (window.viewport_size().width - COMPRESSION_DIALOG_EDGE_GAP * 2.)
        .max(COMPRESSION_DIALOG_MIN_WIDTH)
        .min(preferred)
}

fn compression_dialog_max_height(window: &Window) -> Pixels {
    let viewport_height = window.viewport_size().height;
    (viewport_height - viewport_height / 10. - COMPRESSION_DIALOG_EDGE_GAP).max(px(240.))
}

fn compression_dialog_body_height(
    window: &Window,
    preferred: Pixels,
    dialog_chrome: Pixels,
) -> Pixels {
    (compression_dialog_max_height(window) - dialog_chrome)
        .max(COMPRESSION_DIALOG_MIN_BODY_HEIGHT)
        .min(preferred)
}

type SharedAdapters = Arc<Vec<Box<dyn AgentAdapter>>>;
type SharedLocations = Arc<Vec<AdapterLocation>>;

struct BackgroundEvents {
    subscriber: Mutex<Option<futures::channel::mpsc::UnboundedSender<BgEvent>>>,
    progress: Mutex<ScanProgress>,
}

impl BackgroundEvents {
    fn subscribe(&self, sender: futures::channel::mpsc::UnboundedSender<BgEvent>) {
        *self.subscriber.lock().unwrap_or_else(|e| e.into_inner()) = Some(sender);
    }

    fn current_progress(&self) -> ScanProgress {
        self.progress
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn send(&self, event: BgEvent) {
        if let Some(sender) = self
            .subscriber
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            let _ = sender.unbounded_send(event);
        }
    }
}

impl ScanEvents for BackgroundEvents {
    fn on_progress(&self, progress: &ScanProgress) {
        *self.progress.lock().unwrap_or_else(|e| e.into_inner()) = progress.clone();
        self.send(BgEvent::Progress(progress.clone()));
    }

    fn on_sessions_changed(&self) {
        self.send(BgEvent::Changed);
    }

    fn on_workspace_changes_changed(&self) {
        self.send(BgEvent::WorkspaceChangesChanged);
    }

    fn on_rescan_needed(&self) {
        self.send(BgEvent::RescanNeeded);
    }
}

pub(crate) struct BackgroundRuntime {
    store: Arc<Store>,
    workspace_store: Arc<WorkspaceStore>,
    db_note: Mutex<Option<String>>,
    adapters: Mutex<SharedAdapters>,
    events: Arc<BackgroundEvents>,
    watcher: Mutex<Option<SessionWatcher>>,
    workspace_watcher: Mutex<Option<WorkspaceWatcher>>,
    started: OnceLock<()>,
}

impl BackgroundRuntime {
    fn new(
        store: Arc<Store>,
        workspace_store: Arc<WorkspaceStore>,
        adapters: SharedAdapters,
        db_note: Option<String>,
    ) -> Self {
        Self {
            store,
            workspace_store,
            db_note: Mutex::new(db_note),
            adapters: Mutex::new(adapters),
            events: Arc::new(BackgroundEvents {
                subscriber: Mutex::new(None),
                progress: Mutex::new(ScanProgress::default()),
            }),
            watcher: Mutex::new(None),
            workspace_watcher: Mutex::new(None),
            started: OnceLock::new(),
        }
    }

    fn adapters(&self) -> SharedAdapters {
        self.adapters
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn take_db_note(&self) -> Option<String> {
        self.db_note
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
    }

    fn replace_adapters(&self, adapters: SharedAdapters) {
        *self.adapters.lock().unwrap_or_else(|e| e.into_inner()) = adapters;
    }

    fn subscribe(&self, sender: futures::channel::mpsc::UnboundedSender<BgEvent>) {
        self.events.subscribe(sender);
    }

    fn ensure_started(&self) {
        if self.started.set(()).is_err() {
            return;
        }

        let adapters = self.adapters();
        let events: Arc<dyn ScanEvents> = self.events.clone();
        self.events.on_progress(&ScanProgress {
            scanning: true,
            ..Default::default()
        });
        spawn_scan(adapters.clone(), self.store.clone(), events.clone(), false);
        spawn_usage_sync(adapters.clone(), self.store.clone(), events.clone());

        let syncing_hosts = self.store.enabled_remote_host_names();
        spawn_remote_sync_thread_events(&self.store, self.events.clone(), syncing_hosts);

        {
            let store = self.store.clone();
            let events = self.events.clone();
            std::thread::spawn(move || report_remote_cache_size_events(&store, &events));
        }

        *self.watcher.lock().unwrap_or_else(|e| e.into_inner()) =
            start_watcher(adapters, self.store.clone(), events);

        let events = self.events.clone();
        let watcher = start_workspace_watcher(
            self.workspace_store.clone(),
            Arc::new(move || events.send(BgEvent::WorkspaceChangesChanged)),
        );
        *self
            .workspace_watcher
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = watcher;
    }

    fn remount_watcher(&self) {
        let adapters = self.adapters();
        let events: Arc<dyn ScanEvents> = self.events.clone();
        let mut watcher = self.watcher.lock().unwrap_or_else(|e| e.into_inner());
        *watcher = None;
        *watcher = start_watcher(adapters, self.store.clone(), events);
    }

    fn watched_roots(&self) -> Option<std::collections::BTreeSet<PathBuf>> {
        self.watcher
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|watcher| watcher.watched_roots().clone())
    }

    fn watcher_available(&self) -> bool {
        self.watcher
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
    }

    fn request_workspace_refresh(&self) {
        if let Some(watcher) = self
            .workspace_watcher
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            watcher.request_refresh();
        }
    }

    fn workspace_watcher_available(&self) -> bool {
        self.workspace_watcher
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
    }

    pub(crate) fn shutdown(&self) {
        // Dropping these guards joins the watcher supervisors before the
        // process exits. The finite scan/sync jobs are allowed to finish.
        self.watcher
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        self.workspace_watcher
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
    }
}

fn icon(path: &'static str) -> Icon {
    Icon::empty().path(path)
}

/// Shared identity header for library and full-page views.
/// Each view supplies its existing horizontal inset; type, height and action alignment stay shared.
fn library_header(
    id: &'static str,
    title: impl Into<SharedString>,
    subtitle: impl Into<SharedString>,
    inset: Pixels,
    actions: Option<AnyElement>,
    cx: &App,
) -> impl IntoElement {
    let title: SharedString = title.into();
    let subtitle: SharedString = subtitle.into();
    v_flex()
        .id(id)
        .w_full()
        .h(LIBRARY_IDENTITY_HEIGHT)
        .flex_shrink_0()
        .window_control_area(WindowControlArea::Drag)
        .px(inset)
        .justify_center()
        .child(
            h_flex()
                .w_full()
                .items_start()
                .justify_between()
                .gap(SPACE_SM)
                .child(
                    v_flex()
                        .flex_1()
                        .min_w_0()
                        .gap(px(2.))
                        .child(
                            div()
                                .truncate()
                                .text_size(FONT_TITLE)
                                .font_semibold()
                                .child(title),
                        )
                        .child(
                            div()
                                .truncate()
                                .text_size(FONT_LABEL)
                                .text_color(cx.theme().muted_foreground)
                                .child(subtitle),
                        ),
                )
                .when_some(actions, |row, actions| {
                    row.child(
                        div()
                            .flex_shrink_0()
                            .pt(px(2.))
                            // The header is a native window drag region. Stop its hitbox before
                            // action buttons so Windows delivers clicks instead of HTCAPTION.
                            .occlude()
                            .child(actions),
                    )
                }),
        )
}

/// Search input shared by the global session palette and full-page libraries.
/// Keeping the prefix, clear affordance, and focus behavior here prevents each
/// searchable page from drifting into a different interaction.
fn search_input_control(
    input: &Entity<InputState>,
    size: gpui_component::Size,
    clear_id: &'static str,
    cx: &App,
) -> AnyElement {
    let has_query = input.read(cx).text().len() > 0;
    let clear_input = input.clone();
    Input::new(input)
        .with_size(size)
        .prefix(
            icon("icons/search.svg")
                .with_size(px(16.))
                .text_color(cx.theme().muted_foreground),
        )
        .when(has_query, |input| {
            input.suffix(
                div()
                    .id(clear_id)
                    .size(px(24.))
                    .mr(-size.input_px())
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(cx.theme().radius)
                    .cursor_pointer()
                    .text_color(cx.theme().muted_foreground)
                    .hover(|style| {
                        style
                            .bg(cx.theme().secondary_hover)
                            .text_color(cx.theme().foreground)
                    })
                    .on_click(move |_, window, cx| {
                        clear_input.update(cx, |state, cx| {
                            state.set_value("", window, cx);
                            state.focus(window, cx);
                        });
                    })
                    .child(icon("icons/circle-x.svg").with_size(px(16.))),
            )
        })
        .p_0()
        .appearance(false)
        .into_any_element()
}

/// 起一条后台扫描线程。启动时的自动扫描与用户主动刷新都按文件指纹做增量扫描；
/// `full=true` 只保留给建库或显式的 CLI 全量重建。
/// 共用;返回的 Result 由 run_scan 的终态事件代为上报,这里只需丢弃。
/// 远程同步不在这条线程上——它走 Workbench::spawn_remote_sync 的独立线程,
/// 本地扫描不等网络(不可达 host 的 ConnectTimeout 不该拖住启动索引)。
fn spawn_scan(
    adapters: SharedAdapters,
    store: Arc<Store>,
    events: Arc<dyn ScanEvents>,
    full: bool,
) {
    std::thread::spawn(move || {
        let _ = run_scan(&adapters, &store, events.as_ref(), full);
    });
}

/// 用量有独立游标和解析器,与会话索引扫描解耦。启动时立即补齐,此后按
/// CC Switch 的常驻扫描节奏每十分钟检查源日志的文件指纹。
fn spawn_usage_sync(adapters: SharedAdapters, store: Arc<Store>, events: Arc<dyn ScanEvents>) {
    static STARTED: OnceLock<()> = OnceLock::new();
    if STARTED.set(()).is_err() {
        return;
    }
    std::thread::spawn(move || loop {
        match wake_core::services::session_usage::sync_session_usage(&adapters, &store) {
            Ok(result) => {
                if result.files_parsed > 0 {
                    events.on_sessions_changed();
                }
                if !result.errors.is_empty() {
                    eprintln!("usage scan completed with errors: {:?}", result.errors);
                }
            }
            Err(error) => eprintln!("usage scan failed: {error:#}"),
        }
        std::thread::sleep(Duration::from_secs(10 * 60));
    });
}

/// 起远程同步线程(names 空则不起)。进行中状态由调用方记 `syncing_hosts`
/// (存事实不存文案,展示句在 render 现算——不变量 6 的教训);线程收工经
/// bg_tx 发 RemoteSyncDone,成败都在 remote_hosts 表里。
fn spawn_remote_sync_thread(
    store: &Arc<Store>,
    bg_tx: futures::channel::mpsc::UnboundedSender<BgEvent>,
    names: Vec<String>,
) {
    if names.is_empty() {
        return;
    }
    let store = store.clone();
    std::thread::spawn(move || {
        wake_core::remote::sync_hosts(&store, &names);
        // 同步期间被 Remove 的 host:rsync 取消不了,收工后按配置表把孤儿
        // 缓存目录清掉(含它刚写回的),Remove 的"缓存已删"承诺自此闭合
        wake_core::remote::purge_orphan_caches(&store);
        report_remote_cache_size(&store, &bg_tx);
        let _ = bg_tx.unbounded_send(BgEvent::RemoteSyncDone);
    });
}

fn spawn_remote_sync_thread_events(
    store: &Arc<Store>,
    events: Arc<BackgroundEvents>,
    names: Vec<String>,
) {
    if names.is_empty() {
        return;
    }
    let store = store.clone();
    std::thread::spawn(move || {
        wake_core::remote::sync_hosts(&store, &names);
        wake_core::remote::purge_orphan_caches(&store);
        report_remote_cache_size_events(&store, &events);
        events.send(BgEvent::RemoteSyncDone);
    });
}

/// 算 remotes/ 镜像的占用并经 bg_tx 报回(走目录树 stat,只在后台线程调)。
/// 镜像只在启动、同步收工、删 host 后会变,所以只在那三处算,不放 render
fn report_remote_cache_size(
    store: &Store,
    bg_tx: &futures::channel::mpsc::UnboundedSender<BgEvent>,
) {
    if let Some(db_dir) = store.db_dir() {
        let bytes = wake_core::remote::cache_bytes(&db_dir);
        let _ = bg_tx.unbounded_send(BgEvent::RemoteCacheBytes(bytes));
    }
}

fn report_remote_cache_size_events(store: &Store, events: &BackgroundEvents) {
    if let Some(db_dir) = store.db_dir() {
        let bytes = wake_core::remote::cache_bytes(&db_dir);
        events.send(BgEvent::RemoteCacheBytes(bytes));
    }
}

#[derive(Clone)]
struct MarkdownDetail {
    id: String,
    start: usize,
    end: usize,
    summary: String,
    body: String,
    kind: DetailKind,
    chars: usize,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum DetailKind {
    Thinking,
    CodeGraph,
    Patch,
    Read,
    Exec,
    Image,
    Other,
}

impl DetailKind {
    fn as_str(self) -> &'static str {
        match self {
            DetailKind::Thinking => "thinking",
            DetailKind::CodeGraph => "codegraph",
            DetailKind::Patch => "patch",
            DetailKind::Read => "read",
            DetailKind::Exec => "exec",
            DetailKind::Image => "image",
            DetailKind::Other => "other",
        }
    }
}

#[derive(Clone)]
struct DetailDecision {
    detail: MarkdownDetail,
    replacement: Option<String>,
    uncertain_for_jev: bool,
}

#[derive(Default)]
struct DetailCompactionStats {
    original_chars: usize,
    first_step_deleted: usize,
    first_step_deleted_chars: usize,
    second_step_cropped: usize,
    second_step_saved_chars: usize,
    third_step_jev_candidates: usize,
    third_step_jev_kept_full: usize,
    third_step_jev_dropped_full: usize,
    third_step_jev_batches: usize,
    third_step_jev_skipped_by_budget: usize,
}

struct DetailCompactionResult {
    markdown: String,
    report: String,
    stats: DetailCompactionStats,
}

const JEV_CANDIDATE_OUTPUT_CHARS: usize = 3_000;
const JEV_SUMMARY_PREVIEW_CHARS: usize = 180;
const JEV_HEAD_PREVIEW_CHARS: usize = 240;
const JEV_TAIL_PREVIEW_CHARS: usize = 160;
const JEV_REQUEST_CHAR_BUDGET: usize = 45_000;
const DEFAULT_LLM_INPUT_LIMIT_CHARS: usize =
    wake_core::services::compression::DEFAULT_LLM_INPUT_LIMIT_CHARS;

fn char_slice(text: &str, head: usize, tail: usize) -> String {
    if text.len() <= head + tail + 80 {
        return text.to_string();
    }
    let head_end = safe_prefix_end(text, head);
    let tail_start = safe_suffix_start(text, tail);
    format!(
        "{}\n\n[... {} chars omitted ...]\n\n{}",
        &text[..head_end],
        text.len()
            .saturating_sub(head_end + text[tail_start..].len()),
        &text[tail_start..]
    )
}

fn safe_prefix_end(text: &str, limit: usize) -> usize {
    let mut end = limit.min(text.len());
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    end
}

fn safe_suffix_start(text: &str, limit: usize) -> usize {
    let mut start = text.len().saturating_sub(limit);
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    start
}

fn detail_kind(summary: &str, body: &str) -> DetailKind {
    let combined = format!("{summary}\n{body}");
    if summary.contains("Thinking") || summary.contains("🧠") {
        DetailKind::Thinking
    } else if combined.contains("apply_patch")
        || combined.contains("Begin Patch")
        || combined.contains("Update File:")
        || combined.contains("Add File:")
        || combined.contains("Delete File:")
        || combined.contains("diff --git")
        || combined.contains("@@")
    {
        DetailKind::Patch
    } else if summary.to_ascii_lowercase().contains("codegraph") {
        DetailKind::CodeGraph
    } else if summary.contains("Read") || summary.contains("read") {
        DetailKind::Read
    } else if summary.contains("exec_command")
        || summary.contains("Bash")
        || summary.contains("PowerShell")
        || summary.contains("TaskCreate")
        || summary.contains("TaskUpdate")
        || summary.contains("write_stdin")
    {
        DetailKind::Exec
    } else if summary.contains("view_image") {
        DetailKind::Image
    } else {
        DetailKind::Other
    }
}

fn detail_flags(summary: &str, body: &str) -> Vec<&'static str> {
    let combined = format!("{summary}\n{body}");
    let lower = combined.to_ascii_lowercase();
    let mut flags = Vec::new();
    if lower.contains("error")
        || lower.contains("failed")
        || lower.contains("failure")
        || lower.contains("panic")
        || lower.contains("exception")
        || lower.contains("stderr")
        || combined.contains("失败")
        || combined.contains("报错")
        || combined.contains("错误")
    {
        flags.push("error_or_failure");
    }
    if combined.contains("changed on disk")
        || combined.contains("source omitted")
        || combined.contains("Already sent earlier")
        || combined.contains("last index sync")
    {
        flags.push("codegraph_state");
    }
    if lower.contains("cargo")
        || lower.contains("npm")
        || lower.contains("pnpm")
        || lower.contains("git")
        || lower.contains("rg ")
        || lower.contains("test")
        || lower.contains("check")
        || lower.contains("build")
        || combined.contains("验证")
        || combined.contains("测试")
        || combined.contains("编译")
    {
        flags.push("command_or_verification");
    }
    if combined.contains(":\\")
        || combined.contains("/src/")
        || combined.contains("crates/")
        || combined.contains(".rs")
        || combined.contains(".ts")
        || combined.contains(".tsx")
        || combined.contains(".md")
    {
        flags.push("paths_or_files");
    }
    flags
}

fn parse_markdown_details(markdown: &str) -> Vec<MarkdownDetail> {
    let mut details = Vec::new();
    let mut cursor = 0usize;
    while let Some(open_rel) = markdown[cursor..].find("<details><summary>") {
        let start = cursor + open_rel;
        let summary_start = start + "<details><summary>".len();
        let Some(summary_end_rel) = markdown[summary_start..].find("</summary>") else {
            break;
        };
        let summary_end = summary_start + summary_end_rel;
        let body_start = summary_end + "</summary>".len();
        let Some(close_rel) = markdown[body_start..].find("</details>") else {
            break;
        };
        let close_start = body_start + close_rel;
        let end = close_start + "</details>".len();
        let summary = markdown[summary_start..summary_end].to_string();
        let body = markdown[body_start..close_start]
            .trim_matches('\n')
            .to_string();
        details.push(MarkdownDetail {
            id: format!("d{}", details.len() + 1),
            start,
            end,
            kind: detail_kind(&summary, &body),
            chars: body.len(),
            summary,
            body,
        });
        cursor = end;
    }
    details
}

fn fenced_section(body: &str, label: &str) -> Option<(usize, usize, String)> {
    let marker = format!("{label}:\n\n```\n");
    let start = body.find(&marker)? + marker.len();
    let end = body[start..].find("\n```")? + start;
    Some((start, end, body[start..end].to_string()))
}

fn is_low_value_detail(detail: &MarkdownDetail) -> bool {
    let body = detail.body.trim();
    if detail.summary.contains("write_stdin") && body.len() < 220 {
        return true;
    }
    body.is_empty()
        || body == "Output:\n\n```\n\n```"
        || body.contains("Process exited with code 0") && body.len() < 260
}

fn is_skill_output(output: &str) -> bool {
    output.contains("# Systematic Debugging")
        || output.contains("# ")
            && (output.contains("## Overview") || output.contains("## The Iron Law"))
        || output.contains("SKILL.md")
}

fn is_codegraph_output(summary: &str, output: &str) -> bool {
    summary.to_ascii_lowercase().contains("codegraph")
        || output.contains("CodeGraph")
        || output.contains("Blast radius")
        || output.contains("changed on disk after the last index sync")
}

fn is_patch_evidence(detail: &MarkdownDetail, output: &str) -> bool {
    detail.kind == DetailKind::Patch
        || output.contains("Begin Patch")
        || output.contains("Update File:")
        || output.contains("diff --git")
        || output.contains("@@")
}

fn compress_codegraph_output(output: &str) -> String {
    let mut kept = Vec::new();
    for line in output.lines() {
        if line.contains("Exploration:")
            || line.contains("Found ")
            || line.contains("Blast radius")
            || line.contains("depends on")
            || line.contains("changed on disk")
            || line.contains("source omitted")
            || line.contains("Already sent earlier")
            || line.contains("last index sync")
            || line.starts_with("**`")
            || line.starts_with("> ")
        {
            kept.push(line.to_string());
        }
    }
    if kept.is_empty() {
        format!(
            "{}\n\n[已省略 CodeGraph 源码输出，保留首尾状态]\n\n{}",
            char_slice(output, 900, 0),
            char_slice(output, 0, 500)
        )
    } else {
        format!(
            "{}\n\n[已省略 CodeGraph 源码全文；保留查询、文件状态、blast radius 与同步提示。]",
            kept.join("\n")
        )
    }
}

fn compress_skill_output(output: &str) -> String {
    let headings = output
        .lines()
        .filter(|line| line.starts_with('#'))
        .take(24)
        .collect::<Vec<_>>()
        .join("\n");
    if headings.is_empty() {
        format!(
            "{}\n\n[已省略 skill 全文，仅保留首尾线索]\n\n{}",
            char_slice(output, 800, 0),
            char_slice(output, 0, 500)
        )
    } else {
        format!("[已省略 skill 全文；保留使用的 skill 结构标题]\n\n{headings}")
    }
}

fn structured_output_stub(detail: &MarkdownDetail, output: &str) -> (String, bool) {
    if output.len() < 900 {
        return (output.to_string(), false);
    }
    if is_patch_evidence(detail, output) {
        return (char_slice(output, 2_400, 1_200), output.len() > 3_800);
    }
    if is_codegraph_output(&detail.summary, output) {
        return (compress_codegraph_output(output), false);
    }
    if is_skill_output(output) {
        return (compress_skill_output(output), false);
    }
    let uncertain = output.len() >= JEV_CANDIDATE_OUTPUT_CHARS
        && !detail_flags(&detail.summary, output).contains(&"error_or_failure");
    (
        format!(
            "{}\n\n[已机械裁剪 Output：原始 {} chars]\n\n{}",
            char_slice(output, 700, 0),
            output.len(),
            char_slice(output, 0, 500)
        ),
        uncertain,
    )
}

fn rewrite_output_section(body: &str, replacement: &str) -> String {
    if let Some((start, end, _)) = fenced_section(body, "Output") {
        let mut out = String::new();
        out.push_str(&body[..start]);
        out.push_str(replacement);
        out.push_str(&body[end..]);
        out
    } else {
        body.to_string()
    }
}

fn mechanical_detail_decision(
    detail: MarkdownDetail,
    stats: &mut DetailCompactionStats,
) -> DetailDecision {
    if is_low_value_detail(&detail) {
        stats.first_step_deleted += 1;
        stats.first_step_deleted_chars += detail.end.saturating_sub(detail.start);
        return DetailDecision {
            detail,
            replacement: None,
            uncertain_for_jev: false,
        };
    }
    let Some((_, _, output)) = fenced_section(&detail.body, "Output") else {
        return DetailDecision {
            detail,
            replacement: None,
            uncertain_for_jev: false,
        };
    };
    let (stub, uncertain_for_jev) = structured_output_stub(&detail, &output);
    if stub == output {
        return DetailDecision {
            detail,
            replacement: None,
            uncertain_for_jev: false,
        };
    }
    stats.second_step_cropped += 1;
    stats.second_step_saved_chars += output.len().saturating_sub(stub.len());
    let body = rewrite_output_section(&detail.body, &stub);
    let replacement = format!(
        "<details><summary>{}</summary>\n\n{}\n\n</details>",
        detail.summary, body
    );
    DetailDecision {
        detail,
        replacement: Some(replacement),
        uncertain_for_jev,
    }
}

fn apply_detail_decisions(markdown: &str, decisions: &[DetailDecision]) -> String {
    let mut out = String::new();
    let mut cursor = 0usize;
    for decision in decisions {
        out.push_str(&markdown[cursor..decision.detail.start]);
        if let Some(replacement) = &decision.replacement {
            out.push_str(replacement);
        }
        cursor = decision.detail.end;
    }
    out.push_str(&markdown[cursor..]);
    out
}

fn build_detail_jev_state(meta: &SessionMeta, details: &[MarkdownDetail]) -> serde_json::Value {
    let mut kind_counts = serde_json::Map::new();
    for detail in details {
        let entry = kind_counts
            .entry(detail.kind.as_str())
            .or_insert_with(|| serde_json::json!(0));
        *entry = serde_json::json!(entry.as_i64().unwrap_or(0) + 1);
    }
    serde_json::json!({
        "goal": "Decide whether large uncertain Markdown tool outputs should remain full before LLM compression. Prefer preserving exact outputs only when they contain facts, paths, failures, verification, code changes, or resume-critical details not captured by the mechanical head/tail stub.",
        "session": {
            "title": meta.title,
            "agent": meta.agent.display_name(),
            "project": meta.project_path,
            "message_count": meta.message_count,
            "tokens_used": meta.tokens_used,
        },
        "detail_count": details.len(),
        "kind_counts": kind_counts,
    })
}

fn detail_jev_question(detail: &MarkdownDetail) -> serde_json::Value {
    let output = fenced_section(&detail.body, "Output")
        .map(|(_, _, output)| output)
        .unwrap_or_default();
    serde_json::json!({
        "type": "noul",
        "instructions": format!(
            "The full Output of Markdown detail {} ({}, {} chars) should remain verbatim for LLM compression. Summary: {}\nHead:\n{}\nTail:\n{}",
            detail.id,
            detail.kind.as_str(),
            detail.chars,
            char_slice(&detail.summary, JEV_SUMMARY_PREVIEW_CHARS, 0),
            char_slice(&output, JEV_HEAD_PREVIEW_CHARS, 0),
            char_slice(&output, 0, JEV_TAIL_PREVIEW_CHARS),
        )
    })
}

fn jev_noul_answer(json: &serde_json::Value, key: &str) -> f64 {
    json.pointer(&format!("/answers/{key}/noul"))
        .and_then(|value| value.as_f64())
        .or_else(|| {
            json.pointer(&format!("/answers/{key}/score"))
                .and_then(|value| value.as_f64())
        })
        .unwrap_or(1.0)
}

fn invoke_detail_jev_batch(
    config: &JevConfig,
    meta: &SessionMeta,
    all_details: &[MarkdownDetail],
    batch: &[MarkdownDetail],
) -> anyhow::Result<serde_json::Value> {
    let endpoint = jev_endpoint(&config.api_url);
    let questions = batch
        .iter()
        .map(|detail| (format!("full_{}", detail.id), detail_jev_question(detail)))
        .collect::<serde_json::Map<_, _>>();
    let body = serde_json::json!({
        "model": config.model,
        "state": build_detail_jev_state(meta, all_details),
        "questions": questions,
    });
    let text = post_jev_json(config, &endpoint, &body)?;
    let json_text = text.trim_start_matches('\u{feff}');
    let json: serde_json::Value = serde_json::from_str(json_text).map_err(|error| {
        anyhow::anyhow!(
            "{} returned non-JSON response: {error}; raw head: {}",
            config.provider.display_name(),
            char_slice(json_text.trim(), 600, 0)
        )
    })?;
    if !json.get("answers").is_some_and(|value| value.is_object()) {
        return Err(anyhow::anyhow!(
            "{} response missing answers",
            config.provider.display_name()
        ));
    }
    Ok(json)
}

fn jev_body_len(
    config: &JevConfig,
    meta: &SessionMeta,
    all_details: &[MarkdownDetail],
    batch: &[MarkdownDetail],
) -> usize {
    let questions = batch
        .iter()
        .map(|detail| (format!("full_{}", detail.id), detail_jev_question(detail)))
        .collect::<serde_json::Map<_, _>>();
    serde_json::json!({
        "model": config.model,
        "state": build_detail_jev_state(meta, all_details),
        "questions": questions,
    })
    .to_string()
    .len()
}

fn split_jev_batches(
    config: &JevConfig,
    meta: &SessionMeta,
    all_details: &[MarkdownDetail],
    candidates: &[MarkdownDetail],
    stats: &mut DetailCompactionStats,
) -> Vec<Vec<MarkdownDetail>> {
    let mut batches = Vec::new();
    let mut current = Vec::new();
    for detail in candidates {
        let single = std::slice::from_ref(detail);
        if jev_body_len(config, meta, all_details, single) > JEV_REQUEST_CHAR_BUDGET {
            stats.third_step_jev_skipped_by_budget += 1;
            continue;
        }
        let mut trial = current.clone();
        trial.push(detail.clone());
        if !current.is_empty()
            && jev_body_len(config, meta, all_details, &trial) > JEV_REQUEST_CHAR_BUDGET
        {
            batches.push(current);
            current = vec![detail.clone()];
        } else {
            current = trial;
        }
    }
    if !current.is_empty() {
        batches.push(current);
    }
    batches
}

fn compact_markdown_details(
    markdown: &str,
    meta: &SessionMeta,
    jev: Option<&JevConfig>,
) -> anyhow::Result<DetailCompactionResult> {
    let details = parse_markdown_details(markdown);
    let mut stats = DetailCompactionStats {
        original_chars: markdown.len(),
        ..Default::default()
    };
    let mut decisions = details
        .into_iter()
        .map(|detail| mechanical_detail_decision(detail, &mut stats))
        .collect::<Vec<_>>();
    let candidates = decisions
        .iter()
        .filter(|decision| decision.uncertain_for_jev)
        .map(|decision| decision.detail.clone())
        .collect::<Vec<_>>();
    stats.third_step_jev_candidates = candidates.len();
    if let Some(config) = jev {
        let all_details = decisions
            .iter()
            .map(|decision| decision.detail.clone())
            .collect::<Vec<_>>();
        let batches = split_jev_batches(config, meta, &all_details, &candidates, &mut stats);
        stats.third_step_jev_batches = batches.len();
        for batch in batches {
            let answers = invoke_detail_jev_batch(config, meta, &all_details, &batch)?;
            for detail in batch {
                let score = jev_noul_answer(&answers, &format!("full_{}", detail.id));
                if score >= 0.5 {
                    if let Some(decision) = decisions.iter_mut().find(|d| d.detail.id == detail.id)
                    {
                        decision.replacement = Some(detail_full(&detail));
                        decision.uncertain_for_jev = false;
                    }
                    stats.third_step_jev_kept_full += 1;
                } else {
                    stats.third_step_jev_dropped_full += 1;
                }
            }
        }
    }
    let compacted = apply_detail_decisions(markdown, &decisions);
    let report = format!(
        "# 基础压缩处理报告\n\n- 原始 Markdown：{} chars\n- 第一步机械删除：{} blocks，{} chars\n- 第二步 Output 内部裁剪：{} blocks，约节省 {} chars\n- 第三步 Jev 候选：{} blocks\n- 第三步 Jev 批次：{} batches\n- 第三步 Jev 保留全文：{} blocks\n- 第三步 Jev 继续裁剪：{} blocks\n- thirdStepJevSkippedByBudget：{}\n- LLM 输入 Markdown：{} chars\n",
        stats.original_chars,
        stats.first_step_deleted,
        stats.first_step_deleted_chars,
        stats.second_step_cropped,
        stats.second_step_saved_chars,
        stats.third_step_jev_candidates,
        stats.third_step_jev_batches,
        stats.third_step_jev_kept_full,
        stats.third_step_jev_dropped_full,
        stats.third_step_jev_skipped_by_budget,
        compacted.len(),
    );
    Ok(DetailCompactionResult {
        markdown: compacted,
        report,
        stats,
    })
}

fn detail_full(detail: &MarkdownDetail) -> String {
    format!(
        "<details><summary>{}</summary>\n\n{}\n\n</details>",
        detail.summary, detail.body
    )
}

fn jev_endpoint(raw: &str) -> String {
    let raw = raw.trim().trim_end_matches('/');
    if raw.ends_with("/v1/systemone") {
        raw.to_string()
    } else {
        format!("{raw}/v1/systemone")
    }
}

fn llm_endpoint(raw: &str) -> String {
    let raw = raw.trim().trim_end_matches('/');
    if raw.ends_with("/chat/completions") {
        raw.to_string()
    } else {
        format!("{raw}/v1/chat/completions")
    }
}

fn default_single_compression_strategy() -> String {
    wake_core::services::compression::default_single_strategy()
}

fn default_memory_generation_strategy() -> String {
    wake_core::services::compression::default_memory_generation_strategy()
}

fn default_multi_compression_strategy() -> String {
    wake_core::services::compression::default_multi_strategy()
}

fn default_tag_compression_strategy() -> String {
    wake_core::services::compression::default_tag_strategy()
}

fn default_specific_tag_compression_strategy(tag: &str) -> String {
    wake_core::services::compression::default_specific_tag_strategy(tag)
}

fn compression_strategy_tag_key(tag: &str) -> String {
    format!("compression_strategy_tag_{}", tag.replace('-', "_"))
}

fn compression_strategy_tag_button_id(tag: &str) -> &'static str {
    match tag {
        "development" => "compression-strategy-tag-development",
        "design" => "compression-strategy-tag-design",
        "testing" => "compression-strategy-tag-testing",
        "research" => "compression-strategy-tag-research",
        "refactor" => "compression-strategy-tag-refactor",
        "bugfix" => "compression-strategy-tag-bugfix",
        "product-decision" => "compression-strategy-tag-product-decision",
        "paused" => "compression-strategy-tag-paused",
        "completed" => "compression-strategy-tag-completed",
        "continue-later" => "compression-strategy-tag-continue-later",
        _ => "compression-strategy-tag-unknown",
    }
}

pub(crate) fn compression_strategy_tag_options() -> Vec<(&'static str, &'static str)> {
    SESSION_TAGS
        .iter()
        .map(|tag| (*tag, session_tag_label(tag)))
        .collect()
}

#[cfg(test)]
fn format_tag_strategy_for_prompt(settings: &CompressionSettings, tags: &[String]) -> String {
    let mut out = String::new();
    out.push_str("## 通用标签策略\n");
    out.push_str(settings.tag_strategy.trim());
    out.push_str("\n\n## 当前会话命中的标签专用策略\n");
    let mut matched = false;
    for tag in tags {
        if let Some(strategy) = settings.tag_specific_strategies.get(tag) {
            let strategy = strategy.trim();
            if !strategy.is_empty() {
                matched = true;
                out.push_str(&format!(
                    "- #{}：{}\n",
                    session_tag_label(tag),
                    strategy.replace('\n', "\n  ")
                ));
            }
        }
    }
    if !matched {
        out.push_str("- 无\n");
    }
    out
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CompressionExportMode {
    Plain,
    WithMemory,
}

impl CompressionExportMode {
    fn file_suffix(self) -> &'static str {
        match self {
            Self::Plain => "compressed",
            Self::WithMemory => "compressed-memory",
        }
    }

    fn start_message(self) -> &'static str {
        match self {
            Self::Plain => "正在准备压缩导出…",
            Self::WithMemory => "正在准备压缩并生成记忆…",
        }
    }

    fn llm_message(self) -> &'static str {
        match self {
            Self::Plain => "LLM 正在生成压缩文档…",
            Self::WithMemory => "LLM 正在生成压缩文档和记忆候选…",
        }
    }

    #[cfg(test)]
    fn task_title(self) -> &'static str {
        match self {
            Self::Plain => "请按 ContextOS 策略压缩一个 agent 对话，输出 Markdown。",
            Self::WithMemory => {
                "请按 ContextOS 策略压缩一个 agent 对话，输出 Markdown，并在末尾输出 contextos-json 记忆候选。"
            }
        }
    }

    #[cfg(test)]
    fn strategy<'a>(self, settings: &'a CompressionSettings) -> &'a str {
        match self {
            Self::Plain => &settings.single_strategy,
            Self::WithMemory => &settings.memory_generation_strategy,
        }
    }

    fn success_title(self) -> &'static str {
        match self {
            Self::Plain => "压缩导出完成",
            Self::WithMemory => "压缩并生成记忆完成",
        }
    }
}

fn default_relation_compression_strategy() -> String {
    wake_core::services::compression::default_relation_strategy()
}

fn post_jev_json(
    config: &JevConfig,
    endpoint: &str,
    body: &serde_json::Value,
) -> anyhow::Result<String> {
    let id = JEV_CURL_FALLBACK_GENERATION.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir();
    let stem = format!("contextos-jev-pwsh-{id}-{}", std::process::id());
    let body_path = dir.join(format!("{stem}.json"));
    let script_path = dir.join(format!("{stem}.ps1"));
    let response_path = dir.join(format!("{stem}.out"));
    std::fs::write(&body_path, serde_json::to_vec(body)?)?;
    std::fs::write(
        &script_path,
        format!(
            "$ErrorActionPreference = 'Stop'\n\
             $body = Get-Content -LiteralPath '{}' -Raw\n\
             $headers = @{{ Authorization = 'Bearer {}'; 'Content-Type' = 'application/json' }}\n\
             try {{\n\
               $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($body)\n\
               $response = Invoke-WebRequest -Method Post -Uri '{}' -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $bodyBytes -TimeoutSec {} -UseBasicParsing\n\
               Set-Content -LiteralPath '{}' -Value $response.Content -Encoding UTF8\n\
             }} catch {{\n\
               $message = $_.Exception.Message\n\
               if ($_.ErrorDetails -and $_.ErrorDetails.Message) {{ $message = \"$message`n$($_.ErrorDetails.Message)\" }}\n\
               Set-Content -LiteralPath '{}' -Value $message -Encoding UTF8\n\
               exit 1\n\
             }}\n",
            body_path.to_string_lossy().replace('\'', "''"),
            config.api_key.trim().replace('\'', "''"),
            endpoint.replace('\'', "''"),
            config.timeout_secs,
            response_path.to_string_lossy().replace('\'', "''"),
            response_path.to_string_lossy().replace('\'', "''"),
        ),
    )?;
    let output = std::process::Command::new("powershell.exe")
        .arg("-NoProfile")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-File")
        .arg(&script_path)
        .output();
    let _ = std::fs::remove_file(&script_path);
    let _ = std::fs::remove_file(&body_path);
    let output = output?;
    let response = std::fs::read_to_string(&response_path)
        .unwrap_or_default()
        .trim_start_matches('\u{feff}')
        .to_string();
    let _ = std::fs::remove_file(&response_path);
    if !output.status.success() {
        return Err(anyhow::anyhow!(
            "Jev PowerShell request failed: {}{}{}",
            response.trim(),
            if output.stderr.is_empty() { "" } else { "\n" },
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(response)
}

#[cfg(test)]
fn truncate_for_llm(text: &str, limit: usize) -> String {
    let Some((end, _)) = text.char_indices().nth(limit) else {
        return text.to_string();
    };
    format!(
        "{}\n\n[原始会话过长，已截断到前 {limit} 字符。]",
        &text[..end]
    )
}

#[cfg(test)]
fn call_openai_compatible_llm(
    settings: &CompressionSettings,
    prompt: &str,
) -> anyhow::Result<String> {
    let endpoint = llm_endpoint(&settings.llm_api_url);
    let body = serde_json::json!({
        "model": settings.llm_model.trim(),
        "messages": [
            {
                "role": "system",
                "content": "你是 ContextOS 的压缩引擎。你只根据输入内容压缩，不编造事实；保留可接手的工程上下文。"
            },
            {
                "role": "user",
                "content": prompt
            }
        ],
        "temperature": 0.2
    });
    let response = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(settings.llm_timeout_secs))
        .build()?
        .post(endpoint)
        .bearer_auth(settings.llm_api_key.trim())
        .header(reqwest::header::USER_AGENT, "ContextOS/0.8.0")
        .header(reqwest::header::ACCEPT, "application/json")
        .json(&body)
        .send()?;
    let status = response.status();
    let text = response.text()?;
    if !status.is_success() {
        return Err(anyhow::anyhow!("LLM API returned {status}: {text}"));
    }
    let json: serde_json::Value = serde_json::from_str(&text)?;
    json.pointer("/choices/0/message/content")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .ok_or_else(|| anyhow::anyhow!("LLM API response missing choices[0].message.content"))
}

#[cfg(test)]
fn extract_contextos_json(markdown: &str) -> Option<&str> {
    if let Some(json) = extract_fenced_block(markdown, "```contextos-json") {
        return Some(json);
    }
    extract_memory_candidates_section_json(markdown)
}

#[cfg(test)]
fn extract_fenced_block<'a>(markdown: &'a str, marker: &str) -> Option<&'a str> {
    let start = markdown.rfind(marker)?;
    extract_fenced_block_from(markdown, start, marker)
}

#[cfg(test)]
fn extract_memory_candidates_section_json(markdown: &str) -> Option<&str> {
    let heading = find_contextos_memory_candidates_heading(markdown)?;
    let section = &markdown[heading..];
    let fence = section.find("```")? + heading;
    extract_any_fenced_block_from(markdown, fence)
}

#[cfg(test)]
fn find_contextos_memory_candidates_heading(markdown: &str) -> Option<usize> {
    let mut offset = 0usize;
    for line in markdown.split_inclusive('\n') {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            let title = trimmed.trim_start_matches('#').trim();
            if title == "ContextOS 记忆候选" {
                return Some(offset);
            }
        }
        offset += line.len();
    }
    None
}

#[cfg(test)]
fn extract_any_fenced_block_from(markdown: &str, start: usize) -> Option<&str> {
    let after_open = &markdown[start + "```".len()..];
    let content_start = after_open.find('\n').map_or(0, |ix| ix + 1);
    let content = &after_open[content_start..];
    let end = content.find("```")?;
    Some(content[..end].trim())
}

#[cfg(test)]
fn extract_fenced_block_from<'a>(markdown: &'a str, start: usize, marker: &str) -> Option<&'a str> {
    let after_marker = &markdown[start + marker.len()..];
    let after_newline = after_marker
        .strip_prefix("\r\n")
        .or_else(|| after_marker.strip_prefix('\n'))
        .unwrap_or(after_marker);
    let end = after_newline.find("```")?;
    Some(after_newline[..end].trim())
}

#[cfg(test)]
#[derive(Clone, Debug, Default, serde::Deserialize)]
struct ContextosMemoryCandidates {
    #[serde(default)]
    memory_candidates: Vec<ContextosMemoryCandidate>,
}

type ContextosMemoryCandidate = wake_core::services::compression::MemoryCandidate;

#[cfg(test)]
fn parse_contextos_memory_candidates(
    markdown: &str,
) -> anyhow::Result<Vec<ContextosMemoryCandidate>> {
    let json = extract_contextos_json(markdown).ok_or_else(|| {
        anyhow::anyhow!(
            "LLM 输出缺少 contextos-json 块，也未找到“ContextOS 记忆候选”标题后的 JSON 代码块"
        )
    })?;
    let value: serde_json::Value = serde_json::from_str(json)?;
    if !value
        .get("memory_candidates")
        .is_some_and(|value| value.is_array())
    {
        return Err(anyhow::anyhow!(
            "ContextOS 记忆候选 JSON 缺少 memory_candidates 数组"
        ));
    }
    let parsed: ContextosMemoryCandidates = serde_json::from_value(value)?;
    Ok(parsed.memory_candidates)
}

fn contextos_memory_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".codex")
        .join("memories")
}

fn safe_file_stem(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            out.push(ch);
        } else if ch.is_whitespace() || ch == '.' {
            out.push('-');
        }
    }
    let out = out.trim_matches('-');
    if out.is_empty() {
        "memory".to_string()
    } else {
        out.chars().take(48).collect()
    }
}

fn render_memory_candidate_markdown(
    candidate: &ContextosMemoryCandidate,
    meta: &SessionMeta,
) -> String {
    wake_core::services::compression::render_memory_candidate_markdown(
        candidate,
        Some(&meta.title),
        Some(&meta.project_path),
    )
}

fn empty_dash(value: &str) -> &str {
    let value = value.trim();
    if value.is_empty() {
        "-"
    } else {
        value
    }
}

#[cfg(test)]
fn push_markdown_section(out: &mut String, title: &str, value: &str) {
    let value = value.trim();
    if value.is_empty() {
        return;
    }
    out.push_str(&format!("## {title}\n\n{value}\n\n"));
}

fn write_contextos_memory_candidate(
    candidate: &ContextosMemoryCandidate,
    meta: &SessionMeta,
) -> anyhow::Result<PathBuf> {
    let dir = contextos_memory_dir();
    std::fs::create_dir_all(&dir)?;
    let file = dir.join(format!(
        "contextos-{}-{}-{}-{}.md",
        safe_file_stem(candidate.kind_label()),
        chrono::Local::now().format("%Y%m%d-%H%M%S"),
        if meta.project_name.is_empty() {
            "unknown-project".to_string()
        } else {
            safe_file_stem(&meta.project_name)
        },
        safe_file_stem(&candidate.title_or_fallback())
    ));
    std::fs::write(&file, render_memory_candidate_markdown(candidate, meta))?;
    Ok(file)
}

#[cfg(test)]
fn compress_markdown_with_llm(
    settings: &CompressionSettings,
    meta: &SessionMeta,
    markdown: &str,
    tags: &[String],
    relationship_context: &str,
    jev_reference: Option<&str>,
    mode: CompressionExportMode,
) -> anyhow::Result<String> {
    if settings.llm_api_url.trim().is_empty()
        || settings.llm_api_key.trim().is_empty()
        || settings.llm_model.trim().is_empty()
    {
        return Err(anyhow::anyhow!(
            "请先在设置 > 压缩策略里配置 LLM API URL、Key 和 Model"
        ));
    }
    let tag_labels = if tags.is_empty() {
        "无".to_string()
    } else {
        tags.iter()
            .map(|tag| format!("#{}", session_tag_label(tag)))
            .collect::<Vec<_>>()
            .join(" ")
    };
    let tag_strategy = format_tag_strategy_for_prompt(settings, tags);
    let jev_reference = jev_reference.unwrap_or("未启用或未生成。");
    let prompt = format!(
        r#"# 任务
{task_title}

# 压缩策略
{strategy}

# 标签策略
{tag_strategy}

# 关系策略
{relation_strategy}

# 会话元信息
- 标题：{title}
- Agent：{agent}
- 项目：{project}
- 标签：{tags}
- 关系：{relationship_context}

# Jev 辅助摘取/评分参考
{jev_reference}

# 原始会话 Markdown
{markdown}
"#,
        task_title = mode.task_title(),
        strategy = mode.strategy(settings),
        tag_strategy = tag_strategy,
        relation_strategy = settings.relation_strategy,
        title = meta.title,
        agent = meta.agent.display_name(),
        project = if meta.project_path.is_empty() {
            "(unknown)"
        } else {
            &meta.project_path
        },
        tags = tag_labels,
        relationship_context = relationship_context,
        jev_reference = truncate_for_llm(jev_reference, settings.llm_input_limit_chars),
        markdown = truncate_for_llm(markdown, settings.llm_input_limit_chars),
    );
    call_openai_compatible_llm(settings, &prompt)
}

// ---------------- 后台事件桥 ----------------

enum BgEvent {
    Progress(ScanProgress),
    Changed,
    /// 监听后端丢过事件,需要一轮增量兜底
    RescanNeeded,
    /// 远程 rsync 线程收工(成败都发;状态在 remote_hosts 表里)
    RemoteSyncDone,
    /// remotes/ 镜像的磁盘占用算好了(启动、同步收工、删 host 后各算一次)
    RemoteCacheBytes(u64),
    WorkspaceChangesChanged,
    /// 托管 Laya 状态变化；业务状态保存在 wake-core，这里只触发重绘。
    LayaRuntimeChanged,
    /// 托管 Laya 后台命令收工后的用户通知。
    LayaRuntimeFinished(Result<String, String>),
    /// 外部 SystemOne 能力探测结果。
    LayaExternalProbeFinished(
        Result<wake_core::services::laya_runtime::LayaExternalCapabilities, String>,
    ),
}

// ---------------- 会话列表 delegate ----------------

/// 336px 会话流在 14px 系统字体下约容纳 42 个西文显示单元；CJK 字符由
/// unicode-width 按两个单元计算。尾部每个状态图标再预留三个单元。
const SESSION_TITLE_MAX_WIDTH: usize = 42;
/// 会话流首批与后续每页的条数。列表组件会在距末尾 20 行时预取下一页。
const SESSION_PAGE_SIZE: i64 = 100;
static SESSION_PAGINATION_GENERATION: AtomicU64 = AtomicU64::new(1);
static JEV_CURL_FALLBACK_GENERATION: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, PartialEq, Eq)]
struct SessionGroup {
    label: SharedString,
    range: Range<usize>,
}

struct SessionPagination {
    store: Arc<Store>,
    filter: SessionFilter,
    total: i64,
    next_offset: i64,
    generation: u64,
    loading: bool,
    failed: bool,
}

fn session_group_timestamp(session: &SessionMeta, sort: SortKey) -> i64 {
    match sort {
        SortKey::Created => session.created_at,
        // Tokens 按用量排,日期分组没意义,归到 updated 桶只出单组
        SortKey::Updated | SortKey::Messages | SortKey::Tokens => session.updated_at,
    }
}

fn session_group_label(ts: i64, today: NaiveDate) -> SharedString {
    let Some(date) = Local
        .timestamp_millis_opt(ts)
        .single()
        .map(|dt| dt.date_naive())
    else {
        return t("Undated").into();
    };

    if date >= today {
        return t("Today").into();
    }
    if date == today.pred_opt().unwrap_or(today) {
        return t("Yesterday").into();
    }

    let week_start =
        today - chrono::Duration::days(i64::from(today.weekday().num_days_from_monday()));
    if date >= week_start {
        return t("Earlier this week").into();
    }
    if date.year() == today.year() {
        return date.format(t("%B")).to_string().into();
    }
    date.format(t("%B %Y")).to_string().into()
}

#[derive(Debug, Clone)]
struct SessionListRow {
    meta: SessionMeta,
    depth: u8,
    child_count: i64,
    expanded: bool,
    /// 子会话必须紧跟父会话，不能因自己的时间戳被拆进另一个日期 section。
    group_timestamp: i64,
    group_pinned: bool,
}

fn build_row_groups_at(
    rows: &[SessionListRow],
    sort: SortKey,
    ascending: bool,
    today: NaiveDate,
) -> Vec<SessionGroup> {
    let time_descending = !ascending && matches!(sort, SortKey::Updated | SortKey::Created);
    if rows.is_empty() || !time_descending {
        return vec![SessionGroup {
            label: "".into(),
            range: 0..rows.len(),
        }];
    }

    let mut groups = Vec::new();
    let pinned_count = rows.iter().take_while(|row| row.group_pinned).count();
    if pinned_count > 0 {
        groups.push(SessionGroup {
            label: t("Pinned").into(),
            range: 0..pinned_count,
        });
    }
    let mut start = pinned_count;
    while start < rows.len() {
        let label = session_group_label(rows[start].group_timestamp, today);
        let mut end = start + 1;
        while end < rows.len() && session_group_label(rows[end].group_timestamp, today) == label {
            end += 1;
        }
        groups.push(SessionGroup {
            label,
            range: start..end,
        });
        start = end;
    }
    groups
}

fn same_session_query(left: &SessionFilter, right: &SessionFilter) -> bool {
    left.agents == right.agents
        && left.project_paths == right.project_paths
        && left.tags == right.tags
        && left.models == right.models
        && left.updated_since == right.updated_since
        && left.ignore_pins == right.ignore_pins
        && left.favorite_only == right.favorite_only
        && left.include_archived == right.include_archived
        && left.roots_only == right.roots_only
        && left.title_query == right.title_query
        && left.sort == right.sort
        && left.ascending == right.ascending
}

fn session_matches_filter(session: &SessionMeta, filter: &SessionFilter) -> bool {
    (filter.agents.is_empty() || filter.agents.contains(&session.agent))
        && (filter.project_paths.is_empty() || filter.project_paths.contains(&session.project_path))
        && filter.tags.is_empty()
        && (filter.models.is_empty()
            || session
                .model
                .as_deref()
                .is_some_and(|m| filter.models.contains(&m.to_string())))
        && filter
            .updated_since
            .is_none_or(|since| session.updated_at >= since)
        && (!filter.favorite_only || session.favorite)
        && (filter.include_archived || !session.archived)
        && filter
            .title_query
            .as_deref()
            .map(str::trim)
            .filter(|query| !query.is_empty())
            .is_none_or(|query| {
                let query = query.to_lowercase();
                session.title.to_lowercase().contains(&query)
                    || session.project_name.to_lowercase().contains(&query)
            })
}

pub struct SessionsDelegate {
    /// 分页查询返回的根会话；next_offset 只能按它推进，展开的孩子不参与分页。
    pub sessions: Vec<SessionMeta>,
    rows: Vec<SessionListRow>,
    children: HashMap<String, Vec<SessionMeta>>,
    child_counts: HashMap<String, i64>,
    tags: HashMap<String, Vec<String>>,
    expanded: HashSet<String>,
    groups: Vec<SessionGroup>,
    grouped_on: NaiveDate,
    /// 取 `groups` 里那些标签时的语言代次(标签是译好的文本,不是 key)
    grouped_lang: u64,
    sort: SortKey,
    ascending: bool,
    pagination: Option<SessionPagination>,
}

impl SessionsDelegate {
    fn new(sessions: Vec<SessionMeta>, sort: SortKey, ascending: bool) -> Self {
        Self::new_at(sessions, sort, ascending, Local::now().date_naive())
    }

    fn new_at(
        sessions: Vec<SessionMeta>,
        sort: SortKey,
        ascending: bool,
        grouped_on: NaiveDate,
    ) -> Self {
        let mut delegate = Self {
            sessions,
            rows: Vec::new(),
            children: HashMap::new(),
            child_counts: HashMap::new(),
            tags: HashMap::new(),
            expanded: HashSet::new(),
            groups: Vec::new(),
            grouped_on,
            grouped_lang: crate::i18n::generation(),
            sort,
            ascending,
            pagination: None,
        };
        delegate.rebuild_rows_at(grouped_on);
        delegate
    }

    fn paged(
        sessions: Vec<SessionMeta>,
        filter: SessionFilter,
        total: i64,
        store: Arc<Store>,
    ) -> Self {
        let child_counts = if filter.roots_only {
            store.child_counts(&filter).unwrap_or_default()
        } else {
            HashMap::new()
        };
        let keys = sessions
            .iter()
            .map(|session| session.key.clone())
            .collect::<Vec<_>>();
        let tags = store.session_tags_for(&keys).unwrap_or_default();
        let mut delegate = Self::new(sessions, filter.sort, filter.ascending);
        delegate.child_counts = child_counts;
        delegate.tags = tags;
        delegate.pagination = Some(SessionPagination {
            store,
            total: total.max(0),
            next_offset: i64::try_from(delegate.sessions.len()).unwrap_or(i64::MAX),
            filter,
            generation: SESSION_PAGINATION_GENERATION.fetch_add(1, Ordering::Relaxed),
            loading: false,
            failed: false,
        });
        delegate.rebuild_rows();
        delegate
    }

    fn tree_mode(&self) -> bool {
        self.pagination
            .as_ref()
            .is_some_and(|page| page.filter.roots_only)
    }

    fn rebuild_rows(&mut self) {
        self.rebuild_rows_at(Local::now().date_naive());
    }

    fn rebuild_rows_at(&mut self, today: NaiveDate) {
        let tree_mode = self.tree_mode();
        let mut rows = Vec::new();
        for root in &self.sessions {
            let child_count = if tree_mode {
                self.child_counts.get(&root.key).copied().unwrap_or(0)
            } else {
                0
            };
            let expanded = child_count > 0 && self.expanded.contains(&root.key);
            let group_timestamp = session_group_timestamp(root, self.sort);
            let group_pinned = root.pinned;
            rows.push(SessionListRow {
                meta: root.clone(),
                depth: 0,
                child_count,
                expanded,
                group_timestamp,
                group_pinned,
            });
            if expanded {
                if let Some(children) = self.children.get(&root.key) {
                    rows.extend(children.iter().cloned().map(|child| SessionListRow {
                        meta: child,
                        depth: 1,
                        child_count: 0,
                        expanded: false,
                        group_timestamp,
                        group_pinned,
                    }));
                }
            }
        }
        self.rows = rows;
        self.groups = build_row_groups_at(&self.rows, self.sort, self.ascending, today);
        self.grouped_on = today;
    }

    fn rebuild_groups_at(&mut self, today: NaiveDate) -> bool {
        let lang = crate::i18n::generation();
        if self.grouped_on == today && self.grouped_lang == lang {
            return false;
        }
        self.grouped_lang = lang;
        let groups = build_row_groups_at(&self.rows, self.sort, self.ascending, today);
        let changed = groups != self.groups;
        self.groups = groups;
        self.grouped_on = today;
        changed
    }

    fn append_sessions(&mut self, page: Vec<SessionMeta>) {
        let mut keys: HashSet<String> = self
            .sessions
            .iter()
            .map(|session| session.key.clone())
            .collect();
        let added = page
            .into_iter()
            .filter(|session| keys.insert(session.key.clone()))
            .collect::<Vec<_>>();
        if let Some(pagination) = &self.pagination {
            let added_keys = added
                .iter()
                .map(|session| session.key.clone())
                .collect::<Vec<_>>();
            self.tags.extend(
                pagination
                    .store
                    .session_tags_for(&added_keys)
                    .unwrap_or_default(),
            );
            if pagination.filter.roots_only {
                self.child_counts = pagination
                    .store
                    .child_counts(&pagination.filter)
                    .unwrap_or_default();
            }
        }
        self.sessions.extend(added);
        self.rebuild_rows();
    }

    fn restore_expanded(&mut self, expanded: HashSet<String>) {
        if !self.tree_mode() {
            return;
        }
        let root_keys: HashSet<&str> = self.sessions.iter().map(|root| root.key.as_str()).collect();
        self.expanded = expanded
            .into_iter()
            .filter(|key| root_keys.contains(key.as_str()))
            .collect();
        self.reload_expanded();
    }

    fn reload_expanded(&mut self) {
        let Some(pagination) = &self.pagination else {
            return;
        };
        let store = pagination.store.clone();
        let filter = pagination.filter.clone();
        self.children.clear();
        for key in &self.expanded {
            if let Ok(children) = store.list_children(key, &filter) {
                let child_keys = children
                    .iter()
                    .map(|session| session.key.clone())
                    .collect::<Vec<_>>();
                self.tags
                    .extend(store.session_tags_for(&child_keys).unwrap_or_default());
                self.children.insert(key.clone(), children);
            }
        }
        self.rebuild_rows();
    }

    fn toggle(&mut self, key: &str) -> bool {
        if !self.tree_mode() || self.child_counts.get(key).copied().unwrap_or(0) == 0 {
            return false;
        }
        if self.expanded.remove(key) {
            self.children.remove(key);
        } else {
            let Some(pagination) = &self.pagination else {
                return false;
            };
            let Ok(children) = pagination.store.list_children(key, &pagination.filter) else {
                return false;
            };
            let child_keys = children
                .iter()
                .map(|session| session.key.clone())
                .collect::<Vec<_>>();
            self.tags.extend(
                pagination
                    .store
                    .session_tags_for(&child_keys)
                    .unwrap_or_default(),
            );
            self.expanded.insert(key.to_string());
            self.children.insert(key.to_string(), children);
        }
        self.rebuild_rows();
        true
    }

    fn ensure_expanded(&mut self, key: &str) -> bool {
        if self.expanded.contains(key) {
            return true;
        }
        self.toggle(key)
    }

    fn row_index(&self, key: &str) -> Option<usize> {
        self.rows.iter().position(|row| row.meta.key == key)
    }

    fn row_key(&self, ix: IndexPath) -> Option<&str> {
        self.flat_index(ix)
            .and_then(|flat| self.rows.get(flat))
            .map(|row| row.meta.key.as_str())
    }

    fn row_has_children(&self, key: &str) -> bool {
        self.child_counts.get(key).copied().unwrap_or(0) > 0
    }

    /// 把组件发出的分组坐标还原为可见 `rows` 的平铺下标。
    fn flat_index(&self, ix: IndexPath) -> Option<usize> {
        let group = self.groups.get(ix.section)?;
        let flat = group.range.start.checked_add(ix.row)?;
        (flat < group.range.end).then_some(flat)
    }

    /// 搜索/选择以可见 `rows` 平铺下标定位；进入列表前转成分组坐标。
    fn index_path(&self, flat: usize) -> Option<IndexPath> {
        self.groups
            .iter()
            .enumerate()
            .find(|(_, group)| group.range.contains(&flat))
            .map(|(section, group)| IndexPath::new(flat - group.range.start).section(section))
    }
}

impl ListDelegate for SessionsDelegate {
    type Item = ListItem;

    fn sections_count(&self, _cx: &App) -> usize {
        self.groups.len()
    }

    fn items_count(&self, section: usize, _cx: &App) -> usize {
        self.groups
            .get(section)
            .map(|group| group.range.len())
            .unwrap_or_default()
    }

    fn render_item(
        &mut self,
        ix: IndexPath,
        _window: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> Option<Self::Item> {
        let flat_ix = self.flat_index(ix)?;
        let row = self.rows.get(flat_ix)?.clone();
        let s = &row.meta;
        let theme = cx.theme();
        let shown_ts = session_group_timestamp(s, self.sort);
        let shown_time: SharedString = smart_time(shown_ts).into();
        let shown_tooltip: SharedString = abs_date(shown_ts).into();
        let title_tooltip: SharedString = s.title.clone().into();
        let show_chevron = self.tree_mode() && row.child_count > 0;
        let icon_width =
            3 * (usize::from(s.pinned) + usize::from(s.favorite) + usize::from(show_chevron));
        let title: SharedString =
            clip_display(&s.title, SESSION_TITLE_MAX_WIDTH.saturating_sub(icon_width)).into();
        let key = s.key.clone();
        let open_key = key.clone();
        let toggle_key = key.clone();
        let child_count = row.child_count;
        let expanded = row.expanded;
        let depth = row.depth;
        let row_tags = self.tags.get(&s.key).cloned().unwrap_or_default();
        let child_line_color = theme.muted_foreground.opacity(0.38);
        // 2px 线的中心与父行 15px Grok 图标的 11.5px 中轴一致。
        let child_line_left = SPACE_XS + px(6.5);

        Some(
            // 稳定元素身份必须是 session key：展开插入孩子后，IndexPath 会整体
            // 位移；继续拿下标当 id 会复用到另一会话的点击状态。
            ListItem::new(SharedString::from(key.clone()))
                .rounded(theme.radius)
                .mx(SPACE_SM)
                .child(
                    v_flex()
                        .id(SharedString::from(format!("session-row:{key}")))
                        .relative()
                        .w_full()
                        .px(SPACE_XS)
                        .py(SPACE_SM)
                        .gap(SPACE_XS)
                        .when(depth > 0, |this| {
                            this.pl(px(20.)).child(
                                div()
                                    .absolute()
                                    .left(child_line_left)
                                    .top(SPACE_SM)
                                    .bottom(SPACE_SM)
                                    .w(px(2.))
                                    .rounded_full()
                                    .bg(child_line_color),
                            )
                        })
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(move |this, _, window, cx| {
                                cx.stop_propagation();
                                let Some(flat) = this.delegate().row_index(&open_key) else {
                                    return;
                                };
                                let Some(path) = this.delegate().index_path(flat) else {
                                    return;
                                };
                                let already_selected = this
                                    .selected_index()
                                    .and_then(|selected| this.delegate().row_key(selected))
                                    == Some(open_key.as_str());
                                if already_selected && this.delegate().row_has_children(&open_key) {
                                    this.delegate_mut().toggle(&open_key);
                                    if let Some(new_path) = this
                                        .delegate()
                                        .row_index(&open_key)
                                        .and_then(|flat| this.delegate().index_path(flat))
                                    {
                                        this.set_selected_index(Some(new_path), window, cx);
                                    }
                                    cx.notify();
                                    return;
                                }
                                this.focus(window, cx);
                                this.set_selected_index(Some(path), window, cx);
                                cx.emit(ListEvent::Confirm(path));
                                cx.notify();
                            }),
                        )
                        .child(
                            h_flex()
                                .gap(px(6.))
                                .when(show_chevron, |this| {
                                    this.child(
                                        div()
                                            .id(SharedString::from(format!(
                                                "session-expand:{toggle_key}"
                                            )))
                                            .size(px(16.))
                                            .flex_shrink_0()
                                            .flex()
                                            .items_center()
                                            .justify_center()
                                            .rounded(px(4.))
                                            .cursor_pointer()
                                            .hover(|style| style.bg(theme.muted))
                                            .on_mouse_down(
                                                MouseButton::Left,
                                                cx.listener(move |this, _, window, cx| {
                                                    cx.stop_propagation();
                                                    let selected_key = this
                                                        .selected_index()
                                                        .and_then(|selected| {
                                                            this.delegate()
                                                                .row_key(selected)
                                                                .map(str::to_string)
                                                        });
                                                    if !this.delegate_mut().toggle(&toggle_key) {
                                                        return;
                                                    }
                                                    let selected_path = selected_key
                                                        .as_deref()
                                                        .and_then(|key| {
                                                            this.delegate().row_index(key).and_then(
                                                                |flat| {
                                                                    this.delegate().index_path(flat)
                                                                },
                                                            )
                                                        })
                                                        .or_else(|| {
                                                            this.delegate()
                                                                .row_index(&toggle_key)
                                                                .and_then(|flat| {
                                                                    this.delegate().index_path(flat)
                                                                })
                                                        });
                                                    this.set_selected_index(
                                                        selected_path,
                                                        window,
                                                        cx,
                                                    );
                                                    cx.notify();
                                                }),
                                            )
                                            .child(
                                                icon("icons/chevron-right.svg")
                                                    .with_size(px(13.))
                                                    .text_color(theme.muted_foreground)
                                                    .when(expanded, |icon| {
                                                        icon.rotate(Radians(
                                                            std::f32::consts::FRAC_PI_2,
                                                        ))
                                                    }),
                                            ),
                                    )
                                })
                                .child(
                                    div()
                                        .id(("session-title", flat_ix))
                                        .flex_1()
                                        .min_w_0()
                                        .overflow_hidden()
                                        .whitespace_nowrap()
                                        .text_size(FONT_BODY)
                                        .font_medium()
                                        .text_color(theme.foreground)
                                        .child(title)
                                        .tooltip(move |window, cx| {
                                            gpui_component::tooltip::Tooltip::new(
                                                title_tooltip.clone(),
                                            )
                                            .build(window, cx)
                                        }),
                                )
                                .when(s.pinned, |this| {
                                    this.child(
                                        icon("icons/pin-filled.svg")
                                            .with_size(px(11.))
                                            .text_color(theme.primary),
                                    )
                                })
                                .when(s.favorite, |this| {
                                    this.child(
                                        icon("icons/star-filled.svg")
                                            .with_size(px(11.))
                                            .text_color(rgb(crate::theme::STAR_YELLOW)),
                                    )
                                }),
                        )
                        .child(
                            h_flex()
                                .gap(ICON_TEXT_GAP)
                                .text_size(FONT_LABEL)
                                .text_color(theme.muted_foreground)
                                .child(
                                    img(s.agent.brand_icon(theme.mode.is_dark()))
                                        .size(px(15.))
                                        .flex_shrink_0(),
                                )
                                .child(badge(
                                    s.project_name.clone(),
                                    theme.muted,
                                    theme.muted_foreground,
                                ))
                                .when(!s.host.is_empty(), |this| {
                                    this.child(host_badge(&s.host, &theme))
                                })
                                .children(row_tags.into_iter().take(3).map(|tag| {
                                    outline_badge(
                                        format!("#{}", session_tag_label(&tag)),
                                        theme.primary,
                                    )
                                    .into_any_element()
                                }))
                                .when(show_chevron, |this| {
                                    this.child(
                                        div()
                                            .id(("session-child-count", flat_ix))
                                            .flex_shrink_0()
                                            .child(format!("{child_count}"))
                                            .tooltip(move |window, cx| {
                                                gpui_component::tooltip::Tooltip::new(crate::tp!(
                                                    "{} nested session",
                                                    "{} nested sessions",
                                                    child_count
                                                ))
                                                .build(window, cx)
                                            }),
                                    )
                                })
                                .child(div().flex_1())
                                .child(
                                    div()
                                        .id(("session-time", flat_ix))
                                        .flex_shrink_0()
                                        .child(shown_time)
                                        .tooltip(move |window, cx| {
                                            gpui_component::tooltip::Tooltip::new(
                                                shown_tooltip.clone(),
                                            )
                                            .build(window, cx)
                                        }),
                                ),
                        ),
                ),
        )
    }

    fn render_section_header(
        &mut self,
        section: usize,
        _window: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> Option<impl IntoElement> {
        let label = self.groups.get(section)?.label.clone();
        if label.is_empty() {
            return None;
        }
        Some(section_header_row(label, cx.theme()))
    }

    // 还有下一页时返回 true。失败后停住，等待用户刷新重建 delegate，
    // 避免触底重试风暴。
    fn has_more(&self, _cx: &App) -> bool {
        self.pagination
            .as_ref()
            .is_some_and(|page| !page.loading && !page.failed && page.next_offset < page.total)
    }

    fn load_more(&mut self, window: &mut Window, cx: &mut Context<ListState<Self>>) {
        let Some(page) = self.pagination.as_mut() else {
            return;
        };
        if page.loading || page.failed || page.next_offset >= page.total {
            return;
        }

        page.loading = true;
        let generation = page.generation;
        let query_offset = page.next_offset;
        let store = page.store.clone();
        let mut filter = page.filter.clone();
        filter.limit = SESSION_PAGE_SIZE;
        filter.offset = query_offset;

        let query = cx.background_spawn(async move { store.list_sessions(&filter) });
        cx.spawn_in(window, async move |this, cx| {
            let result = query.await;
            this.update(cx, |state, cx| {
                let delegate = state.delegate_mut();
                let Some(current) = delegate.pagination.as_mut() else {
                    return;
                };
                if current.generation != generation {
                    return;
                }
                current.loading = false;

                match result {
                    Ok((sessions, total)) => {
                        let received = i64::try_from(sessions.len()).unwrap_or(i64::MAX);
                        current.total = total.max(0);
                        let next_offset = if received == 0 {
                            current.total
                        } else {
                            query_offset.saturating_add(received).min(current.total)
                        };
                        // 搜索定位可能同时批量翻过更多页，较晚完成的单页请求
                        // 不能把它已经推进的 offset 倒退。
                        current.next_offset =
                            current.next_offset.max(next_offset).min(current.total);
                        delegate.append_sessions(sessions);
                    }
                    Err(_) => current.failed = true,
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    // 点击/回车走 ListEvent::Confirm(ix),无需自存选中态
    fn set_selected_index(
        &mut self,
        _ix: Option<IndexPath>,
        _window: &mut Window,
        _cx: &mut Context<ListState<Self>>,
    ) {
    }
}

#[cfg(test)]
mod session_group_tests {
    use std::collections::HashSet;
    use std::path::PathBuf;
    use std::sync::Arc;

    use chrono::{Local, NaiveDate, TimeZone as _};
    use gpui_component::IndexPath;
    use wake_core::adapters::AgentAdapter;
    use wake_core::db::Store;
    use wake_core::models::{
        AgentId, ParsedSession, ParsedTranscript, SessionFileRef, SessionFilter, SessionMeta,
        SortKey, ToolCallView,
    };

    use super::{
        clip_tool_text, load_visible_transcript, non_blank_tool_text, same_session_query,
        session_group_label, session_matches_filter, toggle_expanded_row, tool_cluster_heading,
        truncate_for_llm, visible_git_branch, SessionsDelegate, SESSION_PAGE_SIZE,
    };

    #[test]
    fn llm_input_limit_counts_characters_instead_of_utf8_bytes() {
        let text = "中文测试";

        assert_eq!(truncate_for_llm(text, 4), text);
        assert_eq!(
            truncate_for_llm(text, 3),
            "中文测\n\n[原始会话过长，已截断到前 3 字符。]"
        );
    }

    #[test]
    fn compression_strategy_editor_has_explicit_save_footer() {
        let source = include_str!("workbench.rs");
        let start = source
            .rfind("pub(crate) fn open_compression_strategy_form")
            .expect("compression strategy editor exists");
        let end = source[start..]
            .find("fn open_compression_tag_strategies_form")
            .map(|offset| start + offset)
            .expect("tag strategy editor follows compression strategy editor");
        let editor = &source[start..end];

        assert!(editor.contains("DialogFooter::new"));
        assert!(editor.contains("compression-strategy-cancel"));
        assert!(editor.contains("compression-strategy-save"));
    }

    struct FailingAdapter;

    impl AgentAdapter for FailingAdapter {
        fn agent(&self) -> AgentId {
            AgentId::Codex
        }

        fn list_session_files(&self) -> anyhow::Result<Vec<SessionFileRef>> {
            Ok(Vec::new())
        }

        fn parse_session(&self, _r: &SessionFileRef) -> anyhow::Result<ParsedSession> {
            Err(anyhow::anyhow!("unused session parser"))
        }

        fn parse_transcript(&self, _r: &SessionFileRef) -> anyhow::Result<ParsedTranscript> {
            Err(anyhow::anyhow!("broken transcript fixture"))
        }

        fn data_roots(&self) -> Vec<PathBuf> {
            vec![PathBuf::from("/tmp/wake-test")]
        }

        fn with_custom_root(&self, _dir: PathBuf) -> Box<dyn AgentAdapter> {
            Box::new(FailingAdapter)
        }
    }

    fn local_ms(year: i32, month: u32, day: u32) -> i64 {
        Local
            .with_ymd_and_hms(year, month, day, 12, 0, 0)
            .single()
            .expect("test date should be unambiguous in the local timezone")
            .timestamp_millis()
    }

    fn session(key: &str, updated_at: i64, pinned: bool) -> SessionMeta {
        SessionMeta {
            key: key.to_string(),
            id: key.to_string(),
            host: String::new(),
            agent: AgentId::Codex,
            title: key.to_string(),
            project_path: "/tmp/wake-test".to_string(),
            project_name: "wake-test".to_string(),
            file_path: "/tmp/wake-test/session.jsonl".to_string(),
            created_at: updated_at,
            updated_at,
            message_count: 1,
            size_bytes: 1,
            git_branch: None,
            model: None,
            tokens_used: None,
            archived: false,
            source: None,
            favorite: false,
            pinned,
        }
    }

    fn tool_call(name: &str, input_preview: &str) -> ToolCallView {
        ToolCallView {
            id: name.to_string(),
            name: name.to_string(),
            input_preview: input_preview.to_string(),
            input: Some(input_preview.to_string()),
            output: None,
            is_error: false,
            sidechain_ref: None,
        }
    }

    #[test]
    fn cleanup_preview_completes_both_loads_of_the_same_session() {
        for preview_first in [false, true] {
            let mut current = Some(super::DetailState::loading(session("same", 0, false), None));
            let library_load = current.as_ref().unwrap().load_id;
            // Enter cleanup before the library transcript finishes, then preview it.
            let mut saved = current.take();
            current = Some(super::DetailState::loading(session("same", 0, false), None));
            let preview_load = current.as_ref().unwrap().load_id;
            let completions = if preview_first {
                [preview_load, library_load]
            } else {
                [library_load, preview_load]
            };
            for load_id in completions {
                super::detail_for_load(&mut current, &mut saved, "same", load_id)
                    .unwrap()
                    .loading = false;
            }
            assert!(!current.as_ref().unwrap().loading);
            // The cleanup toggle restores the original library state.
            current = saved.take();
            assert!(
                !current.as_ref().unwrap().loading,
                "Library reader stayed loading"
            );
        }
    }

    #[test]
    fn replaced_detail_ignores_an_older_load_of_the_same_session() {
        let old = super::DetailState::loading(session("same", 0, false), None);
        let mut current = Some(super::DetailState::loading(
            session("same", 0, false),
            Some(12),
        ));
        let mut saved = None;
        assert!(super::detail_for_load(&mut current, &mut saved, "same", old.load_id).is_none());
        assert_eq!(current.as_ref().unwrap().jump_seq, Some(12));
    }

    #[test]
    fn date_labels_respect_calendar_week_boundaries() {
        let wednesday = NaiveDate::from_ymd_opt(2026, 9, 2).unwrap();
        assert_eq!(
            session_group_label(local_ms(2026, 9, 1), wednesday),
            "Yesterday"
        );
        assert_eq!(
            session_group_label(local_ms(2026, 8, 31), wednesday),
            "Earlier this week"
        );
        assert_eq!(
            session_group_label(local_ms(2026, 8, 30), wednesday),
            "August"
        );

        let monday = NaiveDate::from_ymd_opt(2026, 9, 7).unwrap();
        assert_eq!(
            session_group_label(local_ms(2026, 9, 6), monday),
            "Yesterday"
        );
        assert_eq!(
            session_group_label(local_ms(2026, 9, 5), monday),
            "September"
        );
    }

    #[test]
    fn time_descending_groups_pinned_and_calendar_ranges() {
        let sessions = vec![
            session("pinned", local_ms(2025, 1, 1), true),
            session("today", local_ms(2026, 9, 2), false),
            session("yesterday", local_ms(2026, 9, 1), false),
            session("week", local_ms(2026, 8, 31), false),
            session("month", local_ms(2026, 8, 30), false),
        ];
        let delegate = SessionsDelegate::new_at(
            sessions,
            SortKey::Updated,
            false,
            NaiveDate::from_ymd_opt(2026, 9, 2).unwrap(),
        );
        let groups = &delegate.groups;

        let labels: Vec<&str> = groups.iter().map(|group| group.label.as_ref()).collect();
        assert_eq!(
            labels,
            [
                "Pinned",
                "Today",
                "Yesterday",
                "Earlier this week",
                "August"
            ]
        );
        assert_eq!(groups[0].range, 0..1);
        assert_eq!(groups[3].range, 3..4);

        assert_eq!(delegate.flat_index(IndexPath::new(0).section(3)), Some(3));
        assert_eq!(delegate.index_path(4), Some(IndexPath::new(0).section(4)));
    }

    #[test]
    fn non_time_descending_sorts_stay_flat() {
        let sessions = vec![
            session("one", local_ms(2026, 9, 2), false),
            session("two", local_ms(2026, 9, 1), false),
        ];
        for (sort, ascending) in [(SortKey::Messages, false), (SortKey::Updated, true)] {
            let delegate = SessionsDelegate::new_at(
                sessions.clone(),
                sort,
                ascending,
                NaiveDate::from_ymd_opt(2026, 9, 2).unwrap(),
            );
            let groups = &delegate.groups;
            assert_eq!(groups.len(), 1);
            assert!(groups[0].label.is_empty());
            assert_eq!(groups[0].range, 0..2);
        }
    }

    #[test]
    fn appended_pages_deduplicate_and_rebuild_flat_indexes() {
        let one = session("one", local_ms(2026, 9, 2), false);
        let duplicate = one.clone();
        let two = session("two", local_ms(2026, 9, 1), false);
        let mut delegate = SessionsDelegate::new(vec![one], SortKey::Messages, false);

        delegate.append_sessions(vec![duplicate, two]);

        assert_eq!(delegate.sessions.len(), 2);
        assert_eq!(delegate.sessions[0].key, "one");
        assert_eq!(delegate.sessions[1].key, "two");
        assert_eq!(delegate.groups[0].range, 0..2);
        assert_eq!(delegate.index_path(1), Some(IndexPath::new(1)));
    }

    #[test]
    fn tree_delegate_expands_children_without_changing_root_pagination() {
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(&temp.path().join("tree.db")).unwrap());
        let mut parent = session("grok:parent", local_ms(2026, 9, 1), false);
        parent.agent = AgentId::Grok;
        parent.file_path = "/tmp/grok/parent/updates.jsonl".into();
        let mut child = session("grok:child", local_ms(2026, 9, 2), false);
        child.agent = AgentId::Grok;
        child.file_path = "/tmp/grok/child/updates.jsonl".into();
        let mut other = session("grok:other", local_ms(2026, 8, 31), false);
        other.agent = AgentId::Grok;
        other.file_path = "/tmp/grok/other/updates.jsonl".into();
        store
            .write_meta_only(&[
                (parent.clone(), parent.updated_at),
                (child.clone(), child.updated_at),
                (other.clone(), other.updated_at),
            ])
            .unwrap();
        store
            .replace_parent_links(AgentId::Grok, &[(child.key.clone(), parent.key.clone())])
            .unwrap();
        let filter = SessionFilter {
            roots_only: true,
            sort: SortKey::Messages,
            limit: SESSION_PAGE_SIZE,
            ..Default::default()
        };
        let (roots, total) = store.list_sessions(&filter).unwrap();
        let mut delegate = SessionsDelegate::paged(roots, filter, total, store);

        assert_eq!(delegate.sessions.len(), 2);
        assert_eq!(delegate.rows.len(), 2);
        assert_eq!(delegate.rows[0].child_count, 1);
        assert_eq!(delegate.row_index(&other.key), Some(1));
        assert!(delegate.toggle(&parent.key));
        assert_eq!(
            delegate.sessions.len(),
            2,
            "children must not advance pagination"
        );
        assert_eq!(delegate.rows.len(), 3);
        assert_eq!(delegate.rows[0].meta.key, parent.key);
        assert_eq!(delegate.rows[1].meta.key, child.key);
        assert_eq!(delegate.rows[1].depth, 1);
        assert_eq!(delegate.index_path(1), Some(IndexPath::new(1)));
        assert_eq!(delegate.row_index(&other.key), Some(2));
        assert!(delegate.toggle(&parent.key));
        assert_eq!(delegate.rows.len(), 2);
        assert_eq!(delegate.row_index(&other.key), Some(1));
    }

    #[test]
    fn date_change_rebuilds_groups_and_stable_indexes() {
        let september_second = NaiveDate::from_ymd_opt(2026, 9, 2).unwrap();
        let september_third = NaiveDate::from_ymd_opt(2026, 9, 3).unwrap();
        let sessions = vec![
            session("recent", local_ms(2026, 9, 2), false),
            session("older", local_ms(2026, 9, 1), false),
        ];
        let mut delegate =
            SessionsDelegate::new_at(sessions, SortKey::Updated, false, september_second);

        assert_eq!(delegate.groups[0].label.as_ref(), "Today");
        assert!(delegate.rebuild_groups_at(september_third));
        assert_eq!(delegate.groups[0].label.as_ref(), "Yesterday");
        assert_eq!(delegate.groups[1].label.as_ref(), "Earlier this week");
        assert_eq!(delegate.index_path(1), Some(IndexPath::new(0).section(1)));
        assert!(!delegate.rebuild_groups_at(september_third));
    }

    #[test]
    fn refresh_query_comparison_ignores_only_page_extent() {
        let mut current = SessionFilter {
            limit: SESSION_PAGE_SIZE,
            ..Default::default()
        };
        let mut reloaded = current.clone();
        reloaded.limit = SESSION_PAGE_SIZE * 3;
        reloaded.offset = SESSION_PAGE_SIZE * 2;
        assert!(same_session_query(&current, &reloaded));

        current.favorite_only = true;
        assert!(!same_session_query(&current, &reloaded));
    }

    #[test]
    fn archived_search_hits_are_not_visible_in_active_list() {
        let mut archived = session("archived", local_ms(2026, 9, 2), false);
        archived.archived = true;
        let active_filter = SessionFilter::default();
        assert!(!session_matches_filter(&archived, &active_filter));

        let archived_filter = SessionFilter {
            include_archived: true,
            ..Default::default()
        };
        assert!(session_matches_filter(&archived, &archived_filter));
    }

    #[test]
    fn meaningless_git_branches_are_hidden() {
        assert_eq!(visible_git_branch(None), None);
        assert_eq!(visible_git_branch(Some("")), None);
        assert_eq!(visible_git_branch(Some(" HEAD ")), None);
        assert_eq!(visible_git_branch(Some("detached")), None);
        assert_eq!(visible_git_branch(Some("(detached HEAD)")), None);
        assert_eq!(
            visible_git_branch(Some("feature/session-detail")),
            Some("feature/session-detail")
        );
    }

    #[test]
    fn detail_load_reports_missing_adapter_and_parse_reason() {
        let meta = session("broken", local_ms(2026, 9, 2), false);

        let missing = load_visible_transcript(&[], &meta).expect_err("adapter should be missing");
        assert!(missing.contains("No Codex adapter"));

        let adapters: Vec<Box<dyn AgentAdapter>> = vec![Box::new(FailingAdapter)];
        let parse_error = load_visible_transcript(&adapters, &meta)
            .expect_err("fixture transcript should fail to parse");
        assert!(parse_error.contains("broken transcript fixture"));
    }

    #[test]
    fn thinking_and_tools_keep_independent_expansion_state() {
        let mut thinking = HashSet::new();
        let mut tools = HashSet::new();

        toggle_expanded_row(&mut thinking, 4);
        assert!(thinking.contains(&4));
        assert!(!tools.contains(&4));

        toggle_expanded_row(&mut tools, 4);
        assert!(thinking.contains(&4));
        assert!(tools.contains(&4));

        toggle_expanded_row(&mut thinking, 4);
        assert!(!thinking.contains(&4));
        assert!(tools.contains(&4));
    }

    #[test]
    fn tool_summaries_use_unicode_width_and_long_sections_are_marked() {
        let calls = vec![tool_call("Bash", "搜索中文项目路径")];
        let (name, argument) = tool_cluster_heading(&calls, 8);
        assert_eq!(name.as_ref(), "Bash");
        assert_eq!(
            argument.as_ref().map(|value| value.as_ref()),
            Some("搜索中…")
        );

        let (shown, truncated) = clip_tool_text("abcdef", 3);
        assert_eq!(shown, "abc…");
        assert!(truncated);

        let (shown, truncated) = clip_tool_text("abc", 3);
        assert_eq!(shown, "abc");
        assert!(!truncated);
    }

    #[test]
    fn tool_copy_source_preserves_edge_whitespace() {
        let original = "\n  result  \n";
        assert_eq!(non_blank_tool_text(original), Some(original));
        assert_eq!(non_blank_tool_text(" \n\t "), None);
    }
}

// ---------------- 搜索面板 delegate ----------------

pub struct SearchDelegate {
    pub hits: Vec<SearchHit>,
    pub degraded: bool,
    store: Arc<Store>,
    last_query: String,
}

impl ListDelegate for SearchDelegate {
    type Item = ListItem;

    fn items_count(&self, _section: usize, _cx: &App) -> usize {
        self.hits.len()
    }

    fn render_item(
        &mut self,
        ix: IndexPath,
        _window: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> Option<Self::Item> {
        let h = self.hits.get(ix.row)?;
        let theme = cx.theme();
        let timestamp = h.timestamp.unwrap_or(0);
        let hit_time: SharedString = smart_time(timestamp).into();
        let hit_time_tooltip: SharedString = abs_date(timestamp).into();
        let snippet = h
            .snippet
            .replace(HL_OPEN, "「")
            .replace(HL_CLOSE, "」")
            .replace('\n', " ");
        Some(
            // ListItem 无默认 margin,行块与内容区同宽(胶囊边对齐 Scope 行/
            // 输入行);块内文字缩进保持组件默认(px_3)+ 内容 px_2
            ListItem::new(ix.row).rounded(theme.radius).child(
                v_flex()
                    .w_full()
                    .px(SPACE_SM)
                    .py(SPACE_SM)
                    .gap(px(6.))
                    .child(
                        h_flex()
                            .gap(ICON_TEXT_GAP)
                            .text_size(FONT_CAPTION)
                            .child(
                                img(h.session.agent.brand_icon(theme.mode.is_dark()))
                                    .size(px(15.))
                                    .flex_shrink_0(),
                            )
                            .child(
                                div()
                                    .min_w_0()
                                    .font_medium()
                                    .text_color(theme.foreground)
                                    .truncate()
                                    .child(h.session.title.clone()),
                            )
                            .child(div().flex_1())
                            .when(!h.session.host.is_empty(), |this| {
                                this.child(host_badge(&h.session.host, &theme))
                            })
                            .child(
                                div()
                                    .id(("search-hit-time", ix.row))
                                    .flex_shrink_0()
                                    .text_size(FONT_CAPTION)
                                    .text_color(theme.muted_foreground)
                                    .child(format!("{} · {}", h.session.project_name, hit_time))
                                    .tooltip(move |window, cx| {
                                        gpui_component::tooltip::Tooltip::new(
                                            hit_time_tooltip.clone(),
                                        )
                                        .build(window, cx)
                                    }),
                            ),
                    )
                    .child(
                        div()
                            .text_size(FONT_CAPTION)
                            .text_color(theme.muted_foreground)
                            .truncate()
                            .child(snippet),
                    ),
            ),
        )
    }

    fn set_selected_index(
        &mut self,
        _ix: Option<IndexPath>,
        _window: &mut Window,
        _cx: &mut Context<ListState<Self>>,
    ) {
    }

    fn perform_search(
        &mut self,
        query: &str,
        window: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> gpui::Task<()> {
        let q = query.to_string();
        self.last_query = q.clone();
        let store = self.store.clone();
        let bg = cx.background_spawn(async move {
            if q.trim().is_empty() {
                (Vec::new(), false)
            } else {
                store
                    .search(&q, &[], None, 60)
                    .unwrap_or((Vec::new(), false))
            }
        });
        cx.spawn_in(window, async move |this, cx| {
            let (hits, degraded) = bg.await;
            this.update(cx, |state, cx| {
                let d = state.delegate_mut();
                d.hits = hits;
                d.degraded = degraded;
                cx.notify();
            })
            .ok();
        })
    }

    // 查询为空时的引导页也走这里:搜索框已拆出 List 自管(searchable(false)),
    // ListState 不再有 query_input,render_initial 永不触发
    fn render_empty(
        &mut self,
        _window: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> impl IntoElement {
        let theme = cx.theme();
        if self.last_query.trim().is_empty() {
            return v_flex()
                .h(px(250.))
                .w_full()
                .justify_center()
                .child(empty_state(
                    "icons/search.svg",
                    px(48.),
                    px(22.),
                    t("Search full conversation text"),
                    t("Matches natural language and code, like \"useEffect(\"."),
                    cx,
                ));
        }
        v_flex()
            .h(px(250.))
            .w_full()
            .items_center()
            .justify_center()
            .gap(SPACE_MD)
            .text_color(theme.muted_foreground)
            .child(icon("icons/inbox.svg").with_size(px(24.)))
            .child(
                div()
                    .text_size(FONT_BODY)
                    .font_medium()
                    .child(crate::tf!("No results for \"{}\"", self.last_query)),
            )
            .child(
                div()
                    .text_size(FONT_CAPTION)
                    .child(t("Try a different or shorter query.")),
            )
    }

    fn render_section_header(
        &mut self,
        _section: usize,
        _window: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> Option<impl IntoElement> {
        if !self.degraded {
            return None;
        }
        Some(
            div()
                .px(SPACE_SM)
                .pb(SPACE_XS)
                .text_size(FONT_LABEL)
                .text_color(cx.theme().muted_foreground)
                .child(t(
                    "Short query — using fallback search. Longer keywords are faster.",
                )),
        )
    }
}

// ---------------- 详情状态 ----------------

fn visible_git_branch(branch: Option<&str>) -> Option<&str> {
    let branch = branch?.trim();
    let normalized = branch.trim_matches(['(', ')']).trim();
    (!normalized.is_empty()
        && !normalized.eq_ignore_ascii_case("head")
        && !normalized.eq_ignore_ascii_case("detached")
        && !normalized.eq_ignore_ascii_case("detached head"))
    .then_some(branch)
}

fn load_visible_transcript(
    adapters: &[Box<dyn AgentAdapter>],
    meta: &SessionMeta,
) -> Result<
    (
        Vec<TranscriptMessage>,
        Vec<wake_core::models::SessionUsageEvent>,
    ),
    String,
> {
    // adapter_for 按文件路径挑实例：自定义 location 的会话必须由拥有其根的
    // 实例解析；完全找不到对应 agent 时保留可读错误，不再静默变成空详情。
    let adapter = adapter_for(adapters, meta.agent, &meta.file_path).ok_or_else(|| {
        crate::tf!(
            "No {} adapter is available for this session path.",
            meta.agent.display_name()
        )
    })?;
    let session_ref = SessionFileRef::from_meta(meta);
    let transcript = adapter.parse_transcript(&session_ref).map_err(|error| {
        crate::tf!(
            "Failed to parse {} session data: {}",
            meta.agent.display_name(),
            format!("{error:#}")
        )
    })?;

    let ParsedTranscript {
        mainline,
        usage_events,
        ..
    } = transcript;
    Ok((
        mainline
            .into_iter()
            .filter(|message| {
                message.kind != MessageKind::Meta
                    && (!message.text.trim().is_empty()
                        || !message.tool_calls.is_empty()
                        || message.thinking.is_some()
                        || !message.images.is_empty()
                        || message.kind == MessageKind::CompactSummary)
            })
            .collect(),
        usage_events,
    ))
}

fn toggle_expanded_row(rows: &mut HashSet<usize>, ix: usize) {
    if !rows.insert(ix) {
        rows.remove(&ix);
    }
}

const SESSION_TAGS: &[&str] = &[
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

const SESSION_RELATIONS: &[&str] = &["continues", "branches", "blocks", "resolves", "related"];

fn session_tag_label(tag: &str) -> &'static str {
    match tag {
        "development" => "开发",
        "design" => "设计",
        "testing" => "测试",
        "research" => "研究",
        "refactor" => "重构",
        "bugfix" => "修复",
        "product-decision" => "产品决策",
        "paused" => "暂停",
        "completed" => "已完成",
        "continue-later" => "稍后继续",
        _ => "标签",
    }
}

fn session_relation_label(relation: &str) -> &'static str {
    match relation {
        "continues" => "继续",
        "branches" => "分支",
        "blocks" => "阻塞",
        "resolves" => "解决",
        "related" => "相关",
        _ => "关系",
    }
}

fn session_relation_icon(relation: &str) -> &'static str {
    match relation {
        "continues" => "icons/chevron-right.svg",
        "branches" => "icons/git-branch.svg",
        "blocks" => "icons/circle-x.svg",
        "resolves" => "icons/check.svg",
        "related" => "icons/link.svg",
        _ => "icons/link.svg",
    }
}

struct DetailState {
    load_id: u64,
    meta: SessionMeta,
    tags: HashSet<String>,
    link_parent_count: i64,
    link_child_count: i64,
    link_parents: Vec<SessionRelation>,
    link_children: Vec<SessionRelation>,
    link_parent_tree: Vec<SessionRelationNode>,
    link_child_tree: Vec<SessionRelationNode>,
    /// Resolved in the background independently of the transcript; None while pending.
    source_path: Option<String>,
    /// Its lifetime is also the inline copy feedback; copying again resets the timer.
    copy_path_reset: Option<Task<()>>,
    /// 过滤后的可见消息。Rc 让行渲染以引用计数克隆代替整条消息深拷贝
    transcript: Rc<Vec<TranscriptMessage>>,
    loading: bool,
    /// 详情解析的具体失败原因；None 表示加载中或成功。
    error: Option<SharedString>,
    /// 逐消息不等高列表(gpui 原生 ListState,惰性测量)
    msg_list: gpui::ListState,
    /// 轮次模型：右侧目录和主阅读区筛选都从这里派生。
    reader_turns: Vec<DetailTurn>,
    /// 当前筛选下，ListState 行下标到原始 transcript 下标的映射。
    reader_visible_indices: Vec<usize>,
    /// 展开的工具簇(按消息在 transcript 里的下标)
    expanded_tools: HashSet<usize>,
    /// 展开的 Thinking。与工具簇分开存，避免其中一个把另一个一起展开。
    expanded_thinking: HashSet<usize>,
    /// 搜索跳转目标(FTS seq,契约=消息 seq);解析完成后滚到该消息并保持高亮
    jump_seq: Option<i64>,
    /// 当前会话内搜索命中消息；搜索只改变阅读定位，不改变源会话。
    search_matches: Vec<usize>,
    search_cursor: usize,
    /// 与 transcript 同下标；原始字节只保留在 Arc<Image> 内，避免双份内存。
    images: Vec<Vec<ImageSlot>>,
    /// 放大预览中的图片：(消息下标, 消息内图片下标)。
    zoom: Option<(usize, usize)>,
    /// 放大预览操作的短暂就地反馈。绑定具体图片，避免切换预览后把上一张的
    /// 成功状态带过来；generation 让较早的复位计时器不能清掉较新的反馈。
    image_action_feedback: [Option<ImageActionFeedback>; 2],
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum DetailOutlineMode {
    All,
    Conversation,
    Changes,
}

#[derive(Clone, Default)]
struct DetailTurn {
    index: usize,
    question: Option<usize>,
    reply: Option<usize>,
    step_messages: Vec<usize>,
    changed_messages: Vec<usize>,
    tokens_used: i64,
    request_count: usize,
}

fn build_detail_turns(
    messages: &[TranscriptMessage],
    usage_events: &[wake_core::models::SessionUsageEvent],
) -> Vec<DetailTurn> {
    let mut turns = Vec::new();
    for (index, message) in messages.iter().enumerate() {
        if message.role == MessageRole::User {
            turns.push(DetailTurn {
                index: turns.len(),
                question: Some(index),
                ..Default::default()
            });
        } else if turns.is_empty() {
            turns.push(DetailTurn {
                index: 0,
                ..Default::default()
            });
        }
        let turn = turns.last_mut().expect("detail turn exists");
        if message.role == MessageRole::Assistant {
            if !message.text.trim().is_empty() {
                turn.reply = Some(index);
            }
            if !message.tool_calls.is_empty() || message.thinking.is_some() {
                turn.step_messages.push(index);
            }
            if transcript_message_is_change(message) {
                turn.changed_messages.push(index);
            }
        }
    }
    let question_indices = turns
        .iter()
        .map(|turn| turn.question.unwrap_or(0))
        .collect::<Vec<_>>();
    let turn_starts = turns
        .iter()
        .enumerate()
        .map(|(turn_index, turn)| {
            turn.question
                .and_then(|index| messages.get(index))
                .and_then(|message| message.timestamp)
                .or_else(|| {
                    let start_index = question_indices[turn_index];
                    let end_index = question_indices
                        .get(turn_index + 1)
                        .copied()
                        .unwrap_or(messages.len());
                    messages[start_index..end_index]
                        .iter()
                        .find_map(|message| message.timestamp)
                })
        })
        .collect::<Vec<_>>();
    for turn_index in 0..turns.len() {
        let start = turn_starts[turn_index];
        let end = turn_starts.get(turn_index + 1).copied().flatten();
        let Some(start) = start else { continue };
        for event in usage_events {
            let Some(timestamp) = event.timestamp else {
                continue;
            };
            if timestamp >= start && end.is_none_or(|end| timestamp < end) {
                let turn = &mut turns[turn_index];
                turn.tokens_used = turn.tokens_used.saturating_add(event.tokens_used);
                turn.request_count = turn.request_count.saturating_add(1);
            }
        }
    }
    turns
}

fn detail_visible_indices(
    messages: &[TranscriptMessage],
    turns: &[DetailTurn],
    mode: DetailOutlineMode,
) -> Vec<usize> {
    match mode {
        DetailOutlineMode::All => (0..messages.len()).collect(),
        DetailOutlineMode::Conversation => turns
            .iter()
            .flat_map(|turn| turn.question.into_iter().chain(turn.reply))
            .collect(),
        DetailOutlineMode::Changes => turns
            .iter()
            .flat_map(|turn| {
                turn.question
                    .into_iter()
                    .chain(turn.changed_messages.iter().copied())
            })
            .collect(),
    }
}

fn rebuild_detail_reader_view(detail: &mut DetailState, mode: DetailOutlineMode) {
    detail.reader_visible_indices =
        detail_visible_indices(&detail.transcript, &detail.reader_turns, mode);
    detail.msg_list = gpui::ListState::new(
        detail.reader_visible_indices.len(),
        gpui::ListAlignment::Bottom,
        px(512.),
    );
}

fn transcript_message_is_change(message: &TranscriptMessage) -> bool {
    message.tool_calls.iter().any(|call| {
        let name = call.name.to_ascii_lowercase();
        let input = call.input.as_deref().unwrap_or_default();
        let output = call.output.as_deref().unwrap_or_default();
        (name == "edit"
            || name == "write"
            || name.ends_with(".edit")
            || name.ends_with(".write")
            || name.contains("apply_patch")
            || name.contains("file_change"))
            || input.contains("*** Begin Patch")
            || input.contains("diff --git")
            || output.contains("*** Begin Patch")
            || output.contains("diff --git")
    })
}

fn tool_call_is_change(call: &ToolCallView) -> bool {
    let name = call.name.to_ascii_lowercase();
    let input = call.input.as_deref().unwrap_or_default();
    let output = call.output.as_deref().unwrap_or_default();
    (name == "edit"
        || name == "write"
        || name.ends_with(".edit")
        || name.ends_with(".write")
        || name.contains("apply_patch")
        || name.contains("file_change"))
        || input.contains("*** Begin Patch")
        || input.contains("diff --git")
        || output.contains("*** Begin Patch")
        || output.contains("diff --git")
}

fn transcript_message_matches(message: &TranscriptMessage, query: &str) -> bool {
    message.text.to_lowercase().contains(query)
        || message
            .thinking
            .as_deref()
            .is_some_and(|text| text.to_lowercase().contains(query))
        || message.tool_calls.iter().any(|call| {
            call.name.to_lowercase().contains(query)
                || call.input_preview.to_lowercase().contains(query)
                || call
                    .input
                    .as_deref()
                    .is_some_and(|text| text.to_lowercase().contains(query))
                || call
                    .output
                    .as_deref()
                    .is_some_and(|text| text.to_lowercase().contains(query))
        })
}

impl DetailState {
    fn loading(meta: SessionMeta, jump_seq: Option<i64>) -> Self {
        static NEXT_LOAD: AtomicU64 = AtomicU64::new(0);
        Self {
            load_id: NEXT_LOAD.fetch_add(1, Ordering::Relaxed),
            source_path: None,
            copy_path_reset: None,
            meta,
            tags: HashSet::new(),
            link_parent_count: 0,
            link_child_count: 0,
            link_parents: Vec::new(),
            link_children: Vec::new(),
            link_parent_tree: Vec::new(),
            link_child_tree: Vec::new(),
            transcript: Rc::new(Vec::new()),
            loading: true,
            error: None,
            // Bottom 对齐 = 聊天语义:打开落在最新消息,向上翻历史
            msg_list: gpui::ListState::new(0, gpui::ListAlignment::Bottom, px(512.)),
            reader_turns: Vec::new(),
            reader_visible_indices: Vec::new(),
            expanded_tools: HashSet::new(),
            expanded_thinking: HashSet::new(),
            jump_seq,
            search_matches: Vec::new(),
            search_cursor: 0,
            images: Vec::new(),
            zoom: None,
            image_action_feedback: [None; 2],
        }
    }
}

fn detail_for_load<'a>(
    current: &'a mut Option<DetailState>,
    saved: &'a mut Option<DetailState>,
    key: &str,
    load_id: u64,
) -> Option<&'a mut DetailState> {
    // Library and cleanup may load the same session concurrently. The response
    // belongs to the state that started it, even after that state moves slots.
    current
        .as_mut()
        .filter(|detail| detail.meta.key == key && detail.load_id == load_id)
        .or_else(|| {
            saved
                .as_mut()
                .filter(|detail| detail.meta.key == key && detail.load_id == load_id)
        })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ImageAction {
    Copy,
    Save,
}

impl ImageAction {
    const fn index(self) -> usize {
        match self {
            Self::Copy => 0,
            Self::Save => 1,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct ImageActionFeedback {
    target: (usize, usize),
    action: ImageAction,
    generation: u64,
}

#[derive(Clone)]
enum ImageSlot {
    Ready {
        image: Arc<gpui::Image>,
        dims: Option<(u32, u32)>,
        text_offset: usize,
    },
    Unsupported {
        media_type: SharedString,
        bytes: Arc<Vec<u8>>,
        text_offset: usize,
    },
    Omitted {
        text_offset: usize,
    },
}

impl ImageSlot {
    fn text_offset(&self) -> usize {
        match self {
            Self::Ready { text_offset, .. }
            | Self::Unsupported { text_offset, .. }
            | Self::Omitted { text_offset } => *text_offset,
        }
    }
}

fn take_image_slots(messages: &mut [TranscriptMessage]) -> Vec<Vec<ImageSlot>> {
    const TRANSCRIPT_IMAGE_BYTES: usize = 64 * 1024 * 1024;
    const TRANSCRIPT_DECODED_PIXELS: u64 = 96_000_000;
    let mut remaining_bytes = TRANSCRIPT_IMAGE_BYTES;
    let mut remaining_pixels = TRANSCRIPT_DECODED_PIXELS;

    messages
        .iter_mut()
        .map(|message| {
            std::mem::take(&mut message.images)
                .into_iter()
                .map(|attachment| {
                    let text_offset = attachment.text_offset.min(message.text.len());
                    if attachment.bytes.len() > remaining_bytes {
                        return ImageSlot::Omitted { text_offset };
                    }
                    remaining_bytes -= attachment.bytes.len();
                    match image_format_of(&attachment.media_type).and_then(|format| {
                        image_probe(&attachment.bytes, format).map(|probe| (format, probe))
                    }) {
                        Some((format, probe)) if probe.decoded_pixels <= remaining_pixels => {
                            remaining_pixels -= probe.decoded_pixels;
                            ImageSlot::Ready {
                                image: Arc::new(gpui::Image::from_bytes(format, attachment.bytes)),
                                dims: Some(probe.dims),
                                text_offset,
                            }
                        }
                        _ => ImageSlot::Unsupported {
                            media_type: attachment.media_type.into(),
                            bytes: Arc::new(attachment.bytes),
                            text_offset,
                        },
                    }
                })
                .collect()
        })
        .collect()
}

#[cfg(test)]
mod detail_selection_tests {
    use std::time::Duration;

    use super::image_probe;
    use gpui::{
        div, list, point, px, AppContext as _, Context, Element as _, InteractiveElement as _,
        IntoElement, ListAlignment, ListState, Modifiers, MouseButton, MouseMoveEvent,
        ParentElement as _, Render, Styled as _, TestAppContext, VisualTestContext, Window,
    };
    use gpui_component::{scroll::AutoScroll, text::TextView, Root, WindowExt as _};

    struct VirtualMessageList {
        list: ListState,
    }

    struct AutoScrollingVirtualMessageList {
        list: ListState,
        auto_scroll: AutoScroll,
    }

    impl Render for VirtualMessageList {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            list(self.list.clone(), |ix, _, _| {
                let text = if ix == 0 {
                    "First message"
                } else {
                    "Second message"
                };
                div()
                    .h(px(60.))
                    .w_full()
                    .child(TextView::markdown(("selection-message", ix), text).selectable(true))
                    .into_any()
            })
            .size_full()
        }
    }

    impl Render for AutoScrollingVirtualMessageList {
        #[allow(deprecated)]
        fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            let list_state = self.list.clone();
            div()
                .size_full()
                .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, window, cx| {
                    let bounds = this.list.viewport_bounds();
                    let delta = (event.dragging() && window.has_text_selection(cx))
                        .then(|| AutoScroll::compute_delta(event.position.y, bounds))
                        .flatten();
                    this.auto_scroll.set(delta, cx, |delta, this, cx| {
                        this.list.scroll_by(delta);
                        cx.notify();
                    });
                }))
                .on_mouse_up(
                    MouseButton::Left,
                    cx.listener(|this, _, _, _| this.auto_scroll.stop()),
                )
                .child(
                    list(list_state, |ix, _, _| {
                        div()
                            .h(px(60.))
                            .w_full()
                            .child(
                                TextView::markdown(
                                    ("auto-scroll-selection-message", ix),
                                    format!("Message {ix}"),
                                )
                                .selectable(true),
                            )
                            .into_any()
                    })
                    .size_full(),
                )
        }
    }

    /// gpui-component fd3bc2b 的遮罩点击关闭是坏的,由 ui.rs 的 sentinel 补:经
    /// open_closable_dialog 打开的弹窗面板内点不关、面板上方/下方点一下即关;裸
    /// open_dialog 的(AlertDialog 一类没登记的)面板外点击不关
    #[gpui::test]
    fn dialog_closes_on_outside_click(cx: &mut TestAppContext) {
        use crate::ui::{open_closable_dialog, overlay_layers};
        use gpui_component::input::{Input, InputState};

        struct Host;
        impl Render for Host {
            fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
                div().size_full().children(overlay_layers(window, cx))
            }
        }
        cx.update(|cx| {
            gpui_component::init(cx);
            // 入场动画一帧到位,不用按真实时钟等它落位
            cx.set_reduce_motion(true);
        });
        let (_root, cx) = cx.add_window_view(|window, cx| {
            let host = cx.new(|_| Host);
            Root::new(host, window, cx)
        });
        let cx: &mut VisualTestContext = cx;
        let draw = |cx: &mut VisualTestContext| {
            cx.update(|w, cx| {
                let _ = w.draw(cx);
            });
            cx.run_until_parked();
        };
        let click = |cx: &mut VisualTestContext, position| {
            cx.simulate_click(position, Modifiers::default());
            draw(cx);
        };
        let size = cx.update(|w, _| w.viewport_size());
        // 面板居中、宽 400、顶边在视口高度 1/10 处
        let inside = point(size.width / 2., size.height / 10. + px(60.));
        // 面板上方(标题栏高度以内)与下方各取一点:上方曾被照抄上游的标题栏豁免吞掉
        let above = point(px(20.), px(20.));
        let below = point(px(20.), size.height - px(20.));

        // 真实表单里有个会拿焦点的输入框,照样放一个
        let input = cx.update(|window, cx| cx.new(|cx| InputState::new(window, cx)));
        cx.update(|window, cx| {
            open_closable_dialog(window, cx, move |dialog, _, _| {
                dialog
                    .title("Probe")
                    .w(px(400.))
                    .child(div().h(px(120.)).child(Input::new(&input)))
            });
        });
        draw(cx);
        click(cx, inside);
        click(cx, inside);
        assert!(
            cx.update(|w, cx| w.has_active_dialog(cx)),
            "click inside the panel must not close the dialog"
        );
        click(cx, above);
        assert!(
            !cx.update(|w, cx| w.has_active_dialog(cx)),
            "click above the panel must close the dialog"
        );

        cx.update(|window, cx| {
            open_closable_dialog(window, cx, |dialog, _, _| {
                dialog
                    .title("Probe")
                    .w(px(400.))
                    .child(div().h(px(120.)).child("body"))
            });
        });
        draw(cx);
        click(cx, below);
        assert!(
            !cx.update(|w, cx| w.has_active_dialog(cx)),
            "click below the panel must close the dialog"
        );

        // 裸 open_dialog(AlertDialog 一类没登记的):面板外点击不关
        cx.update(|window, cx| {
            window.open_dialog(cx, |dialog, _, _| {
                dialog
                    .title("Alert-like")
                    .w(px(400.))
                    .child(div().h(px(120.)).child("body"))
            });
        });
        draw(cx);
        click(cx, below);
        assert!(
            cx.update(|w, cx| w.has_active_dialog(cx)),
            "an unregistered dialog must survive outside clicks"
        );
        cx.update(|window, cx| window.close_dialog(cx));
    }

    #[gpui::test]
    #[allow(deprecated)]
    fn window_selection_spans_text_views_inside_gpui_list(cx: &mut TestAppContext) {
        cx.update(gpui_component::init);
        let (_, cx) = cx.add_window_view(|window, cx| {
            let view = cx.new(|_| VirtualMessageList {
                list: ListState::new(2, ListAlignment::Top, px(60.)),
            });
            Root::new(view, window, cx)
        });
        let cx: &mut VisualTestContext = cx;
        cx.run_until_parked();
        cx.update(|window, cx| {
            let _ = window.draw(cx);
        });

        cx.simulate_mouse_down(
            point(px(1.), px(15.)),
            MouseButton::Left,
            Modifiers::default(),
        );
        cx.simulate_mouse_move(
            point(px(300.), px(75.)),
            Some(MouseButton::Left),
            Modifiers::default(),
        );
        cx.simulate_mouse_up(
            point(px(300.), px(75.)),
            MouseButton::Left,
            Modifiers::default(),
        );
        cx.update(|window, cx| {
            let _ = window.draw(cx);
        });

        let selected = cx.update(|window, cx| window.selected_text(cx));
        assert!(selected.contains("First message"), "got {selected:?}");
        assert!(selected.contains("Second message"), "got {selected:?}");
    }

    #[gpui::test]
    #[allow(deprecated)]
    fn shift_click_extends_across_messages_inside_gpui_list(cx: &mut TestAppContext) {
        cx.update(gpui_component::init);
        let (_, cx) = cx.add_window_view(|window, cx| {
            let view = cx.new(|_| VirtualMessageList {
                list: ListState::new(2, ListAlignment::Top, px(60.)),
            });
            Root::new(view, window, cx)
        });
        let cx: &mut VisualTestContext = cx;
        cx.run_until_parked();
        cx.update(|window, cx| {
            let _ = window.draw(cx);
        });

        cx.simulate_mouse_down(
            point(px(1.), px(15.)),
            MouseButton::Left,
            Modifiers::default(),
        );
        cx.simulate_mouse_up(
            point(px(1.), px(15.)),
            MouseButton::Left,
            Modifiers::default(),
        );
        let shift = Modifiers {
            shift: true,
            ..Modifiers::default()
        };
        cx.simulate_mouse_down(point(px(300.), px(75.)), MouseButton::Left, shift);
        cx.simulate_mouse_up(point(px(300.), px(75.)), MouseButton::Left, shift);
        cx.update(|window, cx| {
            let _ = window.draw(cx);
        });

        let selected = cx.update(|window, cx| window.selected_text(cx));
        assert!(selected.contains("First message"), "got {selected:?}");
        assert!(selected.contains("Second message"), "got {selected:?}");
    }

    #[gpui::test]
    fn dragging_selection_at_viewport_edge_auto_scrolls_gpui_list(cx: &mut TestAppContext) {
        cx.update(gpui_component::init);
        let (root, cx) = cx.add_window_view(|window, cx| {
            let view = cx.new(|_| AutoScrollingVirtualMessageList {
                list: ListState::new(100, ListAlignment::Top, px(60.)),
                auto_scroll: AutoScroll::default(),
            });
            Root::new(view, window, cx)
        });
        let view = root.read_with(cx, |root, _| {
            root.view()
                .clone()
                .downcast::<AutoScrollingVirtualMessageList>()
                .unwrap()
        });
        let cx: &mut VisualTestContext = cx;
        cx.run_until_parked();
        cx.update(|window, cx| {
            let _ = window.draw(cx);
        });
        let bounds = view.read_with(cx, |view, _| view.list.viewport_bounds());
        let x = bounds.left() + px(10.);
        let anchor = point(x, bounds.top() + px(15.));

        cx.simulate_mouse_down(anchor, MouseButton::Left, Modifiers::default());
        cx.simulate_mouse_move(
            point(x, bounds.bottom() - px(20.)),
            Some(MouseButton::Left),
            Modifiers::default(),
        );
        cx.simulate_mouse_move(
            point(x, bounds.bottom() - px(1.)),
            Some(MouseButton::Left),
            Modifiers::default(),
        );
        assert!(view.read_with(cx, |view, _| view.auto_scroll.is_active()));

        cx.executor().advance_clock(Duration::from_millis(32));
        cx.run_until_parked();
        let scroll_top = view.read_with(cx, |view, _| view.list.logical_scroll_top());
        assert!(scroll_top.item_ix > 0 || scroll_top.offset_in_item > px(0.));

        cx.simulate_mouse_up(
            point(x, bounds.bottom() - px(1.)),
            MouseButton::Left,
            Modifiers::default(),
        );
        assert!(!view.read_with(cx, |view, _| view.auto_scroll.is_active()));
    }

    #[test]
    fn image_probe_accepts_small_matching_images_and_rejects_mime_mismatch() {
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgba8(2, 3)
            .write_to(&mut png, image::ImageFormat::Png)
            .expect("png fixture");
        let bytes = png.into_inner();

        let probe = image_probe(&bytes, gpui::ImageFormat::Png).expect("safe png");
        assert_eq!(probe.dims, (2, 3));
        assert_eq!(probe.decoded_pixels, 6);
        assert!(image_probe(&bytes, gpui::ImageFormat::Jpeg).is_none());
    }
}

// ---------------- Workbench ----------------

/// 主区当前显示的页:会话列表 + 阅读面,或整页目的地(侧栏底部入口)。一个
/// 字段承担互斥——三个 bool 各自"关掉别人"漏一处就是两页同时亮(2026-09-17
/// /simplify)。Clean up 是叠在会话视图上的模式(侧栏筛选仍然作用于它),另有
/// `cleanup.open`,进入时把这里落回 Sessions
#[derive(Clone, Copy, PartialEq, Eq)]
enum Page {
    Sessions,
    Insights,
    Memory,
    Skills,
    Relationships,
    Compressions,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum InsightsSubview {
    Overview,
    WorkspaceChanges,
    SessionChanges,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WorkspaceChangeRange {
    Days7,
    Days30,
    All,
}

impl WorkspaceChangeRange {
    const ALL: [Self; 3] = [Self::Days7, Self::Days30, Self::All];

    fn label(self) -> &'static str {
        match self {
            Self::Days7 => "最近 7 天",
            Self::Days30 => "最近 30 天",
            Self::All => "全部时间",
        }
    }

    fn since_ms(self) -> Option<i64> {
        let days = match self {
            Self::Days7 => 7,
            Self::Days30 => 30,
            Self::All => return None,
        };
        Some(Local::now().timestamp_millis() - days * 24 * 60 * 60 * 1000)
    }
}

const WORKSPACE_CHANGE_MARKDOWN_PREVIEW_BYTES: usize = 32 * 1024;

fn workspace_change_markdown_preview(text: &str) -> (&str, bool) {
    if text.len() <= WORKSPACE_CHANGE_MARKDOWN_PREVIEW_BYTES {
        return (text, false);
    }
    let mut end = WORKSPACE_CHANGE_MARKDOWN_PREVIEW_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (&text[..end], true)
}

#[derive(Clone)]
struct WorkspaceChangeFileGroup<'a> {
    path: String,
    events: Vec<&'a WorkspaceChangeEvent>,
}

#[derive(Clone)]
struct WorkspaceChangeFolderGroup<'a> {
    path: String,
    files: Vec<WorkspaceChangeFileGroup<'a>>,
}

#[derive(Clone)]
struct WorkspaceChangeTimelineGroup<'a> {
    latest: i64,
    earliest: i64,
    folder: WorkspaceChangeFolderGroup<'a>,
}

fn session_change_activity_key(group: &SessionChangeSessionGroup) -> String {
    let first_event_id = group
        .folders
        .iter()
        .flat_map(|folder| folder.files.iter())
        .flat_map(|file| file.events.iter())
        .chain(group.root_files.iter().flat_map(|file| file.events.iter()))
        .map(|event| event.id)
        .min()
        .unwrap_or_default();
    format!("{}:{first_event_id}", group.session_key)
}

fn workspace_change_groups(
    events: &[WorkspaceChangeEvent],
 ) -> Vec<WorkspaceChangeTimelineGroup<'_>> {
    const WINDOW_MS: i64 = 10 * 60 * 1000;
    let mut sorted: Vec<_> = events.iter().collect();
    sorted.sort_by(|left, right| {
        right
            .observed_at
            .cmp(&left.observed_at)
            .then_with(|| right.id.cmp(&left.id))
    });
    if sorted.is_empty() {
        return Vec::new();
    }
    let mut batches = Vec::<(i64, i64, Vec<&WorkspaceChangeEvent>)>::new();
    for event in sorted {
        let starts_batch = batches
            .last()
            .is_none_or(|(latest, _, _)| latest.saturating_sub(event.observed_at) >= WINDOW_MS);
        if starts_batch {
            batches.push((event.observed_at, event.observed_at, vec![event]));
        } else if let Some((_, earliest, batch)) = batches.last_mut() {
            *earliest = event.observed_at;
            batch.push(event);
        }
    }

    let mut groups = Vec::new();
    for (latest, earliest, batch) in batches {
        let mut by_folder = HashMap::<String, Vec<&WorkspaceChangeEvent>>::new();
        for event in batch {
            let folder = event
                .file_path
                .rsplit_once('/')
                .map(|(parent, _)| parent)
                .unwrap_or_default()
                .to_string();
            by_folder.entry(folder).or_default().push(event);
        }
        let mut folders = Vec::new();
        for (path, folder_events) in by_folder {
            let mut by_file = HashMap::<String, Vec<&WorkspaceChangeEvent>>::new();
            for event in folder_events {
                by_file.entry(event.file_path.clone()).or_default().push(event);
            }
            let mut files: Vec<_> = by_file
                .into_iter()
                .map(|(path, mut events)| {
                    events.sort_by(|left, right| {
                        right
                            .observed_at
                            .cmp(&left.observed_at)
                            .then_with(|| right.id.cmp(&left.id))
                    });
                    WorkspaceChangeFileGroup { path, events }
                })
                .collect();
            files.sort_by(|left, right| {
                let left_latest = left.events.first().map(|event| event.observed_at).unwrap_or_default();
                let right_latest = right.events.first().map(|event| event.observed_at).unwrap_or_default();
                right_latest.cmp(&left_latest).then_with(|| left.path.cmp(&right.path))
            });
            folders.push(WorkspaceChangeFolderGroup { path, files });
        }
        folders.sort_by(|left, right| {
            let latest_for = |folder: &WorkspaceChangeFolderGroup<'_>| {
                folder
                    .files
                    .iter()
                    .filter_map(|file| file.events.first().map(|event| event.observed_at))
                    .max()
                    .unwrap_or_default()
            };
            latest_for(right)
                .cmp(&latest_for(left))
                .then_with(|| left.path.cmp(&right.path))
        });
        groups.extend(folders.into_iter().map(|folder| WorkspaceChangeTimelineGroup {
            latest,
            earliest,
            folder,
        }));
    }
    groups
}

#[derive(Clone, Debug)]
struct CompressionDocumentEntry {
    path: PathBuf,
    project_path: String,
    title: String,
    scope: String,
    snippet: String,
    direct_match: bool,
    relation_count: usize,
}

fn compression_documents(
    store: &Store,
    projects: &[ProjectInfo],
    query: &str,
) -> anyhow::Result<(Vec<CompressionDocumentEntry>, usize, bool)> {
    let roots = wake_core::services::compression_documents::roots_for_projects(projects);
    let result = wake_core::services::compression_documents::sync_and_search(
        store, &roots, query, 200, true,
    )?;
    let entries = result
        .hits
        .into_iter()
        .map(|hit| CompressionDocumentEntry {
            path: PathBuf::from(hit.path),
            project_path: hit.project_path,
            title: hit.title,
            scope: hit.scope,
            snippet: hit.snippet,
            direct_match: hit.direct_match,
            relation_count: hit.related_by.len(),
        })
        .collect();
    Ok((entries, result.indexed_documents, result.degraded))
}

#[derive(Clone, Debug)]
struct RelationshipRootEntry {
    session: SessionMeta,
    edge_count: usize,
}

/// A relationship tree is represented by its roots in the navigation. For malformed
/// or manually-created cycles, keep one stable representative so the component remains
/// reachable without turning every edge into a duplicate sidebar row.
fn relationship_roots(edges: &[SessionRelationEdge]) -> Vec<RelationshipRootEntry> {
    let mut parents = HashMap::<String, SessionMeta>::new();
    let mut child_keys = HashSet::new();
    let mut degree = HashMap::<String, usize>::new();
    let mut neighbors = HashMap::<String, Vec<String>>::new();
    for edge in edges {
        parents
            .entry(edge.parent.key.clone())
            .or_insert_with(|| edge.parent.clone());
        child_keys.insert(edge.child.key.clone());
        *degree.entry(edge.parent.key.clone()).or_default() += 1;
        neighbors
            .entry(edge.parent.key.clone())
            .or_default()
            .push(edge.child.key.clone());
        neighbors
            .entry(edge.child.key.clone())
            .or_default()
            .push(edge.parent.key.clone());
    }

    let mut roots = Vec::new();
    let mut visited = HashSet::new();
    let mut keys = parents.keys().cloned().collect::<Vec<_>>();
    keys.sort();
    for key in keys {
        if visited.contains(&key) {
            continue;
        }
        let mut component = Vec::new();
        let mut stack = vec![key.clone()];
        while let Some(current) = stack.pop() {
            if !visited.insert(current.clone()) {
                continue;
            }
            component.push(current.clone());
            if let Some(next) = neighbors.get(&current) {
                stack.extend(next.iter().cloned());
            }
        }
        component.sort();
        let root_key = component
            .iter()
            .find(|candidate| parents.contains_key(*candidate) && !child_keys.contains(*candidate))
            .cloned()
            .or_else(|| {
                component
                    .iter()
                    .find(|candidate| parents.contains_key(*candidate))
                    .cloned()
            });
        if let Some(root_key) = root_key {
            if let Some(session) = parents.get(&root_key) {
                let edge_count = component
                    .iter()
                    .map(|key| degree.get(key).copied().unwrap_or_default())
                    .sum();
                roots.push(RelationshipRootEntry {
                    session: session.clone(),
                    edge_count,
                });
            }
        }
    }
    roots.sort_by(|left, right| {
        left.session
            .project_path
            .cmp(&right.session.project_path)
            .then_with(|| left.session.title.cmp(&right.session.title))
            .then_with(|| left.session.key.cmp(&right.session.key))
    });
    roots
}

#[derive(Clone, Debug, Default)]
struct CompressionDocumentMetadata {
    generated_at: String,
    source_session: String,
    project: String,
    processing_chain: String,
    coverage: String,
}

fn metadata_value(line: &str, ascii_prefix: &str, fullwidth_prefix: &str) -> Option<String> {
    line.strip_prefix(ascii_prefix)
        .or_else(|| line.strip_prefix(fullwidth_prefix))
        .map(|value| value.trim().trim_matches('`').to_string())
        .filter(|value| !value.is_empty())
}

fn compression_document_metadata(content: &str) -> CompressionDocumentMetadata {
    let mut metadata = CompressionDocumentMetadata::default();
    for line in content.lines().map(str::trim) {
        if metadata.generated_at.is_empty() {
            metadata.generated_at =
                metadata_value(line, "生成时间:", "生成时间：").unwrap_or_default();
        }
        if metadata.source_session.is_empty() {
            metadata.source_session =
                metadata_value(line, "原始会话:", "原始会话：").unwrap_or_default();
        }
        if metadata.project.is_empty() {
            metadata.project = metadata_value(line, "项目:", "项目：").unwrap_or_default();
        }
        if metadata.processing_chain.is_empty() {
            metadata.processing_chain =
                metadata_value(line, "处理链路:", "处理链路：").unwrap_or_default();
        }
        if metadata.coverage.is_empty() {
            metadata.coverage = metadata_value(line, "覆盖范围:", "覆盖范围：").unwrap_or_default();
        }
    }
    for line in content.lines().map(str::trim) {
        if metadata.generated_at.is_empty() {
            metadata.generated_at =
                metadata_value(line, "generated_at:", "generated_at：").unwrap_or_default();
        }
        if metadata.source_session.is_empty() {
            metadata.source_session =
                metadata_value(line, "contextos_sources:", "contextos_sources：")
                    .unwrap_or_default();
        }
        if metadata.project.is_empty() {
            metadata.project = metadata_value(line, "project:", "project：").unwrap_or_default();
        }
        if metadata.processing_chain.is_empty() {
            metadata.processing_chain =
                metadata_value(line, "contextos_mode:", "contextos_mode：").unwrap_or_default();
        }
        if metadata.coverage.is_empty() {
            metadata.coverage = metadata_value(line, "contextos_coverage:", "contextos_coverage：")
                .unwrap_or_default();
        }
    }
    metadata
}

#[derive(Clone, Debug, Default)]
pub(crate) struct JevConfig {
    pub(crate) provider: wake_core::services::compression_settings::DecisionModelProvider,
    pub(crate) model: String,
    pub(crate) api_url: String,
    pub(crate) api_key: String,
    pub(crate) timeout_secs: u64,
    pub(crate) laya_runtime_mode: wake_core::services::laya_runtime::LayaRuntimeMode,
}

#[derive(Clone, Debug)]
pub(crate) struct CompressionSettings {
    pub(crate) llm_enabled: bool,
    pub(crate) llm_api_url: String,
    pub(crate) llm_api_key: String,
    pub(crate) llm_model: String,
    pub(crate) llm_provider_index: usize,
    pub(crate) llm_provider_name: String,
    pub(crate) llm_timeout_secs: u64,
    pub(crate) llm_input_limit_chars: usize,
    pub(crate) jev_enabled: bool,
    pub(crate) single_strategy: String,
    pub(crate) memory_generation_strategy: String,
    pub(crate) multi_strategy: String,
    pub(crate) tag_strategy: String,
    pub(crate) tag_specific_strategies: HashMap<String, String>,
    pub(crate) relation_strategy: String,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct LlmProviderConfig {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) api_url: String,
    pub(crate) api_key: String,
    pub(crate) model: String,
}

#[derive(Clone, Copy)]
pub(crate) enum JevConfigField {
    Model,
    JevApiUrl,
    JevApiKey,
    LayaApiUrl,
    LayaApiKey,
    TimeoutSecs,
}

#[derive(Clone, Copy)]
pub(crate) enum CompressionConfigField {
    LlmProviderName,
    LlmApiUrl,
    LlmApiKey,
    LlmModel,
    LlmTimeoutSecs,
    LlmInputLimitChars,
}

#[derive(Clone, Copy)]
pub(crate) enum CompressionStrategyField {
    Single,
    MemoryGeneration,
    Multi,
    Tags,
    TagsGeneral,
    TagSpecific(&'static str),
    Relations,
    LlmSystemMessage,
    LlmTaskTemplate,
    LlmUserPromptTemplate,
    LlmMemoryCandidateContract,
}

#[derive(Clone, Copy)]
pub(crate) enum MechanicalRuleKind {
    EmptyOutput,
    ErrorProtection,
    Patch,
    SourceListing,
    SearchOutput,
    ListingOutput,
    InstructionAndToolSpec,
    GenericLargeOutput,
}

impl MechanicalRuleKind {
    fn key(self) -> &'static str {
        match self {
            Self::EmptyOutput => "empty_output_rule",
            Self::ErrorProtection => "error_protection_rule",
            Self::Patch => "patch_rule",
            Self::SourceListing => "source_listing_rule",
            Self::SearchOutput => "search_output_rule",
            Self::ListingOutput => "listing_output_rule",
            Self::InstructionAndToolSpec => "instruction_and_tool_spec_rule",
            Self::GenericLargeOutput => "generic_large_output_rule",
        }
    }

    fn title(self) -> &'static str {
        match self {
            Self::EmptyOutput => "空/低信息输出",
            Self::ErrorProtection => "错误/失败保护",
            Self::Patch => "Patch/Diff 证据",
            Self::SourceListing => "源码/代码分析输出",
            Self::SearchOutput => "搜索输出",
            Self::ListingOutput => "列表/表格输出",
            Self::InstructionAndToolSpec => "说明/工具规格",
            Self::GenericLargeOutput => "通用大输出",
        }
    }
}

#[derive(Clone, Copy)]
enum MechanicalFieldType {
    Boolean,
    Number,
    TextList,
}

#[derive(Clone, Copy)]
struct MechanicalFieldSpec {
    key: &'static str,
    label: &'static str,
    help: &'static str,
    field_type: MechanicalFieldType,
}

fn mechanical_field_specs(rule: MechanicalRuleKind) -> &'static [MechanicalFieldSpec] {
    use MechanicalFieldType::{Boolean, Number, TextList};
    match rule {
        MechanicalRuleKind::EmptyOutput => &[
            MechanicalFieldSpec {
                key: "enabled",
                label: "启用规则",
                help: "填写 是 或 否。",
                field_type: Boolean,
            },
            MechanicalFieldSpec {
                key: "drop_empty_output",
                label: "删除空 Output",
                help: "删除没有正文的工具输出。",
                field_type: Boolean,
            },
            MechanicalFieldSpec {
                key: "success_output_max_chars",
                label: "成功输出删除阈值",
                help: "短于该字符数的普通成功输出可删除。",
                field_type: Number,
            },
            MechanicalFieldSpec {
                key: "write_stdin_max_chars",
                label: "write_stdin 删除阈值",
                help: "短于该字符数的 write_stdin 输出可删除。",
                field_type: Number,
            },
            MechanicalFieldSpec {
                key: "keep_exit_code_line",
                label: "保留退出码摘要",
                help: "删除正文时仍保留退出码。",
                field_type: Boolean,
            },
        ],
        MechanicalRuleKind::ErrorProtection => &[
            MechanicalFieldSpec {
                key: "enabled",
                label: "启用规则",
                help: "填写 是 或 否。",
                field_type: Boolean,
            },
            MechanicalFieldSpec {
                key: "head_chars",
                label: "头部保留字符数",
                help: "错误输出头部保留长度。",
                field_type: Number,
            },
            MechanicalFieldSpec {
                key: "tail_chars",
                label: "尾部保留字符数",
                help: "错误输出尾部保留长度。",
                field_type: Number,
            },
            MechanicalFieldSpec {
                key: "keep_command",
                label: "保留执行命令",
                help: "保留触发输出的命令。",
                field_type: Boolean,
            },
            MechanicalFieldSpec {
                key: "keep_exit_code",
                label: "保留退出码",
                help: "保留非零退出码等结果。",
                field_type: Boolean,
            },
            MechanicalFieldSpec {
                key: "keep_failure_lines",
                label: "保留失败关键词行",
                help: "额外保留命中失败关键词的行。",
                field_type: Boolean,
            },
            MechanicalFieldSpec {
                key: "failure_keywords",
                label: "失败关键词",
                help: "多个关键词用英文逗号分隔。",
                field_type: TextList,
            },
        ],
        MechanicalRuleKind::Patch => &[
            MechanicalFieldSpec {
                key: "enabled",
                label: "启用规则",
                help: "填写 是 或 否。",
                field_type: Boolean,
            },
            MechanicalFieldSpec {
                key: "head_chars",
                label: "头部保留字符数",
                help: "Patch 头部保留长度。",
                field_type: Number,
            },
            MechanicalFieldSpec {
                key: "tail_chars",
                label: "尾部保留字符数",
                help: "Patch 尾部保留长度。",
                field_type: Number,
            },
            MechanicalFieldSpec {
                key: "keep_file_headers",
                label: "保留文件头",
                help: "保留修改文件的路径和头信息。",
                field_type: Boolean,
            },
            MechanicalFieldSpec {
                key: "keep_hunk_headers",
                label: "保留 Hunk 位置",
                help: "保留 @@ 行等修改位置。",
                field_type: Boolean,
            },
            MechanicalFieldSpec {
                key: "max_hunks_per_file",
                label: "每文件最多 Hunk 数",
                help: "单个文件最多保留的修改片段数。",
                field_type: Number,
            },
        ],
        MechanicalRuleKind::SourceListing => &[
            MechanicalFieldSpec {
                key: "enabled",
                label: "启用规则",
                help: "填写 是 或 否。",
                field_type: Boolean,
            },
            MechanicalFieldSpec {
                key: "max_lines",
                label: "最多保留关键行数",
                help: "源码或代码分析输出的关键行上限。",
                field_type: Number,
            },
            MechanicalFieldSpec {
                key: "keep_query_summary",
                label: "保留查询摘要",
                help: "保留查询条件和范围。",
                field_type: Boolean,
            },
            MechanicalFieldSpec {
                key: "keep_file_headers",
                label: "保留文件/符号标题",
                help: "保留路径、符号和分组标题。",
                field_type: Boolean,
            },
            MechanicalFieldSpec {
                key: "keep_blast_radius",
                label: "保留影响范围",
                help: "保留调用链和 blast radius。",
                field_type: Boolean,
            },
            MechanicalFieldSpec {
                key: "keep_staleness_warnings",
                label: "保留索引状态提示",
                help: "保留过期索引等警告。",
                field_type: Boolean,
            },
            MechanicalFieldSpec {
                key: "head_chars",
                label: "兜底头部字符数",
                help: "无法结构化裁剪时保留的头部长度。",
                field_type: Number,
            },
            MechanicalFieldSpec {
                key: "tail_chars",
                label: "兜底尾部字符数",
                help: "无法结构化裁剪时保留的尾部长度。",
                field_type: Number,
            },
        ],
        MechanicalRuleKind::SearchOutput => &[
            MechanicalFieldSpec {
                key: "enabled",
                label: "启用规则",
                help: "填写 是 或 否。",
                field_type: Boolean,
            },
            MechanicalFieldSpec {
                key: "max_matches",
                label: "最多保留命中数",
                help: "搜索命中总上限。",
                field_type: Number,
            },
            MechanicalFieldSpec {
                key: "head_matches",
                label: "前部命中保留数",
                help: "优先保留开头的命中数。",
                field_type: Number,
            },
            MechanicalFieldSpec {
                key: "tail_matches",
                label: "尾部命中保留数",
                help: "优先保留末尾的命中数。",
                field_type: Number,
            },
            MechanicalFieldSpec {
                key: "keep_truncated_notice",
                label: "保留截断提示",
                help: "保留结果被截断的事实。",
                field_type: Boolean,
            },
            MechanicalFieldSpec {
                key: "priority_keywords",
                label: "优先保留关键词",
                help: "多个关键词用英文逗号分隔。",
                field_type: TextList,
            },
        ],
        MechanicalRuleKind::ListingOutput => &[
            MechanicalFieldSpec {
                key: "enabled",
                label: "启用规则",
                help: "填写 是 或 否。",
                field_type: Boolean,
            },
            MechanicalFieldSpec {
                key: "max_items",
                label: "最多保留条目数",
                help: "列表或表格条目总上限。",
                field_type: Number,
            },
            MechanicalFieldSpec {
                key: "head_items",
                label: "前部条目保留数",
                help: "优先保留开头条目数。",
                field_type: Number,
            },
            MechanicalFieldSpec {
                key: "tail_items",
                label: "尾部条目保留数",
                help: "优先保留末尾条目数。",
                field_type: Number,
            },
            MechanicalFieldSpec {
                key: "keep_count_summary",
                label: "保留总数摘要",
                help: "保留裁剪前后的条目数量。",
                field_type: Boolean,
            },
            MechanicalFieldSpec {
                key: "anomaly_keywords",
                label: "异常条目关键词",
                help: "多个关键词用英文逗号分隔。",
                field_type: TextList,
            },
        ],
        MechanicalRuleKind::InstructionAndToolSpec => &[
            MechanicalFieldSpec {
                key: "enabled",
                label: "启用规则",
                help: "填写 是 或 否。",
                field_type: Boolean,
            },
            MechanicalFieldSpec {
                key: "max_headings",
                label: "最多保留标题数",
                help: "说明文档保留的标题上限。",
                field_type: Number,
            },
            MechanicalFieldSpec {
                key: "max_tool_names",
                label: "最多保留工具名数",
                help: "工具清单保留的名称上限。",
                field_type: Number,
            },
            MechanicalFieldSpec {
                key: "keep_required_fields",
                label: "保留必填字段",
                help: "保留 required 和输入约束。",
                field_type: Boolean,
            },
            MechanicalFieldSpec {
                key: "keep_safety_hints",
                label: "保留安全/权限提示",
                help: "保留权限、风险和边界说明。",
                field_type: Boolean,
            },
            MechanicalFieldSpec {
                key: "keep_command_examples",
                label: "保留命令示例",
                help: "保留 CLI 或调用示例。",
                field_type: Boolean,
            },
            MechanicalFieldSpec {
                key: "head_chars",
                label: "兜底头部字符数",
                help: "无法结构化裁剪时保留的头部长度。",
                field_type: Number,
            },
            MechanicalFieldSpec {
                key: "tail_chars",
                label: "兜底尾部字符数",
                help: "无法结构化裁剪时保留的尾部长度。",
                field_type: Number,
            },
        ],
        MechanicalRuleKind::GenericLargeOutput => &[
            MechanicalFieldSpec {
                key: "enabled",
                label: "启用规则",
                help: "填写 是 或 否。",
                field_type: Boolean,
            },
            MechanicalFieldSpec {
                key: "min_output_chars",
                label: "裁剪触发字符数",
                help: "超过该长度才应用通用裁剪。",
                field_type: Number,
            },
            MechanicalFieldSpec {
                key: "head_chars",
                label: "头部保留字符数",
                help: "保留输出开头的长度。",
                field_type: Number,
            },
            MechanicalFieldSpec {
                key: "tail_chars",
                label: "尾部保留字符数",
                help: "保留输出末尾的长度。",
                field_type: Number,
            },
            MechanicalFieldSpec {
                key: "mark_jev_candidate",
                label: "标记为 Jev 候选",
                help: "允许 Jev 对裁剪结果进一步评分。",
                field_type: Boolean,
            },
        ],
    }
}

fn jev_action_chinese(
    action: wake_core::services::compression_settings::JevAction,
) -> &'static str {
    use wake_core::services::compression_settings::JevAction;
    match action {
        JevAction::Discard => "删除",
        JevAction::Stub => "极简占位",
        JevAction::UseMechanical => "机械裁剪",
        JevAction::Evidence => "关键证据",
        JevAction::Expanded => "扩展片段",
        JevAction::Verbatim => "近全文",
    }
}

fn parse_jev_action(value: &str) -> Option<wake_core::services::compression_settings::JevAction> {
    use wake_core::services::compression_settings::JevAction;
    match value.trim().to_ascii_lowercase().as_str() {
        "删除" | "discard" => Some(JevAction::Discard),
        "极简占位" | "占位" | "stub" => Some(JevAction::Stub),
        "机械裁剪" | "机械" | "use_mechanical" => Some(JevAction::UseMechanical),
        "关键证据" | "证据" | "evidence" => Some(JevAction::Evidence),
        "扩展片段" | "扩展" | "expanded" => Some(JevAction::Expanded),
        "近全文" | "全文" | "verbatim" => Some(JevAction::Verbatim),
        _ => None,
    }
}

pub struct Workbench {
    focus_handle: FocusHandle,
    runtime: Arc<BackgroundRuntime>,
    store: Arc<Store>,
    workspace_store: Arc<WorkspaceStore>,
    /// 扫描/监听只含启用 location；管理面板另读 data_locations，停用行不消失。
    adapters: SharedAdapters,
    /// 与 adapters 同一次 roster 构造得到的全部 location 路径快照。
    data_locations: SharedLocations,

    selected_agent: Option<AgentId>,
    selected_project: Option<String>,
    selected_tag: Option<String>,
    /// Models 榜单下钻的筛选(单选,Insights 行点击落这里;侧栏没有这颗入口)
    selected_model: Option<String>,
    pending_link_parent: Option<(String, String)>,
    pending_link_child: Option<(String, String)>,
    favorite_only: bool,
    sort_key: SortKey,
    sort_ascending: bool,

    agent_counts: Vec<(AgentId, i64)>,
    /// remotes/ 镜像的磁盘占用(Settings → Data 的 Storage 行并进索引库大小);
    /// 后台算、经 RemoteCacheBytes 送达,None = 还没算完
    remote_cache_bytes: Option<u64>,
    projects: Vec<ProjectInfo>,
    tag_counts: Vec<(String, i64)>,
    agents_collapsed: bool,
    projects_collapsed: bool,
    tags_collapsed: bool,
    relationship_tree_collapsed: bool,
    relationship_parents_collapsed: bool,
    relationship_children_collapsed: bool,
    starred_count: i64,
    /// 后台扫描的最新状态,启动时的自动扫描与用户主动重扫共用。整份留存而不是
    /// 摊成几个字段:刷新入口的守卫、侧栏状态文案、按钮 busy 态全部从它派生,
    /// 单一写入点就不会互相失步——把派生出的文案反过来当守卫,正是
    /// "扫描失败后刷新按钮再也点不动"的来源
    scan: ScanProgress,
    /// 用户主动发起的重扫。与 scan.scanning 正交：前者决定终态通知，后者是
    /// 所有自动/手动扫描共用的实际运行状态。
    refreshing: bool,
    /// location 变更撞上进行中的扫描时置位:那轮扫描持旧 roster,不补扫的话
    /// 新根不收录、被移根不出清,要等手动 ⌘R(2026-08-24 Codex review)。
    /// 终态事件到达后由 on_bg_event 消费,用新 roster 补一轮增量
    pending_rescan: bool,
    /// rsync 线程正在同步的 host(空 = 空闲);与 scan 正交。侧栏文案与
    /// Sync now 的 busy 态都从这个**事实**派生,render 现算文案——不变量 6
    /// 的教训:别把展示句存成状态
    syncing_hosts: Vec<String>,
    /// 同步进行中又被请求的 host(如 rsync 未收工就 add host):收工后只补
    /// 这几台(不升级成全量),不并发两组 rsync 打同一缓存树
    pending_sync: Vec<String>,
    /// 远程同步线程直发事件用；后台事件由 BackgroundEvents 转发给当前窗口。
    bg_tx: futures::channel::mpsc::UnboundedSender<BgEvent>,
    /// Settings 是单例窗口；句柄不保活，关闭后下次点击会检测失败并重建。
    settings_window: Option<AnyWindowHandle>,
    settings_page: SettingsPage,
    update_status: UpdateStatus,
    laya_external_capabilities: Option<wake_core::services::laya_runtime::LayaExternalCapabilities>,
    total_sessions: i64,

    list_state: Entity<ListState<SessionsDelegate>>,
    palette_list: Entity<ListState<SearchDelegate>>,
    /// ⌘K 搜索输入框(自管,不用 List 内置 searchable:清除钮可控)
    palette_input: Entity<InputState>,
    /// 上次刷新界面缓存译文时的语言代次(见 `sync_language`)
    lang_generation: u64,
    /// 进行中的搜索任务;新输入覆盖旧值即取消过期搜索
    _palette_search_task: Option<Task<()>>,
    /// 搜索命中不在首批会话时，按页补齐到命中项；新搜索覆盖旧任务。
    _list_seek_task: Option<Task<()>>,
    /// delegate 刷新或日期分组变化后，旧 IndexPath 已失效；下一帧按稳定 key
    /// 恢复选择，必要时继续分页找到目标。
    pending_list_selection: Option<String>,
    /// 每分钟触发一次轻量重绘，让跨午夜的 Today/Yesterday 分组自动换日。
    _calendar_task: Option<Task<()>>,

    /// 文本拖选靠近详情视口边缘时，持续推动外层消息列表。
    detail_selection_auto_scroll: AutoScroll,
    detail: Option<DetailState>,
    sidebar_collapsed: bool,
    detail_outline_collapsed: bool,
    detail_outline_mode: DetailOutlineMode,
    detail_search_open: bool,
    detail_search_input: Entity<InputState>,
    /// 图片操作反馈的全局递增代次。即使关闭后重新打开同一会话和图片，旧计时
    /// 器也不会误清新状态。
    image_action_feedback_generation: u64,

    /// 主区当前的页(侧栏单选模型):Insights / Memory 打开时替换中栏+右栏,
    /// 数据在 open/refresh 时后台重算
    page: Page,
    compression_selected: Option<PathBuf>,
    compression_query: Entity<InputState>,
    compression_documents: Vec<CompressionDocumentEntry>,
    compression_indexed_documents: usize,
    compression_search_degraded: bool,
    compression_search_loading: bool,
    compression_search_error: Option<String>,
    compression_last_query: String,
    compression_search_task: Option<Task<()>>,
    relationship_edges: Vec<SessionRelationEdge>,
    skill_query: Entity<InputState>,
    cleanup: cleanup::CleanupState,
    /// Memory 页的数据与选中态(agent 自己写的记忆文档)
    memory: memory::MemoryState,
    /// Skills 页直接读取各 agent 的用户级 Skill 目录，不经过会话索引库。
    skills: skills::SkillsState,
    /// Insights 页数据,Rc 免深拷贝
    insights: Option<Rc<InsightsData>>,
    /// Insights 侧栏当前选中的 Agent;不影响会话页的筛选状态
    insights_agent: Option<AgentId>,
    insights_loading: bool,
    insights_time_range: InsightsTimeRange,
    /// 点击日期临时收窄范围前的选择;再次点击同一天恢复。
    insights_range_before_day: Option<InsightsTimeRange>,
    insights_range: InsightsRange,
    /// 三个榜单各自的度量档,按 UsageBoard 序数索引
    insights_metrics: [InsightsMetric; 3],
    /// 三个榜单各自的行数上限档,按 UsageBoard 序数索引。Agents 榜全量列
    /// (共十九家),该字段对它不生效
    insights_top_n: [TopN; 3],
    /// 热力图点选的某天:三档分布联动为该日所在周期的细分。None = 全历史
    /// 聚合(默认);快照数据在 insights_period,加载中 insights_period_loading
    insights_selected: Option<chrono::NaiveDate>,
    insights_period: Option<Rc<PeriodBreakdown>>,
    insights_period_loading: bool,
    insights_period_task: Option<Task<()>>,
    /// "Agents asking ContextOS" 当前档位(All / MCP / CLI)
    insights_lookup_view: LookupView,
    /// 进行中的统计查询;新查询覆盖旧值即取消,扫描风暴下不堆积读锁竞争
    insights_task: Option<Task<()>>,

    insights_subview: InsightsSubview,
    workspace_roots: Vec<WorkspaceRoot>,
    workspace_change_project: Option<String>,
    workspace_change_events: Vec<WorkspaceChangeEvent>,
    session_change_groups: Vec<SessionChangeSessionGroup>,
    session_change_events: Vec<SessionFileChangeEvent>,
    session_change_loading: bool,
    session_change_error: Option<String>,
    session_change_selected: Option<i64>,
    session_change_open_sessions: HashSet<String>,
    session_change_inspector: Option<String>,
    session_change_picker_open: bool,
    session_change_picker_query: Entity<InputState>,
    session_change_picker_sessions: Vec<SessionMeta>,
    session_change_picker_total: i64,
    session_change_picker_selected: HashSet<String>,
    session_change_request: u64,
    session_change_task: Option<Task<()>>,
    workspace_change_range: WorkspaceChangeRange,
    workspace_change_kind: Option<WorkspaceChangeKind>,
    workspace_change_sort_ascending: bool,
    session_change_range: WorkspaceChangeRange,
    session_change_kind: Option<WorkspaceChangeKind>,
    session_change_sort_ascending: bool,
    workspace_change_open_folders: HashSet<String>,
    workspace_change_open_files: HashSet<String>,
    workspace_change_loading: bool,
    workspace_change_has_more: bool,
    workspace_change_error: Option<String>,
    workspace_change_request: u64,
    workspace_change_selected: Option<i64>,
    workspace_change_detail: Option<WorkspaceChangeDetail>,
    workspace_change_detail_loading: bool,
    workspace_change_detail_error: Option<String>,
    workspace_change_detail_request: u64,
    workspace_change_task: Option<Task<()>>,
    workspace_change_detail_task: Option<Task<()>>,

    scan_events: Arc<dyn ScanEvents>,
    /// 终端 id → 提取好的应用图标 png(后台 JXA 提取,详情页 Open In 用)
    terminal_icons: HashMap<String, PathBuf>,
    /// Open In 上次选择(split 按钮左段直开目标),None = 已装列表首个
    /// Open In 上次选择,按 agent 分记:agent 专属目标(两家 desktop、Kooky)
    /// 只对自家会话有意义,单一全局值会被后选的专属目标冲掉,回头另一家
    /// 会话就回退 Terminal(2026-09-01 用户反馈)。跨 agent 的次级回退走
    /// `last_terminal`
    preferred_terminal: HashMap<AgentId, terminal::TerminalApp>,
    /// 最近一次显式选择(不分 agent),per-agent 无记录时若仍在该会话的
    /// 可用列表内则用它——让"一直用 Ghostty"的人不用每家 agent 都选一遍
    last_terminal: Option<terminal::TerminalApp>,
    _subs: Vec<Subscription>,
}

/// Insights 分布图的维度(‹ › 循环切换)。数据三份都在 InsightsData 里,
/// 切换是纯视图状态,不触发重查
#[derive(Clone, Copy, PartialEq, Eq)]
enum InsightsRange {
    Hour,
    Weekday,
    Month,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum InsightsTimeRange {
    All,
    Days7,
    Days30,
    Days90,
    Year,
    Custom {
        start_ms: i64,
        end_ms: i64,
        live_end: bool,
    },
}

impl InsightsTimeRange {
    const ALL: [Self; 5] = [
        Self::All,
        Self::Days7,
        Self::Days30,
        Self::Days90,
        Self::Year,
    ];

    fn label(self) -> &'static str {
        match self {
            Self::All => t("All"),
            Self::Days7 => t("Last 7 days"),
            Self::Days30 => t("Last 30 days"),
            Self::Days90 => t("Last 90 days"),
            Self::Year => t("Last year"),
            Self::Custom { .. } => t("Custom"),
        }
    }

    fn bounds(self, today: NaiveDate) -> (Option<i64>, Option<i64>) {
        if self == Self::All {
            return (None, Some(Local::now().timestamp_millis()));
        }
        let days = match self {
            Self::Days7 => 7,
            Self::Days30 => 30,
            Self::Days90 => 90,
            Self::Year => 365,
            Self::All => unreachable!(),
            Self::Custom {
                start_ms,
                end_ms,
                live_end,
            } => {
                return (
                    Some(start_ms),
                    Some(if live_end {
                        Local::now().timestamp_millis()
                    } else {
                        end_ms
                    }),
                )
            }
        };
        let start = today - chrono::Days::new(days - 1);
        let start_ms = start
            .and_hms_opt(0, 0, 0)
            .and_then(|dt| Local.from_local_datetime(&dt).single())
            .map(|dt| dt.timestamp_millis())
            .unwrap_or(0);
        (Some(start_ms), Some(Local::now().timestamp_millis()))
    }

    fn day_bounds(day: NaiveDate) -> (Option<i64>, Option<i64>) {
        let to_ms = |date: NaiveDate| {
            date.and_hms_opt(0, 0, 0)
                .and_then(|dt| Local.from_local_datetime(&dt).single())
                .map(|dt| dt.timestamp_millis())
                .unwrap_or(0)
        };
        (Some(to_ms(day)), Some(to_ms(day + chrono::Days::new(1))))
    }
}

impl InsightsRange {
    fn title(self) -> &'static str {
        match self {
            Self::Hour => t("By hour"),
            Self::Weekday => t("By weekday"),
            Self::Month => t("By month"),
        }
    }

    fn prev(self) -> Self {
        match self {
            Self::Hour => Self::Month,
            Self::Weekday => Self::Hour,
            Self::Month => Self::Weekday,
        }
    }

    fn next(self) -> Self {
        match self {
            Self::Hour => Self::Weekday,
            Self::Weekday => Self::Month,
            Self::Month => Self::Hour,
        }
    }
}

/// 榜单行数上限档。All = 全量列(Agents 榜固定此档)
#[derive(Clone, Copy, PartialEq, Eq)]
enum TopN {
    N5,
    N10,
    N20,
    All,
}

impl TopN {
    fn all() -> [TopN; 3] {
        [Self::N5, Self::N10, Self::N20]
    }

    /// 循环:5 → 10 → 20 → 全部 → 5。单击一枚按钮即可,不做 ‹ › 双向
    /// (度量那对箭头已在同一行,再添一对会看不过来)
    fn next(self) -> Self {
        match self {
            Self::N5 => Self::N10,
            Self::N10 => Self::N20,
            Self::N20 => Self::All,
            Self::All => Self::N5,
        }
    }

    fn limit(self) -> usize {
        match self {
            Self::N5 => 5,
            Self::N10 => 10,
            Self::N20 => 20,
            Self::All => usize::MAX,
        }
    }

    fn label(self) -> String {
        match self {
            Self::N5 => crate::tf!("Top {}", 5),
            Self::N10 => crate::tf!("Top {}", 10),
            Self::N20 => crate::tf!("Top {}", 20),
            Self::All => t("All").to_string(),
        }
    }

    /// 榜单头那枚循环按钮的 tooltip:说清按的是行数而不是度量
    fn tooltip(self) -> &'static str {
        t("Rows shown")
    }
}

/// 榜单(Agents/Top projects/Models)的度量维度,‹ › 循环切换、每个榜单
/// 各自记忆档位。Tokens 只在组内有人报过用量时进入循环——tokens=0 语义
/// 是"不报"而非"用了 0"
#[derive(Clone, Copy, PartialEq, Eq)]
enum InsightsMetric {
    Sessions,
    Prompts,
    Tokens,
}

impl InsightsMetric {
    fn caption(self) -> &'static str {
        match self {
            Self::Sessions => t("Sessions"),
            Self::Prompts => t("Prompts"),
            Self::Tokens => t("Tokens"),
        }
    }

    fn value(self, u: &UsageTally) -> i64 {
        match self {
            Self::Sessions => u.sessions,
            Self::Prompts => u.prompts,
            Self::Tokens => u.tokens,
        }
    }

    fn display(self, u: &UsageTally) -> String {
        match self {
            Self::Tokens => fmt_tokens(Some(u.tokens)),
            _ => thousands(self.value(u)),
        }
    }
}

/// "Agents asking ContextOS" 的档位:两条接入合计,或只看其中一条。‹ › 循环,与榜单同形;
/// MCP 那一路按工具名认、天然精确,CLI 那一路按命令文本认,分开看才知道噪音在哪
#[derive(Clone, Copy, PartialEq, Eq)]
enum LookupView {
    All,
    Mcp,
    Cli,
}

impl LookupView {
    /// 两键中间的档位名;MCP / CLI 是专名,不译
    fn caption(self) -> &'static str {
        match self {
            Self::All => t("All"),
            Self::Mcp => "MCP",
            Self::Cli => "CLI",
        }
    }

    fn value(self, l: &LookupTally) -> i64 {
        match self {
            Self::All => l.total(),
            Self::Mcp => l.mcp,
            Self::Cli => l.cli,
        }
    }

    fn prev(self) -> Self {
        match self {
            Self::All => Self::Cli,
            Self::Mcp => Self::All,
            Self::Cli => Self::Mcp,
        }
    }

    fn next(self) -> Self {
        match self {
            Self::All => Self::Mcp,
            Self::Mcp => Self::Cli,
            Self::Cli => Self::All,
        }
    }
}

/// 三个榜单的静态规格。`Workbench::insights_metrics` 按其序数索引各自
/// 记忆档位——同一个渲染方法靠它读写自己的状态,不必外传 setter
#[derive(Clone, Copy)]
enum UsageBoard {
    Agents,
    Projects,
    Models,
}

impl UsageBoard {
    fn title(self) -> &'static str {
        match self {
            Self::Agents => t("Agents"),
            Self::Projects => t("Projects"),
            Self::Models => t("Models"),
        }
    }

    fn arrow_id(self) -> &'static str {
        match self {
            Self::Agents => "agents-arrow",
            Self::Projects => "projects-arrow",
            Self::Models => "models-arrow",
        }
    }

    /// 行元素 id 的前缀(元素 id 只要求同级唯一,带上榜单名更保险)
    fn id(self) -> &'static str {
        match self {
            Self::Agents => "agents",
            Self::Projects => "projects",
            Self::Models => "models",
        }
    }

    fn name_w(self) -> Pixels {
        match self {
            Self::Models => px(176.),
            _ => px(128.),
        }
    }
}

/// Settings/Locations 的一行(= 一个数据源路径)。文本字段用 SharedString，
/// 让跨窗口快照与菜单闭包的 clone 只做引用计数。
#[derive(Clone)]
pub(crate) struct DataSourceRow {
    pub(crate) agent: AgentId,
    /// `~/…` 展示形态
    pub(crate) display: SharedString,
    /// 原始完整路径,交给 Finder
    pub(crate) raw: SharedString,
    /// 会话数,或路径不可用时的状态词
    pub(crate) tally: SharedString,
    /// 路径当前存在(行是否可点)
    pub(crate) exists: bool,
    /// Some(落库路径) = 自定义行(路径可能是本行根的上层目录);None = 预设行
    pub(crate) custom: Option<SharedString>,
    /// 预设行是否能只压制本路径，而不关闭该 agent 的整个默认实例。
    pub(crate) individual_default: bool,
    pub(crate) enabled: bool,
}

#[derive(Clone)]
pub(crate) struct LocationSettingsSnapshot {
    pub(crate) rows: Vec<DataSourceRow>,
    pub(crate) diverged: bool,
}

/// Settings/Memory locations 的一行(= 一个记忆来源:各家默认的目录 / 文件 / 库 /
/// 项目模式,或用户加的自定义目录 / 文件)
#[derive(Clone)]
pub(crate) struct MemoryLocationRow {
    pub(crate) agent: AgentId,
    /// `~/…` 展示形态;项目模式原样(`<project>/CLAUDE.md`)
    pub(crate) display: SharedString,
    /// 来源 id(`MemorySource::id`):停用开关、自定义行的落库路径都是它
    pub(crate) raw: SharedString,
    /// 文件数,或路径不存在时的状态词
    pub(crate) tally: SharedString,
    /// 具体路径当前存在(项目模式恒 true,但没有 Show in Finder)
    pub(crate) exists: bool,
    pub(crate) pattern: bool,
    /// 用户加的(可编辑、可删);默认来源只能开关
    pub(crate) custom: bool,
    pub(crate) enabled: bool,
}

#[derive(Clone)]
pub(crate) struct MemoryLocationSettingsSnapshot {
    pub(crate) rows: Vec<MemoryLocationRow>,
    pub(crate) diverged: bool,
}

#[derive(Clone)]
pub(crate) struct DataSettingsSnapshot {
    pub(crate) display_path: SharedString,
    pub(crate) raw_path: SharedString,
    /// 索引库三件套 + remotes/ 镜像
    pub(crate) size_bytes: u64,
    /// 其中镜像的部分(算完前为 0)
    pub(crate) remote_bytes: u64,
    pub(crate) session_count: i64,
}

/// Settings → Remote hosts 的一行(库表 remote_hosts + 会话计数拼装)
#[derive(Clone)]
pub(crate) struct RemoteHostRow {
    pub(crate) name: SharedString,
    pub(crate) enabled: bool,
    /// "12 sessions · synced 5 min ago" / "Never synced" / 错误摘要
    pub(crate) status: SharedString,
    pub(crate) failed: bool,
}

/// location 表单的语义目标。预设行的“编辑”落库为**压制默认 + 记自定义**；
/// 真正的 Remove 只对自定义 location 出现，预设行由开关启停。
#[derive(Clone)]
enum FormTarget {
    Add,
    /// 编辑既有一行。custom=true:path 是落库的自定义路径(编辑单位);
    /// custom=false:path 是预填表单的路径；root 始终是被点行的真实数据根。
    Edit {
        agent: AgentId,
        path: SharedString,
        root: SharedString,
        custom: bool,
        individual_default: bool,
    },
}

/// 路径表单的一份规格:Session locations 与 Memory locations 共用同一个表单(agent
/// 下拉 + 路径输入 + 选择钮,Cancel/Save 只在有改动时出现;编辑态动作行左 Remove、
/// 右 Show in Finder),两页的差别全在这里
struct PathFormSpec {
    title: &'static str,
    ok_label: &'static str,
    /// 路径字段的标签("Folder" / "Folder or file")
    field_label: &'static str,
    init_agent: AgentId,
    init_path: SharedString,
    /// 选择器是否也收文件(记忆来源可以是单个文件)
    pick_files: bool,
    /// 编辑态动作行 Show in Finder 挂的路径:Some = 这条路径当下存在(添加态、路径不在
    /// 都是 None)
    reveal: Option<SharedString>,
    /// 编辑态 Remove(只有真正可删的自定义行才有)
    remove: Option<Rc<dyn Fn(&mut Workbench, &mut Window, &mut Context<Workbench>)>>,
    /// 提交;返回 false = 表单留着(校验没过,或已手工收场)
    commit:
        Rc<dyn Fn(&mut Workbench, AgentId, String, &mut Window, &mut Context<Workbench>) -> bool>,
}

impl Workbench {
    pub(crate) fn background_runtime_for_shutdown() -> Arc<BackgroundRuntime> {
        Self::background_runtime()
    }

    fn background_runtime() -> Arc<BackgroundRuntime> {
        static RUNTIME: OnceLock<Arc<BackgroundRuntime>> = OnceLock::new();
        RUNTIME
            .get_or_init(|| {
                let db_path = wake_core::db::default_db_path();
                let (store, db_note) = match wake_core::db::open_or_rebuild(&db_path) {
                    Ok(value) => value,
                    Err(error) => {
                        terminal::show_fatal_alert(&crate::tf!(
                            "ContextOS couldn't open or rebuild its index at {}. {}",
                            db_path.display(),
                            error
                        ));
                        std::process::exit(1);
                    }
                };
                let store = Arc::new(store);
                let workspace_store = match WorkspaceStore::open(
                    &default_workspace_db_path(),
                    &default_workspace_cas_path(),
                ) {
                    Ok(store) => Arc::new(store),
                    Err(error) => {
                        terminal::show_fatal_alert(&crate::tf!(
                            "ContextOS couldn't open workspace history. {}",
                            error
                        ));
                        std::process::exit(1);
                    }
                };
                let (adapters, _) = Self::build_roster(&store);
                Arc::new(BackgroundRuntime::new(
                    store,
                    workspace_store,
                    adapters,
                    db_note,
                ))
            })
            .clone()
    }

    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let runtime = Self::background_runtime();
        let db_note = runtime.take_db_note();
        let store = runtime.store.clone();
        let workspace_store = runtime.workspace_store.clone();
        let adapters = runtime.adapters();
        let (_, data_locations) = Self::build_roster(&store);

        let list_state = cx.new(|cx| {
            ListState::new(
                SessionsDelegate::new(Vec::new(), SortKey::Updated, false),
                window,
                cx,
            )
            .searchable(false)
        });
        let palette_list = cx.new(|cx| {
            ListState::new(
                SearchDelegate {
                    hits: Vec::new(),
                    degraded: false,
                    store: store.clone(),
                    last_query: String::new(),
                },
                window,
                cx,
            )
            .searchable(false)
        });
        let palette_input = cx.new(|cx| {
            InputState::new(window, cx).placeholder(t("Search everything — prose or code"))
        });
        let compression_query =
            cx.new(|cx| InputState::new(window, cx).placeholder("搜索压缩内容、标题或路径"));
        let session_change_picker_query =
            cx.new(|cx| InputState::new(window, cx).placeholder("搜索会话标题或项目"));
        let skill_query =
            cx.new(|cx| InputState::new(window, cx).placeholder("搜索 Skill 名称、内容或路径"));
        let detail_search_input =
            cx.new(|cx| InputState::new(window, cx).placeholder("搜索当前会话"));

        let workspace_roots = workspace_store.list_workspace_roots().unwrap_or_default();

        // 每个窗口有自己的事件接收端；扫描、监听和同步本身由进程级
        // BackgroundRuntime 持有，窗口关闭后不会被销毁或重复启动。
        let (tx, mut rx) = futures::channel::mpsc::unbounded::<BgEvent>();
        runtime.subscribe(tx.clone());
        runtime.ensure_started();
        let bg_tx = tx.clone();
        let events: Arc<dyn ScanEvents> = runtime.events.clone();
        let initial_scan = runtime.events.current_progress();
        let syncing_hosts = Vec::new();
        let scan_events = events.clone();

        // 事件泵跟 Workbench entity 走，而不是跟主窗口走：Settings 会在主窗口
        // 关闭后继续持有 Workbench；若这里绑定 window，update_in 会失败并让
        // scan.scanning 永远收不到终态，后续 location 变更也无法再补扫。
        let main_window = window.window_handle();
        cx.spawn(async move |this, cx| {
            while let Some(ev) = rx.next().await {
                let note = match this.update(cx, |this, cx| this.on_bg_event(ev, cx)) {
                    Ok(note) => note,
                    Err(_) => break,
                };
                // 主窗口已关闭时状态仍正常收尾，只是不再尝试展示无处承载的
                // 完成通知。后台刷新不应顺手关闭用户正在使用的搜索面板。
                if let Some(note) = note {
                    main_window
                        .update(cx, |_, window, cx| window.push_notification(note, cx))
                        .ok();
                }
            }
        })
        .detach();

        let subs = vec![
            cx.subscribe_in(&list_state, window, Self::on_list_event),
            cx.subscribe_in(&palette_list, window, Self::on_palette_event),
            cx.subscribe_in(&palette_input, window, Self::on_palette_input_event),
            cx.subscribe_in(&compression_query, window, Self::on_compression_query_event),
            cx.subscribe_in(&skill_query, window, Self::on_skill_query_event),
            cx.subscribe_in(&detail_search_input, window, Self::on_detail_search_event),
        ];

        let mut this = Self {
            focus_handle: cx.focus_handle(),
            runtime,
            store,
            workspace_store,
            adapters,
            data_locations,
            selected_agent: None,
            selected_project: None,
            selected_tag: None,
            selected_model: None,
            pending_link_parent: None,
            pending_link_child: None,
            sort_key: SortKey::Updated,
            sort_ascending: false,
            favorite_only: false,
            agent_counts: Vec::new(),
            remote_cache_bytes: None,
            projects: Vec::new(),
            tag_counts: Vec::new(),
            agents_collapsed: false,
            projects_collapsed: false,
            tags_collapsed: false,
            relationship_tree_collapsed: true,
            relationship_parents_collapsed: false,
            relationship_children_collapsed: false,
            starred_count: 0,
            scan: initial_scan,
            refreshing: false,
            pending_rescan: false,
            syncing_hosts,
            pending_sync: Vec::new(),
            bg_tx,
            settings_window: None,
            settings_page: SettingsPage::General,
            update_status: UpdateStatus::Idle,
            laya_external_capabilities: None,
            total_sessions: 0,
            list_state,
            palette_list,
            palette_input,
            lang_generation: crate::i18n::generation(),
            _palette_search_task: None,
            _list_seek_task: None,
            pending_list_selection: None,
            _calendar_task: None,
            detail_selection_auto_scroll: AutoScroll::default(),
            detail: None,
            sidebar_collapsed: false,
            detail_outline_collapsed: false,
            detail_outline_mode: DetailOutlineMode::All,
            detail_search_open: false,
            detail_search_input,
            image_action_feedback_generation: 0,
            page: Page::Sessions,
            compression_selected: None,
            compression_query,
            compression_documents: Vec::new(),
            compression_indexed_documents: 0,
            compression_search_degraded: false,
            compression_search_loading: false,
            compression_search_error: None,
            compression_last_query: String::new(),
            compression_search_task: None,
            relationship_edges: Vec::new(),
            skill_query,
            cleanup: cleanup::CleanupState::default(),
            memory: memory::MemoryState::default(),
            skills: skills::SkillsState::default(),
            insights: None,
            insights_agent: None,
            insights_loading: false,
            insights_time_range: InsightsTimeRange::All,
            insights_range_before_day: None,
            insights_range: InsightsRange::Hour,
            insights_metrics: [InsightsMetric::Sessions; 3],
            insights_top_n: TopN::all(),
            insights_selected: None,
            insights_period: None,
            insights_period_loading: false,
            insights_period_task: None,
            insights_lookup_view: LookupView::All,
            insights_task: None,
            insights_subview: InsightsSubview::Overview,
            workspace_roots,
            workspace_change_project: None,
            workspace_change_events: Vec::new(),
            session_change_groups: Vec::new(),
            session_change_events: Vec::new(),
            session_change_loading: false,
            session_change_error: None,
            session_change_selected: None,
            session_change_open_sessions: HashSet::new(),
            session_change_inspector: None,
            session_change_picker_open: false,
            session_change_picker_query,
            session_change_picker_sessions: Vec::new(),
            session_change_picker_total: 0,
            session_change_picker_selected: HashSet::new(),
            session_change_request: 0,
            session_change_task: None,
            workspace_change_range: WorkspaceChangeRange::Days7,
            workspace_change_kind: None,
            workspace_change_sort_ascending: false,
            session_change_range: WorkspaceChangeRange::Days7,
            session_change_kind: None,
            session_change_sort_ascending: false,
            workspace_change_open_folders: HashSet::new(),
            workspace_change_open_files: HashSet::new(),
            workspace_change_loading: false,
            workspace_change_has_more: true,
            workspace_change_error: None,
            workspace_change_request: 0,
            workspace_change_selected: None,
            workspace_change_detail: None,
            workspace_change_detail_loading: false,
            workspace_change_detail_error: None,
            workspace_change_detail_request: 0,
            workspace_change_task: None,
            workspace_change_detail_task: None,
            scan_events,
            terminal_icons: HashMap::new(),
            preferred_terminal: HashMap::new(),
            last_terminal: None,
            _subs: subs,
        };
        this.load_open_in_prefs();
        this.load_cleanup_prefs();
        this.refresh(cx);
        this.maybe_start_managed_laya();
        this._calendar_task = Some(cx.spawn(async move |this, cx| loop {
            cx.background_executor()
                .timer(std::time::Duration::from_secs(60))
                .await;
            if this
                .update(cx, |this, cx| {
                    if this.page == Page::Insights
                        && matches!(
                            this.insights_time_range,
                            InsightsTimeRange::Custom { live_end: true, .. }
                        )
                        && this.insights_selected.is_none()
                    {
                        this.reload_insights(cx);
                    }
                    cx.notify();
                })
                .is_err()
            {
                break;
            }
        }));

        // 索引重建过就告诉用户一声——收藏/置顶没了,总得让人知道为什么。
        // defer 到下一帧:此刻 Root 还没建好,notification 层挂不上
        if let Some(note) = db_note {
            cx.defer_in(window, move |_, window, cx| {
                window.push_notification(Notification::warning(note), cx);
            });
        }

        // 终端应用图标后台提取(首次数百 ms,之后命中缓存)
        let icons_task = cx.background_spawn(async {
            let dir = dirs::data_dir()
                .unwrap_or_default()
                .join("wake")
                .join("app-icons");
            terminal::ensure_app_icons(&dir)
        });
        cx.spawn_in(window, async move |this, cx| {
            let icons = icons_task.await;
            this.update(cx, |this, cx| {
                this.terminal_icons = icons;
                cx.notify();
            })
            .ok();
        })
        .detach();
        this
    }

    // ---------- 数据刷新 ----------

    fn current_filter(&self) -> SessionFilter {
        SessionFilter {
            agents: self.selected_agent.into_iter().collect(),
            favorite_only: self.favorite_only,
            include_archived: false,
            roots_only: !self.favorite_only,
            title_query: None,
            sort: self.sort_key,
            ascending: self.sort_ascending,
            limit: SESSION_PAGE_SIZE,
            offset: 0,
            updated_since: None,
            project_paths: self.selected_project.clone().into_iter().collect(),
            tags: self.selected_tag.clone().into_iter().collect(),
            models: self.selected_model.clone().into_iter().collect(),
            ignore_pins: false,
        }
    }

    fn selected_list_key(&self, cx: &App) -> Option<String> {
        let list = self.list_state.read(cx);
        let delegate = list.delegate();
        list.selected_index()
            .and_then(|path| delegate.row_key(path))
            .map(str::to_string)
    }

    fn refresh(&mut self, cx: &mut Context<Self>) {
        let mut filter = self.current_filter();
        let selected_key = self
            .pending_list_selection
            .clone()
            .or_else(|| self.selected_list_key(cx));
        let previously_loaded = {
            let list = self.list_state.read(cx);
            let delegate = list.delegate();
            delegate
                .pagination
                .as_ref()
                .filter(|page| same_session_query(&page.filter, &filter))
                .map(|_| delegate.sessions.len())
                .unwrap_or_default()
        };
        let expanded = self.list_state.read(cx).delegate().expanded.clone();
        if previously_loaded > SESSION_PAGE_SIZE as usize {
            filter.limit = i64::try_from(previously_loaded).unwrap_or(i64::MAX);
        }
        if let Ok((sessions, total)) = self.store.list_sessions(&filter) {
            self.total_sessions = total;
            let store = self.store.clone();
            self.list_state.update(cx, |state, cx| {
                let mut delegate = SessionsDelegate::paged(sessions, filter, total, store);
                delegate.restore_expanded(expanded);
                *state.delegate_mut() = delegate;
                cx.notify();
            });
            self.pending_list_selection = selected_key;
        }
        let mut counts: Vec<(AgentId, i64)> = self
            .store
            .agent_counts()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|(k, v)| AgentId::from_str(&k).map(|a| (a, v)))
            .collect();
        // 固定排序(AgentId 声明序):按会话数排会在平局时抖动
        // (HashMap 迭代无序),每次刷新侧栏顺序都会跳
        counts.sort_by_key(|&(a, _)| a);
        self.agent_counts = counts;
        self.projects = self.store.list_projects(false).unwrap_or_default();
        self.workspace_roots = self
            .workspace_store
            .list_workspace_roots()
            .unwrap_or_default();
        self.tag_counts = self.store.session_tag_counts(false).unwrap_or_default();
        self.starred_count = self.store.starred_count().unwrap_or(0);
        self.relationship_edges = self.store.all_session_relationships().unwrap_or_default();
        // Insights / Memory 打开着就顺带重算:扫描增量/收藏变更等一切走 refresh 的
        // 路径都会让页面数据跟上,不设第二条失效通道
        self.reload_page(cx);
        cx.notify();
    }

    /// 切语言后把**缓存住的译文**补上。`refresh_windows()` 只让每帧重跑
    /// render,凡是早先存进 entity 的字符串(输入框 placeholder、列表分组
    /// 标签)都不会自己变——分组那半由 `rebuild_groups_at` 比对代次处理,
    /// 这里管 placeholder。每帧一次整数比较
    fn sync_language(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let lang = crate::i18n::generation();
        if self.lang_generation == lang {
            return;
        }
        self.lang_generation = lang;
        self.palette_input.update(cx, |state, cx| {
            state.set_placeholder(t("Search everything — prose or code"), window, cx);
        });
    }

    fn refresh_session_group_date(&mut self, cx: &mut Context<Self>) {
        let today = Local::now().date_naive();
        let selected_key = self
            .pending_list_selection
            .clone()
            .or_else(|| self.selected_list_key(cx));
        let changed = self.list_state.update(cx, |state, cx| {
            let changed = state.delegate_mut().rebuild_groups_at(today);
            if changed {
                cx.notify();
            }
            changed
        });
        if changed {
            self.pending_list_selection = selected_key;
        }
    }

    fn restore_pending_list_selection(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(key) = self.pending_list_selection.take() else {
            return;
        };
        if !self.select_list_key(&key, false, window, cx) {
            self.seek_list_key(&key, window, cx);
        }
    }

    /// 底部工具条的页切换(不是开关:再点当前页不退出)。回会话列表不动筛选;去整页
    /// 目的地时清掉三个会话筛选、Memory 的侧栏筛选也从全部开始——互斥单选,点任意
    /// 导航行都退回会话列表(`set_scope`)
    fn show_page(&mut self, page: Page, window: &mut Window, cx: &mut Context<Self>) {
        self.leave_cleanup(cx);
        if self.page == page {
            cx.notify();
            return;
        }
        if self.page == Page::Skills && !self.allow_skill_navigation(window, cx) {
            return;
        }
        self.page = page;
        if page != Page::Sessions {
            self.selected_agent = None;
            self.selected_project = None;
            self.favorite_only = false;
            self.selected_model = None;
            self.reset_memory_scope();
            self.reset_skills_scope(cx);
        }
        self.refresh(cx);
    }

    /// 打开着的整页目的地顺带重载(refresh 与扫描终态都走这里);各页自己按住
    /// "扫描中且已有数据"的情形
    fn reload_page(&mut self, cx: &mut Context<Self>) {
        match self.page {
            Page::Sessions => {}
            Page::Insights => match self.insights_subview {
                InsightsSubview::Overview => self.reload_insights(cx),
                InsightsSubview::WorkspaceChanges => self.reload_workspace_changes(true, cx),
                InsightsSubview::SessionChanges => self.reload_session_changes(cx),
            },
            Page::Memory => self.reload_memories(cx),
            Page::Skills => self.reload_skills(cx),
            Page::Compressions => self.reload_compressions(cx),
            Page::Relationships => {}
        }
    }

    fn set_insights_subview(&mut self, subview: InsightsSubview, cx: &mut Context<Self>) {
        if self.insights_subview == subview {
            return;
        }
        self.insights_subview = subview;
        if subview == InsightsSubview::WorkspaceChanges {
            self.reload_workspace_changes(true, cx);
        } else if subview == InsightsSubview::SessionChanges {
            self.reload_session_changes(cx);
        }
        cx.notify();
    }

    fn reload_session_changes(&mut self, cx: &mut Context<Self>) {
        if self.page != Page::Insights || self.insights_subview != InsightsSubview::SessionChanges {
            return;
        }
        self.session_change_loading = true;
        self.session_change_error = None;
        self.session_change_request = self.session_change_request.wrapping_add(1);
        let request = self.session_change_request;
        let store = self.workspace_store.clone();
        let sessions = self.store.clone();
        let task = cx.background_spawn(async move {
            wake_core::services::session_changes::list_selected_activities(
                &store,
                &sessions,
                None,
                5000,
            )
        });
        self.session_change_task = Some(cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| {
                if this.session_change_request != request {
                    return;
                }
                match result {
                    Ok(groups) => {
                        this.session_change_events = groups
                            .iter()
                            .flat_map(|group| {
                                group
                                    .folders
                                    .iter()
                                    .flat_map(|folder| {
                                        folder.files.iter().flat_map(|file| file.events.clone())
                                    })
                                    .chain(
                                        group
                                            .root_files
                                            .iter()
                                            .flat_map(|file| file.events.clone()),
                                    )
                            })
                            .collect();
                        this.session_change_groups = groups;
                    }
                    Err(error) => this.session_change_error = Some(format!("{error:#}")),
                }
                this.session_change_loading = false;
                cx.notify();
            })
            .ok();
        }));
    }

    fn toggle_session_change_event(&mut self, id: i64, cx: &mut Context<Self>) {
        self.session_change_selected = (self.session_change_selected != Some(id)).then_some(id);
        cx.notify();
    }

    fn set_session_change_membership(
        &mut self,
        key: String,
        selected: bool,
        cx: &mut Context<Self>,
    ) {
        let workspace = self.workspace_store.clone();
        let sessions = self.store.clone();
        let query_key = key.clone();
        let query = cx.background_spawn(async move {
            if selected {
                wake_core::services::session_changes::select_session(
                    &workspace,
                    &sessions,
                    &query_key,
                )
            } else {
                wake_core::services::session_changes::deselect_session(&workspace, &query_key)
            }
        });
        cx.spawn(async move |this, cx| {
            let result = query.await;
            this.update(cx, |this, cx| {
                match result {
                    Ok(_) => {
                        this.session_change_inspector = None;
                        this.reload_session_changes(cx);
                    }
                    Err(error) => {
                        this.session_change_error = Some(format!("{error:#}"));
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn open_session_change_picker(&mut self, cx: &mut Context<Self>) {
        let filter = SessionFilter {
            sort: SortKey::Updated,
            limit: 500,
            ..SessionFilter::default()
        };
        match self.store.list_sessions(&filter) {
            Ok((sessions, total)) => {
                self.session_change_picker_sessions = sessions;
                self.session_change_picker_total = total;
                self.session_change_picker_selected = self
                    .session_change_groups
                    .iter()
                    .map(|group| group.session_key.clone())
                    .collect();
                self.session_change_picker_open = true;
            }
            Err(error) => {
                self.session_change_error = Some(format!("读取可选会话失败：{error:#}"));
            }
        }
        cx.notify();
    }

    fn load_more_session_change_picker(&mut self, cx: &mut Context<Self>) {
        let offset = self.session_change_picker_sessions.len() as i64;
        if offset >= self.session_change_picker_total {
            return;
        }
        let filter = SessionFilter {
            sort: SortKey::Updated,
            limit: 500,
            offset,
            ..SessionFilter::default()
        };
        match self.store.list_sessions(&filter) {
            Ok((sessions, total)) => {
                self.session_change_picker_total = total;
                self.session_change_picker_sessions.extend(sessions);
            }
            Err(error) => {
                self.session_change_error = Some(format!("继续读取会话失败：{error:#}"));
            }
        }
        cx.notify();
    }

    fn apply_session_change_picker(&mut self, cx: &mut Context<Self>) {
        let current = self
            .session_change_groups
            .iter()
            .map(|group| group.session_key.clone())
            .collect::<HashSet<_>>();
        let selected = self.session_change_picker_selected.clone();
        let changes = current
            .iter()
            .filter(|key| !selected.contains(*key))
            .cloned()
            .map(|key| (key, false))
            .chain(
                selected
                    .iter()
                    .filter(|key| !current.contains(*key))
                    .cloned()
                    .map(|key| (key, true)),
            )
            .collect::<Vec<_>>();
        let first_added = changes
            .iter()
            .find_map(|(key, selected)| (*selected).then(|| key.clone()));
        self.session_change_picker_open = false;
        if changes.is_empty() {
            cx.notify();
            return;
        }

        let workspace = self.workspace_store.clone();
        let sessions = self.store.clone();
        let task = cx.background_spawn(async move {
            for (key, selected) in changes {
                if selected {
                    wake_core::services::session_changes::select_session(
                        &workspace, &sessions, &key,
                    )?;
                } else {
                    wake_core::services::session_changes::deselect_session(&workspace, &key)?;
                }
            }
            Ok::<(), anyhow::Error>(())
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| {
                match result {
                    Ok(()) => {
                        if first_added.is_some() {
                            this.session_change_range = WorkspaceChangeRange::All;
                            this.session_change_kind = None;
                            this.session_change_inspector = None;
                        }
                        this.reload_session_changes(cx);
                    }
                    Err(error) => {
                        this.session_change_error = Some(format!("更新已选会话失败：{error:#}"));
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    fn add_workspace_root(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let rx = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some(t("Choose").into()),
        });
        cx.spawn_in(window, async move |this, cx| {
            let path = match rx.await {
                Ok(Ok(Some(paths))) => paths.into_iter().next(),
                _ => None,
            };
            let Some(path) = path else { return };
            this.update(cx, |this, cx| {
                let store = this.workspace_store.clone();
                let task = cx.background_spawn(async move { store.add_workspace_root(&path) });
                cx.spawn(async move |this, cx| {
                    let result = task.await;
                    this.update(cx, |this, cx| {
                        match result {
                            Ok(root) => {
                                this.workspace_roots = this
                                    .workspace_store
                                    .list_workspace_roots()
                                    .unwrap_or_default();
                                this.runtime.request_workspace_refresh();
                                this.select_workspace_change_project(root.path, cx);
                                let _ = this.bg_tx.unbounded_send(BgEvent::WorkspaceChangesChanged);
                            }
                            Err(error) => {
                                eprintln!("could not add workspace root: {error:#}");
                                this.workspace_change_error =
                                    Some(format!("无法添加监控目录：{error:#}"));
                            }
                        }
                        cx.notify();
                    })
                    .ok();
                })
                .detach();
            })
            .ok();
        })
        .detach();
    }

    fn remove_workspace_root(&mut self, path: String, cx: &mut Context<Self>) {
        let selected = self.workspace_change_project.as_deref() == Some(path.as_str());
        // Update the view before touching SQLite. A large initial import can
        // otherwise make this UI action wait behind the workspace write lock.
        self.workspace_roots.retain(|root| root.path != path);
        if selected {
            self.workspace_change_project =
                self.workspace_roots.first().map(|root| root.path.clone());
            self.workspace_change_events.clear();
            self.workspace_change_selected = None;
            self.workspace_change_detail = None;
        }
        cx.notify();

        let store = self.workspace_store.clone();
        let removed_path = path.clone();
        let task = cx.background_spawn(async move { store.remove_workspace_root(&removed_path) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| {
                match result {
                    Ok(()) => {
                        this.runtime.request_workspace_refresh();
                        this.workspace_change_error = None;
                        if selected {
                            this.reload_workspace_changes(true, cx);
                        }
                        let _ = this.bg_tx.unbounded_send(BgEvent::WorkspaceChangesChanged);
                    }
                    Err(error) => {
                        eprintln!("could not remove workspace root {path}: {error:#}");
                        this.workspace_roots = this
                            .workspace_store
                            .list_workspace_roots()
                            .unwrap_or_default();
                        this.workspace_change_error = Some(format!("无法移除监控目录：{error:#}"));
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn select_workspace_change_project(&mut self, path: String, cx: &mut Context<Self>) {
        if self.workspace_change_project.as_deref() == Some(path.as_str()) {
            return;
        }
        self.workspace_change_project = Some(path);
        self.workspace_change_events.clear();
        self.workspace_change_open_folders.clear();
        self.workspace_change_open_files.clear();
        self.workspace_change_selected = None;
        self.workspace_change_detail = None;
        self.workspace_change_detail_error = None;
        self.workspace_change_detail_loading = false;
        self.workspace_change_detail_request = self.workspace_change_detail_request.wrapping_add(1);
        self.workspace_change_detail_task = None;
        self.reload_workspace_changes(true, cx);
        cx.notify();
    }

    fn reload_workspace_changes(&mut self, reset: bool, cx: &mut Context<Self>) {
        if self.page != Page::Insights || self.insights_subview != InsightsSubview::WorkspaceChanges
        {
            return;
        }
        if self.workspace_change_loading && !reset {
            return;
        }
        let project_path = self
            .workspace_change_project
            .clone()
            .or_else(|| self.workspace_roots.first().map(|root| root.path.clone()));
        let Some(project_path) = project_path.filter(|path| !path.trim().is_empty()) else {
            self.workspace_change_request = self.workspace_change_request.wrapping_add(1);
            self.workspace_change_events.clear();
            self.workspace_change_project = None;
            self.workspace_change_loading = false;
            self.workspace_change_has_more = false;
            self.workspace_change_error = None;
            self.workspace_change_selected = None;
            self.workspace_change_detail = None;
            cx.notify();
            return;
        };
        self.workspace_change_project = Some(project_path.clone());
        self.workspace_change_loading = true;
        self.workspace_change_error = None;
        self.workspace_change_request = self.workspace_change_request.wrapping_add(1);
        let request = self.workspace_change_request;
        let before = if reset {
            None
        } else {
            self.workspace_change_events
                .last()
                .map(|event| (event.observed_at, event.id))
        };
        let store = self.workspace_store.clone();
        let query_project_path = project_path.clone();
        let query = cx.background_spawn(async move {
            store.list_workspace_change_events(&query_project_path, before, 100)
        });
        self.workspace_change_task = Some(cx.spawn(async move |this, cx| {
            let result = query.await;
            this.update(cx, |this, cx| {
                if this.workspace_change_request != request
                    || this.workspace_change_project.as_deref() != Some(project_path.as_str())
                {
                    return;
                }
                match result {
                    Ok(events) => {
                        this.workspace_change_has_more = events.len() == 100;
                        if reset {
                            if this
                                .workspace_change_selected
                                .is_some_and(|id| !events.iter().any(|event| event.id == id))
                            {
                                this.workspace_change_selected = None;
                                this.workspace_change_detail = None;
                                this.workspace_change_detail_error = None;
                                this.workspace_change_detail_loading = false;
                                this.workspace_change_detail_request =
                                    this.workspace_change_detail_request.wrapping_add(1);
                                this.workspace_change_detail_task = None;
                            }
                            this.workspace_change_events = events;
                        } else {
                            this.workspace_change_events.extend(events);
                        }
                    }
                    Err(error) => this.workspace_change_error = Some(format!("{error:#}")),
                }
                this.workspace_change_loading = false;
                cx.notify();
            })
            .ok();
        }));
    }

    fn select_workspace_change_event(&mut self, id: i64, cx: &mut Context<Self>) {
        if self.workspace_change_selected == Some(id) {
            self.workspace_change_selected = None;
            self.workspace_change_detail = None;
            self.workspace_change_detail_error = None;
            self.workspace_change_detail_request =
                self.workspace_change_detail_request.wrapping_add(1);
            self.workspace_change_detail_task = None;
            cx.notify();
            return;
        }
        self.workspace_change_selected = Some(id);
        self.workspace_change_detail = None;
        self.workspace_change_detail_loading = true;
        self.workspace_change_detail_error = None;
        self.workspace_change_detail_request = self.workspace_change_detail_request.wrapping_add(1);
        let request = self.workspace_change_detail_request;
        let store = self.workspace_store.clone();
        let query = cx.background_spawn(async move { store.workspace_change_detail(id) });
        self.workspace_change_detail_task = Some(cx.spawn(async move |this, cx| {
            let result = query.await;
            this.update(cx, |this, cx| {
                if this.workspace_change_detail_request != request
                    || this.workspace_change_selected != Some(id)
                {
                    return;
                }
                match result {
                    Ok(detail) => this.workspace_change_detail = detail,
                    Err(error) => this.workspace_change_detail_error = Some(format!("{error:#}")),
                }
                this.workspace_change_detail_loading = false;
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    fn toggle_workspace_folder(&mut self, key: String, cx: &mut Context<Self>) {
        if !self.workspace_change_open_folders.remove(&key) {
            self.workspace_change_open_folders.insert(key);
        }
        cx.notify();
    }

    fn toggle_workspace_file(&mut self, key: String, cx: &mut Context<Self>) {
        if !self.workspace_change_open_files.remove(&key) {
            self.workspace_change_open_files.insert(key);
        }
        cx.notify();
    }

    fn confirm_delete_workspace_change(
        &mut self,
        id: i64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let entity = cx.entity();
        window.open_alert_dialog(cx, move |dialog, _window, cx| {
            let entity = entity.clone();
            dialog
                .title(
                    div()
                        .text_size(FONT_HEADING)
                        .font_semibold()
                        .child("删除这条工作区改动记录？"),
                )
                .width(px(440.))
                .confirm()
                .button_props(
                    gpui_component::dialog::DialogButtonProps::default()
                        .ok_text("删除")
                        .ok_variant(gpui_component::button::ButtonVariant::Danger),
                )
                .child(
                    div()
                        .text_size(FONT_BODY)
                        .text_color(cx.theme().foreground)
                        .child(
                            "只删除 ContextOS 时间线中的这条记录，不删除工作区文件、基线或快照。",
                        ),
                )
                .on_ok(move |_, window, cx| {
                    entity.update(cx, |this, cx| {
                        this.delete_workspace_change(id, window, cx);
                    });
                    true
                })
        });
    }

    fn delete_workspace_change(&mut self, id: i64, _window: &mut Window, cx: &mut Context<Self>) {
        let store = self.workspace_store.clone();
        let task = cx.background_spawn(async move { store.delete_workspace_change(id) });
        self.workspace_change_loading = true;
        cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| {
                match result {
                    Ok(true) => {
                        if this.workspace_change_selected == Some(id) {
                            this.workspace_change_selected = None;
                            this.workspace_change_detail = None;
                            this.workspace_change_detail_error = None;
                            this.workspace_change_detail_loading = false;
                            this.workspace_change_detail_request =
                                this.workspace_change_detail_request.wrapping_add(1);
                            this.workspace_change_detail_task = None;
                        }
                        this.workspace_change_error = None;
                        this.reload_workspace_changes(true, cx);
                    }
                    Ok(false) => {
                        this.workspace_change_loading = false;
                        this.workspace_change_error = Some(format!("找不到工作区改动记录：{id}"));
                    }
                    Err(error) => {
                        this.workspace_change_loading = false;
                        this.workspace_change_error =
                            Some(format!("删除工作区改动失败：{error:#}"));
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// messages 全表分桶几十毫秒量级,走后台;已有数据时静默换新不闪 loading。
    /// 扫描进行中 Changed 事件每秒都来,有旧数据就先按住——终态 Progress
    /// 会补最后一次;新任务覆盖 insights_task 即取消旧查询,不堆积读锁竞争
    fn reload_insights(&mut self, cx: &mut Context<Self>) {
        if self.page != Page::Insights {
            return;
        }
        if self.scan.scanning && self.insights.is_some() {
            return;
        }
        self.insights_loading = self.insights.is_none();
        let store = self.store.clone();
        let agent = self.insights_agent;
        let range = self.insights_time_range;
        let selected = self.insights_selected;
        let (start_ms, end_ms) = selected.map_or_else(
            || range.bounds(Local::now().date_naive()),
            InsightsTimeRange::day_bounds,
        );
        let task = cx.background_spawn(async move {
            store.insights_for_agent_range(Local::now().date_naive(), agent, start_ms, end_ms)
        });
        self.insights_task = Some(cx.spawn(async move |this, cx| {
            let data = task.await;
            this.update(cx, |this, cx| {
                if this.insights_agent == agent
                    && this.insights_time_range == range
                    && this.insights_selected == selected
                {
                    if let Ok(data) = data {
                        this.insights = Some(Rc::new(data));
                    }
                    this.insights_loading = false;
                    cx.notify();
                }
            })
            .ok();
        }));
        // 选中态下的周期快照同样来自 messages,整库重扫后一并刷新——
        // 否则热力图的格子变了、三档分布还停在旧数字
        if self.insights_selected.is_some() {
            self.reload_insights_period(cx);
        }
    }

    fn set_insights_agent(&mut self, agent: Option<AgentId>, cx: &mut Context<Self>) {
        if self.insights_agent == agent {
            return;
        }
        self.insights_agent = agent;
        self.insights = None;
        self.insights_selected = None;
        self.insights_range_before_day = None;
        self.insights_period = None;
        self.insights_period_loading = false;
        self.insights_period_task = None;
        self.reload_insights(cx);
        cx.notify();
    }

    fn set_insights_time_range(&mut self, range: InsightsTimeRange, cx: &mut Context<Self>) {
        if self.insights_time_range == range && self.insights_selected.is_none() {
            return;
        }
        self.insights_time_range = range;
        self.insights_selected = None;
        self.insights_range_before_day = None;
        self.insights = None;
        self.insights_period = None;
        self.insights_period_loading = false;
        self.insights_period_task = None;
        self.reload_insights(cx);
        cx.notify();
    }

    fn open_insights_custom_range(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let now = Local::now();
        let (start_day, start_clock, end_day, end_clock, live_end) = match self.insights_time_range
        {
            InsightsTimeRange::Custom {
                start_ms,
                end_ms,
                live_end,
            } => {
                let start = chrono::DateTime::from_timestamp_millis(start_ms)
                    .map(|dt| dt.with_timezone(&Local))
                    .unwrap_or(now);
                let end = if live_end {
                    now
                } else {
                    chrono::DateTime::from_timestamp_millis(end_ms)
                        .map(|dt| dt.with_timezone(&Local))
                        .unwrap_or(now)
                };
                (
                    start.date_naive(),
                    start.time(),
                    end.date_naive(),
                    end.time(),
                    live_end,
                )
            }
            _ => {
                let start = now.date_naive() - chrono::Days::new(6);
                (
                    start,
                    chrono::NaiveTime::MIN,
                    now.date_naive(),
                    now.time(),
                    true,
                )
            }
        };
        let date_text = |date: NaiveDate| date.format("%Y-%m-%d").to_string();
        let time_text = |time: chrono::NaiveTime| time.format("%H:%M").to_string();
        let start_date_input = cx.new(|cx| InputState::new(window, cx));
        let start_time_input = cx.new(|cx| InputState::new(window, cx));
        let end_date_input = cx.new(|cx| InputState::new(window, cx));
        let end_time_input = cx.new(|cx| InputState::new(window, cx));
        start_date_input.update(cx, |state, cx| {
            state.set_value(date_text(start_day), window, cx)
        });
        start_time_input.update(cx, |state, cx| {
            state.set_value(time_text(start_clock), window, cx)
        });
        end_date_input.update(cx, |state, cx| {
            state.set_value(date_text(end_day), window, cx)
        });
        end_time_input.update(cx, |state, cx| {
            state.set_value(time_text(end_clock), window, cx)
        });
        let live_end_state = Rc::new(Cell::new(live_end));
        let entity = cx.entity();
        window.open_dialog(cx, move |dialog, _window, cx| {
            let theme = cx.theme();
            let inset = BUTTON_SM_PX;
            let start_date_value = start_date_input.clone();
            let start_time_value = start_time_input.clone();
            let end_date_value = end_date_input.clone();
            let end_time_value = end_time_input.clone();
            let live_end_value = live_end_state.clone();
            let live_end_checkbox_value = live_end_state.clone();
            let entity = entity.clone();
            dialog
                .title(
                    div()
                        .pl(inset)
                        .text_size(FONT_HEADING)
                        .font_semibold()
                        .child(t("Custom date range")),
                )
                .w(px(520.))
                .button_props(
                    gpui_component::dialog::DialogButtonProps::default().ok_text(t("Apply")),
                )
                .child(
                    v_flex()
                        .gap(SPACE_MD)
                        .child(
                            h_flex()
                                .px(inset)
                                .gap(SPACE_SM)
                                .items_center()
                                .child(
                                    div()
                                        .w(px(72.))
                                        .text_color(theme.muted_foreground)
                                        .child(t("Start")),
                                )
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .child(Input::new(&start_date_input)),
                                )
                                .child(div().w(px(96.)).child(Input::new(&start_time_input))),
                        )
                        .child(
                            h_flex()
                                .px(inset)
                                .gap(SPACE_SM)
                                .items_center()
                                .child(
                                    div()
                                        .w(px(72.))
                                        .text_color(theme.muted_foreground)
                                        .child(t("End")),
                                )
                                .child(div().flex_1().min_w_0().child(Input::new(&end_date_input)))
                                .child(div().w(px(96.)).child(Input::new(&end_time_input))),
                        )
                        .child(
                            h_flex().px(inset).items_center().child(
                                gpui_component::checkbox::Checkbox::new("insights-live-end")
                                    .label(t("End time follows now"))
                                    .checked(live_end)
                                    .on_click(move |checked, _, _| {
                                        live_end_checkbox_value.set(*checked);
                                    }),
                            ),
                        )
                        .child(
                            div()
                                .px(inset)
                                .text_size(FONT_CAPTION)
                                .text_color(theme.muted_foreground)
                                .child(t("Use YYYY-MM-DD and 24-hour HH:mm format.")),
                        ),
                )
                .on_ok(move |_, window, cx| {
                    let parse_date_time = |date: &str, time: &str| {
                        let date = NaiveDate::parse_from_str(date.trim(), "%Y-%m-%d").ok()?;
                        let time = chrono::NaiveTime::parse_from_str(time.trim(), "%H:%M").ok()?;
                        Local
                            .from_local_datetime(&date.and_time(time))
                            .single()
                            .map(|datetime| datetime.timestamp_millis())
                    };
                    let Some(start_ms) = parse_date_time(
                        &start_date_value.read(cx).text().to_string(),
                        &start_time_value.read(cx).text().to_string(),
                    ) else {
                        window.push_notification(
                            Notification::error(t("Enter a valid start date and time.")),
                            cx,
                        );
                        return false;
                    };
                    let live_end = live_end_value.get();
                    let end_ms = if live_end {
                        Local::now().timestamp_millis()
                    } else {
                        let Some(end_ms) = parse_date_time(
                            &end_date_value.read(cx).text().to_string(),
                            &end_time_value.read(cx).text().to_string(),
                        ) else {
                            window.push_notification(
                                Notification::error(t("Enter a valid end date and time.")),
                                cx,
                            );
                            return false;
                        };
                        end_ms.saturating_add(60_000)
                    };
                    if start_ms >= end_ms {
                        window.push_notification(
                            Notification::error(t("Start must be earlier than end.")),
                            cx,
                        );
                        return false;
                    }
                    entity.update(cx, |this, cx| {
                        this.set_insights_time_range(
                            InsightsTimeRange::Custom {
                                start_ms,
                                end_ms,
                                live_end,
                            },
                            cx,
                        );
                    });
                    true
                })
        });
    }

    /// 热力图点选某天:再点同一格取消。三档分布与趋势高亮都跟着
    /// `insights_selected` 走,所以只在这里改状态 + 取一次周期数据
    fn toggle_insights_day(&mut self, day: chrono::NaiveDate, cx: &mut Context<Self>) {
        if self.insights_selected == Some(day) {
            // 再点同一天:恢复点击前的预设范围。
            self.insights_selected = None;
            self.insights_time_range = self
                .insights_range_before_day
                .take()
                .unwrap_or(self.insights_time_range);
            self.insights = None;
            self.insights_period = None;
            self.insights_period_loading = false;
            self.insights_period_task = None;
            self.reload_insights(cx);
            cx.notify();
            return;
        }
        if self.insights_selected.is_none() {
            self.insights_range_before_day = Some(self.insights_time_range);
        }
        self.insights_selected = Some(day);
        self.insights = None;
        self.insights_period = None;
        self.reload_insights(cx);
    }

    /// 取选中日的周期细分。与 reload_insights 同形:后台查询 + 回主线程写快照;
    /// 新选中覆盖旧任务即取消(连点多个日子不会堆积读锁竞争)
    fn reload_insights_period(&mut self, cx: &mut Context<Self>) {
        let Some(day) = self.insights_selected else {
            return;
        };
        self.insights_period_loading = true;
        let store = self.store.clone();
        let agent = self.insights_agent;
        let task = cx.background_spawn(async move { store.period_breakdown_for_agent(day, agent) });
        self.insights_period_task = Some(cx.spawn(async move |this, cx| {
            let data = task.await;
            this.update(cx, |this, cx| {
                // 只认当前选中日的快照:任务在途中用户又点了别的天或取消选中,
                // 迟到的结果不得覆盖(与 insights_task 的"覆盖即取消"同效)
                if this.insights_selected == Some(day) && this.insights_agent == agent {
                    this.insights_period = data.ok().map(Rc::new);
                    this.insights_period_loading = false;
                    cx.notify();
                }
            })
            .ok();
        }));
        cx.notify();
    }

    /// 手动刷新会话。刷新中忽略重复触发；未变化的文件不重新解析。
    /// 扫描在后台进行，侧栏持续显示进度；浏览、搜索和阅读不被阻断。
    fn refresh_sessions(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        if self.scan.scanning {
            return;
        }
        self.scan = ScanProgress {
            scanning: true,
            ..Default::default()
        };
        self.refreshing = true;
        cx.notify();
        spawn_scan(
            self.adapters.clone(),
            self.store.clone(),
            self.scan_events.clone(),
            false,
        );
        self.sync_all_remote_hosts(cx);
    }

    pub(crate) fn refresh_from_tray(&mut self, cx: &mut Context<Self>) {
        if self.scan.scanning {
            return;
        }
        self.scan = ScanProgress {
            scanning: true,
            ..Default::default()
        };
        self.refreshing = true;
        cx.notify();
        spawn_scan(
            self.adapters.clone(),
            self.store.clone(),
            self.scan_events.clone(),
            false,
        );
        self.sync_all_remote_hosts(cx);
    }

    /// Settings/Locations 页的数据快照。路径与 active roster 来自同一次
    /// adapter 构造，因此停用项仍然可见，环境变量根也不会二次探测后错位。
    pub(crate) fn location_settings_snapshot(&self) -> LocationSettingsSnapshot {
        let mut flat = self.data_locations.as_ref().clone();
        // 自定义根紧随所属 agent 的默认根；同家内部保持 adapter 声明顺序。
        flat.sort_by_key(|location| location.agent);
        let prefixes: Vec<(String, String)> = flat
            .iter()
            .map(|location| {
                (
                    location.agent.as_str().to_string(),
                    location.path.to_string_lossy().to_string(),
                )
            })
            .collect();
        let counts = self
            .store
            .counts_by_path_prefix(&prefixes)
            .unwrap_or_else(|_| vec![0; prefixes.len()]);
        let (customs, removed, removed_roots) = self.store.location_overrides();
        let customs: Vec<(AgentId, SharedString)> = customs
            .into_iter()
            .map(|(agent, path)| {
                (
                    agent,
                    SharedString::from(path.to_string_lossy().to_string()),
                )
            })
            .collect();
        let rows = flat
            .iter()
            .zip(prefixes)
            .zip(counts)
            .map(|((location, (_, raw)), count)| {
                let exists = location.path.exists();
                DataSourceRow {
                    agent: location.agent,
                    display: tilde_path(&raw).into(),
                    raw: raw.clone().into(),
                    tally: if exists {
                        session_tally(count).into()
                    } else {
                        t("Folder not found").into()
                    },
                    exists,
                    custom: custom_owner(&customs, location.agent, &raw).cloned(),
                    individual_default: location.individually_removable,
                    enabled: location.enabled,
                }
            })
            .collect();
        let diverged = !customs.is_empty()
            || !removed.is_empty()
            || !removed_roots.is_empty()
            || self.data_locations.iter().any(|location| !location.enabled);
        LocationSettingsSnapshot { rows, diverged }
    }

    pub(crate) fn data_settings_snapshot(&self) -> DataSettingsSnapshot {
        let path = wake_core::db::default_db_path();
        let raw = path.to_string_lossy().to_string();
        let index_bytes: u64 = ["", "-wal", "-shm"]
            .iter()
            .filter_map(|suffix| std::fs::metadata(format!("{raw}{suffix}")).ok())
            .map(|metadata| metadata.len())
            .sum();
        let remote_bytes = self.remote_cache_bytes.unwrap_or(0);
        DataSettingsSnapshot {
            display_path: tilde_path(&raw).into(),
            raw_path: raw.into(),
            size_bytes: index_bytes + remote_bytes,
            remote_bytes,
            session_count: self.session_total(),
        }
    }

    pub(crate) fn retention_settings_snapshot(
        &self,
    ) -> Vec<wake_core::services::session_retention::RetentionSnapshot> {
        wake_core::services::session_retention::current_snapshots()
    }

    pub(crate) fn save_retention_period(
        &self,
        agent: wake_core::services::session_retention::RetentionAgent,
        value: &str,
    ) -> Result<Vec<wake_core::services::session_retention::RetentionSnapshot>, String> {
        wake_core::services::session_retention::write_current(agent, value)
            .map_err(|error| format!("{error:#}"))
    }

    pub(crate) fn codex_compression_snapshot(
        &self,
    ) -> wake_core::services::codex_session_compression::CodexCompressionSnapshot {
        wake_core::services::codex_session_compression::current_snapshot()
    }

    pub(crate) fn set_codex_compression_enabled(
        &self,
        enabled: bool,
    ) -> wake_core::services::codex_session_compression::CodexCompressionSnapshot {
        wake_core::services::codex_session_compression::set_current_enabled(enabled)
    }

    /// 库内会话总数(各 agent 计数之和;侧栏 All Sessions、Data / Connect 页共用)
    pub(crate) fn session_total(&self) -> i64 {
        self.agent_counts.iter().map(|(_, n)| n).sum()
    }

    pub(crate) fn settings_page(&self) -> SettingsPage {
        self.settings_page
    }

    pub(crate) fn update_status(&self) -> &UpdateStatus {
        &self.update_status
    }

    pub(crate) fn select_settings_page(&mut self, page: SettingsPage, cx: &mut Context<Self>) {
        self.settings_page = page;
        cx.notify();
    }

    pub(crate) fn jev_config(&self) -> JevConfig {
        let service = wake_core::services::compression_settings::load_settings(&self.store).service;
        let (api_url, api_key) = match (service.decision_provider, service.laya_runtime_mode) {
            (
                wake_core::services::compression_settings::DecisionModelProvider::Laya,
                wake_core::services::laya_runtime::LayaRuntimeMode::External,
            ) => (
                service.external_laya_api_url.clone(),
                service.external_laya_api_key.clone(),
            ),
            (
                wake_core::services::compression_settings::DecisionModelProvider::Laya,
                wake_core::services::laya_runtime::LayaRuntimeMode::Managed,
            ) => (String::new(), String::new()),
            _ => (service.jev_api_url.clone(), service.jev_api_key.clone()),
        };
        JevConfig {
            provider: service.decision_provider,
            model: service.decision_model,
            api_url,
            api_key,
            timeout_secs: service.jev_timeout_secs,
            laya_runtime_mode: service.laya_runtime_mode,
        }
    }

    pub(crate) fn laya_external_capabilities(
        &self,
    ) -> Option<wake_core::services::laya_runtime::LayaExternalCapabilities> {
        self.laya_external_capabilities.clone()
    }

    fn llm_providers(&self) -> Vec<LlmProviderConfig> {
        let mut providers = wake_core::services::compression_settings::load_settings(&self.store)
            .service
            .llm_providers
            .into_iter()
            .map(|provider| LlmProviderConfig {
                id: provider.id,
                name: provider.name,
                api_url: provider.api_url,
                api_key: provider.api_key,
                model: provider.model,
            })
            .collect::<Vec<_>>();
        if providers.is_empty() {
            providers.push(LlmProviderConfig {
                id: "default".into(),
                name: "Provider 1".into(),
                api_url: String::new(),
                api_key: String::new(),
                model: "gpt-4.1-mini".to_string(),
            });
        }
        providers
    }

    fn active_llm_provider_index(&self) -> usize {
        let settings = wake_core::services::compression_settings::load_settings(&self.store);
        settings
            .service
            .llm_providers
            .iter()
            .position(|provider| provider.id == settings.service.active_llm_provider_id)
            .unwrap_or(0)
    }

    fn save_llm_providers(&self, providers: &[LlmProviderConfig]) -> anyhow::Result<()> {
        let current_active = wake_core::services::compression_settings::load_settings(&self.store)
            .service
            .active_llm_provider_id;
        let active = providers
            .iter()
            .find(|provider| provider.id == current_active)
            .or_else(|| providers.first())
            .map(|provider| provider.id.as_str())
            .unwrap_or_default();
        self.save_llm_providers_with_active(providers, active)
    }

    fn save_llm_providers_with_active(
        &self,
        providers: &[LlmProviderConfig],
        active_id: &str,
    ) -> anyhow::Result<()> {
        let mut service =
            wake_core::services::compression_settings::load_settings(&self.store).service;
        service.llm_providers = providers
            .iter()
            .map(
                |provider| wake_core::services::compression_settings::LlmProviderConfig {
                    id: provider.id.clone(),
                    name: provider.name.clone(),
                    api_url: provider.api_url.clone(),
                    api_key: provider.api_key.clone(),
                    model: provider.model.clone(),
                },
            )
            .collect::<Vec<_>>();
        service.active_llm_provider_id = active_id.to_string();
        wake_core::services::compression_settings::save_service_settings(
            &self.store,
            &service,
            true,
        )?;
        Ok(())
    }

    pub(crate) fn compression_strategy_settings(
        &self,
    ) -> wake_core::services::compression_settings::CompressionStrategySettings {
        wake_core::services::compression_settings::load_settings(&self.store).strategy
    }

    fn update_compression_strategy(
        &mut self,
        patch: serde_json::Value,
        success: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let data = serde_json::json!({ "strategy": patch });
        match wake_core::services::compression_settings::update_settings(
            &self.store,
            Some(&data),
            None,
        ) {
            Ok(()) => {
                window.push_notification(Notification::success(success), cx);
                cx.notify();
                true
            }
            Err(error) => {
                window
                    .push_notification(Notification::error(crate::tf!("保存失败：{}", error)), cx);
                false
            }
        }
    }

    pub(crate) fn update_mechanical_compression_setting(
        &mut self,
        mechanical_patch: serde_json::Value,
        success: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.update_compression_strategy(
            serde_json::json!({ "mechanical": mechanical_patch }),
            success,
            window,
            cx,
        );
    }

    fn reset_compression_strategy_path(
        &mut self,
        path: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let resets = serde_json::json!([path]);
        match wake_core::services::compression_settings::update_settings(
            &self.store,
            None,
            Some(&resets),
        ) {
            Ok(()) => {
                window.push_notification(Notification::success("已恢复默认设置"), cx);
                cx.notify();
            }
            Err(error) => window.push_notification(
                Notification::error(crate::tf!("恢复默认失败：{}", error)),
                cx,
            ),
        }
    }

    pub(crate) fn compression_settings(&self) -> CompressionSettings {
        let llm_providers = self.llm_providers();
        let llm_provider_index = self.active_llm_provider_index();
        let active_provider = llm_providers
            .get(llm_provider_index)
            .cloned()
            .unwrap_or_default();
        let tag_specific_strategies = SESSION_TAGS
            .iter()
            .map(|tag| {
                let value = self
                    .store
                    .pref_get(&compression_strategy_tag_key(tag))
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| default_specific_tag_compression_strategy(tag));
                ((*tag).to_string(), value)
            })
            .collect();
        CompressionSettings {
            llm_enabled: self.store.pref_get("compression_llm_enabled").as_deref() != Some("false"),
            llm_api_url: active_provider.api_url.clone(),
            llm_api_key: active_provider.api_key.clone(),
            llm_model: active_provider.model.clone(),
            llm_provider_index,
            llm_provider_name: active_provider.name.clone(),
            llm_timeout_secs: self
                .store
                .pref_get("compression_llm_timeout_secs")
                .and_then(|value| value.parse::<u64>().ok())
                .filter(|value| (30..=3600).contains(value))
                .unwrap_or(600),
            llm_input_limit_chars: self
                .store
                .pref_get("compression_llm_input_limit_chars")
                .and_then(|value| value.parse::<usize>().ok())
                .filter(|value| *value > 0)
                .unwrap_or(DEFAULT_LLM_INPUT_LIMIT_CHARS),
            jev_enabled: self.store.pref_get("compression_jev_enabled").as_deref() == Some("true"),
            single_strategy: self
                .store
                .pref_get("compression_strategy_single")
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(default_single_compression_strategy),
            memory_generation_strategy: self
                .store
                .pref_get("compression_strategy_memory_generation")
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(default_memory_generation_strategy),
            multi_strategy: self
                .store
                .pref_get("compression_strategy_multi")
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(default_multi_compression_strategy),
            tag_strategy: self
                .store
                .pref_get("compression_strategy_tags")
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(default_tag_compression_strategy),
            tag_specific_strategies,
            relation_strategy: self
                .store
                .pref_get("compression_strategy_relations")
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(default_relation_compression_strategy),
        }
    }

    fn pref_set_notify(
        &mut self,
        key: &str,
        value: &str,
        success: &'static str,
        failed: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match self.store.pref_set(key, value.trim()) {
            Ok(()) => {
                window.push_notification(Notification::success(success), cx);
                cx.notify();
            }
            Err(error) => window
                .push_notification(Notification::error(crate::tf!("{}：{}", failed, error)), cx),
        }
    }

    fn set_jev_config_value(
        &mut self,
        field: JevConfigField,
        value: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let key = match field {
            JevConfigField::Model => wake_core::services::compression_settings::DECISION_MODEL_KEY,
            JevConfigField::JevApiUrl => "jev_api_url",
            JevConfigField::JevApiKey => "jev_api_key",
            JevConfigField::LayaApiUrl => {
                wake_core::services::compression_settings::EXTERNAL_LAYA_API_URL_KEY
            }
            JevConfigField::LayaApiKey => "compression_external_laya_api_key",
            JevConfigField::TimeoutSecs => {
                let secs = value.trim().parse::<u64>().unwrap_or(60).clamp(10, 1800);
                self.pref_set_notify(
                    "jev_timeout_secs",
                    &secs.to_string(),
                    "决策模型配置已保存",
                    "决策模型配置保存失败",
                    window,
                    cx,
                );
                return;
            }
        };
        self.pref_set_notify(
            key,
            value,
            "决策模型配置已保存",
            "决策模型配置保存失败",
            window,
            cx,
        );
    }

    pub(crate) fn set_decision_provider(
        &mut self,
        provider: wake_core::services::compression_settings::DecisionModelProvider,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let current = self.jev_config();
        let previous_default = current.provider.default_model();
        if let Err(error) = self.store.pref_set(
            wake_core::services::compression_settings::DECISION_PROVIDER_KEY,
            provider.as_str(),
        ) {
            window.push_notification(
                Notification::error(crate::tf!("决策模型提供方保存失败：{}", error)),
                cx,
            );
            return;
        }
        if provider == wake_core::services::compression_settings::DecisionModelProvider::Laya {
            let _ = self.store.pref_set(
                wake_core::services::compression_settings::LAYA_RUNTIME_MODE_KEY,
                current.laya_runtime_mode.as_str(),
            );
        }
        if current.model.trim().is_empty() || current.model == previous_default {
            let _ = self.store.pref_set(
                wake_core::services::compression_settings::DECISION_MODEL_KEY,
                provider.default_model(),
            );
        }
        window.push_notification(
            Notification::success(crate::tf!("已切换到 {}", provider.display_name())),
            cx,
        );
        cx.notify();
    }

    pub(crate) fn set_laya_runtime_mode(
        &mut self,
        mode: wake_core::services::laya_runtime::LayaRuntimeMode,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.pref_set_notify(
            wake_core::services::compression_settings::LAYA_RUNTIME_MODE_KEY,
            mode.as_str(),
            "Laya 运行方式已保存",
            "Laya 运行方式保存失败",
            window,
            cx,
        );
        if mode == wake_core::services::laya_runtime::LayaRuntimeMode::Managed {
            self.maybe_start_managed_laya();
        }
    }

    pub(crate) fn install_managed_laya(&mut self, cx: &mut Context<Self>) {
        let tx = self.bg_tx.clone();
        std::thread::spawn(move || {
            let progress_tx = tx.clone();
            let progress: wake_core::services::laya_runtime::ProgressSink =
                std::sync::Arc::new(move |_| {
                    let _ = progress_tx.unbounded_send(BgEvent::LayaRuntimeChanged);
                });
            let result = wake_core::services::laya_runtime::manager()
                .install(Some(progress))
                .map(|_| "Laya 安装与批量推理验证完成；请重启 ContextOS".to_string())
                .map_err(|error| format!("Laya 安装失败：{error:#}"));
            let _ = tx.unbounded_send(BgEvent::LayaRuntimeFinished(result));
        });
        cx.notify();
    }

    pub(crate) fn start_managed_laya(&mut self, cx: &mut Context<Self>) {
        self.spawn_laya_runtime_command(
            || {
                wake_core::services::laya_runtime::manager()
                    .start()
                    .map(|_| "Laya 已启动".to_string())
            },
            cx,
        );
    }

    pub(crate) fn stop_managed_laya(&mut self, cx: &mut Context<Self>) {
        self.spawn_laya_runtime_command(
            || {
                wake_core::services::laya_runtime::manager()
                    .stop()
                    .map(|_| "Laya 已停止".to_string())
            },
            cx,
        );
    }

    pub(crate) fn uninstall_managed_laya(&mut self, delete_models: bool, cx: &mut Context<Self>) {
        self.spawn_laya_runtime_command(
            move || {
                wake_core::services::laya_runtime::manager()
                    .uninstall(delete_models)
                    .map(|_| {
                        if delete_models {
                            "Laya 与模型文件已卸载"
                        } else {
                            "Laya 已卸载；模型缓存已保留"
                        }
                        .to_string()
                    })
            },
            cx,
        );
    }

    pub(crate) fn probe_external_laya(&mut self, cx: &mut Context<Self>) {
        let config = self.jev_config();
        let tx = self.bg_tx.clone();
        self.laya_external_capabilities = None;
        std::thread::spawn(move || {
            let result = wake_core::services::laya_runtime::probe_external_service(
                &config.api_url,
                &config.api_key,
                &config.model,
                Duration::from_secs(config.timeout_secs),
            )
            .map_err(|error| format!("外部 Laya 能力检测失败：{error:#}"));
            let _ = tx.unbounded_send(BgEvent::LayaExternalProbeFinished(result));
        });
        cx.notify();
    }

    fn spawn_laya_runtime_command(
        &mut self,
        operation: impl FnOnce() -> anyhow::Result<String> + Send + 'static,
        cx: &mut Context<Self>,
    ) {
        let tx = self.bg_tx.clone();
        let _ = tx.unbounded_send(BgEvent::LayaRuntimeChanged);
        std::thread::spawn(move || {
            let result = operation().map_err(|error| format!("{error:#}"));
            let _ = tx.unbounded_send(BgEvent::LayaRuntimeFinished(result));
        });
        cx.notify();
    }

    fn maybe_start_managed_laya(&self) {
        let service = wake_core::services::compression_settings::load_settings(&self.store).service;
        if service.decision_provider
            != wake_core::services::compression_settings::DecisionModelProvider::Laya
            || service.laya_runtime_mode
                != wake_core::services::laya_runtime::LayaRuntimeMode::Managed
        {
            return;
        }
        let status = wake_core::services::laya_runtime::manager().status();
        if status.install_state != wake_core::services::laya_runtime::LayaInstallState::Installed
            || status.service_state != wake_core::services::laya_runtime::LayaServiceState::Stopped
        {
            return;
        }
        let tx = self.bg_tx.clone();
        std::thread::spawn(move || {
            let _ = tx.unbounded_send(BgEvent::LayaRuntimeChanged);
            let result = wake_core::services::laya_runtime::manager()
                .start()
                .map(|_| "Laya 已就绪".to_string())
                .map_err(|error| format!("托管 Laya 启动失败：{error:#}"));
            let _ = tx.unbounded_send(BgEvent::LayaRuntimeFinished(result));
        });
    }

    fn set_compression_config_value(
        &mut self,
        field: CompressionConfigField,
        value: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let mut providers = self.llm_providers();
        let index = self.active_llm_provider_index();
        let Some(provider) = providers.get_mut(index) else {
            return;
        };
        let trimmed = value.trim();
        match field {
            CompressionConfigField::LlmProviderName => {
                provider.name = if trimmed.is_empty() {
                    format!("Provider {}", index + 1)
                } else {
                    trimmed.to_string()
                };
            }
            CompressionConfigField::LlmApiUrl => provider.api_url = trimmed.to_string(),
            CompressionConfigField::LlmApiKey => {
                if trimmed.is_empty() && !provider.api_key.trim().is_empty() {
                    window.push_notification(Notification::info("API Key 未变更"), cx);
                    return;
                }
                provider.api_key = trimmed.to_string();
            }
            CompressionConfigField::LlmModel => provider.model = trimmed.to_string(),
            CompressionConfigField::LlmTimeoutSecs => {
                let secs = trimmed.parse::<u64>().unwrap_or(600).clamp(30, 3600);
                self.pref_set_notify(
                    "compression_llm_timeout_secs",
                    &secs.to_string(),
                    "压缩配置已保存",
                    "压缩配置保存失败",
                    window,
                    cx,
                );
                return;
            }
            CompressionConfigField::LlmInputLimitChars => {
                let chars = trimmed
                    .parse::<usize>()
                    .ok()
                    .filter(|value| *value > 0)
                    .unwrap_or(DEFAULT_LLM_INPUT_LIMIT_CHARS);
                self.pref_set_notify(
                    "compression_llm_input_limit_chars",
                    &chars.to_string(),
                    "压缩配置已保存",
                    "压缩配置保存失败",
                    window,
                    cx,
                );
                return;
            }
        }
        match self.save_llm_providers(&providers) {
            Ok(()) => {
                window.push_notification(Notification::success("压缩配置已保存"), cx);
                cx.notify();
            }
            Err(error) => window.push_notification(
                Notification::error(crate::tf!("压缩配置保存失败：{}", error)),
                cx,
            ),
        }
    }

    pub(crate) fn toggle_compression_llm(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let enabled = !self.compression_settings().llm_enabled;
        self.pref_set_notify(
            "compression_llm_enabled",
            if enabled { "true" } else { "false" },
            "压缩配置已保存",
            "压缩配置保存失败",
            window,
            cx,
        );
    }

    pub(crate) fn select_next_llm_provider(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let providers = self.llm_providers();
        let next = if providers.is_empty() {
            0
        } else {
            (self.active_llm_provider_index() + 1) % providers.len()
        };
        let Some(provider) = providers.get(next) else {
            return;
        };
        match self.store.pref_set(
            wake_core::services::compression_settings::ACTIVE_PROVIDER_ID_KEY,
            &provider.id,
        ) {
            Ok(()) => {
                let _ = self.save_llm_providers(&providers);
                window.push_notification(Notification::success("LLM Provider 已切换"), cx);
                cx.notify();
            }
            Err(error) => window.push_notification(
                Notification::error(crate::tf!("LLM Provider 切换失败：{}", error)),
                cx,
            ),
        }
    }

    pub(crate) fn add_llm_provider(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let mut providers = self.llm_providers();
        let index = providers.len() + 1;
        let id = format!("provider-{index}");
        providers.push(LlmProviderConfig {
            id: id.clone(),
            name: format!("Provider {index}"),
            api_url: String::new(),
            api_key: String::new(),
            model: "gpt-4.1-mini".to_string(),
        });
        match self.save_llm_providers(&providers).and_then(|_| {
            self.store.pref_set(
                wake_core::services::compression_settings::ACTIVE_PROVIDER_ID_KEY,
                &id,
            )?;
            Ok(())
        }) {
            Ok(()) => {
                window.push_notification(Notification::success("LLM Provider 已新增"), cx);
                cx.notify();
            }
            Err(error) => window.push_notification(
                Notification::error(crate::tf!("LLM Provider 新增失败：{}", error)),
                cx,
            ),
        }
    }

    pub(crate) fn delete_current_llm_provider(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let mut providers = self.llm_providers();
        if providers.len() <= 1 {
            window.push_notification(Notification::info("至少保留一个 LLM Provider"), cx);
            return;
        }
        let index = self.active_llm_provider_index().min(providers.len() - 1);
        providers.remove(index);
        match self.save_llm_providers(&providers) {
            Ok(()) => {
                window.push_notification(Notification::success("LLM Provider 已删除"), cx);
                cx.notify();
            }
            Err(error) => window.push_notification(
                Notification::error(crate::tf!("LLM Provider 删除失败：{}", error)),
                cx,
            ),
        }
    }

    pub(crate) fn open_llm_provider_manager(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let entity = cx.entity();
        open_closable_dialog(window, cx, move |dialog, window, cx| {
            let theme = cx.theme();
            let field_inset = BUTTON_SM_PX;
            let dialog_width = compression_dialog_width(window, px(900.));
            let dialog_height = compression_dialog_max_height(window);
            let list_height = compression_dialog_body_height(window, px(430.), px(190.));
            let providers = entity.read(cx).llm_providers();
            let active_id =
                wake_core::services::compression_settings::load_settings(&entity.read(cx).store)
                    .service
                    .active_llm_provider_id;
            let add_entity = entity.clone();
            let rows = providers
                .into_iter()
                .enumerate()
                .map(|(index, provider)| {
                    let is_active = provider.id == active_id;
                    let key_status = if provider.api_key.trim().is_empty() {
                        "Key 未配置"
                    } else {
                        "Key 已配置"
                    };
                    let activate_entity = entity.clone();
                    let activate_id = provider.id.clone();
                    let edit_entity = entity.clone();
                    let edit_id = provider.id.clone();
                    let duplicate_entity = entity.clone();
                    let duplicate_id = provider.id.clone();
                    let delete_entity = entity.clone();
                    let delete_id = provider.id.clone();
                    let test_entity = entity.clone();
                    let test_id = provider.id.clone();
                    v_flex()
                        .id(("llm-provider-row", index))
                        .gap(SPACE_SM)
                        .px(SPACE_MD)
                        .py(SPACE_SM)
                        .rounded(RADIUS_BUTTON)
                        .border_1()
                        .border_color(if is_active {
                            theme.accent
                        } else {
                            theme.border
                        })
                        .child(
                            v_flex()
                                .min_w_0()
                                .gap(SPACE_SM)
                                .child(
                                    v_flex()
                                        .min_w_0()
                                        .gap(px(3.))
                                        .child(
                                            h_flex()
                                                .gap(SPACE_SM)
                                                .child(
                                                    div()
                                                        .text_size(FONT_BODY)
                                                        .font_semibold()
                                                        .child(provider.name.clone()),
                                                )
                                                .when(is_active, |row| {
                                                    row.child(
                                                        div()
                                                            .text_size(FONT_CAPTION)
                                                            .text_color(theme.accent)
                                                            .child("当前启用"),
                                                    )
                                                }),
                                        )
                                        .child(
                                            div()
                                                .truncate()
                                                .text_size(FONT_CAPTION)
                                                .text_color(theme.muted_foreground)
                                                .child(provider.api_url.clone()),
                                        )
                                        .child(
                                            div()
                                                .text_size(FONT_CAPTION)
                                                .text_color(theme.muted_foreground)
                                                .child(crate::tf!(
                                                    "模型：{} · {}",
                                                    provider.model,
                                                    key_status
                                                )),
                                        ),
                                )
                                .child(
                                    h_flex()
                                        .justify_end()
                                        .gap(SPACE_XS)
                                        .when(!is_active, |actions| {
                                            actions.child(
                                                Button::new(("provider-activate", index))
                                                    .label("启用")
                                                    .outline()
                                                    .on_click(move |_, window, cx| {
                                                        activate_entity.update(cx, |this, cx| {
                                                            this.activate_llm_provider(
                                                                &activate_id,
                                                                window,
                                                                cx,
                                                            )
                                                        });
                                                    }),
                                            )
                                        })
                                        .child(
                                            Button::new(("provider-edit", index))
                                                .label("编辑")
                                                .outline()
                                                .on_click(move |_, window, cx| {
                                                    edit_entity.update(cx, |this, cx| {
                                                        this.open_llm_provider_form(
                                                            Some(edit_id.clone()),
                                                            window,
                                                            cx,
                                                        )
                                                    });
                                                }),
                                        )
                                        .child(
                                            Button::new(("provider-copy", index))
                                                .label("复制")
                                                .outline()
                                                .on_click(move |_, window, cx| {
                                                    duplicate_entity.update(cx, |this, cx| {
                                                        this.duplicate_llm_provider(
                                                            &duplicate_id,
                                                            window,
                                                            cx,
                                                        )
                                                    });
                                                }),
                                        )
                                        .child(
                                            Button::new(("provider-test", index))
                                                .label("测试")
                                                .outline()
                                                .on_click(move |_, window, cx| {
                                                    test_entity.update(cx, |this, cx| {
                                                        this.test_llm_provider(&test_id, window, cx)
                                                    });
                                                }),
                                        )
                                        .child(
                                            Button::new(("provider-delete", index))
                                                .label("删除")
                                                .outline()
                                                .on_click(move |_, window, cx| {
                                                    delete_entity.update(cx, |this, cx| {
                                                        this.delete_llm_provider(
                                                            &delete_id, window, cx,
                                                        )
                                                    });
                                                }),
                                        ),
                                ),
                        )
                })
                .collect::<Vec<_>>();
            dialog
                .title(div().pl(field_inset).text_size(FONT_HEADING).font_semibold().child("模型配置"))
                .w(dialog_width)
                .max_h(dialog_height)
                .child(
                    v_flex()
                        .px(field_inset)
                        .gap(SPACE_MD)
                        .child(
                            h_flex()
                                .justify_between()
                                .items_center()
                                .child(div().text_size(FONT_CAPTION).text_color(theme.muted_foreground).child("所有配置均使用 OpenAI-compatible Chat Completions 接口。"))
                                .child(Button::new("provider-add").label("添加 Provider").primary().on_click(move |_, window, cx| {
                                    add_entity.update(cx, |this, cx| this.open_llm_provider_form(None, window, cx));
                                })),
                        )
                        .child(v_flex().id("llm-provider-list").h(list_height).overflow_y_scroll().gap(SPACE_SM).children(rows)),
                )
                .button_props(gpui_component::dialog::DialogButtonProps::default().ok_text("关闭"))
                .on_ok(|_, _, _| true)
        });
    }

    fn open_llm_provider_form(
        &mut self,
        provider_id: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let provider = provider_id.as_ref().and_then(|id| {
            self.llm_providers()
                .into_iter()
                .find(|provider| provider.id == *id)
        });
        let is_new = provider.is_none();
        let initial = provider.unwrap_or_else(|| LlmProviderConfig {
            id: format!(
                "provider-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis()
            ),
            name: String::new(),
            api_url: String::new(),
            api_key: String::new(),
            model: String::new(),
        });
        let name = cx.new(|cx| {
            InputState::new(window, cx).placeholder("例如 OpenAI / DeepSeek / OpenRouter")
        });
        name.update(cx, |state, cx| {
            state.set_value(initial.name.clone(), window, cx)
        });
        let url = cx.new(|cx| InputState::new(window, cx).placeholder("https://example.com/v1"));
        url.update(cx, |state, cx| {
            state.set_value(initial.api_url.clone(), window, cx)
        });
        let key = cx.new(|cx| {
            InputState::new(window, cx).placeholder(if initial.api_key.is_empty() {
                "sk-..."
            } else {
                "已配置；留空保持不变"
            })
        });
        let model = cx.new(|cx| InputState::new(window, cx).placeholder("model-name"));
        model.update(cx, |state, cx| {
            state.set_value(initial.model.clone(), window, cx)
        });
        let entity = cx.entity();
        let stable_id = initial.id.clone();
        let existing_key = initial.api_key.clone();
        open_closable_dialog(window, cx, move |dialog, window, cx| {
            let theme = cx.theme();
            let field_inset = BUTTON_SM_PX;
            let dialog_width = compression_dialog_width(window, px(680.));
            let dialog_height = compression_dialog_max_height(window);
            let save_entity = entity.clone();
            let save_name = name.clone();
            let save_url = url.clone();
            let save_key = key.clone();
            let save_model = model.clone();
            let save_id = stable_id.clone();
            let preserve_key = existing_key.clone();
            let clear_entity = entity.clone();
            let clear_id = stable_id.clone();
            let form_row = |label: &'static str, help: &'static str, input: &Entity<InputState>| {
                v_flex()
                    .gap(SPACE_XS)
                    .child(
                        h_flex()
                            .gap(SPACE_MD)
                            .items_center()
                            .child(div().w(px(110.)).flex_shrink_0().child(label))
                            .child(div().flex_1().min_w_0().child(Input::new(input))),
                    )
                    .child(
                        div()
                            .pl(px(126.))
                            .text_size(FONT_CAPTION)
                            .text_color(theme.muted_foreground)
                            .child(help),
                    )
            };
            dialog
                .title(
                    div()
                        .pl(field_inset)
                        .text_size(FONT_HEADING)
                        .font_semibold()
                        .child(if is_new {
                            "添加 Provider"
                        } else {
                            "编辑 Provider"
                        }),
                )
                .w(dialog_width)
                .max_h(dialog_height)
                .child(
                    v_flex()
                        .px(field_inset)
                        .gap(SPACE_MD)
                        .child(form_row("名称", "用于在模型列表中识别这组配置。", &name))
                        .child(form_row(
                            "API URL",
                            "OpenAI-compatible API 基址；程序自动补 /v1/chat/completions。",
                            &url,
                        ))
                        .child(form_row(
                            "API Key",
                            "不会回填明文；留空保存保持现有 Key。",
                            &key,
                        ))
                        .child(form_row("模型", "请求中发送的 model 名称。", &model)),
                )
                .footer(
                    gpui_component::dialog::DialogFooter::new()
                        .w_full()
                        .px(field_inset)
                        .when(!is_new && !existing_key.is_empty(), |footer| {
                            footer.child(
                                Button::new("provider-clear-key")
                                    .label("清空 API Key")
                                    .outline()
                                    .on_click(move |_, window, cx| {
                                        clear_entity.update(cx, |this, cx| {
                                            this.clear_llm_provider_key(&clear_id, window, cx)
                                        });
                                        window.close_dialog(cx);
                                    }),
                            )
                        })
                        .child(
                            gpui_component::dialog::DialogClose::new()
                                .child(Button::new("provider-form-cancel").label("取消").outline()),
                        )
                        .child(
                            gpui_component::dialog::DialogAction::new()
                                .child(Button::new("provider-form-save").label("保存").primary()),
                        ),
                )
                .on_ok(move |_, window, cx| {
                    let name_value = save_name.read(cx).text().to_string();
                    let url_value = save_url.read(cx).text().to_string();
                    let key_value = save_key.read(cx).text().to_string();
                    let model_value = save_model.read(cx).text().to_string();
                    if name_value.trim().is_empty()
                        || url_value.trim().is_empty()
                        || model_value.trim().is_empty()
                    {
                        window.push_notification(
                            Notification::error("名称、API URL 和模型不能为空"),
                            cx,
                        );
                        return false;
                    }
                    let provider = LlmProviderConfig {
                        id: save_id.clone(),
                        name: name_value.trim().to_string(),
                        api_url: url_value.trim().to_string(),
                        api_key: if key_value.trim().is_empty() {
                            preserve_key.clone()
                        } else {
                            key_value.trim().to_string()
                        },
                        model: model_value.trim().to_string(),
                    };
                    save_entity.update(cx, |this, cx| {
                        this.upsert_llm_provider(provider, is_new, window, cx)
                    })
                })
        });
    }

    fn upsert_llm_provider(
        &mut self,
        provider: LlmProviderConfig,
        activate: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let mut providers = self.llm_providers();
        if let Some(existing) = providers.iter_mut().find(|item| item.id == provider.id) {
            *existing = provider.clone();
        } else {
            providers.push(provider.clone());
        }
        let result = if activate {
            self.save_llm_providers_with_active(&providers, &provider.id)
        } else {
            self.save_llm_providers(&providers)
        };
        match result {
            Ok(()) => {
                window.push_notification(Notification::success("模型配置已保存"), cx);
                cx.notify();
                true
            }
            Err(error) => {
                window.push_notification(
                    Notification::error(crate::tf!("模型配置保存失败：{}", error)),
                    cx,
                );
                false
            }
        }
    }

    fn activate_llm_provider(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let providers = self.llm_providers();
        match self.save_llm_providers_with_active(&providers, id) {
            Ok(()) => {
                window.push_notification(Notification::success("当前模型已切换"), cx);
                cx.notify();
            }
            Err(error) => window.push_notification(
                Notification::error(crate::tf!("模型切换失败：{}", error)),
                cx,
            ),
        }
    }

    fn duplicate_llm_provider(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let mut providers = self.llm_providers();
        let Some(mut copy) = providers.iter().find(|provider| provider.id == id).cloned() else {
            return;
        };
        copy.id = format!(
            "provider-copy-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        );
        copy.name = format!("{} 副本", copy.name);
        providers.push(copy);
        match self.save_llm_providers(&providers) {
            Ok(()) => {
                window.push_notification(Notification::success("Provider 已复制"), cx);
                cx.notify();
            }
            Err(error) => window.push_notification(
                Notification::error(crate::tf!("Provider 复制失败：{}", error)),
                cx,
            ),
        }
    }

    fn delete_llm_provider(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let mut providers = self.llm_providers();
        if providers.len() <= 1 {
            window.push_notification(Notification::info("至少保留一个 Provider"), cx);
            return;
        }
        providers.retain(|provider| provider.id != id);
        let active = wake_core::services::compression_settings::load_settings(&self.store)
            .service
            .active_llm_provider_id;
        let next_active = if active == id {
            providers[0].id.clone()
        } else {
            active
        };
        match self.save_llm_providers_with_active(&providers, &next_active) {
            Ok(()) => {
                window.push_notification(Notification::success("Provider 已删除"), cx);
                cx.notify();
            }
            Err(error) => window.push_notification(
                Notification::error(crate::tf!("Provider 删除失败：{}", error)),
                cx,
            ),
        }
    }

    fn clear_llm_provider_key(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let mut providers = self.llm_providers();
        if let Some(provider) = providers.iter_mut().find(|provider| provider.id == id) {
            provider.api_key.clear();
        }
        match self.save_llm_providers(&providers) {
            Ok(()) => {
                window.push_notification(Notification::success("API Key 已清空"), cx);
                cx.notify();
            }
            Err(error) => window.push_notification(
                Notification::error(crate::tf!("API Key 清空失败：{}", error)),
                cx,
            ),
        }
    }

    fn test_llm_provider(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(provider) = self
            .llm_providers()
            .into_iter()
            .find(|provider| provider.id == id)
        else {
            return;
        };
        if provider.api_url.trim().is_empty()
            || provider.api_key.trim().is_empty()
            || provider.model.trim().is_empty()
        {
            window.push_notification(
                Notification::error("请先完整配置 API URL、API Key 和模型"),
                cx,
            );
            return;
        }
        window.push_notification(Notification::info("正在测试模型连接..."), cx);
        let (sender, receiver) = futures::channel::oneshot::channel();
        std::thread::spawn(move || {
            let result = (|| -> anyhow::Result<()> {
                let response = reqwest::blocking::Client::builder()
                    .timeout(Duration::from_secs(30))
                    .build()?
                    .post(llm_endpoint(&provider.api_url))
                    .bearer_auth(&provider.api_key)
                    .json(&serde_json::json!({
                        "model": provider.model,
                        "messages": [{"role": "user", "content": "Reply with OK."}],
                        "max_tokens": 8,
                        "temperature": 0
                    }))
                    .send()?;
                if !response.status().is_success() {
                    anyhow::bail!("HTTP {}", response.status());
                }
                Ok(())
            })();
            let _ = sender.send(result.map_err(|error| error.to_string()));
        });
        cx.spawn_in(window, async move |this, cx| {
            let result = receiver
                .await
                .unwrap_or_else(|_| Err("测试任务意外结束".to_string()));
            this.update_in(cx, |_this, window, cx| match result {
                Ok(()) => window.push_notification(Notification::success("模型连接测试成功"), cx),
                Err(error) => window.push_notification(
                    Notification::error(crate::tf!("模型连接测试失败：{}", error)),
                    cx,
                ),
            })
            .ok();
        })
        .detach();
    }

    pub(crate) fn toggle_compression_jev(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let enabled = !self.compression_settings().jev_enabled;
        self.pref_set_notify(
            "compression_jev_enabled",
            if enabled { "true" } else { "false" },
            "压缩配置已保存",
            "压缩配置保存失败",
            window,
            cx,
        );
    }

    pub(crate) fn open_jev_config_form(
        &mut self,
        field: JevConfigField,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let config = self.jev_config();
        let service = wake_core::services::compression_settings::load_settings(&self.store).service;
        let provider_name = match field {
            JevConfigField::LayaApiUrl | JevConfigField::LayaApiKey => "Laya",
            JevConfigField::JevApiUrl | JevConfigField::JevApiKey => "Jev",
            _ => config.provider.display_name(),
        };
        let (title, label, placeholder, initial, helper): (
            SharedString,
            &'static str,
            &'static str,
            String,
            SharedString,
        ) = match field {
            JevConfigField::Model => (
                crate::tf!("设置 {} 模型", provider_name).into(),
                "Model",
                config.provider.default_model(),
                config.model,
                "发送到 /v1/systemone 请求体中的模型名。".into(),
            ),
            JevConfigField::JevApiUrl | JevConfigField::LayaApiUrl => (
                crate::tf!("设置 {} API URL", provider_name).into(),
                "URL",
                if matches!(field, JevConfigField::LayaApiUrl) {
                    "http://127.0.0.1:1337"
                } else {
                    "https://api.typesafe.ai"
                },
                if matches!(field, JevConfigField::LayaApiUrl) {
                    service.external_laya_api_url
                } else {
                    service.jev_api_url
                },
                "填 API 基址即可；程序会自动补 /v1/systemone。".into(),
            ),
            JevConfigField::JevApiKey | JevConfigField::LayaApiKey => (
                crate::tf!("设置 {} API Key", provider_name).into(),
                "Key",
                if match field {
                    JevConfigField::LayaApiKey => service.external_laya_api_key.trim().is_empty(),
                    _ => service.jev_api_key.trim().is_empty(),
                } {
                    "sk-..."
                } else {
                    "已配置；输入新 Key 覆盖，留空保持不变"
                },
                String::new(),
                if matches!(field, JevConfigField::JevApiKey) {
                    "API Key 不会在弹窗中回填明文；留空保存会保持原 Key 不变。".into()
                } else {
                    "外部 Laya 未启用认证时可留空；已配置的 Key 不会回填明文。".into()
                },
            ),
            JevConfigField::TimeoutSecs => (
                crate::tf!("设置 {} Timeout", provider_name).into(),
                "Seconds",
                "60",
                config.timeout_secs.to_string(),
                "决策模型请求超时时间，单位秒；范围 10-1800。".into(),
            ),
        };
        let input = cx.new(|cx| InputState::new(window, cx).placeholder(placeholder));
        if !initial.is_empty() {
            input.update(cx, |st, cx| st.set_value(initial, window, cx));
        }
        let entity = cx.entity();
        window.open_dialog(cx, move |dialog, window, cx| {
            let theme = cx.theme();
            let field_inset = BUTTON_SM_PX;
            let dialog_width = compression_dialog_width(window, px(520.));
            let dialog_height = compression_dialog_max_height(window);
            let dirty = input.read(cx).text().chars().any(|c| !c.is_whitespace());
            let ok_entity = entity.clone();
            let ok_input = input.clone();
            let dialog = dialog
                .title(
                    div()
                        .pl(field_inset)
                        .text_size(FONT_HEADING)
                        .font_semibold()
                        .child(title.clone()),
                )
                .w(dialog_width)
                .max_h(dialog_height)
                .button_props(gpui_component::dialog::DialogButtonProps::default().ok_text("保存"))
                .child(
                    v_flex()
                        .gap(SPACE_SM)
                        .child(
                            h_flex()
                                .px(field_inset)
                                .gap(SPACE_SM)
                                .items_center()
                                .child(
                                    div()
                                        .w(FORM_LABEL_W)
                                        .flex_shrink_0()
                                        .text_size(FONT_CAPTION)
                                        .text_color(theme.muted_foreground)
                                        .child(label),
                                )
                                .child(div().flex_1().min_w_0().child(Input::new(&input))),
                        )
                        .child(
                            div()
                                .pl(field_inset + FORM_LABEL_W + SPACE_SM)
                                .pr(field_inset)
                                .text_size(FONT_CAPTION)
                                .text_color(theme.muted_foreground)
                                .child(helper.clone()),
                        ),
                )
                .on_ok(move |_, window, cx| {
                    let value = ok_input.read(cx).text().to_string();
                    ok_entity.update(cx, |this, cx| {
                        let existing_key = match field {
                            JevConfigField::JevApiKey => {
                                wake_core::services::compression_settings::load_settings(
                                    &this.store,
                                )
                                .service
                                .jev_api_key
                            }
                            JevConfigField::LayaApiKey => {
                                wake_core::services::compression_settings::load_settings(
                                    &this.store,
                                )
                                .service
                                .external_laya_api_key
                            }
                            _ => String::new(),
                        };
                        if matches!(
                            field,
                            JevConfigField::JevApiKey | JevConfigField::LayaApiKey
                        ) && value.trim().is_empty()
                            && !existing_key.trim().is_empty()
                        {
                            window.push_notification(
                                Notification::info("决策模型 API Key 未变更"),
                                cx,
                            );
                        } else {
                            this.set_jev_config_value(field, &value, window, cx);
                        }
                    });
                    true
                });
            if dirty {
                dialog.footer(
                    gpui_component::dialog::DialogFooter::new()
                        .w_full()
                        .px(field_inset)
                        .child(
                            gpui_component::dialog::DialogClose::new()
                                .child(Button::new("jev-config-cancel").label("取消").outline()),
                        )
                        .child(
                            gpui_component::dialog::DialogAction::new()
                                .child(Button::new("jev-config-save").label("保存").primary()),
                        ),
                )
            } else {
                dialog
            }
        });
    }

    pub(crate) fn open_compression_config_form(
        &mut self,
        field: CompressionConfigField,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let settings = self.compression_settings();
        let (title, label, placeholder, initial) = match field {
            CompressionConfigField::LlmProviderName => (
                "设置 LLM Provider 名称",
                "名称",
                "OpenAI / DeepSeek / Qwen...",
                settings.llm_provider_name,
            ),
            CompressionConfigField::LlmApiUrl => (
                "设置 LLM API URL",
                "URL",
                "https://api.openai.com",
                settings.llm_api_url,
            ),
            CompressionConfigField::LlmApiKey => (
                "设置 LLM API Key",
                "Key",
                if settings.llm_api_key.trim().is_empty() {
                    "sk-..."
                } else {
                    "已配置；输入新 Key 覆盖，留空保持不变"
                },
                String::new(),
            ),
            CompressionConfigField::LlmModel => (
                "设置 LLM Model",
                "Model",
                "gpt-4.1-mini",
                settings.llm_model,
            ),
            CompressionConfigField::LlmTimeoutSecs => (
                "设置 LLM Timeout",
                "Seconds",
                "600",
                settings.llm_timeout_secs.to_string(),
            ),
            CompressionConfigField::LlmInputLimitChars => (
                "设置 LLM 输入字数上限",
                "Chars",
                "1000000",
                settings.llm_input_limit_chars.to_string(),
            ),
        };
        let input = cx.new(|cx| InputState::new(window, cx).placeholder(placeholder));
        if !initial.is_empty() {
            input.update(cx, |st, cx| st.set_value(initial, window, cx));
        }
        let entity = cx.entity();
        open_closable_dialog(window, cx, move |dialog, window, cx| {
            let theme = cx.theme();
            let field_inset = BUTTON_SM_PX;
            let dialog_width = compression_dialog_width(window, px(520.));
            let dialog_height = compression_dialog_max_height(window);
            let ok_entity = entity.clone();
            let ok_input = input.clone();
            dialog
                .title(
                    div()
                        .pl(field_inset)
                        .text_size(FONT_HEADING)
                        .font_semibold()
                        .child(title),
                )
                .w(dialog_width)
                .max_h(dialog_height)
                .button_props(gpui_component::dialog::DialogButtonProps::default().ok_text("保存"))
                .child(
                    h_flex()
                        .px(field_inset)
                        .gap(SPACE_SM)
                        .items_center()
                        .child(
                            div()
                                .w(FORM_LABEL_W)
                                .flex_shrink_0()
                                .text_size(FONT_CAPTION)
                                .text_color(theme.muted_foreground)
                                .child(label),
                        )
                        .child(div().flex_1().min_w_0().child(Input::new(&input))),
                )
                .on_ok(move |_, window, cx| {
                    let value = ok_input.read(cx).text().to_string();
                    ok_entity.update(cx, |this, cx| {
                        this.set_compression_config_value(field, &value, window, cx);
                    });
                    true
                })
        });
    }

    pub(crate) fn open_mechanical_rule_form(
        &mut self,
        rule: MechanicalRuleKind,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let strategy = self.compression_strategy_settings();
        let mechanical = serde_json::to_value(strategy.mechanical).unwrap_or_default();
        let current = mechanical
            .get(rule.key())
            .and_then(serde_json::Value::as_object)
            .cloned()
            .unwrap_or_default();
        let fields = mechanical_field_specs(rule)
            .iter()
            .map(|spec| {
                let value = current.get(spec.key).cloned().unwrap_or_default();
                let display = match spec.field_type {
                    MechanicalFieldType::Boolean => {
                        if value.as_bool().unwrap_or(false) {
                            "是".to_string()
                        } else {
                            "否".to_string()
                        }
                    }
                    MechanicalFieldType::Number => value.as_u64().unwrap_or_default().to_string(),
                    MechanicalFieldType::TextList => value
                        .as_array()
                        .map(|items| {
                            items
                                .iter()
                                .filter_map(|item| item.as_str())
                                .collect::<Vec<_>>()
                                .join(", ")
                        })
                        .unwrap_or_default(),
                };
                let input = cx.new(|cx| InputState::new(window, cx));
                input.update(cx, |state, cx| state.set_value(display, window, cx));
                (*spec, input)
            })
            .collect::<Vec<_>>();
        let entity = cx.entity();
        open_closable_dialog(window, cx, move |dialog, window, cx| {
            let theme = cx.theme();
            let field_inset = BUTTON_SM_PX;
            let dialog_width = compression_dialog_width(window, px(720.));
            let dialog_height = compression_dialog_max_height(window);
            let body_height = compression_dialog_body_height(window, px(470.), px(140.));
            let save_entity = entity.clone();
            let save_fields = fields.clone();
            let reset_entity = entity.clone();
            let reset_path: &'static str = match rule {
                MechanicalRuleKind::EmptyOutput => "strategy.mechanical.empty_output_rule",
                MechanicalRuleKind::ErrorProtection => "strategy.mechanical.error_protection_rule",
                MechanicalRuleKind::Patch => "strategy.mechanical.patch_rule",
                MechanicalRuleKind::SourceListing => "strategy.mechanical.source_listing_rule",
                MechanicalRuleKind::SearchOutput => "strategy.mechanical.search_output_rule",
                MechanicalRuleKind::ListingOutput => "strategy.mechanical.listing_output_rule",
                MechanicalRuleKind::InstructionAndToolSpec => {
                    "strategy.mechanical.instruction_and_tool_spec_rule"
                }
                MechanicalRuleKind::GenericLargeOutput => {
                    "strategy.mechanical.generic_large_output_rule"
                }
            };
            dialog
                .title(
                    div()
                        .pl(field_inset)
                        .text_size(FONT_HEADING)
                        .font_semibold()
                        .child(crate::tf!("编辑{}", rule.title())),
                )
                .w(dialog_width)
                .max_h(dialog_height)
                .child(
                    v_flex()
                        .id("mechanical-rule-form-scroll")
                        .h(body_height)
                        .overflow_y_scrollbar()
                        .px(field_inset)
                        .gap(SPACE_MD)
                        .children(fields.iter().enumerate().map(|(index, (spec, input))| {
                            v_flex()
                                .id(("mechanical-rule-field", index))
                                .gap(SPACE_XS)
                                .child(
                                    h_flex()
                                        .gap(SPACE_MD)
                                        .items_center()
                                        .child(
                                            div()
                                                .w(px(170.))
                                                .flex_shrink_0()
                                                .text_size(FONT_BODY)
                                                .child(spec.label),
                                        )
                                        .child(div().flex_1().min_w_0().child(Input::new(input))),
                                )
                                .child(
                                    div()
                                        .pl(px(186.))
                                        .text_size(FONT_CAPTION)
                                        .text_color(theme.muted_foreground)
                                        .child(spec.help),
                                )
                        })),
                )
                .footer(
                    gpui_component::dialog::DialogFooter::new()
                        .w_full()
                        .px(field_inset)
                        .child(
                            Button::new("mechanical-rule-reset")
                                .label("恢复本组默认")
                                .outline()
                                .on_click(move |_, window, cx| {
                                    reset_entity.update(cx, |this, cx| {
                                        this.reset_compression_strategy_path(
                                            reset_path, window, cx,
                                        );
                                    });
                                    window.close_dialog(cx);
                                }),
                        )
                        .child(
                            gpui_component::dialog::DialogClose::new().child(
                                Button::new("mechanical-rule-cancel")
                                    .label("取消")
                                    .outline(),
                            ),
                        )
                        .child(
                            gpui_component::dialog::DialogAction::new()
                                .child(Button::new("mechanical-rule-save").label("保存").primary()),
                        ),
                )
                .on_ok(move |_, window, cx| {
                    let mut rule_patch = serde_json::Map::new();
                    for (spec, input) in &save_fields {
                        let raw = input.read(cx).text().to_string();
                        let raw = raw.trim().to_string();
                        let value = match spec.field_type {
                            MechanicalFieldType::Boolean => match raw.to_ascii_lowercase().as_str()
                            {
                                "是" | "true" | "1" | "yes" => serde_json::Value::Bool(true),
                                "否" | "false" | "0" | "no" => serde_json::Value::Bool(false),
                                _ => {
                                    window.push_notification(
                                        Notification::error(crate::tf!(
                                            "{}：请填写 是 或 否",
                                            spec.label
                                        )),
                                        cx,
                                    );
                                    return false;
                                }
                            },
                            MechanicalFieldType::Number => match raw.parse::<u64>() {
                                Ok(number) => serde_json::json!(number),
                                Err(_) => {
                                    window.push_notification(
                                        Notification::error(crate::tf!(
                                            "{}：请输入非负整数",
                                            spec.label
                                        )),
                                        cx,
                                    );
                                    return false;
                                }
                            },
                            MechanicalFieldType::TextList => serde_json::Value::Array(
                                raw.replace('，', ",")
                                    .split(',')
                                    .map(str::trim)
                                    .filter(|item| !item.is_empty())
                                    .map(|item| serde_json::Value::String(item.to_string()))
                                    .collect(),
                            ),
                        };
                        rule_patch.insert(spec.key.to_string(), value);
                    }
                    let patch = serde_json::json!({
                        "mechanical": { rule.key(): serde_json::Value::Object(rule_patch) }
                    });
                    save_entity.update(cx, |this, cx| {
                        this.update_compression_strategy(patch, "机械压缩规则已保存", window, cx)
                    })
                })
        });
    }

    pub(crate) fn open_mechanical_retention_limits_form(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let mechanical = self.compression_strategy_settings().mechanical;
        let expanded = cx.new(|cx| InputState::new(window, cx));
        let evidence = cx.new(|cx| InputState::new(window, cx));
        expanded.update(cx, |state, cx| {
            state.set_value(mechanical.expanded_max_chars.to_string(), window, cx)
        });
        evidence.update(cx, |state, cx| {
            state.set_value(mechanical.evidence_max_chars.to_string(), window, cx)
        });
        let entity = cx.entity();
        let save_expanded = expanded.clone();
        let save_evidence = evidence.clone();
        open_closable_dialog(window, cx, move |dialog, window, cx| {
            let theme = cx.theme();
            let inset = BUTTON_SM_PX;
            let ok_entity = entity.clone();
            let ok_expanded = save_expanded.clone();
            let ok_evidence = save_evidence.clone();
            dialog
                .title(div().pl(inset).text_size(FONT_HEADING).font_semibold().child("编辑恢复输出上限"))
                .w(compression_dialog_width(window, px(620.)))
                .max_h(compression_dialog_max_height(window))
                .child(v_flex().px(inset).gap(SPACE_MD)
                    .child(v_flex().gap(SPACE_XS)
                        .child(div().text_size(FONT_BODY).child("扩展片段字符上限"))
                        .child(Input::new(&expanded))
                        .child(div().text_size(FONT_CAPTION).text_color(theme.muted_foreground).child("expanded 超出此上限时保留头尾片段。")))
                    .child(v_flex().gap(SPACE_XS)
                        .child(div().text_size(FONT_BODY).child("关键证据字符上限"))
                        .child(Input::new(&evidence))
                        .child(div().text_size(FONT_CAPTION).text_color(theme.muted_foreground).child("evidence 仅从本地输出中提取受限证据；无法提取时回退到机械结果。"))))
                .footer(gpui_component::dialog::DialogFooter::new().w_full().px(inset)
                    .child(gpui_component::dialog::DialogClose::new().child(Button::new("retention-limits-cancel").label("取消").outline()))
                    .child(gpui_component::dialog::DialogAction::new().child(Button::new("retention-limits-save").label("保存").primary())))
                .on_ok(move |_, window, cx| {
                    let parse = |input: &Entity<InputState>| input.read(cx).text().to_string().trim().parse::<u64>().ok().filter(|value| *value > 0);
                    let (Some(expanded), Some(evidence)) = (parse(&ok_expanded), parse(&ok_evidence)) else {
                        window.push_notification(Notification::error("字符上限必须是大于 0 的整数"), cx);
                        return false;
                    };
                    ok_entity.update(cx, |this, cx| this.update_mechanical_compression_setting(
                        serde_json::json!({ "expanded_max_chars": expanded, "evidence_max_chars": evidence }),
                        "恢复输出上限已保存", window, cx,
                    ));
                    true
                })
        });
    }

    pub(crate) fn open_jev_strategy_form(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let current = self.compression_strategy_settings().jev;
        let prompt = cx.new(|cx| {
            TextareaState::new(window, cx)
                .rows(12)
                .placeholder("说明评分范围、判断依据和 JSON 输出格式...")
                .default_value(current.jev_prompt_template.clone())
        });
        let request_limit = cx.new(|cx| InputState::new(window, cx));
        request_limit.update(cx, |state, cx| {
            state.set_value(current.jev_request_char_limit.to_string(), window, cx)
        });
        let candidate_min = cx.new(|cx| InputState::new(window, cx));
        candidate_min.update(cx, |state, cx| {
            state.set_value(current.jev_candidate_min_chars.to_string(), window, cx)
        });
        let fallback = cx.new(|cx| InputState::new(window, cx));
        fallback.update(cx, |state, cx| {
            let value = match current.jev_fallback_on_error {
                wake_core::services::compression_settings::JevFallback::UseMechanical => {
                    "使用机械结果"
                }
                wake_core::services::compression_settings::JevFallback::Fail => "压缩失败",
            };
            state.set_value(value, window, cx)
        });
        let scoring_mode = cx.new(|cx| InputState::new(window, cx));
        scoring_mode.update(cx, |state, cx| {
            let value = match current.scoring_mode {
                wake_core::services::compression_settings::DecisionScoringMode::Absolute => {
                    "绝对评分"
                }
                wake_core::services::compression_settings::DecisionScoringMode::Relative => {
                    "相对评分"
                }
            };
            state.set_value(value, window, cx)
        });
        let levels = current
            .jev_score_levels
            .iter()
            .map(|level| {
                let label = cx.new(|cx| InputState::new(window, cx));
                label.update(cx, |state, cx| {
                    state.set_value(level.label.clone(), window, cx)
                });
                let score = cx.new(|cx| InputState::new(window, cx));
                score.update(cx, |state, cx| {
                    state.set_value(format!("{:.2}", level.max_score), window, cx)
                });
                let action = cx.new(|cx| InputState::new(window, cx));
                action.update(cx, |state, cx| {
                    state.set_value(jev_action_chinese(level.action), window, cx)
                });
                (level.id.clone(), label, score, action)
            })
            .collect::<Vec<_>>();
        let entity = cx.entity();
        open_closable_dialog(window, cx, move |dialog, window, cx| {
            let theme = cx.theme();
            let field_inset = BUTTON_SM_PX;
            let dialog_width = compression_dialog_width(window, px(860.));
            let dialog_height = compression_dialog_max_height(window);
            let body_height = compression_dialog_body_height(window, px(590.), px(140.));
            let save_entity = entity.clone();
            let save_prompt = prompt.clone();
            let save_request_limit = request_limit.clone();
            let save_candidate_min = candidate_min.clone();
            let save_fallback = fallback.clone();
            let save_scoring_mode = scoring_mode.clone();
            let save_levels = levels.clone();
            let reset_entity = entity.clone();
            dialog
                .title(
                    div()
                        .pl(field_inset)
                        .text_size(FONT_HEADING)
                        .font_semibold()
                        .child("决策模型评分提示词"),
                )
                .w(dialog_width)
                .max_h(dialog_height)
                .child(
                    v_flex()
                        .id("jev-strategy-form-scroll")
                        .h(body_height)
                        .overflow_y_scrollbar()
                        .px(field_inset)
                        .gap(SPACE_MD)
                        .child(div().text_size(FONT_LABEL).font_semibold().child("评分提示词"))
                        .child(div().h(px(230.)).child(Textarea::new(&prompt).h_full()))
                        .child(
                            div()
                                .text_size(FONT_CAPTION)
                                .text_color(theme.muted_foreground)
                                .child("提示词应要求返回 score、reason 和 evidence_hints，并解释 0.0 到 1.0 的评分依据。"),
                        )
                        .child(
                            h_flex()
                                .gap(SPACE_MD)
                                .child(v_flex().flex_1().gap(SPACE_XS).child("单次请求最大字符数").child(Input::new(&request_limit)))
                                .child(v_flex().flex_1().gap(SPACE_XS).child("候选最小字符数").child(Input::new(&candidate_min)))
                                .child(v_flex().flex_1().gap(SPACE_XS).child("失败降级行为").child(Input::new(&fallback))),
                        )
                        .child(
                            v_flex()
                                .gap(SPACE_XS)
                                .child("最终分档方式")
                                .child(Input::new(&scoring_mode))
                                .child(
                                    div()
                                        .text_size(FONT_CAPTION)
                                        .text_color(theme.muted_foreground)
                                        .child("可填“相对评分”或“绝对评分”。相对评分会在整份导出完成评估后统一排序，同时保留绝对安全下限。"),
                                ),
                        )
                        .child(div().pt(SPACE_SM).text_size(FONT_LABEL).font_semibold().child("评分等级"))
                        .child(
                            div()
                                .text_size(FONT_CAPTION)
                                .text_color(theme.muted_foreground)
                                .child("固定六级；最高分必须递增，最后一级必须为 1.0。动作可填：删除、极简占位、机械裁剪、关键证据、扩展片段、近全文。"),
                        )
                        .children(levels.iter().enumerate().map(|(index, (id, label, score, action))| {
                            h_flex()
                                .id(("jev-score-level", index))
                                .gap(SPACE_SM)
                                .items_center()
                                .child(div().w(px(86.)).flex_shrink_0().text_size(FONT_CAPTION).text_color(theme.muted_foreground).child(id.clone()))
                                .child(v_flex().flex_1().gap(px(3.)).child("中文说明").child(Input::new(label)))
                                .child(v_flex().w(px(120.)).gap(px(3.)).child("最高分").child(Input::new(score)))
                                .child(v_flex().w(px(150.)).gap(px(3.)).child("对应动作").child(Input::new(action)))
                        }))
                        .child(div().pt(SPACE_SM).text_size(FONT_LABEL).font_semibold().child("示例"))
                        .child(
                            v_flex()
                                .gap(SPACE_XS)
                                .text_size(FONT_CAPTION)
                                .text_color(theme.muted_foreground)
                                .child("0.10：重复的成功轮询，没有接手价值，删除。")
                                .child("0.68：包含编译失败行和文件路径，保留关键证据。")
                                .child("0.95：完整 Patch 是唯一修改证据且难以摘要，预算允许时近全文保留。"),
                        ),
                )
                .footer(
                    gpui_component::dialog::DialogFooter::new()
                        .w_full()
                        .px(field_inset)
                        .child(
                            Button::new("jev-strategy-reset")
                                .label("恢复全部默认")
                                .outline()
                                .on_click(move |_, window, cx| {
                                    reset_entity.update(cx, |this, cx| {
                                        this.reset_compression_strategy_path("strategy.jev", window, cx);
                                    });
                                    window.close_dialog(cx);
                                }),
                        )
                        .child(gpui_component::dialog::DialogClose::new().child(Button::new("jev-strategy-cancel").label("取消").outline()))
                        .child(gpui_component::dialog::DialogAction::new().child(Button::new("jev-strategy-save").label("保存").primary())),
                )
                .on_ok(move |_, window, cx| {
                    let mut parse_positive = |input: &Entity<InputState>, label: &str| -> Option<usize> {
                        let value = input.read(cx).text().to_string();
                        match value.trim().parse::<usize>().ok().filter(|value| *value > 0) {
                            Some(value) => Some(value),
                            None => {
                                window.push_notification(Notification::error(crate::tf!("{}：请输入大于 0 的整数", label)), cx);
                                None
                            }
                        }
                    };
                    let Some(request_chars) = parse_positive(&save_request_limit, "单次请求最大字符数") else { return false; };
                    let Some(candidate_chars) = parse_positive(&save_candidate_min, "候选最小字符数") else { return false; };
                    let fallback_text = save_fallback.read(cx).text().to_string();
                    let fallback_value = match fallback_text.trim().to_ascii_lowercase().as_str() {
                        "使用机械结果" | "use_mechanical" => wake_core::services::compression_settings::JevFallback::UseMechanical,
                        "压缩失败" | "fail" => wake_core::services::compression_settings::JevFallback::Fail,
                        _ => {
                            window.push_notification(Notification::error("失败降级行为只能填写“使用机械结果”或“压缩失败”"), cx);
                            return false;
                        }
                    };
                    let scoring_mode_text = save_scoring_mode.read(cx).text().to_string();
                    let scoring_mode_value = match scoring_mode_text.trim().to_ascii_lowercase().as_str() {
                        "相对评分" | "relative" => wake_core::services::compression_settings::DecisionScoringMode::Relative,
                        "绝对评分" | "absolute" => wake_core::services::compression_settings::DecisionScoringMode::Absolute,
                        _ => {
                            window.push_notification(Notification::error("最终分档方式只能填写“相对评分”或“绝对评分”"), cx);
                            return false;
                        }
                    };
                    let mut score_levels = Vec::with_capacity(save_levels.len());
                    for (id, label, score, action) in &save_levels {
                        let label_value = label.read(cx).text().to_string();
                        if label_value.trim().is_empty() {
                            window.push_notification(Notification::error("评分等级的中文说明不能为空"), cx);
                            return false;
                        }
                        let score_text = score.read(cx).text().to_string();
                        let Ok(max_score) = score_text.trim().parse::<f64>() else {
                            window.push_notification(Notification::error("评分等级最高分必须是 0.0 到 1.0 的数字"), cx);
                            return false;
                        };
                        let action_text = action.read(cx).text().to_string();
                        let Some(action_value) = parse_jev_action(&action_text) else {
                            window.push_notification(Notification::error("评分动作不在固定白名单中"), cx);
                            return false;
                        };
                        score_levels.push(wake_core::services::compression_settings::JevScoreLevel {
                            id: id.clone(),
                            label: label_value.trim().to_string(),
                            max_score,
                            action: action_value,
                        });
                    }
                    let prompt_value = save_prompt.read(cx).value().to_string();
                    let jev = wake_core::services::compression_settings::JevStrategySettings {
                        jev_request_char_limit: request_chars,
                        jev_candidate_min_chars: candidate_chars,
                        jev_prompt_template: prompt_value,
                        jev_fallback_on_error: fallback_value,
                        scoring_mode: scoring_mode_value,
                        jev_score_levels: score_levels,
                    };
                    let patch = serde_json::json!({ "jev": serde_json::to_value(jev).unwrap_or_default() });
                    save_entity.update(cx, |this, cx| {
                        this.update_compression_strategy(
                            patch,
                            "决策模型评分策略已保存",
                            window,
                            cx,
                        )
                    })
                })
        });
    }

    pub(crate) fn open_llm_temperature_form(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let current = self.compression_strategy_settings().llm.llm_temperature;
        let input = cx.new(|cx| InputState::new(window, cx).placeholder("0.2"));
        input.update(cx, |state, cx| {
            state.set_value(current.to_string(), window, cx)
        });
        let entity = cx.entity();
        open_closable_dialog(window, cx, move |dialog, window, _cx| {
            let save_entity = entity.clone();
            let save_input = input.clone();
            let dialog_width = compression_dialog_width(window, px(480.));
            let dialog_height = compression_dialog_max_height(window);
            dialog
                .title("设置 LLM Temperature")
                .w(dialog_width)
                .max_h(dialog_height)
                .child(
                    v_flex()
                        .px(BUTTON_SM_PX)
                        .gap(SPACE_SM)
                        .child(Input::new(&input))
                        .child("允许范围 0.0 到 2.0。"),
                )
                .button_props(gpui_component::dialog::DialogButtonProps::default().ok_text("保存"))
                .on_ok(move |_, window, cx| {
                    let value = save_input.read(cx).text().to_string();
                    let Ok(temperature) = value.trim().parse::<f64>() else {
                        window.push_notification(Notification::error("Temperature 必须是数字"), cx);
                        return false;
                    };
                    save_entity.update(cx, |this, cx| {
                        this.update_compression_strategy(
                            serde_json::json!({ "llm": { "llm_temperature": temperature } }),
                            "LLM Temperature 已保存",
                            window,
                            cx,
                        )
                    })
                })
        });
    }

    pub(crate) fn open_compression_strategy_form(
        &mut self,
        field: CompressionStrategyField,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if matches!(field, CompressionStrategyField::Tags) {
            self.open_compression_tag_strategies_form(window, cx);
            return;
        }
        let settings = self.compression_settings();
        let llm = self.compression_strategy_settings().llm;
        let (title, key, initial, reset_path) = match field {
            CompressionStrategyField::Single => (
                "编辑单会话压缩策略".to_string(),
                "compression_strategy_single".to_string(),
                settings.single_strategy,
                None,
            ),
            CompressionStrategyField::MemoryGeneration => (
                "编辑压缩并生成记忆提示词".to_string(),
                "compression_strategy_memory_generation".to_string(),
                llm.memory_generation_strategy.clone(),
                None,
            ),
            CompressionStrategyField::Multi => (
                "编辑多会话压缩策略".to_string(),
                "compression_strategy_multi".to_string(),
                settings.multi_strategy,
                None,
            ),
            CompressionStrategyField::Tags => unreachable!(),
            CompressionStrategyField::TagsGeneral => (
                "编辑通用标签压缩策略".to_string(),
                "compression_strategy_tags".to_string(),
                settings.tag_strategy,
                None,
            ),
            CompressionStrategyField::TagSpecific(tag) => (
                format!("编辑{}标签压缩策略", session_tag_label(tag)),
                compression_strategy_tag_key(tag),
                settings
                    .tag_specific_strategies
                    .get(tag)
                    .cloned()
                    .unwrap_or_else(|| default_specific_tag_compression_strategy(tag)),
                None,
            ),
            CompressionStrategyField::Relations => (
                "编辑关系压缩策略".to_string(),
                "compression_strategy_relations".to_string(),
                settings.relation_strategy,
                None,
            ),
            CompressionStrategyField::LlmSystemMessage => (
                "编辑 LLM System Message".to_string(),
                "llm_system_message".to_string(),
                llm.llm_system_message,
                Some("strategy.llm.llm_system_message"),
            ),
            CompressionStrategyField::LlmTaskTemplate => (
                "编辑 LLM Task 模板".to_string(),
                "llm_task_template".to_string(),
                llm.llm_task_template,
                Some("strategy.llm.llm_task_template"),
            ),
            CompressionStrategyField::LlmUserPromptTemplate => (
                "编辑 LLM 用户提示词模板".to_string(),
                "llm_user_prompt_template".to_string(),
                llm.llm_user_prompt_template,
                Some("strategy.llm.llm_user_prompt_template"),
            ),
            CompressionStrategyField::LlmMemoryCandidateContract => (
                "编辑记忆候选输出契约".to_string(),
                "llm_memory_candidate_contract".to_string(),
                llm.llm_memory_candidate_contract,
                Some("strategy.llm.llm_memory_candidate_contract"),
            ),
        };
        let input = cx.new(|cx| {
            TextareaState::new(window, cx)
                .rows(10)
                .placeholder("写入压缩策略...")
                .default_value(initial)
        });
        let entity = cx.entity();
        open_closable_dialog(window, cx, move |dialog, window, _cx| {
            let field_inset = BUTTON_SM_PX;
            let dialog_width = compression_dialog_width(window, px(720.));
            let dialog_height = compression_dialog_max_height(window);
            let body_height = compression_dialog_body_height(window, px(300.), px(140.));
            let ok_entity = entity.clone();
            let ok_input = input.clone();
            let ok_key = key.clone();
            let reset_entity = entity.clone();
            dialog
                .title(
                    div()
                        .pl(field_inset)
                        .text_size(FONT_HEADING)
                        .font_semibold()
                        .child(title.clone()),
                )
                .w(dialog_width)
                .max_h(dialog_height)
                .button_props(gpui_component::dialog::DialogButtonProps::default().ok_text("保存"))
                .child(
                    div()
                        .px(field_inset)
                        .h(body_height)
                        .child(Textarea::new(&input).h_full()),
                )
                .footer(
                    gpui_component::dialog::DialogFooter::new()
                        .w_full()
                        .px(field_inset)
                        .when_some(reset_path, move |footer, path| {
                            footer.child(
                                Button::new("compression-strategy-reset")
                                    .label("恢复默认")
                                    .outline()
                                    .on_click(move |_, window, cx| {
                                        reset_entity.update(cx, |this, cx| {
                                            this.reset_compression_strategy_path(path, window, cx);
                                        });
                                        window.close_dialog(cx);
                                    }),
                            )
                        })
                        .child(
                            gpui_component::dialog::DialogClose::new().child(
                                Button::new("compression-strategy-cancel")
                                    .label("取消")
                                    .outline(),
                            ),
                        )
                        .child(
                            gpui_component::dialog::DialogAction::new().child(
                                Button::new("compression-strategy-save")
                                    .label("保存")
                                    .primary(),
                            ),
                        ),
                )
                .on_ok(move |_, window, cx| {
                    let value = ok_input.read(cx).value().to_string();
                    let field_key = ok_key.clone();
                    let is_llm_template = field_key.starts_with("llm_");
                    ok_entity.update(cx, move |this, cx| {
                        if is_llm_template {
                            let mut llm_patch = serde_json::Map::new();
                            llm_patch.insert(field_key.clone(), serde_json::Value::String(value));
                            this.update_compression_strategy(
                                serde_json::json!({ "llm": serde_json::Value::Object(llm_patch) }),
                                "LLM 提示词模板已保存",
                                window,
                                cx,
                            )
                        } else {
                            this.pref_set_notify(
                                &field_key,
                                &value,
                                "压缩策略已保存",
                                "压缩策略保存失败",
                                window,
                                cx,
                            );
                            true
                        }
                    })
                })
        });
    }

    fn open_compression_tag_strategies_form(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let entity = cx.entity();
        open_closable_dialog(window, cx, move |dialog, window, cx| {
            let theme = cx.theme();
            let field_inset = BUTTON_SM_PX;
            let dialog_width = compression_dialog_width(window, px(720.));
            let dialog_height = compression_dialog_max_height(window);
            let body_height = compression_dialog_body_height(window, px(420.), px(140.));
            let edit_button =
                |id: &'static str, field: CompressionStrategyField, entity: Entity<Self>| {
                    Button::new(id)
                        .label("编辑")
                        .outline()
                        .on_click(move |_, window, cx| {
                            entity.update(cx, |this, cx| {
                                this.open_compression_strategy_form(field, window, cx);
                            });
                        })
                };
            let row =
                |title: &'static str, description: &'static str, button: Button| -> AnyElement {
                    h_flex()
                        .w_full()
                        .gap(SPACE_MD)
                        .items_center()
                        .px(SPACE_MD)
                        .py(SPACE_SM)
                        .rounded(RADIUS_BUTTON)
                        .border_1()
                        .border_color(theme.border)
                        .child(
                            v_flex()
                                .flex_1()
                                .min_w_0()
                                .gap(px(3.))
                                .child(
                                    div()
                                        .text_size(FONT_BODY)
                                        .text_color(theme.foreground)
                                        .child(title),
                                )
                                .child(
                                    div()
                                        .text_size(FONT_CAPTION)
                                        .text_color(theme.muted_foreground)
                                        .child(description),
                                ),
                        )
                        .child(button)
                        .into_any_element()
                };
            let tag_rows = compression_strategy_tag_options()
                .into_iter()
                .map(|(tag, label)| {
                    row(
                        label,
                        "仅当当前会话带有这个标签时追加到 LLM 压缩提示词。",
                        edit_button(
                            compression_strategy_tag_button_id(tag),
                            CompressionStrategyField::TagSpecific(tag),
                            entity.clone(),
                        ),
                    )
                })
                .collect::<Vec<_>>();
            dialog
                .title(
                    div()
                        .pl(field_inset)
                        .text_size(FONT_HEADING)
                        .font_semibold()
                        .child("标签策略"),
                )
                .w(dialog_width)
                .max_h(dialog_height)
                .button_props(gpui_component::dialog::DialogButtonProps::default().ok_text("关闭"))
                .child(
                    v_flex()
                        .id("compression-tag-strategies-scroll")
                        .h(body_height)
                        .overflow_y_scroll()
                        .px(field_inset)
                        .gap(SPACE_SM)
                        .child(row(
                            "通用标签策略",
                            "所有带标签的压缩都会使用这一段。",
                            edit_button(
                                "compression-strategy-tags-general",
                                CompressionStrategyField::TagsGeneral,
                                entity.clone(),
                            ),
                        ))
                        .children(tag_rows),
                )
                .on_ok(|_, _, _| true)
        });
    }

    pub(crate) fn open_about(&mut self, cx: &mut Context<Self>) {
        self.settings_page = SettingsPage::About;
        cx.notify();
        self.open_settings(cx);
    }

    pub(crate) fn open_updates(&mut self, cx: &mut Context<Self>) {
        self.settings_page = SettingsPage::Updates;
        cx.notify();
        self.open_settings(cx);
        self.check_for_updates(cx);
    }

    pub(crate) fn check_for_updates(&mut self, cx: &mut Context<Self>) {
        if matches!(self.update_status, UpdateStatus::Checking) {
            return;
        }
        self.update_status = UpdateStatus::Checking;
        cx.notify();

        // reqwest::blocking 会自行创建 Tokio runtime；若直接放进 GPUI 的异步
        // executor，runtime 嵌套会 panic，界面便会永远停在 Checking。让阻塞
        // 请求待在独立系统线程里，再用 oneshot 把结果送回 UI executor。
        let (sender, receiver) = futures::channel::oneshot::channel();
        std::thread::spawn(|| {
            let _ = sender.send(update::check_latest_release(env!("CARGO_PKG_VERSION")));
        });
        cx.spawn(async move |this, cx| {
            let status = match receiver.await {
                Ok(Ok(info)) if info.update_available => UpdateStatus::Available {
                    latest: info.latest_version.to_string(),
                },
                Ok(Ok(info)) => UpdateStatus::UpToDate {
                    latest: info.latest_version.to_string(),
                },
                Ok(Err(error)) => {
                    eprintln!("update check failed: {error:#}");
                    UpdateStatus::Failed
                }
                Err(_) => UpdateStatus::Failed,
            };
            this.update(cx, |this, cx| {
                this.update_status = status;
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// 打开单例 Settings 窗口。开窗必须 defer 到当前 Workbench update 退出
    /// 之后：Settings 首帧会读取 location 快照，同步开窗会反读仍被独占借用
    /// 的 Workbench，触发 GPUI double lease。
    pub(crate) fn open_settings(&mut self, cx: &mut Context<Self>) {
        let workbench = cx.entity();
        cx.defer(move |cx| Self::show_settings_window(workbench, cx));
    }

    fn show_settings_window(workbench: Entity<Self>, cx: &mut App) {
        // 先把 Copy 句柄取出，确保 read lease 在后续 update 前结束。
        let existing = workbench.read(cx).settings_window;
        if let Some(handle) = existing {
            if handle
                .update(cx, |_, window, _| window.activate_window())
                .is_ok()
            {
                cx.activate(true);
                return;
            }
            workbench.update(cx, |this, _| this.settings_window = None);
        }
        let (bounds, display_id) =
            crate::main_window::centered_over_main(size(px(820.), px(600.)), cx);
        let titlebar = if cfg!(target_os = "macos") {
            TitlebarOptions {
                title: None,
                appears_transparent: true,
                traffic_light_position: Some(point(px(20.), px(11.))),
            }
        } else {
            TitlebarOptions {
                title: Some(t("ContextOS Settings").into()),
                appears_transparent: false,
                traffic_light_position: None,
            }
        };
        let settings_workbench = workbench.clone();
        match cx.open_window(
            WindowOptions {
                titlebar: Some(titlebar),
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                window_min_size: Some(size(px(720.), px(520.))),
                display_id,
                app_id: Some("contextos-settings".into()),
                window_decorations: Some(WindowDecorations::Client),
                ..Default::default()
            },
            move |window, cx| {
                window
                    .observe_window_appearance(|window, cx| {
                        crate::theme::sync_appearance(Some(window), cx);
                    })
                    .detach();
                crate::theme::sync_appearance(Some(window), cx);
                let settings = cx.new(|cx| SettingsView::new(settings_workbench, window, cx));
                window.focus(&settings.read(cx).focus_handle(cx), cx);
                cx.new(|cx| Root::new(settings, window, cx))
            },
        ) {
            Ok(handle) => {
                workbench.update(cx, |this, _| this.settings_window = Some(handle.into()));
                cx.activate(true);
            }
            Err(error) => eprintln!("failed to open ContextOS settings: {error}"),
        }
    }

    /// store 的 location 配置 → active roster + 全量路径快照。new 与
    /// rebuild_roster 共用；解析与组装都在 wake-core，与 scan CLI 同一条路。
    fn build_roster(store: &Arc<Store>) -> (SharedAdapters, SharedLocations) {
        let roster = create_adapter_roster_for(store);
        (Arc::new(roster.active), Arc::new(roster.locations))
    }

    /// location 配置变更后的唯一 roster 换代点:同一处换 Arc + 重启 watcher,
    /// 新旧两份实例不共存(不变量 8 的运行时补充:"单实例"指任一时刻只有一份
    /// 在服务,换代必须整体换、所有消费方跟随新 Arc)
    fn rebuild_roster(&mut self, cx: &mut Context<Self>) {
        (self.adapters, self.data_locations) = Self::build_roster(&self.store);
        self.runtime.replace_adapters(self.adapters.clone());
        self.remount_watcher();
        cx.notify();
    }

    /// watcher 生命周期的唯一操作点(rebuild_roster 与 RemoteSyncDone 共用):
    /// 先 drop 并等旧线程退出(SessionWatcher::Drop 内 join)——旧线程持旧
    /// roster 在写库,不等收尾,已移除根的会话可能在补扫后被写回复活
    fn remount_watcher(&mut self) {
        self.runtime.remount_watcher();
    }

    /// location 表单(添加/编辑共用一套 UI,2026-08-24 定稿):agent 下拉 +
    /// 路径输入框(可手输,~ 展开)+ 目录选择按钮;Cancel/Save 只在有改动时
    /// 出现。表单作为 Settings 窗口的模态层，esc/取消回到 Locations 页。
    pub(crate) fn open_add_location_form(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open_location_form(FormTarget::Add, window, cx);
    }

    /// Remote hosts 的 Add host 表单:与 location 表单同一材质(标题缩进轴、
    /// 标签列宽、Cancel/Add 只在有输入时出现),字段只有一个 host 名;SSH
    /// 前提说明放在字段下方,填的时候才需要看。回车与 Add 同一条提交路,
    /// 校验不过留在表单上改(2026-09-03 用户要求与 Locations 版式统一)
    pub(crate) fn open_add_remote_host_form(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let host_input = cx.new(|cx| {
            InputState::new(window, cx).placeholder(t("alias from ~/.ssh/config, or user@host"))
        });
        cx.subscribe_in(&host_input, window, |this, input, event, window, cx| {
            if matches!(event, gpui_component::input::InputEvent::PressEnter { .. }) {
                let name = input.read(cx).text().to_string();
                if this.commit_remote_host_form(&name, window, cx) {
                    window.close_all_dialogs(cx);
                }
            }
        })
        .detach();
        let entity = cx.entity();
        open_closable_dialog(window, cx, move |dialog, _window, cx| {
            let theme = cx.theme();
            let field_inset = BUTTON_SM_PX;
            // 有输入才亮出 Cancel/Add(与 location 表单同规则);Rope 直接扫描,
            // builder 每帧跑,禁 to_string
            let dirty = host_input
                .read(cx)
                .text()
                .chars()
                .any(|c| !c.is_whitespace());
            let ok_entity = entity.clone();
            let ok_input = host_input.clone();
            let dialog = dialog
                .title(
                    div()
                        .pl(field_inset)
                        .text_size(FONT_HEADING)
                        .font_semibold()
                        .child(t("Add remote host")),
                )
                .w(px(500.))
                .button_props(
                    gpui_component::dialog::DialogButtonProps::default().ok_text(t("Add")),
                )
                .child(
                    v_flex()
                        .gap(SPACE_MD)
                        .child(
                            h_flex()
                                .px(field_inset)
                                .gap(SPACE_SM)
                                .items_center()
                                .child(
                                    div()
                                        .w(FORM_LABEL_W)
                                        .flex_shrink_0()
                                        .text_size(FONT_CAPTION)
                                        .text_color(theme.muted_foreground)
                                        .child(t("Host")),
                                )
                                .child(div().flex_1().min_w_0().child(Input::new(&host_input))),
                        )
                        .child(
                            // 说明与输入框左缘对齐(跳过标签列)
                            div()
                                .pl(field_inset + FORM_LABEL_W + SPACE_SM)
                                .pr(field_inset)
                                .text_size(FONT_CAPTION)
                                .text_color(theme.muted_foreground)
                                .child(
                                    "Needs non-interactive SSH (key in your agent) and rsync on \
                                     both ends. Connect once from a terminal first to trust the \
                                     host key. Sessions sync on launch, refresh, and Sync now.",
                                ),
                        ),
                )
                .on_ok(move |_, window, cx| {
                    let name = ok_input.read(cx).text().to_string();
                    ok_entity.update(cx, |this, cx| {
                        this.commit_remote_host_form(&name, window, cx)
                    })
                });
            if dirty {
                dialog.footer(
                    gpui_component::dialog::DialogFooter::new()
                        .w_full()
                        .px(field_inset)
                        .child(
                            gpui_component::dialog::DialogClose::new().child(
                                Button::new("remote-host-cancel")
                                    .label(t("Cancel"))
                                    .outline(),
                            ),
                        )
                        .child(
                            gpui_component::dialog::DialogAction::new()
                                .child(Button::new("remote-host-add").label(t("Add")).primary()),
                        ),
                )
            } else {
                dialog
            }
        });
    }

    /// Add host 表单提交:校验 → 入库 → 只拉这台;返回 true 关弹窗,false 留在
    /// 表单上改(空输入静默,格式错给通知)
    fn commit_remote_host_form(
        &mut self,
        name: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let name = name.trim();
        if name.is_empty() {
            return false;
        }
        if !wake_core::remote::valid_host_name(name) {
            window.push_notification(
                Notification::error(t(
                    "Host must be an SSH alias or user@host (letters, digits, . _ - @)",
                )),
                cx,
            );
            return false;
        }
        self.add_remote_host(name, window, cx);
        true
    }

    pub(crate) fn open_edit_location_form(
        &mut self,
        row: DataSourceRow,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // location 的配置单位是目录；SQLite 型 adapter 的展示根可能是文件，
        // 编辑时预填父目录，避免保存成 <db>/<db>。
        let path = row.custom.clone().unwrap_or_else(|| {
            let raw = row.raw.as_ref();
            if std::path::Path::new(raw).is_file() {
                std::path::Path::new(raw)
                    .parent()
                    .map(|path| SharedString::from(path.to_string_lossy().to_string()))
                    .unwrap_or_else(|| row.raw.clone())
            } else {
                row.raw.clone()
            }
        });
        self.open_location_form(
            FormTarget::Edit {
                agent: row.agent,
                path,
                root: row.raw,
                custom: row.custom.is_some(),
                individual_default: row.individual_default,
            },
            window,
            cx,
        );
    }

    fn open_location_form(
        &mut self,
        target: FormTarget,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // 编辑态动作行:Show in Finder 只挂真实存在的路径——目录或 SQLite 库文件都算
        // (open_in_finder 对文件走 reveal 选中;用 is_dir 会把三家库文件行的 Finder 恒
        // 隐藏,2026-08-24 Codex review),fs 探测一次、不进每帧 builder;Remove 只属于
        // 真正可删除的自定义 location,内置 location 由行内开关停用、不删除
        let (title, ok_label, init_agent, init_path, reveal, remove) = match &target {
            FormTarget::Add => (
                t("Add location"),
                t("Add"),
                AgentId::ClaudeCode,
                SharedString::from(""),
                None,
                None,
            ),
            FormTarget::Edit {
                agent,
                path,
                custom,
                ..
            } => {
                let reveal = std::path::Path::new(path.as_ref())
                    .exists()
                    .then(|| path.clone());
                let remove: Option<
                    Rc<dyn Fn(&mut Workbench, &mut Window, &mut Context<Workbench>)>,
                > = if *custom {
                    let (agent, stored) = (*agent, path.clone());
                    Some(Rc::new(move |this: &mut Workbench, window, cx| {
                        this.delete_location(agent, stored.clone(), window, cx)
                    }))
                } else {
                    None
                };
                (
                    t("Edit location"),
                    t("Save"),
                    *agent,
                    path.clone(),
                    reveal,
                    remove,
                )
            }
        };
        let commit_target = target;
        self.open_path_form(
            PathFormSpec {
                title,
                ok_label,
                field_label: t("Folder"),
                init_agent,
                init_path,
                pick_files: false,
                reveal,
                remove,
                commit: Rc::new(move |this, agent, text, window, cx| {
                    this.commit_location_form(commit_target.clone(), agent, text, window, cx)
                }),
            },
            window,
            cx,
        );
    }

    /// 路径表单本体(添加/编辑共用一套 UI,2026-08-24 定稿):agent 下拉 + 路径输入框
    /// (可手输,~ 展开)+ 选择按钮;Cancel/Save 只在有改动时出现。表单作为 Settings
    /// 窗口的模态层,esc/取消回到来源页。Session locations 与 Memory locations 的差别
    /// 全在 `PathFormSpec` 里
    fn open_path_form(&mut self, spec: PathFormSpec, window: &mut Window, cx: &mut Context<Self>) {
        let PathFormSpec {
            title,
            ok_label,
            field_label,
            init_agent,
            init_path,
            pick_files,
            reveal,
            remove,
            commit,
        } = spec;
        // 占位符须与校验规则(Path::is_absolute)同形:Windows 上没有盘符
        // 的 `/absolute/...` 并不算绝对路径,照着占位符敲会被拒
        let placeholder = if cfg!(target_os = "windows") {
            r"C:\absolute\folder\path"
        } else {
            "/absolute/folder/path"
        };
        let path_input = cx.new(|cx| InputState::new(window, cx).placeholder(placeholder));
        if !init_path.is_empty() {
            let v = init_path.clone();
            path_input.update(cx, |st, cx| st.set_value(v, window, cx));
        }
        // 表单状态放 Rc<Cell>/entity 而非宿主字段:builder 每帧重跑,闭包内
        // read 宿主 entity 必 double-lease panic(与 refresh 进度弹窗同一约束)
        let selected: Rc<Cell<AgentId>> = Rc::new(Cell::new(init_agent));
        let dirty_init_agent = init_agent;
        let dirty_init_path = init_path;
        let entity = cx.entity();
        let title: SharedString = title.into();
        let ok_label: SharedString = ok_label.into();
        open_closable_dialog(window, cx, move |dialog, _window, cx| {
            let theme = cx.theme();
            let dark = theme.mode.is_dark();
            // 内容轴缩进 = small 按钮的水平内边距:字段行/标题/footer 以它为轴,
            // 动作行的胶囊钮**不缩进**——可见内容(内边距之后)恰好落轴,hover
            // 胶囊完整留在内容盒内。负 margin 会溢出被裁(locations 面板同一教训)
            let field_inset = BUTTON_SM_PX;
            let sel = selected.get();
            // 脏状态:与初始 (agent, path) 有差且路径非空才亮出 Cancel/Save
            // ——没改动时无可保存,收手走 esc/关闭即可(2026-08-24 用户定稿)。
            // Rope 直接与 &str 比较 + chars 扫描:builder 每帧跑,禁 to_string
            let dirty = {
                let text = path_input.read(cx).text();
                (sel != dirty_init_agent || *text != dirty_init_path.as_ref())
                    && text.chars().any(|c| !c.is_whitespace())
            };
            let sel_cell = selected.clone();
            let browse_entity = entity.clone();
            let browse_input = path_input.clone();
            let ok_entity = entity.clone();
            let ok_input = path_input.clone();
            let ok_sel = selected.clone();
            let ok_commit = commit.clone();
            let remove = remove.clone();
            let reveal = reveal.clone();
            let dialog = dialog
                .title(
                    div()
                        .pl(field_inset)
                        .text_size(FONT_HEADING)
                        .font_semibold()
                        .child(title.clone()),
                )
                .w(px(500.))
                .button_props(
                    gpui_component::dialog::DialogButtonProps::default().ok_text(ok_label.clone()),
                )
                .child(
                    v_flex()
                        .gap(SPACE_MD)
                        .child(
                            h_flex()
                                .px(field_inset)
                                .gap(SPACE_SM)
                                .items_center()
                                .child(
                                    div()
                                        .w(FORM_LABEL_W)
                                        .flex_shrink_0()
                                        .text_size(FONT_CAPTION)
                                        .text_color(theme.muted_foreground)
                                        .child(t("Agent")),
                                )
                                .child(
                                    // Button 走 ParentElement 自组内容:品牌图标是
                                    // PNG(img),进不了 .icon()(那只收单色 SVG),
                                    // 图标+名字+箭头必须同住按钮内(2026-08-24 反馈)
                                    Button::new("loc-agent")
                                        .outline()
                                        .rounded(RADIUS_BUTTON)
                                        .child(
                                            h_flex()
                                                .gap(ICON_TEXT_GAP)
                                                .items_center()
                                                .child(
                                                    img(sel.brand_icon(dark))
                                                        .size(px(14.))
                                                        .flex_shrink_0(),
                                                )
                                                .child(
                                                    div()
                                                        .text_size(FONT_CAPTION)
                                                        .child(sel.display_name()),
                                                )
                                                .child(
                                                    icon("icons/chevron-down.svg")
                                                        .with_size(px(12.))
                                                        .text_color(theme.muted_foreground),
                                                ),
                                        )
                                        .dropdown_menu(move |menu, _, _| {
                                            let mut menu = menu.min_w(px(200.));
                                            for a in AgentId::ALL {
                                                let cell = sel_cell.clone();
                                                // element 变体:菜单项带品牌 PNG
                                                //(纯文本项的 icon 只收单色 SVG)
                                                menu = menu.item(
                                                    PopupMenuItem::element(move |_, _| {
                                                        h_flex()
                                                            .gap(ICON_TEXT_GAP)
                                                            .items_center()
                                                            .child(
                                                                img(a.brand_icon(dark))
                                                                    .size(px(14.))
                                                                    .flex_shrink_0(),
                                                            )
                                                            .child(a.display_name())
                                                    })
                                                    .checked(sel == a)
                                                    .on_click(move |_, window, _| {
                                                        cell.set(a);
                                                        window.refresh();
                                                    }),
                                                );
                                            }
                                            menu
                                        }),
                                ),
                        )
                        .child(
                            h_flex()
                                .px(field_inset)
                                .gap(SPACE_SM)
                                .items_center()
                                .child(
                                    div()
                                        .w(FORM_LABEL_W)
                                        .flex_shrink_0()
                                        .text_size(FONT_CAPTION)
                                        .text_color(theme.muted_foreground)
                                        .child(field_label),
                                )
                                .child(div().flex_1().min_w_0().child(Input::new(&browse_input)))
                                .child(
                                    Button::new("loc-browse")
                                        .outline()
                                        .rounded(RADIUS_BUTTON)
                                        .icon(icon("icons/folder.svg").with_size(px(13.)))
                                        .tooltip(if pick_files {
                                            t("Choose a folder or file")
                                        } else {
                                            t("Choose a folder")
                                        })
                                        .on_click({
                                            let entity = browse_entity.clone();
                                            let input = browse_input.clone();
                                            move |_, window, cx| {
                                                let input = input.clone();
                                                entity.update(cx, |this, cx| {
                                                    this.browse_for_location(
                                                        input, pick_files, window, cx,
                                                    )
                                                });
                                            }
                                        }),
                                ),
                        )
                        .when(remove.is_some() || reveal.is_some(), |el| {
                            el.child(
                                // 动作行遵循破坏性靠左惯例:Remove 靠左、Show in
                                // Finder 靠右。两钮手排:内边距 = 轴缩进,Remove
                                // 左侧再减 1.5 补 lucide 字形内白(24 视框留 3
                                // 单位),字形左缘正落标签轴;右钮文字右缘正落
                                // 浏览钮右缘。全正值内边距,胶囊完整在内容盒里
                                h_flex()
                                    .pt(SPACE_XS)
                                    .items_center()
                                    .justify_between()
                                    .when_some(remove.clone(), |el, remove| {
                                        let remove_entity = entity.clone();
                                        el.child(
                                            h_flex()
                                                .id("loc-remove")
                                                .h(BUTTON_SM_H)
                                                .pl(BUTTON_SM_PX - px(1.5))
                                                .pr(BUTTON_SM_PX)
                                                .rounded(RADIUS_BUTTON)
                                                .items_center()
                                                .gap(ICON_TEXT_GAP)
                                                .cursor_pointer()
                                                .text_size(FONT_BODY)
                                                .text_color(theme.danger)
                                                .hover(|s| s.bg(theme.danger.opacity(0.1)))
                                                .active(|s| s.bg(theme.danger.opacity(0.16)))
                                                .on_click(move |_, window, cx| {
                                                    // 整栈收场(表单+过期面板);
                                                    // 删除内会让面板重读快照
                                                    window.close_all_dialogs(cx);
                                                    let remove = remove.clone();
                                                    remove_entity.update(cx, |this, cx| {
                                                        remove(this, window, cx)
                                                    });
                                                })
                                                .child(
                                                    icon("icons/trash-2.svg")
                                                        .with_size(px(13.))
                                                        .flex_shrink_0(),
                                                )
                                                .child(t("Remove")),
                                        )
                                    })
                                    .when_some(reveal.clone(), |el, path| {
                                        el.child(
                                            h_flex()
                                                .id("loc-reveal")
                                                .h(BUTTON_SM_H)
                                                .px(BUTTON_SM_PX)
                                                .rounded(RADIUS_BUTTON)
                                                .items_center()
                                                .gap(ICON_TEXT_GAP)
                                                .cursor_pointer()
                                                .text_size(FONT_BODY)
                                                .text_color(theme.foreground)
                                                .hover(|s| s.bg(theme.secondary_hover))
                                                .active(|s| s.bg(theme.secondary_active))
                                                .on_click(move |_, _, _| {
                                                    terminal::open_in_file_manager(&path)
                                                })
                                                .child(
                                                    icon("icons/folder.svg")
                                                        .with_size(px(13.))
                                                        .flex_shrink_0()
                                                        .text_color(theme.muted_foreground),
                                                )
                                                .child(show_in_fm()),
                                        )
                                    }),
                            )
                        }),
                )
                .on_ok(move |_, window, cx| {
                    let path_text = ok_input.read(cx).text().to_string();
                    let agent = ok_sel.get();
                    let commit = ok_commit.clone();
                    ok_entity.update(cx, |this, cx| commit(this, agent, path_text, window, cx))
                });
            if dirty {
                dialog.footer(
                    gpui_component::dialog::DialogFooter::new()
                        .w_full()
                        .px(field_inset)
                        .child(
                            gpui_component::dialog::DialogClose::new()
                                .child(Button::new("location-cancel").label(t("Cancel")).outline()),
                        )
                        .child(
                            gpui_component::dialog::DialogAction::new().child(
                                Button::new("location-save")
                                    .label(ok_label.clone())
                                    .primary(),
                            ),
                        ),
                )
            } else {
                dialog
            }
        });
    }

    /// 表单的选择按钮:系统选择器,选中即回填输入框(取消无事发生);记忆来源的
    /// 表单也收文件
    fn browse_for_location(
        &mut self,
        input: Entity<InputState>,
        files: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let rx = cx.prompt_for_paths(PathPromptOptions {
            files,
            directories: true,
            multiple: false,
            prompt: Some(t("Choose").into()),
        });
        cx.spawn_in(window, async move |this, cx| {
            let dir = match rx.await {
                Ok(Ok(Some(paths))) if !paths.is_empty() => paths.into_iter().next().unwrap(),
                _ => return,
            };
            let text = dir.to_string_lossy().to_string();
            this.update_in(cx, |_, window, cx| {
                input.update(cx, |st, cx| st.set_value(text, window, cx));
            })
            .ok();
        })
        .detach();
    }

    /// 表单里手输/选中的路径整形(两个路径表单共用):`~` 展开;Windows 上把手输的
    /// '/' 折成 '\'(`~/.claude` 展开后是 `C:\Users\me/.claude` 这种混分隔符形态,而
    /// path_owns 的重叠判定是字节精确比较、explorer 只认反斜杠——不在入口归一,同一
    /// 目录就会以两种拼写各注册一份;POSIX 不动:'\' 在那边是合法文件名字符);绝对性
    /// 先判、只判一次(is_absolute 三端同判据,空串它也判 false;**必须判在剪尾之前**:
    /// `//` 剪完是空串,拿剪后的去判会退回未剪形态放行,2026-08-25 review);尾分隔符
    /// 剪掉(展示与重叠判定都吃这份),裸根("/"、"C:\")剪完会失去绝对性、原样保留。
    /// 不是绝对路径就弹提示、给 None
    fn absolute_form_path(
        &self,
        raw: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<String> {
        let expanded = expand_tilde(raw.trim());
        let expanded = if cfg!(target_os = "windows") {
            expanded.replace('/', "\\")
        } else {
            expanded
        };
        if !std::path::Path::new(&expanded).is_absolute() {
            window.push_notification(
                Notification::warning(t("Enter an absolute folder path")),
                cx,
            );
            return None;
        }
        let trimmed = expanded.trim_end_matches(std::path::is_separator);
        Some(if std::path::Path::new(trimmed).is_absolute() {
            trimmed.to_string()
        } else {
            expanded
        })
    }

    /// 表单落库。返回值交给 on_ok:false = 表单留着(校验没过,或已手工收场)。
    /// 纯路径管理:不校验目录内容(2026-08-24 用户定稿),只拒空/相对路径与
    /// 同家重叠;预设行的编辑落库为"压默认 + 记自定义"
    fn commit_location_form(
        &mut self,
        target: FormTarget,
        agent_new: AgentId,
        raw_text: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(path) = self.absolute_form_path(&raw_text, window, cx) else {
            return false;
        };
        // 各家归一化(codex:直选 sessions 树/平铺 archived 上提到家层,侧档
        // 找回)。静态分派,不依赖该家实例是否还在 roster(默认被移除时也要
        // 生效);归一化后再做无改动/重叠判定,选中默认根数据子目录会正确判"已覆盖"
        let path =
            wake_core::adapters::normalize_custom_root(agent_new, std::path::PathBuf::from(&path))
                .to_string_lossy()
                .to_string();
        // 没改就没事:直接让机制关表单,面板未过期。旧目标也要**同规归一化**
        // 再比——默认 Codex 的 sessions/archived 行原路径归一化后即 home,不归一
        // 化就比,单按 Enter 会被误判成编辑、静默把默认改成"压默认+记自定义"
        //(2026-08-24 Codex review)
        let unchanged = match &target {
            FormTarget::Add => false,
            FormTarget::Edit { agent, path: p, .. } => {
                *agent == agent_new
                    && wake_core::adapters::normalize_custom_root(
                        *agent,
                        std::path::PathBuf::from(p.as_ref()),
                    )
                    .to_string_lossy()
                        == path
            }
        };
        if unchanged {
            return true;
        }
        // 同家重叠检查,排除被编辑单元自身派生的根(自定义单元 = 其落库路径
        // 之下的根;预设单元 = 不属于任何该家自定义的根)。嵌进**别家**树里
        // 是合法场景(env 根的先例),同家嵌套才是重复读取
        let customs: Vec<(AgentId, SharedString)> = self
            .store
            .location_overrides()
            .0
            .into_iter()
            .map(|(a, p)| (a, SharedString::from(p.to_string_lossy().to_string())))
            .collect();
        let covered = self
            .data_locations
            .iter()
            .filter(|location| location.agent == agent_new)
            .any(|location| {
                let rs = location.path.to_string_lossy().to_string();
                let excluded = match &target {
                    FormTarget::Add => false,
                    FormTarget::Edit {
                        agent,
                        path: unit,
                        custom: true,
                        ..
                    } => *agent == agent_new && path_owns(unit.as_ref(), &rs),
                    FormTarget::Edit {
                        agent,
                        root,
                        custom: false,
                        individual_default: true,
                        ..
                    } => *agent == agent_new && rs == root.as_ref(),
                    FormTarget::Edit {
                        agent,
                        custom: false,
                        ..
                    } => *agent == agent_new && custom_owner(&customs, agent_new, &rs).is_none(),
                };
                !excluded && (path_owns(&path, &rs) || path_owns(&rs, &path))
            });
        if covered {
            window.push_notification(
                Notification::info(t("This folder is already in ContextOS's session locations")),
                cx,
            );
            return false;
        }
        let res = match &target {
            FormTarget::Add => self.store.add_custom_root(agent_new.as_str(), &path),
            // 全形态单事务(含换 agent 的编辑):半程失败不得把配置改成半生效
            //(Codex review P2)
            FormTarget::Edit {
                agent,
                path: old,
                root,
                custom,
                individual_default,
            } => self.store.replace_location(
                agent.as_str(),
                custom.then(|| old.as_ref()),
                (!custom && *individual_default).then(|| root.as_ref()),
                root.as_ref(),
                agent_new.as_str(),
                &path,
            ),
        };
        if let Err(e) = res {
            window.push_notification(Notification::error(crate::tf!("Save failed: {}", e)), cx);
            return false;
        }
        // Settings 页本身是动态快照，只需收起表单；Workbench notify 会让
        // SettingsView 观察者刷新列表。
        window.close_all_dialogs(cx);
        let note = match &target {
            FormTarget::Add => t("Location added"),
            FormTarget::Edit { .. } => t("Location updated"),
        };
        self.apply_roster_change(Ok(()), "", Notification::success(note), window, cx);
        false
    }

    /// 真正删除一个自定义 location。内置 location 不提供 Remove，只能用
    /// 行内开关暂时停用；磁盘文件始终不动。
    pub(crate) fn delete_location(
        &mut self,
        agent: AgentId,
        stored: SharedString,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let res = self
            .store
            .remove_custom_root(agent.as_str(), stored.as_ref());
        self.apply_roster_change(
            res,
            t("Remove failed"),
            Notification::info(t("Location removed")),
            window,
            cx,
        );
    }

    /// Restore defaults:清空全部偏离（自定义、被移除的预设与停用状态），
    /// 回到全部启用的内置默认 location。
    pub(crate) fn restore_default_locations(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let res = self.store.clear_location_overrides();
        self.apply_roster_change(
            res,
            t("Restore failed"),
            Notification::info(t("Locations restored to defaults")),
            window,
            cx,
        );
    }

    /// Session locations 行内开关。状态先落库，再整体换 active roster 与 watcher。
    pub(crate) fn set_location_enabled(
        &mut self,
        agent: AgentId,
        path: SharedString,
        enabled: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let res = self
            .store
            .set_location_enabled(agent.as_str(), path.as_ref(), enabled);
        self.apply_roster_change(
            res,
            t("Couldn't update location"),
            Notification::info(if enabled {
                t("Location enabled")
            } else {
                t("Location disabled")
            }),
            window,
            cx,
        );
    }

    /// 配置写库后的统一收尾:失败弹错;成功先跑 `on_ok`(location:roster 换代 + 补扫;
    /// 记忆来源:只同步一次记忆)再提示——location 增删改与开关、记忆来源增删改与开关
    /// 同一条时序,别各自手写。Settings 页观察 Workbench 的 notify 并重读快照,不需要
    /// 关闭 / 重开管理面板
    fn apply_config_change(
        &mut self,
        res: anyhow::Result<()>,
        err_prefix: &'static str,
        ok_note: Notification,
        on_ok: impl FnOnce(&mut Self, &mut Window, &mut Context<Self>),
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match res {
            Err(e) => window
                .push_notification(Notification::error(crate::tf!("{}: {}", err_prefix, e)), cx),
            Ok(()) => {
                on_ok(self, window, cx);
                window.push_notification(ok_note, cx);
            }
        }
    }

    /// location 变更(删 / 恢复 / 开关 / 表单提交成功)的收尾:roster 换代 + 补扫
    fn apply_roster_change(
        &mut self,
        res: anyhow::Result<()>,
        err_prefix: &'static str,
        ok_note: Notification,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.apply_config_change(
            res,
            err_prefix,
            ok_note,
            |this, _, cx| {
                this.rebuild_roster(cx);
                this.kick_incremental_scan(cx);
            },
            window,
            cx,
        );
    }

    // ---------- 记忆来源(Settings → Memory locations) ----------

    /// Memory locations 面板的快照:`memory_source_plan` 给的每个本地实例的来源(默认 +
    /// 项目模式 + 自定义,与 scanner 同一份),按 AgentId 声明序分组;计数按来源 id 从
    /// memories 表聚合(停用的来源行已出库,计数自然是 0)。三条 SQL + 每来源一次 stat:
    /// Settings 在 observe 回调里取一次,不在 render 里每帧算
    pub(crate) fn memory_location_settings_snapshot(&self) -> MemoryLocationSettingsSnapshot {
        let counts = self.store.memory_source_counts().unwrap_or_default();
        // 只是显示,读不出就按"没配置"画(scanner 那边读不出会整轮不动,别混为一谈)
        let (customs, disabled) = self.store.memory_source_overrides().unwrap_or_default();
        let diverged = !customs.is_empty() || !disabled.is_empty();
        let plan = wake_core::adapters::memory_source_plan(&self.adapters, &customs, &disabled);
        let mut by_agent: std::collections::BTreeMap<AgentId, Vec<MemoryLocationRow>> =
            std::collections::BTreeMap::new();
        for planned in plan {
            if !planned.host.is_empty() {
                continue;
            }
            for p in planned.sources {
                let agent = p.source.agent;
                let id = p.source.id();
                let pattern = p.source.is_pattern();
                let exists = pattern || p.source.path.exists();
                let count = counts
                    .get(&(agent.as_str().to_string(), id.clone()))
                    .copied()
                    .unwrap_or(0);
                by_agent.entry(agent).or_default().push(MemoryLocationRow {
                    agent,
                    display: if pattern {
                        id.clone().into()
                    } else {
                        tilde_path(&id).into()
                    },
                    tally: if exists {
                        file_tally(count).into()
                    } else {
                        t("Not found").into()
                    },
                    enabled: p.enabled,
                    raw: id.into(),
                    exists,
                    pattern,
                    custom: p.custom,
                });
            }
        }
        MemoryLocationSettingsSnapshot {
            rows: by_agent.into_values().flatten().collect(),
            diverged,
        }
    }

    pub(crate) fn open_add_memory_location_form(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.open_path_form(
            PathFormSpec {
                title: t("Add memory location"),
                ok_label: t("Add"),
                field_label: t("Folder or file"),
                init_agent: AgentId::ClaudeCode,
                init_path: "".into(),
                pick_files: true,
                reveal: None,
                remove: None,
                commit: Rc::new(|this, agent, text, window, cx| {
                    this.commit_memory_location_form(None, agent, text, window, cx)
                }),
            },
            window,
            cx,
        );
    }

    /// 只有自定义行可编辑(面板只对它们挂 Edit);默认来源由行内开关停用
    pub(crate) fn open_edit_memory_location_form(
        &mut self,
        row: MemoryLocationRow,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let old = (row.agent, row.raw.clone());
        let remove_old = old.clone();
        self.open_path_form(
            PathFormSpec {
                title: t("Edit memory location"),
                ok_label: t("Save"),
                field_label: t("Folder or file"),
                init_agent: row.agent,
                init_path: row.raw.clone(),
                pick_files: true,
                reveal: row.exists.then(|| row.raw.clone()),
                remove: Some(Rc::new(move |this, window, cx| {
                    this.delete_memory_source(remove_old.0, remove_old.1.clone(), window, cx)
                })),
                commit: Rc::new(move |this, agent, text, window, cx| {
                    this.commit_memory_location_form(Some(old.clone()), agent, text, window, cx)
                }),
            },
            window,
            cx,
        );
    }

    /// 记忆来源表单落库。纯路径管理:目录或文件都收、不校验内容,只拒相对路径与同家
    /// 重复(默认来源里已有、或自定义里已有);编辑走 replace_memory_source 单事务
    fn commit_memory_location_form(
        &mut self,
        old: Option<(AgentId, SharedString)>,
        agent_new: AgentId,
        raw_text: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(path) = self.absolute_form_path(&raw_text, window, cx) else {
            return false;
        };
        if old
            .as_ref()
            .is_some_and(|(agent, p)| *agent == agent_new && p.as_ref() == path)
        {
            return true;
        }
        // 与面板同一份来源清单查重:该家的默认具体路径(项目模式不算)与已有的自定义
        let (customs, disabled) = self.store.memory_source_overrides().unwrap_or_default();
        let duplicate =
            wake_core::adapters::memory_source_plan(&self.adapters, &customs, &disabled)
                .into_iter()
                .flat_map(|p| p.sources)
                .any(|p| {
                    p.source.agent == agent_new
                        && !p.source.is_pattern()
                        && p.source.path.to_string_lossy() == path
                });
        if duplicate {
            window.push_notification(
                Notification::info(t("This path is already in ContextOS's memory locations")),
                cx,
            );
            return false;
        }
        let res = match &old {
            None => self.store.add_memory_source(agent_new.as_str(), &path),
            Some((agent, p)) => self.store.replace_memory_source(
                agent.as_str(),
                p.as_ref(),
                agent_new.as_str(),
                &path,
            ),
        };
        if let Err(e) = res {
            window.push_notification(Notification::error(crate::tf!("Save failed: {}", e)), cx);
            return false;
        }
        window.close_all_dialogs(cx);
        let note = if old.is_none() {
            t("Location added")
        } else {
            t("Location updated")
        };
        self.memory_change_applied(window, cx);
        window.push_notification(Notification::success(note), cx);
        false
    }

    pub(crate) fn delete_memory_source(
        &mut self,
        agent: AgentId,
        stored: SharedString,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let res = self
            .store
            .remove_memory_source(agent.as_str(), stored.as_ref());
        self.apply_memory_change(
            res,
            t("Remove failed"),
            Notification::info(t("Location removed")),
            window,
            cx,
        );
    }

    pub(crate) fn restore_default_memory_locations(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let res = self.store.clear_memory_source_overrides();
        self.apply_memory_change(
            res,
            t("Restore failed"),
            Notification::info(t("Locations restored to defaults")),
            window,
            cx,
        );
    }

    /// Memory locations 行内开关
    pub(crate) fn set_memory_source_enabled(
        &mut self,
        agent: AgentId,
        id: SharedString,
        enabled: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let res = self
            .store
            .set_memory_source_enabled(agent.as_str(), id.as_ref(), enabled);
        self.apply_memory_change(
            res,
            t("Couldn't update location"),
            Notification::info(if enabled {
                t("Location enabled")
            } else {
                t("Location disabled")
            }),
            window,
            cx,
        );
    }

    /// 记忆来源变更的收尾:只同步一次记忆(`sync_memories_quietly` 按新配置重读,不重扫
    /// 会话、不换 roster;扫描进行中就交给它的收尾)
    fn apply_memory_change(
        &mut self,
        res: anyhow::Result<()>,
        err_prefix: &'static str,
        ok_note: Notification,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.apply_config_change(
            res,
            err_prefix,
            ok_note,
            Self::memory_change_applied,
            window,
            cx,
        );
    }

    /// 记忆来源配置已落库之后该做的事(表单提交成功也走这里)
    fn memory_change_applied(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        self.sync_memories_quietly(cx);
        cx.notify();
    }

    // ---------- 远程 host(Settings → Remote hosts) ----------

    /// Settings 的 Sync now 按钮 busy 态(rsync 线程运行中)
    pub(crate) fn remote_sync_in_progress(&self) -> bool {
        !self.syncing_hosts.is_empty()
    }

    pub(crate) fn remote_hosts_snapshot(&self) -> Vec<RemoteHostRow> {
        let counts = self.store.host_counts().unwrap_or_default();
        self.store
            .list_remote_hosts()
            .unwrap_or_default()
            .into_iter()
            .map(|host| {
                let tally = session_tally(counts.get(&host.name).copied().unwrap_or(0));
                let (status, failed) = match (&host.last_sync_error, host.last_sync_at) {
                    (Some(err), _) => (crate::tf!("Sync failed: {}", err), true),
                    (None, Some(ts)) => {
                        (crate::tf!("{} · synced {}", tally, smart_time(ts)), false)
                    }
                    (None, None) => (crate::tf!("{} · never synced", tally), false),
                };
                RemoteHostRow {
                    name: host.name.into(),
                    enabled: host.enabled,
                    status: status.into(),
                    failed,
                }
            })
            .collect()
    }

    pub(crate) fn add_remote_host(
        &mut self,
        name: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !wake_core::remote::valid_host_name(name) {
            window.push_notification(
                Notification::error(t(
                    "Host must be an SSH alias or user@host (letters, digits, . _ - @)",
                )),
                cx,
            );
            return;
        }
        match self.store.add_remote_host(name) {
            Err(e) => window.push_notification(
                Notification::error(crate::tf!("Couldn't add remote host: {}", e)),
                cx,
            ),
            Ok(()) => {
                self.rebuild_roster(cx);
                // 只拉新加的这台(别把既有 host 的整棵树再协商一遍):
                // BatchMode 的 rsync 失败会记进 last_sync_error,面板下一帧
                // 就能给出"密钥不在 agent 里"这类反馈
                self.spawn_remote_sync(vec![name.to_string()], cx);
                window.push_notification(
                    Notification::info(crate::tf!("Syncing sessions from {}…", name)),
                    cx,
                );
            }
        }
    }

    pub(crate) fn set_remote_host_enabled(
        &mut self,
        name: &str,
        enabled: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // 与 location 停用同语义:禁用 → roster 移除实例 → 补扫把该 host
        // 的行按"磁盘已删"出清;缓存保留,重新启用即收编回来
        let res = self.store.set_remote_host_enabled(name, enabled);
        let note = Notification::info(if enabled {
            t("Remote host enabled")
        } else {
            t("Remote host disabled")
        });
        self.apply_roster_change(res, t("Couldn't update remote host"), note, window, cx);
    }

    /// Remove 按确认流程走:索引行与本地缓存一并清掉,远端文件不动。
    pub(crate) fn confirm_remove_remote_host(
        &mut self,
        name: SharedString,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let entity = cx.entity();
        window.open_alert_dialog(cx, move |dialog, _window, cx| {
            let name = name.clone();
            let entity = entity.clone();
            let theme = cx.theme();
            dialog
                .title(
                    div()
                        .text_size(FONT_HEADING)
                        .font_semibold()
                        .child(crate::tf!("Remove {}?", name)),
                )
                .width(px(440.))
                .confirm()
                .button_props(
                    gpui_component::dialog::DialogButtonProps::default()
                        .ok_text(t("Remove"))
                        .ok_variant(gpui_component::button::ButtonVariant::Danger),
                )
                .child(
                    div()
                        .text_size(FONT_BODY)
                        .text_color(theme.foreground)
                        .child(
                            "Its sessions leave the index and the local cache is deleted. \
                             Nothing on the remote host is touched.",
                        ),
                )
                .on_ok(move |_, window, cx| {
                    entity.update(cx, |this, cx| {
                        this.remove_remote_host(name.as_ref(), window, cx);
                    });
                    true
                })
        });
    }

    fn remove_remote_host(&mut self, name: &str, window: &mut Window, cx: &mut Context<Self>) {
        if let Err(e) = self.store.remove_remote_host(name) {
            window.push_notification(
                Notification::error(crate::tf!("Couldn't remove remote host: {}", e)),
                cx,
            );
            return;
        }
        // 排队中的同步请求剔除该 host,别在删除后又把 transcripts 拉回来;
        // 正在跑的 rsync 取消不了(阻塞在 Command::output),它写回的目录由
        // RemoteSyncDone 的孤儿缓存清理兜底(那里按配置表裁决,幂等)
        self.pending_sync.retain(|n| n != name);
        // 先换代(旧 watcher drop 后不再监听该缓存),再删缓存目录,最后补扫
        // 出清库内行——删目录放独立线程,大缓存树的删除不该冻住 UI
        self.rebuild_roster(cx);
        if let Some(db_dir) = self.store.db_dir() {
            let cache = wake_core::remote::host_cache_dir(&db_dir, name);
            let (store, bg_tx) = (self.store.clone(), self.bg_tx.clone());
            std::thread::spawn(move || {
                let _ = std::fs::remove_dir_all(cache);
                report_remote_cache_size(&store, &bg_tx);
            });
        }
        self.kick_incremental_scan(cx);
        window.push_notification(Notification::info(t("Remote host removed")), cx);
    }

    /// 起远程同步(add host / Sync now / ⌘R 共用)。rsync 在独立线程,
    /// 与扫描并行;进行中再来请求则把这几台排队,收工后只补它们。
    /// 完成经 RemoteSyncDone 事件收编缓存,扫描侧完全不感知。
    pub(crate) fn spawn_remote_sync(&mut self, names: Vec<String>, cx: &mut Context<Self>) {
        if names.is_empty() {
            return;
        }
        if !self.syncing_hosts.is_empty() {
            for n in names {
                if !self.pending_sync.contains(&n) {
                    self.pending_sync.push(n);
                }
            }
            return;
        }
        spawn_remote_sync_thread(&self.store, self.bg_tx.clone(), names.clone());
        self.syncing_hosts = names;
        cx.notify();
    }

    pub(crate) fn sync_all_remote_hosts(&mut self, cx: &mut Context<Self>) {
        let names = self.store.enabled_remote_host_names();
        self.spawn_remote_sync(names, cx);
    }

    /// roster 换代后补一轮增量:新根收录、被移根出清。撞上进行中的扫描
    /// 撞上进行中的扫描则排队，由终态事件补扫。
    fn kick_incremental_scan(&mut self, cx: &mut Context<Self>) {
        if self.scan.scanning {
            self.pending_rescan = true;
            return;
        }
        self.scan = ScanProgress {
            scanning: true,
            ..Default::default()
        };
        cx.notify();
        spawn_scan(
            self.adapters.clone(),
            self.store.clone(),
            self.scan_events.clone(),
            false,
        );
    }

    fn on_bg_event(&mut self, ev: BgEvent, cx: &mut Context<Self>) -> Option<Notification> {
        match ev {
            BgEvent::Progress(p) => {
                let note = if !p.scanning && self.refreshing {
                    self.refreshing = false;
                    Some(match &p.error {
                        None => Notification::success(t("Sessions refreshed")),
                        Some(err) => Notification::error(crate::tf!("Refresh failed: {}", err)),
                    })
                } else {
                    None
                };
                self.scan = p;
                // 扫描期间发生过 location 变更:那轮用的是旧 roster,
                // 终态一到立刻用当前 roster 补一轮增量
                if !self.scan.scanning && self.pending_rescan {
                    self.pending_rescan = false;
                    self.kick_incremental_scan(cx);
                }
                // 扫描期间整页目的地的重载被按住(见 reload_insights 注释),终态补最后一次;
                // 扫描期间排队的记忆同步也在这里补
                if !self.scan.scanning {
                    self.reload_page(cx);
                    self.drain_pending_memory_sync(cx);
                }
                cx.notify();
                note
            }
            BgEvent::Changed => {
                self.refresh(cx);
                None
            }
            BgEvent::RescanNeeded => {
                // 撞上进行中的扫描就排队,由终态事件补扫(kick_incremental_scan
                // 自带这条状态机);连续多条 rescan 也只会排一次
                self.kick_incremental_scan(cx);
                None
            }
            BgEvent::RemoteCacheBytes(bytes) => {
                self.remote_cache_bytes = Some(bytes);
                cx.notify();
                None
            }
            BgEvent::WorkspaceChangesChanged => {
                self.workspace_roots = self
                    .workspace_store
                    .list_workspace_roots()
                    .unwrap_or_default();
                if self.page == Page::Insights
                {
                    match self.insights_subview {
                        InsightsSubview::WorkspaceChanges => self.reload_workspace_changes(true, cx),
                        InsightsSubview::SessionChanges => self.reload_session_changes(cx),
                        InsightsSubview::Overview => {}
                    }
                }
                None
            }
            BgEvent::RemoteSyncDone => {
                self.syncing_hosts.clear();
                // 同步期间被排队的 host(如 add host)接着跑;与下面的收编
                // 并行,互不等待
                let queued = std::mem::take(&mut self.pending_sync);
                self.spawn_remote_sync(queued, cx);
                // 首次同步会创建 watcher 挂载时还不存在的缓存目录——磁盘上
                // 出现了监听集(watcher 报的真实挂载根)之外的新根才重挂;
                // 稳态下 rsync 落盘由现有监听收编,不白付 drop+join(watcher
                // 正忙时是一整个去抖批次)的等待
                let watched = self.runtime.watched_roots();
                let grown = self
                    .adapters
                    .iter()
                    .flat_map(|a| a.watch_paths())
                    .any(|p| watched.as_ref().is_none_or(|w| !w.contains(&p)) && p.is_dir());
                if grown {
                    self.remount_watcher();
                }
                // 补扫不能省:SQLite 型侧档(copilot/opencode/antigravity)
                // watcher 只认 .jsonl,远程缓存里这些库的更新只有扫描能收
                self.kick_incremental_scan(cx);
                cx.notify();
                None
            }
            BgEvent::LayaRuntimeChanged => {
                cx.notify();
                None
            }
            BgEvent::LayaRuntimeFinished(result) => {
                cx.notify();
                Some(match result {
                    Ok(message) => Notification::success(message),
                    Err(message) => Notification::error(message),
                })
            }
            BgEvent::LayaExternalProbeFinished(result) => {
                let note = match result {
                    Ok(capabilities) => {
                        let single = capabilities.single;
                        let batch = capabilities.batch;
                        self.laya_external_capabilities = Some(capabilities);
                        if single && batch {
                            Notification::success("外部 Laya Single 兼容与原生 Batch 均可用")
                        } else if single {
                            Notification::success(
                                "外部 Laya Single 兼容可用；Batch 不可用，不影响压缩",
                            )
                        } else {
                            Notification::error(
                                "外部服务不支持 /v1/systemone；当前压缩流程不能使用",
                            )
                        }
                    }
                    Err(message) => Notification::error(message),
                };
                cx.notify();
                Some(note)
            }
        }
    }

    // ---------- 事件处理 ----------

    fn on_list_event(
        &mut self,
        list: &Entity<ListState<SessionsDelegate>>,
        ev: &ListEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // Hidden library selection restoration must not replace cleanup preview.
        if self.cleanup.open {
            return;
        }
        let ix = match ev {
            ListEvent::Select(ix) | ListEvent::Confirm(ix) => *ix,
            ListEvent::Cancel => return,
        };
        let key = {
            let list = list.read(cx);
            let delegate = list.delegate();
            delegate.row_key(ix).map(str::to_string)
        };
        if let Some(key) = key {
            if matches!(ev, ListEvent::Confirm(_)) && self.pending_link_parent.is_some() {
                self._list_seek_task = None;
                self.select_relationship_child(&key, window, cx);
                return;
            }
            if matches!(ev, ListEvent::Confirm(_))
                && self
                    .detail
                    .as_ref()
                    .is_some_and(|detail| detail.meta.key == key)
                && self.toggle_list_key(&key, window, cx)
            {
                return;
            }
            // 用户手动选择优先于尚未完成的搜索定位，避免旧任务稍后抢回高亮。
            self._list_seek_task = None;
            self.open_detail(&key, None, window, cx);
        }
    }

    fn on_palette_event(
        &mut self,
        _list: &Entity<ListState<SearchDelegate>>,
        ev: &ListEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match ev {
            ListEvent::Confirm(ix) => self.open_palette_hit(ix.row, window, cx),
            // Select 仅表示高亮移动,不打开
            ListEvent::Select(_) => {}
            // 焦点在结果列表内(鼠标点过行)时 esc 走这里;焦点在输入框时
            // esc 由 Input 冒泡给 Dialog 的 keyboard Cancel 关闭
            ListEvent::Cancel => window.close_dialog(cx),
        }
    }

    pub fn toggle_search(&mut self, _: &ToggleSearch, window: &mut Window, cx: &mut Context<Self>) {
        if window.has_active_dialog(cx) {
            window.close_dialog(cx);
            return;
        }
        let list = self.palette_list.clone();
        let input = self.palette_input.clone();
        let this = cx.entity();
        open_closable_dialog(window, cx, move |dialog, window, cx| {
            let theme = cx.theme();
            // 输入框尺寸;清除钮的 suffix 补偿 margin 从它派生,改档自动跟随
            let input_size = gpui_component::Size::Large;
            dialog
                .w(px(680.))
                .margin_top(px(72.))
                // Dialog 默认内容 padding 24px 四边;水平 20,用户定稿(2026-08-18)
                .px(SPACE_XL)
                .close_button(false)
                .child(
                    v_flex()
                        // ↑↓ 在 Input 内不被消费,冒泡到这里走 main.rs 的
                        // PALETTE_CONTEXT 键位(Input 拆出 List 后原生 List 绑定够不着)
                        .key_context(PALETTE_CONTEXT)
                        .relative()
                        .on_action(window.listener_for(
                            &this,
                            |wb: &mut Self, _: &PaletteUp, window, cx| {
                                wb.palette_move(-1, window, cx)
                            },
                        ))
                        .on_action(window.listener_for(
                            &this,
                            |wb: &mut Self, _: &PaletteDown, window, cx| {
                                wb.palette_move(1, window, cx)
                            },
                        ))
                        // 定高 + 列表 flex_1:输入行/footer 尺寸变化时列表自适应,
                        // 不用手工重算列表高度
                        .h(PALETTE_HEIGHT)
                        .gap(SPACE_MD)
                        .child(
                            div()
                                .flex_shrink_0()
                                .px(SPACE_SM)
                                .border_b_1()
                                .border_color(theme.border)
                                .child(search_input_control(
                                    &input,
                                    input_size,
                                    "palette-clear",
                                    cx,
                                )),
                        )
                        .child(
                            List::new(&list)
                                .with_size(gpui_component::Size::Large)
                                .flex_1()
                                .min_h_0(),
                        )
                        .child(
                            h_flex()
                                .flex_shrink_0()
                                .border_t_1()
                                .border_color(theme.border)
                                .pt(SPACE_SM)
                                // 与输入行的壳同缩进:文字与放大镜/清除钮左右对齐
                                .px(SPACE_SM)
                                .justify_between()
                                .text_size(FONT_LABEL)
                                .text_color(theme.muted_foreground)
                                .child(t("Scope: all sessions"))
                                .child(
                                    h_flex()
                                        .gap(SPACE_MD)
                                        .child(t("↑↓ navigate"))
                                        .child(t("↩ open"))
                                        .child(t("esc close")),
                                ),
                        ),
                )
        });
        let focus_input = self.palette_input.clone();
        cx.defer_in(window, move |_, window, cx| {
            focus_input.update(cx, |st, cx| st.focus(window, cx));
        });
        cx.notify();
    }

    /// ⌘K 输入框事件:文字变化驱动搜索,回车打开选中项
    fn on_palette_input_event(
        &mut self,
        input: &Entity<InputState>,
        ev: &InputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match ev {
            InputEvent::Change => {
                let q = input.read(cx).value().trim().to_string();
                if self.palette_list.read(cx).delegate().last_query == q {
                    return;
                }
                // 清空(点清除钮/删光)结果已知,同步清态,省掉线程往返
                if q.is_empty() {
                    self._palette_search_task = None;
                    self.palette_list.update(cx, |state, cx| {
                        let d = state.delegate_mut();
                        d.hits = Vec::new();
                        d.degraded = false;
                        d.last_query = String::new();
                        state.set_selected_index(None, window, cx);
                        cx.notify();
                    });
                    return;
                }
                let task = self.palette_list.update(cx, |state, cx| {
                    state.set_selected_index(None, window, cx);
                    state.delegate_mut().perform_search(&q, window, cx)
                });
                // 搜索回填后选中首条并回滚到顶(覆盖旧任务 = 取消过期搜索)
                self._palette_search_task = Some(cx.spawn_in(window, async move |this, cx| {
                    task.await;
                    this.update_in(cx, |this, window, cx| {
                        this.palette_list.update(cx, |state, cx| {
                            let has_hits = !state.delegate().hits.is_empty();
                            state.set_selected_index(has_hits.then(IndexPath::default), window, cx);
                            // scroll_to_item 自带 notify,列表随之重绘
                            state.scroll_to_item(
                                IndexPath::default(),
                                ScrollStrategy::Top,
                                window,
                                cx,
                            );
                        });
                    })
                    .ok();
                }));
            }
            InputEvent::PressEnter { .. } => {
                let row = self
                    .palette_list
                    .read(cx)
                    .selected_index()
                    .map(|i| i.row)
                    .unwrap_or(0);
                self.open_palette_hit(row, window, cx);
            }
            _ => {}
        }
    }

    /// 打开第 row 条搜索命中(回车与鼠标点击共用),定位到命中消息
    fn open_palette_hit(&mut self, row: usize, window: &mut Window, cx: &mut Context<Self>) {
        if self.page == Page::Skills && !self.allow_skill_navigation(window, cx) {
            return;
        }
        let hit = self
            .palette_list
            .read(cx)
            .delegate()
            .hits
            .get(row)
            .map(|h| (h.session.key.clone(), h.seq));
        if let Some((key, seq)) = hit {
            window.close_dialog(cx);
            self.open_detail(&key, Some(seq), window, cx);
        }
    }

    /// ⌘K 面板 ↑↓:焦点在输入框,选中态手动挪(clamp 到两端,不循环)。
    /// 按 row 平移——SearchDelegate 单 section,section 恒 0
    fn palette_move(&mut self, delta: i64, window: &mut Window, cx: &mut Context<Self>) {
        self.palette_list.update(cx, |state, cx| {
            let n = state.delegate().hits.len() as i64;
            if n == 0 {
                return;
            }
            let cur = state.selected_index().map(|ix| ix.row as i64).unwrap_or(-1);
            let next = (cur + delta).clamp(0, n - 1) as usize;
            state.set_selected_index(Some(IndexPath::new(next)), window, cx);
            // scroll_to_selected_item 内部 notify,选中高亮随之重绘
            state.scroll_to_selected_item(window, cx);
        });
    }

    // ---------- 详情 ----------

    fn copy_session_path(&mut self, cx: &mut Context<Self>) {
        let Some(detail) = &mut self.detail else {
            return;
        };
        let Some(path) = detail.source_path.as_ref().filter(|path| !path.is_empty()) else {
            return;
        };
        cx.write_to_clipboard(ClipboardItem::new_string(path.clone()));
        let key = detail.meta.key.clone();
        let load_id = detail.load_id;
        detail.copy_path_reset = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(1_600))
                .await;
            this.update(cx, |this, cx| {
                if let Some(detail) = detail_for_load(
                    &mut this.detail,
                    &mut this.cleanup.saved_detail,
                    &key,
                    load_id,
                ) {
                    detail.copy_path_reset = None;
                    cx.notify();
                }
            })
            .ok();
        }));
        cx.notify();
    }

    fn toggle_session_tag(
        &mut self,
        tag: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(detail) = &mut self.detail else {
            return;
        };
        let key = detail.meta.key.clone();
        let enabled = !detail.tags.contains(tag);
        let label = session_tag_label(tag);
        match self.store.set_session_tag(&key, tag, enabled) {
            Ok(()) => {
                if enabled {
                    detail.tags.insert(tag.to_string());
                    window.push_notification(
                        Notification::success(crate::tf!("已添加标签：{}", label)),
                        cx,
                    );
                } else {
                    detail.tags.remove(tag);
                    window.push_notification(
                        Notification::success(crate::tf!("已移除标签：{}", label)),
                        cx,
                    );
                }
                self.refresh(cx);
                cx.notify();
            }
            Err(error) => {
                window.push_notification(
                    Notification::error(crate::tf!("无法更新标签：{}", format!("{error:#}"))),
                    cx,
                );
            }
        }
    }

    fn mark_relationship_parent(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(detail) = &self.detail else {
            return;
        };
        self.pending_link_parent = Some((detail.meta.key.clone(), detail.meta.title.clone()));
        self.pending_link_child = None;
        window.push_notification(
            Notification::success(t("请在会话列表中选择要连接的会话")),
            cx,
        );
        cx.notify();
    }

    fn select_relationship_child(
        &mut self,
        key: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some((parent_key, parent_title)) = self.pending_link_parent.clone() else {
            return false;
        };
        if parent_key == key {
            window.push_notification(Notification::warning(t("不能把会话连接到自己")), cx);
            return true;
        }
        let Ok(Some(child)) = self.store.get_session(key) else {
            return false;
        };
        self.pending_link_child = Some((child.key.clone(), child.title.clone()));
        window.push_notification(
            Notification::success(crate::tf!(
                "已选择连接：{} → {}",
                clip_display(&parent_title, 18),
                clip_display(&child.title, 18)
            )),
            cx,
        );
        cx.notify();
        true
    }

    fn cancel_pending_relationship(&mut self, cx: &mut Context<Self>) {
        self.pending_link_parent = None;
        self.pending_link_child = None;
        cx.notify();
    }

    fn connect_pending_relationship(
        &mut self,
        relation: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some((parent_key, parent_title)) = self.pending_link_parent.clone() else {
            return;
        };
        let Some((child_key, child_title)) = self.pending_link_child.clone() else {
            window.push_notification(
                Notification::warning(t("请先在会话列表中选择要连接的会话")),
                cx,
            );
            return;
        };
        if parent_key == child_key {
            window.push_notification(Notification::warning(t("不能把会话连接到自己")), cx);
            return;
        }
        match self
            .store
            .set_session_link(&parent_key, &child_key, relation)
        {
            Ok(()) => {
                if let Some(detail) = &mut self.detail {
                    if detail.meta.key == parent_key {
                        if let Ok((parents, children)) =
                            self.store.session_relationships(&parent_key)
                        {
                            detail.link_parent_count = parents.len() as i64;
                            detail.link_child_count = children.len() as i64;
                            detail.link_parents = parents;
                            detail.link_children = children;
                        }
                        if let Ok((parents, children)) =
                            self.store.session_relationship_tree(&parent_key, 3)
                        {
                            detail.link_parent_tree = parents;
                            detail.link_child_tree = children;
                        }
                        self.relationship_edges =
                            self.store.all_session_relationships().unwrap_or_default();
                    }
                }
                self.pending_link_parent = None;
                self.pending_link_child = None;
                window.push_notification(
                    Notification::success(crate::tf!(
                        "已建立{}关系：{} → {}",
                        session_relation_label(relation),
                        clip_display(&parent_title, 16),
                        clip_display(&child_title, 16)
                    )),
                    cx,
                );
                cx.notify();
            }
            Err(error) => {
                window.push_notification(
                    Notification::error(crate::tf!("无法建立关系：{}", format!("{error:#}"))),
                    cx,
                );
            }
        }
    }

    fn refresh_detail_relationships(&mut self, key: &str) {
        let Some(detail) = &mut self.detail else {
            return;
        };
        if detail.meta.key != key {
            return;
        }
        if let Ok((parents, children)) = self.store.session_relationships(key) {
            detail.link_parent_count = parents.len() as i64;
            detail.link_child_count = children.len() as i64;
            detail.link_parents = parents;
            detail.link_children = children;
        }
        if let Ok((parents, children)) = self.store.session_relationship_tree(key, 3) {
            detail.link_parent_tree = parents;
            detail.link_child_tree = children;
        }
    }

    fn update_relationship_edge(
        &mut self,
        parent: &str,
        child: &str,
        old_relation: &str,
        new_relation: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match self
            .store
            .update_session_link_relation(parent, child, old_relation, new_relation)
        {
            Ok(()) => {
                let current_key = self.detail.as_ref().map(|detail| detail.meta.key.clone());
                if let Some(key) = current_key {
                    self.refresh_detail_relationships(&key);
                }
                self.relationship_edges =
                    self.store.all_session_relationships().unwrap_or_default();
                window.push_notification(
                    Notification::success(crate::tf!(
                        "已改为{}关系",
                        session_relation_label(new_relation)
                    )),
                    cx,
                );
                cx.notify();
            }
            Err(error) => {
                window.push_notification(
                    Notification::error(crate::tf!("无法修改关系：{}", format!("{error:#}"))),
                    cx,
                );
            }
        }
    }

    fn delete_relationship_edge(
        &mut self,
        parent: &str,
        child: &str,
        relation: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match self.store.delete_session_link(parent, child, relation) {
            Ok(()) => {
                let current_key = self.detail.as_ref().map(|detail| detail.meta.key.clone());
                if let Some(key) = current_key {
                    self.refresh_detail_relationships(&key);
                }
                self.relationship_edges =
                    self.store.all_session_relationships().unwrap_or_default();
                window.push_notification(Notification::success(t("已删除关系")), cx);
                cx.notify();
            }
            Err(error) => {
                window.push_notification(
                    Notification::error(crate::tf!("无法删除关系：{}", format!("{error:#}"))),
                    cx,
                );
            }
        }
    }

    fn open_detail(
        &mut self,
        key: &str,
        jump_seq: Option<i64>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if jump_seq.is_some() {
            self.leave_cleanup(cx);
        }
        let Ok(Some(meta)) = self.store.get_session(key) else {
            return;
        };
        let mut detail = DetailState::loading(meta.clone(), jump_seq);
        detail.tags = self
            .store
            .session_tags(key)
            .unwrap_or_default()
            .into_iter()
            .collect();
        if let Ok((parents, children)) = self.store.session_link_counts(key) {
            detail.link_parent_count = parents;
            detail.link_child_count = children;
        }
        if let Ok((parents, children)) = self.store.session_relationships(key) {
            detail.link_parents = parents;
            detail.link_children = children;
        }
        if let Ok((parents, children)) = self.store.session_relationship_tree(key, 3) {
            detail.link_parent_tree = parents;
            detail.link_child_tree = children;
        }
        let load_id = detail.load_id;
        self.detail = Some(detail);
        // 搜索路径:中栏列表同步选中并滚到该会话。
        // 列表点击路径(jump=None)不走——List 点击自带选中,再滚会跳视口
        if jump_seq.is_some() {
            self.sync_list_selection(key, window, cx);
        }
        cx.notify();

        // Resolving a virtual path can stat a slow/unavailable custom location.
        // Keep that off the UI thread, without waiting for transcript parsing.
        let source_key = meta.key.clone();
        let file_path = meta.file_path.clone();
        let source_task =
            cx.background_spawn(async move { session_source_path(&file_path).to_string() });
        cx.spawn(async move |this, cx| {
            let source_path = source_task.await;
            this.update(cx, |this, cx| {
                if let Some(detail) = detail_for_load(
                    &mut this.detail,
                    &mut this.cleanup.saved_detail,
                    &source_key,
                    load_id,
                ) {
                    detail.source_path = Some(source_path);
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();

        let adapters = self.adapters.clone();
        let task = cx.background_spawn(async move {
            let result =
                load_visible_transcript(&adapters, &meta).map(|(mut messages, usage_events)| {
                    let images = take_image_slots(&mut messages);
                    (messages, images, usage_events)
                });
            (meta.key.clone(), result)
        });
        cx.spawn_in(window, async move |this, cx| {
            let (key, result) = task.await;
            this.update_in(cx, |this, _window, cx| {
                let detail = detail_for_load(
                    &mut this.detail,
                    &mut this.cleanup.saved_detail,
                    &key,
                    load_id,
                );
                if let Some(detail) = detail {
                    detail.loading = false;
                    match result {
                        Ok((messages, images, usage_events)) => {
                            detail.reader_turns = build_detail_turns(&messages, &usage_events);
                            detail.transcript = Rc::new(messages);
                            rebuild_detail_reader_view(detail, this.detail_outline_mode);
                            // 搜索跳转:seq → 可见消息下标,滚到视口顶。
                            // FTS 命中的行可能被详情过滤(如空文本),用 >= 落到
                            // 其后最近一条;找不到(尾部被滤)则保持默认落底。
                            // jump_seq 归一为落点消息的实际 seq——高亮按精确相等
                            // 渲染,不归一则命中被滤时滚动与高亮指向不同行
                            if let Some(seq) = detail.jump_seq {
                                if let Some(transcript_ix) =
                                    detail.transcript.iter().position(|m| m.seq >= seq)
                                {
                                    detail.jump_seq = Some(detail.transcript[transcript_ix].seq);
                                    if let Some(ix) = detail
                                        .reader_visible_indices
                                        .iter()
                                        .position(|&index| index == transcript_ix)
                                    {
                                        detail.msg_list.scroll_to(gpui::ListOffset {
                                            item_ix: ix,
                                            offset_in_item: px(0.),
                                        });
                                    }
                                }
                            }
                            let query = this
                                .detail_search_input
                                .read(cx)
                                .value()
                                .trim()
                                .to_lowercase();
                            detail.search_matches = if query.is_empty() {
                                Vec::new()
                            } else {
                                detail
                                    .reader_visible_indices
                                    .iter()
                                    .copied()
                                    .filter(|&index| {
                                        transcript_message_matches(
                                            &detail.transcript[index],
                                            &query,
                                        )
                                    })
                                    .collect()
                            };
                            detail.search_cursor = 0;
                            detail.images = images;
                            detail.zoom = None;
                            detail.error = None;
                        }
                        Err(error) => {
                            detail.transcript = Rc::new(Vec::new());
                            detail.images.clear();
                            detail.zoom = None;
                            detail.msg_list =
                                gpui::ListState::new(0, gpui::ListAlignment::Bottom, px(512.));
                            detail.error = Some(error.into());
                        }
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// 侧栏目的地互斥的唯一写入点:三个筛选字段与"离开 Insights"一起落,
    /// 每个导航行只算自己的目标值——新目的地不必再逐个 listener 补互斥
    fn set_scope(
        &mut self,
        agent: Option<AgentId>,
        project: Option<String>,
        favorite: bool,
        cx: &mut Context<Self>,
    ) {
        self.leave_cleanup(cx);
        self.selected_agent = agent;
        self.selected_project = project;
        self.selected_tag = None;
        self.selected_model = None;
        self.favorite_only = favorite;
        self.page = Page::Sessions;
        self.refresh(cx);
    }

    fn set_tag_scope(&mut self, tag: Option<String>, cx: &mut Context<Self>) {
        self.leave_cleanup(cx);
        self.selected_agent = None;
        self.selected_project = None;
        self.favorite_only = false;
        self.selected_tag = tag;
        self.selected_model = None;
        self.page = Page::Sessions;
        self.refresh(cx);
    }

    /// Insights 榜单行下钻:回会话页,按行所属的组筛好,token 从高到低。
    /// 三个筛选槽互斥——落自己的、清别的,与 set_scope 同一写入纪律
    fn drill_into_usage(
        &mut self,
        board: UsageBoard,
        key: &str,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.leave_cleanup(cx);
        self.selected_agent = None;
        self.selected_project = None;
        self.selected_tag = None;
        self.favorite_only = false;
        self.selected_model = None;
        match board {
            UsageBoard::Agents => {
                self.selected_agent = AgentId::from_str(key);
                // 未识别的 agent_id(异常数据)不下钻,免得给出无筛选的列表
                if self.selected_agent.is_none() {
                    cx.notify();
                    return;
                }
            }
            UsageBoard::Projects => self.selected_project = Some(key.to_string()),
            UsageBoard::Models => self.selected_model = Some(key.to_string()),
        }
        self.sort_key = SortKey::Tokens;
        self.sort_ascending = false;
        self.page = Page::Sessions;
        self.refresh(cx);
    }

    /// 清空过滤回 All Sessions 视图(侧栏点击与搜索打开共用;
    /// 已在 All Sessions 时 refresh 幂等,微秒级)
    fn show_all_sessions(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        self.set_scope(None, None, false, cx);
    }

    /// 搜索命中打开:侧栏切回 All Sessions(搜索是全库范围,过滤视图下
    /// 命中可能不在列表里),中栏定位选中该会话并滚到可见
    fn sync_list_selection(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) {
        self._list_seek_task = None;
        // 全文搜索包含归档会话，而 All Sessions 明确排除归档。归档命中仍可在
        // 右栏打开，但不能为了一个永远不可见的 key 把所有活动页全部读进内存。
        if !self
            .store
            .get_session(key)
            .ok()
            .flatten()
            .is_some_and(|session| !session.archived)
        {
            // 阅读面只在会话页才画:从 Memory / Insights(或清理模式)里 ⌘K 打开归档命中,
            // 得先落回会话页,否则 detail 设了却什么都不显示(2026-09-21 review)
            self.leave_cleanup(cx);
            self.page = Page::Sessions;
            cx.notify();
            return;
        }
        self.show_all_sessions(window, cx);
        // show_all_sessions 的通用刷新会暂存刷新前的旧选择；搜索有更明确的新
        // 目标，不能让下一帧的恢复逻辑把刚选中的搜索命中覆盖回去。
        self.pending_list_selection = None;
        if !self.select_list_key(key, true, window, cx) {
            self.seek_list_key(key, window, cx);
        }
    }

    fn open_relationship_session_in_sessions(
        &mut self,
        key: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.sync_list_selection(key, window, cx);
        self.open_detail(key, None, window, cx);
    }

    /// 搜索命中可能落在尚未加载的页。后台逐页补齐到命中项，再用分组后的
    /// IndexPath 选中；generation 防止筛选/排序变化后旧任务污染新列表。
    fn seek_list_key(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) {
        let request = {
            let list = self.list_state.read(cx);
            let Some(page) = list.delegate().pagination.as_ref() else {
                return;
            };
            if page.next_offset >= page.total {
                return;
            }
            (
                page.generation,
                page.filter.clone(),
                page.next_offset,
                page.total,
            )
        };
        let (generation, mut filter, mut offset, mut total) = request;
        let root_key = if filter.roots_only {
            self.visible_parent_key(key)
                .unwrap_or_else(|| key.to_string())
        } else {
            key.to_string()
        };
        if !self
            .store
            .get_session(&root_key)
            .ok()
            .flatten()
            .is_some_and(|session| session_matches_filter(&session, &filter))
        {
            return;
        }
        let store = self.store.clone();
        let key = key.to_string();
        let wanted_key = root_key.clone();
        let query = cx.background_spawn(async move {
            let mut loaded = Vec::new();
            let mut found = false;
            while offset < total {
                filter.limit = SESSION_PAGE_SIZE;
                filter.offset = offset;
                let (page, current_total) = store.list_sessions(&filter).ok()?;
                total = current_total.max(0);
                let received = i64::try_from(page.len()).unwrap_or(i64::MAX);
                if received == 0 {
                    offset = total;
                    break;
                }
                found |= page.iter().any(|session| session.key == wanted_key);
                offset = offset.saturating_add(received).min(total);
                loaded.extend(page);
                if found {
                    break;
                }
            }
            Some((generation, loaded, total, offset, found))
        });

        self._list_seek_task = Some(cx.spawn_in(window, async move |this, cx| {
            let Some((generation, sessions, total, next_offset, found)) = query.await else {
                return;
            };
            this.update_in(cx, |this, window, cx| {
                let applied = this.list_state.update(cx, |state, cx| {
                    let delegate = state.delegate_mut();
                    let Some(page) = delegate.pagination.as_mut() else {
                        return false;
                    };
                    if page.generation != generation {
                        return false;
                    }
                    page.total = total;
                    page.next_offset = page.next_offset.max(next_offset).min(total);
                    page.failed = false;
                    delegate.append_sessions(sessions);
                    cx.notify();
                    true
                });
                if applied && found {
                    this.select_list_key(&key, true, window, cx);
                }
            })
            .ok();
        }));
    }

    /// 按稳定 session key 恢复列表选择；排序、置顶和分组都可能改变 IndexPath。
    fn select_list_key(
        &mut self,
        key: &str,
        scroll: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let parent_key = self
            .list_state
            .read(cx)
            .delegate()
            .tree_mode()
            .then(|| self.visible_parent_key(key))
            .flatten();
        self.list_state.update(cx, |state, cx| {
            if state.delegate().row_index(key).is_none() {
                if let Some(parent) = parent_key.as_deref() {
                    if state.delegate().row_index(parent).is_some() {
                        state.delegate_mut().ensure_expanded(parent);
                    }
                }
            }
            let path = state
                .delegate()
                .row_index(key)
                .and_then(|flat| state.delegate().index_path(flat));
            state.set_selected_index(path, window, cx);
            if scroll {
                if let Some(path) = path {
                    // 组件无 strict-Top:非 Center 策略都是"最小滚动恰好可见",
                    // 目标从下方进入会贴底。先把 offset 拉到超底,deferred 消费时
                    // 目标位于视口上方,最小滚动分支即把它对齐到视口顶。
                    // 耦合 gpui-component 0.5.1 行为;上游 DeferredScrollToItem 的
                    // scroll_strict 字段目前写死 false 未被读——它被接通之日,
                    // 换成 strict-Top 调用并删掉这行 set_offset
                    state.scroll_handle().set_offset(point(px(0.), px(-1e9)));
                    state.scroll_to_item(path, ScrollStrategy::Top, window, cx);
                }
            }
            path.is_some()
        })
    }

    fn visible_parent_key(&self, key: &str) -> Option<String> {
        let parent_key = self.store.parent_key_of(key).ok().flatten()?;
        self.store
            .get_session(&parent_key)
            .ok()
            .flatten()
            .filter(|parent| !parent.archived)
            .map(|_| parent_key)
    }

    /// 展开/收起后按 session key 恢复选择，避免插入的子行让 IndexPath 漂到
    /// 下一条会话。若被收起的正是已选子会话，则选择回父会话。
    fn toggle_list_key(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
        self.list_state.update(cx, |state, cx| {
            if !state.delegate().row_has_children(key) {
                return false;
            }
            let selected_key = state
                .selected_index()
                .and_then(|path| state.delegate().row_key(path))
                .map(str::to_string);
            if !state.delegate_mut().toggle(key) {
                return false;
            }
            let selected_path = selected_key
                .as_deref()
                .and_then(|selected| state.delegate().row_index(selected))
                .and_then(|flat| state.delegate().index_path(flat))
                .or_else(|| {
                    state
                        .delegate()
                        .row_index(key)
                        .and_then(|flat| state.delegate().index_path(flat))
                });
            state.set_selected_index(selected_path, window, cx);
            cx.notify();
            true
        })
    }

    // ---------- 操作 ----------

    /// 后台任务完成 → 推通知的通用桥(do_resume 在用)
    fn notify_when_done<T: Send + 'static>(
        window: &mut Window,
        cx: &mut Context<Self>,
        task: gpui::Task<T>,
        to_note: impl FnOnce(T) -> Notification + Send + 'static,
    ) {
        cx.spawn_in(window, async move |_this, cx| {
            let result = task.await;
            cx.update(|window, cx| {
                window.push_notification(to_note(result), cx);
            })
            .ok();
        })
        .detach();
    }

    // ---------- Open In 目标记忆 ----------

    /// Open In 目标解析:本 agent 的记忆 → 最近全局选择(仍可用时)→
    /// 列表首项
    fn open_in_target(
        &self,
        agent: AgentId,
        terms: &[terminal::TerminalApp],
    ) -> Option<terminal::TerminalApp> {
        self.preferred_terminal
            .get(&agent)
            .copied()
            .filter(|t| terms.contains(t))
            .or_else(|| self.last_terminal.filter(|t| terms.contains(t)))
            .or_else(|| terms.first().copied())
    }

    /// Open In 记忆持久化(prefs 表,key `open_in`):
    /// `{"agents":{"claude-code":"claude-desktop",…},"last":"ghostty"}`。
    /// 读取时按 id 对回本机已装终端——卸载/换平台后的残值静默丢弃
    fn load_open_in_prefs(&mut self) {
        let Some(raw) = self.store.pref_get("open_in") else {
            return;
        };
        let Ok(prefs) = serde_json::from_str::<OpenInPrefs>(&raw) else {
            return;
        };
        let by_id = |s: &str| {
            terminal::installed_terminals()
                .iter()
                .find(|t| t.id() == s)
                .copied()
        };
        for (k, val) in &prefs.agents {
            if let (Some(agent), Some(term)) = (AgentId::from_str(k), by_id(val)) {
                self.preferred_terminal.insert(agent, term);
            }
        }
        self.last_terminal = prefs.last.as_deref().and_then(by_id);
    }

    fn save_open_in_prefs(&self) {
        let prefs = OpenInPrefs {
            agents: self
                .preferred_terminal
                .iter()
                .map(|(a, t)| (a.as_str().to_string(), t.id().to_string()))
                .collect(),
            last: self.last_terminal.map(|t| t.id().to_string()),
        };
        if let Ok(raw) = serde_json::to_string(&prefs) {
            let _ = self.store.pref_set("open_in", &raw);
        }
    }

    /// per-agent 记忆任何 App 点击都写(只影响本 agent,收敛到用户实际用的);
    /// 全局 last_terminal 只在 explicit(下拉显式选择)时写——左段点的可能
    /// 是回退值,写进全局会让一个 dsh 会话把 Kooky 偏好冲成 Terminal。
    /// 非 App 目标(Copy SSH command)不进记忆:远程/本地列表不相交,记了
    /// 也没有可回放的场景。
    fn do_resume(
        &mut self,
        target: terminal::ResumeTarget,
        explicit: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(detail) = &self.detail else { return };
        if let terminal::ResumeTarget::App(term) = target {
            self.preferred_terminal.insert(detail.meta.agent, term);
            if explicit {
                self.last_terminal = Some(term);
            }
            self.save_open_in_prefs();
            cx.notify(); // split 按钮左段立即切到本次选择
        }
        let meta = detail.meta.clone();
        let task = cx.background_spawn(async move { terminal::resume_target(&meta, target) });
        Self::notify_when_done(window, cx, task, move |outcome| {
            if outcome.ok {
                Notification::success(match target {
                    terminal::ResumeTarget::App(_) => {
                        crate::tf!("Opened in terminal: {}", outcome.command)
                    }
                    terminal::ResumeTarget::CopySshCommand => {
                        crate::tf!("SSH command copied: {}", outcome.command)
                    }
                })
            } else {
                Notification::error(outcome.error.unwrap_or_else(|| t("Resume failed").into()))
            }
        });
    }

    fn toggle_favorite(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(detail) = &mut self.detail {
            let key = detail.meta.key.clone();
            let v = !detail.meta.favorite;
            let _ = self.store.set_user_data(&detail.meta.key, Some(v), None);
            detail.meta.favorite = v;
            self.refresh(cx);
            self.select_list_key(&key, false, window, cx);
            self.refresh_cleanup_flags(&key, window, cx);
        }
    }

    fn toggle_pinned(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(detail) = &mut self.detail {
            let key = detail.meta.key.clone();
            let v = !detail.meta.pinned;
            let _ = self.store.set_user_data(&detail.meta.key, None, Some(v));
            detail.meta.pinned = v;
            self.refresh(cx);
            self.select_list_key(&key, true, window, cx);
            self.refresh_cleanup_flags(&key, window, cx);
        }
    }

    /// 导出:系统"另存为"选路径(issue #25,此前直接写进 Downloads),后台解析写文件;
    /// 取消无事发生
    fn do_export(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(detail) = &self.detail else { return };
        let meta = detail.meta.clone();
        let adapters = self.adapters.clone();
        let name = exporter::default_file_name(&meta, "md");
        save_as(
            window,
            cx,
            self.store.clone(),
            name,
            t("Exported"),
            t("Export failed"),
            move |path| {
                let adapter = adapter_for(&adapters, meta.agent, &meta.file_path)
                    .ok_or_else(|| anyhow::anyhow!("no adapter for this session"))?;
                std::fs::write(path, exporter::render_markdown(adapter, &meta)?)?;
                Ok(())
            },
        )
        .detach();
    }

    fn do_conversation_export(
        &mut self,
        include_thinking: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(detail) = &self.detail else { return };
        let meta = detail.meta.clone();
        let adapters = self.adapters.clone();
        let suffix = if include_thinking {
            "conversation-thinking"
        } else {
            "conversation"
        };
        let mut name = exporter::default_file_name(&meta, "md");
        name = name.trim_end_matches(".md").to_string();
        name.push('-');
        name.push_str(suffix);
        name.push_str(".md");
        save_as(
            window,
            cx,
            self.store.clone(),
            name,
            t("Exported"),
            t("Export failed"),
            move |path| {
                let adapter = adapter_for(&adapters, meta.agent, &meta.file_path)
                    .ok_or_else(|| anyhow::anyhow!("no adapter for this session"))?;
                std::fs::write(
                    path,
                    exporter::render_conversation_markdown(adapter, &meta, include_thinking)?,
                )?;
                Ok(())
            },
        )
        .detach();
    }

    fn do_changed_files_export(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(detail) = &self.detail else { return };
        let meta = detail.meta.clone();
        let adapters = self.adapters.clone();
        let mut name = exporter::default_file_name(&meta, "md");
        name = name.trim_end_matches(".md").to_string();
        name.push_str("-changes.md");
        save_as(
            window,
            cx,
            self.store.clone(),
            name,
            t("Exported"),
            t("Export failed"),
            move |path| {
                let adapter = adapter_for(&adapters, meta.agent, &meta.file_path)
                    .ok_or_else(|| anyhow::anyhow!("no adapter for this session"))?;
                std::fs::write(
                    path,
                    exporter::render_changed_files_markdown(adapter, &meta)?,
                )?;
                Ok(())
            },
        )
        .detach();
    }

    pub(crate) fn export_contextos_skill_package(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(skill_dir) = contextos_skill_dir() else {
            window.push_notification(
                Notification::error("找不到 skills/contextos，无法导出 Skill 包"),
                cx,
            );
            return;
        };
        save_as(
            window,
            cx,
            self.store.clone(),
            "contextos-skill.zip".to_string(),
            "已导出 ContextOS Skill",
            "导出 ContextOS Skill 失败",
            move |path| {
                if path.exists() {
                    std::fs::remove_file(path)?;
                }
                let temp_root = std::env::temp_dir()
                    .join(format!("contextos-skill-export-{}", std::process::id()));
                let _ = std::fs::remove_dir_all(&temp_root);
                let staged_skill = temp_root.join("contextos");
                std::fs::create_dir_all(&staged_skill)?;
                copy_dir_contents(&skill_dir, &staged_skill)?;
                inject_skill_binary_paths(&staged_skill.join("SKILL.md"))?;
                let script = format!(
                    "$ErrorActionPreference = 'Stop'\n\
                     Compress-Archive -Path '{}' -DestinationPath '{}' -Force\n",
                    staged_skill.to_string_lossy().replace('\'', "''"),
                    path.to_string_lossy().replace('\'', "''"),
                );
                let output = std::process::Command::new("powershell.exe")
                    .arg("-NoProfile")
                    .arg("-ExecutionPolicy")
                    .arg("Bypass")
                    .arg("-Command")
                    .arg(script)
                    .output()?;
                if !output.status.success() {
                    anyhow::bail!(
                        "{}{}{}",
                        String::from_utf8_lossy(&output.stdout),
                        if output.stderr.is_empty() { "" } else { "\n" },
                        String::from_utf8_lossy(&output.stderr)
                    );
                }
                let _ = std::fs::remove_dir_all(&temp_root);
                Ok(())
            },
        )
        .detach();
    }

    fn do_compressed_export(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.do_compressed_export_with_mode(CompressionExportMode::Plain, window, cx);
    }

    fn do_memory_compressed_export(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.do_compressed_export_with_mode(CompressionExportMode::WithMemory, window, cx);
    }

    fn add_candidate_to_memory(
        &mut self,
        candidate: ContextosMemoryCandidate,
        meta: SessionMeta,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match write_contextos_memory_candidate(&candidate, &meta) {
            Ok(path) => {
                window.push_notification(
                    Notification::success(crate::tf!("已加入记忆：{}", path.display())),
                    cx,
                );
                self.refresh_memories(window, cx);
            }
            Err(error) => window.push_notification(
                Notification::error(crate::tf!("加入记忆失败：{}", format!("{error:#}"))),
                cx,
            ),
        }
    }

    fn open_memory_candidates_dialog(
        &mut self,
        candidates: Vec<ContextosMemoryCandidate>,
        meta: SessionMeta,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let workbench = cx.entity();
        let candidates_count = candidates.len();
        cx.defer(move |cx| {
            Self::show_memory_candidates_window(workbench, candidates, meta, cx);
        });
        window.push_notification(
            Notification::info(crate::tf!("已打开 {} 条记忆候选窗口", candidates_count)),
            cx,
        );
    }

    fn show_memory_candidates_window(
        workbench: Entity<Self>,
        candidates: Vec<ContextosMemoryCandidate>,
        meta: SessionMeta,
        cx: &mut App,
    ) {
        let (bounds, display_id) =
            crate::main_window::centered_over_main(size(px(820.), px(640.)), cx);
        let titlebar = if cfg!(target_os = "macos") {
            TitlebarOptions {
                title: None,
                appears_transparent: true,
                traffic_light_position: Some(point(px(20.), px(11.))),
            }
        } else {
            TitlebarOptions {
                title: Some(t("ContextOS Memory Candidates").into()),
                appears_transparent: false,
                traffic_light_position: None,
            }
        };
        match cx.open_window(
            WindowOptions {
                titlebar: Some(titlebar),
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                window_min_size: Some(size(px(720.), px(520.))),
                display_id,
                app_id: Some("contextos-memory-candidates".into()),
                window_decorations: Some(WindowDecorations::Client),
                ..Default::default()
            },
            move |window, cx| {
                window
                    .observe_window_appearance(|window, cx| {
                        crate::theme::sync_appearance(Some(window), cx);
                    })
                    .detach();
                crate::theme::sync_appearance(Some(window), cx);
                let view = cx.new(|cx| {
                    MemoryCandidatesView::new(workbench.clone(), candidates, meta, window, cx)
                });
                window.focus(&view.read(cx).focus_handle(cx), cx);
                cx.new(|cx| Root::new(view, window, cx))
            },
        ) {
            Ok(_) => cx.activate(true),
            Err(error) => eprintln!("failed to open ContextOS memory candidates: {error}"),
        }
    }

    fn do_compressed_export_with_mode(
        &mut self,
        mode: CompressionExportMode,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(detail) = &self.detail else { return };
        let settings = self.compression_settings();
        if mode == CompressionExportMode::WithMemory && !settings.llm_enabled {
            window.push_notification(
                Notification::error("压缩并生成记忆需要启用 LLM；普通压缩导出仍可只用基础机械压缩"),
                cx,
            );
            return;
        }
        let meta = detail.meta.clone();
        let adapters = self.adapters.clone();
        let name = {
            let mut name = exporter::default_file_name(&meta, "md");
            name = name.trim_end_matches(".md").to_string();
            format!("{name}-{}.md", mode.file_suffix())
        };
        let store = self.store.clone();
        let start = export_dir(&store);
        let rx = cx.prompt_for_new_path(&start, Some(&name));
        let entity = cx.entity();
        window
            .spawn(cx, async move |cx| {
                let path = match rx.await {
                    Ok(Ok(Some(path))) => path,
                    Ok(Err(_)) => start.join(&name),
                    _ => return,
                };
                cx.update(|window, cx| {
                    window.push_notification(Notification::info(mode.start_message()), cx);
                })
                .ok();
                cx.update(|window, cx| {
                    window.push_notification(Notification::info(if settings.llm_enabled {
                        mode.llm_message()
                    } else {
                        "正在执行基础机械压缩…"
                    }), cx);
                })
                .ok();
                let dialog_meta = meta.clone();
                let compression_store = store.clone();
                let result = cx
                    .background_spawn({
                        let path = path.clone();
                        async move {
                            let session_keys = vec![meta.key.clone()];
                            let covered_until = wake_core::services::compression::list_turns(
                                &compression_store,
                                &adapters,
                                &meta.key,
                            )?
                            .last()
                            .map(|turn| turn.number)
                            .unwrap_or_default();
                            let mut coverage = serde_json::Map::new();
                            coverage.insert(meta.key.clone(), serde_json::json!(covered_until));
                            let compressed = wake_core::services::compression::run(
                                &compression_store,
                                &adapters,
                                &session_keys,
                                &wake_core::services::compression::RunOverrides {
                                    jev_enabled: None,
                                    llm_enabled: None,
                                    generate_memory_candidates: mode
                                        == CompressionExportMode::WithMemory,
                                    continuation_context: None,
                                },
                            )?;
                            let output = format!(
                                "{}{}\n\n<!--\ncontextos_document: true\ncontextos_sources: {}\ncontextos_coverage: {}\ncontextos_mode: {}\n-->\n",
                                compressed.processing_report_markdown(),
                                compressed.markdown,
                                meta.key,
                                serde_json::Value::Object(coverage),
                                compressed.mode,
                            );
                            std::fs::write(&path, output)?;
                            let candidates = compressed
                                .memory_candidates
                                .into_iter()
                                .collect::<Vec<ContextosMemoryCandidate>>();
                            Ok::<_, anyhow::Error>((compressed.mode, candidates))
                        }
                    })
                    .await;
                cx.update(|window, cx| {
                    let note = match result {
                        Ok((compression_mode, candidates)) => {
                            if let Some(dir) = path.parent() {
                                let _ = store.pref_set("export_dir", &dir.to_string_lossy());
                            }
                            if mode == CompressionExportMode::WithMemory {
                                let candidate_count = candidates.len();
                                entity.update(cx, |this, cx| {
                                    this.open_memory_candidates_dialog(
                                        candidates,
                                        dialog_meta.clone(),
                                        window,
                                        cx,
                                    );
                                });
                                Notification::success(crate::tf!(
                                    "{}（{}，记忆候选 {} 条） to {}",
                                    mode.success_title(),
                                    compression_mode,
                                    candidate_count,
                                    path.display()
                                ))
                            } else {
                                Notification::success(crate::tf!(
                                    "{}（{}） to {}",
                                    mode.success_title(),
                                    compression_mode,
                                    path.display()
                                ))
                            }
                        }
                        Err(error) => {
                            Notification::error(crate::tf!("压缩导出失败：{}", format!("{error:#}")))
                        }
                    };
                    window.push_notification(note, cx);
                })
                .ok();
            })
            .detach();
    }

    fn do_export_relationships(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(detail) = &self.detail else { return };
        let adapters = self.adapters.clone();
        let current = detail.meta.clone();
        let mut sessions = Vec::new();
        let mut seen = HashSet::new();
        for rel in detail.link_parent_tree.iter().rev() {
            if seen.insert(rel.session.key.clone()) {
                sessions.push((Some(rel.relation.clone()), rel.session.clone()));
            }
        }
        if seen.insert(current.key.clone()) {
            sessions.push((
                detail.link_parents.first().map(|rel| rel.relation.clone()),
                current.clone(),
            ));
        }
        for rel in &detail.link_child_tree {
            if seen.insert(rel.session.key.clone()) {
                sessions.push((Some(rel.relation.clone()), rel.session.clone()));
            }
        }
        let name = {
            let mut name = exporter::default_file_name(&current, "md");
            name = name.trim_end_matches(".md").to_string();
            format!("{name}-relationships.md")
        };
        save_as(
            window,
            cx,
            self.store.clone(),
            name,
            "已导出关系文档",
            "导出关系文档失败",
            move |path| {
                let mut out = String::new();
                out.push_str(&format!("# 关系树：{}\n\n", current.title));
                out.push_str(&format!(
                    "- 起点/当前：{}\n- 会话数：{}\n\n",
                    current.key,
                    sessions.len()
                ));
                for (ix, (relation, meta)) in sessions.iter().enumerate() {
                    out.push_str("\n---\n\n");
                    out.push_str(&format!("## {}. {}\n\n", ix + 1, meta.title));
                    if let Some(relation) = relation {
                        out.push_str(&format!("关系：{}\n\n", session_relation_label(relation)));
                    } else {
                        out.push_str("关系：起点\n\n");
                    }
                    out.push_str(&format!(
                        "Agent：{}  \nProject：{}  \nKey：{}\n\n",
                        meta.agent.display_name(),
                        if meta.project_name.is_empty() {
                            meta.project_path.as_str()
                        } else {
                            meta.project_name.as_str()
                        },
                        meta.key
                    ));
                    let adapter = adapter_for(&adapters, meta.agent, &meta.file_path)
                        .ok_or_else(|| anyhow::anyhow!("no adapter for {}", meta.key))?;
                    out.push_str(&exporter::render_markdown(adapter, meta)?);
                    out.push('\n');
                }
                std::fs::write(path, out)?;
                Ok(())
            },
        )
        .detach();
    }

    /// 执行删除:文件进废纸篓 + 自库 tombstone。trash_paths 可能长阻塞
    /// (契约见 terminal/mod.rs,平台缘由见各实现 doc)——必须离开 UI 线程,
    /// 否则界面在授权框弹出的整段时间里完全冻结。
    fn do_delete(
        &mut self,
        keys: Vec<String>,
        targets: Vec<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let store = self.store.clone();
        let trash_keys = keys.clone();
        let count = keys.len();
        let task = cx.background_spawn(async move {
            terminal::trash_paths(&targets)?;
            store.remove_sessions(&trash_keys, true)
        });
        cx.spawn_in(window, async move |this, cx| {
            let result = task.await;
            this.update_in(cx, |this, window, cx| match result {
                Ok(()) => {
                    // 等待期间用户可能已翻到别的会话，只在仍停在被删子树时清空。
                    if this
                        .detail
                        .as_ref()
                        .is_some_and(|detail| keys.iter().any(|key| key == &detail.meta.key))
                    {
                        this.detail = None;
                    }
                    let message = crate::i18n::tp(
                        crate::ui::session_trashed_key(),
                        crate::ui::sessions_trashed_key(),
                        count as i64,
                        &[&count],
                    );
                    window.push_notification(Notification::success(message), cx);
                    // 立刻把它从列表摘掉,不等 watcher 那 800ms 去抖
                    this.refresh(cx);
                }
                Err(e) => window
                    .push_notification(Notification::error(crate::tf!("Delete failed: {}", e)), cx),
            })
            .ok();
        })
        .detach();
    }

    fn confirm_delete(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(detail) = &self.detail else { return };
        // 远程会话只读(菜单项已隐藏,这里兜住快捷键等其余入口):本地只有
        // 缓存副本,trash 它下次同步就复活;动远端文件是阶段 3 的产品决定
        if !detail.meta.host.is_empty() {
            window.push_notification(
                Notification::info(t(
                    "Remote sessions are read-only — files stay on the remote host",
                )),
                cx,
            );
            return;
        }
        let meta = detail.meta.clone();
        let mut sessions = vec![meta.clone()];
        sessions.extend(self.store.all_descendants(&meta.key).unwrap_or_default());
        let nested_count = sessions.len().saturating_sub(1);
        let keys: Vec<String> = sessions.iter().map(|session| session.key.clone()).collect();
        // 每个子会话按自己的胜出 file_path 找 adapter；多 location 下不能沿用
        // 根会话所属实例。磁盘目标保持稳定顺序并去重。
        let mut seen_targets = HashSet::new();
        let mut targets = Vec::new();
        for session in &sessions {
            let paths = adapter_for(&self.adapters, session.agent, &session.file_path)
                .map(|adapter| adapter.session_paths(session))
                .unwrap_or_else(|| vec![session.file_path.clone()]);
            for path in paths {
                if seen_targets.insert(path.clone()) {
                    targets.push(path);
                }
            }
        }
        let entity = cx.entity();
        window.open_alert_dialog(cx, move |dialog, _window, cx| {
            let meta = meta.clone();
            let keys = keys.clone();
            let targets = targets.clone();
            let entity = entity.clone();
            let theme = cx.theme();
            dialog
                .title(
                    div()
                        .text_size(FONT_HEADING)
                        .font_semibold()
                        .child(if nested_count > 0 {
                            t("Delete this session tree?")
                        } else {
                            t("Delete this session?")
                        }),
                )
                .width(px(440.))
                // 破坏性确认:主按钮点名动作并用 danger 形态,不留裸 "OK"。
                // .confirm() 必须显式调用——Dialog 只在设了 footer 时才渲染
                // 按钮行,只挂 on_ok 的弹窗实际无按钮(仅回车可确认)
                .confirm()
                .button_props(
                    gpui_component::dialog::DialogButtonProps::default()
                        .ok_text(move_to_trash())
                        .ok_variant(gpui_component::button::ButtonVariant::Danger),
                )
                .child(
                    v_flex()
                        .gap(SPACE_SM)
                        .text_size(FONT_BODY)
                        .child(if nested_count > 0 {
                            crate::tp!(
                                "This session and {} nested session will be moved to {}. You can restore them anytime:",
                                "This session and {} nested sessions will be moved to {}. You can restore them anytime:",
                                nested_count,
                                crate::ui::trash_body()
                            )
                        } else {
                            trash_confirm_body().to_string()
                        })
                        .child(
                            div()
                                .px(SPACE_SM)
                                .py(SPACE_XS)
                                .rounded(theme.radius)
                                .bg(theme.muted)
                                .text_size(FONT_CAPTION)
                                // 等宽走主题 token(Menlo 只有 macOS 有;
                                // Windows 上找不到会静默回落到比例字体的
                                // 系统 UI 字体,与其他路径 chip 不一致)
                                .font_family(theme.mono_font_family.clone())
                                .child(meta.file_path.clone()),
                        )
                        .when(meta.agent == AgentId::Codex, |this| {
                            this.child(
                                div()
                                    .text_size(FONT_CAPTION)
                                    .text_color(theme.muted_foreground)
                                    .child(t("Only the local file is removed — Codex's own records stay intact.")),
                            )
                        }),
                )
                .on_ok(move |_, window, cx| {
                    entity.update(cx, |this, cx| {
                        this.do_delete(keys.clone(), targets.clone(), window, cx);
                    });
                    true
                })
        });
    }

    fn context_title(&self) -> String {
        if self.favorite_only {
            return t("Starred").to_string();
        }
        if let Some(tag) = &self.selected_tag {
            return crate::tf!("标签：{}", session_tag_label(tag));
        }
        if let Some(p) = &self.selected_project {
            // 项目显示名以侧栏列表(store 的 ProjectInfo)为准,不再重推
            return self
                .projects
                .iter()
                .find(|info| info.path == *p)
                .map(|info| info.name.clone())
                .unwrap_or_else(|| t("Projects").to_string());
        }
        match self.selected_agent {
            None => t("All Sessions").to_string(),
            Some(one) => one.display_name().to_string(),
        }
    }

    // ---------- 渲染 ----------

    fn render_sidebar(&self, window: &Window, cx: &Context<Self>) -> AnyElement {
        let theme = cx.theme();
        if self.sidebar_collapsed {
            let entity = cx.entity();
            return v_flex()
                .w(SIDEBAR_COLLAPSED_WIDTH)
                .h_full()
                .flex_shrink_0()
                .items_center()
                .pt(WINDOW_TITLEBAR_HEIGHT)
                .bg(theme.sidebar)
                .child(
                    Button::new("expand-sidebar")
                        .ghost()
                        .small()
                        .icon(icon("icons/chevron-right.svg").with_size(px(15.)))
                        .tooltip("展开导航栏")
                        .on_click(move |_, _, cx| {
                            entity.update(cx, |this, cx| this.toggle_sidebar(cx));
                        }),
                )
                .into_any_element();
        }
        let all_active = self.selected_agent.is_none()
            && self.selected_project.is_none()
            && self.selected_tag.is_none()
            && !self.favorite_only
            && self.page == Page::Sessions
            && !self.cleanup.open;
        // 常态沉默,仅刷新中/监听失效时出现;None 时状态栏整行不渲染。
        // 文案在此按 scan 现算,不另存字段——存下来就会有第二个写入点要维护
        // 进行中的活动(会话扫描 / 记忆同步 / 远程同步):行首转圈——与页头 Refresh 按钮
        // loading 态同一个 Spinner;出错的那句行首是静态图标
        let busy = self.scan.scanning || self.memory.syncing || !self.syncing_hosts.is_empty();
        let note = if self.scan.scanning {
            Some(match self.scan.total {
                0 => t("Refreshing…").to_string(),
                total => crate::tf!("Refreshing {}/{}", self.scan.done, total),
            })
        } else if self.memory.syncing {
            Some(t("Refreshing memory…").to_string())
        } else if let [only] = self.syncing_hosts.as_slice() {
            // rsync 与扫描并行;扫描先收工时这里接着展示同步状态
            Some(crate::tf!("Syncing {}…", only))
        } else if !self.syncing_hosts.is_empty() {
            Some(crate::tf!(
                "Syncing {} remote hosts…",
                self.syncing_hosts.len()
            ))
        } else {
            self.scan
                .error
                .as_ref()
                .map(|e| crate::tf!("Refresh failed: {}", e))
        };
        // 文字下方一条进度条(用户 2026-09-22 要的):会话扫描按 done/total 定值;总数
        // 未知、记忆同步与远程同步报不出进度,走不定值滑动
        let progress = busy.then(|| {
            let bar = Progress::new("refresh-progress")
                .with_size(px(3.))
                .color(theme.primary);
            let bar = if self.scan.scanning && self.scan.total > 0 {
                bar.value(self.scan.done as f32 / self.scan.total as f32 * 100.)
            } else {
                bar.loading(true)
            };
            bar.into_any_element()
        });
        let status: Option<AnyElement> = if let Some(note) = note {
            let lead = if busy {
                div()
                    .flex_shrink_0()
                    .child(
                        Spinner::new()
                            .with_size(px(12.))
                            .color(theme.muted_foreground),
                    )
                    .into_any_element()
            } else {
                icon("icons/refresh-cw.svg")
                    .with_size(px(12.))
                    .flex_shrink_0()
                    .into_any_element()
            };
            Some(
                h_flex()
                    .w_full()
                    .gap(ICON_TEXT_GAP)
                    .text_color(theme.muted_foreground)
                    .child(lead)
                    .child(div().min_w_0().truncate().child(note))
                    .into_any_element(),
            )
        } else if !self.runtime.watcher_available() {
            Some(
                h_flex()
                    .w_full()
                    .gap(ICON_TEXT_GAP)
                    .text_color(theme.muted_foreground)
                    .child(
                        div()
                            .size(px(7.))
                            .rounded_full()
                            .flex_shrink_0()
                            .bg(theme.warning),
                    )
                    .child(div().min_w_0().truncate().child(t("Live updates off")))
                    .into_any_element(),
            )
        } else {
            None
        };

        // macOS 恒挂 TitleBar(traffic light 占位 + 拖拽区);Linux/Windows 按
        // 运行时装饰状态:系统给了标题栏(Server)就不挂——TitleBar 的非 mac
        // 实现无条件画 min/max/close 三按钮,会与系统标题栏成双套控制;系统
        // 不给(GNOME Wayland 无 SSD 回落 Client)才挂,此时它是唯一的拖拽区
        // 与窗口按钮(按钮图标 window-*.svg 在 assets 注册表,缺了就是隐形
        // 热区)。Windows 走 appears_transparent=false 的原生 caption,装饰
        // 恒报 Server,这里天然不挂。
        let show_titlebar = cfg!(target_os = "macos")
            || matches!(window.window_decorations(), Decorations::Client { .. });
        v_flex()
            .w(SIDEBAR_WIDTH)
            .h_full()
            .flex_shrink_0()
            .bg(theme.sidebar)
            // 压平 titlebar 靠 theme.rs 的 title_bar/title_bar_border token；主窗口
            // 使用 44px 高度，与详情顶部行共享同一垂直节奏。
            .when(show_titlebar, |this| {
                this.child(TitleBar::new().h(WINDOW_TITLEBAR_HEIGHT))
            })
            .child(
                h_flex()
                    .flex_shrink_0()
                    .h(WINDOW_TITLEBAR_HEIGHT)
                    .px(SIDEBAR_EDGE)
                    .pt(SPACE_XS)
                    .pb(SPACE_LG)
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .pl(TITLE_INSET)
                            .min_w_0()
                            .flex_1()
                            .pr(SIDEBAR_EDGE)
                            .truncate()
                            .text_size(FONT_HEADING)
                            .font_semibold()
                            .text_color(theme.foreground)
                            // Memory/Relationships/Compressions 页标题直接说明当前库,
                            // 不另加模式标题行(用户 2026-09-21)
                            .child(if self.page == Page::Skills {
                                h_flex()
                                    .items_center()
                                    .gap(SPACE_SM)
                                    .child(
                                        Button::new("skills-mode-button")
                                            .small()
                                            .label("Skills")
                                            .when(!self.is_mcp_mode(), |button| button.primary())
                                            .when(self.is_mcp_mode(), |button| button.ghost())
                                            .on_click(cx.listener(|this, _, window, cx| {
                                                this.set_skills_mode(
                                                    skills::SkillsMode::Skills,
                                                    window,
                                                    cx,
                                                )
                                            })),
                                    )
                                    .child(div().w(px(1.)).h(px(16.)).bg(theme.sidebar_border))
                                    .child(
                                        Button::new("mcp-mode-button")
                                            .small()
                                            .label("MCP")
                                            .when(self.is_mcp_mode(), |button| button.primary())
                                            .when(!self.is_mcp_mode(), |button| button.ghost())
                                            .on_click(cx.listener(|this, _, window, cx| {
                                                this.set_skills_mode(
                                                    skills::SkillsMode::Mcp,
                                                    window,
                                                    cx,
                                                )
                                            })),
                                    )
                            } else {
                                div().child(match self.page {
                                    Page::Memory => t("Memory"),
                                    Page::Skills => t("Skills"),
                                    Page::Relationships => "关系",
                                    Page::Compressions => "压缩文件",
                                    _ => "ContextOS",
                                })
                            }),
                    )
                    .child(
                        Button::new("collapse-sidebar")
                            .ghost()
                            .small()
                            .icon(icon("icons/chevron-left.svg").with_size(px(14.)))
                            .tooltip("收起导航栏")
                            .on_click(cx.listener(|this, _, _, cx| this.toggle_sidebar(cx))),
                    ),
            )
            // 导航按页切换:Insights 使用 Agent 统计范围;Memory / Skills / 关系各用
            // 自己的导航,会话页保留搜索与会话筛选
            .child(match self.page {
                Page::Memory => self.render_memory_nav(cx),
                Page::Skills if self.is_mcp_mode() => self.render_mcp_nav(cx),
                Page::Skills => self.render_skills_nav(cx),
                Page::Relationships => self.render_relationships_nav(cx),
                Page::Compressions => self.render_compressions_nav(cx),
                Page::Insights => self.render_insights_nav(cx),
                _ => self.render_sessions_nav(all_active, cx),
            })
            .when(self.page == Page::Sessions && !self.cleanup.open, |this| {
                this.child(self.render_relationship_tree_panel(cx))
            })
            // 底部工具条:次要操作(数据源、刷新)与扫描状态同处一区,与上方
            // 导航行只用一条 border 分隔。按钮透明底、hover 才出色,不跟导航
            // 行的选中态抢注意力;图标-only 元素改 text_color 不丢字号
            .child(
                v_flex()
                    .flex_shrink_0()
                    .border_t_1()
                    .border_color(theme.sidebar_border)
                    .when_some(status, |this, status| {
                        this.child(
                            v_flex()
                                .px(SPACE_XL)
                                .pt(SPACE_MD)
                                .gap(SPACE_SM)
                                .text_size(FONT_LABEL)
                                .child(status)
                                .children(progress),
                        )
                    })
                    // 两端分置的图标条(Zed 状态栏 / Xcode 导航条那种,不带盒子):左端
                    // 页切换 Sessions / Memory / Insights,当前页那颗用侧栏选中色做底;
                    // 右端只有 Settings。Refresh 不在这里——它住在各页页头右端(会话页整库
                    // 重扫、Memory 页只同步记忆;用户 2026-09-21 三轮反馈:六个一样的图标挤
                    // 一排不行、刷新不该放这里、带边框的分段盒子也不行)
                    .child(
                        h_flex()
                            .h(SIDEBAR_FOOTER_ROW_HEIGHT)
                            .pl(FOOTER_LEAD_INSET)
                            .pr(SIDEBAR_EDGE)
                            .items_center()
                            .justify_between()
                            .child(self.render_page_switch(cx))
                            .child(h_flex().gap(px(2.)).child(sidebar_tool_btn(
                                "settings",
                                t("Settings"),
                                false,
                                SidebarGlyph::Icon("icons/settings.svg"),
                                cx.listener(|this, _, _window, cx| this.open_settings(cx)),
                                cx,
                            ))),
                    ),
            )
            .into_any_element()
    }

    /// 统计导航只选择统计范围,不改变会话页的筛选或目的地。
    fn render_insights_nav(&self, cx: &Context<Self>) -> AnyElement {
        if self.insights_subview == InsightsSubview::WorkspaceChanges {
            return self.render_workspace_changes_nav(cx);
        }
        let dark = cx.theme().mode.is_dark();
        v_flex()
            .id("insights-sidebar-nav")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .px(SIDEBAR_EDGE)
            .pt(SPACE_XS)
            .pb(SPACE_LG)
            .gap(SPACE_XS)
            .child(sidebar_row(
                "insights-all-agents",
                RowLead::Icon(icon("icons/chart-column.svg")),
                t("All agents"),
                None,
                self.insights_agent.is_none(),
                RowLevel::Primary,
                cx.listener(|this, _, _window, cx| this.set_insights_agent(None, cx)),
                cx,
            ))
            .child(group_header(
                "insights-agents-header",
                t("Agents"),
                self.agents_collapsed,
                cx.listener(|this, _, _window, cx| {
                    this.agents_collapsed = !this.agents_collapsed;
                    cx.notify();
                }),
                cx,
            ))
            .when(!self.agents_collapsed, |this| {
                this.children(self.agent_counts.iter().map(|(agent, _count)| {
                    let selected_agent = *agent;
                    let active = self.insights_agent == Some(selected_agent);
                    sidebar_row(
                        selected_agent.as_str(),
                        RowLead::Brand(selected_agent.brand_icon(dark)),
                        selected_agent.display_name(),
                        None,
                        active,
                        RowLevel::Sub,
                        cx.listener(move |this, _, _window, cx| {
                            this.set_insights_agent((!active).then_some(selected_agent), cx)
                        }),
                        cx,
                    )
                }))
            })
            .into_any_element()
    }

    fn render_workspace_changes_nav(&self, cx: &Context<Self>) -> AnyElement {
        let theme = cx.theme();
        v_flex()
            .id("workspace-changes-sidebar-nav")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .px(SIDEBAR_EDGE)
            .pt(SPACE_XS)
            .pb(SPACE_LG)
            .gap(SPACE_XS)
            .child(
                h_flex()
                    .w_full()
                    .items_center()
                    .justify_between()
                    .px(SPACE_MD)
                    .py(SPACE_SM)
                    .child(
                        div()
                            .text_size(FONT_CAPTION)
                            .font_medium()
                            .text_color(theme.muted_foreground)
                            .child("监控目录"),
                    )
                    .child(
                        Button::new("workspace-root-add")
                            .small()
                            .ghost()
                            .label("添加")
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.add_workspace_root(window, cx)
                            })),
                    ),
            )
            .when(self.workspace_roots.is_empty(), |nav| {
                nav.child(
                    div()
                        .px(SPACE_MD)
                        .py(SPACE_SM)
                        .text_size(FONT_CAPTION)
                        .text_color(theme.muted_foreground)
                        .child("尚未添加监控目录"),
                )
            })
            .children(self.workspace_roots.iter().map(|root| {
                let path = root.path.clone();
                let active = self.workspace_change_project.as_deref() == Some(path.as_str());
                h_flex()
                    .w_full()
                    .items_center()
                    .child(sidebar_row(
                        SharedString::from(format!("workspace-project-{}", root.path)),
                        RowLead::Icon(icon("icons/folder.svg")),
                        root.name.clone(),
                        None,
                        active,
                        RowLevel::Sub,
                        cx.listener({
                            let path = path.clone();
                            move |this, _, _window, cx| {
                                this.select_workspace_change_project(path.clone(), cx)
                            }
                        }),
                        cx,
                    ))
                    .child(
                        Button::new(SharedString::from(format!(
                            "workspace-root-remove-{}",
                            root.path
                        )))
                        .small()
                        .ghost()
                        .label("移除")
                        .tooltip("停止监控此目录")
                        .on_click(cx.listener(
                            move |this, _, _window, cx| {
                                this.remove_workspace_root(path.clone(), cx)
                            },
                        )),
                    )
                    .into_any_element()
            }))
            .into_any_element()
    }

    fn render_session_changes_content(
        &self,
        window: &Window,
        cx: &Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme();
        let compact_layout = window.bounds().size.width < px(1320.);
        let since = self.session_change_range.since_ms();
        let has_active_filter = self.session_change_range != WorkspaceChangeRange::All
            || self.session_change_kind.is_some();
        let matches_event = |event: &SessionFileChangeEvent| {
            since.is_none_or(|since| event.observed_at >= since)
                && self
                    .session_change_kind
                    .is_none_or(|kind| event.kind == kind)
        };
        let has_visible_events = |group: &SessionChangeSessionGroup| {
            group
                .folders
                .iter()
                .flat_map(|folder| folder.files.iter())
                .flat_map(|file| file.events.iter())
                .chain(group.root_files.iter().flat_map(|file| file.events.iter()))
                .any(&matches_event)
        };
        let count_visible_events = |group: &SessionChangeSessionGroup| {
            group
                .folders
                .iter()
                .flat_map(|folder| folder.files.iter())
                .flat_map(|file| file.events.iter())
                .chain(group.root_files.iter().flat_map(|file| file.events.iter()))
                .filter(|event| matches_event(event))
                .count()
        };
        let mut groups = self
            .session_change_groups
            .iter()
            .filter(|group| !has_active_filter || has_visible_events(group))
            .collect::<Vec<_>>();
        if self.session_change_sort_ascending {
            groups.reverse();
        }
        let selected_session_count = groups
            .iter()
            .map(|group| group.session_key.as_str())
            .collect::<HashSet<_>>()
            .len();
        let selected_group = self
            .session_change_inspector
            .as_ref()
            .and_then(|key| {
                groups
                    .iter()
                    .find(|group| session_change_activity_key(group) == key.as_str())
            })
            .or_else(|| groups.first());
        let manage_session_key = selected_group.map(|group| group.session_key.clone());
        let format_time = |timestamp: i64| {
            chrono::DateTime::<chrono::Utc>::from_timestamp_millis(timestamp)
                .map(|time| time.with_timezone(&Local).format("%Y-%m-%d %H:%M").to_string())
                .unwrap_or_else(|| "未知时间".to_string())
        };
        let selected_group_created_time = selected_group
            .and_then(|group| group.metadata.as_ref().map(|meta| meta.created_at))
            .filter(|timestamp| *timestamp > 0)
            .map(format_time)
            .unwrap_or_else(|| "未知时间".to_string());
        const SESSION_ACTIVITY_WINDOW_MS: i64 = 10 * 60 * 1000;
        let mut activity_window_latest: Option<i64> = None;
        let session_rows = groups.iter().enumerate().map(|(index, group)| {
            let row_key = session_change_activity_key(group);
            let is_open = self.session_change_open_sessions.contains(&row_key);
            let metadata = group.metadata.as_ref();
            let title = metadata
                .map(|meta| meta.title.as_str())
                .filter(|title| !title.trim().is_empty())
                .unwrap_or("未命名会话");
            let agent = metadata
                .map(|meta| meta.agent.display_name().to_string())
                .unwrap_or_else(|| "Agent".to_string());
            let project = metadata
                .map(|meta| {
                    if meta.project_name.trim().is_empty() {
                        "全局会话".to_string()
                    } else {
                        meta.project_name.clone()
                    }
                })
                .unwrap_or_else(|| "会话信息不可用".to_string());
            let timestamp = group
                .latest_change_at
                .map(format_time)
                .unwrap_or_else(|| "未知时间".to_string());
            let session_created_time = metadata
                .map(|meta| meta.created_at)
                .filter(|timestamp| *timestamp > 0)
                .map(format_time)
                .unwrap_or_else(|| "未知时间".to_string());
            let visible_change_count = count_visible_events(group);
            let visible_file_count = group
                .folders
                .iter()
                .flat_map(|folder| folder.files.iter())
                .chain(group.root_files.iter())
                .filter(|file| file.events.iter().any(&matches_event))
                .count();
            let agent_identity = metadata
                .map(|meta| {
                    h_flex()
                        .items_center()
                        .gap(SPACE_XS)
                        .child(
                            img(meta.agent.brand_icon(theme.mode.is_dark()))
                                .size(px(14.))
                                .flex_shrink_0(),
                        )
                        .child(
                            div()
                                .text_size(FONT_CAPTION)
                                .text_color(theme.info)
                                .child(agent.clone()),
                        )
                        .into_any_element()
                })
                .unwrap_or_else(|| outline_badge(agent.clone(), theme.info).into_any_element());
            let inspector_key = row_key.clone();
            let toggle_key = row_key.clone();
            let card_title = title.to_string();
            let selected = selected_group
                .is_some_and(|selected| session_change_activity_key(selected) == row_key);
            let mut detail_rows = Vec::<AnyElement>::new();
            for folder in &group.folders {
                if !folder
                    .files
                    .iter()
                    .any(|file| file.events.iter().any(&matches_event))
                {
                    continue;
                }
                let visible_file_count = folder
                    .files
                    .iter()
                    .filter(|file| file.events.iter().any(&matches_event))
                    .count();
                let folder_key = format!("session:{}:{}", row_key, folder.path);
                let folder_open = self.workspace_change_open_folders.contains(&folder_key);
                detail_rows.push(
                    v_flex()
                        .w_full()
                        .pl(px(18.))
                        .child(
                            h_flex()
                                .h(px(36.))
                                .items_center()
                                .gap(SPACE_SM)
                                .child(
                                    Button::new(SharedString::from(format!(
                                        "session-folder-{index}-{}",
                                        folder.path
                                    )))
                                    .ghost()
                                    .icon(icon(if folder_open {
                                        "icons/chevron-down.svg"
                                    } else {
                                        "icons/chevron-right.svg"
                                    })
                                    .with_size(px(14.)))
                                    .label(format!("{}  /", folder.path))
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        if !this
                                            .workspace_change_open_folders
                                            .remove(&folder_key)
                                        {
                                            this.workspace_change_open_folders
                                                .insert(folder_key.clone());
                                        }
                                        cx.notify();
                                    })),
                                )
                                .child(
                                    div()
                                        .text_size(FONT_CAPTION)
                                        .text_color(theme.muted_foreground)
                                        .child(format!("{} 个文件", visible_file_count)),
                                ),
                        )
                        .when(folder_open, |row| {
                            row.children(folder.files.iter().filter(|file| file.events.iter().any(&matches_event)).map(|file| {
                                let file_name = file
                                    .path
                                    .rsplit('/')
                                    .next()
                                    .unwrap_or(&file.path)
                                    .to_string();
                                let file_key = format!("session:{}:{}", row_key, file.path);
                                let file_open =
                                    self.workspace_change_open_files.contains(&file_key);
                                let toggle_key = file_key.clone();
                                v_flex()
                                    .w_full()
                                    .pl(px(22.))
                                    .child(
                                        Button::new(SharedString::from(format!(
                                            "session-file-{index}-{}",
                                            file.path
                                        )))
                                        .h(px(34.))
                                        .w_full()
                                        .ghost()
                                        .justify_start()
                                        .icon(icon(if file_open {
                                            "icons/chevron-down.svg"
                                        } else {
                                            "icons/chevron-right.svg"
                                        })
                                        .with_size(px(13.)))
                                        .label(file_name)
                                        .tooltip(file.path.clone())
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            if !this
                                                .workspace_change_open_files
                                                .remove(&toggle_key)
                                            {
                                                this.workspace_change_open_files
                                                    .insert(toggle_key.clone());
                                            }
                                            cx.notify();
                                        })),
                                    )
                                    .when(file_open, |row| {
                                        row.children(file.events.iter().filter(|event| matches_event(event)).map(|event| {
                                            let (label, color) = match event.kind {
                                                WorkspaceChangeKind::Created => ("新增", theme.success),
                                                WorkspaceChangeKind::Modified => ("修改", theme.primary),
                                                WorkspaceChangeKind::Deleted => ("删除", theme.danger),
                                            };
                                            h_flex()
                                                .h(px(28.))
                                                .pl(px(26.))
                                                .items_center()
                                                .gap(SPACE_SM)
                                                .text_size(FONT_LABEL)
                                                .text_color(theme.muted_foreground)
                                                .child(div().text_color(color).child(label))
                                                .child(format_time(event.observed_at))
                                                .into_any_element()
                                        }))
                                    })
                                    .into_any_element()
                            }))
                        })
                        .into_any_element(),
                );
            }
            for file in &group.root_files {
                if !file.events.iter().any(&matches_event) {
                    continue;
                }
                let file_name = file.path.rsplit('/').next().unwrap_or(&file.path).to_string();
                let file_key = format!("session:{}:{}", row_key, file.path);
                let file_open = self.workspace_change_open_files.contains(&file_key);
                let toggle_key = file_key.clone();
                detail_rows.push(
                    v_flex()
                        .w_full()
                        .pl(px(18.))
                        .child(
                            Button::new(SharedString::from(format!(
                                "session-root-file-{index}-{}",
                                file.path
                            )))
                            .h(px(34.))
                            .w_full()
                            .ghost()
                            .justify_start()
                            .icon(icon(if file_open {
                                "icons/chevron-down.svg"
                            } else {
                                "icons/chevron-right.svg"
                            })
                            .with_size(px(13.)))
                            .label(file_name)
                            .tooltip(file.path.clone())
                            .on_click(cx.listener(move |this, _, _, cx| {
                                if !this.workspace_change_open_files.remove(&toggle_key) {
                                    this.workspace_change_open_files.insert(toggle_key.clone());
                                }
                                cx.notify();
                            })),
                        )
                        .when(file_open, |row| {
                            row.children(file.events.iter().filter(|event| matches_event(event)).map(|event| {
                                let (label, color) = match event.kind {
                                    WorkspaceChangeKind::Created => ("新增", theme.success),
                                    WorkspaceChangeKind::Modified => ("修改", theme.primary),
                                    WorkspaceChangeKind::Deleted => ("删除", theme.danger),
                                };
                                h_flex()
                                    .h(px(28.))
                                    .pl(px(44.))
                                    .items_center()
                                    .gap(SPACE_SM)
                                    .text_size(FONT_LABEL)
                                    .text_color(theme.muted_foreground)
                                    .child(div().text_color(color).child(label))
                                    .child(format_time(event.observed_at))
                                    .into_any_element()
                            }))
                        })
                        .into_any_element(),
                );
            }
            let toggle = cx.listener(move |this, _, _, cx| {
                this.session_change_inspector = Some(inspector_key.clone());
                if !this.session_change_open_sessions.remove(&toggle_key) {
                    this.session_change_open_sessions.insert(toggle_key.clone());
                }
                cx.notify();
            });
            let starts_time_window = group.latest_change_at.is_some_and(|timestamp| {
                activity_window_latest.is_none_or(|latest| {
                    let starts = latest.max(timestamp).saturating_sub(latest.min(timestamp))
                        >= SESSION_ACTIVITY_WINDOW_MS;
                    if starts {
                        activity_window_latest = Some(timestamp);
                    }
                    starts
                })
            });
            if activity_window_latest.is_none() {
                activity_window_latest = group.latest_change_at;
            }
            let activity_row = h_flex()
                .w_full()
                .items_stretch()
                .gap(SPACE_XL)
                .child(
                    h_flex()
                        .w(px(200.))
                        .flex_shrink_0()
                        .items_start()
                        .gap(SPACE_MD)
                        .child(
                            div()
                                .w(px(156.))
                                .pt(px(8.))
                                .text_right()
                                .text_size(FONT_BODY)
                                .font_medium()
                                .text_color(theme.foreground)
                                .child(timestamp.clone()),
                        )
                        .child(
                            v_flex()
                                .w(px(14.))
                                .items_center()
                                .pt(px(10.))
                                .child(div().size(px(12.)).rounded_full().bg(theme.primary))
                                .when(index + 1 < groups.len(), |rail| {
                                    rail.child(div().w(px(2.)).flex_1().min_h(px(28.)).bg(theme.border))
                                }),
                        ),
                )
                .child(
                    v_flex()
                        .flex_1()
                        .min_w_0()
                        .gap(SPACE_XS)
                        .p(SPACE_MD)
                        .border_1()
                        .border_color(if selected {
                            theme.primary.opacity(0.58)
                        } else {
                            theme.border
                        })
                        .rounded(theme.radius)
                        .bg(if selected {
                            theme.list_active
                        } else {
                            theme.popover
                        })
                        .child(
                            h_flex()
                                .w_full()
                                .items_center()
                                .gap(SPACE_SM)
                                .child(
                                    Button::new(SharedString::from(format!("session-change-{index}")))
                                        .flex_1()
                                        .min_w_0()
                                        .h(px(38.))
                                        .ghost()
                                        .justify_start()
                                        .icon(icon(if is_open {
                                            "icons/chevron-down.svg"
                                        } else {
                                            "icons/chevron-right.svg"
                                        })
                                        .with_size(px(14.)))
                                        .tooltip(card_title.clone())
                                        .child(
                                            div()
                                                .flex_1()
                                                .min_w_0()
                                                .truncate()
                                                .child(card_title),
                                        )
                                        .on_click(toggle),
                                )
                                .child(outline_badge(
                                    format!("{visible_change_count} 条改动"),
                                    theme.primary,
                                )),
                        )
                        .child(
                            h_flex()
                                .pl(px(34.))
                                .items_center()
                                .flex_wrap()
                                .gap(SPACE_SM)
                                .child(agent_identity)
                                .child(div().text_size(FONT_CAPTION).text_color(theme.muted_foreground).child(project))
                                .child(div().text_size(FONT_CAPTION).text_color(theme.muted_foreground).child(format!("{visible_file_count} 个文件 · 最近改动 {timestamp}"))),
                        )
                        .when(is_open, |row| {
                            row.children(detail_rows)
                                .child(div().pl(px(18.)).pt(SPACE_XS).text_size(FONT_CAPTION).text_color(theme.muted_foreground).child(format!("会话创建时间：{session_created_time}")))
                        }),
                )
                .into_any_element();
            v_flex()
                .w_full()
                .gap(SPACE_XS)
                .when(starts_time_window, |row| {
                    row.child(
                        h_flex()
                            .w_full()
                            .items_center()
                            .gap(SPACE_SM)
                            .pt(if index == 0 { px(0.) } else { SPACE_SM })
                            .child(div().h(px(1.)).flex_1().bg(theme.border))
                            .child(
                                div()
                                    .text_size(FONT_CAPTION)
                                    .text_color(theme.muted_foreground)
                                    .child(format!("时间段 · {}", timestamp)),
                            )
                            .child(div().h(px(1.)).flex_1().bg(theme.border)),
                    )
                })
                .child(activity_row)
                .into_any_element()
        });

        let inspector = selected_group.map(|group| {
            let key = group.session_key.clone();
            let metadata = group.metadata.as_ref();
            let title = metadata
                .map(|meta| meta.title.as_str())
                .filter(|title| !title.trim().is_empty())
                .unwrap_or("未命名会话");
            let agent = metadata
                .map(|meta| meta.agent.display_name().to_string())
                .unwrap_or_else(|| "Agent".to_string());
            let project = metadata
                .map(|meta| meta.project_name.clone())
                .filter(|name| !name.trim().is_empty())
                .unwrap_or_else(|| "全局会话".to_string());
            let file_paths = group
                .folders
                .iter()
                .flat_map(|folder| folder.files.iter())
                .chain(group.root_files.iter())
                .filter(|file| file.events.iter().any(&matches_event))
                .map(|file| file.path.clone())
                .collect::<Vec<_>>();
            let visible_change_count = count_visible_events(group);
            let open_key = key.clone();
            let remove_key = key.clone();
            v_flex()
                .w(px(360.))
                .flex_shrink_0()
                .min_h_0()
                .when(compact_layout, |panel| {
                    panel.w_full().h(px(260.))
                })
                .border_1()
                .border_color(theme.border)
                .rounded(theme.radius)
                .bg(theme.popover)
                .child(
                    h_flex()
                        .h(px(48.))
                        .flex_shrink_0()
                        .px(SPACE_MD)
                        .items_center()
                        .justify_between()
                        .border_b_1()
                        .border_color(theme.border)
                        .child(div().font_semibold().child("会话详情"))
                        .child(
                            Button::new("session-change-inspector-open")
                                .small()
                                .primary()
                                .label("打开会话")
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.open_relationship_session_in_sessions(
                                        &open_key, window, cx,
                                    )
                                })),
                        ),
                )
                .child(
                    v_flex()
                        .flex_1()
                        .min_h_0()
                        .overflow_y_scrollbar()
                        .p(SPACE_MD)
                        .gap(SPACE_MD)
                        .child(
                            v_flex()
                                .gap(SPACE_XS)
                                .child(div().font_semibold().child(title.to_string()))
                                .child(
                                    div()
                                        .text_size(FONT_CAPTION)
                                        .text_color(theme.muted_foreground)
                                        .child(format!("{agent} · {project}")),
                                ),
                        )
                        .child(
                            v_flex()
                                .gap(SPACE_XS)
                                .border_t_1()
                                .border_color(theme.border)
                                .pt(SPACE_MD)
                                .child(div().text_size(FONT_CAPTION).text_color(theme.muted_foreground).child("文件改动"))
                                .child(div().text_size(FONT_BODY).child(format!("{} 个文件 · {} 次记录", file_paths.len(), visible_change_count)))
                                .children(file_paths.into_iter().map(|path| {
                                    div()
                                        .text_size(FONT_CAPTION)
                                        .text_color(theme.muted_foreground)
                                        .child(path)
                                        .into_any_element()
                                })),
                        )
                        .child(
                            v_flex()
                                .gap(SPACE_XS)
                                .border_t_1()
                                .border_color(theme.border)
                                .pt(SPACE_MD)
                                .child(div().text_size(FONT_CAPTION).text_color(theme.muted_foreground).child("导入来源"))
                                .child(div().text_size(FONT_BODY).child("用户手动选入"))
                                .child(div().text_size(FONT_CAPTION).text_color(theme.muted_foreground).child(format!("会话创建时间：{selected_group_created_time}")))
                                .child(
                                    Button::new("session-change-remove-selection")
                                        .small()
                                        .ghost()
                                        .label("移出已导入会话")
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            this.set_session_change_membership(remove_key.clone(), false, cx)
                                        })),
                                ),
                        ),
                )
                .into_any_element()
        });

        let session_filters = h_flex()
            .w_full()
            .flex_wrap()
            .items_center()
            .gap(SPACE_SM)
            .pb(SPACE_MD)
            .border_b_1()
            .border_color(theme.border)
            .child(
                h_flex()
                    .items_center()
                    .gap(px(2.))
                    .p(px(3.))
                    .border_1()
                    .border_color(theme.border)
                    .rounded(theme.radius)
                    .children(WorkspaceChangeRange::ALL.into_iter().map(|range| {
                        let selected = self.session_change_range == range;
                        Button::new(SharedString::from(format!("session-range-{range:?}")))
                            .small()
                            .label(range.label())
                            .when(selected, |button| button.primary())
                            .when(!selected, |button| button.ghost())
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.session_change_range = range;
                                cx.notify();
                            }))
                    })),
            )
            .child(
                h_flex()
                    .items_center()
                    .gap(px(2.))
                    .p(px(3.))
                    .border_1()
                    .border_color(theme.border)
                    .rounded(theme.radius)
                    .children(
                        [
                            (None, "全部"),
                            (Some(WorkspaceChangeKind::Created), "新增"),
                            (Some(WorkspaceChangeKind::Modified), "修改"),
                            (Some(WorkspaceChangeKind::Deleted), "删除"),
                        ]
                        .into_iter()
                        .map(|(kind, label)| {
                            let selected = self.session_change_kind == kind;
                            Button::new(SharedString::from(format!("session-kind-{label}")))
                                .small()
                                .label(label)
                                .when(selected, |button| button.primary())
                                .when(!selected, |button| button.ghost())
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.session_change_kind = kind;
                                    cx.notify();
                                }))
                        }),
                    ),
            )
            .child(
                Button::new("session-change-sort")
                    .small()
                    .ghost()
                    .icon(icon("icons/arrow-up-down.svg").with_size(px(14.)))
                    .label(if self.session_change_sort_ascending {
                        "时间正序"
                    } else {
                        "时间倒序"
                    })
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.session_change_sort_ascending = !this.session_change_sort_ascending;
                        cx.notify();
                    })),
            );
        let picker_query = self
            .session_change_picker_query
            .read(cx)
            .value()
            .trim()
            .to_lowercase();
        let picker_rows = self
            .session_change_picker_sessions
            .iter()
            .filter(|session| {
                picker_query.is_empty()
                    || session.title.to_lowercase().contains(&picker_query)
                    || session.project_name.to_lowercase().contains(&picker_query)
            })
            .map(|session| {
                let key = session.key.clone();
                let selected = self.session_change_picker_selected.contains(&key);
                let title = if session.title.trim().is_empty() {
                    "未命名会话".to_string()
                } else {
                    session.title.clone()
                };
                let date = format_time(session.updated_at);
                let agent = session.agent.display_name().to_string();
                let project = if session.project_name.trim().is_empty() {
                    "全局会话".to_string()
                } else {
                    session.project_name.clone()
                };
                h_flex()
                    .id(SharedString::from(format!("session-change-picker-{key}")))
                    .w_full()
                    .min_h(px(64.))
                    .px(SPACE_MD)
                    .gap(SPACE_MD)
                    .items_center()
                    .border_1()
                    .border_color(if selected { theme.primary } else { theme.border })
                    .rounded(theme.radius)
                    .bg(if selected { theme.list_active } else { theme.background })
                    .cursor_pointer()
                    .hover(|style| style.bg(theme.secondary_hover))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if !this.session_change_picker_selected.remove(&key) {
                            this.session_change_picker_selected.insert(key.clone());
                        }
                        cx.notify();
                    }))
                    .child(
                        div()
                            .size(px(18.))
                            .flex_shrink_0()
                            .flex()
                            .items_center()
                            .justify_center()
                            .border_1()
                            .border_color(if selected { theme.primary } else { theme.border })
                            .rounded(px(3.))
                            .bg(if selected { theme.primary } else { theme.background })
                            .text_size(FONT_CAPTION)
                            .text_color(theme.background)
                            .child(if selected { "✓" } else { "" }),
                    )
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .gap(px(2.))
                            .child(div().truncate().text_size(FONT_BODY).child(title))
                            .child(
                                div()
                                    .truncate()
                                    .text_size(FONT_CAPTION)
                                    .text_color(theme.muted_foreground)
                                    .child(format!("{date}  ·  {agent}  ·  {project}")),
                            ),
                    )
                    .when(selected, |row| {
                        row.child(div().text_size(FONT_CAPTION).text_color(theme.primary).child("已选入"))
                    })
                    .into_any_element()
            })
            .collect::<Vec<_>>();
        let picker_empty = picker_rows.is_empty();
        let picker_overlay = div()
            .absolute()
            .inset_0()
            .occlude()
            .flex()
            .items_center()
            .justify_center()
            .p(SPACE_XXL)
            .bg(gpui::black().opacity(0.28))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, _, cx| {
                    this.session_change_picker_open = false;
                    cx.notify();
                }),
            )
            .child(
                v_flex()
                    .w_full()
                    .max_w(px(820.))
                    .max_h(px(680.))
                    .min_h(px(360.))
                    .flex_1()
                    .min_w_0()
                    .border_1()
                    .border_color(theme.border)
                    .rounded(theme.radius)
                    .bg(theme.background)
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(
                        h_flex()
                            .px(SPACE_LG)
                            .py(SPACE_MD)
                            .items_center()
                            .justify_between()
                            .border_b_1()
                            .border_color(theme.border)
                            .child(
                                v_flex()
                                    .gap(SPACE_XS)
                                    .child(div().text_size(FONT_BODY).font_semibold().child("选择会话"))
                                    .child(div().text_size(FONT_CAPTION).text_color(theme.muted_foreground).child("从索引会话中选择；列表显示标题、时间和 Agent")),
                            )
                            .child(
                                Button::new("session-change-picker-close")
                                    .small()
                                    .ghost()
                                    .icon(icon("icons/close.svg").with_size(px(14.)))
                                    .tooltip("关闭")
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.session_change_picker_open = false;
                                        cx.notify();
                                    })),
                            ),
                    )
                    .child(
                        div()
                            .px(SPACE_LG)
                            .pt(SPACE_MD)
                            .child(Input::new(&self.session_change_picker_query)),
                    )
                    .child(
                        h_flex()
                            .px(SPACE_LG)
                            .py(SPACE_SM)
                            .items_center()
                            .justify_between()
                            .child(div().text_size(FONT_CAPTION).font_medium().child("最近活动"))
                            .child(div().text_size(FONT_CAPTION).text_color(theme.muted_foreground).child(format!("按时间倒序 · 显示 {} / {} 个会话", self.session_change_picker_sessions.len(), self.session_change_picker_total))),
                    )
                    .child(
                        v_flex()
                            .id("session-change-picker-list")
                            .flex_1()
                            .min_h_0()
                            .overflow_y_scroll()
                            .px(SPACE_LG)
                            .gap(SPACE_XS)
                            .children(picker_rows)
                            .when(picker_empty, |list| {
                                list.child(div().py(SPACE_XL).text_size(FONT_BODY).text_color(theme.muted_foreground).child("没有匹配的会话"))
                            })
                            .when(
                                self.session_change_picker_sessions.len()
                                    < self.session_change_picker_total as usize,
                                |list| {
                                    list.child(
                                        Button::new("session-change-picker-load-more")
                                            .w_full()
                                            .small()
                                            .ghost()
                                            .label("加载更多会话")
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                this.load_more_session_change_picker(cx);
                                            })),
                                    )
                                },
                            ),
                    )
                    .child(
                        h_flex()
                            .px(SPACE_LG)
                            .py(SPACE_MD)
                            .items_center()
                            .justify_between()
                            .border_t_1()
                            .border_color(theme.border)
                            .child(div().text_size(FONT_CAPTION).text_color(theme.muted_foreground).child(format!("已选 {} 个会话", self.session_change_picker_selected.len())))
                            .child(
                                Button::new("session-change-picker-apply")
                                    .primary()
                                    .label("完成选择")
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.apply_session_change_picker(cx)
                                    })),
                            ),
                    ),
            );

        h_flex()
            .relative()
            .flex_1()
            .min_w_0()
            .min_h_0()
            .h_full()
            .items_stretch()
            .gap(SPACE_MD)
            .when(compact_layout, |root| root.flex_col())
            .child(div()
            .id("session-changes-scroll")
            .flex_1()
            .min_w_0()
            .min_h_0()
            .when(!compact_layout, |content| content.h_full())
            .overflow_y_scroll()
            .child(
                v_flex()
                    .w_full()
                    .px(SPACE_XXL)
                    .pt(SPACE_MD)
                    .pb(px(40.))
                    .gap(SPACE_LG)
                    .child(
                        v_flex()
                            .w_full()
                            .gap(SPACE_MD)
                            .child(
                                h_flex()
                                    .w_full()
                                    .items_center()
                                    .justify_between()
                                    .child(div().text_size(FONT_DISPLAY).font_semibold().child("会话改动"))
                                    .child(
                                        h_flex()
                                            .items_center()
                                            .gap(SPACE_MD)
                                            .child(div().text_size(FONT_LABEL).text_color(theme.muted_foreground).child(format!("{} 个已选会话", selected_session_count)))
                                            .child(
                                                Button::new("session-change-manage-sessions")
                                                    .small()
                                                    .ghost()
                                                  .label("会话详情")
                                                  .disabled(manage_session_key.is_none())
                                                  .on_click(cx.listener(move |this, _, window, cx| {
                                                      if let Some(key) = manage_session_key.as_deref() {
                                                          this.open_relationship_session_in_sessions(
                                                              key, window, cx,
                                                          );
                                                      }
                                                    })),
                                            )
                                            .child(
                                                Button::new("session-change-add-session")
                                                    .small()
                                                    .primary()
                                                    .icon(icon("icons/plus.svg").with_size(px(14.)))
                                                    .label("选择会话")
                                                    .on_click(cx.listener(|this, _, _window, cx| {
                                                        this.open_session_change_picker(cx);
                                                    })),
                                            ),
                                    ),
                            )
                            .child(
                                h_flex()
                                    .w_full()
                                    .items_center()
                                    .gap(SPACE_LG)
                                    .border_b_1()
                                    .border_color(theme.border)
                                    .pb(SPACE_MD)
                                    .child(div().text_color(theme.foreground).child(format!("{} 个会话", selected_session_count)))
                                    .child(div().text_color(theme.muted_foreground).child(format!("{} 条文件记录", groups.iter().map(|group| count_visible_events(group)).sum::<usize>())))
                                    .child(div().text_color(theme.muted_foreground).child(format!("{} 个 Agent", groups.iter().filter_map(|group| group.metadata.as_ref().map(|meta| meta.agent.display_name())).collect::<HashSet<_>>().len()))),
                            ),
                    )
                    .child(session_filters)
                    .when(self.session_change_loading && groups.is_empty(), |content| {
                        content.child(div().py(SPACE_XXL).flex().justify_center().child(Spinner::new()))
                    })
                    .when_some(self.session_change_error.as_ref(), |content, error| {
                        content.child(div().py(SPACE_MD).text_color(theme.danger).child(format!("读取会话改动失败：{error}")))
                    })
                    .when(groups.is_empty() && !self.session_change_loading && self.session_change_error.is_none(), |content| {
                        content.child(div().py(SPACE_XXL).text_size(FONT_BODY).text_color(theme.muted_foreground).child(if has_active_filter { "当前筛选条件下没有改动记录" } else { "暂无会话改动。请从会话列表手动选入相关会话。" }))
                    })
                    .children(session_rows),
            ))
            .children(inspector)
            .when(self.session_change_picker_open, |root| root.child(picker_overlay))
            .into_any_element()
    }

    fn render_workspace_changes_content(
        &self,
        window: &mut Window,
        cx: &Context<Self>,
    ) -> AnyElement {
        if self.insights_subview == InsightsSubview::SessionChanges {
            return self.render_session_changes_content(window, cx);
        }
        let theme = cx.theme();
        let current_project = self
            .workspace_roots
            .iter()
            .find(|root| Some(root.path.as_str()) == self.workspace_change_project.as_deref());
        let session_changes_active = self.insights_subview == InsightsSubview::SessionChanges;
        let project_name = if session_changes_active {
            "会话改动"
        } else {
            current_project.map(|root| root.name.as_str()).unwrap_or("工作区改动")
        };
        let project_path = self.workspace_change_project.as_deref().unwrap_or("");
        let has_projects = !self.workspace_roots.is_empty();
        let since = self.workspace_change_range.since_ms();
        let display_events = self
            .workspace_change_events
            .iter()
            .filter(|event| since.is_none_or(|since| event.observed_at >= since))
            .filter(|event| self.workspace_change_kind.is_none_or(|kind| event.kind == kind))
            .cloned()
            .collect::<Vec<_>>();
        let loading = self.workspace_change_loading;
        let error = self.workspace_change_error.as_ref();
        let empty = display_events.is_empty() && !loading && error.is_none();
        let changed_files = display_events
            .iter()
            .map(|event| event.file_path.as_str())
            .collect::<HashSet<_>>()
            .len();
        let changed_folders = display_events
            .iter()
            .filter_map(|event| event.file_path.rsplit_once('/').map(|(folder, _)| folder))
            .collect::<HashSet<_>>()
            .len();
        let summary = h_flex()
            .w_full()
            .items_center()
            .gap(SPACE_LG)
            .border_b_1()
            .border_color(theme.border)
            .pb(SPACE_MD)
            .child(div().text_size(FONT_CAPTION).text_color(theme.muted_foreground).child(if session_changes_active { "导入的会话" } else { "最近活动" }))
            .child(div().text_size(FONT_BODY).child(format!("{} 条记录", display_events.len())))
            .child(div().text_size(FONT_CAPTION).text_color(theme.muted_foreground).child(format!("{} 个文件", changed_files)))
            .when(!session_changes_active, |row| row.child(div().text_size(FONT_CAPTION).text_color(theme.muted_foreground).child(format!("{} 个目录组", changed_folders))));
        let mut timeline_groups = workspace_change_groups(&display_events);
        if self.workspace_change_sort_ascending {
            timeline_groups.reverse();
        }
        let render_file_group = |file_group: &WorkspaceChangeFileGroup<'_>,
                                 parent_key: &str|
         -> AnyElement {
            let file_key = format!("{parent_key}:{}", file_group.path);
            let is_open = self.workspace_change_open_files.contains(&file_key);
            let file_name = file_group
                .path
                .rsplit('/')
                .next()
                .unwrap_or(&file_group.path);
            let latest = file_group.events.first().map(|event| event.observed_at);
            let latest = latest
                .and_then(chrono::DateTime::<chrono::Utc>::from_timestamp_millis)
                .map(|time| time.with_timezone(&Local).format("%H:%M").to_string())
                .unwrap_or_else(|| "未知时间".to_string());
            let change_rows =
                file_group.events.iter().map(|event| {
                    let event_id = event.id;
                    let selected = if session_changes_active {
                        self.session_change_selected == Some(event_id)
                    } else {
                        self.workspace_change_selected == Some(event_id)
                    };
                    let (kind_label, marker, kind_color) = match event.kind {
                        WorkspaceChangeKind::Created => ("新增", "+", theme.success),
                        WorkspaceChangeKind::Modified => ("修改", "~", theme.primary),
                        WorkspaceChangeKind::Deleted => ("删除", "−", theme.danger),
                    };
                    let timestamp =
                        chrono::DateTime::<chrono::Utc>::from_timestamp_millis(event.observed_at)
                            .map(|time| {
                                time.with_timezone(&Local)
                                    .format("%Y-%m-%d %H:%M:%S")
                                    .to_string()
                            })
                            .unwrap_or_else(|| "未知时间".to_string());
                    v_flex()
                        .id(SharedString::from(format!("workspace-event-{event_id}")))
                        .w_full()
                        .child(
                            h_flex()
                                .w_full()
                                .items_center()
                                .gap(SPACE_SM)
                                .child(
                                    div()
                                        .text_size(FONT_BODY)
                                        .font_semibold()
                                        .text_color(kind_color)
                                        .child(marker),
                                )
                                .child(
                                    Button::new(SharedString::from(format!(
                                        "workspace-event-toggle-{event_id}"
                                    )))
                                    .ghost()
                                    .h(px(34.))
                                    .icon(
                                        icon(if selected {
                                            "icons/chevron-down.svg"
                                        } else {
                                            "icons/chevron-right.svg"
                                        })
                                        .with_size(px(12.)),
                                    )
                                    .label(format!("{kind_label}  ·  {timestamp}"))
                                    .on_click(cx.listener(move |this, _, _window, cx| {
                                        if session_changes_active {
                                            this.toggle_session_change_event(event_id, cx)
                                        } else {
                                            this.select_workspace_change_event(event_id, cx)
                                        }
                                    })),
                                )
                                .when(!session_changes_active, |row| row.child(
                                    Button::new(SharedString::from(format!(
                                        "workspace-change-delete-{event_id}"
                                    )))
                                    .small()
                                    .ghost()
                                    .icon(icon("icons/trash-2.svg").with_size(px(13.)))
                                    .tooltip("删除这条改动记录")
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.confirm_delete_workspace_change(event_id, window, cx)
                                    })),
                                )),
                        )
                        .into_any_element()
                });
            v_flex()
                .w_full()
                .child(
                    h_flex()
                        .w_full()
                        .items_center()
                        .gap(SPACE_SM)
                        .child(
                            div()
                                .text_color(theme.muted_foreground)
                                .child(icon("icons/file-text.svg").with_size(px(14.))),
                        )
                        .child(
                            Button::new(SharedString::from(format!("workspace-file-{file_key}")))
                                .ghost()
                                .h(px(38.))
                                .icon(
                                    icon(if is_open {
                                        "icons/chevron-down.svg"
                                    } else {
                                        "icons/chevron-right.svg"
                                    })
                                    .with_size(px(12.)),
                                )
                                .label(file_name.to_string())
                                .tooltip(file_group.path.clone())
                                .on_click(cx.listener({
                                    let file_key = file_key.clone();
                                    move |this, _, _window, cx| {
                                        this.toggle_workspace_file(file_key.clone(), cx)
                                    }
                                })),
                        )
                        .child(
                            div()
                                .text_size(FONT_CAPTION)
                                .text_color(theme.muted_foreground)
                                .child(format!("{} 条 · {latest}", file_group.events.len())),
                        ),
                )
                .when(is_open, |file| {
                    file.child(v_flex().pl(SPACE_XL).children(change_rows))
                })
                .into_any_element()
        };
        let timeline_sections = timeline_groups.iter().enumerate().map(|(index, timeline)| {
            let folder = &timeline.folder;
            let folder_key = format!(
                "workspace:{}:{}:{}",
                timeline.latest, timeline.earliest, folder.path
            );
            let is_open = self.workspace_change_open_folders.contains(&folder_key);
            let change_count = folder
                .files
                .iter()
                .map(|file| file.events.len())
                .sum::<usize>();
            let folder_path = if folder.path.is_empty() {
                "项目根目录"
            } else {
                folder.path.as_str()
            };
            let files = folder.files.iter().map(|file| {
                div()
                    .pl(SPACE_LG)
                    .child(render_file_group(
                        file,
                        &format!(
                            "timeline:{}:{}:{}",
                            timeline.latest, timeline.earliest, folder.path
                        ),
                    ))
                    .into_any_element()
            });
            let fmt = |timestamp| chrono::DateTime::<chrono::Utc>::from_timestamp_millis(timestamp)
                .map(|time| time.with_timezone(&Local).format("%Y-%m-%d %H:%M").to_string())
                .unwrap_or_else(|| "未知时间".to_string());
            let label = if timeline.latest == timeline.earliest { fmt(timeline.latest) }
                else { format!("{} – {}", fmt(timeline.earliest), fmt(timeline.latest)) };
            h_flex().w_full().items_stretch().gap(SPACE_XL)
                .child(h_flex().w(px(200.)).flex_shrink_0().items_start().gap(SPACE_MD)
                    .child(div().w(px(152.)).pt(px(2.)).text_right().text_size(FONT_BODY).font_medium().text_color(theme.foreground).child(label))
                    .child(v_flex().w(px(14.)).items_center().pt(px(4.))
                        .child(div().size(px(13.)).rounded_full().bg(theme.primary))
                        .when(index + 1 < timeline_groups.len(), |rail| rail.child(div().w(px(2.)).flex_1().min_h(px(32.)).bg(theme.border)))))
                .child(
                    v_flex()
                        .flex_1()
                        .min_w_0()
                        .gap(SPACE_XS)
                        .p(SPACE_MD)
                        .border_1()
                        .border_color(theme.border)
                        .rounded(theme.radius)
                        .bg(theme.popover)
                        .child(
                            h_flex()
                                .w_full()
                                .items_center()
                                .gap(SPACE_SM)
                                .child(
                                    icon("icons/folder.svg")
                                        .with_size(px(18.))
                                        .text_color(theme.warning),
                                )
                                .child(
                                    Button::new(SharedString::from(format!(
                                        "timeline-folder-{index}-{}",
                                        folder.path
                                    )))
                                    .flex_1()
                                    .min_w_0()
                                    .h(px(40.))
                                    .ghost()
                                    .icon(
                                        icon(if is_open {
                                            "icons/chevron-down.svg"
                                        } else {
                                            "icons/chevron-right.svg"
                                        })
                                        .with_size(px(14.)),
                                    )
                                    .justify_start()
                                    .label(folder_path.to_string())
                                    .tooltip(folder_path.to_string())
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.toggle_workspace_folder(folder_key.clone(), cx)
                                    })),
                                )
                                .child(outline_badge(
                                    format!("{} 个文件 · {} 次改动", folder.files.len(), change_count),
                                    theme.muted_foreground,
                                )),
                        )
                        .when(is_open, |card| card.children(files)),
                )
                .into_any_element()
        }).collect::<Vec<_>>();
        let selected_event = self
            .workspace_change_selected
            .and_then(|id| display_events.iter().find(|event| event.id == id));
        let inspector = selected_event.map(|event| {
            let file_name = event.file_path.rsplit('/').next().unwrap_or(&event.file_path);
            let (kind_label, color) = match event.kind {
                WorkspaceChangeKind::Created => ("文件已新增", theme.success),
                WorkspaceChangeKind::Modified => ("文件已修改", theme.primary),
                WorkspaceChangeKind::Deleted => ("文件已删除", theme.danger),
            };
            let timestamp = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(event.observed_at)
                .map(|time| time.with_timezone(&Local).format("%Y-%m-%d %H:%M:%S").to_string())
                .unwrap_or_else(|| "未知时间".to_string());
            let event_id = event.id;
            v_flex()
                .w(px(390.))
                .flex_shrink_0()
                .min_h_0()
                .border_1()
                .border_color(theme.border)
                .rounded(theme.radius)
                .bg(theme.popover)
                .child(
                    h_flex()
                        .h(px(48.))
                        .flex_shrink_0()
                        .px(SPACE_MD)
                        .items_center()
                        .justify_between()
                        .border_b_1()
                        .border_color(theme.border)
                        .child(div().font_semibold().child("改动详情"))
                        .child(
                            Button::new("workspace-change-inspector-close")
                                .small()
                                .ghost()
                                .icon(icon("icons/close.svg").with_size(px(14.)))
                                .tooltip("关闭详情")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.workspace_change_selected = None;
                                    this.workspace_change_detail = None;
                                    cx.notify();
                                })),
                        ),
                )
                .child(
                    v_flex()
                        .flex_1()
                        .min_h_0()
                        .overflow_y_scrollbar()
                        .p(SPACE_MD)
                        .gap(SPACE_MD)
                        .child(
                            v_flex()
                                .gap(SPACE_XS)
                                .child(div().text_color(color).child(kind_label))
                                .child(div().text_size(FONT_HEADING).font_medium().child(file_name.to_string()))
                                .child(div().text_size(FONT_CAPTION).text_color(theme.muted_foreground).child(event.file_path.clone()))
                                .child(div().text_size(FONT_CAPTION).text_color(theme.muted_foreground).child(timestamp)),
                        )
                        .child(self.render_workspace_change_detail(event_id, cx))
                        .child(
                            v_flex()
                                .gap(SPACE_XS)
                                .border_t_1()
                                .border_color(theme.border)
                                .pt(SPACE_MD)
                                .child(div().text_size(FONT_CAPTION).text_color(theme.muted_foreground).child("所在工作区"))
                                .child(div().text_size(FONT_BODY).child(project_name.to_string()))
                                .child(div().text_size(FONT_CAPTION).text_color(theme.muted_foreground).child(project_path.to_string())),
                        ),
                )
                .into_any_element()
        });
        let workspace_filters = h_flex()
            .w_full()
            .flex_wrap()
            .items_center()
            .gap(SPACE_SM)
            .pb(SPACE_MD)
            .border_b_1()
            .border_color(theme.border)
            .child(
                h_flex()
                    .items_center()
                    .gap(px(2.))
                    .p(px(3.))
                    .border_1()
                    .border_color(theme.border)
                    .rounded(theme.radius)
                    .children(WorkspaceChangeRange::ALL.into_iter().map(|range| {
                        let selected = self.workspace_change_range == range;
                        Button::new(SharedString::from(format!("workspace-range-{range:?}")))
                            .small()
                            .label(range.label())
                            .when(selected, |button| button.primary())
                            .when(!selected, |button| button.ghost())
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.workspace_change_range = range;
                                cx.notify();
                            }))
                    })),
            )
            .child(
                h_flex()
                    .items_center()
                    .gap(px(2.))
                    .p(px(3.))
                    .border_1()
                    .border_color(theme.border)
                    .rounded(theme.radius)
                    .children(
                        [
                            (None, "全部"),
                            (Some(WorkspaceChangeKind::Created), "新增"),
                            (Some(WorkspaceChangeKind::Modified), "修改"),
                            (Some(WorkspaceChangeKind::Deleted), "删除"),
                        ]
                        .into_iter()
                        .map(|(kind, label)| {
                            let selected = self.workspace_change_kind == kind;
                            Button::new(SharedString::from(format!("workspace-kind-{label}")))
                                .small()
                                .label(label)
                                .when(selected, |button| button.primary())
                                .when(!selected, |button| button.ghost())
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.workspace_change_kind = kind;
                                    cx.notify();
                                }))
                        }),
                    ),
            )
            .child(
                Button::new("workspace-change-sort")
                    .small()
                    .ghost()
                    .icon(icon("icons/arrow-up-down.svg").with_size(px(14.)))
                    .label(if self.workspace_change_sort_ascending {
                        "时间正序"
                    } else {
                        "时间倒序"
                    })
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.workspace_change_sort_ascending = !this.workspace_change_sort_ascending;
                        cx.notify();
                    })),
            );
        h_flex()
            .flex_1()
            .min_w_0()
            .min_h_0()
            .h_full()
            .items_stretch()
            .gap(SPACE_MD)
            .child(div()
            .id("workspace-changes-scroll")
            .flex_1()
            .min_w_0()
            .min_h_0()
            .h_full()
            .overflow_y_scroll()
            .child(
                div().w_full().flex().justify_center().px(SPACE_XXL).child(
                    v_flex()
                        .w_full()
                        .max_w(px(1440.))
                        .px(SPACE_XL)
                        .pt(SPACE_MD)
                        .pb(px(40.))
                        .gap(SPACE_LG)
                        .child(
                            v_flex()
                                .w_full()
                                .gap(SPACE_XS)
                                .child(
                                    h_flex()
                                        .w_full()
                                        .items_center()
                                        .justify_between()
                                        .child(div().text_size(FONT_DISPLAY).font_semibold().child(if session_changes_active { "会话改动" } else { "工作区改动" }))
                                        .when(!session_changes_active, |row| {
                                            row.child(
                                                h_flex()
                                                    .gap(SPACE_SM)
                                                    .child(
                                                        Button::new("workspace-add-directory")
                                                            .small()
                                                            .primary()
                                                            .icon(icon("icons/plus.svg").with_size(px(14.)))
                                                            .label("添加目录")
                                                            .on_click(cx.listener(|this, _, window, cx| {
                                                                this.add_workspace_root(window, cx)
                                                            })),
                                                    )
                                                    .when(has_projects, |actions| {
                                                        actions.child(
                                                            Button::new("workspace-changes-refresh")
                                                                .small()
                                                                .ghost()
                                                                .icon(icon("icons/refresh-cw.svg").with_size(px(14.)))
                                                                .label("刷新")
                                                                .disabled(self.workspace_change_loading)
                                                                .on_click(cx.listener(|this, _, _window, cx| {
                                                                    this.reload_workspace_changes(true, cx)
                                                                })),
                                                        )
                                                    }),
                                            )
                                        })
                                )
                                .child(
                                    div()
                                        .text_size(FONT_CAPTION)
                                        .text_color(theme.muted_foreground)
                                        .child(if session_changes_active { "已导入会话中记录的文件改动，按发生时间独立展示。".to_string() } else if has_projects { project_path.to_string() } else { "按时间查看本机监控目录中的文件变化。".to_string() }),
                                )
                                .when(
                                    !session_changes_active && !self.runtime.workspace_watcher_available() && has_projects,
                                    |header| header.child(
                                        div()
                                            .text_size(FONT_CAPTION)
                                            .text_color(theme.danger)
                                            .child("文件系统监控未能启动，当前不会记录新的工作区改动。"),
                                    ),
                                ),
                        )
                        .child(workspace_filters)
                        .when(!display_events.is_empty(), |content| content.child(summary))
                        .when(!has_projects && !session_changes_active, |content| {
                            content.child(
                                div()
                                    .py(SPACE_XXL)
                                    .text_size(FONT_BODY)
                                    .text_color(theme.muted_foreground)
                                    .child("添加要监控的工作区目录后，文件变化会显示在这里。"),
                            )
                        })
                        .when(loading && display_events.is_empty(), |content| {
                            content.child(div().py(SPACE_XXL).flex().justify_center().child(Spinner::new()))
                        })
                        .when_some(error, |content, error| {
                            content.child(
                                div()
                                    .py(SPACE_MD)
                                    .text_color(theme.danger)
                                    .child(format!("读取工作区改动失败：{error}")),
                            )
                        })
                        .when(empty, |content| {
                            content.child(
                                div()
                                    .py(SPACE_XXL)
                                    .text_size(FONT_BODY)
                                    .text_color(theme.muted_foreground)
                                    .child("暂无改动记录"),
                            )
                        })
                        .when(!display_events.is_empty(), |content| {
                            content.child(v_flex().w_full().gap(SPACE_LG).children(timeline_sections))
                        })
                        .when(!session_changes_active && self.workspace_change_has_more && !self.workspace_change_events.is_empty(), |content| {
                            content.child(
                                h_flex()
                                    .w_full()
                                    .justify_center()
                                    .child(
                                        Button::new("workspace-changes-load-more")
                                            .small()
                                            .label(if self.workspace_change_loading { "读取中…" } else { "更早的改动" })
                                            .disabled(self.workspace_change_loading)
                                            .on_click(cx.listener(|this, _, _window, cx| {
                                                this.reload_workspace_changes(false, cx)
                                            })),
                                    ),
                            )
                        }),
                ),
            ))
            .children(inspector)
            .into_any_element()
    }

    fn render_workspace_change_detail(&self, event_id: i64, cx: &Context<Self>) -> AnyElement {
        let theme = cx.theme();
        if self.workspace_change_detail_loading {
            return div()
                .pl(SPACE_XXL)
                .py(SPACE_SM)
                .child(Spinner::new().with_size(px(14.)))
                .into_any_element();
        }
        if let Some(error) = &self.workspace_change_detail_error {
            return div()
                .pl(SPACE_XXL)
                .py(SPACE_SM)
                .text_color(theme.danger)
                .child(error.clone())
                .into_any_element();
        }
        let Some(detail) = self
            .workspace_change_detail
            .as_ref()
            .filter(|detail| detail.event.id == event_id)
        else {
            return div().into_any_element();
        };
        let preview_text = |text: &str| {
            let (preview, truncated) = workspace_change_markdown_preview(text);
            if truncated {
                format!("{preview}\n\n…预览已截断（仅显示前 32 KiB）。")
            } else {
                preview.to_string()
            }
        };
        let before_text = detail.before_text.as_deref().map(preview_text);
        let after_text = detail.after_text.as_deref().map(preview_text);
        let before_hash = detail.event.before_hash.clone();
        let after_hash = detail.event.after_hash.clone();
        v_flex()
            .gap(SPACE_MD)
            .children(before_text.map(|text| {
                v_flex()
                    .gap(SPACE_XS)
                    .child(div().text_size(FONT_CAPTION).text_color(theme.muted_foreground).child("变更前"))
                    .child(TextView::markdown(SharedString::from(format!("workspace-change-before-{event_id}")), text).selectable(true))
                    .into_any_element()
            }))
            .children(after_text.map(|text| {
                v_flex()
                    .gap(SPACE_XS)
                    .child(div().text_size(FONT_CAPTION).text_color(theme.muted_foreground).child("变更后"))
                    .child(TextView::markdown(SharedString::from(format!("workspace-change-after-{event_id}")), text).selectable(true))
                    .into_any_element()
            }))
            .when(detail.before_text.is_none() && detail.after_text.is_none(), |detail| {
                detail.child(
                    v_flex()
                        .gap(SPACE_XS)
                        .text_size(FONT_CAPTION)
                        .text_color(theme.muted_foreground)
                        .child("此文件没有可预览的文本快照；可能是敏感文件、二进制文件或超过快照大小限制。")
                        .when_some(before_hash, |row, hash| {
                            row.child(div().child(format!("变更前哈希：{}", &hash[..hash.len().min(16)])))
                        })
                        .when_some(after_hash, |row, hash| {
                            row.child(div().child(format!("变更后哈希：{}", &hash[..hash.len().min(16)])))
                        }),
                )
            })
            .into_any_element()
    }

    /// 会话导航:搜索框(搜的是会话,⌘K 同一条路)、All Sessions / Starred,再接 Agents / Projects
    fn render_sessions_nav(&self, all_active: bool, cx: &Context<Self>) -> AnyElement {
        let theme = cx.theme();
        v_flex()
            .flex_1()
            .min_h_0()
            .child(
                div().flex_shrink_0().px(SIDEBAR_EDGE).pb(SPACE_MD).child(
                    h_flex().gap(SPACE_SM).child(
                        search_field_frame(cx)
                            .id("sidebar-search")
                            .flex_1()
                            .min_w_0()
                            .cursor_pointer()
                            .active(|s| {
                                s.bg(theme.secondary_active)
                                    .text_colored(theme.foreground, FONT_CAPTION)
                            })
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.toggle_search(&ToggleSearch, window, cx)
                            }))
                            .child(icon("icons/search.svg").with_size(px(13.)).flex_shrink_0())
                            // flex_1 + min_w_0 + truncate:空间不足时压文案,右侧的 ⌘K
                            // 提示不被挤出侧栏
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .truncate()
                                    .child(t("Search sessions")),
                            )
                            .child(
                                div()
                                    .flex_shrink_0()
                                    .text_size(FONT_LABEL)
                                    .child(search_key_hint()),
                            ),
                    ),
                ),
            )
            .child(
                v_flex()
                    .flex_shrink_0()
                    .px(SIDEBAR_EDGE)
                    .pb(SPACE_XS)
                    .gap(SPACE_XS)
                    .child(sidebar_row(
                        "all",
                        RowLead::Icon(icon("icons/layers.svg")),
                        t("All Sessions"),
                        Some(self.session_total()),
                        all_active,
                        RowLevel::Primary,
                        cx.listener(|this, _, window, cx| {
                            this.show_all_sessions(window, cx);
                        }),
                        cx,
                    ))
                    .child(sidebar_row(
                        "fav",
                        RowLead::Icon(icon("icons/star.svg")),
                        t("Starred"),
                        if self.starred_count > 0 {
                            Some(self.starred_count)
                        } else {
                            None
                        },
                        self.favorite_only && !self.cleanup.open,
                        RowLevel::Primary,
                        cx.listener(|this, _, _window, cx| {
                            // 取消收藏过滤时 agent/project 必已是 None(互斥),
                            // 两个方向都归 set_scope
                            let favorite = this.cleanup.open || !this.favorite_only;
                            this.set_scope(None, None, favorite, cx);
                        }),
                        cx,
                    )),
            )
            .child(self.sidebar_groups(
                "sidebar-scroll",
                self.agent_counts.iter().map(|(agent, count)| {
                    (
                        *agent,
                        *count,
                        self.selected_agent == Some(*agent) && !self.cleanup.open,
                    )
                }),
                self.projects.iter().map(|p| {
                    (
                        p.path.clone(),
                        SharedString::from(p.name.clone()),
                        p.session_count,
                        self.selected_project.as_deref() == Some(p.path.as_str())
                            && !self.cleanup.open,
                    )
                }),
                |this, next, cx| this.set_scope(next, None, false, cx),
                |this, next, cx| this.set_scope(None, next, false, cx),
                cx,
            ))
            .into_any_element()
    }

    fn render_relationships_nav(&self, cx: &Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let entity = cx.entity();
        let roots = relationship_roots(&self.relationship_edges);
        let mut relation_rows = Vec::new();
        let mut current_project = None::<String>;
        for (index, root) in roots.iter().enumerate() {
            let project_path = if root.session.project_path.is_empty() {
                "全局".to_string()
            } else {
                root.session.project_path.clone()
            };
            if current_project.as_deref() != Some(project_path.as_str()) {
                current_project = Some(project_path.clone());
                let project_name = if root.session.project_name.is_empty() {
                    project_path.clone()
                } else {
                    root.session.project_name.clone()
                };
                relation_rows.push(
                    h_flex()
                        .id(SharedString::from(format!(
                            "relationship-project-header-{index}"
                        )))
                        .mx(SIDEBAR_EDGE)
                        .mt(if relation_rows.is_empty() {
                            SPACE_XS
                        } else {
                            SPACE_MD
                        })
                        .mb(SPACE_XS)
                        .gap(SPACE_SM)
                        .items_center()
                        .text_size(FONT_BODY)
                        .font_semibold()
                        .text_color(theme.muted_foreground)
                        .child(div().min_w_0().truncate().child(project_name))
                        .child(div().h(px(1.)).flex_1().bg(theme.sidebar_border))
                        .tooltip(move |window, cx| {
                            gpui_component::tooltip::Tooltip::new(project_path.clone())
                                .build(window, cx)
                        })
                        .into_any_element(),
                );
            }
            let session = root.session.clone();
            let key = session.key.clone();
            let title = clip_display(&session.title, 28);
            let selected = self
                .detail
                .as_ref()
                .is_some_and(|detail| detail.meta.key == key);
            let click_entity = entity.clone();
            let menu_entity = entity.clone();
            let menu_key = key.clone();
            relation_rows.push(
                v_flex()
                    .id(SharedString::from(format!("relationship-root-nav-{index}")))
                    .mx(SIDEBAR_EDGE)
                    .px(SPACE_MD)
                    .py(SPACE_MD)
                    .gap(SPACE_XS)
                    .rounded(theme.radius)
                    .border_1()
                    .border_color(if selected {
                        theme.primary
                    } else {
                        theme.border.opacity(0.55)
                    })
                    .cursor_pointer()
                    .when(selected, |row| row.bg(theme.list_active))
                    .when(!selected, |row| {
                        row.hover(|style| style.bg(theme.secondary_hover))
                    })
                    .on_click(move |_, window, cx| {
                        click_entity.update(cx, |this, cx| {
                            this.page = Page::Relationships;
                            this.open_detail(&key, None, window, cx);
                            this.select_list_key(&key, true, window, cx);
                        });
                    })
                    .child(
                        h_flex()
                            .gap(ICON_TEXT_GAP)
                            .items_center()
                            .child(
                                img(session.agent.brand_icon(theme.mode.is_dark()))
                                    .size(px(17.))
                                    .flex_shrink_0(),
                            )
                            .child(
                                div()
                                    .min_w_0()
                                    .truncate()
                                    .text_color(if selected {
                                        theme.sidebar_accent_foreground
                                    } else {
                                        theme.sidebar_foreground
                                    })
                                    .font_medium()
                                    .child(title),
                            ),
                    )
                    .child(
                        h_flex()
                            .gap(ICON_TEXT_GAP)
                            .text_size(FONT_CAPTION)
                            .text_color(theme.muted_foreground)
                            .child("关系树起点")
                            .child(div().flex_1())
                            .child(format!("{} 条关系", root.edge_count)),
                    )
                    .context_menu(move |menu, _, _| {
                        let entity = menu_entity.clone();
                        let key = menu_key.clone();
                        menu.min_w(px(160.)).item(
                            PopupMenuItem::new("打开")
                                .icon(icon("icons/message-square.svg").with_size(px(15.)))
                                .on_click(move |_, window, cx| {
                                    entity.update(cx, |this, cx| {
                                        this.open_relationship_session_in_sessions(
                                            &key, window, cx,
                                        );
                                    });
                                }),
                        )
                    })
                    .into_any_element(),
            );
        }
        v_flex()
            .flex_1()
            .min_h_0()
            .overflow_y_scrollbar()
            .children(relation_rows)
            .when(roots.is_empty(), |nav| {
                nav.child(
                    div()
                        .mx(SIDEBAR_EDGE)
                        .text_size(FONT_LABEL)
                        .text_color(theme.muted_foreground)
                        .child("还没有建立会话关系。"),
                )
            })
            .into_any_element()
    }

    fn render_compressions_nav(&self, cx: &Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let entity = cx.entity();
        let query = self.compression_query.read(cx).value().trim().to_string();
        let mut documents = Vec::new();
        let mut current_project = None::<String>;
        for (index, document) in self.compression_documents.iter().enumerate() {
            let project_path = if document.project_path.is_empty() {
                "全局".to_string()
            } else {
                document.project_path.clone()
            };
            if current_project.as_deref() != Some(project_path.as_str()) {
                current_project = Some(project_path.clone());
                let project_name = if document.project_path.is_empty() {
                    "全局压缩库".to_string()
                } else {
                    PathBuf::from(&document.project_path)
                        .file_name()
                        .and_then(|name| name.to_str())
                        .filter(|name| !name.is_empty())
                        .unwrap_or(&document.project_path)
                        .to_string()
                };
                documents.push(
                    h_flex()
                        .id(SharedString::from(format!(
                            "compression-project-header-{index}"
                        )))
                        .mx(SIDEBAR_EDGE)
                        .mt(if documents.is_empty() {
                            SPACE_XS
                        } else {
                            SPACE_LG
                        })
                        .mb(SPACE_XS)
                        .gap(SPACE_SM)
                        .items_center()
                        .text_size(FONT_BODY)
                        .font_semibold()
                        .text_color(theme.muted_foreground)
                        .child(div().min_w_0().truncate().child(project_name))
                        .child(div().h(px(1.)).flex_1().bg(theme.sidebar_border))
                        .tooltip(move |window, cx| {
                            gpui_component::tooltip::Tooltip::new(project_path.clone())
                                .build(window, cx)
                        })
                        .into_any_element(),
                );
            }
            let path = document.path.clone();
            let selected = self.compression_selected.as_ref() == Some(&path);
            let click_entity = entity.clone();
            documents.push(
                v_flex()
                    .id(SharedString::from(format!(
                        "compression-nav-document-{index}"
                    )))
                    .mx(SIDEBAR_EDGE)
                    .px(SPACE_MD)
                    .py(SPACE_MD)
                    .gap(SPACE_XS)
                    .rounded(theme.radius)
                    .border_1()
                    .border_color(if selected {
                        theme.primary
                    } else {
                        theme.border.opacity(0.55)
                    })
                    .cursor_pointer()
                    .when(selected, |row| row.bg(theme.list_active))
                    .when(!selected, |row| {
                        row.hover(|style| style.bg(theme.secondary_hover))
                    })
                    .on_click(move |_, _, cx| {
                        click_entity.update(cx, |this, cx| {
                            this.compression_selected = Some(path.clone());
                            cx.notify();
                        });
                    })
                    .child(
                        h_flex()
                            .gap(ICON_TEXT_GAP)
                            .items_center()
                            .child(
                                icon("icons/file-text.svg")
                                    .with_size(px(16.))
                                    .flex_shrink_0()
                                    .text_color(theme.muted_foreground),
                            )
                            .child(
                                div()
                                    .min_w_0()
                                    .truncate()
                                    .text_size(FONT_BODY)
                                    .font_medium()
                                    .text_color(if selected {
                                        theme.sidebar_accent_foreground
                                    } else {
                                        theme.sidebar_foreground
                                    })
                                    .child(
                                        document.title.replace(HL_OPEN, "").replace(HL_CLOSE, ""),
                                    ),
                            ),
                    )
                    .child(
                        h_flex()
                            .id(SharedString::from(format!(
                                "compression-document-location-{index}"
                            )))
                            .w_full()
                            .min_w_0()
                            .gap(ICON_TEXT_GAP)
                            .text_size(FONT_CAPTION)
                            .text_color(theme.muted_foreground)
                            .child(
                                div()
                                    .min_w_0()
                                    .flex_1()
                                    .truncate()
                                    .child(document.scope.clone()),
                            )
                            .child(div().flex_1())
                            .child(
                                div().min_w_0().max_w(px(140.)).truncate().child(
                                    document
                                        .path
                                        .file_name()
                                        .and_then(|name| name.to_str())
                                        .unwrap_or("Markdown")
                                        .to_string(),
                                ),
                            )
                            .tooltip({
                                let path = document.path.to_string_lossy().to_string();
                                move |window, cx| {
                                    gpui_component::tooltip::Tooltip::new(path.clone())
                                        .build(window, cx)
                                }
                            }),
                    )
                    .when(!query.is_empty() && !document.snippet.is_empty(), |row| {
                        row.child(
                            div()
                                .mt(px(2.))
                                .text_size(FONT_LABEL)
                                .min_w_0()
                                .w_full()
                                .text_color(theme.muted_foreground)
                                .whitespace_normal()
                                .line_clamp(2)
                                .child(
                                    document
                                        .snippet
                                        .replace(HL_OPEN, "「")
                                        .replace(HL_CLOSE, "」")
                                        .replace('\n', " "),
                                ),
                        )
                    })
                    .when(!document.direct_match, |row| {
                        row.child(
                            div()
                                .mt(px(2.))
                                .text_size(FONT_LABEL)
                                .text_color(theme.accent_foreground)
                                .child(format!(
                                    "关联结果 · {} 条关系",
                                    document.relation_count.max(1)
                                )),
                        )
                    })
                    .into_any_element(),
            );
        }
        v_flex()
            .flex_1()
            .min_h_0()
            .overflow_y_scrollbar()
            .child(
                div()
                    .px(SIDEBAR_EDGE)
                    .pb(SPACE_SM)
                    .child(search_input_control(
                        &self.compression_query,
                        gpui_component::Size::Medium,
                        "compression-search-clear",
                        cx,
                    )),
            )
            .child(
                div()
                    .mx(SIDEBAR_EDGE)
                    .mb(SPACE_XS)
                    .text_size(FONT_LABEL)
                    .text_color(theme.muted_foreground)
                    .child(format!(
                        "压缩文档 · 已索引 {}",
                        self.compression_indexed_documents
                    )),
            )
            .children(documents)
            .when(self.compression_documents.is_empty(), |nav| {
                nav.child(
                    div()
                        .mx(SIDEBAR_EDGE)
                        .text_size(FONT_LABEL)
                        .text_color(theme.muted_foreground)
                        .child(if self.compression_search_loading {
                            "正在搜索…"
                        } else {
                            "没有压缩文档"
                        }),
                )
            })
            .when(self.compression_search_degraded, |nav| {
                nav.child(
                    div()
                        .mx(SIDEBAR_EDGE)
                        .mt(SPACE_MD)
                        .text_size(FONT_LABEL)
                        .text_color(theme.warning)
                        .child("当前使用短关键词兼容模式"),
                )
            })
            .into_any_element()
    }

    fn render_relationship_tree_panel(&self, cx: &Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let Some(detail) = &self.detail else {
            return div().into_any_element();
        };
        let entity = cx.entity();
        let current_key = detail.meta.key.clone();
        let current_title = clip_display(&detail.meta.title, 22);
        let parent_tree = detail.link_parent_tree.clone();
        let child_tree = detail.link_child_tree.clone();
        let has_tree = !parent_tree.is_empty() || !child_tree.is_empty();
        let row = move |id: String,
                        title: String,
                        depth: usize,
                        glyph: &'static str,
                        relation: Option<String>,
                        active: bool,
                        key: Option<String>| {
            let entity = entity.clone();
            let relation_color = relation
                .as_deref()
                .map(|relation| match relation {
                    "continues" => theme.primary,
                    "branches" => theme.info,
                    "blocks" => theme.danger,
                    "resolves" => theme.success,
                    "related" => theme.muted_foreground,
                    _ => theme.muted_foreground,
                })
                .unwrap_or(theme.muted_foreground);
            div()
                .id(SharedString::from(id))
                .h(ROW_HEIGHT_SUB)
                .mx(SIDEBAR_EDGE)
                .pl(LEAD_INSET + px((depth.min(3) as f32) * 10.))
                .pr(SIDEBAR_EDGE)
                .rounded(theme.radius)
                .flex()
                .items_center()
                .gap(ICON_TEXT_GAP)
                .text_size(FONT_CAPTION)
                .text_color(if active {
                    theme.sidebar_accent_foreground
                } else {
                    theme.sidebar_foreground
                })
                .when(active, |this| this.bg(theme.sidebar_accent))
                .when(!active && key.is_some(), |this| {
                    this.cursor_pointer()
                        .hover(|this| this.bg(theme.sidebar_accent.opacity(0.55)))
                })
                .when_some(key, |this, key| {
                    this.on_click(move |_, window, cx| {
                        entity.update(cx, |this, cx| {
                            this.open_detail(&key, None, window, cx);
                            this.select_list_key(&key, true, window, cx);
                        });
                    })
                })
                .child(
                    icon(glyph)
                        .with_size(px(13.))
                        .flex_shrink_0()
                        .text_color(if active {
                            theme.sidebar_accent_foreground
                        } else {
                            relation_color
                        }),
                )
                .when_some(relation, |this, relation| {
                    this.child(
                        div()
                            .flex_shrink_0()
                            .px(px(5.))
                            .rounded(RADIUS_BADGE)
                            .text_size(FONT_LABEL)
                            .text_color(relation_color)
                            .bg(relation_color.opacity(0.12))
                            .child(session_relation_label(&relation)),
                    )
                })
                .child(div().min_w_0().truncate().child(title))
                .into_any_element()
        };
        let mut panel = v_flex()
            .flex_shrink_0()
            .max_h(px(220.))
            .overflow_hidden()
            .border_t_1()
            .border_color(theme.sidebar_border)
            .pt(SPACE_XS)
            .pb(SPACE_SM)
            .gap(px(2.))
            .child(group_header(
                "relationship-tree-header",
                "关系树",
                self.relationship_tree_collapsed,
                cx.listener(|this, _, _window, cx| {
                    this.relationship_tree_collapsed = !this.relationship_tree_collapsed;
                    cx.notify();
                }),
                cx,
            ));
        if self.relationship_tree_collapsed {
            return panel.into_any_element();
        }
        panel = panel.child(row(
            "relationship-current".to_string(),
            current_title,
            0,
            "icons/message-square.svg",
            None,
            true,
            Some(current_key),
        ));
        if has_tree {
            if !parent_tree.is_empty() {
                panel = panel.child(
                    group_header(
                        "relationship-parents-header",
                        "上游",
                        self.relationship_parents_collapsed,
                        cx.listener(|this, _, _window, cx| {
                            this.relationship_parents_collapsed =
                                !this.relationship_parents_collapsed;
                            cx.notify();
                        }),
                        cx,
                    )
                    .child(div().flex_1())
                    .child(
                        div()
                            .pr(SIDEBAR_EDGE)
                            .text_size(FONT_LABEL)
                            .text_color(theme.muted_foreground)
                            .child(parent_tree.len().to_string()),
                    ),
                );
                if !self.relationship_parents_collapsed {
                    for rel in parent_tree {
                        let title = clip_display(&rel.session.title, 22);
                        panel = panel.child(row(
                            format!("relationship-parent:{}", rel.session.key),
                            title,
                            rel.depth,
                            session_relation_icon(&rel.relation),
                            Some(rel.relation),
                            false,
                            Some(rel.session.key),
                        ));
                    }
                }
            }
            if !child_tree.is_empty() {
                panel = panel.child(
                    group_header(
                        "relationship-children-header",
                        "分支",
                        self.relationship_children_collapsed,
                        cx.listener(|this, _, _window, cx| {
                            this.relationship_children_collapsed =
                                !this.relationship_children_collapsed;
                            cx.notify();
                        }),
                        cx,
                    )
                    .child(div().flex_1())
                    .child(
                        div()
                            .pr(SIDEBAR_EDGE)
                            .text_size(FONT_LABEL)
                            .text_color(theme.muted_foreground)
                            .child(child_tree.len().to_string()),
                    ),
                );
                if !self.relationship_children_collapsed {
                    for rel in child_tree {
                        let title = clip_display(&rel.session.title, 22);
                        panel = panel.child(row(
                            format!("relationship-child:{}", rel.session.key),
                            title,
                            rel.depth,
                            session_relation_icon(&rel.relation),
                            Some(rel.relation),
                            false,
                            Some(rel.session.key),
                        ));
                    }
                }
            }
        } else {
            panel = panel.child(
                div()
                    .mx(SIDEBAR_EDGE)
                    .px(LEAD_INSET)
                    .py(SPACE_XS)
                    .text_size(FONT_LABEL)
                    .text_color(theme.muted_foreground)
                    .child("暂无关系"),
            );
        }
        panel.into_any_element()
    }

    fn render_relationships_page(&self, cx: &Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let Some(detail) = &self.detail else {
            return v_flex()
                .size_full()
                .items_center()
                .justify_center()
                .bg(theme.background)
                .child(empty_state(
                    "icons/git-branch.svg",
                    px(48.),
                    px(22.),
                    "关系",
                    "选择一个会话查看关系树。",
                    cx,
                ))
                .into_any_element();
        };
        let entity = cx.entity();
        let relation_color = |relation: &str| match relation {
            "continues" => theme.primary,
            "branches" => theme.info,
            "blocks" => theme.danger,
            "resolves" => theme.success,
            "related" => theme.muted_foreground,
            _ => theme.muted_foreground,
        };
        let danger_color = theme.danger;
        let node = |id: String,
                    session: SessionMeta,
                    relation: Option<String>,
                    edge: Option<(String, String, String)>,
                    start: bool,
                    depth: usize,
                    active: bool| {
            let entity = entity.clone();
            let key = session.key.clone();
            let title = clip_display(&session.title, 52);
            let project = if session.project_name.is_empty() {
                "未知项目".to_string()
            } else {
                session.project_name.clone()
            };
            let color = relation
                .as_deref()
                .map(relation_color)
                .unwrap_or(theme.primary);
            let click_entity = entity.clone();
            let menu_entity = entity.clone();
            let menu_key = key.clone();
            h_flex()
                .id(SharedString::from(id))
                .w_full()
                .min_w_0()
                .items_center()
                .rounded(theme.radius)
                .cursor_pointer()
                .when(!active, |this| {
                    this.hover(|style| style.bg(theme.secondary_hover))
                })
                .on_click(move |_, window, cx| {
                    click_entity.update(cx, |this, cx| {
                        this.page = Page::Relationships;
                        this.open_detail(&key, None, window, cx);
                        this.select_list_key(&key, true, window, cx);
                    });
                })
                .child(
                    div()
                        .w(px(24. + (depth.min(6) as f32) * 20.))
                        .flex_shrink_0()
                        .flex()
                        .justify_end()
                        .self_stretch()
                        .child(
                            div()
                                .w(px(12.))
                                .border_l_1()
                                .border_color(theme.border.opacity(0.8))
                                .child(
                                    div()
                                        .mt(px(28.))
                                        .h(px(1.))
                                        .w(px(12.))
                                        .bg(theme.border.opacity(0.8)),
                                ),
                        ),
                )
                .child(
                    v_flex()
                        .flex_1()
                        .min_w_0()
                        .gap(SPACE_XS)
                        .rounded(theme.radius)
                        .border_1()
                        .border_color(if active {
                            theme.primary
                        } else {
                            theme.border.opacity(0.9)
                        })
                        .bg(if active {
                            theme.list_active
                        } else {
                            theme.popover
                        })
                        .px(SPACE_MD)
                        .py(SPACE_LG)
                        .child(
                            h_flex()
                                .w_full()
                                .gap(SPACE_SM)
                                .items_center()
                                .child(
                                    icon(if start {
                                        "icons/git-branch.svg"
                                    } else {
                                        relation
                                            .as_deref()
                                            .map(session_relation_icon)
                                            .unwrap_or("icons/message-square.svg")
                                    })
                                    .with_size(px(15.))
                                    .text_color(color),
                                )
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .truncate()
                                        .text_size(FONT_HEADING)
                                        .font_medium()
                                        .text_color(theme.foreground)
                                        .child(title),
                                )
                                .when(start, |this| {
                                    this.child(outline_badge("起点", theme.primary))
                                })
                                .when_some(relation.clone().filter(|_| !start), |this, relation| {
                                    this.child(outline_badge(
                                        session_relation_label(&relation),
                                        color,
                                    ))
                                })
                                .when_some(edge.clone(), |this, (parent, child, old_relation)| {
                                    let entity = entity.clone();
                                    this.child(
                                        Button::new(SharedString::from(format!(
                                            "relationship-edge-actions:{child}:{old_relation}"
                                        )))
                                        .ghost()
                                        .rounded(RADIUS_BUTTON)
                                        .icon(icon("icons/more-horizontal.svg").with_size(px(15.)))
                                        .dropdown_menu(move |menu, _, _| {
                                            let menu = SESSION_RELATIONS.iter().fold(
                                                menu.min_w(px(180.)),
                                                |menu, relation| {
                                                    let entity = entity.clone();
                                                    let parent = parent.clone();
                                                    let child = child.clone();
                                                    let old_relation = old_relation.clone();
                                                    menu.item(
                                                        PopupMenuItem::new(format!(
                                                            " 改为{}",
                                                            session_relation_label(relation)
                                                        ))
                                                        .icon(
                                                            icon(session_relation_icon(relation))
                                                                .with_size(px(15.)),
                                                        )
                                                        .checked(*relation == old_relation)
                                                        .on_click(move |_, window, cx| {
                                                            entity.update(cx, |this, cx| {
                                                                this.update_relationship_edge(
                                                                    &parent,
                                                                    &child,
                                                                    &old_relation,
                                                                    relation,
                                                                    window,
                                                                    cx,
                                                                );
                                                            });
                                                        }),
                                                    )
                                                },
                                            );
                                            let entity = entity.clone();
                                            let parent = parent.clone();
                                            let child = child.clone();
                                            let old_relation = old_relation.clone();
                                            menu.separator().item(
                                                PopupMenuItem::element(|_, cx| {
                                                    div()
                                                        .text_color(cx.theme().danger)
                                                        .child(" 删除关系")
                                                })
                                                .icon(
                                                    icon("icons/trash-2.svg")
                                                        .with_size(px(15.))
                                                        .text_color(danger_color),
                                                )
                                                .on_click(move |_, window, cx| {
                                                    entity.update(cx, |this, cx| {
                                                        this.delete_relationship_edge(
                                                            &parent,
                                                            &child,
                                                            &old_relation,
                                                            window,
                                                            cx,
                                                        );
                                                    });
                                                }),
                                            )
                                        })
                                        .anchor(Anchor::TopRight),
                                    )
                                }),
                        )
                        .child(
                            h_flex()
                                .gap(ICON_TEXT_GAP)
                                .text_size(FONT_CAPTION)
                                .text_color(theme.muted_foreground)
                                .child(
                                    img(session.agent.brand_icon(theme.mode.is_dark()))
                                        .size(px(15.))
                                        .flex_shrink_0(),
                                )
                                .child(badge(project, theme.muted, theme.muted_foreground))
                                .when(!session.project_path.is_empty(), |this| {
                                    this.child(
                                        div()
                                            .min_w_0()
                                            .truncate()
                                            .child(session.project_path.clone()),
                                    )
                                }),
                        ),
                )
                .context_menu(move |menu, _, _| {
                    let entity = menu_entity.clone();
                    let key = menu_key.clone();
                    menu.min_w(px(160.)).item(
                        PopupMenuItem::new("打开")
                            .icon(icon("icons/message-square.svg").with_size(px(15.)))
                            .on_click(move |_, window, cx| {
                                entity.update(cx, |this, cx| {
                                    this.open_relationship_session_in_sessions(&key, window, cx);
                                });
                            }),
                    )
                })
                .into_any_element()
        };
        let parents = detail.link_parent_tree.clone();
        let children = detail.link_child_tree.clone();
        let current = detail.meta.clone();
        let mut tree_rows: Vec<AnyElement> = Vec::new();
        let parent_chain = parents.iter().rev().collect::<Vec<_>>();
        for (ix, rel) in parent_chain.iter().enumerate() {
            let edge_child = parent_chain
                .get(ix + 1)
                .map(|next| next.session.key.clone())
                .unwrap_or_else(|| current.key.clone());
            tree_rows.push(node(
                format!("relationships-parent:{}", rel.session.key),
                rel.session.clone(),
                Some(rel.relation.clone()),
                Some((rel.session.key.clone(), edge_child, rel.relation.clone())),
                ix == 0,
                ix,
                false,
            ));
        }
        tree_rows.push(node(
            "relationships-current".to_string(),
            current.clone(),
            parents.last().map(|rel| rel.relation.clone()),
            parents.last().map(|rel| {
                (
                    rel.session.key.clone(),
                    current.key.clone(),
                    rel.relation.clone(),
                )
            }),
            parents.is_empty(),
            parents.len(),
            true,
        ));
        let mut child_parent_stack = vec![current.key.clone()];
        for rel in &children {
            child_parent_stack.truncate(rel.depth);
            let parent_key = child_parent_stack
                .last()
                .cloned()
                .unwrap_or_else(|| current.key.clone());
            tree_rows.push(node(
                format!("relationships-child:{}", rel.session.key),
                rel.session.clone(),
                Some(rel.relation.clone()),
                Some((parent_key, rel.session.key.clone(), rel.relation.clone())),
                false,
                parents.len() + rel.depth,
                false,
            ));
            child_parent_stack.push(rel.session.key.clone());
        }
        let actions = h_flex()
            .gap(SPACE_XS)
            .child(
                Button::new("relationship-chunk-input")
                    .ghost()
                    .rounded(RADIUS_BUTTON)
                    .icon(icon("icons/layers.svg").with_size(px(16.)))
                    .label("选择会话并分块输入")
                    .tooltip("选择关系树中的会话，超长会话按完整轮次分块")
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.open_relationship_chunk_input(window, cx);
                    })),
            )
            .child(
                Button::new("export-relationships")
                    .ghost()
                    .rounded(RADIUS_BUTTON)
                    .icon(icon("icons/download.svg").with_size(px(16.)))
                    .tooltip("导出关系文档")
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.do_export_relationships(window, cx);
                    })),
            )
            .child(self.refresh_button(self.scan.scanning, Self::refresh_sessions, cx))
            .into_any_element();
        let relationship_lead = vec![
            img(current.agent.brand_icon(theme.mode.is_dark()))
                .size(px(15.))
                .into_any_element(),
            div()
                .text_size(FONT_CAPTION)
                .child(current.agent.display_name())
                .into_any_element(),
            project_badge(
                "relationship-detail-project",
                &current.project_path,
                if current.project_name.is_empty() {
                    "未知项目".to_string()
                } else {
                    current.project_name.clone()
                },
                theme,
            ),
        ];
        let relationship_header_meta = h_flex()
            .gap(ICON_TEXT_GAP)
            .flex_wrap()
            .text_size(FONT_CAPTION)
            .children([
                format!("{} 个上游", parents.len()),
                format!("{} 个分支", children.len()),
                format!("{} 个会话", parents.len() + children.len() + 1),
            ])
            .into_any_element();
        v_flex()
            .size_full()
            .min_w_0()
            .bg(theme.background)
            .child(detail_header_frame(
                "relationships-header",
                relationship_lead,
                vec![actions],
                current.title.clone().into(),
                vec![relationship_header_meta],
                theme,
            ))
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scrollbar()
                    .flex()
                    .justify_center()
                    .px(SPACE_XXL)
                    .pb(SPACE_XXL)
                    .child(
                        v_flex()
                            .w_full()
                            .min_w_0()
                            .pt(SPACE_MD)
                            .max_w(px(1120.))
                            .gap(SPACE_LG)
                            .child(
                                h_flex()
                                    .w_full()
                                    .items_center()
                                    .justify_between()
                                    .pb(SPACE_SM)
                                    .border_b_1()
                                    .border_color(theme.border)
                                    .child(section_header_row("关系树", &theme))
                                    .child(
                                        div()
                                            .text_size(FONT_CAPTION)
                                            .text_color(theme.muted_foreground)
                                            .child("点击会话查看 · 右键打开会话"),
                                    ),
                            )
                            .children(tree_rows),
                    ),
            )
            .into_any_element()
    }

    /// 侧栏的 Agents / Projects 两组(会话导航与 Memory 导航同一套行组件、同一个单选
    /// 模型,折叠状态两页共用)。每行给 (身份, 计数, 是否当前);点击回调收到切换后的
    /// 目标——点当前项就是 None(回全部)
    fn sidebar_groups(
        &self,
        id: &'static str,
        agents: impl IntoIterator<Item = (AgentId, i64, bool)>,
        projects: impl IntoIterator<Item = (String, SharedString, i64, bool)>,
        on_agent: fn(&mut Self, Option<AgentId>, &mut Context<Self>),
        on_project: fn(&mut Self, Option<String>, &mut Context<Self>),
        cx: &Context<Self>,
    ) -> Stateful<Div> {
        let dark = cx.theme().mode.is_dark();
        v_flex()
            .id(id)
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .px(SIDEBAR_EDGE)
            .pt(SPACE_XS)
            .pb(SPACE_LG)
            .gap(SPACE_XS)
            .child(group_header(
                "agents-header",
                t("Agents"),
                self.agents_collapsed,
                cx.listener(|this, _, _window, cx| {
                    this.agents_collapsed = !this.agents_collapsed;
                    cx.notify();
                }),
                cx,
            ))
            .when(!self.agents_collapsed, |this| {
                this.children(agents.into_iter().map(|(agent, count, active)| {
                    sidebar_row(
                        agent.as_str(),
                        RowLead::Brand(agent.brand_icon(dark)),
                        agent.display_name(),
                        Some(count),
                        active,
                        RowLevel::Sub,
                        cx.listener(move |this, _, _window, cx| {
                            on_agent(this, (!active).then_some(agent), cx)
                        }),
                        cx,
                    )
                }))
            })
            .child(group_header(
                "projects-header",
                t("Projects"),
                self.projects_collapsed,
                cx.listener(|this, _, _window, cx| {
                    this.projects_collapsed = !this.projects_collapsed;
                    cx.notify();
                }),
                cx,
            ))
            .when(!self.projects_collapsed, |this| {
                this.children(projects.into_iter().enumerate().map(
                    |(ix, (path, label, count, active))| {
                        sidebar_row(
                            ("proj", ix),
                            RowLead::Icon(icon("icons/folder.svg")),
                            label,
                            Some(count),
                            active,
                            RowLevel::Sub,
                            cx.listener(move |this, _, _window, cx| {
                                on_project(this, (!active).then(|| path.clone()), cx)
                            }),
                            cx,
                        )
                    },
                ))
            })
    }

    /// 侧栏底部左端的核心目的地。
    fn render_page_switch(&self, cx: &Context<Self>) -> AnyElement {
        let button = |id: &'static str, tooltip: &'static str, glyph: SidebarGlyph, page: Page| {
            sidebar_tool_btn(
                id,
                tooltip,
                self.page == page && !self.cleanup.open,
                glyph,
                cx.listener(move |this, _, window, cx| this.show_page(page, window, cx)),
                cx,
            )
        };
        h_flex()
            .gap(px(2.))
            .child(button(
                "page-sessions",
                t("Sessions"),
                SidebarGlyph::Icon("icons/messages-square.svg"),
                Page::Sessions,
            ))
            .child(button(
                "page-memory",
                t("Memory"),
                SidebarGlyph::Icon("icons/brain.svg"),
                Page::Memory,
            ))
            .child(button(
                "page-skills",
                t("Skills"),
                SidebarGlyph::Text("S"),
                Page::Skills,
            ))
            .child(button(
                "page-relationships",
                "关系",
                SidebarGlyph::Icon("icons/git-branch.svg"),
                Page::Relationships,
            ))
            .child(button(
                "page-compressions",
                "压缩文件",
                SidebarGlyph::Icon("icons/file-text.svg"),
                Page::Compressions,
            ))
            // 统计放最右、紧邻设置:低频目的地不进首屏动作区(用户 2026-10-15 定)
            .child(button(
                "page-insights",
                t("Insights"),
                SidebarGlyph::Icon("icons/chart-column.svg"),
                Page::Insights,
            ))
            .into_any_element()
    }

    /// 页头右端的 Refresh(三页同一外形,各刷各的——用户 2026-09-22 定):会话页与
    /// Insights 走整库重扫(`refresh_sessions`,Insights 的数字全是会话派生的),Memory
    /// 页只同步记忆来源(`refresh_memories`)。进行中 `loading` + 禁用
    fn refresh_button(
        &self,
        busy: bool,
        on_click: impl Fn(&mut Self, &mut Window, &mut Context<Self>) + 'static,
        cx: &Context<Self>,
    ) -> AnyElement {
        Button::new("refresh")
            .ghost()
            .rounded(RADIUS_BUTTON)
            .icon(icon("icons/refresh-cw.svg").with_size(px(16.)))
            .loading(busy)
            .disabled(busy)
            .tooltip(t("Refresh"))
            .on_click(cx.listener(move |this, _, window, cx| on_click(this, window, cx)))
            .into_any_element()
    }

    fn render_session_list(&self, cx: &Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let shown = self.list_state.read(cx).delegate().rows.len();
        let library_empty = self.session_total() == 0;
        let listed_count = self.total_sessions.max(0);
        let shown_label: SharedString = format!(
            "{} {}",
            listed_count,
            if listed_count == 1 {
                "session"
            } else {
                "sessions"
            }
        )
        .into();
        let sort_key = self.sort_key;
        let sort_ascending = self.sort_ascending;
        let sort_entity = cx.entity();
        let sort_label = match sort_key {
            SortKey::Updated => t("Date updated"),
            SortKey::Created => t("Date created"),
            SortKey::Messages => t("Message count"),
            SortKey::Tokens => t("Token usage"),
        };
        let sort_tooltip = crate::tf!(
            "Sort by {} · {}",
            sort_label,
            if sort_ascending {
                t("Ascending")
            } else {
                t("Descending")
            }
        );
        // 与详情工具栏统一：icon-only ghost，常态透明、hover 才出现背景。
        let sort_menu = Button::new("sort-sessions")
            .ghost()
            .rounded(RADIUS_BUTTON)
            .icon(icon("icons/arrow-up-down.svg").with_size(px(16.)))
            .tooltip(sort_tooltip)
            .dropdown_menu(move |menu, _, _| {
                let mk_key = |label: &'static str, key: SortKey| {
                    let entity = sort_entity.clone();
                    PopupMenuItem::new(label).checked(sort_key == key).on_click(
                        move |_, window, cx| {
                            entity.update(cx, |this, cx| {
                                let selected =
                                    this.detail.as_ref().map(|detail| detail.meta.key.clone());
                                this.sort_key = key;
                                this.refresh(cx);
                                if let Some(selected) = selected {
                                    this.select_list_key(&selected, true, window, cx);
                                }
                            });
                        },
                    )
                };
                let mk_dir = |label: &'static str, ascending: bool| {
                    let entity = sort_entity.clone();
                    PopupMenuItem::new(label)
                        .checked(sort_ascending == ascending)
                        .on_click(move |_, window, cx| {
                            entity.update(cx, |this, cx| {
                                let selected =
                                    this.detail.as_ref().map(|detail| detail.meta.key.clone());
                                this.sort_ascending = ascending;
                                this.refresh(cx);
                                if let Some(selected) = selected {
                                    this.select_list_key(&selected, true, window, cx);
                                }
                            });
                        })
                };
                menu.min_w(px(180.))
                    .item(mk_key(t("Date updated"), SortKey::Updated))
                    .item(mk_key(t("Date created"), SortKey::Created))
                    .item(mk_key(t("Message count"), SortKey::Messages))
                    .item(mk_key(t("Token usage"), SortKey::Tokens))
                    .separator()
                    .item(mk_dir(t("Descending"), false))
                    .item(mk_dir(t("Ascending"), true))
            })
            .anchor(Anchor::TopRight);
        let relationship_picker = self.pending_link_parent.as_ref().map(|(_, parent_title)| {
            let child_title = self
                .pending_link_child
                .as_ref()
                .map(|(_, title)| clip_display(title, 18));
            let text = child_title.map_or_else(
                || {
                    crate::tf!(
                        "正在连接：{}，请在会话列表中选择目标",
                        clip_display(parent_title, 18)
                    )
                },
                |child| {
                    crate::tf!(
                        "正在连接：{} → {}，请选择关系类型",
                        clip_display(parent_title, 14),
                        child
                    )
                },
            );
            h_flex()
                .mx(SPACE_LG)
                .mb(SPACE_SM)
                .px(SPACE_SM)
                .py(px(6.))
                .gap(SPACE_SM)
                .items_center()
                .rounded(RADIUS_BUTTON)
                .bg(theme.primary.opacity(0.10))
                .text_size(FONT_LABEL)
                .text_color(theme.primary)
                .child(icon("icons/git-branch.svg").with_size(px(14.)))
                .child(div().flex_1().min_w_0().truncate().child(text))
                .child(
                    Button::new("cancel-relationship-picker")
                        .ghost()
                        .small()
                        .rounded(RADIUS_BUTTON)
                        .label("取消")
                        .on_click(cx.listener(|this, _, _window, cx| {
                            this.cancel_pending_relationship(cx);
                        })),
                )
                .into_any_element()
        });
        v_flex()
            .w(SESSION_STREAM_WIDTH)
            .h_full()
            .flex_shrink_0()
            .bg(theme.colors.list)
            .child(library_header(
                "list-header",
                self.context_title(),
                shown_label,
                SPACE_LG,
                Some(
                    h_flex()
                        .gap(SPACE_XS)
                        .child(self.refresh_button(self.scan.scanning, Self::refresh_sessions, cx))
                        .child(sort_menu)
                        .into_any_element(),
                ),
                cx,
            ))
            .when_some(relationship_picker, |this, picker| this.child(picker))
            .child(if shown == 0 {
                if library_empty && self.scan.scanning {
                    v_flex()
                        .flex_1()
                        .w_full()
                        .items_center()
                        .justify_center()
                        .gap(SPACE_MD)
                        .text_color(theme.muted_foreground)
                        .child(Spinner::new())
                        .child(
                            div()
                                .text_size(FONT_BODY)
                                .font_medium()
                                .text_color(theme.foreground)
                                .child(t("Building your library")),
                        )
                        .child(
                            div()
                                .text_size(FONT_CAPTION)
                                .child(t("Looking for local agent sessions…")),
                        )
                        .into_any_element()
                } else if library_empty {
                    v_flex()
                        .flex_1()
                        .w_full()
                        .items_center()
                        .justify_center()
                        .gap(SPACE_LG)
                        .child(empty_state(
                            "icons/layers.svg",
                            px(48.),
                            px(22.),
                            t("Your library is empty"),
                            t("Add a local session location to get started."),
                            cx,
                        ))
                        .child(
                            Button::new("empty-open-settings")
                                .primary()
                                .small()
                                .rounded(RADIUS_BUTTON)
                                .label(t("Add a location"))
                                .on_click(cx.listener(|this, _, _window, cx| {
                                    this.settings_page = SettingsPage::Locations;
                                    this.open_settings(cx);
                                })),
                        )
                        .into_any_element()
                } else {
                    v_flex()
                        .flex_1()
                        .w_full()
                        .justify_center()
                        .child(empty_state(
                            "icons/inbox.svg",
                            px(48.),
                            px(22.),
                            t("No matching sessions"),
                            t("Try a different agent, project, or filter."),
                            cx,
                        ))
                        .into_any_element()
                }
            } else {
                List::new(&self.list_state)
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .into_any_element()
            })
    }

    fn show_image_action_success(
        &mut self,
        target: (usize, usize),
        action: ImageAction,
        cx: &mut Context<Self>,
    ) {
        self.image_action_feedback_generation =
            self.image_action_feedback_generation.wrapping_add(1);
        let feedback = ImageActionFeedback {
            target,
            action,
            generation: self.image_action_feedback_generation,
        };
        let Some(detail) = &mut self.detail else {
            return;
        };
        if detail.zoom != Some(target) {
            return;
        }
        detail.image_action_feedback[action.index()] = Some(feedback);
        cx.notify();

        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(1_600))
                .await;
            this.update(cx, |this, cx| {
                if let Some(detail) = &mut this.detail {
                    if detail.image_action_feedback[action.index()] == Some(feedback) {
                        detail.image_action_feedback[action.index()] = None;
                        cx.notify();
                    }
                }
            })
            .ok();
        })
        .detach();
    }

    fn render_image_zoom(&mut self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let Some((message_index, image_index)) =
            self.detail.as_ref().and_then(|detail| detail.zoom)
        else {
            return div().into_any_element();
        };
        let Some(ImageSlot::Ready { image, dims, .. }) = self
            .detail
            .as_ref()
            .and_then(|detail| detail.images.get(message_index))
            .and_then(|images| images.get(image_index))
            .cloned()
        else {
            return div().into_any_element();
        };

        let kind = image
            .format
            .mime_type()
            .trim_start_matches("image/")
            .to_ascii_uppercase();
        let size = crate::format::human_bytes(image.bytes.len());
        let metadata = match dims {
            Some((width, height)) => format!("{kind} · {width} × {height} · {size}"),
            None => format!("{kind} · {size}"),
        };
        let shown = zoom_fit(dims, window.viewport_size());
        let feedback = self
            .detail
            .as_ref()
            .map(|detail| detail.image_action_feedback)
            .unwrap_or([None; 2]);
        let target = (message_index, image_index);
        let copy_succeeded =
            feedback[ImageAction::Copy.index()].is_some_and(|feedback| feedback.target == target);
        let save_succeeded =
            feedback[ImageAction::Save.index()].is_some_and(|feedback| feedback.target == target);
        let success = cx.theme().success;

        let close_backdrop = cx.listener(|this, _, _, cx| {
            if let Some(detail) = &mut this.detail {
                detail.zoom = None;
                detail.image_action_feedback = [None; 2];
                cx.notify();
            }
        });
        let close_button = cx.listener(|this, _, _, cx| {
            if let Some(detail) = &mut this.detail {
                detail.zoom = None;
                detail.image_action_feedback = [None; 2];
                cx.notify();
            }
        });
        let copy_image = image.clone();
        let save_image = image.clone();
        let copy_action = cx.listener(move |this, _, window, cx| {
            cx.stop_propagation();
            cx.write_to_clipboard(ClipboardItem::new_image(&copy_image));
            this.show_image_action_success(target, ImageAction::Copy, cx);
            window.push_notification(Notification::success(t("Image copied")), cx);
        });
        let save_action = cx.listener(move |this, _, window, cx| {
            cx.stop_propagation();
            let image = save_image.clone();
            // 文件名用 gpui 解码时算好的内容 id,同一张图两次保存得到同一个名字
            let name = format!(
                "wake-image-{:016x}.{}",
                image.id,
                image_extension(image.format.mime_type())
            );
            let saved = save_as(
                window,
                cx,
                this.store.clone(),
                name,
                t("Saved"),
                t("Couldn't save the image"),
                move |path| Ok(std::fs::write(path, &image.bytes)?),
            );
            cx.spawn_in(window, async move |this, cx| {
                if saved.await.is_some() {
                    this.update_in(cx, |this, _, cx| {
                        this.show_image_action_success(target, ImageAction::Save, cx)
                    })
                    .ok();
                }
            })
            .detach();
        });

        div()
            .id("image-zoom")
            .absolute()
            .inset_0()
            .occlude()
            .bg(gpui::black().opacity(IMAGE_SCRIM))
            .on_click(close_backdrop)
            .child(
                v_flex()
                    .size_full()
                    .items_center()
                    .justify_center()
                    .gap(SPACE_XL)
                    .px(px(56.))
                    .py(px(52.))
                    .child(
                        gpui::img(image)
                            .id("image-zoom-figure")
                            .w(shown.width)
                            .h(shown.height)
                            .rounded(SPACE_SM)
                            .shadow(vec![zoom_shadow(px(18.), px(48.), 0.45)])
                            .on_click(|_, _, cx| cx.stop_propagation()),
                    )
                    .child(
                        h_flex()
                            .id("image-zoom-actions")
                            .flex_shrink_0()
                            .h(px(40.))
                            .items_center()
                            .gap(SPACE_SM)
                            .pl(SPACE_LG)
                            .pr(SPACE_SM)
                            .rounded(px(20.))
                            .bg(gpui::black().opacity(0.78))
                            .border_1()
                            .border_color(gpui::white().opacity(0.13))
                            .shadow(vec![zoom_shadow(px(8.), px(26.), 0.35)])
                            .on_click(|_, _, cx| cx.stop_propagation())
                            .child(
                                div()
                                    .text_size(FONT_LABEL)
                                    .text_color(gpui::white().opacity(0.64))
                                    .child(metadata),
                            )
                            .child(div().w(px(1.)).h(px(16.)).bg(gpui::white().opacity(0.16)))
                            .child(
                                h_flex()
                                    .id("image-copy")
                                    .size(px(30.))
                                    .items_center()
                                    .justify_center()
                                    .rounded(RADIUS_BUTTON)
                                    .cursor_pointer()
                                    .when(copy_succeeded, |style| style.bg(success.opacity(0.2)))
                                    .hover(move |style| {
                                        style.bg(if copy_succeeded {
                                            success.opacity(0.3)
                                        } else {
                                            gpui::white().opacity(0.16)
                                        })
                                    })
                                    .tooltip(move |window, cx| {
                                        gpui_component::tooltip::Tooltip::new(if copy_succeeded {
                                            t("Copied")
                                        } else {
                                            t("Copy image")
                                        })
                                        .build(window, cx)
                                    })
                                    .on_click(copy_action)
                                    .child(
                                        icon(if copy_succeeded {
                                            "icons/check.svg"
                                        } else {
                                            "icons/copy.svg"
                                        })
                                        .with_size(px(15.))
                                        .text_color(
                                            if copy_succeeded {
                                                success
                                            } else {
                                                gpui::white().opacity(0.84)
                                            },
                                        ),
                                    ),
                            )
                            .child(
                                h_flex()
                                    .id("image-save")
                                    .size(px(30.))
                                    .items_center()
                                    .justify_center()
                                    .rounded(RADIUS_BUTTON)
                                    .cursor_pointer()
                                    .when(save_succeeded, |style| style.bg(success.opacity(0.2)))
                                    .hover(move |style| {
                                        style.bg(if save_succeeded {
                                            success.opacity(0.3)
                                        } else {
                                            gpui::white().opacity(0.16)
                                        })
                                    })
                                    .tooltip(move |window, cx| {
                                        gpui_component::tooltip::Tooltip::new(if save_succeeded {
                                            t("Saved")
                                        } else {
                                            t("Save image")
                                        })
                                        .build(window, cx)
                                    })
                                    .on_click(save_action)
                                    .child(
                                        icon(if save_succeeded {
                                            "icons/check.svg"
                                        } else {
                                            "icons/download.svg"
                                        })
                                        .with_size(px(15.))
                                        .text_color(
                                            if save_succeeded {
                                                success
                                            } else {
                                                gpui::white().opacity(0.84)
                                            },
                                        ),
                                    ),
                            ),
                    ),
            )
            .child(
                h_flex()
                    .id("image-zoom-close")
                    .absolute()
                    .top(SPACE_LG)
                    .right(SPACE_LG)
                    .size(px(32.))
                    .items_center()
                    .justify_center()
                    .rounded(px(9.))
                    .bg(gpui::white().opacity(0.11))
                    .hover(|style| style.bg(gpui::white().opacity(0.2)))
                    .cursor_pointer()
                    .tooltip(|window, cx| {
                        gpui_component::tooltip::Tooltip::new(t("Close")).build(window, cx)
                    })
                    .on_click(close_button)
                    .child(
                        icon("icons/close.svg")
                            .with_size(px(15.))
                            .text_color(gpui::white().opacity(0.86)),
                    ),
            )
            .into_any_element()
    }

    // ---------- 对话区逐消息渲染(设计语言:用户右气泡 / 助手平铺 / 工具折叠簇) ----------

    /// gpui::list 的行渲染。在布局阶段经 entity.update 调用(render 已返回,
    /// lease 已释放,无 double-lease 风险——与 dialog builder 的时机不同)。
    fn render_msg_row(
        &mut self,
        ix: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        // 详情宽度随窗口变化；工具头要用当前可用像素反算显示格数，再交给
        // unicode-width 截断，避免窄窗口溢出、宽窗口仍停在固定长度。
        let outline_width = if self.detail_outline_hidden_for_width(window) {
            px(0.)
        } else if self.detail_outline_collapsed {
            DETAIL_OUTLINE_COLLAPSED_WIDTH
        } else {
            DETAIL_OUTLINE_WIDTH
        };
        let reader_width = (window.viewport_size().width
            - SIDEBAR_WIDTH
            - SESSION_STREAM_WIDTH
            - outline_width
            - SPACE_XXL * 2.)
            .clamp(px(220.), READER_MAX_WIDTH);
        let tool_summary_width = (reader_width - px(156.)).max(px(80.));
        let tool_arg_cells =
            ((f32::from(tool_summary_width) / TOOL_MONO_CELL_WIDTH) as usize).max(8);
        let theme = cx.theme();
        let dark = theme.mode.is_dark();
        // 尾部要用的 Copy 值提前取出,theme 借用不跨越 inner 构建期的 &mut cx
        let search_match_bg = theme.primary.opacity(0.055);
        let jump_bg = theme.primary.opacity(0.16);
        let jump_radius = theme.radius;
        let image_border = theme.border;
        let image_panel = theme.popover;
        let image_muted = theme.muted_foreground;
        let Some(detail) = &self.detail else {
            return div().into_any_element();
        };
        let list_ix = ix;
        let ix = detail
            .reader_visible_indices
            .get(list_ix)
            .copied()
            .unwrap_or(list_ix);
        let total = detail.reader_visible_indices.len();
        let tools_open = detail.expanded_tools.contains(&ix);
        let thinking_open = detail.expanded_thinking.contains(&ix);
        let jump_seq = detail.jump_seq;
        let is_search_match = detail.search_matches.contains(&ix);
        // Rc 克隆只加引用计数;逐行借用,避免每帧深拷贝整条消息(text 可达 32KB)
        let transcript = detail.transcript.clone();
        let shots = detail.images.get(ix).cloned().unwrap_or_default();
        let Some(m) = transcript.get(ix) else {
            return div().into_any_element();
        };
        // 只有 thinking、没有回复正文或工具调用的中间事件属于运行日志，
        // 连续铺在阅读视图里会把真正的对话切碎；完整原始记录仍保留在源文件中。
        if matches!(m.role, MessageRole::Assistant)
            && m.text.is_empty()
            && m.tool_calls.is_empty()
            && m.thinking.is_some()
            && shots.is_empty()
        {
            return div().into_any_element();
        }
        if self.detail_outline_mode == DetailOutlineMode::Conversation
            && m.text.trim().is_empty()
            && shots.is_empty()
        {
            return div().into_any_element();
        }
        if self.detail_outline_mode == DetailOutlineMode::Changes
            && !transcript_message_is_change(m)
            && m.role != MessageRole::User
        {
            return div().into_any_element();
        }
        let visible_tools: Vec<ToolCallView> =
            if self.detail_outline_mode == DetailOutlineMode::Changes {
                m.tool_calls
                    .iter()
                    .filter(|call| tool_call_is_change(call))
                    .cloned()
                    .collect()
            } else {
                m.tool_calls.clone()
            };
        let has_visible_tools = !visible_tools.is_empty();
        // 搜索跳转的落点消息:淡 primary 底色保持高亮,直到换会话
        let is_jump_target = jump_seq == Some(m.seq);

        let inner: AnyElement = if m.kind == MessageKind::CompactSummary {
            centered_pill(t("Context compacted"), cx).into_any_element()
        } else {
            match m.role {
                MessageRole::User => {
                    let has_text = !m.text.trim().is_empty();
                    let mut bubble = v_flex()
                        .max_w(px(540.))
                        .min_w_0()
                        .gap(SPACE_SM)
                        .rounded(theme.radius_lg)
                        .bg(theme.muted)
                        .text_size(FONT_MSG_USER)
                        .line_height(relative(1.85));
                    bubble = if !shots.is_empty() && !has_text {
                        bubble.p(px(7.))
                    } else {
                        bubble.px(px(14.)).py(SPACE_SM)
                    };
                    // 气泡靠内容撑宽,各段直接挂在气泡上、中间不加任何包装层
                    //(原因见 message_content 的文档注释)
                    bubble = bubble.children(message_content(
                        ix,
                        m.seq,
                        &m.text,
                        &detail.meta,
                        &shots,
                        FONT_MSG_USER,
                        gpui::rems(0.5),
                        dark,
                        image_border,
                        image_panel,
                        image_muted,
                        cx.entity(),
                        cx,
                    ));
                    h_flex()
                        .w_full()
                        .justify_end()
                        .child(bubble)
                        .into_any_element()
                }
                MessageRole::Assistant => {
                    let mut col = v_flex().w_full().min_w_0().gap(SPACE_SM);
                    if let Some(thinking) = &m.thinking {
                        col = col.child(thinking_panel(
                            ix,
                            thinking,
                            thinking_open,
                            cx.listener(move |this, _, _window, cx| {
                                if let Some(detail) = &mut this.detail {
                                    toggle_expanded_row(&mut detail.expanded_thinking, ix);
                                    detail.msg_list.splice(list_ix..list_ix + 1, 1);
                                }
                                cx.notify();
                            }),
                            cx,
                        ));
                    }
                    let parts = message_content(
                        ix,
                        m.seq,
                        &m.text,
                        &detail.meta,
                        &shots,
                        FONT_MSG_BODY,
                        gpui::rems(0.6),
                        dark,
                        image_border,
                        image_panel,
                        image_muted,
                        cx.entity(),
                        cx,
                    );
                    if !parts.is_empty() {
                        // 这一层只是正文的字号/行高作用域(thinking、工具簇各有自己的字阶,
                        // 不能提到 col 上);col 是 w_full 定宽列,不会走 max-content 探测,
                        // 与用户气泡"不加包装层"的约束不冲突
                        col = col.child(
                            v_flex()
                                .gap(SPACE_SM)
                                .text_size(FONT_MSG_BODY)
                                .line_height(relative(1.9))
                                .children(parts),
                        );
                    }
                    if has_visible_tools {
                        col = col.child(tool_cluster(
                            ix,
                            &visible_tools,
                            tool_arg_cells,
                            tools_open,
                            cx.listener(move |this, _, _window, cx| {
                                if let Some(detail) = &mut this.detail {
                                    toggle_expanded_row(&mut detail.expanded_tools, ix);
                                    // 行高随展开变化,让 list 重测该行
                                    detail.msg_list.splice(list_ix..list_ix + 1, 1);
                                }
                                cx.notify();
                            }),
                            cx,
                        ));
                    }
                    col.into_any_element()
                }
                MessageRole::System => centered_pill(one_line(&m.text, 120), cx).into_any_element(),
            }
        };

        div()
            .w_full()
            .flex()
            .justify_center()
            // 与详情头共用 24px 阅读轴，正文、标题和元信息形成一条竖线。
            .px(SPACE_XXL)
            .py(SPACE_SM)
            .when(list_ix == 0, |d| d.pt(SPACE_LG))
            .when(list_ix + 1 == total, |d| d.pb(SPACE_XXL))
            .child(
                div()
                    .w_full()
                    .max_w(READER_MAX_WIDTH)
                    .min_w_0()
                    // 搜索命中使用淡色背景，当前上下按钮定位的消息使用更强背景。
                    // 负 margin + 等量 padding:背景向外扩出呼吸边,内容原位不推挤,
                    // 与相邻消息的对齐和行距都不变
                    .when(is_search_match, |d| {
                        d.rounded(jump_radius)
                            .bg(search_match_bg)
                            .mx(-SPACE_SM)
                            .px(SPACE_SM)
                            .my(-SPACE_XS)
                            .py(SPACE_XS)
                    })
                    .when(is_jump_target, |d| {
                        d.rounded(jump_radius)
                            .bg(jump_bg)
                            .mx(-SPACE_SM)
                            .px(SPACE_SM)
                            .my(-SPACE_XS)
                            .py(SPACE_XS)
                    })
                    .child(inner),
            )
            .into_any_element()
    }

    // ---------------- Insights ----------------

    fn on_compression_query_event(
        &mut self,
        _: &Entity<InputState>,
        event: &InputEvent,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if matches!(event, InputEvent::Change) {
            self.compression_selected = None;
            self.reload_compressions(cx);
        }
    }

    fn reload_compressions(&mut self, cx: &mut Context<Self>) {
        if self.page != Page::Compressions {
            return;
        }
        let query = self.compression_query.read(cx).value().trim().to_string();
        self.compression_last_query.clone_from(&query);
        self.compression_search_loading = true;
        self.compression_search_error = None;
        let store = self.store.clone();
        let projects = self.projects.clone();
        let search_query = query.clone();
        let task =
            cx.background_spawn(
                async move { compression_documents(&store, &projects, &search_query) },
            );
        self.compression_search_task = Some(cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| {
                let current_query = this.compression_query.read(cx).value().trim().to_string();
                if current_query != query {
                    return;
                }
                this.compression_search_loading = false;
                match result {
                    Ok((documents, indexed_documents, degraded)) => {
                        this.compression_indexed_documents = indexed_documents;
                        this.compression_search_degraded = degraded;
                        this.compression_search_error = None;
                        let selected_still_exists =
                            this.compression_selected.as_ref().is_some_and(|selected| {
                                documents.iter().any(|doc| &doc.path == selected)
                            });
                        if !selected_still_exists {
                            this.compression_selected =
                                documents.first().map(|doc| doc.path.clone());
                        }
                        this.compression_documents = documents;
                    }
                    Err(error) => {
                        this.compression_documents.clear();
                        this.compression_search_degraded = false;
                        this.compression_search_error = Some(format!("{error:#}"));
                    }
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    fn confirm_delete_compression_document(
        &mut self,
        path: PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let entity = cx.entity();
        let path_label = path.to_string_lossy().to_string();
        window.open_alert_dialog(cx, move |dialog, _window, cx| {
            let theme = cx.theme();
            let entity = entity.clone();
            let path = path.clone();
            dialog
                .title(
                    div()
                        .text_size(FONT_HEADING)
                        .font_semibold()
                        .child("删除这份压缩文档？"),
                )
                .width(px(480.))
                .confirm()
                .button_props(
                    gpui_component::dialog::DialogButtonProps::default()
                        .cancel_text("取消")
                        .ok_text(move_to_trash())
                        .ok_variant(gpui_component::button::ButtonVariant::Danger),
                )
                .child(
                    v_flex()
                        .gap(SPACE_SM)
                        .text_size(FONT_BODY)
                        .child(crate::ui::trash_confirm_body())
                        .child(
                            div()
                                .px(SPACE_SM)
                                .py(SPACE_XS)
                                .rounded(theme.radius)
                                .bg(theme.muted)
                                .text_size(FONT_CAPTION)
                                .font_family(theme.mono_font_family.clone())
                                .child(path_label.clone()),
                        ),
                )
                .on_ok(move |_, window, cx| {
                    entity.update(cx, |this, cx| {
                        this.move_compression_document_to_trash(path.clone(), window, cx);
                    });
                    true
                })
        });
    }

    fn move_compression_document_to_trash(
        &mut self,
        path: PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let path_label = path.to_string_lossy().to_string();
        let task = cx.background_spawn(async move { terminal::trash_paths(&[path_label]) });
        cx.spawn_in(window, async move |this, cx| {
            let result = task.await;
            this.update_in(cx, |this, window, cx| match result {
                Ok(()) => {
                    if this.compression_selected.as_ref() == Some(&path) {
                        this.compression_selected = None;
                    }
                    window.push_notification(Notification::success("压缩文档已移入回收站"), cx);
                    cx.notify();
                }
                Err(error) => window.push_notification(
                    Notification::error(crate::tf!("删除压缩文档失败：{}", format!("{error:#}"))),
                    cx,
                ),
            })
        })
        .detach();
    }

    fn render_compressions(&self, cx: &Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let query = self.compression_query.read(cx).value().trim().to_string();
        let documents = &self.compression_documents;
        let indexed_documents = self.compression_indexed_documents;
        let degraded = self.compression_search_degraded;
        let selected = self
            .compression_selected
            .as_ref()
            .and_then(|path| documents.iter().find(|doc| &doc.path == path))
            .or_else(|| documents.first());
        let selected_record = selected.and_then(|doc| {
            self.store
                .get_compression_document(&doc.path.to_string_lossy())
                .ok()
                .flatten()
        });
        let selected_content = selected_record.as_ref().map(|record| {
            wake_core::services::compression_documents::display_content(&record.body)
        });
        let selected_metadata = selected_record
            .as_ref()
            .map(|record| compression_document_metadata(&record.body))
            .unwrap_or_default();
        let header_actions = selected.map(|doc| {
            let path = doc.path.clone();
            let copy_path = path.to_string_lossy().to_string();
            let reveal_path = copy_path.clone();
            let delete_path = path.clone();
            let delete_entity = cx.entity();
            h_flex()
                .gap(SPACE_XS)
                .child(
                    Button::new("compression-copy-path")
                        .ghost()
                        .rounded(RADIUS_BUTTON)
                        .icon(icon("icons/copy.svg").with_size(px(16.)))
                        .tooltip(t("Copy path"))
                        .on_click(move |_, window, cx| {
                            cx.write_to_clipboard(ClipboardItem::new_string(copy_path.clone()));
                            window
                                .push_notification(Notification::success("压缩文档路径已复制"), cx);
                        }),
                )
                .child(
                    Button::new("compression-reveal")
                        .ghost()
                        .rounded(RADIUS_BUTTON)
                        .icon(icon("icons/folder.svg").with_size(px(16.)))
                        .tooltip(reveal_in_fm())
                        .on_click(move |_, window, cx| {
                            terminal::reveal_in_file_manager(&reveal_path);
                            window.push_notification(
                                Notification::success(t("Opened in file manager")),
                                cx,
                            );
                        }),
                )
                .child(
                    Button::new("compression-trash")
                        .ghost()
                        .rounded(RADIUS_BUTTON)
                        .icon(
                            icon("icons/trash-2.svg")
                                .with_size(px(16.))
                                .text_color(theme.danger),
                        )
                        .tooltip(move_to_trash())
                        .on_click(move |_, window, cx| {
                            delete_entity.update(cx, |this, cx| {
                                this.confirm_delete_compression_document(
                                    delete_path.clone(),
                                    window,
                                    cx,
                                );
                            });
                        }),
                )
                .into_any_element()
        });
        let reader = if let (Some(doc), Some(content)) = (selected, selected_content) {
            div()
                .flex_1()
                .min_w_0()
                .min_h_0()
                .overflow_y_scrollbar()
                .flex()
                .justify_center()
                .px(SPACE_XXL)
                .py(SPACE_LG)
                .child(
                    div()
                        .w_full()
                        .max_w(px(960.))
                        .h_full()
                        .min_w_0()
                        .min_h_0()
                        .flex_shrink_0()
                        .border_1()
                        .border_color(theme.border)
                        .rounded(theme.radius)
                        .bg(theme.popover)
                        .p(SPACE_XXL)
                        .child(
                            TextView::markdown(doc.path.to_string_lossy().to_string(), content)
                                .selectable(true),
                        ),
                )
                .into_any_element()
        } else if let Some(error) = self.compression_search_error.as_ref() {
            v_flex()
                .flex_1()
                .items_center()
                .justify_center()
                .child(empty_state_card(
                    "icons/info.svg",
                    px(58.),
                    px(24.),
                    "压缩文件搜索失败",
                    error.clone(),
                    cx,
                ))
                .into_any_element()
        } else {
            let (title, detail) = if !query.is_empty() && !self.compression_search_loading {
                (
                    format!("没有找到“{query}”"),
                    "请尝试更短或不同的关键词。".to_string(),
                )
            } else {
                (
                    "暂无压缩文件".to_string(),
                    "从会话菜单导出压缩 Markdown 后，会在这里显示。".to_string(),
                )
            };
            v_flex()
                .flex_1()
                .items_center()
                .justify_center()
                .child(empty_state_card(
                    "icons/file-text.svg",
                    px(58.),
                    px(24.),
                    title,
                    detail,
                    cx,
                ))
                .into_any_element()
        };
        let header_title = selected
            .map(|doc| doc.title.replace(HL_OPEN, "").replace(HL_CLOSE, ""))
            .unwrap_or_else(|| "压缩文件".to_string());
        let compression_lead = selected.map(|doc| {
            vec![
                icon("icons/file-text.svg")
                    .with_size(px(15.))
                    .text_color(theme.primary)
                    .into_any_element(),
                div()
                    .text_size(FONT_CAPTION)
                    .child("压缩文档")
                    .into_any_element(),
                project_badge(
                    "compression-detail-project",
                    &doc.project_path,
                    if selected_metadata.project.is_empty() {
                        "全局文档".to_string()
                    } else {
                        selected_metadata.project.clone()
                    },
                    theme,
                ),
            ]
        });
        let compression_meta = selected.map(|_| {
            let mut rows = Vec::new();
            let mut add_row = |label: &'static str, value: String| {
                if value.trim().is_empty() {
                    return;
                }
                rows.push(
                    h_flex()
                        .w_full()
                        .min_w_0()
                        .items_start()
                        .gap(SPACE_SM)
                        .text_size(FONT_BODY)
                        .child(
                            div()
                                .w(px(56.))
                                .flex_shrink_0()
                                .text_size(FONT_CAPTION)
                                .text_color(theme.muted_foreground)
                                .child(label),
                        )
                        .child(
                            div()
                                .min_w_0()
                                .flex_1()
                                .whitespace_normal()
                                .line_height(relative(1.5))
                                .text_color(theme.foreground.opacity(0.78))
                                .child(value),
                        )
                        .into_any_element(),
                );
            };
            if !selected_metadata.generated_at.is_empty() {
                add_row("生成", selected_metadata.generated_at.clone());
            }
            if !selected_metadata.source_session.is_empty() {
                add_row("来源", selected_metadata.source_session.clone());
            }
            if !selected_metadata.coverage.is_empty() {
                add_row("覆盖", selected_metadata.coverage.clone());
            }
            if !selected_metadata.processing_chain.is_empty() {
                add_row("处理", selected_metadata.processing_chain.clone());
            }
            if rows.is_empty() {
                rows.push(
                    div()
                        .min_w_0()
                        .w_full()
                        .text_size(FONT_CAPTION)
                        .whitespace_normal()
                        .child(format!(
                            "{} 个结果 · 已索引 {} 个文档",
                            documents.len(),
                            indexed_documents
                        ))
                        .into_any_element(),
                );
            }
            vec![
                v_flex()
                    .w_full()
                    .gap(SPACE_SM)
                    .p(SPACE_LG)
                    .border_1()
                    .border_color(theme.border)
                    .rounded(theme.radius)
                    .bg(theme.popover)
                    .child(
                        div()
                            .text_size(FONT_BODY)
                            .font_semibold()
                            .text_color(theme.foreground)
                            .child("文档信息"),
                    )
                    .children(rows)
                    .into_any_element(),
            ]
        });
        let fallback_subtitle = format!(
            "{} 个结果 · 已索引 {} 个文档{}",
            documents.len(),
            indexed_documents,
            if degraded {
                " · 短关键词兼容模式"
            } else {
                ""
            }
        );
        let header: AnyElement = if let Some(lead) = compression_lead {
            detail_header_frame(
                "compressions-header",
                lead,
                header_actions.into_iter().collect(),
                header_title.into(),
                compression_meta.unwrap_or_default(),
                theme,
            )
            .into_any_element()
        } else {
            library_header(
                "compressions-header-empty",
                header_title,
                fallback_subtitle,
                SPACE_XXL,
                header_actions,
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
            .child(reader)
            .into_any_element()
    }

    /// Insights 整页(替换中栏+右栏)。头部沿用中栏 88px 标题节奏兼窗口
    /// 拖拽区;内容 720px 阅读宽居中,区块只用留白与组头分隔,不做卡片墙
    fn render_insights(&self, window: &mut Window, cx: &Context<Self>) -> AnyElement {
        let theme = cx.theme();
        // 副标题只说 "Since {首会话月份}"(用户定稿);拿不到时间时回落默认句
        let subtitle: SharedString = match &self.insights {
            Some(d) if d.sessions > 0 => match month_year(d.first_ts) {
                my if my.is_empty() => t("Your coding agent activity").into(),
                my => crate::tf!("Since {}", my).into(),
            },
            _ => t("Your coding agent activity").into(),
        };

        let body: AnyElement = match self.insights_subview {
            InsightsSubview::WorkspaceChanges | InsightsSubview::SessionChanges => {
                self.render_workspace_changes_content(window, cx)
            }
            InsightsSubview::Overview => match &self.insights {
                Some(d) => self.render_insights_content(d, cx),
                _ if self.insights_loading => div()
                    .flex_1()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(Spinner::new())
                    .into_any_element(),
                _ => v_flex()
                    .flex_1()
                    .items_center()
                    .justify_center()
                    .child(empty_state_card(
                        "icons/chart-column.svg",
                        px(58.),
                        px(24.),
                        t("No activity yet"),
                        t("Refresh sessions to see your activity here."),
                        cx,
                    ))
                    .into_any_element(),
            },
        };
        let overview_active = self.insights_subview == InsightsSubview::Overview;
        let workspace_changes_active = self.insights_subview == InsightsSubview::WorkspaceChanges;
        let session_changes_active = self.insights_subview == InsightsSubview::SessionChanges;
        let navigation = h_flex()
            .items_center()
            .gap(SPACE_XS)
            .child(
                Button::new("insights-overview-tab")
                    .small()
                    .label("统计")
                    .when(overview_active, |button| button.primary())
                    .when(!overview_active, |button| button.ghost())
                    .on_click(cx.listener(|this, _, _window, cx| {
                        this.set_insights_subview(InsightsSubview::Overview, cx)
                    })),
            )
            .child(div().w(px(1.)).h(px(16.)).bg(theme.border))
            .child(
                Button::new("insights-workspace-changes-tab")
                    .small()
                    .label("工作区改动")
                    .when(workspace_changes_active, |button| button.primary())
                    .when(!workspace_changes_active, |button| button.ghost())
                    .on_click(cx.listener(|this, _, _window, cx| {
                        this.set_insights_subview(InsightsSubview::WorkspaceChanges, cx)
                    })),
            )
            .child(
                Button::new("insights-session-changes-tab")
                    .small()
                    .label("会话改动")
                    .when(session_changes_active, |button| button.primary())
                    .when(!session_changes_active, |button| button.ghost())
                    .on_click(cx.listener(|this, _, _window, cx| {
                        this.set_insights_subview(InsightsSubview::SessionChanges, cx)
                    })),
            )
            .child(self.refresh_button(self.scan.scanning, Self::refresh_sessions, cx));

        let header: AnyElement = if overview_active {
            library_header(
                "insights-header",
                t("Insights"),
                subtitle,
                SPACE_XXL,
                Some(navigation.into_any_element()),
                cx,
            )
            .into_any_element()
        } else {
            h_flex()
                .id("insights-header")
                .w_full()
                .h(px(58.))
                .flex_shrink_0()
                .window_control_area(WindowControlArea::Drag)
                .px(SPACE_XXL)
                .items_center()
                .justify_between()
                .border_b_1()
                .border_color(theme.border)
                .bg(theme.background)
                .child(div().text_size(FONT_BODY).font_semibold().child("统计"))
                .child(div().occlude().child(navigation))
                .into_any_element()
        };

        v_flex()
            .flex_1()
            .min_w_0()
            .h_full()
            .bg(theme.background)
            .child(header)
            .child(body)
            .into_any_element()
    }

    fn render_insights_content(&self, d: &InsightsData, cx: &Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let custom_range_label = match self.insights_time_range {
            InsightsTimeRange::Custom {
                start_ms,
                end_ms,
                live_end,
            } if self.insights_selected.is_none() => {
                let start = chrono::DateTime::from_timestamp_millis(start_ms)
                    .map(|dt| dt.with_timezone(&Local))
                    .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string())
                    .unwrap_or_default();
                let end = if live_end {
                    Local::now().format("%Y-%m-%d %H:%M").to_string()
                } else {
                    chrono::DateTime::from_timestamp_millis(end_ms)
                        .map(|dt| dt.with_timezone(&Local))
                        .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string())
                        .unwrap_or_default()
                };
                Some(format!("{start} – {end}"))
            }
            _ => None,
        };

        let time_ranges = h_flex()
            .flex_wrap()
            .gap(SPACE_XS)
            .children(
                InsightsTimeRange::ALL
                    .into_iter()
                    .enumerate()
                    .map(|(ix, range)| {
                        let selected =
                            self.insights_selected.is_none() && self.insights_time_range == range;
                        Button::new(("insights-time-range", ix))
                            .small()
                            .rounded(RADIUS_BUTTON)
                            .label(range.label())
                            .when(selected, |button| button.primary())
                            .when(!selected, |button| button.ghost())
                            .on_click(cx.listener(move |this, _, _window, cx| {
                                this.set_insights_time_range(range, cx);
                            }))
                    }),
            )
            .child(
                Button::new("insights-custom-range")
                    .small()
                    .rounded(RADIUS_BUTTON)
                    .label(t("Custom"))
                    .when(
                        self.insights_selected.is_none()
                            && matches!(self.insights_time_range, InsightsTimeRange::Custom { .. }),
                        |button| button.primary(),
                    )
                    .when(
                        self.insights_selected.is_some()
                            || !matches!(
                                self.insights_time_range,
                                InsightsTimeRange::Custom { .. }
                            ),
                        |button| button.ghost(),
                    )
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.open_insights_custom_range(window, cx);
                    })),
            )
            .when_some(self.insights_selected, |row, day| {
                row.child(
                    div()
                        .ml(SPACE_SM)
                        .flex()
                        .items_center()
                        .text_size(FONT_CAPTION)
                        .text_color(theme.muted_foreground)
                        .child(format!("{} · {}", t("Date"), day.format(t("%b %-d, %Y")))),
                )
            })
            .when_some(custom_range_label, |row, label| {
                row.child(
                    div()
                        .ml(SPACE_SM)
                        .flex()
                        .items_center()
                        .text_size(FONT_CAPTION)
                        .text_color(theme.muted_foreground)
                        .child(label),
                )
            });

        // ---- 当前范围内的汇总 ----
        let stat =
            |value: String, label: &'static str| stat_cell(value, label, FONT_TITLE, None, cx);
        let overview = h_flex()
            .gap(px(24.))
            .child(stat(thousands(d.sessions), t("Sessions")))
            .child(stat(fmt_tokens(Some(d.tokens)), t("Tokens")))
            .child(stat(thousands(d.prompts), t("Prompts")))
            .child(stat(thousands(d.agents.len() as i64), t("Agents")))
            .child(stat(thousands(d.project_count), t("Projects")))
            .child(stat(thousands(d.active_days()), t("Active days")));

        // ---- 三个榜单的行首/名称(闭包只捕获 Copy 的色值) ----
        let dark = theme.mode.is_dark();
        let muted = theme.muted_foreground;
        let agent_head = move |u: &UsageTally| agent_row_head(&u.name, dark);
        let project_head = move |u: &UsageTally| {
            (
                Some(
                    icon("icons/folder.svg")
                        .with_size(px(14.))
                        .text_color(muted)
                        .into_any_element(),
                ),
                u.name.clone().into(),
            )
        };
        let model_head = |u: &UsageTally| (None, u.name.clone().into());

        div()
            .id("insights-scroll")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .child(
                div().w_full().flex().justify_center().px(SPACE_XXL).child(
                    v_flex()
                        .w_full()
                        .max_w(READER_MAX_WIDTH)
                        .pt(SPACE_SM)
                        .pb(px(40.))
                        .gap(INSIGHTS_SECTION_GAP)
                        .child(time_ranges)
                        .child(overview)
                        .child(
                            v_flex()
                                .gap(SPACE_MD)
                                .child(switch_section_head(
                                    t("Activity"),
                                    Some(
                                        // 选中态换副标题:下方两图已被这天收窄,
                                        // 说清当前scope与取消方式
                                        match self.insights_selected {
                                            Some(day) => crate::tf!(
                                                "{} · click the day again to clear",
                                                day.format(t("%b %-d, %Y"))
                                            )
                                            .into(),
                                            None => t("Prompts you sent, day by day").into(),
                                        },
                                    ),
                                    None,
                                    cx,
                                ))
                                .child(render_heatmap(d, self.insights_selected, cx)),
                        )
                        .child(self.render_trend_section(d, cx))
                        .child(self.render_distribution_section(d, cx))
                        .child(self.render_usage_section(
                            UsageBoard::Agents,
                            &d.agents,
                            agent_head,
                            cx,
                        ))
                        .when(!d.projects.is_empty(), |col| {
                            col.child(self.render_usage_section(
                                UsageBoard::Projects,
                                &d.projects,
                                project_head,
                                cx,
                            ))
                        })
                        .when(!d.models.is_empty(), |col| {
                            col.child(self.render_usage_section(
                                UsageBoard::Models,
                                &d.models,
                                model_head,
                                cx,
                            ))
                        })
                        // 末尾单独一块:上面全是"你怎么用 agent",这块是"agent 怎么用 ContextOS"
                        .when(!d.wake_lookups_7d.is_empty(), |col| {
                            col.child(self.render_lookups_section(d, cx))
                        }),
                ),
            )
            .into_any_element()
    }

    /// 分布区块:标题右侧 ‹ › 在 hour/weekday/month 三个维度间循环切换。
    /// 热力图选中某天时三档全部收窄为该日所在周期(当天逐时 / 当周逐日 /
    /// 当月逐日)——同一份 period_breakdown 切三份,不再额外查询
    fn render_distribution_section(&self, d: &InsightsData, cx: &Context<Self>) -> AnyElement {
        let range = self.insights_range;
        // 快照必须与当前选中日配对:切天后迟到的旧快照不参与渲染(否则会
        // 出现"格子描边是 15 号、图是 14 号"的错位)
        let period = match self.insights_selected {
            Some(day) => self.insights_period.as_deref().filter(|p| p.day == day),
            None => None,
        };
        // 选中但数据还在路上的那一两帧:先按全历史画(不闪空白),数毫秒后
        // 被周期数据替换;查询失败时上游已收回选中态,不会停在这个中间态
        let values: Vec<i64> = match (period, range) {
            (Some(p), InsightsRange::Hour) => p.day_hours.to_vec(),
            (Some(p), InsightsRange::Weekday) => p.week_days.to_vec(),
            (Some(p), InsightsRange::Month) => {
                p.month_days[..days_in_month(p.day) as usize].to_vec()
            }
            (None, InsightsRange::Hour) => d.hourly.to_vec(),
            (None, InsightsRange::Weekday) => d.weekday.to_vec(),
            (None, InsightsRange::Month) => d.monthly.to_vec(),
        };
        let token_values: Vec<i64> = match (period, range) {
            (Some(p), InsightsRange::Hour) => p.day_hour_tokens.to_vec(),
            (Some(p), InsightsRange::Weekday) => p.week_day_tokens.to_vec(),
            (Some(p), InsightsRange::Month) => {
                p.month_day_tokens[..days_in_month(p.day) as usize].to_vec()
            }
            (None, InsightsRange::Hour) => d.hourly_tokens.to_vec(),
            (None, InsightsRange::Weekday) => d.weekday_tokens.to_vec(),
            (None, InsightsRange::Month) => d.monthly_tokens.to_vec(),
        };
        // 峰值只算这一次:caption 点名的与图里高亮的必须是同一根柱
        let (peak, peak_n) = values
            .iter()
            .enumerate()
            .max_by_key(|(_, n)| **n)
            .map(|(i, n)| (i, *n))
            .unwrap_or((0, 0));
        let arrows = insight_arrows(
            "dist-arrow",
            None,
            cx.listener(move |this, _, _window, cx| {
                this.insights_range = this.insights_range.prev();
                cx.notify();
            }),
            cx.listener(move |this, _, _window, cx| {
                this.insights_range = this.insights_range.next();
                cx.notify();
            }),
            cx,
        );
        let caption = match period {
            Some(p) => dist_caption_scoped(range, p.day, peak, peak_n),
            None => dist_caption(range, peak, peak_n),
        };
        v_flex()
            .gap(SPACE_MD)
            .child(switch_section_head(
                range.title(),
                Some(caption.into()),
                Some(arrows.into_any_element()),
                cx,
            ))
            .child(render_distribution(
                range,
                &values,
                &token_values,
                peak,
                period.map(|p| p.day),
                cx,
            ))
            .into_any_element()
    }

    /// 趋势区块:近 53 周每周 prompts 按 agent 堆叠。不按模型出图——
    /// messages 表没有逐条 model,会话级 model 是末态,切周即改写历史。
    /// 热力图选中某天时,该天所在的周整列高亮并换成那周的副标题
    fn render_trend_section(&self, d: &InsightsData, cx: &Context<Self>) -> AnyElement {
        let layers = trend_layers(&d.trend_agents, cx);
        let start = d.trend_start();
        // 选中日 → 列号(与热力图同一套周网格:周一起始,列 0 = 窗口首周)
        let selected_week = self
            .insights_selected
            .map(|day| ((day - start).num_days().max(0) / 7).min(TREND_WEEKS as i64 - 1) as usize);
        let caption: SharedString = match self.insights_selected {
            // 点名"这一天在哪一周":光高亮一列会被读成"这周整体被选中"
            Some(day) => {
                use chrono::Datelike as _;
                let monday =
                    day - chrono::Duration::days(day.weekday().num_days_from_monday() as i64);
                crate::tf!(
                    "{} is in the week of {}",
                    day.format(t("%b %-d")),
                    monday.format(t("%b %-d"))
                )
                .into()
            }
            None => trend_caption(&layers).into(),
        };
        v_flex()
            .gap(SPACE_MD)
            .child(switch_section_head(t("Over time"), Some(caption), None, cx))
            .child(render_trend(
                start,
                layers,
                &d.weekly_tokens,
                selected_week,
                cx,
            ))
            .into_any_element()
    }

    /// 榜单区块(Agents/Projects/Models 同构):‹ 度量名 › 循环切换,行按
    /// 当前度量降序重排再截断。可用档位就是一个切片:组内无人报
    /// token 时 Tokens 不在其中,归一、循环、行过滤都从这一个事实推出。
    /// 行数档(5/10/20/全部)只给 Projects/Models——Agents 共十九家,全列即可
    fn render_usage_section(
        &self,
        board: UsageBoard,
        rows: &[UsageTally],
        row_head: impl Fn(&UsageTally) -> (Option<AnyElement>, SharedString),
        cx: &Context<Self>,
    ) -> AnyElement {
        use InsightsMetric::*;
        let has_tokens = rows.iter().any(|u| u.tokens > 0);
        // 循环序与概览行同:Sessions / Tokens / Prompts(用户钉的)
        let avail: &[InsightsMetric] = if matches!(board, UsageBoard::Models) {
            &[Tokens]
        } else if has_tokens {
            &[Sessions, Tokens, Prompts]
        } else {
            &[Sessions, Prompts]
        };
        let slot = board as usize;
        // position 找不到 = 存的档位已不可用(如数据刷新后 token 清零),
        // 落回首档;循环即可用档位上的环形下标
        let i = avail
            .iter()
            .position(|m| *m == self.insights_metrics[slot])
            .unwrap_or(0);
        let metric = avail[i];
        let to_prev = avail[(i + avail.len() - 1) % avail.len()];
        let to_next = avail[(i + 1) % avail.len()];
        let arrows = insight_arrows(
            board.arrow_id(),
            Some(metric.caption().into()),
            cx.listener(move |this, _, _window, cx| {
                this.insights_metrics[slot] = to_prev;
                cx.notify();
            }),
            cx.listener(move |this, _, _window, cx| {
                this.insights_metrics[slot] = to_next;
                cx.notify();
            }),
            cx,
        );
        // 行数档:Agents 不入此列(全量),其余榜各自记忆。光标点一下换下一档
        let top_n = self.insights_top_n[slot];
        let show_rows_btn = !matches!(board, UsageBoard::Agents);
        let rows_btn = show_rows_btn.then(|| {
            use gpui_component::button::{Button, ButtonVariants as _};
            let theme = cx.theme();
            let to_next_n = top_n.next();
            let n_label: SharedString = top_n.label().into();
            Button::new(("rows-n", slot))
                .ghost()
                .rounded(RADIUS_BUTTON)
                .label(n_label)
                .text_size(FONT_CAPTION)
                .text_color(theme.muted_foreground)
                .tooltip(top_n.tooltip())
                .on_click(cx.listener(move |this, _, _window, cx| {
                    this.insights_top_n[slot] = to_next_n;
                    cx.notify();
                }))
                .into_any_element()
        });
        let mut sorted: Vec<&UsageTally> = rows
            .iter()
            // Tokens 档只列报了用量的组:空条不是"用了 0",是没数据
            .filter(|u| metric != Tokens || u.tokens > 0)
            .collect();
        // stable sort:平局保持 SQL 的 sessions desc + 名称序
        sorted.sort_by_key(|u| std::cmp::Reverse(metric.value(u)));
        sorted.truncate(match board {
            UsageBoard::Agents => usize::MAX,
            _ => top_n.limit(),
        });
        let max = sorted.iter().map(|u| metric.value(u)).max().unwrap_or(1);
        let head_controls = h_flex()
            .flex_shrink_0()
            .gap(SPACE_XS)
            .when_some(rows_btn, |row, btn| row.child(btn))
            .when(!matches!(board, UsageBoard::Models), |row| {
                row.child(arrows.into_any_element())
            });
        v_flex()
            .gap(SPACE_MD)
            .child(switch_section_head(
                board.title(),
                None,
                Some(head_controls.into_any_element()),
                cx,
            ))
            .children(sorted.into_iter().map(|u| {
                let (lead, label) = row_head(u);
                // 下钻参数从榜单规格派生:Agents 带 agent、Projects 带 project、
                // Models 带 model——一行只透传自己的 key,语义集中在 drill 方法
                let board_for_click = board;
                let key = u.key.clone();
                let on_click = move |this: &mut Workbench,
                                     window: &mut Window,
                                     cx: &mut Context<Workbench>| {
                    this.drill_into_usage(board_for_click, &key, window, cx);
                };
                usage_bar_row(
                    lead,
                    label,
                    metric.display(u).into(),
                    metric.value(u),
                    max,
                    board.name_w(),
                    board,
                    Some(on_click),
                    None,
                    cx,
                )
            }))
            .into_any_element()
    }

    /// "Agents asking ContextOS":Insights 末尾单独一块——前面全是"你怎么用 agent",这块
    /// 是"agent 怎么用 ContextOS":近 7 天各家经 wake-mcp / wake-cli 查过往会话的次数,按
    /// 调用时刻归窗。一条 hairline 隔开,自己的组头与说明;‹ › 在 All / MCP / CLI 间
    /// 循环,行形制同 Agents 榜单;一次都没有就整组不画(与空榜单同规矩)。这是
    /// mcp-roadmap 定的"MCP 接入有没有真实使用"的仪表(位置用户 2026-09-17 定)
    fn render_lookups_section(&self, d: &InsightsData, cx: &Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let dark = theme.mode.is_dark();
        let view = self.insights_lookup_view;
        let arrows = insight_arrows(
            "lookups-arrow",
            Some(view.caption().into()),
            cx.listener(move |this, _, _window, cx| {
                this.insights_lookup_view = view.prev();
                cx.notify();
            }),
            cx.listener(move |this, _, _window, cx| {
                this.insights_lookup_view = view.next();
                cx.notify();
            }),
            cx,
        );
        let (mcp, cli) = d
            .wake_lookups_7d
            .iter()
            .fold((0, 0), |(m, c), l| (m + l.mcp, c + l.cli));
        let range_label = self
            .insights_selected
            .map(|day| day.format(t("%b %-d, %Y")).to_string())
            .unwrap_or_else(|| self.insights_time_range.label().to_string());
        let caption = format!(
            "{} · {} lookups · {} via MCP · {} via CLI",
            range_label,
            thousands(mcp + cli),
            thousands(mcp),
            thousands(cli)
        );
        let mut rows: Vec<&LookupTally> = d
            .wake_lookups_7d
            .iter()
            .filter(|l| view.value(l) > 0)
            .collect();
        rows.sort_by_key(|l| std::cmp::Reverse(view.value(l)));
        let max = rows.iter().map(|l| view.value(l)).max().unwrap_or(1);
        v_flex()
            .gap(SPACE_MD)
            // hairline 把它和上面"你的活动"分成两域;到组头的距离补成一个区块间距
            .child(
                div()
                    .w_full()
                    .h(px(1.))
                    .bg(theme.border)
                    .mb(INSIGHTS_SECTION_GAP - SPACE_MD),
            )
            .child(switch_section_head(
                t("Agents asking ContextOS"),
                Some(caption.into()),
                Some(arrows.into_any_element()),
                cx,
            ))
            .children(rows.into_iter().map(|l| {
                let (lead, label) = agent_row_head(&l.name, dark);
                usage_bar_row(
                    lead,
                    label,
                    thousands(view.value(l)).into(),
                    view.value(l),
                    max,
                    UsageBoard::Agents.name_w(),
                    UsageBoard::Agents,
                    None::<fn(&mut Workbench, &mut Window, &mut Context<Workbench>)>,
                    None,
                    cx,
                )
            }))
            .into_any_element()
    }

    #[allow(deprecated)]
    fn update_detail_selection_auto_scroll(
        &mut self,
        event: &MouseMoveEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let has_selection = event.dragging() && window.has_text_selection(cx);
        let delta = self.detail.as_ref().and_then(|detail| {
            let bounds = detail.msg_list.viewport_bounds();
            (has_selection
                && !detail.msg_list.is_scrollbar_dragging()
                && event.position.x >= bounds.left()
                && event.position.x <= bounds.right())
            .then(|| AutoScroll::compute_delta(event.position.y, bounds))
            .flatten()
        });

        self.detail_selection_auto_scroll
            .set(delta, cx, |delta, this, cx| {
                let Some(detail) = &this.detail else {
                    return;
                };
                detail.msg_list.scroll_by(delta);
                cx.notify();
            });
    }

    fn stop_detail_selection_auto_scroll(&mut self) {
        self.detail_selection_auto_scroll.stop();
    }

    fn on_detail_search_event(
        &mut self,
        input: &Entity<InputState>,
        event: &InputEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !matches!(event, InputEvent::Change) {
            return;
        }
        let query = input.read(cx).value().trim().to_lowercase();
        let Some(detail) = &mut self.detail else {
            return;
        };
        detail.search_matches = if query.is_empty() {
            Vec::new()
        } else {
            detail
                .reader_visible_indices
                .iter()
                .copied()
                .filter(|&index| transcript_message_matches(&detail.transcript[index], &query))
                .collect()
        };
        detail.search_cursor = 0;
        if let Some(&index) = detail.search_matches.first() {
            detail.jump_seq = detail.transcript.get(index).map(|message| message.seq);
            if let Some(item_ix) = detail
                .reader_visible_indices
                .iter()
                .position(|&visible| visible == index)
            {
                detail.msg_list.scroll_to(gpui::ListOffset {
                    item_ix,
                    offset_in_item: px(0.),
                });
            }
        } else {
            detail.jump_seq = None;
        }
        cx.notify();
    }

    fn move_detail_search(&mut self, delta: isize, cx: &mut Context<Self>) {
        let Some(detail) = &mut self.detail else {
            return;
        };
        if detail.search_matches.is_empty() {
            return;
        }
        let len = detail.search_matches.len() as isize;
        detail.search_cursor = ((detail.search_cursor as isize + delta).rem_euclid(len)) as usize;
        let index = detail.search_matches[detail.search_cursor];
        detail.jump_seq = detail.transcript.get(index).map(|message| message.seq);
        if let Some(item_ix) = detail
            .reader_visible_indices
            .iter()
            .position(|&visible| visible == index)
        {
            detail.msg_list.scroll_to(gpui::ListOffset {
                item_ix,
                offset_in_item: px(0.),
            });
        }
        cx.notify();
    }

    fn jump_to_detail_message(&mut self, index: usize, cx: &mut Context<Self>) {
        let Some(detail) = &mut self.detail else {
            return;
        };
        if index >= detail.transcript.len() {
            return;
        }
        detail.jump_seq = Some(detail.transcript[index].seq);
        if let Some(position) = detail.search_matches.iter().position(|&item| item == index) {
            detail.search_cursor = position;
        }
        if let Some(item_ix) = detail
            .reader_visible_indices
            .iter()
            .position(|&visible| visible == index)
        {
            detail.msg_list.scroll_to(gpui::ListOffset {
                item_ix,
                offset_in_item: px(0.),
            });
        }
        cx.notify();
    }

    fn toggle_sidebar(&mut self, cx: &mut Context<Self>) {
        self.sidebar_collapsed = !self.sidebar_collapsed;
        cx.notify();
    }

    fn toggle_detail_outline(&mut self, cx: &mut Context<Self>) {
        self.detail_outline_collapsed = !self.detail_outline_collapsed;
        cx.notify();
    }

    fn set_detail_outline_mode(&mut self, mode: DetailOutlineMode, cx: &mut Context<Self>) {
        self.detail_outline_mode = mode;
        let query = self
            .detail_search_input
            .read(cx)
            .value()
            .trim()
            .to_lowercase();
        if let Some(detail) = &mut self.detail {
            rebuild_detail_reader_view(detail, mode);
            detail.search_matches = if query.is_empty() {
                Vec::new()
            } else {
                detail
                    .reader_visible_indices
                    .iter()
                    .copied()
                    .filter(|&index| transcript_message_matches(&detail.transcript[index], &query))
                    .collect()
            };
            detail.search_cursor = 0;
            if let Some(&index) = detail.search_matches.first() {
                detail.jump_seq = detail.transcript.get(index).map(|message| message.seq);
                if let Some(item_ix) = detail
                    .reader_visible_indices
                    .iter()
                    .position(|&visible| visible == index)
                {
                    detail.msg_list.scroll_to(gpui::ListOffset {
                        item_ix,
                        offset_in_item: px(0.),
                    });
                }
            }
        }
        cx.notify();
    }

    fn toggle_detail_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.detail_search_open = !self.detail_search_open;
        if self.detail_search_open {
            self.detail_search_input.update(cx, |input, cx| {
                input.focus(window, cx);
            });
        }
        cx.notify();
    }

    fn detail_outline_hidden_for_width(&self, window: &Window) -> bool {
        window.viewport_size().width
            < SIDEBAR_WIDTH
                + SESSION_STREAM_WIDTH
                + DETAIL_OUTLINE_WIDTH
                + DETAIL_OUTLINE_MIN_READER_WIDTH
    }

    fn render_detail_outline(&self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let Some(detail) = &self.detail else {
            return div().into_any_element();
        };
        let entity = cx.entity();
        if self.detail_outline_hidden_for_width(window) {
            return div().into_any_element();
        }
        if self.detail_outline_collapsed {
            return v_flex()
                .w(DETAIL_OUTLINE_COLLAPSED_WIDTH)
                .h_full()
                .flex_shrink_0()
                .items_center()
                .pt(WINDOW_TITLEBAR_HEIGHT)
                .border_l_1()
                .border_color(theme.border)
                .bg(theme.background)
                .child(
                    Button::new("expand-detail-outline")
                        .ghost()
                        .small()
                        .icon(icon("icons/chevron-left.svg").with_size(px(15.)))
                        .tooltip("展开右侧栏")
                        .on_click(move |_, _, cx| {
                            entity.update(cx, |this, cx| this.toggle_detail_outline(cx));
                        }),
                )
                .into_any_element();
        }
        let query = self.detail_search_input.read(cx).value().trim().to_string();
        let match_total = detail.search_matches.len();
        let match_label = if match_total == 0 {
            "0 / 0".to_string()
        } else {
            format!("{} / {}", detail.search_cursor + 1, match_total)
        };
        let active_match = detail.search_matches.get(detail.search_cursor).copied();
        let mut rows = Vec::new();
        for turn in &detail.reader_turns {
            if self.detail_outline_mode == DetailOutlineMode::Changes
                && turn.changed_messages.is_empty()
            {
                continue;
            }
            if self.detail_outline_mode == DetailOutlineMode::Conversation
                && turn.question.is_none()
                && turn.reply.is_none()
            {
                continue;
            }
            let mut turn_indices = Vec::new();
            match self.detail_outline_mode {
                DetailOutlineMode::Changes => {
                    if let Some(index) = turn.question {
                        turn_indices.push(index);
                    }
                    turn_indices.extend(turn.changed_messages.iter().copied());
                }
                DetailOutlineMode::Conversation => {
                    if let Some(index) = turn.question {
                        turn_indices.push(index);
                    }
                    if let Some(index) = turn.reply {
                        turn_indices.push(index);
                    }
                }
                DetailOutlineMode::All => {
                    if let Some(index) = turn.question {
                        turn_indices.push(index);
                    }
                    if let Some(index) = turn.reply {
                        turn_indices.push(index);
                    }
                    turn_indices.extend(turn.step_messages.iter().copied());
                }
            }
            let is_match = !query.is_empty()
                && turn_indices
                    .iter()
                    .any(|&index| transcript_message_matches(&detail.transcript[index], &query));
            let is_active = active_match.is_some_and(|index| turn_indices.contains(&index));
            let row_entity = entity.clone();
            let question = turn.question.and_then(|index| detail.transcript.get(index));
            let reply = turn.reply.and_then(|index| detail.transcript.get(index));
            let changed_message = turn
                .changed_messages
                .first()
                .and_then(|&index| detail.transcript.get(index));
            let reply_target_and_preview = if self.detail_outline_mode == DetailOutlineMode::Changes
            {
                changed_message.and_then(|message| {
                    message
                        .tool_calls
                        .iter()
                        .find(|call| tool_call_is_change(call))
                        .map(|call| {
                            (
                                turn.changed_messages.first().copied(),
                                one_line(&call.name, 88),
                            )
                        })
                })
            } else {
                reply
                    .map(|message| (turn.reply, one_line(&message.text, 88)))
                    .filter(|(_, text)| !text.is_empty())
                    .or_else(|| {
                        changed_message.and_then(|message| {
                            message
                                .tool_calls
                                .iter()
                                .find(|call| tool_call_is_change(call))
                                .map(|call| {
                                    (
                                        turn.changed_messages.first().copied(),
                                        one_line(&call.name, 88),
                                    )
                                })
                        })
                    })
            };
            let reply_preview = reply_target_and_preview
                .as_ref()
                .map(|(_, preview)| preview.clone());
            let question_element = question.map(|message| {
                let index = turn.question.expect("question element has an index");
                let row_entity = row_entity.clone();
                h_flex()
                    .id(("detail-outline-question", turn.index))
                    .w_full()
                    .justify_end()
                    .child(
                        v_flex()
                            .max_w(px(196.))
                            .items_end()
                            .gap(px(2.))
                            .child(
                                div()
                                    .text_size(FONT_LABEL)
                                    .text_color(theme.muted_foreground)
                                    .child("你"),
                            )
                            .child(
                                div()
                                    .max_w_full()
                                    .rounded(px(10.))
                                    .bg(theme.muted)
                                    .px(SPACE_SM)
                                    .py(SPACE_XS)
                                    .text_size(FONT_CAPTION)
                                    .text_color(theme.foreground)
                                    .child(one_line(&message.text, 120)),
                            ),
                    )
                    .on_click(move |_, _, cx| {
                        row_entity.update(cx, |this, cx| {
                            this.jump_to_detail_message(index, cx);
                        });
                    })
                    .into_any_element()
            });
            let reply_element = reply_preview.map(|preview| {
                let index = reply_target_and_preview
                    .as_ref()
                    .and_then(|(index, _)| *index)
                    .expect("reply preview has a target");
                let row_entity = row_entity.clone();
                h_flex()
                    .id(("detail-outline-reply", turn.index))
                    .w_full()
                    .gap(ICON_TEXT_GAP)
                    .child(icon("icons/message-square.svg").with_size(px(13.)))
                    .child(
                        v_flex()
                            .min_w_0()
                            .flex_1()
                            .gap(px(2.))
                            .child(
                                h_flex()
                                    .gap(ICON_TEXT_GAP)
                                    .text_size(FONT_LABEL)
                                    .text_color(theme.muted_foreground)
                                    .child("Assistant")
                                    .when(turn.step_messages.len() > 0, |row| {
                                        row.child(format!("{} 步", turn.step_messages.len()))
                                    }),
                            )
                            .child(
                                div()
                                    .w_full()
                                    .min_w_0()
                                    .text_size(FONT_CAPTION)
                                    .text_color(theme.foreground)
                                    .child(preview),
                            ),
                    )
                    .on_click(move |_, _, cx| {
                        row_entity.update(cx, |this, cx| {
                            this.jump_to_detail_message(index, cx);
                        });
                    })
                    .into_any_element()
            });
            rows.push(
                v_flex()
                    .id(("detail-outline-row", turn.index))
                    .w_full()
                    .min_w_0()
                    .gap(SPACE_XS)
                    .px(SPACE_SM)
                    .py(SPACE_SM)
                    .rounded(theme.radius)
                    .when(is_match, |row| row.bg(theme.primary.opacity(0.06)))
                    .when(is_active, |row| row.bg(theme.primary.opacity(0.14)))
                    .hover(|row| row.bg(theme.secondary_hover))
                    .children(question_element)
                    .children(reply_element)
                    .when(turn.request_count > 0, |row| {
                        row.child(
                            h_flex()
                                .w_full()
                                .justify_end()
                                .text_size(FONT_CAPTION)
                                .text_color(theme.muted_foreground)
                                .child(crate::tf!(
                                    "{} tokens · {} requests",
                                    fmt_tokens(Some(turn.tokens_used)),
                                    turn.request_count
                                )),
                        )
                    })
                    .into_any_element(),
            );
        }
        let prev_entity = entity.clone();
        let next_entity = entity.clone();
        let mode_entity = entity.clone();
        let search_entity = entity.clone();
        let close_search_entity = entity.clone();
        let collapse_entity = entity.clone();
        let toolbar = h_flex()
            .w_full()
            .items_center()
            .justify_between()
            .gap(SPACE_XS)
            .child(
                h_flex()
                    .gap(px(1.))
                    .p(px(2.))
                    .rounded(theme.radius)
                    .bg(theme.muted)
                    .child(
                        Button::new("outline-all")
                            .ghost()
                            .small()
                            .when(
                                self.detail_outline_mode == DetailOutlineMode::All,
                                |button| button.bg(theme.background),
                            )
                            .label("全部")
                            .on_click({
                                let entity = mode_entity.clone();
                                move |_, _, cx| {
                                    entity.update(cx, |this, cx| {
                                        this.set_detail_outline_mode(DetailOutlineMode::All, cx);
                                    });
                                }
                            }),
                    )
                    .child(
                        Button::new("outline-conversation")
                            .ghost()
                            .small()
                            .when(
                                self.detail_outline_mode == DetailOutlineMode::Conversation,
                                |button| button.bg(theme.background),
                            )
                            .label("对话")
                            .on_click({
                                let entity = mode_entity.clone();
                                move |_, _, cx| {
                                    entity.update(cx, |this, cx| {
                                        this.set_detail_outline_mode(
                                            DetailOutlineMode::Conversation,
                                            cx,
                                        );
                                    });
                                }
                            }),
                    )
                    .child(
                        Button::new("outline-changes")
                            .ghost()
                            .small()
                            .when(
                                self.detail_outline_mode == DetailOutlineMode::Changes,
                                |button| button.bg(theme.background),
                            )
                            .label("改动")
                            .on_click(move |_, _, cx| {
                                mode_entity.update(cx, |this, cx| {
                                    this.set_detail_outline_mode(DetailOutlineMode::Changes, cx);
                                });
                            }),
                    ),
            )
            .child(
                h_flex()
                    .gap(SPACE_XS)
                    .child(
                        Button::new("outline-search-toggle")
                            .ghost()
                            .small()
                            .icon(icon("icons/search.svg").with_size(px(15.)))
                            .tooltip("搜索会话")
                            .on_click(move |_, window, cx| {
                                search_entity.update(cx, |this, cx| {
                                    this.toggle_detail_search(window, cx);
                                });
                            }),
                    )
                    .child(
                        Button::new("collapse-detail-outline")
                            .ghost()
                            .small()
                            .icon(icon("icons/chevron-right.svg").with_size(px(15.)))
                            .tooltip("收起右侧栏")
                            .on_click(move |_, _, cx| {
                                collapse_entity.update(cx, |this, cx| {
                                    this.toggle_detail_outline(cx);
                                });
                            }),
                    ),
            );
        let search_controls = if self.detail_search_open {
            h_flex()
                .w_full()
                .min_w_0()
                .gap(SPACE_XS)
                .child(
                    Input::new(&self.detail_search_input)
                        .appearance(false)
                        .min_w_0()
                        .flex_1(),
                )
                .child(
                    div()
                        .flex_shrink_0()
                        .text_size(FONT_LABEL)
                        .text_color(theme.muted_foreground)
                        .child(match_label),
                )
                .child(
                    Button::new("detail-search-prev")
                        .ghost()
                        .small()
                        .w(px(24.))
                        .icon(icon("icons/chevron-up.svg").with_size(px(14.)))
                        .tooltip("上一个匹配")
                        .on_click(move |_, _, cx| {
                            prev_entity.update(cx, |this, cx| {
                                this.move_detail_search(-1, cx);
                            });
                        }),
                )
                .child(
                    Button::new("detail-search-next")
                        .ghost()
                        .small()
                        .w(px(24.))
                        .icon(icon("icons/chevron-down.svg").with_size(px(14.)))
                        .tooltip("下一个匹配")
                        .on_click(move |_, _, cx| {
                            next_entity.update(cx, |this, cx| {
                                this.move_detail_search(1, cx);
                            });
                        }),
                )
                .child(
                    Button::new("detail-search-close")
                        .ghost()
                        .small()
                        .w(px(24.))
                        .icon(icon("icons/close.svg").with_size(px(14.)))
                        .tooltip("关闭搜索")
                        .on_click(move |_, window, cx| {
                            close_search_entity.update(cx, |this, cx| {
                                this.toggle_detail_search(window, cx);
                            });
                        }),
                )
                .into_any_element()
        } else {
            div().into_any_element()
        };
        v_flex()
            .w(DETAIL_OUTLINE_WIDTH)
            .h_full()
            .flex_shrink_0()
            .border_l_1()
            .border_color(theme.border)
            .bg(theme.background)
            .p(SPACE_SM)
            .gap(SPACE_SM)
            .child(toolbar)
            .child(search_controls)
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scrollbar()
                    .children(rows),
            )
            .into_any_element()
    }

    fn render_detail(&self, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let Some(detail) = &self.detail else {
            return v_flex()
                .flex_1()
                .h_full()
                .items_center()
                .justify_center()
                .bg(theme.background)
                .child(empty_state_card(
                    "icons/message-square.svg",
                    px(58.),
                    px(26.),
                    t("No session selected"),
                    crate::tf!(
                        "Pick one from the list, or press {} to search.",
                        search_key_hint()
                    ),
                    cx,
                ))
                .into_any_element();
        };
        let meta = &detail.meta;
        let session_id = meta.id.clone();
        let session_key = meta.key.clone();
        let session_title = meta.title.clone();
        let session_project = meta.project_path.clone();
        let current_tags = detail.tags.clone();
        let export_entity = cx.entity();
        let copy_path_entity = export_entity.clone();
        let reveal_entity = export_entity.clone();
        let delete_entity = export_entity.clone();
        let tag_entity = export_entity.clone();
        let relation_entity = export_entity.clone();
        let pending_link_parent = self.pending_link_parent.clone();
        let pending_link_child = self.pending_link_child.clone();
        let has_pending_relationship = pending_link_parent.is_some();
        let link_parent_tree = detail.link_parent_tree.clone();
        let link_child_tree = detail.link_child_tree.clone();
        let danger_color = theme.danger;
        let tag_menu = Button::new("tag-actions")
            .ghost()
            .rounded(RADIUS_BUTTON)
            .icon(icon("icons/tag.svg").with_size(px(16.)))
            .tooltip("标签")
            .dropdown_menu(move |menu, _, _| {
                SESSION_TAGS.iter().fold(menu.min_w(px(180.)), |menu, tag| {
                    let entity = tag_entity.clone();
                    menu.item(
                        PopupMenuItem::new(format!(" {}", session_tag_label(tag)))
                            .icon(icon("icons/tag.svg").with_size(px(15.)))
                            .checked(current_tags.contains(*tag))
                            .on_click(move |_, window, cx| {
                                entity.update(cx, |this, cx| {
                                    this.toggle_session_tag(tag, window, cx);
                                });
                            }),
                    )
                })
            })
            .anchor(Anchor::TopRight);
        let relation_menu = Button::new("relation-actions")
            .ghost()
            .rounded(RADIUS_BUTTON)
            .icon(icon("icons/git-branch.svg").with_size(px(16.)))
            .tooltip("关系")
            .dropdown_menu(move |menu, _, _| {
                let menu = menu.min_w(px(220.)).item(
                    PopupMenuItem::new(" 选择连接会话")
                        .icon(icon("icons/git-branch.svg").with_size(px(15.)))
                        .on_click({
                            let entity = relation_entity.clone();
                            move |_, window, cx| {
                                entity.update(cx, |this, cx| {
                                    this.mark_relationship_parent(window, cx);
                                });
                            }
                        }),
                );
                if let (Some((_parent_key, parent_title)), Some((_child_key, child_title))) =
                    (pending_link_parent.clone(), pending_link_child.clone())
                {
                    let parent = clip_display(&parent_title, 12);
                    let child = clip_display(&child_title, 12);
                    SESSION_RELATIONS.iter().fold(
                        menu.separator().item(
                            PopupMenuItem::new(format!("{} → {}", parent, child)).disabled(true),
                        ),
                        |menu, relation| {
                            let entity = relation_entity.clone();
                            menu.item(
                                PopupMenuItem::new(format!(
                                    " 设为{}",
                                    session_relation_label(relation)
                                ))
                                .icon(icon("icons/link.svg").with_size(px(15.)))
                                .on_click(move |_, window, cx| {
                                    entity.update(cx, |this, cx| {
                                        this.connect_pending_relationship(relation, window, cx);
                                    });
                                }),
                            )
                        },
                    )
                } else {
                    menu
                }
                .when(has_pending_relationship, |menu| {
                    let entity = relation_entity.clone();
                    menu.separator().item(
                        PopupMenuItem::new(" 取消连接选择")
                            .icon(icon("icons/close.svg").with_size(px(15.)))
                            .on_click(move |_, _window, cx| {
                                entity.update(cx, |this, cx| {
                                    this.cancel_pending_relationship(cx);
                                });
                            }),
                    )
                })
                .separator()
                .item(PopupMenuItem::new("上游").disabled(true))
                .map(|menu| {
                    if link_parent_tree.is_empty() {
                        menu.item(PopupMenuItem::new(" 暂无上游").disabled(true))
                    } else {
                        link_parent_tree.iter().fold(menu, |menu, rel| {
                            let entity = relation_entity.clone();
                            let key = rel.session.key.clone();
                            let indent = "  ".repeat(rel.depth.saturating_sub(1));
                            menu.item(
                                PopupMenuItem::new(format!(
                                    " {}↳ {} · {}",
                                    indent,
                                    session_relation_label(&rel.relation),
                                    clip_display(&rel.session.title, 24)
                                ))
                                .icon(icon("icons/git-branch.svg").with_size(px(15.)))
                                .on_click(move |_, window, cx| {
                                    entity.update(cx, |this, cx| {
                                        this.open_detail(&key, None, window, cx);
                                    });
                                }),
                            )
                        })
                    }
                })
                .separator()
                .item(PopupMenuItem::new("分支").disabled(true))
                .map(|menu| {
                    if link_child_tree.is_empty() {
                        menu.item(PopupMenuItem::new(" 暂无分支").disabled(true))
                    } else {
                        link_child_tree.iter().fold(menu, |menu, rel| {
                            let entity = relation_entity.clone();
                            let key = rel.session.key.clone();
                            let indent = "  ".repeat(rel.depth.saturating_sub(1));
                            menu.item(
                                PopupMenuItem::new(format!(
                                    " {}↳ {} · {}",
                                    indent,
                                    session_relation_label(&rel.relation),
                                    clip_display(&rel.session.title, 24)
                                ))
                                .icon(icon("icons/link.svg").with_size(px(15.)))
                                .on_click(move |_, window, cx| {
                                    entity.update(cx, |this, cx| {
                                        this.open_detail(&key, None, window, cx);
                                    });
                                }),
                            )
                        })
                    }
                })
            })
            .anchor(Anchor::TopRight);
        // 远程会话只读:Delete 项整个不出现(阶段 1 不做远程删除——本地能
        // trash 的只有缓存副本,下次 rsync 就复活,语义是骗人的)
        let menu_is_remote = !meta.host.is_empty() || self.cleanup.open;
        let more_menu = Button::new("more-actions")
            .ghost()
            .rounded(RADIUS_BUTTON)
            .icon(icon("icons/more-horizontal.svg").with_size(px(16.)))
            .dropdown_menu(move |menu, window, cx| {
                let copy_path_entity = copy_path_entity.clone();
                let export_entity = export_entity.clone();
                let conversation_entity = export_entity.clone();
                let thinking_entity = export_entity.clone();
                let changes_entity = export_entity.clone();
                let compressed_export_entity = export_entity.clone();
                let memory_compressed_export_entity = export_entity.clone();
                let chunk_input_entity = export_entity.clone();
                let delete_entity = delete_entity.clone();
                let session_id_for_copy = session_id.clone();
                let session_key_for_copy = session_key.clone();
                let session_title_for_copy = session_title.clone();
                let session_project_for_copy = session_project.clone();
                let mut menu = menu
                    .min_w(px(210.))
                    .submenu_with_icon(
                        Some(icon("icons/copy.svg").with_size(px(15.))),
                        "复制",
                        window,
                        cx,
                        move |menu, _, _| {
                            let copy_path_entity = copy_path_entity.clone();
                            let id = session_id_for_copy.clone();
                            let key = session_key_for_copy.clone();
                            let title = session_title_for_copy.clone();
                            menu.min_w(px(210.))
                                .item(PopupMenuItem::new("复制会话路径").on_click({
                                    let entity = copy_path_entity.clone();
                                    move |_, _, cx| {
                                        entity.update(cx, |this, cx| {
                                            this.copy_session_path(cx);
                                        });
                                    }
                                }))
                                .item(PopupMenuItem::new(t(" Copy Session ID")).on_click(
                                    move |_, _, cx| {
                                        cx.write_to_clipboard(ClipboardItem::new_string(
                                            id.clone(),
                                        ));
                                    },
                                ))
                                .item(PopupMenuItem::new(t(" Copy Handoff")).on_click({
                                    let project = session_project_for_copy.clone();
                                    move |_, _, cx| {
                                        let cli = wake_core::mcp::sibling_file("contextos-cli");
                                        cx.write_to_clipboard(ClipboardItem::new_string(
                                            wake_core::cli::handoff_text(
                                                &key,
                                                &title,
                                                Some(project.as_str()),
                                                cli.as_deref(),
                                            ),
                                        ));
                                    }
                                }))
                        },
                    )
                    .submenu_with_icon(
                        Some(icon("icons/download.svg").with_size(px(15.))),
                        "导出",
                        window,
                        cx,
                        move |menu, _, _| {
                            menu.min_w(px(250.))
                                .item(PopupMenuItem::new("导出为 Markdown").on_click({
                                    let entity = export_entity.clone();
                                    move |_, window, cx| {
                                        entity.update(cx, |this, cx| {
                                            this.do_export(window, cx);
                                        });
                                    }
                                }))
                                .item(PopupMenuItem::new("导出对话").on_click({
                                    let entity = conversation_entity.clone();
                                    move |_, window, cx| {
                                        entity.update(cx, |this, cx| {
                                            this.do_conversation_export(false, window, cx);
                                        });
                                    }
                                }))
                                .item(PopupMenuItem::new("导出包含 Thinking 的对话").on_click({
                                    let entity = thinking_entity.clone();
                                    move |_, window, cx| {
                                        entity.update(cx, |this, cx| {
                                            this.do_conversation_export(true, window, cx);
                                        });
                                    }
                                }))
                                .item(PopupMenuItem::new("导出仅改动文件").on_click({
                                    let entity = changes_entity.clone();
                                    move |_, window, cx| {
                                        entity.update(cx, |this, cx| {
                                            this.do_changed_files_export(window, cx);
                                        });
                                    }
                                }))
                        },
                    )
                    .submenu_with_icon(
                        Some(icon("icons/file-text.svg").with_size(px(15.))),
                        "压缩",
                        window,
                        cx,
                        move |menu, _, _| {
                            menu.min_w(px(230.))
                                .item(PopupMenuItem::new("压缩导出").on_click({
                                    let entity = compressed_export_entity.clone();
                                    move |_, window, cx| {
                                        entity.update(cx, |this, cx| {
                                            this.do_compressed_export(window, cx);
                                        });
                                    }
                                }))
                                .item(PopupMenuItem::new("压缩并生成记忆").on_click({
                                    let entity = memory_compressed_export_entity.clone();
                                    move |_, window, cx| {
                                        entity.update(cx, |this, cx| {
                                            this.do_memory_compressed_export(window, cx);
                                        });
                                    }
                                }))
                                .item(PopupMenuItem::new("分块输入（长对话）").on_click({
                                    let entity = chunk_input_entity.clone();
                                    move |_, window, cx| {
                                        entity.update(cx, |this, cx| {
                                            this.open_single_chunk_input(window, cx);
                                        });
                                    }
                                }))
                        },
                    );
                if !menu_is_remote {
                    menu = menu.separator().item(
                        PopupMenuItem::element(move |_, _cx| {
                            div().text_color(danger_color).child(move_to_trash())
                        })
                        .icon(
                            icon("icons/trash-2.svg")
                                .with_size(px(15.))
                                .text_color(danger_color),
                        )
                        .on_click(move |_, window, cx| {
                            delete_entity.update(cx, |this, cx| {
                                this.confirm_delete(window, cx);
                            });
                        }),
                    );
                }
                menu
            })
            .anchor(Anchor::TopRight);

        let detail_path: SharedString = if meta.project_path.is_empty() {
            t("Unknown project").to_string()
        } else {
            meta.project_path.clone()
        }
        .into();
        let mut detail_facts: Vec<String> = Vec::new();
        if meta.message_count > 0 {
            detail_facts.push(crate::tf!("{} messages", meta.message_count));
        }
        if let Some(tokens) = meta.tokens_used {
            detail_facts.push(crate::tf!("{} tokens", fmt_tokens(Some(tokens))));
        }
        if detail.link_parent_count > 0 || detail.link_child_count > 0 {
            let mut parts = Vec::new();
            if detail.link_parent_count > 0 {
                parts.push(crate::tf!("{} 上游", detail.link_parent_count));
            }
            if detail.link_child_count > 0 {
                parts.push(crate::tf!("{} 分支", detail.link_child_count));
            }
            detail_facts.push(crate::tf!("关系：{}", parts.join(" · ")));
        }
        let has_detail_facts = !detail_facts.is_empty();
        let detail_fact_line: SharedString = detail_facts.join(" · ").into();
        let created_time: Option<(SharedString, SharedString)> = (meta.created_at > 0).then(|| {
            (
                crate::tf!("Created {}", smart_time(meta.created_at)).into(),
                crate::tf!("Created {}", abs_date(meta.created_at)).into(),
            )
        });
        let updated_at = self
            .cleanup_preview()
            .map_or(meta.updated_at, |c| c.updated_at);
        let updated_time: Option<(SharedString, SharedString)> = (updated_at > 0).then(|| {
            (
                crate::tf!("Updated {}", smart_time(updated_at)).into(),
                crate::tf!("Updated {}", abs_date(updated_at)).into(),
            )
        });
        let branch: Option<SharedString> =
            visible_git_branch(meta.git_branch.as_deref()).map(|branch| branch.to_string().into());
        let mut shown_tags = detail.tags.iter().cloned().collect::<Vec<_>>();
        shown_tags.sort();

        let project_badge = project_badge(
            "detail-project",
            &meta.project_path,
            meta.project_name.clone(),
            theme,
        );
        let mut lead: Vec<AnyElement> = Vec::new();
        if self.cleanup.open {
            lead.push(
                Button::new("cleanup-back")
                    .ghost()
                    .h(px(28.))
                    .px(SPACE_SM)
                    .text_size(FONT_CAPTION)
                    .rounded(RADIUS_BUTTON)
                    .icon(icon("icons/chevron-left.svg").with_size(px(15.)))
                    .label(t("Back"))
                    .tooltip(t("Back to cleanup list"))
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.close_cleanup_preview(window, cx);
                    }))
                    .into_any_element(),
            );
        }
        lead.push(
            img(meta.agent.brand_icon(theme.mode.is_dark()))
                .size(px(15.))
                .flex_shrink_0()
                .into_any_element(),
        );
        lead.push(
            div()
                .flex_shrink_0()
                .child(meta.agent.display_name())
                .into_any_element(),
        );
        lead.push(project_badge);
        if let Some(branch) = branch {
            lead.push(
                h_flex()
                    .min_w_0()
                    .gap(ICON_TEXT_GAP)
                    .child(
                        icon("icons/git-branch.svg")
                            .with_size(px(11.))
                            .flex_shrink_0(),
                    )
                    .child(div().min_w_0().truncate().child(branch))
                    .into_any_element(),
            );
        }
        let open_in: AnyElement = if terminal::resume_targets(meta).is_empty() {
            // 没有 resume 形制的 agent(OpenClaw 的 TUI 只按 session
            // key 开会话):不画 Open In,别给一组点了才报错的死按钮
            div().into_any_element()
        } else if let [terminal::ResumeTarget::CopySshCommand] =
            terminal::resume_targets(meta).as_slice()
        {
            // 远程会话(阶段 1 只有 Copy SSH command):单段控件用
            // 现成 Button,无 chevron 无记忆(split 按钮手搓只因它
            // 要双段共壳)。本地会话即便只剩一个终端也走 split
            // 按钮,品牌图标与 per-agent 记忆不丢
            crate::settings::settings_button(Button::new("open-in-single"), cx)
                .h(px(28.))
                .icon(icon("icons/terminal.svg").with_size(px(13.)))
                .label(t("Copy SSH command"))
                .tooltip(t(
                    "Copy the SSH command that resumes this session on its host",
                ))
                .on_click(cx.listener(|this, _, window, cx| {
                    this.do_resume(terminal::ResumeTarget::CopySshCommand, false, window, cx);
                }))
                .into_any_element()
        } else {
            // Open In split 按钮(Codex/kooky 风):左段 = 上次
            // 目标的应用图标,点击直开;右段 chevron 展开列表。
            // 目标列表按 agent 过滤(Kooky 深链不认 dsh);
            // 偏好目标不在列表时(如 dsh 会话 + 偏好 Kooky)回退首项
            let terms: Vec<terminal::TerminalApp> = terminal::resume_targets(meta)
                .into_iter()
                .filter_map(|t| match t {
                    terminal::ResumeTarget::App(app) => Some(app),
                    _ => None,
                })
                .collect();
            let current = self.open_in_target(meta.agent, &terms);
            let current_icon = current.and_then(|t| self.terminal_icons.get(t.id()).cloned());
            let term_items: Vec<(terminal::TerminalApp, Option<PathBuf>)> = terms
                .iter()
                .map(|t| (*t, self.terminal_icons.get(t.id()).cloned()))
                .collect();
            let menu_entity = cx.entity();
            // 无常显分隔线,hover 分段高亮暗示两段(Codex 同款);
            // 右段 Button 用 custom variant 与左段 hover 完全一致
            h_flex()
                .h(px(28.))
                .rounded(RADIUS_BUTTON)
                .border_1()
                .border_color(theme.border)
                .bg(theme.secondary)
                .overflow_hidden()
                .child(
                    div()
                        .id("open-in-main")
                        .h_full()
                        .px(px(7.))
                        .flex()
                        .items_center()
                        .cursor_pointer()
                        .hover(|s| s.bg(theme.secondary_hover))
                        .active(|s| s.bg(theme.secondary_active))
                        .child(open_in_icon(
                            current,
                            current_icon.as_ref(),
                            icon("icons/terminal.svg")
                                .with_size(px(13.))
                                .text_color(theme.secondary_foreground),
                        ))
                        .tooltip({
                            let label: SharedString = match current {
                                Some(t) => {
                                    crate::tf!("Open this session in {}", t.display_name()).into()
                                }
                                None => t("Open this session").into(),
                            };
                            move |window, cx| {
                                gpui_component::tooltip::Tooltip::new(label.clone())
                                    .build(window, cx)
                            }
                        })
                        .on_click(cx.listener(move |this, _, window, cx| {
                            if let Some(term) = current {
                                this.do_resume(
                                    terminal::ResumeTarget::App(term),
                                    false,
                                    window,
                                    cx,
                                );
                            } else {
                                // 空列表在 macOS 不可能(Terminal.app 恒在),
                                // Windows/Linux 上 PATH 被启动器改写时会发生
                                // ——静默无操作是死按钮,至少说一声为什么
                                window.push_notification(
                                    Notification::warning(t(
                                        "No terminal application found on PATH",
                                    )),
                                    cx,
                                );
                            }
                        })),
                )
                .child(div().w(px(1.)).h_full().flex_shrink_0().bg(theme.border))
                .child(
                    Button::new("open-in-more")
                        .custom(
                            ButtonCustomVariant::new(cx)
                                .foreground(theme.muted_foreground)
                                .hover(theme.secondary_hover)
                                .active(theme.secondary_active),
                        )
                        .rounded(px(0.))
                        .h(px(26.))
                        .w(px(22.))
                        .icon(icon("icons/chevron-down.svg").with_size(px(12.)))
                        .tooltip(t("Open this session in…"))
                        .dropdown_menu(move |menu, _, _| {
                            let mut menu = menu.min_w(px(170.));
                            for (term, icon_path) in term_items.clone() {
                                let entity = menu_entity.clone();
                                menu = menu.item(
                                    PopupMenuItem::element(move |_, _| {
                                        h_flex()
                                            .gap(ICON_TEXT_GAP)
                                            .items_center()
                                            .child(open_in_icon(
                                                Some(term),
                                                icon_path.as_ref(),
                                                icon("icons/terminal.svg").with_size(px(15.)),
                                            ))
                                            .child(term.display_name())
                                    })
                                    .on_click(
                                        move |_, window, cx| {
                                            entity.update(cx, |this, cx| {
                                                this.do_resume(
                                                    terminal::ResumeTarget::App(term),
                                                    true,
                                                    window,
                                                    cx,
                                                );
                                            });
                                        },
                                    ),
                                );
                            }
                            menu
                        })
                        .anchor(Anchor::TopRight),
                )
                .into_any_element()
        };
        let reveal_button = Button::new("reveal-session")
            .ghost()
            .rounded(RADIUS_BUTTON)
            .icon(icon("icons/folder.svg").with_size(px(16.)))
            .tooltip(reveal_in_fm())
            .on_click(move |_, _, cx| {
                reveal_entity.update(cx, |this, _| {
                    if let Some(detail) = &this.detail {
                        terminal::reveal_in_file_manager(&detail.meta.file_path);
                    }
                });
            });
        let actions: Vec<AnyElement> = vec![
            open_in,
            reveal_button.into_any_element(),
            tool_btn(
                "fav",
                "icons/star.svg",
                "icons/star-filled.svg",
                rgb(crate::theme::STAR_YELLOW).into(),
                if meta.favorite {
                    t("Unstar")
                } else {
                    t("Star")
                },
                meta.favorite,
                cx.listener(|this, _, window, cx| this.toggle_favorite(window, cx)),
            )
            .into_any_element(),
            tool_btn(
                "pin",
                "icons/pin.svg",
                "icons/pin-filled.svg",
                theme.primary,
                if meta.pinned { t("Unpin") } else { t("Pin") },
                meta.pinned,
                cx.listener(|this, _, window, cx| this.toggle_pinned(window, cx)),
            )
            .into_any_element(),
            tag_menu.into_any_element(),
            relation_menu.into_any_element(),
            more_menu.into_any_element(),
        ];
        let mut meta_rows: Vec<AnyElement> = vec![
            h_flex()
                .w_full()
                .min_w_0()
                .gap(SPACE_MD)
                .items_center()
                .when_some(meta.model.clone(), |this, model| {
                    this.child(outline_badge(
                        model,
                        rgb(crate::theme::MODEL_BADGE_BG).into(),
                    ))
                })
                .when_some(
                    meta.source.clone().filter(|s| !s.is_empty()),
                    |this, source| {
                        let color = if source == "opencode2" {
                            theme.primary
                        } else {
                            theme.success
                        };
                        this.child(outline_badge(source, color))
                    },
                )
                .when(!meta.host.is_empty(), |this| {
                    // 详情页保持 model/source 同排的描边形态,色相与列表行的 host
                    // 胶囊一致(primary);muted 描边用户否决 2026-09-03
                    this.child(outline_badge(format!("@{}", meta.host), theme.primary))
                })
                .children(shown_tags.into_iter().map(|tag| {
                    outline_badge(format!("#{}", session_tag_label(&tag)), theme.primary)
                        .into_any_element()
                }))
                .when(has_detail_facts, |this| {
                    this.child(div().flex_1().min_w_0().truncate().child(detail_fact_line))
                })
                .into_any_element(),
            h_flex()
                .min_w_0()
                .gap(ICON_TEXT_GAP)
                .child(icon("icons/folder.svg").with_size(px(12.)).flex_shrink_0())
                .child(div().min_w_0().truncate().child(detail_path))
                .into_any_element(),
        ];
        if self.cleanup.open {
            meta_rows.push(self.render_cleanup_detail_facts(cx));
        }
        if created_time.is_some() || updated_time.is_some() {
            meta_rows.push(
                h_flex()
                    .w_full()
                    .min_w_0()
                    .gap(ICON_TEXT_GAP)
                    .items_center()
                    .child(
                        icon("icons/calendar.svg")
                            .with_size(px(12.))
                            .flex_shrink_0(),
                    )
                    .child(
                        h_flex()
                            .min_w_0()
                            .gap(SPACE_MD)
                            .when_some(created_time.clone(), |row, (created, tooltip)| {
                                row.child(
                                    div()
                                        .id("detail-created-time")
                                        .min_w_0()
                                        .truncate()
                                        .child(created)
                                        .tooltip(move |window, cx| {
                                            gpui_component::tooltip::Tooltip::new(tooltip.clone())
                                                .build(window, cx)
                                        }),
                                )
                            })
                            .when(created_time.is_some() && updated_time.is_some(), |row| {
                                row.child(div().flex_shrink_0().text_color(theme.border).child("·"))
                            })
                            .when_some(updated_time.clone(), |row, (updated, tooltip)| {
                                row.child(
                                    div()
                                        .id("detail-updated-time")
                                        .flex_shrink_0()
                                        .child(updated)
                                        .tooltip(move |window, cx| {
                                            gpui_component::tooltip::Tooltip::new(tooltip.clone())
                                                .build(window, cx)
                                        }),
                                )
                            }),
                    )
                    .into_any_element(),
            );
        }

        v_flex()
            .flex_1()
            .min_w_0()
            .h_full()
            .bg(theme.background)
            .child(detail_header_frame(
                "detail-header",
                lead,
                actions,
                meta.title.clone().into(),
                meta_rows,
                theme,
            ))
            .child(if detail.loading {
                h_flex()
                    .flex_1()
                    .bg(theme.popover)
                    .items_center()
                    .justify_center()
                    .gap(ICON_TEXT_GAP)
                    .text_color(theme.muted_foreground)
                    .child(Spinner::new().small())
                    .child(div().text_size(FONT_BODY).child(t("Loading session…")))
                    .into_any_element()
            } else if let Some(error) = detail.error.clone() {
                let reveal_path = meta.file_path.clone();
                v_flex()
                    .flex_1()
                    .bg(theme.popover)
                    .items_center()
                    .justify_center()
                    .px(SPACE_XXL)
                    .child(
                        v_flex()
                            .w_full()
                            .max_w(px(520.))
                            .items_center()
                            .gap(SPACE_MD)
                            .child(
                                icon("icons/circle-x.svg")
                                    .with_size(px(24.))
                                    .text_color(theme.danger),
                            )
                            .child(
                                div()
                                    .text_size(FONT_HEADING)
                                    .font_semibold()
                                    .text_color(theme.foreground)
                                    .child(t("Couldn't load this session")),
                            )
                            .child(
                                div()
                                    .w_full()
                                    .whitespace_normal()
                                    .text_center()
                                    .text_size(FONT_CAPTION)
                                    .text_color(theme.muted_foreground)
                                    .child(error),
                            )
                            .child(
                                Button::new("reveal-failed-session")
                                    .outline()
                                    .small()
                                    .rounded(RADIUS_BUTTON)
                                    .icon(icon("icons/folder.svg").with_size(px(13.)))
                                    .label(reveal_in_fm())
                                    .on_click(move |_, _, _| {
                                        terminal::reveal_in_file_manager(&reveal_path)
                                    }),
                            ),
                    )
                    .into_any_element()
            } else {
                let entity = cx.entity().downgrade();
                div()
                    .flex_1()
                    .min_h_0()
                    .bg(theme.popover)
                    .relative()
                    .child(
                        gpui::list(detail.msg_list.clone(), move |ix, window, cx| {
                            entity
                                .upgrade()
                                .map(|e| {
                                    e.update(cx, |this, cx| this.render_msg_row(ix, window, cx))
                                })
                                .unwrap_or_else(|| div().into_any_element())
                        })
                        .size_full(),
                    )
                    .vertical_scrollbar(&detail.msg_list)
                    .into_any_element()
            })
            .into_any_element()
    }
}

/// 侧栏组头(Agents / Projects):行首是 15px 折叠 chevron(收起指右、展开指下;与导航行
/// 图标同一档,描边粗细才一致),中心压 26.75 轴(用户 2026-09-22 定"箭头放到开头,对准
/// 上面菜单的 icon 和红绿灯的红灯";原先 chevron 跟在文字后,靠首字母字形宽度反推的
/// GROUP_HEAD_INSET 压轴,字号 / 字重 / 语言一变就失效)
fn group_header(
    id: &'static str,
    text: &'static str,
    collapsed: bool,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    cx: &Context<Workbench>,
) -> Stateful<Div> {
    let theme = cx.theme();
    div()
        .id(id)
        .flex_shrink_0()
        // chevron 不占 18px 槽位、只按自己的框居中压轴:槽位居中再接统一间距,墨迹到
        // 文字会比导航行空出一截(chevron 墨迹只有约 5px 宽,用户 2026-09-22 "间隔太大");
        // 按框压轴后文字起点比导航行标签左 1.5px,墨迹到文字视觉约 10.9px、与导航行相当
        .pl(LEAD_INSET + (LEAD_BOX - NAV_ICON) / 2.)
        .pr(SIDEBAR_EDGE)
        .pt(SPACE_MD)
        .pb(SPACE_XS)
        .cursor_pointer()
        .active(|s| s.opacity(0.7))
        .on_click(on_click)
        .child(
            h_flex()
                .gap(ICON_TEXT_GAP)
                // 与主导航行同字号同字重(FONT_BODY / 常规),仅靠 muted 色区分——
                // 加粗会让组头压过它统辖的行
                .text_size(FONT_BODY)
                .text_color(theme.muted_foreground)
                .hover(|s| s.text_colored(theme.foreground, FONT_BODY))
                .child(
                    icon("icons/chevron-right.svg")
                        .with_size(NAV_ICON)
                        .flex_shrink_0()
                        .when(!collapsed, |ic| {
                            ic.rotate(gpui::Radians(std::f32::consts::FRAC_PI_2))
                        }),
                )
                .child(text),
        )
}

/// 侧栏行层级:Primary=固定主导航(32px/FONT_BODY),Sub=分组展开项(26px/FONT_CAPTION)。
/// 行首元素一律对齐同一条中轴(见 ui.rs LEAD_BOX),子级不再缩进——
/// 行高与字号是仅剩的层级来源,禁止把子级行改回主导航尺度。
#[derive(Clone, Copy, PartialEq)]
enum RowLevel {
    Primary,
    Sub,
}

/// 侧栏行首元素——每行必须有一个,槽位定宽,保证同组文字起点对齐。
/// Lucide 图标随选中态着色;品牌 PNG 保留原色不着色。
enum RowLead {
    None,
    Icon(Icon),
    /// Agent 品牌图标,取 `AgentId::brand_icon()`
    Brand(&'static str),
}

// ---------------- Insights 附件 ----------------

/// 可切换区块共用的 ‹ › ghost 按钮组。label 显示在两键中间(当前档位名),
/// 定宽居中让按钮位置不随文本长短跳动;分布图的档位名就是区块标题,传 None
fn insight_arrows(
    id: &'static str,
    label: Option<SharedString>,
    on_prev: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    on_next: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    cx: &App,
) -> impl IntoElement {
    let theme = cx.theme();
    h_flex()
        .flex_shrink_0()
        .gap(SPACE_XS)
        .child(
            Button::new((id, 0usize))
                .ghost()
                .rounded(RADIUS_BUTTON)
                .icon(icon("icons/chevron-left.svg").with_size(px(14.)))
                .tooltip(t("Previous view"))
                .on_click(on_prev),
        )
        .when_some(label, |row, label| {
            row.child(
                div()
                    .w(px(64.))
                    .flex()
                    .justify_center()
                    .whitespace_nowrap()
                    .text_size(FONT_CAPTION)
                    .text_color(theme.muted_foreground)
                    .child(label),
            )
        })
        .child(
            Button::new((id, 1usize))
                .ghost()
                .rounded(RADIUS_BUTTON)
                .icon(icon("icons/chevron-right.svg").with_size(px(14.)))
                .tooltip(t("Next view"))
                .on_click(on_next),
        )
}

/// Insights 区块头:标题 + 可选 caption + 可选右上角切换按钮组。
/// caption 有则双行(按钮对齐首行),无则单行居中对齐
fn switch_section_head(
    title: &'static str,
    caption: Option<SharedString>,
    arrows: Option<AnyElement>,
    cx: &App,
) -> impl IntoElement {
    let theme = cx.theme();
    let two_line = caption.is_some();
    h_flex()
        .justify_between()
        .map(|head| {
            if two_line {
                head.items_start()
            } else {
                head.items_center()
            }
        })
        .child(
            v_flex()
                .gap(px(2.))
                .child(
                    div()
                        .text_size(FONT_BODY)
                        .font_semibold()
                        .text_color(theme.foreground)
                        .child(title),
                )
                .when_some(caption, |head, caption| {
                    head.child(
                        div()
                            .text_size(FONT_CAPTION)
                            .text_color(theme.muted_foreground)
                            .child(caption),
                    )
                }),
        )
        .when_some(arrows, |head, arrows| head.child(arrows))
}

/// 榜单行:行首 + 名称 + 轨道条 + 计数。value_text 与 count 分开传:
/// Tokens 档显示 "1.2M" 缩写,条仍按原值归一
fn usage_bar_row(
    lead: Option<AnyElement>,
    label: SharedString,
    value_text: SharedString,
    count: i64,
    max: i64,
    name_w: Pixels,
    board: UsageBoard,
    on_click: Option<impl Fn(&mut Workbench, &mut Window, &mut Context<Workbench>) + 'static>,
    tooltip: Option<String>,
    cx: &Context<Workbench>,
) -> AnyElement {
    let theme = cx.theme();
    let frac = (count as f32 / max.max(1) as f32).clamp(0., 1.);
    let row = h_flex()
        .h(SPACE_XXL)
        .gap(ICON_TEXT_GAP)
        .items_center()
        .when_some(lead, |row, lead| {
            row.child(
                div()
                    .w(px(15.))
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(lead),
            )
        })
        .child(
            div()
                .w(name_w)
                .flex_shrink_0()
                .min_w_0()
                .text_size(FONT_CAPTION)
                .text_color(theme.foreground)
                .truncate()
                .child(label.clone()),
        )
        .child(
            div()
                .flex_1()
                .h(px(6.))
                .rounded_full()
                .bg(theme.muted)
                .child(
                    div()
                        .h_full()
                        .w(relative(frac))
                        .rounded_full()
                        .bg(theme.primary),
                ),
        )
        .child(
            div()
                .w(px(56.))
                .flex_shrink_0()
                .flex()
                .justify_end()
                .text_size(FONT_LABEL)
                .text_color(theme.muted_foreground)
                .child(value_text),
        );
    match on_click {
        // 可点的行包一层交互壳:hover 出底色 + 手势光标,与侧栏行同语言
        Some(on_click) => div()
            .id(SharedString::from(format!(
                "usage-{}-{}",
                board.id(),
                label
            )))
            .w_full()
            .cursor_pointer()
            .hover(|style| style.bg(theme.muted).rounded(RADIUS_BUTTON))
            .when_some(tooltip, |row, tooltip| {
                row.tooltip(move |window, cx| {
                    gpui_component::tooltip::Tooltip::new(tooltip.clone()).build(window, cx)
                })
            })
            .on_click(cx.listener(move |this, _, window, cx| on_click(this, window, cx)))
            .child(row)
            .into_any_element(),
        None => row.into_any_element(),
    }
}

fn prompts_label(n: i64) -> String {
    match n {
        0 => t("No prompts").into(),
        // 千分位要按 n 自己格式化,故不走 tp! 的「计数即首参」约定
        n => crate::i18n::tp("{} prompt", "{} prompts", n, &[&thousands(n)]),
    }
}

/// 0–23 时 → "12 AM" / "2 PM" 形制(与 smart_time 的 12 小时制一致)
fn hour_label(h: usize) -> String {
    match h % 24 {
        0 => t("12 AM").into(),
        12 => t("12 PM").into(),
        h if h < 12 => crate::tf!("{} AM", h),
        h => crate::tf!("{} PM", h - 12),
    }
}

// 译文表要到运行时才知道,四张名表因此是函数而非 const;调用点每次取一份
// 数组(7/12 个 &'static str 的拷贝,栈上,比查一次表还便宜)
fn dow_short() -> [&'static str; 7] {
    [
        t("Mon"),
        t("Tue"),
        t("Wed"),
        t("Thu"),
        t("Fri"),
        t("Sat"),
        t("Sun"),
    ]
}
fn dow_plural() -> [&'static str; 7] {
    [
        t("Mondays"),
        t("Tuesdays"),
        t("Wednesdays"),
        t("Thursdays"),
        t("Fridays"),
        t("Saturdays"),
        t("Sundays"),
    ]
}
/// 月份名从 chrono 派生。`%b`/`%B` 的译文本来就在给 smart_time 与 Insights
/// 副标题用(format.rs、`session_group_label`),再单列 Jan…December 24 条就是
/// 同一批词的第二份真相——写这版时 zh 包已经漂成「4月」与「4 月」两种写法。
/// **调用点务必提到循环外**:每次调用是 12 次查表加 12 次日期格式化
fn month_names(pattern: &'static str) -> [SharedString; 12] {
    std::array::from_fn(|m| {
        chrono::NaiveDate::from_ymd_opt(2000, m as u32 + 1, 1)
            .expect("1..=12 是合法月份")
            .format(t(pattern))
            .to_string()
            .into()
    })
}
fn month_short() -> [SharedString; 12] {
    month_names("%b")
}
fn month_full() -> [SharedString; 12] {
    month_names("%B")
}

/// peak 由 render_distribution_section 算一次传入——caption 点名的与
/// 图里高亮的必须是同一根柱
fn dist_caption(range: InsightsRange, peak: usize, peak_n: i64) -> String {
    if peak_n == 0 {
        return t("When you talk to your agents").into();
    }
    match range {
        InsightsRange::Hour => crate::tf!("Most active around {}", hour_label(peak)),
        InsightsRange::Weekday => crate::tf!("Most active on {}", dow_plural()[peak]),
        InsightsRange::Month => crate::tf!("Most active in {}", month_full()[peak]),
    }
}

/// 该月天数(1..=31)。月末日期由选中日反推,不查表:先跳到下月 1 号再回退一天
fn days_in_month(day: chrono::NaiveDate) -> u32 {
    use chrono::Datelike as _;
    let first = day.with_day(1).unwrap_or(day);
    let next = if first.month() == 12 {
        chrono::NaiveDate::from_ymd_opt(first.year() + 1, 1, 1)
    } else {
        chrono::NaiveDate::from_ymd_opt(first.year(), first.month() + 1, 1)
    };
    next.and_then(|n| n.pred_opt())
        .map(|last| last.day())
        .unwrap_or(31)
}

/// 选中日所在周(周一起始)的 7 天,供周期模式的轴标签与 tooltip 用
fn week_days_of(day: chrono::NaiveDate) -> impl Iterator<Item = chrono::NaiveDate> {
    use chrono::Datelike as _;
    let monday = day - chrono::Duration::days(day.weekday().num_days_from_monday() as i64);
    (0..7).map(move |i| monday + chrono::Days::new(i))
}

/// 选中日所在月的每一天(1 号起),供周期模式的轴标签与 tooltip 用
fn month_days_of(day: chrono::NaiveDate) -> impl Iterator<Item = chrono::NaiveDate> {
    let first = day.with_day(1).unwrap_or(day);
    (0..days_in_month(day) as u64).map(move |i| first + chrono::Days::new(i))
}

/// 选中某天时三档分布的副标题:先点名周期(Hour 档说哪天、Weekday 档说哪周、
/// Month 档说哪月),再报该周期内的峰值——不然单说"最常在 2 PM"读者不知道
/// 说的是哪一天
fn dist_caption_scoped(
    range: InsightsRange,
    day: chrono::NaiveDate,
    peak: usize,
    peak_n: i64,
) -> String {
    use chrono::Datelike as _;
    let scope: String = match range {
        InsightsRange::Hour => day.format(t("%b %-d, %Y")).to_string(),
        InsightsRange::Weekday => {
            let monday = day - chrono::Duration::days(day.weekday().num_days_from_monday() as i64);
            let sunday = monday + chrono::Days::new(6);
            format!(
                "{} – {}",
                monday.format(t("%b %-d")),
                sunday.format(t("%b %-d"))
            )
        }
        InsightsRange::Month => day.format(t("%B %Y")).to_string(),
    };
    if peak_n == 0 {
        return crate::tf!("{} · no prompts", scope);
    }
    let where_peak: String = match range {
        InsightsRange::Hour => crate::tf!("Most active around {}", hour_label(peak)),
        InsightsRange::Weekday => crate::tf!("Most active on {}", dow_plural()[peak]),
        // 月档的峰值柱是"几号",直接报日期比报数字直观
        InsightsRange::Month => {
            let on = day.with_day(peak as u32 + 1).unwrap_or(day);
            crate::tf!("Most active on {}", on.format(t("%b %-d")))
        }
    };
    format!("{scope} · {where_peak}")
}

/// 竖柱分布图(hour 24 根 / weekday 7 根 / month 12 根 / 选中周期 7 或 28–31 根
/// 共用)。峰值柱全饱和 primary,其余 55%;零值留 2px muted 底座维持基线连续。
/// 宽柱配大缝:柱数越少 gap 越大,免得 7 根 90px 宽柱糊成一片。
/// `scoped_day` = 选中日:轴标签改标具体日期(周档标那 7 天、月档标几号),
/// 否则读图时无法与"哪一周/哪个月"对上
fn render_distribution(
    range: InsightsRange,
    values: &[i64],
    token_values: &[i64],
    peak: usize,
    scoped_day: Option<chrono::NaiveDate>,
    cx: &App,
) -> AnyElement {
    let theme = cx.theme();
    let max = values.iter().copied().max().unwrap_or(0).max(1);
    let gap = match range {
        InsightsRange::Hour => px(4.),
        InsightsRange::Weekday => px(8.),
        InsightsRange::Month => px(6.),
    };
    const CHART_H: f32 = 72.;
    // 两张名表在逐柱闭包**之外**取一次:闭包体每根柱跑一遍,放进去就是
    // 12 根柱 × 12 次查表(hour 档不用名表,空着)
    let long_names: Vec<SharedString> = match (range, scoped_day) {
        // 周期模式:tooltip 与刻度都标真实日期,周档给"10月13日"而非"周一"
        (InsightsRange::Weekday, Some(day)) => week_days_of(day)
            .map(|d| d.format(t("%b %-d")).to_string().into())
            .collect(),
        (InsightsRange::Month, Some(day)) => month_days_of(day)
            .map(|d| d.format(t("%b %-d")).to_string().into())
            .collect(),
        (InsightsRange::Hour, None) => Vec::new(),
        (InsightsRange::Weekday, None) => dow_plural().map(SharedString::from).into(),
        (InsightsRange::Month, None) => month_full().into(),
        // 小时档的展示名由 tooltip 里的 "12 AM – 1 AM" 现算,周期与否都一样
        (InsightsRange::Hour, Some(_)) => Vec::new(),
    };
    let tick_names: Vec<SharedString> = match (range, scoped_day) {
        (InsightsRange::Weekday, Some(_)) => dow_short().map(SharedString::from).into(),
        // 月档 31 根柱:刻度只标日期数字,全标会挤成一片
        (InsightsRange::Month, Some(_)) => (1..=values.len())
            .map(|d| SharedString::from(d.to_string()))
            .collect(),
        (InsightsRange::Hour, None) => Vec::new(),
        (InsightsRange::Hour, Some(_)) => Vec::new(),
        (InsightsRange::Weekday, None) => dow_short().map(SharedString::from).into(),
        (InsightsRange::Month, None) => month_short().into(),
    };
    v_flex()
        .gap(px(6.))
        .child(
            h_flex()
                .items_end()
                .gap(gap)
                .h(px(CHART_H))
                .children((0..values.len()).map(|i| {
                    let n = values[i];
                    let (height, bg) = if n == 0 {
                        (px(2.), theme.muted)
                    } else {
                        let frac = (n as f32 / max as f32).max(0.05);
                        (
                            px((frac * CHART_H).max(3.)),
                            if i == peak {
                                theme.primary
                            } else {
                                theme.primary.opacity(0.55)
                            },
                        )
                    };
                    let activity_label = match range {
                        InsightsRange::Hour => format!(
                            "{} · {} – {}",
                            prompts_label(n),
                            hour_label(i),
                            hour_label(i + 1)
                        ),
                        _ => format!("{} · {}", prompts_label(n), long_names[i]),
                    };
                    let label: SharedString = format!(
                        "{} · {} tokens",
                        activity_label,
                        fmt_tokens(Some(token_values.get(i).copied().unwrap_or(0)))
                    )
                    .into();
                    div()
                        .id(("dist", i))
                        .flex_1()
                        .h(height)
                        .rounded(RADIUS_CELL)
                        .bg(bg)
                        .tooltip(move |window, cx| {
                            gpui_component::tooltip::Tooltip::new(label.clone()).build(window, cx)
                        })
                })),
        )
        .child(
            // 刻度行:与柱同宽的等分槽。hour 只标 6 小时锚点(文字溢出槽宽
            // 不裁剪),weekday/month 每柱都标
            h_flex()
                .gap(gap)
                .text_size(FONT_LABEL)
                .text_color(theme.muted_foreground)
                .children((0..values.len()).map(|i| {
                    let tick = tick_names.get(i).cloned();
                    div().flex_1().whitespace_nowrap().map(|slot| match tick {
                        // 每柱都有标签时与柱居中;hour 的稀疏锚点靠左
                        Some(name) => slot.flex().justify_center().child(name),
                        None if i % 6 == 0 => slot.child(hour_label(i)),
                        None => slot,
                    })
                })),
        )
        .into_any_element()
}

/// 周格网格几何:热力图与趋势图共用——两图的周列必须上下对齐(DESIGN.md),
/// 改任何一个数都同时改两张图
const WEEK_CELL: f32 = 9.;
const WEEK_GAP: f32 = 3.;
const WEEK_STEP: f32 = WEEK_CELL + WEEK_GAP;
/// 热力图左侧星期标签列宽;趋势图同样留出这一列,周列才对齐
const DOW_W: f32 = 26.;

/// 月份刻度行:该列周一进入新月份时标注(与前一周比,首列同规则,相邻标签
/// 由此天然隔开 ≥4 列不会叠)。热力图与趋势图共用同一行
fn month_ticks(start: chrono::NaiveDate, cx: &App) -> Div {
    use chrono::Datelike as _;
    let theme = cx.theme();
    let mut months = div()
        .relative()
        .w_full()
        .h(px(14.))
        .text_size(FONT_LABEL)
        .text_color(theme.muted_foreground);
    let names = month_short();
    for c in 0..TREND_WEEKS as u64 {
        let monday = start + chrono::Days::new(c * 7);
        if monday.month() != (monday - chrono::Days::new(7)).month() {
            months = months.child(
                div()
                    .absolute()
                    .top_0()
                    .left(px(DOW_W + WEEK_GAP + c as f32 * WEEK_STEP))
                    .child(names[monday.month0() as usize].clone()),
            );
        }
    }
    months
}

/// Insights 大数字格:概览行(Title 22)与 Last 7 days(Heading 16)共用,
/// 后者多一行相对变化(note)
fn stat_cell(
    value: String,
    label: &'static str,
    size: Pixels,
    note: Option<(SharedString, Hsla)>,
    cx: &App,
) -> impl IntoElement {
    let theme = cx.theme();
    v_flex()
        .gap(px(2.))
        .child(
            div()
                .text_size(size)
                .font_semibold()
                .text_color(theme.foreground)
                .child(value),
        )
        .child(
            div()
                .text_size(FONT_CAPTION)
                .text_color(theme.muted_foreground)
                .child(label),
        )
        .when_some(note, |cell, (text, color)| {
            cell.child(div().text_size(FONT_LABEL).text_color(color).child(text))
        })
}

/// agent_id → 展示名。库里冒出未知 agent_id(降级防御)时裸名,比整行消失诚实
fn agent_label(raw: &str) -> SharedString {
    AgentId::from_str(raw)
        .map(|a| a.display_name().into())
        .unwrap_or_else(|| raw.to_string().into())
}

/// 榜单里一行 agent 的行首与名称:15px 品牌图 + 显示名。Agents 榜与 Agents asking
/// ContextOS 共用,"一行 agent 长什么样"只此一处
fn agent_row_head(name: &str, dark: bool) -> (Option<AnyElement>, SharedString) {
    (
        AgentId::from_str(name).map(|a| img(a.brand_icon(dark)).size(px(15.)).into_any_element()),
        agent_label(name),
    )
}

/// 趋势图堆叠的序列数上限:前五个按总量降序各自着 agent 品牌色(见 theme.rs),
/// 其余合并为 "Other" 用 muted_foreground 淡层
const TREND_TOP: usize = 5;

/// 趋势图的一层:名称、色、TREND_WEEKS 周值;`other` 是合并层(不参评领先者)
struct TrendLayer {
    name: SharedString,
    color: Hsla,
    weekly: Vec<i64>,
    other: bool,
}

/// series → 图层投影。caption、图例、柱子共用这一份:图例里没有的名字不会
/// 出现在 caption 里。Rc 让 53 个 tooltip 闭包只各持一个指针,hover 才格式化
fn trend_layers(series: &[TrendSeries], cx: &App) -> Rc<Vec<TrendLayer>> {
    let theme = cx.theme();
    let mut layers: Vec<TrendLayer> = series
        .iter()
        .take(TREND_TOP)
        .map(|s| {
            // agent 用品牌色;库里冒出未知 agent_id(降级防御)退备选色
            let hex = AgentId::from_str(&s.name)
                .map(crate::theme::agent_series_color)
                .unwrap_or(crate::theme::SERIES_FALLBACK);
            TrendLayer {
                name: agent_label(&s.name),
                color: rgb(hex).into(),
                weekly: s.weekly.clone(),
                other: false,
            }
        })
        .collect();
    if series.len() > TREND_TOP {
        let mut other = vec![0i64; TREND_WEEKS];
        for s in &series[TREND_TOP..] {
            for (o, n) in other.iter_mut().zip(&s.weekly) {
                *o += n;
            }
        }
        layers.push(TrendLayer {
            name: t("Other").into(),
            color: theme.muted_foreground.opacity(0.35),
            weekly: other,
            other: true,
        });
    }
    Rc::new(layers)
}

fn trend_caption(layers: &[TrendLayer]) -> String {
    // 本周领先者:as_of 所在周 prompts 最多的一层(本周为空则退回上一周)
    let leader = [TREND_WEEKS - 1, TREND_WEEKS - 2]
        .into_iter()
        .find_map(|w| {
            layers
                .iter()
                .filter(|l| !l.other && l.weekly[w] > 0)
                .max_by_key(|l| l.weekly[w])
                .map(|l| l.name.clone())
        });
    match leader {
        Some(name) => crate::tf!("Prompts per week by agent · {} leads this week", name),
        None => t("Prompts per week by agent").to_string(),
    }
}

/// 堆叠周柱图:TREND_WEEKS 列与热力图同宽同步距(左侧留出热力图的星期标签
/// 列,两图的周列上下对齐),每列 = 各层该周 prompts 自下而上堆叠,按窗口内
/// 峰值周归一;零周留 2px muted 基线。图例列出各层。
/// `selected_week` = 热力图选中日所在列:该列套一条贯穿图高的描边(画在与柱
/// 同宽的定高轨道上,而不是变高的柱本身——零周那根 2px 基线套不住描边)
fn render_trend(
    start: chrono::NaiveDate,
    layers: Rc<Vec<TrendLayer>>,
    weekly_tokens: &[i64],
    selected_week: Option<usize>,
    cx: &App,
) -> AnyElement {
    let theme = cx.theme();
    const CHART_H: f32 = 72.;
    let totals: Vec<i64> = (0..TREND_WEEKS)
        .map(|w| layers.iter().map(|l| l.weekly[w]).sum())
        .collect();
    let max = totals.iter().copied().max().unwrap_or(0).max(1);

    let mut columns = h_flex()
        .items_end()
        .gap(px(WEEK_GAP))
        .h(px(CHART_H))
        .child(div().w(px(DOW_W)).flex_shrink_0());
    for w in 0..TREND_WEEKS {
        let total = totals[w];
        let column = if total == 0 {
            div()
                .w(px(WEEK_CELL))
                .h(px(2.))
                .rounded(RADIUS_CELL)
                .bg(theme.muted)
        } else {
            let col_h = ((total as f32 / max as f32) * CHART_H).max(3.);
            // DOM 自上而下 = 视觉自上而下:Other/末层在顶,首层在底
            let mut col = v_flex()
                .w(px(WEEK_CELL))
                .h(px(col_h))
                .justify_end()
                .rounded(RADIUS_CELL)
                .overflow_hidden();
            for l in layers.iter().rev().filter(|l| l.weekly[w] > 0) {
                let h = (l.weekly[w] as f32 / total as f32) * col_h;
                col = col.child(div().w_full().h(px(h)).bg(l.color));
            }
            col
        };
        // 定高轨道:柱贴底(justify_end),轨道本身贯穿图高,"选中那周"才有一条
        // 完整的竖带可套描边;宽度/间距与改造前一致,热力图的对齐不受影响
        let track = v_flex()
            .w(px(WEEK_CELL))
            .h(px(CHART_H))
            .flex_shrink_0()
            .justify_end()
            .when(selected_week == Some(w), |t| {
                t.border_1()
                    .border_color(theme.foreground)
                    .rounded(RADIUS_CELL)
            })
            .child(column);
        // tooltip 只捕获 Rc + 两个 Copy 值,该周总量与前三层明细 hover 才算
        let layers = Rc::clone(&layers);
        let week_tokens = weekly_tokens.get(w).copied().unwrap_or(0);
        columns = columns.child(track.id(("trend", w)).tooltip(move |window, cx| {
            let monday = start + chrono::Days::new(w as u64 * 7);
            let mut label = crate::tf!(
                "Week of {} · {}",
                monday.format(t("%b %-d")),
                prompts_label(total)
            );
            label.push_str(&format!(" · {} tokens", fmt_tokens(Some(week_tokens))));
            let breakdown: Vec<String> = layers
                .iter()
                .filter(|l| l.weekly[w] > 0)
                .take(3)
                .map(|l| format!("{} {}", l.name, l.weekly[w]))
                .collect();
            if !breakdown.is_empty() {
                label.push('\n');
                label.push_str(&breakdown.join(" · "));
            }
            gpui_component::tooltip::Tooltip::new(SharedString::from(label)).build(window, cx)
        }));
    }

    let legend = h_flex()
        .flex_wrap()
        .gap_x(SPACE_MD)
        .gap_y(SPACE_XS)
        .pl(px(DOW_W + WEEK_GAP))
        .text_size(FONT_LABEL)
        .text_color(theme.muted_foreground)
        .children(layers.iter().map(|l| {
            h_flex()
                .gap(px(5.))
                .items_center()
                .child(div().size(px(WEEK_CELL)).rounded(RADIUS_CELL).bg(l.color))
                .child(l.name.clone())
        }));

    v_flex()
        .gap(px(6.))
        .child(columns)
        .child(month_ticks(start, cx))
        .child(legend)
        .into_any_element()
}

/// 热力图强度阶梯(primary 不透明度四档)。图例与格子同引本表,
/// 调阶只改这里
const HEAT: [f32; 4] = [0.25, 0.5, 0.75, 1.];

/// GitHub 风活跃热力图:TREND_WEEKS 周 × 7 天(周一起始),最右列为本周(d.as_of,
/// 与 streak 同一天,渲染层不再读时钟)。格子 9px:网格总宽 26 + 3 +
/// 53×9 + 52×3 = 662,必须收进最小窗口的内容宽 668(940 − 224 侧栏 −
/// 两侧 24 padding)——10px 格的 715 会在最小窗口被裁掉右缘
/// (2026-08-27 Codex review)。daily 升序,二分出窗口后填定长数组——
/// 渲染路径零哈希零日期运算;tooltip 文案 hover 才格式化。
/// **本图是三档分布的选取器**:点一格 = 选中那天(再点取消),选中格用
/// foreground 描边(底色已是 primary,描边用前景色才在两套主题下都跳出来)
fn render_heatmap(
    d: &InsightsData,
    selected: Option<chrono::NaiveDate>,
    cx: &Context<Workbench>,
) -> AnyElement {
    let theme = cx.theme();
    let today = d.as_of;
    let start = d.trend_start();
    let today_ix = (today - start).num_days();

    const DAYS: usize = TREND_WEEKS * 7;
    let mut window = [0i64; DAYS];
    let tokens_by_day: HashMap<chrono::NaiveDate, i64> = d.daily_tokens.iter().copied().collect();
    let mut heat_max = 1i64;
    let from = d.daily.partition_point(|(day, _)| *day < start);
    for &(day, n) in &d.daily[from..] {
        let ix = (day - start).num_days();
        if (0..DAYS as i64).contains(&ix) {
            window[ix as usize] = n;
            heat_max = heat_max.max(n);
        }
    }
    let heat_color = |n: i64| -> Hsla {
        if n == 0 {
            return theme.muted;
        }
        let quartile = ((n as f32 / heat_max as f32) * 4.).ceil().clamp(1., 4.) as usize;
        theme.primary.opacity(HEAT[quartile - 1])
    };
    const CELL: f32 = WEEK_CELL;
    const GAP: f32 = WEEK_GAP;
    const STEP: f32 = WEEK_STEP;

    let months = month_ticks(start, cx);

    // 星期标签列:行 r 的格子 y = r×STEP,文字行高 ≈13px,
    // (CELL−13)/2 = −2 光学对行
    let dow_col = div()
        .relative()
        .w(px(DOW_W))
        .h(px(7. * STEP - GAP))
        .flex_shrink_0()
        .text_size(FONT_LABEL)
        .text_color(theme.muted_foreground)
        .children({
            let names = dow_short();
            [0usize, 2, 4].map(|r| {
                div()
                    .absolute()
                    .top(px(r as f32 * STEP - 2.))
                    .left_0()
                    .child(names[r])
            })
        });

    let mut grid = h_flex().gap(px(GAP)).items_start().child(dow_col);
    for c in 0..TREND_WEEKS {
        let mut col = v_flex().gap(px(GAP));
        for r in 0..7usize {
            let ix = c * 7 + r;
            if ix as i64 > today_ix {
                col = col.child(div().size(px(CELL)));
                continue;
            }
            let n = window[ix];
            let cell_day = start + chrono::Days::new(ix as u64);
            let tokens = tokens_by_day.get(&cell_day).copied().unwrap_or(0);
            let is_selected = selected == Some(cell_day);
            col = col.child(
                div()
                    .id(("hm", ix))
                    .size(px(CELL))
                    .rounded(RADIUS_CELL)
                    .bg(heat_color(n))
                    .cursor_pointer()
                    // 选中格描边。描边画在 9px 格内侧,不吃布局(热力图与趋势
                    // 图的列必须严格对齐)
                    .when(is_selected, |cell| {
                        cell.border_1().border_color(theme.foreground)
                    })
                    .hover(|cell| cell.border_1().border_color(theme.muted_foreground))
                    .on_click(cx.listener(move |this, _, _window, cx| {
                        this.toggle_insights_day(cell_day, cx);
                    }))
                    // 只捕获 Copy 的 (start, ix, n),hover 到的那格才格式化
                    .tooltip(move |window, cx| {
                        let day = start + chrono::Days::new(ix as u64);
                        let label = format!(
                            "{} · {} tokens · {}",
                            prompts_label(n),
                            fmt_tokens(Some(tokens)),
                            day.format(t("%b %-d, %Y"))
                        );
                        gpui_component::tooltip::Tooltip::new(SharedString::from(label))
                            .build(window, cx)
                    }),
            );
        }
        grid = grid.child(col);
    }

    // 底注:streak/最忙一天(左) + Less…More 图例(右)
    let mut notes: Vec<String> = Vec::new();
    if d.current_streak > 0 {
        notes.push(crate::tf!("{}-day streak", d.current_streak));
    }
    if d.longest_streak > 0 {
        notes.push(crate::tf!("Longest {} days", d.longest_streak));
    }
    if let Some((day, n)) = d.busiest_day() {
        notes.push(crate::tf!(
            "Busiest {} ({})",
            day.format(t("%b %-d")),
            prompts_label(n)
        ));
    }
    let legend = h_flex()
        .justify_between()
        .items_center()
        .text_size(FONT_LABEL)
        .text_color(theme.muted_foreground)
        .child(div().min_w_0().truncate().child(notes.join(" · ")))
        .child(
            h_flex()
                .gap(px(GAP))
                .items_center()
                .flex_shrink_0()
                .child(t("Less"))
                .children(std::iter::once(0.).chain(HEAT).map(|a: f32| {
                    div().size(px(CELL)).rounded(RADIUS_CELL).bg(if a == 0. {
                        theme.muted
                    } else {
                        theme.primary.opacity(a)
                    })
                }))
                .child(t("More")),
        );

    v_flex()
        .gap(px(6.))
        .child(months)
        .child(grid)
        .child(div().pt(SPACE_XS).child(legend))
        .into_any_element()
}

/// 阅读材质空态卡(360px `popover` 圆角面):详情空态与 Insights 空态共用,
/// 形制齐步走
fn empty_state_card(
    icon_path: &'static str,
    circle: Pixels,
    icon_size: Pixels,
    title: impl Into<SharedString>,
    caption: impl Into<SharedString>,
    cx: &App,
) -> Div {
    let theme = cx.theme();
    div()
        .w(px(360.))
        .px(SPACE_XXL)
        .py(SPACE_XXL)
        .rounded(theme.radius_lg)
        .bg(theme.popover)
        .child(empty_state(
            icon_path, circle, icon_size, title, caption, cx,
        ))
}

/// 空态占位(⌘K 初始 / 列表空 / 详情未选中共用):muted 圆底图标 + 标题 + 说明。
/// 圆径/图标径按场景传入,字阶与间距固定,保证三处视觉一致。
fn empty_state(
    icon_path: &'static str,
    circle: Pixels,
    icon_size: Pixels,
    title: impl Into<SharedString>,
    caption: impl Into<SharedString>,
    cx: &App,
) -> Div {
    let theme = cx.theme();
    v_flex()
        .items_center()
        .gap(SPACE_MD)
        .text_color(theme.muted_foreground)
        .child(
            div()
                .size(circle)
                .rounded_full()
                .bg(theme.muted)
                .flex()
                .items_center()
                .justify_center()
                .child(
                    icon(icon_path)
                        .with_size(icon_size)
                        .text_color(theme.muted_foreground),
                ),
        )
        .child(
            div()
                .text_size(FONT_BODY)
                .font_medium()
                .text_color(theme.foreground)
                .child(title.into()),
        )
        .child(div().text_size(FONT_CAPTION).child(caption.into()))
}

fn image_format_of(media_type: &str) -> Option<gpui::ImageFormat> {
    use gpui::ImageFormat as Format;
    Some(match media_type.trim().to_ascii_lowercase().as_str() {
        "image/png" => Format::Png,
        "image/jpeg" | "image/jpg" => Format::Jpeg,
        "image/webp" => Format::Webp,
        "image/gif" => Format::Gif,
        // SVG 的画布与滤镜开销无法在 GPUI 解码前可靠约束，保留原始下载即可。
        "image/svg+xml" => return None,
        "image/bmp" => Format::Bmp,
        "image/tiff" | "image/tif" => Format::Tiff,
        _ => return None,
    })
}

#[derive(Clone, Copy)]
struct ImageProbe {
    dims: (u32, u32),
    decoded_pixels: u64,
}

fn image_probe(bytes: &[u8], format: gpui::ImageFormat) -> Option<ImageProbe> {
    use image::AnimationDecoder as _;

    const MAX_DIMENSION: u32 = 8_192;
    const MAX_STATIC_PIXELS: u64 = 16_000_000;
    const MAX_ANIMATED_PIXELS: u64 = 32_000_000;
    const MAX_ANIMATION_FRAMES: usize = 120;

    let reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    let guessed = reader.format()?;
    let expected = match format {
        gpui::ImageFormat::Png => image::ImageFormat::Png,
        gpui::ImageFormat::Jpeg => image::ImageFormat::Jpeg,
        gpui::ImageFormat::Gif => image::ImageFormat::Gif,
        gpui::ImageFormat::Webp => image::ImageFormat::WebP,
        gpui::ImageFormat::Bmp => image::ImageFormat::Bmp,
        gpui::ImageFormat::Tiff => image::ImageFormat::Tiff,
        gpui::ImageFormat::Svg | gpui::ImageFormat::Ico | gpui::ImageFormat::Pnm => return None,
    };
    if guessed != expected {
        return None;
    }
    let dims = reader.into_dimensions().ok()?;
    if dims.0 == 0 || dims.1 == 0 || dims.0 > MAX_DIMENSION || dims.1 > MAX_DIMENSION {
        return None;
    }
    let pixels = u64::from(dims.0) * u64::from(dims.1);
    if pixels > MAX_STATIC_PIXELS {
        return None;
    }

    let frame_count = match format {
        gpui::ImageFormat::Gif => {
            let decoder = image::codecs::gif::GifDecoder::new(std::io::Cursor::new(bytes)).ok()?;
            bounded_animation_frames(decoder.into_frames(), pixels, MAX_ANIMATED_PIXELS)?
        }
        gpui::ImageFormat::Webp => {
            let decoder =
                image::codecs::webp::WebPDecoder::new(std::io::Cursor::new(bytes)).ok()?;
            if decoder.has_animation() {
                bounded_animation_frames(decoder.into_frames(), pixels, MAX_ANIMATED_PIXELS)?
            } else {
                1
            }
        }
        _ => 1,
    };
    if frame_count > MAX_ANIMATION_FRAMES {
        return None;
    }
    Some(ImageProbe {
        dims,
        decoded_pixels: pixels.checked_mul(frame_count as u64)?,
    })
}

fn bounded_animation_frames<'a>(
    frames: image::Frames<'a>,
    pixels_per_frame: u64,
    max_pixels: u64,
) -> Option<usize> {
    let limit = (max_pixels / pixels_per_frame).clamp(1, 120) as usize;
    let mut count = 0usize;
    for frame in frames.take(limit + 1) {
        frame.ok()?;
        count += 1;
        if count > limit {
            return None;
        }
    }
    (count > 0).then_some(count)
}

fn image_extension(media_type: &str) -> &'static str {
    match media_type.trim().to_ascii_lowercase().as_str() {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/svg+xml" => "svg",
        "image/bmp" => "bmp",
        "image/tiff" | "image/tif" => "tiff",
        "image/heic" | "image/heif" => "heic",
        "image/avif" => "avif",
        _ => "png",
    }
}

/// 「另存为」一站式:系统对话框(起点是上次导出/保存的目录)→ 后台 `write` → 记住目录
/// → 通知。取消返回 None;写失败弹错并返回 None;成功返回落盘路径。对话框本身开不了
/// (Linux 缺 xdg-desktop-portal 时 gpui 报 Err)退回旧行为:直接写到起始目录、照常通知,
/// 不让按钮变成静默 no-op
fn save_as(
    window: &mut Window,
    cx: &mut App,
    store: Arc<Store>,
    suggested_name: String,
    done: &'static str,
    failed: &'static str,
    write: impl FnOnce(&std::path::Path) -> anyhow::Result<()> + Send + 'static,
) -> Task<Option<PathBuf>> {
    let start = export_dir(&store);
    let rx = cx.prompt_for_new_path(&start, Some(&suggested_name));
    window.spawn(cx, async move |cx| {
        let path = match rx.await {
            Ok(Ok(Some(path))) => path,
            Ok(Err(_)) => start.join(&suggested_name),
            _ => return None,
        };
        let written = cx
            .background_spawn({
                let path = path.clone();
                async move { write(&path) }
            })
            .await;
        cx.update(|window, cx| {
            let note = match &written {
                Ok(()) => {
                    if let Some(dir) = path.parent() {
                        let _ = store.pref_set("export_dir", &dir.to_string_lossy());
                    }
                    Notification::success(crate::tf!("{} to {}", done, path.display()))
                }
                Err(e) => Notification::error(crate::tf!("{}: {}", failed, e)),
            };
            window.push_notification(note, cx);
        })
        .ok();
        written.ok().map(|()| path)
    })
}

/// 「另存为」的起始目录:上次导出/保存的目录(Store 的 prefs KV,与 Open In 记忆同表;
/// 目录还在)> Downloads > home
fn export_dir(store: &Store) -> PathBuf {
    store
        .pref_get("export_dir")
        .map(PathBuf::from)
        .filter(|dir| dir.is_dir())
        .or_else(dirs::download_dir)
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn contextos_skill_dir() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("skills/contextos"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("skills/contextos"));
            candidates.push(dir.join("../skills/contextos"));
            candidates.push(dir.join("../../skills/contextos"));
        }
    }
    candidates
        .into_iter()
        .find(|path| path.join("SKILL.md").is_file())
}

fn copy_dir_contents(from: &std::path::Path, to: &std::path::Path) -> anyhow::Result<()> {
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if src.is_dir() {
            std::fs::create_dir_all(&dst)?;
            copy_dir_contents(&src, &dst)?;
        } else {
            std::fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}

fn skill_binary_path(name: &str) -> String {
    wake_core::mcp::sibling_named(name)
        .filter(|path| path.is_file())
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|| name.to_string())
}

fn powershell_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn inject_skill_binary_paths(path: &std::path::Path) -> anyhow::Result<()> {
    let original = std::fs::read_to_string(path)?;
    let marker = "## Finding the binary";
    let Some(start) = original.find(marker) else {
        return Ok(());
    };
    let Some(rest) = original[start..].find("\n## Commands").map(|ix| start + ix) else {
        return Ok(());
    };
    let cli = skill_binary_path("contextos-cli");
    let mcp = skill_binary_path("contextos-mcp");
    let generated = format!(
        "## Finding the binary\n\n\
         This exported package was generated on this machine with these ContextOS binaries:\n\n\
         ```powershell\n\
         $env:CONTEXTOS_CLI = {}\n\
         $env:CONTEXTOS_MCP = {}\n\
         ```\n\n\
         Use `$env:CONTEXTOS_CLI` when running the commands below. The MCP path is included for \
         agents that need to register the ContextOS MCP server directly.\n\n\
         If those paths no longer exist, fall back to discovery:\n\n\
         ```bash\n\
         command -v contextos-cli || ls /Applications/ContextOS.app/Contents/MacOS/contextos-cli\n\
         ```\n\n\
         Use whichever resolves. On Linux it is on `PATH` after a deb install, or at\n\
         `~/.local/bin/contextos-cli` from the tarball; on Windows it usually sits next to\n\
         `ContextOS.exe`.\n\n\
         Two things can be missing, and they need different answers:\n\n\
         - **No binary.** Say so — the user needs ContextOS. Do not try to install it yourself.\n\
         - **No index** (`no ContextOS index at … — launch ContextOS once to build it`). ContextOS is\n\
           installed but has never run. Run `contextos-cli index` once; it builds the index in a\n\
           few seconds without opening the app, then retry your query.\n",
        powershell_string(&cli),
        powershell_string(&mcp),
    );
    let mut text = String::with_capacity(original.len() + generated.len());
    text.push_str(&original[..start]);
    text.push_str(&generated);
    text.push_str(&original[rest..]);
    std::fs::write(path, text)?;
    Ok(())
}

fn zoom_fit(dims: Option<(u32, u32)>, viewport: Size<Pixels>) -> Size<Pixels> {
    let available_width = (f32::from(viewport.width) - 112.0).max(120.0);
    let available_height = (f32::from(viewport.height) - 164.0).max(120.0);
    let Some((width, height)) = dims.filter(|(width, height)| *width > 0 && *height > 0) else {
        return gpui::size(
            px(available_width.min(720.0)),
            px(available_height.min(480.0)),
        );
    };
    let (width, height) = (width as f32, height as f32);
    let scale = (available_width / width)
        .min(available_height / height)
        .min(1.0);
    gpui::size(px(width * scale), px(height * scale))
}

fn zoom_shadow(y: Pixels, blur: Pixels, alpha: f32) -> gpui::BoxShadow {
    gpui::BoxShadow {
        color: gpui::black().opacity(alpha),
        offset: gpui::point(px(0.), y),
        blur_radius: blur,
        spread_radius: px(0.),
        inset: false,
    }
}

/// 把消息正文按图片插入点切成「markdown 段 / 图片条」序列,交给调用方的容器
///(用户气泡 / 助手列)直接 `.children(..)` 承载,中间**不要加包装层**。
///
/// 已核实的机制:gpui 的 text 元素缓存上一次测量尺寸,之后凡是 wrap_width 为 None
/// 的探测(MinContent/MaxContent)一律返回缓存值,不管那次是在多窄的定宽下量的
///(gpui `elements/text.rs` 的缓存条件;上游只给 truncate 补了防中毒,wrap 没有)。
/// 实测的触发点:靠内容撑宽的用户气泡(`max_w` 无 `w_full`)下再套一层
/// `v_flex().min_w_0()` / `div().min_w_0()` 放 TextView,taffy 会先用 0 宽量文字,
/// "一字一行"的尺寸进了缓存,气泡 max-content 宽度随之变 0,只剩 28px 内边距
///(v0.3.5 回归,中英文都中招);各段直接挂在气泡上则中英文、图片、多段、代码块全正常。
/// 上游若把该缓存改成按 wrap_width 分键,此约束即可解除。
#[allow(clippy::too_many_arguments)]
fn message_content(
    message_index: usize,
    seq: i64,
    text: &str,
    session: &SessionMeta,
    slots: &[ImageSlot],
    base: Pixels,
    paragraph_gap: gpui::Rems,
    dark: bool,
    border: Hsla,
    panel: Hsla,
    muted: Hsla,
    workbench: Entity<Workbench>,
    cx: &mut App,
) -> Vec<AnyElement> {
    let mut content = Vec::new();
    let mut cursor = 0usize;
    let mut image_index = 0usize;

    // 每轮吃掉「下一组图片之前的文字」+ 该组图片;图片用尽后最后一轮吃掉尾段文字
    loop {
        let offset = slots
            .get(image_index)
            .map_or(text.len(), |slot| slot.text_offset().min(text.len()));
        let offset = text.floor_char_boundary(offset).max(cursor);
        let segment = text[cursor..offset].trim_matches('\n');
        if !segment.trim().is_empty() {
            // 序号只要在本条消息内唯一且跨帧稳定即可,段数就够
            let part = content.len();
            content.push(
                markdown_body(
                    format!("dmsg-{seq}-part-{part}").into(),
                    segment,
                    &session.host,
                    &session.project_path,
                    base,
                    paragraph_gap,
                    dark,
                    cx,
                )
                .into_any_element(),
            );
        }
        if image_index >= slots.len() {
            break;
        }

        let group_start = image_index;
        image_index += 1;
        while image_index < slots.len()
            && slots[image_index].text_offset().min(text.len())
                == slots[group_start].text_offset().min(text.len())
        {
            image_index += 1;
        }
        content.push(
            image_strip(
                message_index,
                group_start,
                &slots[group_start..image_index],
                border,
                panel,
                muted,
                workbench.clone(),
            )
            .into_any_element(),
        );
        cursor = offset;
    }
    content
}

fn image_strip(
    message_index: usize,
    image_index_start: usize,
    slots: &[ImageSlot],
    border: Hsla,
    panel: Hsla,
    muted: Hsla,
    workbench: Entity<Workbench>,
) -> Div {
    let mut row = h_flex().flex_wrap().gap(SPACE_SM);
    for (local_index, slot) in slots.iter().enumerate() {
        let image_index = image_index_start + local_index;
        row = row.child(match slot {
            ImageSlot::Ready { image, dims, .. } => {
                let entity = workbench.clone();
                let figure = gpui::img(image.clone());
                let figure = if dims.is_some_and(|(width, height)| width < height) {
                    figure.w(IMAGE_THUMB)
                } else {
                    figure.h(IMAGE_THUMB)
                };
                div()
                    .id(SharedString::from(format!(
                        "message-image:{message_index}:{image_index}"
                    )))
                    .size(IMAGE_THUMB)
                    .flex()
                    .items_center()
                    .justify_center()
                    .overflow_hidden()
                    .rounded(RADIUS_IMAGE)
                    .border_1()
                    .border_color(border)
                    .bg(panel)
                    .cursor_pointer()
                    .child(figure)
                    .on_click(move |_, _, cx| {
                        entity.update(cx, |this, cx| {
                            if let Some(detail) = &mut this.detail {
                                detail.zoom = Some((message_index, image_index));
                                detail.image_action_feedback = [None; 2];
                                cx.notify();
                            }
                        });
                    })
                    .into_any_element()
            }
            ImageSlot::Unsupported {
                media_type, bytes, ..
            } => {
                let media_type_for_save = media_type.to_string();
                let bytes_for_save = bytes.clone();
                let entity = workbench.clone();
                v_flex()
                    .id(SharedString::from(format!(
                        "unsupported-message-image:{message_index}:{image_index}"
                    )))
                    .size(IMAGE_THUMB)
                    .items_center()
                    .justify_center()
                    .gap(SPACE_XS)
                    .p(SPACE_SM)
                    .rounded(RADIUS_IMAGE)
                    .border_1()
                    .border_color(border)
                    .bg(panel)
                    .text_size(FONT_LABEL)
                    .text_color(muted)
                    .cursor_pointer()
                    .tooltip(|window, cx| {
                        gpui_component::tooltip::Tooltip::new(t("Save original image"))
                            .build(window, cx)
                    })
                    .on_click(move |_, window, cx| {
                        let bytes = bytes_for_save.clone();
                        let name = format!(
                            "wake-image-{:016x}.{}",
                            gpui::hash(&*bytes),
                            image_extension(&media_type_for_save)
                        );
                        let store = entity.read(cx).store.clone();
                        save_as(
                            window,
                            cx,
                            store,
                            name,
                            t("Saved"),
                            t("Couldn't save the image"),
                            move |path| Ok(std::fs::write(path, &*bytes)?),
                        )
                        .detach();
                    })
                    .child(t("Preview unavailable"))
                    .child(div().max_w_full().truncate().child(media_type.clone()))
                    .child(icon("icons/download.svg").with_size(px(14.)))
                    .into_any_element()
            }
            ImageSlot::Omitted { .. } => v_flex()
                .id(SharedString::from(format!(
                    "omitted-message-image:{message_index}:{image_index}"
                )))
                .size(IMAGE_THUMB)
                .items_center()
                .justify_center()
                .gap(SPACE_XS)
                .p(SPACE_SM)
                .rounded(RADIUS_IMAGE)
                .border_1()
                .border_color(border)
                .bg(panel)
                .text_size(FONT_LABEL)
                .text_color(muted)
                .child(t("Image omitted"))
                .child(t("Transcript limit reached"))
                .into_any_element(),
        });
    }
    row
}

/// 对话区居中小胶囊(System 消息 / Context compacted)
fn centered_pill(text: impl Into<SharedString>, cx: &App) -> Div {
    let theme = cx.theme();
    div().w_full().flex().justify_center().child(
        div()
            .px(px(10.))
            .py(px(3.))
            .rounded_full()
            .bg(theme.muted)
            .text_size(FONT_LABEL)
            .text_color(theme.muted_foreground)
            .max_w(px(520.))
            .truncate()
            .child(text.into()),
    )
}

/// 对话正文共用的 Markdown 视图。表格、引用块与分隔线由组件原生解析；
/// ContextOS 覆写样式、代码操作区,并按会话所属主机处理 macOS 正文链接。
/// Markdown 正文(消息与记忆文档共用);`host` / `project_path` 只用来解析正文里的
/// 相对链接(远程会话不开本地文件)
fn markdown_body(
    id: SharedString,
    text: impl Into<SharedString>,
    host: &str,
    project_path: &str,
    base: Pixels,
    paragraph_gap: gpui::Rems,
    dark: bool,
    cx: &mut App,
) -> TextView {
    let theme = cx.theme();
    let code_bg = theme.muted;
    let code_border = theme.border;
    let code_radius = theme.radius;
    // TextView 的语法颜色在解析阶段固化；把主题写进 id，让模式切换走同步
    // 首次解析路径，避免代码块短暂保留上一种模式的颜色。
    let themed_id: SharedString = format!("{id}-{}", if dark { "dark" } else { "light" }).into();

    let view = TextView::markdown(themed_id, text)
        .style(
            TextViewStyle {
                heading_base_font_size: base,
                paragraph_gap,
                is_dark: dark,
                highlight_theme: if dark {
                    HighlightTheme::default_dark()
                } else {
                    HighlightTheme::default_light()
                },
                ..Default::default()
            }
            .heading_font_size(|level, base| match level {
                1 => base * 1.45,
                2 => base * 1.28,
                3 => base * 1.14,
                4 => base * 1.05,
                _ => base,
            })
            .code_block(
                StyleRefinement::default()
                    .bg(code_bg)
                    .border_1()
                    .border_color(code_border)
                    .rounded(code_radius)
                    .px(SPACE_LG)
                    .py(SPACE_MD),
            ),
        )
        .code_block_actions(|block, _window, cx| {
            let theme = cx.theme();
            let code = block.code();
            h_flex()
                .items_center()
                .gap(SPACE_SM)
                .px(px(6.))
                .text_size(FONT_LABEL)
                .text_color(theme.muted_foreground)
                .when_some(block.lang(), |actions, lang| actions.child(lang))
                .child(
                    div()
                        .id("code-copy")
                        .size(px(20.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(RADIUS_BADGE)
                        .cursor_pointer()
                        .hover(|style| style.bg(theme.secondary_hover))
                        .tooltip(|window, cx| {
                            gpui_component::tooltip::Tooltip::new(t("Copy code")).build(window, cx)
                        })
                        .on_click(move |_, _, cx| {
                            cx.write_to_clipboard(ClipboardItem::new_string(code.to_string()));
                        })
                        .child(icon("icons/copy.svg").with_size(px(12.))),
                )
        })
        .selectable(true);
    crate::markdown_links::with_session_links(view, host, project_path)
}

/// Thinking 折叠面板：收起是一行摘要，展开后显示完整原文。
fn thinking_panel(
    ix: usize,
    text: &str,
    expanded: bool,
    on_toggle: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    cx: &App,
) -> Div {
    let theme = cx.theme();
    let summary = clip_display(&one_line(text, 400), 88);
    let mut panel = v_flex()
        .w_full()
        .min_w_0()
        .rounded(theme.radius)
        .border_1()
        .border_color(theme.border)
        .bg(theme.muted.opacity(0.45))
        .child(
            h_flex()
                .id(("thinking", ix))
                .w_full()
                .min_w_0()
                .items_center()
                .gap(ICON_TEXT_GAP)
                .px(SPACE_MD)
                .py(SPACE_SM)
                .cursor_pointer()
                .text_size(FONT_MSG_THINKING)
                .text_color(theme.muted_foreground)
                .hover(|style| style.text_colored(theme.foreground, FONT_MSG_THINKING))
                .child(
                    icon("icons/chevron-right.svg")
                        .with_size(px(11.))
                        .flex_shrink_0()
                        .when(expanded, |icon| {
                            icon.rotate(gpui::Radians(std::f32::consts::FRAC_PI_2))
                        }),
                )
                .child(div().flex_shrink_0().font_medium().child(t("Thinking")))
                .when(!expanded, |header| {
                    header.child(
                        div()
                            .min_w_0()
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .italic()
                            .child(summary),
                    )
                })
                .on_click(on_toggle),
        );

    if expanded {
        panel = panel.child(
            div()
                .w_full()
                .min_w_0()
                .pl(px(30.))
                .pr(SPACE_MD)
                .pb(SPACE_MD)
                .whitespace_normal()
                .text_size(FONT_MSG_THINKING)
                .line_height(relative(1.7))
                .text_color(theme.muted_foreground)
                .child(text.to_string()),
        );
    }

    panel
}

const TOOL_TEXT_PREVIEW_LIMIT: usize = 600;

fn tool_cluster_heading(
    calls: &[ToolCallView],
    arg_cells: usize,
) -> (SharedString, Option<SharedString>) {
    match calls {
        [] => (t("No tool calls").into(), None),
        [only] => {
            let arg = (!only.input_preview.trim().is_empty())
                .then(|| clip_display(&only.input_preview, arg_cells).into());
            (only.name.clone().into(), arg)
        }
        many => {
            let names = many
                .iter()
                .map(|call| call.name.as_str())
                .collect::<Vec<_>>()
                .join(" · ");
            (
                crate::tf!("{} tool calls", many.len()).into(),
                Some(clip_display(&names, arg_cells).into()),
            )
        }
    }
}

fn clip_tool_text(text: &str, limit: usize) -> (String, bool) {
    let mut chars = text.chars();
    let mut shown: String = chars.by_ref().take(limit).collect();
    let truncated = chars.next().is_some();
    if truncated {
        shown.push('…');
    }
    (shown, truncated)
}

/// 工具调用折叠卡：收起显示名称/数量、Unicode 宽度感知的参数摘要和失败数；
/// 展开显示可用的完整 Input 与成功/失败 Output。正文只展示前 600 字符，
/// 但复制按钮始终复制完整内容，不使用会抢主阅读区滚轮的嵌套滚动容器。
fn tool_cluster(
    ix: usize,
    calls: &[ToolCallView],
    arg_cells: usize,
    expanded: bool,
    on_toggle: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    cx: &App,
) -> Div {
    let theme = cx.theme();
    let failed = calls.iter().filter(|c| c.is_error).count();
    let (head_name, head_arg) = tool_cluster_heading(calls, arg_cells);
    let mono = theme.mono_font_family.clone();
    let panel_border = theme.border;

    let mut cluster = v_flex()
        .w_full()
        .min_w_0()
        .rounded(theme.radius)
        .border_1()
        .border_color(panel_border)
        .bg(theme.muted.opacity(0.35))
        .child(
            h_flex()
                .id(("tool-cluster", ix))
                .w_full()
                .min_w_0()
                .items_center()
                .gap(ICON_TEXT_GAP)
                .px(SPACE_MD)
                .py(SPACE_SM)
                .cursor_pointer()
                .text_size(FONT_MSG_THINKING)
                .text_color(theme.muted_foreground)
                .hover(|style| style.text_colored(theme.foreground, FONT_MSG_THINKING))
                .child(
                    icon("icons/chevron-right.svg")
                        .with_size(px(11.))
                        .flex_shrink_0()
                        .when(expanded, |icon| {
                            icon.rotate(gpui::Radians(std::f32::consts::FRAC_PI_2))
                        }),
                )
                .child(
                    div()
                        .flex_shrink_0()
                        .font_medium()
                        .text_color(theme.foreground)
                        .child(head_name),
                )
                .when_some(head_arg, |header, arg| {
                    header.child(
                        div()
                            .min_w_0()
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .font_family(mono.clone())
                            .child(arg),
                    )
                })
                .child(div().flex_1())
                .when(failed > 0, |header| {
                    header.child(
                        div()
                            .flex_shrink_0()
                            .px(px(7.))
                            .rounded(RADIUS_BADGE)
                            .text_size(FONT_LABEL)
                            .text_color(theme.danger)
                            .bg(theme.danger.opacity(0.12))
                            .child(crate::tf!("{} failed", failed)),
                    )
                })
                .on_click(on_toggle),
        );

    if expanded {
        let mut items = v_flex()
            .w_full()
            .min_w_0()
            .border_t_1()
            .border_color(panel_border);
        for (call_ix, call) in calls.iter().enumerate() {
            let mut item = v_flex()
                .w_full()
                .min_w_0()
                .px(SPACE_MD)
                .py(px(10.))
                .gap(px(6.))
                .when(call_ix > 0, |item| {
                    item.border_t_1().border_color(panel_border)
                });

            if calls.len() > 1 {
                item = item.child(
                    h_flex()
                        .w_full()
                        .min_w_0()
                        .gap(px(7.))
                        .child(
                            div()
                                .flex_shrink_0()
                                .text_size(FONT_MSG_THINKING)
                                .font_medium()
                                .text_color(if call.is_error {
                                    theme.danger
                                } else {
                                    theme.foreground
                                })
                                .child(call.name.clone()),
                        )
                        .child(
                            div()
                                .min_w_0()
                                .overflow_hidden()
                                .whitespace_nowrap()
                                .text_size(FONT_MSG_THINKING)
                                .font_family(mono.clone())
                                .text_color(theme.muted_foreground)
                                .child(clip_display(&call.input_preview, arg_cells)),
                        ),
                );
            }

            let input = call.input.as_deref().and_then(non_blank_tool_text);
            if let Some(input) = input {
                item = item.child(tool_section(
                    format!("tool-copy-{ix}-{call_ix}-input").into(),
                    t("Input"),
                    input,
                    false,
                    mono.clone(),
                    cx,
                ));
            } else if let Some(input_preview) = non_blank_tool_text(&call.input_preview) {
                item = item.child(tool_section(
                    format!("tool-copy-{ix}-{call_ix}-input-preview").into(),
                    t("Input preview"),
                    input_preview,
                    false,
                    mono.clone(),
                    cx,
                ));
            }

            if let Some(output) = call.output.as_deref().and_then(non_blank_tool_text) {
                item = item.child(tool_section(
                    format!("tool-copy-{ix}-{call_ix}-output").into(),
                    t("Output"),
                    output,
                    call.is_error,
                    mono.clone(),
                    cx,
                ));
            }

            items = items.child(item);
        }
        cluster = cluster.child(items);
    }
    cluster
}

/// 空白只参与“是否有内容”的判断；展示与复制必须保留工具原始输出的边界空白。
fn non_blank_tool_text(text: &str) -> Option<&str> {
    (!text.trim().is_empty()).then_some(text)
}

fn tool_section(
    copy_id: SharedString,
    label: &'static str,
    body: &str,
    is_error: bool,
    mono: SharedString,
    cx: &App,
) -> Div {
    let theme = cx.theme();
    let (shown, truncated) = clip_tool_text(body, TOOL_TEXT_PREVIEW_LIMIT);
    let full = body.to_string();
    let copy_tooltip: SharedString = crate::tf!("Copy full {}", label.to_lowercase()).into();

    v_flex()
        .w_full()
        .min_w_0()
        .gap(SPACE_XS)
        .child(
            h_flex()
                .w_full()
                .items_center()
                .gap(SPACE_SM)
                .text_size(FONT_LABEL)
                .text_color(if is_error {
                    theme.danger
                } else {
                    theme.muted_foreground
                })
                .child(label)
                .when(truncated, |header| {
                    header.child(
                        div()
                            .text_color(theme.muted_foreground)
                            .child(crate::tf!("First {} characters", TOOL_TEXT_PREVIEW_LIMIT)),
                    )
                })
                .child(div().flex_1())
                .child(
                    div()
                        .id(copy_id)
                        .size(px(20.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(RADIUS_BADGE)
                        .cursor_pointer()
                        .text_color(theme.muted_foreground)
                        .hover(|style| style.bg(theme.secondary_hover).text_color(theme.foreground))
                        .tooltip(move |window, cx| {
                            gpui_component::tooltip::Tooltip::new(copy_tooltip.clone())
                                .build(window, cx)
                        })
                        .on_click(move |_, _, cx| {
                            cx.write_to_clipboard(ClipboardItem::new_string(full.clone()));
                        })
                        .child(icon("icons/copy.svg").with_size(px(12.))),
                ),
        )
        .child(
            div()
                .w_full()
                .min_w_0()
                .px(px(10.))
                .py(px(7.))
                .rounded(RADIUS_KBD)
                .bg(if is_error {
                    theme.danger.opacity(0.08)
                } else {
                    theme.muted
                })
                .whitespace_normal()
                .text_size(FONT_MSG_THINKING)
                .line_height(relative(1.6))
                .font_family(mono)
                .text_color(if is_error {
                    theme.danger
                } else {
                    theme.muted_foreground
                })
                .child(shown),
        )
}

/// 小胶囊 badge(项目名/model/source 共用):4px 圆角,内部截断。
/// 项目名用 muted 灰;model/source 用主题色 tint(淡底+同色文字)。
/// 该数据根是否派生自某条自定义 location(with_custom_root 契约保证派生根
/// 全在其落库目录之下);返回落库路径。面板行标记与表单重叠排除共用同一判据
fn custom_owner<'a>(
    customs: &'a [(AgentId, SharedString)],
    agent: AgentId,
    root: &str,
) -> Option<&'a SharedString> {
    customs
        .iter()
        .find(|(a, p)| *a == agent && path_owns(p.as_ref(), root))
        .map(|(_, p)| p)
}

/// "1 session / N sessions" 单复数文案(Locations、Remote hosts、Data 三个
/// 设置页共用,别让几处各自漂移)
pub(crate) fn session_tally(n: i64) -> String {
    crate::tp!("{} session", "{} sessions", n)
}

/// "N files"(Memory locations 的行)
pub(crate) fn file_tally(n: i64) -> String {
    crate::tp!("{} file", "{} files", n)
}

/// 远程会话的 @host 徽章:填充胶囊但用 primary 淡底 + primary 字,与紧邻的 muted
/// 项目胶囊拉开(描边版、muted 填充版都试过,用户否决 2026-09-03)。列表行与 ⌘K
/// 结果行共用;详情页的描边版是有意的第三种
fn host_badge(host: &str, theme: &gpui_component::Theme) -> impl IntoElement {
    badge(
        format!("@{host}"),
        theme.primary.opacity(0.14),
        theme.primary,
    )
}

fn badge(name: impl Into<SharedString>, bg: Hsla, fg: Hsla) -> impl IntoElement {
    div()
        .min_w_0()
        .px(px(6.))
        .py(px(1.))
        .rounded(RADIUS_BADGE)
        .bg(bg)
        .text_color(fg)
        .font_medium()
        .child(div().truncate().child(name.into()))
}

/// outline 变体(model/source 用):透明底,边框与文字同色
fn outline_badge(name: impl Into<SharedString>, color: Hsla) -> impl IntoElement {
    div()
        .min_w_0()
        .px(px(6.))
        .py(px(1.))
        .rounded(RADIUS_BADGE)
        .border_1()
        .border_color(color)
        .text_color(color)
        .font_medium()
        .child(div().truncate().child(name.into()))
}

/// 列表流里的分组头(会话流的时间分割线、记忆流的项目组头共用):Label 11 medium
/// muted 的标签 + 右侧低对比度 hairline,32px 高、px 12
fn section_header_row(label: impl Into<SharedString>, theme: &gpui_component::Theme) -> Div {
    h_flex()
        .h(px(32.))
        .w_full()
        .items_center()
        .gap(SPACE_SM)
        .px(SPACE_MD)
        .pt(SPACE_XS)
        .text_size(FONT_LABEL)
        .font_medium()
        .text_color(theme.muted_foreground)
        .child(div().flex_shrink_0().child(label.into()))
        .child(div().h(px(1.)).flex_1().bg(theme.border.opacity(0.72)))
}

/// 阅读面头部上下文行里的项目胶囊(会话详情与记忆阅读面共用):有路径就可点、在
/// 文件管理器里打开;没有(Unknown project)就是静态胶囊
fn project_badge(
    id: &'static str,
    path: &str,
    label: impl Into<SharedString>,
    theme: &gpui_component::Theme,
) -> AnyElement {
    let badge = badge(label, theme.muted, theme.muted_foreground);
    if path.is_empty() {
        return div().child(badge).into_any_element();
    }
    let path = path.to_string();
    div()
        .id(id)
        .cursor_pointer()
        .tooltip(|window, cx| gpui_component::tooltip::Tooltip::new(show_in_fm()).build(window, cx))
        .on_click(move |_, _, _| terminal::open_in_file_manager(&path))
        .child(badge)
        .into_any_element()
}

/// 阅读面头部的骨架(会话详情与记忆阅读面共用):44px 上下文行(左 `lead`:Label muted
/// 的品牌图 + agent + 归属;右 `actions`)→ 可换行的 22px 标题(整题挂 tooltip)→
/// Label 的元信息行。整块是窗口拖拽区
fn detail_header_frame(
    id: &'static str,
    lead: Vec<AnyElement>,
    actions: Vec<AnyElement>,
    title: SharedString,
    meta_rows: Vec<AnyElement>,
    theme: &gpui_component::Theme,
) -> Stateful<Div> {
    let title_tooltip = title.clone();
    v_flex()
        .id(id)
        .flex_shrink_0()
        .px(SPACE_XXL)
        .pb(SPACE_SM)
        .border_b_1()
        .border_color(theme.border)
        .child(
            h_flex()
                .w_full()
                .h(WINDOW_TITLEBAR_HEIGHT)
                .items_center()
                .justify_between()
                .gap(SPACE_MD)
                .child(
                    h_flex()
                        .flex_1()
                        .min_w_0()
                        .window_control_area(WindowControlArea::Drag)
                        .gap(ICON_TEXT_GAP)
                        .items_center()
                        .text_size(FONT_LABEL)
                        .text_color(theme.muted_foreground)
                        .children(lead),
                )
                .child(
                    h_flex()
                        .id((ElementId::from(id), "actions"))
                        .flex_shrink_0()
                        .gap(SPACE_XS)
                        .occlude()
                        .children(actions),
                ),
        )
        .child(
            div()
                .w_full()
                .min_h(WINDOW_TITLEBAR_HEIGHT)
                .min_w_0()
                .py(SPACE_SM)
                .flex()
                .items_center()
                .window_control_area(WindowControlArea::Drag)
                .child(
                    div()
                        .id((ElementId::from(id), "title"))
                        .w_full()
                        .min_w_0()
                        .whitespace_normal()
                        .text_size(FONT_TITLE)
                        .line_height(relative(1.15))
                        .font_semibold()
                        .child(title)
                        .tooltip(move |window, cx| {
                            gpui_component::tooltip::Tooltip::new(title_tooltip.clone())
                                .build(window, cx)
                        }),
                ),
        )
        .child(
            v_flex()
                .w_full()
                .min_w_0()
                .window_control_area(WindowControlArea::Drag)
                .pt(SPACE_SM)
                .gap(SPACE_SM)
                .text_size(FONT_LABEL)
                .text_color(theme.muted_foreground)
                .children(meta_rows),
        )
}

/// 底部工具条按钮的边长:比导航行(32)小一档
const FOOTER_BTN: Pixels = px(28.);
/// 工具条左内边距 = 26.75(侧栏中轴,红绿灯红灯中心)− 14(按钮半宽):最左那颗
/// 图标的中心压在与导航行行首同一条轴上(用户 2026-09-21)
const FOOTER_LEAD_INSET: Pixels = px(12.75);

#[derive(Clone, Copy)]
enum SidebarGlyph {
    Icon(&'static str),
    Text(&'static str),
}

/// 底部工具条的图标按钮(Zed 状态栏 / Xcode 导航条同款图标条,不带盒子):透明底、
/// hover 才出色;`active`(当前页 / 清理模式)用侧栏行的选中色做圆角底 + 选中前景,
/// 与导航行的选中态同一套语言。14px 图标由容器 text_color 着色
fn sidebar_tool_btn(
    id: &'static str,
    tooltip: &'static str,
    active: bool,
    glyph: SidebarGlyph,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    cx: &Context<Workbench>,
) -> Stateful<Div> {
    let theme = cx.theme();
    div()
        .id(id)
        .size(FOOTER_BTN)
        .flex_shrink_0()
        .rounded(RADIUS_BUTTON)
        .flex()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .when(active, |el| {
            el.bg(theme.sidebar_accent)
                .text_color(theme.sidebar_accent_foreground)
        })
        .when(!active, |el| {
            el.text_color(theme.muted_foreground)
                .hover(|s| s.bg(theme.secondary_hover).text_color(theme.foreground))
                .active(|s| s.bg(theme.secondary_active))
        })
        .tooltip(move |window, cx| gpui_component::tooltip::Tooltip::new(tooltip).build(window, cx))
        .on_click(on_click)
        .child(match glyph {
            SidebarGlyph::Icon(path) => icon(path).with_size(px(14.)).into_any_element(),
            SidebarGlyph::Text(label) => div()
                .text_size(FONT_LABEL)
                .font_semibold()
                .child(label)
                .into_any_element(),
        })
}

/// Things 风源列表行:图标 + 文字 + 计数,6px 圆角选中胶囊
#[allow(clippy::too_many_arguments)]
fn sidebar_row(
    id: impl Into<ElementId>,
    lead: RowLead,
    label: impl Into<SharedString>,
    count: Option<i64>,
    active: bool,
    level: RowLevel,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    cx: &Context<Workbench>,
) -> Stateful<Div> {
    let theme = cx.theme();
    let sub = level == RowLevel::Sub;
    div()
        .id(id)
        .h(if sub { ROW_HEIGHT_SUB } else { ROW_HEIGHT })
        .flex_shrink_0()
        // 分组项整行右移一档表达从属:行首因此落在轴右侧 SUB_INDENT 处,
        // 压轴的是主导航与组头,不是这里
        .pl(if sub {
            LEAD_INSET + SUB_INDENT
        } else {
            LEAD_INSET
        })
        .pr(SIDEBAR_EDGE)
        .rounded(theme.radius)
        .cursor_pointer()
        .flex()
        .items_center()
        .when(active, |s| {
            s.bg(theme.sidebar_accent)
                .text_color(theme.sidebar_accent_foreground)
        })
        .when(!active, |s| {
            s.text_color(theme.sidebar_foreground)
                .hover(|s| s.bg(theme.sidebar_accent.opacity(0.55)))
                .active(|s| s.bg(theme.sidebar_accent))
        })
        .on_click(on_click)
        .child(
            h_flex()
                .w_full()
                .gap(ICON_TEXT_GAP)
                .child(
                    // 定宽槽位保证文字起点统一;内部居中,使小图标的中心也落在
                    // LEAD_AXIS 上(左对齐会让 14/15px 图标的中心偏离轴 1.5~2pt)
                    div()
                        .w(LEAD_BOX)
                        .flex_shrink_0()
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(match lead {
                            RowLead::None => div().into_any_element(),
                            // 线条图标比实心品牌图视觉轻,给它小一档才平衡
                            RowLead::Icon(ic) => ic
                                .with_size(if sub { px(14.) } else { NAV_ICON })
                                .text_color(if active {
                                    theme.sidebar_accent_foreground
                                } else {
                                    theme.muted_foreground
                                })
                                .into_any_element(),
                            // 品牌图不着色:img 走 AssetSource 取内嵌 PNG,原色渲染
                            // (侧栏单色化试过,用户否决——保持彩色)
                            RowLead::Brand(path) => img(path).size(LEAD_BOX).into_any_element(),
                        }),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .text_size(if sub { FONT_CAPTION } else { FONT_BODY })
                        .truncate()
                        .child(label.into()),
                )
                .when_some(count, |this, n| {
                    // 与 Session locations 面板同款胶囊。底色随行态切换而不是
                    // 固定 muted:常态行底是 sidebar,用 accent 衬;选中行底本身
                    // 就是 accent,退回 sidebar 材质反衬。固定 muted 会在浅色
                    // 常态(#E8E8E5 vs #EDEDEA)和深色选中(#323230 vs #343432)
                    // 两处糊进背景里
                    let bg = if active {
                        theme.sidebar
                    } else {
                        theme.sidebar_accent
                    };
                    this.child(div().flex_shrink_0().text_size(FONT_LABEL).child(badge(
                        n.to_string(),
                        bg,
                        theme.muted_foreground,
                    )))
                }),
        )
}

/// Open In 记忆的落盘形态(prefs 表 `open_in`,id 字符串在加载时对回
/// 本机已装终端,残值静默丢弃)
#[derive(serde::Serialize, serde::Deserialize)]
struct OpenInPrefs {
    #[serde(default)]
    agents: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    last: Option<String>,
}

/// Open In 的目标图标:内嵌品牌覆盖(见 TerminalApp::brand_icon)→
/// 提取的 .app 图标 → 通用终端 svg。两处渲染(split 左段/下拉)共用,
/// 精度规则只此一份
fn open_in_icon(
    term: Option<terminal::TerminalApp>,
    icon_path: Option<&PathBuf>,
    fallback: Icon,
) -> AnyElement {
    match (term.and_then(|t| t.brand_icon()), icon_path) {
        (Some(b), _) => img(b).size(px(16.)).into_any_element(),
        (None, Some(p)) => img(p.clone()).size(px(16.)).into_any_element(),
        (None, None) => fallback.into_any_element(),
    }
}

/// 详情工具栏图标按钮。选中态 = 填充版图标 + 语义色(macOS 惯例),
/// 按钮本身不落底色(.selected 的 hover 底被否)。
fn tool_btn(
    id: &'static str,
    icon_path: &'static str,
    filled_icon_path: &'static str,
    active_color: Hsla,
    tooltip: &'static str,
    highlighted: bool,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Button {
    let ic = if highlighted {
        icon(filled_icon_path)
            .with_size(px(16.))
            .text_color(active_color)
    } else {
        icon(icon_path).with_size(px(16.))
    };
    Button::new(id)
        .ghost()
        .rounded(RADIUS_BUTTON)
        .icon(ic)
        .tooltip(tooltip)
        .on_click(on_click)
}

impl Focusable for Workbench {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

struct MemoryCandidatesView {
    focus_handle: FocusHandle,
    workbench: Entity<Workbench>,
    candidates: Vec<ContextosMemoryCandidate>,
    meta: SessionMeta,
}

impl MemoryCandidatesView {
    fn new(
        workbench: Entity<Workbench>,
        candidates: Vec<ContextosMemoryCandidate>,
        meta: SessionMeta,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        Self {
            focus_handle: cx.focus_handle(),
            workbench,
            candidates,
            meta,
        }
    }
}

impl Focusable for MemoryCandidatesView {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for MemoryCandidatesView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let workbench = self.workbench.clone();
        let meta = self.meta.clone();
        let rows = self
            .candidates
            .iter()
            .enumerate()
            .map(|(ix, candidate)| {
                let memory_button_id = format!("candidate-memory-{ix}");
                let memory_candidate = candidate.clone();
                let memory_meta = meta.clone();
                let memory_workbench = workbench.clone();
                v_flex()
                    .id(("memory-candidate-window-row", ix))
                    .flex_shrink_0()
                    .gap(SPACE_SM)
                    .p(SPACE_LG)
                    .border_1()
                    .border_color(theme.border)
                    .rounded(theme.radius)
                    .bg(theme.popover)
                    .child(
                        h_flex()
                            .gap(SPACE_SM)
                            .items_center()
                            .child(outline_badge(candidate.kind_label(), theme.primary))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .text_size(FONT_BODY)
                                    .font_medium()
                                    .truncate()
                                    .child(candidate.title_or_fallback()),
                            )
                            .child(
                                div()
                                    .text_size(FONT_CAPTION)
                                    .text_color(theme.muted_foreground)
                                    .child(format!(
                                        "{} · 建议：{}",
                                        empty_dash(&candidate.confidence),
                                        empty_dash(&candidate.target)
                                    )),
                            ),
                    )
                    .child(
                        div()
                            .text_size(FONT_CAPTION)
                            .text_color(theme.muted_foreground)
                            .line_height(px(18.))
                            .child(candidate.brief()),
                    )
                    .child(
                        h_flex().gap(SPACE_SM).items_center().child(
                            settings_button(Button::new(memory_button_id).label("加入记忆"), cx)
                                .on_click(move |_, window, cx| {
                                    memory_workbench.update(cx, |this, cx| {
                                        this.add_candidate_to_memory(
                                            memory_candidate.clone(),
                                            memory_meta.clone(),
                                            window,
                                            cx,
                                        );
                                    });
                                }),
                        ),
                    )
                    .into_any_element()
            })
            .collect::<Vec<_>>();

        div()
            .id("contextos-memory-candidates-window")
            .track_focus(&self.focus_handle)
            .size_full()
                    .bg(theme.popover)
            .text_color(theme.foreground)
            .child(
                v_flex()
                    .size_full()
                    .p(SPACE_LG)
                    .gap(SPACE_MD)
                    .child(
                        h_flex()
                            .items_center()
                            .gap(SPACE_MD)
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .child(
                                        div()
                                            .text_size(FONT_HEADING)
                                            .font_semibold()
                                            .child("ContextOS 记忆候选"),
                                    )
                                    .child(
                                        div()
                                            .mt(SPACE_XS)
                                            .text_size(FONT_CAPTION)
                                            .text_color(theme.muted_foreground)
                                            .child("逐条确认要加入记忆。未确认的候选不会写入长期记忆。"),
                                    ),
                            )
                            .child(
                                settings_button(Button::new("memory-candidates-close").label("关闭"), cx)
                                    .on_click(|_, window, _| window.remove_window()),
                            ),
                    )
                    .child(
                        v_flex()
                            .id("memory-candidates-window-scroll")
                            .flex_1()
                            .min_h_0()
                            .overflow_y_scroll()
                            .gap(SPACE_SM)
                            .children(rows),
                    ),
            )
            .children(overlay_layers(window, cx))
    }
}

impl Render for Workbench {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_language(window, cx);
        self.refresh_session_group_date(cx);
        self.restore_pending_list_selection(window, cx);
        let theme = cx.theme();
        div()
            .id("workbench")
            .key_context(KEY_CONTEXT)
            .track_focus(&self.focus_handle)
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                if event.keystroke.key == "escape"
                    && this.cleanup.open
                    && !window.has_active_dialog(cx)
                    && (!this.cleanup.preview_open
                        || this
                            .detail
                            .as_ref()
                            .is_none_or(|detail| detail.zoom.is_none()))
                    && this.navigate_cleanup_back(window, cx)
                {
                    cx.stop_propagation();
                }
            }))
            .on_action(cx.listener(Self::toggle_search))
            .on_action(cx.listener(|this, _: &RefreshSessions, window, cx| {
                this.refresh_sessions(window, cx)
            }))
            .on_action(cx.listener(|this, _: &OpenSettings, _window, cx| this.open_settings(cx)))
            .on_action(cx.listener(|this, _: &OpenUpdates, _window, cx| this.open_updates(cx)))
            .on_action(cx.listener(|this, _: &OpenAbout, _window, cx| this.open_about(cx)))
            .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, window, cx| {
                this.update_detail_selection_auto_scroll(event, window, cx)
            }))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, _, _, _| this.stop_detail_selection_auto_scroll()),
            )
            .size_full()
            .bg(theme.background)
            .text_color(theme.foreground)
            .child(
                h_flex()
                    .size_full()
                    .child(self.render_sidebar(window, cx))
                    // Insights / Memory 是整页目的地:替换中栏+右栏,侧栏导航保持在场
                    .map(|this| {
                        if self.cleanup.open {
                            return this.child(self.render_cleanup(window, cx));
                        }
                        match self.page {
                            Page::Memory => this.child(self.render_memory(cx)),
                            Page::Skills => this.child(self.render_skills(cx)),
                            Page::Insights => this.child(self.render_insights(window, cx)),
                            Page::Relationships => this.child(self.render_relationships_page(cx)),
                            Page::Compressions => this.child(self.render_compressions(cx)),
                            Page::Sessions => this
                                .child(self.render_session_list(cx))
                                .child(self.render_detail(window, cx))
                                .when(self.detail.is_some(), |this| {
                                    this.child(self.render_detail_outline(window, cx))
                                }),
                        }
                    }),
            )
            .child(self.render_image_zoom(window, cx))
            .children(overlay_layers(window, cx))
    }
}
