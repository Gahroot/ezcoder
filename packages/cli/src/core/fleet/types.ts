// Controller-side records for fleet jobs and services (~/.ezcoder/fleet).
import type {
  ArtifactInfo,
  DockerSpec,
  JobKind,
  Resources,
  ServiceEndpoint,
  ServiceKind,
  ServiceState,
} from "./protocol.js";

export type FleetJobState =
  | "queued" // waiting for a node with room
  | "preparing" // accepted by a node, cloning / pulling
  | "running"
  | "passed"
  | "failed"
  | "error" // infrastructure problem, not a command failure
  | "cancelled";

const TERMINAL: ReadonlySet<FleetJobState> = new Set(["passed", "failed", "error", "cancelled"]);

export function isFleetTerminal(state: FleetJobState): boolean {
  return TERMINAL.has(state);
}

/** Kinds that are safe to run again elsewhere after a node loss. Never deploy. */
export const REQUEUE_KINDS: ReadonlySet<JobKind> = new Set([
  "validate",
  "build",
  "test",
  "browser",
  "render",
  "custom",
]);

/** Most dispatches a job gets before a lost node becomes an error. */
export const FLEET_MAX_ATTEMPTS = 3;

export interface FleetRequeue {
  at: string;
  from: string;
  reason: string;
}

export interface FleetJob {
  id: string;
  /** Job name from the project config (build, e2e, ...). */
  name: string;
  kind: JobKind;
  /** Absolute project folder on this machine. */
  project: string;
  /** Project identity sent to nodes (owner/name or folder name). */
  projectKey: string;
  git: string;
  sha: string;
  /** Commit the patch applies to (the newest pushed ancestor), when uncommitted work is sent. */
  base?: string;
  /** A patch of local changes is sent (stored beside jobs.json, not inline). */
  hasPatch?: boolean;
  subdir?: string;
  command: string;
  docker?: DockerSpec;
  env?: Record<string, string>;
  secrets?: string[];
  resources?: Resources;
  artifactGlobs?: string[];
  cacheKey?: string;
  timeoutMinutes: number;
  /** deploy with `"gate": false`. */
  ungated?: boolean;
  state: FleetJobState;
  createdAt: string;
  updatedAt: string;
  /** Node the job runs (or ran) on. */
  node?: string;
  /** Pinned with --node; requeues keep the pin. */
  pinned?: boolean;
  /** Id used on the node (changes per attempt, so a retry never collides). */
  remoteId?: string;
  dispatchedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  summary?: string;
  artifacts?: ArtifactInfo[];
  /** Where artifacts were downloaded. */
  artifactsDir?: string;
  /** Override for artifactsDir (`--out`). */
  outDir?: string;
  attempts?: number;
  requeues?: FleetRequeue[];
  avoid?: string[];
  /** First failed poll of a dispatched job (node unreachable). */
  unreachableSince?: string;
  /** Set once we've said the node looks down. */
  nodeDownWarned?: boolean;
  /** Set once we've said nothing can run it right now. */
  waitWarned?: boolean;
  notifiedState?: FleetJobState;
}

export interface FleetServiceRecord {
  /** Id on the node. */
  id: string;
  /** Service name from the config (llm, browser, dev, ...). */
  name: string;
  kind: ServiceKind;
  node: string;
  /** Project folder it was started from. */
  project?: string;
  state: ServiceState;
  endpoints: ServiceEndpoint[];
  summary?: string;
  createdAt: string;
  updatedAt: string;
  /** Local model endpoint registered for an inference service. */
  localEndpointId?: string;
  unreachableSince?: string;
  nodeDownWarned?: boolean;
  notifiedState?: ServiceState;
}
