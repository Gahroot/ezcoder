// `ezcoder goals …`: Goals from a shell, including Goals hosted on fleet nodes.
//   run --headless <goal-dir>   run a Goal's controller with no UI (what a node runs, GL4)
//   status                      Goals of this project; hosted ones are refreshed from their node
//   host <run-id> --on <machine> start a Goal on a fleet node ("auto" or a node name)
//   fetch <run-id>              fetch a hosted Goal's result branch from origin (GL6)
//   stop <run-id>               stop a hosted Goal on its node
import {
  formatHostedGoal,
  fetchHostedGoalResult,
  hostGoalOnNode,
  refreshHostedGoal,
  stopHostedGoal,
  type GoalFleetDeps,
} from "../core/goal-fleet.js";
import { runGoalHeadless, type HeadlessGoalDeps } from "../core/goal-headless.js";
import { getGoalRun, loadGoalRuns, type GoalRun } from "../core/goal-store.js";

const HELP = `ezcoder goals — Goals from a shell

  status                          Goals of this project (hosted ones are checked on their node)
  host <run-id> --on <machine>    run a whole Goal on a fleet node ("auto" or a node name);
                                  it keeps going with this computer closed
        [--provider P] [--model M]
  fetch <run-id>                  fetch a hosted Goal's result branch (ezcoder/goal/<id>) from origin
  stop <run-id>                   stop a hosted Goal on its node
  run --headless <goal-dir>       run the Goal in <goal-dir>/goal.json here with no UI (used by nodes)`;

export interface RunGoalsDeps {
  out?: (line: string) => void;
  cwd?: string;
  fleet?: GoalFleetDeps;
  headless?: HeadlessGoalDeps;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}

function line(run: GoalRun, hostedError?: string): string {
  const tasks = run.tasks.length
    ? `${run.tasks.filter((task) => task.status === "done").length}/${run.tasks.length} tasks done`
    : "no tasks";
  const base = `[${run.status}] ${run.title} (id: ${run.id.slice(0, 8)}) — ${tasks}`;
  return run.hosted ? `${base}\n    hosted ${formatHostedGoal(run.hosted, hostedError)}` : base;
}

async function requireRun(cwd: string, id: string | undefined): Promise<GoalRun> {
  if (!id) throw new Error("A Goal run id is required (see `ezcoder goals status`).");
  const run = await getGoalRun(cwd, id);
  if (!run) throw new Error(`No goal found matching id "${id}".`);
  return run;
}

/** Goals status lines; hosted Goals are refreshed from their node first (GL4). */
export async function goalsStatusLines(cwd: string, deps: GoalFleetDeps = {}): Promise<string[]> {
  const runs = await loadGoalRuns(cwd);
  const lines: string[] = [];
  for (const run of runs) {
    if (!run.hosted) {
      lines.push(line(run));
      continue;
    }
    const refreshed = await refreshHostedGoal(cwd, run, deps);
    lines.push(line(refreshed.run, refreshed.error));
  }
  return lines;
}

export async function runGoals(
  argv: string[] = process.argv.slice(2),
  deps: RunGoalsDeps = {},
): Promise<void> {
  const args = [...argv];
  const action = args.shift();
  const cwd = deps.cwd ?? process.cwd();
  const out = deps.out ?? ((s: string) => process.stdout.write(s + "\n"));
  switch (action) {
    case "run": {
      const headless = args.indexOf("--headless");
      if (headless < 0) throw new Error("Only `goals run --headless <goal-dir>` is supported.");
      args.splice(headless, 1);
      const goalDir = args.shift();
      if (!goalDir) throw new Error("Usage: ezcoder goals run --headless <goal-dir>");
      const result = await runGoalHeadless(goalDir, cwd, { log: out, ...deps.headless });
      if (result.status !== "passed") process.exitCode = 1;
      return;
    }
    case "status": {
      const lines = await goalsStatusLines(cwd, deps.fleet);
      out(lines.length ? lines.join("\n") : "No goals.");
      return;
    }
    case "host": {
      const machine = flag(args, "--on") ?? "auto";
      const provider = flag(args, "--provider");
      const model = flag(args, "--model");
      const run = await requireRun(cwd, args.shift());
      const hosted = await hostGoalOnNode({
        cwd,
        run,
        machine,
        ...(provider && { provider }),
        ...(model && { model }),
        ...(deps.fleet && { deps: deps.fleet }),
      });
      out(hosted.message);
      return;
    }
    case "fetch": {
      const run = await requireRun(cwd, args.shift());
      if (run.hosted && !run.hosted.resultBranch) await refreshHostedGoal(cwd, run, deps.fleet);
      out(await fetchHostedGoalResult(cwd, run.id));
      return;
    }
    case "stop": {
      const run = await requireRun(cwd, args.shift());
      if (!run.hosted) throw new Error(`Goal "${run.title}" is not hosted on a fleet node.`);
      const stopped = await stopHostedGoal(cwd, run, deps.fleet);
      out(`Goal "${stopped.title}" on ${stopped.hosted?.node}: ${stopped.hosted?.state}.`);
      return;
    }
    default:
      out(HELP);
  }
}
