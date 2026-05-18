import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import ignore from "ignore";

export interface RepoMapOptions {
  cwd: string;
  maxFiles?: number;
  maxSymbolsPerFile?: number;
  maxChars?: number;
  changedFiles?: readonly string[];
  focusTerms?: readonly string[];
  now?: Date;
  cache?: RepoMapCache;
  readFile?: (absolutePath: string) => Promise<string>;
}

export interface RepoMapFile {
  path: string;
  language: string;
  exports: string[];
  symbols: string[];
  imports: string[];
  mtimeMs: number;
  size: number;
}

export interface RepoMapStats {
  indexedFiles: number;
  shownFiles: number;
  totalSymbols: number;
  renderedChars: number;
  truncated: boolean;
}

export interface RepoMapSnapshot {
  version: number;
  createdAt: string;
  files: RepoMapFile[];
  stats: RepoMapStats;
  changedFiles: string[];
  truncated: boolean;
}

export interface RenderedRepoMap {
  snapshot: RepoMapSnapshot;
  markdown: string;
}

export interface RepoMapCacheEntry {
  file: RepoMapFile;
  maxSymbolsPerFile: number;
}

export interface RepoMapCache {
  files: Map<string, RepoMapCacheEntry>;
}

const DEFAULT_MAX_FILES = 80;
const DEFAULT_MAX_SYMBOLS_PER_FILE = 8;
const DEFAULT_MAX_CHARS = 6000;
const MAX_FILE_SIZE_BYTES = 200_000;
const REPO_MAP_VERSION = 1;

export function createRepoMapCache(): RepoMapCache {
  return { files: new Map() };
}

const IGNORE_PATTERNS = [
  "**/.git/**",
  "**/.gg/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.next/**",
  "**/.turbo/**",
  "**/.cache/**",
  "**/vendor/**",
  "**/*.lock",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
];

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".tgz",
  ".wasm",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".mp3",
  ".mp4",
  ".mov",
]);

const LANGUAGE_BY_EXTENSION = new Map<string, string>([
  [".ts", "TypeScript"],
  [".tsx", "TypeScript React"],
  [".js", "JavaScript"],
  [".jsx", "JavaScript React"],
  [".mjs", "JavaScript"],
  [".cjs", "JavaScript"],
  [".json", "JSON"],
  [".md", "Markdown"],
  [".py", "Python"],
  [".go", "Go"],
  [".rs", "Rust"],
  [".css", "CSS"],
]);

export async function buildRepoMap(options: RepoMapOptions): Promise<RenderedRepoMap> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxSymbolsPerFile = options.maxSymbolsPerFile ?? DEFAULT_MAX_SYMBOLS_PER_FILE;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const changedFiles = normalizeRelativePaths(options.cwd, options.changedFiles ?? []);
  const focusTerms = normalizeFocusTerms(options.focusTerms ?? []);
  const createdAt = (options.now ?? new Date()).toISOString();
  const cache = options.cache;
  const readFile =
    options.readFile ?? ((absolutePath: string) => fs.readFile(absolutePath, "utf-8"));

  const entries = await listCandidateFiles(options.cwd);
  const entrySet = new Set(entries);
  if (cache) {
    for (const cachedPath of cache.files.keys()) {
      if (!entrySet.has(cachedPath)) cache.files.delete(cachedPath);
    }
  }

  const files: RepoMapFile[] = [];

  for (const entry of entries) {
    const absolute = path.join(options.cwd, entry);
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat?.isFile() || stat.size > MAX_FILE_SIZE_BYTES) {
      cache?.files.delete(entry);
      continue;
    }

    const cached = cache?.files.get(entry);
    if (
      cached &&
      cached.maxSymbolsPerFile === maxSymbolsPerFile &&
      cached.file.mtimeMs === stat.mtimeMs &&
      cached.file.size === stat.size
    ) {
      files.push(cached.file);
      continue;
    }

    const language = detectLanguage(entry);
    const shouldRead = isTextExtension(entry);
    const content = shouldRead ? await readFile(absolute).catch(() => "") : "";
    const extracted = extractFileFacts(entry, content, maxSymbolsPerFile);
    const file: RepoMapFile = {
      path: entry,
      language,
      exports: extracted.exports,
      symbols: extracted.symbols,
      imports: extracted.imports,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    };
    files.push(file);
    cache?.files.set(entry, { file, maxSymbolsPerFile });
  }

  const ranked = rankRepoMapFiles(files, { changedFiles, focusTerms }).slice(0, maxFiles);
  const snapshot = createSnapshot(ranked, files.length, changedFiles, createdAt, maxChars);
  const markdown = renderRepoMap(snapshot, maxChars);
  const renderedStats = { ...snapshot.stats, renderedChars: markdown.length };
  const renderedSnapshot = {
    ...snapshot,
    stats: renderedStats,
    truncated: snapshot.truncated || renderedStats.truncated,
  };

  return { snapshot: renderedSnapshot, markdown };
}

export function extractFileFacts(
  filePath: string,
  content: string,
  maxSymbolsPerFile = DEFAULT_MAX_SYMBOLS_PER_FILE,
): Pick<RepoMapFile, "exports" | "symbols" | "imports"> {
  if (!isCodeLike(filePath) || content.length === 0) {
    return { exports: [], symbols: [], imports: [] };
  }

  const imports = unique([
    ...matchAll(content, /import\s+(?:type\s+)?(?:[^"'\n]+?\s+from\s+)?["']([^"']+)["']/g),
    ...matchAll(content, /export\s+[^"'\n]+?\s+from\s+["']([^"']+)["']/g),
    ...matchAll(content, /require\(["']([^"']+)["']\)/g),
  ]).slice(0, maxSymbolsPerFile);

  const exportedDeclarations = matchNamedDeclarations(
    content,
    /export\s+(?:async\s+)?(?:function|class|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  );
  const namedExports = matchExportLists(content);
  const symbols = unique([
    ...exportedDeclarations,
    ...matchNamedDeclarations(content, /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g),
    ...matchNamedDeclarations(content, /(?:^|\n)\s*class\s+([A-Za-z_$][\w$]*)/g),
    ...matchNamedDeclarations(content, /(?:^|\n)\s*interface\s+([A-Za-z_$][\w$]*)/g),
    ...matchNamedDeclarations(content, /(?:^|\n)\s*type\s+([A-Za-z_$][\w$]*)/g),
    ...matchNamedDeclarations(content, /(?:^|\n)\s*const\s+([A-Za-z_$][\w$]*)\s*=/g),
  ]).slice(0, maxSymbolsPerFile);

  return {
    exports: unique([...exportedDeclarations, ...namedExports]).slice(0, maxSymbolsPerFile),
    symbols,
    imports,
  };
}

export function rankRepoMapFiles(
  files: readonly RepoMapFile[],
  context: { changedFiles: readonly string[]; focusTerms: readonly string[] },
): RepoMapFile[] {
  const changed = new Set(context.changedFiles);
  return [...files].sort((a, b) => {
    const scoreDelta =
      scoreFile(b, changed, context.focusTerms) - scoreFile(a, changed, context.focusTerms);
    if (scoreDelta !== 0) return scoreDelta;
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return a.path.localeCompare(b.path);
  });
}

export function renderRepoMap(snapshot: RepoMapSnapshot, maxChars = DEFAULT_MAX_CHARS): string {
  const lines = [
    "<!-- gg-repomap -->",
    "## Dynamic Repo Map",
    "Repository symbol map for navigation; entries may be incomplete or stale.",
  ];

  if (snapshot.changedFiles.length > 0) {
    lines.push(`Recently changed: ${snapshot.changedFiles.join(", ")}`);
  }

  for (const file of snapshot.files) {
    const parts = [`${file.path} (${file.language}, ${formatBytes(file.size)})`];
    if (file.exports.length > 0) parts.push(`exports: ${file.exports.join(", ")}`);
    if (file.symbols.length > 0) parts.push(`symbols: ${file.symbols.join(", ")}`);
    if (file.imports.length > 0) parts.push(`imports: ${file.imports.join(", ")}`);
    lines.push(`- ${parts.join(" — ")}`);
  }

  let markdown = lines.join("\n");
  const truncated = markdown.length > maxChars;
  if (truncated) {
    const suffix = "\n… truncated to repo map budget.";
    markdown = markdown.slice(0, Math.max(0, maxChars - suffix.length)).trimEnd() + suffix;
  }
  return markdown;
}

function createSnapshot(
  files: RepoMapFile[],
  indexedFiles: number,
  changedFiles: string[],
  createdAt: string,
  maxChars: number,
): RepoMapSnapshot {
  const totalSymbols = files.reduce(
    (sum, file) => sum + file.symbols.length + file.exports.length,
    0,
  );
  const initial: RepoMapSnapshot = {
    version: REPO_MAP_VERSION,
    createdAt,
    files,
    changedFiles,
    stats: {
      indexedFiles,
      shownFiles: files.length,
      totalSymbols,
      renderedChars: 0,
      truncated: files.length < indexedFiles,
    },
    truncated: files.length < indexedFiles,
  };
  const markdown = renderRepoMap(initial, maxChars);
  const truncated = initial.truncated || markdown.includes("truncated to repo map budget");
  return {
    ...initial,
    stats: { ...initial.stats, renderedChars: markdown.length, truncated },
    truncated,
  };
}

async function listCandidateFiles(cwd: string): Promise<string[]> {
  const ignorePatterns = await loadGitignore(cwd);
  const ig = ignore().add(ignorePatterns);
  const entries = await fg("**/*", {
    cwd,
    dot: false,
    onlyFiles: true,
    ignore: IGNORE_PATTERNS,
  });
  return entries
    .filter((entry) => !BINARY_EXTENSIONS.has(path.extname(entry).toLowerCase()))
    .filter((entry) => !ig.ignores(entry))
    .sort((a, b) => a.localeCompare(b));
}

async function loadGitignore(cwd: string): Promise<string[]> {
  const content = await fs.readFile(path.join(cwd, ".gitignore"), "utf-8").catch(() => "");
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function detectLanguage(filePath: string): string {
  return LANGUAGE_BY_EXTENSION.get(path.extname(filePath).toLowerCase()) ?? "Text";
}

function isTextExtension(filePath: string): boolean {
  return !BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isCodeLike(filePath: string): boolean {
  return [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(
    path.extname(filePath).toLowerCase(),
  );
}

function matchAll(content: string, regexp: RegExp): string[] {
  return [...content.matchAll(regexp)].map((match) => match[1]).filter(isPresent);
}

function matchNamedDeclarations(content: string, regexp: RegExp): string[] {
  return matchAll(content, regexp);
}

function matchExportLists(content: string): string[] {
  const names: string[] = [];
  for (const match of content.matchAll(/export\s*\{([^}]+)\}/g)) {
    const list = match[1];
    if (!list) continue;
    for (const raw of list.split(",")) {
      const name = raw
        .trim()
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (name) names.push(name);
    }
  }
  return names;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function isPresent(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function scoreFile(
  file: RepoMapFile,
  changedFiles: ReadonlySet<string>,
  focusTerms: readonly string[],
): number {
  let score = 0;
  if (changedFiles.has(file.path)) score += 1000;
  if (isEntrypoint(file.path)) score += 150;
  if (file.path.startsWith("src/") || file.path.includes("/src/")) score += 80;
  score += Math.min(120, (file.exports.length + file.symbols.length) * 10);
  score -=
    isTestFile(file.path) && !focusTerms.includes("test") && !focusTerms.includes("tests") ? 80 : 0;
  score -= file.size > 100_000 ? 50 : 0;
  const searchable =
    `${file.path} ${file.exports.join(" ")} ${file.symbols.join(" ")}`.toLowerCase();
  for (const term of focusTerms) {
    if (searchable.includes(term)) score += 200;
  }
  return score;
}

function isEntrypoint(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  return ["package.json", "index.ts", "index.tsx", "index.js", "cli.ts", "main.ts"].includes(base);
}

function isTestFile(filePath: string): boolean {
  return /(?:^|\/|\.)(test|spec)\.[jt]sx?$/.test(filePath) || filePath.includes("__tests__");
}

function normalizeFocusTerms(terms: readonly string[]): string[] {
  return unique(
    terms
      .flatMap((term) => term.toLowerCase().split(/[^a-z0-9_$-]+/))
      .filter((term) => term.length >= 3),
  );
}

function normalizeRelativePaths(cwd: string, files: readonly string[]): string[] {
  return unique(
    files.map((file) => {
      const absolute = path.isAbsolute(file) ? file : path.join(cwd, file);
      return path.relative(cwd, absolute).split(path.sep).join("/");
    }),
  ).sort((a, b) => a.localeCompare(b));
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size}B`;
  return `${Math.round(size / 1024)}KB`;
}
