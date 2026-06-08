# @latentforce/latentgraph

[![npm version](https://img.shields.io/npm/v/@latentforce/latentgraph.svg)](https://www.npmjs.com/package/@latentforce/latentgraph)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/LatentForce-ai/latentgraph-mcp-server/blob/main/LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)

AI-powered code intelligence CLI and MCP server.

Latentgraph indexes your codebase, builds a dependency relationship graph (DRG), and provides AI-powered insights via MCP tools - enabling AI coding assistants to understand your project's structure, dependencies, and blast radius of changes.

---

## Table of Contents

- [Installation](#installation)
- [Getting an API Key](#getting-an-api-key)
- [Quick Start](#quick-start)
- [CLI Reference](#cli-reference)
  - [lgraph start](#lgraph-start)
  - [lgraph init](#lgraph-init)
  - [lgraph status](#lgraph-status)
  - [lgraph update-drg](#lgraph-update-drg)
  - [lgraph update-wiki](#lgraph-update-wiki)
  - [lgraph update-implicit](#lgraph-update-implicit)
  - [lgraph update-file-index](#lgraph-update-file-index)
  - [lgraph update](#lgraph-update)
  - [lgraph analyze](#lgraph-analyze)
  - [lgraph stop](#lgraph-stop)
  - [lgraph add](#lgraph-add)
  - [lgraph join](#lgraph-join)
  - [lgraph config](#lgraph-config)
- [MCP Integration](#mcp-integration)
  - [Supported Tools](#supported-tools)
  - [Claude Desktop (manual)](#claude-desktop-manual)
- [Scan Targets](#scan-targets)
- [MCP Tools](#mcp-tools)
- [Configuration Files](#configuration-files)
- [Contributing](#contributing)

---

## Installation

Install globally from the npm registry:

```bash
npm install -g @latentforce/latentgraph
```

Verify the install:

```bash
lgraph --version
```

To upgrade an existing install to the latest published version:

```bash
npm install -g @latentforce/latentgraph@latest
```

---

## Getting an API Key

1. Go to **https://latentgraph.latentforce.ai/auth**
2. **Sign up** for an account
3. **Sign in** to your dashboard
4. Copy your **API key** from the dashboard under Account Settings

From the dashboard you can also **create a project** or can do directly from the CLI.

---

## Quick Start

All commands must be run from your project's root directory:

```bash
cd /path/to/your/project
```

### Option A — Interactive (recommended)

```bash
lgraph start    # Step 1: Configure API key and project, launch daemon
lgraph init     # Step 2: Scan and index project files
lgraph status   # Step 3: Verify everything is connected
```

When you run `lgraph start` interactively, it will:

1. **Ask for your API key** — paste the key from your dashboard
2. **Ask to create or select a project** — you can either:
   - Select an existing project from your account
   - Create a new project directly from the CLI (prompts for a name and migration template)

### Option B — Non-interactive (CI/CD)

```bash
lgraph init -k YOUR_KEY -n "My App"
```

If a project named "My App" already exists in your account it will be reused; otherwise a new one is created.

---

## CLI Reference

| Command | Description |
|---|---|
| `lgraph start` | Start the daemon and configure the project |
| `lgraph init` | Scan and index project files |
| `lgraph status` | Show current status |
| `lgraph update-drg` | Update the dependency relationship graph |
| `lgraph update-wiki` | Refresh Wiki module documentation |
| `lgraph update-implicit` | Run incremental implicit dependency analysis |
| `lgraph update-file-index` | Refresh per-file enrichment metadata |
| `lgraph update` | Run full incremental update pipeline (drg → implicit → wiki → file-index) |
| `lgraph analyze` | Collect code metrics for the dashboard |
| `lgraph stop` | Stop the daemon |
| `lgraph add [tool]` | Add Latentgraph MCP server to an AI coding tool |
| `lgraph join [project-name]` | Join a shared project as a contributor |
| `lgraph config` | Manage configuration |

---

### `lgraph start`

Resolves authentication, configures the project, and launches a background daemon that maintains a WebSocket connection to the Latentgraph backend.

**Interactive flow (no flags):**

1. Prompts for your API key
2. Prompts to select an existing project or create a new one
   - If creating: asks for a project name and lets you pick a migration template
3. Saves config to `.lgraph/config.json`
4. Launches the background daemon

| Flag | Short | Description |
|---|---|---|
| `--api-key <key>` | `-k` | Provide API key directly (skips the key prompt) |
| `--project-name <name>` | `-n` | Create new project or match existing by name |
| `--project-id <id>` | | Use existing project UUID |
| `--gh-token <token>` | | GitHub token for PR insights (optional) |

```bash
lgraph start                                    # Interactive setup
lgraph start -k <key> -n "My App"               # Non-interactive
lgraph start -k <key> --gh-token ghp_...        # Set API key and GitHub token at once
```

---

### `lgraph init`

Performs a full project scan — collects the file tree, categorizes files (source, config, assets), gathers git info, and sends everything to the Latentgraph backend for indexing. Automatically starts the daemon if not running.

If the project is already indexed, you will be prompted to re-index. Use `--force` to skip the prompt.

| Flag | Short | Description |
|---|---|---|
| `--force` | `-f` | Force re-indexing even if already indexed |
| `--api-key <key>` | `-k` | Provide API key directly |
| `--project-name <name>` | `-n` | Create new project or match existing by name |
| `--project-id <id>` | | Use existing project UUID |
| `--gh-token <token>` | | GitHub token for PR insights (optional) |

```bash
lgraph init                                      # Interactive initialization
lgraph init -f                                   # Force re-index without prompt
lgraph init -k <key> -n "My App"                 # Non-interactive
lgraph init -k <key> --gh-token ghp_...          # Set API key and GitHub token at once
```

---

### `lgraph status`

Displays a comprehensive overview of the current Latentgraph setup — API key status, project details, backend indexing state, and daemon health.

```bash
lgraph status
```

---

### `lgraph update-drg`

Scans source files across all supported languages, detects git changes, and sends file contents to the backend for dependency analysis.

**Supported languages:**

| Language | Extensions |
|---|---|
| JavaScript / TypeScript | `.js` `.jsx` `.ts` `.tsx` `.mjs` `.cjs` |
| Python | `.py` |
| C# | `.cs` |
| C / C++ | `.cpp` `.cc` `.cxx` `.c` `.h` `.hpp` |

| Flag | Short | Description |
|---|---|---|
| `--baseline` | `-b` | Full re-analysis of all source files (slower) |
| `--mode <mode>` | `-m` | Explicit mode: `baseline` or `incremental` |

**Modes:**

- **incremental** (default) — sends only git-changed files for faster updates
- **baseline** — sends all source files for a full re-analysis

```bash
lgraph update-drg                      # Incremental update (default)
lgraph update-drg -b                   # Full re-analysis (short)
lgraph update-drg --baseline           # Full re-analysis (long)
```

---

### `lgraph update-wiki`

Refreshes Wiki module documentation using snapshot-based incremental delta detection. Sends all project source files to the backend; the server compares SHA-256 hashes against its saved snapshot and regenerates only what changed.

**Delta modes (resolved server-side):**

| Mode | Condition |
|---|---|
| `noop` | No source changes detected — returns immediately, zero LLM calls |
| `incremental` | Only changed modules regenerated (< 50% of files changed) |
| `full` | All modules regenerated (first run or ≥ 50% changed) |

```bash
lgraph update-wiki
```

---

### `lgraph update-implicit`

Triggers implicit dependency analysis for changed files only. The server auto-detects whether to run an incremental update based on git commit history, or a full scan if no prior run exists.

Does not re-run explicit dependency analysis (DRG), knowledge graph, or Wiki documentation. Use `lgraph init` for a full pipeline run.

```bash
lgraph update-implicit
```

---

### `lgraph update-file-index`

Refreshes per-file enrichment metadata with incremental delta detection. Sends all project source files to the backend; the server regenerates only what changed based on SHA-256 hash comparison.

```bash
lgraph update-file-index
```

---

### `lgraph update`

Runs the full incremental update pipeline in sequence: `update-drg` → `update-implicit` → `update-wiki` → `update-file-index`. Use this after making significant code changes to keep all indexes in sync.

| Flag | Short | Description |
|---|---|---|
| `--baseline-drg` | `-b` | Run `update-drg` in baseline (full re-analysis) mode |
| `--skip-drg` | | Skip the `update-drg` step |
| `--skip-implicit` | | Skip the `update-implicit` step |
| `--skip-wiki` | | Skip the `update-wiki` step |
| `--skip-file-index` | | Skip the `update-file-index` step |

```bash
lgraph update                      # Full incremental update (all steps)
lgraph update --baseline-drg       # Full DRG re-analysis + remaining steps
lgraph update --skip-wiki          # Skip Wiki regeneration
```

---

### `lgraph analyze`

Scans the project to collect code metrics — lines of code, token counts, comment counts by language, and git commit activity. Results are sent to the backend and viewable in the web dashboard.

Requires `lgraph start` to have been run first (API key + project config). Does not require `lgraph init`.

```bash
lgraph analyze
```

---

### `lgraph stop`

Stops the background daemon process. The daemon can be restarted with `lgraph start`.

```bash
lgraph stop
```

---

### `lgraph add`

Configures the Latentgraph MCP server in your AI coding tool. Run `lgraph add` without arguments to see the list of supported tools. [See MCP Integration](#mcp-integration)

| Flag | Short | Description |
|---|---|---|
| `--yes` | `-y` | Skip the consent prompt and apply Claude/Kiro integration changes automatically |

```bash
lgraph add [tool]
```

---

### `lgraph join`

Joins a shared project that you have been added to as a contributor, or a publicly shared project via share ID. Writes `.lgraph/config.json` so MCP tools can access it immediately. No scanning or indexing is performed — the project is already indexed by its owner.

| Flag | Short | Description |
|---|---|---|
| `--public-id <id>` | `-p` | Join a publicly shared project by its share ID (from a public share URL) |

```bash
lgraph join                          # Interactive project selection
lgraph join "My Team's App"          # Join by exact project name
lgraph join -p <share-id>            # Join a public project by share ID
```

Run `lgraph start` afterwards to connect the daemon.

---

### `lgraph config`

Manages Latentgraph configuration. Running `lgraph config` with no subcommand displays the current configuration.

#### Subcommands

| Subcommand | Description |
|---|---|
| `lgraph config show` | Display current configuration (default) |
| `lgraph config set <key> [value]` | Set a configuration value |
| `lgraph config clear [key]` | Clear a specific key or all configuration |

#### Configurable keys

| Key | Description |
|---|---|
| `api-key` | Your Latentgraph API key |
| `gh-token` | GitHub token for PR insights (enables PR-based code knowledge extraction) |
| `api-url` | Backend API URL |
| `orch-url` | Orchestrator URL |
| `ws-url` | WebSocket URL |

URLs can also be set via environment variables: `LGRAPH_API_URL`, `LGRAPH_ORCH_URL`, `LGRAPH_WS_URL`.

```bash
lgraph config                                      # Show current config
lgraph config set api-key sk-abc123                # Set API key
lgraph config set gh-token ghp_...                 # Set GitHub token for PR insights
lgraph config set api-url http://localhost:9000    # Set API URL
lgraph config clear gh-token                       # Remove GitHub token
lgraph config clear api-key                        # Clear API key
lgraph config clear urls                           # Clear all custom URLs
lgraph config clear                                # Clear all config
```

---

## MCP Integration

After initializing your project, use `lgraph add` to configure the Latentgraph MCP server in your AI coding tool.

### Supported Tools

| Tool | Command | Config method |
|---|---|---|
| Claude Code | `lgraph add claude-code` | Runs `claude mcp add-json` |
| LatentCode | `lgraph add latent-code` | Writes `latent-code.json` |
| Opencode | `lgraph add opencode` | Writes `opencode.json` |
| Codex | `lgraph add codex` | Runs `codex mcp add` |
| GitHub Copilot | `lgraph add copilot` | Writes `.vscode/mcp.json` |
| Cursor | `lgraph add cursor` | Writes `.cursor/mcp.json` |
| Factory Droid | `lgraph add droid` | Runs `droid mcp add` |
| Kiro | `lgraph add kiro` | Writes `.kiro/settings/mcp.json` |

For CLI-based tools, if the tool's CLI is not found on `PATH`, the command will print manual setup instructions instead.

### Claude Desktop (manual)

Add to your Claude Desktop config file:

- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "lgraph": {
      "command": "lgraph",
      "args": ["mcp"],
      "env": {
        "LGRAPH_PROJECT_ID": "YOUR_PROJECT_ID",
        "LGRAPH_API_URL": "https://latentgraph.latentforce.ai",
        "LGRAPH_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

`LGRAPH_API_KEY` is optional if the key is already saved in `~/.lgraph/config.json` via `lgraph config set api-key`. `LGRAPH_API_URL` is optional if you are using the default backend.

---

## Scan Targets

Latentgraph uses `.lgraph/scan_target.json` to control which parts of your codebase are scanned and in which language. This is especially useful for monorepos or multi-language projects.

A default template is **automatically created** the first time you run `lgraph init` or `lgraph start`. When left as the default (single entry with `language: null`), the server auto-detects scan targets.

### Format

The file is a JSON array. Each entry has:

| Field | Type | Description |
|---|---|---|
| `language` | `string \| null` | Language to use, or `null` for auto-detect |
| `path` | `string` | Relative path from project root (`""` for root) |

**Valid language values:** `javascript`, `typescript`, `python`, `cpp`, `csharp`

### Default (auto-detect)

```json
[
  {
    "language": null,
    "path": ""
  }
]
```

### Examples

**Single-language TypeScript project:**

```json
[
  {
    "language": "typescript",
    "path": ""
  }
]
```

**Monorepo with multiple languages:**

```json
[
  {
    "language": "typescript",
    "path": "frontend"
  },
  {
    "language": "python",
    "path": "backend"
  },
  {
    "language": "csharp",
    "path": "services/auth"
  }
]
```

**C++ engine in a subdirectory:**

```json
[
  {
    "language": "cpp",
    "path": "engine/src"
  }
]
```

---

## MCP Tools

The MCP server exposes **9 tools** over the indexed graph — 8 read tools and one write tool (`update_graph`). Each read tool returns curated metadata (summaries, symbols, edges, recorded knowledge) drawn from the index rather than raw source.

| Tool | Description |
|---|---|
| `get_project_overview` | Returns the project's architecture summary, a design/conventions overview document, and the list of top-level modules with each module's path, summary, and file count. Takes no arguments. |
| `get_module_info` | Returns one module's summary, full narrative text, the file paths it contains, its nested child-module ids, and any curated notes recorded for it. |
| `get_file` | Returns one source file's metadata: summary, owning module, category and modification-impact tags, defined symbols (each with its `fqn`), exports, internal imports, declared constants, served API endpoints, and storage backends touched. |
| `get_dependencies` | Returns file-level dependency edges for one file — `outgoing` (files it depends on) and `incoming` (files that depend on it) — each with an explicit/implicit flag, imported names, an edge summary, and a data-flow note. |
| `get_call_chain` | Returns the call graph around a fully-qualified symbol — its callers and callees — with confidence scores, resolution kind, depth level, and warnings for uncertain or polymorphic resolution. |
| `get_symbol` | Locates symbol definitions by name and/or file-path prefix, optionally filtered by kind. Returns each match's kind, file path, signature, and `fqn`. |
| `get_pr_insights` | Returns recorded design knowledge for a file or module: invariants (rules with severity and PR grounding) and decisions (choices with tradeoffs and PR grounding). |
| `ask_codebase` | Answers a natural-language question about the codebase using retrieval over indexed summaries. Returns prose with file-path citations, a confidence level, and fallback targets. |
| `update_graph` | The single write tool. Records a proposed graph edit — a file, dependency, or module annotation, or adding/removing an explicit or implicit dependency edge. Edits are queued for owner approval; returns a `pending_edit_id`. |

Every tool accepts an optional `project_id` (falls back to `LGRAPH_PROJECT_ID`) and an optional `branch` (falls back to `LGRAPH_BRANCH`, then the project's configured `default_branch`). Read tools return their payload as a fenced ` ```toon ` block ([TOON](https://github.com/toon-format/toon) — a compact, tab-delimited JSON encoding); `update_graph` returns a plain-text receipt.

---

## Configuration Files

| File | Location | Description |
|---|---|---|
| Global config | `~/.lgraph/config.json` | API key and server URLs |
| Project config | `.lgraph/config.json` | Project ID, name, and agent info |
| Scan targets | `.lgraph/scan_target.json` | Language and path targets for scanning (auto-created) |

---

## Requirements

- **Node.js:** 18 or newer
- **npm:** 8 or newer (bundled with Node.js)
- A free API key from [latentgraph.latentforce.ai](https://latentgraph.latentforce.ai/auth)

---

## Links

- **Web dashboard:** https://latentgraph.latentforce.ai
- **Sign up / API keys:** https://latentgraph.latentforce.ai/auth

---

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) to get started.

- **Bug reports & feature requests:** [GitHub Issues](https://github.com/LatentForce-ai/latentgraph-mcp-server/issues)
- **Discussions:** [GitHub Discussions](https://github.com/LatentForce-ai/latentgraph-mcp-server/discussions)

---

## License

MIT — see [LICENSE](LICENSE).
