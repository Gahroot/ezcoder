import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGoalsTool } from "../src/tools/goals.js";
import { decideGoalNextAction, canCompleteGoalRun } from "../src/core/goal-controller.js";
import { getGoalRun } from "../src/core/goal-store.js";
import type { GoalRun, GoalTask } from "../src/core/goal-store.js";
import {
  buildGoalWorkerSyntheticEventPayload,
  buildGoalVerifierSyntheticEventPayload,
  formatGoalWorkerCompletionEvent,
  formatGoalVerifierCompletionEvent,
  parseGoalSyntheticEvent,
} from "../src/ui/goal-events.js";
import type { GoalWorkerCompletion } from "../src/core/goal-worker.js";

const now = "2026-01-01T00:00:00.000Z";

async function executeGoalHarnessTool(cwd: string, args: Parameters<ReturnType<typeof createGoalsTool>["execute"]>[0]) {
  return createGoalsTool(cwd).execute(args, {
    signal: new AbortController().signal,
    toolCallId: "goal-e2e-harness",
  });
}

async function runDurableToolLifecycleHarness() {
  const previousGoalsBase = process.env.GG_GOALS_BASE;
  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "goal-e2e-base-"));
  const tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "goal-e2e-project-"));
  process.env.GG_GOALS_BASE = tmpBase;
  try {
    await fs.writeFile(path.join(tmpProject, "fixture.txt"), "ready\n", "utf-8");
    await executeGoalHarnessTool(tmpProject, {
      action: "create",
      run_id: "goal-e2e-tool-run",
      title: "Durable local Goal E2E",
      goal: "Exercise setup-to-completion gates in a temp project.",
      success_criteria: ["safe prerequisite checked", "task done", "verifier pass", "final audit pass"],
      prerequisites: [{ id: "fixture", label: "Fixture exists", status: "unknown", check_command: "test -f fixture.txt" }],
      evidence_plan: [{ id: "fixture-proof", label: "Fixture proof", mechanism: "command", description: "Verifier checks fixture", status: "ready", command: "test -f fixture.txt", evidence: "fixture checked" }],
      verifier_command: "test -f fixture.txt",
    });
    await executeGoalHarnessTool(tmpProject, { action: "task", run_id: "goal-e2e-tool-run", task_id: "work", task_title: "Local work", task_prompt: "No-op local work", task_status: "done", attempts: 1, summary: "work complete" });
    await executeGoalHarnessTool(tmpProject, { action: "verify", run_id: "goal-e2e-tool-run", verification_status: "pass", summary: "Fixture proof passed", exit_code: 0, output_path: "fixture.txt" });
    let run = await getGoalRun(tmpProject, "goal-e2e-tool-run");
    assert.equal(run?.status, "ready", "verifier pass waits for final audit");
    assert.equal(run?.prerequisites[0]?.status, "met", "safe prerequisite command ran");
    await executeGoalHarnessTool(tmpProject, { action: "task", run_id: "goal-e2e-tool-run", task_id: "audit", task_title: "Audit Goal completion evidence", task_prompt: "Audit durable artifacts", task_status: "done", attempts: 1, summary: "audit complete" });
    const checkedAt = run?.verifier?.lastResult?.checkedAt;
    assert.ok(checkedAt, "verifier checkedAt persisted");
    await executeGoalHarnessTool(tmpProject, { action: "audit", run_id: "goal-e2e-tool-run", verification_status: "pass", summary: `FINAL_AUDIT_PASS verifier_checked_at=${checkedAt}; artifact=fixture.txt`, output_path: "fixture.txt" });
    await executeGoalHarnessTool(tmpProject, { action: "complete", run_id: "goal-e2e-tool-run" });
    run = await getGoalRun(tmpProject, "goal-e2e-tool-run");
    assert.equal(run?.status, "passed", "complete marks durable run passed only after audit");
    assert.equal(canCompleteGoalRun(run as GoalRun).ok, true, "completion gate accepts durable E2E run");
    assert.ok(run?.evidence.some((item) => item.label === "Verifier result"), "verifier evidence persisted");
    assert.ok(run?.evidence.some((item) => item.label === "Final completion audit pass"), "final audit evidence persisted");
  } finally {
    if (previousGoalsBase === undefined) delete process.env.GG_GOALS_BASE;
    else process.env.GG_GOALS_BASE = previousGoalsBase;
    await fs.rm(tmpBase, { recursive: true, force: true });
    await fs.rm(tmpProject, { recursive: true, force: true });
  }
}

await runDurableToolLifecycleHarness();

function baseRun(overrides: Partial<GoalRun> = {}): GoalRun {
  return {
    id: "goal-e2e-run",
    title: "Deterministic Goal lifecycle harness",
    goal: "Prove Goal orchestration lifecycle without live model credentials.",
    status: "running",
    createdAt: now,
    updatedAt: now,
    projectPath: process.cwd(),
    successCriteria: ["controller decisions are deterministic", "events are parseable"],
    prerequisites: [],
    harness: [],
    evidencePlan: [],
    tasks: [],
    evidence: [],
    blockers: [],
    ...overrides,
  };
}

function task(overrides: Partial<GoalTask> = {}): GoalTask {
  return {
    id: "task-1",
    title: "Implement local proof",
    prompt: "Create deterministic local proof.",
    status: "pending",
    attempts: 0,
    ...overrides,
  };
}

function assertDecision(run: GoalRun, kind: ReturnType<typeof decideGoalNextAction>["kind"], message: string) {
  const decision = decideGoalNextAction(run);
  assert.equal(decision.kind, kind, `${message}: expected ${kind}, got ${decision.kind} (${decision.reason})`);
  return decision;
}

const blockedPrereq = baseRun({
  prerequisites: [{ id: "p1", label: "API token", status: "missing", instructions: "Provide token." }],
});
assertDecision(blockedPrereq, "blocked", "missing prerequisites block lifecycle");
assert.equal(canCompleteGoalRun(blockedPrereq).ok, false);

const plannedEvidence = baseRun({
  evidencePlan: [{ id: "e1", label: "CLI proof", mechanism: "command", description: "Run local CLI", status: "planned" }],
});
assertDecision(plannedEvidence, "create_task", "planned evidence creates instrumentation task");

const blockedEvidence = baseRun({
  evidencePlan: [{ id: "e1", label: "External proof", mechanism: "manual", description: "External account", status: "blocked", instructions: "User login required." }],
});
assertDecision(blockedEvidence, "blocked", "blocked evidence plan blocks lifecycle");

const pendingTaskRun = baseRun({ tasks: [task()] });
const start = assertDecision(pendingTaskRun, "start_worker", "pending task starts worker");
assert.equal(start.kind === "start_worker" && start.attempts, 1);

const runningTaskRun = baseRun({ tasks: [task({ status: "running", workerId: "worker-1", attempts: 1 })] });
assertDecision(runningTaskRun, "wait", "running task emits wait decision");

const workerCompletion: GoalWorkerCompletion = {
  worker: {
    id: "worker-1",
    runId: pendingTaskRun.id,
    goalTaskId: "task-1",
    title: "Implement local proof",
    prompt: "Create deterministic local proof.",
    status: "done",
    attempts: 1,
    logFile: "tmp/goal-worker.log",
    startedAt: now,
  },
  status: "done",
  exitCode: 0,
  summary: "Worker completed local proof.",
  toolsUsed: [{ name: "bash", ok: true }],
};
const workerEvent = formatGoalWorkerCompletionEvent(pendingTaskRun, "Implement local proof", workerCompletion);
const parsedWorker = parseGoalSyntheticEvent(workerEvent);
assert.equal(parsedWorker?.kind, "worker");
assert.equal(parsedWorker?.status, "done");
assert.equal(buildGoalWorkerSyntheticEventPayload(pendingTaskRun, "Implement local proof", workerCompletion).toolsUsed[0]?.name, "bash");

const readyForVerifier = baseRun({
  tasks: [task({ status: "done", attempts: 1 })],
  evidencePlan: [{ id: "e1", label: "Verifier output", mechanism: "command", description: "Verifier passes", status: "ready", command: "pnpm goal:e2e", evidence: "pass" }],
  verifier: { description: "local verifier", command: "pnpm goal:e2e" },
});
assertDecision(readyForVerifier, "run_verifier", "ready run executes verifier");

const verifierFailRun = baseRun({
  tasks: [task({ status: "done", attempts: 1 })],
  evidencePlan: readyForVerifier.evidencePlan,
  verifier: { description: "local verifier", command: "pnpm goal:e2e", lastResult: { status: "fail", summary: "failed", command: "pnpm goal:e2e", exitCode: 1, outputPath: "tmp/fail.log", checkedAt: now } },
});
assertDecision(verifierFailRun, "create_task", "verifier failure creates bounded fix task");
const failEvent = formatGoalVerifierCompletionEvent(verifierFailRun, "fail", "pnpm goal:e2e", 1, "failed deterministically");
assert.equal(parseGoalSyntheticEvent(failEvent)?.kind, "verifier");
assert.equal(buildGoalVerifierSyntheticEventPayload(verifierFailRun, "fail", "pnpm goal:e2e", 1, "failed").completionGuidance.includes("bounded fix task"), true);

const verifiedNeedsAuditRun = baseRun({
  status: "running",
  tasks: [task({ status: "done", attempts: 1 })],
  evidence: [{ id: "ev1", kind: "command", label: "Verifier output", path: "tmp/pass.log", content: "Verifier output pass", createdAt: now }],
  evidencePlan: readyForVerifier.evidencePlan,
  verifier: { description: "local verifier", command: "pnpm goal:e2e", lastResult: { status: "pass", summary: "Verifier output pass", command: "pnpm goal:e2e", exitCode: 0, outputPath: "tmp/pass.log", checkedAt: now } },
});
assert.equal(canCompleteGoalRun(verifiedNeedsAuditRun).ok, false);
assertDecision(verifiedNeedsAuditRun, "create_task", "pass verifier plus evidence creates final audit task");

const completeRun = baseRun({
  ...verifiedNeedsAuditRun,
  tasks: [task({ status: "done", attempts: 1 }), task({ id: "audit-task", title: "Audit Goal completion evidence", prompt: "Audit final artifacts.", status: "done", attempts: 1, workerId: "audit-worker" })],
  completionAudit: { status: "pass", summary: `FINAL_AUDIT_PASS verifier_checked_at=${now}`, checkedAt: "2026-01-01T00:00:01.000Z", verifierCheckedAt: now, outputPath: "tmp/pass.log" },
});
assert.equal(canCompleteGoalRun(completeRun).ok, true);
assertDecision(completeRun, "complete", "pass verifier plus evidence and final audit completes lifecycle");
const passEvent = formatGoalVerifierCompletionEvent(completeRun, "pass", "pnpm goal:e2e", 0, "passed deterministically");
const parsedPass = parseGoalSyntheticEvent(passEvent);
assert.equal(parsedPass?.kind, "verifier");
assert.equal(parsedPass?.status, "pass");

const terminalRun = baseRun({ status: "passed" });
assertDecision(terminalRun, "terminal", "passed run remains terminal");

console.log("Goal lifecycle harness passed: prerequisites blocked, evidence planned/blocked, worker and verifier events parsed, verifier fail fixes, ready run verifies, final audit gates completion, complete run completes.");
