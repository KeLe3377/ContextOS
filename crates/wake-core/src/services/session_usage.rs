//! Independent usage scans from each agent's original session source.

use crate::adapters::AgentAdapter;
use crate::db::Store;
use crate::models::{session_key, AgentId};
use anyhow::Result;
use std::collections::{HashMap, HashSet};

const USAGE_AGENTS: [AgentId; 14] = [
    AgentId::ClaudeCode,
    AgentId::Codex,
    AgentId::Grok,
    AgentId::Dsh,
    AgentId::Opencode,
    AgentId::Pi,
    AgentId::Omp,
    AgentId::Gemini,
    AgentId::Qoder,
    AgentId::Hermes,
    AgentId::Openclaw,
    AgentId::Codebuddy,
    AgentId::Workbuddy,
    AgentId::Zcode,
];
const USAGE_SOURCE: &str = "adapter-session-source-v2";

#[derive(Debug, Default)]
pub struct UsageSyncResult {
    pub files_seen: usize,
    pub files_parsed: usize,
    pub files_skipped: usize,
    pub errors: Vec<String>,
}

/// Parse usage from source sessions independently from the session/message index.
pub fn sync_session_usage(
    adapters: &[Box<dyn AgentAdapter>],
    store: &Store,
) -> Result<UsageSyncResult> {
    let mut result = UsageSyncResult::default();
    let mut cursors: HashMap<AgentId, HashMap<String, (i64, i64, String)>> = HashMap::new();
    for agent in USAGE_AGENTS {
        cursors.insert(agent, store.session_usage_fingerprints(agent)?);
    }

    let mut all_live: HashMap<AgentId, HashSet<String>> = USAGE_AGENTS
        .into_iter()
        .map(|agent| (agent, HashSet::new()))
        .collect();
    let mut can_prune: HashMap<AgentId, bool> = USAGE_AGENTS
        .into_iter()
        .map(|agent| (agent, true))
        .collect();
    let mut active_agents = HashSet::new();
    let mut candidates: HashMap<String, Vec<(usize, crate::models::SessionFileRef)>> =
        HashMap::new();

    for (ix, adapter) in adapters
        .iter()
        .enumerate()
        .filter(|(_, a)| USAGE_AGENTS.contains(&a.agent()))
    {
        let agent = adapter.agent();
        adapter.begin_scan();
        active_agents.insert(agent);
        let refs = match adapter.list_session_files() {
            Ok(refs) => refs,
            Err(error) => {
                *can_prune.get_mut(&agent).unwrap() = false;
                result.errors.push(format!("{}: {error:#}", agent.as_str()));
                continue;
            }
        };
        for reference in refs {
            result.files_seen += 1;
            let key = session_key(agent, adapter.host(), &reference.native_id);
            candidates.entry(key).or_default().push((ix, reference));
        }
    }

    for (_session_key, mut refs) in candidates {
        refs.sort_by(|(left_ix, left), (right_ix, right)| {
            adapters[*left_ix]
                .dedup_rank()
                .cmp(&adapters[*right_ix].dedup_rank())
                .then_with(|| right.mtime_ms.cmp(&left.mtime_ms))
                .then_with(|| left.file_path.cmp(&right.file_path))
        });
        let (ix, reference) = &refs[0];
        let adapter = &adapters[*ix];
        let agent = adapter.agent();
        all_live
            .get_mut(&agent)
            .unwrap()
            .insert(reference.file_path.clone());
        if cursors[&agent]
            .get(&reference.file_path)
            .is_some_and(|(mtime, size, source)| {
                *mtime == reference.mtime_ms && *size == reference.size && source == USAGE_SOURCE
            })
        {
            result.files_skipped += 1;
            continue;
        }
        let (tokens, usage_events) = match adapter.parse_transcript(reference) {
            Ok(parsed) => (parsed.meta.tokens_used, parsed.usage_events),
            Err(error) => {
                *can_prune.get_mut(&agent).unwrap() = false;
                result.errors.push(format!(
                    "{} {}: {error:#}",
                    agent.as_str(),
                    reference.file_path
                ));
                continue;
            }
        };
        store.write_session_usage(
            &reference.file_path,
            agent,
            tokens,
            &usage_events,
            reference.mtime_ms,
            reference.size,
            USAGE_SOURCE,
        )?;
        result.files_parsed += 1;
    }

    for agent in USAGE_AGENTS {
        if can_prune[&agent] && active_agents.contains(&agent) {
            let paths = all_live[&agent].iter().cloned().collect::<Vec<_>>();
            store.prune_session_usage(agent, &paths)?;
        }
    }
    Ok(result)
}
