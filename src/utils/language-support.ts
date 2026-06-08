import path from 'path';

// ─── DRG-Supported Languages (backend has resolvers for these) ───────────────
// These extensions are fully supported by the dependency analysis pipeline.
export const DRG_SUPPORTED_EXTENSIONS = new Set<string>([
    '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx',  // JavaScript/TypeScript
    '.py', '.pyw',                                  // Python
    '.cs',                                          // C#
    '.c', '.h',                                     // C
    '.cpp', '.cc', '.cxx', '.hpp', '.hxx', '.hh',  // C++
    '.java',                                        // Java
    '.go',                                          // Go
    '.kt', '.kts',                                  // Kotlin
    '.rs',                                          // Rust
    '.php', '.php5',                                // PHP
    '.rb', '.rake',                                 // Ruby
    '.swift',                                       // Swift
]);

// Known languages that are NOT supported by the DRG pipeline.
// Key: extension, Value: language name for display.
export const KNOWN_UNSUPPORTED_LANGUAGES: Record<string, string> = {
    '.scala': 'Scala',
    '.sc': 'Scala',
    '.dart': 'Dart',
    '.ex': 'Elixir',
    '.exs': 'Elixir',
    '.erl': 'Erlang',
    '.hrl': 'Erlang',
    '.clj': 'Clojure',
    '.cljs': 'ClojureScript',
    '.groovy': 'Groovy',
    '.vb': 'Visual Basic',
    '.fs': 'F#',
    '.fsx': 'F#',
    '.hs': 'Haskell',
    '.lhs': 'Haskell',
    '.ml': 'OCaml',
    '.mli': 'OCaml',
    '.pl': 'Perl',
    '.pm': 'Perl',
    '.r': 'R',
    '.R': 'R',
    '.lua': 'Lua',
    '.jl': 'Julia',
    '.nim': 'Nim',
    '.cr': 'Crystal',
    '.v': 'V',
    '.zig': 'Zig',
    '.d': 'D',
    '.pas': 'Pascal',
    '.pp': 'Pascal',
    '.f90': 'Fortran',
    '.f95': 'Fortran',
    '.f03': 'Fortran',
    '.cob': 'COBOL',
    '.cbl': 'COBOL',
};

export const SUPPORTED_LANGUAGES_DISPLAY =
    'JavaScript, TypeScript, Python, C#, C, C++, Java, Go, Kotlin, Rust, PHP, Ruby, Swift';

// Block the scan when MORE than this percentage of recognized code files are in
// unsupported languages. Recognized code files = supported + known-unsupported.
// Files with unknown extensions (config, assets, docs, anything not in either
// set) are ignored entirely — they count toward neither numerator nor denominator.
export const UNSUPPORTED_BLOCK_THRESHOLD_PCT = 50;

export interface LanguageCheckResult {
    /** Files whose extension is in DRG_SUPPORTED_EXTENSIONS. */
    supportedFiles: number;
    /** Files whose extension is in KNOWN_UNSUPPORTED_LANGUAGES. */
    unsupportedFiles: number;
    /** supportedFiles + unsupportedFiles — the denominator for the ratio. */
    recognizedFiles: number;
    /** Sorted list of unsupported language display names that were found. */
    unsupportedLanguages: string[];
    /** { "Scala": 60, "Elixir": 5 } */
    unsupportedDetails: Record<string, number>;
    /** unsupportedFiles / recognizedFiles * 100, or 0 when no recognized files. */
    unsupportedPercent: number;
    /** Any unsupported-language files present at all. */
    hasUnsupported: boolean;
    /** unsupportedPercent > UNSUPPORTED_BLOCK_THRESHOLD_PCT. */
    shouldBlock: boolean;
}

/**
 * Classify files by language support and compute the unsupported ratio.
 *
 * The ratio is measured against RECOGNIZED CODE FILES only (supported +
 * known-unsupported). Config/asset/doc files and any unknown extension are
 * excluded so a JSON/asset-heavy repo doesn't dilute the percentage.
 */
export function checkLanguageSupport(filePaths: string[]): LanguageCheckResult {
    const unsupportedDetails: Record<string, number> = {};
    let unsupportedFiles = 0;
    let supportedFiles = 0;

    for (const filePath of filePaths) {
        const ext = path.extname(filePath).toLowerCase();

        if (DRG_SUPPORTED_EXTENSIONS.has(ext)) {
            supportedFiles++;
            continue;
        }

        const langName = KNOWN_UNSUPPORTED_LANGUAGES[ext];
        if (langName) {
            unsupportedFiles++;
            unsupportedDetails[langName] = (unsupportedDetails[langName] || 0) + 1;
        }
        // else: unknown extension (config/asset/doc/etc.) — ignored.
    }

    const recognizedFiles = supportedFiles + unsupportedFiles;
    const unsupportedPercent = recognizedFiles > 0
        ? (unsupportedFiles / recognizedFiles) * 100
        : 0;

    return {
        supportedFiles,
        unsupportedFiles,
        recognizedFiles,
        unsupportedLanguages: Object.keys(unsupportedDetails).sort(),
        unsupportedDetails,
        unsupportedPercent,
        hasUnsupported: unsupportedFiles > 0,
        shouldBlock: unsupportedPercent > UNSUPPORTED_BLOCK_THRESHOLD_PCT,
    };
}

/**
 * Apply the language-support gate to a command.
 *
 *   > 50% of recognized code files unsupported  → print a block banner and
 *                                                  exit(1). The scan never runs.
 *   0 < pct <= 50%                              → print a warning and continue;
 *                                                  unsupported files are skipped
 *                                                  by the pipeline.
 *   0%                                          → silent (all supported).
 *
 * `label` prefixes log lines (e.g. "Init", "UpdateDRG").
 */
export function enforceLanguageSupport(filePaths: string[], label: string): LanguageCheckResult {
    const check = checkLanguageSupport(filePaths);

    if (!check.hasUnsupported) {
        return check;
    }

    const pct = Math.round(check.unsupportedPercent);

    if (check.shouldBlock) {
        console.log('');
        console.log('╔═══════════════════════════════════════════════════════════════════╗');
        console.log('║           SCAN FAILED — TOO MANY UNSUPPORTED LANGUAGES            ║');
        console.log('╚═══════════════════════════════════════════════════════════════════╝');
        console.log('');
        console.log(
            `${pct}% of recognized code files (${check.unsupportedFiles}/${check.recognizedFiles}) ` +
            `are in unsupported languages.`
        );
        for (const [lang, count] of Object.entries(check.unsupportedDetails)) {
            console.log(`   • ${lang}: ${count} file(s)`);
        }
        console.log('');
        console.log(`Supported languages: ${SUPPORTED_LANGUAGES_DISPLAY}`);
        console.log('');
        console.log(`[${label}] Aborting — the dependency graph would cover less than half of this project.\n`);
        process.exit(1);
    }

    // Some unsupported files, but at or under the threshold → warn and continue.
    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════════════╗');
    console.log('║             WARNING — UNSUPPORTED LANGUAGES DETECTED              ║');
    console.log('╚═══════════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log(
        `Found ${check.unsupportedFiles} file(s) in unsupported languages ` +
        `(${pct}% of ${check.recognizedFiles} recognized code files):`
    );
    for (const [lang, count] of Object.entries(check.unsupportedDetails)) {
        console.log(`   • ${lang}: ${count} file(s)`);
    }
    console.log('');
    console.log('These files will be SKIPPED during dependency analysis.');
    console.log('');
    console.log(`Supported languages: ${SUPPORTED_LANGUAGES_DISPLAY}`);
    console.log('');

    return check;
}
