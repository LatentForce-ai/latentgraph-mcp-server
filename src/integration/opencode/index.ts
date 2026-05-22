// Integration orchestrator — generates opencode integration files:
//   1. AGENTS.md            (project root)                  — committed/shared

import * as fs from 'fs';
import * as path from 'path';
import { createInterface } from 'readline';
import { createAgentsMd } from './instructions.js';

export { createAgentsMd } from './instructions.js';

export interface SetupOptions {
    promptForConsent?: boolean;
    hasUserConsent?: boolean;
    _consentOverride?: boolean;
}

export interface IntegrationResult {
    skipped: boolean;
    skipReason?: string;
}

function describeChanges(projectRoot: string): string[] {
    const agentsMdPath = path.join(projectRoot, 'AGENTS.md');

    const changes: string[] = [];

    if (!fs.existsSync(agentsMdPath)) {
        changes.push('  Create  AGENTS.md                          — project MCP usage rules');
    } else {
        const content = fs.readFileSync(agentsMdPath, 'utf-8');
        if (content.includes('<!-- lgraph-mcp-instructions -->')) {
            changes.push('  Update  AGENTS.md                          — refresh Latentgraph MCP usage rules');
        } else {
            changes.push('  Append  AGENTS.md                          — add Latentgraph MCP usage rules');
        }
    }

    return changes;
}

async function askForConsent(projectRoot: string, consentOverride?: boolean): Promise<boolean> {
    if (consentOverride !== undefined) {
        return consentOverride;
    }

    const changes = describeChanges(projectRoot);

    console.log('\n  Latentgraph wants to set up opencode integration in your project:\n');
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

export async function setupOpencodeIntegration(
    projectRoot: string,
    options: SetupOptions = {},
): Promise<IntegrationResult> {
    if (options.hasUserConsent === true) {
        // explicit approval
    } else if (options.promptForConsent === true) {
        const accepted = await askForConsent(projectRoot, options._consentOverride);
        if (!accepted) {
            console.log(
                '\n  Skipped. Run "lgraph add opencode" at any time to set up opencode integration.\n',
            );
            return { skipped: true, skipReason: 'User declined the consent prompt.' };
        }
        console.log('');
    } else {
        return {
            skipped: true,
            skipReason:
                'No explicit approval provided. ' +
                'Run "lgraph add opencode" to set up interactively, ' +
                'or pass --yes to approve automatically in scripts.',
        };
    }

    console.log('  Setting up opencode integration...\n');

    createAgentsMd(projectRoot);
    console.log('  Tip: commit AGENTS.md so your team shares the setup.');
    console.log('  Note: Hook functionality is not yet supported for opencode.');

    console.log('');
    return { skipped: false };
}

export { describeChanges };
