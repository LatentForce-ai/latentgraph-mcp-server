/**
 * Hook generation for Claude Code integration.
 *
 * Creates a PreToolUse hook that intercepts Grep, Glob, Read, and Bash
 * to remind the agent that lgraph MCP tools provide better code intelligence
 * than raw file searching for indexed source files.
 */

import * as fs from 'fs';
import * as path from 'path';

const HOOK_SCRIPT = `#!/usr/bin/env node
"use strict";

/**
 * Latentgraph hook for Claude Code.
 *
 * PreToolUse — intercepts Grep/Glob/Read/Bash on source files and injects
 *              a reminder to prefer lgraph MCP tools.
 *
 * Input:  JSON on stdin  { hook_event_name, tool_name, tool_input, ... }
 * Output: JSON on stdout { hookSpecificOutput: { hookEventName, permissionDecision, additionalContext } }
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

function extractPathsFromInput(input) {
    const paths = [];
    if (input.file_path) paths.push(input.file_path);
    if (input.path) paths.push(input.path);
    if (input.pattern) {
        const match = input.pattern.match(/\\*\\.([a-z]+)/i);
        if (match) paths.push('file.' + match[1]);
    }
    return paths;
}

function isSearchingForDependencies(input) {
    const pattern = input.pattern || '';
    return DEPENDENCY_PATTERNS.some(re => re.test(pattern));
}

function isBashSearch(command) {
    if (!command) return false;
    const cmd = command.trim();
    return /^(rg|grep|ag|ack)\\s/.test(cmd) || /^find\\s/.test(cmd);
}

function emitContext(hookEventName, message) {
    process.stderr.write(message + '\\n');
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: hookEventName,
            permissionDecision: 'allow',
            additionalContext: message,
        }
    }));
}

function emitAllow() {
    process.stdout.write(JSON.stringify({}));
}

function resolveConfig(cwd) {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    let apiKey = process.env.LGRAPH_API_KEY || '';
    let apiUrl = process.env.LGRAPH_API_URL || '';
    let projectId = process.env.LGRAPH_PROJECT_ID || '';

    // Read global config: ~/.lgraph/config.json
    if (!apiKey || !apiUrl) {
        try {
            const globalCfg = JSON.parse(
                fs.readFileSync(path.join(os.homedir(), '.lgraph', 'config.json'), 'utf-8')
            );
            if (!apiKey) apiKey = globalCfg.api_key || '';
            if (!apiUrl) apiUrl = globalCfg.api_url || '';
        } catch { /* no global config */ }
    }

    // Read project config: <cwd>/.lgraph/config.json
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

function normalizePath(filePath, cwd) {
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
    const target = data.target || '';
    const summary = data.summary || {};
    const structure = data.structure || {};
    const knowledge = data.knowledge || {};
    const coChanges = data.co_changes || {};

    let header = '[Latentgraph] File: ' + target;
    if (summary.module_name) header += ' | Module: ' + summary.module_name;
    if (summary.category) header += ' | Category: ' + summary.category;
    lines.push(header);

    if (summary.text) lines.push('Summary: ' + summary.text);
    if (summary.modification_impact) lines.push('Modification impact: ' + summary.modification_impact);

    const keySymbols = (structure.key_symbols || []).slice(0, 5);
    if (keySymbols.length > 0) {
        const total = structure.key_symbols_total || keySymbols.length;
        lines.push('Key symbols (' + keySymbols.length + ' of ' + total + '):');
        for (const sym of keySymbols) {
            const span = Array.isArray(sym.span) && sym.span.length === 2
                ? ' [L' + sym.span[0] + '-' + sym.span[1] + ']' : '';
            const asyncFlag = sym.is_async ? ' (async)' : '';
            const sig = sym.signature || sym.name || '';
            lines.push('- [' + (sym.kind || 'symbol') + '] ' + sig + asyncFlag + span);
        }
    }

    const apiEndpoints = (structure.api_endpoints || []).slice(0, 3);
    if (apiEndpoints.length > 0) {
        lines.push('API endpoints:');
        for (const ep of apiEndpoints) {
            lines.push('- ' + (ep.method || '') + ' ' + (ep.path || '') + ' -> ' + (ep.handler_name || ''));
        }
    }

    const storage = structure.storage_backends || [];
    if (storage.length > 0) {
        lines.push('Storage: ' + storage.map(function(b) { return b.type; }).join(', '));
    }

    const invariants = (knowledge.invariants || []).slice(0, 3);
    if (invariants.length > 0) {
        lines.push('INVARIANTS (must not break):');
        for (const inv of invariants) {
            const sev = inv.severity ? ' [' + inv.severity + ']' : '';
            lines.push('- ' + (inv.rule || '') + sev);
            if (inv.consequence) lines.push('  consequence: ' + inv.consequence);
        }
    }

    const decisions = (knowledge.decisions || []).slice(0, 2);
    if (decisions.length > 0) {
        lines.push('Design decisions:');
        for (const d of decisions) {
            const tag = d.tag ? ' (' + d.tag + ')' : '';
            lines.push('- ' + (d.title || '') + tag);
        }
    }

    const partners = (coChanges.partners || []).slice(0, 3);
    if (partners.length > 0) {
        const src = coChanges.source || 'unknown';
        lines.push('Co-changes (' + src + '):');
        for (const p of partners) {
            const score = (typeof p.score === 'number') ? ' score=' + p.score.toFixed(2) : '';
            lines.push('- ' + p.file + ' [' + (p.type || '') + ']' + score);
            if (p.edge_summary) lines.push('  ' + p.edge_summary);
        }
    }

    if (knowledge.target_type === 'file_via_module' && Array.isArray(knowledge.matched_modules) && knowledge.matched_modules.length > 0) {
        lines.push('Note: knowledge above is from owning module ' + knowledge.matched_modules[0] + ' (no file-specific items).');
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

        const response = await fetch(config.apiUrl + '/api/v1/mcp/context', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + config.apiKey,
            },
            body: JSON.stringify({
                target: normalized,
                project_id: config.projectId,
                include: ['summary', 'structure', 'knowledge', 'co_changes'],
            }),
            signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) return null;

        const data = await response.json();
        const targets = (data && data.targets) || {};
        const keys = Object.keys(targets);
        if (keys.length === 0) return null;
        const unwrapped = targets[keys[0]];
        if (!unwrapped) return null;
        return formatFileContext(unwrapped);
    } catch {
        return null;
    }
}

// Track files read in session to remind about recording learnings
function getReadCountPath(sessionId) {
    const sessionIdSafe = /^[A-Za-z0-9_-]+$/.test(sessionId) ? sessionId : '';
    return sessionIdSafe
        ? require('os').tmpdir() + '/lgraph-hook-' + sessionIdSafe + '-readcount.json'
        : null;
}

function incrementReadCount(sessionId) {
    const countPath = getReadCountPath(sessionId);
    if (!countPath) return 0;
    let count = 0;
    try {
        const data = JSON.parse(require('fs').readFileSync(countPath, 'utf8'));
        count = data.count || 0;
    } catch { /* ignore */ }
    count++;
    try {
        require('fs').writeFileSync(countPath, JSON.stringify({ count }));
    } catch { /* ignore */ }
    return count;
}

function shouldRemindToRecord(sessionId) {
    const countPath = getReadCountPath(sessionId);
    if (!countPath) return false;
    try {
        const data = JSON.parse(require('fs').readFileSync(countPath, 'utf8'));
        // Remind every 5 file reads
        return (data.count || 0) % 5 === 0 && data.count > 0;
    } catch {
        return false;
    }
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
        emitAllow();
        return;
    }

    const hookEventName = input.hook_event_name;
    const toolName = input.tool_name;
    const toolInput = input.tool_input || {};
    const sessionId = input.session_id || '';
    const sessionIdSafe = /^[A-Za-z0-9_-]+$/.test(sessionId) ? sessionId : '';
    const seenFilePath = sessionIdSafe
        ? require('os').tmpdir() + '/lgraph-hook-' + sessionIdSafe + '-seen.json'
        : null;

    // Handle PreCompact - remind agent to flush session learnings before compression
    if (hookEventName === 'PreCompact') {
        emitContext('PreCompact',
            '[Latentgraph] Context is about to be compressed. ' +
            'Before it is, summarise any discovered insights, edge cases, or non-obvious ' +
            'relationships from this session via mcp__lgraph__update_graph so they survive ' +
            'compression. Operations: edit_file_summary, add_implicit_dependency, edit_module_doc, ' +
            'edit_dependency_summary. Skip if nothing notable was learned.'
        );
        return;
    }

    // Handle PostToolUse - remind to record learnings
    if (hookEventName === 'PostToolUse') {
        // After reading a source file, remind to call get_call_chain for execution flow tracing
        if (toolName === 'Read') {
            const filePath = toolInput.file_path || toolInput.path || '';
            const cwd = input.cwd || process.cwd();
            const normalized = normalizePath(filePath, cwd);

            if (isSourceFile(filePath)) {
                let alreadyReminded = false;
                if (seenFilePath) {
                    const dedupeKey = 'callchain:' + normalized;
                    let seen = {};
                    try {
                        seen = JSON.parse(require('fs').readFileSync(seenFilePath, 'utf8'));
                    } catch { /* not found or malformed */ }

                    if (seen[dedupeKey]) {
                        alreadyReminded = true;
                    } else {
                        seen[dedupeKey] = true;
                        try {
                            require('fs').writeFileSync(seenFilePath, JSON.stringify(seen));
                        } catch { /* best-effort */ }
                    }
                }

                if (!alreadyReminded) {
                    emitContext('PostToolUse',
                        '[Latentgraph] You just read an indexed source file: ' + normalized + '\\n' +
                        'To trace runtime flow for a specific symbol, call:\\n' +
                        '  mcp__lgraph__get_call_chain(symbol="' + normalized + '::<symbol_name>") — callers + callees in one call\\n' +
                        'Use fully-qualified form: <file>::<class>::<method> or <file>::<function>\\n' +
                        'Skip if you do not need to trace execution flow for this file.');
                    return;
                }
            }
        }

        // After reading files or using MCP tools, remind to record learnings
        if (toolName === 'Read' || toolName === 'mcp__lgraph__get_file' || toolName === 'mcp__lgraph__get_context') {
            const count = incrementReadCount(sessionId);
            if (shouldRemindToRecord(sessionId)) {
                emitContext('PostToolUse',
                    '[Latentgraph Memory] You have explored ' + count + ' files/contexts. ' +
                    'REMEMBER: If you discovered any insights, edge cases, or non-obvious relationships, ' +
                    'use mcp__lgraph__update_graph to record them. This builds institutional memory for future sessions. ' +
                    'Operations: edit_file_summary, add_implicit_dependency, edit_module_doc, edit_dependency_summary'
                );
                return;
            }
        }
        emitAllow();
        return;
    }

    if (hookEventName !== 'PreToolUse') {
        emitAllow();
        return;
    }

    const paths = extractPathsFromInput(toolInput);
    const hasSourceTarget = paths.some(p => isSourceFile(p));
    const hasNonSourceTarget = paths.some(p => isNonSourceFile(p));

    if (hasNonSourceTarget && !hasSourceTarget) {
        emitAllow();
        return;
    }

    let suggestion = '';

    switch (toolName) {
        case 'Grep': {
            if (isSearchingForDependencies(toolInput)) {
                suggestion =
                    '[Latentgraph] You are searching for dependency patterns. ' +
                    'Use mcp__lgraph__get_dependencies instead — it returns the bidirectional graph ' +
                    'with relationship types, imported names, reverse deps, dependency summaries, ' +
                    'and implicit coupling strength. Use mcp__lgraph__get_change_impact for downstream impact.';
            } else if (hasSourceTarget) {
                suggestion =
                    '[Latentgraph] This project has a pre-built DRG plus Wiki module docs. ' +
                    'Before grepping indexed source files, consider:\\n' +
                    '  - mcp__lgraph__get_file — file summary, symbols, endpoints, and dependents\\n' +
                    '  - mcp__lgraph__get_dependencies — bidirectional relationships and coupling\\n' +
                    '  - mcp__lgraph__get_change_impact — find affected dependents';
            }
            if (suggestion && seenFilePath) {
                const dedupeKey = 'grep:' + (toolInput.pattern || toolInput.query || '');
                let seen = {};
                try { seen = JSON.parse(require('fs').readFileSync(seenFilePath, 'utf8')); } catch { /* ignore */ }
                if (seen[dedupeKey]) { emitAllow(); return; }
                seen[dedupeKey] = true;
                try { require('fs').writeFileSync(seenFilePath, JSON.stringify(seen)); } catch { /* ignore */ }
            }
            break;
        }

        case 'Glob': {
            if (hasSourceTarget) {
                suggestion =
                    '[Latentgraph] Before globbing indexed source files, consider:\\n' +
                    '  - mcp__lgraph__get_context(targets=["project"]) — architecture summary and top-level modules\\n' +
                    '  - mcp__lgraph__get_context(targets=["project"], depth=-1, include_files=true) — full module tree with files\\n' +
                    '  - mcp__lgraph__get_context(targets=["<module-name>"]) — docs and key files for a specific module';
            }
            if (suggestion && seenFilePath) {
                const dedupeKey = 'glob:' + (toolInput.pattern || toolInput.glob || '');
                let seen = {};
                try { seen = JSON.parse(require('fs').readFileSync(seenFilePath, 'utf8')); } catch { /* ignore */ }
                if (seen[dedupeKey]) { emitAllow(); return; }
                seen[dedupeKey] = true;
                try { require('fs').writeFileSync(seenFilePath, JSON.stringify(seen)); } catch { /* ignore */ }
            }
            break;
        }

        case 'Read': {
            if (hasSourceTarget) {
                const filePath = toolInput.file_path || toolInput.path || '';
                const cwd = input.cwd || process.cwd();
                const normalized = normalizePath(filePath, cwd);

                if (seenFilePath) {
                    let seen = {};
                    try {
                        seen = JSON.parse(require('fs').readFileSync(seenFilePath, 'utf8'));
                    } catch { /* not found or malformed — treat as empty */ }

                    if (seen[normalized]) {
                        emitAllow();
                        return;
                    }

                    seen[normalized] = true;
                    try {
                        require('fs').writeFileSync(seenFilePath, JSON.stringify(seen));
                    } catch { /* best-effort — don't fail the hook */ }
                }

                const context = await fetchFileContext(filePath, cwd);
                if (context) {
                    emitContext('PreToolUse', context);
                } else {
                    emitContext('PreToolUse',
                        '[Latentgraph] This is an indexed source file. Keep the summary, module role, ' +
                        'tight couplings, and dependents in mind while reading.');
                }
                return;
            }
            break;
        }

        case 'Edit':
        case 'Write':
        case 'MultiEdit': {
            if (hasSourceTarget) {
                const filePath = toolInput.file_path || toolInput.path || '';
                const cwd = input.cwd || process.cwd();
                const normalized = normalizePath(filePath, cwd);

                if (seenFilePath) {
                    const dedupeKey = 'edit:' + normalized;
                    let seen = {};
                    try {
                        seen = JSON.parse(require('fs').readFileSync(seenFilePath, 'utf8'));
                    } catch { /* not found or malformed — treat as empty */ }

                    if (seen[dedupeKey]) {
                        emitAllow();
                        return;
                    }

                    seen[dedupeKey] = true;
                    try {
                        require('fs').writeFileSync(seenFilePath, JSON.stringify(seen));
                    } catch { /* best-effort — don't fail the hook */ }
                }

                emitContext('PreToolUse',
                    '[Latentgraph] About to edit indexed source file: ' + normalized + '\\n' +
                    'STOP. Before this edit, call these three MCPs in parallel against the file:\\n' +
                    '  1. mcp__lgraph__get_dependencies(file_path="' + normalized + '") — what it imports and what depends on it\\n' +
                    '  2. mcp__lgraph__get_change_impact(target="' + normalized + '") — downstream blast radius. ' +
                    'If you are editing a specific function, prefer target="' + normalized + '::<symbol_name>" for tighter scope.\\n' +
                    '  3. mcp__lgraph__get_design_knowledge(target="' + normalized + '") — PR-mined invariants you must not break\\n' +
                    'Skip only if you have already pulled these for this file this session.');
                return;
            }
            break;
        }

        case 'Bash': {
            const command = toolInput.command || '';
            if (isBashSearch(command)) {
                suggestion =
                    '[Latentgraph] You are running a source-code search. Consider using MCP first:\\n' +
                    '  - mcp__lgraph__get_context(targets=["project"]) for navigation and architecture\\n' +
                    '  - mcp__lgraph__get_dependencies for relationships and coupling\\n' +
                    '  - mcp__lgraph__get_change_impact for downstream impact\\n' +
                    '  - mcp__lgraph__get_file for file understanding';
            }
            if (suggestion && seenFilePath) {
                const dedupeKey = 'bash:' + command.slice(0, 120);
                let seen = {};
                try { seen = JSON.parse(require('fs').readFileSync(seenFilePath, 'utf8')); } catch { /* ignore */ }
                if (seen[dedupeKey]) { emitAllow(); return; }
                seen[dedupeKey] = true;
                try { require('fs').writeFileSync(seenFilePath, JSON.stringify(seen)); } catch { /* ignore */ }
            }
            break;
        }

        default:
            break;
    }

    if (suggestion) {
        emitContext('PreToolUse', suggestion);
    } else {
        emitAllow();
    }
}

main().catch(() => {
    emitAllow();
});
`;

interface InnerHookEntry {
    type: 'command';
    command: string;
    timeout: number;
    statusMessage: string;
}

interface MatcherEntry {
    matcher: string;
    hooks: InnerHookEntry[];
}

interface HooksConfig {
    PreToolUse?: MatcherEntry[];
    PostToolUse?: MatcherEntry[];
    PreCompact?: MatcherEntry[];
    [key: string]: MatcherEntry[] | undefined;
}

interface SettingsJson {
    hooks?: HooksConfig;
    [key: string]: unknown;
}

export interface GenerateHooksResult {
    hookFilePath: string;
    settingsUpdated: boolean;
}

/**
 * Write the hook script and register it in .claude/settings.json.
 *
 * settings.json is shared with the team; the generated hook script is local
 * and gitignored.
 */
export function generateHookFiles(projectRoot: string): GenerateHooksResult {
    const hookDir = path.join(projectRoot, '.claude', 'hooks', 'lgraph');
    if (!fs.existsSync(hookDir)) {
        fs.mkdirSync(hookDir, { recursive: true });
    }

    const hookFilePath = path.join(hookDir, 'lgraph-hook.cjs');
    fs.writeFileSync(hookFilePath, HOOK_SCRIPT);
    fs.chmodSync(hookFilePath, 0o755);

    const settingsPath = path.join(projectRoot, '.claude', 'settings.json');
    let settings: SettingsJson = {};

    if (fs.existsSync(settingsPath)) {
        try {
            settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        } catch {
            settings = {};
        }
    }

    if (!settings.hooks) {
        settings.hooks = {};
    }

    const hookCommand = 'node ".claude/hooks/lgraph/lgraph-hook.cjs"';
    const isLgraphMatcher = (m: MatcherEntry) =>
        m.hooks?.some(h => h.command.includes('lgraph-hook'));

    const preMatcherEntry: MatcherEntry = {
        matcher: 'Grep|Glob|Read|Bash|Edit|Write|MultiEdit',
        hooks: [{
            type: 'command',
            command: hookCommand,
            timeout: 15,
            statusMessage: 'Checking Latentgraph knowledge graph...',
        }],
    };

    if (!settings.hooks.PreToolUse) {
        settings.hooks.PreToolUse = [];
    }
    settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(m => !isLgraphMatcher(m));
    settings.hooks.PreToolUse.push(preMatcherEntry);

    // Add PostToolUse hook for memory reminders
    const postMatcherEntry: MatcherEntry = {
        matcher: 'Read|mcp__lgraph__get_file|mcp__lgraph__get_context|mcp__lgraph__get_dependencies|mcp__lgraph__ask_codebase',
        hooks: [{
            type: 'command',
            command: hookCommand,
            timeout: 5,
            statusMessage: 'Checking for learnings to record...',
        }],
    };

    if (!settings.hooks.PostToolUse) {
        settings.hooks.PostToolUse = [];
    }
    settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter(m => !isLgraphMatcher(m));
    settings.hooks.PostToolUse.push(postMatcherEntry);

    // Add PreCompact hook to remind the agent to flush session learnings via update_graph
    const preCompactMatcherEntry: MatcherEntry = {
        matcher: '',
        hooks: [{
            type: 'command',
            command: hookCommand,
            timeout: 5,
            statusMessage: 'Reminding to flush Latentgraph learnings...',
        }],
    };

    if (!settings.hooks.PreCompact) {
        settings.hooks.PreCompact = [];
    }
    settings.hooks.PreCompact = settings.hooks.PreCompact.filter(m => !isLgraphMatcher(m));
    settings.hooks.PreCompact.push(preCompactMatcherEntry);

    const claudeDir = path.join(projectRoot, '.claude');
    if (!fs.existsSync(claudeDir)) {
        fs.mkdirSync(claudeDir, { recursive: true });
    }

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

    return { hookFilePath, settingsUpdated: true };
}
