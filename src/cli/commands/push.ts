import { getApiKey, readProjectConfig } from '../../utils/config.js';
import { pushBranch } from '../../utils/api-client.js';

export interface PushOptions {
    // Currently no options, but keeping for future extensibility
}

export async function pushCommand(
    branchName: string | undefined,
    options: PushOptions = {}
): Promise<void> {
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

    // Determine branch to push
    const targetBranch = branchName || config.user_branch;
    if (!targetBranch) {
        console.error('No branch specified and no current branch set.');
        console.error('Usage: lgraph push <branch_name>');
        process.exit(1);
    }

    console.log(`\nPushing branch '${targetBranch}'...`);

    // Step 3: Call push API
    try {
        const result = await pushBranch(apiKey, {
            project_id: config.project_id,
            branch_name: targetBranch,
        });

        if (result.success) {
            console.log(`\n${result.message}`);
            console.log(`\nBranch '${result.branch_name}' is now visible to your team.`);
        } else {
            console.error(`\nFailed to push branch: ${result.message}`);
            process.exit(1);
        }
    } catch (error) {
        console.error(`\nFailed to push branch: ${(error as Error).message}`);
        process.exit(1);
    }
}
