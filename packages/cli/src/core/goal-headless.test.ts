import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGoalHeadless } from "./goal-headless.js";
import { FINAL_COMPLETION_AUDIT_TASK_TITLE } from "./goal-controller.js";
import { createGoalRun, getGoalRun, updateGoalTask, upsertGoalRun } from "./goal-store.js";

let root: string;
let cwd: string;
let goalDir: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ez-goal-headless-")));
  process.env.EZ_GOALS_BASE = path.join(root, "store");
  cwd = path.join(root, "repo");
  goalDir = path.join(root, "goal");
  fs.mkdirSync(cwd);
  fs.mkdirSync(goalDir);
});
afterEach(() => {
  delete process.env.EZ_GOALS_BASE;
  fs.rmSync(root, { recursive: true, force: true });
});

function writeGoal(
  model: { provider?: string; model?: string } = {
    provider: "anthropic",
    model: "m-1",
  },
): void {
  const run = createGoalRun("/laptop/project", {
    id: "hosted-goal",
    title: "Hosted",
    goal: "Make it pass",
    status: "ready",
    successCriteria: ["tests pass"],
    evidencePlan: [
      {
        id: "e",
        label: "tests",
        mechanism: "command",
        description: "run tests",
        status: "ready",
        command: "npm test",
        evidence: "planned",
      },
    ],
    verifier: { description: "tests", command: "npm test", machine: "laptop-node" },
    tasks: [
      {
        id: "t1",
        title: "Fix it",
        prompt: "Fix the bug",
        status: "pending",
        attempts: 0,
        machine: "gpu-box",
      },
    ],
  });
  fs.writeFileSync(path.join(goalDir, "goal.json"), JSON.stringify({ run, ...model }));
}

describe("runGoalHeadless", () => {
  it("runs workers and the verifier locally and writes result.json", async () => {
    writeGoal();
    const workerCalls: string[] = [];
    let resolved = 0;
    const verifierCalls: string[] = [];
    const result = await runGoalHeadless(goalDir, cwd, {
      log: () => {},
      maxSteps: 40,
      resolveModel: async () => {
        resolved++;
        return { provider: "openai", model: "node-default" };
      },
      runWorker: async ({ taskId, title, model, run }) => {
        workerCalls.push(`${title}:${model}`);
        if (title === FINAL_COMPLETION_AUDIT_TASK_TITLE) {
          // What a real audit worker records with the goals tool.
          const latest = (await getGoalRun(cwd, run.id))!;
          const checkedAt = latest.verifier!.lastResult!.checkedAt;
          await upsertGoalRun(cwd, {
            ...latest,
            completionAudit: {
              status: "pass",
              summary: `FINAL_AUDIT_PASS verifier_checked_at=${checkedAt} output=${path.join(root, "audit.log")}`,
              checkedAt: new Date().toISOString(),
              verifierCheckedAt: checkedAt,
              outputPath: path.join(root, "audit.log"),
            },
          });
        }
        await updateGoalTask(cwd, run.id, taskId, { status: "done", lastSummary: "fixed" });
        return "done";
      },
      runVerifier: async ({ command }) => {
        verifierCalls.push(command);
        return {
          verification: {
            status: "pass",
            summary: "ok",
            command,
            exitCode: 0,
            checkedAt: new Date().toISOString(),
          },
          failureClass: "verifier_pass",
          durationMs: 1,
        };
      },
    });
    expect(workerCalls[0]).toBe("Fix it:m-1");
    expect(workerCalls).toContain(`${FINAL_COMPLETION_AUDIT_TASK_TITLE}:m-1`);
    expect(verifierCalls[0]).toBe("npm test");
    const stored = await getGoalRun(cwd, "hosted-goal");
    // Placement from the laptop is dropped: everything runs on this machine.
    expect(stored?.projectPath).not.toBe("/laptop/project");
    expect(stored?.verifier?.machine).toBeUndefined();
    expect(stored?.tasks[0]?.machine).toBeUndefined();
    const written = JSON.parse(fs.readFileSync(path.join(goalDir, "result.json"), "utf-8"));
    expect(result.status).toBe("passed");
    expect(stored?.status).toBe("passed");
    expect(written).toMatchObject({ runId: "hosted-goal", status: "passed" });
    // The controller sent a model, so the node's default wasn't needed.
    expect(resolved).toBe(0);
  });

  it("uses the node's own default provider and model when the controller sent none", async () => {
    writeGoal({});
    const seen: string[] = [];
    await runGoalHeadless(goalDir, cwd, {
      log: () => {},
      maxSteps: 3,
      resolveModel: async () => ({ provider: "openai", model: "node-default" }),
      runWorker: async ({ provider, model }) => {
        seen.push(`${provider}/${model}`);
        return "failed";
      },
    });
    expect(seen[0]).toBe("openai/node-default");
  });

  it("stops with a summary when the goal blocks", async () => {
    const run = createGoalRun(cwd, {
      id: "blocked-goal",
      title: "Blocked",
      goal: "Needs a key",
      status: "ready",
      prerequisites: [
        { id: "k", label: "API key", status: "missing", instructions: "Set API_KEY." },
      ],
    });
    fs.writeFileSync(path.join(goalDir, "goal.json"), JSON.stringify({ run }));
    const result = await runGoalHeadless(goalDir, cwd, {
      log: () => {},
      maxSteps: 10,
      resolveModel: async () => ({ provider: "openai", model: "node-default" }),
    });
    expect(result.status).toBe("blocked");
    expect(result.summary).toContain("API key");
  });

  it("refuses a goal.json without a run", async () => {
    fs.writeFileSync(path.join(goalDir, "goal.json"), JSON.stringify({}));
    await expect(runGoalHeadless(goalDir, cwd, { log: () => {} })).rejects.toThrow(
      /holds no Goal run/,
    );
  });
});
