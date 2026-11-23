// GitHub Actions as an execution backend: a workflow_dispatch workflow on a
// worker repo (self-hosted or GitHub-hosted runners) checks out the project at
// an exact commit and runs the stage command. GitHub keeps the queue, the logs
// and the run history; we only dispatch, poll and read.
import type {
  BackendHealth,
  BackendPollResult,
  Exec,
  Resources,
  ValidationBackend,
  ValidationJob,
} from "./types.js";

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
}

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

  constructor(
    private readonly cfg: GitHubActionsBackendConfig,
    private readonly exec: Exec,
  ) {
    this.id = cfg.id;
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
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || "gh run view failed");
    const v = JSON.parse(r.stdout) as {
      status: string;
      conclusion: string;
      url: string;
      jobs?: { steps?: { name: string; conclusion: string; status: string }[] }[];
    };
    url = v.url || url;
    const steps = v.jobs?.flatMap((j) => j.steps ?? []) ?? [];
    if (v.status !== "completed") {
      // Running only once a step past runner setup has started.
      const started = steps.some((s) => s.status !== "queued" && s.status !== "pending");
      return { state: started ? "running" : "waiting", url };
    }
    const failedStep = steps.find((s) => s.conclusion === "failure");
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
