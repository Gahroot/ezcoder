// Controller side of remote sub-agents (spawn_agent `machine`). A
// RemoteWorkerProcess looks enough like a ChildProcess for SubAgentManager:
// stdin/stdout/stderr streams carrying the same JSON-lines worker protocol,
// kill(), and 'exit'/'close' events. Underneath it prepares a workspace on a
// fleet node (POST /v1/agents: origin URL + local HEAD + a patch of uncommitted
// work), bridges stdio over WS /v1/agents/:id/attach, reconnects on transient
// drops, and brings the node's edits back to the local folder after every
// finished turn and on close (`git apply --3way --binary`, only the delta since
// the last sync).
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { WebSocket } from "ws";
import { log } from "../logger.js";
import { currentSubAgentDepth, SUB_AGENT_DEPTH_ENV } from "../../tools/subagent-shared.js";
import {
  AGENT_DETACH_GRACE_MS,
  type AgentDiff,
  type AgentFrame,
  type AgentRequest,
  type ErrorResponse,
  type SourceSpec,
} from "./protocol.js";
import {
  acquireAgentNode,
  nodeHeaders,
  nodeUrl,
  readFleetNodes,
  type FleetNodeEntry,
} from "./remote-agent-nodes.js";
import { AGENT_RESUMED_HEADER } from "./node/agents.js";

/** SourceSpec.patch limit (protocol: max 50 MB). */
const MAX_PATCH_BYTES = 50 * 1024 * 1024;
const DEFAULT_RECONNECT_WINDOW_MS = 3 * 60_000;
const KILL_GRACE_MS = 10_000;
const MAX_QUEUED_STDIN = 1_000;

export interface RemoteAgentInfo {
  node: string;
  remoteAgentId: string;
}

export interface RemoteWorkerSpawn {
  /** "auto" or a paired node name. */
  machine: string;
  /** Local folder the child works in; its edits come back here. */
  cwd: string;
  localAgentId: string;
  /** Root for per-agent sync state and kept conflict patches. */
  stateRoot: string;
  /** Re-attach to an existing remote agent instead of creating one. */
  resume?: RemoteAgentInfo;
  nodesFile?: string;
  reconnectWindowMs?: number;
  onRemote?: (info: RemoteAgentInfo) => void;
  /** Every sync-back attempt's outcome (Goal workers turn a conflict into a task failure, GL3). */
  onSync?: (event: RemoteSyncEvent) => void;
  /**
   * Last check of the picked node before any work is sent (Goals: S3 protocol
   * and GL5 prerequisites on that node). Throw to refuse the start.
   */
  vetNode?: (node: FleetNodeEntry) => Promise<void>;
  /** Told once when every usable node is full and the start waits for a slot. */
  onQueued?: (reason: string) => void;
  /** Re-check interval while queued (default 2 s). */
  queuePollMs?: number;
  /** Give up waiting for a slot after this long (default 6 h). */
  queueTimeoutMs?: number;
  /** Longest a node's Retry-After is honoured, ms (default 60 s; tests shorten it). */
  maxRetryAfterMs?: number;
}

export interface RemoteSyncEvent {
  when: "turn" | "close";
  node: string;
  /** Present when the node's diff was fetched (applied, conflict or refused). */
  result?: SyncResult;
  /** Present when the sync itself failed; `kept` = the full patch was saved locally. */
  error?: string;
  kept?: boolean;
  /** Full patch saved locally when `kept`. */
  keptPath?: string;
}

interface GitResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

function runGit(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: Buffer } = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const out: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
  });
}

async function git(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: Buffer } = {},
): Promise<string> {
  const result = await runGit(cwd, args, options);
  if (result.code !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
  return result.stdout.toString("utf-8");
}

export interface PreparedRemoteSource {
  repoRoot: string;
  source: SourceSpec;
  /** Raw (not base64) patch of uncommitted work against source.sha. */
  patch: Buffer;
  project: string;
}

/**
 * What the node needs to rebuild `cwd`: origin URL, HEAD (which must already
 * be on origin), and a binary patch of uncommitted work including untracked
 * files. The patch is built in a copy of the index so the user's is untouched.
 */
export async function prepareRemoteSource(cwd: string): Promise<PreparedRemoteSource> {
  let repoRoot: string;
  try {
    repoRoot = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    throw new Error(
      `Running an agent on another machine needs a git repository; ${cwd} is not in one. Leave machine unset to run locally.`,
    );
  }
  const subdir = (await git(cwd, ["rev-parse", "--show-prefix"])).trim().replace(/\/+$/, "");
  let origin: string;
  try {
    origin = (await git(repoRoot, ["remote", "get-url", "origin"])).trim();
  } catch {
    throw new Error(
      `${repoRoot} has no "origin" remote, so the other machine can't fetch the code. Add and push one, or leave machine unset to run locally.`,
    );
  }
  let sha: string;
  try {
    sha = (await git(repoRoot, ["rev-parse", "--verify", "HEAD"])).trim();
  } catch {
    throw new Error(`${repoRoot} has no commits yet. Commit and push, or leave machine unset.`);
  }
  const containing = await runGit(repoRoot, ["branch", "-r", "--contains", sha]);
  if (containing.code !== 0 || containing.stdout.toString().trim() === "") {
    throw new Error(
      `Local HEAD ${sha.slice(0, 12)} is not on origin yet, so the other machine can't check it out. ` +
        "Push it first (git push), or leave machine unset to run the agent locally.",
    );
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ez-remote-src-"));
  try {
    const index = path.join(tmp, "index");
    const userIndex = path.resolve(
      repoRoot,
      (await git(repoRoot, ["rev-parse", "--git-path", "index"])).trim(),
    );
    await fs.copyFile(userIndex, index).catch(() => undefined);
    const env = { ...process.env, GIT_INDEX_FILE: index };
    await git(repoRoot, ["add", "-A", "-N"], { env });
    const patch = (
      await runGit(
        repoRoot,
        ["-c", "core.quotepath=false", "diff", "--binary", "--no-ext-diff", "--no-color", sha],
        { env },
      )
    ).stdout;
    if (patch.length > MAX_PATCH_BYTES) {
      throw new Error(
        `Uncommitted changes are ${Math.round(patch.length / 1e6)} MB (limit 50 MB). Commit and push them, or run locally.`,
      );
    }
    const project =
      origin
        .replace(/\.git$/, "")
        .split(/[/:]/)
        .filter(Boolean)
        .slice(-2)
        .join("/") || path.basename(repoRoot);
    return {
      repoRoot,
      patch,
      project,
      source: {
        git: origin,
        sha,
        ...(patch.length > 0 && { patch: patch.toString("base64") }),
        ...(subdir && { subdir }),
      },
    };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

export interface SyncResult {
  /** Files the delta touched (empty when nothing changed since the last sync). */
  files: string[];
  applied: boolean;
  /** Kept patch when it could not be applied cleanly. */
  conflictPatch?: string;
  /** Files whose hunks do not apply to the local folder (subset of `files`). */
  conflictFiles?: string[];
  /** Git-ignored files the agent changed that were not brought back (R9). */
  notBroughtBack?: string[];
  /** One line for the agent's receipt / stderr. */
  note?: string;
}

/** Escape fnmatch metacharacters for `git apply --include`. */
function literalPathspec(file: string): string {
  return file.replace(/[[\]*?\\]/g, (c) => `\\${c}`);
}

/** Which of `files` make `patchFile` fail to apply (checked one file at a time, nothing written). */
export async function conflictingFiles(
  repoRoot: string,
  patchFile: string,
  files: readonly string[],
): Promise<string[]> {
  if (files.length > 200) return [...files];
  const out: string[] = [];
  for (const file of files) {
    const check = await runGit(repoRoot, [
      "apply",
      "--check",
      "--binary",
      "--whitespace=nowarn",
      `--include=${literalPathspec(file)}`,
      patchFile,
    ]);
    if (check.code !== 0) out.push(file);
  }
  return out.length > 0 ? out : [...files];
}

/** Receipt line for git-ignored files the agent changed (R9). */
export function notBroughtBackNote(node: string, files: readonly string[]): string {
  const shown = files.slice(0, 20).join(", ");
  const more = files.length > 20 ? ` and ${files.length - 20} more` : "";
  return `Not brought back (git ignores them, so they stay on ${node}): ${shown}${more}`;
}

/**
 * Symlinks the change from tree `from` to `to` adds or retargets that point
 * outside the repository (absolute, `..` escapes) or into `.git`. Applying
 * them would let a node write anywhere through a later local edit.
 */
export async function escapingSymlinks(
  repoRoot: string,
  from: string,
  to: string,
): Promise<string[]> {
  const raw = await git(repoRoot, ["diff-tree", "-r", "-z", "--no-renames", from, to]);
  const parts = raw.split("\0");
  const out: string[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const m = /^:\d+ (\d+) [0-9a-f]+ ([0-9a-f]+) [A-Z]/.exec(parts[i]!);
    const file = parts[i + 1]!;
    if (!m || m[1] !== "120000") continue;
    const target = (await git(repoRoot, ["cat-file", "blob", m[2]!])).replace(/\\/g, "/");
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), target));
    if (
      path.posix.isAbsolute(target) ||
      /^[A-Za-z]:/.test(target) ||
      resolved === ".." ||
      resolved.startsWith("../") ||
      resolved.split("/")[0]!.toLowerCase() === ".git"
    ) {
      out.push(file);
    }
  }
  return out;
}

/**
 * Apply to `repoRoot` the change from (base + previous) to (base + next),
 * where both are full remote diffs against `base`. Applying only that delta
 * keeps repeated syncs from re-applying earlier turns. The apply is atomic;
 * when it fails the tree is untouched and the delta is kept under `keepDir`.
 */
export async function applyRemoteDelta(options: {
  repoRoot: string;
  base: string;
  previous: Buffer;
  next: Buffer;
  keepDir: string;
  node: string;
}): Promise<SyncResult> {
  const { repoRoot, base } = options;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ez-remote-sync-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: path.join(tmp, "index") };
    const treeOf = async (patch: Buffer): Promise<string> => {
      await git(repoRoot, ["read-tree", base], { env });
      if (patch.length > 0) {
        await git(repoRoot, ["apply", "--cached", "--binary", "--whitespace=nowarn", "-"], {
          env,
          input: patch,
        });
      }
      return (await git(repoRoot, ["write-tree"], { env })).trim();
    };
    const before = await treeOf(options.previous);
    const after = await treeOf(options.next);
    if (before === after) return { files: [], applied: true };
    const diffArgs = ["-c", "core.quotepath=false", "diff", "--no-ext-diff", "--no-color"];
    const delta = (await runGit(repoRoot, [...diffArgs, "--binary", before, after])).stdout;
    const files = (await git(repoRoot, [...diffArgs, "--name-only", "-z", before, after]))
      .split("\0")
      .filter(Boolean);
    const deltaFile = path.join(tmp, "delta.patch");
    await fs.writeFile(deltaFile, delta);
    const escaping = await escapingSymlinks(repoRoot, before, after);
    if (escaping.length) {
      await fs.mkdir(options.keepDir, { recursive: true });
      const kept = path.join(
        options.keepDir,
        `refused-${new Date().toISOString().replace(/[:.]/g, "-")}.patch`,
      );
      await fs.writeFile(kept, delta);
      return {
        files,
        applied: false,
        conflictPatch: kept,
        note:
          `REFUSED: edits from ${options.node} add symlinks pointing outside the folder ` +
          `(${escaping.join(", ")}), so none were applied. The patch is kept at ${kept}.`,
      };
    }
    // Plain `git apply` is atomic: all hunks land or none do. Never --3way
    // here: it would leave conflict markers in the user's files.
    const plain = await runGit(repoRoot, ["apply", "--binary", "--whitespace=nowarn", deltaFile]);
    if (plain.code === 0) {
      return {
        files,
        applied: true,
        note: `Edits from ${options.node} applied locally: ${files.join(", ")}`,
      };
    }
    await fs.mkdir(options.keepDir, { recursive: true });
    const kept = path.join(
      options.keepDir,
      `conflict-${new Date().toISOString().replace(/[:.]/g, "-")}.patch`,
    );
    await fs.writeFile(kept, delta);
    const conflicts = await conflictingFiles(repoRoot, deltaFile, files);
    return {
      files,
      applied: false,
      conflictPatch: kept,
      conflictFiles: conflicts,
      note:
        `CONFLICT: edits from ${options.node} to ${conflicts.join(", ")} did not apply cleanly to the local folder, ` +
        `so none of its edits (${files.join(", ")}) were applied (${plain.stderr.trim().split("\n").slice(-2).join(" ")}). ` +
        `The patch is kept at ${kept}; apply it manually with: ` +
        `git -C "${repoRoot}" apply --3way --binary "${kept}"`,
    };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/** Serialize syncs into one repo (several remote agents may finish at once). */
const repoLocks = new Map<string, Promise<unknown>>();
function withRepoLock<T>(repoRoot: string, task: () => Promise<T>): Promise<T> {
  const previous = repoLocks.get(repoRoot) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  repoLocks.set(repoRoot, run);
  void run.finally(() => {
    if (repoLocks.get(repoRoot) === run) repoLocks.delete(repoRoot);
  });
  return run;
}

interface RemoteState {
  node: string;
  remoteAgentId: string;
  repoRoot: string;
  base: string;
}

/** The apply failed but the node's full patch is saved locally, so nothing is lost. */
class KeptPatchError extends Error {
  constructor(
    message: string,
    readonly keptPath: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** From Retry-After on a 429 ("busy"). */
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** Retry-After (seconds or HTTP date) in ms, capped at a minute. */
export function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.min(Math.max(at - Date.now(), 0), 60_000);
}

export class RemoteWorkerProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly pid: number | undefined = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  /** Resolves once attached; `resumed` = joined a worker that was already running. */
  readonly attached: Promise<{ resumed: boolean }>;
  readonly machine: string;
  node?: FleetNodeEntry;
  remoteAgentId?: string;

  private ws?: WebSocket;
  private readonly queue: string[] = [];
  private stdoutPartial = "";
  private lineChain: Promise<void> = Promise.resolve();
  private finished = false;
  private exitSeen = false;
  private created = false;
  private reconnecting = false;
  private state?: RemoteState;
  private stateDir?: string;
  private killTimer?: NodeJS.Timeout;
  private closing?: Promise<void>;
  /** The node holds edits we could not fetch: don't remove its workspace. */
  private unsynced = false;
  /** Git-ignored changes already listed in a receipt (R9: each is reported once). */
  private readonly reportedIgnored = new Set<string>();

  constructor(private readonly spawnOptions: RemoteWorkerSpawn) {
    super();
    this.machine = spawnOptions.resume?.node ?? spawnOptions.machine;
    this.stdin = new Writable({
      write: (chunk: Buffer | string, _encoding, callback) => {
        this.send({ t: "stdin", data: chunk.toString() });
        callback();
      },
    });
    this.attached = this.start();
    // Failures surface as exit (with the reason on stderr), like a worker that died.
    this.attached.catch((error: unknown) => {
      void this.cleanupAndFinish(1, null, error instanceof Error ? error.message : String(error));
    });
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    if (this.finished) return false;
    this.killed = true;
    const name = typeof signal === "string" ? signal : "SIGTERM";
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ t: "kill", signal: name } satisfies AgentFrame));
      clearTimeout(this.killTimer);
      this.killTimer = setTimeout(
        () =>
          void this.syncNote("close", 1).then((note) => {
            if (note && !this.finished) this.stderr.write(`${note}\n`);
            return this.cleanupAndFinish(null, name);
          }),
        KILL_GRACE_MS,
      );
      this.killTimer.unref?.();
    } else if (!this.reconnecting) {
      // Still starting: start() sees `killed` and its failure path cleans up.
      void this.attached.then(
        () => this.cleanupAndFinish(null, name),
        () => undefined,
      );
    }
    return true;
  }

  /**
   * Drop the connection without stopping or removing the remote agent (as a
   * parent restart does); the node keeps it for the detach grace period.
   */
  detach(): void {
    this.created = false;
    void this.finish(null, null);
  }

  private async start(): Promise<{ resumed: boolean }> {
    const { resume, stateRoot } = this.spawnOptions;
    if (resume) {
      const nodes = await readFleetNodes(this.spawnOptions.nodesFile);
      const node = nodes.find((candidate) => candidate.name === resume.node);
      if (!node) throw new Error(`Machine "${resume.node}" is no longer paired`);
      this.node = node;
      this.remoteAgentId = resume.remoteAgentId;
      this.stateDir = path.join(stateRoot, resume.remoteAgentId);
      this.state = JSON.parse(
        await fs.readFile(path.join(this.stateDir, "state.json"), "utf-8"),
      ) as RemoteState;
      this.created = true;
    } else {
      // Source first: a "push first" error should not wait on node probes.
      const prepared = await prepareRemoteSource(this.spawnOptions.cwd);
      this.remoteAgentId = `ez-${this.spawnOptions.localAgentId}-${randomBytes(3).toString("hex")}`;
      const request: AgentRequest = {
        id: this.remoteAgentId,
        project: prepared.project,
        source: prepared.source,
        env: { [SUB_AGENT_DEPTH_ENV]: String(currentSubAgentDepth() + 1) },
      };
      const node = await this.createOnFreeNode(request);
      this.stateDir = path.join(stateRoot, this.remoteAgentId);
      this.state = {
        node: node.name,
        remoteAgentId: this.remoteAgentId,
        repoRoot: prepared.repoRoot,
        base: prepared.source.sha,
      };
      await fs.mkdir(this.stateDir, { recursive: true });
      await fs.writeFile(path.join(this.stateDir, "state.json"), JSON.stringify(this.state));
      // The node starts from base + this patch, so it counts as already applied.
      await fs.writeFile(path.join(this.stateDir, "last.patch"), prepared.patch);
    }
    const node = this.node!;
    this.spawnOptions.onRemote?.({ node: node.name, remoteAgentId: this.remoteAgentId });
    if (this.killed) throw new Error("Killed before the remote agent started");
    const attached = await this.connect();
    log("INFO", "subagent", "Remote agent attached", {
      node: node.name,
      remote_agent_id: this.remoteAgentId,
      resumed: attached.resumed,
    });
    return attached;
  }

  /**
   * Pick a node with a free slot (waiting while all are full), then create the
   * agent there. A node that answers 429 (busy: a slot went to someone else
   * between probe and start) sends us back to the queue after its Retry-After.
   */
  private async createOnFreeNode(request: AgentRequest): Promise<FleetNodeEntry> {
    const { spawnOptions } = this;
    let queuedTold = false;
    const onQueued = (reason: string) => {
      if (queuedTold) return;
      queuedTold = true;
      spawnOptions.onQueued?.(reason);
    };
    for (;;) {
      if (this.killed) throw new Error("Killed before the remote agent started");
      const { node, release } = await acquireAgentNode(spawnOptions.machine, {
        file: spawnOptions.nodesFile,
        pollMs: spawnOptions.queuePollMs,
        queueTimeoutMs: spawnOptions.queueTimeoutMs,
        cancelled: () => this.killed,
        onQueued,
      });
      try {
        this.node = node;
        await spawnOptions.vetNode?.(node);
        await this.http("POST", "/v1/agents", request);
        this.created = true;
        return node;
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 429) throw error;
        onQueued(error.message);
        const wait = Math.min(
          error.retryAfterMs ?? spawnOptions.queuePollMs ?? 2_000,
          spawnOptions.maxRetryAfterMs ?? 60_000,
        );
        await new Promise((resolve) => setTimeout(resolve, wait));
      } finally {
        release();
      }
    }
  }

  private async http<T>(method: string, route: string, body?: unknown): Promise<T> {
    const node = this.node!;
    let res: Response;
    try {
      res = await fetch(nodeUrl(node, route), {
        method,
        headers: {
          ...nodeHeaders(node),
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(method === "POST" ? 15 * 60_000 : 2 * 60_000),
      });
    } catch (error) {
      throw new Error(
        `Machine "${node.name}" is unreachable: ${error instanceof Error ? error.message : error}`,
        { cause: error },
      );
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!res.ok) {
      const reason = (parsed as ErrorResponse | undefined)?.error ?? `HTTP ${res.status}`;
      throw new HttpError(
        `Machine "${node.name}": ${reason}`,
        res.status,
        retryAfterMs(res.headers.get("retry-after")),
      );
    }
    return parsed as T;
  }

  private connect(): Promise<{ resumed: boolean }> {
    const node = this.node!;
    const url = nodeUrl(
      node,
      `/v1/agents/${encodeURIComponent(this.remoteAgentId!)}/attach`,
    ).replace(/^http/, "ws");
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers: nodeHeaders(node), maxPayload: 64 * 1024 * 1024 });
      let resumed = false;
      let settled = false;
      ws.on("error", (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
      ws.once("upgrade", (res) => {
        resumed = res.headers[AGENT_RESUMED_HEADER] === "1";
      });
      ws.once("unexpected-response", (req, res) => {
        req.destroy();
        if (!settled) {
          settled = true;
          reject(new HttpError(`attach refused (HTTP ${res.statusCode})`, res.statusCode ?? 0));
        }
      });
      ws.once("open", () => {
        settled = true;
        this.ws = ws;
        ws.on("message", (raw) => this.onFrame(raw.toString()));
        ws.on("close", () => {
          if (this.ws !== ws) return;
          this.ws = undefined;
          if (!this.finished && !this.exitSeen) void this.reconnect();
        });
        for (const data of this.queue.splice(0)) ws.send(data);
        resolve({ resumed });
      });
    });
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    const deadline =
      Date.now() + (this.spawnOptions.reconnectWindowMs ?? DEFAULT_RECONNECT_WINDOW_MS);
    let delay = 250;
    try {
      while (!this.finished && !this.exitSeen) {
        try {
          await this.connect();
          if (this.killed) this.kill("SIGTERM");
          return;
        } catch (error) {
          const status = error instanceof HttpError ? error.status : 0;
          if (status === 404 || status === 401 || status === 403 || Date.now() > deadline) {
            await this.finish(
              null,
              null,
              `Lost the remote agent on ${this.node?.name}: ${error instanceof Error ? error.message : error}`,
            );
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay = Math.min(delay * 2, 5_000);
        }
      }
    } finally {
      this.reconnecting = false;
    }
  }

  private send(frame: AgentFrame): void {
    if (this.finished) return;
    const data = JSON.stringify(frame);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data);
    else if (this.queue.length < MAX_QUEUED_STDIN) this.queue.push(data);
  }

  private onFrame(raw: string): void {
    let frame: AgentFrame;
    try {
      frame = JSON.parse(raw) as AgentFrame;
    } catch {
      return;
    }
    if (frame.t === "stdout") {
      const lines = (this.stdoutPartial + frame.data).split("\n");
      this.stdoutPartial = lines.pop() ?? "";
      for (const line of lines) this.lineChain = this.lineChain.then(() => this.forwardLine(line));
    } else if (frame.t === "stderr") {
      this.stderr.write(frame.data);
    } else if (frame.t === "exit") {
      this.exitSeen = true;
      this.lineChain = this.lineChain.then(async () => {
        await this.syncNote("close", 3).then((note) => note && this.stderr.write(`${note}\n`));
        await this.cleanupAndFinish(frame.code, (frame.signal as NodeJS.Signals | null) ?? null);
      });
    }
  }

  /** Pass a worker line through; a finished turn first brings its edits home. */
  private async forwardLine(line: string): Promise<void> {
    if (line.includes('"turn_complete"')) {
      try {
        const frame = JSON.parse(line) as Record<string, unknown>;
        if (frame.type === "turn_complete") {
          const note = await this.syncNote("turn");
          if (note) {
            frame.receipt = [typeof frame.receipt === "string" ? frame.receipt : "", note]
              .filter(Boolean)
              .join("\n");
            line = JSON.stringify(frame);
          }
        }
      } catch {
        // Not JSON: pass through as-is.
      }
    }
    if (!this.finished) this.stdout.write(`${line}\n`);
  }

  /** Sync and describe the outcome; never throws (a failed sync is reported, not fatal). */
  private async syncNote(when: "turn" | "close", tries = 1): Promise<string | undefined> {
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await this.syncBack();
        this.unsynced = false;
        if (result) this.reportSync({ when, node: this.node?.name ?? "", result });
        return result?.note;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const gone = error instanceof HttpError && error.status === 404;
        const kept = error instanceof KeptPatchError;
        if (attempt < tries && !gone && !kept) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        this.unsynced = !gone && !kept;
        log("WARN", "subagent", "Remote agent sync-back failed", { when, error: message });
        const note = `Could not bring edits back from ${this.node?.name}: ${message}`;
        this.reportSync({
          when,
          node: this.node?.name ?? "",
          error: note,
          kept,
          ...(error instanceof KeptPatchError && { keptPath: error.keptPath }),
        });
        return note;
      }
    }
  }

  private reportSync(event: RemoteSyncEvent): void {
    try {
      this.spawnOptions.onSync?.(event);
    } catch (error) {
      log("WARN", "subagent", "Remote agent sync listener failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Ignored files changed since the last receipt, reported once each (R9). */
  private newlyIgnored(diff: AgentDiff): string[] {
    const fresh = (diff.ignoredChanged ?? []).filter(
      (file) => typeof file === "string" && !this.reportedIgnored.has(file),
    );
    for (const file of fresh) this.reportedIgnored.add(file);
    return fresh;
  }

  /** GET the node's diff and apply what changed since the last sync. */
  async syncBack(): Promise<SyncResult | undefined> {
    const state = this.state;
    if (!state || !this.stateDir || !this.created) return undefined;
    const stateDir = this.stateDir;
    const diff = await this.http<AgentDiff>(
      "GET",
      `/v1/agents/${encodeURIComponent(state.remoteAgentId)}/diff`,
    );
    const next = Buffer.from(diff.patch, "base64");
    const lastFile = path.join(stateDir, "last.patch");
    const ignored = this.newlyIgnored(diff);
    const withIgnored = (result: SyncResult | undefined): SyncResult | undefined => {
      if (ignored.length === 0) return result;
      const line = notBroughtBackNote(state.node, ignored);
      const base = result ?? { files: [], applied: true };
      return {
        ...base,
        notBroughtBack: ignored,
        note: [base.note, line].filter(Boolean).join("\n"),
      };
    };
    return withRepoLock(state.repoRoot, async () => {
      const previous = await fs.readFile(lastFile).catch(() => Buffer.alloc(0));
      if (previous.equals(next)) return withIgnored(undefined);
      let result: SyncResult;
      try {
        result = await applyRemoteDelta({
          repoRoot: state.repoRoot,
          base: diff.base || state.base,
          previous,
          next,
          keepDir: stateDir,
          node: state.node,
        });
      } catch (error) {
        // The node's copy goes away when the agent closes: keep everything it sent.
        const kept = path.join(
          stateDir,
          `unsynced-${new Date().toISOString().replace(/[:.]/g, "-")}.patch`,
        );
        await fs.mkdir(stateDir, { recursive: true });
        await fs.writeFile(kept, next);
        throw new KeptPatchError(
          `${error instanceof Error ? error.message : String(error)}. ` +
            `All of the agent's changes since ${(diff.base || state.base).slice(0, 10)} are kept at ${kept}`,
          kept,
          { cause: error },
        );
      }
      // Consumed either way: a conflict is kept and reported once, not retried.
      const tmpFile = `${lastFile}.${process.pid}.tmp`;
      await fs.writeFile(tmpFile, next);
      await fs.rename(tmpFile, lastFile);
      return withIgnored(result);
    });
  }

  private cleanupAndFinish(
    code: number | null,
    signal: NodeJS.Signals | null,
    reason?: string,
  ): Promise<void> {
    this.closing ??= this.removeAndFinish(code, signal, reason);
    return this.closing;
  }

  private async removeAndFinish(
    code: number | null,
    signal: NodeJS.Signals | null,
    reason?: string,
  ): Promise<void> {
    if (this.finished) return;
    clearTimeout(this.killTimer);
    if (this.created && this.remoteAgentId && this.unsynced) {
      reason = [
        reason,
        `The agent's edits are still on ${this.node?.name} (~/.ezcoder/node/agents/${this.remoteAgentId}); ` +
          `its workspace was left in place and the node removes it after ${AGENT_DETACH_GRACE_MS / 60_000} minutes.`,
      ]
        .filter(Boolean)
        .join("\n");
      this.created = false;
    }
    if (this.created && this.remoteAgentId) {
      await this.http("DELETE", `/v1/agents/${encodeURIComponent(this.remoteAgentId)}`).catch(
        (error: unknown) =>
          log("WARN", "subagent", "Could not remove remote agent", {
            error: error instanceof Error ? error.message : String(error),
          }),
      );
      if (this.stateDir) {
        // Keep conflict patches; drop the bookkeeping.
        await fs.rm(path.join(this.stateDir, "last.patch"), { force: true });
        await fs.rm(path.join(this.stateDir, "state.json"), { force: true });
        await fs.rmdir(this.stateDir).catch(() => undefined);
      }
      this.created = false;
    }
    await this.finish(code, signal, reason);
  }

  private async finish(
    code: number | null,
    signal: NodeJS.Signals | null,
    reason?: string,
  ): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.killTimer);
    const ws = this.ws;
    this.ws = undefined;
    ws?.close(1000);
    if (reason) this.stderr.write(`${reason}\n`);
    this.stdin.destroy();
    this.stdout.end();
    this.stderr.end();
    // Let stream listeners see the last data before the exit is announced.
    await new Promise((resolve) => setImmediate(resolve));
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}
