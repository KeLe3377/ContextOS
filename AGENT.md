# Agent Instructions

- Do not use CodeGraph in this repository unless the user explicitly initializes it or asks for it.
- If a `.codegraph/` directory is absent, inspect files with normal repository tools such as `rg`, `Get-ChildItem`, and direct file reads.
- For backend development, prioritize fast forward progress over strict red-green TDD. Do not run red-light/failing-test-first cycles unless the user explicitly asks for them.
- Implement first, then run targeted verification such as build, tests, or startup checks.
- For incremental work already covered by the repository roadmap or an approved full design, develop directly without creating a separate feature spec and implementation plan. Stop for design approval only when the change introduces a new product boundary or materially changes an existing contract. After each completed, verified increment, commit the changes locally unless the user says otherwise.
- Keep backend scope aligned with the existing frontend pages and explicitly confirmed product modules. Do not add new frontend pages or product modules just because they appear architecturally useful; unaligned APIs create frontend/backend drift and waste time. The current backend roadmap is a deliberately simplified version of the original plan: finish a minimal Evidence Store, then minimal Settings + Jobs runtime, then a Codex-only adapter MVP, then frontend API integration. Record internal Jobs/Audit/Outbox only as support infrastructure, not as standalone product surfaces. These simplified pieces can be deepened later.
- Windows shell/sandbox helpers may be unstable. When tool execution becomes flaky, avoid fragmented retry loops: batch related reads/writes, use the most stable available command path, and keep the user informed only when it affects progress.


