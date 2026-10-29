---
name: contextos
description: Use ContextOS MCP and CLI to search and read coding-agent history, inspect workspace-change records, and manage exposed ContextOS data. Trigger when the user refers to earlier conversations, decisions, work handoff, or indexed changes.
---

# ContextOS — past coding-agent sessions

ContextOS indexes coding-agent sessions and exposes the same business capabilities through
the `contextos` MCP server and `contextos-cli`. Prefer MCP tools when they are available:
their structured arguments and results avoid shell quoting and path-format mistakes. Use
`contextos-cli` when MCP is unavailable, when a command-line workflow is more practical, or
when the user asks for a shell command. Use ContextOS names throughout; do not suggest the
retired `wake-cli` or `wake-mcp` executable names.

Reach for it whenever the answer lives in an earlier conversation rather than in the
code: what was discussed, what was decided and why, where previous work stopped, which
approaches were already tried and rejected, whether an error has been seen before. Git
history and the working tree do not hold any of that.

The original conversation messages are immutable. Domain commands can update business settings,
session metadata, manual relations, ContextOS-owned memories, derived compression documents,
and local data sources. Session-file deletion moves supported files to the OS trash. Workspace
change history also supports permanent deletion of a timeline event and any snapshots no longer
referenced by another event or monitored-file baseline.

## Finding the binary

```bash
command -v contextos-cli || ls /Applications/ContextOS.app/Contents/MacOS/contextos-cli
```

Use whichever resolves. On Linux it is on `PATH` after a deb install, or at
`~/.local/bin/contextos-cli` from the tarball. On Windows it sits next to `ContextOS.exe`; in this repository's debug build use `target/debug/contextos-cli.exe`. The MCP server is the sibling `contextos-mcp` executable.

Two things can be missing, and they need different answers:

- **No binary.** Say so — the user needs ContextOS.
  Do not try to install it yourself.
- **No index** (`no ContextOS index at … — launch ContextOS once to build it`). ContextOS is
  installed but has never run. Run `contextos-cli index` once; it builds the index in a
  few seconds without opening the app, then retry your query.

## Commands

## MCP-first access

Use the installed ContextOS MCP tools directly when available:

- `contextos_search` finds prior discussion by topic, error, file, or decision.
- `contextos_sessions` lists, reads, searches, and updates supported session metadata.
- `contextos_get_session` reads a transcript by session key or `wake://session/...` reference.
- `contextos_list_workspace_changes` lists monitor events for an exact workspace path;
  `contextos_get_workspace_change` reads the captured snapshots for one event id.
- `contextos_settings`, `contextos_relations`, `contextos_compression`,
  `contextos_memories`, `contextos_data_sources`, and `contextos_laya` expose their
  corresponding ContextOS operations. Follow each tool's current schema; do not guess
  parameter names or encode an operation the tool does not expose.

Workspace monitor events and session-log file operations are distinct records. A workspace
event does not by itself identify the session that caused it. Use the exact monitored root
for `project`; do not infer a session from matching timestamps or file paths.

When continuing a session, read it with `contextos_get_session` first. Use the CLI fallback
`contextos-cli show SESSION_KEY` only when shell access is needed. For a project's monitor
history, use `contextos_list_workspace_changes` or the CLI equivalent below.

Always scope to the current repository with `--project "$PWD"` unless the user clearly
means "everywhere". Without it, every project on the machine is in scope.

**What happened in this project recently**

```bash
contextos-cli sessions --project "$PWD" --limit 10
```

At a new session, `contextos-cli context` prints a short handoff for the current project, including the most recent exchange and linked compression-document paths. The optional Claude Code and Codex SessionStart hooks are shown in ContextOS Settings → Connect; merge those entries with existing hooks instead of replacing them.

When the task depends on files changed during earlier Agent work, query `contextos_list_workspace_changes` with the exact monitored root path, then call `contextos_get_workspace_change` for the relevant event id to read the stored before/after snapshot. The equivalent CLI commands are `contextos-cli workspace-changes --project "$PWD"` and `contextos-cli workspace-change ID`.

Use `contextos_delete_workspace_change` or `contextos-cli workspace-delete-change ID` when the user asks to permanently remove a workspace timeline entry. The operation also removes snapshot data only when it is no longer referenced by another workspace event, monitored-file baseline, or session-file record.

Add `--agent codex` (repeatable), `--since 7d`, or `--starred` to narrow it.

**Where was this discussed**

```bash
contextos-cli search "rate limiter" --project "$PWD"
```

Terms are ANDed. CJK text and code substrings like `useEffect(` work. Drop `--project`
when the user asks about something they might have worked on elsewhere.

**Read a session**

```bash
contextos-cli show 'claude-code:1b2c3d4e-…'
```

Add `--tools` for tool inputs and outputs, `--thinking` for recorded reasoning. Both are
verbose — start without them. Work done by subagents (Claude Code sidechains, Cursor
subagents) is not in the main transcript; its ids are listed at the end of the output —
read one with `--subagent ID`, or `--subagent '*'` to list them all. Sub-agents that run
as sessions of their own (Codex `spawn_agent`, Grok) are listed at the end too, by key;
`sessions` only lists parents, so this is where to find them.

**Which projects have history**

```bash
contextos-cli projects --limit 20
```

**What an agent already remembers about this project**

```bash
contextos-cli memories --project "$PWD"
```

The memory files agents keep for themselves — Claude Code's auto-memory, Codex's
memories, ZCode's project memory — plus the instruction files kept for them (CLAUDE.md,
AGENTS.md, GEMINI.md, `.cursor/rules` …), read-only, grouped by project, user memory
(notes that apply to every project) last. Each entry ends with a `wake://memory/…`
reference; pass it to `show` to read the file. Reach for it before re-deriving a
project's conventions or decisions from scratch.

## Business operations

Domain operations accept a JSON object from `--input FILE`, or `--input -` for stdin. The
operation on the command line wins over an `operation` field in the JSON.

```bash
contextos-cli settings get
contextos-cli sessions update_metadata --input request.json
contextos-cli relations create --input request.json
contextos-cli compression run --input request.json
contextos-cli memories create --input request.json
contextos-cli data-sources list --input request.json
contextos-cli laya status
```

For compression, call `list_turns` with `session_key` to inspect number/seq/size/preview.
Use `session_keys` for complete sessions, or control the exact input with
`session_inputs: [{"session_key":"...","turn_numbers":[1,3]}]`; turns are one-based
user/Agent exchanges and explicit selection excludes sidechains.

Compression settings are available through `contextos-cli settings get --input request.json`
or MCP `contextos_settings` with `{"operation":"get","section":"compression"}`. The returned
shape is `service` plus `strategy`: service covers LLM/Jev connections, providers, active
provider, timeouts and limits; strategy covers mechanical rule parameters, Jev scoring, and
LLM prompt templates. Update only the fields you need with `settings update`, then verify with
a real `contextos_compression run` and inspect `stats`/diagnostics before adjusting again.

API keys are never returned and cannot be changed through CLI/MCP; only
`api_key_configured` booleans are visible. Ask the user to configure keys in the GUI.

Do not invent new compression operations with JSON, scripts, or a rule DSL. Editable settings
only tune built-in Rust behavior. If the user needs genuinely new compression behavior, modify
the Rust compression engine operation functions, compile, and verify through real CLI/MCP paths.
Do not operate the GUI for verification; list the affected GUI flows for the user to check
manually. Start from the compression settings/runtime modules rather than trying to encode
behavior inside a prompt or JSON setting.

Use `sessions` without an operation and `memories` without an operation for the compatible
read listings shown above. Never attempt to edit user or agent messages. Only ContextOS-owned
memory and derived Markdown files may be updated or trashed.

## Keys, references and paging

`sessions` and `search` print a key for every session — `<agent>:<id>`, or
`<agent>:<host>:<id>` for a session mirrored from a remote machine. Pass a key to `show`.

`search` also prints `ref: wake://session/<key>#<seq>` under each snippet. Pass the whole
reference (quoted) to `show` and the transcript starts at that message — that is the fast
path from "this term was mentioned" to "here is the surrounding conversation".

Long transcripts are paginated. When the output ends with a `from_seq` hint, run again
with `--from <that number>` to continue.

## Reading the results

- Exit code `0` means it ran — **including "no matches" and "no such project"**. Do not
  treat an empty result as a failure; report that nothing was found.
- Exit `1` means it ran and failed — an unknown or ambiguous key, or a transcript that
  would not parse. Exit `2` means the command line was wrong, or there is no readable index
  yet. Both print an explanation to stderr.
- Listings usually end with the index freshness (`Index covers activity up to …`) — the
  newest activity ContextOS has indexed, not the current time. A stale-looking value usually means
  ContextOS is not running, but some agents (Copilot, OpenCode, Antigravity, Hermes, OpenClaw) are
  stored in SQLite and only refresh when ContextOS launches, so say what the line shows rather than
  concluding the user did nothing. `show` does not depend on that line — it reads
  the agent's own file rather than the index. The exception is a session from a remote
  host (`<agent>:<host>:<id>`): that file is a local mirror, current as of ContextOS's last
  successful sync. Say so rather than reporting it as the other machine's latest state.
- Values out of range are clamped, not rejected: `--limit 999` returns the maximum.

## Sensible defaults

- Start with `sessions --project "$PWD"` when the user says "last time" or "yesterday",
  and with `search` when they name a topic, an error or a decision.
- Read one or two transcripts, not ten — `show` output is large.
- Quote keys and `wake://` references: they contain characters the shell will eat.
