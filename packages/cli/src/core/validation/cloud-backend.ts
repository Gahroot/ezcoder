// Validation on cloud agent sandboxes (Claude Code cloud, Codex cloud) as
// auto-managed overflow capacity. A POOL backend: one machine per provider.
// The sandbox's model only relays one exact runner command (cloud/runner.ts);
// a stage passes or fails only on the harness's record of that command and
// its marker line, never on what the model says.
import fs from "node:fs/promises";
import path from "node:path";
import {
  cloudAllowedFor,
  providerSettings,
  readCloudSettings,
  readCloudState,
  type CloudSettings,
  type CloudState,
} from "../cloud/config.js";
import { cloudAvailability, cloudProvider } from "../cloud/registry.js";
import { runnerCommand, runnerPrompt, verifyRunnerResult } from "../cloud/runner.js";
import { commitSnapshot } from "../cloud/snapshot.js";
import {
  CLOUD_LABELS,
  CloudError,
  isCloudProviderId,
  type CloudAvailability,
  type CloudProvider,
  type CloudProviderId,
  type CloudTaskHandle,
} from "../cloud/types.js";
import { commandNeedsDocker } from "./scheduler.js";
import type {
  BackendHealth,
  BackendPollResult,
  MachineInfo,
  Resources,
  ValidationBackend,
  ValidationJob,
} from "./types.js";

export const CLOUD_BACKEND_ID = "cloud";
/**
 * What one cloud sandbox offers (Claude Code cloud: 4 vCPU, 16 GB). The
 * Docker CLI is there without a running daemon; the runner starts one
 * (`sudo dockerd`, ~5 s, measured live) for stages that use Docker.
 */
export const CLOUD_CAPACITY: Resources = {
  cpus: 4,
  memoryGb: 16,
  labels: ["linux", "cloud", "docker"],
};
/**
 * Providers whose harness records the exact command and its output, so a
 * result can be verified. Codex's work log keeps no such record: a Codex
 * "result" would be the model's word, so Codex never runs validation.
 */
export const VERIFIABLE_PROVIDERS: readonly CloudProviderId[] = ["claude-cloud"];
/** Tools a runner session may not use: it only runs one command. */
export const RUNNER_DISALLOWED_TOOLS = [
  "Edit",
  "Write",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Agent",
];
export const RUNNER_MAX_TURNS = 4;
export const UNTRUSTED_SUMMARY = "cloud agent did not run the exact command; result not trusted";
/** Prefix of a usage-limit `blocked` reason (the service names the bench after it). */
export const CLOUD_LIMIT_SUMMARY = "cloud plan usage limit reached";
/** Extra minutes past the stage timeout before a silent session counts as lost. */
const GRACE_MINUTES = 20;
const AVAILABILITY_TTL_MS = 60_000;
const FAILED_LOG_TAIL_LINES = 200;

export interface CloudBackendDeps {
  availability(): Promise<CloudAvailability[]>;
  provider(id: CloudProviderId): CloudProvider;
  settings(): CloudSettings;
  state(): CloudState;
  /** Tree of the tested commit (what the sandbox must reproduce). */
  tree(repoRoot: string, sha: string): Promise<string>;
  now(): number;
}

const defaultDeps: CloudBackendDeps = {
  availability: () => cloudAvailability("validation"),
  provider: (id) => cloudProvider(id),
  settings: () => readCloudSettings(),
  state: () => readCloudState(),
  tree: async (repoRoot, sha) => (await commitSnapshot(repoRoot, sha)).tree,
  now: () => Date.now(),
};

/** Is cloud validation on (zero config: yes unless turned off)? */
export function cloudValidationEnabled(settings: CloudSettings = readCloudSettings()): boolean {
  return cloudAllowedFor(settings, "validation");
}

/** Runner job id from a validation job id (letters, digits, - and _). */
export function cloudJobId(jobId: string): string {
  return jobId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "job";
}

/** The exact command a job's sandbox runs; rebuilt from job fields at poll time. */
export function cloudRunnerCommand(job: ValidationJob, tree: string): string {
  return runnerCommand({
    jobId: cloudJobId(job.id),
    tree,
    command: job.command,
    timeoutMinutes: job.timeoutMinutes,
    docker: commandNeedsDocker(job.command),
  });
}

interface RunRef {
  provider: CloudProviderId;
  session: string;
  tree: string;
}

/** runId = `<provider>:<session>:<tree>`. */
export function parseCloudRunId(runId: string | undefined): RunRef | undefined {
  const parts = (runId ?? "").split(":");
  if (parts.length !== 3) return undefined;
  const [provider, session, tree] = parts as [string, string, string];
  if (!isCloudProviderId(provider) || !session || !/^[0-9a-f]{40,64}$/.test(tree)) return undefined;
  return { provider, session, tree };
}

function lastLines(text: string, n: number): string {
  return text.split("\n").slice(-n).join("\n");
}

export class CloudValidationBackend implements ValidationBackend {
  readonly id = CLOUD_BACKEND_ID;
  readonly kind = "cloud";
  readonly runs = "remote" as const;
  readonly capacity = CLOUD_CAPACITY;
  private readonly deps: CloudBackendDeps;
  private availCache: { at: number; list: CloudAvailability[] } | undefined;
  /** Verified logs by job id (also written to the logs folder). */
  private readonly verifiedLogs = new Map<string, string>();

  constructor(
    /** Where verified logs are kept (`<validation dir>/logs`); none = memory only. */
    private readonly logsDir?: string,
    deps: Partial<CloudBackendDeps> = {},
  ) {
    this.deps = { ...defaultDeps, ...deps };
  }

  get maxConcurrent(): number {
    const s = this.deps.settings();
    return Math.max(
      1,
      ...(["claude-cloud", "codex-cloud"] as const).map(
        (id) => providerSettings(s, id).maxConcurrent,
      ),
    );
  }

  private async availability(): Promise<CloudAvailability[]> {
    const now = this.deps.now();
    if (this.availCache && now - this.availCache.at < AVAILABILITY_TTL_MS) {
      return this.availCache.list;
    }
    const list = await this.deps.availability().catch(() => [] as CloudAvailability[]);
    this.availCache = { at: now, list };
    return list;
  }

  private detailFor(a: CloudAvailability, state: CloudState): string {
    const parts = [`${CLOUD_LABELS[a.id]}: ${a.detail}`];
    const util = state.utilization?.[a.id];
    if (util) parts.push(`plan ${Math.round(util.value * 100)}% used this week`);
    if (a.limitedUntil && !a.detail.includes("paused until")) {
      parts.push(`paused until ${new Date(a.limitedUntil).toLocaleString()}`);
    }
    if (!a.available && a.setupHint) parts.push(`to enable: ${a.setupHint}`);
    const when = this.deps.settings().when ?? "overflow";
    parts.push(
      when === "overflow"
        ? "used when self-hosted workers are busy, full or offline"
        : when === "manual"
          ? "used only by stages pinned to it"
          : "used like any worker",
    );
    return parts.join("; ");
  }

  readonly machines = async (): Promise<MachineInfo[]> => {
    const settings = this.deps.settings();
    const when = settings.when ?? "overflow";
    const state = this.deps.state();
    const list = await this.availability();
    return list.map((a): MachineInfo => ({
      name: a.id,
      online: a.available && VERIFIABLE_PROVIDERS.includes(a.id),
      cloud: true,
      overflowOnly: when !== "always",
      ...(when === "overflow" && { spillover: true }),
      ...(when === "manual" && { manualOnly: true }),
      slots: providerSettings(settings, a.id).maxConcurrent,
      busy: 0,
      platform: ["linux"],
      capacity: CLOUD_CAPACITY,
      runsOn: [],
      detail: VERIFIABLE_PROVIDERS.includes(a.id)
        ? this.detailFor(a, state)
        : "not used for validation: its results can't be verified (no recorded command output)",
    }));
  };

  private async providerFor(job: ValidationJob): Promise<CloudProviderId> {
    if (job.machine) {
      if (!isCloudProviderId(job.machine)) throw new Error(`unknown cloud provider ${job.machine}`);
      if (!VERIFIABLE_PROVIDERS.includes(job.machine)) {
        throw new Error(`${job.machine} results can't be verified, so it never runs validation`);
      }
      return job.machine;
    }
    const first = (await this.availability()).find(
      (a) => a.available && VERIFIABLE_PROVIDERS.includes(a.id),
    );
    if (!first) throw new Error("no cloud provider available");
    return first.id;
  }

  async dispatch(job: ValidationJob): Promise<{ runId?: string; url?: string }> {
    if (job.run === "local") throw new Error("local stages never run in the cloud");
    const id = await this.providerFor(job);
    const tree = await this.deps.tree(job.project, job.sha);
    const command = cloudRunnerCommand(job, tree);
    let handle: CloudTaskHandle;
    try {
      handle = await this.deps.provider(id).start({
        title: `EZ validate ${job.stage} @ ${job.sha.slice(0, 8)}`,
        prompt: runnerPrompt(command, job.timeoutMinutes),
        source: {
          repoRoot: job.project,
          sha: job.sha,
          ...(job.repo && { repo: job.repo }),
          ...(job.branch && { branch: job.branch }),
        },
        maxTurns: RUNNER_MAX_TURNS,
        disallowedTools: RUNNER_DISALLOWED_TOOLS,
        commandTimeoutMinutes: job.timeoutMinutes,
        approveCommand: command,
        runner: true,
      });
    } catch (e) {
      if (e instanceof CloudError && e.code === "usage_limited") this.availCache = undefined;
      throw e;
    }
    if (handle.baseTree && handle.baseTree !== tree) {
      await this.deps
        .provider(id)
        .archive(handle)
        .catch(() => {});
      throw new Error(`cloud snapshot tree ${handle.baseTree} differs from ${tree}`);
    }
    return { runId: `${id}:${handle.id}:${tree}`, url: handle.url };
  }

  private handleOf(job: ValidationJob): { ref: RunRef; handle: CloudTaskHandle } {
    const ref = parseCloudRunId(job.runId);
    if (!ref) throw new Error(`job ${job.id} has no cloud session`);
    return {
      ref,
      handle: {
        provider: ref.provider,
        id: ref.session,
        url: job.url ?? "",
        baseTree: ref.tree,
        // Permission prompts may approve only this job's exact runner command.
        approveCommand: cloudRunnerCommand(job, ref.tree),
      },
    };
  }

  private async keepLog(job: ValidationJob, log: string): Promise<void> {
    this.verifiedLogs.set(job.id, log);
    if (!this.logsDir) return;
    await fs.mkdir(this.logsDir, { recursive: true });
    await fs.writeFile(this.logFile(job), log);
  }

  private logFile(job: ValidationJob): string {
    return path.join(this.logsDir!, `${cloudJobId(job.id)}.cloud.log`);
  }

  private async finish(provider: CloudProvider, handle: CloudTaskHandle): Promise<void> {
    await provider.archive(handle).catch(() => {});
  }

  async poll(job: ValidationJob): Promise<BackendPollResult> {
    const { ref, handle } = this.handleOf(job);
    const provider = this.deps.provider(ref.provider);
    const status = await provider.status(handle);
    const jobId = cloudJobId(job.id);
    const verified = verifyRunnerResult(status.commands, cloudRunnerCommand(job, ref.tree), jobId);
    const url = handle.url || undefined;

    if (verified) {
      await this.keepLog(job, verified.log).catch(() => {});
      await this.finish(provider, handle);
      if (verified.verdict === "wrong-tree") {
        return {
          state: "error",
          lost: `cloud sandbox had tree ${verified.tree ?? "?"}, not ${ref.tree}`,
        };
      }
      const secs = verified.seconds !== undefined ? ` after ${verified.seconds}s` : "";
      if (verified.verdict === "timeout") {
        return {
          state: "failed",
          summary: `timed out after ${job.timeoutMinutes} min (cloud, ${ref.provider})`,
        };
      }
      if (verified.exitCode === 0) {
        return { state: "passed", summary: `passed${secs} (cloud, ${ref.provider})` };
      }
      const tail = lastLines(verified.log.trim(), 3).replace(/\s*\n\s*/g, " | ");
      return {
        state: "failed",
        summary: `exit code ${verified.exitCode ?? "?"}${secs}${tail ? `: ${tail}` : ""}`.slice(
          0,
          400,
        ),
      };
    }

    if (status.usage?.limited) {
      this.availCache = undefined;
      await this.finish(provider, handle);
      const until = status.usage.resetsAt
        ? `; paused until ${new Date(status.usage.resetsAt).toLocaleString()}`
        : "";
      return { state: "error", blocked: `${CLOUD_LIMIT_SUMMARY} (${ref.provider})${until}` };
    }

    const overdue =
      job.dispatchedAt &&
      this.deps.now() - Date.parse(job.dispatchedAt) >
        (job.timeoutMinutes + GRACE_MINUTES) * 60_000;
    switch (status.state) {
      case "starting":
      case "running":
        if (overdue) {
          await provider.interrupt(handle).catch(() => {});
          await this.finish(provider, handle);
          return {
            state: "error",
            lost: `cloud session gave no result within ${job.timeoutMinutes + GRACE_MINUTES} min`,
          };
        }
        return status.state === "starting"
          ? { state: "waiting", summary: `starting a ${CLOUD_LABELS[ref.provider]} sandbox` }
          : { state: "running" };
      case "idle":
      case "failed":
      case "cancelled":
      default:
        await this.finish(provider, handle);
        return {
          state: "error",
          lost: status.error ? `${UNTRUSTED_SUMMARY} (${status.error})` : UNTRUSTED_SUMMARY,
          ...(url && { url }),
        };
    }
  }

  async logs(job: ValidationJob, failedOnly: boolean): Promise<string> {
    let text = this.verifiedLogs.get(job.id);
    if (text === undefined && this.logsDir) {
      text = await fs.readFile(this.logFile(job), "utf8").catch(() => undefined);
    }
    if (text === undefined && job.runId) {
      const { ref, handle } = this.handleOf(job);
      const status = await this.deps.provider(ref.provider).status(handle);
      const verified = verifyRunnerResult(
        status.commands,
        cloudRunnerCommand(job, ref.tree),
        cloudJobId(job.id),
      );
      text = verified
        ? verified.log
        : `No verified result from the cloud session (${job.url ?? ref.session}).`;
    }
    text ??= "Not dispatched yet.";
    return failedOnly ? lastLines(text, FAILED_LOG_TAIL_LINES) : text;
  }

  async cancel(job: ValidationJob): Promise<void> {
    if (!parseCloudRunId(job.runId)) return;
    const { ref, handle } = this.handleOf(job);
    const provider = this.deps.provider(ref.provider);
    await provider.interrupt(handle).catch(() => {});
    await provider.archive(handle);
  }

  async health(): Promise<BackendHealth> {
    const list = await this.availability();
    const up = list.filter((a) => a.available);
    return {
      online: up.length > 0,
      detail: list.length
        ? list
            .map(
              (a) => `${CLOUD_LABELS[a.id]} ${a.available ? "ready" : "unavailable"}: ${a.detail}`,
            )
            .join("; ")
        : "no cloud providers",
    };
  }
}
