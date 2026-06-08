import { spawn } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';
import { getApiKey, readProjectConfig, isReadOnlyProject, isPublicProject } from '../../utils/config.js';
import { execFile as _execFile } from 'child_process';
import { promisify } from 'util';
import { fetchProjectStatus, sendAdvanceBaseline, sendUpdateBegin, sendUpdateFinalize } from '../../utils/api-client.js';
import { detectGitChanges } from '../../utils/git-changes.js';

const execFileAsync = promisify(_execFile);

export interface UpdateAllOptions {
    drgMode?: string;
    skipDrg?: boolean;
    skipImplicit?: boolean;
    skipWiki?: boolean;
    skipFileIndex?: boolean;
}

/**
 * Spawn a single `lgraph <command>` step as a child process with inherited
 * stdio so all output streams directly to the terminal / Docker log collector
 * in real-time without any buffering.
 */
// How often to print a heartbeat line while waiting for backend-heavy steps.
// Keeps Docker logs alive during the silent HTTP wait in update-wiki / update-file-index.
const HEARTBEAT_INTERVAL_MS = 30_000; // 30 s

interface StepStats {
    step: string;
    mode: string | null;
    elapsed_s: number | null;
    cost_usd: number | null;
}

/** Read the JSON stats file written by each sub-command after it completes. */
function readStepStats(command: string): StepStats {
    try {
        const statsFile = path.join(process.cwd(), '.lgraph', '.step-stats', `${command}.json`);
        if (existsSync(statsFile)) {
            const data = JSON.parse(readFileSync(statsFile, 'utf8'));
            return {
                step:      data.step      ?? command,
                mode:      data.mode      ?? null,
                elapsed_s: data.elapsed_s ?? null,
                cost_usd:  data.cost_usd  ?? null,
            };
        }
    } catch { /* ignore parse errors */ }
    return { step: command, mode: null, elapsed_s: null, cost_usd: null };
}

async function runLgraphStep(
    command: string,
    args: string[] = [],
): Promise<{ success: boolean; code: number; wall_s: number }> {
    // ── section header ────────────────────────────────────────────────────────
    process.stdout.write('\n' + '═'.repeat(62) + '\n');
    process.stdout.write(`  STEP: lgraph ${command}${args.length ? ' ' + args.join(' ') : ''}\n`);
    process.stdout.write('═'.repeat(62) + '\n\n');

    const stepStart = Date.now();

    return new Promise((resolve) => {
        // Re-use the same Node.js binary and entry-point that started lgraph.
        // This avoids PATH lookups and works identically inside Docker.
        const entryPoint = process.argv[1];
        const child = spawn(process.execPath, [entryPoint, command, ...args], {
            stdio: 'inherit',     // all output flows directly to parent stdout/stderr
            cwd: process.cwd(),
            env: process.env,
        });

        // Heartbeat: write a progress line every 30 s so Docker logs remain active
        // during the long silent HTTP wait inside update-wiki / update-file-index.
        // The child has stdio:inherit so both parent and child share the same stdout fd —
        // this only fires during the child's silent wait period, not during its own prints.
        const heartbeat = setInterval(() => {
            const elapsed = Math.round((Date.now() - stepStart) / 1000);
            process.stdout.write(
                `[UpdateAll] ⏳ ${command} still running... (${elapsed}s elapsed — backend processing)\n`,
            );
        }, HEARTBEAT_INTERVAL_MS);

        child.on('close', (code) => {
            clearInterval(heartbeat);
            const wall_s = (Date.now() - stepStart) / 1000;
            resolve({ success: code === 0, code: code ?? 1, wall_s });
        });

        child.on('error', (err) => {
            clearInterval(heartbeat);
            process.stderr.write(
                `\n[UpdateAll] ❌ Failed to spawn "${command}": ${err.message}\n`,
            );
            resolve({ success: false, code: 1, wall_s: (Date.now() - stepStart) / 1000 });
        });
    });
}

/**
 * lgraph update
 *
 * Runs the full incremental update pipeline:
 *   1. update-drg        — Refresh dependency relationship graph
 *   2. update-implicit   — Refresh implicit dependency graph
 *   3. update-file-index — Refresh per-file enrichment + produce summary_diffs
 *   4. update-wiki       — Refresh module docs (consumes summary_diffs from step 3)
 *
 * All output is streamed in real-time (stdio: inherit), making this
 * command Docker-log-friendly out of the box.
 *
 * The pipeline stops immediately if any step fails.
 */
interface StepResult {
    step: string;
    success: boolean;
    skipped: boolean;
    elapsed_s: number | null;
    cost_usd: number | null;
    mode: string | null;
}

export async function updateAllCommand(options: UpdateAllOptions = {}): Promise<void> {
    const {
        drgMode = 'incremental',
        skipDrg = false,
        skipImplicit = false,
        skipWiki = false,
        skipFileIndex = false,
    } = options;

    // Permission check:
    // - Public viewers: always blocked
    // - Contributors: blocked from wiki steps (lgraph update and lgraph update-all both run wiki)
    // - Owners: always allowed
    if (isPublicProject(process.cwd())) {
        console.error('❌ This project was joined as a public (read-only) viewer.');
        console.error('   Public viewers cannot run update commands.');
        console.error('   Remove .lgraph/config.json if you want to link this directory to your own project.');
        process.exit(1);
    }

    // Wiki step requires owner — block contributors unless --skip-wiki is passed
    if (!skipWiki) {
        const { readOnly, reason } = isReadOnlyProject(process.cwd());
        if (readOnly && reason === 'contributor') {
            console.error('❌ This project was joined as a contributor.');
            console.error('   Only the project owner can run wiki regeneration.');
            console.error('   Run "lgraph update --skip-wiki" to update DRG + implicit + file-index only.');
            process.exit(1);
        }
    }

    const startTime = Date.now();
    const results: StepResult[] = [];

    // ── Upfront gate: pipeline_run_meta.last_commit must exist for this branch ──
    // Single invariant for the whole pipeline. If missing, no phase runs (not
    // even update-drg). Establishes baseline = `lgraph init`'s responsibility.
    const apiKey = getApiKey();
    const projectConfig = readProjectConfig(process.cwd());
    const projectId = projectConfig?.project_id;
    const branch = projectConfig?.user_branch ?? projectConfig?.default_branch;
    if (!apiKey || !projectId || !branch) {
        console.error(
            '❌ Missing API key, project_id, or branch in .lgraph/config.json — run `lgraph init` first.',
        );
        process.exit(1);
    }
    const projectStatus = await fetchProjectStatus(apiKey, projectId, branch);
    if (!projectStatus.pipeline_baseline_commit) {
        console.error(
            `❌ Branch baseline missing for branch=${branch}. ` +
            `Run \`lgraph init\` first to establish a baseline.`,
        );
        process.exit(1);
    }

    // ── Umbrella reservation: one transaction covers all sub-steps ───────────
    // Compute changed-files LOC the same way the per-step billing does:
    // git diff against the last DRG/implicit commit, then sum newlines for
    // every added/modified file. Reserve once via /update-begin; the returned
    // umbrella_id is threaded through each child via env so they skip their
    // own per-step billing. Finalize once on success (consume) or failure (refund).
    let umbrellaLoc = 0;
    let deletedCount = 0;
    // On the very first update after `lgraph init`, neither DRG nor implicit
    // has written its own `*_last_indexed_commit` yet — fall back to the
    // branch baseline that init recorded so the umbrella reservation reflects
    // the real changes since init (instead of charging 0 for an unbounded diff).
    const umbrellaSince =
        projectConfig?.drg_last_indexed_commit
        ?? projectConfig?.implicit_last_indexed_commit
        ?? projectStatus.pipeline_baseline_commit;
    if (umbrellaSince) {
        try {
            const changes = await detectGitChanges(process.cwd(), umbrellaSince);
            deletedCount = changes.deleted.length;
            const changedPaths = [...changes.added, ...changes.modified];
            for (const filePath of changedPaths) {
                try {
                    const absolutePath = path.join(process.cwd(), filePath);
                    if (!existsSync(absolutePath)) continue;
                    if (statSync(absolutePath).isDirectory()) continue;
                    const content = readFileSync(absolutePath, 'utf-8');
                    umbrellaLoc += content.split('\n').length;
                } catch { /* unreadable file — skip */ }
            }
        } catch {
            // Git unavailable or detached state — reserve at min-credit floor.
        }
    }

    // Deletions have no LOC to read but still cause backend work (DRG node
    // removal, file-index tombstoning, wiki regen for affected modules).
    // Floor the umbrella at 1 LOC so deletion-only diffs aren't billed as free.
    if (umbrellaLoc === 0 && deletedCount > 0) {
        umbrellaLoc = 1;
    }

    let umbrellaId: string | null = null;
    let umbrellaFinalized = false;
    // One key per `lgraph update` invocation. If the POST below succeeds but
    // the response is lost (TCP reset, timeout reading headers), a retry with
    // the same key returns the existing reservation instead of stranding the
    // original.
    const idempotencyKey = randomUUID();
    try {
        const beginResp = await sendUpdateBegin(apiKey, {
            project_id: projectId,
            branch,
            loc: umbrellaLoc,
            idempotency_key: idempotencyKey,
        });
        umbrellaId = beginResp.umbrella_id;
        process.env.LGRAPH_UMBRELLA_ID = umbrellaId;
        const deletionsNote = deletedCount > 0 ? ` + ${deletedCount} deletion(s)` : '';
        console.log(
            `\n[UpdateAll] 💳 Reserved ${beginResp.credits_reserved} credit(s) for this run ` +
            `(${umbrellaLoc.toLocaleString()} LOC${deletionsNote} since last update).`,
        );
    } catch (err) {
        console.error(`\n❌ Failed to reserve credits: ${(err as Error).message}\n`);
        process.exit(1);
    }

    const finalizeUmbrella = async (status: 'success' | 'failed'): Promise<void> => {
        if (!umbrellaId || umbrellaFinalized) return;
        umbrellaFinalized = true;
        try {
            await sendUpdateFinalize(apiKey, {
                project_id: projectId,
                umbrella_id: umbrellaId,
                status,
                loc: umbrellaLoc,
            });
        } catch (err) {
            // Non-fatal: the stale-umbrella sweeper will refund on TTL expiry.
            console.warn(
                `[UpdateAll] ⚠️  finalize(${status}) failed: ${(err as Error).message}`,
            );
        }
    };

    const onSignal = (signal: NodeJS.Signals) => {
        process.stderr.write(`\n[UpdateAll] ${signal} received — refunding umbrella reservation...\n`);
        void finalizeUmbrella('failed').finally(() => process.exit(130));
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    // Show different header based on whether wiki is included
    if (skipWiki) {
        process.stdout.write('\n╔══════════════════════════════════════════════════════════════╗\n');
        process.stdout.write('║       lgraph update — DRG + Implicit + File-Index            ║\n');
        process.stdout.write('║    update-drg → update-implicit → update-file-index         ║\n');
        // (--skip-wiki path: file-index after implicit; wiki is omitted)
        process.stdout.write('╚══════════════════════════════════════════════════════════════╝\n');
    } else {
        process.stdout.write('\n╔══════════════════════════════════════════════════════════════╗\n');
        process.stdout.write('║       lgraph update-all — Full Incremental Pipeline          ║\n');
        process.stdout.write('║ update-drg → update-implicit → update-file-index → wiki     ║\n');
        process.stdout.write('╚══════════════════════════════════════════════════════════════╝\n');
    }

    // ── Step 1: update-drg ──────────────────────────────────────────────────
    if (skipDrg) {
        console.log('\n[UpdateAll] ⤳ Skipping update-drg (--skip-drg)');
        results.push({ step: 'update-drg', success: true, skipped: true, elapsed_s: null, cost_usd: null, mode: null });
    } else {
        const drgArgs = drgMode === 'baseline' ? ['--baseline'] : [];
        const r = await runLgraphStep('update-drg', drgArgs);
        const stats = readStepStats('update-drg');
        results.push({ step: 'update-drg', success: r.success, skipped: false,
            elapsed_s: stats.elapsed_s ?? r.wall_s, cost_usd: stats.cost_usd, mode: stats.mode });
        if (!r.success) {
            console.error('\n[UpdateAll] ❌ update-drg failed — aborting pipeline.\n');
            await finalizeUmbrella('failed');
            process.exit(1);
        }
    }

    // ── Step 2: update-implicit ─────────────────────────────────────────────
    // update-implicit polls to completion internally and writes its own stats.
    if (skipImplicit) {
        console.log('\n[UpdateAll] ⤳ Skipping update-implicit (--skip-implicit)');
        results.push({ step: 'update-implicit', success: true, skipped: true, elapsed_s: null, cost_usd: null, mode: null });
    } else {
        const r = await runLgraphStep('update-implicit');
        const stats = readStepStats('update-implicit');
        results.push({ step: 'update-implicit', success: r.success, skipped: false,
            elapsed_s: stats.elapsed_s ?? r.wall_s, cost_usd: stats.cost_usd, mode: stats.mode });
        if (!r.success) {
            console.error('\n[UpdateAll] ❌ update-implicit failed — aborting pipeline.\n');
            await finalizeUmbrella('failed');
            process.exit(1);
        }
    }

    // ── Step 3: update-file-index ────────────────────────────────────────────
    // Runs BEFORE update-wiki so the codewiki delta has fresh file
    // summary_diffs to feed into <CHANGED_FILES>. Wiki without file-index
    // first would noop on any modified file (no diff signal to consume).
    let fileIndexMode: string | null = null;
    if (skipFileIndex) {
        console.log('\n[UpdateAll] ⤳ Skipping update-file-index (--skip-file-index)');
        results.push({ step: 'update-file-index', success: true, skipped: true, elapsed_s: null, cost_usd: null, mode: null });
    } else {
        const r = await runLgraphStep('update-file-index');
        const stats = readStepStats('update-file-index');
        fileIndexMode = stats.mode;
        results.push({ step: 'update-file-index', success: r.success, skipped: false,
            elapsed_s: stats.elapsed_s ?? r.wall_s, cost_usd: stats.cost_usd, mode: stats.mode });
        if (!r.success) {
            console.error('\n[UpdateAll] ❌ update-file-index failed — aborting pipeline.\n');
            await finalizeUmbrella('failed');
            process.exit(1);
        }
    }

    // ── Step 4: update-wiki ─────────────────────────────────────────────
    // Only run wiki if file-index actually produced new summaries to
    // consume. If file-index noop'd (no source changes), the module docs
    // would noop too — skip the round-trip. Mirrors pipeline_runner's
    // init-time guard: Phase 4 (codewiki) is gated on Phase 3.6
    // (file enrichment) having work to do.
    const fileIndexDidNothing = fileIndexMode === 'noop';
    if (skipWiki) {
        console.log('\n[UpdateAll] ⤳ Skipping update-wiki (--skip-wiki)');
        results.push({ step: 'update-wiki', success: true, skipped: true, elapsed_s: null, cost_usd: null, mode: null });
    } else if (fileIndexDidNothing) {
        console.log('\n[UpdateAll] ⤳ Skipping update-wiki (file-index noop\'d — no new file summaries to consume)');
        results.push({ step: 'update-wiki', success: true, skipped: true, elapsed_s: null, cost_usd: null, mode: 'skipped_no_file_changes' });
    } else {
        const r = await runLgraphStep('update-wiki');
        const stats = readStepStats('update-wiki');
        results.push({ step: 'update-wiki', success: r.success, skipped: false,
            elapsed_s: stats.elapsed_s ?? r.wall_s, cost_usd: stats.cost_usd, mode: stats.mode });
        if (!r.success) {
            console.error('\n[UpdateAll] ❌ update-wiki failed — aborting pipeline.\n');
            await finalizeUmbrella('failed');
            process.exit(1);
        }
    }

    // Every sub-step succeeded — confirm the umbrella reservation.
    await finalizeUmbrella('success');

    // ── Advance the shared baseline (sole writer of pipeline_run_meta.last_commit) ──
    // Every phase ran successfully. Advance once so no individual phase has to
    // own commit-storage, and later phases don't see a moved baseline and NOOP.
    // A failed advance is treated as a non-fatal warning: the summary still prints
    // and the user is told to re-run. The alternative (process.exit here) would
    // make a working pipeline look broken after a transient network hiccup.
    try {
        const { stdout: headStdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd() });
        const headCommit = headStdout.trim();
        const adv = await sendAdvanceBaseline(apiKey, {
            project_id: projectId,
            branch,
            commit: headCommit,
        });
        console.log(
            `[UpdateAll] ✓ Baseline advanced — pipeline_run_meta.last_commit=${adv.last_commit.slice(0,8)} ` +
            `(branch=${adv.branch})`,
        );
    } catch (err) {
        console.warn(`\n[UpdateAll] ⚠️  Baseline advance failed: ${(err as Error).message}`);
        console.warn('[UpdateAll]    Pipeline steps succeeded. Re-run "lgraph update" to retry baseline advance.\n');
    }

    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const totalCost = results.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0);
    const hasCost = results.some(r => r.cost_usd != null);

    if (skipWiki) {
        process.stdout.write('\n╔══════════════════════════════════════════════════════════════╗\n');
        process.stdout.write('║                ✓ Update Complete                             ║\n');
        process.stdout.write('╚══════════════════════════════════════════════════════════════╝\n\n');
    } else {
        process.stdout.write('\n╔══════════════════════════════════════════════════════════════╗\n');
        process.stdout.write('║                ✓ Full Pipeline Complete                      ║\n');
        process.stdout.write('╚══════════════════════════════════════════════════════════════╝\n\n');
    }

    // Header
    process.stdout.write(`  ${'Step'.padEnd(22)}  ${'Status'.padEnd(8)}  ${'Time'.padStart(8)}  ${'Cost'.padStart(10)}\n`);
    process.stdout.write(`  ${'─'.repeat(22)}  ${'─'.repeat(8)}  ${'─'.repeat(8)}  ${'─'.repeat(10)}\n`);

    for (const r of results) {
        const icon  = r.skipped ? '⤳' : r.success ? '✓' : '✗';
        const label = r.skipped ? 'skipped' : r.success ? 'ok' : 'FAILED';
        const time  = r.elapsed_s != null ? `${r.elapsed_s.toFixed(1)}s` : '—';
        const cost  = r.cost_usd  != null
            ? (r.cost_usd >= 0.00005 ? `$${r.cost_usd.toFixed(4)}` : r.cost_usd > 0 ? `<$0.0001` : `$0.0000`)
            : '—';
        process.stdout.write(
            `  ${icon}  ${r.step.padEnd(22)}  ${label.padEnd(8)}  ${time.padStart(8)}  ${cost.padStart(10)}\n`,
        );
    }

    process.stdout.write(`\n  Total elapsed : ${totalElapsed}s\n`);
    if (hasCost) {
        process.stdout.write(`  Total LLM cost: $${totalCost.toFixed(4)}\n`);
    }
    process.stdout.write('\n');
}
