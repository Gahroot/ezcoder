/** A Goal run that lives on another machine (GL4), as GET /goals reports it. */
export interface HostedGoalRun {
  node: string;
  state: "preparing" | "running" | "done" | "failed" | "stopped" | "lost" | "unreachable";
  runId?: string;
  title?: string;
  summary?: string;
  resultBranch?: string;
  resultSha?: string;
  /** Why the last check on the machine failed, if it did. */
  error?: string;
}

/** One plain line: where a hosted run is and how it stands. */
export function hostedGoalText(run: HostedGoalRun): string {
  const on = `on ${run.node}`;
  switch (run.state) {
    case "preparing":
      return `Getting ready ${on}`;
    case "running":
      return `Running ${on}`;
    case "done": {
      if (!run.resultBranch) return `Done ${on}`;
      const sha = run.resultSha ? ` (${run.resultSha.slice(0, 7)})` : "";
      return `Done ${on}, result on branch ${run.resultBranch}${sha}`;
    }
    case "failed":
      return `Failed ${on}`;
    case "stopped":
      return `Stopped ${on}`;
    case "lost":
      return `Lost ${on}: the machine restarted and couldn't carry on`;
    case "unreachable":
      return `Can't reach ${run.node} right now`;
  }
}

/** The line plus the last check's problem, when there was one. */
export function hostedGoalLine(run: HostedGoalRun): string {
  const text = hostedGoalText(run);
  return run.error && run.state !== "unreachable"
    ? `${text}. Last check failed: ${run.error}`
    : text;
}
