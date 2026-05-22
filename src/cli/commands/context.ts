/**
 * `lgraph context` — returns a compact markdown blob with the things the
 * graph knows that a file can't reveal on its own: reverse-deps, implicit
 * coupling, module role, blast-radius.
 *
 * Consumed by AI coding-tool hooks (latent-code PreToolUse, Claude Code
 * PreToolUse, Copilot preToolUse, etc.) to pre-inject context before the
 * agent reads a source file.
 *
 * Output contract (intentional):
 *   - stdout is plain markdown, never JSON — hooks just concatenate it.
 *   - Non-indexed files print NOTHING and exit 0 (avoid wasted tokens).
 *   - Missing graph data prints NOTHING and exits 0 (fail-soft).
 *   - All errors are written to stderr and we exit 0 anyway, so a broken
 *     hook never breaks the host agent.
 */

import { getApiKey, API_BASE_URL } from '../../utils/config.js';
import {
    formatHookContext,
    isIndexedSourceFile,
    type FileSummaryPartial,
    type DependenciesPartial,
    type BlastRadiusPartial,
} from '../../utils/context-formatter.js';

interface ContextCommandOptions {
    filePath?: string;
    fromStdin?: boolean;
}

/**
 * Normalize a path to match how the backend stores indexed file paths
 * (always forward slashes, always relative to project root). If an absolute
 * path is given and a project root (cwd) is known, strip the root prefix.
 */
function normalizePath(filePath: string, projectRoot?: string): string {
    let p = filePath.replace(/\\/g, '/');
    if (projectRoot) {
        const root = projectRoot.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
        if (p.startsWith(root)) {
            p = p.slice(root.length);
        }
    }
    p = p.replace(/^\.\//, '');
    p = p.replace(/^\//, '');
    return p;
}

/**
 * Extract file_path AND cwd from the stdin JSON the host agent pipes to us.
 * cwd is needed to turn absolute file paths (latent-code, Claude Code) back
 * into project-relative paths (the only shape the graph index knows).
 */
async function readHookInputFromStdin(): Promise<{ filePath: string | null; cwd: string | null }> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString('utf-8').trim();
    if (!raw) return { filePath: null, cwd: null };
    try {
        const obj = JSON.parse(raw);
        const args = obj?.tool_args ?? obj?.toolArgs ?? obj;
        const path = args?.file_path ?? args?.filePath ?? args?.path;
        const cwd = obj?.cwd ?? null;
        return {
            filePath: typeof path === 'string' && path.length > 0 ? path : null,
            cwd: typeof cwd === 'string' && cwd.length > 0 ? cwd : null,
        };
    } catch {
        return { filePath: null, cwd: null };
    }
}

/** POST to a backend endpoint with the auth header. Returns null on failure. */
async function safePost<T>(endpoint: string, body: Record<string, unknown>, signal: AbortSignal): Promise<T | null> {
    const apiKey = process.env.LGRAPH_API_KEY?.trim() || getApiKey();
    if (!apiKey) return null;
    try {
        const res = await fetch(`${API_BASE_URL}${endpoint}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
            signal,
        });
        if (!res.ok) return null;
        return (await res.json()) as T;
    } catch {
        return null;
    }
}

export async function contextCommand(opts: ContextCommandOptions): Promise<void> {
    let filePath = opts.filePath;
    let cwd: string | null = null;
    if (opts.fromStdin) {
        const stdinInput = await readHookInputFromStdin();
        if (stdinInput.filePath) filePath = stdinInput.filePath;
        cwd = stdinInput.cwd;
    }

    if (!filePath) {
        // No file_path supplied; silent exit so we never break a hook.
        return;
    }

    if (!isIndexedSourceFile(filePath)) return;

    const projectId = process.env.LGRAPH_PROJECT_ID?.trim();
    if (!projectId) {
        // Without a project the backend calls cannot be issued. Silent exit.
        return;
    }

    const normalized = normalizePath(filePath, cwd ?? undefined);
    const controller = new AbortController();
    const timeoutMs = Number(process.env.LGRAPH_CONTEXT_TIMEOUT_MS ?? 4000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const [fileSummary, deps, blast] = await Promise.all([
            safePost<FileSummaryPartial>('/api/v1/mcp/what-is-this-file', {
                path: normalized,
                project_id: projectId,
                level: 0,
            }, controller.signal),
            safePost<DependenciesPartial>('/api/v1/mcp/dependency', {
                path: normalized,
                project_id: projectId,
            }, controller.signal),
            safePost<BlastRadiusPartial>('/api/v1/mcp/blast-radius', {
                path: normalized,
                project_id: projectId,
            }, controller.signal),
        ]);

        const out = formatHookContext({
            filePath: normalized,
            fileSummary,
            dependencies: deps,
            blastRadius: blast,
        });

        if (out) process.stdout.write(out + '\n');
    } finally {
        clearTimeout(timer);
    }
}
