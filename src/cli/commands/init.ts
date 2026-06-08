import { exec } from 'child_process';
import { promisify } from 'util';
import { createInterface } from 'readline';
import { createRequire } from 'module';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { readProjectConfig, writeProjectConfig, ensureScanTargetFile, isReadOnlyProject, getGithubToken, setGithubToken } from '../../utils/config.js';
import { fetchProjectStatus, fetchListFiles, sendInitScan, InitScanPayload, ScanTarget, ProjectStatusResponse } from '../../utils/api-client.js';
import { resolveApiKey, resolveProject } from '../../utils/auth-resolver.js';
import { getDaemonStatus, startDaemon } from '../../daemon/daemon-manager.js';
import { getProjectTree, extractAllFilePaths, categorizeFiles, countProjectLOC } from '../../utils/tree-scanner.js';
import { enforceLanguageSupport } from '../../utils/language-support.js';
import { PIPELINE_PHASES, currentPhaseLabel, formatElapsed } from '../../utils/phase-display.js';

const require = createRequire(import.meta.url);
const { version } = require('../../../package.json');

const execAsync = promisify(exec);

/**
 * Prompt user to confirm the default branch for indexing.
 */
async function promptConfirmDefaultBranch(branchName: string): Promise<boolean> {
    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise((resolve) => {
        console.log('');
        console.log(`As you are indexing this branch '${branchName}' it will be counted as the default branch.`);
        rl.question('Proceed? (y/n, default yes): ', (answer) => {
            rl.close();
            const normalized = answer.toLowerCase().trim();
            resolve(normalized === '' || normalized === 'y' || normalized === 'yes');
        });
    });
}

const POLL_INTERVAL_MS = 10_000;
const TICK_MS = 120; // spinner animation frame rate
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SHORT_LABELS = PIPELINE_PHASES.map(p => p.label.split(' ')[0]);

/**
 * Watch pipeline progress with an animated 2-line in-place display.
 *
 * Line 1: spinner + current phase name + block progress bar + elapsed time
 * Line 2: compact per-phase status indicators
 *
 * Both lines are redrawn in-place every TICK_MS milliseconds using ANSI cursor
 * movement, so the terminal never scrolls. Ctrl+C stops the watch loop without
 * killing the pipeline — the phase is persisted in MongoDB so "lgraph status"
 * shows the current position on next run.
 *
 * Terminal detection mirrors the UI's IndexingProgressPanel: completed /
 * completed_with_warnings / failed / pipeline_phase === 'failed'. Also exits
 * when the local daemon disappears, since the pipeline is then orphaned from
 * the CLI's perspective.
 */
async function watchPipelineProgress(
    apiKey: string,
    projectId: string,
    branch: string,
    projectRoot: string,
): Promise<{ completed: boolean }> {
    const startTime = Date.now();
    let watching = true;
    let latestStatus: ProjectStatusResponse | null = null;
    let spinnerIdx = 0;

    let finalMessage = '';
    let completed = false;
    let pollTimeoutId: ReturnType<typeof setTimeout> | null = null;

    const onSigint = () => { watching = false; };
    process.once('SIGINT', onSigint);

    // Daemon-death check: if the daemon was killed externally, the pipeline is
    // effectively orphaned from this CLI's perspective — exit so the user can
    // restart cleanly.
    const checkDaemonAlive = (): boolean => {
        if (getDaemonStatus(projectRoot).running) return true;
        finalMessage = '[Init] ✗ Daemon stopped. Pipeline state preserved — run "lgraph status".';
        watching = false;
        return false;
    };

    // Fire-and-forget poll that reschedules itself every POLL_INTERVAL_MS
    const schedulePoll = () => {
        fetchProjectStatus(apiKey, projectId, branch)
            .then(status => {
                latestStatus = status;
                const s = status.init_scan_status;
                const p = status.pipeline_phase;
                const isCompleted = s === 'completed' || s === 'completed_with_warnings';
                const isFailed = s === 'failed' || p === 'failed';

                if (isCompleted) {
                    finalMessage = `[Init] ✓ Pipeline complete — ${status.file_count} files indexed.`;
                    completed = true;
                    watching = false;
                } else if (isFailed) {
                    finalMessage = '[Init] ✗ Pipeline failed. Run "lgraph status" for details.';
                    watching = false;
                }
            })
            .catch(() => { /* keep going on transient errors */ })
            .finally(() => {
                if (watching) pollTimeoutId = setTimeout(schedulePoll, POLL_INTERVAL_MS);
            });
    };

    // Build the two display lines from current state
    const buildLines = (): [string, string] => {
        const elapsedSec = Math.round((Date.now() - startTime) / 1000);
        const elapsedStr = formatElapsed(elapsedSec);
        const isCompleted =
            latestStatus?.init_scan_status === 'completed' ||
            latestStatus?.init_scan_status === 'completed_with_warnings';
        const isFailed = latestStatus?.init_scan_status === 'failed';

        const icon = isCompleted ? '✓' : isFailed ? '✗' : SPINNER[spinnerIdx % SPINNER.length];

        const phaseIdx = latestStatus?.pipeline_phase
            ? PIPELINE_PHASES.findIndex(p => p.key === latestStatus!.pipeline_phase)
            : -1;
        const phaseLabel =
            (latestStatus ? currentPhaseLabel(latestStatus.pipeline_phase) : '') ||
            'Dispatched...';

        const done = isCompleted ? PIPELINE_PHASES.length : Math.max(0, phaseIdx);
        const filled = isCompleted ? 10 : Math.round((done / PIPELINE_PHASES.length) * 10);
        const bar10 = '█'.repeat(filled) + '░'.repeat(10 - filled);

        const compactBar = SHORT_LABELS.map((label, i) => {
            if (isCompleted || i < phaseIdx) return `✓ ${label}`;
            if (i === phaseIdx)             return `⏳ ${label}`;
            return `○ ${label}`;
        }).join(' ');

        const line1 = `[Init] ${icon} ${phaseLabel.padEnd(28)} [${bar10}]  ${elapsedStr}`;
        const line2 = `       ${compactBar}`;
        return [line1, line2];
    };

    // Redraw 2-line block in-place. line2 is truncated to terminal width so it
    // never wraps — wrapping breaks the \x1b[2A cursor-up and causes scrolling.
    let firstDraw = true;
    const draw = () => {
        const [line1, line2] = buildLines();
        const cols = process.stdout.columns || 120;
        const line2Safe = line2.length > cols ? line2.slice(0, cols) : line2;
        if (!firstDraw) process.stdout.write('\x1b[2A');
        process.stdout.write(`\r\x1b[K${line1}\n\r\x1b[K${line2Safe}\n`);
        firstDraw = false;
    };

    console.log('\n[Init] Watching pipeline progress (Ctrl+C to stop)...\n');

    // Non-TTY fallback: simple periodic log lines (no cursor tricks)
    if (!process.stdout.isTTY) {
        schedulePoll();
        while (watching) {
            if (!checkDaemonAlive()) break;
            // Cast needed: CFA narrows latestStatus → null inside the loop (async .then()
            // assignment is invisible to TypeScript's control-flow analysis).
            const snap = latestStatus as ProjectStatusResponse | null;
            const phase = (snap ? currentPhaseLabel(snap.pipeline_phase) : '') || 'in progress';
            console.log(`[Init] ${formatElapsed(Math.round((Date.now() - startTime) / 1000))}  ${phase}`);
            await new Promise<void>(r => setTimeout(r, POLL_INTERVAL_MS));
        }
        if (pollTimeoutId) clearTimeout(pollTimeoutId);
        process.off('SIGINT', onSigint);
        if (finalMessage) console.log('\n' + finalMessage + '\n');
        return { completed };
    }

    schedulePoll();
    // Daemon-status check is cheap (file read + signal probe) but no need to do
    // it every animation tick — once per second is plenty for responsiveness.
    const DAEMON_CHECK_EVERY = Math.max(1, Math.floor(1000 / TICK_MS));
    try {
        while (watching) {
            if (spinnerIdx % DAEMON_CHECK_EVERY === 0 && !checkDaemonAlive()) break;
            draw();
            spinnerIdx++;
            await new Promise<void>(r => setTimeout(r, TICK_MS));
        }
        draw(); // final frame: show ✓/✗ icon + full bar
    } finally {
        if (pollTimeoutId) clearTimeout(pollTimeoutId);
        process.off('SIGINT', onSigint);
        process.stdout.write('\n');
        if (finalMessage) {
            console.log(finalMessage + '\n');
        } else {
            // Ctrl+C — pipeline is still running in background
            console.log('[Init] Stopped watching. The pipeline is still running.');
            console.log('[Init] Run "lgraph status" to see the current phase.\n');
        }
    }
    return { completed };
}

/**
 * Prompt user to confirm re-indexing an already indexed project
 */
async function promptForReindex(): Promise<boolean> {
    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise((resolve) => {
        rl.question('Do you want to re-index the project? (y/n, default no): ', (answer) => {
            rl.close();
            const normalized = answer.trim().toLowerCase();
            resolve(normalized === 'y' || normalized === 'yes');
        });
    });
}

export interface InitOptions {
    force?: boolean;
    apiKey?: string;
    ghToken?: string;
    projectName?: string;
    projectId?: string;
}

export async function initCommand(options: InitOptions = {}): Promise<void> {
    const projectRoot = process.cwd();
    const isAuthInteractive = !options.apiKey;
    const isProjectInteractive = !!(process.stdin.isTTY);

    // Block contributors and public viewers — they can only use MCP tools, not index projects
    const { readOnly, reason } = isReadOnlyProject(projectRoot);
    if (readOnly) {
        const label = reason === 'contributor' ? 'contributor' : 'public (read-only) viewer';
        console.error(`❌ This project was joined as a ${label}.`);
        console.error('   Only the project owner can run "lgraph init".');
        console.error('   Remove .lgraph/config.json if you want to link this directory to your own project.');
        process.exit(1);
    }

    console.log('╔═══════════════════════════════════════════════╗');
    console.log('║       Initializing Latentgraph Project        ║');
    console.log('╚═══════════════════════════════════════════════╝\n');

    // Step 1: Resolve API key
    console.log('[Init] Step 1/5: Checking API key...');
    const authResult = await resolveApiKey({
        apiKey: options.apiKey,
        interactive: isAuthInteractive,
        commandLabel: 'Init',
    });
    const apiKey = authResult.apiKey;

    // Save GitHub token if provided via flag
    if (options.ghToken) {
        setGithubToken(options.ghToken);
        console.log('[Init] ✓ GitHub token saved\n');
    } else if (getGithubToken()) {
        console.log('[Init] ✓ GitHub token found\n');
    } else {
        console.log('[Init] ⚠  No GitHub token configured (PR insights disabled)\n');
    }

    // Step 2: Resolve project
    console.log('[Init] Step 2/5: Checking project configuration...');

    const project = await resolveProject({
        apiKey,
        projectId: options.projectId,
        projectName: options.projectName,
        interactive: isProjectInteractive,
        commandLabel: 'Init',
        projectRoot,
    });

    // Re-read project config (may have been written by resolveProject)
    const projectConfig = readProjectConfig(projectRoot);
    if (!projectConfig) {
        console.error('\n❌ Failed to configure project.');
        process.exit(1);
    }

    // Ensure .lgraph/scan_target.json exists (template for user customization)
    ensureScanTargetFile(projectRoot);

    // Check if project is already indexed (skip check if --force flag is used)
    if (!options.force) {
        try {
            const { stdout: branchStdout } = await execAsync('git branch --show-current', { cwd: projectRoot });
            const indexedBranch = branchStdout.trim() || 'main';
            const projectStatus = await fetchProjectStatus(apiKey, project.projectId, indexedBranch);
            if (projectStatus.indexed) {
                console.log(`[Init] ✓ Project already indexed (${projectStatus.file_count} files)\n`);

                if (isProjectInteractive) {
                    const shouldReindex = await promptForReindex();
                    if (!shouldReindex) {
                        console.log('\n╔═══════════════════════════════════════════════╗');
                        console.log('║         Project Already Initialized           ║');
                        console.log('╚═══════════════════════════════════════════════╝');
                        console.log('\nUse "lgraph status" to check the current status.');
                        console.log('Use "lgraph init --force" to force re-indexing.\n');
                        return;
                    }
                    console.log('\n[Init] Proceeding with re-indexing...\n');
                } else {
                    console.log('[Init] Already indexed. Use --force to re-index.\n');
                    return;
                }
            }
        } catch {
            // If we can't check status, continue with init (server might be unavailable)
            console.log('[Init] ⚠️  Could not check indexing status, proceeding with initialization...\n');
        }
    } else {
        console.log('[Init] Force flag detected, skipping indexing status check...\n');
    }

    // Step 3: Check daemon status — start it automatically if not running
    console.log('[Init] Step 3/5: Checking daemon status...');
    const daemonStatus = getDaemonStatus(projectRoot);
    if (!daemonStatus.running) {
        console.log('[Init] Daemon not running. Starting it...');
        try {
            const daemonResult = await startDaemon(projectRoot, project.projectId, apiKey);
            if (daemonResult.success) {
                console.log(`[Init] ✓ Daemon started (PID: ${daemonResult.pid})\n`);
            } else {
                console.log(`[Init] ⚠️  Could not start daemon: ${daemonResult.error}`);
                console.log('[Init] Continuing without daemon — run "lgraph start" later.\n');
            }
        } catch (err) {
            console.log(`[Init] ⚠️  Could not start daemon: ${(err as Error).message}`);
            console.log('[Init] Continuing without daemon — run "lgraph start" later.\n');
        }
    } else {
        console.log(`[Init] ✓ Daemon running (PID: ${daemonStatus.pid}, Connected: ${daemonStatus.connected})\n`);
    }

    // Step 4: Scan project structure (matching extension's Step 6)
    console.log('[Init] Step 4/5: Scanning project structure...');

    // Get project tree (matching extension's getProjectTree)
    const treeData = await getProjectTree(projectRoot, { depth: 0 });

    console.log(`[Init]   Files: ${treeData.file_count}`);
    console.log(`[Init]   Directories: ${treeData.dir_count}`);
    console.log(`[Init]   Total size: ${treeData.total_size_mb} MB\n`);

    // Get git info (matching extension)
    let gitInfo = {
        current_branch: '',
        original_branch: 'lgraph_original',
        migrate_branch: 'lgraph_migrated',
        has_uncommitted_changes: false,
    };

    try {
        const { stdout: currentBranch } = await execAsync('git branch --show-current', { cwd: projectRoot });
        const { stdout: statusOutput } = await execAsync('git status --porcelain', { cwd: projectRoot });

        gitInfo.current_branch = currentBranch.trim();
        gitInfo.has_uncommitted_changes = statusOutput.trim().length > 0;

        console.log(`[Init] ✓ Git info: branch=${gitInfo.current_branch}, uncommitted=${gitInfo.has_uncommitted_changes}`);

        // Prompt user to confirm this branch as the default branch
        if (process.stdin.isTTY && gitInfo.current_branch) {
            const confirmed = await promptConfirmDefaultBranch(gitInfo.current_branch);
            if (!confirmed) {
                console.log('\n[Init] Aborted by user. Switch to the desired branch and run again.\n');
                process.exit(0);
            }
            console.log(`[Init] ✓ Default branch confirmed: ${gitInfo.current_branch}\n`);
        } else if (gitInfo.current_branch) {
            console.log(`[Init] Default branch: ${gitInfo.current_branch}\n`);
        }
    } catch {
        console.log('[Init] ⚠️  Not a git repository or git not available\n');
    }

    // Extract file paths and categorize (matching extension)
    const allFiles = extractAllFilePaths(treeData.tree);
    const categorized = categorizeFiles(treeData.tree);

    // Count total lines of code
    const totalLOC = countProjectLOC(projectRoot, categorized.source_files);
    console.log(`[Init] Total LOC: ${totalLOC}`);

    // Prefer the backend's indexed count when available; fall back to local on first init.
    let displaySourceCount = categorized.source_files.length;
    let sourceCountSuffix = ' (local count — first indexing run)';
    try {
        const branch = gitInfo.current_branch || projectConfig.default_branch || projectConfig.user_branch || 'main';
        const listed = await fetchListFiles(apiKey, project.projectId, branch);
        if (typeof listed.total_files === 'number' && listed.total_files > 0) {
            displaySourceCount = listed.total_files;
            sourceCountSuffix = ' (from backend index — matches LatentView)';
        }
    } catch {
        // first init / backend unreachable — keep local count
    }

    console.log(`[Init]   Source files: ${displaySourceCount}${sourceCountSuffix}`);
    console.log(`[Init]   Config files: ${categorized.config_files.length}`);
    console.log(`[Init]   Asset files: ${categorized.asset_files.length}\n`);

    // Step 4b: Check for unsupported languages.
    // Blocks (exit 1) when >50% of recognized code files are in unsupported
    // languages; warns and continues when some but <=50% are.
    console.log('[Init] Checking language support...');
    const langCheck = enforceLanguageSupport(allFiles, 'Init');
    if (!langCheck.hasUnsupported) {
        console.log('[Init] ✓ All source files are in supported languages\n');
    }

    // Step 5: Send scan to backend (matching extension's Step 9)
    console.log('[Init] Step 5/5: Sending scan to backend...');

    // Read scan targets from .lgraph/scan_target.json if it exists
    let scanTargets: ScanTarget[] | null = null;
    const scanTargetPath = path.join(projectRoot, '.lgraph', 'scan_target.json');
    if (existsSync(scanTargetPath)) {
        try {
            const raw = readFileSync(scanTargetPath, 'utf-8');
            const parsed = JSON.parse(raw);
            // Accept both array format and single object format
            const targets = Array.isArray(parsed) ? parsed : [parsed];
            const mapped: ScanTarget[] = targets.map((t: any) => ({
                language: t.language ?? t.lang ?? null,
                path: t.path ?? '',
            }));

            // Treat default template (single entry with language=null, path="") as unconfigured
            const isDefault = mapped.length === 1 && mapped[0].language === null && mapped[0].path === '';
            if (isDefault) {
                console.log('[Init] .lgraph/scan_target.json is default template — server will auto-detect scan targets');
                console.log('[Init]   Edit the file to manually specify scan targets');
            } else {
                scanTargets = mapped;
                console.log(`[Init] ✓ Loaded ${scanTargets.length} scan target(s) from .lgraph/scan_target.json`);
                for (const t of scanTargets) {
                    console.log(`[Init]   → language=${t.language ?? 'auto'}, path="${t.path || '(root)'}"`);
                }
            }
        } catch (err) {
            console.log(`[Init] ⚠️  Failed to read .lgraph/scan_target.json: ${(err as Error).message}`);
            console.log('[Init]   Proceeding without scan targets (server will auto-detect)');
        }
    } else {
        console.log('[Init] No .lgraph/scan_target.json found — server will auto-detect scan targets');
    }

    // Read source file contents so orchestrator can run pipeline inline (e.g. LOCAL mode) and index via init-scan
    const MAX_FILES_TO_SEND = 800;
    const MAX_FILE_SIZE_CHARS = 150000;
    const filesToRead = categorized.source_files.slice(0, MAX_FILES_TO_SEND);
    const filesWithContent: { file_path: string; content: string }[] = [];
    let filesSkipped = 0;
    for (const filePath of filesToRead) {
        try {
            const absolutePath = path.join(projectRoot, filePath);
            const content = readFileSync(absolutePath, 'utf-8');
            const truncated = content.length > MAX_FILE_SIZE_CHARS
                ? content.slice(0, MAX_FILE_SIZE_CHARS) + '\n/* ... truncated */'
                : content;
            filesWithContent.push({ file_path: filePath, content: truncated });
        } catch {
            filesSkipped++;
        }
    }
    if (filesWithContent.length > 0) {
        console.log(`[Init] Read ${filesWithContent.length} source file(s) for inline indexing${filesSkipped > 0 ? ` (${filesSkipped} skipped)` : ''}`);
    }

    // Determine default branch - use git branch if available, otherwise "main"
    const defaultBranch = gitInfo.current_branch || 'main';

    const payload: InitScanPayload = {
        project_id: project.projectId,
        project_tree: treeData,
        git_info: gitInfo,
        file_manifest: {
            all_files: allFiles,
            categorized: categorized,
        },
        metadata: {
            extension_version: `${version}-cli`,
            scan_timestamp: new Date().toISOString(),
            project_name: project.projectName,
        },
        scan_targets: scanTargets,
        total_loc: totalLOC,
        files: filesWithContent.length > 0 ? filesWithContent : undefined,
        github_token: options.ghToken || getGithubToken() || undefined,
        default_branch: defaultBranch,
    };

    try {
        const response = await sendInitScan(apiKey, project.projectId, payload);

        // Store current git HEAD so incremental update-drg knows where to diff from
        // Also store branch info for team collaboration
        try {
            const { stdout: headHash } = await execAsync('git rev-parse HEAD', { cwd: projectRoot });
            const indexedCommit = headHash.trim();
            projectConfig.drg_last_indexed_commit = indexedCommit;
            projectConfig.file_index_last_commit = indexedCommit;
            projectConfig.implicit_last_indexed_commit = indexedCommit;
            // Store branch info - owner gets default_branch = user_branch
            projectConfig.default_branch = defaultBranch;
            projectConfig.user_branch = defaultBranch;
            writeProjectConfig(projectConfig, projectRoot);
        } catch {
            // Not a git repo or no commits yet — still store branch info
            projectConfig.default_branch = defaultBranch;
            projectConfig.user_branch = defaultBranch;
            writeProjectConfig(projectConfig, projectRoot);
        }

        console.log('[Init] ✓ Backend initialization completed');
        const count = response.source_files_count ?? response.files_read;
        if (count != null) {
            console.log(`[Init]   Source files queued: ${count}`);
        } else {
            console.log(`[Init]   (backend did not return file count)`);
        }
        

        // Update local config with agent info (matching extension)
        if (response.agents_created?.theme_planner) {
            const agentInfo = {
                agent_id: response.agents_created.theme_planner.agent_id,
                agent_name: response.agents_created.theme_planner.agent_name,
                agent_type: 'theme_planner',
                created_at: new Date().toISOString(),
            };

            projectConfig.agents = projectConfig.agents || [];
            if (!projectConfig.agents.some(a => a.agent_id === agentInfo.agent_id)) {
                projectConfig.agents.push(agentInfo);
            }
            writeProjectConfig(projectConfig, projectRoot);

            console.log(`[Init] ✓ Agent info saved: ${agentInfo.agent_id}`);
        }

        console.log('\n╔═══════════════════════════════════════════════╗');
        console.log('║       ✓ Project Initialization Complete       ║');
        console.log('╚═══════════════════════════════════════════════╝');

        if (response.next_steps) {
            console.log('\nNext steps:');
            response.next_steps.forEach((step) => console.log(`  - ${step}`));
        }

        // First-ever init: populate the dashboard with the local count immediately
        // so the user sees something while the backend pipeline runs.
        const latestConfig = readProjectConfig(projectRoot);
        if (!latestConfig?.last_analyzed_at) {
            console.log('\n[Init] Running first-time code analysis...');
            try {
                const { analyzeCommand } = await import('./analyze.js');
                await analyzeCommand();
            } catch (err) {
                console.error('\n╔═══════════════════════════════════════════════╗');
                console.error('║   ⚠️  AUTO-ANALYZE FAILED                       ║');
                console.error('╚═══════════════════════════════════════════════╝');
                console.error(`\nError: ${(err as Error).message}`);
                console.error('\nYour project was initialized successfully, but the code');
                console.error('metrics dashboard will be empty until you run:');
                console.error('\n    lgraph analyze\n');
            }
        } else {
            console.log(`\n[Init] Skipping pre-pipeline analyze (already analyzed at ${latestConfig.last_analyzed_at}).`);
        }

        // Watch pipeline progress — polls phase from DB every 10s.
        // Ctrl+C exits the watch loop but the pipeline keeps running.
        // "lgraph status" will always show the last persisted phase.
        const { completed } = await watchPipelineProgress(apiKey, project.projectId, gitInfo.current_branch, projectRoot);

        // Post-pipeline analyze: backend now has the indexed count, so this run
        // syncs the Code Analysis dashboard with LatentView. Skipped on Ctrl+C / pipeline failure.
        if (completed) {
            console.log('[Init] Running analyze to sync dashboards with the new index...');
            try {
                const { analyzeCommand } = await import('./analyze.js');
                await analyzeCommand();
            } catch (err) {
                console.error(`\n[Init] ⚠️  Post-pipeline analyze failed: ${(err as Error).message}`);
                console.error('[Init] Run "lgraph analyze" manually to refresh the dashboard.\n');
            }
        } else {
            console.log('[Init] Pipeline did not finish — skipping post-pipeline analyze.');
            console.log('[Init] Run "lgraph status" then "lgraph analyze" once the pipeline completes.\n');
        }

    } catch (error) {
        console.error(`\n❌ Failed to initialize project: ${(error as Error).message}`);
        process.exit(1);
    }
}
