/**
 * Tools Executor for MCP
 * Handles execution of local file tools matching extension's tools-executor.js
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getProjectTree as scanProjectTree } from '../utils/tree-scanner.js';

const execAsync = promisify(exec);

export interface ToolResult {
    status: 'success' | 'error' | 'denied';
    [key: string]: any;
}

export class ToolsExecutor {
    private wsClient: any;
    private workspaceRoot: string;
    private tools: Record<string, (params: any) => Promise<ToolResult>>;

    constructor(wsClient: any, workspaceRoot: string) {
        this.wsClient = wsClient;
        this.workspaceRoot = workspaceRoot;

        this.tools = {
            'get_tree_struct': this.getTreeStruct.bind(this),
            'read_file': this.readFile.bind(this),
            'read_files': this.readFiles.bind(this),
            'get_file_info': this.getFileInfo.bind(this),
            'get_repository_root': this.getRepositoryRoot.bind(this),
            'get_project_tree': this.getProjectTree.bind(this),
            'execute_command': this.executeCommand.bind(this),
            'run_bash': this.runBash.bind(this),
            'glob_search': this.globSearch.bind(this),
            'grep_search': this.grepSearch.bind(this),
        };
    }

    /**
     * Execute a tool by name
     */
    async executeTool(toolName: string, params: any): Promise<ToolResult> {
        console.log(`[ToolsExecutor] Executing: ${toolName}`);
        console.log(`[ToolsExecutor] Params:`, JSON.stringify(params, null, 2));

        if (!this.tools[toolName]) {
            throw new Error(`Unknown tool: ${toolName}`);
        }

        try {
            const result = await this.tools[toolName](params);
            console.log(`[ToolsExecutor] ✓ ${toolName} completed`);
            return result;
        } catch (error) {
            console.error(`[ToolsExecutor] ✗ ${toolName} failed:`, error);
            throw error;
        }
    }

    /**
     * Get available tool names
     */
    getAvailableTools(): string[] {
        return Object.keys(this.tools);
    }

    /**
     * Execute command (with auto-approval for MCP - no UI)
     */
    async executeCommand(params: any): Promise<ToolResult> {
        const { command, working_directory = '.' } = params;

        if (!command) {
            return {
                status: 'error',
                error: 'command is required'
            };
        }

        console.log(`[ToolsExecutor] Executing command: ${command}`);

        const fullWorkingDir = path.join(this.workspaceRoot, working_directory);

        try {
            const { stdout, stderr } = await execAsync(command, {
                cwd: fullWorkingDir,
                timeout: 30000,
                maxBuffer: 1024 * 1024
            });

            return {
                status: 'success',
                command: command,
                working_directory: working_directory,
                stdout: stdout,
                stderr: stderr,
                exit_code: 0
            };

        } catch (error: any) {
            return {
                status: 'error',
                command: command,
                working_directory: working_directory,
                stdout: error.stdout || '',
                stderr: error.stderr || '',
                exit_code: error.code || 1,
                error_message: error.message
            };
        }
    }

    /**
     * Get tree structure of a directory
     */
    async getTreeStruct(params: any): Promise<ToolResult> {
        const {
            target_path = params.path || '.',
            depth = 3,
            exclude_patterns = ['.git', 'node_modules', '__pycache__', '.vscode', 'dist', 'build']
        } = params;

        const fullPath = path.join(this.workspaceRoot, target_path);

        let file_count = 0;
        let dir_count = 0;
        let total_size = 0;

        const scanDirectory = async (dirPath: string, currentDepth: number = 0, relativePath: string = ''): Promise<any[]> => {
            if (currentDepth >= depth) {
                return [];
            }

            const items: any[] = [];

            try {
                const entries = await fs.readdir(dirPath, { withFileTypes: true });

                for (const entry of entries) {
                    if (exclude_patterns.some((pattern: string) => entry.name.includes(pattern))) {
                        continue;
                    }

                    const itemPath = path.join(dirPath, entry.name);
                    const itemRelativePath = path.join(relativePath, entry.name);

                    if (entry.isDirectory()) {
                        dir_count++;
                        const children = await scanDirectory(itemPath, currentDepth + 1, itemRelativePath);
                        items.push({
                            name: entry.name,
                            type: 'directory',
                            path: itemRelativePath,
                            children: children
                        });
                    } else if (entry.isFile()) {
                        file_count++;
                        try {
                            const stats = await fs.stat(itemPath);
                            total_size += stats.size;
                            items.push({
                                name: entry.name,
                                type: 'file',
                                path: itemRelativePath,
                                size: stats.size
                            });
                        } catch {
                            // Skip files we can't read
                        }
                    }
                }
            } catch (err: any) {
                console.error(`Error scanning ${dirPath}:`, err.message);
            }

            return items;
        };

        const tree = await scanDirectory(fullPath, 0, target_path);

        return {
            status: 'success',
            tree: tree,
            file_count: file_count,
            dir_count: dir_count,
            total_size: `${(total_size / (1024 * 1024)).toFixed(2)} MB`,
            scanned_path: target_path,
            workspace_root: this.workspaceRoot
        };
    }

    /**
     * Read file contents
     */
    async readFile(params: any): Promise<ToolResult> {
        const { file_path } = params;

        if (!file_path) {
            return {
                status: 'error',
                error: 'file_path is required'
            };
        }

        console.log(`[ToolsExecutor] Reading file: ${file_path}`);

        try {
            const fullPath = path.join(this.workspaceRoot, file_path);
            const content = await fs.readFile(fullPath, 'utf8');
            const stats = await fs.stat(fullPath);

            return {
                status: 'success',
                file_path: file_path,
                content: content,
                size: stats.size,
                lines: content.split('\n').length
            };
        } catch (error: any) {
            return {
                status: 'error',
                file_path: file_path,
                error: error.message
            };
        }
    }

    /**
     * Read many files in a single tool call.
     *
     * Designed for pipeline bulk-ingest: the orchestrator sends paths in
     * batches (e.g. 500 at a time) instead of issuing one tool request per
     * file. This collapses ~100k HTTP→WS round-trips into ~200 for a large
     * repo. Each file read still goes through a local fs.readFile — we just
     * amortize the transport cost. Per-file failures are reported in the
     * `errors` array; the overall call succeeds as long as the request was
     * well-formed.
     */
    async readFiles(params: any): Promise<ToolResult> {
        const file_paths: string[] = Array.isArray(params?.file_paths) ? params.file_paths : [];

        if (file_paths.length === 0) {
            return {
                status: 'error',
                error: 'file_paths must be a non-empty array'
            };
        }

        console.log(`[ToolsExecutor] Reading ${file_paths.length} files (batch)`);

        const files: Array<{ file_path: string; content: string; size: number; lines: number }> = [];
        const errors: Array<{ file_path: string; error: string }> = [];

        const results = await Promise.allSettled(
            file_paths.map(async (fp) => {
                const fullPath = path.join(this.workspaceRoot, fp);
                const content = await fs.readFile(fullPath, 'utf8');
                const stats = await fs.stat(fullPath);
                return {
                    file_path: fp,
                    content,
                    size: stats.size,
                    lines: content.split('\n').length,
                };
            })
        );

        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            if (r.status === 'fulfilled') {
                files.push(r.value);
            } else {
                const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
                errors.push({ file_path: file_paths[i], error: msg });
            }
        }

        console.log(`[ToolsExecutor] ✓ read_files: ${files.length} ok, ${errors.length} failed`);

        return {
            status: 'success',
            files,
            errors,
            files_read: files.length,
            files_failed: errors.length,
        };
    }

    /**
     * Get file info
     */
    async getFileInfo(params: any): Promise<ToolResult> {
        const { file_path } = params;

        if (!file_path) {
            return {
                status: 'error',
                error: 'file_path is required'
            };
        }

        try {
            const fullPath = path.join(this.workspaceRoot, file_path);
            const stats = await fs.stat(fullPath);

            return {
                status: 'success',
                file_path: file_path,
                size: stats.size,
                created: stats.birthtime,
                modified: stats.mtime,
                is_directory: stats.isDirectory()
            };
        } catch (error: any) {
            return {
                status: 'error',
                file_path: file_path,
                error: error.message
            };
        }
    }

    /**
     * Get repository root directory
     */
    async getRepositoryRoot(params: any): Promise<ToolResult> {
        const { start_path = '.' } = params;

        console.log(`[ToolsExecutor] Finding repository root from: ${start_path}`);

        let currentPath = path.join(this.workspaceRoot, start_path);

        try {
            const stats = await fs.stat(currentPath);
            if (stats.isFile()) {
                currentPath = path.dirname(currentPath);
            }
        } catch {
            currentPath = this.workspaceRoot;
        }

        let searchPath = currentPath;
        const maxDepth = 20;
        let depth = 0;

        while (depth < maxDepth) {
            try {
                const gitPath = path.join(searchPath, '.git');
                await fs.access(gitPath);

                const entries = await fs.readdir(searchPath);
                const has_package_json = entries.includes('package.json');
                const has_requirements_txt = entries.includes('requirements.txt');
                const has_cargo_toml = entries.includes('Cargo.toml');
                const has_go_mod = entries.includes('go.mod');

                let project_type = 'unknown';
                if (has_package_json) project_type = 'node';
                else if (has_requirements_txt) project_type = 'python';
                else if (has_cargo_toml) project_type = 'rust';
                else if (has_go_mod) project_type = 'go';

                return {
                    status: 'success',
                    repository_root: searchPath,
                    relative_to_workspace: path.relative(this.workspaceRoot, searchPath),
                    has_git: true,
                    project_type: project_type,
                    files_in_root: entries.length
                };

            } catch {
                const parentPath = path.dirname(searchPath);

                if (parentPath === searchPath) {
                    return {
                        status: 'success',
                        repository_root: null,
                        has_git: false,
                        message: 'No .git folder found in any parent directory'
                    };
                }

                searchPath = parentPath;
                depth++;
            }
        }

        return {
            status: 'success',
            repository_root: null,
            has_git: false,
            message: `No .git folder found after searching ${maxDepth} levels up`
        };
    }

    /**
     * Returns combined output matching tools.py's run_bash format.
     */
    async runBash(params: any): Promise<ToolResult> {
        const { command } = params;

        if (!command) {
            return { status: 'error', error: 'command is required' };
        }

        console.log(`[ToolsExecutor] run_bash: ${command}`);

        try {
            const { stdout, stderr } = await execAsync(command, {
                cwd: this.workspaceRoot,
                timeout: 30000,
                maxBuffer: 1024 * 1024,
            });

            let output = stdout;
            if (stderr) output += `\n[STDERR]\n${stderr}`;

            return {
                status: 'success',
                output: output.trim() || '[No output]',
            };
        } catch (error: any) {
            let output = error.stdout || '';
            if (error.stderr) output += `\n[STDERR]\n${error.stderr}`;
            output += `\n[EXIT CODE: ${error.code || 1}]`;

            return {
                status: 'error',
                output: output.trim(),
                error: error.message,
            };
        }
    }

    /**
     * Find files matching a glob pattern
     */
    async globSearch(params: any): Promise<ToolResult> {
        const { pattern } = params;

        if (!pattern) {
            return { status: 'error', error: 'pattern is required' };
        }

        console.log(`[ToolsExecutor] Glob search: ${pattern}`);

    
        let basePath = '.';
        let namePattern = pattern;

        const lastSlash = pattern.lastIndexOf('/');
        if (lastSlash !== -1) {
            basePath = pattern.substring(0, lastSlash).replace(/\/?\*\*$/, '') || '.';
            namePattern = pattern.substring(lastSlash + 1);
        }

        const searchDir = path.join(this.workspaceRoot, basePath);
        const excludes = [
            '-not', '-path', '*/node_modules/*',
            '-not', '-path', '*/.git/*',
            '-not', '-path', '*/__pycache__/*',
            '-not', '-path', '*/dist/*',
            '-not', '-path', '*/build/*',
            '-not', '-path', '*/.venv/*',
        ];

        // Quote searchDir to handle workspace paths that contain spaces
        const cmd = `find "${searchDir}" -name "${namePattern}" ${excludes.join(' ')}`;

        try {
            const { stdout } = await execAsync(cmd, { timeout: 30000 });
            const matches = stdout
                .trim()
                .split('\n')
                .filter(Boolean)
                .map(f => path.relative(this.workspaceRoot, f))
                .slice(0, 200);

            return {
                status: 'success',
                pattern,
                matches,
                count: matches.length,
            };
        } catch (error: any) {
            return { status: 'error', error: error.message };
        }
    }

    /**
     * Search file contents with a regex pattern
     */
    async grepSearch(params: any): Promise<ToolResult> {
        const { pattern, file_glob } = params;

        if (!pattern) {
            return { status: 'error', error: 'pattern is required' };
        }

        console.log(`[ToolsExecutor] Grep search: ${pattern}${file_glob ? ` (${file_glob})` : ''}`);

        const baseArgs = [
            'grep', '-rn', '-E',
            '--exclude-dir=node_modules',
            '--exclude-dir=.git',
            '--exclude-dir=__pycache__',
            '--exclude-dir=dist',
            '--exclude-dir=build',
            '--exclude-dir=.venv',
            '--binary-files=without-match',
        ];

     
        let searchPath = '.';
        if (file_glob) {
            if (file_glob.includes('/')) {
                const match = file_glob.match(/^([^*]+?)\/(?:\*\*\/)?(.+)$/);
                if (match) {
                    searchPath = match[1];
                    const namePat = match[2];
                    if (namePat && namePat !== '*') baseArgs.push(`--include=${namePat}`);
                } else {
                    baseArgs.push(`--include=${file_glob}`);
                }
            } else {
                baseArgs.push(`--include=${file_glob}`);
            }
        }

        const args = [...baseArgs, `'${pattern.replace(/'/g, `'\\''`)}'`, searchPath];

        try {
            const { stdout } = await execAsync(args.join(' '), {
                cwd: this.workspaceRoot,
                timeout: 30000,
                maxBuffer: 1024 * 1024,
            });

            const lines = stdout.trim().split('\n').filter(Boolean);
            const truncated = lines.length > 500;
            const output = truncated ? lines.slice(0, 500).join('\n') + `\n\n... [truncated — ${lines.length} total matches, showing first 500]` : stdout.trim();

            return {
                status: 'success',
                pattern,
                file_glob: file_glob || null,
                output,
                match_count: lines.length,
            };
        } catch (error: any) {
            if (error.code === 1 && !error.stderr) {
                return { status: 'success', pattern, file_glob: file_glob || null, output: '', match_count: 0 };
            }
            return { status: 'error', error: error.message };
        }
    }

    /**
     * Get project tree — delegates to shared tree-scanner utility
     */
    async getProjectTree(params: any): Promise<ToolResult> {
        const { depth = 0, exclude_patterns, format = 'tree' } = params;

        console.log(`[ToolsExecutor] Getting project tree from workspace root: ${this.workspaceRoot}`);
        console.log(`[ToolsExecutor] Depth limit: ${depth === 0 ? 'unlimited' : depth}, format: ${format}`);

        const result = await scanProjectTree(this.workspaceRoot, {
            depth,
            format,
            ...(exclude_patterns && { exclude_patterns }),
        } as any);

        console.log(`[ToolsExecutor] ✓ Scanned project tree:`);
        console.log(`[ToolsExecutor]   Files: ${result.file_count}`);
        console.log(`[ToolsExecutor]   Directories: ${result.dir_count}`);

        return {
            ...result,
        };
    }
}
