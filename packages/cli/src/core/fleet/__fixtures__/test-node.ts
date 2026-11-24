// Test harness: a minimal node HTTP server around the agents route module, on
// 127.0.0.1, with a git-clone prepareWorkspace and a fake worker entry.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NodeContext, NodeRouteModule } from "../node/context.js";
import { createAgentRouteModule, type AgentRoutesOptions } from "../node/agents.js";
import type { NodeInfo } from "../protocol.js";

export const FAKE_WORKER = fileURLToPath(new URL("./fake-remote-worker.mjs", import.meta.url));
export const TEST_TOKEN = "test-token";

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
}

/** A bare origin + a clone with one pushed commit (a.txt, b.txt, sub/c.txt). */
export function makeRepo(root: string): { origin: string; local: string; sha: string } {
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  fs.mkdirSync(seed, { recursive: true });
  sh(root, "init", "--bare", "-b", "main", origin);
  sh(seed, "init", "-b", "main");
  sh(seed, "config", "user.email", "t@example.com");
  sh(seed, "config", "user.name", "Test");
  sh(seed, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(seed, "a.txt"), "a\n");
  fs.writeFileSync(path.join(seed, "b.txt"), "b\n");
  fs.mkdirSync(path.join(seed, "sub"));
  fs.writeFileSync(path.join(seed, "sub", "c.txt"), "c\n");
  sh(seed, "add", "-A");
  sh(seed, "commit", "-m", "init");
  sh(seed, "remote", "add", "origin", `file://${origin}`);
  sh(seed, "push", "-u", "origin", "main");
  const local = path.join(root, "local");
  sh(root, "clone", `file://${origin}`, local);
  sh(local, "config", "user.email", "t@example.com");
  sh(local, "config", "user.name", "Test");
  sh(local, "config", "commit.gpgsign", "false");
  return { origin, local, sha: sh(local, "rev-parse", "HEAD").trim() };
}

export interface TestNode {
  url: string;
  module: NodeRouteModule;
  dataDir: string;
  slotsUsed(): number;
  info: Partial<NodeInfo>;
  close(): Promise<void>;
}

export async function startTestNode(
  dataDir: string,
  options: AgentRoutesOptions & { slots?: number } = {},
): Promise<TestNode> {
  const module = createAgentRouteModule({ cliEntry: FAKE_WORKER, ...options });
  const slots = new Set<string>();
  const maxSlots = options.slots ?? 2;
  const info: Partial<NodeInfo> = { modelAuth: true, load: 0.1, slots: maxSlots };
  const ctx: NodeContext = {
    config: {
      name: "my-pc",
      token: TEST_TOKEN,
      port: 0,
      bind: "127.0.0.1",
      advertiseHost: "127.0.0.1",
      labels: [],
      slots: maxSlots,
      dataDir,
    },
    acquireSlot(owner) {
      if (slots.size >= maxSlots) return false;
      slots.add(owner);
      return true;
    },
    releaseSlot(owner) {
      slots.delete(owner);
    },
    async prepareWorkspace(_kind, id, source) {
      const dir = path.join(dataDir, "agents", id, "repo");
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      sh(dataDir, "clone", "-q", source.git, dir);
      sh(dir, "checkout", "-q", source.sha);
      if (source.patch) {
        const file = path.join(dataDir, `${id}.patch`);
        fs.writeFileSync(file, Buffer.from(source.patch, "base64"));
        sh(dir, "apply", "--binary", file);
        fs.rmSync(file);
      }
      return source.subdir ? path.join(dir, source.subdir) : dir;
    },
    cliEntry: () => "unused",
    json(res, status, body) {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    },
    log() {},
  };
  const authorized = (header: string | undefined) => header === `Bearer ${TEST_TOKEN}`;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!authorized(req.headers.authorization))
      return ctx.json(res, 401, { error: "unauthorized" });
    if (url.pathname === "/v1/info") {
      return ctx.json(res, 200, { ...info, slotsUsed: slots.size, agents: module.agents?.() });
    }
    void module.handle(ctx, req, res, url).then((handled) => {
      if (!handled) ctx.json(res, 404, { error: "not found" });
    });
  });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!authorized(req.headers.authorization) || !module.upgrade?.(ctx, req, socket, head, url)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    module,
    dataDir,
    slotsUsed: () => slots.size,
    info,
    async close() {
      await module.close?.();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
