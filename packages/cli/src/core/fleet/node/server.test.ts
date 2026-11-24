import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HelloResponse, JobStatus, NodeInfo } from "../protocol.js";
import { tokenMatches, type NodeServer } from "./server.js";
import { setSecret } from "./config.js";
import { api, startTestServer, tempDir, waitFor } from "./__fixtures__/server.js";

const isWindows = process.platform === "win32";
let servers: NodeServer[] = [];

afterEach(async () => {
  for (const s of servers) await s.close();
  servers = [];
});

async function start(...args: Parameters<typeof startTestServer>) {
  const s = await startTestServer(...args);
  servers.push(s);
  return s;
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

describe("tokenMatches", () => {
  it("accepts only the exact bearer token", () => {
    expect(tokenMatches("Bearer abc", "abc")).toBe(true);
    expect(tokenMatches("Bearer abd", "abc")).toBe(false);
    expect(tokenMatches("abc", "abc")).toBe(false);
    expect(tokenMatches(undefined, "abc")).toBe(false);
    expect(tokenMatches("Bearer ", "")).toBe(false);
  });
});

describe.skipIf(isWindows)("node server", () => {
  it("serves hello without auth and rejects everything else without the token", async () => {
    const dir = tempDir();
    const s = await start(dir);
    const hello = (await (await fetch(s.url + "/v1/hello")).json()) as HelloResponse;
    expect(hello).toMatchObject({ ezcoderNode: true, protocol: 1, name: "test-node" });
    expect((await fetch(s.url + "/v1/info")).status).toBe(401);
    expect((await api(s, "wrong")("GET", "/v1/jobs")).status).toBe(401);
    expect((await api(s)("GET", "/v1/nope")).status).toBe(404);
  });

  it("reports live resources on /v1/info", async () => {
    const s = await start(tempDir(), { labels: ["render"] });
    const info = (await (await api(s)("GET", "/v1/info")).json()) as NodeInfo;
    expect(info.cpus).toBeGreaterThan(0);
    expect(info.memoryGb).toBeGreaterThan(0);
    expect(info.labels).toEqual(["render"]);
    expect(info.slots).toBe(2);
    expect(info.slotsUsed).toBe(0);
    expect(info.docker).toBe(false);
    expect(info.modelAuth).toBe(false);
    expect(Array.isArray(info.jobs)).toBe(true);
  });

  it("stores shared credentials in the node's own auth file", async () => {
    const dir = tempDir();
    const s = await start(dir);
    const call = api(s);
    const res = await call("POST", "/v1/auth", {
      credentials: { openai: { accessToken: "k", refreshToken: "", expiresAt: 1 } },
    });
    expect(res.status).toBe(200);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf8"));
    expect(stored.openai.accessToken).toBe("k");
    expect((await call("POST", "/v1/auth", { credentials: [] })).status).toBe(400);
    // Prototype keys are never stored (regression).
    const proto = await call(
      "POST",
      "/v1/auth",
      JSON.parse('{"credentials":{"__proto__":{"accessToken":"x"},"constructor":{"a":1}}}'),
    );
    expect(((await proto.json()) as { providers: string[] }).providers).toEqual([]);
    const info = (await (await call("GET", "/v1/info")).json()) as NodeInfo;
    expect(info.modelAuth).toBe(true);
  });

  it("rejects bodies over the limit", async () => {
    const s = await start(tempDir());
    const res = await fetch(s.url + "/v1/jobs", {
      method: "POST",
      headers: {
        authorization: "Bearer secret-token-123",
        "content-length": String(65 * 1024 ** 2),
      },
      body: "x",
      duplex: "half",
    } as RequestInit).catch(() => undefined);
    // Either a 413 or the server cutting the connection is acceptable.
    if (res) expect(res.status).toBe(413);
  });

  it("runs a host job: log offset, artifacts list and download", async () => {
    const s = await start(tempDir());
    const call = api(s);
    const cmd = "echo hello; echo world; mkdir -p out/sub && printf data > out/sub/a.txt";
    const res = await call("POST", "/v1/jobs", job("j1", cmd, { artifacts: ["out/**"] }));
    expect(res.status).toBe(201);
    // idempotent re-post
    expect((await call("POST", "/v1/jobs", job("j1", cmd))).status).toBe(200);
    const st = await finished(call, "j1");
    expect(st.state).toBe("passed");
    expect(st.exitCode).toBe(0);
    expect(st.artifacts).toEqual([{ path: "out/sub/a.txt", bytes: 4 }]);

    const full = await call("GET", "/v1/jobs/j1/log");
    const text = await full.text();
    expect(text).toContain("hello\nworld\n");
    const size = Number(full.headers.get("x-log-size"));
    expect(size).toBe(Buffer.byteLength(text));
    const tail = await call("GET", `/v1/jobs/j1/log?offset=${text.indexOf("world")}`);
    expect(await tail.text()).toBe("world\n");

    const list = await call("GET", "/v1/jobs/j1/artifacts");
    expect(await list.json()).toEqual([{ path: "out/sub/a.txt", bytes: 4 }]);
    const file = await call("GET", "/v1/jobs/j1/artifacts/out/sub/a.txt");
    expect(await file.text()).toBe("data");
    expect((await call("GET", "/v1/jobs/j1/artifacts/../state.json")).status).toBe(404);

    const purged = await call("DELETE", "/v1/jobs/j1?purge=1");
    expect(purged.status).toBe(200);
    expect((await call("GET", "/v1/jobs/j1")).status).toBe(404);
  });

  it("never collects artifacts through a symlinked folder", async () => {
    const s = await start(tempDir());
    const call = api(s);
    const outside = tempDir("ezf-outside-");
    fs.writeFileSync(path.join(outside, "host-secret.txt"), "secret");
    const cmd = `ln -s ${outside} link; mkdir -p out && printf ok > out/a.txt`;
    const res = await call(
      "POST",
      "/v1/jobs",
      job("jlink", cmd, { artifacts: ["link/host-secret.txt", "link/**", "out/**"] }),
    );
    expect(res.status).toBe(201);
    const st = await finished(call, "jlink");
    expect(st.state).toBe("passed");
    expect((st.artifacts ?? []).map((a) => a.path)).toEqual(["out/a.txt"]);
  });

  it("reports failures, timeouts and cancellation", async () => {
    const s = await start(tempDir(), { slots: 4 }, { jobSecondsPerMinute: 1 });
    const call = api(s);
    await call("POST", "/v1/jobs", job("fail", "exit 3"));
    await call("POST", "/v1/jobs", job("slow", "sleep 30", { timeoutMinutes: 1 }));
    await call("POST", "/v1/jobs", job("cancel-me", "sleep 30", { timeoutMinutes: 100 }));
    expect(await finished(call, "fail")).toMatchObject({ state: "failed", exitCode: 3 });

    const timedOut = await finished(call, "slow");
    expect(timedOut.state).toBe("failed");
    expect(timedOut.summary).toContain("timed out");

    await waitFor(async () => {
      const st = (await (await call("GET", "/v1/jobs/cancel-me")).json()) as JobStatus;
      return st.state === "running";
    });
    expect((await call("DELETE", "/v1/jobs/cancel-me")).status).toBe(200);
    expect((await finished(call, "cancel-me")).state).toBe("cancelled");
  });

  it("returns 429 when all slots are busy and frees the slot afterwards", async () => {
    const s = await start(tempDir(), { slots: 1 });
    const call = api(s);
    expect((await call("POST", "/v1/jobs", job("a", "sleep 30"))).status).toBe(201);
    const busy = await call("POST", "/v1/jobs", job("b", "true"));
    expect(busy.status).toBe(429);
    await call("DELETE", "/v1/jobs/a");
    await finished(call, "a");
    expect((await call("POST", "/v1/jobs", job("b", "true"))).status).toBe(201);
    expect((await finished(call, "b")).state).toBe("passed");
  });

  it("validates job requests", async () => {
    const s = await start(tempDir());
    const call = api(s);
    expect((await call("POST", "/v1/jobs", job("../x", "true"))).status).toBe(400);
    expect((await call("POST", "/v1/jobs", job("x", ""))).status).toBe(400);
    expect(
      (await call("POST", "/v1/jobs", job("x", "true", { artifacts: ["../../etc/*"] }))).status,
    ).toBe(400);
    expect(
      (
        await call(
          "POST",
          "/v1/jobs",
          job("x", "true", { docker: { image: "node:22", args: ["--privileged"] } }),
        )
      ).status,
    ).toBe(400);
    // docker unavailable on this node (injected)
    expect(
      (await call("POST", "/v1/jobs", job("x", "true", { docker: { image: "node:22" } }))).status,
    ).toBe(409);
  });

  it("gives secrets only on nodes labelled deploy", async () => {
    const plain = await start(tempDir());
    const denied = await api(plain)(
      "POST",
      "/v1/jobs",
      job("d1", "true", { secrets: ["DEPLOY_TOKEN"] }),
    );
    expect(denied.status).toBe(403);

    const dir = tempDir();
    setSecret(dir, "DEPLOY_TOKEN", "s3cr3t");
    const deploy = await start(dir, { labels: ["deploy"] });
    const call = api(deploy);
    const missing = await call("POST", "/v1/jobs", job("d0", "true", { secrets: ["OTHER"] }));
    expect(missing.status).toBe(400);
    await call(
      "POST",
      "/v1/jobs",
      job("d2", 'test "$DEPLOY_TOKEN" = s3cr3t && echo ok', { secrets: ["DEPLOY_TOKEN"] }),
    );
    const st = await finished(call, "d2");
    expect(st.state).toBe("passed");
    expect(fs.statSync(path.join(dir, "secrets.json")).mode & 0o777).toBe(0o600);
  });

  it("re-adopts a running job after a restart and marks unrecoverable ones lost", async () => {
    const dir = tempDir();
    const first = await startTestServer(dir);
    await api(first)("POST", "/v1/jobs", job("long", "sleep 1; echo done"));
    await waitFor(async () => first.jobs.get("long")?.state === "running");
    await first.close();

    // A job whose runner vanished without an exit file.
    const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
    state.jobs.push({
      status: { id: "gone", kind: "build", project: "you/repo", state: "running", logBytes: 0 },
      timeoutMinutes: 5,
      wrapperPid: 999_999_999,
    });
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));

    const second = await start(dir);
    const call = api(second);
    expect(second.jobs.get("gone")?.state).toBe("lost");
    const st = await finished(call, "long");
    expect(st.state).toBe("passed");
    expect(await (await call("GET", "/v1/jobs/long/log")).text()).toContain("done");
  });
});
