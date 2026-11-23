import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildStageCommand, detectStages, loadProjectConfig, parseGitHubRepo } from "./config.js";
import { defaultExec } from "./exec.js";
import { GitHubActionsBackend } from "./github-actions-backend.js";
import { LocalBackend } from "./local-backend.js";
import { notificationFor, ValidationService } from "./service.js";
import type { BackendPollResult, Exec, ValidationBackend, ValidationJob } from "./types.js";
import { AgentNotificationQueue } from "../agent-notifications.js";
import { attachValidationNotifications } from "./session-hook.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ezv-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, text: string, root = tmp) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRepo(): string {
  const repo = path.join(tmp, "proj");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  git(repo, "remote", "add", "origin", "https://github.com/acme/proj.git");
  write("package.json", JSON.stringify({ scripts: { test: "vitest", lint: "eslint ." } }), repo);
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "one");
  return repo;
}

function commit(repo: string, msg: string): string {
  write("f.txt", msg, repo);
  git(repo, "add", ".");
  git(repo, "commit", "-qm", msg);
  return git(repo, "rev-parse", "HEAD");
}

/** Fake remote backend: jobs move as the test says. */
class FakeRemote implements ValidationBackend {
  readonly kind = "fake";
  readonly runs = "remote" as const;
  dispatched: ValidationJob[] = [];
  cancelled: string[] = [];
  results = new Map<string, BackendPollResult>();
  online = true;
  constructor(
    readonly id = "fake",
    readonly maxConcurrent = 1,
    readonly capacity?: { memoryGb?: number },
  ) {}
  async dispatch(job: ValidationJob) {
    this.dispatched.push(job);
    return { runId: `r-${job.id}`, url: `https://gh/run/${job.id}` };
  }
  async poll(job: ValidationJob): Promise<BackendPollResult> {
    return this.results.get(job.id) ?? { state: "running" };
  }
  async logs() {
    return "Failures:\n  1) expected 1 to equal 2";
  }
  async cancel(job: ValidationJob) {
    this.cancelled.push(job.id);
  }
  async health() {
    return { online: this.online, detail: this.online ? "up" : "pc off" };
  }
}

/** Real git, fake gh (records calls). */
function execWithFakeGh(calls: string[][], opts: { missingCommit?: boolean } = {}): Exec {
  return async (cmd, args, o) => {
    if (cmd === "gh") {
      calls.push(args);
      if (opts.missingCommit && args[1]?.includes("/commits/")) {
        return { code: 1, stdout: "", stderr: "HTTP 422: No commit found for SHA" };
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    return defaultExec(cmd, args, o);
  };
}

function statusCalls(calls: string[][]) {
  return calls
    .filter((c) => c[0] === "api" && c.includes("POST"))
    .map((c) => c.find((a) => a.startsWith("state="))!.slice(6));
}

describe("config", () => {
  it("detects a pnpm project: quick local stage plus a remote test in node:22", () => {
    write("package.json", JSON.stringify({ scripts: { test: "vitest", typecheck: "tsc" } }));
    write("pnpm-lock.yaml", "");
    const { stages } = detectStages(tmp);
    expect(stages.map((s) => [s.name, s.run, s.required])).toEqual([
      ["typecheck", "local", false],
      ["test", "remote", true],
    ]);
    expect(stages[1]!.docker?.image).toBe("node:22");
    expect(stages[1]!.command).toContain("pnpm install --frozen-lockfile && pnpm test");
  });

  it("prefers a compose test file with a tests service", () => {
    write("docker-compose.test.yml", "services:\n  tests:\n    build: .\n");
    write("package.json", JSON.stringify({ scripts: { test: "jest" } }));
    const test = detectStages(tmp).stages.find((s) => s.name === "test")!;
    expect(test.command).toContain("--exit-code-from tests");
  });

  it("reads the config file, fills defaults and wraps compose commands", () => {
    write(
      ".ezcoder/validation.json",
      JSON.stringify({
        stages: [
          {
            name: "models",
            command: "bundle exec rspec spec/models",
            setup: "export BMF_DB_ROOT=$RUNNER_TEMP/bmfdb",
            docker: { compose: "docker-compose-test.yml", service: "bmf_app", entrypoint: "" },
            timeoutMinutes: 150,
          },
        ],
      }),
    );
    const cfg = loadProjectConfig(tmp);
    if ("error" in cfg) throw new Error(cfg.error);
    const s = cfg.stages[0]!;
    expect([s.run, s.required, s.timeoutMinutes]).toEqual(["remote", true, 150]);
    expect(buildStageCommand(s)).toBe(
      "export BMF_DB_ROOT=$RUNNER_TEMP/bmfdb && docker compose -f 'docker-compose-test.yml' build 'bmf_app' && " +
        "docker compose -f 'docker-compose-test.yml' run --rm --entrypoint '' 'bmf_app' sh -c 'bundle exec rspec spec/models'",
    );
  });

  it("rejects bad stage names and duplicate stages", () => {
    write(
      ".ezcoder/validation.json",
      JSON.stringify({ stages: [{ name: "Bad Name", command: "x" }] }),
    );
    expect(loadProjectConfig(tmp)).toHaveProperty("error");
  });

  it("parses GitHub remotes", () => {
    expect(parseGitHubRepo("git@github.com:Gahroot/ezcoder.git")).toBe("Gahroot/ezcoder");
    expect(parseGitHubRepo("https://github.com/a/b")).toBe("a/b");
    expect(parseGitHubRepo("https://gitlab.com/a/b")).toBeUndefined();
  });
});

describe("ValidationService", () => {
  it("dispatches with bounded concurrency, posts statuses and gates on the exact commit", async () => {
    const repo = makeRepo();
    const calls: string[][] = [];
    const fake = new FakeRemote("fake", 1);
    const svc = new ValidationService({
      dir: path.join(tmp, "state"),
      exec: execWithFakeGh(calls),
      backends: [new LocalBackend(path.join(tmp, "state", "logs")), fake],
      pollMs: 60_000,
    });
    const sha = git(repo, "rev-parse", "HEAD");
    const r = await svc.enqueue(repo, { stages: ["test"] });
    expect(r.jobs).toHaveLength(1);
    expect(r.jobs[0]!.statusContext).toBe("ezcoder/test");
    // A second project-stage competes for the single slot.
    write(
      ".ezcoder/validation.json",
      JSON.stringify({ stages: [{ name: "e2e", command: "e2e" }], extendDefaults: true }),
      repo,
    );
    await svc.enqueue(repo, { stages: ["e2e"] });
    await svc.tick();
    expect(fake.dispatched.map((j) => j.stage)).toEqual(["test"]);
    expect(fake.dispatched[0]!.sha).toBe(sha);
    expect(statusCalls(calls)).toEqual(["pending"]);

    let gate = await svc.gate(repo);
    expect(gate.ok).toBe(false);

    fake.results.set(r.jobs[0]!.id, { state: "passed" });
    await svc.tick(); // test passes; e2e takes the freed slot
    expect(fake.dispatched.map((j) => j.stage)).toEqual(["test", "e2e"]);
    const e2e = fake.dispatched[1]!;
    fake.results.set(e2e.id, { state: "passed" });
    await svc.tick();
    expect(statusCalls(calls)).toEqual(["pending", "success", "pending", "success"]);
    gate = await svc.gate(repo);
    expect(gate.ok).toBe(true);

    // A newer commit is not covered by the old results.
    commit(repo, "two");
    expect((await svc.gate(repo)).ok).toBe(false);
    svc.stop();
  });

  it("reuses a pass at the same commit and supersedes older commits on the branch", async () => {
    const repo = makeRepo();
    const fake = new FakeRemote();
    const svc = new ValidationService({
      dir: path.join(tmp, "state"),
      exec: execWithFakeGh([]),
      backends: [fake],
      pollMs: 60_000,
    });
    const first = (await svc.enqueue(repo, { stages: ["test"] })).jobs[0]!;
    await svc.tick();
    // Running job on an old commit gets superseded and cancelled on the worker.
    commit(repo, "two");
    const second = await svc.enqueue(repo, { stages: ["test"] });
    expect(second.messages.join()).toContain("superseded");
    await svc.tick();
    expect(fake.cancelled).toEqual([first.id]);
    expect((await svc.get(first.id))!.state).toBe("superseded");
    // Late result for the superseded run must not overwrite it.
    fake.results.set(first.id, { state: "passed" });
    fake.results.set(second.jobs[0]!.id, { state: "passed" });
    await svc.tick();
    expect((await svc.get(first.id))!.state).toBe("superseded");
    const again = await svc.enqueue(repo, { stages: ["test"] });
    expect(again.jobs).toHaveLength(0);
    expect(again.reused[0]!.state).toBe("passed");
    svc.stop();
  });

  it("refuses commits that are not on GitHub without touching the worker", async () => {
    const repo = makeRepo();
    const fake = new FakeRemote();
    const svc = new ValidationService({
      dir: path.join(tmp, "state"),
      exec: execWithFakeGh([], { missingCommit: true }),
      backends: [fake],
      pollMs: 60_000,
    });
    const job = (await svc.enqueue(repo, { stages: ["test"] })).jobs[0]!;
    await svc.tick();
    expect(fake.dispatched).toHaveLength(0);
    const after = (await svc.get(job.id))!;
    expect(after.state).toBe("error");
    expect(after.summary).toContain("isn't on GitHub");
    svc.stop();
  });

  it("survives a restart: a fresh service picks up in-flight jobs and reports results", async () => {
    const repo = makeRepo();
    const dir = path.join(tmp, "state");
    const fake = new FakeRemote();
    const a = new ValidationService({
      dir,
      exec: execWithFakeGh([]),
      backends: [fake],
      pollMs: 60_000,
    });
    const job = (await a.enqueue(repo, { stages: ["test"] })).jobs[0]!;
    await a.tick();
    a.stop();
    fs.rmSync(path.join(dir, "leader.json")); // the old process is gone

    const b = new ValidationService({
      dir,
      exec: execWithFakeGh([]),
      backends: [fake],
      pollMs: 60_000,
    });
    const queue = new AgentNotificationQueue();
    const detach = attachValidationNotifications(() => repo, queue, b);
    await b.tick(); // seed: nothing finished yet
    fake.results.set(job.id, { state: "failed", summary: "test command failed" });
    await b.tick();
    const notes = queue.drain();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.urgent).toBe(true);
    expect(notes[0]!.text).toContain("Validation FAILED");
    expect(notes[0]!.text).toContain("expected 1 to equal 2");
    detach();
    b.stop();
  });

  it("routes by resources across workers, and a second worker adds capacity", async () => {
    const repo = makeRepo();
    write(
      ".ezcoder/validation.json",
      JSON.stringify({
        stages: [
          { name: "a", command: "a" },
          { name: "b", command: "b" },
          { name: "big", command: "big", resources: { memoryGb: 30 } },
        ],
      }),
      repo,
    );
    const small = new FakeRemote("small", 1, { memoryGb: 8 });
    const large = new FakeRemote("large", 1, { memoryGb: 64 });
    const svc = new ValidationService({
      dir: path.join(tmp, "state"),
      exec: execWithFakeGh([]),
      backends: [small, large],
      pollMs: 60_000,
    });
    await svc.enqueue(repo);
    await svc.tick();
    expect(small.dispatched.map((j) => j.stage)).toEqual(["a"]);
    expect(large.dispatched.map((j) => j.stage)).toEqual(["b"]);
    for (const j of [...small.dispatched, ...large.dispatched])
      small.results.set(j.id, { state: "passed" });
    large.results = small.results;
    await svc.tick();
    expect(large.dispatched.map((j) => j.stage)).toEqual(["b", "big"]);
    expect(small.dispatched).toHaveLength(1);
    svc.stop();
  });

  it("runs local stages on this machine, detached, and marks dirty-tree results advisory", async () => {
    const repo = makeRepo();
    write(
      ".ezcoder/validation.json",
      JSON.stringify({
        stages: [
          { name: "ok", command: "echo hello-local", run: "local", required: true },
          { name: "bad", command: "echo boom; exit 3", run: "local" },
        ],
      }),
      repo,
    );
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "cfg");
    const svc = new ValidationService({
      dir: path.join(tmp, "state"),
      exec: execWithFakeGh([]),
      backends: [new LocalBackend(path.join(tmp, "state", "logs"))],
      pollMs: 60_000,
    });
    const r = await svc.enqueue(repo);
    await svc.tick();
    for (let i = 0; i < 50; i++) {
      await new Promise((res) => setTimeout(res, 100));
      await svc.tick();
      const jobs = await svc.list(repo);
      if (jobs.every((j) => j.state === "passed" || j.state === "failed")) break;
    }
    const [ok, bad] = r.jobs.map((j) => j.id);
    expect((await svc.get(ok!))!.state).toBe("passed");
    expect((await svc.get(bad!))!.state).toBe("failed");
    expect(await svc.logs(ok!)).toContain("hello-local");
    expect((await svc.gate(repo)).ok).toBe(true);

    write("f.txt", "uncommitted", repo);
    git(repo, "add", "f.txt");
    const dirty = await svc.enqueue(repo, { stages: ["ok"] });
    expect(dirty.jobs).toHaveLength(1);
    expect(dirty.jobs[0]!.dirty).toBe(true);
    svc.stop();
  });
});

describe("GitHubActionsBackend", () => {
  const cfg = {
    id: "pc",
    kind: "github-actions" as const,
    repo: "Gahroot/ezcoder-remote-worker",
    workflow: "remote-test.yml",
    labels: ["self-hosted", "ezcoder-docker"],
  };
  const job = {
    id: "vabc",
    repo: "acme/proj",
    sha: "a".repeat(40),
    command: "npm test",
    timeoutMinutes: 30,
    statusContext: "ezcoder/test",
  } as ValidationJob;

  it("dispatches an exact SHA with the job id and reads the run URL", async () => {
    const calls: string[][] = [];
    const b = new GitHubActionsBackend(cfg, async (_c, args) => {
      calls.push(args);
      return {
        code: 0,
        stdout: "https://github.com/Gahroot/ezcoder-remote-worker/actions/runs/123\n",
        stderr: "",
      };
    });
    expect(await b.dispatch(job)).toEqual({
      runId: "123",
      url: "https://github.com/Gahroot/ezcoder-remote-worker/actions/runs/123",
    });
    expect(calls[0]).toEqual(
      expect.arrayContaining([
        `ref=${"a".repeat(40)}`,
        "repo=acme/proj",
        "job_id=vabc",
        "status_context=ezcoder/test",
      ]),
    );
  });

  it("maps runs: setup failure is a worker error, test failure is a code failure", async () => {
    const view = (conclusion: string, failedStep: string) => async () => ({
      code: 0,
      stderr: "",
      stdout: JSON.stringify({
        status: "completed",
        conclusion,
        url: "u",
        jobs: [{ steps: [{ name: failedStep, conclusion: "failure", status: "completed" }] }],
      }),
    });
    const withRun = { ...job, runId: "1" };
    expect(
      (await new GitHubActionsBackend(cfg, view("failure", "Run test command")).poll(withRun))
        .state,
    ).toBe("failed");
    expect(
      (
        await new GitHubActionsBackend(cfg, view("failure", "Run actions/checkout@v5")).poll(
          withRun,
        )
      ).state,
    ).toBe("error");
  });

  it("reports an offline runner", async () => {
    const b = new GitHubActionsBackend(cfg, async () => ({
      code: 0,
      stderr: "",
      stdout: JSON.stringify({
        runners: [
          {
            name: "groot-pc",
            status: "offline",
            busy: false,
            labels: [{ name: "self-hosted" }, { name: "ezcoder-docker" }],
          },
        ],
      }),
    }));
    expect(await b.health()).toMatchObject({ online: false });
  });

  it("notification text for an offline wait tells the agent not to retry", () => {
    const n = notificationFor({
      ...job,
      stage: "test",
      state: "waiting",
      offlineWarned: true,
      summary: "worker offline",
    } as ValidationJob);
    expect(n?.urgent).toBe(true);
    expect(n?.text).toContain("Not retrying");
  });
});

describe("short-lived callers", () => {
  it("queue without leading when autoStart is off", async () => {
    const repo = makeRepo();
    const dir = path.join(tmp, "state");
    const svc = new ValidationService({
      dir,
      exec: execWithFakeGh([]),
      backends: [new FakeRemote()],
      autoStart: false,
    });
    await svc.enqueue(repo, { stages: ["test"] });
    await new Promise((r) => setTimeout(r, 50));
    expect(svc.running).toBe(false);
    expect(fs.existsSync(path.join(dir, "leader.json"))).toBe(false);
    expect(await svc.leaderAlive()).toBe(false);
  });
});
