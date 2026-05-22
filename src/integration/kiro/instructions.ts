/**
 * Root AGENTS.md plus Kiro steering generation for Latentgraph Kiro integration.
 *
 * Kiro automatically includes AGENTS.md from the workspace root, and it also
 * natively loads workspace steering files from .kiro/steering/.
 */

import * as fs from 'fs';
import * as path from 'path';

const SECTION_MARKER = '<!-- lgraph-mcp-instructions -->';
const END_MARKER = '<!-- end-lgraph-mcp-instructions -->';

const AGENTS_MD_CONTENT = `${SECTION_MARKER}
## Latentgraph MCP Tools — MANDATORY USAGE RULES

This project has the **Latentgraph MCP server** (\`lgraph\`) configured with a pre-built dependency relationship graph (DRG) and CodeWiki-backed module documentation. You MUST use these tools as the primary way to understand indexed source code. Do NOT start by searching or reading raw source files when MCP can answer the question faster and more safely.

### Tools (recommended order)

| Tool | When to Use | What it gives you |
|------|-------------|-------------------|
| \`get_context\` | **DEFAULT first call** — session start, unfamiliar area, project or module overview | Architecture summary, module tree, file summary, symbol context — unified entry point. Pass \`targets=['project']\` for project-level, \`targets=['path/to/file']\` for file/module context |
| \`get_file\` | Before reading or editing any indexed source file | Dense file summary, symbols, module role, implicit coupling preview, top dependents |
| \`get_dependencies\` | Trace relationships, imports, reverse deps, and runtime coupling | Relationship types, imported names, dependency summaries, reverse deps, implicit coupling |
| \`get_change_impact\` | Before editing or refactoring | Affected files grouped by depth, supports symbol-level impact |

### Operating Protocol

1. **Start of session / unfamiliar area**
   - Call \`get_context(targets=['project'])\` for orientation.
   - Call \`get_context(targets=['<file-path>'])\` for a specific file or module.
   - Call \`get_file\` for the specific files to edit.
   - Run independent MCP calls in parallel when exploring multiple files or modules.

2. **Before reading any indexed source file**
   - Call \`get_file\` first.
   - Only use raw \`Read\` for implementation details the summary does not cover.
   - Call \`get_context(targets=['<file-path>'])\` for broader module context if needed.

3. **Before editing any indexed source file**
   - Call \`get_file\` to understand the file's purpose, module role, and nearby coupling signals.
   - Call \`get_dependencies\` to inspect relationships, imported names, reverse deps, and implicit coupling.
   - Call \`get_change_impact\` to understand downstream impact before making changes.

4. **When debugging or tracing behavior**
   - Use \`get_dependencies\` for imports, reverse deps, relationship types, and implicit coupling.
   - Use \`get_change_impact\` for "what else could this break?".
   - Use \`get_context\` when the bug spans multiple files in one subsystem.

5. **When answering architecture questions**
   - Use \`get_context(targets=['project'])\` → \`get_context(targets=['<module-or-file>'])\` → \`get_file\`.

6. **For non-source files**
   - Read them directly; do not call MCP tools on them.

### Supported file types

**Indexed (use MCP tools):** \`.js\` \`.jsx\` \`.ts\` \`.tsx\` \`.py\` \`.java\` \`.cpp\` \`.cs\` \`.go\` \`.c\` \`.h\` \`.css\` \`.scss\` \`.html\`

**NOT indexed (read directly):** \`.json\` \`.yaml\` \`.yml\` \`.toml\` \`.env\` \`.md\` \`.txt\` \`.pdf\` \`.png\` \`.lock\` \`.xml\` \`.csv\` and other non-source formats.

Do NOT call MCP tools on non-indexed files — read those directly.

### Level Guidance

**For \`get_file\`:**
- \`level=0\` → the file only
- \`level=1\` → the file plus immediate module ancestry
- \`level=2\` → broader architectural ancestry when the subsystem is unfamiliar

**For \`get_change_impact\`:**
- \`level=1\` → direct dependents only
- \`level=2\` → direct plus secondary impact
- \`level=3\` → deepest available transitive impact for shared utilities or risky refactors

### Critical Rules

- **NEVER** use Grep/Glob as the first step for indexed source-file understanding.
- **NEVER** answer module or architecture questions from a single raw file read.
- **ALWAYS** use \`get_change_impact\` before non-trivial source edits.
- **ALWAYS** use \`get_context(targets=['project'])\` for project orientation before diving into files.

If MCP results look stale after major codebase changes, do a full Latentgraph re-scan with \`lgraph init --force\`.
<!-- end-lgraph-mcp-instructions -->`;

const STEERING_FILE_CONTENT = `# Latentgraph MCP Tools — MANDATORY USAGE RULES

This project has the **Latentgraph MCP server** (\`lgraph\`) configured with a pre-built dependency relationship graph (DRG) and CodeWiki-backed module documentation. You MUST use these tools as the primary way to understand indexed source code. Do NOT start by searching or reading raw source files when MCP can answer the question faster and more safely.

## Tools (recommended order)

| Tool | When to Use | What it gives you |
|------|-------------|-------------------|
| \`get_context\` | **DEFAULT first call** — session start, unfamiliar area, project or module overview | Architecture summary, module tree, file summary, symbol context — unified entry point. Pass \`targets=['project']\` for project-level, \`targets=['path/to/file']\` for file/module context |
| \`get_file\` | Before reading or editing any indexed source file | Dense file summary, symbols, module role, implicit coupling preview, top dependents |
| \`get_dependencies\` | Trace relationships, imports, reverse deps, and runtime coupling | Relationship types, imported names, dependency summaries, reverse deps, implicit coupling |
| \`get_change_impact\` | Before editing or refactoring | Affected files grouped by depth, supports symbol-level impact |

## Operating Protocol

1. **Start of session / unfamiliar area**
   - Call \`get_context(targets=['project'])\` for orientation.
   - Call \`get_context(targets=['<file-path>'])\` for a specific file or module.
   - Call \`get_file\` for the specific files to edit.
   - Run independent MCP calls in parallel when exploring multiple files or modules.

2. **Before reading any indexed source file**
   - Call \`get_file\` first.
   - Only use raw \`Read\` for implementation details the summary does not cover.
   - Call \`get_context(targets=['<file-path>'])\` for broader module context if needed.

3. **Before editing any indexed source file**
   - Call \`get_file\` to understand the file's purpose, module role, and nearby coupling signals.
   - Call \`get_dependencies\` to inspect relationships, imported names, reverse deps, and implicit coupling.
   - Call \`get_change_impact\` to understand downstream impact before making changes.

4. **When debugging or tracing behavior**
   - Use \`get_dependencies\` for imports, reverse deps, relationship types, and implicit coupling.
   - Use \`get_change_impact\` for "what else could this break?".
   - Use \`get_context\` when the bug spans multiple files in one subsystem.

5. **When answering architecture questions**
   - Use \`get_context(targets=['project'])\` → \`get_context(targets=['<module-or-file>'])\` → \`get_file\`.

6. **For non-source files**
   - Read them directly; do not call MCP tools on them.

## Supported file types

**Indexed (use MCP tools):** \`.js\` \`.jsx\` \`.ts\` \`.tsx\` \`.py\` \`.java\` \`.cpp\` \`.cs\` \`.go\` \`.c\` \`.h\` \`.css\` \`.scss\` \`.html\`

**NOT indexed (read directly):** \`.json\` \`.yaml\` \`.yml\` \`.toml\` \`.env\` \`.md\` \`.txt\` \`.pdf\` \`.png\` \`.lock\` \`.xml\` \`.csv\` and other non-source formats.

Do NOT call MCP tools on non-indexed files — read those directly.

## Level Guidance

**For \`get_file\`:**
- \`level=0\` → the file only
- \`level=1\` → the file plus immediate module ancestry
- \`level=2\` → broader architectural ancestry when the subsystem is unfamiliar

**For \`get_change_impact\`:**
- \`level=1\` → direct dependents only
- \`level=2\` → direct plus secondary impact
- \`level=3\` → deepest available transitive impact for shared utilities or risky refactors

## Critical Rules

- **NEVER** use Grep/Glob as the first step for indexed source-file understanding.
- **NEVER** answer module or architecture questions from a single raw file read.
- **ALWAYS** use \`get_change_impact\` before non-trivial source edits.
- **ALWAYS** use \`get_context(targets=['project'])\` for project orientation before diving into files.

If MCP results look stale after major codebase changes, do a full Latentgraph re-scan with \`lgraph init --force\`.
`;

export function createAgentsMd(projectRoot: string): void {
    const agentsMdPath = path.join(projectRoot, 'AGENTS.md');

    if (fs.existsSync(agentsMdPath)) {
        const existing = fs.readFileSync(agentsMdPath, 'utf-8');

        if (existing.includes(SECTION_MARKER)) {
            const start = existing.indexOf(SECTION_MARKER);
            const end = existing.indexOf(END_MARKER);
            if (end !== -1) {
                const before = existing.slice(0, start).trimEnd();
                const after = existing.slice(end + END_MARKER.length).trimStart();
                const updated =
                    (before ? before + '\n\n' : '') +
                    AGENTS_MD_CONTENT +
                    (after ? '\n\n' + after : '');
                fs.writeFileSync(agentsMdPath, updated);
            } else {
                const before = existing.slice(0, existing.indexOf(SECTION_MARKER)).trimEnd();
                fs.writeFileSync(
                    agentsMdPath,
                    (before ? before + '\n\n' : '') + AGENTS_MD_CONTENT,
                );
            }
            console.log('  [AGENTS.md] Updated Latentgraph MCP instructions.');
            return;
        }

        fs.writeFileSync(
            agentsMdPath,
            existing.trimEnd() + '\n\n' + AGENTS_MD_CONTENT,
        );
        console.log('  [AGENTS.md] Appended Latentgraph MCP instructions.');
    } else {
        fs.writeFileSync(agentsMdPath, AGENTS_MD_CONTENT);
        console.log('  [AGENTS.md] Created with Latentgraph MCP instructions.');
    }
}

export function createSteeringMd(projectRoot: string): void {
    const steeringDir = path.join(projectRoot, '.kiro', 'steering');
    if (!fs.existsSync(steeringDir)) {
        fs.mkdirSync(steeringDir, { recursive: true });
    }

    const steeringPath = path.join(steeringDir, 'lgraph.md');
    fs.writeFileSync(steeringPath, STEERING_FILE_CONTENT);
    console.log('  [.kiro/steering] Wrote lgraph.md with Latentgraph MCP instructions.');
}
