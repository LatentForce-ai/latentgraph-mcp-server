# Contributing to Latentgraph

Thank you for your interest in contributing! This document covers how to set up the project, the development workflow, and the guidelines we follow.

---

## Table of Contents

- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Making Changes](#making-changes)
- [Commit Messages](#commit-messages)
- [Submitting a Pull Request](#submitting-a-pull-request)
- [Reporting Bugs](#reporting-bugs)
- [Requesting Features](#requesting-features)

---

## Getting Started

1. **Fork** the repository on GitHub.
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/<your-username>/latentgraph-mcp-server.git
   cd latentgraph-mcp-server
   ```
3. **Install** dependencies:
   ```bash
   npm install
   ```

---

## Development Setup

**Requirements:**
- Node.js 18 or newer
- npm 8 or newer

**Build the project:**
```bash
npm run build
```

**Watch mode (rebuilds on file changes):**
```bash
npm run dev
```

**Link the CLI locally for manual testing:**
```bash
npm link
lgraph --version
```

---

## Project Structure

```
src/
├── index.ts              # CLI entry point (Commander.js)
├── mcp-server.ts         # MCP server and tool implementations
├── cli/commands/         # One file per CLI command
├── daemon/               # Background WebSocket daemon
├── integration/          # Per-tool AI integration (Claude, Copilot, Cursor, …)
└── utils/                # Shared utilities (config, API client, git, …)
```

---

## Making Changes

- Work on a feature branch: `git checkout -b feat/my-feature`
- Keep changes focused — one logical change per PR.
- TypeScript strict mode is enabled; all code must compile without errors (`npm run build`).
- Add or update tests when touching logic in `src/`.

---

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add support for Ruby language scanning
fix: handle missing .lgraph/config.json gracefully
docs: clarify scan_target.json format in README
chore: bump @modelcontextprotocol/sdk to 1.26
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`.

---

## Submitting a Pull Request

1. Push your branch and open a PR against `main`.
2. Fill in the pull request template.
4. A maintainer will review within a few business days.

---

## Reporting Bugs

Open an issue using the **Bug Report** template. Include:
- `lgraph --version` output
- Node.js version (`node --version`)
- Steps to reproduce
- Expected vs. actual behavior
- Relevant error output or logs

---

## Requesting Features

Open an issue using the **Feature Request** template. Describe the problem you are trying to solve and your proposed solution. We will discuss feasibility and prioritization there before implementation begins.
