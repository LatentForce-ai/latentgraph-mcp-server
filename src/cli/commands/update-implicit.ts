import { exec } from 'child_process';
import { promisify } from 'util';
import { readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { readProjectConfig, writeProjectConfig, isReadOnlyProject } from '../../utils/config.js';
import { sendUpdateImplicit } from '../../utils/api-client.js';
import { pollProjectStatus } from '../../utils/poll-project-status.js';
import { resolveApiKey } from '../../utils/auth-resolver.js';
import { getProjectTree, categorizeFiles } from '../../utils/tree-scanner.js';
import { detectGitChanges } from '../../utils/git-changes.js';

const execAsync = promisify(exec);

interface ProjectStatusFields {
    status: string;
    mode: 'noop' | 'delta' | 'full' | null;
    cost: number | null;
}

export async function updateImplicitCommand(): Promise<void> {
    const projectRoot = process.cwd();

    // Block public/read-only viewers only — contributors CAN run update-implicit on their branch
    const { readOnly, reason } = isReadOnlyProject(projectRoot);
    if (readOnly && reason === 'public') {
        console.error(`❌ This project was joined as a public (read-only) viewer.`);
        console.error('   You cannot run "lgraph update-implicit" on a read-only project.');
        process.exit(1);
    }

    console.log('╔═══════════════════════════════════════════════╗');
    console.log('║     Updating Implicit Dependency Analysis     ║');
    console.log('╚═══════════════════════════════════════════════╝\n');

    // Step 1: Check API key
    console.log('[Implicit] Step 1/4: Checking API key...');
    const authResult = await resolveApiKey({
        interactive: !!process.stdin.isTTY,
        commandLabel: 'Implicit',
    });
    const apiKey = authResult.apiKey;
    console.log('[Implicit] ✓ API key found\n');

    // Step 2: Read project config
    console.log('[Implicit] Step 2/4: Reading project configuration...');
    const projectConfig = readProjectConfig(projectRoot);
    if (!projectConfig?.project_id) {
        console.error('\n❌ No project configured for this directory.');
        console.log('Run "lgraph start" first to configure the project.\n');
        process.exit(1);
    }
    console.log(`[Implicit] ✓ Project: ${projectConfig.project_name} (${projectConfig.project_id})\n`);

    // Step 3: Scan all source files (server-side does incremental detection)
    console.log('[Implicit] Step 3/4: Scanning source files...');
    const treeData = await getProjectTree(projectRoot, { depth: 0 });
    const categorized = categorizeFiles(treeData.tree);

    const MAX_FILE_SIZE_CHARS = 300_000;
    const filesToSend: { file_path: string; content: string }[] = [];

    for (const filePath of categorized.source_files) {
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
    console.log(`[Implicit] ✓ ${filesToSend.length} source file(s) ready to send\n`);

    // Step 4: Detect git changes since the last successful implicit run.
    // Mirrors update-drg / update-file-index: committed diff since
    // `implicit_last_indexed_commit` PLUS uncommitted working-tree changes.
    // First run on a project has no tracker yet — uncommitted only, server
    // will fall back to a full scan if the resulting ratio breaches the
    // threshold.
    console.log('[Implicit] Step 4/4: Detecting git changes...');
    const sinceCommit = projectConfig.implicit_last_indexed_commit;
    if (sinceCommit) {
        console.log(`[Implicit] Diffing from last indexed commit: ${sinceCommit.slice(0, 8)}`);
    } else {
        console.log('[Implicit] No baseline commit stored — uncommitted changes only');
    }
    const changes = await detectGitChanges(projectRoot, sinceCommit);
    const totalChanges = changes.added.length + changes.modified.length + changes.deleted.length;
    if (totalChanges === 0) {
        console.log('[Implicit] No changes detected. Server will compare against the last analyzed commit.\n');
    } else {
        console.log(
            `[Implicit] Changes — added: ${changes.added.length}, ` +
            `modified: ${changes.modified.length}, deleted: ${changes.deleted.length}\n`,
        );
    }

    console.log('[Implicit] Triggering implicit dependency update...');

    // Use user's branch (contributor) or default branch (owner)
    const branch = projectConfig.user_branch || projectConfig.default_branch;
    if (!branch) {
        console.error('\n❌ No branch configured in .lgraph/config.json — run "lgraph init" first.');
        process.exit(1);
    }
    try {
        const response = await sendUpdateImplicit(apiKey, {
            project_id: projectConfig.project_id,
            changes,
            files: filesToSend,
            branch,
        });
        console.log(`\n${response.message}`);
    } catch (error) {
        console.error(`\n❌ Failed to trigger implicit update: ${(error as Error).message}`);
        process.exit(1);
    }

    // Poll project status until the implicit phase lands stats in
    // implicit_dep_meta — the dispatch endpoint above is fire-and-forget on
    // the backend, so cost/elapsed only become readable after the job ends.
    const startedAt = Date.now();
    let terminalStatus: ProjectStatusFields;
    try {
        terminalStatus = await pollProjectStatus<ProjectStatusFields>(
            apiKey, projectConfig.project_id, branch,
            {
                extract: s => ({
                    status: s.implicit_dep_status ?? 'unknown',
                    mode:   s.implicit_dep_mode   ?? null,
                    cost:   s.implicit_dep_cost_usd ?? null,
                }),
                isTerminal: v => v.status === 'completed' || v.status === 'failed' || v.status === 'aborted',
                timeoutMs: 20 * 60 * 1000,
                onTick: (elapsedS, v) => console.log(`[Implicit] ⏳ Waiting... (status=${v.status}, ${elapsedS}s elapsed)`),
            },
        );
    } catch (err) {
        console.error(`\n❌ ${(err as Error).message}`);
        process.exit(1);
    }
    if (terminalStatus.status !== 'completed') {
        console.error(`\n❌ update-implicit ${terminalStatus.status} in the backend`);
        process.exit(1);
    }
    const costUsd = terminalStatus.cost;
    const runMode = terminalStatus.mode;
    const elapsedS = (Date.now() - startedAt) / 1000;
    console.log('\n╔═══════════════════════════════════════════════╗');
    console.log('║     ✓ Implicit Update Complete                ║');
    console.log('╚═══════════════════════════════════════════════╝');
    console.log(`  Elapsed  : ${elapsedS.toFixed(1)}s`);
    if (costUsd != null) console.log(`  LLM cost : $${costUsd.toFixed(4)}`);
    console.log('');

    // Advance the local baseline so the next run's git diff starts from here.
    try {
        const { stdout: headHash } = await execAsync('git rev-parse HEAD', { cwd: projectRoot });
        projectConfig.implicit_last_indexed_commit = headHash.trim();
        writeProjectConfig(projectConfig, projectRoot);
    } catch { /* not a git repo — skip */ }

    try {
        const statsDir = path.join(projectRoot, '.lgraph', '.step-stats');
        mkdirSync(statsDir, { recursive: true });
        writeFileSync(path.join(statsDir, 'update-implicit.json'), JSON.stringify({
            step: 'update-implicit', mode: runMode ?? 'delta',
            elapsed_s: elapsedS, cost_usd: costUsd,
        }));
    } catch { /* non-fatal */ }
}
