import { execSync, spawn } from 'child_process';
import { getApiKey, getProjectId, getProjectName, readProjectConfig, writeProjectConfig } from '../../utils/config.js';
import { sendMergeBranch } from '../../utils/api-client.js';

export interface MergeOptions {
    sourceBranch: string;
    targetBranch: string;
}

/**
 * Run a git command and return the output, or null if it fails.
 */
function runGit(cmd: string): string | null {
    try {
        return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch {
        return null;
    }
}

/**
 * Check if a git branch exists locally.
 */
function branchExists(branch: string): boolean {
    const result = runGit(`git rev-parse --verify ${branch} 2>/dev/null`);
    return result !== null;
}

/**
 * Get merge-base (common ancestor) between two branches.
 */
function getMergeBase(branch1: string, branch2: string): string | null {
    return runGit(`git merge-base ${branch1} ${branch2}`);
}

/**
 * Count files changed between a commit and a branch.
 */
function countChanges(fromCommit: string, toBranch: string): number {
    const result = runGit(`git diff --name-only ${fromCommit}...${toBranch}`);
    if (!result) return 0;
    return result.split('\n').filter(line => line.trim()).length;
}

/**
 * Run lgraph update as a child process with inherited stdio.
 */
async function runLgraphUpdate(): Promise<void> {
    return new Promise((resolve, reject) => {
        const entryPoint = process.argv[1];
        const child = spawn(process.execPath, [entryPoint, 'update'], {
            stdio: 'inherit',
            cwd: process.cwd(),
            env: process.env,
        });

        child.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`lgraph update failed with exit code ${code}`));
            }
        });

        child.on('error', (err) => {
            reject(new Error(`Failed to run lgraph update: ${err.message}`));
        });
    });
}

export async function mergeCommand(options: MergeOptions): Promise<void> {
    const { sourceBranch, targetBranch } = options;

    console.log('╔════════════════════════════════════════════╗');
    console.log('║           Merging Branch Data              ║');
    console.log('╚════════════════════════════════════════════╝\n');

    // Step 1: Check API key
    const apiKey = getApiKey();
    if (!apiKey) {
        console.error('❌ No API key configured. Run "lgraph config set api-key <key>" first.');
        process.exit(1);
    }

    // Step 2: Check project is configured
    const projectId = getProjectId();
    const projectName = getProjectName();
    if (!projectId) {
        console.error('❌ No project configured. Run "lgraph init" first.');
        process.exit(1);
    }
    console.log(`[Merge] Project: ${projectName || projectId}`);

    // Step 3: Validate branches are different
    if (sourceBranch === targetBranch) {
        console.error(`\n❌ Cannot merge branch '${sourceBranch}' into itself.`);
        process.exit(1);
    }

    // Step 4: Check both branches exist locally
    console.log(`[Merge] Checking branches...`);
    if (!branchExists(sourceBranch)) {
        console.error(`\n❌ Source branch '${sourceBranch}' does not exist locally.`);
        console.error(`   Run 'git fetch' or check the branch name.`);
        process.exit(1);
    }
    if (!branchExists(targetBranch)) {
        console.error(`\n❌ Target branch '${targetBranch}' does not exist locally.`);
        console.error(`   Run 'git fetch' or check the branch name.`);
        process.exit(1);
    }
    console.log(`[Merge] ✓ Both branches exist locally`);

    // Step 5: Get merge-base and count changes
    console.log(`[Merge] Analyzing branch divergence...`);
    const mergeBase = getMergeBase(sourceBranch, targetBranch);

    let sourceChanges = 0;
    let targetChanges = 0;
    let finalSource: string;
    let finalTarget: string;
    let needsUpdate = false;

    if (!mergeBase) {
        // No common ancestor - distant branches warning
        console.log(`\n⚠️  Warning: No common ancestor found between '${sourceBranch}' and '${targetBranch}'.`);
        console.log(`   These branches may be unrelated or very distant.`);
        console.log(`   Will copy source → target without change analysis.\n`);
        finalSource = sourceBranch;
        finalTarget = targetBranch;
    } else {
        sourceChanges = countChanges(mergeBase, sourceBranch);
        targetChanges = countChanges(mergeBase, targetBranch);

        console.log(`[Merge] Merge base: ${mergeBase.slice(0, 8)}`);
        console.log(`[Merge] Changes in '${sourceBranch}': ${sourceChanges} files`);
        console.log(`[Merge] Changes in '${targetBranch}': ${targetChanges} files`);

        // Apply case logic
        if (sourceChanges > 0 && targetChanges === 0) {
            // Case 1: Only source has changes → copy source → target
            console.log(`\n[Merge] Case: Only '${sourceBranch}' has changes since divergence.`);
            console.log(`[Merge] Action: Copy '${sourceBranch}' DRG → '${targetBranch}'`);
            finalSource = sourceBranch;
            finalTarget = targetBranch;
        } else if (sourceChanges === 0 && targetChanges > 0) {
            // Case 2: Only target has changes → copy target → source
            console.log(`\n[Merge] Case: Only '${targetBranch}' has changes since divergence.`);
            console.log(`[Merge] Action: Copy '${targetBranch}' DRG → '${sourceBranch}'`);
            finalSource = targetBranch;
            finalTarget = sourceBranch;
        } else if (sourceChanges > 0 && targetChanges > 0) {
            // Case 3: Both have changes → copy from larger, remind to update smaller
            if (sourceChanges >= targetChanges) {
                console.log(`\n[Merge] Case: Both branches have changes. '${sourceBranch}' has more.`);
                console.log(`[Merge] Action: Copy '${sourceBranch}' DRG → '${targetBranch}'`);
                finalSource = sourceBranch;
                finalTarget = targetBranch;
            } else {
                console.log(`\n[Merge] Case: Both branches have changes. '${targetBranch}' has more.`);
                console.log(`[Merge] Action: Copy '${targetBranch}' DRG → '${sourceBranch}'`);
                finalSource = targetBranch;
                finalTarget = sourceBranch;
            }
            needsUpdate = true;
        } else {
            // No changes in either - just copy as requested
            console.log(`\n[Merge] Case: No changes detected in either branch.`);
            console.log(`[Merge] Action: Copy '${sourceBranch}' DRG → '${targetBranch}'`);
            finalSource = sourceBranch;
            finalTarget = targetBranch;
        }
    }

    // Step 6: Call backend API
    console.log(`\n[Merge] Copying DRG data from '${finalSource}' to '${finalTarget}'...`);

    let result;
    try {
        result = await sendMergeBranch(apiKey, {
            project_id: projectId,
            source_branch: finalSource,
            target_branch: finalTarget,
        });
    } catch (error) {
        console.error(`\n❌ Merge failed: ${(error as Error).message}`);
        process.exit(1);
    }

    if (!result.success) {
        console.error(`\n❌ Merge failed: ${result.message}`);
        process.exit(1);
    }

    // Step 7: Display results
    console.log(`[Merge] ✓ Copied ${result.total_copied} documents`);

    console.log('\n╔════════════════════════════════════════════╗');
    console.log('║           Merge Completed                  ║');
    console.log('╚════════════════════════════════════════════╝');
    console.log(`\nSource: ${finalSource}`);
    console.log(`Target: ${finalTarget}`);
    console.log(`Documents: ${result.total_copied}`);

    // Show per-database stats if any
    const nonZeroStats = Object.entries(result.stats).filter(([, count]) => count > 0);
    if (nonZeroStats.length > 0) {
        console.log('\nPer-database:');
        for (const [db, count] of nonZeroStats) {
            console.log(`  ${db}: ${count}`);
        }
    }

    // Step 8: Auto-run lgraph update if both branches had changes
    if (needsUpdate && mergeBase) {
        console.log('\n[Merge] Both branches had changes. Running update on target branch...');

        // Switch to target branch and SET drg_last_indexed_commit to merge-base.
        // This makes update-drg diff from merge-base → HEAD, capturing all changes
        // in this branch since it diverged. Much faster than baseline (only changed files).
        const config = readProjectConfig(process.cwd());
        if (config) {
            config.user_branch = finalTarget;
            config.drg_last_indexed_commit = mergeBase;  // Incremental from merge-base
            writeProjectConfig(config, process.cwd());
            console.log(`[Merge] Switched to branch '${finalTarget}'`);
            console.log(`[Merge] Set drg_last_indexed_commit to merge-base: ${mergeBase.slice(0, 8)}`);
        }

        // Run lgraph update to incorporate the target branch's changes
        console.log(`[Merge] Running 'lgraph update' (incremental from merge-base)...\n`);
        try {
            await runLgraphUpdate();
        } catch (error) {
            console.error(`\n❌ ${(error as Error).message}`);
            process.exit(1);
        }
    }
}
