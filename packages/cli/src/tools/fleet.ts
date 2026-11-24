// `fleet` tool: send jobs and services to the user's other machines (nodes).
// Returns at once; results arrive later as notifications.
import { z } from "zod";
import type { AgentTool } from "@prestyj/agent";
import { selectFleetBrowser } from "../core/fleet/browser.js";
import {
  describeFleetJob,
  describeFleetService,
  describeNode,
  FleetService,
} from "../core/fleet/service.js";
import { isFleetTerminal } from "../core/fleet/types.js";

const FleetParams = z.object({
  action: z
    .enum([
      "nodes",
      "run",
      "status",
      "logs",
      "artifacts",
      "cancel",
      "service_up",
      "service_down",
      "services",
      "exec",
    ])
    .describe(
      "nodes: machines and load. run: queue a project job. status: jobs and config. logs/artifacts/cancel: one job. service_up/service_down/services: long-running services (llm, browser, dev, ...). exec: run a command in a devenv service.",
    ),
  name: z
    .string()
    .optional()
    .describe("run: job name. service_up/service_down/exec: service name or id (exec default dev)"),
  id: z.string().optional().describe("logs/artifacts/cancel: job id"),
  node: z.string().optional().describe("run/service_up: pin a node (default: best fit)"),
  uncommitted: z
    .boolean()
    .optional()
    .describe("run/service_up: include uncommitted changes as a patch"),
  command: z.string().optional().describe("exec: shell command"),
  use: z.boolean().optional().describe("service_up browser: make the browser tool use it"),
  out: z.string().optional().describe("artifacts: download folder"),
});

export function createFleetTool(
  cwd: string,
  getService: () => FleetService = () => FleetService.shared(),
): AgentTool<typeof FleetParams> {
  return {
    name: "fleet",
    description:
      "Run work on the user's other machines (nodes): builds, e2e/browser tests, renders, deploys, " +
      "GPU inference, remote browsers, dev environments. Returns at once; you're notified when jobs finish — " +
      "keep working, never wait or poll. Jobs run the pushed commit (push first, or uncommitted: true).",
    parameters: FleetParams,
    async execute(args) {
      const svc = getService();
      try {
        switch (args.action) {
          case "nodes": {
            const nodes = await svc.nodes();
            if (!nodes.length)
              return "No nodes paired. The user pairs one with `ezcoder fleet add`.";
            return nodes.map((n) => `- ${describeNode(n)}`).join("\n");
          }
          case "run": {
            if (!args.name) return "Error: run needs name (a job from fleet status).";
            const r = await svc.run(cwd, args.name, {
              ...(args.node ? { node: args.node } : {}),
              ...(args.uncommitted ? { includeUncommitted: true } : {}),
            });
            return [
              `Queued ${r.job.id} (${r.job.name}). You'll be notified when it finishes; carry on.`,
              ...r.messages,
            ].join("\n");
          }
          case "status": {
            const cfg = svc.config(cwd);
            const jobs = await svc.list(cwd);
            const lines: string[] = [];
            if ("error" in cfg) lines.push(`Config error: ${cfg.error}`);
            else {
              lines.push(
                `Jobs (${cfg.source === "file" ? ".ezcoder/fleet.json" : "auto-detected"}): ${Object.keys(cfg.jobs).join(", ") || "none"}`,
                `Services: ${Object.keys(cfg.services).join(", ")}`,
              );
            }
            const active = jobs.filter((j) => !isFleetTerminal(j.state));
            const recent = jobs.filter((j) => isFleetTerminal(j.state)).slice(-6);
            lines.push(active.length ? "In progress:" : "Nothing in progress.");
            lines.push(...active.map((j) => `- ${describeFleetJob(j)}`));
            if (recent.length)
              lines.push("Recent:", ...recent.map((j) => `- ${describeFleetJob(j)}`));
            return lines.join("\n");
          }
          case "logs":
            if (!args.id) return "Error: logs needs id.";
            return await svc.logs(args.id);
          case "artifacts": {
            if (!args.id) return "Error: artifacts needs id.";
            const r = await svc.downloadArtifacts(args.id, args.out);
            return r.files.length
              ? `Downloaded ${r.files.length} file(s) to ${r.dir}:\n${r.files.slice(0, 30).join("\n")}`
              : "The job has no artifacts.";
          }
          case "cancel": {
            if (!args.id) return "Error: cancel needs id.";
            const j = await svc.cancel(args.id);
            return j ? describeFleetJob(j) : `No job ${args.id}.`;
          }
          case "service_up": {
            if (!args.name) return "Error: service_up needs name (e.g. llm, browser, dev).";
            const r = await svc.serviceUp(cwd, args.name, {
              ...(args.node ? { node: args.node } : {}),
              ...(args.uncommitted !== undefined ? { includeUncommitted: args.uncommitted } : {}),
            });
            if (args.use && r.service.kind === "browser") selectFleetBrowser(r.service.id);
            return [
              `${r.reused ? "Already running" : "Started"}: ${describeFleetService(r.service)}`,
              ...r.messages,
              ...(args.use && r.service.kind === "browser"
                ? ["The browser tool now uses this remote browser."]
                : []),
            ].join("\n");
          }
          case "service_down": {
            if (!args.name) return "Error: service_down needs name or id.";
            const s = await svc.serviceDown(args.name, cwd);
            return `Stopped ${s.id} on ${s.node}.`;
          }
          case "services": {
            const list = (await svc.serviceList(cwd)).filter((s) => s.state !== "stopped");
            return list.length
              ? list.map((s) => `- ${describeFleetService(s)}`).join("\n")
              : "No fleet services running.";
          }
          case "exec": {
            if (!args.command) return "Error: exec needs command.";
            const r = await svc.serviceExec(args.name ?? "dev", args.command, { cwd });
            const out = r.output.length > 20_000 ? `…\n${r.output.slice(-20_000)}` : r.output;
            return `exit ${r.exitCode}\n${out}`;
          }
        }
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  };
}
