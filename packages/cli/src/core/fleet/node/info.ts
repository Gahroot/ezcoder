// Live machine facts for GET /v1/hello and /v1/info: platform (incl. WSL2),
// memory, load, disk, GPUs (nvidia-smi / rocm-smi / system_profiler) and Docker.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GpuInfo, NodePlatform } from "../protocol.js";
import { defaultExec, type NodeExec } from "./exec.js";

let cachedVersion: string | undefined;

/** Version of the installed @prestyj/cli (nearest package.json walking up). */
export function cliVersion(): string {
  if (cachedVersion) return cachedVersion;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as {
        name?: string;
        version?: string;
      };
      if (m.name === "@prestyj/cli" && m.version) return (cachedVersion = m.version);
    } catch {
      // keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return (cachedVersion = "0.0.0");
}

export function detectPlatform(
  platform: NodeJS.Platform = process.platform,
  readProcVersion: () => string = () => fs.readFileSync("/proc/version", "utf8"),
): NodePlatform {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  try {
    if (/microsoft/i.test(readProcVersion())) return "wsl2";
  } catch {
    // not readable: plain Linux
  }
  return "linux";
}

const GB = 1024 ** 3;
const round = (n: number) => Math.round(n * 10) / 10;

export async function diskFreeGb(dir: string): Promise<number> {
  try {
    const s = await fs.promises.statfs(dir);
    return round((s.bavail * s.bsize) / GB);
  } catch {
    return 0;
  }
}

export function parseNvidiaSmi(out: string): GpuInfo[] {
  const gpus: GpuInfo[] = [];
  for (const line of out.split("\n")) {
    const parts = line.split(",").map((p) => p.trim());
    if (parts.length < 2 || !parts[0]) continue;
    const total = Number(parts[1]);
    if (!Number.isFinite(total)) continue;
    const gpu: GpuInfo = { name: parts[0], memoryGb: round(total / 1024), vendor: "nvidia" };
    const used = Number(parts[2]);
    if (parts[2] && Number.isFinite(used)) gpu.memoryUsedGb = round(used / 1024);
    const util = Number(parts[3]);
    if (parts[3] && Number.isFinite(util)) gpu.utilizationPct = util;
    gpus.push(gpu);
  }
  return gpus;
}

export function parseRocmSmi(out: string): GpuInfo[] {
  try {
    const data = JSON.parse(out) as Record<string, Record<string, string>>;
    const gpus: GpuInfo[] = [];
    for (const [key, card] of Object.entries(data)) {
      if (!key.startsWith("card")) continue;
      const total = Number(card["VRAM Total Memory (B)"] ?? 0);
      const used = Number(card["VRAM Total Used Memory (B)"] ?? NaN);
      const gpu: GpuInfo = {
        name: card["Card series"] ?? card["Card Series"] ?? card["Card model"] ?? "AMD GPU",
        memoryGb: round(total / GB),
        vendor: "amd",
      };
      if (Number.isFinite(used)) gpu.memoryUsedGb = round(used / GB);
      const util = Number(card["GPU use (%)"]);
      if (Number.isFinite(util)) gpu.utilizationPct = util;
      gpus.push(gpu);
    }
    return gpus;
  } catch {
    return [];
  }
}

export function parseSystemProfiler(out: string, totalMemGb: number): GpuInfo[] {
  try {
    const data = JSON.parse(out) as {
      SPDisplaysDataType?: Array<{
        sppci_model?: string;
        spdisplays_vendor?: string;
        spdisplays_vram?: string;
      }>;
    };
    return (data.SPDisplaysDataType ?? []).map((d) => {
      const name = d.sppci_model ?? "GPU";
      const apple = /apple/i.test(name) || /apple/i.test(d.spdisplays_vendor ?? "");
      const vram = Number(/(\d+)\s*GB/i.exec(d.spdisplays_vram ?? "")?.[1] ?? NaN);
      return {
        name,
        // Apple silicon shares unified memory with the CPU.
        memoryGb: apple ? round(totalMemGb) : Number.isFinite(vram) ? vram : 0,
        vendor: apple
          ? "apple"
          : /nvidia/i.test(name)
            ? "nvidia"
            : /amd|radeon/i.test(name)
              ? "amd"
              : "other",
      } satisfies GpuInfo;
    });
  } catch {
    return [];
  }
}

export async function detectGpus(
  exec: NodeExec = defaultExec,
  platform: NodePlatform = detectPlatform(),
): Promise<GpuInfo[]> {
  if (platform === "macos") {
    const r = await exec("system_profiler", ["SPDisplaysDataType", "-json"], { timeoutMs: 15_000 });
    return r.code === 0 ? parseSystemProfiler(r.stdout, os.totalmem() / GB) : [];
  }
  const nv = await exec(
    "nvidia-smi",
    ["--query-gpu=name,memory.total,memory.used,utilization.gpu", "--format=csv,noheader,nounits"],
    { timeoutMs: 10_000 },
  );
  if (nv.code === 0) {
    const gpus = parseNvidiaSmi(nv.stdout);
    if (gpus.length) return gpus;
  }
  const amd = await exec(
    "rocm-smi",
    ["--showproductname", "--showmeminfo", "vram", "--showuse", "--json"],
    { timeoutMs: 10_000 },
  );
  return amd.code === 0 ? parseRocmSmi(amd.stdout) : [];
}

export async function dockerAvailable(exec: NodeExec = defaultExec): Promise<boolean> {
  const r = await exec("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 10_000 });
  return r.code === 0 && r.stdout.trim().length > 0;
}

/** Caches slow probes (system_profiler, docker info) for `ttlMs`. */
export class Probe<T> {
  private value?: T;
  private at = 0;
  private pending?: Promise<T>;
  constructor(
    private readonly fn: () => Promise<T>,
    private readonly ttlMs: number,
  ) {}
  async get(): Promise<T> {
    if (this.value !== undefined && Date.now() - this.at < this.ttlMs) return this.value;
    this.pending ??= this.fn().then(
      (v) => {
        this.value = v;
        this.at = Date.now();
        this.pending = undefined;
        return v;
      },
      (e: unknown) => {
        this.pending = undefined;
        throw e;
      },
    );
    return this.pending;
  }
}

/**
 * Parse `vm_stat` output into bytes the system can hand out now: free plus
 * inactive, speculative and purgeable pages (macOS keeps "free" near zero).
 */
export function parseVmStat(text: string): number | undefined {
  const size = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  if (!size) return undefined;
  const pages = (label: string) =>
    Number(new RegExp(`Pages ${label}:\\s+(\\d+)`).exec(text)?.[1] ?? 0);
  return (pages("free") + pages("inactive") + pages("speculative") + pages("purgeable")) * size;
}

/** Memory available to new work. os.freemem() undercounts on macOS. */
export function availableMemoryBytes(): number {
  if (process.platform === "darwin") {
    try {
      const out = execFileSync("vm_stat", { encoding: "utf8", timeout: 2000 });
      const n = parseVmStat(out);
      if (n !== undefined) return Math.min(n, os.totalmem());
    } catch {
      // fall through
    }
  }
  return os.freemem();
}

export function machineSnapshot(): {
  hostname: string;
  arch: string;
  cpus: number;
  memoryGb: number;
  memoryFreeGb: number;
  load: number;
} {
  const cpus = os.cpus().length || 1;
  return {
    hostname: os.hostname(),
    arch: os.arch(),
    cpus,
    memoryGb: round(os.totalmem() / GB),
    memoryFreeGb: round(availableMemoryBytes() / GB),
    load: Math.round(((os.loadavg()[0] ?? 0) / cpus) * 100) / 100,
  };
}
