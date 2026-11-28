// Typed HTTP client for one node (protocol.ts). Every call has a timeout,
// carries the protocol/version headers (S3), and turns transport/HTTP problems
// into FleetClientError with a plain message. https nodes paired with a TLS
// pairing string (ezfleets, with a cert fingerprint) are pinned to that
// certificate (X10).
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { Readable, type Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import {
  FLEET_MIN_PROTOCOL,
  FLEET_PROTOCOL,
  PROTOCOL_HEADER,
  VERSION_HEADER,
  type AgentDiff,
  type AgentRequest,
  type AgentWorkspaceStatus,
  type DoctorReport,
  type ErrorResponse,
  type ExecRequest,
  type ExecResponse,
  type HelloResponse,
  type JobRequest,
  type JobStatus,
  type NodeInfo,
  type PairCodeResponse,
  type RotateTokenResponse,
  type ServiceRequest,
  type ServiceStatus,
  type ShareAuthRequest,
  type UpdateRequest,
  type UpdateResponse,
} from "./protocol.js";
import { NodeRegistry, normalizeFingerprint, type FleetNode } from "./registry.js";

export type FleetErrorCode =
  | "unreachable"
  | "timeout"
  | "auth"
  | "busy"
  | "not_found"
  | "bad_request"
  | "http"
  /** S3: the two sides speak no common protocol; `update` names the side to update. */
  | "incompatible"
  /** R8: the node already has credentials (409). */
  | "exists"
  /** S9: pairing code wrong, expired or used. */
  | "bad_code"
  | "rate_limited"
  /** X5: the node runs only containerised work. */
  | "docker_only"
  /** X10: the node's certificate is not the pinned one. */
  | "tls_mismatch";

export class FleetClientError extends Error {
  constructor(
    message: string,
    readonly code: FleetErrorCode,
    readonly status?: number,
    /** For "incompatible": which side must be updated. */
    readonly update?: "node" | "controller",
    /** For "busy": how long the node asked us to wait (Retry-After), ms. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "FleetClientError";
  }
}

let cachedVersion: string | undefined;

/** This machine's EZ Coder version (sent as VERSION_HEADER, compared with nodes for S7). */
export function controllerVersion(): string {
  if (cachedVersion) return cachedVersion;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as {
        name?: string;
        version?: string;
      };
      if (m.name === "@prestyj/cli" && m.version) return (cachedVersion = m.version);
    } catch {
      // keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return (cachedVersion = "0.0.0");
}

/** -1 / 0 / 1 for dotted versions ("1.2.10" > "1.2.9"); a pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", pre] = v.trim().replace(/^v/, "").split("-", 2);
    return { nums: core.split(".").map((x) => Number.parseInt(x, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export interface ProtocolProblem {
  update: "node" | "controller";
  message: string;
}

function protocolMessage(name: string, update: "node" | "controller", nodeProtocol: number) {
  const range =
    FLEET_MIN_PROTOCOL < FLEET_PROTOCOL
      ? `${FLEET_MIN_PROTOCOL}-${FLEET_PROTOCOL}`
      : String(FLEET_PROTOCOL);
  return update === "node"
    ? nodeProtocol < 2
      ? // Protocol-1 nodes predate `ezcoder node update`.
        `node ${name} speaks fleet protocol ${nodeProtocol} and this machine needs ${range}; update the node: on ${name} run \`npm i -g @prestyj/cli@latest\`, then restart \`ezcoder node serve\` (or its login service)`
      : `node ${name} speaks fleet protocol ${nodeProtocol} and this machine needs ${range}; update the node: run \`ezcoder node update\` on ${name}`
    : `node ${name} speaks fleet protocol ${nodeProtocol}, newer than this machine's ${FLEET_PROTOCOL}; update EZ Coder on this machine`;
}

/**
 * S3: can this controller work with a node that answered `hello`? Compatible
 * when the node's protocol is in our range, or the (newer) node still accepts
 * ours. Otherwise the side with the lower protocol must be updated.
 */
export function protocolProblem(
  name: string,
  hello: Pick<HelloResponse, "protocol" | "minProtocol">,
): ProtocolProblem | undefined {
  const p = Number(hello.protocol);
  if (!Number.isFinite(p) || p < FLEET_MIN_PROTOCOL) {
    return { update: "node", message: protocolMessage(name, "node", Number.isFinite(p) ? p : 1) };
  }
  if (p <= FLEET_PROTOCOL) return undefined;
  const nodeMin = Number(hello.minProtocol ?? p);
  if (nodeMin <= FLEET_PROTOCOL) return undefined;
  return { update: "controller", message: protocolMessage(name, "controller", p) };
}

/** Safe relative artifact path: no absolute paths, no `..`, no `.git` segment (R7). */
export function safeArtifactPath(p: string): string | undefined {
  const norm = p.replace(/\\/g, "/");
  if (norm.startsWith("/") || /^[A-Za-z]:/.test(norm)) return undefined;
  const parts = norm.split("/").filter((x) => x && x !== ".");
  if (!parts.length) return undefined;
  for (const x of parts) {
    if (x === "..") return undefined;
    // Windows ignores trailing dots and spaces: ".git." is ".git" there.
    if (x.replace(/[. ]+$/, "").toLowerCase() === ".git") return undefined;
    if (x.includes(":") || x.includes("\0")) return undefined;
  }
  return parts.join("/");
}

export class TlsPinError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`certificate fingerprint ${actual} is not the pinned ${expected}`);
    this.name = "TlsPinError";
  }
}

/**
 * An https Agent that accepts exactly one certificate: the one whose SHA-256
 * is `fingerprint` (self-signed node certs have no CA). The socket reaches the
 * request only after the check, so nothing (not even the token) is sent to an
 * impostor. Without a pin it only records the certificate seen (`onPeer`).
 */
export class PinnedTlsAgent extends https.Agent {
  constructor(
    private readonly fingerprint: string | undefined,
    private readonly onPeer?: (fingerprint: string) => void,
  ) {
    super({ keepAlive: false });
  }

  override createConnection(
    options: https.RequestOptions,
    callback?: (err: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    let done = false;
    const finish = (err: Error | null, socket: Duplex) => {
      if (done) return;
      done = true;
      callback?.(err, socket);
    };
    const host = String(options.hostname ?? options.host ?? "localhost").replace(/^\[|\]$/g, "");
    const isIp = /^[\d.]+$/.test(host) || host.includes(":");
    const socket = tls.connect({
      host,
      port: Number(options.port ?? 443),
      ...(isIp ? {} : { servername: options.servername ?? host }),
      rejectUnauthorized: false,
    });
    socket.once("secureConnect", () => {
      const actual = normalizeFingerprint(socket.getPeerCertificate()?.fingerprint256) ?? "";
      if (this.fingerprint && actual !== this.fingerprint) {
        const err = new TlsPinError(this.fingerprint, actual || "(none)");
        socket.destroy();
        finish(err, socket);
        return;
      }
      this.onPeer?.(actual);
      finish(null, socket);
    });
    socket.once("error", (e) => finish(e, socket));
    return undefined;
  }
}

/** fetch() over node:https with a given Agent (global fetch can't pin a self-signed cert). */
export function pinnedFetch(agent: https.Agent): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const req = https.request(
        url,
        {
          method: init?.method ?? "GET",
          headers,
          agent,
          ...(init?.signal ? { signal: init.signal } : {}),
        },
        (res) => {
          const h = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(", ") : v);
          }
          const status = res.statusCode ?? 502;
          const noBody = status === 204 || status === 304 || init?.method === "HEAD";
          if (noBody) res.resume();
          resolve(
            new Response(
              noBody ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>),
              { status, headers: h },
            ),
          );
        },
      );
      req.on("error", (e) => {
        if (init?.signal?.aborted) {
          reject((init.signal.reason as Error | undefined) ?? e);
          return;
        }
        reject(new TypeError("fetch failed", { cause: e }));
      });
      if (typeof init?.body === "string") req.write(init.body);
      req.end();
    })) as typeof fetch;
}

/** https Agent for WebSockets (`ws` option `agent`) to a pinned node. */
export function pinnedTlsAgent(fingerprint: string): https.Agent {
  return new PinnedTlsAgent(normalizeFingerprint(fingerprint) ?? fingerprint);
}

export interface FleetClientOptions {
  /** Per-request timeout (default 15 s). */
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Pinned TLS certificate (64 hex) for https nodes. */
  fingerprint?: string;
  /** https without a pin: report the certificate seen (pairing by code). */
  onPeerFingerprint?: (fingerprint: string) => void;
}

export interface LogQuery {
  /** Last N lines (after grep). */
  tail?: number;
  /** Bytes from this offset. */
  offset?: number;
  /** Max bytes from offset. */
  limit?: number;
  /** JS regex (max 200 chars) filtering lines on the node. */
  grep?: string;
}

export interface LogSlice {
  text: string;
  /** Whole log size in bytes (X-Log-Size). */
  size: number;
  /** The node capped the log and dropped its middle (R6). */
  truncated: boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function enc(id: string): string {
  return encodeURIComponent(id);
}

/** Retry-After (seconds or an HTTP date) in ms; undefined when absent or unreadable. Capped at 10 min. */
export function parseRetryAfter(v: string | null, now = Date.now()): number | undefined {
  if (!v) return undefined;
  const secs = Number(v.trim());
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(v) - now;
  if (!Number.isFinite(ms)) return undefined;
  return Math.min(10 * 60_000, Math.max(0, Math.round(ms)));
}

/** Pairing codes are 8 Crockford base32 characters, shown as XXXX-XXXX. */
export function normalizePairCode(code: string): string | undefined {
  const c = code.trim().toUpperCase().replace(/[\s-]/g, "");
  if (!/^[0-9A-Z]{8}$/.test(c)) return undefined;
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}

export class FleetClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;
  private readonly fingerprint: string | undefined;

  constructor(
    readonly name: string,
    baseUrl: string,
    private token: string | undefined,
    opts: FleetClientOptions = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fingerprint = normalizeFingerprint(opts.fingerprint);
    const httpsUrl = /^https:/i.test(this.baseUrl);
    this.doFetch =
      opts.fetch ??
      (httpsUrl && (this.fingerprint || opts.onPeerFingerprint)
        ? pinnedFetch(new PinnedTlsAgent(this.fingerprint, opts.onPeerFingerprint))
        : fetch);
  }

  static forNode(node: FleetNode, opts?: FleetClientOptions): FleetClient {
    return new FleetClient(node.name, node.url, node.token, {
      ...opts,
      ...(node.fingerprint ? { fingerprint: node.fingerprint } : {}),
    });
  }

  private where(): string {
    return `node ${this.name} (${this.baseUrl})`;
  }

  /** Raw request; throws FleetClientError for transport errors and non-2xx answers. */
  async request(
    method: string,
    route: string,
    opts: { body?: unknown; timeoutMs?: number; auth?: boolean } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      [PROTOCOL_HEADER]: String(FLEET_PROTOCOL),
      [VERSION_HEADER]: controllerVersion(),
    };
    if (opts.auth !== false && this.token) headers.authorization = `Bearer ${this.token}`;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    let res: Response;
    try {
      res = await this.doFetch(`${this.baseUrl}${route}`, {
        method,
        headers,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const err = e as Error & { code?: string; cause?: { code?: string; message?: string } };
      const pin =
        err instanceof TlsPinError ? err : err.cause instanceof TlsPinError ? err.cause : undefined;
      if (pin) {
        throw new FleetClientError(
          `${this.where()} presented a different TLS certificate than the one it was paired with (expected sha-256 ${pin.expected.slice(0, 16)}, got ${pin.actual.slice(0, 16)}); nothing was sent. Someone may be intercepting the connection, or the node made a new certificate: if you trust it, pair again with its new pairing string`,
          "tls_mismatch",
        );
      }
      if (err.name === "TimeoutError" || err.name === "AbortError") {
        throw new FleetClientError(
          `${this.where()} did not answer within ${Math.round(timeoutMs / 1000)} s`,
          "timeout",
        );
      }
      const why = err.cause?.code ?? err.code ?? err.cause?.message ?? err.message;
      throw new FleetClientError(
        `${this.where()} is unreachable (${why}); is it online and on the tailnet, and is \`ezcoder node serve\` running?`,
        "unreachable",
      );
    }
    if (res.ok) return res;
    let detail = "";
    let body: ErrorResponse | undefined;
    try {
      const text = await res.text();
      try {
        const parsed = JSON.parse(text) as unknown;
        if (parsed && typeof parsed === "object") body = parsed as ErrorResponse;
        detail = body?.error ?? text;
      } catch {
        detail = text;
      }
    } catch {
      // no body
    }
    detail = String(detail).trim().slice(0, 300);
    const wire = body?.code;
    if (res.status === 426 || wire === "protocol_mismatch") {
      const update =
        body?.update ?? ((body?.nodeProtocol ?? 0) > FLEET_PROTOCOL ? "controller" : "node");
      const nodeProtocol = body?.nodeProtocol ?? (update === "node" ? 1 : FLEET_PROTOCOL + 1);
      throw new FleetClientError(
        protocolMessage(this.name, update, nodeProtocol),
        "incompatible",
        res.status,
        update,
      );
    }
    if (wire === "bad_code") {
      throw new FleetClientError(
        `${this.where()} did not accept the pairing code: it is wrong, expired (codes last 10 minutes) or already used; run \`ezcoder node pair --code\` on that machine for a new one`,
        "bad_code",
        res.status,
      );
    }
    if (wire === "rate_limited") {
      throw new FleetClientError(
        `${this.where()} refused: too many wrong attempts; wait 10 minutes and try again`,
        "rate_limited",
        res.status,
      );
    }
    if (wire === "docker_only") {
      throw new FleetClientError(
        `${this.where()} runs only Docker work (it was started with --docker-only): give the job a Docker image; remote agents and host-shell jobs can't run there`,
        "docker_only",
        res.status,
      );
    }
    if (res.status === 409 || wire === "exists") {
      throw new FleetClientError(
        `${this.where()}: already exists${detail ? ` (${detail})` : ""}`,
        "exists",
        res.status,
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new FleetClientError(
        `${this.where()} rejected our token; pair again with \`ezcoder fleet add <pairing string>\``,
        "auth",
        res.status,
      );
    }
    if (res.status === 429) {
      throw new FleetClientError(
        `${this.where()} is full${detail ? `: ${detail}` : ""}`,
        "busy",
        429,
        undefined,
        parseRetryAfter(res.headers.get("retry-after")),
      );
    }
    if (res.status === 404) {
      throw new FleetClientError(
        `${this.where()}: not found${detail ? ` (${detail})` : ""}`,
        "not_found",
        404,
      );
    }
    const code: FleetErrorCode = res.status >= 400 && res.status < 500 ? "bad_request" : "http";
    throw new FleetClientError(
      `${this.where()} answered ${res.status}${detail ? `: ${detail}` : ""}`,
      code,
      res.status,
    );
  }

  private async json<T>(
    method: string,
    route: string,
    opts: { body?: unknown; timeoutMs?: number; auth?: boolean } = {},
  ): Promise<T> {
    const res = await this.request(method, route, opts);
    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new FleetClientError(`${this.where()} sent a non-JSON answer`, "http", res.status);
    }
  }

  // ── discovery / info ──────────────────────────────────────

  async hello(timeoutMs?: number): Promise<HelloResponse> {
    const h = await this.json<HelloResponse>("GET", "/v1/hello", {
      auth: false,
      ...(timeoutMs ? { timeoutMs } : {}),
    });
    if (!h || h.ezcoderNode !== true) {
      throw new FleetClientError(`${this.where()} is not an EZCODER node`, "bad_request");
    }
    return h;
  }

  /** hello plus the S3 protocol check: throws "incompatible" naming the side to update. */
  async handshake(timeoutMs?: number): Promise<HelloResponse> {
    const h = await this.hello(timeoutMs);
    const problem = protocolProblem(this.name, h);
    if (problem) {
      throw new FleetClientError(problem.message, "incompatible", undefined, problem.update);
    }
    return h;
  }

  info(): Promise<NodeInfo> {
    return this.json<NodeInfo>("GET", "/v1/info");
  }

  /** S1/A4: the node checks itself (Docker, GPU, git access to `repo`, login, disk, ...). */
  doctor(repo?: string): Promise<DoctorReport> {
    return this.json<DoctorReport>(
      "GET",
      `/v1/doctor${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`,
      { timeoutMs: 120_000 },
    );
  }

  /** S4: a new token on the node; the old one stops working at once. This client switches over. */
  async rotateToken(): Promise<RotateTokenResponse> {
    const r = await this.json<RotateTokenResponse>("POST", "/v1/token/rotate", { body: {} });
    if (!r?.token) throw new FleetClientError(`${this.where()} sent no new token`, "http");
    this.token = r.token;
    return r;
  }

  /** S7: ask the node to install another CLI version (default latest) and restart. */
  update(req: UpdateRequest = {}): Promise<UpdateResponse> {
    return this.json<UpdateResponse>("POST", "/v1/update", { body: req, timeoutMs: 600_000 });
  }

  /** S9: trade a short pairing code (no token needed) for the full pairing string. */
  pairWithCode(code: string): Promise<PairCodeResponse> {
    const c = normalizePairCode(code);
    if (!c) {
      throw new FleetClientError(
        `"${code.slice(0, 20)}" is not a pairing code (8 letters and digits, like K7QM-2XPA)`,
        "bad_request",
      );
    }
    return this.json<PairCodeResponse>("POST", "/v1/pair", { body: { code: c }, auth: false });
  }

  // ── jobs ──────────────────────────────────────────────────

  submitJob(req: JobRequest): Promise<JobStatus> {
    return this.json<JobStatus>("POST", "/v1/jobs", { body: req, timeoutMs: 120_000 });
  }

  job(id: string): Promise<JobStatus> {
    return this.json<JobStatus>("GET", `/v1/jobs/${enc(id)}`);
  }

  /** Log bytes from `offset`; `size` is the whole log's size (X-Log-Size). */
  async jobLog(id: string, offset = 0): Promise<{ text: string; size: number }> {
    const res = await this.request("GET", `/v1/jobs/${enc(id)}/log?offset=${Math.max(0, offset)}`);
    const text = await res.text();
    const size = Number(res.headers.get("x-log-size") ?? NaN);
    return { text, size: Number.isFinite(size) ? size : offset + Buffer.byteLength(text) };
  }

  /**
   * A slice of a job's log, cut on the node (A2): the last `tail` lines (after
   * `grep`), or `limit` bytes from `offset`. A tail never downloads the whole log.
   */
  async logs(id: string, q: LogQuery = {}): Promise<LogSlice> {
    const params = new URLSearchParams();
    if (q.tail !== undefined) params.set("tail", String(Math.max(1, Math.floor(q.tail))));
    if (q.offset !== undefined) params.set("offset", String(Math.max(0, Math.floor(q.offset))));
    if (q.limit !== undefined) params.set("limit", String(Math.max(1, Math.floor(q.limit))));
    if (q.grep) {
      if (q.grep.length > 200) {
        throw new FleetClientError("grep pattern is longer than 200 characters", "bad_request");
      }
      params.set("grep", q.grep);
    }
    const qs = params.toString();
    const res = await this.request("GET", `/v1/jobs/${enc(id)}/log${qs ? `?${qs}` : ""}`);
    const text = await res.text();
    const size = Number(res.headers.get("x-log-size") ?? NaN);
    return {
      text,
      size: Number.isFinite(size) ? size : (q.offset ?? 0) + Buffer.byteLength(text),
      truncated: res.headers.get("x-log-truncated") === "1",
    };
  }

  /** Download one artifact to `dest`: streamed to a temp file, then renamed (R7). */
  async downloadArtifact(id: string, artifactPath: string, dest: string): Promise<number> {
    const rel = safeArtifactPath(artifactPath);
    if (!rel) throw new Error(`refusing unsafe artifact path "${artifactPath}"`);
    const route = rel
      .split("/")
      .map((s) => encodeURIComponent(s))
      .join("/");
    const res = await this.request("GET", `/v1/jobs/${enc(id)}/artifacts/${route}`, {
      timeoutMs: 30 * 60_000,
    });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.part-${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
      if (!res.body) fs.writeFileSync(tmp, "", { flag: "wx" });
      else {
        await pipeline(
          Readable.fromWeb(res.body as WebReadableStream),
          fs.createWriteStream(tmp, { flags: "wx" }),
        );
      }
      fs.renameSync(tmp, dest);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    return fs.statSync(dest).size;
  }

  cancelJob(id: string, purge = false): Promise<JobStatus> {
    return this.json<JobStatus>("DELETE", `/v1/jobs/${enc(id)}${purge ? "?purge=1" : ""}`);
  }

  // ── services ──────────────────────────────────────────────

  services(): Promise<ServiceStatus[]> {
    return this.json<ServiceStatus[]>("GET", "/v1/services");
  }

  service(id: string): Promise<ServiceStatus> {
    return this.json<ServiceStatus>("GET", `/v1/services/${enc(id)}`);
  }

  startService(req: ServiceRequest): Promise<ServiceStatus> {
    return this.json<ServiceStatus>("POST", "/v1/services", { body: req, timeoutMs: 120_000 });
  }

  async stopService(id: string): Promise<void> {
    await this.request("DELETE", `/v1/services/${enc(id)}`, { timeoutMs: 60_000 });
  }

  async serviceLog(id: string, tail = 200): Promise<string> {
    const res = await this.request("GET", `/v1/services/${enc(id)}/log?tail=${tail}`);
    return res.text();
  }

  exec(id: string, req: ExecRequest): Promise<ExecResponse> {
    return this.json<ExecResponse>("POST", `/v1/services/${enc(id)}/exec`, {
      body: req,
      timeoutMs: ((req.timeoutSeconds ?? 300) + 15) * 1000,
    });
  }

  // ── agents (used by remote sub-agents) ───────────────────

  createAgent(req: AgentRequest): Promise<AgentWorkspaceStatus> {
    return this.json<AgentWorkspaceStatus>("POST", "/v1/agents", {
      body: req,
      timeoutMs: 300_000,
    });
  }

  agentDiff(id: string): Promise<AgentDiff> {
    return this.json<AgentDiff>("GET", `/v1/agents/${enc(id)}/diff`, { timeoutMs: 120_000 });
  }

  async deleteAgent(id: string): Promise<void> {
    await this.request("DELETE", `/v1/agents/${enc(id)}`);
  }

  /** WebSocket URL + headers for GET /v1/agents/:id/attach (`agent` pins TLS nodes). */
  attachTarget(id: string): {
    url: string;
    headers: Record<string, string>;
    agent?: https.Agent;
  } {
    return {
      url: `${this.baseUrl.replace(/^http/, "ws")}/v1/agents/${enc(id)}/attach`,
      headers: {
        [PROTOCOL_HEADER]: String(FLEET_PROTOCOL),
        [VERSION_HEADER]: controllerVersion(),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      ...(this.fingerprint ? { agent: new PinnedTlsAgent(this.fingerprint) } : {}),
    };
  }

  // ── auth sharing (opt-in) ────────────────────────────────

  /** Throws FleetClientError "exists" (409) when the node has credentials and `force` is unset (R8). */
  async shareAuth(req: ShareAuthRequest): Promise<void> {
    await this.request("POST", "/v1/auth", { body: req });
  }
}

export interface NodeLookupOptions extends FleetClientOptions {
  /** Fleet dir holding nodes.json (tests). */
  dir?: string;
}

/** A client for a paired node by name; throws when the name isn't paired. */
export async function nodeClient(name: string, opts: NodeLookupOptions = {}): Promise<FleetClient> {
  const reg = new NodeRegistry(opts.dir);
  const node = await reg.get(name);
  if (!node) {
    const names = (await reg.list()).map((n) => n.name);
    throw new Error(
      `no paired node "${name}"${names.length ? ` (paired: ${names.join(", ")})` : "; pair one with ezcoder fleet add"}`,
    );
  }
  return FleetClient.forNode(node, opts);
}

const INFO_TTL_MS = 15_000;
const infoCache = new Map<string, { at: number; info: Promise<NodeInfo> }>();

/** Live node info, cached ~15 s per node (failures are not cached). */
export async function getNodeInfo(
  name: string,
  opts: NodeLookupOptions & { force?: boolean } = {},
): Promise<NodeInfo> {
  const client = await nodeClient(name, opts);
  const key = `${client.name}|${client.baseUrl}`;
  const hit = infoCache.get(key);
  if (!opts.force && hit && Date.now() - hit.at < INFO_TTL_MS) return hit.info;
  const info = client.info();
  infoCache.set(key, { at: Date.now(), info });
  info.catch(() => {
    if (infoCache.get(key)?.info === info) infoCache.delete(key);
  });
  return info;
}

/** Forget cached node info (after dispatching, tests). */
export function clearNodeInfoCache(name?: string): void {
  if (!name) infoCache.clear();
  else for (const k of [...infoCache.keys()]) if (k.startsWith(`${name}|`)) infoCache.delete(k);
}

export { listNodes } from "./registry.js";
