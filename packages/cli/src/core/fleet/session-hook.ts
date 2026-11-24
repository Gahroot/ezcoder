// Connects a session to the fleet orchestrator: job and service changes for the
// session's project arrive as notifications (failures are urgent), and
// unfinished jobs resume after a restart. Mirrors validation/session-hook.ts.
import path from "node:path";
import type { AgentNotificationQueue } from "../agent-notifications.js";
import { FleetService, fleetJobNotification, fleetServiceNotification } from "./service.js";
import { isFleetTerminal } from "./types.js";

export function attachFleetNotifications(
  getCwd: () => string,
  queue: AgentNotificationQueue,
  service: FleetService = FleetService.shared(),
): () => void {
  const unsubscribe = service.onEvent((e) => {
    const project = path.resolve(getCwd());
    if (e.type === "job") {
      if (e.job.project !== project) return;
      const n = fleetJobNotification(e.job);
      if (!n) return;
      // Progress notes (requeue, node down) use their own key so the final result isn't blocked.
      const key = n.terminal
        ? e.job.id
        : `${e.job.id}:${e.job.state}:${e.job.requeues?.length ?? 0}`;
      queue.enqueue("fleet", key, n.text, { terminal: n.terminal, urgent: n.urgent });
    } else {
      if (e.service.project && e.service.project !== project) return;
      const n = fleetServiceNotification(e.service, e.previous);
      if (n) {
        queue.enqueue("fleet", `svc:${e.service.id}:${e.service.state}`, n.text, {
          terminal: n.terminal,
          urgent: n.urgent,
        });
      }
    }
  });
  // Resume in-flight work (and report results that landed while we were away).
  void Promise.all([service.jobs.read(), service.services.read()])
    .then(([jobs, services]) => {
      if (
        jobs.some((j) => !isFleetTerminal(j.state) || j.notifiedState !== j.state) ||
        services.some((s) => s.state === "running" || s.state === "starting")
      ) {
        service.start();
      }
    })
    .catch(() => {});
  return unsubscribe;
}
