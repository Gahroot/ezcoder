import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeRepo } from "./fleet/__fixtures__/test-node.js";
import {
  FLEET_PROTOCOL,
  type DoctorReport,
  type JobStatus,
  type NodeInfo,
} from "./fleet/protocol.js";
import {
  checkGoalPrerequisitesOnNode,
  goalNodeProtocolProblem,
  resolveGoalNode,
  runGoalVerifierOnFleet,
} from "./goal-fleet.js";
import { createGoalRun } from "./goal-store.js";

let root: string;
let nodesFile: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ez-goal-fleet-")));
  process.env.EZ_GOALS_BASE = path.join(root, "goals");
  nodesFile = path.join(root, "nodes.json");
  fs.writeFileSync(
    nodesFile,
    JSON.stringify({ nodes: [{ name: "box", url: "http://box.test:7377", token: "tok" }] }),
  );
});
afterEach(() => {
  delete process.env.EZ_GOALS_BASE;
  vi.unstubAllGlobals();
  fs.rmSync(root, { recursive: true, force: true });
});

const info = (over: Partial<NodeInfo> = {}): NodeInfo =>
  ({
    ezcoderNode: true,
    protocol: FLEET_PROTOCOL,
    name: "box",
    version: "1.0.0",
    modelAuth: true,
    slots: 2,
    slotsUsed: 0,
    load: 0.1,
    ...over,
  }) as NodeInfo;

/** Fake node over fetch: route -> JSON body (or [status, body]). */
function fakeFetch(routes: Record<string, unknown>) {
  const calls: Array<{ method: string; route: string; body?: unknown; headers: Headers }> = [];
  const fn = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const route = url.pathname;
    const method = init?.method ?? "GET";
    calls.push({
      method,
      route,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: new Headers(init?.headers),
    });
    // Job ids are generated: "/v1/jobs/*" stands for any id.
    const generic = route.replace(/^\/v1\/jobs\/[^/]+/, "/v1/jobs/*");
    const key = Object.keys(routes).find(
      (k) => k === `${method} ${route}` || k === route || k === generic,
    );
    if (!key) return new Response(JSON.stringify({ error: "nope" }), { status: 404 });
    const value = routes[key];
    if (typeof value === "string") return new Response(value, { status: 200 });
    const [status, body] = Array.isArray(value) ? value : [200, value];
    return new Response(JSON.stringify(body), { status });
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

describe("S3 for goals", () => {
  it("names which side to update", () => {
    expect(goalNodeProtocolProblem("box", info({ protocol: 1 }))).toMatch(
      /fleet protocol 1.*Update the node: run `ezcoder node update` there/,
    );
    expect(goalNodeProtocolProblem("box", info({ minProtocol: FLEET_PROTOCOL + 1 }))).toMatch(
      /Update EZ Coder on this computer/,
    );
    expect(goalNodeProtocolProblem("box", info())).toBeUndefined();
  });

  it("refuses an incompatible node before sending work", async () => {
    await expect(
      resolveGoalNode("box", "worker", { nodesFile, probe: async () => info({ protocol: 1 }) }),
    ).rejects.toThrow(/can't run a Goal worker now: .*ezcoder node update/);
  });
});

describe("GL5: prerequisites on the node", () => {
  it("reports failed doctor checks and prerequisite commands that fail there", async () => {
    const doctor: DoctorReport = {
      node: "box",
      version: "1.0.0",
      protocol: FLEET_PROTOCOL,
      ok: false,
      checks: [
        { id: "model_login", status: "fail", detail: "No model login.", fix: "ezcoder login" },
        { id: "git", status: "ok", detail: "Can fetch the repo." },
        { id: "gpu", status: "fail", detail: "No GPU." },
      ],
    };
    const job: JobStatus = {
      id: "j",
      kind: "custom",
      project: "p",
      state: "failed",
      exitCode: 127,
      logBytes: 10,
    };
    const calls = fakeFetch({
      "/v1/doctor": doctor,
      "POST /v1/jobs": job,
      "/v1/jobs/*": job,
      "/v1/jobs/*/log": "ffmpeg: command not found\n",
    });
    const run = createGoalRun(root, {
      title: "t",
      goal: "g",
      prerequisites: [
        { id: "ff", label: "ffmpeg", status: "met", checkCommand: "ffmpeg -version" },
      ],
    });
    const result = await checkGoalPrerequisitesOnNode({
      node: { name: "box", url: "http://box.test:7377", token: "tok" },
      info: info(),
      run,
      source: { git: "https://example.test/r.git", sha: "a".repeat(40) },
      project: "p",
      needsModel: true,
      deps: { pollMs: 1 },
    });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      "box: No model login. Fix: ezcoder login",
      expect.stringMatching(
        /^box: prerequisite "ffmpeg" is missing there: `ffmpeg -version` failed \(exit 127\): ffmpeg: command not found$/,
      ),
    ]);
    const doctorCall = calls.find((c) => c.route === "/v1/doctor")!;
    expect(doctorCall.headers.get("x-ezcoder-protocol")).toBe(String(FLEET_PROTOCOL));
    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({
      command: "ffmpeg -version",
      source: { sha: "a".repeat(40) },
    });
  });
});

describe("GL2: verifier as a fleet job", () => {
  const passed = (state: JobStatus["state"], exitCode: number): JobStatus => ({
    id: "v",
    kind: "test",
    project: "p",
    state,
    exitCode,
    logBytes: 5,
  });

  it("runs at the exact clean commit and uses the job log as evidence", async () => {
    const { local, sha } = makeRepo(root);
    const calls = fakeFetch({
      "/v1/info": info(),
      "POST /v1/jobs": passed("running", 0),
      "/v1/jobs/*": passed("passed", 0),
      "/v1/jobs/*/log": "12 tests passed\n",
    });
    const result = await runGoalVerifierOnFleet({
      cwd: local,
      runId: "run-12345678",
      command: "npm test",
      machine: "auto",
      deps: { nodesFile, pollMs: 1 },
    });
    expect(result.verification.status).toBe("pass");
    expect(result.verification.summary).toBe(
      `Fleet verifier on box (job v) at clean commit ${sha.slice(0, 12)}: passed, exit 0.\n12 tests passed`,
    );
    expect(fs.readFileSync(result.verification.outputPath!, "utf-8")).toContain("12 tests passed");
    const posted = calls.find((c) => c.method === "POST")!.body as { source: { patch?: string } };
    expect(posted.source.patch).toBeUndefined();
  });

  it("says when uncommitted work was sent as a patch, and fails with the exit code", async () => {
    const { local } = makeRepo(root);
    fs.writeFileSync(path.join(local, "a.txt"), "dirty\n");
    fakeFetch({
      "/v1/info": info(),
      "POST /v1/jobs": passed("running", 0),
      "/v1/jobs/*": passed("failed", 2),
      "/v1/jobs/*/log": "1 failing\n",
    });
    const result = await runGoalVerifierOnFleet({
      cwd: local,
      runId: "run-1",
      command: "npm test",
      machine: "box",
      deps: { nodesFile, pollMs: 1 },
    });
    expect(result.verification.status).toBe("fail");
    expect(result.verification.exitCode).toBe(2);
    expect(result.failureClass).toBe("verifier_failure");
    expect(result.verification.summary).toMatch(
      /plus this computer's uncommitted changes sent as a patch \(\d+ bytes\); not a clean commit: failed, exit 2\./,
    );
  });

  it("reports a verifier that could not start", async () => {
    const { local } = makeRepo(root);
    fakeFetch({ "/v1/info": info({ protocol: 1 }) });
    const result = await runGoalVerifierOnFleet({
      cwd: local,
      runId: "run-1",
      command: "npm test",
      machine: "box",
      deps: { nodesFile },
    });
    expect(result.failureClass).toBe("verifier_spawn_error");
    expect(result.verification.summary).toMatch(/^Fleet verifier did not start: .*node update/);
  });
});
