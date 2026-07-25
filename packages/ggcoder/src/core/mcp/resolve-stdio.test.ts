import { afterEach, describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseNpxPackage,
  findPackageBinScript,
  resolveStdioCommand,
  resolveWindowsExecutable,
} from "./resolve-stdio.js";

/** Lay out a fake npx cache entry: `<cache>/_npx/<hash>/node_modules/<pkg>`
 *  with a package.json + real bin file. Returns the cache root to point
 *  `npm_config_cache` at. */
function seedNpxCache(
  cacheRoot: string,
  hash: string,
  pkgName: string,
  version: string,
  binRel = "build/index.js",
): void {
  const pkgDir = path.join(cacheRoot, "_npx", hash, "node_modules", ...pkgName.split("/"));
  fs.mkdirSync(path.join(pkgDir, path.dirname(binRel)), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, binRel), "#!/usr/bin/env node\n");
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({
      name: pkgName,
      version,
      bin: { [pkgName.split("/").pop()!]: binRel },
    }),
  );
}

describe("parseNpxPackage", () => {
  it("extracts the package from `npx -y <pkg>`", () => {
    expect(parseNpxPackage("npx", ["-y", "@kenkaiiii/kencode-search"])).toBe(
      "@kenkaiiii/kencode-search",
    );
  });

  it("extracts the package from a full npx path", () => {
    expect(parseNpxPackage("/usr/local/bin/npx", ["--yes", "some-pkg"])).toBe("some-pkg");
  });

  it("handles `npm exec <pkg>`", () => {
    expect(parseNpxPackage("npm", ["exec", "-y", "some-pkg"])).toBe("some-pkg");
  });

  it("skips `-p`/`--package` flag values to find the positional", () => {
    expect(parseNpxPackage("npx", ["-p", "helper-pkg", "real-pkg", "--", "arg"])).toBe("real-pkg");
  });

  it("returns null for non-npx commands", () => {
    expect(parseNpxPackage("node", ["server.js"])).toBeNull();
    expect(parseNpxPackage("uvx", ["mcp-server"])).toBeNull();
    expect(parseNpxPackage("npm", ["install"])).toBeNull();
  });
});

describe("findPackageBinScript", () => {
  it("resolves the kencode-search bin script from ggcoder's install", () => {
    // kencode-search is a ggcoder dependency, so its bin must resolve from here.
    const script = findPackageBinScript("@kenkaiiii/kencode-search", "kencode-search");
    expect(script).toBeTruthy();
    expect(script).toMatch(/kencode-search[/\\].*index\.js$/);
  });

  it("returns null for an unknown package", () => {
    expect(findPackageBinScript("this-package-does-not-exist-xyz", "x")).toBeNull();
  });
});

describe("resolveStdioCommand", () => {
  it("rewrites a dependency-backed npx server to `node <binScript>`", () => {
    const out = resolveStdioCommand("npx", ["-y", "@kenkaiiii/kencode-search"]);
    expect(out.command).toBe(process.execPath);
    expect(out.args).toHaveLength(1);
    expect(out.args[0]).toMatch(/kencode-search[/\\].*index\.js$/);
  });

  it("forwards server args that follow the package spec", () => {
    const out = resolveStdioCommand("npx", [
      "-y",
      "@kenkaiiii/kencode-search",
      "--",
      "--flag",
      "value",
    ]);
    expect(out.command).toBe(process.execPath);
    // [binScript, "--flag", "value"] — the `--` separator is dropped.
    expect(out.args.slice(1)).toEqual(["--flag", "value"]);
  });

  it("passes through an npx server that isn't locally resolvable", () => {
    const out = resolveStdioCommand("npx", ["-y", "@vendor/not-installed-mcp"]);
    expect(out.command).toBe("npx");
    expect(out.args).toEqual(["-y", "@vendor/not-installed-mcp"]);
  });

  it("passes through a non-npx command unchanged", () => {
    const out = resolveStdioCommand("uvx", ["some-mcp-server", "--port", "0"]);
    expect(out.command).toBe("uvx");
    expect(out.args).toEqual(["some-mcp-server", "--port", "0"]);
  });
});

describe("resolveStdioCommand npx-cache fallback (covers user-added MCPs)", () => {
  let tmp: string | undefined;
  const prevCache = process.env.npm_config_cache;

  afterEach(() => {
    if (prevCache === undefined) delete process.env.npm_config_cache;
    else process.env.npm_config_cache = prevCache;
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  it("rewrites a non-bundled but npx-cached server to `node <binScript>`", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gg-npx-cache-"));
    seedNpxCache(tmp, "hash1", "@vendor/cool-mcp", "1.0.0");
    process.env.npm_config_cache = tmp;

    const out = resolveStdioCommand("npx", ["-y", "@vendor/cool-mcp"]);
    expect(out.command).toBe(process.execPath);
    expect(out.args[0]).toMatch(/cool-mcp[/\\]build[/\\]index\.js$/);
  });

  it("honours a version pin: a mismatched cached version falls through to npx", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gg-npx-cache-"));
    seedNpxCache(tmp, "hash1", "@vendor/cool-mcp", "1.0.0");
    process.env.npm_config_cache = tmp;

    // Requested @2.0.0, only 1.0.0 cached → do NOT rewrite to the wrong version.
    const out = resolveStdioCommand("npx", ["-y", "@vendor/cool-mcp@2.0.0"]);
    expect(out.command).toBe("npx");
    expect(out.args).toEqual(["-y", "@vendor/cool-mcp@2.0.0"]);
  });

  it("uses a cached copy whose version matches the pin exactly", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gg-npx-cache-"));
    seedNpxCache(tmp, "hash1", "@vendor/cool-mcp", "2.0.0");
    process.env.npm_config_cache = tmp;

    const out = resolveStdioCommand("npx", ["-y", "@vendor/cool-mcp@2.0.0"]);
    expect(out.command).toBe(process.execPath);
    expect(out.args[0]).toMatch(/cool-mcp[/\\]build[/\\]index\.js$/);
  });

  it("picks the highest cached version when the spec is unpinned", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gg-npx-cache-"));
    seedNpxCache(tmp, "old", "@vendor/cool-mcp", "1.2.0", "build/old.js");
    seedNpxCache(tmp, "new", "@vendor/cool-mcp", "1.10.0", "build/new.js");
    process.env.npm_config_cache = tmp;

    // 1.10.0 > 1.2.0 numerically (not lexically) → the newer bin wins.
    const out = resolveStdioCommand("npx", ["-y", "@vendor/cool-mcp"]);
    expect(out.command).toBe(process.execPath);
    expect(out.args[0]).toMatch(/new\.js$/);
  });

  it("resolves a sole bin whose key differs from the package name (e.g. zai)", () => {
    // @z_ai/mcp-server exposes bin `zai-mcp-server`, NOT `mcp-server`. A sole
    // bin must be used regardless of its key, or the rewrite silently misses.
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gg-npx-cache-"));
    const pkgDir = path.join(tmp, "_npx", "h", "node_modules", "@z_ai", "mcp-server");
    fs.mkdirSync(path.join(pkgDir, "build"), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "build", "index.js"), "#!/usr/bin/env node\n");
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@z_ai/mcp-server",
        version: "0.1.4",
        bin: { "zai-mcp-server": "./build/index.js" },
      }),
    );
    process.env.npm_config_cache = tmp;

    const out = resolveStdioCommand("npx", ["-y", "@z_ai/mcp-server"]);
    expect(out.command).toBe(process.execPath);
    expect(out.args[0]).toMatch(/mcp-server[/\\]build[/\\]index\.js$/);
  });
});

describe("resolveWindowsExecutable", () => {
  const exists = (present: string[]) => (p: string) => present.includes(p);

  it("resolves a bare npx to npx.cmd via PATH x PATHEXT", () => {
    // The MCP SDK spawns with shell:false and CreateProcess ignores PATHEXT,
    // so a bare "npx" is ENOENT on Windows even though npx.cmd is right there.
    expect(
      resolveWindowsExecutable(
        "npx",
        { PATH: "C:\\nodejs;C:\\other", PATHEXT: ".com;.exe;.cmd" },
        "win32",
        exists(["C:\\nodejs\\npx.cmd"]),
      ),
    ).toBe("C:\\nodejs\\npx.cmd");
  });

  it("honors Windows' lowercase Path spelling", () => {
    expect(
      resolveWindowsExecutable(
        "npx",
        { Path: "C:\\nodejs", PATHEXT: ".cmd" },
        "win32",
        exists(["C:\\nodejs\\npx.cmd"]),
      ),
    ).toBe("C:\\nodejs\\npx.cmd");
  });

  it("never searches the current directory (no hijack by a local npx.cmd)", () => {
    expect(
      resolveWindowsExecutable(
        "npx",
        { PATH: "C:\\nodejs", PATHEXT: ".cmd" },
        "win32",
        exists(["npx.cmd"]),
      ),
    ).toBe("npx");
  });

  it("extends an explicit path in place", () => {
    expect(
      resolveWindowsExecutable(
        "C:\\tools\\server",
        { PATHEXT: ".exe" },
        "win32",
        exists(["C:\\tools\\server.exe"]),
      ),
    ).toBe("C:\\tools\\server.exe");
  });

  it("passes through off Windows, when extensioned, and when unresolvable", () => {
    expect(resolveWindowsExecutable("npx", { PATH: "/usr/bin" }, "darwin", () => true)).toBe("npx");
    expect(resolveWindowsExecutable("npx.cmd", {}, "win32", () => true)).toBe("npx.cmd");
    expect(resolveWindowsExecutable("npx", { PATH: "C:\\nodejs" }, "win32", () => false)).toBe(
      "npx",
    );
  });
});

/**
 * REAL Windows PATH resolution — runs only on an actual Windows host (the CI
 * `windows-latest` matrix leg), skipped everywhere else.
 *
 * The unit tests above inject a fake PATH and a fake `exists`, so they only
 * prove the algorithm. This proves the PREMISE: that on a real Windows box the
 * thing called `npx` on PATH is `npx.cmd`, that a bare `npx` therefore cannot
 * be spawned with `shell: false` (how the MCP SDK spawns every stdio server),
 * and that our resolution hands back something that actually runs.
 */
describe.skipIf(process.platform !== "win32")("resolveWindowsExecutable on real Windows", () => {
  it("resolves npx to a real file that a shell-less spawn can execute", () => {
    const resolved = resolveWindowsExecutable("npx");

    expect(resolved).not.toBe("npx");
    expect(fs.existsSync(resolved)).toBe(true);
    expect(path.extname(resolved).toLowerCase()).not.toBe("");

    // The bug, demonstrated: bare `npx` is ENOENT without a shell…
    const bare = spawnSync("npx", ["--version"], { shell: false, encoding: "utf8" });
    expect(bare.error).toBeDefined();
    expect((bare.error as NodeJS.ErrnoException).code).toBe("ENOENT");

    // …and the resolved path is not.
    const viaResolved = spawnSync(resolved, ["--version"], {
      shell: false,
      encoding: "utf8",
      windowsHide: true,
    });
    expect(viaResolved.error).toBeUndefined();
    expect(viaResolved.status).toBe(0);
    expect(viaResolved.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  }, 60_000);

  it("rewrites a passthrough MCP stdio config into a spawnable command", () => {
    // The single most common MCP config in the wild is `command: "npx"`. Even
    // when the package isn't locally resolvable (the passthrough branch), what
    // we hand the SDK must still be spawnable.
    const out = resolveStdioCommand("npx", ["-y", "definitely-not-a-real-package-xyz"]);
    expect(fs.existsSync(out.command)).toBe(true);
  });
});
