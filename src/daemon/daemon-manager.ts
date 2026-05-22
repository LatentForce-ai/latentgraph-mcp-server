import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import {
    readDaemonPid,
    writeDaemonPid,
    removeDaemonPid,
    removeDaemonStatus,
    readDaemonStatus,
    isProcessRunning,
    DaemonStatus,
} from '../utils/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface StartDaemonResult {
    success: boolean;
    pid?: number;
    error?: string;
}

export interface StopDaemonResult {
    success: boolean;
    error?: string;
}

export interface DaemonStatusResult {
    running: boolean;
    pid?: number;
    connected?: boolean;
    projectId?: string;
    startedAt?: string;
}

function getDaemonScriptPath(): string {
    // The daemon.js will be in the same directory as daemon-manager.js after compilation
    return path.join(__dirname, 'daemon.js');
}

export async function startDaemon(
    projectRoot: string,
    projectId: string,
    apiKey: string
): Promise<StartDaemonResult> {
    // Check if daemon is already running
    const existingPid = readDaemonPid(projectRoot);
    if (existingPid && isProcessRunning(existingPid)) {
        return {
            success: false,
            error: `Daemon already running with PID ${existingPid}`,
            pid: existingPid,
        };
    }

    // Clean up stale files if process is not running
    if (existingPid) {
        removeDaemonPid(projectRoot);
        removeDaemonStatus(projectRoot);
    }

    const daemonScript = getDaemonScriptPath();

    if (!fs.existsSync(daemonScript)) {
        return {
            success: false,
            error: `Daemon script not found at ${daemonScript}`,
        };
    }

    try {
        // Spawn detached daemon process
        const child = spawn(process.execPath, [daemonScript, projectRoot, projectId, apiKey], {
            detached: true,
            stdio: 'ignore',
            cwd: projectRoot,
        });

        if (!child.pid) {
            return {
                success: false,
                error: 'Failed to spawn daemon process',
            };
        }

        // Detach from parent
        child.unref();

        // Write PID file
        writeDaemonPid(child.pid, projectRoot);

        // Poll up to 5s to detect auth failure (fast exit) or confirmed connection
        const pid = child.pid;
        const maxWait = 5000;
        const interval = 200;
        let waited = 0;

        while (waited < maxWait) {
            await new Promise((resolve) => setTimeout(resolve, interval));
            waited += interval;

            if (!isProcessRunning(pid)) {
                // Daemon exited early — almost certainly an auth failure
                removeDaemonPid(projectRoot);
                removeDaemonStatus(projectRoot);
                return {
                    success: false,
                    pid,
                    error: 'Authentication failed — the API key may be invalid or you are not the project owner.',
                };
            }

            const status = readDaemonStatus(projectRoot);
            if (status?.connected) {
                return { success: true, pid };
            }
        }

        // Still running but not connected yet (slow network) — report started
        return { success: true, pid };

    } catch (error) {
        return {
            success: false,
            error: `Failed to start daemon: ${(error as Error).message}`,
        };
    }
}

export async function stopDaemon(projectRoot: string): Promise<StopDaemonResult> {
    const pid = readDaemonPid(projectRoot);

    if (!pid) {
        return {
            success: false,
            error: 'No daemon PID file found',
        };
    }

    if (!isProcessRunning(pid)) {
        // Clean up stale files
        removeDaemonPid(projectRoot);
        removeDaemonStatus(projectRoot);
        return {
            success: true,
        };
    }

    try {
        // Send SIGTERM for graceful shutdown
        process.kill(pid, 'SIGTERM');

        // Wait for process to exit (with timeout)
        const maxWait = 5000;
        const checkInterval = 100;
        let waited = 0;

        while (waited < maxWait && isProcessRunning(pid)) {
            await new Promise((resolve) => setTimeout(resolve, checkInterval));
            waited += checkInterval;
        }

        // If still running, force kill
        if (isProcessRunning(pid)) {
            try {
                process.kill(pid, 'SIGKILL');
            } catch {
                // Process might have exited between check and kill
            }
        }

        // Clean up files
        removeDaemonPid(projectRoot);
        removeDaemonStatus(projectRoot);

        return {
            success: true,
        };
    } catch (error) {
        // Clean up files even on error
        removeDaemonPid(projectRoot);
        removeDaemonStatus(projectRoot);

        return {
            success: false,
            error: `Failed to stop daemon: ${(error as Error).message}`,
        };
    }
}

export function getDaemonStatus(projectRoot: string): DaemonStatusResult {
    const pid = readDaemonPid(projectRoot);
    const status = readDaemonStatus(projectRoot);

    if (!pid) {
        return { running: false };
    }

    const running = isProcessRunning(pid);

    if (!running) {
        // Clean up stale files
        removeDaemonPid(projectRoot);
        removeDaemonStatus(projectRoot);
        return { running: false };
    }

    return {
        running: true,
        pid,
        connected: status?.connected ?? false,
        projectId: status?.project_id,
        startedAt: status?.started_at,
    };
}
