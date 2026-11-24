// Fleet protocol: the HTTP/WebSocket contract between EZCODER on the user's
// main machine ("controller") and `ezcoder node serve` on every other machine
// ("node"). Nodes are reached over a private network (Tailscale); every call
// except GET /v1/hello carries `Authorization: Bearer <node token>`.
//
// Shared by the node server (core/fleet/node/*) and the controller client
// (core/fleet/client.ts). Change only additively; bump FLEET_PROTOCOL on breaks.

export const FLEET_PROTOCOL = 1;
export const DEFAULT_NODE_PORT = 7377;

/** Platform family the node runs on. */
export type NodePlatform = "linux" | "wsl2" | "macos" | "windows";

export interface GpuInfo {
  name: string;
  memoryGb: number;
  /** Currently used memory, GB (from nvidia-smi / system tools). */
  memoryUsedGb?: number;
  utilizationPct?: number;
  vendor: "nvidia" | "amd" | "apple" | "other";
}

/** GET /v1/hello (no auth): enough to recognise an EZCODER node during discovery. */
export interface HelloResponse {
  ezcoderNode: true;
  protocol: number;
  name: string;
  version: string;
  platform: NodePlatform;
}

/** Live resources, GET /v1/info. */
export interface NodeInfo extends HelloResponse {
  hostname: string;
  arch: string;
  cpus: number;
  memoryGb: number;
  memoryFreeGb: number;
  /** 1-minute load average divided by cpus (0..n). */
  load: number;
  diskFreeGb: number;
  gpus: GpuInfo[];
  docker: boolean;
  /** User-assigned labels, e.g. "deploy", "render". "gpu" is added automatically when gpus exist. */
  labels: string[];
  /** Max concurrent jobs + agents (services don't take slots). */
  slots: number;
  slotsUsed: number;
  /** Has its own model credentials (ezcoder login done or shared). */
  modelAuth: boolean;
  jobs: JobStatus[];
  services: ServiceStatus[];
  agents: AgentWorkspaceStatus[];
}

export interface Resources {
  cpus?: number;
  memoryGb?: number;
  /** GPUs needed (0/undefined = none). */
  gpus?: number;
  /** Min GPU memory per GPU, GB. */
  gpuMemoryGb?: number;
  /** Labels the node must carry. */
  labels?: string[];
}

/**
 * Where the code comes from. The node clones `git` (with its own git/gh
 * credentials) into a fresh per-job folder at exactly `sha`, then applies
 * `patch` (output of `git diff --binary <sha>` incl. intent-to-add untracked
 * files) when given, so uncommitted local work can run remotely too.
 */
export interface SourceSpec {
  git: string;
  sha: string;
  /** base64 of a binary git patch against `sha`. Max 50 MB. */
  patch?: string;
  /** Sub-folder of the repo to work in. */
  subdir?: string;
}

/** How a command is wrapped in Docker on the node (absent = run on the host shell). */
export interface DockerSpec {
  image?: string;
  /** Build this Dockerfile (path relative to the workspace) and run in it. */
  dockerfile?: string;
  compose?: string;
  service?: string;
  entrypoint?: string;
  /** Pass GPUs through (--gpus all). */
  gpu?: boolean;
  /** Extra docker run args (validated: no --privileged, no host network). */
  args?: string[];
}

export type JobKind = "validate" | "build" | "test" | "browser" | "render" | "deploy" | "custom";

/** POST /v1/jobs. Idempotent on `id` (re-posting an existing id returns its status). */
export interface JobRequest {
  id: string;
  kind: JobKind;
  /** Project identity, used for cache keys and isolation. */
  project: string;
  source?: SourceSpec;
  command: string;
  docker?: DockerSpec;
  env?: Record<string, string>;
  /** Names of node-local secrets to expose as env vars. Never values. Only nodes labelled "deploy" accept these. */
  secrets?: string[];
  timeoutMinutes: number;
  resources?: Resources;
  /** Globs (relative to the workspace) collected as artifacts when the job ends. */
  artifacts?: string[];
  /** Cache key; defaults to a sanitized `project`. Mounted at /cache (docker) or exported as EZ_CACHE. */
  cacheKey?: string;
}

export type NodeJobState =
  | "preparing"
  | "running"
  | "passed"
  | "failed"
  | "error"
  | "cancelled"
  /** The node restarted while the job ran and could not re-adopt it. */
  | "lost";

export interface ArtifactInfo {
  path: string;
  bytes: number;
}

export interface JobStatus {
  id: string;
  kind: JobKind;
  project: string;
  state: NodeJobState;
  exitCode?: number;
  summary?: string;
  startedAt?: string;
  finishedAt?: string;
  artifacts?: ArtifactInfo[];
  logBytes: number;
}

// GET /v1/jobs/:id -> JobStatus
// GET /v1/jobs/:id/log?offset=N -> text/plain (bytes from offset); header X-Log-Size
// GET /v1/jobs/:id/artifacts/<path> -> file bytes
// DELETE /v1/jobs/:id -> cancel (JobStatus); DELETE /v1/jobs/:id?purge=1 removes workspace+artifacts

export type ServiceKind = "inference" | "browser" | "devenv" | "custom";

export interface PortSpec {
  /** Port inside the container (or on the host for host services). */
  container: number;
  /** Logical name, e.g. "openai", "playwright", "http". */
  name: string;
  protocol?: "http" | "ws" | "tcp";
}

/** POST /v1/services. Long-running containers reachable on the node's tailnet address. */
export interface ServiceRequest {
  id: string;
  kind: ServiceKind;
  project?: string;
  source?: SourceSpec;
  docker: DockerSpec;
  command?: string;
  env?: Record<string, string>;
  ports: PortSpec[];
  resources?: Resources;
  /** Named volume kept across restarts (models, browsers, home dir). */
  persist?: string;
  /** Stop automatically after this many idle minutes (0 = never). */
  idleStopMinutes?: number;
}

export type ServiceState = "starting" | "running" | "stopped" | "error";

export interface ServiceEndpoint {
  name: string;
  /** e.g. http://my-pc.tailnet.ts.net:41234 */
  url: string;
}

export interface ServiceStatus {
  id: string;
  kind: ServiceKind;
  project?: string;
  state: ServiceState;
  endpoints: ServiceEndpoint[];
  summary?: string;
  startedAt?: string;
}

// GET /v1/services -> ServiceStatus[]; GET /v1/services/:id; DELETE /v1/services/:id (stop+remove)
// GET /v1/services/:id/log?tail=N -> text/plain
// POST /v1/services/:id/exec  ExecRequest -> ExecResponse (devenv/custom only)

export interface ExecRequest {
  command: string;
  timeoutSeconds?: number;
  cwd?: string;
}
export interface ExecResponse {
  exitCode: number;
  output: string;
}

/**
 * Remote agents. POST /v1/agents {id, source, project} prepares an isolated
 * workspace (clone at sha + patch). GET upgrade /v1/agents/:id/attach (WebSocket)
 * spawns `ezcoder --subagent-worker` there (if not already running) and bridges
 * its stdio: every text frame is JSON AgentFrame. The process survives a dropped
 * socket for AGENT_DETACH_GRACE_MS so the controller can re-attach.
 * GET /v1/agents/:id/diff -> AgentDiff (changes vs the prepared base, binary patch).
 * DELETE /v1/agents/:id -> kill the process and remove the workspace.
 */
export interface AgentRequest {
  id: string;
  project: string;
  source: SourceSpec;
  /** Extra env for the worker (never model credentials). */
  env?: Record<string, string>;
}

export interface AgentWorkspaceStatus {
  id: string;
  project: string;
  state: "ready" | "running" | "exited" | "error";
  /** Absolute workspace path on the node. */
  cwd: string;
  pid?: number;
  exitCode?: number;
  createdAt: string;
}

export type AgentFrame =
  | { t: "stdin"; data: string }
  | { t: "stdout"; data: string }
  | { t: "stderr"; data: string }
  | { t: "exit"; code: number | null; signal?: string | null }
  | { t: "kill"; signal?: string };

export const AGENT_DETACH_GRACE_MS = 10 * 60_000;

export interface AgentDiff {
  /** base64 binary patch (`git diff --binary <base>` after `git add -A -N`), "" when unchanged. */
  patch: string;
  files: string[];
  base: string;
}

/** POST /v1/auth (opt-in `ezcoder fleet share-auth`): provider credentials for the node's own ~/.ezcoder/auth.json. */
export interface ShareAuthRequest {
  /** Raw auth.json entries keyed by provider id. */
  credentials: Record<string, unknown>;
}

export interface ErrorResponse {
  error: string;
}
