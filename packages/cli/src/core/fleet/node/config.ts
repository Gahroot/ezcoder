// Node configuration (<dataDir>/node.json), Tailscale discovery, pairing
// strings and codes, TLS certs, and the legacy plaintext secrets file
// (<dataDir>/secrets.json) that secrets.ts migrates into the OS keychain.
import { createHash, randomBytes, randomInt, timingSafeEqual, X509Certificate } from "node:crypto";
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

/**
 * max(1, min(cpus/2, memoryGb/2)) rounded down: a 16-core 32 GB box gets 8.
 * One pool for every kind of work (jobs, validation stages, agents, Goal
 * workers); raise it with `ezcoder node config --slots N`.
 */
export function defaultSlots(
  cpus = os.cpus().length,
  memoryGb = os.totalmem() / 1024 ** 3,
): number {
  return Math.max(1, Math.floor(Math.min(cpus / 2, memoryGb / 2)));
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

/** Parsed JSON object, undefined when the file is missing; throws when it is damaged. */
function readJsonObject(file: string, damaged: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`can't read ${file}: ${(e as Error).message}`, { cause: e });
  }
  try {
    const raw = JSON.parse(text) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw))
      return raw as Record<string, unknown>;
  } catch {
    // reported below
  }
  throw new Error(`${file} is damaged (not a JSON object). ${damaged}`);
}

export function readNodeConfig(dataDir = defaultNodeDataDir()): NodeConfig | undefined {
  const raw = readJsonObject(
    path.join(dataDir, NODE_CONFIG_FILE),
    "Fix it, or move it aside and run `ezcoder node init` (that makes a new token, so pair again).",
  ) as Partial<StoredConfig> | undefined;
  if (!raw?.name || !raw.token) return undefined;
  return {
    name: raw.name,
    token: raw.token,
    port: raw.port ?? DEFAULT_NODE_PORT,
    bind: raw.bind ?? "",
    advertiseHost: raw.advertiseHost ?? "",
    labels: Array.isArray(raw.labels) ? raw.labels : [],
    slots: raw.slots && raw.slots > 0 ? raw.slots : defaultSlots(),
    dataDir,
    ...(raw.dockerOnly === true && { dockerOnly: true }),
    ...(typeof raw.tlsCert === "string" && raw.tlsCert && { tlsCert: raw.tlsCert }),
    ...(typeof raw.tlsKey === "string" && raw.tlsKey && { tlsKey: raw.tlsKey }),
    ...(typeof raw.gcDays === "number" && raw.gcDays > 0 && { gcDays: raw.gcDays }),
    ...(typeof raw.cacheCapGb === "number" && raw.cacheCapGb > 0 && { cacheCapGb: raw.cacheCapGb }),
  };
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

/** True for loopback and Tailscale addresses (100.64.0.0/10, fd7a:115c:a1e0::/48). */
export function isPrivateBind(bind: string): boolean {
  const b = bind
    .trim()
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (b === "localhost" || b === "::1" || /^127(\.\d{1,3}){3}$/.test(b)) return true;
  const cgnat = /^100\.(\d{1,3})(\.\d{1,3}){2}$/.exec(b);
  if (cgnat && Number(cgnat[1]) >= 64 && Number(cgnat[1]) <= 127) return true;
  return b.startsWith("fd7a:115c:a1e0:");
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
  dockerOnly?: boolean;
  tlsCert?: string;
  tlsKey?: string;
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
    token: opts.keepToken !== false && existing?.token ? existing.token : newToken(),
    port: opts.port ?? existing?.port ?? DEFAULT_NODE_PORT,
    bind: opts.bind ?? existing?.bind ?? "",
    advertiseHost: advertiseHost || os.hostname(),
    labels: normalizeLabels(opts.labels ?? existing?.labels ?? []),
    slots:
      opts.slots && opts.slots > 0 ? Math.floor(opts.slots) : (existing?.slots ?? defaultSlots()),
    dataDir,
  };
  const dockerOnly = opts.dockerOnly ?? existing?.dockerOnly;
  if (dockerOnly) config.dockerOnly = true;
  const tlsCert = opts.tlsCert ?? existing?.tlsCert;
  const tlsKey = opts.tlsKey ?? existing?.tlsKey;
  if (tlsCert && tlsKey) Object.assign(config, { tlsCert, tlsKey });
  if (existing?.gcDays) config.gcDays = existing.gcDays;
  if (existing?.cacheCapGb) config.cacheCapGb = existing.cacheCapGb;
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

/**
 * `ezfleet://<name>@<advertiseHost>:<port>#<token>`, or with TLS (X10)
 * `ezfleets://<name>@<host>:<port>#<token>;fp=<64 hex>` (cert SHA-256, pinned by the controller).
 */
export function pairingString(
  config: Pick<NodeConfig, "name" | "advertiseHost" | "port" | "token">,
  tlsFingerprint?: string,
): string {
  const host = config.advertiseHost.includes(":")
    ? `[${config.advertiseHost}]`
    : config.advertiseHost;
  if (tlsFingerprint) {
    return `ezfleets://${config.name}@${host}:${config.port}#${config.token};fp=${tlsFingerprint}`;
  }
  return `ezfleet://${config.name}@${host}:${config.port}#${config.token}`;
}

export function parsePairingString(s: string):
  | {
      name: string;
      host: string;
      port: number;
      token: string;
      tls?: boolean;
      fingerprint?: string;
    }
  | undefined {
  const m =
    /^ezfleet(s?):\/\/([^@\s]+)@(\[[^\]\s]+\]|[^:\s#]+):(\d+)#([^;\s]+)(?:;fp=([0-9a-f]{64}))?$/i.exec(
      s.trim(),
    );
  if (!m) return undefined;
  const tls = m[1] === "s";
  if (tls !== !!m[6]) return undefined; // ezfleets needs a fingerprint, ezfleet has none
  return {
    name: m[2]!,
    host: m[3]!.replace(/^\[|\]$/g, ""),
    port: Number(m[4]),
    token: m[5]!,
    ...(tls && { tls: true, fingerprint: m[6]!.toLowerCase() }),
  };
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** S4: give the node a new token and persist it. The old one stops working at once. */
export function rotateNodeToken(dataDir = defaultNodeDataDir()): NodeConfig {
  const cfg = readNodeConfig(dataDir);
  if (!cfg) throw new Error("this machine is not a fleet node yet: run `ezcoder node init` first");
  cfg.token = newToken();
  writeNodeConfig(cfg);
  return cfg;
}

// ── TLS (X10) ────────────────────────────────────────────────────────────

/** SHA-256 of the certificate (DER), lowercase hex without colons. */
export function certFingerprint(pem: string): string {
  return new X509Certificate(pem).fingerprint256.replace(/:/g, "").toLowerCase();
}

/** Fingerprint of the configured cert, undefined when the node serves plain http. */
export function configFingerprint(config: Pick<NodeConfig, "tlsCert">): string | undefined {
  if (!config.tlsCert) return undefined;
  return certFingerprint(fs.readFileSync(config.tlsCert, "utf8"));
}

/** `node init --tls`: a self-signed P-256 cert (10 years) made with openssl. */
export async function generateSelfSignedCert(
  dataDir: string,
  host: string,
  exec: NodeExec = defaultExec,
): Promise<{ cert: string; key: string }> {
  const dir = path.join(dataDir, "tls");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const cert = path.join(dir, "cert.pem");
  const key = path.join(dir, "key.pem");
  const san = /^[\d.]+$|:/.test(host) ? `IP:${host}` : `DNS:${host}`;
  const r = await exec(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "3650",
      "-subj",
      "/CN=ezcoder-node",
      "-addext",
      `subjectAltName=${san}`,
    ],
    { timeoutMs: 60_000 },
  );
  if (r.code === 127) {
    throw new Error(
      "openssl is not installed, so no certificate can be made. Install openssl, or pass your own with --tls-cert FILE --tls-key FILE",
    );
  }
  if (r.code !== 0) throw new Error(`openssl failed: ${(r.stderr || r.stdout).trim().slice(-500)}`);
  try {
    fs.chmodSync(key, 0o600);
  } catch {
    // best effort
  }
  return { cert, key };
}

// ── Short pairing codes (S9) ─────────────────────────────────────────────

export const PAIR_CODE_FILE = "pair-code.json";
export const PAIR_CODE_TTL_MS = 10 * 60_000;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Upper-case, drop separators, and map Crockford look-alikes (O→0, I/L→1). */
export function normalizePairCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}

const hashCode = (code: string) =>
  createHash("sha256").update(normalizePairCode(code)).digest("hex");

/** A fresh 8-char code (`XXXX-XXXX`), valid 10 minutes, single use. Replaces any earlier one. */
export function createPairCode(dataDir: string, now = Date.now()): string {
  let raw = "";
  for (let i = 0; i < 8; i++) raw += CROCKFORD[randomInt(32)];
  writeFileAtomic(
    path.join(dataDir, PAIR_CODE_FILE),
    JSON.stringify({ hash: hashCode(raw), expiresAt: now + PAIR_CODE_TTL_MS }) + "\n",
  );
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** True (and the code is used up) when `code` is the live one. */
export function consumePairCode(dataDir: string, code: string, now = Date.now()): boolean {
  const file = path.join(dataDir, PAIR_CODE_FILE);
  let stored: { hash?: string; expiresAt?: number };
  try {
    stored = JSON.parse(fs.readFileSync(file, "utf8")) as typeof stored;
  } catch {
    return false;
  }
  if (!stored.hash || !stored.expiresAt || now > stored.expiresAt) {
    fs.rmSync(file, { force: true });
    return false;
  }
  if (typeof code !== "string" || normalizePairCode(code).length !== 8) return false;
  const a = Buffer.from(hashCode(code), "hex");
  const b = Buffer.from(stored.hash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  fs.rmSync(file, { force: true });
  return true;
}

// ── Legacy plaintext secrets (migrated into the keychain by secrets.ts) ──

const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export function isValidSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

export function readSecrets(dataDir: string): Record<string, string> {
  const raw = readJsonObject(
    path.join(dataDir, SECRETS_FILE),
    "Fix it or move it aside; it is left untouched so no secret is lost.",
  );
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw ?? {})) if (typeof v === "string") out[k] = v;
  return out;
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
