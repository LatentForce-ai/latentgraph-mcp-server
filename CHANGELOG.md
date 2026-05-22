# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.27] — 2026-05-22

### Added
- Initial open-source release of the Latentgraph CLI and MCP server.
- `lgraph start` — interactive and non-interactive project setup with daemon launch.
- `lgraph init` — full project scan and indexing.
- `lgraph update` / `update-drg` / `update-wiki` / `update-implicit` / `update-file-index` — incremental and baseline index update pipeline.
- `lgraph analyze` — code metrics collection (LOC, tokens, comments, git activity).
- `lgraph add` — one-command MCP integration for Claude Code, GitHub Copilot, Cursor, Kiro, Codex, Opencode, LatentCode, and Factory Droid.
- `lgraph join` — join a shared or publicly shared project without re-indexing.
- `lgraph branch` / `checkout` / `push` / `merge` — branch-aware collaboration.
- `lgraph config` — manage API key, GitHub token, and server URLs.
- MCP server with 11 tools: `get_context`, `get_file`, `get_dependencies`, `get_change_impact`, `get_design_knowledge`, `get_call_chain`, `get_symbol`, `get_dependency_path`, `search_codebase`, `ask_codebase`, `update_graph`.
- Background WebSocket daemon with automatic reconnection.
- Support for JavaScript/TypeScript, Python, C#, C/C++ source scanning.
- Guest mode — try without an API key using machine fingerprinting.
