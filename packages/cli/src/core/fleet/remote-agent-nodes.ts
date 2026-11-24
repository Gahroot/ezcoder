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

/** Why a probed node can't take an agent now, or undefined when it can. */
export function agentNodeProblem(probed: ProbedNode): string | undefined {
  const { info } = probed;
  if (!info) return "unreachable";
  if (!info.modelAuth) return "no model credentials (run `ezcoder login` there, or share-auth)";
  if (info.slotsUsed >= info.slots) return `full (${info.slotsUsed}/${info.slots} slots)`;
  return undefined;
}

/** `auto`: a node with model credentials and a free slot, least loaded first. */
export function pickAutoNode(probed: readonly ProbedNode[]): ProbedNode | undefined {
  return probed
    .filter((candidate) => agentNodeProblem(candidate) === undefined)
    .sort(
      (a, b) =>
        a.info!.load - b.info!.load ||
        b.info!.slots - b.info!.slotsUsed - (a.info!.slots - a.info!.slotsUsed) ||
        a.node.name.localeCompare(b.node.name),
    )[0];
}

/**
 * Resolve spawn_agent's `machine` ("auto" or a node name) to a node that can
 * run an agent now. Throws a message the model can act on.
 */
export async function selectAgentNode(
  machine: string,
  options: { file?: string; probe?: (node: FleetNodeEntry) => Promise<NodeInfo | undefined> } = {},
): Promise<FleetNodeEntry> {
  const nodes = await readFleetNodes(options.file);
  if (nodes.length === 0) {
    throw new Error(
      "No fleet nodes are paired. Pair one with `ezcoder fleet add`, or leave machine unset to run locally.",
    );
  }
  const probe = options.probe ?? ((node: FleetNodeEntry) => probeNode(node));
  if (machine !== "auto") {
    const node = nodes.find((candidate) => candidate.name === machine);
    if (!node) {
      throw new Error(
        `Unknown machine "${machine}". Paired: ${nodes.map((n) => n.name).join(", ")} (or "auto").`,
      );
    }
    const problem = agentNodeProblem({ node, info: await probe(node) });
    if (problem) throw new Error(`Machine "${machine}" can't run an agent now: ${problem}`);
    return node;
  }
  const probed = await Promise.all(nodes.map(async (node) => ({ node, info: await probe(node) })));
  const picked = pickAutoNode(probed);
  if (!picked) {
    const reasons = probed.map((p) => `${p.node.name}: ${agentNodeProblem(p)}`).join("; ");
    throw new Error(`No paired machine can run an agent now (${reasons}).`);
  }
  return picked.node;
}
