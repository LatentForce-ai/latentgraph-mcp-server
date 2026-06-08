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
description: "Loads architecture summaries, module docs, file metadata, and call chains from the Latentgraph DRG. Use when the user asks how code works, where something lives, what module owns a file, how a flow executes, or to explore an unfamiliar codebase. Triggers: \\"how does X work\\", \\"explain this codebase\\", \\"what calls this\\", \\"what module owns\\", \\"where is X defined\\", \\"trace this flow\\", architectural questions, onboarding."
---

# Exploring Codebases with Latentgraph

This project has Latentgraph configured — a DRG plus module documentation for the codebase. Pick the smallest lgraph MCP tool that answers the question, chain outputs forward, and stop as soon as the answer is in hand. Reach for raw search only when the metadata is insufficient.

## When to Use

- "Explain this codebase"
- "How does authentication work?"
- "What module owns this file?"
- "Show me the main subsystems"
- "Where is the database logic?"
- Onboarding into unfamiliar code before making changes

## Reading TOON output

Every read tool returns its payload inside a \`\`\`\`\`\`toon\`\`\`\`\`\` fenced block. (\`update_graph\` is the exception — plain text.) Format:

- Scalars: \`key: value\`
- Arrays: \`name[N]{col1,col2,col3}:\` declares row count and column header, followed by tab-delimited rows.
- Read every field BY COLUMN NAME, not by position.

## Workflow

\`\`\`
1. Latentgraph:get_project_overview()                 → architecture + top-level modules
2. Latentgraph:get_module_info(module_path="...")     → module docs, files, child modules. Rejects literal "project" — use get_project_overview for that.
3. Latentgraph:get_file(file_path="...")              → file summary + key_symbols (each has an fqn ready for get_call_chain)
4. Latentgraph:get_symbol(name="...")                 → locate a function/class/method by name; returns fqn(s)
5. Latentgraph:get_call_chain(symbol="<fqn>")         → callers/callees for one symbol; direction ∈ callers|callees|both, depth 1-5
6. Latentgraph:get_dependencies(file_path="...")      → file-level incoming (dependents) + outgoing (what it relies on); dedupe by (target, implicit)
7. Latentgraph:ask_codebase(question="...")           → LLM-synthesized narrative across many files, with citations
\`\`\`

\`ask_codebase\` is rate-limited: 50/min, 500/day project-wide. Cap usage at 1-2 calls per task. Drill into citations with \`get_file\` afterwards.

## Checklist

- [ ] Call \`get_project_overview\` first for the big picture
- [ ] Call \`get_module_info\` to drill into the right subsystem
- [ ] Call \`get_file\` on key entry or integration files; reuse the \`fqn\` values it returns
- [ ] Call \`get_dependencies\` on central files; read \`incoming\` for dependents, \`outgoing\` for what they rely on
- [ ] Call \`get_call_chain\` when the question is about a specific function or method
- [ ] Use \`ask_codebase\` only for cross-cutting narrative questions, max 1-2 per task
- [ ] Only read raw files if implementation details matter beyond the summaries

## Anti-patterns

- Grepping for a symbol's location — use \`get_symbol\`.
- Asking \`ask_codebase\` "what does this file do" — that's \`get_file\`.
- Repeated \`ask_codebase\` calls per task — rate-limited; chain cheap tools instead.
- Passing literal \`"project"\` to \`get_module_info\` — use \`get_project_overview\`.
- Passing a bare class identifier to \`get_call_chain\` — use \`<Class>.__init__\` or \`<Class>.<method>\`.

## Symbol fqn format

- Top-level function/class: \`<file>::<name>\` e.g. \`src/auth.py::login\`
- Method: \`<file>::<Class>.<method>\` (dot, not \`::\`) e.g. \`src/auth.py::AuthService.refresh\`
`;

const SKILL_GUIDE_EDITING = `---
name: lgraph-editing
description: "Walks Latentgraph context (file metadata, call chains, dependencies, PR-mined invariants) before code edits, then records corrections back via update_graph. Use when the user asks to fix a bug, add a feature, modify a function, refactor a module, change a handler, or otherwise touch indexed source code. Triggers: \\"fix\\", \\"add feature\\", \\"refactor\\", \\"update handler\\", \\"change function\\", \\"rename\\", any source-code modification."
---

# Editing Code with Latentgraph

This project has Latentgraph configured. Use the lgraph MCP tools to load context and assess blast radius BEFORE editing. Two distinct workflows depending on scope.

## When to Use

- "Fix bug in X"
- "Add feature to Y"
- "Refactor this module"
- "Update this handler"
- "Change the signature of foo()"
- Any task that modifies indexed source code

## Workflow — function-scope edit (changing one symbol's contract)

\`\`\`
1. Latentgraph:get_file(file_path="<file>")                                  → summary + key_symbols; grab the fqn of the symbol you're editing
2. Latentgraph:get_call_chain(symbol="<fqn>", direction="callers")           → who breaks if you change the signature
3. Latentgraph:get_pr_insights(target="<file>")                              → invariants and decisions for the file
4. Read the exact code sections you need
5. Edit
\`\`\`

## Workflow — file-scope edit (changing imports, contracts, shared helpers, module behavior)

\`\`\`
1. Latentgraph:get_file(file_path="<file>")                                  → summary + key_symbols
2. Latentgraph:get_dependencies(file_path="<file>")                          → incoming (blast radius), outgoing (what you rely on); dedupe by (target, implicit)
3. Latentgraph:get_pr_insights(target="<file>")                              → invariants and decisions
4. Read the exact code sections you need
5. Edit
\`\`\`

Pick the workflow by scope — don't run \`get_dependencies\` ahead of \`get_call_chain\` when the change is one function.

## Recording learnings — update_graph

\`update_graph\` is a write tool. It records a proposed change, returns \`applied: false\` plus a \`pending_edit_id\`, and only applies after owner approval. It has no idempotency — queuing the same edit twice creates two pending edits.

Use it when you learn something the graph should know: a corrected file summary, a missed implicit dependency, a captured invariant, a false-positive edge.

Operation enum (11):
- \`edit_file_summary\`, \`edit_dependency_summary\`, \`edit_module_doc\`
- \`add_dependency\`, \`delete_dependency\`, \`add_dependent\`, \`delete_dependent\`
- \`add_implicit_dependency\`, \`edit_implicit_dependency\`, \`ignore_implicit_dependency\`, \`delete_implicit_dependency\`

## Checklist

- [ ] Call \`get_file\` before reading the raw file
- [ ] Function-scope: call \`get_call_chain(direction="callers")\` on the target fqn
- [ ] File-scope: call \`get_dependencies\` and read \`incoming\` as your blast radius
- [ ] Call \`get_pr_insights\` before non-trivial edits
- [ ] Read only the implementation you need
- [ ] After edit, re-check the \`incoming\` list (file-scope) or callers (function-scope)
- [ ] If you discovered an implicit edge, corrected a summary, or captured an invariant — \`update_graph\`

## Anti-patterns

- Grep-first for importers/callers — use \`get_dependencies\` or \`get_call_chain\`.
- Reading the raw file before \`get_file\` — you may not need the read at all.
- Running \`get_dependencies\` for a single-function edit — \`get_call_chain\` is narrower.
- Passing a bare class identifier to \`get_call_chain\` — use \`<Class>.__init__\` or \`<Class>.<method>\`.

## Reading the Signals

- \`get_file\` gives file summary, key_symbols (each with \`fqn\`), endpoints, dependents.
- \`get_call_chain\` \`unresolved: true\` = not in graph; \`unresolved: false\` + empty arrays = indexed but no edges that direction.
- \`get_dependencies\` returns bidirectional edges; \`implicit: true\` flags runtime/config coupling.
- \`get_pr_insights\` surfaces decisions and invariants ranked by severity/importance.
`;

const SKILL_GUIDE_DEBUGGING = `---
name: lgraph-debugging
description: "Traces failures through Latentgraph dependencies, call chains, module context, and PR-mined invariants before reading raw files. Use when the user is investigating a bug, regression, or unexpected behavior, or wants to find a root cause. Triggers: \\"why is X failing\\", \\"trace this bug\\", \\"where does this error come from\\", \\"why did this break\\", \\"who uses this code path\\", \\"root cause\\", debugging, regressions."
---

# Debugging with Latentgraph

This project has Latentgraph configured. Trace bugs through the DRG before reading multiple raw files.

## When to Use

- "Why is this failing?"
- "Trace where this error comes from"
- "Why did this change break Y?"
- "Who uses this code path?"
- Investigating bugs, regressions, and unexpected behavior

## Workflow

\`\`\`
1. Latentgraph:get_file(file_path="<suspect>")                              → file summary + key_symbols
2. Latentgraph:get_symbol(name="<failing symbol>")                          → resolve to fqn if not already known
3. Latentgraph:get_call_chain(symbol="<fqn>", direction="callees", depth=2) → walk down toward the leaf; switch to "callers" to walk up
4. Latentgraph:get_dependencies(file_path="<suspect>")                      → bidirectional edges, including \`implicit: true\` (config/event/runtime)
5. Latentgraph:get_pr_insights(target="<suspect>")                          → invariants the bug may be violating
6. Latentgraph:ask_codebase(question="...")                                 → cross-cutting "how does this flow work" questions only; 50/min, 500/day rate limit, cap at 1-2 per task
7. Read raw source to confirm root cause
\`\`\`

## Checklist

- [ ] Start with the file where the symptom appears
- [ ] Resolve failing names to fqns with \`get_symbol\` before \`get_call_chain\`
- [ ] Inspect edges with \`implicit: true\` if the failure crosses config/runtime boundaries
- [ ] Use \`get_call_chain\` to narrow in on a failing function
- [ ] Use \`get_pr_insights\` to surface invariants the bug may be violating
- [ ] Use \`ask_codebase\` sparingly for cross-cutting questions
- [ ] Read raw source only to confirm the exact root cause

## Recording the root cause

After diagnosis, record what you learned with \`update_graph\` so future sessions don't re-derive it:

- \`edit_file_summary\` — file-level note ("EDGE CASE: refresh silently fails when Redis is down")
- \`add_implicit_dependency\` — capture a hidden runtime edge that contributed
- \`edit_dependency_summary\` — explain why A actually depends on B
- \`edit_module_doc\` — module-wide invariant or gotcha

\`update_graph\` returns \`applied: false\` + \`pending_edit_id\`. Applies after owner approval. No idempotency.

## Anti-patterns

- Repo-wide grep when the suspect file is known — start with \`get_file\`.
- Reading multiple raw files before checking \`get_dependencies\`.
- Passing a bare class identifier to \`get_call_chain\` — use \`<Class>.__init__\` or \`<Class>.<method>\`.
- Asking \`ask_codebase\` "what does this file do" — that's \`get_file\`.

## Interpreting signals

- \`get_call_chain\` \`unresolved: true\` → fqn isn't in the graph (check spelling, try \`get_symbol\`).
- \`get_call_chain\` \`unresolved: false\` + empty arrays → indexed but no edges that direction.
- \`get_dependencies\` may list the same target twice (implicit + explicit). Dedupe by \`(target, implicit)\`.
- \`degraded: true\` on any tool → optional fields empty; fall back to raw read or \`ask_codebase\`.
`;

const SKILL_GUIDE_CLI = `---
name: lgraph-cli
description: "Runs Latentgraph CLI commands for repo initialization, status checks, re-indexing, daemon control, and Codex integration setup. Use when the user wants to index a repo, refresh the DRG, check lgraph status, start/stop the daemon, or configure Codex. Triggers: \\"lgraph init\\", \\"index this repo\\", \\"refresh the DRG\\", \\"lgraph status\\", \\"re-scan\\", \\"configure Codex\\", stale MCP results."
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

- Use \`lgraph init --force\` for a full re-scan when DRG + Wiki outputs need refreshing; there is no incremental refresh command.
- The MCP knowledge graph only indexes source files: .js .jsx .ts .tsx .py .java .cpp .cs .go .c .h .css .scss .html
- Non-source files (.json, .yaml, .md, .env, etc.) are not indexed; read them with normal tools.
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
