/**
 * Pure formatting for the `lgraph context` CLI.
 *
 * Merges the three backend responses (what-is-this-file, dependency, blast-radius)
 * into a compact markdown that only contains information NOT derivable from reading
 * the file itself — module role, reverse-deps, implicit coupling, modification
 * impact, blast radius summary.
 *
 * No I/O. Testable via golden-output comparison.
 */

const MAX_DIRECT_DEPENDENTS = 10;
const MAX_IMPLICIT_DEPENDENTS = 6;

export interface FileSummaryPartial {
    module_name?: string;
    modification_impact?: string;
    dependents?: Array<{ path: string; type?: string[] } | string>;
}

export interface DependencyEdge {
    relationship?: string;
    imports?: string[];
    strength?: string;
    dependency_types?: string[];
    edge_summary?: string;
    dependency_summary?: string;
    implicit?: boolean;
}

export interface DependenciesPartial {
    path?: string;
    dependents?: Array<{ path: string; type?: string[] }>;
    edge_details?: Record<string, DependencyEdge>;
}

export interface BlastRadiusFile {
    path: string;
    summary?: string;
    level?: number;
    dependency_types?: string[];
    coupling_strength?: string;
    is_implicit?: boolean;
}

export interface BlastRadiusPartial {
    path?: string;
    affected_files?: BlastRadiusFile[];
    cluster_blast_radius?: Array<{ path: string; summary?: string }>;
    deep_affected_modules?: Array<{ module: string; file_count?: number }>;
}

export interface HookContextInputs {
    filePath: string;
    fileSummary?: FileSummaryPartial | null;
    dependencies?: DependenciesPartial | null;
    blastRadius?: BlastRadiusPartial | null;
}

/** Classify an affected file the same way mcp-server.ts does. */
function classify(f: BlastRadiusFile): 'explicit' | 'implicit' | 'mixed' {
    const types = Array.isArray(f.dependency_types) ? f.dependency_types : [];
    const hasExplicit = types.includes('explicit');
    const hasImplicit = types.includes('implicit');
    if (hasExplicit && hasImplicit) return 'mixed';
    if (hasImplicit) return 'implicit';
    if (!hasExplicit && f.is_implicit) return 'implicit';
    return 'explicit';
}

/** Build the directly-dependent block from the dependencies endpoint. */
function formatDirectDependents(deps: DependenciesPartial | null | undefined): string[] {
    if (!deps?.dependents?.length) return [];
    const edgeDetails = deps.edge_details ?? {};
    const lines: string[] = [];
    const dependents = deps.dependents.slice(0, MAX_DIRECT_DEPENDENTS);
    for (const d of dependents) {
        const p = typeof d === 'string' ? d : d.path;
        const types = typeof d === 'string' ? [] : (d.type ?? []);
        const typeLabel = types.length ? ` [${types.join(', ')}]` : '';
        const edge = edgeDetails[p];
        const summary = edge?.edge_summary || edge?.dependency_summary || '';
        lines.push(summary ? `- ${p}${typeLabel} — ${summary}` : `- ${p}${typeLabel}`);
    }
    const remaining = deps.dependents.length - dependents.length;
    if (remaining > 0) lines.push(`- … ${remaining} more not shown`);
    return lines;
}

/** Build the implicit-coupling block from blast radius implicit files. */
function formatImplicitCoupling(br: BlastRadiusPartial | null | undefined): string[] {
    if (!br?.affected_files?.length) return [];
    const implicit = br.affected_files.filter(f => classify(f) === 'implicit' || classify(f) === 'mixed');
    if (implicit.length === 0) return [];
    const strengthOrder = { tight: 0, moderate: 1, loose: 2, unknown: 3 };
    implicit.sort((a, b) => {
        const sa = (a.coupling_strength ?? 'unknown') as keyof typeof strengthOrder;
        const sb = (b.coupling_strength ?? 'unknown') as keyof typeof strengthOrder;
        return (strengthOrder[sa] ?? 3) - (strengthOrder[sb] ?? 3);
    });
    const lines: string[] = [];
    for (const f of implicit.slice(0, MAX_IMPLICIT_DEPENDENTS)) {
        const strength = f.coupling_strength ? `[${f.coupling_strength}] ` : '';
        const summary = f.summary ? ` — ${f.summary}` : '';
        lines.push(`- ${strength}${f.path}${summary}`);
    }
    const remaining = implicit.length - MAX_IMPLICIT_DEPENDENTS;
    if (remaining > 0) lines.push(`- … ${remaining} more not shown`);
    return lines;
}

/** Build a one-line blast-radius summary: "N files across M modules". */
function formatBlastSummary(br: BlastRadiusPartial | null | undefined): string {
    const affected = br?.affected_files ?? [];
    if (affected.length === 0 && (!br?.cluster_blast_radius || br.cluster_blast_radius.length === 0)) {
        return 'no other files would be affected';
    }
    const total = affected.length;
    const clusters = br?.cluster_blast_radius?.map(c => c.path) ?? [];
    const modulePart = clusters.length ? ` across ${clusters.slice(0, 4).join(', ')}${clusters.length > 4 ? ', …' : ''}` : '';
    return `${total} file(s) would be affected${modulePart}`;
}

/** Main entry point. Returns an empty string when there is no useful data. */
export function formatHookContext(inputs: HookContextInputs): string {
    const { filePath, fileSummary, dependencies, blastRadius } = inputs;

    const lines: string[] = [];
    lines.push(`## Hidden context for ${filePath}`);

    const moduleName = fileSummary?.module_name;
    if (moduleName) lines.push(`**Module:** ${moduleName}`);

    if (fileSummary?.modification_impact) {
        lines.push(`**Modification impact:** ${fileSummary.modification_impact.trim()}`);
    }

    const directDependents = formatDirectDependents(dependencies);
    if (directDependents.length) {
        lines.push('');
        lines.push(`**Direct dependents (${dependencies?.dependents?.length ?? directDependents.length}):**`);
        lines.push(...directDependents);
    }

    const implicit = formatImplicitCoupling(blastRadius);
    if (implicit.length) {
        lines.push('');
        lines.push(`**Implicit coupling (sorted tight → loose):**`);
        lines.push(...implicit);
    }

    lines.push('');
    lines.push(`**Blast radius:** ${formatBlastSummary(blastRadius)}`);

    // If none of the content sections rendered, return empty so the caller
    // can decide to emit nothing at all rather than a bare header.
    const hasBody = Boolean(
        fileSummary?.modification_impact ||
        directDependents.length ||
        implicit.length ||
        (blastRadius?.affected_files?.length ?? 0) > 0,
    );
    if (!hasBody) return '';

    return lines.join('\n');
}

export const INDEXED_EXTENSIONS = new Set([
    '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
    '.py',
    '.java',
    '.cpp', '.cc', '.cxx', '.c', '.h', '.hpp',
    '.cs',
    '.go',
    '.css', '.scss',
    '.html',
]);

export function isIndexedSourceFile(filePath: string): boolean {
    if (!filePath) return false;
    const idx = filePath.lastIndexOf('.');
    if (idx < 0) return false;
    return INDEXED_EXTENSIONS.has(filePath.slice(idx).toLowerCase());
}
