// Node lookup for remote sub-agents (spawn_agent `machine`). Read-only view of
// the controller's paired nodes in ~/.ezcoder/fleet/nodes.json — the fleet
// registry owns that file and writes it; this module only reads it, so remote
// agents don't depend on the registry's internals.
import fs from "node:fs/promises";
import path from "node:path";
import { getAppPaths } from "@prestyj/core";
import type { NodeInfo } from "./protocol.js";

export interface FleetNodeEntry {
  name: string;
  /** Base URL, e.g. http://my-pc.tailnet.ts.net:7377 */
  url: string;
  token: string;
  labels?: string[];
}

export function fleetNodesFile(): string {
  return path.join(getAppPaths().agentDir, "fleet", "nodes.json");
}

/** Paired nodes; [] when the file is missing or unreadable. */
export async function readFleetNodes(file = fleetNodesFile()): Promise<FleetNodeEntry[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(file, "utf-8"));
  } catch {
    return [];
  }
  const nodes = (parsed as { nodes?: unknown })?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.filter(
    (node): node is FleetNodeEntry =>
      !!node &&
      typeof node.name === "string" &&
      typeof node.url === "string" &&
      typeof node.token === "string",
  );
}

export function nodeHeaders(node: FleetNodeEntry): Record<string, string> {
  return { authorization: `Bearer ${node.token}` };
}

export function nodeUrl(node: FleetNodeEntry, route: string): string {
  return `${node.url.replace(/\/+$/, "")}${route}`;
}

/** GET /v1/info; undefined when the node can't be reached or refuses. */
export async function probeNode(
  node: FleetNodeEntry,
  timeoutMs = 4_000,
): Promise<NodeInfo | undefined> {
  try {
    const res = await fetch(nodeUrl(node, "/v1/info"), {
      headers: nodeHeaders(node),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return undefined;
    return (await res.json()) as NodeInfo;
  } catch {
    return undefined;
  }
}

export interface ProbedNode {
  node: FleetNodeEntry;
  info?: NodeInfo;
}

/**
 * Starts this process has promised a node but the node hasn't counted yet
 * (between the probe and its POST /v1/agents answer). Concurrent "auto"
 * starts see each other here, so they spread instead of piling on one node.
 */
const pendingStarts = new Map<string, number>();

/** Slots this process has reserved on `name` and not yet released. */
export function pendingAgentStarts(name: string): number {
  return pendingStarts.get(name) ?? 0;
}

/** Reserve one start slot on a node; call the returned release exactly once. */
export function reserveAgentStart(name: string): () => void {
  pendingStarts.set(name, pendingAgentStarts(name) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = pendingAgentStarts(name) - 1;
    if (left > 0) pendingStarts.set(name, left);
    else pendingStarts.delete(name);
  };
}

/** Free slots after this process's pending starts. */
export function freeAgentSlots(probed: ProbedNode): number {
  const { info } = probed;
  if (!info) return 0;
  return info.slots - info.slotsUsed - pendingAgentStarts(probed.node.name);
}

/** Why a probed node can't take an agent now, or undefined when it can. */
export function agentNodeProblem(probed: ProbedNode): string | undefined {
  const { info } = probed;
  if (!info) return "unreachable";
  if (!info.modelAuth) return "no model credentials (run `ezcoder login` there, or share-auth)";
  if (freeAgentSlots(probed) <= 0) {
    const pending = pendingAgentStarts(probed.node.name);
    return `full (${info.slotsUsed}/${info.slots} slots${pending ? `, ${pending} starting` : ""})`;
  }
  return undefined;
}

/** The node would take an agent once a slot frees (its only problem is being full). */
export function agentNodeOnlyFull(probed: ProbedNode): boolean {
  return !!probed.info && probed.info.modelAuth && freeAgentSlots(probed) <= 0;
}

/** `auto`: a node with model credentials and a free slot; most free slots first, then least loaded. */
export function pickAutoNode(probed: readonly ProbedNode[]): ProbedNode | undefined {
  return probed
    .filter((candidate) => agentNodeProblem(candidate) === undefined)
    .sort(
      (a, b) =>
        freeAgentSlots(b) - freeAgentSlots(a) ||
        a.info!.load - b.info!.load ||
        a.node.name.localeCompare(b.node.name),
    )[0];
}

export interface SelectAgentNodeOptions {
  file?: string;
  probe?: (node: FleetNodeEntry) => Promise<NodeInfo | undefined>;
}

/**
 * Resolve spawn_agent's `machine` ("auto" or a node name) to a node that can
 * run an agent now. Throws a message the model can act on.
 */
export async function selectAgentNode(
  machine: string,
  options: SelectAgentNodeOptions = {},
): Promise<FleetNodeEntry> {
  const picked = await tryReserveAgentNode(machine, options);
  if ("error" in picked) throw new Error(picked.error);
  picked.release();
  return picked.node;
}

type ReserveAttempt =
  { node: FleetNodeEntry; release: () => void } | { error: string; waitable: boolean };

async function tryReserveAgentNode(
  machine: string,
  options: SelectAgentNodeOptions,
): Promise<ReserveAttempt> {
  const nodes = await readFleetNodes(options.file);
  if (nodes.length === 0) {
    return {
      waitable: false,
      error:
        "No fleet nodes are paired. Pair one with `ezcoder fleet add`, or leave machine unset to run locally.",
    };
  }
  const probe = options.probe ?? ((node: FleetNodeEntry) => probeNode(node));
  if (machine !== "auto") {
    const node = nodes.find((candidate) => candidate.name === machine);
    if (!node) {
      return {
        waitable: false,
        error: `Unknown machine "${machine}". Paired: ${nodes.map((n) => n.name).join(", ")} (or "auto").`,
      };
    }
    const probed = { node, info: await probe(node) };
    // Decide and reserve with no await in between, so concurrent starts see it.
    const problem = agentNodeProblem(probed);
    if (problem) {
      return {
        waitable: agentNodeOnlyFull(probed),
        error: `Machine "${machine}" can't run an agent now: ${problem}`,
      };
    }
    return { node, release: reserveAgentStart(node.name) };
  }
  const probed = await Promise.all(nodes.map(async (node) => ({ node, info: await probe(node) })));
  const picked = pickAutoNode(probed);
  if (!picked) {
    const reasons = probed.map((p) => `${p.node.name}: ${agentNodeProblem(p)}`).join("; ");
    return {
      waitable: probed.some(agentNodeOnlyFull),
      error: `No paired machine can run an agent now (${reasons}).`,
    };
  }
  return { node: picked.node, release: reserveAgentStart(picked.node.name) };
}

export interface AcquireAgentNodeOptions extends SelectAgentNodeOptions {
  /** Give up waiting for a free slot after this long (default 6 h). */
  queueTimeoutMs?: number;
  /** Re-check interval while every usable node is full (default 2 s). */
  pollMs?: number;
  /** Stop waiting (e.g. the agent was killed). */
  cancelled?: () => boolean;
  /** Told once when the start has to wait for a slot. */
  onQueued?: (reason: string) => void;
}

export const DEFAULT_AGENT_QUEUE_TIMEOUT_MS = 6 * 60 * 60_000;

/**
 * Like selectAgentNode, but when the only problem is that every usable node is
 * full, wait (re-checking every pollMs) until a slot frees instead of failing.
 * Returns the node with a start slot reserved; release it once the node has
 * answered the start (accepted or refused).
 */
export async function acquireAgentNode(
  machine: string,
  options: AcquireAgentNodeOptions = {},
): Promise<{ node: FleetNodeEntry; release: () => void }> {
  const deadline = Date.now() + (options.queueTimeoutMs ?? DEFAULT_AGENT_QUEUE_TIMEOUT_MS);
  let told = false;
  for (;;) {
    const attempt = await tryReserveAgentNode(machine, options);
    if ("node" in attempt) return attempt;
    if (!attempt.waitable) throw new Error(attempt.error);
    if (options.cancelled?.()) throw new Error("Cancelled while waiting for a free slot");
    if (Date.now() > deadline) {
      throw new Error(`${attempt.error} Gave up after waiting for a free slot.`);
    }
    if (!told) {
      told = true;
      options.onQueued?.(attempt.error);
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 2_000));
  }
}
