// GL4/GL6: whole Goals hosted on this node (feature "goals").
//
// POST /v1/goals prepares a workspace at the exact commit (+ patch), then runs
// `ezcoder goals run --headless <goal-dir>` there. The run outlives controller
// disconnects; its record is kept in <dataDir>/goals/hosted.json and re-adopted
// after a node restart (a process that died with the node becomes "lost", its
// workspace kept). When the run ends the node commits the workspace and pushes
// `ezcoder/goal/<id>` to origin with its own git credentials, so the result
// never depends on the laptop being awake.
import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import type { GoalHostRequest, GoalHostStatus } from "../protocol.js";
import { killProcessTree } from "../../../utils/process.js";
import { writeFileAtomic } from "./config.js";
import type { NodeContext, NodeRouteModule } from "./context.js";
import { allowedBaseEnv } from "./env.js";
import { isSafeId, pidAlive } from "./exec.js";
import { GIT_ALLOWED_PROTOCOLS } from "./workspace.js";

/** Marks the module so the server can advertise the "goals" feature. */
export const GOAL_HOST_FEATURE = "goals";

export interface GoalHostRecord extends GoalHostStatus {
  /** Workspace (repo root) on the node. */
  cwd: string;
  /** Holds goal.json, result.json, the goal store and run.log. */
  goalDir: string;
  base: string;
  pid?: number;
  resultBranch: string;
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GoalGit = (
  cwd: string,
  args: string[],
  env?: Record<string, string>,
) => Promise<GitResult>;

export interface HeadlessProcess {
  pid?: number;
  /** Resolves with the exit code when the process ends. */
  exited: Promise<number | null>;
}

export interface GoalHostOptions {
  /** Start the headless Goal run (tests); default spawns the node's CLI. */
  spawnHeadless?: (args: {
    ctx: NodeContext;
    goalDir: string;
    cwd: string;
    logFile: string;
    env: Record<string, string>;
  }) => HeadlessProcess;
  /** git runner (tests); default the node's git with its own credentials. */
  git?: GoalGit;
  /** How often adopted runs (no child handle) are checked, ms (default 5 s). */
  adoptPollMs?: number;
}

const MAX_LOG_TAIL = 5_000;

/** True for the module that serves /v1/goals (the server advertises "goals" for it). */
export function isGoalHostModule(module: NodeRouteModule): boolean {
  return (module as { feature?: string }).feature === GOAL_HOST_FEATURE;
}

function defaultGit(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = nodeSpawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ALLOW_PROTOCOL: GIT_ALLOWED_PROTOCOLS,
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: error.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function defaultSpawnHeadless(args: {
  ctx: NodeContext;
  goalDir: string;
  cwd: string;
  logFile: string;
  env: Record<string, string>;
}): HeadlessProcess {
  const out = fs.openSync(args.logFile, "a");
  const child = nodeSpawn(
    process.execPath,
    [args.ctx.cliEntry(), "goals", "run", "--headless", args.goalDir],
    {
      cwd: args.cwd,
      stdio: ["ignore", out, out],
      env: { ...allowedBaseEnv(process.env), ...args.env },
      // Its own process group: it keeps running if the node server restarts.
      detached: process.platform !== "win32",
      windowsHide: true,
    },
  );
  fs.closeSync(out);
  child.unref();
  const exited = new Promise<number | null>((resolve) => {
    child.on("error", () => resolve(1));
    child.on("exit", (code) => resolve(code));
  });
  return { pid: child.pid, exited };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 80 * 1024 * 1024) throw new Error("request too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function status(record: GoalHostRecord): GoalHostStatus {
  return {
    id: record.id,
    project: record.project,
    state: record.state,
    ...(record.summary && { summary: record.summary }),
    ...(record.resultSha && { resultBranch: record.resultBranch, resultSha: record.resultSha }),
    startedAt: record.startedAt,
    ...(record.finishedAt && { finishedAt: record.finishedAt }),
  };
}

function tail(file: string, lines: number): string {
  try {
    const stat = fs.statSync(file);
    const bytes = Math.min(stat.size, 4 * 1024 * 1024);
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(bytes);
    fs.readSync(fd, buf, 0, bytes, stat.size - bytes);
    fs.closeSync(fd);
    return buf
      .toString("utf8")
      .split("\n")
      .slice(-lines - 1)
      .join("\n");
  } catch {
    return "";
  }
}

const VALID_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;

export function createGoalHostRouteModule(options: GoalHostOptions = {}): NodeRouteModule & {
  feature: typeof GOAL_HOST_FEATURE;
} {
  const goals = new Map<string, GoalHostRecord>();
  const timers = new Set<NodeJS.Timeout>();
  const finishing = new Set<string>();
  const git = options.git ?? defaultGit;
  const spawnHeadless = options.spawnHeadless ?? defaultSpawnHeadless;
  let stateFile: string | undefined;

  const persist = () => {
    if (!stateFile) return;
    writeFileAtomic(stateFile, JSON.stringify({ version: 1, goals: [...goals.values()] }, null, 2));
  };
  const owner = (id: string) => `goal:${id}`;
  const logFile = (record: GoalHostRecord) => path.join(record.goalDir, "run.log");
  const appendLog = (record: GoalHostRecord, line: string) => {
    try {
      fs.appendFileSync(logFile(record), `[node] ${line}\n`);
    } catch {
      // the goal folder is gone; the state still says what happened
    }
  };

  /** GL6: commit what the run left and push it as the result branch. */
  async function pushResult(record: GoalHostRecord): Promise<string | undefined> {
    const cwd = record.cwd;
    const identity = await git(cwd, ["config", "user.email"]);
    const env: Record<string, string> =
      identity.code === 0 && identity.stdout.trim()
        ? {}
        : {
            GIT_AUTHOR_NAME: "EZ Coder",
            GIT_AUTHOR_EMAIL: "ezcoder@localhost",
            GIT_COMMITTER_NAME: "EZ Coder",
            GIT_COMMITTER_EMAIL: "ezcoder@localhost",
          };
    const steps: string[][] = [
      ["checkout", "-B", record.resultBranch],
      ["add", "-A"],
    ];
    for (const args of steps) {
      const r = await git(cwd, args, env);
      if (r.code !== 0) return `git ${args[0]} failed: ${r.stderr.trim().slice(-300)}`;
    }
    const staged = await git(cwd, ["diff", "--cached", "--quiet"], env);
    if (staged.code !== 0) {
      const commit = await git(
        cwd,
        [
          "commit",
          "-q",
          "--no-verify",
          "-m",
          `EZ Coder Goal ${record.id}: ${record.summary ?? record.state}`,
        ],
        env,
      );
      if (commit.code !== 0) return `git commit failed: ${commit.stderr.trim().slice(-300)}`;
    }
    const push = await git(
      cwd,
      ["push", "--force", "origin", `HEAD:refs/heads/${record.resultBranch}`],
      env,
    );
    if (push.code !== 0) return `git push failed: ${push.stderr.trim().slice(-300)}`;
    const sha = await git(cwd, ["rev-parse", "HEAD"], env);
    if (sha.code !== 0) return `git rev-parse failed: ${sha.stderr.trim().slice(-300)}`;
    record.resultSha = sha.stdout.trim();
    return undefined;
  }

  /** The headless run ended (or was found ended): read its result, push, release the slot. */
  async function finish(ctx: NodeContext, record: GoalHostRecord, exitCode: number | null) {
    if (record.state !== "running") return;
    let result: { status?: string; summary?: string } | undefined;
    try {
      result = JSON.parse(fs.readFileSync(path.join(record.goalDir, "result.json"), "utf8")) as {
        status?: string;
        summary?: string;
      };
    } catch {
      result = undefined;
    }
    if (finishing.has(record.id)) return;
    finishing.add(record.id);
    record.pid = undefined;
    let summary = result
      ? `Goal ${result.status}: ${result.summary ?? ""}`.trim()
      : `The Goal run exited (code ${exitCode ?? "unknown"}) without a result; see the log.`;
    record.summary = summary;
    // R2: push whatever it produced, passed or not, so nothing is stranded here.
    // The state stays "running" until the push is done, so a poll never sees a
    // finished Goal without its result branch.
    const pushError = await pushResult(record);
    if (pushError) {
      summary = `${summary} Could not push ${record.resultBranch}: ${pushError}. The workspace is kept at ${record.cwd}.`;
    }
    finishing.delete(record.id);
    if (record.state !== "running") return; // stopped meanwhile
    record.summary = summary;
    record.state = !pushError && result?.status === "passed" ? "done" : "failed";
    record.finishedAt = new Date().toISOString();
    appendLog(record, `finished: ${record.state} — ${record.summary}`);
    ctx.releaseSlot(owner(record.id));
    persist();
    ctx.log(`goal ${record.id}: ${record.state}`);
  }

  function watch(ctx: NodeContext, record: GoalHostRecord, proc?: HeadlessProcess) {
    if (proc) {
      void proc.exited.then((code) => finish(ctx, record, code));
      return;
    }
    // Adopted after a restart: no child handle, so poll the pid.
    const timer = setInterval(() => {
      if (pidAlive(record.pid)) return;
      clearInterval(timer);
      timers.delete(timer);
      void finish(ctx, record, null);
    }, options.adoptPollMs ?? 5_000);
    timer.unref?.();
    timers.add(timer);
  }

  async function launch(ctx: NodeContext, record: GoalHostRecord, req: GoalHostRequest) {
    try {
      const cwd = path.resolve(
        await ctx.prepareWorkspace("agent", `goal-${record.id}`, req.source),
      );
      if (record.state !== "preparing") return; // stopped meanwhile
      record.cwd = cwd;
      fs.mkdirSync(record.goalDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(record.goalDir, "goal.json"), JSON.stringify(req.goal ?? {}));
      const proc = spawnHeadless({
        ctx,
        goalDir: record.goalDir,
        cwd,
        logFile: logFile(record),
        env: { EZ_GOALS_BASE: path.join(record.goalDir, "store") },
      });
      record.pid = proc.pid;
      record.state = "running";
      persist();
      watch(ctx, record, proc);
    } catch (error) {
      record.state = "failed";
      record.summary = `Could not prepare the Goal workspace: ${error instanceof Error ? error.message : String(error)}`;
      record.finishedAt = new Date().toISOString();
      ctx.releaseSlot(owner(record.id));
      persist();
    }
  }

  return {
    feature: GOAL_HOST_FEATURE,

    /** Re-adopt hosted Goals from the previous node process. */
    init(ctx) {
      stateFile = path.join(ctx.config.dataDir, "goals", "hosted.json");
      fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
      let records: GoalHostRecord[] = [];
      try {
        const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
          goals?: GoalHostRecord[];
        };
        records = Array.isArray(parsed.goals) ? parsed.goals : [];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          try {
            fs.renameSync(stateFile, `${stateFile}.corrupt-${Date.now()}`);
          } catch {
            // the next save replaces it
          }
        }
      }
      const rebooted = ctx.state?.rebooted() ?? true;
      for (const record of records) {
        if (!isSafeId(record.id) || goals.has(record.id)) continue;
        goals.set(record.id, record);
        if (record.state !== "running" && record.state !== "preparing") continue;
        const alive = record.state === "running" && !rebooted && pidAlive(record.pid);
        if (alive) {
          ctx.acquireSlot(owner(record.id), true);
          watch(ctx, record);
          ctx.log(`goal ${record.id}: re-adopted (running)`);
          continue;
        }
        const finished = fs.existsSync(path.join(record.goalDir, "result.json"));
        if (finished && record.state === "running") {
          // It ended while the node was down: push its result now.
          ctx.acquireSlot(owner(record.id), true);
          void finish(ctx, record, null);
          continue;
        }
        record.state = "lost";
        record.pid = undefined;
        record.finishedAt = new Date().toISOString();
        record.summary = `The node restarted while the Goal ran and could not re-adopt it; its workspace is kept at ${record.cwd || record.goalDir}.`;
        appendLog(record, record.summary);
      }
      persist();
    },

    activeCount() {
      return [...goals.values()].filter((g) => g.state === "running" || g.state === "preparing")
        .length;
    },

    async close() {
      // The runs keep going without the server; only stop watching.
      for (const timer of timers) clearInterval(timer);
      timers.clear();
    },

    async handle(ctx, req, res, url) {
      const p = url.pathname;
      if (p === "/v1/goals" && req.method === "GET") {
        ctx.json(res, 200, [...goals.values()].map(status));
        return true;
      }
      if (p === "/v1/goals" && req.method === "POST") {
        let body: GoalHostRequest;
        try {
          body = (await readJson(req)) as GoalHostRequest;
        } catch (error) {
          ctx.json(res, 400, {
            error: `bad request: ${(error as Error).message}`,
            code: "bad_request",
          });
          return true;
        }
        if (!isSafeId(body?.id)) {
          ctx.json(res, 400, { error: "invalid id", code: "bad_request" });
          return true;
        }
        const existing = goals.get(body.id);
        if (existing && (existing.state === "preparing" || existing.state === "running")) {
          ctx.json(res, 200, status(existing));
          return true;
        }
        const source = body.source;
        if (!source?.git || !/^[0-9a-f]{7,64}$/i.test(source.sha ?? "")) {
          ctx.json(res, 400, { error: "source {git, sha} is required", code: "bad_request" });
          return true;
        }
        if (
          source.subdir &&
          (path.isAbsolute(source.subdir) || source.subdir.split(/[\\/]/).includes(".."))
        ) {
          ctx.json(res, 400, { error: "invalid subdir", code: "bad_request" });
          return true;
        }
        const resultBranch = body.resultBranch ?? `ezcoder/goal/${body.id}`;
        if (!VALID_BRANCH.test(resultBranch) || resultBranch.includes("..")) {
          ctx.json(res, 400, { error: "invalid resultBranch", code: "bad_request" });
          return true;
        }
        if (ctx.config.dockerOnly) {
          ctx.json(res, 403, {
            error: "This node only takes Docker work (serve --docker-only); it can't host a Goal.",
            code: "docker_only",
          });
          return true;
        }
        if (!ctx.acquireSlot(owner(body.id))) {
          ctx.json(res, 429, { error: "No free slot on this node", code: "busy" });
          return true;
        }
        const record: GoalHostRecord = {
          id: body.id,
          project: String(body.project ?? ""),
          state: "preparing",
          startedAt: new Date().toISOString(),
          cwd: "",
          goalDir: path.join(ctx.config.dataDir, "goals", body.id),
          base: source.sha,
          resultBranch,
        };
        goals.set(record.id, record);
        persist();
        void launch(ctx, record, body);
        ctx.json(res, 200, status(record));
        return true;
      }
      const m = /^\/v1\/goals\/([^/]+)(\/log)?$/.exec(p);
      if (!m) return false;
      const record = goals.get(decodeURIComponent(m[1]!));
      if (!record) {
        ctx.json(res, 404, { error: "no such goal" });
        return true;
      }
      if (m[2] && req.method === "GET") {
        const lines = Math.min(
          Math.max(Number(url.searchParams.get("tail") ?? 200) || 200, 1),
          MAX_LOG_TAIL,
        );
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(tail(logFile(record), lines));
        return true;
      }
      if (m[2]) return false;
      if (req.method === "DELETE") {
        if (record.state === "running" || record.state === "preparing") {
          if (record.pid) killProcessTree(record.pid);
          record.state = "stopped";
          record.pid = undefined;
          record.finishedAt = new Date().toISOString();
          record.summary = `Stopped by the controller; the workspace is kept at ${record.cwd || record.goalDir}.`;
          appendLog(record, record.summary);
          ctx.releaseSlot(owner(record.id));
          persist();
        }
        ctx.json(res, 200, status(record));
        return true;
      }
      if (req.method === "GET") {
        ctx.json(res, 200, status(record));
        return true;
      }
      return false;
    },
  };
}
