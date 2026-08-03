import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAppPaths } from "../config.js";
import { DEFAULT_SETTINGS } from "./settings-manager.js";
import {
  buildSandboxSettings,
  prepareSandboxLaunch,
  resetSandboxSupportProbeForTests,
} from "./sandbox.js";

describe("buildSandboxSettings", () => {
  it("limits writes to the workspace and temp directory while denying network by default", () => {
    const cwd = path.join(os.tmpdir(), "gg-sandbox-workspace");
    const settings = buildSandboxSettings(cwd, { mode: "workspace", allowedDomains: [] }, "darwin");

    expect(settings.filesystem.allowWrite).toEqual([
      path.resolve(cwd),
      path.resolve(os.tmpdir()),
      getAppPaths().agentDir,
      "/dev/null",
    ]);
    expect(settings.filesystem.allowWrite).not.toContain(os.homedir());
    expect(settings.filesystem.denyWrite).toEqual(
      expect.arrayContaining([
        path.join(path.resolve(cwd), ".git", "hooks"),
        path.join(path.resolve(cwd), ".env"),
      ]),
    );
    expect(settings.filesystem.denyRead).toEqual(
      expect.arrayContaining([
        path.join(os.homedir(), ".ssh"),
        path.join(os.homedir(), ".gg", "auth.json"),
      ]),
    );
    expect(settings.network).toMatchObject({
      allowedDomains: [],
      strictAllowlist: true,
      allowUnixSockets: [],
      // Dev servers and the screenshot tool bind loopback; blocking it would
      // break core workflows without containing anything.
      allowLocalBinding: true,
    });
  });

  it("keeps bash writable in the same roots the write guard already allows", () => {
    const cwd = path.join(os.tmpdir(), "gg-sandbox-workspace");
    const extraRoot = path.join(os.tmpdir(), "gg-sandbox-second-root");
    const settings = buildSandboxSettings(
      cwd,
      { mode: "workspace", allowedDomains: [], additionalRoots: [extraRoot] },
      "darwin",
    );

    // Multi-root sessions and ~/.gg must not silently lose bash writes.
    expect(settings.filesystem.allowWrite).toEqual(
      expect.arrayContaining([path.resolve(cwd), path.resolve(extraRoot), getAppPaths().agentDir]),
    );
    expect(settings.filesystem.allowWrite).not.toContain(os.homedir());
  });

  it("honors the outside-workspace opt-out instead of contradicting the user", () => {
    const settings = buildSandboxSettings(
      path.join(os.tmpdir(), "gg-sandbox-workspace"),
      { mode: "workspace", allowedDomains: [], allowOutsideWorkspaceWrites: true },
      "darwin",
    );

    expect(settings.filesystem.allowWrite).toContain(os.homedir());
    // Consenting to write outside the workspace is not consent to leak secrets.
    expect(settings.filesystem.denyRead).toContain(path.join(os.homedir(), ".ssh"));
  });

  it("normalizes and sorts explicit network domains deterministically", () => {
    const settings = buildSandboxSettings("/workspace", {
      mode: "workspace",
      allowedDomains: [" registry.npmjs.org ", "github.com", "github.com", ""],
    });

    expect(settings.network.allowedDomains).toEqual(["github.com", "registry.npmjs.org"]);
  });
});

describe("sandbox defaults", () => {
  it("ships opt-in, so existing users keep unrestricted network and egress", () => {
    // SRT's network model is allowlist-only and cannot express "unrestricted",
    // so defaulting isolation on would silently break git push, package
    // installs and curl for every user.
    expect(DEFAULT_SETTINGS.sandboxMode).toBe("off");
  });
});

describe("prepareSandboxLaunch", () => {
  const shell = { file: "bash", args: ["-c", "echo ok"], isCmdFallback: false };

  beforeEach(() => resetSandboxSupportProbeForTests());
  afterEach(() => {
    vi.unstubAllEnvs();
    resetSandboxSupportProbeForTests();
  });

  it("preserves the original shell only for explicit sandbox opt-out", async () => {
    await expect(
      prepareSandboxLaunch(shell, "/workspace", { mode: "off", allowedDomains: [] }),
    ).resolves.toEqual({ ...shell, sandboxed: false });
  });

  it("wraps the command when the platform supports OS isolation", async () => {
    const launch = await prepareSandboxLaunch(shell, os.tmpdir(), {
      mode: "workspace",
      allowedDomains: [],
    });

    expect(launch.sandboxed).toBe(true);
    expect(launch.args).toEqual(
      expect.arrayContaining(["--settings", "--", "bash", "-c", "echo ok"]),
    );
  });

  it("degrades instead of breaking every command when prerequisites are missing", async () => {
    // An unusable interpreter makes the probe child exit non-zero, standing in
    // for bwrap-less Linux or an unprovisioned Windows sandbox user.
    vi.spyOn(process, "execPath", "get").mockReturnValue("/nonexistent/gg-node");

    await expect(
      prepareSandboxLaunch(shell, os.tmpdir(), { mode: "auto", allowedDomains: [] }),
    ).resolves.toEqual({ ...shell, sandboxed: false });
  });

  it("fails closed in strict workspace mode with actionable install guidance", async () => {
    vi.spyOn(process, "execPath", "get").mockReturnValue("/nonexistent/gg-node");

    await expect(
      prepareSandboxLaunch(shell, os.tmpdir(), { mode: "workspace", allowedDomains: [] }),
    ).rejects.toThrow(/bubblewrap \+ socat|windows-install/);
  });
});
