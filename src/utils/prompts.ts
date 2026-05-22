import * as readline from 'readline';
import { Project } from './api-client.js';

function createReadlineInterface(): readline.Interface {
    return readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
}

export function prompt(question: string): Promise<string> {
    return new Promise((resolve) => {
        const rl = createReadlineInterface();
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

export async function promptApiKey(): Promise<string> {
    console.log('\nNo Latentgraph API key found.');
    const apiKey = await prompt('Please paste your Latentgraph API key: ');

    if (!apiKey) {
        console.error('Error: API key is required.');
        process.exit(1);
    }

    return apiKey;
}

export async function promptProjectId(): Promise<string> {
    console.log('\nNo project configured for this directory.');
    const projectId = await prompt('Please enter your Latentgraph project ID: ');

    if (!projectId) {
        console.error('Error: Project ID is required.');
        process.exit(1);
    }

    return projectId;
}

export async function promptSelectProject(projects: Project[]): Promise<Project> {
    console.log('\nAvailable projects:');
    console.log('-------------------');

    projects.forEach((project, index) => {
        const description = project.description ? ` - ${project.description}` : '';
        console.log(`  ${index + 1}. ${project.project_name}${description}`);
    });

    console.log('');

    const answer = await prompt(`Select a project (1-${projects.length}): `);
    const selection = parseInt(answer, 10);

    if (isNaN(selection) || selection < 1 || selection > projects.length) {
        console.error('Invalid selection.');
        process.exit(1);
    }

    return projects[selection - 1];
}

export type KeyChoice = 'paid' | 'guest';

export async function promptKeyChoice(): Promise<KeyChoice> {
    console.log('\nNo Latentgraph API key found.');
    console.log('');
    console.log('  1. I have an API key');
    console.log('  2. Continue as guest');
    console.log('');

    const answer = await prompt('Select an option (1 or 2): ');
    const selection = parseInt(answer, 10);

    if (selection === 1) {
        return 'paid';
    } else if (selection === 2) {
        return 'guest';
    } else {
        console.error('Invalid selection.');
        process.exit(1);
    }
}

export type ProjectAction = 'select' | 'create';

export async function promptCreateOrSelect(): Promise<ProjectAction> {
    console.log('\nProject setup:');
    console.log('');
    console.log('  1. Select an existing project');
    console.log('  2. Create a new project');
    console.log('');

    const answer = await prompt('Select an option (1 or 2): ');
    const selection = parseInt(answer, 10);

    if (selection === 1) {
        return 'select';
    } else if (selection === 2) {
        return 'create';
    } else {
        console.error('Invalid selection.');
        process.exit(1);
    }
}

export async function promptGithubToken(): Promise<string> {
    console.log('\nOptional: GitHub token for PR insights.');
    console.log('Press Enter to skip — PR enrichment will be disabled.\n');
    const token = await prompt('GitHub token (ghp_...): ');
    return token;
}

export async function promptProjectName(defaultName?: string): Promise<string> {
    const hint = defaultName ? ` (${defaultName})` : '';
    const name = await prompt(`Enter project name${hint}: `);
    const result = name || defaultName || '';
    if (!result) {
        console.error('Error: Project name is required.');
        process.exit(1);
    }
    return result;
}

