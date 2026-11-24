import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SubAgentManager, type RemoteWorkerHandle } from "../subagent-manager.js";
import { SubAgentStore } from "../subagent-store.js";
import type { AgentDefinition } from "../agents.js";
import {
  makeRepo,
  sh,
  startTestNode,
  TEST_TOKEN,
  type TestNode,
} from "./__fixtures__/test-node.js";
import { applyRemoteDelta, prepareRemoteSource, RemoteWorkerProcess } from "./remote-agent.js";
import { pickAutoNode, selectAgentNode, type FleetNodeEntry } from "./remote-agent-nodes.js";
import type { NodeInfo } from "./protocol.js";

const localWorker = fileURLToPath(
  new URL("../../tools/__fixtures__/fake-subagent-worker.mjs", import.meta.url),
);
const agents: AgentDefinition[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tmp(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ez-remote-agent-")));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface Setup {
  root: string;
  local: string;
  node: TestNode;
  nodesFile: string;
  created: RemoteWorkerProcess[];
  manager: (opts?: { store?: SubAgentStore }) => SubAgentManager;
}

async function setup(): Promise<Setup> {
  const root = tmp();
  const repo = makeRepo(root);
  const node = await startTestNode(path.join(root, "node-data"));
  cleanups.push(() => node.close());
  const nodesFile = path.join(root, "nodes.json");
  fs.writeFileSync(
    nodesFile,
    JSON.stringify({ nodes: [{ name: "my-pc", url: node.url, token: TEST_TOKEN }] }),
  );
  const created: RemoteWorkerProcess[] = [];
  const store = new SubAgentStore(path.join(root, "subagents"));
  const manager = (opts: { store?: SubAgentStore } = {}) => {
    const instance = new SubAgentManager({
      cwd: repo.local,
      agents,
      getProvider: () => "openai",
      getModel: () => "gpt-test",
      subAgentDepth: 0,
      workerEntry: localWorker,
      store: opts.store ?? store,
      sessionRootDir: path.join(root, "sessions"),
      remoteStateDir: path.join(root, "remote-state"),
      createRemoteWorker: (spawn) => {
        const worker = new RemoteWorkerProcess({ ...spawn, nodesFile, reconnectWindowMs: 5_000 });
        created.push(worker);
        return worker as unknown as RemoteWorkerHandle;
      },
    });
    cleanups.push(() => instance.shutdownAll());
    return instance;
  };
  return { root, local: repo.local, node, nodesFile, created, manager };
}

const read = (dir: string, file: string) => fs.readFileSync(path.join(dir, file), "utf-8");

describe("prepareRemoteSource", () => {
  it("captures uncommitted work incl. untracked files without touching the user's index", async () => {
    const { local } = makeRepo(tmp());
    fs.writeFileSync(path.join(local, "a.txt"), "edited\n");
    fs.writeFileSync(path.join(local, "untracked.txt"), "new\n");
    const before = sh(local, "status", "--porcelain");
    const prepared = await prepareRemoteSource(path.join(local, "sub"));
    expect(prepared.source.subdir).toBe("sub");
    const patch = prepared.patch.toString("utf-8");
    expect(patch).toContain("untracked.txt");
    expect(patch).toContain("+edited");
    expect(sh(local, "status", "--porcelain")).toBe(before);
  });

  it("refuses a HEAD that is not on origin", async () => {
    const { local } = makeRepo(tmp());
    fs.writeFileSync(path.join(local, "x.txt"), "x");
    sh(local, "add", "x.txt");
    sh(local, "commit", "-m", "local only");
    await expect(prepareRemoteSource(local)).rejects.toThrow(/not on origin yet.*git push/);
  });
});

describe("machine selection", () => {
  const entry = (name: string): FleetNodeEntry => ({ name, url: `http://${name}`, token: "t" });
  const info = (over: Partial<NodeInfo>) =>
    ({ modelAuth: true, slots: 2, slotsUsed: 0, load: 0.5, ...over }) as NodeInfo;

  it("auto picks a node with credentials and a free slot, least loaded", () => {
    const picked = pickAutoNode([
      { node: entry("busy-box"), info: info({ load: 0.1, slotsUsed: 2 }) },
      { node: entry("no-auth"), info: info({ load: 0.0, modelAuth: false }) },
      { node: entry("gpu-box"), info: info({ load: 0.9 }) },
      { node: entry("my-pc"), info: info({ load: 0.2 }) },
      { node: entry("offline") },
    ]);
    expect(picked?.node.name).toBe("my-pc");
  });

  it("explains why a named or auto machine can't run an agent", async () => {
    const file = path.join(tmp(), "nodes.json");
    fs.writeFileSync(file, JSON.stringify({ nodes: [entry("my-pc"), entry("gpu-box")] }));
    const probe = async (node: FleetNodeEntry) =>
      node.name === "my-pc" ? info({ slotsUsed: 2 }) : undefined;
    await expect(selectAgentNode("nope", { file, probe })).rejects.toThrow(/Unknown machine/);
    await expect(selectAgentNode("my-pc", { file, probe })).rejects.toThrow(/full/);
    await expect(selectAgentNode("auto", { file, probe })).rejects.toThrow(/gpu-box: unreachable/);
    await expect(selectAgentNode("auto", { file: path.join(tmp(), "none.json") })).rejects.toThrow(
      /No fleet nodes are paired/,
    );
  });
});

describe("remote sub-agents through SubAgentManager", () => {
  it("leaves the local path unchanged when machine is absent", async () => {
    const s = await setup();
    const manager = s.manager();
    const spawned = await manager.spawn("local", "quick");
    expect(spawned.machine).toBeUndefined();
    const { agents: done } = await manager.wait([spawned.agent_id], "all", 10_000);
    expect(done[0]?.state).toBe("completed");
    expect(s.created).toHaveLength(0);
  });

  it("runs on the node and brings edits back once per turn", async () => {
    const s = await setup();
    // Uncommitted local work travels to the node.
    fs.writeFileSync(path.join(s.local, "b.txt"), "local edit\n");
    const manager = s.manager();
    const spawned = await manager.spawn("remote", "write a.txt=remote;new/n.txt=hi", undefined, {
      machine: "auto",
    });
    const first = (await manager.wait([spawned.agent_id], "all", 15_000)).agents[0]!;
    expect(first.state).toBe("completed");
    expect(first.machine).toBe("my-pc");
    expect(first.remote_agent_id).toMatch(/^ez-/);
    expect(first.receipt).toMatch(/Edits from my-pc applied locally: .*a\.txt/);
    expect(read(s.local, "a.txt")).toBe("remote");
    expect(read(s.local, "new/n.txt")).toBe("hi");
    expect(read(s.local, "b.txt")).toBe("local edit\n");
    expect(manager.list()[0]?.machine).toBe("my-pc");

    await manager.followup(spawned.agent_id, "write sub/c.txt=second");
    const second = (await manager.wait([spawned.agent_id], "all", 15_000)).agents[0]!;
    expect(second.state).toBe("completed");
    expect(second.receipt).toMatch(/applied locally: sub\/c\.txt$/m);
    expect(read(s.local, "sub/c.txt")).toBe("second");
    expect(read(s.local, "a.txt")).toBe("remote");

    await manager.shutdownAll();
    // Closing removes the remote agent and its slot (once the worker's exit arrives).
    const deadline = Date.now() + 10_000;
    while ((s.node.module.agents?.().length ?? 0) > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(s.node.module.agents?.()).toEqual([]);
    expect(s.node.slotsUsed()).toBe(0);
  });

  it("keeps a conflicting patch and leaves the local tree untouched", async () => {
    const s = await setup();
    const manager = s.manager();
    const spawned = await manager.spawn("remote", "hold write a.txt=remote;z.txt=z", undefined, {
      machine: "my-pc",
    });
    // The user edits the same file meanwhile.
    fs.writeFileSync(path.join(s.local, "a.txt"), "mine\n");
    await manager.sendMessage(spawned.agent_id, "go");
    const done = (await manager.wait([spawned.agent_id], "all", 15_000)).agents[0]!;
    expect(done.state).toBe("completed");
    expect(done.receipt).toMatch(/CONFLICT/);
    const kept = /kept at (\S+\.patch)/.exec(done.receipt ?? "")?.[1];
    expect(kept && fs.existsSync(kept)).toBe(true);
    expect(done.receipt).toContain(`apply --3way --binary "${kept}"`);
    // Atomic: neither the conflicting file nor the clean one was touched.
    expect(read(s.local, "a.txt")).toBe("mine\n");
    expect(fs.existsSync(path.join(s.local, "z.txt"))).toBe(false);
    expect(sh(s.local, "diff")).not.toContain("<<<<<<<");
  });

  it("recovery re-attaches to the same remote agent instead of respawning locally", async () => {
    const s = await setup();
    const first = s.manager();
    await first.hydrate("parent-1");
    const spawned = await first.spawn("remote", "write a.txt=one", undefined, { machine: "my-pc" });
    await first.wait([spawned.agent_id], "all", 15_000);
    await first.waitForPersistence();
    const remoteId = first.list()[0]?.remote_agent_id;
    // Parent dies: the connection drops, the node keeps the agent.
    s.created[0]!.detach();

    const second = s.manager();
    await second.hydrate("parent-1");
    expect(second.list()[0]).toMatchObject({ machine: "my-pc", remote_agent_id: remoteId });
    await second.followup(spawned.agent_id, "write a.txt=two");
    const done = (await second.wait([spawned.agent_id], "all", 15_000)).agents[0]!;
    expect(done.state).toBe("completed");
    expect(done.output).toBe("done 2: write a.txt=two");
    expect(s.created).toHaveLength(2);
    expect(s.node.module.agents?.().map((a) => a.id)).toEqual([remoteId]);
    expect(read(s.local, "a.txt")).toBe("two");
  });
});

describe.skipIf(process.platform === "win32")("applyRemoteDelta security", () => {
  it("refuses patches that add symlinks pointing outside the folder or into .git", async () => {
    const root = tmp();
    const { local, sha } = makeRepo(root);
    const patchOf = (make: () => void): Buffer => {
      make();
      sh(local, "add", "-A", "-N");
      const out = execFileSync("git", ["diff", "--binary", sha], { cwd: local });
      sh(local, "reset", "-q");
      return out;
    };
    for (const target of ["../outside", "/etc", ".git/config"]) {
      const link = path.join(local, "evil");
      const next = patchOf(() => fs.symlinkSync(target, link));
      fs.unlinkSync(link);
      const r = await applyRemoteDelta({
        repoRoot: local,
        base: sha,
        previous: Buffer.alloc(0),
        next,
        keepDir: path.join(root, "keep"),
        node: "my-pc",
      });
      expect(r.applied, target).toBe(false);
      expect(r.note).toMatch(/REFUSED/);
      expect(fs.existsSync(link) || fs.lstatSync(link, { throwIfNoEntry: false })).toBeFalsy();
    }
    const ok = path.join(local, "ok");
    const next = patchOf(() => fs.symlinkSync("sub/c.txt", ok));
    fs.unlinkSync(ok);
    const r = await applyRemoteDelta({
      repoRoot: local,
      base: sha,
      previous: Buffer.alloc(0),
      next,
      keepDir: path.join(root, "keep"),
      node: "my-pc",
    });
    expect(r.applied).toBe(true);
    expect(fs.readlinkSync(ok)).toBe("sub/c.txt");
  });
});
