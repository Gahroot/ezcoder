import { useCallback, useEffect, useRef, useState } from "react";
import {
  getFleetActivity,
  listMachines,
  type FleetActivity,
  type FleetActivityJob,
  type Machine,
  type MachinesOverview,
} from "./agent";

/** How often the Machines panel re-reads live machine state. */
export const MACHINES_POLL_MS = 10_000;
/** How often the footer re-reads this project's fleet jobs and services. */
export const FLEET_ACTIVITY_POLL_MS = 5_000;

export interface MachinesState {
  machines: Machine[];
  /** This computer's EZ Coder version. */
  version: string | null;
  local: MachinesOverview["local"] | null;
  total: MachinesOverview["total"] | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/** Paired machines, polled while mounted. */
export function useMachines(pollMs = MACHINES_POLL_MS): MachinesState {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [version, setVersion] = useState<string | null>(null);
  const [local, setLocal] = useState<MachinesOverview["local"] | null>(null);
  const [total, setTotal] = useState<MachinesOverview["total"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const res = await listMachines();
      if (!alive.current) return;
      setMachines(Array.isArray(res?.machines) ? res.machines : []);
      setVersion(typeof res?.version === "string" ? res.version : null);
      setLocal(res?.local ?? null);
      setTotal(res?.total ?? null);
      setError(null);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const id = window.setInterval(() => void refresh(), pollMs);
    return () => {
      alive.current = false;
      window.clearInterval(id);
    };
  }, [refresh, pollMs]);

  return { machines, version, local, total, loading, error, refresh };
}

const LIVE_JOB: ReadonlySet<FleetActivityJob["state"]> = new Set([
  "queued",
  "preparing",
  "running",
]);

export function isLiveFleetJob(job: FleetActivityJob): boolean {
  return LIVE_JOB.has(job.state);
}

const EMPTY: FleetActivity = { jobs: [], services: [] };

/**
 * This project's fleet jobs and services, for the footer's activity area.
 * Reading it costs the sidecar two small local files (no machine is asked),
 * so a short poll keeps the state live without a push channel.
 */
export function useFleetActivity(enabled = true, pollMs = FLEET_ACTIVITY_POLL_MS): FleetActivity {
  const [activity, setActivity] = useState<FleetActivity>(EMPTY);

  useEffect(() => {
    if (!enabled) {
      setActivity(EMPTY);
      return;
    }
    let alive = true;
    const read = async (): Promise<void> => {
      try {
        const res = await getFleetActivity();
        if (!alive) return;
        const jobs = Array.isArray(res?.jobs) ? res.jobs : [];
        const services = Array.isArray(res?.services) ? res.services : [];
        // Keep the same object while nothing changed, so the footer doesn't re-render.
        setActivity((prev) =>
          JSON.stringify(prev) === JSON.stringify({ jobs, services }) ? prev : { jobs, services },
        );
      } catch {
        // No sidecar yet, or fleet unavailable: show nothing.
      }
    };
    void read();
    const id = window.setInterval(() => void read(), pollMs);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [enabled, pollMs]);

  return activity;
}
