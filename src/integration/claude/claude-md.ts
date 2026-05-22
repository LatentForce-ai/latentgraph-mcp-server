/**
 * CLAUDE.md generation for Latentgraph MCP integration.
 *
 * Creates or updates CLAUDE.md in the project root with mandatory
 * usage rules that guide Claude Code toward using lgraph MCP tools.
 */

import * as fs from 'fs';
import * as path from 'path';

const SECTION_MARKER = '<!-- lgraph-mcp-instructions -->';
const END_MARKER = '<!-- end-lgraph-mcp-instructions -->';

const CLAUDE_MD_CONTENT = `${SECTION_MARKER}
## Latentgraph MCP Tools — MANDATORY USAGE RULES

This project has the **Latentgraph MCP server** (\`lgraph\`) configured with a pre-built dependency relationship graph (DRG) and CodeWiki-backed module documentation. You MUST use these tools as the primary way to understand indexed source code. Do NOT start by grepping or reading raw source files when MCP can answer the question faster and more safely.

### Tools Overview

| Tool | When to Use | What it gives you |
|------|-------------|-------------------|
| \`get_context\` | **DEFAULT first call** for any artifact. Pass \`targets=['project']\` for project overview, or file/module/symbol names | Architecture summary, module tree, file summaries, symbol context — unified entry point |
| \`get_file\` | Before reading or editing any indexed source file | Dense file summary, symbols, module role, implicit coupling preview, top dependents |
| \`get_dependencies\` | Trace relationships, imports, reverse deps, and runtime coupling | Relationship types, imported names, dependency summaries, reverse deps, implicit coupling |
| \`get_change_impact\` | **BEFORE editing** to see what would break | Affected files grouped by depth, supports symbol-level impact analysis |
| \`get_design_knowledge\` | Before editing to learn project conventions | PR-mined invariants and architectural decisions |
| \`get_symbol\` | Locate a function/class/method by name | File path, line span, signature, kind, decorators, docstring |
| \`get_call_chain\` | Trace symbol-level call graph | Callers and callees with confidence scores |
| \`get_dependency_path\` | Find how file A connects to file B | Shortest path with edge types (explicit/implicit) |
| \`search_codebase\` | Topic-based discovery across summaries/wiki/knowledge | Ranked hits by file, module, or knowledge type |
| \`ask_codebase\` | Natural language questions about the codebase | RAG-based answer with file citations |
| \`update_graph\` | Record learnings about DRG/CodeWiki | Learnings stored separately, queued for owner approval |

### The \`get_context\` Tool (Unified Entry Point)

This is your **DEFAULT first call** for understanding any artifact. It replaces the old project_overview, list_modules, and module_summary tools.

**Target types:**
- \`targets=['project']\` → Architecture summary + module tree (use \`depth=-1, include_files=true\` for full tree)
- \`targets=['path/to/file.py']\` → File context with summary, structure, knowledge
- \`targets=['module_name']\` → Module context with wiki docs, files, children
- \`targets=['file.py::function_name']\` → Symbol context with callers/callees
- \`targets=['function_name']\` → Bare symbol lookup across all files

**Examples:**
\`\`\`
get_context(targets=['project'])                                    # Quick orientation
get_context(targets=['project'], depth=-1, include_files=true)      # Full module tree with files
get_context(targets=['src/auth.py', 'src/login.py'])                # Multiple files at once
get_context(targets=['auth.py::authenticate'], include=['callers']) # Symbol with callers
\`\`\`

### Recording Learnings (\`update_graph\`)

Use this tool to record AI learnings about the codebase. All edits are queued for owner approval.

**Operations:**
| Operation | Purpose | Parameters |
|-----------|---------|------------|
| \`edit_file_summary\` | Add learning about a file | \`file_path\`, \`summary\` |
| \`edit_module_doc\` | Add learning about module | \`module_name\`, \`content\` |
| \`edit_dependency_summary\` | Add learning about a dependency | \`file_path\`, \`dependency_path\`, \`summary\` |
| \`add_dependency\` | Record discovered dependency | \`file_path\`, \`dependency_path\`, \`[summary]\` |
| \`delete_dependency\` | Suggest removing dependency | \`file_path\`, \`dependency_path\` |
| \`add_dependent\` | Record discovered dependent | \`file_path\`, \`dependent_path\`, \`[summary]\` |
| \`delete_dependent\` | Suggest removing dependent | \`file_path\`, \`dependent_path\` |
| \`add_implicit_dependency\` | Record runtime/coupling dependency | \`source_file\`, \`dep_file\`, \`[edge_summary]\` |
| \`edit_implicit_dependency\` | Add learning about implicit dep | \`source_file\`, \`dep_file\`, \`edge_summary\` |
| \`ignore_implicit_dependency\` | Mark implicit dep as false positive | \`source_file\`, \`dep_file\` |
| \`delete_implicit_dependency\` | Suggest removing implicit dep | \`source_file\`, \`dep_file\` |

### Operating Protocol

1. **Start of session / unfamiliar area**
   - Call \`get_context(targets=['project'])\` first for architecture overview
   - Call \`get_context(targets=['project'], depth=-1)\` to see full module tree
   - Call \`get_context(targets=[module_name])\` for the subsystem you'll touch
   - Call \`get_file\` on specific files you expect to edit
   - Run independent MCP calls in parallel when exploring multiple files

2. **Before reading any indexed source file**
   - Call \`get_file\` first for summary, symbols, and context
   - Only use raw \`Read\` for implementation details the summary doesn't cover
   - Use \`get_context\` when you need module-level context

3. **Before editing any indexed source file**
   - Call \`get_file\` to understand the file's purpose and module role
   - Call \`get_dependencies\` to inspect relationships and coupling
   - Call \`get_change_impact\` to understand downstream impact
   - Call \`get_design_knowledge\` to learn invariants you must not break

4. **When debugging or tracing behavior**
   - Use \`get_dependencies\` for imports, reverse deps, and implicit coupling
   - Use \`get_call_chain\` for symbol-level tracing
   - Use \`get_dependency_path\` to find how two files are connected
   - Use \`ask_codebase\` for cross-cutting questions

5. **When answering architecture questions**
   - Never answer from a single \`get_file\` call
   - Use \`get_context(targets=['project'])\` → \`get_context(targets=[module])\` → \`get_file\`
   - Use \`ask_codebase\` for natural language architecture questions

6. **For non-source files**
   - Read \`.json\`, \`.yaml\`, \`.md\`, etc. directly — do not call MCP tools on them

### Supported file types

**Indexed (use MCP tools):** \`.js\` \`.jsx\` \`.ts\` \`.tsx\` \`.py\` \`.java\` \`.cpp\` \`.cs\` \`.go\` \`.c\` \`.h\` \`.css\` \`.scss\` \`.html\`

**NOT indexed (read directly):** \`.json\` \`.yaml\` \`.yml\` \`.toml\` \`.env\` \`.md\` \`.txt\` \`.pdf\` \`.png\` \`.lock\` \`.xml\` \`.csv\`

### Task Patterns

| User intent | Recommended tools |
|-------------|-------------------|
| "Explain the project" | \`get_context(targets=['project'])\` → \`get_context(targets=[module])\` |
| "What does this file do?" | \`get_file(file_path)\` |
| "What module owns this?" | \`get_context(targets=[file_path])\` — check the module field |
| "What does this depend on?" | \`get_dependencies(file_path)\` |
| "What uses this?" | \`get_change_impact(target=file_path)\` |
| "How are these files connected?" | \`get_dependency_path(source, target)\` |
| "Find function X" | \`get_symbol(name='X')\` |
| "What calls this function?" | \`get_call_chain(symbol='file::func')\` |
| "How does auth work?" | \`ask_codebase(question='How does auth work?')\` |
| "Fix/refactor this file" | \`get_file\` → \`get_dependencies\` → \`get_change_impact\` → \`get_design_knowledge\` |
| "I learned something new" | \`update_graph(operation='edit_file_summary', ...)\` |

### Critical Rules

- **NEVER** use Grep/Glob as the first step for indexed source-file understanding
- **NEVER** answer module or architecture questions from a single raw file read
- **ALWAYS** use \`get_change_impact\` before non-trivial source edits
- **ALWAYS** use \`get_design_knowledge\` before editing shared code to learn invariants
- **ALWAYS** use \`update_graph\` when you discover something not in the existing summaries
- **ALWAYS** record edge cases, bugs, hidden dependencies, and non-obvious behaviors
- Do not pass \`project_id\` unless you need to override; the MCP server injects it from environment

---

## MANDATORY: Recording Learnings with \`update_graph\`

**THIS IS A MEMORY SYSTEM - YOU MUST USE IT PROACTIVELY.**

Every session, you MUST use \`mcp__lgraph__update_graph\` to record insights discovered during exploration. This is NOT optional. Learnings persist across sessions and help future agents understand the codebase better.

### Recording Frequency
- After reading **every 3-5 files**, ask yourself: "Did I learn something new?"
- If YES → IMMEDIATELY call \`update_graph\` before continuing
- If NO → Continue, but stay alert for insights

### WHEN to Use \`update_graph\` (Triggers)

You MUST call \`update_graph\` when you discover ANY of the following:

| Trigger | What to Record | Operation |
|---------|---------------|-----------|
| **Edge case or bug** | Discovered a bug, edge case, or gotcha in a file | \`edit_file_summary\` |
| **Hidden dependency** | Found a runtime coupling not in imports (Redis, events, config) | \`add_implicit_dependency\` |
| **Why code exists** | Understood WHY code is written a certain way | \`edit_file_summary\` |
| **Module behavior** | Learned how a module works beyond its docs | \`edit_module_doc\` |
| **Dependency purpose** | Understood why file A depends on file B | \`edit_dependency_summary\` |
| **Missing relationship** | Found a dependency that's not in the graph | \`add_dependency\` |

### HOW to Use \`update_graph\`

\`\`\`
# Record a file insight
update_graph(
  operation="edit_file_summary",
  file_path="src/auth.py",
  summary="EDGE CASE: Token refresh fails silently if Redis is down."
)

# Record an implicit dependency
update_graph(
  operation="add_implicit_dependency",
  source_file="src/api/handler.py",
  dep_file="src/workers/processor.py",
  edge_summary="Handler publishes to Redis queue that processor consumes"
)
\`\`\`

### MANDATORY Recording Protocol

1. **During exploration:** When you read files and discover something not in the existing summary → RECORD IT
2. **After debugging:** When you find the root cause of an issue → RECORD IT
3. **After understanding flow:** When you trace how components connect → RECORD relationships
4. **Before ending session:** Review what you learned and RECORD any unrecorded insights

### What Makes a Good Learning?

| Good Learning | Bad Learning |
|--------------|--------------|
| "This function silently fails if config.X is missing" | "This function processes data" |
| "Must call init() before any other method" | "Has several methods" |
| "File A triggers File B via Redis pub/sub on channel X" | "File A and B are related" |

If MCP results look stale after major codebase changes, do a full Latentgraph re-scan with \`lgraph init --force\`.
${END_MARKER}`;

/**
 * Create or update CLAUDE.md in the project root with lgraph instructions.
 * If the file already contains lgraph instructions, they are replaced in-place.
 * If the file exists without lgraph instructions, they are appended.
 * If the file doesn't exist, it is created.
 */
export function createClaudeMd(projectRoot: string): void {
    const claudeMdPath = path.join(projectRoot, 'CLAUDE.md');

    if (fs.existsSync(claudeMdPath)) {
        const existing = fs.readFileSync(claudeMdPath, 'utf-8');
        if (existing.includes(SECTION_MARKER)) {
            const start = existing.indexOf(SECTION_MARKER);
            const end = existing.indexOf(END_MARKER);
            if (end !== -1) {
                const before = existing.slice(0, start).trimEnd();
                const after = existing.slice(end + END_MARKER.length).trimStart();
                const updated = (before ? before + '\n\n' : '') + CLAUDE_MD_CONTENT + (after ? '\n\n' + after : '');
                fs.writeFileSync(claudeMdPath, updated);
            } else {
                const before = existing.slice(0, existing.indexOf(SECTION_MARKER)).trimEnd();
                fs.writeFileSync(claudeMdPath, (before ? before + '\n\n' : '') + CLAUDE_MD_CONTENT);
            }
            console.log('  [CLAUDE.md] Updated Latentgraph MCP instructions.');
            return;
        }

        fs.writeFileSync(claudeMdPath, existing.trimEnd() + '\n\n' + CLAUDE_MD_CONTENT);
        console.log('  [CLAUDE.md] Appended Latentgraph MCP instructions.');
    } else {
        fs.writeFileSync(claudeMdPath, CLAUDE_MD_CONTENT);
        console.log('  [CLAUDE.md] Created with Latentgraph MCP instructions.');
    }
}
