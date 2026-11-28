// Controller facade for "machines" (paired fleet nodes): what the desktop
// app's Machines panel and `ezcoder fleet add|remove|rotate-token|share-auth`
// call. Plain-words errors throughout; nothing here prints.
import fs from "node:fs";
import { getAppPaths } from "@prestyj/core";
import {
  clearNodeInfoCache,
  FleetClient,
  FleetClientError,
  normalizePairCode,
  type FleetClientOptions,
} from "./client.js";
import { discoverNodes } from "./discovery.js";
import {
  DEFAULT_NODE_PORT,
  type AgentWorkspaceStatus,
  type DoctorReport,
  type GpuInfo,
  type HelloResponse,
  type JobStatus,
  type NodePlatform,
  type ServiceStatus,
} from "./protocol.js";
import { parsePairing, type FleetNode, type Pairing } from "./registry.js";
import { FleetService } from "./service.js";

export interface MachineView {
  name: string;
  url: string;
  /** Answered just now. */
  online: boolean;
  /** S3: no common protocol (names the side to update); the machine gets no work. */
  incompatible?: string;
  /** Why it is offline, when it is. */
  error?: string;
  platform?: NodePlatform;
  version?: string;
  protocol?: number;
  /** S7: the machine runs an older EZ Coder than this one. */
  updateNotice?: string;
  /** Load average per cpu. */
  load?: number;
  cpus?: number;
  memoryGb?: number;
  memoryFreeGb?: number;
  gpus: GpuInfo[];
  slots: number;
  slotsUsed: number;
  labels: string[];
  docker?: boolean;
  dockerOnly?: boolean;
  modelAuth?: boolean;
  /** TLS pinned (ezfleets://). */
  tls: boolean;
  /** Our fleet jobs not finished there. */
  ourJobs: number;
  jobs: JobStatus[];
  services: ServiceStatus[];
  agents: AgentWorkspaceStatus[];
}

export interface FleetCapacity {
  /** This machine's slots for local work. */
  local: number;
  /** Slots used on online, compatible nodes. */
  nodesUsed: number;
  /** Slots of online, compatible nodes. */
  nodesTotal: number;
  /** local + nodesTotal. */
  total: number;
}

export interface MachineOptions {
  /** Fleet service to use (default the process-wide one). */
  svc?: FleetService;
}

function service(opts: MachineOptions): FleetService {
  return opts.svc ?? FleetService.shared();
}

/** Every paired machine with live state (D1). Offline machines show their last error. */
export async function listMachines(opts: MachineOptions = {}): Promise<MachineView[]> {
  const nodes = await service(opts).nodes();
  return nodes.map((n): MachineView => {
    const i = n.info;
    return {
      name: n.node.name,
      url: n.node.url,
      online: n.online,
      ...(n.incompatible ? { incompatible: n.incompatible } : {}),
      ...(n.error ? { error: n.error } : {}),
      ...(i
        ? {
            platform: i.platform,
            version: i.version,
            protocol: i.protocol,
            load: i.load,
            cpus: i.cpus,
            memoryGb: i.memoryGb,
            memoryFreeGb: i.memoryFreeGb,
            docker: i.docker,
            modelAuth: i.modelAuth,
            ...(i.dockerOnly ? { dockerOnly: true } : {}),
          }
        : {}),
      ...(n.updateNotice ? { updateNotice: n.updateNotice } : {}),
      gpus: i?.gpus ?? [],
      slots: i?.slots ?? 0,
      slotsUsed: i?.slotsUsed ?? 0,
      labels: [...new Set([...(i?.labels ?? []), ...n.node.labels])],
      tls: !!n.node.fingerprint,
      ourJobs: n.active,
      jobs: i?.jobs ?? [],
      services: i?.services ?? [],
      agents: i?.agents ?? [],
    };
  });
}

/** Total capacity: local slots plus every online, compatible node's slots. */
export function fleetCapacity(machines: readonly MachineView[], localSlots: number): FleetCapacity {
  const usable = machines.filter((m) => m.online && !m.incompatible);
  const nodesTotal = usable.reduce((n, m) => n + m.slots, 0);
  const nodesUsed = usable.reduce((n, m) => n + Math.min(m.slots, m.slotsUsed), 0);
  return { local: localSlots, nodesUsed, nodesTotal, total: localSlots + nodesTotal };
}

export interface AddMachineOptions extends MachineOptions {
  /** Pair without checking the machine (it is off right now). */
  offline?: boolean;
  /** Pairing by code: the machine's address (default: look on the tailnet). */
  host?: string;
  labels?: string[];
  /** Repo the doctor checks git access to. */
  repo?: string;
  /** Tailnet nodes to try a code on (tests; default `discoverNodes`). */
  discover?: () => Promise<{ name: string; url: string; paired: boolean }[]>;
  client?: FleetClientOptions;
}

export interface AddMachineResult {
  node: FleetNode;
  /** Reached, token accepted, protocol compatible. False only with `offline`. */
  verified: boolean;
  hello?: HelloResponse;
  doctor?: DoctorReport;
  /** Things the user should know (doctor unavailable, older version, ...). */
  warnings: string[];
}

const PAIRING_PREFIX = /^ezfleets?:\/\//i;

function hostUrl(host: string): string {
  const h = host.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(h)) return /:\d+$/.test(h) ? h : `${h}:${DEFAULT_NODE_PORT}`;
  return /:\d+$/.test(h) && !h.startsWith("[") ? `http://${h}` : `http://${h}:${DEFAULT_NODE_PORT}`;
}

/** S9: trade a short code for the pairing string, at `host` or on each tailnet node. */
async function pairingFromCode(code: string, opts: AddMachineOptions): Promise<Pairing> {
  const c = normalizePairCode(code);
  if (!c) {
    throw new Error(
      `"${code.slice(0, 20)}" is neither a pairing string (ezfleet://…) nor a pairing code (like K7QM-2XPA)`,
    );
  }
  const urls = opts.host
    ? [hostUrl(opts.host)]
    : (await (opts.discover ?? (() => discoverNodes()))().catch(() => []))
        .filter((f) => !f.paired)
        .map((f) => f.url);
  if (!urls.length) {
    throw new Error(
      "no unpaired EZ Coder node found on the tailnet to use the code with; pass --host <address of the other machine>",
    );
  }
  let last: unknown;
  for (const url of urls) {
    let seen: string | undefined;
    const client = new FleetClient(url, url, undefined, {
      timeoutMs: 5000,
      ...opts.client,
      onPeerFingerprint: (fp) => (seen = fp),
    });
    try {
      const r = await client.pairWithCode(c);
      const p = parsePairing(r.pairing);
      // The certificate we just talked to must be the one the string pins (X10).
      if (p.fingerprint && seen && seen !== p.fingerprint) {
        throw new Error(
          `the machine at ${url} answered with a certificate that doesn't match its pairing string; not pairing`,
        );
      }
      return p;
    } catch (e) {
      last = e;
      if (opts.host) break;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/**
 * Pair a machine from a pairing string or a short code (D2, S2, S9). Unless
 * `offline`, refuses when the machine can't be reached, rejects the token or
 * speaks an incompatible protocol; then runs its doctor and returns the report.
 */
export async function addMachine(
  pairingOrCode: string,
  opts: AddMachineOptions = {},
): Promise<AddMachineResult> {
  const input = pairingOrCode.trim();
  if (!input) throw new Error("no pairing string given");
  const p = PAIRING_PREFIX.test(input) ? parsePairing(input) : await pairingFromCode(input, opts);
  const svc = service(opts);
  const warnings: string[] = [];
  const client = new FleetClient(p.name, p.url, p.token, {
    timeoutMs: 8000,
    ...opts.client,
    ...(p.fingerprint ? { fingerprint: p.fingerprint } : {}),
  });
  let hello: HelloResponse | undefined;
  let doctor: DoctorReport | undefined;
  if (!opts.offline) {
    try {
      hello = await client.handshake();
      await client.info(); // the token check
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      throw new FleetClientError(
        `not pairing ${p.name}: ${why}. Fix that and try again, or pair anyway with --offline`,
        e instanceof FleetClientError ? e.code : "unreachable",
        e instanceof FleetClientError ? e.status : undefined,
        e instanceof FleetClientError ? e.update : undefined,
      );
    }
    if (hello.name !== p.name) {
      warnings.push(`the machine calls itself ${hello.name}; paired as ${p.name}`);
    }
    try {
      doctor = await client.doctor(opts.repo);
    } catch (e) {
      warnings.push(
        `couldn't run the machine's checks (${e instanceof Error ? e.message : String(e)}); run \`ezcoder node doctor\` there`,
      );
    }
  }
  const node = await svc.registry.add({
    name: p.name,
    url: p.url,
    token: p.token,
    labels: opts.labels ?? [],
    ...(p.fingerprint ? { fingerprint: p.fingerprint } : {}),
  });
  clearNodeInfoCache(p.name);
  return {
    node,
    verified: !opts.offline,
    ...(hello ? { hello } : {}),
    ...(doctor ? { doctor } : {}),
    warnings,
  };
}

/** Forget a paired machine (the machine itself keeps running). False when not paired. */
export async function removeMachine(name: string, opts: MachineOptions = {}): Promise<boolean> {
  const removed = await service(opts).registry.remove(name);
  clearNodeInfoCache(name);
  return removed;
}

async function paired(svc: FleetService, name: string): Promise<FleetNode> {
  const node = await svc.registry.get(name);
  if (!node) throw new Error(`no paired machine "${name}"`);
  return node;
}

/**
 * S4/D5: the machine issues a new token (the old one stops working at once);
 * it is stored here. Returns the fresh pairing string for other controllers.
 */
export async function rotateMachineToken(
  name: string,
  opts: MachineOptions = {},
): Promise<{ pairing: string }> {
  const svc = service(opts);
  const r = await svc.client(await paired(svc, name)).rotateToken();
  await svc.registry.setToken(name, r.token);
  clearNodeInfoCache(name);
  return { pairing: r.pairing };
}

/** Model credentials safe to share: provider entries, never local endpoint keys. */
export function shareableCredentials(authFile: string): Record<string, unknown> {
  const raw = JSON.parse(fs.readFileSync(authFile, "utf8")) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith("local:")));
}

export interface ShareAuthOptions extends MachineOptions {
  /** Replace credentials the machine already has (R8). */
  force?: boolean;
  /** auth.json to share (default ~/.ezcoder/auth.json). */
  authFile?: string;
}

/**
 * Copy this machine's model credentials to a machine (opt-in). Without `force`
 * a machine that already has credentials is left alone: FleetClientError
 * "exists" with a plain message.
 */
export async function shareAuth(
  name: string,
  opts: ShareAuthOptions = {},
): Promise<{ providers: string[] }> {
  const svc = service(opts);
  const node = await paired(svc, name);
  let creds: Record<string, unknown>;
  try {
    creds = shareableCredentials(opts.authFile ?? getAppPaths().authFile);
  } catch {
    creds = {};
  }
  const providers = Object.keys(creds);
  if (!providers.length) {
    throw new Error("no model credentials on this machine (run `ezcoder login` first)");
  }
  try {
    await svc
      .client(node)
      .shareAuth({ credentials: creds, ...(opts.force ? { force: true } : {}) });
  } catch (e) {
    if (e instanceof FleetClientError && e.code === "exists") {
      throw new FleetClientError(
        `${name} already has its own model login, so nothing was changed. To replace it with this machine's, share again with force (\`ezcoder fleet share-auth ${name} --yes --force\`); safer: keep the node's own login`,
        "exists",
        409,
      );
    }
    throw e;
  }
  return { providers };
}
