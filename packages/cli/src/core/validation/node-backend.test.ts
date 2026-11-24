import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FleetClientError } from "../fleet/client.js";
import type { JobRequest, JobStatus, NodeInfo } from "../fleet/protocol.js";
import { loadBackends } from "./backends.js";
import { defaultExec } from "./exec.js";
import { NodeBackend, type NodeBackendDeps, type NodeJobClient } from "./node-backend.js";
import { ValidationService } from "./service.js";
import type { Exec, ValidationJob } from "./types.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ezv-node-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRepo(): string {
  const repo = path.join(tmp, "proj");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  git(repo, "remote", "add", "origin", "https://github.com/you/repo.git");
  fs.writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify({ scripts: { test: "vitest" } }),
  );
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "one");
  return repo;
}

/** gh answers OK (commit is on GitHub, statuses accepted); everything else runs for real. */
const execWithFakeGh: Exec = async (cmd, args, o) =>
  cmd === "gh" ? { code: 0, stdout: "", stderr: "" } : defaultExec(cmd, args, o);

function nodeInfo(name: string, over: Partial<NodeInfo> = {}): NodeInfo {
  return {
    ezcoderNode: true,
    protocol: 1,
    name,
    version: "0.0.0",
    platform: "linux",
    hostname: name,
    arch: "x64",
    cpus: 16,
    memoryGb: 32,
    memoryFreeGb: 20,
    load: 0.2,
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

/** A fake fleet: per-node job tables the test moves along. */
class FakeFleet {
  readonly infos = new Map<string, NodeInfo>();
  readonly jobs = new Map<string, { node: string; req: JobRequest; status: JobStatus }>();
  readonly cancelled: string[] = [];
  readonly down = new Set<string>();

  constructor(names: string[]) {
    for (const name of names) this.infos.set(name, nodeInfo(name));
  }

  unreachable(name: string): FleetClientError {
    return new FleetClientError(`node ${name} is unreachable`, "unreachable");
  }

  deps(): NodeBackendDeps {
    return {
      listNodes: async () => [...this.infos.keys()].map((name) => ({ name })),
      info: async (name) => {
        if (this.down.has(name)) throw this.unreachable(name);
        const info = this.infos.get(name)!;
        const used = [...this.jobs.values()].filter(
          (j) => j.node === name && ["preparing", "running"].includes(j.status.state),
        ).length;
        return { ...info, slotsUsed: info.slotsUsed + used };
      },
      client: async (name) => this.client(name),
    };
  }

  client(name: string): NodeJobClient {
    const get = (id: string) => {
      if (this.down.has(name)) throw this.unreachable(name);
      const job = this.jobs.get(id);
      if (!job || job.node !== name) throw new FleetClientError("not found", "not_found", 404);
      return job;
    };
    return {
      submitJob: async (req) => {
        if (this.down.has(name)) throw this.unreachable(name);
        const status: JobStatus = {
          id: req.id,
          kind: req.kind,
          project: req.project,
          state: "preparing",
          logBytes: 0,
        };
        this.jobs.set(req.id, { node: name, req, status });
        return status;
      },
      job: async (id) => get(id).status,
      jobLog: async (id) => {
        get(id);
        const text = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
        return { text, size: text.length };
      },
      cancelJob: async (id) => {
        const job = get(id);
        this.cancelled.push(id);
        job.status = { ...job.status, state: "cancelled" };
        return job.status;
      },
    };
  }

  set(id: string, patch: Partial<JobStatus>) {
    const job = this.jobs.get(id)!;
    job.status = { ...job.status, ...patch };
  }
}

function service(backend: NodeBackend) {
  return new ValidationService({
    dir: path.join(tmp, "state"),
    exec: execWithFakeGh,
    backends: [backend],
    pollMs: 60_000,
  });
}

describe("node validation backend", () => {
  it("lists one machine per paired node with live slots, capacity and labels", async () => {
    const fleet = new FakeFleet(["my-pc", "gpu-box"]);
    fleet.infos.set(
      "gpu-box",
      nodeInfo("gpu-box", { platform: "wsl2", labels: ["gpu"], slotsUsed: 1 }),
    );
    fleet.down.add("my-pc");
    const backend = new NodeBackend({ kind: "node" }, fleet.deps());
    const machines = await backend.machines();
    expect(machines.map((m) => [m.name, m.online, m.slots, m.busy])).toEqual([
      ["my-pc", false, 0, 0],
      ["gpu-box", true, 2, 1],
    ]);
    expect(machines[1]!.platform).toEqual(["linux", "wsl2"]);
    expect(machines[1]!.capacity).toEqual({
      cpus: 16,
      memoryGb: 32,
      labels: ["node", "gpu", "docker"],
    });
    expect(await backend.health()).toMatchObject({ online: true, busy: false });
    // `nodes` restricts the pool.
    const only = new NodeBackend({ kind: "node", id: "gpu", nodes: ["gpu-box"] }, fleet.deps());
    expect((await only.machines()).map((m) => m.name)).toEqual(["gpu-box"]);
  });

  it("runs a stage on a node as a validate job and reports pass/fail", async () => {
    const repo = makeRepo();
    const sha = git(repo, "rev-parse", "HEAD");
    const fleet = new FakeFleet(["my-pc"]);
    const svc = service(new NodeBackend({ kind: "node" }, fleet.deps()));
    const job = (await svc.enqueue(repo, { stages: ["test"] })).jobs[0]!;
    await svc.tick();
    const sent = fleet.jobs.get(job.id)!;
    expect(sent.node).toBe("my-pc");
    expect(sent.req).toMatchObject({
      id: job.id,
      kind: "validate",
      project: "you/repo",
      source: { git: "https://github.com/you/repo.git", sha },
      command: job.command,
      timeoutMinutes: job.timeoutMinutes,
    });
    expect((await svc.get(job.id))!).toMatchObject({ state: "waiting", machine: "my-pc" });
    fleet.set(job.id, { state: "running" });
    await svc.tick();
    expect((await svc.get(job.id))!.state).toBe("running");
    fleet.set(job.id, { state: "failed", exitCode: 1 });
    await svc.tick();
    expect((await svc.get(job.id))!.state).toBe("failed");
    svc.stop();
  });

  it("requeues a run the node lost on another node", async () => {
    const repo = makeRepo();
    const fleet = new FakeFleet(["my-pc", "gpu-box"]);
    const svc = service(new NodeBackend({ kind: "node" }, fleet.deps()));
    const job = (await svc.enqueue(repo, { stages: ["test"] })).jobs[0]!;
    await svc.tick();
    const first = fleet.jobs.get(job.id)!.node;
    fleet.set(job.id, { state: "lost" });
    await svc.tick();
    const j = (await svc.get(job.id))!;
    expect(j.attempts).toBe(2);
    expect(j.requeues?.[0]?.reason).toContain("lost the run");
    expect(j.machine).not.toBe(first);
    expect(fleet.jobs.get(job.id)!.node).toBe(j.machine);
    svc.stop();
  });

  it("treats a node unreachable too long during a run as lost; briefly unreachable is transient", async () => {
    const fleet = new FakeFleet(["my-pc"]);
    const job = { id: "j1", machine: "my-pc" } as ValidationJob;
    await fleet.client("my-pc").submitJob({ id: "j1" } as JobRequest);
    fleet.down.add("my-pc");
    const patient = new NodeBackend({ kind: "node" }, fleet.deps());
    await expect(patient.poll(job)).rejects.toThrow(/unreachable/);
    const quick = new NodeBackend({ kind: "node" }, fleet.deps(), 0);
    await expect(quick.poll(job)).rejects.toThrow(/unreachable/);
    await new Promise((r) => setTimeout(r, 5));
    expect((await quick.poll(job)).lost).toMatch(/unreachable for over/);
  });

  it("fetches logs (tail when failed only) and cancels on the node", async () => {
    const fleet = new FakeFleet(["my-pc"]);
    const backend = new NodeBackend({ kind: "node" }, fleet.deps());
    const job = {
      id: "j1",
      repo: "you/repo",
      sha: "a".repeat(40),
      command: "x",
      timeoutMinutes: 5,
    } as ValidationJob;
    await backend.dispatch(job);
    expect((await backend.logs(job, false)).split("\n")).toHaveLength(300);
    expect((await backend.logs(job, true)).split("\n")).toHaveLength(200);
    await backend.cancel(job);
    expect(fleet.cancelled).toEqual(["j1"]);
    await expect(backend.dispatch({ ...job, repo: undefined })).rejects.toThrow(/GitHub repo/);
  });
});

describe("backends.json with fleet nodes", () => {
  const ghPool = {
    id: "pool",
    kind: "github-actions",
    repo: "you/workers",
    workflow: "ezcoder-worker.yml",
    discover: true,
  };
  const write = (dir: string, data: unknown) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "backends.json"), JSON.stringify(data));
  };
  const exec: Exec = async () => ({ code: 0, stdout: "", stderr: "" });

  it("keeps an existing GitHub pool config unchanged (no node backend added)", () => {
    const dir = path.join(tmp, "cfg");
    write(dir, { backends: [ghPool] });
    const { backends, problems } = loadBackends(dir, exec);
    expect(problems).toEqual([]);
    expect(backends.map((b) => [b.id, b.kind])).toEqual([
      ["local", "local"],
      ["pool", "github-actions"],
    ]);
  });

  it("adds a node pool for kind:node entries and for fleetNodes:true", async () => {
    const dir = path.join(tmp, "cfg");
    const fleet = new FakeFleet(["my-pc"]);
    write(dir, { backends: [ghPool], fleetNodes: true });
    let { backends } = loadBackends(dir, exec, fleet.deps());
    expect(backends.map((b) => [b.id, b.kind])).toEqual([
      ["local", "local"],
      ["pool", "github-actions"],
      ["fleet", "node"],
    ]);
    expect((await backends[2]!.machines!()).map((m) => m.name)).toEqual(["my-pc"]);

    write(dir, { backends: [ghPool, { kind: "node", id: "gpu", nodes: ["gpu-box"] }] });
    ({ backends } = loadBackends(dir, exec, fleet.deps()));
    expect(backends.map((b) => b.id)).toEqual(["local", "pool", "gpu"]);

    // An explicit "fleet" entry is not duplicated by fleetNodes.
    write(dir, { backends: [{ kind: "node" }], fleetNodes: true });
    const loaded = loadBackends(dir, exec, fleet.deps());
    expect(loaded.backends.map((b) => b.id)).toEqual(["local", "fleet"]);
    expect(loaded.problems).toEqual([]);
  });
});
