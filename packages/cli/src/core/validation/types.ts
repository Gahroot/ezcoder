// Shared types for asynchronous validation: project stages, jobs and the
// execution backends they run on. Projects describe *what* to validate;
// backends (configured per user, not per project) decide *where*.

/** Where a stage runs: on this machine for quick feedback, or on a worker. */
export type StageRun = "local" | "remote";

/** How a stage's command is wrapped in Docker on the worker. */
export interface DockerSpec {
  /** Compose file; the command runs in `service` via `docker compose run`. */
  compose?: string;
  service?: string;
  /** Override the service entrypoint ("" clears it). */
  entrypoint?: string;
  /** Plain image instead of compose: `docker run <image>` with the repo mounted at /w. */
  image?: string;
}

/** What a stage needs from a worker; used to pick a backend that fits. */
export interface Resources {
  cpus?: number;
  memoryGb?: number;
  /** Labels the backend must carry (e.g. "gpu"). */
  labels?: string[];
}

export interface StageConfig {
  name: string;
  command: string;
  run: StageRun;
  /** Required stages gate merges and releases. */
  required: boolean;
  timeoutMinutes: number;
  /** Shell run before the (possibly dockerized) command, outside the container. */
  setup?: string;
  docker?: DockerSpec;
  resources?: Resources;
  /** Pin one backend id or one pool machine (`pool/machine`); otherwise the best fitting one is used. */
  backend?: string;
}

export interface ProjectValidationConfig {
  /** GitHub owner/name; detected from the `origin` remote when omitted. */
  repo?: string;
  stages: StageConfig[];
  /** Commit-status context prefix; stage `test` posts `ezcoder/test`. */
  statusContextPrefix: string;
  /** Cancel a running job when a newer commit on the same branch is validated. */
  cancelSuperseded: boolean;
  /** Post GitHub commit statuses (usable as required checks). */
  postCommitStatus: boolean;
  /** "file" when read from .ezcoder/validation.json, "auto" when detected. */
  source: "file" | "auto";
  /** Why the defaults are what they are (shown by `validate status`). */
  notes: string[];
}

export type JobState =
  | "queued" // waiting for a free slot in EZCODER
  | "waiting" // handed to the backend, not started (worker busy or offline)
  | "running"
  | "passed"
  | "failed"
  | "error" // infrastructure problem, not a test failure
  | "cancelled"
  | "superseded"; // a newer commit on the same branch replaced it

export const TERMINAL_STATES: ReadonlySet<JobState> = new Set([
  "passed",
  "failed",
  "error",
  "cancelled",
  "superseded",
]);

export function isTerminal(state: JobState): boolean {
  return TERMINAL_STATES.has(state);
}

export interface ValidationJob {
  id: string;
  /** Absolute project folder. */
  project: string;
  repo?: string;
  /** Full commit SHA the result belongs to. */
  sha: string;
  branch?: string;
  stage: string;
  run: StageRun;
  required: boolean;
  /** Final shell command (docker wrapping applied). */
  command: string;
  timeoutMinutes: number;
  backend: string;
  resources?: Resources;
  statusContext?: string;
  state: JobState;
  createdAt: string;
  updatedAt: string;
  dispatchedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  /** Backend handle (GitHub run id, local pid) and its page. */
  runId?: string;
  url?: string;
  summary?: string;
  /** Local stages: the work tree had uncommitted changes, so the result is advisory only. */
  dirty?: boolean;
  /** Last state a notification went out for. */
  notifiedState?: JobState;
  /** Last commit-status state posted. */
  postedStatus?: string;
  /** A superseded run was told to stop on its worker. */
  stopSent?: boolean;
  /** Set once we've warned that the worker looks offline. */
  offlineWarned?: boolean;
  supersededBy?: string;
  /** Previous job this one retries. */
  retryOf?: string;
  /** Pool machine the job was sent to (or pinned to); "cloud" for GitHub-hosted overflow. */
  machine?: string;
  /** The stage pinned `backend` (and maybe `machine`); requeues keep the pin. */
  pinned?: boolean;
  /** Dispatch attempts so far (1 when absent); runner losses requeue up to MAX_ATTEMPTS. */
  attempts?: number;
  /** Automatic requeues after a lost runner or an offline machine. */
  requeues?: JobRequeue[];
  /** Targets (`pool/machine` or backend id) a requeued job should avoid if it can. */
  avoid?: string[];
  /** When the job's machine was first seen offline while the run was still waiting. */
  machineOfflineSince?: string;
  /** Set once we've said that no worker is online for this job. */
  noWorkerWarned?: boolean;
}

export interface JobRequeue {
  at: string;
  /** Where the lost run was (`pool/machine` or backend id). */
  from: string;
  runId?: string;
  reason: string;
}

/** Most dispatches a job gets before a lost runner becomes an error. */
export const MAX_ATTEMPTS = 3;

export interface BackendPollResult {
  state: Exclude<JobState, "queued" | "superseded">;
  url?: string;
  summary?: string;
  /** The run ended because its runner/machine was lost (not a test result): why. */
  lost?: string;
  /** GitHub refused to start the run (Actions budget, billing, spending limit): why. */
  blocked?: string;
}

/** One schedulable machine of a pool backend (a group of runners, or cloud runners). */
export interface MachineInfo {
  /** Machine id (the `ezw-` label without prefix, the backend id, or "cloud"). */
  name: string;
  online: boolean;
  /** GitHub-hosted runners: always online, cost Actions minutes. */
  cloud?: boolean;
  /** Cloud used only when no self-hosted machine is online. */
  overflowOnly?: boolean;
  /** Max concurrent EZCODER jobs. */
  slots: number;
  /** Online runners GitHub reports busy (any job, ours or not). */
  busy: number;
  platform: string[];
  capacity?: Resources;
  /** Workflow `runs_on` input that lands a run on this machine. */
  runsOn: string[];
  /** Discovery failed; static capacity/maxConcurrent assumed. */
  assumed?: boolean;
  detail: string;
}

export interface BackendHealth {
  online: boolean;
  busy?: boolean;
  detail: string;
}

/** An execution backend. Adding one never requires changing projects. */
export interface ValidationBackend {
  readonly id: string;
  readonly kind: string;
  readonly runs: StageRun;
  readonly maxConcurrent: number;
  readonly capacity?: Resources;
  dispatch(job: ValidationJob): Promise<{ runId?: string; url?: string }>;
  poll(job: ValidationJob): Promise<BackendPollResult>;
  logs(job: ValidationJob, failedOnly: boolean): Promise<string>;
  cancel(job: ValidationJob): Promise<void>;
  health(): Promise<BackendHealth>;
  /** Pools only: the machines behind this backend (discovery is cached). */
  readonly machines?: () => Promise<MachineInfo[]>;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Exec = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number },
) => Promise<ExecResult>;
