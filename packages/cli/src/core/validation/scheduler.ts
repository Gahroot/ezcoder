// Resource-aware placement of queued jobs. A target is one schedulable place:
// a plain backend (static capacity, `maxConcurrent` slots) or one machine of a
// pool (`<pool>/<machine>`, capacity and slots from its runner labels).
import { fits } from "./backends.js";
import type { MachineInfo, Resources, ValidationBackend, ValidationJob } from "./types.js";

export interface Target {
  /** Backend id, or `<pool>/<machine>`. */
  key: string;
  backend: ValidationBackend;
  machine?: string;
  online: boolean;
  cloud: boolean;
  overflowOnly: boolean;
  slots: number;
  /** Runners GitHub reports busy (ours or anyone's). */
  busy: number;
  capacity?: Resources;
  platform: string[];
  info?: MachineInfo;
}

export function targetKey(backend: string, machine?: string): string {
  return machine && machine !== backend ? `${backend}/${machine}` : backend;
}

/** Where a job is (or was) placed, for display: `pool/machine` or the backend id. */
export function jobTarget(j: Pick<ValidationJob, "backend" | "machine">): string {
  return targetKey(j.backend, j.machine);
}

/** Every target, discovering pool machines (cached by the backends). */
export async function listTargets(backends: readonly ValidationBackend[]): Promise<Target[]> {
  const out: Target[] = [];
  for (const b of backends) {
    if (b.machines) {
      const ms = await b.machines().catch(() => [] as MachineInfo[]);
      for (const m of ms) {
        out.push({
          key: targetKey(b.id, m.name),
          backend: b,
          machine: m.name,
          online: m.online,
          cloud: !!m.cloud,
          overflowOnly: !!m.overflowOnly,
          slots: m.slots,
          busy: m.busy,
          ...(m.capacity ? { capacity: m.capacity } : {}),
          platform: m.platform,
          info: m,
        });
      }
    } else {
      out.push({
        key: b.id,
        backend: b,
        // Static backends are assumed reachable; GitHub queues runs until a runner is back.
        online: true,
        cloud: false,
        overflowOnly: false,
        slots: b.maxConcurrent,
        busy: 0,
        ...(b.capacity ? { capacity: b.capacity } : {}),
        platform: [],
      });
    }
  }
  return out;
}

const inFlight = (j: ValidationJob) => j.state === "waiting" || j.state === "running";

/** Our in-flight jobs on a target. */
export function jobsOn(t: Target, jobs: readonly ValidationJob[]): ValidationJob[] {
  return jobs.filter(
    (j) =>
      inFlight(j) &&
      j.backend === t.backend.id &&
      (t.machine === undefined || (j.machine ?? t.backend.id) === t.machine),
  );
}

export interface TargetLoad {
  /** Slots taken: GitHub-busy runners (at least our running jobs) plus our not-yet-started runs. */
  used: number;
  reservedCpus: number;
  reservedMemoryGb: number;
}

export function loadOf(t: Target, jobs: readonly ValidationJob[]): TargetLoad {
  const mine = jobsOn(t, jobs);
  const running = mine.filter((j) => j.state === "running").length;
  const waiting = mine.length - running;
  return {
    used: Math.max(t.busy, running) + waiting,
    reservedCpus: mine.reduce((n, j) => n + (j.resources?.cpus ?? 0), 0),
    reservedMemoryGb: mine.reduce((n, j) => n + (j.resources?.memoryGb ?? 0), 0),
  };
}

/** Free slot and enough unreserved CPU/memory for this job right now? */
function hasRoom(t: Target, job: ValidationJob, jobs: readonly ValidationJob[]): boolean {
  const l = loadOf(t, jobs);
  if (l.used >= t.slots) return false;
  const need = job.resources;
  if (need?.cpus && t.capacity?.cpus !== undefined && l.reservedCpus + need.cpus > t.capacity.cpus)
    return false;
  if (
    need?.memoryGb &&
    t.capacity?.memoryGb !== undefined &&
    l.reservedMemoryGb + need.memoryGb > t.capacity.memoryGb
  )
    return false;
  return true;
}

/**
 * Pick a target for a queued job.
 * - a Target: dispatch there now
 * - undefined: fitting machines exist but none has room; stay queued
 * - "none": nothing configured could ever fit the stage
 * - "offline": no fitting machine is online (and no cloud overflow); stay queued
 */
export function chooseTarget(
  job: ValidationJob,
  targets: readonly Target[],
  jobs: readonly ValidationJob[],
): Target | undefined | "none" | "offline" {
  let pool: Target[];
  if (job.backend) {
    pool = targets.filter(
      (t) => t.backend.id === job.backend && (!job.machine || t.machine === job.machine),
    );
    if (!pool.length) {
      // A pinned pool with no machines discovered yet: wait for one.
      return job.machine || targets.some((t) => t.backend.id === job.backend) ? "offline" : "none";
    }
    // Pinned to exactly one place: trust the pin, as before.
    if (pool.length > 1) pool = pool.filter((t) => fits(job.resources, t.capacity));
  } else {
    const remote = targets.filter((t) => t.backend.runs === "remote");
    pool = remote.filter((t) => fits(job.resources, t.capacity));
    if (!pool.length) return remote.length ? "none" : "offline";
  }
  if (!pool.length) return "none";
  const selfHostedOnline = pool.filter((t) => !t.cloud && t.online);
  let candidates = selfHostedOnline.length
    ? [...selfHostedOnline, ...pool.filter((t) => t.cloud && !t.overflowOnly)]
    : pool.filter((t) => t.cloud);
  if (!candidates.length) return "offline";
  candidates = candidates.filter((t) => hasRoom(t, job, jobs));
  if (!candidates.length) return undefined;

  const avoid = new Set(job.avoid ?? []);
  const last = [...jobs]
    .reverse()
    .find(
      (j) =>
        j.id !== job.id &&
        j.dispatchedAt &&
        j.run === "remote" &&
        (job.repo ? j.repo === job.repo : j.project === job.project),
    );
  const affinity = last ? jobTarget(last) : undefined;
  const ratio = (t: Target) => loadOf(t, jobs).used / Math.max(1, t.slots);
  const order = new Map(candidates.map((t, i) => [t.key, i]));
  return [...candidates].sort(
    (a, b) =>
      Number(avoid.has(a.key)) - Number(avoid.has(b.key)) ||
      Number(b.key === affinity) - Number(a.key === affinity) ||
      ratio(a) - ratio(b) ||
      order.get(a.key)! - order.get(b.key)!,
  )[0];
}
