import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

// Matching extension's file-tools.js exclude patterns.
// Matched by EXACT name against each entry (dir or file). Substring match was
// removed because it killed monorepo source dirs like `packages/` (npm/pnpm
// workspaces) and source files like `build.ts` or `env-config.ts`.
const DEFAULT_EXCLUDE_PATTERNS = [
    // --- General ---
    '.git',
    '.vscode',
    '.idea',
    '.lgraph',

    // --- Python ---
    '__pycache__',
    '.pytest_cache',
    '.mypy_cache',
    '.tox',
    'htmlcov',
    'venv',
    '.venv',
    'env',
    '.eggs',
    'site-packages',

    // --- JavaScript / TypeScript ---
    'node_modules',
    'dist',
    'build',
    '.next',
    '.cache',
    '.turbo',
    '.parcel-cache',
    '.nyc_output',
    'coverage',

    // --- C++ ---
    'CMakeFiles',
    'cmake-build-debug',
    'cmake-build-release',
    '.cmake',

    // --- C# / .NET ---
    // 'packages' intentionally omitted: legacy NuGet uses it, but every npm/pnpm
    // workspace stores its source there. The binary NuGet artifacts inside are
    // already filtered by SKIP_FILE_EXTENSIONS (.dll, .nupkg, etc.).
    'bin',
    'obj',
    '.vs',
    'TestResults',
    'publish',
];

// File-name PREFIXES to exclude. Keeps `.env`, `.env.local`, `.env.production`
// out of the scan without resorting to substring matching on every entry.
const EXCLUDE_FILE_PREFIXES = ['.env'];

// File extensions to skip — binaries, compiled output, images, archives, lock files
const SKIP_FILE_EXTENSIONS = new Set([
    // Compiled / bytecode
    '.pyc', '.pyo', '.pyd', '.class', '.o', '.obj', '.a', '.lib',
    '.so', '.dylib', '.dll', '.exe', '.out', '.wasm',
    // Archives
    '.zip', '.tar', '.gz', '.bz2', '.xz', '.rar', '.7z', '.jar', '.war', '.egg', '.whl',
    // Images
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.bmp', '.tiff', '.webp', '.avif',
    // Fonts
    '.ttf', '.otf', '.woff', '.woff2', '.eot',
    // Media
    '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.flv', '.webm',
    // Documents / data blobs
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    // Misc binary
    '.bin', '.dat', '.db', '.sqlite', '.sqlite3',
    // Maps / minified (generated)
    '.map', '.min.js', '.min.css',
]);

// Specific filenames to skip (lock files, generated manifests)
const SKIP_FILE_NAMES = new Set([
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'Pipfile.lock',
    'poetry.lock',
    'composer.lock',
    'Gemfile.lock',
    'cargo.lock',
    'packages.lock.json',
]);



// Matching extension's file structure
export interface FileNode {
    name: string;
    type: 'file' | 'directory';
    path: string;
    depth: number;
    children?: FileNode[];
    // File-specific fields
    size?: number;
    extension?: string;
    modified?: Date;
}

export interface ProjectTreeResult {
    status: 'success';
    tree: FileNode[];
    file_count: number;
    dir_count: number;
    total_size_bytes: number;
    total_size_mb: string;
    scanned_from: string;
    depth_limit: number;
    actual_max_depth: string;
    excluded_patterns: string[];
}

export interface ProjectPathsResult {
    status: 'success';
    files: string[];
    file_count: number;
    dir_count: number;
    scanned_from: string;
    depth_limit: number;
    excluded_patterns: string[];
}

export interface ScanOptions {
    depth?: number;
    exclude_patterns?: string[];
    format?: 'tree' | 'paths';
}

const SCAN_PROGRESS_INTERVAL = 5000;

export function getProjectTree(workspaceRoot: string, options?: ScanOptions & { format?: 'tree' }): Promise<ProjectTreeResult>;
export function getProjectTree(workspaceRoot: string, options: ScanOptions & { format: 'paths' }): Promise<ProjectPathsResult>;
export async function getProjectTree(
    workspaceRoot: string,
    options: ScanOptions = {}
): Promise<ProjectTreeResult | ProjectPathsResult> {
    const {
        depth = 0,
        exclude_patterns = DEFAULT_EXCLUDE_PATTERNS,
        format = 'tree',
    } = options;

    const max_depth = depth === 0 ? Infinity : depth;
    const want_tree = format === 'tree';

    let file_count = 0;
    let dir_count = 0;
    let total_size = 0;
    const flat_paths: string[] = [];

    async function scanDirectory(dirPath: string, currentDepth: number, relativePath: string): Promise<FileNode[]> {
        if (currentDepth >= max_depth) {
            return [];
        }

        let entries: fs.Dirent[];
        try {
            entries = await fsp.readdir(dirPath, { withFileTypes: true });
        } catch (err) {
            console.error(`[tree-scanner] Error scanning ${dirPath}: ${(err as Error).message}`);
            return [];
        }

        const items: FileNode[] = [];

        for (const entry of entries) {
            if (entry.isSymbolicLink()) {
                continue;
            }
            // Only apply exclude patterns to DIRECTORIES with EXACT match
            // (not substring match on file names - that incorrectly skips files like "CombinedChart.java" due to "bin" pattern)
            if (entry.isDirectory() && exclude_patterns.includes(entry.name)) {
                continue;
            }
            // File-name prefix excludes (e.g. `.env`, `.env.local`, `.env.production`).
            if (entry.isFile() && EXCLUDE_FILE_PREFIXES.some(p => entry.name.startsWith(p))) {
                continue;
            }

            const itemPath = path.join(dirPath, entry.name);
            const itemRelativePath = relativePath ? path.join(relativePath, entry.name) : entry.name;
            const normalizedPath = itemRelativePath.replace(/\\/g, '/');

            if (entry.isDirectory()) {
                dir_count++;
                const children = await scanDirectory(itemPath, currentDepth + 1, itemRelativePath);
                if (want_tree) {
                    items.push({
                        name: entry.name,
                        type: 'directory',
                        path: normalizedPath,
                        depth: currentDepth,
                        children,
                    });
                }
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (SKIP_FILE_EXTENSIONS.has(ext) || SKIP_FILE_NAMES.has(entry.name)) {
                    continue;
                }
                file_count++;
                if (file_count % SCAN_PROGRESS_INTERVAL === 0) {
                    console.log(`[tree-scanner] …scanned ${file_count} files so far`);
                }

                if (!want_tree) {
                    flat_paths.push(normalizedPath);
                    continue;
                }

                try {
                    const stats = await fsp.stat(itemPath);
                    total_size += stats.size;
                    items.push({
                        name: entry.name,
                        type: 'file',
                        path: normalizedPath,
                        depth: currentDepth,
                        size: stats.size,
                        extension: ext,
                        modified: stats.mtime,
                    });
                } catch {
                    // unreadable file — skip
                }
            }
        }

        return items;
    }

    const tree = await scanDirectory(workspaceRoot, 0, '');

    if (want_tree) {
        const total_size_mb = (total_size / (1024 * 1024)).toFixed(2);
        return {
            status: 'success',
            tree,
            file_count,
            dir_count,
            total_size_bytes: total_size,
            total_size_mb,
            scanned_from: workspaceRoot,
            depth_limit: depth,
            actual_max_depth: depth === 0 ? 'unlimited' : String(depth),
            excluded_patterns: exclude_patterns,
        };
    }

    return {
        status: 'success',
        files: flat_paths,
        file_count,
        dir_count,
        scanned_from: workspaceRoot,
        depth_limit: depth,
        excluded_patterns: exclude_patterns,
    };
}

/**
 * Extract all file paths from tree structure
 * Matching extension's extractAllFilePaths function
 */
export function extractAllFilePaths(tree: FileNode[], basePath: string = ''): string[] {
    let files: string[] = [];

    for (const item of tree) {
        const itemPath = basePath ? `${basePath}/${item.name}` : item.name;

        if (item.type === 'file') {
            files.push(itemPath);
        } else if (item.type === 'directory' && item.children) {
            files = files.concat(extractAllFilePaths(item.children, itemPath));
        }
    }

    return files;
}

/**
 * Categorize files by type
 * Matching extension's categorizeFiles function
 */
/**
 * Count total lines of code across all project files
 */
export function countProjectLOC(rootPath: string, filePaths: string[]): number {
    let totalLOC = 0;

    for (const filePath of filePaths) {
        try {
            const fullPath = path.join(rootPath, filePath);
            const content = fs.readFileSync(fullPath, 'utf-8');
            totalLOC += content.split('\n').length;
        } catch {
            // Skip binary/unreadable files
        }
    }

    return totalLOC;
}

export function categorizeFiles(tree: FileNode[], basePath: string = ''): {
    source_files: string[];
    config_files: string[];
    asset_files: string[];
} {
    const categories = {
        source_files: [] as string[],
        config_files: [] as string[],
        asset_files: [] as string[],
    };

    const sourceExts = [
        '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
        '.py', '.pyw', '.java', '.cpp', '.cc', '.cxx', '.cs', '.go',
        '.c', '.h', '.hpp', '.hxx', '.hh',
        '.css', '.scss', '.html',
        '.rb', '.rake', '.swift', '.rs', '.php', '.kt', '.kts',
    ];
    const configExts = ['.json', '.yaml', '.yml', '.toml', '.ini', '.config', '.xml'];
    const assetExts = ['.png', '.jpg', '.jpeg', '.svg', '.gif', '.css', '.scss', '.less', '.sass'];

    for (const item of tree) {
        const itemPath = basePath ? `${basePath}/${item.name}` : item.name;

        if (item.type === 'file') {
            const ext = path.extname(item.name).toLowerCase();

            if (sourceExts.includes(ext)) {
                categories.source_files.push(itemPath);
            } else if (configExts.includes(ext)) {
                categories.config_files.push(itemPath);
            } else if (assetExts.includes(ext)) {
                categories.asset_files.push(itemPath);
            }
        } else if (item.type === 'directory' && item.children) {
            const subCategories = categorizeFiles(item.children, itemPath);
            categories.source_files.push(...subCategories.source_files);
            categories.config_files.push(...subCategories.config_files);
            categories.asset_files.push(...subCategories.asset_files);
        }
    }

    return categories;
}
