import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Detect git changes since `sinceCommit` (committed history) plus any dirty
 * working-tree changes (staged + unstaged). Renames are registered on both
 * sides — old path as deleted, new path as added — so downstream analyses
 * drop stale state and re-process the new path.
 *
 * Shared by update-drg, update-file-index, and update-implicit so all three
 * CLI commands see the same change set when running against the same
 * baseline commit.
 */
export async function detectGitChanges(
    projectRoot: string,
    sinceCommit: string | undefined,
): Promise<{ added: string[]; modified: string[]; deleted: string[] }> {
    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];
    const seen = new Set<string>();

    function applyLine(statusCode: string, filePath: string): void {
        if (!filePath || seen.has(filePath)) return;
        seen.add(filePath);
        if (statusCode === 'D') {
            deleted.push(filePath);
        } else if (statusCode === 'A' || statusCode === '?') {
            added.push(filePath);
        } else {
            modified.push(filePath);
        }
    }

    try {
        // 1. All commits since the last indexed commit (covers N committed changes)
        if (sinceCommit) {
            try {
                const { stdout } = await execAsync(
                    `git diff --name-status ${sinceCommit}..HEAD`,
                    { cwd: projectRoot },
                );
                for (const line of stdout.split('\n')) {
                    if (!line.trim()) continue;
                    const parts = line.split('\t');
                    const code = parts[0]?.[0] ?? '';
                    // Renames: R100\told\tnew — register old as deleted, new as added
                    if (code === 'R' && parts.length >= 3) {
                        applyLine('D', parts[1]?.trim());
                        applyLine('A', parts[parts.length - 1]?.trim());
                        continue;
                    }
                    const filePath = parts[parts.length - 1]?.trim();
                    applyLine(code, filePath);
                }
            } catch {
                // sinceCommit may no longer exist (force-push, rebase) — fall through
            }
        }

        // 2. Uncommitted changes (staged + unstaged) — catches dirty working tree
        const { stdout: statusOut } = await execAsync('git status --porcelain', { cwd: projectRoot });
        for (const line of statusOut.split('\n')) {
            if (!line.trim()) continue;
            const xy = line.substring(0, 2).trim();
            // Handle rename: "R  old -> new" — keep just the new path
            const filePath = line.substring(3).trim().split(' -> ').pop()!;
            const code = xy.includes('D') ? 'D' : xy.includes('A') || xy === '??' ? 'A' : 'M';
            applyLine(code, filePath);
        }
    } catch {
        // Git not available — caller falls back to baseline / full mode
    }

    return { added, modified, deleted };
}
