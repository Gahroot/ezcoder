// Minimal in-process fleet node for tests: implements the protocol.ts routes
// the controller uses, on 127.0.0.1, with state the test drives directly.
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  FLEET_MIN_PROTOCOL,
  FLEET_PROTOCOL,
  PROTOCOL_HEADER,
  type DoctorReport,
  type JobRequest,
  type JobStatus,
  type NodeInfo,
  type ServiceRequest,
  type ServiceStatus,
  type UpdateRequest,
} from "../protocol.js";

export interface FakeNode {
  url: string;
  token: string;
  info: NodeInfo;
  jobs: Map<string, JobStatus>;
  requests: JobRequest[];
  serviceRequests: ServiceRequest[];
  services: Map<string, ServiceStatus>;
  logs: Map<string, string>;
  artifacts: Map<string, Map<string, string>>;
  cancelled: string[];
  sharedAuth: unknown[];
  /** Answer 429 to job submissions. */
  full: boolean;
  /** Seconds sent as Retry-After with the 429 (absent: no header). */
  retryAfter?: number;
  /** Answer every authed request with 426 protocol_mismatch (S3). */
  mismatch: false | "node" | "controller";
  /** Request headers of every call, in order. */
  headers: http.IncomingHttpHeaders[];
  /** GET /v1/doctor answer. */
  doctor: DoctorReport;
  /** repo query of each doctor call. */
  doctorRepos: (string | null)[];
  /** Valid single-use pairing code for POST /v1/pair (S9). */
  pairCode?: string;
  /** POST /v1/update bodies (S7). */
  updates: UpdateRequest[];
  /** The node already has model credentials: share-auth without force gets 409 (R8). */
  hasAuth: boolean;
  /** Pairing string for the current token. */
  pairing(): string;
  /** Accept a submitted job but drop the connection before answering. */
  dropSubmit: boolean;
  close(): Promise<void>;
}

export function nodeInfo(name: string, over: Partial<NodeInfo> = {}): NodeInfo {
  return {
    ezcoderNode: true,
    protocol: FLEET_PROTOCOL,
    minProtocol: FLEET_MIN_PROTOCOL,
    features: ["doctor", "log-query", "pair-code", "rotate-token"],
    name,
    version: "0.0.0-test",
    platform: "linux",
    hostname: name,
    arch: "x64",
    cpus: 8,
    memoryGb: 32,
    memoryFreeGb: 24,
    load: 0.1,
    diskFreeGb: 100,
    gpus: [],
    docker: true,
    labels: [],
    slots: 2,
    slotsUsed: 0,
    modelAuth: false,
    jobs: [],
    services: [],
    agents: [],
    ...over,
  };
}

export async function startFakeNode(
  name: string,
  over: Partial<NodeInfo> = {},
  token = "t".repeat(32),
): Promise<FakeNode> {
  const node = {
    url: "",
    close: async () => {},
    token,
    info: nodeInfo(name, over),
    jobs: new Map(),
    requests: [],
    serviceRequests: [],
    services: new Map(),
    logs: new Map(),
    artifacts: new Map(),
    cancelled: [],
    sharedAuth: [],
    full: false,
    mismatch: false,
    headers: [],
    doctor: {
      node: name,
      version: "0.0.0-test",
      protocol: FLEET_PROTOCOL,
      checks: [{ id: "docker", status: "ok", detail: "Docker 27 running" }],
      ok: true,
    },
    doctorRepos: [],
    updates: [],
    hasAuth: false,
    pairing: () => "",
    dropSubmit: false,
  } as FakeNode;
  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      const p = url.pathname;
      node.headers.push(req.headers);
      if (p === "/v1/hello") {
        const {
          ezcoderNode,
          protocol,
          minProtocol,
          features,
          name: n,
          version,
          platform,
        } = node.info;
        return json(res, 200, {
          ezcoderNode,
          protocol,
          minProtocol,
          features,
          name: n,
          version,
          platform,
        });
      }
      if (p === "/v1/pair" && req.method === "POST") {
        const { code } = JSON.parse(body || "{}") as { code?: string };
        if (!node.pairCode || code !== node.pairCode) {
          return json(res, 403, { error: "wrong or expired code", code: "bad_code" });
        }
        node.pairCode = undefined;
        return json(res, 200, { pairing: node.pairing() });
      }
      if (req.headers.authorization !== `Bearer ${node.token}`) {
        return json(res, 401, { error: "bad token" });
      }
      if (node.mismatch) {
        const controller = Number(req.headers[PROTOCOL_HEADER] ?? 1);
        return json(res, 426, {
          error: "protocol mismatch",
          code: "protocol_mismatch",
          update: node.mismatch,
          nodeProtocol: node.mismatch === "node" ? 1 : FLEET_PROTOCOL + 1,
          controllerProtocol: controller,
        });
      }
      if (p === "/v1/info") return json(res, 200, node.info);
      if (p === "/v1/doctor") {
        node.doctorRepos.push(url.searchParams.get("repo"));
        return json(res, 200, node.doctor);
      }
      if (p === "/v1/token/rotate" && req.method === "POST") {
        node.token = `rotated-${Math.random().toString(36).slice(2)}${"r".repeat(16)}`;
        return json(res, 200, { token: node.token, pairing: node.pairing() });
      }
      if (p === "/v1/update" && req.method === "POST") {
        const r = JSON.parse(body || "{}") as UpdateRequest;
        node.updates.push(r);
        return json(res, 202, {
          from: node.info.version,
          to: r.version ?? "9.9.9",
          restarting: true,
        });
      }
      if (p === "/v1/auth" && req.method === "POST") {
        const r = JSON.parse(body) as { force?: boolean };
        if (node.hasAuth && !r.force) {
          return json(res, 409, {
            error: "this node already has credentials for anthropic",
            code: "exists",
          });
        }
        node.sharedAuth.push(r);
        node.hasAuth = true;
        return json(res, 200, { ok: true });
      }
      if (p === "/v1/jobs" && req.method === "POST") {
        if (node.full) {
          res.writeHead(429, {
            "content-type": "application/json",
            ...(node.retryAfter !== undefined ? { "retry-after": String(node.retryAfter) } : {}),
          });
          return res.end(JSON.stringify({ error: "no free slot" }));
        }
        const r = JSON.parse(body) as JobRequest;
        node.requests.push(r);
        const st: JobStatus = node.jobs.get(r.id) ?? {
          id: r.id,
          kind: r.kind,
          project: r.project,
          state: "running",
          startedAt: new Date().toISOString(),
          logBytes: 0,
        };
        node.jobs.set(r.id, st);
        if (node.dropSubmit) return void res.destroy();
        return json(res, 200, st);
      }
      let m = /^\/v1\/jobs\/([^/]+)(?:\/(log|artifacts)(?:\/(.*))?)?$/.exec(p);
      if (m) {
        const id = decodeURIComponent(m[1]!);
        const st = node.jobs.get(id);
        if (!st) return json(res, 404, { error: "no such job" });
        if (m[2] === "log") {
          const log = node.logs.get(id) ?? "";
          const q = url.searchParams;
          const headers = {
            "content-type": "text/plain",
            "x-log-size": String(log.length),
            ...(st.logTruncated ? { "x-log-truncated": "1" } : {}),
          };
          res.writeHead(200, headers);
          if (q.has("tail") || q.has("grep")) {
            let lines = log.split("\n");
            if (lines.at(-1) === "") lines.pop();
            const grep = q.get("grep");
            if (grep) lines = lines.filter((l) => new RegExp(grep).test(l));
            const tail = Number(q.get("tail") ?? lines.length);
            return res.end(lines.slice(-tail).join("\n"));
          }
          const off = Number(q.get("offset") ?? 0);
          const limit = q.has("limit") ? Number(q.get("limit")) : undefined;
          return res.end(log.slice(off, limit !== undefined ? off + limit : undefined));
        }
        if (m[2] === "artifacts") {
          const file = node.artifacts.get(id)?.get(decodeURIComponent(m[3] ?? ""));
          if (file === undefined) return json(res, 404, { error: "no artifact" });
          res.writeHead(200);
          return res.end(file);
        }
        if (req.method === "DELETE") {
          node.cancelled.push(id);
          st.state = "cancelled";
        }
        return json(res, 200, st);
      }
      if (p === "/v1/services" && req.method === "POST") {
        const r = JSON.parse(body) as ServiceRequest;
        node.serviceRequests.push(r);
        const st: ServiceStatus = {
          id: r.id,
          kind: r.kind,
          state: "running",
          endpoints: r.ports.map((pt, i) => ({
            name: pt.name,
            url: `http://${name}.tailnet.test:${41000 + i}`,
          })),
        };
        node.services.set(r.id, st);
        return json(res, 200, st);
      }
      if (p === "/v1/services") return json(res, 200, [...node.services.values()]);
      m = /^\/v1\/services\/([^/]+)(?:\/(log|exec))?$/.exec(p);
      if (m) {
        const id = decodeURIComponent(m[1]!);
        const st = node.services.get(id);
        if (!st) return json(res, 404, { error: "no such service" });
        if (m[2] === "log") {
          res.writeHead(200);
          return res.end(`log of ${id}`);
        }
        if (m[2] === "exec") {
          const r = JSON.parse(body) as { command: string };
          return json(res, 200, { exitCode: 0, output: `ran: ${r.command}` });
        }
        if (req.method === "DELETE") {
          node.services.delete(id);
          return json(res, 200, { ok: true });
        }
        return json(res, 200, st);
      }
      json(res, 404, { error: "unknown route" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  node.url = `http://127.0.0.1:${port}`;
  node.pairing = () => `ezfleet://${name}@127.0.0.1:${port}#${node.token}`;
  node.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return node;
}
