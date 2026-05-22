import { z } from "zod";
import type { AgentTool } from "@prestyj/agent";

const EnterPlanParams = z.object({
  reason: z
    .string()
    .optional()
    .describe("Why you are entering plan mode (e.g. complex multi-file task)"),
});

export function createEnterPlanTool(
  onEnterPlan: (reason?: string) => void,
  taskRunningRef?: { current: boolean },
): AgentTool<typeof EnterPlanParams> {
  return {
    name: "enter_plan",
    description:
      "Enter plan mode for safe, read-only exploration before making changes. " +
      "Use this when facing complex, multi-file tasks that benefit from research and planning " +
      "before implementation. In plan mode, destructive tools (bash, edit, write, subagent) are " +
      "restricted — only read-only tools and writing to .ezcoder/plans/ are allowed.",
    parameters: EnterPlanParams,
    executionMode: "sequential",
    async execute({ reason }) {
      // Plan mode requires human approval of the plan via the plan overlay
      // (`exit_plan` opens a modal the user accepts/rejects). Task-pane runs
      // are unattended — there is no human to approve — so entering plan
      // mode would stall the task forever. Refuse and tell the agent to just
      // execute the task directly.
      if (taskRunningRef?.current) {
        return (
          "Error: plan mode is disabled during task-pane runs. The task prompt is the plan — " +
          "execute it directly using edit/write/bash. Do not call enter_plan again in this task."
        );
      }
      onEnterPlan(reason);
      return (
        "Plan mode activated. You are now in read-only research mode.\n\n" +
        "Allowed actions:\n" +
        "- Use read, grep, find, ls to explore the codebase\n" +
        "- Use source_path to locate installed dependency source, then inspect it with read/grep/find/ls\n" +
        "- Use web_fetch for documentation and references\n" +
        "- Write your plan to .ezcoder/plans/<name>.md\n\n" +
        "Restricted: bash, edit, write (except .ezcoder/plans/), subagent\n\n" +
        "When your plan is ready, call exit_plan with the plan file path."
      );
    },
  };
}
