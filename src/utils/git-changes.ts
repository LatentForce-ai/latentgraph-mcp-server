import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Detect git changes between `sinceCommit` and HEAD — committed history only.
 * Renames are registered on both sides — old path as deleted, new path as
 * added — so downstream analyses drop stale state and re-process the new path.
 *
 * Committed-only (no working-tree scan) by design: it keeps the client-side
 * commands consistent with the server-side delta used by update-file-index /
 * update-wiki — every update pipeline diffs the same committed range and none
 * ingest uncommitted or untracked files. (An earlier working-tree scan
 * reported wholly-untracked directories as a single entry, which callers then
 * expanded into every nested file — sweeping in non-source artifacts like
 * mongodump snapshots.)
 *
 * Shared by update-drg and update-implicit so both see the same change set
 * when running against the same baseline commit.
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

    // Committed changes between the last indexed commit and HEAD. With no
    // baseline there is nothing to diff against — return empty and let the
    // caller decide (update-drg falls back to a baseline scan; update-implicit
    // lets the server compare against the last analyzed commit).
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
            // sinceCommit may no longer exist (force-push, rebase) or git is
            // unavailable — caller falls back to baseline / full mode.
        }
    }

    return { added, modified, deleted };
}
