// Remote agents on a node: POST /v1/agents prepares an isolated workspace and
// takes a slot; WS /v1/agents/:id/attach runs `ezcoder --subagent-worker` in it
// and bridges its stdio as AgentFrame JSON text frames; GET .../diff returns
// the workspace's changes; DELETE kills and cleans up. The worker survives a
// dropped socket for the grace period, buffering its output for a re-attach.
//
// Two node-side rules the controller relies on (see docs/fleet-agents.md):
// - `initialize` / `followup` frames are rewritten so the worker works in the
//   node workspace: options.cwd, options.sessionRootDir and
//   options.childSessionPath are node paths, additionalRoots are dropped.
// - The upgrade response carries `X-Ezcoder-Agent-Resumed: 1` when the attach
//   joined a live (or not yet reported) worker instead of starting a new one.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import {
  AGENT_DETACH_GRACE_MS,
  type AgentDiff,
  type AgentFrame,
  type AgentRequest,
  type AgentWorkspaceStatus,
} from "../protocol.js";
import type { NodeContext, NodeRouteModule } from "./context.js";
import { SUB_AGENT_DEPTH_ENV, childSubAgentEnv } from "../../../tools/subagent-shared.js";
import { allowedBaseEnv } from "./env.js";
import { pidAlive } from "./exec.js";
import type { AgentRecord } from "./state.js";

const execFileAsync = promisify(execFile);

export const AGENT_RESUMED_HEADER = "x-ezcoder-agent-resumed";
/** Request body cap: a 50 MB patch is ~67 MB of base64. */
const MAX_BODY_BYTES = 80 * 1024 * 1024;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const DEFAULT_BUFFER_BYTES = 8 * 1024 * 1024;
const STDERR_TAIL_CHARS = 64 * 1024;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
/** Seconds a controller should wait before retrying when every slot is busy. */
const BUSY_RETRY_AFTER = "15";
/** EZ_* names the worker itself needs from the node (beyond the allow-list). */
const WORKER_EZ_ENV = [SUB_AGENT_DEPTH_ENV];
/** Env names a controller may never set on the node (credentials, loaders, identity). */
const BLOCKED_ENV =
  /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION)|^(PATH|HOME|USERPROFILE|NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*|SHELL|GIT_.*|SSH_.*)$/i;

export interface AgentRoutesOptions {
  /** Worker entry override (tests); default ctx.cliEntry(). */
  cliEntry?: string;
  graceMs?: number;
  /** Max bytes of stdout kept while no controller is attached. */
  bufferBytes?: number;
}

interface AgentEntry {
  id: string;
  project: string;
  base: string;
  /** Folder the worker runs in. */
  cwd: string;
  /** Git top level of the workspace. */
  root: string;
  /** Folder removed on DELETE ("" = none: the workspace isn't under dataDir). */
  removeDir: string;
  sessionsDir: string;
  env: Record<string, string>;
  createdAt: string;
  state: AgentWorkspaceStatus["state"];
  proc?: ChildProcess;
  exitCode?: number;
  /** Exit not yet delivered to a controller. */
  pendingExit?: Extract<AgentFrame, { t: "exit" }>;
  socket?: WebSocket;
  buffer: string[];
  bufferBytes: number;
  dropped: number;
  stderrTail: string;
  stdinPartial: string;
  sessionPath?: string;
  graceTimer?: NodeJS.Timeout;
  owner: string;
  /** R9: ignored files at prepare time, path -> "size:mtimeMs". */
  ignoredSnapshot?: Record<string, string>;
  /** Re-adopted after a node restart: its worker (if any) is no longer ours. */
  adopted?: boolean;
  pid?: number;
}

function sendFrame(socket: WebSocket | undefined, frame: AgentFrame): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(frame));
  return true;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("Body too large"), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    throw Object.assign(new Error("Invalid JSON body"), { status: 400 });
  }
}

/** Controller env, minus anything that could carry credentials or hijack the worker. */
export function safeAgentEnv(
  requested: Record<string, unknown> | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(requested ?? {})) {
    if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    if (BLOCKED_ENV.test(name)) continue;
    env[name] = value;
  }
  return env;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 200 * 1024 * 1024,
    encoding: "buffer",
  });
  return stdout.toString("latin1");
}

/** R9: git-ignored files (recursively) with size and mtime. Cheap: no content reads. */
async function ignoredFiles(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let listing: string;
  try {
    listing = await git(root, ["ls-files", "-z", "-o", "-i", "--exclude-standard"]);
  } catch {
    return out;
  }
  const names = Buffer.from(listing, "latin1").toString("utf-8").split("\0").filter(Boolean);
  for (const name of names.slice(0, 200_000)) {
    try {
      const st = await fs.lstat(path.join(root, name));
      out[name] = `${st.size}:${Math.round(st.mtimeMs)}`;
    } catch {
      // vanished meanwhile
    }
  }
  return out;
}

/** Ignored files the agent added, changed or removed since the snapshot. */
export function ignoredChanges(
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  const changed = new Set<string>();
  for (const [name, sig] of Object.entries(after)) if (before[name] !== sig) changed.add(name);
  for (const name of Object.keys(before)) if (!(name in after)) changed.add(name);
  return [...changed].sort();
}

function killTree(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  try {
    if (process.platform === "win32" && proc.pid) {
      spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    } else if (proc.pid) process.kill(-proc.pid, signal);
    else proc.kill(signal);
  } catch {
    proc.kill(signal);
  }
}

export function createAgentRouteModule(options: AgentRoutesOptions = {}): NodeRouteModule {
  const agents = new Map<string, AgentEntry>();
  const resumed = new WeakMap<IncomingMessage, boolean>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  wss.on("headers", (headers, req) => {
    const value = resumed.get(req);
    if (value !== undefined) headers.push(`X-Ezcoder-Agent-Resumed: ${value ? 1 : 0}`);
  });
  const graceMs = options.graceMs ?? AGENT_DETACH_GRACE_MS;
  const bufferLimit = options.bufferBytes ?? DEFAULT_BUFFER_BYTES;

  let stateCtx: NodeContext | undefined;
  const toRecord = (e: AgentEntry): AgentRecord => ({
    id: e.id,
    project: e.project,
    base: e.base,
    cwd: e.cwd,
    root: e.root,
    removeDir: e.removeDir,
    sessionsDir: e.sessionsDir,
    env: e.env,
    createdAt: e.createdAt,
    state: e.state,
    ...((e.proc?.pid ?? e.pid) !== undefined && { pid: e.proc?.pid ?? e.pid }),
    ...(e.exitCode !== undefined && { exitCode: e.exitCode }),
    ...(e.sessionPath && { sessionPath: e.sessionPath }),
    ...(e.ignoredSnapshot && { ignoredSnapshot: e.ignoredSnapshot }),
  });
  /** R3: mirror every agent into node state so a restart can re-adopt it. */
  const persist = () => {
    const state = stateCtx?.state;
    if (!state) return;
    state.data.agents = [...agents.values()].map(toRecord);
    try {
      state.save();
    } catch (e) {
      stateCtx?.log(`agents: could not save state: ${(e as Error).message}`);
    }
  };

  const status = (entry: AgentEntry): AgentWorkspaceStatus => ({
    id: entry.id,
    project: entry.project,
    state: entry.state,
    cwd: entry.cwd,
    ...((entry.proc?.pid ?? entry.pid) !== undefined &&
      entry.state === "running" && { pid: entry.proc?.pid ?? entry.pid }),
    ...(entry.exitCode !== undefined && { exitCode: entry.exitCode }),
    createdAt: entry.createdAt,
  });

  const armGrace = (ctx: NodeContext, entry: AgentEntry) => {
    clearTimeout(entry.graceTimer);
    entry.graceTimer = setTimeout(() => {
      if (entry.socket) return;
      ctx.log(`agent ${entry.id}: no controller for ${Math.round(graceMs / 1000)}s, removing`);
      void dispose(ctx, entry);
    }, graceMs);
    entry.graceTimer.unref?.();
  };

  const dispose = async (ctx: NodeContext, entry: AgentEntry): Promise<void> => {
    if (agents.get(entry.id) !== entry) return;
    agents.delete(entry.id);
    clearTimeout(entry.graceTimer);
    if (entry.proc) killTree(entry.proc, "SIGKILL");
    entry.socket?.close(1000, "removed");
    entry.socket = undefined;
    if (entry.adopted && entry.pid && entry.state === "running") {
      try {
        process.kill(-entry.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    ctx.releaseSlot(entry.owner);
    persist();
    for (const dir of [entry.removeDir, entry.sessionsDir]) {
      if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  };

  const deliver = (entry: AgentEntry, frame: AgentFrame) => {
    if (sendFrame(entry.socket, frame)) return;
    if (frame.t === "stdout") {
      entry.buffer.push(frame.data);
      entry.bufferBytes += frame.data.length;
      while (entry.bufferBytes > bufferLimit && entry.buffer.length > 0) {
        entry.bufferBytes -= entry.buffer.shift()!.length;
        entry.dropped++;
      }
    } else if (frame.t === "stderr") {
      entry.stderrTail = (entry.stderrTail + frame.data).slice(-STDERR_TAIL_CHARS);
    } else if (frame.t === "exit") {
      entry.pendingExit = frame;
    }
  };

  /** Point the worker at the node workspace instead of the controller's paths. */
  const rewriteStdin = (entry: AgentEntry, line: string): string => {
    let command: Record<string, unknown>;
    try {
      command = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return line;
    }
    if (
      command.command === "initialize" &&
      command.options &&
      typeof command.options === "object"
    ) {
      const opts = { ...(command.options as Record<string, unknown>) };
      opts.cwd = entry.cwd;
      opts.sessionRootDir = entry.sessionsDir;
      if (entry.sessionPath) opts.childSessionPath = entry.sessionPath;
      else delete opts.childSessionPath;
      delete opts.additionalRoots;
      return JSON.stringify({ ...command, options: opts });
    }
    if (command.command === "followup" && "additionalRoots" in command) {
      const { additionalRoots: _roots, ...rest } = command;
      return JSON.stringify(rest);
    }
    return line;
  };

  const startWorker = (ctx: NodeContext, entry: AgentEntry) => {
    const entryPath = options.cliEntry ?? ctx.cliEntry();
    const proc = spawn(process.execPath, [entryPath, "--subagent-worker"], {
      cwd: entry.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      // X6: allow-listed node env only, plus the worker's own depth marker.
      env: { ...allowedBaseEnv(childSubAgentEnv(process.env), WORKER_EZ_ENV), ...entry.env },
      detached: process.platform !== "win32",
    });
    entry.proc = proc;
    entry.adopted = false;
    entry.pid = proc.pid;
    entry.state = "running";
    // A worker takes a slot while it runs (re-taken after an earlier exit released it).
    ctx.acquireSlot(entry.owner, true);
    persist();
    entry.exitCode = undefined;
    entry.pendingExit = undefined;
    entry.stdinPartial = "";
    ctx.log(`agent ${entry.id}: worker started (pid ${proc.pid ?? "?"})`);
    createInterface({ input: proc.stdout! }).on("line", (line) => {
      if (line.includes('"child_session_path"')) {
        try {
          const frame = JSON.parse(line) as { type?: string; child_session_path?: unknown };
          if (frame.type === "ack" && typeof frame.child_session_path === "string") {
            entry.sessionPath = frame.child_session_path;
            persist();
          }
        } catch {
          // Not a protocol line; pass through untouched.
        }
      }
      deliver(entry, { t: "stdout", data: `${line}\n` });
    });
    proc.stderr!.on("data", (chunk: Buffer) =>
      deliver(entry, { t: "stderr", data: chunk.toString() }),
    );
    proc.stdin!.on("error", () => {});
    let exited = false;
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (exited) return;
      exited = true;
      if (entry.proc !== proc) return;
      entry.state = code === 0 ? "exited" : "error";
      entry.exitCode = code ?? undefined;
      ctx.releaseSlot(entry.owner);
      persist();
      ctx.log(`agent ${entry.id}: worker exited (${code ?? signal})`);
      deliver(entry, { t: "exit", code, signal });
    };
    // 'close' fires after stdout drained, so the exit frame follows every line.
    proc.once("close", onExit);
    proc.once("error", (error) => {
      deliver(entry, { t: "stderr", data: `Failed to start worker: ${error.message}\n` });
      onExit(null, null);
    });
  };

  const onMessage = (entry: AgentEntry, raw: RawData) => {
    let frame: AgentFrame;
    try {
      frame = JSON.parse(raw.toString()) as AgentFrame;
    } catch {
      return;
    }
    const proc = entry.proc;
    if (frame.t === "stdin" && typeof frame.data === "string") {
      if (!proc?.stdin?.writable || entry.state !== "running") return;
      const text = entry.stdinPartial + frame.data;
      const lines = text.split("\n");
      entry.stdinPartial = lines.pop() ?? "";
      for (const line of lines) proc.stdin.write(`${rewriteStdin(entry, line)}\n`);
    } else if (frame.t === "kill" && proc) {
      const signal = (frame.signal as NodeJS.Signals | undefined) ?? "SIGTERM";
      killTree(proc, signal === "SIGKILL" ? "SIGKILL" : "SIGTERM");
      const timer = setTimeout(() => killTree(proc, "SIGKILL"), 3_000);
      timer.unref?.();
    }
  };

  const handleAttach = (ctx: NodeContext, entry: AgentEntry, socket: WebSocket) => {
    clearTimeout(entry.graceTimer);
    tokens.set(socket, ctx.config.token);
    // A newer attach wins: the old socket is a stale connection.
    if (entry.socket && entry.socket !== socket) entry.socket.close(4000, "replaced");
    entry.socket = socket;
    socket.on("message", (raw) => onMessage(entry, raw));
    socket.on("error", () => {});
    socket.on("close", () => {
      if (entry.socket !== socket) return;
      entry.socket = undefined;
      if (agents.get(entry.id) === entry) armGrace(ctx, entry);
    });
    if (entry.dropped > 0) {
      sendFrame(socket, {
        t: "stderr",
        data: `[node] ${entry.dropped} output line(s) dropped while no controller was attached\n`,
      });
      entry.dropped = 0;
    }
    if (entry.stderrTail) sendFrame(socket, { t: "stderr", data: entry.stderrTail });
    entry.stderrTail = "";
    for (const data of entry.buffer) sendFrame(socket, { t: "stdout", data });
    entry.buffer = [];
    entry.bufferBytes = 0;
    if (entry.pendingExit) {
      const exit = entry.pendingExit;
      entry.pendingExit = undefined;
      sendFrame(socket, exit);
      return;
    }
    if (entry.adopted && entry.state === "running") {
      // The worker from before the node restart has no stdio bridge any more.
      sendFrame(socket, {
        t: "stderr",
        data: "[node] the node restarted; the previous worker can't be re-attached. Its edits are still in the workspace (fetch the diff).\n",
      });
      sendFrame(socket, { t: "exit", code: null, signal: null });
      return;
    }
    if (entry.state !== "running") startWorker(ctx, entry);
  };

  const handleCreate = async (ctx: NodeContext, req: IncomingMessage, res: ServerResponse) => {
    if (ctx.config.dockerOnly) {
      return ctx.json(res, 403, {
        error:
          "this node only runs containerised work (docker-only) and does not host remote agents; use another node",
        code: "docker_only",
      });
    }
    const body = (await readJson(req)) as Partial<AgentRequest>;
    if (!body || typeof body.id !== "string" || !ID_RE.test(body.id)) {
      return ctx.json(res, 400, { error: "id must match [A-Za-z0-9._-]{1,80}" });
    }
    const source = body.source;
    if (!source || typeof source.git !== "string" || typeof source.sha !== "string") {
      return ctx.json(res, 400, { error: "source {git, sha} is required" });
    }
    if (!/^[0-9a-f]{7,64}$/i.test(source.sha)) return ctx.json(res, 400, { error: "invalid sha" });
    if (
      source.subdir &&
      (path.isAbsolute(source.subdir) || source.subdir.split(/[\\/]/).includes(".."))
    ) {
      return ctx.json(res, 400, { error: "invalid subdir" });
    }
    const existing = agents.get(body.id);
    if (existing) return ctx.json(res, 200, status(existing));
    const owner = `agent:${body.id}`;
    if (!ctx.acquireSlot(owner)) {
      res.setHeader("retry-after", BUSY_RETRY_AFTER);
      return ctx.json(res, 429, { error: "all slots are busy", code: "busy" });
    }
    let workspace: string;
    try {
      workspace = path.resolve(await ctx.prepareWorkspace("agent", body.id, source));
    } catch (error) {
      ctx.releaseSlot(owner);
      return ctx.json(res, 500, {
        error: `Could not prepare workspace: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    // Real paths throughout: git reports them (macOS /var -> /private/var).
    workspace = await fs.realpath(workspace).catch(() => workspace);
    let root = workspace;
    try {
      root = path.resolve((await git(workspace, ["rev-parse", "--show-toplevel"])).trim());
    } catch {
      // Not a git checkout: diff will report the error.
    }
    let cwd = workspace;
    if (source.subdir && path.relative(root, workspace) === "")
      cwd = path.join(root, source.subdir);
    const dataDir = await fs.realpath(ctx.config.dataDir).catch(() => ctx.config.dataDir);
    const agentsDir = path.join(dataDir, "agents", body.id);
    // Only ever remove our own folders under dataDir.
    const removeDir = isInside(agentsDir, root) ? agentsDir : isInside(dataDir, root) ? root : "";
    const entry: AgentEntry = {
      id: body.id,
      project: typeof body.project === "string" ? body.project : "",
      base: source.sha,
      cwd,
      root,
      removeDir,
      sessionsDir: path.join(dataDir, "agent-sessions", body.id),
      env: safeAgentEnv(body.env),
      createdAt: new Date().toISOString(),
      state: "ready",
      buffer: [],
      bufferBytes: 0,
      dropped: 0,
      stderrTail: "",
      stdinPartial: "",
      owner,
    };
    await fs.mkdir(entry.sessionsDir, { recursive: true });
    entry.ignoredSnapshot = await ignoredFiles(root);
    agents.set(entry.id, entry);
    persist();
    armGrace(ctx, entry);
    ctx.log(`agent ${entry.id}: workspace ready at ${cwd}`);
    ctx.json(res, 201, status(entry));
  };

  const handleDiff = async (ctx: NodeContext, entry: AgentEntry, res: ServerResponse) => {
    try {
      await git(entry.root, ["add", "-A", "-N"]);
      const diffArgs = ["-c", "core.quotepath=false", "diff", "--no-ext-diff", "--no-color"];
      const patch = await execFileAsync("git", [...diffArgs, "--binary", entry.base], {
        cwd: entry.root,
        maxBuffer: 200 * 1024 * 1024,
        encoding: "buffer",
      });
      const names = await git(entry.root, [...diffArgs, "--name-only", "-z", entry.base]);
      const body: AgentDiff = {
        patch: patch.stdout.length > 0 ? patch.stdout.toString("base64") : "",
        files: Buffer.from(names, "latin1").toString("utf-8").split("\0").filter(Boolean),
        base: entry.base,
      };
      if (entry.ignoredSnapshot) {
        const changed = ignoredChanges(entry.ignoredSnapshot, await ignoredFiles(entry.root));
        if (changed.length) body.ignoredChanged = changed;
      }
      ctx.json(res, 200, body);
    } catch (error) {
      ctx.json(res, 500, {
        error: `diff failed: ${error instanceof Error ? error.message : error}`,
      });
    }
  };

  const tokens = new WeakMap<WebSocket, string>();

  return {
    /** R3: re-adopt agents from the previous node process. */
    init(ctx) {
      stateCtx = ctx;
      const records = ctx.state?.data.agents ?? [];
      const rebooted = ctx.state?.rebooted() ?? true;
      for (const r of records) {
        if (agents.has(r.id)) continue;
        const alive = r.state === "running" && !rebooted && pidAlive(r.pid);
        const entry: AgentEntry = {
          ...r,
          state:
            r.state === "running"
              ? alive
                ? "running"
                : "error"
              : r.state === "ready"
                ? "ready"
                : r.state,
          ...(r.state === "running" && !alive && { exitCode: r.exitCode }),
          buffer: [],
          bufferBytes: 0,
          dropped: 0,
          stderrTail: "",
          stdinPartial: "",
          owner: `agent:${r.id}`,
          adopted: alive,
          ...(alive ? { pid: r.pid } : { pid: undefined }),
        };
        if (r.state === "running" && !alive) {
          entry.stderrTail =
            "[node] the node restarted and the worker stopped; its workspace is kept so the diff can still be fetched.\n";
        }
        if (alive) ctx.acquireSlot(entry.owner, true);
        agents.set(entry.id, entry);
        // A stopped worker's edits stay until the controller fetches them and DELETEs (R2).
        if (alive) armGrace(ctx, entry);
        ctx.log(`agent ${entry.id}: re-adopted (${entry.state})`);
      }
      persist();
    },

    /** S4: sockets opened with the old token are closed at once. */
    tokenRotated() {
      for (const entry of agents.values()) {
        const socket = entry.socket;
        if (socket && tokens.get(socket) !== stateCtx?.config.token) {
          socket.close(4001, "token rotated");
        }
      }
    },

    activeCount() {
      return [...agents.values()].filter((a) => a.state === "running").length;
    },

    async handle(ctx, req, res, url) {
      stateCtx ??= ctx;
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] !== "v1" || parts[1] !== "agents") return false;
      try {
        if (parts.length === 2) {
          if (req.method === "POST") await handleCreate(ctx, req, res);
          else if (req.method === "GET") ctx.json(res, 200, [...agents.values()].map(status));
          else ctx.json(res, 405, { error: "Method not allowed" });
          return true;
        }
        const entry = agents.get(decodeURIComponent(parts[2] ?? ""));
        if (!entry) {
          ctx.json(res, 404, { error: "Unknown agent" });
          return true;
        }
        if (parts.length === 3 && req.method === "GET") ctx.json(res, 200, status(entry));
        else if (parts.length === 3 && req.method === "DELETE") {
          const final = { ...status(entry), state: "exited" as const };
          await dispose(ctx, entry);
          ctx.json(res, 200, final);
        } else if (parts.length === 4 && parts[3] === "diff" && req.method === "GET") {
          await handleDiff(ctx, entry, res);
        } else ctx.json(res, 404, { error: "Not found" });
      } catch (error) {
        const code = (error as { status?: number }).status ?? 500;
        if (!res.headersSent) {
          ctx.json(res, code, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      return true;
    },

    upgrade(ctx, req, socket, head, url) {
      stateCtx ??= ctx;
      const match = /^\/v1\/agents\/([^/]+)\/attach$/.exec(url.pathname);
      if (!match) return false;
      const entry = agents.get(decodeURIComponent(match[1]!));
      if (!entry) {
        socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return true;
      }
      resumed.set(req, entry.state === "running" || entry.pendingExit !== undefined);
      wss.handleUpgrade(req, socket as Socket, head, (ws) => handleAttach(ctx, entry, ws));
      return true;
    },

    agents() {
      return [...agents.values()].map(status);
    },

    async close() {
      for (const entry of agents.values()) {
        clearTimeout(entry.graceTimer);
        if (entry.proc && entry.state === "running") {
          killTree(entry.proc, "SIGKILL");
          // Recorded now: the exit event may land after the next node process read the state.
          entry.state = "error";
          entry.adopted = false;
        }
        entry.socket?.close(1001, "node shutting down");
      }
      persist();
      wss.close();
    },
  };
}

const agentRouteModule = createAgentRouteModule();
export { agentRouteModule };
export default agentRouteModule;
