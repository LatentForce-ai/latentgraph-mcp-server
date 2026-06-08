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
    let branch = process.env.LGRAPH_BRANCH || '';

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
    if (!projectId || !branch) {
        try {
            const projCfg = JSON.parse(
                fs.readFileSync(path.join(cwd, '.lgraph', 'config.json'), 'utf-8')
            );
            if (!projectId) projectId = projCfg.project_id || '';
            if (!branch) branch = projCfg.user_branch || projCfg.default_branch || '';
        } catch { /* no project config */ }
    }

    if (!apiUrl) apiUrl = 'https://latentgraph.latentforce.ai';
    if (!apiKey || !projectId || !branch) return null;

    return { apiUrl, apiKey, projectId, branch };
}

const CACHE_TTL_MS = 600000;
const CACHE_DIR = require('os').tmpdir() + '/lgraph-hook-cache';

async function cachedFetch(cacheKey, fetcher) {
    const fs = require('fs');
    const path = require('path');
    const crypto = require('crypto');
    try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
    } catch { /* ignore */ }
    const file = path.join(CACHE_DIR, crypto.createHash('sha256').update(cacheKey).digest('hex') + '.json');
    try {
        const stat = fs.statSync(file);
        if (Date.now() - stat.mtimeMs < CACHE_TTL_MS) {
            const raw = fs.readFileSync(file, 'utf8');
            return raw === 'null' ? null : JSON.parse(raw);
        }
    } catch { /* not cached or stale */ }
    const data = await fetcher();
    try {
        fs.writeFileSync(file, data === null ? 'null' : JSON.stringify(data));
    } catch { /* best-effort */ }
    return data;
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
    const target = data.path || '';

    let header = '[Latentgraph] File: ' + target;
    if (data.module_name) header += ' | Module: ' + data.module_name;
    if (data.file_category) header += ' | Category: ' + data.file_category;
    lines.push(header);

    if (typeof data.summary === 'string' && data.summary) {
        lines.push('Summary: ' + data.summary);
    } else if (data.summary && typeof data.summary === 'object' && data.summary.text) {
        lines.push('Summary: ' + data.summary.text);
    }
    if (data.modification_impact) lines.push('Modification impact: ' + data.modification_impact);

    const keySymbols = (data.key_symbols || []).slice(0, 5);
    if (keySymbols.length > 0) {
        const total = data.key_symbols_total || keySymbols.length;
        lines.push('Key symbols (' + keySymbols.length + ' of ' + total + '):');
        for (const sym of keySymbols) {
            const span = Array.isArray(sym.span) && sym.span.length === 2
                ? ' [L' + sym.span[0] + '-' + sym.span[1] + ']' : '';
            const asyncFlag = sym.is_async ? ' (async)' : '';
            const sig = sym.signature || sym.name || '';
            lines.push('- [' + (sym.kind || 'symbol') + '] ' + sig + asyncFlag + span);
        }
    }

    const apiEndpoints = (data.api_endpoints || []).slice(0, 3);
    if (apiEndpoints.length > 0) {
        lines.push('API endpoints:');
        for (const ep of apiEndpoints) {
            lines.push('- ' + (ep.method || '') + ' ' + (ep.path || '') + ' -> ' + (ep.handler_name || ''));
        }
    }

    const storage = data.storage_backends || [];
    if (storage.length > 0) {
        lines.push('Storage: ' + storage.map(function(b) { return b.type; }).join(', '));
    }

    lines.push('For invariants/decisions, call mcp__lgraph__get_pr_insights(target="' + target + '").');
    if (data.module_name) {
        lines.push('For module context (sibling files, child modules, narrative), call mcp__lgraph__get_module_info(module_path="' + data.module_name + '").');
    }
    if (target) {
        const dir = target.split('/').slice(0, -1).join('/');
        if (dir) lines.push('To list every symbol in this directory, call mcp__lgraph__get_symbol(file_prefix="' + dir + '/"). Add name="<your_symbol>" to filter.');
    }

    return lines.join('\\n');
}

async function fetchFileContext(filePath, cwd) {
    const config = resolveConfig(cwd);
    if (!config) return null;
    const normalized = normalizePath(filePath, cwd);
    const key = 'file:' + config.projectId + ':' + config.branch + ':' + normalized;
    const data = await cachedFetch(key, async function() {
        try {
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
                    branch: config.branch,
                }),
                signal: controller.signal,
            });
            clearTimeout(timeout);
            if (!response.ok) return null;
            const body = await response.json();
            if (!body || body.degraded) return null;
            return body;
        } catch {
            return null;
        }
    });
    return data ? formatFileContext(data) : null;
}

async function fetchDependencies(filePath, cwd) {
    const config = resolveConfig(cwd);
    if (!config) return null;
    const normalized = normalizePath(filePath, cwd);
    const key = 'deps:' + config.projectId + ':' + config.branch + ':' + normalized;
    return cachedFetch(key, async function() {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(function() { controller.abort(); }, 7000);
            const response = await fetch(config.apiUrl + '/api/v1/mcp/dependency', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + config.apiKey,
                },
                body: JSON.stringify({
                    path: normalized,
                    project_id: config.projectId,
                    branch: config.branch,
                }),
                signal: controller.signal,
            });
            clearTimeout(timeout);
            if (!response.ok) return null;
            const data = await response.json();
            return data || null;
        } catch {
            return null;
        }
    });
}

async function fetchPRInsights(target, cwd) {
    const config = resolveConfig(cwd);
    if (!config) return null;
    const key = 'pri:' + config.projectId + ':' + config.branch + ':' + target;
    return cachedFetch(key, async function() {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(function() { controller.abort(); }, 7000);
            const response = await fetch(config.apiUrl + '/api/v1/mcp/pr-insights', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + config.apiKey,
                },
                body: JSON.stringify({
                    target: target,
                    project_id: config.projectId,
                    branch: config.branch,
                }),
                signal: controller.signal,
            });
            clearTimeout(timeout);
            if (!response.ok) return null;
            const data = await response.json();
            return data || null;
        } catch {
            return null;
        }
    });
}

async function fetchProjectOverview(cwd) {
    const config = resolveConfig(cwd);
    if (!config) return null;
    const key = 'overview:' + config.projectId + ':' + config.branch;
    return cachedFetch(key, async function() {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(function() { controller.abort(); }, 10000);
            const url = config.apiUrl + '/api/v1/mcp/project-overview'
                + '?project_id=' + encodeURIComponent(config.projectId)
                + '&branch=' + encodeURIComponent(config.branch);
            const response = await fetch(url, {
                method: 'GET',
                headers: { 'Authorization': 'Bearer ' + config.apiKey },
                signal: controller.signal,
            });
            clearTimeout(timeout);
            if (!response.ok) return null;
            const data = await response.json();
            return data || null;
        } catch {
            return null;
        }
    });
}

function clip(text, max) {
    if (!text) return '';
    const s = String(text);
    return s.length > max ? s.slice(0, max).trimEnd() + '…' : s;
}

function formatDependencies(data, filePath) {
    if (!data) return '';
    const lines = [];
    lines.push('[Latentgraph] Dependencies for ' + filePath);
    const outgoing = Array.isArray(data.outgoing) ? data.outgoing : [];
    const incoming = Array.isArray(data.incoming) ? data.incoming : [];
    const outExplicit = outgoing.filter(function(e) { return !e.implicit; }).slice(0, 5);
    const outImplicit = outgoing.filter(function(e) { return e.implicit; }).slice(0, 5);
    const inExplicit = incoming.filter(function(e) { return !e.implicit; }).slice(0, 5);
    const inImplicit = incoming.filter(function(e) { return e.implicit; }).slice(0, 5);
    if (outExplicit.length === 0 && outImplicit.length === 0 && inExplicit.length === 0 && inImplicit.length === 0) {
        lines.push('(no edges recorded — file may be isolated or degraded)');
        return lines.join('\\n');
    }
    if (outExplicit.length > 0) {
        lines.push('Outgoing — explicit imports (' + outExplicit.length + '):');
        for (const e of outExplicit) {
            const imports = Array.isArray(e.imports) && e.imports.length ? ' [' + e.imports.slice(0, 4).join(', ') + ']' : '';
            lines.push('  → ' + e.target + imports + (e.summary ? ' — ' + clip(e.summary, 100) : ''));
        }
    }
    if (outImplicit.length > 0) {
        lines.push('Outgoing — implicit runtime coupling (' + outImplicit.length + '):');
        for (const e of outImplicit) {
            lines.push('  ⇢ ' + e.target + (e.summary ? ' — ' + clip(e.summary, 100) : '') + (e.data_flow ? ' [' + clip(e.data_flow, 40) + ']' : ''));
        }
    }
    if (inExplicit.length > 0) {
        lines.push('Incoming — explicit dependents (' + inExplicit.length + ', blast radius):');
        for (const e of inExplicit) {
            const imports = Array.isArray(e.imports) && e.imports.length ? ' [' + e.imports.slice(0, 4).join(', ') + ']' : '';
            lines.push('  ← ' + e.source + imports + (e.summary ? ' — ' + clip(e.summary, 100) : ''));
        }
    }
    if (inImplicit.length > 0) {
        lines.push('Incoming — implicit consumers (' + inImplicit.length + '):');
        for (const e of inImplicit) {
            lines.push('  ⇠ ' + e.source + (e.summary ? ' — ' + clip(e.summary, 100) : ''));
        }
    }
    if (data.degraded) lines.push('(degraded: edge summaries may be empty; paths still valid)');
    return lines.join('\\n');
}

function formatPRInsights(data, target) {
    if (!data) return '';
    const lines = [];
    lines.push('[Latentgraph] Recorded knowledge for ' + target);
    const invariants = Array.isArray(data.invariants) ? data.invariants.slice(0, 3) : [];
    const decisions = Array.isArray(data.decisions) ? data.decisions.slice(0, 2) : [];
    if (invariants.length === 0 && decisions.length === 0) {
        if (data.degraded) {
            lines.push('(knowledge layer absent for this project)');
        } else {
            lines.push('(no recorded knowledge for this scope)');
        }
        return lines.join('\\n');
    }
    if (invariants.length > 0) {
        lines.push('Invariants (MUST respect):');
        for (const inv of invariants) {
            const sev = inv.severity ? ' [' + inv.severity + ']' : '';
            const cons = inv.consequence ? ' — ' + clip(inv.consequence, 120) : '';
            lines.push('  • ' + clip(inv.rule || '', 200) + sev + cons);
        }
    }
    if (decisions.length > 0) {
        lines.push('Decisions:');
        for (const d of decisions) {
            const imp = typeof d.importance === 'number' ? ' [importance ' + d.importance.toFixed(2) + ']' : '';
            const tr = d.tradeoffs ? ' — ' + clip(d.tradeoffs, 120) : '';
            lines.push('  • ' + clip(d.choice || '', 200) + imp + tr);
        }
    }
    return lines.join('\\n');
}

function formatProjectOverview(data) {
    if (!data) return '';
    const lines = [];
    lines.push('[Latentgraph] Project orientation');
    if (data.architecture_summary) {
        lines.push('');
        lines.push(clip(data.architecture_summary, 500));
    }
    const modules = Array.isArray(data.top_level_modules) ? data.top_level_modules.slice(0, 15) : [];
    if (modules.length > 0) {
        lines.push('');
        lines.push('Top modules (' + modules.length + ' of ' + (data.top_level_modules ? data.top_level_modules.length : modules.length) + '):');
        for (const m of modules) {
            const fc = typeof m.file_count === 'number' ? ' (' + m.file_count + ' files)' : '';
            const sum = m.summary ? ' — ' + clip(m.summary, 80) : '';
            lines.push('  • ' + (m.path || m.name || '?') + fc + sum);
        }
    }
    lines.push('');
    lines.push('Call mcp__lgraph__get_module_info(module_path="…") to drill into a module.');
    if (data.degraded) lines.push('(degraded: overview is partial)');
    return lines.join('\\n');
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

    // Handle SessionStart - inject project overview so the agent is oriented from turn 1
    if (hookEventName === 'SessionStart') {
        const cwd = input.cwd || process.cwd();
        const overview = await fetchProjectOverview(cwd);
        if (overview) {
            emitContext('SessionStart', formatProjectOverview(overview));
        } else {
            emitContext('SessionStart',
                '[Latentgraph] Project overview unavailable from hook. ' +
                'Call mcp__lgraph__get_project_overview() to orient before drilling deeper.'
            );
        }
        return;
    }

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
        // After editing a source file, nudge to verify callers via get_call_chain
        if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit') {
            const filePath = toolInput.file_path || toolInput.path || '';
            if (isSourceFile(filePath)) {
                const cwd = input.cwd || process.cwd();
                const normalized = normalizePath(filePath, cwd);
                if (seenFilePath) {
                    const dedupeKey = 'post-edit:' + normalized;
                    let seen = {};
                    try { seen = JSON.parse(require('fs').readFileSync(seenFilePath, 'utf8')); } catch { /* ignore */ }
                    if (seen[dedupeKey]) { emitAllow(); return; }
                    seen[dedupeKey] = true;
                    try { require('fs').writeFileSync(seenFilePath, JSON.stringify(seen)); } catch { /* ignore */ }
                }
                emitContext('PostToolUse',
                    '[Latentgraph] You just edited an indexed source file: ' + normalized + '\\n' +
                    'Verify nothing downstream broke: call mcp__lgraph__get_call_chain(symbol="' + normalized + '::<edited_symbol>", direction="callers") for each function whose contract you changed.\\n' +
                    'Skip if you only changed bodies (no signature/contract change).'
                );
                return;
            }
        }

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
                        'Use fully-qualified form: <file>::<Class>.<method> for methods, <file>::<function> for top-level\\n' +
                        'Skip if you do not need to trace execution flow for this file.');
                    return;
                }
            }
        }

        // After reading files or using MCP tools, remind to record learnings
        if (toolName === 'Read'
            || toolName === 'mcp__lgraph__get_file'
            || toolName === 'mcp__lgraph__get_project_overview'
            || toolName === 'mcp__lgraph__get_module_info') {
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
                    'and implicit coupling strength.';
            } else if (hasSourceTarget) {
                suggestion =
                    '[Latentgraph] This project has a pre-built DRG plus Wiki module docs. ' +
                    'Before grepping indexed source files, consider:\\n' +
                    '  - mcp__lgraph__get_file — file summary, symbols, endpoints, and dependents\\n' +
                    '  - mcp__lgraph__get_dependencies — bidirectional relationships and coupling\\n' +
                    '  - mcp__lgraph__get_symbol — locate a function/class by name';
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
                    '  - mcp__lgraph__get_project_overview() — architecture summary and top-level modules\\n' +
                    '  - mcp__lgraph__get_module_info(module_path="<module-name>") — files and child modules for a specific module\\n' +
                    '  - mcp__lgraph__get_symbol(name="<symbol>") — locate a function/class without scanning paths';
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

                const [fileCtx, deps, pri] = await Promise.all([
                    fetchFileContext(filePath, cwd),
                    fetchDependencies(filePath, cwd),
                    fetchPRInsights(normalized, cwd),
                ]);
                const blocks = [];
                if (fileCtx) blocks.push(fileCtx);
                if (deps) blocks.push(formatDependencies(deps, normalized));
                if (pri) blocks.push(formatPRInsights(pri, normalized));
                if (blocks.length === 0) {
                    blocks.push(
                        '[Latentgraph] About to edit indexed source file: ' + normalized + '\\n' +
                        'Hook fetch failed — manually call mcp__lgraph__get_dependencies(file_path="' + normalized + '") + mcp__lgraph__get_pr_insights(target="' + normalized + '") before editing.'
                    );
                }
                blocks.push(
                    '[Latentgraph] For function-signature edits, call mcp__lgraph__get_call_chain(symbol="' + normalized + '::<symbol_name>", direction="callers") to see who breaks.'
                );
                emitContext('PreToolUse', blocks.join('\\n\\n---\\n\\n'));
                return;
            }
            break;
        }

        case 'Bash': {
            const command = toolInput.command || '';
            if (isBashSearch(command)) {
                suggestion =
                    '[Latentgraph] You are running a source-code search. Consider using MCP first:\\n' +
                    '  - mcp__lgraph__get_project_overview() for navigation and architecture\\n' +
                    '  - mcp__lgraph__get_symbol(name="<x>") to locate a definition by name\\n' +
                    '  - mcp__lgraph__get_dependencies for relationships and coupling\\n' +
                    '  - mcp__lgraph__get_file for single-file metadata';
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
        matcher: 'Read|Edit|Write|MultiEdit|mcp__lgraph__get_file|mcp__lgraph__get_project_overview|mcp__lgraph__get_module_info|mcp__lgraph__get_dependencies|mcp__lgraph__get_pr_insights|mcp__lgraph__ask_codebase',
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

    // Add SessionStart hook to inject project overview into the agent's context from turn 1
    const sessionStartMatcherEntry: MatcherEntry = {
        matcher: 'startup',
        hooks: [{
            type: 'command',
            command: hookCommand,
            timeout: 15,
            statusMessage: 'Loading Latentgraph project overview...',
        }],
    };

    if (!settings.hooks.SessionStart) {
        settings.hooks.SessionStart = [];
    }
    settings.hooks.SessionStart = settings.hooks.SessionStart.filter(m => !isLgraphMatcher(m));
    settings.hooks.SessionStart.push(sessionStartMatcherEntry);

    const claudeDir = path.join(projectRoot, '.claude');
    if (!fs.existsSync(claudeDir)) {
        fs.mkdirSync(claudeDir, { recursive: true });
    }

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

    return { hookFilePath, settingsUpdated: true };
}
