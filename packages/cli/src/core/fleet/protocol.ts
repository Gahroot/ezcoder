// Fleet protocol: the HTTP/WebSocket contract between EZCODER on the user's
// main machine ("controller") and `ezcoder node serve` on every other machine
// ("node"). Nodes are reached over a private network (Tailscale); every call
// except GET /v1/hello carries `Authorization: Bearer <node token>`.
//
// Shared by the node server (core/fleet/node/*) and the controller client
// (core/fleet/client.ts). Change only additively; bump FLEET_PROTOCOL on breaks.

export const FLEET_PROTOCOL = 2;
/**
 * Oldest peer protocol this build still talks to (S3). Controller and node
 * each accept a peer whose protocol is in [FLEET_MIN_PROTOCOL, FLEET_PROTOCOL];
 * outside that range the side with the LOWER protocol must be updated.
 */
export const FLEET_MIN_PROTOCOL = 2;
/** Request headers the controller sends on every call (S3). */
export const PROTOCOL_HEADER = "x-ezcoder-protocol";
export const VERSION_HEADER = "x-ezcoder-version";
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
  /** Oldest controller protocol this node accepts (absent on protocol-1 nodes). */
  minProtocol?: number;
  /** Optional capabilities, e.g. "doctor", "log-query", "pair-code", "tls", "goals", "rotate-token". */
  features?: string[];
  /** Node refuses host-shell jobs and remote agents (X5, `serve --docker-only`). */
  dockerOnly?: boolean;
  /** SHA-256 fingerprint (hex, colon-free) of the TLS cert when serving https (X10). */
  tlsFingerprint?: string;
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
  /** Run `git submodule update --init --recursive` after checkout (R11). Default true when .gitmodules exists. */
  submodules?: boolean;
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
  /** Max log bytes kept (R6, default 200 MB); beyond it head and tail are kept. */
  logCapBytes?: number;
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
  /** The log hit its cap; the middle was dropped (R6). */
  logTruncated?: boolean;
  /** Why a job is still waiting on the node, e.g. "waiting for a free slot" (A6). */
  waitingReason?: string;
}

// GET /v1/jobs/:id -> JobStatus
// GET /v1/jobs/:id/log?offset=N -> text/plain (bytes from offset); header X-Log-Size
// GET /v1/jobs/:id/log?tail=N[&grep=RE] -> last N lines (after grep filter); A2.
//   ?offset=N&limit=B returns at most B bytes from offset. ?grep=RE (JS regex, max 200 chars)
//   filters lines server-side. The node never sends the whole log for tail/grep queries.
//   Headers: X-Log-Size (total bytes), X-Log-Truncated: 1 when capped.
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
  /** Git-ignored files the agent changed; NOT in the patch (R9). */
  ignoredChanged?: string[];
}

/** POST /v1/auth (opt-in `ezcoder fleet share-auth`): provider credentials for the node's own ~/.ezcoder/auth.json. */
export interface ShareAuthRequest {
  /** Raw auth.json entries keyed by provider id. */
  credentials: Record<string, unknown>;
  /** Overwrite providers the node already has credentials for (R8). Without it: 409 code "exists". */
  force?: boolean;
}

export type FleetErrorCodeWire =
  | "protocol_mismatch" // S3: see ProtocolMismatch fields
  | "docker_only" // X5: host-shell job or agent refused
  | "exists" // R8
  | "bad_code" // S9: pairing code wrong/expired/used
  | "rate_limited"
  | "busy" // every slot is taken: 429 with Retry-After; queue and retry, don't fail
  | "secrets_refused"
  | "bad_request";

export interface ErrorResponse {
  error: string;
  /** Machine-readable reason (absent on older nodes). */
  code?: FleetErrorCodeWire;
  /** S3 only: which side must be updated so both speak a common protocol. */
  update?: "node" | "controller";
  nodeProtocol?: number;
  controllerProtocol?: number;
}

// ---- S3: protocol handshake ----
// The controller sends PROTOCOL_HEADER + VERSION_HEADER on every request. A node
// answers 426 with ErrorResponse{code:"protocol_mismatch", update, nodeProtocol,
// controllerProtocol} when the controller protocol is outside its range. The
// controller checks HelloResponse.protocol itself on pairing and every poll and
// refuses (with the same "update node|controller" wording) before sending work.
// A missing header (very old controller) is treated as protocol 1.

// ---- S1/A4: GET /v1/doctor?repo=<git url> ----
export type DoctorCheckId =
  | "tailscale"
  | "docker"
  | "gpu"
  | "git"
  | "model_login"
  | "disk"
  | "version"
  | "slots"
  | "keychain";
export interface DoctorCheck {
  id: DoctorCheckId;
  status: "ok" | "warn" | "fail" | "skip";
  /** One line, plain words: what was found. */
  detail: string;
  /** One line, a concrete fix (command to run) when status is warn/fail. */
  fix?: string;
}
export interface DoctorReport {
  node: string;
  version: string;
  protocol: number;
  checks: DoctorCheck[];
  /** true when no check is "fail". */
  ok: boolean;
}

// ---- S4/D5: POST /v1/token/rotate (auth: current token) ----
// Issues a new token, persists it, and invalidates the old one for every later
// request (in-flight WebSockets on the old token are closed). Returns:
export interface RotateTokenResponse {
  token: string;
  /** Fresh pairing string with the new token. */
  pairing: string;
}

// ---- S9: short-code pairing ----
// `ezcoder node pair --code` prints an 8-char code (e.g. "K7QM-2XPA", Crockford
// base32), valid 10 minutes, single use. Also printed as a QR of the pairing
// string. POST /v1/pair (no auth) body PairCodeRequest -> PairCodeResponse;
// wrong code -> 403 code "bad_code"; >5 bad attempts per 10 min -> 429 "rate_limited".
export interface PairCodeRequest {
  code: string;
}
export interface PairCodeResponse {
  /** Full pairing string (ezfleet://...#token, or ezfleets:// for TLS). */
  pairing: string;
}

// ---- S7: POST /v1/update {version?} (auth) ----
// Node installs the requested CLI version (default: latest) with its own package
// manager, then restarts its login service. Returns 202 {from, to}; refuses while
// jobs/agents run unless {force:true}.
export interface UpdateRequest {
  version?: string;
  force?: boolean;
}
export interface UpdateResponse {
  from: string;
  to: string;
  restarting: boolean;
}

// ---- R9 additions to AgentDiff are in AgentDiff.ignoredChanged ----

// ---- GL4: whole Goals hosted on a node (feature "goals") ----
// POST /v1/goals GoalHostRequest -> GoalHostStatus (prepares a workspace like an
// agent, then runs the Goal controller headless there, surviving controller
// disconnects and node restarts). GET /v1/goals -> GoalHostStatus[];
// GET /v1/goals/:id -> GoalHostStatus; GET /v1/goals/:id/log?tail=N;
// DELETE /v1/goals/:id -> stop. On finish the node pushes the result branch
// `ezcoder/goal/<id>` to origin with its own git credentials (GL6).
export interface GoalHostRequest {
  id: string;
  project: string;
  source: SourceSpec;
  /** The serialized goal definition (as stored in the goal store). */
  goal: unknown;
  /** Branch to push the result to (default ezcoder/goal/<id>). */
  resultBranch?: string;
}
export interface GoalHostStatus {
  id: string;
  project: string;
  state: "preparing" | "running" | "done" | "failed" | "stopped" | "lost";
  summary?: string;
  /** Pushed result branch once done. */
  resultBranch?: string;
  resultSha?: string;
  startedAt: string;
  finishedAt?: string;
}
