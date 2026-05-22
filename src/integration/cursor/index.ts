// Integration orchestrator — generates Cursor integration files:
//   1. AGENTS.md            (project root)                  — committed/shared
//   2. .cursor/mcp.json     (project root)                  — committed/shared
//   3. .gitignore           (excludes generated local files)

import * as fs from 'fs';
import * as path from 'path';
import { createInterface } from 'readline';
import { createAgentsMd } from './cursor-md.js';

export { createAgentsMd } from './cursor-md.js';

export interface SetupOptions {
    promptForConsent?: boolean;
    hasUserConsent?: boolean;
    _consentOverride?: boolean;
}

export interface IntegrationResult {
    skipped: boolean;
    skipReason?: string;
    gitignoreUpdated?: boolean;
}

function describeChanges(projectRoot: string): string[] {
    const agentsMdPath = path.join(projectRoot, 'AGENTS.md');
    const mcpPath = path.join(projectRoot, '.cursor', 'mcp.json');
    const changes: string[] = [];

    if (!fs.existsSync(agentsMdPath)) {
        changes.push('  Create  AGENTS.md                     — project MCP usage rules');
    } else {
        const content = fs.readFileSync(agentsMdPath, 'utf-8');
        if (content.includes('<!-- lgraph-mcp-instructions -->')) {
            changes.push('  Update  AGENTS.md                     — refresh Latentgraph MCP usage rules');
        } else {
            changes.push('  Append  AGENTS.md                     — add Latentgraph MCP usage rules');
        }
    }

    if (!fs.existsSync(mcpPath)) {
        changes.push('  Create  .cursor/mcp.json         — register MCP (commit this)');
    } else {
        changes.push('  Update  .cursor/mcp.json         — register MCP (commit this)');
    }

    return changes;
}

async function askForConsent(projectRoot: string, consentOverride?: boolean): Promise<boolean> {
    if (consentOverride !== undefined) {
        return consentOverride;
    }

    const changes = describeChanges(projectRoot);

    console.log('\n  Latentgraph wants to set up Cursor integration in your project:\n');
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

export async function setupCursorIntegration(
    projectRoot: string,
    options: SetupOptions = {},
): Promise<IntegrationResult> {
    if (options.hasUserConsent === true) {
        // explicit approval
    } else if (options.promptForConsent === true) {
        const accepted = await askForConsent(projectRoot, options._consentOverride);
        if (!accepted) {
            console.log(
                '\n  Skipped. Run "lgraph add cursor" at any time to set up Cursor integration.\n',
            );
            return { skipped: true, skipReason: 'User declined the consent prompt.' };
        }
        console.log('');
    } else {
        return {
            skipped: true,
            skipReason:
                'No explicit approval provided. ' +
                'Run "lgraph add cursor" to set up interactively, ' +
                'or pass --yes to approve automatically in scripts.',
        };
    }

    console.log('  Setting up Cursor integration...\n');

    createAgentsMd(projectRoot);

    console.log('  Tip: commit AGENTS.md and .cursor/mcp.json so your team shares the setup.\n');
    console.log('  [NOTE] The MCP integration may start as disabled for Cursor.');
    console.log('  You should check Cursor Settings > MCP to confirm it is enabled for lgraph.\n');

    console.log('');
    return { skipped: false, gitignoreUpdated: false };
}

export { describeChanges };

function updateGitignore(projectRoot: string): boolean {
    const gitignorePath = path.join(projectRoot, '.gitignore');
    const entries = [
        '# Latentgraph Cursor integration (auto-generated)',
        '.cursor/hooks/lgraph/',
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
