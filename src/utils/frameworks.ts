// Framework detection — deterministic, no LLM.
//
// Hybrid approach:
//   • JS/TS web frameworks → @netlify/framework-info (Next, Nuxt, Astro, Remix, Vite, …)
//   • All other 12 languages → hand-rolled manifest parsing + marker-file checks
//
// Output is a flat list of { name, language, source } entries. Duplicates are
// de-duped by (name, language). Detection is best-effort: failures in one
// language do not block detection for others.

import * as fsp from 'fs/promises';
import * as fs from 'fs';
import * as path from 'path';

export interface Framework {
    name: string;
    language: string | null;
    source: string;               // e.g. "package.json", "Cargo.toml", "marker:manage.py"
}

// ─── Manifest → framework maps (12 non-JS/TS languages) ──────────────────────

const PY_FRAMEWORKS: Record<string, string> = {
    django: 'Django', flask: 'Flask', fastapi: 'FastAPI', tornado: 'Tornado',
    sanic: 'Sanic', starlette: 'Starlette', aiohttp: 'aiohttp', bottle: 'Bottle',
    pyramid: 'Pyramid', quart: 'Quart', falcon: 'Falcon',
    // ML / data
    torch: 'PyTorch', tensorflow: 'TensorFlow', keras: 'Keras',
    'scikit-learn': 'scikit-learn', pandas: 'pandas', numpy: 'NumPy',
    transformers: 'HuggingFace', langchain: 'LangChain', llama_index: 'LlamaIndex',
    // infra / tooling
    celery: 'Celery', pytest: 'pytest', sqlalchemy: 'SQLAlchemy', pydantic: 'Pydantic',
    redis: 'Redis', pymongo: 'MongoDB', boto3: 'AWS SDK',
};

// Match on artifactId or groupId:artifactId substring
const JAVA_FRAMEWORKS: Record<string, string> = {
    'spring-boot': 'Spring Boot', 'spring-core': 'Spring', 'spring-webmvc': 'Spring',
    'spring-webflux': 'Spring WebFlux', 'hibernate-core': 'Hibernate',
    quarkus: 'Quarkus', micronaut: 'Micronaut', 'dropwizard-core': 'Dropwizard',
    'vert.x': 'Vert.x', javalin: 'Javalin', 'play-java': 'Play', struts: 'Struts',
    junit: 'JUnit', testng: 'TestNG', mockito: 'Mockito', lombok: 'Lombok',
};

const KOTLIN_FRAMEWORKS: Record<string, string> = {
    'ktor-server': 'Ktor', 'ktor-client': 'Ktor Client',
    'spring-boot': 'Spring Boot',
    'kotlinx-coroutines-core': 'Coroutines', 'kotlinx-serialization': 'kotlinx.serialization',
    compose: 'Jetpack Compose', 'androidx.compose': 'Jetpack Compose',
    exposed: 'Exposed', hilt: 'Hilt', retrofit: 'Retrofit',
};

const GO_FRAMEWORKS: Record<string, string> = {
    'github.com/gin-gonic/gin': 'Gin', 'github.com/labstack/echo': 'Echo',
    'github.com/gofiber/fiber': 'Fiber', 'github.com/gorilla/mux': 'Gorilla Mux',
    'github.com/go-chi/chi': 'Chi', 'github.com/beego/beego': 'Beego',
    'github.com/spf13/cobra': 'Cobra', 'github.com/urfave/cli': 'urfave/cli',
    'google.golang.org/grpc': 'gRPC', 'google.golang.org/protobuf': 'Protobuf',
    'github.com/graphql-go/graphql': 'GraphQL',
    'gorm.io/gorm': 'GORM', 'github.com/jmoiron/sqlx': 'sqlx',
    'github.com/stretchr/testify': 'testify', 'github.com/aws/aws-sdk-go': 'AWS SDK',
};

const RUST_FRAMEWORKS: Record<string, string> = {
    actix: 'Actix', 'actix-web': 'Actix Web', rocket: 'Rocket', axum: 'Axum',
    warp: 'Warp', tide: 'Tide', poem: 'Poem', salvo: 'Salvo',
    tokio: 'Tokio', 'async-std': 'async-std', serde: 'Serde',
    tauri: 'Tauri', bevy: 'Bevy', yew: 'Yew', leptos: 'Leptos',
    diesel: 'Diesel', sqlx: 'SQLx', reqwest: 'reqwest', tonic: 'Tonic (gRPC)',
    clap: 'clap', anyhow: 'anyhow', thiserror: 'thiserror',
};

// Matched against <PackageReference Include="..."> in .csproj files
const CSHARP_FRAMEWORKS: Record<string, string> = {
    'Microsoft.AspNetCore': 'ASP.NET Core', 'Microsoft.EntityFrameworkCore': 'EF Core',
    'Xamarin.Forms': 'Xamarin', 'Microsoft.Maui': '.NET MAUI',
    NUnit: 'NUnit', 'xunit': 'xUnit', 'MSTest.TestFramework': 'MSTest',
    Dapper: 'Dapper', AutoMapper: 'AutoMapper', Serilog: 'Serilog',
    MediatR: 'MediatR', FluentValidation: 'FluentValidation',
    Blazor: 'Blazor', SignalR: 'SignalR', Orleans: 'Orleans',
    Unity: 'Unity',
};

const PHP_FRAMEWORKS: Record<string, string> = {
    'laravel/framework': 'Laravel', 'symfony/symfony': 'Symfony',
    'symfony/framework-bundle': 'Symfony', 'symfony/http-kernel': 'Symfony',
    'slim/slim': 'Slim', 'cakephp/cakephp': 'CakePHP',
    'codeigniter/framework': 'CodeIgniter', codeigniter4: 'CodeIgniter',
    'yiisoft/yii2': 'Yii', 'yiisoft/yii': 'Yii', 'zendframework/zend': 'Zend',
    'laminas/laminas': 'Laminas',
    'phpunit/phpunit': 'PHPUnit', 'doctrine/orm': 'Doctrine',
    'guzzlehttp/guzzle': 'Guzzle', 'drupal/core': 'Drupal',
    'wordpress/wordpress': 'WordPress',
};

const RUBY_FRAMEWORKS: Record<string, string> = {
    rails: 'Rails', sinatra: 'Sinatra', hanami: 'Hanami', rack: 'Rack',
    roda: 'Roda', padrino: 'Padrino', grape: 'Grape',
    rspec: 'RSpec', 'rspec-rails': 'RSpec', minitest: 'Minitest',
    sidekiq: 'Sidekiq', resque: 'Resque', devise: 'Devise',
    activerecord: 'ActiveRecord', sequel: 'Sequel',
};

const SWIFT_FRAMEWORKS: Record<string, string> = {
    Vapor: 'Vapor', Perfect: 'Perfect', Kitura: 'Kitura',
    Alamofire: 'Alamofire', RxSwift: 'RxSwift', SnapKit: 'SnapKit',
    Kingfisher: 'Kingfisher', SwiftyJSON: 'SwiftyJSON',
    Firebase: 'Firebase', SwiftLint: 'SwiftLint',
    'swift-nio': 'SwiftNIO', 'swift-log': 'Swift Log',
};

const CPP_FRAMEWORKS: Record<string, string> = {
    Qt5: 'Qt', Qt6: 'Qt', Qt: 'Qt',
    Boost: 'Boost', OpenCV: 'OpenCV', Eigen3: 'Eigen',
    gtest: 'GoogleTest', GTest: 'GoogleTest', Catch2: 'Catch2',
    grpc: 'gRPC', gRPC: 'gRPC', protobuf: 'Protobuf', Protobuf: 'Protobuf',
    fmt: 'fmt', spdlog: 'spdlog', nlohmann_json: 'nlohmann/json',
    OpenGL: 'OpenGL', Vulkan: 'Vulkan', SFML: 'SFML', SDL2: 'SDL2',
    pybind11: 'pybind11', Threads: 'pthreads',
};

// ─── Marker files (unique build / config files → direct framework ID) ───────

const MARKER_FILES: Record<string, { name: string; language: string | null }> = {
    // Python
    'manage.py':              { name: 'Django',            language: 'Python' },
    // PHP
    'artisan':                { name: 'Laravel',           language: 'PHP' },
    'wp-config.php':          { name: 'WordPress',         language: 'PHP' },
    // Ruby
    'config.ru':              { name: 'Rack',              language: 'Ruby' },
    'config/application.rb':  { name: 'Rails',             language: 'Ruby' },
    // Swift / Apple
    'Package.swift':          { name: 'Swift PM',          language: 'Swift' },
    'Podfile':                { name: 'CocoaPods',         language: 'Swift' },
    // C / C++
    'CMakeLists.txt':         { name: 'CMake',             language: 'C/C++' },
    'meson.build':            { name: 'Meson',             language: 'C/C++' },
    'conanfile.txt':          { name: 'Conan',             language: 'C/C++' },
    'conanfile.py':           { name: 'Conan',             language: 'C/C++' },
    'vcpkg.json':             { name: 'vcpkg',             language: 'C/C++' },
    // Java / Kotlin build
    'mvnw':                   { name: 'Maven Wrapper',     language: 'Java' },
    'gradlew':                { name: 'Gradle Wrapper',    language: 'Java' },
    // Android
    'AndroidManifest.xml':    { name: 'Android',           language: 'Kotlin' },
    // Infra
    'Dockerfile':             { name: 'Docker',            language: null },
    'docker-compose.yml':     { name: 'Docker Compose',    language: null },
    'docker-compose.yaml':    { name: 'Docker Compose',    language: null },
    '.github/workflows':      { name: 'GitHub Actions',    language: null },
    '.gitlab-ci.yml':         { name: 'GitLab CI',         language: null },
    'Jenkinsfile':            { name: 'Jenkins',           language: null },
    'terraform.tf':           { name: 'Terraform',         language: null },
    'main.tf':                { name: 'Terraform',         language: null },
};

// ─── helpers ─────────────────────────────────────────────────────────────────

function fileExists(p: string): boolean {
    try { return fs.statSync(p).isFile(); } catch { return false; }
}

async function readFileSafe(p: string): Promise<string | null> {
    try { return await fsp.readFile(p, 'utf-8'); } catch { return null; }
}

function addFramework(
    out: Framework[],
    seen: Set<string>,
    name: string,
    language: string | null,
    source: string,
): void {
    const key = `${name}::${language ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, language, source });
}

/** Match a dependency name against a framework map with substring fallback. */
function matchAgainstMap(
    depName: string,
    map: Record<string, string>,
): string | null {
    if (map[depName]) return map[depName];
    // substring fallback (e.g. "spring-boot-starter-web" matches "spring-boot")
    const lower = depName.toLowerCase();
    for (const [key, val] of Object.entries(map)) {
        if (lower.includes(key.toLowerCase())) return val;
    }
    return null;
}

// ─── per-language detectors ──────────────────────────────────────────────────

async function detectJsTs(projectRoot: string, out: Framework[], seen: Set<string>): Promise<void> {
    // Use @netlify/framework-info for JS/TS web frameworks
    try {
        const mod = await import('@netlify/framework-info');
        const listFrameworks = (mod as any).listFrameworks;
        if (typeof listFrameworks === 'function') {
            const found: any[] = await listFrameworks({ projectDir: projectRoot });
            for (const f of found || []) {
                const displayName = f.name
                    ? String(f.name).charAt(0).toUpperCase() + String(f.name).slice(1)
                    : null;
                if (displayName) {
                    addFramework(out, seen, displayName, 'JS/TS', '@netlify/framework-info');
                }
            }
        }
    } catch {
        // Library optional — if it fails, fall through to manual package.json parsing
    }

    // Also parse package.json directly for non-web libs Netlify doesn't know (Express, NestJS, etc.)
    const pkgJsonPath = path.join(projectRoot, 'package.json');
    const content = await readFileSafe(pkgJsonPath);
    if (!content) return;

    let pkg: any;
    try { pkg = JSON.parse(content); } catch { return; }

    const NPM_FRAMEWORKS: Record<string, string> = {
        react: 'React', vue: 'Vue', '@angular/core': 'Angular',
        svelte: 'Svelte', 'react-native': 'React Native',
        express: 'Express', '@nestjs/core': 'NestJS', fastify: 'Fastify',
        koa: 'Koa', '@hapi/hapi': 'Hapi', 'hono': 'Hono',
        next: 'Next.js', nuxt: 'Nuxt', astro: 'Astro', remix: 'Remix',
        '@sveltejs/kit': 'SvelteKit', gatsby: 'Gatsby', '@builder.io/qwik': 'Qwik',
        vite: 'Vite', webpack: 'Webpack', rollup: 'Rollup', esbuild: 'esbuild',
        tailwindcss: 'Tailwind', typescript: 'TypeScript',
        electron: 'Electron', expo: 'Expo',
        jest: 'Jest', vitest: 'Vitest', mocha: 'Mocha', playwright: 'Playwright',
        cypress: 'Cypress', prisma: 'Prisma', mongoose: 'Mongoose',
        'socket.io': 'Socket.IO', graphql: 'GraphQL',
    };

    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}), ...(pkg.peerDependencies || {}) };
    for (const dep of Object.keys(deps)) {
        const match = NPM_FRAMEWORKS[dep];
        if (match) addFramework(out, seen, match, 'JS/TS', 'package.json');
    }
}

async function detectPython(projectRoot: string, out: Framework[], seen: Set<string>): Promise<void> {
    const sources = ['requirements.txt', 'requirements-dev.txt', 'Pipfile', 'setup.py'];
    for (const src of sources) {
        const content = await readFileSafe(path.join(projectRoot, src));
        if (!content) continue;
        // Extract package names — crude but effective
        const names = content.match(/^[\w\-_.]+/gm) || [];
        for (const name of names) {
            const lower = name.toLowerCase().replace(/_/g, '-');
            const match = PY_FRAMEWORKS[lower] || PY_FRAMEWORKS[name.toLowerCase()];
            if (match) addFramework(out, seen, match, 'Python', src);
        }
    }
    // pyproject.toml — parse [project.dependencies] and [tool.poetry.dependencies]
    const pyproj = await readFileSafe(path.join(projectRoot, 'pyproject.toml'));
    if (pyproj) {
        const depLines = pyproj.match(/^[\w\-_.]+\s*=/gm) || [];
        const depsBlock = pyproj.match(/dependencies\s*=\s*\[([\s\S]*?)\]/g) || [];
        const all = [...depLines.map(l => l.split('=')[0].trim()), ...depsBlock.join('\n').match(/"([\w\-_.]+)/g)?.map(s => s.slice(1)) || []];
        for (const name of all) {
            const lower = name.toLowerCase().replace(/_/g, '-');
            const match = PY_FRAMEWORKS[lower] || PY_FRAMEWORKS[name.toLowerCase()];
            if (match) addFramework(out, seen, match, 'Python', 'pyproject.toml');
        }
    }
}

async function detectJavaKotlin(projectRoot: string, out: Framework[], seen: Set<string>): Promise<void> {
    // Maven
    const pom = await readFileSafe(path.join(projectRoot, 'pom.xml'));
    if (pom) {
        const artifacts = pom.match(/<artifactId>([^<]+)<\/artifactId>/g) || [];
        for (const a of artifacts) {
            const id = a.replace(/<\/?artifactId>/g, '').trim();
            const javaMatch = matchAgainstMap(id, JAVA_FRAMEWORKS);
            if (javaMatch) addFramework(out, seen, javaMatch, 'Java', 'pom.xml');
            const ktMatch = matchAgainstMap(id, KOTLIN_FRAMEWORKS);
            if (ktMatch) addFramework(out, seen, ktMatch, 'Kotlin', 'pom.xml');
        }
    }
    // Gradle (Groovy + Kotlin DSL)
    for (const name of ['build.gradle', 'build.gradle.kts']) {
        const gradle = await readFileSafe(path.join(projectRoot, name));
        if (!gradle) continue;
        // Match 'group:artifact:version' strings
        const refs = gradle.match(/["']([\w.\-]+):([\w.\-]+):[^"']+["']/g) || [];
        for (const ref of refs) {
            const m = ref.match(/["']([\w.\-]+):([\w.\-]+):/);
            if (!m) continue;
            const artifact = m[2];
            const javaMatch = matchAgainstMap(artifact, JAVA_FRAMEWORKS);
            if (javaMatch) addFramework(out, seen, javaMatch, 'Java', name);
            const ktMatch = matchAgainstMap(artifact, KOTLIN_FRAMEWORKS);
            if (ktMatch) addFramework(out, seen, ktMatch, 'Kotlin', name);
        }
    }
}

async function detectGo(projectRoot: string, out: Framework[], seen: Set<string>): Promise<void> {
    const content = await readFileSafe(path.join(projectRoot, 'go.mod'));
    if (!content) return;
    // go.mod lists "require" blocks with full module paths
    const modules = content.match(/[\w./\-]+\s+v[\d][\w.\-+]*/g) || [];
    for (const mod of modules) {
        const modPath = mod.split(/\s+/)[0];
        for (const [key, val] of Object.entries(GO_FRAMEWORKS)) {
            if (modPath === key || modPath.startsWith(key)) {
                addFramework(out, seen, val, 'Go', 'go.mod');
            }
        }
    }
}

async function detectRust(projectRoot: string, out: Framework[], seen: Set<string>): Promise<void> {
    const content = await readFileSafe(path.join(projectRoot, 'Cargo.toml'));
    if (!content) return;
    // Crate names appear as "name = " or in [dependencies] tables
    const crates = content.match(/^[\w\-]+\s*=/gm) || [];
    for (const c of crates) {
        const name = c.split('=')[0].trim();
        const match = RUST_FRAMEWORKS[name] || RUST_FRAMEWORKS[name.replace(/-/g, '_')];
        if (match) addFramework(out, seen, match, 'Rust', 'Cargo.toml');
    }
}

async function detectCSharp(projectRoot: string): Promise<string[]> {
    // Find all .csproj files at project root (one level deep, to keep it cheap)
    const found: string[] = [];
    try {
        const entries = await fsp.readdir(projectRoot, { withFileTypes: true });
        for (const e of entries) {
            if (e.isFile() && e.name.endsWith('.csproj')) found.push(e.name);
            if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
                try {
                    const sub = await fsp.readdir(path.join(projectRoot, e.name));
                    for (const f of sub) {
                        if (f.endsWith('.csproj')) found.push(path.join(e.name, f));
                    }
                } catch { /* unreadable — skip */ }
            }
        }
    } catch { /* unreadable — skip */ }
    return found;
}

async function detectCSharpFrameworks(projectRoot: string, out: Framework[], seen: Set<string>): Promise<void> {
    const csprojs = await detectCSharp(projectRoot);
    for (const rel of csprojs) {
        const content = await readFileSafe(path.join(projectRoot, rel));
        if (!content) continue;
        const pkgs = content.match(/<PackageReference\s+Include="([^"]+)"/g) || [];
        for (const p of pkgs) {
            const m = p.match(/Include="([^"]+)"/);
            if (!m) continue;
            const pkg = m[1];
            const match = matchAgainstMap(pkg, CSHARP_FRAMEWORKS);
            if (match) addFramework(out, seen, match, 'C#', rel);
        }
    }
}

async function detectPhp(projectRoot: string, out: Framework[], seen: Set<string>): Promise<void> {
    const content = await readFileSafe(path.join(projectRoot, 'composer.json'));
    if (!content) return;
    let pkg: any;
    try { pkg = JSON.parse(content); } catch { return; }
    const deps = { ...(pkg.require || {}), ...(pkg['require-dev'] || {}) };
    for (const dep of Object.keys(deps)) {
        const match = matchAgainstMap(dep, PHP_FRAMEWORKS);
        if (match) addFramework(out, seen, match, 'PHP', 'composer.json');
    }
}

async function detectRuby(projectRoot: string, out: Framework[], seen: Set<string>): Promise<void> {
    const content = await readFileSafe(path.join(projectRoot, 'Gemfile'));
    if (!content) return;
    // gem 'name', '~> 1.0'
    const gems = content.match(/gem\s+["']([\w\-]+)["']/g) || [];
    for (const g of gems) {
        const m = g.match(/["']([\w\-]+)["']/);
        if (!m) continue;
        const name = m[1];
        const match = RUBY_FRAMEWORKS[name] || RUBY_FRAMEWORKS[name.replace(/_/g, '-')];
        if (match) addFramework(out, seen, match, 'Ruby', 'Gemfile');
    }
}

async function detectSwift(projectRoot: string, out: Framework[], seen: Set<string>): Promise<void> {
    // Package.swift
    const pkgSwift = await readFileSafe(path.join(projectRoot, 'Package.swift'));
    if (pkgSwift) {
        // .package(url: "https://github.com/vapor/vapor.git", ...)
        const urls = pkgSwift.match(/\.package\([^)]*url:\s*"([^"]+)"/g) || [];
        for (const u of urls) {
            const m = u.match(/"([^"]+)"/);
            if (!m) continue;
            const url = m[1];
            for (const [key, val] of Object.entries(SWIFT_FRAMEWORKS)) {
                if (url.toLowerCase().includes(key.toLowerCase())) {
                    addFramework(out, seen, val, 'Swift', 'Package.swift');
                }
            }
        }
    }
    // Podfile
    const podfile = await readFileSafe(path.join(projectRoot, 'Podfile'));
    if (podfile) {
        const pods = podfile.match(/pod\s+["']([\w\-./]+)["']/g) || [];
        for (const p of pods) {
            const m = p.match(/["']([\w\-./]+)["']/);
            if (!m) continue;
            const name = m[1].split('/')[0];
            const match = SWIFT_FRAMEWORKS[name];
            if (match) addFramework(out, seen, match, 'Swift', 'Podfile');
        }
    }
}

async function detectCpp(projectRoot: string, out: Framework[], seen: Set<string>): Promise<void> {
    // CMakeLists.txt — find_package() and target_link_libraries()
    const cmake = await readFileSafe(path.join(projectRoot, 'CMakeLists.txt'));
    if (cmake) {
        const finds = cmake.match(/find_package\s*\(\s*([\w\-]+)/gi) || [];
        const links = cmake.match(/target_link_libraries\s*\([^)]+\)/gi) || [];
        const names = new Set<string>();
        for (const f of finds) {
            const m = f.match(/find_package\s*\(\s*([\w\-]+)/i);
            if (m) names.add(m[1]);
        }
        for (const l of links) {
            const ids = l.match(/\b[\w:]+\b/g) || [];
            for (const id of ids) names.add(id.split('::')[0]);
        }
        for (const name of names) {
            const match = CPP_FRAMEWORKS[name];
            if (match) addFramework(out, seen, match, 'C/C++', 'CMakeLists.txt');
        }
    }
    // vcpkg.json
    const vcpkg = await readFileSafe(path.join(projectRoot, 'vcpkg.json'));
    if (vcpkg) {
        try {
            const parsed = JSON.parse(vcpkg);
            const deps = parsed.dependencies || [];
            for (const d of deps) {
                const name = typeof d === 'string' ? d : d.name;
                if (!name) continue;
                // vcpkg uses lowercase-dashed names; match case-insensitively
                const hit = Object.entries(CPP_FRAMEWORKS).find(([k]) => k.toLowerCase() === name.toLowerCase());
                if (hit) addFramework(out, seen, hit[1], 'C/C++', 'vcpkg.json');
            }
        } catch { /* malformed — skip */ }
    }
    // conanfile.txt (INI-ish: [requires] block)
    const conan = await readFileSafe(path.join(projectRoot, 'conanfile.txt'));
    if (conan) {
        const reqBlock = conan.match(/\[requires\]([\s\S]*?)(?=\n\[|\n*$)/);
        if (reqBlock) {
            const names = reqBlock[1].match(/^([\w\-]+)\//gm) || [];
            for (const n of names) {
                const name = n.slice(0, -1);
                const hit = Object.entries(CPP_FRAMEWORKS).find(([k]) => k.toLowerCase() === name.toLowerCase());
                if (hit) addFramework(out, seen, hit[1], 'C/C++', 'conanfile.txt');
            }
        }
    }
}

function detectMarkerFiles(projectRoot: string, out: Framework[], seen: Set<string>): void {
    for (const [marker, info] of Object.entries(MARKER_FILES)) {
        const full = path.join(projectRoot, marker);
        const exists = marker.endsWith('/workflows')
            ? (() => { try { return fs.statSync(full).isDirectory(); } catch { return false; } })()
            : fileExists(full);
        if (exists) addFramework(out, seen, info.name, info.language, `marker:${marker}`);
    }
}

// ─── monorepo helper — find all directories containing manifest files ───────

const MANIFEST_BASENAMES = new Set<string>([
    'package.json', 'requirements.txt', 'Pipfile', 'setup.py', 'pyproject.toml',
    'pom.xml', 'build.gradle', 'build.gradle.kts',
    'go.mod', 'Cargo.toml', 'composer.json', 'Gemfile',
    'Package.swift', 'Podfile',
    'CMakeLists.txt', 'meson.build', 'conanfile.txt', 'vcpkg.json',
]);

const SKIP_DIRS = new Set<string>([
    'node_modules', 'dist', 'build', 'out', 'target', 'coverage',
    '__pycache__', 'venv', 'env', '.venv',
    'bin', 'obj', 'vendor', 'Pods',
]);

/**
 * Walk up to `maxDepth` levels below root, collecting every directory that
 * contains a package manifest or a .csproj. Each of these is treated as a
 * separate project the detectors will run against.
 */
async function findProjectDirs(root: string, maxDepth: number = 3): Promise<string[]> {
    const result = new Set<string>([root]);

    async function walk(dir: string, depth: number): Promise<void> {
        if (depth > maxDepth) return;
        let entries;
        try {
            entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch { return; }

        let hasManifestHere = false;
        for (const e of entries) {
            if (e.isFile()) {
                if (MANIFEST_BASENAMES.has(e.name) || e.name.endsWith('.csproj')) {
                    hasManifestHere = true;
                }
            }
        }
        if (hasManifestHere) result.add(dir);

        for (const e of entries) {
            if (!e.isDirectory()) continue;
            if (e.name.startsWith('.')) continue;
            if (SKIP_DIRS.has(e.name)) continue;
            await walk(path.join(dir, e.name), depth + 1);
        }
    }

    await walk(root, 0);
    return [...result];
}

// ─── public entry point ──────────────────────────────────────────────────────

export async function collectFrameworks(projectRoot: string): Promise<Framework[]> {
    const out: Framework[] = [];
    const seen = new Set<string>();

    // Discover every directory that looks like a project (monorepo-aware).
    const dirs = await findProjectDirs(projectRoot);

    // Run all detectors against every candidate dir, in parallel.
    // Each detector is failure-isolated so one bad manifest won't kill the rest.
    const tasks: Promise<void>[] = [];
    for (const dir of dirs) {
        tasks.push(
            detectJsTs(dir, out, seen).catch(() => {}),
            detectPython(dir, out, seen).catch(() => {}),
            detectJavaKotlin(dir, out, seen).catch(() => {}),
            detectGo(dir, out, seen).catch(() => {}),
            detectRust(dir, out, seen).catch(() => {}),
            detectCSharpFrameworks(dir, out, seen).catch(() => {}),
            detectPhp(dir, out, seen).catch(() => {}),
            detectRuby(dir, out, seen).catch(() => {}),
            detectSwift(dir, out, seen).catch(() => {}),
            detectCpp(dir, out, seen).catch(() => {}),
        );
    }
    await Promise.all(tasks);

    // Marker files — checked only at root (Dockerfile, .github/workflows, etc.
    // are overwhelmingly top-level).
    detectMarkerFiles(projectRoot, out, seen);

    // Stable sort: by language, then name
    out.sort((a, b) => {
        const la = a.language ?? 'zzz';
        const lb = b.language ?? 'zzz';
        if (la !== lb) return la.localeCompare(lb);
        return a.name.localeCompare(b.name);
    });

    return out;
}
