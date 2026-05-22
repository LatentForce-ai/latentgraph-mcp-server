import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';

import { createClaudeMd } from '../claude/claude-md.js';
import { generateHookFiles } from '../claude/hooks.js';
import { setupClaudeCodeIntegration } from '../claude/index.js';
import { generateAgentFiles, generateSkillFiles } from '../claude/skills.js';

import { generateSkillFiles as generateCopilotSkillFiles } from '../copilot/skills.js';
import { createCopilotInstructions } from '../copilot/instructions.js';
import { generatePromptFiles as generateCopilotPromptFiles } from '../copilot/prompts.js';
import { generateHookFiles as generateCopilotHookFiles } from '../copilot/hooks.js';
import { setupCopilotIntegration } from '../copilot/index.js';

import { generateSkillFiles as generateCodexSkillFiles } from '../codex/skills.js';
import { setupCodexIntegration } from '../codex/index.js';

import { setupLatentCodeIntegration } from '../latent-code/index.js';
import { setupOpencodeIntegration } from '../opencode/index.js';

import { generateSkillFiles as generateKiroSkillFiles } from '../kiro/skills.js';
import { generateHookFiles as generateKiroHookFiles } from '../kiro/hooks.js';
import { setupKiroIntegration } from '../kiro/index.js';

import { addCommand } from '../../cli/commands/add.js';

function makeTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'lgraph-test-'));
}

function rmrf(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
}

function runHook(hookPath: string, input: Record<string, unknown>): Record<string, unknown> {
    const result = execFileSync('node', [hookPath], {
        input: JSON.stringify(input),
        encoding: 'utf-8',
        timeout: 5000,
    });
    return JSON.parse(result);
}

// Kiro hooks: exit 0 = pass through (no output), exit 2 = deny (stderr to LLM)
function runKiroHook(hookPath: string, input: Record<string, unknown>): { exitCode: number; stdout: string; stderr: string } {
    try {
        const stdout = execFileSync('node', [hookPath], {
            input: JSON.stringify(input),
            encoding: 'utf-8',
            timeout: 5000,
        });
        return { exitCode: 0, stdout, stderr: '' };
    } catch (e: unknown) {
        const err = e as { status?: number; stdout?: string; stderr?: string };
        return { exitCode: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    }
}

const EXPECTED_GUIDES = [
    'lgraph-cli',
    'lgraph-debugging',
    'lgraph-editing',
    'lgraph-exploring',
    'lgraph-impact',
];

describe('generateSkillFiles', () => {
    let tmpDir: string;

    beforeEach(() => { tmpDir = makeTmpDir(); });
    afterEach(() => { rmrf(tmpDir); });

    it('creates 5 compatibility skill directories under .claude/skills/', () => {
        generateSkillFiles(tmpDir);
        const skillsDir = path.join(tmpDir, '.claude', 'skills');
        const entries = fs.readdirSync(skillsDir).sort();
        assert.deepEqual(entries, EXPECTED_GUIDES);
        for (const name of EXPECTED_GUIDES) {
            assert.ok(fs.existsSync(path.join(skillsDir, name, 'SKILL.md')), `missing SKILL.md for ${name}`);
        }
    });

    it('each skill has YAML frontmatter and no update-drg references', () => {
        generateSkillFiles(tmpDir);
        for (const name of EXPECTED_GUIDES) {
            const content = fs.readFileSync(
                path.join(tmpDir, '.claude', 'skills', name, 'SKILL.md'),
                'utf-8',
            );
            assert.match(content, /^---\n/, `${name}: missing frontmatter start`);
            assert.match(content, /\nname:\s+\S/, `${name}: missing name field`);
            assert.match(content, /\ndescription:\s+/, `${name}: missing description field`);
            assert.ok(!content.includes('update-drg'), `${name}: must not reference update-drg`);
        }
    });

    it('all skill files reference mcp__lgraph__ and the new tool set', () => {
        generateSkillFiles(tmpDir);
        for (const name of EXPECTED_GUIDES) {
            const content = fs.readFileSync(
                path.join(tmpDir, '.claude', 'skills', name, 'SKILL.md'),
                'utf-8',
            );
            if (content.includes('mcp__')) {
                assert.ok(content.includes('mcp__lgraph__'), `${name}: should reference mcp__lgraph__`);
                assert.ok(!content.includes('mcp__shift__'), `${name}: must not reference mcp__shift__`);
            }
        }

        const exploring = fs.readFileSync(
            path.join(tmpDir, '.claude', 'skills', 'lgraph-exploring', 'SKILL.md'),
            'utf-8',
        );
        for (const tool of ['get_context', 'get_file', 'get_dependencies', 'get_change_impact']) {
            assert.ok(exploring.includes(tool), `lgraph-exploring should reference ${tool}`);
        }
    });
});

describe('generateCodexAgentsMd', () => {
    let tmpDir: string;

    beforeEach(() => { tmpDir = makeTmpDir(); });
    afterEach(() => { rmrf(tmpDir); });

    it('creates AGENTS.md when it does not exist', async () => {
        const { createAgentsMd } = await import('../codex/agents-md.js');
        createAgentsMd(tmpDir);
        assert.ok(fs.existsSync(path.join(tmpDir, 'AGENTS.md')));
    });

    it('contains the full new tool set and no update-drg', async () => {
        const { createAgentsMd } = await import('../codex/agents-md.js');
        createAgentsMd(tmpDir);
        const content = fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8');

        for (const tool of ['get_context', 'get_file', 'get_dependencies', 'get_change_impact']) {
            assert.ok(content.includes(tool), `AGENTS.md should reference ${tool}`);
        }
        assert.ok(!content.includes('update-drg'));
        assert.ok(content.includes('lgraph init --force'));
    });

    it('is idempotent — re-running does not duplicate the lgraph section', async () => {
        const { createAgentsMd } = await import('../codex/agents-md.js');
        createAgentsMd(tmpDir);
        createAgentsMd(tmpDir);
        const content = fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8');
        const count = (content.match(/<!-- lgraph-mcp-instructions -->/g) ?? []).length;
        assert.equal(count, 1, 'section marker must appear exactly once');
    });

    it('appends to existing AGENTS.md without overwriting user content', async () => {
        const agentsMdPath = path.join(tmpDir, 'AGENTS.md');
        fs.writeFileSync(agentsMdPath, '# My Custom Instructions\n\nSome custom Codex guidance.\n');

        const { createAgentsMd } = await import('../codex/agents-md.js');
        createAgentsMd(tmpDir);

        const content = fs.readFileSync(agentsMdPath, 'utf-8');
        assert.ok(content.includes('# My Custom Instructions'));
        assert.ok(content.includes('Latentgraph MCP Tools'));
    });
});
describe('setupCodexIntegration', () => {
    let tmpDir: string;

    beforeEach(() => { tmpDir = makeTmpDir(); });
    afterEach(() => { rmrf(tmpDir); });

    it('writes AGENTS.md with consent', async () => {
        const result = await setupCodexIntegration(tmpDir, { hasUserConsent: true });

        assert.equal(result.skipped, false);
        assert.ok(fs.existsSync(path.join(tmpDir, 'AGENTS.md')));
    });

    it('is skipped without approval', async () => {
        const result = await setupCodexIntegration(tmpDir);
        assert.equal(result.skipped, true);
        assert.ok(!fs.existsSync(path.join(tmpDir, 'AGENTS.md')));
    });
});

describe('createLatentCodeAgentsMd', () => {
    let tmpDir: string;

    beforeEach(() => { tmpDir = makeTmpDir(); });
    afterEach(() => { rmrf(tmpDir); });

    it('creates AGENTS.md when it does not exist', async () => {
        const { createAgentsMd } = await import('../latent-code/instructions.js');
        createAgentsMd(tmpDir);
        assert.ok(fs.existsSync(path.join(tmpDir, 'AGENTS.md')));
    });

    it('contains the full new tool set and no update-drg', async () => {
        const { createAgentsMd } = await import('../latent-code/instructions.js');
        createAgentsMd(tmpDir);
        const content = fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8');

        for (const tool of ['get_context', 'get_file', 'get_dependencies', 'get_change_impact']) {
            assert.ok(content.includes(tool), `AGENTS.md should reference ${tool}`);
        }
        assert.ok(!content.includes('update-drg'));
        assert.ok(content.includes('lgraph init --force'));
    });

    it('is idempotent — re-running does not duplicate the lgraph section', async () => {
        const { createAgentsMd } = await import('../latent-code/instructions.js');
        createAgentsMd(tmpDir);
        createAgentsMd(tmpDir);
        const content = fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8');
        const count = (content.match(/<!-- lgraph-mcp-instructions -->/g) ?? []).length;
        assert.equal(count, 1, 'section marker must appear exactly once');
    });

    it('appends to existing AGENTS.md without overwriting user content', async () => {
        const agentsMdPath = path.join(tmpDir, 'AGENTS.md');
        fs.writeFileSync(agentsMdPath, '# My Custom Instructions\n\nSome custom latent-code guidance.\n');

        const { createAgentsMd } = await import('../latent-code/instructions.js');
        createAgentsMd(tmpDir);

        const content = fs.readFileSync(agentsMdPath, 'utf-8');
        assert.ok(content.includes('# My Custom Instructions'));
        assert.ok(content.includes('Latentgraph MCP Tools'));
    });

    it('references specialist agents and critical rules', async () => {
        const { createAgentsMd } = await import('../latent-code/instructions.js');
        createAgentsMd(tmpDir);
        const content = fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8');

        for (const agent of ['@lgraph-exploring', '@lgraph-editing', '@lgraph-impact', '@lgraph-debugging', '@lgraph-cli']) {
            assert.ok(content.includes(agent), `AGENTS.md should reference ${agent}`);
        }
        assert.ok(content.includes('NEVER'));
        assert.ok(content.includes('ALWAYS'));
    });
});

describe('setupLatentCodeIntegration', () => {
    let tmpDir: string;

    beforeEach(() => { tmpDir = makeTmpDir(); });
    afterEach(() => { rmrf(tmpDir); });

    it('writes AGENTS.md with consent', async () => {
        const result = await setupLatentCodeIntegration(tmpDir, { hasUserConsent: true });

        assert.equal(result.skipped, false);
        assert.ok(fs.existsSync(path.join(tmpDir, 'AGENTS.md')));
    });

    it('is skipped without approval', async () => {
        const result = await setupLatentCodeIntegration(tmpDir);
        assert.equal(result.skipped, true);
        assert.ok(!fs.existsSync(path.join(tmpDir, 'AGENTS.md')));
    });

    it('creates AGENTS.md with Latentgraph MCP instructions', async () => {
        await setupLatentCodeIntegration(tmpDir, { hasUserConsent: true });

        const content = fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8');
        for (const tool of ['get_file', 'get_dependencies', 'get_change_impact']) {
            assert.ok(content.includes(tool), `AGENTS.md should reference ${tool}`);
        }
    });
});

describe('createOpencodeAgentsMd', () => {
    let tmpDir: string;

    beforeEach(() => { tmpDir = makeTmpDir(); });
    afterEach(() => { rmrf(tmpDir); });

    it('creates AGENTS.md when it does not exist', async () => {
        const { createAgentsMd } = await import('../opencode/instructions.js');
        createAgentsMd(tmpDir);
        assert.ok(fs.existsSync(path.join(tmpDir, 'AGENTS.md')));
    });

    it('contains the full new tool set and no update-drg', async () => {
        const { createAgentsMd } = await import('../opencode/instructions.js');
        createAgentsMd(tmpDir);
        const content = fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8');

        for (const tool of ['get_context', 'get_file', 'get_dependencies', 'get_change_impact']) {
            assert.ok(content.includes(tool), `AGENTS.md should reference ${tool}`);
        }
        assert.ok(!content.includes('update-drg'));
        assert.ok(content.includes('lgraph init --force'));
    });

    it('is idempotent — re-running does not duplicate the lgraph section', async () => {
        const { createAgentsMd } = await import('../opencode/instructions.js');
        createAgentsMd(tmpDir);
        createAgentsMd(tmpDir);
        const content = fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8');
        const count = (content.match(/<!-- lgraph-mcp-instructions -->/g) ?? []).length;
        assert.equal(count, 1, 'section marker must appear exactly once');
    });

    it('appends to existing AGENTS.md without overwriting user content', async () => {
        const agentsMdPath = path.join(tmpDir, 'AGENTS.md');
        fs.writeFileSync(agentsMdPath, '# My Custom Instructions\n\nSome custom opencode guidance.\n');

        const { createAgentsMd } = await import('../opencode/instructions.js');
        createAgentsMd(tmpDir);

        const content = fs.readFileSync(agentsMdPath, 'utf-8');
        assert.ok(content.includes('# My Custom Instructions'));
        assert.ok(content.includes('Latentgraph MCP Tools'));
    });

    it('references specialist agents and critical rules', async () => {
        const { createAgentsMd } = await import('../opencode/instructions.js');
        createAgentsMd(tmpDir);
        const content = fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8');

        for (const agent of ['@lgraph-exploring', '@lgraph-editing', '@lgraph-impact', '@lgraph-debugging', '@lgraph-cli']) {
            assert.ok(content.includes(agent), `AGENTS.md should reference ${agent}`);
        }
        assert.ok(content.includes('NEVER'));
        assert.ok(content.includes('ALWAYS'));
    });
});

describe('setupOpencodeIntegration', () => {
    let tmpDir: string;

    beforeEach(() => { tmpDir = makeTmpDir(); });
    afterEach(() => { rmrf(tmpDir); });

    it('writes AGENTS.md with consent', async () => {
        const result = await setupOpencodeIntegration(tmpDir, { hasUserConsent: true });

        assert.equal(result.skipped, false);
        assert.ok(fs.existsSync(path.join(tmpDir, 'AGENTS.md')));
    });

    it('is skipped without approval', async () => {
        const result = await setupOpencodeIntegration(tmpDir);
        assert.equal(result.skipped, true);
        assert.ok(!fs.existsSync(path.join(tmpDir, 'AGENTS.md')));
    });

    it('creates AGENTS.md with Latentgraph MCP instructions', async () => {
        await setupOpencodeIntegration(tmpDir, { hasUserConsent: true });

        const content = fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8');
        for (const tool of ['get_file', 'get_dependencies', 'get_change_impact']) {
            assert.ok(content.includes(tool), `AGENTS.md should reference ${tool}`);
        }
    });
});

describe('generateAgentFiles', () => {
    let tmpDir: string;

    beforeEach(() => { tmpDir = makeTmpDir(); });
    afterEach(() => { rmrf(tmpDir); });

    it('creates 5 Claude project agents under .claude/agents/', () => {
        generateAgentFiles(tmpDir);
        const agentsDir = path.join(tmpDir, '.claude', 'agents');
        const entries = fs.readdirSync(agentsDir).sort();
        assert.deepEqual(entries, EXPECTED_GUIDES.map(name => `${name}.md`));
    });

    it('agent files share the same guide content shape and avoid update-drg', () => {
        generateSkillFiles(tmpDir);
        generateAgentFiles(tmpDir);
        for (const name of EXPECTED_GUIDES) {
            const agentContent = fs.readFileSync(
                path.join(tmpDir, '.claude', 'agents', `${name}.md`),
                'utf-8',
            );
            const skillContent = fs.readFileSync(
                path.join(tmpDir, '.claude', 'skills', name, 'SKILL.md'),
                'utf-8',
            );
            assert.match(agentContent, /^---\n/, `${name}: missing frontmatter`);
            assert.ok(!agentContent.includes('update-drg'), `${name}: must not reference update-drg`);
            assert.notEqual(agentContent, skillContent, `${name}: agent and skill content must differ`);
            assert.ok(!agentContent.includes('## When to Use'), `${name}: agent should not include skill-only reference sections`);
        }
    });

    it('adds frontmatter tool restrictions appropriate to each agent', () => {
        generateAgentFiles(tmpDir);

        const readOnlyAgents = [
            'lgraph-exploring',
            'lgraph-impact',
            'lgraph-debugging',
            'lgraph-cli',
        ];

        for (const name of readOnlyAgents) {
            const content = fs.readFileSync(
                path.join(tmpDir, '.claude', 'agents', `${name}.md`),
                'utf-8',
            );
            assert.match(
                content,
                /\ndisallowedTools:\s+Edit,\s+Write,\s+NotebookEdit\n/,
                `${name}: should forbid edit-capable tools`,
            );
        }

        const editingAgent = fs.readFileSync(
            path.join(tmpDir, '.claude', 'agents', 'lgraph-editing.md'),
            'utf-8',
        );
        assert.match(
            editingAgent,
            /\ndisallowedTools:\s+NotebookEdit\n/,
            'lgraph-editing: should only forbid NotebookEdit',
        );
    });
});

describe('generateHookFiles', () => {
    let tmpDir: string;

    beforeEach(() => { tmpDir = makeTmpDir(); });
    afterEach(() => { rmrf(tmpDir); });

    it('creates .claude/hooks/lgraph/lgraph-hook.cjs', () => {
        generateHookFiles(tmpDir);
        const hookPath = path.join(tmpDir, '.claude', 'hooks', 'lgraph', 'lgraph-hook.cjs');
        assert.ok(fs.existsSync(hookPath));
    });

    it('creates settings.json with correct nested hook structure (PreToolUse only)', () => {
        generateHookFiles(tmpDir);
        const settings = JSON.parse(
            fs.readFileSync(path.join(tmpDir, '.claude', 'settings.json'), 'utf-8'),
        );

        assert.ok(settings.hooks, 'missing hooks key');
        assert.ok(Array.isArray(settings.hooks.PreToolUse), 'PreToolUse should be an array');
        assert.equal(settings.hooks.PreToolUse.length, 1);
        assert.equal(settings.hooks.PostToolUse, undefined, 'PostToolUse must not be registered');
    });

    it('hook script falls back to passive read context on source-file reads when no API config exists', () => {
        generateHookFiles(tmpDir);
        const output = runHook(
            path.join(tmpDir, '.claude', 'hooks', 'lgraph', 'lgraph-hook.cjs'),
            {
                hook_event_name: 'PreToolUse',
                tool_name: 'Read',
                tool_input: { file_path: 'src/main.ts' },
            },
        ) as { hookSpecificOutput?: { permissionDecision?: string; additionalContext?: string } };

        // Without API config the hook falls back to static passive read guidance.
        assert.ok(output.hookSpecificOutput, 'should have hookSpecificOutput');
        assert.equal(output.hookSpecificOutput.permissionDecision, 'allow');
        assert.ok(
            output.hookSpecificOutput.additionalContext?.includes('Keep the summary, module role'),
            'fallback should inject passive read context',
        );
    });

    it('hook script ignores non-source reads', () => {
        generateHookFiles(tmpDir);
        const output = runHook(
            path.join(tmpDir, '.claude', 'hooks', 'lgraph', 'lgraph-hook.cjs'),
            {
                hook_event_name: 'PreToolUse',
                tool_name: 'Read',
                tool_input: { file_path: 'config/settings.json' },
            },
        );
        assert.deepEqual(output, {});
    });

    it('hook script injects context on first read then passes through on second read (fire-once per session)', () => {
        generateHookFiles(tmpDir);
        const hookPath = path.join(tmpDir, '.claude', 'hooks', 'lgraph', 'lgraph-hook.cjs');
        const sessionId = 'test-session-fire-once-' + Date.now();
        const stateFile = path.join(os.tmpdir(), `lgraph-hook-${sessionId}-seen.json`);

        // Clean up any leftover state from a previous run
        try { fs.unlinkSync(stateFile); } catch { /* ignore */ }

        const input = {
            hook_event_name: 'PreToolUse',
            tool_name: 'Read',
            tool_input: { file_path: 'src/main.ts' },
            session_id: sessionId,
        };

        // First read — should inject context (fallback passive guidance since no API config)
        const first = runHook(hookPath, input) as {
            hookSpecificOutput?: { permissionDecision?: string; additionalContext?: string };
        };
        assert.ok(first.hookSpecificOutput, 'first read should have hookSpecificOutput');
        assert.equal(first.hookSpecificOutput!.permissionDecision, 'allow');
        assert.ok(
            first.hookSpecificOutput!.additionalContext?.includes('Keep the summary, module role'),
            'first read should inject passive read context',
        );

        // Second read of the same file in the same session — should pass through silently
        const second = runHook(hookPath, input);
        assert.deepEqual(second, {}, 'second read of same file should be empty (fire-once)');

        // Clean up state file
        try { fs.unlinkSync(stateFile); } catch { /* ignore */ }
    });

    it('hook script deduplicates Grep, Glob, and Bash nudges once per pattern/command per session', () => {
        generateHookFiles(tmpDir);
        const hookPath = path.join(tmpDir, '.claude', 'hooks', 'lgraph', 'lgraph-hook.cjs');
        const sessionId = 'test-claude-dedup-' + Date.now();
        const stateFile = path.join(os.tmpdir(), `lgraph-hook-${sessionId}-seen.json`);
        try { fs.unlinkSync(stateFile); } catch { /* ignore */ }

        type HookOut = { hookSpecificOutput?: { additionalContext?: string } };

        // Grep — first fires, second is silent
        const g1 = runHook(hookPath, { hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'import ', glob: 'src/**/*.ts' }, session_id: sessionId }) as HookOut;
        const g2 = runHook(hookPath, { hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'import ', glob: 'src/**/*.ts' }, session_id: sessionId });
        assert.ok(g1.hookSpecificOutput?.additionalContext, 'Grep first call should emit');
        assert.deepEqual(g2, {}, 'Grep second call with same pattern should be silent');

        // Glob — first fires, second is silent
        const gl1 = runHook(hookPath, { hook_event_name: 'PreToolUse', tool_name: 'Glob', tool_input: { pattern: '**/*.ts' }, session_id: sessionId }) as HookOut;
        const gl2 = runHook(hookPath, { hook_event_name: 'PreToolUse', tool_name: 'Glob', tool_input: { pattern: '**/*.ts' }, session_id: sessionId });
        assert.ok(gl1.hookSpecificOutput?.additionalContext, 'Glob first call should emit');
        assert.deepEqual(gl2, {}, 'Glob second call with same pattern should be silent');

        // Bash — first fires, second is silent
        const b1 = runHook(hookPath, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rg "import " src' }, session_id: sessionId }) as HookOut;
        const b2 = runHook(hookPath, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rg "import " src' }, session_id: sessionId });
        assert.ok(b1.hookSpecificOutput?.additionalContext, 'Bash first call should emit');
        assert.deepEqual(b2, {}, 'Bash second call with same command should be silent');

        try { fs.unlinkSync(stateFile); } catch { /* ignore */ }
    });

    it('hook script always injects context when session_id is absent (no deduplication)', () => {
        generateHookFiles(tmpDir);
        const hookPath = path.join(tmpDir, '.claude', 'hooks', 'lgraph', 'lgraph-hook.cjs');

        const input = {
            hook_event_name: 'PreToolUse',
            tool_name: 'Read',
            tool_input: { file_path: 'src/main.ts' },
            // no session_id
        };

        const first = runHook(hookPath, input) as {
            hookSpecificOutput?: { permissionDecision?: string; additionalContext?: string };
        };
        const second = runHook(hookPath, input) as {
            hookSpecificOutput?: { permissionDecision?: string; additionalContext?: string };
        };

        assert.ok(first.hookSpecificOutput?.additionalContext, 'first should inject context');
        assert.ok(second.hookSpecificOutput?.additionalContext, 'second should also inject context when no session_id');
    });
});

describe('createClaudeMd', () => {
    let tmpDir: string;

    beforeEach(() => { tmpDir = makeTmpDir(); });
    afterEach(() => { rmrf(tmpDir); });

    it('creates CLAUDE.md when it does not exist', () => {
        createClaudeMd(tmpDir);
        assert.ok(fs.existsSync(path.join(tmpDir, 'CLAUDE.md')));
    });

    it('contains the full new tool set and no update-drg', () => {
        createClaudeMd(tmpDir);
        const content = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf-8');

        for (const tool of ['get_context', 'get_file', 'get_dependencies', 'get_change_impact']) {
            assert.ok(content.includes(tool), `CLAUDE.md should reference ${tool}`);
        }
        assert.ok(!content.includes('update-drg'));
        assert.ok(content.includes('lgraph init --force'));
    });
});

const EXPECTED_COPILOT_SKILLS = [
    'lgraph-cli',
    'lgraph-debugging',
    'lgraph-editing',
    'lgraph-exploring',
    'lgraph-impact',
];

describe('generateCopilotSkillFiles', () => {
    let tmpDir: string;

    beforeEach(() => { tmpDir = makeTmpDir(); });
    afterEach(() => { rmrf(tmpDir); });

    it('creates 5 skill directories under .github/skills/', () => {
        generateCopilotSkillFiles(tmpDir);
        const skillsDir = path.join(tmpDir, '.github', 'skills');
        const entries = fs.readdirSync(skillsDir).sort();
        assert.deepEqual(entries, EXPECTED_COPILOT_SKILLS);
        for (const name of EXPECTED_COPILOT_SKILLS) {
            assert.ok(fs.existsSync(path.join(skillsDir, name, 'SKILL.md')), `missing SKILL.md for ${name}`);
        }
    });

    it('each skill has valid YAML frontmatter and no update-drg references', () => {
        generateCopilotSkillFiles(tmpDir);
        for (const name of EXPECTED_COPILOT_SKILLS) {
            const content = fs.readFileSync(
                path.join(tmpDir, '.github', 'skills', name, 'SKILL.md'),
                'utf-8',
            );
            assert.match(content, /^---\n/, `${name}: missing frontmatter start`);
            assert.match(content, /\nname:\s+\S/, `${name}: missing name field`);
            assert.match(content, /\ndescription:\s+/, `${name}: missing description field`);
            assert.ok(!content.includes('update-drg'), `${name}: must not reference update-drg`);
        }
    });

    it('exploring skill references all primary tools', () => {
        generateCopilotSkillFiles(tmpDir);
        const exploring = fs.readFileSync(
            path.join(tmpDir, '.github', 'skills', 'lgraph-exploring', 'SKILL.md'),
            'utf-8',
        );
        for (const tool of ['get_context', 'get_file', 'get_dependencies', 'get_change_impact']) {
            assert.ok(exploring.includes(tool), `lgraph-exploring should reference ${tool}`);
        }

        const cli = fs.readFileSync(
            path.join(tmpDir, '.github', 'skills', 'lgraph-cli', 'SKILL.md'),
            'utf-8',
        );
        assert.ok(cli.includes('lgraph init --force'));
        assert.ok(cli.includes('lgraph add copilot'));
        assert.ok(!cli.includes('lgraph add claude-code'));
    });
});

describe('generateCopilotPromptFiles', () => {
    let tmpDir: string;

    beforeEach(() => { tmpDir = makeTmpDir(); });
    afterEach(() => { rmrf(tmpDir); });

    it('creates 5 prompt files under .github/prompts/', () => {
        generateCopilotPromptFiles(tmpDir);
        const promptsDir = path.join(tmpDir, '.github', 'prompts');
        const entries = fs.readdirSync(promptsDir).sort();
        assert.deepEqual(entries, EXPECTED_COPILOT_SKILLS.map(name => `${name}.prompt.md`));
    });

    it('cli prompt references Copilot setup and avoids update-drg', () => {
        generateCopilotPromptFiles(tmpDir);
        const content = fs.readFileSync(
            path.join(tmpDir, '.github', 'prompts', 'lgraph-cli.prompt.md'),
            'utf-8',
        );
        assert.ok(content.includes('lgraph add copilot'));
        assert.ok(content.includes('lgraph init --force'));
        assert.ok(!content.includes('update-drg'));
    });
});

describe('createCopilotInstructions', () => {
    let tmpDir: string;

    beforeEach(() => { tmpDir = makeTmpDir(); });
    afterEach(() => { rmrf(tmpDir); });

    it('creates .github/copilot-instructions.md with section markers', () => {
        createCopilotInstructions(tmpDir);
        const instructionsPath = path.join(tmpDir, '.github', 'copilot-instructions.md');

        assert.ok(fs.existsSync(instructionsPath));
        const content = fs.readFileSync(instructionsPath, 'utf-8');
        assert.ok(content.includes('<!-- lgraph-mcp-instructions -->'));
        assert.ok(content.includes('<!-- end-lgraph-mcp-instructions -->'));
    });

    it('contains baseline lgraph guidance for repository-wide use', () => {
        createCopilotInstructions(tmpDir);
        const content = fs.readFileSync(
            path.join(tmpDir, '.github', 'copilot-instructions.md'),
            'utf-8',
        );

        for (const tool of ['get_context', 'get_file', 'get_dependencies', 'get_change_impact']) {
            assert.ok(content.includes(tool), `copilot-instructions should reference ${tool}`);
        }
    });

    it('appends to existing instructions without overwriting user content', () => {
        const instructionsPath = path.join(tmpDir, '.github', 'copilot-instructions.md');
        fs.mkdirSync(path.dirname(instructionsPath), { recursive: true });
        fs.writeFileSync(instructionsPath, '# My Custom Instructions\n\nSome custom Copilot guidance.\n');
        createCopilotInstructions(tmpDir);
        const content = fs.readFileSync(instructionsPath, 'utf-8');
        assert.ok(content.includes('# My Custom Instructions'));
        assert.ok(content.includes('Latentgraph MCP Tools'));
    });

    it('is idempotent — re-running does not duplicate the lgraph section', () => {
        createCopilotInstructions(tmpDir);
        createCopilotInstructions(tmpDir);
        const content = fs.readFileSync(
            path.join(tmpDir, '.github', 'copilot-instructions.md'),
            'utf-8',
        );
        const count = (content.match(/<!-- lgraph-mcp-instructions -->/g) ?? []).length;
        assert.equal(count, 1, 'section marker must appear exactly once');
    });
});

describe('generateCopilotHookFiles', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        // Remove persistent session marker so each test starts with a clean slate
        try { fs.unlinkSync(path.join(os.tmpdir(), 'lgraph-copilot-session.json')); } catch { /* ignore */ }
    });
    afterEach(() => {
        // Remove persistent session marker and any per-session state files
        const tmpOsDir = os.tmpdir();
        try { fs.unlinkSync(path.join(tmpOsDir, 'lgraph-copilot-session.json')); } catch { /* ignore */ }
        try {
            for (const f of fs.readdirSync(tmpOsDir)) {
                if (f.startsWith('lgraph-copilot-hook-')) {
                    try { fs.unlinkSync(path.join(tmpOsDir, f)); } catch { /* ignore */ }
                }
            }
        } catch { /* ignore */ }
        rmrf(tmpDir);
    });

    it('creates .github/hooks/lgraph/lgraph-hook.cjs', () => {
        generateCopilotHookFiles(tmpDir);
        const hookPath = path.join(tmpDir, '.github', 'hooks', 'lgraph', 'lgraph-hook.cjs');
        assert.ok(fs.existsSync(hookPath));
    });

    it('creates hooks.json with correct nested hook structure (preToolUse only)', () => {
        generateCopilotHookFiles(tmpDir);
        const config = JSON.parse(
            fs.readFileSync(path.join(tmpDir, '.github', 'hooks', 'hooks.json'), 'utf-8'),
        );

        assert.equal(config.version, 1);
        assert.ok(config.hooks, 'missing hooks key');
        assert.ok(Array.isArray(config.hooks.preToolUse), 'preToolUse should be an array');
        assert.equal(config.hooks.preToolUse.length, 1);
        assert.equal(config.hooks.postToolUse, undefined, 'postToolUse must not be registered');
    });

    it('hook script emits additional context on source-file reads', () => {
        generateCopilotHookFiles(tmpDir);
        const output = runHook(
            path.join(tmpDir, '.github', 'hooks', 'lgraph', 'lgraph-hook.cjs'),
            {
                toolName: 'read_file',
                toolArgs: { file_path: 'src/main.ts' },
                // no sessionId — always emits, no state file written
            },
        );

        const out = output as Record<string, unknown>;
        assert.equal(out.permissionDecision, 'allow');
        assert.ok(typeof out.additionalContext === 'string');
        assert.ok(!(out.additionalContext as string).includes('update-drg'));
    });

    it('hook script emits additional context for dependency-pattern searches when toolArgs are an object', () => {
        generateCopilotHookFiles(tmpDir);
        const output = runHook(
            path.join(tmpDir, '.github', 'hooks', 'lgraph', 'lgraph-hook.cjs'),
            {
                toolName: 'grep_search',
                toolArgs: { pattern: 'import ', path: 'src/main.ts' },
                // no sessionId — always emits
            },
        );

        const out = output as Record<string, unknown>;
        assert.equal(out.permissionDecision, 'allow');
        assert.ok(typeof out.additionalContext === 'string');
        assert.ok(!(out.additionalContext as string).includes('update-drg'));
    });

    it('hook script emits additional context for dependency-pattern terminal searches when toolArgs are a JSON string', () => {
        generateCopilotHookFiles(tmpDir);
        const output = runHook(
            path.join(tmpDir, '.github', 'hooks', 'lgraph', 'lgraph-hook.cjs'),
            {
                toolName: 'bash',
                toolArgs: JSON.stringify({ command: 'rg "import " src' }),
                // no sessionId — always emits
            },
        );

        const out = output as Record<string, unknown>;
        assert.equal(out.permissionDecision, 'allow');
        assert.ok(typeof out.additionalContext === 'string');
    });

    it('hook script emits read guidance only once per session per file', () => {
        generateCopilotHookFiles(tmpDir);
        const hookPath = path.join(tmpDir, '.github', 'hooks', 'lgraph', 'lgraph-hook.cjs');
        const ts = Date.now();
        const sid1 = `copilot-session-a-${ts}`;
        const sid2 = `copilot-session-b-${ts}`;
        const stateFile1 = path.join(os.tmpdir(), `lgraph-copilot-hook-${sid1}.json`);
        const stateFile2 = path.join(os.tmpdir(), `lgraph-copilot-hook-${sid2}.json`);
        try { fs.unlinkSync(stateFile1); } catch { /* ignore */ }
        try { fs.unlinkSync(stateFile2); } catch { /* ignore */ }

        const first = runHook(hookPath, { toolName: 'read_file', toolArgs: { file_path: 'src/main.ts' }, sessionId: sid1, cwd: tmpDir });
        const second = runHook(hookPath, { toolName: 'read_file', toolArgs: { file_path: 'src/main.ts' }, sessionId: sid1, cwd: tmpDir });
        const third = runHook(hookPath, { toolName: 'read_file', toolArgs: { file_path: 'src/other.ts' }, sessionId: sid1, cwd: tmpDir });
        const fourth = runHook(hookPath, { toolName: 'read_file', toolArgs: { file_path: 'src/main.ts' }, sessionId: sid2, cwd: tmpDir });

        assert.equal((first as Record<string, unknown>).permissionDecision, 'allow');
        assert.deepEqual(second, {});
        assert.equal((third as Record<string, unknown>).permissionDecision, 'allow');
        assert.equal((fourth as Record<string, unknown>).permissionDecision, 'allow');

        try { fs.unlinkSync(stateFile1); } catch { /* ignore */ }
        try { fs.unlinkSync(stateFile2); } catch { /* ignore */ }
    });

    it('hook script generates a persistent session ID and deduplicates when no session ID is in input', () => {
        generateCopilotHookFiles(tmpDir);
        const hookPath = path.join(tmpDir, '.github', 'hooks', 'lgraph', 'lgraph-hook.cjs');
        const sessionMarker = path.join(os.tmpdir(), 'lgraph-copilot-session.json');
        const input = { toolName: 'read_file', toolArgs: { file_path: 'src/main.ts' }, cwd: tmpDir };

        // First read — should emit and create a persistent session marker
        const first = runHook(hookPath, input) as Record<string, unknown>;
        assert.equal(first.permissionDecision, 'allow', 'first should emit');
        assert.ok(fs.existsSync(sessionMarker), 'persistent session marker should be created');
        const session = JSON.parse(fs.readFileSync(sessionMarker, 'utf-8'));
        assert.ok(typeof session.id === 'string' && session.id.startsWith('gen-'), 'session id should be a generated UUID');

        // Second read of same file — should be deduplicated (fire-once)
        const second = runHook(hookPath, input) as Record<string, unknown>;
        assert.deepEqual(second, {}, 'second read of same file should be empty (fire-once via persistent session)');
    });

    it('hook script ignores non-source reads', () => {
        generateCopilotHookFiles(tmpDir);
        const output = runHook(
            path.join(tmpDir, '.github', 'hooks', 'lgraph', 'lgraph-hook.cjs'),
            {
                toolName: 'read_file',
                toolArgs: { file_path: 'config/settings.json' },
            },
        );
        assert.deepEqual(output, {});
    });
});

describe('setupClaudeCodeIntegration', () => {
    let tmpDir: string;

    beforeEach(() => { tmpDir = makeTmpDir(); });
    afterEach(() => { rmrf(tmpDir); });

    it('writes CLAUDE.md, hooks, settings, and gitignore entries with consent', async () => {
        const result = await setupClaudeCodeIntegration(tmpDir, { hasUserConsent: true });

        assert.equal(result.skipped, false);
        assert.ok(fs.existsSync(path.join(tmpDir, 'CLAUDE.md')));
        assert.ok(!fs.existsSync(path.join(tmpDir, '.claude', 'agents')));
        assert.ok(!fs.existsSync(path.join(tmpDir, '.claude', 'skills')));
        assert.ok(fs.existsSync(path.join(tmpDir, '.claude', 'settings.json')));
        assert.ok(fs.existsSync(path.join(tmpDir, '.claude', 'hooks', 'lgraph', 'lgraph-hook.cjs')));

        const gitignore = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
        assert.ok(gitignore.includes('.claude/hooks/lgraph/'));
        assert.ok(!gitignore.includes('.claude/skills/lgraph-*/'));
        assert.ok(!gitignore.includes('.claude/agents/'));
        assert.ok(!gitignore.includes('.claude/settings.json'));
    });

    it('removes stale generated Claude agent files during setup', async () => {
        const agentsDir = path.join(tmpDir, '.claude', 'agents');
        fs.mkdirSync(agentsDir, { recursive: true });
        fs.writeFileSync(path.join(agentsDir, 'lgraph-editing.md'), 'stale');
        fs.writeFileSync(path.join(agentsDir, 'custom-agent.md'), 'keep');

        const result = await setupClaudeCodeIntegration(tmpDir, { hasUserConsent: true });

        assert.deepEqual(result.removedStaleAgents, ['lgraph-editing.md']);
        assert.ok(!fs.existsSync(path.join(agentsDir, 'lgraph-editing.md')));
        assert.ok(fs.existsSync(path.join(agentsDir, 'custom-agent.md')));
    });

    it('is skipped without approval', async () => {
        const result = await setupClaudeCodeIntegration(tmpDir);
        assert.equal(result.skipped, true);
        assert.ok(!fs.existsSync(path.join(tmpDir, 'CLAUDE.md')));
    });

    it('generated CLAUDE.md and hooks agree on primary tool names', async () => {
        await setupClaudeCodeIntegration(tmpDir, { hasUserConsent: true });

        const claudeMd = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf-8');
        const settings = fs.readFileSync(
            path.join(tmpDir, '.claude', 'settings.json'),
            'utf-8',
        );

        for (const tool of ['get_file', 'get_dependencies', 'get_change_impact']) {
            assert.ok(claudeMd.includes(tool), `CLAUDE.md should reference ${tool}`);
        }
        assert.ok(settings.includes('Grep|Glob|Read|Bash'));
    });
});

describe('setupCopilotIntegration', () => {
    let tmpDir: string;

    beforeEach(() => { tmpDir = makeTmpDir(); });
    afterEach(() => { rmrf(tmpDir); });

    it('writes repo instructions and shared repository hooks with consent', async () => {
        const result = await setupCopilotIntegration(tmpDir, { hasUserConsent: true });

        assert.equal(result.skipped, false);
        assert.ok(fs.existsSync(path.join(tmpDir, '.github', 'copilot-instructions.md')));
        assert.ok(!fs.existsSync(path.join(tmpDir, '.github', 'skills')));
        assert.ok(!fs.existsSync(path.join(tmpDir, '.github', 'prompts')));
        assert.ok(fs.existsSync(path.join(tmpDir, '.github', 'hooks', 'hooks.json')));
        assert.ok(fs.existsSync(path.join(tmpDir, '.github', 'hooks', 'lgraph', 'lgraph-hook.cjs')));

        const gitignorePath = path.join(tmpDir, '.gitignore');
        if (fs.existsSync(gitignorePath)) {
            const gitignore = fs.readFileSync(gitignorePath, 'utf-8');
            assert.ok(!gitignore.includes('.github/hooks/hooks.json'));
            assert.ok(!gitignore.includes('.github/hooks/lgraph/'));
            assert.ok(!gitignore.includes('.github/skills/'));
        }
    });

    it('is skipped without approval', async () => {
        const result = await setupCopilotIntegration(tmpDir);
        assert.equal(result.skipped, true);
        assert.ok(!fs.existsSync(path.join(tmpDir, '.github', 'copilot-instructions.md')));
    });

    it('repo instructions and hooks.json agree on primary tool names', async () => {
        await setupCopilotIntegration(tmpDir, { hasUserConsent: true });

        const instructions = fs.readFileSync(
            path.join(tmpDir, '.github', 'copilot-instructions.md'),
            'utf-8',
        );
        const hooksConfig = JSON.parse(
            fs.readFileSync(path.join(tmpDir, '.github', 'hooks', 'hooks.json'), 'utf-8'),
        );

        for (const tool of ['get_file', 'get_dependencies', 'get_change_impact']) {
            assert.ok(instructions.includes(tool), `copilot-instructions should reference ${tool}`);
        }
        assert.ok(Array.isArray(hooksConfig.hooks.preToolUse), 'hooks.json preToolUse should be an array');
    });
});

describe('addCommand copilot MCP config', () => {
    let tmpDir: string;
    let originalCwd: string;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        originalCwd = process.cwd();
        // Write a stub .lgraph/config.json so getProjectId() returns a value
        const lgraphDir = path.join(tmpDir, '.lgraph');
        fs.mkdirSync(lgraphDir, { recursive: true });
        fs.writeFileSync(
            path.join(lgraphDir, 'config.json'),
            JSON.stringify({ project_id: 'test-project-id', project_name: 'test' }),
        );
        process.chdir(tmpDir);
    });

    afterEach(() => {
        process.chdir(originalCwd);
        rmrf(tmpDir);
    });

    it('creates .vscode/mcp.json with lgraph server entry', async () => {
        await addCommand('copilot', { yes: true });
        const configPath = path.join(tmpDir, '.vscode', 'mcp.json');
        assert.ok(fs.existsSync(configPath), '.vscode/mcp.json should be created');
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        assert.ok(config.servers?.lgraph, 'servers.lgraph should be present');
        assert.equal(config.servers.lgraph.command, 'lgraph');
    });

    it('does not create a .github/mcp-config.json or .copilot directory', async () => {
        await addCommand('copilot', { yes: true });
        assert.ok(!fs.existsSync(path.join(tmpDir, '.github', 'mcp-config.json')), '.github/mcp-config.json must not be created');
        assert.ok(!fs.existsSync(path.join(tmpDir, '.copilot')), '.copilot must not be created');
    });
});

const EXPECTED_KIRO_SKILLS = [
    'lgraph-cli',
    'lgraph-debugging',
    'lgraph-editing',
    'lgraph-exploring',
    'lgraph-impact',
];

describe('generateKiroSkillFiles', () => {
    let tmpDir: string;

    beforeEach(() => { tmpDir = makeTmpDir(); });
    afterEach(() => { rmrf(tmpDir); });

    it('creates 5 skill files under .kiro/skills/', () => {
        generateKiroSkillFiles(tmpDir);
        const skillsDir = path.join(tmpDir, '.kiro', 'skills');
        const entries = fs.readdirSync(skillsDir).sort();
        assert.deepEqual(entries, EXPECTED_KIRO_SKILLS);
    });

    it('each skill directory contains SKILL.md but no openai.yaml', () => {
        generateKiroSkillFiles(tmpDir);
        for (const name of EXPECTED_KIRO_SKILLS) {
            assert.ok(
                fs.existsSync(path.join(tmpDir, '.kiro', 'skills', name, 'SKILL.md')),
                `missing .kiro/skills/${name}/SKILL.md`,
            );
            assert.ok(
                !fs.existsSync(path.join(tmpDir, '.kiro', 'skills', name, 'agents', 'openai.yaml')),
                `${name} must not have openai.yaml (Kiro-specific format)`,
            );
        }
    });

    it('each skill has valid YAML frontmatter and no update-drg references', () => {
        generateKiroSkillFiles(tmpDir);
        for (const name of EXPECTED_KIRO_SKILLS) {
            const content = fs.readFileSync(
                path.join(tmpDir, '.kiro', 'skills', name, 'SKILL.md'),
                'utf-8',
            );
            assert.match(content, /^---\n/, `${name}: missing frontmatter start`);
            assert.match(content, /\nname:\s+\S/, `${name}: missing name field`);
            assert.match(content, /\ndescription:\s+/, `${name}: missing description field`);
            assert.ok(!content.includes('update-drg'), `${name}: must not reference update-drg`);
        }
    });

    it('exploring skill references all primary tools', () => {
        generateKiroSkillFiles(tmpDir);
        const exploring = fs.readFileSync(
            path.join(tmpDir, '.kiro', 'skills', 'lgraph-exploring', 'SKILL.md'),
            'utf-8',
        );
        for (const tool of ['get_context', 'get_file', 'get_dependencies', 'get_change_impact']) {
            assert.ok(exploring.includes(tool), `lgraph-exploring should reference ${tool}`);
        }

        const cli = fs.readFileSync(
            path.join(tmpDir, '.kiro', 'skills', 'lgraph-cli', 'SKILL.md'),
            'utf-8',
        );
        assert.ok(cli.includes('lgraph init --force'));
        assert.ok(cli.includes('lgraph add kiro'));
    });

    it('marks existing skills as updated and new skills as created', () => {
        const first = generateKiroSkillFiles(tmpDir);
        assert.equal(first.created.length, 5);
        assert.equal(first.updated.length, 0);

        const second = generateKiroSkillFiles(tmpDir);
        assert.equal(second.created.length, 0);
        assert.equal(second.updated.length, 5);
    });
});

describe('generateKiroHookFiles', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        // Remove per-session state files from prior runs
        const tmpOsDir = os.tmpdir();
        try {
            for (const f of fs.readdirSync(tmpOsDir)) {
                if (f.startsWith('lgraph-kiro-hook-')) {
                    try { fs.unlinkSync(path.join(tmpOsDir, f)); } catch { /* ignore */ }
                }
            }
        } catch { /* ignore */ }
    });
    afterEach(() => {
        const tmpOsDir = os.tmpdir();
        try {
            for (const f of fs.readdirSync(tmpOsDir)) {
                if (f.startsWith('lgraph-kiro-hook-')) {
                    try { fs.unlinkSync(path.join(tmpOsDir, f)); } catch { /* ignore */ }
                }
            }
        } catch { /* ignore */ }
        rmrf(tmpDir);
    });

    it('creates the hook script and agent config', () => {
        generateKiroHookFiles(tmpDir);
        assert.ok(fs.existsSync(path.join(tmpDir, '.kiro', 'hooks', 'lgraph', 'lgraph-hook.cjs')));
        assert.ok(fs.existsSync(path.join(tmpDir, '.kiro', 'agents', 'lgraph.json')));
    });

    it('agent config registers one preToolUse hook entry per supported Kiro matcher', () => {
        generateKiroHookFiles(tmpDir);
        const config = JSON.parse(
            fs.readFileSync(path.join(tmpDir, '.kiro', 'agents', 'lgraph.json'), 'utf-8'),
        );
        assert.ok(Array.isArray(config.hooks?.preToolUse), 'preToolUse should be an array');
        const lgraphHooks = config.hooks.preToolUse.filter(
            (e: { command?: string }) => e.command?.includes('lgraph-hook'),
        );
        assert.equal(lgraphHooks.length, 6, 'should register one entry per matcher');
        const matchers = lgraphHooks.map((e: { matcher?: string }) => e.matcher).sort();
        assert.deepEqual(matchers, ['execute_bash', 'fs_read', 'glob', 'grep', 'read', 'shell']);
    });

    it('hook script nudges dependency-pattern searches (execute_bash, exit 0 + stdout suggestion)', () => {
        const { hookFilePath } = generateKiroHookFiles(tmpDir);
        const sessionId = 'kiro-bash-dep-' + Date.now();
        const result = runKiroHook(hookFilePath, {
            hook_event_name: 'preToolUse',
            tool_name: 'execute_bash',
            tool_input: { command: 'grep -r "import " src/' },
            session_id: sessionId,
            cwd: tmpDir,
        });
        assert.equal(result.exitCode, 0, 'dependency search should be allowed (exit 0)');
        assert.ok(result.stdout.includes('get_dependencies'), 'stdout should reference mcp__lgraph__get_dependencies');
    });

    it('hook script nudges dependency-pattern terminal searches (rg variant, exit 0 + stdout)', () => {
        const { hookFilePath } = generateKiroHookFiles(tmpDir);
        const sessionId = 'kiro-bash-rg-' + Date.now();
        const result = runKiroHook(hookFilePath, {
            hook_event_name: 'preToolUse',
            tool_name: 'execute_bash',
            tool_input: { command: 'rg "import " src' },
            session_id: sessionId,
            cwd: tmpDir,
        });
        assert.equal(result.exitCode, 0);
        assert.ok(result.stdout.includes('dependencies'));
    });

    it('hook script injects file context on first read of a source file (exit 0 + stdout)', () => {
        const { hookFilePath } = generateKiroHookFiles(tmpDir);
        const sessionId = 'kiro-read-test-' + Date.now();
        const result = runKiroHook(hookFilePath, {
            hook_event_name: 'preToolUse',
            tool_name: 'read',
            tool_input: { path: 'src/main.ts' },
            session_id: sessionId,
            cwd: tmpDir,
        });
        assert.equal(result.exitCode, 0, 'read should exit 0 (allow)');
        assert.ok(result.stdout.trim().length > 0, 'should inject context on stdout');
        assert.ok(result.stdout.includes('[Latentgraph]'), 'stdout should contain lgraph context');
    });

    it('hook script injects context on first fs_read, silent on second (fire-once per session)', () => {
        const { hookFilePath } = generateKiroHookFiles(tmpDir);
        const sessionId = 'kiro-fire-once-' + Date.now();
        const stateFile = path.join(os.tmpdir(), `lgraph-kiro-hook-${sessionId}.json`);
        try { fs.unlinkSync(stateFile); } catch { /* ignore */ }

        const input = {
            hook_event_name: 'preToolUse',
            tool_name: 'fs_read',
            tool_input: { path: 'src/main.ts' },
            session_id: sessionId,
            cwd: tmpDir,
        };

        const first = runKiroHook(hookFilePath, input);
        assert.equal(first.exitCode, 0, 'first read should exit 0');
        assert.ok(first.stdout.includes('[Latentgraph]'), 'first read should inject context');

        const second = runKiroHook(hookFilePath, input);
        assert.equal(second.exitCode, 0, 'second read should exit 0');
        assert.equal(second.stdout.trim(), '', 'second read of same file should be silent (fire-once)');

        // Different file in same session — should emit again
        const third = runKiroHook(hookFilePath, {
            ...input,
            tool_input: { path: 'src/other.ts' },
        });
        assert.ok(third.stdout.includes('[Latentgraph]'), 'different file should inject context');

        try { fs.unlinkSync(stateFile); } catch { /* ignore */ }
    });

    it('hook script injects context for grep (fire-once per pattern)', () => {
        const { hookFilePath } = generateKiroHookFiles(tmpDir);
        const sessionId = 'kiro-grep-test-' + Date.now();
        const stateFile = path.join(os.tmpdir(), `lgraph-kiro-hook-${sessionId}.json`);
        try { fs.unlinkSync(stateFile); } catch { /* ignore */ }

        const input = {
            hook_event_name: 'preToolUse',
            tool_name: 'grep',
            tool_input: { pattern: 'handleRequest', path: 'src' },
            session_id: sessionId,
            cwd: tmpDir,
        };

        const first = runKiroHook(hookFilePath, input);
        assert.equal(first.exitCode, 0);
        assert.ok(first.stdout.includes('[Latentgraph]'), 'first grep should inject context');

        const second = runKiroHook(hookFilePath, input);
        assert.equal(second.exitCode, 0);
        assert.equal(second.stdout.trim(), '', 'second grep with same pattern should be silent');

        try { fs.unlinkSync(stateFile); } catch { /* ignore */ }
    });

    it('hook script injects context for glob on source patterns (fire-once per glob)', () => {
        const { hookFilePath } = generateKiroHookFiles(tmpDir);
        const sessionId = 'kiro-glob-test-' + Date.now();
        const stateFile = path.join(os.tmpdir(), `lgraph-kiro-hook-${sessionId}.json`);
        try { fs.unlinkSync(stateFile); } catch { /* ignore */ }

        const input = {
            hook_event_name: 'preToolUse',
            tool_name: 'glob',
            tool_input: { pattern: '**/*.ts' },
            session_id: sessionId,
            cwd: tmpDir,
        };

        const first = runKiroHook(hookFilePath, input);
        assert.equal(first.exitCode, 0);
        assert.ok(first.stdout.includes('[Latentgraph]'), 'first glob should inject context');

        const second = runKiroHook(hookFilePath, input);
        assert.equal(second.exitCode, 0);
        assert.equal(second.stdout.trim(), '', 'second glob with same pattern should be silent');

        try { fs.unlinkSync(stateFile); } catch { /* ignore */ }
    });

    it('hook script passes through non-source reads silently (exit 0, no stdout)', () => {
        const { hookFilePath } = generateKiroHookFiles(tmpDir);
        const result = runKiroHook(hookFilePath, {
            hook_event_name: 'preToolUse',
            tool_name: 'read',
            tool_input: { path: 'config/settings.json' },
            cwd: tmpDir,
        });
        assert.equal(result.exitCode, 0);
        assert.equal(result.stdout.trim(), '', 'non-source read should not inject context');
    });

    it('hook script passes through non-dependency bash searches silently (exit 0)', () => {
        const { hookFilePath } = generateKiroHookFiles(tmpDir);
        // "handleRequest" is not a dependency pattern — first call may nudge, but cat is not a search
        const result = runKiroHook(hookFilePath, {
            hook_event_name: 'preToolUse',
            tool_name: 'execute_bash',
            tool_input: { command: 'cat src/main.ts' },
            cwd: tmpDir,
        });
        assert.equal(result.exitCode, 0, 'cat should pass through');
        assert.equal(result.stdout.trim(), '', 'cat is not a search command, no context injected');
    });

    it('hook script passes through non-dependency searches (exit 0)', () => {
        const { hookFilePath } = generateKiroHookFiles(tmpDir);
        const result = runKiroHook(hookFilePath, {
            hook_event_name: 'preToolUse',
            tool_name: 'execute_bash',
            tool_input: { command: 'grep -r "handleRequest" src/' },
            cwd: tmpDir,
        });
        assert.equal(result.exitCode, 0);
    });

    it('is idempotent — re-registering replaces the existing lgraph hook entry', () => {
        generateKiroHookFiles(tmpDir);
        generateKiroHookFiles(tmpDir);
        const config = JSON.parse(
            fs.readFileSync(path.join(tmpDir, '.kiro', 'agents', 'lgraph.json'), 'utf-8'),
        );
        const lgraphHooks = config.hooks.preToolUse.filter(
            (e: { command?: string }) => e.command?.includes('lgraph-hook'),
        );
        assert.equal(lgraphHooks.length, 6, 'should keep exactly one lgraph hook per matcher after two runs');
    });
});

describe('setupKiroIntegration', () => {
    let tmpDir: string;

    beforeEach(() => { tmpDir = makeTmpDir(); });
    afterEach(() => { rmrf(tmpDir); });

    it('creates AGENTS.md, steering, agent config, hook, and .gitignore with hasUserConsent', async () => {
        const result = await setupKiroIntegration(tmpDir, { hasUserConsent: true });
        assert.equal(result.skipped, false);

        assert.ok(fs.existsSync(path.join(tmpDir, 'AGENTS.md')));
        assert.ok(fs.existsSync(path.join(tmpDir, '.kiro', 'steering', 'lgraph.md')));
        assert.ok(fs.existsSync(path.join(tmpDir, '.kiro', 'agents', 'lgraph.json')));
        assert.ok(fs.existsSync(path.join(tmpDir, '.kiro', 'hooks', 'lgraph', 'lgraph-hook.cjs')));
        assert.ok(!fs.existsSync(path.join(tmpDir, '.kiro', 'skills')), 'setup must not generate skill files');

        const gitignore = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
        assert.ok(gitignore.includes('.kiro/hooks/lgraph/'));
        assert.ok(!gitignore.includes('.kiro/agents/lgraph.json'));
        assert.ok(!gitignore.includes('.kiro/skills/'));
    });

    it('is skipped without approval', async () => {
        const result = await setupKiroIntegration(tmpDir);
        assert.equal(result.skipped, true);
        assert.ok(!fs.existsSync(path.join(tmpDir, 'AGENTS.md')));
        assert.ok(!fs.existsSync(path.join(tmpDir, '.kiro', 'steering', 'lgraph.md')));
        assert.ok(!fs.existsSync(path.join(tmpDir, '.kiro', 'agents', 'lgraph.json')));
    });

    it('AGENTS.md, Kiro steering, and agent config agree on primary tool names', async () => {
        await setupKiroIntegration(tmpDir, { hasUserConsent: true });

        const agentsMd = fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8');
        const steeringMd = fs.readFileSync(path.join(tmpDir, '.kiro', 'steering', 'lgraph.md'), 'utf-8');
        const agentConfig = JSON.parse(
            fs.readFileSync(path.join(tmpDir, '.kiro', 'agents', 'lgraph.json'), 'utf-8'),
        );

        for (const tool of ['get_file', 'get_dependencies', 'get_change_impact']) {
            assert.ok(agentsMd.includes(tool), `AGENTS.md should reference ${tool}`);
            assert.ok(steeringMd.includes(tool), `.kiro/steering/lgraph.md should reference ${tool}`);
        }
        assert.ok(Array.isArray(agentConfig.hooks?.preToolUse), 'agent config preToolUse should be an array');
    });
});

describe('addCommand kiro MCP config', () => {
    let tmpDir: string;
    let origCwd: string;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        origCwd = process.cwd();
        const lgraphDir = path.join(tmpDir, '.lgraph');
        fs.mkdirSync(lgraphDir, { recursive: true });
        fs.writeFileSync(
            path.join(lgraphDir, 'config.json'),
            JSON.stringify({ project_id: 'test-project-id', project_name: 'test' }),
        );
        process.chdir(tmpDir);
    });

    afterEach(() => {
        process.chdir(origCwd);
        rmrf(tmpDir);
    });

    it('writes mcpServers.lgraph to .kiro/settings/mcp.json', async () => {
        await addCommand('kiro', { yes: true });
        const mcpPath = path.join(tmpDir, '.kiro', 'settings', 'mcp.json');
        assert.ok(fs.existsSync(mcpPath), '.kiro/settings/mcp.json must be created');
        const config = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
        assert.ok(config.mcpServers?.lgraph, 'mcpServers.lgraph must be present');
        assert.equal(config.mcpServers.lgraph.command, 'lgraph');
        assert.deepEqual(config.mcpServers.lgraph.args, ['mcp']);
    });

    it('does not create a servers.lgraph key (Copilot format) in .kiro/settings/mcp.json', async () => {
        await addCommand('kiro', { yes: true });
        const mcpPath = path.join(tmpDir, '.kiro', 'settings', 'mcp.json');
        const config = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
        assert.ok(!config.servers, 'must not use Copilot-style "servers" key');
    });
});
