use futures::channel::mpsc;
use gpui::{App, Global};
use tray_icon::{
    menu::{Menu, MenuEvent, MenuItem},
    Icon, TrayIcon, TrayIconBuilder, TrayIconEvent,
};

const OPEN_ID: &str = "contextos.open";
const REFRESH_ID: &str = "contextos.refresh";
const QUIT_ID: &str = "contextos.quit";

#[derive(Clone, Copy, Debug)]
pub(crate) enum Command {
    Open,
    Refresh,
    Quit,
}

/// Keeps the non-Send tray handle alive on GPUI's event-loop thread.
pub(crate) struct State {
    _icon: TrayIcon,
}

impl Global for State {}

pub(crate) fn init(cx: &mut App) -> anyhow::Result<()> {
    let menu = Menu::new();
    let open = MenuItem::with_id(OPEN_ID, "打开 ContextOS", true, None);
    let refresh = MenuItem::with_id(REFRESH_ID, "刷新会话", true, None);
    let quit = MenuItem::with_id(QUIT_ID, "退出 ContextOS", true, None);
    let items: [&dyn tray_icon::menu::IsMenuItem; 3] = [&open, &refresh, &quit];
    menu.append_items(&items)?;

    let icon = image::load_from_memory(include_bytes!("../assets/icon-1024.png"))?.into_rgba8();
    let (width, height) = icon.dimensions();
    let icon = Icon::from_rgba(icon.into_raw(), width, height)?;
    let tray = TrayIconBuilder::new()
        .with_menu(Box::new(menu))
        .with_tooltip("ContextOS")
        .with_icon(icon)
        .build()?;

    let (tx, mut rx) = mpsc::unbounded::<Command>();
    MenuEvent::set_event_handler(Some({
        let tx = tx.clone();
        move |event: MenuEvent| {
            let command = match event.id().as_ref() {
                OPEN_ID => Some(Command::Open),
                REFRESH_ID => Some(Command::Refresh),
                QUIT_ID => Some(Command::Quit),
                _ => None,
            };
            if let Some(command) = command {
                let _ = tx.unbounded_send(command);
            }
        }
    }));
    TrayIconEvent::set_event_handler(Some(move |event: TrayIconEvent| {
        if matches!(event, TrayIconEvent::DoubleClick { .. }) {
            let _ = tx.unbounded_send(Command::Open);
        }
    }));

    cx.set_global(State { _icon: tray });
    cx.spawn(async move |cx| loop {
        // GPUI and tray-icon have different event sources. Polling on a short
        // foreground timer lets a tray click wake the GPUI side even when no
        // application window is visible.
        cx.background_executor()
            .timer(std::time::Duration::from_millis(100))
            .await;
        while let Ok(command) = rx.try_recv() {
            cx.update(|cx| crate::handle_tray_command(command, cx));
        }
    })
    .detach();

    Ok(())
}
