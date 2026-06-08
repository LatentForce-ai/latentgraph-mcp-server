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
## Latentgraph MCP Tools

This project has the **Latentgraph MCP server** (\`lgraph\`) configured with a pre-built dependency relationship graph (DRG) and CodeWiki-backed module documentation. Prefer these tools over searching or reading raw source files for indexed code — they answer common questions in one call instead of many.

### Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| \`get_project_overview\` | Top-level orientation. No params. | Cheap. Returns architecture_summary + top_level_modules[]. |
| \`get_module_info\` | Module overview, files, child modules. \`module_path\` required. | Rejects literal \`"project"\` — use \`get_project_overview\` instead. \`files_truncated: true\` past 50 files. |
| \`get_file\` | File metadata: summary, module_name, file_category, modification_impact, key_symbols[], exports, internal_imports, api_endpoints, storage_backends, constants. \`file_path\` required (leaf source only; extension case-folded). | No \`level\` param. |
| \`get_symbol\` | Name → fqn locator. \`name\` required; \`kind\`, \`file_prefix\`, \`limit\` optional. | Case-insensitive ranking: exact > prefix > substring. |
| \`get_call_chain\` | Walk callers/callees of an fqn. \`symbol\` required. \`direction\` ∈ callers/callees/both (default both). \`depth\` 1-5 default 2. | Rejects bare class identifiers (\`<file>::<ClassName>\` with no method) — use \`<Class>.__init__\` for instantiation or \`<Class>.<method>\`. Edges below confidence 0.6 filtered. Two empty states: \`unresolved: true\` (not indexed) vs \`unresolved: false\` + empty arrays (indexed but no edges in that direction). |
| \`get_dependencies\` | File-level edges. \`file_path\` required. | \`outgoing\` = what this file depends on; \`incoming\` = what depends on it (blast radius). Same file may appear twice when both explicit + implicit — dedupe by \`(target, implicit)\`. |
| \`get_pr_insights\` | Invariants (severity-ranked) + decisions (importance-ranked) recorded from PRs. \`target\` (file or module) required. \`limit_per_type\` 1-10 default 5. | Module targets aggregate insights from all member files. \`degraded: true\` when no knowledge OR unknown target. |
| \`ask_codebase\` | LLM-synthesized narrative answer with citations. \`question\` required; \`top_n\` 1-20 default 5; \`use_modules\` bool. | Rate-limited: 50 calls/min, 500/day per project. Cap at 1-2 per task. Returns \`confidence: high\\|low\`. |
| \`update_graph\` | Persist a session learning back into the graph (corrected summary, new implicit edge, doc update). | Returns \`applied: false\` + \`pending_edit_id\`. Write-only, owner approval required. 11 ops: edit_file_summary, edit_module_doc, edit_dependency_summary, add/delete dependency, add/delete dependent, add/edit/ignore/delete implicit_dependency. |

### Reading tool output (TOON format)

Read tools return their payload in a \`\`\`toon fenced block (\`update_graph\` returns plain prose). TOON is compact JSON-equivalent: \`key: value\` for scalars; \`array_name[N]{col1,col2,col3}:\` declares row count + column header, then rows stream tab-delimited. Read fields by column name, not by position. \`degraded: true\` means enrichment metadata is missing — skeleton fields (paths, symbols, edges) still work, summaries come back empty.

### Symbol fqn format

- Top-level: \`<file>::<name>\` (e.g. \`src/auth.py::login\`)
- Method: \`<file>::<Class>.<method>\` — dot between class and method, not \`::\`
- Legacy \`::\` shape accepted for back-compat.

### Operating Protocol

1. **Start of session / unfamiliar area**
   - Call \`get_project_overview()\` for orientation.
   - Call \`get_module_info(module_path='<module-name>')\` for a specific module.
   - Call \`get_file(file_path='<file-path>')\` for the specific files to edit.
   - Run independent MCP calls in parallel — they're cheap and don't depend on each other.

2. **Before reading any indexed source file**
   - Call \`get_file\` first.
   - Only use raw \`Read\` for implementation details the summary does not cover.

3. **Function-scope edit** (changing one function's behavior or signature)
   - \`get_file(<file>)\` → grab \`fqn\` from \`key_symbols\`.
   - \`get_call_chain(symbol=<fqn>, direction='callers')\` to see who breaks if the signature changes.
   - \`get_pr_insights(target=<file>)\` for invariants.
   - Edit.

4. **File-scope edit** (broader behavior change across a file)
   - \`get_file(<file>)\`.
   - \`get_dependencies(<file>)\` — \`incoming\` = blast radius; \`outgoing\` = what you rely on.
   - \`get_pr_insights(target=<file>)\`.
   - Edit.

5. **When debugging or tracing behavior**
   - Use \`get_call_chain(symbol='<fqn>')\` for symbol-level callers/callees.
   - Use \`get_dependencies\` for file-level imports and implicit coupling.
   - Use \`get_module_info\` when the bug spans multiple files in one subsystem.

6. **When answering architecture questions**
   - \`get_project_overview()\` → \`get_module_info(module_path='<module>')\` → \`get_file(file_path='<file>')\`.

7. **For non-source files**
   - Read them directly; do not call MCP tools on them.

### Supported file types

**Indexed (use MCP tools):** \`.js\` \`.jsx\` \`.ts\` \`.tsx\` \`.py\` \`.java\` \`.cpp\` \`.cs\` \`.go\` \`.c\` \`.h\` \`.css\` \`.scss\` \`.html\`

**NOT indexed (read directly):** \`.json\` \`.yaml\` \`.yml\` \`.toml\` \`.env\` \`.md\` \`.txt\` \`.pdf\` \`.png\` \`.lock\` \`.xml\` \`.csv\` and other non-source formats.

### Critical Rules

- Don't grep/glob as the first step for indexed source-file understanding — \`get_file\` is faster and denser.
- Don't answer module or architecture questions from a single raw file read.
- \`ask_codebase\` is rate-limited (50/min, 500/day per project). Cap at 1-2 per task.
- \`project_id\` and \`branch\` resolve from environment — don't pass them.

If MCP results look stale after major codebase changes, do a full Latentgraph re-scan with \`lgraph init --force\`.
<!-- end-lgraph-mcp-instructions -->`;

const STEERING_FILE_CONTENT = `# Latentgraph MCP Tools

This project has the **Latentgraph MCP server** (\`lgraph\`) configured with a pre-built dependency relationship graph (DRG) and CodeWiki-backed module documentation. Prefer these tools over searching or reading raw source files for indexed code — they answer common questions in one call instead of many.

## Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| \`get_project_overview\` | Top-level orientation. No params. | Cheap. Returns architecture_summary + top_level_modules[]. |
| \`get_module_info\` | Module overview, files, child modules. \`module_path\` required. | Rejects literal \`"project"\` — use \`get_project_overview\` instead. \`files_truncated: true\` past 50 files. |
| \`get_file\` | File metadata: summary, module_name, file_category, modification_impact, key_symbols[], exports, internal_imports, api_endpoints, storage_backends, constants. \`file_path\` required (leaf source only; extension case-folded). | No \`level\` param. |
| \`get_symbol\` | Name → fqn locator. \`name\` required; \`kind\`, \`file_prefix\`, \`limit\` optional. | Case-insensitive ranking: exact > prefix > substring. |
| \`get_call_chain\` | Walk callers/callees of an fqn. \`symbol\` required. \`direction\` ∈ callers/callees/both (default both). \`depth\` 1-5 default 2. | Rejects bare class identifiers (\`<file>::<ClassName>\` with no method) — use \`<Class>.__init__\` for instantiation or \`<Class>.<method>\`. Edges below confidence 0.6 filtered. Two empty states: \`unresolved: true\` (not indexed) vs \`unresolved: false\` + empty arrays (indexed but no edges in that direction). |
| \`get_dependencies\` | File-level edges. \`file_path\` required. | \`outgoing\` = what this file depends on; \`incoming\` = what depends on it (blast radius). Same file may appear twice when both explicit + implicit — dedupe by \`(target, implicit)\`. |
| \`get_pr_insights\` | Invariants (severity-ranked) + decisions (importance-ranked) recorded from PRs. \`target\` (file or module) required. \`limit_per_type\` 1-10 default 5. | Module targets aggregate insights from all member files. \`degraded: true\` when no knowledge OR unknown target. |
| \`ask_codebase\` | LLM-synthesized narrative answer with citations. \`question\` required; \`top_n\` 1-20 default 5; \`use_modules\` bool. | Rate-limited: 50 calls/min, 500/day per project. Cap at 1-2 per task. Returns \`confidence: high\\|low\`. |
| \`update_graph\` | Persist a session learning back into the graph (corrected summary, new implicit edge, doc update). | Returns \`applied: false\` + \`pending_edit_id\`. Write-only, owner approval required. 11 ops: edit_file_summary, edit_module_doc, edit_dependency_summary, add/delete dependency, add/delete dependent, add/edit/ignore/delete implicit_dependency. |

## Reading tool output (TOON format)

Read tools return their payload in a \`\`\`toon fenced block (\`update_graph\` returns plain prose). TOON is compact JSON-equivalent: \`key: value\` for scalars; \`array_name[N]{col1,col2,col3}:\` declares row count + column header, then rows stream tab-delimited. Read fields by column name, not by position. \`degraded: true\` means enrichment metadata is missing — skeleton fields (paths, symbols, edges) still work, summaries come back empty.

## Symbol fqn format

- Top-level: \`<file>::<name>\` (e.g. \`src/auth.py::login\`)
- Method: \`<file>::<Class>.<method>\` — dot between class and method, not \`::\`
- Legacy \`::\` shape accepted for back-compat.

## Operating Protocol

1. **Start of session / unfamiliar area**
   - Call \`get_project_overview()\` for orientation.
   - Call \`get_module_info(module_path='<module-name>')\` for a specific module.
   - Call \`get_file(file_path='<file-path>')\` for the specific files to edit.
   - Run independent MCP calls in parallel — they're cheap and don't depend on each other.

2. **Before reading any indexed source file**
   - Call \`get_file\` first.
   - Only use raw \`Read\` for implementation details the summary does not cover.

3. **Function-scope edit** (changing one function's behavior or signature)
   - \`get_file(<file>)\` → grab \`fqn\` from \`key_symbols\`.
   - \`get_call_chain(symbol=<fqn>, direction='callers')\` to see who breaks if the signature changes.
   - \`get_pr_insights(target=<file>)\` for invariants.
   - Edit.

4. **File-scope edit** (broader behavior change across a file)
   - \`get_file(<file>)\`.
   - \`get_dependencies(<file>)\` — \`incoming\` = blast radius; \`outgoing\` = what you rely on.
   - \`get_pr_insights(target=<file>)\`.
   - Edit.

5. **When debugging or tracing behavior**
   - Use \`get_call_chain(symbol='<fqn>')\` for symbol-level callers/callees.
   - Use \`get_dependencies\` for file-level imports and implicit coupling.
   - Use \`get_module_info\` when the bug spans multiple files in one subsystem.

6. **When answering architecture questions**
   - \`get_project_overview()\` → \`get_module_info(module_path='<module>')\` → \`get_file(file_path='<file>')\`.

7. **For non-source files**
   - Read them directly; do not call MCP tools on them.

## Supported file types

**Indexed (use MCP tools):** \`.js\` \`.jsx\` \`.ts\` \`.tsx\` \`.py\` \`.java\` \`.cpp\` \`.cs\` \`.go\` \`.c\` \`.h\` \`.css\` \`.scss\` \`.html\`

**NOT indexed (read directly):** \`.json\` \`.yaml\` \`.yml\` \`.toml\` \`.env\` \`.md\` \`.txt\` \`.pdf\` \`.png\` \`.lock\` \`.xml\` \`.csv\` and other non-source formats.

## Critical Rules

- Don't grep/glob as the first step for indexed source-file understanding — \`get_file\` is faster and denser.
- Don't answer module or architecture questions from a single raw file read.
- \`ask_codebase\` is rate-limited (50/min, 500/day per project). Cap at 1-2 per task.
- \`project_id\` and \`branch\` resolve from environment — don't pass them.

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
