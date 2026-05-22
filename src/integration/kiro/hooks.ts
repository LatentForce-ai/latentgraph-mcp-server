/**
 * Hook generation for Latentgraph Kiro CLI integration.
 *
 * Kiro hooks protocol (PreToolUse):
 *   Input:  JSON on stdin  { hook_event_name, cwd, session_id, tool_name, tool_input }
 *   Output: exit 0 + raw text on stdout  — context injected, tool allowed
 *           exit 2 + stderr              — tool blocked, reason shown to LLM
 *
 * Hook script:  .kiro/hooks/lgraph/lgraph-hook.cjs  (gitignored, auto-generated)
 * Agent config: .kiro/agents/lgraph.json            (committed/shared agent config)
 */

import * as fs from 'fs';
import * as path from 'path';

const HOOK_SCRIPT = `#!/usr/bin/env node
"use strict";

/**
 * Latentgraph PreToolUse hook for Kiro.
 *
 * - read / fs_read / fsRead : inject file context (lgraph API or fallback) — fire-once per session per file
 * - grep                    : inject MCP search suggestion — fire-once per pattern per session
 * - glob                    : inject MCP navigation suggestion — fire-once per glob per session
 * - execute_bash / shell    : nudge terminal searches once per session
 *
 * Input:  JSON on stdin  { hook_event_name, cwd, session_id, tool_name, tool_input }
 * Output: exit 0 + raw text on stdout  — context injected, tool allowed
 *         exit 2 + stderr              — tool blocked, reason shown to LLM
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

const READ_TOOLS = new Set(['read', 'fs_read', 'fsread']);
const BASH_SEARCH_RE = /^(rg|grep|ag|ack)\\s/;
const STATE_FILE_PREFIX = 'lgraph-kiro-hook-';

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

function getStateFilePath(sessionId) {
    const safe = /^[A-Za-z0-9_-]+$/.test(sessionId || '') ? sessionId : null;
    if (!safe) return null;
    return require('path').join(require('os').tmpdir(), STATE_FILE_PREFIX + safe + '.json');
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

function shouldEmitOnce(sessionId, dedupeKey) {
    if (!dedupeKey || !sessionId) return true;
    const statePath = getStateFilePath(sessionId);
    if (!statePath) return true;
    const seen = loadSeen(statePath);
    if (seen.includes(dedupeKey)) return false;
    saveSeen(statePath, [...seen, dedupeKey]);
    return true;
}

function normalizePath(filePath, cwd) {
    let p = filePath.replace(/\\\\/g, '/');
    if (cwd) {
        const cwdNorm = cwd.replace(/\\\\/g, '/').replace(/\\/$/, '');
        if (p.startsWith(cwdNorm + '/')) p = p.slice(cwdNorm.length + 1);
    }
    p = p.replace(/^\\.\\//, '');
    p = p.replace(/^\\//, '');
    return p;
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

function formatFileContext(data) {
    const lines = [];
    lines.push('[Latentgraph] File: ' + (data.path || '') + (data.module_name ? ' | Module: ' + data.module_name : ''));
    if (data.summary) lines.push('Summary: ' + data.summary);

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
        for (const dep of dependents) lines.push('- ' + dep);
    }

    return lines.join('\\n');
}

async function fetchFileContext(filePath, cwd) {
    try {
        const config = resolveConfig(cwd);
        if (!config) return null;

        const normalized = normalizePath(filePath, cwd);
        const controller = new AbortController();
        const timeout = setTimeout(function() { controller.abort(); }, 7000);

        const response = await fetch(config.apiUrl + '/api/v1/mcp/what-is-this-file', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + config.apiKey,
            },
            body: JSON.stringify({ path: normalized, project_id: config.projectId, level: 0 }),
            signal: controller.signal,
        });

        clearTimeout(timeout);
        if (!response.ok) return null;
        return formatFileContext(await response.json());
    } catch {
        return null;
    }
}

async function main() {
    let rawInput = '';
    for await (const chunk of process.stdin) rawInput += chunk;

    let input;
    try { input = JSON.parse(rawInput); } catch { process.exit(0); }

    const toolName = (input.tool_name || '').toLowerCase().trim();
    const toolInput = input.tool_input || {};
    const sessionId = (input.session_id || '').trim();
    const cwd = input.cwd || process.cwd();

    // --- READ / FS_READ: inject file context (fire-once per session per file) ---
    if (READ_TOOLS.has(toolName)) {
        const ops = Array.isArray(toolInput.operations) ? toolInput.operations : null;
        const filePath = (ops && ops[0] && ops[0].path) || toolInput.path || toolInput.file_path || '';

        if (!filePath || isNonSourceFile(filePath) || !isSourceFile(filePath)) {
            process.exit(0);
        }

        const dedupeKey = 'read:' + normalizePath(filePath, cwd).toLowerCase();

        if (!shouldEmitOnce(sessionId, dedupeKey)) {
            process.exit(0);
        }

        const context = await fetchFileContext(filePath, cwd);
        process.stdout.write(
            (context ||
                '[Latentgraph] This is an indexed source file. Keep the summary, module role, ' +
                'tight couplings, and dependents in mind while reading.') +
            '\\n'
        );
        process.exit(0);
    }

    // --- GREP: inject search suggestion (fire-once per pattern per session) ---
    if (toolName === 'grep') {
        const pattern = toolInput.pattern || toolInput.query || '';
        let suggestion = '';

        if (DEPENDENCY_PATTERNS.some(function(re) { return re.test(pattern); })) {
            suggestion =
                '[Latentgraph] You are searching for dependency patterns. ' +
                'Use mcp__lgraph__get_dependencies instead — it returns the bidirectional graph ' +
                'with relationship types, imported names, reverse deps, dependency summaries, ' +
                'and implicit coupling strength. Use mcp__lgraph__get_change_impact for downstream impact.';
        } else if (pattern) {
            suggestion =
                '[Latentgraph] This project has a pre-built DRG plus CodeWiki module docs. ' +
                'Before grepping indexed source files, consider:\\n' +
                '  - mcp__lgraph__get_file — file summary, symbols, endpoints, dependents\\n' +
                '  - mcp__lgraph__get_dependencies — bidirectional relationships, imports, coupling\\n' +
                '  - mcp__lgraph__get_change_impact — downstream blast radius';
        }

        if (suggestion && shouldEmitOnce(sessionId, 'grep:' + pattern)) {
            process.stdout.write(suggestion + '\\n');
        }
        process.exit(0);
    }

    // --- GLOB: inject navigation suggestion (fire-once per glob per session) ---
    if (toolName === 'glob') {
        const pattern = toolInput.pattern || toolInput.glob || '';
        const looksLikeSourceGlob =
            /\\.(js|jsx|ts|tsx|py|java|cs|go|cpp|c|h|css|scss|html)(\\*|$)/.test(pattern) ||
            pattern.includes('**');

        if (looksLikeSourceGlob && shouldEmitOnce(sessionId, 'glob:' + pattern)) {
            process.stdout.write(
                '[Latentgraph] Before globbing indexed source files, consider:\\n' +
                '  - mcp__lgraph__get_context(targets=["project"]) — architecture summary and top-level modules\\n' +
                '  - mcp__lgraph__get_context(targets=["project"], depth=-1, include_files=true) — logical modules and owning files\\n' +
                '  - mcp__lgraph__get_context(targets=["..."]) — module docs, key files, and context\\n'
            );
        }
        process.exit(0);
    }

    // --- EXECUTE_BASH / SHELL: nudge terminal searches once ---
    if (toolName === 'execute_bash' || toolName === 'shell' || toolName === 'run' ||
        toolName === 'exec' || toolName.includes('bash') || toolName.includes('shell')) {

        const command = (toolInput.command || toolInput.cmd || '').trim();
        if (!command) { process.exit(0); }

        if (BASH_SEARCH_RE.test(command)) {
            const isDependencySearch = DEPENDENCY_PATTERNS.some(function(re) { return re.test(command); });
            const suggestion = isDependencySearch
                ? '[Latentgraph] You are searching for dependency patterns in the terminal. ' +
                  'Use mcp__lgraph__get_dependencies instead — it returns the bidirectional graph ' +
                  'with relationship types, imported names, reverse deps, dependency summaries, ' +
                  'and implicit coupling strength. Use mcp__lgraph__get_change_impact for downstream impact.'
                : '[Latentgraph] You are running a source-code search. Consider using MCP first:\\n' +
                  '  - mcp__lgraph__get_context(targets=["project"]) for navigation\\n' +
                  '  - mcp__lgraph__get_dependencies for bidirectional relationships, imports, coupling\\n' +
                  '  - mcp__lgraph__get_change_impact for downstream blast radius\\n' +
                  '  - mcp__lgraph__get_file for file summary, symbols, endpoints, dependents';
            const dedupeKey = 'bash:' + command.slice(0, 120);
            if (shouldEmitOnce(sessionId, dedupeKey)) {
                process.stdout.write(suggestion + '\\n');
            }
        }
        process.exit(0);
    }

    process.exit(0);
}

main().catch(function() { process.exit(0); });
`;

interface HookEntry {
    matcher?: string;
    command: string;
    timeout_ms?: number;
}

interface HooksConfig {
    preToolUse?: HookEntry[];
    [key: string]: HookEntry[] | undefined;
}

interface AgentConfig {
    name: string;
    description: string;
    hooks: HooksConfig;
}

export interface GenerateHooksResult {
    hookFilePath: string;
    agentConfigPath: string;
    agentConfigUpdated: boolean;
}

const PRE_TOOL_MATCHERS = ['read', 'fs_read', 'grep', 'glob', 'execute_bash', 'shell'] as const;

export function generateHookFiles(projectRoot: string): GenerateHooksResult {
    const hookDir = path.join(projectRoot, '.kiro', 'hooks', 'lgraph');
    if (!fs.existsSync(hookDir)) {
        fs.mkdirSync(hookDir, { recursive: true });
    }

    const hookFilePath = path.join(hookDir, 'lgraph-hook.cjs');
    fs.writeFileSync(hookFilePath, HOOK_SCRIPT);
    fs.chmodSync(hookFilePath, 0o755);

    const agentsDir = path.join(projectRoot, '.kiro', 'agents');
    if (!fs.existsSync(agentsDir)) {
        fs.mkdirSync(agentsDir, { recursive: true });
    }

    const agentConfigPath = path.join(agentsDir, 'lgraph.json');
    const hookCommand = 'node .kiro/hooks/lgraph/lgraph-hook.cjs';
    const isLgraphEntry = (e: HookEntry) => e.command?.includes('lgraph-hook');

    let agentConfig: AgentConfig = {
        name: 'lgraph',
        description: 'Latentgraph MCP-aware agent for this project. Use this shared agent in Kiro when you want hook-assisted file context and MCP nudges before reads, searches, and shell exploration.',
        hooks: {},
    };

    if (fs.existsSync(agentConfigPath)) {
        try {
            agentConfig = JSON.parse(fs.readFileSync(agentConfigPath, 'utf-8'));
            if (!agentConfig.hooks) agentConfig.hooks = {};
        } catch {
            // start fresh
        }
    }

    if (!agentConfig.hooks.preToolUse) {
        agentConfig.hooks.preToolUse = [];
    }

    // Replace any existing lgraph hook entry, keep others
    agentConfig.hooks.preToolUse = agentConfig.hooks.preToolUse.filter(
        e => !isLgraphEntry(e),
    );
    for (const matcher of PRE_TOOL_MATCHERS) {
        agentConfig.hooks.preToolUse.push({
            matcher,
            command: hookCommand,
            timeout_ms: 10000,
        });
    }

    fs.writeFileSync(agentConfigPath, JSON.stringify(agentConfig, null, 2) + '\n');

    return { hookFilePath, agentConfigPath, agentConfigUpdated: true };
}
