use crate::db::Store;
use crate::workspace_changes::{
    SessionChangeFileGroup, SessionChangeFolderGroup, SessionChangeSessionGroup,
};
use crate::workspace_store::WorkspaceStore;
use anyhow::{bail, Result};
use std::collections::BTreeMap;

/// Add an indexed session to the independent session-changes view.
/// The transcript remains indexed and stored by the session database.
pub fn select_session(workspace: &WorkspaceStore, sessions: &Store, key: &str) -> Result<bool> {
    if sessions.get_session(key)?.is_none() {
        bail!("session `{key}` is not present in the session index");
    }
    workspace.select_session_changes(key)
}

pub fn deselect_session(workspace: &WorkspaceStore, key: &str) -> Result<bool> {
    workspace.deselect_session_changes(key)
}

/// Return only explicitly selected sessions, each with its own file-change
/// groups and current indexed metadata. A project filter is optional.
pub fn list_selected_sessions(
    workspace: &WorkspaceStore,
    sessions: &Store,
    project_path: Option<&str>,
    per_session_limit: usize,
) -> Result<Vec<SessionChangeSessionGroup>> {
    let selections = workspace.list_session_change_selections()?;
    let mut result = Vec::with_capacity(selections.len());

    for selection in selections {
        let metadata = sessions.get_session(&selection.session_key)?;
        if project_path.is_some_and(|path| {
            metadata
                .as_ref()
                .is_none_or(|meta| !meta.project_path.eq_ignore_ascii_case(path))
        }) {
            continue;
        }

        let events = workspace
            .list_session_file_changes_for_session(&selection.session_key, per_session_limit)?;
        let latest_change_at = events.first().map(|event| event.observed_at);
        let change_count = events.len();
        let mut folders = BTreeMap::<String, BTreeMap<String, Vec<_>>>::new();
        let mut root_files = BTreeMap::<String, Vec<_>>::new();
        for event in events {
            if let Some((folder, _)) = event.file_path.rsplit_once('/') {
                folders
                    .entry(folder.to_string())
                    .or_default()
                    .entry(event.file_path.clone())
                    .or_default()
                    .push(event);
            } else {
                root_files
                    .entry(event.file_path.clone())
                    .or_default()
                    .push(event);
            }
        }

        let folders = folders
            .into_iter()
            .map(|(path, files)| SessionChangeFolderGroup {
                path,
                files: files
                    .into_iter()
                    .map(|(path, events)| SessionChangeFileGroup { path, events })
                    .collect(),
            })
            .collect();
        let root_files = root_files
            .into_iter()
            .map(|(path, events)| SessionChangeFileGroup { path, events })
            .collect();

        result.push(SessionChangeSessionGroup {
            session_key: selection.session_key,
            metadata,
            selected_at: selection.selected_at,
            latest_change_at,
            change_count,
            folders,
            root_files,
        });
    }

    result.sort_by(|left, right| {
        right
            .latest_change_at
            .unwrap_or(right.selected_at)
            .cmp(&left.latest_change_at.unwrap_or(left.selected_at))
            .then_with(|| left.session_key.cmp(&right.session_key))
    });
    Ok(result)
}

/// Return one timeline item per transcript change event. Files changed by the
/// same tool call stay together, while later changes from the same session get
/// their own chronological item.
pub fn list_selected_activities(
    workspace: &WorkspaceStore,
    sessions: &Store,
    project_path: Option<&str>,
    per_session_limit: usize,
) -> Result<Vec<SessionChangeSessionGroup>> {
    let selected = list_selected_sessions(workspace, sessions, project_path, per_session_limit)?;
    let mut activities = Vec::new();

    for session in selected {
        let mut by_source = BTreeMap::<String, Vec<_>>::new();
        for event in session
            .folders
            .iter()
            .flat_map(|folder| folder.files.iter())
            .flat_map(|file| file.events.iter())
            .chain(
                session
                    .root_files
                    .iter()
                    .flat_map(|file| file.events.iter()),
            )
        {
            let file_suffix = format!(":{}", event.file_path);
            let source = event
                .source_event_key
                .strip_suffix(&file_suffix)
                .map(str::to_string)
                .unwrap_or_else(|| format!("{}:{}", event.session_key, event.observed_at));
            by_source.entry(source).or_default().push(event.clone());
        }

        for events in by_source.into_values() {
            let mut folders = BTreeMap::<String, BTreeMap<String, Vec<_>>>::new();
            let mut root_files = BTreeMap::<String, Vec<_>>::new();
            for event in events {
                if let Some((folder, _)) = event.file_path.rsplit_once('/') {
                    folders
                        .entry(folder.to_string())
                        .or_default()
                        .entry(event.file_path.clone())
                        .or_default()
                        .push(event);
                } else {
                    root_files
                        .entry(event.file_path.clone())
                        .or_default()
                        .push(event);
                }
            }

            let folders: Vec<SessionChangeFolderGroup> = folders
                .into_iter()
                .map(|(path, files)| SessionChangeFolderGroup {
                    path,
                    files: files
                        .into_iter()
                        .map(|(path, events)| SessionChangeFileGroup { path, events })
                        .collect(),
                })
                .collect();
            let root_files: Vec<SessionChangeFileGroup> = root_files
                .into_iter()
                .map(|(path, events)| SessionChangeFileGroup { path, events })
                .collect();
            let change_count = folders
                .iter()
                .flat_map(|folder: &SessionChangeFolderGroup| folder.files.iter())
                .map(|file| file.events.len())
                .sum::<usize>()
                + root_files
                    .iter()
                    .map(|file: &SessionChangeFileGroup| file.events.len())
                    .sum::<usize>();
            let latest_change_at = folders
                .iter()
                .flat_map(|folder: &SessionChangeFolderGroup| folder.files.iter())
                .flat_map(|file| file.events.iter())
                .chain(
                    root_files
                        .iter()
                        .flat_map(|file: &SessionChangeFileGroup| file.events.iter()),
                )
                .map(|event| event.observed_at)
                .max();

            activities.push(SessionChangeSessionGroup {
                session_key: session.session_key.clone(),
                metadata: session.metadata.clone(),
                selected_at: session.selected_at,
                latest_change_at,
                change_count,
                folders,
                root_files,
            });
        }
    }

    activities.sort_by(|left, right| {
        let latest_event_id = |group: &SessionChangeSessionGroup| {
            group
                .folders
                .iter()
                .flat_map(|folder| folder.files.iter())
                .flat_map(|file| file.events.iter())
                .chain(group.root_files.iter().flat_map(|file| file.events.iter()))
                .map(|event| event.id)
                .max()
                .unwrap_or_default()
        };
        right
            .latest_change_at
            .cmp(&left.latest_change_at)
            .then_with(|| latest_event_id(right).cmp(&latest_event_id(left)))
            .then_with(|| left.session_key.cmp(&right.session_key))
    });
    Ok(activities)
}
