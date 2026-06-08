import { readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { readProjectConfig, isReadOnlyProject } from '../../utils/config.js';
import { sendUpdateWiki } from '../../utils/api-client.js';
import { resolveApiKey } from '../../utils/auth-resolver.js';
import { getProjectTree, categorizeFiles, extractAllFilePaths } from '../../utils/tree-scanner.js';
import { detectGitChanges } from '../../utils/git-changes.js';
import { enforceLanguageSupport } from '../../utils/language-support.js';

const execAsync = promisify(exec);

export interface UpdateWikiOptions {
    // reserved for future flags (e.g. --force-full)
}

/**
 * lgraph update-wiki
 *
 * Sends all project source files to the backend, which runs Wiki
 * documentation generation with snapshot-based incremental delta detection:
 *
 *   noop        — nothing changed, returns immediately
 *   incremental — only changed modules regenerated (< 50 % of files changed)
 *   full        — all modules regenerated (first run or >= 50 % changed)
 *
 * Unlike update-drg, ALL source files are always sent (delta detection is
 * server-side via SHA-256 snapshot comparison, not client-side git diff).
 */
export async function updateWikiCommand(_options: UpdateWikiOptions = {}): Promise<void> {
    const projectRoot = process.cwd();

    // Block contributors and public viewers
    const { readOnly, reason } = isReadOnlyProject(projectRoot);
    if (readOnly) {
        const label = reason === 'contributor' ? 'contributor' : 'public (read-only) viewer';
        console.error(`❌ This project was joined as a ${label}.`);
        console.error('   Only the project owner can run "lgraph update-wiki".');
        console.error('   Remove .lgraph/config.json if you want to link this directory to your own project.');
        process.exit(1);
    }

    console.log('\n[UpdateWiki] Preparing to refresh module documentation...');

    // Step 1: Resolve API key
    const authResult = await resolveApiKey({
        interactive: !!process.stdin.isTTY,
        commandLabel: 'UpdateWiki',
    });
    const apiKey = authResult.apiKey;

    // Step 2: Read project config
    const projectConfig = readProjectConfig(projectRoot);
    if (!projectConfig?.project_id) {
        console.error('\n❌ No project configured. Run "lgraph init" first.\n');
        process.exit(1);
    }
    const projectId = projectConfig.project_id;
    console.log(`[UpdateWiki] Project: ${projectId}`);

    // Step 3: Scan all source files
    console.log('[UpdateWiki] Scanning source files...');
    const treeData = await getProjectTree(projectRoot, { depth: 0 });
    const categorized = categorizeFiles(treeData.tree);

    // Language-support gate: block (exit 1) when >50% of recognized code files
    // are in unsupported languages; warn and continue when some but <=50% are.
    enforceLanguageSupport(extractAllFilePaths(treeData.tree), 'UpdateWiki');

    const MAX_FILE_SIZE_CHARS = 300_000;
    const filesToSend: { file_path: string; content: string }[] = [];
    const sourceFiles = categorized.source_files;

    for (const filePath of sourceFiles) {
        try {
            const absolutePath = path.join(projectRoot, filePath);
            if (!existsSync(absolutePath) || statSync(absolutePath).isDirectory()) continue;
            const raw = readFileSync(absolutePath, 'utf-8');
            filesToSend.push({
                file_path: filePath,
                content: raw.length > MAX_FILE_SIZE_CHARS
                    ? raw.slice(0, MAX_FILE_SIZE_CHARS) + '\n/* ... truncated */'
                    : raw,
            });
        } catch { /* skip unreadable files */ }
    }

    if (filesToSend.length === 0) {
        console.log('\n⚠️  No source files found. Nothing to update.\n');
        return;
    }

    console.log(`[UpdateWiki] ${filesToSend.length} source file(s) ready to send`);
    console.log('[UpdateWiki] Sending to backend (delta detection is server-side)...');
    console.log('[UpdateWiki] This may take a few minutes for a full or incremental run.\n');

    // Step 4: Send to backend
    // Use user's branch (contributor) or default branch (owner)
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

    // Compute git delta hint so the server scopes billing to changed files
    // (mirrors update-drg / update-implicit). Without this hint the server
    // falls back to charging the full project LOC. Inside `lgraph update`
    // the umbrella owns billing and this hint is informational; standalone
    // `lgraph update-wiki` runs depend on it for correct charges.
    let changes: { added: string[]; modified: string[]; deleted: string[] } | undefined;
    const sinceCommit =
        projectConfig.implicit_last_indexed_commit
        ?? projectConfig.drg_last_indexed_commit;
    if (sinceCommit) {
        try {
            changes = await detectGitChanges(projectRoot, sinceCommit);
        } catch { /* git unavailable — server falls back to full LOC */ }
    }

    try {
        const result = await sendUpdateWiki(apiKey, {
            project_id: projectId,
            files: filesToSend,
            branch,
            current_commit: currentCommit,
            changes,
            umbrella_id: process.env.LGRAPH_UMBRELLA_ID || undefined,
        });

        if (result.success) {
            const s = result.stats;
            console.log('╔═══════════════════════════════════════════════════╗');
            console.log('║         ✓ Wiki Update Complete                ║');
            console.log('╚═══════════════════════════════════════════════════╝');
            console.log(`\n${result.message}`);
            console.log('');
            console.log(`  Mode             : ${result.mode.toUpperCase()}`);
            console.log(`  Files provided   : ${s.files_provided}`);
            console.log(`  Leaf nodes       : ${s.leaf_nodes}`);
            console.log(`  Modules          : ${s.module_count}`);
            console.log(`  Docs regenerated : ${s.docs_updated}`);
            console.log(`  Docs patched     : ${s.docs_patched}`);
            console.log(`  Docs persisted   : ${s.docs_persisted}`);
            console.log(`  DRG nodes fresh  : ${s.drg_nodes_refreshed}`);
            if (s.regen_modules.length > 0) {
                console.log(`  Regen modules    : ${s.regen_modules.join(', ')}`);
            }
            if (s.surgical_modules.length > 0) {
                console.log(`  Surgical modules : ${s.surgical_modules.join(', ')}`);
            }
            if (s.parent_modules.length > 0) {
                console.log(`  Parent refresh   : ${s.parent_modules.join(', ')}`);
            }
            if (s.elapsed_seconds != null) console.log(`  Elapsed          : ${s.elapsed_seconds}s`);
            if (s.cost_usd        != null) console.log(`  LLM cost         : $${s.cost_usd.toFixed(4)}`);
            console.log('');
            // Write step stats so update-all can include them in the summary table
            try {
                const statsDir = path.join(process.cwd(), '.lgraph', '.step-stats');
                mkdirSync(statsDir, { recursive: true });
                writeFileSync(path.join(statsDir, 'update-wiki.json'), JSON.stringify({
                    step: 'update-wiki', mode: result.mode,
                    elapsed_s: s.elapsed_seconds ?? null,
                    cost_usd:  s.cost_usd      ?? null,
                }));
            } catch { /* non-fatal */ }
        } else {
            console.error(`\n❌ Wiki update failed: ${result.message}\n`);
            process.exit(1);
        }
    } catch (error) {
        console.error(`\n❌ Failed to update Wiki: ${(error as Error).message}\n`);
        process.exit(1);
    }
}
