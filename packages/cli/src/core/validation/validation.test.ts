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
import type {
  BackendPollResult,
  Exec,
  MachineInfo,
  ValidationBackend,
  ValidationJob,
} from "./types.js";
import { loadBackends } from "./backends.js";
import { chooseTarget, listTargets } from "./scheduler.js";
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

// ── v2: pools, scheduling, recovery ─────────────────────────

const runner = (id: number, name: string, status: string, busy: boolean, labels: string[]) => ({
  id,
  name,
  status,
  busy,
  labels: ["self-hosted", "Linux", "X64", ...labels].map((n) => ({ name: n })),
});

const poolCfg = {
  id: "pool",
  kind: "github-actions" as const,
  repo: "you/test-worker",
  workflow: "remote-test.yml",
  discover: true,
  maxConcurrent: 1,
  capacity: { cpus: 4, memoryGb: 8 },
};

describe("pool discovery", () => {
  const page1 = {
    total_count: 4,
    runners: [
      runner(1, "my-pc-1", "online", true, [
        "ezcoder-docker",
        "ezw-my-pc",
        "ez-cpu-16",
        "ez-mem-15",
        "ez-slots-2",
        "linux",
        "wsl2",
      ]),
      runner(2, "my-pc-2", "online", false, ["ezcoder-docker", "ezw-my-pc", "linux", "wsl2"]),
    ],
  };
  const page2 = {
    total_count: 4,
    runners: [
      runner(3, "old-box", "online", false, ["ezcoder-docker"]),
      runner(4, "unrelated", "online", false, ["gpu"]),
    ],
  };

  it("groups runners by ezw- label, parses resource/platform labels, paginates and caches", async () => {
    const calls: string[][] = [];
    const b = new GitHubActionsBackend(poolCfg, async (_c, args) => {
      calls.push(args);
      return { code: 0, stderr: "", stdout: JSON.stringify(page1) + JSON.stringify(page2) };
    });
    const ms = await b.machines!();
    expect(calls[0]).toEqual([
      "api",
      "--paginate",
      "repos/you/test-worker/actions/runners?per_page=100",
    ]);
    const pc = ms.find((m) => m.name === "my-pc")!;
    expect(pc).toMatchObject({
      online: true,
      slots: 2,
      busy: 1,
      platform: ["linux", "wsl2"],
      capacity: { cpus: 16, memoryGb: 15 },
      runsOn: ["self-hosted", "ezcoder-docker", "ezw-my-pc"],
    });
    // No ezw- label: a machine named after the backend, with its static capacity.
    const old = ms.find((m) => m.name === "pool")!;
    expect(old).toMatchObject({ slots: 1, capacity: { cpus: 4, memoryGb: 8 } });
    expect(ms.map((m) => m.name)).not.toContain("unrelated");
    await b.machines!();
    expect(calls).toHaveLength(1); // cached
  });

  it("falls back to static capacity when the runner list can't be read", async () => {
    const b = new GitHubActionsBackend(poolCfg, async () => ({
      code: 1,
      stdout: "",
      stderr: "HTTP 403",
    }));
    const [m] = await b.machines!();
    expect(m).toMatchObject({ name: "pool", online: true, assumed: true, slots: 1 });
    expect(m!.capacity).toMatchObject({ cpus: 4, memoryGb: 8 });
  });

  it("dispatch pins the machine with runs_on and sends cache_key; static backends don't", async () => {
    const calls: string[][] = [];
    const exec: Exec = async (_c, args) => {
      calls.push(args);
      if (args[0] === "api") return { code: 0, stderr: "", stdout: JSON.stringify(page1) };
      return { code: 0, stderr: "", stdout: "https://github.com/you/test-worker/actions/runs/9\n" };
    };
    const job = {
      id: "vj",
      repo: "acme/My Proj!",
      sha: "b".repeat(40),
      command: "npm test",
      timeoutMinutes: 5,
      machine: "my-pc",
    } as ValidationJob;
    const pool = new GitHubActionsBackend(
      { ...poolCfg, cloud: { enabled: true, runsOn: ["ubuntu-latest"] } },
      exec,
    );
    await pool.machines!();
    await pool.dispatch(job);
    expect(calls.at(-1)).toEqual(
      expect.arrayContaining([
        'runs_on=["self-hosted","ezcoder-docker","ezw-my-pc"]',
        "cache_key=My_Proj_",
      ]),
    );
    await pool.dispatch({ ...job, machine: "cloud" });
    expect(calls.at(-1)).toContain('runs_on=["ubuntu-latest"]');

    const { discover: _d, ...staticCfg } = poolCfg;
    await new GitHubActionsBackend(staticCfg, exec).dispatch(job);
    expect(calls.at(-1)!.some((a) => a.startsWith("runs_on=") || a.startsWith("cache_key="))).toBe(
      false,
    );
  });

  it("keeps a static backends.json entry working and gains a pool with discover", () => {
    const dir = path.join(tmp, "cfg");
    fs.mkdirSync(dir);
    const entry = { ...poolCfg, id: "my-pc", discover: undefined, labels: ["self-hosted"] };
    fs.writeFileSync(path.join(dir, "backends.json"), JSON.stringify({ backends: [entry] }));
    const exec: Exec = async () => ({ code: 0, stdout: "", stderr: "" });
    const first = loadBackends(dir, exec);
    let backends = first.backends;
    const problems = first.problems;
    expect(problems).toEqual([]);
    expect(backends.map((b) => [b.id, b.maxConcurrent, !!b.machines])).toEqual([
      ["local", 2, false],
      ["my-pc", 1, false],
    ]);
    fs.writeFileSync(
      path.join(dir, "backends.json"),
      JSON.stringify({ backends: [{ ...entry, discover: true }] }),
    );
    ({ backends } = loadBackends(dir, exec));
    expect(!!backends[1]!.machines).toBe(true);
  });
});

describe("image-mode cache", () => {
  it("mounts the per-project cache at /cache and points package caches into it", () => {
    const cmd = buildStageCommand(
      {
        name: "test",
        command: "npm ci && npm test",
        run: "remote",
        required: true,
        timeoutMinutes: 5,
        docker: { image: "node:22" },
      },
      "proj",
    );
    expect(cmd).toContain('-v "${EZ_CACHE:-$HOME/.cache/ezcoder-worker/proj}":/cache');
    expect(cmd).toContain('-v "$PWD":/w');
    for (const e of [
      "npm_config_cache=/cache/npm",
      "PIP_CACHE_DIR=/cache/pip",
      "BUNDLE_PATH=/cache/bundle",
      "GOMODCACHE=/cache/go/mod",
      "GOCACHE=/cache/go/build",
      "CARGO_HOME=/cache/cargo",
      "npm_config_store_dir=/cache/pnpm-store",
      "YARN_CACHE_FOLDER=/cache/yarn",
    ])
      expect(cmd).toContain(`-e ${e}`);
    expect(cmd).toMatch(/'node:22' sh -c 'npm ci && npm test'$/);
  });
});

/** Fake pool: machines as the test says; poll results per job id. */
class FakePool implements ValidationBackend {
  readonly kind = "github-actions";
  readonly runs = "remote" as const;
  readonly maxConcurrent = 1;
  dispatched: ValidationJob[] = [];
  cancelled: string[] = [];
  results = new Map<string, BackendPollResult>();
  constructor(
    readonly id: string,
    public list: MachineInfo[],
  ) {}
  readonly machines = async () => this.list;
  async dispatch(job: ValidationJob) {
    this.dispatched.push(job);
    return { runId: `r${this.dispatched.length}`, url: `https://gh/run/${this.dispatched.length}` };
  }
  async poll(job: ValidationJob): Promise<BackendPollResult> {
    return this.results.get(job.runId!) ?? { state: "running" };
  }
  async logs() {
    return "";
  }
  async cancel(job: ValidationJob) {
    this.cancelled.push(job.id);
  }
  async health() {
    return { online: true, detail: "" };
  }
}

function machine(name: string, o: Partial<MachineInfo> = {}): MachineInfo {
  return {
    name,
    online: true,
    slots: 1,
    busy: 0,
    platform: ["linux"],
    capacity: { cpus: 8, memoryGb: 16, labels: ["linux"] },
    runsOn: ["self-hosted", "ezcoder-docker", `ezw-${name}`],
    detail: "",
    ...o,
  };
}

const cloudM = (o: Partial<MachineInfo> = {}) =>
  machine("cloud", { cloud: true, overflowOnly: true, slots: 2, runsOn: ["ubuntu-latest"], ...o });

function qjob(o: Partial<ValidationJob> = {}): ValidationJob {
  return {
    id: `q${Math.random()}`,
    project: "/p",
    repo: "acme/proj",
    sha: "c".repeat(40),
    stage: "test",
    run: "remote",
    required: true,
    command: "x",
    timeoutMinutes: 5,
    backend: "",
    state: "queued",
    createdAt: "",
    updatedAt: "",
    ...o,
  };
}

describe("scheduler", () => {
  it("picks by capacity, free slots (incl. GitHub-busy runners) and reserved resources", async () => {
    const pool = new FakePool("pool", [
      machine("small", { capacity: { cpus: 4, memoryGb: 8 } }),
      machine("big", { slots: 2, capacity: { cpus: 16, memoryGb: 15 } }),
    ]);
    const targets = await listTargets([pool]);
    expect(
      (chooseTarget(qjob({ resources: { memoryGb: 12 } }), targets, []) as { key: string }).key,
    ).toBe("pool/big");
    expect(chooseTarget(qjob({ resources: { memoryGb: 64 } }), targets, [])).toBe("none");
    // big has 2 slots but GitHub reports both runners busy: nothing free.
    pool.list[1]!.busy = 2;
    const busyTargets = await listTargets([pool]);
    expect(chooseTarget(qjob({ resources: { memoryGb: 12 } }), busyTargets, [])).toBeUndefined();
    // One slot free but our in-flight job there holds 10 of its 15 GB.
    pool.list[1]!.busy = 0;
    const t2 = await listTargets([pool]);
    const ours = qjob({
      state: "waiting",
      backend: "pool",
      machine: "big",
      resources: { memoryGb: 10 },
    });
    expect(chooseTarget(qjob({ resources: { memoryGb: 9 } }), t2, [ours])).toBeUndefined();
    expect(
      (chooseTarget(qjob({ resources: { cpus: 6, memoryGb: 4 } }), t2, [ours]) as { key: string })
        .key,
    ).toBe("pool/big");
  });

  it("prefers the machine that last ran the repo, then the lowest load, and avoids listed ones", async () => {
    const pool = new FakePool("pool", [machine("a"), machine("b")]);
    const t = await listTargets([pool]);
    const past = qjob({ state: "passed", backend: "pool", machine: "b", dispatchedAt: "x" });
    expect((chooseTarget(qjob(), t, [past]) as { key: string }).key).toBe("pool/b");
    expect((chooseTarget(qjob({ avoid: ["pool/b"] }), t, [past]) as { key: string }).key).toBe(
      "pool/a",
    );
  });

  it("stays queued when every machine is offline; overflows to cloud only when enabled", async () => {
    const pool = new FakePool("pool", [machine("a", { online: false })]);
    expect(chooseTarget(qjob(), await listTargets([pool]), [])).toBe("offline");
    pool.list.push(cloudM());
    expect((chooseTarget(qjob(), await listTargets([pool]), []) as { key: string }).key).toBe(
      "pool/cloud",
    );
    // Self-hosted online but full: overflow-only cloud is not used, the job waits.
    pool.list[0]!.online = true;
    pool.list[0]!.busy = 1;
    expect(chooseTarget(qjob(), await listTargets([pool]), [])).toBeUndefined();
  });
});

describe("recovery", () => {
  async function setup(list: MachineInfo[]) {
    const repo = makeRepo();
    const pool = new FakePool("pool", list);
    const svc = new ValidationService({
      dir: path.join(tmp, "state"),
      exec: execWithFakeGh([]),
      backends: [pool],
      pollMs: 60_000,
      machineOfflineRequeueMinutes: 0,
    });
    const job = (await svc.enqueue(repo, { stages: ["test"] })).jobs[0]!;
    return { repo, pool, svc, job };
  }

  it("requeues a lost run on a different machine, up to 3 attempts", async () => {
    const { pool, svc, job } = await setup([machine("a"), machine("b")]);
    const queue = new AgentNotificationQueue();
    const detach = attachValidationNotifications(() => job.project, queue, svc);
    await svc.tick();
    expect(pool.dispatched.map((j) => j.machine)).toEqual(["a"]);
    pool.results.set("r1", { state: "error", lost: "runner lost", summary: "x" });
    await svc.tick();
    let j = (await svc.get(job.id))!;
    expect([j.state, j.attempts, j.machine, j.requeues?.[0]?.from]).toEqual([
      "waiting",
      2,
      "b",
      "pool/a",
    ]);
    expect(queue.drain().some((n) => n.text.includes("re-queued") && !n.urgent)).toBe(true);
    pool.results.set("r2", { state: "error", lost: "run vanished" });
    await svc.tick();
    pool.results.set("r3", { state: "error", lost: "runner lost" });
    await svc.tick();
    j = (await svc.get(job.id))!;
    expect(j.state).toBe("error");
    expect(j.requeues).toHaveLength(3);
    expect(pool.dispatched).toHaveLength(3);
    detach();
    svc.stop();
  });

  it("cancels and requeues a run waiting on a machine that went offline", async () => {
    const { pool, svc, job } = await setup([machine("a"), machine("b")]);
    await svc.tick();
    pool.results.set("r1", { state: "waiting" });
    pool.list[0]!.online = false;
    await svc.tick(); // notes the offline time
    expect((await svc.get(job.id))!.machineOfflineSince).toBeTruthy();
    await new Promise((r) => setTimeout(r, 5));
    await svc.tick();
    expect(pool.cancelled).toEqual([job.id]);
    const j = (await svc.get(job.id))!;
    expect([j.machine, j.attempts, j.state]).toEqual(["b", 2, "waiting"]);
    svc.stop();
  });

  it("never requeues jobs EZCODER cancelled or superseded", async () => {
    const { repo, pool, svc, job } = await setup([machine("a"), machine("b", { slots: 0 })]);
    await svc.tick();
    await svc.cancel(job.id);
    pool.results.set("r1", { state: "cancelled", lost: "cancelled" });
    await svc.tick();
    expect((await svc.get(job.id))!.state).toBe("cancelled");
    const second = (await svc.enqueue(repo, { stages: ["test"], force: true })).jobs[0]!;
    await svc.tick();
    commit(repo, "two");
    await svc.enqueue(repo, { stages: ["test"] });
    pool.results.set("r2", { state: "error", lost: "runner lost" });
    await svc.tick();
    const s = (await svc.get(second.id))!;
    expect(s.state).toBe("superseded");
    expect(s.requeues).toBeUndefined();
    expect(pool.dispatched).toHaveLength(3);
    svc.stop();
  });

  it("runs a stage pinned to pool/machine only there", async () => {
    const { repo, pool, svc } = await setup([machine("a"), machine("b")]);
    write(
      ".ezcoder/validation.json",
      JSON.stringify({ stages: [{ name: "e2e", command: "e", backend: "pool/b" }] }),
      repo,
    );
    const j = (await svc.enqueue(repo, { stages: ["e2e"] })).jobs[0]!;
    expect([j.backend, j.machine, j.pinned]).toEqual(["pool", "b", true]);
    await svc.tick();
    expect(pool.dispatched.find((x) => x.stage === "e2e")!.machine).toBe("b");
    svc.stop();
  });
});

describe("billing-blocked cloud runs", () => {
  it("classifies a zero-step run with a budget annotation as an infra error, not a loss", async () => {
    const exec: Exec = async (_c, args) => {
      if (args[0] === "api" && args[1]!.includes("/annotations")) {
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify([
            {
              message:
                "The job was not started because an Actions budget is preventing further use.",
            },
          ]),
        };
      }
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          status: "completed",
          conclusion: "failure",
          url: "u",
          jobs: [{ databaseId: 77, steps: [] }],
        }),
      };
    };
    const r = await new GitHubActionsBackend(poolCfg, exec).poll({
      id: "v",
      runId: "5",
    } as ValidationJob);
    expect(r.state).toBe("error");
    expect(r.lost).toBeUndefined();
    expect(r.blocked).toContain("Actions budget");
    expect(r.summary).toContain("GitHub Actions budget/billing blocks cloud runners");
    // Zero steps, no annotation: still an infra error (runner never started), not a test failure.
    const bare: Exec = async (_c, args) =>
      args[1]!.includes("/annotations") ? { code: 0, stderr: "", stdout: "[]" } : exec("gh", args);
    expect(
      (await new GitHubActionsBackend(poolCfg, bare).poll({ id: "v", runId: "5" } as ValidationJob))
        .state,
    ).toBe("error");
  });

  it("benches the cloud target and requeues once to a self-hosted machine", async () => {
    const repo = makeRepo();
    const pool = new FakePool("pool", [
      machine("a", { online: true }),
      cloudM({ overflowOnly: false }),
    ]);
    const svc = new ValidationService({
      dir: path.join(tmp, "state"),
      exec: execWithFakeGh([]),
      backends: [pool],
      pollMs: 60_000,
    });
    write(
      ".ezcoder/validation.json",
      JSON.stringify({
        stages: [
          { name: "a", command: "a" },
          { name: "b", command: "b" },
        ],
      }),
      repo,
    );
    const [ja, jb] = (await svc.enqueue(repo)).jobs;
    await svc.tick();
    expect(pool.dispatched.map((j) => j.machine)).toEqual(["a", "cloud"]);
    pool.results.set("r2", { state: "error", blocked: "Actions budget", summary: "budget" });
    await svc.tick();
    let b = (await svc.get(jb!.id))!;
    expect(b.state).toBe("queued"); // machine a is still busy with job a
    expect(b.attempts).toBe(1); // a billing refusal is not a runner loss
    expect(b.requeues?.[0]?.reason).toContain("budget/billing");
    expect((await svc.workers()).find((w) => w.id === "pool/cloud")!.blockedUntil).toBeTruthy();
    pool.results.set("r1", { state: "passed" });
    await svc.tick();
    b = (await svc.get(jb!.id))!;
    expect([b.state, b.machine]).toEqual(["waiting", "a"]);
    expect(pool.dispatched).toHaveLength(3); // cloud not tried again
    expect((await svc.get(ja!.id))!.state).toBe("passed");
    svc.stop();
  });

  it("leaves the error when no self-hosted machine fits", async () => {
    const repo = makeRepo();
    const pool = new FakePool("pool", [cloudM()]);
    const svc = new ValidationService({
      dir: path.join(tmp, "state"),
      exec: execWithFakeGh([]),
      backends: [pool],
      pollMs: 60_000,
    });
    const job = (await svc.enqueue(repo, { stages: ["test"] })).jobs[0]!;
    await svc.tick();
    pool.results.set("r1", { state: "error", blocked: "Actions budget" });
    await svc.tick();
    const j = (await svc.get(job.id))!;
    expect(j.state).toBe("error");
    expect(j.summary).toContain("budget/billing");
    expect(pool.dispatched).toHaveLength(1);
    svc.stop();
  });
});
