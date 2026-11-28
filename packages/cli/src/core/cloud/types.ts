// Cloud agent environments as compute: Claude Code cloud sessions and Codex
// cloud tasks. Both are AI sandboxes (a model runs the commands), reached with
// the subscription sign-ins EZ Coder already holds, so nothing is installed
// and no extra login is needed. Used as a fallback when self-hosted machines
// are busy or offline: validation stages, one-off jobs and helper agents.

export type CloudProviderId = "claude-cloud" | "codex-cloud";

export const CLOUD_PROVIDER_IDS: readonly CloudProviderId[] = ["claude-cloud", "codex-cloud"];

export function isCloudProviderId(value: string): value is CloudProviderId {
  return (CLOUD_PROVIDER_IDS as readonly string[]).includes(value);
}

export const CLOUD_LABELS: Record<CloudProviderId, string> = {
  "claude-cloud": "Claude Code cloud",
  "codex-cloud": "Codex cloud",
};

/** Whether a provider can take work for a project right now, and why not. */
export interface CloudAvailability {
  id: CloudProviderId;
  available: boolean;
  /** Signed-in account, for display (email or plan). */
  account?: string;
  /** Environment tasks run in (Claude env_…, Codex environment id). */
  environmentId?: string;
  environmentName?: string;
  /** One line for `ezcoder cloud status` / `validate workers`. */
  detail: string;
  /** What the user can do once to make it available. */
  setupHint?: string;
  /** Plan usage was exhausted; cloud is benched until then (ISO). */
  limitedUntil?: string;
}

/** The code a task starts from. */
export interface CloudSource {
  /** Local repository root. */
  repoRoot: string;
  /** GitHub owner/name when the project has one. */
  repo?: string;
  /** Commit the work is based on (validation: the exact commit tested). */
  sha: string;
  /**
   * Binary patch of uncommitted work on top of `sha` (agents only). Its
   * result is the tree the task starts from.
   */
  patch?: Buffer;
  branch?: string;
}

export interface CloudTaskRequest {
  title: string;
  prompt: string;
  source: CloudSource;
  /** Model id (provider default when absent). */
  model?: string;
  /** Hard cap on agent turns (validation: a handful). */
  maxTurns?: number;
  /** Tools the cloud agent may not use (validation: no edits). */
  disallowedTools?: string[];
  /** Longest one command may run, minutes (validation: stage timeout). */
  commandTimeoutMinutes?: number;
  /**
   * Runner tasks: the one exact shell command the sandbox may run. When its
   * permission check pauses on that command, the provider approves it; any
   * other command it asks about is denied.
   */
  approveCommand?: string;
  /** A runner task: lean system prompt and the shell tool only. */
  runner?: boolean;
  /** Plain environment for the sandbox. Never secrets. */
  env?: Record<string, string>;
}

export interface CloudTaskHandle {
  provider: CloudProviderId;
  /** session_… (Claude) or task id (Codex). */
  id: string;
  url: string;
  /** Tree hash of the code the task started from (snapshot); used to build diffs. */
  baseTree?: string;
  /** Local commit (created with commit-tree) whose tree the task started from. */
  baseCommit?: string;
  /** Local repository the task came from (providers that build diffs with local git). */
  repoRoot?: string;
  /**
   * The one command permission prompts may approve (CloudTaskRequest.approveCommand),
   * kept on the handle so a restarted poller can rebuild it.
   */
  approveCommand?: string;
}

export type CloudTaskState =
  | "starting" // provisioning the sandbox
  | "running" // the agent is working
  | "idle" // the agent finished its turn and waits for input
  | "failed" // the sandbox or session failed
  | "cancelled";

/** A command the sandbox ran, as recorded by the provider's harness (not the model). */
export interface CloudCommandRecord {
  command: string;
  output: string;
  isError: boolean;
}

export interface CloudTaskStatus {
  state: CloudTaskState;
  /** Last assistant text of the latest turn. */
  finalText?: string;
  /** Commands recorded by the harness, oldest first. */
  commands: CloudCommandRecord[];
  /** Turns finished so far. */
  turns: number;
  /** Plan usage stopped the task, or nearly did. */
  usage?: { limited: boolean; utilization?: number; resetsAt?: string };
  /** Why the task failed, when it did. */
  error?: string;
  /** Activity for progress display: last tool name and its input. */
  activity?: { tool: string; input: Record<string, unknown> }[];
  usageTokens?: { input: number; output: number };
}

/** One cloud backend. Implementations must never put secrets into a task. */
export interface CloudProvider {
  readonly id: CloudProviderId;
  /** Signed in, plan allows it, environment ready for this project? */
  detect(project?: { repoRoot?: string; repo?: string }): Promise<CloudAvailability>;
  start(request: CloudTaskRequest): Promise<CloudTaskHandle>;
  status(handle: CloudTaskHandle): Promise<CloudTaskStatus>;
  /** Queue a follow-up message into the task. */
  send(handle: CloudTaskHandle, message: string): Promise<void>;
  /**
   * The task's changes as a binary patch against the tree it started from
   * (`handle.baseTree`); empty when it changed nothing.
   */
  diff(handle: CloudTaskHandle): Promise<Buffer>;
  /** Stop the current turn. */
  interrupt(handle: CloudTaskHandle): Promise<void>;
  /** Remove it from the user's task list (best effort). */
  archive(handle: CloudTaskHandle): Promise<void>;
}

export class CloudError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_signed_in"
      | "not_allowed"
      | "no_environment"
      | "usage_limited"
      | "too_large"
      | "http"
      | "unreachable"
      | "not_found",
    readonly status?: number,
    /** Usage limits: when it lifts (ISO). */
    readonly until?: string,
  ) {
    super(message);
    this.name = "CloudError";
  }
}
