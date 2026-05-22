#!/usr/bin/env node

import { Command } from 'commander';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

const program = new Command();

program
    .name('lgraph')
    .description(
        'Latentgraph CLI - AI-powered code intelligence and dependency analysis.\n\n' +
            'Latentgraph indexes your codebase, builds a dependency relationship graph (DRG),\n' +
            'and provides AI-powered insights via MCP tools.\n\n' +
            'Quick start:\n' +
            '  lgraph start          Start the daemon and configure project\n' +
            '  lgraph init           Scan and index the project\n' +
            '  lgraph update         Run full update pipeline (DRG + Wiki + file-index)\n' +
            '  lgraph update-drg     Build/update the dependency graph\n' +
            '  lgraph update-implicit    Run incremental implicit dependency analysis\n' +
            '  lgraph analyze        Collect code metrics for the dashboard\n' +
            '  lgraph add claude-code  Configure Claude Code integration\n' +
            '  lgraph status         Check current status\n\n' +
            'Configuration:\n' +
            '  Global config:   ~/.lgraph/config.json\n' +
            '  Project config:  .lgraph/config.json',
    )
    .version(version, '-v, --version', 'output the version number');

// `lgraph context` hook-ready file context (not an MCP tool; used by
// PreToolUse hooks to pre-inject graph data before the agent reads a file).
program
    .command('context [file_path]')
    .description('Output hook-ready context (module role, reverse deps, implicit coupling, blast radius) for a source file')
    .option('--from-stdin', 'Read {tool_args:{file_path}} JSON from stdin (PreToolUse hook contract)')
    .action(async (filePath: string | undefined, options: { fromStdin?: boolean }) => {
        const { contextCommand } = await import('./cli/commands/context.js');
        await contextCommand({ filePath, fromStdin: !!options.fromStdin });
    });

// MCP server mode (default when run via MCP host)
program
    .command('mcp', { isDefault: true, hidden: true })
    .description('Start MCP server on stdio')
    .action(async () => {
        const mcpExplicitlyRequested = process.argv.includes('mcp');
        if (process.stdin.isTTY && !mcpExplicitlyRequested) {
            program.outputHelp();
            return;
        }
        const { startMcpServer } = await import('./mcp-server.js');
        await startMcpServer();
    });

// --- start ---
const startCmd = program
    .command('start')
    .description('Start the Latentgraph daemon for this project')
    .option('--guest', 'Use guest authentication (auto-creates a temporary project)')
    .option('-k, --api-key <key>', 'Provide your Latentgraph API key directly')
    .option('--gh-token <token>', 'GitHub token for PR insights (optional)')
    .option('-n, --project-name <name>', 'Create a new project or match an existing one by name')
    .option('--project-id <id>', 'Link to an existing project by its UUID')
    .action(async (options) => {
        const { startCommand } = await import('./cli/commands/start.js');
        await startCommand({
            guest: options.guest,
            apiKey: options.apiKey,
            ghToken: options.ghToken,
            projectName: options.projectName,
            projectId: options.projectId,
        });
    });

startCmd.addHelpText(
    'after',
    `
Details:
  Resolves authentication, configures the project, and launches a
  background daemon that maintains a WebSocket connection to the
  Latentgraph backend.

Examples:
  lgraph start                               Interactive setup
  lgraph start --guest                       Quick start without API key
  lgraph start -k <key> -n "My App"
  lgraph start -k <key> --gh-token ghp_...   Set API key and GitHub token at once
`,
);

// --- init ---
const initCmd = program
    .command('init')
    .description('Initialize and scan the project for file indexing')
    .option('-f, --force', 'Force re-indexing even if the project is already indexed')
    .option('--guest', 'Use guest authentication (auto-creates a temporary project)')
    .option('-k, --api-key <key>', 'Provide your Latentgraph API key directly')
    .option('--gh-token <token>', 'GitHub token for PR insights (optional)')
    .option('-n, --project-name <name>', 'Create a new project or match an existing one by name')
    .option('--project-id <id>', 'Link to an existing project by its UUID')
    .action(async (options) => {
        const { initCommand } = await import('./cli/commands/init.js');
        await initCommand({
            force: options.force ?? false,
            guest: options.guest,
            apiKey: options.apiKey,
            ghToken: options.ghToken,
            projectName: options.projectName,
            projectId: options.projectId,
        });
    });

initCmd.addHelpText(
    'after',
    `
Details:
  Performs a full project scan — collects the file tree, categorizes files
  (source, config, assets), gathers git info, and sends everything to the
  Latentgraph backend for indexing. Automatically starts the daemon if not running.

  If the project is already indexed, you will be prompted to re-index.
  Use --force to skip the prompt.

Examples:
  lgraph init                                    Interactive initialization
  lgraph init -f                                 Force re-index without prompt
  lgraph init --guest                            Quick init with guest auth
  lgraph init -k <key> -n "My App"
  lgraph init -k <key> --gh-token ghp_...        Set API key and GitHub token at once
`,
);

// --- stop ---
const stopCmd = program
    .command('stop')
    .description('Stop the Latentgraph daemon for this project')
    .action(async () => {
        const { stopCommand } = await import('./cli/commands/stop.js');
        await stopCommand();
    });

stopCmd.addHelpText(
    'after',
    `
Details:
  Terminates the background daemon process. The daemon can be
  restarted later with "lgraph start".
`,
);

// --- status ---
const statusCmd = program
    .command('status')
    .description('Show the current Latentgraph status')
    .action(async () => {
        const { statusCommand } = await import('./cli/commands/status.js');
        await statusCommand();
    });

statusCmd.addHelpText(
    'after',
    `
Details:
  Displays a comprehensive overview of:
    - API key configuration (guest or authenticated)
    - Project details (name, ID)
    - Registered agents
    - Backend indexing status and file count
    - Daemon process status (PID, WebSocket connection, uptime)
`,
);

// --- update-drg ---
const updateDrgCmd = program
    .command('update-drg')
    .description('Update the dependency relationship graph (DRG)')
    .option('-b, --baseline', 'Full re-analysis of all files (slower, use after major changes)')
    .option('-m, --mode <mode>', 'Update mode: "baseline" or "incremental" (default: incremental)')
    .action(async (options) => {
        const { updateDrgCommand } = await import('./cli/commands/update-drg.js');
        if (options.baseline && options.mode) {
            console.error('\n❌ Conflicting flags: -b/--baseline and -m/--mode cannot be used together.\n');
            process.exit(1);
        }
        const mode = options.baseline ? 'baseline' : (options.mode ?? 'incremental');
        await updateDrgCommand({ mode });
    });

updateDrgCmd.addHelpText(
    'after',
    `
Details:
  Updates the explicit dependency DRG using either:
    - incremental mode for git-detected changes
    - baseline mode for a full rebuild

  This command runs only when explicitly invoked by the user.
  For a full graph refresh, run a full Latentgraph init-scan / project re-scan.
`,
);

// --- update-wiki ---
const updateWikiCmd = program
    .command('update-wiki')
    .description('Refresh Wiki module documentation with incremental delta detection')
    .action(async () => {
        const { updateWikiCommand } = await import('./cli/commands/update-wiki.js');
        await updateWikiCommand();
    });

updateWikiCmd.addHelpText(
    'after',
    `
Details:
  Sends all project source files to the backend, which runs Wiki
  documentation generation with snapshot-based incremental delta detection.

  Delta modes (resolved server-side — no git diff needed):
    noop        No source changes detected — returns immediately, zero LLM calls
    incremental Only changed modules regenerated (< 50% of files changed)
    full        All modules regenerated (first run or >= 50% changed)

  Unlike update-drg, ALL source files are sent every time.
  The server compares SHA-256 hashes against the saved snapshot to decide
  what needs to be regenerated.

  Run this after editing source files to keep Wiki docs up to date
  without triggering a full project re-scan.
`,
);

// --- analyze ---
const analyzeCmd = program
    .command('analyze')
    .description('Analyze codebase: LOC, tokens, comments, and git activity')
    .action(async () => {
        const { analyzeCommand } = await import('./cli/commands/analyze.js');
        await analyzeCommand();
    });

analyzeCmd.addHelpText(
    'after',
    `
Details:
  Scans the project to collect code metrics including lines of code,
  token counts, comment counts by language, and git commit activity.
  Results are sent to the backend and viewable in the web dashboard.

  Requires "lgraph start" to have been run first (API key + project config).
  Does NOT require "lgraph init".

Examples:
  lgraph analyze
`,
);

// --- update-implicit ---
const updateImplicitCmd = program
    .command('update-implicit')
    .description('Run incremental implicit dependency analysis')
    .action(async () => {
        const { updateImplicitCommand } = await import('./cli/commands/update-implicit.js');
        await updateImplicitCommand();
    });

// --- update --- (Full pipeline: DRG + implicit + file-index + wiki)
const updateCmd = program
    .command('update')
    .description('Update DRG, implicit deps, file index, and wiki for your branch')
    .option('-b, --baseline-drg', 'Run update-drg in baseline (full re-analysis) mode')
    .option('--skip-drg', 'Skip the update-drg step')
    .option('--skip-implicit', 'Skip the update-implicit step')
    .option('--skip-wiki', 'Skip the update-wiki step')
    .option('--skip-file-index', 'Skip the update-file-index step')
    .action(async (options) => {
        const { updateAllCommand } = await import('./cli/commands/update-all.js');
        await updateAllCommand({
            drgMode: options.baselineDrg ? 'baseline' : 'incremental',
            skipDrg: options.skipDrg ?? false,
            skipImplicit: options.skipImplicit ?? false,
            skipWiki: options.skipWiki ?? false,
            skipFileIndex: options.skipFileIndex ?? false,
        });
    });

updateCmd.addHelpText(
    'after',
    `
Details:
  Runs the full incremental update pipeline:
    1. update-drg        — Refresh the dependency relationship graph (DRG)
    2. update-implicit   — Refresh the implicit dependency graph
    3. update-file-index — Refresh per-file enrichment metadata
    4. update-wiki       — Refresh module docs and edge summaries in drg_graph

  This command is available to both project owners and contributors.
  Contributors update their own branch copy of the DRG.

Examples:
  lgraph update                    Full incremental update (DRG + wiki)
  lgraph update --baseline-drg     DRG full re-analysis mode
  lgraph update --skip-wiki        Skip wiki step (faster, no edge_summary refresh)
  lgraph update --skip-drg         Skip DRG step
  lgraph update --skip-implicit    Skip implicit step
  lgraph update --skip-file-index  Skip file-index step
`,
);

// --- update-all --- (Full pipeline with wiki - owner only)
const updateAllCmd = program
    .command('update-all')
    .description('Run full pipeline including wiki regeneration (owner only)')
    .option('-b, --baseline-drg', 'Run update-drg in baseline (full re-analysis) mode')
    .option('--skip-drg', 'Skip the update-drg step')
    .option('--skip-implicit', 'Skip the update-implicit step')
    .option('--skip-wiki', 'Skip the update-wiki step')
    .option('--skip-file-index', 'Skip the update-file-index step')
    .action(async (options) => {
        const { updateAllCommand } = await import('./cli/commands/update-all.js');
        await updateAllCommand({
            drgMode: options.baselineDrg ? 'baseline' : 'incremental',
            skipDrg: options.skipDrg ?? false,
            skipImplicit: options.skipImplicit ?? false,
            skipWiki: options.skipWiki ?? false,
            skipFileIndex: options.skipFileIndex ?? false,
        });
    });

updateAllCmd.addHelpText(
    'after',
    `
Details:
  Runs the full incremental update pipeline:
    1. update-drg        — Refresh the dependency relationship graph (DRG)
    2. update-implicit   — Refresh the implicit dependency graph
    3. update-wiki       — Refresh module docs (expensive, owner only)
    4. update-file-index — Refresh per-file enrichment metadata

  This command is only available to project owners.
  Contributors should use "lgraph update" instead.

Examples:
  lgraph update-all                    Full pipeline with wiki
  lgraph update-all --baseline-drg     DRG full re-analysis mode
  lgraph update-all --skip-wiki        Skip wiki regeneration
`,
);

// --- update-file-index ---
const updateFileIndexCmd = program
    .command('update-file-index')
    .description('Refresh per-file enrichment metadata with incremental delta detection')
    .action(async () => {
        const { updateFileIndexCommand } = await import('./cli/commands/update-file-index.js');
        await updateFileIndexCommand();
    });

updateFileIndexCmd.addHelpText(
    'after',
    `
Details:
  Re-enriches per-file metadata (summaries, exports, API endpoints, tags, etc.)
  for files whose LLM inputs have changed since the last run.

  MUST be run after both:
    lgraph update-implicit    (refreshes implicit dependency map)
    lgraph update-wiki    (regenerates module docs with fresh implicit context)

  Delta modes (resolved server-side — no git diff needed):
    noop        No inputs changed — returns immediately, zero LLM calls
    incremental Only changed files re-enriched
    full        All files enriched (first run or no prior snapshot)

  Change detection uses 5 dimensions hashed at exact LLM-input truncation:
    • Source content (first 8 000 chars)
    • is_leaf flag + module name
    • Module doc content (first 1 500 chars)  ← also captures implicit diff
    • Dependents list
    • Dependency context

  Incremental runs send only changed files with content plus the full active
  path set; the server compares SHA-256 hashes against the saved snapshot.

Examples:
  lgraph update-implicit && lgraph update-wiki && lgraph update-file-index
`,
);

updateImplicitCmd.addHelpText(
    'after',
    `
Details:
  Triggers implicit dependency analysis for changed files only.
  The server auto-detects whether to run an incremental update
  (based on git commit history) or a full scan if no prior run exists.

  Does not re-run explicit dependency analysis (DRG), knowledge graph,
  or Wiki documentation. Use "lgraph init" for a full pipeline run.

Examples:
  lgraph update-implicit          Trigger incremental implicit dep update
`,
);

// --- add mcp servers ---
const addCmd = program
    .command('add [tool]')
    .description('Add Latentgraph MCP server to an AI coding tool')
    .option('-y, --yes', 'Skip the consent prompt and apply Claude integration changes automatically')
    .action(async (tool?: string, options?: { yes?: boolean }) => {
        if (!tool) {
            addCmd.help();
            return;
        }
        const { addCommand } = await import('./cli/commands/add.js');
        await addCommand(tool, { yes: options?.yes ?? false });
    });

addCmd.addHelpText(
    'after',
    `
Supported tools:
  latentcode      Write to latentcode.json
  claude-code     Configure via Claude Code CLI
  latent-code     Write to latent-code.json
  opencode        Write to opencode.json
  codex           Configure via Codex CLI
  copilot         Write to .vscode/mcp.json
  cursor          Write to .cursor/mcp.json
  droid           Configure via Factory-Droid CLI

Notes:
  lgraph add claude-code writes project guidance files after an explicit
  consent prompt. Use --yes only for automation or when approval is already given.

Examples:
  lgraph add claude-code
  lgraph add claude-code --yes
  lgraph add latentcode
  lgraph add copilot
  lgraph add cursor
  lgraph add latent-code
  lgraph add opencode
`,
);

// --- join ---
const joinCmd = program
    .command('join [source_branch] [user_branch_name]')
    .description('Join a collaboration project by copying DRG data from a source branch to your own branch')
    .option('-n, --project-name <name>', 'Specify the project name (required in non-interactive mode)')
    .option('-p, --public-id <id>', 'Join a publicly shared project by its share ID (read-only, no branch needed)')
    .action(async (sourceBranch?: string, userBranchName?: string, opts?: { projectName?: string; publicId?: string }) => {
        const { joinCommand } = await import('./cli/commands/join.js');
        // For public projects, branch args are not needed
        if (opts?.publicId) {
            await joinCommand({ publicId: opts.publicId });
        } else {
            await joinCommand({
                projectName: opts?.projectName,
                sourceBranch,
                userBranchName,
            });
        }
    });

joinCmd.addHelpText(
    'after',
    `
Details:
  Copies DRG data from an existing branch (e.g. "main") to create your own
  branch for independent updates. Requires contributor access to the project.

  With -p: joins a publicly shared project using the share ID from a
  public share URL (e.g. https://latentgraph.latentforce.ai/public/<ID>).
  No API key is required for public projects. Public join is read-only.

  No scanning or indexing is performed — the project is already
  indexed by its owner. After joining, run "lgraph update" to sync changes.

Arguments:
  [source_branch]      Branch to copy DRG data from (e.g. "main")
  [user_branch_name]   Name for your own branch (e.g. "johns-feature")

Examples:
  lgraph join main johns-feature                      Interactive project selection
  lgraph join main johns-feature -n "My Team's App"   Join specific project by name
  lgraph join -p dy1RdU2MIFu-NEM7kG75l                Join a public project (read-only)
`,
);

// --- config ---
const configCmd = program
    .command('config')
    .description('Manage Latentgraph configuration (URLs, API key)')
    .action(async () => {
        const { configCommand } = await import('./cli/commands/config.js');
        await configCommand('show');
    });

configCmd
    .command('show')
    .description('Display current configuration')
    .action(async () => {
        const { configCommand } = await import('./cli/commands/config.js');
        await configCommand('show');
    });

configCmd
    .command('set <key> [value]')
    .description('Set a configuration value')
    .addHelpText(
        'after',
        `
Keys:
  api-key    Your Latentgraph API key
  gh-token   GitHub token for PR insights (optional)
  api-url    Backend API URL
  orch-url   Orchestrator URL
  ws-url     WebSocket URL

Examples:
  lgraph config set api-key sk-abc123
  lgraph config set gh-token ghp_...
  lgraph config set api-url http://localhost:9000
  lgraph config set orch-url http://localhost:9999
`,
    )
    .action(async (key: string, value?: string) => {
        const { configCommand } = await import('./cli/commands/config.js');
        await configCommand('set', key, value);
    });

configCmd
    .command('clear [key]')
    .description('Clear a specific config key or all configuration')
    .addHelpText(
        'after',
        `
Keys:
  api-key    Clear the stored API key
  urls       Clear all custom URLs (revert to defaults)
  (none)     Clear all configuration (prompts for confirmation)

Examples:
  lgraph config clear api-key
  lgraph config clear urls
  lgraph config clear
`,
    )
    .action(async (key?: string) => {
        const { configCommand } = await import('./cli/commands/config.js');
        await configCommand('clear', key);
    });

configCmd.addHelpText(
    'after',
    `
Configurable keys:
  api-key    Your Latentgraph API key
  api-url    Backend API URL
  orch-url   Orchestrator URL
  ws-url     WebSocket URL

URLs can also be set via environment variables:
  LGRAPH_API_URL, LGRAPH_ORCH_URL, LGRAPH_WS_URL

Examples:
  lgraph config                                    Show config
  lgraph config set api-key sk-abc123              Set API key
  lgraph config set api-url http://localhost:9000   Set API URL
  lgraph config clear api-key                      Clear API key
  lgraph config clear                              Clear all config
`,
);

// --- merge ---
const mergeCmd = program
    .command('merge <source_branch> <target_branch>')
    .description('Merge DRG data between branches based on git divergence')
    .action(async (sourceBranch: string, targetBranch: string) => {
        const { mergeCommand } = await import('./cli/commands/merge.js');
        await mergeCommand({ sourceBranch, targetBranch });
    });

mergeCmd.addHelpText(
    'after',
    `
Details:
  Merges DRG/CodeWiki data between branches without re-computation.
  Analyzes git divergence to determine merge direction:

    - Only source has changes: copy source → target
    - Only target has changes: copy target → source
    - Both have changes: copy from branch with more changes,
      then remind to run 'lgraph update' on the smaller branch

  This is useful for syncing DRG data after git merges or when
  collaborators want to share indexed data between branches.

Arguments:
  <source_branch>    First branch for merge comparison
  <target_branch>    Second branch for merge comparison

Examples:
  lgraph merge main feature-branch    Sync DRG between main and feature branch
  lgraph merge dev staging            Sync DRG between dev and staging
`,
);

// --- branch ---
const branchCmd = program
    .command('branch')
    .description('List all branches for the current project')
    .option('-a, --all', 'Show detailed branch info (created date, source branch)')
    .action(async (options) => {
        const { branchCommand } = await import('./cli/commands/branch.js');
        await branchCommand({ all: options.all });
    });

branchCmd.addHelpText(
    'after',
    `
Details:
  Lists all DRG branches for the current project. The current branch
  is marked with an asterisk (*). Use -a for more details.

Examples:
  lgraph branch           List branches
  lgraph branch -a        List with details (created date, source)
`,
);

// --- checkout ---
const checkoutCmd = program
    .command('checkout [branch_name]')
    .description('Switch to a branch or create a new one')
    .option('-b, --branch', 'Create a new branch')
    .option('--from <source>', 'Source branch to copy from (with -b)')
    .action(async (branchName?: string, options?: { branch?: boolean; from?: string }) => {
        const { checkoutCommand } = await import('./cli/commands/checkout.js');
        await checkoutCommand(branchName, {
            branch: options?.branch,
            from: options?.from,
        });
    });

checkoutCmd.addHelpText(
    'after',
    `
Details:
  Switch between existing DRG branches or create new ones.
  Creating a branch copies all DRG data from the source branch.

Arguments:
  [branch_name]    Branch to switch to or create

Options:
  -b, --branch     Create a new branch instead of switching
  --from <source>  Source branch to copy from (defaults to current branch)

Examples:
  lgraph checkout main                    Switch to main branch
  lgraph checkout feature-auth            Switch to feature-auth branch
  lgraph checkout -b new-feature          Create branch from current
  lgraph checkout -b fix --from main      Create branch from main
`,
);

// --- push ---
const pushCmd = program
    .command('push [branch_name]')
    .description('Push a local branch to make it visible to team members')
    .action(async (branchName?: string) => {
        const { pushCommand } = await import('./cli/commands/push.js');
        await pushCommand(branchName);
    });

pushCmd.addHelpText(
    'after',
    `
Details:
  Pushes a local branch to the server, making it visible to other
  team members. Until pushed, only you can see the branch.

Arguments:
  [branch_name]    Branch to push (defaults to current branch)

Examples:
  lgraph push                Push current branch
  lgraph push my-feature     Push specific branch
`,
);

program.parse();
