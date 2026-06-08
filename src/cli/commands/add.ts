import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { getConfiguredUrls, getProjectId, getApiKey, readProjectConfig } from '../../utils/config.js';
import { setupClaudeCodeIntegration } from '../../integration/claude/index.js';
import { setupCopilotIntegration } from '../../integration/copilot/index.js';
import { setupCodexIntegration } from '../../integration/codex/index.js';
import { setupKiroIntegration } from '../../integration/kiro/index.js';
import { setupLatentCodeIntegration } from '../../integration/latent-code/index.js';
import { setupOpencodeIntegration } from '../../integration/opencode/index.js';
import { setupCursorIntegration } from '../../integration/cursor/index.js';

const execFileAsync = promisify(execFile);

const SUPPORTED_TOOLS = ['latentcode', 'claude-code', 'latent-code', 'opencode', 'codex', 'copilot', 'droid', 'kiro', 'cursor'] as const;
type Tool = typeof SUPPORTED_TOOLS[number];

interface ExecError extends Error {
    code?: string | number;
    stderr?: string;
    stdout?: string;
}

function isNotFound(e: ExecError): boolean {
    return e.code === 'ENOENT' || /ENOENT|not found|not recognized/.test(e.message);
}

function getStderr(e: ExecError): string {
    return (e.stderr || e.stdout || e.message || '').trim();
}


function getMcpEnv(projectId: string): Record<string, string> {
    const urls = getConfiguredUrls();
    const env: Record<string, string> = {
        LGRAPH_PROJECT_ID: projectId,
        LGRAPH_API_URL: urls.api_url,
    };
    // For public projects, pass the share token instead of (or alongside) the API key
    const projectConfig = readProjectConfig();
    if (projectConfig?.role === 'public' && projectConfig.public_token) {
        env['LGRAPH_PUBLIC_TOKEN'] = projectConfig.public_token;
    } else {
        const apiKey = getApiKey();
        if (apiKey) env['LGRAPH_API_KEY'] = apiKey;
    }
    return env;
}

function getMcpConfig(projectId: string) {
    return {
        command: 'lgraph',
        args: ['mcp'],
        env: getMcpEnv(projectId),
    };
}

async function addClaudeCode(projectId: string, projectRoot: string, yes: boolean): Promise<void> {
    const mcpConfig = getMcpConfig(projectId);
    const jsonPayload = JSON.stringify({
        type: 'stdio',
        command: mcpConfig.command,
        args: mcpConfig.args,
        env: mcpConfig.env,
    });

    try {
        await execFileAsync('claude', ['mcp', 'add-json', 'lgraph', jsonPayload]);
        console.log('  Added Latentgraph MCP server to Claude Code.');
        console.log('\n  Verify with: claude mcp list');
    } catch (e) {
        const err = e as ExecError;
        const stderr = getStderr(err);
        const manualCmd = `claude mcp add-json lgraph '${jsonPayload}'`;
        const shellNote = process.platform === 'win32' ? '\n  (Run in PowerShell, not cmd.exe)' : '';

        if (/already exists/.test(stderr)) {
            console.log('  Latentgraph MCP server is already configured in Claude Code.');
            console.log('  To update, remove it first: claude mcp remove lgraph');
        } else if (isNotFound(err)) {
            console.log('  "claude" CLI not found. Add manually:\n');
            console.log(`  ${manualCmd}${shellNote}`);
        } else {
            console.log(`  Failed: ${stderr}`);
            console.log('\n  Try adding manually:\n');
            console.log(`  ${manualCmd}${shellNote}`);
        }
    }

    await setupClaudeCodeIntegration(projectRoot, yes
        ? { hasUserConsent: true }
        : { promptForConsent: true });
}

async function addCodex(projectId: string, projectRoot: string, yes: boolean): Promise<void> {
    const config = getMcpConfig(projectId);
    const args = ['mcp', 'add', 'lgraph'];
    for (const [k, v] of Object.entries(config.env)) {
        args.push('--env', `${k}=${v}`);
    }
    args.push('--', config.command, ...config.args);

    const manualCmd = `codex ${args.join(' ')}`;

    try {
        await execFileAsync('codex', args, { shell: true });
        console.log('  Added Latentgraph MCP server to Codex.');
        console.log('\n  Verify with: codex mcp list');
    } catch (e) {
        const err = e as ExecError;
        const stderr = getStderr(err);

        if (isNotFound(err)) {
            console.log('  "codex" CLI not found. Make sure Codex CLI is installed and on your PATH.\n');
            console.log('  Once installed, add manually:\n');
        } else if (/already exists/.test(stderr)) {
            console.log('  Latentgraph MCP server is already configured in Codex.');
            console.log('  To update, remove it first: codex mcp remove lgraph');
            return;
        } else {
            console.log(`  Failed: ${stderr}`);
            console.log('\n  Try adding manually:\n');
        }
        console.log(`  ${manualCmd}`);
    }

    await setupCodexIntegration(projectRoot, yes
        ? { hasUserConsent: true }
        : { promptForConsent: true });
}

async function addFactoryDroid(projectId: string): Promise<void> {
    const config = getMcpConfig(projectId);
    const args = ['mcp', 'add', 'lgraph', config.command];
    for (const [k, v] of Object.entries(config.env)) {
        args.push('--env', `${k}=${v}`);
    }

    const manualCmd = `droid ${args.join(' ')}`;

    try {
        await execFileAsync('droid', args, { shell: true });
        console.log('  Added Latentgraph MCP server to Factory Droid.');
        console.log('\n  Verify: type /mcp within droid to see configured servers');
    } catch (e) {
        const err = e as ExecError;
        console.log(`  Failed: ${getStderr(err)}`);
        console.log('\n  Try adding manually:\n');
        console.log(`  ${manualCmd}`);
    }
}

function mergeJsonConfig(
    filePath: string,
    serverKey: string[],
    serverValue: Record<string, unknown>,
): void {
    let config: Record<string, unknown> = {};

    if (fs.existsSync(filePath)) {
        try {
            config = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch {
            console.log(`  Warning: Could not parse existing ${filePath}, creating new file.`);
            config = {};
        }
    }

    let obj = config;
    for (let i = 0; i < serverKey.length - 1; i++) {
        const key = serverKey[i];
        if (typeof obj[key] !== 'object' || obj[key] === null) {
            obj[key] = {};
        }
        obj = obj[key] as Record<string, unknown>;
    }

    const finalKey = serverKey[serverKey.length - 1];
    obj[finalKey] = serverValue;

    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n');
}

async function addLatentCode(projectId: string, projectRoot: string, yes: boolean): Promise<void> {
    const config = getMcpConfig(projectId);
    const filePath = path.join(projectRoot, 'latent-code.json');

    let existing: Record<string, unknown> = {};
    if (fs.existsSync(filePath)) {
        try { existing = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { /* will be recreated */ }
    }
    if (!existing['$schema']) {
        existing['$schema'] = 'https://latentforce.ai/config.json';
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(existing, null, 2) + '\n');
    }

    mergeJsonConfig(filePath, ['mcp', 'lgraph'], {
        type: 'local',
        command: [config.command, ...config.args],
        enabled: true,
        environment: config.env,
    });

    console.log(`  Updated ${filePath}`);
    console.log('\n  Verify: check "mcp.lgraph" in latent-code.json\n');

    await setupLatentCodeIntegration(projectRoot, yes
        ? { hasUserConsent: true }
        : { promptForConsent: true });
}

async function addOpencode(projectId: string, projectRoot: string, yes: boolean): Promise<void> {
    const config = getMcpConfig(projectId);
    const filePath = path.join(projectRoot, 'opencode.json');

    let existing: Record<string, unknown> = {};
    if (fs.existsSync(filePath)) {
        try { existing = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { /* will be recreated */ }
    }
    if (!existing['$schema']) {
        existing['$schema'] = 'https://opencode.ai/config.json';
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(existing, null, 2) + '\n');
    }

    mergeJsonConfig(filePath, ['mcp', 'lgraph'], {
        type: 'local',
        command: [config.command, ...config.args],
        enabled: true,
        environment: config.env,
    });

    console.log(`  Updated ${filePath}`);
    console.log('\n  Verify: check "mcp.lgraph" in opencode.json\n');

    await setupOpencodeIntegration(projectRoot, yes
        ? { hasUserConsent: true }
        : { promptForConsent: true });
}

function addLatentcode(projectId: string, projectRoot: string): void {
    const config = getMcpConfig(projectId);
    const filePath = path.join(projectRoot, 'latentcode.json');

    let existing: Record<string, unknown> = {};
    if (fs.existsSync(filePath)) {
        try { existing = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { /* will be recreated */ }
    }
    if (!existing['$schema']) {
        existing['$schema'] = 'https://latentforce.ai/config.json';
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(existing, null, 2) + '\n');
    }

    mergeJsonConfig(filePath, ['mcp', 'lgraph'], {
        type: 'local',
        command: [config.command, ...config.args],
        enabled: true,
        environment: config.env,
    });

    console.log(`  Updated ${filePath}`);
    console.log('\n  Verify: check "mcp.lgraph" in latentcode.json');
}

async function addCopilot(projectId: string, projectRoot: string, yes: boolean): Promise<void> {
    const config = getMcpConfig(projectId);
    const filePath = path.join(projectRoot, '.vscode', 'mcp.json');

    mergeJsonConfig(filePath, ['servers', 'lgraph'], {
        command: config.command,
        args: config.args,
        env: config.env,
    });

    console.log(`  Updated ${filePath}`);
    console.log('\n  Verify: check "servers.lgraph" in .vscode/mcp.json');

    await setupCopilotIntegration(projectRoot, yes
        ? { hasUserConsent: true }
        : { promptForConsent: true });
}

async function addKiro(projectId: string, projectRoot: string, yes: boolean): Promise<void> {
    const config = getMcpConfig(projectId);
    const filePath = path.join(projectRoot, '.kiro', 'settings', 'mcp.json');

    mergeJsonConfig(filePath, ['mcpServers', 'lgraph'], {
        command: config.command,
        args: config.args,
        env: config.env,
    });

    console.log(`  Updated ${filePath}`);
    console.log('\n  Verify: check "mcpServers.lgraph" in .kiro/settings/mcp.json');

    await setupKiroIntegration(projectRoot, yes
        ? { hasUserConsent: true }
        : { promptForConsent: true });
}

async function addCursor(projectId: string, projectRoot: string, yes: boolean): Promise<void> {
    const config = getMcpConfig(projectId);
    const filePath = path.join(projectRoot, '.cursor', 'mcp.json');

    mergeJsonConfig(filePath, ['mcpServers', 'lgraph'], {
        command: config.command,
        args: config.args,
        env: config.env,
    });

    console.log(`  Updated ${filePath}`);
    console.log('\n  Verify: check "mcpServers.lgraph" in .cursor/mcp.json');

    await setupCursorIntegration(projectRoot, yes
        ? { hasUserConsent: true }
        : { promptForConsent: true });
}

export async function addCommand(tool: string, options: { yes?: boolean } = {}): Promise<void> {
    if (!SUPPORTED_TOOLS.includes(tool as Tool)) {
        console.error(`\n  Unknown tool: "${tool}"\n`);
        console.error('  Supported tools:');
        for (const t of SUPPORTED_TOOLS) {
            console.error(`    - ${t}`);
        }
        process.exit(1);
    }

    const projectRoot = process.cwd();
    const projectId = getProjectId(projectRoot);

    if (!projectId) {
        console.error('\n  No project configured. Run "lgraph init" first to set up your project.\n');
        process.exit(1);
    }

    console.log(`\n  Configuring Latentgraph MCP for ${tool}...\n`);

    switch (tool as Tool) {
        case 'latentcode':
            addLatentcode(projectId, projectRoot);
            break;
        case 'claude-code':
            await addClaudeCode(projectId, projectRoot, options.yes ?? false);
            break;
        case 'latent-code':
            await addLatentCode(projectId, projectRoot, options.yes ?? false);
            break;
        case 'opencode':
            await addOpencode(projectId, projectRoot, options.yes ?? false);
            break;
        case 'codex':
            await addCodex(projectId, projectRoot, options.yes ?? false);
            break;
        case 'copilot':
            await addCopilot(projectId, projectRoot, options.yes ?? false);
            break;
        case 'droid':
            await addFactoryDroid(projectId);
            break;
        case 'kiro':
            await addKiro(projectId, projectRoot, options.yes ?? false);
            break;
        case 'cursor':
            await addCursor(projectId, projectRoot, options.yes ?? false);
            break;
    }

    console.log('');
}
