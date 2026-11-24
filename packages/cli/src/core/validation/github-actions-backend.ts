// GitHub Actions as an execution backend: a workflow_dispatch workflow on a
// worker repo (self-hosted or GitHub-hosted runners) checks out the project at
// an exact commit and runs the stage command. GitHub keeps the queue, the logs
// and the run history; we only dispatch, poll and read.
//
// With `discover: true` the backend is a POOL: its machines are the repo's
// self-hosted runners (label `ezcoder-docker`) grouped by their `ezw-<machine>`
// label, each declaring resources with `ez-cpu-N` / `ez-mem-GB` / `ez-slots-N`.
// Runs are pinned to a machine with the workflow's `runs_on` input; an optional
// `cloud` entry adds GitHub-hosted runners.
import { cacheKeyFor } from "./config.js";
import type {
  BackendHealth,
  BackendPollResult,
  Exec,
  MachineInfo,
  Resources,
  ValidationBackend,
  ValidationJob,
} from "./types.js";

/** GitHub-hosted runners added to a pool. Off unless `enabled` (it costs Actions minutes). */
export interface CloudConfig {
  enabled?: boolean;
  /** `runs_on` for cloud runs (default ["ubuntu-latest"]). */
  runsOn?: string[];
  /** Concurrent cloud runs (default 2). */
  maxConcurrent?: number;
  /** What a cloud runner offers (default 4 CPUs, 16 GB). */
  capacity?: Resources;
  /** "overflow" (default): only when no self-hosted machine is online. "always": a normal machine. */
  when?: "overflow" | "always";
}

export interface GitHubActionsBackendConfig {
  id: string;
  kind: "github-actions";
  /** Repo holding the workflow, e.g. you/test-worker. */
  repo: string;
  workflow: string;
  /** Branch of the worker repo to run the workflow from (default: its default branch). */
  workflowRef?: string;
  maxConcurrent?: number;
  capacity?: Resources;
  /** Runner labels used for the health check (all must match). */
  labels?: string[];
  /** Read the machines from the repo's runners (a pool). */
  discover?: boolean;
  /** Pools only: GitHub-hosted runners for overflow. */
  cloud?: CloudConfig;
}

/** The label every runner that takes EZCODER jobs carries. */
export const WORKER_LABEL = "ezcoder-docker";
export const CLOUD_MACHINE = "cloud";
const PLATFORMS = ["linux", "wsl2", "macos", "windows"];
const DISCOVERY_TTL_MS = 30_000;

export interface GhRunner {
  id?: number;
  name: string;
  status: string;
  busy: boolean;
  labels: { name: string }[];
}

/** Values from a JSON stream: `gh api --paginate` prints one document per page, back to back. */
export function parseJsonStream(text: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") {
      if (depth++ === 0) start = i;
    } else if ((c === "}" || c === "]") && depth > 0 && --depth === 0) {
      out.push(JSON.parse(text.slice(start, i + 1)));
    }
  }
  return out;
}

/** Runners from `gh api --paginate repos/<repo>/actions/runners` output. */
export function parseRunners(text: string): GhRunner[] {
  const runners: GhRunner[] = [];
  for (const doc of parseJsonStream(text)) {
    const list = Array.isArray(doc) ? doc : (doc as { runners?: unknown[] }).runners;
    for (const r of list ?? []) {
      const x = r as Partial<GhRunner>;
      if (typeof x?.name === "string" && Array.isArray(x.labels)) runners.push(x as GhRunner);
    }
  }
  return runners;
}

function labelNum(labels: string[], prefix: string): number | undefined {
  let best: number | undefined;
  for (const l of labels) {
    if (!l.startsWith(prefix)) continue;
    const n = Number(l.slice(prefix.length));
    if (Number.isFinite(n) && n > 0) best = Math.max(best ?? 0, n);
  }
  return best;
}

function cloudPlatform(runsOn: string[]): string[] {
  const s = runsOn.join(" ").toLowerCase();
  return s.includes("windows") ? ["windows"] : s.includes("macos") ? ["macos"] : ["linux"];
}

/** Group a pool's runners into machines by their `ezw-` label and read their resource labels. */
export function machinesFromRunners(
  runners: GhRunner[],
  cfg: GitHubActionsBackendConfig,
): MachineInfo[] {
  const want = [WORKER_LABEL, ...(cfg.labels ?? [])].map((l) => l.toLowerCase());
  const groups = new Map<string, { labelled: boolean; runners: GhRunner[] }>();
  for (const r of runners) {
    const labels = r.labels.map((l) => l.name.toLowerCase());
    if (!want.every((w) => labels.includes(w))) continue;
    const ezw = labels.find((l) => l.startsWith("ezw-") && l.length > 4);
    const name = ezw ? ezw.slice(4) : cfg.id;
    const g = groups.get(name) ?? { labelled: !!ezw, runners: [] };
    g.runners.push(r);
    groups.set(name, g);
  }
  const machines: MachineInfo[] = [];
  for (const [name, g] of groups) {
    const labels = [
      ...new Set(g.runners.flatMap((r) => r.labels.map((l) => l.name.toLowerCase()))),
    ];
    const online = g.runners.filter((r) => r.status === "online");
    const busy = online.filter((r) => r.busy).length;
    const cpus = labelNum(labels, "ez-cpu-") ?? cfg.capacity?.cpus;
    const memoryGb = labelNum(labels, "ez-mem-") ?? cfg.capacity?.memoryGb;
    const staticSlots = g.labelled ? undefined : cfg.maxConcurrent;
    const slots =
      labelNum(labels, "ez-slots-") ??
      (staticSlots ? Math.min(staticSlots, online.length) : online.length);
    machines.push({
      name,
      online: online.length > 0,
      slots,
      busy,
      platform: PLATFORMS.filter((p) => labels.includes(p)),
      capacity: {
        ...(cpus ? { cpus } : {}),
        ...(memoryGb ? { memoryGb } : {}),
        labels: [...new Set([...labels, ...(cfg.capacity?.labels ?? [])])],
      },
      runsOn: g.labelled
        ? ["self-hosted", WORKER_LABEL, `ezw-${name}`]
        : cfg.labels?.length
          ? cfg.labels
          : ["self-hosted", WORKER_LABEL],
      detail: g.runners
        .map((r) => `${r.name}: ${r.status}${r.status === "online" && r.busy ? " (busy)" : ""}`)
        .join(", "),
    });
  }
  return machines;
}

/** The pool's cloud machine, when enabled. */
export function cloudMachine(cfg: GitHubActionsBackendConfig): MachineInfo | undefined {
  const c = cfg.cloud;
  if (!cfg.discover || !c?.enabled) return undefined;
  const runsOn = c.runsOn?.length ? c.runsOn : ["ubuntu-latest"];
  const platform = cloudPlatform(runsOn);
  return {
    name: CLOUD_MACHINE,
    online: true,
    cloud: true,
    overflowOnly: c.when !== "always",
    slots: Math.max(1, c.maxConcurrent ?? 2),
    busy: 0,
    platform,
    capacity: {
      cpus: c.capacity?.cpus ?? 4,
      memoryGb: c.capacity?.memoryGb ?? 16,
      labels: [...platform, "cloud", ...(c.capacity?.labels ?? [])],
    },
    runsOn,
    detail: `GitHub-hosted ${runsOn.join(",")} (${c.when === "always" ? "always" : "overflow only"})`,
  };
}

const BILLING_BLOCKED =
  /actions budget|spending limit|billing|payment|account is locked|minutes? (?:quota|limit)|budget is preventing/i;
export const BILLING_SUMMARY = "GitHub Actions budget/billing blocks cloud runners";

const RUNNER_LOST =
  /lost communication with the server|runner has received a shutdown signal|runner.{0,80}(?:went offline|is offline|was lost|lost)|did not connect|never came online|shutdown signal/i;

const LOG_TAIL_BYTES = 24_000;

function tail(text: string, bytes = LOG_TAIL_BYTES): string {
  return text.length <= bytes ? text : `…\n${text.slice(-bytes)}`;
}

export class GitHubActionsBackend implements ValidationBackend {
  readonly kind = "github-actions";
  readonly runs = "remote" as const;
  readonly id: string;
  readonly maxConcurrent: number;
  readonly capacity?: Resources;
  readonly machines?: () => Promise<MachineInfo[]>;
  private cache: { at: number; machines: MachineInfo[] } | undefined;
  private readonly ttlMs: number;

  constructor(
    private readonly cfg: GitHubActionsBackendConfig,
    private readonly exec: Exec,
    opts: { discoveryTtlMs?: number } = {},
  ) {
    this.id = cfg.id;
    this.ttlMs = opts.discoveryTtlMs ?? DISCOVERY_TTL_MS;
    if (cfg.discover) this.machines = () => this.discover();
    this.maxConcurrent = Math.max(1, cfg.maxConcurrent ?? 1);
    this.capacity = cfg.capacity
      ? { ...cfg.capacity, labels: cfg.capacity.labels ?? cfg.labels }
      : cfg.labels
        ? { labels: cfg.labels }
        : undefined;
  }

  private gh(args: string[], timeoutMs = 60_000) {
    return this.exec("gh", args, { timeoutMs });
  }

  /** The pool's machines, read from the runner list at most every ~30 s. */
  private async discover(): Promise<MachineInfo[]> {
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.machines;
    const r = await this.gh(
      ["api", "--paginate", `repos/${this.cfg.repo}/actions/runners?per_page=100`],
      30_000,
    );
    let machines: MachineInfo[] | undefined;
    if (r.code === 0) {
      try {
        machines = machinesFromRunners(parseRunners(r.stdout), this.cfg);
      } catch {
        machines = undefined;
      }
    }
    // Runner list unreadable: behave like a static backend.
    machines ??= [
      {
        name: this.cfg.id,
        online: true,
        assumed: true,
        slots: this.maxConcurrent,
        busy: 0,
        platform: [],
        ...(this.capacity ? { capacity: this.capacity } : {}),
        runsOn: this.cfg.labels?.length ? this.cfg.labels : ["self-hosted", WORKER_LABEL],
        detail: "runner list not readable; static capacity assumed",
      },
    ];
    const cloud = cloudMachine(this.cfg);
    if (cloud) machines.push(cloud);
    this.cache = { at: Date.now(), machines };
    return machines;
  }

  private runsOnFor(machine: string | undefined): string[] {
    const known = this.cache?.machines.find((m) => m.name === machine);
    if (known) return known.runsOn;
    if (machine === CLOUD_MACHINE && this.cfg.cloud?.enabled) return cloudMachine(this.cfg)!.runsOn;
    if (machine && machine !== this.cfg.id) return ["self-hosted", WORKER_LABEL, `ezw-${machine}`];
    return this.cfg.labels?.length ? this.cfg.labels : ["self-hosted", WORKER_LABEL];
  }

  async dispatch(job: ValidationJob): Promise<{ runId?: string; url?: string }> {
    if (!job.repo) throw new Error("project has no GitHub repo");
    const args = [
      "workflow",
      "run",
      this.cfg.workflow,
      "-R",
      this.cfg.repo,
      ...(this.cfg.workflowRef ? ["--ref", this.cfg.workflowRef] : []),
      "-f",
      `ref=${job.sha}`,
      "-f",
      `command=${job.command}`,
      "-f",
      `timeout_minutes=${job.timeoutMinutes}`,
      "-f",
      `job_id=${job.id}`,
    ];
    // Testing the worker repo itself needs no cross-repo token.
    if (job.repo.toLowerCase() !== this.cfg.repo.toLowerCase()) args.push("-f", `repo=${job.repo}`);
    if (job.statusContext) args.push("-f", `status_context=${job.statusContext}`);
    // Pools pin the machine; plain backends keep the workflow's old inputs untouched.
    if (this.cfg.discover) {
      args.push(
        "-f",
        `runs_on=${JSON.stringify(this.runsOnFor(job.machine))}`,
        "-f",
        `cache_key=${cacheKeyFor(job.repo)}`,
      );
    }
    const r = await this.gh(args);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || "gh workflow run failed");
    const m = `${r.stdout}\n${r.stderr}`.match(/https:\/\/\S+\/actions\/runs\/(\d+)/);
    if (m) return { runId: m[1], url: m[0] };
    return (await this.findRun(job.id)) ?? {};
  }

  /** Older gh prints no run URL; the run name carries the job id instead. */
  private async findRun(jobId: string): Promise<{ runId: string; url: string } | undefined> {
    const r = await this.gh([
      "run",
      "list",
      "-R",
      this.cfg.repo,
      "-w",
      this.cfg.workflow,
      "-L",
      "30",
      "--json",
      "databaseId,displayTitle,url",
    ]);
    if (r.code !== 0) return undefined;
    try {
      const runs = JSON.parse(r.stdout) as {
        databaseId: number;
        displayTitle: string;
        url: string;
      }[];
      const hit = runs.find((x) => x.displayTitle.split(/\s+/).includes(jobId));
      return hit ? { runId: String(hit.databaseId), url: hit.url } : undefined;
    } catch {
      return undefined;
    }
  }

  async poll(job: ValidationJob): Promise<BackendPollResult> {
    let runId = job.runId;
    let url = job.url;
    if (!runId) {
      const found = await this.findRun(job.id);
      if (!found) {
        const age = Date.now() - Date.parse(job.dispatchedAt ?? job.updatedAt);
        return age > 10 * 60_000
          ? { state: "error", summary: "the dispatched run never appeared on GitHub" }
          : { state: "waiting" };
      }
      runId = found.runId;
      url = found.url;
    }
    const r = await this.gh([
      "run",
      "view",
      runId,
      "-R",
      this.cfg.repo,
      "--json",
      "status,conclusion,url,jobs",
    ]);
    if (r.code !== 0) {
      const msg = (r.stderr || r.stdout).trim();
      if (/HTTP 404|not found/i.test(msg)) {
        const why = "the run vanished on GitHub";
        return { state: "error", url, summary: why, lost: why };
      }
      throw new Error(msg || "gh run view failed");
    }
    const v = JSON.parse(r.stdout) as {
      status: string;
      conclusion: string;
      url: string;
      jobs?: {
        databaseId?: number;
        steps?: { name: string; conclusion: string; status: string }[];
      }[];
    };
    url = v.url || url;
    const steps = v.jobs?.flatMap((j) => j.steps ?? []) ?? [];
    if (v.status !== "completed") {
      // Running only once a step past runner setup has started.
      const started = steps.some((s) => s.status !== "queued" && s.status !== "pending");
      return { state: started ? "running" : "waiting", url };
    }
    const failedStep = steps.find((s) => s.conclusion === "failure");
    const testStep = steps.find((s) => /run test command/i.test(s.name));
    const testFinished =
      testStep?.status === "completed" &&
      (testStep.conclusion === "success" || testStep.conclusion === "failure");
    if ((v.conclusion === "failure" || v.conclusion === "cancelled") && !testFinished) {
      const notes = await this.annotations(v.jobs ?? []);
      // GitHub never started the job: budget, billing or spending limit. Not a code failure.
      const billing = notes.find((n) => BILLING_BLOCKED.test(n));
      if (billing) {
        return {
          state: "error",
          url,
          summary: `${BILLING_SUMMARY}: ${billing}`.slice(0, 300),
          blocked: billing,
        };
      }
      // The test command never finished: a lost runner, unless a setup step failed on its own.
      // A job with zero steps never started at all: an infra error too.
      const note = notes.find((n) => RUNNER_LOST.test(n));
      const nonTestFailure = failedStep && !/run test command/i.test(failedStep.name);
      if (note || !nonTestFailure) {
        const why = note ?? `the run was ${v.conclusion} before the test command finished`;
        return { state: "error", url, summary: `runner lost: ${why}`.slice(0, 300), lost: why };
      }
    }
    switch (v.conclusion) {
      case "success":
        return { state: "passed", url };
      case "cancelled":
        return { state: "cancelled", url, summary: "cancelled on GitHub" };
      case "timed_out":
        return { state: "failed", url, summary: "timed out" };
      case "failure":
        // A failure before or outside the test command is the worker's problem, not the code's.
        if (failedStep && !/run test command/i.test(failedStep.name)) {
          return { state: "error", url, summary: `worker step failed: ${failedStep.name}` };
        }
        return { state: "failed", url, summary: "test command failed" };
      default:
        return { state: "error", url, summary: `run ended: ${v.conclusion || "unknown"}` };
    }
  }

  /** First lines of the run's job annotations (one call per job, at most three jobs). */
  private async annotations(jobs: { databaseId?: number }[]): Promise<string[]> {
    const out: string[] = [];
    for (const j of jobs.slice(0, 3)) {
      if (!j.databaseId) continue;
      const r = await this.gh(
        ["api", `repos/${this.cfg.repo}/check-runs/${j.databaseId}/annotations`],
        30_000,
      ).catch(() => undefined);
      if (!r || r.code !== 0) continue;
      try {
        const notes = JSON.parse(r.stdout) as { message?: string }[];
        for (const n of Array.isArray(notes) ? notes : []) {
          if (typeof n.message === "string" && n.message.trim()) {
            out.push(n.message.trim().split("\n")[0]!.slice(0, 200));
          }
        }
      } catch {
        // not annotations
      }
    }
    return out;
  }

  async logs(job: ValidationJob, failedOnly: boolean): Promise<string> {
    if (!job.runId) return "No GitHub run yet.";
    const r = await this.gh(
      ["run", "view", job.runId, "-R", this.cfg.repo, failedOnly ? "--log-failed" : "--log"],
      120_000,
    );
    if (r.code !== 0) return `Could not read logs: ${(r.stderr || r.stdout).trim()}`;
    // Lines are "job\tstep\ttimestamp text"; keep the text.
    const text = r.stdout
      .split("\n")
      .map((l) =>
        l
          .split("\t")
          .slice(2)
          .join("\t")
          .replace(/^\S+Z /, ""),
      )
      .join("\n");
    return tail(text || "(empty log)");
  }

  async cancel(job: ValidationJob): Promise<void> {
    if (!job.runId) return;
    await this.gh(["run", "cancel", job.runId, "-R", this.cfg.repo]);
  }

  async health(): Promise<BackendHealth> {
    const r = await this.gh(["api", `repos/${this.cfg.repo}/actions/runners`], 30_000);
    if (r.code !== 0) {
      // No admin access to list runners: GitHub-hosted or someone else's repo.
      return { online: true, detail: "runner list not readable; assuming GitHub queues jobs" };
    }
    try {
      const want = (this.cfg.labels ?? []).map((l) => l.toLowerCase());
      const runners = (
        JSON.parse(r.stdout) as {
          runners: { name: string; status: string; busy: boolean; labels: { name: string }[] }[];
        }
      ).runners.filter((x) => want.every((l) => x.labels.some((y) => y.name.toLowerCase() === l)));
      if (runners.length === 0) return { online: false, detail: "no matching runner registered" };
      const online = runners.filter((x) => x.status === "online");
      const busy = online.length > 0 && online.every((x) => x.busy);
      return {
        online: online.length > 0,
        busy,
        detail: runners.map((x) => `${x.name}: ${x.status}${x.busy ? " (busy)" : ""}`).join(", "),
      };
    } catch {
      return { online: true, detail: "unreadable runner list" };
    }
  }
}
