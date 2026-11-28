// `fleet` tool: send jobs and services to the user's other machines (nodes).
// Returns at once; results arrive later as notifications.
import { execFile } from "node:child_process";
import { z } from "zod";
import type { AgentTool } from "@prestyj/agent";
import type { AskUserRequest, AskUserResult } from "../core/ask-user.js";
import { selectFleetBrowser } from "../core/fleet/browser.js";
import { stripUrlCredentials } from "../core/fleet/git.js";
import type { JobKind } from "../core/fleet/protocol.js";
import {
  proposeFleetConfig,
  validateProposedConfig,
  writeFleetConfig,
} from "../core/fleet/propose-config.js";
import { FLEET_CONFIG_FILE, type FleetJobSpec } from "../core/fleet/project-config.js";
import {
  describeFleetJob,
  describeFleetService,
  describeNode,
  FleetService,
  type NodeSummary,
} from "../core/fleet/service.js";
import { isFleetTerminal, type FleetJob } from "../core/fleet/types.js";
import type { DoctorReport } from "../core/fleet/protocol.js";

/** A1: most copies one `run` may start. */
export const MAX_RUN_COUNT = 16;
const JOB_KINDS = ["build", "test", "browser", "render", "custom"] as const;

const FleetParams = z.object({
  action: z
    .enum([
      "nodes",
      "doctor",
      "run",
      "status",
      "logs",
      "artifacts",
      "cancel",
      "service_up",
      "service_down",
      "services",
      "exec",
      "propose_config",
      "apply_config",
    ])
    .describe(
      "nodes: machines and load. doctor: per node, usable or not and why. run: queue a project job, or an ad hoc `command`. status: jobs, queue position, why waiting. logs/artifacts/cancel: one job. service_up/service_down/services: long-running services (llm, browser, dev, ...). exec: run a command in a devenv service. propose_config: suggest .ezcoder/fleet.json from the project. apply_config: write it, only after the user approved it.",
    ),
  name: z
    .string()
    .optional()
    .describe(
      "run: job name (omit with command). service_up/service_down/exec: service name or id (exec default dev)",
    ),
  id: z.string().optional().describe("logs/artifacts/cancel: job id"),
  image: z
    .string()
    .optional()
    .describe("run with command: Docker image to run it in (else host shell)"),
  kind: z.enum(JOB_KINDS).optional().describe("run with command: job kind (default custom)"),
  timeout_minutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60)
    .optional()
    .describe("run with command: timeout (default 30)"),
  count: z
    .number()
    .int()
    .min(1)
    .max(MAX_RUN_COUNT)
    .optional()
    .describe(
      "run: start N copies at once, spread over free slots; each gets EZ_SHARD (1..N) and EZ_SHARD_TOTAL",
    ),
  tail: z.number().int().min(1).max(5000).optional().describe("logs: last N lines (after grep)"),
  offset: z.number().int().min(0).optional().describe("logs: bytes from this offset"),
  limit: z.number().int().min(1).optional().describe("logs: max bytes from offset"),
  grep: z.string().max(200).optional().describe("logs: JS regex; only matching lines"),
  repo: z.string().optional().describe("doctor: git URL to test access to (default: origin)"),
  config: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("apply_config: the fleet.json to write (default: the current proposal)"),
  approved: z
    .boolean()
    .optional()
    .describe("apply_config: the user approved this exact config (ask_user first)"),
  overwrite: z.boolean().optional().describe("apply_config: replace an existing fleet.json"),
  node: z
    .string()
    .optional()
    .describe(
      'run/service_up: pin a node (default: best fit). run also takes "cloud", "claude-cloud" or "codex-cloud"',
    ),
  uncommitted: z
    .boolean()
    .optional()
    .describe("run/service_up: include uncommitted changes as a patch"),
  command: z.string().optional().describe("run: ad hoc shell command. exec: shell command"),
  use: z.boolean().optional().describe("service_up browser: make the browser tool use it"),
  out: z.string().optional().describe("artifacts: download folder"),
});

export interface FleetToolOptions {
  /** Puts a question to the user (apply_config confirmation). Without it, `approved: true` is required. */
  ask?: (request: AskUserRequest) => Promise<AskUserResult>;
  /** `git remote get-url origin` (tests). */
  originUrl?: (cwd: string) => Promise<string | undefined>;
}

function gitOrigin(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) =>
    execFile("git", ["remote", "get-url", "origin"], { cwd, timeout: 5000 }, (err, out) =>
      resolve(err ? undefined : String(out).trim() || undefined),
    ),
  );
}

/** A6: queue position (1-based, across every project) and why the job waits. */
export function describeWaiting(j: FleetJob, all: readonly FleetJob[]): string | undefined {
  if (j.state !== "queued") return undefined;
  const queued = all
    .filter((x) => x.state === "queued")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const pos = queued.findIndex((x) => x.id === j.id) + 1;
  const why = j.summary?.startsWith("waiting") ? j.summary : "waiting for a node with room";
  return `queue position ${pos} of ${queued.length}; ${why}`;
}

/** A4: one block per node: usable or not, and what to do about it. */
export function describeNodeHealth(n: NodeSummary, report?: DoctorReport | string): string {
  const name = n.node.name;
  if (n.incompatible) {
    return `${name}: NOT USABLE (incompatible): ${n.incompatible}. Tell the user; no work is sent there.`;
  }
  if (!n.online || !n.info) {
    return (
      `${name}: NOT USABLE (unreachable${n.error ? `: ${n.error}` : ""}). ` +
      "Ask the user to check the machine is on, Tailscale is up there, and `ezcoder node serve` (or its login service) runs."
    );
  }
  const i = n.info;
  const problems: string[] = [];
  const notes: string[] = [];
  const free = Math.max(0, i.slots - i.slotsUsed);
  notes.push(
    `slots ${free}/${i.slots} free${free ? "" : " (full: work queues until a slot frees)"}`,
  );
  const labels = [...new Set([...i.labels, ...n.node.labels])];
  notes.push(`labels ${labels.join(",") || "none"}`);
  if (i.dockerOnly)
    notes.push("docker-only: no host-shell jobs or remote agents, give jobs an image");
  if (!i.docker) notes.push("no docker: only host-shell jobs");
  if (typeof report === "string") notes.push(`doctor: ${report}`);
  else if (report) {
    for (const c of report.checks) {
      if (c.status === "fail")
        problems.push(`${c.id}: ${c.detail}${c.fix ? ` (fix on ${name}: ${c.fix})` : ""}`);
      else if (c.status === "warn") notes.push(`${c.id}: ${c.detail}`);
    }
  }
  if (n.updateNotice) notes.push(n.updateNotice);
  const head = problems.length ? `${name}: NOT READY` : `${name}: usable`;
  return [`${head}; ${notes.join("; ")}`, ...problems.map((p) => `  - ${p}`)].join("\n");
}

export function createFleetTool(
  cwd: string,
  getService: () => FleetService = () => FleetService.shared(),
  toolOpts: FleetToolOptions = {},
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
            const [nodes, cloud] = await Promise.all([
              svc.nodes(),
              svc.cloudLines(cwd).catch(() => [] as string[]),
            ]);
            const lines = nodes.length
              ? nodes.map((n) => `- ${describeNode(n)}`)
              : ["No nodes paired. The user pairs one with `ezcoder fleet add`."];
            return [...lines, ...cloud.map((l) => `- ${l}`)].join("\n");
          }
          case "doctor": {
            const nodes = await svc.nodes();
            if (!nodes.length)
              return "No nodes paired. The user pairs one with `ezcoder fleet add`.";
            const repo = args.repo ?? (await (toolOpts.originUrl ?? gitOrigin)(cwd));
            const lines = await Promise.all(
              nodes.map(async (n) => {
                if (!n.online || n.incompatible) return describeNodeHealth(n);
                const report = await svc
                  .client(n.node)
                  .doctor(repo)
                  .catch(
                    (e: unknown) =>
                      `not available (${e instanceof Error ? e.message : String(e)}); an older node, update it with \`ezcoder node update\``,
                  );
                return describeNodeHealth(n, report);
              }),
            );
            return [
              ...(repo ? [`git access checked for ${stripUrlCredentials(repo)}`] : []),
              ...lines,
            ].join("\n");
          }
          case "run": {
            if (!args.name && !args.command) {
              return "Error: run needs name (a job from fleet status) or command (ad hoc).";
            }
            const name = args.name ?? "cmd";
            const spec: FleetJobSpec | undefined = args.command
              ? {
                  name,
                  kind: (args.kind ?? "custom") as JobKind,
                  command: args.command,
                  ...(args.image ? { docker: { image: args.image } } : {}),
                  timeoutMinutes: args.timeout_minutes ?? 30,
                }
              : undefined;
            const count = args.count ?? 1;
            const queued: string[] = [];
            const messages = new Set<string>();
            for (let index = 1; index <= count; index++) {
              const r = await svc.run(cwd, name, {
                ...(args.node ? { node: args.node } : {}),
                ...(args.uncommitted ? { includeUncommitted: true } : {}),
                ...(spec ? { spec } : {}),
                ...(count > 1 ? { shard: { index, total: count } } : {}),
              });
              queued.push(count > 1 ? `${r.job.id} (shard ${index}/${count})` : r.job.id);
              for (const m of r.messages) messages.add(m);
            }
            return [
              `Queued ${queued.join(", ")} (${name}${spec ? ": ad hoc command" : ""}). You'll be notified when ${count > 1 ? "each finishes" : "it finishes"}; carry on.`,
              ...messages,
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
            const all = active.some((j) => j.state === "queued") ? await svc.list() : [];
            const line = (j: FleetJob) => {
              const wait = describeWaiting(j, all);
              return `- ${describeFleetJob(j)}${wait ? ` [${wait}]` : ""}`;
            };
            const cloud = await svc.cloudLines(cwd).catch(() => [] as string[]);
            if (cloud.length) lines.push(...cloud);
            lines.push(active.length ? "In progress:" : "Nothing in progress.");
            lines.push(...active.map(line));
            if (recent.length)
              lines.push("Recent:", ...recent.map((j) => `- ${describeFleetJob(j)}`));
            return lines.join("\n");
          }
          case "logs": {
            if (!args.id) return "Error: logs needs id.";
            const query =
              args.tail !== undefined || args.grep !== undefined || args.limit !== undefined;
            if (!query) {
              return await svc.logs(
                args.id,
                args.offset !== undefined ? { offset: args.offset } : {},
              );
            }
            const job = await svc.get(args.id);
            if (!job) return `No job ${args.id}.`;
            const node = job.node ? await svc.registry.get(job.node) : undefined;
            if (!node || !job.remoteId || job.state === "queued") {
              // Not on a node (queued, or cloud): fall back to the plain log.
              return await svc.logs(
                args.id,
                args.offset !== undefined ? { offset: args.offset } : {},
              );
            }
            const slice = await svc.client(node).logs(job.remoteId, {
              ...(args.tail !== undefined ? { tail: args.tail } : {}),
              ...(args.offset !== undefined ? { offset: args.offset } : {}),
              ...(args.limit !== undefined ? { limit: args.limit } : {}),
              ...(args.grep ? { grep: args.grep } : {}),
            });
            const head = `[log ${slice.size} bytes${slice.truncated ? ", middle dropped (cap)" : ""}]`;
            return `${head}\n${slice.text || "(no matching output)"}`;
          }
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
          case "propose_config": {
            const p = proposeFleetConfig(cwd);
            return [
              `Proposed ${FLEET_CONFIG_FILE}${p.exists ? " (one exists already; applying replaces it, pass overwrite: true)" : ""}:`,
              JSON.stringify(p.config, null, 2),
              "Why:",
              ...p.reasons.map((r) => `- ${r}`),
              "Show it to the user and ask before apply_config; write nothing without their yes.",
            ].join("\n");
          }
          case "apply_config": {
            const proposal = proposeFleetConfig(cwd);
            const config = validateProposedConfig(args.config ?? proposal.config);
            if (proposal.exists && !args.overwrite) {
              return `Error: ${FLEET_CONFIG_FILE} already exists; pass overwrite: true once the user agreed to replace it.`;
            }
            if (toolOpts.ask) {
              const answer = await toolOpts.ask({
                questions: [
                  {
                    id: "apply",
                    kind: "confirm",
                    question: `Write ${FLEET_CONFIG_FILE}${proposal.exists ? " (replacing the current one)" : ""}?`,
                    detail: `Jobs: ${Object.keys(config.jobs).join(", ") || "none"}; defaults: ${
                      Object.entries(config.defaults)
                        .map(([k, v]) => `${k}=${v}`)
                        .join(", ") || "none"
                    }`,
                  },
                ],
              });
              if (answer.action === "answer" && answer.by === "ken") {
                // Writing project config is the user's call, not autopilot's.
                return `Not written: autopilot answered, but ${FLEET_CONFIG_FILE} needs the user's own yes. Ask them when they are back.`;
              }
              const yes = answer.action === "answer" && answer.answers.apply === "yes";
              if (!yes) return `The user did not approve; ${FLEET_CONFIG_FILE} was not written.`;
            } else if (args.approved !== true) {
              return `Error: not written. Show the config to the user, ask (ask_user), and call apply_config with approved: true only after they say yes.`;
            }
            const file = writeFleetConfig(cwd, config);
            return `Wrote ${file}. Jobs: ${Object.keys(config.jobs).join(", ") || "none"}.`;
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
