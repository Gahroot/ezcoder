// Goals on the fleet, controller side (PRD section 9): pick and vet the node a
// Goal's work runs on (S3 protocol check, GL5 prerequisites checked on that
// node), run the verifier as a fleet job at the exact commit (GL2), and start,
// watch, stop and fetch whole Goals hosted on a node (GL4/GL6).
//
// Talks to nodes with plain fetch over the paired-node list that remote agents
// use (remote-agent-nodes.ts), so it doesn't depend on the fleet client.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FLEET_MIN_PROTOCOL,
  FLEET_PROTOCOL,
  PROTOCOL_HEADER,
  VERSION_HEADER,
  type DoctorReport,
  type ErrorResponse,
  type GoalHostRequest,
  type GoalHostStatus,
  type JobRequest,
  type JobStatus,
  type NodeInfo,
  type SourceSpec,
} from "./fleet/protocol.js";
import {
  agentNodeProblem,
  nodeHeaders,
  nodeUrl,
  probeNode,
  readFleetNodes,
  type FleetNodeEntry,
} from "./fleet/remote-agent-nodes.js";
import { prepareRemoteSource, type PreparedRemoteSource } from "./fleet/remote-agent.js";
import { cliVersion } from "./fleet/node/info.js";
import { validateGoalPrerequisiteCheckCommand } from "./goal-prerequisites.js";
import {
  getGoalRun,
  projectDir,
  upsertGoalRun,
  type GoalHostedInfo,
  type GoalRun,
  type GoalVerificationResult,
} from "./goal-store.js";
import type { RunGoalVerifierResult } from "./goal-verifier.js";

export interface GoalFleetDeps {
  /** Paired nodes file (tests); default ~/.ezcoder/fleet/nodes.json. */
  nodesFile?: string;
  /** GET /v1/info override (tests). */
  probe?: (node: FleetNodeEntry) => Promise<NodeInfo | undefined>;
  /** Poll interval for fleet jobs (default 2 s). */
  pollMs?: number;
}

export class GoalFleetError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = "GoalFleetError";
  }
}

const TERMINAL_JOB_STATES = new Set<JobStatus["state"]>([
  "passed",
  "failed",
  "error",
  "cancelled",
  "lost",
]);

/** JSON request to a node with the S3 protocol headers. */
export async function nodeRequest<T>(
  node: FleetNodeEntry,
  method: string,
  route: string,
  options: { body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(nodeUrl(node, route), {
      method,
      headers: {
        ...nodeHeaders(node),
        [PROTOCOL_HEADER]: String(FLEET_PROTOCOL),
        [VERSION_HEADER]: cliVersion(),
        ...(options.body !== undefined && { "content-type": "application/json" }),
      },
      ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
  } catch (error) {
    throw new GoalFleetError(
      `Machine "${node.name}" is unreachable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const body = parsed as ErrorResponse | undefined;
    if (body?.code === "protocol_mismatch") {
      throw new GoalFleetError(protocolMismatchText(node.name, body), res.status);
    }
    const reason = (typeof body === "object" && body?.error) || `HTTP ${res.status}`;
    throw new GoalFleetError(`Machine "${node.name}": ${reason}`, res.status);
  }
  return parsed as T;
}

function protocolMismatchText(name: string, body: ErrorResponse): string {
  return body.update === "controller"
    ? `Machine "${name}" speaks a newer fleet protocol (${body.nodeProtocol ?? "?"}) than this EZ Coder (${FLEET_PROTOCOL}). Update EZ Coder on this computer.`
    : `Machine "${name}" speaks an older fleet protocol (${body.nodeProtocol ?? "?"}) than this EZ Coder (${FLEET_PROTOCOL}). Update the node: run \`ezcoder node update\` there.`;
}

/**
 * S3 for Goals: why this node's protocol can't take Goal work from us, or
 * undefined when it can. Checked before any work is sent, never mid-run.
 */
export function goalNodeProtocolProblem(
  name: string,
  info: Pick<NodeInfo, "protocol" | "minProtocol" | "version"> | undefined,
): string | undefined {
  if (!info) return undefined;
  const protocol = typeof info.protocol === "number" ? info.protocol : 1;
  if (protocol < FLEET_MIN_PROTOCOL) {
    return (
      `Machine "${name}" runs EZ Coder ${info.version ?? "(unknown version)"} with fleet protocol ${protocol}; ` +
      `this EZ Coder needs ${FLEET_MIN_PROTOCOL}–${FLEET_PROTOCOL}. Update the node: run \`ezcoder node update\` there.`
    );
  }
  if ((info.minProtocol ?? protocol) > FLEET_PROTOCOL) {
    return (
      `Machine "${name}" needs fleet protocol ${info.minProtocol ?? protocol} or newer; ` +
      `this EZ Coder speaks ${FLEET_PROTOCOL}. Update EZ Coder on this computer.`
    );
  }
  return undefined;
}

export type GoalNodePurpose = "worker" | "job";

function nodeProblem(
  purpose: GoalNodePurpose,
  node: FleetNodeEntry,
  info: NodeInfo | undefined,
): string | undefined {
  if (!info) return "unreachable";
  const protocol = goalNodeProtocolProblem(node.name, info);
  if (protocol) return protocol;
  if (info.dockerOnly) return "it only takes Docker work (`node serve --docker-only`)";
  if (purpose === "worker") return agentNodeProblem({ node, info });
  if (info.slotsUsed >= info.slots) return `full (${info.slotsUsed}/${info.slots} slots)`;
  return undefined;
}

export interface ResolvedGoalNode {
  node: FleetNodeEntry;
  info: NodeInfo;
}

/**
 * Resolve a Goal `machine` ("auto" or a node name) to a node that can take
 * the work now, refusing incompatible protocols up front (S3).
 */
export async function resolveGoalNode(
  machine: string,
  purpose: GoalNodePurpose,
  deps: GoalFleetDeps = {},
): Promise<ResolvedGoalNode> {
  const nodes = await readFleetNodes(deps.nodesFile);
  if (nodes.length === 0) {
    throw new GoalFleetError(
      "No fleet nodes are paired. Pair one with `ezcoder fleet add`, or leave machine unset to run on this computer.",
    );
  }
  const probe = deps.probe ?? ((node: FleetNodeEntry) => probeNode(node));
  const what = purpose === "worker" ? "a Goal worker" : "a Goal job";
  if (machine !== "auto") {
    const node = nodes.find((candidate) => candidate.name === machine);
    if (!node) {
      throw new GoalFleetError(
        `Unknown machine "${machine}". Paired: ${nodes.map((n) => n.name).join(", ")} (or "auto").`,
      );
    }
    const info = await probe(node);
    const problem = nodeProblem(purpose, node, info);
    if (problem) throw new GoalFleetError(`Machine "${machine}" can't run ${what} now: ${problem}`);
    return { node, info: info! };
  }
  const probed = await Promise.all(nodes.map(async (node) => ({ node, info: await probe(node) })));
  const usable = probed
    .filter((p) => nodeProblem(purpose, p.node, p.info) === undefined)
    .sort(
      (a, b) =>
        a.info!.load - b.info!.load ||
        b.info!.slots - b.info!.slotsUsed - (a.info!.slots - a.info!.slotsUsed) ||
        a.node.name.localeCompare(b.node.name),
    );
  const picked = usable[0];
  if (!picked) {
    const reasons = probed
      .map((p) => `${p.node.name}: ${nodeProblem(purpose, p.node, p.info)}`)
      .join("; ");
    throw new GoalFleetError(`No paired machine can run ${what} now (${reasons}).`);
  }
  return { node: picked.node, info: picked.info! };
}

/** GET /v1/doctor; undefined when the node predates it (404). */
export async function nodeDoctor(
  node: FleetNodeEntry,
  repo: string | undefined,
): Promise<DoctorReport | undefined> {
  try {
    return await nodeRequest<DoctorReport>(
      node,
      "GET",
      `/v1/doctor${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`,
      { timeoutMs: 60_000 },
    );
  } catch (error) {
    if (error instanceof GoalFleetError && error.status === 404) return undefined;
    throw error;
  }
}

export interface GoalNodeCheck {
  ok: boolean;
  /** One line each, naming the node and what to fix. */
  problems: string[];
  /** Things that were not checked, and why. */
  notes: string[];
}

/**
 * GL5: check what a Goal needs on the machine that will run it: model login
 * (for workers), git access to the repo, the node's version, and each
 * prerequisite's check command (run there as a fleet job at the exact commit).
 */
export async function checkGoalPrerequisitesOnNode(args: {
  node: FleetNodeEntry;
  info: NodeInfo;
  run: GoalRun;
  source: SourceSpec;
  project: string;
  /** Workers and hosted Goals need the node's own model login; a verifier job doesn't. */
  needsModel: boolean;
  deps?: GoalFleetDeps;
}): Promise<GoalNodeCheck> {
  const { node, info, run } = args;
  const problems: string[] = [];
  const notes: string[] = [];
  const doctor = await nodeDoctor(node, args.source.git).catch((error: unknown) => {
    problems.push(error instanceof Error ? error.message : String(error));
    return undefined;
  });
  const wanted = new Set(["git", "version", "disk", ...(args.needsModel ? ["model_login"] : [])]);
  if (doctor) {
    for (const check of doctor.checks) {
      if (check.status !== "fail" || !wanted.has(check.id)) continue;
      problems.push(`${node.name}: ${check.detail}${check.fix ? ` Fix: ${check.fix}` : ""}`.trim());
    }
  } else {
    if (args.needsModel && !info.modelAuth) {
      problems.push(
        `${node.name}: no model login. Fix: run \`ezcoder login\` on ${node.name}, or \`ezcoder fleet share-auth ${node.name}\`.`,
      );
    }
    notes.push(
      `${node.name} has no doctor (older EZ Coder), so git access was not checked up front.`,
    );
  }
  for (const prerequisite of run.prerequisites) {
    if (!prerequisite.checkCommand) continue;
    const safety = validateGoalPrerequisiteCheckCommand(prerequisite.checkCommand);
    if (!safety.safe) {
      problems.push(
        `${node.name}: prerequisite "${prerequisite.label}" check refused as unsafe (${safety.reason}).`,
      );
      continue;
    }
    try {
      const { status, log } = await runFleetJob(
        node,
        {
          id: `goal-prereq-${run.id.slice(0, 8)}-${randomBytes(3).toString("hex")}`,
          kind: "custom",
          project: args.project,
          source: args.source,
          command: prerequisite.checkCommand,
          timeoutMinutes: 2,
        },
        { ...args.deps, timeoutMs: 3 * 60_000 },
      );
      if (status.state !== "passed") {
        const tail = log.trim().split("\n").slice(-3).join(" ").slice(0, 300);
        problems.push(
          `${node.name}: prerequisite "${prerequisite.label}" is missing there: \`${prerequisite.checkCommand}\` ${status.state}${status.exitCode !== undefined ? ` (exit ${status.exitCode})` : ""}${tail ? `: ${tail}` : ""}`,
        );
      }
    } catch (error) {
      problems.push(
        `${node.name}: could not check prerequisite "${prerequisite.label}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { ok: problems.length === 0, problems, notes };
}

/** Submit a job and wait for it to end; returns the final status and its log. */
export async function runFleetJob(
  node: FleetNodeEntry,
  request: JobRequest,
  options: GoalFleetDeps & { timeoutMs?: number } = {},
): Promise<{ status: JobStatus; log: string }> {
  let status = await nodeRequest<JobStatus>(node, "POST", "/v1/jobs", {
    body: request,
    timeoutMs: 120_000,
  });
  const deadline = Date.now() + (options.timeoutMs ?? (request.timeoutMinutes + 2) * 60_000);
  const pollMs = options.pollMs ?? 2_000;
  while (!TERMINAL_JOB_STATES.has(status.state)) {
    if (Date.now() > deadline) {
      await nodeRequest(node, "DELETE", `/v1/jobs/${encodeURIComponent(request.id)}`).catch(
        () => undefined,
      );
      throw new GoalFleetError(
        `Job ${request.id} on ${node.name} did not finish in time and was cancelled.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    status = await nodeRequest<JobStatus>(
      node,
      "GET",
      `/v1/jobs/${encodeURIComponent(request.id)}`,
    );
  }
  const log = await fetch(
    nodeUrl(node, `/v1/jobs/${encodeURIComponent(request.id)}/log?tail=400`),
    { headers: nodeHeaders(node), signal: AbortSignal.timeout(60_000) },
  )
    .then((res) => (res.ok ? res.text() : ""))
    .catch(() => "");
  return { status, log };
}

const MAX_VERIFIER_OUTPUT_CHARS = 20_000;

/** How the code reached the node, in words (GL2: clean commit or commit + patch). */
export function describeCheckout(prepared: Pick<PreparedRemoteSource, "source" | "patch">): string {
  const sha = prepared.source.sha.slice(0, 12);
  return prepared.patch.length > 0
    ? `commit ${sha} plus this computer's uncommitted changes sent as a patch (${prepared.patch.length} bytes); not a clean commit`
    : `clean commit ${sha}`;
}

/**
 * GL2: run the Goal verifier as a fleet job at the exact local commit. The
 * node clones that commit itself; uncommitted work travels as a patch and the
 * evidence says so. The evidence is the job's log.
 */
export async function runGoalVerifierOnFleet(options: {
  cwd: string;
  runId: string;
  command: string;
  machine: string;
  timeoutMs?: number;
  deps?: GoalFleetDeps;
}): Promise<RunGoalVerifierResult> {
  const startedAt = Date.now();
  const logDir = join(projectDir(options.cwd), "verifiers");
  await mkdir(logDir, { recursive: true });
  const outputPath = join(logDir, `${options.runId}-${startedAt}-fleet.log`);
  const finish = async (
    status: "pass" | "fail",
    failureClass: RunGoalVerifierResult["failureClass"],
    summary: string,
    exitCode: number,
  ): Promise<RunGoalVerifierResult> => {
    await writeFile(outputPath, summary + "\n", "utf-8");
    const verification: GoalVerificationResult = {
      status,
      summary,
      command: options.command,
      exitCode,
      outputPath,
      checkedAt: new Date().toISOString(),
    };
    return { verification, failureClass, durationMs: Math.max(0, Date.now() - startedAt) };
  };
  let prepared: PreparedRemoteSource;
  let resolved: ResolvedGoalNode;
  try {
    prepared = await prepareRemoteSource(options.cwd);
    resolved = await resolveGoalNode(options.machine, "job", options.deps);
  } catch (error) {
    return finish(
      "fail",
      "verifier_spawn_error",
      `Fleet verifier did not start: ${error instanceof Error ? error.message : String(error)}`,
      1,
    );
  }
  const checkout = describeCheckout(prepared);
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  try {
    const { status, log } = await runFleetJob(
      resolved.node,
      {
        id: `goal-verify-${options.runId.slice(0, 8)}-${randomBytes(3).toString("hex")}`,
        kind: "test",
        project: prepared.project,
        source: prepared.source,
        command: options.command,
        timeoutMinutes: Math.max(1, Math.ceil(timeoutMs / 60_000)),
      },
      { ...options.deps, timeoutMs: timeoutMs + 2 * 60_000 },
    );
    const passed = status.state === "passed";
    const exitCode = status.exitCode ?? (passed ? 0 : 1);
    const header = `Fleet verifier on ${resolved.node.name} (job ${status.id}) at ${checkout}: ${status.state}, exit ${exitCode}.`;
    const body =
      log.length > MAX_VERIFIER_OUTPUT_CHARS ? log.slice(-MAX_VERIFIER_OUTPUT_CHARS) : log;
    return finish(
      passed ? "pass" : "fail",
      passed
        ? "verifier_pass"
        : status.state === "failed"
          ? "verifier_failure"
          : "verifier_spawn_error",
      `${header}\n${body.trim()}`.trim(),
      exitCode,
    );
  } catch (error) {
    return finish(
      "fail",
      /did not finish in time/.test(String(error)) ? "verifier_timeout" : "verifier_spawn_error",
      `Fleet verifier on ${resolved.node.name} at ${checkout} failed: ${error instanceof Error ? error.message : String(error)}`,
      124,
    );
  }
}

// ---- GL4/GL6: whole Goals hosted on a node ----

/** What a node needs to run a Goal headless (GoalHostRequest.goal). */
export interface HostedGoalPayload {
  run: GoalRun;
  provider?: string;
  model?: string;
}

export function goalResultBranch(hostId: string): string {
  return `ezcoder/goal/${hostId}`;
}

function hostedFromStatus(node: string, status: GoalHostStatus): GoalHostedInfo {
  return {
    node,
    hostId: status.id,
    state: status.state,
    ...(status.summary ? { summary: status.summary } : {}),
    ...(status.resultBranch ? { resultBranch: status.resultBranch } : {}),
    ...(status.resultSha ? { resultSha: status.resultSha } : {}),
    startedAt: status.startedAt,
    ...(status.finishedAt ? { finishedAt: status.finishedAt } : {}),
    checkedAt: new Date().toISOString(),
  };
}

/**
 * GL4: start a whole Goal on a node. The node clones the exact commit (plus a
 * patch of uncommitted work), runs the Goal controller headless there, and on
 * finish pushes `ezcoder/goal/<id>` to origin with its own credentials.
 */
export async function hostGoalOnNode(options: {
  cwd: string;
  run: GoalRun;
  machine: string;
  provider?: string;
  model?: string;
  deps?: GoalFleetDeps;
}): Promise<{ run: GoalRun; message: string }> {
  const { run } = options;
  if (run.hosted && (run.hosted.state === "running" || run.hosted.state === "preparing")) {
    throw new GoalFleetError(
      `Goal "${run.title}" already runs on ${run.hosted.node}. Check it with goals status, or stop it first.`,
    );
  }
  const prepared = await prepareRemoteSource(options.cwd);
  const { node, info } = await resolveGoalNode(options.machine, "worker", options.deps);
  const check = await checkGoalPrerequisitesOnNode({
    node,
    info,
    run,
    source: prepared.source,
    project: prepared.project,
    needsModel: true,
    deps: options.deps,
  });
  if (!check.ok) {
    throw new GoalFleetError(
      `Goal "${run.title}" can't run on ${node.name}: ${check.problems.join("; ")}`,
    );
  }
  const hostId = run.id;
  const payload: HostedGoalPayload = {
    run: { ...run, hosted: undefined },
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.model ? { model: options.model } : {}),
  };
  const request: GoalHostRequest = {
    id: hostId,
    project: prepared.project,
    source: prepared.source,
    goal: payload,
    resultBranch: goalResultBranch(hostId),
  };
  let status: GoalHostStatus;
  try {
    status = await nodeRequest<GoalHostStatus>(node, "POST", "/v1/goals", {
      body: request,
      timeoutMs: 15 * 60_000,
    });
  } catch (error) {
    if (error instanceof GoalFleetError && error.status === 404) {
      throw new GoalFleetError(
        `Machine "${node.name}" can't host Goals (its EZ Coder predates hosted Goals). Update the node: run \`ezcoder node update\` there.`,
        404,
      );
    }
    throw error;
  }
  const updated = await upsertGoalRun(options.cwd, {
    ...run,
    hosted: hostedFromStatus(node.name, status),
  });
  const notes = check.notes.length ? ` ${check.notes.join(" ")}` : "";
  return {
    run: updated,
    message:
      `Goal "${run.title}" now runs on ${node.name} from ${describeCheckout(prepared)}. ` +
      `It keeps going with this computer closed; when it finishes, ${node.name} pushes ${goalResultBranch(hostId)} to origin.${notes}`,
  };
}

async function hostedNode(run: GoalRun, deps: GoalFleetDeps): Promise<FleetNodeEntry> {
  const nodes = await readFleetNodes(deps.nodesFile);
  const node = nodes.find((candidate) => candidate.name === run.hosted?.node);
  if (!node) throw new GoalFleetError(`Machine "${run.hosted?.node}" is no longer paired.`);
  return node;
}

/** GL4: refresh a hosted Goal's state from its node into the goal store. */
export async function refreshHostedGoal(
  cwd: string,
  run: GoalRun,
  deps: GoalFleetDeps = {},
): Promise<{ run: GoalRun; error?: string }> {
  if (!run.hosted) return { run };
  try {
    const node = await hostedNode(run, deps);
    const status = await nodeRequest<GoalHostStatus>(
      node,
      "GET",
      `/v1/goals/${encodeURIComponent(run.hosted.hostId)}`,
      { timeoutMs: 8_000 },
    );
    const hosted = hostedFromStatus(node.name, status);
    const updated = await upsertGoalRun(cwd, { ...run, hosted });
    return { run: updated };
  } catch (error) {
    return { run, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Stop a hosted Goal on its node. */
export async function stopHostedGoal(
  cwd: string,
  run: GoalRun,
  deps: GoalFleetDeps = {},
): Promise<GoalRun> {
  if (!run.hosted) return run;
  const node = await hostedNode(run, deps);
  const status = await nodeRequest<GoalHostStatus>(
    node,
    "DELETE",
    `/v1/goals/${encodeURIComponent(run.hosted.hostId)}`,
  );
  return upsertGoalRun(cwd, { ...run, hosted: hostedFromStatus(node.name, status) });
}

/** One line for `goals status` about a hosted Goal. */
export function formatHostedGoal(hosted: GoalHostedInfo, error?: string): string {
  const parts = [`on ${hosted.node}: ${hosted.state}`];
  if (hosted.summary) parts.push(hosted.summary.split("\n")[0]!.slice(0, 200));
  if (hosted.resultBranch) {
    parts.push(
      `result branch ${hosted.resultBranch}${hosted.resultSha ? ` @ ${hosted.resultSha.slice(0, 12)}` : ""} on origin (fetch: git fetch origin ${hosted.resultBranch})`,
    );
  }
  if (error) parts.push(`last check failed: ${error}`);
  return parts.join(" — ");
}

/** GL6: fetch a hosted Goal's result branch from origin into the local repo. */
export async function fetchHostedGoalResult(cwd: string, runId: string): Promise<string> {
  const run = await getGoalRun(cwd, runId);
  const branch = run?.hosted?.resultBranch;
  if (!run?.hosted || !branch) {
    throw new GoalFleetError(
      run?.hosted
        ? `Goal "${run.title}" on ${run.hosted.node} has no result branch yet (${run.hosted.state}).`
        : "This Goal is not hosted on a fleet node.",
    );
  }
  const result = await new Promise<{ code: number; out: string }>((resolve) => {
    const child = spawn(
      "git",
      ["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
      {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (out += c.toString()));
    child.on("error", (error) => resolve({ code: 1, out: error.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
  if (result.code !== 0) {
    throw new GoalFleetError(`git fetch of ${branch} failed: ${result.out.trim().slice(-500)}`);
  }
  return (
    `Fetched ${branch}${run.hosted.resultSha ? ` (${run.hosted.resultSha.slice(0, 12)})` : ""} from origin as origin/${branch}. ` +
    `Review: git log --stat HEAD..origin/${branch}; merge: git merge origin/${branch}`
  );
}
