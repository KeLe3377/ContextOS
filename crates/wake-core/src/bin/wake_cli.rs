//! contextos-cli:从终端查 ContextOS 的会话索引(只读)。
//!
//!   contextos-cli search QUERY [OPTIONS]   全文搜索
//!   contextos-cli sessions [OPTIONS]       最近的会话
//!   contextos-cli show KEY [OPTIONS]       读一份转录
//!   contextos-cli projects [OPTIONS]       有会话历史的项目
//!   contextos-cli setup                    路径、进 PATH、给 agent 的说明
//!   contextos-cli index                    库不存在时建一次(见 scanner::build_index)
//!   contextos-cli --version | --help
//!
//! 输出就是 MCP 工具那份文本、一字不改(tests/cli.rs 逐字节卡),所以 docs 与
//! 将来的 Skill 只需描述一份格式。解析在 `wake_core::cli`,这里只做 I/O 与退
//! 出码。索引库一律只读打开(`mcp::open_index`),**绝不 open_or_rebuild**;
//! 唯一的写是 `index` 子命令——库不存在时建一次,规矩与理由在
//! `scanner::build_index`,别在这里复述或放宽。
//!
//! **结果不许走 println!**:Rust 忽略 SIGPIPE,`contextos-cli show K | head` 会让
//! println! panic 成 101。所有输出统一经 cli::emit,BrokenPipe 由 write 收场。
use std::io::{self, IsTerminal as _, Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use wake_core::cli::{self, Action, CliError, Report, Stream};
use wake_core::db::{self, Store};
use wake_core::mcp::{self, tools};
use wake_core::models::SessionFilter;
use wake_core::scanner::{self, NullEvents, ScanEvents, ScanProgress};
use wake_core::text::plural;

fn program_name() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|path| {
            path.file_stem()
                .map(|name| name.to_string_lossy().to_string())
        })
        .unwrap_or_else(|| "contextos-cli".to_string())
}

fn main() -> ExitCode {
    // args()(而非 args_os)对非 UTF-8 参数是 panic,退出码 101 —— Linux 上
    // 目录名可以不是 UTF-8,而 `--project "$PWD"` 正是主用法,不能崩
    let argv: Vec<String> = match std::env::args_os()
        .skip(1)
        .map(|a| a.into_string())
        .collect()
    {
        Ok(v) => v,
        Err(bad) => {
            return write(
                CliError {
                    message: format!("argument is not valid UTF-8: {}", bad.to_string_lossy()),
                    with_usage: false,
                }
                .report(),
            )
        }
    };
    let inv = match cli::parse(&argv) {
        Ok(i) => i,
        Err(e) => return write(e.report()),
    };
    match inv.action {
        Action::Help => write(ok(cli::help())),
        Action::Version => write(ok(format!("{} {}", program_name(), mcp::SERVER_VERSION))),
        Action::Setup => write(ok(setup(&inv.db))),
        Action::Index => write(cli::report(index(&db_path(&inv.db)))),
        Action::Context => write(cli::report(context(&db_path(&inv.db)))),
        Action::RefreshContext => write(cli::report(refresh_context(&db_path(&inv.db)))),
        Action::Tool { tool, args } => {
            let args = match merge_domain_input(args) {
                Ok(args) => args,
                Err(message) => {
                    return write(cli::report(Err(tools::ToolError::InvalidParams(message))))
                }
            };
            run(&inv.db, tool, &args)
        }
    }
}

fn context(path: &Path) -> Result<String, tools::ToolError> {
    let (store, _) =
        mcp::open_index(path).map_err(|error| tools::ToolError::Internal(format!("{error:#}")))?;
    let cwd = std::env::current_dir().map_err(|error| {
        tools::ToolError::Internal(format!("could not read current directory: {error}"))
    })?;
    wake_core::services::context::session_start_context(&store, &cwd)
        .map(|context| context.unwrap_or_default())
        .map_err(|error| tools::ToolError::Internal(format!("{error:#}")))
}

fn refresh_context(path: &Path) -> Result<String, tools::ToolError> {
    let (store, adapters) =
        mcp::open_index(path).map_err(|error| tools::ToolError::Internal(format!("{error:#}")))?;
    scanner::run_scan(&adapters, &store, &NullEvents, false)
        .map_err(|error| tools::ToolError::Internal(format!("index refresh failed: {error:#}")))?;
    let cwd = std::env::current_dir().map_err(|error| {
        tools::ToolError::Internal(format!("could not read current directory: {error}"))
    })?;
    wake_core::services::context::session_start_context(&store, &cwd)
        .map(|context| context.unwrap_or_default())
        .map_err(|error| tools::ToolError::Internal(format!("{error:#}")))
}

fn merge_domain_input(mut args: serde_json::Value) -> Result<serde_json::Value, String> {
    let input = args.as_object_mut().and_then(|map| map.remove("_input"));
    let Some(input) = input else {
        return Ok(args);
    };
    let source = input
        .as_str()
        .ok_or("internal error: `_input` must be a string")?;
    let mut raw = String::new();
    if source == "-" {
        io::stdin()
            .read_to_string(&mut raw)
            .map_err(|e| format!("cannot read stdin: {e}"))?;
    } else {
        raw = std::fs::read_to_string(source).map_err(|e| format!("cannot read {source}: {e}"))?;
    }
    let loaded: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("invalid request JSON: {e}"))?;
    let loaded = loaded.as_object().ok_or("request JSON must be an object")?;
    let map = args.as_object_mut().expect("CLI args are always an object");
    let operation = map.remove("operation");
    for (key, value) in loaded {
        map.insert(key.clone(), value.clone());
    }
    if let Some(operation) = operation {
        map.insert("operation".into(), operation);
    }
    Ok(args)
}

fn ok(text: String) -> Report {
    Report {
        stream: Stream::Stdout,
        text,
        code: 0,
    }
}

/// db 路径只在真要用库时求值:`path_or_default` 落到 default_db_path 时有副
/// 作用(首次会把旧 vibex 库拷过来),--help / --version 不该碰用户的文件系统
fn db_path(db: &Option<PathBuf>) -> PathBuf {
    db::path_or_default(db.as_deref())
}

fn run(db: &Option<PathBuf>, tool: &str, args: &serde_json::Value) -> ExitCode {
    // 只读打开 + 按库配置建 roster,与 contextos-mcp 同一条(不变量 8⑥);库不存在
    // 或太老由 open_read_only 给出 "launch Wake once"
    let (store, adapters) = match mcp::open_index(&db_path(db)) {
        Ok(x) => x,
        Err(e) => {
            return write(Report {
                stream: Stream::Stderr,
                text: format!("contextos-cli: {e}"),
                code: 2,
            })
        }
    };
    let cache = tools::TranscriptCache::default();
    let result = tools::invoke(&store, &adapters, &cache, tool, args);
    if wake_core::services::control::NAMES.contains(&tool) {
        if let Ok(text) = &result {
            if serde_json::from_str::<serde_json::Value>(text)
                .ok()
                .and_then(|value| value.get("ok").and_then(serde_json::Value::as_bool))
                == Some(false)
            {
                return write(Report {
                    stream: Stream::Stdout,
                    text: text.clone(),
                    code: 1,
                });
            }
        }
    }
    write(cli::report(result))
}

/// 建一次索引,然后说一句人话。建不建、凭什么敢建全在 `scanner::build_index`,
/// 这里只剩措辞。场景是"装了 Wake 但从没启动过":skill 让 agent 跑这一条自救。
/// 失败一律走 `?`(anyhow → `ToolError::Internal`)交 `cli::report` 收场——
/// "跑起来了然后失败"退 1,与工具调用失败同一条出口,不另写一份映射
fn index(path: &Path) -> Result<String, tools::ToolError> {
    // 进度只给终端看:全量扫描要几秒到几十秒,没有反馈像卡死;管道与 agent
    // 调用时 stderr 保持安静(它是诊断通道,tests/cli.rs 也这么断言)
    let events: &dyn ScanEvents = if io::stderr().is_terminal() {
        &TtyProgress
    } else {
        &NullEvents
    };
    let Some(store) = scanner::build_index(path, events)? else {
        return Ok(format!(
            "An index already exists at {}. Launch Wake to update or rebuild it.",
            path.display()
        ));
    };
    let sessions = store
        .list_sessions(&SessionFilter {
            limit: 1,
            ..Default::default()
        })?
        .1;
    let agents = store.agent_counts()?.len() as i64;
    Ok(format!(
        "Indexed {sessions} session{} from {agents} agent{} into {}.\n\
         Launch Wake to keep it current — it watches the agents' files while it runs.",
        plural(sessions),
        plural(agents),
        path.display()
    ))
}

/// `index` 在终端上的进度:格式在 `cli::progress_line`(有单测),这里只负责
/// "写到 stderr"。写失败一律忽略——进度条不是结果;stderr 无缓冲,不需要 flush
struct TtyProgress;

impl ScanEvents for TtyProgress {
    fn on_progress(&self, p: &ScanProgress) {
        let _ = cli::progress_line(p, &mut io::stderr().lock());
    }
    fn on_sessions_changed(&self) {}
}

fn setup(db: &Option<PathBuf>) -> String {
    let cli_bin = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("contextos-cli"));
    let mcp_bin = mcp::sibling_file("contextos-mcp");
    let path = db_path(db);
    // 只探库,不必为一行提示把十九家 roster 建起来
    let db_error = Store::open_read_only(&path).err().map(|e| format!("{e:#}"));
    cli::setup_text(&cli::SetupFacts {
        cli_bin: &cli_bin,
        mcp_bin: mcp_bin.as_deref(),
        db: &path,
        db_error,
    })
}

/// 唯一的输出出口。下游关掉管道(`contextos-cli search x | head`)是正常收场,保持
/// 原本的退出码;stderr 也可能被关,同理别 panic
fn write(r: Report) -> ExitCode {
    let res = match r.stream {
        Stream::Stdout => cli::emit(&r.text, &mut io::stdout().lock()),
        Stream::Stderr => cli::emit(&r.text, &mut io::stderr().lock()),
    };
    match res {
        Ok(()) => ExitCode::from(r.code),
        Err(e) if e.kind() == io::ErrorKind::BrokenPipe => ExitCode::from(r.code),
        Err(e) => {
            let _ = writeln!(io::stderr(), "contextos-cli: {e}");
            ExitCode::from(1)
        }
    }
}
