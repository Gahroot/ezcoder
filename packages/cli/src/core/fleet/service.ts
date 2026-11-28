// The fleet orchestrator on the controller. Sessions and the CLI queue jobs and
// return at once; one leader process (a session host or `ezcoder fleet daemon`)
// dispatches them to nodes with bounded concurrency, polls them, downloads
// artifacts, requeues work lost with a node (never deploys) and records results.
// Every process watches the shared store and tells its own sessions.
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  benchProvider,
  cloudAllowedFor,
  providerSettings,
  readCloudSettings,
  recordUtilization,
  type CloudSettings,
} from "../cloud/config.js";
import { git as cloudGit, runGit } from "../cloud/git.js";
import { runnerCommand, runnerPrompt, verifyRunnerResult } from "../cloud/runner.js";
import { commitSnapshot, workingTreeSnapshot } from "../cloud/snapshot.js";
import {
  CloudError,
  type CloudAvailability,
  type CloudProvider,
  type CloudProviderId,
  type CloudTaskHandle,
} from "../cloud/types.js";
import { cacheKeyFor, parseGitHubRepo } from "../validation/config.js";
import { defaultExec } from "../validation/exec.js";
import type { GateResult } from "../validation/service.js";
import type { Exec } from "../validation/types.js";
import {
  addCustomEndpoint,
  removeCustomEndpoint,
  type LocalEndpointStoreOptions,
} from "../local-endpoint-store.js";
import { DEFAULT_LOCAL_SLOTS, readBackendsFile } from "../validation/backends.js";
import {
  compareVersions,
  controllerVersion,
  FleetClient,
  FleetClientError,
  protocolProblem,
  safeArtifactPath,
} from "./client.js";
import { validationInFlightByNode } from "./node-load.js";
import {
  CLOUD_JOB_DISALLOWED_TOOLS,
  CLOUD_JOB_MAX_TURNS,
  CLOUD_RUNNER_MODEL,
  cloudIneligibility,
  cloudJobCommand,
  cloudNodeName,
  cloudProviderOfNode,
  cloudPinProblem,
  cloudRunId,
  cloudVerifiable,
  describeCloudCapacity,
  isCloudPin,
} from "./cloud-jobs.js";
import {
  chooseNode,
  slotsUsed,
  type InFlightWork,
  type NodeView,
  type PlacementRequest,
} from "./fleet-scheduler.js";
import { FleetGit } from "./git.js";
import {
  builtinServices,
  FLEET_CONFIG_FILE,
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
  canRequeue,
  type FleetJob,
  type FleetJobState,
  type FleetServiceRecord,
} from "./types.js";

export interface FleetServiceOptions {
  dir?: string;
  /** Validation folder whose node stages share node slots with fleet jobs (default: beside `dir`). */
  validationDir?: string;
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
  /** R10: a service in "error" this long is stopped on its node and retired (default 30). */
  stuckServiceMinutes?: number;
  /** R10: how often leftovers are cleaned (default 10 min; first pass at the first tick). */
  cleanupEveryMinutes?: number;
  /** Where inference endpoints are registered (tests); false disables it. */
  localEndpoints?: LocalEndpointStoreOptions | false;
  /** Cap for automatic artifact downloads per job. */
  maxArtifactBytes?: number;
  autoStart?: boolean;
  /** Cloud sandboxes as extra capacity (tests inject fakes); false turns cloud off. */
  cloud?: FleetCloudHooks | false;
}

/** How the fleet reaches cloud providers (core/cloud/registry by default). */
export interface FleetCloudHooks {
  settings(): CloudSettings;
  availability(
    project: { repoRoot?: string; repo?: string },
    settings: CloudSettings,
  ): Promise<CloudAvailability[]>;
  provider(id: CloudProviderId): CloudProvider | Promise<CloudProvider>;
  bench(id: CloudProviderId, until: string, reason: string): void;
  recordUtilization(id: CloudProviderId, value: number, resetsAt?: string): void;
}

export function defaultFleetCloudHooks(): FleetCloudHooks {
  return {
    settings: () => readCloudSettings(),
    // Loaded lazily: the providers pull in auth and HTTP code only when cloud is used.
    availability: async (project, settings) =>
      (await import("../cloud/registry.js")).cloudAvailability("jobs", project, settings),
    provider: async (id) => (await import("../cloud/registry.js")).cloudProvider(id),
    bench: benchProvider,
    recordUtilization,
  };
}

/** Per-dispatch-pass cloud view (availability is fetched once per project). */
interface CloudPass {
  settings: CloudSettings;
  availability: Map<string, Promise<CloudAvailability[]>>;
  /** Our unfinished jobs per provider. */
  active: Map<CloudProviderId, number>;
}

type CloudAttempt = { started: true } | { wait: string } | { no: string; quiet?: boolean };

export interface RunOptions {
  node?: string;
  /** Send uncommitted local changes as a patch. */
  includeUncommitted?: boolean;
  ref?: string;
  /** Artifacts folder override. */
  outDir?: string;
  /** A1: run this spec instead of looking `name` up in the project config (ad hoc command). */
  spec?: FleetJobSpec;
  /** A1: this job is shard `index` (1-based) of `total`; exported as EZ_SHARD / EZ_SHARD_TOTAL. */
  shard?: { index: number; total: number };
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
  /** S3: no common protocol; names the side to update. The node gets no work. */
  incompatible?: string;
  /** S7: the node runs an older EZ Coder than this machine. */
  updateNotice?: string;
  /** Our unfinished jobs there. */
  active: number;
}

/** S7: a notice when the node's CLI is older than this machine's. */
export function nodeUpdateNotice(
  name: string,
  nodeVersion: string | undefined,
): string | undefined {
  const mine = controllerVersion();
  if (!nodeVersion || compareVersions(nodeVersion, mine) >= 0) return undefined;
  return `${name} runs EZ Coder ${nodeVersion}, older than this machine's ${mine}; update it with \`ezcoder fleet update ${name}\``;
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
  readonly validationDir: string;
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
  private readonly cloudHooks: FleetCloudHooks | undefined;
  private readonly events = new EventEmitter();
  private readonly lastInfo = new Map<string, NodeInfo>();
  private readonly stuckServiceMs: number;
  private readonly cleanupEveryMs: number;
  private lastCleanup = 0;
  /** Nodes that answered 429 with Retry-After: no dispatch there until (ms epoch). */
  private readonly busyUntil = new Map<string, number>();
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
    this.validationDir = opts.validationDir ?? path.join(path.dirname(this.dir), "validation");
    this.exec = opts.exec ?? defaultExec;
    this.git = new FleetGit(this.exec);
    this.fetchImpl = opts.fetch;
    this.pollMs = opts.pollMs ?? 15_000;
    this.clientTimeoutMs = opts.clientTimeoutMs ?? 15_000;
    this.unreachableMs = (opts.unreachableRequeueMinutes ?? 3) * 60_000;
    this.stuckServiceMs = (opts.stuckServiceMinutes ?? 30) * 60_000;
    this.cleanupEveryMs = (opts.cleanupEveryMinutes ?? 10) * 60_000;
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
    this.cloudHooks = opts.cloud === false ? undefined : (opts.cloud ?? defaultFleetCloudHooks());
    this.events.setMaxListeners(100);
  }

  /** One service per process. */
  static shared(): FleetService {
    shared ??= new FleetService();
    return shared;
  }

  /**
   * Cap on fleet jobs in flight. Unset (the default): no cap beyond the real
   * capacity, i.e. every free slot on every node is used.
   */
  get maxConcurrent(): number {
    return Math.max(
      1,
      this.maxConcurrentOverride ?? readFleetSettings(this.dir).maxConcurrent ?? Infinity,
    );
  }

  /** Slots of this machine for local validation stages (backends.json localMaxConcurrent). */
  localCapacity(): number {
    return readBackendsFile(this.validationDir).localMaxConcurrent ?? DEFAULT_LOCAL_SLOTS;
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
          // S3 on every poll: a node we can't talk to safely gets no work.
          const problem = protocolProblem(n.name, info);
          const until = this.busyUntil.get(n.name);
          const wait = until !== undefined ? Math.ceil((until - Date.now()) / 1000) : 0;
          if (until !== undefined && wait <= 0) this.busyUntil.delete(n.name);
          return {
            name: n.name,
            online: true,
            info,
            labels: n.labels,
            ...(problem ? { incompatible: problem.message } : {}),
            ...(wait > 0 ? { unavailable: `full; the node asked to retry in ${wait} s` } : {}),
          };
        } catch (e) {
          if (e instanceof FleetClientError && e.code === "incompatible") {
            const last = this.lastInfo.get(n.name);
            return {
              name: n.name,
              online: true,
              ...(last ? { info: last } : {}),
              labels: n.labels,
              incompatible: e.message,
              error: e.message,
            };
          }
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
        ...(v.incompatible ? { incompatible: v.incompatible } : {}),
        ...(v.online && nodeUpdateNotice(node.name, v.info?.version)
          ? { updateNotice: nodeUpdateNotice(node.name, v.info?.version)! }
          : {}),
        active: jobs.filter((j) => j.node === node.name && ACTIVE_JOB.has(j.state)).length,
      };
    });
  }

  /** One line per cloud provider ("cloud: claude-cloud ready, 4 cpu/16 GB, overflow"). */
  async cloudLines(cwd?: string): Promise<string[]> {
    if (!this.cloudHooks) return [];
    const settings = this.cloudHooks.settings();
    const [avail, jobs] = await Promise.all([
      this.cloudHooks.availability(cwd ? { repoRoot: path.resolve(cwd) } : {}, settings),
      this.jobs.read(),
    ]);
    return avail.map((a) =>
      describeCloudCapacity(
        a,
        settings,
        jobs.filter((j) => j.node === cloudNodeName(a.id) && ACTIVE_JOB.has(j.state)).length,
      ),
    );
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

  /**
   * The code of a job that only cloud will run: the local commit (no push
   * needed, the sandbox gets a bundle) plus, with includeUncommitted, a
   * snapshot commit of the working tree.
   */
  private async localSource(
    cwd: string,
    opts: { includeUncommitted?: boolean; ref?: string },
  ): Promise<{ src: SourceSpec; repo?: string; snapshot?: string; messages: string[] }> {
    let sha: string;
    try {
      sha = (
        await cloudGit(cwd, ["rev-parse", "--verify", `${opts.ref ?? "HEAD"}^{commit}`])
      ).trim();
    } catch {
      throw new Error(
        `"${opts.ref ?? "HEAD"}" is not a commit in ${cwd} (is this a Git repo with commits?)`,
      );
    }
    const origin = await runGit(cwd, ["remote", "get-url", "origin"]);
    const url = origin.code === 0 ? origin.stdout.toString().trim() : "";
    const repo = url ? parseGitHubRepo(url) : undefined;
    const messages: string[] = [];
    let snapshot: string | undefined;
    if (opts.includeUncommitted) {
      const snap = await workingTreeSnapshot(cwd);
      snapshot = snap.commit;
      if (snap.withheld.length) {
        messages.push(
          `Not sent to the cloud (look like credentials): ${snap.withheld.join(", ")}.`,
        );
      }
    }
    return {
      src: { git: url, sha },
      ...(repo ? { repo } : {}),
      ...(snapshot ? { snapshot } : {}),
      messages,
    };
  }

  /** Cloud may pick up jobs without being named (settings allow it, not manual). */
  private cloudAuto(): boolean {
    if (!this.cloudHooks) return false;
    const settings = this.cloudHooks.settings();
    return cloudAllowedFor(settings, "jobs") && (settings.when ?? "overflow") !== "manual";
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
    const config = opts.spec ? { jobs: { [name]: opts.spec } } : loadFleetConfig(cwd);
    if ("error" in config) throw new Error(config.error);
    const spec: FleetJobSpec | undefined = config.jobs[name];
    if (!spec) {
      const names = Object.keys(config.jobs);
      throw new Error(
        `no fleet job "${name}"; this project has: ${names.join(", ") || "none"} (define jobs in .ezcoder/fleet.json)`,
      );
    }
    const cloudPin = isCloudPin(opts.node) ? opts.node : undefined;
    if (opts.node && !cloudPin && !(await this.registry.get(opts.node))) {
      throw new Error(`no paired node "${opts.node}"`);
    }
    const cloudWhy = cloudIneligibility(
      { ...spec, ...(spec.artifacts ? { artifactGlobs: spec.artifacts } : {}) },
      { pinned: !!cloudPin },
    );
    if (cloudPin) {
      if (!this.cloudHooks) throw new Error("cloud is off in this process");
      const pinWhy = cloudPinProblem(cloudPin) ?? cloudWhy;
      if (pinWhy) throw new Error(`job ${name} can't run in the cloud: ${pinWhy}`);
    }
    const noNodes = !(await this.registry.list()).length;
    const cloudOnly = !!cloudPin || (noNodes && !cloudWhy && this.cloudAuto());
    if (noNodes && !cloudOnly) {
      throw new Error(
        "no nodes paired; run `ezcoder fleet discover`, then `ezcoder fleet add <pairing>`" +
          (cloudWhy && this.cloudAuto() ? ` (cloud can't take it: ${cloudWhy})` : ""),
      );
    }
    const isDeploy = spec.kind === "deploy";
    if (isDeploy && opts.includeUncommitted) {
      throw new Error(
        "deploy runs exact pushed commits only; commit and push, then deploy without --uncommitted",
      );
    }
    const s: { src: SourceSpec; repo?: string; snapshot?: string; messages: string[] } = cloudOnly
      ? await this.localSource(cwd, opts)
      : await this.source(cwd, opts);
    if (!cloudOnly && s.src.patch && !cloudWhy && this.cloudAuto()) {
      // Captured now so the job can still overflow to cloud with the same code.
      s.snapshot = await workingTreeSnapshot(cwd)
        .then((snap) => snap.commit)
        .catch(() => undefined);
    }
    if (cloudOnly && !cloudPin) {
      s.messages.push(
        "No nodes paired: this runs in the cloud (extra capacity) when a provider has room.",
      );
    }
    if (cloudPin && spec.artifacts?.length) {
      s.messages.push(
        "Cloud can't send files back: this job's artifacts stay in the cloud session.",
      );
    }
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
      ...(spec.env || opts.shard
        ? {
            env: {
              ...spec.env,
              ...(opts.shard
                ? {
                    EZ_SHARD: String(opts.shard.index),
                    EZ_SHARD_TOTAL: String(opts.shard.total),
                  }
                : {}),
            },
          }
        : {}),
      ...(opts.spec ? { adhoc: true } : {}),
      ...(opts.shard ? { shard: opts.shard } : {}),
      ...(spec.secrets ? { secrets: spec.secrets } : {}),
      ...(spec.resources ? { resources: spec.resources } : {}),
      ...(spec.artifacts ? { artifactGlobs: spec.artifacts } : {}),
      cacheKey: spec.cacheKey ?? cacheKeyFor(projectKey),
      timeoutMinutes: spec.timeoutMinutes,
      ...(ungated ? { ungated: true } : {}),
      ...(spec.kind === "custom" && spec.retry ? { retry: true } : {}),
      state: "queued",
      createdAt: at,
      updatedAt: at,
      ...(opts.node ? { node: opts.node, pinned: true } : {}),
      ...(cloudPin ? { cloudPin } : {}),
      ...(cloudOnly ? { cloudOnly: true } : {}),
      ...(s.snapshot ? { snapshot: s.snapshot } : {}),
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
      const wasDispatched = !!j.remoteId && (j.state !== "queued" || !canRequeue(j));
      j.state = "cancelled";
      j.summary = "cancelled by request";
      j.updatedAt = j.finishedAt = nowIso();
      return { ...j, wasDispatched };
    });
    const cloudId = cloudProviderOfNode(job?.node);
    if (job && (job as { wasDispatched?: boolean }).wasDispatched && cloudId && job.cloud) {
      await this.stopCloud(cloudId, job.cloud.handle, true);
    } else if (
      job &&
      (job as { wasDispatched?: boolean }).wasDispatched &&
      job.node &&
      job.remoteId
    ) {
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
    if (cloudProviderOfNode(job.node)) {
      const where = job.cloud ? ` (${job.cloud.handle.url})` : "";
      let text: string | undefined;
      try {
        text = fs.readFileSync(this.cloudLogFile(job.id), "utf8");
      } catch {
        // not finished yet
      }
      if (text === undefined) {
        return `Running on ${job.node}${where}; cloud sends only a verified log tail, when the job finishes.`;
      }
      if (opts.offset !== undefined) return text.slice(opts.offset);
      return `[verified log tail from ${job.node}${where}]\n${text || "(no output)"}`;
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
    if (cloudProviderOfNode(job.node)) {
      throw new Error(
        `job ${id} ran on ${job.node}; cloud can't send files back, so its artifacts stay in the cloud session${job.cloud ? ` (${job.cloud.handle.url})` : ""}`,
      );
    }
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

  /**
   * R10: controller leftovers. Stored patches of jobs that are finished
   * (cancelled, errored, ...) or forgotten, and services stuck in "error":
   * stopped on their node (best effort) and marked stopped. Runs at the first
   * tick (startup) and then every `cleanupEveryMinutes`.
   */
  async cleanup(): Promise<{ patches: string[]; services: string[] }> {
    this.lastCleanup = Date.now();
    const jobs = await this.jobs.read();
    const keep = new Set(jobs.filter((j) => !isFleetTerminal(j.state)).map((j) => j.id));
    const patches: string[] = [];
    const dir = path.join(this.dir, "patches");
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir);
    } catch {
      // no patches folder
    }
    for (const f of files) {
      if (!f.endsWith(".b64")) continue;
      const id = f.slice(0, -4);
      if (keep.has(id)) continue;
      fs.rmSync(path.join(dir, f), { force: true });
      patches.push(id);
    }
    const retired: string[] = [];
    const now = Date.now();
    for (const s of await this.services.read()) {
      if (s.state !== "error" || now - Date.parse(s.updatedAt) < this.stuckServiceMs) continue;
      const node = await this.registry.get(s.node);
      if (node)
        await this.client(node)
          .stopService(s.id)
          .catch(() => {});
      const u = await this.patchService(s.id, {
        state: "stopped",
        summary: `cleaned up: stuck in error (${s.summary ?? "no detail"})`.slice(0, 300),
      });
      if (u) await this.syncLocalEndpoint(u);
      retired.push(s.id);
    }
    return { patches, services: retired };
  }

  private async tickInner(): Promise<void> {
    if (Date.now() - this.lastCleanup >= this.cleanupEveryMs) {
      await this.cleanup().catch(() => {});
    }
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
    // Validation stages on the same nodes take the same slots (not our cap, though).
    for (const [node, n] of await validationInFlightByNode(this.validationDir)) {
      for (let i = 0; i < n; i++) inFlight.push({ node });
    }
    const views = await this.nodeViews();
    const cloud = this.cloudPass(jobs);
    for (const j of queued) {
      if (count >= this.maxConcurrent) break;
      if (!canRequeue(j) && j.node && j.remoteId) {
        const claim = await this.reconcileClaim(j);
        if (claim === "running") count++;
        if (claim !== "absent") continue;
        delete j.remoteId;
        if (!j.pinned) delete j.node;
      }
      if (j.cloudPin) {
        const r = await this.tryCloud(j, cloud, { pinned: true });
        if ("started" in r) count++;
        else if ("wait" in r) await this.waitJob(j, r.wait);
        else {
          await this.patchJob(j.id, {
            state: "error",
            summary: `can't run in the cloud: ${r.no}`.slice(0, 400),
            finishedAt: nowIso(),
          });
        }
        continue;
      }
      if (j.cloudOnly) {
        // Its source is local only (no origin URL / unpushed commit): nodes can't fetch it.
        const r = await this.tryCloud(j, cloud, { pinned: false });
        if ("started" in r) count++;
        else if ("wait" in r) await this.waitJob(j, `cloud: ${r.wait}`);
        else {
          await this.patchJob(j.id, {
            state: "error",
            summary:
              `queued for cloud only (no nodes were paired), and cloud can't run it: ${r.no || "cloud is off"}. Push and run it again to use your machines.`.slice(
                0,
                400,
              ),
            finishedAt: nowIso(),
          });
        }
        continue;
      }
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
      let p = chooseNode(req, views, inFlight);
      const pinnedNode = !!(j.pinned && j.node);
      if (!pinnedNode && !("node" in p)) {
        // No self-hosted machine has room (or none fits): cloud is the overflow.
        const r = await this.tryCloud(j, cloud, { pinned: false });
        if ("started" in r) {
          count++;
          continue;
        }
        if ("wait" in r) {
          await this.waitJob(j, `${"wait" in p ? p.wait : p.error}; cloud: ${r.wait}`);
          continue;
        }
        if (!r.quiet) {
          p =
            "wait" in p
              ? { wait: `${p.wait}; cloud: ${r.no}` }
              : { error: `${p.error}; cloud: ${r.no}` };
        }
      } else if (!pinnedNode && "node" in p && cloud.settings.when === "always") {
        // Cloud is one more machine: take the job when it is less loaded.
        const ratio = slotsUsed(p.node, inFlight) / Math.max(1, p.node.info?.slots ?? 1);
        const r = await this.tryCloud(j, cloud, { pinned: false, nodeRatio: ratio });
        if ("started" in r) {
          count++;
          continue;
        }
      }
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
          (e.code === "busy" ||
            e.code === "incompatible" ||
            e.code === "unreachable" ||
            e.code === "timeout")
        ) {
          // Node full, incompatible or gone since we looked: stay queued, avoid it this pass.
          const v = views.find((x) => x.name === nodeName);
          if (v) v.online = false;
          if (e.code === "busy") {
            // Never an error: wait for a slot, as long as the node asked (Retry-After).
            if (e.retryAfterMs) this.busyUntil.set(nodeName, Date.now() + e.retryAfterMs);
            await this.patchJob(
              j.id,
              {
                ...(j.pinned ? {} : { node: undefined }),
                remoteId: undefined,
                waitWarned: true,
                summary:
                  `waiting: ${nodeName} is full` +
                  (e.retryAfterMs ? `; retrying in ${Math.ceil(e.retryAfterMs / 1000)} s` : ""),
              },
              "queued",
            );
            continue;
          }
          if (e.code === "incompatible") {
            // A 426 answer: the node refused before taking the job.
            await this.patchJob(
              j.id,
              {
                ...(j.pinned ? {} : { node: undefined }),
                remoteId: undefined,
                waitWarned: true,
                summary: `waiting: ${e.message}`.slice(0, 400),
              },
              "queued",
            );
            continue;
          }
          if (!canRequeue(j)) {
            // It may have started there: keep the claim and ask that node before placing it again.
            await this.patchJob(
              j.id,
              {
                waitWarned: true,
                summary: `waiting: ${nodeName} didn't answer the dispatch; confirming whether it started before trying again`,
              },
              "queued",
            );
            continue;
          }
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

  /** A dispatch whose answer never arrived: ask the claimed node whether it took the job. */
  private async reconcileClaim(j: FleetJob): Promise<"running" | "absent" | "unknown"> {
    const node = await this.registry.get(j.node!);
    if (!node) {
      await this.patchJob(j.id, {
        state: "error",
        summary: `${j.node} was removed before it confirmed the dispatch. ${j.kind} is not retried automatically (it may have run); check the target before deploying again.`,
        finishedAt: nowIso(),
      });
      return "unknown";
    }
    try {
      const status = await this.client(node).job(j.remoteId!);
      const at = nowIso();
      const state =
        status.state === "preparing" || status.state === "lost" ? "preparing" : "running";
      await this.patchJob(
        j.id,
        {
          state,
          dispatchedAt: at,
          ...(state === "running" ? { startedAt: status.startedAt ?? at } : {}),
          summary: `on ${node.name}`,
          waitWarned: false,
        },
        "queued",
      );
      return "running";
    } catch (e) {
      if (!(e instanceof FleetClientError && e.code === "not_found")) return "unknown";
      await this.patchJob(
        j.id,
        { ...(j.pinned ? {} : { node: undefined }), remoteId: undefined },
        "queued",
      );
      return "absent";
    }
  }

  private async pollJob(j: FleetJob): Promise<void> {
    if (!j.node || !j.remoteId) {
      await this.patchJob(j.id, { state: "queued" });
      return;
    }
    if (cloudProviderOfNode(j.node)) {
      await this.pollCloudJob(j);
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
        if (state === "failed") {
          patch.summary = await this.failureSummary(node, j, status);
          const tail = await this.failureTail(node, j);
          if (tail.length) patch.failTail = tail;
        }
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

  /** A3: the last FAIL_TAIL_LINES lines of the log, cut on the node (older nodes: last 16 KB). */
  private async failureTail(node: FleetNode, j: FleetJob): Promise<string[]> {
    const c = this.client(node);
    const text = await c
      .logs(j.remoteId!, { tail: FAIL_TAIL_LINES })
      .then((r) => r.text)
      .catch(() =>
        c
          .jobLog(j.remoteId!, 0)
          .then((r) => r.text.slice(-16_000))
          .catch(() => ""),
      );
    return failTailLines(text);
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
      if (!canRequeue(x)) {
        x.state = "error";
        x.finishedAt = at;
        x.summary = (
          x.kind === "deploy"
            ? `${reason}. deploy is not retried automatically (it may have partly run); check the target before deploying again.`
            : `${reason}. This ${x.kind} job is not retried automatically (it may have partly run); run it again yourself, or mark it "retry": true in ${FLEET_CONFIG_FILE} if it is safe to repeat.`
        ).slice(0, 480);
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

  // ── cloud ────────────────────────────────────────────────

  private cloudLogFile(id: string): string {
    return path.join(this.dir, "cloud-logs", `${id}.log`);
  }

  private cloudPass(jobs: FleetJob[]): CloudPass {
    const active = new Map<CloudProviderId, number>();
    for (const j of jobs) {
      const id = cloudProviderOfNode(j.node);
      if (id && ACTIVE_JOB.has(j.state) && j.state !== "queued") {
        active.set(id, (active.get(id) ?? 0) + 1);
      }
    }
    return { settings: this.cloudHooks?.settings() ?? {}, availability: new Map(), active };
  }

  private async waitJob(j: FleetJob, why: string): Promise<void> {
    if (j.waitWarned) return;
    await this.patchJob(
      j.id,
      { waitWarned: true, summary: `waiting: ${why}`.slice(0, 400) },
      "queued",
    );
  }

  private async provider(id: CloudProviderId): Promise<CloudProvider> {
    if (!this.cloudHooks) throw new Error("cloud is off");
    return this.cloudHooks.provider(id);
  }

  /** Interrupt (when asked) and archive a cloud task; best effort. */
  private async stopCloud(
    id: CloudProviderId,
    handle: CloudTaskHandle,
    interrupt: boolean,
  ): Promise<void> {
    try {
      const p = await this.provider(id);
      if (interrupt) await p.interrupt(handle).catch(() => {});
      await p.archive(handle).catch(() => {});
    } catch {
      // provider gone: nothing to stop
    }
  }

  /**
   * Run a queued job on the first cloud provider with room. `wait` = it could
   * run in the cloud later (usage limit, provider full); `no` = it can't.
   */
  private async tryCloud(
    j: FleetJob,
    pass: CloudPass,
    opts: { pinned: boolean; nodeRatio?: number },
  ): Promise<CloudAttempt> {
    const hooks = this.cloudHooks;
    if (!hooks) return { no: "cloud is off", quiet: true };
    const settings = pass.settings;
    if (!opts.pinned) {
      if (!cloudAllowedFor(settings, "jobs")) return { no: "cloud is off for jobs", quiet: true };
      const when = settings.when ?? "overflow";
      if (when === "manual") return { no: "cloud runs only jobs pinned to it", quiet: true };
      if (opts.nodeRatio !== undefined && when !== "always") return { no: "", quiet: true };
    }
    const why = cloudIneligibility(j, { pinned: opts.pinned });
    if (why) return { no: why };
    const key = j.project;
    let avail = pass.availability.get(key);
    if (!avail) {
      const repo = /^[\w.-]+\/[\w.-]+$/.test(j.projectKey) ? j.projectKey : undefined;
      avail = hooks
        .availability({ repoRoot: j.project, ...(repo ? { repo } : {}) }, settings)
        .catch((e: unknown) => [
          {
            id: "claude-cloud" as const,
            available: false,
            detail: errText(e),
          },
        ]);
      pass.availability.set(key, avail);
    }
    const want = j.cloudPin && j.cloudPin !== "cloud" ? j.cloudPin : undefined;
    const avoid = new Set(j.avoid ?? []);
    const reasons: string[] = [];
    let wait: string | undefined;
    for (const a of await avail) {
      if (want && a.id !== want) continue;
      if (!cloudVerifiable(a.id)) {
        if (want) reasons.push(cloudPinProblem(a.id) ?? `${a.id} can't report verified results`);
        continue;
      }
      if (avoid.has(cloudNodeName(a.id))) {
        reasons.push(`${a.id} already failed this job`);
        continue;
      }
      if (!a.available) {
        reasons.push(`${a.id}: ${a.detail}${a.setupHint ? ` (${a.setupHint})` : ""}`);
        if (a.limitedUntil) wait ??= `${a.id}: ${a.detail}`;
        continue;
      }
      const max = providerSettings(settings, a.id).maxConcurrent;
      const active = pass.active.get(a.id) ?? 0;
      if (active >= max) {
        wait ??= `${a.id} runs ${active}/${max} jobs`;
        continue;
      }
      if (opts.nodeRatio !== undefined && active / max >= opts.nodeRatio) continue;
      const r = await this.startCloud(j, a.id, settings);
      if (r === true) {
        pass.active.set(a.id, active + 1);
        return { started: true };
      }
      if (r.limited) wait ??= `${a.id}: ${r.error}`;
      reasons.push(`${a.id}: ${r.error}`);
    }
    if (wait) return { wait };
    return { no: reasons.join("; ") || "no cloud provider" };
  }

  private async startCloud(
    j: FleetJob,
    id: CloudProviderId,
    settings: CloudSettings,
  ): Promise<true | { error: string; limited?: boolean }> {
    const node = cloudNodeName(id);
    const remoteId = (j.attempts ?? 1) > 1 ? `${j.id}-${j.attempts}` : j.id;
    const runId = cloudRunId(remoteId);
    const claimed = await this.patchJob(j.id, { node, remoteId }, "queued");
    if (!claimed) return { error: "the job changed meanwhile" };
    let handle: CloudTaskHandle | undefined;
    try {
      const provider = await this.provider(id);
      const base = j.snapshot ?? j.sha;
      const snap = await commitSnapshot(j.project, base);
      const command = runnerCommand({
        jobId: runId,
        tree: snap.tree,
        command: cloudJobCommand({ ...j, id: runId }),
        timeoutMinutes: j.timeoutMinutes,
        ...(j.docker ? { docker: true } : {}),
      });
      const model =
        providerSettings(settings, id).runnerModel ??
        (id === "claude-cloud" ? CLOUD_RUNNER_MODEL : undefined);
      const repo = /^[\w.-]+\/[\w.-]+$/.test(j.projectKey) ? j.projectKey : undefined;
      handle = await provider.start({
        title: `EZ Coder job ${j.name} (${j.projectKey})`,
        prompt: runnerPrompt(command, j.timeoutMinutes),
        source: { repoRoot: j.project, ...(repo ? { repo } : {}), sha: base },
        ...(model ? { model } : {}),
        maxTurns: CLOUD_JOB_MAX_TURNS,
        disallowedTools: [...CLOUD_JOB_DISALLOWED_TOOLS],
        commandTimeoutMinutes: j.timeoutMinutes,
        approveCommand: command,
        runner: true,
      });
      const at = nowIso();
      const started = await this.patchJob(
        j.id,
        {
          state: "preparing",
          dispatchedAt: at,
          cloud: { handle, tree: snap.tree, runId },
          summary: `on ${node}: ${handle.url}`,
          waitWarned: false,
        },
        "queued",
      );
      if (!started) await this.stopCloud(id, handle, true); // cancelled meanwhile
      return true;
    } catch (e) {
      const limited = e instanceof CloudError && e.code === "usage_limited";
      if (limited) {
        this.cloudHooks?.bench(
          id,
          e.until ?? new Date(Date.now() + 3_600_000).toISOString(),
          "usage limit reached",
        );
      }
      await this.patchJob(
        j.id,
        {
          node: j.cloudPin ?? (j.pinned ? j.node : undefined),
          remoteId: undefined,
          ...(limited ? {} : { avoid: [...new Set([...(j.avoid ?? []), node])] }),
        },
        "queued",
      );
      if (!limited) j.avoid = [...new Set([...(j.avoid ?? []), node])];
      return { error: `couldn't start: ${errText(e)}`.slice(0, 300), limited };
    }
  }

  private async pollCloudJob(j: FleetJob): Promise<void> {
    const id = cloudProviderOfNode(j.node)!;
    const c = j.cloud;
    if (!c) {
      await this.cloudRetry(j, `no cloud session recorded for ${j.node}`);
      return;
    }
    let status;
    try {
      status = await (await this.provider(id)).status(c.handle);
    } catch (e) {
      if (e instanceof CloudError && e.code === "not_found") {
        await this.cloudRetry(j, `${j.node} no longer knows the session`);
        return;
      }
      const since = j.unreachableSince ? Date.parse(j.unreachableSince) : undefined;
      if (since === undefined) await this.patchJob(j.id, { unreachableSince: nowIso() });
      else if (Date.now() - since > Math.max(this.unreachableMs, 1)) {
        await this.stopCloud(id, c.handle, true);
        await this.cloudRetry(j, `${j.node} unreachable: ${errText(e)}`);
      }
      return;
    }
    if (status.usage?.utilization !== undefined) {
      this.cloudHooks?.recordUtilization(id, status.usage.utilization, status.usage.resetsAt);
    }
    if (status.state === "starting" || status.state === "running") {
      const patch: Partial<FleetJob> = {};
      if (j.unreachableSince) patch.unreachableSince = undefined;
      if (status.state === "running" && j.state !== "running") {
        patch.state = "running";
        patch.startedAt = nowIso();
      }
      const since = Date.parse(j.dispatchedAt ?? j.updatedAt);
      if (Date.now() - since > (j.timeoutMinutes + 30) * 60_000) {
        await this.stopCloud(id, c.handle, true);
        await this.cloudRetry(j, `${j.node} ran past the job's ${j.timeoutMinutes} min timeout`);
        return;
      }
      if (Object.keys(patch).length) await this.patchJob(j.id, patch);
      return;
    }
    // Finished its turn, failed or was stopped: only a verified result counts.
    await this.stopCloud(id, c.handle, false);
    if (status.usage?.limited && status.usage.resetsAt) {
      this.cloudHooks?.bench(id, status.usage.resetsAt, "usage limit reached");
    }
    const command = runnerCommand({
      jobId: c.runId,
      tree: c.tree,
      command: cloudJobCommand({ ...j, id: c.runId }),
      timeoutMinutes: j.timeoutMinutes,
      ...(j.docker ? { docker: true } : {}),
    });
    const result = verifyRunnerResult(status.commands, command, c.runId);
    if (!result || result.verdict === "wrong-tree") {
      const reason = !result
        ? status.state === "failed"
          ? `cloud session failed${status.error ? `: ${status.error}` : ""}`
          : "the cloud result could not be verified (the sandbox didn't run the exact command)"
        : `the cloud sandbox had different code (tree ${short(result.tree ?? "?")}, expected ${short(c.tree)})`;
      await this.cloudRetry(j, reason);
      return;
    }
    fs.mkdirSync(path.dirname(this.cloudLogFile(j.id)), { recursive: true });
    fs.writeFileSync(this.cloudLogFile(j.id), result.log);
    const passed = result.verdict === "done" && result.exitCode === 0;
    const arts = j.artifactGlobs?.length
      ? `; artifacts stay in the cloud session ${c.handle.url}`
      : "";
    let summary: string;
    if (result.verdict === "timeout") summary = `timed out after ${j.timeoutMinutes} min`;
    else if (passed) summary = "passed";
    else {
      const lines = result.log
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => /fail|error|expected|assert|✗|×/i.test(l))
        .slice(-4);
      summary = [`exited ${result.exitCode ?? "non-zero"}`, ...lines].join(" | ");
    }
    const updated = await this.patchJob(j.id, {
      state: passed ? "passed" : "failed",
      finishedAt: nowIso(),
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      ...(j.startedAt ? {} : { startedAt: j.dispatchedAt ?? nowIso() }),
      unreachableSince: undefined,
      summary: `${summary}${arts}`.slice(0, 480),
    });
    if (updated) this.removePatch(updated.id);
  }

  /**
   * A cloud run gave no verified result: this attempt is an error and the job
   * goes back to the queue once, away from that provider; a second time ends it.
   */
  private async cloudRetry(j: FleetJob, reason: string): Promise<void> {
    const at = nowIso();
    const from = j.node ?? "cloud";
    await this.jobs.update((jobs) => {
      const x = jobs.find((y) => y.id === j.id);
      if (!x || (x.state !== "preparing" && x.state !== "running")) return;
      const attempts = x.attempts ?? 1;
      const triedCloud = (x.requeues ?? []).some((r) => r.from.startsWith("cloud:"));
      x.updatedAt = at;
      x.requeues = [...(x.requeues ?? []), { at, from, reason }];
      if (triedCloud || attempts >= FLEET_MAX_ATTEMPTS || !canRequeue(x)) {
        x.state = "error";
        x.finishedAt = at;
        x.summary = `${reason} (on ${from})`.slice(0, 400);
        return;
      }
      x.state = "queued";
      x.attempts = attempts + 1;
      x.avoid = [...new Set([...(x.avoid ?? []), from])];
      x.summary = `requeued (attempt ${attempts + 1}/${FLEET_MAX_ATTEMPTS}): ${reason}`.slice(
        0,
        400,
      );
      if (x.cloudPin) x.node = x.cloudPin;
      else if (!x.pinned) delete x.node;
      for (const k of [
        "remoteId",
        "dispatchedAt",
        "startedAt",
        "unreachableSince",
        "nodeDownWarned",
        "waitWarned",
        "cloud",
      ] as const) {
        delete x[k];
      }
    });
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

/** A3: how many log lines a failure notification carries. */
export const FAIL_TAIL_LINES = 30;

/** Last FAIL_TAIL_LINES non-empty lines, each capped at 300 chars. */
export function failTailLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .slice(-FAIL_TAIL_LINES)
    .map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l));
}

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
  if (n.incompatible) {
    return `${n.node.name} (${n.node.url}): INCOMPATIBLE — ${n.incompatible}; no work is sent there`;
  }
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
    `${i.modelAuth ? "; model login ok" : "; no model login"}${n.active ? `; ${n.active} of our jobs` : ""}` +
    `${n.updateNotice ? `\n  notice: ${n.updateNotice}` : ""}`
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
        text:
          `Fleet job FAILED: ${at}${j.summary ? `: ${j.summary}` : ""}.` +
          (j.failTail?.length
            ? ` Last ${j.failTail.length} log lines:\n${j.failTail.join("\n")}\nMore with fleet logs ${j.id} (tail/grep).`
            : ` Read the log with fleet logs ${j.id}.`),
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
            text: `Fleet node ${j.node} stopped answering while running ${j.name} (${j.id}); ${canRequeue(j) ? "it moves to another node if the node stays away" : j.kind === "deploy" ? "a deploy is never retried automatically" : `a ${j.kind} job is not retried automatically (mark it "retry": true in ${FLEET_CONFIG_FILE} if it is safe to repeat)`}.`,
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
