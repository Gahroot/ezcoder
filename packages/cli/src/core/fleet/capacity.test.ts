// Full capacity: every free slot on every node is used, fleet jobs and
// validation stages share each node's slots, and busy work waits, never fails.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadBackends } from "../validation/backends.js";
import { NodeBackend, type NodeBackendDeps } from "../validation/node-backend.js";
import { ValidationService } from "../validation/service.js";
import type { Exec, ValidationJob } from "../validation/types.js";
import { FleetClientError } from "./client.js";
import { NodeRegistry } from "./registry.js";
import { FleetService } from "./service.js";
import { nodeInfo, startFakeNode, type FakeNode } from "./__fixtures__/fake-node.js";
import type { JobRequest, JobStatus, NodeInfo } from "./protocol.js";

const TOKEN = "z".repeat(32);
let tmp: string;
let repo: string;
let fleetDir: string;
let validationDir: string;
let nodes: FakeNode[];

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ezf-cap-"));
  fleetDir = path.join(tmp, "fleet");
  validationDir = path.join(tmp, "validation");
  const bare = path.join(tmp, "origin.git");
  git(tmp, "init", "-q", "--bare", "-b", "main", bare);
  repo = path.join(tmp, "proj");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  git(repo, "remote", "add", "origin", bare);
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
  fs.mkdirSync(path.join(repo, ".ezcoder"));
  fs.writeFileSync(
    path.join(repo, ".ezcoder", "fleet.json"),
    JSON.stringify({ jobs: { build: { kind: "build", command: "npm run build" } } }),
  );
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "one");
  git(repo, "push", "-q", "origin", "main");
  nodes = [];
});

afterEach(async () => {
  await Promise.all(nodes.map((n) => n.close()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function addNode(name: string, over: Partial<NodeInfo> = {}): Promise<FakeNode> {
  const n = await startFakeNode(name, over, TOKEN);
  nodes.push(n);
  await new NodeRegistry(fleetDir).add({ name, url: n.url, token: TOKEN, labels: [] });
  return n;
}

function fleet(): FleetService {
  return new FleetService({
    dir: fleetDir,
    validationDir,
    autoStart: false,
    pollMs: 60_000,
    clientTimeoutMs: 2000,
    cloud: false,
    localEndpoints: false,
  });
}

async function queue(svc: FleetService, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push((await svc.run(repo, "build")).job.id);
  return ids;
}

describe("fleet jobs use every free slot", () => {
  it("starts 6 jobs at once on one 6-slot node", async () => {
    const node = await addNode("big", { slots: 6 });
    const svc = fleet();
    await queue(svc, 6);
    await svc.tick();
    expect(node.requests).toHaveLength(6);
    expect((await svc.list()).every((j) => j.state === "running")).toBe(true);
  });

  it("spreads 6 jobs over 6 one-slot nodes", async () => {
    const six = await Promise.all(
      ["n1", "n2", "n3", "n4", "n5", "n6"].map((n) => addNode(n, { slots: 1 })),
    );
    const svc = fleet();
    await queue(svc, 6);
    await svc.tick();
    expect(six.map((n) => n.requests.length)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it("queues a 7th job and starts it as soon as a slot frees", async () => {
    const node = await addNode("big", { slots: 6 });
    const svc = fleet();
    const ids = await queue(svc, 7);
    await svc.tick();
    expect(node.requests).toHaveLength(6);
    const seventh = (await svc.get(ids[6]!))!;
    expect(seventh.state).toBe("queued");
    expect(seventh.summary).toMatch(/waiting: .*busy/);
    Object.assign(node.jobs.get(ids[0]!)!, { state: "passed", exitCode: 0 });
    await svc.tick();
    expect(node.requests).toHaveLength(7);
    expect((await svc.get(ids[6]!))!.state).toBe("running");
  });

  it("keeps work queued when the node answers 429 busy", async () => {
    const node = await addNode("pc", { slots: 4 });
    node.full = true;
    const svc = fleet();
    const [id] = await queue(svc, 1);
    await svc.tick();
    expect((await svc.get(id!))!.state).toBe("queued");
    node.full = false;
    await svc.tick();
    expect((await svc.get(id!))!.state).toBe("running");
  });

  it("counts validation stages on the node, so the two never over-book it", async () => {
    const node = await addNode("pc", { slots: 2 });
    fs.mkdirSync(validationDir, { recursive: true });
    fs.writeFileSync(
      path.join(validationDir, "jobs.json"),
      JSON.stringify({
        version: 1,
        jobs: [{ id: "v1", backend: "fleet", machine: "pc", state: "running" }],
      }),
    );
    const svc = fleet();
    const ids = await queue(svc, 2);
    await svc.tick();
    expect(node.requests).toHaveLength(1);
    expect((await svc.get(ids[1]!))!.state).toBe("queued");
  });

  it("reports local capacity from backends.json", () => {
    expect(fleet().localCapacity()).toBe(2);
    fs.mkdirSync(validationDir, { recursive: true });
    fs.writeFileSync(
      path.join(validationDir, "backends.json"),
      JSON.stringify({ localMaxConcurrent: 6 }),
    );
    expect(fleet().localCapacity()).toBe(6);
  });
});

/** In-memory fleet nodes for the validation NodeBackend. */
class Nodes {
  submitted: JobRequest[] = [];
  jobs = new Map<string, JobStatus>();
  fleetJobs = new Map<string, number>();
  busy = false;
  constructor(readonly infos: Record<string, NodeInfo>) {}
  deps(): NodeBackendDeps {
    return {
      listNodes: async () => Object.keys(this.infos).map((name) => ({ name })),
      info: async (name) => this.infos[name]!,
      fleetInFlight: async () => new Map(this.fleetJobs),
      client: async () => ({
        submitJob: async (req) => {
          if (this.busy) throw new FleetClientError("full", "busy", 429);
          this.submitted.push(req);
          const st: JobStatus = {
            id: req.id,
            kind: req.kind,
            project: req.project,
            state: "running",
            logBytes: 0,
          };
          this.jobs.set(req.id, st);
          return st;
        },
        job: async (id) => this.jobs.get(id)!,
        jobLog: async () => ({ text: "", size: 0 }),
        cancelJob: async (id) => this.jobs.get(id)!,
      }),
    };
  }
}

const okExec: Exec = async () => ({ code: 0, stdout: "", stderr: "" });

function vjob(i: number): ValidationJob {
  const at = new Date(Date.now() + i).toISOString();
  return {
    id: `v${i}`,
    project: "/p",
    repo: "acme/proj",
    sha: "a".repeat(40),
    stage: `shard-${i}`,
    run: "remote",
    required: true,
    command: "npm test",
    timeoutMinutes: 10,
    backend: "",
    state: "queued",
    createdAt: at,
    updatedAt: at,
  };
}

async function validation(n: Nodes, count: number): Promise<ValidationService> {
  const svc = new ValidationService({
    dir: validationDir,
    exec: okExec,
    autoStart: false,
    backends: [new NodeBackend({ kind: "node" }, n.deps())],
  });
  await svc.store.update((jobs) => {
    for (let i = 0; i < count; i++) jobs.push(vjob(i));
  });
  return svc;
}

describe("validation stages use every free slot", () => {
  it("runs 6 stages at once on one 6-slot node (no hidden cap of 4)", async () => {
    const n = new Nodes({ big: nodeInfo("big", { slots: 6 }) });
    const svc = await validation(n, 6);
    await svc.tick();
    expect(n.submitted).toHaveLength(6);
  });

  it("spreads 6 stages over 6 one-slot nodes, and a 7th waits", async () => {
    const infos: Record<string, NodeInfo> = {};
    for (const name of ["n1", "n2", "n3", "n4", "n5", "n6"])
      infos[name] = nodeInfo(name, { slots: 1 });
    const n = new Nodes(infos);
    const svc = await validation(n, 7);
    await svc.tick();
    const jobs = await svc.store.read();
    const placed = jobs.filter((j) => j.state === "waiting").map((j) => j.machine);
    expect(placed.sort()).toEqual(["n1", "n2", "n3", "n4", "n5", "n6"]);
    expect(jobs.find((j) => j.id === "v6")!.state).toBe("queued");
  });

  it("leaves room for fleet jobs already on the node", async () => {
    const n = new Nodes({ pc: nodeInfo("pc", { slots: 2 }) });
    n.fleetJobs.set("pc", 1);
    const svc = await validation(n, 2);
    await svc.tick();
    expect(n.submitted).toHaveLength(1);
  });

  it("keeps a stage queued when the node answers 429 busy", async () => {
    const n = new Nodes({ pc: nodeInfo("pc", { slots: 2 }) });
    n.busy = true;
    const svc = await validation(n, 1);
    await svc.tick();
    const [j] = await svc.store.read();
    expect(j!.state).toBe("queued");
    expect(j!.summary).toMatch(/full/);
    n.busy = false;
    await svc.tick();
    expect((await svc.store.read())[0]!.state).toBe("waiting");
  });
});

describe("validation backends", () => {
  it("joins paired fleet nodes by default; false turns it off; no hidden cap", async () => {
    await new NodeRegistry(fleetDir).add({
      name: "pc",
      url: "http://x:1",
      token: TOKEN,
      labels: [],
    });
    const write = (data: object) => {
      fs.mkdirSync(validationDir, { recursive: true });
      fs.writeFileSync(
        path.join(validationDir, "backends.json"),
        JSON.stringify({ cloud: false, ...data }),
      );
    };
    write({});
    let loaded = loadBackends(validationDir, okExec);
    expect(loaded.backends.map((b) => b.id)).toEqual(["local", "fleet"]);
    expect(loaded.maxConcurrent).toBeUndefined();
    write({ fleetNodes: false, maxConcurrent: 3 });
    loaded = loadBackends(validationDir, okExec);
    expect(loaded.backends.map((b) => b.id)).toEqual(["local"]);
    expect(loaded.maxConcurrent).toBe(3);
  });
});
