# ContextOS

ContextOS 是一个面向 AI 编程 Agent 的桌面工作台。它把分散在本机各个 Agent 中的会话、项目改动和可复用上下文集中起来，让用户和 Agent 能够搜索历史、查看变更、整理记忆，并通过 MCP 或 CLI 继续组合这些能力。

ContextOS 基于 [Wake](https://github.com/iAmCorey/Wake) 进行二次开发。感谢 Corey Chiu 和 Wake 项目为会话浏览器、数据适配器及 Rust + GPUI 应用提供的基础。

## 功能

- **统一浏览 Agent 会话**：扫描多个编程 Agent 的本地会话数据，按 Agent 和项目查看会话，全文搜索并定位到具体消息；支持查看对话、工具调用、模型与 Token 信息。
- **继续和整理会话**：从原项目位置恢复会话，收藏、置顶、导出 Markdown，或将不需要的会话移入系统废纸篓。
- **追踪项目改动**：监控用户指定的工作区，记录文件改动和前后快照；同时展示会话日志明确记录的文件操作，便于回看 Agent 在项目中的工作。
- **压缩长会话**：组合机械规则、Jev 评估与可配置的 LLM 策略，按完整对话轮次处理内容，并管理生成的摘要和压缩文档。
- **管理记忆与 Skill**：浏览和维护 Agent 记忆、项目指令及 Skill；查看 Skill 在不同 Agent 目录中的安装和同步状态。
- **查看使用统计与清理记录**：按 Agent、项目、模型和时间查看会话及 Token 统计；整理历史索引和会话文件。
- **通过 MCP 和 CLI 组合操作**：桌面应用、`contextos-mcp` 和 `contextos-cli` 共享业务实现。Agent 可按需组合会话、改动、记忆、关系、压缩、数据源和 Laya 运行时等操作。
- **本机索引与可选外部服务**：会话索引保存在本机。可选的 LLM 或 Jev 压缩服务会按用户配置发送相应输入；远程工作区能力通过用户配置的 SSH 主机同步会话数据。

## 支持的 Agent

内置数据适配器覆盖 Claude Code、Codex、Cursor、Gemini CLI、OpenCode、Kiro、Pi、Qoder、Copilot CLI、Kimi Code、Grok Build、DeepSeek Harness、Hermes、OpenClaw、CodeBuddy、WorkBuddy、ZCode 等 Agent。各 Agent 可提供的会话字段和恢复方式取决于其本地数据格式。

## 构建

项目使用 Rust、Cargo 和 GPUI。请在目标操作系统上安装 Rust 工具链及 GPUI 所需的系统依赖，然后运行对应平台的发行脚本：

```text
macOS:  scripts/make-app.sh
Linux:  scripts/make-linux.sh
Windows: powershell -ExecutionPolicy Bypass -File scripts/make-windows.ps1
```

开发时可使用 `cargo run -p wake` 启动桌面应用，或运行 `scripts/build-dev.ps1` 构建 Windows 下的开发二进制。MCP 和 CLI 的配置与命令说明见 [`docs/mcp.md`](docs/mcp.md) 和 [`docs/cli.md`](docs/cli.md)。

## 致谢与许可

ContextOS 从 [iAmCorey/Wake](https://github.com/iAmCorey/Wake) 派生。Wake 项目采用 MIT License；感谢上游作者和贡献者的工作。使用或分发基于 Wake 的代码时，请遵守上游仓库中的 [MIT 许可声明](https://github.com/iAmCorey/Wake/blob/main/LICENSE)。
