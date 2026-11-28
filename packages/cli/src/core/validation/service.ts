// The validation orchestrator. Sessions enqueue jobs and return immediately;
// one leader process (a session host or `ezcoder validate daemon`) dispatches
// them to backends with bounded concurrency, polls them, posts commit statuses
// and records results. Every process watches the shared store and tells its
// own sessions when a job for their project changes.
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withFileLock } from "@prestyj/core";
import { fits, loadBackends } from "./backends.js";
import { CLOUD_LIMIT_SUMMARY } from "./cloud-backend.js";
import { BILLING_SUMMARY } from "./github-actions-backend.js";
import { buildStageCommand, cacheKeyFor, loadProjectConfig, parseGitHubRepo } from "./config.js";
import { defaultExec } from "./exec.js";
import { chooseTarget, jobTarget, jobsOn, listTargets, loadOf, type Target } from "./scheduler.js";
import { JobStore, defaultValidationDir } from "./store.js";
import {
  isTerminal,
  MAX_ATTEMPTS,
  type BackendHealth,
  type Exec,
  type JobState,
  type ProjectValidationConfig,
  type Resources,
  type ValidationBackend,
  type ValidationJob,
} from "./types.js";

export interface ValidationServiceOptions {
  dir?: string;
  exec?: Exec;
  pollMs?: number;
  /** Inject backends (tests); otherwise read from backends.json. */
  backends?: ValidationBackend[];
  /** Cap on jobs in flight; default the real total capacity of every target. */
  maxConcurrent?: number;
  /** Minutes a job may wait on an offline worker before we say so. */
  offlineWarnMinutes?: number;
  /** Minutes a dispatched run may wait on an offline pool machine before it's moved. */
  machineOfflineRequeueMinutes?: number;
  /** Minutes a target stays out of scheduling after GitHub refused it for billing reasons. */
  billingBlockMinutes?: number;
  /** Start the poll loop when work is queued (off for short-lived CLI commands). */
  autoStart?: boolean;
}

export interface EnqueueOptions {
  stages?: string[];
  ref?: string;
  /** Run again even if this commit already passed the stage. */
  force?: boolean;
}

export interface EnqueueResult {
  sha: string;
  branch?: string;
  dirty: boolean;
  jobs: ValidationJob[];
  reused: ValidationJob[];
  messages: string[];
}

export interface GateRow {
  stage: string;
  state: JobState | "missing";
  jobId?: string;
  url?: string;
  note?: string;
}

export interface GateResult {
  sha: string;
  ok: boolean;
  rows: GateRow[];
}

export interface WorkerInfo {
  /** Backend id, or `<pool>/<machine>` for a pool machine. */
  id: string;
  backend: string;
  machine?: string;
  kind: string;
  /** Slots (concurrent EZCODER jobs). */
  maxConcurrent: number;
  /** Our jobs dispatched there and not finished. */
  active: number;
  /** Slots taken (GitHub-busy runners plus our not-yet-started runs). */
  used: number;
  /** Runners GitHub reports busy. */
  busy: number;
  queued: number;
  health: BackendHealth;
  platform: string[];
  capacity?: Resources;
  /** CPU/memory held by our in-flight jobs there. */
  reserved: { cpus: number; memoryGb: number };
  cloud?: boolean;
  /** Infra errors and lost runs there in the last 24 h. */
  recentFailures: number;
  /** Out of scheduling until then (GitHub refused it for billing reasons). */
  blockedUntil?: string;
}

export type JobListener = (
  job: ValidationJob,
  previous: JobState | undefined,
  info?: { requeued: boolean },
) => void;

const ACTIVE: ReadonlySet<JobState> = new Set(["queued", "waiting", "running"]);

function nowIso(): string {
  return new Date().toISOString();
}

function newJobId(): string {
  return `v${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function short(sha: string): string {
  return sha.slice(0, 8);
}

let shared: ValidationService | undefined;

export class ValidationService {
  readonly dir: string;
  readonly store: JobStore;
  private readonly exec: Exec;
  private readonly pollMs: number;
  private readonly offlineWarnMs: number;
  private readonly machineOfflineMs: number;
  /** Targets GitHub refused to run on (billing), until when (ms epoch). In memory only. */
  private readonly unavailable = new Map<string, number>();
  private readonly unavailableMs: number;
  private backends: ValidationBackend[];
  private maxConcurrent: number | undefined;
  private readonly injected: boolean;
  private readonly events = new EventEmitter();
  private seen = new Map<string, string>();
  private seeded = false;
  private timer: NodeJS.Timeout | undefined;
  private ticking: Promise<void> | undefined;
  private keepAlive = false;
  /** Backend problems found while loading the registry. */
  problems: string[] = [];
  /** Start the poll loop when work is queued; short-lived commands turn this off. */
  autoStart: boolean;

  constructor(opts: ValidationServiceOptions = {}) {
    this.dir = opts.dir ?? defaultValidationDir();
    this.store = new JobStore(this.dir);
    this.exec = opts.exec ?? defaultExec;
    this.pollMs = opts.pollMs ?? 20_000;
    this.offlineWarnMs = (opts.offlineWarnMinutes ?? 10) * 60_000;
    this.machineOfflineMs = (opts.machineOfflineRequeueMinutes ?? 5) * 60_000;
    this.unavailableMs = (opts.billingBlockMinutes ?? 60) * 60_000;
    this.injected = !!opts.backends;
    this.backends = opts.backends ?? [];
    this.maxConcurrent = opts.maxConcurrent;
    this.autoStart = opts.autoStart ?? true;
    if (!opts.backends) this.reloadBackends();
    this.events.setMaxListeners(100);
  }

  /** One service per process. */
  static shared(): ValidationService {
    shared ??= new ValidationService();
    return shared;
  }

  reloadBackends(): void {
    if (this.injected) return;
    const loaded = loadBackends(this.dir, this.exec);
    this.backends = loaded.backends;
    this.maxConcurrent = loaded.maxConcurrent;
    this.problems = loaded.problems;
  }

  /** Slots of this machine's local backend. */
  localCapacity(): number {
    return this.backend("local")?.maxConcurrent ?? 0;
  }

  /** The in-flight cap: explicit, or the total slots of every self-hosted target online. */
  capacityOf(targets: readonly Target[]): number {
    if (this.maxConcurrent !== undefined) return Math.max(1, this.maxConcurrent);
    const total = targets
      .filter((t) => t.online && t.backend.kind !== "cloud")
      .reduce((n, t) => n + Math.max(0, t.slots), 0);
    return Math.max(1, total);
  }

  getBackends(): readonly ValidationBackend[] {
    return this.backends;
  }

  private backend(id: string): ValidationBackend | undefined {
    return this.backends.find((b) => b.id === id);
  }

  // ── events ───────────────────────────────────────────────

  onJob(listener: JobListener): () => void {
    this.events.on("job", listener);
    return () => this.events.off("job", listener);
  }

  private observe(jobs: ValidationJob[]): ValidationJob[] {
    const changed: ValidationJob[] = [];
    for (const job of jobs) {
      const prev = this.seen.get(job.id);
      const key = `${job.state}|${job.offlineWarned ? 1 : 0}|${job.requeues?.length ?? 0}|${job.noWorkerWarned ? 1 : 0}`;
      if (prev === key) continue;
      this.seen.set(job.id, key);
      // First look after start: only report finished jobs nobody was told about.
      if (!this.seeded && (!isTerminal(job.state) || job.notifiedState === job.state)) continue;
      changed.push(job);
      const requeued = !!prev && (job.requeues?.length ?? 0) > Number(prev.split("|")[2] ?? 0);
      this.events.emit("job", job, prev ? (prev.split("|")[0] as JobState) : undefined, {
        requeued,
      });
    }
    this.seeded = true;
    return changed;
  }

  // ── git ──────────────────────────────────────────────────

  private async git(cwd: string, args: string[]): Promise<string | undefined> {
    const r = await this.exec("git", args, { cwd, timeoutMs: 15_000 });
    return r.code === 0 ? r.stdout.trim() : undefined;
  }

  private async gitState(cwd: string, ref: string) {
    const sha = await this.git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
    const branchRaw = await this.git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const status = await this.git(cwd, ["status", "--porcelain", "--untracked-files=no"]);
    const origin = await this.git(cwd, ["remote", "get-url", "origin"]);
    return {
      sha,
      branch: ref === "HEAD" && branchRaw && branchRaw !== "HEAD" ? branchRaw : undefined,
      dirty: ref === "HEAD" && !!status,
      originRepo: origin ? parseGitHubRepo(origin) : undefined,
    };
  }

  // ── public API ───────────────────────────────────────────

  config(cwd: string): ProjectValidationConfig | { error: string } {
    return loadProjectConfig(cwd);
  }

  async enqueue(cwdIn: string, opts: EnqueueOptions = {}): Promise<EnqueueResult> {
    const cwd = path.resolve(cwdIn);
    const config = loadProjectConfig(cwd);
    if ("error" in config) throw new Error(config.error);
    const ref = opts.ref ?? "HEAD";
    const g = await this.gitState(cwd, ref);
    if (!g.sha)
      throw new Error(`"${ref}" is not a commit in ${cwd} (is this a Git repo with commits?)`);
    const sha = g.sha;
    const repo = config.repo ?? g.originRepo;
    let stages = config.stages;
    if (opts.stages?.length) {
      const unknown = opts.stages.filter((s) => !stages.some((x) => x.name === s));
      if (unknown.length) {
        throw new Error(
          `unknown stage(s) ${unknown.join(", ")}; this project has: ${stages.map((s) => s.name).join(", ") || "none"}`,
        );
      }
      stages = stages.filter((s) => opts.stages!.includes(s.name));
    }
    if (stages.length === 0) throw new Error(`no validation stages. ${config.notes.join(" ")}`);

    const messages: string[] = [];
    // Cloud overflow alone doesn't make stages remote: without a self-hosted
    // worker they keep running on this machine.
    const hasRemote = this.backends.some((b) => b.runs === "remote" && b.kind !== "cloud");
    if (g.dirty && stages.some((s) => s.run === "remote")) {
      messages.push(
        `Uncommitted changes are not included in remote stages; they test commit ${short(sha)}. Commit first to test them.`,
      );
    }
    const created: ValidationJob[] = [];
    const reused: ValidationJob[] = [];
    await this.store.update((jobs) => {
      for (const stage of stages) {
        const pin = stage.run === "local" ? undefined : stage.backend;
        const slash = pin?.indexOf("/") ?? -1;
        let backend =
          stage.run === "local" ? "local" : pin ? (slash > 0 ? pin.slice(0, slash) : pin) : "";
        const pinnedMachine = pin && slash > 0 ? pin.slice(slash + 1) : undefined;
        let command = buildStageCommand(stage, cacheKeyFor(repo));
        if (stage.run === "remote" && !stage.backend && (!repo || !hasRemote)) {
          backend = "local";
          command = stage.setup ? `${stage.setup} && ${stage.command}` : stage.command;
          messages.push(
            `${stage.name}: ${!repo ? "not a GitHub repo" : "no remote worker configured"}, so it runs on this machine.`,
          );
        }
        if (backend && !this.backend(backend)) {
          throw new Error(
            `stage ${stage.name} names backend "${pin ?? backend}", which isn't configured`,
          );
        }
        if (pinnedMachine && !this.backend(backend)?.machines) {
          throw new Error(
            `stage ${stage.name} pins "${pin}", but ${backend} isn't a pool (discover)`,
          );
        }
        const isLocal = backend === "local";
        const same = jobs
          .filter(
            (j) =>
              j.project === cwd && j.sha === sha && j.stage === stage.name && j.command === command,
          )
          .at(-1);
        if (
          same &&
          !opts.force &&
          (ACTIVE.has(same.state) ||
            (same.state === "passed" && !same.dirty && !(isLocal && g.dirty)))
        ) {
          reused.push(same);
          continue;
        }
        const at = nowIso();
        const job: ValidationJob = {
          id: newJobId(),
          project: cwd,
          ...(repo ? { repo } : {}),
          sha,
          ...(g.branch ? { branch: g.branch } : {}),
          stage: stage.name,
          run: isLocal ? "local" : "remote",
          required: stage.required,
          command,
          timeoutMinutes: stage.timeoutMinutes,
          backend,
          ...(pin && !isLocal ? { pinned: true } : {}),
          ...(pinnedMachine && !isLocal ? { machine: pinnedMachine } : {}),
          ...(stage.resources ? { resources: stage.resources } : {}),
          ...(config.postCommitStatus && repo && !isLocal
            ? { statusContext: `${config.statusContextPrefix}/${stage.name}` }
            : {}),
          state: "queued",
          createdAt: at,
          updatedAt: at,
          ...(isLocal && g.dirty ? { dirty: true } : {}),
        };
        // A newer commit on the same branch makes older pending runs pointless.
        if (g.branch) {
          for (const old of jobs) {
            if (
              old.project === cwd &&
              old.branch === g.branch &&
              old.stage === stage.name &&
              old.sha !== sha &&
              ACTIVE.has(old.state) &&
              (old.state === "queued" || config.cancelSuperseded)
            ) {
              old.state = "superseded";
              old.supersededBy = job.id;
              old.summary = `superseded by ${short(sha)}`;
              old.updatedAt = at;
              old.finishedAt = at;
              messages.push(`${old.stage} for ${short(old.sha)} superseded.`);
            }
          }
        }
        jobs.push(job);
        created.push(job);
      }
    });
    if (created.length && this.autoStart) this.start();
    return { sha, branch: g.branch, dirty: g.dirty, jobs: created, reused, messages };
  }

  async list(cwd?: string): Promise<ValidationJob[]> {
    const jobs = await this.store.read();
    return cwd ? jobs.filter((j) => j.project === path.resolve(cwd)) : jobs;
  }

  async get(id: string): Promise<ValidationJob | undefined> {
    return (await this.store.read()).find((j) => j.id === id);
  }

  /** Required stages for an exact commit: ok only when every one passed at that SHA. */
  async gate(cwdIn: string, ref = "HEAD"): Promise<GateResult> {
    const cwd = path.resolve(cwdIn);
    const config = loadProjectConfig(cwd);
    if ("error" in config) throw new Error(config.error);
    const sha = await this.git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
    if (!sha) throw new Error(`"${ref}" is not a commit`);
    const jobs = (await this.store.read()).filter(
      (j) => j.project === cwd && j.sha === sha && j.state !== "superseded",
    );
    const rows: GateRow[] = config.stages
      .filter((s) => s.required)
      .map((s) => {
        const mine = jobs.filter((j) => j.stage === s.name);
        const job =
          [...mine].reverse().find((j) => j.state === "passed" && !j.dirty) ?? mine.at(-1);
        if (!job) return { stage: s.name, state: "missing" as const };
        const note = job.dirty ? "ran on uncommitted changes; doesn't count" : job.summary;
        return {
          stage: s.name,
          state: job.state,
          jobId: job.id,
          url: job.url,
          ...(note ? { note } : {}),
        };
      });
    const ok = rows.every((r) => r.state === "passed" && !r.note?.includes("doesn't count"));
    return { sha, ok, rows };
  }

  async cancel(id: string): Promise<ValidationJob | undefined> {
    const job = await this.store.update((jobs) => {
      const j = jobs.find((x) => x.id === id);
      if (!j || isTerminal(j.state)) return j;
      j.state = "cancelled";
      j.summary = "cancelled by request";
      j.updatedAt = j.finishedAt = nowIso();
      return { ...j };
    });
    if (job?.runId)
      await this.backend(job.backend)
        ?.cancel(job)
        .catch(() => {});
    if (job?.statusContext && job.dispatchedAt) await this.postStatus(job, "error", "cancelled");
    return job;
  }

  /** Run a finished job again at the same commit. */
  async retry(id: string): Promise<ValidationJob> {
    const created = await this.store.update((jobs) => {
      const j = jobs.find((x) => x.id === id);
      if (!j) throw new Error(`no job ${id}`);
      if (!isTerminal(j.state)) throw new Error(`job ${id} is still ${j.state}`);
      const at = nowIso();
      const copy: ValidationJob = {
        id: newJobId(),
        project: j.project,
        ...(j.repo ? { repo: j.repo } : {}),
        sha: j.sha,
        ...(j.branch ? { branch: j.branch } : {}),
        stage: j.stage,
        run: j.run,
        required: j.required,
        command: j.command,
        timeoutMinutes: j.timeoutMinutes,
        backend: j.run === "local" ? "local" : j.pinned ? j.backend : "",
        ...(j.pinned ? { pinned: true, ...(j.machine ? { machine: j.machine } : {}) } : {}),
        ...(j.resources ? { resources: j.resources } : {}),
        ...(j.statusContext ? { statusContext: j.statusContext } : {}),
        ...(j.dirty ? { dirty: true } : {}),
        state: "queued",
        createdAt: at,
        updatedAt: at,
        retryOf: j.id,
      };
      jobs.push(copy);
      return copy;
    });
    if (this.autoStart) this.start();
    return created;
  }

  async logs(id: string, failedOnly = true): Promise<string> {
    const job = await this.get(id);
    if (!job) return `No job ${id}.`;
    const b = this.backend(job.backend);
    if (!b)
      return job.backend
        ? `Backend ${job.backend} is no longer configured.`
        : "Not dispatched yet.";
    return b.logs(job, failedOnly && job.state === "failed");
  }

  /** Every place jobs can run: plain backends and each pool machine. */
  async workers(): Promise<WorkerInfo[]> {
    const jobs = await this.store.read();
    const dayAgo = Date.now() - 86_400_000;
    const targets = await listTargets(this.backends);
    return Promise.all(
      targets.map(async (t) => {
        const mine = jobsOn(t, jobs);
        const load = loadOf(t, jobs);
        const health: BackendHealth = t.info
          ? { online: t.online, busy: t.online && t.busy >= t.slots, detail: t.info.detail }
          : await t.backend.health().catch((e: unknown) => ({
              online: false,
              detail: e instanceof Error ? e.message : String(e),
            }));
        const here = (j: ValidationJob) =>
          j.backend === t.backend.id &&
          (t.machine === undefined || (j.machine ?? t.backend.id) === t.machine);
        const recent = (at: string) => Date.parse(at) > dayAgo;
        return {
          id: t.key,
          backend: t.backend.id,
          ...(t.machine !== undefined ? { machine: t.machine } : {}),
          kind: t.backend.kind,
          maxConcurrent: t.slots,
          active: mine.length,
          used: load.used,
          busy: t.busy,
          queued: jobs.filter(
            (j) =>
              j.state === "queued" &&
              (j.backend
                ? j.backend === t.backend.id && (!j.machine || j.machine === t.machine)
                : t.backend.runs === "remote"),
          ).length,
          health,
          platform: t.platform,
          ...(t.capacity ? { capacity: t.capacity } : {}),
          reserved: { cpus: load.reservedCpus, memoryGb: load.reservedMemoryGb },
          ...(t.cloud ? { cloud: true } : {}),
          ...(this.unavailableUntil(t.key)
            ? { blockedUntil: new Date(this.unavailableUntil(t.key)!).toISOString() }
            : {}),
          recentFailures:
            jobs.filter((j) => here(j) && j.state === "error" && recent(j.updatedAt)).length +
            jobs.flatMap((j) => j.requeues ?? []).filter((r) => r.from === t.key && recent(r.at))
              .length,
        };
      }),
    );
  }

  // ── scheduling loop ──────────────────────────────────────

  /** Start (or keep) the poll loop. Cheap when idle: it stops itself. */
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

  /** One pass: observe, and if we lead, poll/dispatch. Returns whether work remains. */
  async tick(): Promise<boolean> {
    if (this.ticking) {
      await this.ticking;
      return this.hasActive();
    }
    this.ticking = this.tickInner().finally(() => {
      this.ticking = undefined;
    });
    await this.ticking;
    return this.hasActive();
  }

  private lastActive = false;
  private hasActive(): boolean {
    return this.lastActive;
  }

  private async tickInner(): Promise<void> {
    let jobs = await this.store.read();
    this.emitAndMark(jobs);
    const active = jobs.filter((j) => ACTIVE.has(j.state));
    const pendingCancels = jobs.filter((j) => j.state === "superseded" && j.runId && !j.stopSent);
    this.lastActive = active.length > 0;
    if (!active.length && !pendingCancels.length) {
      if (!this.keepAlive) this.stop();
      return;
    }
    if (!(await this.lead())) return;

    // Superseded jobs that were already running: stop them on the worker.
    for (const j of pendingCancels) {
      await this.patch(j.id, { stopSent: true }, undefined, true);
      await this.backend(j.backend)
        ?.cancel(j)
        .catch(() => {});
      await this.postStatus(j, "error", `superseded by a newer commit`);
    }

    // Poll what's in flight.
    for (const j of active.filter((x) => x.state !== "queued")) {
      const b = this.backend(j.backend);
      if (!b) {
        await this.patch(j.id, {
          state: "error",
          summary: `backend ${j.backend} is no longer configured`,
        });
        continue;
      }
      try {
        const r = await b.poll(j);
        if (r.blocked) {
          await this.handleBlocked(j, r.blocked, r.url);
          continue;
        }
        if (r.lost) {
          await this.requeueLost(j, r.lost);
          continue;
        }
        const patch: Partial<ValidationJob> = {};
        if (r.url && r.url !== j.url) patch.url = r.url;
        if (r.state !== j.state) {
          patch.state = r.state;
          if (r.summary) patch.summary = r.summary;
          if (r.state === "running") patch.startedAt = nowIso();
          if (isTerminal(r.state)) {
            patch.finishedAt = nowIso();
            if (j.run === "local" && !j.dirty && (await this.movedSince(j))) patch.dirty = true;
            if (r.state === "failed" && b.runs === "remote") {
              patch.summary = await this.failureSummary(b, j, r.summary);
            }
          }
        }
        // A run still waiting for a pool machine that went offline: move it elsewhere.
        if (r.state === "waiting" && b.machines && j.machine) {
          const m = (await b.machines().catch(() => [])).find((x) => x.name === j.machine);
          if (m && !m.cloud && !m.online) {
            const since = j.machineOfflineSince ? Date.parse(j.machineOfflineSince) : undefined;
            if (since === undefined) patch.machineOfflineSince = nowIso();
            else if (Date.now() - since > this.machineOfflineMs) {
              await b.cancel(j).catch(() => {});
              await this.requeueLost(
                j,
                `machine ${jobTarget(j)} went offline before the run started`,
              );
              continue;
            }
          } else if (j.machineOfflineSince) {
            patch.machineOfflineSince = undefined;
          }
        } else if (
          (r.state === "waiting" || j.state === "waiting") &&
          !(b.machines && j.machine) &&
          !j.offlineWarned &&
          j.dispatchedAt &&
          Date.now() - Date.parse(j.dispatchedAt) > this.offlineWarnMs
        ) {
          const h = await b.health().catch(() => undefined);
          if (h && !h.online) {
            patch.offlineWarned = true;
            patch.summary = `worker offline (${h.detail}); it stays queued on GitHub and runs when the worker is back`;
          }
        }
        if (Object.keys(patch).length) {
          const updated = await this.patch(j.id, patch);
          if (updated && patch.state && isTerminal(patch.state) && updated.statusContext) {
            await this.postFinal(updated);
          }
        }
      } catch (e) {
        // Transient (network, rate limit): try again next tick.
        void e;
      }
    }

    // Dispatch queued jobs into free slots, oldest first.
    jobs = await this.store.read();
    // Cloud overflow is extra capacity: it doesn't count against the cap, and
    // once the cap is reached a job may still go to the cloud.
    const isCloud = (id: string) => this.backend(id)?.kind === "cloud";
    let inFlight = jobs.filter(
      (j) => (j.state === "waiting" || j.state === "running") && !isCloud(j.backend),
    ).length;
    const queued = jobs.filter((x) => x.state === "queued");
    const targets: Target[] = queued.length ? await this.availableTargets() : [];
    const cloudTargets = targets.filter((t) => t.backend.kind === "cloud");
    const cap = this.capacityOf(targets);
    for (const j of queued) {
      const atCap = inFlight >= cap;
      if (atCap && !cloudTargets.length) break;
      const t = atCap ? chooseTarget(j, cloudTargets, jobs) : chooseTarget(j, targets, jobs);
      if (atCap && (t === undefined || typeof t === "string")) continue;
      if (t === "none") {
        await this.patch(j.id, {
          state: "error",
          summary: j.machine
            ? `pinned machine ${jobTarget(j)} isn't known to its pool`
            : "no configured worker fits this stage's resources",
          finishedAt: nowIso(),
        });
        continue;
      }
      if (t === "offline") {
        if (!j.noWorkerWarned) {
          await this.patch(
            j.id,
            {
              noWorkerWarned: true,
              summary: "no worker online; it stays queued and runs when one comes online",
            },
            "queued",
          );
        }
        continue;
      }
      if (!t) continue; // every fitting machine is full
      const b = t.backend;
      const claim: Partial<ValidationJob> = {
        backend: b.id,
        ...(t.machine !== undefined ? { machine: t.machine } : {}),
      };
      const claimed = await this.patch(j.id, claim, "queued");
      if (!claimed) continue;
      try {
        // Cloud sandboxes get the commit as an upload, not from GitHub.
        if (
          b.runs === "remote" &&
          b.kind !== "cloud" &&
          j.repo &&
          !(await this.commitOnGitHub(j.repo, j.sha))
        ) {
          await this.patch(j.id, {
            state: "error",
            summary: `commit ${short(j.sha)} isn't on GitHub; push it, then run validation again`,
            finishedAt: nowIso(),
          });
          continue;
        }
        const handle = await b.dispatch(claimed);
        const at = nowIso();
        const updated = await this.patch(
          j.id,
          { state: "waiting", dispatchedAt: at, attempts: j.attempts ?? 1, ...handle },
          "queued",
        );
        if (b.kind !== "cloud") inFlight++;
        // Count it against the machine for the rest of this pass.
        Object.assign(j, claim, { state: "waiting", dispatchedAt: at });
        if (updated?.statusContext) {
          await this.postStatus(updated, "pending", `running on ${jobTarget(updated)}`);
        }
      } catch (e) {
        if ((e as { code?: unknown }).code === "busy") {
          // The machine filled up since we looked (other work took the slot):
          // back to the queue; it starts when a slot frees. Never an error.
          await this.patch(
            j.id,
            { backend: j.backend, machine: j.machine, summary: `waiting: ${t.key} is full` },
            "queued",
          );
          continue;
        }
        await this.patch(j.id, {
          state: "error",
          summary:
            `dispatch to ${t.key} failed: ${e instanceof Error ? e.message : String(e)}`.slice(
              0,
              400,
            ),
          finishedAt: nowIso(),
        });
      }
    }
    this.emitAndMark(await this.store.read());
  }

  /** Targets minus the ones GitHub recently refused (billing). */
  private async availableTargets(): Promise<Target[]> {
    const now = Date.now();
    for (const [k, until] of this.unavailable) if (until <= now) this.unavailable.delete(k);
    return (await listTargets(this.backends)).filter((t) => !this.unavailable.has(t.key));
  }

  /** Is a target out of scheduling (billing), and until when? */
  unavailableUntil(key: string): number | undefined {
    const until = this.unavailable.get(key);
    return until && until > Date.now() ? until : undefined;
  }

  /**
   * GitHub refused to start the run (Actions budget/billing). Never a runner-loss loop:
   * the target is benched for a while and the job goes back once to a self-hosted
   * machine that fits; otherwise it ends as an infra error.
   */
  private async handleBlocked(j: ValidationJob, why: string, url?: string): Promise<void> {
    const from = jobTarget(j);
    this.unavailable.set(from, Date.now() + this.unavailableMs);
    // Cloud: plan usage limit (the provider is benched until it lifts). GitHub: billing.
    const prefix =
      this.backend(j.backend)?.kind === "cloud" ? CLOUD_LIMIT_SUMMARY : BILLING_SUMMARY;
    const alreadyMoved = (j.requeues ?? []).some((r) => r.reason.startsWith(prefix));
    const selfHosted = (await this.availableTargets()).some(
      (t) =>
        !t.cloud &&
        t.backend.runs === "remote" &&
        (!j.pinned || t.backend.id === j.backend) &&
        fits(j.resources, t.capacity),
    );
    const at = nowIso();
    const reason = (why.startsWith(prefix) ? why : `${prefix} (${why})`).slice(0, 300);
    const updated = await this.store.update((jobs) => {
      const x = jobs.find((y) => y.id === j.id);
      if (!x || (x.state !== "waiting" && x.state !== "running")) return undefined;
      x.updatedAt = at;
      if (alreadyMoved || !selfHosted || (x.pinned && x.machine)) {
        x.state = "error";
        x.finishedAt = at;
        x.summary = reason;
        if (url) x.url = url;
        return { ...x };
      }
      x.requeues = [
        ...(x.requeues ?? []),
        { at, from, ...(x.runId ? { runId: x.runId } : {}), reason },
      ];
      x.state = "queued";
      x.avoid = [...new Set([...(x.avoid ?? []), from])];
      x.summary = `requeued to a self-hosted worker: ${reason}`.slice(0, 400);
      if (!x.pinned) {
        x.backend = "";
        delete x.machine;
      }
      for (const k of ["runId", "url", "dispatchedAt", "startedAt", "finishedAt"] as const)
        delete x[k];
      return { ...x };
    });
    if (updated?.state === "error" && updated.statusContext) await this.postFinal(updated);
  }

  /**
   * A run lost its runner (or its machine went away before it started): queue the
   * job again, up to MAX_ATTEMPTS, steering it away from that machine. Jobs that
   * EZCODER cancelled or superseded meanwhile are left alone.
   */
  private async requeueLost(j: ValidationJob, reason: string): Promise<void> {
    const from = jobTarget(j);
    const at = nowIso();
    const updated = await this.store.update((jobs) => {
      const x = jobs.find((y) => y.id === j.id);
      if (!x || (x.state !== "waiting" && x.state !== "running")) return undefined;
      const attempts = x.attempts ?? 1;
      x.requeues = [
        ...(x.requeues ?? []),
        { at, from, ...(x.runId ? { runId: x.runId } : {}), reason },
      ];
      x.updatedAt = at;
      if (attempts >= MAX_ATTEMPTS) {
        x.state = "error";
        x.finishedAt = at;
        x.summary = `worker lost ${attempts} times; last: ${reason}`.slice(0, 400);
        return { ...x };
      }
      x.state = "queued";
      x.attempts = attempts + 1;
      x.avoid = [...new Set([...(x.avoid ?? []), from])];
      x.summary = `requeued (attempt ${attempts + 1}/${MAX_ATTEMPTS}): ${reason}`.slice(0, 400);
      if (!x.pinned) {
        x.backend = "";
        delete x.machine;
      }
      for (const k of [
        "runId",
        "url",
        "dispatchedAt",
        "startedAt",
        "finishedAt",
        "offlineWarned",
        "machineOfflineSince",
      ] as const) {
        delete x[k];
      }
      return { ...x };
    });
    if (updated?.state === "error" && updated.statusContext) await this.postFinal(updated);
  }

  private async movedSince(job: ValidationJob): Promise<boolean> {
    const head = await this.git(job.project, ["rev-parse", "HEAD"]);
    const status = await this.git(job.project, ["status", "--porcelain", "--untracked-files=no"]);
    return head !== job.sha || !!status;
  }

  private async failureSummary(
    b: ValidationBackend,
    j: ValidationJob,
    base?: string,
  ): Promise<string> {
    const log = await b.logs(j, true).catch(() => "");
    const lines = log
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => /fail|error|expected|assert|✗|×/i.test(l))
      .slice(-4);
    return [base ?? "failed", ...lines].join(" | ").slice(0, 480);
  }

  private async commitOnGitHub(repo: string, sha: string): Promise<boolean> {
    const r = await this.exec("gh", ["api", `repos/${repo}/commits/${sha}`, "--jq", ".sha"], {
      timeoutMs: 30_000,
    });
    if (r.code === 0) return true;
    // Only a clear "not found" blocks; on network trouble let the worker decide.
    return !/HTTP 4(04|22)|No commit found/i.test(r.stderr + r.stdout);
  }

  private async postFinal(job: ValidationJob): Promise<void> {
    const state = job.state === "passed" ? "success" : job.state === "failed" ? "failure" : "error";
    await this.postStatus(job, state, (job.summary ?? job.state).slice(0, 130));
  }

  private async postStatus(job: ValidationJob, state: string, description: string): Promise<void> {
    if (!job.repo || !job.statusContext) return;
    const args = [
      "api",
      "-X",
      "POST",
      `repos/${job.repo}/statuses/${job.sha}`,
      "-f",
      `state=${state}`,
      "-f",
      `context=${job.statusContext}`,
      "-f",
      `description=${description.slice(0, 139)}`,
      ...(job.url?.startsWith("http") ? ["-f", `target_url=${job.url}`] : []),
    ];
    const r = await this.exec("gh", args, { timeoutMs: 30_000 });
    await this.patch(
      job.id,
      { postedStatus: r.code === 0 ? state : `failed:${state}` },
      undefined,
      true,
    );
  }

  /** Merge a patch into one stored job. With `onlyIf`, only when it's still in that state. */
  private async patch(
    id: string,
    patch: Partial<ValidationJob>,
    onlyIf?: JobState,
    evenIfTerminal = false,
  ): Promise<ValidationJob | undefined> {
    return this.store.update((jobs) => {
      const j = jobs.find((x) => x.id === id);
      if (!j) return undefined;
      if (onlyIf && j.state !== onlyIf) return undefined;
      // Never resurrect a job someone cancelled or superseded meanwhile.
      if (!evenIfTerminal && isTerminal(j.state) && patch.state && !isTerminal(patch.state))
        return undefined;
      if (!evenIfTerminal && (j.state === "cancelled" || j.state === "superseded") && patch.state) {
        return undefined;
      }
      Object.assign(j, patch, { updatedAt: nowIso() });
      return { ...j };
    });
  }

  private emitAndMark(jobs: ValidationJob[]): void {
    const changed = this.observe(jobs);
    const done = changed.filter((j) => isTerminal(j.state) && j.notifiedState !== j.state);
    if (done.length && this.events.listenerCount("job") > 0) {
      void this.store
        .update((all) => {
          for (const d of done) {
            const j = all.find((x) => x.id === d.id);
            if (j) j.notifiedState = d.state;
          }
        })
        .catch(() => {});
    }
  }

  // ── leadership ───────────────────────────────────────────

  private async lead(): Promise<boolean> {
    const file = path.join(this.dir, "leader.json");
    const staleMs = Math.max(90_000, this.pollMs * 4);
    await fs.mkdir(this.dir, { recursive: true });
    return withFileLock(file, async () => {
      try {
        const cur = JSON.parse(await fs.readFile(file, "utf8")) as {
          pid: number;
          host: string;
          at: number;
        };
        const mine = cur.pid === process.pid && cur.host === os.hostname();
        const live = cur.host === os.hostname() ? pidAlive(cur.pid) : true;
        if (!mine && live && Date.now() - cur.at < staleMs) return false;
      } catch {
        // no leader yet
      }
      await fs.writeFile(
        file,
        JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() }),
      );
      return true;
    });
  }

  /** Is some live process leading? (Used to decide whether to start a daemon.) */
  async leaderAlive(): Promise<boolean> {
    try {
      const cur = JSON.parse(await fs.readFile(path.join(this.dir, "leader.json"), "utf8")) as {
        pid: number;
        host: string;
        at: number;
      };
      return (
        cur.host === os.hostname() &&
        pidAlive(cur.pid) &&
        Date.now() - cur.at < Math.max(90_000, this.pollMs * 4)
      );
    } catch {
      return false;
    }
  }
}

/** Plain-words one-liner for a worker / pool machine, used by the tool and the CLI. */
export function describeWorker(w: WorkerInfo): string {
  const cap = [
    w.capacity?.cpus ? `${w.capacity.cpus} cpu` : "",
    w.capacity?.memoryGb ? `${w.capacity.memoryGb} GB` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const reserved =
    w.reserved.cpus || w.reserved.memoryGb
      ? `; reserved ${w.reserved.cpus} cpu, ${w.reserved.memoryGb} GB`
      : "";
  const kind = w.cloud ? "cloud" : w.kind;
  return (
    `${w.id} (${kind}${w.platform.length ? `, ${w.platform.join("/")}` : ""}): ` +
    `${w.health.online ? "online" : "OFFLINE"}${w.blockedUntil ? `, blocked until ${w.blockedUntil} (${w.kind === "cloud" ? "usage limit" : "billing"})` : ""}; ` +
    `slots ${w.used}/${w.maxConcurrent} used, ${w.busy} busy on GitHub, ${w.active} ours, ${w.queued} queued` +
    `${cap ? `; ${cap}` : ""}${reserved}` +
    `${w.recentFailures ? `; ${w.recentFailures} infra errors/lost runs in 24h` : ""} — ${w.health.detail}`
  );
}

/** Plain-words one-liner for a job, used by notifications, the tool and the CLI. */
export function describeJob(j: ValidationJob): string {
  const where = j.backend ? ` on ${jobTarget(j)}` : "";
  const extra = j.summary ? ` — ${j.summary}` : "";
  const dirty = j.dirty ? " (uncommitted changes; advisory only)" : "";
  return `${j.id} ${j.stage} @ ${short(j.sha)}${where}: ${j.state}${dirty}${extra}${j.url ? ` ${j.url}` : ""}`;
}

/** Non-urgent note that a job went back to the queue after a lost runner or billing refusal. */
export function requeueNotification(j: ValidationJob): string | undefined {
  const last = j.requeues?.at(-1);
  if (!last) return undefined;
  return (
    `Validation re-queued: ${j.stage} at ${short(j.sha)}: ${last.reason} on ${last.from} ` +
    `(attempt ${j.attempts ?? 1}/${MAX_ATTEMPTS}, now ${j.state}${j.backend ? ` on ${jobTarget(j)}` : ""}). ` +
    `Nothing to do; it runs again automatically.`
  );
}

/** The notification a session gets for a job change, or undefined for routine ones. */
export function notificationFor(
  j: ValidationJob,
): { text: string; terminal: boolean; urgent: boolean } | undefined {
  const at = `${j.stage} at ${short(j.sha)}${j.backend ? ` on ${jobTarget(j)}` : ""}`;
  switch (j.state) {
    case "passed":
      return {
        text: `Validation passed: ${at}${j.dirty ? " (on uncommitted changes, advisory only)" : ""}.`,
        terminal: true,
        urgent: false,
      };
    case "failed":
      return {
        text:
          `Validation FAILED: ${at}${j.summary ? `: ${j.summary}` : ""}. ` +
          `Read the log with validate logs ${j.id}, fix the cause, commit, then validate run again ` +
          `(the new commit supersedes this one).`,
        terminal: true,
        urgent: true,
      };
    case "error":
      return {
        text:
          `Validation could not run (not a code failure): ${at}: ${j.summary ?? "unknown error"}. ` +
          `Tell the user if it needs them; retry with validate retry ${j.id}.`,
        terminal: true,
        urgent: true,
      };
    case "queued":
      return j.noWorkerWarned
        ? {
            text:
              `No validation worker online for ${j.stage} at ${short(j.sha)}; it stays queued and ` +
              `runs when a worker comes online. Tell the user if they're waiting on it.`,
            terminal: false,
            urgent: false,
          }
        : undefined;
    case "waiting":
      return j.offlineWarned
        ? {
            text: `Validation waiting: ${at}: ${j.summary}. Not retrying; tell the user.`,
            terminal: false,
            urgent: true,
          }
        : undefined;
    default:
      return undefined;
  }
}
