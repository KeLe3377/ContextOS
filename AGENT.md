# Agent Instructions

- Do not use CodeGraph in this repository unless the user explicitly initializes it or asks for it.
- If a `.codegraph/` directory is absent, inspect files with normal repository tools such as `rg`, `Get-ChildItem`, and direct file reads.
- For backend development, prioritize fast forward progress over strict red-green TDD. Do not run red-light/failing-test-first cycles unless the user explicitly asks for them.
- Implement first, then run targeted verification such as build, tests, or startup checks.
- Windows shell/sandbox helpers may be unstable. When tool execution becomes flaky, avoid fragmented retry loops: batch related reads/writes, use the most stable available command path, and keep the user informed only when it affects progress.
