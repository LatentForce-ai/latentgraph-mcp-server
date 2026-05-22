import { getDaemonStatus, stopDaemon } from '../../daemon/daemon-manager.js';
import { readProjectConfig, isReadOnlyProject } from '../../utils/config.js';

export async function stopCommand(): Promise<void> {
    const projectRoot = process.cwd();

    // Block contributors and public viewers — no daemon to stop
    const { readOnly, reason } = isReadOnlyProject(projectRoot);
    if (readOnly) {
        const label = reason === 'contributor' ? 'contributor' : 'public (read-only) viewer';
        console.error(`❌ This project was joined as a ${label}.`);
        console.error('   Run "lgraph add <ai-tool>" to configure MCP in your AI agent,');
        console.error('   then use the MCP tools from there.');
        process.exit(1);
    }

    console.log('\nStopping Latentgraph daemon...\n');

    // Check if daemon is running
    const status = getDaemonStatus(projectRoot);
    if (!status.running) {
        console.log('Daemon is not running.');
        return;
    }

    console.log(`Stopping daemon (PID: ${status.pid})...`);
    const result = await stopDaemon(projectRoot);

    if (!result.success) {
        console.error(`Failed to stop daemon: ${result.error}`);
        process.exit(1);
    }

    console.log('Daemon stopped successfully.\n');
}
