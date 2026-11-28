// One view of each node's slots for both kinds of controller work: fleet jobs
// (~/.ezcoder/fleet/jobs.json) and validation stages placed on fleet nodes
// (~/.ezcoder/validation/jobs.json). Each scheduler adds the OTHER kind's
// in-flight work to its own, so neither over-books a node the other is using.
// Plain file reads, no locks: a count that is one tick stale is corrected by
// the node itself (it answers 429 busy, and the work stays queued).
import fs from "node:fs/promises";
import path from "node:path";

async function readList(file: string, key: string): Promise<Record<string, unknown>[]> {
  try {
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown> | null;
    const list = raw?.[key];
    return Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
  } catch {
    return [];
  }
}

function bump(m: Map<string, number>, name: string): void {
  m.set(name, (m.get(name) ?? 0) + 1);
}

/** Fleet jobs dispatched and unfinished, per node (cloud runs excluded). */
export async function fleetInFlightByNode(fleetDir: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const j of await readList(path.join(fleetDir, "jobs.json"), "jobs")) {
    const node = j.node;
    if (typeof node !== "string" || node.startsWith("cloud:")) continue;
    if (j.state === "preparing" || j.state === "running") bump(out, node);
  }
  return out;
}

/** Ids of validation backends that run on fleet nodes ("fleet" plus kind:"node" entries). */
async function nodeBackendIds(validationDir: string): Promise<Set<string>> {
  const ids = new Set(["fleet"]);
  try {
    const file = JSON.parse(
      await fs.readFile(path.join(validationDir, "backends.json"), "utf8"),
    ) as {
      backends?: Array<{ kind?: string; id?: string }>;
    };
    for (const b of file.backends ?? []) if (b?.kind === "node") ids.add(b.id ?? "fleet");
  } catch {
    // no registry: only the default "fleet" pool
  }
  return ids;
}

/** Validation stages dispatched to a fleet node and unfinished, per node. */
export async function validationInFlightByNode(
  validationDir: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = await nodeBackendIds(validationDir);
  for (const j of await readList(path.join(validationDir, "jobs.json"), "jobs")) {
    if (typeof j.backend !== "string" || !ids.has(j.backend)) continue;
    if (typeof j.machine !== "string") continue;
    if (j.state === "waiting" || j.state === "running") bump(out, j.machine);
  }
  return out;
}
