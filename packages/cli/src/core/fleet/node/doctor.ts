// S1/A4: `ezcoder node doctor` and GET /v1/doctor. Checks everything a node
// needs to take work and prints one concrete fix for each check that failed.
// Every probe goes through injected tools so tests need no real Tailscale,
// Docker, git or keychain.
import fs from "node:fs";
import os from "node:os";
import { stripUrlCredentials } from "../git.js";
import {
  FLEET_PROTOCOL,
  type DoctorCheck,
  type DoctorReport,
  type GpuInfo,
  type NodePlatform,
} from "../protocol.js";
import { detectTailscale, type TailscaleInfo } from "./config.js";
import type { NodeConfig } from "./context.js";
import { defaultExec, type NodeExec } from "./exec.js";
import { cliVersion, detectGpus, detectPlatform, diskFreeGb } from "./info.js";
import { defaultSecretStore, NodeSecrets, type SecretStore } from "./secrets.js";

/** Below this much free disk the node can't clone and build: fail. */
export const DISK_FAIL_GB = 5;
/** Below this: warn. */
export const DISK_WARN_GB = 20;

export interface DoctorOptions {
  config: NodeConfig;
  /** Git URL to test access to (`git ls-remote`). */
  repo?: string;
  exec?: NodeExec;
  platform?: NodePlatform;
  tailscale?: () => Promise<TailscaleInfo>;
  gpus?: () => Promise<GpuInfo[]>;
  diskFreeGb?: (dir: string) => Promise<number>;
  /** Provider ids with stored model credentials. */
  modelProviders?: () => Promise<string[]>;
  secretStore?: SecretStore;
  version?: string;
  cpus?: number;
  /** /dev/kfd exists (AMD GPUs in Docker). */
  exists?: (p: string) => boolean;
}

const check = (
  id: DoctorCheck["id"],
  status: DoctorCheck["status"],
  detail: string,
  fix?: string,
): DoctorCheck => ({ id, status, detail, ...(fix && status !== "ok" && { fix }) });

async function tailscaleCheck(o: DoctorOptions, exec: NodeExec): Promise<DoctorCheck> {
  const ts = await (o.tailscale ?? (() => detectTailscale(exec)))();
  if (ts.running && ts.ip) {
    return check("tailscale", "ok", `running, this machine is ${ts.dnsName ?? ts.ip}`);
  }
  if (o.config.tlsCert) {
    return check(
      "tailscale",
      "warn",
      "not running; the node serves https (TLS) instead",
      "nothing needed if the controller reaches this machine another way; otherwise run `sudo tailscale up`",
    );
  }
  return check(
    "tailscale",
    "fail",
    "not running, so the main machine can't reach this node privately",
    "install Tailscale (https://tailscale.com/download) and run `sudo tailscale up`",
  );
}

async function dockerCheck(
  o: DoctorOptions,
  exec: NodeExec,
): Promise<{ check: DoctorCheck; runtimes: string }> {
  const r = await exec("docker", ["info", "--format", "{{json .Runtimes}}"], {
    timeoutMs: 20_000,
  });
  const severity = o.config.dockerOnly ? "fail" : "warn";
  if (r.code === 0) return { check: check("docker", "ok", "running"), runtimes: r.stdout };
  if (r.code === 127) {
    return {
      check: check(
        "docker",
        severity,
        "not installed: containerised jobs, browser runs and services can't run here",
        "install Docker (https://docs.docker.com/engine/install/), then run `ezcoder node doctor` again",
      ),
      runtimes: "",
    };
  }
  const why = (r.stderr || r.stdout).trim().split("\n").pop() ?? "";
  const denied = /permission denied/i.test(why);
  return {
    check: check(
      "docker",
      severity,
      `installed but not usable${why ? `: ${why.slice(0, 160)}` : ""}`,
      denied
        ? "add yourself to the docker group: `sudo usermod -aG docker $USER`, then log out and back in"
        : "start Docker (Docker Desktop, or `sudo systemctl start docker`)",
    ),
    runtimes: "",
  };
}

function gpuCheck(
  gpus: GpuInfo[],
  docker: DoctorCheck,
  runtimes: string,
  o: DoctorOptions,
): DoctorCheck {
  if (!gpus.length) return check("gpu", "skip", "no GPU found");
  const names = gpus.map((g) => g.name).join(", ");
  if (docker.status !== "ok") {
    return check("gpu", "skip", `${names}; Docker is not usable, so passthrough can't be checked`);
  }
  const vendor = gpus[0]!.vendor;
  if (vendor === "apple") {
    return check(
      "gpu",
      "skip",
      `${names}; Docker on macOS can't use the GPU, so GPU work runs on the host`,
    );
  }
  if (vendor === "nvidia") {
    if (/nvidia/i.test(runtimes)) return check("gpu", "ok", `${names}, passed through to Docker`);
    return check(
      "gpu",
      "fail",
      `${names}, but Docker has no NVIDIA runtime, so containers can't use it`,
      "install the NVIDIA Container Toolkit, then `sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker`",
    );
  }
  if (vendor === "amd") {
    const exists = o.exists ?? fs.existsSync;
    if (exists("/dev/kfd")) return check("gpu", "ok", `${names}, /dev/kfd available to Docker`);
    return check(
      "gpu",
      "fail",
      `${names}, but /dev/kfd is missing, so containers can't use it`,
      "install the ROCm kernel driver (amdgpu-dkms) and add yourself to the render and video groups",
    );
  }
  return check("gpu", "warn", `${names}; passthrough for this GPU is not checked`);
}

async function gitCheck(repo: string | undefined, exec: NodeExec): Promise<DoctorCheck> {
  if (!repo) {
    return check("git", "skip", "no repository given (pass --repo URL to test access to one)");
  }
  const shown = stripUrlCredentials(repo);
  // No option injection, no `ext::` style transports that run commands.
  if (repo.startsWith("-") || /^[a-z][a-z0-9+.-]*::/i.test(repo)) {
    return check("git", "fail", `${shown} is not a git URL`, "pass an https or ssh git URL");
  }
  const r = await exec("git", ["ls-remote", "--exit-code", repo, "HEAD"], {
    timeoutMs: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" },
  });
  if (r.code === 0) return check("git", "ok", `can read ${shown}`);
  if (r.code === 127) {
    return check(
      "git",
      "fail",
      "git is not installed",
      "install git (`sudo apt install git`, or `xcode-select --install` on macOS)",
    );
  }
  const ssh = /^(ssh:\/\/|[\w.-]+@[\w.-]+:)/.test(repo);
  const why = (r.stderr || r.stdout).trim().split("\n").pop() ?? "";
  return check(
    "git",
    "fail",
    `can't read ${shown}${why ? `: ${why.slice(0, 160)}` : ""}`,
    ssh
      ? "add this machine's SSH key to your git host (test with `ssh -T git@github.com`)"
      : "sign in to your git host on this machine: `gh auth login && gh auth setup-git`",
  );
}

async function modelCheck(o: DoctorOptions): Promise<DoctorCheck> {
  let providers: string[];
  try {
    providers = o.modelProviders ? await o.modelProviders() : [];
  } catch {
    providers = [];
  }
  if (providers.length) return check("model_login", "ok", `signed in to ${providers.join(", ")}`);
  return check(
    "model_login",
    "warn",
    "no model login, so remote agents and Goal workers can't run here (jobs still can)",
    "run `ezcoder login` on this machine, or `ezcoder fleet share-auth <node>` from the main machine",
  );
}

async function diskCheck(o: DoctorOptions): Promise<DoctorCheck> {
  const free = await (o.diskFreeGb ?? diskFreeGb)(o.config.dataDir);
  const detail = `${free} GB free in ${o.config.dataDir}`;
  const fix =
    "free disk space, or lower `ezcoder node config --gc-days N` so old jobs are removed sooner";
  if (free < DISK_FAIL_GB) return check("disk", "fail", detail, fix);
  if (free < DISK_WARN_GB) return check("disk", "warn", detail, fix);
  return check("disk", "ok", detail);
}

function slotsCheck(o: DoctorOptions): DoctorCheck {
  const cpus = o.cpus ?? os.cpus().length;
  const slots = o.config.slots;
  if (slots > cpus) {
    return check(
      "slots",
      "warn",
      `${slots} slots on ${cpus} CPUs: work will crowd each other out`,
      `lower it: \`ezcoder node config --slots ${Math.max(1, Math.floor(cpus / 2))}\``,
    );
  }
  return check("slots", "ok", `${slots} slots on ${cpus} CPUs`);
}

async function keychainCheck(o: DoctorOptions, platform: NodePlatform): Promise<DoctorCheck> {
  const secrets = new NodeSecrets(o.config.dataDir, o.secretStore ?? defaultSecretStore(o.exec));
  let available: boolean;
  try {
    available = await secrets.available();
  } catch {
    available = false;
  }
  if (available) {
    const legacy = secrets.hasLegacyFile();
    if (legacy) {
      return check(
        "keychain",
        "warn",
        `${secrets.kind} available, but old plain-text secrets are still on disk`,
        "run `ezcoder node serve` once: it moves them into the keychain and deletes the file",
      );
    }
    return check("keychain", "ok", `${secrets.kind} available for deploy secrets`);
  }
  const fix =
    platform === "macos"
      ? "unlock your login keychain (`security unlock-keychain`)"
      : "install a keyring: `sudo apt install libsecret-tools gnome-keyring` (needs a D-Bus session)";
  const needed = secrets.list().length > 0 || o.config.labels.includes("deploy");
  return check(
    "keychain",
    needed ? "fail" : "warn",
    needed
      ? "no keychain, so deploy secrets can't be stored or read"
      : "no keychain; only needed for deploy secrets",
    fix,
  );
}

export async function runDoctor(o: DoctorOptions): Promise<DoctorReport> {
  const exec = o.exec ?? defaultExec;
  const platform = o.platform ?? detectPlatform();
  const [ts, docker, gpus, git, model, disk, keychain] = await Promise.all([
    tailscaleCheck(o, exec),
    dockerCheck(o, exec),
    (o.gpus ?? (() => detectGpus(exec, platform)))().catch(() => [] as GpuInfo[]),
    gitCheck(o.repo, exec),
    modelCheck(o),
    diskCheck(o),
    keychainCheck(o, platform),
  ]);
  const version = o.version ?? cliVersion();
  const checks: DoctorCheck[] = [
    ts,
    docker.check,
    gpuCheck(gpus, docker.check, docker.runtimes, o),
    git,
    model,
    disk,
    check("version", "ok", `ezcoder ${version}, fleet protocol ${FLEET_PROTOCOL}`),
    slotsCheck(o),
    keychain,
  ];
  return {
    node: o.config.name,
    version,
    protocol: FLEET_PROTOCOL,
    checks,
    ok: checks.every((c) => c.status !== "fail"),
  };
}

const MARK: Record<DoctorCheck["status"], string> = {
  ok: "ok  ",
  warn: "warn",
  fail: "FAIL",
  skip: "skip",
};

/** Plain text: one line per check, then `fix:` under each warn/fail. */
export function formatDoctorReport(r: DoctorReport): string {
  const lines = [`node ${r.node} (ezcoder ${r.version}, protocol ${r.protocol})`];
  const width = Math.max(...r.checks.map((c) => c.id.length));
  for (const c of r.checks) {
    lines.push(`  ${MARK[c.status]}  ${c.id.padEnd(width)}  ${c.detail}`);
    if (c.fix) lines.push(`        ${"".padEnd(width)}  fix: ${c.fix}`);
  }
  lines.push(r.ok ? "ready for work" : "not ready: fix the FAIL lines above");
  return lines.join("\n");
}
