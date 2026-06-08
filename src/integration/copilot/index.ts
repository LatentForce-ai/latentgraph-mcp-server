// Integration orchestrator — generates GitHub Copilot integration files:
//   1. Repo instructions (.github/copilot-instructions.md)      — committed/shared
//   2. Repository hooks (.github/hooks/)                        — committed/shared
//   3. .gitignore       (reserved for generated local files when needed)

import * as fs from 'fs';
import * as path from 'path';
import { createInterface } from 'readline';
import { createCopilotInstructions } from './instructions.js';
import { generateHookFiles, type GenerateHooksResult } from './hooks.js';

export interface SetupOptions {
    promptForConsent?: boolean;
    hasUserConsent?: boolean;
    _consentOverride?: boolean;
}

export interface IntegrationResult {
    skipped: boolean;
    skipReason?: string;
    hooks?: GenerateHooksResult;
    gitignoreUpdated?: boolean;
}

function describeProjectChanges(projectRoot: string): string[] {
    const instructionsPath = path.join(projectRoot, '.github', 'copilot-instructions.md');

    const changes: string[] = [];

    if (!fs.existsSync(instructionsPath)) {
        changes.push('  Create  .github/copilot-instructions.md   — shared repo-wide Copilot guidance');
    } else {
        changes.push('  Update  .github/copilot-instructions.md   — refresh repo-wide Copilot guidance');
    }

    return changes;
}

function describeHookChanges(projectRoot: string): string[] {
    const hooksDir = path.join(projectRoot, '.github', 'hooks');
    const hooksConfigPath = path.join(hooksDir, 'hooks.json');

    const changes: string[] = [];

    if (!fs.existsSync(hooksConfigPath)) {
        changes.push('  Create  .github/hooks/hooks.json          — register Copilot preToolUse hook (commit this)');
    } else {
        changes.push('  Update  .github/hooks/hooks.json          — register Copilot preToolUse hook (commit this)');
    }
    changes.push('  Create  .github/hooks/lgraph/             — shared Copilot hook script directory (commit this)');

    return changes;
}

async function askYesNoPrompt(title: string, changes: string[], consentOverride?: boolean): Promise<boolean> {
    if (consentOverride !== undefined) {
        return consentOverride;
    }

    console.log(`\n  ${title}\n`);
    for (const line of changes) {
        console.log(line);
    }
    console.log('');

    const rl = createInterface({ input: process.stdin, output: process.stdout });

    return new Promise((resolve) => {
        rl.question('  Proceed? (y/n, default yes): ', (answer) => {
            rl.close();
            const trimmed = answer.trim().toLowerCase();
            resolve(trimmed === '' || trimmed === 'y' || trimmed === 'yes');
        });
    });
}

export async function setupCopilotIntegration(
    projectRoot: string,
    options: SetupOptions = {},
): Promise<IntegrationResult> {
    if (options.hasUserConsent === true) {
        // explicit approval
    } else if (options.promptForConsent === true) {
        const projectAccepted = await askYesNoPrompt(
            'Latentgraph wants to update your project:',
            describeProjectChanges(projectRoot),
            options._consentOverride,
        );
        if (!projectAccepted) {
            console.log(
                '\n  Skipped. Run "lgraph add copilot" at any time to set up GitHub Copilot integration.\n',
            );
            return { skipped: true, skipReason: 'User declined the project update prompt.' };
        }

        console.log('');

        const hookAccepted = await askYesNoPrompt(
            'Latentgraph wants to set up the GitHub Copilot hook:',
            describeHookChanges(projectRoot),
            options._consentOverride,
        );
        if (!hookAccepted) {
            console.log(
                '\n  Skipped. Run "lgraph add copilot" at any time to set up GitHub Copilot integration.\n',
            );
            return { skipped: true, skipReason: 'User declined the hook setup prompt.' };
        }
        console.log('');
    } else {
        return {
            skipped: true,
            skipReason:
                'No explicit approval provided. ' +
                'Run "lgraph add copilot" to set up interactively, ' +
                'or pass --yes to approve automatically in scripts.',
        };
    }

    console.log('  Setting up GitHub Copilot integration...\n');

    console.log('  [Instructions] Generating repository instructions...');
    createCopilotInstructions(projectRoot);

    console.log('  [Hooks] Generating hook files...');
    const hooks = generateHookFiles(projectRoot);
    console.log(`  [Hooks] Hook script: ${hooks.hookFilePath}`);
    if (hooks.configUpdated) {
        console.log('  [Hooks] Registered preToolUse hook in .github/hooks/hooks.json');
        console.log('  [Hooks] Tip: commit .github/copilot-instructions.md and .github/hooks/ so your team shares the setup.');
    }

    const gitignoreUpdated = updateGitignore(projectRoot);

    console.log('');
    return { skipped: false, hooks, gitignoreUpdated };
}

export { describeProjectChanges, describeHookChanges };

function updateGitignore(projectRoot: string): boolean {
    const gitignorePath = path.join(projectRoot, '.gitignore');
    const entries: string[] = [];

    let existing = '';
    if (fs.existsSync(gitignorePath)) {
        existing = fs.readFileSync(gitignorePath, 'utf-8');
    }

    const missingEntries = entries.filter(entry => !existing.includes(entry));

    if (missingEntries.length === 0) {
        return false;
    }

    const block = '\n' + missingEntries.join('\n') + '\n';
    fs.writeFileSync(gitignorePath, existing.trimEnd() + '\n' + block);
    console.log('  [Gitignore] Updated .gitignore with generated file entries');
    return true;
}
