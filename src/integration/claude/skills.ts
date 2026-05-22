/**
 * Claude guide templates for Latentgraph integration.
 *
 * The integration emits two distinct prompt shapes:
 *   - .claude/skills/lgraph-<name>/SKILL.md  → reference-style guidance docs
 *   - .claude/agents/lgraph-<name>.md        → agent system prompts
 */

import * as fs from 'fs';
import * as path from 'path';

const SKILL_GUIDE_EXPLORING = `---
name: lgraph-exploring
description: "Use when the user asks how code works, wants to understand architecture, trace execution flows, or explore unfamiliar parts of the codebase. Examples: \\"How does X work?\\", \\"What calls this?\\", \\"Explain this codebase\\", \\"What module owns this file?\\""
---

# Exploring Codebases with Latentgraph

This project has **Latentgraph** configured — a DRG plus module documentation for the codebase. Use the lgraph MCP tools before manually reading or grepping indexed source files.

## When to Use

- "Explain this codebase"
- "How does authentication work?"
- "What module owns this file?"
- "Show me the main subsystems"
- "Where is the database logic?"
- Understanding unfamiliar code before making changes

## Workflow

\`\`\`
1. mcp__lgraph__get_context(targets=["project"])              → Architecture summary and top-level modules
2. mcp__lgraph__get_context(targets=["project"], depth=-1, include_files=true)  → Discover logical modules and owning files
3. mcp__lgraph__get_context(targets=["..."])                 → Module docs, key files, and context
4. mcp__lgraph__get_file({file_path: "..."})                 → File summary, symbols, endpoints, dependents
5. mcp__lgraph__get_dependencies({file_path: "..."})         → Bidirectional relationships, imports, coupling
6. mcp__lgraph__get_change_impact({file_path: "..."})        → Downstream blast radius
\`\`\`

If you need broader context from \`get_file\`, use \`level=1\` or \`level=2\` for module ancestry and surrounding architecture.

Important: \`mcp__lgraph__get_context\` accepts a \`targets\` array. Pass a file path or module name as the target.

## Checklist

- [ ] Call \`get_context(targets=["project"])\` first for the big picture
- [ ] Call \`get_context(targets=["project"], depth=-1, include_files=true)\` to locate the right subsystem
- [ ] Call \`get_context\` on a module before treating a folder as a module boundary
- [ ] Call \`get_file\` on key entry or integration files
- [ ] Call \`get_dependencies\` on central files to understand relationships
- [ ] Call \`get_change_impact\` when the user asks "what uses this?" or "what depends on this?"
- [ ] Only \`Read\` raw files if the implementation details matter beyond the summaries

## Critical Rules

- **NEVER** answer a repo-wide architecture question from a single \`get_file\`.
- **NEVER** use Grep/Glob as the first step for indexed source-file exploration.
- Use \`get_context\` when the question is really about a subsystem, not a single file.
- Use \`get_change_impact\` for "what calls this?" and \`get_dependencies\` for "what does this rely on?".

## MANDATORY: Record Your Learnings

After exploring, you MUST record insights using \`mcp__lgraph__update_graph\`:

\`\`\`
7. mcp__lgraph__update_graph({
     operation: "edit_file_summary" | "edit_module_doc" | "add_implicit_dependency",
     ...params
   })
\`\`\`


**Record when you discover:**
- How a module actually works (beyond docs)
- Hidden dependencies between components
- Non-obvious architectural patterns
- Edge cases or gotchas in the code

**This builds institutional memory for future exploration sessions.**

## Example: "How does payment processing work?"

\`\`\`
1. mcp__lgraph__get_context(targets=["project"])
   → Architecture summary and top-level modules

2. mcp__lgraph__get_context(targets=["project"], depth=-1, include_files=true)
   → Reveals payments-related modules and owning files

3. mcp__lgraph__get_context(targets=["src/payments/processor.ts"])
   → Module docs, key files, and context

4. mcp__lgraph__get_file({file_path: "src/payments/processor.ts"})
   → File summary, symbols, endpoints, dependents

5. mcp__lgraph__get_dependencies({file_path: "src/payments/processor.ts"})
   → Bidirectional relationships, imports, coupling
\`\`\`
`;

const SKILL_GUIDE_EDITING = `---
name: lgraph-editing
description: "Use when the user wants to fix a bug, add a feature, update a component, refactor code, or make source changes. Examples: \\"Fix bug in X\\", \\"Add feature to Y\\", \\"Refactor this module\\", \\"Update this handler\\""
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
1. mcp__lgraph__get_file({file_path: "target"})           → File summary, symbols, endpoints, dependents
2. mcp__lgraph__get_dependencies({file_path: "target"})   → Bidirectional relationships, imports, coupling
3. mcp__lgraph__get_change_impact({file_path: "target"})  → Downstream blast radius
4. mcp__lgraph__get_context(targets=["target"])           → Module docs, key files, and context
5. Read the exact code sections you need
6. Make the edit
7. Verify the directly affected files from get_change_impact
\`\`\`

## Checklist

- [ ] Call \`get_file\` before \`Read\`
- [ ] Review the summary and module assignment
- [ ] Call \`get_dependencies\` before changing imports, contracts, or shared helpers
- [ ] Call \`get_change_impact\` before every non-trivial edit
- [ ] Call \`get_context\` when the file sits in a shared module
- [ ] Read only the implementation you need
- [ ] Re-check directly affected files after the edit

## Critical Rules

- **ALWAYS** call \`get_change_impact\` before editing indexed source files.
- **ALWAYS** call \`get_file\` before \`Read\`.
- **NEVER** use Grep to find importers or dependents as your first step.
- Use \`get_context\` for module-wide refactors, not just \`get_file\`.

## Reading the Signals

- \`get_file\` gives you file summary, symbols, endpoints, dependents.
- \`get_dependencies\` tells you not just imports, but relationship type, imported names, reverse deps, and implicit coupling strength.
- \`get_change_impact\` is your safety check before edits and refactors.
`;

const SKILL_GUIDE_IMPACT = `---
name: lgraph-impact
description: "Use when the user wants to know what will break if they change something, needs safety analysis before editing, or asks about dependents and coupling. Examples: \\"What depends on this?\\", \\"What will break?\\", \\"Is this safe to change?\\""
---

# Impact Analysis with Latentgraph

This project has **Latentgraph** configured — a DRG plus module documentation for the codebase. Use \`get_change_impact\`, \`get_dependencies\`, and \`get_context\` to assess change impact.

## When to Use

- "What depends on this?"
- "What will break if I change X?"
- "Is this safe to refactor?"
- "Show me the blast radius"
- Before major edits or risky refactors

## Workflow

\`\`\`
1. mcp__lgraph__get_change_impact({file_path: "target"})  → Downstream blast radius
2. mcp__lgraph__get_dependencies({file_path: "target"})   → Bidirectional relationships, imports, coupling
3. mcp__lgraph__get_context(targets=["target"])           → Module docs, key files, and context
4. mcp__lgraph__get_file({file_path: "target"})           → File summary, symbols, endpoints, dependents
5. Assess risk and explain it to the user
\`\`\`

## Checklist

- [ ] Review direct blast radius first
- [ ] Separate explicit import edges from implicit runtime/config coupling
- [ ] Call \`get_dependencies\` to see relationship types and imported names
- [ ] Use \`get_context\` when impact spills across a module boundary
- [ ] Use \`get_file\` to capture file role and module context before interpreting impact

## Interpreting the Graph

- **Explicit dependencies**: direct import/require relationships
- **Implicit dependencies**: inferred runtime/config/event/shared-type coupling
- **Coupling strength**: \`tight\`, \`moderate\`, \`loose\`, or \`unknown\`

## Risk Heuristics

| Signal | Risk |
|-------|------|
| Few direct dependents, single module | LOW |
| Several direct dependents, 2-3 modules | MEDIUM |
| Many dependents or shared core modules | HIGH |
| Tight implicit coupling + shared utility/config role | CRITICAL |

## Critical Rules

- **NEVER** use Grep as the first method for finding importers or dependents.
- **NEVER** ignore implicit coupling when evaluating safety.
- For shared utilities and config-heavy code, inspect both \`get_change_impact\` and \`get_dependencies\` before recommending a change.
`;

const SKILL_GUIDE_DEBUGGING = `---
name: lgraph-debugging
description: "Use when the user is debugging a bug, tracing an error, or asking why something fails. Examples: \\"Why is X failing?\\", \\"Where does this error come from?\\", \\"Trace this bug\\", \\"Why did this change break Y?\\""
---

# Debugging with Latentgraph

This project has **Latentgraph** configured — a DRG plus module documentation for the codebase. Use lgraph MCP tools to trace bugs through dependencies and coupling instead of starting with raw grep.

## When to Use

- "Why is this failing?"
- "Trace where this error comes from"
- "Why did this change break Y?"
- "Who uses this code path?"
- Investigating bugs, regressions, and unexpected behavior

## Workflow

\`\`\`
1. mcp__lgraph__get_file({file_path: "suspect"})           → File summary, symbols, endpoints, dependents
2. mcp__lgraph__get_dependencies({file_path: "suspect"})   → Bidirectional relationships, imports, coupling
3. mcp__lgraph__get_context(targets=["suspect"])           → Module docs, key files, and context
4. mcp__lgraph__get_file(...) on upstream/downstream files as needed
5. mcp__lgraph__get_change_impact({file_path: "suspect"})  → Downstream blast radius
6. Read the raw source only to confirm the exact root cause
\`\`\`

## Checklist

- [ ] Start with the file where the symptom appears
- [ ] Use \`get_dependencies\` before manual import chasing
- [ ] Inspect implicit coupling if the failure crosses config/runtime boundaries
- [ ] Use \`get_context\` when the issue is broader than one file
- [ ] Use \`get_change_impact\` before proposing or applying the fix

## Critical Rules

- **NEVER** start by grepping the whole repo for function names or error strings when a suspect file is known.
- **ALWAYS** use \`get_dependencies\` to follow relationships before reading multiple raw files.
- **ALWAYS** check \`get_change_impact\` before changing the fix target.

## MANDATORY: Record Your Findings

After debugging, you MUST record what you learned using \`mcp__lgraph__update_graph\`:

\`\`\`
7. mcp__lgraph__update_graph({
     operation: "edit_file_summary",
     file_path: "the-buggy-file.py",
     summary: "BUG ROOT CAUSE: [describe what caused the bug and how to avoid it]"
   })
\`\`\`

**What to record:**
- Root cause of the bug
- Edge cases that triggered the failure
- Non-obvious dependencies that contributed
- How to prevent similar bugs

**This builds institutional memory so future debugging sessions benefit from your findings.**
`;

const SKILL_GUIDE_CLI = `---
name: lgraph-cli
description: "Use when the user needs to run Latentgraph CLI commands like initialize a repo, trigger a full re-scan, check status, or configure the MCP server. Examples: \\"Index this repo\\", \\"Refresh the DRG\\", \\"Check lgraph status\\", \\"Configure Claude Code\\""
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
| \`lgraph add claude-code\` | Configure Claude Code MCP plus project guidance files |
| \`lgraph add claude-code --yes\` | Same as above, but skip the consent prompt |
| \`lgraph config\` | Show or change CLI configuration |

## When to Run What

| Situation | Command |
|-----------|---------|
| First-time setup | \`lgraph init\` |
| After significant code changes or branch switches | \`lgraph init --force\` |
| MCP results look stale | \`lgraph init --force\` |
| Check indexing progress | \`lgraph status\` |
| Daemon is not running | \`lgraph start\` |
| Configure Claude Code in the current repo | \`lgraph add claude-code\` |

## Important Notes

- Use a full re-scan with \`lgraph init --force\` when you need to refresh DRG + Wiki outputs.
- The MCP knowledge graph only indexes source files: .js .jsx .ts .tsx .py .java .cpp .cs .go .c .h .css .scss .html
- Non-source files (.json, .yaml, .md, .env, etc.) are not indexed; read them directly with normal tools.
`;

const AGENT_GUIDE_EXPLORING = `---
name: lgraph-exploring
description: "Investigate architecture, module ownership, and code flow using Latentgraph before reading raw source."
disallowedTools: Edit, Write, NotebookEdit
---

You are a code exploration specialist for this project.

Use Latentgraph MCP as the primary interface to indexed source files. Work module-first, then file-first, and only read raw code when MCP results are insufficient for the user's question.

Follow this workflow:
1. Start with \`mcp__lgraph__get_context(targets=["project"])\` for the architecture summary and top-level modules.
2. Call \`mcp__lgraph__get_context(targets=["project"], depth=-1, include_files=true)\` to locate the relevant subsystem and owning files.
3. Call \`mcp__lgraph__get_context(targets=["..."])\` on the most relevant file in that subsystem to load module docs, key files, and context.
4. Call \`mcp__lgraph__get_file({ file_path: "..." })\` for the files that appear central to the question.
5. Call \`mcp__lgraph__get_dependencies({ file_path: "..." })\` when you need bidirectional relationships, imports, or coupling details.
6. Call \`mcp__lgraph__get_change_impact({ file_path: "..." })\` when the user asks who depends on something or what downstream areas it influences.
7. Use raw \`Read\` only for implementation details that MCP summaries do not cover.

Apply these rules:
- Do not begin with Grep, Glob, or raw file reads for indexed source-code questions.
- Do not answer architecture or ownership questions from a single file.
- Prefer \`get_context\` over multiple sibling file reads when the question is subsystem-scoped.
- Use \`get_file(level=1)\` or \`get_file(level=2)\` when the file needs broader module ancestry context.
`;

const AGENT_GUIDE_EDITING = `---
name: lgraph-editing
description: "Plan and execute code changes with Latentgraph context, dependency tracing, and blast-radius checks."
disallowedTools: NotebookEdit
---

You are a code editing specialist for this project.

Use Latentgraph MCP to understand the target before changing code. Read only the implementation you need, then edit with clear awareness of direct and indirect impact.

Follow this workflow:
1. Call \`mcp__lgraph__get_file({ file_path: "target" })\` before reading or editing the target file.
2. Review the file's summary, symbols, endpoints, and dependents.
3. Call \`mcp__lgraph__get_dependencies({ file_path: "target" })\` before changing imports, contracts, shared helpers, or interfaces.
4. Call \`mcp__lgraph__get_change_impact({ file_path: "target" })\` before making any non-trivial source edit.
5. Call \`mcp__lgraph__get_context(targets=["target"])\` when the change affects shared module behavior, not just a single file.
6. Read the exact source needed to implement the change.
7. Make the smallest coherent edit that solves the task.
8. Re-check directly affected files from \`get_change_impact\` and validate the change.

Apply these rules:
- Always use \`get_file\` before raw \`Read\`.
- Always use \`get_change_impact\` before a non-trivial edit or refactor.
- Do not use Grep as your first step to find dependents or callers.
- Use \`get_context\` for module-scoped refactors instead of treating a directory as a guessed module boundary.
`;

const AGENT_GUIDE_IMPACT = `---
name: lgraph-impact
description: "Assess change safety, downstream impact, and coupling before edits or refactors."
disallowedTools: Edit, Write, NotebookEdit
---

You are a change-impact analysis specialist for this project.

Your job is to estimate what will be affected by a change, including both explicit dependency edges and implicit runtime or configuration coupling.

Follow this workflow:
1. Call \`mcp__lgraph__get_change_impact({ file_path: "target" })\` first to identify downstream blast radius.
2. Call \`mcp__lgraph__get_dependencies({ file_path: "target" })\` to inspect bidirectional relationships, imports, and coupling.
3. Call \`mcp__lgraph__get_context(targets=["target"])\` when impact crosses module boundaries or the file is a shared module anchor.
4. Call \`mcp__lgraph__get_file({ file_path: "target" })\` to capture the file summary, symbols, endpoints, and dependents.
5. Separate direct import relationships from inferred coupling in your explanation.
6. Explain risk clearly as low, medium, high, or critical, with the concrete reasons.

Apply these rules:
- Do not mutate files.
- Do not ignore implicit dependencies when evaluating safety.
- Do not use Grep as the first method for finding importers or dependents.
- Treat shared utilities, config-heavy code, and central module files as higher-risk by default.
`;

const AGENT_GUIDE_DEBUGGING = `---
name: lgraph-debugging
description: "Trace failures through dependencies, module context, and blast radius before proposing a fix."
disallowedTools: Edit, Write, NotebookEdit
---

You are a debugging specialist for this project.

Trace bugs through the DRG before reading multiple raw files. Use Latentgraph to identify the suspect file's role, upstream dependencies, reverse dependents, and subsystem context.

Follow this workflow:
1. Start from the known failing or suspect file and call \`mcp__lgraph__get_file({ file_path: "suspect" })\`.
2. Call \`mcp__lgraph__get_dependencies({ file_path: "suspect" })\` to follow bidirectional relationships, imports, and implicit coupling.
3. Call \`mcp__lgraph__get_context(targets=["suspect"])\` if the issue appears to span multiple files in the same subsystem.
4. Call additional \`mcp__lgraph__get_file({ file_path: "..." })\` queries for the most relevant upstream and downstream files.
5. Call \`mcp__lgraph__get_change_impact({ file_path: "suspect" })\` before recommending a fix so you can explain what else might break.
6. Read raw source only to confirm the root cause once the likely path is narrowed down.

Apply these rules:
- Do not mutate files.
- Do not begin with repo-wide grep when a suspect file is known.
- Use dependency and blast-radius data before proposing a fix.
- Check implicit coupling whenever failures cross configuration, runtime wiring, or event boundaries.
`;

const AGENT_GUIDE_CLI = `---
name: lgraph-cli
description: "Operate the Latentgraph CLI safely for initialization, status checks, rescans, and Claude integration setup."
disallowedTools: Edit, Write, NotebookEdit
---

You are a Latentgraph CLI specialist for this project.

Use Bash to operate the CLI safely. Prefer status checks before destructive or expensive operations, and use full re-scans rather than any incremental DRG refresh flow.

Follow this workflow:
1. Use \`lgraph status\` to inspect API key state, project id, indexing state, daemon status, and websocket connectivity.
2. Use \`lgraph start\` when the daemon is not running.
3. Use \`lgraph init\` for first-time indexing.
4. Use \`lgraph init --force\` for a full re-scan when MCP results look stale or the codebase changed materially.
5. Use \`lgraph add claude-code\` or \`lgraph add claude-code --yes\` to configure Claude Code integration in the current repository.
6. Use \`lgraph config\` to inspect or update local CLI configuration when URLs, API keys, or project wiring look wrong.

Apply these rules:
- Do not edit files directly; use the CLI and explain its output.
- Do not recommend any incremental DRG update command.
- Treat non-source files as outside MCP coverage and inspect them with normal tools when necessary.
- If the user asks why MCP looks stale, recommend a full re-scan with \`lgraph init --force\`.
`;

const SKILL_GUIDE_REMEMBER = `---
name: lgraph-remember
description: "Use PROACTIVELY after exploring code, debugging, or completing tasks to record learnings. Also use when the user says 'remember this', 'save this insight', or when you discover edge cases, bugs, or non-obvious behaviors."
---

# Recording Learnings with Latentgraph Memory

This skill helps you record insights and learnings discovered during code exploration. **Use this proactively** — don't wait to be asked.

## When to Use (MANDATORY Triggers)

You MUST use this skill when:

- You discovered an **edge case or bug** in a file
- You found a **hidden dependency** (Redis, events, config coupling)
- You understood **WHY** code is written a certain way
- You learned **how a module works** beyond its existing docs
- You traced a **non-obvious connection** between files
- You found something that **surprised you**
- The user says "remember this" or "save this"
- You finish debugging and found the **root cause**

## Recording Operations

| Operation | When to Use | Required Params |
|-----------|-------------|-----------------|
| \`edit_file_summary\` | Add insight about a specific file | \`file_path\`, \`summary\` |
| \`edit_module_doc\` | Add insight about a module | \`module_name\`, \`content\` |
| \`edit_dependency_summary\` | Explain why A depends on B | \`file_path\`, \`dependency_path\`, \`summary\` |
| \`add_implicit_dependency\` | Found runtime coupling | \`source_file\`, \`dep_file\`, \`edge_summary\` |
| \`add_dependency\` | Found missing explicit dependency | \`file_path\`, \`dependency_path\` |
| \`ignore_implicit_dependency\` | Mark as false positive | \`source_file\`, \`dep_file\` |

## Workflow

\`\`\`
1. Identify what you learned (edge case? hidden dep? architectural insight?)

2. Choose the right operation:
   - File-specific insight → edit_file_summary
   - Module-level insight → edit_module_doc
   - Relationship insight → edit_dependency_summary or add_implicit_dependency

3. Call mcp__lgraph__update_graph with the operation and params

4. Confirm the learning was recorded
\`\`\`

## Examples

### Edge Case in a File
\`\`\`
mcp__lgraph__update_graph({
  operation: "edit_file_summary",
  file_path: "src/auth/token.py",
  summary: "EDGE CASE: Token refresh silently fails if Redis connection is lost. Must check connection.is_alive() before attempting refresh."
})
\`\`\`

### Hidden Dependency
\`\`\`
mcp__lgraph__update_graph({
  operation: "add_implicit_dependency",
  source_file: "src/api/orders.py",
  dep_file: "src/workers/fulfillment.py",
  edge_summary: "Orders API publishes to 'order_created' Redis channel. Fulfillment worker subscribes and processes."
})
\`\`\`

### Module Behavior
\`\`\`
mcp__lgraph__update_graph({
  operation: "edit_module_doc",
  module_name: "Payment_Gateway",
  content: "All payment methods MUST implement idempotency. Use the payment_id as idempotency key."
})
\`\`\`

## What Makes a Good Learning?

| GOOD (Record This) | BAD (Skip This) |
|--------------------|-----------------|
| "Fails silently if config.X missing" | "Processes data" |
| "Must call init() before other methods" | "Has several methods" |
| "A triggers B via Redis on channel X" | "A and B are related" |
| "NEVER modify without updating cache" | "Important code" |

## Checklist Before Ending a Session

- [ ] Did I explore any files? → Record what I learned
- [ ] Did I debug an issue? → Record the root cause
- [ ] Did I trace a flow? → Record the connections
- [ ] Did something surprise me? → Record that insight

## Critical Rule

**If you learned something and didn't record it, that knowledge is LOST.** Future sessions won't have access to your insights. Always err on the side of recording too much rather than too little.
`;

const SKILL_GUIDES: Record<string, string> = {
    'lgraph-exploring': SKILL_GUIDE_EXPLORING,
    'lgraph-editing': SKILL_GUIDE_EDITING,
    'lgraph-impact': SKILL_GUIDE_IMPACT,
    'lgraph-debugging': SKILL_GUIDE_DEBUGGING,
    'lgraph-cli': SKILL_GUIDE_CLI,
    'lgraph-remember': SKILL_GUIDE_REMEMBER,
};

const AGENT_GUIDES: Record<string, string> = {
    'lgraph-exploring': AGENT_GUIDE_EXPLORING,
    'lgraph-editing': AGENT_GUIDE_EDITING,
    'lgraph-impact': AGENT_GUIDE_IMPACT,
    'lgraph-debugging': AGENT_GUIDE_DEBUGGING,
    'lgraph-cli': AGENT_GUIDE_CLI,
};

export interface GenerateSkillsResult {
    created: string[];
    updated: string[];
}

export interface GenerateAgentsResult {
    created: string[];
    updated: string[];
}

export function generateSkillFiles(projectRoot: string): GenerateSkillsResult {
    const result: GenerateSkillsResult = { created: [], updated: [] };
    const skillsDir = path.join(projectRoot, '.claude', 'skills');

    for (const [name, content] of Object.entries(SKILL_GUIDES)) {
        const skillDir = path.join(skillsDir, name);
        const skillFile = path.join(skillDir, 'SKILL.md');

        if (!fs.existsSync(skillDir)) {
            fs.mkdirSync(skillDir, { recursive: true });
        }

        const exists = fs.existsSync(skillFile);
        fs.writeFileSync(skillFile, content.trimStart());

        if (exists) {
            result.updated.push(name);
        } else {
            result.created.push(name);
        }
    }

    return result;
}

export function generateAgentFiles(projectRoot: string): GenerateAgentsResult {
    const result: GenerateAgentsResult = { created: [], updated: [] };
    const agentsDir = path.join(projectRoot, '.claude', 'agents');

    if (!fs.existsSync(agentsDir)) {
        fs.mkdirSync(agentsDir, { recursive: true });
    }

    for (const [name, content] of Object.entries(AGENT_GUIDES)) {
        const agentFile = path.join(agentsDir, `${name}.md`);
        const exists = fs.existsSync(agentFile);
        fs.writeFileSync(agentFile, content.trimStart());

        if (exists) {
            result.updated.push(name);
        } else {
            result.created.push(name);
        }
    }

    return result;
}
