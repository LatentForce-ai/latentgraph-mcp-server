// Integration orchestrator — generates all Claude Code integration files:
//   1. CLAUDE.md       (mandatory usage rules in project root)
//   2. Hook script     (.claude/hooks/lgraph/lgraph-hook.cjs)      — gitignored
//   3. settings.json   (.claude/settings.json, hook registration)  — committed/shared
//   4. .gitignore      (ensures generated local files are ignored)

import * as fs from 'fs';
import * as path from 'path';
import { createInterface } from 'readline';
import { createClaudeMd } from './claude-md.js';
import { generateHookFiles, type GenerateHooksResult } from './hooks.js';
import { generateSkillFiles, type GenerateSkillsResult } from './skills.js';

export { createClaudeMd } from './claude-md.js';

export interface SetupOptions {
    promptForConsent?: boolean;
    hasUserConsent?: boolean;
    _consentOverride?: boolean;
}

export interface IntegrationResult {
    skipped: boolean;
    skipReason?: string;
    hooks?: GenerateHooksResult;
    skills?: GenerateSkillsResult;
    gitignoreUpdated?: boolean;
    removedStaleAgents?: string[];
}

function describeProjectChanges(projectRoot: string): string[] {
    const claudeMdPath = path.join(projectRoot, 'CLAUDE.md');
    const changes: string[] = [];

    if (!fs.existsSync(claudeMdPath)) {
        changes.push('  Create  CLAUDE.md                     — project MCP usage rules');
    } else {
        const content = fs.readFileSync(claudeMdPath, 'utf-8');
        if (content.includes('<!-- lgraph-mcp-instructions -->')) {
            changes.push('  Update  CLAUDE.md                     — refresh Latentgraph MCP usage rules');
        } else {
            changes.push('  Append  CLAUDE.md                     — add Latentgraph MCP usage rules');
        }
    }

    return changes;
}

function describeHookChanges(projectRoot: string): string[] {
    const settingsPath = path.join(projectRoot, '.claude', 'settings.json');
    const changes: string[] = [];

    if (!fs.existsSync(settingsPath)) {
        changes.push('  Create  .claude/settings.json         — register Claude hook (commit this)');
    } else {
        changes.push('  Update  .claude/settings.json         — register Claude hook (commit this)');
    }

    const staleAgents = listGeneratedClaudeAgentFiles(projectRoot);
    if (staleAgents.length > 0) {
        changes.push('  Remove  .claude/agents/lgraph-*.md    — stale generated Claude agent files');
    }

    changes.push('  Create  .claude/hooks/lgraph/         — hook script (gitignored, auto-generated)');
    changes.push('  Update  .gitignore                    — exclude generated local files');

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

export async function setupClaudeCodeIntegration(
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
                '\n  Skipped. Run "lgraph add claude-code" at any time to set up Claude Code integration.\n',
            );
            return { skipped: true, skipReason: 'User declined the project update prompt.' };
        }

        console.log('');

        const hookAccepted = await askYesNoPrompt(
            'Latentgraph wants to set up the Claude Code hook:',
            describeHookChanges(projectRoot),
            options._consentOverride,
        );
        if (!hookAccepted) {
            console.log(
                '\n  Skipped. Run "lgraph add claude-code" at any time to set up Claude Code integration.\n',
            );
            return { skipped: true, skipReason: 'User declined the hook setup prompt.' };
        }

        console.log('');
    } else {
        return {
            skipped: true,
            skipReason:
                'No explicit approval provided. ' +
                'Run "lgraph add claude-code" to set up interactively, ' +
                'or pass --yes to approve automatically in scripts.',
        };
    }

    console.log('  Setting up Claude Code integration...\n');

    createClaudeMd(projectRoot);
    const removedStaleAgents = removeGeneratedClaudeAgentFiles(projectRoot);
    if (removedStaleAgents.length > 0) {
        console.log(`  [Agents] Removed stale generated agent files: ${removedStaleAgents.join(', ')}`);
    }

    console.log('  [Skills] Generating skill files...');
    const skills = generateSkillFiles(projectRoot);
    if (skills.created.length > 0) {
        console.log(`  [Skills] Created: ${skills.created.join(', ')}`);
    }
    if (skills.updated.length > 0) {
        console.log(`  [Skills] Updated: ${skills.updated.join(', ')}`);
    }

    console.log('  [Hooks] Generating hook files...');
    const hooks = generateHookFiles(projectRoot);
    console.log(`  [Hooks] Hook script: ${hooks.hookFilePath}`);
    if (hooks.settingsUpdated) {
        console.log('  [Hooks] Registered PreToolUse hook in .claude/settings.json');
        console.log('  [Hooks] Tip: commit .claude/settings.json so your team shares the setup.');
    }

    const gitignoreUpdated = updateGitignore(projectRoot);

    console.log('');
    return { skipped: false, hooks, skills, gitignoreUpdated, removedStaleAgents };
}

export { describeProjectChanges, describeHookChanges };

function listGeneratedClaudeAgentFiles(projectRoot: string): string[] {
    const agentsDir = path.join(projectRoot, '.claude', 'agents');
    if (!fs.existsSync(agentsDir)) {
        return [];
    }

    return fs.readdirSync(agentsDir)
        .filter(name => /^lgraph-.*\.md$/.test(name))
        .sort();
}

function removeGeneratedClaudeAgentFiles(projectRoot: string): string[] {
    const agentsDir = path.join(projectRoot, '.claude', 'agents');
    const generatedFiles = listGeneratedClaudeAgentFiles(projectRoot);

    for (const name of generatedFiles) {
        fs.rmSync(path.join(agentsDir, name), { force: true });
    }

    if (generatedFiles.length > 0 && fs.existsSync(agentsDir) && fs.readdirSync(agentsDir).length === 0) {
        fs.rmSync(agentsDir, { recursive: true, force: true });
    }

    return generatedFiles;
}

function updateGitignore(projectRoot: string): boolean {
    const gitignorePath = path.join(projectRoot, '.gitignore');
    const entries = [
        '# Latentgraph Claude Code integration (auto-generated)',
        '.claude/hooks/lgraph/',
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
 