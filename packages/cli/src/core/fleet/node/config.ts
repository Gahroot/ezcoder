// Node configuration (<dataDir>/node.json), Tailscale discovery, pairing
// strings and the node-local deploy secrets (<dataDir>/secrets.json, 0600).
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAppPaths } from "@prestyj/core";
import { DEFAULT_NODE_PORT } from "../protocol.js";
import type { NodeConfig } from "./context.js";
import { defaultExec, type NodeExec } from "./exec.js";

export const NODE_CONFIG_FILE = "node.json";
export const SECRETS_FILE = "secrets.json";

export function defaultNodeDataDir(): string {
  return path.join(getAppPaths().agentDir, "node");
}

/** max(1, min(cpus/4, memoryGb/4)) rounded down. */
export function defaultSlots(
  cpus = os.cpus().length,
  memoryGb = os.totalmem() / 1024 ** 3,
): number {
  return Math.max(1, Math.floor(Math.min(cpus / 4, memoryGb / 4)));
}

/** Write a file atomically with the given mode. */
export function writeFileAtomic(file: string, data: string, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, mode);
  } catch {
    // best effort (e.g. filesystems without modes)
  }
}

type StoredConfig = Omit<NodeConfig, "dataDir">;

export function readNodeConfig(dataDir = defaultNodeDataDir()): NodeConfig | undefined {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(dataDir, NODE_CONFIG_FILE), "utf8"),
    ) as Partial<StoredConfig>;
    if (!raw.name || !raw.token) return undefined;
    return {
      name: raw.name,
      token: raw.token,
      port: raw.port ?? DEFAULT_NODE_PORT,
      bind: raw.bind ?? "",
      advertiseHost: raw.advertiseHost ?? "",
      labels: Array.isArray(raw.labels) ? raw.labels : [],
      slots: raw.slots && raw.slots > 0 ? raw.slots : defaultSlots(),
      dataDir,
    };
  } catch {
    return undefined;
  }
}

export function writeNodeConfig(config: NodeConfig): void {
  const { dataDir, ...stored } = config;
  writeFileAtomic(path.join(dataDir, NODE_CONFIG_FILE), JSON.stringify(stored, null, 2) + "\n");
}

export interface TailscaleInfo {
  running: boolean;
  /** First tailnet IPv4. */
  ip?: string;
  /** MagicDNS name without the trailing dot. */
  dnsName?: string;
}

const TAILSCALE_BINARIES = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];

/** Best effort: `tailscale status --json` (Self.DNSName / TailscaleIPs), else `tailscale ip -4`. */
export async function detectTailscale(exec: NodeExec = defaultExec): Promise<TailscaleInfo> {
  for (const bin of TAILSCALE_BINARIES) {
    const r = await exec(bin, ["status", "--json"], { timeoutMs: 10_000 });
    if (r.code === 127) continue;
    const info: TailscaleInfo = { running: false };
    if (r.code === 0) {
      try {
        const s = JSON.parse(r.stdout) as {
          BackendState?: string;
          Self?: { DNSName?: string; TailscaleIPs?: string[] };
        };
        info.running = s.BackendState === undefined || s.BackendState === "Running";
        const dns = s.Self?.DNSName?.replace(/\.$/, "");
        if (dns) info.dnsName = dns;
        info.ip = s.Self?.TailscaleIPs?.find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
      } catch {
        // fall through to `tailscale ip -4`
      }
    }
    if (!info.ip) {
      const ip = await exec(bin, ["ip", "-4"], { timeoutMs: 10_000 });
      const first = ip.stdout.trim().split(/\s+/)[0];
      if (ip.code === 0 && first) {
        info.ip = first;
        info.running = true;
      }
    }
    if (!info.ip) info.running = false;
    return info;
  }
  return { running: false };
}

/** True for addresses that listen on every interface (0.0.0.0, ::, 0, ::ffff:0.0.0.0 …). */
export function isWildcardBind(bind: string): boolean {
  const b = bind
    .trim()
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (b === "*") return true;
  if (/^[0.]+$/.test(b)) return true; // 0.0.0.0, 0, 0.0
  if (/^[0:]+$/.test(b) && b.includes(":")) return true; // ::, ::0, 0:0:…:0
  return /^[0:]*:ffff:0+(\.0+){3}$/.test(b); // ::ffff:0.0.0.0
}

export function sanitizeNodeName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/\..*$/, "")
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63) || "node"
  );
}

export interface InitOptions {
  dataDir?: string;
  name?: string;
  labels?: string[];
  slots?: number;
  port?: number;
  /** Explicit bind address (default: resolved from Tailscale at serve time). */
  bind?: string;
  advertiseHost?: string;
  exec?: NodeExec;
  /** Keep the existing token when re-initialising (default true). */
  keepToken?: boolean;
}

/** Create or update <dataDir>/node.json. */
export async function initNodeConfig(opts: InitOptions = {}): Promise<NodeConfig> {
  const dataDir = opts.dataDir ?? defaultNodeDataDir();
  const existing = readNodeConfig(dataDir);
  let advertiseHost = opts.advertiseHost ?? existing?.advertiseHost ?? "";
  if (!opts.advertiseHost) {
    const ts = await detectTailscale(opts.exec);
    advertiseHost = ts.dnsName ?? ts.ip ?? advertiseHost;
  }
  const config: NodeConfig = {
    name: sanitizeNodeName(opts.name ?? existing?.name ?? os.hostname()),
    token:
      opts.keepToken !== false && existing?.token
        ? existing.token
        : randomBytes(32).toString("base64url"),
    port: opts.port ?? existing?.port ?? DEFAULT_NODE_PORT,
    bind: opts.bind ?? existing?.bind ?? "",
    advertiseHost: advertiseHost || os.hostname(),
    labels: normalizeLabels(opts.labels ?? existing?.labels ?? []),
    slots:
      opts.slots && opts.slots > 0 ? Math.floor(opts.slots) : (existing?.slots ?? defaultSlots()),
    dataDir,
  };
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeNodeConfig(config);
  return config;
}

export function normalizeLabels(labels: string[]): string[] {
  return [
    ...new Set(
      labels.map((l) => l.trim().toLowerCase()).filter((l) => /^[a-z0-9][a-z0-9._-]*$/.test(l)),
    ),
  ];
}

/** `ezfleet://<name>@<advertiseHost>:<port>#<token>` */
export function pairingString(
  config: Pick<NodeConfig, "name" | "advertiseHost" | "port" | "token">,
): string {
  return `ezfleet://${config.name}@${config.advertiseHost}:${config.port}#${config.token}`;
}

export function parsePairingString(
  s: string,
): { name: string; host: string; port: number; token: string } | undefined {
  const m = /^ezfleet:\/\/([^@\s]+)@([^:\s#]+):(\d+)#(\S+)$/.exec(s.trim());
  if (!m) return undefined;
  return { name: m[1]!, host: m[2]!, port: Number(m[3]), token: m[4]! };
}

// ── Secrets ──────────────────────────────────────────────────────────────

const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export function isValidSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

export function readSecrets(dataDir: string): Record<string, string> {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, SECRETS_FILE), "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

export function setSecret(dataDir: string, name: string, value: string): void {
  if (!isValidSecretName(name)) throw new Error(`invalid secret name: ${name}`);
  const all = readSecrets(dataDir);
  all[name] = value;
  writeFileAtomic(path.join(dataDir, SECRETS_FILE), JSON.stringify(all, null, 2) + "\n", 0o600);
}

export function removeSecret(dataDir: string, name: string): boolean {
  const all = readSecrets(dataDir);
  if (!(name in all)) return false;
  delete all[name];
  writeFileAtomic(path.join(dataDir, SECRETS_FILE), JSON.stringify(all, null, 2) + "\n", 0o600);
  return true;
}

export function listSecretNames(dataDir: string): string[] {
  return Object.keys(readSecrets(dataDir)).sort();
}
