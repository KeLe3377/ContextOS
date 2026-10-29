use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, ensure, Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[cfg(windows)]
use std::os::windows::process::CommandExt as _;
#[cfg(windows)]
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

pub const RUNTIME_VERSION: &str = "contextos-laya-runtime-v1";
pub const UV_VERSION: &str = "0.12.23";
pub const UV_WINDOWS_X86_64_URL: &str =
    "https://github.com/astral-sh/uv/releases/download/0.12.23/uv-x86_64-pc-windows-msvc.zip";
pub const UV_WINDOWS_X86_64_SHA256: &str =
    "75d05de6762778c31ee183398de7dd15093fad0ed90b1f236d8205ea5ec00c90";
pub const PYTHON_VERSION: &str = "3.12.12";
pub const LAYA_VERSION: &str = "0.4.0";
pub const MODEL: &str = "laya-multilingual";
const MODEL_NAME: &str = "multilingual";
const FIRST_PORT: u16 = 1338;
const LAST_PORT: u16 = 1348;
const LOG_LIMIT_BYTES: u64 = 8 * 1024 * 1024;
const HEALTH_TIMEOUT: Duration = Duration::from_secs(20 * 60);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LayaRuntimeMode {
    #[default]
    Managed,
    External,
}

impl LayaRuntimeMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Managed => "managed",
            Self::External => "external",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "managed" => Some(Self::Managed),
            "external" => Some(Self::External),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LayaInstallState {
    #[default]
    NotInstalled,
    Installing,
    Installed,
    Broken,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LayaServiceState {
    #[default]
    Stopped,
    Starting,
    Ready,
    Failed,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LayaRuntimeError {
    pub stage: String,
    pub message: String,
    pub log_path: Option<PathBuf>,
    pub retryable: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct LayaRuntimeStatus {
    pub install_state: LayaInstallState,
    pub service_state: LayaServiceState,
    pub installed_version: Option<String>,
    pub model_revision: Option<String>,
    pub endpoint: Option<String>,
    pub current_stage: Option<String>,
    pub progress: Option<f32>,
    pub error: Option<LayaRuntimeError>,
    pub cleanup_required: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LayaInstallation {
    pub schema_version: u32,
    pub runtime_version: String,
    pub python_version: String,
    pub laya_version: String,
    pub model: String,
    pub model_revision: String,
    pub installed_at: DateTime<Utc>,
    pub validated: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LayaEndpoint {
    pub url: String,
    pub pid: u32,
    pub started_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct LayaExternalCapabilities {
    pub health: bool,
    pub native_laya: bool,
    pub single: bool,
    pub batch: bool,
    pub model: Option<String>,
    pub response_format: Option<String>,
    pub health_error: Option<String>,
    pub single_error: Option<String>,
    pub batch_error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct RuntimeRecord {
    schema_version: u32,
    pid: u32,
    parent_pid: u32,
    endpoint: String,
    executable: PathBuf,
    installation_dir: PathBuf,
    started_at: DateTime<Utc>,
}

pub type ProgressSink = Arc<dyn Fn(&LayaRuntimeStatus) + Send + Sync>;

#[derive(Clone)]
pub struct LayaRuntimeManager {
    inner: Arc<ManagerInner>,
}

struct ManagerInner {
    root: PathBuf,
    state: Mutex<ManagerState>,
}

struct ManagerState {
    status: LayaRuntimeStatus,
    child: Option<Child>,
    operation: LifecycleOperation,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum LifecycleOperation {
    #[default]
    Idle,
    Installing,
    Starting,
    Uninstalling,
    CleanupRequired,
}

static MANAGER: OnceLock<LayaRuntimeManager> = OnceLock::new();
static INSTALL_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn manager() -> &'static LayaRuntimeManager {
    MANAGER.get_or_init(|| LayaRuntimeManager::new(default_root()))
}

fn notify_progress(progress: &Option<ProgressSink>, status: &LayaRuntimeStatus) {
    if let Some(sink) = progress {
        sink(status);
    }
}

pub fn default_root() -> PathBuf {
    crate::db::default_db_path()
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("laya")
}

fn candidate_installation_name() -> String {
    let sequence = INSTALL_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!(
        "{RUNTIME_VERSION}-{}-{}-{sequence}",
        Utc::now().timestamp_millis(),
        std::process::id()
    )
}

impl LayaRuntimeManager {
    pub fn new(root: PathBuf) -> Self {
        let status = inspect_installation(&root);
        let manager = Self {
            inner: Arc::new(ManagerInner {
                root,
                state: Mutex::new(ManagerState {
                    status,
                    child: None,
                    operation: LifecycleOperation::Idle,
                }),
            }),
        };
        manager.inspect_runtime_record();
        manager
    }

    pub fn status(&self) -> LayaRuntimeStatus {
        let mut state = self.inner.state.lock().unwrap();
        if let Some(child) = state.child.as_mut() {
            if let Ok(Some(exit)) = child.try_wait() {
                state.child = None;
                state.status.service_state = LayaServiceState::Failed;
                state.status.endpoint = None;
                state.status.error = Some(LayaRuntimeError {
                    stage: "start_server".into(),
                    message: format!("managed Laya exited with {exit}"),
                    log_path: Some(self.server_log()),
                    retryable: true,
                });
            }
        }
        state.status.clone()
    }

    pub fn installation_dir(&self) -> PathBuf {
        current_installation_dir(&self.inner.root)
            .unwrap_or_else(|_| self.installations_dir().join(RUNTIME_VERSION))
    }

    pub fn log_dir(&self) -> PathBuf {
        self.inner.root.join("logs")
    }

    pub fn install(&self, progress: Option<ProgressSink>) -> Result<LayaInstallation> {
        ensure_supported_platform()?;
        let _process_lock = acquire_lifecycle_lock()?;
        self.ensure_no_external_owner()?;
        let initial = {
            let mut state = self.inner.state.lock().unwrap();
            ensure!(
                state.operation == LifecycleOperation::Idle,
                "managed Laya lifecycle operation is already running"
            );
            state.operation = LifecycleOperation::Installing;
            state.status.install_state = LayaInstallState::Installing;
            state.status.service_state = LayaServiceState::Stopped;
            state.status.current_stage = Some("download_uv".into());
            state.status.progress = None;
            state.status.error = None;
            state.status.cleanup_required = false;
            state.status.clone()
        };
        notify_progress(&progress, &initial);

        let mut candidate = None;
        let result = (|| {
            self.stop_inner()
                .context("stop_server: could not stop the existing managed Laya service")?;
            self.prepare_layout()?;
            rotate_log(&self.install_log())?;
            self.set_install_stage("download_uv", None, &progress);

            let candidate_name = candidate_installation_name();
            let candidate_dir = self.installations_dir().join(&candidate_name);
            ensure!(
                !candidate_dir.exists(),
                "installation candidate already exists"
            );
            fs::create_dir_all(&candidate_dir)?;
            candidate = Some(candidate_dir.clone());
            self.install_into(&candidate_dir, &candidate_name, &progress)
        })();
        if let Err(error) = &result {
            if let Some(candidate) = candidate.as_deref() {
                if candidate.exists() {
                    let _ = safe_remove_dir_all(&self.inner.root, candidate);
                }
            }
            self.set_install_error(
                stage_from_error(error),
                format!("{error:#}"),
                true,
                &progress,
            );
        }
        let mut state = self.inner.state.lock().unwrap();
        if state.child.is_some() {
            state.operation = LifecycleOperation::CleanupRequired;
            state.status.service_state = LayaServiceState::Failed;
            state.status.cleanup_required = true;
        } else {
            state.operation = LifecycleOperation::Idle;
        }
        drop(state);
        result
    }

    fn install_into(
        &self,
        candidate_dir: &Path,
        candidate_name: &str,
        progress: &Option<ProgressSink>,
    ) -> Result<LayaInstallation> {
        let archive = candidate_dir.join("uv.zip");
        self.download_uv(&archive, progress)
            .context("download_uv: failed to download uv")?;

        self.set_install_stage("verify_uv", None, progress);
        verify_sha256(&archive, UV_WINDOWS_X86_64_SHA256)
            .context("verify_uv: uv archive checksum mismatch")?;

        let uv_dir = candidate_dir.join("uv");
        extract_zip(&archive, &uv_dir).context("verify_uv: failed to extract uv")?;
        let uv = find_file_named(&uv_dir, "uv.exe")
            .ok_or_else(|| anyhow!("verify_uv: uv.exe was not present in the archive"))?;

        self.set_install_stage("install_python", None, progress);
        let python_dir = candidate_dir.join("python");
        let mut install_python = Command::new(&uv);
        install_python
            .args([
                "python",
                "install",
                "--managed-python",
                "--no-bin",
                "--no-registry",
                "--no-config",
                PYTHON_VERSION,
            ])
            .env("UV_PYTHON_INSTALL_DIR", &python_dir)
            .env("UV_CACHE_DIR", self.inner.root.join("cache"));
        run_logged(&mut install_python, &self.install_log(), "install_python")?;

        self.set_install_stage("create_venv", None, progress);
        let venv = candidate_dir.join("venv");
        let mut create_venv = Command::new(&uv);
        create_venv
            .arg("venv")
            .arg("--managed-python")
            .arg("--no-python-downloads")
            .arg("--no-config")
            .arg("--python")
            .arg(PYTHON_VERSION)
            .arg(&venv)
            .env("UV_PYTHON_INSTALL_DIR", &python_dir)
            .env("UV_CACHE_DIR", self.inner.root.join("cache"));
        run_logged(&mut create_venv, &self.install_log(), "create_venv")?;

        self.set_install_stage("install_laya", None, progress);
        let python = venv_python(&venv);
        let mut install_laya = Command::new(&uv);
        install_laya
            .arg("pip")
            .arg("install")
            .arg("--no-config")
            .arg("--strict")
            .arg("--torch-backend")
            .arg("cpu")
            .arg("--python")
            .arg(&python)
            .arg(format!("laya[serve]=={LAYA_VERSION}"))
            .env("UV_CACHE_DIR", self.inner.root.join("cache"));
        run_logged(&mut install_laya, &self.install_log(), "install_laya")?;

        self.set_install_stage("download_model", None, progress);
        let port = select_port()?;
        let child = self
            .spawn_server(candidate_dir, port, &self.install_log())
            .context("start_server: failed to start Laya")?;
        {
            let mut state = self.inner.state.lock().unwrap();
            state.child = Some(child);
            state.status.service_state = LayaServiceState::Starting;
        }
        let endpoint = format!("http://127.0.0.1:{port}");
        let validation = (|| {
            let health = self
                .wait_for_owned_health(&endpoint, HEALTH_TIMEOUT)
                .context("health_check: Laya did not become healthy")?;
            self.set_install_stage("health_check", None, progress);
            let revision = validate_health(&health)
                .context("health_check: Laya health response is not multilingual-ready")?;
            self.set_install_stage("batch_smoke_test", None, progress);
            batch_smoke_test(&endpoint)
                .context("batch_smoke_test: Laya batch inference validation failed")?;
            Ok::<_, anyhow::Error>(revision)
        })();
        let stop_result = self.stop_inner();
        if let Err(error) = stop_result {
            return Err(error).context("stop_server: failed to stop validation server");
        }
        let model_revision = validation?;

        let installation = LayaInstallation {
            schema_version: 1,
            runtime_version: RUNTIME_VERSION.into(),
            python_version: PYTHON_VERSION.into(),
            laya_version: LAYA_VERSION.into(),
            model: MODEL.into(),
            model_revision,
            installed_at: Utc::now(),
            validated: true,
        };
        fs::write(candidate_dir.join("install-complete"), b"validated\n")?;
        fs::write(
            candidate_dir.join("installation.json"),
            serde_json::to_vec_pretty(&installation)?,
        )?;

        self.set_install_stage("activate_installation", None, progress);
        self.activate(candidate_name, &installation)
            .context("activate_installation: failed to activate validated Laya")?;
        self.update_status(progress, |status| {
            status.install_state = LayaInstallState::Installed;
            status.service_state = LayaServiceState::Stopped;
            status.installed_version = Some(RUNTIME_VERSION.into());
            status.model_revision = Some(installation.model_revision.clone());
            status.endpoint = None;
            status.current_stage = Some("complete".into());
            status.progress = None;
            status.error = None;
        });
        Ok(installation)
    }

    pub fn start(&self) -> Result<LayaEndpoint> {
        ensure_supported_platform()?;
        if let Ok(endpoint) = self.ready_endpoint() {
            return Ok(LayaEndpoint {
                url: endpoint,
                pid: self
                    .inner
                    .state
                    .lock()
                    .unwrap()
                    .child
                    .as_ref()
                    .map(Child::id)
                    .unwrap_or_default(),
                started_at: Utc::now(),
            });
        }
        let _process_lock = acquire_lifecycle_lock()?;
        self.ensure_no_external_owner()?;
        {
            let mut state = self.inner.state.lock().unwrap();
            ensure!(
                state.operation == LifecycleOperation::Idle,
                "managed Laya lifecycle operation is already running"
            );
            state.operation = LifecycleOperation::Starting;
            state.status.service_state = LayaServiceState::Starting;
            state.status.current_stage = Some("start_server".into());
            state.status.progress = None;
            state.status.error = None;
            state.status.cleanup_required = false;
            state.status.endpoint = None;
        }
        let result = (|| {
            let installation = load_valid_installation(&self.inner.root)?;
            let installation_dir = current_installation_dir(&self.inner.root)?;
            let python = venv_python(&installation_dir.join("venv"));
            ensure!(python.is_file(), "managed Laya Python is missing");
            let port = select_port()?;
            let endpoint = format!("http://127.0.0.1:{port}");
            rotate_log(&self.server_log())?;
            let mut child = self.spawn_server(&installation_dir, port, &self.server_log())?;
            let pid = child.id();
            {
                let mut state = self.inner.state.lock().unwrap();
                if state.operation != LifecycleOperation::Starting
                    || state.status.service_state != LayaServiceState::Starting
                {
                    stop_child(&mut child)?;
                    bail!("managed Laya start was cancelled");
                }
                state.child = Some(child);
            }

            let health = self
                .wait_for_owned_health(&endpoint, HEALTH_TIMEOUT)
                .context("health_check: managed Laya did not become healthy")?;
            let revision = validate_health(&health)
                .context("health_check: managed Laya health response is invalid")?;
            let started_at = Utc::now();
            let record = RuntimeRecord {
                schema_version: 1,
                pid,
                parent_pid: std::process::id(),
                endpoint: endpoint.clone(),
                executable: python,
                installation_dir,
                started_at,
            };
            {
                let mut state = self.inner.state.lock().unwrap();
                ensure!(
                    state.operation == LifecycleOperation::Starting
                        && state.status.service_state == LayaServiceState::Starting
                        && state.child.as_ref().map(Child::id) == Some(pid),
                    "managed Laya start was cancelled"
                );
                atomic_write_json(&self.runtime_file(), &record)
                    .context("start_server: could not save managed Laya runtime state")?;
                state.status.install_state = LayaInstallState::Installed;
                state.status.service_state = LayaServiceState::Ready;
                state.status.installed_version = Some(installation.runtime_version);
                state.status.model_revision = Some(revision);
                state.status.endpoint = Some(endpoint.clone());
                state.status.current_stage = None;
                state.status.progress = None;
                state.status.error = None;
                state.status.cleanup_required = false;
                state.operation = LifecycleOperation::Idle;
            }
            Ok(LayaEndpoint {
                url: endpoint,
                pid,
                started_at,
            })
        })();

        if let Err(error) = &result {
            let cancelled =
                self.inner.state.lock().unwrap().status.service_state == LayaServiceState::Stopped;
            let cleanup_error = self.stop_inner().err();
            let mut state = self.inner.state.lock().unwrap();
            if !cancelled {
                let stage = service_stage_from_error(error);
                let cleanup_required = cleanup_error.is_some();
                let message = match cleanup_error.as_ref() {
                    Some(cleanup) => format!("{error:#}; cleanup failed: {cleanup:#}"),
                    None => format!("{error:#}"),
                };
                state.status.service_state = LayaServiceState::Failed;
                state.status.endpoint = None;
                state.status.current_stage = Some(stage.into());
                state.status.error = Some(LayaRuntimeError {
                    stage: stage.into(),
                    message,
                    log_path: Some(self.server_log()),
                    retryable: true,
                });
                state.status.cleanup_required = cleanup_required;
                state.operation = if cleanup_required {
                    LifecycleOperation::CleanupRequired
                } else {
                    LifecycleOperation::Idle
                };
            } else {
                state.operation = LifecycleOperation::Idle;
            }
        }
        result
    }

    pub fn stop(&self) -> Result<()> {
        let internal_operation = self.inner.state.lock().unwrap().operation;
        let _process_lock = if internal_operation == LifecycleOperation::Idle {
            Some(acquire_lifecycle_lock()?)
        } else {
            None
        };
        self.ensure_no_external_owner()?;
        self.stop_inner()?;
        let mut state = self.inner.state.lock().unwrap();
        state.operation = LifecycleOperation::Idle;
        state.status.cleanup_required = false;
        Ok(())
    }

    fn stop_inner(&self) -> Result<()> {
        let mut state = self.inner.state.lock().unwrap();
        if state.child.is_none() && state.status.service_state == LayaServiceState::Ready {
            let record = read_json::<RuntimeRecord>(&self.runtime_file())
                .context("managed Laya runtime record is missing")?;
            drop(state);
            terminate_recorded_process(&record)?;
            state = self.inner.state.lock().unwrap();
        }
        let child = state.child.take();
        drop(state);
        if let Some(mut child) = child {
            if let Err(error) = stop_child(&mut child) {
                if child.try_wait().ok().flatten().is_none() {
                    self.inner.state.lock().unwrap().child = Some(child);
                }
                return Err(error).context("stop_server: failed to stop managed Laya");
            }
        }
        if self.runtime_file().is_file() {
            let _ = fs::remove_file(self.runtime_file());
        }
        self.update_status(&None, |status| {
            status.service_state = LayaServiceState::Stopped;
            status.endpoint = None;
            status.current_stage = None;
            status.progress = None;
            status.cleanup_required = false;
        });
        Ok(())
    }

    pub fn uninstall(&self, delete_models: bool) -> Result<()> {
        let _process_lock = acquire_lifecycle_lock()?;
        self.ensure_no_external_owner()?;
        {
            let mut state = self.inner.state.lock().unwrap();
            ensure!(
                state.operation == LifecycleOperation::Idle,
                "managed Laya lifecycle operation is already running"
            );
            state.operation = LifecycleOperation::Uninstalling;
        }
        let result = (|| {
            self.stop_inner()?;
            if let Ok(directory) = current_installation_dir(&self.inner.root) {
                if directory.exists() {
                    safe_remove_dir_all(&self.inner.root, &directory)?;
                }
            }
            for file in [
                self.manifest_file(),
                self.current_file(),
                self.runtime_file(),
            ] {
                if file.is_file() {
                    fs::remove_file(file)?;
                }
            }
            if delete_models {
                let models = self.inner.root.join("models");
                if models.exists() {
                    safe_remove_dir_all(&self.inner.root, &models)?;
                }
            }
            Ok(())
        })();
        let mut state = self.inner.state.lock().unwrap();
        state.operation = LifecycleOperation::Idle;
        if result.is_ok() {
            state.status = LayaRuntimeStatus::default();
        } else {
            let mut restored = inspect_installation(&self.inner.root);
            restored.error = Some(LayaRuntimeError {
                stage: "uninstall".into(),
                message: format!("{:#}", result.as_ref().unwrap_err()),
                log_path: Some(self.install_log()),
                retryable: true,
            });
            restored.current_stage = Some("uninstall".into());
            restored.cleanup_required = state.child.is_some();
            if restored.cleanup_required {
                restored.service_state = LayaServiceState::Failed;
                state.operation = LifecycleOperation::CleanupRequired;
            }
            state.status = restored;
        }
        result
    }

    pub fn ready_endpoint(&self) -> Result<String> {
        let status = self.status();
        match status.service_state {
            LayaServiceState::Ready => status
                .endpoint
                .ok_or_else(|| anyhow!("managed Laya is ready but has no endpoint")),
            LayaServiceState::Starting => bail!("managed Laya is still starting"),
            LayaServiceState::Failed => bail!(
                "managed Laya failed to start: {}",
                status
                    .error
                    .map(|error| error.message)
                    .unwrap_or_else(|| "see the server log".into())
            ),
            LayaServiceState::Stopped => match status.install_state {
                LayaInstallState::NotInstalled => bail!("managed Laya is not installed"),
                LayaInstallState::Installing => bail!("managed Laya is being installed"),
                LayaInstallState::Broken => bail!("managed Laya installation is damaged"),
                LayaInstallState::Installed => bail!("managed Laya is installed but not running"),
            },
        }
    }

    fn prepare_layout(&self) -> Result<()> {
        for directory in [
            self.inner.root.clone(),
            self.installations_dir(),
            self.inner.root.join("models").join("huggingface"),
            self.inner.root.join("staging"),
            self.log_dir(),
            self.inner.root.join("cache"),
        ] {
            fs::create_dir_all(directory)?;
        }
        Ok(())
    }

    fn download_uv(&self, destination: &Path, progress: &Option<ProgressSink>) -> Result<()> {
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(10 * 60))
            .build()?;
        let mut response = client.get(UV_WINDOWS_X86_64_URL).send()?;
        ensure!(
            response.status().is_success(),
            "uv download returned {}",
            response.status()
        );
        let total = response.content_length();
        let mut output = File::create(destination)?;
        let mut downloaded = 0_u64;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let count = response.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            output.write_all(&buffer[..count])?;
            downloaded += count as u64;
            let ratio = total
                .filter(|total| *total > 0)
                .map(|total| (downloaded as f32 / total as f32).clamp(0.0, 1.0));
            self.set_install_stage("download_uv", ratio, progress);
        }
        output.sync_all()?;
        if let Some(total) = total {
            ensure!(
                downloaded == total,
                "uv download ended before all bytes arrived"
            );
        }
        Ok(())
    }

    fn spawn_server(&self, installation_dir: &Path, port: u16, log_path: &Path) -> Result<Child> {
        let python = venv_python(&installation_dir.join("venv"));
        ensure!(
            python.is_file(),
            "managed Python is missing at {}",
            python.display()
        );
        let stdout = append_log(log_path)?;
        let stderr = stdout.try_clone()?;
        let mut command = Command::new(&python);
        command
            .args(["-m", "laya.serve"])
            .current_dir(installation_dir)
            .env("LAYA_HOST", "127.0.0.1")
            .env("LAYA_PORT", port.to_string())
            .env("LAYA_MODELS", MODEL_NAME)
            .env("LAYA_DEFAULT_MODEL", MODEL_NAME)
            .env("LAYA_PRELOAD", "1")
            .env("LAYA_LOG_LEVEL", "info")
            .env(
                "HF_HOME",
                self.inner.root.join("models").join("huggingface"),
            )
            .env("USE_TF", "0")
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr));
        hide_window(&mut command);
        command.spawn().context("could not spawn managed Laya")
    }

    fn wait_for_owned_health(&self, endpoint: &str, timeout: Duration) -> Result<Value> {
        let deadline = Instant::now() + timeout;
        loop {
            {
                let mut state = self.inner.state.lock().unwrap();
                let child = state
                    .child
                    .as_mut()
                    .ok_or_else(|| anyhow!("managed Laya process is no longer owned"))?;
                if let Some(exit) = child.try_wait()? {
                    state.child = None;
                    bail!("managed Laya exited with {exit}");
                }
            }
            if let Ok(health) = fetch_health(endpoint) {
                return Ok(health);
            }
            ensure!(
                Instant::now() < deadline,
                "timed out waiting for managed Laya"
            );
            std::thread::sleep(Duration::from_millis(500));
        }
    }

    fn activate(&self, candidate_name: &str, installation: &LayaInstallation) -> Result<()> {
        ensure!(
            valid_installation_name(candidate_name),
            "invalid installation candidate name"
        );
        let target = self.installations_dir().join(candidate_name);
        ensure!(target.is_dir(), "installation candidate is missing");
        let previous_manifest = fs::read(self.manifest_file()).ok();
        let previous_current = fs::read(self.current_file()).ok();
        let metadata = serde_json::to_vec_pretty(installation)?;
        let activation = (|| {
            atomic_write(&self.manifest_file(), &metadata)?;
            atomic_write(
                &self.current_file(),
                format!("{candidate_name}\n").as_bytes(),
            )?;
            Ok::<_, anyhow::Error>(())
        })();
        if let Err(error) = activation {
            restore_file(&self.manifest_file(), previous_manifest.as_deref())
                .context("could not restore the previous installation manifest")?;
            restore_file(&self.current_file(), previous_current.as_deref())
                .context("could not restore the previous current installation")?;
            return Err(error).context("could not switch the current installation");
        }

        if let Some(previous) = previous_current
            .as_deref()
            .and_then(|bytes| std::str::from_utf8(bytes).ok())
            .map(str::trim)
            .filter(|name| valid_installation_name(name) && *name != candidate_name)
        {
            let previous = self.installations_dir().join(previous);
            if previous.exists() {
                let _ = safe_remove_dir_all(&self.inner.root, &previous);
            }
        }
        Ok(())
    }

    fn inspect_runtime_record(&self) {
        let path = self.runtime_file();
        let Ok(record) = read_json::<RuntimeRecord>(&path) else {
            return;
        };
        let expected_dir = match current_installation_dir(&self.inner.root) {
            Ok(path) => path,
            Err(_) => {
                let _ = fs::remove_file(path);
                return;
            }
        };
        if record.installation_dir != expected_dir
            || record.executable != venv_python(&expected_dir.join("venv"))
            || !record.endpoint.starts_with("http://127.0.0.1:")
        {
            let _ = fs::remove_file(path);
            return;
        }
        match inspect_recorded_process(&record) {
            RecordedProcessState::MissingOrUnrelated | RecordedProcessState::Terminated => {
                let _ = fs::remove_file(path);
            }
            RecordedProcessState::LiveOwner => {
                self.adopt_runtime_record(&record);
            }
            RecordedProcessState::TerminationFailed => {
                self.set_service_error(
                    "stop_server",
                    "a stale managed Laya process could not be terminated safely".into(),
                );
            }
        }
    }

    fn ensure_no_external_owner(&self) -> Result<()> {
        let path = self.runtime_file();
        if !path.is_file() {
            return Ok(());
        }
        let record = match read_json::<RuntimeRecord>(&path) {
            Ok(record) => record,
            Err(_) => {
                fs::remove_file(path)?;
                return Ok(());
            }
        };
        let owned_here = self
            .inner
            .state
            .lock()
            .unwrap()
            .child
            .as_ref()
            .is_some_and(|child| child.id() == record.pid);
        if owned_here {
            return Ok(());
        }
        match inspect_recorded_process(&record) {
            RecordedProcessState::MissingOrUnrelated | RecordedProcessState::Terminated => {
                fs::remove_file(path)?;
                Ok(())
            }
            RecordedProcessState::LiveOwner => {
                self.adopt_runtime_record(&record);
                Ok(())
            }
            RecordedProcessState::TerminationFailed => {
                bail!("a stale managed Laya process could not be terminated safely")
            }
        }
    }

    fn update_status(
        &self,
        progress: &Option<ProgressSink>,
        update: impl FnOnce(&mut LayaRuntimeStatus),
    ) {
        let snapshot = {
            let mut state = self.inner.state.lock().unwrap();
            update(&mut state.status);
            state.status.clone()
        };
        if let Some(sink) = progress {
            sink(&snapshot);
        }
    }

    fn adopt_runtime_record(&self, record: &RuntimeRecord) {
        self.update_status(&None, |status| {
            status.install_state = LayaInstallState::Installed;
            status.service_state = LayaServiceState::Ready;
            status.endpoint = Some(record.endpoint.clone());
            status.current_stage = None;
            status.progress = None;
            status.error = None;
            status.cleanup_required = false;
            if status.installed_version.is_none() {
                status.installed_version = Some(RUNTIME_VERSION.into());
            }
        });
    }

    fn set_install_stage(&self, stage: &str, value: Option<f32>, progress: &Option<ProgressSink>) {
        self.update_status(progress, |status| {
            status.install_state = LayaInstallState::Installing;
            status.service_state = LayaServiceState::Stopped;
            status.current_stage = Some(stage.into());
            status.progress = value;
            status.error = None;
        });
    }

    fn set_install_error(
        &self,
        stage: &str,
        message: String,
        retryable: bool,
        progress: &Option<ProgressSink>,
    ) {
        let mut restored = inspect_installation(&self.inner.root);
        restored.service_state = LayaServiceState::Stopped;
        restored.current_stage = Some(stage.into());
        restored.progress = None;
        restored.error = Some(LayaRuntimeError {
            stage: stage.into(),
            message,
            log_path: Some(self.install_log()),
            retryable,
        });
        let snapshot = {
            let mut state = self.inner.state.lock().unwrap();
            state.status = restored;
            state.status.clone()
        };
        notify_progress(progress, &snapshot);
    }

    fn set_service_error(&self, stage: &str, message: String) {
        self.update_status(&None, |status| {
            status.service_state = LayaServiceState::Failed;
            status.endpoint = None;
            status.current_stage = Some(stage.into());
            status.error = Some(LayaRuntimeError {
                stage: stage.into(),
                message,
                log_path: Some(self.server_log()),
                retryable: true,
            });
        });
    }

    fn installations_dir(&self) -> PathBuf {
        self.inner.root.join("installations")
    }

    fn manifest_file(&self) -> PathBuf {
        self.inner.root.join("installation.json")
    }

    fn current_file(&self) -> PathBuf {
        self.inner.root.join("current.txt")
    }

    fn runtime_file(&self) -> PathBuf {
        self.inner.root.join("runtime.json")
    }

    fn install_log(&self) -> PathBuf {
        self.log_dir().join("install.log")
    }

    fn server_log(&self) -> PathBuf {
        self.log_dir().join("server.log")
    }
}

fn inspect_installation(root: &Path) -> LayaRuntimeStatus {
    match load_valid_installation(root) {
        Ok(installation) => LayaRuntimeStatus {
            install_state: LayaInstallState::Installed,
            service_state: LayaServiceState::Stopped,
            installed_version: Some(installation.runtime_version),
            model_revision: Some(installation.model_revision),
            ..Default::default()
        },
        Err(_error)
            if !root.join("installation.json").exists() && !root.join("current.txt").exists() =>
        {
            LayaRuntimeStatus::default()
        }
        Err(error) => LayaRuntimeStatus {
            install_state: LayaInstallState::Broken,
            service_state: LayaServiceState::Stopped,
            error: Some(LayaRuntimeError {
                stage: "load_installation".into(),
                message: error.to_string(),
                log_path: Some(root.join("logs").join("install.log")),
                retryable: true,
            }),
            ..Default::default()
        },
    }
}

fn load_valid_installation(root: &Path) -> Result<LayaInstallation> {
    let directory = current_installation_dir(root)?;
    let installation: LayaInstallation = read_json(&directory.join("installation.json"))?;
    ensure!(
        installation.schema_version == 1,
        "unsupported Laya installation schema"
    );
    ensure!(
        installation.validated,
        "Laya installation was not validated"
    );
    ensure!(
        installation.runtime_version == RUNTIME_VERSION,
        "installed Laya runtime version is not supported"
    );
    ensure!(
        directory.join("install-complete").is_file(),
        "Laya install marker is missing"
    );
    ensure!(
        venv_python(&directory.join("venv")).is_file(),
        "managed Python is missing"
    );
    Ok(installation)
}

fn current_installation_dir(root: &Path) -> Result<PathBuf> {
    let current = fs::read_to_string(root.join("current.txt"))?;
    let current = current.trim();
    ensure!(
        valid_installation_name(current),
        "invalid managed Laya current installation"
    );
    Ok(root.join("installations").join(current))
}

fn valid_installation_name(name: &str) -> bool {
    if name == RUNTIME_VERSION {
        return true;
    }
    name.strip_prefix(&format!("{RUNTIME_VERSION}-"))
        .is_some_and(|suffix| {
            !suffix.is_empty()
                && suffix
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || byte == b'-')
        })
}

pub fn systemone_endpoint(raw: &str, batch: bool) -> Result<String> {
    let raw = raw.trim().trim_end_matches('/');
    ensure!(!raw.is_empty(), "SystemOne API URL is empty");
    let base = raw
        .strip_suffix("/v1/systemone/batch")
        .or_else(|| raw.strip_suffix("/v1/systemone"))
        .or_else(|| raw.strip_suffix("/v1"))
        .unwrap_or(raw);
    Ok(if batch {
        format!("{base}/v1/systemone/batch")
    } else {
        format!("{base}/v1/systemone")
    })
}

pub fn probe_external_service(
    raw: &str,
    api_key: &str,
    model: &str,
    timeout: Duration,
) -> Result<LayaExternalCapabilities> {
    let single_url = systemone_endpoint(raw, false)?;
    let batch_url = systemone_endpoint(raw, true)?;
    let base = single_url
        .strip_suffix("/v1/systemone")
        .ok_or_else(|| anyhow!("could not normalize the SystemOne base URL"))?;
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(timeout)
        .build()?;
    let mut capabilities = LayaExternalCapabilities::default();

    match client.get(format!("{base}/health")).send() {
        Ok(response) if response.status().is_success() => match response.json::<Value>() {
            Ok(value) => {
                capabilities.health = true;
                capabilities.native_laya = value.get("status").and_then(Value::as_str)
                    == Some("ok")
                    && (value.get("loaded").is_some() || value.get("revisions").is_some());
                capabilities.model = value
                    .get("loaded")
                    .and_then(Value::as_array)
                    .and_then(|loaded| loaded.first())
                    .and_then(Value::as_str)
                    .map(str::to_owned);
            }
            Err(error) => capabilities.health_error = Some(format!("invalid health JSON: {error}")),
        },
        Ok(response) => {
            capabilities.health_error = Some(format!("health returned {}", response.status()))
        }
        Err(error) => capabilities.health_error = Some(error.to_string()),
    }

    let questions = json!({
        "capability_probe": {
            "type": "noul",
            "instructions": "Does this text confirm that the service is reachable?"
        }
    });
    let state = json!({"document": "ContextOS capability probe."});
    let single_body =
        json!({"model": model, "state": state.clone(), "questions": questions.clone()});
    match send_probe_request(&client, &single_url, api_key, &single_body) {
        Ok(value)
            if value
                .pointer("/answers/capability_probe/noul")
                .and_then(Value::as_f64)
                .is_some() =>
        {
            capabilities.single = true;
            capabilities.response_format = Some("systemone".into());
            capabilities.model = value
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or(capabilities.model);
        }
        Ok(_) => {
            capabilities.single_error = Some("single response is not SystemOne-compatible".into())
        }
        Err(error) => capabilities.single_error = Some(error.to_string()),
    }

    let batch_body = json!({
        "model": model,
        "states": [state.clone(), state],
        "questions": questions
    });
    match send_probe_request(&client, &batch_url, api_key, &batch_body) {
        Ok(value) => match validate_probe_batch_response(&value, 2) {
            Ok(()) => {
                capabilities.batch = true;
                capabilities.response_format = Some("systemone_batch".into());
            }
            Err(error) => capabilities.batch_error = Some(error.to_string()),
        },
        Err(error) => capabilities.batch_error = Some(error.to_string()),
    }
    Ok(capabilities)
}

fn send_probe_request(
    client: &reqwest::blocking::Client,
    url: &str,
    api_key: &str,
    body: &Value,
) -> Result<Value> {
    let mut request = client.post(url).json(body);
    if !api_key.trim().is_empty() {
        request = request.bearer_auth(api_key.trim());
    }
    let response = request.send()?;
    let status = response.status();
    let text = response.text()?;
    ensure!(
        status.is_success(),
        "{} returned {}: {}",
        url_path(url),
        status,
        text.chars().take(500).collect::<String>()
    );
    Ok(serde_json::from_str(text.trim_start_matches('\u{feff}'))?)
}

fn validate_probe_batch_response(value: &Value, expected: usize) -> Result<()> {
    let results = value
        .get("results")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("batch response is missing results"))?;
    ensure!(
        results.len() == expected,
        "batch result count does not match state count"
    );
    ensure!(
        results.iter().all(|result| result
            .pointer("/answers/capability_probe/noul")
            .and_then(Value::as_f64)
            .is_some()),
        "batch results are not SystemOne-compatible"
    );
    Ok(())
}

fn url_path(url: &str) -> &str {
    url.split_once("://")
        .and_then(|(_, rest)| rest.find('/').map(|index| &rest[index..]))
        .unwrap_or(url)
}

fn fetch_health(endpoint: &str) -> Result<Value> {
    let response = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(1))
        .timeout(Duration::from_secs(3))
        .build()?
        .get(format!("{}/health", endpoint.trim_end_matches('/')))
        .send()?;
    ensure!(
        response.status().is_success(),
        "health returned {}",
        response.status()
    );
    Ok(response.json()?)
}

fn validate_health(value: &Value) -> Result<String> {
    ensure!(
        value.get("status").and_then(Value::as_str) == Some("ok"),
        "status is not ok"
    );
    let loaded = value
        .get("loaded")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("health is missing loaded checkpoints"))?;
    ensure!(
        loaded.iter().any(|item| item.as_str() == Some(MODEL_NAME)),
        "multilingual checkpoint is not loaded"
    );
    value
        .get("revisions")
        .and_then(|revisions| revisions.get(MODEL_NAME))
        .and_then(Value::as_str)
        .filter(|revision| !revision.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("health is missing multilingual model revision"))
}

fn batch_smoke_test(endpoint: &str) -> Result<()> {
    let url = systemone_endpoint(endpoint, true)?;
    let body = json!({
        "model": MODEL,
        "states": [
            {"document": "Keep the exact error code E104 for the incident report."},
            {"document": "The operation completed successfully with no additional output."}
        ],
        "questions": {
            "preservation_level": {
                "type": "score",
                "instructions": "How strongly should this evidence be preserved?",
                "criteria": ["discardable", "useful", "critical evidence"]
            },
            "irreplaceable_evidence": {
                "type": "noul",
                "instructions": "Does this state contain evidence that cannot be reconstructed reliably?"
            }
        }
    });
    let response = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5 * 60))
        .build()?
        .post(url)
        .json(&body)
        .send()?;
    let status = response.status();
    let text = response.text()?;
    ensure!(status.is_success(), "batch returned {status}: {text}");
    let value: Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))?;
    validate_batch_response(&value, 2)
}

fn validate_batch_response(value: &Value, expected: usize) -> Result<()> {
    let results = value
        .get("results")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("batch response is missing results"))?;
    ensure!(
        results.len() == expected,
        "batch result count does not match state count"
    );
    for (index, result) in results.iter().enumerate() {
        let score = result.pointer("/answers/preservation_level/score");
        let noul = result.pointer("/answers/irreplaceable_evidence/noul");
        ensure!(
            score.and_then(Value::as_f64).is_some(),
            "result {index} has no score"
        );
        ensure!(
            noul.and_then(Value::as_f64).is_some(),
            "result {index} has no noul"
        );
    }
    Ok(())
}

fn select_port() -> Result<u16> {
    for port in FIRST_PORT..=LAST_PORT {
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Ok(port);
        }
    }
    bail!("no managed Laya port is available in {FIRST_PORT}-{LAST_PORT}")
}

fn ensure_supported_platform() -> Result<()> {
    ensure!(
        cfg!(all(target_os = "windows", target_arch = "x86_64")),
        "managed Laya is currently available only on Windows x86_64"
    );
    Ok(())
}

fn run_logged(command: &mut Command, log_path: &Path, stage: &str) -> Result<()> {
    let stdout = append_log(log_path)?;
    let stderr = stdout.try_clone()?;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    hide_window(command);
    let status = command
        .status()
        .with_context(|| format!("{stage}: could not start subprocess"))?;
    ensure!(status.success(), "{stage}: subprocess exited with {status}");
    Ok(())
}

fn append_log(path: &Path) -> io::Result<File> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    OpenOptions::new().create(true).append(true).open(path)
}

fn rotate_log(path: &Path) -> Result<()> {
    let Some(metadata) = fs::metadata(path).ok() else {
        return Ok(());
    };
    if metadata.len() < LOG_LIMIT_BYTES {
        return Ok(());
    }
    let rotated = path.with_extension("log.1");
    if rotated.exists() {
        fs::remove_file(&rotated)?;
    }
    fs::rename(path, rotated)?;
    Ok(())
}

fn verify_sha256(path: &Path, expected: &str) -> Result<()> {
    let mut input = File::open(path)?;
    let mut digest = Sha256::new();
    io::copy(&mut input, &mut digest)?;
    let actual = format!("{:x}", digest.finalize());
    ensure!(
        actual.eq_ignore_ascii_case(expected),
        "expected {expected}, got {actual}"
    );
    Ok(())
}

fn extract_zip(archive: &Path, destination: &Path) -> Result<()> {
    fs::create_dir_all(destination)?;
    let input = File::open(archive)?;
    let mut zip = zip::ZipArchive::new(input)?;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index)?;
        let relative = entry
            .enclosed_name()
            .ok_or_else(|| anyhow!("zip entry contains an unsafe path"))?
            .to_path_buf();
        let output = destination.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&output)?;
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = File::create(output)?;
        io::copy(&mut entry, &mut file)?;
    }
    Ok(())
}

fn find_file_named(root: &Path, name: &str) -> Option<PathBuf> {
    let direct = root.join(name);
    if direct.is_file() {
        return Some(direct);
    }
    fs::read_dir(root).ok()?.flatten().find_map(|entry| {
        let path = entry.path();
        if path.is_dir() {
            find_file_named(&path, name)
        } else if path.file_name().and_then(|part| part.to_str()) == Some(name) {
            Some(path)
        } else {
            None
        }
    })
}

fn venv_python(venv: &Path) -> PathBuf {
    if cfg!(windows) {
        venv.join("Scripts").join("python.exe")
    } else {
        venv.join("bin").join("python")
    }
}

fn safe_remove_dir_all(root: &Path, target: &Path) -> Result<()> {
    let root = absolute_lexical(root)?;
    let target = absolute_lexical(target)?;
    ensure!(target != root, "refusing to delete the managed Laya root");
    ensure!(
        target.starts_with(&root),
        "refusing to delete outside the managed Laya root"
    );
    let canonical_root = fs::canonicalize(&root)
        .with_context(|| format!("could not resolve managed Laya root {}", root.display()))?;
    let canonical_target = fs::canonicalize(&target)
        .with_context(|| format!("could not resolve deletion target {}", target.display()))?;
    ensure!(
        canonical_target != canonical_root && canonical_target.starts_with(&canonical_root),
        "refusing to delete through a link or junction outside the managed Laya root"
    );
    let metadata = fs::symlink_metadata(&target)?;
    ensure!(
        !metadata.file_type().is_symlink(),
        "refusing to recursively delete a link"
    );
    fs::remove_dir_all(target)?;
    Ok(())
}

fn absolute_lexical(path: &Path) -> Result<PathBuf> {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                ensure!(clean.pop(), "path escapes its root");
            }
            other => clean.push(other.as_os_str()),
        }
    }
    Ok(clean)
}

fn atomic_write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    atomic_write(path, &serde_json::to_vec_pretty(value)?)
}

fn restore_file(path: &Path, previous: Option<&[u8]>) -> Result<()> {
    match previous {
        Some(bytes) => atomic_write(path, bytes),
        None if path.exists() => fs::remove_file(path).map_err(Into::into),
        None => Ok(()),
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or_else(|| anyhow!("path has no parent"))?;
    fs::create_dir_all(parent)?;
    let temp = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("write"),
        std::process::id()
    ));
    {
        let mut file = File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    replace_file(&temp, path)?;
    Ok(())
}

#[cfg(windows)]
fn replace_file(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt as _;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    let ok = unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(from: &Path, to: &Path) -> io::Result<()> {
    fs::rename(from, to)
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T> {
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}

fn stop_child(child: &mut Child) -> Result<()> {
    match child.try_wait()? {
        Some(_) => Ok(()),
        None => {
            child.kill()?;
            child.wait()?;
            Ok(())
        }
    }
}

fn stage_from_error(error: &anyhow::Error) -> &str {
    let text = format!("{error:#}");
    [
        "download_uv",
        "verify_uv",
        "install_python",
        "create_venv",
        "install_laya",
        "download_model",
        "start_server",
        "health_check",
        "batch_smoke_test",
        "stop_server",
        "activate_installation",
    ]
    .into_iter()
    .find(|stage| text.contains(stage))
    .unwrap_or("install_laya")
}

fn service_stage_from_error(error: &anyhow::Error) -> &'static str {
    let text = format!("{error:#}");
    if text.contains("health_check") {
        "health_check"
    } else {
        "start_server"
    }
}

#[cfg(windows)]
struct CrossProcessLifecycleGuard(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl Drop for CrossProcessLifecycleGuard {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::ReleaseMutex;

        unsafe {
            ReleaseMutex(self.0);
            CloseHandle(self.0);
        }
    }
}

#[cfg(windows)]
fn acquire_lifecycle_lock() -> Result<CrossProcessLifecycleGuard> {
    use std::os::windows::ffi::OsStrExt as _;
    use windows_sys::Win32::Foundation::{WAIT_ABANDONED, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{CreateMutexW, WaitForSingleObject};

    let name = std::ffi::OsStr::new("Local\\ContextOS.ManagedLaya.Lifecycle")
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
    if handle.is_null() {
        return Err(io::Error::last_os_error()).context("could not create Laya lifecycle mutex");
    }
    let wait = unsafe { WaitForSingleObject(handle, 0) };
    if wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED {
        Ok(CrossProcessLifecycleGuard(handle))
    } else {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
        bail!("managed Laya lifecycle operation is running in another ContextOS process")
    }
}

#[cfg(not(windows))]
struct CrossProcessLifecycleGuard;

#[cfg(not(windows))]
fn acquire_lifecycle_lock() -> Result<CrossProcessLifecycleGuard> {
    Ok(CrossProcessLifecycleGuard)
}

#[cfg(windows)]
fn hide_window(command: &mut Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_window(_: &mut Command) {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RecordedProcessState {
    MissingOrUnrelated,
    LiveOwner,
    Terminated,
    TerminationFailed,
}

#[cfg(windows)]
fn inspect_recorded_process(record: &RuntimeRecord) -> RecordedProcessState {
    use sysinfo::{Pid, System};

    let system = System::new_all();
    let pid = Pid::from_u32(record.pid);
    let Some(process) = system.process(pid) else {
        return RecordedProcessState::MissingOrUnrelated;
    };
    let command = process
        .cmd()
        .iter()
        .map(|part| part.to_string_lossy())
        .collect::<Vec<_>>();
    let executable_matches = process
        .exe()
        .is_some_and(|path| paths_equal(path, &record.executable));
    let parent_matches = process.parent().map(Pid::as_u32) == Some(record.parent_pid);
    let command_matches = command.iter().any(|part| part.as_ref() == "-m")
        && command.iter().any(|part| part.as_ref() == "laya.serve");
    if !executable_matches || !parent_matches || !command_matches {
        return RecordedProcessState::MissingOrUnrelated;
    }
    // The runtime is a shared service. Its parent ContextOS process may exit
    // while MCP/CLI clients continue using it, so parent liveness is not an
    // ownership boundary. The executable, parent pid recorded at launch, and
    // command shape above are the identity check.
    RecordedProcessState::LiveOwner
}

#[cfg(windows)]
fn terminate_recorded_process(record: &RuntimeRecord) -> Result<()> {
    use sysinfo::{Pid, System};

    let system = System::new_all();
    let pid = Pid::from_u32(record.pid);
    let process = system
        .process(pid)
        .ok_or_else(|| anyhow!("managed Laya process {} is no longer running", record.pid))?;
    let command = process
        .cmd()
        .iter()
        .map(|part| part.to_string_lossy())
        .collect::<Vec<_>>();
    ensure!(
        process
            .exe()
            .is_some_and(|path| paths_equal(path, &record.executable))
            && process.parent().map(Pid::as_u32) == Some(record.parent_pid)
            && command.iter().any(|part| part.as_ref() == "-m")
            && command.iter().any(|part| part.as_ref() == "laya.serve"),
        "refusing to stop an unrelated process recorded for managed Laya"
    );
    ensure!(
        process.kill(),
        "could not stop managed Laya process {}",
        record.pid
    );
    Ok(())
}

#[cfg(not(windows))]
fn terminate_recorded_process(_: &RuntimeRecord) -> Result<()> {
    bail!("cross-process managed Laya control is only available on Windows x86_64")
}

#[cfg(not(windows))]
fn inspect_recorded_process(_: &RuntimeRecord) -> RecordedProcessState {
    RecordedProcessState::MissingOrUnrelated
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    if cfg!(windows) {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    } else {
        left == right
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_systemone_endpoints_once() {
        assert_eq!(
            systemone_endpoint("http://127.0.0.1:1338/v1/systemone", true).unwrap(),
            "http://127.0.0.1:1338/v1/systemone/batch"
        );
        assert_eq!(
            systemone_endpoint("http://127.0.0.1:1338/v1/systemone/batch", false).unwrap(),
            "http://127.0.0.1:1338/v1/systemone"
        );
    }

    #[test]
    fn validates_health_model_and_revision() {
        let health = json!({
            "status": "ok",
            "loaded": ["multilingual"],
            "revisions": {"multilingual": "abc123"}
        });
        assert_eq!(validate_health(&health).unwrap(), "abc123");
        assert!(validate_health(&json!({"status":"ok"})).is_err());
    }

    #[test]
    fn validates_every_batch_result() {
        let answer = json!({
            "answers": {
                "preservation_level": {"score": 1.0},
                "irreplaceable_evidence": {"noul": 0.5}
            }
        });
        assert!(validate_batch_response(&json!({"results":[answer.clone(), answer]}), 2).is_ok());
        assert!(validate_batch_response(&json!({"results":[]}), 2).is_err());
    }

    #[test]
    fn validates_probe_batch_shape() {
        let answer = json!({"answers":{"capability_probe":{"noul":0.7}}});
        assert!(
            validate_probe_batch_response(&json!({"results":[answer.clone(), answer]}), 2).is_ok()
        );
        assert!(validate_probe_batch_response(&json!({"results":[{}]}), 1).is_err());
    }

    #[test]
    fn recognizes_valid_installation_layout() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let installation_dir = root.join("installations").join(RUNTIME_VERSION);
        fs::create_dir_all(installation_dir.join("venv").join(if cfg!(windows) {
            "Scripts"
        } else {
            "bin"
        }))
        .unwrap();
        fs::write(venv_python(&installation_dir.join("venv")), b"").unwrap();
        fs::write(installation_dir.join("install-complete"), b"validated").unwrap();
        fs::write(root.join("current.txt"), RUNTIME_VERSION).unwrap();
        let installation = LayaInstallation {
            schema_version: 1,
            runtime_version: RUNTIME_VERSION.into(),
            python_version: PYTHON_VERSION.into(),
            laya_version: LAYA_VERSION.into(),
            model: MODEL.into(),
            model_revision: "revision".into(),
            installed_at: Utc::now(),
            validated: true,
        };
        fs::write(
            installation_dir.join("installation.json"),
            serde_json::to_vec(&installation).unwrap(),
        )
        .unwrap();
        fs::write(
            root.join("installation.json"),
            serde_json::to_vec(&installation).unwrap(),
        )
        .unwrap();
        assert_eq!(
            inspect_installation(root).install_state,
            LayaInstallState::Installed
        );
    }

    #[test]
    fn guarded_delete_rejects_root_and_outside_paths() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("laya");
        let child = root.join("staging");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&child).unwrap();
        fs::create_dir_all(&outside).unwrap();
        assert!(safe_remove_dir_all(&root, &root).is_err());
        assert!(safe_remove_dir_all(&root, &outside).is_err());
        safe_remove_dir_all(&root, &child).unwrap();
        assert!(!child.exists());
    }

    #[test]
    fn activation_switches_only_after_candidate_is_complete() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("laya");
        let old_name = format!("{RUNTIME_VERSION}-1-1-1");
        let new_name = format!("{RUNTIME_VERSION}-2-1-2");
        let old = root.join("installations").join(&old_name);
        let candidate = root.join("installations").join(&new_name);
        fs::create_dir_all(&old).unwrap();
        fs::create_dir_all(&candidate).unwrap();
        fs::write(root.join("current.txt"), &old_name).unwrap();
        let installation = LayaInstallation {
            schema_version: 1,
            runtime_version: RUNTIME_VERSION.into(),
            python_version: PYTHON_VERSION.into(),
            laya_version: LAYA_VERSION.into(),
            model: MODEL.into(),
            model_revision: "revision".into(),
            installed_at: Utc::now(),
            validated: true,
        };
        fs::write(
            candidate.join("installation.json"),
            serde_json::to_vec(&installation).unwrap(),
        )
        .unwrap();
        fs::write(candidate.join("install-complete"), b"validated").unwrap();

        let manager = LayaRuntimeManager::new(root.clone());
        manager.activate(&new_name, &installation).unwrap();

        assert_eq!(
            fs::read_to_string(root.join("current.txt")).unwrap().trim(),
            new_name
        );
        assert!(candidate.exists());
        assert!(!old.exists());
    }

    #[test]
    fn failed_reinstall_preserves_valid_installation_status() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("laya");
        let name = format!("{RUNTIME_VERSION}-1-1-1");
        let installation_dir = root.join("installations").join(&name);
        fs::create_dir_all(installation_dir.join("venv").join(if cfg!(windows) {
            "Scripts"
        } else {
            "bin"
        }))
        .unwrap();
        fs::write(venv_python(&installation_dir.join("venv")), b"").unwrap();
        fs::write(installation_dir.join("install-complete"), b"validated").unwrap();
        let installation = LayaInstallation {
            schema_version: 1,
            runtime_version: RUNTIME_VERSION.into(),
            python_version: PYTHON_VERSION.into(),
            laya_version: LAYA_VERSION.into(),
            model: MODEL.into(),
            model_revision: "revision".into(),
            installed_at: Utc::now(),
            validated: true,
        };
        fs::write(
            installation_dir.join("installation.json"),
            serde_json::to_vec(&installation).unwrap(),
        )
        .unwrap();
        fs::write(root.join("current.txt"), &name).unwrap();

        let manager = LayaRuntimeManager::new(root);
        manager.set_install_error("install_laya", "failed".into(), true, &None);
        let status = manager.status();
        assert_eq!(status.install_state, LayaInstallState::Installed);
        assert_eq!(status.service_state, LayaServiceState::Stopped);
        assert!(status.error.is_some());
    }

    #[cfg(windows)]
    #[test]
    fn cleanup_required_blocks_new_start_and_install_operations() {
        let temp = tempfile::tempdir().unwrap();
        let manager = LayaRuntimeManager::new(temp.path().join("laya"));
        {
            let mut state = manager.inner.state.lock().unwrap();
            state.operation = LifecycleOperation::CleanupRequired;
            state.status.cleanup_required = true;
            state.status.service_state = LayaServiceState::Failed;
        }

        assert!(manager
            .install(None)
            .unwrap_err()
            .to_string()
            .contains("lifecycle operation"));
        assert!(manager
            .start()
            .unwrap_err()
            .to_string()
            .contains("lifecycle operation"));
    }
}
