import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { tasksStore } from "./tasks-store.js";

// The tasks-store reads getAppPaths().agentDir at runtime via getPlanPath().
// Override HOME so each test gets an isolated tmp directory and we don't
// scribble on the user's real ~/.gg/boss/plan.json.
let tmpHome: string;
let originalHome: string | undefined;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "gg-boss-test-"));
  originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
  // Reset in-memory state between tests.
  await tasksStore.reset();
});

afterEach(async () => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

describe("tasksStore — round-trip", () => {
  it("add → list returns the same task", async () => {
    const t = await tasksStore.add({
      project: "alpha",
      title: "do thing",
      description: "do the thing",
    });
    const list = tasksStore.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(t.id);
    expect(list[0]!.status).toBe("pending");
  });

  it("update changes only the supplied fields", async () => {
    const t = await tasksStore.add({
      project: "alpha",
      title: "do thing",
      description: "do the thing",
    });
    const updated = await tasksStore.update(t.id, { status: "done" });
    expect(updated?.status).toBe("done");
    expect(updated?.title).toBe("do thing"); // untouched
  });

  it("update with no status preserves status (regression: was wiping to undefined)", async () => {
    const t = await tasksStore.add({
      project: "alpha",
      title: "do thing",
      description: "do the thing",
    });
    // Simulate the boss calling update_task with only `notes` — the bug was
    // spreading {status: undefined, notes: ...} which clobbered status.
    // tasksStore.update receives only `notes` here so status must survive.
    const updated = await tasksStore.update(t.id, { notes: "hmm" });
    expect(updated?.status).toBe("pending");
    expect(updated?.notes).toBe("hmm");
  });

  it("remove drops the task", async () => {
    const t = await tasksStore.add({
      project: "alpha",
      title: "do thing",
      description: "x",
    });
    expect(await tasksStore.remove(t.id)).toBe(true);
    expect(tasksStore.list()).toHaveLength(0);
  });
});

describe("tasksStore — nextDispatchable", () => {
  it("prefers pending over blocked", async () => {
    const blocked = await tasksStore.add({ project: "a", title: "b", description: "x" });
    await tasksStore.update(blocked.id, { status: "blocked" });
    const pending = await tasksStore.add({ project: "a", title: "p", description: "x" });
    const next = tasksStore.nextDispatchable("a");
    expect(next?.id).toBe(pending.id);
  });

  it("falls through to blocked when nothing is pending", async () => {
    const blocked = await tasksStore.add({ project: "a", title: "b", description: "x" });
    await tasksStore.update(blocked.id, { status: "blocked" });
    const next = tasksStore.nextDispatchable("a");
    expect(next?.id).toBe(blocked.id);
  });

  it("ignores done/in_progress/skipped tasks", async () => {
    const t1 = await tasksStore.add({ project: "a", title: "t1", description: "x" });
    const t2 = await tasksStore.add({ project: "a", title: "t2", description: "x" });
    const t3 = await tasksStore.add({ project: "a", title: "t3", description: "x" });
    await tasksStore.update(t1.id, { status: "done" });
    await tasksStore.update(t2.id, { status: "in_progress" });
    await tasksStore.update(t3.id, { status: "skipped" });
    expect(tasksStore.nextDispatchable("a")).toBeUndefined();
  });

  it("scopes to the requested project", async () => {
    await tasksStore.add({ project: "a", title: "x", description: "x" });
    const b1 = await tasksStore.add({ project: "b", title: "y", description: "y" });
    expect(tasksStore.nextDispatchable("b")?.id).toBe(b1.id);
  });
});

describe("tasksStore — load() pruning + self-heal", () => {
  it("reset wipes in-memory + on-disk state", async () => {
    await tasksStore.add({ project: "a", title: "x", description: "x" });
    await tasksStore.reset();
    expect(tasksStore.list()).toHaveLength(0);
    await tasksStore.load();
    expect(tasksStore.list()).toHaveLength(0);
  });

  it("load drops done + skipped tasks", async () => {
    const a = await tasksStore.add({ project: "p", title: "a", description: "x" });
    const b = await tasksStore.add({ project: "p", title: "b", description: "x" });
    const c = await tasksStore.add({ project: "p", title: "c", description: "x" });
    await tasksStore.update(a.id, { status: "done" });
    await tasksStore.update(b.id, { status: "skipped" });
    await tasksStore.load();
    const list = tasksStore.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(c.id);
  });

  it("load resets stale in_progress to pending", async () => {
    const t = await tasksStore.add({ project: "p", title: "x", description: "x" });
    await tasksStore.update(t.id, { status: "in_progress" });
    await tasksStore.load();
    expect(tasksStore.byId(t.id)?.status).toBe("pending");
  });
});
