import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./logger.js";
import { getAppPaths } from "../config.js";
import type { ShellResolution } from "./shell.js";

export interface SandboxPolicy {
  /**
   * `workspace` always isolates and fails closed. `auto` isolates wherever the
   * OS supports it and degrades with a warning where the prerequisites are
   * absent, because SRT needs bubblewrap/socat on Linux and an elevated
   * `windows-install` on Windows — enforcing there would break every command.
   *
   * Both isolating modes are opt-in (`off` by default): SRT's network model is
   * allowlist-only and cannot express "unrestricted", so turning isolation on
   * necessarily gates egress to {@link allowedDomains}.
   */
  mode: "auto" | "workspace" | "off";
  /** Hosts reachable while sandboxed. Empty means no egress at all. */
  allowedDomains: string[];
  /** Extra workspace roots (multi-root sessions), mirroring the write guard. */
  additionalRoots?: string[];
  /** The user consented to writes outside the workspace; do not contradict them. */
  allowOutsideWorkspaceWrites?: boolean;
}

export interface SandboxLaunch extends ShellResolution {
  sandboxed: boolean;
}

interface SandboxSettings {
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
    strictAllowlist: boolean;
    allowUnixSockets: string[];
    allowLocalBinding: boolean;
  };
  filesystem: {
    denyRead: string[];
    allowWrite: string[];
    denyWrite: string[];
  };
}

const SANDBOX_CONFIG_DIR = path.join(os.homedir(), ".gg", "sandbox-configs");
const PROBE_TIMEOUT_MS = 20_000;
let warnedUnsupported = false;

function sensitiveReadPaths(home: string): string[] {
  return [
    path.join(home, ".ssh"),
    path.join(home, ".aws"),
    path.join(home, ".gnupg"),
    path.join(home, ".kube"),
    path.join(home, ".config", "gcloud"),
    path.join(home, ".azure"),
    path.join(home, ".gg", "auth.json"),
  ];
}

/** Pure policy builder, exported so the security boundary is regression-tested. */
export function buildSandboxSettings(
  cwd: string,
  policy: SandboxPolicy,
  platform: NodeJS.Platform = process.platform,
): SandboxSettings {
  const workspace = path.resolve(cwd);
  const temp = path.resolve(os.tmpdir());
  const home = os.homedir();
  const allowedDomains = [
    ...new Set(policy.allowedDomains.map((host) => host.trim()).filter(Boolean)),
  ].sort();
  // Mirror resolveWriteGuard's roots. The sandbox must never be stricter than
  // the write guard the user already controls, or bash silently loses
  // multi-root workspaces and the documented outside-workspace opt-out.
  const writeRoots = [
    workspace,
    ...(policy.additionalRoots ?? []).map((root) => path.resolve(root)),
    temp,
    path.resolve(getAppPaths().agentDir),
    ...(policy.allowOutsideWorkspaceWrites ? [home] : []),
  ];

  return {
    network: {
      allowedDomains,
      deniedDomains: [],
      strictAllowlist: true,
      allowUnixSockets: [],
      // Dev servers, preview servers and the screenshot tool all bind a local
      // port. Loopback never leaves the machine, so blocking it costs core
      // workflows without buying containment.
      allowLocalBinding: true,
    },
    filesystem: {
      denyRead: sensitiveReadPaths(home),
      // SRT adds its platform-required temporary paths; these are the only
      // product-owned write roots supplied by GG Coder.
      allowWrite: platform === "win32" ? writeRoots : [...writeRoots, "/dev/null"],
      denyWrite: [
        path.join(workspace, ".git", "hooks"),
        path.join(workspace, ".git", "config"),
        path.join(workspace, ".env"),
        path.join(workspace, ".env.local"),
      ],
    },
  };
}

function resolveSandboxCli(): string {
  const packageEntry = import.meta.resolve("@anthropic-ai/sandbox-runtime");
  return path.join(path.dirname(fileURLToPath(packageEntry)), "cli.js");
}

/**
 * Does this machine actually support OS sandboxing? SRT reports missing
 * bubblewrap/socat or an unprovisioned Windows sandbox user only when it
 * initializes, so probe once per process with a trivial command instead of
 * reimplementing its per-platform dependency matrix.
 */
let supportProbe: Promise<{ supported: boolean; reason: string }> | null = null;

export function resetSandboxSupportProbeForTests(): void {
  supportProbe = null;
  warnedUnsupported = false;
}

function probeSandboxSupport(
  settingsPath: string,
): Promise<{ supported: boolean; reason: string }> {
  supportProbe ??= new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        process.execPath,
        [resolveSandboxCli(), "--settings", settingsPath, "-c", "exit 0"],
        {
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
    } catch (error) {
      resolve({ supported: false, reason: (error as Error).message });
      return;
    }
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-500);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ supported: false, reason: "sandbox probe timed out" });
    }, PROBE_TIMEOUT_MS);
    timer.unref?.();
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ supported: false, reason: error.message });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({
        supported: code === 0,
        reason: code === 0 ? "ok" : stderr.trim() || `sandbox probe exited with code ${code}`,
      });
    });
  });
  return supportProbe;
}

async function writeStableSettings(settings: SandboxSettings): Promise<string> {
  const json = `${JSON.stringify(settings, null, 2)}\n`;
  const digest = createHash("sha256").update(json).digest("hex").slice(0, 20);
  const settingsPath = path.join(SANDBOX_CONFIG_DIR, `${digest}.json`);
  await fs.mkdir(SANDBOX_CONFIG_DIR, { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(settingsPath, json, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return settingsPath;
}

/**
 * Wrap an already-resolved shell with Anthropic's cross-platform OS sandbox.
 * Initialization and dependency failures remain visible and fail closed: the
 * original command is never spawned outside the sandbox as an implicit fallback.
 */
export async function prepareSandboxLaunch(
  shell: ShellResolution,
  cwd: string,
  policy: SandboxPolicy,
): Promise<SandboxLaunch> {
  if (policy.mode === "off") return { ...shell, sandboxed: false };
  const settingsPath = await writeStableSettings(buildSandboxSettings(cwd, policy));

  const support = await probeSandboxSupport(settingsPath);
  if (!support.supported) {
    if (policy.mode === "workspace") {
      throw new Error(
        `${support.reason}. Install the OS sandbox prerequisites ` +
          `(Linux: bubblewrap + socat; Windows: run \`srt windows-install\`), ` +
          `or set sandboxMode to "auto" to run without OS isolation.`,
      );
    }
    if (!warnedUnsupported) {
      warnedUnsupported = true;
      log("WARN", "sandbox", "OS sandbox unavailable; commands run unisolated", {
        reason: support.reason,
      });
    }
    return { ...shell, sandboxed: false };
  }

  return {
    file: process.execPath,
    args: [resolveSandboxCli(), "--settings", settingsPath, "--", shell.file, ...shell.args],
    isCmdFallback: shell.isCmdFallback,
    sandboxed: true,
  };
}
