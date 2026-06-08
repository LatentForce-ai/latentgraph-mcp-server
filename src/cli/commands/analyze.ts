import * as fsp from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getEncoding } from 'js-tiktoken';
import sloc from 'sloc';
import { getApiKey, readProjectConfig, writeProjectConfig, isReadOnlyProject } from '../../utils/config.js';
import { sendAnalyze, fetchListFiles, AnalyzePayload } from '../../utils/api-client.js';
import { collectFrameworks } from '../../utils/frameworks.js';
import { getProjectTree, categorizeFiles } from '../../utils/tree-scanner.js';

const execAsync = promisify(exec);

// ─── Supported languages (single source of truth) ──────────────────────────
//
// Each entry maps a file extension to:
//   - slocLang:    the language code recognized by the `sloc` library
//   - languageKey: a stable key used to group extensions for per-language summaries
//   - label:       human-readable name shown in CLI output
//
// To add a new extension, add a single row here.
interface LanguageInfo {
    slocLang: string;
    languageKey: string;
    label: string;
}

const SUPPORTED_LANGUAGES: Record<string, LanguageInfo> = {
    // JavaScript / TypeScript
    '.js':   { slocLang: 'js',   languageKey: 'js_ts',  label: 'JS/TS'  },
    '.jsx':  { slocLang: 'jsx',  languageKey: 'js_ts',  label: 'JS/TS'  },
    '.ts':   { slocLang: 'ts',   languageKey: 'js_ts',  label: 'JS/TS'  },
    '.tsx':  { slocLang: 'tsx',  languageKey: 'js_ts',  label: 'JS/TS'  },
    '.mjs':  { slocLang: 'js',   languageKey: 'js_ts',  label: 'JS/TS'  },
    '.cjs':  { slocLang: 'js',   languageKey: 'js_ts',  label: 'JS/TS'  },
    // Python
    '.py':   { slocLang: 'py',   languageKey: 'python', label: 'Python' },
    '.pyw':  { slocLang: 'py',   languageKey: 'python', label: 'Python' },
    // Java
    '.java': { slocLang: 'java', languageKey: 'java',   label: 'Java'   },
    // C
    '.c':    { slocLang: 'c',    languageKey: 'c',      label: 'C'      },
    // C++
    '.cpp':  { slocLang: 'cpp',  languageKey: 'cpp',    label: 'C++'    },
    '.cc':   { slocLang: 'cpp',  languageKey: 'cpp',    label: 'C++'    },
    '.cxx':  { slocLang: 'cpp',  languageKey: 'cpp',    label: 'C++'    },
    // C / C++ headers
    '.h':    { slocLang: 'h',    languageKey: 'cpp',    label: 'C/C++'  },
    '.hpp':  { slocLang: 'h',    languageKey: 'cpp',    label: 'C++'    },
    '.hxx':  { slocLang: 'h',    languageKey: 'cpp',    label: 'C++'    },
    '.hh':   { slocLang: 'h',    languageKey: 'cpp',    label: 'C++'    },
    // C#
    '.cs':   { slocLang: 'cs',   languageKey: 'csharp', label: 'C#'     },
    // Go
    '.go':   { slocLang: 'go',   languageKey: 'go',     label: 'Go'     },
    // Rust
    '.rs':   { slocLang: 'rs',   languageKey: 'rust',   label: 'Rust'   },
    // Ruby
    '.rb':   { slocLang: 'rb',   languageKey: 'ruby',   label: 'Ruby'   },
    '.rake': { slocLang: 'rb',   languageKey: 'ruby',   label: 'Ruby'   },
    // PHP
    '.php':  { slocLang: 'php',  languageKey: 'php',    label: 'PHP'    },
    '.php5': { slocLang: 'php',  languageKey: 'php',    label: 'PHP'    },
    // Swift
    '.swift':{ slocLang: 'swift',languageKey: 'swift',  label: 'Swift'  },
    // Kotlin
    '.kt':   { slocLang: 'kt',   languageKey: 'kotlin', label: 'Kotlin' },
    '.kts':  { slocLang: 'kt',   languageKey: 'kotlin', label: 'Kotlin' },
    // CSS / Web — must mirror tree-scanner.ts sourceExts (init uses the same list).
    '.css':  { slocLang: 'css',  languageKey: 'css',    label: 'CSS'    },
    '.scss': { slocLang: 'scss', languageKey: 'css',    label: 'CSS'    },
    '.html': { slocLang: 'html', languageKey: 'html',   label: 'HTML'   },
};

// Set of all supported extensions for quick lookup
const ALL_SUPPORTED_EXTENSIONS = new Set<string>(Object.keys(SUPPORTED_LANGUAGES));

// Initialize tiktoken encoder (cl100k_base is used by GPT-4 / Claude-class models)
const encoder = getEncoding('cl100k_base');

interface FileAnalysis {
    totalLines: number;
    codeLines: number;
    blankLines: number;
    commentLines: number;
    tokenCount: number;
}

/**
 * Analyze a file using sloc (industry-standard LOC counter).
 * Returns code/blank/comment line counts and token count.
 */
function analyzeFile(content: string, ext: string): FileAnalysis {
    const slocLang = SUPPORTED_LANGUAGES[ext].slocLang;

    // sloc returns: { total, source, comment, single, block, mixed, blockEmpty, empty, todo }
    // - total:   physical lines of code (excluding trailing newline)
    // - source:  lines containing code (may also have a trailing comment)
    // - comment: full-line comments (single + block)
    // - empty:   blank lines
    const stats = sloc(content, slocLang);

    // Token count using tiktoken (cl100k_base encoding)
    const tokenCount = encoder.encode(content).length;

    return {
        totalLines: stats.total,
        codeLines: stats.source,
        blankLines: stats.empty,
        commentLines: stats.comment,
        tokenCount,
    };
}

interface GitActivity {
    commits_by_date: Record<string, number>;
    commits_by_author: Record<string, number>;
    total_commits: number;
    date_range: { from: string; to: string };
}

interface CommitChurn {
    hash: string;
    date: string;          // YYYY-MM-DD
    author: string;
    added: number;
    deleted: number;
    net: number;
}

interface GitLocChurn {
    churn_by_date: Record<string, { added: number; deleted: number }>;
    per_commit: CommitChurn[];
    total_added: number;
    total_deleted: number;
}

/**
 * Collect git commit activity from the last year.
 * Uses null byte separator to handle author names containing '|'.
 * Excludes merge commits for cleaner activity data.
 */
async function collectGitActivity(projectRoot: string): Promise<GitActivity> {
    const activity: GitActivity = {
        commits_by_date: {},
        commits_by_author: {},
        total_commits: 0,
        date_range: { from: '', to: '' },
    };

    try {
        const { stdout } = await execAsync(
            'git log --no-merges --format="%H%x00%an%x00%aI" --since="1 year ago"',
            { cwd: projectRoot, maxBuffer: 10 * 1024 * 1024 }
        );

        if (!stdout.trim()) return activity;

        const lines = stdout.trim().split('\n');
        let earliestDate = '';
        let latestDate = '';

        for (const line of lines) {
            const parts = line.split('\x00');
            if (parts.length < 3) continue;

            const author = parts[1].trim();
            const dateStr = parts[2].trim();
            const date = dateStr.substring(0, 10); // YYYY-MM-DD

            activity.total_commits++;
            activity.commits_by_date[date] = (activity.commits_by_date[date] || 0) + 1;
            activity.commits_by_author[author] = (activity.commits_by_author[author] || 0) + 1;

            if (!earliestDate || date < earliestDate) earliestDate = date;
            if (!latestDate || date > latestDate) latestDate = date;
        }

        activity.date_range = { from: earliestDate, to: latestDate };
    } catch {
        // Not a git repo or git not available
    }

    return activity;
}

/**
 * Collect per-commit LOC churn (additions/deletions) for the last year.
 * Only counts changes to supported source file extensions.
 */
async function collectGitLocChurn(projectRoot: string): Promise<GitLocChurn> {
    const result: GitLocChurn = {
        churn_by_date: {},
        per_commit: [],
        total_added: 0,
        total_deleted: 0,
    };

    try {
        // %H hash, %an author, %aI ISO date, then --numstat gives per-file adds/dels
        // Separator "\x01" between commit header and numstat block, "\x02" as end-of-commit marker
        const { stdout } = await execAsync(
            'git log --no-merges --numstat --format="\x02%H\x01%an\x01%aI" --since="1 year ago"',
            { cwd: projectRoot, maxBuffer: 50 * 1024 * 1024 }
        );

        if (!stdout.trim()) return result;

        // Split on commit marker
        const commits = stdout.split('\x02').filter(c => c.trim().length > 0);

        for (const commitBlock of commits) {
            const lines = commitBlock.split('\n');
            const headerParts = lines[0].split('\x01');
            if (headerParts.length < 3) continue;

            const hash = headerParts[0].trim();
            const author = headerParts[1].trim();
            const dateStr = headerParts[2].trim();
            const date = dateStr.substring(0, 10);

            let commitAdded = 0;
            let commitDeleted = 0;

            // Parse numstat lines: "added\tdeleted\tfilepath"
            for (let i = 1; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;

                const parts = line.split('\t');
                if (parts.length < 3) continue;

                const addedStr = parts[0];
                const deletedStr = parts[1];
                const filePath = parts[2];

                // Skip binary files (git shows "-" for them)
                if (addedStr === '-' || deletedStr === '-') continue;

                // Only count supported extensions
                const ext = path.extname(filePath).toLowerCase();
                if (!ALL_SUPPORTED_EXTENSIONS.has(ext)) continue;

                commitAdded += parseInt(addedStr, 10) || 0;
                commitDeleted += parseInt(deletedStr, 10) || 0;
            }

            // Skip commits with no changes to source files
            if (commitAdded === 0 && commitDeleted === 0) continue;

            // Aggregate daily churn
            if (!result.churn_by_date[date]) {
                result.churn_by_date[date] = { added: 0, deleted: 0 };
            }
            result.churn_by_date[date].added += commitAdded;
            result.churn_by_date[date].deleted += commitDeleted;

            result.total_added += commitAdded;
            result.total_deleted += commitDeleted;

            result.per_commit.push({
                hash: hash.substring(0, 8),
                date,
                author,
                added: commitAdded,
                deleted: commitDeleted,
                net: commitAdded - commitDeleted,
            });

            // Stop parsing once we've collected the cap. `git log` is newest-first,
            // so the first 500 commits with source-file changes are the most recent.
            // This bounds memory on huge repos with hundreds of thousands of commits.
            if (result.per_commit.length >= 500) break;
        }
    } catch {
        // Not a git repo or git not available
    }

    return result;
}

export async function analyzeCommand(): Promise<void> {
    const projectRoot = process.cwd();

    // Block contributors and public viewers
    const { readOnly, reason } = isReadOnlyProject(projectRoot);
    if (readOnly) {
        const label = reason === 'contributor' ? 'contributor' : 'public (read-only) viewer';
        console.error(`❌ This project was joined as a ${label}.`);
        console.error('   Only the project owner can run "lgraph analyze".');
        console.error('   Remove .lgraph/config.json if you want to link this directory to your own project.');
        process.exit(1);
    }

    console.log('╔═══════════════════════════════════════════════╗');
    console.log('║            Analyzing Codebase                  ║');
    console.log('╚═══════════════════════════════════════════════╝\n');

    // Step 1: Check API key
    console.log('[Analyze] Step 1/4: Checking API key...');
    const apiKey = getApiKey();
    if (!apiKey) {
        console.error('\n❌ No API key found. Run "lgraph start" first to configure your project.\n');
        process.exit(1);
    }
    console.log('[Analyze] ✓ API key found\n');

    // Step 2: Read project config
    console.log('[Analyze] Step 2/4: Reading project configuration...');
    const projectConfig = readProjectConfig(projectRoot);
    if (!projectConfig?.project_id) {
        console.error('\n❌ No project configured for this directory.');
        console.log('Run "lgraph start" first to configure the project.\n');
        process.exit(1);
    }
    console.log(`[Analyze] ✓ Project: ${projectConfig.project_name} (${projectConfig.project_id})\n`);

    // Step 3: Scan and analyze files
    console.log('[Analyze] Step 3/4: Scanning and analyzing project files...');

    const treeData = await getProjectTree(projectRoot);
    if (treeData.file_count === 0) {
        throw new Error('No files found in this directory.');
    }

    // Use the backend's indexed file list when it matches the current commit.
    // If the user has made new commits since the last index, fall back to local
    // scanning so the analysis reflects the actual working tree.
    let supportedFiles: string[];
    let usingBackendIndex = false;
    try {
        const { stdout: branchStdout } = await execAsync('git branch --show-current', { cwd: projectRoot });
        const branch = branchStdout.trim() || projectConfig.default_branch || projectConfig.user_branch || 'main';

        // Compare current HEAD against the last file-index commit stored in config.
        // If they differ, the backend index is stale — use local files instead.
        let headCommit = '';
        try {
            const { stdout: headStdout } = await execAsync('git rev-parse HEAD', { cwd: projectRoot });
            headCommit = headStdout.trim();
        } catch { /* not a git repo */ }

        const lastIndexedCommit = projectConfig.file_index_last_commit || '';
        const indexIsCurrent = headCommit && lastIndexedCommit && headCommit === lastIndexedCommit;

        if (!indexIsCurrent) throw new Error('stale_or_unknown');

        const listed = await fetchListFiles(apiKey, projectConfig.project_id, branch);
        if (!Array.isArray(listed.files) || listed.files.length === 0) throw new Error('empty');
        supportedFiles = listed.files.filter(f => ALL_SUPPORTED_EXTENSIONS.has(path.extname(f).toLowerCase()));
        usingBackendIndex = true;
    } catch {
        supportedFiles = categorizeFiles(treeData.tree).source_files.filter(f => ALL_SUPPORTED_EXTENSIONS.has(path.extname(f).toLowerCase()));
    }

    console.log(`[Analyze]   Files: ${treeData.file_count}`);
    if (usingBackendIndex) {
        console.log(`[Analyze]   Source files: ${supportedFiles.length} (from backend index — matches LatentView)`);
    } else {
        console.log(`[Analyze]   Source files: ${supportedFiles.length} (local count — run "lgraph init" to index, then re-run for backend count)`);
    }

    if (supportedFiles.length === 0) {
        throw new Error(
            `No supported source files found in this directory.\n` +
            `   Supported extensions: ${[...ALL_SUPPORTED_EXTENSIONS].sort().join(', ')}`
        );
    }

    const locByExtension: Record<string, number> = {};
    const codeLinesByExtension: Record<string, number> = {};
    const blankLinesByExtension: Record<string, number> = {};
    const tokenCountByExtension: Record<string, number> = {};
    const commentCountByExtension: Record<string, number> = {};
    const fileCountByExtension: Record<string, number> = {};
    // Per-file LOC and token arrays — used by the frontend to plot sorted distribution curves.
    // filePathsByExtension is aligned by index to the above arrays so the frontend can filter
    // per-file values by folder prefix without another scan.
    const locPerFileByExtension: Record<string, number[]> = {};
    const tokenPerFileByExtension: Record<string, number[]> = {};
    const filePathsByExtension: Record<string, string[]> = {};
    let totalLoc = 0;
    let totalCodeLines = 0;
    let totalBlankLines = 0;
    let totalTokens = 0;
    let totalComments = 0;
    let readErrors = 0;

    // Read & analyze files in bounded-concurrency batches to avoid blocking the
    // event loop on large repos and to cap simultaneous file descriptors.
    const FILE_READ_CONCURRENCY = 32;
    for (let i = 0; i < supportedFiles.length; i += FILE_READ_CONCURRENCY) {
        const batch = supportedFiles.slice(i, i + FILE_READ_CONCURRENCY);

        const results = await Promise.all(batch.map(async (filePath) => {
            const absolutePath = path.join(projectRoot, filePath);
            const ext = path.extname(filePath).toLowerCase();
            try {
                const content = await fsp.readFile(absolutePath, 'utf-8');
                return { filePath, ext, analysis: analyzeFile(content, ext) };
            } catch {
                return { filePath, ext, analysis: null };
            }
        }));

        for (const { filePath, ext, analysis } of results) {
            if (!analysis) {
                readErrors++;
                continue;
            }
            locByExtension[ext] = (locByExtension[ext] || 0) + analysis.totalLines;
            codeLinesByExtension[ext] = (codeLinesByExtension[ext] || 0) + analysis.codeLines;
            blankLinesByExtension[ext] = (blankLinesByExtension[ext] || 0) + analysis.blankLines;
            tokenCountByExtension[ext] = (tokenCountByExtension[ext] || 0) + analysis.tokenCount;
            commentCountByExtension[ext] = (commentCountByExtension[ext] || 0) + analysis.commentLines;
            fileCountByExtension[ext] = (fileCountByExtension[ext] || 0) + 1;
            if (!locPerFileByExtension[ext]) locPerFileByExtension[ext] = [];
            locPerFileByExtension[ext].push(analysis.totalLines);
            if (!tokenPerFileByExtension[ext]) tokenPerFileByExtension[ext] = [];
            tokenPerFileByExtension[ext].push(analysis.tokenCount);
            if (!filePathsByExtension[ext]) filePathsByExtension[ext] = [];
            // Normalize to POSIX separators so the frontend folder filter works on any OS.
            filePathsByExtension[ext].push(filePath.split(path.sep).join('/'));

            totalLoc += analysis.totalLines;
            totalCodeLines += analysis.codeLines;
            totalBlankLines += analysis.blankLines;
            totalTokens += analysis.tokenCount;
            totalComments += analysis.commentLines;
        }
    }

    if (readErrors > 0) {
        console.log(`[Analyze]   ⚠️  Could not read ${readErrors} file(s)`);
    }

    // Print per-language summary by grouping extensions under their languageKey.
    // Each language is printed once with totals across all its extensions.
    interface LangTotals { label: string; files: number; loc: number; code: number; blank: number; comments: number; tokens: number; }
    const groupedByLang: Record<string, LangTotals> = {};
    for (const [ext, info] of Object.entries(SUPPORTED_LANGUAGES)) {
        const files = fileCountByExtension[ext] || 0;
        if (files === 0) continue;
        if (!groupedByLang[info.languageKey]) {
            groupedByLang[info.languageKey] = { label: info.label, files: 0, loc: 0, code: 0, blank: 0, comments: 0, tokens: 0 };
        }
        const g = groupedByLang[info.languageKey];
        g.files += files;
        g.loc += locByExtension[ext] || 0;
        g.code += codeLinesByExtension[ext] || 0;
        g.blank += blankLinesByExtension[ext] || 0;
        g.comments += commentCountByExtension[ext] || 0;
        g.tokens += tokenCountByExtension[ext] || 0;
    }
    for (const g of Object.values(groupedByLang)) {
        console.log(`[Analyze]   ${g.label}: ${g.files} files | ${g.loc} total lines (${g.code} code, ${g.blank} blank, ${g.comments} comment) | ${g.tokens} tokens`);
    }
    console.log(`[Analyze]   ─────────────────────────────────────────────`);
    console.log(`[Analyze]   Totals: ${supportedFiles.length - readErrors} files | ${totalLoc} total lines (${totalCodeLines} code, ${totalBlankLines} blank, ${totalComments} comment) | ${totalTokens} tokens\n`);

    // Step 4: Collect git activity
    console.log('[Analyze] Step 4/4: Collecting git activity...');
    const gitActivity = await collectGitActivity(projectRoot);

    if (gitActivity.total_commits > 0) {
        console.log(`[Analyze]   Total commits (last year): ${gitActivity.total_commits}`);
        console.log(`[Analyze]   Contributors: ${Object.keys(gitActivity.commits_by_author).length}`);
        console.log(`[Analyze]   Date range: ${gitActivity.date_range.from} → ${gitActivity.date_range.to}`);
    } else {
        console.log('[Analyze]   No git commits found (or not a git repository)');
    }

    // Collect per-commit LOC churn
    const gitLocChurn = await collectGitLocChurn(projectRoot);
    if (gitLocChurn.per_commit.length > 0) {
        console.log(`[Analyze]   Source code churn: +${gitLocChurn.total_added} / -${gitLocChurn.total_deleted} lines across ${gitLocChurn.per_commit.length} commits`);
    }
    console.log('');

    // Detect frameworks (deterministic — no LLM)
    console.log('[Analyze] Detecting frameworks...');
    const frameworks = await collectFrameworks(projectRoot);
    if (frameworks.length > 0) {
        // Group by language for readable output
        const byLang: Record<string, string[]> = {};
        for (const f of frameworks) {
            const k = f.language ?? 'Other';
            (byLang[k] = byLang[k] || []).push(f.name);
        }
        for (const [lang, names] of Object.entries(byLang)) {
            console.log(`[Analyze]   ${lang}: ${names.join(', ')}`);
        }
    } else {
        console.log('[Analyze]   No frameworks detected.');
    }
    console.log('');

    // Build a folder tree (depth 0/1/2) with file counts so the web UI can populate
    // the histogram's folder dropdown without re-computing from raw paths. Keys are
    // POSIX-style paths relative to project root; "" = root.
    const folderTree: Record<string, { file_count: number; depth: number }> = {
        '': { file_count: 0, depth: 0 },
    };
    for (const paths of Object.values(filePathsByExtension)) {
        for (const p of paths) {
            folderTree[''].file_count++;
            const segments = p.split('/');
            // Only build depth-1 and depth-2 buckets
            for (let d = 1; d <= Math.min(2, segments.length - 1); d++) {
                const folderKey = segments.slice(0, d).join('/');
                if (!folderTree[folderKey]) {
                    folderTree[folderKey] = { file_count: 0, depth: d };
                }
                folderTree[folderKey].file_count++;
            }
        }
    }

    // Send to backend
    console.log('[Analyze] Sending analysis results to backend...');

    const payload: AnalyzePayload = {
        project_id: projectConfig.project_id,
        loc_by_extension: locByExtension,
        code_lines_by_extension: codeLinesByExtension,
        blank_lines_by_extension: blankLinesByExtension,
        token_count_by_extension: tokenCountByExtension,
        comment_count_by_extension: commentCountByExtension,
        file_count_by_extension: fileCountByExtension,
        loc_per_file_by_extension: locPerFileByExtension,
        token_per_file_by_extension: tokenPerFileByExtension,
        file_paths_by_extension: filePathsByExtension,
        folder_tree: folderTree,
        git_activity: gitActivity,
        git_loc_churn: gitLocChurn,
        frameworks,
        total_loc: totalLoc,
        total_code_lines: totalCodeLines,
        total_blank_lines: totalBlankLines,
        total_tokens: totalTokens,
        total_comments: totalComments,
        total_files: supportedFiles.length - readErrors,
        analyzed_at: new Date().toISOString(),
    };

    try {
        const response = await sendAnalyze(apiKey, payload);
        console.log(`[Analyze] ✓ ${response.message}`);
    } catch (error) {
        console.error(`[Analyze] ❌ Failed to send results: ${(error as Error).message}`);
        process.exit(1);
    }

    // Persist last-analyzed timestamp so 'lgraph init' knows analyze has been run.
    // A failure to write the local config should NOT mark the analyze run as failed
    // — the backend already has the data.
    try {
        projectConfig.last_analyzed_at = payload.analyzed_at;
        writeProjectConfig(projectConfig, projectRoot);
    } catch (error) {
        console.warn(`[Analyze] ⚠️  Could not update local project config: ${(error as Error).message}`);
        console.warn('[Analyze]    Backend has the data, but auto-skip on init may not work next time.');
    }

    console.log('\n╔═══════════════════════════════════════════════╗');
    console.log('║         ✓ Analysis Complete                    ║');
    console.log('╚═══════════════════════════════════════════════╝');
    console.log('\nView results in the web dashboard under "Code Analysis".\n');
}
