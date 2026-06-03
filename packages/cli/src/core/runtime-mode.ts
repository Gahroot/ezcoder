export type GoalMode = "off" | "planner" | "setup" | "coordinator";

export interface RuntimeModeRefs {
  planModeRef?: { current: boolean };
  goalModeRef?: { current: GoalMode };
}

export function isPlanModeActive(planModeRef?: { current: boolean }): boolean {
  return planModeRef?.current === true;
}

export function getActiveGoalMode(goalModeRef?: { current: GoalMode }): GoalMode {
  return goalModeRef?.current ?? "off";
}

export function isGoalModeActive(goalModeRef?: { current: GoalMode }): boolean {
  return getActiveGoalMode(goalModeRef) !== "off";
}

export function planModeRestriction(toolName: string): string {
  return `Error: ${toolName} is restricted in plan mode. Use read-only tools to explore (read-only bash like git log, wc, grep is allowed), write the plan under .ezcoder/plans/, then call exit_plan for review.`;
}

export function goalModeMutationRestriction(toolName: string, mode: GoalMode): string {
  return `Error: ${toolName} is restricted in Goal ${mode} mode. Goal planner/setup/coordinator turns may only update Goal metadata and orchestration state; implementation changes must be performed by Goal workers after durable Goal setup.`;
}

export function goalModeSubagentRestriction(mode: GoalMode): string {
  return `Error: subagent is restricted in Goal ${mode} mode. Use Goal task creation through the goals tool so worker activity is durable and orchestrated.`;
}

export function goalModeBashRestriction(mode: GoalMode, background: boolean): string | null {
  if (mode === "off") return null;
  if (mode === "coordinator") {
    return "Error: bash is restricted in Goal coordinator mode. Use goals metadata actions and UI-driven verifier execution instead.";
  }
  if (background) {
    return `Error: background bash is restricted in Goal ${mode} mode. Use only cheap foreground non-mutating checks while setting up Goal metadata.`;
  }
  return null;
}
