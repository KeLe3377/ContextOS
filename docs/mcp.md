# ContextOS MCP

`contextos-mcp` is the stdio MCP server shipped beside ContextOS. It exposes session history plus current ContextOS business operations to coding Agents. MCP, CLI, and the desktop application are built and released together.

## Setup

Run `contextos-mcp setup` to print configuration snippets for Claude Code, Codex, and Cursor. Typical Codex configuration:

```toml
[mcp_servers.contextos]
command = "D:\\path\\to\\contextos-mcp.exe"
```

The server reads ContextOS's default database. Pass `--db PATH` to use another existing compatible database. It does not create, migrate, repair, rescan, or rebuild an index.

## Tools

Compatibility tools:

```text
contextos_search
contextos_list_sessions
contextos_get_session
contextos_list_projects
contextos_list_memories
contextos_list_workspace_changes
contextos_get_workspace_change
contextos_delete_workspace_change
```

Business domain tools:

```text
contextos_settings
contextos_sessions
contextos_relations
contextos_compression
contextos_memories
contextos_data_sources
contextos_laya
```

Each domain tool accepts an object with an `operation` field. `tools/list` publishes the complete shared parameter schema for every operation, including nested `session_inputs` and memory candidates. Its payload shape is the same as the corresponding CLI command documented in [cli.md](cli.md).

`contextos_list_workspace_changes` reads file-monitor events for manually monitored workspace directories. It returns event ids, project-relative file paths, change kinds, timestamps, and hashes. Pass the exact monitored workspace path as `project` to scope the result. Use `contextos_get_workspace_change` with an event id to read historical before/after text snapshots when captured. `contextos_delete_workspace_change` permanently removes one timeline event and reclaims its snapshots only when no other workspace event, monitored-file baseline, or session-file record references them. It does not modify the current workspace file or baseline. Session-log file operations are stored and displayed in the separate session changes view; they are not matched to workspace events.

Call `contextos_compression.list_turns` with `session_key` to obtain turn numbers, seq ranges, sizes, and previews. Then call `run` with `session_keys` for complete sessions or `session_inputs` to choose one-based `turn_numbers` independently for each session. The two input forms are mutually exclusive.

LLM input is packed on complete-turn boundaries. Inputs larger than the configured character limit are sent as multiple blocks and their outputs and memory candidates are merged. A single oversized turn is not split or silently truncated; the error includes its session key, turn and character counts. Related sessions receive their recorded relationship context, while unrelated sessions remain valid ordinary multi-session input.

```json
{"name":"contextos_settings","arguments":{"operation":"get","section":"compression"}}
```

Compression settings use the same `service` / `strategy` shape as CLI:

- `service` contains LLM/decision-model enablement, provider list, active provider, URLs, timeouts, input limits, and Laya's `managed` / `external` runtime mode. External Laya uses `external_laya_api_url`; a managed endpoint is process state and is never persisted as that URL.
- Managed Laya uses native `/v1/systemone/batch`. External Laya uses `/v1/systemone` with named candidates, which supports single-only SystemOne gateways such as Atomic Chat. OpenAI-compatible chat completion remains the separate LLM provider path.
- `strategy` contains mechanical rule parameters, Jev scoring policy, and LLM strategy/prompt templates.

Agents can patch only the fields they want to change:

```json
{
  "name": "contextos_settings",
  "arguments": {
    "operation": "update",
    "section": "compression",
    "data": {
      "strategy": {
        "mechanical": {
          "generic_large_output_rule": {
            "min_output_chars": 4000
          }
        },
        "llm": {
          "llm_temperature": 0.2
        }
      }
    }
  }
}
```

Use `reset_defaults` with explicit paths to restore defaults. API keys are never returned or accepted through MCP; only `api_key_configured` booleans are visible. Configure keys in the GUI.

`contextos_laya` exposes `status`, `start`, `stop`, `install`, and `uninstall` for the managed Laya runtime. GUI, MCP, and CLI attach to the same validated runtime record; a running GUI-owned Laya process is reusable by MCP instead of being treated as an ownership conflict.

`contextos_compression.update` reads the document's `contextos_coverage` cursor and appends only new session turns. Existing compressed content is preserved.

```json
{
  "name": "contextos_compression",
  "arguments": {
    "operation": "run",
    "session_keys": ["codex:SESSION_ID"],
    "output": "D:\\exports\\compressed.md",
    "generate_memory_candidates": true
  }
}
```

Persist a returned candidate without dropping its type or evidence:

```json
{
  "name": "contextos_memories",
  "arguments": {
    "operation": "create",
    "source_session_key": "codex:SESSION_ID",
    "candidate": {
      "kind": "resume_hint",
      "title": "Resume point",
      "content": "Continue from the verified build.",
      "scope": "project",
      "confidence": "high"
    }
  }
}
```

## Result Contract

Domain tool text contains one stable JSON envelope:

```json
{"ok":true,"data":{},"warnings":[]}
```

or:

```json
{"ok":false,"error":{"code":"provider_error","message":"...","details":{"stage":"llm_request","block_number":2,"retryable":true}}}
```

Business failures stay normal MCP tool results so the Agent can inspect the domain error. JSON-RPC errors are reserved for malformed protocol calls, invalid tool argument shape, unknown tools, and internal protocol failures.

Compression `stats.sources` reports `mechanical_rule_hits`, `jev_level_counts`, and `jev_action_counts` together with before/after character counts. `stats.decision.fragments` lists each Jev/Laya candidate by source, turn, fragment, configured grade, and applied retention action; the generated Markdown processing report includes the same per-fragment table. These diagnostics are intended for the Agent loop: read settings, adjust a partial patch, run real compression, inspect the result, then refine only the fields that need changing.

`contextos_compression` also supports `operation: "search"`. It accepts `query`, optional `project`, `limit`, `expand_relations`, and `include_content`. The operation synchronizes ContextOS-owned compression documents into SQLite FTS5, ranks direct matches with BM25, returns highlighted titles and snippets, and can append one-hop results through existing `session_links`. It is keyword retrieval only and does not use embeddings, a vector database, or RAG.

`operation: "update"` continues from `contextos_coverage`. With LLM compression enabled, a bounded portion of the existing derived document is passed as read-only continuity context. Only the newly generated continuation is appended; existing content is not regenerated.

## Boundaries

- Original user and Agent messages are immutable.
- Session and derived-file delete operations move supported files to the OS trash; there is no recovery command.
- Workspace timeline events can be permanently deleted; captured snapshots are reclaimed only when no workspace event or monitored-file baseline references them.
- There is no search-index rebuild, dry-run framework, or public test operation.
- Automatic relations are read-only; manual relations are writable.
- ContextOS can only modify ContextOS-owned derived documents and user Memories.
- Compression memory candidates are suggestions and are never persisted automatically.
- API keys are neither returned nor changed. Only configured booleans are visible.
- Business settings and data-source changes may require reopening ContextOS.
- Remote Hosts and old Wake features absent from the ContextOS UI are excluded.

## Protocol

- Transport: stdio, one JSON-RPC 2.0 message per line.
- Methods: `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`.
- Capabilities: tools only.
- stdout is protocol-only; diagnostics go to stderr.

For a direct smoke call without an MCP client:

```powershell
contextos-mcp call contextos_settings '{"operation":"get","section":"compression"}'
```
