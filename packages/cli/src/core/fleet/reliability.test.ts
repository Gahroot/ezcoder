// R1 (deploy dispatched at most once), R4 (custom retry opt-in), R10 (cleanup),
// S3 (protocol check on poll and dispatch) and 429 Retry-After, against the fake node.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseRetryAfter } from "./client.js";
import { loadFleetConfig } from "./project-config.js";
import { NodeRegistry } from "./registry.js";
import { FleetService } from "./service.js";
import { startFakeNode, type FakeNode } from "./__fixtures__/fake-node.js";
import type { NodeInfo } from "./protocol.js";

const TOKEN = "z".repeat(32);
let tmp: string;
let repo: string;
let fleetDir: string;
let nodes: FakeNode[];

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ezf-rel-"));
  fleetDir = path.join(tmp, "fleet");
  const bare = path.join(tmp, "origin.git");
  git(tmp, "init", "-q", "--bare", "-b", "main", bare);
  repo = path.join(tmp, "proj");
  fs.mkdirSync(path.join(repo, ".ezcoder"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  git(repo, "remote", "add", "origin", bare);
  fs.writeFileSync(
    path.join(repo, ".ezcoder", "fleet.json"),
    JSON.stringify({
      jobs: {
        build: { kind: "build", command: "make" },
        deploy: {
          kind: "deploy",
          command: "./deploy.sh",
          gate: false,
          resources: { labels: ["deploy"] },
        },
        migrate: { kind: "custom", command: "./migrate.sh" },
        shards: { kind: "custom", command: "./shard.sh", retry: true },
      },
    }),
  );
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "one");
  git(repo, "push", "-q", "origin", "main");
  nodes = [];
});

afterEach(async () => {
  await Promise.all(nodes.map((n) => n.close().catch(() => {})));
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function addNode(name: string, over: Partial<NodeInfo> = {}): Promise<FakeNode> {
  const n = await startFakeNode(name, over, TOKEN);
  nodes.push(n);
  await new NodeRegistry(fleetDir).add({ name, url: n.url, token: TOKEN, labels: [] });
  return n;
}

function service(over: Partial<ConstructorParameters<typeof FleetService>[0]> = {}): FleetService {
  return new FleetService({
    dir: fleetDir,
    validationDir: path.join(tmp, "validation"),
    autoStart: false,
    pollMs: 60_000,
    clientTimeoutMs: 1500,
    unreachableRequeueMinutes: 0,
    cloud: false,
    localEndpoints: false,
    ...over,
  });
}

const dispatches = () => nodes.reduce((n, x) => n + x.requests.length, 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("R1: a deploy is dispatched at most once", () => {
  it("dispatch timeout: asks the same node, never sends it again", async () => {
    const a = await addNode("a", { labels: ["deploy"] });
    const b = await addNode("b", { labels: ["deploy"] });
    a.dropSubmit = b.dropSubmit = true;
    const svc = service();
    const { job } = await svc.run(repo, "deploy");
    await svc.tick();
    expect(dispatches()).toBe(1);
    a.dropSubmit = b.dropSubmit = false;
    for (let i = 0; i < 3; i++) await svc.tick();
    expect(dispatches()).toBe(1);
    expect((await svc.get(job.id))!.state).toBe("running");
  });

  it("dispatch timeout and the claimed node gone: never moves to another node", async () => {
    const a = await addNode("a", { labels: ["deploy"] });
    const b = await addNode("b", { labels: ["deploy"] });
    a.dropSubmit = b.dropSubmit = true;
    const svc = service();
    const { job } = await svc.run(repo, "deploy");
    await svc.tick();
    const claimed = (await svc.get(job.id))!.node!;
    await (claimed === "a" ? a : b).close();
    (claimed === "a" ? b : a).dropSubmit = false;
    for (let i = 0; i < 3; i++) await svc.tick();
    expect(dispatches()).toBe(1);
    expect((await svc.get(job.id))!.node).toBe(claimed);
  });

  it("controller restart mid-deploy: the new controller re-adopts, never re-sends", async () => {
    await addNode("a", { labels: ["deploy"] });
    await addNode("b", { labels: ["deploy"] });
    const first = service();
    const { job } = await first.run(repo, "deploy");
    await first.tick();
    expect(dispatches()).toBe(1);
    first.stop();
    const second = service();
    for (let i = 0; i < 3; i++) await second.tick();
    expect(dispatches()).toBe(1);
    expect((await second.get(job.id))!.state).toBe("running");
  });

  it("controller restart while the dispatch was unanswered: still one dispatch", async () => {
    const a = await addNode("a", { labels: ["deploy"] });
    const b = await addNode("b", { labels: ["deploy"] });
    a.dropSubmit = b.dropSubmit = true;
    const first = service();
    await first.run(repo, "deploy");
    await first.tick();
    a.dropSubmit = b.dropSubmit = false;
    const second = service();
    for (let i = 0; i < 3; i++) await second.tick();
    expect(dispatches()).toBe(1);
  });

  it("node lost mid-deploy (restart or gone): error, no second dispatch", async () => {
    const a = await addNode("a", { labels: ["deploy"] });
    const b = await addNode("b", { labels: ["deploy"] });
    const svc = service();
    const { job } = await svc.run(repo, "deploy");
    await svc.tick();
    const on = (await svc.get(job.id))!.node === "a" ? a : b;
    on.jobs.get(job.id)!.state = "lost";
    for (let i = 0; i < 3; i++) await svc.tick();
    expect((await svc.get(job.id))!.state).toBe("error");
    expect(dispatches()).toBe(1);

    const { job: second } = await svc.run(repo, "deploy");
    await svc.tick();
    const on2 = (await svc.get(second.id))!.node === "a" ? a : b;
    await on2.close();
    await svc.tick();
    await sleep(10);
    for (let i = 0; i < 3; i++) await svc.tick();
    const j = (await svc.get(second.id))!;
    expect(j.state).toBe("error");
    expect(j.summary).toMatch(/not retried automatically/);
    expect(dispatches()).toBe(2); // one per deploy, never more
  });
});

describe("R4: custom jobs retry only when marked", () => {
  it("does not requeue a custom job by default", async () => {
    const a = await addNode("a");
    await addNode("b", { load: 5 });
    const svc = service();
    const { job } = await svc.run(repo, "migrate");
    await svc.tick();
    a.jobs.get(job.id)!.state = "lost";
    await svc.tick();
    const j = (await svc.get(job.id))!;
    expect(j.state).toBe("error");
    expect(j.summary).toMatch(/"retry": true/);
    expect(dispatches()).toBe(1);
  });

  it('requeues a custom job with "retry": true on another node', async () => {
    const a = await addNode("a");
    const b = await addNode("b", { load: 5 });
    const svc = service();
    const { job } = await svc.run(repo, "shards");
    expect(job.retry).toBe(true);
    await svc.tick();
    a.jobs.get(job.id)!.state = "lost";
    await svc.tick();
    const j = (await svc.get(job.id))!;
    expect(j.attempts).toBe(2);
    expect(b.requests).toHaveLength(1);
  });

  it("refuses retry on a deploy and non-boolean values", () => {
    const bad = (job: object) => {
      fs.writeFileSync(
        path.join(repo, ".ezcoder", "fleet.json"),
        JSON.stringify({ jobs: { x: job } }),
      );
      return loadFleetConfig(repo);
    };
    expect(bad({ kind: "deploy", command: "d", retry: true })).toMatchObject({
      error: expect.stringMatching(/never retried/),
    });
    expect(bad({ kind: "custom", command: "d", retry: "yes" })).toMatchObject({
      error: expect.stringMatching(/true or false/),
    });
  });
});

describe("S3: protocol check on poll and dispatch", () => {
  it("never dispatches to a node with an older protocol and says which side to update", async () => {
    const old = await addNode("old", { protocol: 1, minProtocol: 1 });
    const svc = service();
    const { job } = await svc.run(repo, "build");
    await svc.tick();
    expect(old.requests).toHaveLength(0);
    const j = (await svc.get(job.id))!;
    expect(j.state).toBe("queued");
    expect(j.summary).toContain("update the node: on old run `npm i -g @prestyj/cli@latest`");
    const [n] = await svc.nodes();
    expect(n!.incompatible).toMatch(/update the node/);
  });

  it("treats a 426 answer as incompatible and keeps the work queued", async () => {
    const n = await addNode("pc");
    n.mismatch = "controller";
    const svc = service();
    const { job } = await svc.run(repo, "build");
    await svc.tick();
    expect(n.requests).toHaveLength(0);
    expect((await svc.get(job.id))!.summary).toContain("update EZ Coder on this machine");
    n.mismatch = false;
    await svc.tick();
    expect(n.requests).toHaveLength(1);
  });

  it("sends the protocol and version headers on every call", async () => {
    const n = await addNode("pc");
    const svc = service();
    await svc.run(repo, "build");
    await svc.tick();
    expect(n.headers.length).toBeGreaterThan(0);
    expect(n.headers.every((h) => h["x-ezcoder-protocol"] === "2" && h["x-ezcoder-version"])).toBe(
      true,
    );
  });
});

describe("429 busy with Retry-After", () => {
  it("parses seconds and dates", () => {
    expect(parseRetryAfter("30")).toBe(30_000);
    expect(parseRetryAfter(new Date(1_000_000 + 5000).toUTCString(), 1_000_000)).toBe(5000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("99999")).toBe(600_000);
  });

  it("waits as long as the node asked, then dispatches", async () => {
    const n = await addNode("pc");
    n.full = true;
    n.retryAfter = 1;
    const svc = service();
    const { job } = await svc.run(repo, "build");
    await svc.tick();
    let j = (await svc.get(job.id))!;
    expect(j.state).toBe("queued");
    expect(j.summary).toMatch(/full; retrying in 1 s/);
    n.full = false;
    await svc.tick();
    expect(n.requests).toHaveLength(0); // still inside Retry-After
    await sleep(1100);
    await svc.tick();
    j = (await svc.get(job.id))!;
    expect(j.state).toBe("running");
  });
});

describe("R10: controller leftovers", () => {
  it("removes patches of finished and forgotten jobs, keeps live ones", async () => {
    await addNode("pc");
    const svc = service();
    const { job: live } = await svc.run(repo, "build");
    const { job: gone } = await svc.run(repo, "build");
    await svc.cancel(gone.id);
    const dir = path.join(fleetDir, "patches");
    fs.mkdirSync(dir, { recursive: true });
    for (const id of [live.id, gone.id, "orphan"])
      fs.writeFileSync(path.join(dir, `${id}.b64`), "x");
    const r = await svc.cleanup();
    expect(r.patches.sort()).toEqual([gone.id, "orphan"].sort());
    expect(fs.readdirSync(dir)).toEqual([`${live.id}.b64`]);
  });

  it("stops services stuck in error, on startup and periodically", async () => {
    const n = await addNode("pc");
    n.services.set("s1", { id: "s1", kind: "custom", state: "error", endpoints: [] });
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    const svc = service({ stuckServiceMinutes: 30, cleanupEveryMinutes: 10 });
    await svc.services.update((list) => {
      list.push({
        id: "s1",
        name: "dev",
        kind: "custom",
        node: "pc",
        state: "error",
        endpoints: [],
        summary: "container exited",
        createdAt: old,
        updatedAt: old,
      });
      list.push({
        id: "s2",
        name: "dev2",
        kind: "custom",
        node: "pc",
        state: "error",
        endpoints: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });
    await svc.tick(); // first tick = startup cleanup
    const list = await svc.services.read();
    expect(list.find((s) => s.id === "s1")!.state).toBe("stopped");
    expect(list.find((s) => s.id === "s2")!.state).toBe("error"); // not stuck long enough
    expect(n.services.has("s1")).toBe(false); // stopped on the node too
  });
});
