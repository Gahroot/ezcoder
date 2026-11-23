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
  /** Pin one backend id; otherwise the first fitting, available one is used. */
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
}

export interface BackendPollResult {
  state: Exclude<JobState, "queued" | "superseded">;
  url?: string;
  summary?: string;
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
