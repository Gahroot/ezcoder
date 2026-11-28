// GL4/GL6: Goals hosted on a node — workspace at the exact commit, a headless
// run holding one shared slot, records that survive a node restart, and the
// result pushed to origin as ezcoder/goal/<id>.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GoalHostStatus } from "../protocol.js";
import { makeRepo, sh } from "../__fixtures__/test-node.js";
import { api, startTestServer, tempDir, waitFor } from "./__fixtures__/server.js";
import {
  createGoalHostRouteModule,
  type GoalGit,
  type GoalHostOptions,
  type GoalHostRecord,
} from "./goals.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

interface FakeRun {
  goalDir: string;
  cwd: string;
  env: Record<string, string>;
  /** End the headless run, optionally writing result.json first. */
  end(result?: { status: string; summary: string }, code?: number): void;
}

function fakeHeadless() {
  const runs: FakeRun[] = [];
  const spawnHeadless: NonNullable<GoalHostOptions["spawnHeadless"]> = ({ goalDir, cwd, env }) => {
    let resolve!: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => (resolve = r));
    runs.push({
      goalDir,
      cwd,
      env,
      end(result, code = 0) {
        if (result) fs.writeFileSync(path.join(goalDir, "result.json"), JSON.stringify(result));
        fs.appendFileSync(path.join(goalDir, "run.log"), "[goal] finished\n");
        resolve(code);
      },
    });
    return { exited };
  };
  return { runs, spawnHeadless };
}

function fakeGit(fail?: string) {
  const calls: string[][] = [];
  const git: GoalGit = async (_cwd, args) => {
    calls.push(args);
    if (fail && args[0] === fail) return { code: 1, stdout: "", stderr: "permission denied" };
    if (args[0] === "diff") return { code: 1, stdout: "", stderr: "" };
    if (args[0] === "rev-parse") return { code: 0, stdout: "abc123def4567890\n", stderr: "" };
    if (args[0] === "config") return { code: 0, stdout: "node@example.com\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { calls, git };
}

async function setup(options: GoalHostOptions, slots = 1, dataDir = tempDir("ezf-goals-")) {
  const repo = makeRepo(tempDir("ezf-goals-repo-"));
  const server = await startTestServer(
    dataDir,
    { slots },
    { modules: [createGoalHostRouteModule({ adoptPollMs: 50, ...options })] },
  );
  cleanups.push(() => server.close());
  return { server, call: api(server), repo, dataDir };
}

const body = (repo: { origin: string; sha: string }, id = "goal-1") => ({
  id,
  project: "proj",
  source: { git: repo.origin, sha: repo.sha },
  goal: { run: { id, title: "Hosted" }, model: "m" },
});

async function statusOf(call: ReturnType<typeof api>, id = "goal-1"): Promise<GoalHostStatus> {
  return (await (await call("GET", `/v1/goals/${id}`)).json()) as GoalHostStatus;
}

describe("hosted goals on a node", () => {
  it("prepares the workspace, runs headless on one slot, then pushes the result branch", async () => {
    const headless = fakeHeadless();
    const git = fakeGit();
    const { server, call, repo } = await setup({ ...headless, git: git.git });
    const posted = await call("POST", "/v1/goals", body(repo));
    expect(posted.status).toBe(200);
    expect(((await posted.json()) as GoalHostStatus).state).toBe("preparing");
    const run = await waitFor(() => headless.runs[0]);
    expect(JSON.parse(fs.readFileSync(path.join(run.goalDir, "goal.json"), "utf8"))).toMatchObject({
      run: { id: "goal-1" },
    });
    expect(run.env.EZ_GOALS_BASE).toBe(path.join(run.goalDir, "store"));
    expect(sh(run.cwd, "rev-parse", "HEAD").trim()).toBe(repo.sha);
    expect((await statusOf(call)).state).toBe("running");

    // It holds the node's one slot: other work is told to retry.
    const busy = await call("POST", "/v1/goals", body(repo, "goal-2"));
    expect(busy.status).toBe(429);
    expect(Number(busy.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await busy.json()).toMatchObject({ code: "busy" });

    run.end({ status: "passed", summary: "All criteria proven." });
    const done = await waitFor(async () => {
      const s = await statusOf(call);
      return s.state === "done" ? s : undefined;
    });
    expect(done).toMatchObject({
      state: "done",
      summary: "Goal passed: All criteria proven.",
      resultBranch: "ezcoder/goal/goal-1",
      resultSha: "abc123def4567890",
    });
    expect(git.calls).toContainEqual(["checkout", "-B", "ezcoder/goal/goal-1"]);
    expect(git.calls).toContainEqual([
      "push",
      "--force",
      "origin",
      "HEAD:refs/heads/ezcoder/goal/goal-1",
    ]);
    expect(git.calls.some((args) => args[0] === "commit")).toBe(true);
    expect(server.context.acquireSlot("probe")).toBe(true);
    const log = await (await call("GET", "/v1/goals/goal-1/log?tail=5")).text();
    expect(log).toContain("finished: done");
    const list = (await (await call("GET", "/v1/goals")).json()) as GoalHostStatus[];
    expect(list.map((g) => g.id)).toEqual(["goal-1"]);
  }, 60_000);

  it('advertises the "goals" feature', async () => {
    const { server } = await setup(fakeHeadless());
    const hello = (await (await fetch(`${server.url}/v1/hello`)).json()) as { features: string[] };
    expect(hello.features).toContain("goals");
  }, 60_000);

  it("reports a failed push and keeps the workspace", async () => {
    const headless = fakeHeadless();
    const { call, repo } = await setup({ ...headless, git: fakeGit("push").git });
    await call("POST", "/v1/goals", body(repo));
    const run = await waitFor(() => headless.runs[0]);
    run.end({ status: "failed", summary: "Verifier failed." }, 1);
    const failed = await waitFor(async () => {
      const s = await statusOf(call);
      return s.state === "failed" ? s : undefined;
    });
    expect(failed.summary).toBe(
      `Goal failed: Verifier failed. Could not push ezcoder/goal/goal-1: git push failed: permission denied. The workspace is kept at ${run.cwd}.`,
    );
    expect(failed.resultSha).toBeUndefined();
    expect(fs.existsSync(run.cwd)).toBe(true);
  }, 60_000);

  it("stops a running goal on DELETE and frees its slot", async () => {
    const headless = fakeHeadless();
    const { server, call, repo } = await setup({ ...headless, git: fakeGit().git });
    await call("POST", "/v1/goals", body(repo));
    await waitFor(() => headless.runs[0]);
    const stopped = (await (await call("DELETE", "/v1/goals/goal-1")).json()) as GoalHostStatus;
    expect(stopped.state).toBe("stopped");
    expect(stopped.summary).toMatch(/^Stopped by the controller; the workspace is kept at /);
    expect(server.context.acquireSlot("probe")).toBe(true);
    expect((await call("GET", "/v1/goals/nope")).status).toBe(404);
  }, 60_000);

  it("re-adopts, finishes or marks lost after a node restart", async () => {
    const dataDir = tempDir("ezf-goals-");
    const goalsDir = path.join(dataDir, "goals");
    fs.mkdirSync(path.join(goalsDir, "done-while-down"), { recursive: true });
    fs.mkdirSync(path.join(goalsDir, "died"), { recursive: true });
    fs.writeFileSync(
      path.join(goalsDir, "done-while-down", "result.json"),
      JSON.stringify({ status: "passed", summary: "ok" }),
    );
    const record = (id: string, pid?: number): GoalHostRecord => ({
      id,
      project: "p",
      state: "running",
      startedAt: new Date().toISOString(),
      cwd: path.join(dataDir, "agents", `goal-${id}`),
      goalDir: path.join(goalsDir, id),
      base: "a".repeat(40),
      resultBranch: `ezcoder/goal/${id}`,
      ...(pid !== undefined && { pid }),
    });
    fs.writeFileSync(
      path.join(goalsDir, "hosted.json"),
      JSON.stringify({ goals: [record("done-while-down"), record("died", 999_999_999)] }),
    );
    const git = fakeGit();
    const { call } = await setup({ git: git.git }, 2, dataDir);
    const finished = await waitFor(async () => {
      const s = await statusOf(call, "done-while-down");
      return s.state === "done" ? s : undefined;
    });
    expect(finished.resultBranch).toBe("ezcoder/goal/done-while-down");
    const lost = await statusOf(call, "died");
    expect(lost.state).toBe("lost");
    expect(lost.summary).toMatch(/could not re-adopt it; its workspace is kept at /);
  }, 60_000);

  it("pushes the result branch to origin with real git (GL6)", async () => {
    const headless = fakeHeadless();
    const { call, repo } = await setup(headless);
    await call("POST", "/v1/goals", body(repo));
    const run = await waitFor(() => headless.runs[0]);
    sh(run.cwd, "config", "user.email", "node@example.com");
    sh(run.cwd, "config", "user.name", "Node");
    sh(run.cwd, "config", "commit.gpgsign", "false");
    fs.writeFileSync(path.join(run.cwd, "result.txt"), "made on the node\n");
    run.end({ status: "passed", summary: "done" });
    const done = await waitFor(async () => {
      const s = await statusOf(call);
      return s.state === "done" || s.state === "failed" ? s : undefined;
    });
    expect(done.state, done.summary).toBe("done");
    const remoteSha = sh(repo.origin, "rev-parse", "refs/heads/ezcoder/goal/goal-1").trim();
    expect(remoteSha).toBe(done.resultSha);
    expect(sh(repo.origin, "show", `${remoteSha}:result.txt`)).toBe("made on the node\n");
  }, 60_000);
});
