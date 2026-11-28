// Validation on paired fleet nodes (`ezcoder node serve`). A POOL backend:
// one machine per paired node, slots and load read live from GET /v1/info.
// Stages become node jobs of kind "validate" that clone the commit from
// GitHub on the node; a job the node reports `lost` (or a node unreachable
// for too long while running) is requeued through the pool's `lost` path.
import {
  clearNodeInfoCache,
  FleetClientError,
  getNodeInfo,
  listNodes,
  nodeClient,
} from "../fleet/client.js";
import { fleetInFlightByNode } from "../fleet/node-load.js";
import type { JobRequest, JobStatus, NodeInfo } from "../fleet/protocol.js";
import { defaultFleetDir } from "../fleet/store.js";
import type {
  BackendHealth,
  BackendPollResult,
  MachineInfo,
  Resources,
  ValidationBackend,
  ValidationJob,
} from "./types.js";

export interface NodeBackendConfig {
  kind: "node";
  /** Backend id (default "fleet"). */
  id?: string;
  /** Paired node names this backend uses (default: every paired node). */
  nodes?: string[];
  /** Static cap across the pool, used only when no node reports slots (default 4). */
  maxConcurrent?: number;
}

/** The slice of FleetClient a validation backend needs. */
export interface NodeJobClient {
  submitJob(req: JobRequest): Promise<JobStatus>;
  job(id: string): Promise<JobStatus>;
  jobLog(id: string, offset?: number): Promise<{ text: string; size: number }>;
  cancelJob(id: string, purge?: boolean): Promise<JobStatus>;
}

export interface NodeBackendDeps {
  listNodes(): Promise<{ name: string }[]>;
  client(name: string): Promise<NodeJobClient>;
  info(name: string): Promise<NodeInfo>;
  /** Fleet jobs in flight per node (shared slot accounting with the fleet scheduler). */
  fleetInFlight(): Promise<Map<string, number>>;
}

const defaultDeps: NodeBackendDeps = {
  listNodes: () => listNodes(),
  client: (name) => nodeClient(name),
  info: (name) => getNodeInfo(name),
  fleetInFlight: () => fleetInFlightByNode(defaultFleetDir()),
};

/** A running job's node unreachable this long counts as lost (fleet design: 3 min). */
export const NODE_UNREACHABLE_LOST_MS = 3 * 60_000;
const FAILED_LOG_TAIL_LINES = 200;

const PLATFORM_LABELS: Record<NodeInfo["platform"], string[]> = {
  linux: ["linux"],
  wsl2: ["linux", "wsl2"],
  macos: ["macos"],
  windows: ["windows"],
};

/** The commit lives on GitHub; the node clones it with its own credentials. */
export function githubCloneUrl(repo: string): string {
  return `https://github.com/${repo.replace(/\.git$/, "")}.git`;
}

export class NodeBackend implements ValidationBackend {
  readonly id: string;
  readonly kind = "node";
  readonly runs = "remote" as const;
  readonly maxConcurrent: number;
  private readonly deps: NodeBackendDeps;
  /** First time each running job's node did not answer. */
  private readonly unreachableSince = new Map<string, number>();

  constructor(
    private readonly cfg: NodeBackendConfig,
    deps: Partial<NodeBackendDeps> = {},
    private readonly unreachableLostMs = NODE_UNREACHABLE_LOST_MS,
  ) {
    this.id = cfg.id ?? "fleet";
    this.maxConcurrent = Math.max(1, cfg.maxConcurrent ?? 4);
    this.deps = { ...defaultDeps, ...deps };
  }

  private async nodeNames(): Promise<string[]> {
    const paired = (await this.deps.listNodes()).map((n) => n.name);
    return this.cfg.nodes ? paired.filter((n) => this.cfg.nodes!.includes(n)) : paired;
  }

  readonly machines = async (): Promise<MachineInfo[]> => {
    const names = await this.nodeNames();
    const fleet = await this.deps.fleetInFlight().catch(() => new Map<string, number>());
    return Promise.all(
      names.map(async (name): Promise<MachineInfo> => {
        try {
          const info = await this.deps.info(name);
          const labels = [...new Set(["node", ...info.labels, ...(info.docker ? ["docker"] : [])])];
          return {
            name,
            online: true,
            slots: info.slots,
            busy: info.slotsUsed,
            externalInFlight: fleet.get(name) ?? 0,
            platform: PLATFORM_LABELS[info.platform] ?? [info.platform],
            capacity: { cpus: info.cpus, memoryGb: info.memoryGb, labels },
            runsOn: [],
            detail:
              `${info.platform} ${info.arch}, ${info.cpus} cpus, ${Math.round(info.memoryGb)} GB, ` +
              `${info.slotsUsed}/${info.slots} slots busy, load ${info.load.toFixed(2)}`,
          };
        } catch (e) {
          return {
            name,
            online: false,
            slots: 0,
            busy: 0,
            platform: [],
            runsOn: [],
            assumed: true,
            detail: e instanceof Error ? e.message : String(e),
          };
        }
      }),
    );
  };

  /** Node the job was placed on (the scheduler sets `machine`); else the only one. */
  private async nodeFor(job: ValidationJob): Promise<string> {
    if (job.machine) return job.machine;
    const names = await this.nodeNames();
    if (names.length === 1) return names[0]!;
    throw new Error(
      names.length ? "job has no machine; the scheduler should place it" : "no paired fleet nodes",
    );
  }

  async dispatch(job: ValidationJob): Promise<{ runId?: string; url?: string }> {
    if (!job.repo) {
      throw new Error("project has no GitHub repo (origin remote); nodes clone the commit from it");
    }
    const node = await this.nodeFor(job);
    const resources: Resources | undefined = job.resources;
    const req: JobRequest = {
      id: job.id,
      kind: "validate",
      project: job.repo,
      source: { git: githubCloneUrl(job.repo), sha: job.sha },
      command: job.command,
      timeoutMinutes: job.timeoutMinutes,
      ...(resources && { resources }),
    };
    const client = await this.deps.client(node);
    await client.submitJob(req);
    // Slots changed: don't place the next job on stale info.
    clearNodeInfoCache(node);
    return { runId: `${node}:${job.id}` };
  }

  async poll(job: ValidationJob): Promise<BackendPollResult> {
    const node = await this.nodeFor(job);
    let status: JobStatus;
    try {
      status = await (await this.deps.client(node)).job(job.id);
    } catch (e) {
      if (e instanceof FleetClientError && e.code === "not_found") {
        this.unreachableSince.delete(job.id);
        return { state: "error", lost: `node ${node} no longer knows this job` };
      }
      const unreachable =
        e instanceof FleetClientError ? e.code === "unreachable" || e.code === "timeout" : true;
      if (!unreachable) throw e;
      const since = this.unreachableSince.get(job.id) ?? Date.now();
      this.unreachableSince.set(job.id, since);
      if (Date.now() - since > this.unreachableLostMs) {
        this.unreachableSince.delete(job.id);
        return {
          state: "error",
          lost: `node ${node} unreachable for over ${Math.round(this.unreachableLostMs / 60_000)} min`,
        };
      }
      throw e; // transient: the service retries next tick
    }
    this.unreachableSince.delete(job.id);
    const summary = status.summary;
    switch (status.state) {
      case "preparing":
        return { state: "waiting", ...(summary && { summary }) };
      case "running":
        return { state: "running" };
      case "passed":
        return { state: "passed", ...(summary && { summary }) };
      case "failed":
        return {
          state: "failed",
          summary: summary ?? `exit code ${status.exitCode ?? "?"}`,
        };
      case "cancelled":
        return { state: "cancelled", ...(summary && { summary }) };
      case "lost":
        return { state: "error", lost: `node ${node} restarted and lost the run` };
      case "error":
      default:
        return { state: "error", summary: summary ?? `node ${node} reported an error` };
    }
  }

  async logs(job: ValidationJob, failedOnly: boolean): Promise<string> {
    const node = await this.nodeFor(job);
    const { text } = await (await this.deps.client(node)).jobLog(job.id, 0);
    if (!failedOnly) return text;
    const lines = text.split("\n");
    return lines.slice(-FAILED_LOG_TAIL_LINES).join("\n");
  }

  async cancel(job: ValidationJob): Promise<void> {
    const node = await this.nodeFor(job);
    await (await this.deps.client(node)).cancelJob(job.id);
  }

  async health(): Promise<BackendHealth> {
    const machines = await this.machines();
    if (machines.length === 0) {
      return { online: false, detail: "no paired fleet nodes (ezcoder fleet add)" };
    }
    const online = machines.filter((m) => m.online);
    return {
      online: online.length > 0,
      busy: online.length > 0 && online.every((m) => m.busy >= m.slots),
      detail:
        `${online.length}/${machines.length} nodes online` +
        (online.length
          ? `: ${online.map((m) => `${m.name} ${m.busy}/${m.slots}`).join(", ")}`
          : ""),
    };
  }
}
