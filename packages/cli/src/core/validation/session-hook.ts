// Connects a session to the validation orchestrator: results for the session's
// project arrive as pushed notifications (failures are urgent, so an idle
// session can wake to repair), and unfinished jobs resume after a restart.
import path from "node:path";
import type { AgentNotificationQueue } from "../agent-notifications.js";
import { notificationFor, requeueNotification, ValidationService } from "./service.js";
import { isTerminal } from "./types.js";

export function attachValidationNotifications(
  getCwd: () => string,
  queue: AgentNotificationQueue,
  service: ValidationService = ValidationService.shared(),
): () => void {
  const unsubscribe = service.onJob((job, _prev, info) => {
    if (job.project !== path.resolve(getCwd())) return;
    const re = info?.requeued && !isTerminal(job.state) ? requeueNotification(job) : undefined;
    if (re) {
      queue.enqueue("validation", `${job.id}:requeue${job.requeues?.length ?? 0}`, re, {
        terminal: false,
        urgent: false,
      });
    }
    const n = notificationFor(job);
    if (n) queue.enqueue("validation", job.id, n.text, { terminal: n.terminal, urgent: n.urgent });
  });
  // Resume in-flight work (and report results that landed while we were away).
  void service.store
    .read()
    .then((jobs) => {
      if (jobs.some((j) => !isTerminal(j.state) || j.notifiedState !== j.state)) service.start();
    })
    .catch(() => {});
  return unsubscribe;
}
