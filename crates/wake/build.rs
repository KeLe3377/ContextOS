//! Windows 资源嵌入:exe 图标 + 版本信息。图标资源 ID 必须是 1——gpui 的
//! Windows 后端用 `LoadImageW(module, MAKEINTRESOURCE(1))` 取窗口/任务栏图
//! (winresource 的 set_icon 默认即 ID 1),资源管理器则自取最小 ID 做文件图。
//! 其余平台此脚本是空转;icon.ico 由 icon.svg 预生成入库
//! (scripts/make-windows.ps1 头注有再生成命令)。

fn main() {
    // rerun 声明先于 early return:零声明的 build script 会退回"包内任一
    // 文件变了就重跑",非 Windows 平台的增量构建也白付一次空转
    println!("cargo:rerun-if-changed=assets/icon.ico");
    // 按编译目标而非宿主判断:交叉构建(如 Linux 上 cargo check windows 目标)
    // 也要走这支;宿主没有 rc/windres 工具链时降级为警告,不挡 check
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let mut res = winresource::WindowsResource::new();
    res.set_icon("assets/icon.ico");
    res.set("ProductName", "ContextOS");
    res.set(
        "FileDescription",
        "ContextOS — coding agent session manager",
    );
    if let Err(e) = res.compile() {
        // 宿主即 Windows(= 真机构建,rc.exe 理应在)时硬失败:静默降级会让
        // make-windows.ps1 打出一个没图标、没版本信息的 exe 而无人察觉;
        // 跨平台 check(Linux 宿主查 windows 目标)才允许降级为警告
        if cfg!(windows) {
            panic!("Windows resources failed to embed (icon/version info): {e}");
        }
        println!("cargo:warning=Windows resources skipped (icon/version info): {e}");
    }
}
