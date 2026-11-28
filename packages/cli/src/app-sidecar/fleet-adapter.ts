// The desktop app's one door into core/fleet (D1–D5). Machines go through the
// controller facade (core/fleet/machines.ts: listMachines, fleetCapacity,
// addMachine, removeMachine, rotateMachineToken, shareAuth); doctor through
// FleetClient.doctor; activity and logs through FleetService. This file turns
// their answers into the app's shapes and plain-words errors.
import { getAppPaths } from "@prestyj/core";
import { FleetClientError } from "../core/fleet/client.js";
import type { FoundNode } from "../core/fleet/discovery.js";
import * as Machines from "../core/fleet/machines.js";
import { cliVersion } from "../core/fleet/node/info.js";
import {
  FLEET_MIN_PROTOCOL,
  FLEET_PROTOCOL,
  type DoctorCheck,
  type DoctorReport,
  type NodeInfo,
  type NodePlatform,
} from "../core/fleet/protocol.js";
import { parsePairing, type FleetNode } from "../core/fleet/registry.js";
import { FleetService } from "../core/fleet/service.js";
import { isFleetTerminal, type FleetJob, type FleetServiceRecord } from "../core/fleet/types.js";

// ── Wire shapes the app reads ──────────────────────────────

export interface MachineNotice {
  kind: "update" | "protocol" | "offline";
  /** One plain sentence, with what to do. */
  text: string;
}

export interface MachineView {
  name: string;
  /** Host (and port) the machine is reached at, without the token. */
  address: string;
  online: boolean;
  platform?: NodePlatform;
  version?: string;
  /** Load per CPU (0..n), when known. */
  load?: number;
  cpus?: number;
  memoryGb?: number;
  gpus: { name: string; memoryGb: number }[];
  slots?: number;
  slotsUsed?: number;
  /** What runs there right now. */
  running: { jobs: number; services: number; agents: number };
  /** Our unfinished jobs placed on it (incl. ones still preparing). */
  ourJobs: number;
  labels: string[];
  modelLogin?: boolean;
  dockerOnly?: boolean;
  notices: MachineNotice[];
  addedAt: string;
}

export interface AddMachineResult {
  name: string;
  online: boolean;
  /** Absent when the machine couldn't be reached (offline add). */
  doctor?: DoctorReport;
}

export interface ShareAuthResult {
  /** "exists": the machine already has its own login; ask before replacing it. */
  status: "shared" | "exists";
  providers: string[];
}

export interface FleetActivityJob {
  id: string;
  name: string;
  kind: string;
  state: FleetJob["state"];
  node?: string;
  summary?: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
}

export interface FleetActivityService {
  id: string;
  name: string;
  kind: string;
  state: FleetServiceRecord["state"];
  node: string;
  summary?: string;
  endpoints: { name: string; url: string }[];
}

export interface FleetActivity {
  jobs: FleetActivityJob[];
  services: FleetActivityService[];
}

/** Slots in use / total: one slot runs one job or helper agent. */
export interface Capacity {
  slots: number;
  slotsUsed: number;
}

export interface MachinesOverview {
  machines: MachineView[];
  /** This computer's own share of the work. */
  local: Capacity & { estimated?: boolean };
  /** This computer plus every machine that's online. */
  total: Capacity;
}

export interface FleetAdapter {
  version(): string;
  listMachines(): Promise<MachineView[]>;
  /** Machines plus capacity totals (this computer and every online machine). */
  overview(): Promise<MachinesOverview>;
  addMachine(input: string, opts?: { offline?: boolean }): Promise<AddMachineResult>;
  removeMachine(name: string): Promise<boolean>;
  rotateMachineToken(name: string): Promise<void>;
  shareAuth(name: string, opts?: { force?: boolean }): Promise<ShareAuthResult>;
  doctor(name: string): Promise<DoctorReport>;
  activity(cwd: string): Promise<FleetActivity>;
  jobLog(id: string, tail: number): Promise<string>;
  serviceLog(id: string, tail: number): Promise<string>;
}

/** A plain-words problem the app shows as-is (HTTP 400). */
export class FleetUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FleetUserError";
  }
}

// ── Helpers ────────────────────────────────────────────────

/** -1 / 0 / 1 comparing dotted versions (pre-release tags ignored). */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .replace(/^v/, "")
      .split(/[-+]/)[0]!
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

function addressOf(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

const PAIR_CODE = /^[0-9A-Z]{4}-?[0-9A-Z]{4}$/i;

/** Notices for one machine: older CLI, protocol out of range, unreachable. */
export function machineNotices(
  info: Pick<NodeInfo, "version" | "protocol" | "minProtocol"> | undefined,
  ours: string,
  online: boolean,
  error?: string,
): MachineNotice[] {
  const notices: MachineNotice[] = [];
  if (!online) {
    notices.push({
      kind: "offline",
      text: error
        ? `Can't reach this machine right now. Check that it's on, signed in to Tailscale and running EZ Coder. (${error})`
        : "Can't reach this machine right now. Check that it's on, signed in to Tailscale and running EZ Coder.",
    });
  }
  if (error && /protocol|update (the )?(node|controller)/i.test(error)) {
    notices.push({ kind: "protocol", text: error });
  }
  if (info) {
    if (info.protocol < FLEET_MIN_PROTOCOL) {
      notices.push({
        kind: "protocol",
        text: "This machine's EZ Coder is too old to take work from this computer. Update it: run `ezcoder node update` there.",
      });
    } else if ((info.minProtocol ?? info.protocol) > FLEET_PROTOCOL) {
      notices.push({
        kind: "protocol",
        text: "This machine's EZ Coder is newer than this computer's. Update EZ Coder here to keep using it.",
      });
    } else if (compareVersions(info.version, ours) < 0) {
      notices.push({
        kind: "update",
        text: `This machine has EZ Coder ${info.version}; this computer has ${ours}. Update it with \`ezcoder node update\` there.`,
      });
    }
  }
  return notices;
}

/** A doctor report put together from /v1/info, for nodes without /v1/doctor. */
export function doctorFromInfo(info: NodeInfo, ours: string): DoctorReport {
  const checks: DoctorCheck[] = [];
  const versionNote = machineNotices(info, ours, true)[0];
  checks.push(
    versionNote
      ? {
          id: "version",
          status: versionNote.kind === "protocol" ? "fail" : "warn",
          detail: `EZ Coder ${info.version} is installed.`,
          fix: "ezcoder node update",
        }
      : { id: "version", status: "ok", detail: `EZ Coder ${info.version} is installed.` },
  );
  checks.push(
    info.docker
      ? { id: "docker", status: "ok", detail: "Docker is running." }
      : {
          id: "docker",
          status: "warn",
          detail: "Docker isn't running, so only plain commands can run here.",
          fix: "Install Docker and start it, then run `ezcoder node serve` again.",
        },
  );
  checks.push(
    info.gpus.length
      ? {
          id: "gpu",
          status: "ok",
          detail: `Graphics card: ${info.gpus.map((g) => g.name).join(", ")}.`,
        }
      : { id: "gpu", status: "skip", detail: "No graphics card found." },
  );
  checks.push(
    info.modelAuth
      ? { id: "model_login", status: "ok", detail: "It has its own model login." }
      : {
          id: "model_login",
          status: "warn",
          detail: "It has no model login, so helper agents can't run there yet.",
          fix: "Run `ezcoder login` on that machine, or use Share model login here.",
        },
  );
  checks.push(
    info.diskFreeGb >= 10
      ? { id: "disk", status: "ok", detail: `${Math.round(info.diskFreeGb)} GB of disk free.` }
      : {
          id: "disk",
          status: "warn",
          detail: `Only ${Math.round(info.diskFreeGb)} GB of disk free.`,
          fix: "Free up some disk space on that machine.",
        },
  );
  checks.push({
    id: "slots",
    status: info.slots > 0 ? "ok" : "fail",
    detail: `Room for ${info.slots} job${info.slots === 1 ? "" : "s"} at once.`,
    ...(info.slots > 0 ? {} : { fix: "ezcoder node init --slots 2" }),
  });
  return {
    node: info.name,
    version: info.version,
    protocol: info.protocol,
    checks,
    ok: checks.every((c) => c.status !== "fail"),
  };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function tailLines(text: string, n: number): string {
  const lines = text.replace(/\n$/, "").split("\n");
  return lines.slice(-Math.max(1, n)).join("\n");
}

// ── The adapter ────────────────────────────────────────────

export interface FleetAdapterOptions {
  service?: FleetService;
  /** Fetch for machines not yet paired (tests); paired ones use the service's. */
  fetch?: typeof fetch;
  /** auth.json with this machine's model logins. */
  authFile?: string;
  /** This computer's EZ Coder version. */
  version?: string;
  /** This computer's slots (default: the controller's `localCapacity()`). */
  localCapacity?: () => Promise<Capacity & { estimated?: boolean }>;
  /** Tailscale discovery, for short pairing codes. */
  discover?: () => Promise<FoundNode[]>;
}

const UNREACHABLE = /^not pairing /;

/** The facade's machine record, as the app shows it. */
function toView(m: Machines.MachineView, ours: string, addedAt: string | undefined): MachineView {
  const notices: MachineNotice[] = [];
  if (!m.online) notices.push(...machineNotices(undefined, ours, false, m.error));
  if (m.incompatible) notices.push({ kind: "protocol", text: m.incompatible });
  else if (m.updateNotice) notices.push({ kind: "update", text: m.updateNotice });
  else if (m.online && m.version && m.protocol !== undefined) {
    notices.push(...machineNotices({ version: m.version, protocol: m.protocol }, ours, true));
  }
  return {
    name: m.name,
    address: addressOf(m.url),
    online: m.online,
    ...(m.platform ? { platform: m.platform } : {}),
    ...(m.version ? { version: m.version } : {}),
    ...(m.load !== undefined ? { load: m.load } : {}),
    ...(m.cpus !== undefined ? { cpus: m.cpus } : {}),
    ...(m.memoryGb !== undefined ? { memoryGb: m.memoryGb } : {}),
    ...(m.online ? { slots: m.slots, slotsUsed: m.slotsUsed } : {}),
    ...(m.modelAuth !== undefined ? { modelLogin: m.modelAuth } : {}),
    ...(m.dockerOnly ? { dockerOnly: true } : {}),
    gpus: m.gpus.map((g) => ({ name: g.name, memoryGb: g.memoryGb })),
    running: {
      jobs: m.jobs.filter((j) => j.state === "running" || j.state === "preparing").length,
      services: m.services.filter((x) => x.state === "running").length,
      agents: m.agents.filter((a) => a.state === "running").length,
    },
    ourJobs: m.ourJobs,
    labels: m.labels,
    notices,
    addedAt: addedAt ?? "",
  };
}

export function createFleetAdapter(opts: FleetAdapterOptions = {}): FleetAdapter {
  const svc = (): FleetService => opts.service ?? FleetService.shared();
  const ours = (): string => opts.version ?? cliVersion();
  const base = (): Machines.MachineOptions => ({ svc: svc() });
  const paired = async (name: string): Promise<FleetNode> => {
    const node = await svc().registry.get(name);
    if (!node) throw new FleetUserError(`There's no machine called ${name} any more.`);
    return node;
  };

  /** The machine's own checks; nodes without /v1/doctor get the same lines from /v1/info. */
  async function doctorFor(node: FleetNode): Promise<DoctorReport> {
    const client = svc().client(node);
    try {
      return await client.doctor();
    } catch (e) {
      if (!(e instanceof FleetClientError) || e.code !== "not_found") throw e;
      return doctorFromInfo(await client.info(), ours());
    }
  }

  async function localCapacity(): Promise<Capacity & { estimated?: boolean }> {
    if (opts.localCapacity) return opts.localCapacity();
    return { slots: svc().localCapacity(), slotsUsed: 0 };
  }

  async function views(): Promise<{ raw: Machines.MachineView[]; views: MachineView[] }> {
    const [raw, nodes] = await Promise.all([Machines.listMachines(base()), svc().registry.list()]);
    const added = new Map(nodes.map((n) => [n.name, n.addedAt]));
    return { raw, views: raw.map((m) => toView(m, ours(), added.get(m.name))) };
  }

  const adapter: FleetAdapter = {
    version: ours,

    async overview() {
      const [{ raw, views: machines }, local] = await Promise.all([views(), localCapacity()]);
      const cap = Machines.fleetCapacity(raw, local.slots);
      return {
        machines,
        local,
        total: { slots: cap.total, slotsUsed: local.slotsUsed + cap.nodesUsed },
      };
    },

    async listMachines() {
      return (await views()).views;
    },

    async addMachine(input, { offline = false } = {}) {
      const text = input.trim();
      if (!text) throw new FleetUserError("Paste the pairing text or type the code first.");
      const isPairing = /^ezfleets?:\/\//i.test(text);
      if (isPairing) {
        try {
          parsePairing(text);
        } catch (e) {
          throw new FleetUserError(
            `That pairing text doesn't look right (${errText(e)}). Copy it again from the other machine.`,
          );
        }
      } else if (!PAIR_CODE.test(text)) {
        throw new FleetUserError(
          "That isn't a pairing text or code. It starts with ezfleet:// or looks like K7QM-2XPA.",
        );
      }
      const existing = isPairing ? await svc().registry.get(parsePairing(text).name) : undefined;
      let result: Machines.AddMachineResult;
      try {
        result = await Machines.addMachine(isPairing ? text : text.toUpperCase(), {
          ...base(),
          offline,
          ...(existing ? { labels: existing.labels } : {}),
          ...(opts.fetch ? { client: { fetch: opts.fetch } } : {}),
          ...(opts.discover ? { discover: opts.discover } : {}),
        });
      } catch (e) {
        if (!isPairing) {
          throw new FleetUserError(
            "None of the machines on your Tailscale network took that code. Codes last 10 minutes and work once: run `ezcoder node pair --code` again for a fresh one, or paste the full pairing text.",
          );
        }
        const name = parsePairing(text).name;
        if (e instanceof FleetClientError && e.code === "auth") {
          throw new FleetUserError(
            `${name} turned down the pairing text. Run \`ezcoder node pair\` there and copy the new one.`,
          );
        }
        if (e instanceof Error && UNREACHABLE.test(e.message)) {
          const why = e.message
            .replace(UNREACHABLE, "")
            .replace(/^[^:]*:\s*/, "")
            .replace(/\. Fix that and try again.*$/, "");
          throw new FleetUserError(
            `Couldn't reach ${name} (${why}). To add it anyway, tick "Add it even if it's off".`,
          );
        }
        throw e;
      }
      const { node, verified } = result;
      if (!verified) return { name: node.name, online: false };
      const doctor = result.doctor ?? (await doctorFor(node).catch(() => undefined));
      return { name: node.name, online: true, ...(doctor ? { doctor } : {}) };
    },

    async removeMachine(name) {
      return Machines.removeMachine(name, base());
    },

    async rotateMachineToken(name) {
      await paired(name);
      await Machines.rotateMachineToken(name, base());
    },

    async shareAuth(name, { force = false } = {}) {
      await paired(name);
      const authFile = opts.authFile ?? getAppPaths().authFile;
      try {
        const { providers } = await Machines.shareAuth(name, { ...base(), force, authFile });
        return { status: "shared", providers };
      } catch (e) {
        if (e instanceof FleetClientError && (e.code === "exists" || e.status === 409)) {
          let providers: string[] = [];
          try {
            providers = Object.keys(Machines.shareableCredentials(authFile));
          } catch {
            // unreadable auth file: the re-ask doesn't need the list
          }
          return { status: "exists", providers };
        }
        if (e instanceof Error && /no model credentials/.test(e.message)) {
          throw new FleetUserError(
            "There's no model login on this computer to share. Sign in under AI Providers first.",
          );
        }
        throw e;
      }
    },

    async doctor(name) {
      return doctorFor(await paired(name));
    },

    async activity(cwd) {
      const [jobs, services] = await Promise.all([svc().list(cwd), svc().serviceList(cwd)]);
      // Finished jobs stay listed a few minutes so the result is seen.
      const recent = Date.now() - 10 * 60_000;
      return {
        jobs: jobs
          .filter(
            (j) => !isFleetTerminal(j.state) || Date.parse(j.finishedAt ?? j.updatedAt) > recent,
          )
          .slice(-20)
          .map((j) => ({
            id: j.id,
            name: j.name,
            kind: j.kind,
            state: j.state,
            ...(j.node ? { node: j.node } : {}),
            ...(j.summary ? { summary: j.summary } : {}),
            ...(j.startedAt ? { startedAt: j.startedAt } : {}),
            ...(j.finishedAt ? { finishedAt: j.finishedAt } : {}),
            updatedAt: j.updatedAt,
          })),
        services: services
          .filter((s) => s.state !== "stopped")
          .map((s) => ({
            id: s.id,
            name: s.name,
            kind: s.kind,
            state: s.state,
            node: s.node,
            ...(s.summary ? { summary: s.summary } : {}),
            endpoints: s.endpoints,
          })),
      };
    },

    async jobLog(id, tail) {
      return tailLines(await svc().logs(id), tail);
    },

    async serviceLog(id, tail) {
      return svc().serviceLog(id, tail);
    },
  };
  return adapter;
}

let shared: FleetAdapter | undefined;

/** The adapter the sidecar routes use. */
export function fleetAdapter(): FleetAdapter {
  shared ??= createFleetAdapter();
  return shared;
}
