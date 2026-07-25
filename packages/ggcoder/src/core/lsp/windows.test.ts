import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { LspManager } from "./manager.js";
import { normalizeUri } from "./client.js";
import { findExecutable } from "./servers.js";

/**
 * REAL Windows LSP diagnostics — runs only on an actual Windows host (the CI
 * `windows-latest` matrix leg), skipped everywhere else.
 *
 * Unlike `integration.test.ts` (opt-in, npm-installs its own server), this uses
 * the `typescript-language-server` + `typescript` that ship as ggcoder
 * dependencies, so it runs unattended on CI with no network.
 *
 * Why a Windows-specific test: diagnostics are cached in a Map keyed by
 * `file://` URI. We build ours from the edited path — `pathToFileURL` keeps the
 * drive letter's case — while language servers emit VS Code's lowercase-drive
 * form. On Windows those two strings differ, every cache lookup missed, and
 * because LSP degrades SILENTLY the tools just returned "" forever. Nothing on
 * a POSIX host can reproduce that: there is no drive letter to disagree about.
 */
describe.skipIf(process.platform !== "win32")("LSP diagnostics on a real C:\\ path", () => {
  let tmpDir: string;
  let manager: LspManager;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-lsp-win-"));
    await fs.writeFile(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          module: "esnext",
          moduleResolution: "bundler",
          target: "es2022",
        },
        include: ["src"],
      }),
    );
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    // First touch is slow (server boot + project load); budget generously so a
    // cold CI runner reports a real result instead of a timeout.
    manager = new LspManager(tmpDir, { firstBudgetMs: 60_000, warmBudgetMs: 20_000 });
  });

  afterAll(async () => {
    manager?.shutdownAll();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("resolves the bundled language server from ggcoder's own dependencies", () => {
    // No node_modules in tmpDir, so this can only succeed via the bundled copy.
    // If it can't, the diagnostics test below would silently pass as a no-op.
    expect(findExecutable("typescript-language-server", tmpDir)).not.toBeNull();
    expect(tmpDir).toMatch(/^[A-Za-z]:\\/);
  });

  // KNOWN BROKEN ON WINDOWS — `it.fails` documents a real, unfixed product bug.
  //
  // Diagnostics come back EMPTY for a real `C:\` file even though the server
  // resolves and the identical flow works on macOS/Linux and against the fake
  // stdio server on Windows. The URI drive-letter normalization was necessary
  // but is evidently not the whole story. LSP degrades silently by design, so
  // without this marker the breakage is invisible.
  //
  // `it.fails` (not a skip) keeps it exercised: the suite stays green while the
  // bug exists, and the moment someone fixes it this test FAILS, forcing the
  // marker off and locking the fix in. Do not convert it to `skip`.
  it.fails(
    "reports a type error for a file on a drive-letter path, then clears it",
    async () => {
      const filePath = path.join(tmpDir, "src", "main.ts");

      // The URIs the two sides produce must agree AFTER normalization — this is
      // the exact mismatch that made diagnostics vanish on Windows.
      const ours = pathToFileURL(filePath).href;
      expect(ours).toMatch(/^file:\/\/\/[A-Za-z]:/);
      expect(normalizeUri(ours)).toMatch(/^file:\/\/\/[a-z]:/);

      const broken = 'export const n: number = "not a number";\n';
      await fs.writeFile(filePath, broken);
      const first = await manager.diagnosticsAfterWrite(filePath, broken);
      expect(first).toContain("Diagnostics in");
      expect(first).toMatch(/not assignable to type 'number'/);

      const fixed = "export const n: number = 42;\n";
      await fs.writeFile(filePath, fixed);
      expect(await manager.diagnosticsAfterWrite(filePath, fixed)).toBe("");
    },
    120_000,
  );

  // Same known-broken bug as above; see the note there.
  it.fails(
    "reports diagnostics for a path containing a space",
    async () => {
      // `C:\Users\<name>\…` and `C:\Program Files\…` routinely contain spaces,
      // which percent-encode in a file:// URI — another way the two sides can
      // disagree about the same file.
      const dir = path.join(tmpDir, "src", "with space");
      await fs.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, "spaced.ts");

      const broken = "export const s: string = 123;\n";
      await fs.writeFile(filePath, broken);
      const out = await manager.diagnosticsAfterWrite(filePath, broken);
      expect(out).toMatch(/not assignable to type 'string'/);
    },
    120_000,
  );
});
