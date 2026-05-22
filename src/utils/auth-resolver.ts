import * as path from 'path';
import {
    getApiKey,
    setApiKey,
    setGuestKey,
    isGuestKey,
    setProject,
    readProjectConfig,
} from './config.js';
import {
    requestGuestKey,
    fetchProjects,
    createProject,
    Project,
} from './api-client.js';
import {
    promptApiKey,
    promptKeyChoice,
    promptSelectProject,
    promptProjectName,
    promptCreateOrSelect,
} from './prompts.js';

export interface ResolveApiKeyOptions {
    guest?: boolean;
    apiKey?: string;
    interactive?: boolean;
    commandLabel?: string;
}

export interface ResolveApiKeyResult {
    apiKey: string;
    projectId?: string;
}

/**
 * Resolve API key from flags, config, or interactive prompts.
 * Guest flow returns both apiKey and projectId (from guest-key endpoint).
 */
export async function resolveApiKey(opts: ResolveApiKeyOptions = {}): Promise<ResolveApiKeyResult> {
    const label = opts.commandLabel || 'lgraph';
    const interactive = opts.interactive ?? true;

    // If both --guest and --api-key, api-key wins
    if (opts.guest && opts.apiKey) {
        console.log(`[${label}] ⚠️  Both --guest and --api-key provided; using --api-key.`);
    }

    // 1. Explicit --api-key flag
    if (opts.apiKey) {
        setApiKey(opts.apiKey);
        console.log(`[${label}] ✓ API key saved\n`);
        return { apiKey: opts.apiKey };
    }

    // 2. Existing key in config
    const existingKey = getApiKey();
    if (existingKey) {
        if (isGuestKey()) {
            console.log(`[${label}] ✓ Guest key found\n`);
        } else {
            console.log(`[${label}] ✓ API key found\n`);
        }
        return { apiKey: existingKey };
    }

    // 3. --guest flag
    if (opts.guest) {
        return await doGuestFlow(label);
    }

    // 4. Interactive fallback
    if (interactive) {
        const choice = await promptKeyChoice();
        if (choice === 'paid') {
            const apiKey = await promptApiKey();
            setApiKey(apiKey);
            console.log(`[${label}] ✓ API key saved\n`);
            return { apiKey };
        } else {
            return await doGuestFlow(label);
        }
    }

    // 5. Non-interactive with no key
    console.error(`\n❌ No API key found. Provide --api-key <key> or --guest.`);
    process.exit(1);
}

async function doGuestFlow(label: string): Promise<ResolveApiKeyResult> {
    console.log(`\n[${label}] Requesting guest session...`);
    try {
        const resp = await requestGuestKey();
        setGuestKey(resp.api_key);
        console.log(`[${label}] ✓ Guest session started\n`);

        const result: ResolveApiKeyResult = { apiKey: resp.api_key };

        // Guest endpoint may return a project_id
        if (resp.project_id) {
            result.projectId = resp.project_id;
        }

        return result;
    } catch (error) {
        console.error(`\n❌ Failed to get guest key: ${(error as Error).message}`);
        process.exit(1);
    }
}

export interface ResolveProjectOptions {
    apiKey: string;
    projectId?: string;
    projectName?: string;
    interactive?: boolean;
    commandLabel?: string;
    projectRoot?: string;
}

export interface ResolveProjectResult {
    projectId: string;
    projectName: string;
}

/**
 * Resolve project from flags, local config, or interactive prompts.
 * Can create new projects when --project-name is given.
 */
export async function resolveProject(opts: ResolveProjectOptions): Promise<ResolveProjectResult> {
    const label = opts.commandLabel || 'lgraph';
    const interactive = opts.interactive ?? true;
    const projectRoot = opts.projectRoot || process.cwd();

    // 1. Check existing local config
    const existingConfig = readProjectConfig(projectRoot);
    if (existingConfig) {
        console.log(`[${label}] ✓ Project: ${existingConfig.project_name} (${existingConfig.project_id})\n`);
        return { projectId: existingConfig.project_id, projectName: existingConfig.project_name };
    }

    // 2. Explicit --project-id
    if (opts.projectId) {
        const name = opts.projectName || 'CLI Project';
        setProject(opts.projectId, name, projectRoot);
        console.log(`[${label}] ✓ Project "${name}" saved (${opts.projectId})\n`);
        return { projectId: opts.projectId, projectName: name };
    }

    // 3. --project-name: try to match existing, else create new
    if (opts.projectName) {
        return await resolveByName(opts, projectRoot, label);
    }

    // 4. Interactive fallback
    if (interactive) {
        return await interactiveProjectSetup(opts.apiKey, projectRoot, label);
    }

    // 5. Non-interactive with no project info
    console.error(`\n❌ No project configured. Provide --project-id or --project-name.`);
    process.exit(1);
}

async function resolveByName(
    opts: ResolveProjectOptions,
    projectRoot: string,
    label: string,
): Promise<ResolveProjectResult> {
    const { apiKey, projectName } = opts;
    const interactive = opts.interactive ?? true;

    // Try to match existing project by name
    console.log(`[${label}] Looking for project "${projectName}"...`);
    try {
        const projects = await fetchProjects(apiKey);
        const match = projects.find(
            (p) => p.project_name.toLowerCase() === projectName!.toLowerCase(),
        );
        if (match) {
            setProject(match.project_id, match.project_name, projectRoot);
            console.log(`[${label}] ✓ Found existing project "${match.project_name}" (${match.project_id})\n`);
            return { projectId: match.project_id, projectName: match.project_name };
        }
    } catch {
        // Can't fetch projects — proceed to create
    }

    // No match — create new project
    console.log(`[${label}] No existing project named "${projectName}". Creating new project...`);
    return await createNewProject(apiKey, projectName!, interactive, projectRoot, label);
}

async function createNewProject(
    apiKey: string,
    name: string,
    interactive: boolean,
    projectRoot: string,
    label: string,
): Promise<ResolveProjectResult> {
    try {
        const project = await createProject(apiKey, {
            project_name: name,
        });
        setProject(project.project_id, project.project_name, projectRoot);
        console.log(`[${label}] ✓ Created project "${project.project_name}" (${project.project_id})\n`);
        return { projectId: project.project_id, projectName: project.project_name };
    } catch (error) {
        console.error(`\n❌ Failed to create project: ${(error as Error).message}`);
        process.exit(1);
    }
}

async function interactiveProjectSetup(
    apiKey: string,
    projectRoot: string,
    label: string,
): Promise<ResolveProjectResult> {
    // Always ask user what they want to do first
    const action = await promptCreateOrSelect();

    if (action === 'select') {
        let projects: Project[] = [];
        try {
            projects = await fetchProjects(apiKey);
        } catch {
            // fetch failed
        }

        if (projects.length > 0) {
            const selected = await promptSelectProject(projects);
            setProject(selected.project_id, selected.project_name, projectRoot);
            console.log(`[${label}] ✓ Project "${selected.project_name}" saved\n`);
            return { projectId: selected.project_id, projectName: selected.project_name };
        }

        console.log(`[${label}] No existing projects found. Let's create one.\n`);
    }

    // Create new project — suggest directory name as default
    const defaultName = path.basename(projectRoot);
    const name = await promptProjectName(defaultName);
    return await createNewProject(apiKey, name, true, projectRoot, label);
}
