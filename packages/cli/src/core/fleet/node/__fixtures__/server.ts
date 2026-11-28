// Shared helpers for the fleet node tests (temp data dirs, a real server on 127.0.0.1).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FLEET_PROTOCOL, PROTOCOL_HEADER } from "../../protocol.js";
import type { NodeConfig } from "../context.js";
import { memorySecretStore } from "../secrets.js";
import { startNodeServer, type NodeServer, type NodeServerOptions } from "../server.js";

export function tempDir(prefix = "ezf-node-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function testConfig(dataDir: string, over: Partial<NodeConfig> = {}): NodeConfig {
  return {
    name: "test-node",
    token: "secret-token-123",
    port: 0,
    bind: "127.0.0.1",
    advertiseHost: "my-pc.example.ts.net",
    labels: [],
    slots: 2,
    dataDir,
    ...over,
  };
}

export async function startTestServer(
  dataDir: string,
  over: Partial<NodeConfig> = {},
  opts: Partial<NodeServerOptions> = {},
): Promise<NodeServer> {
  return startNodeServer({
    config: testConfig(dataDir, over),
    modules: [],
    log: () => {},
    authFile: path.join(dataDir, "auth.json"),
    dockerAvailable: async () => false,
    gpus: async () => [],
    jobPollMs: 50,
    killGraceSeconds: 1,
    secretStore: memorySecretStore(),
    configCheckMs: 0,
    ...opts,
  });
}

export function api(server: NodeServer, token = "secret-token-123") {
  return async (method: string, p: string, body?: unknown) => {
    const res = await fetch(server.url + p, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        [PROTOCOL_HEADER]: String(FLEET_PROTOCOL),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return res;
  };
}

export async function waitFor<T>(
  fn: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 15_000,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}
