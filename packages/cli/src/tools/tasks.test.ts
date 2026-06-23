import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTasksTool } from "./tasks.js";
import { loadTasks } from "../core/task-store.js";

// The tool's execute() may be called by the agent loop with a second context
// arg; the tasks tool ignores it, so the tests pass params only.
type Exec = (params: Record<string, unknown>) => Promise<string>;

describe("tasks tool", () => {
  let tmp: string;
  let base: string;
  let exec: Exec;
  const cwd = "/virtual/project";

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tasks-tool-"));
    base = path.join(tmp, "tasks");
    process.env.EZCODER_TASKS_BASE = base;
    exec = createTasksTool(cwd).execute as unknown as Exec;
  });

  afterEach(async () => {
    delete process.env.EZCODER_TASKS_BASE;
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function addOne(
    title = "Build the thing",
    prompt = "Do the work in src/x.ts",
  ): Promise<string> {
    const result = await exec({ action: "add", title, prompt });
    const match = /id: ([0-9a-f]+)/.exec(result);
    if (!match) throw new Error(`no id in: ${result}`);
    return match[1];
  }

  it("updates a task's status", async () => {
    const id = await addOne();
    const result = await exec({ action: "update", id, status: "in-progress" });
    expect(result).toContain("status=in-progress");
    const [task] = await loadTasks(cwd);
    expect(task.status).toBe("in-progress");
  });

  it("updates a task's title and prompt without losing the other fields", async () => {
    const id = await addOne();
    await exec({ action: "update", id, title: "New title", prompt: "New prompt" });
    const [task] = await loadTasks(cwd);
    expect(task.title).toBe("New title");
    expect(task.prompt).toBe("New prompt");
    expect(task.status).toBe("pending");
  });

  it("rejects an update with no fields to change", async () => {
    const id = await addOne();
    const result = await exec({ action: "update", id });
    expect(result).toMatch(/at least one of status, title, or prompt/);
  });

  it("errors when the id does not match a task", async () => {
    await addOne();
    const result = await exec({ action: "update", id: "deadbeef", status: "done" });
    expect(result).toMatch(/no task found/);
  });

  it("still supports add, done, and remove", async () => {
    const id = await addOne();
    expect(await exec({ action: "done", id })).toContain("Marked done");
    expect((await loadTasks(cwd))[0].status).toBe("done");
    expect(await exec({ action: "remove", id })).toContain("Removed");
    expect(await loadTasks(cwd)).toHaveLength(0);
  });
});
