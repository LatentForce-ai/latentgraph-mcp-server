/**
 * Skill file generation for Latentgraph Codex integration.
 *
 * Generates .agents/skills/lgraph-<name>/SKILL.md following the open agent
 * skills standard that Codex uses for both explicit ($lgraph-exploring) and
 * implicit (auto-matched) invocation.
 *
 * Each skill directory also gets agents/openai.yaml, which declares the lgraph
 * MCP server as a required tool dependency so Codex activates it automatically
 * when the skill is invoked.
 */

import * as fs from 'fs';
import * as path from 'path';

const SKILL_GUIDE_EXPLORING = `---
name: lgraph-exploring
description: "Use when the user asks how code works, wants to understand architecture, trace execution flows, or explore unfamiliar parts of the codebase. Examples: \\"How does X work?\\", \\"What calls this?\\", \\"Explain this codebase\\", \\"What module owns this file?\\""
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
- [ ] Only read raw files if the implementation details matter beyond the summaries

## Critical Rules

- **NEVER** answer a repo-wide architecture question from a single \`get_file\`.
- **NEVER** use grep or cat as the first step for indexed source-file exploration.
- Use \`get_context\` when the question is really about a subsystem, not a single file.
- Use \`get_change_impact\` for "what calls this?" and \`get_dependencies\` for "what does this rely on?".
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

- [ ] Call \`get_file\` before reading the file
- [ ] Review the summary and symbols
- [ ] Call \`get_dependencies\` before changing imports, contracts, or shared helpers
- [ ] Call \`get_change_impact\` before every non-trivial edit
- [ ] Call \`get_context\` when the file sits in a shared module
- [ ] Read only the implementation you need
- [ ] Re-check directly affected files after the edit

## Critical Rules

- **ALWAYS** call \`get_change_impact\` before editing indexed source files.
- **ALWAYS** call \`get_file\` before reading the raw file.
- **NEVER** use grep to find importers or dependents as your first step.
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
- [ ] Use \`get_file\` to capture file summary and dependents

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

- **NEVER** use grep as the first method for finding importers or dependents.
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
`;

const SKILL_GUIDE_CLI = `---
name: lgraph-cli
description: "Use when the user needs to run Latentgraph CLI commands like initialize a repo, trigger a full re-scan, check status, or configure the MCP server. Examples: \\"Index this repo\\", \\"Refresh the DRG\\", \\"Check lgraph status\\", \\"Configure Codex\\""
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
| \`lgraph add codex\` | Configure Codex MCP plus project guidance files |
| \`lgraph add codex --yes\` | Same as above, but skip the consent prompt |
| \`lgraph config\` | Show or change CLI configuration |

## When to Run What

| Situation | Command |
|-----------|---------|
| First-time setup | \`lgraph init\` |
| After significant code changes or branch switches | \`lgraph init --force\` |
| MCP results look stale | \`lgraph init --force\` |
| Check indexing progress | \`lgraph status\` |
| Daemon is not running | \`lgraph start\` |
| Configure Codex in the current repo | \`lgraph add codex\` |

## Important Notes

- Use a full re-scan with \`lgraph init --force\` when you need to refresh DRG + Wiki outputs.
- The MCP knowledge graph only indexes source files: .js .jsx .ts .tsx .py .java .cpp .cs .go .c .h .css .scss .html
- Non-source files (.json, .yaml, .md, .env, etc.) are not indexed; read them directly with normal tools.
`;

// agents/openai.yaml declares the lgraph MCP server as a required tool dependency.
// Codex uses this to activate the server when the skill is invoked.
const OPENAI_YAML = `dependencies:
  tools:
    - type: "mcp"
      value: "lgraph"
      description: "Latentgraph dependency graph and code intelligence tools"
`;

const SKILL_GUIDES: Record<string, string> = {
    'lgraph-exploring': SKILL_GUIDE_EXPLORING,
    'lgraph-editing': SKILL_GUIDE_EDITING,
    'lgraph-impact': SKILL_GUIDE_IMPACT,
    'lgraph-debugging': SKILL_GUIDE_DEBUGGING,
    'lgraph-cli': SKILL_GUIDE_CLI,
};

export interface GenerateSkillsResult {
    created: string[];
    updated: string[];
}

export function generateSkillFiles(projectRoot: string): GenerateSkillsResult {
    const result: GenerateSkillsResult = { created: [], updated: [] };
    const skillsDir = path.join(projectRoot, '.agents', 'skills');

    for (const [name, content] of Object.entries(SKILL_GUIDES)) {
        const skillDir = path.join(skillsDir, name);
        const skillFile = path.join(skillDir, 'SKILL.md');
        const agentsDir = path.join(skillDir, 'agents');
        const openaiYamlFile = path.join(agentsDir, 'openai.yaml');

        if (!fs.existsSync(skillDir)) {
            fs.mkdirSync(skillDir, { recursive: true });
        }
        if (!fs.existsSync(agentsDir)) {
            fs.mkdirSync(agentsDir, { recursive: true });
        }

        const exists = fs.existsSync(skillFile);
        fs.writeFileSync(skillFile, content.trimStart());
        fs.writeFileSync(openaiYamlFile, OPENAI_YAML);

        if (exists) {
            result.updated.push(name);
        } else {
            result.created.push(name);
        }
    }

    return result;
}
