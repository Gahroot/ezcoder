import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SubAgentManager, type RemoteWorkerHandle } from "../subagent-manager.js";
import { SubAgentStore } from "../subagent-store.js";
import type { NodeInfo } from "../fleet/protocol.js";
import { chooseAutoTarget, cloudAgentModel, CloudWorkerProcess } from "./cloud-agent.js";
import {
  CLOUD_PROVIDER_IDS,
  CloudError,
  type CloudAvailability,
  type CloudCommandRecord,
  type CloudProvider,
  type CloudProviderId,
  type CloudTaskHandle,
  type CloudTaskRequest,
  type CloudTaskStatus,
} from "./types.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

function makeRepo(): { root: string; local: string; head: string } {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ez-cloud-agent-")));
  // Retries: a worker may still be removing its sync state as the test ends.
  cleanups.push(() =>
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  );
  const local = path.join(root, "local");
  fs.mkdirSync(local);
  sh(local, "init", "-q", "-b", "main");
  sh(local, "config", "user.email", "t@example.com");
  sh(local, "config", "user.name", "Test");
  sh(local, "config", "commit.gpgsign", "false");
  sh(local, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(local, "a.txt"), "a\n");
  sh(local, "add", "-A");
  sh(local, "commit", "-q", "-m", "init");
  return { root, local, head: sh(local, "rev-parse", "HEAD").trim() };
}

/**
 * A cloud that finishes each message after one "running" poll, recording a
 * command per turn. `hang` keeps turns running until interrupted.
 */
class FakeCloud implements CloudProvider {
  started: CloudTaskRequest[] = [];
  sent: string[] = [];
  archived: string[] = [];
  interrupted = 0;
  hang = false;
  patch = Buffer.alloc(0);
  private turns = 0;
  private commands: CloudCommandRecord[] = [];
  private pending?: { message: string; polls: number };
  private finalText?: string;

  constructor(readonly id: CloudProviderId) {}

  async detect(): Promise<CloudAvailability> {
    return { id: this.id, available: true, detail: "ready" };
  }
  async start(request: CloudTaskRequest): Promise<CloudTaskHandle> {
    this.started.push(request);
    this.pending = { message: request.prompt.split("Task:\n")[1] ?? "", polls: 1 };
    return {
      provider: this.id,
      id: "task_1",
      url: `https://cloud.example/${this.id}/task_1`,
      baseCommit: request.source.sha,
    };
  }
  async status(): Promise<CloudTaskStatus> {
    if (this.pending && (this.hang || this.pending.polls-- > 0)) {
      return { state: "running", commands: [...this.commands], turns: this.turns };
    }
    if (this.pending) {
      this.turns++;
      this.commands.push({ command: `echo turn${this.turns}`, output: "ok", isError: false });
      this.finalText = `done ${this.turns}: ${this.pending.message}`;
      this.pending = undefined;
    }
    return {
      state: "idle",
      commands: [...this.commands],
      turns: this.turns,
      ...(this.finalText && { finalText: this.finalText }),
      usageTokens: { input: 100 * this.turns, output: 10 * this.turns },
    };
  }
  async send(_handle: CloudTaskHandle, message: string): Promise<void> {
    this.sent.push(message);
    this.pending = { message, polls: 1 };
  }
  async diff(): Promise<Buffer> {
    return this.patch;
  }
  async interrupt(): Promise<void> {
    this.interrupted++;
    this.pending = undefined;
  }
  async archive(handle: CloudTaskHandle): Promise<void> {
    this.archived.push(handle.id);
  }
}

const available = (ids: CloudProviderId[]) => async (): Promise<CloudAvailability[]> =>
  CLOUD_PROVIDER_IDS.map((id) => ({
    id,
    available: ids.includes(id),
    detail: ids.includes(id) ? "ready" : "not signed in",
    ...(!ids.includes(id) && { setupHint: "Sign in" }),
  }));

function setup(cloud: FakeCloud, availableIds: CloudProviderId[] = [cloud.id]) {
  const { root, local, head } = makeRepo();
  const created: CloudWorkerProcess[] = [];
  const store = new SubAgentStore(path.join(root, "subagents"));
  const manager = (parentModel = "claude-opus-5") => {
    const instance = new SubAgentManager({
      cwd: local,
      agents: [],
      getProvider: () => "anthropic",
      getModel: () => parentModel,
      subAgentDepth: 0,
      store,
      sessionRootDir: path.join(root, "sessions"),
      remoteStateDir: path.join(root, "remote-state"),
      createRemoteWorker: (spawn) => {
        const worker = new CloudWorkerProcess({
          ...spawn,
          pollMs: 5,
          provider: () => cloud,
          availability: available(availableIds),
        });
        created.push(worker);
        return worker as unknown as RemoteWorkerHandle;
      },
    });
    cleanups.push(() => instance.shutdownAll());
    return instance;
  };
  return { root, local, head, created, manager };
}

describe("CloudWorkerProcess through SubAgentManager", () => {
  it("runs a turn as a cloud task and reports harness-recorded commands", async () => {
    const cloud = new FakeCloud("claude-cloud");
    const s = setup(cloud);
    const m = s.manager();
    await m.hydrate("parent");
    const spawned = await m.spawn("helper", "fix the bug", undefined, { machine: "claude-cloud" });
    const done = (await m.wait([spawned.agent_id], "all", 10_000)).agents[0]!;
    expect(done).toMatchObject({
      state: "completed",
      output: "done 1: fix the bug",
      machine: "claude-cloud",
      remote_agent_id: `task_1@${s.head}`,
      model: "claude-opus-5",
      turn_count: 1,
      tool_use_count: 1,
      token_usage: { input: 100, output: 10 },
    });
    expect(done.receipt).toContain("https://cloud.example/claude-cloud/task_1");
    expect(done.receipt).toContain("- `echo turn1`");
    expect(done.receipt).toContain("No file changes came back");
    const request = cloud.started[0]!;
    expect(request.prompt).toContain("Do not push");
    expect(request.prompt).toContain("fix the bug");
    expect(request.model).toBe("claude-opus-5");
    expect(request.maxTurns).toBeGreaterThanOrEqual(100);
    expect(request.source.sha).toBe(s.head);
    // git reports the root with forward slashes on Windows.
    expect(path.resolve(request.source.repoRoot)).toBe(path.resolve(s.local));
    expect(request.source.patch).toBeUndefined();

    await m.followup(spawned.agent_id, "and the test");
    const second = (await m.wait([spawned.agent_id], "all", 10_000)).agents[0]!;
    expect(second.output).toBe("done 2: and the test");
    expect(second.receipt).toContain("- `echo turn2`");
    expect(second.receipt).not.toContain("turn1");
    expect(cloud.started).toHaveLength(1);
    expect(cloud.sent).toEqual(["and the test"]);

    await m.shutdownAll();
    expect(cloud.archived).toEqual(["task_1"]);
  });

  it("uses the provider's default model when the parent's is another family", async () => {
    expect(cloudAgentModel("claude-cloud", "gpt-6")).toBe("claude-sonnet-5-5");
    expect(cloudAgentModel("claude-cloud", "claude-haiku-5-5")).toBe("claude-haiku-5-5");
    expect(cloudAgentModel("codex-cloud", "gpt-6")).toBeUndefined();
    const cloud = new FakeCloud("claude-cloud");
    const s = setup(cloud);
    const m = s.manager("gpt-test");
    await m.hydrate("parent");
    const spawned = await m.spawn("h", "x", undefined, { machine: "cloud" });
    const done = (await m.wait([spawned.agent_id], "all", 10_000)).agents[0]!;
    expect(cloud.started[0]!.model).toBe("claude-sonnet-5-5");
    expect(done).toMatchObject({ machine: "claude-cloud", model: "claude-sonnet-5-5" });
  });

  it("brings edits back for providers that return them, and sends uncommitted work", async () => {
    const cloud = new FakeCloud("codex-cloud");
    const s = setup(cloud);
    fs.writeFileSync(path.join(s.local, "a.txt"), "a\nlocal\n");
    cloud.patch = Buffer.from(
      "diff --git a/b.txt b/b.txt\nnew file mode 100644\n--- /dev/null\n+++ b/b.txt\n@@ -0,0 +1 @@\n+cloud\n",
    );
    const m = s.manager();
    await m.hydrate("parent");
    const spawned = await m.spawn("h", "add b", undefined, { machine: "codex-cloud" });
    const done = (await m.wait([spawned.agent_id], "all", 10_000)).agents[0]!;
    expect(cloud.started[0]!.source.patch?.toString()).toContain("+local");
    expect(cloud.started[0]!.model).toBeUndefined();
    expect(fs.readFileSync(path.join(s.local, "b.txt"), "utf-8")).toBe("cloud\n");
    expect(fs.readFileSync(path.join(s.local, "a.txt"), "utf-8")).toBe("a\nlocal\n");
    expect(done.receipt).toContain("applied locally: b.txt");
    expect(done.receipt).toContain("does not report the commands");
  });

  it("interrupts a running turn", async () => {
    const cloud = new FakeCloud("claude-cloud");
    cloud.hang = true;
    const s = setup(cloud);
    const m = s.manager();
    await m.hydrate("parent");
    const spawned = await m.spawn("h", "long", undefined, { machine: "claude-cloud" });
    for (let i = 0; i < 400 && cloud.started.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const stopped = await m.interrupt(spawned.agent_id);
    expect(stopped.state).toBe("interrupted");
    expect(cloud.interrupted).toBe(1);
  });

  it("fails with the setup hint when the pinned provider is unavailable", async () => {
    const cloud = new FakeCloud("codex-cloud");
    const s = setup(cloud, ["claude-cloud"]);
    const m = s.manager();
    await m.hydrate("parent");
    const spawned = await m
      .spawn("h", "x", undefined, { machine: "codex-cloud" })
      .catch((error: Error) => error);
    const snapshot =
      spawned instanceof Error
        ? m.list()[0]!
        : (await m.wait([spawned.agent_id], "all", 10_000)).agents[0]!;
    expect(snapshot.state).toBe("failed");
    expect(snapshot.error).toContain("Codex cloud can't run an agent now");
    expect(snapshot.error).toContain("Sign in");
    expect(cloud.started).toHaveLength(0);
  });

  it("recovery re-attaches to the same cloud task", async () => {
    const cloud = new FakeCloud("claude-cloud");
    const s = setup(cloud);
    const first = s.manager();
    await first.hydrate("parent-1");
    const spawned = await first.spawn("h", "one", undefined, { machine: "claude-cloud" });
    await first.wait([spawned.agent_id], "all", 10_000);
    await first.waitForPersistence();
    // Parent dies: the task stays in the cloud.
    s.created[0]!.detach();

    const second = s.manager();
    await second.hydrate("parent-1");
    expect(second.list()[0]).toMatchObject({
      machine: "claude-cloud",
      remote_agent_id: `task_1@${s.head}`,
    });
    await second.followup(spawned.agent_id, "two");
    const done = (await second.wait([spawned.agent_id], "all", 10_000)).agents[0]!;
    expect(done.state).toBe("completed");
    expect(done.output).toBe("done 2: two");
    expect(s.created).toHaveLength(2);
    expect(cloud.started).toHaveLength(1);
    expect(cloud.archived).toEqual([]);
  });

  it("kill archives the task and exits", async () => {
    const cloud = new FakeCloud("claude-cloud");
    cloud.hang = true;
    const { local, root } = makeRepo();
    const worker = new CloudWorkerProcess({
      machine: "claude-cloud",
      cwd: local,
      localAgentId: "a1",
      stateRoot: path.join(root, "state"),
      pollMs: 5,
      provider: () => cloud,
      availability: available(["claude-cloud"]),
    });
    const out: string[] = [];
    worker.stdout.on("data", (chunk: Buffer) => out.push(chunk.toString()));
    worker.stdin.write(
      `${JSON.stringify({ request_id: "1", command: "initialize", options: {} })}\n`,
    );
    worker.stdin.write(`${JSON.stringify({ request_id: "2", command: "start", task: "t" })}\n`);
    for (let i = 0; i < 400 && cloud.started.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(cloud.started).toHaveLength(1);
    const exited = new Promise((resolve) => worker.once("exit", (...args) => resolve(args)));
    expect(worker.kill("SIGTERM")).toBe(true);
    expect(await exited).toEqual([null, "SIGTERM"]);
    expect(cloud.archived).toEqual(["task_1"]);
    expect(out.join("")).toContain('"request_id":"2","ok":true');
  });

  it("reports a start failure as a failed turn", async () => {
    const cloud = new FakeCloud("codex-cloud");
    cloud.start = async () => {
      throw new CloudError("Push it first (git push).", "not_allowed");
    };
    const s = setup(cloud);
    const m = s.manager();
    await m.hydrate("parent");
    const spawned = await m.spawn("h", "x", undefined, { machine: "codex-cloud" });
    const done = (await m.wait([spawned.agent_id], "all", 10_000)).agents[0]!;
    expect(done).toMatchObject({ state: "failed", error: "Push it first (git push)." });
  });
});

describe("auto machine selection", () => {
  const info = (slotsUsed: number): NodeInfo =>
    ({ modelAuth: true, slots: 2, slotsUsed, load: 0 }) as unknown as NodeInfo;

  function nodesFile(): { file: string; cwd: string } {
    const { root, local } = makeRepo();
    const file = path.join(root, "nodes.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ nodes: [{ name: "pc", url: "http://pc.invalid:1", token: "t" }] }),
    );
    return { file, cwd: local };
  }

  it("prefers a fleet node that can take the agent", async () => {
    const { file, cwd } = nodesFile();
    let asked = false;
    const target = await chooseAutoTarget({
      cwd,
      nodesFile: file,
      probe: async () => info(0),
      settings: () => ({}),
      availability: async () => {
        asked = true;
        return available(["claude-cloud"])();
      },
    });
    expect(target).toEqual({ kind: "node", machine: "pc" });
    expect(asked).toBe(false);
  });

  it("falls back to the first available cloud only when no node can take it", async () => {
    const { file, cwd } = nodesFile();
    const common = { cwd, nodesFile: file, probe: async () => info(2) };
    expect(
      await chooseAutoTarget({
        ...common,
        settings: () => ({}),
        availability: available(["codex-cloud"]),
      }),
    ).toEqual({ kind: "cloud", machine: "codex-cloud" });
    expect(
      await chooseAutoTarget({
        cwd,
        nodesFile: path.join(cwd, "missing.json"),
        settings: () => ({}),
        availability: available(["claude-cloud", "codex-cloud"]),
      }),
    ).toEqual({ kind: "cloud", machine: "claude-cloud" });
    await expect(
      chooseAutoTarget({
        ...common,
        settings: () => ({ when: "manual" }),
        availability: available(["claude-cloud"]),
      }),
    ).rejects.toThrow(/name it/);
    await expect(
      chooseAutoTarget({
        ...common,
        settings: () => ({ use: ["validation"] }),
        availability: available(["claude-cloud"]),
      }),
    ).rejects.toThrow(/cloud is off for agents/);
    await expect(
      chooseAutoTarget({ ...common, settings: () => ({}), availability: available([]) }),
    ).rejects.toThrow(/no cloud is available/);
  });
});
