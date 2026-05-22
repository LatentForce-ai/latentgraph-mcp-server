import { getApiKey, readProjectConfig } from '../../utils/config.js';
import { fetchBranches, BranchInfo } from '../../utils/api-client.js';

export interface BranchOptions {
    all?: boolean;  // -a flag for verbose output with metadata
}

export async function branchCommand(options: BranchOptions = {}): Promise<void> {
    const projectRoot = process.cwd();

    // Step 1: Check project config exists
    const config = readProjectConfig(projectRoot);
    if (!config) {
        console.error('No project found. Run "lgraph init" first.');
        process.exit(1);
    }

    // Step 2: Check API key
    const apiKey = getApiKey();
    if (!apiKey) {
        console.error('No API key configured. Run "lgraph config set api-key <key>" first.');
        process.exit(1);
    }

    // Step 3: Fetch branches from API
    let branches: BranchInfo[];
    try {
        branches = await fetchBranches(apiKey, config.project_id);
    } catch (error) {
        console.error(`Failed to fetch branches: ${(error as Error).message}`);
        process.exit(1);
    }

    if (branches.length === 0) {
        console.log(`No branches found for project "${config.project_name}".`);
        console.log('Run "lgraph init" to create the default branch.');
        return;
    }

    // Step 4: Display branches
    const currentBranch = config.user_branch || config.default_branch;

    console.log(`\nBranches for project "${config.project_name}":\n`);

    if (options.all) {
        // Verbose output with metadata
        for (const branch of branches) {
            const isCurrent = branch.branch_name === currentBranch;
            const marker = isCurrent ? '*' : ' ';
            const defaultTag = branch.is_default ? ' (default)' : '';
            const localTag = (!branch.pushed && branch.is_mine) ? ' (local)' : '';
            const sourceInfo = branch.source_branch ? ` <- ${branch.source_branch}` : '';
            const createdAt = new Date(branch.created_at).toLocaleDateString();
            const pushedStatus = branch.pushed ? 'Pushed' : 'Not pushed';

            console.log(`  ${marker} ${branch.branch_name}${defaultTag}${localTag}${sourceInfo}`);
            console.log(`      Created: ${createdAt} | ${pushedStatus}`);
        }
    } else {
        // Simple output
        for (const branch of branches) {
            const isCurrent = branch.branch_name === currentBranch;
            const marker = isCurrent ? '*' : ' ';
            const defaultTag = branch.is_default ? ' (default)' : '';
            const localTag = (!branch.pushed && branch.is_mine) ? ' (local)' : '';

            console.log(`  ${marker} ${branch.branch_name}${defaultTag}${localTag}`);
        }
    }

    console.log('');
}
