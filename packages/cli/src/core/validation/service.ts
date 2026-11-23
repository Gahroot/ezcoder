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
import { buildStageCommand, loadProjectConfig, parseGitHubRepo } from "./config.js";
import { defaultExec } from "./exec.js";
import { JobStore, defaultValidationDir } from "./store.js";
import {
  isTerminal,
  type BackendHealth,
  type Exec,
  type JobState,
  type ProjectValidationConfig,
  type ValidationBackend,
  type ValidationJob,
} from "./types.js";

export interface ValidationServiceOptions {
  dir?: string;
  exec?: Exec;
  pollMs?: number;
  /** Inject backends (tests); otherwise read from backends.json. */
  backends?: ValidationBackend[];
  maxConcurrent?: number;
  /** Minutes a job may wait on an offline worker before we say so. */
  offlineWarnMinutes?: number;
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
  id: string;
  kind: string;
  maxConcurrent: number;
  active: number;
  queued: number;
  health: BackendHealth;
  recentFailures: number;
}

export type JobListener = (job: ValidationJob, previous: JobState | undefined) => void;

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
  private backends: ValidationBackend[];
  private maxConcurrent: number;
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
    this.injected = !!opts.backends;
    this.backends = opts.backends ?? [];
    this.maxConcurrent = opts.maxConcurrent ?? 4;
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
      const key = `${job.state}|${job.offlineWarned ? 1 : 0}`;
      if (prev === key) continue;
      this.seen.set(job.id, key);
      // First look after start: only report finished jobs nobody was told about.
      if (!this.seeded && (!isTerminal(job.state) || job.notifiedState === job.state)) continue;
      changed.push(job);
      this.events.emit("job", job, prev ? (prev.split("|")[0] as JobState) : undefined);
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
    const hasRemote = this.backends.some((b) => b.runs === "remote");
    if (g.dirty && stages.some((s) => s.run === "remote")) {
      messages.push(
        `Uncommitted changes are not included in remote stages; they test commit ${short(sha)}. Commit first to test them.`,
      );
    }
    const created: ValidationJob[] = [];
    const reused: ValidationJob[] = [];
    await this.store.update((jobs) => {
      for (const stage of stages) {
        let backend = stage.run === "local" ? "local" : (stage.backend ?? "");
        let command = buildStageCommand(stage);
        if (stage.run === "remote" && !stage.backend && (!repo || !hasRemote)) {
          backend = "local";
          command = stage.setup ? `${stage.setup} && ${stage.command}` : stage.command;
          messages.push(
            `${stage.name}: ${!repo ? "not a GitHub repo" : "no remote worker configured"}, so it runs on this machine.`,
          );
        }
        if (backend && !this.backend(backend)) {
          throw new Error(`stage ${stage.name} names backend "${backend}", which isn't configured`);
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
        backend: j.run === "local" ? "local" : "",
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

  async workers(): Promise<WorkerInfo[]> {
    const jobs = await this.store.read();
    const dayAgo = Date.now() - 86_400_000;
    return Promise.all(
      this.backends.map(async (b) => ({
        id: b.id,
        kind: b.kind,
        maxConcurrent: b.maxConcurrent,
        active: jobs.filter(
          (j) => j.backend === b.id && (j.state === "waiting" || j.state === "running"),
        ).length,
        queued: jobs.filter(
          (j) =>
            j.state === "queued" && (j.backend === b.id || (!j.backend && b.runs === "remote")),
        ).length,
        health: await b.health().catch((e: unknown) => ({
          online: false,
          detail: e instanceof Error ? e.message : String(e),
        })),
        recentFailures: jobs.filter(
          (j) => j.backend === b.id && j.state === "error" && Date.parse(j.updatedAt) > dayAgo,
        ).length,
      })),
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
        if (
          (r.state === "waiting" || j.state === "waiting") &&
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
    let inFlight = jobs.filter((j) => j.state === "waiting" || j.state === "running").length;
    for (const j of jobs.filter((x) => x.state === "queued")) {
      if (inFlight >= this.maxConcurrent) break;
      const b = this.chooseBackend(j, jobs);
      if (b === "none") {
        await this.patch(j.id, {
          state: "error",
          summary: "no configured worker fits this stage's resources",
          finishedAt: nowIso(),
        });
        continue;
      }
      if (!b) continue; // every fitting backend is full
      const claimed = await this.patch(j.id, { backend: b.id }, "queued");
      if (!claimed) continue;
      try {
        if (b.runs === "remote" && j.repo && !(await this.commitOnGitHub(j.repo, j.sha))) {
          await this.patch(j.id, {
            state: "error",
            summary: `commit ${short(j.sha)} isn't on GitHub; push it, then run validation again`,
            finishedAt: nowIso(),
          });
          continue;
        }
        const handle = await b.dispatch({ ...claimed, backend: b.id });
        const at = nowIso();
        const updated = await this.patch(
          j.id,
          { state: "waiting", dispatchedAt: at, ...handle },
          "queued",
        );
        inFlight++;
        j.backend = b.id;
        j.state = "waiting";
        if (updated?.statusContext) await this.postStatus(updated, "pending", `running on ${b.id}`);
      } catch (e) {
        await this.patch(j.id, {
          state: "error",
          summary:
            `dispatch to ${b.id} failed: ${e instanceof Error ? e.message : String(e)}`.slice(
              0,
              400,
            ),
          finishedAt: nowIso(),
        });
      }
    }
    this.emitAndMark(await this.store.read());
  }

  private chooseBackend(
    job: ValidationJob,
    jobs: ValidationJob[],
  ): ValidationBackend | undefined | "none" {
    const load = (b: ValidationBackend) =>
      jobs.filter((j) => j.backend === b.id && (j.state === "waiting" || j.state === "running"))
        .length;
    let candidates: ValidationBackend[];
    if (job.backend) {
      const b = this.backend(job.backend);
      if (!b) return "none";
      candidates = [b];
    } else {
      candidates = this.backends.filter(
        (b) => b.runs === "remote" && fits(job.resources, b.capacity),
      );
      if (!candidates.length) return "none";
    }
    const free = candidates
      .filter((b) => load(b) < b.maxConcurrent)
      .sort((a, b) => load(a) / a.maxConcurrent - load(b) / b.maxConcurrent);
    return free[0];
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

/** Plain-words one-liner for a job, used by notifications, the tool and the CLI. */
export function describeJob(j: ValidationJob): string {
  const where = j.backend ? ` on ${j.backend}` : "";
  const extra = j.summary ? ` — ${j.summary}` : "";
  const dirty = j.dirty ? " (uncommitted changes; advisory only)" : "";
  return `${j.id} ${j.stage} @ ${short(j.sha)}${where}: ${j.state}${dirty}${extra}${j.url ? ` ${j.url}` : ""}`;
}

/** The notification a session gets for a job change, or undefined for routine ones. */
export function notificationFor(
  j: ValidationJob,
): { text: string; terminal: boolean; urgent: boolean } | undefined {
  const at = `${j.stage} at ${short(j.sha)}${j.backend ? ` on ${j.backend}` : ""}`;
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
