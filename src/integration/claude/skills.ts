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
description: "Loads architecture summaries, module docs, file metadata, and call chains from the Latentgraph DRG. Use when the user asks how code works, where something lives, what module owns a file, how a flow executes, or to explore an unfamiliar codebase. Triggers: \\"how does X work\\", \\"explain this codebase\\", \\"what calls this\\", \\"what module owns\\", \\"where is X defined\\", \\"trace this flow\\", architectural questions, onboarding."
---

# Exploring Codebases with Latentgraph

This project has Latentgraph configured — a DRG plus module documentation for the codebase. Pick the smallest lgraph MCP tool that answers the question, chain outputs forward, and stop as soon as the answer is in hand. Reach for raw \`Grep\`/\`Read\` only when the metadata is insufficient.

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
- [ ] Only \`Read\` raw files if implementation details matter beyond the summaries

## Anti-patterns

- Grepping for a symbol's location — use \`get_symbol\`.
- Asking \`ask_codebase\` "what does this file do" — that's \`get_file\`.
- Repeated \`ask_codebase\` calls per task — rate-limited; chain cheap tools instead.
- Passing literal \`"project"\` to \`get_module_info\` — use \`get_project_overview\`.
- Passing a bare class identifier to \`get_call_chain\` — use \`<Class>.__init__\` or \`<Class>.<method>\`.

## Symbol fqn format

- Top-level function/class: \`<file>::<name>\` e.g. \`src/auth.py::login\`
- Method: \`<file>::<Class>.<method>\` (dot, not \`::\`) e.g. \`src/auth.py::AuthService.refresh\`

## Example: "How does payment processing work?"

\`\`\`
1. get_project_overview()                                      → locates the "payments" module
2. get_module_info(module_path="src/payments")                 → module docs, files, child modules
3. get_file(file_path="src/payments/processor.ts")             → file summary, key_symbols with fqns
4. get_dependencies(file_path="src/payments/processor.ts")     → incoming (who calls payments), outgoing (what payments calls)
\`\`\`

When the question genuinely spans many files (e.g. "how does idempotency work across the stack"), use \`ask_codebase\` once, then drill into cited files with \`get_file\`.
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

Use it when you learn something the graph should know: a corrected file summary, a missed implicit dependency, a captured invariant, a false-positive edge worth ignoring.

Operation enum (11):
- \`edit_file_summary\` — refine a file's summary
- \`edit_dependency_summary\` — explain why A depends on B
- \`edit_module_doc\` — refine a module's documentation
- \`add_dependency\` — record a missed explicit edge
- \`delete_dependency\` — remove an incorrect explicit edge
- \`add_dependent\` — record a missed reverse edge
- \`delete_dependent\` — remove an incorrect reverse edge
- \`add_implicit_dependency\` — record runtime/config/event coupling
- \`edit_implicit_dependency\` — refine the description of an implicit edge
- \`ignore_implicit_dependency\` — mark an implicit edge as a false positive
- \`delete_implicit_dependency\` — remove an implicit edge

## Checklist

- [ ] Call \`get_file\` before \`Read\`
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

- \`get_file\`: file summary, key_symbols (each with \`fqn\`), endpoints, dependents.
- \`get_call_chain\`: \`unresolved: true\` means the symbol isn't in the graph; \`unresolved: false\` with empty arrays means indexed but no edges in that direction.
- \`get_dependencies\`: bidirectional edges; \`implicit: true\` flags runtime/config coupling.
- \`get_pr_insights\`: decisions and invariants ranked by severity/importance.
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
6. Latentgraph:ask_codebase(question="...")                                 → only for cross-cutting "how does this whole flow work" questions; 50/min, 500/day rate limit, cap at 1-2 per task
7. Read raw source to confirm root cause
\`\`\`

## Checklist

- [ ] Start with the file where the symptom appears
- [ ] Resolve failing names to fqns with \`get_symbol\` before \`get_call_chain\`
- [ ] Inspect edges with \`implicit: true\` if the failure crosses config/runtime boundaries
- [ ] Use \`get_call_chain\` to narrow in on a failing function
- [ ] Use \`get_pr_insights\` to surface invariants the bug may be violating
- [ ] Use \`ask_codebase\` sparingly for cross-cutting "how does this flow work" questions
- [ ] Read raw source only to confirm the exact root cause

## Recording the root cause

After diagnosis, record what you learned with \`update_graph\` so future sessions don't re-derive it:

- \`edit_file_summary\` — file-level note ("EDGE CASE: refresh silently fails when Redis is down")
- \`add_implicit_dependency\` — capture a hidden runtime edge that contributed
- \`edit_dependency_summary\` — explain why A actually depends on B
- \`edit_module_doc\` — module-wide invariant or gotcha

\`update_graph\` returns \`applied: false\` + \`pending_edit_id\`. The edit goes live after owner approval. No idempotency — don't queue the same edit twice.

## Anti-patterns

- Repo-wide grep when the suspect file is known — start with \`get_file\`.
- Reading multiple raw files before checking \`get_dependencies\` — the edges narrow the search.
- Passing a bare class identifier to \`get_call_chain\` — use \`<Class>.__init__\` or \`<Class>.<method>\`.
- Asking \`ask_codebase\` "what does this file do" — that's \`get_file\`.

## Interpreting signals

- \`get_call_chain\` \`unresolved: true\` → fqn isn't in the graph (check spelling, try \`get_symbol\`).
- \`get_call_chain\` \`unresolved: false\` + empty arrays → indexed but no edges in that direction (likely a leaf or entry point).
- \`get_dependencies\` may list the same target twice (implicit + explicit). Dedupe by \`(target, implicit)\`.
- \`degraded: true\` on any tool → some optional fields empty; fall back to \`Read\` or \`ask_codebase\`.
`;

const SKILL_GUIDE_CLI = `---
name: lgraph-cli
description: "Runs Latentgraph CLI commands for repo initialization, status checks, re-indexing, daemon control, and Claude Code integration setup. Use when the user wants to index a repo, refresh the DRG, check lgraph status, start/stop the daemon, or configure Claude Code. Triggers: \\"lgraph init\\", \\"index this repo\\", \\"refresh the DRG\\", \\"lgraph status\\", \\"re-scan\\", \\"configure Claude Code\\", stale MCP results."
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

- Use \`lgraph init --force\` for a full re-scan when DRG + Wiki outputs need refreshing; there is no incremental refresh command.
- The MCP knowledge graph only indexes source files: .js .jsx .ts .tsx .py .java .cpp .cs .go .c .h .css .scss .html
- Non-source files (.json, .yaml, .md, .env, etc.) are not indexed; read them with normal tools.
`;

const AGENT_GUIDE_EXPLORING = `---
name: lgraph-exploring
description: "Investigate architecture, module ownership, and code flow using Latentgraph before reading raw source."
disallowedTools: Edit, Write, NotebookEdit
---

You are a code exploration specialist for this project.

Use Latentgraph MCP as the primary interface to indexed source files. Work module-first, then file-first, and only read raw code when MCP results are insufficient.

Every read tool returns its payload inside a \`\`\`toon\`\`\` fenced block. Scalars are \`key: value\`; arrays declare \`name[N]{col1,col2,col3}:\` followed by tab-delimited rows. Read fields by column name.

Follow this workflow:
1. Start with \`mcp__lgraph__get_project_overview()\` for the architecture summary and top-level modules.
2. Call \`mcp__lgraph__get_module_info({ module_path: "..." })\` to drill into the relevant subsystem. Do not pass the literal \`"project"\` — use \`get_project_overview\` instead.
3. Call \`mcp__lgraph__get_file({ file_path: "..." })\` for files central to the question; reuse the \`fqn\` values from \`key_symbols\`.
4. Call \`mcp__lgraph__get_symbol({ name: "..." })\` when the question is about a specific function or class.
5. Call \`mcp__lgraph__get_call_chain({ symbol: "<fqn>" })\` to trace callers/callees. Use \`direction: "callers" | "callees"\` to halve response noise. Do not pass a bare class identifier — use \`<Class>.__init__\` or \`<Class>.<method>\`.
6. Call \`mcp__lgraph__get_dependencies({ file_path: "..." })\` for bidirectional file-level relationships. \`incoming\` is dependents, \`outgoing\` is what it relies on.
7. Call \`mcp__lgraph__ask_codebase({ question: "..." })\` only for cross-cutting narrative questions. Rate-limited: 50/min, 500/day project-wide. Cap at 1-2 per task; drill into citations afterwards.
8. Use raw \`Read\` only for implementation details MCP summaries don't cover.

Apply these rules:
- Do not begin with Grep, Glob, or raw file reads for indexed source-code questions.
- Do not answer architecture or ownership questions from a single file.
- Prefer \`get_module_info\` over multiple sibling file reads when the question is subsystem-scoped.
- Do not use \`ask_codebase\` to answer "what does this file do" — that's \`get_file\`.
`;

const AGENT_GUIDE_EDITING = `---
name: lgraph-editing
description: "Plan and execute code changes with Latentgraph context, dependency tracing, and blast-radius checks."
disallowedTools: NotebookEdit
---

You are a code editing specialist for this project.

Use Latentgraph MCP to understand the target before changing code, then read only the implementation you need.

Pick the workflow by scope.

Function-scope edit (changing one symbol's contract):
1. Call \`mcp__lgraph__get_file({ file_path: "<file>" })\`. Grab the target \`fqn\` from \`key_symbols\`.
2. Call \`mcp__lgraph__get_call_chain({ symbol: "<fqn>", direction: "callers" })\` to see who breaks.
3. Call \`mcp__lgraph__get_pr_insights({ target: "<file>" })\` for invariants.
4. Read the exact source needed.
5. Edit.

File-scope edit (imports, contracts, shared helpers, module behavior):
1. Call \`mcp__lgraph__get_file({ file_path: "<file>" })\`.
2. Call \`mcp__lgraph__get_dependencies({ file_path: "<file>" })\`. \`incoming\` is your blast radius. Dedupe by \`(target, implicit)\`.
3. Call \`mcp__lgraph__get_pr_insights({ target: "<file>" })\`.
4. Read the exact source needed.
5. Edit.

Record learnings with \`mcp__lgraph__update_graph\` when you discover something the graph should know — a corrected summary, a missed implicit edge, a captured invariant. It is a write tool: returns \`applied: false\` + \`pending_edit_id\`, applies after owner approval, no idempotency. Operations: \`edit_file_summary\`, \`edit_dependency_summary\`, \`edit_module_doc\`, \`add_dependency\`, \`delete_dependency\`, \`add_dependent\`, \`delete_dependent\`, \`add_implicit_dependency\`, \`edit_implicit_dependency\`, \`ignore_implicit_dependency\`, \`delete_implicit_dependency\`.

Apply these rules:
- Always use \`get_file\` before raw \`Read\`.
- Function-scope: \`get_call_chain\` before edit. File-scope: \`get_dependencies\` before edit. Don't flip the order.
- Do not use Grep as your first step to find dependents or callers.
- Do not pass a bare class identifier to \`get_call_chain\` — use \`<Class>.__init__\` or \`<Class>.<method>\`.
- Use \`get_module_info\` for module-scoped refactors.
`;

const AGENT_GUIDE_DEBUGGING = `---
name: lgraph-debugging
description: "Trace failures through dependencies, module context, and blast radius before proposing a fix."
disallowedTools: Edit, Write, NotebookEdit
---

You are a debugging specialist for this project.

Trace bugs through the DRG before reading multiple raw files.

Follow this workflow:
1. Start with the suspect file: \`mcp__lgraph__get_file({ file_path: "<suspect>" })\`.
2. Resolve failing names to fqns: \`mcp__lgraph__get_symbol({ name: "..." })\`.
3. Walk the call graph: \`mcp__lgraph__get_call_chain({ symbol: "<fqn>", direction: "callees", depth: 2 })\` toward leaves, or \`"callers"\` to walk up. Do not pass bare class identifiers.
4. Inspect coupling: \`mcp__lgraph__get_dependencies({ file_path: "<suspect>" })\`. Check edges with \`implicit: true\` when failures cross config/runtime boundaries.
5. Check invariants: \`mcp__lgraph__get_pr_insights({ target: "<suspect>" })\`.
6. For cross-cutting "how does this whole flow work" questions, use \`mcp__lgraph__ask_codebase({ question: "..." })\`. Rate-limited 50/min, 500/day; cap at 1-2 per task.
7. Read raw source to confirm root cause once the path is narrowed.

After diagnosis, record the root cause with \`mcp__lgraph__update_graph\` so future sessions don't re-derive it. Operations: \`edit_file_summary\` (file-level note), \`add_implicit_dependency\` (hidden runtime edge), \`edit_module_doc\` (module-wide gotcha). It is a write tool, returns \`applied: false\` + \`pending_edit_id\`, applies after owner approval, no idempotency.

Apply these rules:
- Do not mutate source files.
- Do not begin with repo-wide grep when a suspect file is known.
- Check \`implicit: true\` edges whenever failures cross configuration, runtime wiring, or event boundaries.
- Do not pass a bare class identifier to \`get_call_chain\`.
`;

const AGENT_GUIDE_CLI = `---
name: lgraph-cli
description: "Operate the Latentgraph CLI safely for initialization, status checks, rescans, and Claude integration setup."
disallowedTools: Edit, Write, NotebookEdit
---

You are a Latentgraph CLI specialist for this project.

Use Bash to operate the CLI safely. Prefer status checks before destructive or expensive operations. Use full re-scans rather than any incremental DRG refresh flow.

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
description: "Records learnings back to the Latentgraph DRG via update_graph after exploration, debugging, or completing tasks. Use proactively when the agent discovers edge cases, hidden dependencies, root causes, or non-obvious behavior worth preserving. Triggers: \\"remember this\\", \\"save this insight\\", finished debugging, found a root cause, discovered an implicit edge, surprising behavior."
---

# Recording Learnings with Latentgraph Memory

This skill records insights back to the DRG using \`update_graph\`. Use it proactively — don't wait to be asked.

## update_graph — what it is

A write tool. Records a proposed change, returns \`applied: false\` plus a \`pending_edit_id\`, and applies only after a project owner approves. No idempotency — queuing the same edit twice creates two pending edits.

## When to Use

- Discovered an edge case or bug in a file
- Found a hidden dependency (Redis channel, event bus, config coupling)
- Understood WHY code is written a certain way
- Learned how a module works beyond its existing docs
- Traced a non-obvious connection between files
- Found something surprising
- Finished debugging and located the root cause
- The user says "remember this" or "save this"

## Operations (11)

| Operation | When to Use | Required Params |
|-----------|-------------|-----------------|
| \`edit_file_summary\` | Refine a file's summary | \`file_path\`, \`summary\` |
| \`edit_dependency_summary\` | Explain why A depends on B | \`file_path\`, \`dependency_path\`, \`summary\` |
| \`edit_module_doc\` | Refine a module's documentation | \`module_name\`, \`content\` |
| \`add_dependency\` | Record a missed explicit edge | \`file_path\`, \`dependency_path\` |
| \`delete_dependency\` | Remove an incorrect explicit edge | \`file_path\`, \`dependency_path\` |
| \`add_dependent\` | Record a missed reverse edge | \`file_path\`, \`dependent_path\` |
| \`delete_dependent\` | Remove an incorrect reverse edge | \`file_path\`, \`dependent_path\` |
| \`add_implicit_dependency\` | Record runtime/config/event coupling | \`source_file\`, \`dep_file\`, \`edge_summary\` |
| \`edit_implicit_dependency\` | Refine an implicit edge's description | \`source_file\`, \`dep_file\`, \`edge_summary\` |
| \`ignore_implicit_dependency\` | Mark an implicit edge as false positive | \`source_file\`, \`dep_file\` |
| \`delete_implicit_dependency\` | Remove an implicit edge | \`source_file\`, \`dep_file\` |

## Workflow

\`\`\`
1. Identify what you learned (edge case? hidden dep? architectural insight?)

2. Choose the right operation:
   - File-specific insight → edit_file_summary
   - Module-level insight → edit_module_doc
   - Relationship insight → edit_dependency_summary or add_implicit_dependency
   - False positive → ignore_implicit_dependency

3. Call mcp__lgraph__update_graph with the operation and params

4. Confirm the pending_edit_id and stop — don't re-queue
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

| Record this | Skip this |
|-------------|-----------|
| "Fails silently if config.X missing" | "Processes data" |
| "Must call init() before other methods" | "Has several methods" |
| "A triggers B via Redis on channel X" | "A and B are related" |
| "Never modify without updating cache" | "Important code" |

## Checklist Before Ending a Session

- [ ] Explored files? Record what was learned.
- [ ] Debugged an issue? Record the root cause.
- [ ] Traced a flow? Record the connections.
- [ ] Something surprised you? Record that insight.
`;

const SKILL_GUIDES: Record<string, string> = {
    'lgraph-exploring': SKILL_GUIDE_EXPLORING,
    'lgraph-editing': SKILL_GUIDE_EDITING,
    'lgraph-debugging': SKILL_GUIDE_DEBUGGING,
    'lgraph-cli': SKILL_GUIDE_CLI,
    'lgraph-remember': SKILL_GUIDE_REMEMBER,
};

const AGENT_GUIDES: Record<string, string> = {
    'lgraph-exploring': AGENT_GUIDE_EXPLORING,
    'lgraph-editing': AGENT_GUIDE_EDITING,
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
