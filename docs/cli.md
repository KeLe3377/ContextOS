# ContextOS CLI

`contextos-cli` lets an Agent read ContextOS history and invoke the same business operations exposed by MCP. It ships with ContextOS and uses the existing compatible database directly; there is no daemon or separate service.

## Commands

Compatibility read commands remain available:

```text
contextos-cli search QUERY
contextos-cli sessions [filters]
contextos-cli show SESSION_KEY
contextos-cli projects
contextos-cli memories [filters]
contextos-cli workspace-changes [--project PATH] [--since WHEN] [--limit N]
contextos-cli workspace-change ID [--max-chars N]
contextos-cli workspace-delete-change ID
contextos-cli context
contextos-cli refresh-context
```

Seven domain commands expose current ContextOS business functionality:

```text
contextos-cli settings OPERATION
contextos-cli sessions OPERATION
contextos-cli relations OPERATION
contextos-cli compression OPERATION
contextos-cli memories OPERATION
contextos-cli data-sources OPERATION
contextos-cli laya OPERATION
```

The operation is merged into a JSON request supplied with `--input FILE` or `--input -`. A file is recommended for complex input; `-` reads stdin.

```powershell
contextos-cli settings get --input request.json
contextos-cli sessions update_metadata --input request.json
Get-Content request.json -Raw | contextos-cli compression run --input -
```

Use `--db PATH` to operate on another existing compatible ContextOS database. CLI and MCP never create, migrate, repair, rescan, or rebuild that database.

`contextos-cli context` reads the current index and prints a compact handoff for the working directory. `contextos-cli refresh-context` first performs the same incremental scan used by Wake, then prints that handoff; it is intended for SessionStart hooks, including when the GUI is closed. Both print nothing when the current directory has no matching project history and never print full transcripts or modify agent session files. SessionStart hook snippets for Claude Code and Codex are available in Settings → Connect and `contextos-cli setup`; merge them into existing hook configuration rather than replacing other hooks. GUI scans, watcher scans, and CLI refreshes serialize across processes using a lock adjacent to the index. Compression paths in the output can be opened directly or read through ContextOS tools.

`contextos-cli workspace-changes` reads the unified timeline for manually monitored workspaces, including filesystem observations and explicit file operations found in session logs. A session key is returned only when the log names the operation; no project/time-window matching is used. Use the exact monitored workspace path with `--project`; use the returned event id with `contextos-cli workspace-change ID` to read captured before/after text snapshots and any exact session key. Snapshot output is capped by `--max-chars`. `contextos-cli workspace-delete-change ID` permanently removes one workspace timeline event and deletes snapshot blobs only when no other workspace event, monitored-file baseline, or session-file record references them; it does not modify the monitored file or its baseline.

## Operations

| Domain | Operations |
|---|---|
| `settings` | `get`, `update` |
| `sessions` | `list`, `get`, `search`, `list_projects`, `update_metadata`, `trash`, `cleanup_history` |
| `relations` | `list`, `create`, `update`, `delete` |
| `compression` | `list_turns`, `run`, `update`, `get_document`, `update_document`, `trash_document` |
| `memories` | `list`, `get`, `create`, `update`, `trash` |
| `data-sources` | `list`, `add`, `set_enabled`, `remove`, `reset` |
| `laya` | `status`, `start`, `stop`, `install`, `uninstall` |

Example requests:

```json
{"operation":"get","section":"compression"}
```

Compression settings are returned as two groups:

- `service`: LLM/decision-model enablement, provider list, active provider, URLs, timeouts, input limits, and Laya's `managed` / `external` runtime mode. External Laya uses `external_laya_api_url`; managed endpoints are dynamic process state and are not saved as user URLs.
- Managed Laya uses native `/v1/systemone/batch`. External Laya uses `/v1/systemone` with named candidates, including single-only SystemOne gateways such as Atomic Chat. OpenAI-compatible chat completion remains the separate LLM provider path.
- `strategy`: mechanical rule parameters, Jev scoring policy, and LLM strategy/prompt templates.

`settings update` accepts a partial patch. Objects are merged, arrays are replaced, and omitted fields stay unchanged:

```json
{
  "operation": "update",
  "section": "compression",
  "data": {
    "service": {
      "llm_timeout_secs": 900,
      "active_llm_provider_id": "provider-1"
    },
    "strategy": {
      "mechanical": {
        "retention_mode": "body_with_structure",
        "allow_jev_delete_assistant_body": false,
        "allow_jev_delete_user_messages": false,
        "expanded_max_chars": 6000,
        "evidence_max_chars": 2000,
        "generic_large_output_rule": {
          "min_output_chars": 4000,
          "head_chars": 900,
          "tail_chars": 700
        }
      },
      "jev": {
        "jev_candidate_min_chars": 2500,
        "jev_fallback_on_error": "use_mechanical"
      },
      "llm": {
        "llm_temperature": 0.2
      }
    }
  }
}
```

Defaults can be restored by explicit path:

```json
{
  "operation": "update",
  "section": "compression",
  "reset_defaults": [
    "strategy.mechanical.empty_output_rule",
    "strategy.jev.jev_score_levels",
    "strategy.llm.llm_user_prompt_template"
  ]
}
```

Provider entries are OpenAI-compatible endpoint configs. CLI/MCP return `api_key_configured` only; they never return or update `api_key`. Configure keys in the GUI.

The `laya` command controls the shared managed runtime. A running GUI-owned process is attachable by CLI/MCP after its executable, command line, installation, and endpoint are validated. Use `--delete-models` only with `laya uninstall` when the downloaded model cache should also be removed.

```json
{
  "operation": "update_metadata",
  "key": "codex:SESSION_ID",
  "favorite": true,
  "pinned": true,
  "add_tags": ["development"],
  "remove_tags": []
}
```

```json
{
  "operation": "run",
  "session_keys": ["codex:SESSION_ID"],
  "output": "D:\\exports\\session-compressed.md",
  "overwrite": false,
  "jev_enabled": true,
  "llm_enabled": true,
  "generate_memory_candidates": true
}
```

Compression supports one or several explicitly listed sessions. Memory candidates are returned but never saved automatically.

Search ContextOS-owned compression documents with the shared SQLite full-text index:

```powershell
Get-Content compression-search.json -Raw | contextos-cli compression search --input -
```

```json
{
  "query": "Laya runtime",
  "project": "D:\\Wake",
  "limit": 20,
  "expand_relations": true,
  "include_content": false
}
```

The result is ranked with SQLite FTS5/BM25 and includes highlighted titles, matching snippets, and optional one-hop results from the existing session relationship graph. This is lexical retrieval only: it does not use embeddings, a vector database, or RAG. The search operation synchronizes the derived index from project `.ContextOS` directories and the global ContextOS compression directory before querying it.

`compression update` only compresses turns after the document's `contextos_coverage`. When LLM compression is enabled, a bounded view of the existing document is supplied as read-only continuity context; the generated result still contains only the new continuation and is appended to the existing document.

Sessions do not need a recorded relationship to be compressed together. When selected sessions do have relationships, the shared compression service adds that context and the configured relationship strategy. Tags and manual relationship names may be custom values; built-in values are suggestions only.

To select exact conversation turns, use `session_inputs` instead of `session_keys`:

```json
{"operation":"list_turns","session_key":"codex:SESSION_ID"}
```

Use the returned number, seq range, character count, and user-message preview to choose inputs:

```json
{
  "operation": "run",
  "session_inputs": [
    {"session_key": "codex:SESSION_ID", "turn_numbers": [2, 4, 5]},
    {"session_key": "claude-code:SESSION_ID", "turn_numbers": [1]}
  ],
  "output": "D:\\exports\\selected-turns.md"
}
```

Turns are one-based. A turn starts at a user message and includes following Agent/tool messages up to the next user message. Explicit turn selection excludes unselected turns and sidechains.

The shared GUI/MCP/CLI compression service packs complete turns into blocks when input exceeds `llm_input_limit_chars`. It never silently splits or truncates one oversized turn. Provider failures include structured `error.details` such as stage, provider/model, session/turn or block, elapsed time, timeout, character counts, HTTP status and retryability when available.

Each source in compression `stats` includes `mechanical_rule_hits`, `jev_level_counts`, and `jev_action_counts`, alongside before/after character counts. `stats.decision.fragments` lists each Jev/Laya candidate by source, turn, fragment, configured grade, and applied retention action; the generated Markdown processing report includes the same per-fragment table.

To persist a candidate returned by `compression run`, pass the complete object so its type and metadata survive:

```json
{
  "operation": "create",
  "source_session_key": "codex:SESSION_ID",
  "candidate": {
    "kind": "resume_hint",
    "title": "Resume point",
    "content": "Continue from the verified build.",
    "scope": "project",
    "target": "memory",
    "reason": "Useful next-session context",
    "trigger": "When work resumes",
    "boundary": "Only this project",
    "next_action": "Run the focused build",
    "related_paths": ["crates/wake-core"],
    "evidence": "The previous build passed",
    "confidence": "high"
  }
}
```

## Result Contract

Domain commands write one JSON envelope to stdout:

```json
{"ok":true,"data":{},"warnings":[]}
```

```json
{"ok":false,"error":{"code":"invalid_request","message":"..."}}
```

Exit codes:

- `0`: operation succeeded, including empty search results.
- `1`: operation executed but failed. Domain commands still return the JSON error envelope on stdout.
- `2`: command syntax or database startup error.

## Boundaries

- Original user and Agent messages are immutable. No command edits transcript content.
- Session, ContextOS document, and ContextOS-owned Memory deletion only moves supported files to the OS trash.
- Permanent deletion and recovery are not exposed.
- Automatic relations are read-only; only `source: "manual"` relations can be changed.
- API keys are never returned. Settings only report configured booleans, and API keys cannot be changed through CLI/MCP.
- Settings and data-source changes return `restart_required: true`; a running GUI may use them after ContextOS is reopened.
- Remote Hosts and old Wake features absent from the ContextOS UI are out of scope.

Run `contextos-cli --help` for compatibility command flags and installed paths.
