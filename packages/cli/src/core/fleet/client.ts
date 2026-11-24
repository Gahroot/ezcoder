// Typed HTTP client for one node (protocol.ts). Every call has a timeout and
// turns transport/HTTP problems into FleetClientError with a plain message.
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type {
  AgentDiff,
  AgentRequest,
  AgentWorkspaceStatus,
  ExecRequest,
  ExecResponse,
  HelloResponse,
  JobRequest,
  JobStatus,
  NodeInfo,
  ServiceRequest,
  ServiceStatus,
  ShareAuthRequest,
} from "./protocol.js";
import { NodeRegistry, type FleetNode } from "./registry.js";

export type FleetErrorCode =
  "unreachable" | "timeout" | "auth" | "busy" | "not_found" | "bad_request" | "http";

export class FleetClientError extends Error {
  constructor(
    message: string,
    readonly code: FleetErrorCode,
    readonly status?: number,
  ) {
    super(message);
    this.name = "FleetClientError";
  }
}

export interface FleetClientOptions {
  /** Per-request timeout (default 15 s). */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function enc(id: string): string {
  return encodeURIComponent(id);
}

export class FleetClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;

  constructor(
    readonly name: string,
    baseUrl: string,
    private readonly token: string | undefined,
    opts: FleetClientOptions = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.doFetch = opts.fetch ?? fetch;
  }

  static forNode(node: FleetNode, opts?: FleetClientOptions): FleetClient {
    return new FleetClient(node.name, node.url, node.token, opts);
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
    const headers: Record<string, string> = {};
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
      const err = e as Error & { cause?: { code?: string; message?: string } };
      if (err.name === "TimeoutError" || err.name === "AbortError") {
        throw new FleetClientError(
          `${this.where()} did not answer within ${Math.round(timeoutMs / 1000)} s`,
          "timeout",
        );
      }
      const why = err.cause?.code ?? err.cause?.message ?? err.message;
      throw new FleetClientError(
        `${this.where()} is unreachable (${why}); is it online and on the tailnet, and is \`ezcoder node serve\` running?`,
        "unreachable",
      );
    }
    if (res.ok) return res;
    let detail = "";
    try {
      const text = await res.text();
      try {
        detail = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        detail = text;
      }
    } catch {
      // no body
    }
    detail = detail.trim().slice(0, 300);
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

  info(): Promise<NodeInfo> {
    return this.json<NodeInfo>("GET", "/v1/info");
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

  /** Download one artifact to `dest` (streamed). */
  async downloadArtifact(id: string, artifactPath: string, dest: string): Promise<number> {
    const route = artifactPath
      .split("/")
      .filter(Boolean)
      .map((s) => encodeURIComponent(s))
      .join("/");
    const res = await this.request("GET", `/v1/jobs/${enc(id)}/artifacts/${route}`, {
      timeoutMs: 30 * 60_000,
    });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (!res.body) {
      fs.writeFileSync(dest, "");
      return 0;
    }
    await pipeline(Readable.fromWeb(res.body as WebReadableStream), fs.createWriteStream(dest));
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

  /** WebSocket URL + headers for GET /v1/agents/:id/attach. */
  attachTarget(id: string): { url: string; headers: Record<string, string> } {
    return {
      url: `${this.baseUrl.replace(/^http/, "ws")}/v1/agents/${enc(id)}/attach`,
      headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
    };
  }

  // ── auth sharing (opt-in) ────────────────────────────────

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
