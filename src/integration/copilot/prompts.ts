/**
 * Copilot prompt file generation for Latentgraph integration.
 *
 * Generates .github/prompts/lgraph-*.prompt.md files — Copilot's
 * equivalent of Claude Code skill files. Each prompt targets a specific
 * workflow (exploring, editing, impact analysis, debugging, CLI).
 */

import * as fs from 'fs';
import * as path from 'path';

const PROMPT_EXPLORING = `---
mode: agent
description: "Use when the user asks how code works, wants to understand architecture, trace execution flows, or explore unfamiliar parts of the codebase. Examples: \"How does X work?\", \"What calls this?\", \"Explain this codebase\", \"What module owns this file?\""
---

# Exploring Codebases with Latentgraph

This project has **Latentgraph** configured — a DRG plus module documentation for the codebase. Use the lgraph MCP tools before manually reading or searching indexed source files.

## When to Use

- "Explain this codebase"
- "How does authentication work?"
- "What module owns this file?"
- "Show me the main subsystems"
- "Where is the database logic?"
- Understanding unfamiliar code before making changes

## Workflow

\`\`\`
1. mcp__lgraph__get_project_overview()                          → Architecture summary and top-level modules
2. mcp__lgraph__get_module_info(module_path="...")              → Module docs, files, child modules
3. mcp__lgraph__get_file(file_path="...")                       → File summary, symbols, endpoints, dependents
4. mcp__lgraph__get_symbol(name="...")                          → Locate a function/class/method by name
5. mcp__lgraph__get_call_chain(symbol="<fqn>")                  → Callers and callees for a specific symbol
6. mcp__lgraph__get_dependencies(file_path="...")               → Bidirectional file-level dependencies (incoming = blast radius, outgoing = what it relies on)
\`\`\`

If you need broader context from \`get_file\`, use \`level=1\` or \`level=2\` for module ancestry and surrounding architecture.

## Checklist

- [ ] Call \`get_project_overview()\` first for the big picture
- [ ] Call \`get_module_info(module_path="...")\` to drill into the right subsystem
- [ ] Call \`get_file\` on key entry or integration files
- [ ] Call \`get_dependencies\` on central files; read \`incoming\` for dependents and \`outgoing\` for what they rely on
- [ ] Call \`get_call_chain\` when the question is about a specific function or method
- [ ] Only read raw files if the implementation details matter beyond the summaries

## Critical Rules

- **NEVER** answer a repo-wide architecture question from a single \`get_file\`.
- **NEVER** use search or glob as the first step for indexed source-file exploration.
- Use \`get_module_info\` when the question is really about a subsystem, not a single file.
- Use \`get_dependencies\` for both "what calls this?" (read \`incoming\`) and "what does this rely on?" (read \`outgoing\`).
`;

const PROMPT_EDITING = `---
mode: agent
description: "Use when the user wants to fix a bug, add a feature, update a component, refactor code, or make source changes. Examples: \"Fix bug in X\", \"Add feature to Y\", \"Refactor this module\", \"Update this handler\""
---

# Editing Code with Latentgraph

This project has **Latentgraph** configured — a DRG plus module documentation for the codebase. Use the lgraph MCP tools to understand context and impact BEFORE making edits.

## When to Use

- "Fix bug in X"
- "Add feature to Y"
- "Refactor this module"
- "Update this handler"
- Any task that modifies indexed source code

## Workflow

\`\`\`
1. mcp__lgraph__get_file(file_path="target")              → File summary, symbols, endpoints, dependents
2. mcp__lgraph__get_dependencies(file_path="target")      → Bidirectional dependencies (incoming = blast radius, outgoing = what it relies on)
3. mcp__lgraph__get_pr_insights(target="target")          → PR-mined invariants and decisions you must not break
4. mcp__lgraph__get_call_chain(symbol="target::<symbol>") → Function-scope: callers/callees for the symbol you're touching
5. Read the exact code sections you need
6. Make the edit
7. Re-check the \`incoming\` list from get_dependencies — those files depend on what you just changed
\`\`\`

## Checklist

- [ ] Call \`get_file\` before reading the file
- [ ] Review the summary and module assignment
- [ ] Call \`get_dependencies\` before changing imports, contracts, or shared helpers — \`incoming\` is your blast radius
- [ ] Call \`get_pr_insights\` before every non-trivial edit
- [ ] Call \`get_call_chain\` when you're changing a single function's contract
- [ ] Read only the implementation you need
- [ ] Re-check the \`incoming\` list after the edit

## Critical Rules

- **ALWAYS** call \`get_dependencies\` (read \`incoming\`) before editing indexed source files.
- **ALWAYS** call \`get_file\` before reading the raw file.
- **NEVER** use search to find importers or dependents as your first step.
- Use \`get_module_info\` for module-wide refactors, not just \`get_file\`.

## Reading the Signals

- \`get_file\` gives you file summary, symbols, endpoints, dependents.
- \`get_dependencies\` returns the bidirectional graph: \`incoming\` (dependents — your blast radius), \`outgoing\` (what this file imports/uses), implicit coupling flagged via \`implicit: true\`.
- \`get_pr_insights\` surfaces decisions and invariants already written down — the cheapest safety check before a refactor.
`;

const PROMPT_DEBUGGING = `---
mode: agent
description: "Use when the user is debugging a bug, tracing an error, or asking why something fails. Examples: \"Why is X failing?\", \"Where does this error come from?\", \"Trace this bug\", \"Why did this change break Y?\""
---

# Debugging with Latentgraph

This project has **Latentgraph** configured — a DRG plus module documentation for the codebase. Use lgraph MCP tools to trace bugs through dependencies and coupling instead of starting with raw search.

## When to Use

- "Why is this failing?"
- "Trace where this error comes from"
- "Why did this change break Y?"
- "Who uses this code path?"
- Investigating bugs, regressions, and unexpected behavior

## Workflow

\`\`\`
1. mcp__lgraph__get_file(file_path="suspect")                      → File summary, symbols, endpoints, dependents
2. mcp__lgraph__get_dependencies(file_path="suspect")              → Bidirectional relationships, imports, implicit coupling
3. mcp__lgraph__get_call_chain(symbol="suspect::<fqn>")            → Trace callers/callees for the failing symbol
4. mcp__lgraph__get_file(...) on upstream/downstream files as needed
5. mcp__lgraph__get_pr_insights(target="suspect")                  → Recorded invariants and decisions for the file or module
6. Read the raw source only to confirm the exact root cause
\`\`\`

## Checklist

- [ ] Start with the file where the symptom appears
- [ ] Use \`get_dependencies\` before manual import chasing — read \`incoming\` to see who triggers this code
- [ ] Inspect edges with \`implicit: true\` if the failure crosses config/runtime boundaries
- [ ] Use \`get_call_chain\` when narrowing in on a specific failing function
- [ ] Use \`get_pr_insights\` to surface invariants the bug may be violating

## Critical Rules

- **NEVER** start by searching the whole repo for function names or error strings when a suspect file is known.
- **ALWAYS** use \`get_dependencies\` to follow relationships before reading multiple raw files.
- **ALWAYS** re-check the \`incoming\` list from \`get_dependencies\` before applying the fix.
`;

const PROMPT_CLI = `---
mode: agent
description: "Use when the user needs to run Latentgraph CLI commands like initialize a repo, trigger a full re-scan, check status, or configure the MCP server. Examples: \"Index this repo\", \"Refresh the DRG\", \"Check lgraph status\", \"Configure Copilot\""
---

# Latentgraph CLI Reference

## Commands

| Command | Purpose |
|---------|---------|
| \`lgraph init\` | Initialize and index the project |
| \`lgraph init --force\` | Full re-scan when the project is already indexed |
| \`lgraph status\` | Check indexing status, daemon status, and file counts |
| \`lgraph start\` | Start the background daemon |
| \`lgraph stop\` | Stop the background daemon |
| \`lgraph add copilot\` | Configure GitHub Copilot MCP plus project guidance files |
| \`lgraph add copilot --yes\` | Same as above, but skip the consent prompt |
| \`lgraph config\` | Show or change CLI configuration |

## When to Run What

| Situation | Command |
|-----------|---------|
| First-time setup | \`lgraph init\` |
| After significant code changes or branch switches | \`lgraph init --force\` |
| MCP results look stale | \`lgraph init --force\` |
| Check indexing progress | \`lgraph status\` |
| Daemon is not running | \`lgraph start\` |
| Configure Copilot in the current repo | \`lgraph add copilot\` |

## Important Notes

- Use a full re-scan with \`lgraph init --force\` when you need to refresh DRG + Wiki outputs.
- The MCP knowledge graph only indexes source files: .js .jsx .ts .tsx .py .java .cpp .cs .go .c .h .css .scss .html
- Non-source files (.json, .yaml, .md, .env, etc.) are not indexed; read them directly with normal tools.
`;

const PROMPTS: Record<string, string> = {
    'lgraph-exploring': PROMPT_EXPLORING,
    'lgraph-editing': PROMPT_EDITING,
    'lgraph-debugging': PROMPT_DEBUGGING,
    'lgraph-cli': PROMPT_CLI,
};

export interface GeneratePromptsResult {
    created: string[];
    updated: string[];
}

export function generatePromptFiles(projectRoot: string): GeneratePromptsResult {
    const result: GeneratePromptsResult = { created: [], updated: [] };
    const promptsDir = path.join(projectRoot, '.github', 'prompts');

    if (!fs.existsSync(promptsDir)) {
        fs.mkdirSync(promptsDir, { recursive: true });
    }

    for (const [name, content] of Object.entries(PROMPTS)) {
        const promptFile = path.join(promptsDir, `${name}.prompt.md`);
        const exists = fs.existsSync(promptFile);
        fs.writeFileSync(promptFile, content.trimStart());

        if (exists) {
            result.updated.push(name);
        } else {
            result.created.push(name);
        }
    }

    return result;
}
