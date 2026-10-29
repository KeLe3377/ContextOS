use crate::db::Store;
use crate::models::{
    CompressionDocumentRecord, CompressionRelationMatch, CompressionSearchResult, ProjectInfo,
};
use anyhow::{Context as _, Result};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use walkdir::WalkDir;

const DOCUMENT_MARKER: &str = "contextos_document: true";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompressionRoot {
    pub path: PathBuf,
    pub scope: String,
    pub project_path: String,
}

pub fn roots_for_projects(projects: &[ProjectInfo]) -> Vec<CompressionRoot> {
    let mut roots = projects
        .iter()
        .filter(|project| !project.path.trim().is_empty())
        .map(|project| CompressionRoot {
            path: PathBuf::from(&project.path).join(".ContextOS"),
            scope: "项目".to_string(),
            project_path: project.path.clone(),
        })
        .collect::<Vec<_>>();
    if let Ok(current) = std::env::current_dir() {
        roots.push(CompressionRoot {
            path: current.join(".ContextOS"),
            scope: "项目".to_string(),
            project_path: current.to_string_lossy().into_owned(),
        });
    }
    if let Some(data) = dirs::data_local_dir() {
        roots.push(CompressionRoot {
            path: data.join("ContextOS").join("compressions"),
            scope: "全局".to_string(),
            project_path: String::new(),
        });
    }
    roots.sort_by(|left, right| left.path.cmp(&right.path));
    roots.dedup_by(|left, right| left.path == right.path);
    roots
}

pub fn roots_for_paths(project_paths: &[String]) -> Vec<CompressionRoot> {
    let mut roots = project_paths
        .iter()
        .filter(|path| !path.trim().is_empty())
        .map(|path| CompressionRoot {
            path: PathBuf::from(path).join(".ContextOS"),
            scope: "项目".to_string(),
            project_path: path.clone(),
        })
        .collect::<Vec<_>>();
    if let Some(data) = dirs::data_local_dir() {
        roots.push(CompressionRoot {
            path: data.join("ContextOS").join("compressions"),
            scope: "全局".to_string(),
            project_path: String::new(),
        });
    }
    roots.sort_by(|left, right| left.path.cmp(&right.path));
    roots.dedup_by(|left, right| left.path == right.path);
    roots
}

pub fn sync_and_search(
    store: &Store,
    roots: &[CompressionRoot],
    query: &str,
    limit: usize,
    expand_relations: bool,
) -> Result<CompressionSearchResult> {
    let indexed_documents = sync(store, roots)?;
    let root_paths = roots
        .iter()
        .map(|root| root.path.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    let relation_budget = if expand_relations && !query.trim().is_empty() && limit > 1 {
        (limit / 4).max(1)
    } else {
        0
    };
    let direct_budget = limit.saturating_sub(relation_budget).max(1);
    let (mut hits, degraded) =
        store.search_compression_documents(query, &root_paths, direct_budget)?;
    let direct_hits = hits.len();

    if relation_budget > 0 && !hits.is_empty() {
        let mut expansions: HashMap<String, Vec<CompressionRelationMatch>> = HashMap::new();
        for hit in &hits {
            for source in &hit.sources {
                let Ok((parents, children)) = store.session_relationships(source) else {
                    continue;
                };
                for relation in parents.into_iter().chain(children) {
                    expansions
                        .entry(relation.session.key.clone())
                        .or_default()
                        .push(CompressionRelationMatch {
                            seed_path: hit.path.clone(),
                            source_session_key: source.clone(),
                            related_session_key: relation.session.key,
                            relation: relation.relation,
                        });
                }
            }
        }
        let related_keys = expansions.keys().cloned().collect::<Vec<_>>();
        let excluded = hits
            .iter()
            .map(|hit| hit.path.clone())
            .collect::<HashSet<_>>();
        for (mut hit, matched_source) in store.compression_documents_by_sources(
            &related_keys,
            &root_paths,
            &excluded,
            relation_budget,
        )? {
            hit.related_by = expansions.remove(&matched_source).unwrap_or_default();
            hits.push(hit);
        }
    }
    let relation_hits = hits.len().saturating_sub(direct_hits);
    Ok(CompressionSearchResult {
        hits,
        indexed_documents,
        degraded,
        direct_hits,
        relation_hits,
    })
}

pub fn sync(store: &Store, roots: &[CompressionRoot]) -> Result<usize> {
    let root_paths = roots
        .iter()
        .map(|root| root.path.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    let fingerprints = store.compression_document_fingerprints(&root_paths)?;
    let mut seen_paths = HashSet::new();
    let mut changed = Vec::new();

    for root in roots {
        if !root.path.is_dir() {
            continue;
        }
        for entry in WalkDir::new(&root.path)
            .follow_links(false)
            .into_iter()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_type().is_file())
        {
            let path = entry.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("md") {
                continue;
            }
            let path_text = path.to_string_lossy().into_owned();
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };
            let modified_at = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as i64)
                .unwrap_or_default();
            let size_bytes = metadata.len().min(i64::MAX as u64) as i64;
            if fingerprints.get(&path_text) == Some(&(modified_at, size_bytes)) {
                seen_paths.insert(path_text);
                continue;
            }
            let content = match std::fs::read_to_string(path) {
                Ok(content) => content,
                Err(_) => continue,
            };
            if !is_contextos_document(&content) {
                continue;
            }
            seen_paths.insert(path_text.clone());
            changed.push(CompressionDocumentRecord {
                path: path_text,
                root_path: root.path.to_string_lossy().into_owned(),
                scope: root.scope.clone(),
                project_path: root.project_path.clone(),
                title: document_title(path, &content),
                sources: document_sources(&content),
                body: content,
                modified_at,
                size_bytes,
            });
        }
    }
    store.sync_compression_documents(&root_paths, &seen_paths, &changed)
}

fn is_contextos_document(content: &str) -> bool {
    content.lines().any(|line| line.trim() == DOCUMENT_MARKER)
}

fn document_title(path: &Path, content: &str) -> String {
    content
        .lines()
        .find_map(|line| line.strip_prefix("# ").map(str::trim))
        .filter(|title| !title.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| {
            path.file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("压缩文档")
                .to_string()
        })
}

fn document_sources(content: &str) -> Vec<String> {
    content
        .lines()
        .find_map(|line| line.strip_prefix("contextos_sources:").map(str::trim))
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .collect()
}

pub fn document_content(store: &Store, path: &Path) -> Result<Option<String>> {
    Ok(store
        .get_compression_document(&path.to_string_lossy())?
        .map(|document| display_content(&document.body)))
}

/// Removes ContextOS bookkeeping from the reader while keeping the raw indexed
/// document unchanged. Both legacy leading YAML and current trailing comments
/// are accepted because existing files are not rewritten on discovery.
pub fn display_content(content: &str) -> String {
    let without_leading = if content.starts_with("---\n") {
        content
            .find("\n---")
            .map(|end| content[end + "\n---".len()..].trim_start_matches('\n'))
            .unwrap_or(content)
    } else {
        content
    };
    let Some(start) = without_leading.rfind("\n<!--\n") else {
        return without_leading.to_string();
    };
    let tail = &without_leading[start + 1..];
    let body = if tail.lines().any(|line| line.trim() == DOCUMENT_MARKER)
        && tail.trim_end().ends_with("-->")
    {
        without_leading[..start].trim_end().to_string()
    } else {
        without_leading.to_string()
    };
    body.lines()
        .filter(|line| {
            let line = line.trim();
            ![
                "生成时间:",
                "生成时间：",
                "原始会话:",
                "原始会话：",
                "项目:",
                "项目：",
                "处理链路:",
                "处理链路：",
                "覆盖范围:",
                "覆盖范围：",
            ]
            .iter()
            .any(|prefix| line.starts_with(prefix))
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim_end()
        .to_string()
}

pub fn project_paths(store: &Store, requested: Option<&str>) -> Result<Vec<String>> {
    if let Some(path) = requested.map(str::trim).filter(|path| !path.is_empty()) {
        return Ok(vec![path.to_string()]);
    }
    Ok(store
        .list_projects(false)
        .context("list indexed projects for compression search")?
        .into_iter()
        .map(|project| project.path)
        .filter(|path| !path.trim().is_empty())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AgentId, SessionMeta};

    fn root(path: &Path) -> CompressionRoot {
        CompressionRoot {
            path: path.join(".ContextOS"),
            scope: "项目".into(),
            project_path: path.to_string_lossy().into_owned(),
        }
    }

    fn session(key: &str, file_path: &Path) -> SessionMeta {
        SessionMeta {
            key: key.into(),
            id: key.into(),
            host: String::new(),
            agent: AgentId::Codex,
            title: key.into(),
            project_path: file_path
                .parent()
                .unwrap_or_else(|| Path::new(""))
                .to_string_lossy()
                .into_owned(),
            project_name: "test".into(),
            file_path: file_path.to_string_lossy().into_owned(),
            created_at: 1,
            updated_at: 1,
            message_count: 1,
            size_bytes: 1,
            git_branch: None,
            model: None,
            tokens_used: None,
            archived: false,
            source: None,
            favorite: false,
            pinned: false,
        }
    }

    fn write_document(path: &Path, source: &str, title: &str, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            path,
            format!(
                "---\ncontextos_document: true\ncontextos_sources: {source}\n---\n\n# {title}\n\n{body}\n"
            ),
        )
        .unwrap();
    }

    #[test]
    fn sync_accepts_metadata_at_the_end_of_a_document() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::open(&temp.path().join("index.db")).unwrap();
        let root = root(temp.path());
        let path = root.path.join("trailing.md");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            "# Trailing metadata\n\nBody\n\n<!--\ncontextos_document: true\ncontextos_sources: codex:trailing\n-->\n",
        )
        .unwrap();

        let result =
            sync_and_search(&store, std::slice::from_ref(&root), "Trailing", 10, false).unwrap();

        assert_eq!(result.indexed_documents, 1);
        assert_eq!(
            result.hits[0]
                .title
                .replace(crate::models::HL_OPEN, "")
                .replace(crate::models::HL_CLOSE, ""),
            "Trailing metadata"
        );
    }

    #[test]
    fn display_content_hides_legacy_and_trailing_metadata() {
        let legacy = "---\ncontextos_document: true\n---\n\n# Body\n";
        let trailing =
            "# Body\n\n<!--\ncontextos_document: true\ncontextos_mode: mechanical\n-->\n";
        assert_eq!(display_content(legacy), "# Body\n");
        assert_eq!(display_content(trailing), "# Body");
    }

    #[test]
    fn sync_searches_with_fts_and_removes_deleted_files() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::open(&temp.path().join("index.db")).unwrap();
        let root = root(temp.path());
        let path = root.path.join("nested").join("runtime.md");
        write_document(
            &path,
            "codex:runtime",
            "Laya runtime design",
            "The managed runtime is shared by GUI MCP and CLI.",
        );

        let result = sync_and_search(
            &store,
            std::slice::from_ref(&root),
            "managed runtime",
            10,
            false,
        )
        .unwrap();
        assert_eq!(result.indexed_documents, 1);
        assert_eq!(result.direct_hits, 1);
        assert!(result.hits[0].score > 0.0);
        assert!(result.hits[0].snippet.contains(crate::models::HL_OPEN));

        std::fs::remove_file(path).unwrap();
        let result = sync_and_search(&store, &[root], "", 10, false).unwrap();
        assert_eq!(result.indexed_documents, 0);
        assert!(result.hits.is_empty());
    }

    #[test]
    fn search_expands_through_existing_session_links() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::open(&temp.path().join("index.db")).unwrap();
        let project = temp.path().join("project");
        let root = root(&project);
        let session_a = session("codex:a", &project.join("a.jsonl"));
        let session_b = session("codex:b", &project.join("b.jsonl"));
        store.write_session(&session_a, 1, &[]).unwrap();
        store.write_session(&session_b, 1, &[]).unwrap();
        store
            .set_session_link("codex:a", "codex:b", "continues")
            .unwrap();
        write_document(
            &root.path.join("a.md"),
            "codex:a",
            "Indexed seed",
            "needle appears in this document",
        );
        write_document(
            &root.path.join("b.md"),
            "codex:b",
            "Related continuation",
            "This document is connected through the session tree.",
        );

        let result = sync_and_search(&store, &[root], "needle", 10, true).unwrap();
        assert_eq!(result.direct_hits, 1);
        assert_eq!(result.relation_hits, 1);
        let related = result.hits.iter().find(|hit| !hit.direct_match).unwrap();
        assert_eq!(related.title, "Related continuation");
        assert_eq!(related.related_by[0].relation, "continues");
        assert_eq!(related.related_by[0].related_session_key, "codex:b");
    }
}
