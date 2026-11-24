// Node placement for fleet jobs and services. Static fit (labels, GPUs, GPU
// memory, cpus/memory, docker) decides whether a node could EVER run the work;
// live room (slots incl. our in-flight jobs, free memory, free GPU memory)
// decides whether it can run it NOW. Among nodes with room: avoid nodes the
// job was lost on, prefer the node that last ran this project (warm caches),
// then the emptiest, then the least loaded.
import type { NodeInfo, Resources } from "./protocol.js";

export interface NodeView {
  name: string;
  online: boolean;
  /** Live info (or the last known when offline). */
  info?: NodeInfo;
  /** Controller-side labels from nodes.json. */
  labels?: string[];
  error?: string;
}

export interface PlacementRequest {
  resources?: Resources;
  /** Secret names: only nodes labelled "deploy" may run these. */
  secrets?: string[];
  /** Runs in docker (needs docker on the node). */
  docker?: boolean;
  /** Pinned node name. */
  node?: string;
  /** Nodes to avoid if anything else fits. */
  avoid?: string[];
  /** Node that last ran this project. */
  affinity?: string;
  /** Jobs take slots; services don't. */
  takesSlot: boolean;
}

/** Our dispatched, unfinished work per node (the node's own count may lag). */
export interface InFlightWork {
  node: string;
  resources?: Resources;
}

export type Placement = { node: NodeView } | { wait: string } | { error: string };

function labelsOf(v: NodeView): string[] {
  const all = [...(v.info?.labels ?? []), ...(v.labels ?? [])];
  if (v.info?.gpus.length) all.push("gpu");
  return all.map((l) => l.toLowerCase());
}

/** Why this node can never run the request (undefined = it could). */
export function staticMismatch(req: PlacementRequest, v: NodeView): string | undefined {
  const info = v.info;
  if (!info) return undefined;
  const need = req.resources ?? {};
  const labels = labelsOf(v);
  const missing = (need.labels ?? []).filter((l) => !labels.includes(l.toLowerCase()));
  if (missing.length) return `lacks label ${missing.join(", ")}`;
  if (req.secrets?.length && !labels.includes("deploy")) {
    return 'uses secrets, which only nodes labelled "deploy" accept';
  }
  if (req.docker && !info.docker) return "has no docker";
  if (need.gpus) {
    const gpus = info.gpus.filter((g) => !need.gpuMemoryGb || g.memoryGb >= need.gpuMemoryGb);
    if (gpus.length < need.gpus) {
      return need.gpuMemoryGb
        ? `has ${gpus.length} GPU(s) with ${need.gpuMemoryGb} GB, needs ${need.gpus}`
        : `has ${info.gpus.length} GPU(s), needs ${need.gpus}`;
    }
  }
  if (need.cpus && need.cpus > info.cpus) return `has ${info.cpus} cpus, needs ${need.cpus}`;
  if (need.memoryGb && need.memoryGb > info.memoryGb) {
    return `has ${info.memoryGb} GB memory, needs ${need.memoryGb}`;
  }
  return undefined;
}

export function slotsUsed(v: NodeView, inFlight: readonly InFlightWork[]): number {
  const ours = inFlight.filter((w) => w.node === v.name).length;
  return Math.max(v.info?.slotsUsed ?? 0, ours);
}

/** Why the node can't take the request right now (undefined = it can). */
export function liveShortage(
  req: PlacementRequest,
  v: NodeView,
  inFlight: readonly InFlightWork[],
): string | undefined {
  const info = v.info;
  if (!v.online || !info) return "offline";
  if (req.takesSlot && slotsUsed(v, inFlight) >= info.slots) return "all slots busy";
  const need = req.resources ?? {};
  const mine = inFlight.filter((w) => w.node === v.name);
  const reservedCpus = mine.reduce((n, w) => n + (w.resources?.cpus ?? 0), 0);
  if (need.cpus && reservedCpus + need.cpus > info.cpus) return "cpus reserved by other jobs";
  if (need.memoryGb && need.memoryGb > info.memoryFreeGb) {
    return `only ${info.memoryFreeGb} GB memory free`;
  }
  if (need.gpus) {
    const free = info.gpus.filter(
      (g) => g.memoryGb - (g.memoryUsedGb ?? 0) >= (need.gpuMemoryGb ?? 0.5),
    ).length;
    if (free < need.gpus) return "GPU memory in use";
  }
  return undefined;
}

/** Pick a node, or say why it must wait / can never run. */
export function chooseNode(
  req: PlacementRequest,
  nodes: readonly NodeView[],
  inFlight: readonly InFlightWork[] = [],
): Placement {
  if (!nodes.length) return { error: "no nodes paired; pair one with `ezcoder fleet add`" };
  let pool = [...nodes];
  if (req.node) {
    pool = pool.filter((n) => n.name === req.node);
    if (!pool.length) return { error: `no paired node "${req.node}"` };
  }
  const reasons: string[] = [];
  const fitting = pool.filter((n) => {
    const why = staticMismatch(req, n);
    if (why) reasons.push(`${n.name} ${why}`);
    return !why;
  });
  if (!fitting.length) return { error: `no node fits: ${reasons.join("; ")}` };
  const known = fitting.filter((n) => n.info);
  // Only offline nodes we've never seen could fit: wait for them rather than fail.
  const withRoom = known.filter((n) => {
    const why = liveShortage(req, n, inFlight);
    if (why) reasons.push(`${n.name}: ${why}`);
    return !why;
  });
  if (!withRoom.length) {
    const online = fitting.filter((n) => n.online);
    return {
      wait: online.length
        ? `every fitting node is busy (${reasons.join("; ")})`
        : `no fitting node is online (${fitting.map((n) => n.name).join(", ")})`,
    };
  }
  const avoid = new Set(req.avoid ?? []);
  const ratio = (n: NodeView) =>
    req.takesSlot ? slotsUsed(n, inFlight) / Math.max(1, n.info!.slots) : 0;
  const order = new Map(withRoom.map((n, i) => [n.name, i]));
  const best = [...withRoom].sort(
    (a, b) =>
      Number(avoid.has(a.name)) - Number(avoid.has(b.name)) ||
      Number(b.name === req.affinity) - Number(a.name === req.affinity) ||
      ratio(a) - ratio(b) ||
      a.info!.load - b.info!.load ||
      order.get(a.name)! - order.get(b.name)!,
  )[0]!;
  return { node: best };
}
