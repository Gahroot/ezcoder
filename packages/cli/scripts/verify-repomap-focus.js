/**
 * Smoke verification for the live repo-map focus/ranking behavior.
 *
 * Reproduces the "gg-voice is dirty but we're actively editing ezcoder" case
 * without restarting the CLI. Run:
 *   pnpm --filter @prestyj/cli verify:repomap
 */
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { FOCUSED_REPO_MAP_MAX_CHARS, buildRepoMap } from "../dist/core/repomap.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(PACKAGE_ROOT, "../..");

const READ_FILES = [
  "package.json",
  "packages/cli/package.json",
  "packages/cli/scripts/verify-edit-agent-view.ts",
  "packages/cli/scripts/verify-edit-pomodoro.ts",
  "packages/cli/src/core/agent-session.ts",
  "packages/cli/src/core/repomap.test.ts",
  "packages/cli/src/core/repomap.ts",
  "packages/cli/tsconfig.json",
];

const GGCODER_CHANGED_FILES = [
  "packages/cli/package.json",
  "packages/cli/src/core/repomap.test.ts",
  "packages/cli/src/core/repomap.ts",
  "packages/cli/tsconfig.json",
  "packages/cli/src/cli.ts",
  "packages/cli/src/core/agent-session.ts",
  "packages/cli/src/core/repomap-context.test.ts",
  "packages/cli/src/core/repomap-context.ts",
  "packages/cli/src/tools/index.ts",
  "packages/cli/src/tools/read.ts",
  "packages/cli/src/ui/App.tsx",
  "packages/cli/src/ui/render.ts",
];

const OTHER_CHANGED_FILES = [
  ...Array.from({ length: 16 }, (_, index) => `packages/voice/src/dirty-${index}.ts`),
  ...Array.from({ length: 5 }, (_, index) => `packages/ai/src/dirty-${index}.ts`),
  "packages/agent/src/dirty.ts",
  "packages/boss/src/dirty.ts",
];

const EXPECTED_TOP_SOURCE_FILES = [
  "packages/cli/src/core/agent-session.ts",
  "packages/cli/src/core/repomap.test.ts",
  "packages/cli/src/core/repomap.ts",
];

const checks = [];

function record(name, pass, detail = "") {
  checks.push({ name, pass, detail });
  process.stdout.write(`[${pass ? "PASS" : "FAIL"}] ${name}\n`);
  if (detail) process.stdout.write(`       ${detail.replace(/\n/g, "\n       ")}\n`);
}

function isGgCoderPath(filePath) {
  return filePath === "package.json" || filePath.startsWith("packages/cli/");
}

async function main() {
  const rendered = await buildRepoMap({
    cwd: REPO_ROOT,
    maxChars: FOCUSED_REPO_MAP_MAX_CHARS,
    readFiles: READ_FILES,
    focusTerms: [
      "Why is it focused on gg-voice? We're not even actively working on that. We're adjusting ezcoder right now.",
    ],
    now: new Date("2026-01-01T00:00:00.000Z"),
    listGitChangedFiles: async () => [...GGCODER_CHANGED_FILES, ...OTHER_CHANGED_FILES],
  });

  const paths = rendered.snapshot.files.map((file) => file.path);
  process.stdout.write("\nRendered repo map:\n");
  process.stdout.write(`${rendered.markdown}\n\n`);

  record(
    "active package is ezcoder",
    JSON.stringify(rendered.snapshot.activeRoots) === JSON.stringify(["packages/cli"]),
    JSON.stringify(rendered.snapshot.activeRoots),
  );
  record(
    "gg-voice is summarized as other dirty package",
    rendered.markdown.includes("Other dirty packages: gg-voice(16)"),
  );
  record(
    "no gg-voice files are rendered",
    paths.every((filePath) => !filePath.startsWith("packages/voice/")),
  );
  record(
    "rendered files stay in ezcoder/root context",
    paths.every(isGgCoderPath),
    paths.filter((filePath) => !isGgCoderPath(filePath)).join("\n"),
  );
  record(
    "actively read+changed source files lead the ranking",
    EXPECTED_TOP_SOURCE_FILES.every((filePath) => paths.slice(0, 3).includes(filePath)),
    paths.slice(0, 8).join("\n"),
  );
  record(
    "broad App.tsx does not lead",
    paths[0] !== "packages/cli/src/ui/App.tsx",
    paths[0] ?? "",
  );

  const failed = checks.filter((check) => !check.pass);
  if (failed.length > 0) {
    process.stderr.write(`\n${failed.length} repo-map focus check(s) failed.\n`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
