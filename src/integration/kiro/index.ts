// Integration orchestrator — generates all Kiro CLI integration files:
//   1. AGENTS.md               (mandatory usage rules in project root)
//   2. Steering file           (.kiro/steering/lgraph.md)              — committed/shared
//   3. Agent config            (.kiro/agents/lgraph.json)              — committed/shared Kiro agent
//   4. Hook script             (.kiro/hooks/lgraph/lgraph-hook.cjs)    — gitignored
//   5. .gitignore              (ensures generated local files are ignored)

import * as fs from 'fs';
import * as path from 'path';
import { createInterface } from 'readline';
import { generateHookFiles, type GenerateHooksResult } from './hooks.js';
import { createAgentsMd, createSteeringMd } from './instructions.js';

export { createAgentsMd, createSteeringMd } from './instructions.js';

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
    const agentsMdPath = path.join(projectRoot, 'AGENTS.md');
    const steeringPath = path.join(projectRoot, '.kiro', 'steering', 'lgraph.md');
    const changes: string[] = [];

    if (!fs.existsSync(agentsMdPath)) {
        changes.push('  Create  AGENTS.md                — MCP usage rules (auto-loaded by Kiro IDE)');
    } else {
        const content = fs.readFileSync(agentsMdPath, 'utf-8');
        if (content.includes('<!-- lgraph-mcp-instructions -->')) {
            changes.push('  Update  AGENTS.md                — refresh Latentgraph MCP usage rules');
        } else {
            changes.push('  Append  AGENTS.md                — add Latentgraph MCP usage rules');
        }
    }

    if (!fs.existsSync(steeringPath)) {
        changes.push('  Create  .kiro/steering/lgraph.md — native Kiro workspace steering (commit this)');
    } else {
        changes.push('  Update  .kiro/steering/lgraph.md — refresh native Kiro workspace steering');
    }

    return changes;
}

function describeHookChanges(projectRoot: string): string[] {
    const agentConfigPath = path.join(projectRoot, '.kiro', 'agents', 'lgraph.json');
    const changes: string[] = [];

    if (!fs.existsSync(agentConfigPath)) {
        changes.push('  Create  .kiro/agents/lgraph.json  — shared lgraph agent with PreToolUse hooks (commit this)');
    } else {
        changes.push('  Update  .kiro/agents/lgraph.json  — shared lgraph agent with PreToolUse hooks (commit this)');
    }

    changes.push('  Create  .kiro/hooks/lgraph/       — hook script (gitignored, auto-generated)');
    changes.push('  Update  .gitignore                — exclude generated local files');

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
        rl.question('  Proceed? (Y/n): ', (answer) => {
            rl.close();
            const trimmed = answer.trim().toLowerCase();
            resolve(trimmed === '' || trimmed === 'y' || trimmed === 'yes');
        });
    });
}

export async function setupKiroIntegration(
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
                '\n  Skipped. Run "lgraph add kiro" at any time to set up Kiro CLI integration.\n',
            );
            return { skipped: true, skipReason: 'User declined the project update prompt.' };
        }

        console.log('');

        const hookAccepted = await askYesNoPrompt(
            'Latentgraph wants to set up the Kiro hook:',
            describeHookChanges(projectRoot),
            options._consentOverride,
        );
        if (!hookAccepted) {
            console.log(
                '\n  Skipped. Run "lgraph add kiro" at any time to set up Kiro CLI integration.\n',
            );
            return { skipped: true, skipReason: 'User declined the hook setup prompt.' };
        }

        console.log('');
    } else {
        return {
            skipped: true,
            skipReason:
                'No explicit approval provided. ' +
                'Run "lgraph add kiro" to set up interactively, ' +
                'or pass --yes to approve automatically in scripts.',
        };
    }

    console.log('  Setting up Kiro CLI integration...\n');

    createAgentsMd(projectRoot);
    createSteeringMd(projectRoot);

    console.log('  [Hooks] Generating hook files...');
    const hooks = generateHookFiles(projectRoot);
    console.log(`  [Hooks] Hook script: ${hooks.hookFilePath}`);
    if (hooks.agentConfigUpdated) {
        console.log('  [Hooks] Registered Kiro PreToolUse hooks in .kiro/agents/lgraph.json');
        console.log('  [Hooks] Tip: commit .kiro/agents/lgraph.json and use the shared "lgraph" agent in Kiro when you want hook-assisted MCP guidance.');
    }

    const gitignoreUpdated = updateGitignore(projectRoot);

    console.log('');
    return { skipped: false, hooks, gitignoreUpdated };
}

export { describeProjectChanges, describeHookChanges };

function updateGitignore(projectRoot: string): boolean {
    const gitignorePath = path.join(projectRoot, '.gitignore');
    const entries = [
        '# Latentgraph Kiro CLI integration (auto-generated)',
        '.kiro/hooks/lgraph/',
    ];

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
