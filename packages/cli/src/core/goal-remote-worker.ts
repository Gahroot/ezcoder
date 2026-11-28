// GL1/GL3: a Goal worker task run on a fleet node. It uses the same start path
// and slot accounting as every other remote agent (SubAgentManager +
// RemoteWorkerProcess: queue while nodes are full, one patch per turn), so
// there is no separate pool. Edits come home one patch at a time per project
// folder (the remote-agent repo lock); a patch that doesn't apply fails the
// task, names the conflicting files and is saved in the goal folder (R2).
import { copyFile, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Provider } from "@prestyj/ai";
import {
  RemoteWorkerProcess,
  type RemoteSyncEvent,
  type RemoteWorkerSpawn,
} from "./fleet/remote-agent.js";
import { probeNode, type FleetNodeEntry } from "./fleet/remote-agent-nodes.js";
import { goalNodeProtocolProblem } from "./goal-fleet.js";
import { projectDir } from "./goal-store.js";
import { SubAgentManager, type RemoteWorkerHandle } from "./subagent-manager.js";
import { SubAgentStore } from "./subagent-store.js";

/** Test seams for the fleet side of a remote Goal worker. */
export interface GoalWorkerFleetOptions {
  nodesFile?: string;
  queuePollMs?: number;
  reconnectWindowMs?: number;
  /** Cap on a node's Retry-After, ms (tests). */
  maxRetryAfterMs?: number;
  /** Told once when the worker waits for a free node slot. */
  onQueued?: (reason: string) => void;
  /** Override the remote worker factory (tests). */
  createRemoteWorker?: (spawn: RemoteWorkerSpawn) => RemoteWorkerHandle;
}

export interface RemoteGoalWorkerOutcome {
  status: "done" | "failed";
  summary: string;
  exitCode: number;
  /** Node it ran on (D4). */
  node?: string;
  /** Patch saved in the goal folder when edits could not be applied (GL3). */
  keptPatch?: string;
  conflictFiles?: string[];
  toolUses: number;
}

export interface RemoteGoalWorkerRun {
  done: Promise<RemoteGoalWorkerOutcome>;
  stop(): Promise<void>;
}

const TERMINAL = new Set(["completed", "failed", "interrupted", "closed", "reaped"]);

/** S3 for Goals: refuse a node whose protocol can't take the work, before anything is sent. */
async function vetProtocol(node: FleetNodeEntry): Promise<void> {
  const problem = goalNodeProtocolProblem(node.name, await probeNode(node));
  if (problem) throw new Error(problem);
}

export function startRemoteGoalWorker(options: {
  workerId: string;
  cwd: string;
  goalRunId: string;
  goalTaskId: string;
  machine: string;
  provider: Provider;
  model: string;
  /** System prompt + task prompt, sent as the worker's brief. */
  brief: string;
  timeoutMs: number;
  fleet?: GoalWorkerFleetOptions;
  onNode?: (node: string) => void;
  onActivity?: (activity: string) => void;
}): RemoteGoalWorkerRun {
  const dir = join(projectDir(options.cwd), "workers", options.workerId);
  const syncs: RemoteSyncEvent[] = [];
  const fleet = options.fleet ?? {};
  const manager = new SubAgentManager({
    cwd: options.cwd,
    agents: [],
    getProvider: () => options.provider,
    getModel: () => options.model,
    subAgentDepth: 0,
    store: new SubAgentStore(join(dir, "subagents")),
    sessionRootDir: join(dir, "sessions"),
    remoteStateDir: join(dir, "remote"),
    onState: (snapshot) => {
      if (snapshot.machine && snapshot.machine !== "auto") options.onNode?.(snapshot.machine);
      if (snapshot.current_activity) options.onActivity?.(snapshot.current_activity);
    },
    createRemoteWorker: (spawn) => {
      const full: RemoteWorkerSpawn = {
        ...spawn,
        ...(fleet.nodesFile && { nodesFile: fleet.nodesFile }),
        ...(fleet.queuePollMs !== undefined && { queuePollMs: fleet.queuePollMs }),
        ...(fleet.reconnectWindowMs !== undefined && {
          reconnectWindowMs: fleet.reconnectWindowMs,
        }),
        ...(fleet.maxRetryAfterMs !== undefined && { maxRetryAfterMs: fleet.maxRetryAfterMs }),
        ...(fleet.onQueued && { onQueued: fleet.onQueued }),
        vetNode: vetProtocol,
        onSync: (event) => syncs.push(event),
      };
      return fleet.createRemoteWorker
        ? fleet.createRemoteWorker(full)
        : (new RemoteWorkerProcess(full) as unknown as RemoteWorkerHandle);
    },
  });

  let stopped = false;
  let timedOut = false;
  const timer =
    options.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          void manager.shutdownAll();
        }, options.timeoutMs)
      : undefined;
  timer?.unref?.();

  const keepPatch = async (source: string): Promise<string> => {
    const patchesDir = join(projectDir(options.cwd), "patches");
    await mkdir(patchesDir, { recursive: true });
    const target = join(
      patchesDir,
      `${options.goalRunId.slice(0, 8)}-${options.goalTaskId.slice(0, 8)}-${options.workerId}-${basename(source)}`,
    );
    await copyFile(source, target);
    return target;
  };

  const done = (async (): Promise<RemoteGoalWorkerOutcome> => {
    let node: string | undefined;
    try {
      const spawned = await manager.spawn(`goal-${options.workerId}`, options.brief, undefined, {
        machine: options.machine,
      });
      let snapshot = spawned;
      while (!TERMINAL.has(snapshot.state)) {
        const waited = await manager.wait([spawned.agent_id], "all");
        snapshot = waited.agents[0] ?? snapshot;
      }
      node = snapshot.machine && snapshot.machine !== "auto" ? snapshot.machine : undefined;
      // Close it: the final sync runs and the node frees its slot.
      await manager.shutdownAll();
      const conflict = syncs.find((event) => event.result && !event.result.applied);
      const lostSync = syncs.find((event) => event.error);
      const keptSource = conflict?.result?.conflictPatch ?? lostSync?.keptPath;
      const keptPatch = keptSource ? await keepPatch(keptSource) : undefined;
      const notes = syncs
        .map((event) => event.result?.note ?? event.error)
        .filter((note): note is string => !!note);
      const output = (snapshot.output ?? snapshot.error ?? "").trim();
      if (conflict?.result) {
        const files = conflict.result.conflictFiles ?? conflict.result.files;
        return {
          status: "failed",
          exitCode: 1,
          node,
          keptPatch,
          conflictFiles: files,
          toolUses: snapshot.tool_use_count,
          summary:
            `Edits from ${conflict.node} conflict with this folder in: ${files.join(", ")}. ` +
            `None of this worker's edits were applied; its patch is saved at ${keptPatch}. ` +
            `Apply by hand with: git apply --3way --binary "${keptPatch}"` +
            (output ? `\n\nWorker report:\n${output}` : ""),
        };
      }
      if (lostSync) {
        return {
          status: "failed",
          exitCode: 1,
          node,
          ...(keptPatch && { keptPatch }),
          toolUses: snapshot.tool_use_count,
          summary:
            `${lostSync.error}${keptPatch ? ` Saved in the goal folder at ${keptPatch}.` : ""}` +
            (output ? `\n\nWorker report:\n${output}` : ""),
        };
      }
      const ok = !timedOut && !stopped && snapshot.state === "completed";
      return {
        status: ok ? "done" : "failed",
        exitCode: timedOut ? 124 : ok ? 0 : 1,
        node,
        toolUses: snapshot.tool_use_count,
        summary: timedOut
          ? `Remote worker on ${node ?? options.machine} timed out after ${options.timeoutMs}ms and was stopped.`
          : [output || (ok ? "Worker completed." : "Worker failed."), ...notes].join("\n"),
      };
    } catch (error) {
      await manager.shutdownAll().catch(() => undefined);
      return {
        status: "failed",
        exitCode: 1,
        node,
        toolUses: 0,
        summary: `Remote Goal worker could not run on ${options.machine}: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  })();

  return {
    done,
    async stop() {
      stopped = true;
      await manager.shutdownAll();
    },
  };
}
