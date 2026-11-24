// `ezcoder node serve`: the HTTP server every fleet node runs. Implements the
// contract in ../protocol.ts (hello/info, jobs, services, share-auth) and hands
// every other request — and every authenticated WebSocket upgrade — to route
// modules (agents.ts) through the NodeContext seam in context.ts.
import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { AuthStorage, type OAuthCredentials } from "@prestyj/core";
import {
  FLEET_PROTOCOL,
  type ExecRequest,
  type GpuInfo,
  type HelloResponse,
  type JobRequest,
  type NodeInfo,
  type ServiceRequest,
  type ShareAuthRequest,
} from "../protocol.js";
import type { NodeConfig, NodeContext, NodeRouteModule } from "./context.js";
import { defaultExec, type NodeExec } from "./exec.js";
import {
  cliVersion,
  detectGpus,
  detectPlatform,
  diskFreeGb,
  dockerAvailable,
  machineSnapshot,
  Probe,
} from "./info.js";
import { JobManager, type SlotTable } from "./jobs.js";
import { ServiceManager } from "./services.js";
import { StateStore } from "./state.js";
import { prepareWorkspace } from "./workspace.js";

/** JSON bodies up to 64 MB (base64 patches are capped at 50 MB). */
export const MAX_BODY_BYTES = 64 * 1024 * 1024;

export interface NodeServerOptions {
  config: NodeConfig;
  exec?: NodeExec;
  /** Route modules; when omitted, ./agents.js is loaded if it exists. */
  modules?: NodeRouteModule[];
  log?: (msg: string) => void;
  /** auth.json the node uses for model credentials (default ~/.ezcoder/auth.json). */
  authFile?: string;
  /** Override the CLI entry used to spawn `--subagent-worker`. */
  cliEntry?: string;
  /** Override probes (tests). */
  dockerAvailable?: () => Promise<boolean>;
  gpus?: () => Promise<GpuInfo[]>;
  /** Job tuning (tests). */
  jobPollMs?: number;
  jobSecondsPerMinute?: number;
  killGraceSeconds?: number;
  freePort?: (host: string) => Promise<number>;
}

export interface NodeServer {
  url: string;
  port: number;
  jobs: JobManager;
  services: ServiceManager;
  context: NodeContext;
  close(): Promise<void>;
}

class Slots implements SlotTable {
  private owners = new Set<string>();
  constructor(private readonly max: () => number) {}
  acquire(owner: string, force = false): boolean {
    if (this.owners.has(owner)) return true;
    if (!force && this.owners.size >= this.max()) return false;
    this.owners.add(owner);
    return true;
  }
  release(owner: string): void {
    this.owners.delete(owner);
  }
  get used(): number {
    return this.owners.size;
  }
}

/** Constant-time bearer token check (hash both sides so lengths match). */
export function tokenMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!m || !token) return false;
  const a = createHash("sha256").update(m[1]!.trim()).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > limit) {
      req.resume();
      reject(new HttpError(413, "request body too large"));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on("data", (c: Buffer) => {
      if (failed) return;
      size += c.length;
      if (size > limit) {
        failed = true;
        reject(new HttpError(413, "request body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (failed) return;
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, "invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
  });
  res.end(data);
}

function defaultCliEntry(): string {
  // dist/core/fleet/node/server.js -> dist/cli.js
  return fileURLToPath(new URL("../../../cli.js", import.meta.url));
}

/** Load ./agents.js (written separately) if present; tolerate absence. */
async function loadDefaultModules(log: (m: string) => void): Promise<NodeRouteModule[]> {
  const spec = "./agents.js";
  let mod: Record<string, unknown>;
  try {
    mod = (await import(/* @vite-ignore */ spec)) as Record<string, unknown>;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (
      code !== "ERR_MODULE_NOT_FOUND" &&
      !/Cannot find|Failed to load|not found/i.test(String(e))
    ) {
      log(`agents module failed to load: ${(e as Error).message}`);
    }
    return [];
  }
  const isModule = (v: unknown): v is NodeRouteModule =>
    Boolean(v) && typeof (v as NodeRouteModule).handle === "function";
  const candidates = [mod.default, ...Object.values(mod)];
  for (const c of candidates) if (isModule(c)) return [c];
  for (const [name, c] of Object.entries(mod)) {
    if (typeof c === "function" && /^create/i.test(name)) {
      try {
        const made = await (c as () => unknown)();
        if (isModule(made)) return [made];
      } catch (e) {
        log(`agents module factory ${name} failed: ${(e as Error).message}`);
      }
    }
  }
  return [];
}

export async function startNodeServer(opts: NodeServerOptions): Promise<NodeServer> {
  const config = opts.config;
  const exec = opts.exec ?? defaultExec;
  const log = opts.log ?? ((m: string) => process.stderr.write(`[ezcoder node] ${m}\n`));
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });

  const slots = new Slots(() => config.slots);
  const state = new StateStore(config.dataDir);
  const dockerProbe = new Probe(opts.dockerAvailable ?? (() => dockerAvailable(exec)), 30_000);
  const platform = detectPlatform();
  const gpuProbe = new Probe(
    opts.gpus ?? (() => detectGpus(exec, platform)),
    platform === "macos" ? 300_000 : 10_000,
  );
  const auth = new AuthStorage(opts.authFile);

  const context: NodeContext = {
    config,
    acquireSlot: (owner) => slots.acquire(owner),
    releaseSlot: (owner) => slots.release(owner),
    prepareWorkspace: (kind, id, source) =>
      prepareWorkspace({ dataDir: config.dataDir, kind, id, source, exec }),
    cliEntry: () => opts.cliEntry ?? defaultCliEntry(),
    json: sendJson,
    log,
  };

  const jobs = new JobManager({
    config,
    state,
    exec,
    slots,
    log,
    dockerAvailable: () => dockerProbe.get(),
    pollMs: opts.jobPollMs,
    secondsPerMinute: opts.jobSecondsPerMinute,
    killGraceSeconds: opts.killGraceSeconds,
  });
  const services = new ServiceManager({
    config,
    state,
    exec,
    log,
    dockerAvailable: () => dockerProbe.get(),
    freePort: opts.freePort,
  });
  await jobs.init();
  await services.init();
  const modules = opts.modules ?? (await loadDefaultModules(log));

  const hello = (): HelloResponse => ({
    ezcoderNode: true,
    protocol: FLEET_PROTOCOL,
    name: config.name,
    version: cliVersion(),
    platform,
  });

  const info = async (): Promise<NodeInfo> => {
    const [gpus, docker, disk, providers] = await Promise.all([
      gpuProbe.get().catch(() => [] as GpuInfo[]),
      dockerProbe.get().catch(() => false),
      diskFreeGb(config.dataDir),
      auth.listProviders().catch(() => [] as string[]),
    ]);
    const labels = [...config.labels];
    if (gpus.length && !labels.includes("gpu")) labels.push("gpu");
    return {
      ...hello(),
      ...machineSnapshot(),
      diskFreeGb: disk,
      gpus,
      docker,
      labels,
      slots: config.slots,
      slotsUsed: slots.used,
      modelAuth: providers.length > 0,
      jobs: jobs.list(),
      services: services.snapshot(),
      agents: modules.flatMap((m) => m.agents?.() ?? []),
    };
  };

  const shareAuth = async (body: ShareAuthRequest): Promise<string[]> => {
    const creds = body?.credentials;
    if (!creds || typeof creds !== "object" || Array.isArray(creds)) {
      throw new HttpError(400, "credentials must be an object keyed by provider id");
    }
    const stored: string[] = [];
    for (const [provider, value] of Object.entries(creds)) {
      if (!/^[A-Za-z0-9:._-]{1,128}$/.test(provider)) continue;
      if (["__proto__", "constructor", "prototype"].includes(provider)) continue;
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      await auth.setCredentials(provider, value as OAuthCredentials);
      stored.push(provider);
    }
    // Names only — never values.
    log(`share-auth: stored credentials for ${stored.join(", ") || "nothing"}`);
    return stored;
  };

  const route = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const method = req.method ?? "GET";
    const p = url.pathname.replace(/\/+$/, "") || "/";
    const parts = p.split("/").slice(1); // ["v1", ...]

    if (p === "/v1/info" && method === "GET") return sendJson(res, 200, await info());

    if (p === "/v1/auth" && method === "POST") {
      const stored = await shareAuth((await readBody(req)) as ShareAuthRequest);
      return sendJson(res, 200, { ok: true, providers: stored });
    }

    // ── jobs ──
    if (parts[0] === "v1" && parts[1] === "jobs") {
      if (parts.length === 2) {
        if (method === "GET") return sendJson(res, 200, jobs.list());
        if (method === "POST") {
          const r = await jobs.submit((await readBody(req)) as JobRequest);
          return sendJson(res, r.status, r.body);
        }
      }
      const id = decodeURIComponent(parts[2] ?? "");
      if (parts.length === 3) {
        if (method === "GET") {
          const s = jobs.get(id);
          return s ? sendJson(res, 200, s) : sendJson(res, 404, { error: "no such job" });
        }
        if (method === "DELETE") {
          const purge = ["1", "true"].includes(url.searchParams.get("purge") ?? "");
          const s = purge ? await jobs.purge(id) : await jobs.cancel(id);
          return s ? sendJson(res, 200, s) : sendJson(res, 404, { error: "no such job" });
        }
      }
      if (parts.length === 4 && parts[3] === "log" && method === "GET") {
        const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
        const chunk = jobs.readLog(id, offset);
        if (!chunk) return sendJson(res, 404, { error: "no such job" });
        res.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "content-length": chunk.data.length,
          "x-log-size": String(chunk.size),
          "cache-control": "no-store",
        });
        res.end(chunk.data);
        return;
      }
      if (parts[3] === "artifacts" && method === "GET") {
        const s = jobs.get(id);
        if (!s) return sendJson(res, 404, { error: "no such job" });
        if (parts.length === 4) return sendJson(res, 200, s.artifacts ?? []);
        const rel = parts.slice(4).map(decodeURIComponent).join("/");
        const file = jobs.artifactFile(id, rel);
        if (!file) return sendJson(res, 404, { error: "no such artifact" });
        const size = fs.statSync(file).size;
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": size,
          "content-disposition": `attachment; filename="${path.basename(file).replace(/"/g, "")}"`,
        });
        fs.createReadStream(file).pipe(res);
        return;
      }
    }

    // ── services ──
    if (parts[0] === "v1" && parts[1] === "services") {
      if (parts.length === 2) {
        if (method === "GET") return sendJson(res, 200, await services.list());
        if (method === "POST") {
          const r = await services.submit((await readBody(req)) as ServiceRequest);
          return sendJson(res, r.status, r.body);
        }
      }
      const id = decodeURIComponent(parts[2] ?? "");
      if (parts.length === 3) {
        if (method === "GET") {
          const s = await services.get(id);
          return s ? sendJson(res, 200, s) : sendJson(res, 404, { error: "no such service" });
        }
        if (method === "DELETE") {
          const s = await services.remove(id);
          return s ? sendJson(res, 200, s) : sendJson(res, 404, { error: "no such service" });
        }
      }
      if (parts.length === 4 && parts[3] === "log" && method === "GET") {
        const text = await services.logs(id, Number(url.searchParams.get("tail") ?? 500));
        if (text === undefined) return sendJson(res, 404, { error: "no such service" });
        res.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(text);
        return;
      }
      if (parts.length === 4 && parts[3] === "exec" && method === "POST") {
        const r = await services.execIn(id, (await readBody(req)) as ExecRequest);
        return sendJson(res, r.status, r.body);
      }
    }

    for (const m of modules) {
      if (await m.handle(context, req, res, url)) return;
    }
    sendJson(res, 404, { error: `no route for ${method} ${p}` });
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://node.invalid");
    if (url.pathname === "/v1/hello" && (req.method ?? "GET") === "GET") {
      return sendJson(res, 200, hello());
    }
    if (!tokenMatches(req.headers.authorization, config.token)) {
      req.resume();
      return sendJson(res, 401, { error: "unauthorized" });
    }
    route(req, res, url).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log(`error on ${req.method} ${url.pathname}: ${(e as Error).message}`);
      if (!res.headersSent)
        sendJson(res, status, { error: (e as Error).message ?? "internal error" });
      else res.destroy();
    });
  });
  server.requestTimeout = 0; // large patch uploads on slow links
  server.headersTimeout = 60_000;

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://node.invalid");
    const reject = (code: number, text: string) => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (!tokenMatches(req.headers.authorization, config.token)) return reject(401, "Unauthorized");
    for (const m of modules) {
      try {
        if (m.upgrade?.(context, req, socket, head, url)) return;
      } catch (e) {
        log(`upgrade error on ${url.pathname}: ${(e as Error).message}`);
        return reject(500, "Internal Server Error");
      }
    }
    reject(404, "Not Found");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.bind || undefined, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : config.port;
  const host = config.bind && config.bind !== "0.0.0.0" ? config.bind : "127.0.0.1";
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
  log(
    `node "${config.name}" listening on ${url} (slots ${config.slots}, labels ${config.labels.join(",") || "-"})`,
  );

  return {
    url,
    port,
    jobs,
    services,
    context,
    async close() {
      jobs.close();
      services.close();
      for (const m of modules) await m.close?.().catch(() => {});
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
