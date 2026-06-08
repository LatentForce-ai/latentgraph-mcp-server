import { exec } from 'child_process';
import { promisify } from 'util';
import { readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { readProjectConfig, writeProjectConfig, isPublicProject, getUserBranch } from '../../utils/config.js';
import { sendUpdateDrg, type DrgUpdateLangStatus } from '../../utils/api-client.js';
import { pollProjectStatus } from '../../utils/poll-project-status.js';
import { resolveApiKey } from '../../utils/auth-resolver.js';
import { getProjectTree, categorizeFiles, extractAllFilePaths } from '../../utils/tree-scanner.js';
import { enforceLanguageSupport } from '../../utils/language-support.js';
import { detectGitChanges } from '../../utils/git-changes.js';

const execAsync = promisify(exec);

// Extension sets per language — used for both auto-detection and per-language change reporting
const LANG_EXTS: Record<string, string[]> = {
    javascript: ['js','jsx','ts','tsx','mjs','cjs'],
    python:     ['py','pyw'],
    go:         ['go'],
    php:        ['php'],
    java:       ['java'],
    cpp:        ['cpp','cc','cxx','h','hpp','hxx','hh'],
    c:          ['c'],
    csharp:     ['cs'],
    ruby:       ['rb','rake'],
    kotlin:     ['kt','kts'],
    swift:      ['swift'],
    rust:       ['rs'],
};

export interface UpdateDrgOptions {
    mode?: string;
}

export async function updateDrgCommand(options: UpdateDrgOptions = {}): Promise<void> {
    let mode = options.mode || 'incremental';

    if (mode !== 'baseline' && mode !== 'incremental') {
        console.error(`\n❌ Invalid mode: "${mode}". Must be "baseline" or "incremental".\n`);
        process.exit(1);
    }

    const projectRoot = process.cwd();

    // Block public viewers only - contributors can update their own branch
    if (isPublicProject(projectRoot)) {
        console.error('❌ This project was joined as a public (read-only) viewer.');
        console.error('   Public viewers cannot update the DRG.');
        console.error('   Remove .lgraph/config.json if you want to link this directory to your own project.');
        process.exit(1);
    }

    console.log(`\n[UpdateDRG] Mode: ${mode}`);

    // Step 1: Resolve API key
    const authResult = await resolveApiKey({
        interactive: !!process.stdin.isTTY,
        commandLabel: 'UpdateDRG',
    });
    const apiKey = authResult.apiKey;

    // Step 2: Read project config
    const projectConfig = readProjectConfig(projectRoot);
    if (!projectConfig?.project_id) {
        console.error('\n❌ No project configured. Run "lgraph init" first.\n');
        process.exit(1);
    }
    const projectId = projectConfig.project_id;
    const userBranchOrNull = getUserBranch(projectRoot);
    if (!userBranchOrNull) {
        console.error('\n❌ No branch configured in .lgraph/config.json — run "lgraph init" first.\n');
        process.exit(1);
    }
    const userBranch: string = userBranchOrNull;
    console.log(`[UpdateDRG] Project: ${projectId}`);
    console.log(`[UpdateDRG] Branch: ${userBranch}`);

    // Language-support gate: block (exit 1) when >50% of recognized code files
    // are in unsupported languages; warn and continue when some but <=50% are.
    const gateTree = await getProjectTree(projectRoot, { depth: 0 });
    enforceLanguageSupport(extractAllFilePaths(gateTree.tree), 'UpdateDRG');

    // Step 3: Read language(s) from scan_target.json, auto-detect if missing.
    // Multi-language projects (e.g. C++ + Kotlin) get one backend call per language
    // so every language's changed files reach the LLM extractor.
    let languages: string[] = [];
    const scanTargetPath = path.join(projectRoot, '.lgraph', 'scan_target.json');
    if (existsSync(scanTargetPath)) {
        try {
            const raw = readFileSync(scanTargetPath, 'utf-8');
            const parsed = JSON.parse(raw);
            const targets = Array.isArray(parsed) ? parsed : [parsed];
            for (const t of targets) {
                const lang = t?.language;
                if (lang && !languages.includes(lang)) languages.push(lang);
            }
        } catch { /* fall through to auto-detect */ }
    }
    if (languages.length === 0) {
        // Auto-detect ALL languages present — not just the top one.
        const treeData = await getProjectTree(projectRoot, { depth: 0 });
        const categorized = categorizeFiles(treeData.tree);
        const extCount: Record<string, number> = {};
        for (const f of categorized.source_files) {
            const ext = f.split('.').pop()?.toLowerCase() ?? '';
            extCount[ext] = (extCount[ext] ?? 0) + 1;
        }
        const countFor = (exts: string[]) => exts.reduce((s, e) => s + (extCount[e] ?? 0), 0);
        const counts = Object.entries(LANG_EXTS)
            .map(([lang, exts]) => ({ lang, n: countFor(exts) }))
            .sort((a, b) => b.n - a.n);
        const detected = counts.filter(c => c.n > 0);
        if (detected.length === 0) {
            languages = ['javascript'];
            console.log(`[UpdateDRG] No source files found — defaulting to javascript`);
        } else {
            languages = detected.map(c => c.lang);
            const primary = detected[0];
            const secondary = detected.slice(1);
            let msg = `[UpdateDRG] Language auto-detected: ${primary.lang} (${primary.n} files)`;
            if (secondary.length > 0) {
                msg += ` + ${secondary.map(c => `${c.lang} (${c.n})`).join(', ')}`;
            }
            console.log(msg);
        }
    }
    console.log(`[UpdateDRG] Language(s): ${languages.join(', ')}`);

    const MAX_FILE_SIZE_CHARS = 150000;
    let filesToSend: { file_path: string; content: string }[] = [];
    let changes = { added: [] as string[], modified: [] as string[], deleted: [] as string[] };

    // Check if this is a new branch that needs baseline data
    // If user_branch differs from default_branch and no prior commit exists for this branch,
    // we need to run baseline even if git shows no changes
    const isNewBranch = userBranch !== (projectConfig.default_branch || 'main') && !projectConfig.drg_last_indexed_commit;

    if (mode === 'incremental' && !isNewBranch) {
        // Step 4a: Detect changed files via git, diffing from last indexed commit
        const sinceCommit = projectConfig.drg_last_indexed_commit;
        if (sinceCommit) {
            console.log(`[UpdateDRG] Diffing from last indexed commit: ${sinceCommit.slice(0, 8)}`);
        } else {
            console.log('[UpdateDRG] No baseline commit stored — nothing to diff (run "lgraph init" first)');
        }
        changes = await detectGitChanges(projectRoot, sinceCommit);
        const { added, modified, deleted } = changes;
        console.log(`[UpdateDRG] Found: ${added.length} added, ${modified.length} modified, ${deleted.length} deleted`);
        // Per-language breakdown so users can see which language's files actually changed
        for (const lang of languages) {
            const exts = new Set(LANG_EXTS[lang] ?? []);
            const hasExt = (f: string) => exts.has(path.extname(f).toLowerCase().replace('.', ''));
            const la = added.filter(hasExt).length;
            const lm = modified.filter(hasExt).length;
            const ld = deleted.filter(hasExt).length;
            console.log(`[UpdateDRG]   ${lang}: ${la} added, ${lm} modified, ${ld} deleted`);
        }

        if (added.length === 0 && modified.length === 0 && deleted.length === 0) {
            console.log('\n✓ No changes detected — DRG is already up to date.\n');
            // Write null cost (no LLM ran) so update-all shows "—" instead of "$0.0000"
            try {
                const statsDir = path.join(projectRoot, '.lgraph', '.step-stats');
                mkdirSync(statsDir, { recursive: true });
                writeFileSync(path.join(statsDir, 'update-drg.json'), JSON.stringify({
                    step: 'update-drg', mode: 'noop',
                    elapsed_s: 0, cost_usd: null,
                }));
            } catch { /* non-fatal */ }
            return;
        }

        // Read content of added + modified files (skip directories — git status can report dirs)
        for (const filePath of [...added, ...modified]) {
            try {
                const absolutePath = path.join(projectRoot, filePath);
                if (!existsSync(absolutePath)) continue;
                if (statSync(absolutePath).isDirectory()) {
                    // git reported a whole directory (e.g. "?? somedir/") — expand it
                    const { stdout: dirFiles } = await execAsync(
                        `git ls-files --others --exclude-standard "${filePath.replace(/\/$/, '')}"`,
                        { cwd: projectRoot }
                    );
                    for (const nestedPath of dirFiles.split('\n').filter(Boolean)) {
                        try {
                            const nestedAbs = path.join(projectRoot, nestedPath);
                            if (existsSync(nestedAbs) && !statSync(nestedAbs).isDirectory()) {
                                const content = readFileSync(nestedAbs, 'utf-8');
                                filesToSend.push({
                                    file_path: nestedPath,
                                    content: content.length > MAX_FILE_SIZE_CHARS
                                        ? content.slice(0, MAX_FILE_SIZE_CHARS) + '\n/* ... truncated */'
                                        : content,
                                });
                            }
                        } catch { /* skip unreadable */ }
                    }
                    continue;
                }
                const content = readFileSync(absolutePath, 'utf-8');
                filesToSend.push({
                    file_path: filePath,
                    content: content.length > MAX_FILE_SIZE_CHARS
                        ? content.slice(0, MAX_FILE_SIZE_CHARS) + '\n/* ... truncated */'
                        : content,
                });
            } catch { /* skip unreadable files */ }
        }
        console.log(`[UpdateDRG] Read ${filesToSend.length} changed file(s) for re-analysis`);
    } else {
        // Step 4b: Baseline — read all source files
        // Also triggered for new branches to ensure dep_dependencies exists for the branch
        if (isNewBranch) {
            console.log(`[UpdateDRG] New branch "${userBranch}" — running baseline to initialize branch data`);
            mode = 'baseline';  // Ensure backend knows this is a baseline run
        }
        console.log('[UpdateDRG] Scanning all source files for baseline update...');
        const treeData = await getProjectTree(projectRoot, { depth: 0 });
        const categorized = categorizeFiles(treeData.tree);
        const filesToRead = categorized.source_files;
        for (const filePath of filesToRead) {
            try {
                const absolutePath = path.join(projectRoot, filePath);
                const content = readFileSync(absolutePath, 'utf-8');
                filesToSend.push({
                    file_path: filePath,
                    content: content.length > MAX_FILE_SIZE_CHARS
                        ? content.slice(0, MAX_FILE_SIZE_CHARS) + '\n/* ... truncated */'
                        : content,
                });
            } catch { /* skip */ }
        }
        console.log(`[UpdateDRG] Read ${filesToSend.length} source file(s)`);
    }

    // Step 5: Send to backend — one call per detected language.
    // filesToSend already contains ALL changed files; the backend filters by
    // each language's extensions, so the same payload works for every language.
    console.log(`[UpdateDRG] Sending to backend...`);
    let _allSucceeded = true;
    let _rawExtractionOk = true;
    let _totalElapsed = 0;
    let _totalCost: number | null = null;
    let _lastMessage = '';

    // Retry wrapper for the dispatch handshake. The DRG analysis itself runs
    // asynchronously server-side; this only covers transient errors on the
    // POST that triggers the background task.
    const MAX_DISPATCH_RETRIES = 5;
    async function sendWithRetry(
        sendFn: () => ReturnType<typeof sendUpdateDrg>,
        label: string,
    ): Promise<Awaited<ReturnType<typeof sendUpdateDrg>>> {
        for (let attempt = 1; attempt <= MAX_DISPATCH_RETRIES; attempt++) {
            try {
                return await sendFn();
            } catch (err) {
                const msg = (err as Error).message ?? '';
                const isRateLimit  = msg.includes('rate_limit') || msg.includes('Too many requests');
                const isInProgress = msg.includes('already in progress');
                const isFetchFail  = msg.toLowerCase().includes('fetch failed');
                const isRetriable  = isRateLimit || isInProgress || isFetchFail;

                if (!isRetriable || attempt >= MAX_DISPATCH_RETRIES) throw err;

                if (isRateLimit) {
                    const match = msg.match(/retry_after_seconds["'\s:]+(\d+)/);
                    const waitSecs = match ? parseInt(match[1], 10) : 60;
                    console.log(`  [${label}] ⏳ Rate limited — waiting ${waitSecs}s (attempt ${attempt}/${MAX_DISPATCH_RETRIES})...`);
                    await new Promise(r => setTimeout(r, waitSecs * 1000));
                } else if (isInProgress) {
                    console.log(`  [${label}] ⏳ Previous DRG run still completing — waiting 30s (attempt ${attempt}/${MAX_DISPATCH_RETRIES})...`);
                    await new Promise(r => setTimeout(r, 30_000));
                } else {
                    console.log(`  [${label}] ⚠️  Dispatch dropped — retrying in 15s (attempt ${attempt}/${MAX_DISPATCH_RETRIES})...`);
                    await new Promise(r => setTimeout(r, 15_000));
                }
            }
        }
        throw new Error('unreachable');
    }

    async function pollDrgUntilDone(lang: string): Promise<DrgUpdateLangStatus> {
        const langKey = lang.toLowerCase();
        let lastLoggedSec = -30;
        const result = await pollProjectStatus<DrgUpdateLangStatus | undefined>(
            apiKey, projectId, userBranch,
            {
                extract: s => s.drg_update?.[langKey],
                isTerminal: v => v?.status === 'completed' || v?.status === 'failed',
                onTick: (elapsedS, v) => {
                    if (elapsedS - lastLoggedSec >= 30) {
                        console.log(`  [${lang}] ⏳ Waiting... (status=${v?.status ?? 'starting'}, ${elapsedS}s elapsed)`);
                        lastLoggedSec = elapsedS;
                    }
                },
            },
        );
        // isTerminal only returns true when result is defined → safe non-null assertion
        return result!;
    }

    // Process languages sequentially — avoids backend lock contention and LLM rate-limit
    // bursts when multiple languages share the same Gemini/OpenRouter quota.
    type LangResult = { elapsed_s: number | null; cost_usd: number | null; rawExtractionOk: boolean; succeeded: boolean; lastMessage: string };

    function noBaselineFromMessage(msg: string | undefined | null): boolean {
        const m = (msg ?? '').toLowerCase();
        return m.includes('symbol_table') || m.includes('mode=baseline');
    }

    async function dispatchAndPoll(
        lang: string,
        runMode: string,
        runChanges: { added: string[]; modified: string[]; deleted: string[] },
        runFiles: { file_path: string; content: string }[],
    ): Promise<DrgUpdateLangStatus> {
        await sendWithRetry(() => sendUpdateDrg(apiKey, {
            project_id: projectId,
            language: lang,
            mode: runMode,
            changes: runChanges,
            files: runFiles,
            branch: userBranch,
            umbrella_id: process.env.LGRAPH_UMBRELLA_ID || undefined,
        }), lang);
        return await pollDrgUntilDone(lang);
    }

    async function processOneLang(lang: string): Promise<LangResult> {
        const out: LangResult = { elapsed_s: null, cost_usd: null, rawExtractionOk: true, succeeded: true, lastMessage: '' };
        if (languages.length > 1) console.log(`[UpdateDRG] → Processing: ${lang}`);
        try {
            let result = await dispatchAndPoll(lang, mode, changes, filesToSend);

            // Auto-fallback: incremental with no prior baseline → full baseline scan.
            if (
                result.status === 'failed'
                && mode === 'incremental'
                && noBaselineFromMessage(result.message)
            ) {
                console.log(`  [${lang}] ⚠️  No baseline found — running full baseline scan...`);
                const treeData = await getProjectTree(projectRoot, { depth: 0 });
                const categorized = categorizeFiles(treeData.tree);
                const baselineFiles: { file_path: string; content: string }[] = [];
                for (const fp of categorized.source_files) {
                    try {
                        const abs = path.join(projectRoot, fp);
                        const content = readFileSync(abs, 'utf-8');
                        baselineFiles.push({
                            file_path: fp,
                            content: content.length > MAX_FILE_SIZE_CHARS
                                ? content.slice(0, MAX_FILE_SIZE_CHARS) + '\n/* ... truncated */'
                                : content,
                        });
                    } catch { /* skip */ }
                }
                console.log(`  [${lang}] Baseline scan: ${baselineFiles.length} file(s)`);
                result = await dispatchAndPoll(
                    lang,
                    'baseline',
                    { added: [], modified: [], deleted: [] },
                    baselineFiles,
                );
            }

            if (result.status === 'completed') {
                out.elapsed_s = result.elapsed_s ?? null;
                out.cost_usd  = result.cost_usd  ?? null;
                // Don't propagate raw_extraction_ok=false from a baseline rebuild —
                // a baseline always builds a valid symbol_table, so the commit hash
                // must be saved. Blocking it here causes an infinite re-baseline loop.
                if (result.mode !== 'full' && result.raw_extraction_ok === false) {
                    out.rawExtractionOk = false;
                }
                out.lastMessage = result.message ?? '';
                if (languages.length > 1) console.log(`  [${lang}] ${result.message ?? 'completed'}`);
            } else {
                console.error(`\n❌ DRG update failed for ${lang}: ${result.message ?? 'unknown'}`);
                out.succeeded = false;
            }
        } catch (error) {
            console.error(`\n❌ Failed to update DRG for ${lang}: ${(error as Error).message}`);
            out.succeeded = false;
        }
        return out;
    }

    for (const lang of languages) {
        const r = await processOneLang(lang);
        if (r.elapsed_s != null) _totalElapsed += r.elapsed_s;
        if (r.cost_usd  != null) _totalCost = (_totalCost ?? 0) + r.cost_usd;
        if (!r.rawExtractionOk) _rawExtractionOk = false;
        if (!r.succeeded) _allSucceeded = false;
        if (r.lastMessage) _lastMessage = r.lastMessage;
    }

    if (_allSucceeded) {
        // Store the current HEAD so next incremental diff starts from here.
        // Skip if any language's raw extraction cache failed to persist.
        try {
            const { stdout: headHash } = await execAsync('git rev-parse HEAD', { cwd: projectRoot });
            if (!_rawExtractionOk) {
                console.warn('[UpdateDRG] ⚠️  Raw extraction cache failed to persist — skipping commit hash update to force full re-analysis on next run');
            } else {
                projectConfig.drg_last_indexed_commit = headHash.trim();
                writeProjectConfig(projectConfig, projectRoot);
            }
        } catch { /* not a git repo — skip */ }

        const drgElapsed = _totalElapsed > 0 ? _totalElapsed : null;
        const drgCost    = _totalCost;
        console.log('\n╔═══════════════════════════════════════════════╗');
        console.log('║        ✓ DRG Update Complete                  ║');
        console.log('╚═══════════════════════════════════════════════╝');
        if (languages.length === 1) console.log(`\n${_lastMessage}`);
        console.log(`\nStats: ${changes.added.length} added, ${changes.modified.length} modified, ${changes.deleted.length} deleted`);
        if (drgElapsed != null) console.log(`  Elapsed          : ${drgElapsed.toFixed(1)}s`);
        if (drgCost    != null) console.log(`  LLM cost         : $${drgCost.toFixed(4)}`);
        console.log('');
        // Write step stats so update-all can include them in the summary table
        try {
            const statsDir = path.join(projectRoot, '.lgraph', '.step-stats');
            mkdirSync(statsDir, { recursive: true });
            writeFileSync(path.join(statsDir, 'update-drg.json'), JSON.stringify({
                step: 'update-drg', mode: mode === 'baseline' ? 'full' : 'delta',
                elapsed_s: drgElapsed, cost_usd: drgCost,
            }));
        } catch { /* non-fatal */ }
    } else {
        process.exit(1);
    }
}
