import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Global config location: ~/.lgraph/config.json
const GLOBAL_LGRAPH_DIR = path.join(os.homedir(), '.lgraph');
const GLOBAL_CONFIG_FILE = path.join(GLOBAL_LGRAPH_DIR, 'config.json');

// Local config location: .lgraph/ in current directory
const LOCAL_LGRAPH_DIR = '.lgraph';
const LOCAL_CONFIG_FILE = 'config.json';  // Changed from project.json to match extension
const DAEMON_PID_FILE = 'daemon.pid';
const DAEMON_STATUS_FILE = 'daemon.status.json';

// Default URLs
const DEFAULT_API_URL = 'https://latentgraph.latentforce.ai';
const DEFAULT_ORCH_URL = 'https://latentgraph-orch.latentforce.ai';
const DEFAULT_WS_URL = 'wss://latentgraph-orch.latentforce.ai';

// Default URLs (local development)
// const DEFAULT_API_URL = 'http://localhost:9000';
// const DEFAULT_ORCH_URL = 'http://localhost:9999';
// const DEFAULT_WS_URL = 'ws://localhost:9999';
export interface GlobalConfig {
    api_key: string;
    key_type?: 'paid' | 'guest';
    // Environment URLs (stored for global npm installs)
    api_url?: string;
    orch_url?: string;
    ws_url?: string; 
    // Optional GitHub token for PR enrichment (Phase 6)
    github_token?: string;
}

// Helper to get URL from: 1) env var, 2) global config, 3) default
function getConfiguredUrl(envVar: string, configKey: 'api_url' | 'orch_url' | 'ws_url', defaultUrl: string): string {
    // Priority: Environment variable > Global config > Default
    if (process.env[envVar]) {
        return process.env[envVar]!;
    }
    const config = readGlobalConfigInternal();
    if (config?.[configKey]) {
        return config[configKey]!;
    }
    return defaultUrl;
}

// Internal read to avoid circular dependency
function readGlobalConfigInternal(): GlobalConfig | null {
    try {
        if (fs.existsSync(GLOBAL_CONFIG_FILE)) {
            const content = fs.readFileSync(GLOBAL_CONFIG_FILE, 'utf-8');
            return JSON.parse(content) as GlobalConfig;
        }
    } catch {
        // Invalid config, treat as not existing
    }
    return null;
}

// API URLs - Priority: env var > global config > default
export const API_BASE_URL = getConfiguredUrl('LGRAPH_API_URL', 'api_url', DEFAULT_API_URL);
export const API_BASE_URL_ORCH = getConfiguredUrl('LGRAPH_ORCH_URL', 'orch_url', DEFAULT_ORCH_URL);
export const WS_URL = getConfiguredUrl('LGRAPH_WS_URL', 'ws_url', DEFAULT_WS_URL);

// Matching extension's .lgraph/config.json structure
export interface ProjectConfig {
    project_id: string;
    project_name: string;
    agents: AgentInfo[];
    created_at: string;
    role?: 'contributor' | 'public';  // set when joined via 'lgraph join'; absent means owner
    public_token?: string;            // set when role='public'; used by MCP server to call public endpoints
    drg_last_indexed_commit?: string;       // git SHA stored after each successful DRG update
    file_index_last_commit?: string;        // git SHA stored after each successful file index update
    implicit_last_indexed_commit?: string;  // git SHA stored after each successful implicit-dep update
    last_analyzed_at?: string;  // ISO timestamp of the most recent successful 'lgraph analyze'
    // Branch support for team collaboration
    default_branch?: string;          // the branch set during init (e.g., "main")
    user_branch?: string;             // the user's own branch (same as default for owner, custom for contributor)
    source_branch?: string;           // for contributors: which branch they copied from
}

export interface AgentInfo {
    agent_id: string;
    agent_name: string;
    agent_type: string;
    created_at: string;
}

export interface DaemonStatus {
    pid: number;
    connected: boolean;
    project_id: string;
    started_at: string;
}

// --- Global Config Functions ---

export function ensureGlobalLgraphDir(): void {
    if (!fs.existsSync(GLOBAL_LGRAPH_DIR)) {
        fs.mkdirSync(GLOBAL_LGRAPH_DIR, { recursive: true });
    }
}

export function readGlobalConfig(): GlobalConfig | null {
    try {
        if (fs.existsSync(GLOBAL_CONFIG_FILE)) {
            const content = fs.readFileSync(GLOBAL_CONFIG_FILE, 'utf-8');
            return JSON.parse(content) as GlobalConfig;
        }
    } catch {
        // Invalid config, treat as not existing
    }
    return null;
}

export function writeGlobalConfig(config: GlobalConfig): void {
    ensureGlobalLgraphDir();
    fs.writeFileSync(GLOBAL_CONFIG_FILE, JSON.stringify(config, null, 2));
}

export function getApiKey(): string | null {
    const config = readGlobalConfig();
    return config?.api_key || null;
}

export function setApiKey(apiKey: string): void {
    const config = readGlobalConfig() || { api_key: '' };
    config.api_key = apiKey;
    delete config.key_type;
    writeGlobalConfig(config);
}

export function setGuestKey(apiKey: string): void {
    const config: GlobalConfig = {
        api_key: apiKey,
        key_type: 'guest',
    };
    writeGlobalConfig(config);
}

export function isGuestKey(): boolean {
    const config = readGlobalConfig();
    return config?.key_type === 'guest';
}

export function clearApiKey(): void {
    const config = readGlobalConfig() || { api_key: '' };
    config.api_key = '';
    delete config.key_type;
    writeGlobalConfig(config);
}

export function getGithubToken(): string | null {
    const config = readGlobalConfig();
    return config?.github_token || null;
}

export function setGithubToken(token: string): void {
    const config = readGlobalConfig() || { api_key: '' };
    config.github_token = token;
    writeGlobalConfig(config);
}

export function clearGithubToken(): void {
    const config = readGlobalConfig() || { api_key: '' };
    delete config.github_token;
    writeGlobalConfig(config);
}

// --- URL Configuration Functions ---

export function setApiUrl(url: string): void {
    const config = readGlobalConfig() || { api_key: '' };
    config.api_url = url;
    writeGlobalConfig(config);
}

export function setOrchUrl(url: string): void {
    const config = readGlobalConfig() || { api_key: '' };
    config.orch_url = url;
    writeGlobalConfig(config);
}

export function setWsUrl(url: string): void {
    const config = readGlobalConfig() || { api_key: '' };
    config.ws_url = url;
    writeGlobalConfig(config);
}

export function clearUrls(): void {
    const config = readGlobalConfig() || { api_key: '' };
    delete config.api_url;
    delete config.orch_url;
    delete config.ws_url;
    writeGlobalConfig(config);
}

export function getConfiguredUrls(): { api_url: string; orch_url: string; ws_url: string } {
    return {
        api_url: getConfiguredUrl('LGRAPH_API_URL', 'api_url', DEFAULT_API_URL),
        orch_url: getConfiguredUrl('LGRAPH_ORCH_URL', 'orch_url', DEFAULT_ORCH_URL),
        ws_url: getConfiguredUrl('LGRAPH_WS_URL', 'ws_url', DEFAULT_WS_URL),
    };
}

// --- Local Config Functions ---

/**
 * Find the project root by walking up directories looking for .lgraph folder.
 * Returns null if not found.
 */
function findProjectRoot(startDir: string): string | null {
    let current = startDir;
    const root = path.parse(current).root;

    while (current !== root) {
        const lgraphDir = path.join(current, LOCAL_LGRAPH_DIR);
        if (fs.existsSync(lgraphDir)) {
            return current;
        }
        current = path.dirname(current);
    }
    return null;
}

export function getLocalLgraphDir(projectRoot?: string): string {
    // Priority: explicit arg > auto-detect by walking up > cwd
    if (projectRoot) {
        return path.join(projectRoot, LOCAL_LGRAPH_DIR);
    }
    // Auto-detect: walk up from cwd to find .lgraph
    const cwd = process.cwd();
    const detected = findProjectRoot(cwd);
    if (detected) {
        return path.join(detected, LOCAL_LGRAPH_DIR);
    }
    // Fallback to cwd
    return path.join(cwd, LOCAL_LGRAPH_DIR);
}

export function ensureLocalLgraphDir(projectRoot?: string): void {
    const dir = getLocalLgraphDir(projectRoot);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

const SCAN_TARGET_TEMPLATE = [
    {
        language: null,
        path: '',
    },
];

/**
 * Create .lgraph/scan_target.json with a template if it doesn't exist.
 * Users can edit this file to manually specify scan targets.
 */
export function ensureScanTargetFile(projectRoot?: string): void {
    const filePath = path.join(getLocalLgraphDir(projectRoot), 'scan_target.json');
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, JSON.stringify(SCAN_TARGET_TEMPLATE, null, 2));
    }
}

export function readProjectConfig(projectRoot?: string): ProjectConfig | null {
    try {
        const filePath = path.join(getLocalLgraphDir(projectRoot), LOCAL_CONFIG_FILE);
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf-8');
            return JSON.parse(content) as ProjectConfig;
        }
    } catch {
        // Invalid config, treat as not existing
    }
    return null;
}

export function writeProjectConfig(config: ProjectConfig, projectRoot?: string): void {
    ensureLocalLgraphDir(projectRoot);
    const filePath = path.join(getLocalLgraphDir(projectRoot), LOCAL_CONFIG_FILE);
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2));

    // Also create .gitignore in .lgraph folder (matching extension)
    const gitignorePath = path.join(getLocalLgraphDir(projectRoot), '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
        fs.writeFileSync(gitignorePath, '*\n!.gitignore\n!config.json\n!scan_target.json\n');
    }

    // Create scan_target.json template if it doesn't exist
    ensureScanTargetFile(projectRoot);
}

export function getProjectId(projectRoot?: string): string | null {
    const config = readProjectConfig(projectRoot);
    return config?.project_id || null;
}

/**
 * Returns true if this directory was joined as a read-only viewer (contributor OR public).
 * Checks both the role field AND the presence of public_token so that manually removing
 * the role field without removing the token still blocks write operations.
 */
export function isReadOnlyProject(projectRoot?: string): { readOnly: boolean; reason: 'contributor' | 'public' | null } {
    const config = readProjectConfig(projectRoot);
    if (!config) return { readOnly: false, reason: null };
    if (config.role === 'contributor') return { readOnly: true, reason: 'contributor' };
    if (config.role === 'public' || config.public_token) return { readOnly: true, reason: 'public' };
    return { readOnly: false, reason: null };
}

export function getProjectName(projectRoot?: string): string | null {
    const config = readProjectConfig(projectRoot);
    return config?.project_name || null;
}

export function getUserBranch(projectRoot?: string): string | null {
    const config = readProjectConfig(projectRoot);
    return config?.user_branch || config?.default_branch || null;
}

export function getDefaultBranch(projectRoot?: string): string | null {
    const config = readProjectConfig(projectRoot);
    return config?.default_branch || null;
}

export function isPublicProject(projectRoot?: string): boolean {
    const config = readProjectConfig(projectRoot);
    return config?.role === 'public' || !!config?.public_token;
}

export function setProject(projectId: string, projectName: string, projectRoot?: string): void {
    const existing = readProjectConfig(projectRoot);
    const config: ProjectConfig = {
        project_id: projectId,
        project_name: projectName,
        agents: existing?.agents || [],
        created_at: existing?.created_at || new Date().toISOString(),
    };
    writeProjectConfig(config, projectRoot);
}

// --- Daemon Status Functions ---

export function getDaemonPidPath(projectRoot?: string): string {
    return path.join(getLocalLgraphDir(projectRoot), DAEMON_PID_FILE);
}

export function getDaemonStatusPath(projectRoot?: string): string {
    return path.join(getLocalLgraphDir(projectRoot), DAEMON_STATUS_FILE);
}

export function readDaemonPid(projectRoot?: string): number | null {
    try {
        const filePath = getDaemonPidPath(projectRoot);
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf-8').trim();
            const pid = parseInt(content, 10);
            return isNaN(pid) ? null : pid;
        }
    } catch {
        // Error reading PID file
    }
    return null;
}

export function writeDaemonPid(pid: number, projectRoot?: string): void {
    ensureLocalLgraphDir(projectRoot);
    const filePath = getDaemonPidPath(projectRoot);
    fs.writeFileSync(filePath, String(pid));
}

export function removeDaemonPid(projectRoot?: string): void {
    const filePath = getDaemonPidPath(projectRoot);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }
}

export function readDaemonStatus(projectRoot?: string): DaemonStatus | null {
    try {
        const filePath = getDaemonStatusPath(projectRoot);
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf-8');
            return JSON.parse(content) as DaemonStatus;
        }
    } catch {
        // Invalid status file
    }
    return null;
}

export function writeDaemonStatus(status: DaemonStatus, projectRoot?: string): void {
    ensureLocalLgraphDir(projectRoot);
    const filePath = getDaemonStatusPath(projectRoot);
    fs.writeFileSync(filePath, JSON.stringify(status, null, 2));
}

export function removeDaemonStatus(projectRoot?: string): void {
    const filePath = getDaemonStatusPath(projectRoot);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }
}

// --- Process Check ---

export function isProcessRunning(pid: number): boolean {
    try {
        // Sending signal 0 checks if process exists without killing it
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}
