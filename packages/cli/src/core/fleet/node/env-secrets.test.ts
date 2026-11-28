// X6: host-shell jobs and remote agents inherit an allow-listed environment,
// so a secret in the node's own environment never reaches them.
// X8: deploy secrets live in the OS keychain only: an old plain-text file is
// moved in and deleted, and with no keychain nothing is stored at all.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { FAKE_WORKER, makeRepo } from "../__fixtures__/test-node.js";
import { FLEET_PROTOCOL, PROTOCOL_HEADER, type AgentFrame, type JobStatus } from "../protocol.js";
import { runNode } from "../../../cli/node.js";
import { createAgentRouteModule } from "./agents.js";
import { allowedBaseEnv } from "./env.js";
import {
  memorySecretStore,
  NO_KEYCHAIN_MESSAGE,
  NodeSecrets,
  SECRET_NAMES_FILE,
  unavailableStore,
} from "./secrets.js";
import type { NodeServer } from "./server.js";
import { api, startTestServer, tempDir, waitFor } from "./__fixtures__/server.js";

const LEAK = "EZF_TEST_NODE_SECRET_TOKEN";
const servers: NodeServer[] = [];
afterEach(async () => {
  delete process.env[LEAK];
  for (const s of servers.splice(0)) await s.close();
});

describe("allowedBaseEnv (X6)", () => {
  it("keeps the allow-list and LC_*, and drops everything else", () => {
    const env = allowedBaseEnv(
      {
        PATH: "/bin",
        HOME: "/h",
        LC_ALL: "C",
        [LEAK]: "s3cr3t",
        AWS_SECRET_ACCESS_KEY: "k",
        ANTHROPIC_API_KEY: "k",
        NODE_OPTIONS: "-r evil",
        SSH_AUTH_SOCK: "/tmp/agent",
        EZ_SUBAGENT_DEPTH: "1",
      },
      ["EZ_SUBAGENT_DEPTH"],
    );
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", LC_ALL: "C", EZ_SUBAGENT_DEPTH: "1" });
  });
});

describe.skipIf(process.platform === "win32")("node env allow-list (X6)", () => {
  it("a secret in the node's environment does not reach a host-shell job", async () => {
    process.env[LEAK] = "s3cr3t";
    const s = await startTestServer(tempDir());
    servers.push(s);
    const call = api(s);
    const cmd = `echo "leak=\${${LEAK}:-absent}"; test -n "$PATH" && echo path-ok`;
    const res = await call("POST", "/v1/jobs", {
      id: "env1",
      kind: "custom",
      project: "you/repo",
      command: cmd,
      timeoutMinutes: 1,
    });
    expect(res.status).toBe(201);
    await waitFor(async () => {
      const st = (await (await call("GET", "/v1/jobs/env1")).json()) as JobStatus;
      return st.state === "passed" ? st : undefined;
    });
    const log = await (await call("GET", "/v1/jobs/env1/log")).text();
    expect(log).toContain("leak=absent");
    expect(log).toContain("path-ok");
    expect(log).not.toContain("s3cr3t");
  });

  it("a secret in the node's environment does not reach a remote agent", async () => {
    // The fake worker reports process.env.SECRET_TOKEN as `leaked`.
    const prev = process.env.SECRET_TOKEN;
    process.env.SECRET_TOKEN = "node-own-secret";
    try {
      const s = await startTestServer(
        tempDir(),
        {},
        {
          modules: [createAgentRouteModule({ cliEntry: FAKE_WORKER })],
        },
      );
      servers.push(s);
      const repo = makeRepo(tempDir("ezf-repo-"));
      const created = await api(s)("POST", "/v1/agents", {
        id: "a1",
        project: "you/repo",
        source: { git: `file://${repo.origin}`, sha: repo.sha },
      });
      expect(created.status).toBe(201);
      const ws = new WebSocket(`${s.url.replace("http", "ws")}/v1/agents/a1/attach`, {
        headers: {
          authorization: "Bearer secret-token-123",
          [PROTOCOL_HEADER]: String(FLEET_PROTOCOL),
        },
      });
      const ack = await new Promise<Record<string, unknown>>((resolve, reject) => {
        let buf = "";
        ws.on("message", (raw) => {
          const frame = JSON.parse(raw.toString()) as AgentFrame;
          if (frame.t !== "stdout") return;
          buf += frame.data;
          for (const line of buf.split("\n").filter(Boolean)) {
            const msg = JSON.parse(line) as Record<string, unknown>;
            if (msg.request_id === "r1") resolve(msg);
          }
        });
        ws.once("error", reject);
        ws.once("open", () =>
          ws.send(
            JSON.stringify({
              t: "stdin",
              data: `${JSON.stringify({ request_id: "r1", command: "initialize", options: { sessionRootDir: "/x" } })}\n`,
            }),
          ),
        );
      });
      ws.close();
      expect(ack.leaked).toBeNull();
      expect(ack.depth).toBeDefined();
    } finally {
      if (prev === undefined) delete process.env.SECRET_TOKEN;
      else process.env.SECRET_TOKEN = prev;
    }
  });
});

describe("keychain deploy secrets (X8)", () => {
  const legacy = (dir: string, values: Record<string, string>) =>
    fs.writeFileSync(path.join(dir, "secrets.json"), JSON.stringify(values), { mode: 0o600 });

  it("moves an old plain-text secrets.json into the keychain, then deletes it", async () => {
    const dir = tempDir();
    legacy(dir, { DEPLOY_TOKEN: "s3cr3t", OTHER: "x" });
    const store = memorySecretStore();
    const secrets = new NodeSecrets(dir, store);
    expect(secrets.hasLegacyFile()).toBe(true);
    const msg = await secrets.migrateLegacy();
    expect(msg).toMatch(
      /moved 2 deploy secret\(s\) \(DEPLOY_TOKEN, OTHER\) .* and deleted the file/,
    );
    expect(fs.existsSync(path.join(dir, "secrets.json"))).toBe(false);
    expect(store.values.get("DEPLOY_TOKEN")).toBe("s3cr3t");
    expect(secrets.list()).toEqual(["DEPLOY_TOKEN", "OTHER"]);
    // Only names on disk, never values.
    expect(fs.readFileSync(path.join(dir, SECRET_NAMES_FILE), "utf8")).not.toContain("s3cr3t");
    expect(await secrets.read(["DEPLOY_TOKEN", "MISSING"])).toEqual({ DEPLOY_TOKEN: "s3cr3t" });
    expect(await secrets.migrateLegacy()).toBeUndefined();
  });

  it("the node server migrates the file when it starts", async () => {
    const dir = tempDir();
    legacy(dir, { DEPLOY_TOKEN: "s3cr3t" });
    const store = memorySecretStore();
    const s = await startTestServer(dir, {}, { secretStore: store });
    servers.push(s);
    expect(fs.existsSync(path.join(dir, "secrets.json"))).toBe(false);
    expect(store.values.get("DEPLOY_TOKEN")).toBe("s3cr3t");
  });

  it("refuses to store a secret without a keychain, writing nothing", async () => {
    const dir = tempDir();
    const secrets = new NodeSecrets(dir, unavailableStore);
    await expect(secrets.set("DEPLOY_TOKEN", "s3cr3t")).rejects.toThrow(NO_KEYCHAIN_MESSAGE);
    expect(fs.readdirSync(dir)).toEqual([]);
    // An old file is left alone (and unusable) rather than half-migrated.
    legacy(dir, { DEPLOY_TOKEN: "s3cr3t" });
    expect(await secrets.migrateLegacy()).toMatch(/no keychain to move them into/);
    expect(fs.existsSync(path.join(dir, "secrets.json"))).toBe(true);
  });

  it("`ezcoder node secret set` uses the keychain and refuses without one", async () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, "node.json"),
      JSON.stringify({
        name: "box",
        token: "t".repeat(32),
        port: 1,
        bind: "127.0.0.1",
        advertiseHost: "box.ts.net",
        labels: ["deploy"],
        slots: 1,
      }),
    );
    const store = memorySecretStore();
    const readValue = async () => "s3cr3t";
    const write = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      await runNode(["--data-dir", dir, "secret", "set", "DEPLOY_TOKEN"], {
        secretStore: store,
        readValue,
      });
      await expect(
        runNode(["--data-dir", dir, "secret", "set", "OTHER"], {
          secretStore: unavailableStore,
          readValue,
        }),
      ).rejects.toThrow(/no OS keychain is available on this machine/);
    } finally {
      process.stdout.write = write;
    }
    expect(store.values.get("DEPLOY_TOKEN")).toBe("s3cr3t");
    expect(fs.existsSync(path.join(dir, "secrets.json"))).toBe(false);
    for (const f of fs.readdirSync(dir)) {
      expect(fs.readFileSync(path.join(dir, f), "utf8"), f).not.toContain("s3cr3t");
    }
  });
});
