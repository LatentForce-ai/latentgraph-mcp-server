import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from 'zod';
import { createRequire } from 'module';
import { getApiKey, getConfiguredUrls, getUserBranch } from './utils/config.js';
import { log } from "console";

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

function getBaseUrl(): string {
    console.error(getConfiguredUrls().api_url)
    return getConfiguredUrls().api_url;
}

function getApiKeyFromEnv(): string | null {
    return process.env.LGRAPH_API_KEY?.trim() || getApiKey();
}

function getProjectIdFromEnv(): string {
    const projectId = process.env.LGRAPH_PROJECT_ID;
    if (!projectId || projectId.trim() === "") {
        throw new Error(
            "LGRAPH_PROJECT_ID environment variable is not set. " +
            "Set it to your Latentgraph project UUID, or pass project_id in each tool call."
        );
    }
    return projectId.trim();
}

/** Resolve project_id: use tool arg if provided, else fall back to env. */
function resolveProjectId(args: { project_id?: string }): string {
    const fromArgs = args.project_id?.trim();
    if (fromArgs) return fromArgs;
    return getProjectIdFromEnv();
}

/** Normalize file paths: backslash → forward slash, strip leading ./ and / */
function normalizePath(filePath: string): string {
    let p = filePath.replace(/\\/g, '/');
    p = p.replace(/^\.\//, '');
    p = p.replace(/^\//, '');
    return p;
}

function getPublicToken(): string | null {
    return process.env.LGRAPH_PUBLIC_TOKEN?.trim() || null;
}

function getBranchFromEnv(): string | null {
    // Prefer env var, then fall back to config file (which reads user_branch or default_branch)
    const envBranch = process.env.LGRAPH_BRANCH?.trim();
    const configBranch = getUserBranch();
    return envBranch || configBranch || null;
}

/** Resolve branch: use tool arg if provided, else fall back to env/config. Throws if no branch found. */
function resolveBranch(args: { branch?: string }): string {
    const fromArgs = args.branch?.trim();
    if (fromArgs) return fromArgs;
    const fromEnv = getBranchFromEnv();
    if (fromEnv) return fromEnv;
    throw new Error(
        "Branch not configured. Add 'default_branch' to .lgraph/config.json or re-run 'lgraph init'."
    );
}

function getAuthHeaders(): Record<string, string> {
    const apiKey = getApiKeyFromEnv();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    return headers;
}

function handleApiError(response: Response, text: string): never {
    if (response.status === 404) {
        if (text.includes('Knowledge graph not found') || text.includes('knowledge graph')) {
            throw new Error(
                "No knowledge graph exists for this project. Run a full project scan (init-scan) to build it."
            );
        }
        if (text.includes('File not found') || text.includes('not found in')) {
            const pathMatch = text.match(/['"]([^'"]+)['"]/);
            const filePath = pathMatch ? pathMatch[1] : 'the requested file';
            throw new Error(
                `File '${filePath}' not found in knowledge graph. Possible causes:\n` +
                `  1. The path may be incorrect (check casing and slashes)\n` +
                `  2. The file was added after the last full project scan\n` +
                `  3. The file type is not one of the indexed source-file types`
            );
        }
        if (text.includes('No module tree') || text.includes('module tree')) {
            throw new Error(
                "No module tree exists for this project. Run the Wiki indexing step to build it."
            );
        }
    }
    throw new Error(`API call failed: ${response.status} ${response.statusText}${text ? ` - ${text}` : ""}`);
}

function truncateText(text: string, maxChars: number): string {
    if (!text || text.length <= maxChars) return text;
    return `${text.slice(0, maxChars).trimEnd()}...`;
}

/** POST to backend API */
async function callBackendAPI(endpoint: string, data: Record<string, unknown>): Promise<any> {
 
    const response = await fetch(`${getBaseUrl()}${endpoint}`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(data),
    });

    if (!response.ok) {
        const text = await response.text();
        handleApiError(response, text);
    }

    return await response.json();
}

/** Get MCP-specific headers for edit requests */
function getMcpEditHeaders(): Record<string, string> {
    const headers = getAuthHeaders();
    headers['X-MCP-Source'] = 'true';
    // User ID will be determined from the API key on the backend
    return headers;
}

/** PUT to backend API for MCP edit (always queued for approval) */
async function callMcpEditPut(endpoint: string, data: Record<string, unknown>): Promise<any> {
    const response = await fetch(`${getBaseUrl()}${endpoint}`, {
        method: 'PUT',
        headers: getMcpEditHeaders(),
        body: JSON.stringify(data),
    });

    if (!response.ok) {
        const text = await response.text();
        handleApiError(response, text);
    }

    return await response.json();
}

/** POST to backend API for MCP edit (always queued for approval) */
async function callMcpEditPost(endpoint: string, data: Record<string, unknown>): Promise<any> {
    const response = await fetch(`${getBaseUrl()}${endpoint}`, {
        method: 'POST',
        headers: getMcpEditHeaders(),
        body: JSON.stringify(data),
    });

    if (!response.ok) {
        const text = await response.text();
        handleApiError(response, text);
    }

    return await response.json();
}

/** DELETE to backend API for MCP edit (always queued for approval) */
async function callMcpEditDelete(endpoint: string, data: Record<string, unknown>): Promise<any> {
    const response = await fetch(`${getBaseUrl()}${endpoint}`, {
        method: 'DELETE',
        headers: getMcpEditHeaders(),
        body: JSON.stringify(data),
    });

    if (!response.ok) {
        const text = await response.text();
        handleApiError(response, text);
    }

    return await response.json();
}

/** Format edit result for MCP response */
function formatEditResult(data: any, operation: string): string {
    const lines: string[] = [];

    if (data.applied) {
        lines.push(`✅ ${operation} applied successfully.`);
    } else if (data.pending_edit_id) {
        lines.push(`📋 ${operation} submitted for approval.`);
        lines.push(`**Edit ID:** ${data.pending_edit_id}`);
        lines.push('');
        lines.push('The edit has been queued and requires owner approval before being applied.');
    }

    if (data.message) {
        lines.push(`**Status:** ${data.message}`);
    }

    return lines.join('\n');
}

/** POST to a public (no-auth) project endpoint: /api/public/{token}/{endpoint} */
async function callPublicAPIPost(token: string, endpoint: string, data: Record<string, unknown>): Promise<any> {
    const url = `${getBaseUrl()}/api/public/${encodeURIComponent(token)}/${endpoint}`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });

    if (!response.ok) {
        const text = await response.text();
        if (response.status === 404) throw new Error(`Not found: ${text || endpoint}`);
        if (response.status === 403) throw new Error(`Access denied: ${text}`);
        if (response.status === 410) throw new Error('This public share link has expired.');
        throw new Error(`Public API call failed: ${response.status} - ${text}`);
    }

    return await response.json();
}

// ============= FORMATTERS =============

function formatChainEdges(edges: any[], indent: string): string[] {
    const out: string[] = [];
    if (!Array.isArray(edges) || edges.length === 0) return out;
    for (const e of edges) {
        const sym = e?.symbol || '';
        if (!sym) continue;
        const file = e.file ? ` — ${e.file}` : '';
        const score = (e.score ?? 0).toFixed(1);
        const conf = (e.confidence ?? 0).toFixed(2);
        const kind = e.kind ? `${e.kind} ` : '';
        out.push(`${indent}- ${kind}\`${sym}\`${file} — score ${score}, conf ${conf}`);
    }
    return out;
}

/** Format file_summary response as readable markdown */
function formatFileSummary(data: any): string {
    const lines: string[] = [];
    lines.push(`## File: ${data.path}`);

    if (data.module_name) {
        lines.push(`**Module:** ${data.module_name}`);
    }

    lines.push('');
    lines.push('### Summary');
    lines.push(data.summary || 'No summary available.');

    if (data.modification_impact) {
        lines.push('');
        lines.push('### Modification Impact');
        lines.push(data.modification_impact);
    }

    if (data.file_category) {
        lines.push('');
        lines.push(`**Category:** ${data.file_category}${data.execution_context ? ` | **Context:** ${data.execution_context}` : ''}`);
    }

    if (data.exports?.length > 0) {
        lines.push('');
        lines.push('### Exports');
        for (const exp of data.exports) {
            if (typeof exp === 'object' && exp !== null) {
                const name = exp.name || '';
                const kind = exp.kind ? ` *(${exp.kind})*` : '';
                const summary = exp.summary ? `: ${exp.summary}` : '';
                lines.push(`- **${name}**${kind}${summary}`);
                if (exp.key_methods?.length > 0) {
                    const methodNames = exp.key_methods.map((m: any) =>
                        typeof m === 'string' ? m : (m.name || m.signature || '')
                    ).filter(Boolean);
                    if (methodNames.length > 0) lines.push(`  - Methods: ${methodNames.join(', ')}`);
                }
            }
        }
    }

    if (data.key_symbols?.length > 0) {
        lines.push('');
        lines.push(`### Key Symbols (${data.key_symbols.length})`);
        for (const sym of data.key_symbols) {
            if (typeof sym !== 'object' || sym === null) continue;
            const name = sym.name || '';
            const kind = sym.kind || 'symbol';
            const parentChain: string[] = Array.isArray(sym.parent_chain) ? sym.parent_chain : [];
            const parent = parentChain.length > 0 ? `${parentChain.join('.')}.` : '';
            const sig = sym.signature || `${parent}${name}`;
            const asyncFlag = sym.is_async ? ' *(async)*' : '';
            const visibility = sym.visibility && sym.visibility !== 'public' ? ` *(${sym.visibility})*` : '';
            const span = Array.isArray(sym.span) && sym.span.length === 2 ? ` [L${sym.span[0]}-${sym.span[1]}]` : '';
            lines.push(`- **[${kind}]** \`${sig}\`${asyncFlag}${visibility}${span}`);
            const decorators: string[] = Array.isArray(sym.decorators) ? sym.decorators : [];
            if (decorators.length > 0) lines.push(`  - Decorators: ${decorators.join(', ')}`);
            if (sym.docstring) lines.push(`  - ${truncateText(String(sym.docstring), 200)}`);
        }
    }

    const keyChains: Record<string, { callers?: any[]; callees?: any[] }> = data.key_symbols_chains || {};
    const chainKeys = Object.keys(keyChains);
    if (chainKeys.length > 0) {
        lines.push('');
        lines.push(`### Top symbol call chains (depth 1)`);
        for (const sid of chainKeys) {
            const chain = keyChains[sid] || {};
            const callers = chain.callers || [];
            const callees = chain.callees || [];
            if (callers.length === 0 && callees.length === 0) continue;
            lines.push(`- **${sid}**`);
            if (callers.length > 0) {
                lines.push(`  - Callers (top ${callers.length}):`);
                lines.push(...formatChainEdges(callers, '    '));
            }
            if (callees.length > 0) {
                lines.push(`  - Callees (top ${callees.length}):`);
                lines.push(...formatChainEdges(callees, '    '));
            }
        }
    }

    if (data.internal_imports?.length > 0) {
        lines.push('');
        lines.push(`### Internal Imports (${data.internal_imports.length})`);
        for (const imp of data.internal_imports) {
            if (typeof imp === 'object' && imp !== null) {
                const name = imp.name || '(unnamed)';
                const fromPath = imp.from_path ? ` ← ${imp.from_path}` : '';
                const kind = imp.kind ? ` (${imp.kind})` : '';
                const relative = imp.is_relative ? ' *(relative)*' : '';
                lines.push(`- ${name}${kind}${fromPath}${relative}`);
            } else if (typeof imp === 'string' && imp.trim()) {
                lines.push(`- ${imp.trim()}`);
            }
        }
    }

    if (data.api_endpoints?.length > 0) {
        lines.push('');
        lines.push(`### API Endpoints (${data.api_endpoints.length})`);
        for (const ep of data.api_endpoints) {
            const method = ep.method || '';
            const path = ep.path || '';
            const handler = ep.handler_name ? ` → \`${ep.handler_name}\`` : '';
            const framework = ep.framework ? ` *(${ep.framework})*` : '';
            lines.push(`- \`${method} ${path}\`${handler}${framework}`);
        }
    }

    if (data.storage_backends?.length > 0) {
        lines.push('');
        lines.push(`### Storage Backends (${data.storage_backends.length})`);
        for (const sb of data.storage_backends) {
            const type = sb.type || '';
            const hint = sb.hint ? ` — \`${sb.hint}\`` : '';
            lines.push(`- **${type}**${hint}`);
        }
    }

    if (data.constants?.length > 0) {
        lines.push('');
        lines.push(`### Constants (${data.constants.length})`);
        for (const c of data.constants) {
            const name = c.name || '';
            const value = c.value_preview ? ` = ${c.value_preview}` : '';
            lines.push(`- \`${name}\`${value}`);
        }
    }

    const symbolEdgesCount = data.symbol_edges_count || 0;
    const symbolEdgesPreview: any[] = data.symbol_edges_preview || [];
    if (symbolEdgesCount > 0) {
        lines.push('');
        lines.push(`### Symbol Edges (${symbolEdgesCount})`);
        for (const edge of symbolEdgesPreview) {
            const kind = edge.kind || '';
            const from = edge.from_symbol || '';
            const to = edge.to_symbol || '';
            const toFile = edge.to_file ? ` *(in ${edge.to_file})*` : '';
            lines.push(`- **${kind}**: \`${from}\` → \`${to}\`${toFile}`);
        }
        if (symbolEdgesCount > symbolEdgesPreview.length) {
            lines.push(`- ... ${symbolEdgesCount - symbolEdgesPreview.length} more not shown`);
        }
    }

    if (data.dependencies?.length > 0) {
        lines.push('');
        lines.push(`### Dependencies (${data.dependencies.length} imports)`);
        for (const dep of data.dependencies) {
            lines.push(`- ${dep}`);
        }
    }

    if (data.dependents?.length > 0) {
        lines.push('');
        lines.push(`### Dependents (${data.dependents.length} files depend on this)`);
        for (const dep of data.dependents) {
            const depPath = typeof dep === 'string' ? dep : (dep?.path || '');
            const depTypes: string[] = Array.isArray(dep?.type) ? dep.type : [];
            const typeLabel = depTypes.length > 0 ? ` [${depTypes.join(', ')}]` : '';
            lines.push(`- ${depPath}${typeLabel}`);
        }
    }

    const implicitCount = data.implicit_dependencies_count || 0;
    const implicitPreview = data.implicit_dependencies_preview || [];
    if (implicitCount > 0) {
        lines.push('');
        lines.push(`### Implicit Dependencies (${implicitCount})`);
        for (const dep of implicitPreview) {
            const depTypes = dep?.dependency_types ? ` [${dep.dependency_types}]` : '';
            const strength = dep?.strength ? ` [${dep.strength}]` : '';
            const relation = dep?.coupling_type ? `: ${dep.coupling_type}` : '';
            const summary = dep?.edge_summary ? ` — ${dep.edge_summary}` : '';
            lines.push(`- **${dep.path}**${depTypes}${strength}${relation}${summary}`);
        }
        if (implicitCount > implicitPreview.length) {
            lines.push(`- ... ${implicitCount - implicitPreview.length} more not shown`);
        }
    }

    if (data.module_context?.length > 0) {
        lines.push('');
        lines.push('### Module Context');
        for (const parent of data.module_context) {
            lines.push(`- **${parent.path}**: ${parent.summary}`);
        }
    }

    // AI Learnings section
    if (data.learnings?.length > 0) {
        lines.push('');
        lines.push('### AI Learnings');
        for (const learning of data.learnings) {
            lines.push(`- ${learning}`);
        }
    }

    if (data.dependency_learnings?.length > 0) {
        lines.push('');
        lines.push('### Dependency Learnings');
        for (const learning of data.dependency_learnings) {
            lines.push(`- ${learning}`);
        }
    }

    return lines.join('\n');
}

/** Format dependency response as readable markdown */
function formatDependencies(data: any): string {
    const lines: string[] = [];
    const deps: string[] = data.dependencies || [];
    // edge_details is a dict of {imports, dependency_types, edge_summary,
    // why_this_dependency, usage_pattern, data_flow, change_impact, implicit}
    const edgeDetails: Record<string, any> = data.edge_details || {};
    const symbolEdgesByDep: Record<string, any[]> = data.symbol_edges_by_dep || {};

    // Returns ["explicit"], ["implicit"], or ["explicit","implicit"] for the
    // edge to `dep`. Falls back to deriving from the legacy `implicit` flag
    // when `dependency_types` is absent (older indexed projects).
    const kindsOf = (dep: string): string[] => {
        const edge = edgeDetails[dep] || {};
        if (Array.isArray(edge.dependency_types) && edge.dependency_types.length > 0) {
            return edge.dependency_types;
        }
        return edge.implicit ? ['implicit'] : ['explicit'];
    };

    // Prefer pre-segregated lists from the backend; fall back to deriving
    // them from `dependencies` + edge metadata when the backend is older
    // than the explicit/implicit split.
    const explicitDeps: string[] = Array.isArray(data.explicit_dependencies)
        ? data.explicit_dependencies
        : deps.filter((d) => kindsOf(d).includes('explicit'));
    const implicitDeps: string[] = Array.isArray(data.implicit_dependencies)
        ? data.implicit_dependencies
        : deps.filter((d) => kindsOf(d).includes('implicit'));

    lines.push(`## Dependencies: ${data.path}`);
    if (data.module_name) {
        lines.push(`**Module:** ${data.module_name}`);
    }
    lines.push('');

    // Renders one dep entry with all its metadata. Same for both groups.
    const renderDep = (dep: string) => {
        const edge = edgeDetails[dep] || {};
        const types = kindsOf(dep);
        const mixed = types.length > 1; // file has BOTH an import + runtime coupling to this target
        const tag = mixed ? ' [mixed: explicit + implicit]' : '';
        lines.push(`- **${dep}**${tag}`);
        if (edge.relationship) lines.push(`  - Relationship: ${edge.relationship}`);
        if (edge.imports?.length > 0) lines.push(`  - Imports: ${edge.imports.join(', ')}`);
        if (edge.strength) lines.push(`  - Strength: ${edge.strength}`);
        if (edge.edge_summary || edge.dependency_summary) {
            lines.push(`  - Summary: ${edge.edge_summary || edge.dependency_summary}`);
        }
        const symEdges = symbolEdgesByDep[dep] || [];
        if (symEdges.length > 0) {
            lines.push(`  - Symbol edges (${symEdges.length}):`);
            for (const se of symEdges.slice(0, 10)) {
                lines.push(`    - **${se.kind}**: \`${se.from_symbol}\` → \`${se.to_symbol}\``);
                const callers: any[] = Array.isArray(se.callers_top3) ? se.callers_top3 : [];
                if (callers.length > 0) {
                    lines.push(`      - Other callers of \`${se.to_symbol}\`:`);
                    lines.push(...formatChainEdges(callers, '        '));
                }
            }
            if (symEdges.length > 10) {
                lines.push(`    - ... ${symEdges.length - 10} more not shown`);
            }
        }
    };

    if (deps.length === 0) {
        lines.push('This file has no dependencies.');
    } else {
        lines.push(`### Explicit dependencies (${explicitDeps.length}) — direct imports / static references`);
        if (explicitDeps.length === 0) {
            lines.push('_None._');
        } else {
            for (const dep of explicitDeps) renderDep(dep);
        }
        lines.push('');
        lines.push(`### Implicit dependencies (${implicitDeps.length}) — runtime coupling (Redis / events / shared config / cross-service calls)`);
        if (implicitDeps.length === 0) {
            lines.push('_None._');
        } else {
            for (const dep of implicitDeps) renderDep(dep);
        }
    }

    // --- Reverse dependencies ---
    const dependents: any[] = data.dependents || [];
    const dependentEdgeDetails: Record<string, any> = data.dependent_edge_details || {};

    // dependents may be either ["path", ...] (newer backend) or
    // [{path, type}, ...] (older backend); normalise to paths AND capture
    // the per-entry `type` array on the way through so we can use it when
    // the backend hasn't populated `dependent_edge_details`.
    const dependentPaths: string[] = [];
    const dependentTypeMap: Record<string, string[]> = {};
    for (const d of dependents) {
        const p = typeof d === 'string' ? d : (d?.path || '');
        if (!p) continue;
        dependentPaths.push(p);
        if (typeof d === 'object' && Array.isArray(d?.type) && d.type.length > 0) {
            dependentTypeMap[p] = d.type;
        }
    }

    const dependentKindsOf = (path: string): string[] => {
        // Priority 1 — current backend: dependency_types on the edge detail.
        const edge = dependentEdgeDetails[path] || {};
        if (Array.isArray(edge.dependency_types) && edge.dependency_types.length > 0) {
            return edge.dependency_types;
        }
        // Priority 2 — older backend: `type` array on the dependents entry
        // itself. Without this, an old deployment classifies everything as
        // explicit and silently loses the implicit signal in the rendering.
        if (dependentTypeMap[path]) {
            return dependentTypeMap[path];
        }
        // Priority 3 — very old backend: legacy `implicit: bool` flag.
        return edge.implicit ? ['implicit'] : ['explicit'];
    };

    const explicitDependents: string[] = Array.isArray(data.explicit_dependents)
        ? data.explicit_dependents
        : dependentPaths.filter((p) => dependentKindsOf(p).includes('explicit'));
    const implicitDependents: string[] = Array.isArray(data.implicit_dependents)
        ? data.implicit_dependents
        : dependentPaths.filter((p) => dependentKindsOf(p).includes('implicit'));

    if (dependentPaths.length > 0) {
        lines.push('');
        lines.push(`### Dependents (${dependentPaths.length} file(s) that depend on this file)`);
        lines.push('');
        lines.push(`#### Explicit dependents (${explicitDependents.length})`);
        if (explicitDependents.length === 0) {
            lines.push('_None._');
        } else {
            for (const p of explicitDependents) {
                const types = dependentKindsOf(p);
                const tag = types.length > 1 ? ' [mixed: explicit + implicit]' : '';
                lines.push(`- **${p}**${tag}`);
            }
        }
        lines.push('');
        lines.push(`#### Implicit dependents (${implicitDependents.length})`);
        if (implicitDependents.length === 0) {
            lines.push('_None._');
        } else {
            for (const p of implicitDependents) {
                const types = dependentKindsOf(p);
                const tag = types.length > 1 ? ' [mixed: explicit + implicit]' : '';
                lines.push(`- **${p}**${tag}`);
            }
        }
    }

    // AI Learnings section
    if (data.dependency_learnings?.length > 0) {
        lines.push('');
        lines.push('### Dependency Learnings');
        for (const learning of data.dependency_learnings) {
            lines.push(`- ${learning}`);
        }
    }

    if (data.implicit_learnings?.length > 0) {
        lines.push('');
        lines.push('### Implicit Dependency Learnings');
        for (const learning of data.implicit_learnings) {
            lines.push(`- ${learning}`);
        }
    }

    return lines.join('\n');
}

/** Format blast_radius response as readable markdown */
function formatBlastRadius(data: any): string {
    const lines: string[] = [];

    if (data.target_type === 'symbol') {
        const affectedSymbols: any[] = data.affected_symbols || [];
        const fileRollup: any[] = data.affected_files || [];
        const total: number = data.affected_symbols_total ?? affectedSymbols.length;
        lines.push(`## Change Impact (symbol-level): ${data.path}`);
        lines.push(`**Affected symbols:** ${total} across ${fileRollup.length} file(s) (max depth ${data.blast_radius_level})`);
        lines.push('');
        if (affectedSymbols.length === 0) {
            lines.push('No other symbols call into this symbol.');
            return lines.join('\n');
        }
        if (fileRollup.length > 0) {
            lines.push('### Affected files (rollup)');
            for (const f of fileRollup) {
                const sc = f.affected_symbols_count != null ? ` — ${f.affected_symbols_count} symbol(s)` : '';
                const kinds = f.edge_kinds?.length > 0 ? ` [${f.edge_kinds.join(', ')}]` : '';
                lines.push(`- **${f.path}** (L${f.level})${sc}${kinds}`);
                if (f.summary) lines.push(`  - ${f.summary}`);
            }
            lines.push('');
        }
        lines.push('### Affected symbols (per call site)');
        const byLevel: Record<number, any[]> = {};
        for (const s of affectedSymbols) {
            const lvl = s.level || 1;
            if (!byLevel[lvl]) byLevel[lvl] = [];
            byLevel[lvl].push(s);
        }
        const levels = Object.keys(byLevel).map(Number).sort((a, b) => a - b);
        for (const lvl of levels) {
            lines.push(`#### Level ${lvl} (${byLevel[lvl].length})`);
            for (const s of byLevel[lvl]) {
                lines.push(`- **[${s.kind}]** \`${s.from_symbol}\``);
                if (s.from_file) lines.push(`  - in ${s.from_file}`);
                const callees: any[] = Array.isArray(s.callees_top3) ? s.callees_top3 : [];
                if (callees.length > 0) {
                    lines.push(`  - What \`${s.from_symbol}\` calls next:`);
                    lines.push(...formatChainEdges(callees, '    '));
                }
            }
            lines.push('');
        }
        return lines.join('\n');
    }

    const affected: any[] = data.affected_files || [];

    lines.push(`## Blast Radius: ${data.path}`);

    if (data.module_name) {
        lines.push(`**Module:** ${data.module_name}`);
    }

    lines.push('');

    // Split into explicit-only, implicit-only, and mixed using dependency_types when available
    function classifyFile(f: any): 'explicit' | 'implicit' | 'mixed' {
        const types: string[] = Array.isArray(f.dependency_types) ? f.dependency_types : [];
        const hasExplicit = types.includes('explicit');
        const hasImplicit = types.includes('implicit');
        if (hasExplicit && hasImplicit) return 'mixed';
        if (hasImplicit) return 'implicit';
        // Fall back to is_implicit for older schema
        if (!hasExplicit && f.is_implicit) return 'implicit';
        return 'explicit';
    }

    const explicitFiles = affected.filter((f: any) => classifyFile(f) === 'explicit');
    const implicitFiles = affected.filter((f: any) => classifyFile(f) === 'implicit');
    const mixedFiles = affected.filter((f: any) => classifyFile(f) === 'mixed');

    if (explicitFiles.length === 0 && implicitFiles.length === 0 && mixedFiles.length === 0) {
        lines.push('No other files are affected by changes to this file.');
    } else {
        const totalCount = affected.length;
        lines.push(`**${totalCount}** file(s) would be affected (${explicitFiles.length} explicit, ${implicitFiles.length} implicit, ${mixedFiles.length} mixed):`);
        lines.push('');

        // --- Explicit files grouped by level (backend only sends levels 1-3) ---
        if (explicitFiles.length > 0) {
            const byLevel: Record<number, any[]> = {};
            for (const file of explicitFiles) {
                const level = file.level || 1;
                if (!byLevel[level]) byLevel[level] = [];
                byLevel[level].push(file);
            }
            const levels = Object.keys(byLevel).map(Number).sort((a, b) => a - b);
            for (const level of levels) {
                lines.push(`### ${level === 1 ? 'Level 1 (direct)' : `Level ${level}`}`);
                for (const file of byLevel[level]) {
                    lines.push(`- **${file.path}**: ${file.summary || 'No summary'}`);
                }
                lines.push('');
            }
        }

        // --- Mixed files (explicit + implicit) grouped by level ---
        if (mixedFiles.length > 0) {
            const byLevel: Record<number, any[]> = {};
            for (const file of mixedFiles) {
                const level = file.level || 1;
                if (!byLevel[level]) byLevel[level] = [];
                byLevel[level].push(file);
            }
            const mixedLevels = Object.keys(byLevel).map(Number).sort((a, b) => a - b);
            for (const level of mixedLevels) {
                const label = level === 1 ? 'Mixed Level 1 (direct, explicit + implicit)' : `Mixed Level ${level} (explicit + implicit)`;
                lines.push(`### ${label}`);
                for (const file of byLevel[level]) {
                    const s = file.coupling_strength;
                    const tag = s ? ` [${s}]` : '';
                    lines.push(`- **${file.path}**${tag}: ${file.summary || 'No summary'}`);
                }
                lines.push('');
            }
        }

        // --- Implicit-only files grouped by level, then by coupling strength within each level ---
        if (implicitFiles.length > 0) {
            const strengthOrder = ['tight', 'moderate', 'loose', 'unknown'];
            const byLevel: Record<number, any[]> = {};
            for (const file of implicitFiles) {
                const level = file.level || 1;
                if (!byLevel[level]) byLevel[level] = [];
                byLevel[level].push(file);
            }
            const implicitLevels = Object.keys(byLevel).map(Number).sort((a, b) => a - b);
            for (const level of implicitLevels) {
                const label = level === 1 ? 'Implicit Level 1 (direct)' : `Implicit Level ${level}`;
                lines.push(`### ${label}`);
                const byStrength: Record<string, any[]> = {};
                for (const file of byLevel[level]) {
                    const s = file.coupling_strength || 'unknown';
                    if (!byStrength[s]) byStrength[s] = [];
                    byStrength[s].push(file);
                }
                for (const strength of strengthOrder) {
                    const group = byStrength[strength];
                    if (!group || group.length === 0) continue;
                    for (const file of group) {
                        lines.push(`- **${file.path}** [${strength}]: ${file.summary || 'No summary'}`);
                    }
                }
                lines.push('');
            }
        }

        // --- Deep files (level 4+) — backend sends these pre-grouped by module ---
        const deepModules: any[] = data.deep_affected_modules || [];
        if (deepModules.length > 0) {
            const deepFileCount = deepModules.reduce((sum: number, m: any) => sum + (m.file_count || 0), 0);
            lines.push(`### Level 4+ (${deepFileCount} files — modules only)`);
            for (const m of deepModules) {
                const count = m.file_count || 0;
                lines.push(`- **${m.module}** (${count} file${count !== 1 ? 's' : ''})`);
            }
            lines.push('');
        }
    }

    // --- Affected clusters ---
    const clusters: any[] = data.cluster_blast_radius || [];
    if (clusters.length > 0) {
        lines.push('### Affected Modules/Folders');
        for (const cluster of clusters) {
            lines.push(`- **${cluster.path}**: ${cluster.summary}`);
        }
    }

    return lines.join('\n');
}

/** Format project_overview response as readable markdown */
function formatKnowledge(data: any): string {
    const lines: string[] = [];
    const target = data.target || '';
    const targetType = data.target_type || 'file';
    lines.push(`## Knowledge: ${target}`);
    if (targetType === 'file_via_module') {
        const owning = (data.matched_modules || [])[0] || 'parent module';
        lines.push(`**Target type:** file (no file-specific knowledge — showing owning module \`${owning}\`)`);
    } else {
        lines.push(`**Target type:** ${targetType}`);
    }

    const matchedModules: string[] = data.matched_modules || [];
    if (matchedModules.length > 0 && targetType !== 'file_via_module') {
        lines.push(`**Matched modules:** ${matchedModules.join(', ')}`);
    }

    const grounded: string[] = data.grounded_in || [];
    if (grounded.length > 0) {
        lines.push(`**Grounded in:** ${grounded.join(', ')}`);
    }

    const invariants: any[] = data.invariants || [];
    const decisions: any[] = data.decisions || [];

    if (invariants.length === 0 && decisions.length === 0) {
        lines.push('');
        lines.push('No knowledge available for this target.');
        return lines.join('\n');
    }

    if (invariants.length > 0) {
        lines.push('');
        lines.push(`### Invariants (${invariants.length})`);
        for (const inv of invariants) {
            const severity = inv.severity ? ` [${inv.severity}]` : '';
            lines.push(`- **${inv.rule || ''}**${severity}`);
            if (inv.why) lines.push(`  - Why: ${inv.why}`);
            if (inv.consequence) lines.push(`  - Consequence: ${inv.consequence}`);
            if (inv.grounded_in?.length > 0) lines.push(`  - PRs: ${inv.grounded_in.join(', ')}`);
        }
    }

    if (decisions.length > 0) {
        lines.push('');
        lines.push(`### Design Decisions (${decisions.length})`);
        for (const dec of decisions) {
            const importance = dec.importance ? ` [${dec.importance}]` : '';
            const tag = dec.tag ? ` *(${dec.tag})*` : '';
            lines.push(`- **${dec.title || ''}**${importance}${tag}`);
            if (dec.rationale) lines.push(`  - Rationale: ${dec.rationale}`);
            if (dec.tradeoffs) lines.push(`  - Tradeoffs: ${dec.tradeoffs}`);
            if (dec.grounded_in?.length > 0) lines.push(`  - PRs: ${dec.grounded_in.join(', ')}`);
        }
    }

    return lines.join('\n');
}

function formatCoupling(data: any): string {
    const lines: string[] = [];
    const partners: any[] = data.partners || [];
    const source = data.source || 'pr_history';
    lines.push(`## Coupling Partners: ${data.file_path || ''}`);
    lines.push(`**Total partners:** ${data.total_partners ?? partners.length} | **Source:** ${source}`);
    lines.push('');

    if (partners.length === 0) {
        lines.push('No co-changing partners found in PR history, and no structural neighbors detected.');
        return lines.join('\n');
    }

    if (source === 'structural_fallback') {
        lines.push(`### Structural neighbors (${partners.length}) — no PR co-change history available`);
        for (const p of partners) {
            lines.push(`- **${p.file}** [${p.type}]`);
            if (p.edge_summary) lines.push(`  - ${p.edge_summary}`);
        }
        return lines.join('\n');
    }

    lines.push(`### Top ${partners.length} partners (by composite score)`);
    for (const p of partners) {
        const score = (p.score ?? 0).toFixed(3);
        const typeLabel = p.type ? ` [${p.type}]` : '';
        lines.push(`- **${p.file}** — score ${score}${typeLabel}`);
        const measures = `LC=${(p.lc ?? 0).toFixed(2)} CC=${(p.cc ?? 0).toFixed(2)} IC=${(p.ic ?? 0).toFixed(2)} TC=${(p.tc ?? 0).toFixed(2)}`;
        lines.push(`  - ${measures}`);
        if (p.edge_summary) lines.push(`  - ${p.edge_summary}`);
    }

    return lines.join('\n');
}

function formatPath(data: any): string {
    const lines: string[] = [];
    lines.push(`## Path: ${data.source} → ${data.target}`);

    if (!data.connected) {
        lines.push('');
        lines.push('No dependency path found between these files.');
        return lines.join('\n');
    }

    const hops: any[] = data.path || [];
    lines.push(`**Hops:** ${hops.length}`);
    if (data.has_implicit_hop) lines.push('**Includes implicit coupling hop.**');
    lines.push('');

    if (hops.length === 0) {
        lines.push('Source and target are the same file.');
        return lines.join('\n');
    }

    for (let i = 0; i < hops.length; i++) {
        const h = hops[i];
        const arrow = h.type === 'implicit' ? '⇢' : '→';
        const mech = h.coupling_mechanism ? ` [${h.coupling_mechanism}${h.strength ? ` ${h.strength}` : ''}]` : '';
        lines.push(`${i + 1}. **${h.from_path}** ${arrow} **${h.to_path}**${mech}`);
        if (h.summary) lines.push(`   - ${h.summary}`);
    }

    return lines.join('\n');
}

function formatCallChain(data: any): string {
    const lines: string[] = [];
    const callers: any[] = data.callers || [];
    const callees: any[] = data.callees || [];
    const stats = data.stats || {};
    const warnings: any[] = data.warnings || [];

    lines.push(`## Call Chain: ${data.symbol}`);
    lines.push(`**Direction:** ${data.direction} | **Depth:** ${data.depth} | **fan_in:** ${stats.fan_in ?? 0} | **fan_out:** ${stats.fan_out ?? 0} | **score:** ${(stats.score ?? 0).toFixed(2)}`);
    if (data.truncated) lines.push('**Truncated:** results capped — narrow the query (lower depth, higher min_confidence, or kinds filter) to see more.');
    lines.push('');

    if (warnings.length > 0) {
        lines.push('### ⚠ Warnings');
        for (const w of warnings) {
            const extra = w.callers && w.callers.length ? ` — ${w.callers.slice(0, 3).join(', ')}` : '';
            lines.push(`- **${w.type}**: ${w.message}${extra}`);
        }
        lines.push('');
    }

    const renderEdges = (edges: any[], header: string, otherSide: 'from_symbol' | 'to_symbol') => {
        if (edges.length === 0) return;
        lines.push(`### ${header} (${edges.length})`);
        // Group by level for readability.
        const byLevel: Record<number, any[]> = {};
        for (const e of edges) {
            const lv = e.level ?? 1;
            (byLevel[lv] ||= []).push(e);
        }
        const levels = Object.keys(byLevel).map(Number).sort((a, b) => a - b);
        for (const lv of levels) {
            lines.push(`**Level ${lv}** (${byLevel[lv].length} edges)`);
            for (const e of byLevel[lv]) {
                const peer = e[otherSide] || '';
                const conf = (e.confidence ?? 0).toFixed(2);
                lines.push(`- **${peer}** — ${e.kind}/${e.resolution} ${conf}`);
                lines.push(`  - ${e.from_file || '?'}`);
                if (e.candidates && e.candidates.length) {
                    lines.push(`  - candidates: ${e.candidates.slice(0, 3).join(', ')}${e.candidates.length > 3 ? ` (+${e.candidates.length - 3})` : ''}`);
                }
            }
        }
        lines.push('');
    };

    renderEdges(callers, 'Callers (who calls this)', 'from_symbol');
    renderEdges(callees, 'Callees (what this calls)', 'to_symbol');

    if (callers.length === 0 && callees.length === 0) {
        lines.push('No call edges found at the requested confidence and direction. Try lowering `min_confidence` or switching `direction`.');
    }

    return lines.join('\n');
}

function formatSearch(data: any): string {
    const lines: string[] = [];
    const results: any[] = data.results || [];
    lines.push(`## Search: "${data.query || ''}"`);
    lines.push(`**Results:** ${results.length}`);
    lines.push('');

    if (results.length === 0) {
        lines.push('No matches found.');
        return lines.join('\n');
    }

    for (const hit of results) {
        const score = (hit.score ?? 0).toFixed(2);
        lines.push(`- **[${hit.type}]** ${hit.path} — score ${score}`);
        if (hit.summary) lines.push(`  - ${hit.summary}`);
    }

    return lines.join('\n');
}

function formatSymbols(data: any): string {
    const lines: string[] = [];
    const results: any[] = data.results || [];
    lines.push(`## Symbol search: "${data.name || ''}"`);
    lines.push(`**Results:** ${results.length}`);
    lines.push('');
    if (results.length === 0) {
        lines.push('No symbols matched. Try: a partial name, or `search_codebase` for topic-based search.');
        return lines.join('\n');
    }
    for (const r of results) {
        const span = Array.isArray(r.span) && r.span.length === 2 ? ` [L${r.span[0]}-${r.span[1]}]` : '';
        const parent = Array.isArray(r.parent_chain) && r.parent_chain.length > 0 ? `${r.parent_chain.join('.')}.` : '';
        const asyncFlag = r.is_async ? ' *(async)*' : '';
        lines.push(`- **[${r.kind}]** \`${parent}${r.name}\`${asyncFlag}${span} — ${r.file_path}`);
        if (r.signature) lines.push(`  - \`${r.signature}\``);
        if (r.docstring) lines.push(`  - ${r.docstring}`);
        const callers: any[] = Array.isArray(r.callers_top3) ? r.callers_top3 : [];
        const callees: any[] = Array.isArray(r.callees_top3) ? r.callees_top3 : [];
        if (callers.length > 0) {
            lines.push(`  - Callers (top ${callers.length}):`);
            lines.push(...formatChainEdges(callers, '    '));
        }
        if (callees.length > 0) {
            lines.push(`  - Callees (top ${callees.length}):`);
            lines.push(...formatChainEdges(callees, '    '));
        }
    }
    return lines.join('\n');
}

function formatContext(data: any): string {
    const targets = data?.targets || {};
    const keys = Object.keys(targets);
    const lines: string[] = [];

    if (keys.length === 0) {
        return '## Context\nNo targets returned.';
    }

    lines.push(`## Context (${keys.length} target${keys.length > 1 ? 's' : ''})`);
    if (data.truncated) {
        lines.push(`**Truncated:** dropped_targets=${(data.dropped_targets || []).length}, dropped_symbols across ${Object.keys(data.dropped_symbols || {}).length} target(s)`);
    }

    for (const key of keys) {
        lines.push('');
        lines.push('---');
        const tgt = targets[key];
        lines.push(formatOneTarget(key, tgt));
    }

    return lines.join('\n');
}

function formatOneTarget(key: string, tgt: any): string {
    if (!tgt) return `### ${key}\n(empty)`;
    const lines: string[] = [];
    const targetType = tgt.target_type || 'unknown';
    lines.push(`### ${key} *(${targetType})*`);

    if (targetType === 'unknown') {
        if (tgt.hint) lines.push(tgt.hint);
        else lines.push(`No match for '${key}'.`);
        const dym: string[] = tgt.did_you_mean || [];
        if (dym.length > 0) lines.push(`Did you mean: ${dym.map(s => `\`${s}\``).join(', ')}`);
        return lines.join('\n');
    }

    if (targetType === 'ambiguous_file') {
        if (tgt.hint) lines.push(tgt.hint);
        const candidates: any[] = tgt.candidates || [];
        if (candidates.length > 0) {
            lines.push('Candidates:');
            for (const c of candidates) {
                const mod = c.module_name ? ` (module: ${c.module_name})` : '';
                lines.push(`- ${c.file_path}${mod}`);
            }
        }
        return lines.join('\n');
    }

    if (targetType === 'symbol') {
        const r = tgt.resolved || {};
        const span = Array.isArray(r.span) && r.span.length === 2 ? ` [L${r.span[0]}-${r.span[1]}]` : '';
        const asyncFlag = r.is_async ? ' *(async)*' : '';
        lines.push(`**Resolved:** \`${r.qualified_name || r.symbol_name}\` *(${r.kind})*${asyncFlag}${span}`);
        lines.push(`**File:** ${r.file_path}`);
        if (r.signature) lines.push(`**Signature:** \`${r.signature}\``);
        if (r.decorators?.length > 0) lines.push(`**Decorators:** ${r.decorators.join(', ')}`);
        if (r.docstring) lines.push(`**Docstring:** ${r.docstring}`);

        const candidates: any[] = tgt.candidates || [];
        if (candidates.length > 0) {
            lines.push('');
            lines.push(`**Other matches (${candidates.length}):**`);
            for (const c of candidates) {
                const cspan = Array.isArray(c.span) && c.span.length === 2 ? ` [L${c.span[0]}-${c.span[1]}]` : '';
                lines.push(`- ${c.file_path}::${c.name} *(${c.kind})*${cspan}`);
            }
        }

        if (tgt.callers?.length > 0) {
            lines.push('');
            lines.push(`**Callers (${tgt.callers.length} of ${tgt.callers_total}):**`);
            for (const c of tgt.callers) {
                lines.push(`- **${c.kind}**: \`${c.symbol}\``);
            }
        }
        if (tgt.callees?.length > 0) {
            lines.push('');
            lines.push(`**Callees (${tgt.callees.length} of ${tgt.callees_total}):**`);
            for (const c of tgt.callees) {
                lines.push(`- **${c.kind}**: \`${c.symbol}\``);
            }
        }
        if (tgt.file_context) {
            lines.push('');
            lines.push('**File context:**');
            const fc = tgt.file_context;
            if (fc.summary?.text) lines.push(`- ${fc.summary.text}`);
            const k = fc.knowledge || {};
            const inv = (k.invariants || [])[0];
            if (inv) lines.push(`- INVARIANT: ${inv.rule}${inv.severity ? ` [${inv.severity}]` : ''}`);
        }
        return lines.join('\n');
    }

    const data = tgt;

    if (data.summary) {
        lines.push('### Summary');
        if (data.summary.text) lines.push(data.summary.text);
        if (data.summary.description) lines.push(data.summary.description);
        if (data.summary.module_name) lines.push(`**Module:** ${data.summary.module_name}`);
        if (data.summary.category) lines.push(`**Category:** ${data.summary.category}`);
        if (data.summary.modification_impact) {
            lines.push('');
            lines.push(`**Modification impact:** ${data.summary.modification_impact}`);
        }
        if (data.summary.overview) {
            lines.push('');
            lines.push(data.summary.overview);
        }
        if (typeof data.summary.files_total === 'number') {
            lines.push(`**Files:** ${data.summary.files_total}`);
        }
    }

    if (data.structure) {
        const s = data.structure;
        if (s.key_symbols?.length > 0) {
            lines.push('');
            lines.push(`### Key Symbols (${s.key_symbols.length} of ${s.key_symbols_total})`);
            for (const sym of s.key_symbols) {
                const span = Array.isArray(sym.span) && sym.span.length === 2 ? ` [L${sym.span[0]}-${sym.span[1]}]` : '';
                const asyncFlag = sym.is_async ? ' *(async)*' : '';
                lines.push(`- **[${sym.kind}]** \`${sym.signature || sym.name}\`${asyncFlag}${span}`);
            }
        }
        if (s.api_endpoints?.length > 0) {
            lines.push('');
            lines.push(`### API Endpoints (${s.api_endpoints.length})`);
            for (const ep of s.api_endpoints) {
                lines.push(`- \`${ep.method || ''} ${ep.path || ''}\` → \`${ep.handler_name || ''}\``);
            }
        }
        if (s.storage_backends?.length > 0) {
            lines.push('');
            lines.push(`### Storage Backends (${s.storage_backends.length})`);
            for (const sb of s.storage_backends) lines.push(`- **${sb.type}** — \`${sb.hint || ''}\``);
        }
        if (s.constants?.length > 0) {
            lines.push('');
            lines.push(`### Constants (${s.constants.length} of ${s.constants_total})`);
            for (const c of s.constants) lines.push(`- \`${c.name}\` = ${c.value_preview || ''}`);
        }
        if (s.internal_imports?.length > 0) {
            lines.push('');
            lines.push(`### Internal Imports (${s.internal_imports.length} of ${s.internal_imports_total})`);
            for (const i of s.internal_imports) {
                const rel = i.is_relative ? ' *(relative)*' : '';
                lines.push(`- ${i.name} (${i.kind || ''}) ← ${i.from_path || ''}${rel}`);
            }
        }
    }

    if (data.knowledge && (data.knowledge.invariants?.length > 0 || data.knowledge.decisions?.length > 0)) {
        lines.push('');
        lines.push('### Design Knowledge');
        const k = data.knowledge;
        if (k.invariants?.length > 0) {
            lines.push(`**Invariants (${k.invariants.length}):**`);
            for (const inv of k.invariants) {
                const sev = inv.severity ? ` [${inv.severity}]` : '';
                lines.push(`- ${inv.rule || ''}${sev}`);
            }
        }
        if (k.decisions?.length > 0) {
            lines.push(`**Decisions (${k.decisions.length}):**`);
            for (const d of k.decisions) {
                const tag = d.tag ? ` *(${d.tag})*` : '';
                lines.push(`- ${d.title || ''}${tag}`);
            }
        }
        if (k.grounded_in?.length > 0) lines.push(`**Grounded in:** ${k.grounded_in.slice(0, 5).join(', ')}`);
    }

    if (data.co_changes?.partners?.length > 0) {
        lines.push('');
        lines.push(`### Co-changes (${data.co_changes.partners.length}, source: ${data.co_changes.source})`);
        for (const p of data.co_changes.partners) {
            const score = (p.score ?? 0).toFixed(2);
            lines.push(`- **${p.file}** [${p.type}] score=${score}`);
            if (p.edge_summary) lines.push(`  - ${p.edge_summary}`);
        }
    }

    if (data.graph) {
        const g = data.graph;
        lines.push('');
        lines.push('### Graph');
        lines.push(`- Imports: ${g.imports_count} | Dependents: ${g.dependents_count} | Symbol edges: ${g.symbol_edges_count}`);
        if (g.symbol_edges_preview?.length > 0) {
            lines.push(`**Symbol edges preview:**`);
            for (const e of g.symbol_edges_preview) {
                const kw = e.kwargs?.length > 0 ? ` — kwargs: ${e.kwargs.join(', ')}` : '';
                lines.push(`- **${e.kind}**: \`${e.from_symbol}\` → \`${e.to_symbol}\`${kw}`);
            }
        }
        if (g.blast_radius_l1?.length > 0) {
            lines.push(`**Direct dependents (L1):**`);
            for (const d of g.blast_radius_l1) lines.push(`- ${d.path}`);
        }
    }

    if (data.sibling_modules?.length > 0) {
        lines.push('');
        lines.push(`### Sibling modules (${data.sibling_modules.length} of ${data.sibling_modules_total})`);
        for (const m of data.sibling_modules) {
            lines.push(`- ${m.name} (${m.file_count} files) — ${m.description}`);
        }
    }

    if (data.modules?.length > 0) {
        lines.push('');
        const depthLabel = data.depth === -1 ? 'all' : (typeof data.depth === 'number' ? `≤${data.depth}` : '');
        const header = depthLabel
            ? `### Modules (${data.modules.length} of ${data.modules_total}, depth=${depthLabel})`
            : `### Modules (${data.modules.length} of ${data.modules_total})`;
        lines.push(header);
        for (const m of data.modules) {
            const desc = m.description ? ` — ${m.description}` : '';
            lines.push(`- **${m.name}** — ${m.file_count} files${desc}`);
            const files: string[] = m.files || [];
            if (files.length > 0) {
                for (const f of files) lines.push(`  - ${f}`);
                const total = m.total_files ?? files.length;
                if (total > files.length) lines.push(`  - … ${total - files.length} more`);
            }
        }
    }

    if (data.health) {
        const h = data.health;
        lines.push('');
        lines.push('### Health');
        lines.push(`- Files: ${h.files} | Modules: ${h.modules} | Enriched modules: ${h.enriched_modules}`);
        lines.push(`- Coupling pairs: ${h.coupling_pairs} | Files with symbol edges: ${h.files_with_symbol_edges}`);
    }

    return lines.join('\n');
}

/** Format ask_codebase response: synthesised answer + per-file citations + retrieval. */
function formatAskCodebase(data: any): string {
    const lines: string[] = [];
    const confidence: string = (data?.confidence || 'low').toString();
    const useModules: boolean = !!data?.use_modules;
    const degraded: boolean = !!data?.degraded;
    const timing: number = Number(data?.timing_ms || 0);

    const flags = [
        `confidence: ${confidence}`,
        useModules ? 'modules=on' : 'modules=off',
    ];
    if (degraded) flags.push('**degraded**');
    lines.push(`## Answer (${flags.join(', ')})`);
    if (degraded) {
        lines.push('');
        lines.push('> ⚠️ The codebase wiki / file enrichment phase has not run for this project. ' +
                   'ask_codebase has no corpus to retrieve from — try one of the structural ' +
                   'MCPs (get_context, get_dependencies, get_call_chain, get_change_impact) ' +
                   'or run the codewiki / file_index phase first.');
    }
    if (data?.note) {
        lines.push(`*${data.note}*`);
    }
    if (data?.answer) {
        lines.push('');
        lines.push(String(data.answer));
    } else if (!data?.note) {
        lines.push('');
        lines.push('*(empty answer)*');
    }

    const citations: string[] = Array.isArray(data?.citations) ? data.citations : [];
    if (citations.length > 0) {
        lines.push('');
        lines.push('### Citations');
        for (const c of citations) lines.push(`- ${c}`);
    }

    const fallback: string[] = Array.isArray(data?.fallback_targets) ? data.fallback_targets : [];
    const uncited = fallback.filter(p => !citations.includes(p));
    if (uncited.length > 0) {
        lines.push('');
        lines.push(`### Other top files retrieved (not cited in answer)`);
        for (const p of uncited) lines.push(`- ${p}`);
    }

    const retrieval: any[] = Array.isArray(data?.retrieval) ? data.retrieval : [];
    if (retrieval.length > 0) {
        lines.push('');
        lines.push(`### Retrieval scores (top ${retrieval.length})`);
        for (const r of retrieval) {
            const score = Number(r?.score || 0).toFixed(3);
            const summary = (r?.summary || '').toString().replace(/\s+/g, ' ').slice(0, 140);
            lines.push(`- **${r?.target_path || r?.title || ''}** (score=${score}) — ${summary}`);
        }
    }

    const subQueries: string[] = Array.isArray(data?.sub_queries) ? data.sub_queries : [];
    if (subQueries.length > 1) {
        lines.push('');
        lines.push(`*Decomposed into ${subQueries.length} sub-queries: ${subQueries.map(q => `"${q}"`).join(', ')}*`);
    }

    if (timing > 0) {
        lines.push('');
        lines.push(`*timing: ${timing.toFixed(0)}ms*`);
    }

    return lines.join('\n');
}

// ============= MCP SERVER =============

export async function startMcpServer(): Promise<void> {
    const server = new McpServer({
        name: "lgraph",
        version,
    });

    const edaOnly = process.env.LGRAPH_ABLATION_EDA_ONLY === 'true';
    const registerEnrichmentTool: typeof server.registerTool = ((...args: any[]) => {
        if (edaOnly) return undefined as any;
        return (server.registerTool as any)(...args);
    }) as any;
    if (edaOnly) {
        console.error("[lgraph] EDA-only mode — enrichment-dependent tools skipped (set LGRAPH_ABLATION_EDA_ONLY=false to disable)");
    }

    // ---- get_change_impact ----
    server.registerTool(
        "get_change_impact",
        {
            description: "Use this BEFORE non-trivial source edits to see what would break. Pass `target` as a file path for file-level impact (every file that imports or depends on it, grouped by depth) — or as `file_path::symbol_name` for symbol-level impact (the exact functions/methods/classes that call into your symbol, transitively). Symbol-level mode dramatically reduces false positives — you see only the callers actually reached, not every dependent of the file. Skip for .json/.yaml/.md (not in graph).",
            inputSchema: z.object({
                target: z.string().describe("File path (file-level mode) OR 'file_path::symbol_name' (symbol-level mode)"),
                project_id: z.string().optional().describe("Latentgraph project UUID; overrides LGRAPH_PROJECT_ID if provided"),
                level: z.number().optional().describe("Max BFS depth (default 3)"),
            })
        },
        async (args: any) => {
            const publicToken = getPublicToken();
            const isSymbolTarget = args.target.includes("::");
            const targetValue = isSymbolTarget ? args.target : normalizePath(args.target);
            const payload: Record<string, unknown> = { path: targetValue };
            if (args.level != null) payload.level = args.level;
            if (publicToken) {
                const data = await callPublicAPIPost(publicToken, 'blast-radius', payload);
                return { content: [{ type: "text", text: formatBlastRadius(data) }] };
            }
            const projectId = resolveProjectId(args);
            const branch = resolveBranch(args);
            const data = await callBackendAPI('/api/v1/mcp/blast-radius', { ...payload, project_id: projectId, branch });
            return { content: [{ type: "text", text: formatBlastRadius(data) }] };
        },
    );

    // ---- get_dependencies ----
    server.registerTool(
        "get_dependencies",
        {
            description: "Use this to map out a file's relationships before touching it. Returns what the file imports AND what depends on it (reverse deps), each split into TWO sections: **Explicit** (direct imports / static references) and **Implicit** (runtime coupling — Redis channels, events, shared config, cross-service calls). A target reached via BOTH kinds is tagged `[mixed: explicit + implicit]` and appears in both lists; that's accurate signal, not duplication. Pass `with_symbols=true` to also get a per-dependency symbol-level breakdown showing which specific functions of yours call which specific functions of each dependency — this prevents misjudging impact based on file-level edges alone. Indexed source files only.",
            inputSchema: z.object({
                file_path: z.string().describe("Path to the file"),
                with_symbols: z.boolean().optional().describe("If true, include per-dependency symbol-level edges (caller → callee, kind)"),
                project_id: z.string().optional().describe("Latentgraph project UUID; overrides LGRAPH_PROJECT_ID if provided"),
            })
        },
        async (args: any) => {
            const publicToken = getPublicToken();
            const payload = {
                path: normalizePath(args.file_path),
                with_symbols: !!args.with_symbols,
            };
            if (publicToken) {
                const data = await callPublicAPIPost(publicToken, 'dependencies', payload);
                return { content: [{ type: "text", text: formatDependencies(data) }] };
            }
            const projectId = resolveProjectId(args);
            const branch = resolveBranch(args);
            const data = await callBackendAPI('/api/v1/mcp/dependency', { ...payload, project_id: projectId, branch });
            return { content: [{ type: "text", text: formatDependencies(data) }] };
        },
    );

    // ---- get_file ----
    registerEnrichmentTool(
        "get_file",
        {
            description: "Use this BEFORE reading any source file — gives the essential context without parsing the source. Returns: AI-written summary, AST-extracted symbols (functions/classes/methods with line spans + signatures + decorators + async flag), internal imports, API endpoints, storage backends (mongo/redis/etc.), constants, dependents, owning module, modification-impact guidance, and a preview of symbol-to-symbol edges (which of your functions call which of the dependency's functions). Use `level` to include parent module ancestry. Indexed source files only — for .json/.yaml/.md read directly.",
            inputSchema: z.object({
                file_path: z.string().describe("Path to the file to summarize"),
                project_id: z.string().optional().describe("Latentgraph project UUID; overrides LGRAPH_PROJECT_ID if provided"),
                level: z.number().optional().describe("Number of parent directory levels to include (default 0)"),
            })
        },
        async (args: any) => {
            const publicToken = getPublicToken();
            if (publicToken) {
                const data = await callPublicAPIPost(publicToken, 'file-summary', {
                    path: normalizePath(args.file_path),
                });
                return { content: [{ type: "text", text: formatFileSummary(data) }] };
            }
            const projectId = resolveProjectId(args);
            const branch = resolveBranch(args);
            const data = await callBackendAPI('/api/v1/mcp/what-is-this-file', {
                path: normalizePath(args.file_path),
                project_id: projectId,
                level: args.level ?? 0,
                branch,
            });
            return { content: [{ type: "text", text: formatFileSummary(data) }] };
        },
    );

    // get_module, get_overview, list_modules were removed from the MCP surface
    // (all codewiki/file-enrichment-dependent — agent gets module info via
    // get_context with a module-name target). Backend routes /module-summary,
    // /project-overview, /list-modules remain wired for the web UI.

    // ============= UNIFIED EDIT TOOL (All edits are queued for approval) =============

    // Operation configurations for routing
    const EDIT_OPERATIONS = {
        edit_file_summary: {
            method: 'PUT' as const,
            endpoint: (projectId: string) => `/api/project/${projectId}/drg/file-summary`,
            buildPayload: (args: any) => ({
                id: normalizePath(args.file_path),
                summary: args.summary,
            }),
            requiredParams: ['file_path', 'summary'],
            label: 'File summary edit',
        },
        edit_dependency_summary: {
            method: 'PUT' as const,
            endpoint: (projectId: string) => `/api/project/${projectId}/drg/dependency-summary`,
            buildPayload: (args: any) => ({
                id: normalizePath(args.file_path),
                dependency_path: normalizePath(args.dependency_path),
                summary: args.summary,
            }),
            requiredParams: ['file_path', 'dependency_path', 'summary'],
            label: 'Dependency summary edit',
        },
        edit_module_doc: {
            method: 'PUT' as const,
            endpoint: (projectId: string) => `/api/project/${projectId}/codewiki/doc`,
            buildPayload: (args: any) => ({
                module_name: args.module_name,
                content: args.content,
            }),
            requiredParams: ['module_name', 'content'],
            label: 'Module documentation edit',
        },
        add_dependency: {
            method: 'POST' as const,
            endpoint: (projectId: string) => `/api/project/${projectId}/drg/dependency`,
            buildPayload: (args: any) => ({
                id: normalizePath(args.file_path),
                dependency_path: normalizePath(args.dependency_path),
                summary: args.summary || '',
            }),
            requiredParams: ['file_path', 'dependency_path'],
            label: 'Add dependency',
        },
        delete_dependency: {
            method: 'DELETE' as const,
            endpoint: (projectId: string) => `/api/project/${projectId}/drg/dependency`,
            buildPayload: (args: any) => ({
                id: normalizePath(args.file_path),
                dependency_path: normalizePath(args.dependency_path),
            }),
            requiredParams: ['file_path', 'dependency_path'],
            label: 'Delete dependency',
        },
        add_dependent: {
            method: 'POST' as const,
            endpoint: (projectId: string) => `/api/project/${projectId}/drg/dependent`,
            buildPayload: (args: any) => ({
                id: normalizePath(args.file_path),
                dependent_path: normalizePath(args.dependent_path),
                summary: args.summary || '',
            }),
            requiredParams: ['file_path', 'dependent_path'],
            label: 'Add dependent',
        },
        delete_dependent: {
            method: 'DELETE' as const,
            endpoint: (projectId: string) => `/api/project/${projectId}/drg/dependent`,
            buildPayload: (args: any) => ({
                id: normalizePath(args.file_path),
                dependent_path: normalizePath(args.dependent_path),
            }),
            requiredParams: ['file_path', 'dependent_path'],
            label: 'Delete dependent',
        },
        add_implicit_dependency: {
            method: 'POST' as const,
            endpoint: (projectId: string) => `/api/project/${projectId}/implicit-dep/add`,
            buildPayload: (args: any) => ({
                source_file: normalizePath(args.source_file),
                dep_file: normalizePath(args.dep_file),
                edge_summary: args.edge_summary || '',
            }),
            requiredParams: ['source_file', 'dep_file'],
            label: 'Add implicit dependency',
        },
        edit_implicit_dependency: {
            method: 'PUT' as const,
            endpoint: (projectId: string) => `/api/project/${projectId}/implicit-dep/update`,
            buildPayload: (args: any) => ({
                source_file: normalizePath(args.source_file),
                dep_file: normalizePath(args.dep_file),
                edge_summary: args.edge_summary || '',
            }),
            requiredParams: ['source_file', 'dep_file'],
            label: 'Edit implicit dependency',
        },
        ignore_implicit_dependency: {
            method: 'POST' as const,
            endpoint: (projectId: string) => `/api/project/${projectId}/implicit-dep/ignore`,
            buildPayload: (args: any) => ({
                source_file: normalizePath(args.source_file),
                dep_file: normalizePath(args.dep_file),
            }),
            requiredParams: ['source_file', 'dep_file'],
            label: 'Ignore implicit dependency',
        },
        delete_implicit_dependency: {
            method: 'DELETE' as const,
            endpoint: (projectId: string) => `/api/project/${projectId}/implicit-dep/delete`,
            buildPayload: (args: any) => ({
                source_file: normalizePath(args.source_file),
                dep_file: normalizePath(args.dep_file),
            }),
            requiredParams: ['source_file', 'dep_file'],
            label: 'Delete implicit dependency',
        },
    };

    type EditOperation = keyof typeof EDIT_OPERATIONS;

    server.registerTool(
        "update_graph",
        {
            description: `Record learnings about the dependency relationship graph (DRG) or CodeWiki. All edits are queued for owner approval before being applied. Learnings are stored separately from original data.

**Operations:**
- \`edit_file_summary\`: Add a learning about a file. Stored in the file's learnings array. Params: file_path, summary
- \`edit_dependency_summary\`: Add a learning about why file_path depends on dependency_path. Params: file_path, dependency_path, summary
- \`edit_module_doc\`: Add a learning about module documentation. Stored in the module's learnings array. Params: module_name, content
- \`add_dependency\`: Record discovered dependency relationship. Params: file_path, dependency_path, [summary]
- \`delete_dependency\`: Suggest removing dependency relationship. Params: file_path, dependency_path
- \`add_dependent\`: Record discovered dependent relationship. Params: file_path, dependent_path, [summary]
- \`delete_dependent\`: Suggest removing dependent relationship. Params: file_path, dependent_path
- \`add_implicit_dependency\`: Record discovered runtime/coupling dependency. Params: source_file, dep_file, [edge_summary]
- \`edit_implicit_dependency\`: Add learning about implicit dependency. Params: source_file, dep_file, edge_summary
- \`ignore_implicit_dependency\`: Mark implicit dep as false positive. Params: source_file, dep_file
- \`delete_implicit_dependency\`: Suggest removing implicit dependency. Params: source_file, dep_file`,
            inputSchema: z.object({
                operation: z.enum([
                    'edit_file_summary',
                    'edit_dependency_summary',
                    'edit_module_doc',
                    'add_dependency',
                    'delete_dependency',
                    'add_dependent',
                    'delete_dependent',
                    'add_implicit_dependency',
                    'edit_implicit_dependency',
                    'ignore_implicit_dependency',
                    'delete_implicit_dependency',
                ]).describe("The edit operation to perform"),
                // File/node operations
                file_path: z.string().optional().describe("Path to the file (for file/dependency operations)"),
                summary: z.string().optional().describe("Learning or summary text to add"),
                dependency_path: z.string().optional().describe("Target dependency file path"),
                dependent_path: z.string().optional().describe("Target dependent file path"),
                // Implicit dependency operations
                source_file: z.string().optional().describe("Source file (for implicit deps)"),
                dep_file: z.string().optional().describe("Dependency file (for implicit deps)"),
                edge_summary: z.string().optional().describe("Description of the relationship"),
                // Module operations
                module_name: z.string().optional().describe("Module name (for codewiki)"),
                content: z.string().optional().describe("Learning content to add for module documentation"),
                // Project
                project_id: z.string().optional().describe("Latentgraph project UUID; overrides LGRAPH_PROJECT_ID if provided"),
            })
        },
        async (args: any) => {
            const operation = args.operation as EditOperation;
            const config = EDIT_OPERATIONS[operation];

            if (!config) {
                throw new Error(`Unknown operation: ${operation}. Valid operations: ${Object.keys(EDIT_OPERATIONS).join(', ')}`);
            }

            // Validate required parameters
            const missingParams = config.requiredParams.filter(param => !args[param]);
            if (missingParams.length > 0) {
                throw new Error(`Missing required parameters for ${operation}: ${missingParams.join(', ')}`);
            }

            const projectId = resolveProjectId(args);
            const branch = resolveBranch(args);
            const endpoint = config.endpoint(projectId);
            const payload = config.buildPayload(args);
            // Add branch to payload
            (payload as any).branch = branch;

            let data: any;
            switch (config.method) {
                case 'PUT':
                    data = await callMcpEditPut(endpoint, payload);
                    break;
                case 'POST':
                    data = await callMcpEditPost(endpoint, payload);
                    break;
                case 'DELETE':
                    data = await callMcpEditDelete(endpoint, payload);
                    break;
            }

            return { content: [{ type: "text", text: formatEditResult(data, config.label) }] };
        },
    );

    // ---- get_design_knowledge ----
    registerEnrichmentTool(
        "get_design_knowledge",
        {
            description: "Use this BEFORE editing to learn the project's hard-won design knowledge mined from past PRs: rules you must not break (invariants with severity + consequence) and architectural choices that look reasonable to undo but aren't (decisions with rationale + tradeoffs). Two modes: pass `target` (file path or module name) for knowledge attached to that artifact; pass `query` for a keyword search across ALL modules — use this when you don't know which module owns a convention (e.g. 'source_id propagation', 'rate limit', 'idempotency'). Returns up to `limit_per_type` (default 5, max 10) items per category. For target/file modes items are ranked by severity → PR-grounding count → content depth; query mode ranks by token-overlap. Every item is PR-grounded. If `degraded=true` the project never ran the pr_insights phase — empty results then mean 'phase missing', not 'no knowledge captured'.",
            inputSchema: z.object({
                target: z.string().optional().describe("File path or module name to look up directly"),
                query: z.string().optional().describe("Keyword search across all modules' invariants/decisions"),
                limit_per_type: z.number().int().optional().describe("Max items per category (default 3, clamped 1–10)"),
                project_id: z.string().optional().describe("Latentgraph project UUID; overrides LGRAPH_PROJECT_ID if provided"),
                branch: z.string().optional().describe("Branch name; defaults to .lgraph/config.json default_branch"),
            })
        },
        async (args: any) => {
            const publicToken = getPublicToken();
            const target = args.target ? normalizePath(args.target) : undefined;
            const query = args.query?.trim() || undefined;
            if (!target && !query) {
                throw new Error("knowledge: must provide either `target` or `query`");
            }
            const payload: Record<string, unknown> = {};
            if (target) payload.target = target;
            if (query) payload.query = query;
            if (typeof args.limit_per_type === 'number') payload.limit_per_type = args.limit_per_type;
            if (publicToken) {
                const data = await callPublicAPIPost(publicToken, 'knowledge', payload);
                return { content: [{ type: "text", text: formatKnowledge(data) }] };
            }
            const projectId = resolveProjectId(args);
            const branch = resolveBranch(args);
            const data = await callBackendAPI('/api/v1/mcp/knowledge', { ...payload, project_id: projectId, branch });
            return { content: [{ type: "text", text: formatKnowledge(data) }] };
        },
    );

    // ---- get_co_changes (disabled; backend route /coupling still available) ----
    /*
    server.registerTool(
        "get_co_changes",
        {
            description: "Use this when `get_change_impact` returns surprising or sparse results — finds files that ALWAYS change together with the target in PR history, even when they share no import. Each partner shows 4 academic measures (LC, CC, IC, TC), a composite score, and a type: 'explicit' (has DRG edge), 'implicit' (runtime coupling), or 'none' (HIDDEN — only PR history reveals). Falls back to structural neighbors (same subdirectory → 1-hop deps → module siblings) when no PR data exists. The `[none]` partners are gold.",
            inputSchema: z.object({
                file_path: z.string().describe("Path to the file to analyze"),
                limit: z.number().optional().describe("Maximum partners to return (default 10)"),
                project_id: z.string().optional().describe("Latentgraph project UUID; overrides LGRAPH_PROJECT_ID if provided"),
                branch: z.string().optional().describe("Branch name; defaults to .lgraph/config.json default_branch"),
            })
        },
        async (args: any) => {
            const publicToken = getPublicToken();
            const payload = {
                file_path: normalizePath(args.file_path),
                limit: args.limit ?? 10,
            };
            if (publicToken) {
                const data = await callPublicAPIPost(publicToken, 'coupling', payload);
                return { content: [{ type: "text", text: formatCoupling(data) }] };
            }
            const projectId = resolveProjectId(args);
            const branch = resolveBranch(args);
            const data = await callBackendAPI('/api/v1/mcp/coupling', { ...payload, project_id: projectId, branch });
            return { content: [{ type: "text", text: formatCoupling(data) }] };
        },
    );
    */

    // ---- get_dependency_path ----
    server.registerTool(
        "get_dependency_path",
        {
            description: "Use this to answer 'how is file A connected to file B' — runs BFS over the dependency graph and returns the shortest hop chain. Each hop shows edge type (explicit import or implicit runtime coupling), coupling mechanism and strength for implicit hops, and an edge summary. Sets `has_implicit_hop=true` when any hop is implicit (often the most interesting case — reveals cross-module coupling that goes through Redis/config/event channels invisible to plain import analysis). Returns `connected=false` if no chain exists within `max_hops`.",
            inputSchema: z.object({
                source: z.string().describe("Start file path"),
                target: z.string().describe("End file path"),
                max_hops: z.number().optional().describe("Maximum hops to search (default 8)"),
                project_id: z.string().optional().describe("Latentgraph project UUID; overrides LGRAPH_PROJECT_ID if provided"),
                branch: z.string().optional().describe("Branch name; defaults to .lgraph/config.json default_branch"),
            })
        },
        async (args: any) => {
            const publicToken = getPublicToken();
            const payload = {
                source: normalizePath(args.source),
                target: normalizePath(args.target),
                max_hops: args.max_hops ?? 8,
            };
            if (publicToken) {
                const data = await callPublicAPIPost(publicToken, 'path', payload);
                return { content: [{ type: "text", text: formatPath(data) }] };
            }
            const projectId = resolveProjectId(args);
            const branch = resolveBranch(args);
            const data = await callBackendAPI('/api/v1/mcp/path', { ...payload, project_id: projectId, branch });
            return { content: [{ type: "text", text: formatPath(data) }] };
        },
    );

    // ---- get_call_chain ----
    server.registerTool(
        "get_call_chain",
        {
            description: "Trace symbol-level call chains in both directions (callers + callees) over the AST-built call graph. Always returns both directions — pick what you need from the response. Symbol id must be fully-qualified: '<file>::<class>::<method>' or '<file>::<function>'. Each edge carries from/to symbol+file, kind, resolution tier, and confidence. Use BEFORE editing a function to understand the actual runtime graph rather than file-level imports; pair with `get_change_impact` (symbol mode) for the flat blast surface. Internal defaults: confidence>=0.6, externals excluded, polymorphic candidates suppressed, width capped at 25 edges per BFS level. Response is hard-capped at 32KB — when exceeded, deepest + lowest-confidence edges are dropped first and `truncated`/`dropped_count` are set; reduce `depth` to see fewer, more relevant edges.",
            inputSchema: z.object({
                symbol: z.string().describe("Fully-qualified symbol id, e.g., 'src/auth/handler.py::Auth::authenticate'"),
                depth: z.number().optional().describe("BFS hops (default 2, max 5). Higher catches indirect chains but returns more edges."),
                project_id: z.string().optional().describe("Latentgraph project UUID; overrides LGRAPH_PROJECT_ID if provided"),
                branch: z.string().optional().describe("Branch name; defaults to .lgraph/config.json default_branch"),
            })
        },
        async (args: any) => {
            const publicToken = getPublicToken();
            const payload: Record<string, unknown> = {
                symbol: args.symbol,
                depth: args.depth ?? 2,
            };
            if (publicToken) {
                const data = await callPublicAPIPost(publicToken, 'call-chain', payload);
                return { content: [{ type: "text", text: formatCallChain(data) }] };
            }
            const projectId = resolveProjectId(args);
            const branch = resolveBranch(args);
            const data = await callBackendAPI('/api/v1/mcp/call-chain', { ...payload, project_id: projectId, branch });
            return { content: [{ type: "text", text: formatCallChain(data) }] };
        },
    );

    // ---- search_codebase ----
    registerEnrichmentTool(
        "search_codebase",
        {
            description: "Use this for topic-based discovery — keyword search across file summaries, module wiki content, and PR-extracted knowledge (invariants, decisions). Returns ranked hits with type ('file', 'module', 'knowledge'). Knowledge hits get a 1.5× score boost because they contain the 'why' behind the code. Use when you don't know which file/module owns a topic. For finding a specific function or class by name, use `get_symbol` instead — it's purpose-built for symbol lookup.",
            inputSchema: z.object({
                query: z.string().describe("Search query"),
                kind: z.enum(["file", "module", "knowledge", "all"]).optional().describe("Filter by hit type (default 'all')"),
                limit: z.number().optional().describe("Maximum results (default 10)"),
                project_id: z.string().optional().describe("Latentgraph project UUID; overrides LGRAPH_PROJECT_ID if provided"),
                branch: z.string().optional().describe("Branch name; defaults to .lgraph/config.json default_branch"),
            })
        },
        async (args: any) => {
            const publicToken = getPublicToken();
            const payload = {
                query: args.query,
                kind: args.kind || "all",
                limit: args.limit ?? 10,
            };
            if (publicToken) {
                const data = await callPublicAPIPost(publicToken, 'search', payload);
                return { content: [{ type: "text", text: formatSearch(data) }] };
            }
            const projectId = resolveProjectId(args);
            const branch = resolveBranch(args);
            const data = await callBackendAPI('/api/v1/mcp/search', { ...payload, project_id: projectId, branch });
            return { content: [{ type: "text", text: formatSearch(data) }] };
        },
    );

    // ---- get_symbol ----
    server.registerTool(
        "get_symbol",
        {
            description: "Use this to LOCATE a symbol by name — given a function/class/method/constant name, returns where it's defined across the project. Each hit includes file_path, line span, signature, kind, parent class chain, decorators, async flag, visibility, and docstring. Optional: filter by `kind` (function|class|method|constant|...) or scope by `file_prefix`. For broader topic-based search, use `search_codebase`.",
            inputSchema: z.object({
                name: z.string().describe("Symbol name (function, class, method, constant) — exact, prefix, or substring"),
                kind: z.enum(["function", "class", "method", "constant", "interface", "struct", "enum", "trait", "module", "variable", "attribute", "any"]).optional().describe("Filter by symbol kind (default 'any')"),
                file_prefix: z.string().optional().describe("Restrict to file paths starting with this prefix"),
                limit: z.number().optional().describe("Max results (default 10)"),
                project_id: z.string().optional().describe("Latentgraph project UUID; overrides LGRAPH_PROJECT_ID if provided"),
                branch: z.string().optional().describe("Branch name; defaults to .lgraph/config.json default_branch"),
            })
        },
        async (args: any) => {
            const publicToken = getPublicToken();
            const payload: Record<string, unknown> = {
                name: args.name,
                kind: args.kind || "any",
                limit: args.limit ?? 10,
            };
            if (args.file_prefix) payload.file_prefix = args.file_prefix;
            if (publicToken) {
                const data = await callPublicAPIPost(publicToken, 'find-symbols', payload);
                return { content: [{ type: "text", text: formatSymbols(data) }] };
            }
            const projectId = resolveProjectId(args);
            const branch = resolveBranch(args);
            const data = await callBackendAPI('/api/v1/mcp/find-symbols', { ...payload, project_id: projectId, branch });
            return { content: [{ type: "text", text: formatSymbols(data) }] };
        },
    );

    // ---- get_context ----
    registerEnrichmentTool(
        "get_context",
        {
            description: [
                "DEFAULT first call to understand any artifact. Also the project-orientation tool — pass `targets=['project']` for the architecture summary, wiki overview, and module tree (replaces the removed get_overview / list_modules tools).",
                "Each entry in `targets` can be:",
                "  - a file path:        \"webapp/app_backend/app/routes/auth.py\"",
                "  - a module name:      \"webapp/api/auth\"",
                "  - a file::symbol:     \"webapp/app_backend/app/routes/auth.py::authenticate\"",
                "  - a filename::symbol: \"auth.py::authenticate\"  (resolves by basename; if multiple files match, returns candidates)",
                "  - a bare symbol name: \"authenticate\"           (searches all files; if multiple match, primary + candidates[])",
                "  - the literal:        \"project\"                (architecture summary + module tree)",
                "Returns a `targets` map keyed by your inputs, each with target_type + relevant sections (summary / structure / knowledge / co_changes / graph / callers / callees / candidates / modules / health / etc.).",
                "Use `include` to narrow sections (default: auto). Use `depth` and `include_files` (project target only) to control module-tree breadth — depth=1 (default) returns top-level modules; depth=-1 returns the full tree; include_files=true attaches file paths to each module entry. Examples:",
                "  get_context(targets=[\"auth.py\", \"login.py\"])",
                "  get_context(targets=[\"auth.py::authenticate\"], include=[\"callers\",\"callees\",\"file_context\"])",
                "  get_context(targets=[\"project\"])                                       # quick orientation (top-level modules)",
                "  get_context(targets=[\"project\"], depth=-1, include_files=true)         # full module tree with files (replaces list_modules)",
                "Response is capped at ~32KB; if truncated, see `truncated`, `dropped_targets`, `dropped_symbols` flags.",
            ].join("\n"),
            inputSchema: z.object({
                targets: z.array(z.string()).describe("Array of targets: file paths, module names, file::symbol, filename::symbol, bare symbol names, or 'project'"),
                include: z.array(z.enum([
                    "summary", "structure", "knowledge", "co_changes", "graph",
                    "siblings", "modules", "health",
                    "callers", "callees", "file_context",
                ])).optional().describe("Limit to specific sections (default: auto by target type)"),
                depth: z.number().int().optional().describe("Project target only: module-tree depth. 1 = top-level only (default), 2 = top + children, -1 = full tree. Other targets ignore."),
                include_files: z.boolean().optional().describe("Project target only: attach file paths (and total_files) to each module entry. Other targets ignore."),
                project_id: z.string().optional().describe("Latentgraph project UUID; overrides LGRAPH_PROJECT_ID if provided"),
                branch: z.string().optional().describe("Branch name; defaults to .lgraph/config.json default_branch"),
            })
        },
        async (args: any) => {
            const publicToken = getPublicToken();
            const rawTargets: string[] = Array.isArray(args.targets) ? args.targets : [];
            const normalized = rawTargets.map(t => {
                if (!t) return t;
                if (t === 'project') return t;
                if (t.includes('::')) return t;
                if (t.includes('/') || t.includes('.')) return normalizePath(t);
                return t;
            });
            const payload: Record<string, unknown> = { targets: normalized };
            if (args.include) payload.include = args.include;
            if (typeof args.depth === 'number') payload.depth = args.depth;
            if (typeof args.include_files === 'boolean') payload.include_files = args.include_files;
            if (publicToken) {
                const data = await callPublicAPIPost(publicToken, 'context', payload);
                return { content: [{ type: "text", text: formatContext(data) }] };
            }
            const projectId = resolveProjectId(args);
            const branch = resolveBranch(args);
            const data = await callBackendAPI('/api/v1/mcp/context', { ...payload, project_id: projectId, branch });
            return { content: [{ type: "text", text: formatContext(data) }] };
        },
    );

    // ---- ask_codebase ----
    registerEnrichmentTool(
        "ask_codebase",
        {
            description: "Ask a natural-language question about the codebase. Hierarchical RAG retrieval over module wiki pages, file summaries, and dependency-edge notes — returns a synthesized answer with per-file citations. Use this for cross-cutting understanding (\"how does auth work?\", \"what writes to call_graph?\") rather than pinpoint lookups; for those prefer get_context, get_symbol, get_dependencies, get_call_chain. Cost: ~4 chat + 2-4 embed calls per question (rate-limited 50/min, 500/day per project). Each answer cites the project files it draws from inline like (path/to/file.py); if the wiki excerpts don't cover the question the response says so explicitly and lists the most likely files to inspect. Set top_n to widen / narrow the citation set (default 5, max 20). use_modules overrides the project-level setting for this one call (default mode includes codewiki module narrative; turn off if codewiki is sparse for this project).",
            inputSchema: z.object({
                question: z.string().describe("Natural-language question about the codebase"),
                top_n: z.number().int().optional().describe("Number of source files to cite (default 5, max 20)"),
                use_modules: z.boolean().optional().describe("Override the project-level codewiki-narrative setting for this call"),
                project_id: z.string().optional().describe("Latentgraph project UUID; overrides LGRAPH_PROJECT_ID if provided"),
                branch: z.string().optional().describe("Branch name; defaults to .lgraph/config.json default_branch"),
            })
        },
        async (args: any) => {
            const publicToken = getPublicToken();
            const payload: Record<string, unknown> = { question: args.question };
            if (typeof args.top_n === 'number') payload.top_n = args.top_n;
            if (typeof args.use_modules === 'boolean') payload.use_modules = args.use_modules;
            if (publicToken) {
                const data = await callPublicAPIPost(publicToken, 'ask-codebase', payload);
                return { content: [{ type: "text", text: formatAskCodebase(data) }] };
            }
            const projectId = resolveProjectId(args);
            const branch = resolveBranch(args);
            const data = await callBackendAPI('/api/v1/mcp/ask-codebase', { ...payload, project_id: projectId, branch });
            return { content: [{ type: "text", text: formatAskCodebase(data) }] };
        },
    );

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Latentgraph MCP Server running on stdio");
    if (!process.env.LGRAPH_PUBLIC_TOKEN && !process.env.LGRAPH_PROJECT_ID) {
        console.error("Warning: neither LGRAPH_PUBLIC_TOKEN nor LGRAPH_PROJECT_ID is set. Pass project_id in each tool call, or set the env var.");
    }
}
