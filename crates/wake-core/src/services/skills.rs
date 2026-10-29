use crate::models::AgentId;
use crate::services::terminal;
use anyhow::{anyhow, Context as _, Result};
use ignore::WalkBuilder;
use serde::Deserialize;
use std::collections::HashSet;
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

const SKILL_FILE: &str = "SKILL.md";
static SAVE_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PathIdentity(u64, u64, u64);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillSource {
    pub agent: AgentId,
    pub root: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillEntry {
    pub key: String,
    pub agent: Option<AgentId>,
    pub project_path: String,
    pub project_name: String,
    pub root: PathBuf,
    pub directory: PathBuf,
    pub file: PathBuf,
    pub name: String,
    pub description: String,
    pub body: String,
    pub updated_at: i64,
    pub directory_trash_allowed: bool,
    directory_identity: PathIdentity,
    file_identity: PathIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillScanIssue {
    pub agent: Option<AgentId>,
    pub path: PathBuf,
    pub message: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SkillScanResult {
    pub skills: Vec<SkillEntry>,
    pub issues: Vec<SkillScanIssue>,
}

#[derive(Debug, Default, Deserialize)]
struct SkillFrontmatter {
    name: Option<String>,
    description: Option<String>,
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn push_source(out: &mut Vec<SkillSource>, agent: AgentId, root: PathBuf) {
    if !out
        .iter()
        .any(|source| source.agent == agent && source.root == root)
    {
        out.push(SkillSource { agent, root });
    }
}

/// User-level Agent Skills roots with stable, documented layouts. Missing roots are
/// intentionally retained here and ignored by the scanner, so a newly installed agent
/// appears without any ContextOS configuration.
pub fn default_skill_sources() -> Vec<SkillSource> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    skill_sources_for(&home, env_path)
}

fn skill_sources_for(
    home: &Path,
    mut environment_path: impl FnMut(&str) -> Option<PathBuf>,
) -> Vec<SkillSource> {
    let mut out = Vec::new();

    let claude_home = environment_path("CLAUDE_CONFIG_DIR").unwrap_or_else(|| home.join(".claude"));
    push_source(&mut out, AgentId::ClaudeCode, claude_home.join("skills"));

    let codex_home = environment_path("CODEX_HOME").unwrap_or_else(|| home.join(".codex"));
    push_source(&mut out, AgentId::Codex, codex_home.join("skills"));
    push_source(
        &mut out,
        AgentId::Codex,
        home.join(".agents").join("skills"),
    );

    push_source(
        &mut out,
        AgentId::Cursor,
        home.join(".cursor").join("skills"),
    );
    push_source(
        &mut out,
        AgentId::Copilot,
        home.join(".copilot").join("skills"),
    );
    push_source(
        &mut out,
        AgentId::Gemini,
        home.join(".gemini").join("skills"),
    );

    let opencode_home = environment_path("OPENCODE_CONFIG_DIR")
        .unwrap_or_else(|| home.join(".config").join("opencode"));
    push_source(&mut out, AgentId::Opencode, opencode_home.join("skills"));
    push_source(
        &mut out,
        AgentId::Opencode,
        home.join(".claude").join("skills"),
    );
    push_source(
        &mut out,
        AgentId::Opencode,
        home.join(".agents").join("skills"),
    );

    push_source(
        &mut out,
        AgentId::Pi,
        home.join(".pi").join("agent").join("skills"),
    );

    let default_openclaw_home = home.join(".openclaw");
    let openclaw_state = environment_path("OPENCLAW_STATE_DIR");
    let openclaw_uses_default_state = openclaw_state.as_ref().map_or(true, |path| {
        normalized_path(path) == normalized_path(&default_openclaw_home)
    });
    let openclaw_home = openclaw_state.unwrap_or(default_openclaw_home);
    push_source(&mut out, AgentId::Openclaw, openclaw_home.join("skills"));
    if openclaw_uses_default_state {
        push_source(
            &mut out,
            AgentId::Openclaw,
            home.join(".agents").join("skills"),
        );
    }
    out
}

pub fn scan_user_skills() -> SkillScanResult {
    scan_sources(&default_skill_sources())
}

/// Scans user-level Skills plus project-level Skills for projects already known to ContextOS.
/// Skill contents remain filesystem-backed and are never written to the session database.
pub fn scan_skills(project_roots: &[PathBuf]) -> SkillScanResult {
    scan_skills_with_added_projects(project_roots, &[])
}

/// Scans the standard user/project locations plus project roots explicitly added by the user.
/// Added roots are searched recursively because a project may keep Skills outside an Agent's
/// conventional directory layout.
pub fn scan_skills_with_added_projects(
    project_roots: &[PathBuf],
    added_project_roots: &[PathBuf],
) -> SkillScanResult {
    let mut result = scan_user_skills();
    for project in project_roots {
        let project_path = project.to_string_lossy().to_string();
        let project_name = project
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or("Project")
            .to_string();
        let mut scanned = scan_sources(&project_skill_sources(project));
        for entry in &mut scanned.skills {
            entry.project_path.clone_from(&project_path);
            entry.project_name.clone_from(&project_name);
        }
        result.skills.append(&mut scanned.skills);
        result.issues.append(&mut scanned.issues);
    }

    let mut seen_files = result
        .skills
        .iter()
        .map(|entry| normalized_path(&entry.file))
        .collect::<HashSet<_>>();
    for project in added_project_roots {
        let mut scanned = scan_project_tree(project);
        scanned
            .skills
            .retain(|entry| seen_files.insert(normalized_path(&entry.file)));
        result.skills.append(&mut scanned.skills);
        result.issues.append(&mut scanned.issues);
    }

    let mut seen = HashSet::new();
    result.skills.retain(|entry| seen.insert(entry.key.clone()));
    result.skills.sort_by(|a, b| {
        a.agent
            .cmp(&b.agent)
            .then_with(|| a.project_path.cmp(&b.project_path))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.directory.cmp(&b.directory))
    });
    result
}

fn scan_project_tree(project: &Path) -> SkillScanResult {
    let mut result = SkillScanResult::default();
    let mut visited = HashSet::new();
    let project_path = project.to_string_lossy().to_string();
    let project_name = project
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Project")
        .to_string();

    let mut builder = WalkBuilder::new(project);
    builder
        .hidden(false)
        .follow_links(false)
        .require_git(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .filter_entry(|entry| !is_expensive_generated_directory(entry));

    for walked in builder.build() {
        let entry = match walked {
            Ok(entry) => entry,
            Err(error) => {
                result.issues.push(SkillScanIssue {
                    agent: None,
                    path: project.to_path_buf(),
                    message: error.to_string(),
                });
                continue;
            }
        };
        let directory = entry.into_path();
        let file = directory.join(SKILL_FILE);
        let is_directory = directory.is_dir();
        let is_linked_skill = !is_directory && file.is_file();
        if !is_directory && !is_linked_skill {
            continue;
        }
        if !visited.insert(normalized_path(&directory)) {
            continue;
        }
        if file.is_file() {
            let agent = infer_project_agent(project, &directory);
            let root = directory.parent().unwrap_or(project).to_path_buf();
            let key = format!(
                "{}:{}",
                agent.map_or("project", |agent| agent.as_str()),
                normalized_path(&directory)
            );
            match read_entry(agent, &root, key, directory.clone(), file, false) {
                Ok((mut skill, metadata_error)) => {
                    skill.project_path.clone_from(&project_path);
                    skill.project_name.clone_from(&project_name);
                    if let Some(message) = metadata_error {
                        result.issues.push(SkillScanIssue {
                            agent,
                            path: skill.file.clone(),
                            message,
                        });
                    }
                    result.skills.push(skill);
                }
                Err(error) => result.issues.push(SkillScanIssue {
                    agent,
                    path: directory.clone(),
                    message: format!("{error:#}"),
                }),
            }
        }
    }

    result
}

fn is_expensive_generated_directory(entry: &ignore::DirEntry) -> bool {
    if entry.depth() == 0 || !entry.file_type().is_some_and(|kind| kind.is_dir()) {
        return false;
    }
    matches!(
        entry.file_name().to_str(),
        Some(
            ".git"
                | ".hg"
                | ".svn"
                | "node_modules"
                | "target"
                | ".venv"
                | "venv"
                | ".tox"
                | "__pycache__"
                | ".mypy_cache"
                | ".pytest_cache"
        )
    )
}

fn infer_project_agent(project: &Path, skill_directory: &Path) -> Option<AgentId> {
    let mut components = skill_directory
        .strip_prefix(project)
        .unwrap_or(skill_directory)
        .components()
        .filter_map(|component| component.as_os_str().to_str());
    match (components.next(), components.next()) {
        (Some(".cursor"), Some("skills")) => Some(AgentId::Cursor),
        (Some(".github"), Some("skills")) => Some(AgentId::Copilot),
        (Some(".gemini"), Some("skills")) => Some(AgentId::Gemini),
        (Some(".opencode"), Some("skills")) => Some(AgentId::Opencode),
        (Some(".pi"), Some("skills")) => Some(AgentId::Pi),
        _ => None,
    }
}

fn project_skill_sources(project: &Path) -> Vec<SkillSource> {
    let mut out = Vec::new();
    push_source(
        &mut out,
        AgentId::ClaudeCode,
        project.join(".claude").join("skills"),
    );
    push_source(
        &mut out,
        AgentId::Codex,
        project.join(".agents").join("skills"),
    );
    push_source(
        &mut out,
        AgentId::Cursor,
        project.join(".cursor").join("skills"),
    );
    push_source(
        &mut out,
        AgentId::Copilot,
        project.join(".github").join("skills"),
    );
    push_source(
        &mut out,
        AgentId::Gemini,
        project.join(".gemini").join("skills"),
    );
    push_source(
        &mut out,
        AgentId::Opencode,
        project.join(".opencode").join("skills"),
    );
    push_source(
        &mut out,
        AgentId::Opencode,
        project.join(".claude").join("skills"),
    );
    push_source(
        &mut out,
        AgentId::Opencode,
        project.join(".agents").join("skills"),
    );
    push_source(&mut out, AgentId::Pi, project.join(".pi").join("skills"));
    push_source(&mut out, AgentId::Openclaw, project.join("skills"));
    out
}

pub fn scan_sources(sources: &[SkillSource]) -> SkillScanResult {
    let mut result = SkillScanResult::default();
    let mut seen = HashSet::new();

    for source in sources {
        match source.root.try_exists() {
            Ok(true) => {}
            Ok(false) => continue,
            Err(error) => {
                result.issues.push(issue(source, &source.root, error));
                continue;
            }
        }
        let entries = match fs::read_dir(&source.root) {
            Ok(entries) => entries,
            Err(error) => {
                result.issues.push(issue(source, &source.root, error));
                continue;
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    result.issues.push(issue(source, &source.root, error));
                    continue;
                }
            };
            let directory = entry.path();
            let file = directory.join(SKILL_FILE);
            if !file.is_file() {
                continue;
            }
            let key = format!("{}:{}", source.agent.as_str(), normalized_path(&directory));
            if !seen.insert(key.clone()) {
                continue;
            }
            match read_entry(Some(source.agent), &source.root, key, directory, file, true) {
                Ok((skill, metadata_error)) => {
                    if let Some(message) = metadata_error {
                        result.issues.push(SkillScanIssue {
                            agent: Some(source.agent),
                            path: skill.file.clone(),
                            message,
                        });
                    }
                    result.skills.push(skill);
                }
                Err(error) => result.issues.push(SkillScanIssue {
                    agent: Some(source.agent),
                    path: entry.path(),
                    message: format!("{error:#}"),
                }),
            }
        }
    }

    result.skills.sort_by(|a, b| {
        a.agent
            .cmp(&b.agent)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.directory.cmp(&b.directory))
    });
    result
}

fn issue(source: &SkillSource, path: &Path, error: impl std::fmt::Display) -> SkillScanIssue {
    SkillScanIssue {
        agent: Some(source.agent),
        path: path.to_path_buf(),
        message: error.to_string(),
    }
}

fn normalized_path(path: &Path) -> String {
    let normalized = fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .replace('\\', "/")
        .to_string();
    if cfg!(windows) {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

fn read_entry(
    agent: Option<AgentId>,
    root: &Path,
    key: String,
    directory: PathBuf,
    file: PathBuf,
    directory_trash_allowed: bool,
) -> Result<(SkillEntry, Option<String>)> {
    let body =
        fs::read_to_string(&file).with_context(|| format!("could not read {}", file.display()))?;
    let fallback_name = directory
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Skill")
        .to_string();
    let metadata = fs::metadata(&file)?;
    let directory_identity = path_identity(&directory)?;
    let file_identity = path_identity(&file)?;
    let updated_at = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default();
    let (frontmatter, metadata_error) = match parse_frontmatter(&body) {
        Ok(frontmatter) => (frontmatter, None),
        Err(error) => (
            SkillFrontmatter::default(),
            Some(format!("invalid SKILL.md metadata: {error:#}")),
        ),
    };
    let name = frontmatter
        .name
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(fallback_name);
    let description = frontmatter.description.unwrap_or_default();
    Ok((
        SkillEntry {
            key,
            agent,
            project_path: String::new(),
            project_name: String::new(),
            root: root.to_path_buf(),
            directory,
            file,
            name,
            description,
            body,
            updated_at,
            directory_trash_allowed,
            directory_identity,
            file_identity,
        },
        metadata_error,
    ))
}

fn parse_frontmatter(body: &str) -> Result<SkillFrontmatter> {
    let mut lines = body.lines();
    if lines.next().map(str::trim) != Some("---") {
        return Ok(SkillFrontmatter::default());
    }
    let mut yaml = String::new();
    let mut closed = false;
    for line in lines {
        if line.trim() == "---" {
            closed = true;
            break;
        }
        yaml.push_str(line);
        yaml.push('\n');
    }
    if !closed {
        return Err(anyhow!("SKILL.md frontmatter has no closing delimiter"));
    }
    serde_yaml::from_str(&yaml).context("invalid SKILL.md frontmatter")
}

/// Saves only when the directory entry, file entry, and text still match the scanned version.
pub fn save_skill(entry: &SkillEntry, replacement: &str) -> Result<()> {
    revalidate_skill(entry)?;
    let metadata = fs::symlink_metadata(&entry.file)?;
    let shared_hard_link = has_multiple_hard_links(&entry.file, &metadata)?;
    // Replacing a link would silently turn the package entry into a regular file. Write
    // through links instead; identity and body checks still protect external changes.
    if metadata.file_type().is_symlink() || shared_hard_link {
        return fs::write(&entry.file, replacement.as_bytes())
            .with_context(|| format!("could not save {}", entry.file.display()));
    }
    atomic_replace_skill(entry, replacement)
}

#[cfg(unix)]
fn has_multiple_hard_links(_path: &Path, metadata: &fs::Metadata) -> Result<bool> {
    use std::os::unix::fs::MetadataExt as _;
    Ok(metadata.nlink() > 1)
}

#[cfg(windows)]
fn has_multiple_hard_links(path: &Path, _metadata: &fs::Metadata) -> Result<bool> {
    use std::os::windows::fs::OpenOptionsExt as _;
    use std::os::windows::io::AsRawHandle as _;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE,
    };

    let file = fs::OpenOptions::new()
        .access_mode(0)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .open(path)?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(std::io::Error::last_os_error())
            .context("could not inspect SKILL.md link count");
    }
    Ok(info.nNumberOfLinks > 1)
}

#[cfg(not(any(unix, windows)))]
fn has_multiple_hard_links(_path: &Path, _metadata: &fs::Metadata) -> Result<bool> {
    Ok(false)
}

pub fn trash_skill(entry: &SkillEntry) -> Result<()> {
    if !entry.directory_trash_allowed {
        return Err(anyhow!(
            "recursively discovered project Skills cannot move their containing folder to trash"
        ));
    }
    revalidate_skill(entry)?;
    if entry.file.parent() != Some(entry.directory.as_path()) {
        return Err(anyhow!("SKILL.md is outside its skill directory"));
    }
    if entry.directory.parent() != Some(entry.root.as_path()) {
        return Err(anyhow!(
            "skill directory is not directly inside its agent skill root"
        ));
    }
    terminal::trash_paths(&[entry.directory.to_string_lossy().to_string()])
}

fn validate_skill_file(file: &Path) -> Result<()> {
    if file.file_name().and_then(|name| name.to_str()) != Some(SKILL_FILE) || !file.is_file() {
        return Err(anyhow!("not an existing SKILL.md file: {}", file.display()));
    }
    Ok(())
}

fn revalidate_skill(entry: &SkillEntry) -> Result<()> {
    validate_skill_file(&entry.file)?;
    if path_identity(&entry.directory)? != entry.directory_identity
        || path_identity(&entry.file)? != entry.file_identity
    {
        return Err(anyhow!(
            "Skill changed on disk; refresh before modifying or deleting it"
        ));
    }
    if fs::read_to_string(&entry.file)? != entry.body {
        return Err(anyhow!(
            "SKILL.md changed on disk; refresh before modifying or deleting it"
        ));
    }
    Ok(())
}

fn atomic_replace_skill(entry: &SkillEntry, replacement: &str) -> Result<()> {
    let parent = entry
        .file
        .parent()
        .ok_or_else(|| anyhow!("SKILL.md has no parent directory"))?;
    let sequence = SAVE_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temp = parent.join(format!(
        ".SKILL.md.contextos-{}-{sequence}.tmp",
        std::process::id()
    ));
    let result = (|| -> Result<()> {
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        output.write_all(replacement.as_bytes())?;
        output.sync_all()?;
        fs::set_permissions(&temp, fs::metadata(&entry.file)?.permissions())?;
        // Temp-file creation can take long enough for an editor to save the original.
        revalidate_skill(entry)?;
        replace_file(&temp, &entry.file)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.with_context(|| format!("could not save {}", entry.file.display()))
}

#[cfg(windows)]
fn replace_file(from: &Path, to: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt as _;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let from = from
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let to = to
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    if unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(from: &Path, to: &Path) -> Result<()> {
    fs::rename(from, to)?;
    Ok(())
}

/// Identity of the directory entry itself. On Windows OPEN_REPARSE_POINT and on Unix
/// symlink_metadata keep linked Skill packages manageable without confusing the link with
/// its target during destructive revalidation.
#[cfg(windows)]
fn path_identity(path: &Path) -> Result<PathIdentity> {
    use std::os::windows::fs::OpenOptionsExt as _;
    use std::os::windows::io::AsRawHandle as _;
    use windows_sys::Win32::Storage::FileSystem::{
        FileIdInfo, GetFileInformationByHandleEx, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_ID_INFO, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE,
    };
    let file = fs::OpenOptions::new()
        .access_mode(0)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let mut id = FILE_ID_INFO::default();
    let ok = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileIdInfo,
            (&mut id as *mut FILE_ID_INFO).cast(),
            std::mem::size_of::<FILE_ID_INFO>() as u32,
        )
    };
    if ok == 0 || id.FileId.Identifier == [0; 16] {
        return Err(std::io::Error::last_os_error())
            .context("could not verify Skill path identity");
    }
    Ok(PathIdentity(
        id.VolumeSerialNumber as u64,
        u64::from_le_bytes(id.FileId.Identifier[..8].try_into()?),
        u64::from_le_bytes(id.FileId.Identifier[8..].try_into()?),
    ))
}

#[cfg(unix)]
fn path_identity(path: &Path) -> Result<PathIdentity> {
    use std::os::unix::fs::MetadataExt as _;
    let metadata = fs::symlink_metadata(path)?;
    Ok(PathIdentity(metadata.dev(), metadata.ino(), 0))
}

#[cfg(not(any(unix, windows)))]
fn path_identity(path: &Path) -> Result<PathIdentity> {
    let metadata = fs::symlink_metadata(path)?;
    let modified = metadata
        .modified()?
        .duration_since(UNIX_EPOCH)?
        .as_nanos()
        .min(u64::MAX as u128) as u64;
    Ok(PathIdentity(metadata.len(), modified, 0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans_agent_roots_and_parses_frontmatter() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("skills");
        let skill = root.join("reviewer");
        fs::create_dir_all(&skill).unwrap();
        fs::write(
            skill.join(SKILL_FILE),
            "---\nname: code-review\ndescription: Review changes safely\n---\n\n# Review\n",
        )
        .unwrap();

        let scanned = scan_sources(&[SkillSource {
            agent: AgentId::Codex,
            root,
        }]);
        assert!(scanned.issues.is_empty());
        assert_eq!(scanned.skills.len(), 1);
        assert_eq!(scanned.skills[0].name, "code-review");
        assert_eq!(scanned.skills[0].description, "Review changes safely");
        assert_eq!(scanned.skills[0].agent, Some(AgentId::Codex));
        assert!(scanned.skills[0].directory_trash_allowed);
    }

    #[test]
    fn recursively_scans_added_project_folders_without_fabricating_an_agent() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("demo-project");
        let skill = project.join("tools").join("reviewer");
        fs::create_dir_all(&skill).unwrap();
        fs::write(
            skill.join(SKILL_FILE),
            "---\nname: project-review\n---\n# Review\n",
        )
        .unwrap();

        let scanned = scan_skills_with_added_projects(&[], &[project.clone()]);
        let project_skills = scanned
            .skills
            .iter()
            .filter(|entry| entry.project_path == project.to_string_lossy())
            .collect::<Vec<_>>();

        assert!(scanned.issues.is_empty());
        assert_eq!(project_skills.len(), 1);
        assert_eq!(project_skills[0].name, "project-review");
        assert_eq!(project_skills[0].agent, None);
        assert!(!project_skills[0].directory_trash_allowed);
        assert!(trash_skill(project_skills[0]).is_err());
        assert!(project.exists());
    }

    #[test]
    fn recursive_project_scan_respects_ignores_and_skips_generated_trees() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("demo-project");
        let kept = project.join("tools").join("kept");
        let gitignored = project.join("generated").join("ignored");
        let dependency = project.join("node_modules").join("ignored");
        fs::create_dir_all(&kept).unwrap();
        fs::create_dir_all(&gitignored).unwrap();
        fs::create_dir_all(&dependency).unwrap();
        fs::write(project.join(".gitignore"), "generated/\n").unwrap();
        fs::write(kept.join(SKILL_FILE), "# Kept\n").unwrap();
        fs::write(gitignored.join(SKILL_FILE), "# Ignored\n").unwrap();
        fs::write(dependency.join(SKILL_FILE), "# Dependency\n").unwrap();

        let scanned = scan_project_tree(&project);

        assert!(scanned.issues.is_empty());
        assert_eq!(scanned.skills.len(), 1);
        assert_eq!(scanned.skills[0].name, "kept");
    }

    #[test]
    fn recursive_project_scan_recognizes_unambiguous_agent_paths() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("demo-project");
        let skill = project.join(".cursor").join("skills").join("helper");
        fs::create_dir_all(&skill).unwrap();
        fs::write(skill.join(SKILL_FILE), "# Helper\n").unwrap();

        let scanned = scan_skills_with_added_projects(
            std::slice::from_ref(&project),
            std::slice::from_ref(&project),
        );
        let project_skills = scanned
            .skills
            .iter()
            .filter(|entry| entry.project_path == project.to_string_lossy())
            .collect::<Vec<_>>();

        assert_eq!(project_skills.len(), 1);
        assert_eq!(project_skills[0].agent, Some(AgentId::Cursor));
    }

    #[test]
    fn recursive_agent_inference_rejects_ambiguous_and_nested_layouts() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("demo-project");
        let ambiguous = project.join(".claude").join("skills").join("shared");
        let nested = project
            .join("tools")
            .join(".cursor")
            .join("skills")
            .join("helper");
        fs::create_dir_all(&ambiguous).unwrap();
        fs::create_dir_all(&nested).unwrap();
        fs::write(ambiguous.join(SKILL_FILE), "# Shared\n").unwrap();
        fs::write(nested.join(SKILL_FILE), "# Nested\n").unwrap();

        let scanned = scan_project_tree(&project);

        assert_eq!(scanned.skills.len(), 2);
        assert!(scanned.skills.iter().all(|entry| entry.agent.is_none()));
    }

    #[cfg(unix)]
    #[test]
    fn recursive_scan_reads_a_linked_skill_package_without_following_its_tree() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("demo-project");
        let external = temp.path().join("external-skill");
        let nested = external.join("nested");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&nested).unwrap();
        fs::write(external.join(SKILL_FILE), "# Linked\n").unwrap();
        fs::write(nested.join(SKILL_FILE), "# Must not escape\n").unwrap();
        symlink(&external, project.join("linked")).unwrap();

        let scanned = scan_project_tree(&project);

        assert_eq!(scanned.skills.len(), 1);
        assert_eq!(scanned.skills[0].name, "linked");
    }

    #[test]
    fn ignores_missing_roots_and_non_skill_directories() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("notes")).unwrap();
        let scanned = scan_sources(&[
            SkillSource {
                agent: AgentId::ClaudeCode,
                root: temp.path().join("missing"),
            },
            SkillSource {
                agent: AgentId::Codex,
                root: temp.path().to_path_buf(),
            },
        ]);
        assert!(scanned.skills.is_empty());
        assert!(scanned.issues.is_empty());
    }

    #[test]
    fn malformed_frontmatter_keeps_the_skill_and_reports_an_issue() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("skills");
        let skill = root.join("broken");
        fs::create_dir_all(&skill).unwrap();
        fs::write(skill.join(SKILL_FILE), "---\nname: [broken\n---\n# Body").unwrap();

        let scanned = scan_sources(&[SkillSource {
            agent: AgentId::ClaudeCode,
            root,
        }]);
        assert_eq!(scanned.skills.len(), 1);
        assert_eq!(scanned.skills[0].name, "broken");
        assert_eq!(scanned.issues.len(), 1);
        assert!(scanned.issues[0]
            .message
            .contains("invalid SKILL.md metadata"));
    }

    #[test]
    fn refuses_to_overwrite_an_external_edit() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("skills");
        let directory = root.join("demo");
        fs::create_dir_all(&directory).unwrap();
        let file = directory.join(SKILL_FILE);
        fs::write(&file, "original").unwrap();
        let scanned = scan_sources(&[SkillSource {
            agent: AgentId::Codex,
            root,
        }]);
        fs::write(&file, "external edit").unwrap();
        let error = save_skill(&scanned.skills[0], "editor change").unwrap_err();
        assert!(error.to_string().contains("changed on disk"));
        assert_eq!(fs::read_to_string(file).unwrap(), "external edit");
    }

    #[test]
    fn saves_when_the_loaded_version_is_current() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("skills");
        let directory = root.join("demo");
        fs::create_dir_all(&directory).unwrap();
        let file = directory.join(SKILL_FILE);
        fs::write(&file, "original").unwrap();
        let scanned = scan_sources(&[SkillSource {
            agent: AgentId::Codex,
            root,
        }]);
        save_skill(&scanned.skills[0], "updated").unwrap();
        assert_eq!(fs::read_to_string(file).unwrap(), "updated");
    }

    #[test]
    fn saving_a_hard_link_updates_the_shared_file() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("skills");
        let directory = root.join("demo");
        fs::create_dir_all(&directory).unwrap();
        let shared = temp.path().join("shared-skill.md");
        fs::write(&shared, "original").unwrap();
        let file = directory.join(SKILL_FILE);
        fs::hard_link(&shared, &file).unwrap();
        let scanned = scan_sources(&[SkillSource {
            agent: AgentId::Codex,
            root,
        }]);

        save_skill(&scanned.skills[0], "updated").unwrap();

        assert_eq!(fs::read_to_string(&shared).unwrap(), "updated");
        assert_eq!(fs::read_to_string(file).unwrap(), "updated");
    }

    #[test]
    fn replaced_skill_directory_is_rejected_before_trash() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("skills");
        let directory = root.join("demo");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join(SKILL_FILE), "original").unwrap();
        let scanned = scan_sources(&[SkillSource {
            agent: AgentId::Codex,
            root: root.clone(),
        }]);
        fs::rename(&directory, root.join("old-demo")).unwrap();
        fs::create_dir(&directory).unwrap();
        fs::write(directory.join(SKILL_FILE), "original").unwrap();

        let error = revalidate_skill(&scanned.skills[0]).unwrap_err();
        assert!(error.to_string().contains("changed on disk"));
        assert!(directory.exists());
    }

    #[test]
    fn shared_roots_remain_separate_agent_sources() {
        let Some(home) = dirs::home_dir() else {
            return;
        };
        let sources = default_skill_sources();
        let shared = home.join(".agents").join("skills");
        assert!(sources
            .iter()
            .any(|source| source.agent == AgentId::Codex && source.root == shared));
        assert!(sources
            .iter()
            .any(|source| source.agent == AgentId::Opencode && source.root == shared));
        if std::env::var_os("OPENCLAW_STATE_DIR").is_none() {
            assert!(sources
                .iter()
                .any(|source| source.agent == AgentId::Openclaw && source.root == shared));
        }
    }

    #[test]
    fn opencode_compatibility_root_does_not_follow_claude_config_dir() {
        let home = PathBuf::from("test-home");
        let custom_claude = PathBuf::from("custom-claude");
        let sources = skill_sources_for(&home, |name| match name {
            "CLAUDE_CONFIG_DIR" => Some(custom_claude.clone()),
            _ => None,
        });

        assert!(sources.iter().any(|source| {
            source.agent == AgentId::ClaudeCode && source.root == custom_claude.join("skills")
        }));
        assert!(sources.iter().any(|source| {
            source.agent == AgentId::Opencode && source.root == home.join(".claude").join("skills")
        }));
        assert!(!sources.iter().any(|source| {
            source.agent == AgentId::Opencode && source.root == custom_claude.join("skills")
        }));
    }

    #[test]
    fn openclaw_shared_root_depends_on_the_effective_state_directory() {
        let home = PathBuf::from("test-home");
        let default_state = home.join(".openclaw");
        let shared = home.join(".agents").join("skills");
        let default_sources = skill_sources_for(&home, |name| {
            (name == "OPENCLAW_STATE_DIR").then(|| default_state.clone())
        });
        assert!(default_sources
            .iter()
            .any(|source| source.agent == AgentId::Openclaw && source.root == shared));

        let custom_sources = skill_sources_for(&home, |name| {
            (name == "OPENCLAW_STATE_DIR").then(|| PathBuf::from("custom-openclaw"))
        });
        assert!(!custom_sources
            .iter()
            .any(|source| source.agent == AgentId::Openclaw && source.root == shared));
    }
}
