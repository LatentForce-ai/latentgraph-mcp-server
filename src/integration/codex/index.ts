// Integration orchestrator — generates Codex integration files:
//   1. AGENTS.md     (mandatory usage rules in project root)
//   2. MCP Server    (Latentgraph integration)
//
// Note: Hook script generation is pending Codex support for permissionDecision: allow

import * as fs from 'fs';
import * as path from 'path';
import { createInterface } from 'readline';
import { createAgentsMd } from './agents-md.js';

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
        changes.push('  Create  AGENTS.md                             — project MCP usage rules');
    } else {
        const content = fs.readFileSync(agentsMdPath, 'utf-8');
        if (content.includes('<!-- lgraph-mcp-instructions -->')) {
            changes.push('  Update  AGENTS.md                             — refresh Latentgraph MCP usage rules');
        } else {
            changes.push('  Append  AGENTS.md                             — add Latentgraph MCP usage rules');
        }
    }

    return changes;
}

async function askForConsent(projectRoot: string, consentOverride?: boolean): Promise<boolean> {
    if (consentOverride !== undefined) {
        return consentOverride;
    }

    const changes = describeChanges(projectRoot);

    console.log('\n  Latentgraph wants to set up Codex integration in your project:\n');
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

export async function setupCodexIntegration(
    projectRoot: string,
    options: SetupOptions = {},
): Promise<IntegrationResult> {
    if (options.hasUserConsent === true) {
        // explicit approval
    } else if (options.promptForConsent === true) {
        const accepted = await askForConsent(projectRoot, options._consentOverride);
        if (!accepted) {
            console.log(
                '\n  Skipped. Run "lgraph add codex" at any time to set up Codex integration.\n',
            );
            return { skipped: true, skipReason: 'User declined the consent prompt.' };
        }
        console.log('');
    } else {
        return {
            skipped: true,
            skipReason:
                'No explicit approval provided. ' +
                'Run "lgraph add codex" to set up interactively, ' +
                'or pass --yes to approve automatically in scripts.',
        };
    }

    console.log('  Setting up Codex integration...\n');

    createAgentsMd(projectRoot);

    console.log('  [Hooks] Skipped — Codex does not yet support permissionDecision: allow');

    console.log('');
    return { skipped: false };
}

export { describeChanges };
