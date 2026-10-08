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
      "Enter read-only plan mode for complex or risky work (writes only under .ezcoder/plans/).",
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
        "Plan mode activated. You are now in read-only research mode.\n\n" +
        "Allowed actions:\n" +
        "- Use read, grep, find, ls, source_path, web_fetch/web_search, and code search tools to investigate\n" +
        "- Write the implementation plan to .ezcoder/plans/<name>.md\n\n" +
        "Restricted: bash, edit, write outside .ezcoder/plans/, subagent, and task mutation.\n\n" +
        "When the plan is ready, call exit_plan with the plan file path."
      );
    },
  };
}
