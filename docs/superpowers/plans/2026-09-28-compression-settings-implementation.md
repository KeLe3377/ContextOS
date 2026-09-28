# Compression Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement editable compression service and strategy settings across GUI, MCP, CLI, and the shared Rust compression engine.

**Architecture:** Move compression settings loading, defaults, validation, public redacted views, and patch updates into wake-core so GUI, MCP, CLI, and compression execution share one source of truth. Keep real compression behavior in Rust functions, expose only built-in parameters/templates through settings, and update ContextOS skill only after the implementation and real MCP/CLI validation are complete.

**Tech Stack:** Rust, serde/serde_json, reqwest blocking client, SQLite prefs through `Store`, GPUI/gpui-component settings UI, existing `contextos_settings` and `contextos_compression` domain handlers.

---

## File Structure

- Create `crates/wake-core/src/services/compression_settings.rs`
  - Owns provider v2 storage, service settings, mechanical/Jev/LLM strategy structs, defaults, validation, public view, and patch/reset operations.
- Modify `crates/wake-core/src/services/mod.rs`
  - Exports the new settings module.
- Modify `crates/wake-core/src/services/compression.rs`
  - Loads settings through `compression_settings`, applies mechanical parameters, Jev scoring levels, LLM outer prompt templates, and richer diagnostics.
- Modify `crates/wake-core/src/services/control.rs`
  - Makes `contextos_settings` return/update the new nested `service`/`strategy` public settings shape.
- Modify `crates/wake-core/src/mcp/tools.rs`
  - Updates schema descriptions for nested compression settings.
- Modify `crates/wake-core/src/bin/wake_cli.rs` and `crates/wake-core/src/cli.rs` only if the generic domain input path needs help text/schema updates.
- Modify `crates/wake/src/workbench.rs`
  - Replaces fixed provider handling and current compression settings snapshots with shared wake-core settings structs or mirrored GUI structs.
- Modify `crates/wake/src/settings.rs`
  - Splits settings into `压缩服务` and `压缩策略`, adds model provider dialog, mechanical rule edit dialogs, Jev prompt editor, and LLM outer template dialogs.
- Modify `docs/cli.md` and `docs/mcp.md`
  - Documents concrete MCP/CLI compression settings contract after code exists.
- Modify `skills/contextos/SKILL.md` and maybe `skills/wake/SKILL.md`
  - Only after code and real CLI/MCP verification pass.

## Tasks

### Task 1: Shared Compression Settings Model

**Files:**
- Create: `crates/wake-core/src/services/compression_settings.rs`
- Modify: `crates/wake-core/src/services/mod.rs`

- [ ] Add serde structs for `CompressionSettingsPublic`, `CompressionServicePublic`, `CompressionStrategyPublic`, `LlmProviderPublic`, `LlmProviderConfig`, `MechanicalStrategySettings`, `JevStrategySettings`, `LlmPromptSettings`, and every mechanical rule group from the spec.
- [ ] Implement defaults matching the design document:
  - Provider v2 keys: `compression_llm_providers_v2`, `compression_llm_active_provider_id`.
  - Mechanical rule group defaults.
  - Jev request/candidate limits, prompt template, fixed six score levels, fallback behavior.
  - LLM strategy defaults and outer prompt template defaults.
- [ ] Implement provider v2 loading and one-way migration from the current valid legacy provider values without writing empty slot providers.
- [ ] Implement redacted public view that returns `api_key_configured` but never returns API keys.
- [ ] Implement `update_from_patch(store, data, reset_defaults)` with recursive object patch semantics, array replacement semantics, white-listed resets, field validation, and API key rejection.
- [ ] Run `cargo check -p wake-core --all-targets`.
- [ ] Commit this task.

### Task 2: MCP/CLI Settings Contract

**Files:**
- Modify: `crates/wake-core/src/services/control.rs`
- Modify: `crates/wake-core/src/mcp/tools.rs`
- Modify: `docs/cli.md`
- Modify: `docs/mcp.md`

- [ ] Replace the flat compression settings public view with `compression_settings::public_settings(store)`.
- [ ] Replace `update_compression_setting` with patch/reset delegation to `compression_settings::update_settings`.
- [ ] Keep operation shape `settings.get/update section=compression`.
- [ ] Ensure CLI and MCP still reject API key writes and only expose configured booleans.
- [ ] Update MCP schema for nested `service`, `strategy`, `reset_defaults`, provider v2 fields, mechanical rules, Jev strategy fields, and LLM prompt fields.
- [ ] Update CLI/MCP docs with examples for get, patch update, reset defaults, and API key boundary.
- [ ] Run `cargo check -p wake-core --all-targets`.
- [ ] Exercise `contextos-cli settings get --input` and `contextos-mcp call contextos_settings` against the real local database if binaries are available after build.
- [ ] Commit this task.

### Task 3: Compression Runtime Uses Strategy Settings

**Files:**
- Modify: `crates/wake-core/src/services/compression.rs`
- Optionally split during implementation:
  - `crates/wake-core/src/services/compression/settings.rs`
  - `crates/wake-core/src/services/compression/mechanical.rs`
  - `crates/wake-core/src/services/compression/jev.rs`
  - `crates/wake-core/src/services/compression/llm_prompt.rs`
  - `crates/wake-core/src/services/compression/diagnostics.rs`

- [ ] Replace hard-coded provider and strategy loading with `compression_settings::load_runtime_settings`.
- [ ] Make mechanical compaction consult rule group settings instead of fixed thresholds where the current Rust behavior already has an equivalent parameter.
- [ ] Keep rule order fixed in Rust and do not add runtime DSL/action scripting.
- [ ] Replace Jev boolean keep/full behavior with score level parsing:
  - Build prompt from `jev_prompt_template`.
  - Parse score, reason, and evidence hints.
  - Map scores to fixed level/action list.
  - Apply `discard`, `stub`, `use_mechanical`, `evidence`, `expanded`, and `verbatim` with Rust-owned behavior.
  - Respect `jev_fallback_on_error`.
- [ ] Replace hard-coded LLM system/user prompt shell with editable outer templates and required variable validation.
- [ ] Add diagnostics for mechanical rule hits, Jev score level/action counts, LLM block count, active provider id/name/model, and character counts.
- [ ] Run `cargo check -p wake-core --all-targets`.
- [ ] Run a real `contextos-cli compression run` with a small indexed session when available.
- [ ] Commit this task.

### Task 4: GUI Compression Service Page

**Files:**
- Modify: `crates/wake/src/workbench.rs`
- Modify: `crates/wake/src/settings.rs`
- Modify: `crates/wake/locales/zh-Hans.json` if new UI text must be localized through the existing locale path.

- [ ] Add settings pages `压缩服务` and `压缩策略` in the sidebar, replacing the single compression page entry.
- [ ] Render `压缩服务` with LLM enabled, active provider summary, `模型配置`, LLM timeout, LLM input limit, Jev enabled, Jev URL, Jev Key, and Jev timeout.
- [ ] Implement unlimited provider v2 model dialog:
  - List providers with name, URL, model, key configured, active status.
  - Add, edit, duplicate, delete, activate, and test actions.
  - Do not show API key plaintext; empty key preserves old key; explicit clear key action exists in GUI only.
- [ ] Persist providers through shared keys and preserve existing URL/API Key/Model during migration.
- [ ] Run `cargo check -p wake --all-targets`.
- [ ] Launch the GUI build if feasible and inspect the settings page.
- [ ] Commit this task.

### Task 5: GUI Compression Strategy Page

**Files:**
- Modify: `crates/wake/src/settings.rs`
- Modify: `crates/wake/src/workbench.rs`

- [ ] Render mechanical rule group summary rows in Chinese with `编辑` buttons.
- [ ] Implement per-rule edit dialogs with Chinese labels, save, restore default, and cancel.
- [ ] Render Jev strategy summary row and dedicated Jev prompt editor:
  - Multi-line prompt editor.
  - Score level table for six levels.
  - Example explanatory section.
- [ ] Render existing LLM strategy editors and add LLM outer template editors:
  - system message
  - task template
  - user prompt template
  - memory candidate contract
  - temperature
- [ ] Use shared validation errors from wake-core where possible and show human-readable errors in GUI notifications.
- [ ] Run `cargo check -p wake --all-targets`.
- [ ] Launch the GUI build if feasible and inspect dialogs for text overflow/overlap.
- [ ] Commit this task.

### Task 6: Docs, Skill, and Real Verification

**Files:**
- Modify: `docs/cli.md`
- Modify: `docs/mcp.md`
- Modify: `skills/contextos/SKILL.md`
- Modify: `skills/wake/SKILL.md` if it remains a compatibility skill.

- [ ] Build real binaries:
  - `cargo build -p wake-core --bin contextos-cli --bin contextos-mcp`
  - `cargo build -p wake`
- [ ] Run real CLI settings get/update/reset calls against the current ContextOS database.
- [ ] Run real MCP `contextos-mcp call contextos_settings` get/update calls.
- [ ] Run one real compression with the new settings path and inspect diagnostics.
- [ ] Update ContextOS skill only after the verified commands and field names are final:
  - mention settings get/update,
  - mention API key boundary,
  - mention service/strategy split,
  - mention compression run diagnostics loop,
  - mention Rust operation edits for new behavior instead of JSON rule DSL.
- [ ] Commit docs and skill updates.

## Self-Review

- Spec coverage: the plan covers provider v2, GUI page split, mechanical rules, Jev scoring prompt/levels, LLM outer templates, MCP/CLI nested settings, diagnostics, docs, and delayed skill update.
- Scope boundary: the plan does not add runtime DSL, arbitrary scripts, multi-profile/package management, import/export, rule marketplace, or graphical rule builder.
- User process boundary: the plan does not require red-light TDD or isolated temporary environments; verification uses cargo checks/builds and real CLI/MCP paths.
