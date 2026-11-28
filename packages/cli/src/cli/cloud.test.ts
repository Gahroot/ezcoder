import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCloudSettings, writeCloudSettings } from "../core/cloud/config.js";
import type { CloudAvailability, CloudProvider } from "../core/cloud/types.js";
import { describeCloudStatus, runCloud, type CloudCliDeps } from "./cloud.js";

let tmp: string;
let file: string;
let lines: string[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ez-cloud-cli-"));
  file = path.join(tmp, "cloud.json");
  lines = [];
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exitCode = undefined;
});

const avail: CloudAvailability[] = [
  {
    id: "claude-cloud",
    available: true,
    account: "me@example.com (Max)",
    environmentId: "env_1",
    environmentName: "Default",
    detail: "ok",
  },
  {
    id: "codex-cloud",
    available: false,
    detail: "no Codex cloud environment",
    setupHint: "create one at chatgpt.com/codex",
  },
];

function deps(over: CloudCliDeps = {}): CloudCliDeps {
  return {
    file,
    state: () => ({}),
    availability: async () => avail,
    out: (l) => lines.push(l),
    ...over,
  };
}

describe("ezcoder cloud settings", () => {
  it("edits ~/.ezcoder/cloud.json atomically and keeps other fields", async () => {
    writeCloudSettings({ providers: { "claude-cloud": { maxConcurrent: 2 } } }, file);
    await runCloud(["off", "codex"], deps());
    await runCloud(["use", "validation,jobs"], deps());
    await runCloud(["when", "always"], deps());
    await runCloud(["limit", "60"], deps());
    expect(readCloudSettings(file)).toEqual({
      providers: {
        "claude-cloud": { maxConcurrent: 2 },
        "codex-cloud": { enabled: false },
      },
      use: ["validation", "jobs"],
      when: "always",
      maxPlanUtilization: 0.6,
    });
    expect(fs.readdirSync(tmp)).toEqual(["cloud.json"]); // no temp files left
    await runCloud(["off"], deps());
    expect(readCloudSettings(file).enabled).toBe(false);
    await runCloud(["on", "codex"], deps());
    expect(readCloudSettings(file)).toMatchObject({
      enabled: true,
      providers: { "codex-cloud": { enabled: true } },
    });
  });

  it("rejects bad values without writing", async () => {
    await expect(runCloud(["when", "sometimes"], deps())).rejects.toThrow(/overflow/);
    await expect(runCloud(["use", "gpu"], deps())).rejects.toThrow(/validation/);
    await expect(runCloud(["limit", "150"], deps())).rejects.toThrow(/percent/);
    await expect(runCloud(["on", "gemini"], deps())).rejects.toThrow(/unknown/);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("sets up the Claude environment on request", async () => {
    let calls = 0;
    await runCloud(
      ["setup", "claude"],
      deps({
        setupClaude: async () => {
          calls++;
          return { environmentId: "env_9", name: "Default" };
        },
      }),
    );
    expect(calls).toBe(1);
    expect(lines.join("\n")).toMatch(/env_9/);
  });
});

describe("ezcoder cloud status", () => {
  it("prints each provider with account, environment, usage and setup hint", async () => {
    const at = new Date().toISOString();
    const until = new Date(Date.now() + 3_600_000).toISOString();
    await runCloud(
      ["status"],
      deps({
        state: () => ({
          utilization: { "claude-cloud": { value: 0.31, at } },
          benched: { "codex-cloud": { until, reason: "usage limit" } },
        }),
      }),
    );
    const text = lines.join("\n");
    expect(text).toMatch(/Cloud: overflow .*runs validation, jobs, agents; plan cap 80%/);
    expect(text).toMatch(/claude-cloud \(Claude Code cloud\): connected/);
    expect(text).toContain("account: me@example.com (Max)");
    expect(text).toContain("environment: Default env_1");
    expect(text).toMatch(/plan used: 31%/);
    expect(text).toMatch(/used for: validation, jobs, agents \(overflow, up to 3 at once\)/);
    expect(text).toMatch(/codex-cloud \(Codex cloud\): not available/);
    expect(text).toMatch(/paused until/);
    expect(text).toContain("setup: create one at chatgpt.com/codex");
  });

  it("says when cloud is off", () => {
    expect(describeCloudStatus(avail, { enabled: false }, {})[0]).toMatch(/OFF/);
  });
});

describe("cloud provider order", () => {
  it("puts Codex first by default and `prefer` changes it", async () => {
    const { providerOrder } = await import("../core/cloud/config.js");
    expect(providerOrder({})).toEqual(["codex-cloud", "claude-cloud"]);
    await runCloud(["prefer", "claude"], deps());
    expect(readCloudSettings(file).order).toEqual(["claude-cloud", "codex-cloud"]);
    expect(providerOrder(readCloudSettings(file))).toEqual(["claude-cloud", "codex-cloud"]);
    await runCloud(["prefer", "codex"], deps());
    expect(readCloudSettings(file).order).toEqual(["codex-cloud", "claude-cloud"]);
    await expect(runCloud(["prefer"], deps())).rejects.toThrow(/usage/);
  });

  it("status lists providers in order and says gates use Claude", async () => {
    await runCloud(["status"], deps());
    const out = lines.join("\n");
    expect(out).toMatch(/Order: Codex cloud first, then Claude Code cloud/);
    expect(out.indexOf("codex-cloud (")).toBeLessThan(out.indexOf("claude-cloud ("));
  });

  it("cloudAvailability returns providers in preference order", async () => {
    const { cloudAvailability, setCloudProvidersForTest } =
      await import("../core/cloud/registry.js");
    const home = process.env.HOME;
    process.env.HOME = tmp; // keep real plan state out of the test
    const fake = (id: "claude-cloud" | "codex-cloud") =>
      ({
        id,
        detect: async () => ({ id, available: true, detail: "ok" }),
      }) as unknown as CloudProvider;
    setCloudProvidersForTest([fake("claude-cloud"), fake("codex-cloud")]);
    try {
      const byDefault = await cloudAvailability("agents", undefined, {});
      expect(byDefault.find((a) => a.available)?.id).toBe("codex-cloud");
      const claudeFirst = await cloudAvailability("agents", undefined, {
        order: ["claude-cloud"],
      });
      expect(claudeFirst.map((a) => a.id)).toEqual(["claude-cloud", "codex-cloud"]);
    } finally {
      setCloudProvidersForTest(undefined);
      process.env.HOME = home;
    }
  });
});

describe("ezcoder cloud setup codex", () => {
  it("opens the connect page, waits for GitHub, then makes the repo's environment", async () => {
    const { setupCodex } = await import("./cloud.js");
    let checks = 0;
    const opened: string[] = [];
    const out: string[] = [];
    await setupCodex(
      {
        connected: async () => ++checks >= 3,
        open: (url) => opened.push(url),
        repo: async () => "o/r",
        ensure: async () => ({ kind: "env", env: { id: "env_1", label: "r" }, created: true }),
        sleep: async () => {},
      },
      (l) => out.push(l),
    );
    expect(opened).toEqual(["https://chatgpt.com/codex/settings/connectors"]);
    expect(checks).toBe(3);
    expect(out.join("\n")).toMatch(/Created the Codex environment "r" for o\/r/);
  });

  it("skips the browser when already connected and explains a missing repo", async () => {
    const { setupCodex } = await import("./cloud.js");
    const opened: string[] = [];
    await expect(
      setupCodex(
        {
          connected: async () => true,
          open: (url) => opened.push(url),
          repo: async () => "o/r",
          ensure: async () => ({
            kind: "missing",
            detail: "Codex's GitHub app can't see o/r",
            hint: "Give access",
          }),
        },
        () => {},
      ),
    ).rejects.toThrow(/can't see o\/r/);
    expect(opened).toEqual([]);
  });

  it("gives up after the wait with a clear next step", async () => {
    const { setupCodex } = await import("./cloud.js");
    await expect(
      setupCodex(
        {
          connected: async () => false,
          open: () => {},
          repo: async () => undefined,
          ensure: async () => ({ kind: "creatable", repo: "x" }),
          sleep: async () => {},
          waitMs: 0,
        },
        () => {},
      ),
    ).rejects.toThrow(/still isn't connected/);
  });
});
