import * as https from 'node:https';
import * as http from 'node:http';
import { API_BASE_URL, API_BASE_URL_ORCH } from './config.js';

function parseInsufficientCreditsMessage(body: string): string {
    try {
        const detail = JSON.parse(body)?.detail;
        const msg = typeof detail === 'object' ? (detail?.message ?? body) : (detail ?? body);
        return `Insufficient credits: ${msg}`;
    } catch {
        return `Insufficient credits: ${body}`;
    }
}

export interface Project {
    project_id: string;
    project_name: string;
    description?: string;
}

export interface ScanTarget {
    language: string | null;
    path: string;
}

export interface FileWithContent {
    file_path: string;
    content: string;
}

export interface InitScanPayload {
    project_id: string;
    project_tree: any;
    git_info: {
        current_branch: string;
        original_branch: string;
        migrate_branch: string;
        has_uncommitted_changes: boolean;
    };
    file_manifest: {
        all_files: string[];
        categorized: {
            source_files: string[];
            config_files: string[];
            asset_files: string[];
        };
    };
    metadata: {
        extension_version: string;
        scan_timestamp: string;
        project_name: string;
    };
    scan_targets?: ScanTarget[] | null;
    total_loc?: number;
    /** When set, orchestrator can run pipeline inline (e.g. LOCAL mode) and index via init-scan */
    files?: FileWithContent[] | null;
    github_token?: string;
    /** The branch being indexed - will be set as the default branch for this project */
    default_branch?: string;
}

export interface InitScanResponse {
    /** @deprecated Use source_files_count. Orchestrator returns source_files_count. */
    files_read?: number;
    /** @deprecated Orchestrator does not return files_failed. */
    files_failed?: number;
    /** Number of source files queued or indexed (orchestrator). */
    source_files_count?: number;
    agents_created?: {
        theme_planner?: {
            agent_id: string;
            agent_name: string;
        };
    };
    next_steps?: string[];
    message?: string;
}

export interface SharedProject extends Project {
    role: string;
}

export interface PublicProjectInfo {
    project_id: string;
    project_name: string;
    description: string;
    allowed_features: string[];
}

/**
 * Fetch public project info by share token (no auth required).
 * Calls GET /api/public/{token}/join — the dedicated join endpoint, which
 * returns the same payload as /info but records the join server-side.
 */
export async function fetchPublicProjectInfo(token: string): Promise<PublicProjectInfo> {
    // Only called by `lgraph join -p`. Hitting /join is what records the join —
    // no headers or API key needed; the count can't be inflated by browser views.
    const response = await fetch(`${API_BASE_URL}/api/public/${encodeURIComponent(token)}/join`, {
        method: 'GET',
    });

    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();

    // Detect HTML response (SPA fallback or proxy error page)
    if (!contentType.includes('application/json') || text.trimStart().startsWith('<')) {
        throw new Error(
            `Server returned a non-JSON response for /api/public/${token}/join.\n` +
            `  This usually means the public share feature is not yet deployed on the server.\n` +
            `  Server: ${API_BASE_URL}  Status: ${response.status}`
        );
    }

    if (!response.ok) {
        if (response.status === 404) {
            throw new Error('Public share link not found or sharing has been disabled.');
        }
        if (response.status === 410) {
            throw new Error('This public share link has expired.');
        }
        throw new Error(text || `HTTP ${response.status}`);
    }

    return JSON.parse(text);
}

/**
 * Fetch only projects where the user is a contributor (not owner)
 */
export async function fetchSharedProjects(apiKey: string): Promise<SharedProject[]> {
    const response = await fetch(`${API_BASE_URL}/api/v1/mcp/projects/shared`, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
        },
    });

    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();

    if (!contentType.includes('application/json') || text.trimStart().startsWith('<')) {
        throw new Error(
            `Server returned a non-JSON response (status ${response.status}).\n` +
            `  Check your API key and that the server is reachable: ${API_BASE_URL}`
        );
    }

    if (!response.ok) {
        throw new Error(text || `HTTP ${response.status}`);
    }

    const data = JSON.parse(text);
    return data.projects || [];
}

/**
 * Fetch available projects for the user
 * Matching extension's fetchProjects function in api-client.js
 */
export async function fetchProjects(apiKey: string): Promise<Project[]> {
    const response = await fetch(`${API_BASE_URL}/api/v1/mcp/projects`, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
        },
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `HTTP ${response.status}`);
    }

    const data = await response.json();
    return data.projects || [];
}

/**
 * Send init scan to backend
 * Matching extension's init-scan API call
 */
export async function sendInitScan(
    apiKey: string,
    projectId: string,
    payload: InitScanPayload
): Promise<InitScanResponse> {
    try {
        // Ensure proper URL construction with leading slash
        const path = `/api/projects/${projectId}/init-scan`;
        const url = new URL(path, API_BASE_URL_ORCH).toString();
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(text || `HTTP ${response.status}`);
        }

        return await response.json();
    } catch (error) {
        // Re-throw for caller to handle; keep stack/context
        throw error;
    }
}

export interface UpdateDrgFile {
    file_path: string;
    content: string;
}

export interface UpdateDrgChanges {
    added: string[];
    modified: string[];
    deleted: string[];
}

export interface UpdateDrgPayload {
    project_id: string;
    language: string;
    mode: string;
    changes: UpdateDrgChanges;
    files: UpdateDrgFile[];
    branch?: string;  // user's branch to update
    umbrella_id?: string;  // When set, billing is owned by an umbrella reservation
}

export interface UpdateDrgResponse {
    success: boolean;
    message: string;
    language?: string;
}

/**
 * Send update-drg request to backend
 * Calls POST /api/v1/mcp/update-drg
 */
export async function sendUpdateDrg(
    apiKey: string,
    payload: UpdateDrgPayload
): Promise<UpdateDrgResponse> {
    const response = await fetch(`${API_BASE_URL}/api/v1/mcp/update-drg`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const text = await response.text();
        if (response.status === 402) {
            throw new Error(parseInsufficientCreditsMessage(text));
        }
        throw new Error(text || `HTTP ${response.status}`);
    }

    return await response.json();
}

export interface UpdateImplicitFile {
    file_path: string;
    content: string;
}

export interface UpdateImplicitPayload {
    project_id: string;
    changes: { added: string[]; modified: string[]; deleted: string[] };
    files: UpdateImplicitFile[];
    branch?: string;  // user's branch to update
    umbrella_id?: string;  // When set, billing is owned by an umbrella reservation
}

export interface UpdateImplicitResponse {
    success: boolean;
    message: string;
}

/**
 * Send update-implicit request to backend with file contents.
 * Calls POST /api/v1/mcp/update-implicit
 *
 * Uses node:https to avoid fetch/undici timeout limitations.
 * Timeout: 60 seconds (upload only — backend processes async).
 */
export async function sendUpdateImplicit(
    apiKey: string,
    payload: UpdateImplicitPayload,
): Promise<UpdateImplicitResponse> {
    const TIMEOUT_MS = 60 * 1000;
    const body = JSON.stringify(payload);
    const urlStr = `${API_BASE_URL}/api/v1/mcp/update-implicit`;

    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(urlStr);
        const contentLength = new TextEncoder().encode(body).length;
        const isHttps = parsedUrl.protocol === 'https:';
        const transport = isHttps ? https : http;

        const options: https.RequestOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Content-Length': contentLength,
            },
            timeout: TIMEOUT_MS,
        };

        const req = transport.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    try { resolve(JSON.parse(data) as UpdateImplicitResponse); }
                    catch { resolve({ success: true, message: data }); }
                } else if (res.statusCode === 402) {
                    reject(new Error(parseInsufficientCreditsMessage(data)));
                } else {
                    reject(new Error(data || `HTTP ${res.statusCode}`));
                }
            });
        });

        req.on('timeout', () => { req.destroy(new Error('Request timed out')); });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ─── update-wiki ────────────────────────────────────────────────────────

export interface UpdateWikiFile {
    file_path: string;
    content: string;
}

export interface UpdateWikiPayload {
    project_id: string;
    files: UpdateWikiFile[];
    branch?: string;  // user's branch to update
    current_commit?: string;  // git HEAD SHA; eliminates A1 proxy call on the server
    changes?: { added: string[]; modified: string[]; deleted: string[] };  // Scopes billing to changed files when present
    umbrella_id?: string;  // When set, billing is owned by an umbrella reservation
}

export interface UpdateWikiStats {
    total_files: number;
    leaf_nodes: number;
    module_count: number;
    docs_updated: number;
    docs_persisted: number;
    docs_patched: number;
    drg_nodes_refreshed: number;
    files_provided: number;
    regen_modules: string[];
    surgical_modules: string[];
    parent_modules: string[];
    cost_usd?: number;
    elapsed_seconds?: number;
}

export interface UpdateWikiResponse {
    success: boolean;
    mode: string;
    message: string;
    stats: UpdateWikiStats;
}

/**
 * Send update-wiki request to backend.
 * Calls POST /api/v1/mcp/update-wiki
 *
 * Uses node:https instead of fetch to avoid:
 *   - Issue 11: undici headersTimeout (300s hardcoded, can't be overridden via fetch API)
 *   - Issue 10: no timeout at all — large repos can hang forever
 *   - Issue 9:  fetch wraps OS errors in err.cause — the real message (ECONNRESET etc.)
 *               was swallowed; node:https surfaces it directly
 */
export async function sendUpdateWiki(
    apiKey: string,
    payload: UpdateWikiPayload,
): Promise<UpdateWikiResponse> {
    const TIMEOUT_MS = 35 * 60 * 1000; // 35 min — server orchestrator limit is 30 min
    const body = JSON.stringify(payload);
    const urlStr = `${API_BASE_URL}/api/v1/mcp/update-wiki`;

    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(urlStr);
        // TextEncoder is a web-standard global — no @types/node needed
        const contentLength = new TextEncoder().encode(body).length;
        const isHttps = parsedUrl.protocol === 'https:';
        const transport = isHttps ? https : http;

        const options: https.RequestOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Content-Length': contentLength,
            },
        };

        const req = transport.request(options, (res) => {
            // Use string mode — avoids Buffer globals entirely
            res.setEncoding('utf8');
            const chunks: string[] = [];
            res.on('data', (chunk: string) => chunks.push(chunk));
            res.on('end', () => {
                const text = chunks.join('');
                if (res.statusCode === 402) {
                    reject(new Error(parseInsufficientCreditsMessage(text)));
                    return;
                }
                if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(text || `HTTP ${res.statusCode}`));
                    return;
                }
                try {
                    resolve(JSON.parse(text) as UpdateWikiResponse);
                } catch {
                    reject(new Error(`Invalid JSON response: ${text.slice(0, 200)}`));
                }
            });
        });

        // Issue 10 + 11: single wall-clock timeout covering upload + processing + response.
        // No headersTimeout exists in node:https — the whole request races this timer.
        req.setTimeout(TIMEOUT_MS, () => {
            req.destroy(new Error(`update-wiki timed out after ${TIMEOUT_MS / 60000} minutes`));
        });

        // Issue 9: node:https surfaces OS errors (ECONNRESET, ECONNREFUSED, etc.) directly
        // in err.message without the extra fetch wrapper layer.
        req.on('error', (err: Error) => reject(err));

        req.write(body);
        req.end();
    });
}

// ─── update-file-index ──────────────────────────────────────────────────────

export interface UpdateFileIndexPayload {
    project_id: string;
    branch?: string;
    current_commit?: string;  // git HEAD SHA; eliminates A1 proxy call on the server
    umbrella_id?: string;  // When set, billing is owned by an umbrella reservation
}

export interface UpdateFileIndexStats {
    files_enriched: number;
    files_total: number;
    files_deleted: number;
    registry_drops_skipped: number;
    tag_count: number;
    elapsed_seconds: number;
    cost_usd?: number;
    enriched_files: string[];
    enriched_file_reasons: Record<string, string>;
    delta_breakdown: Record<string, number>;
}

export interface UpdateFileIndexResponse {
    success: boolean;
    mode: string;
    message: string;
    stats: UpdateFileIndexStats;
}

/**
 * Send update-file-index request to backend.
 * Calls POST /api/v1/mcp/update-file-index
 *
 * Uses node:https to avoid fetch/undici timeout limitations (same as
 * sendUpdateWiki).  Timeout: 35 minutes.
 */
export async function sendUpdateFileIndex(
    apiKey: string,
    payload: UpdateFileIndexPayload,
): Promise<UpdateFileIndexResponse> {
    const TIMEOUT_MS = 35 * 60 * 1000;
    const body = JSON.stringify(payload);
    const urlStr = `${API_BASE_URL}/api/v1/mcp/update-file-index`;

    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(urlStr);
        const contentLength = new TextEncoder().encode(body).length;
        const isHttps = parsedUrl.protocol === 'https:';
        const transport = isHttps ? https : http;

        const options: https.RequestOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Content-Length': contentLength,
            },
        };

        const req = transport.request(options, (res) => {
            res.setEncoding('utf8');
            const chunks: string[] = [];
            res.on('data', (chunk: string) => chunks.push(chunk));
            res.on('end', () => {
                const text = chunks.join('');
                if (res.statusCode === 402) {
                    reject(new Error(parseInsufficientCreditsMessage(text)));
                    return;
                }
                if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(text || `HTTP ${res.statusCode}`));
                    return;
                }
                try {
                    resolve(JSON.parse(text) as UpdateFileIndexResponse);
                } catch {
                    reject(new Error(`Invalid JSON response: ${text.slice(0, 200)}`));
                }
            });
        });

        req.setTimeout(TIMEOUT_MS, () => {
            req.destroy(new Error(`update-file-index timed out after ${TIMEOUT_MS / 60000} minutes`));
        });

        req.on('error', (err: Error) => reject(err));
        req.write(body);
        req.end();
    });
}

// ─── update umbrella (one charge for the whole `lgraph update`) ─────────────

export interface UpdateBeginPayload {
    project_id: string;
    branch?: string;
    loc: number;  // Changed-files LOC (added + modified)
    // Client-generated uuid per `lgraph update` invocation. Server returns
    // the existing reservation if this key matches a still-open umbrella
    // (safe retry on transient network failure).
    idempotency_key?: string;
}

export interface UpdateBeginResponse {
    umbrella_id: string;
    credits_reserved: number;
    loc: number;
    // True when the server returned an existing reservation matched by
    // idempotency_key rather than creating a new one.
    idempotent_replay?: boolean;
}

export interface UpdateFinalizePayload {
    project_id: string;
    umbrella_id: string;
    status: 'success' | 'failed';
    loc?: number;
}

export interface UpdateFinalizeResponse {
    success: boolean;
    noop?: boolean;
    credits_consumed?: number;
    credits_refunded?: number;
}

export async function sendUpdateBegin(
    apiKey: string,
    payload: UpdateBeginPayload,
): Promise<UpdateBeginResponse> {
    const response = await fetch(`${API_BASE_URL}/api/v1/mcp/update-begin`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    });
    if (!response.ok) {
        const text = await response.text();
        if (response.status === 402) {
            throw new Error(parseInsufficientCreditsMessage(text));
        }
        throw new Error(text || `HTTP ${response.status}`);
    }
    return await response.json();
}

export async function sendUpdateFinalize(
    apiKey: string,
    payload: UpdateFinalizePayload,
): Promise<UpdateFinalizeResponse> {
    const response = await fetch(`${API_BASE_URL}/api/v1/mcp/update-finalize`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    });
    if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `HTTP ${response.status}`);
    }
    return await response.json();
}

// ────────────────────────────────────────────────────────────────────────────

export type PipelinePhase =
    | 'reading_files'
    | 'analyzing'
    | 'enriching_files'
    | 'generating_docs'
    | 'indexing_graph'
    | 'enriching_modules'
    | 'completed'
    | 'failed';

export interface DrgUpdateLangStatus {
    status: 'in_progress' | 'completed' | 'failed';
    language?: string | null;
    mode?: 'delta' | 'full' | null;
    targets_total?: number;
    targets_succeeded?: number;
    elapsed_s?: number | null;
    cost_usd?: number | null;
    raw_extraction_ok?: boolean;
    message?: string;
    edge_diff?: { added?: number; removed?: number };
    call_graph_total_edges?: number;
    call_graph_resolution_rate?: number;
    started_at?: string;
    completed_at?: string;
}

export interface ProjectStatusResponse {
    indexed: boolean;
    file_count: number;
    init_scan_status: 'not_started' | 'in_progress' | 'completed' | 'completed_with_warnings' | 'failed';
    implicit_dep_status?: 'not_started' | 'in_progress' | 'resumed' | 'completed' | 'failed' | 'aborted' | 'unknown';
    implicit_dep_mode?: 'noop' | 'delta' | 'full' | null;
    implicit_dep_cost_usd?: number | null;
    implicit_dep_elapsed_s?: number | null;
    drg_update?: Record<string, DrgUpdateLangStatus> | null;
    wiki_updated_at?: string | null;
    file_index_updated_at?: string | null;
    pipeline_phase?: PipelinePhase | null;
    pipeline_phase_started_at?: string | null;
    pipeline_baseline_commit?: string | null;
    elapsed_sec?: number | null;
    branch?: string;
}

// --- Analyze ---

export interface CommitChurn {
    hash: string;
    date: string;
    author: string;
    added: number;
    deleted: number;
    net: number;
}

export interface GitLocChurn {
    churn_by_date: Record<string, { added: number; deleted: number }>;
    per_commit: CommitChurn[];
    total_added: number;
    total_deleted: number;
}

export interface Framework {
    name: string;
    language: string | null;
    source: string;
}

export interface AnalyzePayload {
    project_id: string;
    loc_by_extension: Record<string, number>;
    code_lines_by_extension: Record<string, number>;
    blank_lines_by_extension: Record<string, number>;
    token_count_by_extension: Record<string, number>;
    comment_count_by_extension: Record<string, number>;
    file_count_by_extension: Record<string, number>;
    loc_per_file_by_extension: Record<string, number[]>;
    token_per_file_by_extension: Record<string, number[]>;
    file_paths_by_extension: Record<string, string[]>;
    folder_tree: Record<string, { file_count: number; depth: number }>;
    git_activity: {
        commits_by_date: Record<string, number>;
        commits_by_author: Record<string, number>;
        total_commits: number;
        date_range: { from: string; to: string };
    };
    git_loc_churn: GitLocChurn;
    frameworks: Framework[];
    total_loc: number;
    total_code_lines: number;
    total_blank_lines: number;
    total_tokens: number;
    total_comments: number;
    total_files: number;
    analyzed_at: string;
}

export interface AnalyzeResponse {
    success: boolean;
    message: string;
}

/**
 * Send analyze results to backend
 * Calls POST /api/v1/mcp/analyze
 */
export async function sendAnalyze(
    apiKey: string,
    payload: AnalyzePayload
): Promise<AnalyzeResponse> {
    const response = await fetch(`${API_BASE_URL}/api/v1/mcp/analyze`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `HTTP ${response.status}`);
    }

    return await response.json();
}

// --- Project Creation ---

export interface CreateProjectParams {
    project_name: string;
    description?: string;
}

export async function createProject(apiKey: string, params: CreateProjectParams): Promise<Project> {
    const response = await fetch(`${API_BASE_URL}/api/v1/mcp/projects/create`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ project_name: params.project_name, description: params.description }),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `HTTP ${response.status}`);
    }

    const data = await response.json();
    return data.project || data;
}

/**
 * Fetch project indexing/work status for the given branch.
 * ``branch`` is required — every status field that matters (pipeline_baseline_commit,
 * implicit_dep_status on this branch's last run) is per-branch.
 */
export async function fetchProjectStatus(
    apiKey: string,
    projectId: string,
    branch: string,
): Promise<ProjectStatusResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000); // 30 second timeout

    try {
        const response = await fetch(
            `${API_BASE_URL}/api/v1/mcp/projects/${projectId}/status?branch=${encodeURIComponent(branch)}`,
            {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${apiKey}` },
                signal: controller.signal,
            },
        );

        clearTimeout(timeoutId);

        if (!response.ok) {
            const text = await response.text();
            throw new Error(text || `HTTP ${response.status}`);
        }

        return await response.json();
    } catch (error) {
        clearTimeout(timeoutId);
        throw error;
    }
}

// ─── list-files ─────────────────────────────────────────────────────────────

export interface ListFilesResponse {
    project_id: string;
    files: string[];
    total_files: number;
}

/**
 * Fetch the list of files currently indexed in the project's DRG.
 * Used by analyze to display the backend's authoritative file count.
 */
export async function fetchListFiles(
    apiKey: string,
    projectId: string,
    branch?: string,
): Promise<ListFilesResponse> {
    const controller = new AbortController();
    // Short timeout: this call is just to enrich the CLI display. If the
    // backend is slow/unhealthy, we fall back to the local count quickly
    // instead of blocking the user.
    const timeoutId = setTimeout(() => controller.abort(), 3_000);

    try {
        const params = new URLSearchParams({ project_id: projectId });
        if (branch) params.set('branch', branch);
        const response = await fetch(`${API_BASE_URL}/api/v1/mcp/list-files?${params}`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${apiKey}` },
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const text = await response.text();
            throw new Error(text || `HTTP ${response.status}`);
        }

        return await response.json();
    } catch (error) {
        clearTimeout(timeoutId);
        throw error;
    }
}

// ─── join-branch ────────────────────────────────────────────────────────────

export interface JoinBranchPayload {
    project_id: string;
    source_branch: string;
    user_branch_name: string;
}

export interface JoinBranchResponse {
    success: boolean;
    message: string;
    files_copied?: number;
    default_branch?: string;
}

/**
 * Join a project branch by copying all DRG data from source branch to a new user branch.
 * Calls POST /api/v1/mcp/join-branch
 */
export async function sendJoinBranch(
    apiKey: string,
    payload: JoinBranchPayload
): Promise<JoinBranchResponse> {
    const response = await fetch(`${API_BASE_URL}/api/v1/mcp/join-branch`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `HTTP ${response.status}`);
    }

    return await response.json();
}

// ─── branches ───────────────────────────────────────────────────────────────

export interface BranchInfo {
    branch_name: string;
    is_default: boolean;
    source_branch: string | null;
    user_id: string;
    created_at: string;
    pushed: boolean;
    is_mine: boolean;
}

export interface ListBranchesResponse {
    branches: BranchInfo[];
}

/**
 * List all branches for a project.
 * Calls GET /api/v1/mcp/projects/{project_id}/branches
 */
export async function fetchBranches(
    apiKey: string,
    projectId: string
): Promise<BranchInfo[]> {
    const response = await fetch(`${API_BASE_URL}/api/v1/mcp/projects/${encodeURIComponent(projectId)}/branches`, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
        },
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `HTTP ${response.status}`);
    }

    const data = await response.json();
    return data.branches || [];
}

// ─── push-branch ─────────────────────────────────────────────────────────────

export interface PushBranchPayload {
    project_id: string;
    branch_name?: string;
}

export interface PushBranchResponse {
    success: boolean;
    message: string;
    branch_name: string;
}

/**
 * Push a local branch to make it visible to team members.
 * Calls POST /api/v1/mcp/push-branch
 */
export async function pushBranch(
    apiKey: string,
    payload: PushBranchPayload
): Promise<PushBranchResponse> {
    const response = await fetch(`${API_BASE_URL}/api/v1/mcp/push-branch`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `HTTP ${response.status}`);
    }

    return await response.json();
}

// ─── merge-branch ────────────────────────────────────────────────────────────

export interface MergeBranchPayload {
    project_id: string;
    source_branch: string;
    target_branch: string;
}

export interface MergeBranchResponse {
    success: boolean;
    message: string;
    stats: Record<string, number>;
    total_copied: number;
}

/**
 * Merge DRG data from source branch to target branch.
 * Calls POST /api/v1/mcp/merge-branch
 */
export async function sendMergeBranch(
    apiKey: string,
    payload: MergeBranchPayload
): Promise<MergeBranchResponse> {
    const response = await fetch(`${API_BASE_URL}/api/v1/mcp/merge-branch`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `HTTP ${response.status}`);
    }

    return await response.json();
}


export interface AdvanceBaselinePayload {
    project_id: string;
    branch?: string;
    commit: string;
}

export interface AdvanceBaselineResponse {
    success: boolean;
    project_id: string;
    branch: string;
    last_commit: string;
}

/**
 * Advance pipeline_run_meta.last_commit for (project_id, branch). Called once
 * by `lgraph update` after every phase succeeds — the sole writer of the
 * shared baseline. Phase services (update-drg / -implicit / -wiki /
 * -file-index) are read-only on this key.
 *
 * POST /api/v1/mcp/advance-baseline
 */
export async function sendAdvanceBaseline(
    apiKey: string,
    payload: AdvanceBaselinePayload
): Promise<AdvanceBaselineResponse> {
    const response = await fetch(`${API_BASE_URL}/api/v1/mcp/advance-baseline`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `HTTP ${response.status}`);
    }

    return await response.json();
}
