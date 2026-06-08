#!/usr/bin/env node

/**
 * Daemon process entry point.
 * This script runs as a detached background process and manages the WebSocket connection.
 * Matching extension's behavior.
 *
 * Usage: node daemon.js <projectRoot> <projectId> <apiKey>
 */

import { existsSync, statSync } from 'fs';
import { WebSocketClient } from './websocket-client.js';
import { writeDaemonStatus, removeDaemonPid, removeDaemonStatus, DaemonStatus } from '../utils/config.js';

const args = process.argv.slice(2);

if (args.length < 3) {
    console.error('Usage: daemon <projectRoot> <projectId> <apiKey>');
    process.exit(1);
}

const [projectRoot, projectId, apiKey] = args;

// Refuse to start if the directory we'd execute tool calls in is missing.
// The orchestrator proxies git diff / read_files through this daemon and
// runs them against `projectRoot`; if the directory was moved or deleted
// since the last `lgraph init`, the daemon would register on the WebSocket
// but every tool call would silently fail downstream. Fail loud, fail early.
if (!existsSync(projectRoot) || !statSync(projectRoot).isDirectory()) {
    console.error(`[Daemon] ❌ working_directory does not exist: ${projectRoot}`);
    console.error('[Daemon]    The project may have been moved or deleted since the daemon was last started.');
    console.error('[Daemon]    Run `lgraph stop` then `lgraph start` from the project root to re-register.');
    process.exit(1);
}

let wsClient: WebSocketClient | null = null;
let isShuttingDown = false;
let startedAt = new Date().toISOString();

function updateStatus(connected: boolean): void {
    const status: DaemonStatus = {
        pid: process.pid,
        connected,
        project_id: projectId,
        started_at: startedAt,
        working_directory: projectRoot,
    };
    writeDaemonStatus(status, projectRoot);
}

function cleanup(): void {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log('[Daemon] Shutting down...');

    if (wsClient) {
        wsClient.disconnect();
        wsClient = null;
    }

    removeDaemonPid(projectRoot);
    removeDaemonStatus(projectRoot);

    process.exit(0);
}

// Handle graceful shutdown
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
process.on('SIGHUP', cleanup);

// Handle uncaught errors
process.on('uncaughtException', (error) => {
    console.error('[Daemon] Uncaught exception:', error);
    cleanup();
});

process.on('unhandledRejection', (reason) => {
    console.error('[Daemon] Unhandled rejection:', reason);
    cleanup();
});

async function main(): Promise<void> {
    console.log('╔════════════════════════════════════════════╗');
    console.log('║        Latentgraph Daemon Starting         ║');
    console.log('╚════════════════════════════════════════════╝');
    console.log(`[Daemon] Project ID: ${projectId}`);
    console.log(`[Daemon] Project root: ${projectRoot}`);
    console.log(`[Daemon] PID: ${process.pid}`);

    // Initial status - not connected yet
    updateStatus(false);

    wsClient = new WebSocketClient({
        projectId,
        apiKey,
        workspaceRoot: projectRoot,
    });

    // Set up event listeners - matching extension's setupWebSocketListeners
    wsClient.on('connecting', () => {
        console.log('[Daemon] WebSocket connecting...');
    });

    wsClient.on('connected', (projectInfo) => {
        console.log('[Daemon] ✓ Connected to project:', projectInfo?.project_name);
        updateStatus(true);
    });

    wsClient.on('disconnected', (code, reason) => {
        console.log(`[Daemon] Disconnected (code: ${code}, reason: ${reason})`);
        updateStatus(false);
    });

    wsClient.on('auth_failed', (message) => {
        console.error(`[Daemon] ❌ Authentication failed: ${message}`);
        cleanup();
    });

    wsClient.on('error', (error) => {
        console.error('[Daemon] WebSocket error:', error.message);
        updateStatus(false);
    });

    wsClient.on('reconnecting', (attempt) => {
        console.log(`[Daemon] Reconnecting... (attempt ${attempt})`);
    });

    wsClient.on('max_reconnects_reached', () => {
        console.error('[Daemon] ❌ Max reconnection attempts reached. Stopping daemon.');
        cleanup();
    });

    wsClient.on('message', (message) => {
        console.log(`[Daemon] Received message: ${message.type}`);
    });

    wsClient.on('tool_executed', ({ tool, result, requestId }) => {
        console.log(`[Daemon] ✓ Tool executed: ${tool} (${requestId})`);
    });

    wsClient.on('tool_error', ({ tool, error, requestId }) => {
        console.error(`[Daemon] ✗ Tool failed: ${tool} (${requestId}):`, error.message);
    });

    // Connect to WebSocket
    try {
        await wsClient.connect();
        console.log('[Daemon] ✓ Initial connection successful');
    } catch (error) {
        console.error('[Daemon] Initial connection failed:', (error as Error).message);
        // Don't exit - the WebSocket client will handle reconnection
    }
}

main().catch((error) => {
    console.error('[Daemon] Fatal error:', error);
    cleanup();
});
