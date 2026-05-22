import type { PipelinePhase, ProjectStatusResponse } from './api-client.js';

export interface PhaseDefinition {
    key: PipelinePhase;
    label: string;
}

// Ordered pipeline phases as the backend runs them
export const PIPELINE_PHASES: PhaseDefinition[] = [
    { key: 'reading_files',      label: 'Reading files' },
    { key: 'analyzing',          label: 'Analysing dependencies' },
    { key: 'enriching_files',    label: 'Enriching files' },
    { key: 'generating_docs',    label: 'Generating documentation' },
    { key: 'indexing_graph',     label: 'Indexing knowledge graph' },
    { key: 'enriching_modules',  label: 'Enriching modules' },
];

/**
 * Returns the index of the current phase in PIPELINE_PHASES.
 * Returns -1 if phase is null/undefined/unknown (before pipeline starts).
 * Returns PIPELINE_PHASES.length for 'completed'.
 */
function phaseIndex(phase: PipelinePhase | null | undefined): number {
    if (!phase || phase === 'failed') return -1;
    if (phase === 'completed') return PIPELINE_PHASES.length;
    return PIPELINE_PHASES.findIndex(p => p.key === phase);
}

/**
 * Renders a one-line phase progress bar:
 *   ✓ Reading files  →  ⏳ Analysing dependencies  →  ○ Generating docs  →  ...
 */
export function renderPhaseBar(status: ProjectStatusResponse): string {
    const { init_scan_status, pipeline_phase } = status;

    if (init_scan_status === 'not_started') {
        return '○ ' + PIPELINE_PHASES.map(p => p.label).join('  →  ○ ');
    }

    if (init_scan_status === 'failed' || pipeline_phase === 'failed') {
        const idx = phaseIndex(pipeline_phase);
        return PIPELINE_PHASES.map((p, i) => {
            if (i < idx) return `✓ ${p.label}`;
            if (i === idx) return `✗ ${p.label}`;
            return `○ ${p.label}`;
        }).join('  →  ');
    }

    if (init_scan_status === 'completed' || init_scan_status === 'completed_with_warnings') {
        return PIPELINE_PHASES.map(p => `✓ ${p.label}`).join('  →  ');
    }

    // in_progress: highlight current phase
    const idx = phaseIndex(pipeline_phase);
    return PIPELINE_PHASES.map((p, i) => {
        if (i < idx) return `✓ ${p.label}`;
        if (i === idx) return `⏳ ${p.label}`;
        return `○ ${p.label}`;
    }).join('  →  ');
}

/**
 * Human-readable label for the current phase, e.g. "Analysing dependencies".
 * Falls back to "Starting..." if phase is unknown.
 */
export function currentPhaseLabel(phase: PipelinePhase | null | undefined): string {
    if (!phase || phase === 'completed') return '';
    if (phase === 'failed') return 'Failed';
    return PIPELINE_PHASES.find(p => p.key === phase)?.label ?? 'Starting...';
}

/**
 * Formats elapsed seconds as "1m 23s" or "45s".
 */
export function formatElapsed(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * Formats a raw status string nicely, e.g. "in_progress" → "in progress".
 */
export function formatImplicitDepStatus(status: ProjectStatusResponse): string {
    const s = status.implicit_dep_status;
    if (!s || s === 'unknown') return '○ not started';
    if (s === 'not_started') return '○ not started';
    if (s === 'in_progress' || s === 'resumed') return '⏳ in progress';
    if (s === 'completed') {
        const parts: string[] = ['✓ completed'];
        if (status.implicit_dep_cost_usd != null) {
            parts.push(`$${status.implicit_dep_cost_usd.toFixed(2)}`);
        }
        if (status.implicit_dep_elapsed_s != null) {
            parts.push(formatElapsed(Math.round(status.implicit_dep_elapsed_s)));
        }
        return parts.join('  ');
    }
    if (s === 'failed') return '✗ failed';
    return s;
}

/**
 * Formats a UTC ISO timestamp for human display (local time, date + time).
 */
export function formatTimestamp(iso: string | null | undefined): string {
    if (!iso) return '';
    try {
        return new Date(iso).toLocaleString();
    } catch {
        return iso;
    }
}
