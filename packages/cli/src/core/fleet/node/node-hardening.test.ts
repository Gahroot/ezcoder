// Regression tests for node-side fleet hardening: S3, S4, X5, X9, R3, R6, R8,
// R9, A2 and the single shared slot pool (429 busy + Retry-After, live slots).
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { FAKE_WORKER, makeRepo } from "../__fixtures__/test-node.js";
import {
  FLEET_PROTOCOL,
  PROTOCOL_HEADER,
  type AgentDiff,
  type ErrorResponse,
  type HelloResponse,
  type JobStatus,
  type NodeInfo,
  type RotateTokenResponse,
} from "../protocol.js";
import { writeNodeConfig } from "./config.js";
import { createAgentRouteModule } from "./agents.js";
import { tailLines } from "./jobs.js";
import { protocolMismatch, type NodeServer } from "./server.js";
import { api, startTestServer, tempDir, testConfig, waitFor } from "./__fixtures__/server.js";

const TOKEN = "secret-token-123";
let servers: NodeServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function start(...args: Parameters<typeof startTestServer>): Promise<NodeServer> {
  const s = await startTestServer(...args);
  servers.push(s);
  return s;
}

/** A node with the real agents module and the fake worker. */
async function agentNode(dir: string, over: Parameters<typeof startTestServer>[1] = {}) {
  return start(dir, over, { modules: [createAgentRouteModule({ cliEntry: FAKE_WORKER })] });
}

const job = (id: string, command: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: "custom",
  project: "you/repo",
  command,
  timeoutMinutes: 5,
  ...extra,
});

async function finished(call: ReturnType<typeof api>, id: string): Promise<JobStatus> {
  return waitFor(async () => {
    const s = (await (await call("GET", `/v1/jobs/${id}`)).json()) as JobStatus;
    return ["passed", "failed", "error", "cancelled", "lost"].includes(s.state) ? s : undefined;
  });
}

function createAgent(s: NodeServer, id: string, repoRoot = tempDir("ezf-repo-")) {
  const repo = makeRepo(repoRoot);
  return api(s)("POST", "/v1/agents", {
    id,
    project: "you/repo",
    source: { git: `file://${repo.origin}`, sha: repo.sha },
  });
}

function attach(s: NodeServer, id: string, token = TOKEN): Promise<WebSocket> {
  const ws = new WebSocket(`${s.url.replace("http", "ws")}/v1/agents/${id}/attach`, {
    headers: { authorization: `Bearer ${token}`, [PROTOCOL_HEADER]: String(FLEET_PROTOCOL) },
  });
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

describe("protocolMismatch (S3)", () => {
  it("treats a missing header as protocol 1 and names the side to update", () => {
    expect(protocolMismatch(String(FLEET_PROTOCOL))).toBeUndefined();
    expect(protocolMismatch(undefined)).toMatchObject({
      code: "protocol_mismatch",
      update: "controller",
      controllerProtocol: 1,
      nodeProtocol: FLEET_PROTOCOL,
    });
    expect(protocolMismatch("99")?.update).toBe("node");
  });
});

describe("tailLines (A2)", () => {
  it("reads the last lines across chunk boundaries without the whole file", () => {
    const file = path.join(tempDir(), "log");
    const lines = Array.from({ length: 30_000 }, (_, i) => `line ${i}${i % 7 === 0 ? " ERR" : ""}`);
    fs.writeFileSync(file, lines.join("\n") + "\n");
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      expect(tailLines(fd, size, 3)).toEqual(["line 29997\n", "line 29998\n", "line 29999\n"]);
      expect(tailLines(fd, size, 2, /ERR/)).toEqual(["line 29988 ERR\n", "line 29995 ERR\n"]);
      expect(tailLines(fd, size, 100_000)).toHaveLength(30_000);
    } finally {
      fs.closeSync(fd);
    }
  });
});

describe.skipIf(process.platform === "win32")("node hardening", () => {
  it("S3: refuses a controller outside the protocol range with 426; hello advertises the range", async () => {
    const s = await start(tempDir());
    const hello = (await (await fetch(`${s.url}/v1/hello`)).json()) as HelloResponse;
    expect(hello.protocol).toBe(FLEET_PROTOCOL);
    expect(hello.minProtocol).toBe(2);
    expect(hello.features).toEqual(expect.arrayContaining(["log-query", "rotate-token"]));
    const old = await fetch(`${s.url}/v1/jobs`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(old.status).toBe(426);
    expect((await old.json()) as ErrorResponse).toMatchObject({
      code: "protocol_mismatch",
      update: "controller",
    });
    const newer = await fetch(`${s.url}/v1/jobs`, {
      headers: { authorization: `Bearer ${TOKEN}`, [PROTOCOL_HEADER]: "99" },
    });
    expect(((await newer.json()) as ErrorResponse).update).toBe("node");
    expect((await api(s)("GET", "/v1/jobs")).status).toBe(200);
  });

  it("S4: a rotated token works at once and the old one stops, also via node.json", async () => {
    const dir = tempDir();
    const s = await agentNode(dir);
    expect((await createAgent(s, "a1")).status).toBe(201);
    const ws = await attach(s, "a1");
    const closed = new Promise<number>((r) => ws.once("close", (code) => r(code)));

    const res = await api(s)("POST", "/v1/token/rotate");
    expect(res.status).toBe(200);
    const body = (await res.json()) as RotateTokenResponse;
    expect(body.pairing).toContain(`#${body.token}`);
    expect((await api(s)("GET", "/v1/jobs")).status).toBe(401);
    expect((await api(s, body.token)("GET", "/v1/jobs")).status).toBe(200);
    expect(await closed).toBe(4001);

    // `ezcoder node rotate-token` rewrites node.json; the running server picks it up.
    writeNodeConfig(testConfig(dir, { token: "cli-rotated-token" }));
    expect((await api(s, body.token)("GET", "/v1/jobs")).status).toBe(401);
    expect((await api(s, "cli-rotated-token")("GET", "/v1/jobs")).status).toBe(200);
  });

  it("X5: a docker-only node refuses host-shell jobs and remote agents", async () => {
    const s = await agentNode(tempDir(), { dockerOnly: true });
    const hello = (await (await fetch(`${s.url}/v1/hello`)).json()) as HelloResponse;
    expect(hello.dockerOnly).toBe(true);
    const host = await api(s)("POST", "/v1/jobs", job("h1", "true"));
    expect(host.status).toBe(403);
    expect(((await host.json()) as ErrorResponse).code).toBe("docker_only");
    const agent = await createAgent(s, "a1");
    expect(agent.status).toBe(403);
    expect(((await agent.json()) as ErrorResponse).code).toBe("docker_only");
    // A containerised job passes the gate (then meets the injected "no docker").
    const boxed = await api(s)("POST", "/v1/jobs", job("d1", "true", { docker: { image: "a:1" } }));
    expect(boxed.status).toBe(409);
  });

  it("X9: a job can mount only its own workspace and cache", async () => {
    const dir = tempDir();
    const s = await start(dir);
    const call = api(s);
    for (const bad of [`${dir}/jobs/other:/x`, `${dir}/cache/other-project:/c`, `${dir}/jobs:/j`]) {
      const r = await call(
        "POST",
        "/v1/jobs",
        job("m1", "true", { docker: { image: "a:1", args: ["-v", bad] } }),
      );
      expect(r.status, bad).toBe(400);
    }
    const own = await call(
      "POST",
      "/v1/jobs",
      job("m1", "true", { docker: { image: "a:1", args: ["-v", `${dir}/cache/you_repo:/c2`] } }),
    );
    expect(own.status).toBe(409); // valid; refused only because docker is unavailable
  });

  it("R6: caps a job's log keeping head and tail, A2: tail/grep/offset+limit", async () => {
    const s = await start(tempDir());
    const call = api(s);
    const cmd = "i=1; while [ $i -le 2000 ]; do echo line$i; i=$((i+1)); done";
    expect((await call("POST", "/v1/jobs", job("big", cmd, { logCapBytes: 4096 }))).status).toBe(
      201,
    );
    const st = await finished(call, "big");
    expect(st.logTruncated).toBe(true);
    expect(st.logBytes).toBeLessThanOrEqual(4096);
    const full = await call("GET", "/v1/jobs/big/log");
    expect(full.headers.get("x-log-truncated")).toBe("1");
    const text = await full.text();
    expect(text).toContain("line1\n");
    expect(text).toContain("line2000\n");
    expect(text).toContain("the middle was dropped");

    expect((await call("POST", "/v1/jobs", job("small", cmd))).status).toBe(201);
    await finished(call, "small");
    expect(await (await call("GET", "/v1/jobs/small/log?tail=2")).text()).toBe(
      "line1999\nline2000\n",
    );
    expect(await (await call("GET", "/v1/jobs/small/log?tail=2&grep=^line19")).text()).toBe(
      "line1998\nline1999\n",
    );
    const range = await call("GET", "/v1/jobs/small/log?offset=6&limit=6");
    expect(await range.text()).toBe("line2\n");
    expect(Number(range.headers.get("x-log-size"))).toBeGreaterThan(1000);
    expect(await (await call("GET", "/v1/jobs/small/log?grep=^line200")).text()).toBe(
      "line200\nline2000\n",
    );
    expect((await call("GET", "/v1/jobs/small/log?grep=(")).status).toBe(400);
    expect((await call("GET", `/v1/jobs/small/log?grep=${"a".repeat(201)}`)).status).toBe(400);
  });

  it("R8: share-auth refuses to overwrite existing credentials without force", async () => {
    const s = await start(tempDir());
    const call = api(s);
    const creds = { credentials: { openai: { accessToken: "a", refreshToken: "", expiresAt: 1 } } };
    expect((await call("POST", "/v1/auth", creds)).status).toBe(200);
    const again = await call("POST", "/v1/auth", creds);
    expect(again.status).toBe(409);
    expect(((await again.json()) as ErrorResponse).code).toBe("exists");
    expect((await call("POST", "/v1/auth", { ...creds, force: true })).status).toBe(200);
  });

  it("shares one slot pool between jobs and agents; 429 busy with Retry-After; live slots", async () => {
    const dir = tempDir();
    const s = await agentNode(dir, { slots: 1 });
    const call = api(s);
    expect((await call("POST", "/v1/jobs", job("hold", "sleep 30"))).status).toBe(201);
    const agent = await createAgent(s, "a1");
    expect(agent.status).toBe(429);
    expect(agent.headers.get("retry-after")).toBe("15");
    expect(((await agent.json()) as ErrorResponse).code).toBe("busy");
    const job2 = await call("POST", "/v1/jobs", job("j2", "true"));
    expect(job2.status).toBe(429);
    expect(job2.headers.get("retry-after")).toBe("15");
    expect(((await job2.json()) as ErrorResponse).code).toBe("busy");

    s.setSlots(2);
    expect((await createAgent(s, "a1")).status).toBe(201);
    const info = (await (await call("GET", "/v1/info")).json()) as NodeInfo;
    expect(info).toMatchObject({ slots: 2, slotsUsed: 2 });

    // `ezcoder node config --slots 5` rewrites node.json; picked up without a restart.
    writeNodeConfig(testConfig(dir, { slots: 5 }));
    const live = (await (await call("GET", "/v1/info")).json()) as NodeInfo;
    expect(live.slots).toBe(5);
    expect(() => s.setSlots(0)).toThrow(/at least 1/);
    await call("DELETE", "/v1/jobs/hold");
  });

  it("R3: re-adopts agents after a restart; a dead worker is error with its workspace kept", async () => {
    const dir = tempDir();
    const first = await agentNode(dir);
    const created = (await (await createAgent(first, "a1")).json()) as { cwd: string };
    expect((await createAgent(first, "a2")).status).toBe(201);
    const ws = await attach(first, "a2");
    await waitFor(
      () =>
        first.context.state?.data.agents.find((a) => a.id === "a2")?.state === "running" ||
        undefined,
    );
    fs.writeFileSync(path.join(created.cwd, "a.txt"), "edited\n");
    ws.terminate();
    servers = servers.filter((x) => x !== first);
    await first.close();

    const second = await agentNode(dir);
    const call = api(second);
    const list = (await (await call("GET", "/v1/agents")).json()) as Array<{
      id: string;
      state: string;
    }>;
    expect(list.map((a) => a.id).sort()).toEqual(["a1", "a2"]);
    expect(list.find((a) => a.id === "a1")?.state).toBe("ready");
    expect(["error", "exited"]).toContain(list.find((a) => a.id === "a2")?.state);
    const diff = (await (await call("GET", "/v1/agents/a1/diff")).json()) as AgentDiff;
    expect(diff.files).toEqual(["a.txt"]);
    expect((await call("GET", "/v1/agents/a2/diff")).status).toBe(200);
    expect((await call("DELETE", "/v1/agents/a1")).status).toBe(200);
    expect(fs.existsSync(created.cwd)).toBe(false);
  });

  it("R9: lists git-ignored files the agent changed, outside the patch", async () => {
    const s = await agentNode(tempDir());
    const { cwd } = (await (await createAgent(s, "a1")).json()) as { cwd: string };
    fs.writeFileSync(path.join(cwd, ".gitignore"), "*.log\n");
    fs.writeFileSync(path.join(cwd, "build.log"), "x");
    const diff = (await (await api(s)("GET", "/v1/agents/a1/diff")).json()) as AgentDiff;
    expect(diff.files).toEqual([".gitignore"]);
    expect(diff.ignoredChanged).toEqual(["build.log"]);
  });
});
