import { getApiKey, readProjectConfig, writeProjectConfig } from '../../utils/config.js';
import { fetchBranches, sendJoinBranch, BranchInfo } from '../../utils/api-client.js';

export interface CheckoutOptions {
    branch?: boolean;   // -b flag to create new branch
    from?: string;      // --from to specify source branch (with -b)
}

export async function checkoutCommand(
    branchName: string | undefined,
    options: CheckoutOptions = {}
): Promise<void> {
    const projectRoot = process.cwd();

    // Step 1: Validate branch name provided
    if (!branchName) {
        if (options.branch) {
            console.error('Branch name required. Usage: lgraph checkout -b <branch_name>');
        } else {
            console.error('Branch name required. Usage: lgraph checkout <branch_name>');
        }
        process.exit(1);
    }

    // Step 2: Check project config exists
    const config = readProjectConfig(projectRoot);
    if (!config) {
        console.error('No project found. Run "lgraph init" first.');
        process.exit(1);
    }

    // Step 3: Check API key
    const apiKey = getApiKey();
    if (!apiKey) {
        console.error('No API key configured. Run "lgraph config set api-key <key>" first.');
        process.exit(1);
    }

    // Step 4: Fetch existing branches
    let branches: BranchInfo[];
    try {
        branches = await fetchBranches(apiKey, config.project_id);
    } catch (error) {
        console.error(`Failed to fetch branches: ${(error as Error).message}`);
        process.exit(1);
    }

    const branchExists = branches.some(b => b.branch_name === branchName);
    const currentBranch = config.user_branch || config.default_branch;

    if (options.branch) {
        // CREATE NEW BRANCH
        await createBranch(branchName, branchExists, currentBranch, config, apiKey, options, projectRoot);
    } else {
        // SWITCH TO EXISTING BRANCH
        await switchBranch(branchName, branchExists, currentBranch, config, branches, projectRoot);
    }
}

async function createBranch(
    branchName: string,
    branchExists: boolean,
    currentBranch: string | undefined,
    config: ReturnType<typeof readProjectConfig>,
    apiKey: string,
    options: CheckoutOptions,
    projectRoot: string
): Promise<void> {
    if (branchExists) {
        console.error(`Branch '${branchName}' already exists.`);
        console.error(`Use "lgraph checkout ${branchName}" to switch to it.`);
        process.exit(1);
    }

    // Determine source branch
    const sourceBranch = options.from || currentBranch || config!.default_branch || 'main';

    console.log(`\nCreating branch '${branchName}' from '${sourceBranch}'...`);

    // Call API to create branch (copies DRG data)
    try {
        const result = await sendJoinBranch(apiKey, {
            project_id: config!.project_id,
            source_branch: sourceBranch,
            user_branch_name: branchName,
        });

        if (!result.success) {
            console.error(`Failed to create branch: ${result.message}`);
            process.exit(1);
        }

        const filesCopied = result.files_copied ?? 'unknown';
        console.log(`Copied ${filesCopied} files from '${sourceBranch}'`);
    } catch (error) {
        console.error(`Failed to create branch: ${(error as Error).message}`);
        process.exit(1);
    }

    // Update local config
    config!.user_branch = branchName;
    config!.source_branch = sourceBranch;
    writeProjectConfig(config!, projectRoot);

    console.log(`\nSwitched to new branch '${branchName}'`);
    console.log('\nNext steps:');
    console.log('  Run "lgraph update" to sync your local changes to this branch.\n');
}

async function switchBranch(
    branchName: string,
    branchExists: boolean,
    currentBranch: string | undefined,
    config: ReturnType<typeof readProjectConfig>,
    branches: BranchInfo[],
    projectRoot: string
): Promise<void> {
    if (!branchExists) {
        console.error(`Branch '${branchName}' not found.`);
        console.error('\nAvailable branches:');
        for (const b of branches) {
            const defaultTag = b.is_default ? ' (default)' : '';
            console.error(`  - ${b.branch_name}${defaultTag}`);
        }
        console.error(`\nUse "lgraph checkout -b ${branchName}" to create it.`);
        process.exit(1);
    }

    if (branchName === currentBranch) {
        console.log(`Already on branch '${branchName}'`);
        return;
    }

    // Update local config
    config!.user_branch = branchName;
    writeProjectConfig(config!, projectRoot);

    console.log(`Switched to branch '${branchName}'`);
}
