// The fleet orchestrator on the controller. Sessions and the CLI queue jobs and
// return at once; one leader process (a session host or `ezcoder fleet daemon`)
// dispatches them to nodes with bounded concurrency, polls them, downloads
// artifacts, requeues work lost with a node (never deploys) and records results.
// Every process watches the shared store and tells its own sessions.
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { cacheKeyFor } from "../validation/config.js";
import { defaultExec } from "../validation/exec.js";
import type { GateResult } from "../validation/service.js";
import type { Exec } from "../validation/types.js";
import {
  addCustomEndpoint,
  removeCustomEndpoint,
  type LocalEndpointStoreOptions,
} from "../local-endpoint-store.js";
import { FleetClient, FleetClientError } from "./client.js";
import {
  chooseNode,
  type InFlightWork,
  type NodeView,
  type PlacementRequest,
} from "./fleet-scheduler.js";
import { FleetGit } from "./git.js";
import {
  builtinServices,
  loadFleetConfig,
  type FleetJobSpec,
  type FleetProjectConfig,
  type FleetServiceSpec,
} from "./project-config.js";
import type {
  ExecResponse,
  JobRequest,
  JobStatus,
  NodeInfo,
  ServiceRequest,
  ServiceStatus,
  SourceSpec,
} from "./protocol.js";
import { NodeRegistry, type FleetNode } from "./registry.js";
import { defaultFleetDir, JsonListStore, LeaderLock, readFleetSettings } from "./store.js";
import {
  FLEET_MAX_ATTEMPTS,
  isFleetTerminal,
  REQUEUE_KINDS,
  type FleetJob,
  type FleetJobState,
  type FleetServiceRecord,
} from "./types.js";

export interface FleetServiceOptions {
  dir?: string;
  exec?: Exec;
  fetch?: typeof fetch;
  pollMs?: number;
  /** Per-request node timeout. */
  clientTimeoutMs?: number;
  /** Validation gate for deploys (default: the shared ValidationService). */
  gate?: (cwd: string, sha: string) => Promise<GateResult>;
  maxConcurrent?: number;
  /** Minutes a node may be unreachable while it runs a job before the job moves. */
  unreachableRequeueMinutes?: number;
  /** Where inference endpoints are registered (tests); false disables it. */
  localEndpoints?: LocalEndpointStoreOptions | false;
  /** Cap for automatic artifact downloads per job. */
  maxArtifactBytes?: number;
  autoStart?: boolean;
}

export interface RunOptions {
  node?: string;
  /** Send uncommitted local changes as a patch. */
  includeUncommitted?: boolean;
  ref?: string;
  /** Artifacts folder override. */
  outDir?: string;
}

export interface RunResult {
  job: FleetJob;
  messages: string[];
}

export interface NodeSummary {
  node: FleetNode;
  online: boolean;
  info?: NodeInfo;
  error?: string;
  /** Our unfinished jobs there. */
  active: number;
}

export interface ServiceUpOptions {
  node?: string;
  includeUncommitted?: boolean;
}

export type FleetEvent =
  | { type: "job"; job: FleetJob; previous?: FleetJobState; requeued: boolean }
  | { type: "service"; service: FleetServiceRecord; previous?: string };

const ACTIVE_JOB: ReadonlySet<FleetJobState> = new Set(["queued", "preparing", "running"]);
const KEEP_DAYS = 14;
const KEEP_MAX = 500;

function nowIso(): string {
  return new Date().toISOString();
}

function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
}

export function short(sha: string): string {
  return sha.slice(0, 8);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function pruneJobs(jobs: FleetJob[]): FleetJob[] {
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  let kept = jobs.filter((j) => !isFleetTerminal(j.state) || Date.parse(j.updatedAt) > cutoff);
  if (kept.length > KEEP_MAX) {
    const active = kept.filter((j) => !isFleetTerminal(j.state));
    const done = kept.filter((j) => isFleetTerminal(j.state)).slice(-(KEEP_MAX - active.length));
    kept = [...done, ...active].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  return kept;
}

function pruneServices(list: FleetServiceRecord[]): FleetServiceRecord[] {
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  return list.filter((s) => s.state !== "stopped" || Date.parse(s.updatedAt) > cutoff);
}

/** Map a node job state onto ours. */
function mapState(s: JobStatus["state"]): FleetJobState | "lost" {
  return s === "lost" ? "lost" : s;
}

/** Safe relative path for an artifact (no traversal, no absolute paths). */
export function safeArtifactPath(p: string): string | undefined {
  const parts = p
    .replace(/\\/g, "/")
    .split("/")
    .filter((x) => x && x !== ".");
  if (!parts.length || parts.some((x) => x === "..")) return undefined;
  return parts.join("/");
}

/**
 * Local file for an artifact under `dir`. Refuses to write through a symlink
 * (an existing `dir/dist -> /elsewhere` would otherwise redirect the download).
 */
export function safeArtifactDest(dir: string, rel: string): string {
  fs.mkdirSync(dir, { recursive: true });
  let cur = fs.realpathSync(dir);
  for (const part of rel.split("/")) {
    cur = path.join(cur, part);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch {
      break; // the rest doesn't exist yet: created as plain folders/files
    }
    if (st.isSymbolicLink())
      throw new Error(`refusing to write artifact through a symlink: ${cur}`);
  }
  return path.join(fs.realpathSync(dir), rel);
}

let shared: FleetService | undefined;

export class FleetService {
  readonly dir: string;
  readonly jobs: JsonListStore<FleetJob>;
  readonly services: JsonListStore<FleetServiceRecord>;
  readonly registry: NodeRegistry;
  private readonly exec: Exec;
  private readonly git: FleetGit;
  private readonly fetchImpl?: typeof fetch;
  private readonly pollMs: number;
  private readonly clientTimeoutMs: number;
  private readonly unreachableMs: number;
  private readonly maxArtifactBytes: number;
  private readonly leader: LeaderLock;
  private readonly gateFn: (cwd: string, sha: string) => Promise<GateResult>;
  private readonly localEndpoints: LocalEndpointStoreOptions | false;
  private readonly maxConcurrentOverride?: number;
  private readonly events = new EventEmitter();
  private readonly lastInfo = new Map<string, NodeInfo>();
  private seenJobs = new Map<string, string>();
  private seenServices = new Map<string, string>();
  private seeded = false;
  private timer: NodeJS.Timeout | undefined;
  private ticking: Promise<void> | undefined;
  private keepAlive = false;
  autoStart: boolean;

  constructor(opts: FleetServiceOptions = {}) {
    this.dir = opts.dir ?? defaultFleetDir();
    this.jobs = new JsonListStore<FleetJob>(this.dir, "jobs.json", "jobs", { prune: pruneJobs });
    this.services = new JsonListStore<FleetServiceRecord>(this.dir, "services.json", "services", {
      prune: pruneServices,
    });
    this.registry = new NodeRegistry(this.dir);
    this.exec = opts.exec ?? defaultExec;
    this.git = new FleetGit(this.exec);
    this.fetchImpl = opts.fetch;
    this.pollMs = opts.pollMs ?? 15_000;
    this.clientTimeoutMs = opts.clientTimeoutMs ?? 15_000;
    this.unreachableMs = (opts.unreachableRequeueMinutes ?? 3) * 60_000;
    this.maxArtifactBytes = opts.maxArtifactBytes ?? 2 * 1024 ** 3;
    this.leader = new LeaderLock(this.dir, Math.max(90_000, this.pollMs * 4));
    this.gateFn =
      opts.gate ??
      (async (cwd, sha) => {
        const { ValidationService } = await import("../validation/service.js");
        return ValidationService.shared().gate(cwd, sha);
      });
    this.localEndpoints = opts.localEndpoints ?? {};
    this.maxConcurrentOverride = opts.maxConcurrent;
    this.autoStart = opts.autoStart ?? true;
    this.events.setMaxListeners(100);
  }

  /** One service per process. */
  static shared(): FleetService {
    shared ??= new FleetService();
    return shared;
  }

  get maxConcurrent(): number {
    return Math.max(
      1,
      this.maxConcurrentOverride ?? readFleetSettings(this.dir).maxConcurrent ?? 8,
    );
  }

  onEvent(listener: (e: FleetEvent) => void): () => void {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  // ── nodes ────────────────────────────────────────────────

  client(node: FleetNode): FleetClient {
    return FleetClient.forNode(node, {
      timeoutMs: this.clientTimeoutMs,
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
    });
  }

  private async clientFor(name: string): Promise<FleetClient> {
    const node = await this.registry.get(name);
    if (!node) throw new Error(`node ${name} is no longer paired`);
    return this.client(node);
  }

  /** Live view of every paired node (info fetched in parallel). */
  async nodeViews(): Promise<NodeView[]> {
    const nodes = await this.registry.list();
    return Promise.all(
      nodes.map(async (n): Promise<NodeView> => {
        try {
          const info = await this.client(n).info();
          this.lastInfo.set(n.name, info);
          return { name: n.name, online: true, info, labels: n.labels };
        } catch (e) {
          const last = this.lastInfo.get(n.name);
          return {
            name: n.name,
            online: false,
            ...(last ? { info: last } : {}),
            labels: n.labels,
            error: errText(e),
          };
        }
      }),
    );
  }

  async nodes(): Promise<NodeSummary[]> {
    const [views, nodes, jobs] = await Promise.all([
      this.nodeViews(),
      this.registry.list(),
      this.jobs.read(),
    ]);
    return nodes.map((node) => {
      const v = views.find((x) => x.name === node.name)!;
      return {
        node,
        online: v.online,
        ...(v.online && v.info ? { info: v.info } : {}),
        ...(v.error ? { error: v.error } : {}),
        active: jobs.filter((j) => j.node === node.name && ACTIVE_JOB.has(j.state)).length,
      };
    });
  }

  // ── jobs ─────────────────────────────────────────────────

  config(cwd: string): FleetProjectConfig | { error: string } {
    return loadFleetConfig(cwd);
  }

  private patchFile(id: string): string {
    return path.join(this.dir, "patches", `${id}.b64`);
  }

  /** Resolve the code a job or devenv uses; throws "push first" when the commit isn't on origin. */
  private async source(
    cwd: string,
    opts: { includeUncommitted?: boolean; ref?: string },
  ): Promise<{ src: SourceSpec; repo?: string; dirty: boolean; messages: string[] }> {
    const g = await this.git.state(cwd, opts.ref ?? "HEAD");
    const messages: string[] = [];
    if (opts.includeUncommitted) {
      const p = await this.git.patch(cwd, g.sha);
      if (p.base !== g.sha) {
        messages.push(
          `Local commits after ${short(p.base)} (the newest pushed one) go as a patch.`,
        );
      }
      if (p.patch) messages.push(`Sending ${p.files} changed file(s) as a patch.`);
      return {
        src: { git: g.git, sha: p.base, ...(p.patch ? { patch: p.patch } : {}) },
        ...(g.repo ? { repo: g.repo } : {}),
        dirty: !!p.patch,
        messages,
      };
    }
    if (!g.onRemote) {
      throw new Error(
        `commit ${short(g.sha)} isn't on origin; push first (or include uncommitted work with --uncommitted / includeUncommitted)`,
      );
    }
    if (g.dirty) {
      messages.push(
        `Uncommitted changes are not included; this runs commit ${short(g.sha)}. Use --uncommitted to include them.`,
      );
    }
    return {
      src: { git: g.git, sha: g.sha },
      ...(g.repo ? { repo: g.repo } : {}),
      dirty: false,
      messages,
    };
  }

  private async checkGate(cwd: string, sha: string): Promise<void> {
    let g: GateResult;
    try {
      g = await this.gateFn(cwd, sha);
    } catch (e) {
      throw new Error(`deploy blocked: validation gate could not be checked (${errText(e)})`, {
        cause: e,
      });
    }
    if (!g.ok) {
      const rows =
        g.rows.map((r) => `${r.stage}: ${r.state}`).join(", ") || "no required stages passed";
      throw new Error(
        `deploy blocked: required validation hasn't passed at ${short(sha)} (${rows}). Run validate run, wait for it to pass, then deploy again.`,
      );
    }
  }

  /** Queue a job from the project config; returns at once. */
  async run(cwdIn: string, name: string, opts: RunOptions = {}): Promise<RunResult> {
    const cwd = path.resolve(cwdIn);
    const config = loadFleetConfig(cwd);
    if ("error" in config) throw new Error(config.error);
    const spec: FleetJobSpec | undefined = config.jobs[name];
    if (!spec) {
      const names = Object.keys(config.jobs);
      throw new Error(
        `no fleet job "${name}"; this project has: ${names.join(", ") || "none"} (define jobs in .ezcoder/fleet.json)`,
      );
    }
    if (opts.node && !(await this.registry.get(opts.node))) {
      throw new Error(`no paired node "${opts.node}"`);
    }
    if (!(await this.registry.list()).length) {
      throw new Error(
        "no nodes paired; run `ezcoder fleet discover`, then `ezcoder fleet add <pairing>`",
      );
    }
    const isDeploy = spec.kind === "deploy";
    if (isDeploy && opts.includeUncommitted) {
      throw new Error(
        "deploy runs exact pushed commits only; commit and push, then deploy without --uncommitted",
      );
    }
    const s = await this.source(cwd, opts);
    const ungated = isDeploy && spec.gate === false;
    if (isDeploy && !ungated) await this.checkGate(cwd, s.src.sha);

    const id = newId("f");
    if (s.src.patch) {
      fs.mkdirSync(path.dirname(this.patchFile(id)), { recursive: true });
      fs.writeFileSync(this.patchFile(id), s.src.patch, { mode: 0o600 });
    }
    const projectKey = s.repo ?? path.basename(cwd);
    const at = nowIso();
    const job: FleetJob = {
      id,
      name,
      kind: spec.kind,
      project: cwd,
      projectKey,
      git: s.src.git,
      sha: s.src.sha,
      ...(s.src.patch ? { hasPatch: true, base: s.src.sha } : {}),
      ...(spec.subdir ? { subdir: spec.subdir } : {}),
      command: spec.command,
      ...(spec.docker ? { docker: spec.docker } : {}),
      ...(spec.env ? { env: spec.env } : {}),
      ...(spec.secrets ? { secrets: spec.secrets } : {}),
      ...(spec.resources ? { resources: spec.resources } : {}),
      ...(spec.artifacts ? { artifactGlobs: spec.artifacts } : {}),
      cacheKey: spec.cacheKey ?? cacheKeyFor(projectKey),
      timeoutMinutes: spec.timeoutMinutes,
      ...(ungated ? { ungated: true } : {}),
      state: "queued",
      createdAt: at,
      updatedAt: at,
      ...(opts.node ? { node: opts.node, pinned: true } : {}),
      ...(opts.outDir ? { outDir: path.resolve(cwd, opts.outDir) } : {}),
      attempts: 1,
    };
    await this.jobs.update((jobs) => {
      jobs.push(job);
    });
    if (ungated) s.messages.push('deploy gate is off for this job ("gate": false).');
    if (this.autoStart) this.start();
    return { job, messages: s.messages };
  }

  async list(cwd?: string): Promise<FleetJob[]> {
    const jobs = await this.jobs.read();
    return cwd ? jobs.filter((j) => j.project === path.resolve(cwd)) : jobs;
  }

  async get(id: string): Promise<FleetJob | undefined> {
    return (await this.jobs.read()).find((j) => j.id === id);
  }

  async cancel(id: string): Promise<FleetJob | undefined> {
    const job = await this.jobs.update((jobs) => {
      const j = jobs.find((x) => x.id === id);
      if (!j || isFleetTerminal(j.state)) return j ? { ...j } : undefined;
      const wasDispatched = !!j.remoteId && j.state !== "queued";
      j.state = "cancelled";
      j.summary = "cancelled by request";
      j.updatedAt = j.finishedAt = nowIso();
      return { ...j, wasDispatched };
    });
    if (job && (job as { wasDispatched?: boolean }).wasDispatched && job.node && job.remoteId) {
      await this.clientFor(job.node)
        .then((c) => c.cancelJob(job.remoteId!))
        .catch(() => {});
    }
    if (job) delete (job as { wasDispatched?: boolean }).wasDispatched;
    return job;
  }

  /** Log text from `offset` (default: the last ~24 KB). */
  async logs(id: string, opts: { offset?: number; full?: boolean } = {}): Promise<string> {
    const job = await this.get(id);
    if (!job) return `No job ${id}.`;
    if (!job.node || !job.remoteId || job.state === "queued") {
      return `Not dispatched yet${job.summary ? ` (${job.summary})` : ""}.`;
    }
    const c = await this.clientFor(job.node);
    if (opts.offset !== undefined) return (await c.jobLog(job.remoteId, opts.offset)).text;
    const head = await c.jobLog(job.remoteId, 0);
    if (opts.full || head.text.length <= 24_000) return head.text || "(no output yet)";
    return `…\n${head.text.slice(-24_000)}`;
  }

  defaultArtifactsDir(job: FleetJob): string {
    return job.outDir ?? path.join(job.project, ".ezcoder", "artifacts", job.id);
  }

  /** Download a finished job's artifacts; returns local paths. */
  async downloadArtifacts(id: string, outDir?: string): Promise<{ dir: string; files: string[] }> {
    const job = await this.get(id);
    if (!job) throw new Error(`no job ${id}`);
    if (!job.node || !job.remoteId) throw new Error(`job ${id} hasn't run yet`);
    const c = await this.clientFor(job.node);
    const status = await c.job(job.remoteId);
    const list = status.artifacts ?? job.artifacts ?? [];
    const dir = outDir ? path.resolve(outDir) : this.defaultArtifactsDir(job);
    const files: string[] = [];
    let total = 0;
    for (const a of list) {
      const rel = safeArtifactPath(a.path);
      if (!rel) continue;
      total += a.bytes;
      if (!outDir && total > this.maxArtifactBytes) {
        throw new Error(
          `artifacts exceed ${Math.round(this.maxArtifactBytes / 1e9)} GB; download with --out <dir>`,
        );
      }
      const dest = safeArtifactDest(dir, rel);
      await c.downloadArtifact(job.remoteId, a.path, dest);
      files.push(dest);
    }
    await this.patchJob(id, { artifacts: list, artifactsDir: dir }, undefined, true);
    return { dir, files };
  }

  // ── services ─────────────────────────────────────────────

  private serviceSpec(cwd: string | undefined, name: string): FleetServiceSpec {
    if (cwd) {
      const config = loadFleetConfig(cwd);
      if ("error" in config) throw new Error(config.error);
      const spec = config.services[name];
      if (!spec) {
        throw new Error(
          `no fleet service "${name}"; available: ${Object.keys(config.services).join(", ")}`,
        );
      }
      return spec;
    }
    const spec = builtinServices()[name];
    if (!spec) throw new Error(`no built-in service "${name}" (built-ins: llm, browser)`);
    return spec;
  }

  async serviceList(cwd?: string): Promise<FleetServiceRecord[]> {
    const all = await this.services.read();
    return cwd ? all.filter((s) => !s.project || s.project === path.resolve(cwd)) : all;
  }

  /** Find a service by id, `node/name` or name (newest live one, this project first). */
  async findService(ref: string, cwd?: string): Promise<FleetServiceRecord | undefined> {
    const all = (await this.services.read()).filter((s) => s.state !== "stopped");
    const byId = all.find((s) => s.id === ref);
    if (byId) return byId;
    const [node, name] = ref.includes("/") ? ref.split("/", 2) : [undefined, ref];
    const matches = all.filter((s) => s.name === name && (!node || s.node === node));
    const project = cwd ? path.resolve(cwd) : undefined;
    return matches.filter((s) => s.project === project).at(-1) ?? matches.at(-1);
  }

  /** Start a service on a fitting node; returns once the node accepted it. */
  async serviceUp(
    cwdIn: string | undefined,
    name: string,
    opts: ServiceUpOptions = {},
  ): Promise<{ service: FleetServiceRecord; messages: string[]; reused: boolean }> {
    const cwd = cwdIn ? path.resolve(cwdIn) : undefined;
    const spec = this.serviceSpec(cwd, name);
    const existing = (await this.services.read()).find(
      (s) =>
        s.name === name &&
        s.project === cwd &&
        (s.state === "running" || s.state === "starting") &&
        (!opts.node || s.node === opts.node),
    );
    if (existing) return { service: existing, messages: [], reused: true };

    const messages: string[] = [];
    let source: SourceSpec | undefined;
    let projectKey: string | undefined;
    if (spec.needsSource) {
      if (!cwd) throw new Error(`service ${name} needs a project folder`);
      const s = await this.source(cwd, {
        includeUncommitted: opts.includeUncommitted ?? spec.kind === "devenv",
      });
      source = s.src;
      projectKey = s.repo ?? path.basename(cwd);
      messages.push(...s.messages);
    }
    const views = await this.nodeViews();
    const placement = chooseNode(
      { resources: spec.resources, docker: true, node: opts.node, takesSlot: false },
      views,
    );
    if ("error" in placement) throw new Error(`can't start ${name}: ${placement.error}`);
    if ("wait" in placement) throw new Error(`can't start ${name} now: ${placement.wait}`);
    const node = (await this.registry.get(placement.node.name))!;
    const id = `${name}-${randomBytes(3).toString("hex")}`;
    const req: ServiceRequest = {
      id,
      kind: spec.kind,
      ...(projectKey ? { project: projectKey } : {}),
      ...(source ? { source } : {}),
      docker: spec.docker,
      ...(spec.command ? { command: spec.command } : {}),
      ...(spec.env ? { env: spec.env } : {}),
      ports: spec.ports,
      ...(spec.resources ? { resources: spec.resources } : {}),
      ...(spec.persist ? { persist: spec.persist } : {}),
      ...(spec.idleStopMinutes !== undefined ? { idleStopMinutes: spec.idleStopMinutes } : {}),
    };
    const status = await this.client(node).startService(req);
    const at = nowIso();
    let rec: FleetServiceRecord = {
      id: status.id || id,
      name,
      kind: spec.kind,
      node: node.name,
      ...(cwd ? { project: cwd } : {}),
      state: status.state,
      endpoints: status.endpoints ?? [],
      ...(status.summary ? { summary: status.summary } : {}),
      createdAt: at,
      updatedAt: at,
    };
    await this.services.update((list) => {
      list.push(rec);
    });
    rec = (await this.syncLocalEndpoint(rec, messages)) ?? rec;
    if (this.autoStart) this.start();
    return { service: rec, messages, reused: false };
  }

  /** Register (or remove) the local model endpoint of an inference service. */
  private async syncLocalEndpoint(
    rec: FleetServiceRecord,
    messages?: string[],
  ): Promise<FleetServiceRecord | undefined> {
    if (rec.kind !== "inference" || this.localEndpoints === false) return undefined;
    const live = rec.state === "running" || rec.state === "starting";
    if (live && !rec.localEndpointId) {
      const ep = rec.endpoints.find((e) => e.name === "openai") ?? rec.endpoints[0];
      if (!ep) return undefined;
      try {
        const added = await addCustomEndpoint(
          { label: `fleet:${rec.node}/${rec.name}`, baseUrl: ep.url },
          this.localEndpoints,
        );
        messages?.push(`Registered ${added.baseUrl} as local model endpoint "${added.label}".`);
        return this.patchService(rec.id, { localEndpointId: added.id });
      } catch (e) {
        messages?.push(`Could not register the model endpoint: ${errText(e)}`);
      }
    } else if (!live && rec.localEndpointId) {
      await removeCustomEndpoint(rec.localEndpointId, this.localEndpoints).catch(() => {});
      return this.patchService(rec.id, { localEndpointId: undefined });
    }
    return undefined;
  }

  async serviceDown(ref: string, cwd?: string): Promise<FleetServiceRecord> {
    const rec = await this.findService(ref, cwd);
    if (!rec) throw new Error(`no running fleet service "${ref}"`);
    let note: string | undefined;
    try {
      await (await this.clientFor(rec.node)).stopService(rec.id);
    } catch (e) {
      if (!(e instanceof FleetClientError && e.code === "not_found")) {
        note = `node didn't confirm the stop: ${errText(e)}`;
      }
    }
    const updated =
      (await this.patchService(rec.id, {
        state: "stopped",
        ...(note ? { summary: note } : {}),
      })) ?? rec;
    await this.syncLocalEndpoint(updated);
    const { clearSelectedFleetBrowser } = await import("./browser.js");
    clearSelectedFleetBrowser(rec.id);
    return { ...updated, localEndpointId: undefined };
  }

  async serviceLog(ref: string, tail = 200, cwd?: string): Promise<string> {
    const rec = await this.findService(ref, cwd);
    if (!rec) return `No running fleet service "${ref}".`;
    return (await this.clientFor(rec.node)).serviceLog(rec.id, tail);
  }

  async serviceExec(
    ref: string,
    command: string,
    opts: { cwd?: string; timeoutSeconds?: number } = {},
  ): Promise<ExecResponse> {
    const rec = await this.findService(ref, opts.cwd);
    if (!rec) throw new Error(`no running fleet service "${ref}"`);
    if (rec.kind !== "devenv" && rec.kind !== "custom") {
      throw new Error(`exec works on devenv/custom services; ${rec.name} is ${rec.kind}`);
    }
    return (await this.clientFor(rec.node)).exec(rec.id, {
      command,
      timeoutSeconds: opts.timeoutSeconds ?? 300,
    });
  }

  // ── scheduling loop ──────────────────────────────────────

  start(opts: { keepAlive?: boolean } = {}): void {
    if (opts.keepAlive) this.keepAlive = true;
    if (this.timer) return;
    const loop = () => {
      this.timer = setTimeout(async () => {
        await this.tick().catch(() => {});
        if (this.timer) loop();
      }, this.pollMs);
      if (!this.keepAlive) this.timer.unref();
    };
    void this.tick().catch(() => {});
    loop();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  get running(): boolean {
    return !!this.timer;
  }

  async leaderAlive(): Promise<boolean> {
    return this.leader.alive();
  }

  /** One pass: observe; if we lead, poll and dispatch. Returns whether jobs remain active. */
  async tick(): Promise<boolean> {
    if (this.ticking) {
      await this.ticking;
    } else {
      this.ticking = this.tickInner().finally(() => {
        this.ticking = undefined;
      });
      await this.ticking;
    }
    return (await this.jobs.read()).some((j) => ACTIVE_JOB.has(j.state));
  }

  private async tickInner(): Promise<void> {
    let jobs = await this.jobs.read();
    let services = await this.services.read();
    this.observe(jobs, services);
    const active = jobs.filter((j) => ACTIVE_JOB.has(j.state));
    const liveServices = services.filter((s) => s.state === "running" || s.state === "starting");
    if (!active.length && !liveServices.length) {
      if (!this.keepAlive) this.stop();
      return;
    }
    if (!(await this.leader.lead())) return;

    for (const j of active.filter((x) => x.state !== "queued")) await this.pollJob(j);
    for (const s of liveServices) await this.pollService(s);

    jobs = await this.jobs.read();
    const queued = jobs.filter((j) => j.state === "queued");
    if (queued.length) await this.dispatchQueued(jobs, queued);
    jobs = await this.jobs.read();
    services = await this.services.read();
    this.observe(jobs, services);
  }

  private async dispatchQueued(jobs: FleetJob[], queued: FleetJob[]): Promise<void> {
    const inFlight: InFlightWork[] = jobs
      .filter((j) => (j.state === "preparing" || j.state === "running") && j.node)
      .map((j) => ({ node: j.node!, ...(j.resources ? { resources: j.resources } : {}) }));
    let count = inFlight.length;
    const views = await this.nodeViews();
    for (const j of queued) {
      if (count >= this.maxConcurrent) break;
      const last = [...jobs]
        .reverse()
        .find((x) => x.id !== j.id && x.dispatchedAt && x.node && x.projectKey === j.projectKey);
      const req: PlacementRequest = {
        ...(j.resources ? { resources: j.resources } : {}),
        ...(j.secrets?.length ? { secrets: j.secrets } : {}),
        docker: !!j.docker,
        ...(j.pinned && j.node ? { node: j.node } : {}),
        ...(j.avoid ? { avoid: j.avoid } : {}),
        ...(last?.node ? { affinity: last.node } : {}),
        takesSlot: true,
      };
      const p = chooseNode(req, views, inFlight);
      if ("error" in p) {
        await this.patchJob(j.id, {
          state: "error",
          summary: p.error.slice(0, 400),
          finishedAt: nowIso(),
        });
        continue;
      }
      if ("wait" in p) {
        if (!j.waitWarned) {
          await this.patchJob(
            j.id,
            { waitWarned: true, summary: `waiting: ${p.wait}`.slice(0, 400) },
            "queued",
          );
        }
        continue;
      }
      const nodeName = p.node.name;
      if (j.kind === "deploy" && !j.ungated) {
        try {
          await this.checkGate(j.project, j.sha);
        } catch (e) {
          await this.patchJob(j.id, {
            state: "error",
            summary: errText(e).slice(0, 400),
            finishedAt: nowIso(),
          });
          continue;
        }
      }
      const node = await this.registry.get(nodeName);
      if (!node) continue;
      const remoteId = (j.attempts ?? 1) > 1 ? `${j.id}-${j.attempts}` : j.id;
      let patch: string | undefined;
      if (j.hasPatch) {
        try {
          patch = fs.readFileSync(this.patchFile(j.id), "utf8");
        } catch {
          await this.patchJob(j.id, {
            state: "error",
            summary: "the stored patch of local changes is missing",
            finishedAt: nowIso(),
          });
          continue;
        }
      }
      const request: JobRequest = {
        id: remoteId,
        kind: j.kind,
        project: j.projectKey,
        source: {
          git: j.git,
          sha: j.sha,
          ...(patch ? { patch } : {}),
          ...(j.subdir ? { subdir: j.subdir } : {}),
        },
        command: j.command,
        ...(j.docker ? { docker: j.docker } : {}),
        ...(j.env ? { env: j.env } : {}),
        ...(j.secrets ? { secrets: j.secrets } : {}),
        timeoutMinutes: j.timeoutMinutes,
        ...(j.resources ? { resources: j.resources } : {}),
        ...(j.artifactGlobs ? { artifacts: j.artifactGlobs } : {}),
        ...(j.cacheKey ? { cacheKey: j.cacheKey } : {}),
      };
      const claimed = await this.patchJob(j.id, { node: nodeName, remoteId }, "queued");
      if (!claimed) continue;
      try {
        const status = await this.client(node).submitJob(request);
        const at = nowIso();
        const state = mapState(status.state);
        await this.patchJob(
          j.id,
          {
            state: state === "lost" ? "preparing" : state,
            dispatchedAt: at,
            ...(state === "running" ? { startedAt: status.startedAt ?? at } : {}),
            summary: `on ${nodeName}`,
            waitWarned: false,
          },
          "queued",
        );
        inFlight.push({ node: nodeName, ...(j.resources ? { resources: j.resources } : {}) });
        count++;
      } catch (e) {
        if (
          e instanceof FleetClientError &&
          (e.code === "busy" || e.code === "unreachable" || e.code === "timeout")
        ) {
          // Node full or gone since we looked: stay queued, avoid it this pass.
          const v = views.find((x) => x.name === nodeName);
          if (v) v.online = false;
          await this.patchJob(
            j.id,
            { ...(j.pinned ? {} : { node: undefined }), remoteId: undefined },
            "queued",
          );
          continue;
        }
        await this.patchJob(j.id, {
          state: "error",
          summary: `dispatch to ${nodeName} failed: ${errText(e)}`.slice(0, 400),
          finishedAt: nowIso(),
        });
      }
    }
  }

  private async pollJob(j: FleetJob): Promise<void> {
    if (!j.node || !j.remoteId) {
      await this.patchJob(j.id, { state: "queued" });
      return;
    }
    const node = await this.registry.get(j.node);
    if (!node) {
      await this.nodeLost(j, `node ${j.node} was removed from the fleet`);
      return;
    }
    let status: JobStatus;
    try {
      status = await this.client(node).job(j.remoteId);
    } catch (e) {
      if (e instanceof FleetClientError && e.code === "not_found") {
        await this.nodeLost(j, `node ${j.node} no longer knows the job`);
        return;
      }
      if (e instanceof FleetClientError && (e.code === "unreachable" || e.code === "timeout")) {
        const since = j.unreachableSince ? Date.parse(j.unreachableSince) : Date.now();
        if (!j.unreachableSince) {
          await this.patchJob(j.id, { unreachableSince: nowIso() });
        } else if (Date.now() - since > this.unreachableMs) {
          await this.nodeLost(
            j,
            `node ${j.node} unreachable for ${Math.round((Date.now() - since) / 60_000)} min`,
          );
        } else if (!j.nodeDownWarned && Date.now() - since > 60_000) {
          await this.patchJob(j.id, { nodeDownWarned: true });
        }
      }
      return;
    }
    const state = mapState(status.state);
    if (state === "lost") {
      await this.nodeLost(j, `node ${j.node} restarted and lost the job`);
      return;
    }
    const patch: Partial<FleetJob> = {};
    if (j.unreachableSince) patch.unreachableSince = undefined;
    if (j.nodeDownWarned) patch.nodeDownWarned = undefined;
    if (state !== j.state) {
      patch.state = state;
      if (state === "running") patch.startedAt = status.startedAt ?? nowIso();
      if (isFleetTerminal(state)) {
        patch.finishedAt = status.finishedAt ?? nowIso();
        if (status.exitCode !== undefined) patch.exitCode = status.exitCode;
        if (status.artifacts) patch.artifacts = status.artifacts;
        patch.summary = status.summary ?? (state === "passed" ? "passed" : state);
        if (state === "failed") patch.summary = await this.failureSummary(node, j, status);
      }
    }
    if (!Object.keys(patch).length) return;
    const updated = await this.patchJob(j.id, patch);
    if (updated && isFleetTerminal(updated.state) && updated.state !== "cancelled") {
      await this.autoDownload(updated);
      this.removePatch(updated.id);
    }
  }

  private async autoDownload(j: FleetJob): Promise<void> {
    if (!j.artifacts?.length) return;
    try {
      await this.downloadArtifacts(j.id, j.outDir);
    } catch (e) {
      await this.patchJob(
        j.id,
        {
          summary: `${j.summary ?? j.state}; artifacts not downloaded: ${errText(e)}`.slice(0, 480),
        },
        undefined,
        true,
      );
    }
  }

  private removePatch(id: string): void {
    fs.rmSync(this.patchFile(id), { force: true });
  }

  private async failureSummary(node: FleetNode, j: FleetJob, status: JobStatus): Promise<string> {
    const base = status.summary ?? `exited ${status.exitCode ?? "non-zero"}`;
    try {
      const size = status.logBytes ?? 0;
      const { text } = await this.client(node).jobLog(j.remoteId!, Math.max(0, size - 16_000));
      const lines = text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => /fail|error|expected|assert|✗|×/i.test(l))
        .slice(-4);
      return [base, ...lines].join(" | ").slice(0, 480);
    } catch {
      return base;
    }
  }

  /**
   * The node lost the job (restart, unreachable too long, removed). Safe kinds go
   * back to the queue (max FLEET_MAX_ATTEMPTS), steered away from that node.
   * Deploys are never requeued: they end in error and the user is told.
   */
  private async nodeLost(j: FleetJob, reason: string): Promise<void> {
    const at = nowIso();
    const from = j.node ?? "?";
    await this.jobs.update((jobs) => {
      const x = jobs.find((y) => y.id === j.id);
      if (!x || (x.state !== "preparing" && x.state !== "running")) return;
      const attempts = x.attempts ?? 1;
      x.updatedAt = at;
      if (!REQUEUE_KINDS.has(x.kind)) {
        x.state = "error";
        x.finishedAt = at;
        x.summary =
          `${reason}. ${x.kind} is not retried automatically (it may have partly run); check the target before deploying again.`.slice(
            0,
            480,
          );
        return;
      }
      x.requeues = [...(x.requeues ?? []), { at, from, reason }];
      if (attempts >= FLEET_MAX_ATTEMPTS) {
        x.state = "error";
        x.finishedAt = at;
        x.summary = `node lost ${attempts} times; last: ${reason}`.slice(0, 400);
        return;
      }
      x.state = "queued";
      x.attempts = attempts + 1;
      x.avoid = [...new Set([...(x.avoid ?? []), from])];
      x.summary = `requeued (attempt ${attempts + 1}/${FLEET_MAX_ATTEMPTS}): ${reason}`.slice(
        0,
        400,
      );
      if (!x.pinned) delete x.node;
      for (const k of [
        "remoteId",
        "dispatchedAt",
        "startedAt",
        "unreachableSince",
        "nodeDownWarned",
        "waitWarned",
      ] as const) {
        delete x[k];
      }
    });
    // Best effort: stop the old run if the node is reachable after all.
    if (j.node && j.remoteId) {
      const node = await this.registry.get(j.node);
      if (node)
        void this.client(node)
          .cancelJob(j.remoteId)
          .catch(() => {});
    }
  }

  private async pollService(s: FleetServiceRecord): Promise<void> {
    const node = await this.registry.get(s.node);
    if (!node) {
      const u = await this.patchService(s.id, {
        state: "error",
        summary: `node ${s.node} was removed`,
      });
      if (u) await this.syncLocalEndpoint(u);
      return;
    }
    let st: ServiceStatus;
    try {
      st = await this.client(node).service(s.id);
    } catch (e) {
      if (e instanceof FleetClientError && e.code === "not_found") {
        const u = await this.patchService(s.id, {
          state: "stopped",
          summary: "gone from the node",
        });
        if (u) await this.syncLocalEndpoint(u);
        return;
      }
      const since = s.unreachableSince ? Date.parse(s.unreachableSince) : undefined;
      if (since === undefined) await this.patchService(s.id, { unreachableSince: nowIso() });
      else if (!s.nodeDownWarned && Date.now() - since > 60_000) {
        await this.patchService(s.id, {
          nodeDownWarned: true,
          summary: `node ${s.node} unreachable: ${errText(e)}`.slice(0, 300),
        });
      }
      return;
    }
    const patch: Partial<FleetServiceRecord> = {};
    if (s.unreachableSince) patch.unreachableSince = undefined;
    if (s.nodeDownWarned) patch.nodeDownWarned = undefined;
    if (st.state !== s.state) patch.state = st.state;
    if (st.summary && st.summary !== s.summary) patch.summary = st.summary;
    if (JSON.stringify(st.endpoints ?? []) !== JSON.stringify(s.endpoints))
      patch.endpoints = st.endpoints ?? [];
    if (!Object.keys(patch).length && (s.localEndpointId || s.kind !== "inference")) return;
    const u = Object.keys(patch).length ? await this.patchService(s.id, patch) : s;
    if (u) await this.syncLocalEndpoint(u);
  }

  // ── store helpers ────────────────────────────────────────

  private async patchJob(
    id: string,
    patch: Partial<FleetJob>,
    onlyIf?: FleetJobState,
    evenIfTerminal = false,
  ): Promise<FleetJob | undefined> {
    return this.jobs.update((jobs) => {
      const j = jobs.find((x) => x.id === id);
      if (!j) return undefined;
      if (onlyIf && j.state !== onlyIf) return undefined;
      if (!evenIfTerminal && isFleetTerminal(j.state)) return undefined;
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete (j as unknown as Record<string, unknown>)[k];
        else (j as unknown as Record<string, unknown>)[k] = v;
      }
      j.updatedAt = nowIso();
      return { ...j };
    });
  }

  private async patchService(
    id: string,
    patch: Partial<FleetServiceRecord>,
  ): Promise<FleetServiceRecord | undefined> {
    return this.services.update((list) => {
      const s = list.find((x) => x.id === id);
      if (!s) return undefined;
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete (s as unknown as Record<string, unknown>)[k];
        else (s as unknown as Record<string, unknown>)[k] = v;
      }
      s.updatedAt = nowIso();
      return { ...s };
    });
  }

  // ── events ───────────────────────────────────────────────

  private observe(jobs: FleetJob[], services: FleetServiceRecord[]): void {
    const markJobs: Array<[string, FleetJobState]> = [];
    for (const job of jobs) {
      const prev = this.seenJobs.get(job.id);
      const key = `${job.state}|${job.requeues?.length ?? 0}|${job.nodeDownWarned ? 1 : 0}|${job.waitWarned ? 1 : 0}|${job.artifactsDir ? 1 : 0}`;
      if (prev === key) continue;
      this.seenJobs.set(job.id, key);
      if (!this.seeded && (!isFleetTerminal(job.state) || job.notifiedState === job.state))
        continue;
      const requeued = !!prev && (job.requeues?.length ?? 0) > Number(prev.split("|")[1] ?? 0);
      const previous = prev ? (prev.split("|")[0] as FleetJobState) : undefined;
      this.events.emit("event", { type: "job", job, previous, requeued } satisfies FleetEvent);
      if (isFleetTerminal(job.state) && job.notifiedState !== job.state)
        markJobs.push([job.id, job.state]);
    }
    for (const s of services) {
      const prev = this.seenServices.get(s.id);
      const key = `${s.state}|${s.nodeDownWarned ? 1 : 0}`;
      if (prev === key) continue;
      this.seenServices.set(s.id, key);
      if (!this.seeded) continue;
      this.events.emit("event", {
        type: "service",
        service: s,
        ...(prev ? { previous: prev.split("|")[0] } : {}),
      } satisfies FleetEvent);
    }
    this.seeded = true;
    if (markJobs.length && this.events.listenerCount("event") > 0) {
      void this.jobs
        .update((all) => {
          for (const [id, state] of markJobs) {
            const j = all.find((x) => x.id === id);
            if (j) j.notifiedState = state;
          }
        })
        .catch(() => {});
    }
  }
}

// ── plain-words output ─────────────────────────────────────

export function describeFleetJob(j: FleetJob): string {
  const where = j.node ? ` on ${j.node}` : "";
  const src = `${short(j.sha)}${j.hasPatch ? "+patch" : ""}`;
  const extra = j.summary && j.summary !== `on ${j.node}` ? ` — ${j.summary}` : "";
  const arts = j.artifactsDir ? ` (artifacts: ${j.artifactsDir})` : "";
  return `${j.id} ${j.name} [${j.kind}] @ ${src}${where}: ${j.state}${extra}${arts}`;
}

export function describeFleetService(s: FleetServiceRecord): string {
  const eps = s.endpoints.map((e) => `${e.name} ${e.url}`).join(", ");
  return (
    `${s.id} ${s.name} [${s.kind}] on ${s.node}: ${s.state}` +
    `${eps ? ` — ${eps}` : ""}${s.summary ? ` (${s.summary})` : ""}` +
    `${s.localEndpointId ? ` [model endpoint ${s.localEndpointId}]` : ""}`
  );
}

export function describeNode(n: NodeSummary): string {
  const labels = [...new Set([...(n.info?.labels ?? []), ...n.node.labels])];
  if (!n.online || !n.info) {
    return `${n.node.name} (${n.node.url}): OFFLINE${n.error ? ` — ${n.error}` : ""}`;
  }
  const i = n.info;
  const gpus = i.gpus.length
    ? `; ${i.gpus.map((g) => `${g.name} ${g.memoryGb} GB`).join(", ")}`
    : "";
  return (
    `${n.node.name} (${i.platform}, ${i.arch}, v${i.version}): online; slots ${i.slotsUsed}/${i.slots}, ` +
    `${i.cpus} cpu, ${i.memoryFreeGb}/${i.memoryGb} GB free, load ${i.load.toFixed(2)}${gpus}` +
    `${i.docker ? "" : "; no docker"}${labels.length ? `; labels ${labels.join(",")}` : ""}` +
    `${i.modelAuth ? "; model login ok" : "; no model login"}${n.active ? `; ${n.active} of our jobs` : ""}`
  );
}

/** Notification for a job change, or undefined for routine ones. */
export function fleetJobNotification(
  j: FleetJob,
): { text: string; terminal: boolean; urgent: boolean } | undefined {
  const at = `${j.name} at ${short(j.sha)}${j.hasPatch ? "+patch" : ""}${j.node ? ` on ${j.node}` : ""}`;
  switch (j.state) {
    case "passed":
      return {
        text: `Fleet job passed: ${at}${j.artifactsDir ? `; artifacts in ${j.artifactsDir}` : ""}.`,
        terminal: true,
        urgent: false,
      };
    case "failed":
      return {
        text: `Fleet job FAILED: ${at}${j.summary ? `: ${j.summary}` : ""}. Read the log with fleet logs ${j.id}.`,
        terminal: true,
        urgent: true,
      };
    case "error":
      return {
        text: `Fleet job could not run (not a code failure): ${at}: ${j.summary ?? "unknown error"}. Tell the user if it needs them.`,
        terminal: true,
        urgent: true,
      };
    case "preparing":
    case "running":
      return j.nodeDownWarned
        ? {
            text: `Fleet node ${j.node} stopped answering while running ${j.name} (${j.id}); ${REQUEUE_KINDS.has(j.kind) ? "it moves to another node if the node stays away" : "a deploy is never retried automatically"}.`,
            terminal: false,
            urgent: false,
          }
        : undefined;
    case "queued": {
      const last = j.requeues?.at(-1);
      if (last && j.attempts && j.attempts > 1 && !j.waitWarned) {
        return {
          text: `Fleet job re-queued: ${j.name} (${j.id}): ${last.reason} (attempt ${j.attempts}/${FLEET_MAX_ATTEMPTS}). Nothing to do.`,
          terminal: false,
          urgent: false,
        };
      }
      return j.waitWarned
        ? {
            text: `Fleet job ${j.name} (${j.id}) is queued: ${j.summary}.`,
            terminal: false,
            urgent: false,
          }
        : undefined;
    }
    default:
      return undefined;
  }
}

export function fleetServiceNotification(
  s: FleetServiceRecord,
  previous?: string,
): { text: string; terminal: boolean; urgent: boolean } | undefined {
  if (s.nodeDownWarned) {
    return {
      text: `Fleet node ${s.node} stopped answering; service ${s.name} (${s.id}) may be down.`,
      terminal: false,
      urgent: false,
    };
  }
  if (s.state === "running" && previous === "starting") {
    const eps = s.endpoints.map((e) => `${e.name} ${e.url}`).join(", ");
    return {
      text: `Fleet service ${s.name} is up on ${s.node}${eps ? `: ${eps}` : ""}.`,
      terminal: false,
      urgent: false,
    };
  }
  if (s.state === "error") {
    return {
      text: `Fleet service ${s.name} (${s.id}) on ${s.node} failed: ${s.summary ?? "unknown error"}.`,
      terminal: true,
      urgent: true,
    };
  }
  if (s.state === "stopped" && previous && previous !== "stopped") {
    return {
      text: `Fleet service ${s.name} (${s.id}) on ${s.node} stopped.`,
      terminal: true,
      urgent: false,
    };
  }
  return undefined;
}
