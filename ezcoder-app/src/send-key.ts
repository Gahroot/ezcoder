/** What the composer's round send key does right now. */
export type SendKeyAction = "send" | "stop-run" | "stop-ken";

// The send key is the only Stop control: it stops GG's run, Nolan's autopilot
// review (both through the run's cancel) or a manual @Nolan reply.
export function sendKeyAction(state: {
  shellMode: boolean;
  running: boolean;
  nolanRunning: boolean;
  autopilotReviewing: boolean;
}): SendKeyAction {
  if (state.shellMode) return "send";
  if (state.running || state.autopilotReviewing) return "stop-run";
  if (state.nolanRunning) return "stop-ken";
  return "send";
}
