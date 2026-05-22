import { getApiKey } from '../../utils/config.js';
import { fetchSharedProjects, fetchPublicProjectInfo, sendJoinBranch, SharedProject } from '../../utils/api-client.js';
import { setProject, readProjectConfig, writeProjectConfig } from '../../utils/config.js';
import { createInterface } from 'readline';

export interface JoinOptions {
    projectName?: string;
    publicId?: string;
    sourceBranch?: string;      // branch to copy from (e.g., "main")
    userBranchName?: string;    // name for user's own branch
}

async function promptSelectSharedProject(projects: SharedProject[]): Promise<SharedProject> {
    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise((resolve) => {
        console.log('\nCollaboration projects you have access to:\n');
        projects.forEach((p, i) => {
            const role = p.role ? ` [${p.role}]` : '';
            console.log(`  ${i + 1}. ${p.project_name}${role}`);
        });
        console.log('');

        const ask = () => {
            rl.question(`Select a project (1-${projects.length}): `, (answer) => {
                const index = parseInt(answer.trim(), 10) - 1;
                if (index >= 0 && index < projects.length) {
                    rl.close();
                    resolve(projects[index]);
                } else {
                    console.log(`  Please enter a number between 1 and ${projects.length}.`);
                    ask();
                }
            });
        };
        ask();
    });
}

async function joinPublicProject(publicId: string, projectRoot: string): Promise<void> {
    console.log('╔════════════════════════════════════════════╗');
    console.log('║         Joining Public Project             ║');
    console.log('╚════════════════════════════════════════════╝\n');

    // Check if project is already configured here
    const existing = readProjectConfig(projectRoot);
    if (existing) {
        console.log(`[Join] ⚠️  This directory is already linked to project "${existing.project_name}" (${existing.project_id}).`);
        console.log('[Join]   Remove .lgraph/config.json to re-link.\n');
        process.exit(1);
    }

    // Fetch public project info (no auth needed)
    console.log('[Join] Fetching public project info...');
    let info;
    try {
        info = await fetchPublicProjectInfo(publicId);
    } catch (error) {
        console.error(`\n❌ Failed to resolve public project: ${(error as Error).message}`);
        process.exit(1);
    }

    // Write .lgraph/config.json with role=public and the share token
    setProject(info.project_id, info.project_name, projectRoot);
    const savedConfig = readProjectConfig(projectRoot)!;
    savedConfig.role = 'public';
    savedConfig.public_token = publicId;
    writeProjectConfig(savedConfig, projectRoot);

    console.log(`\n[Join] ✓ Linked to public project "${info.project_name}" (${info.project_id})`);
    console.log('\n╔════════════════════════════════════════════╗');
    console.log('║       Successfully Joined Public Project   ║');
    console.log('╚════════════════════════════════════════════╝');
    console.log('\nNext steps:');
    console.log('  Add Latentgraph MCP to your AI coding tool:');
    console.log('');
    console.log('    lgraph add claude-code');
    console.log('    lgraph add latent-code');
    console.log('    lgraph add opencode');
    console.log('    lgraph add codex');
    console.log('    lgraph add copilot');
    console.log('    lgraph add droid');
    console.log('');
    console.log('  MCP tools will use read-only public access — no API key required.\n');
}

export async function joinCommand(options: JoinOptions = {}): Promise<void> {
    const projectRoot = process.cwd();

    // Public join flow: no API key needed
    if (options.publicId) {
        return joinPublicProject(options.publicId, projectRoot);
    }

    console.log('╔════════════════════════════════════════════╗');
    console.log('║        Joining Collaboration Project       ║');
    console.log('╚════════════════════════════════════════════╝\n');

    // Step 1: Check API key
    const apiKey = getApiKey();
    if (!apiKey) {
        console.error('❌ No API key configured. Run "lgraph config set api-key <key>" first.');
        process.exit(1);
    }
    console.log('[Join] ✓ API key found\n');

    // Step 2: Check if project is already configured here
    const existing = readProjectConfig(projectRoot);
    if (existing) {
        console.log(`[Join] ⚠️  This directory is already linked to project "${existing.project_name}" (${existing.project_id}).`);
        console.log('[Join]   Remove .lgraph/config.json to re-link.\n');
        process.exit(1);
    }

    // Step 3: Fetch shared (contributor) projects
    console.log('[Join] Fetching collaboration projects...');
    let projects: SharedProject[];
    try {
        projects = await fetchSharedProjects(apiKey);
    } catch (error) {
        console.error(`\n❌ Failed to fetch shared projects: ${(error as Error).message}`);
        process.exit(1);
    }

    if (projects.length === 0) {
        console.log('\n[Join] No collaboration projects found.');
        console.log('       Ask a project owner to add you as a contributor first.\n');
        process.exit(0);
    }

    let selected: SharedProject;

    // Step 4a: --project-name flag provided — find by name
    if (options.projectName) {
        const match = projects.find(
            (p) => p.project_name.toLowerCase() === options.projectName!.toLowerCase(),
        );
        if (!match) {
            console.error(`\n❌ No shared project named "${options.projectName}" found.`);
            console.log('   Available projects:');
            projects.forEach((p) => console.log(`     - ${p.project_name}`));
            console.log('');
            process.exit(1);
        }
        selected = match;
    } else {
        // Step 4b: Interactive selection
        if (!process.stdin.isTTY) {
            console.error('\n❌ Non-interactive mode: provide --project-name <name>.');
            process.exit(1);
        }
        selected = await promptSelectSharedProject(projects);
    }

    // Step 5: Validate branch arguments
    const sourceBranch = options.sourceBranch;
    const userBranchName = options.userBranchName;

    if (!sourceBranch || !userBranchName) {
        console.error('\n❌ Branch arguments required.');
        console.error('   Usage: lgraph join <source_branch> <user_branch_name> [--project-name <name>]');
        console.error('   Example: lgraph join main johns-feature --project-name "My Project"\n');
        process.exit(1);
    }

    // Step 6: Call join-branch API to copy DRG data
    console.log(`\n[Join] Copying DRG data from '${sourceBranch}' to '${userBranchName}'...`);
    let joinResult;
    try {
        joinResult = await sendJoinBranch(apiKey, {
            project_id: selected.project_id,
            source_branch: sourceBranch,
            user_branch_name: userBranchName,
        });
    } catch (error) {
        console.error(`\n❌ Failed to join branch: ${(error as Error).message}`);
        process.exit(1);
    }

    if (!joinResult.success) {
        console.error(`\n❌ Failed to join branch: ${joinResult.message}`);
        process.exit(1);
    }

    // Step 7: Write .lgraph/config.json with role=contributor and branch info
    setProject(selected.project_id, selected.project_name, projectRoot);
    const savedConfig = readProjectConfig(projectRoot)!;
    savedConfig.role = 'contributor';
    savedConfig.default_branch = joinResult.default_branch || sourceBranch;
    savedConfig.user_branch = userBranchName;
    savedConfig.source_branch = sourceBranch;
    writeProjectConfig(savedConfig, projectRoot);

    const filesCopied = joinResult.files_copied ?? 'unknown';
    console.log(`[Join] ✓ Copied ${filesCopied} files`);
    console.log(`\n[Join] ✓ Linked to project "${selected.project_name}" (${selected.project_id})`);
    console.log('\n╔════════════════════════════════════════════╗');
    console.log('║          Successfully Joined Project       ║');
    console.log('╚════════════════════════════════════════════╝');
    console.log(`\nProject: ${selected.project_name}`);
    console.log(`Your branch: ${userBranchName}`);
    console.log(`Copied from: ${sourceBranch}`);
    console.log('\nNext steps:');
    console.log('  Add Latentgraph MCP to your AI coding tool:');
    console.log('');
    console.log('    lgraph add claude-code');
    console.log('    lgraph add latent-code');
    console.log('    lgraph add opencode');
    console.log('    lgraph add codex');
    console.log('    lgraph add copilot');
    console.log('    lgraph add droid');
    console.log('');
    console.log('  Run "lgraph update" to sync your local changes.\n');
}
