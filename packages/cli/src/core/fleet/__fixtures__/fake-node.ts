// Minimal in-process fleet node for tests: implements the protocol.ts routes
// the controller uses, on 127.0.0.1, with state the test drives directly.
import http from "node:http";
import type { AddressInfo } from "node:net";
import type {
  JobRequest,
  JobStatus,
  NodeInfo,
  ServiceRequest,
  ServiceStatus,
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
  close(): Promise<void>;
}

export function nodeInfo(name: string, over: Partial<NodeInfo> = {}): NodeInfo {
  return {
    ezcoderNode: true,
    protocol: 1,
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
      if (p === "/v1/hello") {
        const { ezcoderNode, protocol, name: n, version, platform } = node.info;
        return json(res, 200, { ezcoderNode, protocol, name: n, version, platform });
      }
      if (req.headers.authorization !== `Bearer ${node.token}`) {
        return json(res, 401, { error: "bad token" });
      }
      if (p === "/v1/info") return json(res, 200, node.info);
      if (p === "/v1/auth" && req.method === "POST") {
        node.sharedAuth.push(JSON.parse(body));
        return json(res, 200, { ok: true });
      }
      if (p === "/v1/jobs" && req.method === "POST") {
        if (node.full) return json(res, 429, { error: "no free slot" });
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
        return json(res, 200, st);
      }
      let m = /^\/v1\/jobs\/([^/]+)(?:\/(log|artifacts)(?:\/(.*))?)?$/.exec(p);
      if (m) {
        const id = decodeURIComponent(m[1]!);
        const st = node.jobs.get(id);
        if (!st) return json(res, 404, { error: "no such job" });
        if (m[2] === "log") {
          const log = node.logs.get(id) ?? "";
          const off = Number(url.searchParams.get("offset") ?? 0);
          res.writeHead(200, { "content-type": "text/plain", "x-log-size": String(log.length) });
          return res.end(log.slice(off));
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
  node.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return node;
}
