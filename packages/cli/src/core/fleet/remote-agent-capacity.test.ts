// Capacity of remote agents: node slots (not the local limit) bound them,
// "auto" spreads by free slots, and a full fleet queues instead of failing.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_LIMIT, SubAgentManager, type RemoteWorkerHandle } from "../subagent-manager.js";
import { SubAgentStore } from "../subagent-store.js";
import {
  makeRepo,
  sh,
  startTestNode,
  TEST_TOKEN,
  type TestNode,
} from "./__fixtures__/test-node.js";
import {
  conflictingFiles,
  notBroughtBackNote,
  RemoteWorkerProcess,
  retryAfterMs,
} from "./remote-agent.js";
import { acquireAgentNode, type FleetNodeEntry } from "./remote-agent-nodes.js";
import type { NodeInfo } from "./protocol.js";

const localWorker = fileURLToPath(
  new URL("../../tools/__fixtures__/fake-subagent-worker.mjs", import.meta.url),
);
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tmp(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ez-remote-cap-")));
  cleanups.push(() =>
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
  return dir;
}

interface Fleet {
  root: string;
  local: string;
  nodes: TestNode[];
  nodesFile: string;
  manager: () => SubAgentManager;
}

interface FleetOptions {
  /** Retry-After (seconds) the nodes send with a 429. */
  retryAfterSeconds?: number;
  onBusy?: () => void;
  onQueued?: (reason: string) => void;
}

async function fleet(slotsPerNode: number[], opts: FleetOptions = {}): Promise<Fleet> {
  const root = tmp();
  const { local } = makeRepo(root);
  const nodes: TestNode[] = [];
  for (const [index, slots] of slotsPerNode.entries()) {
    const node = await startTestNode(path.join(root, `node-${index}`), {
      slots,
      ...(opts.retryAfterSeconds !== undefined && { retryAfterSeconds: opts.retryAfterSeconds }),
      ...(opts.onBusy && { onBusy: opts.onBusy }),
    });
    cleanups.push(() => node.close());
    nodes.push(node);
  }
  const nodesFile = path.join(root, "nodes.json");
  fs.writeFileSync(
    nodesFile,
    JSON.stringify({
      nodes: nodes.map((node, index) => ({
        name: `pc-${index}`,
        url: node.url,
        token: TEST_TOKEN,
      })),
    }),
  );
  let count = 0;
  const manager = () => {
    count++;
    const instance = new SubAgentManager({
      cwd: local,
      agents: [],
      getProvider: () => "openai",
      getModel: () => "gpt-test",
      subAgentDepth: 0,
      workerEntry: localWorker,
      store: new SubAgentStore(path.join(root, `subagents-${count}`)),
      sessionRootDir: path.join(root, `sessions-${count}`),
      remoteStateDir: path.join(root, `remote-${count}`),
      createRemoteWorker: (spawn) =>
        new RemoteWorkerProcess({
          ...spawn,
          nodesFile,
          reconnectWindowMs: 5_000,
          queuePollMs: 50,
          // The node asks for seconds; tests honour it but only briefly.
          maxRetryAfterMs: 50,
          ...(opts.onQueued && { onQueued: opts.onQueued }),
        }) as unknown as RemoteWorkerHandle,
    });
    cleanups.push(() => instance.shutdownAll());
    return instance;
  };
  return { root, local, nodes, nodesFile, manager };
}

describe("acquireAgentNode", () => {
  const entry = (name: string): FleetNodeEntry => ({ name, url: `http://${name}`, token: "t" });
  const info = (slots: number, slotsUsed = 0): NodeInfo =>
    ({ modelAuth: true, slots, slotsUsed, load: 0.1 }) as NodeInfo;

  it("spreads starts by free slots, counting its own pending starts, then queues", async () => {
    const file = path.join(tmp(), "nodes.json");
    fs.writeFileSync(file, JSON.stringify({ nodes: [entry("big"), entry("small")] }));
    const probe = async (node: FleetNodeEntry) => (node.name === "big" ? info(3) : info(1));
    const picks = [];
    for (let i = 0; i < 4; i++) picks.push(await acquireAgentNode("auto", { file, probe }));
    const names = picks.map((p) => p.node.name).sort();
    expect(names).toEqual(["big", "big", "big", "small"]);
    // All four slots are reserved: a fifth waits, and gives up only at its deadline.
    const queued: string[] = [];
    await expect(
      acquireAgentNode("auto", {
        file,
        probe,
        pollMs: 10,
        queueTimeoutMs: 50,
        onQueued: (reason) => queued.push(reason),
      }),
    ).rejects.toThrow(/Gave up after waiting for a free slot/);
    expect(queued[0]).toMatch(/big: full \(0\/3 slots, 3 starting\)/);
    // A release frees the slot for the next start.
    picks.find((p) => p.node.name === "small")!.release();
    const next = await acquireAgentNode("auto", { file, probe, pollMs: 10 });
    expect(next.node.name).toBe("small");
    next.release();
    for (const p of picks) p.release();
  });

  it("fails at once when no node could ever take the agent", async () => {
    const file = path.join(tmp(), "nodes.json");
    fs.writeFileSync(file, JSON.stringify({ nodes: [entry("no-auth")] }));
    const probe = async () => ({ ...info(2), modelAuth: false });
    await expect(acquireAgentNode("auto", { file, probe, pollMs: 10 })).rejects.toThrow(
      /no model credentials/,
    );
  });

  it("reads Retry-After as seconds or a date, capped at a minute", () => {
    expect(retryAfterMs("3")).toBe(3_000);
    expect(retryAfterMs("600")).toBe(60_000);
    expect(retryAfterMs(null)).toBeUndefined();
    expect(retryAfterMs("soon")).toBeUndefined();
  });
});

describe("remote agents use node capacity", () => {
  it("runs 6 agents at once on one 6-slot node", async () => {
    const f = await fleet([6]);
    const manager = f.manager();
    const spawned = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((n) =>
        manager.spawn(`r-${n}`, `hold write f${n}.txt=${n}`, undefined, { machine: "auto" }),
      ),
    );
    expect(spawned.every((agent) => agent.state === "running")).toBe(true);
    expect(f.nodes[0]!.slotsUsed()).toBe(6);
    for (const agent of spawned) await manager.sendMessage(agent.agent_id, "go");
    const done = await manager.wait(
      spawned.map((agent) => agent.agent_id),
      "all",
      30_000,
    );
    expect(done.agents.every((agent) => agent.state === "completed")).toBe(true);
    expect(done.agents.every((agent) => agent.machine === "pc-0")).toBe(true);
    for (const n of [1, 2, 3, 4, 5, 6]) {
      expect(fs.readFileSync(path.join(f.local, `f${n}.txt`), "utf-8")).toBe(String(n));
    }
  }, 90_000);

  it("spreads 6 auto agents over 6 one-slot nodes", async () => {
    const f = await fleet([1, 1, 1, 1, 1, 1]);
    const manager = f.manager();
    const spawned = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((n) =>
        manager.spawn(`r-${n}`, "hold", undefined, { machine: "auto" }),
      ),
    );
    expect(spawned.every((agent) => agent.state === "running")).toBe(true);
    expect(f.nodes.map((node) => node.slotsUsed())).toEqual([1, 1, 1, 1, 1, 1]);
    const machines = manager.list().map((agent) => agent.machine);
    expect(new Set(machines).size).toBe(6);
  }, 90_000);

  it("a 7th agent waits through the node's 429 and starts when a slot frees", async () => {
    // Event-driven: the test moves on when the node refuses and the start queues.
    let busy = 0;
    let markQueued!: () => void;
    const queued = new Promise<void>((resolve) => (markQueued = resolve));
    const f = await fleet([6], {
      retryAfterSeconds: 30,
      onBusy: () => busy++,
      onQueued: () => markQueued(),
    });
    // The node advertises more slots than it has, so the start is refused with 429.
    f.nodes[0]!.info.slots = 99;
    const first = f.manager();
    await Promise.all(
      [1, 2, 3, 4, 5, 6].map((n) => first.spawn(`r-${n}`, "hold", undefined, { machine: "pc-0" })),
    );
    expect(f.nodes[0]!.slotsUsed()).toBe(6);
    const second = f.manager();
    let started = false;
    const seventh = second
      .spawn("seventh", "write s.txt=7", undefined, { machine: "pc-0" })
      .then((agent) => {
        started = true;
        return agent;
      });
    await queued;
    expect(busy).toBeGreaterThanOrEqual(1);
    expect(started).toBe(false);
    expect(f.nodes[0]!.slotsUsed()).toBe(6);
    await first.shutdownAll();
    const agent = await seventh;
    const done = (await second.wait([agent.agent_id], "all", 30_000)).agents[0]!;
    expect(done.state).toBe("completed");
    expect(fs.readFileSync(path.join(f.local, "s.txt"), "utf-8")).toBe("7");
  }, 90_000);

  it("does not count remote agents against the local limit", async () => {
    const f = await fleet([2]);
    const manager = f.manager();
    const local = await Promise.all(
      Array.from({ length: ACTIVE_LIMIT }, (_, i) => manager.spawn(`l-${i}`, "hold")),
    );
    expect(local.every((agent) => agent.state === "running")).toBe(true);
    await expect(manager.spawn("l-extra", "hold")).rejects.toThrow(
      `At most ${ACTIVE_LIMIT} agents may run at once on this machine`,
    );
    const remote = await manager.spawn("remote", "hold", undefined, { machine: "pc-0" });
    expect(remote.state).toBe("running");
    expect(f.nodes[0]!.slotsUsed()).toBe(1);
  }, 90_000);
});

describe("R9: git-ignored changes", () => {
  it("lists ignored files the agent changed as not brought back, once", async () => {
    const f = await fleet([1]);
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const res = await realFetch(input, init);
      if (!String(input).endsWith("/diff")) return res;
      const body = (await res.json()) as Record<string, unknown>;
      return new Response(JSON.stringify({ ...body, ignoredChanged: ["dist/out.js", ".env"] }), {
        status: res.status,
        headers: { "content-type": "application/json" },
      });
    });
    const manager = f.manager();
    const agent = await manager.spawn("r", "write a.txt=x", undefined, { machine: "pc-0" });
    const done = (await manager.wait([agent.agent_id], "all", 30_000)).agents[0]!;
    expect(done.receipt).toContain(
      "Not brought back (git ignores them, so they stay on pc-0): dist/out.js, .env",
    );
    await manager.followup(agent.agent_id, "write b.txt=y");
    const second = (await manager.wait([agent.agent_id], "all", 30_000)).agents[0]!;
    expect(second.receipt).not.toContain("Not brought back");
  }, 60_000);

  it("shortens long lists", () => {
    const files = Array.from({ length: 23 }, (_, i) => `f${i}`);
    expect(notBroughtBackNote("pc", files)).toMatch(/f19 and 3 more$/);
  });
});

describe("conflictingFiles", () => {
  it("names only the files whose hunks don't apply", async () => {
    const root = tmp();
    const { local, sha } = makeRepo(root);
    fs.writeFileSync(path.join(local, "a.txt"), "remote\n");
    fs.writeFileSync(path.join(local, "b.txt"), "remote b\n");
    const patch = execFileSync("git", ["diff", "--binary", sha], { cwd: local });
    sh(local, "checkout", "--", ".");
    fs.writeFileSync(path.join(local, "a.txt"), "mine\n");
    const file = path.join(root, "p.patch");
    fs.writeFileSync(file, patch);
    expect(await conflictingFiles(local, file, ["a.txt", "b.txt"])).toEqual(["a.txt"]);
  });
});
