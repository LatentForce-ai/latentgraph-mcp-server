import { exec } from 'child_process';
import { promisify } from 'util';
import { readProjectConfig, writeProjectConfig, ensureScanTargetFile, isReadOnlyProject, getGithubToken, setGithubToken } from '../../utils/config.js';
import { startDaemon, getDaemonStatus } from '../../daemon/daemon-manager.js';
import { resolveApiKey, resolveProject } from '../../utils/auth-resolver.js';
import { promptGithubToken } from '../../utils/prompts.js';

const execAsync = promisify(exec);

export interface StartOptions {
    apiKey?: string;
    ghToken?: string;
    projectName?: string;
    projectId?: string;
}

export async function startCommand(options: StartOptions = {}): Promise<void> {
    const projectRoot = process.cwd();
    const isAuthInteractive = !options.apiKey;
    const isProjectInteractive = !!(process.stdin.isTTY);

    // Block contributors and public viewers — no daemon needed; they use MCP tools directly
    const { readOnly, reason } = isReadOnlyProject(projectRoot);
    if (readOnly) {
        const label = reason === 'contributor' ? 'contributor' : 'public (read-only) viewer';
        console.error(`❌ This project was joined as a ${label}.`);
        console.error('   Run "lgraph add <ai-tool>" to configure MCP in your AI agent,');
        console.error('   then use the MCP tools from there.');
        process.exit(1);
    }

    console.log('╔════════════════════════════════════════════╗');
    console.log('║           Starting Latentgraph             ║');
    console.log('╚════════════════════════════════════════════╝\n');

    // Step 1: Resolve API key
    console.log('[Start] Step 1/5: Checking API key...');
    const authResult = await resolveApiKey({
        apiKey: options.apiKey,
        interactive: isAuthInteractive,
        commandLabel: 'Start',
    });
    const apiKey = authResult.apiKey;

    // Step 2: Optional GitHub token for PR insights
    console.log('[Start] Step 2/5: Checking GitHub token...');
    if (options.ghToken) {
        setGithubToken(options.ghToken);
        console.log('[Start] ✓ GitHub token saved\n');
    } else if (isAuthInteractive && process.stdin.isTTY) {
        const existingToken = getGithubToken();
        if (existingToken) {
            console.log('[Start] ✓ GitHub token found\n');
        } else {
            const token = await promptGithubToken();
            if (token) {
                setGithubToken(token);
                console.log('[Start] ✓ GitHub token saved\n');
            } else {
                console.log('[Start] ⏭  GitHub token skipped (PR insights disabled)\n');
            }
        }
    } else {
        const existingToken = getGithubToken();
        if (existingToken) {
            console.log('[Start] ✓ GitHub token found\n');
        } else {
            console.log('[Start] ⚠  No GitHub token configured (PR insights disabled)\n');
        }
    }

    // Step 3: Resolve project
    console.log('[Start] Step 3/5: Checking project configuration...');

    const project = await resolveProject({
        apiKey,
        projectId: options.projectId,
        projectName: options.projectName,
        interactive: isProjectInteractive,
        commandLabel: 'Start',
        projectRoot,
    });

    const projectConfig = readProjectConfig(projectRoot);
    if (!projectConfig) {
        console.error('❌ Failed to configure project');
        process.exit(1);
    }

    // Persist default_branch when missing — only lgraph init sets it normally,
    // but lgraph update needs it. Read from git so users don't have to re-init
    // after deleting .lgraph.
    if (!projectConfig.default_branch && !projectConfig.user_branch) {
        try {
            const { stdout } = await execAsync('git branch --show-current', { cwd: projectRoot });
            const branch = stdout.trim();
            if (branch) {
                projectConfig.default_branch = branch;
                writeProjectConfig(projectConfig, projectRoot);
                console.log(`[Start] ✓ Branch detected: ${branch}\n`);
            }
        } catch { /* not a git repo or git unavailable — skip */ }
    }

    // Ensure .lgraph/scan_target.json exists (template for user customization)
    ensureScanTargetFile(projectRoot);

    // Step 4: Check if daemon is already running
    console.log('[Start] Step 4/5: Checking daemon status...');
    const status = getDaemonStatus(projectRoot);
    if (status.running) {
        console.log(`[Start] ✓ Daemon is already running (PID: ${status.pid})`);
        console.log(`[Start]   WebSocket: ${status.connected ? 'Connected' : 'Connecting...'}\n`);
        return;
    }
    console.log('[Start] Daemon not running\n');

    // Step 5: Start daemon
    console.log('[Start] Step 5/5: Starting daemon...');
    const result = await startDaemon(projectRoot, project.projectId, apiKey);

    if (!result.success) {
        console.error(`\n❌ Failed to start daemon: ${result.error}`);
        process.exit(1);
    }

    const connected = getDaemonStatus(projectRoot).connected;
    console.log(`[Start] ✓ Daemon started (PID: ${result.pid})`);
    if (connected) {
        console.log('[Start] ✓ Connected to Latentgraph server');
    } else {
        console.log('[Start] ⏳ Connecting to Latentgraph server...');
    }
    console.log('\n╔════════════════════════════════════════════╗');
    console.log('║         Latentgraph is now running!        ║');
    console.log('╚════════════════════════════════════════════╝');
    console.log('\nUse "lgraph status" to check connection status.');
    console.log('Use "lgraph init" to scan and index the project.');
    console.log('Use "lgraph stop" to stop the daemon.\n');
}
