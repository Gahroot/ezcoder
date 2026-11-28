// GL4: run a Goal's controller loop with no UI (`ezcoder goals run --headless
// <goal-dir>`), as a fleet node does for a Goal hosted on it. It drives the
// same decision function as the app (decideGoalNextAction): queue the tasks it
// proposes, run each worker locally, run the verifier, and stop when the Goal
// passes, pauses or blocks. The outcome is written to <goal-dir>/result.json.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Provider } from "@prestyj/ai";
import { canCompleteGoalRun, decideGoalNextAction } from "./goal-controller.js";
import {
  appendGoalDecision,
  appendGoalEvidence,
  createGoalTask,
  getGoalRun,
  normalizeGoalRun,
  reconcileActiveGoalRuns,
  updateGoalTask,
  upsertGoalRun,
  type GoalRun,
  type GoalRunStatus,
} from "./goal-store.js";
import { runGoalVerifierCommand, type RunGoalVerifierResult } from "./goal-verifier.js";
import { startGoalWorker, type GoalWorkerCompletion } from "./goal-worker.js";
import { ALL_PROVIDERS } from "../app-sidecar/app-settings.js";
import { ensureAppDirs, loadSavedSettings } from "../config.js";
import { AuthStorage } from "./auth-storage.js";
import { resolveStartOrFallback, type ResolvedStart } from "./resolve-start.js";

/** <goal-dir>/goal.json: what the controller sent (GoalHostRequest.goal). */
export const HEADLESS_GOAL_FILE = "goal.json";
/** <goal-dir>/result.json: what the run ended as (read by the node). */
export const HEADLESS_RESULT_FILE = "result.json";

export interface HeadlessGoalResult {
  runId: string;
  status: GoalRunStatus;
  summary: string;
  finishedAt: string;
}

export interface HeadlessGoalDeps {
  /** Run one worker for a task and resolve when it ends (default: a local Goal worker). */
  runWorker?: (args: {
    cwd: string;
    run: GoalRun;
    taskId: string;
    title: string;
    prompt: string;
    provider: Provider;
    model: string;
  }) => Promise<GoalWorkerCompletion["status"]>;
  /** Run the verifier (default: locally in cwd). */
  runVerifier?: (args: {
    cwd: string;
    runId: string;
    command: string;
  }) => Promise<RunGoalVerifierResult>;
  /**
   * Provider + model when the controller sent none (default: this node's own
   * saved settings and logins, resolved like the CLI does at startup).
   */
  resolveModel?: () => Promise<ResolvedStart>;
  /** Safety stop for the loop (default 500 decisions). */
  maxSteps?: number;
  log?: (line: string) => void;
}

/** The node's configured default provider/model, as the CLI picks it at startup. */
export async function resolveNodeGoalModel(): Promise<ResolvedStart> {
  const saved = loadSavedSettings();
  const paths = await ensureAppDirs();
  const auth = new AuthStorage(paths.authFile);
  await auth.load();
  const { provider, model } = await resolveStartOrFallback(
    auth,
    ALL_PROVIDERS,
    saved.provider ?? "anthropic",
    saved.model,
  );
  return { provider, model };
}

async function defaultRunWorker(args: {
  cwd: string;
  run: GoalRun;
  taskId: string;
  title: string;
  prompt: string;
  provider: Provider;
  model: string;
}): Promise<GoalWorkerCompletion["status"]> {
  return new Promise((resolve, reject) => {
    startGoalWorker({
      cwd: args.cwd,
      goalRunId: args.run.id,
      goalTaskId: args.taskId,
      taskTitle: args.title,
      provider: args.provider,
      model: args.model,
      prompt: args.prompt,
      onComplete: (completion) => resolve(completion.status),
    }).catch(reject);
  });
}

/** Run the Goal in <goal-dir>/goal.json to an end state in `cwd`. */
export async function runGoalHeadless(
  goalDir: string,
  cwd: string,
  deps: HeadlessGoalDeps = {},
): Promise<HeadlessGoalResult> {
  const log = deps.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const payload = JSON.parse(await readFile(join(goalDir, HEADLESS_GOAL_FILE), "utf-8")) as {
    run?: unknown;
    provider?: string;
    model?: string;
  };
  const parsed = normalizeGoalRun(payload.run, cwd);
  if (!parsed) throw new Error(`${join(goalDir, HEADLESS_GOAL_FILE)} holds no Goal run`);
  let provider = payload.provider as Provider | undefined;
  let model = payload.model;
  if (!provider || !model) {
    const resolved = await (deps.resolveModel ?? resolveNodeGoalModel)();
    provider ??= resolved.provider;
    model ??= resolved.model;
  }
  const runWorker = deps.runWorker ?? defaultRunWorker;
  const runVerifier = deps.runVerifier ?? ((args) => runGoalVerifierCommand(args));

  // The laptop's fleet placement doesn't apply here: everything runs on this machine.
  const existing = await getGoalRun(cwd, parsed.id);
  if (!existing || existing.projectPath !== parsed.projectPath) {
    await upsertGoalRun(cwd, {
      ...parsed,
      hosted: undefined,
      verifier: parsed.verifier ? { ...parsed.verifier, machine: undefined } : undefined,
      tasks: parsed.tasks.map((task) => ({ ...task, machine: undefined })),
    });
  }
  // After a node restart nothing from the last process is still running.
  await reconcileActiveGoalRuns(cwd, {
    isWorkerActive: () => false,
    isVerifierActive: () => false,
  });

  let summary = "";
  let waits = 0;
  const maxSteps = deps.maxSteps ?? 500;
  for (let step = 0; step < maxSteps; step++) {
    const run = await getGoalRun(cwd, parsed.id);
    if (!run) throw new Error(`Goal ${parsed.id} vanished from the goal store`);
    const decision = decideGoalNextAction(run);
    log(`[goal] ${decision.kind}: ${"reason" in decision ? decision.reason : ""}`);
    if (decision.kind === "create_task") {
      const task = createGoalTask({ title: decision.title, prompt: decision.prompt });
      await upsertGoalRun(cwd, { ...run, status: "ready", tasks: [...run.tasks, task] });
      await appendGoalDecision(cwd, run.id, decision);
      continue;
    }
    if (decision.kind === "start_worker") {
      await updateGoalTask(cwd, run.id, decision.task.id, {
        status: "running",
        attempts: decision.attempts,
        lastSummary: `Worker attempt ${decision.attempts} running.`,
      });
      await upsertGoalRun(cwd, { ...((await getGoalRun(cwd, run.id)) ?? run), status: "running" });
      const status = await runWorker({
        cwd,
        run,
        taskId: decision.task.id,
        title: decision.task.title,
        prompt: decision.task.prompt,
        provider,
        model,
      });
      const after = await getGoalRun(cwd, run.id);
      const task = after?.tasks.find((candidate) => candidate.id === decision.task.id);
      if (after && task && (task.status === "running" || task.status === "verifying")) {
        await updateGoalTask(cwd, run.id, task.id, {
          status: status === "done" ? "done" : "failed",
        });
      }
      if (after?.status === "running") await upsertGoalRun(cwd, { ...after, status: "ready" });
      continue;
    }
    if (decision.kind === "run_verifier") {
      await upsertGoalRun(cwd, { ...run, status: "verifying" });
      const { verification } = await runVerifier({ cwd, runId: run.id, command: decision.command });
      const latest = (await getGoalRun(cwd, run.id)) ?? run;
      await upsertGoalRun(cwd, {
        ...latest,
        status: verification.status === "pass" ? "passed" : "ready",
        verifier: {
          ...(latest.verifier ?? { description: "Goal verifier" }),
          command: verification.command ?? decision.command,
          lastResult: verification,
        },
      });
      await appendGoalEvidence(cwd, run.id, {
        kind: "log",
        label: "Verifier result",
        content: verification.summary,
        ...(verification.outputPath ? { path: verification.outputPath } : {}),
      });
      continue;
    }
    if (decision.kind === "complete") {
      const completion = canCompleteGoalRun(run);
      await upsertGoalRun(cwd, { ...run, status: "passed" });
      summary = completion.ok
        ? "Verifier evidence proves the Goal success criteria."
        : completion.reason;
      break;
    }
    if (decision.kind === "pause" || decision.kind === "blocked") {
      await upsertGoalRun(cwd, {
        ...run,
        status: decision.kind === "pause" ? "paused" : "blocked",
        blockers: [...run.blockers, decision.reason],
      });
      await appendGoalDecision(cwd, run.id, decision);
      summary = decision.reason;
      break;
    }
    if (decision.kind === "terminal") {
      summary = decision.reason;
      break;
    }
    // wait: nothing else runs here, so a wait that persists is a stuck Goal.
    if (++waits > 5) {
      summary = `Goal stuck waiting: ${decision.reason}`;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const final = await getGoalRun(cwd, parsed.id);
  const result: HeadlessGoalResult = {
    runId: parsed.id,
    status: final?.status ?? "failed",
    summary: summary || `Goal stopped after ${maxSteps} steps without finishing.`,
    finishedAt: new Date().toISOString(),
  };
  await writeFile(join(goalDir, HEADLESS_RESULT_FILE), JSON.stringify(result, null, 2));
  log(`[goal] finished: ${result.status} — ${result.summary}`);
  return result;
}
