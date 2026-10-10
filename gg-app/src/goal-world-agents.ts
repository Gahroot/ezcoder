// Who is in a Goal's world and what each one is doing, derived from the
// window's live state: GG Goals itself (the coordinator) from the main run's
// tool feed, and every worker it brought in from the transcript's sub-agent
// groups. Pure, so the world view and its tests share one mapping.

import type { FloorAgent } from "./critter-floor";
import { toolKindOf } from "./critter-tool-kind";
import type { LiveToolEntry } from "./LiveToolPanel";

/** Every kind of work the world can act out; each has its own station. */
export const WORK_KINDS = [
  "read",
  "search",
  "edit",
  "run",
  "web",
  "think",
  "ask",
  "delegate",
  "wait",
] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

export type WorldAgentStatus = "working" | "idle" | "done" | "error";

export interface WorldAgent {
  /** Stable identity: one critter per key for the world's lifetime. */
  readonly key: string;
  /** Named agent type ("researcher"…), which picks its critter. */
  readonly agentName: string | undefined;
  /** What the roster and announcements call it. */
  readonly name: string;
  readonly coordinator: boolean;
  readonly status: WorldAgentStatus;
  /** What it is doing now; null when it has nothing to do (it goes to the lounge). */
  readonly kind: WorkKind | null;
  /** The same in words, for the roster and screen readers. */
  readonly detail: string;
}

export const COORDINATOR_KEY = "gg-goals";

/** Coordinator tools that mean something other than their plain tool kind. */
const COORDINATOR_TOOLS: ReadonlyMap<string, WorkKind> = new Map<string, WorkKind>([
  ["ask_user", "ask"],
  ["spawn_agent", "delegate"],
  ["subagent", "delegate"],
  ["send_agent", "delegate"],
  ["wait_agent", "wait"],
  ["task_output", "wait"],
  ["tasks", "think"],
  ["checklist", "think"],
]);

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function baseName(value: string): string {
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? value;
}

function clip(value: string, max = 48): string {
  const single = value.replace(/\s+/g, " ");
  return single.length > max ? `${single.slice(0, max - 1)}\u2026` : single;
}

/** What a coordinator tool call is, as a kind of work. */
export function coordinatorKind(toolName: string): WorkKind {
  return COORDINATOR_TOOLS.get(toolName) ?? toolKindOf(toolName) ?? "think";
}

/** One line saying what a coordinator tool call is doing. */
export function describeTool(name: string, args: Readonly<Record<string, unknown>>): string {
  const path = text(args.file_path) ?? text(args.path);
  switch (coordinatorKind(name)) {
    case "read":
      return path ? `Reading ${clip(baseName(path), 40)}` : "Reading";
    case "edit":
      return path ? `Editing ${clip(baseName(path), 40)}` : "Editing";
    case "search": {
      const query = text(args.pattern) ?? text(args.query);
      return query ? `Searching for \u201c${clip(query, 32)}\u201d` : "Searching";
    }
    case "run": {
      const command = text(args.command);
      return command ? `Running ${clip(command, 40)}` : "Running a command";
    }
    case "web": {
      const query = text(args.query) ?? text(args.url);
      return query ? `Browsing ${clip(query, 40)}` : "Browsing the web";
    }
    case "ask":
      return "Asking you a question";
    case "delegate":
      return "Bringing in help";
    case "wait":
      return "Waiting on the team";
    case "think":
      return "Planning";
  }
}

function workerStatus(agent: FloorAgent): WorldAgentStatus {
  switch (agent.status) {
    case "running":
      return "working";
    case "idle":
      return "idle";
    case "done":
      return "done";
    case "error":
    case "interrupted":
      return "error";
  }
}

export interface WorldInput {
  /** The main run is in progress. */
  readonly running: boolean;
  /** The main run's recent tool calls, oldest first. */
  readonly liveTools: readonly LiveToolEntry[];
  /** GG Goals is waiting on an answer from the user. */
  readonly waitingOnUser: boolean;
  /** Every worker GG Goals brought in, as the critter floor sees them. */
  readonly workers: readonly FloorAgent[];
}

function coordinator(input: WorldInput): WorldAgent {
  const base = {
    key: COORDINATOR_KEY,
    agentName: undefined,
    name: "GG Goals",
    coordinator: true,
  };
  if (input.waitingOnUser) {
    return { ...base, status: "working", kind: "ask", detail: "Waiting for your answer" };
  }
  if (!input.running) {
    return { ...base, status: "idle", kind: null, detail: "Ready when you are" };
  }
  const current = [...input.liveTools].reverse().find((entry) => entry.status === "running");
  if (!current) return { ...base, status: "working", kind: "think", detail: "Planning" };
  return {
    ...base,
    status: "working",
    kind: coordinatorKind(current.name),
    detail: describeTool(current.name, current.args),
  };
}

/** Everyone in the world right now: GG Goals first, then its workers. */
export function collectWorldAgents(input: WorldInput): WorldAgent[] {
  const workers = input.workers.map((agent): WorldAgent => {
    const status = workerStatus(agent);
    const activity = agent.activity?.trim();
    const kind = status === "working" ? (toolKindOf(activity) ?? "think") : null;
    return {
      key: agent.key,
      agentName: agent.agentName,
      name: agent.label,
      coordinator: false,
      status,
      kind,
      detail:
        status === "done"
          ? "Finished"
          : status === "error"
            ? "Stopped"
            : activity
              ? clip(activity)
              : status === "working"
                ? "Thinking"
                : "Waiting for work",
    };
  });
  return [coordinator(input), ...workers];
}
