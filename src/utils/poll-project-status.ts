import { fetchProjectStatus, type ProjectStatusResponse } from './api-client.js';

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 35 * 60 * 1000;  // server orchestrator limit is 30 min
const MAX_CONSECUTIVE_POLL_ERRORS = 5;

export interface PollOptions<T> {
    /** Extract the field of interest from the status response. */
    extract: (status: ProjectStatusResponse) => T;
    /** Return true once the value is terminal (completed/failed/etc.). */
    isTerminal: (value: T) => boolean;
    /** Optional tick callback for progress logging — called on each non-terminal poll. */
    onTick?: (elapsedS: number, value: T) => void;
    intervalMs?: number;
    timeoutMs?: number;
}

/**
 * Poll a project's status doc until `isTerminal(extract(status))` returns true.
 *
 * Returns the terminal value. Throws on timeout or after
 * MAX_CONSECUTIVE_POLL_ERRORS consecutive HTTP failures.
 *
 * Used by fire-and-poll update commands (update-implicit, update-drg) to wait
 * for a background task in the orch container to write its terminal status
 * back to the `projects` collection.
 */
export async function pollProjectStatus<T>(
    apiKey: string,
    projectId: string,
    branch: string,
    opts: PollOptions<T>,
): Promise<T> {
    const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    const timeoutMs  = opts.timeoutMs  ?? DEFAULT_TIMEOUT_MS;
    const startedAt = Date.now();
    let consecutiveErrors = 0;

    while (Date.now() - startedAt < timeoutMs) {
        let status: ProjectStatusResponse;
        try {
            status = await fetchProjectStatus(apiKey, projectId, branch);
            consecutiveErrors = 0;
        } catch (err) {
            consecutiveErrors++;
            if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
                throw new Error(
                    `Status polling failed ${MAX_CONSECUTIVE_POLL_ERRORS} times: ${(err as Error).message}`,
                );
            }
            await new Promise(r => setTimeout(r, intervalMs));
            continue;
        }

        const value = opts.extract(status);
        if (opts.isTerminal(value)) return value;
        if (opts.onTick) opts.onTick(Math.round((Date.now() - startedAt) / 1000), value);
        await new Promise(r => setTimeout(r, intervalMs));
    }
    throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for terminal status`);
}
