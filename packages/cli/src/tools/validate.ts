// `validate` tool: hands tests to the async validation orchestrator and
// returns at once. Results arrive later as notifications, so a test run never
// holds the session.
import { z } from "zod";
import type { AgentTool } from "@prestyj/agent";
import {
  describeJob,
  describeWorker,
  short,
  ValidationService,
} from "../core/validation/service.js";
import { VALIDATION_CONFIG_FILE } from "../core/validation/config.js";
import { isTerminal } from "../core/validation/types.js";
import { jobTarget } from "../core/validation/scheduler.js";

const ValidateParams = z.object({
  action: z
    .enum(["run", "status", "gate", "logs", "cancel", "retry", "workers"])
    .describe(
      "run: queue stages for a commit and return at once. status: config and jobs. gate: did every required stage pass at this exact commit. logs/cancel/retry: one job. workers: backends and health.",
    ),
  stages: z.array(z.string()).optional().describe("run: stage names (default all)"),
  ref: z.string().optional().describe("run/gate: commit or branch (default HEAD)"),
  id: z.string().optional().describe("logs/cancel/retry: job id"),
  full: z.boolean().optional().describe("logs: whole log, not only the failing part"),
  force: z.boolean().optional().describe("run: re-run even if this commit already passed"),
});

export function createValidateTool(
  cwd: string,
  getService: () => ValidationService = () => ValidationService.shared(),
): AgentTool<typeof ValidateParams> {
  return {
    name: "validate",
    description:
      "Async tests on workers (local quick checks, remote heavy suites) against exact commits; " +
      "returns at once and you're notified when each stage finishes — keep working, never wait or poll. " +
      "Stages come from .ezcoder/validation.json or are detected. Remote stages test the committed SHA " +
      "(commit and push first); a newer commit supersedes older runs. Use gate before calling work merge- or release-ready.",
    parameters: ValidateParams,
    async execute(args) {
      const svc = getService();
      try {
        switch (args.action) {
          case "run": {
            const r = await svc.enqueue(cwd, {
              ...(args.stages ? { stages: args.stages } : {}),
              ...(args.ref ? { ref: args.ref } : {}),
              ...(args.force ? { force: true } : {}),
            });
            const lines = [
              `Commit ${short(r.sha)}${r.branch ? ` (${r.branch})` : ""}: ${r.jobs.length} queued` +
                (r.reused.length ? `, ${r.reused.length} already done or running` : "") +
                ". You'll be notified as each finishes; carry on.",
              ...r.jobs.map(
                (j) => `- ${j.id} ${j.stage} (${j.backend ? jobTarget(j) : "next free worker"})`,
              ),
              ...r.reused.map((j) => `- ${describeJob(j)}`),
              ...r.messages,
            ];
            return lines.join("\n");
          }
          case "status": {
            const cfg = svc.config(cwd);
            const jobs = await svc.list(cwd);
            const lines: string[] = [];
            if ("error" in cfg) lines.push(`Config error: ${cfg.error}`);
            else {
              lines.push(
                `Stages (${cfg.source === "file" ? VALIDATION_CONFIG_FILE : "auto-detected"}): ` +
                  (cfg.stages
                    .map((s) => `${s.name} [${s.run}${s.required ? ", required" : ""}]`)
                    .join(", ") || "none"),
                ...cfg.notes,
              );
            }
            const active = jobs.filter((j) => !isTerminal(j.state));
            const recent = jobs.filter((j) => isTerminal(j.state)).slice(-8);
            lines.push(active.length ? "In progress:" : "Nothing in progress.");
            lines.push(...active.map((j) => `- ${describeJob(j)}`));
            if (recent.length) lines.push("Recent:", ...recent.map((j) => `- ${describeJob(j)}`));
            return lines.join("\n");
          }
          case "gate": {
            const g = await svc.gate(cwd, args.ref);
            return [
              `${g.ok ? "PASS" : "NOT READY"}: required stages at ${short(g.sha)}`,
              ...g.rows.map(
                (r) =>
                  `- ${r.stage}: ${r.state}${r.note ? ` (${r.note})` : ""}${r.jobId ? ` [${r.jobId}]` : ""}`,
              ),
              ...(g.rows.length ? [] : ["(no required stages)"]),
            ].join("\n");
          }
          case "logs":
            if (!args.id) return "Error: logs needs id.";
            return await svc.logs(args.id, !args.full);
          case "cancel": {
            if (!args.id) return "Error: cancel needs id.";
            const j = await svc.cancel(args.id);
            return j ? describeJob(j) : `No job ${args.id}.`;
          }
          case "retry": {
            if (!args.id) return "Error: retry needs id.";
            const j = await svc.retry(args.id);
            return `Queued ${j.id} (retry of ${args.id}). You'll be notified when it finishes.`;
          }
          case "workers": {
            const ws = await svc.workers();
            return [
              ...ws.map((w) => `- ${describeWorker(w)}`),
              ...svc.problems.map((p) => `Config problem: ${p}`),
            ].join("\n");
          }
        }
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  };
}
