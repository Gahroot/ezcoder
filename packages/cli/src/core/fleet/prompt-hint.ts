// A5/A8: the fleet section of the system prompt. Shown only when a node is
// paired: when to send work to the fleet and when not, the total capacity,
// and the project's placement defaults from .ezcoder/fleet.json.
import { fleetCapacity, listMachines, type FleetCapacity, type MachineView } from "./machines.js";
import { loadFleetConfig, type FleetPlacement } from "./project-config.js";
import { FleetService } from "./service.js";

export interface FleetHintInput {
  machines: readonly MachineView[];
  capacity: FleetCapacity;
  defaults?: Record<string, FleetPlacement>;
}

export function renderFleetHint(h: FleetHintInput): string | undefined {
  if (!h.machines.length) return undefined;
  const usable = h.machines.filter((m) => m.online && !m.incompatible);
  const gpus = usable.flatMap((m) => m.gpus.map((g) => `${g.name} on ${m.name}`));
  const c = h.capacity;
  const lines = [
    "# Fleet",
    `Paired machines: ${h.machines.map((m) => `${m.name}${m.online ? "" : " (offline)"}${m.incompatible ? " (incompatible)" : ""}`).join(", ")}. ` +
      `Capacity: ${c.total} slots (${c.local} here, ${c.nodesTotal} on nodes, ${c.nodesUsed} in use)` +
      `${gpus.length ? `; GPUs: ${gpus.join(", ")}` : ""}.`,
    "Prefer the `fleet` tool for long builds, e2e/browser tests, renders, GPU work, and many test runs at once (`run` with `count`); it returns at once and you are notified, so keep working.",
    "Keep quick edits, short commands and anything that needs local secrets or local files that are not committed (unless sent with uncommitted: true) on this machine.",
  ];
  const d = Object.entries(h.defaults ?? {});
  if (d.length) {
    lines.push(
      `Project defaults (.ezcoder/fleet.json): ${d.map(([k, v]) => `${k} runs ${v === "fleet" ? "on the fleet" : "locally"}`).join("; ")}. Follow them unless the user says otherwise.`,
    );
  }
  return lines.join("\n");
}

/** Builds the hint for a session; undefined when no node is paired. Never throws. */
export async function loadFleetHint(
  cwd: string,
  svc: FleetService = FleetService.shared(),
  timeoutMs = 3000,
): Promise<string | undefined> {
  try {
    if (!(await svc.registry.list()).length) return undefined;
    const machines = await Promise.race([
      listMachines({ svc }),
      new Promise<MachineView[]>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), timeoutMs).unref(),
      ),
    ]);
    const cfg = loadFleetConfig(cwd);
    return renderFleetHint({
      machines,
      capacity: fleetCapacity(machines, svc.localCapacity()),
      ...(!("error" in cfg) && cfg.defaults ? { defaults: cfg.defaults } : {}),
    });
  } catch {
    return undefined;
  }
}
