//! ContextOS 的双模式主题:冷白 / slate 工具台质感。
//! 浅色对齐 `D:\project\ContextOS\frontend` 的冷灰 CSS token;深色保持同一冷调层级。
use gpui::{App, Hsla, Rgba, Window};
use gpui_component::{ActiveTheme as _, Theme, ThemeMode};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppearancePreference {
    System,
    Light,
    Dark,
}

impl AppearancePreference {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Light => "light",
            Self::Dark => "dark",
        }
    }

    fn parse(value: &str) -> Self {
        match value.trim() {
            "light" => Self::Light,
            "dark" => Self::Dark,
            _ => Self::System,
        }
    }
}

pub fn appearance_preference() -> AppearancePreference {
    crate::prefs::read("appearance")
        .map(|value| AppearancePreference::parse(&value))
        .unwrap_or(AppearancePreference::System)
}

fn apply_appearance(
    preference: AppearancePreference,
    mut window: Option<&mut Window>,
    cx: &mut App,
) {
    match preference {
        AppearancePreference::System => Theme::sync_system_appearance(window.as_deref_mut(), cx),
        AppearancePreference::Light => Theme::change(ThemeMode::Light, window.as_deref_mut(), cx),
        AppearancePreference::Dark => Theme::change(ThemeMode::Dark, window.as_deref_mut(), cx),
    }
    apply_wake_theme(cx);
    #[cfg(target_os = "windows")]
    if let Some(window) = window.as_deref_mut() {
        sync_windows_titlebar(window, cx.theme().mode.is_dark());
    }
    cx.refresh_windows();
}

#[cfg(target_os = "windows")]
fn sync_windows_titlebar(window: &Window, dark: bool) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows_sys::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_USE_IMMERSIVE_DARK_MODE};

    let handle = match HasWindowHandle::window_handle(window) {
        Ok(handle) => handle,
        Err(error) => {
            eprintln!("Could not get native window handle for title bar appearance: {error}");
            return;
        }
    };
    let RawWindowHandle::Win32(handle) = handle.as_raw() else {
        return;
    };

    let use_dark_mode = i32::from(dark);
    let result = unsafe {
        DwmSetWindowAttribute(
            handle.hwnd.get() as _,
            DWMWA_USE_IMMERSIVE_DARK_MODE as u32,
            (&use_dark_mode as *const i32).cast(),
            std::mem::size_of_val(&use_dark_mode) as u32,
        )
    };
    if result < 0 {
        eprintln!("Could not update native Windows title bar appearance: HRESULT {result:#x}");
    }
}

pub fn set_appearance(
    preference: AppearancePreference,
    window: Option<&mut Window>,
    cx: &mut App,
) -> std::io::Result<()> {
    crate::prefs::write("appearance", preference.as_str().as_bytes())?;
    apply_appearance(preference, window, cx);
    Ok(())
}

/// 带透明度的色值(文字选区等叠加层用)
fn ca(hex: u32, a: f32) -> Hsla {
    let mut col = c(hex);
    col.a = a;
    col
}

fn c(hex: u32) -> Hsla {
    Rgba {
        r: ((hex >> 16) & 0xff) as f32 / 255.0,
        g: ((hex >> 8) & 0xff) as f32 / 255.0,
        b: (hex & 0xff) as f32 / 255.0,
        a: 1.0,
    }
    .into()
}

/// Claude 品牌橙:model badge、趋势图 Claude 层、模型色板第二档共用
const CLAUDE_ORANGE: u32 = 0xD97757;

/// 详情页 model badge 色——用户指定的 Claude 橙(非 agent 语义,纯配色选择);
/// outline badge 形态,两模式通用
pub const MODEL_BADGE_BG: u32 = CLAUDE_ORANGE;

/// 收藏星选中色——macOS systemYellow(Finder/Mail 星标惯例),两模式通用
pub const STAR_YELLOW: u32 = 0xFFCC00;

/// Insights 趋势图的 agent 序列色:有彩色品牌的家取品牌色(从内嵌 PNG 取主色,
/// 与侧栏图标同调),单色字形的家(Copilot/Cursor/OpenCode/Pi/Grok/Kimi)
/// 给固定备选色——同一家在任何机器上颜色都不变,相邻常见组合(Claude/Codex/
/// Cursor/Copilot)互不撞色。两模式共用(用户 2026-09-03:单色阶梯分不清)
pub fn agent_series_color(agent: wake_core::models::AgentId) -> u32 {
    use wake_core::models::AgentId::*;
    match agent {
        ClaudeCode => CLAUDE_ORANGE,
        Codex => 0x7A8DFF,
        Grok => 0x8A7F73,
        Dsh => 0x4D6BFE,
        Cursor => 0x2DB6C8,
        Opencode => 0xC98A2E,
        Pi => 0x3AAE8C,
        Omp => 0xB05CE6,
        Kiro => 0x9148FF,
        Kimi => 0xE4739E,
        Gemini => 0x3B8BD9,
        Copilot => 0x6E9C3F,
        Antigravity => 0x648AB5,
        Qoder => 0x2BB454,
        Hermes => 0xE0B040,
        Openclaw => 0xE04A4A,
        Codebuddy => 0x6C4DFF,
        Workbuddy => 0x0EC8A9,
        // 品牌是黑白的,趋势图里给一档中性石板灰
        Zcode => 0x8B95A5,
    }
}

/// 趋势图里库内冒出未知 agent_id(降级防御)时的备选序列色
pub const SERIES_FALLBACK: u32 = 0x4C8DFF;

/// 在 gpui-component 默认主题之上覆写 ContextOS 的 token。
/// 每次外观切换后都要重新调用(sync_system_appearance 会重置为默认)。
pub fn apply_wake_theme(cx: &mut App) {
    let dark = cx.theme().mode.is_dark();
    let theme = Theme::global_mut(cx);

    if dark {
        // ---- 深色：VS Code Dark+ 炭灰层级与蓝色焦点色 ----
        theme.background = c(0x1E1E1E);
        theme.foreground = c(0xD4D4D4);
        theme.border = c(0x3C3C3C);
        theme.ring = c(0x007ACC);

        theme.sidebar = c(0x252526);
        theme.sidebar_foreground = c(0xCCCCCC);
        theme.sidebar_border = c(0x333333);
        theme.sidebar_accent = c(0x37373D);
        theme.sidebar_accent_foreground = c(0xF0F0F0);
        theme.sidebar_primary = c(0x007ACC);
        theme.sidebar_primary_foreground = c(0xFFFFFF);

        theme.colors.list = c(0x1E1E1E);
        theme.list_hover = c(0x2A2D2E);
        theme.list_active = c(0x04395E);
        theme.list_active_border = c(0x007ACC);
        theme.list_even = c(0x1E1E1E);
        theme.list_head = c(0x252526);

        theme.muted = c(0x2D2D30);
        theme.muted_foreground = c(0xA0A0A0);
        theme.accent = c(0x37373D);
        theme.accent_foreground = c(0xD4D4D4);

        theme.primary = c(0x007ACC);
        theme.primary_hover = c(0x1684D8);
        theme.primary_active = c(0x005A9E);
        theme.primary_foreground = c(0xFFFFFF);

        theme.secondary = c(0x333333);
        theme.secondary_hover = c(0x3E3E42);
        theme.secondary_active = c(0x4A4A4F);
        theme.secondary_foreground = c(0xD4D4D4);

        theme.popover = c(0x252526);
        theme.popover_foreground = c(0xD4D4D4);
        theme.group_box = c(0x252526);
        theme.group_box_foreground = c(0xD4D4D4);
        theme.input = c(0x3C3C3C);
        theme.selection = ca(0x264F78, 0.55);
        theme.caret = c(0xAEAFAD);

        theme.title_bar = c(0x3C3C3C);
        theme.title_bar_border = c(0x3C3C3C);

        theme.scrollbar_thumb = c(0x424242);
        theme.scrollbar_thumb_hover = c(0x4F4F4F);

        theme.link = c(0x3794FF);
        theme.danger = c(0xF14C4C);
        theme.danger_hover = c(0xF26464);
        theme.danger_active = c(0xD83B3B);
        theme.danger_foreground = c(0xFFFFFF);
        theme.success = c(0x89D185);
        theme.success_foreground = c(0x1E1E1E);
        theme.warning = c(0xCCA700);
        theme.warning_foreground = c(0x1E1E1E);
        theme.overlay = gpui::hsla(0., 0., 0., 0.45);
    } else {
        // ---- 浅色：与 ContextOS frontend 的冷白 / slate token 对齐 ----
        theme.background = c(0xF8FAFC);
        theme.foreground = c(0x0F172A);
        theme.border = c(0xE2E8F0);
        theme.ring = c(0x2563EB);

        theme.sidebar = c(0xFFFFFF);
        theme.sidebar_foreground = c(0x475569);
        theme.sidebar_border = c(0xE2E8F0);
        theme.sidebar_accent = c(0xF1F5F9);
        theme.sidebar_accent_foreground = c(0x0F172A);
        theme.sidebar_primary = c(0x2563EB);
        theme.sidebar_primary_foreground = c(0xFFFFFF);

        theme.colors.list = c(0xFFFFFF);
        theme.list_hover = c(0xF1F5F9);
        theme.list_active = c(0xEDF4FE);
        theme.list_active_border = c(0x2563EB);
        theme.list_even = c(0xFFFFFF);
        theme.list_head = c(0xF8FAFC);

        theme.muted = c(0xF1F5F9);
        theme.muted_foreground = c(0x64748B);
        theme.accent = c(0xE8EDF5);
        theme.accent_foreground = c(0x0F172A);

        theme.primary = c(0x2563EB);
        theme.primary_hover = c(0x1D4ED8);
        theme.primary_active = c(0x1E40AF);
        theme.primary_foreground = c(0xFFFFFF);

        theme.secondary = c(0xF1F5F9);
        theme.secondary_hover = c(0xE8EDF5);
        theme.secondary_active = c(0xE2E8F0);
        theme.secondary_foreground = c(0x475569);

        theme.popover = c(0xFFFFFF);
        theme.popover_foreground = c(0x0F172A);
        theme.group_box = c(0xFFFFFF);
        theme.group_box_foreground = c(0x0F172A);
        theme.input = c(0xCBD5E1);
        theme.selection = ca(0x2563EB, 0.18);
        theme.caret = c(0x2563EB);

        theme.title_bar = c(0xFFFFFF);
        theme.title_bar_border = c(0xE2E8F0);

        theme.scrollbar_thumb = c(0xCBD5E1);
        theme.scrollbar_thumb_hover = c(0x94A3B8);

        theme.link = c(0x2563EB);
        theme.danger = c(0xB91C1C);
        theme.danger_hover = c(0xDC2626);
        theme.danger_active = c(0x991B1B);
        theme.danger_foreground = c(0xFFFFFF);
        theme.success = c(0x15803D);
        theme.success_foreground = c(0xFFFFFF);
        theme.warning = c(0xB45309);
        theme.warning_foreground = c(0xFFFFFF);
        theme.overlay = gpui::hsla(0., 0., 0., 0.25);
    }

    // Checkbox 的边框和禁用态读取 colors.primary，选中填充读取
    // tokens.primary；同步背景 token，避免蓝色描边包着组件默认的黑色填充。
    theme.tokens.primary = theme.primary.into();

    // 系统字体与 macOS 圆角习惯。`.SystemUIFont` 是 gpui 各平台后端都认的
    // 别名(macOS 解到 .AppleSystemUIFont,Windows 的 DirectWrite 后端解到
    // 系统 UI 字体);写死 `.AppleSystemUIFont` 会让非 mac 平台每个字重都
    // 走一遍"找不到→回落"的错误路径(2026-08-25 review)
    theme.font_family = ".SystemUIFont".into();
    theme.font_size = gpui::px(14.);
    theme.radius = gpui::px(8.);
    // 聚焦态只把边框染成 ring 色,不画框外的环:gpui-component 的环是元素框外
    // 2px 的绝对定位子元素,任何裁切祖先(弹窗面板、滚动列表、圆角容器)都会
    // 切掉一截——Add host / Add location 表单与设置页里实测残缺(2026-09-03
    // 用户反馈两轮)。上游自己的建议就是版式裁切多的应用关掉它,边框不占空间
    theme.focus_ring = false;
    theme.radius_lg = gpui::px(12.);
    theme.shadow = true;
}

/// 跟随系统外观:同步模式 → 重套 ContextOS token。
pub fn sync_appearance(window: Option<&mut Window>, cx: &mut App) {
    // WAKE_THEME=dark|light 可强制模式(调试/截图用)
    let preference = match std::env::var("WAKE_THEME").as_deref() {
        Ok("dark") => AppearancePreference::Dark,
        Ok("light") => AppearancePreference::Light,
        _ => appearance_preference(),
    };
    apply_appearance(preference, window, cx);
}
