import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from 'zod';
import { createRequire } from 'module';
import { encode as toonEncode, DELIMITERS } from '@toon-format/toon';
import { getApiKey, getConfiguredUrls, getUserBranch } from './utils/config.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

function getBaseUrl(): string {
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

function resolveProjectId(args: { project_id?: string }): string {
    const fromArgs = args.project_id?.trim();
    if (fromArgs) return fromArgs;
    return getProjectIdFromEnv();
}

function normalizePath(filePath: string): string {
    let p = filePath.replace(/\\/g, '/');
    p = p.replace(/^\.\//, '');
    p = p.replace(/^\//, '');
    return p;
}

/**
 * Lowercases ONLY the final file extension on a path. The backend indexes
 * source files keyed by lowercase extension (`.py`, `.ts`), so callers
 * passing `pipeline_runner.PY` would otherwise hit a silent "not indexed"
 * miss. Does not touch the rest of the path — directory and filename casing
 * remain meaningful on case-sensitive filesystems.
 */
function normalizeFileExt(filePath: string): string {
    const p = normalizePath(filePath);
    const dot = p.lastIndexOf('.');
    const slash = p.lastIndexOf('/');
    if (dot <= slash || dot === -1) return p;
    return p.slice(0, dot) + p.slice(dot).toLowerCase();
}

/**
 * Surfaces obvious mis-uses of `get_call_chain` before they hit the backend
 * and return a generic `unresolved: true`. The call graph only tracks
 * function and method nodes — class identifiers (`<file>::<ClassName>` with
 * no `.method` suffix) are not callable nodes themselves and would silently
 * look like a typo. Throw with a redirect so callers know to query the
 * constructor or a method instead.
 */
function preflightCallChainSymbol(symbol: string): void {
    const last = symbol.split('::').pop() ?? '';
    if (!last || last.includes('.') || last.includes('::')) return;
    if (/^[A-Z][A-Za-z0-9_]*$/.test(last)) {
        throw new Error(
            `get_call_chain: '${symbol}' looks like a class identifier. ` +
            `Classes are not callable nodes in the call graph. ` +
            `Use '${symbol}.__init__' for instantiation, '${symbol}.<method_name>' ` +
            `for a specific method, or 'get_symbol(name="${last}", kind="class")' ` +
            `to list the class's methods first.`
        );
    }
}

function getPublicToken(): string | null {
    return process.env.LGRAPH_PUBLIC_TOKEN?.trim() || null;
}

function getBranchFromEnv(): string | null {
    const envBranch = process.env.LGRAPH_BRANCH?.trim();
    const configBranch = getUserBranch();
    return envBranch || configBranch || null;
}

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

/** Parse a FastAPI error body to its `detail` field; fall back to the raw text. */
function extractDetail(text: string): string {
    if (!text) return '';
    try {
        const j = JSON.parse(text);
        if (typeof j?.detail === 'string') return j.detail;
        if (j?.detail !== undefined) return JSON.stringify(j.detail);
    } catch { /* not JSON */ }
    return text;
}

interface ApiErrorContext {
    /** What the caller asked for (file path, module path, symbol id). Echoed in error messages so users see the exact rejected value rather than a parsed/leaked backend substring. */
    requestedTarget?: string;
}

function handleApiError(response: Response, text: string, ctx: ApiErrorContext = {}): never {
    const detail = extractDetail(text);
    const target = ctx.requestedTarget?.trim();

    if (response.status === 404) {
        // Order matters: specific patterns first. The broad "knowledge graph" substring
        // matches both "No knowledge graph found" (project not indexed) and "File not
        // found in knowledge graph" (project IS indexed, the requested file isn't) —
        // falling back to the generic "graph missing" message in the second case
        // misled users into re-running init-scan.
        if (detail.includes('File not found') || detail.includes('not found in knowledge graph')) {
            const subj = target ? `'${target}'` : 'the requested file';
            throw new Error(
                `${subj} is not in the indexed map. Possible reasons:\n` +
                `  1. Path doesn't match an indexed source file (check spelling, casing, slashes)\n` +
                `  2. Not an indexed file type — non-source (.json, .yaml, .md, .toml, .env, lockfiles) is intentionally excluded; open with Read instead\n` +
                `  3. File was added after the last project scan`
            );
        }
        if (detail.includes('No knowledge graph found')) {
            throw new Error("This project has no indexed map yet. Run a full project scan (lgraph init) to build it.");
        }
        if (detail.includes('No module tree')) {
            throw new Error("No module tree exists for this project. Run the wiki indexing step to build it.");
        }
        if (detail.includes('Module not found')) {
            const subj = target ? `'${target}'` : 'the requested module';
            throw new Error(
                `Module ${subj} is not in the project tree. Use get_project_overview to list modules, or get_module_info on a parent module to see its children.`
            );
        }
    }
    const tail = detail ? ` - ${detail}` : '';
    throw new Error(`API call failed: ${response.status} ${response.statusText}${tail}`);
}

function truncateText(text: string, maxChars: number): string {
    if (!text || text.length <= maxChars) return text;
    return `${text.slice(0, maxChars).trimEnd()}...`;
}

async function callBackendAPI(endpoint: string, data: Record<string, unknown>, ctx: ApiErrorContext = {}): Promise<any> {
    const response = await fetch(`${getBaseUrl()}${endpoint}`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(data),
    });
    if (!response.ok) {
        const text = await response.text();
        handleApiError(response, text, ctx);
    }
    return await response.json();
}

function getMcpEditHeaders(): Record<string, string> {
    const headers = getAuthHeaders();
    // The backend resolves the editing user from the API key, not a header field.
    headers['X-MCP-Source'] = 'true';
    return headers;
}

async function callMcpEdit(method: 'PUT' | 'POST' | 'DELETE', endpoint: string, data: Record<string, unknown>, ctx: ApiErrorContext = {}): Promise<any> {
    const response = await fetch(`${getBaseUrl()}${endpoint}`, {
        method,
        headers: getMcpEditHeaders(),
        body: JSON.stringify(data),
    });
    if (!response.ok) {
        const text = await response.text();
        handleApiError(response, text, ctx);
    }
    return await response.json();
}

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

/**
 * Dual-auth dispatcher. Public-token deployments hit `/api/public/<token>/<seg>`;
 * authenticated deployments hit the namespaced backend route with project_id+branch.
 */
async function dispatchTool(
    args: Record<string, any>,
    backendEndpoint: string,
    publicPathSegment: string,
    payload: Record<string, unknown>,
    ctx: ApiErrorContext = {},
): Promise<any> {
    const publicToken = getPublicToken();
    if (publicToken) return callPublicAPIPost(publicToken, publicPathSegment, payload);
    const projectId = resolveProjectId(args);
    const branch = resolveBranch(args);
    return callBackendAPI(backendEndpoint, { ...payload, project_id: projectId, branch }, ctx);
}

const TOON_OPTIONS = { delimiter: DELIMITERS.tab, indent: 2, keyFolding: 'safe' as const };

/** Encode a curated payload as a TOON-fenced code block. */
function toon(data: unknown): string {
    return '```toon\n' + toonEncode(data, TOON_OPTIONS) + '\n```';
}

/** Strip null/undefined/empty values so encoded payloads don't ship literal `field: null`. */
function dropEmpty<T extends Record<string, unknown>>(obj: T): Partial<T> {
    const out: Partial<T> = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v === null || v === undefined) continue;
        if (Array.isArray(v) && v.length === 0) continue;
        if (typeof v === 'string' && v.length === 0) continue;
        if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0) continue;
        (out as any)[k] = v;
    }
    return out;
}

const arr = (v: unknown): any[] => Array.isArray(v) ? v : [];
const round2 = (n: unknown): number | undefined => typeof n === 'number' && Number.isFinite(n) ? Number(n.toFixed(2)) : undefined;

function curateFile(data: any) {
    return dropEmpty({
        path: data?.path,
        summary: data?.summary,
        module_name: data?.module_name,
        file_category: data?.file_category,
        execution_context: data?.execution_context,
        modification_impact: data?.modification_impact,
        key_symbols: arr(data?.key_symbols).map((s: any) => dropEmpty({
            name: s?.name,
            kind: s?.kind,
            signature: s?.signature,
            fqn: s?.fqn,
            is_async: s?.is_async ? true : undefined,
            decorators: arr(s?.decorators),
            visibility: s?.visibility && s.visibility !== 'public' ? s.visibility : undefined,
            docstring: s?.docstring ? truncateText(String(s.docstring), 200) : undefined,
        })),
        exports: arr(data?.exports).map((e: any) => dropEmpty({
            name: e?.name,
            kind: e?.kind,
            summary: e?.summary,
            key_methods: arr(e?.key_methods)
                .map((m: any) => typeof m === 'string' ? m : (m?.name || m?.signature || ''))
                .filter(Boolean),
        })),
        internal_imports: arr(data?.internal_imports).map((i: any) => {
            if (typeof i === 'string') return dropEmpty({ name: i });
            return dropEmpty({
                name: i?.name,
                from_path: i?.from_path,
                kind: i?.kind,
                is_relative: i?.is_relative ? true : undefined,
            });
        }),
        api_endpoints: arr(data?.api_endpoints).map((e: any) => dropEmpty({
            method: e?.method,
            path: e?.path,
            handler: e?.handler_name,
            framework: e?.framework,
        })),
        storage_backends: arr(data?.storage_backends).map((s: any) => dropEmpty({
            type: s?.type,
            hint: s?.hint,
        })),
        constants: arr(data?.constants).map((c: any) => dropEmpty({
            name: c?.name,
            value_preview: c?.value_preview,
        })),
        degraded: data?.degraded ? true : undefined,
    });
}

function curateDependencies(data: any) {
    const mapEdge = (e: any, peerKey: 'target' | 'source') => dropEmpty({
        [peerKey]: e?.[peerKey],
        implicit: e?.implicit ? true : undefined,
        imports: arr(e?.imports),
        summary: e?.summary,
        data_flow: e?.data_flow,
    });
    return dropEmpty({
        path: data?.path,
        outgoing: arr(data?.outgoing).map((e: any) => mapEdge(e, 'target')),
        incoming: arr(data?.incoming).map((e: any) => mapEdge(e, 'source')),
        learnings: arr(data?.learnings),
        degraded: data?.degraded ? true : undefined,
    });
}

const MODULE_FILES_CAP = 50;

function curateModuleInfo(data: any) {
    const allFiles = arr(data?.files);
    const files = allFiles.slice(0, MODULE_FILES_CAP);
    return dropEmpty({
        module_name: data?.module_name,
        description: data?.description,
        content: data?.content ? truncateText(String(data.content), 4000) : undefined,
        files,
        total_file_count: allFiles.length,
        files_truncated: allFiles.length > MODULE_FILES_CAP ? true : undefined,
        child_modules: arr(data?.child_modules),
        learnings: arr(data?.learnings),
        degraded: data?.degraded ? true : undefined,
    });
}

function curateProjectOverview(data: any) {
    return dropEmpty({
        architecture_summary: data?.architecture_summary,
        overview: data?.overview,
        top_level_modules: arr(data?.top_level_modules).map((m: any) => dropEmpty({
            path: m?.path || m?.name,
            file_count: typeof m?.file_count === 'number' ? m.file_count : undefined,
            summary: m?.summary,
        })),
        degraded: data?.degraded ? true : undefined,
    });
}

function curateSymbols(data: any, requestedName?: string) {
    // results is always emitted (even when empty) so consumers can distinguish
    // "name not indexed" from "field absent". dropEmpty would otherwise strip
    // an empty array and collapse those two states into one.
    const results = arr(data?.results).map((r: any) => dropEmpty({
        name: r?.name,
        kind: r?.kind,
        file_path: r?.file_path,
        fqn: r?.fqn,
        signature: r?.signature,
        parent_chain: arr(r?.parent_chain),
        is_async: r?.is_async ? true : undefined,
    }));
    return {
        ...dropEmpty({ name: data?.name ?? requestedName }),
        results,
    };
}

function curateCallChain(data: any) {
    const mapEdge = (e: any, peerKey: 'from_symbol' | 'to_symbol') => dropEmpty({
        [peerKey]: e?.[peerKey],
        from_file: e?.from_file,
        kind: e?.kind,
        resolution: e?.resolution,
        confidence: round2(e?.confidence),
        level: typeof e?.level === 'number' ? e.level : undefined,
        candidates: arr(e?.candidates).slice(0, 3),
    });
    const stats = data?.stats || {};
    return dropEmpty({
        symbol: data?.symbol,
        direction: data?.direction,
        depth: typeof data?.depth === 'number' ? data.depth : undefined,
        stats: dropEmpty({
            fan_in: typeof stats.fan_in === 'number' ? stats.fan_in : undefined,
            fan_out: typeof stats.fan_out === 'number' ? stats.fan_out : undefined,
            score: round2(stats.score),
        }),
        callers: arr(data?.callers).map((e: any) => mapEdge(e, 'from_symbol')),
        callees: arr(data?.callees).map((e: any) => mapEdge(e, 'to_symbol')),
        warnings: arr(data?.warnings).map((w: any) => dropEmpty({
            type: w?.type,
            message: w?.message,
            callers: arr(w?.callers).slice(0, 3),
        })),
        truncated: data?.truncated ? true : undefined,
        unresolved: data?.unresolved ? true : undefined,
    });
}

function curateKnowledge(data: any) {
    const invariants = arr(data?.invariants).map((i: any) => dropEmpty({
        rule: i?.rule,
        severity: i?.severity,
        why: i?.why,
        consequence: i?.consequence,
        grounded_in: arr(i?.grounded_in),
    }));
    const decisions = arr(data?.decisions).map((d: any) => dropEmpty({
        title: d?.title,
        importance: d?.importance,
        tag: d?.tag,
        rationale: d?.rationale,
        tradeoffs: d?.tradeoffs,
        grounded_in: arr(d?.grounded_in),
    }));
    const matched_modules = arr(data?.matched_modules);
    const grounded_in = arr(data?.grounded_in);

    // Backend returns identical empty-array shapes whether the target is
    // a known file with no recorded knowledge or a target that doesn't exist
    // at all. Heuristic: when nothing surfaces from any field, mark degraded
    // so the agent treats "empty" as "may not be indexed" and not "no rule
    // applies". Backend should ideally distinguish; this is a TS workaround.
    const empty = invariants.length === 0 && decisions.length === 0 &&
        matched_modules.length === 0 && grounded_in.length === 0;

    return dropEmpty({
        target: data?.target,
        target_type: data?.target_type,
        matched_modules,
        grounded_in,
        invariants,
        decisions,
        degraded: empty ? true : undefined,
        note: empty
            ? "No recorded knowledge for this target. May indicate target is not indexed, or no PR-derived rules/decisions exist for it yet."
            : undefined,
    });
}

function curateAskCodebase(data: any) {
    const citations = arr(data?.citations);
    const fallback = arr(data?.fallback_targets).filter((p: string) => !citations.includes(p));
    return dropEmpty({
        answer: data?.answer ? truncateText(String(data.answer), 8000) : undefined,
        confidence: data?.confidence,
        note: data?.note,
        citations,
        fallback_targets: fallback,
        degraded: data?.degraded ? true : undefined,
    });
}

/**
 * Render the queued-edit receipt as plain prose. `update_graph` is a write tool
 * with a tiny 3-field response — TOON's tabular savings don't apply, and the
 * agent reads this once for confirmation, not for downstream parsing.
 */
function formatEditReceipt(data: any, operation: string): string {
    const id = data?.pending_edit_id ? String(data.pending_edit_id) : '(none)';
    const message = data?.message ? String(data.message) : 'No message returned.';
    const applied = data?.applied ? 'true' : 'false';
    return `Operation: ${operation}\nApplied: ${applied}\nPending edit id: ${id}\nMessage: ${message}`;
}

// ============= MCP SERVER =============

export async function startMcpServer(): Promise<void> {
    const server = new McpServer({
        name: "lgraph",
        version,
    });

    const edaOnly = process.env.LGRAPH_ABLATION_EDA_ONLY === 'true';
    // Enrichment-dependent tools depend on the codewiki layer; in EDA-only ablation
    // they would return all-degraded responses, so skip registering them at all.
    const registerEnrichmentTool: typeof server.registerTool = ((...args: any[]) => {
        if (edaOnly) return undefined as any;
        return (server.registerTool as any)(...args);
    }) as any;
    if (edaOnly) {
        console.error("[lgraph] EDA-only mode — enrichment-dependent tools skipped (set LGRAPH_ABLATION_EDA_ONLY=false to disable)");
    }

    // ---- get_dependencies ----
    // Wire change vs pre-1.0.29: `with_symbols=true` arg removed from the
    // schema. Symbol-level call edges now live in `get_call_chain` (per
    // symbol). Old callers passing `with_symbols` get it silently dropped.
    server.registerTool(
        "get_dependencies",
        {
            description: "Returns the file-level dependencies around one indexed source file. `outgoing` lists every file the given file depends on; `incoming` lists every file that depends on it. Each entry names the other file (as `target` for outgoing, `source` for incoming) and carries `implicit` (true for runtime coupling like Redis channels, event buses, shared cache, or shared config; false for direct imports), a `summary` of the edge, a `data_flow` description, and `imports` (symbol names for explicit edges; empty for implicit). A file reached through both an explicit import AND an implicit coupling appears as TWO entries with the same target/source — one `implicit: true`, one `implicit: false`; deduplicate by `(target, implicit)`. Use this to know which files will be affected by changes to a given file, what it builds upon, or what runtime channels couple it elsewhere. It will not return symbol-level call edges, source code, or dependencies of any other file. If metadata is incomplete, `degraded: true` and `summary`/`data_flow` are empty. File extensions are case-folded on lookup, so `.PY` and `.py` resolve to the same file.",
            inputSchema: z.object({
                file_path: z.string().describe("Path of the file to inspect, relative to the project root. Must point to a leaf indexed source file. Module paths, directory paths, and non-source extensions are rejected. Extension casing is normalized (`.PY` → `.py`); the rest of the path is case-sensitive."),
            })
        },
        async (args: any) => {
            const data = await dispatchTool(args, '/api/v1/mcp/dependency', 'dependencies', {
                path: normalizeFileExt(args.file_path),
            }, { requestedTarget: args.file_path });
            return { content: [{ type: "text", text: toon(curateDependencies(data)) }] };
        },
    );

    // ---- get_file ----
    // Wire change vs pre-1.0.29: `level` arg removed from schema and module
    // ancestry (`module_context`) no longer in the response. Use
    // `get_module_info` to walk up the module tree from a file's `module_name`.
    registerEnrichmentTool(
        "get_file",
        {
            description: "Returns the static metadata for one indexed source file: an AI-written summary of what it does, the module it belongs to, a category tag, a modification-impact tag, the symbols it defines (each with name, kind, signature, async flag, decorators, and a ready-to-chain `fqn` — `<file_path>::<name>` for top-level, `<file_path>::<Class>.<method>` for methods, pass straight into get_call_chain), explicit exports, internal imports, declared constants, served API endpoints, and storage backends touched. The file_path must point to a leaf indexed source file (.ts, .py, .java, etc.); module paths, directories, and non-source extensions (.json, .yaml, .md) are rejected. Use this when you need to understand one file's purpose and intrinsic structure before reading the raw source. It will not return which files this file depends on, which files depend on it, call relationships, or the module's architectural ancestry. If file metadata is incomplete, the response carries `degraded: true` and most fields are empty except path, summary, and module_name. Extension casing is normalized (`.PY` → `.py`); the rest of the path is case-sensitive.",
            inputSchema: z.object({
                file_path: z.string().describe("Path of the file to retrieve, relative to the project root. Must point to a leaf indexed source file. Module paths, directory paths, and non-source extensions (.json, .yaml, .md, lockfiles) are rejected. Extension casing is normalized on lookup; directory and filename casing are not."),
            })
        },
        async (args: any) => {
            const data = await dispatchTool(args, '/api/v1/mcp/what-is-this-file', 'file-summary', {
                path: normalizeFileExt(args.file_path),
            }, { requestedTarget: args.file_path });
            const curated = curateFile(data);
            let text = toon(curated);
            const mod = (curated as any)?.module_name;
            const fpath = (curated as any)?.path;
            const trailer: string[] = [];
            if (mod) trailer.push(`Module context: this file belongs to "${mod}". Call get_module_info(module_path="${mod}") for the module narrative, sibling files, and child modules.`);
            if (fpath) {
                const dir = fpath.split('/').slice(0, -1).join('/');
                if (dir) trailer.push(`List every symbol in this directory: get_symbol(file_prefix="${dir}/"). Add name="<your_symbol>" to filter by name within the same subtree.`);
            }
            if (trailer.length > 0) text += '\n\n' + trailer.join('\n');
            return { content: [{ type: "text", text }] };
        },
    );

    // ---- get_module_info ----
    registerEnrichmentTool(
        "get_module_info",
        {
            description: "Returns the overview of one indexed module: a summary paragraph of what it does, the full narrative text that describes how it fits the system, the list of file paths it contains, the identifiers of any nested child modules under it (so you can drill down into the module tree), and any human-curated notes recorded for it by past sessions. The module_path is the module's identifier in the indexed project's module tree — these identifiers often resemble directory paths but are codewiki node paths and can diverge when projects use logical groupings; file paths and the literal \"project\" are rejected (for the project root, call `get_project_overview` instead). Use this to understand what a subsystem does and which files belong to it before drilling into any one of them. It will not return details of any individual file, the symbols any file defines, or call relationships between files. If the module's overview is unavailable, the response carries `degraded: true` and the summary and narrative fields are empty.",
            inputSchema: z.object({
                module_path: z.string().describe("Identifier of the module to retrieve, as recorded in the indexed project's module tree. These identifiers often resemble filesystem directory paths but are codewiki node paths — they may diverge when the project uses logical module groupings. Discover valid identifiers from the project overview's top-level module list or from another module's `child_modules` array. File paths and the literal string 'project' are rejected; for the project root, call `get_project_overview`."),
            })
        },
        async (args: any) => {
            if (args.module_path === 'project') {
                throw new Error(
                    "get_module_info: 'project' is not a module identifier. " +
                    "Call get_project_overview() for the project root summary and top-level module list."
                );
            }
            const data = await dispatchTool(args, '/api/v1/mcp/module-info', 'module-info', {
                module_path: args.module_path,
            }, { requestedTarget: args.module_path });
            return { content: [{ type: "text", text: toon(curateModuleInfo(data)) }] };
        },
    );

    // ---- get_project_overview ----
    // GET-only — bespoke handler since `dispatchTool` is POST-only.
    registerEnrichmentTool(
        "get_project_overview",
        {
            description: "Returns the top-level overview of the indexed project: a paragraph summarizing the overall architecture, a longer document explaining the system's design and conventions, and the list of top-level modules with each one's path, summary, and file count. Takes no arguments — the project is implicit. Use this as the first call when starting work on an unfamiliar project to orient before drilling deeper. It will not provide details of any individual module's contents or any file. If the project overview is unavailable, the response carries `degraded: true` and the summary fields are empty.",
            inputSchema: z.object({})
        },
        async (args: any) => {
            const publicToken = getPublicToken();
            let data: any;
            if (publicToken) {
                data = await callPublicAPIPost(publicToken, 'project-overview', {});
            } else {
                const projectId = resolveProjectId(args);
                const branch = resolveBranch(args);
                const url = `/api/v1/mcp/project-overview?project_id=${encodeURIComponent(projectId)}&branch=${encodeURIComponent(branch)}`;
                const response = await fetch(`${getBaseUrl()}${url}`, { method: 'GET', headers: getAuthHeaders() });
                if (!response.ok) handleApiError(response, await response.text(), {});
                data = await response.json();
            }
            return { content: [{ type: "text", text: toon(curateProjectOverview(data)) }] };
        },
    );

    // ---- get_call_chain ----
    // Wire change vs pre-1.0.29: `stats.fan_in`/`stats.fan_out` flipped
    // from `int = 0` to `Optional[int] = None` + `response_model_exclude_none`.
    // Each is now absent (not 0) when the requested direction skips that
    // side — clients reading the field as a number must handle missing.
    server.registerTool(
        "get_call_chain",
        {
            description: "Returns the call graph around a fully-qualified symbol. `callers` lists every function invoking the symbol (walked upward); `callees` lists every function it invokes (walked downward). Each edge carries caller/callee ids, file paths, kind, confidence 0.0-1.0 (edges below 0.6 filtered out), source fragment, and level (1=direct, 2=one hop). `stats.fan_in`/`stats.fan_out` count DIRECT (level-1) only — count `level==1` rows to verify, use full row count for deeper levels. `warnings` flags polymorphic or uncertain resolution. Two empty states exist: `unresolved: true` means the symbol isn't in the call graph (typo, external, or a class identifier — classes aren't callable nodes, use `<file>::<Class>.__init__` or a method fqn); `unresolved: false` with empty `callers`/`callees` (and `fan_in: 0`/`fan_out: 0` for the requested direction) means the symbol IS indexed but has no tracked edges in that direction. Use to trace bug symptom→root cause and validate refactor coverage. Will not return source bodies, file-level imports, or the dependency graph. When the response is trimmed, `truncated` is true and `dropped_count` reports skipped edges — reduce `depth` for a tighter slice.",
            inputSchema: z.object({
                symbol: z.string().describe("Fully qualified symbol identifier in the form '<file_path>::<symbol_name>' for top-level functions, or '<file_path>::<ClassName>.<method_name>' for methods (dot between class and method). The file path is relative to the project root. Bare class identifiers like '<file>::<ClassName>' are not callable nodes — pass '<ClassName>.__init__' for instantiation or '<ClassName>.<method>' for a specific method. The legacy '<file_path>::<ClassName>::<method_name>' shape is also accepted for back-compat with pre-1.0.29 saved fqns. If you don't know the fully qualified id, locate the symbol's definition first via `get_symbol` or `get_file`."),
                direction: z.enum(["callers", "callees", "both"]).optional().describe("Which side of the call graph to walk. 'callers' returns every function that invokes this symbol (the graph walked upward from the symbol). 'callees' returns every function this symbol invokes (the graph walked downward). 'both' returns both sides in one response. Choose a single side when you only need one to save response size."),
                depth: z.number().int().optional().describe("How many levels to walk in the call graph. Valid range 1-5. Default 2. Each additional level expands one more layer of indirect callers or callees; deeper levels grow response size quickly."),
            })
        },
        async (args: any) => {
            preflightCallChainSymbol(args.symbol);
            const data = await dispatchTool(args, '/api/v1/mcp/call-chain', 'call-chain', {
                symbol: args.symbol,
                direction: args.direction ?? "both",
                depth: args.depth ?? 2,
            }, { requestedTarget: args.symbol });
            return { content: [{ type: "text", text: toon(curateCallChain(data)) }] };
        },
    );

    // ---- get_symbol ----
    server.registerTool(
        "get_symbol",
        {
            description: "Returns the locations where symbols are defined in the indexed project. Three supported shapes: (1) `name` only — search by symbol name across the project (case-insensitive, ranking exact > prefix > substring). (2) `file_prefix` only — list every symbol whose file_path starts with this prefix (alphabetical by file_path then by name). (3) both — search by name restricted to the subtree. At least one of `name` or `file_prefix` is REQUIRED; unscoped project-wide queries are rejected. Each hit includes the symbol's name as written in source, its kind (function, class, method, constant, interface, struct, enum, trait, variable, attribute), the file path, a ready-to-chain `fqn` (`<file_path>::<name>` for top-level symbols, `<file_path>::<Class>.<method>` for methods — pass it straight into `get_call_chain` without reformatting), its signature, the parent class or module chain, the async flag, and any decorators applied. Use `kind` to filter to one symbol type. It will not return who calls the symbol, what the symbol calls, the source body, or any cross-file relationship.",
            inputSchema: z.object({
                name: z.string().min(1).optional().describe("Symbol name to locate. Matched case-insensitively across symbol definitions. Ranking: exact match > prefix > substring; `PIPELINECOSTTRACKER` and `PipelineCostTracker` both surface the exact-cased definition above any substring matches. Required when `file_prefix` is omitted."),
                file_prefix: z.string().min(1).optional().describe("Path prefix that scopes the search to files whose path starts with it (e.g. 'applications/drive/' to scope to one app, or a single file path to scope to one file). Required when `name` is omitted. When supplied with `name`, narrows the name search to this subtree. When supplied without `name`, returns every symbol under the prefix."),
                kind: z.enum(["function", "class", "method", "constant", "interface", "struct", "enum", "trait", "module", "variable", "attribute", "any"]).optional().describe("Restrict results to a specific symbol kind. 'function' covers top-level callables and arrow functions; 'class' covers class definitions; 'method' covers class members; 'constant' covers top-level constants; 'interface' (TypeScript/Java); 'struct' (Go/C/Rust); 'enum'; 'trait' (Rust); 'module'; 'variable' (mutable top-level); 'attribute' (class field). Default 'any' returns all kinds."),
                limit: z.number().int().optional().describe("Maximum number of hits to return. Default 10."),
            })
        },
        async (args: any) => {
            if (!args.name && !args.file_prefix) {
                throw new Error("get_symbol: provide at least one of `name` (search by symbol name) or `file_prefix` (list/scope by path prefix). Both may be combined.");
            }
            const payload: Record<string, unknown> = {
                kind: args.kind || "any",
                limit: args.limit ?? 10,
            };
            if (args.name) payload.name = args.name;
            if (args.file_prefix) payload.file_prefix = args.file_prefix;
            const data = await dispatchTool(args, '/api/v1/mcp/find-symbols', 'find-symbols', payload, { requestedTarget: args.name });
            const curated = curateSymbols(data, args.name);
            let text = toon(curated);
            const hits: any[] = Array.isArray((curated as any)?.results) ? (curated as any).results : [];
            if (hits.length > 0) {
                const lines: string[] = [];
                const topN = Math.min(hits.length, 3);
                for (let i = 0; i < topN; i++) {
                    const h = hits[i];
                    const fqn = h?.fqn || (h?.file_path && h?.name ? h.file_path + '::' + h.name : undefined);
                    if (fqn) lines.push(`Walk callers/callees: get_call_chain(symbol="${fqn}", direction="both")`);
                }
                if (hits.length > topN) {
                    lines.push(`(${hits.length - topN} more hits — pass their \`fqn\` to get_call_chain when you need their call graph)`);
                }
                if (lines.length > 0) text += '\n\n' + lines.join('\n');
            }
            return { content: [{ type: "text", text }] };
        },
    );

    // ---- get_pr_insights ----
    registerEnrichmentTool(
        "get_pr_insights",
        {
            description: "Returns recorded design knowledge for one file or module path. Two kinds are returned. An invariant is a rule the code must not violate (captured after an incident, production bug, or code-review correction); it carries `rule`, `severity` (critical/high/medium/low), `consequence` of violation, `reason`, and `pr_grounding` citing the PRs or commits that established it. A decision is a deliberate design choice; it carries `choice`, `importance` (0.0-1.0), `tradeoffs`, `alternatives_rejected`, and `pr_grounding`. Invariants rank by severity, decisions by importance, both capped by `limit_per_type`. Module-level queries aggregate insights from every file in the module (so a module target returns a superset of any single member file's results). Use this BEFORE editing a subsystem to learn the rules that must not break and the reasoning behind the current code shape. It will not return file structure, dependency relationships, call graphs, or source code. If no knowledge exists for this project, `degraded: true` and empty results mean the knowledge layer is absent, not that no rule applies.",
            inputSchema: z.object({
                target: z.string().describe("File path or module path whose recorded knowledge you want, relative to the project root. File targets return file-scoped insights; module targets aggregate insights from every contained file. Discover valid paths from `get_project_overview` (top_level_modules) plus `get_module_info` (files, child_modules)."),
                limit_per_type: z.number().int().optional().describe("Maximum number of items to return per category (invariants, decisions). Valid range 1-10. Default 5. Items are pre-ranked: invariants by severity, decisions by importance."),
            })
        },
        async (args: any) => {
            const target = args.target ? normalizePath(args.target) : undefined;
            if (!target) throw new Error("get_pr_insights: `target` is required");
            const payload: Record<string, unknown> = { target };
            if (typeof args.limit_per_type === 'number') payload.limit_per_type = args.limit_per_type;
            const data = await dispatchTool(args, '/api/v1/mcp/pr-insights', 'pr-insights', payload, { requestedTarget: args.target });
            return { content: [{ type: "text", text: toon(curateKnowledge(data)) }] };
        },
    );

    // ---- ask_codebase ----
    registerEnrichmentTool(
        "ask_codebase",
        {
            description: "Returns a written natural-language answer to a question about how the indexed codebase works, with the source file paths it was synthesized from. The answer is generated by retrieving from indexed file and module summaries and synthesizing prose with inline file-path citations; `citations` lists those paths separately for follow-up. The response also carries `confidence` (\"high\" when the retriever found strong matches; \"low\" when matches were weak and the answer is best-effort) and `fallback_targets` listing likely-relevant files when confidence is low. Use this as the canonical bridge from a problem statement to the entry-point files: pass the problem in, then drill into the cited paths. Also fits cross-cutting \"how does X work end-to-end?\" questions that span many files. It will not return raw source code, symbol definitions, call relationships, or recorded design knowledge. If no summary corpus exists, `degraded: true` and the answer is empty.",
            inputSchema: z.object({
                question: z.string().describe("A natural-language question about how the codebase works. The question should be a complete sentence or phrase (e.g. 'How does authentication work?', 'What writes to the call_graph collection?', 'Which components subscribe to the user_updated event?'). Cross-cutting and narrative questions are the right fit; pinpoint lookups for a specific symbol or file are not."),
                top_n: z.number().int().optional().describe("Maximum number of source files to cite in the answer. Valid range 1-20. Default 5. Widen this when the question spans many files (e.g. a system-wide feature); keep it narrow when the question is focused."),
                use_modules: z.boolean().optional().describe("Override whether the retriever blends in module-level narratives along with file summaries. Defaults to the project's configured behavior. Set to false when the project has sparse or low-quality module narratives so they don't dilute file-level retrieval."),
            })
        },
        async (args: any) => {
            const payload: Record<string, unknown> = { question: args.question };
            if (typeof args.top_n === 'number') payload.top_n = args.top_n;
            if (typeof args.use_modules === 'boolean') payload.use_modules = args.use_modules;
            const data = await dispatchTool(args, '/api/v1/mcp/ask-codebase', 'ask-codebase', payload);
            return { content: [{ type: "text", text: toon(curateAskCodebase(data)) }] };
        },
    );

    // ---- update_graph ----
    // All writes are queued for owner approval before they apply.
    const EDIT_OPERATIONS = {
        edit_file_summary: {
            method: 'PUT' as const,
            endpoint: (projectId: string) => `/api/project/${projectId}/drg/file-summary`,
            buildPayload: (args: any) => ({ id: normalizePath(args.file_path), summary: args.summary }),
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
            buildPayload: (args: any) => ({ module_name: args.module_name, content: args.content }),
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
            description: "Records a proposed change to the project's knowledge or dependency graph — the only write tool here. Each call describes one `operation`: annotating a file summary, dependency summary, or module narrative; adding/removing an explicit-import edge between two files; or adding/editing/ignoring/deleting an implicit runtime-coupling edge (Redis channel, event bus, shared cache, shared config). Every write is queued — NOT applied immediately, even for owners. Response: `applied: false`, a `pending_edit_id` UUID, and a status message; the change applies only after a project owner approves it via a separate review. When approved, content is APPENDED as a learning entry (never overwriting) preserving the audit trail. Use this to record session discoveries worth keeping. Will not return current state, a diff, or any read of the graph. Same edit submitted twice queues twice — no idempotency.",
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
                ]).describe("Which kind of edit to record. 'edit_file_summary', 'edit_dependency_summary', 'edit_module_doc' attach a freeform annotation to an existing target. 'add_dependency'/'delete_dependency' and 'add_dependent'/'delete_dependent' adjust the file's explicit-import edge list. 'add_implicit_dependency'/'edit_implicit_dependency'/'delete_implicit_dependency' record or remove a runtime-coupling edge (Redis channel, event bus, shared cache, shared config) that static analysis missed. 'ignore_implicit_dependency' marks a previously detected implicit edge as a false positive and hides it from future responses."),
                file_path: z.string().optional().describe("Path of the file the edit applies to, relative to the project root. Required for edit_file_summary, edit_dependency_summary, add_dependency, delete_dependency, add_dependent, delete_dependent."),
                dependency_path: z.string().optional().describe("Path of the other file in a dependency edge, relative to the project root. Required for edit_dependency_summary, add_dependency, delete_dependency."),
                dependent_path: z.string().optional().describe("Path of the file that depends on `file_path`, relative to the project root. Required for add_dependent, delete_dependent."),
                source_file: z.string().optional().describe("Path of the originating file in an implicit-coupling edge, relative to the project root. Required for add_implicit_dependency, edit_implicit_dependency, ignore_implicit_dependency, delete_implicit_dependency."),
                dep_file: z.string().optional().describe("Path of the destination file in an implicit-coupling edge, relative to the project root. Required for add_implicit_dependency, edit_implicit_dependency, ignore_implicit_dependency, delete_implicit_dependency."),
                module_name: z.string().optional().describe("Path or name of the module the edit applies to. Required for edit_module_doc."),
                summary: z.string().optional().describe("Plain-language annotation text to record. Required for edit_file_summary, edit_dependency_summary. Optional for add_dependency, add_dependent."),
                content: z.string().optional().describe("Full narrative markdown body to record on a module. Required for edit_module_doc."),
                edge_summary: z.string().optional().describe("Short description of the coupling mechanism (e.g. 'Redis channel: user_updated', 'shared config key: feature_flags'). Optional for add_implicit_dependency, edit_implicit_dependency."),
            })
        },
        async (args: any) => {
            // Public-token sessions (lgraph join -p <token>) are read-only by
            // design — short-circuit before the network call so users see a
            // clear message instead of a raw 401/403 from /api/project/...
            if (getPublicToken()) {
                throw new Error(
                    "update_graph isn't available in public read-only mode. " +
                    "Sign up and run `lgraph join` as a contributor to submit edits for owner approval."
                );
            }
            const operation = args.operation as EditOperation;
            const config = EDIT_OPERATIONS[operation];
            if (!config) {
                throw new Error(`Unknown operation: ${operation}. Valid operations: ${Object.keys(EDIT_OPERATIONS).join(', ')}`);
            }
            const missingParams = config.requiredParams.filter(param => !args[param]);
            if (missingParams.length > 0) {
                throw new Error(`Missing required parameters for ${operation}: ${missingParams.join(', ')}`);
            }
            const projectId = resolveProjectId(args);
            const branch = resolveBranch(args);
            const endpoint = config.endpoint(projectId);
            const payload: Record<string, unknown> = { ...config.buildPayload(args), branch };
            const data = await callMcpEdit(config.method, endpoint, payload);
            return { content: [{ type: "text", text: formatEditReceipt(data, config.label) }] };
        },
    );

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Latentgraph MCP Server running on stdio");
    if (!process.env.LGRAPH_PUBLIC_TOKEN && !process.env.LGRAPH_PROJECT_ID) {
        console.error("Warning: neither LGRAPH_PUBLIC_TOKEN nor LGRAPH_PROJECT_ID is set. Pass project_id in each tool call, or set the env var.");
    }
}
