/**
 * Hook generation for GitHub Copilot integration.
 *
 * Creates a preToolUse hook that injects additional context for source-file
 * reads and searches, nudging Copilot toward lgraph MCP tools before it
 * falls back to raw source inspection. Reminders are emitted once per
 * session per target, so the same file is not repeatedly annotated.
 *
 * Copilot hooks protocol:
 *   Input:  JSON on stdin  { toolName, toolArgs, cwd, timestamp, ... }
 *   Output: JSON on stdout { permissionDecision, additionalContext }
 *
 * Config:  .github/hooks/hooks.json  (version: 1 schema)
 */

import * as fs from 'fs';
import * as path from 'path';

const HOOK_SCRIPT = `#!/usr/bin/env node
"use strict";

/**
 * Latentgraph hook for GitHub Copilot.
 *
 * preToolUse — injects additional context for indexed source-file reads
 *              and searches, pointing Copilot to lgraph MCP tools first.
 *
 * Input:  JSON on stdin  { toolName, toolArgs, cwd, timestamp }
 * Output: JSON on stdout { permissionDecision, additionalContext }
 */

const SOURCE_EXTENSIONS = new Set([
    '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
    '.py',
    '.java',
    '.cpp', '.cc', '.cxx', '.c', '.h', '.hpp',
    '.cs',
    '.go',
    '.css', '.scss',
    '.html',
]);

const NON_SOURCE_EXTENSIONS = new Set([
    '.json', '.yaml', '.yml', '.toml', '.env', '.md', '.txt',
    '.pdf', '.png', '.jpg', '.lock', '.xml', '.csv', '.svg',
    '.gif', '.ico', '.woff', '.woff2', '.ttf', '.eot',
]);

const DEPENDENCY_PATTERNS = [
    /\\bimport\\s/,
    /\\brequire\\s*\\(/,
    /\\bfrom\\s+['"]/,
    /\\bexport\\s/,
    /\\bmodule\\.exports/,
    /uses?\\b.*\\bimport/i,
    /depend/i,
    /call(s|ed|ing)?\\b/i,
];

const STATE_FILE_PREFIX = 'lgraph-copilot-hook-';

// Copilot agent tool names (camelCase and snake_case variants)
const SEARCH_TOOLS = new Set([
    'grepSearch', 'grep_search', 'grep', 'searchCode', 'search_code',
    'fileSearch', 'file_search', 'findFiles', 'find_files', 'glob',
    'semanticSearch', 'semantic_search',
]);
const TERMINAL_TOOLS = new Set([
    'runInTerminal', 'run_in_terminal', 'runCommand', 'run_command',
    'bash', 'shell', 'exec',
]);
const READ_TOOLS = new Set([
    'readFile', 'read_file', 'openFile', 'open_file', 'read',
]);

function isSourceFile(filePath) {
    if (!filePath) return false;
    const ext = require('path').extname(filePath).toLowerCase();
    return SOURCE_EXTENSIONS.has(ext);
}

function isNonSourceFile(filePath) {
    if (!filePath) return false;
    const ext = require('path').extname(filePath).toLowerCase();
    return NON_SOURCE_EXTENSIONS.has(ext);
}

function parseToolArgs(rawArgs) {
    if (!rawArgs) return {};
    if (typeof rawArgs === 'string') {
        try {
            const parsed = JSON.parse(rawArgs);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
            return {};
        }
    }
    return typeof rawArgs === 'object' ? rawArgs : {};
}

function extractPathsFromArgs(toolArgs) {
    if (!toolArgs || typeof toolArgs !== 'object') return [];
    const candidates = [
        toolArgs.file_path, toolArgs.filePath, toolArgs.path,
        toolArgs.pattern, toolArgs.glob, toolArgs.query,
    ];
    const paths = [];
    for (const c of candidates) {
        if (typeof c === 'string') {
            const match = c.match(/\\*\\.([a-z]+)/i);
            paths.push(match ? 'file.' + match[1] : c);
        }
    }
    return paths;
}

function isSearchingForDependencies(toolArgs) {
    const pattern = (toolArgs && (toolArgs.pattern || toolArgs.query || toolArgs.searchQuery)) || '';
    return DEPENDENCY_PATTERNS.some(re => re.test(pattern));
}

function isTerminalSearch(toolArgs) {
    const command = (toolArgs && (toolArgs.command || toolArgs.cmd || toolArgs.input)) || '';
    return /^(rg|grep|ag|ack|find)\\s/.test(command.trim());
}

function isTerminalDependencySearch(toolArgs) {
    const command = (toolArgs && (toolArgs.command || toolArgs.cmd || toolArgs.input)) || '';
    return isTerminalSearch(toolArgs) && DEPENDENCY_PATTERNS.some(re => re.test(command));
}

function getStateFilePath(sessionKey) {
    const safe = /^[A-Za-z0-9_-]+$/.test(sessionKey) ? sessionKey : null;
    if (!safe) return null;
    return require('path').join(require('os').tmpdir(), STATE_FILE_PREFIX + safe + '.json');
}

function getSessionKey(input) {
    const candidates = [
        input.sessionId,
        input.session_id,
        input.chatSessionId,
        input.chat_session_id,
        input.conversationId,
        input.conversation_id,
        input.threadId,
        input.thread_id,
    ];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
            return candidate.trim();
        }
    }

    // No session ID in input — generate a persistent ID on first use and reuse it permanently.
    const sessionMarker = require('path').join(require('os').tmpdir(), 'lgraph-copilot-session.json');
    try {
        const existing = JSON.parse(require('fs').readFileSync(sessionMarker, 'utf-8'));
        if (existing && typeof existing.id === 'string' && existing.id) {
            return existing.id;
        }
    } catch { /* no session file yet — create one */ }

    const newId = 'gen-' + require('crypto').randomUUID();
    try {
        require('fs').writeFileSync(sessionMarker, JSON.stringify({ id: newId }));
    } catch { /* best-effort */ }
    return newId;
}

function normalizeFilePath(filePath) {
    if (!filePath || typeof filePath !== 'string') return '';
    return filePath.replace(/\\\\/g, '/').toLowerCase();
}

function resolveConfig(cwd) {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    let apiKey = process.env.LGRAPH_API_KEY || '';
    let apiUrl = process.env.LGRAPH_API_URL || '';
    let projectId = process.env.LGRAPH_PROJECT_ID || '';

    if (!apiKey || !apiUrl) {
        try {
            const globalCfg = JSON.parse(
                fs.readFileSync(path.join(os.homedir(), '.lgraph', 'config.json'), 'utf-8')
            );
            if (!apiKey) apiKey = globalCfg.api_key || '';
            if (!apiUrl) apiUrl = globalCfg.api_url || '';
        } catch { /* no global config */ }
    }

    if (!projectId) {
        try {
            const projCfg = JSON.parse(
                fs.readFileSync(path.join(cwd, '.lgraph', 'config.json'), 'utf-8')
            );
            projectId = projCfg.project_id || '';
        } catch { /* no project config */ }
    }

    if (!apiUrl) apiUrl = 'https://latentgraph.latentforce.ai';
    if (!apiKey || !projectId) return null;

    return { apiUrl, apiKey, projectId };
}

function normalizeBackendPath(filePath, cwd) {
    let p = filePath.replace(/\\\\/g, '/');
    if (cwd) {
        const cwdNorm = cwd.replace(/\\\\/g, '/').replace(/\\/$/, '');
        if (p.startsWith(cwdNorm + '/')) {
            p = p.slice(cwdNorm.length + 1);
        }
    }
    p = p.replace(/^\\.\\//, '');
    p = p.replace(/^\\//, '');
    return p;
}

function formatFileContext(data) {
    const lines = [];
    lines.push('[Latentgraph] File: ' + (data.path || '') + (data.module_name ? ' | Module: ' + data.module_name : ''));

    if (data.summary) {
        lines.push('Summary: ' + data.summary);
    }

    const implicits = (data.implicit_dependencies_preview || [])
        .filter(function(dep) { return dep && dep.strength === 'tight'; })
        .slice(0, 5);

    if (implicits.length > 0) {
        lines.push('Tight implicit couplings:');
        for (const dep of implicits) {
            lines.push('- ' + dep.path);
            if (dep.coupling_type) lines.push('  coupling_type: ' + dep.coupling_type);
            if (dep.coupling_mechanism) lines.push('  coupling_mechanism: ' + dep.coupling_mechanism);
            if (dep.strength) lines.push('  strength: ' + dep.strength);
            if (dep.dependency_types) lines.push('  dependency_types: ' + (Array.isArray(dep.dependency_types) ? dep.dependency_types.join(', ') : dep.dependency_types));
            if (dep.edge_summary) lines.push('  edge_summary: ' + dep.edge_summary);
        }
    }

    const dependents = (data.dependents || []).slice(0, 5);
    if (dependents.length > 0) {
        lines.push('Dependents:');
        for (const dep of dependents) {
            lines.push('- ' + dep);
        }
    }

    return lines.join('\\n');
}

async function fetchFileContext(filePath, cwd) {
    try {
        const config = resolveConfig(cwd);
        if (!config) return null;

        const normalized = normalizeBackendPath(filePath, cwd);
        const controller = new AbortController();
        const timeout = setTimeout(function() { controller.abort(); }, 7000);

        const response = await fetch(config.apiUrl + '/api/v1/mcp/what-is-this-file', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + config.apiKey,
            },
            body: JSON.stringify({
                path: normalized,
                project_id: config.projectId,
                level: 0,
            }),
            signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) return null;

        const data = await response.json();
        return formatFileContext(data);
    } catch {
        return null;
    }
}

function loadSeen(statePath) {
    try {
        const raw = require('fs').readFileSync(statePath, 'utf-8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function saveSeen(statePath, seen) {
    require('fs').writeFileSync(statePath, JSON.stringify(seen) + '\\n');
}

function shouldEmitOnce(input, dedupeKey) {
    if (!dedupeKey) return true;

    const sessionKey = getSessionKey(input);
    const statePath = getStateFilePath(sessionKey);
    if (!statePath) return true;

    const seen = loadSeen(statePath);
    if (seen.includes(dedupeKey)) return false;

    saveSeen(statePath, [...seen, dedupeKey]);
    return true;
}

function emitContext(message) {
    process.stdout.write(JSON.stringify({
        permissionDecision: 'allow',
        additionalContext: message,
    }));
}

function emitEmpty() {
    process.stdout.write(JSON.stringify({}));
}

async function main() {
    let rawInput = '';
    for await (const chunk of process.stdin) {
        rawInput += chunk;
    }

    let input;
    try {
        input = JSON.parse(rawInput);
    } catch {
        emitEmpty();
        return;
    }

    const toolName = input.toolName || input.tool_name || '';
    const toolArgs = parseToolArgs(input.toolArgs || input.tool_input || {});

    const paths = extractPathsFromArgs(toolArgs);
    const hasSourceTarget = paths.some(p => isSourceFile(p));
    const hasNonSourceTarget = paths.some(p => isNonSourceFile(p));

    if (hasNonSourceTarget && !hasSourceTarget) {
        emitEmpty();
        return;
    }

    let suggestion = '';
    let dedupeKey = '';

    if (READ_TOOLS.has(toolName) && hasSourceTarget) {
        const targetPath = paths.find(p => isSourceFile(p)) || '';
        dedupeKey = 'read:' + normalizeFilePath(targetPath);

        if (!shouldEmitOnce(input, dedupeKey)) {
            emitEmpty();
            return;
        }

        const readPath = toolArgs.file_path || toolArgs.filePath || toolArgs.path || targetPath;
        const cwd = input.cwd || process.cwd();
        const context = await fetchFileContext(String(readPath), cwd);

        if (context) {
            emitContext(context);
        } else {
            emitContext(
                '[Latentgraph] This is an indexed source file. Keep the summary, module role, ' +
                'tight couplings, and dependents in mind while reading.'
            );
        }
        return;
    } else if (SEARCH_TOOLS.has(toolName)) {
        if (isSearchingForDependencies(toolArgs)) {
            suggestion =
                '[Latentgraph] You are searching for dependency patterns. ' +
                'Use mcp__lgraph__get_dependencies instead — it returns the bidirectional graph ' +
                'with relationship types, imported names, reverse deps, dependency summaries, ' +
                'and implicit coupling strength. Use mcp__lgraph__get_change_impact for downstream impact.';
            const targetPath = paths.find(p => isSourceFile(p)) || paths[0] || toolArgs.pattern || toolArgs.query || '';
            dedupeKey = 'search:' + normalizeFilePath(String(targetPath));
        } else if (hasSourceTarget) {
            suggestion =
                '[Latentgraph] Before searching indexed source files, consider:\\n' +
                '  - mcp__lgraph__get_context(targets=["project"]) — architecture summary and top-level modules\\n' +
                '  - mcp__lgraph__get_context(targets=["project"], depth=-1, include_files=true) — logical modules and owning files\\n' +
                '  - mcp__lgraph__get_file — file summary, symbols, endpoints, dependents\\n' +
                '  - mcp__lgraph__get_dependencies — bidirectional relationships, imports, coupling';
            const targetPath = paths.find(p => isSourceFile(p)) || '';
            dedupeKey = 'search:' + normalizeFilePath(targetPath);
        }
    } else if (TERMINAL_TOOLS.has(toolName)) {
        if (isTerminalDependencySearch(toolArgs)) {
            suggestion =
                '[Latentgraph] You are running a dependency search in the terminal. ' +
                'Use mcp__lgraph__get_dependencies for relationship tracing and ' +
                'mcp__lgraph__get_change_impact for downstream impact instead.';
            dedupeKey = 'terminal:' + normalizeFilePath(String(toolArgs.command || toolArgs.cmd || toolArgs.input || ''));
        } else if (isTerminalSearch(toolArgs)) {
            suggestion =
                '[Latentgraph] You are running a source-code search. Consider using MCP first:\\n' +
                '  - mcp__lgraph__get_context(targets=["project"]) for navigation\\n' +
                '  - mcp__lgraph__get_dependencies for bidirectional relationships, imports, coupling\\n' +
                '  - mcp__lgraph__get_change_impact for downstream blast radius\\n' +
                '  - mcp__lgraph__get_file for file summary, symbols, endpoints, dependents';
            dedupeKey = 'terminal:' + normalizeFilePath(String(toolArgs.command || toolArgs.cmd || toolArgs.input || ''));
        }
    }

    if (!suggestion) {
        emitEmpty();
        return;
    }

    if (!shouldEmitOnce(input, dedupeKey)) {
        emitEmpty();
        return;
    }

    emitContext(suggestion);
}

main().catch(() => {
    emitEmpty();
});
`;

interface HookEntry {
    type: 'command';
    bash: string;
    powershell: string;
    timeoutSec: number;
    comment: string;
}

interface HooksConfig {
    version: 1;
    hooks: {
        preToolUse?: HookEntry[];
        [key: string]: HookEntry[] | undefined;
    };
}

export interface GenerateHooksResult {
    hookFilePath: string;
    configUpdated: boolean;
}

/**
 * Write the hook script and register it in .github/hooks.json.
 *
 * Copilot hook files live in the repository under .github/hooks/, matching
 * GitHub's repository hook convention.
 */
export function generateHookFiles(projectRoot: string): GenerateHooksResult {
    const hookDir = path.join(projectRoot, '.github', 'hooks', 'lgraph');
    if (!fs.existsSync(hookDir)) {
        fs.mkdirSync(hookDir, { recursive: true });
    }

    const hookFilePath = path.join(hookDir, 'lgraph-hook.cjs');
    fs.writeFileSync(hookFilePath, HOOK_SCRIPT);
    fs.chmodSync(hookFilePath, 0o755);

    const configPath = path.join(hookDir, '..', 'hooks.json');
    let config: HooksConfig = { version: 1, hooks: {} };

    if (fs.existsSync(configPath)) {
        try {
            config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            if (!config.hooks) config.hooks = {};
        } catch {
            config = { version: 1, hooks: {} };
        }
    }

    const hookCommand = 'node .github/hooks/lgraph/lgraph-hook.cjs';
    const isLgraphEntry = (e: HookEntry) =>
        e.bash?.includes('lgraph-hook') || e.powershell?.includes('lgraph-hook');

    const entry: HookEntry = {
        type: 'command',
        bash: hookCommand,
        powershell: hookCommand,
        timeoutSec: 10,
        comment: 'Latentgraph local guidance hook — injects MCP-first context for source reads and searches',
    };

    if (!config.hooks.preToolUse) {
        config.hooks.preToolUse = [];
    }
    config.hooks.preToolUse = config.hooks.preToolUse.filter(e => !isLgraphEntry(e));
    config.hooks.preToolUse.push(entry);

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

    return { hookFilePath, configUpdated: true };
}
