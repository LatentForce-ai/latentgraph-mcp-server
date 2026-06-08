import { getApiKey, readProjectConfig } from '../../utils/config.js';
import { getDaemonStatus } from '../../daemon/daemon-manager.js';
import { fetchProjectStatus, ProjectStatusResponse } from '../../utils/api-client.js';
import {
    PIPELINE_PHASES,
    currentPhaseLabel,
    formatTimestamp,
    formatElapsed,
} from '../../utils/phase-display.js';

const POLL_INTERVAL_MS = 10_000;
const TICK_MS = 120;
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SHORT_LABELS = PIPELINE_PHASES.map(p => p.label.split(' ')[0]);

const KEY_WIDTH = 26;
const kv = (key: string, value: string | null | undefined): string =>
    `  ${key.padEnd(KEY_WIDTH)} ${value ?? '—'}`;

/**
 * Render core backend ProjectStatusResponse fields as key-value lines.
 * Keys are exact backend JSON field names; values are the raw stored strings.
 * Line count is fixed (6) so in-place redraw works reliably.
 * Derived/computed fields (cost, elapsed, timestamps) are omitted intentionally.
 */
function buildDataLines(snap: ProjectStatusResponse | null): string[] {
    return [
        kv('init_scan_status',          snap?.init_scan_status ?? null),
        kv('pipeline_phase',            snap?.pipeline_phase ?? null),
        kv('pipeline_phase_started_at', snap?.pipeline_phase_started_at
            ? formatTimestamp(snap.pipeline_phase_started_at) : null),
        kv('indexed',                   snap?.indexed != null ? String(snap.indexed) : null),
        kv('file_count',                snap?.file_count != null ? String(snap.file_count) : null),
    ];
}

function buildAnimatedLines(
    snap: ProjectStatusResponse | null,
    spinnerIdx: number,
    elapsedSec: number,
): [string, string] {
    const isCompleted =
        snap?.init_scan_status === 'completed' ||
        snap?.init_scan_status === 'completed_with_warnings';
    const isFailed = snap?.init_scan_status === 'failed';

    const icon = isCompleted ? '✓' : isFailed ? '✗' : SPINNER[spinnerIdx % SPINNER.length];
    const phaseIdx = snap?.pipeline_phase
        ? PIPELINE_PHASES.findIndex(p => p.key === snap!.pipeline_phase)
        : -1;
    const phaseLabel =
        (snap ? currentPhaseLabel(snap.pipeline_phase) : '') || 'Connecting...';

    const done   = isCompleted ? PIPELINE_PHASES.length : Math.max(0, phaseIdx);
    const filled = isCompleted ? 10 : Math.round((done / PIPELINE_PHASES.length) * 10);
    const bar10  = '█'.repeat(filled) + '░'.repeat(10 - filled);

    const compactBar = SHORT_LABELS.map((label, i) => {
        if (isCompleted || i < phaseIdx) return `✓ ${label}`;
        if (i === phaseIdx)              return `⏳ ${label}`;
        return `○ ${label}`;
    }).join(' ');

    const line1 = `[Status] ${icon} ${phaseLabel.padEnd(28)} [${bar10}]  ${formatElapsed(elapsedSec)}`;
    const line2 = `         ${compactBar}`;
    return [line1, line2];
}

/**
 * Live-polling animated display for when init_scan_status === 'in_progress'.
 * Redraws a fixed 13-line block in-place every TICK_MS milliseconds using
 * ANSI cursor movement. Polls the backend every POLL_INTERVAL_MS seconds.
 * Stops automatically when the scan completes or fails.
 * Ctrl+C exits the watch loop; the pipeline keeps running in the background.
 */
async function watchLiveStatus(apiKey: string, projectId: string, branch: string): Promise<void> {
    let watching = true;
    let latestStatus: ProjectStatusResponse | null = null;
    let spinnerIdx = 0;

    let pollTimeoutId: ReturnType<typeof setTimeout> | null = null;
    let finalMessage = '';
    // Server-authoritative elapsed: synced on every poll, ticked locally between polls.
    let serverElapsedBase = 0;
    let localBaseTime = Date.now();

    const onSigint = () => { watching = false; };
    process.once('SIGINT', onSigint);

    const schedulePoll = () => {
        fetchProjectStatus(apiKey, projectId, branch)
            .then(status => {
                latestStatus = status;
                if (status.elapsed_sec != null) {
                    serverElapsedBase = status.elapsed_sec;
                    localBaseTime = Date.now();
                }
                const s = status.init_scan_status;
                if (s === 'completed' || s === 'completed_with_warnings') {
                    finalMessage = `[Status] ✓ Pipeline complete — ${status.file_count} files indexed.`;
                    watching = false;
                } else if (s === 'failed') {
                    finalMessage = '[Status] ✗ Pipeline failed.';
                    watching = false;
                }
            })
            .catch(() => { /* keep going on transient network errors */ })
            .finally(() => {
                if (watching) pollTimeoutId = setTimeout(schedulePoll, POLL_INTERVAL_MS);
            });
    };

    // Redraw 2-line block in-place. line2 is truncated to terminal width so it
    // never wraps — wrapping breaks the \x1b[2A cursor-up and causes scrolling.
    let firstDraw = true;
    const draw = () => {
        const snap = latestStatus as ProjectStatusResponse | null;
        const elapsedSec = serverElapsedBase + Math.round((Date.now() - localBaseTime) / 1000);
        const [line1, line2] = buildAnimatedLines(snap, spinnerIdx, elapsedSec);
        const cols = process.stdout.columns || 120;
        const line2Safe = line2.length > cols ? line2.slice(0, cols) : line2;
        if (!firstDraw) process.stdout.write('\x1b[2A');
        process.stdout.write(`\r\x1b[K${line1}\n\r\x1b[K${line2Safe}\n`);
        firstDraw = false;
    };

    // Non-TTY fallback: simple periodic log lines (no cursor tricks)
    if (!process.stdout.isTTY) {
        schedulePoll();
        while (watching) {
            const snap = latestStatus as ProjectStatusResponse | null;
            const phase = (snap ? currentPhaseLabel(snap.pipeline_phase) : '') || 'in_progress';
            const elapsed = serverElapsedBase + Math.round((Date.now() - localBaseTime) / 1000);
            console.log(
                `[Status] ${formatElapsed(elapsed)}` +
                `  init_scan_status=${snap?.init_scan_status ?? '?'}` +
                `  pipeline_phase=${phase}`,
            );
            await new Promise<void>(r => setTimeout(r, POLL_INTERVAL_MS));
        }
        if (pollTimeoutId) clearTimeout(pollTimeoutId);
        process.off('SIGINT', onSigint);
        return;
    }

    schedulePoll();
    try {
        while (watching) {
            draw();
            spinnerIdx++;
            await new Promise<void>(r => setTimeout(r, TICK_MS));
        }
        draw(); // final frame: ✓/✗ icon + full bar
    } finally {
        if (pollTimeoutId) clearTimeout(pollTimeoutId);
        process.off('SIGINT', onSigint);
        // Print data fields once, below the animated block
        process.stdout.write('\n');
        for (const line of buildDataLines(latestStatus)) {
            console.log(line);
        }
        process.stdout.write('\n');
        if (finalMessage) {
            console.log(finalMessage + '\n');
        } else {
            // Ctrl+C — pipeline is still running in the background
            console.log('[Status] Stopped watching. Pipeline still running in background.');
            console.log('[Status] Run "lgraph status" to see the current phase.\n');
        }
    }
}

export async function statusCommand(): Promise<void> {
    const projectRoot = process.cwd();

    // Block contributors — no daemon to check; use AI agent directly
    const projectConfig = readProjectConfig(projectRoot);
    if (projectConfig?.role === 'contributor') {
        console.error('❌ This project was joined as a contributor.');
        console.error('   Run "lgraph add <ai-tool>" to configure MCP in your AI agent,');
        console.error('   then use the MCP tools from there.');
        process.exit(1);
    }

    console.log('\n╔════════════════════════════════════════════╗');
    console.log('║            Latentgraph Status              ║');
    console.log('╚════════════════════════════════════════════╝\n');

    // Check API key
    const apiKey = getApiKey();
    if (!apiKey) {
        console.log('API Key:     ❌ Not configured');
        console.log('\nRun "lgraph start" to configure your API key.\n');
        return;
    }
    console.log('API Key:     ✓ Configured');

    // Check project config
    if (!projectConfig?.project_id) {
        console.log('Project:     ❌ Not configured');
        console.log('\nRun "lgraph start" to configure this project.\n');
        return;
    }
    console.log(`Project:     ${projectConfig.project_name ?? '(unnamed)'}`);
    console.log(`Project ID:  ${projectConfig.project_id}`);

    // Agents
    if (projectConfig.agents && projectConfig.agents.length > 0) {
        console.log(`Agents:      ${projectConfig.agents.length} configured`);
        projectConfig.agents.forEach((agent) => {
            console.log(`             - ${agent.agent_name} (${agent.agent_type})`);
        });
    }

    // Backend indexing status
    try {
        const indexedBranch = projectConfig.user_branch ?? projectConfig.default_branch ?? 'main';
        const projectStatus = await fetchProjectStatus(apiKey, projectConfig.project_id, indexedBranch);

        console.log('');
        console.log('── Indexing ─────────────────────────────────');

        if (projectStatus.init_scan_status === 'in_progress') {
            // Animate: the pipeline is still running — enter live watch mode
            console.log('[Status] Pipeline is running. Watching progress (Ctrl+C to stop)...\n');
            await watchLiveStatus(apiKey, projectConfig.project_id, indexedBranch);
        } else {
            // Static: show all backend fields with their exact key names
            for (const line of buildDataLines(projectStatus)) {
                console.log(line);
            }
        }
    } catch {
        console.log('\nStatus:      ⚠️  Unable to check (server unavailable)');
    }

    // Daemon status (local check, always static)
    const daemonStatus = getDaemonStatus(projectRoot);

    console.log('');
    console.log('── Daemon ───────────────────────────────────');

    if (!daemonStatus.running) {
        console.log('Daemon:      ❌ Not running');
        console.log('\nRun "lgraph start" to start the daemon.\n');
        return;
    }

    console.log(`Daemon:      ✓ Running (PID: ${daemonStatus.pid})`);
    console.log(`WebSocket:   ${daemonStatus.connected ? '✓ Connected' : '⚠️  Disconnected'}`);

    if (daemonStatus.startedAt) {
        const startedAt = new Date(daemonStatus.startedAt);
        console.log(`Started:     ${startedAt.toLocaleString()}`);
    }

    console.log('');
}
