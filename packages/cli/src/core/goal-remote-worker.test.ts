// GL1/GL3/D4: Goal workers on fleet nodes share the remote-agent start path and
// node slots; their edits come home one patch at a time, and a conflict fails
// the task with the files named and the patch saved in the goal folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeRepo,
  startTestNode,
  TEST_TOKEN,
  type TestNode,
} from "./fleet/__fixtures__/test-node.js";
import { FLEET_PROTOCOL } from "./fleet/protocol.js";
import { getGoalRun, projectDir, upsertGoalRun } from "./goal-store.js";
import {
  listGoalWorkers,
  startGoalWorker,
  type GoalWorkerCompletion,
  type GoalWorkerRecord,
} from "./goal-worker.js";

const gatedWorker = fileURLToPath(
  new URL("./__fixtures__/fake-gated-remote-worker.mjs", import.meta.url),
);

let root: string;
let local: string;
let nodesFile: string;
const closers: Array<() => Promise<void>> = [];

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ez-goal-remote-")));
  process.env.EZ_GOALS_BASE = path.join(root, "goals");
  local = makeRepo(root).local;
  nodesFile = path.join(root, "nodes.json");
});
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  delete process.env.EZ_GOALS_BASE;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function nodes(slots: number[]): Promise<TestNode[]> {
  const started: TestNode[] = [];
  for (const [index, count] of slots.entries()) {
    const node = await startTestNode(path.join(root, `node-${index}`), {
      slots: count,
      cliEntry: gatedWorker,
    });
    node.info.protocol = FLEET_PROTOCOL;
    closers.push(() => node.close());
    started.push(node);
  }
  fs.writeFileSync(
    nodesFile,
    JSON.stringify({
      nodes: started.map((node, index) => ({
        name: `pc-${index}`,
        url: node.url,
        token: TEST_TOKEN,
      })),
    }),
  );
  return started;
}

async function seed(taskIds: string[], maxRemoteWorkers?: number): Promise<void> {
  await upsertGoalRun(local, {
    id: "goal-r",
    title: "Remote goal",
    goal: "Use the fleet",
    status: "ready",
    successCriteria: ["done"],
    prerequisites: [],
    harness: [],
    evidencePlan: [],
    tasks: taskIds.map((id) => ({ id, title: id, prompt: id, status: "pending", attempts: 0 })),
    evidence: [],
    blockers: [],
    ...(maxRemoteWorkers !== undefined && { maxRemoteWorkers }),
  });
}

function start(
  taskId: string,
  prompt: string,
  machine = "auto",
  onQueued?: (reason: string) => void,
): Promise<{ record: GoalWorkerRecord; done: Promise<GoalWorkerCompletion> }> {
  let resolve!: (c: GoalWorkerCompletion) => void;
  const done = new Promise<GoalWorkerCompletion>((r) => (resolve = r));
  return startGoalWorker({
    cwd: local,
    goalRunId: "goal-r",
    goalTaskId: taskId,
    provider: "openai",
    model: "gpt-test",
    prompt,
    systemPrompt: "Goal worker.",
    machine,
    timeoutMs: 60_000,
    fleet: {
      nodesFile,
      queuePollMs: 50,
      reconnectWindowMs: 5_000,
      maxRetryAfterMs: 50,
      ...(onQueued && { onQueued }),
    },
    onComplete: resolve,
  }).then((record) => ({ record, done }));
}

async function until(check: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `t${i + 1}`);

describe("GL1: Goal workers on fleet nodes", () => {
  it("runs 6 workers at once on one 6-slot node, and a 7th waits for a free slot", async () => {
    const [node] = await nodes([6]);
    await seed(ids(7));
    const gate = path.join(root, "gate");
    const runs = await Promise.all(
      ids(6).map((id) => start(id, `gate=${gate} write ${id}.txt=${id}`)),
    );
    await until(() => node!.slotsUsed() === 6);
    expect(runs.every((run) => run.record.status === "running")).toBe(true);
    // D4: the record says where it runs.
    await until(() => listGoalWorkers(local).every((worker) => worker.machine === "pc-0"));

    let markQueued!: (reason: string) => void;
    const queued = new Promise<string>((resolve) => (markQueued = resolve));
    const seventh = await start("t7", "write t7.txt=t7", "auto", (reason) => markQueued(reason));
    // Event-driven: the 7th has seen every slot taken and is waiting.
    expect(await queued).toMatch(/full \(6\/6 slots/);
    expect(node!.slotsUsed()).toBe(6);
    expect(fs.existsSync(path.join(local, "t7.txt"))).toBe(false);

    fs.writeFileSync(gate, "go");
    const results = await Promise.all([...runs, seventh].map((run) => run.done));
    expect(results.map((r) => r.status)).toEqual(Array(7).fill("done"));
    for (const id of ids(7)) {
      expect(fs.readFileSync(path.join(local, `${id}.txt`), "utf-8")).toBe(id);
    }
    const run = await getGoalRun(local, "goal-r");
    expect(run?.tasks.every((task) => task.remoteNode === "pc-0" && task.machine === "auto")).toBe(
      true,
    );
  }, 120_000);

  it("spreads 6 auto workers over 6 one-slot nodes", async () => {
    const started = await nodes([1, 1, 1, 1, 1, 1]);
    await seed(ids(6));
    const gate = path.join(root, "gate");
    const runs = await Promise.all(
      ids(6).map((id) => start(id, `gate=${gate} write ${id}.txt=${id}`)),
    );
    await until(() => started.every((node) => node.slotsUsed() === 1));
    fs.writeFileSync(gate, "go");
    const results = await Promise.all(runs.map((run) => run.done));
    expect(results.every((r) => r.status === "done")).toBe(true);
    expect(new Set(results.map((r) => r.worker.machine)).size).toBe(6);
  }, 120_000);

  it("keeps a user-set cap on remote workers per goal", async () => {
    await nodes([4]);
    await seed(ids(2), 1);
    const gate = path.join(root, "gate");
    const first = await start("t1", `gate=${gate} write a.txt=1`);
    await expect(start("t2", "write b.txt=2")).rejects.toThrow(
      'Goal "Remote goal" already has 1 worker(s) on fleet nodes (max_remote_workers=1). Wait for one to finish or raise the cap.',
    );
    fs.writeFileSync(gate, "go");
    expect((await first.done).status).toBe("done");
  }, 60_000);

  it("refuses a node with an incompatible protocol before any work is sent (S3)", async () => {
    const [node] = await nodes([2]);
    node!.info.protocol = 1;
    await seed(["t1"]);
    const run = await start("t1", "write a.txt=1", "pc-0");
    const result = await run.done;
    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(
      /^Remote Goal worker could not run on pc-0: Machine "pc-0" runs EZ Coder .* fleet protocol 1; .*Update the node: run `ezcoder node update` there\.$/,
    );
    expect(node!.slotsUsed()).toBe(0);
  }, 60_000);
});

describe("GL3: conflicting edits from parallel remote workers", () => {
  it("applies one worker's edits and fails the other with the files named and the patch saved", async () => {
    await nodes([1, 1]);
    await seed(["t1", "t2"]);
    const gateA = path.join(root, "gate-a");
    const gateB = path.join(root, "gate-b");
    const a = await start("t1", `gate=${gateA} write a.txt=from A;only-a.txt=A`);
    const b = await start("t2", `gate=${gateB} write a.txt=from B;only-b.txt=B`);
    await until(
      () => listGoalWorkers(local).filter((w) => w.machine?.startsWith("pc-")).length === 2,
    );

    fs.writeFileSync(gateA, "go");
    const resultA = await a.done;
    expect(resultA.status).toBe("done");
    expect(fs.readFileSync(path.join(local, "a.txt"), "utf-8")).toBe("from A");

    fs.writeFileSync(gateB, "go");
    const resultB = await b.done;
    expect(resultB.status).toBe("failed");
    // Nothing of B's landed: all-or-nothing.
    expect(fs.readFileSync(path.join(local, "a.txt"), "utf-8")).toBe("from A");
    expect(fs.existsSync(path.join(local, "only-b.txt"))).toBe(false);

    const run = await getGoalRun(local, "goal-r");
    const task = run!.tasks.find((t) => t.id === "t2")!;
    expect(task.status).toBe("failed");
    expect(task.lastSummary).toMatch(
      /^Edits from pc-\d conflict with this folder in: a\.txt\. None of this worker's edits were applied; its patch is saved at .*\.patch\. Apply by hand with: git apply --3way --binary ".*\.patch"/,
    );
    expect(task.keptPatch).toBeDefined();
    expect(task.keptPatch!.startsWith(path.join(projectDir(local), "patches"))).toBe(true);
    const saved = fs.readFileSync(task.keptPatch!, "utf-8");
    expect(saved).toContain("from B");
    expect(saved).toContain("only-b.txt");
    expect(resultB.worker.keptPatch).toBe(task.keptPatch);
    expect(run!.evidence.some((e) => e.label === `Worker ${resultB.worker.id} conflict`)).toBe(
      true,
    );
  }, 120_000);
});
