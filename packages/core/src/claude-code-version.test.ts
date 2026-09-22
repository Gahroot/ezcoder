import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// getAppPaths() decides where the version cache lives; point it at a temp dir so
// these tests never read or clobber the developer's real ~/.ezcoder cache.
let tmpDir: string;
vi.mock("./paths.js", () => ({
  getAppPaths: () => ({ agentDir: tmpDir }),
}));

const NPM_URL = "https://registry.npmjs.org/@anthropic-ai/claude-code/latest";

async function freshModule() {
  vi.resetModules();
  return import("./claude-code-version.js");
}

function mockNpm(version: string | null) {
  const fetchMock = vi.fn(async () =>
    version === null
      ? ({ ok: false, status: 500, json: async () => ({}) } as unknown as Response)
      : ({ ok: true, status: 200, json: async () => ({ version }) } as unknown as Response),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function writeCache(value: Record<string, unknown>): Promise<void> {
  await fs.mkdir(tmpDir, { recursive: true });
  await fs.writeFile(path.join(tmpDir, "claude-code-version.json"), JSON.stringify(value), "utf-8");
}

async function readCache(): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(path.join(tmpDir, "claude-code-version.json"), "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ccv-test-"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("getClaudeCodeVersion", () => {
  it("fetches the live version from npm when there is no cache, and persists it", async () => {
    const fetchMock = mockNpm("2.1.280");
    const mod = await freshModule();

    expect(await mod.getClaudeCodeVersion()).toBe("2.1.280");
    expect(fetchMock).toHaveBeenCalledWith(NPM_URL, expect.anything());
    expect(await readCache()).toMatchObject({ version: "2.1.280" });
  });

  it("serves a fresh disk cache without hitting npm", async () => {
    await writeCache({ version: "2.1.280", fetchedAt: Date.now() });
    const fetchMock = mockNpm("2.1.999");
    const mod = await freshModule();

    expect(await mod.getClaudeCodeVersion()).toBe("2.1.280");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes in the background once the cache goes stale, so the next run is current", async () => {
    // The regression: a model that requires a newer client shipped while this
    // cache was still inside its TTL, and the user stayed locked out. A stale
    // entry must still answer instantly, but must not stay stale.
    const staleAt = Date.now() - 2 * 60 * 60 * 1000;
    await writeCache({ version: "2.1.278", fetchedAt: staleAt });
    const fetchMock = mockNpm("2.1.280");
    const mod = await freshModule();

    // Answers immediately from cache — no blocking network call on the hot path.
    expect(await mod.getClaudeCodeVersion()).toBe("2.1.278");

    await vi.waitFor(async () => {
      expect(fetchMock).toHaveBeenCalled();
      expect(await readCache()).toMatchObject({ version: "2.1.280" });
    });
  });

  it("blocks on a refresh rather than serving a very old cache", async () => {
    await writeCache({ version: "2.1.100", fetchedAt: Date.now() - 30 * 24 * 60 * 60 * 1000 });
    mockNpm("2.1.280");
    const mod = await freshModule();

    expect(await mod.getClaudeCodeVersion()).toBe("2.1.280");
  });

  it("falls back to the stale cache when npm is unreachable", async () => {
    await writeCache({ version: "2.1.277", fetchedAt: Date.now() - 30 * 24 * 60 * 60 * 1000 });
    mockNpm(null);
    const mod = await freshModule();

    expect(await mod.getClaudeCodeVersion()).toBe("2.1.277");
  });

  it("uses the bundled fallback when there is no cache and npm is unreachable", async () => {
    mockNpm(null);
    const mod = await freshModule();

    // Whatever the constant is, it must be recent enough to run the models this
    // release ships as defaults.
    expect(
      mod.compareClaudeCodeVersions(await mod.getClaudeCodeVersion(), "2.1.280"),
    ).toBeGreaterThanOrEqual(0);
  });
});

describe("recordRequiredClaudeCodeVersion", () => {
  it("pins the floor Anthropic demands so the very next request satisfies it", async () => {
    await writeCache({ version: "2.1.278", fetchedAt: Date.now() });
    mockNpm("2.1.278");
    const mod = await freshModule();

    expect(await mod.getClaudeCodeVersion()).toBe("2.1.278");

    const recorded = mod.recordRequiredClaudeCodeVersion(
      "Claude Code 2.1.278 does not support this model; version 2.1.280 or newer is required. Run 'claude update'.",
    );
    expect(recorded).toBe("2.1.280");

    // Self-heals without waiting for the npm cache to catch up.
    expect(await mod.getClaudeCodeVersion()).toBe("2.1.280");
    expect(await mod.getClaudeCliUserAgent()).toBe("claude-cli/2.1.280 (external, cli)");
  });

  it("persists the floor so a restarted process is not locked out again", async () => {
    mockNpm("2.1.278");
    const first = await freshModule();
    first.recordRequiredClaudeCodeVersion("version 2.1.280 or newer is required");
    expect(await first.getClaudeCodeVersion()).toBe("2.1.280");

    const restarted = await freshModule();
    expect(await restarted.getClaudeCodeVersion()).toBe("2.1.280");
  });

  it("never drags the version backwards when npm is already ahead of the floor", async () => {
    await writeCache({ version: "2.2.0", fetchedAt: Date.now() });
    mockNpm("2.2.0");
    const mod = await freshModule();

    mod.recordRequiredClaudeCodeVersion("version 2.1.280 or newer is required");
    expect(await mod.getClaudeCodeVersion()).toBe("2.2.0");
  });

  it("ignores unrelated provider errors", async () => {
    mockNpm("2.1.280");
    const mod = await freshModule();

    expect(mod.recordRequiredClaudeCodeVersion("overloaded_error: server busy")).toBeNull();
    expect(mod.recordRequiredClaudeCodeVersion("")).toBeNull();
  });
});

describe("compareClaudeCodeVersions", () => {
  it("orders versions numerically, not lexically", () => {
    // "2.1.9" > "2.1.280" under string comparison — the trap this guards.
    return import("./claude-code-version.js").then(({ compareClaudeCodeVersions: cmp }) => {
      expect(cmp("2.1.280", "2.1.9")).toBeGreaterThan(0);
      expect(cmp("2.1.278", "2.1.280")).toBeLessThan(0);
      expect(cmp("2.1.280", "2.1.280")).toBe(0);
      expect(cmp("2.2.0", "2.1.280")).toBeGreaterThan(0);
      expect(cmp("3.0.0", "2.9.9")).toBeGreaterThan(0);
    });
  });
});
