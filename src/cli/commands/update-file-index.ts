import { writeFileSync, mkdirSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { readProjectConfig, writeProjectConfig, isReadOnlyProject } from '../../utils/config.js';
import { sendUpdateFileIndex } from '../../utils/api-client.js';
import { resolveApiKey } from '../../utils/auth-resolver.js';

const execAsync = promisify(exec);

/**
 * lgraph update-file-index
 *
 * Triggers the server-side file-enrichment delta. The orch container fetches
 * git diff from the A1 proxy and re-enriches only files whose LLM inputs
 * changed since the recorded baseline.
 *
 * Delta modes (resolved server-side):
 *   noop        — current commit equals baseline, returns immediately
 *   delta       — added/modified re-enriched, dependents patched surgically
 *   full        — first run or churn exceeds threshold
 */
export async function updateFileIndexCommand(): Promise<void> {
    const projectRoot = process.cwd();

    // Block public/read-only viewers only — contributors CAN run update-file-index on their branch
    const { readOnly, reason } = isReadOnlyProject(projectRoot);
    if (readOnly && reason === 'public') {
        console.error(`❌ This project was joined as a public (read-only) viewer.`);
        console.error('   You cannot run "lgraph update-file-index" on a read-only project.');
        process.exit(1);
    }

    console.log('\n[UpdateFileIndex] Preparing to refresh file index...');

    // Step 1: Resolve API key
    const authResult = await resolveApiKey({
        interactive: !!process.stdin.isTTY,
        commandLabel: 'UpdateFileIndex',
    });
    const apiKey = authResult.apiKey;

    // Step 2: Read project config
    const projectConfig = readProjectConfig(projectRoot);
    if (!projectConfig?.project_id) {
        console.error('\n❌ No project configured. Run "lgraph init" first.\n');
        process.exit(1);
    }
    const projectId = projectConfig.project_id;
    console.log(`[UpdateFileIndex] Project: ${projectId}`);

    // Step 3: Send to backend — the orch resolves diff + reads files itself
    const branch = projectConfig.user_branch || projectConfig.default_branch;
    if (!branch) {
        console.error('\n❌ No branch configured in .lgraph/config.json — run "lgraph init" first.\n');
        process.exit(1);
    }

    // Include current HEAD so the server can skip the A1 proxy git call.
    let currentCommit: string | undefined;
    try {
        const { stdout } = await execAsync('git rev-parse HEAD', { cwd: projectRoot });
        currentCommit = stdout.trim() || undefined;
    } catch { /* not a git repo — server falls back to A1 proxy */ }

    console.log('[UpdateFileIndex] Sending to backend (server-side git diff + delta)...');
    try {
        const result = await sendUpdateFileIndex(apiKey, {
            project_id: projectId,
            branch,
            current_commit: currentCommit,
            umbrella_id: process.env.LGRAPH_UMBRELLA_ID || undefined,
        });

        if (!result.success) {
            console.error(`\n❌ File index update failed: ${result.message}\n`);
            process.exit(1);
        }

        const s = result.stats;
        const modeLabel = result.mode.toUpperCase();
        console.log('╔═══════════════════════════════════════════════════╗');
        console.log('║        ✓ File Index Update Complete               ║');
        console.log('╚═══════════════════════════════════════════════════╝');
        console.log(`\n${result.message}`);
        console.log('');
        console.log(`  Mode             : ${modeLabel}`);
        console.log(`  Files re-enriched: ${s.files_enriched}`);
        console.log(`  Files total      : ${s.files_total}`);
        console.log(`  Git deletions    : ${s.files_deleted}`);
        if (s.registry_drops_skipped > 0) {
            console.log(`  Registry drops skipped: ${s.registry_drops_skipped}`);
        }
        console.log(`  Tags synced      : ${s.tag_count}`);
        console.log(`  Elapsed          : ${s.elapsed_seconds}s`);
        const deltaParts = Object.entries(s.delta_breakdown || {})
            .filter(([, count]) => count > 0)
            .map(([reason, count]) => `${reason}=${count}`);
        if (deltaParts.length > 0) {
            console.log(`  Delta breakdown  : ${deltaParts.join(', ')}`);
        }
        if (s.enriched_files.length > 0) {
            console.log('  Enriched files   :');
            for (const filePath of s.enriched_files) {
                const reason = s.enriched_file_reasons[filePath] || 'unknown';
                console.log(`    - ${filePath} (${reason})`);
            }
        }
        if (s.cost_usd != null) console.log(`  LLM cost         : $${s.cost_usd.toFixed(4)}`);
        console.log('');
        // Persist the indexed commit so lgraph analyze can detect stale backend index.
        if (currentCommit && result.mode !== 'error') {
            try {
                const cfg = readProjectConfig(projectRoot);
                if (cfg) {
                    cfg.file_index_last_commit = currentCommit;
                    writeProjectConfig(cfg, projectRoot);
                }
            } catch { /* non-fatal */ }
        }
        // Write step stats so update-all can include them in the summary table
        try {
            const statsDir = path.join(process.cwd(), '.lgraph', '.step-stats');
            mkdirSync(statsDir, { recursive: true });
            writeFileSync(path.join(statsDir, 'update-file-index.json'), JSON.stringify({
                step: 'update-file-index', mode: result.mode,
                elapsed_s: s.elapsed_seconds ?? null,
                cost_usd:  s.cost_usd       ?? null,
            }));
        } catch { /* non-fatal */ }
    } catch (error) {
        console.error(`\n❌ Failed to update file index: ${(error as Error).message}\n`);
        process.exit(1);
    }
}
