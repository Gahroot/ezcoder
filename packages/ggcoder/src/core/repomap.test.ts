import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRepoMap,
  createRepoMapCache,
  extractFileFacts,
  rankRepoMapFiles,
  renderRepoMap,
  type RepoMapFile,
} from "./repomap.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("repomap", () => {
  it("extracts TypeScript imports, exports, and symbols", () => {
    const facts = extractFileFacts(
      "src/example.ts",
      `import path from "node:path";
import { helper } from "./helper";
export { helper as renamed } from "./helper";
export interface User { id: string }
export type UserId = string;
export class Service {}
export function run() {}
const internal = 1;
function localFn() {}
`,
    );

    expect(facts.imports).toEqual(["node:path", "./helper"]);
    expect(facts.exports).toEqual(["User", "UserId", "Service", "run", "helper"]);
    expect(facts.symbols).toContain("Service");
    expect(facts.symbols).toContain("localFn");
  });

  it("respects gitignore, build directories, and file size cap", async () => {
    const cwd = await makeFixture({
      ".gitignore": "ignored.ts\n",
      "src/keep.ts": "export const keep = true;\n",
      "ignored.ts": "export const ignored = true;\n",
      "dist/built.ts": "export const built = true;\n",
      "src/huge.ts": `export const huge = "${"x".repeat(210_000)}";`,
    });

    const { snapshot } = await buildRepoMap({ cwd, now: new Date("2026-01-01T00:00:00.000Z") });
    const paths = snapshot.files.map((file) => file.path);

    expect(paths).toContain("src/keep.ts");
    expect(paths).not.toContain("ignored.ts");
    expect(paths).not.toContain("dist/built.ts");
    expect(paths).not.toContain("src/huge.ts");
  });

  it("ranks changed and focused files above unrelated files", () => {
    const files: RepoMapFile[] = [
      file("src/unrelated.ts", ["alpha"]),
      file("docs/readme.md", []),
      file("src/repomap.ts", ["buildRepoMap"]),
      file("src/changed.ts", []),
    ];

    const ranked = rankRepoMapFiles(files, {
      changedFiles: ["src/changed.ts"],
      focusTerms: ["repomap"],
    });

    expect(ranked[0]?.path).toBe("src/changed.ts");
    expect(ranked[1]?.path).toBe("src/repomap.ts");
  });

  it("enforces max char budget and reports truncation", async () => {
    const cwd = await makeFixture({
      "src/a.ts": "export const alpha = 1;\nexport const beta = 2;\n",
      "src/b.ts": "export const gamma = 3;\nexport const delta = 4;\n",
    });

    const { snapshot, markdown } = await buildRepoMap({
      cwd,
      maxChars: 220,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(markdown.length).toBeLessThanOrEqual(220);
    expect(snapshot.stats.truncated).toBe(true);
    expect(markdown).toContain("truncated to repo map budget");
  });

  it("renders stats and navigation warning", () => {
    const markdown = renderRepoMap(
      {
        version: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        files: [file("src/index.ts", ["main"])],
        changedFiles: ["src/index.ts"],
        stats: {
          indexedFiles: 1,
          shownFiles: 1,
          totalSymbols: 1,
          renderedChars: 0,
          truncated: false,
        },
        truncated: false,
      },
      1000,
    );

    expect(markdown).toContain("<!-- gg-repomap -->");
    expect(markdown).toContain("## Dynamic Repo Map");
    expect(markdown).not.toContain("indexedFiles=1");
    expect(markdown).not.toContain("Generated:");
    expect(markdown).toContain("Recently changed: src/index.ts");
    expect(markdown).toContain("Repository symbol map for navigation");
  });

  it("keeps default rendered map under the injection budget", async () => {
    const cwd = await makeFixture(
      Object.fromEntries(
        Array.from({ length: 120 }, (_, index) => [
          `src/file-${index}.ts`,
          `export const symbol${index} = ${index};\n`,
        ]),
      ),
    );

    const { markdown, snapshot } = await buildRepoMap({
      cwd,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(markdown.length).toBeLessThanOrEqual(6000);
    expect(snapshot.stats.renderedChars).toBeLessThanOrEqual(6000);
  });

  it("shows changed files after mutation callbacks record them", async () => {
    const cwd = await makeFixture({
      "src/changed.ts": "export const changed = true;\n",
      "src/other.ts": "export const other = true;\n",
    });

    const { markdown, snapshot } = await buildRepoMap({
      cwd,
      changedFiles: [path.join(cwd, "src/changed.ts")],
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(snapshot.changedFiles).toEqual(["src/changed.ts"]);
    expect(markdown).toContain("Recently changed: src/changed.ts");
    expect(snapshot.files[0]?.path).toBe("src/changed.ts");
  });

  it("reuses cached file facts when files are unchanged", async () => {
    const cwd = await makeFixture({
      "src/a.ts": "export const alpha = 1;\n",
      "src/b.ts": "export const beta = 2;\n",
    });
    const cache = createRepoMapCache();
    const reads: string[] = [];
    const readFile = async (absolutePath: string): Promise<string> => {
      reads.push(path.relative(cwd, absolutePath).split(path.sep).join("/"));
      return fs.readFile(absolutePath, "utf-8");
    };

    await buildRepoMap({ cwd, cache, readFile, now: new Date("2026-01-01T00:00:00.000Z") });
    await buildRepoMap({ cwd, cache, readFile, now: new Date("2026-01-01T00:00:01.000Z") });

    expect(reads.sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(cache.files.size).toBe(2);
  });

  it("re-reads only changed files when cache metadata changes", async () => {
    const cwd = await makeFixture({
      "src/a.ts": "export const alpha = 1;\n",
      "src/b.ts": "export const beta = 2;\n",
    });
    const cache = createRepoMapCache();
    const reads: string[] = [];
    const readFile = async (absolutePath: string): Promise<string> => {
      reads.push(path.relative(cwd, absolutePath).split(path.sep).join("/"));
      return fs.readFile(absolutePath, "utf-8");
    };

    await buildRepoMap({ cwd, cache, readFile, now: new Date("2026-01-01T00:00:00.000Z") });
    reads.length = 0;
    await fs.writeFile(
      path.join(cwd, "src/b.ts"),
      "export const beta = 3;\nexport const changed = true;\n",
    );
    const future = new Date(Date.now() + 5_000);
    await fs.utimes(path.join(cwd, "src/b.ts"), future, future);

    const { markdown } = await buildRepoMap({
      cwd,
      cache,
      readFile,
      now: new Date("2026-01-01T00:00:01.000Z"),
    });

    expect(reads).toEqual(["src/b.ts"]);
    expect(markdown).toContain("changed");
  });
});

async function makeFixture(files: Record<string, string>): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gg-repomap-"));
  tempDirs.push(cwd);
  await Promise.all(
    Object.entries(files).map(async ([relativePath, content]) => {
      const absolute = path.join(cwd, relativePath);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, content, "utf-8");
    }),
  );
  return cwd;
}

function file(filePath: string, symbols: string[]): RepoMapFile {
  return {
    path: filePath,
    language: "TypeScript",
    exports: symbols,
    symbols,
    imports: [],
    mtimeMs: 1,
    size: 100,
  };
}
