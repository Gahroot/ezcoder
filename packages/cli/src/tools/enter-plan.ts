import { z } from "zod";
import type { AgentTool } from "@prestyj/agent";

const EnterPlanParams = z.object({
  reason: z.string().optional(),
});

export function createEnterPlanTool(
  onEnterPlan: (reason?: string) => boolean | void | Promise<boolean | void>,
): AgentTool<typeof EnterPlanParams> {
  return {
    name: "enter_plan",
    description:
      "Enter read-only plan mode: research, then write a plan for the user to approve before changing code.",
    parameters: EnterPlanParams,
    executionMode: "sequential",
    async execute({ reason }) {
      const entered = await onEnterPlan(reason);
      // The host can decline plan mode (e.g. during an unattended task run where
      // an approval pane would stall the loop). When declined, tell the agent to
      // skip planning and implement the task directly.
      if (entered === false) {
        return (
          "Plan mode is unavailable during a task run. Skip planning and implement " +
          "the task directly: make the code changes, verify them, and mark the task done."
        );
      }
      return (
        "Plan mode is on. Research read-only (read-only bash is allowed), write the plan to " +
        ".ezcoder/plans/<name>.md ending in a numbered '## Steps' list, then call exit_plan with its path. " +
        "Edits outside .ezcoder/plans/, mutating bash and helper agents that can edit are blocked until the plan is approved."
      );
    },
  };
}
